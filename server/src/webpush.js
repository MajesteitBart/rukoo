// Push wakes for team chat (WORKSPACES.md, Push wakes): a phone that isn't connected hears that it has something new
// through the push service it chose, such as a UnifiedPush distributor like ntfy, or Google's FCM through the embedded
// distributor in Rukoo for Android. The phone registers that service's endpoint with its session (PUT
// /v1/push-endpoint), and the account object posts a wake there (account.js, wake).
//
// A wake is a Web Push message as UnifiedPush's Android specification requires it (AND_3): encrypted for the phone
// with its public key and auth secret, as RFC 8291 says, and signed by this server with VAPID (RFC 8292). Its plaintext
// is {"t":"wake"}, the same frame the wake socket sends: it names no workspace, no conversation and no person, and the
// phone fetches what changed over its own signed-in connection. The push service sees when a wake is sent and how
// large it is, which is always the same.
//
// The VAPID key pair comes from the PEPPER secret, so it never changes and needs no setting of its own. FCM ties each
// registration to the key it was made with, so a new key would end every phone's registration.
//
// The server posts to an address a phone gave it, which is a way to make this server send requests elsewhere. So an
// endpoint must be https on its default port, at most 1,000 bytes long, without a user name, password or fragment, and
// must pass the rules link cards follow (previews.js): no local or internal host name, no IP literal in a private,
// loopback, link-local, shared or multicast range, none of this server's own hosts, and a host name whose addresses
// are all public when it is registered. Redirects aren't followed, the answer's body isn't read, and a session's
// wakes come at most once per PUSH_WINDOW (account.js), whatever happens in its workspaces.

import { fromBase64url, randomBytes, toBase64url, utf8 } from './bytes.js';
import { ownHosts, workspacesOn } from './config.js';
import { HttpError, invalid } from './input.js';
import { allowed, resolvesPublic } from './previews.js';

// The longest endpoint UnifiedPush allows, in bytes.
export const ENDPOINT_BYTES = 1000;
// How long a push service keeps a wake for a phone it can't reach, in seconds. A wake that arrives later still makes
// the phone catch up once. Topic makes a newer wake replace one still waiting, where the service supports it.
const TTL = 24 * 60 * 60;
const TOPIC = 'rukoo-wake';
const SEND_TIME = 10 * 1000;
const DNS_TIME = 4 * 1000;
// The record size the encrypted body names: the plaintext fits in one record.
const RECORD_SIZE = 4096;
// How long a VAPID signature is valid. RFC 8292 allows at most 24 hours.
const VAPID_TIME = 12 * 60 * 60;
export const WAKE = '{"t":"wake"}';

// The order of the P-256 group: a private key is a number from 1 to N - 1.
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
// A PKCS #8 document for a P-256 private key without its public key, up to the 32 bytes of the key itself. WebCrypto
// works the public key out on import.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86,
  0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20
]);

// Whether push wakes are on: with team chat, unless WORKSPACE_PUSH is "off". The objects check WORKSPACE_PUSH alone,
// since team chat being on is the Worker's to decide.
export function pushSwitch(env) {
  return String(env.WORKSPACE_PUSH ?? '').trim().toLowerCase() !== 'off';
}

// Whether the Worker takes push endpoints: team chat on, and push wakes not turned off.
export function pushOn(env) {
  return workspacesOn(env) && pushSwitch(env);
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hmacBytes(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- VAPID ----

let vapid = { pepper: null, keys: null };

// The server's VAPID key pair: { privateKey, publicKey }, the second as the 65 bytes of an uncompressed P-256 point,
// which is what GET /v1/info hands the apps in base64url.
export async function vapidKeys(env) {
  if (vapid.pepper === env.PEPPER && vapid.keys) return vapid.keys;
  let d = null;
  // An HMAC is a number below N all but once in four billion times; the counter picks the next one then.
  for (let i = 0; d === null; i++) {
    const candidate = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env.PEPPER), utf8(`vapid-key\n${i}`)));
    const value = BigInt(`0x${hex(candidate)}`);
    if (value > 0n && value < N) d = candidate;
  }
  const privateKey = await crypto.subtle.importKey('pkcs8', concat(PKCS8_PREFIX, d), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = concat([4], fromBase64url(jwk.x), fromBase64url(jwk.y));
  vapid = { pepper: env.PEPPER, keys: { privateKey, publicKey } };
  return vapid.keys;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

// The public key apps register with, in base64url.
export async function vapidPublicKey(env) {
  return toBase64url((await vapidKeys(env)).publicKey);
}

// Who runs this server, for the VAPID token's sub claim, so a push service can reach the operator: OPERATOR_CONTACT
// when it is an https or mailto address, else OPERATOR_URL when it is https. Without either the token has no sub,
// which RFC 8292 allows.
export function vapidContact(env) {
  for (const value of [env.OPERATOR_CONTACT, env.OPERATOR_URL]) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (/^mailto:[^\s@]+@[^\s@]+$/i.test(text)) return text;
    const url = URL.parse(text);
    if (url && url.protocol === 'https:') return url.href;
  }
  return null;
}

