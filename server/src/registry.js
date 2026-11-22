// How many accounts this server holds, so an operator can cap them (MAX_ACCOUNTS), and how often each invite code
// was used (INVITE_USES). With open sign-ups, the cap is what bounds the storage strangers can take: each account is
// limited on its own, but nothing else limits how many accounts there are. With invite codes, the uses keep one code
// from filling the cap. One object for the whole server, holding counts and hashes of invite codes. It also keeps a
// place per workspace, for MAX_WORKSPACES, and holds the installation id that tells this server apart from another
// one answering at the same address later (WORKSPACES.md, Conventions).
//
// It also keeps the codes sent by email (codes.js), the one thing here about people: hashes of their addresses, made
// with PEPPER, for a day after a code was asked for. An alarm deletes them when that time is up. The same goes for
// what limits verified sign-ups and unlock emails (signups.js, codes.js) and for the lock on sign-ins (lock.js): each
// is kept under a hash made with PEPPER, of a domain, a mailbox or an address, and goes when its day or lock is over.
// The lock lives in 64 more objects of this class, apart from the one for the whole server (config.js, lockObject);
// their other tables go unused.

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
// claim and claimedUntil hold the code for one request at a time. sent, a column added later, marks a code whose
// email Resend took. code_sends: when codes of a purpose were asked for
// an address in the last day, newest last, under the hash codes.js counts it by (sendsHash: the mailbox for sign-up
// codes, the address itself for unlock codes). code_mail: how many sign-up emails went out in the hour that started at
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

