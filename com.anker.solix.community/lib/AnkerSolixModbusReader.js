'use strict';

const { ModbusClient, toInt32, toUint32, fromInt32 } = require('./ModbusClient');

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

// Write-side registers for third-party control (see Anker's official
// register map — write_quantities.operating_mode and
// control_items.battery_power_setpoint / write_quantities.battery_power_direction,
// which both target the same physical register: sign = direction, magnitude = watts).
const REG_OPERATING_MODE          = 10064;
const REG_BATTERY_POWER_SETPOINT  = 10071;
const OPERATING_MODE_SELF_CONSUMPTION = 0;
const OPERATING_MODE_THIRD_PARTY_CONTROL = 3;

/**
 * Forces the battery to charge from the grid at the given wattage by
 * switching to third-party-control mode and writing a negative power
 * setpoint (negative = charge, mirroring the read-side sign convention
 * for register 10008).
 */
async function setGridChargePower({ host, port = 502, watts }) {
  const client = new ModbusClient({ host, port });
  try {
    await client.writeSingleRegister(REG_OPERATING_MODE, OPERATING_MODE_THIRD_PARTY_CONTROL);
    await client.writeMultipleRegisters(REG_BATTERY_POWER_SETPOINT, fromInt32(-Math.abs(watts)));
  } finally {
    client.close();
  }
}

/**
 * Clears any third-party power setpoint and returns the device to normal
 * self-consumption behaviour.
 */
async function stopGridCharge({ host, port = 502 }) {
  const client = new ModbusClient({ host, port });
  try {
    await client.writeMultipleRegisters(REG_BATTERY_POWER_SETPOINT, fromInt32(0));
    await client.writeSingleRegister(REG_OPERATING_MODE, OPERATING_MODE_SELF_CONSUMPTION);
  } finally {
    client.close();
  }
}

/**
 * Holds the battery at 0W by staying in third-party-control mode with a 0
 * setpoint, rather than reverting to self-consumption (stopGridCharge).
 * Unlike self-consumption, this should stop the battery from absorbing
 * solar surplus or covering load from its own charge — both flow through
 * the grid connection instead while the hold is active.
 */
async function holdBatteryAtZero({ host, port = 502 }) {
  const client = new ModbusClient({ host, port });
  try {
    await client.writeSingleRegister(REG_OPERATING_MODE, OPERATING_MODE_THIRD_PARTY_CONTROL);
    // A literal 0 setpoint is treated by the firmware as a "no override"
    // sentinel and falls straight back to self-consumption (verified live:
    // discharge kept tracking load exactly). A 1W setpoint is honoured as a
    // real override — verified live to hold discharge at 0W regardless of
    // load, sustained over a load range of 900W-2800W.
    await client.writeMultipleRegisters(REG_BATTERY_POWER_SETPOINT, fromInt32(1));
  } finally {
    client.close();
  }
}

/**
 * Sets a signed battery power setpoint using the Homey target_power
 * convention: positive = charge, negative = discharge, 0 = hold at 0W.
 * The register uses the opposite sign (negative = charge), and a literal 0
 * would fall back to self-consumption, so 0 is written as 1W (see
 * holdBatteryAtZero).
 */
async function setBatteryPower({ host, port = 502, watts }) {
  const w = Math.round(watts);
  const registerValue = w === 0 ? 1 : -w;
  const client = new ModbusClient({ host, port });
  try {
    await client.writeSingleRegister(REG_OPERATING_MODE, OPERATING_MODE_THIRD_PARTY_CONTROL);
    await client.writeMultipleRegisters(REG_BATTERY_POWER_SETPOINT, fromInt32(registerValue));
  } finally {
    client.close();
  }
}

module.exports = {
  readModbusSnapshot, setGridChargePower, stopGridCharge, holdBatteryAtZero, setBatteryPower,
};
