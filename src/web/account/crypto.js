'use strict';

// The keys and encryption of a Rukoo account in a browser: src/main/account/crypto.js on Web Crypto, with the same
// bytes out (test/fixtures/account-vectors.json, checked by website/tools/web-account.test.mjs). Web Crypto is
// asynchronous, so everything that derives, seals or opens returns a promise here.
//
// createKeys() takes what the work runs on: the Argon2id function (hash-wasm's argon2id signature; in the page that is
// argon2.js, which runs it in a Worker), crypto.subtle, and where random bytes come from. Node's tests pass their own.
// The functions that need none of these (encoding, the recovery key's text, the kdf check) are exported on their own.

const DEFAULT_KDF = Object.freeze({ alg: 'argon2id', m: 65536, t: 3, p: 1 });
// The desktop's limits. Below these a server could make a stolen verifier cheap to attack, so a device refuses them.
const KDF_MIN = Object.freeze({ m: 19456, t: 2 });
const KDF_MAX = Object.freeze({ m: 1048576, t: 10, p: 4 });
const VERSION = 1;
const NONCE = 12;
const TAG = 16;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64U_VALUE = new Map([...B64U].map((ch, i) => [ch, i]));
const DATA_KEY_AAD = 'rukoo/v1/data-key';

const utf8 = (text) => new TextEncoder().encode(text);

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('bytes');
}

function b64u(value) {
  const b = bytesOf(value);
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64U[n >>> 18] + B64U[(n >>> 12) & 63] + B64U[(n >>> 6) & 63] + B64U[n & 63];
  }
  if (b.length - i === 1) {
    const n = b[i] << 16;
    out += B64U[n >>> 18] + B64U[(n >>> 12) & 63];
  } else if (b.length - i === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64U[n >>> 18] + B64U[(n >>> 12) & 63] + B64U[(n >>> 6) & 63];
  }
  return out;
}

// Strict: anything but base64url characters is refused rather than skipped. So is a length no encoder makes (one
// character past a group of four), which Node's Buffer would quietly drop on desktop.
function unb64u(text, bytes = null) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('invalid base64url');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let value = 0;
  let bits = 0;
  let j = 0;
  for (const ch of text) {
    value = (value << 6) | B64U_VALUE.get(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (value >>> bits) & 0xff;
      value &= (1 << bits) - 1;
    }
  }
  if (bytes !== null && out.length !== bytes) throw new Error('invalid length');
  return out;
}

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function checkKdf(kdf) {
  const k = kdf || {};
  const int = (v) => Number.isInteger(v);
  if (k.alg !== 'argon2id' || !int(k.m) || !int(k.t) || !int(k.p)) throw new Error('kdf');
  if (k.m < KDF_MIN.m || k.t < KDF_MIN.t || k.m > KDF_MAX.m || k.t > KDF_MAX.t || k.p < 1 || k.p > KDF_MAX.p) throw new Error('kdf');
  return { alg: 'argon2id', m: k.m, t: k.t, p: k.p };
}

