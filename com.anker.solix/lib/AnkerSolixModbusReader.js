'use strict';

const { ModbusClient, toInt32, toUint32 } = require('./ModbusClient');

// Register map for Anker SOLIX Solarbank Max AC (product code DMWH/DMXU/E25H),
// taken from Anker's official Home Assistant integration
// (github.com/anker-charging/ha-anker-solix-official) device config for this model.
// Word order is big-endian (registers[0] = high 16 bits).
const REG_BLOCK_1_START = 10002;
const REG_BLOCK_1_COUNT = 13; // covers 10002..10014

// Covers ac_grid_output_power (10208-10209), rated_energy (10250-10251) and
// cumulative_charge/discharge_energy (10262-10265) in one request.
const REG_BLOCK_2_START = 10208;
const REG_BLOCK_2_COUNT = 10265 - REG_BLOCK_2_START + 1;

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
    const block2 = await client.readInputRegisters(REG_BLOCK_2_START, REG_BLOCK_2_COUNT);

    const at1 = offset => block1.slice(offset, offset + 2); // 2 registers -> INT32/UINT32
    const at2 = offset => block2.slice(offset, offset + 2);

    const pvPower           = toInt32(at1(10002 - REG_BLOCK_1_START));
    const thirdPartyPvPower = toInt32(at1(10004 - REG_BLOCK_1_START));
    const batteryPowerRaw   = toInt32(at1(10008 - REG_BLOCK_1_START));
    const loadPower         = toInt32(at1(10010 - REG_BLOCK_1_START));
    const gridPowerRaw      = toInt32(at1(10012 - REG_BLOCK_1_START));
    const batterySoc        = block1[10014 - REG_BLOCK_1_START];
    const acGridOutputPower = toInt32(at2(10208 - REG_BLOCK_2_START));
    // gain 10: raw register value is kWh * 10
    const ratedEnergy        = toUint32(at2(10250 - REG_BLOCK_2_START)) / 10;
    const cumulativeCharge   = toUint32(at2(10262 - REG_BLOCK_2_START)) / 10;
    const cumulativeDischarge = toUint32(at2(10264 - REG_BLOCK_2_START)) / 10;

    return {
      photovoltaic_power:    pvPower + thirdPartyPvPower,
      battery_power:         batterySoc,
      bat_charge_power:      batteryPowerRaw < 0 ? -batteryPowerRaw : 0,
      bat_discharge_power:   batteryPowerRaw > 0 ? batteryPowerRaw : 0,
      output_power:          acGridOutputPower,
      home_load_power:       loadPower,
      grid_to_home_power:    gridPowerRaw > 0 ? gridPowerRaw : 0,
      photovoltaic_to_grid_power: gridPowerRaw < 0 ? -gridPowerRaw : 0,
      rated_energy_kwh:       ratedEnergy,
      cumulative_charge_kwh:  cumulativeCharge,
      cumulative_discharge_kwh: cumulativeDischarge,
    };
  } finally {
    client.close();
  }
}

module.exports = { readModbusSnapshot };
