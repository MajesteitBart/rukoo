'use strict';

// stream for the browser build, as far as files.js's transfer() uses it for a download: pipeline(response, meter,
// file, callback), where meter is a Transform that counts and checks each chunk. Here a pipeline reads the source as an
// async iterator (shims/http.js's response, shims/fs.js's read stream), runs each chunk through the transforms in turn,
// writes what comes out to the last stream and ends it. Any error, a transform's, the source's or the destination's
// 'error', destroys all of them and reaches the callback, once, as Node's pipeline does.
const EventEmitter = require('./events');

class Transform extends EventEmitter {
  // options.transform(chunk, encoding, done), with done(err, chunk) as Node's.
  constructor(options = {}) {
    super();
    this.transformChunk = typeof options.transform === 'function' ? options.transform : (chunk, _encoding, done) => done(null, chunk);
    this.destroyed = false;
  }

  // One chunk through the transform: what it passes on, or undefined for nothing.
  run(chunk) {
    return new Promise((resolve, reject) => {
      let called = false;
      try {
        this.transformChunk.call(this, chunk, 'buffer', (err, out) => {
          if (called) return;
          called = true;
          if (err) reject(err);
          else resolve(out);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    Promise.resolve().then(() => {
      if (err && this.listenerCount('error')) this.emit('error', err);
      this.emit('close');
    });
    return this;
  }
}

function pipeline(...streams) {
  const callback = typeof streams[streams.length - 1] === 'function' ? streams.pop() : null;
  if (streams.length < 2) throw new TypeError('pipeline needs a source and a destination');
  const source = streams[0];
  const dest = streams[streams.length - 1];
  const transforms = streams.slice(1, -1);
  let settled = false;
  let failWith = null;
  const failed = new Promise((_, reject) => {
    failWith = reject;
  });
  failed.catch(() => {});
  const finish = (err) => {
    if (settled) return;
    settled = true;
    if (err) {
      for (const s of streams) {
        try {
          if (typeof s.destroy === 'function') s.destroy();
        } catch (_) {
          // Gone already.
        }
      }
    }
    if (callback) callback(err || undefined);
  };
  // A destination or transform that fails by itself (a full store, a destroy from elsewhere) ends the pipeline.
  for (const s of [...transforms, dest]) if (typeof s.on === 'function') s.on('error', (err) => failWith(err));

  (async () => {
    const iterator = source[Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([iterator.next(), failed]);
      if (step.done) break;
      let chunk = step.value;
      for (const t of transforms) {
        chunk = await Promise.race([t.run(chunk), failed]);
        if (chunk === undefined || chunk === null) break;
      }
      if (chunk !== undefined && chunk !== null) dest.write(chunk);
    }
    await Promise.race([
      new Promise((resolve) => {
        dest.once('finish', resolve);
        dest.end();
      }),
      failed
    ]);
  })().then(
    () => finish(null),
    (err) => finish(err || new Error('pipeline failed'))
  );
  return dest;
}

module.exports = { Transform, pipeline };
