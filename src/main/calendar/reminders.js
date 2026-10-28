'use strict';

// Desktop reminders for calendar events. due() is pure: given events and a stretch of time, it lists the reminders
// that fire in it. The state helpers keep <dataDir>/reminders.json, which remembers which reminders already showed,
// so a restart, a second tick or the same meeting on two calendars never shows one twice. The runner that ticks,
// reads the calendars and shows the notifications builds on both.

const fs = require('fs');
const path = require('path');
const { zonedParts, zonedInstant, addDays, pcZone } = require('./zone');

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
// A reminder still shows this long after its event started ('started 3 min ago'); after that it's dropped.
const LATE = 5 * MINUTE;
// Minutes before the start: up to 4 weeks, and on all-day events down to -1439, a time on the event's own day.
const MAX_MINUTES = 40320;
const MIN_ALL_DAY = -1439;
// Fired keys stay until their event ends; this only bounds a file that something went wrong with.
const MAX_FIRED = 5000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const pad = (n) => String(n).padStart(2, '0');
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The popup reminders of an event, in minutes before its start. Email reminders are the provider's to send.
function reminderMinutes(e, cal, fallback) {
  const r = e.reminders;
  let list;
  if (!plain(r)) {
    // Unknown (CalDAV without VALARM, the demo): the fallback, but only for timed events on calendars that are the
    // user's own (writable) or the account's primary, never on subscribed holiday or birthday calendars.
    if (e.allDay || !cal || !(cal.writable || cal.primary)) return [];
    list = [{ method: 'popup', minutes: fallback }];
  } else if (r.useDefault) {
    // A calendar's defaults (Google) are for timed events. All-day events have defaults of their own that the API
    // doesn't show, and applying the timed ones would ping at 23:50 the evening before every holiday.
    if (e.allDay) return [];
    list = cal && Array.isArray(cal.defaultReminders) ? cal.defaultReminders : [];
  } else {
    // Google's useDefault: false with no overrides means no reminders, and stays that way.
    list = Array.isArray(r.overrides) ? r.overrides : [];
  }
  const out = [];
  for (const x of list) {
    const m = plain(x) && x.method === 'popup' ? x.minutes : NaN;
    if (Number.isInteger(m) && m <= MAX_MINUTES && m >= (e.allDay ? MIN_ALL_DAY : 0) && !out.includes(m)) out.push(m);
  }
  return out;
}

// The date an all-day event starts on, from startDate; the cached ms only for an event without one.
function firstDate(e, zone) {
  if (typeof e.startDate === 'string' && DATE.test(e.startDate)) {
    try {
      zonedInstant(e.startDate, '00:00', zone);
      return e.startDate;
    } catch (_) {
      // Not a real date; read it from start below.
    }
  }
  return zonedParts(e.start, zone).date;
}

// When an all-day reminder fires and until when it may still show. Minutes count back from 00:00 of the event's
// first day in the zone, read on the wall clock: 900 is the day before at 09:00 and -540 the day itself at 09:00,
// also when the clock changes in between. It may show until that first day is over, since the event lasts all day.
function allDayTimes(e, minutes, zone) {
  const date = firstDate(e, zone);
  const after = -minutes;
  const days = Math.floor(after / 1440);
  const rest = after - days * 1440;
  return {
    at: zonedInstant(addDays(date, days), `${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`, zone),
    until: zonedInstant(addDays(date, 1), '00:00', zone)
  };
}

