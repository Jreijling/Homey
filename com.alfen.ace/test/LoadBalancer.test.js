'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { readGrid, fuseLimit } = require('../lib/LoadBalancer');

const cap = value => ({ value });

test('reads HomeWizard style capabilities', () => {
  const grid = readGrid({
    measure_power: cap(7265),
    'measure_current.l1': cap(20.67),
    'measure_current.l2': cap(5.5),
    'measure_current.l3': cap(5.29),
  });
  assert.deepStrictEqual(grid, { power: 7265, currents: [20.67, 5.5, 5.29] });
});

test('reads Tibber Pulse style capabilities (upper case L)', () => {
  const grid = readGrid({
    measure_power: cap(4881),
    'measure_current.L1': cap(4),
    'measure_current.L2': cap(5),
    'measure_current.L3': cap(10),
  });
  assert.deepStrictEqual(grid.currents, [4, 5, 10]);
});

test('derives current from phase power when current is missing', () => {
  const grid = readGrid({
    measure_power: cap(2300),
    'measure_power.l1': cap(2300),
    'measure_power.l2': cap(-230),
    'measure_power.l3': cap(0),
  });
  assert.deepStrictEqual(grid.currents, [10, 1, 0]);
});

test('no currents when the meter has no phase data', () => {
  assert.deepStrictEqual(readGrid({ measure_power: cap(500) }), { power: 500, currents: null });
});

test('limits charge current to the busiest phase', () => {
  // House: L1 14.67 A, L2 0 A, L3 0 A → L1 leaves 25 - 2 - 14.67 = 8.33 A
  const limit = fuseLimit({
    fuse: 25, margin: 2,
    gridCurrents:    [20.67, 5.5, 5.29],
    chargerCurrents: [6, 6, 5.5],
    phases: 3,
  });
  assert.strictEqual(limit, 8);
});

test('single phase charging only looks at L1', () => {
  const limit = fuseLimit({
    fuse: 25, margin: 0,
    gridCurrents:    [10, 24, 24],
    chargerCurrents: [6, 0, 0],
    phases: 1,
  });
  assert.strictEqual(limit, 21);
});