// The Authorization header for one endpoint: a JWT for the endpoint's origin, signed with ES256, and the public key.
export async function vapidAuthorization(env, endpoint, now = Date.now()) {
  const { privateKey, publicKey } = await vapidKeys(env);
  const encode = (value) => toBase64url(utf8(JSON.stringify(value)));
  const sub = vapidContact(env);
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_TIME, ...(sub ? { sub } : {}) };
  const signed = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode(claims)}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(signed)));
  return `vapid t=${signed}.${toBase64url(signature)}, k=${toBase64url(publicKey)}`;
}

// ---- Encryption (RFC 8291) ----

// The body of a push message: plaintext encrypted for the phone's public key (65 bytes) and auth secret (16 bytes)
// with the aes128gcm content encoding. sender and salt are for tests, which check the RFC's own example: sender is
// { privateKey, publicKey }, an ECDH key and its 65 bytes. Every real message gets a fresh key pair and salt.
export async function encrypt(uaPublic, authSecret, plaintext, { sender = null, salt = randomBytes(16) } = {}) {
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  let pair = sender;
  if (!pair) {
    const made = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    pair = { privateKey: made.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', made.publicKey)) };
  }
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, pair.privateKey, 256));
  // HKDF with SHA-256, written out: the extract step is one HMAC, and each expand to 32 bytes or fewer another.
  const prkKey = await hmacBytes(authSecret, shared);
  const ikm = await hmacBytes(prkKey, concat(utf8('WebPush: info\0'), uaPublic, pair.publicKey, [1]));
  const prk = await hmacBytes(salt, ikm);
  const cek = (await hmacBytes(prk, concat(utf8('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmacBytes(prk, concat(utf8('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record, the last: the plaintext, then the delimiter 2 and no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, [2])));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = pair.publicKey.length;
  return concat(header, pair.publicKey, sealed);
}

// ---- Endpoints ----

// The rules an endpoint is held to: link cards' rules (previews.js) without their exemptions, and https only. url:
// the request's, for this server's own host names; the account object has none and passes null.
export function endpointRules(env, url = null) {
  return { own: url ? ownHosts(env, url) : ownHosts(env, new URL('https://invalid.invalid')), exempt: new Set() };
}

// Whether the account object may post to endpoint now: the address rules without the DNS lookup.
export function postable(endpoint, rules) {
  const url = URL.parse(endpoint);
  return Boolean(url) && url.protocol === 'https:' && !url.hash && allowed(url, rules);
}

// A registration as PUT /v1/push-endpoint sends it: { endpoint, p256dh, auth }, each checked, the endpoint's host
// looked up too. Throws 400 invalid with the field that is wrong.
export async function endpointInput(body, env, url, rules = endpointRules(env, url)) {
  const endpoint = body?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length < 1 || utf8(endpoint).length > ENDPOINT_BYTES) {
    throw invalid(`endpoint must be an https address of at most ${ENDPOINT_BYTES} bytes.`, 'endpoint');
  }
  const parsed = URL.parse(endpoint);
  if (!parsed || parsed.href !== endpoint || endpoint.includes('#') || !postable(endpoint, rules)) {
    throw invalid('endpoint must be a public https address on its default port, as the push service gave it.', 'endpoint');
  }
  const p256dh = fromBase64url(body.p256dh);
  let point = false;
  if (p256dh && p256dh.length === 65 && p256dh[0] === 4) {
    point = await crypto.subtle
      .importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      .then(() => true)
      .catch(() => false);
  }
  if (!point) throw invalid('p256dh must be the P-256 public key the push service registration made, uncompressed, in base64url.', 'p256dh');
  const auth = fromBase64url(body.auth);
  if (!auth || auth.length !== 16) throw invalid('auth must be the 16-byte auth secret, in base64url.', 'auth');
  if (!(await resolvesPublic(parsed, rules, AbortSignal.timeout(DNS_TIME)))) {
    throw new HttpError(400, 'invalid', "endpoint's host doesn't lead to a public address.", {}, { field: 'endpoint' });
  }
  return { endpoint, p256dh, auth };
}

// Posts one wake. Returns the push service's status; throws when the request fails or runs out of time.
export async function sendWake(env, target, now = Date.now()) {
  const body = await encrypt(new Uint8Array(target.p256dh), new Uint8Array(target.auth), utf8(WAKE));
  const response = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuthorization(env, target.endpoint, now),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(TTL),
      urgency: 'high',
      topic: TOPIC
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(SEND_TIME)
  });
  await response.body?.cancel();
  return response.status;
}
