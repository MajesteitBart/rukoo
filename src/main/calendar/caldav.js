'use strict';

const { t } = require('../../i18n');

// CalDAV calendars (RFC 4791), for accounts with a calendar server in their Server settings. Rukoo signs in with the
// account's own username and password and finds the calendars from the address the user gave (RFC 6764). It reads
// each event whole and expands a recurring one here, into its occurrences with the changes made to each of them.
// Events come back in the shape the calendar store keeps (see index.js).
// https://www.rfc-editor.org/rfc/rfc4791 https://www.rfc-editor.org/rfc/rfc6764
const crypto = require('crypto');
const ICAL = require('ical.js');
const { DOMParser } = require('@xmldom/xmldom');
const { calendarError, localDay, dayKey, plainDescription } = require('./google');

const DAV = 'DAV:';
const CAL = 'urn:ietf:params:xml:ns:caldav';
const APPLE = 'http://apple.com/ns/ical/';
const TIMEOUT = 20000;
const REDIRECTS = 5;
// How many occurrences of one recurring event are stepped through to reach a period; a rule that repeats every
// minute would otherwise run on for a long time. A series that needs more fails the fetch instead of going missing.
const MAX_STEPS = 100000;
const DAY = 86400000;
// Requests that follow a redirect. A change only goes to the address it was made for.
const FOLLOW = new Set(['GET', 'PROPFIND', 'REPORT']);
const ICS = 'text/calendar; charset=utf-8';
const XML = 'application/xml; charset=utf-8';
const PRODID = '-//Rukoo Mail//Calendar//EN';
const PARTSTAT = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative', 'NEEDS-ACTION': 'needsAction' };
const ANSWER = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' };
const VIDEO = /^https:\/\/([a-z0-9-]+\.)*(zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|whereby\.com|webex\.com)\/\S*$/i;

// ---------- addresses ----------

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

// Rukoo only sends a password over an encrypted connection; plain http is for a server on this PC.
function allowed(u) {
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.test(u.hostname));
}

// The address from Server settings: a host name, a host with a path, or a whole URL. Without a scheme it is https.
function serverUrl(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    throw calendarError('invalid_url', t('errors.caldav.invalidUrl'));
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw calendarError('invalid_url', t('errors.caldav.invalidUrl'));
  if (!allowed(u)) throw calendarError('insecure', t('errors.caldav.insecure'));
  u.username = '';
  u.password = '';
  u.hash = '';
  return u.toString();
}

function resolve(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.toString();
  } catch (_) {
    return null;
  }
}

// A collection's address ends in a slash, so the names of the events in it resolve inside it.
const collection = (url) => (url.endsWith('/') ? url : `${url}/`);

// ---------- XML ----------

