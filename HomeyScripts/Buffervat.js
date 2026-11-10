// ==========================
// Warmwaterbuffer (Buffervat) - Homey Script
// Verwarmen / verlagen op basis van:
// 1. Vakantie -> minimum temperatuur (geen zonne-boost, geen negatieve-prijs-boost)
// 2. Negatieve all-in prijs -> BOOST 56°C (verbruiken loont, overschrijft ECO)
// 3. 8 duurste uren -> ECO (zon genegeerd, terugleveren loont meer)
// 4. Zonne-overschot ÉN 6 goedkoopste uren tegelijk -> BOOST 56°C
// 5. Alleen 6 goedkoopste uren (geen zon) -> BOOST 52°C
// 6. Anders (incl. zon zonder goedkoop uur) -> NORMAAL (zon gaat terug het net op)
//
// Zonne-overschot wordt gedetecteerd via de P1 (netto export) ÉN via het
// live zonvermogen van de Accu (Solarbank). De Accu vangt zon namelijk eerst
// op voordat er iets bij de P1-meter zichtbaar wordt, dus met alleen P1 zou
// Buffervat pas boosten als de Accu al (bijna) vol is. Met het Accu-signaal
// erbij mag Buffervat ook al meeboosten terwijl de Accu nog laadt.
//
// Zowel de dagforecast ("Prognose deze dag") als de rollende 3-uursforecast
// komen van het Power by the Hour-device Zonnepanelen_Σsolar (capabilities
// meter_kwh_forecast.this_day resp. measure_watt_forecast.*) — geen
// afhankelijkheid meer van het eigen forecast.solar-script (Solar_Forecast.js
// is verwijderd).
// Met logging + redenen + optionele Timeline
// ==========================

// ---------- Apparaat IDs ----------
const P1_APPARAAT_ID = '3755a652-027b-41bb-b188-ab2ac592ee04';
const WARMTEPOMP_ID = 'd9a883d7-6322-4b73-820d-cd259bde862c';
const DYNAMISCHE_ENERGIE_PRIJS_ID = 'adc99ffc-add2-40d0-b664-8ce3b19c28af'; // Power by the Hour: NL_Netherlands (Frank Energie opslag)
const ACCU_APPARAAT_ID = 'd0b80416-826c-4db9-9a4e-163796f60d5a'; // Solarbank ("Accu")
const ZON_FORECAST_APPARAAT_ID = '865bc38a-e913-4771-aec7-b6bc7ab46b6a'; // Zonnepanelen_Σsolar (Power by the Hour) — "Prognose deze dag"

// ---------- Instellingen warmtepomp doeltemperaturen ----------
const VAKANTIE_TEMPERATUUR = 45;
const ECO_TEMPERATUUR = 47;
const NORMAAL_TEMPERATUUR = 49;
const BOOST_TEMPERATUUR_ZONNE = 56;
const BOOST_TEMPERATUUR_STANDAARD = 52;

// ---------- Drempels zonne-overschot met hysterese ----------
const ZONNE_BOOST_AAN_WATT = -2500;   // boost INSCHAKELEN (P1 netto export)
const ZONNE_BOOST_UIT_WATT = -500;    // boost UITSCHAKELEN (P1 netto export)

// Live zonvermogen dat de Accu (Solarbank) zelf rapporteert. Dit signaal
// reageert eerder dan P1, omdat de Accu zon eerst zelf opvangt/laadt
// voordat er iets exporteert. Combinatie met P1 is een OR/OR-hysterese:
// AAN zodra één van de twee signalen genoeg overschot ziet, UIT pas als
// beide signalen weer laag genoeg zijn.
const ACCU_ZON_AAN_WATT = 3000;       // boost INSCHAKELEN (Accu solar_power)
const ACCU_ZON_UIT_WATT = 1000;       // boost UITSCHAKELEN (Accu solar_power)

// ---------- Prijs instellingen ----------
// meter_rank_price_h0_this_day rangschikt op kwartierblokken (96/dag ipv 24 uren),
// dus "aantal uren" wordt hieronder omgerekend naar blokken (x4).
const GOEDKOOPSTE_UREN_AANTAL = 6;
const DUURSTE_UREN_AANTAL = 8;
const BLOKKEN_PER_DAG = 96;
const SOLAR_FORECAST_SKIP_BOOST_KWH = 3; // rollende 3-uursforecast, drempel om zonne-boost vrij te geven
const SOLAR_FORECAST_DAG_SKIP_BOOST_KWH = 10; // alternatief: "Prognose deze dag" al ruim genoeg, ook als de 3-uursforecast nog laag is

