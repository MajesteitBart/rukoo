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
const { t, getLanguage } = require('../../i18n');
const keys = require('./crypto');
const { AccountError, serverUrl, request: httpRequest } = require('./client');

const PROTOCOL = 1;
// The versions of the workspace protocol (server/WORKSPACES.md) this Rukoo speaks. Version 2 takes a message with
// files and no text as it is; version 1 gets a text standing in for it.
const WORKSPACE_VERSIONS = [1, 2];
const MIN_PASSWORD = 12;
const SYNC_EVERY = 5 * 60 * 1000;
const PUSH_AFTER = 2000;
const SAVE_AFTER = 1000;
const SAVE_RETRY = 30000;
const PULL_LIMIT = 1000;
const PUSH_BATCH = 500;
// When one pull stops asking for more: after 500 pages of 1000 records and tombstones, or once 256 MiB of answers counted
// whole, with the fields Rukoo ignores, have come in. The meter is checked between pages, so the page that crosses it is
// the last. A full account is about 170 MiB of them (server/PROTOCOL.md).
const PULL_PAGES = 500;
const PULL_DATA = 256 * 1024 * 1024;
// A record id is an HMAC-SHA256 in base64url (server/PROTOCOL.md, Records).
const RECORD_ID = /^[A-Za-z0-9_-]{43}$/;
// The most a record may take on the server, once sealed (server/PROTOCOL.md).
const RECORD_BYTES = 16384;
// Collections whose records are decided once, by the first device to write one (server/PROTOCOL.md, Collections).
// A booking page's key pair is one of them, so two devices that make one at the same time end up with the same.
const FIRST_WRITE_WINS = new Set(['classification', 'bookingkey']);
// Collections whose keys name the Rukoo account they belong to (<acct>); see bookingAcct().
const PER_ACCOUNT = new Set(['booking', 'bookingkey']);
// Addresses Rukoo used as its default server before. A device signed in at one keeps it (pin()) while the session
// lasts; once it ends, the device goes back to the default (forget()).
const FORMER_SERVERS = ['https://rukoo-account.bvdm.ai'];
// Which of two versions of a record wins: the later change, and on a tie the larger value, so every device picks the
// same one whatever order they arrive in.
const gone = (x) => (x.d || x.deleted ? 1 : 0);
const newer = (a, b) => a.t > b.t || (a.t === b.t && JSON.stringify([gone(a), a.v]) > JSON.stringify([gone(b), b.v]));
// Rounds of pull and push in one sync, enough for a refused first write or a newer value that has to go up again.
const SYNC_ROUNDS = 3;
const ERRORS = new Set([
  'invalid', 'unauthorized', 'locked', 'rate_limited', 'exists', 'signups_closed', 'invite_required', 'quota', 'too_large',
  'not_configured', 'network', 'server', 'invalid_email', 'weak_password', 'recovery_key', 'weak_kdf', 'no_server', 'protocol',
  'signed_in', 'signed_out', 'wrong_password',
  // Codes sent by email (server/PROTOCOL.md, POST /v1/email-code), and code_format, a typed code that is neither the
  // six digits nor the long code.
  'code_required', 'code_wrong', 'code_expired', 'code_in_use', 'mail_unavailable', 'code_format',
  // The booking routes (server/PROTOCOL.md, Owner errors).
  'handle_taken', 'handle_reserved', 'handle_lost', 'handle_changes', 'has_bookings', 'other_device', 'not_found', 'slot_taken',
  'stale_version', 'not_active'
]);
// What a code is for: a sign-up on a server that checks addresses, or a sign-in or recovery past the account's lock.
const CODE_PURPOSES = ['signup', 'unlock'];
// A challenge, and the long code in the email: 32 random bytes in base64url.
const CODE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Codes asked for are kept by purpose and address, a few at most.
const codeKey = (purpose, address) => `${purpose}
${address}`;
const MAX_HELD_CODES = 8;

// Whether the server mails codes for purpose: email-codes in its features and the purpose in emailCodes.purposes
// (server/PROTOCOL.md, GET /v1/info). Without both, sign-up and sign-in work as they did before codes.
const codesFor = (info, purpose) =>
  Boolean(
    info &&
      Array.isArray(info.features) &&
      info.features.includes('email-codes') &&
      info.emailCodes &&
      Array.isArray(info.emailCodes.purposes) &&
      info.emailCodes.purposes.includes(purpose)
  );

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
function fail(code, status = 0, details = null) {
  const known = ERRORS.has(code) ? code : 'server';
  return new AccountError(known, status, t(`account.errors.${known}`), details);
}

function translated(err) {
  if (err instanceof AccountError) return fail(err.code, err.status, err.details);
  return err;
}

