// ==========================
// Douche Vraag - Homey Script
// Vraagt huishoudenleden of ze gaan douchen en past de buffervat temperatuur aan.
//
// Temperaturen op basis van het aantal bevestigden:
//   1 persoon  → 50°C
//   2 personen → 52°C
//   3 personen → 56°C
//   4 personen → 58°C
//
// Hoe het werkt:
//   1. Script reset de 4 persoonsvariabelen naar false
//   2. Stuurt een melding naar de Homey tijdlijn
//   3. Wacht tot alle personen hebben gereageerd (max. WACHT_TOTAAL_MIN minuten)
//   4. Zet de warmtepomp doeltemperatuur op basis van het aantal bevestigden
//
// Instellen per persoon:
//   Maak in de Homey app een Flow of widget waarmee elke persoon
//   zijn/haar variabele (douchevraag_persoon_1 t/m _4) op 'true' kan zetten.
//   Bijv. via een virtueel apparaat of via de Logic-variabele direct in de app.
//
// Triggers:
//   Gebruik meerdere Flows om dit script op gewenste tijden te starten,
//   bijv. om 07:00, 12:00 en 17:00. Bij elk nieuw start worden de variabelen gereset.
// ==========================

// ---------- Apparaat ID ----------
const WARMTEPOMP_ID = 'd9a883d7-6322-4b73-820d-cd259bde862c';

// ---------- Personen configuratie ----------
// Pas de namen aan naar de echte namen van jouw huishouden
const PERSONEN = [
  { naam: 'Persoon 1', variabele: 'douchevraag_persoon_1' },
  { naam: 'Persoon 2', variabele: 'douchevraag_persoon_2' },
  { naam: 'Persoon 3', variabele: 'douchevraag_persoon_3' },
  { naam: 'Persoon 4', variabele: 'douchevraag_persoon_4' },
];

// ---------- Temperatuur per aantal douchenden ----------
const DOUCHE_TEMP = {
  1: 50,
  2: 52,
  3: 56,
  4: 58,
};

// ---------- Wachttijdinstellingen ----------
const WACHT_TOTAAL_MIN = 30;        // maximaal wachten op antwoorden (minuten)
const WACHT_INTERVAL_SEC = 60;      // controle-interval (seconden)
const STOP_ALS_IEDEREEN_REAGEERDE = true; // eerder stoppen als iedereen heeft gereageerd

// ---------- Logging ----------
const LOG_MAX_REGELS = 40;
const STUUR_TIJDLIJN_BIJ_STARTEN = true;
const STUUR_TIJDLIJN_BIJ_RESULTAAT = true;

const LOG_VARIABELE        = 'douchevraag_log';
const RESULTAAT_VARIABELE  = 'douchevraag_resultaat';
const DOELTEMP_VARIABELE   = 'douchevraag_doeltemp';

// --------------------------
// Hulpfuncties
// --------------------------
function haalLokaalDatum() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })
  );
}

function opvullen(n) {
  return String(n).padStart(2, '0');
}

function haalNuIsoLokaal() {
  const d = haalLokaalDatum();
  return d.getFullYear() + '-' + opvullen(d.getMonth() + 1) + '-' + opvullen(d.getDate()) + ' ' +
    opvullen(d.getHours()) + ':' + opvullen(d.getMinutes()) + ':' + opvullen(d.getSeconds());
}

async function haalAlleLogicaVariabelen() {
  return await Homey.logic.getVariables();
}

