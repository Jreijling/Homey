'use strict';

const Homey = require('homey');
const { ModbusClient } = require('../../lib/ModbusClient');
const { SCN_START, SCN_COUNT, parseSocket } = require('../../lib/AlfenReader');
const { readGrid } = require('../../lib/LoadBalancer');

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
      this.log(`Pair: connecting to ${host}:${port} socket ${unitId}`);

      const client = new ModbusClient({ host, port, unitId });
      try {
        const socket = parseSocket(await client.readHoldingRegisters(SCN_START, SCN_COUNT));
        this.log(`Pair: ${host} socket ${unitId} mode 3 state ${socket.mode3State}`);
      } catch (err) {
        this.error(`Pair: ${host}:${port} failed:`, err.message);
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

  /** Repair: pick the energy meter used for load balancing from a list. */
  async onRepair(session, device) {
    session.setHandler('list_meters', async () => {
      const api     = await this.homey.app.getHomeyApi();
      const devices = Object.values(await api.devices.getDevices());

      const meters = devices
        .filter(d => readGrid(d.capabilitiesObj).currents)
        .map(d => ({ id: d.id, name: d.name, zone: d.zoneName || '' }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return { meters, selected: device.getSetting('meter_device_id') || '' };
    });

    session.setHandler('select_meter', async ({ id }) => {
      await device.setSettings({ meter_device_id: id || '' });
      return true;
    });
  }
}

module.exports = AceDriver;