const entryKey = (c, k) => `${c}\n${k}`;
const validEmail = (email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 320;

// <acct>: the first 16 characters of base64url(SHA-256) of the trimmed, lowercased Rukoo account email. Booking
// records carry it in their keys, so a device signed in to another account never uses them (server/PROTOCOL.md).
const bookingAcct = (email) => crypto.createHash('sha256').update(keys.normalizeEmail(email), 'utf8').digest('base64url').slice(0, 16);

// The <acct> a booking record's key names: bookingkey/<acct>, booking/settings:<acct>, booking/map:<acct>:<id>.
function acctOfKey(c, k) {
  if (c === 'bookingkey') return k;
  const m = /^[a-z]+:([A-Za-z0-9_-]{16})(?::|$)/.exec(k);
  return m ? m[1] : null;
}

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
    this.durableCursor = 0;
    // Runs before the account is deleted on the server and stops the deletion when it throws: the booking service
    // turns the booking page off first (main.js).
    this.beforeDelete = null;
    // The last code asked for, by purpose and address (codeKey): { server, challenge, until }. Only in memory: the
    // challenge is what the six digits count with, and only this device got it (requestCode).
    this.codes = new Map();
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
    // The cursor as of the records last written to disk: the state on disk never goes past it.
    this.durableCursor = Number(this.state.cursor) || 0;
    if (this.state.email && this.state.token && this.state.dataKey) {
      this.pin();
      try {
        this.open({ token: this.secrets.decrypt(this.state.token), dataKey: Buffer.from(this.secrets.decrypt(this.state.dataKey), 'base64'), server: this.server });
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

  // A session belongs to the address it signed in at, because the password proofs include it (server/PROTOCOL.md,
  // Keys). A device that signed in at the default keeps that address when a newer Rukoo has another default. Sessions
  // from before sessionServer was kept have the server info fetched at sign-in, which is for the same address.
  pin() {
    if (this.state.server) return;
    const at = serverUrl(this.state.sessionServer || (this.state.info && this.state.info.server));
    if (!at || at === this.defaultServer) return;
    this.state.server = at;
    this.saveState();
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
  // another account; a 401 then says nothing about the session there is now. meter: { bytes } the answer's size is
  // added to. raw: the server's own error comes back as it is, with its code and details, instead of one of ERRORS;
  // a 401 still ends the session. headers: extra request headers (client.js lets only a few through). server: where
  // the call goes; a signed-in call goes to the address its session signed in at, so its token never reaches another.
  async call(method, route, body, { auth = false, server, session = this.session, meter, raw = false, headers } = {}) {
    const to = server || (auth && session && session.server) || this.server;
    if (!to) throw fail('no_server');
    try {
      return await this.http(to, method, route, { body, token: auth ? session && session.token : undefined, meter, headers });
    } catch (err) {
      // The session ended elsewhere: this device was removed or the password changed on another one.
      if (auth && err instanceof AccountError && err.status === 401) {
        if (session && this.session === session) {
          this.state.error = 'signed_out';
          // The session is over even when account.json can't be written now: the status goes out regardless, so
          // the services that follow it (team chat deletes its cache) end theirs too. The next write saves the state.
          try {
            this.forget();
          } catch (_) {
            // forget() cleared the session before it tried to save.
          }
          this.changedStatus();
        }
        throw fail('signed_out', 401);
      }
      throw raw ? err : translated(err);
    }
  }

  // The workspace routes (server/WORKSPACES.md) with this session, in the newest version of their protocol both this
  // Rukoo and the server speak (workspaceVersion). Unlike call(), the server's own error code and details survive,
  // because the team chat service acts on them (stale_grant, reset_required, scope). A 401 from any of them ends the
  // session, as from every other route.
  async workspaceCall(method, route, body, { session = this.session } = {}) {
    if (!this.signedIn || !session) throw fail('signed_out');
    const headers = { 'rukoo-workspace-version': String(this.workspaceVersion(session.server)) };
    return this.call(method, route, body, { auth: true, session, raw: true, headers });
  }

  // The highest workspace protocol version this Rukoo and the server's saved GET /v1/info both list, else 1.
  workspaceVersion(server) {
    const info = this.state.info && this.state.info.server === server ? this.state.info.data : null;
    const theirs = info && info.workspace && Array.isArray(info.workspace.versions) ? info.workspace.versions : [];
    return Math.max(1, ...WORKSPACE_VERSIONS.filter((v) => theirs.includes(v)));
  }

  // A short, stable tag of the session: the first 22 characters of base64url SHA-256 of its token. The team chat cache
  // keeps it, so a cache is only ever shown to the session that built it (contract 3.4). null while signed out.
  get sessionTag() {
    return this.session ? crypto.createHash('sha256').update(String(this.session.token), 'utf8').digest('base64url').slice(0, 22) : null;
  }

  // Who runs the server and where it keeps data; shown before anyone signs up. The current server's is kept, and
  // 'info' tells the services that read it (team chat's availability) that it may have changed.
  async serverInfo(url = this.server) {
    const server = serverUrl(url);
    if (!server) throw fail('no_server');
    const data = await this.call('GET', '/v1/info', undefined, { server });
    if (!data || data.protocol !== PROTOCOL) throw fail('protocol');
    if (server === this.server) {
      this.state.info = { server, data, at: this.now() };
      this.saveState();
      this.emit('info', data);
    }
    return data;
  }

  // When the current server's saved GET /v1/info was fetched, or null without one.
  infoAt() {
    const saved = this.state.info;
    return saved && saved.server === this.server && Number.isFinite(saved.at) ? saved.at : null;
  }

  setServer(url) {
    if (this.signedIn) throw fail('signed_in');
    const server = url ? serverUrl(url) : '';
    if (url && !server) throw fail('no_server');
    this.state.server = server && server !== this.defaultServer ? server : null;
    this.state.info = null;
    delete this.state.formerServer;
    delete this.state.formerEmail;
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

  // ---- codes by email ----

  // POST /v1/email-code: the server mails a code to email for purpose, 'signup' or 'unlock'. The challenge it answers,
  // which the six digits count only with and which only this device gets, stays here in memory for the sign-up,
  // sign-in or recovery that follows (emailCodeFor); the window gets the address and how long the six digits work. A
  // new request for the same purpose and address replaces the one before, so the newest email's six digits are the
  // ones that work here; one for another address, answered late, leaves this address's alone.
  async requestCode({ email, purpose }) {
    const address = keys.normalizeEmail(email);
    if (this.signedIn) throw fail('signed_in');
    if (!validEmail(address)) throw fail('invalid_email');
    if (!CODE_PURPOSES.includes(purpose)) throw fail('invalid');
    const at = this.server;
    const lang = getLanguage() === 'nl' ? 'nl' : 'en';
    const res = await this.call('POST', '/v1/email-code', { email: address, purpose, lang }, { server: at });
    const challenge = res && typeof res.challenge === 'string' && CODE_TOKEN.test(res.challenge) ? res.challenge : null;
    if (!challenge) throw fail('server');
    const expiresIn = Number.isSafeInteger(res.expiresIn) && res.expiresIn > 0 ? Math.min(res.expiresIn, 3600) : 600;
    const key = codeKey(purpose, address);
    this.codes.delete(key);
    this.codes.set(key, { server: at, challenge, until: this.now() + expiresIn * 1000 });
    // A few addresses at most are worth keeping: the oldest go first.
    while (this.codes.size > MAX_HELD_CODES) this.codes.delete(this.codes.keys().next().value);
    return { email: address, expiresIn };
  }

  // emailCode for a request to the server at, from what the person typed: null when nothing was typed, { token } for
  // the long code, { challenge, code } for six digits with the challenge this device got for the same address, purpose
  // and server. Spaces, line breaks and dashes are left out, as people paste them. Six digits without such a challenge
  // (asked for on another device, before Rukoo restarted, or expired here) can't work: code_expired, whose message
  // says to ask again or paste the long code.
  emailCodeFor(purpose, address, at, typed) {
    const text = typeof typed === 'string' ? typed.replace(/\s+/g, '') : '';
    if (!text) return null;
    if (CODE_TOKEN.test(text)) return { token: text };
    const digits = text.replace(/-/g, '');
    if (!/^\d{6}$/.test(digits)) throw fail('code_format');
    const held = this.codes.get(codeKey(purpose, address));
    if (!held || held.server !== at || held.until <= this.now()) throw fail('code_expired');
    return { challenge: held.challenge, code: digits };
  }

  // After a request that carried emailCode: a code the server took is used up, and six digits that no longer work
  // (code_expired, or wrong for the last time) leave nothing worth keeping. A long code that failed leaves the six
  // digits alone: they may be of another email.
  settleCode(purpose, address, emailCode, err = null) {
    if (!emailCode) return;
    const key = codeKey(purpose, address);
    const held = this.codes.get(key);
    if (!err) {
      this.codes.delete(key);
      return;
    }
    if (!held || held.challenge !== emailCode.challenge) return;
    const code = err && err.code;
    const last = code === 'code_wrong' && err.details && err.details.attemptsLeft === 0;
    if (code === 'code_expired' || last) this.codes.delete(key);
  }

  // workspaceInvite: { workspace, invite } from a team chat invitation link, which a server that takes accounts by
  // invite code accepts in place of one (contract 2.12). Sent instead of invite.
  //
  // emailCode: what the person typed of a signup code (requestCode). A server that checks addresses
  // (codesFor(info, 'signup')) needs one for every sign-up without the operator's invite code, also one with a
  // workspace invitation (workspace.inviteSignupsNeedCode); without it this stops with code_required before the
  // password's keys are made, and the window asks for a code. A wrong invite code gets code_required from the server.
  // With an invite code, a typed code that can't be sent (code_format, code_expired here) doesn't stop the sign-up:
  // the invite code may do without it, and only when the server still asks for a code does that error come back.
  //
  // Sign-up, sign-in and recovery read the server once and use that address for every call and key: the server can
  // still change while they wait (only a session stops it), and attach() refuses the session when it did.
  async signUp({ email, password, invite, workspaceInvite, emailCode: typed }) {
    const address = keys.normalizeEmail(email);
    this.checkNew(address, password);
    const linked =
      workspaceInvite && typeof workspaceInvite === 'object' && typeof workspaceInvite.workspace === 'string' && typeof workspaceInvite.invite === 'string'
        ? { workspace: workspaceInvite.workspace.slice(0, 100), invite: workspaceInvite.invite.slice(0, 100) }
        : null;
    const plain = !linked && invite ? String(invite).trim() : '';
    const at = this.server;
    const info = await this.serverInfo(at);
    let emailCode = null;
    let unusable = null;
    try {
      emailCode = this.emailCodeFor('signup', address, at, typed);
    } catch (err) {
      if (!plain) throw err;
      unusable = err;
    }
    if (!emailCode && !plain && codesFor(info, 'signup')) throw fail('code_required', 403);
    const salt = crypto.randomBytes(16);
    const kdf = { ...keys.DEFAULT_KDF };
    const { authKey, wrapKey } = await keys.passwordKeys(password, salt, kdf, at);
    const dataKey = crypto.randomBytes(32);
    const recoveryKey = crypto.randomBytes(20);
    const { recoveryAuth, recoveryWrap } = keys.recoveryKeys(recoveryKey, at);
    let res;
    try {
      res = await this.call('POST', '/v1/signup', {
        email: address,
        ...(linked ? { workspaceInvite: linked } : plain ? { invite: plain } : {}),
        ...(emailCode ? { emailCode } : {}),
        kdf,
        salt: keys.b64u(salt),
        authKey: keys.b64u(authKey),
        wrappedKey: keys.b64u(keys.wrapDataKey(wrapKey, dataKey)),
        recoveryAuth: keys.b64u(recoveryAuth),
        recoveryWrappedKey: keys.b64u(keys.wrapDataKey(recoveryWrap, dataKey)),
        device: this.device()
      }, { server: at });
    } catch (err) {
      this.settleCode('signup', address, emailCode, err);
      throw unusable && err && err.code === 'code_required' ? unusable : err;
    }
    this.settleCode('signup', address, emailCode);
    this.attach(address, res.token, dataKey, at);
    return { recoveryKey: keys.formatRecoveryKey(recoveryKey), account: res.account };
  }

  // authKey for the password, with the parameters the server at keeps for the address. Refuses weak ones.
  async authFor(email, password, at = this.server) {
    const pre = await this.call('POST', '/v1/prelogin', { email }, { server: at });
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
    return keys.passwordKeys(password, salt, kdf, at);
  }

  // emailCode: what the person typed of an unlock code (requestCode), which lets the sign-in past the account's lock.
  async signIn({ email, password, emailCode: typed }) {
    const address = keys.normalizeEmail(email);
    if (this.signedIn) throw fail('signed_in');
    if (!validEmail(address)) throw fail('invalid_email');
    if (typeof password !== 'string' || !password) throw fail('unauthorized');
    this.checkStorage();
    const at = this.server;
    const former = this.state.server ? null : this.state.formerServer;
    const emailCode = this.emailCodeFor('unlock', address, at, typed);
    // This device went back to the default from a former one (forget()). An account made there signs in only there,
    // as the password proofs include the address: it is tried once, and kept when it works. The address stays with
    // this attempt until attach() commits it, and only while the attempt is still current: nobody signed in meanwhile
    // and the server is still the one it began at. A session made meanwhile keeps its own address.
    //
    // An unlock code goes to both: a former address reaches the same server (FORMER_SERVERS), whose codes don't depend
    // on the address they were asked at. Each wrong proof costs the code a try, so for the account that was signed in
    // at the former address (formerEmail) that address goes first, and its right password doesn't spend the code's
    // tries at the default first.
    const formerFirst = Boolean(former && emailCode && this.state.formerEmail === address);
    const hosts = !former ? [at] : formerFirst ? [former, at] : [at, former];
    let first = null;
    for (const host of hosts) {
      if (first) {
        if (first.code !== 'unauthorized') throw first;
        if (this.signedIn || this.server !== at || this.state.formerServer !== former) throw first;
      }
      try {
        const res = await this.login(address, password, host, at, emailCode);
        this.settleCode('unlock', address, emailCode);
        return res;
      } catch (err) {
        this.settleCode('unlock', address, emailCode, err);
        if (!first) {
          first = err || fail('server');
          continue;
        }
        // The second address took the password, but another sign-in got here first, or the code didn't do there:
        // that one says why. Otherwise the first answer does.
        throw err && (err.code === 'signed_in' || (emailCode && /^code_|^locked$/.test(err.code))) ? err : first;
      }
    }
    throw first;
  }

  // A sign-in at the address at. from: the server this device uses that the attempt began at, which differs from at
  // only for the former-address try of signIn(); attach() takes the session only while the device still uses from.
  // emailCode: an unlock code for at, from emailCodeFor.
  async login(address, password, at = this.server, from = at, emailCode = null) {
    const info = await this.serverInfo(at);
    const { authKey, wrapKey } = await this.authFor(address, password, at);
    const body = { email: address, authKey: keys.b64u(authKey), device: this.device(), ...(emailCode ? { emailCode } : {}) };
    const res = await this.call('POST', '/v1/login', body, { server: at });
    let dataKey;
    try {
      dataKey = keys.unwrapDataKey(wrapKey, keys.unb64u(res.wrappedKey));
    } catch (_) {
      throw fail('server');
    }
    this.attach(address, res.token, dataKey, at, { from, info });
    return { account: res.account };
  }

  // A forgotten password: the recovery key opens the data key, and a new password takes over. emailCode: what the
  // person typed of an unlock code, which goes with both steps: recover/start leaves the code for recover/finish.
  async recover({ email, recoveryKey, password, emailCode: typed }) {
    const address = keys.normalizeEmail(email);
    this.checkNew(address, password);
    const key = keys.parseRecoveryKey(recoveryKey);
    if (!key) throw fail('recovery_key');
    const at = this.server;
    const emailCode = this.emailCodeFor('unlock', address, at, typed);
    const code = emailCode ? { emailCode } : {};
    let settled = false;
    try {
      await this.serverInfo(at);
      const { recoveryAuth, recoveryWrap } = keys.recoveryKeys(key, at);
      const start = await this.call('POST', '/v1/recover/start', { email: address, recoveryAuth: keys.b64u(recoveryAuth), ...code }, { server: at });
      let dataKey;
      try {
        dataKey = keys.unwrapDataKey(recoveryWrap, keys.unb64u(start.recoveryWrappedKey));
      } catch (_) {
        throw fail('server');
      }
      const salt = crypto.randomBytes(16);
      const kdf = { ...keys.DEFAULT_KDF };
      const { authKey, wrapKey } = await keys.passwordKeys(password, salt, kdf, at);
      const res = await this.call('POST', '/v1/recover/finish', {
        email: address,
        recoveryAuth: keys.b64u(recoveryAuth),
        kdf,
        salt: keys.b64u(salt),
        authKey: keys.b64u(authKey),
        wrappedKey: keys.b64u(keys.wrapDataKey(wrapKey, dataKey)),
        device: this.device(),
        ...code
      }, { server: at });
      // The server used the code up with the new password, also when attach() refuses the session below.
      this.settleCode('unlock', address, emailCode);
      settled = true;
      this.attach(address, res.token, dataKey, at);
      return { account: res.account };
    } catch (err) {
      if (!settled) this.settleCode('unlock', address, emailCode, err);
      throw err;
    }
  }

  // Only the session this was asked for: a slow answer must not sign out one made meanwhile.
  async signOut() {
    if (!this.signedIn) return this.status();
    const session = this.session;
    await this.call('POST', '/v1/logout', undefined, { auth: true, session }).catch(() => {});
    if (this.session === session) {
      this.state.error = null;
      // Signed out even when the state can't be saved: the status goes out before that error does.
      try {
        this.forget();
      } finally {
        this.changedStatus();
      }
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
    if (typeof this.beforeDelete === 'function') {
      // The server checks the password only in the last call, and what beforeDelete removes (the booking page and
      // its bookings) doesn't come back: a mistyped password, or a session locked after too many, stops before it.
      await this.checkPassword(authKey, session);
      await this.beforeDelete();
    }
    // The key to take the booking page's handle back with an account made again here: the server keeps the handle
    // for it, not for whoever signs up next with this email (sign-ups don't prove the address).
    const handleKey = keys.b64u(crypto.randomBytes(32));
    const email = this.state.email;
    await this.call('DELETE', '/v1/account', { authKey: keys.b64u(authKey), handleKey }, { auth: true, session });
    if (this.session === session) {
      this.state.error = null;
      // Signed out even when the state can't be saved: the status goes out before that error does.
      try {
        this.forget();
        this.state.handleKey = { email, key: handleKey };
        this.saveState();
      } finally {
        this.changedStatus();
      }
    }
    return this.status();
  }

  // The handleKey this device kept when it deleted the account with this email, for the booking page's publish.
  handleKeyFor(email) {
    const k = this.state.handleKey;
    return k && email && k.email === keys.normalizeEmail(email) && typeof k.key === 'string' ? k.key : null;
  }

  dropHandleKey() {
    if (!this.state.handleKey) return;
    delete this.state.handleKey;
    this.saveState();
  }

  // Whether authKey is this account's password, without changing anything there. POST /v1/password/check asks on the
  // deleting session and counts a wrong password toward that session's lock, which DELETE /v1/account uses too, so
  // the deletion would answer the same: wrong_password or locked. A server from before that call answers 404. There a
  // sign-in of its own checks the password (that route answers a wrong one with 401) and its session ends at once;
  // such a server counts the deletion toward the same account lock as that sign-in.
  async checkPassword(authKey, session = this.session) {
    try {
      await this.call('POST', '/v1/password/check', { authKey: keys.b64u(authKey) }, { auth: true, session });
      return;
    } catch (err) {
      if (!err || err.status !== 404) throw err;
    }
    let res;
    try {
      res = await this.call('POST', '/v1/login', { email: this.state.email, authKey: keys.b64u(authKey), device: this.device() });
    } catch (err) {
      if (err && err.code === 'unauthorized') throw fail('wrong_password', 403);
      throw err;
    }
    if (res && typeof res.token === 'string') await this.call('POST', '/v1/logout', undefined, { auth: true, session: { token: res.token } }).catch(() => {});
  }

  // server: the address the session signed in at, where every call made with it goes (call()).
  open({ token, dataKey, server }) {
    this.session = { token, dataKey, server, keys: keys.recordKeys(dataKey) };
    this.ids.clear();
    for (const [key, e] of this.entries) {
      e.id = keys.recordId(this.session.keys.indexKey, e.c, e.k);
      this.ids.set(e.id, key);
    }
    clearInterval(this.timers.every);
    this.timers.every = setInterval(() => this.sync().catch(() => {}), SYNC_EVERY);
    if (this.timers.every.unref) this.timers.every.unref();
  }

  // This device joins the account it signed in to at the address at. Everything it has goes up; what the account has
  // comes down first, so an older value here doesn't overwrite a newer one there. When the server was changed while the sign-in
  // waited, the session is refused and ended there: its token would otherwise go to the new address. So is one when
  // another sign-in attached its session first: that session stays, with its address.
  //
  // from: the server this device used when the sign-in began; it differs from at only for signIn()'s try at a former
  // address, whose address becomes this device's server here (info: that server's info, fetched by the sign-in).
  attach(email, token, dataKey, at = this.server, { from = at, info = null } = {}) {
    if (from !== this.server || this.signedIn) {
      const code = this.signedIn ? 'signed_in' : 'server';
      this.http(at, 'POST', '/v1/logout', { token }).catch(() => {});
      throw fail(code);
    }
    const moved = at !== this.server;
    this.state = {
      ...this.state,
      ...(moved ? { server: at, info: info ? { server: at, data: info, at: this.now() } : null } : {}),
      email,
      sessionServer: at,
      token: this.secrets.encrypt(token),
      dataKey: this.secrets.encrypt(dataKey.toString('base64')),
      cursor: 0,
      lastSync: null,
      error: null
    };
    delete this.state.formerServer;
    delete this.state.formerEmail;
    const acct = bookingAcct(email);
    for (const e of this.entries.values()) {
      delete e.seq;
      // Another Rukoo account's booking page stays with that account: kept here, never sent to this one.
      if (PER_ACCOUNT.has(e.c) && acctOfKey(e.c, e.k) !== acct) {
        delete e.dirty;
        delete e.ifAbsent;
        continue;
      }
      e.dirty = true;
      // A first write, unless it is a deletion: that settles by its time, like any other.
      if (FIRST_WRITE_WINS.has(e.c) && !e.deleted) e.ifAbsent = e.first = true;
    }
    this.open({ token, dataKey, server: at });
    this.saveState();
    this.changedStatus();
    this.sync().catch(() => {});
  }

  forget() {
    this.session = null;
    clearInterval(this.timers.every);
    clearTimeout(this.timers.push);
    this.ids.clear();
    for (const [key, e] of this.entries) {
      // A booking page's private key leaves with the session; signing in again brings it back from the account.
      // Dropped here only, not deleted: a deletion would go up at the next sign-in.
      if (e.c === 'bookingkey') {
        this.entries.delete(key);
        continue;
      }
      delete e.id;
      delete e.seq;
      delete e.dirty;
      delete e.ifAbsent;
    }
    // A device pinned to a former default goes back to the default: signed out here, deleted, or ended elsewhere, as
    // when another device deleted the account to make it again at the default.
    // signIn() tries the former address once more, for an account still there (formerServer), first for the address
    // that was signed in there (formerEmail) when it carries an unlock code.
    const former = FORMER_SERVERS.includes(this.state.server);
    const { server, info, error, handleKey } = this.state;
    const kept = handleKey ? { handleKey } : {};
    const formerEmail = former ? this.state.email : this.state.formerEmail;
    const remembered = former ? { formerServer: server } : this.state.formerServer ? { formerServer: this.state.formerServer } : {};
    if (remembered.formerServer && formerEmail) remembered.formerEmail = formerEmail;
    this.state = former ? { server: null, info: null, error, ...remembered, ...kept } : { server, info, error, ...remembered, ...kept };
    this.saveState();
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

  // Where a record stands with the server: seq once the server has stored or sent this version, dirty while it still
  // has to go up. Null for a record this device doesn't have.
  recordState(c, k) {
    const e = this.entries.get(entryKey(c, k));
    if (!e || e.deleted) return null;
    return { seq: Number.isSafeInteger(e.seq) ? e.seq : null, dirty: Boolean(e.dirty) };
  }

  // The signed-in account's <acct>, or null.
  get acct() {
    return this.signedIn && this.state.email ? bookingAcct(this.state.email) : null;
  }

  // A call to the booking routes (server/PROTOCOL.md, Booking pages) with this session. Their errors carry the
  // server's details (the refused field, the booking as it is now).
  async bookingCall(method, route, body) {
    if (!this.signedIn) throw fail('signed_out');
    return this.call(method, route, body, { auth: true });
  }

  // Returns false when ifAbsent and the record already exists. An ifAbsent record is a first write: when another
  // device's first write reaches the server before it, that one stays, whatever the times say.
  put(c, k, v, { ifAbsent = false } = {}) {
    const key = entryKey(c, k);
    const was = this.entries.get(key);
    if (ifAbsent && was && !was.deleted) return false;
    const e = { c, k, v, t: Math.max(this.now(), was ? was.t + 1 : 0), dirty: true };
    // A first write, unless it takes the place of a deletion this device knows of: the server keeps that deletion as
    // a record, so a first write would bounce off it. This one settles by its time instead.
    if (ifAbsent && !(was && was.deleted)) e.ifAbsent = e.first = true;
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

  // Everything this device keeps, readable: what "Export my data" saves. Not a booking page's key pair: its private
  // key opens guests' details, and an export is a file anyone may come across. Booking records only of the account
  // signed in now: another Rukoo account's (someone else on a shared computer) hold its guests' names and notes.
  exportData() {
    const acct = this.acct;
    const records = [...this.entries.values()]
      .filter((e) => !e.deleted && e.c !== 'bookingkey' && (!PER_ACCOUNT.has(e.c) || (acct && acctOfKey(e.c, e.k) === acct)))
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
        else this.saveEntries(true);
        this.changedStatus();
      }
      return this.status();
    })();
    this.syncing = { session, promise };
    return promise;
  }

  async pull(session = this.session) {
    const touched = new Set();
    // The cursor moves past each page as it is taken, so a later page that fails doesn't bring this one back: what it
    // changed is announced either way.
    try {
      await this.pullPages(session, touched);
    } finally {
      if (touched.size) this.changedRecords([...touched]);
    }
  }

  async pullPages(session, touched) {
    let restarted = false;
    let pages = 0;
    const meter = { bytes: 0 };
    for (;;) {
      if (!session || this.session !== session) return;
      // A server that keeps answering more can't keep this device busy: what is left comes with the next sync. Every
      // byte of an answer counts, so padding a page with fields Rukoo ignores doesn't get past the limit.
      if (pages >= PULL_PAGES || meter.bytes >= PULL_DATA) return;
      pages += 1;
      const since = Number(this.state.cursor) || 0;
      const res = await this.call('GET', `/v1/records?since=${since}&limit=${PULL_LIMIT}`, undefined, { auth: true, session, meter });
      if (this.session !== session) return;
      const records = Array.isArray(res && res.records) ? res.records : [];
      const top = Number(res && res.seq);
      // The server's newest change is older than where this device got to: it lost data, or an earlier answer was
      // false. Start again from the beginning, once; records already here are taken again without harm.
      if (Number.isSafeInteger(top) && top < since) {
        if (restarted) throw fail('server');
        restarted = true;
        this.state.cursor = 0;
        continue;
      }
      // A page comes after since, in order, and not past the server's newest change; anything else is refused whole,
      // so a false sequence number can't move the cursor past records this device hasn't seen. So is a page with an id
      // no device could have made, such as a long tombstone id padding the answer.
      if (records.length > PULL_LIMIT) throw fail('server');
      let last = since;
      for (const r of records) {
        const seq = Number(r && r.seq);
        if (!Number.isSafeInteger(seq) || seq <= last || (Number.isSafeInteger(top) && seq > top)) throw fail('server');
        if (typeof r.id !== 'string' || !RECORD_ID.test(r.id)) throw fail('server');
        last = seq;
      }
      for (const r of records) {
        const c = this.applyRemote(r);
        if (c) touched.add(c);
        if (Number(r.seq) > this.state.cursor) this.state.cursor = Number(r.seq);
      }
      if (!res || !res.more || !records.length) break;
    }
  }

  // Takes one record from the server; returns its collection when this device's data changed.
  applyRemote({ id, seq, data }) {
    // A tombstone (data null) proves nothing about who wrote it, so a server could use one to erase records here.
    // Devices delete with sealed d: true records, which do prove it; tombstones are left alone.
    if (data === null || data === undefined) return null;
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
      const dirty = [...this.entries.values()].filter((e) => e.dirty).slice(0, PUSH_BATCH);
      if (!dirty.length) return refused;
      // A record too large for the server stays on this device: sent along, it would fail the whole batch every time.
      const batch = [];
      const records = [];
      for (const e of dirty) {
        const out = keys.sealRecord(session.keys, e.deleted ? { ...e, v: null, d: true } : e);
        if (Buffer.byteLength(out.data, 'base64url') > RECORD_BYTES) {
          delete e.dirty;
          delete e.ifAbsent;
          e.tooLarge = true;
          continue;
        }
        if (e.ifAbsent && !e.deleted) out.ifAbsent = true;
        batch.push(e);
        records.push(out);
      }
      if (!records.length) {
        this.saveEntries();
        continue;
      }
      const res = await this.call('POST', '/v1/records', { records }, { auth: true, session });
      if (this.session !== session) return refused;
      const results = new Map((Array.isArray(res && res.results) ? res.results : []).map((r) => [r && r.id, r]));
      // A server that leaves a record out of its answer would get it again, forever.
      if (batch.some((e) => !results.has(e.id))) throw fail('server');
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

  // The records go first: a cursor on disk past records that aren't would have them skipped for good after a restart.
  saveState() {
    this.saveEntries(true);
    // When the records couldn't be written (a full disk), the cursor on disk stays where they last were.
    const state = this.state.cursor === undefined ? this.state : { ...this.state, cursor: Math.min(Number(this.state.cursor) || 0, this.durableCursor) };
    writeJson(this.file('account.json'), state);
  }

  // Now (false when that failed), or a second after the last change.
  saveEntries(now = false) {
    clearTimeout(this.timers.save);
    this.timers.save = null;
    if (now) return this.writeEntries();
    this.timers.save = setTimeout(() => this.writeEntries(), SAVE_AFTER);
    if (this.timers.save.unref) this.timers.save.unref();
    return true;
  }

  // False when the disk refused the records; they are tried again a little later then.
  writeEntries() {
    this.timers.save = null;
    const cursor = Number(this.state.cursor) || 0;
    try {
      writeJson(this.file('account-records.json'), { entries: [...this.entries.values()] });
      this.durableCursor = cursor;
      return true;
    } catch (_) {
      this.timers.save = setTimeout(() => this.writeEntries(), SAVE_RETRY);
      if (this.timers.save.unref) this.timers.save.unref();
      return false;
    }
  }

  // Writes the records that wait for their save now; false when they couldn't be written.
  flush() {
    return this.timers.save ? this.saveEntries(true) : true;
  }

  // Writes what waits and stops the timers, for quitting.
  close() {
    clearInterval(this.timers.every);
    clearTimeout(this.timers.push);
    this.flush();
  }

  changedStatus() {
    this.emit('status', this.status());
  }

  changedRecords(collections) {
    this.emit('records', { collections });
  }
}

module.exports = { AccountService, MIN_PASSWORD, PULL_PAGES, PULL_DATA, bookingAcct, codesFor };
