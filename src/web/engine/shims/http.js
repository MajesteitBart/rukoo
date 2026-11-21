'use strict';

// http and https for the browser build: the request() of Node's client, as far as files.js's transfer() uses it to move
// a file's bytes (the account's own calls go through the web account service). Every request goes out with fetch:
// redirect 'manual', so a redirect is refused before the browser follows it (with an upload's body, to wherever it
// points); credentials 'omit', so no cookie goes, the site's own included; no referrer; and nothing cached, as
// transfer() asks of Node. The answer is read as a stream, so transfer() stops reading at its own limits.
//
// What matches Node: request(url, options, onResponse) returns a request with end(), destroy(err) and the events
// 'error', 'timeout' (options.timeout ms without bytes going either way) and 'close'; the answer has statusCode,
// headers (lowercase names), resume() and the events 'data', 'end' and 'error', and is an async iterator of Buffers for
// stream.pipeline. A body is piped in from fs.createReadStream (shims/fs.js), which hands its Blob over with sendBlob().
// What differs, because a page can't do it:
// - Headers a browser sets itself (content-length, accept-encoding and the rest of the Fetch standard's forbidden
//   names) are left out. The browser sends the Blob's own length, and takes compressed answers apart before the page
//   sees them.
// - fetch says nothing of a body while it goes, so the body counts as sent once the answer comes (sendBlob's onSent),
//   and until then the idle timer also gives it the time every body on its way would take at a slow connection's pace
//   (UPLOAD_RATE, the backlog below). XMLHttpRequest reports upload progress, but it follows a redirect with the body
//   and sends the site's cookies.
// - A redirect's answer is opaque to the page (status 0): it counts as a 302, which transfer() refuses.
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

// The slowest pace, in bytes a second, of a connection whose uploads count as still going while the page can't see
// them: about 128 kbit/s for all of them together, under a weak mobile connection's upload. A 25 MiB file alone then
// has 27 minutes before its request times out. A slower connection fails the upload, where desktop sees each byte go.
const UPLOAD_RATE = 16 * 1024;

// The bodies on their way share one connection: files.js sends up to three at once (TRANSFERS), each at a share of its
// pace. So a request's allowance runs until every body on its way would have gone at UPLOAD_RATE (backlog), and a body
// that starts moves the others' timers on with it. A body that is done frees its share: the others then need at most
// their own bytes at that pace from then on.
// request -> its body's size.
const sending = new Map();
// When, in Date.now() ms, every body in sending would have gone at UPLOAD_RATE.
let backlog = 0;
const paced = (bytes) => Math.ceil((bytes / UPLOAD_RATE) * 1000);

function rearmSending() {
  const left = Math.max(0, backlog - Date.now());
  for (const req of sending.keys()) req.arm(req.timeout + left);
}

function startSending(req, size) {
  backlog = Math.max(backlog, Date.now()) + paced(size);
  sending.set(req, size);
  rearmSending();
}

function stopSending(req) {
  if (!sending.delete(req)) return;
  let rest = 0;
  for (const size of sending.values()) rest += size;
  backlog = Math.min(backlog, Date.now() + paced(rest));
  rearmSending();
}

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
  }

  // The idle timer: 'timeout' once nothing went either way for options.timeout ms, or for ms.
  arm(ms = this.timeout) {
    if (!this.timeout || this.destroyed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.destroyed) this.emit('timeout');
    }, ms);
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

  // The body as one Blob (fs.createReadStream's pipe). onSent(bytes) with its whole size once the answer came.
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
    stopSending(this);
    this.disarm();
    if (this.res) this.res.destroy(err);
    if (this.listenerCount('error')) this.emit('error', err);
    this.close();
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    stopSending(this);
    this.disarm();
    this.controller.abort(err || hangUp());
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

  async start() {
    if (this.destroyed) return;
    const body = this.body;
    // Until the answer, nothing the page can see goes either way while the browser sends a body.
    if (body) startSending(this, body.size);
    else this.arm();
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
    // An answer: the body went, or the server refused it early, which fails the upload anyway. Either way there is no
    // finer count to give.
    stopSending(this);
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