// ---------- All-in prijs ----------
// Komt uit de gedeelde logica-variabele 'electra_prijs' (berekend door Electra_Prijs.js).

// ---------- Logging ----------
const LOG_MAX_REGELS = 40;
const STUUR_TIJDLIJN_BIJ_WIJZIGING = true;
const STUUR_TIJDLIJN_ALTIJD = false;

const LOG_VARIABELE = 'buffervat_log';
const LAATSTE_REDEN_VARIABELE = 'buffervat_laatste_reden';
const LAATSTE_MODUS_VARIABELE = 'buffervat_laatste_modus';
const LAATSTE_DOELTEMP_VARIABELE = 'buffervat_laatste_doeltemp';
const LAATSTE_RESULTAAT_VARIABELE = 'buffervat_laatste_resultaat';
const ZONNE_BOOST_ACTIEF_VARIABELE = 'buffervat_zonne_boost_actief';
const IS_DUUR_UUR_VARIABELE = 'isDuurUur';

// --------------------------
// Hulpfuncties
// --------------------------
function afronding(waarde, decimalen) {
  if (decimalen === undefined) decimalen = 2;
  return Number(Number(waarde).toFixed(decimalen));
}

function haalNumeriekeCapabilityWaarde(capabilitiesObj, namen) {
  for (let i = 0; i < namen.length; i++) {
    const naam = namen[i];
    const capability = capabilitiesObj[naam];

    if (!capability || capability.value == null) {
      continue;
    }

    const waarde = Number(capability.value);
    if (Number.isFinite(waarde)) {
      return {
        naam: naam,
        waarde: waarde
      };
    }
  }

  return null;
}

function bepaalWarmtepompTemperatuurInfo(capabilitiesObj) {
  const voorkeursNamen = [
    'measure_temperature.water',
    'measure_temperature.dhw',
    'measure_temperature_1',
    'measure_temperature_2',
    'measure_temperature',
    'temperature_water',
    'water_temperature',
    'hot_water_temperature',
    'boiler_temperature'
  ];

  const gevondenVoorkeur = haalNumeriekeCapabilityWaarde(capabilitiesObj, voorkeursNamen);
  const alleNamen = Object.keys(capabilitiesObj || {});
  const debugTemperaturen = [];

  for (let i = 0; i < alleNamen.length; i++) {
    const naam = alleNamen[i];
    const isRelevant = /temp|water/i.test(naam) && naam !== 'target_temperature';

    if (!isRelevant) {
      continue;
    }

    const capability = capabilitiesObj[naam];
    if (!capability || capability.value == null) {
      continue;
    }

    const waarde = Number(capability.value);
    if (!Number.isFinite(waarde)) {
      continue;
    }

    debugTemperaturen.push(naam + ':' + afronding(waarde));
  }

  return {
    gemetenTemperatuur: gevondenVoorkeur ? gevondenVoorkeur.waarde : null,
    gemetenTemperatuurCapability: gevondenVoorkeur ? gevondenVoorkeur.naam : 'onbekend',
    temperatuurDebugLijst: debugTemperaturen.length ? debugTemperaturen.join(',') : 'geen'
  };
}

// Power by the Hour geeft Watt-forecastpunten op vaste momenten
// (nu, +15/30/45 min, +1u/2u/3u). Trapezium-integratie daarvan geeft een
// schatting van de opbrengst (kWh) in de komende 3 uur.
function bepaalZonForecastKwh3Uur(capabilitiesObj) {
  const punten = [
    { uur: 0, watt: Number(capabilitiesObj['measure_watt_forecast.h0']?.value) },
    { uur: 0.25, watt: Number(capabilitiesObj['measure_watt_forecast.m15']?.value) },
    { uur: 0.5, watt: Number(capabilitiesObj['measure_watt_forecast.m30']?.value) },
    { uur: 0.75, watt: Number(capabilitiesObj['measure_watt_forecast.m45']?.value) },
    { uur: 1, watt: Number(capabilitiesObj['measure_watt_forecast.h1']?.value) },
    { uur: 2, watt: Number(capabilitiesObj['measure_watt_forecast.h2']?.value) },
    { uur: 3, watt: Number(capabilitiesObj['measure_watt_forecast.h3']?.value) }
  ].filter(function(p) { return Number.isFinite(p.watt); });

  let kwh = 0;
  for (let i = 1; i < punten.length; i++) {
    const duurUur = punten[i].uur - punten[i - 1].uur;
    const gemiddeldWatt = (punten[i].watt + punten[i - 1].watt) / 2;
    kwh += (gemiddeldWatt * duurUur) / 1000;
  }

  return kwh;
}

