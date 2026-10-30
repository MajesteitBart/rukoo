'use strict';

// Video meetings for bookings (docs/booking.md, Video meetings): a booking whose meeting type uses a video service
// gets its own meeting, made by the computer that handles bookings. Jitsi Meet needs no account; Zoom and Microsoft
// Teams sign in with OAuth. Sign-ins stay on this computer: the refresh token is encrypted like a Google account's
// (secrets.js) in video.json, and access tokens live in memory. A new service is one adapter like jitsi.js, zoom.js
// or teams.js: a name, a kind ('room' or 'oauth'), and create, update and remove for a meeting.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { t, translate } = require('../../i18n');
const { OAuthFlow, videoError } = require('./oauth');
const { jitsi, serverAddress, DEFAULT_SERVER } = require('./jitsi');
const { zoom } = require('./zoom');
const { teams } = require('./teams');

const API_TIMEOUT = 30000;
// A token this close to its end is refreshed first.
const MARGIN = 60000;

const plain = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const text = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

// A client file: { client_id, client_secret?, tenant? }. Zoom's secret is optional with PKCE; Microsoft's public
// clients have none.
function cleanClient(raw) {
  const c = plain(raw) ? raw.installed || raw.web || raw : null;
  if (!plain(c)) return null;
  const id = text(c.client_id ?? c.clientId, 500);
  if (!id) return null;
  return { id, secret: text(c.client_secret ?? c.clientSecret, 500), tenant: text(c.tenant, 100) };
}

class VideoServices extends EventEmitter {
  // dataDir: where video.json is. configDir: where a user's client files are (zoom-oauth.json, teams-oauth.json), next
  // to google-oauth.json. adapters: for tests.
  constructor({ dataDir, configDir = dataDir, secrets, openBrowser = () => {}, fetchImpl = fetch, env = process.env, adapters = null, now = Date.now }) {
    super();
    this.dataDir = dataDir;
    this.configDir = configDir;
    this.secrets = secrets;
    this.fetch = fetchImpl;
    this.env = env;
    this.now = now;
    this.adapters = new Map((adapters || [jitsi(), zoom(), teams()]).map((a) => [a.id, a]));
    this.flow = new OAuthFlow({ openBrowser, fetchImpl });
    this.tokens = new Map();
    this.file = { v: 1, rooms: {}, accounts: {} };
    // The service whose browser sign-in is open, shown in Settings with a Cancel button.
    this.pending = null;
  }

  get path() {
    return path.join(this.dataDir, 'video.json');
  }

  init() {
    const saved = readJson(this.path, null);
    if (plain(saved) && saved.v === 1) {
      for (const [id, r] of Object.entries(plain(saved.rooms) ? saved.rooms : {})) {
        if (this.adapters.has(id) && plain(r)) this.file.rooms[id] = { on: r.on === true, server: typeof r.server === 'string' ? r.server : '' };
      }
      for (const [id, a] of Object.entries(plain(saved.accounts) ? saved.accounts : {})) {
        if (this.adapters.has(id) && plain(a) && typeof a.secret === 'string') this.file.accounts[id] = { email: String(a.email || ''), name: String(a.name || ''), secret: a.secret, at: Number(a.at) || 0, renew: a.renew === true };
      }
    }
    return this;
  }

