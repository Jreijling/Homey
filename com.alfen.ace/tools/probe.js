'use strict';

// Reads the Alfen registers once, outside Homey, to test the Modbus connection.
// Usage: node tools/probe.js <ip> [port] [unit id]

const { ModbusClient } = require('../lib/ModbusClient');
const {
  METER_START, METER_COUNT, SCN_START, SCN_COUNT, toFloat32, parseMeter, parseSocket,
} = require('../lib/AlfenReader');

// Raw power-related registers, to see which ones this charger/firmware fills.
const RAW_REGISTERS = [
  [306, 'Voltage L1 (V)'],
  [320, 'Current L1 (A)'],
  [322, 'Current L2 (A)'],
  [324, 'Current L3 (A)'],
  [326, 'Current sum (A)'],
  [334, 'Power factor sum'],
  [338, 'Real power L1 (W)'],
  [340, 'Real power L2 (W)'],
  [342, 'Real power L3 (W)'],
  [344, 'Real power sum (W)'],
  [346, 'Apparent power L1 (VA)'],
  [352, 'Apparent power sum (VA)'],
];

function printRaw(regs) {
  console.log('Raw registers:');
  for (const [reg, label] of RAW_REGISTERS) {
    const words = regs.slice(reg - METER_START, reg - METER_START + 2);
    const hex   = words.map(w => w.toString(16).padStart(4, '0')).join(' ');
    const value = toFloat32(words);
    console.log(`  ${reg}  ${label.padEnd(24)} ${hex}  ${Number.isFinite(value) ? value.toFixed(2) : value}`);
  }
}

async function main() {
  const [host, port = '502', unitId = '1'] = process.argv.slice(2);
  if (!host) {
    console.log('Usage: node tools/probe.js <ip> [port] [unit id]');
    process.exit(1);
  }

  const client = new ModbusClient({ host, port: Number(port), unitId: Number(unitId) });
  try {
    console.log(`Connecting to ${host}:${port} (unit id ${unitId})...`);
    await client.connect();
    console.log('TCP connection OK');

    const socket = parseSocket(await client.readHoldingRegisters(SCN_START, SCN_COUNT));
    console.log('Socket:', socket);

    const regs = await client.readHoldingRegisters(METER_START, METER_COUNT);
    printRaw(regs);

    const meter = parseMeter(regs);
    console.log('Meter:', JSON.stringify(meter, null, 2));
  } catch (err) {
    console.log('FAILED:', err.code || '', err.message);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

main();