function haalLokaalDatum() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })
  );
}

function haalNuIsoLokaal() {
  const d = haalLokaalDatum();
  const opvullen = function(n) {
    return String(n).padStart(2, '0');
  };

  return d.getFullYear() + '-' +
    opvullen(d.getMonth() + 1) + '-' +
    opvullen(d.getDate()) + ' ' +
    opvullen(d.getHours()) + ':' +
    opvullen(d.getMinutes()) + ':' +
    opvullen(d.getSeconds());
}

async function haalAlleLogicaVariabelen() {
  return await Homey.logic.getVariables();
}

async function zoekLogicaVariabelPerNaam(naam) {
  const variabelen = await haalAlleLogicaVariabelen();
  const alleVariabelen = Object.values(variabelen);

  for (let i = 0; i < alleVariabelen.length; i++) {
    if (alleVariabelen[i].name === naam) {
      return alleVariabelen[i];
    }
  }

  return null;
}

async function haalVariabele(naam, fallback) {
  try {
    const gevonden = await zoekLogicaVariabelPerNaam(naam);
    if (!gevonden) return fallback;

    const waarde = gevonden.value;

    if (typeof fallback === 'number') {
      const getal = Number(waarde);
      return Number.isFinite(getal) ? getal : fallback;
    }

    if (typeof fallback === 'boolean') {
      if (typeof waarde === 'boolean') return waarde;
      if (waarde === 'true' || waarde === 1 || waarde === '1') return true;
      if (waarde === 'false' || waarde === 0 || waarde === '0') return false;
      return fallback;
    }

    return waarde != null ? waarde : fallback;
  } catch (e) {
    return fallback;
  }
}

async function zorgVoorLogicaVariabele(naam, type, beginwaarde) {
  const bestaande = await zoekLogicaVariabelPerNaam(naam);
  if (bestaande) return bestaande;

  return await Homey.logic.createVariable({
    variable: { name: naam, type: type, value: beginwaarde }
  });
}

async function stellogicaVariabeleIn(naam, type, waarde) {
  const variabele = await zorgVoorLogicaVariabele(naam, type, waarde);

  await Homey.logic.updateVariable({
    id: variabele.id,
    variable: { value: waarde }
  });

  return variabele;
}

async function voegLogRegelToe(regel) {
  const huidig = await haalVariabele(LOG_VARIABELE, '');
  const regels = String(huidig || '')
    .split('\n')
    .filter(function(x) { return Boolean(x); });

  regels.push(regel);

  while (regels.length > LOG_MAX_REGELS) {
    regels.shift();
  }

  await stellogicaVariabeleIn(LOG_VARIABELE, 'string', regels.join('\n'));
}

async function voegTijdlijnToe(tekst) {
  try {
    await Homey.flow.runFlowCardAction({
      uri: 'homey:flowcardaction:homey:manager:notifications:create_notification',
      id: 'homey:manager:notifications:create_notification',
      args: { text: tekst }
    });
    return true;
  } catch (e) {
    return false;
  }
}

// --------------------------
// Apparaten ophalen
// --------------------------
const p1 = await Homey.devices.getDevice({ id: P1_APPARAAT_ID });
const warmtepomp = await Homey.devices.getDevice({ id: WARMTEPOMP_ID });
const dap = await Homey.devices.getDevice({ id: DYNAMISCHE_ENERGIE_PRIJS_ID });
const accu = await Homey.devices.getDevice({ id: ACCU_APPARAAT_ID });
const zonForecastApparaat = await Homey.devices.getDevice({ id: ZON_FORECAST_APPARAAT_ID });
const warmtepompTemperatuurInfo = bepaalWarmtepompTemperatuurInfo(warmtepomp.capabilitiesObj || {});

