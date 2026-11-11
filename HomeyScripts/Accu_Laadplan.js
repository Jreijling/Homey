// Accu nachtladen – plan maken.
// Berekent hoeveel de accu 's nachts van het net moet laden zodat het verwachte zonne-overschot
// hem overdag vol krijgt, en kiest daarvoor de goedkoopste nachtkwartieren.
// Huisverbruik per uur = mediaan van de afgelopen dagen uit Insights (net + zon − accu − auto).
// Rekening gehouden met 85% round-trip (√0,85 laden en √0,85 ontladen).
const CFG = {
  CAP_KWH: 14,          // bruikbare capaciteit
  RTE: 0.85,            // round-trip efficiency
  CHARGE_W: 3000,       // laadvermogen vanaf het net (AC); begrensd via 'Max AC Input Power' van de accu
  MAX_SOC: 100,         // hoogste doel
  PV_FACTOR: 1.0,       // correctie op de zonneprognose (1.0 = prognose van Zonnepanelen_Σsolar ongewijzigd)
  LOAD_DAYS: 5,         // aantal hele dagen terug voor het verbruiksprofiel
  LOAD_FALLBACK_W: 450, // verbruik per uur als Insights niet lukt
  MARGIN_EUR: 0.03,     // minimale winst per kWh t.o.v. de avondpiek
  NIGHT_FROM: 0, NIGHT_TO: 7,   // laadvenster (uren, lokale tijd)
  PEAK_FROM: 17, PEAK_TO: 22,   // avondpiek waartegen we vergelijken
  DRY_RUN: false,        // true = alleen plannen, niet laden
};
const ACCU = 'd0b80416-826c-4db9-9a4e-163796f60d5a';
const SOLAR = '865bc38a-e913-4771-aec7-b6bc7ab46b6a';
const GRID = '3755a652-027b-41bb-b188-ab2ac592ee04';   // HomeWizard P1 (+ = afname)
const EV = 'dac34f15-df55-42fc-921c-30377b5480aa';     // Alfen laadpaal (apart gepland door EMS)
const KNMI = '557e2f59-b507-4aa4-a543-5da9391dfa76';    // zon op/onder
const PBTH = 'homey:device:adc99ffc-add2-40d0-b664-8ce3b19c28af';
const PLAN_VAR = 'e06b1baf-c079-424c-a84f-34928033d87b';
const STATUS_VAR = 'f40fb5df-e234-43ce-9867-d57a74e42c2a';

function local(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, min: +p.hour * 60 + +p.minute };
}
const r2 = x => Math.round(x * 100) / 100;
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
async function setVar(id, value) { await Homey.logic.updateVariable({ id, variable: { value } }); }
async function hourly(deviceId, cap) {
  let e;
  try { e = await Homey.insights.getLogEntries({ id: `homey:device:${deviceId}:${cap}`, resolution: 'last7Days' }); }
  catch (err) { e = await Homey.insights.getLogEntries({ uri: `homey:device:${deviceId}`, id: cap, resolution: 'last7Days' }); }
  const m = new Map();
  for (const x of (e.values || e.entries || e || [])) if (x && x.v !== null && x.v !== undefined) m.set(new Date(x.t).getTime(), Number(x.v));
  return m;
}

const now = local(new Date());
const forTomorrow = now.hour >= 12;                 // 23:00 -> plan voor de nacht van morgen
const target = forTomorrow ? local(new Date(Date.now() + 12 * 3600e3)) : now;
const etaC = Math.sqrt(CFG.RTE);

