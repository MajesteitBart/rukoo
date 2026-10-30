'use strict';

const { t } = require('../../i18n');

// Calendar objects in iCalendar (RFC 5545), as CalDAV servers keep them and as the demo calendar stores its events:
// reading one into the events the calendar store keeps, with a recurring event expanded into its occurrences and the
// changes made to each of them, and making the changes Rukoo writes, from one occurrence to a whole series. The
// calendars that use it (caldav.js, demo.js) only fetch and store the objects.
// https://www.rfc-editor.org/rfc/rfc5545
const crypto = require('crypto');
const ICAL = require('ical.js');
const { calendarError, localDay, dayKey, plainDescription } = require('./google');
const { isZone } = require('./zone');
const { vtimezone } = require('./vtimezone');

// How many occurrences of one recurring event are stepped through to reach a period; a rule that repeats every
// minute would otherwise run on for a long time. A series that needs more fails the fetch instead of going missing.
const MAX_STEPS = 100000;
const DAY = 86400000;
const PRODID = '-//Rukoo Mail//Calendar//EN';
const PARTSTAT = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative', 'NEEDS-ACTION': 'needsAction' };
const ANSWER = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' };
const VIDEO = /^https:\/\/([a-z0-9-]+\.)*(zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|meet\.jit\.si|whereby\.com|webex\.com)\/\S*$/i;
const CLASSES = { PUBLIC: 'public', PRIVATE: 'private', CONFIDENTIAL: 'confidential' };
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// RFC 9074: an alarm that says the event has none, so "no reminders" isn't read back as "unknown" (Apple writes it).
const NO_ALARM = '1976-04-01T00:55:45Z';
// A change to these makes invitations go out again (RFC 5546 2.1.4), so only they raise SEQUENCE, with the times.
const SIGNIFICANT = ['rrule', 'rdate', 'exdate', 'status', 'location'];
const BOOKING = 'x-rukoo-booking';

const notFound = () => calendarError('not_found', t('errors.calendar.notFound'));
const refused = (key) => calendarError('refused', t(key));

// ---------- times ----------

const pad = (n, width = 2) => String(n).padStart(width, '0');
const dateText = (time) => `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`;

