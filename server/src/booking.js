// One Durable Object per booking page handle (PROTOCOL.md, Booking pages). It holds the claim on the handle, what the
// booking device published, and the bookings made on the page. The Worker checks every input and orchestrates;
// objects don't call each other, except this one's daily check that its account still exists.
//
// As in Account, methods first await every hash, seal and key they need, then do all their reading and writing in
// one synchronous stretch, so no other call can slip in between a check and the write that depends on it. Two guests
// booking one slot at once: the second one's stretch runs after the first one's insert and finds the slot taken.
//
// Methods return plain objects for the Worker to turn into answers; failures are { ok: false, error, ... } with the
// error codes PROTOCOL.md lists. Nothing here logs guest details, keys or keyed URLs.

import { DurableObject } from 'cloudflare:workers';
import { blob, fromBase64url, randomBytes, sameBytes, sha256, toBase64url, utf8 } from './bytes.js';
import { ACCOUNT_NAME, accountObject, configProblem, jurisdiction } from './config.js';
import { saltedHash, seal, unwrapManageKey, wrapManageKey } from './seal.js';
import { expiresAt, isOpen, nearest, openSlots, resolveType } from './slots.js';
import { DAY, zonedParts } from './zone.js';

const MINUTE = 60000;
// A handle given up stays reserved for its last account this long, then becomes free.
export const RESERVED_FOR = 365 * DAY;
// A renamed handle redirects to the new one this long.
export const REDIRECT_FOR = 180 * DAY;
// Published data goes this long after the last publish, once no future bookings remain.
export const UNPUBLISHED_FOR = 60 * DAY;
// Bookings go this long after they ended, were cancelled, declined or lapsed.
export const KEEP_BOOKINGS = 30 * DAY;
export const IDEMPOTENCY_FOR = DAY;
export const NETWORK_DAILY = 3;
export const FUTURE_MAX = 500;
export const GUEST_RESCHEDULES = 2;
export const MAIL_BUDGET = 10;
const ACTIVE = ['pending', 'confirmed'];
// Another attempt, when the page changed while a booking was being sealed: a new key, type or day.
const RETRY = Symbol('retry');

const SCHEMA = `
  CREATE TABLE page (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT NOT NULL,
    deviceId TEXT,
    offDevice TEXT,
    handle TEXT NOT NULL,
    profile TEXT,
    windows TEXT,
    busy TEXT,
    publishedAt INTEGER,
    enabled INTEGER NOT NULL DEFAULT 0,
    movedTo TEXT,
    movedUntil INTEGER,
    retiredAt INTEGER,
    salt BLOB NOT NULL,
    daySalt BLOB,
    day TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    claimedAt INTEGER NOT NULL,
    checkedAt INTEGER NOT NULL DEFAULT 0,
    missingSince INTEGER,
    jurisdiction TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    bookedStart INTEGER NOT NULL,
    bookedEnd INTEGER NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    sealed BLOB,
    keyHash BLOB,
    guestHash TEXT,
    channel TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    handledVersion INTEGER NOT NULL DEFAULT 0,
    reschedules INTEGER NOT NULL DEFAULT 0,
    sequence INTEGER NOT NULL DEFAULT 0,
    expiresAt INTEGER,
    uid TEXT NOT NULL,
    notify INTEGER NOT NULL DEFAULT 0,
    cancelledBy TEXT,
    reason TEXT,
    message TEXT
  );
  CREATE INDEX bookings_seq ON bookings (seq);
  CREATE INDEX bookings_start ON bookings (start);
  CREATE TABLE idem (
    key TEXT PRIMARY KEY,
    bodyHash TEXT NOT NULL,
    bookingId TEXT NOT NULL,
    wrappedKey BLOB NOT NULL,
    expiresAt INTEGER NOT NULL
  );
  CREATE TABLE counters (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (day, kind)
  );
`;

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

