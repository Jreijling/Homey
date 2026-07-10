// ==========================
// Forecast.Solar -> Homey Logic + Timeline
// ==========================

// --- JOUW INSTELLINGEN ---
const LAT = 52.4775;
const LON = 4.7974;
const TILT = 15;
const KWP = 8.8;
const AZIMUTH = -30;
const FORECAST_CORRECTIE = 1.66; // Schaalfactor voor prognose — pas aan op basis van calibratieadvies

const VARIABLE_NAME = "solar_forecast"; // rollend venster komende 3 uur
const DAG_VARIABLE_NAME = "solar_forecast_dag"; // totale verwachte opbrengst hele kalenderdag

// Timeline instellingen
const SEND_TIMELINE = true;
const MIN_CHANGE_FOR_TIMELINE = 0.3; // kWh verschil voordat we melden
const DAG_MELDING_UUR = 6; // lokaal uur waarin de dagprognose gemeld wordt i.p.v. de 3-uursprognose

// --------------------------
// Helpers
// --------------------------

function parseForecastDate(s) {
  return new Date(s.replace(" ", "T"));
}

function getAmsterdamOffsetHours(date) {
  const year = date.getUTCFullYear();
  const lastSundayMarch = new Date(Date.UTC(year, 2, 31));
  lastSundayMarch.setUTCDate(31 - lastSundayMarch.getUTCDay());
  const lastSundayOct = new Date(Date.UTC(year, 9, 31));
  lastSundayOct.setUTCDate(31 - lastSundayOct.getUTCDay());
  return (date >= lastSundayMarch && date < lastSundayOct) ? 2 : 1;
}

function round(value, decimals = 2) {
  return Number(Number(value).toFixed(decimals));
}

async function getOrCreateLogicVariable(name, type, initialValue) {
  const vars = await Homey.logic.getVariables();
  let found = Object.values(vars).find(v => v.name === name);

  if (found) return found;

  return await Homey.logic.createVariable({
    variable: { name, type, value: initialValue }
  });
}

async function setLogicNumber(name, value) {
  const variable = await getOrCreateLogicVariable(name, "number", value);

  await Homey.logic.updateVariable({
    id: variable.id,
    variable: { value }
  });

  return variable;
}

async function getLogicNumber(name, fallback = 0) {
  const vars = await Homey.logic.getVariables();
  const found = Object.values(vars).find(v => v.name === name);
  if (!found) return fallback;

  const num = Number(found.value);
  return Number.isFinite(num) ? num : fallback;
}

async function addTimeline(text) {
  try {
    await Homey.flow.runFlowCardAction({
      uri: 'homey:flowcardaction:homey:manager:notifications:create_notification',
      id: 'homey:manager:notifications:create_notification',
      args: { text }
    });
    return true;
  } catch (e) {
    return false;
  }
}

// kWh berekening
function getKwhNextHoursFromCumulative(wattHoursMap, hours = 3) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 3600000);

  const entries = Object.entries(wattHoursMap)
    .map(([ts, wh]) => ({
      time: parseForecastDate(ts),
      wh: Number(wh)
    }))
    .sort((a, b) => a.time - b.time);

  let start = entries.findLast(e => e.time <= now) || entries[0];
  let endEntry = start;

  for (const e of entries) {
    if (e.time <= end && e.time >= start.time) {
      endEntry = e;
    }
  }

  return Math.max(0, (endEntry.wh - start.wh) / 1000);
}

// --------------------------
// API call
// --------------------------

const url = `https://api.forecast.solar/estimate/${LAT}/${LON}/${TILT}/${AZIMUTH}/${KWP}`;
const res = await fetch(url);

if (!res.ok) {
  throw new Error(`API fout: ${res.status}`);
}

const data = await res.json();

if (!data.result?.watt_hours) {
  throw new Error("Geen forecast data ontvangen");
}

// --------------------------
// Berekening
// --------------------------

let solarForecast = getKwhNextHoursFromCumulative(data.result.watt_hours, 3);
solarForecast = round(solarForecast * FORECAST_CORRECTIE, 2);

// vorige waarde ophalen
const previousForecast = await getLogicNumber(VARIABLE_NAME, 0);
const delta = round(solarForecast - previousForecast, 2);

// Totale verwachte opbrengst hele kalenderdag (00:00-24:00, lokale tijd)
const now = new Date();
const tzOffset = getAmsterdamOffsetHours(now);
const localNow = new Date(now.getTime() + tzOffset * 3600000);
const todayStr = localNow.toISOString().slice(0, 10);
const solarForecastDag = round(((data.result.watt_hours_day?.[todayStr] ?? 0) / 1000) * FORECAST_CORRECTIE, 2);

// --------------------------
// Opslaan
// --------------------------

await setLogicNumber(VARIABLE_NAME, solarForecast);
await setLogicNumber(DAG_VARIABLE_NAME, solarForecastDag);

// --------------------------
// Timeline
// --------------------------

let timelineSent = false;
let timelineText = '';

if (SEND_TIMELINE && localNow.getUTCHours() === DAG_MELDING_UUR) {
  timelineText = `☀️ Verwachte opbrengst vandaag: ${solarForecastDag} kWh`;
  timelineSent = await addTimeline(timelineText);
} else if (SEND_TIMELINE && Math.abs(delta) >= MIN_CHANGE_FOR_TIMELINE) {
  timelineText = `☀️ Zon verwachting komende 3 uur: ${solarForecast} kWh (${delta >= 0 ? '+' : ''}${delta})`;
  timelineSent = await addTimeline(timelineText);
}

// --------------------------
// Return
// --------------------------

return {
  solarForecastKwhNext3h: solarForecast,
  previous: previousForecast,
  delta,
  solarForecastKwhDag: solarForecastDag,
  timelineSent,
  timelineText,
  lat: LAT,
  lon: LON,
  tilt: TILT,
  azimuth: AZIMUTH,
  kwp: KWP,
  forecastCorrectie: FORECAST_CORRECTIE
};