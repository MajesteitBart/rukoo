'use strict';

// Short-lived links to a meeting's media (RUK-110). get_meeting_media_link issues them; GET /media/v1/<token> on the
// MCP listeners (mcp.js) serves them. Rukoo Voice keeps the media and the key that decrypts the user's bucket, so the
// bytes come from Voice over the bridge (media.open, then media.read in 1 MiB pieces); an agent never reads a bucket.
//
// A token is the payload in base64url, a dot, and an HMAC-SHA256 of it under a key that exists only in this process,
// so every link dies when Rukoo quits. The payload names one meeting, one kind and one stretch, the expiry, the agent,
// the listener, the address the agent called from and a binding to the MCP token it called with. The GET carries no
// credential of its own: each fetch checks the binding against the tokens Rukoo still accepts, and a stream checks it
// again before every piece, so a link stops with its chat, its Codex process or the agent's switch. Tokens are never
// logged.

const crypto = require('crypto');
const { Limiter, peerOf } = require('./phonehost');
const { isMeetingId } = require('../voice/protocol');

const MEDIA_LINK_TTL_MS = 5 * 60 * 1000;
// = MEDIA_READ_MAX in voice/protocol.js: the most one media.read returns.
const READ_CHUNK = 1024 * 1024;
const PREPARE_WAIT_MS = 120 * 1000;
// A download that started before expiry may finish, but never later than this after the link expired.
const STREAM_MAX_MS = 15 * 60 * 1000;
const MAX_STREAMS = 3;
const REQUESTS_PER_MINUTE = 60;
const BAD_TOKENS_PER_MINUTE = 20;
const BLOCK_MS = 5 * 60 * 1000;
const MINUTE = 60 * 1000;
// media.open's polling: every 250 ms at first, then up to once a second.
const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 1000;
// setTimeout takes at most this; anything longer fires at once.
const TIMER_MAX = 2 ** 31 - 1;

const TYPES = { audio: 'audio/wav', frame: 'image/jpeg', video: 'video/mp4' };
const EXTENSIONS = { audio: 'wav', frame: 'jpg', video: 'mp4' };
const PATH = /^\/media\/v1\/([A-Za-z0-9_-]{20,600})\.([A-Za-z0-9_-]{43})(\/[^/]*)?$/;
const TOKEN = /^([A-Za-z0-9_-]{20,600})\.([A-Za-z0-9_-]{43})$/;
const MEDIA_ID = /^md-[A-Za-z0-9_-]{22}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SIGN_PREFIX = 'rukoo-media-v1.';

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isLoopback = (ip) => /^127\./.test(ip) || ip === '::1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The cosmetic file name at the end of a link and in Content-Disposition: <meeting>-<kind>-<from>-<to>.<ext> in
// seconds, or <meeting>-frame-<at>.jpg. The route ignores the name in the path; this one comes from the payload.
function mediaFileName({ meeting, kind, start, end }) {
  const from = Math.floor(start / 1000);
  const range = end === null || end === undefined ? `${from}` : `${from}-${Math.ceil(end / 1000)}`;
  return `${meeting}-${kind}-${range}.${EXTENSIONS[kind]}`;
}

// One Range header against a file of size bytes: { start, end } (end inclusive), null for none, for several ranges
// or for one Rukoo can't read (the whole file is sent), or 'unsatisfiable'.
function parseRange(header, size) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

function validPayload(p) {
  return (
    isObj(p) &&
    isMeetingId(p.m) &&
    Object.hasOwn(TYPES, p.k) &&
    Number.isSafeInteger(p.s) &&
    p.s >= 0 &&
    (p.e === null || (Number.isSafeInteger(p.e) && p.e >= p.s)) &&
    Number.isFinite(p.x) &&
    typeof p.a === 'string' &&
    typeof p.r === 'boolean' &&
    (p.p === null || typeof p.p === 'string') &&
    (p.t === null || typeof p.t === 'string')
  );
}

// An answer without a body to read: JSON with the code, or headers alone for HEAD.
function fail(req, res, status, code, extra = {}) {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify({ error: code });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra });
  return res.end(req.method === 'HEAD' ? undefined : body);
}

