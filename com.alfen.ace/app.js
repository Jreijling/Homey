'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

class AlfenApp extends Homey.App {

  async onInit() {
    const device = args => args.device;

    this.homey.flow.getActionCard('set_max_current')
      .registerRunListener(args => device(args).setMaxCurrent(args.current));

    this.homey.flow.getActionCard('set_charge_phases')
      .registerRunListener(args => device(args).setChargePhases(args.phases));

    this.homey.flow.getActionCard('set_solar_mode')
      .registerRunListener(args => device(args).setSolarMode(args.state === 'on'));

    this.homey.flow.getActionCard('update_grid_power')
      .registerRunListener(args => device(args).updateGridPower(args.power));

    this.log('Alfen ACE app ready');
  }

  /** Homey Web API, used to read the energy meter chosen for load balancing. */
  async getHomeyApi() {
    if (!this._homeyApi) {
      this._homeyApi = HomeyAPI.createAppAPI({ homey: this.homey }).catch(err => {
        this._homeyApi = null;
        throw err;
      });
    }
    return this._homeyApi;
  }
}

module.exports = AlfenApp;
