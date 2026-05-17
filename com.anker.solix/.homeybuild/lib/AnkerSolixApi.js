'use strict';

const crypto = require('crypto');

// Anker's ECDH public key (EU and COM servers share the same key)
const ANKER_PUBLIC_KEY_HEX = '04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076';

const API_SERVERS = {
  eu: 'https://ankerpower-api-eu.anker.com',
  com: 'https://ankerpower-api.anker.com',
};

// Countries routed to COM server; all others default to EU
const COM_COUNTRIES = new Set([
  'DZ', 'LB', 'SY', 'EG', 'LY', 'TN', 'MA', 'JO', 'PS',
  'AR', 'AU', 'BR', 'HK', 'IN', 'JP', 'MX', 'NG', 'NZ',
  'RU', 'SG', 'ZA', 'KR', 'TW', 'US', 'CA', 'RO',
]);

const ENDPOINTS = {
  login:          'passport/login',
  siteList:       'power_service/v1/site/get_site_list',
  sceneInfo:      'power_service/v1/site/get_scen_info',
  siteDetail:     'power_service/v1/site/get_site_detail',
  userDevices:    'power_service/v1/site/list_user_devices',
  getDeviceParam: 'power_service/v1/site/get_site_device_param',
  setDeviceParam: 'power_service/v1/site/set_site_device_param',
  energyAnalysis: 'power_service/v1/site/energy_analysis',
  getDeviceAttrs: 'power_service/v1/app/device/get_device_attrs',
  setDeviceAttrs: 'power_service/v1/app/device/set_device_attrs',
  getPowerCutoff: 'power_service/v1/app/compatible/get_power_cutoff',
  setPowerCutoff: 'power_service/v1/app/compatible/set_power_cutoff',
};

// Schedule param types
const PARAM_TYPE_SCHEDULE    = 4;
const PARAM_TYPE_SCHEDULE_SB2 = 6;

class AnkerSolixApi {

  constructor({ email, password, country, log, error }) {
    this.email    = email;
    this.password = password;
    this.country  = (country || 'NL').toUpperCase();
    this.log      = log   || console.log;
    this.error    = error || console.error;

    this.server = COM_COUNTRIES.has(this.country)
      ? API_SERVERS.com
      : API_SERVERS.eu;

    // Auth state
    this.authToken   = null;
    this.gtoken      = null;
    this.tokenExpiry = null;
    this.loggedIn    = false;
    this.nickname    = '';

    // Rate limiting (250 ms minimum between requests)
    this._lastRequest = 0;
    this._delay       = 300;

    // Generate ECDH P-256 key pair once; compute shared secret with Anker's public key
    this._ecdh = crypto.createECDH('prime256v1');
    this._ecdh.generateKeys();
    this._sharedSecret = this._ecdh.computeSecret(Buffer.from(ANKER_PUBLIC_KEY_HEX, 'hex'));
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  _publicKeyHex() {
    return this._ecdh.getPublicKey('hex', 'uncompressed');
  }

  _encryptPassword(password) {
    // AES-256-CBC; key = shared secret (32 bytes), IV = first 16 bytes of shared secret
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      this._sharedSecret,
      this._sharedSecret.slice(0, 16),
    );
    return cipher.update(password, 'utf8', 'base64') + cipher.final('base64');
  }

  _timezoneString() {
    const off  = -new Date().getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const hh   = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
    const mm   = String(Math.abs(off) % 60).padStart(2, '0');
    return `GMT${sign}${hh}:${mm}`;
  }

  async _throttle() {
    const wait = this._delay - (Date.now() - this._lastRequest);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastRequest = Date.now();
  }