export class Booking extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Tables are made by the first claim, not here: public requests for handles nobody has reach empty objects, and
    // those should stay empty so probing handles leaves nothing behind.
    this.ready = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'page'").toArray().length > 0;
    this.cache = null;
  }

  #page() {
    return this.ready ? (this.sql.exec('SELECT * FROM page WHERE id = 1').toArray()[0] ?? null) : null;
  }

  // The published profile, windows and busy times, parsed once per publish.
  #published(page) {
    if (!page?.profile) return null;
    if (this.cache?.at !== page.publishedAt) {
      this.cache = {
        at: page.publishedAt,
        profile: JSON.parse(page.profile),
        windows: JSON.parse(page.windows),
        busy: JSON.parse(page.busy)
      };
    }
    return this.cache;
  }

  #moved(page, now) {
    return Boolean(page.movedTo) && page.movedUntil > now;
  }

  // ---- What the public routes read ----

  // The page as the public routes need it. state: 'none' (nobody has it), 'moved' (renamed, redirecting) or 'page'.
  // times: { staleMs, darkMs } from the Worker's settings.
  view(times) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return { state: 'none' };
    if (this.#moved(page, now)) return { state: 'moved', movedTo: page.movedTo };
    return { state: 'page', ...this.#info(page, now, times) };
  }

  #info(page, now, times) {
    const pub = page.retiredAt ? null : this.#published(page);
    const age = pub ? now - page.publishedAt : Infinity;
    return {
      handle: page.handle,
      profile: pub ? pub.profile : null,
      publishedAt: pub ? page.publishedAt : null,
      enabled: page.enabled === 1,
      accepting: Boolean(pub) && page.enabled === 1 && !page.retiredAt,
      stale: age > times.staleMs,
      dark: age > times.darkMs
    };
  }

  // Open starts of one type in [from, to). type null picks the only visible type. exclude: { id, keyHash } of a
  // booking the guest is moving, which then doesn't count against its own new time (the key has to match).
  slots({ type, from, to, exclude = null }, times) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return fail('not_found');
    if (this.#moved(page, now)) return fail('moved', { movedTo: page.movedTo });
    const info = this.#info(page, now, times);
    if (!info.accepting) return fail('not_accepting', { page: info });
    const resolved = resolveType(info.profile, type);
    if (resolved.error) return fail(resolved.error, { page: info, visible: resolved.visible });
    this.#expire(now);
    const input = { ...this.#slotInput(page, resolved.type, now, info), exclude: this.#excluded(exclude) };
    const starts = openSlots({ ...input, from, to }).map((s) => s.start);
    return { ok: true, page: info, type: resolved.type, starts, now };
  }

  // The open starts of every visible type in [from, to), at most limit each: the landing page's and llms.txt's
  // "next open times". With slug, that type only (hidden types too). exclude as for slots().
  overview({ from, to, limit = 40, slug = null, exclude = null }, times) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return fail('not_found');
    if (this.#moved(page, now)) return fail('moved', { movedTo: page.movedTo });
    const info = this.#info(page, now, times);
    if (!info.accepting) return { ok: true, page: info, slots: {}, now };
    this.#expire(now);
    const skip = this.#excluded(exclude);
    const slots = {};
    for (const type of info.profile.types) {
      if (slug ? type.slug !== slug : type.hidden) continue;
      slots[type.slug] = openSlots({ ...this.#slotInput(page, type, now, info), exclude: skip, from, to })
        .slice(0, limit)
        .map((s) => s.start);
    }
    return { ok: true, page: info, slots, now };
  }

  // Whether one start is open, and if not the nearest open ones: for the booking form a link opens. Reads only.
  check({ type, start, exclude = null }, times) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return fail('not_found');
    if (this.#moved(page, now)) return fail('moved', { movedTo: page.movedTo });
    const info = this.#info(page, now, times);
    if (!info.accepting) return fail('not_accepting', { page: info });
    const resolved = resolveType(info.profile, type);
    if (resolved.error) return fail(resolved.error, { page: info, visible: resolved.visible });
    this.#expire(now);
    const input = { ...this.#slotInput(page, resolved.type, now, info), exclude: this.#excluded(exclude) };
    const open = isOpen(input, start);
    return { ok: true, page: info, type: resolved.type, open, alternatives: open ? [] : nearest(input, start), now };
  }

  // The id of a booking to leave out of the slot rules, when its manage key matches; else nothing is left out.
  #excluded(exclude) {
    if (!exclude || typeof exclude.id !== 'string' || !exclude.keyHash) return null;
    return this.#guestRow(exclude.id, exclude.keyHash) ? exclude.id : null;
  }

  #slotInput(page, type, now, info) {
    const pub = this.#published(page);
    return { profile: pub.profile, windows: pub.windows, busy: pub.busy, bookings: this.#active(now), type, now, dark: info.dark };
  }

  #active(now) {
    return this.sql
      .exec("SELECT id, type, start, end FROM bookings WHERE status IN ('pending', 'confirmed') AND end > ?", now - DAY)
      .toArray();
  }

  // ---- Booking ----

  // input: { type, start, name, email, notes, timeZone, locale, via, channel, idempotencyKey, network, uidHost }.
  async book(input, times) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // The page as it is now: its key, the type and the day's salt. A page that can't take the booking stops it
      // here, before any crypto.
      const snap = this.#prepare(input, times);
      if (!snap.ok) return snap;

      const bookingId = toBase64url(randomBytes(16));
      const manageKey = toBase64url(randomBytes(32));
      const end = input.start + snap.type.duration * MINUTE;
      const sealed = await seal({
        publicRaw: fromBase64url(snap.publicKey),
        handle: snap.handle,
        bookingId,
        plaintext: {
          name: input.name,
          email: input.email,
          notes: input.notes,
          timeZone: input.timeZone,
          locale: input.locale,
          via: input.via,
          manageKey,
          type: snap.type.slug,
          start: input.start,
          end
        }
      });
      const keyHash = await sha256(utf8(manageKey));
      // Bound to the type and start, so it tells one booking of a time from another and links nothing else.
      const guestHash = await saltedHash(snap.salt, `guest\n${snap.type.slug}\n${input.start}\n${input.email}`);
      const network = await saltedHash(snap.daySalt, `network\n${input.network}`);
      let idem = null;
      if (input.idempotencyKey) {
        idem = {
          key: await saltedHash(snap.salt, `idempotency\n${input.idempotencyKey}`),
          bodyHash: toBase64url(await sha256(utf8(bodyText(input, snap.type.slug)))),
          wrapped: await wrapManageKey(input.idempotencyKey, bookingId, manageKey)
        };
      }

      const result = this.#commit(snap, input, times, {
        bookingId,
        manageKey,
        end,
        sealed: sealed.blob,
        keyHash,
        guestHash,
        network,
        idem
      });
      if (result === RETRY) continue;
      if (result.replay) {
        // A replay writes nothing, so the key can be unwrapped after the stretch.
        let key = null;
        try {
          key = await unwrapManageKey(input.idempotencyKey, result.booking.id, result.wrapped);
        } catch {
          key = null;
        }
        return { ok: true, outcome: 'replayed', booking: result.booking, key, page: result.page };
      }
      return result;
    }
    return fail('server');
  }

  #prepare(input, times) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return fail('not_found');
    if (this.#moved(page, now)) return fail('moved', { movedTo: page.movedTo });
    const info = this.#info(page, now, times);
    if (!info.accepting) return fail('not_accepting', { page: info });
    const resolved = resolveType(info.profile, input.type);
    if (resolved.error) return fail(resolved.error, { page: info, visible: resolved.visible });
    const day = this.#rollDay(info.profile, now);
    return {
      ok: true,
      handle: page.handle,
      publicKey: info.profile.publicKey,
      salt: new Uint8Array(page.salt),
      daySalt: day.salt,
      day: day.day,
      type: resolved.type
    };
  }

  // The day's salt and date in the host's zone, made new when the day turned. Counters of other days go with it.
  #rollDay(profile, now) {
    const today = zonedParts(now, profile?.timeZone ?? 'UTC').date;
    const current = this.#page();
    if (current.day === today && current.daySalt) return { day: today, salt: new Uint8Array(current.daySalt) };
    const salt = randomBytes(32);
    this.sql.exec('UPDATE page SET day = ?, daySalt = ? WHERE id = 1', today, blob(salt));
    this.sql.exec('DELETE FROM counters WHERE day != ?', today);
    return { day: today, salt };
  }

  #commit(snap, input, times, made) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return fail('not_found');
    const info = this.#info(page, now, times);
    if (!info.accepting) return fail('not_accepting', { page: info });
    const resolved = resolveType(info.profile, input.type);
    // The page changed while the details were sealed: seal again against what it is now.
    if (
      resolved.error ||
      resolved.type.slug !== snap.type.slug ||
      resolved.type.duration !== snap.type.duration ||
      info.profile.publicKey !== snap.publicKey ||
      page.day !== snap.day
    ) {
      return RETRY;
    }
    const type = resolved.type;
    this.#expire(now);

    if (made.idem) {
      const prior = this.sql.exec('SELECT * FROM idem WHERE key = ? AND expiresAt > ?', made.idem.key, now).toArray()[0];
      if (prior) {
        if (prior.bodyHash !== made.idem.bodyHash) return fail('idempotency_mismatch', { page: info });
        const booking = this.#row(prior.bookingId);
        if (booking) return { replay: true, booking: publicRow(booking), wrapped: prior.wrappedKey, page: info };
      }
    }
    const same = this.sql
      .exec(
        "SELECT * FROM bookings WHERE type = ? AND start = ? AND guestHash = ? AND status IN ('pending', 'confirmed')",
        type.slug,
        input.start,
        made.guestHash
      )
      .toArray()[0];
    if (same) return { ok: true, outcome: 'already', booking: publicRow(same), key: null, page: info };

    const count = (kind) => this.sql.exec('SELECT n FROM counters WHERE day = ? AND kind = ?', snap.day, kind).toArray()[0]?.n ?? 0;
    if (count(`network:${made.network}`) >= NETWORK_DAILY) return fail('limit_reached', { limit: 'network', page: info });
    if (count('new') >= info.profile.dailyCap) return fail('limit_reached', { limit: 'day', page: info });
    const future = this.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('pending', 'confirmed') AND end > ?", now).one().n;
    if (future >= FUTURE_MAX) return fail('limit_reached', { limit: 'future', page: info });

    const slotInput = this.#slotInput(page, type, now, info);
    if (!isOpen(slotInput, input.start)) {
      return fail('slot_taken', { alternatives: nearest(slotInput, input.start), page: info, type });
    }

    // A type that needs the host's OK, a page not published to for a day, or a day past its mail budget: a request.
    const confirmed = !type.confirm && !info.stale && count('mail') < MAIL_BUDGET;
    const seq = this.#bump();
    this.sql.exec(
      `INSERT INTO bookings (id, type, start, end, bookedStart, bookedEnd, status, version, sealed, keyHash, guestHash, channel,
         createdAt, updatedAt, seq, expiresAt, uid, notify)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      made.bookingId,
      type.slug,
      input.start,
      made.end,
      input.start,
      made.end,
      confirmed ? 'confirmed' : 'pending',
      blob(made.sealed),
      blob(made.keyHash),
      made.guestHash,
      input.channel,
      now,
      now,
      seq,
      confirmed ? null : expiresAt(now, input.start, type.minNotice),
      `${made.bookingId}@${input.uidHost}`,
      confirmed ? 1 : 0
    );
    this.#count(snap.day, `network:${made.network}`);
    this.#count(snap.day, 'new');
    if (confirmed) this.#count(snap.day, 'mail');
    if (made.idem) {
      this.sql.exec(
        'INSERT OR REPLACE INTO idem (key, bodyHash, bookingId, wrappedKey, expiresAt) VALUES (?, ?, ?, ?, ?)',
        made.idem.key,
        made.idem.bodyHash,
        made.bookingId,
        blob(made.idem.wrapped),
        now + IDEMPOTENCY_FOR
      );
    }
    return { ok: true, outcome: 'created', booking: publicRow(this.#row(made.bookingId)), key: made.manageKey, page: info };
  }

  #count(day, kind) {
    this.sql.exec('INSERT INTO counters (day, kind, n) VALUES (?, ?, 1) ON CONFLICT (day, kind) DO UPDATE SET n = n + 1', day, kind);
  }

  // A counter for the host's today; a day nobody counted in yet is 0.
  #todayCount(page, kind) {
    const pub = this.#published(page);
    const today = zonedParts(Date.now(), pub?.profile.timeZone ?? 'UTC').date;
    if (page.day !== today) return 0;
    return this.sql.exec('SELECT n FROM counters WHERE day = ? AND kind = ?', today, kind).toArray()[0]?.n ?? 0;
  }

  // Whether the host's calendar may still mail guests today for their changes; a host confirm always sends.
  #mailLeft(page) {
    return this.#todayCount(page, 'mail') < MAIL_BUDGET;
  }

  #countMail(profile) {
    this.#count(this.#rollDay(profile, Date.now()).day, 'mail');
  }

  // ---- What a guest does with their manage key (the Worker hashes the key first) ----

  #guestRow(id, keyHash) {
    const row = this.#row(id);
    if (!row || !row.keyHash || !sameBytes(new Uint8Array(row.keyHash), new Uint8Array(keyHash))) return null;
    return row;
  }

  // No such booking here. On a renamed page it may be on the new handle, where the guest's assistant booked it
  // through the old link: that is where the Worker sends them.
  #noGuestRow(page, now) {
    return this.#moved(page, now) ? fail('moved', { movedTo: page.movedTo }) : fail('not_found');
  }

  guestGet(id, keyHash, times) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return fail('not_found');
    this.#expire(now);
    const row = this.#guestRow(id, keyHash);
    if (!row) return this.#noGuestRow(page, now);
    return { ok: true, booking: publicRow(row), page: this.#info(page, now, times) };
  }

  guestCancel(id, keyHash, times) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return fail('not_found');
    this.#expire(now);
    const row = this.#guestRow(id, keyHash);
    if (!row) return this.#noGuestRow(page, now);
    const info = this.#info(page, now, times);
    if (row.status === 'cancelled') return { ok: true, booking: publicRow(row), page: info };
    if (!ACTIVE.includes(row.status) || row.end <= now) return fail('not_active', { booking: publicRow(row), page: info });
    // Past the day's budget the host's calendar still removes the event, without mailing the guest.
    const notify = row.status === 'confirmed' && this.#mailLeft(page);
    if (notify) this.#countMail(info.profile);
    this.#change(row.id, { status: 'cancelled', cancelledBy: 'guest', reason: null, notify });
    return { ok: true, booking: publicRow(this.#row(row.id)), page: info };
  }

  guestReschedule(id, keyHash, start, times) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return fail('not_found');
    this.#expire(now);
    const row = this.#guestRow(id, keyHash);
    if (!row) return this.#noGuestRow(page, now);
    const info = this.#info(page, now, times);
    if (!ACTIVE.includes(row.status) || row.start <= now) return fail('not_active', { booking: publicRow(row), page: info });
    // A move to the time it already has changes nothing: no move used, no new invitation, no mail.
    if (start === row.start) return { ok: true, unchanged: true, booking: publicRow(row), page: info };
    if (!info.accepting) return fail('not_accepting', { page: info });
    if (row.reschedules >= GUEST_RESCHEDULES) return fail('limit_reached', { limit: 'reschedules', page: info });
    const confirmed = row.status === 'confirmed';
    if (confirmed && !this.#mailLeft(page)) return fail('limit_reached', { limit: 'mail', page: info });
    // On a stale page the busy times may be out of date, which is why new bookings wait for the host there. Moving a
    // confirmed booking would have the host's calendar mail the guest a time checked against those same busy times,
    // so it is refused; the guest can cancel and book again, as a request. A pending one stays pending anyway.
    if (confirmed && info.stale) return fail('limit_reached', { limit: 'stale', page: info });
    const type = info.profile.types.find((t) => t.slug === row.type);
    if (!type) return fail('not_active', { booking: publicRow(row), page: info });
    const slotInput = { ...this.#slotInput(page, type, now, info), exclude: row.id };
    if (!isOpen(slotInput, start)) return fail('slot_taken', { alternatives: nearest(slotInput, start), page: info, type });
    if (confirmed) this.#countMail(info.profile);
    this.#change(row.id, {
      start,
      end: start + (row.end - row.start),
      reschedules: row.reschedules + 1,
      sequence: row.sequence + (confirmed ? 1 : 0),
      notify: confirmed,
      expiresAt: confirmed ? null : expiresAt(row.createdAt, start, type.minNotice)
    });
    return { ok: true, booking: publicRow(this.#row(row.id)), page: info };
  }

  // ---- What the host's devices do (the Worker has checked the session and passes the account's routing name) ----

  // For GET /v1/booking. Without tables the handle is free again: the account still names it, nothing is on it.
  // deviceId: the caller's session. A booking device whose page another session turned off has now seen that, so its
  // publishes no longer need a takeover (see publish()).
  ownerView(owner, times, deviceId = null) {
    const page = this.#page();
    if (!page) return { ok: true, empty: true };
    if (page.owner !== owner) return fail('handle_lost');
    if (deviceId && page.offDevice === deviceId) this.sql.exec('UPDATE page SET offDevice = NULL WHERE id = 1');
    return { ok: true, view: this.#ownerView(times) };
  }

  // A publish (or rename) that must take over: from the booking device after another session turned the page off,
  // before that device read the page again. Publishing what it knew from before would turn the page back on.
  #unaware(page, deviceId, takeover) {
    return !takeover && Boolean(deviceId) && page.offDevice === deviceId;
  }

  #ownerView(times) {
    const now = Date.now();
    this.#expire(now);
    const page = this.#page();
    const pub = page.retiredAt ? null : this.#published(page);
    const n = (query, ...args) => this.sql.exec(query, ...args).one().n;
    return {
      handle: page.handle,
      enabled: page.enabled === 1 && !page.retiredAt,
      deviceId: page.deviceId,
      publishedAt: page.publishedAt,
      keyId: pub ? pub.profile.keyId : null,
      seq: page.seq,
      pending: n("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending'"),
      upcoming: n("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND end > ?", now),
      today: pub
        ? { bookings: this.#todayCount(page, 'new'), cap: pub.profile.dailyCap, mail: this.#todayCount(page, 'mail'), mailMax: MAIL_BUDGET }
        : null,
      stale: pub ? now - page.publishedAt > times.staleMs : false
    };
  }

  // Who has this handle, for GET /v1/booking/handles: 'free', 'mine' (this account's, in use or kept), 'taken'
  // (another account uses it) or 'reserved' (another account gave it up less than 12 months ago).
  claim(owner) {
    const page = this.#page();
    if (!page) return 'free';
    if (page.owner === owner) return 'mine';
    return page.retiredAt ? 'reserved' : 'taken';
  }

  // PUT /v1/booking: claims the handle if nobody has it, takes it back when this account kept it, and publishes.
  // Returns the claim as it was, so the Worker can undo it when the rest of a rename fails.
  async publish(owner, deviceId, takeover, data, times) {
    const now = Date.now();
    let fresh = false;
    if (!this.ready) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(SCHEMA);
        this.sql.exec(
          'INSERT INTO page (id, owner, handle, salt, claimedAt, jurisdiction) VALUES (1, ?, ?, ?, ?, ?)',
          owner,
          data.handle,
          blob(randomBytes(32)),
          now,
          jurisdiction(this.env) ?? ''
        );
      });
      this.ready = true;
      fresh = true;
    }
    const page = this.#page();
    if (page.owner !== owner) return fail('other_owner', { retired: Boolean(page.retiredAt) });
    if (page.deviceId && page.deviceId !== deviceId && !takeover && !page.retiredAt) return fail('other_device');
    if (this.#unaware(page, deviceId, takeover)) return fail('other_device');
    const previous = { fresh, retiredAt: page.retiredAt, movedTo: page.movedTo, movedUntil: page.movedUntil, enabled: page.enabled };
    this.sql.exec(
      `UPDATE page SET handle = ?, profile = ?, windows = ?, busy = ?, publishedAt = ?, enabled = ?, deviceId = ?,
         offDevice = NULL, retiredAt = NULL, movedTo = NULL, movedUntil = NULL, missingSince = NULL WHERE id = 1`,
      data.handle,
      JSON.stringify(data.profile),
      JSON.stringify(data.windows),
      JSON.stringify(data.busy),
      now,
      data.enabled ? 1 : 0,
      deviceId
    );
    this.cache = null;
    const view = this.#ownerView(times);
    if (fresh) await this.ctx.storage.setAlarm(now + DAY);
    return { ok: true, view, previous };
  }

  // Undoes a claim publish() made, when the rest of a rename failed.
  async unclaim(owner, previous) {
    const page = this.#page();
    if (!page || page.owner !== owner || !previous) return;
    const any = this.sql.exec('SELECT COUNT(*) AS n FROM bookings').one().n;
    if (previous.fresh && any === 0) await this.#forget();
    else this.#restore(previous);
  }

  // The first half of a rename: the old handle stops taking bookings and redirects, but keeps what it published
  // until finishRetire(), so restore() can put it back exactly. Refused while bookings lie ahead, and, like a publish,
  // from a device that doesn't handle the page.
  retire(owner, movedTo, deviceId = null, takeover = false) {
    const now = Date.now();
    const page = this.#page();
    if (!page) return { ok: true, previous: null };
    if (page.owner !== owner) return fail('handle_lost');
    if (deviceId && page.deviceId && page.deviceId !== deviceId && !takeover && !page.retiredAt) return fail('other_device');
    if (this.#unaware(page, deviceId, takeover)) return fail('other_device');
    this.#expire(now);
    const ahead = this.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('pending', 'confirmed') AND end > ?", now).one().n;
    if (ahead > 0) return fail('has_bookings');
    const previous = { retiredAt: page.retiredAt, movedTo: page.movedTo, movedUntil: page.movedUntil, enabled: page.enabled };
    this.sql.exec(
      'UPDATE page SET retiredAt = ?, movedTo = ?, movedUntil = ?, enabled = 0 WHERE id = 1',
      page.retiredAt ?? now,
      movedTo,
      movedTo ? now + REDIRECT_FOR : null
    );
    return { ok: true, previous };
  }

  restore(owner, previous) {
    const page = this.#page();
    if (!page || page.owner !== owner || !previous) return;
    this.#restore(previous);
  }

  #restore(previous) {
    this.sql.exec(
      'UPDATE page SET retiredAt = ?, movedTo = ?, movedUntil = ?, enabled = ? WHERE id = 1',
      previous.retiredAt,
      previous.movedTo,
      previous.movedUntil,
      previous.enabled
    );
  }

  // The second half of a rename: what the old handle published goes.
  finishRetire(owner) {
    const page = this.#page();
    if (!page || page.owner !== owner || !page.retiredAt) return;
    this.#unpublish();
    this.sql.exec('UPDATE page SET deviceId = NULL WHERE id = 1');
  }

  // DELETE /v1/booking and account deletion: everything on the page goes; the claim stays, reserved for this account.
  // deviceId: the session that turned the page off, for DELETE /v1/booking.
  wipe(owner, deviceId = null) {
    const page = this.#page();
    if (!page) return { ok: true };
    if (page.owner !== owner) return fail('handle_lost');
    this.#wipe(Date.now(), deviceId);
    return { ok: true };
  }

  // When another session turns the page off, the booking device doesn't know yet and may still publish what it had,
  // which would turn the page on again. offDevice keeps that device until it reads the page or takes over.
  #wipe(now, deviceId = null) {
    const page = this.#page();
    // The booking device, or the one an earlier turn-off left unaware; never the session that turns it off now.
    const unaware = page.deviceId ?? page.offDevice;
    const offDevice = deviceId && unaware !== deviceId ? unaware : null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM bookings');
      this.sql.exec('DELETE FROM idem');
      this.sql.exec('DELETE FROM counters');
      this.sql.exec(
        `UPDATE page SET profile = NULL, windows = NULL, busy = NULL, publishedAt = NULL, enabled = 0, deviceId = NULL,
           offDevice = ?, retiredAt = ?, seq = 0, salt = ?, daySalt = NULL, day = NULL, missingSince = NULL WHERE id = 1`,
        offDevice,
        page.retiredAt ?? now,
        blob(randomBytes(32))
      );
    });
    this.cache = null;
  }

  #unpublish() {
    this.sql.exec('UPDATE page SET profile = NULL, windows = NULL, busy = NULL, enabled = 0 WHERE id = 1');
    this.cache = null;
  }

  // Everything goes and the handle is free. The alarm goes first, so it can't wake an object without tables.
  async #forget() {
    this.ready = false;
    this.cache = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // GET /v1/booking/bookings: the bookings changed after since, oldest change first.
  list(owner, since, limit) {
    const page = this.#page();
    if (!page) return { ok: true, bookings: [], seq: 0, more: false };
    if (page.owner !== owner) return fail('handle_lost');
    this.#expire(Date.now());
    const rows = this.sql.exec('SELECT * FROM bookings WHERE seq > ? ORDER BY seq LIMIT ?', since, limit + 1).toArray();
    return { ok: true, bookings: rows.slice(0, limit).map(ownerRow), seq: this.#page().seq, more: rows.length > limit };
  }

  // POST /v1/booking/bookings/<id> from the booking device.
  act(owner, deviceId, id, a, times) {
    const now = Date.now();
    const page = this.#page();
    if (!page || page.owner !== owner) return fail('handle_lost');
    if (page.deviceId && page.deviceId !== deviceId) return fail('other_device');
    this.#expire(now);
    const row = this.#row(id);
    if (!row) return fail('not_found');
    if (a.action === 'handled') {
      if (a.version > row.version) return fail('invalid', { field: 'version' });
      // uid: the UID the host's calendar really gave the event, when it kept another than the booking's (Google may
      // ignore the iCalUID a client sends). The guest's calendar file uses it from then on, so the two merge.
      this.sql.exec(
        'UPDATE bookings SET handledVersion = MAX(handledVersion, ?), uid = COALESCE(?, uid) WHERE id = ?',
        a.version,
        a.uid ?? null,
        id
      );
      return { ok: true, booking: ownerRow(this.#row(id)) };
    }
    const stale = () => fail('stale_version', { booking: ownerRow(row) });
    if (a.version !== row.version) return stale();
    const pub = page.retiredAt ? null : this.#published(page);
    switch (a.action) {
      case 'confirm':
        if (row.status !== 'pending') return stale();
        // The host chose to confirm, so the invitation goes out; it still counts toward the day's budget.
        this.#countMail(pub?.profile);
        this.#change(id, { status: 'confirmed', notify: true, expiresAt: null });
        break;
      case 'decline':
        if (row.status !== 'pending') return stale();
        this.#change(id, { status: 'declined', notify: false, message: a.message });
        break;
      case 'cancel':
        if (!ACTIVE.includes(row.status)) return stale();
        this.#change(id, { status: 'cancelled', notify: false, cancelledBy: 'host', reason: a.reason, message: a.message });
        break;
      case 'reschedule': {
        if (!ACTIVE.includes(row.status)) return stale();
        const type = pub?.profile.types.find((t) => t.slug === row.type) ?? null;
        if (!a.host) {
          const info = this.#info(page, now, times);
          if (!type || !info.accepting) return fail('slot_taken', { alternatives: [] });
          const slotInput = { ...this.#slotInput(page, type, now, info), exclude: id };
          if (!isOpen(slotInput, a.start)) return fail('slot_taken', { alternatives: nearest(slotInput, a.start) });
        }
        this.#change(id, {
          start: a.start,
          end: a.start + (row.end - row.start),
          sequence: row.sequence + (row.status === 'confirmed' ? 1 : 0),
          notify: false,
          expiresAt: row.status === 'pending' ? expiresAt(row.createdAt, a.start, type ? type.minNotice : 0) : null
        });
        break;
      }
    }
    return { ok: true, booking: ownerRow(this.#row(id)) };
  }

  // ---- Bookkeeping ----

  #row(id) {
    return this.sql.exec('SELECT * FROM bookings WHERE id = ?', id).toArray()[0] ?? null;
  }

  #bump() {
    const seq = this.#page().seq + 1;
    this.sql.exec('UPDATE page SET seq = ? WHERE id = 1', seq);
    return seq;
  }

  // A new version of a booking: the next seq, and the guest's details gone once it is no longer active. The key hash
  // stays until the row is purged, so the guest's manage page can still show what happened and the host's message.
  #change(id, fields) {
    const seq = this.#bump();
    const sets = ['version = version + 1', 'seq = ?', 'updatedAt = ?'];
    const args = [seq, Date.now()];
    const ended = fields.status && !ACTIVE.includes(fields.status);
    for (const [k, v] of Object.entries(fields)) {
      if (ended && k === 'expiresAt') continue;
      sets.push(`${k} = ?`);
      args.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null));
    }
    if (ended) {
      sets.push('sealed = NULL', 'guestHash = NULL', 'expiresAt = NULL');
      this.sql.exec('DELETE FROM idem WHERE bookingId = ?', id);
    }
    this.sql.exec(`UPDATE bookings SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
  }

  // Requests nobody confirmed lapse at their expiresAt. Noticed lazily, by whatever reads next; a lapse is a change.
  #expire(now) {
    if (!this.ready) return;
    const due = this.sql.exec("SELECT id FROM bookings WHERE status = 'pending' AND expiresAt <= ?", now).toArray();
    for (const { id } of due) this.#change(id, { status: 'expired', notify: false });
  }

  // Whether the account can be looked up where it lives. Objects are found per jurisdiction, so with a JURISDICTION
  // that is broken, or not the one this page was claimed under, the lookup reaches an empty object and every account
  // would seem gone. The Worker refuses requests then; the check waits until the setting is right again.
  #canLookUpOwner(page) {
    return configProblem(this.env) === null && page.jurisdiction === (jurisdiction(this.env) ?? '');
  }

  // Once a day: lapse, purge, drop old idempotency entries and counters, check the account, and let go of what time
  // has passed.
  async alarm() {
    if (!this.ready) return;
    let now = Date.now();
    let page = this.#page();
    if (!page) return;
    if (page.retiredAt && now - page.retiredAt >= RESERVED_FOR) {
      await this.#forget();
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.#expire(now);
      this.sql.exec(
        "DELETE FROM bookings WHERE (status NOT IN ('pending', 'confirmed') AND updatedAt < ?) OR end < ?",
        now - KEEP_BOOKINGS,
        now - KEEP_BOOKINGS
      );
      this.sql.exec('DELETE FROM idem WHERE expiresAt <= ?', now);
      // A day's counters, network HMACs among them, go with the salt that made them once the host's day is over, also
      // when nobody books the next day. The next booking makes a new salt (#rollDay).
      const pub = page.retiredAt ? null : this.#published(page);
      if (page.day !== zonedParts(now, pub?.profile.timeZone ?? 'UTC').date) {
        this.sql.exec('DELETE FROM counters');
        this.sql.exec('UPDATE page SET day = NULL, daySalt = NULL WHERE id = 1');
      }
      if (page.movedTo && page.movedUntil <= now) this.sql.exec('UPDATE page SET movedTo = NULL, movedUntil = NULL WHERE id = 1');
      // A retired handle publishes nothing; a rename that stopped halfway leaves its old data for this.
      if (page.retiredAt && page.profile) this.#unpublish();
      const ahead = this.sql.exec("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('pending', 'confirmed') AND end > ?", now).one().n;
      if (!page.retiredAt && page.publishedAt && now - page.publishedAt >= UNPUBLISHED_FOR && ahead === 0) this.#unpublish();
    });

    page = this.#page();
    if (!page.retiredAt && now - page.checkedAt >= DAY && ACCOUNT_NAME.test(page.owner) && this.#canLookUpOwner(page)) {
      const owner = page.owner;
      let alive = null;
      try {
        alive = await accountObject(this.env, owner).exists();
      } catch {
        // Unknown this time; asked again tomorrow.
        alive = null;
      }
      now = Date.now();
      page = this.#page();
      if (page && page.owner === owner) {
        // Gone on two checks a day apart, with no answer in between that found it: only then is the page wiped, which
        // can't be undone.
        if (alive === false && page.missingSince !== null) this.#wipe(now);
        else if (alive === false) this.sql.exec('UPDATE page SET checkedAt = ?, missingSince = ? WHERE id = 1', now, now);
        else if (alive === true) this.sql.exec('UPDATE page SET checkedAt = ?, missingSince = NULL WHERE id = 1', now);
        else this.sql.exec('UPDATE page SET checkedAt = ? WHERE id = 1', now);
      }
    }
    if (this.ready) await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
}