// --------------------------
// Actuele waarden lezen
// --------------------------
const netwerkvermogen = Number(p1.capabilitiesObj.measure_power.value);
const huidigDoeltemperatuur = Number(warmtepomp.capabilitiesObj.target_temperature.value);

if (!Number.isFinite(netwerkvermogen)) {
  throw new Error('Ongeldig netwerkvermogen van P1');
}

if (!Number.isFinite(huidigDoeltemperatuur)) {
  throw new Error('Ongeldig doeltemperatuur van warmtepomp');
}

const nu = haalLokaalDatum();
const uur = nu.getHours();
const buitentemp = await haalVariabele('Buitentemperatuur', 10);
const zonForecastCapaciteiten = zonForecastApparaat.capabilitiesObj || {};
const solarForecast = afronding(bepaalZonForecastKwh3Uur(zonForecastCapaciteiten), 2);
const solarForecastDag = Number(zonForecastCapaciteiten['meter_kwh_forecast.this_day']?.value) || 0;

// --------------------------
// Accu (Solarbank) status
// --------------------------
const accuZonVermogen = Number(accu.capabilitiesObj?.solar_power?.value) || 0;
const accuSoc = Number(accu.capabilitiesObj?.measure_battery?.value);

// --------------------------
// Prijzen via DAP-apparaat + gedeelde all-in-prijsvariabele
// --------------------------
const dapCapaciteiten = dap.capabilitiesObj || {};

if (!dapCapaciteiten.meter_rank_price_h0_this_day || dapCapaciteiten.meter_rank_price_h0_this_day.value == null) {
  throw new Error('DAP capaciteit meter_rank_price_h0_this_day niet gevonden of leeg');
}

const huidigePrijsRang = Number(dapCapaciteiten.meter_rank_price_h0_this_day.value);

if (!Number.isFinite(huidigePrijsRang)) {
  throw new Error('Ongeldige prijsrang uit DAP-apparaat');
}

// In deze setup: #1 = goedkoopst, #96 = duurst (kwartierblokken)
const isGoedkoopUur = huidigePrijsRang <= (GOEDKOOPSTE_UREN_AANTAL * 4);
const isDuurUur = huidigePrijsRang > (BLOKKEN_PER_DAG - (DUURSTE_UREN_AANTAL * 4));

// All-in prijs komt uit de gedeelde variabele (berekend door NegatievePrijsMelding.js)
const huidigePrijsAllIn = await haalVariabele('electra_prijs', 0);
const isNegatieveAllInPrijs = huidigePrijsAllIn < 0;

// ---------- Vakantie ----------
const opVakantie = await haalVariabele('vakantie', false);

// --------------------------
// Zonne-overschot buffer / hysterese
// --------------------------
// Forecast-gate: hetzij de rollende 3-uursforecast, hetzij de hele dagforecast
// is genoeg reden om zonne-boost sowieso vrij te geven.
const zonneBoostAan = solarForecast >= SOLAR_FORECAST_SKIP_BOOST_KWH
  || solarForecastDag >= SOLAR_FORECAST_DAG_SKIP_BOOST_KWH;

const vorighZonneBoostActief = await haalVariabele(ZONNE_BOOST_ACTIEF_VARIABELE, false);
let zonneBoostActief = vorighZonneBoostActief;
let zonnebufferReden = '';

// Twee onafhankelijke signalen voor "er is nu zonne-overschot":
// - P1 netto export (pas negatief ná Accu-lading, dus reageert laat)
// - Accu's eigen live zonvermogen (reageert direct, ook terwijl Accu nog laadt)
const netToontOverschot = netwerkvermogen < ZONNE_BOOST_AAN_WATT;
const netToontGeenOverschotMeer = netwerkvermogen > ZONNE_BOOST_UIT_WATT;
const accuToontOverschot = accuZonVermogen > ACCU_ZON_AAN_WATT;
const accuToontGeenOverschotMeer = accuZonVermogen < ACCU_ZON_UIT_WATT;

