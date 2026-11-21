// How many accounts this server holds, so an operator can cap them (MAX_ACCOUNTS), and how often each invite code
// was used (INVITE_USES). With open sign-ups, the cap is what bounds the storage strangers can take: each account is
// limited on its own, but nothing else limits how many accounts there are. With invite codes, the uses keep one code
// from filling the cap. One object for the whole server, holding counts and hashes of invite codes. It also keeps a
// place per workspace, for MAX_WORKSPACES, and holds the installation id that tells this server apart from another
// one answering at the same address later (WORKSPACES.md, Conventions).
//
// It also keeps the codes sent by email (codes.js), the one thing here about people: hashes of their addresses, made
// with PEPPER, for a day after a code was asked for. An alarm deletes them when that time is up.

import { DurableObject } from 'cloudflare:workers';
import { fromBase64url, randomBytes, sameBytes, toBase64url } from './bytes.js';
import { workspaceObject } from './config.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// How long a claimed code is held for the sign-up, sign-in or recovery that claimed it, far longer than one takes. A
// Worker that stops between claiming and settling leaves a claim that lapses.
const CLAIM_TIME = 60 * 1000;
// codes: one row per code asked for, by the hash of its challenge. token is the hash of the long code in the same
// email; address the hash of the address; code the hash of the six digits, which also binds the purpose, the challenge
// and the address. The six digits work until codeUntil and for `attempts` misses; the long code until `until`, when
// the row goes. failures counts wrong passwords or recovery keys sent with either, and ends both at `attempts`.
// claim and claimedUntil hold the code for one request at a time. code_sends: when codes of a purpose were asked for
// an address in the last day, newest last. code_mail: how many sign-up emails went out in the hour that started at
// hour * HOUR.
const CODE_TABLES = `
  CREATE TABLE IF NOT EXISTS codes (
    challenge TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code TEXT NOT NULL,
    codeUntil INTEGER NOT NULL,
    until INTEGER NOT NULL,
    misses INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    claim TEXT,
    claimedUntil INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS codes_until ON codes (until);
  CREATE TABLE IF NOT EXISTS code_sends (
    address TEXT NOT NULL,
    purpose TEXT NOT NULL,
    times TEXT NOT NULL,
    until INTEGER NOT NULL,
    PRIMARY KEY (address, purpose)
  );
  CREATE INDEX IF NOT EXISTS code_sends_until ON code_sends (until);
  CREATE TABLE IF NOT EXISTS code_mail (purpose TEXT PRIMARY KEY, hour INTEGER NOT NULL, count INTEGER NOT NULL);
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

  // Keeps a new code, unless the server is full (for a sign-up code, max > 0) or the address had too many of this
  // purpose: { result } is 'ok', 'full' or 'wait', with retryAfter in seconds for 'wait'. entry holds the hashes
  // codes.js made. rules: ttl, how long the six digits work; tokenTtl, how long the long code works; gap, hourly and
  // daily, the limits per address and purpose.
  async issueCode(entry, { ttl, tokenTtl, gap, hourly, daily, max = 0 }) {
    const now = Date.now();
    this.#purgeCodes(now);
    if (max > 0 && this.count() >= max) return { result: 'full' };
    const row = this.sql
      .exec('SELECT times FROM code_sends WHERE address = ? AND purpose = ?', entry.address, entry.purpose)
      .toArray()[0];
    const times = sendTimes(row?.times).filter((t) => now - t < DAY);
    const hour = times.filter((t) => now - t < HOUR);
    let wait = 0;
    if (times.length > 0) wait = Math.max(wait, times[times.length - 1] + gap - now);
    if (hour.length >= hourly) wait = Math.max(wait, hour[hour.length - hourly] + HOUR - now);
    if (times.length >= daily) wait = Math.max(wait, times[times.length - daily] + DAY - now);
    if (wait > 0) return { result: 'wait', retryAfter: Math.ceil(wait / 1000) };
    times.push(now);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO codes (challenge, token, address, purpose, code, codeUntil, until) VALUES (?, ?, ?, ?, ?, ?, ?)',
        entry.challenge,
        entry.token,
        entry.address,
        entry.purpose,
        entry.code,
        now + ttl,
        now + tokenTtl
      );
      this.sql.exec(
        `INSERT INTO code_sends (address, purpose, times, until) VALUES (?, ?, ?, ?)
         ON CONFLICT (address, purpose) DO UPDATE SET times = excluded.times, until = excluded.until`,
        entry.address,
        entry.purpose,
        JSON.stringify(times.slice(-daily)),
        now + DAY
      );
    });
    await this.#armCodes(now + tokenTtl);
    return { result: 'ok' };
  }

  // Counts one email of a purpose against perHour emails an hour for the whole server: the hour it counts in, or null
  // when this hour's are used up. Only emails about to go out count, so asking for codes that send nothing uses none
  // of them up.
  async chargeMail(purpose, perHour) {
    const slot = Math.floor(Date.now() / HOUR);
    const row = this.sql.exec('SELECT hour, count FROM code_mail WHERE purpose = ?', purpose).toArray()[0];
    if (perHour > 0 && row?.hour === slot && row.count >= perHour) return null;
    this.sql.exec(
      `INSERT INTO code_mail (purpose, hour, count) VALUES (?, ?, 1)
       ON CONFLICT (purpose) DO UPDATE SET
         count = CASE WHEN code_mail.hour = excluded.hour THEN code_mail.count + 1 ELSE 1 END, hour = excluded.hour`,
      purpose,
      slot
    );
    return slot;
  }

  // Gives back an email chargeMail counted, when Resend refused it, so a refusal doesn't use up the hour.
  async refundMail(purpose, slot) {
    this.sql.exec('UPDATE code_mail SET count = MAX(0, count - 1) WHERE purpose = ? AND hour = ?', purpose, slot);
  }

  // No email with the code's long code went out, so nobody can use it: the row goes when the six digits expire, and
  // not a day later.
  async shortenCode(challenge) {
    this.sql.exec('UPDATE codes SET until = MIN(until, codeUntil) WHERE challenge = ?', challenge);
    const row = this.sql.exec('SELECT until FROM codes WHERE challenge = ?', challenge).toArray()[0];
    if (row) await this.#armCodes(row.until);
  }

  // Claims a code for one request: the six digits with their challenge ({ challenge, code }), or the long code
  // ({ token }), for an address and purpose. { result } is 'ok' with the code's id and the claim, 'wrong' with attemptsLeft for
  // six digits that don't match, 'busy' while another request holds the code, or 'expired' for a code that is
  // unknown, expired, used or out of tries. A wrong six digits costs only their own tries, so whoever holds the
  // challenge can't spend the long code in the email. A long code for another address or purpose counts as unknown.
  // The claim holds the code until settleCode, so two requests never use one code at once.
  async claimCode(entry, attempts) {
    const now = Date.now();
    const byToken = typeof entry.token === 'string';
    const row = this.sql
      .exec(`SELECT * FROM codes WHERE ${byToken ? 'token' : 'challenge'} = ?`, byToken ? entry.token : entry.challenge)
      .toArray()[0];
    if (!row || row.until <= now || row.failures >= attempts) return { result: 'expired' };
    if (byToken) {
      if (row.address !== entry.address || row.purpose !== entry.purpose) return { result: 'expired' };
    } else {
      if (row.codeUntil <= now || row.misses >= attempts) return { result: 'expired' };
      const stored = fromBase64url(row.code);
      const given = fromBase64url(entry.code);
      const right = row.address === entry.address && row.purpose === entry.purpose && stored && given && sameBytes(stored, given);
      if (!right) {
        this.sql.exec('UPDATE codes SET misses = misses + 1 WHERE challenge = ?', row.challenge);
        return { result: 'wrong', attemptsLeft: Math.max(0, attempts - row.misses - 1) };
      }
    }
    if (row.claimedUntil > now) return { result: 'busy' };
    const claim = toBase64url(randomBytes(16));
    this.sql.exec('UPDATE codes SET claim = ?, claimedUntil = ? WHERE challenge = ?', claim, now + CLAIM_TIME, row.challenge);
    return { result: 'ok', id: row.challenge, claim };
  }

  // Ends a claim: 'used' deletes the code, 'failed' (a wrong password or recovery key) costs it a try and gives it
  // back, and 'keep' gives it back as it was. A claim that lapsed meanwhile gives back nothing, so it never ends a
  // newer request's claim. What it did still counts: a use deletes the code and a wrong password costs a try.
  async settleCode(id, claim, outcome, attempts) {
    if (outcome === 'used') {
      this.sql.exec('DELETE FROM codes WHERE challenge = ?', id);
      return;
    }
    if (outcome === 'failed') this.sql.exec('UPDATE codes SET failures = failures + 1 WHERE challenge = ?', id);
    this.sql.exec('UPDATE codes SET claim = NULL, claimedUntil = 0 WHERE challenge = ? AND claim = ?', id, claim);
    this.sql.exec('DELETE FROM codes WHERE challenge = ? AND failures >= ?', id, attempts);
  }

  // Deletes what has expired and waits for the next to expire.
  async alarm() {
    const now = Date.now();
    this.#purgeCodes(now);
    const next = this.sql
      .exec('SELECT MIN(t) AS t FROM (SELECT MIN(until) AS t FROM codes UNION ALL SELECT MIN(until) AS t FROM code_sends)')
      .one().t;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }

  #purgeCodes(now) {
    this.sql.exec('DELETE FROM codes WHERE until <= ?', now);
    this.sql.exec('DELETE FROM code_sends WHERE until <= ?', now);
  }

  // An alarm at the latest when this code goes. The alarm sets the next one itself.
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
