// Stripe, for billing team workspaces per member (README.md, Billing). Plain fetch with form-encoded bodies, the way
// Stripe's API takes them, so the Worker needs no SDK. Every POST carries an idempotency key. A POST is sent again with
// the same key only when no answer came, after a 429 (which Stripe hasn't run) or while Stripe still runs the first
// request with that key: Stripe keeps the answer to a key for a day, a 500 included, so the same key after an error
// would only get the same error back. The callers decide what to do after one. The secret key is only ever sent to
// Stripe in the Authorization header; errors and logs carry Stripe's error code and message, never the key.
//
// The webhook's signature is checked here too: HMAC-SHA256 with the endpoint's signing secret over "<t>." and the
// body's bytes exactly as they came, compared in constant time with each v1 signature in the Stripe-Signature header,
// within five minutes of t.

import { randomBytes, sameBytes, toBase64url, utf8 } from './bytes.js';

const API = 'https://api.stripe.com';
// The API version every request asks for, so the shapes this file reads don't change under it. The webhook endpoint
// has a version of its own (set when it is made in Stripe), so the readers below take both shapes where 2025-03-31
// moved a field: current_period_end from the subscription to its items, and an invoice's subscription under parent.
export const STRIPE_VERSION = '2025-03-31.basil';
// How long one call may take, how often it is tried, and how long a signed webhook stays acceptable.
const TIMEOUT = 10 * 1000;
const ATTEMPTS = 3;
export const TOLERANCE = 5 * 60;
// What a seat costs when Stripe can't be asked: shown, never charged. The price itself lives in Stripe (STRIPE_PRICE_ID).
export const FALLBACK_PRICE = { amount: 1950, currency: 'eur', interval: 'month', taxBehavior: 'inclusive' };
const PRICE_TIME = 60 * 60 * 1000;

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

// An error Stripe answered with, or one on the way there (status 0). code and type are Stripe's.
export class StripeError extends Error {
  constructor(status, message, { code = null, type = null } = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

// Stripe's form encoding: nested objects and lists as metadata[workspace]=… and line_items[0][price]=…. Null and
// undefined values are left out; true and false are written as words.
export function formBody(params, prefix = '', out = new URLSearchParams()) {
  for (const [name, value] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${name}]` : name;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item, i) => (typeof item === 'object' && item !== null ? formBody(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof value === 'object') formBody(value, key, out);
    else out.append(key, String(value));
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A client for one environment. STRIPE_API is for tests only: the address of a stand-in for Stripe.
export function stripe(env) {
  const base = text(env.STRIPE_API) ?? API;
  const key = text(env.STRIPE_SECRET_KEY);
  async function call(method, path, params = null, { idempotencyKey = null } = {}) {
    if (!key) throw new StripeError(0, 'Stripe has no secret key on this server.');
    const headers = { authorization: `Bearer ${key}`, 'stripe-version': STRIPE_VERSION };
    let url = `${base}${path}`;
    let body;
    if (method === 'GET') {
      if (params) url += `?${formBody(params)}`;
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['idempotency-key'] = idempotencyKey ?? `rukoo-${toBase64url(randomBytes(18))}`;
      body = formBody(params ?? {}).toString();
    }
    let last = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      let response;
      try {
        response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT) });
      } catch (err) {
        last = new StripeError(0, `Stripe could not be reached: ${err?.name || 'error'}`);
        if (attempt < ATTEMPTS) await sleep(250 * 4 ** (attempt - 1));
        continue;
      }
      let answer = null;
      try {
        answer = await response.json();
      } catch {
        answer = null;
      }
      if (response.ok && answer && typeof answer === 'object') return answer;
      const error = answer?.error ?? {};
      last = new StripeError(response.status, typeof error.message === 'string' ? error.message.slice(0, 300) : `Stripe answered ${response.status}.`, {
        code: typeof error.code === 'string' ? error.code : null,
        type: typeof error.type === 'string' ? error.type : null
      });
      // A refusal of the request itself is final, and so is Stripe's own trouble for a POST, whose key now holds that
      // answer. Too many requests, a read that met Stripe's trouble and a key still in use by a request under way (409
      // with an idempotency error) are worth another try.
      const again = response.status === 429 || (method === 'GET' && response.status >= 500) || (response.status === 409 && error.type === 'idempotency_error');
      if (!again || attempt === ATTEMPTS) throw last;
      const wait = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 5) * 1000 : 250 * 4 ** (attempt - 1));
    }
    throw last;
  }
  return {
    get: (path, params) => call('GET', path, params),
    post: (path, params, options) => call('POST', path, params, options)
  };
}

// ---- Webhook signatures ----

const HEX = /^[0-9a-f]{64}$/;

function hexBytes(hex) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// The bytes Stripe signs: "<t>." and the body as it came. payload is those bytes, or text, which is encoded as UTF-8.
async function sign(secret, t, payload) {
  const body = typeof payload === 'string' ? utf8(payload) : payload;
  const prefix = utf8(`${t}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
}

// Whether payload, the raw body's bytes exactly as they came, carries a valid Stripe-Signature for one of secrets,
// signed within TOLERANCE seconds of now (milliseconds). Every pair of secret and signature is compared, so the time
// taken doesn't show which one matched. secrets: the endpoint's signing secrets, two while one is being rolled.
export async function verifySignature(payload, header, secrets, now = Date.now()) {
  if (typeof header !== 'string' || header.length > 4096 || !secrets.length) return false;
  let t = null;
  const v1 = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === 't') t = value;
    else if (name === 'v1' && HEX.test(value)) v1.push(hexBytes(value));
  }
  if (t === null || !/^\d{1,12}$/.test(t) || !v1.length || v1.length > 8) return false;
  if (Math.abs(now / 1000 - Number(t)) > TOLERANCE) return false;
  let found = false;
  for (const secret of secrets) {
    const expected = await sign(secret, t, payload);
    for (const given of v1) if (sameBytes(expected, given)) found = true;
  }
  return found;
}