if (!zonneBoostAan) {
  zonneBoostActief = false;
  zonnebufferReden = 'Zonne-boost uitgeschakeld (forecast 3u ' + solarForecast + ' kWh < ' + SOLAR_FORECAST_SKIP_BOOST_KWH + ' kWh, dag ' + solarForecastDag + ' kWh < ' + SOLAR_FORECAST_DAG_SKIP_BOOST_KWH + ' kWh)';
} else if (vorighZonneBoostActief) {
  // Pas uitschakelen als BEIDE signalen geen overschot meer laten zien.
  if (netToontGeenOverschotMeer && accuToontGeenOverschotMeer) {
    zonneBoostActief = false;
    zonnebufferReden = 'Zonne-boost UIT via buffer: netwerk ' + netwerkvermogen + 'W > ' + ZONNE_BOOST_UIT_WATT + 'W én Accu-zon ' + accuZonVermogen + 'W < ' + ACCU_ZON_UIT_WATT + 'W';
  } else {
    zonneBoostActief = true;
    zonnebufferReden = 'Zonne-boost blijft AAN via buffer: netwerk ' + netwerkvermogen + 'W of Accu-zon ' + accuZonVermogen + 'W laat nog overschot zien';
  }
} else {
  // Al AAN zodra één van beide signalen overschot laat zien (ook terwijl Accu nog laadt).
  if (netToontOverschot || accuToontOverschot) {
    zonneBoostActief = true;
    zonnebufferReden = 'Zonne-boost AAN via buffer: netwerk ' + netwerkvermogen + 'W < ' + ZONNE_BOOST_AAN_WATT + 'W of Accu-zon ' + accuZonVermogen + 'W > ' + ACCU_ZON_AAN_WATT + 'W';
  } else {
    zonneBoostActief = false;
    zonnebufferReden = 'Zonne-boost blijft UIT via buffer: netwerk ' + netwerkvermogen + 'W en Accu-zon ' + accuZonVermogen + 'W beide onder drempel';
  }
}

// --------------------------
// Vorige status
// --------------------------
const vorigheModus = await haalVariabele(LAATSTE_MODUS_VARIABELE, 'ONBEKEND');
const vorighDoeltemp = await haalVariabele(LAATSTE_DOELTEMP_VARIABELE, huidigDoeltemperatuur);

// --------------------------
// Modus bepalen
// --------------------------
let modus = 'NORMAAL';
let redenen = [];
let doeltemp = NORMAAL_TEMPERATUUR;

redenen.push('Huidige prijs (all-in): ' + huidigePrijsAllIn);
redenen.push('Prijsrang vandaag: #' + huidigePrijsRang + '/' + BLOKKEN_PER_DAG + ' (1 = goedkoopst)');
redenen.push('Goedkoop uur: ' + isGoedkoopUur);
redenen.push('Duur uur: ' + isDuurUur);
redenen.push('Negatieve all-in prijs: ' + isNegatieveAllInPrijs);
redenen.push('Accu: soc=' + (Number.isFinite(accuSoc) ? accuSoc + '%' : 'onbekend') + ', zonvermogen=' + accuZonVermogen + 'W');
redenen.push(zonnebufferReden);

// Prioriteit:
// 1. vakantie -> VAKANTIE (minimum, geen zonne-boost, geen negatieve-prijs-boost)
// 2. negatieve all-in prijs -> BOOST_NEGATIEF (56°C, overschrijft ECO — verbruiken loont letterlijk)
// 3. duurste 8 uren -> ECO (zonne-overschot NIET gebruikt: stroom verkopen loont meer)
// 4. zonne-overschot ÉN goedkoopste 6 uren tegelijk -> BOOST_ZONNE_PRIJS (56°C)
// 5. alleen goedkoopste 6 uren (geen zon) -> BOOST_GOEDKOOP (52°C)
// 6. anders -> NORMAAL
// Let op: zonneBoostActief is al forecast-gated (SOLAR_FORECAST_SKIP_BOOST_KWH), dus
// BOOST_ZONNE_PRIJS vereist zowel voldoende zon-forecast als een goedkoop uur.
if (opVakantie) {
  modus = 'VAKANTIE';
  doeltemp = VAKANTIE_TEMPERATUUR;
  redenen.push('Vakantie: buffervat op minimum temperatuur (zonne-overschot en negatieve prijs genegeerd)');
} else if (isNegatieveAllInPrijs) {
  modus = 'BOOST_NEGATIEF';
  doeltemp = BOOST_TEMPERATUUR_ZONNE;
  redenen.push('Buffervat naar 56°C: all-in prijs is negatief (' + huidigePrijsAllIn + ' €/kWh) — verbruiken is nu voordelig');
} else if (isDuurUur) {
  modus = 'ECO_DUUR';
  doeltemp = ECO_TEMPERATUUR;
  redenen.push('Buffervat naar ECO: duurste ' + DUURSTE_UREN_AANTAL + ' uren — zonne-overschot niet gebruikt, stroom terugleveren loont meer');
} else if (zonneBoostActief && isGoedkoopUur) {
  modus = 'BOOST_ZONNE_PRIJS';
  doeltemp = BOOST_TEMPERATUUR_ZONNE;
  redenen.push('Buffervat naar 56°C: zon-overschot én goedkoop uur (rang #' + huidigePrijsRang + ') tegelijk actief');
} else if (isGoedkoopUur) {
  modus = 'BOOST_GOEDKOOP';
  doeltemp = BOOST_TEMPERATUUR_STANDAARD;
  redenen.push('Buffervat naar 52°C: goedkoop uur (rang #' + huidigePrijsRang + '), maar geen zon-overschot (solar forecast: ' + solarForecast + ' kWh)');
} else {
  modus = 'NORMAAL';
  doeltemp = NORMAAL_TEMPERATUUR;
  redenen.push('Geen zonne-overschot, niet in goedkoopste uren en niet in duurste uren');
}