  async _request(endpoint, body = {}) {
    // Ensure authenticated before any non-login call
    if (endpoint !== ENDPOINTS.login && !this.loggedIn) {
      await this.authenticate();
    }

    await this._throttle();

    const headers = {
      'Content-Type': 'application/json',
      'model-type':   'DESKTOP',
      'app-name':     'anker_power',
      'os-type':      'android',
      'country':      this.country,
      'timezone':     this._timezoneString(),
    };

    if (this.authToken) {
      headers['x-auth-token'] = this.authToken;
      headers['gtoken']       = this.gtoken;
    }

    const url = `${this.server}/${endpoint}`;

    let res;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers,
        body:    JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Network error calling ${endpoint}: ${err.message}`);
    }

    // Re-auth on 401/403 (token kicked out by another session) — retry once
    if ((res.status === 401 || res.status === 403) && this.loggedIn) {
      this.loggedIn = false;
      await this.authenticate();
      return this._request(endpoint, body);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${endpoint}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(`Invalid JSON from ${endpoint}`);
    }

    if (data.code !== 0) {
      throw new Error(`API error ${data.code} (${endpoint}): ${data.msg}`);
    }

    return data;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async authenticate() {
    const tzOffsetMs = -new Date().getTimezoneOffset() * 60 * 1000;

    const data = await this._request(ENDPOINTS.login, {
      ab:                 this.country,
      client_secret_info: { public_key: this._publicKeyHex() },
      enc:                0,
      email:              this.email,
      password:           this._encryptPassword(this.password),
      time_zone:          tzOffsetMs,
      transaction:        String(Date.now()),
    });

    const d          = data.data;
    this.authToken   = d.auth_token;
    this.gtoken      = crypto.createHash('md5').update(d.user_id).digest('hex');
    this.tokenExpiry = d.token_expires_at;
    this.nickname    = d.nick_name || '';
    this.loggedIn    = true;

    this.log(`Authenticated as ${this.nickname || this.email} on ${this.server}`);
    return d;
  }

  async getSiteList() {
    const r = await this._request(ENDPOINTS.siteList);
    return r.data?.site_list || [];
  }

  async getSceneInfo(siteId) {
    const r = await this._request(ENDPOINTS.sceneInfo, { site_id: siteId });
    return r.data || {};
  }

  async getSiteDetail(siteId) {
    const r = await this._request(ENDPOINTS.siteDetail, { site_id: siteId });
    return r.data || {};
  }

  async getUserDevices(siteId) {
    const r = await this._request(ENDPOINTS.userDevices, { site_id: siteId });
    return r.data?.device_list || [];
  }

  // paramType: 4 = standard schedule, 6 = SB2+ extended schedule
  async getDeviceParam(siteId, deviceSn, paramType = PARAM_TYPE_SCHEDULE) {
    const r = await this._request(ENDPOINTS.getDeviceParam, {
      site_id:    siteId,
      device_sn:  deviceSn,
      param_type: paramType,
    });
    const raw = r.data?.param_data;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async setDeviceParam(siteId, deviceSn, paramType, schedule) {
    await this._request(ENDPOINTS.setDeviceParam, {
      site_id:    siteId,
      device_sn:  deviceSn,
      param_type: paramType,
      param_data: JSON.stringify(schedule),
    });
  }

  async getDeviceAttrs(deviceSn, attributes) {
    const r = await this._request(ENDPOINTS.getDeviceAttrs, {
      device_sn:  deviceSn,
      attributes,
    });
    return r.data?.attributes || {};
  }

  async setDeviceAttrs(deviceSn, attributes) {
    await this._request(ENDPOINTS.setDeviceAttrs, {
      device_sn:  deviceSn,
      attributes,
    });
  }

  async getPowerCutoff(siteId, deviceSn) {
    const r = await this._request(ENDPOINTS.getPowerCutoff, {
      site_id:   siteId,
      device_sn: deviceSn,
    });
    return r.data?.power_cutoff_data || [];
  }

  async setPowerCutoff(siteId, deviceSn, cutoffSoc) {
    await this._request(ENDPOINTS.setPowerCutoff, {
      site_id:    siteId,
      device_sn:  deviceSn,
      cutoff_soc: cutoffSoc,
    });
  }

  async getEnergyAnalysis(siteId, deviceSn, type, startTime, endTime) {
    const r = await this._request(ENDPOINTS.energyAnalysis, {
      site_id:    siteId,
      device_sn:  deviceSn,
      type,
      start_time: startTime,
      end_time:   endTime,
    });
    return r.data || {};
  }

  // ─── Schedule helpers ─────────────────────────────────────────────────────

  /**
   * Set output power target in the device schedule.
   * Updates both the per-device slot (SB2+) and the appliance slot (SB1).
   */
  async setOutputPower(siteId, deviceSn, watts) {
    // Try SB2 extended schedule first (param_type 6), fall back to type 4
    let paramType = PARAM_TYPE_SCHEDULE_SB2;
    let schedule  = await this.getDeviceParam(siteId, deviceSn, paramType);

    if (!schedule?.ranges) {
      paramType = PARAM_TYPE_SCHEDULE;
      schedule  = await this.getDeviceParam(siteId, deviceSn, paramType);
    }

    if (!schedule?.ranges) {
      throw new Error('No schedule data available for device ' + deviceSn);
    }

    for (const range of schedule.ranges) {
      // SB2+ per-device power loads
      const deviceSlot = (range.device_power_loads || []).find(d => d.device_sn === deviceSn);
      if (deviceSlot) {
        deviceSlot.power = watts;
      }
      // SB1 / site-wide appliance loads
      if (Array.isArray(range.appliance_loads) && range.appliance_loads.length > 0) {
        range.appliance_loads[0].power = watts;
      }
    }

    await this.setDeviceParam(siteId, deviceSn, paramType, schedule);
  }

  /**
   * Returns the currently selected minimum SOC (output cutoff) in %.
   */
  async getMinSoc(siteId, deviceSn) {
    const cutoffs = await this.getPowerCutoff(siteId, deviceSn);
    const selected = cutoffs.find(c => c.is_selected === 1);
    return selected ? selected.output_cutoff_data : null;
  }

  /**
   * Set the minimum SOC by selecting the closest available cutoff option.
   */
  async setMinSoc(siteId, deviceSn, percent) {
    const cutoffs = await this.getPowerCutoff(siteId, deviceSn);
    if (!cutoffs.length) throw new Error('No cutoff options for ' + deviceSn);

    const best = cutoffs.reduce((prev, curr) =>
      Math.abs(curr.output_cutoff_data - percent) < Math.abs(prev.output_cutoff_data - percent)
        ? curr : prev,
    );

    await this.setPowerCutoff(siteId, deviceSn, best.output_cutoff_data);
    return best.output_cutoff_data;
  }
}

module.exports = { AnkerSolixApi, PARAM_TYPE_SCHEDULE, PARAM_TYPE_SCHEDULE_SB2 };
