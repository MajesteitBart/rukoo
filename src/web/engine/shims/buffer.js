// Node's Buffer for the browser build, as far as the bundled chat code uses it: wire.js (mentionRule, uuidv7, localId
// through shims/crypto.js), notify.js (alertText) and files.js (image headers, the answer of a transfer, a GIF's
// thumbnail). esbuild's inject puts it in place of every free Buffer, so those files run unchanged. It is ESM because
// inject only takes the named exports of an ES module.
//
// A Uint8Array underneath: indexing, length and subarray (which keeps the class) are the platform's own.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function unknownEncoding(encoding) {
  const err = new TypeError(`Unknown encoding: ${encoding}`);
  err.code = 'ERR_UNKNOWN_ENCODING';
  return err;
}

function outOfRange(offset) {
  const err = new RangeError(`The value of "offset" is out of range. Received ${offset}`);
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

const isUtf8 = (encoding) => encoding === undefined || encoding === 'utf8' || encoding === 'utf-8';
const isLatin1 = (encoding) => encoding === 'latin1' || encoding === 'binary';

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class Buffer extends Uint8Array {
  // from(string, 'utf8') or from(bytes): a copy, as Node's.
  static from(value, encoding) {
    if (typeof value === 'string') {
      if (!isUtf8(encoding)) throw unknownEncoding(encoding);
      const bytes = encoder.encode(value);
      return new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (value instanceof ArrayBuffer) return new Buffer(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Buffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (value && typeof value.length === 'number') return new Buffer(Array.from(value));
    throw new TypeError('The first argument must be a string, an ArrayBuffer, a typed array or an array-like object');
  }

  static alloc(size) {
    return new Buffer(size);
  }

  static isBuffer(value) {
    return value instanceof Buffer;
  }

  // The bytes of list (Buffers or any Uint8Array, as a fetch body's chunks are) one after the other, in a new Buffer.
  static concat(list, totalLength) {
    if (!Array.isArray(list)) throw new TypeError('The "list" argument must be an array');
    const length = totalLength === undefined ? list.reduce((n, b) => n + b.length, 0) : totalLength;
    const out = Buffer.alloc(length);
    let at = 0;
    for (const b of list) {
      if (at >= length) break;
      const part = b.length > length - at ? b.subarray(0, length - at) : b;
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  // toString(encoding, start, end): utf8, latin1 (binary), hex, base64 or base64url of bytes start to end.
  toString(encoding, start = 0, end = this.length) {
    const from = Math.max(0, Math.min(this.length, start | 0));
    const to = Math.max(from, Math.min(this.length, end === undefined ? this.length : end | 0));
    const bytes = from === 0 && to === this.length ? this : this.subarray(from, to);
    if (isUtf8(encoding)) return decoder.decode(bytes);
    if (isLatin1(encoding)) {
      let out = '';
      for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return out;
    }
    if (encoding === 'hex') {
      let out = '';
      for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
      return out;
    }
    if (encoding === 'base64') return base64(bytes);
    if (encoding === 'base64url') return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    throw unknownEncoding(encoding);
  }

  // Bytes sourceStart to sourceEnd into target at targetStart, cut to what fits. Returns how many went.
  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const end = Math.min(sourceEnd, this.length, sourceStart + (target.length - targetStart));
    if (end <= sourceStart) return 0;
    target.set(this.subarray(sourceStart, end), targetStart);
    return end - sourceStart;
  }

  // Throws as Node does when byteLength bytes from offset aren't all there.
  _check(offset, byteLength) {
    if (!Number.isInteger(offset) || offset < 0 || offset + byteLength > this.length) throw outOfRange(offset);
  }

  readUInt16BE(offset = 0) {
    this._check(offset, 2);
    return this[offset] * 0x100 + this[offset + 1];
  }

  readUInt16LE(offset = 0) {
    this._check(offset, 2);
    return this[offset] + this[offset + 1] * 0x100;
  }

  readUInt32BE(offset = 0) {
    this._check(offset, 4);
    return this[offset] * 0x1000000 + this[offset + 1] * 0x10000 + this[offset + 2] * 0x100 + this[offset + 3];
  }

  readUInt32LE(offset = 0) {
    this._check(offset, 4);
    return this[offset] + this[offset + 1] * 0x100 + this[offset + 2] * 0x10000 + this[offset + 3] * 0x1000000;
  }

  // byteLength bytes (1 to 6), least significant first, at offset.
  readUIntLE(offset, byteLength) {
    if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 6) throw new RangeError('byteLength must be 1 to 6');
    this._check(offset, byteLength);
    let value = 0;
    for (let i = byteLength - 1; i >= 0; i--) value = value * 256 + this[offset + i];
    return value;
  }

  // value as byteLength bytes (1 to 6), most significant first, at offset. Returns the offset after them.
  writeUIntBE(value, offset, byteLength) {
    if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 6) throw new RangeError('byteLength must be 1 to 6');
    if (!Number.isInteger(offset) || offset < 0 || offset + byteLength > this.length) throw new RangeError('The offset is out of range');
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * byteLength)) throw new RangeError('The value is out of range');
    let rest = value;
    for (let i = byteLength - 1; i >= 0; i--) {
      this[offset + i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    return offset + byteLength;
  }
}
