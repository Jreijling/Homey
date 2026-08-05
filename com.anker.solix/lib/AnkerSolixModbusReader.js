'use strict';

const { ModbusClient, toInt32 } = require('./ModbusClient');

// Register map for Anker SOLIX Solarbank Max AC (product code DMWH/DMXU/E25H),
// taken from Anker's official Home Assistant integration
// (github.com/anker-charging/ha-anker-solix-official) device config for this model.
// Word order is big-endian (registers[0] = high 16 bits).
const REG_BLOCK_1_START = 10002;
const REG_BLOCK_1_COUNT = 13; // covers 10002..10014
const REG_AC_GRID_OUTPUT = 10208;

/**
 * Reads live power/battery data directly from a Solarbank Max AC over local
 * Modbus TCP, and returns it shaped like the fields our cloud polling code
 * already expects (see lib/AnkerSolixApi.js get_scen_info response), so it
 * can be merged straight into the cached site data.
 */
async function readModbusSnapshot({ host, port = 502 }) {
  const client = new ModbusClient({ host, port });

  try {
    const block1 = await client.readInputRegisters(REG_BLOCK_1_START, REG_BLOCK_1_COUNT);
    const acBlock = await client.readInputRegisters(REG_AC_GRID_OUTPUT, 2);

    const at = offset => block1.slice(offset, offset + 2); // 2 registers -> INT32

    const pvPower           = toInt32(at(10002 - REG_BLOCK_1_START));
    const thirdPartyPvPower = toInt32(at(10004 - REG_BLOCK_1_START));
    const batteryPowerRaw   = toInt32(at(10008 - REG_BLOCK_1_START));
    const loadPower         = toInt32(at(10010 - REG_BLOCK_1_START));
    const gridPowerRaw      = toInt32(at(10012 - REG_BLOCK_1_START));
    const batterySoc        = block1[10014 - REG_BLOCK_1_START];
    const acGridOutputPower = toInt32(acBlock);

    return {
      photovoltaic_power:    pvPower + thirdPartyPvPower,
      battery_power:         batterySoc,
      bat_charge_power:      batteryPowerRaw < 0 ? -batteryPowerRaw : 0,
      bat_discharge_power:   batteryPowerRaw > 0 ? batteryPowerRaw : 0,
      output_power:          acGridOutputPower,
      home_load_power:       loadPower,
      grid_to_home_power:    gridPowerRaw > 0 ? gridPowerRaw : 0,
      photovoltaic_to_grid_power: gridPowerRaw < 0 ? -gridPowerRaw : 0,
    };
  } finally {
    client.close();
  }
}

module.exports = { readModbusSnapshot };
