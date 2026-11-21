'use strict';

// http and https for the browser build: the request() of Node's client, as far as files.js's transfer() uses it to move
// a file's bytes (the account's own calls go through the web account service). A request without a body (a download)
// goes out with fetch, which streams the answer and can refuse a redirect; one with a body (an upload's PUT) with
// XMLHttpRequest, the one browser API that reports upload progress, or with fetch where there is none (Node, for the
// tests). fetch sends no cookies, no referrer and caches nothing, as transfer() asks of Node. XMLHttpRequest can't
// leave out the site's own cookies on a same-origin request, and the links are same-origin on rukoo.io, but the site
// sets none; the page's Referrer-Policy (no-referrer) keeps the referrer out, and a PUT is never cached.
//
// What matches Node: request(url, options, onResponse) returns a request with end(), destroy(err) and the events
// 'error', 'timeout' (options.timeout ms without bytes going either way) and 'close'; the answer has statusCode,
// headers (lowercase names), resume() and the events 'data', 'end' and 'error', and is an async iterator of Buffers for
// stream.pipeline. A body is piped in from fs.createReadStream (shims/fs.js), which hands its Blob over with sendBlob().
// What differs, because a page can't do it:
// - Headers a browser sets itself (content-length, accept-encoding and the rest of the Fetch standard's forbidden
//   names) are left out, which also keeps XMLHttpRequest from logging "Refused to set unsafe header". The browser sends
//   the Blob's own length, and takes compressed answers apart before the page sees them.
// - XMLHttpRequest follows a redirect by itself; an answer from anywhere but the request's own address counts as a
//   redirect (302) afterwards, which transfer() refuses. fetch's redirect: 'manual' refuses it before it is followed.
const EventEmitter = require('./events');
const { Buffer } = require('./buffer');

const FORBIDDEN = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via'
]);
const allowedHeader = (name) => !FORBIDDEN.has(name) && !name.startsWith('proxy-') && !name.startsWith('sec-');

const later = (fn) => Promise.resolve().then(fn);
const toBuffer = (bytes) => new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function hangUp() {
  const err = new Error('socket hang up');
  err.code = 'ECONNRESET';
  return err;
}

// An answer. next() gives the next chunk or null at the end; stop(err) gives up on the rest.
class IncomingMessage extends EventEmitter {
  constructor(statusCode, headers, { next, stop }) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
    this.next = next;
    this.stop = stop;
    this.reading = false;
    this.ended = false;
    this.destroyed = false;
    this.error = null;
  }

  // A 'data' listener starts the answer flowing, once the response callback has added the others.
  on(name, fn) {
    super.on(name, fn);
    if (name === 'data') later(() => this.flow());
    return this;
  }

  async flow() {
    if (this.reading) return;
    try {
      for await (const chunk of this) if (this.listenerCount('data')) this.emit('data', chunk);
      if (!this.destroyed) this.emit('end');
    } catch (err) {
      if (this.listenerCount('error')) this.emit('error', err);
    }
  }

  async *[Symbol.asyncIterator]() {
    if (this.reading) throw new Error('The answer is being read already');
    this.reading = true;
    for (;;) {
      if (this.destroyed) throw this.error || hangUp();
      const chunk = await this.next();
      if (this.destroyed) throw this.error || hangUp();
      if (chunk === null) {
        this.ended = true;
        return;
      }
      yield chunk;
    }
  }

  // Without a 'data' listener: the rest of the answer isn't wanted.
  resume() {
    if (!this.reading && !this.listenerCount('data')) {
      this.reading = true;
      this.stop(null);
    }
    return this;
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.error = err || null;
    this.stop(err || null);
    return this;
  }
}

function headersOf(fetchHeaders) {
  const out = {};
  if (fetchHeaders && typeof fetchHeaders.forEach === 'function') fetchHeaders.forEach((value, name) => (out[name.toLowerCase()] = value));
  return out;
}

function parseHeaders(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

const sameAddress = (a, b) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch (_) {
    return false;
  }
};

class ClientRequest extends EventEmitter {
  constructor(url, options, onResponse) {
    super();
    this.url = String(url);
    this.method = String(options.method || 'GET').toUpperCase();
    this.headers = {};
    for (const [name, value] of Object.entries(options.headers || {})) {
      const n = name.toLowerCase();
      if (allowedHeader(n) && value !== undefined) this.headers[n] = String(value);
    }
    this.timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 0;
    this.onResponse = typeof onResponse === 'function' ? onResponse : null;
    this.body = null;
    this.parts = [];
    this.onSent = null;
    this.started = false;
    this.destroyed = false;
    this.closed = false;
    this.res = null;
    this.timer = null;
    this.controller = new AbortController();
    this.xhr = null;
  }

