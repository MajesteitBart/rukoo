'use strict';

// crypto for the browser build. wire.js takes randomBytes from it, for operation IDs (uuidv7) and the handles of
// unsent messages (localId, which reads them as base64url), so the bytes come as a Buffer (shims/buffer.js).
const { Buffer } = require('./buffer');

// getRandomValues fills at most 65,536 bytes per call.
const CHUNK = 65536;

function randomBytes(size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('The "size" argument must be a whole number of bytes');
  const out = Buffer.alloc(size);
  for (let at = 0; at < size; at += CHUNK) globalThis.crypto.getRandomValues(out.subarray(at, Math.min(at + CHUNK, size)));
  return out;
}

module.exports = { randomBytes };
