/*
  Mini Laadscript
  Stopt de Wallbox zodra de Mini het ingestelde laaddoel bereikt.

  Werking:
  - Laaddoel komt uit Logic variabele: MiniLaadDoel (standaard 80)
  - Controleert via ev_charging_state of de auto daadwerkelijk laadt
  - Schrijft alleen naar tijdlijn bij statuswijziging (via global state)
  - Reset laaddoel automatisch naar standaard als auto losgekoppeld wordt

  Flow-setup (kies één van beide):
    A) Trigger op batterijwijziging: BMW Connected Drive → "Accuniveau is veranderd"
    B) Polling: elke 1 minuut via tijdstrigger

  Laden tot 100%:
    Maak een aparte Flow die 'MiniLaadDoel' op 100 zet vóór het laden start.
*/

const config = {
  miniDeviceName:          'Mini',
  wallboxDeviceName:       'Wallbox',
  wallboxOffCapability:    'onoff',

  logicTargetName:         'MiniLaadDoel',
  defaultTargetBattery:    80,
  resetToDefaultWhenUnplugged: true,

  // BMW Mini Cooper SE netto accucapaciteit in kWh
  batterijCapaciteitKwh:   28.9,

  // BMW-data ouder dan dit wordt als verouderd beschouwd
  accuDataMaxAgeMs:        2 * 60 * 60 * 1000,

  // Alleen testen, niets schakelen
  dryRun: false,

  // Alleen bij statuswijziging een tijdlijnbericht sturen
  sendTimelineUpdates: true,

  // Keys voor opslag tussen script-runs (via global)
  stateKey:            'mini_charge_guard_last_state',
  messageKey:          'mini_charge_guard_last_message',
  laadStartKwhKey:     'mini_laad_start_kwh',
  laadStartAccuKey:    'mini_laad_start_accu',
  vorigeWallboxKey:    'mini_wallbox_prev_status',
};

// ─── Hulpfuncties ────────────────────────────────────────────────────────────

function logLine(msg) {
  log(`[MiniLaadScript] ${msg}`);
}

function getCapValue(device, capability) {
  return device?.capabilitiesObj?.[capability]?.value ?? null;
}

async function sendTimeline(message) {
  if (!config.sendTimelineUpdates) return;
  try {
    await Homey.flow.runFlowCardAction({
      uri: 'homey:manager:notifications',
      id:  'homey:manager:notifications:create_notification',
      args: { text: message }
    });
    logLine(`Tijdlijn: ${message}`);
  } catch (err) {
    logLine(`Tijdlijn mislukt: ${err.message}`);
  }
}

async function sendTimelineIfChanged(newState, message) {
  const previousState   = global.get(config.stateKey);
  const previousMessage = global.get(config.messageKey);

  if (previousState !== newState || previousMessage !== message) {
    await sendTimeline(message);
    global.set(config.stateKey,   newState);
    global.set(config.messageKey, message);
  } else {
    logLine(`Status ongewijzigd (${newState}), geen tijdlijn.`);
  }
}

// ─── Apparaten ophalen ───────────────────────────────────────────────────────

const devices = await Homey.devices.getDevices();
const mini    = Object.values(devices).find(d => d.name === config.miniDeviceName);
const wallbox = Object.values(devices).find(d => d.name === config.wallboxDeviceName);

if (!mini)    throw new Error(`Apparaat '${config.miniDeviceName}' niet gevonden.`);
if (!wallbox) throw new Error(`Apparaat '${config.wallboxDeviceName}' niet gevonden.`);

// ─── Capability-controle ─────────────────────────────────────────────────────

if (!wallbox.capabilities.includes(config.wallboxOffCapability)) {
  throw new Error(
    `Wallbox mist capability '${config.wallboxOffCapability}'. ` +
    `Beschikbaar: ${wallbox.capabilities.join(', ')}`
  );
}

// ─── Logic variabele lezen ───────────────────────────────────────────────────

const logicVars = await Homey.logic.getVariables();
const logicVar  = Object.values(logicVars).find(v => v.name === config.logicTargetName);

let targetBattery = config.defaultTargetBattery;
if (logicVar?.value !== null && logicVar?.value !== undefined) {
  const parsed = Number(logicVar.value);
  if (!Number.isNaN(parsed)) targetBattery = parsed;
}

// ─── Status ophalen ──────────────────────────────────────────────────────────

const battery          = getCapValue(mini,    'measure_battery');
const laadstatus       = getCapValue(mini,    'ev_charging_state');
const wallboxIsOn      = getCapValue(wallbox, config.wallboxOffCapability);
const wallboxStatus    = getCapValue(wallbox, 'status');
const wallboxMeterKwh  = getCapValue(wallbox, 'meter_power') ?? 0;

if (battery    === null) throw new Error(`'measure_battery' niet gevonden op '${config.miniDeviceName}'.`);
if (laadstatus === null) throw new Error(`'ev_charging_state' niet gevonden op '${config.miniDeviceName}'.`);

// ─── Accudata versheid + kWh-schatting ───────────────────────────────────────

const batteryLastUpdated = mini?.capabilitiesObj?.measure_battery?.lastUpdated;
const batteryAgeMs       = batteryLastUpdated
  ? Date.now() - new Date(batteryLastUpdated).getTime()
  : Infinity;
const batteryIsStale = batteryAgeMs > config.accuDataMaxAgeMs;

