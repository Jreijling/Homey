'use strict';

const Homey = require('homey');
const { AnkerSolixApi } = require('./lib/AnkerSolixApi');

const DEFAULT_POLL_INTERVAL_S = 60;
const MIN_POLL_INTERVAL_S     = 30;

class AnkerSolixApp extends Homey.App {

  async onInit() {
    this.log('Anker Solix starting...');

    this._api        = null;
    this._siteCache  = {};   // siteId → { site, sceneData }
    this._pollTimer  = null;

    // Re-initialise API when credentials change in settings
    this.homey.settings.on('set', async key => {
      if (['email', 'password', 'country'].includes(key)) {
        this.log(`Setting "${key}" changed – reconnecting`);
        await this._resetApi();
      }
    });

    // Register flow card handlers
    try {
      this._registerFlowCards();
    } catch (err) {
      this.error('Flow card registration failed:', err.message);
    }

    // Boot
    await this._initApi();
    this._schedulePoll(0); // immediate first poll
  }

  // ─── API lifecycle ────────────────────────────────────────────────────────

  async _initApi() {
    const email    = this.homey.settings.get('email');
    const password = this.homey.settings.get('password');
    const country  = this.homey.settings.get('country') || 'NL';

    if (!email || !password) {
      this.log('No credentials – configure in app settings');
      return;
    }

    this._api = new AnkerSolixApi({
      email, password, country,
      log:   (...a) => this.log(...a),
      error: (...a) => this.error(...a),
    });

    try {
      await this._api.authenticate();
    } catch (err) {
      this.error('Authentication failed:', err.message);
      this._api = null;
    }
  }

  async _resetApi() {
    this._cancelPoll();
    this._api       = null;
    this._siteCache = {};
    await this._initApi();
    this._schedulePoll(0);
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  _pollIntervalMs() {
    const s = Number(this.homey.settings.get('poll_interval') || DEFAULT_POLL_INTERVAL_S);
    return Math.max(MIN_POLL_INTERVAL_S, s) * 1000;
  }

  _cancelPoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _schedulePoll(delayMs) {
    this._cancelPoll();
    this._pollTimer = setTimeout(async () => {
      await this._poll();
      this._schedulePoll(this._pollIntervalMs());
    }, delayMs ?? this._pollIntervalMs());
  }

  async _poll() {
    if (!this._api) return;

    try {
      const sites = await this._api.getSiteList();

      for (const site of sites) {
        const sceneData = await this._api.getSceneInfo(site.site_id);
        this._siteCache[site.site_id] = { site, sceneData };
      }

      this.log(`Poll complete – ${sites.length} site(s) updated`);
      this.homey.emit('anker_solix_update', this._siteCache);

    } catch (err) {
      this.error('Poll error:', err.message);
    }
  }

  // ─── Public helpers for drivers/devices ──────────────────────────────────

  getApi() {
    return this._api;
  }

  getSiteCache() {
    return this._siteCache;
  }

  /**
   * Manually trigger an immediate poll (called by devices after a write).
   */
  async refreshNow() {
    this._cancelPoll();
    await this._poll();
    this._schedulePoll(this._pollIntervalMs());
  }

  /**
   * Authenticate with given credentials, save to settings, and reset.
   * Used by the pair flow to validate credentials before listing devices.
   */
  async loginAndSave(email, password, country) {
    const api = new AnkerSolixApi({
      email, password, country,
      log:   (...a) => this.log(...a),
      error: (...a) => this.error(...a),
    });
    await api.authenticate(); // throws on failure

    this.homey.settings.set('email',    email);
    this.homey.settings.set('password', password);
    this.homey.settings.set('country',  country.toUpperCase());

    // Switch to new API without waiting for the settings event
    this._cancelPoll();
    this._api = api;
    this._schedulePoll(0);
  }

  // ─── Flow cards ───────────────────────────────────────────────────────────

  _registerFlowCards() {
    // Conditions (device cards — have a "device" argument)
    this.homey.flow.getDeviceConditionCard('battery_soc_above')
      .registerRunListener(({ device, soc }) => {
        const current = device.getCapabilityValue('measure_battery') ?? 0;
        return current > soc;
      });

    this.homey.flow.getDeviceConditionCard('solar_power_above')
      .registerRunListener(({ device, watts }) => {
        const current = device.getCapabilityValue('solar_power') ?? 0;
        return current > watts;
      });

    this.homey.flow.getDeviceConditionCard('grid_importing')
      .registerRunListener(({ device }) => {
        return (device.getCapabilityValue('grid_import_power') ?? 0) > 0;
      });

    // Actions (device cards — have a "device" argument)
    this.homey.flow.getDeviceActionCard('set_output_preset')
      .registerRunListener(async ({ device, watts }) => {
        await device.setOutputPreset(watts);
      });

    this.homey.flow.getDeviceActionCard('set_grid_export')
      .registerRunListener(async ({ device, enabled }) => {
        await device.setGridExport(enabled === 'true');
      });
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────

  async onUninit() {
    this._cancelPoll();
    this.log('Anker Solix stopped');
  }
}

module.exports = AnkerSolixApp;
