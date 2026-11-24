'use strict';

// The workspace API as an agent's key reaches it (server/WORKSPACES.md, "Agents in channels"): the same routes the apps
// use, with `Authorization: Bearer rka_…`. The key goes only to the configured server and never follows a redirect.

const crypto = require('crypto');

const PROTOCOL = 'rukoo.workspace.v1';
const TICKET_PREFIX = 'rukoo.ticket.';
const KEY = /^rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
// The wire versions the runner reads. Version 2 sends a message of files alone with empty text.
const VERSIONS = [2, 1];
// The most of an answer the runner reads: a page of 100 events of 16 KiB each, with room to spare.
const RESPONSE_MAX = 8 * 1024 * 1024;

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

// The server's address without a trailing slash. https, or http to this computer; other http only with allowHttp,
// since the key would cross the network in the clear.
function serverAddress(value, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error(`"server" is not an address: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('"server" must start with https://');
  if (url.protocol === 'http:' && !LOOPBACK.test(url.hostname) && !allowHttp) {
    throw new Error('"server" must use https:// unless it is on this computer; set "allowHttp": true to send the key unencrypted anyway');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('"server" takes no user name, password, query or fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

class Rukoo {
  // server: the account server's address; workspace: w_…; key: rka_….
  constructor({ server, workspace, key, allowHttp = false, timeout = 30000 }) {
    if (!/^w_[A-Za-z0-9_-]{22}$/.test(String(workspace || ''))) throw new Error('"workspace" must be a workspace id (w_…)');
    if (!KEY.test(String(key || ''))) throw new Error('The key is not an agent key (rka_…)');
    this.server = serverAddress(server, { allowHttp });
    this.workspace = workspace;
    this.key = key;
    this.timeout = timeout;
    this.version = 1;
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

  // The server's /v1/info, without the key: its wire versions and agent limits. signal, here and below: ends the
  // request, as the runner's stop does.
  async info({ signal } = {}) {
    const info = await this.ok('GET', '/v1/info', { auth: false, signal });
    const w = info && info.workspace;
    const versions = w && Array.isArray(w.versions) ? w.versions : [1];
    this.version = VERSIONS.find((v) => versions.includes(v)) || 1;
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

module.exports = { Rukoo, RukooError, KeyRefused, uuidv7, serverAddress, retryAfter, bodyOf, KEY, PROTOCOL, RESPONSE_MAX };
