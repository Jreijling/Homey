// ==========================
// Forecast.Solar -> Homey Logic + Timeline
// ==========================

// --- JOUW INSTELLINGEN ---
const LAT = 52.4775;
const LON = 4.7974;
const TILT = 17;
const KWP = 8.8;
const AZIMUTH = -30;

const VARIABLE_NAME = "solar_forecast";

// Timeline instellingen
const SEND_TIMELINE = true;
const MIN_CHANGE_FOR_TIMELINE = 0.3; // kWh verschil voordat we melden

// --------------------------
// Helpers
// --------------------------

function parseForecastDate(s) {
  return new Date(s.replace(" ", "T"));
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
solarForecast = round(solarForecast, 2);

// vorige waarde ophalen
const previousForecast = await getLogicNumber(VARIABLE_NAME, 0);
const delta = round(solarForecast - previousForecast, 2);

// --------------------------
// Opslaan
// --------------------------

await setLogicNumber(VARIABLE_NAME, solarForecast);

// --------------------------
// Timeline
// --------------------------

let timelineSent = false;
let timelineText = '';

if (SEND_TIMELINE && Math.abs(delta) >= MIN_CHANGE_FOR_TIMELINE) {
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
  timelineSent,
  timelineText,
  lat: LAT,
  lon: LON,
  tilt: TILT,
  azimuth: AZIMUTH,
  kwp: KWP
};