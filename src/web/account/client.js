'use strict';

// HTTP calls to a Rukoo account server (server/PROTOCOL.md) from a browser page: src/main/account/client.js on fetch.
// The errors, their details, the headers, the 20 s timeout and the 32 MiB limit are the desktop's. Two things a
// browser decides itself: it asks for compressed answers and unpacks them, and a page can neither send
// Accept-Encoding: identity nor see the bytes on the connection. So answers aren't refused for being compressed (the
// account server and Cloudflare compress JSON for browsers), and the limit counts the unpacked body, which bounds what
// a compressed answer can grow into.

const TIMEOUT = 20000;
const MAX_BYTES = 32 * 1024 * 1024;

// details: what an error answer says besides its code and message, as on desktop: the refused field, the booking as it
// is now (stale_version), other times (slot_taken), and for the workspace routes (server/WORKSPACES.md, "Errors") the
// scope, minVersion, channels, member, limit and retryAfter (from the Retry-After header).
class AccountError extends Error {
  constructor(code, status = 0, message = '', details = null) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const SCOPES = ['account', 'workspace', 'conversation'];
const CONVERSATION_ID = /^c_[A-Za-z0-9_-]{22}$/;
const MEMBER_ID = /^u_[A-Za-z0-9_-]{22}$/;

// Retry-After in whole seconds, 1 to 3600: a number of seconds or an HTTP date. null when there is none to read.
function retryAfter(raw, now = Date.now()) {
  const text = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  if (!text) return null;
  let seconds;
  if (/^\d{1,10}$/.test(text)) seconds = Number(text);
  else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(Math.max(seconds, 1), 3600);
}

// headers: a fetch Headers, or a plain object of lowercase names.
function headerOf(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  return headers[name];
}

function errorDetails(json, headers, now = Date.now()) {
  const out = {};
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    if (typeof json.field === 'string') out.field = json.field.slice(0, 200);
    if (json.booking && typeof json.booking === 'object' && !Array.isArray(json.booking)) out.booking = json.booking;
    if (Array.isArray(json.alternatives)) out.alternatives = json.alternatives.filter(Number.isSafeInteger).slice(0, 3);
    if (SCOPES.includes(json.scope)) out.scope = json.scope;
    if (Number.isSafeInteger(json.minVersion) && json.minVersion > 0) out.minVersion = json.minVersion;
    if (Array.isArray(json.channels)) {
      const channels = json.channels.filter((c) => typeof c === 'string' && CONVERSATION_ID.test(c)).slice(0, 100);
      if (channels.length) out.channels = channels;
    }
    if (typeof json.member === 'string' && MEMBER_ID.test(json.member)) out.member = json.member;
    if (typeof json.limit === 'string' && /^[A-Za-z]{1,40}$/.test(json.limit)) out.limit = json.limit;
  }
  const wait = retryAfter(headerOf(headers, 'retry-after'), now);
  if (wait !== null) out.retryAfter = wait;
  return Object.keys(out).length ? out : null;
}

// The only header a caller may add: the workspace protocol version (server/WORKSPACES.md). Anything else, such as
// authorization, stays as request() sets it.
const EXTRA_HEADERS = ['rukoo-workspace-version'];

// The server's base URL without a trailing slash, or null when it isn't one Rukoo may talk to: https, or http on
// this computer. The same rule as desktop, so a page served over plain http elsewhere has no account server.
function serverUrl(text) {
  let url;
  try {
    url = new URL(String(text || '').trim());
  } catch (_) {
    return null;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const messageOf = (err) => (err && err.message ? String(err.message) : String(err));

function joined(chunks, size) {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// The body as text, refused once more than maxBytes of it came in.
async function readText(res, maxBytes, status) {
  const declared = Number(headerOf(res.headers, 'content-length'));
  const chunks = [];
  let size = 0;
  try {
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Not downloaded at all; a failure to cancel changes nothing about this answer.
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
      throw new AccountError('too_large', status);
    }
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          // The rest isn't wanted; a failure to cancel changes nothing about this answer.
          reader.cancel().catch(() => {});
          throw new AccountError('too_large', status);
        }
        chunks.push(value);
      }
    } else if (typeof res.arrayBuffer === 'function') {
      const all = new Uint8Array(await res.arrayBuffer());
      if (all.byteLength > maxBytes) throw new AccountError('too_large', status);
      chunks.push(all);
      size = all.byteLength;
    }
  } catch (err) {
    if (err instanceof AccountError) throw err;
    throw new AccountError('network', 0, messageOf(err));
  }
  return new TextDecoder().decode(joined(chunks, size));
}

// request(server, method, path, { body, token, headers, keepalive }) as desktop's, on the fetch given. A redirect is an
// answer like any other non-2xx (desktop's Node client follows none either); in a browser it reads as status 0.
// keepalive (web only): the browser still sends the request when the page goes away meanwhile.
function createRequest({ fetch: fetchFn, now = Date.now, timeout = TIMEOUT, maxBytes = MAX_BYTES } = {}) {
  if (typeof fetchFn !== 'function') throw new TypeError('createRequest needs fetch');
  return async function request(server, method, path, { body, token, headers: extra, keepalive = false } = {}) {
    const url = new URL(server + path).href;
    const headers = { accept: 'application/json' };
    if (extra && typeof extra === 'object') {
      for (const name of EXTRA_HEADERS) {
        const value = extra[name];
        if (typeof value === 'string' && /^[\x21-\x7e]{1,40}$/.test(value)) headers[name] = value;
      }
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);
    try {
      let res;
      try {
        // Called unbound: window.fetch refuses any this but the window.
        res = await fetchFn(url, {
          method,
          headers,
          body: payload,
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'manual',
          referrerPolicy: 'no-referrer',
          ...(keepalive ? { keepalive: true } : {})
        });
      } catch (err) {
        throw new AccountError('network', 0, messageOf(err));
      }
      const status = Number(res.status) || 0;
      const text = await readText(res, maxBytes, status);
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_) {
        json = null;
      }
      if (status >= 200 && status < 300) return json;
      const code = json && typeof json.error === 'string' && json.error ? json.error : 'server';
      throw new AccountError(code, status, json && typeof json.message === 'string' ? json.message : '', errorDetails(json, res.headers, now()));
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { AccountError, TIMEOUT, MAX_BYTES, serverUrl, createRequest, errorDetails, retryAfter };
