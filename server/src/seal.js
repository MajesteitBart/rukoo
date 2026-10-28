// Guest details sealed to the host's booking key (PROTOCOL.md, Sealed guest details). The server reads a guest's
// name, email and notes once, while a booking is made, and keeps only this blob, which only the host's devices can
// open. Also the wrapping of a manage key under an Idempotency-Key, so a retried booking can get its key back without
// the server keeping a usable copy.

import { fromBase64url, sha256, toBase64url, utf8 } from './bytes.js';

export const SEAL_VERSION = 0x02;
const INFO = 'rukoo/v1/booking-guest';
const AAD = 'rukoo/v1/booking:';
const IDEM_INFO = 'rukoo/v1/booking-idempotency';
const IDEM_AAD = 'rukoo/v1/booking-idem:';
const P256 = { name: 'ECDH', namedCurve: 'P-256' };
// Version, key id, ephemeral public key, nonce and tag: the bytes a sealed blob has on top of its plaintext.
export const SEAL_OVERHEAD = 1 + 8 + 65 + 12 + 16;

// The plaintext's keys, in the order the JSON must have them.
export const GUEST_KEYS = ['name', 'email', 'notes', 'timeZone', 'locale', 'via', 'manageKey', 'type', 'start', 'end'];

export function guestJson(details) {
  const ordered = {};
  for (const k of GUEST_KEYS) ordered[k] = details[k];
  return JSON.stringify(ordered);
}

// keyId = SHA-256(ownerPublicRaw)[0..8].
export async function keyId(publicRaw) {
  return (await sha256(publicRaw)).slice(0, 8);
}

// A raw P-256 public key as WebCrypto takes it. Importing checks that the point is on the curve.
export function importPublic(publicRaw) {
  return crypto.subtle.importKey('raw', publicRaw, P256, true, []);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function hkdf(ikm, salt, info) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, base, 256);
  return new Uint8Array(bits);
}

async function ephemeralPair(given) {
  if (given) {
    const privateKey = await crypto.subtle.importKey('pkcs8', given.privatePkcs8, P256, false, ['deriveBits']);
    return { privateKey, publicRaw: given.publicRaw };
  }
  const pair = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

// Seals details to a page's public key. ephemeral ({ privatePkcs8, publicRaw }) and nonce are injected only by tests,
// so a fixed vector can be reproduced; a booking always gets fresh ones. Returns the blob and, for the vectors, the
// intermediate values.
export async function seal({ publicRaw, handle, bookingId, plaintext, ephemeral = null, nonce = null }) {
  const owner = await importPublic(publicRaw);
  const eph = await ephemeralPair(ephemeral);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: owner }, eph.privateKey, 256));
  const key = await hkdf(ikm, concat(eph.publicRaw, publicRaw), INFO);
  const iv = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const text = typeof plaintext === 'string' ? plaintext : guestJson(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(`${AAD}${handle}:${bookingId}`), tagLength: 128 },
      aes,
      utf8(text)
    )
  );
  const blob = concat(Uint8Array.of(SEAL_VERSION), await keyId(publicRaw), eph.publicRaw, iv, ciphertext);
  return { blob, ikm, key, plaintextJson: text, ephemeralPublic: eph.publicRaw };
}

// Opens a blob with the owner's private key (PKCS #8). The server never does this; the vectors' test does, and it
// is the reference for what the host's devices do.
export async function open({ privatePkcs8, handle, bookingId, blob }) {
  const bytes = typeof blob === 'string' ? fromBase64url(blob) : blob;
  if (!bytes || bytes.length < SEAL_OVERHEAD || bytes[0] !== SEAL_VERSION) throw new Error('Not a sealed booking.');
  const privateKey = await crypto.subtle.importKey('pkcs8', privatePkcs8, P256, true, ['deriveBits']);
  // The public half, through JWK, so the key id and the HKDF salt can be checked and rebuilt.
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const ownerPublic = concat(Uint8Array.of(4), fromBase64url(jwk.x), fromBase64url(jwk.y));
  const id = bytes.slice(1, 9);
  if (toBase64url(id) !== toBase64url(await keyId(ownerPublic))) throw new Error('Sealed to another key.');
  const ephemeralPublic = bytes.slice(9, 74);
  const iv = bytes.slice(74, 86);
  const eph = await importPublic(ephemeralPublic);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: eph }, privateKey, 256));
  const key = await hkdf(ikm, concat(ephemeralPublic, ownerPublic), INFO);
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(`${AAD}${handle}:${bookingId}`), tagLength: 128 },
    aes,
    bytes.slice(86)
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

async function idemKey(idempotencyKey) {
  const bits = await hkdf(utf8(idempotencyKey), new Uint8Array(0), IDEM_INFO);
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// The manage key, sealed under a key derived from the Idempotency-Key that made the booking: nonce ‖ ciphertext ‖
// tag. Only a caller who still has that Idempotency-Key can get the manage key back from a replay.
export async function wrapManageKey(idempotencyKey, bookingId, manageKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(IDEM_AAD + bookingId) },
    await idemKey(idempotencyKey),
    utf8(manageKey)
  );
  return concat(iv, new Uint8Array(out));
}

export async function unwrapManageKey(idempotencyKey, bookingId, wrapped) {
  const bytes = new Uint8Array(wrapped);
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: utf8(IDEM_AAD + bookingId) },
    await idemKey(idempotencyKey),
    bytes.slice(12)
  );
  return new TextDecoder().decode(out);
}

// HMAC-SHA256 under a raw secret, as base64url. For the page's salted hashes: idempotency keys, guests' natural
// keys and client networks.
export async function saltedHash(salt, text) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(text))));
}
