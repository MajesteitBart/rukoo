'use strict';

// Desktop reminders, the part that runs (design 2.8; contracts e and "A4a: what the reminder runner reads"). Every
// 30 seconds, and when the computer wakes or unlocks, it asks reminders.js which reminders fell due since the last
// check, shows the ones that haven't shown yet and remembers them in <dataDir>/reminders.json. The events come from
// calendars.read() over readRange(): every 15 minutes, and for one account again after a change or a sync there.
// Reminders show while Rukoo is focused too; main.js turns them into one notification.

const path = require('path');
const { t, getLocale } = require('../../i18n');
const { due, readRange, loadState, saveState, since, unfired, record } = require('./reminders');
const { calendarKey } = require('./index');

const MINUTE = 60000;
const TICK = 30 * 1000;
const READ_EVERY = 15 * MINUTE;
// A read that brings an event after its reminder time still reminds of it: a check looks back this far before the
// last one. Fired keys keep that from showing anything twice.
const LOOK_BACK = 15 * MINUTE;
// How long a change or a sync waits before its account is read again, so a burst of changes reads once.
const REREAD_AFTER = 2000;
// The most events one combined notification names.
const MAX_LINES = 4;
// How often reminders.json is written when no reminder showed, for the time of the last check. A reminder that
// shows is written at once, so it can't show twice; after a crash, checking from up to this long ago only shows ones
// that were missed.
const SAVE_EVERY = 5 * MINUTE;

const keyOf = (e) => calendarKey(e.accountId, e.calendarId);

class ReminderRunner {
  // notify(list): shows the reminders (main.js). powerMonitor: Electron's, or null. now: the clock, for tests.
  constructor({ calendars, engine, dataDir, notify, powerMonitor = null, now = Date.now }) {
    this.calendars = calendars;
    this.engine = engine;
    this.file = path.join(dataDir, 'reminders.json');
    this.notify = notify;
    this.powerMonitor = powerMonitor;
    this.now = now;
    this.state = null;
    this.events = [];
    this.readAt = 0;
    this.range = null;
    this.timer = null;
    this.rereads = new Map();
    this.running = null;
    this.listeners = [];
    this.savedAt = null;
  }

