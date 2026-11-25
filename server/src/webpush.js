// Push wakes for team chat (WORKSPACES.md, Push wakes): a phone that isn't connected hears that it has something new
// through the push service it uses: a UnifiedPush distributor app such as ntfy, or Google's FCM through the distributor
// built into Rukoo for Android. The phone registers that service's endpoint with its session (PUT /v1/push-endpoint),
// and the account object posts a wake there (account.js, wake). Delivery is best effort: the push service and the
// phone's battery settings decide when a wake arrives, and the phone's periodic check stays the fallback.
//
// A wake is a Web Push message as UnifiedPush's Android specification requires it (AND_3): encrypted for the phone
// with its public key and auth secret, as RFC 8291 says, and signed by this server with VAPID (RFC 8292). Its plaintext
// is {"t":"wake","w":[…]}: that there is something new, and the IDs of the workspaces it is in, so the phone fetches
// those first. It names no conversation and no person and holds no text; the phone fetches what changed over its own
// signed-in connection. The push service can't read it and sees only when a wake is sent and how large it is.
//
// The VAPID key pair comes from the PEPPER secret, so it never changes and needs no setting of its own. FCM ties each
// registration to the key it was made with, so a new key would end every phone's registration.
//
// The server posts to an address a phone gave it, which is a way to make this server send requests elsewhere. So it
// posts only to known push services: Google's FCM, ntfy.sh and Mozilla's push service (PUSH_ORIGINS), and the origins
// its operator adds in WORKSPACE_PUSH_ORIGINS, such as a self-hosted ntfy. An endpoint is https, at most 1,000 bytes,
// without a user name, password or fragment, on one of those origins. Redirects aren't followed, the answer's body
// isn't read, and a session's wakes come at most once per PUSH_WINDOW (account.js), whatever happens in its workspaces.

import { fromBase64url, randomBytes, toBase64url, utf8 } from './bytes.js';
import { configProblem, workspacesOn } from './config.js';
import { HttpError, invalid } from './input.js';

// The longest endpoint UnifiedPush allows, in bytes.
export const ENDPOINT_BYTES = 1000;
// How long a push service keeps a wake for a phone it can't reach, in seconds. A wake that arrives later still makes
// the phone catch up once. Topic makes a newer wake replace one still waiting, where the service supports it.
const TTL = 24 * 60 * 60;
const TOPIC = 'rukoo-wake';
const SEND_TIME = 10 * 1000;
// The record size the encrypted body names: the plaintext fits in one record.
const RECORD_SIZE = 4096;
// How long a VAPID signature is valid. RFC 8292 allows at most 24 hours.
const VAPID_TIME = 12 * 60 * 60;
// Workspace IDs one wake names, at most. A wake for more names none, and the phone checks its workspaces as it would.
export const WAKE_WORKSPACES = 10;

// The push services every server posts to: Google's FCM, which Rukoo for Android's built-in distributor uses, ntfy.sh,
// the ntfy app's default server, and Mozilla's push service, which the Sunup app uses.
export const PUSH_ORIGINS = ['https://fcm.googleapis.com', 'https://ntfy.sh', 'https://updates.push.services.mozilla.com'];

// The order of the P-256 group: a private key is a number from 1 to N - 1.
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
// A PKCS #8 document for a P-256 private key without its public key, up to the 32 bytes of the key itself. WebCrypto
// works the public key out on import.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86,
  0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20
]);

// Whether WORKSPACE_PUSH leaves push wakes on. The objects check this alone, since team chat being on is the Worker's
// to decide.
export function pushSwitch(env) {
  return String(env.WORKSPACE_PUSH ?? '').trim().toLowerCase() !== 'off';
}

// Whether push wakes can work: WORKSPACE_PUSH not off and a PEPPER to make the VAPID key from.
export function pushConfigured(env) {
  return pushSwitch(env) && configProblem(env) === null;
}

// Whether the Worker takes push endpoints: team chat on and push wakes configured.
export function pushOn(env) {
  return workspacesOn(env) && pushConfigured(env);
}

// The origins this server posts wakes to: PUSH_ORIGINS and the https origins in WORKSPACE_PUSH_ORIGINS,
// comma-separated. An entry that isn't a bare https origin is left out.
export function pushOrigins(env) {
  const origins = new Set(PUSH_ORIGINS);
  for (const entry of String(env.WORKSPACE_PUSH_ORIGINS ?? '').split(',')) {
    const url = URL.parse(entry.trim());
    if (url && url.protocol === 'https:' && !url.username && !url.password && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash) {
      origins.add(url.origin);
    }
  }
  return origins;
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
// which is what GET /v1/info hands the apps in base64url. Throws without a usable PEPPER.
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

// The public key while push wakes are configured and the key can be made, else null: GET /v1/info offers push-wake
// only then, and answers without it when PEPPER is missing or too short.
export async function pushKey(env) {
  if (!pushConfigured(env)) return null;
  try {
    return await vapidPublicKey(env);
  } catch (err) {
    console.error('Could not make the VAPID key:', err?.message || err);
    return null;
  }
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

// Whether endpoint is an address this server posts to: https on one of origins, without a user name, password or
// fragment.
export function postable(endpoint, origins) {
  const url = typeof endpoint === 'string' ? URL.parse(endpoint) : null;
  return Boolean(url) && url.protocol === 'https:' && !url.username && !url.password && !endpoint.includes('#') && origins.has(url.origin);
}

// A registration as PUT /v1/push-endpoint sends it: { endpoint, p256dh, auth }. A malformed field is 400 invalid with
// the field; an endpoint on a push service this server doesn't post to is 400 push_not_allowed.
export async function endpointInput(body, env) {
  const endpoint = body?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length < 1 || utf8(endpoint).length > ENDPOINT_BYTES) {
    throw invalid(`endpoint must be an https address of at most ${ENDPOINT_BYTES} bytes.`, 'endpoint');
  }
  const parsed = URL.parse(endpoint);
  if (!parsed || parsed.href !== endpoint || parsed.protocol !== 'https:' || parsed.username || parsed.password || endpoint.includes('#')) {
    throw invalid('endpoint must be an https address without a user name or fragment, as the push service gave it.', 'endpoint');
  }
  if (!postable(endpoint, pushOrigins(env))) {
    throw new HttpError(400, 'push_not_allowed', "This server doesn't send wakes to that push service.", {}, { field: 'endpoint' });
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
  return { endpoint, p256dh, auth };
}

// What a wake says: that there is something new, and in which workspaces, when there are at most WAKE_WORKSPACES.
export function wakeText(workspaces = []) {
  const list = [...new Set(workspaces)];
  return JSON.stringify(list.length && list.length <= WAKE_WORKSPACES ? { t: 'wake', w: list } : { t: 'wake' });
}

// Posts one wake for workspaces. Returns the push service's status; throws when the request fails or runs out of time.
export async function sendWake(env, target, workspaces = [], now = Date.now()) {
  const body = await encrypt(new Uint8Array(target.p256dh), new Uint8Array(target.auth), utf8(wakeText(workspaces)));
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
