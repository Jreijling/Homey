'use strict';

// Alfen NG9xx (Eve Single / Double Pro-line, ACE) Modbus TCP register map.
// Socket registers live on unit id 1 (socket 2 = unit id 2). All multi-word
// values are big-endian: registers[0] holds the high 16 bits.

const METER_START = 300;
const METER_COUNT = 78; // 300 … 377

const SCN_START = 1200;
const SCN_COUNT = 16;   // 1200 … 1215

const REG_MAX_CURRENT  = 1210; // Modbus Slave Max Current (FLOAT32, RW)
const REG_CHARGE_PHASES = 1215; // Charge using 1 or 3 phases (UINT16, RW)

// Below this current a phase is considered idle, so a 0 W reading is genuine.
const MIN_ACTIVE_CURRENT = 0.5;

// ─── Decoding helpers ────────────────────────────────────────────────────────

function toFloat32(registers) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(registers[0] & 0xFFFF, 0);
  buf.writeUInt16BE(registers[1] & 0xFFFF, 2);
  return buf.readFloatBE(0);
}

function toFloat64(registers) {
  const buf = Buffer.alloc(8);
  registers.slice(0, 4).forEach((r, i) => buf.writeUInt16BE(r & 0xFFFF, i * 2));
  return buf.readDoubleBE(0);
}

function toUint32(registers) {
  const [hi, lo] = registers;
  return ((hi & 0xFFFF) << 16 | (lo & 0xFFFF)) >>> 0;
}

function toAscii(registers) {
  return registers
    .map(r => String.fromCharCode((r >> 8) & 0xFF, r & 0xFF))
    .join('')
    .replace(/\0/g, '')
    .trim();
}

function fromFloat32(value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

/** NaN / Infinity → null, so unsupported registers never show up as values. */
function finite(value) {
  return Number.isFinite(value) ? value : null;
}

// ─── Power ───────────────────────────────────────────────────────────────────

/**
 * Real power of one phase in W.
 *
 * Depending on firmware and meter type the Alfen reports 0 or NaN in the real
 * power registers (338-343) while current is flowing. In that case derive the
 * power from voltage × current × power factor, which the charger always fills.
 */
function phasePower({ power, voltage, current, powerFactor }) {
  const idle = current === null || Math.abs(current) < MIN_ACTIVE_CURRENT;

  if (power !== null && (Math.abs(power) >= 1 || idle)) return power;
  if (idle || voltage === null) return 0;

  const pf = powerFactor !== null && powerFactor > 0 && powerFactor <= 1 ? powerFactor : 1;
  return voltage * current * pf;
}

// ─── Block parsers ───────────────────────────────────────────────────────────

/** Parses holding registers 300-377 (energy meter). */
function parseMeter(regs) {
  const at  = reg => reg - METER_START;
  const f32 = reg => finite(toFloat32(regs.slice(at(reg), at(reg) + 2)));
  const f64 = reg => finite(toFloat64(regs.slice(at(reg), at(reg) + 4)));

  const phases = [0, 1, 2].map(n => {
    const phase = {
      voltage:     f32(306 + n * 2),
      current:     f32(320 + n * 2),
      powerFactor: f32(328 + n * 2),
      power:       f32(338 + n * 2),
    };
    return { ...phase, power: phasePower(phase) };
  });

  const energyWh = f64(374);
  const state    = regs[at(300)];

  return {
    // bit 0 = initialised, bit 1 = updated, bit 3 = error
    meterActive: (state & 0x03) !== 0 && (state & 0x08) === 0,
    phases,
    totalPower:  phases.reduce((sum, p) => sum + p.power, 0),
    energyKwh:   energyWh !== null ? energyWh / 1000 : null,
  };
}

/** Parses holding registers 1200-1215 (socket / load balancing). */
function parseSocket(regs) {
  const at  = reg => reg - SCN_START;
  const f32 = reg => finite(toFloat32(regs.slice(at(reg), at(reg) + 2)));

  return {
    available:        regs[at(1200)] === 1,
    mode3State:       toAscii(regs.slice(at(1201), at(1206))),
    actualMaxCurrent: f32(1206),
    validTime:        toUint32(regs.slice(at(1208), at(1210))),
    modbusMaxCurrent: f32(1210),
    safeCurrent:      f32(1212),
    chargePhases:     regs[at(1215)],
  };
}

/**
 * Mode 3 (IEC 61851) state → car connected / actively charging.
 * A = no car, B = car connected, C/D = car ready to charge; the suffix 2 means
 * the charger supplies power. E/F are error states.
 */
function mode3Status(state) {
  const letter = (state || '').charAt(0);
  return {
    carConnected: ['B', 'C', 'D'].includes(letter),
    charging:     state === 'C2' || state === 'D2',
  };
}

module.exports = {
  METER_START,
  METER_COUNT,
  SCN_START,
  SCN_COUNT,
  REG_MAX_CURRENT,
  REG_CHARGE_PHASES,
  toFloat32,
  toFloat64,
  fromFloat32,
  phasePower,
  parseMeter,
  parseSocket,
  mode3Status,
};
