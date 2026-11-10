'use strict';

// Reads the Alfen registers once, outside Homey, to test the Modbus connection.
// Usage: node tools/probe.js <ip> [port] [unit id]

const { ModbusClient } = require('../lib/ModbusClient');
const {
  METER_START, METER_COUNT, SCN_START, SCN_COUNT, parseMeter, parseSocket,
} = require('../lib/AlfenReader');

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

    const meter = parseMeter(await client.readHoldingRegisters(METER_START, METER_COUNT));
    console.log('Meter:', JSON.stringify(meter, null, 2));
  } catch (err) {
    console.log('FAILED:', err.code || '', err.message);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

main();
