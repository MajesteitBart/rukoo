// How many accounts this server holds, so an operator can cap them (MAX_ACCOUNTS), and how often each invite code
// was used (INVITE_USES). With open sign-ups, the cap is what bounds the storage strangers can take: each account is
// limited on its own, but nothing else limits how many accounts there are. With invite codes, the uses keep one code
// from filling the cap. One object for the whole server, holding counts and hashes of invite codes. It also keeps a
// place per workspace, for MAX_WORKSPACES, and holds the installation id that tells this server apart from another
// one answering at the same address later (WORKSPACES.md, Conventions).
//
// It also keeps the codes sent by email (codes.js), the one thing here about people: hashes of their addresses, made
// with PEPPER, for as long as a code works and, for the limits on how many codes one address gets, a day after the
// last one. An alarm deletes them when that time is up.

import { DurableObject } from 'cloudflare:workers';
import { fromBase64url, randomBytes, sameBytes, toBase64url } from './bytes.js';
import { workspaceObject } from './config.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// codes: one row per code asked for, by the hash of its challenge, with the hash of the address it went to and the
// hash of the code, which also binds the purpose, the challenge and the address. sends: when codes went to an
// address in the last day, newest last, and when the row goes. code_hour: how many codes of each purpose the server
// handed out in the hour that started at hour * HOUR. Each purpose has its own count, so someone who uses up the
// sign-up codes of an hour doesn't keep owners of locked accounts from getting theirs.
const CODE_TABLES = `
  CREATE TABLE IF NOT EXISTS codes (
    challenge TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS code_sends (address TEXT PRIMARY KEY, times TEXT NOT NULL, until INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS code_hour (purpose TEXT PRIMARY KEY, hour INTEGER NOT NULL, count INTEGER NOT NULL);
`;

