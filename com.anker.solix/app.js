'use strict';

const Homey = require('homey');
const { AnkerSolixApi } = require('./lib/AnkerSolixApi');
const { readModbusSnapshot } = require('./lib/AnkerSolixModbusReader');
const AnkerSolixMqtt = require('./lib/AnkerSolixMqtt');

const DEFAULT_POLL_INTERVAL_S = 60;
const MIN_POLL_INTERVAL_S     = 30;
const MODBUS_POLL_INTERVAL_MS = 10000;
const MQTT_RETRY_MS           = 60000;

class AnkerSolixApp extends Homey.App {

  async onInit() {
    this.log('Anker Solix starting...');

    this._api          = null;
    this._siteCache    = {};   // siteId → { site, sceneData }
    this._pollTimer    = null;
    this._modbusTimer  = null;
    this._realtime     = null;   // AnkerSolixMqtt.RealtimeSession for smart meters
    this._realtimeKey  = '';
    this._realtimeRetry = null;

    // Re-initialise API when credentials change in settings
    this.homey.settings.on('set', async key => {
      if (['email', 'password', 'country'].includes(key)) {
        this.log(`Setting "${key}" changed – reconnecting`);
        await this._resetApi();
      }
      if (['connection_mode', 'modbus_ip', 'modbus_port'].includes(key)) {
        this.log(`Setting "${key}" changed – updating Modbus polling`);
        this._scheduleModbusPoll(0);
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
    this._scheduleModbusPoll(0);
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
    this._stopRealtime();
    this._api       = null;
    this._siteCache = {};
    await this._initApi();
    this._schedulePoll(0);
  }

  // ─── Modbus (local, real-time) ───────────────────────────────────────────

  _modbusEnabled() {
    return this.homey.settings.get('connection_mode') === 'modbus'
      && !!this.homey.settings.get('modbus_ip');
  }

  _cancelModbusPoll() {
    if (this._modbusTimer) {
      clearTimeout(this._modbusTimer);
      this._modbusTimer = null;
    }
  }

  _scheduleModbusPoll(delayMs) {
    this._cancelModbusPoll();
    if (!this._modbusEnabled()) return;

    this._modbusTimer = setTimeout(async () => {
      await this._pollModbus();
      this._scheduleModbusPoll(MODBUS_POLL_INTERVAL_MS);
    }, delayMs ?? MODBUS_POLL_INTERVAL_MS);
  }

  /**
   * Reads live values from the Solarbank over local Modbus TCP and overlays
   * them onto the cached site data (which is still populated via the cloud
   * for pairing/site discovery), then emits an update.
   */
  async _pollModbus() {
    if (!this._modbusEnabled()) return;

    const host = this.homey.settings.get('modbus_ip');
    const port = Number(this.homey.settings.get('modbus_port')) || 502;

    try {
      const snapshot = await readModbusSnapshot({ host, port });

      for (const { sceneData } of Object.values(this._siteCache)) {
        const device = sceneData?.solarbank_info?.solarbank_list?.[0];
        if (device) {
          device.photovoltaic_power  = String(snapshot.photovoltaic_power);
          device.bat_charge_power    = String(snapshot.bat_charge_power);
          device.bat_discharge_power = String(snapshot.bat_discharge_power);
          device.output_power        = String(snapshot.output_power);
          device.battery_power       = String(snapshot.battery_power);
          device.rated_energy_kwh        = snapshot.rated_energy_kwh;
          device.cumulative_charge_kwh   = snapshot.cumulative_charge_kwh;
          device.cumulative_discharge_kwh = snapshot.cumulative_discharge_kwh;
        }
        if (sceneData?.solarbank_info) {
          sceneData.solarbank_info.total_photovoltaic_power = String(snapshot.photovoltaic_power);
        }
        if (sceneData) {
          sceneData.home_load_power = String(snapshot.home_load_power);
        }
        if (sceneData?.grid_info) {
          sceneData.grid_info.grid_to_home_power         = String(snapshot.grid_to_home_power);
          sceneData.grid_info.photovoltaic_to_grid_power  = String(snapshot.photovoltaic_to_grid_power);
        }
      }

      this.log(`Modbus poll complete – pv=${snapshot.photovoltaic_power}W soc=${snapshot.battery_power}% charge=${snapshot.bat_charge_power}W discharge=${snapshot.bat_discharge_power}W load=${snapshot.home_load_power}W gridImport=${snapshot.grid_to_home_power}W gridExport=${snapshot.photovoltaic_to_grid_power}W`);
      this.homey.emit('anker_solix_update', this._siteCache);

    } catch (err) {
      this.error('Modbus poll error:', err.message);
    }
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

      this.refreshRealtime().catch(err => this.error('MQTT realtime start failed:', err.message));

      if (this._modbusEnabled()) {
        await this._pollModbus(); // overlays fresher local values + emits
      } else {
        this.homey.emit('anker_solix_update', this._siteCache);
      }

    } catch (err) {
      this.error('Poll error:', err.message);
    }
  }

  /**
   * Sets the grid export and AC input power limits via Anker's cloud MQTT
   * channel (the only way to reach these two settings — not available via
   * the REST schedule API or local Modbus). Wire format reverse-engineered
   * from a real command captured from the official Anker app.
   */
  async setPowerLimits(devicePn, deviceSn, { gridExportLimitW, acInputLimitW }) {
    const mqttInfo = await this._api.getMqttInfo();
    if (!mqttInfo.endpoint_addr) {
      throw new Error('No MQTT endpoint returned by Anker cloud (getMqttInfo)');
    }
    await AnkerSolixMqtt.setPowerLimits({
      mqttInfo, devicePn, deviceSn, gridExportLimitW, acInputLimitW,
    });
  }

  // ─── MQTT realtime telemetry (smart meters) ───────────────────────────────

  /**
   * (Re)starts the MQTT realtime session for all paired smart meters, so they
   * receive ~5 s updates plus cumulative import/export energy counters that
   * the REST API doesn't expose. No-op when the device set is unchanged.
   */
  async refreshRealtime() {
    if (!this._api || this._realtimeStarting) return;
    this._realtimeStarting = true;
    try {
      await this._startRealtime();
    } finally {
      this._realtimeStarting = false;
    }
  }

  async _startRealtime() {

    const devices = this.homey.drivers.getDriver('smart-meter').getDevices()
      .map(d => ({ deviceSn: d.getStoreValue('device_sn'), devicePn: d.getStoreValue('device_pn') }))
      .filter(d => d.deviceSn && d.devicePn);

    const key = devices.map(d => `${d.devicePn}/${d.deviceSn}`).sort().join(',');
    if (this._realtime && key === this._realtimeKey) return;

    this._stopRealtime();
    if (devices.length === 0) return;

    const mqttInfo = await this._api.getMqttInfo();
    if (!mqttInfo.endpoint_addr) throw new Error('No MQTT endpoint returned by Anker cloud');

    this._realtimeKey = key;
    this._realtime = new AnkerSolixMqtt.RealtimeSession({
      mqttInfo,
      devices,
      log:    (...a) => this.log(...a),
      error:  (...a) => this.error(...a),
      onData: (deviceSn, devicePn, msgType, fields) => {
        this.homey.emit('anker_solix_mqtt', { deviceSn, devicePn, msgType, fields });
      },
      onClose: () => {
        this.log(`MQTT realtime closed – retrying in ${MQTT_RETRY_MS / 1000}s`);
        this._realtime = null;
        this._realtimeRetry = this.homey.setTimeout(() => {
          this._realtimeRetry = null;
          this.refreshRealtime().catch(err => this.error('MQTT realtime restart failed:', err.message));
        }, MQTT_RETRY_MS);
      },
    });
    this._realtime.start();
  }

  _stopRealtime() {
    if (this._realtimeRetry) {
      this.homey.clearTimeout(this._realtimeRetry);
      this._realtimeRetry = null;
    }
    if (this._realtime) {
      this._realtime.stop();
      this._realtime = null;
    }
    this._realtimeKey = '';
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
    this._stopRealtime();
    this._api = api;
    this._schedulePoll(0);
  }

  // ─── Flow cards ───────────────────────────────────────────────────────────

  _registerFlowCards() {
    // Conditions (device cards — have a "device" argument)
    this.homey.flow.getConditionCard('battery_soc_above')
      .registerRunListener(({ device, soc }) => {
        const current = device.getCapabilityValue('measure_battery') ?? 0;
        return current > soc;
      });

    this.homey.flow.getConditionCard('solar_power_above')
      .registerRunListener(({ device, watts }) => {
        const current = device.getCapabilityValue('solar_power') ?? 0;
        return current > watts;
      });

    this.homey.flow.getConditionCard('grid_importing')
      .registerRunListener(({ device }) => {
        return (device.getCapabilityValue('grid_import_power') ?? 0) > 0;
      });

    // Actions (device cards — have a "device" argument)
    this.homey.flow.getActionCard('set_output_preset')
      .registerRunListener(async ({ device, watts }) => {
        await device.setOutputPreset(watts);
      });

    this.homey.flow.getActionCard('set_grid_export')
      .registerRunListener(async ({ device, enabled }) => {
        await device.setGridExport(enabled === 'true');
      });
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────

  async onUninit() {
    this._cancelPoll();
    this._cancelModbusPoll();
    this._stopRealtime();
    this.log('Anker Solix stopped');
  }
}

module.exports = AnkerSolixApp;
