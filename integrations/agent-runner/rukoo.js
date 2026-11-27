'use strict';

// The workspace API as an agent's key reaches it (server/WORKSPACES.md, "Agents in channels"): the same routes the apps
// use, with `Authorization: Bearer rka_…`. The key goes only to the configured server and never follows a redirect.

const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const PROTOCOL = 'rukoo.workspace.v1';
const TICKET_PREFIX = 'rukoo.ticket.';
const KEY = /^rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
// The wire versions the runner reads. Version 2 sends a message of files alone with empty text.
const VERSIONS = [2, 1];
// The most of an answer the runner reads: a page of 100 events of 16 KiB each, with room to spare.
const RESPONSE_MAX = 8 * 1024 * 1024;
// The largest file when /v1/info names none (server/WORKSPACES.md, "Files": 25 MiB per file).
const FILE_BYTES_DEFAULT = 25 * 1024 * 1024;
// A download gets the request timeout and one second more for every DOWNLOAD_RATE bytes it may hold, so a whole file
// of 25 MiB has 200 seconds on top.
const DOWNLOAD_RATE = 128 * 1024;

class RukooError extends Error {
  constructor(status, body, message) {
    super(message || (body && body.message) || `HTTP ${status}`);
    this.status = status;
    this.body = body || null;
    this.code = (body && body.error) || (status ? `http_${status}` : 'offline');
  }
}

// The key stopped working: replaced, the agent removed, its sponsor gone, or agents turned off. Nothing else helps.
class KeyRefused extends RukooError {}

