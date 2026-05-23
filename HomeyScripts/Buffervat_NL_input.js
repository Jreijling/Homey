// ==========================
// Warmwaterbuffer (Buffervat) - Homey Script
// Verwarmen / verlagen op basis van:
// 1. Zonne-overschot
// 2. 10 goedkoopste uren
// 3. 8 duurste uren
// Met logging + redenen + optionele Timeline
// ==========================

// ---------- Apparaat IDs ----------
const P1_APPARAAT_ID = '3755a652-027b-41bb-b188-ab2ac592ee04';
const WARMTEPOMP_ID = 'd9a883d7-6322-4b73-820d-cd259bde862c';
const DYNAMISCHE_ENERGIE_PRIJS_ID = '48b55814-c41c-4b0b-a65a-b7c5a21182e0'; // NL_Nederland

// ---------- Instellingen warmtepomp doeltemperaturen ----------
const ECO_TEMPERATUUR = 47;
const NORMAAL_TEMPERATUUR = 48;
const BOOST_TEMPERATUUR = 54;

// ---------- Drempels zonne-overschot met hysterese ----------
const ZONNE_BOOST_AAN_WATT = -2500;   // boost INSCHAKELEN
const ZONNE_BOOST_UIT_WATT = -800;    // boost UITSCHAKELEN

// ---------- Prijs instellingen ----------
const GOEDKOOPSTE_UREN_AANTAL = 10;
const DUURSTE_UREN_AANTAL = 8;
const DAG_UREN_AANTAL = 24;

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