// 20261014T090000Z: an instant as CalDAV writes it in a time range, and as Rukoo names an occurrence.
function utcStamp(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const formatters = new Map();
// A formatter for a time zone the PC knows by name, or null.
function zoneFormatter(tzid) {
  if (!formatters.has(tzid)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tzid, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch (_) {
      // Not a zone name the PC knows, such as a Windows name.
    }
    formatters.set(tzid, f);
  }
  return formatters.get(tzid);
}

// The clock in a named zone at a moment.
function wallClock(f, ms) {
  const v = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') v[p.type] = Number(p.value);
  return { year: v.year, month: v.month, day: v.day, hour: v.hour % 24, minute: v.minute, second: v.second };
}

// A clock time in a named zone as milliseconds. The second pass settles the hour around a clock change.
function fromWallClock(time, f) {
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const offset = (ms) => {
    const c = wallClock(f, ms);
    return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - Math.floor(ms / 1000) * 1000;
  };
  return wall - offset(wall - offset(wall));
}

const floating = (time) => !time.zone || time.zone === ICAL.Timezone.localTimezone || time.zone.tzid === 'floating';
const utcTime = (time) => !time.isDate && time.zone === ICAL.Timezone.utcTimezone;

// A date or date-time as milliseconds. All-day dates are local midnight, as Google's are. A zone the event defines
// (VTIMEZONE), or UTC, converts directly. A zone the event only names is looked up by that name, and a time without a
// zone is floating: the same clock time wherever the PC is.
function instant(time, tzid) {
  if (time.isDate) return localDay(dateText(time));
  if (!floating(time)) return time.toUnixTime() * 1000;
  const f = tzid && zoneFormatter(tzid);
  if (f) return fromWallClock(time, f);
  return new Date(time.year, time.month - 1, time.day, time.hour, time.minute, time.second).getTime();
}

const tzidOf = (comp, name) => {
  const p = comp.getFirstProperty(name);
  return (p && p.getParameter('tzid')) || null;
};

// How Rukoo names one occurrence of a series: its original start, as a date or in UTC.
const ridOf = (time, tzid) => (time.isDate ? dateText(time).replace(/-/g, '') : utcStamp(instant(time, tzid)));

// The moment an occurrence's name stands for: local midnight for a date, as instant() gives it.
function ridInstant(rid) {
  const s = String(rid || '');
  if (/^\d{8}$/.test(s)) return localDay(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : NaN;
}

// The TZID a time of this event is written with: the event's own, unless the time is a date or in UTC.
const zoneParam = (time, tzid) => (time.isDate || time.zone === ICAL.Timezone.utcTimezone ? null : (time.zone && !floating(time) && time.zone.tzid) || tzid || null);

function setTime(comp, name, { time, tzid }) {
  comp.removeAllProperties(name);
  const p = new ICAL.Property(name);
  p.setValue(time);
  if (tzid) p.setParameter('tzid', tzid);
  comp.addProperty(p);
}

const nextDay = (date) => {
  const d = new Date(localDay(date));
  d.setDate(d.getDate() + 1);
  return dayKey(d);
};

// A clock reading taken as if it were UTC, so a difference between two of them is a difference on the clock (a
// "wall" time); and its parts again.
const onClock = (c) => Date.UTC(c.year, c.month - 1, c.day, c.hour || 0, c.minute || 0, c.second || 0);
function clockParts(wall) {
  const d = new Date(wall);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}
const dateWall = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const toSecond = (ms) => Math.floor(ms / 1000) * 1000;

// The clock of a zone: UTC, a zone the object defines (VTIMEZONE), one it only names (the PC's zone data), or the
// PC's own, for floating times and dates. toWall turns a moment into that clock's reading, fromWall back.
function clock(tzid, vcal) {
  if (tzid === 'UTC') return { toWall: (ms) => toSecond(ms), fromWall: (w) => w };
  const zone = tzid && vcal ? vcal.getTimeZoneByID(tzid) : null;
  if (zone) {
    const fromWall = (w) => ICAL.Time.fromData({ ...clockParts(w), isDate: false }, zone).toUnixTime() * 1000;
    return {
      // ical.js converts from UTC as if the UTC reading were the zone's own, which is off for a few hours around a
      // clock change; from the clock to the moment is exact, so the reading is corrected that way.
      toWall: (ms) => {
        const at = toSecond(ms);
        let w = at + zone.utcOffset(ICAL.Time.fromJSDate(new Date(at), true)) * 1000;
        for (let i = 0; i < 3; i++) {
          const back = fromWall(w);
          if (back === at) break;
          w += at - back;
        }
        return w;
      },
      fromWall
    };
  }
  const f = tzid && zoneFormatter(tzid);
  if (f) return { toWall: (ms) => onClock(wallClock(f, ms)), fromWall: (w) => fromWallClock(clockParts(w), f) };
  return {
    toWall: (ms) => {
      const d = new Date(ms);
      return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    },
    fromWall: (w) => {
      const c = clockParts(w);
      return new Date(c.year, c.month - 1, c.day, c.hour, c.minute, c.second).getTime();
    }
  };
}

// How a series' times are written: as dates, or as date-times in UTC ('UTC'), in a zone (its TZID) or floating (null).
function frameOf(comp) {
  const p = comp.getFirstProperty('dtstart');
  const time = p.getFirstValue();
  if (time.isDate) return { allDay: true, tzid: null };
  if (utcTime(time)) return { allDay: false, tzid: 'UTC' };
  return { allDay: false, tzid: p.getParameter('tzid') || null };
}

const frameClock = (frame, vcal) => clock(frame.allDay ? null : frame.tzid, vcal);
const named = (tzid) => Boolean(tzid) && tzid !== 'UTC';

// A time of the object as a reading of the frame's clock. A time written in the frame's own zone is that reading
// already, also when the zone can't be looked up.
function wallIn(time, tzid, frame, vcal) {
  if (time.isDate) return Date.UTC(time.year, time.month - 1, time.day);
  const own = utcTime(time) ? 'UTC' : tzid || null;
  if (!frame.allDay && own === frame.tzid) return onClock(time);
  return frameClock(frame, vcal).toWall(instant(time, tzid));
}

// The value a clock reading of the frame is written as.
function timeFromWall(wall, frame) {
  const c = clockParts(wall);
  if (frame.allDay) return { time: ICAL.Time.fromData({ year: c.year, month: c.month, day: c.day, isDate: true }), tzid: null };
  if (frame.tzid === 'UTC') return { time: ICAL.Time.fromData({ ...c, isDate: false }, ICAL.Timezone.utcTimezone), tzid: null };
  return { time: ICAL.Time.fromData({ ...c, isDate: false }), tzid: frame.tzid };
}

// The name of the occurrence that starts at a clock reading of the frame.
function ridAt(wall, frame, vcal) {
  const c = clockParts(wall);
  if (frame.allDay) return `${pad(c.year, 4)}${pad(c.month)}${pad(c.day)}`;
  return utcStamp(frameClock(frame, vcal).fromWall(wall));
}

// The time a property gets for a moment, in the zone tzid: one the object defines, one the PC knows by name, or else
// UTC. A clock time the zone shows twice (the hour the clocks go back) is written in UTC too: readers take the first
// of the two, which may not be the one meant.
function writeTime(ms, tzid, vcal) {
  const utc = { time: ICAL.Time.fromJSDate(new Date(ms), true), tzid: null };
  if (!named(tzid) || !((vcal && vcal.getTimeZoneByID(tzid)) || zoneFormatter(tzid))) return utc;
  const c = clock(tzid, vcal);
  const at = toSecond(ms);
  const w = c.toWall(at);
  if (c.fromWall(w) !== at) return utc;
  for (const d of [1800000, 3600000, 7200000]) if (c.toWall(at - d) === w || c.toWall(at + d) === w) return utc;
  return { time: ICAL.Time.fromData({ ...clockParts(w), isDate: false }), tzid };
}

// The start or end of a series: always a clock time in its zone, which the rule follows. In UTC the series would be
// an hour off after the clocks change. A start in the hour they go back can then be read as either of the two times
// (RFC 5545 says the first, ical.js takes the second); every later occurrence is right.
function writeSeriesTime(ms, tzid, vcal) {
  if (!named(tzid) || !((vcal && vcal.getTimeZoneByID(tzid)) || zoneFormatter(tzid))) return writeTime(ms, tzid, vcal);
  return { time: ICAL.Time.fromData({ ...clockParts(clock(tzid, vcal).toWall(ms)), isDate: false }), tzid };
}

const zoneOrNull = (zone) => (zone === 'UTC' || (typeof zone === 'string' && isZone(zone)) ? zone : null);

// ---------- reading ----------

// One calendar object: the event, or the series with the occurrences changed on their own (RECURRENCE-ID).
function parseObject(text) {
  const jcal = ICAL.parse(String(text || ''));
  const vcal = new ICAL.Component(typeof jcal[0] === 'string' ? jcal : jcal[0]);
  if (vcal.name !== 'vcalendar') throw new Error('not a calendar');
  const vevents = vcal.getAllSubcomponents('vevent');
  return { vcal, master: vevents.find((v) => !v.hasProperty('recurrence-id')) || null, exceptions: vevents.filter((v) => v.hasProperty('recurrence-id')) };
}

const recurring = (comp) => Boolean(comp && (comp.hasProperty('rrule') || comp.hasProperty('rdate')));
const cancelled = (comp) => String(comp.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';
const exceptionRid = (x) => ridOf(x.getFirstPropertyValue('recurrence-id'), tzidOf(x, 'recurrence-id'));
const exceptionAt = (x) => instant(x.getFirstPropertyValue('recurrence-id'), tzidOf(x, 'recurrence-id'));
// An exception that also changes every later occurrence (RANGE=THISANDFUTURE).
const ranged = (x) => /^thisandfuture$/i.test(String(x.getFirstProperty('recurrence-id').getParameter('range') || ''));

// The series as its rule steps through it, with every extra and excluded date (RDATE, EXDATE) in the same frame as
// its start. A start in a zone the object defines, or in UTC, is a moment, so those dates become moments too. A start
// in a zone the object only names, or without a zone, is a clock time, so they become clock times in that zone.
// Otherwise an EXDATE written in UTC or another zone would never match an occurrence, and an RDATE would land at the
// wrong time. The copy is only stepped through, never written.
function stepper(master) {
  const start = master.getFirstPropertyValue('dtstart');
  if (!start || start.isDate || !(master.hasProperty('exdate') || master.hasProperty('rdate'))) return master;
  const own = tzidOf(master, 'dtstart');
  const clockTime = floating(start);
  const f = clockTime && own ? zoneFormatter(own) : null;
  const frame = (ms) => {
    if (!clockTime) return ICAL.Time.fromJSDate(new Date(ms), true);
    if (f) return ICAL.Time.fromData({ ...wallClock(f, ms), isDate: false });
    const d = new Date(ms);
    return ICAL.Time.fromData({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), isDate: false });
  };
  const convert = (time, tzid) => {
    if (!time || typeof time.isDate !== 'boolean' || time.isDate) return time;
    // Already in the start's frame: a moment for a moment, or a clock time in the same (or no) zone.
    if (clockTime ? floating(time) && (!tzid || tzid === own || !zoneFormatter(tzid)) : !floating(time)) return time;
    return frame(instant(time, tzid));
  };
  let converted = false;
  const values = (name) =>
    master.getAllProperties(name).map((p) =>
      p.getValues().map((v) => {
        const next = convert(v, p.getParameter('tzid') || null);
        converted = converted || next !== v;
        return next;
      })
    );
  const exdates = values('exdate');
  const rdates = values('rdate');
  if (!converted) return master;
  // The copy keeps the object's zone definitions, so a start in one of them still means the same moment.
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  for (const zone of master.parent ? master.parent.getAllSubcomponents('vtimezone') : []) vcal.addSubcomponent(clone(zone));
  const copy = clone(master);
  vcal.addSubcomponent(copy);
  for (const [name, lists] of [['exdate', exdates], ['rdate', rdates]]) {
    copy.removeAllProperties(name);
    for (const list of lists) {
      const p = new ICAL.Property(name);
      p.setValues(list);
      copy.addProperty(p);
    }
  }
  return copy;
}

// The start times of a series, in order: its rule, its extra dates and without its excluded ones. A series with more
// occurrences before the end of what is asked than Rukoo steps through fails, rather than look empty.
function* starts(master) {
  const it = new ICAL.Event(stepper(master)).iterator();
  for (let i = 0; i < MAX_STEPS; i++) {
    const next = it.next();
    if (!next) return;
    yield next;
  }
  throw calendarError('too_many', t('errors.calendar.tooMany'));
}

// The start of the occurrence a name points at, or null when the series has no such occurrence (any more).
function occurrenceStart(master, rid) {
  const tzid = tzidOf(master, 'dtstart');
  for (const time of starts(master)) {
    const r = ridOf(time, tzid);
    if (r === rid) return time;
    if (r > rid && r.length === rid.length) return null;
  }
  return null;
}

function person(p) {
  return { name: String(p.getParameter('cn') || '').trim(), address: String(p.getFirstValue() || '').replace(/^mailto:/i, '').trim().toLowerCase() };
}

const roomOrResource = (p) => /^(room|resource)$/i.test(String(p.getParameter('cutype') || ''));

// The link to a video call: Google's own property, the event's URL or place, or the first one in the description.
function meetingLink(comp, location, description, video = VIDEO) {
  const candidates = [comp.getFirstPropertyValue('x-google-conference'), comp.getFirstPropertyValue('url'), location, ...(String(description).match(/https:\/\/[^\s<>"']+/g) || [])];
  return candidates.map((v) => String(v || '').trim()).find((v) => video.test(v)) || null;
}

// Who sends invitations for guests on a calendar: its server ('provider') or nobody Rukoo knows of ('none'). A
// calendar cached before Rukoo kept this has only the server's own answer (scheduling).
const invitesOf = (cal) => (cal.invites === 'provider' || cal.invites === 'none' ? cal.invites : cal.scheduling === true ? 'provider' : 'none');

// An alarm's time as minutes before the event's start: negative for a time after it (on an all-day event's own day).
// start and length are the event's, for an alarm set at a moment or relative to the end. null when unreadable.
function triggerMinutes(alarm, start, length) {
  const p = alarm.getFirstProperty('trigger');
  const value = p && p.getFirstValue();
  if (!value) return null;
  let seconds;
  if (value instanceof ICAL.Duration) {
    seconds = -value.toSeconds();
    if (/^end$/i.test(String(p.getParameter('related') || ''))) seconds -= length / 1000;
  } else if (value instanceof ICAL.Time) {
    seconds = (start - value.toUnixTime() * 1000) / 1000;
  } else {
    return null;
  }
  return Number.isFinite(seconds) ? Math.round(seconds / 60) : null;
}

const actionOf = (alarm) => String(alarm.getFirstPropertyValue('action') || '').toUpperCase();

// The event's reminders, from its alarms (VALARM): null when it has none, which says nothing (the calendar's or
// Rukoo's default applies). A snoozed copy of an alarm (RELATED-TO) isn't a reminder of its own.
function readReminders(comp, start, length) {
  const alarms = comp.getAllSubcomponents('valarm');
  if (!alarms.length) return null;
  const overrides = [];
  for (const a of alarms) {
    if (a.hasProperty('related-to')) continue;
    const action = actionOf(a);
    const method = action === 'EMAIL' ? 'email' : action === 'DISPLAY' || action === 'AUDIO' ? 'popup' : null;
    if (!method) continue;
    const minutes = triggerMinutes(a, start, length);
    if (minutes !== null && !overrides.some((r) => r.method === method && r.minutes === minutes)) overrides.push({ method, minutes });
  }
  return { useDefault: false, overrides: overrides.sort((a, b) => a.minutes - b.minutes) };
}

// An event as the calendar store keeps it. me: the account's own addresses, to tell the user apart from the guests.
// locked: part of a series Rukoo can show but not change (see seriesContext). original: the occurrence's start in its
// series. local: the guests are made up and nobody emails them (the demo), so a meeting with guests can be changed.
function toEvent(comp, { cal, href, etag, me, rid = null, seriesId = null, locked = false, startTime, endTime, tzid, endTzid, original = null, local = false, video = VIDEO }) {
  const allDay = startTime.isDate;
  let start = instant(startTime, tzid);
  let end = endTime ? instant(endTime, endTzid) : start;
  const startDate = allDay ? dateText(startTime) : null;
  let endDate = allDay && endTime && endTime.isDate ? dateText(endTime) : null;
  if (allDay && (!endDate || end <= start)) {
    endDate = nextDay(startDate);
    end = localDay(endDate);
  }
  if (end < start) end = start;
  const org = comp.getFirstProperty('organizer');
  const organizer = org ? { ...person(org), self: false } : null;
  if (organizer) organizer.self = !organizer.address || me.has(organizer.address);
  const own = !organizer || organizer.self;
  // Rooms and resources aren't shown as guests, but a change still reaches them.
  const everyone = comp
    .getAllProperties('attendee')
    .map((p) => {
      const who = person(p);
      return {
        ...who,
        response: PARTSTAT[String(p.getParameter('partstat') || 'NEEDS-ACTION').toUpperCase()] || 'needsAction',
        self: me.has(who.address),
        organizer: Boolean(organizer && organizer.address && organizer.address === who.address),
        optional: /^opt-participant$/i.test(String(p.getParameter('role') || '')),
        booked: roomOrResource(p)
      };
    })
    .filter((a) => a.address);
  const attendees = everyone.filter((a) => !a.booked).map(({ booked, ...a }) => a);
  const mine = attendees.find((a) => a.self);
  // Where the server sends the invitations, the organizer changes a meeting with guests and the server tells them.
  // Elsewhere a meeting with guests, or with a room or resource booked, stays as it is: depending on the server, a
  // change would email them or change the booking without Rukoo asking. An invitation can be answered where the
  // server tells the organizer.
  const invites = invitesOf(cal);
  const guests = everyone.filter((a) => !a.self && !(own && a.organizer));
  const changeable = Boolean(cal.writable && own && !locked && (local || invites === 'provider' || !guests.length));
  const location = String(comp.getFirstPropertyValue('location') || '').trim();
  const description = plainDescription(comp.getFirstPropertyValue('description'));
  // A TZID is the sender's text: only a zone the PC knows by name, or UTC, reaches the store (Zone | null).
  const zone = zoneOrNull(tzid) || (!allDay && utcTime(startTime) ? 'UTC' : null);
  const kind = String(comp.getFirstPropertyValue('class') || '').toUpperCase();
  // A booking id counts only on an event the user organizes: anyone can send an invitation that carries one.
  const booking = own ? String(comp.getFirstPropertyValue(BOOKING) || '').trim() : '';
  return {
    calendarId: cal.id,
    eventId: rid ? `${href}#${rid}` : href,
    // The version of the calendar object; every occurrence of a series shares it.
    etag: etag || null,
    eventType: 'default',
    seriesId,
    uid: String(comp.getFirstPropertyValue('uid') || '') || null,
    originalStart: original,
    recurring: Boolean(seriesId),
    title: String(comp.getFirstPropertyValue('summary') || ''),
    location,
    description,
    allDay,
    start,
    end,
    startDate,
    endDate,
    timeZone: zone,
    endTimeZone: zoneOrNull(endTzid) || zone,
    status: String(comp.getFirstPropertyValue('status') || '').toUpperCase() === 'TENTATIVE' ? 'tentative' : 'confirmed',
    busy: String(comp.getFirstPropertyValue('transp') || '').toUpperCase() !== 'TRANSPARENT',
    visibility: CLASSES[kind] || 'default',
    reminders: readReminders(comp, start, end - start),
    response: mine && !own ? mine.response : null,
    canEdit: changeable,
    canDelete: changeable,
    canRespond: local ? Boolean(mine && !own) : Boolean(mine && !own && cal.writable && invites === 'provider' && !locked),
    canInvite: !local && invites === 'provider' && cal.writable && own && !locked ? 'edit' : false,
    canMove: changeable && own,
    organizer,
    attendees,
    moreAttendees: false,
    link: null,
    meeting: meetingLink(comp, location, description, video),
    conference: null,
    bookingId: booking || null
  };
}

// One event, or one occurrence changed on its own, with its own times.
function ownEvent(comp, ctx) {
  const ev = new ICAL.Event(comp);
  const rid = comp.hasProperty('recurrence-id') ? exceptionRid(comp) : null;
  const tzid = tzidOf(comp, 'dtstart');
  return toEvent(comp, { ...ctx, rid, startTime: ev.startDate, endTime: ev.endDate, tzid, endTzid: tzidOf(comp, 'dtend') || tzid, original: rid ? exceptionAt(comp) : null });
}

// The clock of a series' start, as a way to turn a moment into a clock time and back (see clock).
function clockOf(master) {
  const c = frameClock(frameOf(master), master.parent);
  return { toClock: (ms) => clockParts(c.toWall(ms)), fromClock: (parts) => c.fromWall(onClock(parts)) };
}

// The exceptions that also change every later occurrence (RANGE=THISANDFUTURE), in order. From the moment of its
// original start (from), each occurrence moves by shift on the series' clock, so a move of a week stays a week across
// a change to summer time; it lasts length and takes the exception's fields, until the next change.
function laterChanges(obj) {
  const seriesClock = clockOf(obj.master);
  return obj.exceptions
    .filter(ranged)
    .map((x) => {
      const ev = new ICAL.Event(x);
      const tz = tzidOf(x, 'dtstart');
      const from = exceptionAt(x);
      const start = instant(ev.startDate, tz);
      const shift = onClock(seriesClock.toClock(start)) - onClock(seriesClock.toClock(from));
      return { comp: x, tz, from, shift, clock: seriesClock, length: Math.max(0, instant(ev.endDate, tzidOf(x, 'dtend') || tz) - start), allDay: ev.startDate.isDate };
    })
    .sort((a, b) => a.from - b.from);
}

// An occurrence's moment moved by a change's shift on the series' clock.
function moved(at, change) {
  return change.clock.fromClock(clockParts(onClock(change.clock.toClock(at)) + change.shift));
}

// The occurrences of a series share its address as seriesId. A series with a change to this and every later
// occurrence is shown with that change, but Rukoo leaves it alone: a change to one occurrence there would apply to
// every one after it as well.
function seriesContext(obj, ctx) {
  const changes = laterChanges(obj);
  return { ...ctx, seriesId: ctx.href, locked: changes.length > 0, changes };
}

// An occurrence the rule makes: the series' fields at one of its start times, or, after a change to that and every
// later occurrence, the changed fields at the moved time; null when that change cancelled them.
function ruleEvent(master, time, series) {
  const tzid = tzidOf(master, 'dtstart');
  const { changes = [], ...ctx } = series;
  const rid = ridOf(time, tzid);
  const at = instant(time, tzid);
  const change = changes.filter((c) => c.from <= at).pop();
  if (change) {
    if (cancelled(change.comp)) return null;
    let startTime;
    let endTime;
    if (change.allDay) {
      const d = new Date(at);
      d.setDate(d.getDate() + Math.round(change.shift / DAY));
      const e = new Date(d);
      e.setDate(e.getDate() + Math.max(1, Math.round(change.length / DAY)));
      startTime = ICAL.Time.fromDateString(dayKey(d));
      endTime = ICAL.Time.fromDateString(dayKey(e));
    } else {
      const from = moved(at, change);
      startTime = ICAL.Time.fromJSDate(new Date(from), true);
      endTime = ICAL.Time.fromJSDate(new Date(from + change.length), true);
    }
    return toEvent(change.comp, { ...ctx, rid, startTime, endTime, tzid: change.tz, endTzid: change.tz, original: at });
  }
  const end = time.clone();
  end.addDuration(new ICAL.Event(master).duration);
  return toEvent(master, { ...ctx, rid, startTime: time, endTime: end, tzid, endTzid: tzid, original: at });
}

// The events of one calendar object that overlap start to end: the event itself, or the occurrences of a series.
// An occurrence changed on its own replaces the one the rule makes, wherever it moved to.
// ctx: { cal, href, etag, me, local?, video? }; href is the object's name in event ids, and the series' id.
function expand(obj, ctx, start, end) {
  const out = [];
  const add = (e) => {
    if (e && e.start < end && e.end > start) out.push(e);
  };
  const { master, exceptions } = obj;
  if (!recurring(master)) {
    for (const comp of [master, ...exceptions]) if (comp && !cancelled(comp)) add(ownEvent(comp, ctx));
    return out;
  }
  if (cancelled(master)) return out;
  const series = seriesContext(obj, ctx);
  const { changes, ...own } = series;
  const tzid = tzidOf(master, 'dtstart');
  const changed = new Set(exceptions.map(exceptionRid));
  // A change that moved later occurrences earlier brings ones from after the end into view; a day more covers any
  // clock change along the way (some zones change by two hours). It only decides how far the series is stepped.
  const ahead = Math.min(0, ...changes.map((c) => c.shift - DAY));
  for (const time of starts(master)) {
    if (instant(time, tzid) + ahead >= end) break;
    if (!changed.has(ridOf(time, tzid))) add(ruleEvent(master, time, series));
  }
  for (const x of exceptions) if (!cancelled(x)) add(ownEvent(x, own));
  return out;
}

// The one event or occurrence an id names, from a calendar object; null when it isn't there (any more).
function pick(obj, ctx, rid) {
  const { master, exceptions } = obj;
  if (!rid) return master && !recurring(master) && !cancelled(master) ? ownEvent(master, ctx) : null;
  const series = recurring(master) ? seriesContext(obj, ctx) : ctx;
  const { changes, ...own } = series;
  const x = exceptions.find((c) => exceptionRid(c) === rid);
  if (x) return cancelled(x) ? null : ownEvent(x, own);
  if (!recurring(master) || cancelled(master)) return null;
  const time = occurrenceStart(master, rid);
  return time ? ruleEvent(master, time, series) : null;
}

// An event id is the calendar object's name, with the occurrence after a # for one occurrence of a series.
function splitId(eventId) {
  const s = String(eventId);
  const i = s.lastIndexOf('#');
  return i < 0 ? { href: s, rid: null } : { href: s.slice(0, i), rid: s.slice(i + 1) };
}

// The series as the event dialog edits it (SeriesInfo in the contracts), without its version.
function seriesInfo(obj) {
  const { master } = obj;
  if (!master || !recurring(master)) throw notFound();
  const tzid = tzidOf(master, 'dtstart');
  const ev = new ICAL.Event(master);
  const allDay = ev.startDate.isDate;
  const rules = master.getAllProperties('rrule').map((p) => p.getFirstValue().toString());
  return {
    rule: rules[0] || null,
    rules,
    extra: ['rdate', 'exdate', 'exrule'].flatMap((name) => master.getAllProperties(name).map((p) => p.toICALString())),
    exdates: master.getAllProperties('exdate').flatMap((p) => p.getValues().filter((v) => v instanceof ICAL.Time).map((v) => instant(v, p.getParameter('tzid') || null))),
    start: instant(ev.startDate, tzid),
    end: instant(ev.endDate, tzidOf(master, 'dtend') || tzid),
    allDay,
    startDate: allDay ? dateText(ev.startDate) : null,
    endDate: allDay ? dateText(ev.endDate) : null,
    timeZone: zoneOrNull(tzid) || (!allDay && utcTime(ev.startDate) ? 'UTC' : null)
  };
}

// Whether anyone is invited to the event, or to any occurrence of it.
const hasGuests = (obj) => [obj.master, ...obj.exceptions].some((c) => c && c.hasProperty('attendee'));

// The name of a series' first occurrence, or null for a single event (or a series without any).
function firstRid(obj) {
  const { master } = obj;
  if (!master || !recurring(master)) return null;
  for (const time of starts(master)) return ridOf(time, tzidOf(master, 'dtstart'));
  return null;
}

// ---------- writing ----------

function text(comp, name, value) {
  if (value) comp.updatePropertyWithValue(name, value);
  else comp.removeAllProperties(name);
}

function clone(comp) {
  return new ICAL.Component(JSON.parse(JSON.stringify(comp.toJSON())));
}

const raw = (comp, name) => String(comp.getFirstPropertyValue(name) ?? '');

// What decides whether a change goes out again as an update (see SIGNIFICANT): the times as moments, and the rest as
// written.
function significance(comp) {
  const ev = new ICAL.Event(comp);
  const tzid = tzidOf(comp, 'dtstart');
  const times = ev.startDate ? [instant(ev.startDate, tzid), ev.startDate.isDate, ev.endDate ? instant(ev.endDate, tzidOf(comp, 'dtend') || tzid) : null] : [];
  return JSON.stringify([times, ...SIGNIFICANT.map((n) => comp.getAllProperties(n).map((p) => p.toICALString()).sort())]);
}

// Marks a component as changed now; SEQUENCE rises only when what before measured changed.
function touch(comp, before) {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  comp.updatePropertyWithValue('dtstamp', now);
  comp.updatePropertyWithValue('last-modified', now);
  if (before !== undefined && significance(comp) !== before) comp.updatePropertyWithValue('sequence', (Number(comp.getFirstPropertyValue('sequence')) || 0) + 1);
}

function writeBusy(comp, busy) {
  if (busy === false) comp.updatePropertyWithValue('transp', 'TRANSPARENT');
  else comp.removeAllProperties('transp');
}

function writeVisibility(comp, visibility) {
  const kind = Object.keys(CLASSES).find((k) => CLASSES[k] === visibility);
  if (kind) comp.updatePropertyWithValue('class', kind);
  else comp.removeAllProperties('class');
}

function alarm(fields) {
  const a = new ICAL.Component('valarm');
  for (const [name, value] of fields) {
    const p = new ICAL.Property(name);
    p.setValue(value);
    a.addProperty(p);
  }
  return a;
}

// The popup reminders become the event's display alarms. Alarms that already match stay as they are (with their own
// UID and texts), email alarms aren't Rukoo's to change, and an event left without any gets the alarm that says so.
// minutes count back from the start; negative ones are a time on an all-day event's own day.
function writeReminders(comp, reminders, title) {
  if (!reminders || !Array.isArray(reminders.overrides)) return;
  const wanted = [...new Set(reminders.overrides.filter((r) => r && r.method === 'popup' && Number.isInteger(r.minutes)).map((r) => r.minutes))];
  const ev = new ICAL.Event(comp);
  const tzid = tzidOf(comp, 'dtstart');
  const start = instant(ev.startDate, tzid);
  const length = instant(ev.endDate, tzidOf(comp, 'dtend') || tzid) - start;
  const kept = new Set();
  for (const a of comp.getAllSubcomponents('valarm')) {
    const action = actionOf(a);
    const own = !a.hasProperty('related-to');
    if (action === 'EMAIL' && own) continue;
    const minutes = triggerMinutes(a, start, length);
    if ((action === 'DISPLAY' || action === 'AUDIO') && own && wanted.includes(minutes) && !kept.has(minutes)) kept.add(minutes);
    else comp.removeSubcomponent(a);
  }
  for (const minutes of wanted) {
    if (kept.has(minutes)) continue;
    comp.addSubcomponent(alarm([['uid', crypto.randomUUID()], ['action', 'DISPLAY'], ['description', title || 'Reminder'], ['trigger', ICAL.Duration.fromSeconds(-minutes * 60)]]));
  }
  if (!comp.getAllSubcomponents('valarm').length) {
    comp.addSubcomponent(alarm([['uid', crypto.randomUUID()], ['action', 'NONE'], ['trigger', ICAL.Time.fromString(NO_ALARM)]]));
  }
}

const hasDiff = (diff) => Boolean(diff && ((diff.add && diff.add.length) || (diff.remove && diff.remove.length) || (diff.optional && Object.keys(diff.optional).length)));

function attendeeProperty(address, { name = '', role = 'REQ-PARTICIPANT', partstat = 'NEEDS-ACTION', rsvp = true } = {}) {
  const p = new ICAL.Property('attendee');
  p.setValue(`mailto:${address}`);
  if (name) p.setParameter('cn', name);
  p.setParameter('cutype', 'INDIVIDUAL');
  p.setParameter('role', role);
  p.setParameter('partstat', partstat);
  if (rsvp) p.setParameter('rsvp', 'TRUE');
  return p;
}

// Applies the dialog's guest changes to the guests as they are: every existing entry keeps its answer and
// parameters, rooms and resources stay, and the user becomes the organizer with the first guest and stops being one
// with the last. organizer: { address, name } for the user.
function applyGuests(comp, diff, { me, organizer }) {
  if (!hasDiff(diff)) return;
  const org = comp.getFirstProperty('organizer');
  if (org && !me.has(person(org).address)) throw refused('errors.calendar.notOrganizer');
  const remove = new Set((diff.remove || []).map((a) => String(a).trim().toLowerCase()));
  for (const p of comp.getAllProperties('attendee')) {
    const address = person(p).address;
    if (remove.has(address) && !roomOrResource(p) && !me.has(address)) comp.removeProperty(p);
  }
  const find = (address) => comp.getAllProperties('attendee').find((p) => person(p).address === address);
  for (const g of diff.add || []) {
    const address = String(g.address || '').trim().toLowerCase();
    if (!address || me.has(address)) continue;
    const there = find(address);
    if (there) {
      if (typeof g.optional === 'boolean' && !roomOrResource(there)) there.setParameter('role', g.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT');
      continue;
    }
    comp.addProperty(attendeeProperty(address, { name: String(g.name || '').trim(), role: g.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT' }));
  }
  for (const [address, optional] of Object.entries(diff.optional || {})) {
    const p = find(String(address).trim().toLowerCase());
    if (p && !roomOrResource(p) && typeof optional === 'boolean') p.setParameter('role', optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT');
  }
  const others = comp.getAllProperties('attendee').filter((p) => !me.has(person(p).address));
  if (others.length && !comp.hasProperty('organizer') && organizer && organizer.address) {
    const p = new ICAL.Property('organizer');
    p.setValue(`mailto:${organizer.address}`);
    if (organizer.name) p.setParameter('cn', organizer.name);
    comp.addProperty(p);
    if (!find(organizer.address)) comp.addProperty(attendeeProperty(organizer.address, { name: organizer.name, role: 'CHAIR', partstat: 'ACCEPTED', rsvp: false }));
  }
  if (!others.length) {
    comp.removeAllProperties('organizer');
    for (const p of comp.getAllProperties('attendee')) comp.removeProperty(p);
  }
}

// What the user changed, against the event they opened.
function changes(event, input) {
  const startOf = (x) => (x.allDay ? x.startDate : x.start);
  const endOf = (x) => (x.allDay ? x.endDate : x.end);
  const allDay = input.allDay !== event.allDay;
  return {
    title: input.title !== undefined && input.title !== event.title,
    location: input.location !== undefined && input.location !== event.location,
    // Rukoo shows a description as plain text, so one the user didn't touch stays as the server has it.
    description: input.description !== undefined && input.description !== event.description,
    allDay,
    start: allDay || startOf(input) !== startOf(event),
    end: allDay || endOf(input) !== endOf(event),
    reminders: input.reminders !== undefined && JSON.stringify(input.reminders) !== JSON.stringify(event.reminders),
    busy: input.busy !== undefined && input.busy !== event.busy,
    visibility: input.visibility !== undefined && input.visibility !== event.visibility,
    guests: hasDiff(input.guests)
  };
}

// The fields besides the times. old: the series' values before the change, for an exception, which keeps a title,
// place or description of its own.
function applyFields(comp, input, ch, o, old = null) {
  const own = (name) => Boolean(old) && comp !== old.comp && raw(comp, name) !== old[name];
  if (ch.title && !own('summary')) text(comp, 'summary', input.title);
  if (ch.location && !own('location')) text(comp, 'location', input.location);
  if (ch.description && !own('description')) text(comp, 'description', input.description);
  if (ch.busy) writeBusy(comp, input.busy);
  if (ch.visibility) writeVisibility(comp, input.visibility);
  if (ch.guests) applyGuests(comp, input.guests, o);
  if (ch.reminders) writeReminders(comp, input.reminders, input.title);
}

// A rule's end for a clock reading of the frame (RFC 5545 3.3.10): a date for all-day events, UTC for a series in a
// zone or in UTC, a clock time for a floating one.
function untilAt(wall, frame, vcal) {
  const c = clockParts(wall);
  if (frame.allDay) return ICAL.Time.fromData({ year: c.year, month: c.month, day: c.day, isDate: true });
  if (frame.tzid === null) return ICAL.Time.fromData({ ...c, isDate: false });
  return ICAL.Time.fromJSDate(new Date(frameClock(frame, vcal).fromWall(wall)), true);
}

// An RRULE value from the dialog, with its end written the way its start is. An end date includes that whole day.
function normalizeRule(value, frame, vcal) {
  let recur;
  try {
    recur = ICAL.Recur.fromString(String(value).replace(/^RRULE:/i, ''));
  } catch (_) {
    recur = null;
  }
  if (!recur || !recur.freq) throw calendarError('invalid', t('errors.calendar.invalidRule'));
  if (recur.until) {
    const u = recur.until;
    let wall;
    if (u.isDate) wall = frame.allDay ? Date.UTC(u.year, u.month - 1, u.day) : Date.UTC(u.year, u.month - 1, u.day, 23, 59, 59);
    else if (utcTime(u)) wall = frameClock(frame, vcal).toWall(u.toUnixTime() * 1000);
    else wall = onClock(u);
    recur.until = untilAt(wall, frame, vcal);
  }
  return recur;
}

function sameRule(master, value, frame, vcal) {
  if (value === null) return !recurring(master);
  const rules = master.getAllProperties('rrule');
  return rules.length === 1 && normalizeRule(value, frame, vcal).toString() === rules[0].getFirstValue().toString();
}

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// The same rule on another day: when a series moves from one date to another (clock readings from and to), the
// weekday, day of the month and month it repeats on follow. A rule on several weekdays can't follow a move to another
// weekday, nor a rule that picks among its days (BYSETPOS): Rukoo can't tell which day should take its place.
function shiftRule(recur, from, to) {
  const a = clockParts(from);
  const b = clockParts(to);
  if (a.year === b.year && a.month === b.month && a.day === b.day) return;
  const wa = new Date(from).getUTCDay();
  const wb = new Date(to).getUTCDay();
  const parts = recur.parts;
  const fail = () => {
    throw refused('errors.calendar.seriesDayChange');
  };
  if ((parts.BYSETPOS && parts.BYSETPOS.length) || (parts.BYYEARDAY && parts.BYYEARDAY.length) || (parts.BYWEEKNO && parts.BYWEEKNO.length)) fail();
  if (parts.BYDAY && parts.BYDAY.length) {
    if (parts.BYDAY.length > 1) {
      if (wa !== wb && !(recur.freq === 'DAILY' && parts.BYDAY.includes(DAYS[wb]))) fail();
    } else {
      const m = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(String(parts.BYDAY[0]).toUpperCase());
      if (!m) fail();
      let n = m[1] ? Number(m[1]) : null;
      if (n !== null) {
        const nth = Math.ceil(b.day / 7);
        const last = b.day + 7 > daysIn(b.year, b.month);
        // The 5th of a weekday is always the month's last.
        n = n < 0 && last ? -1 : nth <= 4 ? nth : -1;
      }
      parts.BYDAY = [`${n === null ? '' : n}${DAYS[wb]}`];
    }
  }
  if (parts.BYMONTHDAY && parts.BYMONTHDAY.length && a.day !== b.day) {
    if (parts.BYMONTHDAY.length > 1) fail();
    parts.BYMONTHDAY = [parts.BYMONTHDAY[0] < 0 && b.day === daysIn(b.year, b.month) ? -1 : b.day];
  }
  if (parts.BYMONTH && parts.BYMONTH.length && a.month !== b.month) {
    if (parts.BYMONTH.length > 1) fail();
    parts.BYMONTH = [b.month];
  }
}

// Rewrites the values of a list property (EXDATE, RDATE): keep says which stay, map moves each into frame. A period
// is kept as it is. into: another component to write them to, leaving comp as it was.
function rewriteDates(comp, name, { map = null, keep = () => true, frame = null, into = comp } = {}) {
  const lists = comp.getAllProperties(name).map((p) => ({ tzid: p.getParameter('tzid') || null, values: p.getValues(), type: p.type }));
  if (into === comp) comp.removeAllProperties(name);
  for (const { tzid, values, type } of lists) {
    const out = values.filter((v) => !(v instanceof ICAL.Time) || keep(v, tzid));
    if (!out.length) continue;
    const q = new ICAL.Property(name);
    if (!map || out.some((v) => !(v instanceof ICAL.Time))) {
      if (type === 'period') q.resetType('period');
      q.setValues(out);
      if (tzid) q.setParameter('tzid', tzid);
    } else {
      q.setValues(out.map((v) => map(v, tzid).time));
      if (frame && !frame.allDay && named(frame.tzid)) q.setParameter('tzid', frame.tzid);
    }
    into.addProperty(q);
  }
}

// The occurrence changed on its own, made from the series when it doesn't exist yet.
function exceptionFor(obj, rid) {
  const found = obj.exceptions.find((c) => exceptionRid(c) === rid);
  if (found) return found;
  const { master } = obj;
  if (!recurring(master)) return null;
  const time = occurrenceStart(master, rid);
  if (!time) return null;
  const tzid = tzidOf(master, 'dtstart');
  const x = clone(master);
  // An event has DTEND or DURATION, never both; the exception gets a DTEND.
  for (const name of ['rrule', 'rdate', 'exdate', 'exrule', 'recurrence-id', 'duration']) x.removeAllProperties(name);
  obj.vcal.addSubcomponent(x);
  const end = time.clone();
  end.addDuration(new ICAL.Event(master).duration);
  setTime(x, 'recurrence-id', { time: time.clone(), tzid: zoneParam(time, tzid) });
  setTime(x, 'dtstart', { time: time.clone(), tzid: zoneParam(time, tzid) });
  setTime(x, 'dtend', { time: end, tzid: zoneParam(end, tzid) });
  obj.exceptions.push(x);
  return x;
}

// One event, or one occurrence, gets the dialog's fields. Its times are written as moments: in its own zone, or the
// one the dialog chose; o.zone (the PC's) for times that had none, as when an all-day event gets times. A rule
// (input.recurrence) makes a single event a series; then this returns the name of its first occurrence.
function applyOne(obj, comp, event, input, o) {
  const { vcal } = obj;
  const before = significance(comp);
  const ch = changes(event, input);
  applyFields(comp, input, ch, o);
  const frame = frameOf(comp);
  const chosen = input.allDay ? null : zoneOrNull(input.timeZone);
  const series = !comp.hasProperty('recurrence-id') && typeof input.recurrence === 'string';
  const masterFrame = obj.master && obj.master !== comp ? frameOf(obj.master) : null;
  let tzid = chosen || (frame.allDay ? (masterFrame && !masterFrame.allDay && masterFrame.tzid) || o.zone : frame.tzid);
  // A rule is followed on a clock: a series in UTC or in floating times would be an hour off after the clocks
  // change, so it moves to a zone.
  if (series && !input.allDay && !named(tzid)) tzid = o.zone;
  const zoneChange = !input.allDay && (frame.allDay || (tzid || null) !== (frame.tzid || null));
  if (ch.start || ch.end || zoneChange) {
    comp.removeAllProperties('duration');
    if (input.allDay) {
      setTime(comp, 'dtstart', { time: ICAL.Time.fromDateString(input.startDate), tzid: null });
      setTime(comp, 'dtend', { time: ICAL.Time.fromDateString(input.endDate), tzid: null });
    } else {
      const endTzid = !zoneChange && tzidOf(comp, 'dtend') ? tzidOf(comp, 'dtend') : tzid;
      const write = series ? writeSeriesTime : writeTime;
      setTime(comp, 'dtstart', write(input.start, tzid, vcal));
      setTime(comp, 'dtend', write(input.end, endTzid, vcal));
    }
  }
  let rid = null;
  if (series) {
    comp.removeAllProperties('rrule');
    comp.addPropertyWithValue('rrule', normalizeRule(input.recurrence, frameOf(comp), vcal));
    rid = ridOf(comp.getFirstPropertyValue('dtstart'), tzidOf(comp, 'dtstart'));
  }
  touch(comp, before);
  return rid;
}

// A change to every occurrence of a series. The series moves by the change to the opened occurrence on the clock of
// the series' zone (a move from 09:00 to 10:00 stays 10:00 after the clocks change), its start and its end each by
// their own; the occurrences changed on their own and the excluded dates move with it, and the rule follows its place
// in the series to the new weekday or date. Only what the user changed reaches the series, and an occurrence with a
// title, place or description of its own keeps it. The opened occurrence, when it was changed on its own, ends up as
// the dialog has it. A new rule drops the changed occurrences and excluded dates it doesn't have. Returns the opened
// occurrence's name afterwards (null: the series became one event).
function applyAll(obj, event, input, o) {
  const { vcal, master } = obj;
  const before = new Map([master, ...obj.exceptions].map((c) => [c, significance(c)]));
  const ch = changes(event, input);
  const old = { comp: master, summary: raw(master, 'summary'), location: raw(master, 'location'), description: raw(master, 'description') };
  const opened = (o.rid && obj.exceptions.find((x) => exceptionRid(x) === o.rid)) || null;
  const f0 = frameOf(master);
  const rule = input.recurrence;
  const ruleChange = rule !== undefined && !sameRule(master, rule, f0, vcal);
  const chosen = zoneOrNull(input.timeZone);
  let tzid = null;
  if (!input.allDay) {
    if (chosen) tzid = chosen;
    else if (!f0.allDay && (named(f0.tzid) || !ruleChange)) tzid = f0.tzid;
    else tzid = o.zone;
  }
  const f1 = { allDay: Boolean(input.allDay), tzid };
  const c0 = frameClock(f0, vcal);
  const c1 = frameClock(f1, vcal);
  const wallOld = (ms, date, allDay) => (allDay ? dateWall(date) : c0.toWall(ms));
  const wallNew = (ms, date) => (f1.allDay ? dateWall(date) : c1.toWall(ms));
  const from = wallOld(event.start, event.startDate, event.allDay);
  const to = wallNew(input.start, input.startDate);
  const ds = to - from;
  const endTo = wallNew(input.end, input.endDate);
  const de = endTo - wallOld(event.end, event.endDate, event.allDay);
  // The opened occurrence's place in the series, which the rule has to keep making: where the rule put it, not the
  // day it was moved to on its own.
  const slot = opened ? wallIn(opened.getFirstPropertyValue('recurrence-id'), tzidOf(opened, 'recurrence-id'), f0, vcal) : from;
  const reframe = ds !== 0 || de !== 0 || f0.allDay !== f1.allDay || f0.tzid !== f1.tzid;
  const map = (time, tz, d) => timeFromWall(wallIn(time, tz, f0, vcal) + d, f1);
  let rid = o.rid;
  if (reframe) {
    const ev = new ICAL.Event(master);
    const tz0 = tzidOf(master, 'dtstart');
    const startTime = ev.startDate;
    const endTime = ev.endDate;
    const tzEnd = tzidOf(master, 'dtend') || tz0;
    setTime(master, 'dtstart', map(startTime, tz0, ds));
    master.removeAllProperties('duration');
    setTime(master, 'dtend', map(endTime, tzEnd, de));
    for (const x of obj.exceptions) {
      const ridProp = x.getFirstProperty('recurrence-id');
      const range = ridProp.getParameter('range');
      const r = ridProp.getFirstValue();
      const rz = tzidOf(x, 'recurrence-id');
      const xev = new ICAL.Event(x);
      const xz = tzidOf(x, 'dtstart');
      const alone = xev.startDate.isDate !== r.isDate || instant(xev.startDate, xz) !== instant(r, rz);
      setTime(x, 'recurrence-id', map(r, rz, ds));
      if (range) x.getFirstProperty('recurrence-id').setParameter('range', range);
      if (x === opened) {
        // The opened occurrence goes where the user put it.
        x.removeAllProperties('duration');
        setTime(x, 'dtstart', timeFromWall(to, f1));
        setTime(x, 'dtend', timeFromWall(endTo, f1));
      } else if (!alone || f0.allDay !== f1.allDay) {
        // An occurrence moved on its own stays where it was put.
        const xEnd = xev.endDate;
        x.removeAllProperties('duration');
        setTime(x, 'dtstart', map(xev.startDate, xz, ds));
        setTime(x, 'dtend', map(xEnd, tzidOf(x, 'dtend') || xz, de));
      }
    }
    for (const name of ['exdate', 'rdate']) rewriteDates(master, name, { map: (v, tz) => map(v, tz, ds), frame: f1 });
    for (const p of master.getAllProperties('rrule')) {
      const recur = p.getFirstValue();
      if (!recur.until) continue;
      recur.until = untilAt(wallIn(recur.until, null, f0, vcal) + ds, f1, vcal);
      p.setValue(recur);
    }
    if (rid) rid = ridAt(c0.toWall(ridInstant(rid)) + ds, f1, vcal);
  }
  if (rule === null) {
    for (const name of ['rrule', 'rdate', 'exdate', 'exrule']) master.removeAllProperties(name);
    for (const x of obj.exceptions) obj.vcal.removeSubcomponent(x);
    obj.exceptions = [];
    rid = null;
  } else if (ruleChange) {
    master.removeAllProperties('rrule');
    master.addPropertyWithValue('rrule', normalizeRule(rule, f1, vcal));
    prune(obj);
  } else if (reframe) {
    for (const p of master.getAllProperties('rrule')) {
      const recur = p.getFirstValue();
      shiftRule(recur, slot, slot + ds);
      p.setValue(recur);
    }
  }
  // The opened occurrence takes what the user changed in it, also a title of its own.
  for (const c of [master, ...obj.exceptions]) applyFields(c, input, ch, o, c === opened ? null : old);
  for (const c of [master, ...obj.exceptions]) touch(c, before.get(c));
  return rid;
}

// After a new rule: the occurrences changed on their own and the excluded dates it doesn't make go. A changed
// occurrence is shown wherever it was put, so one the rule no longer has would show as an extra event, also in other
// apps. A series' start is always its first occurrence (RFC 5545), also where ical.js, which skips a start the rule
// doesn't match, leaves it out. Only names of the start's kind (dates for an all-day series, times otherwise) are
// checked, and a name further along than Rukoo steps stays.
function prune(obj) {
  const { master } = obj;
  const start = master.getFirstPropertyValue('dtstart');
  const tzid = tzidOf(master, 'dtstart');
  const kind = (time) => time instanceof ICAL.Time && time.isDate === start.isDate;
  const wanted = new Set();
  for (const x of obj.exceptions) if (kind(x.getFirstPropertyValue('recurrence-id'))) wanted.add(exceptionRid(x));
  for (const p of master.getAllProperties('exdate')) for (const v of p.getValues()) if (kind(v)) wanted.add(ridOf(v, p.getParameter('tzid') || tzid));
  if (!wanted.size) return;
  const last = Math.max(...[...wanted].map(ridInstant));
  const made = new Set([ridOf(start, tzid)]);
  // How far the rule was followed.
  let reached = -Infinity;
  // Stepped through without its excluded dates: a date it leaves out is still one of its occurrences.
  const excluded = master.getAllProperties('exdate');
  for (const p of excluded) master.removeProperty(p);
  try {
    const it = new ICAL.Event(stepper(master)).iterator();
    for (let i = 0; i < MAX_STEPS; i++) {
      const next = it.next();
      const at = next ? instant(next, tzid) : Infinity;
      if (at > last) {
        reached = Infinity;
        break;
      }
      made.add(ridOf(next, tzid));
      reached = at;
    }
  } finally {
    for (const p of excluded) master.addProperty(p);
  }
  const stays = (rid) => made.has(rid) || ridInstant(rid) > reached;
  const gone = obj.exceptions.filter((x) => kind(x.getFirstPropertyValue('recurrence-id')) && !stays(exceptionRid(x)));
  for (const x of gone) obj.vcal.removeSubcomponent(x);
  obj.exceptions = obj.exceptions.filter((x) => !gone.includes(x));
  rewriteDates(master, 'exdate', { keep: (v, tz) => !kind(v) || stays(ridOf(v, tz || tzid)) });
}

// How many times a rule matches before a moment, the ones excluded (EXDATE) included: COUNT counts them too.
function countBefore(master, recur, at) {
  const tzid = tzidOf(master, 'dtstart');
  const it = ICAL.Recur.fromString(recur.toString()).iterator(master.getFirstPropertyValue('dtstart'));
  for (let n = 0; n < MAX_STEPS; n++) {
    const next = it.next();
    if (!next || instant(next, tzid) >= at) return n;
  }
  throw calendarError('too_many', t('errors.calendar.tooMany'));
}

// Whether the series has an occurrence before a moment, so cutting it there leaves something.
function hasBefore(obj, at) {
  const { master, exceptions } = obj;
  const tzid = tzidOf(master, 'dtstart');
  const gone = new Set(exceptions.filter(cancelled).map(exceptionRid));
  for (const time of starts(master)) {
    if (instant(time, tzid) >= at) break;
    if (!gone.has(ridOf(time, tzid))) return true;
  }
  return exceptions.some((x) => !cancelled(x) && exceptionAt(x) < at);
}

// Ends a series just before a moment: its rules stop (UNTIL a second before, in UTC, or the day before for all-day
// events; COUNT goes), and what lay after goes with them: the occurrences changed on their own and the extra and
// excluded dates.
function cutAt(obj, at) {
  const { master } = obj;
  const before = significance(master);
  const frame = frameOf(master);
  let until;
  if (frame.allDay) {
    const d = new Date(at);
    d.setDate(d.getDate() - 1);
    until = ICAL.Time.fromDateString(dayKey(d));
  } else if (frame.tzid === null) {
    until = ICAL.Time.fromData({ ...clockParts(clock(null).toWall(at - 1000)), isDate: false });
  } else {
    until = ICAL.Time.fromJSDate(new Date(at - 1000), true);
  }
  for (const p of master.getAllProperties('rrule')) {
    const recur = p.getFirstValue();
    recur.count = null;
    if (!recur.until || instant(recur.until, null) > instant(until, null)) recur.until = until;
    p.setValue(recur);
  }
  for (const x of obj.exceptions.filter((c) => exceptionAt(c) >= at)) obj.vcal.removeSubcomponent(x);
  obj.exceptions = obj.exceptions.filter((c) => exceptionAt(c) < at);
  for (const name of ['exdate', 'rdate']) rewriteDates(master, name, { keep: (v, tzid) => instant(v, tzid) < at });
  touch(master, before);
}

// "This and following": the series ends before the opened occurrence, and a new series (UID o.newUid) takes over
// from there with what the user changed. Its start is the occurrence's new start (or where it was); its rule counts on
// from what the old one used up (COUNT) or ends where that did (UNTIL); the occurrences changed on their own, and the
// excluded and extra dates, from there on move to it, as far along as the series moved; a new rule keeps only those
// it makes (the series' own rule again is no new one). A series in UTC or in floating times moves to a zone. Returns
// null at the series' first occurrence, which is the whole series; otherwise { next: the new object, nextRid: its
// opened occurrence }, and obj is the cut series.
function split(obj, event, input, o) {
  const { vcal, master } = obj;
  const at = ridInstant(o.rid);
  if (!Number.isFinite(at) || !hasBefore(obj, at)) return null;
  const f0 = frameOf(master);
  if (typeof input.recurrence === 'string' && sameRule(master, input.recurrence, f0, vcal)) input = { ...input, recurrence: undefined };
  const ch = changes(event, input);
  const chosen = zoneOrNull(input.timeZone);
  const f1 = input.allDay ? { allDay: true, tzid: null } : { allDay: false, tzid: chosen || (!f0.allDay && named(f0.tzid) ? f0.tzid : o.zone) };
  const c0 = frameClock(f0, vcal);
  const c1 = frameClock(f1, vcal);
  const tz0 = tzidOf(master, 'dtstart');
  const mev = new ICAL.Event(master);
  const length = wallIn(mev.endDate, tzidOf(master, 'dtend') || tz0, f0, vcal) - wallIn(mev.startDate, tz0, f0, vcal);
  const w0 = c0.toWall(at);
  const timesChanged = ch.start || ch.end;
  const sw = timesChanged ? (f1.allDay ? dateWall(input.startDate) : c1.toWall(input.start)) : c1.toWall(at);
  const ew = timesChanged ? (f1.allDay ? dateWall(input.endDate) : c1.toWall(input.end)) : sw + length;
  const ds = sw - w0;
  const de = ew - (w0 + length);
  const map = (time, tz, d) => timeFromWall(wallIn(time, tz, f0, vcal) + d, f1);
  const old = { comp: master, summary: raw(master, 'summary'), location: raw(master, 'location'), description: raw(master, 'description') };
  const opened = obj.exceptions.find((x) => exceptionRid(x) === o.rid) || null;
  const single = input.recurrence === null;

  const next = new ICAL.Component(['vcalendar', [], []]);
  for (const name of ['prodid', 'version', 'calscale']) for (const p of vcal.getAllProperties(name)) next.addPropertyWithValue(name, p.getFirstValue());
  if (!next.hasProperty('prodid')) next.addPropertyWithValue('prodid', PRODID);
  if (!next.hasProperty('version')) next.addPropertyWithValue('version', '2.0');
  for (const z of vcal.getAllSubcomponents('vtimezone')) next.addSubcomponent(clone(z));
  const now = ICAL.Time.fromJSDate(new Date(), true);
  const fresh = (comp) => {
    comp.updatePropertyWithValue('uid', o.newUid);
    comp.updatePropertyWithValue('sequence', 0);
    comp.updatePropertyWithValue('dtstamp', now);
    comp.updatePropertyWithValue('last-modified', now);
  };
  const head = clone(single && opened ? opened : master);
  next.addSubcomponent(head);
  for (const name of ['recurrence-id', 'rrule', 'rdate', 'exdate', 'exrule', 'duration', 'created']) head.removeAllProperties(name);
  fresh(head);
  head.addPropertyWithValue('created', now);
  if (!single) {
    setTime(head, 'dtstart', timeFromWall(sw, f1));
    setTime(head, 'dtend', timeFromWall(ew, f1));
  } else if (input.allDay) {
    // No rule after the split: one event, the opened occurrence as the dialog has it.
    setTime(head, 'dtstart', { time: ICAL.Time.fromDateString(input.startDate), tzid: null });
    setTime(head, 'dtend', { time: ICAL.Time.fromDateString(input.endDate), tzid: null });
  } else {
    setTime(head, 'dtstart', writeTime(input.start, f1.tzid, next));
    setTime(head, 'dtend', writeTime(input.end, f1.tzid, next));
  }
  applyFields(head, input, ch, o);
  const carried = [];
  if (!single) {
    if (input.recurrence === undefined) {
      for (const p of master.getAllProperties('rrule')) {
        const recur = ICAL.Recur.fromString(p.getFirstValue().toString());
        if (recur.count) {
          recur.count -= countBefore(master, p.getFirstValue(), at);
          if (recur.count <= 0) continue;
        }
        if (recur.until) recur.until = untilAt(wallIn(recur.until, null, f0, vcal) + ds, f1, next);
        shiftRule(recur, w0, sw);
        head.addPropertyWithValue('rrule', recur);
      }
    } else {
      head.addPropertyWithValue('rrule', normalizeRule(input.recurrence, f1, next));
    }
    for (const name of ['exdate', 'rdate']) rewriteDates(master, name, { keep: (v, tz) => instant(v, tz) >= at, map: (v, tz) => map(v, tz, ds), frame: f1, into: head });
    for (const x of obj.exceptions) {
      if (exceptionAt(x) < at) continue;
      const y = clone(x);
      next.addSubcomponent(y);
      fresh(y);
      const r = x.getFirstPropertyValue('recurrence-id');
      const rz = tzidOf(x, 'recurrence-id');
      setTime(y, 'recurrence-id', map(r, rz, ds));
      const xev = new ICAL.Event(x);
      const xz = tzidOf(x, 'dtstart');
      if (x === opened) {
        if (timesChanged) {
          y.removeAllProperties('duration');
          setTime(y, 'dtstart', timeFromWall(sw, f1));
          setTime(y, 'dtend', timeFromWall(ew, f1));
        }
        applyFields(y, input, ch, o);
      } else {
        const alone = xev.startDate.isDate !== r.isDate || instant(xev.startDate, xz) !== instant(r, rz);
        if (!alone || f0.allDay !== f1.allDay) {
          const xEnd = xev.endDate;
          y.removeAllProperties('duration');
          setTime(y, 'dtstart', map(xev.startDate, xz, ds));
          setTime(y, 'dtend', map(xEnd, tzidOf(x, 'dtend') || xz, de));
        }
        applyFields(y, input, ch, o, old);
      }
      carried.push(y);
    }
  }
  const made = { vcal: next, master: head, exceptions: carried };
  if (!single && typeof input.recurrence === 'string') prune(made);
  cutAt(obj, at);
  return { next: made, nextRid: single ? null : ridAt(sw, f1, next) };
}

// Makes the dialog's change in a calendar object. o: { rid, scope, me, organizer, zone, newUid }; rid names the opened
// occurrence of a series (null for a single event), me is a Set of the user's addresses. Returns { rid }, the changed
// occurrence's name in obj afterwards; or, for "this and following", { next, nextRid }: a new series to write before
// the cut one.
function edit(obj, event, input, o) {
  const { master } = obj;
  const rid = o.rid || null;
  if (!rid) {
    if (!master || recurring(master)) throw notFound();
    return { rid: applyOne(obj, master, event, input, o) };
  }
  if (!recurring(master)) {
    // An object of changed occurrences only, without the series they belong to.
    const x = obj.exceptions.find((c) => exceptionRid(c) === rid);
    if (!x) throw notFound();
    applyOne(obj, x, event, { ...input, recurrence: undefined }, o);
    return { rid };
  }
  const scope = o.scope === 'following' || o.scope === 'all' ? o.scope : 'one';
  if (scope === 'one') {
    if (input.recurrence !== undefined && !sameRule(master, input.recurrence, frameOf(master), obj.vcal)) throw refused('errors.calendar.ruleKept');
    const comp = exceptionFor(obj, rid);
    if (!comp) throw notFound();
    applyOne(obj, comp, event, { ...input, recurrence: undefined }, o);
    return { rid };
  }
  const org = master.getFirstProperty('organizer');
  if (org && !o.me.has(person(org).address)) throw refused('errors.calendar.notOrganizer');
  if (scope === 'following') {
    const made = split(obj, event, input, o);
    if (made) return made;
  }
  return { rid: applyAll(obj, event, input, o) };
}

// Leaves one occurrence out of its series (EXDATE), with any change made to it; or an object's only event. Returns
// whether nothing is left of the object.
function excludeOccurrence(obj, rid) {
  const { master } = obj;
  const time = master && recurring(master) ? occurrenceStart(master, rid) : null;
  for (const x of obj.exceptions.filter((c) => exceptionRid(c) === rid)) obj.vcal.removeSubcomponent(x);
  obj.exceptions = obj.exceptions.filter((c) => exceptionRid(c) !== rid);
  if (time) {
    const before = significance(master);
    const p = new ICAL.Property('exdate');
    p.setValue(time.clone());
    const tz = zoneParam(time, tzidOf(master, 'dtstart'));
    if (tz) p.setParameter('tzid', tz);
    master.addProperty(p);
    touch(master, before);
  }
  return !obj.vcal.getAllSubcomponents('vevent').length;
}

// "Delete this and following": the series ends before the occurrence. Returns whether nothing is left, as when it
// was the first one.
function truncate(obj, rid) {
  const at = ridInstant(rid);
  if (!obj.master || !recurring(obj.master) || !Number.isFinite(at)) throw notFound();
  if (!hasBefore(obj, at)) return true;
  cutAt(obj, at);
  return false;
}

// Whether a series has nothing left from an occurrence on: no start of its rule or its extra dates, and no occurrence
// changed on its own. That is what a cut there leaves. null when obj holds no series.
function endsBefore(obj, rid) {
  const at = ridInstant(rid);
  const { master } = obj;
  if (!master || !recurring(master) || !Number.isFinite(at)) return null;
  const tzid = tzidOf(master, 'dtstart');
  for (const time of starts(master)) if (instant(time, tzid) >= at) return false;
  return !obj.exceptions.some((x) => !cancelled(x) && exceptionAt(x) >= at);
}

// An answer to an invitation: only the user's own PARTSTAT changes, in the occurrence or in the whole series. Returns
// whether the user was among the guests.
function respond(obj, rid, response, { me, series = false }) {
  const whole = !rid || (series && recurring(obj.master));
  const comps = whole ? [obj.master, ...obj.exceptions].filter(Boolean) : [exceptionFor(obj, rid)].filter(Boolean);
  let found = false;
  for (const comp of comps) {
    for (const p of comp.getAllProperties('attendee')) {
      if (!me.has(person(p).address)) continue;
      p.setParameter('partstat', ANSWER[response]);
      found = true;
    }
  }
  return found;
}

// A new event, named uid. Its times are written in the zone the input names, else in zone (the PC's): every timed
// event gets one, with its definition, so a rule added later follows that zone's clock. bookingId marks an event a
// booking made; organizer ({ address, name }) is the user, for the first guest.
function newObject(input, { uid, zone, bookingId = null, me = new Set(), organizer = null }) {
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.addPropertyWithValue('prodid', PRODID);
  vcal.addPropertyWithValue('version', '2.0');
  const vevent = new ICAL.Component('vevent');
  vcal.addSubcomponent(vevent);
  vevent.addPropertyWithValue('uid', uid);
  vevent.addPropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
  vevent.addPropertyWithValue('sequence', 0);
  text(vevent, 'summary', input.title);
  text(vevent, 'location', input.location);
  text(vevent, 'description', input.description);
  if (input.allDay) {
    setTime(vevent, 'dtstart', { time: ICAL.Time.fromDateString(input.startDate), tzid: null });
    setTime(vevent, 'dtend', { time: ICAL.Time.fromDateString(input.endDate), tzid: null });
  } else {
    const tzid = zoneOrNull(input.timeZone) || zoneOrNull(zone) || 'UTC';
    const write = typeof input.recurrence === 'string' ? writeSeriesTime : writeTime;
    setTime(vevent, 'dtstart', write(input.start, tzid, vcal));
    setTime(vevent, 'dtend', write(input.end, tzid, vcal));
  }
  // New all-day events don't block the day, as in Google, Apple and Outlook; timed ones do.
  writeBusy(vevent, input.busy === undefined ? !input.allDay : input.busy);
  if (input.visibility) writeVisibility(vevent, input.visibility);
  if (input.reminders) writeReminders(vevent, input.reminders, input.title);
  if (bookingId) vevent.updatePropertyWithValue(BOOKING, String(bookingId));
  if (typeof input.recurrence === 'string') vevent.addPropertyWithValue('rrule', normalizeRule(input.recurrence, frameOf(vevent), vcal));
  if (hasDiff(input.guests)) applyGuests(vevent, input.guests, { me, organizer });
  touch(vevent);
  return { vcal, master: vevent, exceptions: [] };
}

// ---------- zone definitions ----------

// Whether a definition has an observance that starts at or before a moment; readers have no offset before the first.
function coversFrom(zone, ms) {
  return zone.getAllSubcomponents().some((o) => {
    const start = o.getFirstPropertyValue('dtstart');
    const from = o.getFirstPropertyValue('tzoffsetfrom');
    if (!start || !from) return false;
    return Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute, start.second) - from.toSeconds() * 1000 <= ms;
  });
}

// Every zone the object's times are written in gets a definition (VTIMEZONE) that covers its earliest time, as RFC
// 5545 asks, and definitions nothing uses go. One the server or another app wrote stays, unless it starts after a
// time it now has to cover. A zone the PC doesn't know by name (a Windows name) keeps the definition it came with.
function ensureZones(vcal, now = Date.now()) {
  const used = new Map();
  const note = (tzid, ms, open = false) => {
    if (!Number.isFinite(ms)) return;
    const e = used.get(tzid) || { from: ms, to: ms, open: false };
    e.from = Math.min(e.from, ms);
    e.to = Math.max(e.to, ms);
    e.open = e.open || open;
    used.set(tzid, e);
  };
  for (const comp of vcal.getAllSubcomponents()) {
    if (comp.name === 'vtimezone') continue;
    for (const p of comp.getAllProperties()) {
      const tzid = p.getParameter('tzid');
      if (!tzid) continue;
      for (const v of p.getValues()) {
        const time = v instanceof ICAL.Time ? v : v && v.start instanceof ICAL.Time ? v.start : null;
        if (time && !time.isDate) note(tzid, instant(time, tzid));
      }
    }
    const tzid = tzidOf(comp, 'dtstart');
    if (!tzid) continue;
    for (const p of comp.getAllProperties('rrule')) {
      const recur = p.getFirstValue();
      if (recur.until) note(tzid, instant(recur.until, tzid));
      else note(tzid, now, true);
    }
  }
  for (const [tzid, e] of used) {
    if (!isZone(tzid)) continue;
    const have = vcal.getAllSubcomponents('vtimezone').find((z) => z.getFirstPropertyValue('tzid') === tzid);
    if (have && coversFrom(have, e.from)) continue;
    if (have) vcal.removeSubcomponent(have);
    vcal.addSubcomponent(vtimezone(tzid, { from: e.from, until: e.open ? null : e.to, now }));
  }
  for (const z of vcal.getAllSubcomponents('vtimezone')) if (!used.has(z.getFirstPropertyValue('tzid'))) vcal.removeSubcomponent(z);
  // Zone definitions first, as most apps write them.
  const rest = vcal.getAllSubcomponents().filter((c) => c.name !== 'vtimezone');
  for (const c of rest) vcal.removeSubcomponent(c);
  for (const c of rest) vcal.addSubcomponent(c);
}

// The object as text, with its zones defined. zones: false leaves them as they came, for an answer to an invitation,
// which may only change the user's own reply.
function serialize(obj, { zones = true, now = Date.now() } = {}) {
  if (zones) ensureZones(obj.vcal, now);
  return obj.vcal.toString();
}

module.exports = {
  PRODID,
  VIDEO,
  parseObject,
  serialize,
  expand,
  pick,
  splitId,
  seriesInfo,
  hasGuests,
  firstRid,
  recurring,
  newObject,
  edit,
  excludeOccurrence,
  truncate,
  endsBefore,
  respond,
  ensureZones,
  invitesOf,
  person,
  instant,
  utcStamp,
  ridOf,
  ridInstant
};