  persist() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(`${this.path}.tmp`, JSON.stringify(this.file), { mode: 0o600 });
      fs.renameSync(`${this.path}.tmp`, this.path);
    } catch (_) {
      // A full disk: the next change writes it again.
    }
  }

  changed() {
    this.persist();
    this.emit('changed', this.state());
  }

  adapter(id) {
    const a = typeof id === 'string' ? this.adapters.get(id) : null;
    if (!a) throw videoError('unknown', t('errors.video.unknown'));
    return a;
  }

  name(id) {
    return this.adapters.has(id) ? this.adapters.get(id).name : String(id || '');
  }

  // The OAuth client a service signs in with: from the environment, else from the client file a user chose. null
  // when there is none; the repository and its builds carry no client of their own (docs/booking.md).
  client(id) {
    const a = this.adapter(id);
    if (a.kind !== 'oauth') return null;
    const envId = text(this.env[a.env.id], 500);
    if (envId) return { id: envId, secret: a.env.secret ? text(this.env[a.env.secret], 500) : null, tenant: a.env.tenant ? text(this.env[a.env.tenant], 100) : null };
    return cleanClient(readJson(path.join(this.configDir, a.file), null));
  }

  // 'connected', 'renew' (signed in, but the sign-in stopped working), 'off', or 'unavailable' (no OAuth client).
  status(id) {
    const a = this.adapter(id);
    if (a.kind === 'room') return this.file.rooms[id] && this.file.rooms[id].on ? 'connected' : 'off';
    if (!this.client(id)) return 'unavailable';
    const acc = this.file.accounts[id];
    if (!acc) return 'off';
    return acc.renew ? 'renew' : 'connected';
  }

  state() {
    return {
      pending: this.pending,
      services: [...this.adapters.values()].map((a) => {
        const status = this.status(a.id);
        const acc = this.file.accounts[a.id];
        const room = this.file.rooms[a.id];
        return {
          id: a.id,
          name: a.name,
          kind: a.kind,
          status,
          account: a.kind === 'oauth' && acc && status !== 'unavailable' ? { email: acc.email, name: acc.name } : null,
          server: a.kind === 'room' ? (room && room.server) || DEFAULT_SERVER : null,
          customServer: a.kind === 'room' ? Boolean(room && room.server) : false
        };
      })
    };
  }

  // ---------- connecting ----------

  // A room service turns on; an OAuth service signs in through the browser and keeps the refresh token.
  async connect(id) {
    const a = this.adapter(id);
    if (a.kind === 'room') return this.setRoom(id, { on: true });
    const client = this.client(id);
    if (!client) throw videoError('unavailable', t('errors.video.notConfigured', { service: a.name }));
    this.pending = id;
    this.emit('changed', this.state());
    try {
      const tokens = await this.flow.signIn(a.oauth(client), client);
      if (!tokens.refresh_token) throw videoError('failed', t('errors.video.noRefreshToken', { service: a.name }));
      const grant = { accessToken: tokens.access_token, expiresAt: this.now() + (Number(tokens.expires_in) || 3600) * 1000 };
      // Encrypted before anything changes: a keyring that can't store it leaves the service as it was.
      const secret = this.secrets.encrypt(tokens.refresh_token);
      let profile = { email: '', name: '' };
      try {
        profile = await a.profile((method, p, body) => this.request(a, grant.accessToken, method, p, body));
      } catch (_) {
        // The account's name is only shown in Settings; meetings work without it.
      }
      this.file.accounts[id] = { email: profile.email, name: profile.name, secret, at: this.now(), renew: false };
      this.tokens.set(id, grant);
    } finally {
      if (this.pending === id) this.pending = null;
      this.changed();
    }
    return this.state();
  }

  cancel() {
    this.flow.cancel();
  }

  // Forgets the sign-in on this computer; the access stays listed in the service's own account settings until the
  // user removes it there.
  disconnect(id) {
    const a = this.adapter(id);
    if (a.kind === 'room') return this.setRoom(id, { on: false });
    delete this.file.accounts[id];
    this.tokens.delete(id);
    this.changed();
    return this.state();
  }

  // Jitsi: on or off, and the server ('' for meet.jit.si).
  setRoom(id, { on, server } = {}) {
    const a = this.adapter(id);
    if (a.kind !== 'room') throw videoError('unknown', t('errors.video.unknown'));
    const room = { on: false, server: '', ...(this.file.rooms[id] || {}) };
    if (typeof on === 'boolean') room.on = on;
    if (server !== undefined) room.server = serverAddress(server === null ? '' : server);
    this.file.rooms[id] = room;
    this.changed();
    return this.state();
  }

  // A client file chosen by the user, kept beside google-oauth.json.
  importClient(id, file) {
    const a = this.adapter(id);
    if (a.kind !== 'oauth') throw videoError('unknown', t('errors.video.unknown'));
    const c = cleanClient(readJson(file, null));
    if (!c) throw videoError('invalid', t('errors.video.invalidClient', { service: a.name }));
    const out = { client_id: c.id };
    if (c.secret) out.client_secret = c.secret;
    if (c.tenant) out.tenant = c.tenant;
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(path.join(this.configDir, a.file), JSON.stringify(out), { mode: 0o600 });
    this.changed();
    return this.state();
  }

  // ---------- tokens and requests ----------

  markRenew(id) {
    const acc = this.file.accounts[id];
    this.tokens.delete(id);
    if (!acc || acc.renew) return;
    acc.renew = true;
    this.changed();
  }

  // A valid access token, refreshed with the stored refresh token when needed. Zoom and Microsoft hand out a new
  // refresh token with each refresh; it replaces the stored one.
  access(id) {
    const a = this.adapter(id);
    const status = this.status(id);
    if (status === 'renew') return Promise.reject(videoError('renew', t('errors.video.expired', { service: a.name })));
    if (status !== 'connected') return Promise.reject(videoError('off', t('errors.video.notConnected', { service: a.name })));
    if (a.kind !== 'oauth') return Promise.resolve(null);
    const cached = this.tokens.get(id);
    if (cached && cached.accessToken && cached.expiresAt - this.now() > MARGIN) return Promise.resolve(cached.accessToken);
    if (cached && cached.refreshing) return cached.refreshing;
    const acc = this.file.accounts[id];
    const client = this.client(id);
    let stored;
    try {
      stored = this.secrets.decrypt(acc.secret);
    } catch (_) {
      // Encrypted under another keyring, as after copying a profile: only a new sign-in helps.
      this.markRenew(id);
      return Promise.reject(videoError('renew', t('errors.video.expired', { service: a.name })));
    }
    // Only while this sign-in is still the one stored: a disconnect or a new sign-in meanwhile wins.
    const current = () => this.file.accounts[id] === acc;
    const refreshing = this.flow
      .refresh(a.oauth(client), client, stored)
      .then((tok) => {
        if (!current()) return tok.access_token;
        if (typeof tok.refresh_token === 'string' && tok.refresh_token) {
          acc.secret = this.secrets.encrypt(tok.refresh_token);
          this.persist();
        }
        this.tokens.set(id, { accessToken: tok.access_token, expiresAt: this.now() + (Number(tok.expires_in) || 3600) * 1000 });
        return tok.access_token;
      })
      .catch((err) => {
        if (this.tokens.get(id) && this.tokens.get(id).refreshing === refreshing) this.tokens.delete(id);
        if (err && err.code === 'renew' && current()) this.markRenew(id);
        throw err;
      });
    this.tokens.set(id, { refreshing });
    return refreshing;
  }

  // One API request with a token. Returns the JSON answer, or null for an empty one.
  async request(a, token, method, p, body) {
    let res;
    try {
      res = await this.fetch(`${a.api}${p}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(API_TIMEOUT)
      });
    } catch (_) {
      throw videoError('network', t('errors.video.connection', { service: a.name }));
    }
    let answer = null;
    try {
      const raw = await res.text();
      answer = raw ? JSON.parse(raw) : null;
    } catch (_) {
      answer = null;
    }
    if (res.ok) return answer;
    if (res.status === 401) throw videoError('unauthorized', t('errors.video.expired', { service: a.name }));
    if (res.status === 404) throw videoError('not_found', t('errors.video.gone', { service: a.name }));
    const reason = String(a.errorText(answer) || res.status).split(/\r?\n/)[0].slice(0, 200);
    if (res.status >= 500 || res.status === 429) throw videoError('failed', t('errors.video.request', { service: a.name, reason }));
    throw videoError('refused', t('errors.video.refused', { service: a.name, reason }));
  }

  // A request with this computer's sign-in. A token the service turns down is refreshed once; turned down again, the
  // sign-in needs renewing.
  async call(id, method, p, body) {
    const a = this.adapter(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.access(id);
      try {
        return await this.request(a, token, method, p, body);
      } catch (err) {
        if (err.code !== 'unauthorized') throw err;
        const cached = this.tokens.get(id);
        if (cached && cached.accessToken === token) this.tokens.delete(id);
      }
    }
    this.markRenew(id);
    throw videoError('renew', t('errors.video.expired', { service: a.name }));
  }

  // ---------- meetings ----------

  // A new meeting. meeting: { title, start, end, timeZone }. Returns { service, id, url }, the reference a booking
  // keeps to move and delete it.
  async create(id, meeting) {
    const a = this.adapter(id);
    // Says 'off' or 'renew' when the service can't be used on this computer.
    await this.access(id);
    if (a.kind === 'room') {
      const room = this.file.rooms[id] || {};
      return { service: id, ...a.create({ server: room.server || '' }) };
    }
    const made = await a.create((method, p, body) => this.call(id, method, p, body), meeting);
    if (!made) throw videoError('failed', t('errors.video.noLink', { service: a.name }));
    return { service: id, id: made.id, url: made.url };
  }

  // The meeting at the booking's new time. A room has no time.
  async update(ref, meeting) {
    const a = this.adapter(ref && ref.service);
    if (!a.update) return;
    await a.update((method, p, body) => this.call(a.id, method, p, body), ref, meeting);
  }

  // The meeting deleted. One the service no longer has is gone already; a room has nothing to delete.
  async remove(ref) {
    const a = this.adapter(ref && ref.service);
    if (!a.remove) return;
    try {
      await a.remove((method, p, body) => this.call(a.id, method, p, body), ref);
    } catch (err) {
      if (err.code !== 'not_found') throw err;
    }
  }
}

// The booking's event with its meeting: the link as the location, and a line with it at the top of the description,
// in the page's language.
function withMeeting(input, meeting, { locale, name }) {
  if (!meeting || typeof meeting.url !== 'string') return input;
  const line = translate(locale, 'booking.event.video', { service: name, url: meeting.url });
  return { ...input, location: meeting.url, description: [line, input.description].filter(Boolean).join('\n\n') };
}

module.exports = { VideoServices, withMeeting, cleanClient, videoError };
