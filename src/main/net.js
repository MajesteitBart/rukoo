'use strict';

const { t } = require('../i18n');

// Outbound requests the app makes on its own behalf (sender logos, one-click unsubscribe). Their URLs
// come from mail, so they only go to public addresses over https, follow a few checked redirects at
// most, and stop reading at a size limit.
const https = require('https');
const dns = require('dns');
const net = require('net');

function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

// The eight 16-bit groups of an IPv6 address, whichever way it is written ("::", an IPv4 tail).
function v6Groups(ip) {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest !== undefined && rest ? rest.split(':') : [];
  const fill = rest !== undefined ? Array(8 - left.length - right.length).fill('0') : [];
  const groups = [...left, ...fill, ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function isPublicAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return !v4Private(ip);
  if (kind !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (n) => g.slice(0, n).every((x) => x === 0);
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
  if (zero(5) && g[5] === 0xffff) return !v4Private(v4(g[6], g[7]));
  if (zero(6)) return g[6] !== 0 && !v4Private(v4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b) return false;
  const first = g[0];
  return !(
    (first & 0xfe00) === 0xfc00 || // unique local
    (first & 0xffc0) === 0xfe80 || // link local
    (first & 0xffc0) === 0xfec0 || // site local
    (first & 0xff00) === 0xff00 // multicast
  );
}

// A dns.lookup replacement for the socket: the check happens on the address actually connected to,
// so a name that resolves differently a second time cannot slip through.
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
      return callback(Object.assign(new Error(t('errors.network.privateHost', { hostname: hostname })), { code: 'ENOTPUBLIC' }));
    }
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

// Resolves to { status, headers, body } or null when the request failed, was refused or ran over.
// options: { method, headers, body, maxBytes, timeout, redirects, transport, lookup, protocol }
function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    maxBytes = 256 * 1024,
    timeout = 3000,
    // One deadline for the whole request, redirects included.
    deadline = Date.now() + timeout,
    redirects = 3,
    transport = https,
    lookup = publicLookup,
    protocol = 'https:'
  } = options;
  let target;
  try {
    target = new URL(url);
  } catch (_) {
    return Promise.resolve(null);
  }
  if (target.protocol !== protocol) return Promise.resolve(null);
  // Sockets skip the lookup for an address written as a literal, so check that one here.
  const literal = target.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) && lookup === publicLookup && !isPublicAddress(literal)) return Promise.resolve(null);
  if (Date.now() >= deadline) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = transport.request(target, { method, headers: body ? { 'content-length': Buffer.byteLength(body), ...headers } : headers, lookup }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        // The body of a redirect is never needed; close it rather than download it.
        res.destroy();
        if (redirects <= 0 || method !== 'GET') return finish({ status, headers: res.headers, body: null });
        let next;
        try {
          next = new URL(res.headers.location, target).toString();
        } catch (_) {
          return finish(null);
        }
        return request(next, { ...options, deadline, redirects: redirects - 1 }).then(finish);
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        res.destroy();
        return finish(null);
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => finish(null));
    });
    // A hard deadline, not an idle timeout: a server that trickles bytes is cut off too.
    timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, Math.max(0, deadline - Date.now()));
    req.on('error', () => finish(null));
    if (body) req.write(body);
    req.end();
  });
}

// RFC 8058 one-click unsubscribe: a POST that counts only if the endpoint itself answers 2xx.
async function oneClickUnsubscribe(url, options = {}) {
  const res = await request(url, {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    redirects: 0,
    timeout: options.timeout || 10000,
    maxBytes: options.maxBytes || 64 * 1024
  });
  return Boolean(res && res.status >= 200 && res.status < 300);
}

module.exports = { request, oneClickUnsubscribe, isPublicAddress, publicLookup };