// Detecteer start nieuwe laadsessie
const vorigeWallboxStatus = global.get(config.vorigeWallboxKey) ?? null;
const sessieJuistGestart  = wallboxStatus === 'Charging' && vorigeWallboxStatus !== 'Charging';

if (sessieJuistGestart) {
  global.set(config.laadStartKwhKey,  wallboxMeterKwh);
  global.set(config.laadStartAccuKey, battery);
  logLine(`Laadsessie gestart: meter=${wallboxMeterKwh} kWh, accu=${battery}%`);
}
global.set(config.vorigeWallboxKey, wallboxStatus);

// Schat huidig accuniveau via Wallbox kWh (fallback als BMW-data verouderd is)
const laadStartKwh  = global.get(config.laadStartKwhKey)  ?? wallboxMeterKwh;
const laadStartAccu = global.get(config.laadStartAccuKey) ?? battery;
const kwhGeladen    = Math.max(0, wallboxMeterKwh - laadStartKwh);
const geschatteAccu = Math.min(100, laadStartAccu + (kwhGeladen / config.batterijCapaciteitKwh) * 100);
const effectieveAccu = Math.max(battery, geschatteAccu);

logLine(`Batterij: ${battery}% (${batteryIsStale ? 'VEROUDERD' : 'vers'}, ${Math.round(batteryAgeMs / 60000)}min) | Schatting: ${Math.round(geschatteAccu)}% (+${kwhGeladen.toFixed(2)} kWh) | Effectief: ${Math.round(effectieveAccu)}% | Mini: ${laadstatus} | Wallbox: ${wallboxStatus} (${wallboxIsOn ? 'AAN' : 'UIT'}) | Doel: ${targetBattery}%`);

// ─── Logica ──────────────────────────────────────────────────────────────────

const isCharging     = laadstatus === 'plugged_in_charging';
const isPaused       = laadstatus === 'plugged_in_paused';
const limitReached   = effectieveAccu >= targetBattery;
// "Ready" = auto aangesloten maar laadt niet; Wallbox geldt als fallback als Mini-data achterloopt
const wallboxConnected = ['Charging', 'Paused', 'Waiting', 'Ready', 'Locked'].includes(wallboxStatus);
const wallboxActief    = ['Charging', 'Paused', 'Waiting'].includes(wallboxStatus);
const isPluggedIn      = laadstatus !== 'plugged_out' || wallboxConnected;

// 1. Niet aangesloten → optioneel laaddoel resetten
if (!isPluggedIn) {
  if (config.resetToDefaultWhenUnplugged && logicVar &&
      Number(logicVar.value) !== config.defaultTargetBattery) {
    if (!config.dryRun) {
      await Homey.logic.updateVariable({
        id: logicVar.id,
        variable: { value: config.defaultTargetBattery }
      });
    }
    await sendTimelineIfChanged(
      `unplugged-reset-${config.defaultTargetBattery}`,
      `Mini losgekoppeld, laaddoel teruggezet naar ${config.defaultTargetBattery}%`
    );
  } else {
    await sendTimelineIfChanged(
      'unplugged',
      `Mini niet aangesloten (${battery}%), laaddoel ${targetBattery}%`
    );
  }
  return { action: 'none', reason: 'niet aangesloten', battery, laadstatus, targetBattery };
}

// 2. Laaddoel bereikt → Wallbox stoppen
// Beide kanten moeten actief zijn: Mini laadt (ev_charging_state) én Wallbox is bezig (status)
const shouldStop = limitReached && wallboxIsOn === true && wallboxActief &&
                   (isCharging || isPaused || laadstatus === 'plugged_in');

if (shouldStop) {
  if (config.dryRun) {
    await sendTimelineIfChanged(
      `dryrun-stop-${battery}-${targetBattery}`,
      `DRY RUN: Mini op ${battery}% (doel ${targetBattery}%), wallbox zou nu stoppen`
    );
    return { action: 'dry-run-stop', battery, laadstatus, targetBattery };
  }

  await wallbox.setCapabilityValue(config.wallboxOffCapability, false);

  const stopBron = batteryIsStale ? `schatting ${Math.round(effectieveAccu)}%` : `${battery}%`;
  await sendTimelineIfChanged(
    `stopped-${targetBattery}`,
    `Mini laden gestopt op ${stopBron} (doel ${targetBattery}%, +${kwhGeladen.toFixed(1)} kWh)`
  );

  return { action: 'stopped', battery, effectieveAccu: Math.round(effectieveAccu), batteryIsStale, kwhGeladen, laadstatus, targetBattery };
}

// 3. Aangesloten, onder limiet → informatieve status
let state   = `pluggedin-${targetBattery}`;
let message = `Mini aangesloten, niet aan het laden: ${battery}% / doel ${targetBattery}%`;

if (isCharging) {
  state   = `charging-${targetBattery}`;
  message = `Mini laadt: ${battery}%${batteryIsStale ? ` (schatting ${Math.round(geschatteAccu)}%)` : ''} / doel ${targetBattery}%`;
} else if (isPaused) {
  state   = `paused-${targetBattery}`;
  message = `Mini laden gepauzeerd: ${battery}% / doel ${targetBattery}%`;
}

await sendTimelineIfChanged(state, message);

return { action: 'none', battery, effectieveAccu: Math.round(effectieveAccu), batteryIsStale, kwhGeladen, laadstatus, wallboxIsOn, targetBattery, state };
