// One Durable Object per account, holding everything about it in its own SQLite database: the account row, its
// sessions and its records. The Worker has already checked every input; this object checks secrets, keeps the
// sequence numbers and counters, and decides what gets stored.
//
// Methods are called over RPC and return { status, body } for the Worker to send. They first await every hash they
// need and then do all their reading and writing in one synchronous stretch, so no other call can slip in between a
// check and the write that depends on it.

import { DurableObject } from 'cloudflare:workers';
import { blob, randomBytes, sameBytes, sha256, toBase64url, utf8 } from './bytes.js';
import { EXPIRE_MIN_DAYS, expiryDays, registryObject, workspaceObject } from './config.js';
import { postable, pushOrigins, pushSwitch, sendWake } from './webpush.js';

// Ten failed sign-ins or recovery attempts within 15 minutes lock the account for 15 minutes (PROTOCOL.md, login).
// The registry keeps that lock, per address and for addresses without an account too (lock.js); this object keeps it
// only on a server without the registry. A session that sends a wrong password ten times is locked the same way, on
// its own (PROTOCOL.md, POST /v1/password).
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60 * 1000;
const LOCK_TIME = 15 * 60 * 1000;
// A device's last-seen time only needs to be roughly right, and writing it on every call would double the writes.
const SEEN_INTERVAL = 60 * 60 * 1000;
// Every sign-in adds a session. A device that keeps signing in without signing out would otherwise grow the list
// forever, so past this many the one seen longest ago goes.
const MAX_SESSIONS = 100;
// A pull stops early once it holds this much data and says there is more, so one page stays a size a phone can take.
const PAGE_BYTES = 4 * 1024 * 1024;
// An account can change its booking page's handle at most this often (PROTOCOL.md, Handles and meeting types).
export const HANDLE_CHANGES = 3;
export const HANDLE_WINDOW = 30 * 24 * 60 * 60 * 1000;

// A session's own count of wrong passwords and its lock, for the signed-in calls that ask for the password again.
const SESSION_LOCK = ['failures', 'failedAt', 'lockedUntil'].map((name) => `${name} INTEGER NOT NULL DEFAULT 0`);
// A session's push endpoint for team chat's wakes (webpush.js; WORKSPACES.md, Push wakes): the address its push
// service gave the phone, the phone's public key and auth secret, when it was registered, and since when every wake to
// it has failed. They go with the session, so signing out, being signed out from another device and every other end of
// a session on the server take them along.
const SESSION_WAKE = ['wakeEndpoint TEXT', 'wakeKey BLOB', 'wakeAuth BLOB', 'wakeAt INTEGER', 'wakeFailedSince INTEGER'];
// What clears a session's push registration.
const CLEAR_WAKE = 'wakeEndpoint = NULL, wakeKey = NULL, wakeAuth = NULL, wakeAt = NULL, wakeFailedSince = NULL';
// Sessions of one account that may have a push endpoint at once. Registering one more clears the oldest.
const WAKE_ENDPOINTS = 10;
// A session gets one wake at once, then at most one more per window: activity in the window after a wake sends a
// single wake when it ends. Tests shorten it on the object (pushWindow).
const PUSH_WINDOW = 15 * 1000;
// An endpoint whose wakes have all failed for this long goes, as after a phone signed out without a connection and let
// go of its push registration, which some push services answer with an error that isn't 404 or 410.
const WAKE_FAILING = 7 * 24 * 60 * 60 * 1000;
// What one session may register: a burst of this many, then one more a minute (PUT /v1/push-endpoint). Tests that
// try many addresses raise the burst on the object (wakePutBurst).
const WAKE_PUTS = 6;
const WAKE_PUT_EVERY = 60 * 1000;

// The booking page's handle, for accounts that ever had one. changes is a JSON list of when it was changed.
const BOOKING_TABLE = `
  CREATE TABLE IF NOT EXISTS booking (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    handle TEXT,
    changes TEXT NOT NULL DEFAULT '[]'
  );
`;

// What an account needs once it uses a workspace, made on first use (WORKSPACES.md, Accounts and external workspaces).
// identity: the incarnation, a random id for this one lifetime of the account. A workspace knows its members by it, so
// an account made again at the same address is nobody there. class says what the account may do: every account today
// is 'full'. workspaces: the workspaces this account is or was a member of, which is what tells them when it is
// deleted. version goes up each time a reference is recorded, so giving one back never takes a newer one with it.
// former marks a workspace the account left: it no longer shows in the account's list, and still hears of a deletion,
// so the name the account had there goes too.
const WORKSPACE_TABLES = `
  CREATE TABLE IF NOT EXISTS identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    incarnation TEXT NOT NULL,
    class TEXT NOT NULL,
    versions INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    created INTEGER NOT NULL DEFAULT 0,
    former INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL,
    addedAt INTEGER NOT NULL
  );
`;
// What is left of a deleted account that was in workspaces: which ones still have to hear that its incarnation is
// gone. No address, no credentials and no records. An address can be deleted, made again and deleted again before a
// workspace answers, so the list is kept per incarnation and outlives every one of those accounts.
const CLEANUP_TABLE = `
  CREATE TABLE IF NOT EXISTS cleanup (
    workspace TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace, incarnation)
  );
`;
// An account made while EXPIRE_UNUSED_DAYS is set is checked that many days later, and deleted when it was never used
// (expireUnused; README.md, "Accounts that are never used"). at: when its check is due. The row goes when a device
// signs in or connects after the sign-up day, or at the check. Records, workspaces and a booking page are looked up at
// the check itself, because each of them stays once it was there.
const EXPIRY_TABLE = 'CREATE TABLE IF NOT EXISTS expiry (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)';
// What is left of an account the check deleted, until its place under MAX_ACCOUNTS is back (#finishExpiry): the key
// the registry gives it back under, whether it did, and how often asking it failed, for the wait before the next try.
// No address and nothing else of the account.
const EXPIRED_TABLE =
  'CREATE TABLE IF NOT EXISTS expired (id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL, released INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)';
const DAY = 24 * 60 * 60 * 1000;
// Every table a living account can have. Deleting an account that was in workspaces drops these and keeps cleanup.
const LIVE_TABLES = ['account', 'sessions', 'records', 'meta', 'booking', 'identity', 'workspaces', 'expiry'];
const CLEANUP_RETRY = 60 * 1000;
const CLEANUP_RETRY_MAX = 60 * 60 * 1000;
const CLEANUP_LATE = 24 * 60 * 60 * 1000;
// A reference this young may belong to a join that hasn't committed yet, so listing doesn't drop it.
const REFERENCE_GRACE = 5 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    email TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    kdf TEXT NOT NULL,
    salt BLOB NOT NULL,
    authVerifier BLOB NOT NULL,
    wrappedKey BLOB NOT NULL,
    recoveryVerifier BLOB NOT NULL,
    recoveryWrappedKey BLOB NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    failedAt INTEGER NOT NULL DEFAULT 0,
    lockedUntil INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    tokenHash BLOB NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    lastSeenAt INTEGER NOT NULL,
    ${SESSION_LOCK.join(',\n    ')},
    ${SESSION_WAKE.join(',\n    ')}
  );
  CREATE TABLE records (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    data BLOB,
    size INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX records_seq ON records (seq);
  CREATE TABLE meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seq INTEGER NOT NULL,
    records INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    tombstones INTEGER NOT NULL DEFAULT 0
  );
  ${BOOKING_TABLE}
