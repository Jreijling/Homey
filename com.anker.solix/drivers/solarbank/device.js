'use strict';

const Homey = require('homey');
const { setGridChargePower, stopGridCharge, holdBatteryAtZero } = require('../../lib/AnkerSolixModbusReader');

const p = v => parseFloat(v) || 0;

class SolarbankDevice extends Homey.Device {

  async onInit() {
    this.log('Solarbank device init:', this.getName());

    this._siteId   = this.getStoreValue('site_id');
    this._deviceSn = this.getStoreValue('device_sn');

    // Devices paired before these capabilities were added need them added explicitly.
    for (const cap of ['measure_power', 'meter_power.charged', 'meter_power.discharged', 'grid_charge_power', 'grid_export_limit', 'ac_input_limit', 'battery_hold']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(err => this.error(`addCapability ${cap}:`, err.message));
      }
    }

    // Devices paired before the energy config was added to the manifest keep
    // their old (empty) energy object. Apply it explicitly so Homey Energy
    // recognises this device as a home battery with charged/discharged meters.
    try {
      await this.setEnergy({
        homeBattery: true,
        meterPowerImportedCapability: 'meter_power.charged',
        meterPowerExportedCapability: 'meter_power.discharged',
      });
    } catch (err) {
      this.error('setEnergy failed:', err.message);
    }

    // State for flow triggers
    this._wasCharging    = false;
    this._wasDischarging = false;

    // Register capability listeners for writable capabilities
    this.registerCapabilityListener('output_preset_power', v => this.setOutputPreset(v));
    this.registerCapabilityListener('battery_min_soc',     v => this._setMinSoc(v));
    this.registerCapabilityListener('grid_export_enabled', v => this.setGridExport(v));
    this.registerCapabilityListener('grid_charge_power',   v => this.setGridChargePower(v));
    this.registerCapabilityListener('battery_hold',        v => this.setBatteryHold(v));
    this.registerCapabilityListener('grid_export_limit',   v => this.setGridExportLimit(v));
    this.registerCapabilityListener('ac_input_limit',      v => this.setAcInputLimit(v));

    // Subscribe to poll results
    this._onUpdate = this._onUpdate.bind(this);
    this.homey.on('anker_solix_update', this._onUpdate);

