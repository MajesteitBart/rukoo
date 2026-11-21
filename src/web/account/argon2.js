'use strict';

// Argon2id for the page, run in web/argon2-worker.js. argon2id() has hash-wasm's signature, so crypto.js takes either
// this or hash-wasm itself (Node's tests). The worker starts with the first hash and is ended once none waits.

const WORKER_URL = 'web/argon2-worker.js';

// Worker and url can be replaced in tests. url is relative to the page, as new Worker() reads it: /app/ gives
// /app/web/argon2-worker.js.
function createArgon2({ Worker: WorkerClass = globalThis.Worker, url = WORKER_URL } = {}) {
  let worker = null;
  let next = 1;
  const waiting = new Map();

  function stop() {
    if (!worker) return;
    worker.terminate();
    worker = null;
  }

  function failAll(err) {
    const jobs = [...waiting.values()];
    waiting.clear();
    stop();
    for (const job of jobs) job.reject(err);
  }

  function start() {
    if (worker) return worker;
    if (typeof WorkerClass !== 'function') throw new Error('argon2: this browser has no Worker');
    const w = new WorkerClass(url);
    w.onmessage = ({ data }) => {
      const job = data && waiting.get(data.id);
      if (!job) return;
      waiting.delete(data.id);
      if (data.hash instanceof Uint8Array && data.hash.length === 32) job.resolve(data.hash);
      else job.reject(new Error(typeof data.error === 'string' ? data.error : 'argon2'));
      if (!waiting.size && worker === w) stop();
    };
    // The script didn't load or run: a missing file, or a CSP without 'wasm-unsafe-eval' for the worker.
    w.onerror = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (worker === w) failAll(new Error(`argon2: ${(event && event.message) || 'the worker failed'}`));
    };
    w.onmessageerror = () => {
      if (worker === w) failAll(new Error('argon2: unreadable answer'));
    };
    worker = w;
    return w;
  }

  return function argon2id(options) {
    return new Promise((resolve, reject) => {
      const id = next++;
      try {
        const o = options || {};
        const w = start();
        waiting.set(id, { resolve, reject });
        w.postMessage({
          id,
          options: {
            password: o.password,
            salt: o.salt,
            parallelism: o.parallelism,
            iterations: o.iterations,
            memorySize: o.memorySize,
            hashLength: o.hashLength
          }
        });
      } catch (err) {
        waiting.delete(id);
        if (!waiting.size) stop();
        reject(err);
      }
    });
  };
}

let shared = null;

// The page's one client, made at the first hash.
function argon2id(options) {
  if (!shared) shared = createArgon2();
  return shared(options);
}

module.exports = { argon2id, createArgon2, WORKER_URL };
