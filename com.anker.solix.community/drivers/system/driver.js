'use strict';

const Homey = require('homey');

class SystemDriver extends Homey.Driver {

  async onInit() {
    this.log('System driver ready');
  }

  async onPairListDevices() {
    const api = this.homey.app.getApi();
    if (!api) throw new Error(this.homey.__('errors.no_credentials'));

    const sites = await api.getSiteList();

    if (sites.length === 0) {
      throw new Error(this.homey.__('errors.no_sites'));
    }

    return sites.map(site => ({
      name:  site.site_name || `Power System (${site.site_id})`,
      data:  { id: site.site_id },
      store: {
        site_id:   site.site_id,
        site_name: site.site_name || '',
      },
    }));
  }
}

module.exports = SystemDriver;
