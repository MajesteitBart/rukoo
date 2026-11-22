'use strict';

// A Rukoo account in a browser page: the part of src/main/account/index.js that team chat needs, on fetch, Web Crypto
// and localStorage. Two kinds of caller:
//
// - The team chat engine (src/main/workspaces, bundled for the page) uses status(), sessionTag, serverInfo(),
//   workspaceCall() and the 'status' and 'info' events exactly as on desktop.
// - The bridge (src/web/bridge.js) serves the renderer's account calls with the account* methods, which take and
//   return what main.js's IPC handlers do. Invitation links are the bridge's: it splits a link out of the invite
//   field and remembers the join, as main.js does.
//
// Errors are AccountError (client.js) with the code as their message: the bridge words them, as main.js does with
// t(`account.errors.${code}`). status().errorText is worded only when a t() was given.
//
// The session is kept in localStorage under rukoo.web.session as { v: 1, server, email, token, at }. The password
// and the data key are never kept: a sign-in opens the data key once, to check what the server sent, and drops it.
//
// Not here, compared with desktop:
// - records and their sync, and so the sync line, pending count and record counts in status() (always empty);
// - export, and a server of one's choice: the page talks to the one server it was given;
// - changing the password and a new recovery key: both need the data key;
// - the former default server (https://rukoo-account.bvdm.ai): another origin, which the page may not call, so an
//   account made there can't sign in here;
// - the handleKey a deletion leaves on desktop, for taking the booking page's handle back with a new account: a page
//   has no booking page to publish, so a deletion here sends none and the handle stays reserved for nobody;
// - the booking service's step before a deletion: the server wipes the booking page with the account.
const { AccountError, serverUrl, createRequest } = require('./client');
const keysModule = require('./crypto');

const { normalizeEmail, checkKdf, unb64u, b64u, formatRecoveryKey, parseRecoveryKey, DEFAULT_KDF, createKeys } = keysModule;

const PROTOCOL = 1;
// The workspace protocol versions this Rukoo speaks, as src/main/account/index.js WORKSPACE_VERSIONS: the page runs the
// desktop's own chat engine, so it reads what desktop reads.
const WORKSPACE_VERSIONS = [1, 2];
const MIN_PASSWORD = 12;
const SESSION_KEY = 'rukoo.web.session';
const PLATFORM = 'web';
// A token as an Authorization header can carry it. The server's are name.<43 base64url characters>.
const TOKEN = /^[\x21-\x7e]{1,1000}$/;
const ERRORS = new Set([
  'invalid', 'unauthorized', 'locked', 'rate_limited', 'exists', 'signups_closed', 'invite_required', 'quota', 'too_large',
  'not_configured', 'network', 'server', 'invalid_email', 'weak_password', 'recovery_key', 'weak_kdf', 'no_server', 'protocol',
  'signed_in', 'signed_out', 'wrong_password',
  // Codes sent by email, as on desktop (src/main/account/index.js ERRORS).
  'code_required', 'code_wrong', 'code_expired', 'code_in_use', 'mail_unavailable', 'code_format',
  // The page's own: another tab changed the account while a sign-out or delete dialog was open (src/web/host.js).
  'account_changed',
  // The booking routes (server/PROTOCOL.md, Owner errors), kept so the codes read the same as on desktop.
  'handle_taken', 'handle_reserved', 'handle_lost', 'handle_changes', 'has_bookings', 'other_device', 'not_found', 'slot_taken',
  'stale_version', 'not_active'
]);