// What an Idempotency-Key's body hash is made of: the booking as checked, so field order and spelling don't matter,
// only what would be booked.
function bodyText(input, type) {
  return JSON.stringify([type, input.start, input.name, input.email, input.notes, input.timeZone, input.via]);
}

// A booking as the host's devices get it (PROTOCOL.md, GET /v1/booking/bookings).
export function ownerRow(r) {
  return {
    id: r.id,
    type: r.type,
    start: r.start,
    end: r.end,
    status: r.status,
    version: r.version,
    handledVersion: r.handledVersion,
    seq: r.seq,
    sealed: r.sealed ? toBase64url(new Uint8Array(r.sealed)) : null,
    channel: r.channel,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
    reschedules: r.reschedules,
    uid: r.uid,
    notify: r.notify === 1,
    cancelledBy: r.cancelledBy,
    reason: r.reason,
    message: r.message,
    bookedStart: r.bookedStart,
    bookedEnd: r.bookedEnd
  };
}

// What a guest may see of their booking; the Worker writes it out in the public shape.
export function publicRow(r) {
  return {
    id: r.id,
    type: r.type,
    start: r.start,
    end: r.end,
    status: r.status,
    version: r.version,
    expiresAt: r.expiresAt,
    reschedules: r.reschedules,
    // Moves of the confirmed booking: the calendar file's SEQUENCE, in step with the host's invitation.
    sequence: r.sequence,
    cancelledBy: r.cancelledBy,
    message: r.message,
    uid: r.uid,
    createdAt: r.createdAt
  };
}
