'use strict';

const Homey = require('homey');

class SmartMeterDriver extends Homey.Driver {

  async onInit() {
    this.log('Smart Meter driver ready');
  }

  async onPairListDevices() {
    const api = this.homey.app.getApi();
    if (!api) throw new Error(this.homey.__('errors.no_credentials'));

    const sites   = await api.getSiteList();
    const devices = [];

    for (const site of sites) {
      const sceneData = await api.getSceneInfo(site.site_id);
      const gridList  = sceneData.grid_info?.grid_list || [];

      for (const meter of gridList) {
        if (!meter.device_sn) continue;

        devices.push({
          name:  meter.device_name || `Smart Meter (${meter.device_sn})`,
          data:  { id: meter.device_sn },
          store: {
            site_id:   site.site_id,
            site_name: site.site_name,
            device_sn: meter.device_sn,
            device_pn: meter.device_pn || '',
          },
        });
      }
    }

    if (devices.length === 0) {
      throw new Error(this.homey.__('errors.no_smart_meters'));
    }

    return devices;
  }
}

module.exports = SmartMeterDriver;
