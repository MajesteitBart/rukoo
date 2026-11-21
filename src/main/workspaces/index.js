'use strict';

// Team chat in the main process: the WorkspaceService (team chat contract 4.3). It follows the Rukoo account's
// session, keeps the chat cache (store.js) for exactly as long as that session lasts, lists the person's workspaces,
// runs the feed engine (sync.js) for each, keeps their wake sockets (socket.js) and timers, and tells the main window
// what changed through 'event' payloads that main.js sends as 'chat' (contract 4.5).
//
// The renderer never reaches the network or the cache: it calls the chat* IPC methods (ipc.js). The core answers
// chatState, chatSelect, chatView, chatSync and chatReload; the modules history.js, outbox.js, manage.js and notify.js
// answer the rest and hook into the runs (contract 4.3).
//
// Every async job captures this.epoch, which moves on whenever a session ends or begins. An answer for an older epoch
// is dropped before it touches the store (guard()), so a slow answer can't write into the next session's cache.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { openStore } = require('./store');
const wire = require('./wire');
const sync = require('./sync');
const { WakeSocket } = require('./socket');
const { History } = require('./history');
const { Outbox } = require('./outbox');
const { Manage } = require('./manage');
const { Notifier } = require('./notify');
const { Files } = require('./files');

const { ChatError, chatError } = wire;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// The shared numbers of contract 3.19, in milliseconds where they are times. timing in the constructor overrides any
// of them, for tests and SEM_CHAT_FAST.
const TIMING = {
  feedLimit: 64,
  pagesPerRun: 50,
  minFetchGap: 500,
  moreAfter: SECOND,
  eventsNewest: 50,
  eventsPage: 100,
  forwardGapMax: 300,
  backfillPages: 10,
  readFlush: 5 * SECOND,
  clockMaxAge: 6 * HOUR,
  sendBackoff: [2, 5, 15, 30, 60].map((s) => s * SECOND),
  syncBackoff: [5, 15, 30, 60, 120].map((s) => s * SECOND),
  socketBackoff: [1, 2, 4, 8, 16, 32, 60].map((s) => s * SECOND),
  pingEvery: 30 * SECOND,
  pongTimeout: 10 * SECOND,
  reconnectGap: 10 * SECOND,
  leaseRefresh: 10 * MINUTE,
  listEvery: 30 * MINUTE,
  listFocusGap: MINUTE,
  infoEvery: HOUR,
  notifyRooms: 3,
  sendsInFlight: 2,
  tombstoneDays: 14,
  // The catch-up timer of each workspace (desktop-service.md "Catch-up timer"), re-armed after every run with 10
  // percent jitter: a minute while the window has focus, five minutes away; an open socket covers the rest, with a
  // run before its lease runs out.
  catchupFocused: MINUTE,
  catchupAway: 5 * MINUTE,
  focusRunGap: 5 * SECOND,
  focusSpread: 10 * SECOND,
  socketsMax: 8,
  // state and rooms events within this many milliseconds go out as one.
  coalesce: 100,
  // A write that gets 429 tries again after Retry-After, at most this often and within this window (contract 4.4).
  writeRetries: 3,
  writeRetryWindow: 30 * SECOND,
  // SEM_CHAT_RETRY_DELAY: how long the outbox holds its first retry after a reconnect, for the held-row journey.
  retryDelay: 0,
  // A cache file that couldn't be deleted is tried again this often.
  wipeRetry: MINUTE,
  // Downloaded team chat files kept on this computer (rich contract 4.6).
  fileCacheMax: 1024 * 1024 * 1024
};

// The test knobs (contract 4.8): under SEM_HIDDEN, SEM_CHAT_FAST=1 makes the read flush 300 ms, the catch-up 2 s and
// every backoff start at 100 ms; SEM_CHAT_RETRY_DELAY=<ms> holds the outbox's first retry after a reconnect.
function chatTiming(env = {}) {
  const out = {};
  if (!env.SEM_HIDDEN) return out;
  if (env.SEM_CHAT_FAST === '1') {
    Object.assign(out, {
      readFlush: 300,
      catchupFocused: 2 * SECOND,
      catchupAway: 2 * SECOND,
      syncBackoff: [100, 200, 400, 800, 1600],
      sendBackoff: [100, 200, 400, 800, 1600],
      socketBackoff: [100, 200, 400, 800, 1600, 3200, 6000]
    });
  }
  if (/^\d{1,7}$/.test(String(env.SEM_CHAT_RETRY_DELAY || ''))) out.retryDelay = Number(env.SEM_CHAT_RETRY_DELAY);
  return out;
}

// Timers that keep a test process alive only while they are short: a catch-up or a backoff of minutes never holds
// it open, a run due in a moment does.
const realTimers = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    if (ms > SECOND && timer && timer.unref) timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval(fn, ms) {
    const timer = setInterval(fn, ms);
    if (timer && timer.unref) timer.unref();
    return timer;
  },
  clearInterval: (timer) => clearInterval(timer)
};

// Thrown after an await when the session the job started in has ended. Never reaches the renderer as itself: ipc.js
// turns it into signed_out.
class Stale extends Error {
  constructor() {
    super('The team chat session changed');
    this.name = 'Stale';
    this.stale = true;
  }
}

const sidecars = (file) => [file, `${file}-wal`, `${file}-shm`];
const anyExists = (file) => sidecars(file).some((f) => fs.existsSync(f));
const isInt = (v) => Number.isSafeInteger(v) && v >= 0;
const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function hostOf(server) {
  try {
    return new URL(server).host;
  } catch (_) {
    return '';
  }
}

// Whether the configured server has team chat (contract 3.1): its saved GET /v1/info lists workspaces-v1 and
// version 1 of the workspace protocol.
function isAvailable(info) {
  return Boolean(
    info &&
      Array.isArray(info.features) &&
      info.features.includes('workspaces-v1') &&
      info.workspace &&
      Array.isArray(info.workspace.versions) &&
      info.workspace.versions.includes(1)
  );
}

// ChatState without a service (before main.js made it).
function blankState() {
  return {
    available: false,
    storage: true,
    signedIn: false,
    server: '',
    host: '',
    operator: null,
    jurisdiction: null,
    signups: null,
    inviteSignups: false,
    retention: null,
    limits: null,
    notifications: true,
    pendingJoin: false,
    unsent: 0,
    lostUnsent: 0,
    selected: null,
    connection: 'idle',
    attention: 0,
    unread: false,
    workspaces: [],
    capabilities: [],
    files: null
  };
}

// What /v1/info lists the workspace server can do (rich contract 2.1): reactions, unread, files, previews.
function capabilitiesOf(info) {
  const ws = info && info.workspace && typeof info.workspace === 'object' ? info.workspace : null;
  const list = ws && Array.isArray(ws.capabilities) ? ws.capabilities : [];
  return [...new Set(list.filter((c) => typeof c === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(c)))].slice(0, 50);
}

