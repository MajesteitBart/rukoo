'use strict';

const { t } = require('../../i18n');

// The calendars of every account that has one, for the calendar view. Each account's events are cached for one
// stretch of time around what the user has looked at; a view outside it fetches the missing weeks in the
// background and says so with 'updated'. Times are milliseconds; all-day events also carry their dates.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { CALENDAR_SCOPES } = require('../google');
const { GoogleCalendar, calendarError, localDay } = require('./google');
const { DemoCalendar } = require('./demo');

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

function encodeId(accountId, calendarId, eventId) {
  return [accountId, calendarId, eventId].map(encodeURIComponent).join(':');
}

function decodeId(id) {
  const [accountId, calendarId, eventId] = String(id).split(':').map(decodeURIComponent);
  return { accountId, calendarId, eventId };
}

const covers = (range, start, end) => Boolean(range && range.start <= start && range.end >= end);
const overlaps = (e, start, end) => e.start < end && e.end > start;
const sameEvent = (a, b) => a.calendarId === b.calendarId && a.eventId === b.eventId;
// The events of one series, or the one event.
const inScope = (e, event, series) => e.calendarId === event.calendarId && (series && event.seriesId ? e.seriesId === event.seriesId : e.eventId === event.eventId);

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
    engine.on('account-removed', (acc) => this.forget(acc));
  }

  // ---------- accounts ----------

  // How an account gets its calendar: 'demo', 'google', 'reconnect' for a Google account whose grant doesn't
  // include the calendar, or null when Rukoo has no calendar for that kind of account.
  kind(acc) {
    if (acc.type === 'demo') return 'demo';
    if (acc.provider !== 'google') return null;
    const scopes = acc.auth === 'oauth2' ? acc.scopes || [] : [];
    return CALENDAR_SCOPES.every((s) => scopes.includes(s)) ? 'google' : 'reconnect';
  }

  provider(acc) {
    const kind = this.kind(acc);
    if (kind !== 'demo' && kind !== 'google') return null;
    const key = `${acc.id}:${kind}`;
    if (!this.providers.has(key)) {
      this.providers.set(
        key,
        kind === 'demo'
          ? new DemoCalendar(path.join(this.dataDir, 'demo-calendar.json'), acc)
          : new GoogleCalendar({ token: () => this.engine.accessToken(this.engine.account(acc.id)), fetchImpl: this.fetch })
      );
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

  // Google names the primary calendar after the address; the account's name reads better under that address.
  publicCalendar(acc, { id, name, primary, writable, selected }) {
    const own = primary && acc.name && name.toLowerCase() === String(acc.email).toLowerCase();
    return { id, name: own ? acc.name : name, primary, writable, selected };
  }

  publicEvent(acc, e) {
    return { ...e, id: encodeId(acc.id, e.calendarId, e.eventId), accountId: acc.id };
  }

  // The engine counts sign-ins as it installs each new grant; a failure from before the last one is about the old grant.
  grant(id) {
    return this.engine.grant(id);
  }

  // After signing in again: the account may have its calendar now, and an earlier sign-in error is gone.
  reconnected(id) {
    for (const key of this.providers.keys()) if (key.startsWith(`${id}:`)) this.providers.delete(key);
    const cache = this.caches.get(id);
    if (cache) {
      cache.error = null;
      cache.failedAt = null;
    }
    this.emit('updated');
  }

  forget(acc) {
    const id = acc.id;
    for (const key of this.providers.keys()) if (key.startsWith(`${id}:`)) this.providers.delete(key);
    this.caches.delete(id);
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
      this.caches.set(id, { calendars: [], events: [], range: null, view: null, syncedAt: null, error: null, failedAt: null, ...(saved || {}) });
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

  // One job at a time per account, so a sync, a view and a change never fetch over each other.
  queue(id, job) {
    const run = (this.queues.get(id) || Promise.resolve()).then(job, job);
    this.queues.set(id, run.catch(() => {}));
    return run;
  }

  // A job that fetches: the account shows as loading until it is done.
  busy(id, job) {
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

  ensure(id, start, end) {
    return this.busy(id, () => this.fill(id, start, end));
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
      cache.calendars = calendars;
      if (!stretch) cache.events = [];
      for (const { w, events } of fetched) this.merge(cache, w, events);
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

  // ---------- sync ----------

  // Fetches the calendars and the cached stretch again. An account whose calendar was never opened waits for that.
  syncAccount(id) {
    const acc = this.engine.accounts.find((a) => a.id === id);
    if (!acc || !this.provider(acc)) return Promise.resolve();
    const cache = this.cache(id);
    if (!cache.range && !cache.view) return Promise.resolve();
    return this.busy(id, async () => {
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
        Object.assign(cache, { calendars, range, events: [], syncedAt: Date.now(), error: null, failedAt: null });
        this.merge(cache, range, events);
      } catch (err) {
        this.failed(acc, cache, err, grant);
        throw err;
      } finally {
        this.persist(id);
      }
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

  // What a new or changed event may contain, checked again here because it comes from the renderer.
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
      return out;
    }
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw calendarError('invalid', t('errors.calendar.invalidTimes'));
    out.start = start;
    out.end = end;
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
    }
  }

  store(acc, cache, event, replaces = null) {
    cache.events = cache.events.filter((e) => !sameEvent(e, replaces || event)).concat(event).sort((a, b) => a.start - b.start);
    this.persist(acc.id);
    this.emit('updated');
    return this.publicEvent(acc, event);
  }

  async create(input) {
    const acc = this.engine.accounts.find((a) => a.id === input.accountId);
    const p = acc && this.provider(acc);
    if (!p) throw calendarError('not_found', t('errors.calendar.noCalendar'));
    const cache = this.cache(acc.id);
    const cal = cache.calendars.find((c) => c.id === input.calendarId && c.writable);
    if (!cal) throw calendarError('read_only', t('errors.calendar.noCalendar'));
    const clean = this.clean(input);
    // Google's own format for event ids: base32hex, 5 to 1024 characters.
    if (typeof input.id === 'string' && /^[a-v0-9]{5,1024}$/.test(input.id)) clean.id = input.id;
    const event = await this.change(acc, cache, null, () => p.create(cal, clean));
    return this.store(acc, cache, event);
  }

  async update(id, input, { notify = false } = {}) {
    const { acc, p, cache, cal, event } = this.locate(id);
    if (!event.canEdit) throw calendarError('read_only', t('errors.calendar.readOnly'));
    const clean = this.clean(input);
    const next = await this.change(acc, cache, event, () => p.update(cal, event, clean, { notify }));
    return this.store(acc, cache, next, event);
  }

  async remove(id, { notify = false, series = false } = {}) {
    const { acc, p, cache, cal, event } = this.locate(id);
    if (!event.canEdit) throw calendarError('read_only', t('errors.calendar.readOnly'));
    await this.change(acc, cache, event, () => p.remove(cal, event, { notify, series }));
    cache.events = cache.events.filter((e) => !inScope(e, event, series));
    this.persist(acc.id);
    this.emit('updated');
  }

  async respond(id, response, { series = false } = {}) {
    const { acc, p, cache, cal, event } = this.locate(id);
    if (!RESPONSES.has(response)) throw calendarError('invalid', t('errors.calendar.invalidResponse'));
    if (!event.canRespond) throw calendarError('not_invited', t('errors.calendar.notInvited'));
    await this.change(acc, cache, event, () => p.respond(cal, event, response, { series }));
    for (const e of cache.events) {
      if (!inScope(e, event, series) || !e.canRespond) continue;
      e.response = response;
      for (const a of e.attendees || []) if (a.self) a.response = response;
    }
    this.persist(acc.id);
    this.emit('updated');
  }
}

module.exports = { Calendars, encodeId, decodeId };
