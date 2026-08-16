// ==========================
// Accu Laadplan - Homey Script
// Vult het tekort tussen accucapaciteit en verwachte zonopbrengst aan vanaf
// het net, en doet dat alleen tijdens de goedkoopste kwartierblokken van de
// dag die nodig zijn om dat tekort te dekken.
//
// Werking (elke run herberekend, geen eenmalig ochtendplan):
// 1. tekort = min(resterende ruimte in accu, 14 kWh - zon-forecast)
// 2. blokken nodig = tekort / (maxLaadvermogen x kwartier), afgerond naar boven
// 3. als het huidige kwartierblok bij de N goedkoopste van vandaag hoort ÉN er
//    nu geen zon beschikbaar is -> zet grid_charge_power op maxLaadvermogen,
//    anders op 0. Zon heeft dus altijd voorrang via de normale zelfconsumptie-
//    modus van het apparaat; dit script grijpt alleen in als er geen zon is.
//
// Vereist: Anker Solix app in Modbus-modus (grid_charge_power werkt niet via cloud).
//
// Zon-forecast komt van het Power by the Hour-device Zonnepanelen_Σsolar
// (capability meter_kwh_forecast.this_day, "Prognose deze dag").
//
// Fallback vanaf fallbackCheckVanafUur (standaard 13:00): als de werkelijk
// geproduceerde zon tot dan toe (meter_kwh_this_day) al achterblijft bij wat
// de accu nodig heeft, telt dát als tekort mee naast de dagforecast. Dit vangt
// dagen op waarop de forecast (te) optimistisch bleek (bijv. onverwachte
// bewolking), zodat er nog een net-laadmoment in de resterende goedkope
// blokken van de middag gepakt kan worden in plaats van dat de accu de avond
// halfleeg in gaat.
//
// Flow-setup: cron elke 15 minuten (aansluitend op de kwartier-prijsblokken).
//
// Logging: elke run wordt weggeschreven naar de logic-variabele
// accu_laadplan_log (rolling, laatste logMaxRegels regels) — te bekijken via
// Meer > Logica > Variabelen. De Homey-tijdlijn krijgt alleen een melding als
// de categorie (geen-tekort / laden / zon-heeft-voorrang / wachten) écht
// wijzigt, niet bij elke kleine schommeling in kWh/prijsrang/blokkenNodig.
// ==========================

const config = {
  accuDeviceId:            'd0b80416-826c-4db9-9a4e-163796f60d5a', // "Accu"
  dapDeviceId:              'adc99ffc-add2-40d0-b664-8ce3b19c28af', // Power by the Hour: NL_Netherlands
  zonForecastDeviceId:      '865bc38a-e913-4771-aec7-b6bc7ab46b6a', // Zonnepanelen_Σsolar (Power by the Hour) — "Prognose deze dag"

  accuCapaciteitKwh:        14,
  maxLaadvermogenWatt:      3500,
  blokMinuten:              15,
  blokkenPerDag:            96,
  minTekortKwh:             0.2, // kleiner tekort dan dit: niet de moeite
  zonAanwezigDrempelWatt:   100, // boven dit vermogen: zon regelt het zelf, niet ingrijpen
  fallbackCheckVanafUur:    13, // vanaf dit lokale uur ook op werkelijke zon-tot-nu-toe checken

  prijsVariabele:            'electra_prijs', // all-in prijs, berekend door Electra_Prijs.js

  logVariabele:  'accu_laadplan_log',
  logMaxRegels:  40,

  dryRun: false,
  sendTimelineUpdates: true,

  stateKey: 'accu_laadplan_last_state',
};

// ─── Hulpfuncties ────────────────────────────────────────────────────────────

function logLine(msg) {
  log(`[AccuLaadplan] ${msg}`);
}

function afronding(waarde, decimalen = 2) {
  return Number(Number(waarde).toFixed(decimalen));
}

function haalLokaalDatum() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })
  );
}

function haalLokaalUur() {
  return haalLokaalDatum().getHours();
}