// The recovery key as people write it down: 32 Crockford base32 characters in groups of four.
function formatRecoveryKey(value) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytesOf(value)) {
    acc = ((acc << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

// Forgiving about how it was copied: case, dashes, spaces, and O, I and L for 0 and 1. Null unless it is 20 bytes.
function parseRecoveryKey(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== 32) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

const recordAad = (id) => `rukoo/v1/record:${id}`;

function defaultRandom(size) {
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

function createKeys({ argon2id, subtle, randomBytes = defaultRandom } = {}) {
  if (typeof argon2id !== 'function') throw new TypeError('createKeys needs an argon2id function');
  if (!subtle || typeof subtle.importKey !== 'function') throw new TypeError('createKeys needs crypto.subtle');

  async function masterKey(password, salt, kdf) {
    const k = checkKdf(kdf);
    const out = await argon2id({
      password: String(password).normalize('NFC'),
      salt: bytesOf(salt),
      parallelism: k.p,
      iterations: k.t,
      memorySize: k.m,
      hashLength: 32,
      outputType: 'binary'
    });
    const key = bytesOf(out);
    if (key.length !== 32) throw new Error('argon2');
    return key;
  }

  async function hkdf(ikm, info) {
    const key = await subtle.importKey('raw', bytesOf(ikm), 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) }, key, 256);
    return new Uint8Array(bits);
  }

  async function sha256(value) {
    return new Uint8Array(await subtle.digest('SHA-256', typeof value === 'string' ? utf8(value) : bytesOf(value)));
  }

  // authKey proves the password to one server: its address is part of the key, so a server someone was tricked into
  // using can't pass the proof on to the real one. wrapKey opens the data key and stays here. server: the canonical
  // address (client.js serverUrl), never the page's origin by default.
  async function passwordKeys(password, salt, kdf, server) {
    if (!server) throw new Error('server');
    const master = await masterKey(password, salt, kdf);
    try {
      return { authKey: await hkdf(master, `rukoo/v1/auth\n${server}`), wrapKey: await hkdf(master, 'rukoo/v1/wrap') };
    } finally {
      master.fill(0);
    }
  }

  async function seal(key, plaintext, aad, nonce = randomBytes(NONCE)) {
    const iv = bytesOf(nonce);
    if (iv.length !== NONCE) throw new Error('nonce');
    const k = await subtle.importKey('raw', bytesOf(key), 'AES-GCM', false, ['encrypt']);
    const body = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: TAG * 8 }, k, bytesOf(plaintext)));
    const out = new Uint8Array(1 + NONCE + body.length);
    out[0] = VERSION;
    out.set(iv, 1);
    out.set(body, 1 + NONCE);
    return out;
  }

  async function open(key, sealed, aad) {
    const buf = bytesOf(sealed);
    if (buf.length < 1 + NONCE + TAG || buf[0] !== VERSION) throw new Error('sealed');
    const k = await subtle.importKey('raw', bytesOf(key), 'AES-GCM', false, ['decrypt']);
    try {
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(1, 1 + NONCE), additionalData: utf8(aad), tagLength: TAG * 8 }, k, buf.subarray(1 + NONCE));
      return new Uint8Array(plain);
    } catch (_) {
      // Web Crypto says only OperationError for a tag that doesn't verify; desktop's open() throws there too.
      throw new Error('sealed');
    }
  }

  const wrapDataKey = (wrapKey, dataKey) => seal(wrapKey, dataKey, DATA_KEY_AAD);

  async function unwrapDataKey(wrapKey, wrapped) {
    const key = await open(wrapKey, wrapped, DATA_KEY_AAD);
    if (key.length !== 32) throw new Error('sealed');
    return key;
  }

  // recoveryAuth is bound to the server like authKey; recoveryWrap opens the data key wherever the account lives.
  async function recoveryKeys(recoveryKey, server) {
    if (!server) throw new Error('server');
    return {
      recoveryAuth: await hkdf(recoveryKey, `rukoo/v1/recovery-auth\n${server}`),
      recoveryWrap: await hkdf(recoveryKey, 'rukoo/v1/recovery-wrap')
    };
  }

  // The records of server/PROTOCOL.md. The page doesn't sync records; these are here so the port is whole and the
  // shared vectors cover every key.
  async function recordKeys(dataKey) {
    return { recordKey: await hkdf(dataKey, 'rukoo/v1/records'), indexKey: await hkdf(dataKey, 'rukoo/v1/index') };
  }

  async function recordId(indexKey, c, k) {
    const key = await subtle.importKey('raw', bytesOf(indexKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64u(new Uint8Array(await subtle.sign('HMAC', key, utf8(`${c}\n${k}`))));
  }

  async function sealRecord(keys, { c, k, v, t, d }, nonce) {
    const id = await recordId(keys.indexKey, c, k);
    const record = d ? { c, k, v: null, t, d: true } : { c, k, v, t };
    const data = await seal(keys.recordKey, utf8(JSON.stringify(record)), recordAad(id), nonce);
    return { id, data: b64u(data) };
  }

  // The record under id, or null when it doesn't open or claims to be another record than its id says.
  async function openRecord(keys, id, data) {
    try {
      const rec = JSON.parse(new TextDecoder().decode(await open(keys.recordKey, unb64u(data), recordAad(id))));
      if (!rec || typeof rec.c !== 'string' || typeof rec.k !== 'string') return null;
      if ((await recordId(keys.indexKey, rec.c, rec.k)) !== id) return null;
      const out = { c: rec.c, k: rec.k, v: rec.v === undefined ? null : rec.v, t: Number(rec.t) || 0 };
      if (rec.d === true) out.d = true;
      return out;
    } catch (_) {
      return null;
    }
  }

  // The team chat cache's tag of a session (src/main/account/index.js sessionTag): the first 22 characters of
  // base64url SHA-256 of the token.
  const sessionTag = async (token) => b64u(await sha256(String(token))).slice(0, 22);

  return {
    randomBytes,
    masterKey,
    hkdf,
    sha256,
    passwordKeys,
    seal,
    open,
    wrapDataKey,
    unwrapDataKey,
    recoveryKeys,
    recordKeys,
    recordId,
    sealRecord,
    openRecord,
    sessionTag
  };
}

module.exports = {
  DEFAULT_KDF,
  KDF_MIN,
  KDF_MAX,
  b64u,
  unb64u,
  normalizeEmail,
  checkKdf,
  formatRecoveryKey,
  parseRecoveryKey,
  createKeys
};