// An answer's body as text, at most max bytes; null past it, and the rest isn't read.
async function bodyOf(res, max = RESPONSE_MAX) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A lowercase UUIDv7 for time: the operation ID the server takes.
function uuidv7(time = Date.now()) {
  const bytes = crypto.randomBytes(16);
  let t = BigInt(Math.floor(time));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Retry-After in seconds, or null without one.
function retryAfter(headers) {
  const raw = headers && headers.get('retry-after');
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

// An address from the config as a URL: https, or http to this computer; other http only with allowHttp. field: its
// name in the config, for the errors. why: what plain http would do, for the error that refuses it.
function configAddress(value, field, { allowHttp = false, why }) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error(`"${field}" is not an address: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`"${field}" must start with https://`);
  if (url.protocol === 'http:' && !LOOPBACK.test(url.hostname) && !allowHttp) {
    throw new Error(`"${field}" must use https:// unless it is on this computer; set "allowHttp": true to ${why} anyway`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(`"${field}" takes no user name, password, query or fragment`);
  return url;
}

// The server's address without a trailing slash. Plain http would send the key in the clear.
function serverAddress(value, { allowHttp = false } = {}) {
  const url = configAddress(value, 'server', { allowHttp, why: 'send the key unencrypted' });
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// privateFilesOrigin from the config: the origin of the file links of a server on a private network, which the runner
// downloads from at whatever address it has, as from the server itself. Checked as "server" is, and an origin alone.
// null without one.
function privateFilesOrigin(value, { allowHttp = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('"privateFilesOrigin" must be an address, such as https://files.example.internal');
  const url = configAddress(value, 'privateFilesOrigin', { allowHttp, why: 'download files unencrypted' });
  if (url.pathname !== '/') throw new Error('"privateFilesOrigin" is an origin alone, without a path');
  return url.origin;
}

// ---- Where downloads go ----
//
// A link to the server's own origin, or to privateFilesOrigin, goes to whatever address it has: the operator chose
// both in the config. A link to the files origin a server advertises in /v1/info goes only to a public address
// (server/WORKSPACES.md, "Files"), since a remote workspace can't grant more: never to this computer (loopback), an
// unspecified, link-local, private (RFC 1918, fc00::/7), CGNAT (100.64.0.0/10) or multicast address, any other range
// IANA's special-purpose registries mark as not globally reachable, nor one of those as IPv6 writes an IPv4 address. The connection checks the address it connects to in its own lookup (publicLookup),
// so a name can't answer one address to a check and another to the connection.

const NOT_PUBLIC = 'ERR_RUKOO_NOT_PUBLIC';

function ipv4Parts(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const n = parts.map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

// The ranges IANA's special-purpose registry marks as not globally reachable count as not public, besides multicast.
const publicIPv4 = ([a, b, c, d]) =>
  !(
    a === 0 || // "this network", 0.0.0.0 among it
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) || // IETF protocol assignments, but for two anycast addresses
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 88 && c === 99) || // the old 6to4 relay
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, the reserved block and broadcast
  );

// An IPv6 address as its eight groups, or null. A zone (%eth0) and brackets go; an IPv4 address in the last 32 bits
// becomes its two groups.
function ipv6Groups(address) {
  let s = String(address).toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const last = s.lastIndexOf(':');
  if (last === -1) return null;
  if (s.includes('.', last)) {
    const v4 = ipv4Parts(s.slice(last + 1));
    if (!v4) return null;
    s = `${s.slice(0, last + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...new Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return all.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? all.map((g) => parseInt(g, 16)) : null;
}

// Whether the runner may connect to address, an IP address, for a link a remote server named. Anything it can't read
// as one isn't.
function publicAddress(address) {
  const v4 = ipv4Parts(address);
  if (v4) return publicIPv4(v4);
  const g = ipv6Groups(address);
  if (!g) return false;
  const embedded = () => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  // ::ffff:a.b.c.d, the IPv4-mapped form: as the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicIPv4(embedded());
  // :: (unspecified), ::1 (loopback) and the deprecated IPv4-compatible ::a.b.c.d.
  if (g.slice(0, 6).every((x) => x === 0)) return false;
  // 64:ff9b::a.b.c.d, NAT64's well-known prefix, reaches the IPv4 address through the network's gateway.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicIPv4(embedded());
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false; // 64:ff9b:1::/48, NAT64 for a local network
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] <= 1) return false; // 100::/64 discard, 100:0:0:1::/64 dummy
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // 2001::/23, IETF protocol assignments such as Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return false; // documentation, 3fff::/20
  if (g[0] === 0x5f00) return false; // SRv6 segment ids
  // 2002:a.b.c.d::/48, 6to4: as the IPv4 address it carries.
  if (g[0] === 0x2002) return publicIPv4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff]);
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local, fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false; // link-local, and the old site-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  return true;
}

const notPublic = () => Object.assign(new Error('The address is not a public one'), { code: NOT_PUBLIC });

// A lookup for a connection (net.connect's lookup option) that answers only public addresses, in both forms Node asks
// for: one address, (err, address, family), or with { all: true }, as Node 22 asks with autoSelectFamily, (err,
// [{ address, family }]). A name with any address that isn't public is refused whole. resolve: dns.lookup, or a
// stand-in for the tests.
function publicLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    resolve(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      if (!list.length || list.some((a) => !a || !publicAddress(a.address))) return callback(notPublic());
      callback(null, address, family);
    });
  };
}

// GET url for fetchFile: on a connection of its own (agent: false, so no pooled socket and no cookie), without a
// redirect (node's http follows none), through lookup when there is one. refused(message): the error for an address
// the lookup turned down.
async function getFile(url, { keep, limit, lookup, signal, refused }) {
  let turnedDown = false;
  const options = { method: 'GET', headers: { accept: '*/*', 'accept-encoding': 'identity' }, agent: false, signal };
  if (lookup) {
    options.lookup = (hostname, opts, callback) =>
      lookup(hostname, opts, (err, ...rest) => {
        if (err && err.code === NOT_PUBLIC) turnedDown = true;
        callback(err, ...rest);
      });
  }
  let res;
  try {
    res = await new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(url, options, resolve);
      req.on('error', reject);
      req.end();
    });
  } catch (err) {
    if (turnedDown) throw refused('The server answered a download link to a host whose address is not public');
    const e = new RukooError(0, null, `No answer from ${url.host}: ${err.message}`);
    e.network = true;
    throw e;
  }
  if (res.statusCode !== 200) {
    res.destroy();
    throw new RukooError(res.statusCode, null, `The download answered HTTP ${res.statusCode}`);
  }
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let kept = 0;
  let size = 0;
  try {
    for await (const value of res) {
      if (size + value.length > limit) {
        res.destroy();
        return { bytes: Buffer.concat(chunks), size: size + value.length, sha256: null, over: true };
      }
      size += value.length;
      hash.update(value);
      if (kept < keep) {
        const part = Buffer.from(value.subarray(0, keep - kept));
        chunks.push(part);
        kept += part.length;
      }
    }
  } catch (err) {
    const e = new RukooError(0, null, `The download broke off: ${err.message}`);
    e.network = true;
    throw e;
  }
  return { bytes: Buffer.concat(chunks), size, sha256: hash.digest('hex'), over: false };
}

class Rukoo {
  // server: the account server's address; workspace: w_…; key: rka_…. privateFilesOrigin: the config's, see above.
  // resolve: what looks up a name for a download from an advertised files origin, dns.lookup unless a test gives one.
  constructor({ server, workspace, key, allowHttp = false, privateFilesOrigin: privateFiles = null, timeout = 30000, resolve = dns.lookup }) {
    if (!/^w_[A-Za-z0-9_-]{22}$/.test(String(workspace || ''))) throw new Error('"workspace" must be a workspace id (w_…)');
    if (!KEY.test(String(key || ''))) throw new Error('The key is not an agent key (rka_…)');
    this.server = serverAddress(server, { allowHttp });
    this.allowHttp = allowHttp === true;
    this.privateFilesOrigin = privateFilesOrigin(privateFiles, { allowHttp });
    this.lookup = publicLookup(resolve);
    this.workspace = workspace;
    this.key = key;
    this.timeout = timeout;
    this.version = 1;
    // What /v1/info said of files (info()): the origin its download links use besides the server's own, and the largest
    // file it takes.
    this.filesOrigin = null;
    this.fileLimit = FILE_BYTES_DEFAULT;
    // The agent's member id, from the key: u_ and the 22 characters after rka_.
    this.agentId = `u_${key.slice(4, 26)}`;
  }

  url(path) {
    return `${this.server}${path}`;
  }

  async request(method, path, { body, query, auth = true, timeout = this.timeout, signal } = {}) {
    let route = path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) params.set(k, String(v));
      const q = params.toString();
      if (q) route += `?${q}`;
    }
    const headers = { accept: 'application/json', 'rukoo-workspace-version': String(this.version) };
    if (auth) headers.authorization = `Bearer ${this.key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    let res;
    let text = '';
    try {
      res = await fetch(this.url(route), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any(signals)
      });
      text = await bodyOf(res);
    } catch (err) {
      const e = new RukooError(0, null, `No answer from ${new URL(this.server).host}: ${err.cause ? err.cause.message || err.cause : err.message}`);
      e.network = true;
      throw e;
    }
    if (text === null) {
      const e = new RukooError(res.status, null, `The answer from ${new URL(this.server).host} was larger than ${RESPONSE_MAX / 1024 / 1024} MiB`);
      e.tooLarge = true;
      throw e;
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.status === 401 && auth && data && data.scope === 'agent') throw new KeyRefused(401, data);
    return { status: res.status, body: data, headers: res.headers };
  }

  // A request that must answer 2xx; anything else throws a RukooError with the status and body.
  async ok(method, path, options) {
    const res = await this.request(method, path, options);
    if (res.status < 200 || res.status > 299) {
      const err = new RukooError(res.status, res.body);
      err.retryAfter = retryAfter(res.headers);
      throw err;
    }
    return res.body;
  }

  ws(rest = '') {
    return `/v1/workspaces/${this.workspace}${rest}`;
  }

  // The server's /v1/info, without the key: its wire versions, agent limits, and the origin and size limit of its files.
  // signal, here and below: ends the request, as the runner's stop does.
  async info({ signal } = {}) {
    const info = await this.ok('GET', '/v1/info', { auth: false, signal });
    const w = info && info.workspace;
    const versions = w && Array.isArray(w.versions) ? w.versions : [1];
    this.version = VERSIONS.find((v) => versions.includes(v)) || 1;
    const files = w && w.files && typeof w.files === 'object' ? w.files : null;
    this.filesOrigin = null;
    if (files && typeof files.origin === 'string' && files.origin) {
      try {
        const u = new URL(files.origin);
        if (u.protocol === 'https:' || u.protocol === 'http:') this.filesOrigin = u.origin;
      } catch {
        // Not an origin: links go only to the server's own.
      }
    }
    this.fileLimit = files && Number.isSafeInteger(files.maxBytes) && files.maxBytes > 0 ? files.maxBytes : FILE_BYTES_DEFAULT;
    return info;
  }

  workspaceInfo({ signal } = {}) {
    return this.ok('GET', this.ws(), { signal });
  }

  async me({ signal } = {}) {
    return (await this.ok('GET', this.ws('/agents/me'), { signal })).agent;
  }

  async members({ signal } = {}) {
    return (await this.ok('GET', this.ws('/members'), { signal })).members || [];
  }

  async channelMembers(conversation, { signal } = {}) {
    return (await this.ok('GET', this.ws(`/channels/${conversation}/members`), { signal })).members || [];
  }

  changes(after, signal) {
    return this.ok('GET', this.ws('/changes'), { query: { after: after || undefined, limit: 100 }, signal });
  }

  events(conversation, { after, before, limit = 100, signal } = {}) {
    return this.ok('GET', this.ws(`/conversations/${conversation}/events`), { query: before !== undefined ? { before, limit } : { after: after || 0, limit }, signal });
  }

  // { status, body, headers }: the runner decides what each refusal means.
  post(conversation, body) {
    return this.request('POST', this.ws(`/conversations/${conversation}/messages`), { body });
  }

  read(conversation, seq) {
    return this.ok('POST', this.ws(`/conversations/${conversation}/read`), { body: { seq } });
  }

  // A link to a file of a message in a room the agent is in, for the next 60 seconds: { url, expiresAt, name, type,
  // size, sha256 }. 404 not_found for a file of a removed message, or one retention no longer keeps.
  fileLink(conversation, file, { signal } = {}) {
    return this.ok('POST', this.ws(`/conversations/${conversation}/files/${encodeURIComponent(file)}/download`), { signal });
  }

  // Where the runner downloads url, a URL, from: { anyAddress } for an origin it takes links for, null for any other.
  // The configured server's own origin and privateFilesOrigin go to whatever address they have (anyAddress true); the
  // files origin /v1/info advertises (info()) goes only to a public address. No user name or password. Plain http to
  // the advertised origin only when the operator set allowHttp; the other two passed the config's check for it.
  linkRoute(url) {
    if (!(url instanceof URL) || url.username || url.password) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.origin === new URL(this.server).origin || url.origin === this.privateFilesOrigin) return { anyAddress: true };
    if (url.origin !== this.filesOrigin) return null;
    return url.protocol === 'https:' || this.allowHttp ? { anyAddress: false } : null;
  }

  // Whether the runner downloads from url at all: the origins the desktop app takes links for
  // (src/main/workspaces/files.js allowedLink), and privateFilesOrigin.
  allowedLink(url) {
    return Boolean(this.linkRoute(url));
  }

  // A file from a link fileLink() answered, read whole through SHA-256 up to limit bytes, of which only the first keep
  // stay in memory: { bytes, size, sha256, over }, with size and sha256 of everything that came, and over when more than
  // limit came, of which the rest isn't read. The link is the only thing a download needs, so the key never goes with
  // it: only to an origin linkRoute() takes, at an address it allows, on a connection of its own without cookies, and
  // no redirect.
  async fetchFile(link, { keep = 0, limit = this.fileLimit, signal, timeout } = {}) {
    const refused = (message) => Object.assign(new RukooError(0, null, message), { refused: true });
    let url;
    try {
      url = new URL(String(link || ''));
    } catch {
      throw refused('The server answered a download link that is no address');
    }
    const route = this.linkRoute(url);
    if (!route) throw refused('The server answered a download link the runner does not follow');
    // An address in the link itself is never looked up, so it is checked here.
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    if (!route.anyAddress && net.isIP(host) && !publicAddress(host)) throw refused('The server answered a download link to an address that is not public');
    const wait = timeout ?? this.timeout + Math.ceil(Math.max(0, limit) / DOWNLOAD_RATE) * 1000;
    return getFile(url, { keep, limit, lookup: route.anyAddress ? null : this.lookup, signal: AbortSignal.any([AbortSignal.timeout(wait), ...(signal ? [signal] : [])]), refused });
  }

  async ticket({ signal } = {}) {
    return this.ok('POST', this.ws('/socket-ticket'), { signal });
  }

  // The wake socket, with the ticket offered as a subprotocol next to the protocol's own name, which any WebSocket
  // client can do (a header needs Node's own extension). Never in the address.
  socketUrl() {
    return `${this.url(this.ws('/socket')).replace(/^http/, 'ws')}`;
  }

  socketProtocols(ticket) {
    return [PROTOCOL, `${TICKET_PREFIX}${ticket}`];
  }
}

module.exports = { Rukoo, RukooError, KeyRefused, uuidv7, serverAddress, privateFilesOrigin, publicAddress, publicLookup, retryAfter, bodyOf, KEY, PROTOCOL, RESPONSE_MAX };