    // Apply any already-cached data immediately
    const cache = this.homey.app.getSiteCache();
    if (Object.keys(cache).length > 0) this._onUpdate(cache);
  }

  // ─── Data update ──────────────────────────────────────────────────────────

  _onUpdate(siteCache) {
    const siteData = siteCache[this._siteId];
    if (!siteData) return;

    const { sceneData } = siteData;
    const sbInfo = sceneData?.solarbank_info;
    if (!sbInfo) return;

    const device = (sbInfo.solarbank_list || []).find(
      sb => sb.device_sn === this._deviceSn,
    );

    // ── Per-device values ──
    // Note: "charging_power"/"battery_discharge_power" stay at 0 for this
    // site topology (power_site_type 19) — the actual live values come
    // through "bat_charge_power"/"bat_discharge_power" instead.
    if (device) {
      this._set('measure_battery',      p(device.battery_power));
      this._set('solar_power',          p(device.photovoltaic_power));
      this._set('battery_charge_power', p(device.bat_charge_power ?? device.charging_power));
      this._set('ac_output_power',      p(device.output_power));

      if (device.set_load_power !== '') {
        this._set('output_preset_power', p(device.set_load_power));
      }

      // Only populated when reading over local Modbus TCP.
      if (device.cumulative_charge_kwh != null) {
        this._set('meter_power.charged', device.cumulative_charge_kwh);
      }
      if (device.cumulative_discharge_kwh != null) {
        this._set('meter_power.discharged', device.cumulative_discharge_kwh);
      }
    }

    // ── Site-level values from solarbank_info ──
    this._set('battery_discharge_power', p(device?.bat_discharge_power ?? sbInfo.battery_discharge_power));

    // ── Flow trigger logic ──
    const chargePower    = p(device?.bat_charge_power ?? device?.charging_power);
    const dischargePower = p(device?.bat_discharge_power ?? sbInfo.battery_discharge_power);

    // Homey Energy convention: positive = charging (consuming), negative = discharging.
    this._set('measure_power', chargePower - dischargePower);

    const isCharging    = chargePower    > 0;
    const isDischarging = dischargePower > 0;

    if (isCharging && !this._wasCharging) {
      this.homey.flow.getDeviceTriggerCard('solarbank_charging_started').trigger(this);
    }
    if (!isCharging && this._wasCharging) {
      this.homey.flow.getDeviceTriggerCard('solarbank_charging_stopped').trigger(this);
    }
    if (isDischarging && !this._wasDischarging) {
      this.homey.flow.getDeviceTriggerCard('solarbank_discharging_started').trigger(this);
    }

    this._wasCharging    = isCharging;
    this._wasDischarging = isDischarging;
  }

  _set(cap, value) {
    this.setCapabilityValue(cap, value).catch(err => this.error(`set ${cap}:`, err.message));
  }

  // ─── Controls (public – also called from flow actions) ───────────────────

  async setOutputPreset(watts) {
    const api = this.homey.app.getApi();
    if (!api) throw new Error('Not authenticated');

    await api.setOutputPower(this._siteId, this._deviceSn, watts);
    this._set('output_preset_power', watts);
    await this.homey.app.refreshNow();
  }

  async setGridExport(enabled) {
    const api = this.homey.app.getApi();
    if (!api) throw new Error('Not authenticated');

    // switch_0w = 1 means "0W switch ON" (no export); 0 = export allowed
    await api.setDeviceAttrs(this._deviceSn, { switch_0w: enabled ? 0 : 1 });
    this._set('grid_export_enabled', enabled);
    await this.homey.app.refreshNow();
  }

  /**
   * Forces grid charging via local Modbus TCP third-party control. Requires
   * Modbus mode to be enabled in app settings — there is no cloud equivalent.
   * Setting 0W returns the device to normal self-consumption behaviour.
   */
  async setGridChargePower(watts) {
    if (this.homey.settings.get('connection_mode') !== 'modbus') {
      throw new Error('Grid charge control requires Modbus mode (see app settings)');
    }

    const host = this.homey.settings.get('modbus_ip');
    const port = Number(this.homey.settings.get('modbus_port')) || 502;
    if (!host) throw new Error('No Modbus IP configured in app settings');

    if (watts > 0) {
      await setGridChargePower({ host, port, watts });
    } else {
      await stopGridCharge({ host, port });
    }

    this._set('grid_charge_power', watts);
  }

  /**
   * Holds the battery at 0W (neither charging nor discharging) by staying in
   * third-party-control mode with a 0 setpoint, instead of reverting fully to
   * self-consumption. Used to stop solar surplus from charging the battery
   * (e.g. during expensive price hours), letting it flow to the grid instead.
   * Disabling returns the device to normal self-consumption behaviour.
   */
  async setBatteryHold(enabled) {
    if (this.homey.settings.get('connection_mode') !== 'modbus') {
      throw new Error('Battery hold requires Modbus mode (see app settings)');
    }

    const host = this.homey.settings.get('modbus_ip');
    const port = Number(this.homey.settings.get('modbus_port')) || 502;
    if (!host) throw new Error('No Modbus IP configured in app settings');

    if (enabled) {
      await holdBatteryAtZero({ host, port });
    } else {
      await stopGridCharge({ host, port });
    }

    this._set('battery_hold', enabled);
  }

  /**
   * Grid export and AC input power limits share a single physical command
   * (message type 0080 on Anker's cloud MQTT channel) — both fields must be
   * sent together, or the unset one would get reset. When the other value
   * isn't known yet (never read or set), falls back to its capability max,
   * which matched the device's factory default when this was reverse-engineered.
   */
  async _setPowerLimits({ gridExportLimitW, acInputLimitW }) {
    const devicePn = this.getStoreValue('device_pn');
    if (!devicePn) throw new Error('No device_pn stored for this device');

    await this.homey.app.setPowerLimits(devicePn, this._deviceSn, { gridExportLimitW, acInputLimitW });
  }

  _otherLimitOrMax(cap) {
    // getCapabilityValue() throws rather than returning null for a
    // capability that has never had a value set (e.g. right after pairing).
    let value;
    try {
      value = this.getCapabilityValue(cap);
    } catch (err) {
      value = null;
    }
    if (Number.isFinite(value)) return value;
    try {
      return this.getCapabilityOptions(cap)?.max ?? 3500;
    } catch (err) {
      return 3500;
    }
  }

  async setGridExportLimit(watts) {
    await this._setPowerLimits({
      gridExportLimitW: watts,
      acInputLimitW: this._otherLimitOrMax('ac_input_limit'),
    });
    this._set('grid_export_limit', watts);
  }

  async setAcInputLimit(watts) {
    await this._setPowerLimits({
      gridExportLimitW: this._otherLimitOrMax('grid_export_limit'),
      acInputLimitW: watts,
    });
    this._set('ac_input_limit', watts);
  }

  async _setMinSoc(percent) {
    const api = this.homey.app.getApi();
    if (!api) throw new Error('Not authenticated');

    const actual = await api.setMinSoc(this._siteId, this._deviceSn, percent);
    this._set('battery_min_soc', actual);
    await this.homey.app.refreshNow();
  }

  // ─── Device events ────────────────────────────────────────────────────────

  async onAdded() {
    this.log('Solarbank added:', this.getName(), this._deviceSn);
  }

  async onDeleted() {
    this.homey.removeListener('anker_solix_update', this._onUpdate);
    this.log('Solarbank deleted:', this.getName());
  }

  async onSettings({ newSettings }) {
    // No device-level settings currently
  }
}

module.exports = SolarbankDevice;