// /v1/info's workspace.files when files are listed: { maxBytes, workspaceBytes, origin }, origin '' for the server's.
function filesOf(info) {
  if (!capabilitiesOf(info).includes('files')) return null;
  const f = info.workspace.files && typeof info.workspace.files === 'object' ? info.workspace.files : {};
  let origin = '';
  if (typeof f.origin === 'string' && f.origin) {
    try {
      const u = new URL(f.origin);
      if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin;
    } catch (_) {
      origin = '';
    }
  }
  return { maxBytes: isInt(f.maxBytes) ? f.maxBytes : null, workspaceBytes: isInt(f.workspaceBytes) ? f.workspaceBytes : null, origin };
}

class WorkspaceService extends EventEmitter {
  // settings: () => engine.settings. timing: overrides of TIMING (chatTiming). WebSocket, now, random and timers can
  // be replaced in tests. host: what only Electron does for files.js (dialogs, opening a file, nativeImage), which
  // main.js gives and tests replace. autoInfo: GET /v1/info by itself, signed in or not (refreshInfo), which main.js
  // turns off for tests that didn't name a server of their own.
  constructor({
    account,
    dataDir,
    settings = () => ({}),
    timing = {},
    WebSocket = globalThis.WebSocket,
    now = Date.now,
    random = Math.random,
    timers = realTimers,
    host = {},
    autoInfo = true
  }) {
    super();
    this.account = account;
    this.dataDir = dataDir;
    this.autoInfo = autoInfo;
    // The last GET /v1/info this service asked for by itself: when it began and for which server, and the one on its
    // way, which a second ask shares (maybeRefreshInfo, refreshInfo).
    // Per server: { at, asking }, so switching servers and back doesn't ask the first one twice.
    this.infoTries = new Map();
    this.file = path.join(dataDir, 'chat.db');
    this.settings = typeof settings === 'function' ? settings : () => settings || {};
    this.timing = { ...TIMING, ...timing };
    this.WebSocket = WebSocket;
    this.now = now;
    this.random = random;
    this.timers = timers;
    this.host = host || {};
    this.store = null;
    this.epoch = 0;
    // false when node:sqlite couldn't open the cache, or a file to replace couldn't be deleted.
    this.storage = true;
    this.lostUnsent = 0;
    this.signedIn = false;
    this.server = '';
    this.info = null;
    this.available = false;
    this.followed = null;
    this.focused = false;
    // The room on screen, which the history module sets: { ws, room } or null.
    this.active = null;
    this.selected = null;
    this.runners = new Map();
    // The cache revision of each workspace (revision()), from one counter so a value is never used twice; the revision
    // the last GET / answered under (detailsCurrent()); and per workspace the GET / requests started and the newest one
    // whose answer was applied, so an older answer that comes later is dropped.
    this.revisions = new Map();
    this.revisionSeq = 0;
    this.detailsRev = new Map();
    this.detailsStarted = new Map();
    this.detailsApplied = new Map();
    // A timer that tries again to delete workspaces the server removed but the cache couldn't delete yet.
    this.removeTimer = null;
    this.sockets = new Map();
    // The last successful request to each workspace, for the socket lease.
    this.lastOk = new Map();
    this.listing = null;
    this.listedAt = -Infinity;
    this.listError = null;
    this.wipePending = false;
    this.closed = false;
    this.pending = { rooms: new Map(), state: false };
    this.sentState = null;
    this.flushTimer = null;
    this.intervals = [];
    this.retryTimer = null;
    this.hookError = null;
    this.history = new History(this);
    this.outbox = new Outbox(this);
    this.manage = new Manage(this);
    this.notifier = new Notifier(this);
    this.files = new Files(this);
    this.onStatus = () => this.follow();
    this.onInfo = () => this.follow();
  }

  // Follows the account from now on, opens or deletes the cache and starts the timers. Returns this.
  init() {
    this.account.on('status', this.onStatus);
    this.account.on('info', this.onInfo);
    this.follow();
    this.intervals.push(
      this.timers.setInterval(() => {
        if (this.live()) this.list().catch(() => {});
      }, this.timing.listEvery),
      // Every hour, unless something else asked within the last 54 minutes.
      this.timers.setInterval(() => this.maybeRefreshInfo({ maxAge: Math.round(this.timing.infoEvery * 0.9) }), this.timing.infoEvery)
    );
    return this;
  }

  // Synchronous, for quitting: timers, sockets (closed with 1000) and the cache. Read positions and unsent messages
  // are on disk already; the next start goes on from there.
  close() {
    if (this.closed) return;
    this.closed = true;
    this.account.removeListener('status', this.onStatus);
    this.account.removeListener('info', this.onInfo);
    for (const timer of this.intervals) this.timers.clearInterval(timer);
    this.intervals = [];
    if (this.flushTimer) this.timers.clearTimeout(this.flushTimer);
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    if (this.removeTimer) this.timers.clearTimeout(this.removeTimer);
    this.flushTimer = this.retryTimer = this.removeTimer = null;
    this.stopNetwork();
    for (const module of [this.history, this.outbox, this.manage, this.notifier, this.files]) {
      if (module && typeof module.close === 'function') {
        try {
          module.close();
        } catch (_) {
          // Quitting goes on.
        }
      }
    }
    if (this.store) this.store.close();
    this.store = null;
  }

  // ---- the session and its cache (contract 3.1 and 3.4) ----

  live() {
    return Boolean(this.store && this.signedIn && this.available && !this.closed);
  }

  isStale(err) {
    return Boolean(err && err.stale === true);
  }

  // Throws Stale when the session moved on since epoch, or, given run ({ runner, stops } of a run), when the service
  // stopped that run since (Chat turned off: stopNetwork).
  guard(epoch, run = null) {
    if (epoch !== this.epoch || this.closed) throw new Stale();
    if (run && run.runner.stops !== run.stops) throw new Stale();
  }

  // ---- the cache revision (contract 3.6) ----

  // A number that changes whenever the workspace's cache is reset (410), started over, restored (new generation),
  // re-keyed, quarantined (409), parked (426) or removed. Every fetch for the workspace (feed pages, history pages,
  // alert fetches, GET /) records it before the request and drops its answer or error when it changed meanwhile: that
  // answer belongs to the cache as it stood before. bumpRevision runs inside the transaction that resets the cache.
  revision(ws) {
    return this.revisions.get(ws) || 0;
  }

  bumpRevision(ws) {
    this.revisionSeq += 1;
    this.revisions.set(ws, this.revisionSeq);
    return this.revisionSeq;
  }

  // Whether a GET / answered (and was applied) under the workspace's current revision, which a pass from the start
  // needs before it begins (sync.js runSync).
  detailsCurrent(ws) {
    return this.detailsRev.has(ws) && this.detailsRev.get(ws) === this.revision(ws);
  }

