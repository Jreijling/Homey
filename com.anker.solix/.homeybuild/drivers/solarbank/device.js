'use strict';

const Homey = require('homey');

const p = v => parseFloat(v) || 0;

class SolarbankDevice extends Homey.Device {

  async onInit() {
    this.log('Solarbank device init:', this.getName());

    this._siteId   = this.getStoreValue('site_id');
    this._deviceSn = this.getStoreValue('device_sn');

    // State for flow triggers
    this._wasCharging    = false;
    this._wasDischarging = false;

    // Register capability listeners for writable capabilities
    this.registerCapabilityListener('output_preset_power', v => this.setOutputPreset(v));
    this.registerCapabilityListener('battery_min_soc',     v => this._setMinSoc(v));
    this.registerCapabilityListener('grid_export_enabled', v => this.setGridExport(v));

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
    if (device) {
      this._set('measure_battery',     p(device.battery_power));
      this._set('solar_power',         p(device.photovoltaic_power));
      this._set('battery_charge_power', p(device.charging_power));
      this._set('ac_output_power',      p(device.output_power));

      if (device.set_load_power !== '') {
        this._set('output_preset_power', p(device.set_load_power));
      }
    }

    // ── Site-level values from solarbank_info ──
    this._set('battery_discharge_power', p(sbInfo.battery_discharge_power));

    // ── Flow trigger logic ──
    const chargePower    = p(device?.charging_power);
    const dischargePower = p(sbInfo.battery_discharge_power);

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
