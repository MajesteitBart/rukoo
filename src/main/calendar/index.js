'use strict';

const { t } = require('../../i18n');

// The calendars of every account that has one, for the calendar view. Each account's events are cached for one
// stretch of time around what the user has looked at; a view outside it fetches the missing weeks in the
// background and says so with 'updated'. Times are milliseconds; all-day events also carry their dates.
// The rest of Rukoo (free time, reminders, bookings, agents) reads through read() and busyTimes(), which leave the
// view's stretch, its loading state and 'updated' alone. Every change made here is followed by 'changed', and every
// successful sync by 'synced'.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { CALENDAR_SCOPES } = require('../google');
const { GoogleCalendar, calendarError, localDay, hasGuests } = require('./google');
const { CalDavCalendar } = require('./caldav');
const { DemoCalendar } = require('./demo');
const { isZone, zonedInstant, pcZone } = require('./zone');
const { merge: mergeIntervals } = require('./availability');

const DAY = 86400000;
// Fetched around what is on screen, so the next week is usually there already.
const PAD = 14 * DAY;
// A view further from the cached stretch than this starts a new one instead of stretching it.
const NEAR = 120 * DAY;
// A sync refetches the cached stretch, unless it has grown longer than this.
const MAX_SYNC = 180 * DAY;
// After a failed fetch, views wait this long before trying again; a sync or Retry tries right away.
const RETRY_AFTER = 60000;
const RESPONSES = new Set(['accepted', 'tentative', 'declined']);
const SCOPES = new Set(['one', 'following', 'all']);
// What read() fetched, and the view's stretch, serve later reads this long, unless they ask for fresher.
const MEMO_AGE = 5 * 60000;
// And what read() fetched is kept this long at all, so event() finds an event a reminder or a booking notice points
// at. The conflict line in the event dialog takes what is this old too: it shows what the grid shows, give or take.
const MEMO_KEEP = 30 * 60000;
// Parts of the view's stretch whose fetch time is kept; an older part counts as never fetched for read().
const FETCHED_MAX = 32;
// Stretches kept per calendar.
const MEMO_RANGES = 8;
// A Meet link Google is still making is read again this long after the change.
const CONFERENCE_DELAYS = [2000, 5000, 15000];
const SEARCH_YEAR = 365 * DAY;
const SEARCH_MAX = 200;
const CONFLICTS_MAX = 20;
const HEX = /^#[0-9a-f]{6}$/i;
// The same check the engine makes on addresses.
const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CONTROL = /[\x00-\x1f\x7f]/g;
const VISIBILITIES = new Set(['default', 'public', 'private', 'confidential']);
const METHODS = new Set(['popup', 'email']);
// The demo account's own calendars; its birthdays aren't.
const DEMO_OWNED = new Set(['personal', 'work']);

// The parts of a repeat rule Rukoo writes and reads, and what each may hold.
const DAYNAME = '(?:[+-]?(?:[1-9]|[1-4]\\d|5[0-3]))?(?:MO|TU|WE|TH|FR|SA|SU)';
const list = (item) => new RegExp(`^${item}(?:,${item})*$`);
const RULE_VALUES = {
  FREQ: /^(?:DAILY|WEEKLY|MONTHLY|YEARLY)$/,
  INTERVAL: /^[1-9]\d{0,3}$/,
  COUNT: /^[1-9]\d{0,3}$/,
  UNTIL: /^\d{8}(?:T\d{6}Z?)?$/,
  BYDAY: list(DAYNAME),
  BYMONTHDAY: list('[+-]?(?:[1-9]|[12]\\d|3[01])'),
  BYMONTH: list('(?:[1-9]|1[0-2])'),
  BYSETPOS: list('[+-]?[1-9]\\d{0,2}'),
  WKST: /^(?:MO|TU|WE|TH|FR|SA|SU)$/
};

function encodeId(accountId, calendarId, eventId) {
  return [accountId, calendarId, eventId].map(encodeURIComponent).join(':');
}

function decodeId(id) {
  const [accountId, calendarId, eventId] = String(id).split(':').map(decodeURIComponent);
  return { accountId, calendarId, eventId };
}

// A calendar's local key, as settings.calendar and read() name it.
const calendarKey = (accountId, calendarId) => `${accountId}\n${calendarId}`;
const covers = (range, start, end) => Boolean(range && range.start <= start && range.end >= end);
const overlaps = (e, start, end) => e.start < end && e.end > start;
const sameEvent = (a, b) => a.calendarId === b.calendarId && a.eventId === b.eventId;
// The events of one series, or the one event.
const inScope = (e, event, series) => e.calendarId === event.calendarId && (series && event.seriesId ? e.seriesId === event.seriesId : e.eventId === event.eventId);
const plain = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
// Busy for availability: shown as busy and not declined. Invitations not answered yet, and tentative ones, count.
const isBusy = (e) => e.busy !== false && e.response !== 'declined';
const refused = (key) => calendarError('refused', t(key));
// A provider's answer to a change to one event, apart from what the write did (written, from CalDAV), which only
// restamp() reads and which never reaches the cache or a window.
function apart(answer) {
  if (!answer || !Object.hasOwn(answer, 'written')) return { event: answer, written: null };
  const { written, ...event } = answer;
  return { event, written };
}

// An event the way the store hands it out. One cached before these fields existed gets them here.
function filled(e) {
  return {
    ...e,
    uid: e.uid ?? null,
    originalStart: e.originalStart ?? null,
    recurring: typeof e.recurring === 'boolean' ? e.recurring : Boolean(e.seriesId),
    reminders: e.reminders ?? null,
    visibility: VISIBILITIES.has(e.visibility) ? e.visibility : 'default',
    bookingId: e.bookingId ?? null,
    canInvite: e.canInvite === 'add' || e.canInvite === 'edit' ? e.canInvite : false,
    canMove: e.canMove === true,
    conference: e.conference ?? null,
    busy: typeof e.busy === 'boolean' ? e.busy : true
  };
}

// ---------- input checks ----------

function cleanRule(text) {
  const bad = () => calendarError('invalid', t('errors.calendar.invalidRule'));
  if (typeof text !== 'string' || !text.trim() || text.length > 500) throw bad();
  const rule = text.trim().toUpperCase();
  const parts = rule.split(';');
  const seen = new Map();
  for (const part of parts) {
    const m = /^([A-Z]+)=([A-Z0-9,+-]+)$/.exec(part);
    if (!m || !RULE_VALUES[m[1]] || seen.has(m[1]) || !RULE_VALUES[m[1]].test(m[2])) throw bad();
    seen.set(m[1], m[2]);
  }
  if (!parts[0].startsWith('FREQ=')) throw bad();
  // RFC 5545 allows only one of COUNT and UNTIL, and BYSETPOS picks from the days another part names.
  if (seen.has('COUNT') && seen.has('UNTIL')) throw bad();
  if (seen.has('BYSETPOS') && !seen.has('BYDAY') && !seen.has('BYMONTHDAY')) throw bad();
  return rule;
}

function cleanGuests(g) {
  const bad = () => calendarError('invalid', t('errors.calendar.invalidGuests'));
  if (!plain(g)) throw bad();
  const address = (a) => {
    const s = typeof a === 'string' ? a.trim().toLowerCase() : '';
    if (!s || s.length > 320 || !ADDRESS.test(s)) throw bad();
    return s;
  };
  const out = {};
  if (g.add !== undefined) {
    if (!Array.isArray(g.add) || g.add.length > 100) throw bad();
    const seen = new Set();
    out.add = [];
    for (const a of g.add) {
      if (!plain(a)) throw bad();
      const addr = address(a.address);
      if (seen.has(addr)) continue;
      seen.add(addr);
      out.add.push({ address: addr, name: typeof a.name === 'string' ? a.name.replace(CONTROL, ' ').trim().slice(0, 200) : '', optional: a.optional === true });
    }
  }
  if (g.remove !== undefined) {
    if (!Array.isArray(g.remove) || g.remove.length > 100) throw bad();
    out.remove = [...new Set(g.remove.map(address))];
  }
  if (g.optional !== undefined) {
    if (!plain(g.optional) || Object.keys(g.optional).length > 100) throw bad();
    out.optional = {};
    for (const [k, v] of Object.entries(g.optional)) {
      if (typeof v !== 'boolean') throw bad();
      out.optional[address(k)] = v;
    }
  }
  return out;
}