// What a code is for, and the shape of a challenge and of the email's long code (32 random bytes in base64url).
const CODE_PURPOSES = ['signup', 'unlock'];
const CODE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Codes asked for are kept by purpose and address, a few at most (desktop's codeKey).
const codeKey = (purpose, address) => `${purpose}
${address}`;
const MAX_HELD_CODES = 8;

// Whether the server mails codes for purpose (desktop's codesFor, src/main/account/index.js).
const codesFor = (info, purpose) =>
  Boolean(
    info &&
      Array.isArray(info.features) &&
      info.features.includes('email-codes') &&
      info.emailCodes &&
      Array.isArray(info.emailCodes.purposes) &&
      info.emailCodes.purposes.includes(purpose)
  );

// An error with a code for the bridge to word. Server codes Rukoo doesn't know read as 'server'.
function fail(code, status = 0, details = null) {
  const known = ERRORS.has(code) ? code : 'server';
  return new AccountError(known, status, known, details);
}

const translated = (err) => (err instanceof AccountError ? fail(err.code, err.status, err.details) : err);
const validEmail = (email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 320;
// What main.js's IPC handlers make of the renderer's arguments.
const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const accountText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// What the account's device list calls this browser, from its user agent, such as "Firefox · Windows". A page can't
// learn the computer's name, which desktop uses.
function browserDevice(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /(Firefox|FxiOS)\//.test(ua)
        ? 'Firefox'
        : /(Chrome|CriOS|Chromium)\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const system = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'macOS'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return system ? `${browser} · ${system}` : browser;
}

// localStorage that may be missing, refuse writes (a private window, a full quota) or throw on every access (blocked
// site data). What it refuses is kept in memory instead, so a sign-in still lasts while the page is open.
function sessionStore(storage) {
  const memory = new Map();
  return {
    get(key) {
      if (memory.has(key)) return memory.get(key);
      try {
        return storage ? storage.getItem(key) : null;
      } catch (_) {
        return null;
      }
    },
    set(key, value) {
      try {
        if (!storage) throw new Error('no storage');
        storage.setItem(key, value);
        memory.delete(key);
      } catch (_) {
        memory.set(key, value);
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        if (storage) storage.removeItem(key);
      } catch (_) {
        // Storage that throws here threw at set() too, so nothing of this session was written to it.
      }
    }
  };
}

// The few EventEmitter methods the engine and the bridge use, without Node's events module.
class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
    return this;
  }

  addListener(name, fn) {
    return this.on(name, fn);
  }

  once(name, fn) {
    const wrapped = (...args) => {
      this.removeListener(name, wrapped);
      fn.apply(this, args);
    };
    wrapped.listener = fn;
    return this.on(name, wrapped);
  }

  // The most recently added copy, as Node's removeListener does.
  removeListener(name, fn) {
    const list = this.listeners.get(name);
    if (!list) return this;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === fn || list[i].listener === fn) {
        list.splice(i, 1);
        break;
      }
    }
    return this;
  }

  off(name, fn) {
    return this.removeListener(name, fn);
  }

  listenerCount(name) {
    return (this.listeners.get(name) || []).length;
  }

  emit(name, ...args) {
    const list = [...(this.listeners.get(name) || [])];
    for (const fn of list) fn.apply(this, args);
    return list.length > 0;
  }
}

class WebAccountService extends Emitter {
  constructor({ server, fetch, storage, subtle, argon2, now = Date.now, t = null, language = null, deviceName, userAgent, randomBytes, timeout }) {
    super();
    this.address = serverUrl(server) || '';
    this.http = createRequest({ fetch, now, timeout });
    this.keys = createKeys({ argon2id: argon2, subtle, randomBytes });
    this.store = sessionStore(storage);
    this.now = now;
    this.t = typeof t === 'function' ? t : null;
    // The page's language, for the email a code comes in.
    this.language = typeof language === 'function' ? language : () => 'en';
    // The last code asked for, by purpose and address, as on desktop: { server, challenge, until, seq }, in this
    // page's memory only. A reload drops it; the long code in the email still works then. seq counts the requests, so
    // an older one answered late can't replace a newer one's challenge.
    this.codes = new Map();
    this.codeSeq = 0;
    const ua = userAgent !== undefined ? userAgent : globalThis.navigator && globalThis.navigator.userAgent;
    this.deviceName = String(deviceName || browserDevice(ua)).slice(0, 100);
    this.platform = PLATFORM;
    this.state = { email: null, error: null };
    this.session = null;
    // The session the last 401 ended (call()).
    this.revoked = null;
    this.info = null;
    this.initializing = null;
    // GET /v1/info started by init(), for whoever wants to wait for it.
    this.infoLoad = null;
  }

