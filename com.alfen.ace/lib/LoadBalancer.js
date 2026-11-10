'use strict';

// Keeps house + charger below the main fuse, using a Homey energy meter
// (P1 dongle) as the source of the per-phase grid current.

const NOMINAL_VOLTAGE = 230;

function capValue(capabilitiesObj, pattern) {
  const key = Object.keys(capabilitiesObj || {}).find(k => pattern.test(k));
  const value = key ? capabilitiesObj[key].value : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads grid power and per-phase current from a meter's capabilitiesObj.
 * Capability names differ per app (measure_current.l1 vs measure_current.L1);
 * a missing current is derived from the phase power.
 */
function readGrid(capabilitiesObj) {
  const power = capValue(capabilitiesObj, /^measure_power$/);

  const currents = [1, 2, 3].map(n => {
    const current = capValue(capabilitiesObj, new RegExp(`^measure_current\\.l${n}$`, 'i'));
    if (current !== null) return Math.abs(current);

    const phasePower = capValue(capabilitiesObj, new RegExp(`^measure_power\\.l${n}$`, 'i'));
    if (phasePower === null) return null;
    const voltage = capValue(capabilitiesObj, new RegExp(`^measure_voltage\\.l${n}$`, 'i')) || NOMINAL_VOLTAGE;
    return Math.abs(phasePower) / voltage;
  });

  return {
    power,
    currents: currents.every(c => c !== null) ? currents : null,
  };
}

/**
 * Highest charge current (A) that keeps every phase the charger uses below
 * fuse - margin. The charger's own draw is subtracted from the grid current
 * to get the house load.
 */
function fuseLimit({ fuse, margin, gridCurrents, chargerCurrents, phases }) {
  const used = phases === 1 ? [0] : [0, 1, 2];
  const room = used.map(n => {
    const house = Math.max(0, gridCurrents[n] - (chargerCurrents[n] || 0));
    return fuse - margin - house;
  });
  return Math.floor(Math.min(...room));
}

module.exports = { readGrid, fuseLimit };