function haalNuIsoLokaal() {
  const d = haalLokaalDatum();
  const opvullen = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${opvullen(d.getMonth() + 1)}-${opvullen(d.getDate())} ` +
    `${opvullen(d.getHours())}:${opvullen(d.getMinutes())}:${opvullen(d.getSeconds())}`;
}

async function zoekLogicaVariabelPerNaam(naam) {
  const variabelen = await Homey.logic.getVariables();
  return Object.values(variabelen).find(v => v.name === naam) || null;
}

async function haalLogicaVariabele(naam, fallback = 0) {
  const gevonden = await zoekLogicaVariabelPerNaam(naam);
  if (!gevonden) return fallback;
  const getal = Number(gevonden.value);
  return Number.isFinite(getal) ? getal : fallback;
}

async function zorgVoorLogicaVariabele(naam, type, beginwaarde) {
  const bestaande = await zoekLogicaVariabelPerNaam(naam);
  if (bestaande) return bestaande;
  return await Homey.logic.createVariable({ variable: { name: naam, type, value: beginwaarde } });
}

async function stelLogicaVariabeleIn(naam, type, waarde) {
  const variabele = await zorgVoorLogicaVariabele(naam, type, waarde);
  await Homey.logic.updateVariable({ id: variabele.id, variable: { value: waarde } });
  return variabele;
}

async function voegLogRegelToe(regel) {
  const bestaande = await zoekLogicaVariabelPerNaam(config.logVariabele);
  const huidig = bestaande && typeof bestaande.value === 'string' ? bestaande.value : '';
  const regels = huidig.split('\n').filter(Boolean);

  regels.push(regel);
  while (regels.length > config.logMaxRegels) regels.shift();

  await stelLogicaVariabeleIn(config.logVariabele, 'string', regels.join('\n'));
}

async function sendTimeline(tekst) {
  if (!config.sendTimelineUpdates) return false;
  try {
    await Homey.flow.runFlowCardAction({
      uri: 'homey:flowcardaction:homey:manager:notifications:create_notification',
      id: 'homey:manager:notifications:create_notification',
      args: { text: tekst }
    });
    return true;
  } catch (e) {
    logLine(`Tijdlijn mislukt: ${e.message}`);
    return false;
  }
}

async function sendTimelineIfChanged(newState, message) {
  const previousState = global.get(config.stateKey);

  if (previousState !== newState) {
    await sendTimeline(message);
    global.set(config.stateKey, newState);
    return true;
  }
  return false;
}

// ─── Apparaten & data ophalen ─────────────────────────────────────────────────

const accu = await Homey.devices.getDevice({ id: config.accuDeviceId });
const dap  = await Homey.devices.getDevice({ id: config.dapDeviceId });
const zonForecast = await Homey.devices.getDevice({ id: config.zonForecastDeviceId });

if (!accu) throw new Error(`Accu-apparaat (${config.accuDeviceId}) niet gevonden`);
if (!dap)  throw new Error(`Prijs-apparaat (${config.dapDeviceId}) niet gevonden`);
if (!zonForecast) throw new Error(`Zon-forecast-apparaat (${config.zonForecastDeviceId}) niet gevonden`);

const soc = Number(accu.capabilitiesObj?.measure_battery?.value);
if (!Number.isFinite(soc)) throw new Error("Ongeldige 'measure_battery' op Accu");

const huidigLaadvermogen = Number(accu.capabilitiesObj?.grid_charge_power?.value) || 0;
const huidigZonvermogen  = Number(accu.capabilitiesObj?.solar_power?.value) || 0;
const zonBeschikbaar     = huidigZonvermogen > config.zonAanwezigDrempelWatt;

const prijsRang = Number(dap.capabilitiesObj?.meter_rank_price_h0_this_day?.value);
if (!Number.isFinite(prijsRang)) throw new Error("Ongeldige 'meter_rank_price_h0_this_day' op DAP-apparaat");

const solarForecastDag = Number(zonForecast.capabilitiesObj?.['meter_kwh_forecast.this_day']?.value) || 0;
const actueleZonKwhVandaag = Number(zonForecast.capabilitiesObj?.['meter_kwh_this_day']?.value) || 0;
const huidigePrijs = await haalLogicaVariabele(config.prijsVariabele, 0);

// ─── Tekort berekenen ──────────────────────────────────────────────────────────

const huidigUur = haalLokaalUur();
const fallbackActief = huidigUur >= config.fallbackCheckVanafUur;

const huidigeKwh = (soc / 100) * config.accuCapaciteitKwh;
const resterendeRuimteKwh = Math.max(0, config.accuCapaciteitKwh - huidigeKwh);
const theoretischTekortKwhForecast = Math.max(0, config.accuCapaciteitKwh - solarForecastDag);
const theoretischTekortKwhActueel = fallbackActief
  ? Math.max(0, config.accuCapaciteitKwh - actueleZonKwhVandaag)
  : 0;
const theoretischTekortKwh = Math.max(theoretischTekortKwhForecast, theoretischTekortKwhActueel);
const viaFallback = theoretischTekortKwhActueel > theoretischTekortKwhForecast;
const tekortKwh = Math.min(theoretischTekortKwh, resterendeRuimteKwh);

const heeftTekort = tekortKwh >= config.minTekortKwh;

// ─── Benodigde blokken + prijsdrempel ──────────────────────────────────────────

const kwhPerBlok = (config.maxLaadvermogenWatt / 1000) * (config.blokMinuten / 60);
const blokkenNodig = heeftTekort
  ? Math.min(config.blokkenPerDag, Math.ceil(tekortKwh / kwhPerBlok))
  : 0;

const isGoedkoopGenoeg = heeftTekort && prijsRang <= blokkenNodig;
const magNetLaden = isGoedkoopGenoeg && !zonBeschikbaar;
const gewenstVermogen = magNetLaden ? config.maxLaadvermogenWatt : 0;

const logRegel =
  `[${haalNuIsoLokaal()}] soc=${soc}% (${afronding(huidigeKwh)} kWh) | ruimte=${afronding(resterendeRuimteKwh)} kWh | ` +
  `zonForecast=${afronding(solarForecastDag)} kWh | zonWerkelijkVandaag=${afronding(actueleZonKwhVandaag)} kWh ` +
  `(fallback${fallbackActief ? '' : ' nog niet'} actief vanaf ${config.fallbackCheckVanafUur}u) | ` +
  `tekort=${afronding(tekortKwh)} kWh${viaFallback ? ' [via fallback]' : ''} | blokkenNodig=${blokkenNodig}/${config.blokkenPerDag} | ` +
  `prijsRang=#${prijsRang} (${afronding(huidigePrijs, 4)}) | goedkoopGenoeg=${isGoedkoopGenoeg} | ` +
  `zonNu=${huidigZonvermogen}W (beschikbaar=${zonBeschikbaar}) | magNetLaden=${magNetLaden} | ` +
  `huidig=${huidigLaadvermogen}W -> gewenst=${gewenstVermogen}W`;

logLine(logRegel);
await voegLogRegelToe(logRegel);

// ─── Toepassen ─────────────────────────────────────────────────────────────────

let gewijzigd = false;

if (gewenstVermogen !== huidigLaadvermogen) {
  if (!config.dryRun) {
    await accu.setCapabilityValue('grid_charge_power', gewenstVermogen);
  }
  gewijzigd = true;
}

// ─── Tijdlijn ──────────────────────────────────────────────────────────────────
// Categorie bepaalt of er een tijdlijnmelding komt (alleen bij écht andere
// categorie); message is puur de tekst van die ene melding en mag dus best
// per run in details verschillen zonder extra meldingen te veroorzaken.

let categorie;
let message;

if (!heeftTekort) {
  categorie = 'geen-tekort';
  message = `Accu: geen netlaadtekort (zon dekt naar verwachting ${afronding(solarForecastDag)} kWh)`;
} else if (magNetLaden) {
  categorie = viaFallback ? 'laden-fallback' : 'laden';
  message = `Accu laadt vanaf net: ${gewenstVermogen}W (prijsrang #${prijsRang}, tekort ${afronding(tekortKwh)} kWh, ${blokkenNodig} blokken nodig)` +
    (viaFallback ? ` — werkelijke zon vandaag (${afronding(actueleZonKwhVandaag)} kWh) blijft achter bij de forecast (${afronding(solarForecastDag)} kWh)` : '');
} else if (isGoedkoopGenoeg && zonBeschikbaar) {
  categorie = 'zon-heeft-voorrang';
  message = `Accu: goedkoop moment maar zon (${huidigZonvermogen}W) regelt het laden al zelf`;
} else {
  categorie = 'wachten';
  message = `Accu wacht op goedkoper moment (prijsrang #${prijsRang} > ${blokkenNodig} benodigde blokken, tekort ${afronding(tekortKwh)} kWh)`;
}

const tijdlijnVerstuurd = await sendTimelineIfChanged(categorie, message);

// ─── Resultaat ─────────────────────────────────────────────────────────────────

return {
  soc,
  huidigeKwh: afronding(huidigeKwh),
  resterendeRuimteKwh: afronding(resterendeRuimteKwh),
  solarForecastDag: afronding(solarForecastDag),
  actueleZonKwhVandaag: afronding(actueleZonKwhVandaag),
  fallbackActief,
  viaFallback,
  tekortKwh: afronding(tekortKwh),
  heeftTekort,
  blokkenNodig,
  prijsRang,
  huidigePrijs,
  isGoedkoopGenoeg,
  huidigZonvermogen,
  zonBeschikbaar,
  magNetLaden,
  huidigLaadvermogen,
  gewenstVermogen,
  gewijzigd,
  categorie,
  message,
  logRegel,
  tijdlijnVerstuurd,
  dryRun: config.dryRun
};
