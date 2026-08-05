// ==========================
// Solar: Dagelijkse samenvatting + TILT kalibratie
// Trigger: dagelijks om 21:30 lokaal
// ==========================

const LAT = 52.4775;
const LON = 4.7974;
const TILT = 15;
const KWP = 8.8;
const AZIMUTH = -30;
const FORECAST_CORRECTIE = 1.2; // Schaalfactor voor prognose — pas aan op basis van calibratieadvies

const DEVICE_NAME = 'Zonnepanelen';

// Dag geldt als "helder genoeg" voor kalibratie als werkelijk >= drempel × dag-prognose.
// forecast.solar is een hemelsblauw-model (geen weer), dus op bewolkte dagen < 0.7.
const CLEAR_DAY_THRESHOLD = 0.75;

// EMA-gewicht: hogere waarde = sneller aanpassen, lagere waarde = meer stabiel
const EMA_ALPHA = 0.2;

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

async function getLogicNumber(name, fallback = 0) {
  const vars = await Homey.logic.getVariables();
  const found = Object.values(vars).find(v => v.name === name);
  if (!found) return fallback;
  const num = Number(found.value);
  return Number.isFinite(num) ? num : fallback;
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

// --------------------------
// Actuele dagopbrengst
// --------------------------

const devices = await Homey.devices.getDevices();
const device = Object.values(devices).find(d => d.name === DEVICE_NAME);
if (!device) throw new Error(`Device '${DEVICE_NAME}' niet gevonden`);

const actualKwh = round(device.capabilitiesObj['meter_power.day']?.value ?? 0, 2);

// --------------------------
// Dag-prognose ophalen
// --------------------------

const now = new Date();
const tzOffset = getAmsterdamOffsetHours(now);
const todayStr = new Date(now.getTime() + tzOffset * 3600000).toISOString().slice(0, 10);

const url = `https://api.forecast.solar/estimate/${LAT}/${LON}/${TILT}/${AZIMUTH}/${KWP}`;
const res = await fetch(url);
if (!res.ok) throw new Error(`API fout: ${res.status}`);
const data = await res.json();

const forecastDay = round((data.result.watt_hours_day?.[todayStr] ?? 0) / 1000, 2);
const forecastCorrected = round(forecastDay * FORECAST_CORRECTIE, 2);
const ratio = forecastCorrected > 0 ? round(actualKwh / forecastCorrected, 3) : null;
// Correctie die vandaag precies de werkelijke opbrengst had opgeleverd — onafhankelijk van de huidige FORECAST_CORRECTIE
const impliedCorrectie = forecastDay > 0 ? round(actualKwh / forecastDay, 3) : null;

// --------------------------
// TILT kalibratie (EMA)
// Op heldere dagen bijwerken: gemiddelde geïmpliceerde correctie nadert de ingestelde FORECAST_CORRECTIE als TILT klopt
// --------------------------

let emaCorrectie = await getLogicNumber('solar_tilt_ema_correctie', impliedCorrectie ?? FORECAST_CORRECTIE);
let calibDays = await getLogicNumber('solar_tilt_calibration_days', 0);
let tiltAdvice = null;
let islearningDay = false;

// Auto-reset alleen als TILT, AZIMUTH of KWP is aangepast — die veranderen de ruwe prognosebasis.
// FORECAST_CORRECTIE zelf triggert geen reset meer: emaCorrectie is er onafhankelijk van.
const lastTilt = await getLogicNumber('solar_last_tilt', TILT);
const lastAzimuth = await getLogicNumber('solar_last_azimuth', AZIMUTH);
const lastKwp = await getLogicNumber('solar_last_kwp', KWP);
if (lastTilt !== TILT || lastAzimuth !== AZIMUTH || lastKwp !== KWP) {
  emaCorrectie = impliedCorrectie ?? FORECAST_CORRECTIE;
  calibDays = 0;
  await setLogicNumber('solar_tilt_ema_correctie', emaCorrectie);
  await setLogicNumber('solar_tilt_calibration_days', calibDays);
  await setLogicNumber('solar_last_tilt', TILT);
  await setLogicNumber('solar_last_azimuth', AZIMUTH);
  await setLogicNumber('solar_last_kwp', KWP);
}

if (ratio !== null && ratio >= CLEAR_DAY_THRESHOLD && impliedCorrectie !== null) {
  islearningDay = true;
  emaCorrectie = round(EMA_ALPHA * impliedCorrectie + (1 - EMA_ALPHA) * emaCorrectie, 3);
  calibDays = calibDays + 1;

  await setLogicNumber('solar_tilt_ema_correctie', emaCorrectie);
  await setLogicNumber('solar_tilt_calibration_days', calibDays);

  if (calibDays >= 5) {
    const suggested = round(emaCorrectie, 2);
    if (suggested > FORECAST_CORRECTIE * 1.07) {
      tiltAdvice = `Prognose te laag — gemiddeld geïmpliceerde correctie ${suggested} over ${calibDays} heldere dagen. Verhoog FORECAST_CORRECTIE van ${FORECAST_CORRECTIE} naar ~${suggested}.`;
    } else if (suggested < FORECAST_CORRECTIE * 0.93) {
      tiltAdvice = `Prognose te hoog of verliezen aanwezig — gemiddeld geïmpliceerde correctie ${suggested} over ${calibDays} heldere dagen. Verlaag FORECAST_CORRECTIE van ${FORECAST_CORRECTIE} naar ~${suggested}.`;
    } else {
      tiltAdvice = `Prognose klopt goed (FORECAST_CORRECTIE=${FORECAST_CORRECTIE}) — gemiddeld geïmpliceerde correctie ${suggested} over ${calibDays} heldere dagen.`;
    }
  }
}

// --------------------------
// Tijdlijn-bericht (één per dag)
// --------------------------

const pctStr = ratio !== null ? ` (${Math.round(ratio * 100)}%)` : '';
let text = `☀️ Dagopbrengst: ${actualKwh} kWh werkelijk vs ${forecastCorrected} kWh prognose${pctStr}`;
if (tiltAdvice) text += `\n📐 ${tiltAdvice}`;

await addTimeline(text);

return {
  actualKwhToday: actualKwh,
  forecastDayKwh: forecastDay,
  forecastCorrectedKwh: forecastCorrected,
  ratio,
  impliedCorrectie,
  emaCorrectie,
  calibrationDays: calibDays,
  isLearningDay: islearningDay,
  tiltAdvice,
  tilt: TILT,
  forecastCorrectie: FORECAST_CORRECTIE
};