function elements(node) {
  const out = [];
  for (let n = node && node.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
  return out;
}
const kids = (node, ns, name) => elements(node).filter((n) => n.namespaceURI === ns && n.localName === name);
const kid = (node, ns, name) => kids(node, ns, name)[0] || null;
const textOf = (node) => (node ? String(node.textContent || '').trim() : '');
const okStatus = (status) => /^HTTP\/[\d.]+\s+2\d\d\b/i.test(status);

// The responses in a 207 Multi-Status: each one's address, resolved against the request's, and the properties the
// server could give for it.
function multistatus(text, base) {
  let doc = null;
  try {
    doc = new DOMParser({ onError: () => {} }).parseFromString(String(text || ''), 'application/xml');
  } catch (_) {
    // Not XML; said below.
  }
  const root = doc && doc.documentElement;
  if (!root || root.namespaceURI !== DAV || root.localName !== 'multistatus') throw calendarError('bad_answer', t('errors.caldav.badAnswer'));
  return kids(root, DAV, 'response').map((r) => {
    const props = new Map();
    for (const ps of kids(r, DAV, 'propstat')) {
      if (!okStatus(textOf(kid(ps, DAV, 'status')))) continue;
      for (const p of elements(kid(ps, DAV, 'prop'))) props.set(`${p.namespaceURI} ${p.localName}`, p);
    }
    return { href: resolve(textOf(kid(r, DAV, 'href')), base), props };
  });
}

const prop = (r, ns, name) => r.props.get(`${ns} ${name}`) || null;

// The first address inside a property such as current-user-principal or calendar-home-set.
function hrefIn(r, ns, name, base) {
  const p = prop(r, ns, name);
  const h = p && kid(p, DAV, 'href');
  return h ? resolve(textOf(h), base) : null;
}

const propfind = (props) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="${CAL}" xmlns:a="${APPLE}"><d:prop>${props}</d:prop></d:propfind>`;
const FIND_HOME = propfind('<d:current-user-principal/><c:calendar-home-set/>');
const LIST = propfind('<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/><a:calendar-order/>');

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

// The TZID a time of this event is written with: the event's own, unless the time is a date or in UTC.
const zoneParam = (time, tzid) => (time.isDate || time.zone === ICAL.Timezone.utcTimezone ? null : (time.zone && !floating(time) && time.zone.tzid) || tzid || null);

// The time a property gets for an instant: in the zone the event already uses when Rukoo can convert to it, otherwise
// in UTC.
function timeFor(ms, vcal, tzid) {
  const utc = ICAL.Time.fromJSDate(new Date(ms), true);
  if (!tzid) return { time: utc, tzid: null };
  const zone = vcal.getTimeZoneByID(tzid);
  if (zone) return { time: utc.convertToZone(zone), tzid };
  const f = zoneFormatter(tzid);
  if (!f) return { time: utc, tzid: null };
  return { time: ICAL.Time.fromData({ ...wallClock(f, ms), isDate: false }), tzid };
}

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

// ---------- events ----------

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
  for (const zone of master.parent ? master.parent.getAllSubcomponents('vtimezone') : []) vcal.addSubcomponent(new ICAL.Component(JSON.parse(JSON.stringify(zone.toJSON()))));
  const copy = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
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

// The link to a video call: Google's own property, the event's URL or place, or the first one in the description.
function meetingLink(comp, location, description) {
  const candidates = [comp.getFirstPropertyValue('x-google-conference'), comp.getFirstPropertyValue('url'), location, ...(String(description).match(/https:\/\/[^\s<>"']+/g) || [])];
  return candidates.map((v) => String(v || '').trim()).find((v) => VIDEO.test(v)) || null;
}

// An event as the calendar store keeps it. me: the account's own addresses, to tell the user apart from the guests.
// locked: part of a series Rukoo can show but not change (see seriesContext).
function toEvent(comp, { cal, href, etag, me, rid = null, seriesId = null, locked = false, startTime, endTime, tzid, endTzid }) {
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
        booked: /^(room|resource)$/i.test(String(p.getParameter('cutype') || ''))
      };
    })
    .filter((a) => a.address);
  const attendees = everyone.filter((a) => !a.booked).map(({ booked, ...a }) => a);
  const mine = attendees.find((a) => a.self);
  // A meeting with guests, or with a room or resource booked, stays as it is: depending on the server, a change would
  // email them or change the booking without Rukoo asking. An invitation can be answered where the server tells the
  // organizer (cal.scheduling).
  const guests = everyone.filter((a) => !a.self && !(own && a.organizer));
  const changeable = Boolean(cal.writable && own && !guests.length && !locked);
  const location = String(comp.getFirstPropertyValue('location') || '').trim();
  const description = plainDescription(comp.getFirstPropertyValue('description'));
  const zone = tzid || (!allDay && startTime.zone === ICAL.Timezone.utcTimezone ? 'UTC' : null);
  return {
    calendarId: cal.id,
    eventId: rid ? `${href}#${rid}` : href,
    // The version of the calendar object; every occurrence of a series shares it.
    etag: etag || null,
    eventType: 'default',
    seriesId,
    title: String(comp.getFirstPropertyValue('summary') || ''),
    location,
    description,
    allDay,
    start,
    end,
    startDate,
    endDate,
    timeZone: zone,
    endTimeZone: endTzid || zone,
    status: String(comp.getFirstPropertyValue('status') || '').toUpperCase() === 'TENTATIVE' ? 'tentative' : 'confirmed',
    busy: String(comp.getFirstPropertyValue('transp') || '').toUpperCase() !== 'TRANSPARENT',
    response: mine && !own ? mine.response : null,
    canEdit: changeable,
    canDelete: changeable,
    canRespond: Boolean(mine && !own && cal.writable && cal.scheduling && !locked),
    organizer,
    attendees,
    moreAttendees: false,
    link: null,
    meeting: meetingLink(comp, location, description)
  };
}

