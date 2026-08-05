'use strict';

const net = require('net');

const FUNCTION_READ_HOLDING   = 0x03;
const FUNCTION_READ_INPUT     = 0x04;
const FUNCTION_WRITE_SINGLE   = 0x06;
const FUNCTION_WRITE_MULTIPLE = 0x10;

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Minimal Modbus TCP client (MBAP framing) — reads/writes 16-bit registers
 * over a raw net.Socket. No third-party dependency.
 */
class ModbusClient {

  constructor({ host, port = 502, unitId = 1 }) {
    this.host   = host;
    this.port   = port;
    this.unitId = unitId;

    this._socket    = null;
    this._buffer    = Buffer.alloc(0);
    this._nextTxId  = 1;
    this._pending   = new Map(); // txId -> { resolve, reject, timer }
  }

  connect() {
    if (this._socket) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(REQUEST_TIMEOUT_MS);

      socket.once('error', err => {
        this._teardown(err);
        reject(err);
      });
      socket.once('timeout', () => {
        const err = new Error(`Modbus connect timeout to ${this.host}:${this.port}`);
        socket.destroy();
        this._teardown(err);
        reject(err);
      });
      socket.connect(this.port, this.host, () => {
        this._socket = socket;
        socket.removeAllListeners('error');
        socket.removeAllListeners('timeout');
        socket.on('data', chunk => this._onData(chunk));
        socket.on('error', err => this._teardown(err));
        socket.on('close', () => this._teardown(new Error('Modbus connection closed')));
        resolve();
      });
    });
  }

  close() {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
  }

  _teardown(err) {
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this._pending.clear();
  }

  async readInputRegisters(address, count) {
    return this._readRegisters(FUNCTION_READ_INPUT, address, count);
  }

  async readHoldingRegisters(address, count) {
    return this._readRegisters(FUNCTION_READ_HOLDING, address, count);
  }

  async writeSingleRegister(address, value) {
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(FUNCTION_WRITE_SINGLE, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(value & 0xFFFF, 3);
    await this._transact(pdu);
  }

  async writeMultipleRegisters(address, values) {
    const byteCount = values.length * 2;
    const pdu = Buffer.alloc(6 + byteCount);
    pdu.writeUInt8(FUNCTION_WRITE_MULTIPLE, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(values.length, 3);
    pdu.writeUInt8(byteCount, 5);
    values.forEach((v, i) => pdu.writeUInt16BE(v & 0xFFFF, 6 + i * 2));
    await this._transact(pdu);
  }

  async _readRegisters(functionCode, address, count) {
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(functionCode, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(count, 3);

    const responsePdu = await this._transact(pdu);
    // responsePdu: [functionCode, byteCount, ...registerBytes]
    const byteCount = responsePdu.readUInt8(1);
    const registers = [];
    for (let i = 0; i < byteCount / 2; i++) {
      registers.push(responsePdu.readUInt16BE(2 + i * 2));
    }
    return registers;
  }

  async _transact(pdu) {
    if (!this._socket) await this.connect();

    const txId = this._nextTxId;
    this._nextTxId = (this._nextTxId + 1) & 0xFFFF;

    const header = Buffer.alloc(7);
    header.writeUInt16BE(txId, 0);       // Transaction ID
    header.writeUInt16BE(0, 2);          // Protocol ID (Modbus = 0)
    header.writeUInt16BE(pdu.length + 1, 4); // Length = unitId + PDU
    header.writeUInt8(this.unitId, 6);   // Unit ID

    const frame = Buffer.concat([header, pdu]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(txId);
        reject(new Error(`Modbus request timeout (txId ${txId})`));
      }, REQUEST_TIMEOUT_MS);

      this._pending.set(txId, { resolve, reject, timer });
      this._socket.write(frame);
    });
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    while (this._buffer.length >= 7) {
      const txId   = this._buffer.readUInt16BE(0);
      const length = this._buffer.readUInt16BE(4);
      const frameLength = 6 + length;

      if (this._buffer.length < frameLength) return; // wait for more data

      const unitIdAndPdu = this._buffer.subarray(6, frameLength);
      this._buffer = this._buffer.subarray(frameLength);

      const pending = this._pending.get(txId);
      if (!pending) continue; // unexpected/late reply, ignore

      this._pending.delete(txId);
      clearTimeout(pending.timer);

      const pdu = unitIdAndPdu.subarray(1); // strip unit id
      const functionCode = pdu.readUInt8(0);

      if (functionCode & 0x80) {
        const exceptionCode = pdu.readUInt8(1);
        pending.reject(new Error(`Modbus exception 0x${exceptionCode.toString(16)} on function 0x${(functionCode & 0x7F).toString(16)}`));
      } else {
        pending.resolve(pdu);
      }
    }
  }
}

// ─── Register value decoding helpers ───────────────────────────────────────
// Anker Solix registers use big-endian word order: registers[0] = high 16
// bits, registers[1] = low 16 bits.

function toUint32(registers) {
  const [hi, lo] = registers;
  return ((hi & 0xFFFF) << 16 | (lo & 0xFFFF)) >>> 0;
}

function toInt32(registers) {
  const unsigned = toUint32(registers);
  return unsigned & 0x80000000 ? unsigned - 0x100000000 : unsigned;
}

module.exports = { ModbusClient, toUint32, toInt32 };