// 1. Huisverbruik per uur (lokale tijd) uit de afgelopen hele dagen, zonder auto-laden
let loadW = Array(24).fill(CFG.LOAD_FALLBACK_W), loadInfo = 'vast';
try {
  const [grid, pv, bat, ev] = await Promise.all([hourly(GRID, 'energy_power'), hourly(SOLAR, 'energy_power'), hourly(ACCU, 'energy_power'), hourly(EV, 'energy_power').catch(() => new Map())]);
  const days = [...new Set([...grid.keys()].map(t => local(new Date(t)).date))].filter(d => d !== now.date).sort().slice(-CFG.LOAD_DAYS);
  const buckets = Array.from({ length: 24 }, () => []);
  for (const [t, g] of grid) {
    const l = local(new Date(t));
    if (!days.includes(l.date)) continue;
    const load = g + (pv.get(t) ?? 0) - (bat.get(t) ?? 0) - Math.max(0, ev.get(t) ?? 0);
    if (load < 0 || load > 15000) continue;          // meetfout
    buckets[l.hour].push(load);
  }
  if (days.length >= 2) {
    loadW = buckets.map(b => b.length ? median(b) : CFG.LOAD_FALLBACK_W);
    loadInfo = `mediaan ${days.length} dagen`;
  }
} catch (e) { loadInfo = 'vast (Insights-fout: ' + e.message + ')'; }

// 2. Zonneprognose verdeeld over de dag (sinus van zonsopkomst tot -ondergang)
const accu = await Homey.devices.getDevice({ id: ACCU });
const soc = Number(accu.capabilitiesObj.measure_battery.value);
const solar = await Homey.devices.getDevice({ id: SOLAR });
const fcCap = forTomorrow ? 'meter_kwh_forecast.tomorrow' : 'meter_kwh_forecast.this_day';
const pvForecast = Number(solar.capabilitiesObj[fcCap]?.value ?? 0);
const pvUsable = pvForecast * CFG.PV_FACTOR;
let rise = 8 * 60, set = 17 * 60;
try { const k = await Homey.devices.getDevice({ id: KNMI }); rise = toMin(k.capabilitiesObj.sun_up.value) || rise; set = toMin(k.capabilitiesObj.sun_down.value) || set; } catch (e) {}
const shape = Array.from({ length: 24 }, (_, h) => {           // gemiddelde sinus over het uur
  let s = 0; for (let q = 0; q < 4; q++) { const m = h * 60 + q * 15 + 7.5; if (m > rise && m < set) s += Math.sin(Math.PI * (m - rise) / (set - rise)); } return s;
});
const shapeSum = shape.reduce((a, x) => a + x, 0) || 1;
const pvH = shape.map(s => pvUsable * s / shapeSum);          // kWh per uur
const surplusH = pvH.map((p, h) => Math.max(0, p - loadW[h] / 1000));
const loadSunKWh = pvH.reduce((a, p, h) => a + (p > 0 ? loadW[h] / 1000 : 0), 0);
const solarToBattery = surplusH.reduce((a, x) => a + x, 0) * etaC;   // kWh die in de accu komt

// 3. Doel-SoC: zo vol dat het zonne-overschot hem daarna vol krijgt
const targetSoc = Math.min(CFG.MAX_SOC, Math.max(0, 100 - solarToBattery / CFG.CAP_KWH * 100));
const storeKWh = Math.max(0, (targetSoc - soc) / 100 * CFG.CAP_KWH);
const gridKWh = storeKWh / etaC;   // van het net, incl. laadverlies

// 4. Prijzen en kwartieren
const pr = await Homey.flow.runFlowCardAction({ uri: PBTH, id: PBTH + ':prices_json', args: { period: forTomorrow ? 'tomorrow' : 'this_day' } });
const prices = JSON.parse(pr?.returnTokens?.prices || '[]');
if (!prices.length) throw new Error('Geen prijzen van PBTH voor ' + target.date);
const slotLen = Math.round(1440 / prices.length);
const perSlotKWh = CFG.CHARGE_W / 1000 * slotLen / 60;
const slots = prices.map((p, i) => ({ start: i * slotLen, price: Number(p) }));
const peak = slots.filter(s => s.start >= CFG.PEAK_FROM * 60 && s.start < CFG.PEAK_TO * 60);
const peakAvg = peak.reduce((a, s) => a + s.price, 0) / peak.length;
const maxPrice = (peakAvg - CFG.MARGIN_EUR) * CFG.RTE;   // duurste nachtprijs die nog loont
const night = slots.filter(s => s.start >= CFG.NIGHT_FROM * 60 && s.start < CFG.NIGHT_TO * 60).sort((a, b) => a.price - b.price);
const need = Math.ceil(gridKWh / perSlotKWh - 1e-9);
const chosen = night.filter(s => s.price <= maxPrice).slice(0, need).sort((a, b) => a.start - b.start);
const plannedGrid = Math.min(gridKWh, chosen.length * perSlotKWh);

