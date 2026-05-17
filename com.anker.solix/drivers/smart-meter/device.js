'use strict';

const Homey = require('homey');

const p = v => parseFloat(v) || 0;

class SmartMeterDevice extends Homey.Device {

  async onInit() {
    this.log('Smart Meter device init:', this.getName());

    this._siteId   = this.getStoreValue('site_id');
    this._deviceSn = this.getStoreValue('device_sn');

    // State for flow triggers
    this._wasImporting = false;
    this._wasExporting = false;

    this._onUpdate = this._onUpdate.bind(this);
    this.homey.on('anker_solix_update', this._onUpdate);

    const cache = this.homey.app.getSiteCache();
    if (Object.keys(cache).length > 0) this._onUpdate(cache);
  }

  // ─── Data update ──────────────────────────────────────────────────────────

  _onUpdate(siteCache) {
    const siteData = siteCache[this._siteId];
    if (!siteData) return;

    const gridInfo = siteData.sceneData?.grid_info;
    if (!gridInfo) return;

    const importPower = p(gridInfo.grid_to_home_power);
    const exportPower = p(gridInfo.photovoltaic_to_grid_power);

    // Net grid power: positive = importing, negative = exporting
    const netPower = importPower - exportPower;

    this._set('measure_power',      netPower);
    this._set('grid_import_power',  importPower);
    this._set('grid_export_power',  exportPower);

    // Flow triggers
    const isImporting = importPower > 0;
    const isExporting = exportPower > 0;

    if (isImporting && !this._wasImporting) {
      this.homey.flow.getDeviceTriggerCard('grid_import_started').trigger(this);
    }
    if (isExporting && !this._wasExporting) {
      this.homey.flow.getDeviceTriggerCard('grid_export_started').trigger(this);
    }

    this._wasImporting = isImporting;
    this._wasExporting = isExporting;
  }

  _set(cap, value) {
    this.setCapabilityValue(cap, value).catch(err => this.error(`set ${cap}:`, err.message));
  }

  // ─── Device events ────────────────────────────────────────────────────────

  async onAdded() {
    this.log('Smart Meter added:', this.getName());
  }

  async onDeleted() {
    this.homey.removeListener('anker_solix_update', this._onUpdate);
    this.log('Smart Meter deleted:', this.getName());
  }
}

module.exports = SmartMeterDevice;
