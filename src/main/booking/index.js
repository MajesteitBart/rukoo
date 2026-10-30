'use strict';

// The booking page on the desktop (design 2.9; tmp/cal/contracts.md sections f, g, h, k; server/PROTOCOL.md, Booking
// pages). The page's settings, its key pair and which event each booking became live in the Rukoo account as
// end-to-end encrypted records, keyed per account. One computer, the booking device, publishes open and busy times,
// takes the bookings the server collected into the destination calendar and keeps the two in step; the others show
// the same state read-only. Only this computer talks to calendar providers; the server never does.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');
const { t, translate, getLanguage, getLocale } = require('../../i18n');
const { encodeId, calendarKey } = require('../calendar');
const { openWindows, workWeekly } = require('../calendar/availability');
const { zonedParts, zonedInstant, addDays, isZone, pcZone } = require('../calendar/zone');
const rules = require('./rules');
const keys = require('./keys');
const { withMeeting } = require('../video');

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// How often the booking device polls, and the other devices; how long a publish waits after a calendar change, and
// how often it runs regardless (design 2.9).
const POLL_EVERY = MINUTE;
const POLL_OTHER = 5 * MINUTE;
const REFRESH_OFF = 15 * MINUTE;
const INFO_EVERY = HOUR;
const PUBLISH_AFTER = MINUTE;
const PUBLISH_EVERY = 30 * MINUTE;
const PUBLISH_RETRY = 5 * MINUTE;
const RECONCILE_AFTER = 1500;
// A calendar that can't be read is published from its last good busy times for this long; then every type waits for
// the host.
const LAST_GOOD = 12 * HOUR;
const STALE = 24 * HOUR;
// Bookings and their records are kept this long after the meeting, then forgotten.
const KEEP = 30 * DAY;
// Before a booking's event counts as gone, its calendar is read again fresh this far back and ahead: the host may
// have moved it far, and this computer's copy may be older than the event.
const LOOK_BACK = 31 * DAY;
const LOOK_AHEAD = 400 * DAY;
const PAGES = 50;
const PAGE_LIMIT = 500;
const MAX_PUBLISHED = 50;
const ACTIVE = new Set(['pending', 'confirmed']);
const STATUSES = new Set(['pending', 'confirmed', 'cancelled', 'declined', 'expired']);
const NOTICE_ID = /^[A-Za-z0-9_:.@-]{1,120}$/;
// A calendar UID the server takes with handled (PROTOCOL.md): 1 to 255 visible ASCII characters.
const UID = /^[\x21-\x7e]{1,255}$/;

const plain = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const lower = (s) => String(s || '').trim().toLowerCase();
const num = (v) => (Number.isSafeInteger(v) ? v : null);

// A job whose Rukoo session ended while it waited: a sign-out, or another account signed in. It stops without
// another write; what it still had in hand belongs to the session that ended.
const staleError = () => rules.bookingError('signedOut', { code: 'stale_session' });
const isStale = (err) => Boolean(err && err.code === 'stale_session');
// For a catch that lets a job go on after a failure, but not after its session ended.
const unlessStale = (err) => {
  if (isStale(err)) throw err;
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function emptyFile(acct = null) {
  return { v: 1, acct, cursor: 0, device: null, page: null, lost: false, rows: {}, handled: {}, seen: {}, unopened: {}, busy: {}, unchecked: [], publish: { at: 0, lastOk: null, hash: null, ok: true, error: null }, published: null, dismissed: {}, notices: [], unmoved: {}, noUid: false };
}

// A booking row as the owner API sends it (PROTOCOL.md, GET /v1/booking/bookings), with anything unexpected left out.
function cleanRow(r) {
  if (!plain(r) || !rules.BOOKING_ID.test(r.id) || !STATUSES.has(r.status) || !Number.isSafeInteger(r.version)) return null;
  if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.end <= r.start) return null;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  return {
    id: r.id,
    type: text(r.type, 40) || '',
    start: r.start,
    end: r.end,
    status: r.status,
    version: r.version,
    handledVersion: num(r.handledVersion) || 0,
    seq: num(r.seq) || 0,
    sealed: text(r.sealed, 16384),
    channel: ['web', 'api', 'mcp'].includes(r.channel) ? r.channel : 'web',
    createdAt: num(r.createdAt) || 0,
    updatedAt: num(r.updatedAt) || 0,
    expiresAt: num(r.expiresAt),
    reschedules: num(r.reschedules) || 0,
    uid: text(r.uid, 1000),
    notify: r.notify === true,
    cancelledBy: r.cancelledBy === 'guest' || r.cancelledBy === 'host' ? r.cancelledBy : null,
    reason: text(r.reason, 40),
    message: text(r.message, 500),
    bookedStart: num(r.bookedStart) ?? r.start,
    bookedEnd: num(r.bookedEnd) ?? r.end
  };
}

const httpUrl = (v) => typeof v === 'string' && /^https?:\/\//.test(v);

// What GET and PUT /v1/booking say about the page, as this computer keeps it. base is where every page on the server
// starts (https://meet.rukoo.io, or <server>/meet), there before the account has a handle; older servers don't send it.
function cleanPage(p) {
  if (!plain(p)) return null;
  const device = plain(p.device) && typeof p.device.id === 'string' ? { id: p.device.id.slice(0, 200), name: typeof p.device.name === 'string' ? p.device.name.slice(0, 200) : null, current: p.device.current === true } : null;
  const today = plain(p.today) ? { bookings: num(p.today.bookings) || 0, cap: num(p.today.cap) || 0, mail: num(p.today.mail) || 0, mailMax: num(p.today.mailMax) || 0 } : null;
  return {
    handle: typeof p.handle === 'string' ? p.handle.slice(0, 64) : null,
    url: httpUrl(p.url) ? p.url.slice(0, 2000) : null,
    base: httpUrl(p.base) ? p.base.slice(0, 2000).replace(/\/+$/, '') : null,
    enabled: p.enabled === true,
    device,
    publishedAt: num(p.publishedAt),
    keyId: typeof p.keyId === 'string' ? p.keyId.slice(0, 20) : null,
    seq: num(p.seq) || 0,
    pending: num(p.pending) || 0,
    upcoming: num(p.upcoming) || 0,
    today
  };
}

class Booking extends EventEmitter {
  // timing: { auto } (false in tests: no timers start by themselves) and the delays above, for tests. video: the video
  // services on this computer (src/main/video), which make a meeting for each booking whose type uses one.
  constructor({ account, calendars, engine, secrets = null, video = null, dataDir, notify = () => {}, now = Date.now, timing = {} }) {
    super();
    this.account = account;
    this.calendars = calendars;
    this.engine = engine;
    this.video = video;
    this.secrets = secrets;
    this.dataDir = dataDir;
    this.notifyHost = notify;
    this.now = now;
    this.timing = { auto: true, publishAfter: PUBLISH_AFTER, reconcileAfter: RECONCILE_AFTER, ...timing };
    this.file = emptyFile();
    this.queue = Promise.resolve();
    this.running = 0;
    // The session each job started in, through all its awaits (live()).
    this.jobs = new AsyncLocalStorage();
    this.timers = { tick: null, soon: new Map() };
    this.last = { poll: 0, info: 0, refresh: 0 };
    // Booking ids whose events this service is writing now: their 'changed' events are its own.
    this.own = new Set();
    // Guest details opened from sealed blobs, for bookings without a mapping record. Kept in memory only.
    this.opened = new Map();
    // Where the host just moved a booking's event in Rukoo, by booking id, so reconciliation reads there.
    this.moves = new Map();
    this.fullRead = false;
    // What was last written to booking.json and sent to windows, so an unchanged state goes nowhere.
    this.saved = null;
    this.sent = null;
  }

  get path() {
    return path.join(this.dataDir, 'booking.json');
  }

  init() {
    const saved = readJson(this.path, null);
    this.file = plain(saved) && saved.v === 1 ? { ...emptyFile(), ...saved } : emptyFile();
    // An earlier build kept one flag for every sealed booking that didn't open (unopened counts them per booking),
    // and the time of each page read, which rewrote this file every minute.
    delete this.file.unreadable;
    delete this.file.pageAt;
    if (!plain(this.file.unopened)) this.file.unopened = {};
    if (!plain(this.file.unmoved)) this.file.unmoved = {};
    this.follow();
    this.account.on('status', () => this.follow());
    this.account.on('records', ({ collections = [] } = {}) => {
      if (!collections.includes('booking') && !collections.includes('bookingkey')) return;
      this.recordsChanged();
    });
    this.calendars.on('changed', (c) => this.calendarChanged(c));
    this.calendars.on('synced', () => this.soon('publish', this.timing.publishAfter));
    if (typeof this.engine.on === 'function') this.engine.on('calendar-settings', () => this.soon('publish', this.timing.publishAfter));
    // A video service connected or lost here changes the notices about it.
    if (this.video && typeof this.video.on === 'function') this.video.on('changed', () => this.broadcast());
    if (this.timing.auto) {
      this.timers.tick = setInterval(() => this.tick().catch(() => {}), POLL_EVERY);
      if (this.timers.tick.unref) this.timers.tick.unref();
      this.soon('tick', 5000);
    }
    return this;
  }

  close() {
    clearInterval(this.timers.tick);
    for (const timer of this.timers.soon.values()) clearTimeout(timer);
    this.timers.soon.clear();
    this.persist();
  }

