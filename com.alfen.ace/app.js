'use strict';

const Homey = require('homey');

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
}

module.exports = AlfenApp;