  get server() {
    return this.address;
  }

  get signedIn() {
    return Boolean(this.session);
  }

  // desktop's shape (src/main/account/index.js status()). A page keeps no records, so nothing is pending or synced.
  status() {
    const error = this.state.error || null;
    return {
      server: this.server,
      defaultServer: this.server,
      signedIn: this.signedIn,
      email: this.signedIn ? this.state.email : null,
      lastSync: null,
      syncing: false,
      error,
      errorText: error && this.t ? this.t(`account.errors.${ERRORS.has(error) ? error : 'server'}`) : null,
      info: this.info && this.info.server === this.server ? this.info.data : null,
      pending: 0,
      counts: {}
    };
  }

  changedStatus() {
    this.emit('status', this.status());
  }

  // Says with the 'ended' event that this page's own sign-out or deletion (by: 'sign-out' or 'delete') ended session, so
  // the bridge can tell that end from any other (src/web/host.js). Once the server has taken the request, the token is
  // dead, so a 401 that another call got before this request's answer came was this request's doing: its signed_out
  // error, which says the session ended elsewhere, goes again.
  endedHere(session, by) {
    if (!this.session && this.state.error === 'signed_out' && this.revoked === session) {
      this.state.error = null;
      this.changedStatus();
    }
    this.emit('ended', { tag: session.tag, by });
  }

  // ---- the stored session ----

  // The stored session for this server, or null. One stored for another server (the page's rukoo-server meta changed)
  // is left alone: it belongs to that address, and the next sign-in here replaces it.
  readSession() {
    let saved;
    try {
      saved = JSON.parse(this.store.get(SESSION_KEY) || 'null');
    } catch (_) {
      return null;
    }
    if (!saved || typeof saved !== 'object' || saved.v !== 1) return null;
    if (saved.server !== this.server || !this.server) return null;
    if (typeof saved.email !== 'string' || !validEmail(saved.email)) return null;
    if (typeof saved.token !== 'string' || !TOKEN.test(saved.token)) return null;
    return { server: saved.server, email: saved.email, token: saved.token, at: Number(saved.at) || 0 };
  }

  // Reads the stored session, starts GET /v1/info and says the status. Every account* call waits for it; the bridge
  // calls it before the engine starts, so the engine's first look already sees a stored session.
  init() {
    if (!this.initializing) this.initializing = this.restore();
    return this.initializing;
  }

  async restore() {
    const saved = this.readSession();
    if (saved) {
      const tag = await this.keys.sessionTag(saved.token);
      // A sign-in that finished meanwhile is newer than what was stored.
      if (!this.session) {
        this.session = { token: saved.token, server: saved.server, tag };
        this.state = { email: saved.email, error: null };
      }
    }
    this.changedStatus();
    // Chat's availability reads the server's info, also before anyone signs in; status() and the 'info' event have it
    // once it answers. Unreachable, it stays null, as a desktop that never reached the server has it.
    this.infoLoad = this.server ? this.serverInfo().catch(() => null) : Promise.resolve(null);
    return this;
  }

  // Another tab changed the stored session (the page's 'storage' event): its sign-in, sign-out or ended session holds
  // here too, without asking the server.
  async storageChanged() {
    await this.init();
    const saved = this.readSession();
    if (this.session ? saved && saved.token === this.session.token : !saved) return;
    const tag = saved ? await this.keys.sessionTag(saved.token) : null;
    const now = this.readSession();
    // Changed again while the tag was made: the event of that change follows.
    if ((now && now.token) !== (saved && saved.token)) return;
    if (this.session && saved && saved.token === this.session.token) return;
    this.session = saved ? { token: saved.token, server: saved.server, tag } : null;
    this.state = { email: saved ? saved.email : null, error: null };
    this.changedStatus();
  }