  start() {
    if (this.timer) return;
    this.state = loadState(this.file);
    this.timer = setInterval(() => this.tick().catch(() => {}), TICK);
    if (this.timer.unref) this.timer.unref();
    const on = (emitter, event, fn) => {
      if (!emitter || typeof emitter.on !== 'function') return;
      emitter.on(event, fn);
      this.listeners.push(() => emitter.removeListener(event, fn));
    };
    // After sleep the interval may not have run for hours: check at once.
    const wake = () => this.tick().catch(() => {});
    on(this.powerMonitor, 'resume', wake);
    on(this.powerMonitor, 'unlock-screen', wake);
    on(this.calendars, 'changed', (c) => this.changed(c));
    on(this.calendars, 'synced', (s) => s && this.reread(s.accountId));
    this.tick().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.rereads.values()) clearTimeout(timer);
    this.rereads.clear();
    for (const off of this.listeners.splice(0)) off();
    this.flush();
  }

  flush() {
    if (!this.state) return;
    try {
      saveState(this.file, this.state);
      this.savedAt = this.now();
    } catch (_) {
      // A full disk: at worst a reminder shows again after a restart.
    }
  }

  // Every account's events for the reminders that can fire before the next read.
  async read() {
    const now = this.now();
    const range = readRange({ to: now + READ_EVERY, now });
    const { events, failed } = await this.calendars.read({ start: range.start, end: range.end, lastKnown: true });
    // An account that couldn't be read keeps the events it had, so a network hiccup doesn't drop its reminders; one
    // this runner hasn't read yet (Rukoo started without a network) reminds from the store's cached events.
    const failedIds = new Set(failed.map((f) => f.accountId));
    const had = new Set(this.events.filter((e) => failedIds.has(e.accountId)).map((e) => e.accountId));
    this.events = [...events.filter((e) => !had.has(e.accountId)), ...this.events.filter((e) => had.has(e.accountId))];
    this.readAt = now;
    this.range = range;
  }

  // One account read again, fresh from its provider: after a change or a sync, so a moved event re-arms.
  reread(accountId) {
    if (!accountId || !this.timer) return;
    clearTimeout(this.rereads.get(accountId));
    const timer = setTimeout(() => {
      this.rereads.delete(accountId);
      this.readAccount(accountId).catch(() => {});
    }, REREAD_AFTER);
    if (timer.unref) timer.unref();
    this.rereads.set(accountId, timer);
  }

  async readAccount(accountId) {
    const acc = this.calendars.list().find((a) => a.id === accountId);
    if (!acc || !acc.calendars.length || !this.range) return;
    const range = readRange({ to: this.now() + READ_EVERY, now: this.now() });
    const { events, failed } = await this.calendars.read({ start: range.start, end: range.end, calendars: acc.calendars.map((c) => calendarKey(acc.id, c.id)), maxAgeMs: 0 });
    if (failed.length) return;
    this.events = [...this.events.filter((e) => e.accountId !== accountId), ...events];
  }

  // A change made in Rukoo applies at once; the account's read afterwards confirms it.
  changed(c) {
    if (!c) return;
    const gone = new Set([c.previous && c.previous.id, c.event && c.event.id].filter(Boolean));
    this.events = this.events.filter((e) => !gone.has(e.id));
    if (c.event && c.kind !== 'remove') this.events.push(c.event);
    this.reread(c.accountId);
  }

  // One check: reminders due between the last check (a little before it) and now that haven't shown yet.
  tick() {
    if (this.running) return this.running;
    this.running = this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async check() {
    if (!this.state) this.state = loadState(this.file);
    let now = this.now();
    if (!this.range || now - this.readAt >= READ_EVERY || now + TICK > this.range.end) {
      await this.read().catch(() => {});
      now = this.now();
    }
    const settings = (this.engine.settings && this.engine.settings.calendar) || {};
    const cals = new Map();
    for (const acc of this.calendars.list()) for (const c of acc.calendars) cals.set(calendarKey(acc.id, c.id), c);
    const last = Number.isFinite(this.state.lastCheck) && this.state.lastCheck <= now;
    const from = last ? since(this.state, now) - LOOK_BACK : now;
    const list = unfired(
      due(this.events, {
        from,
        to: now,
        now,
        fallback: Number.isFinite(settings.reminder) ? settings.reminder : null,
        isShown: (e) => Boolean(cals.get(keyOf(e)) && cals.get(keyOf(e)).visible),
        calendarOf: (e) => cals.get(keyOf(e)) || null
      }),
      this.state
    );
    // Reminders turned off: they count as shown, so turning them on again doesn't bring a pile of old ones.
    if (list.length && settings.notify !== false) {
      try {
        this.notify(list);
      } catch (_) {
        // A notification that can't show is still counted; it won't come back.
      }
    }
    this.state = record(this.state, list, now);
    if (list.length || this.savedAt === null || now - this.savedAt >= SAVE_EVERY || now < this.savedAt) this.flush();
    return list;
  }
}

// ---------- the notification's text ----------

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function dayWord(ms, now) {
  if (sameDay(ms, now)) return t('reminders.today');
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(ms, tomorrow.getTime())) return t('reminders.tomorrow');
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
}

const timeText = (ms) => new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(ms);

// When the event is, from now: 'Starts in 10 minutes', 'Started 3 minutes ago', 'Tomorrow at 10:00', and for an
// all-day event its day without a clock time.
function whenText(d, now) {
  if (d.allDay) return t('reminders.allDay', { day: dayWord(d.start, now) });
  if (d.late > 0) return t('reminders.started', { count: d.late });
  const minutes = Math.ceil((d.start - now) / MINUTE);
  if (minutes <= 0) return t('reminders.now');
  if (minutes <= 60) return t('reminders.in', { count: minutes });
  return t('reminders.at', { day: dayWord(d.start, now), time: timeText(d.start) });
}

// One notification for the reminders of one check (design 2.8): an event's title with when it is, its place and, for
// a video meeting, that a click leads to Join; several events in one notification. open: what a click opens.
function reminderNotice(list, now = Date.now()) {
  const seen = new Set();
  const events = list.filter((d) => !seen.has(d.id) && seen.add(d.id));
  const first = events[0];
  const open = { id: first.id, start: first.start };
  const title = (d) => (d.title && d.title.trim()) || t('reminders.untitled');
  if (events.length === 1) {
    const lines = [whenText(first, now)];
    if (first.location) lines.push(first.location);
    if (first.meeting) lines.push(t('reminders.join'));
    return { title: title(first), body: lines.join('\n'), open };
  }
  const lines = events.slice(0, MAX_LINES).map((d) => `${whenText(d, now)}: ${title(d)}`);
  if (events.length > MAX_LINES) lines.push(t('reminders.more', { count: events.length - MAX_LINES }));
  return { title: t('reminders.many', { count: events.length }), body: lines.join('\n'), open };
}

module.exports = { ReminderRunner, reminderNotice, TICK, READ_EVERY };
