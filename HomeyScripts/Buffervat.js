// ==========================
// Buffervat warmtepomp script
// Verwarmen / verlagen op basis van:
// 1. zonne-overschot
// 2. 10 goedkoopste uren
// 3. 8 duurste uren
// Met logging + redenen + optionele Timeline
// ==========================

// ---------- Device IDs ----------
const P1_ID = '3755a652-027b-41bb-b188-ab2ac592ee04';
const DAIKIN_ID = 'd9a883d7-6322-4b73-820d-cd259bde862c';
const DAP_DEVICE_ID = '48b55814-c41c-4b0b-a65a-b7c5a21182e0'; // NL_Netherlands

// ---------- Instellingen warmtepomp ----------
const ECO = 47;
const NORMAL = 48;
const BOOST = 54;

// ---------- Drempels zonne-overschot met buffer ----------
const GRID_SOLAR_BOOST_ON_WATT = -2500;   // boost AAN
const GRID_SOLAR_BOOST_OFF_WATT = -800;   // boost UIT

// ---------- Zonne-opbrengst optimalisatie ----------
const SOLAR_OPTIMAL_START = 10;            // beste zonne-window start
const SOLAR_OPTIMAL_END = 15;              // beste zonne-window einde
const SOLAR_PLANNED_HOURS_COUNT = 5;       // aantal uren waarin buffervat op zonne-dag mag laden
const SOLAR_HOUR_MIN_SCORE = 0.12;         // minimale kwaliteit voor solar-uur selectie
const SOLAR_DAY_MIN_POTENTIAL = 2.2;       // fallback drempel voor "voldoende zonne-dag"
const SOLAR_FORECAST_MIN_KWH = 8;          // als dagprognose >= 8 kWh, dan alleen solar-uren gebruiken
const SOLAR_FORECAST_VARIABLE_CANDIDATES = [
  'zonne_opbrengst_vandaag_kwh',
  'zonneopbrengst_vandaag_kwh',
  'solar_forecast_today_kwh',
  'solar_forecast_today',
  'zonneopbrengst_vandaag',
  'verwachte_zonneopbrengst_vandaag'
];

// ---------- Prijs instellingen ----------
const CHEAP_HOURS_COUNT = 10;
const EXPENSIVE_HOURS_COUNT = 8;
const DAY_HOURS_COUNT = 24;

// ---------- COP optimalisatie temperatuur-grenzen ----------
const COP_TEMP_WARM = 54;        // target bij warm weer (>15°C)
const COP_TEMP_MILD = 51;        // target bij mild weer (>10°C)
const COP_TEMP_COOL = 49;        // target bij koel weer (>5°C)
const COP_TEMP_COLD = 47;        // target bij bevriezen (<0°C)
const COP_THRESHOLD_WARM = 15;   // warm weer drempel
const COP_THRESHOLD_MILD = 10;   // mild weer drempel
const COP_THRESHOLD_COOL = 5;    // koel weer drempel
const COP_THRESHOLD_COLD = 0;    // bevriezing drempel

// ---------- Logging ----------
const LOG_MAX_LINES = 40;
const SEND_TIMELINE_ON_CHANGE = true;
const SEND_TIMELINE_ALWAYS = false;

const LOG_VARIABLE = 'buffervat_log';
const LAST_REASON_VARIABLE = 'buffervat_laatste_reden';
const LAST_MODE_VARIABLE = 'buffervat_laatste_modus';
const LAST_TARGET_VARIABLE = 'buffervat_laatste_doeltemp';
const LAST_RUN_VARIABLE = 'buffervat_laatste_resultaat';
const SOLAR_BOOST_ACTIVE_VARIABLE = 'buffervat_solar_boost_active';

// --------------------------
// Helpers
// --------------------------
function round(value, decimals) {
  if (decimals === undefined) decimals = 2;
  return Number(Number(value).toFixed(decimals));
}

function getLocalDate() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })
  );
}

function nowIsoLocal() {
  const d = getLocalDate();
  const pad = function(n) {
    return String(n).padStart(2, '0');
  };

  return d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes()) + ':' +
    pad(d.getSeconds());
}

async function getAllLogicVars() {
  return await Homey.logic.getVariables();
}

async function findLogicVarByName(name) {
  const vars = await getAllLogicVars();
  const allVars = Object.values(vars);

  for (let i = 0; i < allVars.length; i++) {
    if (allVars[i].name === name) {
      return allVars[i];
    }
  }

  return null;
}