// A place taken for a workspace that was never confirmed made or called off is settled after this long, by asking
// the workspace.
const SETTLE_AFTER = 5 * 60 * 1000;
// When the server is full, how many made workspaces one new workspace asks whether they still exist, and how long a
// workspace that answered yes isn't asked again.
const RECHECK_BATCH = 25;
const RECHECK_AFTER = 60 * 60 * 1000;

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS counts (id INTEGER PRIMARY KEY CHECK (id = 1), accounts INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO counts (id, accounts) VALUES (1, 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, used INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS host (id INTEGER PRIMARY KEY CHECK (id = 1), installation TEXT NOT NULL)');
    // One row per workspace: its place under MAX_WORKSPACES. made is 0 from the moment the place is taken until the
    // workspace is known to exist. checked is when a made workspace was last asked whether it still exists.
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, at INTEGER NOT NULL, made INTEGER NOT NULL DEFAULT 0, checked INTEGER NOT NULL DEFAULT 0)'
    );
    if (!this.sql.exec('PRAGMA table_info(workspace)').toArray().some((c) => c.name === 'checked')) {
      this.sql.exec('ALTER TABLE workspace ADD COLUMN checked INTEGER NOT NULL DEFAULT 0');
    }
    this.sql.exec(CODE_TABLES);
  }

  // Keeps a new code, unless the server is full (for a sign-up code, max > 0) or the address or the server had too
  // many: { result } is 'ok', 'full', 'wait' or 'busy', with retryAfter in seconds for the last two. entry holds the
  // hashes codes.js made. rules: ttl, how long the code works; gap, hourly and daily, the limits per address;
  // perHour, the limit for the whole server, per purpose.
  async issueCode(entry, { ttl, gap, hourly, daily, perHour, max = 0 }) {
    const now = Date.now();
    this.#purgeCodes(now);
    if (max > 0 && this.count() >= max) return { result: 'full' };
    const row = this.sql.exec('SELECT times FROM code_sends WHERE address = ?', entry.address).toArray()[0];
    const times = sendTimes(row?.times).filter((t) => now - t < DAY);
    const hour = times.filter((t) => now - t < HOUR);
    let wait = 0;
    if (times.length > 0) wait = Math.max(wait, times[times.length - 1] + gap - now);
    if (hour.length >= hourly) wait = Math.max(wait, hour[hour.length - hourly] + HOUR - now);
    if (times.length >= daily) wait = Math.max(wait, times[times.length - daily] + DAY - now);
    if (wait > 0) return { result: 'wait', retryAfter: Math.ceil(wait / 1000) };
    const slot = Math.floor(now / HOUR);
    const counted = this.sql.exec('SELECT hour, count FROM code_hour WHERE purpose = ?', entry.purpose).toArray()[0];
    if (perHour > 0 && counted?.hour === slot && counted.count >= perHour) {
      return { result: 'busy', retryAfter: Math.ceil(((slot + 1) * HOUR - now) / 1000) };
    }
    times.push(now);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO codes (challenge, address, purpose, code, expiresAt) VALUES (?, ?, ?, ?, ?)',
        entry.challenge,
        entry.address,
        entry.purpose,
        entry.code,
        now + ttl
      );
      this.sql.exec(
        `INSERT INTO code_sends (address, times, until) VALUES (?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET times = excluded.times, until = excluded.until`,
        entry.address,
        JSON.stringify(times.slice(-daily)),
        now + DAY
      );
      this.sql.exec(
        `INSERT INTO code_hour (purpose, hour, count) VALUES (?, ?, 1)
         ON CONFLICT (purpose) DO UPDATE SET
           count = CASE WHEN code_hour.hour = excluded.hour THEN code_hour.count + 1 ELSE 1 END, hour = excluded.hour`,
        entry.purpose,
        slot
      );
    });
    await this.#armCodes(now + ttl);
    return { result: 'ok' };
  }

  // Checks a code against the one kept for its challenge: { result } is 'ok', 'wrong' with attemptsLeft, or 'expired'
  // for a challenge that is unknown, expired, used or out of tries. A right code stays until useCode, so a sign-in
  // with the wrong password can still count against it (failCode). Every try that isn't right counts, also one for
  // another address or purpose.
  async checkCode(entry, attempts) {
    const now = Date.now();
    const row = this.sql.exec('SELECT * FROM codes WHERE challenge = ?', entry.challenge).toArray()[0];
    if (!row || row.expiresAt <= now || row.attempts >= attempts) {
      if (row) this.sql.exec('DELETE FROM codes WHERE challenge = ?', row.challenge);
      return { result: 'expired' };
    }
    const stored = fromBase64url(row.code);
    const given = fromBase64url(entry.code);
    const right = row.address === entry.address && row.purpose === entry.purpose && stored && given && sameBytes(stored, given);
    return right ? { result: 'ok' } : this.#miss(row, attempts);
  }

  // A right code with the wrong password or recovery key behind it: one try fewer, as for a wrong code.
  async failCode(challenge, attempts) {
    const row = this.sql.exec('SELECT challenge, attempts FROM codes WHERE challenge = ?', challenge).toArray()[0];
    if (row) this.#miss(row, attempts);
  }

  async useCode(challenge) {
    this.sql.exec('DELETE FROM codes WHERE challenge = ?', challenge);
  }

  // Deletes what has expired and waits for the next to expire.
  async alarm() {
    const now = Date.now();
    this.#purgeCodes(now);
    const next = this.sql
      .exec('SELECT MIN(t) AS t FROM (SELECT MIN(expiresAt) AS t FROM codes UNION ALL SELECT MIN(until) AS t FROM code_sends)')
      .one().t;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }

  #miss(row, attempts) {
    const left = attempts - row.attempts - 1;
    if (left <= 0) this.sql.exec('DELETE FROM codes WHERE challenge = ?', row.challenge);
    else this.sql.exec('UPDATE codes SET attempts = attempts + 1 WHERE challenge = ?', row.challenge);
    return { result: 'wrong', attemptsLeft: Math.max(0, left) };
  }

  #purgeCodes(now) {
    this.sql.exec('DELETE FROM codes WHERE expiresAt <= ?', now);
    this.sql.exec('DELETE FROM code_sends WHERE until <= ?', now);
  }

  // An alarm at the latest when this code expires. The alarm sets the next one itself.
  async #armCodes(at) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // Made the first time workspaces are used, and never changed.
  async installation() {
    this.sql.exec('INSERT OR IGNORE INTO host (id, installation) VALUES (1, ?)', toBase64url(randomBytes(16)));
    return this.sql.exec('SELECT installation FROM host WHERE id = 1').one().installation;
  }

  // Takes a place for a workspace that is about to be made: 'ok' or 'full'. The place is kept by the workspace's id,
  // so taking, confirming and giving it back can each be repeated without counting twice.
  async reserveWorkspace(id, max) {
    await this.#settle();
    const full = () => max > 0 && this.sql.exec('SELECT COUNT(*) AS n FROM workspace').one().n >= max;
    if (full()) {
      await this.#recheck();
      if (full()) return 'full';
    }
    this.sql.exec('INSERT OR IGNORE INTO workspace (id, at, made) VALUES (?, ?, 0)', id, Date.now());
    return 'ok';
  }

  // The workspace was made.
  async confirmWorkspace(id) {
    this.sql.exec('UPDATE workspace SET made = 1 WHERE id = ?', id);
  }

  // The workspace was not made. A place that was confirmed stays.
  async releaseWorkspace(id) {
    this.sql.exec('DELETE FROM workspace WHERE id = ? AND made = 0', id);
  }

  // The workspace was deleted: its place is free again, confirmed or not. When this call doesn't arrive, #recheck
  // finds the place once the server is full.
  async forgetWorkspace(id) {
    this.sql.exec('DELETE FROM workspace WHERE id = ?', id);
  }

  // The server is full: made workspaces not asked in the past hour, those asked longest ago first, are asked whether
  // they still exist, RECHECK_BATCH at a time, and the place of one deleted without telling the registry is free
  // again. A server that really is full asks each workspace at most once an hour. The batch is marked asked before
  // anyone answers, so a workspace that can't answer waits its hour like the others, and a reservation made meanwhile
  // asks the next batch.
  async #recheck() {
    const now = Date.now();
    const asked = this.sql
      .exec(
        `UPDATE workspace SET checked = ? WHERE id IN
           (SELECT id FROM workspace WHERE made = 1 AND checked < ? ORDER BY checked, at LIMIT ?)
         RETURNING id`,
        now,
        now - RECHECK_AFTER,
        RECHECK_BATCH
      )
      .toArray();
    await Promise.all(
      asked.map(async ({ id }) => {
        try {
          if (!(await workspaceObject(this.env, id).exists())) this.sql.exec('DELETE FROM workspace WHERE id = ? AND made = 1', id);
        } catch {
          // Asked again in an hour, the next time the server is full.
        }
      })
    );
  }

  // When the answer to making a workspace got lost, nobody confirmed or gave back its place. The workspace itself
  // knows whether it exists, so it is asked, a few at a time, before the next place is handed out.
  async #settle() {
    const waiting = this.sql.exec('SELECT id FROM workspace WHERE made = 0 AND at < ? LIMIT 5', Date.now() - SETTLE_AFTER).toArray();
    for (const { id } of waiting) {
      try {
        if (await workspaceObject(this.env, id).exists()) this.sql.exec('UPDATE workspace SET made = 1 WHERE id = ?', id);
        else this.sql.exec('DELETE FROM workspace WHERE id = ? AND made = 0', id);
      } catch {
        // Asked again the next time a place is taken.
      }
    }
  }

  used(code) {
    const row = this.sql.exec('SELECT used FROM invites WHERE code = ?', code).toArray()[0];
    return row ? row.used : 0;
  }

  count() {
    return this.sql.exec('SELECT accounts FROM counts WHERE id = 1').one().accounts;
  }

  // Takes a place for a new account, and a use of its invite code (a hash) when it has one: 'ok', 'full' or 'used'.
  // max 0 means no cap; uses 0 means a code works any number of times. usedFirst: a used code says so even when the
  // server is full, as a workspace invitation that made its account must (WORKSPACES.md, Signing up with an invitation).
  async reserve(max, code = null, uses = 0, usedFirst = false) {
    const used = () => code && uses > 0 && this.used(code) >= uses;
    if (usedFirst && used()) return 'used';
    if (max > 0 && this.count() >= max) return 'full';
    if (used()) return 'used';
    this.sql.exec('UPDATE counts SET accounts = accounts + 1 WHERE id = 1');
    if (code) this.sql.exec('INSERT INTO invites (code, used) VALUES (?, 1) ON CONFLICT (code) DO UPDATE SET used = used + 1', code);
    return 'ok';
  }

  // Gives a place back. With the code, the sign-up didn't happen after all, so its use comes back too; a deleted
  // account gives back only its place, or a code could be used again and again.
  async release(code = null) {
    this.sql.exec('UPDATE counts SET accounts = MAX(0, accounts - 1) WHERE id = 1');
    if (code) this.sql.exec('UPDATE invites SET used = MAX(0, used - 1) WHERE code = ?', code);
  }

  async accounts() {
    return this.count();
  }
}

function sendTimes(json) {
  try {
    const list = JSON.parse(json ?? '[]');
    return Array.isArray(list) ? list.filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}