// A Stripe-Signature header for payload, as Stripe makes one. For tests and the e2e stand-in.
export async function signatureHeader(payload, secret, time = Math.floor(Date.now() / 1000)) {
  const mac = await sign(secret, time, payload);
  return `t=${time},v1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---- What a seat costs ----

// The price of a seat as the apps show it: { amount, currency, interval, taxBehavior }, amount in the currency's
// smallest unit (cents). Asked of Stripe once an hour per Worker instance; FALLBACK_PRICE while Stripe can't answer or
// the price isn't a plain recurring price per unit.
let priceCache = { id: null, value: null, at: 0 };

export async function seatPrice(env, now = Date.now()) {
  const id = text(env.STRIPE_PRICE_ID);
  if (!id) return FALLBACK_PRICE;
  if (priceCache.id === id && priceCache.value && now - priceCache.at < PRICE_TIME) return priceCache.value;
  try {
    const price = await stripe(env).get(`/v1/prices/${encodeURIComponent(id)}`);
    const value = priceOut(price);
    if (value) {
      priceCache = { id, value, at: now };
      return value;
    }
    console.error('The Stripe price for a seat is not a plain monthly price per unit; the apps show the fallback.');
  } catch (err) {
    console.error('Could not read the seat price from Stripe:', err?.message || err);
  }
  return priceCache.id === id && priceCache.value ? priceCache.value : FALLBACK_PRICE;
}

export function priceOut(price) {
  const amount = price?.unit_amount;
  const interval = price?.recurring?.interval;
  if (!Number.isSafeInteger(amount) || amount < 0 || typeof price.currency !== 'string' || typeof interval !== 'string') return null;
  const taxBehavior = ['inclusive', 'exclusive'].includes(price.tax_behavior) ? price.tax_behavior : 'unspecified';
  return { amount, currency: price.currency.toLowerCase(), interval, taxBehavior };
}

// For tests: forget the cached price.
export function forgetPrice() {
  priceCache = { id: null, value: null, at: 0 };
}