async function getVar(name, fallback) {
  try {
    const found = await findLogicVarByName(name);
    if (!found) return fallback;

    const val = found.value;

    if (typeof fallback === 'number') {
      const num = Number(val);
      return Number.isFinite(num) ? num : fallback;
    }

    if (typeof fallback === 'boolean') {
      if (typeof val === 'boolean') return val;
      if (val === 'true' || val === 1 || val === '1') return true;
      if (val === 'false' || val === 0 || val === '0') return false;
      return fallback;
    }

    return val != null ? val : fallback;
  } catch (e) {
    return fallback;
  }
}

async function ensureLogicVar(name, type, initialValue) {
  const existing = await findLogicVarByName(name);
  if (existing) return existing;

  return await Homey.logic.createVariable({
    variable: { name: name, type: type, value: initialValue }
  });
}

async function setLogicVar(name, type, value) {
  const variable = await ensureLogicVar(name, type, value);

  await Homey.logic.updateVariable({
    id: variable.id,
    variable: { value: value }
  });

  return variable;
}

async function appendLogLine(line) {
  const current = await getVar(LOG_VARIABLE, '');
  const lines = String(current || '')
    .split('\n')
    .filter(function(x) { return Boolean(x); });

  lines.push(line);

  while (lines.length > LOG_MAX_LINES) {
    lines.shift();
  }

  await setLogicVar(LOG_VARIABLE, 'string', lines.join('\n'));
}

async function addTimeline(text) {
  try {
    await Homey.flow.runFlowCardAction({
      uri: 'homey:flowcardaction:homey:manager:notifications:create_notification',
      id: 'homey:manager:notifications:create_notification',
      args: { text: text }
    });
    return true;
  } catch (e) {
    return false;
  }
}

// --------------------------
// Zonne-opbrengst potentiaal berekening
// --------------------------
function bereken_seizoensfactor(maandIndex) {
  const maandFactoren = [0.35, 0.45, 0.60, 0.80, 0.95, 1.00, 1.00, 0.90, 0.75, 0.55, 0.40, 0.30];

  if (maandIndex >= 0 && maandIndex < maandFactoren.length) {
    return maandFactoren[maandIndex];
  }

  return 0.60;
}

function bereken_zonne_potentiaal(uurVanDag, datum) {
  // Zonnepotentiaal per uur (0-1 schaal) - zon staat op z'n hoogst rond 12-13 uur
  // Dit is een vereenvoudigd patroon voor Nederland, vermenigvuldigd met een seizoensfactor.
  const zonnePatroon = [
    0.00, 0.00, 0.00, 0.00, 0.00, 0.02, 0.10, 0.25, 0.45, 0.70,
    0.85, 0.95, 1.00, 0.95, 0.85, 0.70, 0.45, 0.20, 0.05, 0.00,
    0.00, 0.00, 0.00, 0.00
  ];

  if (uurVanDag < 0 || uurVanDag >= 24) {
    return 0;
  }

  const maandIndex = datum ? datum.getMonth() : getLocalDate().getMonth();
  return zonnePatroon[uurVanDag] * bereken_seizoensfactor(maandIndex);
}

function bereken_zonne_window_score(uurVanDag, terugleverPrijs, datum) {
  const zonnePotentiaal = bereken_zonne_potentiaal(uurVanDag, datum);

  // Hoe lager de teruglever-prijs, hoe beter (je wilt buffervat laden als je goedkoper kunt terugleveren)
  // Normaliseer prijs naar 0-1: lage prijs = hoge score
  const prijs_factor = 1 - Math.min(Math.max(terugleverPrijs, 0) / 0.40, 1.0); // 0.40 EUR/kWh als referentie

  // Score = zonne-potentiaal * prijs-factor
  // Hoge zon + lage prijs = hoge score (ideaal moment)
  return zonnePotentiaal * prijs_factor;
}

function bereken_dag_zonne_potentiaal(datum) {
  let totaal = 0;

  for (let uur = SOLAR_OPTIMAL_START; uur <= SOLAR_OPTIMAL_END; uur++) {
    totaal += bereken_zonne_potentiaal(uur, datum);
  }

  return totaal;
}

function bepaal_solar_uren_vandaag(prijzen, datum) {
  const kandidaten = [];

  for (let uur = SOLAR_OPTIMAL_START; uur <= SOLAR_OPTIMAL_END; uur++) {
    const prijs = Number.isFinite(Number(prijzen[uur])) ? Number(prijzen[uur]) : 0.30;
    const score = bereken_zonne_window_score(uur, prijs, datum);

    if (score >= SOLAR_HOUR_MIN_SCORE) {
      kandidaten.push({ uur: uur, score: score, prijs: prijs });
    }
  }

  kandidaten.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.uur - b.uur;
  });

  const gekozen = kandidaten
    .slice(0, SOLAR_PLANNED_HOURS_COUNT)
    .sort(function(a, b) { return a.uur - b.uur; });

  return {
    uren: gekozen.map(function(item) { return item.uur; }),
    details: gekozen,
    totaleScore: gekozen.reduce(function(sum, item) { return sum + item.score; }, 0)
  };
}

