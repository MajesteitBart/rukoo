'use strict';

// The page's Argon2id, in a dedicated Worker, so the 64 MiB, three-pass hash of a sign-in doesn't hold up the page.
// Bundled to web/argon2-worker.js; argon2.js starts it and ends it again once no hash waits, which gives back the
// WebAssembly memory hash-wasm never shrinks.
//
// In: { id, options }, with hash-wasm's argon2id options. Out: { id, hash } (32 bytes, transferred) or { id, error }.
// The worker holds every request to the account's own limits (crypto.js checkKdf), so no script on the page can use it
// for a larger hash than a sign-in could ask for.
const { checkKdf } = require('./crypto');

async function handle(data, argon2id) {
  const id = data && Number.isSafeInteger(data.id) ? data.id : null;
  try {
    const o = data && data.options;
    if (id === null || !o || typeof o.password !== 'string' || !(o.salt instanceof Uint8Array) || o.salt.length !== 16 || o.hashLength !== 32) {
      throw new Error('argon2');
    }
    checkKdf({ alg: 'argon2id', m: o.memorySize, t: o.iterations, p: o.parallelism });
    const out = await argon2id({
      password: o.password,
      salt: o.salt,
      parallelism: o.parallelism,
      iterations: o.iterations,
      memorySize: o.memorySize,
      hashLength: 32,
      outputType: 'binary'
    });
    // A copy of its own, so transferring it can never detach memory hash-wasm still uses.
    const hash = new Uint8Array(out);
    if (hash.length !== 32) throw new Error('argon2');
    return { id, hash };
  } catch (err) {
    return { id, error: err && err.message ? String(err.message).slice(0, 200) : 'argon2' };
  }
}

// Only inside a worker: Node's tests load this file for handle() alone.
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  const { argon2id } = require('hash-wasm');
  self.onmessage = async ({ data }) => {
    const reply = await handle(data, argon2id);
    self.postMessage(reply, reply.hash ? [reply.hash.buffer] : []);
  };
}

module.exports = { handle };