// One event, or one occurrence changed on its own, with its own times.
function ownEvent(comp, ctx) {
  const ev = new ICAL.Event(comp);
  const rid = comp.hasProperty('recurrence-id') ? exceptionRid(comp) : null;
  const tzid = tzidOf(comp, 'dtstart');
  return toEvent(comp, { ...ctx, rid, startTime: ev.startDate, endTime: ev.endDate, tzid, endTzid: tzidOf(comp, 'dtend') || tzid });
}

// The clock of a series' start: the zone it is written in, as a way to turn a moment into a clock time and back.
// A zone the object defines goes through its definition, one it only names through the PC's zone data, UTC as is,
// and a floating time through the PC's own clock.
function clockOf(master) {
  const p = master.getFirstProperty('dtstart');
  const time = p.getFirstValue();
  if (!time.isDate && !floating(time)) {
    const zone = time.zone;
    return {
      toClock: (ms) => {
        const c = ICAL.Time.fromJSDate(new Date(ms), true).convertToZone(zone);
        return { year: c.year, month: c.month, day: c.day, hour: c.hour, minute: c.minute, second: c.second };
      },
      fromClock: (c) => ICAL.Time.fromData({ ...c, isDate: false }, zone).toUnixTime() * 1000
    };
  }
  const f = zoneFormatter(p.getParameter('tzid') || '');
  if (f) return { toClock: (ms) => wallClock(f, ms), fromClock: (c) => fromWallClock(c, f) };
  return {
    toClock: (ms) => {
      const d = new Date(ms);
      return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
    },
    fromClock: (c) => new Date(c.year, c.month - 1, c.day, c.hour, c.minute, c.second).getTime()
  };
}

// A clock time as if it were UTC, so the difference between two of them is a difference on the clock.
const onClock = (c) => Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);

// The exceptions that also change every later occurrence (RANGE=THISANDFUTURE), in order. From the moment of its
// original start (from), each occurrence moves by shift on the series' clock, so a move of a week stays a week across
// a change to summer time; it lasts length and takes the exception's fields, until the next change.
function laterChanges(obj) {
  const clock = clockOf(obj.master);
  return obj.exceptions
    .filter(ranged)
    .map((x) => {
      const ev = new ICAL.Event(x);
      const tz = tzidOf(x, 'dtstart');
      const from = instant(x.getFirstPropertyValue('recurrence-id'), tzidOf(x, 'recurrence-id'));
      const start = instant(ev.startDate, tz);
      const shift = onClock(clock.toClock(start)) - onClock(clock.toClock(from));
      return { comp: x, tz, from, shift, clock, length: Math.max(0, instant(ev.endDate, tzidOf(x, 'dtend') || tz) - start), allDay: ev.startDate.isDate };
    })
    .sort((a, b) => a.from - b.from);
}

// An occurrence's moment moved by a change's shift on the series' clock.
function moved(at, change) {
  const d = new Date(onClock(change.clock.toClock(at)) + change.shift);
  return change.clock.fromClock({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() });
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
    return toEvent(change.comp, { ...ctx, rid, startTime, endTime, tzid: change.tz, endTzid: change.tz });
  }
  const end = time.clone();
  end.addDuration(new ICAL.Event(master).duration);
  return toEvent(master, { ...ctx, rid, startTime: time, endTime: end, tzid, endTzid: tzid });
}

// The events of one calendar object that overlap start to end: the event itself, or the occurrences of a series.
// An occurrence changed on its own replaces the one the rule makes, wherever it moved to.
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

// An event id is the calendar object's address, with the occurrence after a # for one occurrence of a series.
function splitId(eventId) {
  const s = String(eventId);
  const i = s.lastIndexOf('#');
  return i < 0 ? { href: s, rid: null } : { href: s.slice(0, i), rid: s.slice(i + 1) };
}

function text(comp, name, value) {
  if (value) comp.updatePropertyWithValue(name, value);
  else comp.removeAllProperties(name);
}