async function haal_dag_zonne_forecast() {
  for (let i = 0; i < SOLAR_FORECAST_VARIABLE_CANDIDATES.length; i++) {
    const naam = SOLAR_FORECAST_VARIABLE_CANDIDATES[i];
    const waarde = await getVar(naam, null);
    const numeriek = Number(waarde);

    if (Number.isFinite(numeriek) && numeriek >= 0) {
      return {
        value: numeriek,
        source: naam
      };
    }
  }

  return null;
}

// --------------------------
// Devices ophalen
// --------------------------
const p1 = await Homey.devices.getDevice({ id: P1_ID });
const hp = await Homey.devices.getDevice({ id: DAIKIN_ID });
const dap = await Homey.devices.getDevice({ id: DAP_DEVICE_ID });

// --------------------------
// Actuele waarden
// --------------------------
const grid = Number(p1.capabilitiesObj.measure_power.value);
const currentTarget = Number(hp.capabilitiesObj.target_temperature.value);

if (!Number.isFinite(grid)) {
  throw new Error('Ongeldige grid waarde van P1');
}

if (!Number.isFinite(currentTarget)) {
  throw new Error('Ongeldige target_temperature van warmtepomp');
}

const now = getLocalDate();
const hour = now.getHours();
const outside = await getVar('Buitentemperatuur', 10);

// --------------------------
// Prijs via DAP device
// --------------------------
const dapCaps = dap.capabilitiesObj || {};

if (!dapCaps.meter_price_h0 || dapCaps.meter_price_h0.value == null) {
  throw new Error('DAP capability meter_price_h0 niet gevonden of leeg');
}

if (!dapCaps.meter_rank_price_h0_this_day || dapCaps.meter_rank_price_h0_this_day.value == null) {
  throw new Error('DAP capability meter_rank_price_h0_this_day niet gevonden of leeg');
}

const priceNow = Number(dapCaps.meter_price_h0.value);
const currentRankToday = Number(dapCaps.meter_rank_price_h0_this_day.value);

if (!Number.isFinite(priceNow)) {
  throw new Error('Ongeldige actuele prijs uit DAP device');
}

if (!Number.isFinite(currentRankToday)) {
  throw new Error('Ongeldige prijsrang uit DAP device');
}

// In jouw setup: #1 = goedkoopst, #24 = duurst
const isCheapHour = currentRankToday <= CHEAP_HOURS_COUNT;
const isExpensiveHour = currentRankToday > (DAY_HOURS_COUNT - EXPENSIVE_HOURS_COUNT);

// Verzamel alle prijzen voor de dag
const prijzenVandaag = [];
let visiblePricesCount = 0;
for (let i = 0; i < DAY_HOURS_COUNT; i++) {
  const capName = 'meter_price_h' + i;
  const cap = dapCaps[capName];
  if (cap && cap.value != null && Number.isFinite(Number(cap.value))) {
    const prijs = Number(cap.value);
    prijzenVandaag[i] = prijs;
    visiblePricesCount++;
  }
}

// --------------------------
// Dagstrategie op basis van zonne-opbrengst
// Als de dag voldoende zonnig is: alleen laden tijdens geselecteerde solar-uren.
// Anders: laden tijdens goedkope uren.
// --------------------------
const previousSolarBoostActive = await getVar(SOLAR_BOOST_ACTIVE_VARIABLE, false);
const daySolarForecast = await haal_dag_zonne_forecast();
const daySolarPotential = bereken_dag_zonne_potentiaal(now);
const plannedSolarWindow = bepaal_solar_uren_vandaag(prijzenVandaag, now);
const plannedSolarHours = plannedSolarWindow.uren;
const isPlannedSolarHour = plannedSolarHours.indexOf(hour) !== -1;
const solarDaySufficient = daySolarForecast
  ? daySolarForecast.value >= SOLAR_FORECAST_MIN_KWH
  : daySolarPotential >= SOLAR_DAY_MIN_POTENTIAL;
const solarStrategySource = daySolarForecast
  ? ('logic_var:' + daySolarForecast.source)
  : 'heuristic';

let solarBoostActive = false;
let solarBufferReason = '';

