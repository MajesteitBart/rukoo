'use strict';

// HTTP calls to a Rukoo account server (server/PROTOCOL.md). https only, apart from a server on this computer for
// development and tests.
const http = require('http');
const https = require('https');

const TIMEOUT = 20000;
const MAX_BYTES = 32 * 1024 * 1024;

// details: what an error answer says besides its code and message, for the booking routes: the refused field, the
// booking as it is now (stale_version), other times (slot_taken).
class AccountError extends Error {
  constructor(code, status = 0, message = '', details = null) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function errorDetails(json) {
  if (!json || typeof json !== 'object') return null;
  const out = {};
  if (typeof json.field === 'string') out.field = json.field.slice(0, 200);
  if (json.booking && typeof json.booking === 'object' && !Array.isArray(json.booking)) out.booking = json.booking;
  if (Array.isArray(json.alternatives)) out.alternatives = json.alternatives.filter(Number.isSafeInteger).slice(0, 3);
  return Object.keys(out).length ? out : null;
}

// The server's base URL without a trailing slash, or null when it isn't one Rukoo may talk to.
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

// meter: { bytes }, which each byte read for the answer is added to, so a caller can bound a run of requests by what
// they downloaded rather than by the parts it reads.
function request(server, method, path, { body, token, meter } = {}) {
  const url = new URL(server + path);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  // Answers come as they were sent, so the meter counts what was downloaded. Node never unpacks one; Android's OkHttp
  // would, so both apps ask for none.
  const headers = { accept: 'application/json', 'accept-encoding': 'identity' };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = payload.length;
  }
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    let status = 0;
    // A connection of its own for each request. Kept-alive connections race with a server that closes them when idle:
    // a request sent on one just as the server lets go of it fails, and Argon2 between two requests takes about as
    // long as a server's idle timeout on a slow computer. A sync makes only a few requests.
    const req = lib.request(url, { method, headers, timeout: TIMEOUT, agent: false }, (res) => {
      status = res.statusCode;
      // An answer compressed anyway can't be read, so it isn't downloaded either.
      const encodings = String(res.headers['content-encoding'] || '').split(',').map((e) => e.trim().toLowerCase());
      if (encodings.some((e) => e && e !== 'identity')) {
        req.destroy();
        return reject(new AccountError('server', res.statusCode));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
          json = null;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        reject(new AccountError((json && json.error) || 'server', res.statusCode, json && json.message, errorDetails(json)));
      });
      res.on('error', (err) => reject(new AccountError('network', 0, err.message)));
    });
    // The answer counts as it comes off the connection, which is this request's own, so its headers and chunk framing
    // count too: Node hands over only the body, and a server can put 16 KiB of chunk extensions before each byte of it.
    let size = 0;
    req.on('socket', (socket) =>
      socket.on('data', (data) => {
        size += data.length;
        if (meter) meter.bytes += data.length;
        if (size > MAX_BYTES) {
          req.destroy();
          reject(new AccountError('too_large', status));
        }
      })
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => reject(new AccountError('network', 0, err.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { AccountError, serverUrl, request };
