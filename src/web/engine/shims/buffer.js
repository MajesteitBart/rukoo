// Node's Buffer for the browser build, as far as the bundled chat code uses it: wire.js (mentionRule, uuidv7, localId
// through shims/crypto.js) and notify.js (alertText). esbuild's inject puts it in place of every free Buffer, so those
// files run unchanged. It is ESM because inject only takes the named exports of an ES module.
//
// A Uint8Array underneath: indexing, length and subarray (which keeps the class) are the platform's own.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function unknownEncoding(encoding) {
  const err = new TypeError(`Unknown encoding: ${encoding}`);
  err.code = 'ERR_UNKNOWN_ENCODING';
  return err;
}

const isUtf8 = (encoding) => encoding === undefined || encoding === 'utf8' || encoding === 'utf-8';

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

  toString(encoding) {
    if (isUtf8(encoding)) return decoder.decode(this);
    if (encoding === 'hex') {
      let out = '';
      for (const byte of this) out += byte.toString(16).padStart(2, '0');
      return out;
    }
    if (encoding === 'base64') return base64(this);
    if (encoding === 'base64url') return base64(this).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    throw unknownEncoding(encoding);
  }

  // Bytes sourceStart to sourceEnd into target at targetStart, cut to what fits. Returns how many went.
  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const end = Math.min(sourceEnd, this.length, sourceStart + (target.length - targetStart));
    if (end <= sourceStart) return 0;
    target.set(this.subarray(sourceStart, end), targetStart);
    return end - sourceStart;
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