// Writes what the event dialog gives into an event. A timed event keeps the zone it was written in.
function apply(comp, vcal, input, { description = true, sequence = true } = {}) {
  text(comp, 'summary', input.title);
  text(comp, 'location', input.location);
  if (description) text(comp, 'description', input.description);
  const tzid = tzidOf(comp, 'dtstart');
  const endTzid = tzidOf(comp, 'dtend') || tzid;
  comp.removeAllProperties('duration');
  if (input.allDay) {
    setTime(comp, 'dtstart', { time: ICAL.Time.fromDateString(input.startDate), tzid: null });
    setTime(comp, 'dtend', { time: ICAL.Time.fromDateString(input.endDate), tzid: null });
  } else {
    setTime(comp, 'dtstart', timeFor(input.start, vcal, tzid));
    setTime(comp, 'dtend', timeFor(input.end, vcal, endTzid));
  }
  const now = ICAL.Time.fromJSDate(new Date(), true);
  comp.updatePropertyWithValue('dtstamp', now);
  comp.updatePropertyWithValue('last-modified', now);
  if (sequence) comp.updatePropertyWithValue('sequence', (Number(comp.getFirstPropertyValue('sequence')) || 0) + 1);
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
  const x = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
  // An event has DTEND or DURATION, never both; the exception gets a DTEND.
  for (const name of ['rrule', 'rdate', 'exdate', 'recurrence-id', 'duration']) x.removeAllProperties(name);
  obj.vcal.addSubcomponent(x);
  const end = time.clone();
  end.addDuration(new ICAL.Event(master).duration);
  setTime(x, 'recurrence-id', { time: time.clone(), tzid: zoneParam(time, tzid) });
  setTime(x, 'dtstart', { time: time.clone(), tzid: zoneParam(time, tzid) });
  setTime(x, 'dtend', { time: end, tzid: zoneParam(end, tzid) });
  obj.exceptions.push(x);
  return x;
}

// ---------- errors ----------

function httpError(status, { write = false } = {}) {
  if (status === 401) return calendarError('password', t('errors.caldav.signIn'));
  if (status === 403 && write) return calendarError('read_only', t('errors.calendar.readOnly'));
  if (status === 404 || status === 410) return calendarError('not_found', t('errors.calendar.notFound'));
  // If-Match failed: the event changed since the version the user saw.
  if (status === 412) return calendarError('changed', t('errors.calendar.changed'));
  if (status === 429 || status === 503) return calendarError('busy', t('errors.caldav.busy'));
  return calendarError('request', t('errors.caldav.request', { reason: status }));
}

// ---------- the calendar ----------

class CalDavCalendar {
  // url: the address from Server settings. home: the calendar home found from it before, or null.
  // credentials: () => ({ user, password }). addresses: () => the account's own addresses, to find the user among guests.
  // onHome(home): called when the home had to be found again, so the account remembers it.
  constructor({ url, home = null, credentials, addresses = () => [], onHome = () => {}, fetchImpl = (...a) => fetch(...a) }) {
    this.url = url;
    this.home = home;
    this.credentials = credentials;
    this.addresses = addresses;
    this.onHome = onHome;
    this.fetch = fetchImpl;
    // Every calendar object has an etag, and a change can be made to apply only to that version. A series is one
    // object, so deleting it can be made to apply only to the version the user saw as well.
    this.versioned = true;
    this.versionedSeries = true;
  }

  me() {
    return new Set((this.addresses() || []).map((a) => String(a || '').toLowerCase()).filter(Boolean));
  }

  // Rukoo sends the password only to the server from Server settings. A redirect, or an address in an answer, that
  // leads to another host is refused before anything is sent, with that host's name, so the user can enter it in
  // Server settings if they trust it. Whether two hosts belong to one provider can't be told from their names.
  trusts(u) {
    return u.origin === new URL(this.url).origin;
  }