`;

class QuotaExceeded extends Error {}

function reply(status, body = null, headers) {
  return { status, body, headers };
}

function failure(status, error, message, headers) {
  return reply(status, { error, message }, headers);
}

const UNAUTHORIZED = failure(401, 'unauthorized', 'Sign in again.');

// A session made in a browser, known by its device platform (PROTOCOL.md, Sessions made in a browser). Rukoo in the
// browser keeps the token in the site's local storage, where any script running on the site can read it, and uses
// only the account and team chat. So such a session can't reach the records or the booking page. The platform is
// written once, when the session is made, so what a session may do never changes.
const BROWSER = 'web';
const BROWSER_SESSION = failure(403, 'browser_session', "A session made in a browser can't use this. Use the Rukoo app.");

function locked(until, now) {
  return failure(429, 'locked', 'Too many failed attempts. Try again later.', {
    'retry-after': String(Math.ceil((until - now) / 1000))
  });
}

export class Account extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Tables are made at sign-up, not here: prelogin and failed sign-ins reach objects for addresses without an
    // account, and those objects should stay empty so they leave nothing behind.
    this.present =
      this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account'").toArray().length > 0;
    this.identity = null;
    this.cleaning = false;
    // Push wakes in memory: when each session last got one, the one each still waits to send and the workspaces it is
    // for (wake), and each session's allowance for registering (checkWakeSession).
    this.pushWindow = PUSH_WINDOW;
    this.wakeSent = new Map();
    this.wakeLater = new Map();
    this.wakeWorkspaces = new Map();
    this.wakePuts = new Map();
    this.wakePutBurst = WAKE_PUTS;
    if (this.present) this.migrate();
    this.expiring = this.present && this.#has('expiry');
    // A list of workspaces to tell with no alarm to work through it would wait forever. That can happen when an alarm
    // failed so often that the platform gave up on it. An object that starts with such a list has an alarm again
    // before it answers anything. The same goes for an account's check for use, and for what an expired one left.
    if (this.#has('cleanup') || this.expiring || this.#has('expired')) ctx.blockConcurrencyWhile(() => this.#rearm());
  }

  async #rearm() {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    const waiting = this.#has('cleanup') && this.sql.exec('SELECT COUNT(*) AS n FROM cleanup').one().n > 0;
    if (waiting || this.#has('expired')) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY);
    else if (this.expiring) await this.ctx.storage.setAlarm(this.#expiryAt());
  }

  #expiryAt() {
    return this.sql.exec('SELECT at FROM expiry WHERE id = 1').toArray()[0]?.at ?? null;
  }

  // Brings an account made by an older version of the server up to the current tables. Each step checks for itself
  // whether it is needed, so running it again changes nothing.
  migrate() {
    const columns = (table) =>
      new Set(this.sql.exec('SELECT name FROM pragma_table_info(?)', table).toArray().map((c) => c.name));
    if (!columns('meta').has('tombstones')) {
      // The first version didn't count tombstones; count the ones there are.
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('ALTER TABLE meta ADD COLUMN tombstones INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('UPDATE meta SET tombstones = (SELECT COUNT(*) FROM records WHERE data IS NULL) WHERE id = 1');
      });
    }
    if (!columns('sessions').has('lockedUntil')) {
      // Wrong passwords on signed-in calls counted toward the account's lock before; each session starts at none.
      this.ctx.storage.transactionSync(() => {
        for (const column of SESSION_LOCK) this.sql.exec(`ALTER TABLE sessions ADD COLUMN ${column}`);
      });
    }
    const sessionColumns = columns('sessions');
    const missing = SESSION_WAKE.filter((column) => !sessionColumns.has(column.split(' ')[0]));
    if (missing.length) {
      // Push wakes came later; no session had an endpoint before.
      this.ctx.storage.transactionSync(() => {
        for (const column of missing) this.sql.exec(`ALTER TABLE sessions ADD COLUMN ${column}`);
      });
    }
    // Booking pages came later; accounts from before have no handle yet.
    this.sql.exec(BOOKING_TABLE);
  }

  // Whether this object holds an account. A Booking object asks once a day, so a page whose account was deleted
  // doesn't outlive it by more than a day. Asking leaves an empty object empty.
  async exists() {
    return this.present;
  }

  // Who is asking, for the booking page routes: the account's routing name (the token's first part, which is how the
  // Worker found this object), its handle, the caller's session id, how many handle changes the last 30 days used,
  // and the names of its sessions, for showing which device handles bookings. 401 only for a dead session.
  // passwordLock is the 429 to send while this session's password checks are locked (#withPassword), else null; only
  // DELETE /v1/booking uses it.
  async bookingAuth(token) {
    return this.#fromApp(token, (session, now) => {
      const row = this.#booking();
      const devices = {};
      for (const d of this.sql.exec('SELECT id, name FROM sessions')) devices[d.id] = d.name;
      return {
        status: 200,
        body: null,
        name: token.slice(0, token.indexOf('.')),
        handle: row.handle,
        deviceId: session.id,
        changes: recentChanges(row.changes, now).length,
        devices,
        passwordLock: session.lockedUntil > now ? locked(session.lockedUntil, now) : null
      };
    });
  }

  // Sets the account's one handle. Taking a first handle, or giving it up (null), isn't a change; replacing one is,
  // and the fourth within 30 days is refused.
  async bookingSetHandle(token, handle) {
    return this.#fromApp(token, (session, now) => {
      // A booking page is use, for good, whatever becomes of the page (expireUnused).
      if (handle && this.expiring) this.#endExpiry();
      const row = this.#booking();
      const changes = recentChanges(row.changes, now);
      if (handle === row.handle) return reply(200, { handle, changes: changes.length });
      if (row.handle && handle) {
        if (changes.length >= HANDLE_CHANGES) {
          return failure(409, 'handle_changes', 'This account changed its handle 3 times in the last 30 days.');
        }
        changes.push(now);
      }
      this.sql.exec(
        'INSERT INTO booking (id, handle, changes) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET handle = excluded.handle, changes = excluded.changes',
        handle,
        JSON.stringify(changes)
      );
      return reply(200, { handle, changes: changes.length });
    });
  }

  // Who a session is, for the workspace routes: the account's incarnation and class, and the session's id. The first
  // call gives the account its incarnation. 401 for a dead session.
  async principal(token) {
    return this.#signedIn(token, (session) => ({
      status: 200,
      body: null,
      ...this.#identity(),
      session: session.id,
      name: token.slice(0, token.indexOf('.'))
    }));
  }

  // Records that this account may be a member of a workspace, before the workspace makes it one, and answers with the
  // reference's version. created: the account is making the workspace, of which it may make max. most: how many
  // workspaces an account may be in at once.
  async addWorkspace(token, id, { created = false, max = 0, most = 0 } = {}) {
    return this.#signedIn(token, (session, now) => {
      // Making or joining a workspace is use, for good, also once the workspace is deleted and its reference goes
      // (expireUnused).
      if (this.expiring) this.#endExpiry();
      const identity = this.#identity();
      if (created && max > 0 && this.sql.exec('SELECT COUNT(*) AS n FROM workspaces WHERE created = 1').one().n >= max) {
        return failure(403, 'workspace_limit', `One account can make ${max} workspaces on this server.`);
      }
      const others = this.sql.exec('SELECT COUNT(*) AS n FROM workspaces WHERE former = 0 AND id != ?', id).one().n;
      if (most > 0 && others >= most) {
        return failure(403, 'workspace_limit', `One account can be in ${most} workspaces on this server.`);
      }
      const version = this.sql.exec('UPDATE identity SET versions = versions + 1 WHERE id = 1 RETURNING versions').one().versions;
      this.sql.exec(
        `INSERT INTO workspaces (id, created, former, version, addedAt) VALUES (?, ?, 0, ?, ?)
         ON CONFLICT (id) DO UPDATE SET created = MAX(created, excluded.created), former = 0,
           version = excluded.version, addedAt = excluded.addedAt`,
        id,
        created ? 1 : 0,
        version,
        now
      );
      return { status: 200, body: null, ...identity, ref: version };
    });
  }

  // The workspaces this account has a reference to and hasn't left, and, marked former, the ones it made and left:
  // those count against the limit on making workspaces until the workspace is gone. stale says which are old enough to
  // give back when their workspace doesn't know the account.
  async workspaces(token) {
    return this.#signedIn(token, (session, now) => {
      const identity = this.#identity();
      const list = this.sql
        .exec('SELECT id, version, addedAt, former FROM workspaces WHERE former = 0 OR created = 1 ORDER BY addedAt, id')
        .toArray()
        .map((row) => ({
          id: row.id,
          version: row.version,
          stale: now - row.addedAt > REFERENCE_GRACE,
          former: row.former === 1
        }));
      return { status: 200, body: null, ...identity, workspaces: list };
    });
  }

  // Gives a reference back: the workspace never made the account a member. Called by the Worker, never by a client.
  // Only the reference with this version goes, so one recorded since, by a join that did succeed, stays. The
  // incarnation must be this account's, so a reference of an account made again at the same address is left alone.
  async dropWorkspace(incarnation, id, version) {
    if (this.#knownIdentity()?.incarnation !== incarnation) return;
    this.sql.exec('DELETE FROM workspaces WHERE id = ? AND version = ?', id, version);
  }

  // The member left the workspace or was removed from it. The reference stays, out of the account's list, so the
  // workspace still hears when the account is deleted.
  async leftWorkspace(incarnation, id, version) {
    if (this.#knownIdentity()?.incarnation !== incarnation) return;
    this.sql.exec('UPDATE workspaces SET former = 1 WHERE id = ? AND version = ?', id, version);
  }

  // Whether a session of this incarnation still exists, for a workspace about to open a socket for it.
  async session(incarnation, id) {
    if (this.#knownIdentity()?.incarnation !== incarnation) return false;
    return this.sql.exec('SELECT 1 FROM sessions WHERE id = ?', id).toArray().length > 0;
  }

  // ---- Push wakes (webpush.js) ----

  // Before PUT /v1/push-endpoint does any work: 204 for a live session within its allowance, a burst of WAKE_PUTS and
  // then one a minute, else 429 with Retry-After, or 401. setWakeEndpoint checks the session again where it writes.
  async checkWakeSession(token) {
    return this.#signedIn(token, (session, now) => {
      const held = this.wakePuts.get(session.id) ?? { tokens: this.wakePutBurst, at: now };
      const tokens = Math.min(this.wakePutBurst, held.tokens + (now - held.at) / WAKE_PUT_EVERY);
      if (tokens < 1) {
        this.wakePuts.set(session.id, { tokens, at: now });
        const wait = Math.ceil(((1 - tokens) * WAKE_PUT_EVERY) / 1000);
        return failure(429, 'rate_limited', 'Too many push registrations. Try again shortly.', { 'retry-after': String(wait) });
      }
      this.wakePuts.set(session.id, { tokens: tokens - 1, at: now });
      return reply(204);
    });
  }

  // PUT /v1/push-endpoint: this session's push endpoint, which the Worker checked. It replaces the session's earlier
  // one. Another session of this account with the same endpoint lets go of it, so a phone that signed in again doesn't
  // get every wake twice, and past WAKE_ENDPOINTS the session that registered longest ago loses its own.
  async setWakeEndpoint(token, { endpoint, p256dh, auth }) {
    return this.#signedIn(token, (session, now) => {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`UPDATE sessions SET ${CLEAR_WAKE} WHERE wakeEndpoint = ? AND id != ?`, endpoint, session.id);
        this.sql.exec(
          'UPDATE sessions SET wakeEndpoint = ?, wakeKey = ?, wakeAuth = ?, wakeAt = ?, wakeFailedSince = NULL WHERE id = ?',
          endpoint,
          blob(p256dh),
          blob(auth),
          now,
          session.id
        );
        this.sql.exec(
          `UPDATE sessions SET ${CLEAR_WAKE} WHERE id IN (
             SELECT id FROM sessions WHERE wakeEndpoint IS NOT NULL ORDER BY wakeAt DESC, id LIMIT -1 OFFSET ?)`,
          WAKE_ENDPOINTS
        );
      });
      return reply(204);
    });
  }

  // DELETE /v1/push-endpoint: this session gets no more wakes. 204 also when it had none, and while push wakes are off.
  async clearWakeEndpoint(token) {
    return this.#signedIn(token, (session) => {
      this.sql.exec(`UPDATE sessions SET ${CLEAR_WAKE} WHERE id = ?`, session.id);
      return reply(204);
    });
  }

  // A workspace has something for this account that notifies (workspace.js, #post): a wake goes to each of its
  // sessions with a push endpoint, apart from those in live, which have a working socket to that workspace and heard
  // of it there. Returns how many sessions got one at once; a session woken within the last pushWindow gets one when
  // the window ends instead, one for everything that came in it, naming every workspace it came from. The incarnation
  // must be this account's, so an account made again at the same address hears nothing of the old one's workspaces.
  async wake(incarnation, live = [], workspace = null) {
    if (!pushSwitch(this.env) || this.#knownIdentity()?.incarnation !== incarnation) return 0;
    const skip = new Set(live);
    const now = Date.now();
    const sends = [];
    for (const row of this.sql.exec('SELECT id FROM sessions WHERE wakeEndpoint IS NOT NULL').toArray()) {
      if (skip.has(row.id)) continue;
      const since = now - (this.wakeSent.get(row.id) ?? -Infinity);
      if (since >= this.pushWindow && !this.wakeLater.has(row.id)) {
        this.wakeSent.set(row.id, now);
        sends.push(this.#sendWake(row.id, workspace ? [workspace] : []));
        continue;
      }
      const waiting = this.wakeWorkspaces.get(row.id) ?? new Set();
      if (workspace) waiting.add(workspace);
      this.wakeWorkspaces.set(row.id, waiting);
      if (this.wakeLater.has(row.id)) continue;
      // The wake at the end of the window, which waitUntil keeps this object alive for.
      const later = new Promise((resolve) => {
        setTimeout(() => {
          this.wakeLater.delete(row.id);
          const workspaces = [...(this.wakeWorkspaces.get(row.id) ?? [])];
          this.wakeWorkspaces.delete(row.id);
          this.wakeSent.set(row.id, Date.now());
          this.#sendWake(row.id, workspaces)
            .catch((err) => console.error('A push wake failed:', err?.message || err))
            .finally(resolve);
        }, Math.max(0, this.pushWindow - since));
      });
      this.wakeLater.set(row.id, later);
      this.ctx.waitUntil?.(later);
    }
    await Promise.all(sends);
    return sends.length;
  }

  // Sends one wake to a session's endpoint as it is now. The push service's 404 or 410 means the registration is gone,
  // so the endpoint goes too, unless the session registered another meanwhile. Any other failure is logged without the
  // endpoint, and the next wake tries again; an endpoint whose wakes have all failed for WAKE_FAILING goes.
  async #sendWake(id, workspaces) {
    const row = this.#wakeTarget(id);
    if (!row) return;
    if (!postable(row.wakeEndpoint, pushOrigins(this.env))) {
      this.#dropWakeEndpoint(id, row);
      return;
    }
    let status = 0;
    try {
      status = await sendWake(this.env, { endpoint: row.wakeEndpoint, p256dh: row.wakeKey, auth: row.wakeAuth }, workspaces);
    } catch (err) {
      console.error('A push wake could not be sent:', err?.name || 'Error', err?.message || '');
    }
    if (status === 404 || status === 410) return this.#dropWakeEndpoint(id, row);
    if (status >= 200 && status < 300) return this.#wakeWorked(id, row, true);
    if (status) console.error(`A push service answered a wake with ${status}.`);
    this.#wakeWorked(id, row, false);
  }

  // Notes whether a wake to a registration worked. The first failure starts the clock; WAKE_FAILING later, with every
  // wake in between failed too, the registration goes.
  #wakeWorked(id, row, ok) {
    if (!this.present || !this.#has('sessions')) return;
    const same = 'id = ? AND wakeEndpoint = ? AND wakeKey = ? AND wakeAuth = ?';
    const args = [id, row.wakeEndpoint, row.wakeKey, row.wakeAuth];
    if (ok) {
      if (row.wakeFailedSince !== null) this.sql.exec(`UPDATE sessions SET wakeFailedSince = NULL WHERE ${same}`, ...args);
      return;
    }
    const now = Date.now();
    if (row.wakeFailedSince === null) this.sql.exec(`UPDATE sessions SET wakeFailedSince = ? WHERE ${same}`, now, ...args);
    else if (now - row.wakeFailedSince >= WAKE_FAILING) this.#dropWakeEndpoint(id, row);
  }

  // The endpoint, keys and failure clock of a session, or null: none registered, or the session or the account is gone.
  #wakeTarget(id) {
    if (!this.present || !this.#has('sessions')) return null;
    const row = this.sql.exec('SELECT wakeEndpoint, wakeKey, wakeAuth, wakeFailedSince FROM sessions WHERE id = ?', id).toArray()[0];
    return row?.wakeEndpoint ? row : null;
  }

  // Clears a session's registration when it is still the one in row, the same endpoint and keys: one the session made
  // meanwhile stays.
  #dropWakeEndpoint(id, row) {
    if (!this.present || !this.#has('sessions')) return;
    this.sql.exec(
      `UPDATE sessions SET ${CLEAR_WAKE} WHERE id = ? AND wakeEndpoint = ? AND wakeKey = ? AND wakeAuth = ?`,
      id,
      row.wakeEndpoint,
      row.wakeKey,
      row.wakeAuth
    );
  }

  // Tells the workspaces a deleted account was in, and tries again later for the ones that didn't answer. Checks
  // whether an account made while EXPIRE_UNUSED_DAYS was set was ever used, with the setting as it is now.
  async alarm() {
    await this.#cleanup();
    await this.#finishExpiry();
    await this.expireUnused(expiryDays(this.env));
  }

  // Deletes this account when it is at least `days` days old (EXPIRE_MIN_DAYS at least) and was never used: no records
  // stored, ever; no workspace it made, joined or tried to join, ever; no booking page, ever; and no device that signed
  // in or connected after the day it was made. The alarm calls it with EXPIRE_UNUSED_DAYS, and 0 means the setting was
  // turned off: the account stays and isn't checked again. The decision and the account's end are one transaction with
  // nothing awaited before it, so a request that would have used the account either comes first and keeps it, or finds
  // no account. What the transaction leaves is the place under MAX_ACCOUNTS still to give back (#finishExpiry), which
  // the alarm finishes when it fails now, so the place goes back once and the account never comes back.
  // Returns what it did: 'deleted', 'kept' (used, or the setting off), 'waiting' or 'none'.
  async expireUnused(days) {
    if (!this.present || !this.#has('expiry')) return 'none';
    const now = Date.now();
    const { createdAt } = this.#account();
    if (!(days > 0)) {
      this.#endExpiry();
      return 'kept';
    }
    days = Math.max(days, EXPIRE_MIN_DAYS);
    // An earlier account at this address still has workspaces to tell, or a place to give back; #cleanup and
    // #finishExpiry set the check's alarm again after.
    if (this.#has('cleanup') || this.#has('expired')) return 'waiting';
    const due = createdAt + days * DAY;
    if (now < due) {
      this.sql.exec('UPDATE expiry SET at = ? WHERE id = 1', due);
      await this.ctx.storage.setAlarm(due);
      return 'waiting';
    }
    if (this.#everUsed(createdAt)) {
      this.#endExpiry();
      return 'kept';
    }
    // The alarm that finishes the job if this run doesn't, set in the same stretch as the transaction, as deleteAccount
    // does. It never had a booking page or a workspace, so nothing else has anything of it.
    const armed = this.ctx.storage.setAlarm(now + CLEANUP_RETRY);
    armed.catch(() => {});
    this.ctx.storage.transactionSync(() => {
      for (const table of LIVE_TABLES) this.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      this.sql.exec(EXPIRED_TABLE);
      this.sql.exec('INSERT INTO expired (id, key, released) VALUES (1, ?, 0)', toBase64url(randomBytes(16)));
    });
    this.present = false;
    this.identity = null;
    this.expiring = false;
    await armed;
    await this.#finishExpiry();
    return 'deleted';
  }

  // What is left of an expired account: its place to give back, as DELETE /v1/account gives it back, and then the rest
  // to wipe. The registry gives back a place once per key (Registry.releaseOnce), a random key made with the decision,
  // and this object notes that it did, so a run that fails halfway never gives it back twice. When the registry can't
  // be reached, the alarm tries again, waiting longer each time up to an hour, as #cleanup does: nobody may ever ask
  // this address again, and the place would be lost for good. An account made at this address since, or the list of
  // workspaces such an account left behind, keeps everything but this.
  async #finishExpiry() {
    const row = this.#has('expired') ? this.sql.exec('SELECT * FROM expired WHERE id = 1').toArray()[0] : null;
    if (!row) return;
    if (!row.released) {
      try {
        await registryObject(this.env)?.releaseOnce(row.key);
      } catch (err) {
        // A marker from before the column was added gets it now.
        if (!('attempts' in row)) this.sql.exec('ALTER TABLE expired ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
        const attempts = (row.attempts ?? 0) + 1;
        this.sql.exec('UPDATE expired SET attempts = ? WHERE id = 1', attempts);
        await this.ctx.storage.setAlarm(Date.now() + Math.min(CLEANUP_RETRY * 2 ** Math.min(attempts - 1, 10), CLEANUP_RETRY_MAX));
        console.error('Giving back the place of an expired account failed; its alarm tries again.', err?.message || err);
        return;
      }
      this.sql.exec('UPDATE expired SET released = 1 WHERE id = 1');
    }
    if (this.present || this.#has('cleanup')) this.sql.exec('DROP TABLE expired');
    else await this.ctx.storage.deleteAll();
  }

  // Whether this account shows any use, for expireUnused. Each of these stays once it happened: seq never goes down,
  // a workspace reference stays after leaving (former), and the booking row stays once a handle was taken.
  #everUsed(createdAt) {
    if (this.#meta().seq > 0) return true;
    if (this.#has('workspaces') && this.sql.exec('SELECT COUNT(*) AS n FROM workspaces').one().n > 0) return true;
    if (this.sql.exec('SELECT COUNT(*) AS n FROM booking').one().n > 0) return true;
    const seen = this.sql.exec('SELECT MAX(MAX(createdAt, lastSeenAt)) AS t FROM sessions').one().t;
    return seen !== null && seen > createdAt + DAY;
  }

  // A sign-in, or a device that connects, after the sign-up day: the account is used, and its check goes.
  #markUsed(now) {
    if (!this.expiring) return;
    if (now - this.#account().createdAt > DAY) this.#endExpiry();
  }

  #endExpiry() {
    this.sql.exec('DROP TABLE IF EXISTS expiry');
    this.expiring = false;
  }

  async prelogin() {
    if (!this.present) return reply(200, null);
    const { kdf, salt } = this.#account();
    return reply(200, { kdf: JSON.parse(kdf), salt: toBase64url(new Uint8Array(salt)) });
  }

  // expireDays: EXPIRE_UNUSED_DAYS, which arms the check for use that many days from now (expireUnused); 0 arms none.
  async signup(name, input, limits, { expireDays = 0 } = {}) {
    const authVerifier = await sha256(input.authKey);
    const recoveryVerifier = await sha256(input.recoveryAuth);
    const token = newToken(name);
    const tokenHash = await sha256(utf8(token));
    if (this.present) return failure(409, 'exists', 'This address already has an account.');
    const now = Date.now();
    const expireAt = expireDays > 0 ? now + expireDays * DAY : null;
    // Set in the same stretch as the account's rows, as deleteAccount does with its alarm. An earlier account at this
    // address that still has workspaces to tell, or a place to give back, keeps its alarm, which sets this one when it
    // is done.
    let armed = null;
    if (expireAt !== null && !this.#has('cleanup') && !this.#has('expired')) {
      armed = this.ctx.storage.setAlarm(expireAt);
      armed.catch(() => {});
    }
    let sessionId;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(SCHEMA);
      this.sql.exec(
        `INSERT INTO account (id, email, createdAt, kdf, salt, authVerifier, wrappedKey, recoveryVerifier, recoveryWrappedKey)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.email,
        now,
        JSON.stringify(input.kdf),
        blob(input.salt),
        blob(authVerifier),
        blob(input.wrappedKey),
        blob(recoveryVerifier),
        blob(input.recoveryWrappedKey)
      );
      this.sql.exec('INSERT INTO meta (id, seq, records, bytes, tombstones) VALUES (1, 0, 0, 0, 0)');
      sessionId = this.#addSession(tokenHash, input.device, now);
      if (expireAt !== null) {
        this.sql.exec(EXPIRY_TABLE);
        this.sql.exec('INSERT INTO expiry (id, at) VALUES (1, ?)', expireAt);
      }
    });
    this.present = true;
    this.expiring = expireAt !== null;
    // An alarm that couldn't be set leaves the row, and the constructor sets it the next time the object starts.
    if (armed) await armed.catch((err) => console.error('Setting the check for an unused account failed:', err?.message || err));
    return reply(201, { token, account: this.#info(sessionId, limits) });
  }

  // unlocked: the Worker keeps the lock on this address itself (lock.js), or checked a code sent to the address
  // (codes.js), which lets this attempt past the lock. Either way this object leaves its own lock and count of
  // failures as they are. They are only used on a server without the registry, which has nowhere else to keep them.
  async login(name, input, limits, { unlocked = false } = {}) {
    const hash = await sha256(input.authKey);
    const token = newToken(name);
    const tokenHash = await sha256(utf8(token));
    if (!this.present) return failure(401, 'unauthorized', 'The email address or password is wrong.');
    const now = Date.now();
    const check = this.#check('authVerifier', hash, now, unlocked);
    if (check.result === 'locked') return locked(check.lockedUntil, now);
    if (check.result === 'wrong') return failure(401, 'unauthorized', 'The email address or password is wrong.');
    this.#markUsed(now);
    const sessionId = this.ctx.storage.transactionSync(() => this.#addSession(tokenHash, input.device, now));
    const { wrappedKey } = this.#account();
    return reply(200, {
      token,
      wrappedKey: toBase64url(new Uint8Array(wrappedKey)),
      account: this.#info(sessionId, limits)
    });
  }

  async logout(token) {
    return this.#signedIn(token, (session) => {
      this.sql.exec('DELETE FROM sessions WHERE id = ?', session.id);
      return reply(204);
    });
  }

  async account(token, limits) {
    return this.#signedIn(token, (session) => reply(200, this.#info(session.id, limits)));
  }

  async revoke(token, deviceId) {
    return this.#signedIn(token, () => {
      const { rowsWritten } = this.sql.exec('DELETE FROM sessions WHERE id = ?', deviceId);
      return rowsWritten > 0 ? reply(204) : failure(404, 'not_found', 'There is no device with this id.');
    });
  }

  async changePassword(token, input) {
    const hash = await sha256(input.authKey);
    const newVerifier = await sha256(input.newAuthKey);
    return this.#signedIn(token, (session, now) =>
      this.#withPassword(session, hash, now, () => {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            'UPDATE account SET kdf = ?, salt = ?, authVerifier = ?, wrappedKey = ? WHERE id = 1',
            JSON.stringify(input.kdf),
            blob(input.salt),
            blob(newVerifier),
            blob(input.wrappedKey)
          );
          this.sql.exec('DELETE FROM sessions WHERE id != ?', session.id);
        });
        return reply(204);
      })
    );
  }

  async replaceRecovery(token, input) {
    const hash = await sha256(input.authKey);
    const recoveryVerifier = await sha256(input.recoveryAuth);
    return this.#signedIn(token, (session, now) =>
      this.#withPassword(session, hash, now, () => {
        this.sql.exec(
          'UPDATE account SET recoveryVerifier = ?, recoveryWrappedKey = ? WHERE id = 1',
          blob(recoveryVerifier),
          blob(input.recoveryWrappedKey)
        );
        return reply(204);
      })
    );
  }

  // Checks the password and changes nothing but this session's count (PROTOCOL.md, POST /v1/password/check). A device
  // asks before it deletes what doesn't come back, such as the booking page, ahead of DELETE /v1/account: this counts
  // toward the same lock as that deletion, so the answer holds for it.
  async checkPassword(token, input) {
    const hash = await sha256(input.authKey);
    return this.#signedIn(token, (session, now) => this.#withPassword(session, hash, now, () => reply(204)));
  }

  async recoverStart(input, { unlocked = false } = {}) {
    const hash = await sha256(input.recoveryAuth);
    if (!this.present) return failure(401, 'unauthorized', 'The email address or recovery key is wrong.');
    const now = Date.now();
    const check = this.#check('recoveryVerifier', hash, now, unlocked);
    if (check.result === 'locked') return locked(check.lockedUntil, now);
    if (check.result === 'wrong') return failure(401, 'unauthorized', 'The email address or recovery key is wrong.');
    const { recoveryWrappedKey, kdf } = this.#account();
    return reply(200, { recoveryWrappedKey: toBase64url(new Uint8Array(recoveryWrappedKey)), kdf: JSON.parse(kdf) });
  }

  async recoverFinish(name, input, limits, { unlocked = false } = {}) {
    const hash = await sha256(input.recoveryAuth);
    const authVerifier = await sha256(input.authKey);
    const token = newToken(name);
    const tokenHash = await sha256(utf8(token));
    if (!this.present) return failure(401, 'unauthorized', 'The email address or recovery key is wrong.');
    const now = Date.now();
    const check = this.#check('recoveryVerifier', hash, now, unlocked);
    if (check.result === 'locked') return locked(check.lockedUntil, now);
    if (check.result === 'wrong') return failure(401, 'unauthorized', 'The email address or recovery key is wrong.');
    this.#markUsed(now);
    const sessionId = this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'UPDATE account SET kdf = ?, salt = ?, authVerifier = ?, wrappedKey = ? WHERE id = 1',
        JSON.stringify(input.kdf),
        blob(input.salt),
        blob(authVerifier),
        blob(input.wrappedKey)
      );
      this.sql.exec('DELETE FROM sessions');
      return this.#addSession(tokenHash, input.device, now);
    });
    return reply(200, { token, account: this.#info(sessionId, limits) });
  }

  async deleteAccount(token, input) {
    const hash = await sha256(input.authKey);
    // The account is gone from the moment the password checks out, before anything is awaited: a second delete
    // arriving meanwhile finds no account (401) instead of deleting it again, so the Worker gives its place under
    // MAX_ACCOUNTS back once. The booking handle is read in the same stretch and handed to the Worker, which wipes
    // the page afterwards (send() leaves the extra property out of the answer).
    let armed = null;
    const result = await this.#signedIn(token, (session, now) =>
      this.#withPassword(session, hash, now, () => {
        const { handle } = this.#booking();
        const references = this.#has('workspaces') ? this.sql.exec('SELECT id FROM workspaces').toArray() : [];
        // Workspaces an earlier account at this address was in, which haven't all answered yet, and the place under
        // MAX_ACCOUNTS of an earlier account that expired, which the registry hasn't taken back yet (#finishExpiry).
        const waiting = this.#has('cleanup') && this.sql.exec('SELECT COUNT(*) AS n FROM cleanup').one().n > 0;
        const cleanup = references.length > 0 || waiting || this.#has('expired');
        if (cleanup) {
          // An account that was in workspaces can't vanish in one step: each workspace still has to hear that its
          // incarnation is gone. Everything of the account goes now, in one transaction with the list of who to tell.
          // What an expired account left stays the same way, for the alarm to finish.
          // The alarm that works through the list is set in the same stretch, with nothing awaited in between, which
          // is how the platform stores a series of writes as one. Its documentation doesn't name alarms there, so
          // the constructor is the second safeguard: a list without an alarm gets one when the object next starts.
          armed = this.ctx.storage.setAlarm(now + CLEANUP_RETRY);
          armed.catch(() => {});
          const incarnation = this.#knownIdentity()?.incarnation;
          this.ctx.storage.transactionSync(() => {
            for (const table of LIVE_TABLES) this.sql.exec(`DROP TABLE IF EXISTS ${table}`);
            this.sql.exec(CLEANUP_TABLE);
            for (const { id } of references) {
              this.sql.exec(
                'INSERT OR IGNORE INTO cleanup (workspace, incarnation, createdAt) VALUES (?, ?, ?)',
                id,
                incarnation,
                now
              );
            }
          });
        }
        this.present = false;
        this.identity = null;
        this.expiring = false;
        return { ...reply(204), handle, cleanup };
      })
    );
    if (result.status !== 204) return result;
    if (result.cleanup) {
      // The workspaces are told right away, without this answer waiting for them: the Worker still has the booking
      // page to wipe and the account's place to give back. A workspace that doesn't answer now hears it from the
      // alarm.
      await armed;
      this.ctx.waitUntil(
        this.#cleanup().catch((err) => console.error('Telling workspaces about a deleted account failed:', err?.stack || err))
      );
      return result;
    }
    try {
      // deleteAll removes the whole SQLite database, so the object is as empty as one that never had an account.
      await this.ctx.storage.deleteAll();
    } catch (err) {
      this.present =
        this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account'").toArray().length > 0;
      throw err;
    }
    return result;
  }

  // Tells each workspace on the list that an incarnation is gone, and takes it off the list once it answered. When
  // the list is empty, what is left of the deleted account is wiped, unless the address has a new account by then:
  // that one keeps everything but the list. A failure outside the calls to workspaces, such as an alarm that can't
  // be set, is thrown: from alarm() that makes the platform run the alarm again.
  async #cleanup() {
    // One run at a time: the alarm can come due while the run a deletion started is still waiting for a workspace.
    if (this.cleaning || !this.#has('cleanup')) return;
    this.cleaning = true;
    try {
      const now = Date.now();
      for (const row of this.sql.exec('SELECT workspace, incarnation, createdAt FROM cleanup').toArray()) {
        try {
          await workspaceObject(this.env, row.workspace).retire(row.incarnation);
          this.sql.exec('DELETE FROM cleanup WHERE workspace = ? AND incarnation = ?', row.workspace, row.incarnation);
        } catch (err) {
          this.sql.exec(
            'UPDATE cleanup SET attempts = attempts + 1 WHERE workspace = ? AND incarnation = ?',
            row.workspace,
            row.incarnation
          );
          const late = now - row.createdAt > CLEANUP_LATE ? ' It has been waiting for more than a day.' : '';
          console.error(`A workspace has not heard that a deleted account is gone.${late}`, err?.message || err);
        }
      }
      // A deletion that came in while this waited may have added to the list, so it is read again.
      const left = this.sql.exec('SELECT COUNT(*) AS n, MIN(attempts) AS attempts FROM cleanup').one();
      if (left.n > 0) {
        const wait = Math.min(CLEANUP_RETRY * 2 ** Math.min(left.attempts, 10), CLEANUP_RETRY_MAX);
        await this.ctx.storage.setAlarm(Date.now() + wait);
        return;
      }
      // An account made again at this address may wait for its check for use, which waited for this list. An expired
      // account's place still to give back keeps the alarm going, and what is left of it, for #finishExpiry.
      const expired = this.#has('expired');
      if (expired) await this.ctx.storage.setAlarm(Date.now() + 1000);
      else if (this.present && this.expiring) await this.ctx.storage.setAlarm(Math.max(this.#expiryAt(), Date.now() + 1000));
      else await this.ctx.storage.deleteAlarm();
      if (this.present || expired) this.sql.exec('DROP TABLE cleanup');
      else await this.ctx.storage.deleteAll();
    } finally {
      this.cleaning = false;
    }
  }

  async pull(token, since, limit) {
    return this.#fromApp(token, () => {
      const rows = this.sql
        .exec('SELECT id, seq, data FROM records WHERE seq > ? ORDER BY seq LIMIT ?', since, limit + 1)
        .toArray();
      const records = [];
      let bytes = 0;
      for (const row of rows.slice(0, limit)) {
        if (records.length > 0 && bytes + (row.data?.byteLength ?? 0) > PAGE_BYTES) break;
        bytes += row.data?.byteLength ?? 0;
        records.push({
          id: row.id,
          seq: row.seq,
          data: row.data === null ? null : toBase64url(new Uint8Array(row.data))
        });
      }
      return reply(200, { records, seq: this.#meta().seq, more: records.length < rows.length });
    });
  }

  async push(token, items, limits) {
    return this.#fromApp(token, (session, now) => {
      try {
        return reply(
          200,
          this.ctx.storage.transactionSync(() => this.#store(items, limits, now))
        );
      } catch (err) {
        if (err instanceof QuotaExceeded) return failure(413, 'quota', 'This account is full.');
        throw err;
      }
    });
  }

  // Writes a push in one transaction. A delete keeps the row with its data cleared and a new seq, so devices that
  // pull later learn of it. Deleting what is already deleted, or was never stored, changes nothing and leaves no row.
  // The counters change in the same transaction, which keeps them exact without counting.
  #store(items, limits, now) {
    const start = this.#meta();
    let { seq, records, bytes, tombstones } = start;
    const results = [];
    for (const item of items) {
      const old = this.sql
        .exec('SELECT seq, size, data IS NOT NULL AS live FROM records WHERE id = ?', item.id)
        .toArray()[0];
      if (item.ifAbsent && old?.live) {
        results.push({ id: item.id, seq: old.seq, stored: false });
        continue;
      }
      if (!item.data && !old?.live) {
        results.push({ id: item.id, seq: old ? old.seq : seq, stored: true });
        continue;
      }
      seq += 1;
      if (old?.live) {
        records -= 1;
        bytes -= old.size;
      } else if (old) {
        tombstones -= 1;
      }
      const size = item.data ? item.data.byteLength : 0;
      if (item.data) {
        records += 1;
        bytes += size;
      } else {
        tombstones += 1;
      }
      this.sql.exec(
        `INSERT INTO records (id, seq, data, size, updatedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, data = excluded.data, size = excluded.size, updatedAt = excluded.updatedAt`,
        item.id,
        seq,
        item.data ? blob(item.data) : null,
        size,
        now
      );
      results.push({ id: item.id, seq, stored: true });
    }
    // Only a push that adds to an account over its limit is refused. One that was already over, for example after
    // the operator lowered a limit, can still delete and shrink records. Tombstones have a limit of their own, as many
    // as records: they take little room, but without a limit an account could grow them forever.
    const grows = (now, before, limit) => now > limit && now > before;
    if (
      grows(records, start.records, limits.records) ||
      grows(bytes, start.bytes, limits.bytes) ||
      grows(tombstones, start.tombstones, limits.records)
    ) {
      throw new QuotaExceeded();
    }
    this.sql.exec(
      'UPDATE meta SET seq = ?, records = ?, bytes = ?, tombstones = ? WHERE id = 1',
      seq,
      records,
      bytes,
      tombstones
    );
    return { results, seq };
  }

  // Runs fn with the session a token belongs to, or answers 401. Every session's hash is compared, without stopping
  // at a match, so the time taken says nothing about which tokens exist.
  async #signedIn(token, fn) {
    const hash = await sha256(utf8(token));
    if (!this.present) return UNAUTHORIZED;
    let session = null;
    for (const row of this.sql.exec('SELECT id, tokenHash, platform, lastSeenAt, failures, failedAt, lockedUntil FROM sessions')) {
      if (sameBytes(new Uint8Array(row.tokenHash), hash)) session = row;
    }
    if (!session) return UNAUTHORIZED;
    const now = Date.now();
    if (now - session.lastSeenAt >= SEEN_INTERVAL) {
      this.sql.exec('UPDATE sessions SET lastSeenAt = ? WHERE id = ?', now, session.id);
    }
    this.#markUsed(now);
    return fn(session, now);
  }

  // #signedIn for the routes only an app's session may use: the records and the booking page. A browser's session
  // gets 403 browser_session and changes nothing; a dead one still gets 401 first.
  async #fromApp(token, fn) {
    return this.#signedIn(token, (session, now) => (session.platform === BROWSER ? BROWSER_SESSION : fn(session, now)));
  }

  // For signed-in calls that ask for the password again. A wrong one is 403, not 401, so the app can tell it apart
  // from an ended session. These attempts count per session, not toward the account's lock: anyone who knows the
  // email address can lock that one, and the session already proves the device. A stolen session still gets only
  // ten guesses every 15 minutes, whatever other devices do: sign-ins leave its count and lock alone. While the lock
  // lasts, the session can't delete the booking page either (owner.js, deleteBooking).
  #withPassword(session, hash, now, fn) {
    const { authVerifier } = this.#account();
    const check = this.#attempt('sessions', session, sameBytes(new Uint8Array(authVerifier), hash), now);
    if (check.result === 'locked') return locked(check.lockedUntil, now);
    if (check.result === 'wrong') return failure(403, 'wrong_password', 'The password is wrong.');
    return fn();
  }

  // Compares a hash with the account's stored verifier and keeps the account's failure count, for sign-ins and
  // recovery. unlocked: a code proved the address, so the lock doesn't apply and nothing is counted.
  #check(column, hash, now, unlocked = false) {
    const account = this.#account();
    const right = sameBytes(new Uint8Array(account[column]), hash);
    if (unlocked) return { result: right ? 'ok' : 'wrong' };
    return this.#attempt('account', account, right, now);
  }

  // Counts one attempt in row's failure count, where row is the account or a session from table and right says
  // whether the secret matched. Returns { result, lockedUntil }, where result is 'ok', 'wrong' or 'locked'. The
  // attempt that reaches the limit already answers 'locked', since the lock is in force from then on.
  #attempt(table, row, right, now) {
    const set = (failures, failedAt, lockedUntil) =>
      this.sql.exec(
        `UPDATE ${table} SET failures = ?, failedAt = ?, lockedUntil = ? WHERE id = ?`,
        failures,
        failedAt,
        lockedUntil,
        row.id
      );
    if (row.lockedUntil > now) return { result: 'locked', lockedUntil: row.lockedUntil };
    if (right) {
      if (row.failures > 0) set(0, 0, row.lockedUntil);
      return { result: 'ok' };
    }
    const fresh = now - row.failedAt >= FAILURE_WINDOW;
    const failures = fresh ? 1 : row.failures + 1;
    if (failures >= MAX_FAILURES) {
      set(0, 0, now + LOCK_TIME);
      return { result: 'locked', lockedUntil: now + LOCK_TIME };
    }
    set(failures, fresh ? now : row.failedAt, row.lockedUntil);
    return { result: 'wrong' };
  }

  #addSession(tokenHash, device, now) {
    const id = toBase64url(randomBytes(16));
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM sessions').one().n;
    if (count >= MAX_SESSIONS) {
      this.sql.exec(
        'DELETE FROM sessions WHERE id IN (SELECT id FROM sessions ORDER BY lastSeenAt, createdAt LIMIT ?)',
        count - MAX_SESSIONS + 1
      );
    }
    this.sql.exec(
      'INSERT INTO sessions (id, tokenHash, name, platform, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      blob(tokenHash),
      device.name,
      device.platform,
      now,
      now
    );
    return id;
  }

  #account() {
    return this.sql.exec('SELECT * FROM account WHERE id = 1').one();
  }

  #meta() {
    return this.sql.exec('SELECT seq, records, bytes, tombstones FROM meta WHERE id = 1').one();
  }

  #booking() {
    return this.sql.exec('SELECT handle, changes FROM booking WHERE id = 1').toArray()[0] ?? { handle: null, changes: '[]' };
  }

  #has(table) {
    return this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length > 0;
  }

  // The incarnation and class of an account that has them, without making them.
  #knownIdentity() {
    if (!this.present || !this.#has('identity')) return null;
    return this.sql.exec('SELECT incarnation, class FROM identity WHERE id = 1').toArray()[0] ?? null;
  }

  // The account's incarnation and class, made the first time a workspace route asks. Every workspace request comes
  // through here, so the answer is kept in memory; deleting the account forgets it.
  #identity() {
    if (!this.identity) {
      this.sql.exec(WORKSPACE_TABLES);
      this.sql.exec(
        "INSERT OR IGNORE INTO identity (id, incarnation, class) VALUES (1, ?, 'full')",
        toBase64url(randomBytes(16))
      );
      const row = this.sql.exec('SELECT incarnation, class FROM identity WHERE id = 1').one();
      this.identity = { incarnation: row.incarnation, class: row.class };
    }
    return this.identity;
  }

  // What GET /v1/account returns, which sign-up, sign-in and recovery return too.
  #info(currentId, limits) {
    const account = this.#account();
    const meta = this.#meta();
    const devices = this.sql
      .exec('SELECT id, name, platform, createdAt, lastSeenAt FROM sessions ORDER BY createdAt, id')
      .toArray()
      .map((d) => ({ ...d, current: d.id === currentId }));
    // An account that never used a workspace has no incarnation yet, and reading the account doesn't make one.
    const identity = this.#has('identity')
      ? this.sql.exec('SELECT incarnation, class FROM identity WHERE id = 1').toArray()[0]
      : null;
    return {
      email: account.email,
      createdAt: account.createdAt,
      class: identity?.class ?? 'full',
      incarnation: identity?.incarnation ?? null,
      kdf: JSON.parse(account.kdf),
      usage: { records: meta.records, bytes: meta.bytes },
      limits,
      devices
    };
  }
}

// A token names its account, so the Worker can route it without a table of sessions; the random part is the secret.
function newToken(name) {
  return `${name}.${toBase64url(randomBytes(32))}`;
}

// The handle changes within the last 30 days.
function recentChanges(json, now) {
  let list = [];
  try {
    list = JSON.parse(json);
  } catch {
    list = [];
  }
  return Array.isArray(list) ? list.filter((t) => Number.isFinite(t) && now - t < HANDLE_WINDOW) : [];
}
