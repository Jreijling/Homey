// ==========================
// Electra Prijs - Homey Script
// Zet de all-in prijs van Power by the Hour in de logica-variabelen
// 'electra_prijs' (huidig) en 'electra_prijs_volgende' (over 15 min).
//
// LET OP: meter_price_* van Power by the Hour is al all-in (Frank Energie
// opslag + energiebelasting + BTW zijn in de app-instellingen meegenomen).
// Hier dus GEEN belasting/BTW meer optellen, anders telt die dubbel.
//
// Accu_Laadplan.js, Thermostaat.js, Buffervat.js en NegatievePrijsMelding.js
// lezen deze variabelen uit.
//
// Flow-setup: trigger op prijswijziging (Power by the Hour "prijs verandert"
// e.d.), niet op een cron - loopt zo exact synchroon met echte
// prijswisselingen i.p.v. tot 15 minuten achter te lopen.
// ==========================

const DYNAMISCHE_ENERGIE_PRIJS_ID = 'adc99ffc-add2-40d0-b664-8ce3b19c28af'; // Power by the Hour: NL_Netherlands

// --------------------------
// Hulpfuncties
// --------------------------
function afronding(waarde, decimalen = 4) {
  return Number(Number(waarde).toFixed(decimalen));
}

// Power by the Hour levert al all-in prijzen: alleen afronden.
function naarPrijs(prijs) {
  return afronding(prijs, 4);
}

async function haalAlleLogicaVariabelen() {
  return await Homey.logic.getVariables();
}

async function zoekLogicaVariabelPerNaam(naam) {
  const variabelen = await haalAlleLogicaVariabelen();
  return Object.values(variabelen).find(v => v.name === naam) || null;
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

// --------------------------
// Apparaat + prijzen ophalen
// --------------------------
const dap = await Homey.devices.getDevice({ id: DYNAMISCHE_ENERGIE_PRIJS_ID });
const caps = dap.capabilitiesObj || {};

function kaleWaarde(capNaam) {
  const cap = caps[capNaam];
  if (!cap || cap.value == null) return null;
  const waarde = Number(cap.value);
  return Number.isFinite(waarde) ? waarde : null;
}

const kalePrijsNu = kaleWaarde('meter_price_h0');
const kalePrijsVolgende = kaleWaarde('meter_price_m15');

if (kalePrijsNu == null) {
  throw new Error('DAP capaciteit meter_price_h0 niet gevonden of leeg');
}

const prijsNu = naarPrijs(kalePrijsNu);
const prijsVolgende = kalePrijsVolgende != null ? naarPrijs(kalePrijsVolgende) : prijsNu;

await stelLogicaVariabeleIn('electra_prijs', 'number', prijsNu);
await stelLogicaVariabeleIn('electra_prijs_volgende', 'number', prijsVolgende);

// --------------------------
// Resultaat
// --------------------------
return {
  kalePrijsNu,
  kalePrijsVolgende,
  prijsNu,
  prijsVolgende
};