// The reminders that fire in (from, to], one per key, by fire time. A timed event's reminder is dropped once the
// event started LATE ago or more; until then `late` says how many whole minutes ago it started. Events isShown()
// turns down (hidden calendar) and declined ones never remind. The key is uid (or id), originalStart (or start),
// start and minutes, joined by newlines: one meeting on two calendars or two accounts gives one reminder, and the
// start in it re-arms an event that moved. timeZone is the zone all-day events are read in, the PC's by default.
function due(events, { from, to, fallback = null, isShown, calendarOf, now = Date.now(), timeZone } = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new RangeError(`Invalid range: ${from} to ${to}`);
  if (!Number.isFinite(now)) throw new RangeError(`Invalid time: ${now}`);
  if (!Array.isArray(events) || to <= from) return [];
  const zone = timeZone || pcZone();
  const shown = typeof isShown === 'function' ? isShown : () => true;
  const calendar = typeof calendarOf === 'function' ? calendarOf : () => null;
  const found = new Map();
  for (const e of events) {
    if (!plain(e) || !Number.isFinite(e.start) || !Number.isFinite(e.end)) continue;
    if (e.response === 'declined' || e.status === 'cancelled' || !shown(e)) continue;
    for (const minutes of reminderMinutes(e, calendar(e) || null, fallback)) {
      const { at, until } = e.allDay ? allDayTimes(e, minutes, zone) : { at: e.start - minutes * MINUTE, until: e.start + LATE };
      if (at <= from || at > to || now >= until) continue;
      const key = `${e.uid || e.id}\n${Number.isFinite(e.originalStart) ? e.originalStart : e.start}\n${e.start}\n${minutes}`;
      if (found.has(key)) continue;
      found.set(key, {
        key,
        id: e.id,
        title: typeof e.title === 'string' ? e.title : '',
        location: typeof e.location === 'string' ? e.location : '',
        meeting: typeof e.meeting === 'string' ? e.meeting : null,
        start: e.start,
        end: e.end,
        allDay: Boolean(e.allDay),
        minutes,
        at,
        until,
        late: !e.allDay && now > e.start ? Math.floor((now - e.start) / MINUTE) : 0
      });
    }
  }
  return [...found.values()].sort((a, b) => a.at - b.at || a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// The events to read (calendars.read() gives those overlapping [start, end)) so that due() sees every reminder that
// fires up to `to` and can still show at `now`. Ahead it reaches the longest reminder past `to`; a read that serves
// later ticks too passes the last of them as `to`. Behind it reaches back two days, because an all-day event may
// still be on its first day while its cached times, made in a zone up to 26 hours away, have already ended. Two more
// days ahead cover that gap for an all-day event's start, and the clock change that makes 4 weeks an hour longer.
function readRange({ to, now = Date.now() } = {}) {
  if (!Number.isFinite(to) || !Number.isFinite(now)) throw new RangeError(`Invalid time: ${to}, ${now}`);
  return { start: now - 2 * DAY, end: Math.max(to, now) + MAX_MINUTES * MINUTE + 2 * DAY };
}

// reminders.json: { v: 1, lastCheck: ms | null, fired: { key: until when it is kept } }.
function emptyState() {
  return { v: 1, lastCheck: null, fired: {} };
}

// A state as read from disk, with anything that doesn't fit left out.
function normalizeState(value) {
  const state = emptyState();
  if (!plain(value) || value.v !== 1) return state;
  if (Number.isFinite(value.lastCheck)) state.lastCheck = value.lastCheck;
  if (plain(value.fired)) {
    for (const [key, end] of Object.entries(value.fired)) {
      if (key.length <= 4000 && Number.isFinite(end)) state.fired[key] = end;
    }
  }
  return state;
}

// A missing or damaged file is an empty state: at worst a reminder shows again.
function loadState(file) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return emptyState();
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalizeState(state)));
  fs.renameSync(tmp, file);
}

// Where the next check starts: the last check, or now when there was none or the clock went back past it, so a first
// start never shows reminders from before Rukoo ran.
function since(state, now) {
  const last = state && state.lastCheck;
  return Number.isFinite(last) && last <= now ? last : now;
}

// The reminders in list that haven't shown yet.
function unfired(list, state) {
  return list.filter((d) => !own(state.fired, d.key));
}

// The state after a check at `now` that showed `shown`: they are remembered until their event ends or due() stops
// offering them, whichever is later (plus the LATE margin, so an event shorter than that can't show its reminder
// twice), and older keys go. An all-day event cached in a zone far ahead can end before its first day here is over.
function record(state, shown, now) {
  const fired = {};
  for (const [key, end] of Object.entries(state.fired)) if (end + LATE > now) fired[key] = end;
  for (const d of shown) fired[d.key] = Number.isFinite(d.until) ? Math.max(d.end, d.until) : d.end;
  const keys = Object.keys(fired);
  if (keys.length > MAX_FIRED) {
    // The ones ending last are the ones that could still fire.
    for (const key of keys.sort((a, b) => fired[a] - fired[b]).slice(0, keys.length - MAX_FIRED)) delete fired[key];
  }
  return { v: 1, lastCheck: now, fired };
}

module.exports = { due, readRange, emptyState, normalizeState, loadState, saveState, since, unfired, record, LATE, MAX_MINUTES };
