'use strict';

// The keys and encryption of a Rukoo account, as server/PROTOCOL.md describes them. Everything here runs on the
// device; the server only ever gets authKey, recoveryAuth and sealed bytes.
const crypto = require('crypto');
const { argon2id } = require('hash-wasm');

const DEFAULT_KDF = Object.freeze({ alg: 'argon2id', m: 65536, t: 3, p: 1 });
// Below these a server could make a stolen verifier cheap to attack, so a device refuses them.
const KDF_MIN = { m: 19456, t: 2 };
const KDF_MAX = { m: 1048576, t: 10, p: 4 };
const VERSION = 1;
const NONCE = 12;
const TAG = 16;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
// Strict: anything but base64url characters is refused rather than skipped, as Buffer.from would.
function unb64u(text, bytes = null) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url');
  const buf = Buffer.from(text, 'base64url');
  if (bytes !== null && buf.length !== bytes) throw new Error('invalid length');
  return buf;
}

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function checkKdf(kdf) {
  const k = kdf || {};
  const int = (v) => Number.isInteger(v);
  if (k.alg !== 'argon2id' || !int(k.m) || !int(k.t) || !int(k.p)) throw new Error('kdf');
  if (k.m < KDF_MIN.m || k.t < KDF_MIN.t || k.m > KDF_MAX.m || k.t > KDF_MAX.t || k.p < 1 || k.p > KDF_MAX.p) throw new Error('kdf');
  return { alg: 'argon2id', m: k.m, t: k.t, p: k.p };
}

async function masterKey(password, salt, kdf) {
  const k = checkKdf(kdf);
  const out = await argon2id({
    password: String(password).normalize('NFC'),
    salt,
    parallelism: k.p,
    iterations: k.t,
    memorySize: k.m,
    hashLength: 32,
    outputType: 'binary'
  });
  return Buffer.from(out);
}

const hkdf = (ikm, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));

// authKey proves the password to the server; wrapKey opens the data key and stays here.
async function passwordKeys(password, salt, kdf) {
  const master = await masterKey(password, salt, kdf);
  return { authKey: hkdf(master, 'rukoo/v1/auth'), wrapKey: hkdf(master, 'rukoo/v1/wrap') };
}

function seal(key, plaintext, aad, nonce = crypto.randomBytes(NONCE)) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]);
}

function open(key, sealed, aad) {
  const buf = Buffer.from(sealed);
  if (buf.length < 1 + NONCE + TAG || buf[0] !== VERSION) throw new Error('sealed');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(1, 1 + NONCE));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(buf.subarray(buf.length - TAG));
  return Buffer.concat([decipher.update(buf.subarray(1 + NONCE, buf.length - TAG)), decipher.final()]);
}

const DATA_KEY_AAD = 'rukoo/v1/data-key';
const wrapDataKey = (wrapKey, dataKey) => seal(wrapKey, dataKey, DATA_KEY_AAD);
function unwrapDataKey(wrapKey, wrapped) {
  const key = open(wrapKey, wrapped, DATA_KEY_AAD);
  if (key.length !== 32) throw new Error('sealed');
  return key;
}

// The recovery key as people write it down: 32 Crockford base32 characters in groups of four.
function formatRecoveryKey(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
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
  return Buffer.from(out);
}

const recoveryKeys = (recoveryKey) => ({
  recoveryAuth: hkdf(recoveryKey, 'rukoo/v1/recovery-auth'),
  recoveryWrap: hkdf(recoveryKey, 'rukoo/v1/recovery-wrap')
});

const recordKeys = (dataKey) => ({ recordKey: hkdf(dataKey, 'rukoo/v1/records'), indexKey: hkdf(dataKey, 'rukoo/v1/index') });
const recordId = (indexKey, c, k) => b64u(crypto.createHmac('sha256', indexKey).update(`${c}\n${k}`, 'utf8').digest());
const recordAad = (id) => `rukoo/v1/record:${id}`;

function sealRecord(keys, { c, k, v, t }, nonce) {
  const id = recordId(keys.indexKey, c, k);
  const data = seal(keys.recordKey, Buffer.from(JSON.stringify({ c, k, v, t }), 'utf8'), recordAad(id), nonce);
  return { id, data: b64u(data) };
}

// The record under id, or null when it doesn't open or claims to be another record than its id says.
function openRecord(keys, id, data) {
  try {
    const rec = JSON.parse(open(keys.recordKey, unb64u(data), recordAad(id)).toString('utf8'));
    if (!rec || typeof rec.c !== 'string' || typeof rec.k !== 'string') return null;
    if (recordId(keys.indexKey, rec.c, rec.k) !== id) return null;
    return { c: rec.c, k: rec.k, v: rec.v === undefined ? null : rec.v, t: Number(rec.t) || 0 };
  } catch (_) {
    return null;
  }
}

module.exports = {
  DEFAULT_KDF,
  b64u,
  unb64u,
  normalizeEmail,
  checkKdf,
  masterKey,
  hkdf,
  passwordKeys,
  seal,
  open,
  wrapDataKey,
  unwrapDataKey,
  formatRecoveryKey,
  parseRecoveryKey,
  recoveryKeys,
  recordKeys,
  recordId,
  sealRecord,
  openRecord
};