if (solarDaySufficient) {
  if (!plannedSolarHours.length) {
    solarBoostActive = false;
    solarBufferReason = 'Solar-dag actief, maar er zijn geen bruikbare solar-uren geselecteerd';
  } else if (!isPlannedSolarHour) {
    solarBoostActive = false;
    solarBufferReason = 'Solar-dag actief: huidig uur ' + hour + ' valt buiten solar-uren [' + plannedSolarHours.join(', ') + ']';
  } else if (previousSolarBoostActive) {
    if (grid > GRID_SOLAR_BOOST_OFF_WATT) {
      solarBoostActive = false;
      solarBufferReason = 'Solar boost UIT via buffer: grid ' + grid + 'W > ' + GRID_SOLAR_BOOST_OFF_WATT + 'W';
    } else {
      solarBoostActive = true;
      solarBufferReason = 'Solar boost blijft AAN in solar-uur via buffer: grid ' + grid + 'W <= ' + GRID_SOLAR_BOOST_OFF_WATT + 'W';
    }
  } else if (grid < GRID_SOLAR_BOOST_ON_WATT) {
    solarBoostActive = true;
    solarBufferReason = 'Solar boost AAN in gepland solar-uur: grid ' + grid + 'W < ' + GRID_SOLAR_BOOST_ON_WATT + 'W';
  } else {
    solarBoostActive = false;
    solarBufferReason = 'Solar-dag actief, maar wacht op overschot: grid ' + grid + 'W >= ' + GRID_SOLAR_BOOST_ON_WATT + 'W';
  }
} else {
  solarBoostActive = false;
  solarBufferReason = 'Dag-zonneopbrengst onvoldoende; buffervat gebruikt goedkope uren';
}

// --------------------------
// Vorige status
// --------------------------
const previousMode = await getVar(LAST_MODE_VARIABLE, 'UNKNOWN');
const previousTarget = await getVar(LAST_TARGET_VARIABLE, currentTarget);

// --------------------------
// Modus bepalen
// --------------------------
let mode = 'NORMAL';
let reasons = [];
let target = NORMAL;

reasons.push('Huidige prijs: ' + round(priceNow) + ' EUR/kWh');
reasons.push('Prijsrang vandaag: #' + currentRankToday + ' (1 = goedkoopst)');
reasons.push('Goedkoop uur: ' + isCheapHour);
reasons.push('Duur uur: ' + isExpensiveHour);
reasons.push('Zichtbare prijsblokken: ' + visiblePricesCount);
reasons.push('Zonne-dag voldoende: ' + solarDaySufficient + ' (' + solarStrategySource + ')');
if (daySolarForecast) {
  reasons.push('Dag-zonneprognose: ' + round(daySolarForecast.value, 1) + ' kWh');
} else {
  reasons.push('Dag-zonnepotentiaal (heuristiek): ' + round(daySolarPotential, 2));
}
reasons.push('Geplande solar-uren: ' + (plannedSolarHours.length ? plannedSolarHours.join(', ') : 'geen'));
reasons.push('Huidig uur in solar-plan: ' + isPlannedSolarHour);
reasons.push(solarBufferReason);

// Prioriteit:
// 1. zonne-overschot in gepland solar-uur -> BOOST
// 2. duurste 8 uren -> ECO
// 3. goedkope uren -> BOOST, maar alleen als de dag-zonneopbrengst NIET voldoende is
// 4. anders -> NORMAL
if (solarBoostActive) {
  mode = 'BOOST_SOLAR';
  target = BOOST;
  reasons.push('Buffervat verwarmen op zonne-overschot binnen gepland solar-uur');
  if (isExpensiveHour) {
    reasons.push('Zonne-overschot override op duur uur');
  }
} else if (isExpensiveHour) {
  mode = 'ECO_EXPENSIVE';
  target = ECO;
  reasons.push('Buffervat naar ECO omdat huidig uur in de ' + EXPENSIVE_HOURS_COUNT + ' duurste uren valt');
} else if (!solarDaySufficient && isCheapHour) {
  mode = 'BOOST_CHEAP';
  target = BOOST;
  reasons.push('Dag-zonneopbrengst onvoldoende: buffervat verwarmen in goedkoop uur');
} else {
  mode = 'NORMAL';
  target = NORMAL;
  if (solarDaySufficient) {
    reasons.push('Dag-zonneopbrengst voldoende: goedkope uren worden overgeslagen buiten het solar-plan');
  } else {
    reasons.push('Geen zonne-overschot, niet in goedkoopste uren en niet in duurste uren');
  }
}

// --------------------------
// COP optimalisatie
// Alleen buiten BOOST modi
// --------------------------
const isBoostMode = (mode === 'BOOST_SOLAR' || mode === 'BOOST_CHEAP');