// --------------------------
// Hulpfuncties
// --------------------------
function afronding(waarde, decimalen) {
  if (decimalen === undefined) decimalen = 2;
  return Number(Number(waarde).toFixed(decimalen));
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

// --------------------------
// Prijzen via DAP-apparaat
// --------------------------
const dapCapaciteiten = dap.capabilitiesObj || {};

if (!dapCapaciteiten.meter_price_h0 || dapCapaciteiten.meter_price_h0.value == null) {
  throw new Error('DAP capaciteit meter_price_h0 niet gevonden of leeg');
}

if (!dapCapaciteiten.meter_rank_price_h0_this_day || dapCapaciteiten.meter_rank_price_h0_this_day.value == null) {
  throw new Error('DAP capaciteit meter_rank_price_h0_this_day niet gevonden of leeg');
}

const huidigePrijs = Number(dapCapaciteiten.meter_price_h0.value);
const huidigePrijsRang = Number(dapCapaciteiten.meter_rank_price_h0_this_day.value);

if (!Number.isFinite(huidigePrijs)) {
  throw new Error('Ongeldige huidige prijs uit DAP-apparaat');
}

if (!Number.isFinite(huidigePrijsRang)) {
  throw new Error('Ongeldige prijsrang uit DAP-apparaat');
}

// In deze setup: #1 = goedkoopst, #24 = duurst
const isGoedkoopUur = huidigePrijsRang <= GOEDKOOPSTE_UREN_AANTAL;
const isDuurUur = huidigePrijsRang > (DAG_UREN_AANTAL - DUURSTE_UREN_AANTAL);

// Alleen voor logging/debug
let zichtbarePrijsblokken = 0;
for (let i = 0; i < 24; i++) {
  const capaciteitNaam = 'meter_price_h' + i;
  const capaciteit = dapCapaciteiten[capaciteitNaam];
  if (capaciteit && capaciteit.value != null && Number.isFinite(Number(capaciteit.value))) {
    zichtbarePrijsblokken++;
  }
}

// --------------------------
// Zonne-overschot buffer / hysterese
// --------------------------
const vorighZonneBoostActief = await haalVariabele(ZONNE_BOOST_ACTIEF_VARIABELE, false);
let zonneBoostActief = vorighZonneBoostActief;
let zonnebufferReden = '';

if (vorighZonneBoostActief) {
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

redenen.push('Huidige prijs: ' + afronding(huidigePrijs) + ' EUR/kWh');
redenen.push('Prijsrang vandaag: #' + huidigePrijsRang + ' (1 = goedkoopst)');
redenen.push('Goedkoop uur: ' + isGoedkoopUur);
redenen.push('Duur uur: ' + isDuurUur);
redenen.push('Zichtbare prijsblokken: ' + zichtbarePrijsblokken);
redenen.push(zonnebufferReden);

// Prioriteit:
// 1. zonne-overschot -> BOOST
// 2. duurste 8 uren -> ECO
// 3. goedkoopste 10 uren -> BOOST
// 4. anders -> NORMAAL
if (zonneBoostActief) {
  modus = 'BOOST_ZONNE';
  doeltemp = BOOST_TEMPERATUUR;
  redenen.push('Buffervat verwarmen op zonne-overschot');
  if (isDuurUur) {
    redenen.push('Zonne-overschot override op duur uur');
  }
} else if (isDuurUur) {
  modus = 'ECO_DUUR';
  doeltemp = ECO_TEMPERATUUR;
  redenen.push('Buffervat naar ECO omdat huidig uur in de ' + DUURSTE_UREN_AANTAL + ' duurste uren valt');
} else if (isGoedkoopUur) {
  modus = 'BOOST_GOEDKOOP';
  doeltemp = BOOST_TEMPERATUUR;
  redenen.push('Buffervat verwarmen omdat huidig uur in de ' + GOEDKOOPSTE_UREN_AANTAL + ' goedkoopste uren valt');
} else {
  modus = 'NORMAAL';
  doeltemp = NORMAAL_TEMPERATUUR;
  redenen.push('Geen zonne-overschot, niet in goedkoopste uren en niet in duurste uren');
}

// --------------------------
// COP-optimalisatie (alleen buiten BOOST-modi)
// --------------------------
const isBooostModus = (modus === 'BOOST_ZONNE' || modus === 'BOOST_GOEDKOOP');

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

if (doeltemp !== huidigDoeltemperatuur) {
  await warmtepomp.setCapabilityValue('target_temperature', doeltemp);
  gewijzigd = true;
  actie = 'Setpoint ' + huidigDoeltemperatuur + '->' + doeltemp;
  redenen.push(actie);
} else {
  redenen.push('Geen wijziging nodig');
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
  ', netwerk=' + netwerkvermogen +
  ', huidigePrijs=' + afronding(huidigePrijs) +
  ', rangVandaag=' + huidigePrijsRang +
  ', isGoedkoopUur=' + isGoedkoopUur +
  ', isDuurUur=' + isDuurUur +
  ', zichtbarePrijsblokken=' + zichtbarePrijsblokken +
  ', zonneBoostActief=' + zonneBoostActief +
  ', buitentemp=' + buitentemp +
  ', huidigDoeltemp=' + huidigDoeltemperatuur +
  ', doeltemp=' + doeltemp +
  ', gewijzigd=' + gewijzigd +
  ', reden=' + redenenTekst;

await voegLogRegelToe(samenvatting);
await stellogicaVariabeleIn(LAATSTE_REDEN_VARIABELE, 'string', redenenTekst);
await stellogicaVariabeleIn(LAATSTE_MODUS_VARIABELE, 'string', modus);
await stellogicaVariabeleIn(LAATSTE_DOELTEMP_VARIABELE, 'number', doeltemp);
await stellogicaVariabeleIn(LAATSTE_RESULTAAT_VARIABELE, 'string', timestamp);

// --------------------------
// Tijdlijn
// --------------------------
let tijdlijnVerstuurd = false;

if (STUUR_TIJDLIJN_ALTIJD || (STUUR_TIJDLIJN_BIJ_WIJZIGING && (gewijzigd || modusGewijzigd || doeltempGewijzigdTegenVorigeRun))) {
  const tekst =
    'Warmtepomp ' + modus +
    ': ' + huidigDoeltemperatuur + '->' + doeltemp +
    ' (uur ' + uur + ', prijs ' + afronding(huidigePrijs) + ' EUR/kWh, rang #' + huidigePrijsRang + ', netwerk ' + netwerkvermogen + 'W)';
  tijdlijnVerstuurd = await voegTijdlijnToe(tekst);
}

// --------------------------
// Resultaat
// --------------------------
return {
  modus: modus,
  uur: uur,
  netwerk: netwerkvermogen,
  huidigePrijs: huidigePrijs,
  rangVandaag: huidigePrijsRang,
  isGoedkoopUur: isGoedkoopUur,
  isDuurUur: isDuurUur,
  zichtbarePrijsblokken: zichtbarePrijsblokken,
  zonneBoostActief: zonneBoostActief,
  buitentemp: buitentemp,
  huidigDoeltemp: huidigDoeltemperatuur,
  doeltemp: doeltemp,
  gewijzigd: gewijzigd,
  actie: actie,
  hysteriseHoudtAan: hysteriseHoudtAan,
  tijdlijnVerstuurd: tijdlijnVerstuurd
};
