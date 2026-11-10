'use strict';

const Homey = require('homey');

// All Solarbank product numbers (SB1 → Solarbank Max AC)
const SOLARBANK_PNS = new Set([
  'A17C0', // Solarbank E1600
  'A17C1', // Solarbank 2 E1600 Pro
  'A17C2', // Solarbank 2 E1600 AC
  'A17C3', // Solarbank 2 E1600 Plus
  'A17C5', // Solarbank 3 E2700 Pro
  'A17E2', // Solarbank Max AC
]);

class SolarbankDriver extends Homey.Driver {

  async onInit() {
    this.log('Solarbank driver ready');
  }

  /**
   * Called by Homey when the user adds a Solarbank device.
   * Credentials must be configured in app settings beforehand.
   */
  async onPairListDevices() {
    const api = this.homey.app.getApi();
    if (!api) {
      throw new Error(this.homey.__('errors.no_credentials'));
    }

    const sites   = await api.getSiteList();
    const devices = [];

    for (const site of sites) {
      const sceneData = await api.getSceneInfo(site.site_id);
      const sbList    = sceneData.solarbank_info?.solarbank_list || [];

      for (const sb of sbList) {
        if (!sb.device_sn) continue;
        // Accept any known Solarbank model; also accept unknown pn (empty string from
        // newer firmware that hasn't been catalogued yet)
        if (sb.device_pn && !SOLARBANK_PNS.has(sb.device_pn)) continue;

        devices.push({
          name:  sb.alias_name || sb.device_name || `Solarbank (${sb.device_sn})`,
          data:  { id: sb.device_sn },
          store: {
            site_id:   site.site_id,
            site_name: site.site_name || '',
            device_sn: sb.device_sn,
            device_pn: sb.device_pn || '',
          },
        });
      }
    }

    if (devices.length === 0) {
      throw new Error(this.homey.__('errors.no_solarbanks'));
    }

    return devices;
  }
}

module.exports = SolarbankDriver;
