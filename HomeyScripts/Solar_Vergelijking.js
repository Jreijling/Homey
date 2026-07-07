// ==========================
// Solar: Forecast vs Werkelijk (uurlijks — stille data-opslag)
// ==========================

const LAT = 52.4775;
const LON = 4.7974;
const TILT = 15;
const KWP = 8.8;
const AZIMUTH = -30;
const FORECAST_CORRECTIE = 1.1; // Schaalfactor voor prognose — pas aan op basis van calibratieadvies

const DEVICE_NAME = 'Zonnepanelen';

// --------------------------
// Helpers
// --------------------------

function round(value, decimals = 2) {
  return Number(Number(value).toFixed(decimals));
}

function getAmsterdamOffsetHours(date) {
  const year = date.getUTCFullYear();
  const lastSundayMarch = new Date(Date.UTC(year, 2, 31));
  lastSundayMarch.setUTCDate(31 - lastSundayMarch.getUTCDay());
  const lastSundayOct = new Date(Date.UTC(year, 9, 31));
  lastSundayOct.setUTCDate(31 - lastSundayOct.getUTCDay());
  return (date >= lastSundayMarch && date < lastSundayOct) ? 2 : 1;
}

function parseForecastDate(s, offsetHours) {
  const hh = String(offsetHours).padStart(2, '0');
  return new Date(s.replace(' ', 'T') + `+${hh}:00`);
}

async function setLogicNumber(name, value) {
  const vars = await Homey.logic.getVariables();
  let found = Object.values(vars).find(v => v.name === name);
  if (!found) {
    found = await Homey.logic.createVariable({ variable: { name, type: 'number', value } });
  } else {
    await Homey.logic.updateVariable({ id: found.id, variable: { value } });
  }
}

// --------------------------
// Actuele opbrengst
// --------------------------

const devices = await Homey.devices.getDevices();
const device = Object.values(devices).find(d => d.name === DEVICE_NAME);
if (!device) throw new Error(`Device '${DEVICE_NAME}' niet gevonden`);

const actualKwh = round(device.capabilitiesObj['meter_power.day']?.value ?? 0, 2);

// --------------------------
// Forecast ophalen
// --------------------------

const now = new Date();
const tzOffset = getAmsterdamOffsetHours(now);
const localNow = new Date(now.getTime() + tzOffset * 3600000);
const todayStr = localNow.toISOString().slice(0, 10);

const url = `https://api.forecast.solar/estimate/${LAT}/${LON}/${TILT}/${AZIMUTH}/${KWP}`;
const res = await fetch(url);
if (!res.ok) throw new Error(`API fout: ${res.status}`);
const data = await res.json();
if (!data.result?.watt_hours) throw new Error("Geen forecast data ontvangen");

// Forecast t/m nu
const todayEntries = Object.entries(data.result.watt_hours)
  .filter(([ts]) => ts.startsWith(todayStr))
  .map(([ts, wh]) => ({ time: parseForecastDate(ts, tzOffset), wh: Number(wh) }))
  .sort((a, b) => a.time - b.time);

const firstEntry = todayEntries[0];
const currentEntry = todayEntries.filter(e => e.time <= now).pop();

const forecastSoFar = (currentEntry && firstEntry)
  ? round(((currentEntry.wh - firstEntry.wh) / 1000) * FORECAST_CORRECTIE, 2)
  : 0;

const todayTotalForecast = round(((data.result.watt_hours_day?.[todayStr] ?? 0) / 1000) * FORECAST_CORRECTIE, 2);
const pct = forecastSoFar > 0 ? round((actualKwh / forecastSoFar) * 100, 0) : null;

// --------------------------
// Opslaan als logic variables
// --------------------------

await setLogicNumber('solar_actual_day_kwh', actualKwh);
await setLogicNumber('solar_forecast_soFar_kwh', forecastSoFar);
await setLogicNumber('solar_forecast_day_total_kwh', todayTotalForecast);

return {
  actualKwhToday: actualKwh,
  forecastSoFarKwh: forecastSoFar,
  todayTotalForecastKwh: todayTotalForecast,
  percentageOfForecast: pct
};
