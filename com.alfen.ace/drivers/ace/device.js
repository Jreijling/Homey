'use strict';

const Homey = require('homey');
const { ModbusClient } = require('../../lib/ModbusClient');
const {
  METER_START, METER_COUNT, SCN_START, SCN_COUNT,
  REG_MAX_CURRENT, REG_CHARGE_PHASES,
  fromFloat32, parseMeter, parseSocket, mode3Status,
} = require('../../lib/AlfenReader');
const { readGrid, fuseLimit } = require('../../lib/LoadBalancer');

const MIN_CURRENT      = 6;     // below this the Alfen suspends charging
const DEFAULT_CURRENT  = 16;
const NOMINAL_VOLTAGE  = 230;
const REFRESH_BEFORE_S = 60;    // rewrite the setpoint before the charger falls back to safe current
const GRID_STALE_MS    = 5 * 60 * 1000;
const SOLAR_STOP_POLLS = 3;     // polls below minimum surplus before solar charging stops
const MAX_FAILURES     = 3;

const round = (value, decimals = 0) => {
  if (value === null || value === undefined) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

class AceDevice extends Homey.Device {

  async onInit() {
    this.log('Alfen ACE device init:', this.getName());

    this._failures     = 0;
    this._gridAt       = 0;
    this._solarLowRuns = 0;
    this._lastConnected = null;

    await this._migrateCapabilities();
    await this._initDefaults();

    this.registerCapabilityListener('evcharger_charging', value => this._onChargingToggle(value));
    this.registerCapabilityListener('max_current', value => this.setMaxCurrent(value));
    this.registerCapabilityListener('charge_phases', value => this.setChargePhases(value));
    this.registerCapabilityListener('solar_mode', value => this.setSolarMode(value));
    this.registerCapabilityListener('solar_min_charge_kw', async () => this._schedulePoll(0));

    this._schedulePoll(0);
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.some(k => ['host', 'port', 'unit_id'].includes(k))) this._closeClient();
    this._schedulePoll(1000);
  }

  async onDeleted() {
    this._deleted = true;
    this.homey.clearTimeout(this._pollTimer);
    this._closeClient();
  }

  /** Adds capabilities introduced after this device was paired. */
  async _migrateCapabilities() {
    for (const cap of this.driver.manifest.capabilities) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(err => this.error(`add ${cap}:`, err.message));
      }
    }
  }

  async _initDefaults() {
    const defaults = {
      evcharger_charging:  true,
      max_current:         DEFAULT_CURRENT,
      solar_mode:          false,
      solar_mode_active:   false,
      solar_min_charge_kw: 1.4,
    };
    for (const [cap, value] of Object.entries(defaults)) {
      if (this.getCapabilityValue(cap) === null) await this._set(cap, value);
    }
  }

  // ─── Public (flow cards / capability listeners) ──────────────────────────

  async setMaxCurrent(current) {
    await this._set('max_current', Math.max(MIN_CURRENT, Math.round(current)));
    this._schedulePoll(0);
  }

  async setChargePhases(phases) {
    await this._client().writeSingleRegister(REG_CHARGE_PHASES, Number(phases) === 1 ? 1 : 3);
    await this._set('charge_phases', String(phases));
    this._schedulePoll(1000);
  }

  async setSolarMode(enabled) {
    this._solarLowRuns = 0;
    await this._set('solar_mode', enabled);
    if (!enabled) await this._set('solar_mode_active', false);
    this._schedulePoll(0);
  }

  async updateGridPower(power) {
    this._gridAt = Date.now();
    await this._set('grid_power', round(power));
  }

  async _onChargingToggle(value) {
    await this._set('evcharger_charging', value);
    this._schedulePoll(0);
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  _schedulePoll(delay) {
    if (this._deleted) return;
    this.homey.clearTimeout(this._pollTimer);
    this._pollTimer = this.homey.setTimeout(() => this._poll(), delay);
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;

    try {
      const client = this._client();
      const meter  = parseMeter(await client.readHoldingRegisters(METER_START, METER_COUNT));
      const socket = parseSocket(await client.readHoldingRegisters(SCN_START, SCN_COUNT));
      const grid   = await this._readEnergyMeter();

      await this._applyMeter(meter);
      await this._applySocket(socket);
      await this._applySetpoint(meter, socket, grid);

      this._failures = 0;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Poll failed:', err.message);
      this._closeClient();
      if (++this._failures >= MAX_FAILURES) {
        await this.setUnavailable(err.message).catch(this.error);
      }
    } finally {
      this._polling = false;
      this._schedulePoll(Math.max(5, Number(this.getSetting('poll_interval')) || 10) * 1000);
    }
  }

  async _applyMeter(meter) {
    const [l1, l2, l3] = meter.phases;

    await this._set('measure_power',      round(meter.totalPower));
    await this._set('charger_power_l1',   round(l1.power));
    await this._set('charger_power_l2',   round(l2.power));
    await this._set('charger_power_l3',   round(l3.power));
    await this._set('charger_voltage_l1', round(l1.voltage, 1));
    await this._set('charger_voltage_l2', round(l2.voltage, 1));
    await this._set('charger_voltage_l3', round(l3.voltage, 1));
    await this._set('charger_current_l1', round(l1.current, 1));
    await this._set('charger_current_l2', round(l2.current, 1));
    await this._set('charger_current_l3', round(l3.current, 1));
    await this._set('meter_active',       meter.meterActive);

    if (meter.energyKwh > 0) await this._set('meter_power', round(meter.energyKwh, 3));
  }

  async _applySocket(socket) {
    const { carConnected, charging } = mode3Status(socket.mode3State);
    const paused = carConnected && !charging;

    let state = 'plugged_out';
    if (charging) state = 'plugged_in_charging';
    else if (carConnected) state = this.getCapabilityValue('evcharger_charging') ? 'plugged_in' : 'plugged_in_paused';

    await this._set('evcharger_charging_state', state);
    await this._set('car_connected',            carConnected);
    await this._set('charging_paused',          paused);
    await this._set('actual_max_current',       round(socket.actualMaxCurrent, 1));
    await this._set('safe_current',             round(socket.safeCurrent, 1));
    await this._set('valid_time_remaining',     socket.validTime);
    if (socket.chargePhases === 1 || socket.chargePhases === 3) {
      await this._set('charge_phases', String(socket.chargePhases));
    }

    if (this._lastConnected !== null && this._lastConnected !== carConnected) {
      this.driver.triggerCarConnected(this, carConnected);
    }
    this._lastConnected = carConnected;
  }

  // ─── Energy meter (load balancing) ───────────────────────────────────────

  /**
   * Reads the energy meter set in the device settings. Returns null when no
   * meter is configured, { ok: false } when it cannot be read.
   */
  async _readEnergyMeter() {
    const id = (this.getSetting('meter_device_id') || '').trim();
    if (!id) return null;

    try {
      const api    = await this.homey.app.getHomeyApi();
      const device = await api.devices.getDevice({ id });
      const grid   = readGrid(device.capabilitiesObj);

      if (grid.power !== null) await this.updateGridPower(grid.power);
      if (!grid.currents) throw new Error(`${device.name} reports no current or power per phase`);

      this._logMeterError(null);
      return { ok: true, ...grid };
    } catch (err) {
      this._logMeterError(err.message);
      return { ok: false };
    }
  }

  _logMeterError(message) {
    if (message === this._meterError) return;
    this._meterError = message;
    if (message) this.error('Energy meter:', message);
    else this.log('Energy meter OK');
  }

  /**
   * Max current that keeps the main fuse safe, or null without a meter.
   * When the meter cannot be read, fall back to the charger's safe current.
   */
  async _balanceLimit(meter, socket, grid) {
    if (!grid) {
      await this._set('load_balance_limit', null);
      return null;
    }
    if (!grid.ok) return socket.safeCurrent ?? MIN_CURRENT;

    const limit = fuseLimit({
      fuse:            Number(this.getSetting('main_fuse')) || 25,
      margin:          Number(this.getSetting('fuse_margin')) || 0,
      gridCurrents:    grid.currents,
      chargerCurrents: meter.phases.map(p => p.current),
      phases:          socket.chargePhases === 1 ? 1 : 3,
    });
    await this._set('load_balance_limit', Math.max(0, limit));
    return limit;
  }

  // ─── Setpoint ─────────────────────────────────────────────────────────────

  async _applySetpoint(meter, socket, grid) {
    const target  = await this._targetCurrent(meter, socket, grid);
    const current = socket.modbusMaxCurrent;

    const changed = current === null || Math.abs(target - current) >= 0.5;
    const expiring = socket.validTime < REFRESH_BEFORE_S;
    if (!changed && !expiring) return;

    if (changed) this.log(`Setpoint ${current} A → ${target} A`);
    await this._client().writeMultipleRegisters(REG_MAX_CURRENT, fromFloat32(target));
  }

  async _targetCurrent(meter, socket, grid) {
    const limit     = await this._balanceLimit(meter, socket, grid);
    const requested = await this._requestedCurrent(meter, socket);
    const target    = limit === null ? requested : Math.min(requested, limit);
    return target >= MIN_CURRENT ? target : 0;
  }

  /** Current asked for by the user or solar mode, before load balancing. */
  async _requestedCurrent(meter, socket) {
    if (!this.getCapabilityValue('evcharger_charging')) return 0;

    const maxCurrent = this.getCapabilityValue('max_current') || DEFAULT_CURRENT;
    if (!this.getCapabilityValue('solar_mode')) return maxCurrent;

    const amps = this._solarCurrent(meter, socket, maxCurrent);
    await this._set('solar_mode_active', amps > 0);
    return amps;
  }

  /**
   * Charge on surplus only: the power the charger may use is its own current
   * draw minus what is imported from the grid (grid_power, pushed by a flow).
   */
  _solarCurrent(meter, socket, maxCurrent) {
    if (Date.now() - this._gridAt > GRID_STALE_MS) {
      this._solarLowRuns = 0;
      return 0;
    }

    const phases  = socket.chargePhases === 1 ? 1 : 3;
    const wPerAmp = NOMINAL_VOLTAGE * phases;
    const surplus = meter.totalPower - this.getCapabilityValue('grid_power');
    const amps    = Math.floor(surplus / wPerAmp);
    const active  = this.getCapabilityValue('solar_mode_active');

    const startW = Math.max((this.getCapabilityValue('solar_min_charge_kw') || 0) * 1000, MIN_CURRENT * wPerAmp);
    if (!active && surplus < startW) return 0;

    if (amps < MIN_CURRENT) {
      // Keep charging at minimum for a few polls to ride out passing clouds
      if (active && ++this._solarLowRuns < SOLAR_STOP_POLLS) return MIN_CURRENT;
      this._solarLowRuns = 0;
      return 0;
    }

    this._solarLowRuns = 0;
    return Math.min(amps, maxCurrent);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _client() {
    if (!this._modbus) {
      this._modbus = new ModbusClient({
        host:   this.getSetting('host'),
        port:   Number(this.getSetting('port')) || 502,
        unitId: Number(this.getSetting('unit_id')) || 1,
      });
    }
    return this._modbus;
  }

  _closeClient() {
    if (this._modbus) this._modbus.close();
    this._modbus = null;
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap) || value === undefined || this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch(err => this.error(`set ${cap}:`, err.message));
  }
}

module.exports = AceDevice;