  // etag: change only this version (If-Match). create: only when nothing is there yet (If-None-Match).
  async request(method, url, { body = null, type = XML, depth = null, etag = null, create = false } = {}) {
    let target = url;
    for (let hops = 0; ; hops++) {
      const u = new URL(target);
      if (!allowed(u)) throw calendarError('insecure', t('errors.caldav.insecure'));
      if (!this.trusts(u)) throw calendarError('elsewhere', t('errors.caldav.elsewhere', { host: u.host }));
      const { user, password } = this.credentials();
      const headers = { authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}` };
      if (body !== null) headers['content-type'] = type;
      if (depth !== null) headers.depth = String(depth);
      if (etag) headers['if-match'] = etag;
      if (create) headers['if-none-match'] = '*';
      let res;
      try {
        res = await this.fetch(target, { method, headers, body: body === null ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
      } catch (_) {
        throw calendarError('network', t('errors.caldav.unreachable'));
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location && FOLLOW.has(method) && hops < REDIRECTS) {
        target = resolve(location, target);
        if (!target) throw httpError(res.status);
        continue;
      }
      let data;
      try {
        data = await res.text();
      } catch (_) {
        // A body that stops halfway is a failed request, never an empty answer: an empty list would clear the calendar.
        throw calendarError('network', t('errors.caldav.unreachable'));
      }
      return { status: res.status, ok: res.status >= 200 && res.status < 300, url: target, etag: res.headers.get('etag'), dav: res.headers.get('dav'), body: data };
    }
  }

  async propfind(url, depth, body) {
    const res = await this.request('PROPFIND', url, { body, depth });
    if (!res.ok) throw httpError(res.status);
    return multistatus(res.body, res.url);
  }

  // The calendar home: from the address itself, or from /.well-known/caldav on its host, through the user's principal.
  async discover() {
    const start = new URL(this.url);
    const known = new URL('/.well-known/caldav', start).toString();
    const tries = start.pathname === '/' ? [known, start.toString()] : [start.toString(), known];
    let elsewhere = null;
    for (const url of tries) {
      let home = null;
      try {
        home = await this.homeFrom(url);
      } catch (err) {
        // A wrong password or no connection is the answer; anything else means: not here, try the next.
        if (err.code === 'password' || err.code === 'network' || err.code === 'insecure') throw err;
        if (err.code === 'elsewhere') elsewhere = elsewhere || err;
      }
      if (home) return collection(home);
    }
    throw elsewhere || calendarError('not_caldav', t('errors.caldav.notFound'));
  }

  async homeFrom(url) {
    const [first] = await this.propfind(url, 0, FIND_HOME);
    if (!first) return null;
    let home = hrefIn(first, CAL, 'calendar-home-set', first.href);
    if (!home) {
      const principal = hrefIn(first, DAV, 'current-user-principal', first.href);
      if (!principal) return null;
      const [p] = await this.propfind(principal, 0, FIND_HOME);
      home = p ? hrefIn(p, CAL, 'calendar-home-set', p.href) : null;
    }
    // A home Rukoo wouldn't give the password to is no use; say where it is.
    if (home && !this.trusts(new URL(home))) throw calendarError('elsewhere', t('errors.caldav.elsewhere', { host: new URL(home).host }));
    return home;
  }

  async findHome() {
    this.home = await this.discover();
    this.onHome(this.home);
    return this.home;
  }

  // The calendars that hold events. A home that moved is found again.
  async calendars() {
    if (!this.home) await this.findHome();
    let list;
    try {
      list = await this.propfind(this.home, 1, LIST);
    } catch (err) {
      if (err.code !== 'not_found') throw err;
      list = await this.propfind(await this.findHome(), 1, LIST);
    }
    const calendars = list
      .filter((r) => {
        const type = prop(r, DAV, 'resourcetype');
        if (!type || !kid(type, CAL, 'calendar')) return false;
        const comps = prop(r, CAL, 'supported-calendar-component-set');
        return !comps || kids(comps, CAL, 'comp').some((c) => String(c.getAttribute('name')).toUpperCase() === 'VEVENT');
      })
      .map((r, i) => {
        const privileges = prop(r, DAV, 'current-user-privilege-set');
        const granted = privileges ? kids(privileges, DAV, 'privilege').flatMap((p) => elements(p).map((e) => e.localName)) : null;
        const segment = decodeURIComponent(new URL(r.href).pathname.replace(/\/$/, '').split('/').pop() || '');
        return {
          id: collection(r.href),
          name: textOf(prop(r, DAV, 'displayname')) || segment,
          primary: false,
          // A server that doesn't say what the user may do is taken at its word when a change fails.
          writable: !granted || granted.some((g) => ['all', 'write', 'write-content', 'bind'].includes(g)),
          selected: true,
          timeZone: null,
          order: Number(textOf(prop(r, APPLE, 'calendar-order'))) || i + 1000
        };
      })
      .sort((a, b) => a.order - b.order);
    // CalDAV has no primary calendar; new events go to the first one that takes them.
    const first = calendars.find((c) => c.writable);
    if (first) first.primary = true;
    const scheduling = calendars.length ? await this.schedules() : false;
    return calendars.map(({ order, ...c }) => ({ ...c, scheduling })).sort((a, b) => Number(b.primary) - Number(a.primary));
  }

  // Whether the server tells the organizer when a guest answers in their own calendar (RFC 6638), as its DAV header
  // says. Without that, an answer would stay in the user's calendar and the organizer would never hear it.
  async schedules() {
    try {
      const res = await this.request('OPTIONS', this.home);
      return res.ok && /(^|[\s,])calendar-auto-schedule([\s,]|$)/i.test(String(res.dav || ''));
    } catch (_) {
      return false;
    }
  }

  // The events that overlap start to end. The server picks the calendar objects with an occurrence in that time;
  // their occurrences are worked out here.
  async events(cal, start, end) {
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="${CAL}"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${utcStamp(start)}" end="${utcStamp(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const res = await this.request('REPORT', cal.id, { body, depth: 1 });
    if (!res.ok) throw httpError(res.status);
    const me = this.me();
    const out = [];
    for (const r of multistatus(res.body, res.url)) {
      const data = textOf(prop(r, CAL, 'calendar-data'));
      if (!data || !r.href) continue;
      try {
        out.push(...expand(parseObject(data), { cal, href: r.href, etag: textOf(prop(r, DAV, 'getetag')), me }, start, end));
      } catch (err) {
        // One event Rukoo can't read doesn't take the rest of the calendar with it. A series too long to step
        // through does fail the fetch, so the calendar keeps what it showed instead of losing that series.
        if (err && err.code === 'too_many') throw err;
      }
    }
    return out;
  }

  async load(href) {
    const res = await this.request('GET', href);
    if (!res.ok) throw httpError(res.status);
    let obj;
    try {
      obj = parseObject(res.body);
    } catch (_) {
      throw calendarError('bad_answer', t('errors.caldav.badAnswer'));
    }
    return { obj, etag: res.etag };
  }

  // Writes a calendar object back, only over the version etag; returns its new version.
  async save(href, obj, etag) {
    const res = await this.request('PUT', href, { body: obj.vcal.toString(), type: ICS, etag });
    if (!res.ok) throw httpError(res.status, { write: true });
    return res.etag || (await this.load(href)).etag;
  }

  async get(cal, eventId) {
    const { href, rid } = splitId(eventId);
    const { obj, etag } = await this.load(href);
    const e = pick(obj, { cal, href, etag, me: this.me() }, rid);
    if (!e) throw calendarError('not_found', t('errors.calendar.notFound'));
    return e;
  }

  // input.id, when given, names the event: a Save that is tried again after a lost answer finds the event it made
  // the first time (If-None-Match fails) and gives it the latest fields instead of making a second one.
  async create(cal, input) {
    const id = input.id || crypto.randomUUID();
    const href = new URL(`${encodeURIComponent(id)}.ics`, cal.id).toString();
    const vcal = new ICAL.Component(['vcalendar', [], []]);
    vcal.addPropertyWithValue('prodid', PRODID);
    vcal.addPropertyWithValue('version', '2.0');
    const vevent = new ICAL.Component('vevent');
    vcal.addSubcomponent(vevent);
    vevent.addPropertyWithValue('uid', id);
    vevent.addPropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
    vevent.addPropertyWithValue('sequence', 0);
    apply(vevent, vcal, input, { sequence: false });
    const res = await this.request('PUT', href, { body: vcal.toString(), type: ICS, create: true });
    if (res.status === 412 && input.id) {
      const made = await this.load(href);
      const master = made.obj.master;
      const org = master && master.getFirstProperty('organizer');
      if (!master || recurring(master) || master.getFirstPropertyValue('uid') !== id || (org && !this.me().has(person(org).address))) {
        throw calendarError('conflict', t('errors.calendar.readOnly'));
      }
      apply(master, made.obj.vcal, input);
      const etag = await this.save(href, made.obj, made.etag);
      return pick(made.obj, { cal, href, etag, me: this.me() }, null);
    }
    if (!res.ok) throw httpError(res.status, { write: true });
    const etag = res.etag || (await this.load(href)).etag;
    return pick({ vcal, master: vevent, exceptions: [] }, { cal, href, etag, me: this.me() }, null);
  }

  // Changes one event; for a series, the occurrence that was opened. etag is the version the user changed, and a
  // newer one on the server makes this fail with 'changed'. An untouched description stays as the server has it,
  // because Rukoo shows it as plain text.
  async update(cal, event, input, { etag = null } = {}) {
    const { href, rid } = splitId(event.eventId);
    const { obj, etag: current } = await this.load(href);
    if (etag && current && etag !== current) throw calendarError('changed', t('errors.calendar.changed'));
    const comp = rid ? exceptionFor(obj, rid) : recurring(obj.master) ? null : obj.master;
    if (!comp) throw calendarError('not_found', t('errors.calendar.notFound'));
    apply(comp, obj.vcal, input, { description: input.description !== event.description });
    const next = await this.save(href, obj, etag || current);
    const e = pick(obj, { cal, href, etag: next, me: this.me() }, rid);
    if (!e) throw calendarError('not_found', t('errors.calendar.notFound'));
    return e;
  }

  // An event, a whole series, or one occurrence, which the series then leaves out (EXDATE); each only on the version
  // the user saw.
  async remove(cal, event, { series = false, etag = null } = {}) {
    const { href, rid } = splitId(event.eventId);
    if (!rid || (series && event.seriesId)) {
      // The whole series is one calendar object, whose version every occurrence carries: a series changed elsewhere in
      // the meantime is refused (412) rather than deleted.
      const res = await this.request('DELETE', series && event.seriesId ? event.seriesId : href, { etag });
      if (!res.ok) throw httpError(res.status, { write: true });
      return;
    }
    const { obj, etag: current } = await this.load(href);
    if (etag && current && etag !== current) throw calendarError('changed', t('errors.calendar.changed'));
    const { master } = obj;
    const time = recurring(master) ? occurrenceStart(master, rid) : null;
    for (const x of obj.exceptions.filter((c) => exceptionRid(c) === rid)) obj.vcal.removeSubcomponent(x);
    obj.exceptions = obj.exceptions.filter((c) => exceptionRid(c) !== rid);
    if (time) {
      const p = new ICAL.Property('exdate');
      p.setValue(time.clone());
      const tz = zoneParam(time, tzidOf(master, 'dtstart'));
      if (tz) p.setParameter('tzid', tz);
      master.addProperty(p);
    }
    if (!obj.vcal.getAllSubcomponents('vevent').length) {
      const res = await this.request('DELETE', href, { etag: etag || current });
      if (!res.ok) throw httpError(res.status, { write: true });
      return;
    }
    await this.save(href, obj, etag || current);
  }

  // An answer to an invitation: only the user's own PARTSTAT changes, in the occurrence or in the whole series. The
  // server sends the organizer the reply (RFC 6638); events only offer this where the server says it does.
  async respond(cal, event, response, { series = false } = {}) {
    const { href, rid } = splitId(event.eventId);
    const { obj, etag } = await this.load(href);
    const whole = !rid || (series && recurring(obj.master));
    const comps = whole ? [obj.master, ...obj.exceptions].filter(Boolean) : [exceptionFor(obj, rid)].filter(Boolean);
    const me = this.me();
    let found = false;
    for (const comp of comps) {
      for (const p of comp.getAllProperties('attendee')) {
        if (!me.has(person(p).address)) continue;
        p.setParameter('partstat', ANSWER[response]);
        found = true;
      }
    }
    if (!found) throw calendarError('not_invited', t('errors.calendar.notInvited'));
    await this.save(href, obj, etag);
  }
}

// Checks the address from Server settings: finds the calendar home with these credentials and at least one calendar
// with events. Returns the address as Rukoo keeps it and the home.
async function discoverCalDav({ url, user, password, fetchImpl }) {
  const address = serverUrl(url);
  const p = new CalDavCalendar({ url: address, credentials: () => ({ user, password }), fetchImpl });
  await p.findHome();
  const calendars = await p.calendars();
  if (!calendars.length) throw calendarError('no_calendars', t('errors.caldav.noCalendars'));
  return { url: address, home: p.home };
}

module.exports = { CalDavCalendar, discoverCalDav, serverUrl, parseObject, expand, instant, utcStamp };
