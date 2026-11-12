// Accu nachtladen – plan maken.
// Berekent hoeveel de accu 's nachts van het net moet laden zodat het verwachte zonne-overschot
// hem overdag vol krijgt, en kiest daarvoor de goedkoopste nachtkwartieren.
// Huisverbruik per uur = mediaan van de afgelopen dagen uit Insights (net + zon − accu − auto).
// Rekening gehouden met 85% round-trip (√0,85 laden en √0,85 ontladen).
// Een nachtkwartier wordt alleen gekozen als de stroom later op de dag een duurder tekortkwartier
// vervangt: de waarde = prijs van de duurste kwartieren (na het laadvenster) waarin het huis meer
// verbruikt dan de zon levert. Wat al in de accu zit en het zonne-overschot gaan eerst naar de duurste.
// Ochtendpiek: er wordt in ieder geval zoveel geladen dat de accu het verbruik vanaf het laatste
// laadkwartier tot de zon het verbruik dekt (uiterlijk MORNING_TO) haalt, met MIN_SOC als reserve.
const CFG = {
  CAP_KWH: 14,          // bruikbare capaciteit
  RTE: 0.85,            // round-trip efficiency
  CHARGE_W: 3000,       // laadvermogen vanaf het net (AC); begrensd via 'Max AC Input Power' van de accu
  MAX_SOC: 100,         // hoogste doel
  MIN_SOC: 0,           // ontlaadgrens van de accu (accu ontlaadt tot 0%)
  MORNING_TO: 12,       // ochtendpiek loopt tot de zon het verbruik dekt, uiterlijk tot dit uur
  MORNING_RESERVE: 5,   // extra marge (% van de accu) bovenop het verwachte ochtendverbruik
  PV_FACTOR: 1.0,       // correctie op de zonneprognose (1.0 = prognose van Zonnepanelen_Σsolar ongewijzigd)
  LOAD_DAYS: 5,         // aantal hele dagen terug voor het verbruiksprofiel
  LOAD_FALLBACK_W: 450, // verbruik per uur als Insights niet lukt
  MARGIN_EUR: 0.03,     // minimale winst per geleverde kWh
  NIGHT_FROM: 0, NIGHT_TO: 7,   // laadvenster (uren, lokale tijd); ontladen telt vanaf NIGHT_TO tot middernacht
  DRY_RUN: false,        // true = alleen plannen, niet laden
};
const ACCU = '46654c7d-d07d-4c4e-8db2-0ec0f1a2c825';  // Accu (Anker Solix community-app)
const ACCU_SIGMA = '60d84a7c-088e-48fc-a99d-929a31d4d198'; // Accu_Σ (PBTH): accuvermogen per uur, + = laden; vult gaten in de accu-historie
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
  // Accu-historie mag ontbreken (nieuw device): dan Accu_Σ als bron. Zonder accuwaarde is het verbruik
  // van dat moment onbekend (ontladen verlaagt de netafname), dus die momenten slaan we over.
  const [grid, pv, batDev, batSigma, ev] = await Promise.all([hourly(GRID, 'energy_power'), hourly(SOLAR, 'energy_power'), hourly(ACCU, 'energy_power').catch(() => new Map()), hourly(ACCU_SIGMA, 'measure_watt_avg').catch(() => new Map()), hourly(EV, 'energy_power').catch(() => new Map())]);
  const bat = new Map([...batSigma, ...batDev]);   // accu-device gaat voor waar het een waarde heeft
  const days = [...new Set([...grid.keys()].map(t => local(new Date(t)).date))].filter(d => d !== now.date).sort().slice(-CFG.LOAD_DAYS);
  const buckets = Array.from({ length: 24 }, () => []);
  for (const [t, g] of grid) {
    const l = local(new Date(t));
    if (!days.includes(l.date) || !bat.has(t)) continue;
    const load = g + (pv.get(t) ?? 0) - bat.get(t) - Math.max(0, ev.get(t) ?? 0);
    if (load < 0 || load > 15000) continue;          // meetfout
    buckets[l.hour].push(load);
  }
  if (days.length >= 2) {
    loadW = buckets.map(b => b.length ? median(b) : CFG.LOAD_FALLBACK_W);
    const empty = buckets.filter(b => !b.length).length;
    loadInfo = `mediaan ${days.length} dagen` + (empty ? `, ${empty} uur zonder accudata → ${CFG.LOAD_FALLBACK_W} W` : '');
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
const night = slots.filter(s => s.start >= CFG.NIGHT_FROM * 60 && s.start < CFG.NIGHT_TO * 60).sort((a, b) => a.price - b.price);

// 5. Ochtendpiek: minimaal te laden zodat de accu tot de zon het overneemt meegaat.
// Tekort per kwartier = verbruik (mediaan afgelopen dagen) − zon in dat uur. Minuten < 0 = vorige avond.
const deficitAt = m => { const h = ((Math.floor(m / 60) % 24) + 24) % 24; return Math.max(0, loadW[h] / 1000 - pvH[h]) * slotLen / 60; };
let morningEnd = CFG.MORNING_TO * 60;
for (let m = CFG.NIGHT_TO * 60; m < CFG.MORNING_TO * 60; m += slotLen) {
  const h = Math.floor(m / 60);
  if (pvH[h] >= loadW[h] / 1000) { morningEnd = m; break; }
}
const planFrom = forTomorrow ? now.min - 1440 : now.min;      // 23:00 → -60 (gisteravond)
const morningKWh = (() => { let e = 0; for (let m = CFG.NIGHT_TO * 60; m < morningEnd; m += slotLen) e += deficitAt(m); return e; })();
// Laadkwartieren bepalen het moment vanaf wanneer de accu het zelf moet doen; herhalen tot stabiel.
let must = [], mustGrid = 0, mustSoc = 0, drainBefore = 0;
for (let iter = 0; iter < 6; iter++) {
  const taken = new Set(must.map(s => s.start));
  const first = must.length ? Math.min(...must.map(s => s.start)) : CFG.NIGHT_TO * 60;
  drainBefore = 0; for (let m = Math.max(planFrom, -1440); m < first; m += slotLen) drainBefore += deficitAt(m);   // accu dekt de nacht vóór het laden
  let afterKWh = 0; for (let m = first; m < morningEnd; m += slotLen) if (!taken.has(m)) afterKWh += deficitAt(m); // en alles ná het eerste laadkwartier behalve tijdens het laden
  const socAtCharge = Math.max(CFG.MIN_SOC, soc - drainBefore / etaC / CFG.CAP_KWH * 100);
  mustSoc = Math.min(CFG.MAX_SOC, CFG.MIN_SOC + CFG.MORNING_RESERVE + afterKWh / etaC / CFG.CAP_KWH * 100);
  mustGrid = Math.max(0, (mustSoc - socAtCharge) / 100 * CFG.CAP_KWH) / etaC;
  const n = Math.min(night.length, Math.ceil(mustGrid / perSlotKWh - 1e-9));
  const next = night.slice(0, n);
  const same = next.length === must.length && next.every(s => taken.has(s.start));
  must = next;
  if (same) break;
}

// 6. Waarde van opgeslagen stroom: kwartieren na het laadvenster waarin het huis tekort heeft, duurste eerst
const valueSlots = slots.filter(s => s.start >= CFG.NIGHT_TO * 60).map(s => {
  const h = Math.floor(s.start / 60);
  return { start: s.start, price: s.price, kWh: Math.max(0, loadW[h] / 1000 - pvH[h]) * slotLen / 60 };
}).filter(s => s.kWh > 0).sort((a, b) => b.price - a.price);
const deficitKWh = valueSlots.reduce((a, s) => a + s.kWh, 0);
let vi = 0, vLeft = valueSlots[0]?.kWh ?? 0;
function take(kWh) {                 // verbruikt tekort-energie van duur naar goedkoop
  let e = 0, val = 0;
  while (kWh > 1e-9 && vi < valueSlots.length) {
    const t = Math.min(kWh, vLeft); e += t; val += t * valueSlots[vi].price; kWh -= t; vLeft -= t;
    if (vLeft <= 1e-9) { vi++; vLeft = valueSlots[vi]?.kWh ?? 0; }
  }
  return { e, val, avg: e ? val / e : 0 };
}
function peek(kWh) { const sv = [vi, vLeft]; const r = take(kWh); [vi, vLeft] = sv; return r; }
// Wat al in de accu zit (boven MIN_SOC) en het zonne-overschot dekken eerst de duurste tekortkwartieren
const freeKWh = (Math.max(0, (soc - CFG.MIN_SOC) / 100 * CFG.CAP_KWH) + solarToBattery) * etaC;
take(freeKWh);

const deliverPerSlot = perSlotKWh * CFG.RTE;
const firstV = peek(deliverPerSlot);
const need = Math.ceil(gridKWh / perSlotKWh - 1e-9);
const chosen = [];
let valueSum = 0, valueKWh = 0;
for (const s of must) {              // ochtendpiek: altijd, ook als het niet loont
  const v = take(deliverPerSlot); chosen.push(s); valueSum += v.val; valueKWh += v.e;
}
const mustSet = new Set(must.map(s => s.start));
for (const s of night) {
  if (chosen.length >= Math.max(need, must.length)) break;
  if (mustSet.has(s.start)) continue;
  const v = peek(deliverPerSlot);
  if (v.e * (v.avg - CFG.MARGIN_EUR) < perSlotKWh * s.price) break;   // loont niet (meer)
  take(deliverPerSlot); chosen.push(s); valueSum += v.val; valueKWh += v.e;
}
chosen.sort((a, b) => a.start - b.start);
const plannedGrid = Math.min(Math.max(gridKWh, mustGrid), chosen.length * perSlotKWh);
const valueAvg = valueKWh ? valueSum / valueKWh : firstV.avg;

// Doel voor de uitvoer-flow (laden stopt zodra dit bereikt is). Nooit lager dan wat de ochtend
// nodig heeft, want vóór het laden kan de accu al wat ontladen zijn.
const planTargetSoc = Math.round(Math.min(CFG.MAX_SOC, Math.max(
  soc + plannedGrid * etaC / CFG.CAP_KWH * 100,
  must.length ? mustSoc : 0,
)));
const plan = {
  date: target.date, slotLen, targetSoc: planTargetSoc,
  slots: chosen.map(s => s.start), dryRun: CFG.DRY_RUN,
  made: `${now.date} ${hhmm(now.min)}`,
};
await setVar(PLAN_VAR, JSON.stringify(plan));

const avgChosen = chosen.length ? chosen.reduce((a, s) => a + s.price, 0) / chosen.length : 0;
const reason = chosen.length === 0 && need === 0 ? 'accu en zon redden de ochtend, niet laden'
  : !night.length ? 'geen nachtprijzen'
  : chosen.length === must.length && must.length > 0 && need <= must.length ? 'alleen voor de ochtendpiek'
  : firstV.e === 0 && must.length === 0 ? `geen tekort na ${hhmm(CFG.NIGHT_TO * 60)} dat accu en zon niet al dekken`
  : chosen.length === 0 ? `geen nachtkwartier loont (goedkoopste €${r2(night[0].price)} ÷0,85 = €${r2(night[0].price / CFG.RTE)} vs waarde €${r2(firstV.avg)})`
  : chosen.length < need ? `alleen ${chosen.length} van ${need} kwartieren lonen` : 'ok';
const morningInfo = `ochtend ${hhmm(CFG.NIGHT_TO * 60)}–${hhmm(morningEnd)} tekort ${r2(morningKWh)} kWh (nacht vóór laden ${r2(drainBefore)} kWh) → minimaal ${Math.round(mustSoc)}% na laden, ${must.length} kwartier(en) verplicht`;
const sunProfile = pvH.map((p, h) => p > 0 ? `${h}u zon ${Math.round(p * 1000)}/verbr ${Math.round(loadW[h])}` : null).filter(Boolean).join(', ');
const summary = `${plan.made} plan ${target.date}${CFG.DRY_RUN ? ' [TEST, laadt niet]' : ''}: SoC nu ${soc}%; zon ${r2(pvForecast)} kWh (×${CFG.PV_FACTOR}, ${hhmm(rise)}–${hhmm(set)}), verbruik tijdens zonuren ${r2(loadSunKWh)} kWh (${loadInfo}, zonder auto) → overschot ${r2(solarToBattery)} kWh in accu → doel ${Math.round(targetSoc)}%, van net ${r2(gridKWh)} kWh nodig; ${morningInfo}; tekort na ${hhmm(CFG.NIGHT_TO * 60)} ${r2(deficitKWh)} kWh, waarvan ${r2(Math.min(freeKWh, deficitKWh))} kWh al gedekt door accu (>${CFG.MIN_SOC}%) en zon; ${chosen.length} kwartier(en) ${chosen.map(s => hhmm(s.start)).join(',')} gem. €${r2(avgChosen)} (÷0,85 = €${r2(avgChosen / CFG.RTE)}) vs waarde bij ontladen €${r2(valueAvg)}; ${reason}; verwacht ${r2(plannedGrid)} kWh laden, doel ${plan.targetSoc}% | profiel W: ${sunProfile}`;
await setVar(STATUS_VAR, summary);
log(summary);

// 7. Korte samenvatting op de tijdlijn (aaneengesloten kwartieren als tijdvak)
const ranges = [];
for (const s of chosen) { const last = ranges[ranges.length - 1]; if (last && last.end === s.start) last.end += slotLen; else ranges.push({ start: s.start, end: s.start + slotLen }); }
const timeline = `🔋 Laadplan ${target.date}${CFG.DRY_RUN ? ' [TEST]' : ''}: `
  + (chosen.length ? `${r2(plannedGrid)} kWh laden ${ranges.map(x => `${hhmm(x.start)}–${hhmm(x.end)}`).join(', ')}, gem. €${r2(avgChosen)} → ~${plan.targetSoc}%` : 'niet laden')
  + `. SoC nu ${soc}%, zon ${r2(pvForecast)} kWh, ochtendpiek tot ${hhmm(morningEnd)} vraagt ${Math.round(mustSoc)}%`
  + (reason !== 'ok' ? ` (${reason})` : '') + '.';
try { await Homey.flow.runFlowCardAction({ uri: 'homey:flowcardaction:homey:manager:notifications:create_notification', id: 'homey:manager:notifications:create_notification', args: { text: timeline } }); }
catch (e) { log('Tijdlijnmelding mislukt: ' + e.message); }
return true;