// Minutes before the start, up to 4 weeks. Below zero only on all-day events: a time on the day itself, counted
// from its midnight ("on the day at 09:00" is -540).
function cleanReminders(r, allDay) {
  const bad = () => calendarError('invalid', t('errors.calendar.invalidReminders'));
  if (!plain(r) || typeof r.useDefault !== 'boolean' || !Array.isArray(r.overrides) || r.overrides.length > 5) throw bad();
  const overrides = r.overrides.map((o) => {
    if (!plain(o) || !METHODS.has(o.method) || !Number.isInteger(o.minutes) || o.minutes < -1439 || o.minutes > 40320 || (o.minutes < 0 && !allDay)) throw bad();
    return { method: o.method, minutes: o.minutes };
  });
  return { useDefault: r.useDefault, overrides };
}

function matches(e, needle) {
  const fields = [e.title, e.location, e.description, ...(e.attendees || []).flatMap((a) => [a.name, a.address])];
  return fields.some((s) => String(s || '').toLowerCase().includes(needle));
}

// Which events an exclude option leaves out: booking events (all, or some by booking id) and events by public id.
function exclusion(exclude) {
  const x = plain(exclude) ? exclude : {};
  const bookings = x.bookings === 'all' ? 'all' : new Set(Array.isArray(x.bookings) ? x.bookings : []);
  const ids = new Set(Array.isArray(x.ids) ? x.ids : []);
  return (e) => ids.has(e.id) || Boolean(e.bookingId && (bookings === 'all' || bookings.has(e.bookingId)));
}

// Whether a change leaves everything but the guests as the event has it. The event's texts are compared as clean()
// leaves the input's: invitations from other calendars often end their title with a space.
function onlyGuests(e, input) {
  const times = input.allDay ? e.allDay && input.startDate === e.startDate && input.endDate === e.endDate : !e.allDay && input.start === e.start && input.end === e.end;
  const same = (k) => input[k] === undefined || input[k] === e[k];
  const text = (v, max) => String(v || '').slice(0, max);
  const texts = input.title === text(e.title, 1000).trim() && input.location === text(e.location, 1000).trim() && input.description === text(e.description, 20000);
  return times && texts && input.recurrence === undefined && input.reminders === undefined && input.addMeet === undefined && ['timeZone', 'busy', 'visibility'].every(same);
}

// One entry per account, the first failure it had.
function oncePerAccount(failed) {
  const seen = new Set();
  return failed.filter((f) => !seen.has(f.accountId) && seen.add(f.accountId));
}

class Calendars extends EventEmitter {
  constructor({ engine, fetchImpl = null }) {
    super();
    this.engine = engine;
    this.dataDir = engine.dataDir;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.providers = new Map();
    this.caches = new Map();
    this.queues = new Map();
    // Accounts with a fetch running or waiting, with how many.
    this.loading = new Map();
    this.saveTimers = new Map();
    // What read() fetched outside the view's stretch, per account and calendar: [{ start, end, at, events }].
    this.memos = new Map();
    // What a provider's own search found lately, per account: { at, events }. A result can lie outside every stretch
    // read so far, and its card opens before the view has fetched it.
    this.found = new Map();
    this.conferenceDelays = CONFERENCE_DELAYS;
    engine.on('account-removed', (acc) => this.forget(acc));
    // A new calendar server, or none: what the cache holds came from the old one.
    engine.on('calendar-changed', (acc) => {
      this.forget(acc);
      this.emit('updated');
    });
  }

  // ---------- accounts ----------

  // How an account gets its calendar: 'demo', 'google', 'caldav' for an account with a CalDAV server in its Server
  // settings, 'reconnect' for a Google account whose grant doesn't include the calendar, or null when Rukoo has no
  // calendar for the account.
  kind(acc) {
    if (acc.type === 'demo') return 'demo';
    if (acc.type === 'imap' && acc.auth !== 'oauth2' && acc.caldav && acc.caldav.url) return 'caldav';
    if (acc.provider !== 'google') return null;
    const scopes = acc.auth === 'oauth2' ? acc.scopes || [] : [];
    return CALENDAR_SCOPES.every((s) => scopes.includes(s)) ? 'google' : 'reconnect';
  }

  provider(acc) {
    const kind = this.kind(acc);
    if (kind !== 'demo' && kind !== 'google' && kind !== 'caldav') return null;
    const key = `${acc.id}:${kind}`;
    if (!this.providers.has(key)) {
      let p;
      if (kind === 'demo') p = new DemoCalendar(path.join(this.dataDir, 'demo-calendar.json'), acc);
      else if (kind === 'google') p = new GoogleCalendar({ token: () => this.engine.accessToken(this.engine.account(acc.id)), fetchImpl: this.fetch, timeZone: () => pcZone() });
      else {
        // The account's sign-in and addresses as they are at each request, so a new password applies right away. The
        // server is the one this provider was made for, also when Server settings name another one by the time it
        // finds its home; once they do, a request it still had running gets no password at all, so the new password
        // never reaches the old server.
        const current = () => this.engine.account(acc.id);
        const { url } = acc.caldav;
        p = new CalDavCalendar({
          url,
          home: acc.caldav.home || null,
          credentials: () => {
            const now = current();
            if (!now.caldav || now.caldav.url !== url) throw calendarError('reconfigured', t('errors.caldav.reconfigured'));
            return { user: (now.imap && now.imap.user) || now.email, password: this.engine.credentials(now) };
          },
          addresses: () => this.engine.identities(current()).map((i) => i.address),
          onHome: (home) => this.engine.setCalDavHome(acc.id, home, url),
          fetchImpl: this.fetch,
          // Whether the server sends invitations, as the user set it in Server settings; null leaves it to the server.
          invites: () => {
            const now = this.engine.accounts.find((a) => a.id === acc.id);
            return (now && now.caldavInvites) ?? null;
          },
          timeZone: () => pcZone()
        });
      }
      this.providers.set(key, p);
    }
    return this.providers.get(key);
  }

  accounts() {
    return this.engine.accounts.filter((a) => this.kind(a));
  }

  publicAccount(acc) {
    const kind = this.kind(acc);
    const cache = kind === 'reconnect' ? null : this.cache(acc.id);
    const error = cache && cache.error;
    let state = 'ready';
    if (kind === 'reconnect' || (error && (error.code === 'signin' || error.code === 'auth'))) state = 'reconnect';
    else if (error) state = 'error';
    return {
      id: acc.id,
      email: acc.email,
      name: acc.name || '',
      color: acc.color,
      kind,
      state,
      error: error || null,
      loading: this.loading.has(acc.id),
      syncedAt: (cache && cache.syncedAt) || null,
      calendars: cache ? cache.calendars.map((c) => this.publicCalendar(acc, c)) : []
    };
  }

  // The user's own choices for calendars: shown, counted toward availability, colour. See normalizeCalendar().
  choices() {
    const c = (this.engine.settings && this.engine.settings.calendar) || {};
    return { visible: plain(c.visible) ? c.visible : {}, availability: plain(c.availability) ? c.availability : {}, colors: plain(c.colors) ? c.colors : {} };
  }

