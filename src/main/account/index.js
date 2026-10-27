'use strict';

// A Rukoo account: Rukoo's own data (categories, the category each email got, corrections) on every device of one
// person, end-to-end encrypted. See docs/account.md for what it does and server/PROTOCOL.md for how.
//
// The data lives here first. Records work without an account and stay on this computer; signing in sends them to
// the account and brings in what the other devices wrote. The server is never required: when it can't be reached,
// everything keeps working here and goes out at the next sync.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { t } = require('../../i18n');
const keys = require('./crypto');
const { AccountError, serverUrl, request: httpRequest } = require('./client');

const PROTOCOL = 1;
const MIN_PASSWORD = 12;
const SYNC_EVERY = 5 * 60 * 1000;
const PUSH_AFTER = 2000;
const SAVE_AFTER = 1000;
const PULL_LIMIT = 1000;
const PUSH_BATCH = 500;
// Collections whose records are decided once, by the first device to write one (server/PROTOCOL.md, Collections).
const FIRST_WRITE_WINS = new Set(['classification']);
// Which of two versions of a record wins: the later change, and on a tie the larger value, so every device picks the
// same one whatever order they arrive in.
const gone = (x) => (x.d || x.deleted ? 1 : 0);
const newer = (a, b) => a.t > b.t || (a.t === b.t && JSON.stringify([gone(a), a.v]) > JSON.stringify([gone(b), b.v]));
// Rounds of pull and push in one sync, enough for a refused first write or a newer value that has to go up again.
const SYNC_ROUNDS = 3;
const ERRORS = new Set([
  'invalid', 'unauthorized', 'locked', 'rate_limited', 'exists', 'signups_closed', 'invite_required', 'quota', 'too_large',
  'not_configured', 'network', 'server', 'invalid_email', 'weak_password', 'recovery_key', 'weak_kdf', 'no_server', 'protocol',
  'signed_in', 'signed_out', 'wrong_password'
]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// An error with a message for the person and a code for the code. Server codes Rukoo doesn't know read as 'server'.
function fail(code, status = 0) {
  const known = ERRORS.has(code) ? code : 'server';
  return new AccountError(known, status, t(`account.errors.${known}`));
}

function translated(err) {
  if (err instanceof AccountError) return fail(err.code, err.status);
  return err;
}

const entryKey = (c, k) => `${c}\n${k}`;
const validEmail = (email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 320;

class AccountService extends EventEmitter {
  // request and now can be replaced in tests.
  constructor({ dataDir, secrets, defaultServer = '', deviceName, platform = process.platform, request = httpRequest, now = Date.now }) {
    super();
    this.dataDir = dataDir;
    this.secrets = secrets;
    this.defaultServer = serverUrl(defaultServer) || '';
    this.deviceName = String(deviceName || os.hostname() || 'Rukoo').slice(0, 100);
    this.platform = platform;
    this.http = request;
    this.now = now;
    this.state = {};
    this.entries = new Map();
    this.ids = new Map();
    this.session = null;
    this.syncing = null;
    this.timers = { push: null, save: null, every: null };
  }

  file(name) {
    return path.join(this.dataDir, name);
  }

  init() {
    this.state = readJson(this.file('account.json'), {});
    const saved = readJson(this.file('account-records.json'), { entries: [] });
    for (const e of Array.isArray(saved.entries) ? saved.entries : []) {
      if (e && typeof e.c === 'string' && typeof e.k === 'string') this.entries.set(entryKey(e.c, e.k), e);
    }
    if (this.state.email && this.state.token && this.state.dataKey) {
      try {
        this.open({ token: this.secrets.decrypt(this.state.token), dataKey: Buffer.from(this.secrets.decrypt(this.state.dataKey), 'base64') });
      } catch (_) {
        // Stored under another user or on another computer: the keys don't open here, so this device signs in again.
        this.state.error = 'signed_out';
        this.forget();
      }
    }
    return this;
  }

  get server() {
    return this.state.server || this.defaultServer;
  }

  get signedIn() {
    return Boolean(this.session);
  }

  status() {
    const counts = {};
    let pending = 0;
    for (const e of this.entries.values()) {
      if (e.dirty) pending += 1;
      if (!e.deleted) counts[e.c] = (counts[e.c] || 0) + 1;
    }
    return {
      server: this.server,
      defaultServer: this.defaultServer,
      signedIn: this.signedIn,
      email: this.signedIn ? this.state.email : null,
      lastSync: this.state.lastSync || null,
      syncing: Boolean(this.syncing),
      error: this.state.error || null,
      errorText: this.state.error ? t(`account.errors.${ERRORS.has(this.state.error) ? this.state.error : 'server'}`) : null,
      info: this.state.info && this.state.info.server === this.server ? this.state.info.data : null,
      pending: this.signedIn ? pending : 0,
      counts
    };
  }

  // ---- talking to the server ----

  // session: the one a signed-in call is made for. Its answer may come after this device signed out or into
  // another account; a 401 then says nothing about the session there is now.
  async call(method, route, body, { auth = false, server = this.server, session = this.session } = {}) {
    if (!server) throw fail('no_server');
    try {
      return await this.http(server, method, route, { body, token: auth ? session && session.token : undefined });
    } catch (err) {
      // The session ended elsewhere: this device was removed or the password changed on another one.
      if (auth && err instanceof AccountError && err.status === 401) {
        if (session && this.session === session) {
          this.state.error = 'signed_out';
          this.forget();
          this.changedStatus();
        }
        throw fail('signed_out', 401);
      }
      throw translated(err);
    }
  }

  // Who runs the server and where it keeps data; shown before anyone signs up. The current server's is kept.
  async serverInfo(url = this.server) {
    const server = serverUrl(url);
    if (!server) throw fail('no_server');
    const data = await this.call('GET', '/v1/info', undefined, { server });
    if (!data || data.protocol !== PROTOCOL) throw fail('protocol');
    if (server === this.server) {
      this.state.info = { server, data, at: this.now() };
      this.saveState();
    }
    return data;
  }

  setServer(url) {
    if (this.signedIn) throw fail('signed_in');
    const server = url ? serverUrl(url) : '';
    if (url && !server) throw fail('no_server');
    this.state.server = server && server !== this.defaultServer ? server : null;
    this.state.info = null;
    this.saveState();
    this.changedStatus();
    return this.status();
  }

  device() {
    return { name: this.deviceName, platform: this.platform };
  }

  // ---- signing up, in and out ----

  checkNew(email, password) {
    if (this.signedIn) throw fail('signed_in');
    if (!validEmail(email)) throw fail('invalid_email');
    if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) throw fail('weak_password');
    this.checkStorage();
  }

  // The session has to be stored safely (secrets.js); without a keyring, stop before the server makes an account.
  checkStorage() {
    this.secrets.encrypt('rukoo');
  }

  async signUp({ email, password, invite }) {
    const address = keys.normalizeEmail(email);
    this.checkNew(address, password);
    await this.serverInfo();
    const salt = crypto.randomBytes(16);
    const kdf = { ...keys.DEFAULT_KDF };
    const { authKey, wrapKey } = await keys.passwordKeys(password, salt, kdf, this.server);
    const dataKey = crypto.randomBytes(32);
    const recoveryKey = crypto.randomBytes(20);
    const { recoveryAuth, recoveryWrap } = keys.recoveryKeys(recoveryKey, this.server);
    const res = await this.call('POST', '/v1/signup', {
      email: address,
      ...(invite ? { invite: String(invite).trim() } : {}),
      kdf,
      salt: keys.b64u(salt),
      authKey: keys.b64u(authKey),
      wrappedKey: keys.b64u(keys.wrapDataKey(wrapKey, dataKey)),
      recoveryAuth: keys.b64u(recoveryAuth),
      recoveryWrappedKey: keys.b64u(keys.wrapDataKey(recoveryWrap, dataKey)),
      device: this.device()
    });
    this.attach(address, res.token, dataKey);
    return { recoveryKey: keys.formatRecoveryKey(recoveryKey), account: res.account };
  }

  // authKey for the password, with the parameters the server keeps for the address. Refuses weak ones.
  async authFor(email, password) {
    const pre = await this.call('POST', '/v1/prelogin', { email });
    let kdf;
    try {
      kdf = keys.checkKdf(pre && pre.kdf);
    } catch (_) {
      throw fail('weak_kdf');
    }
    let salt;
    try {
      salt = keys.unb64u(pre.salt, 16);
    } catch (_) {
      throw fail('server');
    }
    return keys.passwordKeys(password, salt, kdf, this.server);
  }

  async signIn({ email, password }) {
    const address = keys.normalizeEmail(email);
    if (this.signedIn) throw fail('signed_in');
    if (!validEmail(address)) throw fail('invalid_email');
    if (typeof password !== 'string' || !password) throw fail('unauthorized');
    this.checkStorage();
    await this.serverInfo();
    const { authKey, wrapKey } = await this.authFor(address, password);
    const res = await this.call('POST', '/v1/login', { email: address, authKey: keys.b64u(authKey), device: this.device() });
    let dataKey;
    try {
      dataKey = keys.unwrapDataKey(wrapKey, keys.unb64u(res.wrappedKey));
    } catch (_) {
      throw fail('server');
    }
    this.attach(address, res.token, dataKey);
    return { account: res.account };
  }

  // A forgotten password: the recovery key opens the data key, and a new password takes over.
  async recover({ email, recoveryKey, password }) {
    const address = keys.normalizeEmail(email);
    this.checkNew(address, password);
    const key = keys.parseRecoveryKey(recoveryKey);
    if (!key) throw fail('recovery_key');
    await this.serverInfo();
    const { recoveryAuth, recoveryWrap } = keys.recoveryKeys(key, this.server);
    const start = await this.call('POST', '/v1/recover/start', { email: address, recoveryAuth: keys.b64u(recoveryAuth) });
    let dataKey;
    try {
      dataKey = keys.unwrapDataKey(recoveryWrap, keys.unb64u(start.recoveryWrappedKey));
    } catch (_) {
      throw fail('server');
    }
    const salt = crypto.randomBytes(16);
    const kdf = { ...keys.DEFAULT_KDF };
    const { authKey, wrapKey } = await keys.passwordKeys(password, salt, kdf, this.server);
    const res = await this.call('POST', '/v1/recover/finish', {
      email: address,
      recoveryAuth: keys.b64u(recoveryAuth),
      kdf,
      salt: keys.b64u(salt),
      authKey: keys.b64u(authKey),
      wrappedKey: keys.b64u(keys.wrapDataKey(wrapKey, dataKey)),
      device: this.device()
    });
    this.attach(address, res.token, dataKey);
    return { account: res.account };
  }

  // Only the session this was asked for: a slow answer must not sign out one made meanwhile.
  async signOut() {
    if (!this.signedIn) return this.status();
    const session = this.session;
    await this.call('POST', '/v1/logout', undefined, { auth: true, session }).catch(() => {});
    if (this.session === session) {
      this.state.error = null;
      this.forget();
      this.changedStatus();
    }
    return this.status();
  }

  async details() {
    if (!this.signedIn) throw fail('signed_out');
    return this.call('GET', '/v1/account', undefined, { auth: true });
  }

  async removeDevice(id) {
    if (!this.signedIn) throw fail('signed_out');
    await this.call('DELETE', `/v1/devices/${encodeURIComponent(String(id))}`, undefined, { auth: true });
    return true;
  }

  async changePassword(current, next) {
    if (!this.signedIn) throw fail('signed_out');
    if (typeof next !== 'string' || [...next].length < MIN_PASSWORD) throw fail('weak_password');
    const { authKey } = await this.authFor(this.state.email, current);
    const salt = crypto.randomBytes(16);
    const kdf = { ...keys.DEFAULT_KDF };
    const fresh = await keys.passwordKeys(next, salt, kdf, this.server);
    await this.call(
      'POST',
      '/v1/password',
      {
        authKey: keys.b64u(authKey),
        kdf,
        salt: keys.b64u(salt),
        newAuthKey: keys.b64u(fresh.authKey),
        wrappedKey: keys.b64u(keys.wrapDataKey(fresh.wrapKey, this.session.dataKey))
      },
      { auth: true }
    );
    return true;
  }

  // A new recovery key; the old one stops working.
  async newRecoveryKey(password) {
    if (!this.signedIn) throw fail('signed_out');
    const { authKey } = await this.authFor(this.state.email, password);
    const recoveryKey = crypto.randomBytes(20);
    const { recoveryAuth, recoveryWrap } = keys.recoveryKeys(recoveryKey, this.server);
    await this.call(
      'POST',
      '/v1/recovery',
      {
        authKey: keys.b64u(authKey),
        recoveryAuth: keys.b64u(recoveryAuth),
        recoveryWrappedKey: keys.b64u(keys.wrapDataKey(recoveryWrap, this.session.dataKey))
      },
      { auth: true }
    );
    return { recoveryKey: keys.formatRecoveryKey(recoveryKey) };
  }

  // Deletes the account and everything in it on the server. This computer keeps its own copy.
  async deleteAccount(password) {
    if (!this.signedIn) throw fail('signed_out');
    const session = this.session;
    const { authKey } = await this.authFor(this.state.email, password);
    await this.call('DELETE', '/v1/account', { authKey: keys.b64u(authKey) }, { auth: true, session });
    if (this.session === session) {
      this.state.error = null;
      this.forget();
      this.changedStatus();
    }
    return this.status();
  }

  open({ token, dataKey }) {
    this.session = { token, dataKey, keys: keys.recordKeys(dataKey) };
    this.ids.clear();
    for (const [key, e] of this.entries) {
      e.id = keys.recordId(this.session.keys.indexKey, e.c, e.k);
      this.ids.set(e.id, key);
    }
    clearInterval(this.timers.every);
    this.timers.every = setInterval(() => this.sync().catch(() => {}), SYNC_EVERY);
    if (this.timers.every.unref) this.timers.every.unref();
  }

  // This device joins the account. Everything it has goes up; what the account has comes down first, so an older
  // value here doesn't overwrite a newer one there.
  attach(email, token, dataKey) {
    this.state = {
      ...this.state,
      email,
      token: this.secrets.encrypt(token),
      dataKey: this.secrets.encrypt(dataKey.toString('base64')),
      cursor: 0,
      lastSync: null,
      error: null
    };
    for (const e of this.entries.values()) {
      delete e.seq;
      e.dirty = true;
      // A first write, unless it is a deletion: that settles by its time, like any other.
      if (FIRST_WRITE_WINS.has(e.c) && !e.deleted) e.ifAbsent = e.first = true;
    }
    this.open({ token, dataKey });
    this.saveState();
    this.saveEntries(true);
    this.changedStatus();
    this.sync().catch(() => {});
  }

  forget() {
    this.session = null;
    clearInterval(this.timers.every);
    clearTimeout(this.timers.push);
    this.ids.clear();
    for (const [key, e] of this.entries) {
      delete e.id;
      delete e.seq;
      delete e.dirty;
      delete e.ifAbsent;
    }
    const { server, info, error } = this.state;
    this.state = { server, info, error };
    this.saveState();
    this.saveEntries(true);
  }

  // ---- records ----

  get(c, k) {
    const e = this.entries.get(entryKey(c, k));
    return e && !e.deleted ? e.v : undefined;
  }

  list(c) {
    const out = [];
    for (const e of this.entries.values()) if (e.c === c && !e.deleted) out.push({ k: e.k, v: e.v, t: e.t });
    return out;
  }

  // Returns false when ifAbsent and the record already exists. An ifAbsent record is a first write: when another
  // device's first write reaches the server before it, that one stays, whatever the times say.
  put(c, k, v, { ifAbsent = false } = {}) {
    const key = entryKey(c, k);
    const was = this.entries.get(key);
    if (ifAbsent && was && !was.deleted) return false;
    const e = { c, k, v, t: Math.max(this.now(), was ? was.t + 1 : 0), dirty: true };
    if (ifAbsent) e.ifAbsent = e.first = true;
    this.track(key, e);
    this.changedRecords([c]);
    return true;
  }

  // A deletion is kept, and goes up, as a record of its own (d: true) with its time, so it settles against a change
  // on another device like any other write, also when it was made while signed out.
  remove(c, k) {
    const key = entryKey(c, k);
    const was = this.entries.get(key);
    if (!was || was.deleted) return false;
    this.track(key, { c, k, v: null, t: Math.max(this.now(), was.t + 1), deleted: true, dirty: true });
    this.changedRecords([c]);
    return true;
  }

  track(key, e) {
    if (this.signedIn) {
      e.id = keys.recordId(this.session.keys.indexKey, e.c, e.k);
      this.ids.set(e.id, key);
    } else delete e.dirty;
    this.entries.set(key, e);
    this.saveEntries();
    if (this.signedIn) {
      clearTimeout(this.timers.push);
      this.timers.push = setTimeout(() => this.sync().catch(() => {}), PUSH_AFTER);
      if (this.timers.push.unref) this.timers.push.unref();
    }
  }

  // Everything this device keeps, readable: what "Export my data" saves.
  exportData() {
    const records = [...this.entries.values()]
      .filter((e) => !e.deleted)
      .map((e) => ({ collection: e.c, key: e.k, value: e.v, changed: new Date(e.t).toISOString() }));
    return {
      exportedAt: new Date(this.now()).toISOString(),
      server: this.signedIn ? this.server : null,
      email: this.signedIn ? this.state.email : null,
      records
    };
  }

  // ---- sync ----

  // A sync belongs to the session it started in. When this device signs out or into another account meanwhile, what
  // the server still answers for the old one is dropped, and the new session gets a sync of its own.
  sync() {
    if (!this.signedIn) return Promise.resolve(this.status());
    const session = this.session;
    if (this.syncing && this.syncing.session === session) return this.syncing.promise;
    const current = () => this.session === session;
    const promise = (async () => {
      this.changedStatus();
      try {
        for (let round = 0; round < SYNC_ROUNDS && current(); round++) {
          await this.pull(session);
          const refused = await this.push(session);
          if (!refused && ![...this.entries.values()].some((e) => e.dirty)) break;
        }
        if (current()) {
          this.state.lastSync = this.now();
          this.state.error = null;
        }
      } catch (err) {
        if (current()) this.state.error = err instanceof AccountError ? err.code : 'server';
        throw translated(err);
      } finally {
        if (this.syncing && this.syncing.promise === promise) this.syncing = null;
        if (current()) this.saveState();
        this.saveEntries(true);
        this.changedStatus();
      }
      return this.status();
    })();
    this.syncing = { session, promise };
    return promise;
  }

  async pull(session = this.session) {
    const touched = new Set();
    for (;;) {
      if (!session || this.session !== session) return;
      const since = Number(this.state.cursor) || 0;
      const res = await this.call('GET', `/v1/records?since=${since}&limit=${PULL_LIMIT}`, undefined, { auth: true, session });
      if (this.session !== session) return;
      const records = Array.isArray(res && res.records) ? res.records : [];
      for (const r of records) {
        const c = this.applyRemote(r);
        if (c) touched.add(c);
        if (Number(r.seq) > this.state.cursor) this.state.cursor = Number(r.seq);
      }
      if (!res || !res.more || !records.length) break;
    }
    if (touched.size) this.changedRecords([...touched]);
  }

  // Takes one record from the server; returns its collection when this device's data changed.
  applyRemote({ id, seq, data }) {
    const key = this.ids.get(id);
    const local = key ? this.entries.get(key) : null;
    // A tombstone the server keeps for data null. Rukoo deletes with d: true instead, but takes these too.
    if (data === null || data === undefined) {
      if (!local || local.dirty) return null;
      this.entries.delete(key);
      this.ids.delete(id);
      return local.c;
    }
    const rec = keys.openRecord(this.session.keys, id, data);
    if (!rec) return null;
    const k = entryKey(rec.c, rec.k);
    const mine = this.entries.get(k);
    if (mine && !mine.dirty && mine.seq === Number(seq)) return null;
    // Two devices that changed a record at about the same time may reach the server in either order. The later
    // change wins on every device: one that is newer here goes up again, also after it was sent once. A first write
    // (a classification) is the exception: the server keeps whichever came first.
    if (mine && !mine.first && newer(mine, rec)) {
      mine.dirty = true;
      return null;
    }
    const e = { c: rec.c, k: rec.k, v: rec.v, t: rec.t, id, seq: Number(seq) };
    if (rec.d) e.deleted = true;
    this.entries.set(k, e);
    this.ids.set(id, k);
    return rec.c;
  }

  // Sends this device's changes; true when the server kept another device's record for some of them.
  async push(session = this.session) {
    let refused = false;
    for (;;) {
      if (!session || this.session !== session) return refused;
      const batch = [...this.entries.values()].filter((e) => e.dirty).slice(0, PUSH_BATCH);
      if (!batch.length) return refused;
      const records = batch.map((e) => {
        const out = keys.sealRecord(session.keys, e.deleted ? { ...e, v: null, d: true } : e);
        if (e.ifAbsent && !e.deleted) out.ifAbsent = true;
        return out;
      });
      const res = await this.call('POST', '/v1/records', { records }, { auth: true, session });
      if (this.session !== session) return refused;
      const results = new Map((Array.isArray(res && res.results) ? res.results : []).map((r) => [r.id, r]));
      for (const e of batch) {
        const r = results.get(e.id);
        // Changed again while this was on its way: it goes up with the next batch.
        if (!r || this.entries.get(entryKey(e.c, e.k)) !== e) continue;
        delete e.dirty;
        delete e.ifAbsent;
        if (r.stored) {
          e.seq = Number(r.seq);
          continue;
        }
        // Another device's first write came first. The next pull must bring it, even when it is older than the cursor.
        refused = true;
        delete e.seq;
        this.state.cursor = Math.min(Number(this.state.cursor) || 0, Number(r.seq) - 1);
      }
      this.saveEntries();
    }
  }

  // ---- persistence and events ----

  saveState() {
    writeJson(this.file('account.json'), this.state);
  }

  saveEntries(now = false) {
    clearTimeout(this.timers.save);
    const write = () => writeJson(this.file('account-records.json'), { entries: [...this.entries.values()] });
    if (now) return write();
    this.timers.save = setTimeout(write, SAVE_AFTER);
    if (this.timers.save.unref) this.timers.save.unref();
  }

  // Writes what waits and stops the timers, for quitting.
  close() {
    clearInterval(this.timers.every);
    clearTimeout(this.timers.push);
    if (this.timers.save) this.saveEntries(true);
  }

  changedStatus() {
    this.emit('status', this.status());
  }

  changedRecords(collections) {
    this.emit('records', { collections });
  }
}

module.exports = { AccountService, MIN_PASSWORD };