if (!isBoostMode) {
  if (outside > COP_THRESHOLD_WARM) target = Math.min(target, COP_TEMP_WARM);
  else if (outside > COP_THRESHOLD_MILD) target = Math.min(target, COP_TEMP_MILD);
  else if (outside > COP_THRESHOLD_COOL) target = Math.min(target, COP_TEMP_COOL);
  else if (outside < COP_THRESHOLD_COLD) target = Math.max(COP_TEMP_COLD, target);

  reasons.push('COP optimalisatie toegepast');
} else {
  reasons.push('COP optimalisatie overgeslagen (BOOST modus)');
}

// --------------------------
// Hysterese
// --------------------------
let hysteresisHeld = false;

if (Math.abs(currentTarget - target) < 1) {
  hysteresisHeld = true;
  target = currentTarget;
  reasons.push('Hysterese actief');
}

// --------------------------
// Toepassen
// --------------------------
let changed = false;
let action = 'none';

if (target !== currentTarget) {
  await hp.setCapabilityValue('target_temperature', target);
  changed = true;
  action = 'Setpoint ' + currentTarget + '->' + target;
  reasons.push(action);
} else {
  reasons.push('Geen wijziging nodig');
}

// Solar buffer status opslaan
await setLogicVar(SOLAR_BOOST_ACTIVE_VARIABLE, 'boolean', solarBoostActive);

// --------------------------
// Logging
// --------------------------
const reasonText = reasons.join(' | ');
const timestamp = nowIsoLocal();

const modeChanged = mode !== previousMode;
const targetChangedVsPreviousRun = Number(previousTarget) !== Number(target);

const summary =
  '[' + timestamp + ']' +
  ' mode=' + mode +
  ', hour=' + hour +
  ', grid=' + grid +
  ', priceNow=' + round(priceNow) +
  ', rankToday=' + currentRankToday +
  ', isCheapHour=' + isCheapHour +
  ', isExpensiveHour=' + isExpensiveHour +
  ', visiblePricesCount=' + visiblePricesCount +
  ', solarDaySufficient=' + solarDaySufficient +
  ', solarStrategySource=' + solarStrategySource +
  ', daySolarForecast=' + (daySolarForecast ? round(daySolarForecast.value, 1) : 'n/a') +
  ', daySolarPotential=' + round(daySolarPotential, 2) +
  ', plannedSolarHours=' + (plannedSolarHours.length ? plannedSolarHours.join(',') : 'none') +
  ', isPlannedSolarHour=' + isPlannedSolarHour +
  ', solarBoostActive=' + solarBoostActive +
  ', outside=' + outside +
  ', currentTarget=' + currentTarget +
  ', target=' + target +
  ', changed=' + changed +
  ', reason=' + reasonText;

await appendLogLine(summary);
await setLogicVar(LAST_REASON_VARIABLE, 'string', reasonText);
await setLogicVar(LAST_MODE_VARIABLE, 'string', mode);
await setLogicVar(LAST_TARGET_VARIABLE, 'number', target);
await setLogicVar(LAST_RUN_VARIABLE, 'string', timestamp);

// --------------------------
// Timeline
// --------------------------
let timelineSent = false;

if (SEND_TIMELINE_ALWAYS || (SEND_TIMELINE_ON_CHANGE && (changed || modeChanged || targetChangedVsPreviousRun))) {
  const text =
    'Warmtepomp ' + mode +
    ': ' + currentTarget + '->' + target +
    ' (uur ' + hour + ', prijs ' + round(priceNow) + ' EUR/kWh, rang #' + currentRankToday + ', grid ' + grid + 'W)';
  timelineSent = await addTimeline(text);
}

// --------------------------
// Resultaat
// --------------------------
return {
  mode: mode,
  hour: hour,
  grid: grid,
  priceNow: priceNow,
  currentRankToday: currentRankToday,
  isCheapHour: isCheapHour,
  isExpensiveHour: isExpensiveHour,
  visiblePricesCount: visiblePricesCount,
  solarDaySufficient: solarDaySufficient,
  solarStrategySource: solarStrategySource,
  daySolarForecast: daySolarForecast ? daySolarForecast.value : null,
  daySolarPotential: daySolarPotential,
  plannedSolarHours: plannedSolarHours,
  isPlannedSolarHour: isPlannedSolarHour,
  solarBoostActive: solarBoostActive,
  outside: outside,
  currentTarget: currentTarget,
  target: target,
  changed: changed,
  action: action,
  hysteresisHeld: hysteresisHeld,
  timelineSent: timelineSent
};