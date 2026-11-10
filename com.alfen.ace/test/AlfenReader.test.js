'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const {
  METER_START, METER_COUNT, SCN_START, SCN_COUNT,
  fromFloat32, phasePower, parseMeter, parseSocket, mode3Status,
} = require('../lib/AlfenReader');

function meterRegisters({ voltages, currents, pfs = [NaN, NaN, NaN], powers, energyWh = 2827540 }) {
  const regs = new Array(METER_COUNT).fill(0);
  const put  = (reg, words) => words.forEach((w, i) => { regs[reg - METER_START + i] = w; });

  put(300, [0x0003]);
  [0, 1, 2].forEach(n => {
    put(306 + n * 2, fromFloat32(voltages[n]));
    put(320 + n * 2, fromFloat32(currents[n]));
    put(328 + n * 2, fromFloat32(pfs[n]));
    put(338 + n * 2, fromFloat32(powers[n]));
  });
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(energyWh, 0);
  put(374, [0, 1, 2, 3].map(i => buf.readUInt16BE(i * 2)));
  return regs;
}

test('uses real power registers when they are filled', () => {
  const meter = parseMeter(meterRegisters({
    voltages: [231.3, 228.6, 232.3],
    currents: [6, 6, 5.5],
    powers:   [1380, 1365, 1270],
  }));
  assert.strictEqual(Math.round(meter.totalPower), 4015);
  assert.strictEqual(meter.energyKwh, 2827.54);
  assert.strictEqual(meter.meterActive, true);
});

test('falls back to V × I when power registers read 0 while charging', () => {
  const meter = parseMeter(meterRegisters({
    voltages: [231.3, 228.6, 232.3],
    currents: [6, 6, 5.5],
    powers:   [0, 0, 0],
  }));
  const expected = 231.3 * 6 + 228.6 * 6 + 232.3 * 5.5;
  assert.ok(Math.abs(meter.totalPower - expected) < 0.5, `got ${meter.totalPower}`);
  assert.ok(meter.phases.every(p => p.power > 1200));
});

test('falls back to V × I × PF when power registers are NaN', () => {
  const meter = parseMeter(meterRegisters({
    voltages: [230, 230, 230],
    currents: [10, 10, 10],
    pfs:      [0.98, 0.98, 0.98],
    powers:   [NaN, NaN, NaN],
  }));
  assert.ok(Math.abs(meter.totalPower - 3 * 230 * 10 * 0.98) < 0.5);
});

test('reports 0 W when no current flows', () => {
  assert.strictEqual(phasePower({ power: 0, voltage: 230, current: 0, powerFactor: null }), 0);
  assert.strictEqual(phasePower({ power: null, voltage: 230, current: 0.1, powerFactor: null }), 0);
});

test('parses socket block and mode 3 state', () => {
  const regs = new Array(SCN_COUNT).fill(0);
  const put  = (reg, words) => words.forEach((w, i) => { regs[reg - SCN_START + i] = w; });
  put(1200, [1]);
  put(1201, [0x4332, 0, 0, 0, 0]); // "C2"
  put(1206, fromFloat32(6));
  put(1208, [0, 877]);
  put(1210, fromFloat32(6));
  put(1212, fromFloat32(16));
  put(1215, [3]);

  const socket = parseSocket(regs);
  assert.deepStrictEqual(socket, {
    available: true, mode3State: 'C2', actualMaxCurrent: 6, validTime: 877,
    modbusMaxCurrent: 6, safeCurrent: 16, chargePhases: 3,
  });
  assert.deepStrictEqual(mode3Status('C2'), { carConnected: true, charging: true });
  assert.deepStrictEqual(mode3Status('B1'), { carConnected: true, charging: false });
  assert.deepStrictEqual(mode3Status('A'),  { carConnected: false, charging: false });
});
