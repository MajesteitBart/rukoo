'use strict';

// The booking page's key pair and the guest details sealed to it (server/PROTOCOL.md, Sealed guest details; design
// 3.5). The server seals with WebCrypto; this opens the same bytes with Node's crypto, and the shared vectors in
// server/test/fixtures/booking-vectors.json keep the two in step.

const crypto = require('crypto');

const VERSION = 0x02;
const INFO = Buffer.from('rukoo/v1/booking-guest', 'utf8');
const AAD = 'rukoo/v1/booking:';
const NONCE = 12;
const TAG = 16;
// Version, key id, ephemeral public key, nonce and tag.
const OVERHEAD = 1 + 8 + 65 + NONCE + TAG;
const KID = /^[A-Za-z0-9_-]{11}$/;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function unb64u(text, bytes = null) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url');
  const buf = Buffer.from(text, 'base64url');
  if (bytes !== null && buf.length !== bytes) throw new Error('invalid length');
  return buf;
}

// keyId = SHA-256(publicRaw)[0..8], base64url: 11 characters.
const kidOf = (publicRaw) => b64u(crypto.createHash('sha256').update(publicRaw).digest().subarray(0, 8));

// An uncompressed P-256 point (0x04 ‖ x ‖ y) as a key object.
function publicKey(raw) {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('not an uncompressed P-256 point');
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
}

function rawOf(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

// A new keyring with one key (contracts g, BookingKeyring).
function newKeyring(now = Date.now()) {
  const { privateKey, publicKey: pub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicRaw = rawOf(pub);
  const kid = kidOf(publicRaw);
  return { current: kid, keys: { [kid]: { privatePkcs8: b64u(privateKey.export({ format: 'der', type: 'pkcs8' })), publicRaw: b64u(publicRaw), createdAt: now } } };
}

// The keyring's keys that hold together: a private key whose public half is the stored one, under its own key id.
// Returns Map(kid -> { privateKey, publicRaw }) and the current key id, or null when the current key is unusable.
function openKeyring(keyring) {
  if (!keyring || typeof keyring !== 'object' || typeof keyring.current !== 'string' || !keyring.keys || typeof keyring.keys !== 'object') return null;
  const keys = new Map();
  for (const [kid, k] of Object.entries(keyring.keys)) {
    try {
      if (!KID.test(kid) || !k || typeof k !== 'object') continue;
      const publicRaw = unb64u(k.publicRaw, 65);
      if (kidOf(publicRaw) !== kid) continue;
      const privateKey = crypto.createPrivateKey({ key: unb64u(k.privatePkcs8), format: 'der', type: 'pkcs8' });
      if (!rawOf(crypto.createPublicKey(privateKey)).equals(publicRaw)) continue;
      keys.set(kid, { privateKey, publicRaw });
    } catch (_) {
      // A damaged key is left out; the current one being damaged makes the keyring unusable.
    }
  }
  if (!keys.has(keyring.current)) return null;
  return { current: keyring.current, keys };
}

// What the page publishes about its key.
function published(opened) {
  const k = opened.keys.get(opened.current);
  return { keyId: opened.current, publicKey: b64u(k.publicRaw) };
}

// Opens a sealed blob with whichever of the keyring's keys it was sealed to. Returns the plaintext JSON text; throws
// when the blob is damaged, was sealed to a key this keyring doesn't have, or doesn't belong to this booking.
function openSealed(opened, { handle, bookingId, blob }) {
  const bytes = unb64u(blob);
  if (bytes.length < OVERHEAD || bytes[0] !== VERSION) throw new Error('not a sealed booking');
  const kid = b64u(bytes.subarray(1, 9));
  const key = opened && opened.keys.get(kid);
  if (!key) throw Object.assign(new Error('sealed to another key'), { unknownKey: true });
  const ephemeralRaw = bytes.subarray(9, 74);
  const nonce = bytes.subarray(74, 86);
  const ikm = crypto.diffieHellman({ privateKey: key.privateKey, publicKey: publicKey(ephemeralRaw) });
  const aesKey = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.concat([ephemeralRaw, key.publicRaw]), INFO, 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAAD(Buffer.from(`${AAD}${handle}:${bookingId}`, 'utf8'));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG));
  const plain = Buffer.concat([decipher.update(bytes.subarray(86, bytes.length - TAG)), decipher.final()]);
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

module.exports = { kidOf, newKeyring, openKeyring, published, openSealed };