// Until the response can take more, or is gone.
function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

class MediaLinks {
  // voice(): the VoiceService or null. canRead(): "Agents can read meetings". agentAllowed(agent, remote): the agent
  // may still use Rukoo on that listener. tokenLive(agent, remote, bind): a token Rukoo issued to that agent for that
  // listener still gives bind (bindOf). endpoint(remote): { host, port } of the listener a link must use, or null.
  // now, ttlMs, prepareWaitMs, streamMaxMs and maxStreams for tests.
  constructor({
    voice = () => null,
    canRead = () => true,
    agentAllowed = () => true,
    tokenLive = () => false,
    endpoint = () => null,
    now = Date.now,
    ttlMs = MEDIA_LINK_TTL_MS,
    prepareWaitMs = PREPARE_WAIT_MS,
    streamMaxMs = STREAM_MAX_MS,
    maxStreams = MAX_STREAMS,
    log = () => {}
  } = {}) {
    this.voice = voice;
    this.canRead = canRead;
    this.agentAllowed = agentAllowed;
    this.tokenLive = tokenLive;
    this.endpoint = endpoint;
    this.now = now;
    this.ttlMs = ttlMs;
    this.prepareWaitMs = prepareWaitMs;
    this.streamMaxMs = streamMaxMs;
    this.maxStreams = maxStreams;
    this.log = log;
    this.key = crypto.randomBytes(32);
    this.streams = 0;
    this.requests = new Limiter(REQUESTS_PER_MINUTE, MINUTE, now);
    this.badTokens = new Limiter(BAD_TOKENS_PER_MINUTE, MINUTE, now);
    this.blocked = new Map();
    this.swept = 0;
  }

  sign(body) {
    return crypto.createHmac('sha256', this.key).update(SIGN_PREFIX + body).digest('base64url');
  }

  // What a link stores of the MCP token it was issued under: 22 characters of an HMAC of the token's hash, so the
  // payload names the token without carrying anything that could stand in for it.
  bindOf(tokenHash) {
    return crypto.createHmac('sha256', this.key).update(`tok${tokenHash}`).digest('base64url').slice(0, 22);
  }

  // { url, expiresAt, name }, or null when the listener the agent needs isn't open. peer: the address the MCP request
  // came from (null: only loopback on the local listener may fetch). tokenHash: the hex SHA-256 of the MCP token the
  // agent called with (null for a call from inside Rukoo, such as the test agent, which no token can revoke).
  issue({ agent, remote = false, peer = null, tokenHash = null, meeting, kind, start, end = null }) {
    if (!isMeetingId(meeting) || !Object.hasOwn(TYPES, kind) || !Number.isSafeInteger(start) || start < 0) throw new TypeError('invalid media link');
    if (end !== null && (!Number.isSafeInteger(end) || end < start)) throw new TypeError('invalid media link end');
    const at = this.endpoint(Boolean(remote));
    if (!at || !at.host || !at.port) return null;
    const x = this.now() + this.ttlMs;
    const payload = {
      v: 1,
      m: meeting,
      k: kind,
      s: start,
      e: end,
      x,
      a: String(agent),
      r: Boolean(remote),
      p: typeof peer === 'string' && peer ? peer : null,
      t: typeof tokenHash === 'string' && tokenHash ? this.bindOf(tokenHash) : null,
      n: crypto.randomBytes(8).toString('base64url')
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const name = mediaFileName({ meeting, kind, start, end });
    const host = String(at.host).includes(':') ? `[${at.host}]` : at.host;
    return { url: `http://${host}:${at.port}/media/v1/${body}.${this.sign(body)}/${name}`, expiresAt: x, name };
  }

  // The payload, or null when the token isn't one this process signed. No expiry or listener check.
  verify(token) {
    const m = TOKEN.exec(String(token || ''));
    if (!m) return null;
    const want = Buffer.from(this.sign(m[1]), 'utf8');
    const got = Buffer.from(m[2], 'utf8');
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
      const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      return isObj(payload) ? payload : null;
    } catch (_) {
      return null;
    }
  }

