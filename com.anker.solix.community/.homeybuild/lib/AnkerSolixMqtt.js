'use strict';

const mqtt = require('mqtt');
const crypto = require('crypto');

// Message type "0080" ("solarbank command group") carries the AC input and
// grid export power limits for the Solarbank Max AC (device_pn A17E2).
// Reverse-engineered by capturing a real command from the official Anker
// app over this same MQTT channel (field offsets/types are specific to this
// device_pn; other Solarbank models use a differently-shaped 0080 message).
const MSG_TYPE_LIMITS = Buffer.from([0x00, 0x80]);

/**
 * Connects to Anker's cloud MQTT command channel using the mutual-TLS
 * client certificates returned by AnkerSolixApi.getMqttInfo(). Anker's own
 * app uses this channel for a handful of settings not reachable via the
 * REST schedule API or local Modbus (e.g. max grid input/export power).
 */
function connectListener({ mqttInfo, onMessage, onError, onConnect }) {
  const client = mqtt.connect({
    host: mqttInfo.endpoint_addr,
    port: 8883,
    protocol: 'mqtts',
    cert: mqttInfo.certificate_pem,
    key: mqttInfo.private_key,
    ca: mqttInfo.aws_root_ca1_pem,
    clientId: `${mqttInfo.thing_name}_${Math.floor(Math.random() * 99999)}`,
    protocolVersion: 4,
    reconnectPeriod: 0,
    connectTimeout: 15000,
  });

  client.on('connect', () => onConnect?.(client));
  if (onMessage) client.on('message', (topic, payload) => onMessage(topic, payload));
  client.on('error', err => onError?.(err));

  return client;
}

function deviceTopic(mqttInfo, devicePn, deviceSn, publish = false) {
  return `${publish ? 'cmd' : 'dt'}/${mqttInfo.app_name}/${devicePn}/${deviceSn}/#`;
}

// ─── Binary command encoding (device_pn A17E2, message type 0080) ─────────

function tlvField(id, typeByte, valueBytes) {
  return Buffer.concat([Buffer.from([id, 1 + valueBytes.length, typeByte]), valueBytes]);
}

function uint16le(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(Math.round(value));
  return buf;
}

/**
 * Builds the binary payload for setting the grid export power limit (field
 * a2) and AC input power limit (field a3) in one command. Anker's own app
 * always sends both fields together, even when the user only changes one —
 * so both current values must be supplied to avoid resetting the other.
 */
function buildLimitsCommand({ gridExportLimitW, acInputLimitW, timestampSec }) {
  const fields = Buffer.concat([
    Buffer.from([0xa1, 0x01, 0x22]), // fixed pattern field, always present
    tlvField(0xa2, 0x02, uint16le(gridExportLimitW)),
    tlvField(0xa3, 0x02, uint16le(acInputLimitW)),
    tlvField(0xfe, 0x03, (() => {
      const ts = Buffer.alloc(4);
      ts.writeUInt32LE(timestampSec ?? Math.floor(Date.now() / 1000));
      return ts;
    })()),
  ]);

  const totalLength = 9 + fields.length + 1; // header + fields + checksum byte
  const header = Buffer.alloc(9);
  header[0] = 0xff;
  header[1] = 0x09;
  header.writeUInt16LE(totalLength, 2);
  header[4] = 0x03;
  header[5] = 0x00;
  header[6] = 0x0f;
  MSG_TYPE_LIMITS.copy(header, 7);

  const withoutChecksum = Buffer.concat([header, fields]);
  let xor = 0;
  for (const b of withoutChecksum) xor ^= b;

  return Buffer.concat([withoutChecksum, Buffer.from([xor])]);
}

/**
 * Publishes a single command to set the grid export and AC input power
 * limits, then closes the connection. Connects fresh per call — this is a
 * rare, user-initiated write, not a persistent channel like polling.
 */