  // Ends session here, and in storage when it is still the one stored: another tab may have signed in since.
  forget(session = this.session) {
    if (session && this.session === session) this.session = null;
    const saved = this.readSession();
    if (session && saved && saved.token === session.token) this.store.remove(SESSION_KEY);
  }

  // ---- talking to the server ----

  // As desktop's call(): session is the one a signed-in call is made for, and its answer may come after this page
  // signed out or into another account, when a 401 says nothing about the session there is now. raw: the server's own
  // error comes back with its code and details instead of one of ERRORS; a 401 still ends the session.
  async call(method, route, body, { auth = false, server, session = this.session, raw = false, headers, keepalive = false } = {}) {
    const to = server || (auth && session && session.server) || this.server;
    if (!to) throw fail('no_server');
    try {
      return await this.http(to, method, route, { body, token: auth ? session && session.token : undefined, headers, keepalive });
    } catch (err) {
      // The session ended elsewhere: this browser was removed from the devices, or the password changed elsewhere.
      if (auth && err instanceof AccountError && err.status === 401) {
        if (session && this.session === session) {
          this.state.error = 'signed_out';
          // Which session the error is about, for this page's own sign-out or deletion that caused it (endedHere).
          this.revoked = session;
          this.forget(session);
          this.changedStatus();
        }
        throw fail('signed_out', 401);
      }
      throw raw ? err : translated(err);
    }
  }

  // The workspace routes (server/WORKSPACES.md) with this session, in the newest version of their protocol both this
  // page and the server speak (workspaceVersion). The server's own error code and details survive, because the team
  // chat engine acts on them. A 401 ends the session. keepalive (web only): for a request the page sends as it goes away
  // (src/web/host.js releaseStaged).
  async workspaceCall(method, route, body, { session = this.session, keepalive = false } = {}) {
    if (!this.signedIn || !session) throw fail('signed_out');
    const headers = { 'rukoo-workspace-version': String(this.workspaceVersion(session.server)) };
    return this.call(method, route, body, { auth: true, session, raw: true, headers, keepalive });
  }

  // The highest workspace protocol version this page and the server's GET /v1/info both list, else 1 (desktop's
  // workspaceVersion). Asked in version 1, the server gives a message with files and no text its file names as text
  // ("📎 plan.png"), which the page would show above the files themselves.
  workspaceVersion(server) {
    const info = this.info && this.info.server === server ? this.info.data : null;
    const theirs = info && info.workspace && Array.isArray(info.workspace.versions) ? info.workspace.versions : [];
    return Math.max(1, ...WORKSPACE_VERSIONS.filter((v) => theirs.includes(v)));
  }

  // The first 22 characters of base64url SHA-256 of the session's token, made when the session starts (Web Crypto has
  // no synchronous hash). null while signed out.
  get sessionTag() {
    return this.session ? this.session.tag : null;
  }

  // Who runs the server and where it keeps data. The server's is kept in memory, and 'info' tells the engine.
  async serverInfo(url = this.server) {
    const server = serverUrl(url);
    if (!server) throw fail('no_server');
    const data = await this.call('GET', '/v1/info', undefined, { server });
    if (!data || data.protocol !== PROTOCOL) throw fail('protocol');
    if (server === this.server) {
      this.info = { server, data, at: this.now() };
      this.emit('info', data);
    }
    return data;
  }

  device() {
    return { name: this.deviceName, platform: this.platform };
  }

  // ---- signing up, in and out ----