// --------------------------
// COP-optimalisatie (alleen buiten BOOST-modi)
// --------------------------
const isBooostModus = (modus === 'BOOST_ZONNE_PRIJS' || modus === 'BOOST_GOEDKOOP' || modus === 'BOOST_NEGATIEF');

if (!isBooostModus) {
  if (buitentemp > 15) doeltemp = Math.min(doeltemp, 53);
  else if (buitentemp > 10) doeltemp = Math.min(doeltemp, 51);
  else if (buitentemp > 5) doeltemp = Math.min(doeltemp, 49);
  else if (buitentemp < 0) doeltemp = Math.max(ECO_TEMPERATUUR, doeltemp);

  redenen.push('COP-optimalisatie toegepast');
} else {
  redenen.push('COP-optimalisatie overgeslagen (BOOST-modus)');
}

// --------------------------
// Hysterese
// --------------------------
let hysteriseHoudtAan = false;

if (Math.abs(huidigDoeltemperatuur - doeltemp) < 1) {
  hysteriseHoudtAan = true;
  doeltemp = huidigDoeltemperatuur;
  redenen.push('Hysterese actief');
}

// --------------------------
// Toepassen
// --------------------------
let gewijzigd = false;
let actie = 'geen';

const huidigePowerfulModus = warmtepomp.capabilitiesObj['fan_mode.powerful']
  ? String(warmtepomp.capabilitiesObj['fan_mode.powerful'].value || 'off')
  : 'off';
const tankOpTemperatuur = warmtepompTemperatuurInfo.gemetenTemperatuur != null
  && warmtepompTemperatuurInfo.gemetenTemperatuur >= (doeltemp - 1);
const gewenstePowerfulModus = ((modus === 'BOOST_ZONNE_PRIJS' || modus === 'BOOST_NEGATIEF') && !tankOpTemperatuur) ? 'on' : 'off';

if (doeltemp !== huidigDoeltemperatuur) {
  await warmtepomp.setCapabilityValue('target_temperature', doeltemp);
  gewijzigd = true;
  actie = 'Setpoint ' + huidigDoeltemperatuur + '->' + doeltemp;
  redenen.push(actie);
} else {
  redenen.push('Geen wijziging nodig');
}

if (gewenstePowerfulModus !== huidigePowerfulModus) {
  await warmtepomp.setCapabilityValue('fan_mode.powerful', gewenstePowerfulModus);
  gewijzigd = true;
  redenen.push('Powerful mode: ' + huidigePowerfulModus + '->' + gewenstePowerfulModus);
}

// Zonne-buffer status opslaan
await stellogicaVariabeleIn(ZONNE_BOOST_ACTIEF_VARIABELE, 'boolean', zonneBoostActief);

// --------------------------
// Logging
// --------------------------
const redenenTekst = redenen.join(' | ');
const timestamp = haalNuIsoLokaal();

const modusGewijzigd = modus !== vorigheModus;
const doeltempGewijzigdTegenVorigeRun = Number(vorighDoeltemp) !== Number(doeltemp);

