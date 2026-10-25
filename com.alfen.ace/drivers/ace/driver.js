'use strict';

const Homey = require('homey');
const { ModbusClient } = require('../../lib/ModbusClient');
const { SCN_START, SCN_COUNT, parseSocket } = require('../../lib/AlfenReader');

class AceDriver extends Homey.Driver {

  async onInit() {
    this._carConnected    = this.homey.flow.getDeviceTriggerCard('car_connected');
    this._carDisconnected = this.homey.flow.getDeviceTriggerCard('car_disconnected');
    this.log('Alfen ACE driver ready');
  }

  triggerCarConnected(device, connected) {
    const card = connected ? this._carConnected : this._carDisconnected;
    card.trigger(device).catch(err => this.error('trigger car connection:', err.message));
  }

  async onPair(session) {
    let found = null;

    session.setHandler('connect', async ({ host, port, unitId }) => {
      host = (host || '').trim();
      if (!host) throw new Error(this.homey.__('errors.no_host'));

      port   = Number(port) || 502;
      unitId = Number(unitId) || 1;

      const client = new ModbusClient({ host, port, unitId });
      try {
        const socket = parseSocket(await client.readHoldingRegisters(SCN_START, SCN_COUNT));
        this.log(`Pair: ${host} socket ${unitId} mode 3 state ${socket.mode3State}`);
      } catch (err) {
        throw new Error(this.homey.__('errors.connect_failed', { message: err.message }));
      } finally {
        client.close();
      }

      found = {
        name:     unitId > 1 ? `Alfen ACE Lader ${unitId}` : 'Alfen ACE Lader',
        data:     { id: `${host}:${unitId}` },
        settings: { host, port, unit_id: unitId },
      };
      return true;
    });

    session.setHandler('list_devices', async () => (found ? [found] : []));
  }
}

module.exports = AceDriver;
