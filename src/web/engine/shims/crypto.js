'use strict';

// crypto for the browser build. wire.js takes randomBytes from it, for operation IDs (uuidv7) and the handles of
// unsent messages (localId, which reads them as base64url); files.js takes randomBytes for the names of staged and
// downloading files and of view links, and createHash('sha256') for a file's digest, fed chunk by chunk as the file is
// read or downloaded and read out at once (digest is synchronous in Node). Web Crypto's digest is neither, so the
// SHA-256 here is FIPS 180-4 in plain JavaScript. The bytes come as a Buffer (shims/buffer.js).
const { Buffer } = require('./buffer');

// getRandomValues fills at most 65,536 bytes per call.
const CHUNK = 65536;

function randomBytes(size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('The "size" argument must be a whole number of bytes');
  const out = Buffer.alloc(size);
  for (let at = 0; at < size; at += CHUNK) globalThis.crypto.getRandomValues(out.subarray(at, Math.min(at + CHUNK, size)));
  return out;
}

// The first 32 bits of the fractional parts of the cube roots of the first 64 primes.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Uint32Array(64);
    // The bytes of a block not yet full.
    this.block = new Uint8Array(64);
    this.fill = 0;
    this.bytes = 0;
    this.done = false;
  }

  // Runs the compression function over the 64 bytes of data at offset.
  compress(data, offset) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this.h;
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let k = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += k;
  }

  // data: a string (as UTF-8, or in the named encoding Buffer.from takes) or bytes. Returns the hash, as Node's.
  update(data, encoding) {
    if (this.done) {
      const err = new Error('Digest already called');
      err.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw err;
    }
    let bytes;
    if (typeof data === 'string') bytes = Buffer.from(data, encoding);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else throw new TypeError('The "data" argument must be a string or bytes');
    this.bytes += bytes.length;
    let at = 0;
    if (this.fill) {
      const take = Math.min(64 - this.fill, bytes.length);
      this.block.set(bytes.subarray(0, take), this.fill);
      this.fill += take;
      at = take;
      if (this.fill < 64) return this;
      this.compress(this.block, 0);
      this.fill = 0;
    }
    for (; at + 64 <= bytes.length; at += 64) this.compress(bytes, at);
    if (at < bytes.length) {
      this.block.set(bytes.subarray(at), 0);
      this.fill = bytes.length - at;
    }
    return this;
  }

  // The digest as a Buffer, or in encoding (hex, base64, base64url).
  digest(encoding) {
    if (this.done) {
      const err = new Error('Digest already called');
      err.code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw err;
    }
    this.done = true;
    const bits = this.bytes * 8;
    const block = this.block;
    block[this.fill++] = 0x80;
    if (this.fill > 56) {
      block.fill(0, this.fill);
      this.compress(block, 0);
      this.fill = 0;
    }
    block.fill(0, this.fill);
    // The length in bits, big-endian in the last 8 bytes; a file is far under 2^53 bits.
    const high = Math.floor(bits / 0x100000000);
    const low = bits >>> 0;
    block[56] = high >>> 24;
    block[57] = (high >>> 16) & 0xff;
    block[58] = (high >>> 8) & 0xff;
    block[59] = high & 0xff;
    block[60] = low >>> 24;
    block[61] = (low >>> 16) & 0xff;
    block[62] = (low >>> 8) & 0xff;
    block[63] = low & 0xff;
    this.compress(block, 0);
    const out = Buffer.alloc(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = this.h[i] >>> 24;
      out[i * 4 + 1] = (this.h[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (this.h[i] >>> 8) & 0xff;
      out[i * 4 + 3] = this.h[i] & 0xff;
    }
    return encoding === undefined ? out : out.toString(encoding);
  }
}

function createHash(algorithm) {
  if (String(algorithm).toLowerCase() !== 'sha256') {
    const err = new Error(`Digest method not supported in the browser build: ${algorithm}`);
    err.code = 'ERR_CRYPTO_INVALID_DIGEST';
    throw err;
  }
  return new Sha256();
}

module.exports = { randomBytes, createHash };