async function zoekLogicaVariabelPerNaam(naam) {
  const variabelen = await haalAlleLogicaVariabelen();
  const alle = Object.values(variabelen);
  for (let i = 0; i < alle.length; i++) {
    if (alle[i].name === naam) return alle[i];
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

async function stelLogicaVariabeleIn(naam, type, waarde) {
  const variabele = await zorgVoorLogicaVariabele(naam, type, waarde);
  await Homey.logic.updateVariable({
    id: variabele.id,
    variable: { value: waarde }
  });
  return variabele;
}

async function voegLogRegelToe(regel) {
  const huidig = await haalVariabele(LOG_VARIABELE, '');
  const regels = String(huidig || '').split('\n').filter(function(x) { return Boolean(x); });
  regels.push(regel);
  while (regels.length > LOG_MAX_REGELS) regels.shift();
  await stelLogicaVariabeleIn(LOG_VARIABELE, 'string', regels.join('\n'));
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
// Tel hoeveel personen bevestigd
// --------------------------
async function telBevestigden() {
  let aantal = 0;
  for (let i = 0; i < PERSONEN.length; i++) {
    const bevestigd = await haalVariabele(PERSONEN[i].variabele, false);
    if (bevestigd === true) aantal++;
  }
  return aantal;
}

// --------------------------
// Initialiseer variabelen (aanmaken als ze niet bestaan + resetten)
// --------------------------
async function initialiseerVariabelen() {
  for (let i = 0; i < PERSONEN.length; i++) {
    await stelLogicaVariabeleIn(PERSONEN[i].variabele, 'boolean', false);
  }
  await zorgVoorLogicaVariabele(LOG_VARIABELE, 'string', '');
  await zorgVoorLogicaVariabele(RESULTAAT_VARIABELE, 'string', '');
  await zorgVoorLogicaVariabele(DOELTEMP_VARIABELE, 'number', 0);
}

// --------------------------
// Begin script
// --------------------------
const startIso = haalNuIsoLokaal();

// Stap 1: Reset alle persoonsvariabelen
await initialiseerVariabelen();
await voegLogRegelToe(startIso + ' | START | Douchevraag gestart voor ' + PERSONEN.length + ' personen');

// Stap 2: Stuur vraag-melding naar de tijdlijn
if (STUUR_TIJDLIJN_BIJ_STARTEN) {
  const namen = PERSONEN.map(function(p) { return p.naam; }).join(', ');
  await voegTijdlijnToe(
    '🚿 Ga je vandaag douchen?\n' +
    'Zet jouw douchevariabele op Aan in de Homey app.\n' +
    '(' + namen + ')'
  );
}

// Stap 3: Wachtlus - controleer elke WACHT_INTERVAL_SEC seconden
const maxIteraties = Math.ceil((WACHT_TOTAAL_MIN * 60) / WACHT_INTERVAL_SEC);
let iteratie = 0;
let aantalBevestigd = 0;

while (iteratie < maxIteraties) {
  if (iteratie > 0) {
    await wait(WACHT_INTERVAL_SEC * 1000);
  }

  aantalBevestigd = await telBevestigden();
  iteratie++;

  if (STOP_ALS_IEDEREEN_REAGEERDE && aantalBevestigd >= PERSONEN.length) {
    await voegLogRegelToe(
      haalNuIsoLokaal() + ' | Alle ' + PERSONEN.length + ' personen hebben gereageerd na ' +
      iteratie + ' check(s), stop vroeg'
    );
    break;
  }
}

// Stap 4: Temperatuur instellen op basis van het aantal bevestigden
const doeltemp = DOUCHE_TEMP[aantalBevestigd] || null;
let actie = 'geen';
let huidigDoeltemp = null;

if (doeltemp != null) {
  const warmtepomp = await Homey.devices.getDevice({ id: WARMTEPOMP_ID });
  huidigDoeltemp = Number(warmtepomp.capabilitiesObj.target_temperature.value);
  await warmtepomp.setCapabilityValue('target_temperature', doeltemp);
  await stelLogicaVariabeleIn(DOELTEMP_VARIABELE, 'number', doeltemp);
  actie = 'Buffervat ' + huidigDoeltemp + ' → ' + doeltemp + '°C (' + aantalBevestigd + ' persoon/personen)';
} else {
  await stelLogicaVariabeleIn(DOELTEMP_VARIABELE, 'number', 0);
  actie = 'Niemand gaat douchen, geen temperatuurwijziging';
}

// Stap 5: Log en tijdlijn
const resultaatTekst =
  haalNuIsoLokaal() + ' | ' +
  aantalBevestigd + '/' + PERSONEN.length + ' gaat douchen | ' +
  actie + ' | iteraties=' + iteratie;

await voegLogRegelToe(resultaatTekst);
await stelLogicaVariabeleIn(RESULTAAT_VARIABELE, 'string', resultaatTekst);

if (STUUR_TIJDLIJN_BIJ_RESULTAAT && doeltemp != null) {
  await voegTijdlijnToe(
    '🚿 Buffervat aangepast: ' + aantalBevestigd + ' persoon/personen gaat douchen → ' + doeltemp + '°C'
  );
}

// Stap 6: Geef resultaat terug
return {
  aantalBevestigd: aantalBevestigd,
  totaalPersonen: PERSONEN.length,
  doeltemp: doeltemp,
  huidigDoeltemp: huidigDoeltemp,
  actie: actie,
  iteraties: iteratie,
  resultaat: resultaatTekst
};
