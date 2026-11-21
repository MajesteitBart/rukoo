'use strict';

// fs for the browser build, over the files in memory (shims/vfs.js). The chat cache itself lives in sqlite.js, so
// store.js and the WorkspaceService, which ask whether chat.db or its -wal and -shm files exist and delete them, find
// none, and a wipe always reports that no file stayed behind. What files.js does with it: list and delete the cache's
// folders (readdirSync, rmSync, existsSync), read a file as a stream for its digest and its upload
// (createReadStream), and write a download as it comes (createWriteStream).
const EventEmitter = require('./events');
const path = require('./path');
const vfs = require('./vfs');
const promises = require('./fs-promises');
const { Buffer } = require('./buffer');

// How much of a file a read stream hands over at a time, as Node's 64 KiB highWaterMark does, only larger: each chunk
// is a Blob read.
const CHUNK = 1024 * 1024;
// The chunks a read stream reports what an upload sent with (see pipe).
const ZEROS = new Buffer(CHUNK);

const later = (fn) => Promise.resolve().then(fn);

function existsSync(name) {
  return vfs.kind(name) !== null;
}

function mkdirSync(name) {
  vfs.mkdir(name);
}

function rmSync(name, { force = false, recursive = false } = {}) {
  if (!vfs.remove(name, { recursive }) && !force) throw vfs.error('ENOENT', path.normalize(String(name)), 'rm');
}

function readdirSync(name) {
  return vfs.list(name);
}

function writeFileSync(name, data) {
  vfs.put(name, data);
}

// A file's bytes start to end (inclusive, as Node's options) as a readable stream: an async iterator of Buffers, which
// hashFile reads, and pipe(), which put() sends a transfer's body with. A file that isn't there fails as Node's: with
// an 'error' event, or a throw from the iterator.
class ReadStream extends EventEmitter {
  constructor(name, { start = 0, end = Infinity } = {}) {
    super();
    this.path = path.normalize(String(name));
    this.blob = vfs.get(this.path);
    this.start = Math.max(0, start);
    this.stop = this.blob ? Math.min(this.blob.size, end === Infinity ? Infinity : end + 1) : 0;
    this.destroyed = false;
    this.closed = false;
    if (!this.blob) later(() => this.fail(vfs.error('ENOENT', this.path, 'open')));
  }

  fail(err) {
    if (this.destroyed) return;
    this.destroy();
    if (this.listenerCount('error')) this.emit('error', err);
  }

  async *[Symbol.asyncIterator]() {
    if (!this.blob) throw vfs.error('ENOENT', this.path, 'open');
    try {
      for (let at = this.start; at < this.stop && !this.destroyed; at += CHUNK) {
        const part = await this.blob.slice(at, Math.min(at + CHUNK, this.stop)).arrayBuffer();
        if (this.destroyed) return;
        yield new Buffer(part);
      }
    } finally {
      this.destroy();
    }
  }

  // The stream's bytes into dest. A request of shims/http.js takes them as one Blob (sendBlob), which the browser
  // uploads itself; 'data' then reports what went as it goes, as chunks of zeros of that length: files.js counts them
  // for the upload's progress and reads nothing else of them. Any other writable gets the bytes chunk by chunk.
  pipe(dest) {
    if (!this.blob) return dest;
    const slice = this.blob.slice(this.start, this.stop);
    if (typeof dest.sendBlob === 'function') {
      dest.sendBlob(slice, (sent) => {
        for (let left = sent; left > 0 && !this.destroyed; left -= CHUNK) this.emit('data', ZEROS.subarray(0, Math.min(left, CHUNK)));
      });
      return dest;
    }
    (async () => {
      for await (const chunk of this) {
        this.emit('data', chunk);
        dest.write(chunk);
      }
      dest.end();
    })().catch((err) => this.fail(err));
    return dest;
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    later(() => {
      if (err && this.listenerCount('error')) this.emit('error', err);
      this.closed = true;
      this.emit('close');
    });
    return this;
  }
}

// A file written chunk by chunk, which exists with all of them once end() is called; until then, and after a
// destroy(), it isn't there at all. Events as Node's: 'finish' after end(), then 'close'; destroy() closes too.
class WriteStream extends EventEmitter {
  constructor(name) {
    super();
    this.path = path.normalize(String(name));
    this.chunks = [];
    this.bytesWritten = 0;
    this.writable = true;
    this.destroyed = false;
    this.closed = false;
  }

  write(chunk, encoding, cb) {
    const done = typeof encoding === 'function' ? encoding : cb;
    if (!this.writable) {
      const err = new Error('write after end');
      err.code = 'ERR_STREAM_WRITE_AFTER_END';
      later(() => (done ? done(err) : this.emit('error', err)));
      return false;
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined) : chunk;
    this.chunks.push(bytes);
    this.bytesWritten += bytes.length;
    if (done) later(() => done(null));
    return true;
  }

  end(chunk, encoding, cb) {
    const done = [chunk, encoding, cb].find((x) => typeof x === 'function');
    if (chunk !== undefined && typeof chunk !== 'function') this.write(chunk, typeof encoding === 'string' ? encoding : undefined);
    if (!this.writable) return this;
    this.writable = false;
    try {
      vfs.put(this.path, new Blob(this.chunks));
    } catch (err) {
      this.chunks = null;
      this.destroy(err);
      return this;
    }
    this.chunks = null;
    later(() => {
      this.emit('finish');
      if (done) done();
      this.destroyed = true;
      this.closed = true;
      this.emit('close');
    });
    return this;
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    this.chunks = null;
    later(() => {
      if (err && this.listenerCount('error')) this.emit('error', err);
      this.closed = true;
      this.emit('close');
    });
    return this;
  }
}

const createReadStream = (name, options) => new ReadStream(name, options);
const createWriteStream = (name) => new WriteStream(name);

module.exports = {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  writeFileSync,
  createReadStream,
  createWriteStream,
  ReadStream,
  WriteStream,
  promises
};