// signup_domains: how many accounts were made today with an emailed code at a domain (signups.js), by the hash of the
// domain, for the day that started at day * DAY. tallies: counts for the whole server in the period that started at
// slot times the period: 'verified', sign-ups with an emailed code this hour; 'unlock', counted unlock emails today;
// 'alert', 1 for the day the operator was last mailed (signups.js). unlock_mail: when counted unlock
// emails went out to a mailbox in the last day, oldest first, by the hash of the mailbox (codes.js), and, under
// "free\n" and the hash of an address, when the free ones went to that address (chargeUnlock). locks: the lock on
// sign-ins and recovery for an address (lock.js), by the hash of the address: the wrong attempts since failedAt, the
// attempts still running as [ticket, start] pairs, and lockedUntil; until is when the row can go. released: the
// expired accounts whose places were given back, by a hash of each one's lifetime, so a retry gives none back twice.
const GUARD_TABLES = `
  CREATE TABLE IF NOT EXISTS signup_domains (domain TEXT PRIMARY KEY, day INTEGER NOT NULL, count INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tallies (name TEXT PRIMARY KEY, slot INTEGER NOT NULL, count INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS unlock_mail (mailbox TEXT PRIMARY KEY, times TEXT NOT NULL, until INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS unlock_mail_until ON unlock_mail (until);
  CREATE TABLE IF NOT EXISTS locks (
    address TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    failedAt INTEGER NOT NULL,
    pending TEXT NOT NULL DEFAULT '[]',
    lockedUntil INTEGER NOT NULL,
    until INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS locks_until ON locks (until);
  CREATE TABLE IF NOT EXISTS released (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
`;
// An attempt under the lock that hasn't come back after this long never will (a Worker's request ends sooner): from
// then on it counts as a wrong one.
const IN_FLIGHT = 60 * 1000;
const RELEASED_FOR = 7 * DAY;
// Unlock emails (chargeUnlock): how long a long code must still work to count as one its owner holds, and how many
// emails one address gets a day past the mailbox's limit and the budget.
const UNLOCK_MARGIN = HOUR;
const FREE_UNLOCK = 2;

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
    this.sql.exec(GUARD_TABLES);
    // Columns that came after their tables: sent, when Resend took a code's email (markSent); pending, the sign-in
    // attempts still running (lockAttempt).
    const has = (table, column) => this.sql.exec(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === column);
    if (!has('codes', 'sent')) this.sql.exec('ALTER TABLE codes ADD COLUMN sent INTEGER NOT NULL DEFAULT 0');
    if (!has('locks', 'pending')) this.sql.exec("ALTER TABLE locks ADD COLUMN pending TEXT NOT NULL DEFAULT '[]'");
  }

  // Resend took the email with this code: its long code is in the owner's mailbox (chargeUnlock).
  async markSent(challenge) {
    this.sql.exec('UPDATE codes SET sent = 1 WHERE challenge = ?', challenge);
  }

  // Keeps a new code, unless the server is full (for a sign-up code, max > 0), the address's domain made its accounts
  // for today (domain, for a sign-up code) or the address had too many of this purpose: { result } is 'ok', 'full',
  // 'domain' or 'wait', with retryAfter in seconds for 'domain' and 'wait'. entry holds the hashes codes.js made; the
  // limits count under entry.sends. rules: ttl, how long the six digits work; tokenTtl, how long the long code works;
  // gap, hourly and daily, the limits per address and purpose; domain, { domain, cap } from signups.js or null.
  async issueCode(entry, { ttl, tokenTtl, gap, hourly, daily, max = 0, domain = null }) {
    const now = Date.now();
    this.#purgeCodes(now);
    if (max > 0 && this.count() >= max) return { result: 'full' };
    if (this.#domainFull(domain, now)) return { result: 'domain', retryAfter: untilTomorrow(now) };
    const row = this.sql
      .exec('SELECT times FROM code_sends WHERE address = ? AND purpose = ?', entry.sends, entry.purpose)
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
        entry.sends,
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

  // Counts an unlock email about to go out to a mailbox (codes.js). { ok: true, at, slot, free } lets it go: at is when
  // it was counted, slot the day of the server's budget it counted in, and free whether the limits let it through
  // without counting it. { ok: false, reason } stops it: 'mailbox' when the mailbox had `daily` counted unlock emails in
  // the last day, 'budget' when today's `budget` (0 for none) is used up.
  //
  // Free is an email to an account address (address, the hash codes.js keys codes by) that has no long code left to
  // use, as long as the address had fewer than FREE_UNLOCK free ones in the last day. A long code counts as left when
  // Resend took its email (sent), it is unused, has tries left and works for at least another UNLOCK_MARGIN, as long as
  // the limit per hour can make its owner wait for a new one; this request's own code (id) doesn't count. Only the owner can use up a long code, so a stranger gets an address one free email until its owner used
  // the code or it ran out, and however the stranger spends the limits, the owner holds a code that gets them in, or
  // gets one with their next request. The cap of FREE_UNLOCK keeps someone who reads the mailbox from using up codes
  // and asking again without limit.
  async chargeUnlock(mailbox, { address, id, daily, budget, attempts }) {
    const now = Date.now();
    const times = this.#unlockTimes(mailbox, now);
    const freeKey = `free\n${address}`;
    const freeTimes = this.#unlockTimes(freeKey, now);
    const usable = this.sql
      .exec(
        `SELECT COUNT(*) AS n FROM codes WHERE address = ? AND purpose = 'unlock' AND challenge != ? AND sent = 1
           AND until > ? AND failures < ?`,
        address,
        id,
        now + UNLOCK_MARGIN,
        attempts
      )
      .one().n;
    const free = usable === 0 && freeTimes.length < FREE_UNLOCK;
    let slot = null;
    if (!free) {
      if (times.length >= daily) return { ok: false, reason: 'mailbox' };
      slot = this.#charge('unlock', DAY, budget, now);
      if (slot === null) return { ok: false, reason: 'budget' };
      this.#saveUnlockTimes(mailbox, [...times, now], now);
    } else {
      this.#saveUnlockTimes(freeKey, [...freeTimes, now], now);
    }
    await this.#armCodes(now + DAY);
    return { ok: true, at: now, slot, free };
  }

  // Gives back what chargeUnlock counted, when Resend refused the email.
  async refundUnlock(mailbox, { at, slot, free }, address) {
    const key = free ? `free\n${address}` : mailbox;
    const times = this.#unlockTimes(key, Date.now());
    const i = times.lastIndexOf(at);
    if (i >= 0) times.splice(i, 1);
    this.#saveUnlockTimes(key, times, Date.now());
    if (slot !== null) this.#refund('unlock', slot);
  }

  // When counted unlock emails went to a mailbox, or free ones to an address, in the last day, oldest first.
  #unlockTimes(key, now) {
    const row = this.sql.exec('SELECT times FROM unlock_mail WHERE mailbox = ?', key).toArray()[0];
    return sendTimes(row?.times).filter((t) => now - t < DAY);
  }

  #saveUnlockTimes(key, times, now) {
    this.sql.exec(
      `INSERT INTO unlock_mail (mailbox, times, until) VALUES (?, ?, ?)
       ON CONFLICT (mailbox) DO UPDATE SET times = excluded.times, until = excluded.until`,
      key,
      JSON.stringify(times),
      now + DAY
    );
  }

  // A count for the whole server in the period that holds now: the slot it counted in, or null when limit (0 for none)
  // is reached.
  #charge(name, period, limit, now) {
    const slot = Math.floor(now / period);
    const row = this.sql.exec('SELECT slot, count FROM tallies WHERE name = ?', name).toArray()[0];
    if (limit > 0 && row?.slot === slot && row.count >= limit) return null;
    this.sql.exec(
      `INSERT INTO tallies (name, slot, count) VALUES (?, ?, 1)
       ON CONFLICT (name) DO UPDATE SET
         count = CASE WHEN tallies.slot = excluded.slot THEN tallies.count + 1 ELSE 1 END, slot = excluded.slot`,
      name,
      slot
    );
    return slot;
  }

  #refund(name, slot) {
    this.sql.exec('UPDATE tallies SET count = MAX(0, count - 1) WHERE name = ? AND slot = ?', name, slot);
  }

  #tally(name, period, now) {
    const row = this.sql.exec('SELECT slot, count FROM tallies WHERE name = ?', name).toArray()[0];
    return row?.slot === Math.floor(now / period) ? row.count : 0;
  }

  // Whether a domain made its accounts for today: domain is { domain, cap } from signups.js, or null for one that
  // isn't counted.
  #domainFull(domain, now) {
    if (!domain?.domain || !(domain.cap > 0)) return false;
    const row = this.sql.exec('SELECT day, count FROM signup_domains WHERE domain = ?', domain.domain).toArray()[0];
    return row?.day === Math.floor(now / DAY) && row.count >= domain.cap;
  }

  // Counts an account made at a domain on a day, or gives one back (step -1) to that day.
  #countDomain(domain, day, step) {
    if (step > 0) {
      this.sql.exec(
        `INSERT INTO signup_domains (domain, day, count) VALUES (?, ?, 1)
         ON CONFLICT (domain) DO UPDATE SET
           count = CASE WHEN signup_domains.day = excluded.day THEN signup_domains.count + 1 ELSE 1 END, day = excluded.day`,
        domain,
        day
      );
    } else {
      this.sql.exec('UPDATE signup_domains SET count = MAX(0, count - 1) WHERE domain = ? AND day = ?', domain, day);
    }
  }

  // Whether to mail the operator now (signups.js), after a sign-up: 'signups' when this hour's sign-ups with an
  // emailed code reached perHour, 'accounts' when the accounts reached 80% of max, else null. At most one a day:
  // the reason it returns claims today's email, which alertFailed gives back when Resend refused it.
  async alertDue({ perHour, max }) {
    const now = Date.now();
    const day = Math.floor(now / DAY);
    if (this.#tally('alert', DAY, now) > 0) return null;
    const signups = this.#tally('verified', HOUR, now);
    const accounts = this.count();
    let reason = null;
    if (perHour > 0 && signups >= perHour) reason = 'signups';
    else if (max > 0 && accounts * 5 >= max * 4) reason = 'accounts';
    if (!reason) return null;
    this.#charge('alert', DAY, 0, now);
    return { reason, signups, accounts, day };
  }

  async alertFailed(day) {
    this.#refund('alert', day);
  }

  // One attempt to sign in or recover with an address (lock.js), let in before the password or recovery key is
  // compared. { result: 'ok', ticket } lets it in; lockSettle takes the ticket when it is over. { result: 'locked',
  // retryAfter } in seconds turns it away: while the address is locked, and while wrong attempts and attempts still
  // running reach `max` between them, so attempts sent at once get no more than `max` tries. Only wrong attempts start
  // the lock itself, so an owner's right attempt that is still running never helps a stranger lock the address. One
  // that doesn't come back within IN_FLIGHT counts as wrong.
  async lockAttempt(address, rules) {
    const now = Date.now();
    const state = this.#lockState(address, now, rules);
    if (state.lockedUntil > now) return { result: 'locked', retryAfter: seconds(state.lockedUntil - now) };
    if (state.failures >= rules.max) {
      await this.#saveLock(address, { ...state, failures: 0, pending: [], lockedUntil: now + rules.lockTime }, rules);
      return { result: 'locked', retryAfter: seconds(rules.lockTime) };
    }
    if (state.failures + state.pending.length >= rules.max) {
      await this.#saveLock(address, state, rules);
      return { result: 'locked', retryAfter: seconds(state.pending[0][1] + IN_FLIGHT - now) };
    }
    const ticket = toBase64url(randomBytes(12));
    state.pending.push([ticket, now]);
    await this.#saveLock(address, state, rules);
    return { result: 'ok', ticket };
  }

  // How the attempt with this ticket ended. A right one resets the count of wrong ones, as a success always did; a
  // wrong one adds to it, and the one that makes `max` locks the address and answers 'locked', as the tenth wrong
  // attempt always has. An attempt whose ticket is no longer running, because it came back after IN_FLIGHT and was
  // counted as wrong, or was settled already, changes nothing. { result } is 'ok', 'wrong' or 'locked' with
  // retryAfter.
  async lockSettle(address, ticket, right, rules) {
    const now = Date.now();
    const state = this.#lockState(address, now, rules, ticket);
    const mine = state.pending.findIndex(([t]) => t === ticket);
    if (mine >= 0) state.pending.splice(mine, 1);
    let answer = { result: right ? 'ok' : 'wrong' };
    if (right) {
      if (mine >= 0) state.failures = 0;
    } else if (state.lockedUntil > now) {
      answer = { result: 'locked', retryAfter: seconds(state.lockedUntil - now) };
    } else {
      if (mine >= 0) state.failures += 1;
      if (state.failures >= rules.max) {
        Object.assign(state, { failures: 0, pending: [], lockedUntil: now + rules.lockTime });
        answer = { result: 'locked', retryAfter: seconds(rules.lockTime) };
      }
    }
    if (state.failures === 0 && state.pending.length === 0 && state.lockedUntil <= now) {
      this.sql.exec('DELETE FROM locks WHERE address = ?', address);
    } else {
      await this.#saveLock(address, state, rules);
    }
    return answer;
  }

  // An address's lock as of now. Attempts running longer than IN_FLIGHT, apart from `keep`, count as wrong from the
  // moment they ran out, oldest first, each in the window that moment falls in: one that runs out when the window it
  // came in with is over starts a new window, as a wrong attempt then would. The one that makes `max` in a window locks
  // the address from that moment, whenever this is asked. Then a window that started `window` ago starts again, with
  // the attempts that are still running.
  #lockState(address, now, { max, window, lockTime }, keep = null) {
    const row = this.sql.exec('SELECT * FROM locks WHERE address = ?', address).toArray()[0];
    if (!row) return { failures: 0, failedAt: now, pending: [], lockedUntil: 0 };
    let pending = [];
    try {
      pending = JSON.parse(row.pending).filter((p) => Array.isArray(p) && typeof p[0] === 'string' && Number.isFinite(p[1]));
    } catch {
      pending = [];
    }
    let { failures, failedAt, lockedUntil } = row;
    const lost = pending.filter(([t, at]) => t !== keep && now - at >= IN_FLIGHT).sort((a, b) => a[1] - b[1]);
    for (const [, at] of lost) {
      const out = at + IN_FLIGHT;
      if (lockedUntil > out) continue;
      if (out - failedAt >= window) {
        failures = 0;
        failedAt = out;
      }
      failures += 1;
      if (failures >= max) {
        lockedUntil = out + lockTime;
        failures = 0;
      }
    }
    pending = pending.filter((p) => !lost.includes(p));
    if (lockedUntil <= now && now - failedAt >= window) return { failures: 0, failedAt: now, pending, lockedUntil: 0 };
    return { failures, failedAt, pending, lockedUntil };
  }

  // A row stays as long as its window, its lock, or the lock an attempt still running could start once it runs out.
  async #saveLock(address, { failures, failedAt, pending, lockedUntil }, { window, lockTime }) {
    const until = Math.max(failedAt + window, lockedUntil, ...pending.map(([, at]) => at + IN_FLIGHT + lockTime));
    this.sql.exec(
      `INSERT INTO locks (address, failures, failedAt, pending, lockedUntil, until) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET failures = excluded.failures, failedAt = excluded.failedAt,
         pending = excluded.pending, lockedUntil = excluded.lockedUntil, until = excluded.until`,
      address,
      failures,
      failedAt,
      JSON.stringify(pending),
      lockedUntil,
      until
    );
    await this.#armCodes(until);
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
  // The claim holds the code until settleCode, so two requests never use one code at once. It also counts one of the
  // code's tries for the password or recovery key, before the account compares it: a request that never settles,
  // because its client went away or its Worker stopped, keeps that try, and settleCode gives it back only when the
  // request didn't fail.
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
    this.sql.exec(
      'UPDATE codes SET claim = ?, claimedUntil = ?, failures = failures + 1 WHERE challenge = ?',
      claim,
      now + CLAIM_TIME,
      row.challenge
    );
    return { result: 'ok', id: row.challenge, claim };
  }

  // Ends a claim: 'used' deletes the code, 'failed' (a wrong password or recovery key) keeps the try claimCode counted
  // and gives the code back, and 'keep' gives back the try and the code as they were. A claim that lapsed meanwhile
  // gives back nothing, neither the code nor its try, so it never ends a newer request's claim. What it did still
  // counts: a use deletes the code and a wrong password costs a try.
  async settleCode(id, claim, outcome, attempts) {
    if (outcome === 'used') {
      this.sql.exec('DELETE FROM codes WHERE challenge = ?', id);
      return;
    }
    if (outcome === 'keep') {
      this.sql.exec('UPDATE codes SET failures = MAX(0, failures - 1) WHERE challenge = ? AND claim = ?', id, claim);
    }
    this.sql.exec('UPDATE codes SET claim = NULL, claimedUntil = 0 WHERE challenge = ? AND claim = ?', id, claim);
    // Out of tries, unless a newer request holds the code: its own try is among them, and it settles the code itself.
    this.sql.exec(
      'DELETE FROM codes WHERE challenge = ? AND failures >= ? AND (claim IS NULL OR claimedUntil <= ?)',
      id,
      attempts,
      Date.now()
    );
  }

  // Deletes what has expired and waits for the next to expire.
  async alarm() {
    const now = Date.now();
    this.#purgeCodes(now);
    // One query per table: the platform's SQLite takes only a few terms in one compound SELECT.
    const times = ['codes', 'code_sends', 'unlock_mail', 'locks', 'released'].map(
      (table) => this.sql.exec(`SELECT MIN(until) AS t FROM ${table}`).one().t
    );
    const day = this.sql.exec('SELECT MIN(day) AS d FROM signup_domains').one().d;
    if (day !== null) times.push((day + 1) * DAY);
    const due = times.filter((t) => t !== null);
    if (due.length > 0) await this.ctx.storage.setAlarm(Math.max(Math.min(...due), now + 1000));
  }

  #purgeCodes(now) {
    this.sql.exec('DELETE FROM codes WHERE until <= ?', now);
    this.sql.exec('DELETE FROM code_sends WHERE until <= ?', now);
    this.sql.exec('DELETE FROM unlock_mail WHERE until <= ?', now);
    this.sql.exec('DELETE FROM locks WHERE until <= ?', now);
    this.sql.exec('DELETE FROM released WHERE until <= ?', now);
    this.sql.exec('DELETE FROM signup_domains WHERE day < ?', Math.floor(now / DAY));
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

  // Takes a place for a new account, and a use of its invite code (a hash) when it has one: 'ok', 'full', 'used' or
  // 'domain'. max 0 means no cap; uses 0 means a code works any number of times. usedFirst: a used code says so even
  // when the server is full, as a workspace invitation that made its account must (WORKSPACES.md, Signing up with an
  // invitation). verified: { domain, cap } from signups.js for a sign-up with an emailed code, which counts toward
  // this hour's sign-ups and, with a domain, toward its domain's accounts of the day ('domain' once cap is reached).
  async reserve(max, code = null, uses = 0, usedFirst = false, verified = null) {
    const used = () => code && uses > 0 && this.used(code) >= uses;
    if (usedFirst && used()) return { result: 'used' };
    if (max > 0 && this.count() >= max) return { result: 'full' };
    if (used()) return { result: 'used' };
    const now = Date.now();
    if (this.#domainFull(verified, now)) return { result: 'domain' };
    this.sql.exec('UPDATE counts SET accounts = accounts + 1 WHERE id = 1');
    if (code) this.sql.exec('INSERT INTO invites (code, used) VALUES (?, 1) ON CONFLICT (code) DO UPDATE SET used = used + 1', code);
    // The hour and day the sign-up counted in, which release takes it from again, also when the clock has moved on.
    const counted = verified ? { hour: Math.floor(now / HOUR), day: Math.floor(now / DAY) } : null;
    if (verified) {
      this.#charge('verified', HOUR, 0, now);
      if (verified.domain && verified.cap > 0) {
        this.#countDomain(verified.domain, counted.day, 1);
        await this.#armCodes((counted.day + 1) * DAY);
      }
    }
    return { result: 'ok', counted };
  }

  // Gives a place back. With the code, the sign-up didn't happen after all, so its use comes back too, and so do the
  // counts of a sign-up with an emailed code (verified and counted, as reserve got and gave them). A deleted account
  // gives back only its place, or a code could be used again and again, and the day's accounts at a domain again and
  // again.
  async release(code = null, verified = null, counted = null) {
    this.sql.exec('UPDATE counts SET accounts = MAX(0, accounts - 1) WHERE id = 1');
    if (code) this.sql.exec('UPDATE invites SET used = MAX(0, used - 1) WHERE code = ?', code);
    if (verified && counted) {
      this.#refund('verified', counted.hour);
      if (verified.domain && verified.cap > 0) this.#countDomain(verified.domain, counted.day, -1);
    }
  }

  // Gives back the place of an account that expired (account.js, expireUnused), once per key however often the
  // account's alarm asks: when the account couldn't be wiped after this, its next try asks again. key is a hash that
  // names that one account's lifetime; it is kept for a week.
  async releaseOnce(key) {
    const now = Date.now();
    if (this.sql.exec('SELECT 1 FROM released WHERE key = ?', key).toArray().length > 0) return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO released (key, until) VALUES (?, ?)', key, now + RELEASED_FOR);
      this.sql.exec('UPDATE counts SET accounts = MAX(0, accounts - 1) WHERE id = 1');
    });
    await this.#armCodes(now + RELEASED_FOR);
  }

  async accounts() {
    return this.count();
  }
}

// Seconds until the next day starts (UTC), when the counts per domain start again.
function untilTomorrow(now) {
  return seconds((Math.floor(now / DAY) + 1) * DAY - now);
}

function seconds(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

function sendTimes(json) {
  try {
    const list = JSON.parse(json ?? '[]');
    return Array.isArray(list) ? list.filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}
