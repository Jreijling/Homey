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

module.exports = { connectListener, deviceTopic, buildLimitsCommand, setPowerLimits };
