'use strict';

const Homey = require('homey');

const p = v => parseFloat(v) || 0;

class SystemDevice extends Homey.Device {

  async onInit() {
    this.log('System device init:', this.getName());

    this._siteId = this.getStoreValue('site_id');

    this._onUpdate = this._onUpdate.bind(this);
    this.homey.on('anker_solix_update', this._onUpdate);

    const cache = this.homey.app.getSiteCache();
    if (Object.keys(cache).length > 0) this._onUpdate(cache);
  }

  // ─── Data update ──────────────────────────────────────────────────────────

  _onUpdate(siteCache) {
    const siteData = siteCache[this._siteId];
    if (!siteData) return;

    const { sceneData } = siteData;
    const sbInfo   = sceneData?.solarbank_info;
    const gridInfo = sceneData?.grid_info;

    // ── Solar production ──
    if (sbInfo) {
      this._set('solar_power', p(sbInfo.total_photovoltaic_power));

      // Average battery SOC across all connected Solarbanks
      const sbList = sbInfo.solarbank_list || [];
      if (sbList.length > 0) {
        const avgSoc = sbList.reduce((sum, sb) => sum + p(sb.battery_power), 0) / sbList.length;
        this._set('measure_battery', Math.round(avgSoc));
      }
    }

    // ── Grid ──
    if (gridInfo) {
      const importPower = p(gridInfo.grid_to_home_power);
      const exportPower = p(gridInfo.photovoltaic_to_grid_power);
      this._set('grid_import_power', importPower);
      this._set('grid_export_power', exportPower);
      this._set('measure_power',     importPower - exportPower); // net
    }

    // ── Home load ──
    if (sceneData?.home_load_power !== undefined) {
      this._set('home_load_power', p(sceneData.home_load_power));
    }

    // ── Today's solar production (kWh) from energy_details ──
    const today = sceneData?.energy_details?.today;
    if (today?.solar_production !== undefined) {
      this._set('meter_power.generated', p(today.solar_production));
    }
  }

  _set(cap, value) {
    this.setCapabilityValue(cap, value).catch(err => this.error(`set ${cap}:`, err.message));
  }

  // ─── Device events ────────────────────────────────────────────────────────

  async onAdded() {
    this.log('System added:', this.getName());
  }

  async onDeleted() {
    this.homey.removeListener('anker_solix_update', this._onUpdate);
    this.log('System deleted:', this.getName());
  }
}

module.exports = SystemDevice;
