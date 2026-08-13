'use strict';

const Homey = require('homey');
const { setGridChargePower, stopGridCharge } = require('../../lib/AnkerSolixModbusReader');

const p = v => parseFloat(v) || 0;

class SolarbankDevice extends Homey.Device {

  async onInit() {
    this.log('Solarbank device init:', this.getName());

    this._siteId   = this.getStoreValue('site_id');
    this._deviceSn = this.getStoreValue('device_sn');

    // Devices paired before these capabilities were added need them added explicitly.
    for (const cap of ['measure_power', 'meter_power.charged', 'meter_power.discharged', 'grid_charge_power']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(err => this.error(`addCapability ${cap}:`, err.message));
      }
    }

    // State for flow triggers
    this._wasCharging    = false;
    this._wasDischarging = false;

    // Register capability listeners for writable capabilities
    this.registerCapabilityListener('output_preset_power', v => this.setOutputPreset(v));
    this.registerCapabilityListener('battery_min_soc',     v => this._setMinSoc(v));
    this.registerCapabilityListener('grid_export_enabled', v => this.setGridExport(v));
    this.registerCapabilityListener('grid_charge_power',   v => this.setGridChargePower(v));

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
