// Binary helpers shared by the Worker and the Durable Object. Binary values travel as base64url without padding,
// as PROTOCOL.md's encoding section says.

const encoder = new TextEncoder();

export function utf8(text) {
  return encoder.encode(text);
}

export function toBase64url(bytes) {
  let binary = '';
  // In slices, because String.fromCharCode takes its bytes as arguments and a 16 KiB record would be too many.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The bytes of a base64url string, or null when it isn't one. Only the canonical spelling counts: the unused low bits
// of the last character must be zero. Otherwise one record id could be written two ways and end up as two records.
export function fromBase64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  let binary;
  try {
    binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return toBase64url(bytes) === text ? bytes : null;
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

// Importing the key is the slow part of an HMAC, and the pepper only changes with a redeploy.
let hmacKey = { secret: null, key: null };

export async function hmac(secret, text) {
  if (hmacKey.secret !== secret) {
    const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKey = { secret, key };
  }
  return new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey.key, utf8(text)));
}

// Compares two secrets or hashes without leaking, through timing, how much of them matched. Lengths aren't secret
// here: every value compared this way has a fixed length.
export function sameBytes(a, b) {
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

// SQLite storage takes an ArrayBuffer for a BLOB. A Uint8Array may be a view on a larger buffer, so copy when it is.
export function blob(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
}
