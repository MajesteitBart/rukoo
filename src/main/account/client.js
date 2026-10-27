'use strict';

// HTTP calls to a Rukoo account server (server/PROTOCOL.md). https only, apart from a server on this computer for
// development and tests.
const http = require('http');
const https = require('https');

const TIMEOUT = 20000;
const MAX_BYTES = 32 * 1024 * 1024;

class AccountError extends Error {
  constructor(code, status = 0, message = '') {
    super(message || code);
    this.code = code;
    this.status = status;
  }
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

function request(server, method, path, { body, token } = {}) {
  const url = new URL(server + path);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { accept: 'application/json' };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = payload.length;
  }
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    // A connection of its own for each request. Kept-alive connections race with a server that closes them when idle:
    // a request sent on one just as the server lets go of it fails, and Argon2 between two requests takes about as
    // long as a server's idle timeout on a slow computer. A sync makes only a few requests.
    const req = lib.request(url, { method, headers, timeout: TIMEOUT, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          reject(new AccountError('too_large', res.statusCode));
        } else chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
          json = null;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        reject(new AccountError((json && json.error) || 'server', res.statusCode, json && json.message));
      });
      res.on('error', (err) => reject(new AccountError('network', 0, err.message)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => reject(new AccountError('network', 0, err.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { AccountError, serverUrl, request };