async function setPowerLimits({ mqttInfo, devicePn, deviceSn, gridExportLimitW, acInputLimitW }) {
  return new Promise((resolve, reject) => {
    const client = connectListener({
      mqttInfo,
      onConnect: () => {
        const topic = `cmd/${mqttInfo.app_name}/${devicePn}/${deviceSn}/req`;
        const data = buildLimitsCommand({ gridExportLimitW, acInputLimitW });

        const message = JSON.stringify({
          head: {
            version: '1.0.0.1',
            client_id: 'cloud',
            sess_id: crypto.randomBytes(16).toString('hex'),
            cmd: 17,
            cmd_status: 2,
            msg_seq: 1,
            sign_code: 0,
            seed: '',
            timestamp: Math.floor(Date.now() / 1000),
          },
          payload: JSON.stringify({
            data: data.toString('base64'),
            account_id: mqttInfo.user_id,
            device_sn: deviceSn,
          }),
        });

        client.publish(topic, message, { qos: 1 }, err => {
          client.end(true);
          if (err) reject(err); else resolve();
        });
      },
      onError: err => {
        client.end(true);
        reject(err);
      },
    });

    setTimeout(() => {
      client.end(true);
      reject(new Error('MQTT publish timed out'));
    }, 15000);
  });
}

// ─── Generic binary message framing ────────────────────────────────────────

/**
 * Wraps TLV fields into a complete command message: ff09 header, 2-byte LE
 * length (incl. checksum), fixed send pattern 03 00 0f, message type, fields
 * and a trailing XOR checksum byte.
 */
function frameCommand(msgType, fields) {
  const totalLength = 9 + fields.length + 1;
  const header = Buffer.alloc(9);
  header[0] = 0xff;
  header[1] = 0x09;
  header.writeUInt16LE(totalLength, 2);
  header[4] = 0x03;
  header[5] = 0x00;
  header[6] = 0x0f;
  msgType.copy(header, 7);

  const withoutChecksum = Buffer.concat([header, fields]);
  let xor = 0;
  for (const b of withoutChecksum) xor ^= b;

  return Buffer.concat([withoutChecksum, Buffer.from([xor])]);
}

function uint32le(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Math.round(value));
  return buf;
}

/**
 * Builds the "0057" realtime trigger command. Devices only push their ~5 s
 * telemetry messages (e.g. 0425 for the P1 Meter) for `timeoutSec` after
 * receiving this, so it must be re-sent before the timeout expires.
 */
function buildRealtimeTrigger({ timeoutSec = 60, timestampSec } = {}) {
  const fields = Buffer.concat([
    Buffer.from([0xa1, 0x01, 0x22]),             // fixed pattern field
    Buffer.from([0xa2, 0x02, 0x01, 0x01]),       // enable realtime = 1
    tlvField(0xa3, 0x03, uint32le(timeoutSec)),  // timeout in seconds
    tlvField(0xfe, 0x03, uint32le(timestampSec ?? Math.floor(Date.now() / 1000))),
  ]);
  return frameCommand(Buffer.from([0x00, 0x57]), fields);
}

function decodeValue(type, value) {
  switch (type) {
    case 0x00: return value.toString('utf8').replace(/[^\x20-\x7e]/g, '');
    case 0x01: return value.length >= 1 ? value.readUInt8(0) : null;
    case 0x02: return value.length >= 2 ? value.readInt16LE(0) : null;
    case 0x03: return value.length >= 4 ? value.readInt32LE(0) : null;
    case 0x05: return value.length >= 4 ? value.readFloatLE(0) : null;
    default:   return null;
  }
}

/**
 * Parses a binary device message (ff09 framing) into its message type and a
 * map of field id (e.g. "a8") → decoded value. Mirrors DeviceHexData in the
 * ha-anker-solix integration, limited to the field types used by meters.
 */
function parseMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0x09) return null;

  const length  = Math.min(buf.readUInt16LE(2), buf.length);
  const msgType = buf.subarray(7, 9).toString('hex');

  // Optional increment byte: present when byte 9 isn't a field id a0..a9
  let i = (buf[9] >= 0xa0 && buf[9] <= 0xa9) ? 9 : 10;
  const end = length - 1; // last byte is the XOR checksum
  const fields = {};

  while (i + 2 <= end) {
    const id  = buf[i];
    const len = buf[i + 1];
    if (len === 0 || i + 2 + len > end) break;

    const raw = buf.subarray(i + 2, i + 2 + len);
    let value;
    if (len > 1 && raw[0] < 0x10) {
      value = decodeValue(raw[0], raw.subarray(1));
    } else {
      value = len === 1 ? raw[0] : raw.toString('hex');
    }
    fields[id.toString(16)] = value;
    i += 2 + len;
  }

  return { msgType, fields };
}

/**
 * Long-lived MQTT session that keeps realtime telemetry flowing for a set of
 * devices: subscribes to their data topics and re-sends the realtime trigger
 * before it times out. Calls `onData(deviceSn, devicePn, msgType, fields)`
 * for every decoded binary message.
 */
class RealtimeSession {

  constructor({ mqttInfo, devices, onData, onClose, log, error, timeoutSec = 60 }) {
    this._mqttInfo   = mqttInfo;
    this._devices    = devices; // [{ deviceSn, devicePn }]
    this._onData     = onData;
    this._onClose    = onClose;
    this._log        = log || (() => {});
    this._error      = error || (() => {});
    this._timeoutSec = timeoutSec;
    this._timer      = null;
    this._client     = null;
    this._closed     = false;
  }

  start() {
    this._client = connectListener({
      mqttInfo:  this._mqttInfo,
      onConnect: client => {
        this._log(`MQTT realtime connected – ${this._devices.length} device(s)`);
        for (const { deviceSn, devicePn } of this._devices) {
          client.subscribe(deviceTopic(this._mqttInfo, devicePn, deviceSn), { qos: 1 });
        }
        this._trigger();
        this._timer = setInterval(() => this._trigger(), (this._timeoutSec - 10) * 1000);
      },
      onMessage: (topic, payload) => this._handleMessage(topic, payload),
      onError:   err => this._error('MQTT realtime error:', err.message),
    });

    this._client.on('close', () => this._shutdown());
  }

  stop() {
    this._closed = true;
    this._shutdown();
  }

  _shutdown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._client) {
      const client = this._client;
      this._client = null;
      client.removeAllListeners('close');
      client.end(true);
      if (!this._closed) this._onClose?.();
    }
  }

  _trigger() {
    if (!this._client) return;
    for (const { deviceSn, devicePn } of this._devices) {
      const message = JSON.stringify({
        head: {
          version: '1.0.0.1',
          client_id: 'cloud',
          sess_id: crypto.randomBytes(16).toString('hex'),
          cmd: 17,
          cmd_status: 2,
          msg_seq: 1,
          sign_code: 0,
          seed: '',
          timestamp: Math.floor(Date.now() / 1000),
        },
        payload: JSON.stringify({
          data: buildRealtimeTrigger({ timeoutSec: this._timeoutSec }).toString('base64'),
          account_id: this._mqttInfo.user_id,
          device_sn: deviceSn,
        }),
      });
      this._client.publish(`cmd/${this._mqttInfo.app_name}/${devicePn}/${deviceSn}/req`, message, { qos: 1 }, err => {
        if (err) this._error(`MQTT realtime trigger ${deviceSn}:`, err.message);
      });
    }
  }

  _handleMessage(topic, raw) {
    try {
      const message = JSON.parse(raw.toString());
      const payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload;
      if (!payload?.data) return;

      const [, , devicePn, deviceSn] = topic.split('/');
      const parsed = parseMessage(Buffer.from(payload.data, 'base64'));
      if (parsed) this._onData(payload.sn || deviceSn, payload.pn || devicePn, parsed.msgType, parsed.fields);
    } catch (err) {
      this._error('MQTT realtime message decode failed:', err.message);
    }
  }
}

module.exports = {
  connectListener, deviceTopic, buildLimitsCommand, setPowerLimits,
  buildRealtimeTrigger, parseMessage, RealtimeSession,
};