  // Google names the primary calendar after the address; the account's name reads better under that address. A
  // calendar cached before Rukoo read colours, Meet and reminders gets the defaults here.
  publicCalendar(acc, cal) {
    const { id, name, primary, writable, selected } = cal;
    const own = primary && acc.name && name.toLowerCase() === String(acc.email).toLowerCase();
    const kind = this.kind(acc);
    const key = calendarKey(acc.id, id);
    const choices = this.choices();
    const owned = typeof cal.owned === 'boolean' ? cal.owned : kind === 'demo' ? DEMO_OWNED.has(id) : Boolean(primary);
    const providerColor = typeof cal.color === 'string' && HEX.test(cal.color) ? cal.color.toLowerCase() : null;
    const chosen = choices.colors[key];
    let invites = 'none';
    if (kind === 'google') invites = 'provider';
    else if (kind === 'caldav') invites = cal.invites === 'provider' || cal.invites === 'none' ? cal.invites : cal.scheduling === true ? 'provider' : 'none';
    return {
      id,
      name: own ? acc.name : name,
      primary,
      writable,
      selected,
      color: typeof chosen === 'string' && HEX.test(chosen) ? chosen : providerColor || acc.color,
      providerColor,
      conference: kind === 'google' && cal.conference === true,
      invites,
      timeZone: cal.timeZone || null,
      defaultReminders: Array.isArray(cal.defaultReminders) ? cal.defaultReminders : [],
      owned,
      // Read-only calendars never count by default; the eye toggle never changes it.
      availability: typeof choices.availability[key] === 'boolean' ? choices.availability[key] : Boolean(writable && (primary || owned)),
      visible: typeof choices.visible[key] === 'boolean' ? choices.visible[key] : Boolean(selected)
    };
  }

  // Guests can be edited only where the provider sends the invitations.
  publicEvent(acc, e) {
    const out = { ...filled(e), id: encodeId(acc.id, e.calendarId, e.eventId), accountId: acc.id };
    if (out.canInvite && this.invitesOf(acc, e.calendarId) !== 'provider') out.canInvite = false;
    return out;
  }

  invitesOf(acc, calendarId) {
    const kind = this.kind(acc);
    if (kind === 'google') return 'provider';
    if (kind !== 'caldav') return 'none';
    const cal = ((this.caches.get(acc.id) || {}).calendars || []).find((c) => c.id === calendarId);
    return cal ? this.publicCalendar(acc, cal).invites : 'none';
  }

  // The engine counts sign-ins as it installs each new grant; a failure from before the last one is about the old grant.
  grant(id) {
    return this.engine.grant(id);
  }

  // After signing in again: the account may have its calendar now, and an earlier sign-in error is gone.
  reconnected(id) {
    for (const key of this.providers.keys()) if (key.startsWith(`${id}:`)) this.providers.delete(key);
    this.dropMemos(id);
    const cache = this.caches.get(id);
    if (cache) {
      cache.error = null;
      cache.failedAt = null;
    }
    this.emit('updated');
    // What the cache holds is from before; fetch it again with the new grant.
    this.syncAccount(id).catch(() => {});
  }

  forget(acc) {
    const id = acc.id;
    for (const key of this.providers.keys()) if (key.startsWith(`${id}:`)) this.providers.delete(key);
    this.caches.delete(id);
    this.dropMemos(id);
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    fs.rmSync(this.file(id), { force: true });
    if (acc.type === 'demo') fs.rmSync(path.join(this.dataDir, 'demo-calendar.json'), { force: true });
  }

  // ---------- cache ----------

  file(id) {
    return path.join(this.dataDir, 'calendar', `${id}.json`);
  }

  cache(id) {
    if (!this.caches.has(id)) {
      let saved = null;
      try {
        saved = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
      } catch (_) {
        // Never opened, or the file is damaged: start empty.
      }
      // fetched: when each part of the stretch was last fetched, [{ start, end, at }], so read() knows how old it is.
      this.caches.set(id, { calendars: [], events: [], range: null, view: null, fetched: [], syncedAt: null, error: null, failedAt: null, ...(saved || {}) });
      // A cache from before canDelete: what could be changed could be deleted.
      for (const e of this.caches.get(id).events) if (e.canDelete === undefined) e.canDelete = Boolean(e.canEdit);
    }
    return this.caches.get(id);
  }