  // Old rate-limit windows and blocks go, at most once a minute, as requests come in.
  sweep() {
    const t = this.now();
    if (t - this.swept < MINUTE) return;
    this.swept = t;
    this.requests.prune();
    this.badTokens.prune();
    for (const [ip, until] of this.blocked) if (until <= t) this.blocked.delete(ip);
  }

  // GET or HEAD /media/v1/<token>[/<name>]. Never throws: it answers, or destroys a response it started.
  handle(entry, req, res, pathname) {
    this.serve(entry, req, res, pathname).catch((err) => {
      this.log('request failed:', (err && err.message) || err);
      if (!res.headersSent) fail(req, res, 500, 'unknown');
      else res.destroy();
    });
  }

  async serve(entry, req, res, pathname) {
    // A GET has no body; whatever came along is read and dropped, so the connection stays usable.
    req.on('error', () => {});
    req.resume();
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(req, res, 405, 'method-not-allowed', { Allow: 'GET, HEAD' });
    this.sweep();
    const peer = peerOf(req);
    const now = this.now();
    const until = this.blocked.get(peer);
    if (until && until > now) return fail(req, res, 429, 'rate-limited', { 'Retry-After': String(Math.ceil((until - now) / 1000)) });
    const m = PATH.exec(pathname);
    const payload = m ? this.verify(`${m[1]}.${m[2]}`) : null;
    if (!payload) {
      if (!this.badTokens.take(peer)) {
        this.blocked.set(peer, now + BLOCK_MS);
        this.log('blocked', peer, 'for bad links');
        return fail(req, res, 429, 'rate-limited', { 'Retry-After': String(BLOCK_MS / 1000) });
      }
      return fail(req, res, 403, 'forbidden');
    }
    if (payload.v !== 1 || !validPayload(payload)) return fail(req, res, 403, 'forbidden');
    const p = payload;
    const what = `${p.a} ${p.k} ${p.m}`;
    if (now > p.x) return fail(req, res, 410, 'expired');
    if (Boolean(entry.remote) !== p.r) return fail(req, res, 404, 'not-found');
    const fromCaller = p.p === null ? isLoopback(peer) && !entry.remote : peer === p.p;
    if (!fromCaller) return fail(req, res, 403, 'forbidden');
    if (!this.canRead()) return fail(req, res, 403, 'meetings-off');
    if (!this.agentAllowed(p.a, p.r)) return fail(req, res, 403, 'agent-off');
    if (p.t !== null && !this.tokenLive(p.a, p.r, p.t)) return fail(req, res, 403, 'token-gone');
    if (!this.requests.take(peer)) return fail(req, res, 429, 'rate-limited', { 'Retry-After': this.requests.retryAfter(peer) });
    if (this.streams >= this.maxStreams) return fail(req, res, 429, 'busy', { 'Retry-After': '5' });
    const voice = this.voice();
    if (!voice || !voice.connected) return fail(req, res, 503, 'voice-offline', { 'Retry-After': '10' });

    // From here the request holds one of the streams until its response is over, however it ends.
    this.streams++;
    let closed = false;
    let timer = null;
    res.once('close', () => {
      closed = true;
      this.streams--;
      clearTimeout(timer);
    });
    const args = { meeting: p.m, kind: p.k, start: p.s, ...(p.e === null ? {} : { end: p.e }) };
    const opened = await this.prepare(voice, args, () => closed);
    if (closed) return undefined;
    if (!opened.ready) {
      const code = opened.error ? opened.error.code : 'preparing';
      this.log('not served', what, code);
      return this.openFailed(req, res, code);
    }
    const ready = opened.ready;
    if (ready.type !== TYPES[p.k] || !Number.isSafeInteger(ready.size) || ready.size < 0 || typeof ready.media !== 'string' || !MEDIA_ID.test(ready.media)) {
      this.log('not served', what, 'bad answer');
      return fail(req, res, 502, 'bad-media');
    }
    const size = ready.size;
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') return fail(req, res, 416, 'range', { 'Content-Range': `bytes */${size}` });
    const from = range ? range.start : 0;
    const to = range ? range.end + 1 : size;
    const name = mediaFileName({ meeting: p.m, kind: p.k, start: p.s, end: p.e });
    res.writeHead(range ? 206 : 200, {
      'Content-Type': ready.type,
      'Content-Length': to - from,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${from}-${to - 1}/${size}` } : {}),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Disposition': `attachment; filename="${name}"`
    });
    if (req.method === 'HEAD') return res.end();
    // The status and size go out now, so a download cut before its first piece still says what it was.
    res.flushHeaders();

    // A reader too slow to finish would hold a stream for good: the response ends 15 minutes after the link expired.
    timer = setTimeout(() => res.destroy(), Math.min(TIMER_MAX, Math.max(0, p.x + this.streamMaxMs - this.now())));
    if (timer.unref) timer.unref();
    let media = ready.media;
    let reopened = false;
    let offset = from;
    while (offset < to && !closed) {
      // Turning "Agents can read meetings" off, the agent's access or its token going, or the hard end stop a
      // download after the piece that is under way.
      if (!this.canRead() || !this.agentAllowed(p.a, p.r) || (p.t !== null && !this.tokenLive(p.a, p.r, p.t)) || this.now() > p.x + this.streamMaxMs) {
        this.log('stopped', what, `at ${offset} of ${size}`);
        return res.destroy();
      }
      const length = Math.min(READ_CHUNK, to - offset);
      let reply;
      try {
        reply = await voice.mediaRead(media, offset, length);
      } catch (err) {
        // Voice forgot the file (10 minutes unread, or a clip its sweep removed): open it again once and go on, as
        // long as it is the same file.
        if (err && err.code === 'not_found' && !reopened && !closed) {
          reopened = true;
          const again = await this.prepare(voice, args, () => closed);
          if (again.ready && again.ready.size === size && again.ready.type === ready.type && MEDIA_ID.test(String(again.ready.media))) {
            media = again.ready.media;
            continue;
          }
        }
        this.log('cut short', what, `at ${offset} of ${size}`, (err && err.code) || 'error');
        return res.destroy();
      }
      if (closed) break;
      const data = reply && typeof reply.data === 'string' && reply.offset === offset && reply.data.length % 4 === 0 && BASE64.test(reply.data) ? Buffer.from(reply.data, 'base64') : null;
      if (!data || data.length !== length) {
        this.log('cut short', what, `at ${offset} of ${size}`, 'bad piece');
        return res.destroy();
      }
      offset += length;
      if (!res.write(data)) await drained(res);
    }
    if (closed) {
      this.log('client left', what, `at ${offset} of ${size}`);
      return undefined;
    }
    this.log('served', what, `${to - from} bytes`);
    return res.end();
  }

  // media.open until the file is ready: { ready }, { error } or {} when preparing took too long or the client left.
  async prepare(voice, args, gone) {
    const started = Date.now();
    let wait = POLL_FIRST_MS;
    for (;;) {
      let out;
      try {
        out = await voice.mediaOpen(args);
      } catch (err) {
        return { error: err && err.code ? err : { code: 'failed' } };
      }
      if (isObj(out) && out.ready === true) return { ready: out };
      if (gone() || Date.now() - started + wait > this.prepareWaitMs) return {};
      await sleep(wait);
      if (gone()) return {};
      wait = Math.min(POLL_MAX_MS, wait * 2);
    }
  }

  openFailed(req, res, code) {
    switch (code) {
      case 'preparing':
        return fail(req, res, 503, 'preparing', { 'Retry-After': '15' });
      case 'not_found':
      case 'not_available':
        return fail(req, res, 404, 'gone');
      case 'bad_request':
        return fail(req, res, 400, 'bad-request');
      case 'unknown_command':
        return fail(req, res, 501, 'voice-too-old');
      case 'offline':
      case 'timeout':
        return fail(req, res, 503, 'voice-offline', { 'Retry-After': '10' });
      default:
        return fail(req, res, 502, 'failed');
    }
  }
}

module.exports = { MediaLinks, parseRange, mediaFileName, MEDIA_LINK_TTL_MS, READ_CHUNK, PREPARE_WAIT_MS, STREAM_MAX_MS, MAX_STREAMS, REQUESTS_PER_MINUTE, BAD_TOKENS_PER_MINUTE, BLOCK_MS };