  // The idle timer: 'timeout' once nothing went either way for options.timeout ms.
  arm() {
    if (!this.timeout || this.destroyed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.destroyed) this.emit('timeout');
    }, this.timeout);
  }

  disarm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.disarm();
    later(() => this.emit('close'));
  }

  // The body as one Blob (fs.createReadStream's pipe). onSent(bytes) for each part the browser reports as sent.
  sendBlob(blob, onSent) {
    this.body = blob;
    this.onSent = onSent;
    this.end();
  }

  write(chunk) {
    this.parts.push(chunk);
    return true;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    if (this.started) return this;
    this.started = true;
    if (!this.body && this.parts.length) this.body = new Blob(this.parts);
    this.parts = [];
    later(() => this.start());
    return this;
  }

  fail(err) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disarm();
    if (this.res) this.res.destroy(err);
    if (this.listenerCount('error')) this.emit('error', err);
    this.close();
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.disarm();
    this.controller.abort(err || hangUp());
    if (this.xhr) {
      try {
        this.xhr.abort();
      } catch (_) {
        // Done already.
      }
    }
    if (this.res) this.res.destroy(err);
    // Destroyed before an answer, as Node: an error even without one given.
    const reported = err || (this.res ? null : hangUp());
    later(() => {
      if (reported && this.listenerCount('error')) this.emit('error', reported);
    });
    this.close();
    return this;
  }

  respond(res) {
    this.res = res;
    if (this.destroyed) {
      res.destroy(this.controller.signal.reason);
      return;
    }
    if (this.onResponse) this.onResponse(res);
    else this.emit('response', res);
  }

  sent(bytes) {
    if (bytes > 0 && this.onSent) this.onSent(bytes);
  }

  start() {
    if (this.destroyed) return;
    this.arm();
    if (this.body && typeof globalThis.XMLHttpRequest === 'function') this.startXhr();
    else this.startFetch();
  }

  async startFetch() {
    const body = this.body;
    let answer;
    try {
      answer = await globalThis.fetch(this.url, {
        method: this.method,
        headers: this.headers,
        body: body || undefined,
        signal: this.controller.signal,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      });
    } catch (err) {
      if (!this.destroyed) this.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.destroyed) return;
    // fetch sends the body before it gives an answer.
    if (body) this.sent(body.size);
    this.arm();
    const status = answer.type === 'opaqueredirect' ? 302 : answer.status;
    const reader = answer.body && status !== 302 ? answer.body.getReader() : null;
    const res = new IncomingMessage(status, headersOf(answer.headers), {
      next: async () => {
        if (!reader) {
          this.close();
          return null;
        }
        const { done, value } = await reader.read();
        if (done) {
          this.close();
          return null;
        }
        this.arm();
        return toBuffer(value);
      },
      stop: (err) => {
        if (reader) reader.cancel(err || undefined).catch(() => {});
        else if (answer.body) answer.body.cancel().catch(() => {});
        this.close();
      }
    });
    this.respond(res);
  }

  startXhr() {
    const xhr = new globalThis.XMLHttpRequest();
    this.xhr = xhr;
    const size = this.body.size;
    let reported = 0;
    xhr.open(this.method, this.url, true);
    xhr.responseType = 'arraybuffer';
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(this.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      this.arm();
      const loaded = Math.min(size, Number(e.loaded) || 0);
      if (loaded > reported) {
        const delta = loaded - reported;
        reported = loaded;
        this.sent(delta);
      }
    };
    xhr.onprogress = () => this.arm();
    xhr.onerror = () => {
      if (!this.destroyed) this.fail(new Error('The upload failed: no answer from the server'));
    };
    xhr.onload = () => {
      if (this.destroyed) return;
      if (reported < size) {
        this.sent(size - reported);
        reported = size;
      }
      const status = xhr.responseURL && !sameAddress(xhr.responseURL, this.url) ? 302 : xhr.status;
      let bytes = xhr.response instanceof ArrayBuffer ? new Uint8Array(xhr.response) : new Uint8Array(0);
      if (status === 302) bytes = new Uint8Array(0);
      let given = false;
      const res = new IncomingMessage(status, status === 302 ? {} : parseHeaders(xhr.getAllResponseHeaders()), {
        next: async () => {
          if (given || !bytes.length) {
            this.close();
            return null;
          }
          given = true;
          return toBuffer(bytes);
        },
        stop: () => this.close()
      });
      this.respond(res);
    };
    xhr.send(this.body);
  }
}

// request(url, options, onResponse), request(url, onResponse) or request(options, onResponse) with options.href or
// options.protocol, host and path, as Node takes them.
function request(url, options, onResponse) {
  let target = url;
  let opts = options;
  let cb = onResponse;
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  if (target && typeof target === 'object' && !(target instanceof URL) && !opts) {
    opts = target;
    target = null;
  }
  opts = opts || {};
  if (!target) target = opts.href || `${opts.protocol || 'http:'}//${opts.host || opts.hostname}${opts.path || '/'}`;
  return new ClientRequest(target, opts, cb);
}

function get(url, options, onResponse) {
  const req = request(url, options, onResponse);
  req.end();
  return req;
}

module.exports = { request, get, ClientRequest, IncomingMessage };