  persist(id) {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id);
        this.write(id);
      }, 250)
    );
  }

  write(id) {
    const cache = this.caches.get(id);
    if (!cache) return;
    const file = this.file(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(cache));
    fs.renameSync(`${file}.tmp`, file);
  }

  flush() {
    for (const [id, timer] of this.saveTimers) {
      clearTimeout(timer);
      this.write(id);
    }
    this.saveTimers.clear();
  }

  // One job at a time per account, so a sync, a view, a read and a change never fetch over each other.
  queue(id, job) {
    const run = (this.queues.get(id) || Promise.resolve()).then(job, job);
    this.queues.set(id, run.catch(() => {}));
    return run;
  }

  // A job that fetches for the view: the account shows as loading until it is done. read() never uses it.
  fetching(id, job) {
    this.loading.set(id, (this.loading.get(id) || 0) + 1);
    return this.queue(id, job).finally(() => {
      const n = this.loading.get(id) - 1;
      if (n > 0) this.loading.set(id, n);
      else this.loading.delete(id);
      this.emit('updated');
    });
  }

  // ---------- reading ----------

  // The events between start and end, from the cache. Missing weeks are fetched in the background.
  view({ start, end }) {
    const out = { accounts: [], events: [] };
    for (const acc of this.accounts()) {
      if (this.kind(acc) !== 'reconnect') {
        const cache = this.cache(acc.id);
        cache.view = { start, end };
        // A fetch that is already running says 'updated' when it is done, and the next view looks again.
        const waiting = this.loading.has(acc.id) || (cache.failedAt && Date.now() - cache.failedAt < RETRY_AFTER);
        if (!covers(cache.range, start, end) && !waiting) this.ensure(acc.id, start, end).catch(() => {});
        for (const e of cache.events) if (overlaps(e, start, end)) out.events.push(this.publicEvent(acc, e));
      }
      out.accounts.push(this.publicAccount(acc));
    }
    return out;
  }

  // The accounts and their cached calendars, without fetching and without touching the view: for settings pages and
  // the booking setup, which mustn't start fills or spin the sidebar.
  list() {
    return this.accounts().map((acc) => this.publicAccount(acc));
  }

  ensure(id, start, end) {
    return this.fetching(id, () => this.fill(id, start, end));
  }

  async fill(id, start, end) {
    const acc = this.engine.accounts.find((a) => a.id === id);
    const p = acc && this.provider(acc);
    if (!p) return;
    const cache = this.cache(id);
    if (covers(cache.range, start, end)) return;
    const grant = this.grant(id);
    try {
      const calendars = cache.calendars.length && cache.range ? cache.calendars : await p.calendars();
      const r = cache.range;
      const stretch = Boolean(r && start < r.end + NEAR && end > r.start - NEAR);
      let range;
      const windows = [];
      if (stretch) {
        range = { start: Math.min(r.start, start - PAD), end: Math.max(r.end, end + PAD) };
        if (range.start < r.start) windows.push({ start: range.start, end: r.start });
        if (range.end > r.end) windows.push({ start: r.end, end: range.end });
      } else {
        range = { start: start - PAD, end: end + PAD };
        windows.push(range);
      }
      const fetched = [];
      for (const w of windows) fetched.push({ w, events: await this.fetchEvents(p, calendars, w) });
      // Only now that every fetch worked does the cache change.
      const at = Date.now();
      cache.calendars = calendars;
      if (!stretch) cache.events = [];
      for (const { w, events } of fetched) this.merge(cache, w, events);
      cache.fetched = [...(stretch ? cache.fetched || [] : []), ...windows.map((w) => ({ start: w.start, end: w.end, at }))].slice(-FETCHED_MAX);
      cache.range = range;
      cache.syncedAt = cache.syncedAt || Date.now();
      cache.error = null;
      cache.failedAt = null;
    } catch (err) {
      this.failed(acc, cache, err, grant);
      throw err;
    } finally {
      this.persist(id);
    }
  }

  // Google filters all-day events by the calendar's own time zone, which can be a day off from the PC's. So it is
  // asked for two days more on each side, and only what overlaps the window on the PC's clock is kept.
  async fetchEvents(p, calendars, w) {
    const lists = await Promise.all(calendars.map((cal) => p.events(cal, w.start - 2 * DAY, w.end + 2 * DAY)));
    return lists.flat().filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end) && overlaps(e, w.start, w.end));
  }

  // The fetched window replaces whatever the cache had in it; an event that crosses its edge comes back in it.
  merge(cache, w, events) {
    const kept = cache.events.filter((e) => !overlaps(e, w.start, w.end));
    const seen = new Map();
    for (const e of [...kept, ...events]) seen.set(`${e.calendarId}\n${e.eventId}`, e);
    cache.events = [...seen.values()].sort((a, b) => a.start - b.start);
  }

  // grant: the account's sign-in count when the request started. A sign-in or scope failure from before the latest
  // sign-in is about the old grant and must not undo the new one.
  failed(acc, cache, err, grant = this.grant(acc.id)) {
    const stale = grant !== this.grant(acc.id);
    const code = err && err.calendar ? err.code : err && err.oauth && err.code === 'invalid_grant' ? 'signin' : 'error';
    if (stale && (code === 'scope' || code === 'signin' || code === 'auth')) return;
    if (code === 'scope') {
      // The grant doesn't cover the calendar after all; the account asks to sign in again.
      this.engine.setScopes(acc.id, (acc.scopes || []).filter((s) => !CALENDAR_SCOPES.includes(s)));
      cache.error = null;
      return;
    }
    cache.error = { code, message: (err && err.message) || String(err), url: (err && err.url) || null };
    cache.failedAt = Date.now();
  }

  // ---------- reads for the rest of Rukoo ----------

  // An account that couldn't be read, for the failed list: 'reconnect' when signing in again is what it needs.
  failure(acc, err) {
    const code = err && err.calendar ? err.code : err && err.oauth && err.code === 'invalid_grant' ? 'signin' : 'error';
    return { accountId: acc.id, email: acc.email, code: ['reconnect', 'auth', 'scope', 'signin'].includes(code) ? 'reconnect' : code };
  }

  // The events between start and end on the given calendars (local keys; null for every calendar), with the accounts
  // that couldn't be read. From the cache when the view's stretch covers them and was fetched at most maxAgeMs ago
  // (Infinity takes it at any age); otherwise read from the providers in the account's queue, without changing the
  // view's stretch or loading state and without 'updated', and kept for maxAgeMs so the next read doesn't ask again.
  // lastKnown: an account that can't be read gives its cached events, whatever their age, and is still in failed; for
  // the reminder runner, which would rather remind from what the calendar view shows than not at all.
  async read({ start, end, calendars = null, maxAgeMs = MEMO_AGE, lastKnown = false } = {}) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw calendarError('invalid', t('errors.calendar.invalidTimes'));
    const wanted = Array.isArray(calendars) ? new Set(calendars) : null;
    const age = typeof maxAgeMs === 'number' && maxAgeMs >= 0 ? maxAgeMs : MEMO_AGE;
    const events = [];
    const failed = [];
    await Promise.all(
      this.accounts().map(async (acc) => {
        if (wanted && ![...wanted].some((k) => k.startsWith(`${acc.id}\n`))) return;
        // A Google account whose calendar was never connected has no calendar to read; one that lost it fails below.
        if (!wanted && this.mailOnly(acc)) return;
        try {
          for (const e of await this.readAccount(acc, start, end, wanted, age)) events.push(this.publicEvent(acc, e));
        } catch (err) {
          failed.push(this.failure(acc, err));
          if (lastKnown) for (const e of this.cache(acc.id).events) if (overlaps(e, start, end) && (!wanted || wanted.has(calendarKey(acc.id, e.calendarId)))) events.push(this.publicEvent(acc, e));
        }
      })
    );
    events.sort((a, b) => a.start - b.start || a.end - b.end);
    return { events, failed };
  }

  async readAccount(acc, start, end, wanted, age) {
    if (this.kind(acc) === 'reconnect' || this.publicAccount(acc).state === 'reconnect') throw calendarError('reconnect', t('errors.calendar.signIn'));
    const p = this.provider(acc);
    if (!p) return [];
    const cache = this.cache(acc.id);
    const mine = (e) => !wanted || wanted.has(calendarKey(acc.id, e.calendarId));
    // A cache whose last fetch failed may be old, and so may one the user hasn't synced for a while (or since the last
    // start); only one fetched recently enough serves the read, and only while no read since knows better.
    const fresh = () => {
      const at = this.fetchedAt(cache, start, end);
      // Strictly younger, as for the memo, so maxAgeMs 0 always reads again.
      if (at === null || Date.now() - at >= age) return false;
      const newer = [...(this.memos.get(acc.id) || new Map()).values()].some((list) => list.some((m) => m.at >= at && m.start < end && m.end > start));
      return !newer;
    };
    const cached = () => (!cache.error && cache.calendars.length && covers(cache.range, start, end) && fresh() ? cache.events.filter((e) => overlaps(e, start, end) && mine(e)) : null);
    const hit = cached();
    if (hit) return hit;
    return this.queue(acc.id, async () => {
      const now = cached();
      if (now) return now;
      const cals = (await this.calendarsFor(acc, p, cache)).filter((c) => !wanted || wanted.has(calendarKey(acc.id, c.id)));
      const memo = this.memo(acc.id);
      const at = Date.now();
      const out = [];
      const missing = [];
      for (const cal of cals) {
        const kept = (memo.get(cal.id) || []).find((m) => m.start <= start && m.end >= end && at - m.at < age);
        if (kept) out.push(...kept.events.filter((e) => overlaps(e, start, end)));
        else missing.push(cal);
      }
      // Two days more on each side, as fetchEvents asks, and clipped afterwards.
      const lists = await Promise.all(missing.map((cal) => p.events(cal, start - 2 * DAY, end + 2 * DAY)));
      missing.forEach((cal, i) => {
        const events = lists[i].filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end) && overlaps(e, start, end));
        const kept = (memo.get(cal.id) || []).filter((m) => at - m.at <= MEMO_KEEP).slice(-(MEMO_RANGES - 1));
        memo.set(cal.id, [...kept, { start, end, at, events }]);
        out.push(...events);
      });
      return out;
    });
  }

  memo(id) {
    if (!this.memos.has(id)) this.memos.set(id, new Map());
    return this.memos.get(id);
  }

  // When the view's stretch was fetched between start and end: the oldest fetch that part rests on, or null when
  // some of it has no known fetch time (a cache from before Rukoo kept them).
  fetchedAt(cache, start, end) {
    const parts = (cache.fetched || []).filter((f) => f.start < end && f.end > start).sort((a, b) => a.start - b.start);
    let from = start;
    let at = Infinity;
    for (const f of parts) {
      if (f.start > from) return null;
      from = Math.max(from, f.end);
      at = Math.min(at, f.at);
    }
    return from >= end ? at : null;
  }

  // A Google account whose grant never covered the calendar: it has no calendars, cached or otherwise. One that lost
  // the calendar keeps the ones it had in its cache.
  mailOnly(acc) {
    return this.kind(acc) === 'reconnect' && !this.cache(acc.id).calendars.length;
  }

  // An account's calendars: the cached ones, or for an account whose calendar was never opened, the provider's,
  // which the cache keeps for the view.
  async calendarsFor(acc, p, cache) {
    if (cache.calendars.length) return cache.calendars;
    const cals = await p.calendars();
    cache.calendars = cals;
    this.persist(acc.id);
    return cals;
  }

  // Reads the calendars of every account whose calendar was never opened, for list(), without touching the view's
  // stretch or its loading state and without 'updated'. Returns the accounts that couldn't be read.
  async loadCalendars() {
    const failed = [];
    await Promise.all(
      this.accounts().map(async (acc) => {
        const p = this.provider(acc);
        if (!p) return;
        const cache = this.cache(acc.id);
        if (cache.calendars.length) return;
        try {
          await this.queue(acc.id, () => this.calendarsFor(acc, p, cache));
        } catch (err) {
          failed.push(this.failure(acc, err));
        }
      })
    );
    return failed;
  }

  // The calendars that count toward availability, as local keys, and the accounts that couldn't say which. A Google
  // account that lost its calendar can't say when it is busy, so it fails when its cached calendars counted; one whose
  // calendar was never connected has nothing that counts and isn't named.
  async availabilitySet() {
    const failed = await this.loadCalendars();
    const keys = [];
    for (const acc of this.accounts()) {
      if (failed.some((f) => f.accountId === acc.id)) continue;
      const counted = this.cache(acc.id).calendars.filter((c) => this.publicCalendar(acc, c).availability);
      if (this.kind(acc) === 'reconnect') {
        if (counted.length) failed.push(this.failure(acc, calendarError('reconnect', t('errors.calendar.signIn'))));
      } else for (const c of counted) keys.push(calendarKey(acc.id, c.id));
    }
    return { keys, failed };
  }

  // Where an event is busy in a zone: timed events at their moments, all-day events from midnight to midnight of
  // their dates in that zone, not on the PC's clock the cache keeps them on.
  span(e, timeZone) {
    if (e.allDay && e.startDate && e.endDate) {
      try {
        return [zonedInstant(e.startDate, '00:00', timeZone), zonedInstant(e.endDate, '00:00', timeZone)];
      } catch (_) {
        // A damaged date; the cached moments will do.
      }
    }
    return [e.start, e.end];
  }

  // Busy time between start and end, merged, sorted and clipped to the range, for free time and the booking page.
  // calendars null means the calendars that count toward availability. Accounts that couldn't be read are named in
  // failed, never taken as free. allDay lists every all-day event in the range, busy or not, for day headers.
  // maxAgeMs: as for read().
  async busyTimes({ start, end, calendars = null, timeZone, exclude = {}, maxAgeMs } = {}) {
    if (!isZone(timeZone)) throw calendarError('invalid', t('errors.calendar.invalidZone'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw calendarError('invalid', t('errors.calendar.invalidTimes'));
    const set = Array.isArray(calendars) ? { keys: calendars, failed: [] } : await this.availabilitySet();
    // A day wider: an all-day event's dates in the zone can lie a day off from the PC's.
    const read = await this.read({ start: start - DAY, end: end + DAY, calendars: set.keys, maxAgeMs });
    const skip = exclusion(exclude);
    const intervals = [];
    const allDay = [];
    for (const e of read.events) {
      if (skip(e)) continue;
      const [s, en] = this.span(e, timeZone);
      if (!(s < end && en > start)) continue;
      if (e.allDay) allDay.push({ id: e.id, accountId: e.accountId, calendarId: e.calendarId, startDate: e.startDate, endDate: e.endDate, title: e.title, busy: isBusy(e) });
      if (isBusy(e) && en > s) intervals.push([Math.max(s, start), Math.min(en, end)]);
    }
    return { intervals: mergeIntervals(intervals), allDay, failed: oncePerAccount([...set.failed, ...read.failed]) };
  }

  // Busy events on the availability calendars that overlap a time, for the conflict line in the event dialog. It asks
  // again each time the times change, so it takes the view's stretch and earlier reads up to half an hour old.
  async conflicts({ start, end, exclude = [] } = {}) {
    const set = await this.availabilitySet();
    const read = await this.read({ start, end, calendars: set.keys, maxAgeMs: MEMO_KEEP });
    const skip = new Set(exclude);
    const events = read.events
      .filter((e) => !skip.has(e.id) && isBusy(e) && e.end > e.start && overlaps(e, start, end))
      .slice(0, CONFLICTS_MAX)
      .map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay }));
    return { events, failed: oncePerAccount([...set.failed, ...read.failed]) };
  }

  // Events whose title, place, description or guests contain the query. Google searches a year back and ahead
  // itself; other calendars are read from 30 days back to 180 days ahead and searched here.
  async search(query) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q || q.length > 200) throw calendarError('invalid', t('errors.calendar.invalidQuery'));
    const needle = q.toLowerCase();
    const now = Date.now();
    const events = [];
    const failed = [];
    await Promise.all(
      this.accounts().map(async (acc) => {
        try {
          if (this.kind(acc) === 'reconnect') throw calendarError('reconnect', t('errors.calendar.signIn'));
          const p = this.provider(acc);
          if (!p) return;
          if (typeof p.search === 'function') {
            const cache = this.cache(acc.id);
            const found = await this.queue(acc.id, async () => {
              const cals = await this.calendarsFor(acc, p, cache);
              return (await Promise.all(cals.map((cal) => p.search(cal, q, now - SEARCH_YEAR, now + SEARCH_YEAR)))).flat();
            });
            this.found.set(acc.id, { at: Date.now(), events: found });
            for (const e of found) events.push(this.publicEvent(acc, e));
          } else {
            for (const e of await this.readAccount(acc, now - 30 * DAY, now + 180 * DAY, null, MEMO_AGE)) if (matches(e, needle)) events.push(this.publicEvent(acc, e));
          }
        } catch (err) {
          failed.push(this.failure(acc, err));
        }
      })
    );
    events.sort((a, b) => a.start - b.start);
    return { events: events.slice(0, SEARCH_MAX), failed };
  }

  // ---------- sync ----------

  // Fetches the calendars and the cached stretch again. An account whose calendar was never opened waits for that.
  syncAccount(id) {
    const acc = this.engine.accounts.find((a) => a.id === id);
    if (!acc || !this.provider(acc)) return Promise.resolve();
    const cache = this.cache(id);
    if (!cache.range && !cache.view) return Promise.resolve();
    return this.fetching(id, async () => {
      const p = this.provider(acc);
      if (!p) return;
      const grant = this.grant(id);
      let range = cache.range;
      if (!range || range.end - range.start > MAX_SYNC) {
        const v = cache.view || { start: Date.now(), end: Date.now() + 7 * DAY };
        range = { start: v.start - PAD, end: v.end + PAD };
      }
      try {
        const calendars = await p.calendars();
        const events = await this.fetchEvents(p, calendars, range);
        const at = Date.now();
        Object.assign(cache, { calendars, range, events: [], fetched: [{ start: range.start, end: range.end, at }], syncedAt: at, error: null, failedAt: null });
        this.merge(cache, range, events);
        this.dropMemos(id);
      } catch (err) {
        this.failed(acc, cache, err, grant);
        throw err;
      } finally {
        this.persist(id);
      }
    }).then(() => {
      this.emit('synced', { accountId: id });
    });
  }

  async syncAll() {
    const errors = [];
    await Promise.all(this.accounts().map((a) => this.syncAccount(a.id).catch((err) => errors.push(`${a.email}: ${err.message}`))));
    if (errors.length) throw new Error(errors.join('\n'));
  }

  // ---------- changes ----------

  locate(id) {
    const { accountId, calendarId, eventId } = decodeId(id);
    const acc = this.engine.accounts.find((a) => a.id === accountId);
    const p = acc && this.provider(acc);
    if (!p) throw calendarError('not_found', t('errors.calendar.notFound'));
    const cache = this.cache(accountId);
    const cal = cache.calendars.find((c) => c.id === calendarId);
    const event = cache.events.find((e) => e.calendarId === calendarId && e.eventId === eventId);
    if (!cal || !event) throw calendarError('not_found', t('errors.calendar.notFound'));
    return { acc, p, cache, cal, event };
  }

  // locate(), or for an answer an event outside the view's stretch that read() fetched lately: an invitation answered
  // from its email (findInvite), whose week the calendar may never have shown.
  locateAnswerable(id) {
    try {
      return this.locate(id);
    } catch (err) {
      const { accountId, calendarId, eventId } = decodeId(id);
      const acc = this.engine.accounts.find((a) => a.id === accountId);
      const cache = acc && this.provider(acc) ? this.cache(accountId) : null;
      const cal = cache && cache.calendars.find((c) => c.id === calendarId);
      const event = cal && this.recent(accountId, calendarId, (x) => x.calendarId === calendarId && x.eventId === eventId);
      if (!event) throw err;
      return { acc, p: this.provider(acc), cache, cal, event };
    }
  }

  // What a new or changed event may contain, checked again here because it comes from the renderer. The newer fields
  // are copied only when given: on a change, a missing one stays as it is.
  clean(input) {
    const text = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
    const out = {
      title: text(input.title, 1000).trim(),
      location: text(input.location, 1000).trim(),
      description: text(input.description, 20000),
      allDay: input.allDay === true
    };
    const date = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(localDay(d));
    if (out.allDay) {
      if (!date(input.startDate) || !date(input.endDate) || input.endDate <= input.startDate) throw calendarError('invalid', t('errors.calendar.invalidTimes'));
      out.startDate = input.startDate;
      out.endDate = input.endDate;
    } else {
      const start = Number(input.start);
      const end = Number(input.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw calendarError('invalid', t('errors.calendar.invalidTimes'));
      out.start = start;
      out.end = end;
    }
    if (input.timeZone !== undefined) {
      if (!isZone(input.timeZone)) throw calendarError('invalid', t('errors.calendar.invalidZone'));
      out.timeZone = input.timeZone;
    }
    if (input.guests !== undefined) out.guests = cleanGuests(input.guests);
    if (input.recurrence !== undefined) out.recurrence = input.recurrence === null ? null : cleanRule(input.recurrence);
    if (input.reminders !== undefined) out.reminders = cleanReminders(input.reminders, out.allDay);
    if (typeof input.busy === 'boolean') out.busy = input.busy;
    if (VISIBILITIES.has(input.visibility)) out.visibility = input.visibility;
    if (typeof input.addMeet === 'boolean') out.addMeet = input.addMeet;
    return out;
  }

  // Runs a change; an event that is gone from the calendar leaves the cache, and a missing grant asks to reconnect.
  async change(acc, cache, event, job) {
    let grant = this.grant(acc.id);
    try {
      return await this.queue(acc.id, () => {
        grant = this.grant(acc.id);
        return job();
      });
    } catch (err) {
      if (err && err.code === 'not_found' && event) {
        cache.events = cache.events.filter((e) => !sameEvent(e, event));
        this.persist(acc.id);
        this.emit('updated');
      }
      if (err && err.code === 'scope') {
        this.failed(acc, cache, err, grant);
        this.emit('updated');
      }
      throw err;
    } finally {
      // Whatever was read outside the view may be out of date now.
      this.dropMemos(acc.id);
    }
  }

  // A change made on the version of the event the user saw (etag). When the provider has a newer one, the change
  // fails and the cache gets that version, so the user sees it before trying again; when the event is gone, it leaves
  // the cache. An event cached before Rukoo kept versions has none to send, so it counts as changed as well.
  // series: the change is to the whole series the event belongs to. Then only this occurrence can turn out to be
  // gone; the series may still be there, so that counts as changed, and only the occurrence leaves the cache.
  async unlessChanged(acc, p, cache, cal, event, etag, job, { series = false } = {}) {
    try {
      if (p.versioned && !etag) throw calendarError('changed', t('errors.calendar.changed'));
      return await job();
    } catch (err) {
      if (!err || err.code !== 'changed') throw err;
      let latest;
      try {
        latest = await p.get(cal, event.eventId);
      } catch (gone) {
        if (gone && gone.code === 'not_found' && series) {
          cache.events = cache.events.filter((e) => !sameEvent(e, event));
          this.persist(acc.id);
          this.emit('updated');
          throw err;
        }
        // Deleted in the meantime: that is the news. Any other failure leaves the cache as it was.
        throw gone && gone.code === 'not_found' ? gone : err;
      }
      // Only this occurrence gets the latest version. The others of a series that changed elsewhere keep the version
      // they were read at: what they show may be out of date as well, so a change to them should say so too.
      this.store(acc, cache, latest, event);
      throw err;
    }
  }

  // The series' version a change to the whole series, or to this and following occurrences, is made on: the one the
  // user saw; on a provider whose series is one object, the occurrence's own (every occurrence carries it); else the
  // version the provider has now, so a drag, which knows none, has nothing to conflict with.
  async seriesVersion(p, cal, event, etag, seriesEtag) {
    if (seriesEtag) return seriesEtag;
    if (p.versionedSeries && etag) return etag;
    if (typeof p.series !== 'function') return null;
    try {
      return (await p.series(cal, event)).etag || null;
    } catch (err) {
      if (err && err.code === 'not_found') return null;
      throw err;
    }
  }

  // After a change to a series or a move, the calendars it touched are fetched again for the cached stretch, in the
  // same queue job, so every occurrence on screen is the new version. When that fails the stretch is let go, and the
  // next view fetches it whole.
  async refetch(acc, p, cache, ids) {
    const range = cache.range;
    if (!range) return;
    const cals = cache.calendars.filter((c) => ids.includes(c.id));
    try {
      const events = await this.fetchEvents(p, cals, range);
      const seen = new Map();
      for (const e of [...cache.events.filter((x) => !ids.includes(x.calendarId)), ...events]) seen.set(`${e.calendarId}\n${e.eventId}`, e);
      cache.events = [...seen.values()].sort((a, b) => a.start - b.start);
    } catch (_) {
      cache.range = null;
      cache.fetched = [];
    }
    this.persist(acc.id);
  }

  // One event from the cache, wherever it lies now, or from what read() or a search fetched lately outside it; null when
  // gone.
  event(id) {
    const { accountId, calendarId, eventId } = decodeId(id);
    const acc = this.engine.accounts.find((a) => a.id === accountId);
    if (!acc || !this.provider(acc)) return null;
    const match = (x) => x.calendarId === calendarId && x.eventId === eventId;
    const e = this.cache(acc.id).events.find(match) || this.recent(acc.id, calendarId, match);
    return e ? this.publicEvent(acc, e) : null;
  }

  // An event read() or a search fetched lately outside the cache, as the provider gave it.
  recent(accountId, calendarId, match) {
    const now = Date.now();
    for (const m of ((this.memos.get(accountId) || new Map()).get(calendarId) || []).slice().reverse()) {
      const hit = now - m.at <= MEMO_KEEP && m.events.find(match);
      if (hit) return hit;
    }
    const searched = this.found.get(accountId);
    return (searched && now - searched.at <= MEMO_KEEP && searched.events.find(match)) || null;
  }

  // The event an invitation by email is about, in one of the user's calendars: the same UID and, for one occurrence
  // of a series, the same original start. Google puts an invitation into the calendar when it arrives, under an id
  // of its own, and so do CalDAV servers that handle scheduling. A day either side of its time is read; null when no
  // calendar has it (or none could be read).
  async findInvite({ uid, start, end, rid = null }) {
    if (!uid || !Number.isFinite(start)) return null;
    const at = Number.isFinite(rid) ? rid : start;
    const { events } = await this.read({ start: Math.min(at, start) - DAY, end: Math.max(Number.isFinite(end) ? end : start, at) + DAY });
    const same = events.filter((e) => e.uid === uid);
    if (Number.isFinite(rid)) return same.find((e) => e.originalStart === rid || (!e.seriesId && e.start === rid)) || null;
    return same.find((e) => !e.seriesId || e.start === start) || same[0] || null;
  }

  // Lets go of what was read outside the cache, after a change or a new grant: it may no longer be so.
  dropMemos(id) {
    this.memos.delete(id);
    this.found.delete(id);
  }

  store(acc, cache, event, replaces = null) {
    cache.events = cache.events.filter((e) => !sameEvent(e, replaces || event)).concat(event).sort((a, b) => a.start - b.start);
    this.dropMemos(acc.id);
    this.persist(acc.id);
    this.emit('updated');
    return this.publicEvent(acc, event);
  }

  // #53: a provider whose series is one object with one version (CalDAV) gives the whole object a new version when one
  // occurrence changes, is left out or is answered. written, from the provider, holds that version, the one it
  // replaced and, when the provider had to read the new version back, its occurrences. The occurrences cached at the
  // replaced version move to the new one; otherwise the next change to one of them would count as made elsewhere. A
  // version the server named in its answer holds what Rukoo wrote, so only their version changes. A version read back
  // can also hold a change made elsewhere in between, so they take their content from it too, and one it doesn't have
  // keeps its old version. Occurrences cached at an older version keep it: what they show may be out of date, so a
  // change to them should say so too (unlessChanged). Google versions every occurrence on its own, so its other
  // occurrences stay as they are. Returns the occurrences that took their content from the version read back, so a
  // caller doesn't write its own idea of the change over them.
  restamp(p, cache, event, written) {
    const fresh = new Set();
    const { etag, replaced, occurrences } = written || {};
    if (!p.versionedSeries || !replaced || !etag || replaced === etag) return fresh;
    const behind = cache.events.filter((e) => inScope(e, event, true) && e.etag === replaced);
    if (!behind.length) return fresh;
    if (typeof occurrences !== 'function') {
      for (const e of behind) e.etag = etag;
      return fresh;
    }
    let latest;
    try {
      // A day either side also finds an occurrence without length.
      latest = occurrences(Math.min(...behind.map((e) => e.start)) - DAY, Math.max(...behind.map((e) => e.end)) + DAY);
    } catch (_) {
      // Occurrences Rukoo can't work out, such as a series too long to step through, keep their old version.
      return fresh;
    }
    const read = new Map(latest.map((e) => [e.eventId, e]));
    cache.events = cache.events
      .map((e) => {
        if (!behind.includes(e) || !read.has(e.eventId)) return e;
        const next = read.get(e.eventId);
        fresh.add(next);
        return next;
      })
      .sort((a, b) => a.start - b.start);
    return fresh;
  }

  changed(acc, calendarId, kind, scope, event, previous) {
    this.emit('changed', { accountId: acc.id, calendarId, kind, scope, event, previous });
  }

  // A Meet link Google is still making: the event is read again a few times until it has one, and the cache gets it.
  watchConference(acc, cal, e) {
    if (!e || !e.conference || !e.conference.pending) return;
    const delays = [...this.conferenceDelays];
    let waited = 0;
    const next = () => {
      if (!delays.length) return;
      const at = delays.shift();
      const timer = setTimeout(() => {
        const p = this.provider(acc);
        if (!p) return;
        this.queue(acc.id, async () => {
          const cache = this.caches.get(acc.id);
          if (!cache || !cache.events.some((x) => sameEvent(x, e))) return;
          let latest;
          try {
            latest = await p.get(cal, e.eventId);
          } catch (_) {
            next();
            return;
          }
          this.store(acc, cache, latest);
          if (latest.conference && latest.conference.pending) next();
        });
      }, Math.max(0, at - waited));
      waited = at;
      if (timer.unref) timer.unref();
    };
    next();
  }

  // The changes the store refuses before asking the provider: guests where nobody sends invitations or the user may
  // not change the list, Meet where the calendar has none, a new rule for one occurrence, a split by a guest.
  checkChange(acc, cal, e, input, scope) {
    const calendar = this.publicCalendar(acc, cal);
    if (hasGuests(input.guests)) {
      if (calendar.invites !== 'provider') throw refused('errors.calendar.noGuests');
      if (!e.canInvite) throw refused(e.moreAttendees ? 'errors.calendar.guestListPartial' : 'errors.calendar.notOrganizer');
      if (e.canInvite === 'add' && ((input.guests.remove || []).length || Object.keys(input.guests.optional || {}).length)) throw refused('errors.calendar.notOrganizer');
    }
    if (input.addMeet === true && !calendar.conference && !e.conference) throw refused('errors.calendar.noMeet');
    if (input.recurrence !== undefined && e.seriesId && scope === 'one') throw refused('errors.calendar.ruleKept');
    if (scope === 'following' && e.organizer && !e.organizer.self) throw refused('errors.calendar.notOrganizer');
  }

  // opts.bookingId and opts.uid are for the booking service only; they never come from the renderer.
  async create(input, { notify = false, bookingId = null, uid = null } = {}) {
    const acc = this.engine.accounts.find((a) => a.id === input.accountId);
    const p = acc && this.provider(acc);
    if (!p) throw calendarError('not_found', t('errors.calendar.noCalendar'));
    const cache = this.cache(acc.id);
    const cal = cache.calendars.find((c) => c.id === input.calendarId && c.writable);
    if (!cal) throw calendarError('read_only', t('errors.calendar.noCalendar'));
    const clean = this.clean(input);
    // Google's own format for event ids: base32hex, 5 to 1024 characters.
    if (typeof input.id === 'string' && /^[a-v0-9]{5,1024}$/.test(input.id)) clean.id = input.id;
    const booking = typeof bookingId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(bookingId) ? bookingId : null;
    const icalUid = typeof uid === 'string' && uid && uid.length <= 1000 && !/[\x00-\x1f\x7f]/.test(uid) ? uid : null;
    const calendar = this.publicCalendar(acc, cal);
    if (hasGuests(clean.guests) && calendar.invites !== 'provider') {
      // A booking's guest is kept in its booking record when this calendar can't invite anyone.
      if (!booking) throw refused('errors.calendar.noGuests');
      delete clean.guests;
    }
    if (clean.addMeet === true && !calendar.conference) throw refused('errors.calendar.noMeet');
    if (clean.recurrence === null) delete clean.recurrence;
    const repeats = typeof clean.recurrence === 'string';
    const made = await this.change(acc, cache, null, async () => {
      const e = await p.create(cal, clean, { notify, bookingId: booking, uid: icalUid });
      // A new series comes back as its first event; its occurrences come from the calendar.
      if (repeats) await this.refetch(acc, p, cache, [cal.id]);
      return e;
    });
    let out;
    let cached = made;
    if (repeats) {
      const series = new Set([made.seriesId, made.eventId].filter(Boolean));
      const first = cache.events.filter((e) => e.calendarId === cal.id && series.has(e.seriesId)).sort((a, b) => a.start - b.start);
      cached = first.find((e) => (clean.allDay ? e.startDate === clean.startDate : e.start === clean.start)) || first[0] || null;
      out = this.publicEvent(acc, cached || made);
      this.emit('updated');
    } else out = this.store(acc, cache, made);
    this.changed(acc, cal.id, 'create', 'one', out, null);
    this.watchConference(acc, cal, cached);
    return out;
  }

  // etag: the version the user saw, from the event card or the dialog. scope: for an occurrence of a series, this one,
  // this and following, or all; the series' version is seriesEtag (from series()). A rule on a single event makes it
  // a series. After a change to a series the occurrence is looked up again: null when the store can't find it.
  async update(id, input, { notify = false, etag = null, scope = 'one', seriesEtag = null } = {}) {
    const { acc, p, cache, cal, event } = this.locate(id);
    const clean = this.clean(input);
    const previous = this.publicEvent(acc, event);
    // A guest who may invite others changes nothing but the guest list.
    if (!event.canEdit && !(previous.canInvite && hasGuests(clean.guests) && onlyGuests(event, clean))) throw calendarError('read_only', t('errors.calendar.readOnly'));
    const inSeries = Boolean(event.seriesId);
    const which = inSeries && SCOPES.has(scope) ? scope : 'one';
    this.checkChange(acc, cal, previous, clean, which);
    // Taking the rule off a single event changes nothing.
    if (clean.recurrence === null && !inSeries) delete clean.recurrence;
    const ruleOnSingle = !inSeries && typeof clean.recurrence === 'string';
    const one = () => this.unlessChanged(acc, p, cache, cal, event, etag, () => p.update(cal, event, clean, { notify, etag, scope: 'one', seriesEtag: null }));
    if (which === 'one' && !ruleOnSingle) {
      const { event: next, written } = apart(await this.change(acc, cache, event, one));
      // The rest of the series first: store() then puts the changed occurrence over whatever restamp() left there.
      this.restamp(p, cache, event, written);
      const out = this.store(acc, cache, next, event);
      this.changed(acc, cal.id, 'update', 'one', out, previous);
      this.watchConference(acc, cal, next);
      return out;
    }
    const made = await this.change(acc, cache, event, async () => {
      let result;
      try {
        // The calendar is fetched again below, so what the write did doesn't matter here.
        if (ruleOnSingle) result = apart(await one()).event;
        else {
          const version = await this.seriesVersion(p, cal, event, etag, seriesEtag);
          result = await p.update(cal, event, clean, { notify, etag, scope: which, seriesEtag: version });
        }
      } catch (err) {
        // The series changed elsewhere, a split was taken back, or a split may half have happened: show the series as
        // it is now. After an unsure split the calendar may be out of reach, and then the error says so itself.
        if (err && (err.code === 'changed' || err.code === 'split_failed' || err.code === 'unsure')) {
          await this.refetch(acc, p, cache, [cal.id]).catch((again) => {
            if (err.code !== 'unsure') throw again;
          });
          this.emit('updated');
        }
        throw err;
      }
      await this.refetch(acc, p, cache, [cal.id]);
      return result;
    });
    const found = this.occurrence(cache, cal.id, made, event, clean);
    const out = found ? this.publicEvent(acc, found) : null;
    this.emit('updated');
    this.changed(acc, cal.id, 'series', ruleOnSingle ? 'all' : which, out, previous);
    if (found && cache.events.includes(found)) this.watchConference(acc, cal, found);
    return out;
  }

  // The edited occurrence after a change to its series, in the refetched cache: by the id the provider gave back (also
  // a single event, when "this and following" stopped the repeat), by its new start (an occurrence's id can change
  // with its series), or at its old start.
  occurrence(cache, calendarId, made, event, input) {
    if (made && made.eventId) {
      const hit = cache.events.find((e) => e.calendarId === calendarId && e.eventId === made.eventId);
      if (hit) return hit;
    }
    const inCal = cache.events.filter((e) => e.calendarId === calendarId && (e.seriesId || e.recurring));
    const series = new Set([made && made.seriesId, made && made.eventId, event.seriesId, event.eventId].filter(Boolean));
    const atNew = (e) => (input.allDay ? e.allDay && e.startDate === input.startDate : e.start === input.start);
    return (
      inCal.find((e) => atNew(e) && series.has(e.seriesId)) ||
      inCal.find((e) => atNew(e) && e.title === input.title) ||
      inCal.find(atNew) ||
      inCal.find((e) => e.start === event.start && series.has(e.seriesId)) ||
      // Nothing cached to look in: an occurrence or a single event as the provider gave it back, never a series' master.
      (made && (made.seriesId || !made.recurring) && !cache.range ? made : null)
    );
  }

  // scope: this occurrence, this and following, or the whole series; the older series: true means 'all'.
  async remove(id, { notify = false, scope, series = false, etag = null, seriesEtag = null } = {}) {
    const { acc, p, cache, cal, event } = this.locate(id);
    if (!event.canDelete) throw calendarError('read_only', t('errors.calendar.readOnly'));
    let which = SCOPES.has(scope) ? scope : series ? 'all' : 'one';
    if (!event.seriesId) which = 'one';
    if (which === 'following' && event.organizer && !event.organizer.self) throw refused('errors.calendar.notOrganizer');
    const previous = this.publicEvent(acc, event);
    const opts = { notify, scope: which, series: which === 'all', etag };
    let gone = false;
    let result = null;
    try {
      result = await this.change(acc, cache, event, async () => {
        if (which === 'one') return this.unlessChanged(acc, p, cache, cal, event, etag, () => p.remove(cal, event, { ...opts, seriesEtag: null }));
        const version = await this.seriesVersion(p, cal, event, etag, seriesEtag);
        const job = () => p.remove(cal, event, { ...opts, seriesEtag: version });
        let done;
        try {
          // A provider whose series is one object with one version checks it like any other change.
          done = await (p.versionedSeries ? this.unlessChanged(acc, p, cache, cal, event, version, job, { series: true }) : job());
        } catch (err) {
          // The deletion may half have happened: show the series as the calendar has it now, or, when it can't be
          // read, let the cached stretch go so the next view fetches it whole.
          if (err && err.code === 'unsure') {
            await this.refetch(acc, p, cache, [cal.id]);
            this.dropMemos(acc.id);
            this.emit('updated');
          }
          throw err;
        }
        await this.refetch(acc, p, cache, [cal.id]);
        return done;
      });
    } catch (err) {
      // Already gone, for instance after a first try whose answer got lost: the event or series is deleted, as asked.
      if (!err || err.code !== 'not_found') throw err;
      gone = true;
    }
    if (which === 'one') cache.events = cache.events.filter((e) => !sameEvent(e, event));
    else if (gone || which === 'all') cache.events = cache.events.filter((e) => !inScope(e, event, true));
    else {
      const from = event.originalStart ?? event.start;
      cache.events = cache.events.filter((e) => !(e.calendarId === event.calendarId && e.seriesId === event.seriesId && (e.originalStart ?? e.start) >= from));
    }
    // One occurrence left out: the rest of its series has a new version.
    if (!gone && which === 'one') this.restamp(p, cache, event, result);
    this.dropMemos(acc.id);
    this.persist(acc.id);
    this.emit('updated');
    this.changed(acc, cal.id, which === 'one' ? 'remove' : 'series', which, null, previous);
  }

  async respond(id, response, { series = false } = {}) {
    const { acc, p, cache, cal, event } = this.locateAnswerable(id);
    if (!RESPONSES.has(response)) throw calendarError('invalid', t('errors.calendar.invalidResponse'));
    if (!event.canRespond) throw calendarError('not_invited', t('errors.calendar.notInvited'));
    const written = await this.change(acc, cache, event, () => p.respond(cal, event, response, { series }));
    // An occurrence read back from the server shows the answer stored there, which can be one given elsewhere since.
    const fresh = this.restamp(p, cache, event, written);
    for (const e of cache.events) {
      if (!inScope(e, event, series) || !e.canRespond || fresh.has(e)) continue;
      e.response = response;
      for (const a of e.attendees || []) if (a.self) a.response = response;
    }
    // An event from outside the view's stretch (locateAnswerable) isn't among them.
    if (!cache.events.includes(event)) {
      event.response = response;
      for (const a of event.attendees || []) if (a.self) a.response = response;
    }
    this.persist(acc.id);
    this.emit('updated');
    // The reminder runner and the booking page follow at once: a declined meeting doesn't remind, and isn't busy. The
    // event as the cache has it now, which restamp() may have replaced with the version read back.
    const answered = cache.events.find((e) => sameEvent(e, event)) || event;
    this.changed(acc, cal.id, 'respond', series ? 'all' : 'one', this.publicEvent(acc, answered), null);
  }

  // Moves an event to another calendar of the same account; an occurrence moves with its whole series. Returns the
  // moved event, or for a series the opened occurrence when the refetch finds it.
  async move(id, calendarId, { notify = false } = {}) {
    const { acc, p, cache, cal, event } = this.locate(id);
    const to = cache.calendars.find((c) => c.id === calendarId);
    if (!to || !to.writable) throw calendarError('read_only', t('errors.calendar.noCalendar'));
    const previous = this.publicEvent(acc, event);
    if (to.id === cal.id) return previous;
    if (!previous.canMove || typeof p.move !== 'function') throw refused('errors.calendar.cannotMove');
    const whole = Boolean(event.seriesId);
    const moved = await this.change(acc, cache, event, async () => {
      const m = await p.move(cal, event, to, { notify });
      cache.events = cache.events.filter((e) => !inScope(e, event, whole));
      await this.refetch(acc, p, cache, [cal.id, to.id]);
      return m;
    });
    const inTo = cache.events.filter((e) => e.calendarId === to.id);
    const ids = new Set([moved && moved.eventId, event.eventId].filter(Boolean));
    const series = new Set([moved && moved.seriesId, moved && moved.eventId, event.seriesId].filter(Boolean));
    let found = inTo.find((e) => ids.has(e.eventId)) || (whole ? inTo.find((e) => series.has(e.seriesId) && e.start === event.start) : null) || null;
    // Without a cached stretch to refetch, a single event goes into the cache as the provider gave it back.
    if (!found && !whole && moved) {
      cache.events = cache.events.concat(moved).sort((a, b) => a.start - b.start);
      found = moved;
    }
    this.persist(acc.id);
    const out = found ? this.publicEvent(acc, found) : null;
    this.emit('updated');
    this.changed(acc, to.id, 'move', 'one', out, previous);
    return out;
  }

  // The series an occurrence belongs to: its rule, other recurrence lines and version (send it back as seriesEtag).
  async series(id) {
    const { acc, p, cache, cal, event } = this.locate(id);
    if (!event.seriesId || typeof p.series !== 'function') throw calendarError('not_found', t('errors.calendar.notFound'));
    return this.change(acc, cache, null, () => p.series(cal, event));
  }
}

module.exports = { Calendars, encodeId, decodeId, calendarKey };
