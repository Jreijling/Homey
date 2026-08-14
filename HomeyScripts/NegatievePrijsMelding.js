// ==========================
// Negatieve Prijs Melding - Homey Script
// 1. Als de all-in prijs van MORGEN op enig moment negatief is -> eenmalige melding per dag
// 2. Als de all-in prijs over 15 minuten negatief wordt (en nu nog niet) -> reminder
//
// Huidige en volgende all-in prijs komen uit de logica-variabelen
// 'electra_prijs' / 'electra_prijs_volgende' (berekend door Electra_Prijs.js) -
// dit script berekent zelf alleen nog de "morgen laagste"-waarde, die daar
// niet in zit.
//
// Bedoeld om elke 15 minuten via een Flow te draaien (tijd-trigger op :00/:15/:30/:45),
// aansluitend op de kwartierprijzen van het DAP-apparaat.
// ==========================

// ---------- Apparaat ID ----------
const DYNAMISCHE_ENERGIE_PRIJS_ID = 'adc99ffc-add2-40d0-b664-8ce3b19c28af'; // Power by the Hour: NL_Netherlands

// ---------- All-in prijs (kale prijs + energiebelasting, incl. BTW) ----------
const ENERGIEBELASTING_PER_KWH = 0.0916; // excl. BTW, overheidstarief 2026
const BTW_FACTOR = 1.21;

// ---------- Logic-variabelen (voorkomen dubbele meldingen) ----------
const VAR_LAATSTE_MELDDATUM_MORGEN = 'negatieve_prijs_morgen_laatste_melddatum';
const VAR_LAATSTE_REMINDER_KWARTIER = 'negatieve_prijs_reminder_laatste_kwartier';

// --------------------------
// Hulpfuncties
// --------------------------
function afronding(waarde, decimalen) {
  if (decimalen === undefined) decimalen = 4;
  return Number(Number(waarde).toFixed(decimalen));
}

function alleInPrijs(kalePrijs) {
  return afronding((kalePrijs + ENERGIEBELASTING_PER_KWH) * BTW_FACTOR, 4);
}

function haalLokaalDatum() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
}

function opvullen(n) {
  return String(n).padStart(2, '0');
}

function maakDagSleutel(datum) {
  return datum.getFullYear() + '-' + opvullen(datum.getMonth() + 1) + '-' + opvullen(datum.getDate());
}

function formatDecimaalUur(uurDecimaal) {
  const uren = Math.floor(uurDecimaal);
  const minuten = Math.round((uurDecimaal - uren) * 60);
  return opvullen(uren) + ':' + opvullen(minuten);
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
  const gevonden = await zoekLogicaVariabelPerNaam(naam);
  if (!gevonden) return fallback;
  return gevonden.value != null ? gevonden.value : fallback;
}

async function zorgVoorLogicaVariabele(naam, type, beginwaarde) {
  const bestaande = await zoekLogicaVariabelPerNaam(naam);
  if (bestaande) return bestaande;
  return await Homey.logic.createVariable({ variable: { name: naam, type: type, value: beginwaarde } });
}

async function stelLogicaVariabeleIn(naam, type, waarde) {
  const variabele = await zorgVoorLogicaVariabele(naam, type, waarde);
  await Homey.logic.updateVariable({ id: variabele.id, variable: { value: waarde } });
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
// Prijzen ophalen
// --------------------------
const alleInNu = await haalVariabele('electra_prijs', 0);
const alleInOver15Min = await haalVariabele('electra_prijs_volgende', alleInNu);

// "Morgen laagste" zit niet in de gedeelde variabelen - apart uit het DAP-apparaat.
const dap = await Homey.devices.getDevice({ id: DYNAMISCHE_ENERGIE_PRIJS_ID });
const caps = dap.capabilitiesObj || {};

function kaleWaarde(capNaam) {
  const cap = caps[capNaam];
  if (!cap || cap.value == null) return null;
  const waarde = Number(cap.value);
  return Number.isFinite(waarde) ? waarde : null;
}

const prijsMorgenLaagste = kaleWaarde('meter_price_next_day_lowest');
const uurMorgenLaagste = kaleWaarde('hour_next_day_lowest');
const alleInMorgenLaagste = prijsMorgenLaagste != null ? alleInPrijs(prijsMorgenLaagste) : null;

const nu = haalLokaalDatum();
const vandaag = maakDagSleutel(nu);

let morgenMeldingVerstuurd = false;
let reminderVerstuurd = false;

// --------------------------
// 1. Melding: morgen negatieve all-in prijs
// (meter_price_next_day_lowest is pas beschikbaar na publicatie day-ahead veiling, ~13:00)
// --------------------------
if (alleInMorgenLaagste != null && alleInMorgenLaagste < 0) {
  const laatsteMelddatum = await haalVariabele(VAR_LAATSTE_MELDDATUM_MORGEN, '');

  if (laatsteMelddatum !== vandaag) {
    const tekst = '📉 Morgen wordt de all-in stroomprijs negatief: ' + alleInMorgenLaagste +
      ' €/kWh rond ' + formatDecimaalUur(uurMorgenLaagste) + ' uur — verbruik plannen loont!';

    morgenMeldingVerstuurd = await voegTijdlijnToe(tekst);
    await stelLogicaVariabeleIn(VAR_LAATSTE_MELDDATUM_MORGEN, 'string', vandaag);
  }
}

// --------------------------
// 2. Reminder: 15 minuten voordat de prijs negatief wordt
// --------------------------
if (alleInOver15Min != null && alleInOver15Min < 0 && alleInNu >= 0) {
  const doelTijdstip = new Date(nu.getTime() + 15 * 60000);
  const kwartierSleutel = maakDagSleutel(doelTijdstip) + '_' + opvullen(doelTijdstip.getHours()) + ':' + opvullen(doelTijdstip.getMinutes());
  const laatsteReminderKwartier = await haalVariabele(VAR_LAATSTE_REMINDER_KWARTIER, '');

  if (laatsteReminderKwartier !== kwartierSleutel) {
    const tekst = '⏰ Over 15 minuten wordt de all-in stroomprijs negatief: ' + alleInOver15Min +
      ' €/kWh — nu vast starten met verbruik loont.';

    reminderVerstuurd = await voegTijdlijnToe(tekst);
    await stelLogicaVariabeleIn(VAR_LAATSTE_REMINDER_KWARTIER, 'string', kwartierSleutel);
  }
}

// --------------------------
// Resultaat
// --------------------------
return {
  alleInNu: alleInNu,
  alleInOver15Min: alleInOver15Min,
  prijsMorgenLaagste: prijsMorgenLaagste,
  alleInMorgenLaagste: alleInMorgenLaagste,
  uurMorgenLaagste: uurMorgenLaagste,
  morgenMeldingVerstuurd: morgenMeldingVerstuurd,
  reminderVerstuurd: reminderVerstuurd
};