  persist() {
    const text = JSON.stringify(this.file);
    if (text === this.saved) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(`${this.path}.tmp`, text);
      fs.renameSync(`${this.path}.tmp`, this.path);
      this.saved = text;
    } catch (_) {
      // A full disk: the next save tries again; the server and the records hold what matters.
    }
  }

  // The state to every window, only when it changed: each one redraws the calendar or Settings with it.
  broadcast() {
    const state = this.state();
    const text = JSON.stringify(state);
    if (text === this.sent) return;
    this.sent = text;
    this.emit('state', state);
  }

  changed() {
    this.persist();
    this.broadcast();
  }

  // The signed-in account decides which booking page this is. Another account starts from nothing: its records
  // carry another <acct>, and this computer's own bookkeeping for the old one goes.
  follow() {
    const acct = this.account.acct;
    if (acct && acct !== this.file.acct) {
      this.file = emptyFile(acct);
      this.opened.clear();
      this.moves.clear();
      this.fullRead = false;
      this.persist();
    }
    // The account says 'status' at every sync; only a sign-in, a sign-out or another account matters here.
    const sig = `${this.account.signedIn}\n${acct}`;
    if (sig === this.followed) return;
    this.followed = sig;
    if (acct && this.timing.auto) this.soon('tick', 2000);
    this.broadcast();
  }

  // One job at a time: a publish, a poll and an action never run over each other. Each job belongs to the session it
  // was asked for in; when that session ends while the job waits in the queue or runs, the job stops and gets the
  // state there is now.
  exclusive(job) {
    const context = { session: this.account.session, acct: this.acct };
    const run = this.queue.then(async () => {
      this.running += 1;
      try {
        return await this.jobs.run(context, () => {
          this.live();
          return job();
        });
      } catch (err) {
        if (isStale(err)) return this.state();
        throw err;
      } finally {
        this.running -= 1;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // Throws when the session the running job started in has ended: signed out, signed in again, or another account.
  // Every await in a job is followed by this before the job writes a record, booking.json, a notice or calls the
  // server, because after a switch acct, mapKey() and the server's session are the next account's. Outside a job
  // (a handle check, a test) there is nothing to compare.
  live() {
    const job = this.jobs.getStore();
    if (job && (job.session !== this.account.session || job.acct !== this.acct)) throw staleError();
  }

  // Awaits work a job started (a calendar, the account), then live(): a session that ended meanwhile wins over the
  // work's own answer or error.
  async after(promise) {
    let value;
    try {
      value = await promise;
    } catch (err) {
      this.live();
      throw err;
    }
    this.live();
    return value;
  }

  soon(name, ms) {
    if (!this.timing.auto && name !== 'reconcile' && name !== 'publish') return;
    clearTimeout(this.timers.soon.get(name));
    const timer = setTimeout(() => {
      this.timers.soon.delete(name);
      const job = name === 'publish' ? () => this.exclusive(() => this.publish()) : name === 'reconcile' ? () => this.exclusive(() => this.reconcile()) : () => this.tick();
      job()
        .then(() => name !== 'tick' && this.changed())
        .catch(() => {});
    }, ms);
    if (timer.unref) timer.unref();
    this.timers.soon.set(name, timer);
  }

  // Every minute: the booking device polls and publishes at least every 30 minutes; other devices look less often.
  async tick() {
    if (!this.account.signedIn) return;
    const now = this.now();
    await this.exclusive(async () => {
      if (now - this.last.info >= INFO_EVERY) {
        this.last.info = now;
        await this.after(this.account.serverInfo().catch(() => {}));
      }
      if (this.supported() === false) return;
      const on = this.status() === 'on';
      const due = on ? (this.thisDevice() ? POLL_EVERY : POLL_OTHER) : REFRESH_OFF;
      if (now - this.last.poll < due - 1000) return;
      this.last.poll = now;
      if (!on) {
        await this.refresh();
        return;
      }
      // At least every 30 minutes, and a few minutes after a publish that failed.
      const every = this.file.publish.ok ? PUBLISH_EVERY : PUBLISH_RETRY;
      if (this.thisDevice() && now - (this.file.publish.at || 0) >= every) await this.publish({ force: true }).catch(unlessStale);
      await this.poll();
    }).catch(() => {});
    this.changed();
  }

  // ---------- what the account and the server say ----------

  get acct() {
    return this.account.acct;
  }

  info() {
    return this.account.status().info || null;
  }

  // True or false once /v1/info said; null while it is unknown.
  supported() {
    const info = this.info();
    if (!info) return null;
    return Array.isArray(info.features) && info.features.includes('booking');
  }

  status() {
    if (!this.account.signedIn) return 'signed_out';
    if (this.supported() === false) return 'unsupported';
    const page = this.file.page;
    return page && page.enabled && !this.file.lost ? 'on' : 'off';
  }

  // This computer handles the bookings: the page names its session, or the session this computer published with
  // before it signed in again (contracts g). Any other device id means another computer took over.
  thisDevice() {
    const d = this.file.page && this.file.page.device;
    return Boolean(d && (d.current || (this.file.device && d.id === this.file.device)));
  }

  resigned() {
    const d = this.file.page && this.file.page.device;
    return Boolean(d && !d.current && this.file.device && d.id === this.file.device);
  }

  record(name) {
    const acct = this.acct;
    return acct ? this.account.get('booking', `${name}:${acct}`) : undefined;
  }

  // The settings record as stored, checked; null without one or when it doesn't hold together.
  settings() {
    const s = this.record('settings');
    if (!plain(s)) return null;
    try {
      return rules.checkSettings(s, { meet: true });
    } catch (_) {
      return null;
    }
  }

  mapKey(id) {
    return `map:${this.acct}:${id}`;
  }

  map(id) {
    const m = this.acct ? this.account.get('booking', this.mapKey(id)) : undefined;
    return plain(m) && typeof m.eventId === 'string' ? m : null;
  }

  keyring() {
    const acct = this.acct;
    const rec = acct ? this.account.get('bookingkey', acct) : undefined;
    return rec ? keys.openKeyring(rec) : null;
  }

  keyState() {
    const acct = this.acct;
    const rec = acct ? this.account.get('bookingkey', acct) : undefined;
    if (!rec) return 'missing';
    const opened = keys.openKeyring(rec);
    // Only the keyring itself: a single booking that doesn't open is counted on its own (unopened).
    if (!opened) return 'unreadable';
    const page = this.file.page;
    if (page && page.enabled && page.keyId && !opened.keys.has(page.keyId)) return 'mismatch';
    return 'ok';
  }

  setPage(answer) {
    const page = cleanPage(answer);
    if (!page) return;
    this.file.page = page;
    this.file.lost = false;
    if (page.device && page.device.current) this.file.device = page.device.id;
  }

  // A booking route, only in the session the job started in; an answer that comes after that session ended goes
  // nowhere.
  async call(method, route, body) {
    this.live();
    let res;
    try {
      res = await this.account.bookingCall(method, route, body);
    } catch (err) {
      this.live();
      if (err && err.code === 'handle_lost') this.file.lost = true;
      throw asBookingError(err);
    }
    this.live();
    return res;
  }

  // GET /v1/booking. A page this account lost, or a server that can't be reached, leaves what this computer knew.
  async refresh({ info = false } = {}) {
    if (!this.account.signedIn) return;
    if (info) {
      this.last.info = this.now();
      await this.after(this.account.serverInfo().catch(() => {}));
    }
    if (this.supported() === false) return;
    this.last.refresh = this.now();
    try {
      this.setPage(await this.call('GET', '/v1/booking'));
    } catch (err) {
      // Shown through the state: lost, stale or unchanged.
      unlessStale(err);
    }
    await this.followUrl().catch(unlessStale);
  }

  // The settings record keeps the public address as the server reports it, for the footer and other devices.
  async followUrl() {
    const page = this.file.page;
    const s = this.settings();
    if (!s || !page || !page.url || !page.enabled || page.handle !== s.handle || s.url === page.url) return;
    await this.writeSettings((current) => ({ ...current, url: page.url }));
  }

  // Writes the settings record after a pull, with change applied to what the pull brought (contracts g).
  async writeSettings(change) {
    await this.after(this.account.sync().catch(() => {}));
    const current = this.record('settings');
    const next = change(plain(current) ? current : null);
    if (!next) return null;
    const checked = rules.checkSettings(next, { meet: true, today: rules.todayIn(next.timeZone, this.now()) });
    this.account.put('booking', `settings:${this.acct}`, checked);
    // Up at once rather than with the next push, so another computer sees the change when it looks.
    await this.after(this.account.sync().catch(() => {}));
    return checked;
  }

  // ---------- the state windows show ----------

  // Which local account and calendar a portable key names, and how it reads.
  resolve(portable) {
    const p = rules.parsePortable(portable);
    if (!p) return null;
    for (const acc of this.calendars.list()) {
      if (lower(acc.email) !== p.email) continue;
      const cal = acc.calendars.find((c) => c.id === p.calendarId);
      if (cal) return { key: calendarKey(acc.id, cal.id), portable, accountId: acc.id, calendarId: cal.id, name: cal.name, email: acc.email, found: true, invites: cal.invites, conference: cal.conference, writable: cal.writable, kind: acc.kind };
    }
    return { key: null, portable, accountId: null, calendarId: p.calendarId, name: p.calendarId, email: p.email, found: false, invites: 'none', conference: false, writable: false, kind: null };
  }

  // A calendar named by a window: a local Key (account id and calendar id) becomes the portable key the record
  // stores; a portable key stays as it is.
  portable(key) {
    const at = key.indexOf('\n');
    if (at < 0 || key.slice(0, at).includes('@')) return key;
    for (const acc of this.calendars.list()) {
      const cal = acc.calendars.find((c) => calendarKey(acc.id, c.id) === key);
      if (cal) return rules.portableKey(acc.email, cal.id);
    }
    return key;
  }

  resolved(settings) {
    const published = this.record('published');
    const list = plain(published) && Array.isArray(published.availability) ? published.availability : [];
    const dest = settings && settings.destination ? this.resolve(settings.destination) : null;
    return {
      availability: list.map((k) => this.resolve(k)).filter(Boolean).map(({ key, portable, name, email, found }) => ({ key, portable, name, email, found })),
      destination: dest ? { key: dest.key, portable: dest.portable, name: dest.name, email: dest.email, found: dest.found, invites: dest.invites, conference: dest.conference } : null
    };
  }

  // A guest's details: from the mapping record, else opened from the sealed blob. null when neither works here.
  guestOf(row) {
    const map = this.map(row.id);
    if (map && plain(map.guest)) return map.guest;
    if (this.opened.has(row.id)) return this.opened.get(row.id);
    // Remembered also when it didn't open, until the keyring changes (recordsChanged).
    const opened = this.openRow(row);
    this.opened.set(row.id, opened);
    return opened;
  }

  openRow(row) {
    if (!row.sealed) return null;
    const ring = this.keyring();
    const page = this.file.page;
    const handle = (page && page.handle) || (this.settings() || {}).handle;
    if (!ring || !handle) return null;
    let guest = null;
    try {
      guest = rules.checkGuest(keys.openSealed(ring, { handle, bookingId: row.id, blob: row.sealed }), row);
    } catch (_) {
      guest = null;
    }
    // Sealed to a key this keyring doesn't have, damaged on the way, or details that don't match the booking: the
    // booking waits, and one notice counts every such booking (notices()). Forgotten when the booking ends or the
    // keyring changes.
    if (guest) delete this.file.unopened[row.id];
    else if (ACTIVE.has(row.status) && !this.file.unopened[row.id]) this.file.unopened[row.id] = this.now();
    return guest;
  }

  item(row) {
    const settings = this.settings();
    const type = settings && settings.types.find((x) => x.slug === row.type);
    const map = this.map(row.id);
    let eventId = null;
    if (map) {
      const acc = this.engine.accounts.find((a) => lower(a.email) === lower(map.accountEmail));
      if (acc) eventId = encodeId(acc.id, map.calendarId, map.eventId);
    }
    const g = this.guestOf(row);
    return {
      id: row.id,
      status: row.status,
      type: row.type,
      typeTitle: type ? type.title : row.type,
      start: row.start,
      end: row.end,
      channel: row.channel,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.status === 'pending' ? row.expiresAt : null,
      eventId,
      guest: g ? { name: g.name, email: g.email, notes: g.notes, timeZone: g.timeZone, locale: g.locale, via: g.via } : null,
      customLength: Boolean(map && map.customLength)
    };
  }

  state() {
    const status = this.status();
    const info = this.info();
    const settings = this.settings();
    const page = this.file.page;
    const now = this.now();
    const rows = Object.values(this.file.rows);
    const thisDevice = status !== 'signed_out' && this.thisDevice();
    const lastAt = this.file.publish.lastOk || null;
    const signedIn = this.account.signedIn;
    return {
      status,
      signedIn,
      email: signedIn ? this.account.status().email : null,
      server: this.account.server || null,
      serverName: info && info.operator && typeof info.operator.name === 'string' ? info.operator.name : null,
      invite: Boolean(info && info.signups === 'invite'),
      handle: signedIn ? (page && page.handle) || (settings && settings.handle) || null : null,
      url: signedIn ? (page && page.url) || (settings && settings.url) || null : null,
      base: signedIn ? (page && page.base) || null : null,
      enabled: status === 'on',
      settings: signedIn ? settings : null,
      resolved: signedIn ? this.resolved(settings) : { availability: [], destination: null },
      device: signedIn && page && page.device ? { id: page.device.id, name: page.device.name || '', current: thisDevice } : null,
      thisDevice,
      publishing: {
        lastAt,
        lastError: this.file.publish.ok ? null : this.file.publish.error,
        stale: Boolean(thisDevice && status === 'on' && (!lastAt || now - lastAt > STALE)),
        unchecked: this.file.unchecked.map((u) => ({ email: u.email, since: u.since }))
      },
      key: signedIn ? this.keyState() : 'missing',
      bookings: status === 'signed_out' ? [] : rows.filter((r) => r.status === 'confirmed' && r.end >= now - KEEP).sort((a, b) => a.start - b.start).map((r) => this.item(r)),
      requests: status === 'signed_out' ? [] : rows.filter((r) => r.status === 'pending').sort((a, b) => a.start - b.start).map((r) => this.item(r)),
      notices: status === 'signed_out' ? [] : this.notices(),
      today: page && page.today ? { ...page.today } : null,
      busy: this.running > 0,
      // The video services the meeting types use that can't make meetings on this computer.
      video: { missing: signedIn ? this.videoMissing(settings).map(({ service, name, status }) => ({ service, name, status })) : [] }
    };
  }

  // The full public address while the page is on, for the footer, the composer and agents.
  url() {
    if (this.status() !== 'on') return null;
    const page = this.file.page;
    const s = this.settings();
    return (page && page.url) || (s && s.url) || null;
  }

  locale() {
    const s = this.account.signedIn ? this.settings() : null;
    return s ? s.locale : null;
  }

  // Booking hours for free time (calendar/free.js), while the page is on.
  hours() {
    const s = this.status() === 'on' ? this.settings() : null;
    if (!s) return null;
    return { weekly: s.hours.custom && s.hours.weekly ? s.hours.weekly : workWeekly(this.engine.settings.calendar), overrides: s.overrides, timeZone: s.timeZone };
  }

  // The link and the visible types, for the composer and get_booking_link.
  link() {
    const url = this.url();
    const s = url && this.settings();
    if (!s) return null;
    return { url, types: s.types.filter((x) => !x.hidden).map((x) => ({ slug: x.slug, title: x.title, duration: x.duration, url: `${url}/${x.slug}` })) };
  }

  // ---------- notices ----------

  notices() {
    const now = this.now();
    const page = this.file.page;
    const on = this.status() === 'on';
    const thisDevice = this.thisDevice();
    const settings = this.settings();
    const list = [];
    const conditions = new Set();
    const add = (n) => {
      conditions.add(n.id);
      list.push(n);
    };
    const action = (a) => ({ action: a, label: t(`booking.notices.actions.${a}`) });
    if (this.file.lost) add({ id: 'handleLost', kind: 'handleLost', tone: 'error', title: t('booking.notices.handleLostTitle'), text: t('booking.notices.handleLostText', { handle: (page && page.handle) || '' }), actions: [action('dismiss')] });
    if (on && page.device && !thisDevice) {
      // Use this computer moves the meetings too: it says which services still have to be connected here.
      const missing = this.videoMissing(settings);
      const text = missing.length ? t('booking.notices.otherDeviceVideoText', { services: listText(missing.map((m) => m.name)) }) : t('booking.notices.otherDeviceText');
      add({ id: 'otherDevice', kind: 'otherDevice', tone: 'info', title: t('booking.notices.otherDeviceTitle', { device: page.device.name || t('booking.notices.otherDeviceUnknown') }), text, actions: [action('takeover'), action('dismiss')] });
    }
    if (on) {
      const key = this.keyState();
      if (key !== 'ok' && (thisDevice || key !== 'missing')) {
        const text = { missing: 'booking.notices.keyMissingText', mismatch: 'booking.notices.keyMismatchText', unreadable: 'booking.notices.keyUnreadableText' }[key];
        add({ id: 'key', kind: 'key', tone: 'error', title: t('booking.notices.keyTitle'), text: t(text), actions: [action('dismiss')] });
      }
      if (page.publishedAt && now - page.publishedAt > STALE) {
        add({ id: 'stale', kind: 'stale', tone: 'warn', title: t('booking.notices.staleTitle'), text: t(thisDevice ? 'booking.notices.staleText' : 'booking.notices.staleOtherText', { device: (page.device && page.device.name) || t('booking.notices.otherDeviceUnknown') }), actions: [action('dismiss')] });
      }
      if (page.today && page.today.cap && page.today.bookings >= page.today.cap) {
        add({ id: 'cap', kind: 'cap', tone: 'info', title: t('booking.notices.capTitle'), text: t('booking.notices.capText', { count: page.today.cap }), actions: [action('dismiss')] });
      }
      if (thisDevice) {
        for (const u of this.file.unchecked) {
          if (!u.over || !u.accountId) continue;
          add({ id: `unchecked:${u.accountId}`, kind: 'unchecked', tone: 'warn', accountId: u.accountId, email: u.email, title: t('booking.notices.uncheckedTitle', { email: u.email }), text: t('booking.notices.uncheckedText'), actions: [action('reconnect')] });
        }
        const dest = settings && settings.destination ? this.resolve(settings.destination) : null;
        if (dest && !(dest.found && dest.writable)) {
          add({ id: 'destination', kind: 'destination', tone: 'error', title: t('booking.notices.destinationTitle'), text: t('booking.notices.destinationText', { email: dest.email }), actions: [action('dismiss')] });
        }
        if (!this.file.publish.ok) add({ id: 'publishFailed', kind: 'publishFailed', tone: 'error', title: t('booking.notices.publishFailedTitle'), text: t('booking.notices.publishFailedText', { error: this.file.publish.error || '' }), actions: [action('dismiss')] });
        for (const m of this.videoMissing(settings)) {
          // A service only upcoming bookings still use: their meetings can't move or go with them.
          const why = t(m.status === 'renew' ? 'booking.notices.videoWhyRenew' : 'booking.notices.videoWhyOff', { service: m.name });
          const text = m.types.length
            ? t(m.status === 'renew' ? 'booking.notices.videoRenewText' : 'booking.notices.videoMissingText', { service: m.name, types: listText(m.types) })
            : t('booking.notices.videoBookingsText', { service: m.name, why, count: m.bookings });
          const title = m.types.length ? t('booking.notices.videoMissingTitle', { service: m.name }) : t('booking.notices.videoBookingsTitle', { service: m.name });
          add({ id: `videoMissing:${m.service}`, kind: 'videoMissing', tone: 'warn', title, text, actions: [action('video'), action('dismiss')] });
        }
        // Bookings ahead whose guest details didn't open here: the guests have their answer from the page, and the
        // host has nothing in the calendar. A new one brings the notice back after a dismiss (since).
        const unopened = Object.keys(this.file.unopened).filter((id) => this.file.rows[id] && ACTIVE.has(this.file.rows[id].status) && this.file.rows[id].end > now);
        if (unopened.length) {
          const since = Math.max(...unopened.map((id) => this.file.unopened[id]));
          add({ id: 'unopened', kind: 'unopened', tone: 'warn', since, title: t('booking.notices.unopenedTitle', { count: unopened.length }), text: t('booking.notices.unopenedText', { count: unopened.length }), actions: [action('dismiss')] });
        }
      }
    }
    // A notice that was dismissed returns once its condition has cleared and comes back.
    for (const id of Object.keys(this.file.dismissed)) {
      const stored = this.file.notices.some((n) => n.id === id);
      if (!stored && !conditions.has(id)) delete this.file.dismissed[id];
    }
    for (const n of this.file.notices) {
      const shown = this.storedNotice(n, settings, action);
      if (shown) list.push(shown);
    }
    return list
      .filter((n) => !this.file.dismissed[n.id] || (n.since && n.since > this.file.dismissed[n.id]))
      .map((n) => ({ id: n.id, kind: n.kind, tone: n.tone, bookingId: n.bookingId || null, accountId: n.accountId || null, email: n.email || null, title: n.title, text: n.text, actions: n.actions }));
  }

  // Notices about one booking, kept until dismissed: their text is made in the current language each time.
  storedNotice(n, settings, action) {
    const type = settings && settings.types.find((x) => x.slug === n.type);
    const params = { type: type ? type.title : n.type || '', guest: n.name || t('booking.notifications.someone'), when: whenText(n.start) };
    const base = { id: n.id, kind: n.kind, bookingId: n.bookingId };
    switch (n.kind) {
      case 'overlap':
        return { ...base, tone: 'warn', title: t('booking.notices.overlapTitle'), text: t('booking.notices.overlapText', params), actions: [action('keep'), action('cancel'), action('open')] };
      case 'mailBudget':
        return { ...base, tone: 'warn', title: t('booking.notices.mailBudgetTitle'), text: t('booking.notices.mailBudgetText', params), actions: [action('open'), action('dismiss')] };
      case 'guestCancelled':
        return { ...base, tone: 'info', title: t('booking.notices.guestCancelledTitle', params), text: t('booking.notices.guestCancelledText', params), actions: [action('dismiss')] };
      case 'guestDeclined':
        return { ...base, tone: 'info', title: t('booking.notices.guestDeclinedTitle', params), text: t('booking.notices.guestDeclinedText', params), actions: [action('dismiss')] };
      case 'hostDeleted':
        return { ...base, tone: 'info', title: t('booking.notices.hostDeletedTitle'), text: t('booking.notices.hostDeletedText', params), actions: [action('dismiss')] };
      case 'video': {
        // A meeting the video service didn't make, move or delete (op), and why: the sign-in needs renewing, the
        // service isn't connected here, or what the service said.
        const service = rules.VIDEO_SERVICES[n.service] || n.service || '';
        const why = n.reason === 'renew' ? t('booking.notices.videoWhyRenew', { service }) : n.reason === 'off' ? t('booking.notices.videoWhyOff', { service }) : n.error || t('booking.notices.videoWhyFailed', { service });
        const op = { update: 'Update', delete: 'Delete' }[n.op] || 'Create';
        const p = { ...params, service, why };
        return { ...base, tone: 'warn', title: t(`booking.notices.video${op}Title`, p), text: t(`booking.notices.video${op}Text`, p), actions: op === 'Delete' ? [action('video'), action('dismiss')] : [action('video'), action('open'), action('dismiss')] };
      }
      default:
        return null;
    }
  }

  // extra: what the notice's text needs besides the booking (a video notice's service and reason).
  addNotice(kind, row, name, extra = {}) {
    this.live();
    const id = `${kind}:${row.id}`;
    this.file.notices = this.file.notices.filter((n) => n.id !== id);
    this.file.notices.push({ ...extra, id, kind, bookingId: row.id, type: row.type, start: row.start, name: name || '', at: this.now() });
    delete this.file.dismissed[id];
  }

  // ---------- turning the page on and off ----------

  requireSignedIn() {
    if (!this.account.signedIn) throw rules.bookingError('signedOut', { code: 'signed_out' });
  }

  async requireSupported() {
    this.requireSignedIn();
    if (this.supported() === null) await this.after(this.account.serverInfo().catch(() => {}));
    if (this.supported() === false) throw rules.bookingError('unsupported');
  }

  requireDevice() {
    if (this.status() !== 'on') throw rules.bookingError('notOn');
    if (!this.thisDevice()) throw rules.bookingError('notBookingDevice');
  }

  // A destination calendar a booking can be written to (design 1.2): a writable Google calendar, a CalDAV calendar
  // whose server sends invitations, or a demo calendar.
  destinationOf(portable) {
    const d = portable ? this.resolve(portable) : null;
    if (!d) throw rules.bookingError('noDestination', { code: 'invalid', field: 'destination' });
    if (!d.found || !d.writable) throw rules.bookingError('destinationGone', { code: 'invalid', field: 'destination' });
    if (d.kind === 'caldav' && d.invites !== 'provider') throw rules.bookingError('noDestination', { code: 'invalid', field: 'destination' });
    if (!['google', 'caldav', 'demo'].includes(d.kind)) throw rules.bookingError('noDestination', { code: 'invalid', field: 'destination' });
    return d;
  }

  // Turns the page on from the setup screen (contracts g, BookingEnableInput). Settings kept from an earlier time the
  // page was on stay, apart from what the setup screen sends.
  async enable(input) {
    return this.exclusive(async () => {
      await this.requireSupported();
      const i = plain(input) ? input : {};
      await this.after(this.account.sync().catch(() => {}));
      await this.after(this.calendars.loadCalendars().catch(() => []));
      const local = this.calendars.list().find((acc) => acc.calendars.some((c) => calendarKey(acc.id, c.id) === i.destination));
      const cal = local && local.calendars.find((c) => calendarKey(local.id, c.id) === i.destination);
      if (!cal) throw rules.bookingError('noDestination', { code: 'invalid', field: 'destination' });
      const destination = rules.portableKey(local.email, cal.id);
      const dest = this.destinationOf(destination);
      const current = this.record('settings');
      const prior = plain(current) ? current : null;
      const locale = getLanguage() === 'nl' ? 'nl' : 'en';
      const first = rules.typeWithDefaults(i.type, prior && prior.types && prior.types[0] ? prior.types[0] : rules.defaultType(locale, { conference: dest.conference }));
      const others = prior && Array.isArray(prior.types) ? prior.types.slice(1).filter((x) => plain(x) && x.slug !== first.slug) : [];
      const hours = plain(i.hours) ? { custom: i.hours.custom === true, weekly: i.hours.weekly ?? null } : prior && prior.hours ? prior.hours : { custom: false, weekly: null };
      const draft = {
        v: 1,
        handle: typeof i.handle === 'string' ? i.handle.trim() : '',
        url: prior && typeof prior.url === 'string' ? prior.url : '',
        name: i.name,
        intro: prior ? prior.intro ?? '' : '',
        timeZone: i.timeZone,
        locale: prior && (prior.locale === 'en' || prior.locale === 'nl') ? prior.locale : locale,
        contact: prior ? prior.contact ?? null : null,
        dailyCap: prior && Number.isInteger(prior.dailyCap) ? prior.dailyCap : 20,
        hours,
        overrides: prior && plain(prior.overrides) ? prior.overrides : {},
        destination,
        device: null,
        types: [first, ...others]
      };
      const settings = rules.checkSettings(draft, { today: rules.todayIn(draft.timeZone, this.now()), meet: dest.conference });
      // Turning the page on again after another computer had it makes this one the booking device.
      await this.publish({ force: true, settings, enabling: true, takeover: Boolean(this.file.page && this.file.page.device && !this.thisDevice()) });
      const page = this.file.page;
      await this.writeSettings(() => ({ ...settings, url: (page && page.url) || settings.url, device: page && page.device ? page.device.id : null }));
      await this.poll().catch(unlessStale);
      return this.state();
    }).finally(() => this.changed());
  }

  async save(patch) {
    return this.exclusive(async () => {
      this.requireSignedIn();
      await this.after(this.account.sync().catch(() => {}));
      const current = this.record('settings');
      if (!plain(current)) throw rules.bookingError('notOn');
      const p = { ...(plain(patch) ? patch : {}) };
      if (typeof p.destination === 'string') p.destination = this.portable(p.destination);
      const next = rules.mergeSettings(current, p);
      // A new destination must be one a booking can go to; the one the record has may be another computer's calendar.
      let meet = true;
      if (p.destination !== undefined && p.destination !== current.destination) meet = this.destinationOf(next.destination).conference;
      else if (next.destination) {
        const d = this.resolve(next.destination);
        if (d && d.found) meet = d.conference;
      }
      patch = p;
      const settings = rules.checkSettings(next, { today: rules.todayIn(next.timeZone, this.now()), meet });
      let on = this.status() === 'on';
      // A video service is chosen on the computer that handles bookings, where it has to be connected. That one runs
      // a Rukoo that knows the location; a computer from before video services can't read the settings once a type
      // has one, so it must not be the one (docs/booking.md). Who handles them is asked fresh, as another computer may
      // have taken over since this one last looked, and again once the change is up (videoStays); when the server
      // can't say, the change doesn't go.
      const chosen = on ? newVideo(current, settings) : [];
      if (chosen.length) {
        this.setPage(await this.call('GET', '/v1/booking'));
        on = this.status() === 'on';
        if (on && !this.thisDevice()) throw rules.bookingError('videoElsewhere', { code: 'invalid', field: `types[${chosen[0]}].location.kind` });
      }
      if (settings.handle !== current.handle && on) {
        // A rename goes to the server first; when it is refused the record keeps the old handle. Changes the old
        // handle has waiting are handled first: afterwards only the new one is read, and the server refuses the
        // rename while any are left.
        if (!this.thisDevice()) throw rules.bookingError('notBookingDevice');
        await this.poll().catch(unlessStale);
        await this.publish({ force: true, settings });
      }
      const page = this.file.page;
      const written = await this.writeSettings((pulled) => {
        const merged = rules.mergeSettings(pulled || current, patch);
        return { ...merged, url: page && page.handle === settings.handle && page.url ? page.url : merged.url };
      });
      if (chosen.length && on && written) await this.videoStays(current, settings, chosen);
      if (on && this.thisDevice() && written) await this.publish({ force: true, settings: written }).catch(unlessStale);
      return this.state();
    }).finally(() => this.changed());
  }

  // After a save that chose a video service (chosen: those types' indexes in settings): whether this computer still
  // handles bookings, now that the change is up. Another one may have taken over between the question before it and
  // the push, and may run a Rukoo from before video services. When one did, or the server can't say, those types get
  // back the location they had before (none for a type the save added), and the save is refused. Other changes stay.
  async videoStays(before, settings, chosen) {
    let failure = null;
    try {
      this.setPage(await this.call('GET', '/v1/booking'));
      if (this.status() !== 'on' || this.thisDevice()) return;
    } catch (err) {
      unlessStale(err);
      failure = err;
    }
    const was = new Map((Array.isArray(before.types) ? before.types : []).filter(plain).map((x) => [x.slug, x.location]));
    const picked = new Map(chosen.map((i) => [settings.types[i].slug, settings.types[i].location.service]));
    const none = { kind: 'none', label: '', value: '', public: false };
    const back = (x) => (plain(x) && picked.has(x.slug) && plain(x.location) && x.location.kind === 'video' && x.location.service === picked.get(x.slug) ? { ...x, location: was.get(x.slug) || none } : x);
    await this.writeSettings((pulled) => {
      const s = pulled || settings;
      return { ...s, types: s.types.map(back) };
    });
    throw failure || rules.bookingError('videoElsewhere', { code: 'invalid', field: `types[${chosen[0]}].location.kind` });
  }

  // Turns the page off (contracts g): the server deletes the page and its bookings and keeps the handle for this
  // account; the settings stay, so turning it on again starts from them. The mapping records go.
  async disable() {
    return this.exclusive(async () => {
      await this.requireSupported();
      await this.call('DELETE', '/v1/booking');
      this.forgetBookings();
      await this.refresh();
      return this.state();
    }).finally(() => this.changed());
  }

  forgetBookings() {
    const acct = this.acct;
    if (acct) for (const { k } of this.account.list('booking')) if (k.startsWith(`map:${acct}:`) || k.startsWith(`meeting:${acct}:`)) this.account.remove('booking', k);
    Object.assign(this.file, { rows: {}, handled: {}, seen: {}, unopened: {}, unmoved: {}, cursor: 0, notices: [], unchecked: [], lost: false });
    this.file.publish = { ...emptyFile().publish };
    if (this.file.page) this.file.page = { ...this.file.page, enabled: false, device: null, today: null };
    this.opened.clear();
    this.moves.clear();
  }

  // Before the Rukoo account is deleted (decision 22): the page goes first, and when that fails the account stays.
  // A server without booking pages, or one that answers 404 (an older server, or no page), has nothing to delete.
  // AccountService.deleteAccount has checked the password by then. In turn with publishes, so none of them can put
  // the page back while it goes.
  async disableForDelete() {
    if (!this.account.signedIn) return;
    if (this.supported() === null) await this.account.serverInfo().catch(() => {});
    if (this.supported() !== true) return;
    for (const name of ['publish', 'reconcile']) {
      clearTimeout(this.timers.soon.get(name));
      this.timers.soon.delete(name);
    }
    // Only the page of the session whose account is being deleted: one that ended before or during the call counts as
    // a failure, so the account isn't deleted then.
    const session = this.account.session;
    const deleted = await this.exclusive(async () => {
      try {
        if (this.account.session !== session) throw staleError();
        await this.after(this.account.bookingCall('DELETE', '/v1/booking'));
      } catch (err) {
        if (err && err.status === 404) return false;
        throw rules.bookingError('deleteFirst');
      }
      this.forgetBookings();
      return true;
    });
    // A session that ended while the call waited in the queue gets a state back from exclusive(), not an answer: the
    // page wasn't deleted, so neither may the account be.
    if (typeof deleted !== 'boolean') throw rules.bookingError('deleteFirst');
    if (deleted) this.changed();
  }

  async takeover() {
    return this.exclusive(async () => {
      await this.requireSupported();
      await this.refresh();
      if (this.status() !== 'on') throw rules.bookingError('notOn');
      await this.after(this.account.sync().catch(() => {}));
      await this.after(this.calendars.loadCalendars().catch(() => []));
      this.seedAvailability();
      const settings = this.settings();
      if (!settings) throw rules.bookingError('notOn');
      // Bookings are written to the destination calendar from here on: a computer without it would make no events.
      this.destinationOf(settings.destination);
      await this.publish({ force: true, takeover: true, settings });
      const page = this.file.page;
      await this.writeSettings((current) => ({ ...(current || settings), device: page && page.device ? page.device.id : null }));
      await this.poll().catch(unlessStale);
      return this.state();
    }).finally(() => this.changed());
  }

  // A computer that takes over and never chose calendars for availability takes the set the page was published with
  // (decision 17).
  seedAvailability() {
    const chosen = (this.engine.settings.calendar || {}).availability || {};
    if (Object.keys(chosen).length) return;
    const published = this.record('published');
    if (!plain(published) || !Array.isArray(published.availability)) return;
    const wanted = new Set(published.availability);
    const patch = {};
    for (const acc of this.calendars.list()) {
      for (const c of acc.calendars) patch[calendarKey(acc.id, c.id)] = wanted.has(rules.portableKey(acc.email, c.id));
    }
    if (Object.keys(patch).length && typeof this.engine.calendarSettings === 'function') this.engine.calendarSettings({ availability: patch });
  }

  async checkHandle(handle) {
    const h = typeof handle === 'string' ? handle.trim().slice(0, 64) : '';
    const problem = rules.handleProblem(h);
    if (problem) return { handle: h, available: false, reason: problem };
    await this.requireSupported();
    const res = await this.call('GET', `/v1/booking/handles/${encodeURIComponent(h)}`);
    const reason = ['taken', 'reserved', 'invalid', 'yours'].includes(res && res.reason) ? res.reason : null;
    // The handle of the account this device deleted and made again: reserved for the key it kept, which the publish
    // sends.
    const settings = this.settings();
    if (reason === 'reserved' && settings && settings.handle === h && this.account.handleKeyFor && this.account.handleKeyFor(this.account.status().email)) return { handle: h, available: true, reason: null };
    return { handle: h, available: Boolean(res && res.available), reason };
  }

  // ---------- publishing ----------

  // Makes the key pair the first time: only after a pull that completed shows the account has none, written as a
  // first write so two devices end up with the same one, and used only once the server has it and it was read back.
  async ensureKey() {
    const acct = this.acct;
    if (!acct) throw rules.bookingError('signedOut', { code: 'signed_out' });
    const ready = () => {
      const st = this.account.recordState('bookingkey', acct);
      return st && !st.dirty && st.seq !== null;
    };
    if (!this.account.get('bookingkey', acct)) {
      try {
        await this.after(this.account.sync());
      } catch (err) {
        unlessStale(err);
        throw rules.bookingError('noKey');
      }
      if (!this.account.get('bookingkey', acct)) this.account.put('bookingkey', acct, keys.newKeyring(this.now()), { ifAbsent: true });
    }
    // The first sync sends it, or brings the one another device wrote first.
    for (let i = 0; i < 3 && !ready(); i++) await this.after(this.account.sync().catch(() => {}));
    if (!ready()) throw rules.bookingError('noKey');
    // Then it is read back: a pull after the server stored it must still give this key.
    const kid = this.account.get('bookingkey', acct).current;
    if (this.keyRead !== `${acct}\n${kid}`) {
      await this.after(this.account.sync().catch(() => {}));
      if (!ready() || this.account.get('bookingkey', acct).current !== kid) throw rules.bookingError('noKey');
      this.keyRead = `${acct}\n${kid}`;
    }
    const opened = this.keyring();
    if (!opened) throw rules.bookingError('keyMismatch');
    return opened;
  }

  // The windows and busy times to publish (design 2.9). Busy time is read per account, so a calendar that can't be
  // read is published from its last good snapshot (up to 12 hours), after which every type waits for the host.
  async payload(settings, opened) {
    const now = this.now();
    const zone = settings.timeZone;
    const horizon = Math.max(...settings.types.map((x) => x.horizon));
    const buffer = Math.max(0, ...settings.types.map((x) => Math.max(x.bufferBefore, x.bufferAfter))) * MINUTE;
    const today = zonedParts(now, zone).date;
    const from = zonedInstant(today, '00:00', zone);
    const to = Math.min(zonedInstant(addDays(today, horizon + 1), '00:00', zone), now + 91 * DAY);
    const weekly = settings.hours.custom && settings.hours.weekly ? settings.hours.weekly : workWeekly(this.engine.settings.calendar);
    const overrides = {};
    for (const [date, ranges] of Object.entries(settings.overrides)) if (date >= today) overrides[date] = ranges;
    const windows = openWindows({ weekly, overrides, timeZone: zone, from, to });

    const set = await this.after(this.calendars.availabilitySet());
    const accounts = new Map();
    for (const acc of this.calendars.list()) accounts.set(acc.id, acc);
    const byAccount = new Map();
    for (const key of set.keys) {
      const accountId = key.slice(0, key.indexOf('\n'));
      if (!byAccount.has(accountId)) byAccount.set(accountId, []);
      byAccount.get(accountId).push(key);
    }
    const failedIds = new Set(set.failed.map((f) => f.accountId));
    for (const f of set.failed) if (!byAccount.has(f.accountId)) byAccount.set(f.accountId, []);
    const active = new Map(Object.values(this.file.rows).filter((r) => ACTIVE.has(r.status)).map((r) => [r.id, r]));
    const busy = [];
    const unchecked = [];
    let confirmAll = false;
    for (const [accountId, list] of byAccount) {
      const acc = accounts.get(accountId);
      const email = lower(acc ? acc.email : (set.failed.find((f) => f.accountId === accountId) || {}).email);
      let ok = false;
      if (!failedIds.has(accountId) && list.length) {
        try {
          // A booking's own event is left out while it sits at the booking's time: the server already keeps that
          // time, and a guest moving the booking a little mustn't run into it. Every other event is busy, also one
          // with a booking id: the host moved it elsewhere, or its booking is gone (the page was turned off). The
          // same stretch busyTimes reads, so its read comes from this one.
          const read = await this.after(this.calendars.read({ start: from - buffer - DAY, end: to + buffer + DAY, calendars: list }));
          if (read.failed.length) throw new Error('unread');
          const ids = read.events.filter((e) => e.bookingId && active.has(e.bookingId) && e.start === active.get(e.bookingId).start && e.end === active.get(e.bookingId).end).map((e) => e.id);
          const r = await this.after(this.calendars.busyTimes({ start: from - buffer, end: to + buffer, calendars: list, timeZone: zone, exclude: { ids } }));
          if (!r.failed.length) {
            ok = true;
            busy.push(...r.intervals);
            this.file.busy[email] = { at: now, intervals: r.intervals };
          }
        } catch (err) {
          unlessStale(err);
          ok = false;
        }
      } else if (!failedIds.has(accountId)) ok = true;
      if (ok) continue;
      const last = this.file.busy[email];
      const fresh = Boolean(last && now - last.at <= LAST_GOOD);
      if (fresh) busy.push(...last.intervals.filter((i) => Array.isArray(i) && i[1] > from && i[0] < to + buffer));
      else confirmAll = true;
      unchecked.push({ accountId, email, since: last ? last.at : null, over: !fresh });
    }
    const destination = settings.destination ? this.resolve(settings.destination) : null;
    const availability = set.keys
      .map((key) => {
        const acc = accounts.get(key.slice(0, key.indexOf('\n')));
        return acc ? rules.portableKey(acc.email, key.slice(key.indexOf('\n') + 1)) : null;
      })
      .filter(Boolean)
      .sort()
      .slice(0, MAX_PUBLISHED);
    return {
      profile: rules.profileOf(settings, keys.published(opened), { confirmAll, invites: !(destination && destination.kind === 'demo') }),
      windows,
      busy: rules.publishedBusy(busy, windows, buffer),
      unchecked,
      availability
    };
  }

  // Publishes when the page changed since the last publish, or always with force. settings: what to publish when it
  // isn't the stored record yet (a rename, turning on). Only the booking device publishes; enabling and taking over
  // make this computer it.
  async publish({ force = false, takeover = false, settings: given = null, enabling = false } = {}) {
    if (!this.account.signedIn || this.supported() === false) return false;
    const settings = given || this.settings();
    if (!settings) return false;
    const routine = !enabling && !takeover;
    if (routine && (this.status() !== 'on' || !this.thisDevice())) return false;
    const opened = await this.ensureKey();
    const payload = await this.payload(settings, opened);
    const now = this.now();
    const body = { handle: settings.handle, enabled: true, profile: payload.profile, windows: { default: payload.windows }, busy: payload.busy };
    const hash = rules.payloadHash(body);
    this.file.unchecked = payload.unchecked;
    // Signed in again on the booking device: the page still names the old session until this publish takes over.
    if (!force && !this.resigned() && this.file.publish.ok && hash === this.file.publish.hash && now - this.file.publish.at < PUBLISH_EVERY) return false;
    if (routine) {
      // What this computer knows of the page can be minutes old. Another computer may have turned it off or taken
      // it over since, and the server takes a publish then: it would turn the page on again. So it asks first.
      await this.refresh();
      if (this.status() !== 'on' || !this.thisDevice()) return false;
    }
    if (takeover || this.resigned()) body.takeover = true;
    // After this device deleted the account and it was made again: the key that takes the old handle back.
    const reclaim = this.account.handleKeyFor ? this.account.handleKeyFor(this.account.status().email) : null;
    if (reclaim) body.reclaim = reclaim;
    try {
      this.setPage(await this.call('PUT', '/v1/booking', body));
      if (reclaim) this.account.dropHandleKey();
    } catch (err) {
      unlessStale(err);
      this.file.publish = { ...this.file.publish, at: now, ok: false, error: err.message };
      if (err.code === 'other_device') await this.refresh().catch(unlessStale);
      throw err;
    }
    this.file.publish = { at: now, lastOk: now, hash, ok: true, error: null };
    const published = this.record('published');
    const before = plain(published) && Array.isArray(published.availability) ? published.availability : null;
    if (!before || before.join('\n') !== payload.availability.join('\n')) this.account.put('booking', `published:${this.acct}`, { availability: payload.availability, at: now });
    this.persist();
    // Each publish also compares the booked events with the bookings (design 2.9, Reconciliation).
    await this.reconcile().catch(unlessStale);
    return true;
  }

  // ---------- polling and processing ----------

  // The bookings that changed since the cursor, under the same rules as a records pull (PROTOCOL.md). The booking
  // device then processes what it hasn't handled.
  async poll() {
    if (!this.account.signedIn || this.supported() === false) return;
    await this.refresh({ info: this.now() - this.last.info >= INFO_EVERY });
    const page = this.file.page;
    if (!page || !page.handle) return;
    await this.fetchRows(this.file.cursor, true);
    if (this.thisDevice() && page.enabled) {
      const opened = this.keyring();
      // A published key this computer doesn't have, or a page that still names this computer's old session: publish
      // first, or every booking action would be refused.
      if ((opened && page.keyId && !opened.keys.has(page.keyId)) || this.resigned()) await this.publish({ force: true }).catch(unlessStale);
      await this.processAll();
    }
    this.prune();
  }

  async fetchRows(since, moveCursor) {
    let from = since;
    let restarted = false;
    for (let n = 0; n < PAGES; n++) {
      const res = await this.call('GET', `/v1/booking/bookings?since=${from}&limit=${PAGE_LIMIT}`);
      const list = res && Array.isArray(res.bookings) ? res.bookings : [];
      const top = Number(res && res.seq);
      // The page was deleted or replaced: start again from the beginning, once.
      if (Number.isSafeInteger(top) && top < from) {
        if (restarted || !moveCursor) throw rules.bookingError('serverAnswer');
        restarted = true;
        from = 0;
        Object.assign(this.file, { cursor: 0, rows: {}, handled: {}, seen: {}, unopened: {}, unmoved: {} });
        continue;
      }
      if (list.length > PAGE_LIMIT) throw rules.bookingError('serverAnswer');
      let last = from;
      for (const r of list) {
        const seq = Number(r && r.seq);
        if (!Number.isSafeInteger(seq) || seq <= last || (Number.isSafeInteger(top) && seq > top)) throw rules.bookingError('serverAnswer');
        last = seq;
      }
      for (const r of list) {
        const row = cleanRow(r);
        if (row) this.file.rows[row.id] = row;
        if (row && !ACTIVE.has(row.status)) {
          delete this.file.unopened[row.id];
          // The guest's details stay in memory until the change is handled: its notification names the guest.
          if (row.version <= this.handledVersion(row)) this.opened.delete(row.id);
        }
      }
      from = last;
      if (moveCursor) this.file.cursor = from;
      if (!res.more || !list.length) break;
    }
  }

  handledVersion(row) {
    return Math.max(row.handledVersion || 0, this.file.handled[row.id] || 0);
  }

  async processAll() {
    const rows = Object.values(this.file.rows).sort((a, b) => a.seq - b.seq);
    for (const row of rows) {
      if (row.version <= this.handledVersion(row)) continue;
      try {
        await this.process(row);
      } catch (err) {
        unlessStale(err);
        // Another device took over, or the page is gone: nothing more to do here. Anything else is tried again.
        if (err && (err.code === 'other_device' || err.code === 'handle_lost')) break;
      }
    }
  }

  // One booking version (design 2.9, Processor), then handled with that version.
  async process(row) {
    const settings = this.settings();
    if (!settings) return;
    if (row.status === 'pending') {
      const guest = this.guestOf(row);
      if (!this.file.seen[row.id]) {
        this.file.seen[row.id] = 1;
        this.tell('request', row, guest, { request: row.id });
      }
    } else if (row.status === 'confirmed') {
      const guest = this.guestOf(row);
      // Without the guest's details the event can't be made; it waits for the key.
      if (!guest) return;
      const map = this.map(row.id);
      if (!map) {
        const ev = await this.createEvent(row, guest, settings);
        // Also a booking the guest already moved before this computer saw it; one the host accepted was seen as a
        // request.
        if (!this.file.seen[row.id]) {
          this.file.seen[row.id] = 1;
          this.tell('new', row, guest, { id: ev.id, start: ev.start });
        }
        await this.checkOverlap(row, guest, settings);
        if (!row.notify) this.budgetNotice(row, guest, settings);
      } else if (map.start !== row.start || map.end !== row.end) {
        const ev = await this.moveEvent(map, row, guest, settings);
        this.tell('rescheduled', row, guest, ev ? { id: ev.id, start: ev.start } : { start: row.start });
        await this.checkOverlap(row, guest, settings);
        if (!row.notify) this.budgetNotice(row, guest, settings);
      } else {
        this.writeMap({ ...map, version: row.version });
        // A meeting a crash or a failed step left at an earlier time of the booking.
        await this.followMeeting(row, guest);
      }
    } else if (row.status === 'cancelled' && row.cancelledBy === 'guest') {
      const map = this.map(row.id);
      const guest = map && map.guest ? map.guest : this.opened.get(row.id) || null;
      // Without a mapping record, and not a request this computer saw, another computer may have made the event
      // before its record came here: it is looked for by the booking.
      const target = map || (this.file.seen[row.id] ? null : await this.foundMap(row, settings));
      if (target) {
        await this.removeEvent(target, row.notify);
        if (map) this.writeMap({ ...map, version: row.version, cancelled: true });
        if (!row.notify) this.budgetNotice(row, guest, settings);
        // The event is gone; the calendar opens on the day it was.
        this.tell('cancelled', row, guest, { start: row.start });
        this.addNotice('guestCancelled', row, rules.shortName(guest && guest.name));
      } else if (this.file.seen[row.id]) {
        // A request the guest withdrew: it never had an event, so a notification says so and no notice is kept.
        this.tell('cancelled', row, guest, { start: row.start }, 'withdrawn');
      }
      // Its meeting goes too, also one made for an event that never got written.
      await this.endMeeting(row, map, rules.shortName(guest && guest.name));
      this.dropNotices(row.id, ['overlap']);
    } else this.dropNotices(row.id, ['overlap']);
    await this.handled(row);
  }

  // The booking version is handled. The UID the calendar gave the booking's event (in its mapping record, see
  // createEvent) goes along every time the server still has another, so a handled that failed and is tried again
  // still tells it.
  async handled(row) {
    const body = { action: 'handled', version: row.version };
    const map = this.map(row.id);
    if (map && typeof map.uid === 'string' && UID.test(map.uid) && row.uid && map.uid !== row.uid && !this.file.noUid) body.uid = map.uid;
    let res;
    try {
      res = await this.call('POST', `/v1/booking/bookings/${row.id}`, body);
    } catch (err) {
      // A server from before uid on handled refuses the field; the booking is handled without it.
      if (!body.uid || err.code !== 'invalid') throw err;
      this.file.noUid = true;
      delete body.uid;
      res = await this.call('POST', `/v1/booking/bookings/${row.id}`, body);
    }
    this.file.handled[row.id] = Math.max(this.file.handled[row.id] || 0, row.version);
    if (!ACTIVE.has(row.status)) this.opened.delete(row.id);
    const next = res && cleanRow(res.booking);
    if (next) this.file.rows[row.id] = next;
  }

  writeMap(map) {
    this.live();
    this.account.put('booking', this.mapKey(map.id || map.bookingId), map);
  }

  dropNotices(bookingId, kinds) {
    this.file.notices = this.file.notices.filter((n) => !(n.bookingId === bookingId && kinds.includes(n.kind)));
  }

  // A desktop notification (or a toast while Rukoo is focused; main.js decides) about a booking. text: which words,
  // when they aren't the kind's own (a withdrawn request is a guest's cancellation).
  tell(kind, row, guest, open, text = kind) {
    this.live();
    const settings = this.settings();
    const type = settings && settings.types.find((x) => x.slug === row.type);
    const params = { guest: rules.shortName(guest && guest.name) || t('booking.notifications.someone'), type: type ? type.title : row.type, when: whenText(row.start) };
    const keysFor = {
      new: ['booking.notifications.newTitle', 'booking.notifications.newBody'],
      request: ['booking.notifications.requestTitle', 'booking.notifications.requestBody'],
      rescheduled: ['booking.notifications.rescheduledTitle', 'booking.notifications.rescheduledBody'],
      cancelled: ['booking.notifications.cancelledTitle', 'booking.notifications.cancelledBody'],
      withdrawn: ['booking.notifications.withdrawnTitle', 'booking.notifications.withdrawnBody']
    }[text];
    try {
      this.notifyHost({ kind, title: t(keysFor[0]), body: t(keysFor[1], params), open });
    } catch (_) {
      // A notification that can't show doesn't stop the booking.
    }
  }

  // The mail budget was used up (contracts g): the change is in the calendar without mail. Only Google sends no mail
  // then; a CalDAV server that schedules mails anyway and the demo never does.
  budgetNotice(row, guest, settings) {
    const dest = settings.destination ? this.resolve(settings.destination) : null;
    if (!dest || dest.kind !== 'google') return;
    this.addNotice('mailBudget', row, rules.shortName(guest && guest.name));
  }

  // The event a booking becomes (design 2.9): the type's title with the host and the guest's short name in the
  // page's language, only host-written text in the description, the location's private value or Google Meet, and the
  // guest as attendee where the calendar sends invitations.
  eventInput(row, guest, settings, dest) {
    const type = settings.types.find((x) => x.slug === row.type) || { title: row.type, description: '', location: { kind: 'none', label: '', value: '' } };
    const locale = settings.locale;
    const name = rules.shortName(guest.name);
    const title = name ? translate(locale, 'booking.event.title', { type: type.title, host: settings.name, guest: name }) : translate(locale, 'booking.event.titleNoGuest', { type: type.title, host: settings.name });
    const url = settings.url || (this.file.page && this.file.page.url) || '';
    const description = [type.description, url ? translate(locale, 'booking.event.description', { url }) : ''].filter(Boolean).join('\n\n');
    const loc = type.location;
    const meet = loc.kind === 'googleMeet' && dest.conference;
    const location = loc.kind === 'googleMeet' || loc.kind === 'none' ? '' : loc.value || loc.label || '';
    const input = {
      accountId: dest.accountId,
      calendarId: dest.calendarId,
      title,
      location,
      description,
      allDay: false,
      start: row.start,
      end: row.end,
      timeZone: isZone(settings.timeZone) ? settings.timeZone : pcZone(),
      busy: true,
      guests: { add: [{ address: guest.email }] }
    };
    if (meet) input.addMeet = true;
    return input;
  }

  calendarKeys(accountId) {
    return this.calendars.list().filter((a) => a.id === accountId).flatMap((a) => a.calendars.map((c) => calendarKey(a.id, c.id)));
  }

  // The booking's event wherever it is in the destination account now, or null. Used before making one, so a retry
  // after a lost answer doesn't make a second (Google also looks its booking events up by id).
  async findEvent(row, accountId) {
    const keysOf = this.calendarKeys(accountId);
    if (!keysOf.length) return null;
    const read = await this.after(this.calendars.read({ start: Math.min(row.start, row.bookedStart) - DAY, end: Math.max(row.end, row.bookedEnd) + DAY, calendars: keysOf, maxAgeMs: 0 }));
    if (read.failed.length) throw rules.bookingError('calendarUnreadable');
    return read.events.find((e) => e.bookingId === row.id) || null;
  }

  // Every booking event of a mail account, by booking id (a list, as more than one event can carry an id; eventFor
  // picks), read fresh from its calendars from a month back to over a year ahead and around the given times. This
  // decides that an event is gone: this computer's copy of the calendar can be older than the event (another computer
  // made it), and the host may have moved it far. Throws when the account can't be read, so nothing is concluded from
  // a calendar that didn't answer.
  async bookingEvents(accountId, around = []) {
    const keysOf = this.calendarKeys(accountId);
    if (!keysOf.length) throw rules.bookingError('calendarUnreadable');
    const now = this.now();
    const start = Math.min(now - LOOK_BACK, ...around.map((a) => a.start - DAY));
    const end = Math.max(now + LOOK_AHEAD, ...around.map((a) => a.end + DAY));
    const read = await this.after(this.calendars.read({ start, end, calendars: keysOf, maxAgeMs: 0 }));
    if (read.failed.length) throw rules.bookingError('calendarUnreadable');
    return byBooking(read.events);
  }

  // Whether the calendar a mapping names is one this computer can read in its account: a booking whose event isn't
  // found there isn't gone when its calendar left the account's list (hidden, unsubscribed).
  mappedCalendarRead(map, accountId) {
    return this.calendarKeys(accountId).includes(calendarKey(accountId, map.calendarId));
  }

  // Where a booking's event is when this computer has no mapping record for it, in the mapping's shape; null when the
  // destination calendar isn't on this computer or has no event for it.
  async foundMap(row, settings) {
    const dest = settings.destination ? this.resolve(settings.destination) : null;
    if (!dest || !dest.accountId) return null;
    const ev = await this.findEvent(row, dest.accountId);
    if (!ev) return null;
    const acc = this.engine.accounts.find((a) => a.id === ev.accountId);
    return { id: row.id, accountEmail: lower(acc ? acc.email : dest.email), calendarId: ev.calendarId, eventId: ev.eventId, start: ev.start, end: ev.end };
  }

  async createEvent(row, guest, settings) {
    const dest = this.destinationOf(settings.destination);
    this.own.add(row.id);
    try {
      let ev = await this.findEvent(row, dest.accountId);
      // A meeting made for this booking before its event was: kept, so a retry doesn't make a second one.
      let meeting = this.keptMeeting(row.id);
      if (!ev) {
        const input = this.eventInput(row, guest, settings, dest);
        meeting = await this.meetingFor(row, guest, settings, input);
        // The kept meeting is on disk before the calendar write starts, not with the account's own save a second
        // later: after a crash in between, the retry would make a second meeting. When the disk refuses, the event
        // waits for the next try.
        if (meeting && !this.account.flush()) throw Object.assign(new Error(''), { code: 'not_saved' });
        // The booking's meeting is its one link, also when the type has used Google Meet since.
        if (meeting) delete input.addMeet;
        ev = await this.after(this.calendars.create(withMeeting(input, meeting && meeting.ref, { locale: settings.locale, name: videoName(meeting && meeting.ref) }), { notify: row.notify, bookingId: row.id, uid: row.uid }));
      } else if (ev.start !== row.start || ev.end !== row.end) {
        // Made for an earlier time of this booking (an answer that got lost, then the guest moved it): it goes to this one.
        ev = await this.moveTo(await this.intoCache(ev), row);
      }
      const acc = this.engine.accounts.find((a) => a.id === ev.accountId);
      // uid: the one the calendar gave the event (Google may ignore the booking's), kept before handled tells the
      // server, so a handled that fails still has it the next time. The booking's own when the server can't take it.
      const uid = typeof ev.uid === 'string' && UID.test(ev.uid) ? ev.uid : row.uid;
      // The meeting with the time it has, which followMeeting changes once the service takes the booking's.
      const video = meeting ? { video: { ...meeting.ref, start: meeting.start, end: meeting.end } } : {};
      this.writeMap({ id: row.id, accountEmail: lower(acc ? acc.email : dest.email), calendarId: ev.calendarId, eventId: ev.eventId, uid, version: row.version, type: row.type, start: row.start, end: row.end, guest, customLength: false, ...video });
      if (meeting) this.dropKept(row.id, meeting.ref);
      // A kept meeting made for an earlier time of the booking goes to this one.
      await this.followMeeting(row, guest);
      return ev;
    } finally {
      this.own.delete(row.id);
    }
  }

  accountFor(map) {
    return this.engine.accounts.find((a) => lower(a.email) === lower(map.accountEmail)) || null;
  }

  // The event of a mapping, in the cache the store changes events in. One the cache doesn't have is looked for fresh
  // (bookingEvents) and fetched into the cache, and only when that read finds none in the calendars the mapping's is
  // among is it gone (null). Throws when that can't be told: the calendar can't be read, its mail account isn't on
  // this computer, or the mapping's calendar left the account's list.
  async writableEvent(map, around) {
    const acc = this.accountFor(map);
    if (!acc) throw rules.bookingError('calendarUnreadable');
    const events = this.calendars.cache(acc.id).events;
    const hit = events.find((e) => e.calendarId === map.calendarId && e.eventId === map.eventId) || events.find((e) => e.bookingId === map.id);
    if (hit) return this.calendars.event(encodeId(acc.id, hit.calendarId, hit.eventId));
    const found = eventFor((await this.bookingEvents(acc.id, [around])).get(map.id), map);
    if (found) return this.intoCache(found);
    if (!this.mappedCalendarRead(map, acc.id)) throw rules.bookingError('calendarUnreadable');
    return null;
  }

  // An event read fresh, in the cache the store changes events in: its stretch is fetched into the cache, or else the
  // cached stretch again, which can be older than the event.
  async intoCache(found) {
    const cached = () => this.calendars.cache(found.accountId).events.some((e) => e.calendarId === found.calendarId && e.eventId === found.eventId);
    const fetches = [() => this.calendars.ensure(found.accountId, found.start - DAY, found.end + DAY), () => this.calendars.syncAccount(found.accountId), () => this.calendars.ensure(found.accountId, found.start - DAY, found.end + DAY)];
    for (const fetch of fetches) {
      if (cached()) break;
      await this.after(fetch().catch(() => {}));
    }
    if (!cached()) throw rules.bookingError('calendarUnreadable');
    return this.calendars.event(found.id);
  }

  // An event in the cache moved to the booking's time, with mail when the server's notify says so.
  async moveTo(ev, row) {
    const input = { accountId: ev.accountId, calendarId: ev.calendarId, title: ev.title, location: ev.location, description: ev.description, allDay: false, start: row.start, end: row.end };
    return (await this.after(this.calendars.update(ev.id, input, { notify: row.notify, etag: ev.etag, scope: 'one' }))) || ev;
  }

  // A guest's move: the event goes to the new time.
  async moveEvent(map, row, guest, settings) {
    this.own.add(row.id);
    try {
      const ev = await this.writableEvent(map, { start: Math.min(map.start, row.start), end: Math.max(map.end, row.end) });
      if (!ev) {
        // Gone from the calendar, as a fresh read showed: the booking is still on, so it gets its event again, with
        // the meeting it had.
        const video = videoOf(map);
        if (video) this.keepMeeting(row.id, video);
        this.account.remove('booking', this.mapKey(row.id));
        return this.createEvent(row, guest, settings);
      }
      const out = await this.moveTo(ev, row);
      this.writeMap({ ...map, version: row.version, start: row.start, end: row.end, customLength: false, calendarId: out.calendarId, eventId: out.eventId });
      await this.followMeeting(row, guest);
      return out;
    } finally {
      this.own.delete(row.id);
    }
  }

  // The event goes, with the provider's cancellation when notify. Nothing to do when a fresh read finds it gone, or
  // when its mail account isn't on this computer; a calendar that can't be read throws, because the event, and the
  // guest's invitation, may still be there.
  async removeEvent(map, notify) {
    if (!this.accountFor(map)) return;
    this.own.add(map.id);
    try {
      const ev = await this.writableEvent(map, { start: map.start, end: map.end });
      if (!ev) return;
      await this.after(
        this.calendars.remove(ev.id, { notify, etag: ev.etag, scope: 'one' }).catch((err) => {
          if (!err || err.code !== 'not_found') throw err;
        })
      );
    } finally {
      this.own.delete(map.id);
    }
  }

  // ---------- video meetings ----------

  // A meeting made for a booking whose event isn't written yet, as a record of the Rukoo account (end-to-end
  // encrypted, like the mapping record that takes the meeting over once the event exists): a retry, here or on a
  // computer that took over, uses the same meeting. It keeps the time the meeting has, so a booking moved meanwhile
  // moves the meeting too. { ref: { service, id, url }, start, end } or null.
  keptKey(id) {
    return `meeting:${this.acct}:${id}`;
  }

  keptMeeting(id) {
    const v = this.acct ? this.account.get('booking', this.keptKey(id)) : undefined;
    if (!plain(v) || typeof v.service !== 'string' || typeof v.url !== 'string') return null;
    return { ref: refOf(v), start: v.start, end: v.end };
  }

  // createEvent writes it to disk before the calendar write.
  keepMeeting(id, { ref, start, end }) {
    this.live();
    this.account.put('booking', this.keptKey(id), { ...refOf(ref), start, end });
  }

  // Only once the meeting is in the booking's mapping record, or the service deleted it: otherwise nothing would know
  // of it.
  dropKept(id, ref) {
    const kept = this.keptMeeting(id);
    if (kept && sameMeeting(kept.ref, ref)) this.account.remove('booking', this.keptKey(id));
  }

  // The meeting a booking's event gets: { ref: { service, id, url }, start, end }, with the time the meeting has. A
  // meeting made for the booking before its event could be written is the one, whatever its type says by now (another
  // location or service, or no type at all): the guest booked with it, and only so is it moved and deleted with the
  // booking. Otherwise a new one when the type uses a video service. null for another location, or when the service
  // can't make one: the event then goes in without a link, and a notice says why and what to do. input: the event,
  // for the meeting's title and zone.
  async meetingFor(row, guest, settings, input) {
    const kept = this.keptMeeting(row.id);
    if (kept) return kept;
    const type = settings.types.find((x) => x.slug === row.type);
    const loc = type && type.location;
    if (!loc || loc.kind !== 'video') return null;
    try {
      if (!this.video) throw Object.assign(new Error(''), { code: 'off' });
      const made = await this.after(this.video.create(loc.service, { title: input.title, start: row.start, end: row.end, timeZone: input.timeZone }));
      const meeting = { ref: refOf(made), start: row.start, end: row.end };
      this.keepMeeting(row.id, meeting);
      return meeting;
    } catch (err) {
      unlessStale(err);
      this.addNotice('video', row, rules.shortName(guest && guest.name), videoProblem(loc.service, 'create', err));
      return null;
    }
  }

  // The booking's meeting at the booking's time, when the time its mapping record gives the meeting is another: right
  // after a move, and on each later pass (processing, reconciliation) until the service takes it, so a move that
  // failed, or that a crash or a failed step before it skipped, still happens. The record keeps the new time only once
  // the service took it. A failure leaves the meeting and its link as they were, with a notice once for each time the
  // booking gets: the passes that try again don't bring a dismissed one back.
  async followMeeting(row, guest) {
    const video = videoOf(this.map(row.id));
    if (!video || !this.video || (video.start === row.start && video.end === row.end)) return;
    const settings = this.settings();
    const zone = settings && isZone(settings.timeZone) ? settings.timeZone : pcZone();
    try {
      await this.after(this.video.update(video.ref, { start: row.start, end: row.end, timeZone: zone }));
    } catch (err) {
      unlessStale(err);
      if (this.file.unmoved[row.id] !== row.start) {
        this.file.unmoved[row.id] = row.start;
        this.addNotice('video', row, rules.shortName(guest && guest.name), videoProblem(video.ref.service, 'update', err));
      }
      return;
    }
    delete this.file.unmoved[row.id];
    this.file.notices = this.file.notices.filter((n) => !(n.id === `video:${row.id}` && n.op === 'update'));
    const map = this.map(row.id);
    if (map && sameMeeting(map.video, video.ref)) this.writeMap({ ...map, video: { ...video.ref, start: row.start, end: row.end } });
  }

  // A booking that ended takes its meeting with it: the one in its mapping record, and one kept for an event that
  // never got written. One the service couldn't delete stays, with a notice; the booking's other video notices go
  // only once every meeting is deleted.
  async endMeeting(row, map, name) {
    if (!this.video) return;
    const kept = this.keptMeeting(row.id);
    const all = [videoOf(map), kept].filter(Boolean).map((m) => m.ref);
    const refs = all.filter((r, i) => all.findIndex((x) => sameMeeting(x, r)) === i);
    let failed = null;
    for (const ref of refs) {
      try {
        await this.after(this.video.remove(ref));
        this.dropKept(row.id, ref);
      } catch (err) {
        unlessStale(err);
        failed = failed || { ref, err };
      }
    }
    if (failed) this.addNotice('video', row, name, videoProblem(failed.ref.service, 'delete', failed.err));
    else if (refs.length) this.dropNotices(row.id, ['video']);
  }

  // The video services that can't do their part on this computer, because they aren't connected here or the sign-in
  // needs renewing: those the meeting types use (types: their titles), and those whose meetings upcoming bookings
  // have, which a move or cancellation changes (bookings: how many). A Jitsi room needs nothing after it is made.
  videoMissing(settings) {
    if (!settings) return [];
    const by = new Map();
    const entry = (service) => {
      if (by.has(service)) return by.get(service);
      let status = 'off';
      try {
        status = this.video ? this.video.status(service) : 'off';
      } catch (_) {
        status = 'off';
      }
      const e = { service, name: videoName({ service }), status, types: [], bookings: 0 };
      by.set(service, e);
      return e;
    };
    for (const type of settings.types) if (type.location.kind === 'video') entry(type.location.service).types.push(type.title);
    const now = this.now();
    for (const row of Object.values(this.file.rows)) {
      if (row.status !== 'confirmed' || row.end <= now) continue;
      const map = this.map(row.id);
      const ref = (map && map.video) || (this.keptMeeting(row.id) || {}).ref;
      if (ref && typeof ref.service === 'string' && (!this.video || typeof this.video.manages !== 'function' || this.video.manages(ref.service))) entry(ref.service).bookings += 1;
    }
    return [...by.values()].filter((e) => e.status !== 'connected');
  }

  // A new or moved booking that overlaps something else on fresh busy data keeps its event; the host decides.
  async checkOverlap(row, guest, settings) {
    try {
      const busy = await this.after(this.calendars.busyTimes({ start: row.start, end: row.end, calendars: null, timeZone: settings.timeZone, exclude: { bookings: [row.id] }, maxAgeMs: 0 }));
      if (busy.intervals.some(([s, e]) => s < row.end && e > row.start)) this.addNotice('overlap', row, rules.shortName(guest && guest.name));
      else this.dropNotices(row.id, ['overlap']);
    } catch (err) {
      // Unknown: no notice either way.
      unlessStale(err);
    }
  }

  // ---------- reconciliation ----------

  // Booking events compared with the server's confirmed bookings (design 2.9): a moved event reschedules the booking,
  // one that is gone while the calendar was read cancels it, a guest who declined cancels it, and a changed length
  // stays the host's own.
  async reconcile() {
    if (!this.thisDevice() || this.status() !== 'on') return;
    const settings = this.settings();
    if (!settings) return;
    const now = this.now();
    const rows = Object.values(this.file.rows).filter((r) => r.status === 'confirmed' && r.end > now && this.map(r.id) && r.version <= this.handledVersion(r));
    if (!rows.length) return;
    const byAccount = new Map();
    for (const row of rows) {
      const acc = this.accountFor(this.map(row.id));
      if (!acc) continue;
      if (!byAccount.has(acc.id)) byAccount.set(acc.id, []);
      byAccount.get(acc.id).push(row);
    }
    for (const [accountId, list] of byAccount) {
      const keysOf = this.calendarKeys(accountId);
      if (!keysOf.length) continue;
      // Around each booking's time, and where the host just moved its event in Rukoo.
      const times = list.flatMap((r) => {
        const map = this.map(r.id);
        const moved = this.moves.get(r.id);
        return [r.start, r.end, map.start, map.end, ...(moved ? [moved.start, moved.end] : [])];
      });
      let events;
      try {
        const read = await this.after(this.calendars.read({ start: Math.min(...times) - DAY, end: Math.max(...times) + DAY, calendars: keysOf }));
        // Nothing is concluded from a calendar that couldn't be read.
        if (read.failed.length) continue;
        const all = byBooking(read.events);
        events = new Map();
        for (const r of list) {
          const ev = eventFor(all.get(r.id), this.map(r.id));
          if (ev) events.set(r.id, ev);
        }
      } catch (err) {
        unlessStale(err);
        continue;
      }
      // An event that isn't there may have moved further, or this computer's copy may be older than it (another
      // computer made it): only a fresh read over a wide stretch tells it is gone.
      const missing = list.filter((r) => !events.has(r.id) && !this.own.has(r.id));
      const unsure = new Set();
      if (missing.length) {
        try {
          const found = await this.bookingEvents(accountId, missing);
          for (const r of missing) {
            const ev = eventFor(found.get(r.id), this.map(r.id));
            if (ev) events.set(r.id, ev);
            // Not found, and its calendar wasn't among those read: nothing is concluded.
            else if (!this.mappedCalendarRead(this.map(r.id), accountId)) unsure.add(r.id);
          }
        } catch (err) {
          unlessStale(err);
          for (const r of missing) unsure.add(r.id);
        }
      }
      for (const row of list) {
        if (this.own.has(row.id) || unsure.has(row.id)) continue;
        this.moves.delete(row.id);
        const map = this.map(row.id);
        const ev = events.get(row.id);
        try {
          if (!ev) {
            await this.hostCancel(row, 'host_deleted');
            this.addNotice('hostDeleted', row, rules.shortName(map.guest && map.guest.name));
            continue;
          }
          const guest = (ev.attendees || []).find((a) => lower(a.address) === lower(map.guest && map.guest.email));
          if (guest && guest.response === 'declined') {
            await this.hostCancel(row, 'guest_declined');
            this.addNotice('guestDeclined', row, rules.shortName(map.guest.name));
            continue;
          }
          const custom = ev.end - ev.start !== row.end - row.start;
          let next = { ...map, calendarId: ev.calendarId, eventId: ev.eventId, customLength: custom };
          if (ev.start !== row.start) {
            const res = await this.call('POST', `/v1/booking/bookings/${row.id}`, { action: 'reschedule', version: row.version, start: ev.start, host: true });
            const moved = cleanRow(res && res.booking) || { ...row, start: ev.start, end: ev.start + (row.end - row.start) };
            this.file.rows[row.id] = moved;
            next = { ...next, version: moved.version, start: moved.start, end: moved.end };
            this.writeMap(next);
            // The meeting goes along before handled, which can fail; the passes after this one move it when it didn't.
            await this.followMeeting(moved, map.guest);
            await this.handled(moved);
            continue;
          }
          if (next.calendarId !== map.calendarId || next.eventId !== map.eventId || Boolean(map.customLength) !== custom) this.writeMap(next);
          await this.followMeeting(row, map.guest);
        } catch (err) {
          unlessStale(err);
          if (err && err.code === 'stale_version') await this.fetchRows(this.file.cursor, true).catch(unlessStale);
          else if (err && (err.code === 'other_device' || err.code === 'handle_lost')) return;
        }
      }
    }
  }

  async hostCancel(row, reason, message = null) {
    const body = { action: 'cancel', version: row.version, reason };
    if (message) body.message = message;
    const res = await this.call('POST', `/v1/booking/bookings/${row.id}`, body);
    const next = cleanRow(res && res.booking) || { ...row, status: 'cancelled', cancelledBy: 'host', reason, version: row.version + 1 };
    this.file.rows[row.id] = next;
    const map = this.map(row.id);
    if (map) this.writeMap({ ...map, version: next.version, cancelled: true });
    this.dropNotices(row.id, ['overlap', 'mailBudget']);
    await this.handled(next).catch(unlessStale);
    // Its meeting goes too, also one made for an event that never got written.
    await this.endMeeting(next, map, rules.shortName(map && map.guest && map.guest.name));
    return next;
  }

  // A booking event the user changed in Rukoo: a move or a delete on the booking device reschedules or cancels it.
  // Where the event went is kept for reconciliation, which then reads there.
  calendarChanged(c) {
    if (!c || this.status() !== 'on') return;
    this.soon('publish', this.timing.publishAfter);
    if (!this.thisDevice()) return;
    const ids = [c.event && c.event.bookingId, c.previous && c.previous.bookingId].filter(Boolean);
    const theirs = (id) => !this.own.has(id) && this.file.rows[id] && this.file.rows[id].status === 'confirmed';
    if (c.event && c.event.bookingId && theirs(c.event.bookingId) && Number.isFinite(c.event.start) && Number.isFinite(c.event.end)) this.moves.set(c.event.bookingId, { start: c.event.start, end: c.event.end });
    if (ids.some(theirs)) this.soon('reconcile', this.timing.reconcileAfter);
  }

  // The settings record or the key changed, here or on another device: the booking device publishes them. Mapping
  // records change with every booking and need no publish.
  recordsChanged() {
    const ring = this.keyring();
    const sig = `${JSON.stringify(this.record('settings') || null)}\n${ring ? ring.current : ''}`;
    if (sig !== this.recordsSeen) {
      const keyChanged = !this.recordsSeen || this.recordsSeen.slice(this.recordsSeen.lastIndexOf('\n') + 1) !== (ring ? ring.current : '');
      this.recordsSeen = sig;
      if (keyChanged) {
        this.opened.clear();
        this.file.unopened = {};
      }
      if (this.status() === 'on' && this.thisDevice()) this.soon('publish', 2000);
    }
    this.broadcast();
  }

  // Bookings and records 30 days past their meeting go.
  prune() {
    const now = this.now();
    for (const [id, row] of Object.entries(this.file.rows)) {
      const over = row.end < now - KEEP || (!ACTIVE.has(row.status) && row.updatedAt < now - KEEP);
      if (!over) continue;
      delete this.file.rows[id];
      delete this.file.handled[id];
      delete this.file.seen[id];
      delete this.file.unopened[id];
      delete this.file.unmoved[id];
      this.opened.delete(id);
      this.moves.delete(id);
    }
    this.file.notices = this.file.notices.filter((n) => this.file.rows[n.bookingId] && now - n.at < KEEP);
    const acct = this.acct;
    if (!acct || !this.thisDevice()) return;
    for (const { k, v } of this.account.list('booking')) {
      if ((k.startsWith(`map:${acct}:`) || k.startsWith(`meeting:${acct}:`)) && plain(v) && Number.isFinite(v.end) && v.end < now - KEEP) this.account.remove('booking', k);
    }
  }

  // ---------- what windows ask ----------

  async load({ refresh = false } = {}) {
    if (refresh && this.account.signedIn) {
      await this.exclusive(async () => {
        await this.refresh({ info: true });
        if (this.status() !== 'signed_out' && this.supported() !== false && this.file.page && this.file.page.handle) await this.fetchRows(this.file.cursor, true).catch(unlessStale);
      }).catch(() => {});
      this.changed();
    }
    return this.state();
  }

  // Sync now: the booking device publishes what changed, then polls and processes; others only read.
  async sync() {
    if (!this.account.signedIn) return this.state();
    await this.exclusive(async () => {
      await this.refresh({ info: true });
      if (this.status() === 'on' && this.thisDevice()) await this.publish().catch(unlessStale);
      await this.poll();
      await this.reconcile().catch(unlessStale);
    }).finally(() => this.changed());
    return this.state();
  }

  async details(id) {
    if (!rules.BOOKING_ID.test(String(id)) || !this.account.signedIn) return null;
    let row = this.file.rows[id];
    // A device without this booking (a fresh install, or one that forgot it) reads every booking once.
    if (!row && !this.fullRead && this.supported() !== false && this.file.page && this.file.page.handle) {
      this.fullRead = true;
      await this.exclusive(() => this.fetchRows(0, false)).catch(() => {});
      row = this.file.rows[id];
    }
    return row ? this.item(row) : null;
  }

  // accept, decline and cancel take a booking id; keep and dismiss a notice id (contracts f).
  async action(id, action, opts = {}) {
    const o = plain(opts) ? opts : {};
    if (action === 'keep' || action === 'dismiss') {
      if (!NOTICE_ID.test(String(id))) throw rules.bookingError('notFound');
      this.file.dismissed[id] = this.now();
      this.file.notices = this.file.notices.filter((n) => n.id !== id);
      this.changed();
      return this.state();
    }
    if (!['accept', 'decline', 'cancel'].includes(action) || !rules.BOOKING_ID.test(String(id))) throw rules.bookingError('notFound');
    const message = o.message === undefined || o.message === null ? null : String(o.message).replace(/\r\n?/g, '\n').trim();
    if (message && Array.from(message).length > 500) throw rules.bookingError('invalidMessage', { code: 'invalid', field: 'message' });
    return this.exclusive(async () => {
      this.requireSignedIn();
      this.requireDevice();
      const row = this.file.rows[id];
      if (!row) throw rules.bookingError('notFound');
      try {
        if (action === 'accept') await this.accept(row);
        else if (action === 'decline') await this.decline(row, { message, email: o.email === true });
        else await this.cancel(row, { message, notify: o.notify !== false });
      } catch (err) {
        // The booking changed meanwhile: the window gets it as it is now.
        if (err && err.code === 'stale_version') await this.fetchRows(this.file.cursor, true).catch(unlessStale);
        throw err;
      }
      return this.state();
    }).finally(() => this.changed());
  }

  async accept(row) {
    if (row.status !== 'pending') throw rules.bookingError('notFound');
    const res = await this.call('POST', `/v1/booking/bookings/${row.id}`, { action: 'confirm', version: row.version });
    const next = cleanRow(res && res.booking);
    if (!next) return;
    this.file.rows[row.id] = next;
    this.file.seen[row.id] = 1;
    await this.process(next);
  }

  async decline(row, { message, email }) {
    if (row.status !== 'pending') throw rules.bookingError('notFound');
    const guest = this.guestOf(row);
    const body = { action: 'decline', version: row.version };
    if (message) body.message = message;
    const res = await this.call('POST', `/v1/booking/bookings/${row.id}`, body);
    const next = cleanRow(res && res.booking) || { ...row, status: 'declined', version: row.version + 1 };
    this.file.rows[row.id] = next;
    await this.handled(next).catch(unlessStale);
    if (email && guest) await this.declineMail(row, guest, message);
  }

  // The short note to a declined guest, from the destination account (default off). Only the host's words and the
  // page's link: nothing the guest wrote.
  async declineMail(row, guest, message) {
    const settings = this.settings();
    if (!settings || !settings.destination) return;
    const dest = this.resolve(settings.destination);
    if (!dest || !dest.accountId) return;
    const type = settings.types.find((x) => x.slug === row.type);
    const locale = settings.locale;
    const tag = locale === 'nl' ? 'nl-NL' : 'en-GB';
    const when = new Intl.DateTimeFormat(tag, { timeZone: isZone(guest.timeZone) ? guest.timeZone : settings.timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(row.start);
    const url = settings.url || (this.file.page && this.file.page.url) || '';
    const subject = translate(locale, 'booking.decline.subject', { type: type ? type.title : row.type, when });
    const text = [message || translate(locale, 'booking.decline.body', { type: type ? type.title : row.type, when }), url ? translate(locale, 'booking.decline.again', { url }) : ''].filter(Boolean).join('\n\n');
    this.live();
    await this.after(this.engine.send({ accountId: dest.accountId, to: [{ name: '', address: guest.email }], subject, text }));
  }

  // A booking that is over isn't cancelled: its event is an ordinary one to delete by then, and the guest isn't told.
  async cancel(row, { message, notify }) {
    if (!ACTIVE.has(row.status) || row.end <= this.now()) throw rules.bookingError('notFound');
    const map = this.map(row.id);
    if (map && row.status === 'confirmed') await this.removeEvent(map, notify);
    try {
      await this.hostCancel(row, 'host_cancelled', message);
    } catch (err) {
      if (!err || err.code !== 'stale_version') throw err;
      // The guest moved the booking after this computer last saw it. The event and its cancellation are out already,
      // so the cancel goes to the booking as it is now; otherwise the next poll would make the event again.
      await this.fetchRows(this.file.cursor, true).catch(unlessStale);
      const current = this.file.rows[row.id];
      if (!current || !ACTIVE.has(current.status)) throw err;
      await this.hostCancel(current, 'host_cancelled', message);
    }
  }
}

// The account server's errors as booking errors: the server's code, its localised message and the refused field.
function asBookingError(err) {
  if (!err || err.booking) return err;
  const out = new Error(err.message || String(err));
  out.booking = true;
  out.code = err.code || 'server';
  out.status = err.status || 0;
  if (err.details && err.details.field) out.field = err.details.field;
  if (err.details && err.details.booking) out.current = err.details.booking;
  return out;
}

// Booking events by booking id: every event with an id, as more than one can carry it.
function byBooking(events) {
  const out = new Map();
  for (const e of events) if (e.bookingId) out.set(e.bookingId, [...(out.get(e.bookingId) || []), e]);
  return out;
}

// A booking's event among those with its id: the one its mapping names, else the first. Another event with the same
// id (copied, or someone else's that carries it) doesn't take the booking's place.
function eventFor(list, map) {
  if (!list || !list.length) return null;
  return (map && list.find((e) => e.calendarId === map.calendarId && e.eventId === map.eventId)) || list[0];
}

// The name of the video service a meeting or a location names: 'Zoom'.
function videoName(x) {
  const id = x && x.service;
  return rules.VIDEO_SERVICES[id] || String(id || '');
}

// A meeting's reference, as the video services take it.
function refOf(v) {
  return { service: v.service, id: typeof v.id === 'string' ? v.id : String(v.id || ''), url: v.url };
}

function sameMeeting(a, b) {
  return plain(a) && plain(b) && a.service === b.service && String(a.id || '') === String(b.id || '') && a.url === b.url;
}

// A mapping record's meeting with the time it has: { ref, start, end }, or null.
function videoOf(map) {
  const v = map && map.video;
  if (!plain(v) || typeof v.service !== 'string' || typeof v.url !== 'string') return null;
  return { ref: refOf(v), start: v.start, end: v.end };
}

// What a video notice keeps about a failure: the sign-in needs renewing, the service isn't connected here ('off', also
// without an OAuth client), or what the service said.
function videoProblem(service, op, err) {
  const code = err && err.code;
  if (code === 'renew') return { service, op, reason: 'renew' };
  if (code === 'off' || code === 'unavailable') return { service, op, reason: 'off' };
  return { service, op, reason: 'failed', error: String((err && err.message) || '').slice(0, 300) };
}

// The indexes of the meeting types whose video service the settings choose anew (a new type, or another location or
// service than the record has for its slug).
function newVideo(current, settings) {
  const before = new Map((plain(current) && Array.isArray(current.types) ? current.types : []).filter(plain).map((x) => [x.slug, x.location]));
  return settings.types.flatMap((x, i) => {
    if (x.location.kind !== 'video') return [];
    const was = before.get(x.slug);
    return !plain(was) || was.kind !== 'video' || was.service !== x.location.service ? [i] : [];
  });
}

// A list in a sentence, in the interface language: 'Zoom and Microsoft Teams'.
function listText(list) {
  try {
    return new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(list);
  } catch (_) {
    return list.join(', ');
  }
}

// A booking's time for the host, in the interface language and the PC's zone: 'Tue 3 Nov, 10:00'.
function whenText(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
}

module.exports = { Booking, cleanRow };