  // The account said something: a sign-in, a sign-out, a new server, new server info, or a sync. Only the signature
  // of signed in, server and session tag changes the cache; availability starts or stops the network.
  follow() {
    if (this.closed) return;
    const status = this.account.status();
    const signedIn = Boolean(status.signedIn);
    const server = String(status.server || '');
    const tag = signedIn ? this.account.sessionTag : null;
    const sig = `${signedIn}\n${server}\n${tag}`;
    this.info = status.info || null;
    const available = isAvailable(this.info);
    const changed = sig !== this.followed;
    const availableChanged = available !== this.available;
    this.followed = sig;
    this.signedIn = signedIn;
    this.server = server;
    this.available = available;
    if (changed) {
      this.endSession();
      if (!signedIn) {
        this.discard();
      } else {
        this.openCache(server, tag);
        // At start signed in, and after a sign-in, which fetched it a moment ago itself.
        this.maybeRefreshInfo({ maxAge: MINUTE });
        this.startNetwork();
      }
    } else if (availableChanged) {
      if (available && signedIn && !this.store) this.openCache(server, tag);
      if (this.live()) this.startNetwork();
      else this.stopNetwork({ keepRuns: true });
    }
    // Signed out too: whether the server has team chat decides whether Chat shows, and the setup page's way to it.
    if (!signedIn) this.maybeRefreshInfo();
    this.stateChanged();
  }

  // Whatever the old session started stops: its answers are dropped, its runs and sockets end and its alerts go.
  endSession() {
    this.epoch += 1;
    this.stopNetwork();
    this.active = null;
    this.selected = null;
    this.lastOk.clear();
    // A listing of the old session may still be on its way: the new session's first listing mustn't wait for it.
    this.listing = null;
    this.listedAt = -Infinity;
    this.listError = null;
    this.detailsRev.clear();
    this.pending.rooms.clear();
    try {
      this.notifier.clear();
    } catch (err) {
      this.hookFailed(err);
    }
    try {
      this.files.clear();
    } catch (err) {
      this.hookFailed(err);
    }
  }

  // Signed out: the cache and its -wal and -shm files go (contract 3.4), unsent messages with them. A file another
  // process holds stays, erased, and is tried again.
  discard() {
    this.lostUnsent = 0;
    let gone = true;
    this.stopRemoveTimer();
    try {
      this.manage.onSignedOut();
    } catch (err) {
      this.hookFailed(err);
    }
    if (this.store) {
      gone = this.store.wipe();
      this.store = null;
    } else if (anyExists(this.file)) {
      try {
        gone = openStore(this.file, { now: this.now }).wipe();
      } catch (_) {
        for (const f of sidecars(this.file)) {
          try {
            fs.rmSync(f, { force: true });
          } catch (_) {
            // Checked below.
          }
        }
        gone = !anyExists(this.file);
      }
    }
    this.storage = true;
    this.wipePending = !gone;
    if (!gone) this.retryLater();
    return gone;
  }