const samenvatting =
  '[' + timestamp + ']' +
  ' modus=' + modus +
  ', uur=' + uur +
  ', opVakantie=' + opVakantie +
  ', netwerk=' + netwerkvermogen +
  ', huidigePrijsAllIn=' + huidigePrijsAllIn +
  ', rangVandaag=' + huidigePrijsRang + '/' + BLOKKEN_PER_DAG +
  ', isGoedkoopUur=' + isGoedkoopUur +
  ', isDuurUur=' + isDuurUur +
  ', isNegatieveAllInPrijs=' + isNegatieveAllInPrijs +
  ', zonneBoostActief=' + zonneBoostActief +
  ', solarForecast=' + solarForecast +
  ', solarForecastDag=' + solarForecastDag +
  ', accuZonVermogen=' + accuZonVermogen +
  ', accuSoc=' + (Number.isFinite(accuSoc) ? accuSoc : 'onbekend') +
  ', buitentemp=' + buitentemp +
  ', gemetenBuffervatTemp=' + (warmtepompTemperatuurInfo.gemetenTemperatuur == null ? 'onbekend' : afronding(warmtepompTemperatuurInfo.gemetenTemperatuur)) +
  ', gemetenBuffervatCap=' + warmtepompTemperatuurInfo.gemetenTemperatuurCapability +
  ', huidigDoeltemp=' + huidigDoeltemperatuur +
  ', doeltemp=' + doeltemp +
  ', powerfulModus=' + gewenstePowerfulModus +
  ', gewijzigd=' + gewijzigd +
  ', reden=' + redenenTekst;

await voegLogRegelToe(samenvatting);
await stellogicaVariabeleIn(LAATSTE_REDEN_VARIABELE, 'string', redenenTekst);
await stellogicaVariabeleIn(LAATSTE_MODUS_VARIABELE, 'string', modus);
await stellogicaVariabeleIn(LAATSTE_DOELTEMP_VARIABELE, 'number', doeltemp);
await stellogicaVariabeleIn(LAATSTE_RESULTAAT_VARIABELE, 'string', timestamp);
await stellogicaVariabeleIn(IS_DUUR_UUR_VARIABELE, 'boolean', isDuurUur);
await stellogicaVariabeleIn('buffervat_temp_debug', 'string', warmtepompTemperatuurInfo.temperatuurDebugLijst);

// --------------------------
// Tijdlijn
// --------------------------
let tijdlijnVerstuurd = false;

if (STUUR_TIJDLIJN_ALTIJD || (STUUR_TIJDLIJN_BIJ_WIJZIGING && (gewijzigd || modusGewijzigd || doeltempGewijzigdTegenVorigeRun))) {
  const tekst =
    'Warmtepomp ' + modus +
    ': ' + huidigDoeltemperatuur + '->' + doeltemp +
    ' (uur: ' + uur + ', prijs: ' + huidigePrijsAllIn + ' rang: ' + huidigePrijsRang + ', netwerk: ' + netwerkvermogen + 'W)';
  tijdlijnVerstuurd = await voegTijdlijnToe(tekst);
}

// --------------------------
// Resultaat
// --------------------------
return {
  modus: modus,
  opVakantie: opVakantie,
  uur: uur,
  netwerk: netwerkvermogen,
  huidigePrijsAllIn: huidigePrijsAllIn,
  rangVandaag: huidigePrijsRang,
  blokkenPerDag: BLOKKEN_PER_DAG,
  isGoedkoopUur: isGoedkoopUur,
  isDuurUur: isDuurUur,
  isNegatieveAllInPrijs: isNegatieveAllInPrijs,
  zonneBoostAan: zonneBoostAan,
  zonneBoostActief: zonneBoostActief,
  solarForecast: solarForecast,
  solarForecastDag: solarForecastDag,
  accuZonVermogen: accuZonVermogen,
  accuSoc: Number.isFinite(accuSoc) ? accuSoc : null,
  buitentemp: buitentemp,
  huidigDoeltemp: huidigDoeltemperatuur,
  doeltemp: doeltemp,
  gewijzigd: gewijzigd,
  actie: actie,
  powerfulModus: gewenstePowerfulModus,
  hysteriseHoudtAan: hysteriseHoudtAan,
  tijdlijnVerstuurd: tijdlijnVerstuurd
};