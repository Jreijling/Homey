// ==========================
// Warmwaterbuffer (Buffervat) - Homey Script
// Verwarmen / verlagen op basis van:
// 1. Vakantie -> minimum temperatuur (geen zonne-boost, geen negatieve-prijs-boost)
// 2. Negatieve all-in prijs -> BOOST 56°C (verbruiken loont, overschrijft ECO)
// 3. 8 duurste uren -> ECO (zon genegeerd, terugleveren loont meer)
// 4. Zonne-overschot ÉN 10 goedkoopste uren tegelijk -> BOOST 56°C
// 5. Alleen 10 goedkoopste uren (geen zon) -> BOOST 52°C
// 6. Anders (incl. zon zonder goedkoop uur) -> NORMAAL (zon gaat terug het net op)
// Met logging + redenen + optionele Timeline
// ==========================

// ---------- Apparaat IDs ----------
const P1_APPARAAT_ID = '3755a652-027b-41bb-b188-ab2ac592ee04';
const WARMTEPOMP_ID = 'd9a883d7-6322-4b73-820d-cd259bde862c';
const DYNAMISCHE_ENERGIE_PRIJS_ID = 'adc99ffc-add2-40d0-b664-8ce3b19c28af'; // Power by the Hour: NL_Netherlands (Frank Energie opslag)

// ---------- Instellingen warmtepomp doeltemperaturen ----------
const VAKANTIE_TEMPERATUUR = 45;
const ECO_TEMPERATUUR = 47;
const NORMAAL_TEMPERATUUR = 49;
const BOOST_TEMPERATUUR_ZONNE = 56;
const BOOST_TEMPERATUUR_STANDAARD = 52;

// ---------- Drempels zonne-overschot met hysterese ----------
const ZONNE_BOOST_AAN_WATT = -2500;   // boost INSCHAKELEN
const ZONNE_BOOST_UIT_WATT = -500;    // boost UITSCHAKELEN

// ---------- Prijs instellingen ----------
// meter_rank_price_h0_this_day rangschikt op kwartierblokken (96/dag ipv 24 uren),
// dus "aantal uren" wordt hieronder omgerekend naar blokken (x4).
const GOEDKOOPSTE_UREN_AANTAL = 6;
const DUURSTE_UREN_AANTAL = 8;
const BLOKKEN_PER_DAG = 96;
const SOLAR_FORECAST_SKIP_BOOST_KWH = 3;

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
const solarForecast = await haalVariabele('solar_forecast', 0);

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
const zonneBoostAan = solarForecast >= SOLAR_FORECAST_SKIP_BOOST_KWH;
const vorighZonneBoostActief = await haalVariabele(ZONNE_BOOST_ACTIEF_VARIABELE, false);
let zonneBoostActief = vorighZonneBoostActief;
let zonnebufferReden = '';

if (!zonneBoostAan) {
  zonneBoostActief = false;
  zonnebufferReden = 'Zonne-boost uitgeschakeld (solarForecast ' + solarForecast + ' kWh < ' + SOLAR_FORECAST_SKIP_BOOST_KWH + ' kWh)';
} else if (vorighZonneBoostActief) {
  if (netwerkvermogen > ZONNE_BOOST_UIT_WATT) {
    zonneBoostActief = false;
    zonnebufferReden = 'Zonne-boost UIT via buffer: netwerk ' + netwerkvermogen + 'W > ' + ZONNE_BOOST_UIT_WATT + 'W';
  } else {
    zonneBoostActief = true;
    zonnebufferReden = 'Zonne-boost blijft AAN via buffer: netwerk ' + netwerkvermogen + 'W <= ' + ZONNE_BOOST_UIT_WATT + 'W';
  }
} else {
  if (netwerkvermogen < ZONNE_BOOST_AAN_WATT) {
    zonneBoostActief = true;
    zonnebufferReden = 'Zonne-boost AAN via buffer: netwerk ' + netwerkvermogen + 'W < ' + ZONNE_BOOST_AAN_WATT + 'W';
  } else {
    zonneBoostActief = false;
    zonnebufferReden = 'Zonne-boost blijft UIT via buffer: netwerk ' + netwerkvermogen + 'W >= ' + ZONNE_BOOST_AAN_WATT + 'W';
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
redenen.push(zonnebufferReden);

// Prioriteit:
// 1. vakantie -> VAKANTIE (minimum, geen zonne-boost, geen negatieve-prijs-boost)
// 2. negatieve all-in prijs -> BOOST_NEGATIEF (56°C, overschrijft ECO — verbruiken loont letterlijk)
// 3. duurste 8 uren -> ECO (zonne-overschot NIET gebruikt: stroom verkopen loont meer)
// 4. zonne-overschot ÉN goedkoopste 10 uren tegelijk -> BOOST_ZONNE_PRIJS (56°C)
// 5. alleen goedkoopste 10 uren (geen zon) -> BOOST_GOEDKOOP (52°C)
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
  buitentemp: buitentemp,
  huidigDoeltemp: huidigDoeltemperatuur,
  doeltemp: doeltemp,
  gewijzigd: gewijzigd,
  actie: actie,
  powerfulModus: gewenstePowerfulModus,
  hysteriseHoudtAan: hysteriseHoudtAan,
  tijdlijnVerstuurd: tijdlijnVerstuurd
};