// Shared by the tests: requests against the Worker, and stand-ins for the keys a device derives. The server only
// hashes or stores those keys, so random bytes of the right length and shape are enough.

import { createExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import worker from '../src/index.js';
import { hmac, toBase64url } from '../src/bytes.js';

export const KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };
export const INVITE = 'first-code';

export function random(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export const key = () => toBase64url(random(32));
export const salt = () => toBase64url(random(16));

// A value shaped like seal()'s output: version byte 0x01, then nonce, ciphertext and tag.
export function sealedBytes(length = 61) {
  const bytes = random(length);
  bytes[0] = 0x01;
  return bytes;
}

export const sealed = (length) => toBase64url(sealedBytes(length));
export const recordId = () => toBase64url(random(32));

let counter = 0;
export function newEmail() {
  counter += 1;
  return `person-${counter}-${toBase64url(random(6)).toLowerCase()}@example.com`;
}

// A different client address per request, so the rate limiter only ever sees what a test means it to.
export function randomIp() {
  const b = random(4);
  return `10.${b[1]}.${b[2]}.${b[3]}`;
}

// Sends a request through the deployed configuration, or, given vars, through the Worker's fetch handler with those
// vars changed. Either way the real Durable Objects answer.
export async function call(method, path, { body, token, ip = randomIp(), vars, headers = {} } = {}) {
  const init = { method, headers: { 'cf-connecting-ip': ip, ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const request = new Request(`https://accounts.example${path}`, init);
  const response = vars
    ? await worker.fetch(request, withVars(vars), createExecutionContext())
    : await exports.default.fetch(request);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text, headers: response.headers };
}

export function withVars(vars) {
  const copy = {};
  for (const name of Object.keys(env)) copy[name] = env[name];
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete copy[name];
    else copy[name] = value;
  }
  return copy;
}

export function device(name = 'Test desktop', platform = 'linux') {
  return { name, platform };
}

// Makes an account and returns everything a device would know about it.
export async function signup(options = {}) {
  const person = {
    email: options.email ?? newEmail(),
    kdf: options.kdf ?? KDF,
    salt: salt(),
    authKey: key(),
    wrappedKey: sealed(),
    recoveryAuth: key(),
    recoveryWrappedKey: sealed()
  };
  const result = await call('POST', '/v1/signup', {
    body: { ...person, invite: INVITE, device: options.device ?? device() },
    vars: options.vars
  });
  if (result.status !== 201) throw new Error(`Sign-up failed: ${result.status} ${result.text}`);
  return { ...person, token: result.body.token, account: result.body.account };
}

export async function login(person, name = 'Second device') {
  return call('POST', '/v1/login', {
    body: { email: person.email, authKey: person.authKey, device: device(name, 'android') }
  });
}

export async function accountName(email) {
  return toBase64url(await hmac(env.PEPPER, `account\n${email}`));
}

export async function accountStub(email) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(await accountName(email)));
}

export function push(token, records, vars) {
  return call('POST', '/v1/records', { token, body: { records }, vars });
}

export function pull(token, query = '') {
  return call('GET', `/v1/records${query}`, { token });
}
