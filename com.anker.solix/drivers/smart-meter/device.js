'use strict';

const Homey = require('homey');

const p = v => parseFloat(v) || 0;

// REST values are skipped while MQTT realtime data is fresher than this
const MQTT_FRESH_MS = 30000;

/**
 * MQTT realtime field mapping per device model and message type, taken from
 * mqttmap.py in the ha-anker-solix integration. Entries are [field, factor].
 * Energy counters are converted to kWh.
 */
const MQTT_MAP = {
  // Anker SOLIX P1 Meter – energy fields verified against a HomeWizard P1 on
  // the same meter (HA's mqttmap has aa/ab swapped and a 0.001 factor)
  AE1R0: {
    '0425': { importW: ['a8', 1], exportW: ['a9', 1], importKwh: ['aa', 0.01], exportKwh: ['ab', 0.01] },
  },
  // Anker 3-phase Smart Meter
  A17X7: {
    '0405': { importW: ['a8', 1], exportW: ['a9', 1], importKwh: ['aa', 0.01], exportKwh: ['ab', 0.01] },
  },
  // Shelly Pro 3EM via Anker
  SHEMP3: {
    '0405': { importW: ['a8', 0.01], exportW: ['a9', 0.01], importKwh: ['aa', 0.00001], exportKwh: ['ab', 0.00001] },
  },
};

const ENERGY_CUMULATIVE = {
  cumulative: true,
  cumulativeImportedCapability: 'meter_power.imported',
  cumulativeExportedCapability: 'meter_power.exported',
};

class SmartMeterDevice extends Homey.Device {

  async onInit() {
    this.log('Smart Meter device init:', this.getName());

    this._siteId   = this.getStoreValue('site_id');
    this._deviceSn = this.getStoreValue('device_sn');

    // State for flow triggers
    this._wasImporting = false;
    this._wasExporting = false;

    this._lastMqttAt   = 0;
    this._loggedTypes  = new Set();

    await this._migrateCapabilities();
    await this._applyEnergySetting(this.getSetting('main_meter'));

    this._onUpdate = this._onUpdate.bind(this);
    this._onMqtt   = this._onMqtt.bind(this);
    this.homey.on('anker_solix_update', this._onUpdate);
    this.homey.on('anker_solix_mqtt', this._onMqtt);

    const cache = this.homey.app.getSiteCache();
    if (Object.keys(cache).length > 0) this._onUpdate(cache);

    this.homey.app.refreshRealtime().catch(err => this.error('MQTT realtime start failed:', err.message));
  }

  /** Adds capabilities introduced after this device was paired. */
  async _migrateCapabilities() {
    for (const cap of this.driver.manifest.capabilities) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(err => this.error(`add ${cap}:`, err.message));
      }
    }
  }

  async _applyEnergySetting(cumulative) {
    if (typeof this.setEnergy !== 'function') return;
    await this.setEnergy(cumulative === false ? {} : ENERGY_CUMULATIVE)
      .catch(err => this.error('setEnergy:', err.message));
  }

  // ─── Cloud REST update (every poll) ───────────────────────────────────────

  _onUpdate(siteCache) {
    const siteData = siteCache[this._siteId];
    if (!siteData) return;

    const gridInfo = siteData.sceneData?.grid_info;
    if (!gridInfo) return;

    this._updateDevicePn(gridInfo.grid_list || []);

    if (Date.now() - this._lastMqttAt < MQTT_FRESH_MS) return;

    this._applyPower(p(gridInfo.grid_to_home_power), p(gridInfo.photovoltaic_to_grid_power));
  }

  /** Older pairings may lack device_pn, which MQTT topics require. */
  _updateDevicePn(gridList) {
    const meter = gridList.find(m => m.device_sn === this._deviceSn);
    if (meter?.device_pn && meter.device_pn !== this.getStoreValue('device_pn')) {
      this.setStoreValue('device_pn', meter.device_pn)
        .then(() => this.homey.app.refreshRealtime())
        .catch(err => this.error('update device_pn:', err.message));
    }
  }

  // ─── MQTT realtime update (~5 s) ──────────────────────────────────────────

  _onMqtt({ deviceSn, devicePn, msgType, fields }) {
    if (deviceSn !== this._deviceSn) return;

    if (!this._loggedTypes.has(msgType)) {
      this._loggedTypes.add(msgType);
      this.log(`MQTT ${devicePn} msg ${msgType}:`, JSON.stringify(fields));
    }

    const map = MQTT_MAP[devicePn]?.[msgType];
    if (!map) return;

    const get = ([field, factor]) => (typeof fields[field] === 'number' ? fields[field] * factor : null);

    const importW = get(map.importW);
    const exportW = get(map.exportW);
    if (importW !== null && exportW !== null) {
      this._lastMqttAt = Date.now();
      this._applyPower(Math.max(0, importW), Math.max(0, exportW));
    }

    const importKwh = get(map.importKwh);
    const exportKwh = get(map.exportKwh);
    if (importKwh > 0 && exportKwh > 0) this._applyEnergy(importKwh, exportKwh);
  }

  // ─── Capability updates ───────────────────────────────────────────────────

  _applyPower(importPower, exportPower) {
    // Net grid power: positive = importing, negative = exporting
    this._set('measure_power',     importPower - exportPower);
    this._set('grid_import_power', importPower);
    this._set('grid_export_power', exportPower);

    // Flow triggers
    const isImporting = importPower > 0;
    const isExporting = exportPower > 0;

    if (isImporting && !this._wasImporting) {
      this.homey.flow.getDeviceTriggerCard('grid_import_started').trigger(this).catch(this.error);
    }
    if (isExporting && !this._wasExporting) {
      this.homey.flow.getDeviceTriggerCard('grid_export_started').trigger(this).catch(this.error);
    }

    this._wasImporting = isImporting;
    this._wasExporting = isExporting;
  }

  _applyEnergy(importKwh, exportKwh) {
    const round = v => Math.round(v * 1000) / 1000;

    this._set('meter_power.imported', round(importKwh));
    this._set('meter_power.exported', round(exportKwh));

    // Daily counters: delta against the counter values at local midnight
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: this.homey.clock.getTimezone() });
    let start = this.getStoreValue('day_start_kwh');
    if (!start || start.date !== today) {
      start = { date: today, imported: importKwh, exported: exportKwh };
      this.setStoreValue('day_start_kwh', start).catch(err => this.error('store day_start_kwh:', err.message));
    }

    this._set('meter_power.imported_today', round(Math.max(0, importKwh - start.imported)));
    this._set('meter_power.exported_today', round(Math.max(0, exportKwh - start.exported)));
  }

  _set(cap, value) {
    if (!this.hasCapability(cap) || this.getCapabilityValue(cap) === value) return;
    this.setCapabilityValue(cap, value).catch(err => this.error(`set ${cap}:`, err.message));
  }

  // ─── Device events ────────────────────────────────────────────────────────

  async onSettings({ changedKeys, newSettings }) {
    if (changedKeys.includes('main_meter')) {
      await this._applyEnergySetting(newSettings.main_meter);
    }
  }

  async onAdded() {
    this.log('Smart Meter added:', this.getName());
  }

  async onDeleted() {
    this.homey.removeListener('anker_solix_update', this._onUpdate);
    this.homey.removeListener('anker_solix_mqtt', this._onMqtt);
    this.homey.app.refreshRealtime().catch(err => this.error('MQTT realtime refresh failed:', err.message));
    this.log('Smart Meter deleted:', this.getName());
  }
}

module.exports = SmartMeterDevice;