const plan = {
  date: target.date, slotLen, targetSoc: Math.round(Math.min(CFG.MAX_SOC, soc + plannedGrid * etaC / CFG.CAP_KWH * 100)),
  slots: chosen.map(s => s.start), dryRun: CFG.DRY_RUN,
  made: `${now.date} ${hhmm(now.min)}`,
};
await setVar(PLAN_VAR, JSON.stringify(plan));

const avgChosen = chosen.length ? chosen.reduce((a, s) => a + s.price, 0) / chosen.length : 0;
const reason = need === 0 ? 'zon vult de accu genoeg, niet laden'
  : chosen.length === 0 ? `geen nachtkwartier goedkoop genoeg (max €${r2(maxPrice)}, goedkoopste €${r2(night[0]?.price)})`
  : chosen.length < need ? `alleen ${chosen.length} van ${need} kwartieren goedkoop genoeg` : 'ok';
const sunProfile = pvH.map((p, h) => p > 0 ? `${h}u zon ${Math.round(p * 1000)}/verbr ${Math.round(loadW[h])}` : null).filter(Boolean).join(', ');
const summary = `${plan.made} plan ${target.date}${CFG.DRY_RUN ? ' [TEST, laadt niet]' : ''}: SoC nu ${soc}%; zon ${r2(pvForecast)} kWh (×${CFG.PV_FACTOR}, ${hhmm(rise)}–${hhmm(set)}), verbruik tijdens zonuren ${r2(loadSunKWh)} kWh (${loadInfo}, zonder auto) → overschot ${r2(solarToBattery)} kWh in accu → doel ${Math.round(targetSoc)}%, van net ${r2(gridKWh)} kWh nodig; ${chosen.length} kwartier(en) ${chosen.map(s => hhmm(s.start)).join(',')} gem. €${r2(avgChosen)} (÷0,85 = €${r2(avgChosen / CFG.RTE)}) vs avondpiek €${r2(peakAvg)}; ${reason}; verwacht ${r2(plannedGrid)} kWh laden tot ~${plan.targetSoc}% | profiel W: ${sunProfile}`;
await setVar(STATUS_VAR, summary);
log(summary);

// 5. Korte samenvatting op de tijdlijn (aaneengesloten kwartieren als tijdvak)
const ranges = [];
for (const s of chosen) { const last = ranges[ranges.length - 1]; if (last && last.end === s.start) last.end += slotLen; else ranges.push({ start: s.start, end: s.start + slotLen }); }
const timeline = `🔋 Laadplan ${target.date}${CFG.DRY_RUN ? ' [TEST]' : ''}: `
  + (chosen.length ? `${r2(plannedGrid)} kWh laden ${ranges.map(x => `${hhmm(x.start)}–${hhmm(x.end)}`).join(', ')}, gem. €${r2(avgChosen)} → ~${plan.targetSoc}%` : 'niet laden')
  + `. SoC nu ${soc}%, zon ${r2(pvForecast)} kWh, doel ${Math.round(targetSoc)}%`
  + (reason !== 'ok' ? ` (${reason})` : '') + '.';
try { await Homey.flow.runFlowCardAction({ uri: 'homey:manager:notifications', id: 'create_notification', args: { text: timeline } }); }
catch (e) { log('Tijdlijnmelding mislukt: ' + e.message); }
return true;