  retryLater() {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.closed) return;
      if (!this.signedIn && this.wipePending) this.discard();
      else if (this.signedIn && this.available && !this.store) {
        this.openCache(this.server, this.account.sessionTag);
        this.startNetwork();
        this.stateChanged();
      }
    }, this.timing.wipeRetry);
  }

  // Signed in: the cache of this session, made when there is none. A file of another session or server is deleted
  // first. Without team chat on the server, an existing file is still checked (and a stranger's deleted), but none is
  // made. Returns whether the cache is open.
  openCache(server, tag) {
    if (this.store) {
      if (this.store.getMeta('session') === tag && this.store.getMeta('server') === server) return true;
      this.wipeStore();
    }
    if (!this.available && !anyExists(this.file)) return false;
    try {
      let store = openStore(this.file, { now: this.now });
      const session = store.getMeta('session');
      const at = store.getMeta('server');
      if ((session && session !== tag) || (at && at !== server)) {
        store.wipe();
        store = openStore(this.file, { now: this.now });
      }
      if (!store.getMeta('session')) {
        store.tx(() => {
          store.setMeta('session', tag);
          store.setMeta('server', server);
        });
      }
      // A workspace parked for a newer protocol tries again once per start: this may be the newer Rukoo.
      store.run(`UPDATE ws SET state = 'ok' WHERE state = 'upgrade'`);
      this.store = store;
      this.storage = true;
      this.lostUnsent += store.lostUnsent;
      const selected = store.getMeta('selected');
      this.selected = selected && store.getWs(selected) ? selected : null;
    } catch (_) {
      this.store = null;
      this.storage = false;
      this.retryLater();
      return false;
    }
    try {
      this.manage.onSignedIn();
    } catch (err) {
      this.hookFailed(err);
    }
    try {
      this.files.onOpened();
    } catch (err) {
      this.hookFailed(err);
    }
    return true;
  }

  wipeStore() {
    const store = this.store;
    this.stopRemoveTimer();
    this.store = null;
    if (store && !store.wipe()) {
      this.wipePending = true;
      this.retryLater();
    }
  }

  // GET /v1/info again: at start signed in, after a sign-in and every hour (contract 3.1). With autoInfo also while
  // signed out, so Chat shows on a server that has it before anyone signs in. The account says 'info', which follow()
  // reads.
  refreshInfo() {
    if ((!this.signedIn && !this.autoInfo) || this.closed) return Promise.resolve();
    const status = this.account.status();
    if (!status || !status.server) return Promise.resolve();
    const server = status.server;
    const tried = this.infoTries.get(server);
    if (tried && tried.asking) return tried.asking;
    const asking = this.account.serverInfo(server).then(
      () => {},
      () => {}
    );
    const entry = { at: this.now(), asking };
    this.infoTries.set(server, entry);
    asking.then(() => {
      if (entry.asking === asking) entry.asking = null;
    });
    return asking;
  }

  // GET /v1/info when the saved answer is missing or older than maxAge, at most once a minute per server, so a start,
  // a sign-in or a new server learns whether there is team chat without asking a server that doesn't answer over and
  // over. Signed out only with autoInfo.
  maybeRefreshInfo({ maxAge = this.timing.infoEvery } = {}) {
    if ((!this.signedIn && !this.autoInfo) || this.closed) return;
    const status = this.account.status();
    const server = status && status.server;
    if (!server) return;
    const tried = this.infoTries.get(server);
    if (tried && (tried.asking || this.now() - tried.at < MINUTE)) return;
    const at = typeof this.account.infoAt === 'function' ? this.account.infoAt() : null;
    if (this.info && Number.isFinite(at) && this.now() - at < maxAge) return;
    this.refreshInfo();
  }

  // ---- the network ----

  startNetwork() {
    if (!this.live()) return;
    this.list().catch(() => {});
    for (const row of this.store.listWs()) if (row.state === 'ok') this.schedule(row.id, 0);
    this.updateSockets();
  }

  // Sockets close, timers stop, and runs on their way are retired: their answers are dropped (guard with the run's
  // stops). keepRuns (Chat turned off while signed in): a runner whose run is still on its way stays, marked running,
  // so a start before that run ends sets again instead of starting a second run of the workspace.
  stopNetwork({ keepRuns = false } = {}) {
    for (const socket of this.sockets.values()) socket.stop(1000);
    this.sockets.clear();
    for (const [ws, r] of this.runners) {
      if (r.timer) this.timers.clearTimeout(r.timer);
      r.timer = null;
      r.due = null;
      r.stops += 1;
      for (const resolve of r.waiters.splice(0)) resolve({ stale: true });
      if (!keepRuns || !r.running) this.runners.delete(ws);
    }
  }

  // A request to the workspace routes with the account's session: under /v1/workspaces/{ws} when ws is given (route
  // '' is GET /), else route as it is. Throws ChatError (contract 3.15), or Stale when the session ended meanwhile.
  // A 404 with scope workspace runs the removal path, and a 426 parks the workspace, before the error goes on.
  // retry: a 429 waits Retry-After and tries again, up to three times within 30 s (contract 4.4, for writes).
  // goneReason: the reason the removed event gives when the workspace turns out to be gone.
  //
  // The 404 and the 426 act only under the cache revision the request went out under: one that answers after a reset,
  // Start over, restore, new key, park or removal belongs to the workspace as it stood, and goes on marked superseded
  // without removing or parking anything (contract 3.6). The next request asks again.
  async call(ws, method, route, body, { retry = false, goneReason = 'removed' } = {}) {
    if (!this.store || !this.signedIn) throw new ChatError('signed_out');
    if (!this.available) throw new ChatError('server');
    const epoch = this.epoch;
    const full = ws ? `/v1/workspaces/${ws}${route}` : route;
    const started = this.now();
    for (let attempt = 0; ; attempt++) {
      const rev = ws ? this.revision(ws) : null;
      try {
        const res = await this.account.workspaceCall(method, full, body);
        this.guard(epoch);
        if (ws) this.lastOk.set(ws, this.now());
        return res;
      } catch (raw) {
        if (this.isStale(raw)) throw raw;
        this.guard(epoch);
        const err = chatError(raw);
        if (retry && err.code === 'rate_limited' && attempt + 1 < this.timing.writeRetries) {
          const wait = (err.retryAfter || 1) * SECOND;
          if (this.now() + wait - started <= this.timing.writeRetryWindow) {
            await new Promise((resolve) => this.timers.setTimeout(resolve, wait));
            this.guard(epoch);
            continue;
          }
        }
        const scoped = ws && ((err.code === 'not_found' && err.scope === 'workspace') || err.code === 'upgrade_required');
        if (scoped && this.revision(ws) !== rev) err.superseded = true;
        else if (scoped && err.code === 'upgrade_required') this.park(ws);
        else if (scoped) this.removeWorkspace(ws, goneReason);
        throw err;
      }
    }
  }

  // 426: the server needs a newer workspace protocol. The workspace waits, socket closed, until Rukoo is updated.
  park(ws) {
    if (!this.store || !this.store.getWs(ws)) return;
    this.store.tx(() => {
      this.bumpRevision(ws);
      this.store.updateWs(ws, { state: 'upgrade' });
    });
    this.updateSockets();
    this.stateChanged();
  }

  // GET / for a workspace: its name, my member row, generation, keyId, limits and retention, and the clock. A new
  // generation runs the restore path; a new keyId starts a pass. Either asks for a run, which does the pass, unless
  // the run itself asked (inRun: sync.js), as it goes on with the pass. Returns the checked answer.
  //
  // An answer is applied only under the cache revision its request started under, and only when no GET / of the same
  // workspace that started later was applied first: an older answer would put back the generation, keyId or role a
  // newer one replaced. A dropped answer still measures the clock. run: { runner, stops } of the run that asks (sync.js),
  // whose answer is dropped whole, as Stale, when Chat stopped that run meanwhile.
  async details(ws, { goneReason = 'removed', inRun = false, run = null } = {}) {
    const epoch = this.epoch;
    const rev = this.revision(ws);
    const ticket = (this.detailsStarted.get(ws) || 0) + 1;
    this.detailsStarted.set(ws, ticket);
    const t0 = this.now();
    const answer = wire.checkWorkspace(await this.call(ws, 'GET', '', undefined, { goneReason }));
    const t1 = this.now();
    this.guard(epoch, run);
    if (!this.store.getWs(ws)) return answer;
    if (this.revision(ws) !== rev || ticket < (this.detailsApplied.get(ws) || 0)) {
      this.store.tx(() => {
        this.store.setMeta('clockOffset', String(Math.round(answer.workspace.time - (t0 + t1) / 2)));
        this.store.setMeta('clockAt', String(t1));
      });
      return answer;
    }
    this.detailsApplied.set(ws, ticket);
    const { restored, keyChanged } = sync.restore(this, ws, answer, { t0, t1 });
    this.detailsRev.set(ws, this.revision(ws));
    if (restored || keyChanged) {
      this.roomsChanged(ws, this.store.listRooms(ws).map((r) => r.id));
      // Both deleted the notice rows: the pass that follows can't list what was removed meanwhile.
      await this.hook(() => this.notifier.onReset(ws));
      await this.hook(() => this.history.onReset(ws));
      if (restored) await this.hook(() => this.outbox.kick(ws));
    }
    // From the listing, a 4003 or the outbox: the pass mustn't wait for the catch-up timer. During a run this only
    // makes another run follow, for a reset that came after the run's last page.
    if ((restored || keyChanged) && !inRun) this.sync(ws, 'restore');
    this.stateChanged();
    return answer;
  }

  // The server's time minus this computer's, in milliseconds, or null when unknown or older than clockMaxAge.
  clock() {
    if (!this.store) return null;
    const offset = Number(this.store.getMeta('clockOffset'));
    const at = Number(this.store.getMeta('clockAt'));
    if (!Number.isFinite(offset) || !Number.isFinite(at) || this.store.getMeta('clockAt') === null) return null;
    if (this.now() - at > this.timing.clockMaxAge) return null;
    return offset;
  }

  // GET /v1/workspaces (contract 3.11): new workspaces get a row and a first pass, one that is no longer listed is
  // asked GET /, whose 404 removes it. A failed listing changes nothing. One listing at a time.
  list() {
    if (!this.live()) return Promise.resolve(null);
    if (this.listing) return this.listing;
    const epoch = this.epoch;
    const run = (async () => {
      try {
        const answer = wire.checkWorkspaces(await this.call(null, 'GET', '/v1/workspaces'));
        this.guard(epoch);
        const store = this.store;
        const known = new Set(store.listWs().map((r) => r.id));
        const listed = new Set(answer.workspaces.map((w) => w.id));
        const added = [];
        store.tx(() => {
          for (const w of answer.workspaces) {
            if (!known.has(w.id)) added.push(w.id);
            store.insertWs(w);
          }
        });
        this.listedAt = this.now();
        this.listError = null;
        if (!this.selected || !store.getWs(this.selected)) this.pickSelected();
        for (const id of added) this.schedule(id, 0);
        for (const id of known) {
          if (!listed.has(id)) this.details(id, { goneReason: 'gone' }).catch(() => {});
        }
        this.updateSockets();
        this.stateChanged();
        return answer.workspaces;
      } catch (err) {
        if (this.isStale(err)) return null;
        this.listError = err && err.code ? err.code : 'server';
        this.stateChanged();
        throw err;
      } finally {
        if (this.listing === run) this.listing = null;
      }
    })();
    this.listing = run;
    return run;
  }

  // The first workspace by name when none is selected, or none.
  pickSelected() {
    const rows = this.ordered();
    this.setSelected(rows.length ? rows[0].id : null);
  }

  setSelected(ws) {
    this.selected = ws;
    if (!this.store) return;
    if (ws) this.store.setMeta('selected', ws);
    else this.store.deleteMeta('selected');
  }

  ordered() {
    return this.store ? this.store.listWs().sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)) : [];
  }

  // The directories marked stale (or named in which) loaded again now, outside a run: after a block, for one.
  async refreshDirectory(ws, which = {}) {
    if (!this.store || !this.store.getWs(ws)) throw new ChatError('not_found', { scope: 'workspace' });
    const flags = {};
    if (which.members) flags.membersStale = 1;
    if (which.channels) flags.channelsStale = 1;
    if (which.blocks) flags.blocksStale = 1;
    if (Object.keys(flags).length) this.store.updateWs(ws, flags);
    return sync.directory(this, ws);
  }

  // The person lost a workspace: removed, left, deleted, or gone from the listing. Its row goes with everything under
  // it, the WAL is checkpointed so deleted pages don't linger, and the main window hears removed. The workspace is
  // hidden from every cache read first (store.hideWs), so when SQLite refuses the deletion nothing shows its rows
  // meanwhile, and the deletion is tried again every wipeRetry until it succeeds.
  removeWorkspace(ws, reason = 'removed') {
    if (!this.store || !this.store.getWs(ws)) return false;
    this.bumpRevision(ws);
    this.store.hideWs(ws);
    const socket = this.sockets.get(ws);
    if (socket) socket.stop(1000);
    this.sockets.delete(ws);
    const r = this.runners.get(ws);
    if (r) {
      if (r.timer) this.timers.clearTimeout(r.timer);
      for (const resolve of r.waiters.splice(0)) resolve({ gone: true });
      this.runners.delete(ws);
    }
    this.deleteHidden();
    this.lastOk.delete(ws);
    if (this.active && this.active.ws === ws) this.active = null;
    if (this.selected === ws) this.pickSelected();
    this.emit('event', { kind: 'removed', ws, reason });
    this.hook(() => this.history.onWorkspaceGone(ws));
    this.hook(() => this.notifier.onWorkspaceGone(ws));
    this.hook(() => this.files.onWorkspaceGone(ws));
    this.updateSockets();
    this.stateChanged();
    if (reason === 'removed') this.list().catch(() => {});
    return true;
  }

  // Deletes the workspaces removeWorkspace hid, with a checkpoint after. Those SQLite refuses stay hidden and are tried
  // again after wipeRetry.
  deleteHidden() {
    const store = this.store;
    if (!store || !store.hidden.size) return;
    let deleted = false;
    for (const ws of [...store.hidden]) {
      try {
        store.deleteWs(ws);
        deleted = true;
      } catch (err) {
        this.hookFailed(err);
      }
    }
    if (deleted) {
      try {
        store.checkpoint();
      } catch (_) {
        // A reader holds the WAL; the next checkpoint gets it.
      }
    }
    if (!store.hidden.size || this.removeTimer || this.closed) return;
    this.removeTimer = this.timers.setTimeout(() => {
      this.removeTimer = null;
      if (!this.closed && this.store === store) this.deleteHidden();
    }, this.timing.wipeRetry);
  }

  // The retry of deleteHidden belongs to the cache it was set for: when that cache goes, so does the timer, so the
  // next cache's own failed deletion sets one of its own.
  stopRemoveTimer() {
    if (this.removeTimer) this.timers.clearTimeout(this.removeTimer);
    this.removeTimer = null;
  }

  // ---- runs (contract 3.6): one per workspace at a time, at least MIN_FETCH_GAP apart ----

  runner(ws) {
    let r = this.runners.get(ws);
    if (!r) {
      r = {
        running: false,
        again: false,
        timer: null,
        due: null,
        lastStart: -Infinity,
        failures: 0,
        notBefore: 0,
        error: null,
        // The last run failed on the network or a 5xx (contract 3.6): the workspace shows offline, error code kept.
        offline: false,
        ok: false,
        waiters: [],
        detailsDue: false,
        nudgedAt: -Infinity,
        // How often stopNetwork retired this runner's runs; a run captures it and drops its answers when it moved.
        stops: 0
      };
      this.runners.set(ws, r);
    }
    return r;
  }

  // A run of ws after delay ms, or sooner when one is due sooner already. During a run it sets again, and the next
  // run follows it.
  schedule(ws, delay = 0) {
    if (!this.live() || !this.store.getWs(ws)) return;
    const r = this.runner(ws);
    if (r.running) {
      if (delay === 0) r.again = true;
      return;
    }
    const now = this.now();
    const at = Math.max(now + delay, r.lastStart + this.timing.minFetchGap, r.notBefore);
    if (r.timer && r.due <= at) return;
    if (r.timer) this.timers.clearTimeout(r.timer);
    r.due = at;
    r.timer = this.timers.setTimeout(() => {
      r.timer = null;
      r.due = null;
      this.run(ws);
    }, Math.max(0, at - now));
  }

  // Asks for a run; resolves when a run that started after this call has ended, with its outcome. Any reason but the
  // catch-up timer resets the backoff: a wake, focus, resume or the person's own request.
  sync(ws, why = 'manual') {
    if (!this.live() || !ws || !this.store.getWs(ws)) return Promise.resolve({ skipped: true });
    const r = this.runner(ws);
    if (why !== 'catchup') r.failures = 0;
    return new Promise((resolve) => {
      r.waiters.push(resolve);
      this.schedule(ws, 0);
    });
  }

  async run(ws) {
    const r = this.runners.get(ws);
    if (!r || !this.live() || !this.store.getWs(ws)) {
      if (r) for (const resolve of r.waiters.splice(0)) resolve({ skipped: true });
      return;
    }
    if (r.running) {
      r.again = true;
      return;
    }
    const epoch = this.epoch;
    const stops = r.stops;
    r.running = true;
    r.again = false;
    r.lastStart = this.now();
    const waiters = r.waiters.splice(0);
    this.stateChanged();
    let outcome;
    try {
      outcome = await sync.runSync(this, ws);
      r.error = null;
      r.offline = false;
      r.failures = 0;
      r.ok = true;
    } catch (err) {
      if (this.isStale(err)) outcome = { stale: true };
      else {
        const e = chatError(err);
        r.error = wire.isInternal(e.code) ? 'server' : e.code;
        r.offline = e.code === 'network' || e.status >= 500;
        if (e.code === 'rate_limited') r.notBefore = this.now() + (e.retryAfter || 1) * SECOND;
        else r.failures += 1;
        outcome = { error: e };
      }
    } finally {
      r.running = false;
    }
    for (const resolve of waiters) resolve(outcome);
    if (epoch !== this.epoch || this.runners.get(ws) !== r || this.closed) return;
    if (stops !== r.stops) {
      // Retired by stopNetwork while it ran. Chat came back meanwhile (startNetwork set again): the next run starts
      // now, after this one, so there was never a second run beside it. Still off: the runner goes, as stopNetwork
      // would have let it.
      if (!this.live()) this.runners.delete(ws);
      else if (r.again) this.schedule(ws, 0);
      return;
    }
    this.stateChanged();
    // A stopped or parked workspace waits for Start over or a newer Rukoo, not for a timer.
    const row = this.store && this.store.getWs(ws);
    if (!row || row.state !== 'ok') return;
    if (r.again) this.schedule(ws, 0);
    else if (outcome.more) this.schedule(ws, this.timing.moreAfter);
    else if (outcome.error && outcome.error.code === 'rate_limited') this.schedule(ws, 0);
    else if (outcome.error) {
      const table = this.timing.syncBackoff;
      this.schedule(ws, table[Math.min(r.failures - 1, table.length - 1)]);
    } else this.schedule(ws, this.catchupDelay(ws));
  }

  // The catch-up timer (desktop-service.md): a minute for the selected workspace while the window has focus, and
  // without an open socket while it has focus; five minutes without one away; with an open socket, before its lease
  // runs out. Each with 10 percent jitter.
  catchupDelay(ws) {
    const open = this.socketState(ws) === 'open';
    let base;
    if (open && !(this.focused && ws === this.selected)) {
      const last = this.lastOk.has(ws) ? this.lastOk.get(ws) : this.now();
      base = Math.max(this.timing.leaseRefresh - (this.now() - last), 0);
    } else base = this.focused ? this.timing.catchupFocused : this.timing.catchupAway;
    return Math.max(0, Math.round(base * (0.9 + 0.2 * this.random())));
  }

  // chatSync: a run of ws, or of every workspace after a listing, and the state after it.
  async syncNow(ws = null) {
    if (!this.live()) return this.state();
    if (ws && !this.store.getWs(ws)) throw new ChatError('not_found', { scope: 'workspace' });
    if (!ws) await this.list().catch(() => {});
    const ids = ws ? [ws] : this.store ? this.store.listWs().map((r) => r.id) : [];
    await Promise.all(ids.map((id) => this.sync(id, 'manual')));
    return this.state();
  }

  // chatReload, Start over (contract 3.6): the workspace runs again from a pass, after GET /, and its unsent messages
  // are looked up first.
  async reload(ws) {
    if (!this.store || !this.store.getWs(ws)) throw new ChatError('not_found', { scope: 'workspace' });
    sync.startOver(this, ws);
    const r = this.runner(ws);
    r.detailsDue = true;
    r.error = null;
    r.failures = 0;
    r.notBefore = 0;
    await this.hook(() => this.notifier.onReset(ws));
    await this.hook(() => this.history.onReset(ws));
    await this.hook(() => this.outbox.kick(ws));
    this.updateSockets();
    this.stateChanged();
    this.sync(ws, 'reload');
    return this.state();
  }

  // ---- sockets (contract 3.11) ----

  socketUrl(ws) {
    return `${this.server.replace(/^http/, 'ws')}/v1/workspaces/${ws}/socket`;
  }

  socketState(ws) {
    const socket = this.sockets.get(ws);
    return socket ? socket.state : 'off';
  }

  // One socket each for the selected workspace and the seven most recently active, of those that are ok.
  updateSockets() {
    if (!this.live() || typeof this.WebSocket !== 'function') {
      for (const socket of this.sockets.values()) socket.stop(1000);
      this.sockets.clear();
      return;
    }
    const rows = this.store
      .listWs()
      .filter((r) => r.state === 'ok')
      .sort((a, b) => (b.id === this.selected) - (a.id === this.selected) || (b.activeAt || 0) - (a.activeAt || 0) || (a.id < b.id ? -1 : 1));
    const wanted = new Set(rows.slice(0, this.timing.socketsMax).map((r) => r.id));
    for (const [ws, socket] of this.sockets) {
      if (wanted.has(ws)) continue;
      socket.stop(1000);
      this.sockets.delete(ws);
    }
    for (const ws of wanted) {
      if (this.sockets.has(ws)) continue;
      const socket = this.makeSocket(ws);
      this.sockets.set(ws, socket);
      socket.start();
    }
  }

  makeSocket(ws) {
    const epoch = this.epoch;
    const mine = () => this.epoch === epoch && this.sockets.get(ws) === socket;
    const socket = new WakeSocket({
      url: this.socketUrl(ws),
      ticket: async () => wire.checkTicket(await this.call(ws, 'POST', '/socket-ticket')).ticket,
      WebSocket: this.WebSocket,
      timing: this.timing,
      random: this.random,
      now: this.now,
      timers: this.timers,
      onOpen: () => {
        if (!mine()) return;
        // Wakes sent while it was down are lost: a run catches up.
        this.sync(ws, 'socket');
        this.hook(() => this.outbox.kick(ws));
      },
      onWake: () => {
        if (mine()) this.sync(ws, 'wake');
      },
      onLease: () => {
        if (mine()) this.sync(ws, 'lease');
      },
      onRemoved: () => {
        if (!mine()) return;
        // 4003: GET / says whether the person is still a member; its 404 runs the removal path and its 426 parks the
        // workspace. Any other failure (network, 5xx, 429) may pass: the socket tries again after a backoff, and its
        // next 4003 asks GET / again.
        const ok = () => mine() && this.store && this.store.getWs(ws) && this.store.getWs(ws).state === 'ok';
        this.details(ws).then(
          () => {
            if (ok()) socket.start();
          },
          (err) => {
            if (this.isStale(err) || !ok()) return;
            // A 404 or 426 from before a reset (call() left the workspace alone): the socket asks again, and a 4003
            // then asks GET / under the cache as it is now.
            if (err && err.superseded) return socket.tryAgain(0);
            const code = err && err.code;
            if (['signed_out', 'not_found', 'forbidden', 'upgrade_required'].includes(code)) return;
            socket.tryAgain(code === 'rate_limited' ? (err.retryAfter || 1) * SECOND : 0);
          }
        );
      },
      onChange: () => this.stateChanged()
    });
    return socket;
  }

  // ---- focus, resume and the room on screen ----

  // The main window gained focus, showed or was restored (true), or lost focus or hid (false).
  setFocused(on) {
    const was = this.focused;
    this.focused = Boolean(on);
    if (this.focused && !was) this.nudge('focus');
  }

  // 'focus' or 'resume' (contract 3.11), which do the same: list again at most once a minute, run the selected
  // workspace now (at most once per 5 s) and the others spread over 10 s, reconnect sockets that are down and kick
  // the outbox.
  // eslint-disable-next-line no-unused-vars
  nudge(why = 'focus') {
    if (this.closed || !this.live()) return;
    const now = this.now();
    if (now - this.listedAt >= this.timing.listFocusGap) this.list().catch(() => {});
    for (const row of this.store.listWs()) {
      if (row.state !== 'ok') continue;
      const r = this.runner(row.id);
      r.failures = 0;
      if (row.id === this.selected) {
        if (now - r.nudgedAt >= this.timing.focusRunGap) {
          r.nudgedAt = now;
          this.schedule(row.id, 0);
        }
      } else {
        this.schedule(row.id, Math.floor(this.random() * this.timing.focusSpread));
      }
    }
    for (const socket of this.sockets.values()) socket.nudge();
    this.hook(() => this.outbox.kick());
  }

  // The room on screen, which the history module sets when the renderer opens and closes rooms: { ws, room } or
  // null. It decides the /changes query's active room (through activeQuery) and isOnScreen.
  setActive(active) {
    this.active = active && typeof active.ws === 'string' && typeof active.room === 'string' ? { ws: active.ws, room: active.room } : null;
    if (this.active) this.touch(this.active.ws);
  }

  // Chat on screen with that room, in the main window, which has focus.
  isOnScreen(ws, room) {
    return Boolean(this.focused && this.active && this.active.ws === ws && this.active.room === room);
  }

  // Recent activity in ws, which keeps its socket among the eight.
  touch(ws) {
    if (!this.store || !this.store.getWs(ws)) return;
    this.store.updateWs(ws, { activeAt: this.now() });
    this.updateSockets();
  }

  // What the server can do (rich contract 2.1), from /v1/info: 'reactions', 'unread', 'files', 'previews'.
  capabilities() {
    return capabilitiesOf(this.info);
  }

  // /v1/info's workspace.files, or null without files.
  filesInfo() {
    return filesOf(this.info);
  }

  // { id, name, role } of the person in ws, from GET /, or null before it answered.
  me(ws) {
    const row = this.store && this.store.getWs(ws);
    if (!row || !row.me) return null;
    return { id: row.me, name: row.myName, role: row.role };
  }

  // ---- what the renderer reads ----

  // chatSelect: the workspace shown in Chat, stored for the next start.
  select(ws) {
    if (ws !== null && !this.store.getWs(ws)) throw new ChatError('not_found', { scope: 'workspace' });
    this.setSelected(ws);
    if (ws) {
      this.touch(ws);
      this.sync(ws, 'select');
    }
    this.updateSockets();
    this.stateChanged();
    return this.state();
  }

  // Attention and unread per workspace (contract 3.10): a muted room asks for nothing, a DM for its unread messages
  // and a channel for its mentions.
  totals() {
    const out = new Map();
    if (!this.store) return out;
    const rows = this.store.all(
      `SELECT ws, SUM(CASE WHEN muted = 1 THEN 0 WHEN kind = 'dm' THEN unread ELSE mentions END) AS attention,
              MAX(CASE WHEN muted = 0 AND unread > 0 THEN 1 ELSE 0 END) AS unread
       FROM room GROUP BY ws`
    );
    for (const r of rows) out.set(r.ws, { attention: Math.min(r.attention || 0, 100), unread: Boolean(r.unread) });
    return out;
  }

  summary(row, totals = this.totals().get(row.id)) {
    const r = this.runners.get(row.id);
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      status: row.state !== 'ok' ? row.state : row.fresh ? 'loading' : 'ok',
      syncing: Boolean(r && r.running),
      socket: this.socketState(row.id),
      error: r && r.error ? r.error : null,
      attention: totals ? totals.attention : 0,
      unread: totals ? totals.unread : false
    };
  }

  connection(workspaces) {
    if (!this.live()) return 'idle';
    const w = workspaces.find((x) => x.id === this.selected) || workspaces[0];
    if (!w) {
      if (this.listError === 'network') return 'offline';
      return Number.isFinite(this.listedAt) ? 'online' : 'connecting';
    }
    const r = this.runners.get(w.id);
    // The last run failed on the network or with a 5xx: offline, even while a socket is open (contract 3.6).
    if (w.error === 'network' || (r && r.offline && w.error)) return 'offline';
    if (w.status === 'quarantined' || w.status === 'upgrade') return 'idle';
    if (w.socket === 'open') return 'online';
    if (w.socket === 'off' && r && r.ok && !w.error) return 'online';
    return 'connecting';
  }

  // ChatState (contract 4.6). take: this is the chatState IPC call, which reports lostUnsent once.
  state({ take = false } = {}) {
    const info = this.info || {};
    const ws = info.workspace && typeof info.workspace === 'object' ? info.workspace : {};
    const totals = this.totals();
    const workspaces = this.ordered().map((row) => this.summary(row, totals.get(row.id)));
    let attention = 0;
    let unread = false;
    for (const w of workspaces) {
      attention += w.attention;
      unread = unread || w.unread;
    }
    const operator = info.operator && typeof info.operator === 'object' ? { name: text(info.operator.name), url: text(info.operator.url, 2000) } : null;
    const jurisdiction = info.hosting && ['eu', 'us', 'fedramp'].includes(info.hosting.jurisdiction) ? info.hosting.jurisdiction : null;
    const retention = ws.retention && isInt(ws.retention.contentDays) && isInt(ws.retention.feedDays) ? { contentDays: ws.retention.contentDays, feedDays: ws.retention.feedDays } : null;
    const limits = ws.limits && isInt(ws.limits.workspacesPerAccount) && isInt(ws.limits.members) ? { workspacesPerAccount: ws.limits.workspacesPerAccount, members: ws.limits.members } : null;
    let unsent = 0;
    let pendingJoin = false;
    try {
      unsent = this.store ? Number(this.outbox.unsent()) || 0 : 0;
      pendingJoin = Boolean(this.manage.pendingJoin());
    } catch (err) {
      this.hookFailed(err);
    }
    const state = {
      available: this.available,
      storage: this.storage,
      signedIn: this.signedIn,
      server: this.server,
      host: hostOf(this.server),
      operator,
      jurisdiction,
      signups: ['open', 'invite', 'closed'].includes(info.signups) ? info.signups : null,
      inviteSignups: ws.inviteSignups === true,
      retention,
      limits,
      notifications: this.settings().chatNotifications !== false,
      pendingJoin,
      unsent,
      lostUnsent: this.lostUnsent,
      selected: this.selected,
      connection: this.connection(workspaces),
      attention: Math.min(attention, 100),
      unread,
      workspaces,
      // Rich messages (rich contract 2.1): what the renderer shows only when the server lists it.
      capabilities: this.capabilities(),
      files: this.filesInfo()
    };
    if (take && this.lostUnsent) {
      this.lostUnsent = 0;
      this.stateChanged();
    }
    return state;
  }

  // chatView: a workspace as the cache has it (contract 4.6 WorkspaceView).
  view(ws) {
    const row = this.store.getWs(ws);
    if (!row) throw new ChatError('not_found', { scope: 'workspace' });
    const members = this.store.listMembers(ws);
    const me = members.find((m) => m.id === row.me) || { id: row.me, kind: 'human', name: row.myName || '', role: row.role, state: 'active', joinedAt: 0 };
    return {
      ws: this.summary(row),
      me,
      rooms: this.store.listRooms(ws).map(wire.toRoom),
      members,
      membersMore: Boolean(row.membersMore),
      channels: this.store.listChannels(ws),
      blocks: this.store.listBlocks(ws)
    };
  }

  // ---- events (contract 4.5) ----

  // Sends a chat payload to the main window. state and rooms wait up to coalesce ms and go out as one; a state equal
  // to the last one sent is dropped.
  emitChat(payload) {
    if (!payload || typeof payload !== 'object' || this.closed) return;
    if (payload.kind === 'state') {
      this.stateChanged();
      return;
    }
    if (payload.kind === 'rooms') {
      const ids = (Array.isArray(payload.rooms) ? payload.rooms : []).map((r) => (typeof r === 'string' ? r : r && r.id)).filter(Boolean);
      this.roomsChanged(payload.ws, ids, Array.isArray(payload.removed) ? payload.removed : []);
      return;
    }
    this.emit('event', payload);
  }

  // Cached messages of a room whose reactions or link cards changed (rich contract 4.4): the updated event with each
  // as the renderer's Event, as the cache has it now.
  emitUpdated(ws, room, ids) {
    if (!this.store || !Array.isArray(ids) || !ids.length) return;
    const events = [];
    for (const id of new Set(ids)) {
      const row = this.store.eventById(ws, id);
      if (row && row.room === room) events.push(wire.toRenderer(row));
    }
    if (events.length) this.emit('event', { kind: 'updated', ws, conversation: room, events: events.sort((a, b) => a.seq - b.seq) });
  }

  // These rooms of ws changed (or went: removed). The rooms event reads them from the cache when it goes out, so it
  // carries what is there then; a room no longer there is listed in removed.
  roomsChanged(ws, ids = [], removed = []) {
    if (!ws || this.closed) return;
    let p = this.pending.rooms.get(ws);
    if (!p) {
      p = { ids: new Set(), removed: new Set() };
      this.pending.rooms.set(ws, p);
    }
    for (const id of ids) p.ids.add(id);
    for (const id of removed) p.removed.add(id);
    this.stateChanged();
  }

  stateChanged() {
    if (this.closed) return;
    this.pending.state = true;
    if (!this.flushTimer) this.flushTimer = this.timers.setTimeout(() => this.flush(), this.timing.coalesce);
  }

  flush() {
    this.flushTimer = null;
    if (this.closed) return;
    const rooms = this.pending.rooms;
    this.pending.rooms = new Map();
    if (this.store) {
      for (const [ws, p] of rooms) {
        if (!this.store.getWs(ws)) continue;
        const out = [];
        const removed = new Set(p.removed);
        for (const id of p.ids) {
          const row = this.store.getRoom(ws, id);
          if (row) out.push(wire.toRoom(row));
          else removed.add(id);
        }
        for (const id of removed) if (this.store.getRoom(ws, id)) removed.delete(id);
        if (out.length || removed.size) this.emit('event', { kind: 'rooms', ws, rooms: out, removed: [...removed] });
      }
    }
    if (this.pending.state) {
      this.pending.state = false;
      const state = this.state();
      const json = JSON.stringify(state);
      if (json !== this.sentState) {
        this.sentState = json;
        this.emit('event', { kind: 'state', state });
      }
    }
  }

  // The settings changed (chatNotifications): the state says so.
  settingsChanged() {
    this.stateChanged();
  }

  // A notification for main.js to show: { id, title, body, open: { ws, conversation, seq } }.
  show(notice) {
    if (!this.closed) this.emit('notify', notice);
  }

  // Takes a shown notification back.
  hide(id) {
    if (!this.closed) this.emit('unnotify', id);
  }

  // A hook of a module, which mustn't stop the core when it fails.
  hook(fn) {
    try {
      const value = fn();
      if (value && typeof value.then === 'function') {
        return value.then(
          () => {},
          (err) => {
            if (!this.isStale(err)) this.hookFailed(err);
          }
        );
      }
    } catch (err) {
      if (!this.isStale(err)) this.hookFailed(err);
    }
    return Promise.resolve();
  }

  hookFailed(err) {
    this.hookError = err;
    if (process.env.SEM_TRACE) console.warn('[chat] a module hook failed:', err && err.stack ? err.stack : err);
  }

  // For tests (contract 4.8): the cache and the network as they stand, without message text, tokens or tickets.
  debugState() {
    const store = this.store;
    const workspaces = store
      ? store.listWs().map((row) => {
          const r = this.runners.get(row.id);
          const socket = this.sockets.get(row.id);
          return {
            id: row.id,
            name: row.name,
            role: row.role,
            me: row.me,
            state: row.state,
            passing: Boolean(row.passing),
            fresh: Boolean(row.fresh),
            cursor: Boolean(row.cursor),
            generation: Boolean(row.generation),
            stale: { members: Boolean(row.membersStale), channels: Boolean(row.channelsStale), blocks: Boolean(row.blocksStale) },
            syncedAt: row.syncedAt,
            activeAt: row.activeAt,
            syncing: Boolean(r && r.running),
            error: r ? r.error : null,
            failures: r ? r.failures : 0,
            socket: socket ? socket.state : 'off',
            socketAttempt: socket ? socket.attempt : 0,
            rooms: store.listRooms(row.id).map((room) => ({
              id: room.id,
              kind: room.kind,
              head: room.head,
              floor: room.floor,
              read: room.read,
              readLocal: room.readLocal,
              readSent: room.readSent,
              unread: room.unread,
              mentions: room.mentions,
              lo: room.lo,
              hi: room.hi,
              notified: room.notified,
              muted: Boolean(room.muted)
            })),
            events: store.get('SELECT COUNT(*) AS n FROM event WHERE ws = ?', row.id).n,
            passRooms: store.get('SELECT COUNT(*) AS n FROM pass_room WHERE ws = ?', row.id).n,
            members: store.get('SELECT COUNT(*) AS n FROM member WHERE ws = ?', row.id).n,
            channels: store.get('SELECT COUNT(*) AS n FROM channel WHERE ws = ?', row.id).n,
            blocks: store.get('SELECT COUNT(*) AS n FROM block WHERE ws = ?', row.id).n,
            outbox: store.outboxForWs(row.id).map((o) => ({
              local: o.local,
              room: o.room,
              root: o.root,
              state: o.state,
              reason: o.reason,
              attempts: o.attempts,
              nextAt: o.nextAt,
              createdAt: o.createdAt,
              operationId: Boolean(o.operationId)
            }))
          };
        })
      : [];
    return {
      file: this.file,
      exists: anyExists(this.file),
      storage: this.storage,
      signedIn: this.signedIn,
      available: this.available,
      live: this.live(),
      epoch: this.epoch,
      focused: this.focused,
      active: this.active,
      selected: this.selected,
      listedAt: Number.isFinite(this.listedAt) ? this.listedAt : null,
      listError: this.listError,
      unsent: store ? store.countUnsent() : 0,
      staged: [...this.files.staged.values()].map((e) => ({ stage: e.stage, ws: e.ws, room: e.conversation, state: e.state, error: e.error, file: e.file })),
      views: this.files.views.size,
      hookError: this.hookError ? String(this.hookError.message || this.hookError).slice(0, 500) : null,
      workspaces
    };
  }
}

module.exports = { WorkspaceService, chatTiming, blankState, isAvailable, capabilitiesOf, filesOf, TIMING, Stale };
