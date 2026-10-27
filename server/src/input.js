// Checks what a client sends before any of it reaches an account's Durable Object. Each check either returns the
// value in the form the object stores or throws an HttpError with the status and code PROTOCOL.md gives.

import { fromBase64url } from './bytes.js';

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function invalid(message) {
  return new HttpError(400, 'invalid', message);
}

export const DEFAULT_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };
// The same floor the apps use when signing in (PROTOCOL.md, Keys), plus ceilings, so a client can't store parameters
// that would make every other device spend minutes or gigabytes on a sign-in.
const KDF_RANGE = { m: [19456, 1048576], t: [2, 10], p: [1, 4] };

// A sealed blob is a version byte 0x01, a 12-byte nonce, the ciphertext and a 16-byte tag.
const SEAL_VERSION = 0x01;
const SEAL_MIN = 1 + 12 + 16;
// A wrapped data key is 61 bytes; the ceiling only keeps the account row small.
const WRAPPED_KEY_MAX = 256;

export const RECORD_BYTES = 16384;
export const BATCH = 500;
export const PULL_LIMIT = 1000;

// Requests other than a push carry a few hundred bytes. A full push is 500 records of at most 16 KiB, which grows by a
// third in base64url, plus the JSON around them.
const BODY_MAX = 64 * 1024;
const PUSH_BODY_MAX = 12 * 1024 * 1024;

// The body, read piece by piece and given up on as soon as it passes max. A body sent in chunks has no
// Content-Length to check first, and reading all of it before checking would let anyone fill the Worker's memory.
async function readBody(request, max) {
  const tooLarge = () => new HttpError(413, 'too_large', 'The request body is too large.');
  const declared = Number(request.headers.get('content-length'));
  if (declared > max) throw tooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

export async function readJson(request, max = BODY_MAX) {
  const body = await readBody(request, max);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw invalid('The request body must be JSON.');
  }
  if (!isObject(value)) throw invalid('The request body must be a JSON object.');
  return value;
}

export function readPushJson(request) {
  return readJson(request, PUSH_BODY_MAX);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Trimmed and lowercased as PROTOCOL.md says, then checked loosely: an address has one @ with a dot somewhere after
// it. Nothing else about it can be known without sending it mail, which this server never does.
export function email(value) {
  if (typeof value !== 'string') throw invalid('email must be a string.');
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(normalized)) {
    throw invalid('email must be an email address.');
  }
  return normalized;
}

export function key(value, name, length) {
  const bytes = fromBase64url(value);
  if (!bytes || bytes.length !== length) throw invalid(`${name} must be ${length} bytes in base64url.`);
  return bytes;
}

export function sealed(value, name, max = WRAPPED_KEY_MAX) {
  const bytes = fromBase64url(value);
  if (!bytes || bytes.length < SEAL_MIN || bytes.length > max || bytes[0] !== SEAL_VERSION) {
    throw invalid(`${name} must be a sealed value in base64url.`);
  }
  return bytes;
}

// Exactly the four parameters PROTOCOL.md names. A field this server doesn't know is refused rather than dropped:
// a device that relied on it would derive a different key from what the server hands back at the next sign-in.
export function kdf(value) {
  if (!isObject(value)) throw invalid('kdf must be an object.');
  if (Object.keys(value).sort().join(',') !== 'alg,m,p,t')
    throw invalid('kdf must have alg, m, t and p, and nothing else.');
  if (value.alg !== 'argon2id') throw invalid('kdf.alg must be argon2id.');
  for (const [name, [min, max]] of Object.entries(KDF_RANGE)) {
    const n = value[name];
    if (!Number.isInteger(n) || n < min || n > max)
      throw invalid(`kdf.${name} must be a whole number from ${min} to ${max}.`);
  }
  return { alg: 'argon2id', m: value.m, t: value.t, p: value.p };
}

// Cut by code point, so a name never ends in half an emoji.
function cut(text, length) {
  return Array.from(text.trim()).slice(0, length).join('').trim();
}

export function device(value) {
  if (!isObject(value) || typeof value.name !== 'string') throw invalid('device must be an object with a name.');
  if (value.platform !== undefined && typeof value.platform !== 'string')
    throw invalid('device.platform must be a string.');
  return { name: cut(value.name, 100), platform: cut(value.platform ?? '', 32) };
}

export function recordId(value) {
  if (typeof value !== 'string' || value.length !== 43 || !fromBase64url(value)) {
    throw invalid('A record id must be 43 characters of base64url.');
  }
  return value;
}

// The records of a push, in order. Data is decoded here so the object only ever sees bytes it can store as they are.
export function records(value) {
  if (!Array.isArray(value)) throw invalid('records must be a list.');
  if (value.length > BATCH) throw new HttpError(413, 'too_large', `A push holds at most ${BATCH} records.`);
  return value.map((item) => {
    if (!isObject(item)) throw invalid('Each record must be an object.');
    const id = recordId(item.id);
    if (item.ifAbsent !== undefined && typeof item.ifAbsent !== 'boolean')
      throw invalid('ifAbsent must be true or false.');
    let data = null;
    if (item.data !== null) {
      // Checked on the text first, so an oversized record isn't decoded at all.
      if (typeof item.data === 'string' && item.data.length > Math.ceil((RECORD_BYTES * 4) / 3)) {
        throw new HttpError(413, 'too_large', `A record's data is at most ${RECORD_BYTES} bytes.`);
      }
      data = sealed(item.data, 'data', RECORD_BYTES);
    }
    return { id, data, ifAbsent: item.ifAbsent === true };
  });
}

// since and limit for a pull. A limit above the maximum is lowered to it rather than refused.
export function pullQuery(url) {
  const since = whole(url.searchParams.get('since'), 0, 'since');
  const limit = whole(url.searchParams.get('limit'), PULL_LIMIT, 'limit');
  if (limit < 1) throw invalid('limit must be at least 1.');
  return { since, limit: Math.min(limit, PULL_LIMIT) };
}

function whole(text, fallback, name) {
  if (text === null) return fallback;
  const n = /^\d{1,15}$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n)) throw invalid(`${name} must be a whole number.`);
  return n;
}