  checkNew(email, password) {
    if (this.signedIn) throw fail('signed_in');
    if (!validEmail(email)) throw fail('invalid_email');
    if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) throw fail('weak_password');
  }

  // ---- codes by email (desktop's requestCode, emailCodeFor and settleCode) ----

  // POST /v1/email-code for purpose, 'signup' or 'unlock'. The challenge stays in this page's memory; the renderer
  // gets the address and how long the six digits work.
  async requestCode({ email, purpose }) {
    const address = normalizeEmail(email);
    if (this.signedIn) throw fail('signed_in');
    if (!validEmail(address)) throw fail('invalid_email');
    if (!CODE_PURPOSES.includes(purpose)) throw fail('invalid');
    const at = this.server;
    if (!at) throw fail('no_server');
    const seq = ++this.codeSeq;
    const lang = this.language() === 'nl' ? 'nl' : 'en';
    const res = await this.call('POST', '/v1/email-code', { email: address, purpose, lang });
    const challenge = res && typeof res.challenge === 'string' && CODE_TOKEN.test(res.challenge) ? res.challenge : null;
    if (!challenge) throw fail('server');
    const expiresIn = Number.isSafeInteger(res.expiresIn) && res.expiresIn > 0 ? Math.min(res.expiresIn, 3600) : 600;
    const key = codeKey(purpose, address);
    const newer = this.codes.get(key);
    if (newer && newer.seq > seq) return { email: address, expiresIn };
    this.codes.delete(key);
    this.codes.set(key, { server: at, challenge, until: this.now() + expiresIn * 1000, seq });
    while (this.codes.size > MAX_HELD_CODES) this.codes.delete(this.codes.keys().next().value);
    return { email: address, expiresIn };
  }

  // emailCode for a request, from what was typed: null, { token } for the long code, or { challenge, code } for six
  // digits with this page's challenge for the same address, purpose and server; code_expired without one.
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

  // After a request that carried emailCode: a used code, or six digits that no longer work, leave nothing to keep.
  settleCode(purpose, address, emailCode, err = null) {
    if (!emailCode) return;
    const key = codeKey(purpose, address);
    if (!err) {
      this.codes.delete(key);
      return;
    }
    const held = this.codes.get(key);
    if (!held || held.challenge !== emailCode.challenge) return;
    const last = err.code === 'code_wrong' && err.details && err.details.attemptsLeft === 0;
    if (err.code === 'code_expired' || last) this.codes.delete(key);
  }

  // workspaceInvite: { workspace, invite } from a team chat invitation link, which a server that takes accounts by
  // invite code accepts in place of one (contract 2.12). Sent instead of invite. The account is made first; only
  // then does the recovery key come back to be shown, as on desktop. emailCode: what was typed of a signup code; a
  // server that checks addresses needs one without the operator's invite code, also with workspaceInvite, so this
  // stops with code_required before the password's keys are made. There, an invite code that has been used up gets
  // invite_required, and the server doesn't look at the emailed code beside it: the sign-up goes once more without
  // the invite code. Without an emailed code, that answer reads as code_required (desktop's signUp).
  async signUp({ email, password, invite, workspaceInvite, emailCode: typed }) {
    const address = normalizeEmail(email);
    this.checkNew(address, password);
    const linked =
      workspaceInvite && typeof workspaceInvite === 'object' && typeof workspaceInvite.workspace === 'string' && typeof workspaceInvite.invite === 'string'
        ? { workspace: workspaceInvite.workspace.slice(0, 100), invite: workspaceInvite.invite.slice(0, 100) }
        : null;
    const plain = !linked && invite ? String(invite).trim() : '';
    const at = this.server;
    if (!at) throw fail('no_server');
    const info = await this.serverInfo(at);
    // With an invite code, a typed code that can't be sent doesn't stop the sign-up; its error comes back only when the
    // server still asks for a code (desktop's signUp).
    let emailCode = null;
    let unusable = null;
    try {
      emailCode = this.emailCodeFor('signup', address, at, typed);
    } catch (err) {
      if (!plain) throw err;
      unusable = err;
    }
    const codes = codesFor(info, 'signup');
    if (!emailCode && !plain && codes) throw fail('code_required', 403);
    const k = this.keys;
    const salt = k.randomBytes(16);
    const kdf = { ...DEFAULT_KDF };
    const dataKey = k.randomBytes(32);
    const recoveryKey = k.randomBytes(20);
    const { authKey, wrapKey } = await k.passwordKeys(password, salt, kdf, at);
    const { recoveryAuth, recoveryWrap } = await k.recoveryKeys(recoveryKey, at);
    let body;
    try {
      body = {
        email: address,
        ...(linked ? { workspaceInvite: linked } : plain ? { invite: plain } : {}),
        ...(emailCode ? { emailCode } : {}),
        kdf,
        salt: b64u(salt),
        authKey: b64u(authKey),
        wrappedKey: b64u(await k.wrapDataKey(wrapKey, dataKey)),
        recoveryAuth: b64u(recoveryAuth),
        recoveryWrappedKey: b64u(await k.wrapDataKey(recoveryWrap, dataKey)),
        device: this.device()
      };
    } finally {
      for (const key of [dataKey, authKey, wrapKey, recoveryAuth, recoveryWrap]) key.fill(0);
    }
    // The operator's invite code didn't work on a server that checks addresses: used up (invite_required) or wrong
    // (code_required).
    const inviteFailed = (err) => Boolean(codes && plain && err && (err.code === 'invite_required' || err.code === 'code_required'));
    let res;
    try {
      try {
        res = await this.call('POST', '/v1/signup', body);
      } catch (err) {
        if (!emailCode || err.code !== 'invite_required' || !inviteFailed(err)) throw err;
        const without = { ...body };
        delete without.invite;
        res = await this.call('POST', '/v1/signup', without);
      }
    } catch (err) {
      this.settleCode('signup', address, emailCode, err);
      if (!inviteFailed(err)) throw unusable && err && err.code === 'code_required' ? unusable : err;
      throw unusable || (err.code === 'code_required' ? err : fail('code_required', 403));
    }
    this.settleCode('signup', address, emailCode);
    await this.attach(address, res && res.token, at);
    const text = formatRecoveryKey(recoveryKey);
    recoveryKey.fill(0);
    return { recoveryKey: text, account: res.account };
  }

  // authKey and wrapKey for the password, with the parameters the server keeps for the address. Refuses weak ones.
  async authFor(email, password, at = this.server) {
    const pre = await this.call('POST', '/v1/prelogin', { email });
    let kdf;
    try {
      kdf = checkKdf(pre && pre.kdf);
    } catch (_) {
      throw fail('weak_kdf');
    }
    let salt;
    try {
      salt = unb64u(pre.salt, 16);
    } catch (_) {
      throw fail('server');
    }
    return this.keys.passwordKeys(password, salt, kdf, at);
  }

  // emailCode: what was typed of an unlock code, which lets the sign-in past the account's lock.
  async signIn({ email, password, emailCode: typed }) {
    const address = normalizeEmail(email);
    if (this.signedIn) throw fail('signed_in');
    if (!validEmail(address)) throw fail('invalid_email');
    if (typeof password !== 'string' || !password) throw fail('unauthorized');
    const at = this.server;
    if (!at) throw fail('no_server');
    const emailCode = this.emailCodeFor('unlock', address, at, typed);
    await this.serverInfo(at);
    const { authKey, wrapKey } = await this.authFor(address, password, at);
    let res;
    try {
      try {
        res = await this.call('POST', '/v1/login', { email: address, authKey: b64u(authKey), device: this.device(), ...(emailCode ? { emailCode } : {}) });
      } catch (err) {
        this.settleCode('unlock', address, emailCode, err);
        throw err;
      }
      this.settleCode('unlock', address, emailCode);
      // The data key isn't kept, but it has to open: a wrappedKey that doesn't is a server that can't be trusted with
      // the session either.
      try {
        const dataKey = await this.keys.unwrapDataKey(wrapKey, unb64u(res && res.wrappedKey));
        dataKey.fill(0);
      } catch (_) {
        this.endToken(at, res && res.token);
        throw fail('server');
      }
    } finally {
      authKey.fill(0);
      wrapKey.fill(0);
    }
    await this.attach(address, res.token, at);
    return { account: res.account };
  }

  // A forgotten password: the recovery key opens the data key, and a new password takes over. emailCode: what was
  // typed of an unlock code; it goes with both steps, as recover/start leaves it for recover/finish.
  async recover({ email, recoveryKey, password, emailCode: typed }) {
    const address = normalizeEmail(email);
    this.checkNew(address, password);
    const key = parseRecoveryKey(recoveryKey);
    if (!key) throw fail('recovery_key');
    const at = this.server;
    if (!at) throw fail('no_server');
    const emailCode = this.emailCodeFor('unlock', address, at, typed);
    const code = emailCode ? { emailCode } : {};
    await this.serverInfo(at);
    const k = this.keys;
    const { recoveryAuth, recoveryWrap } = await k.recoveryKeys(key, at);
    key.fill(0);
    let start;
    try {
      start = await this.call('POST', '/v1/recover/start', { email: address, recoveryAuth: b64u(recoveryAuth), ...code });
    } catch (err) {
      this.settleCode('unlock', address, emailCode, err);
      throw err;
    }
    let dataKey;
    try {
      dataKey = await k.unwrapDataKey(recoveryWrap, unb64u(start && start.recoveryWrappedKey));
    } catch (_) {
      throw fail('server');
    } finally {
      recoveryWrap.fill(0);
    }
    const salt = k.randomBytes(16);
    const kdf = { ...DEFAULT_KDF };
    let body;
    try {
      const { authKey, wrapKey } = await k.passwordKeys(password, salt, kdf, at);
      body = {
        email: address,
        recoveryAuth: b64u(recoveryAuth),
        kdf,
        salt: b64u(salt),
        authKey: b64u(authKey),
        wrappedKey: b64u(await k.wrapDataKey(wrapKey, dataKey)),
        device: this.device(),
        ...code
      };
      wrapKey.fill(0);
    } finally {
      dataKey.fill(0);
    }
    let res;
    try {
      res = await this.call('POST', '/v1/recover/finish', body);
    } catch (err) {
      this.settleCode('unlock', address, emailCode, err);
      throw err;
    }
    this.settleCode('unlock', address, emailCode);
    await this.attach(address, res && res.token, at);
    return { account: res.account };
  }

  // Only the session this was asked for: a slow answer must not sign out one made meanwhile.
  async signOut() {
    if (!this.signedIn) return this.status();
    const session = this.session;
    // Signed out here whatever the server says: offline, the session ends here and stays on the server's list.
    let taken = false;
    await this.call('POST', '/v1/logout', undefined, { auth: true, session }).then(
      () => (taken = true),
      () => {}
    );
    // Still this session: the sign-out ends it. Otherwise something ended it while the request was out: the server's
    // yes says that was this sign-out (endedHere); a 401 from the logout, or another tab, ended it before.
    if (this.session === session) {
      this.state.error = null;
      this.forget(session);
      this.changedStatus();
      this.endedHere(session, 'sign-out');
    } else if (taken) this.endedHere(session, 'sign-out');
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

  // Deletes the account and everything in it on the server. The server checks the password in this one call.
  async deleteAccount(password) {
    if (!this.signedIn) throw fail('signed_out');
    // hash-wasm refuses an empty password with an error of its own; the server would refuse it as this.
    if (typeof password !== 'string' || !password) throw fail('wrong_password', 403);
    const session = this.session;
    const { authKey, wrapKey } = await this.authFor(this.state.email, password);
    wrapKey.fill(0);
    try {
      await this.call('DELETE', '/v1/account', { authKey: b64u(authKey) }, { auth: true, session });
    } finally {
      authKey.fill(0);
    }
    // The account is gone, and with it the session, also when a 401 that the deletion caused ended it here first.
    if (this.session === session) {
      this.state.error = null;
      this.forget(session);
      this.changedStatus();
    }
    this.endedHere(session, 'delete');
    return this.status();
  }

  // A session the server made that this page won't use: ended there at once, as far as the server can be reached.
  endToken(at, token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return;
    this.http(at, 'POST', '/v1/logout', { token }).catch(() => {});
  }

  // The page signs in to the account at the address at. A sign-in that another one beat keeps that one: its own
  // session is ended at the server.
  async attach(email, token, at) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw fail('server');
    const tag = await this.keys.sessionTag(token);
    if (this.signedIn || at !== this.server) {
      const code = this.signedIn ? 'signed_in' : 'server';
      this.endToken(at, token);
      throw fail(code);
    }
    this.session = { token, server: at, tag };
    this.state = { email, error: null };
    this.store.set(SESSION_KEY, JSON.stringify({ v: 1, server: at, email, token, at: this.now() }));
    this.changedStatus();
  }

  // ---- the renderer's calls (main.js's IPC handlers) ----

  async accountStatus() {
    await this.init();
    return this.status();
  }

  async accountServerInfo() {
    await this.init();
    return this.serverInfo();
  }

  // invite: what is left of the invite field once the bridge took a team chat invitation link out of it
  // (manage.splitInvite), and workspaceInvite what that link gave.
  async accountSignUp(input) {
    await this.init();
    const i = plainObject(input);
    const w = plainObject(i.workspaceInvite);
    return this.signUp({
      email: accountText(i.email, 320),
      password: accountText(i.password, 1000),
      invite: accountText(i.invite, 200),
      workspaceInvite: typeof w.workspace === 'string' && typeof w.invite === 'string' ? { workspace: w.workspace, invite: w.invite } : undefined,
      emailCode: accountText(i.emailCode, 200)
    });
  }

  // A code by email (main.js accountEmailCode): { email, purpose } with purpose 'signup' or 'unlock'.
  async accountEmailCode(input) {
    await this.init();
    const i = plainObject(input);
    return this.requestCode({ email: accountText(i.email, 320), purpose: accountText(i.purpose, 20) });
  }

  async accountSignIn(input) {
    await this.init();
    const i = plainObject(input);
    return this.signIn({ email: accountText(i.email, 320), password: accountText(i.password, 1000), emailCode: accountText(i.emailCode, 200) });
  }

  async accountRecover(input) {
    await this.init();
    const i = plainObject(input);
    return this.recover({
      email: accountText(i.email, 320),
      recoveryKey: accountText(i.recoveryKey, 200),
      password: accountText(i.password, 1000),
      emailCode: accountText(i.emailCode, 200)
    });
  }

  async accountSignOut() {
    await this.init();
    return this.signOut();
  }

  async accountDetails() {
    await this.init();
    return this.details();
  }

  async accountRemoveDevice(id) {
    await this.init();
    return this.removeDevice(accountText(id, 200));
  }

  async accountDelete(password) {
    await this.init();
    return this.deleteAccount(accountText(password, 1000));
  }
}

// server: the account server's address as the page uses it (the bridge reads it from <meta name="rukoo-server"> or
// location.origin); password proofs include it. fetch, storage (localStorage), subtle (crypto.subtle) and argon2
// (argon2.js argon2id, or hash-wasm's in Node) are what the account runs on. Optional: now, t (words
// status().errorText), deviceName or userAgent, randomBytes, and timeout (ms, for tests).
function createAccountService(deps = {}) {
  return new WebAccountService(deps);
}

module.exports = { createAccountService, WebAccountService, AccountError, SESSION_KEY, browserDevice, ERRORS, WORKSPACE_VERSIONS, codesFor };
