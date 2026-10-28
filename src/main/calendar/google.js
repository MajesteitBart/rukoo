'use strict';

const { t } = require('../../i18n');

// Google Calendar over its REST API, with the account's OAuth token. Events come back in the shape the calendar
// store keeps (see index.js); recurring events arrive as single instances because of singleEvents=true. A change to a
// whole series, or to an occurrence and the ones after it, is made on the series' master event, which Rukoo reads
// fresh for each such change.
// https://developers.google.com/workspace/calendar/api/v3/reference
const crypto = require('crypto');
const ICAL = require('ical.js');
const { convert } = require('html-to-text');
const { zonedParts, zonedInstant, addDays, weekday, isZone, pcZone } = require('./zone');

const API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT = 20000;
const ACTIVATION_HOSTS = new Set(['console.developers.google.com', 'console.cloud.google.com']);
const DAY = 86400000;
// Search reads at most this many events per calendar; the store shows 200 in all.
const SEARCH_MAX = 250;

function calendarError(code, message, extra = {}) {
  return Object.assign(new Error(message), { calendar: true, code }, extra);
}

// A failed write that may have been made all the same: no answer came back (a dropped connection, a timeout, a body
// cut off), or the server failed (5xx) after it may have taken it. A refusal (409, 412, any other 4xx) means it wasn't.
const maybeWritten = (err) => Boolean(err && (err.code === 'network' || err.status >= 500));

// The reason codes Google puts in an error, old style (errors[].reason) and new (details[].reason).
function reasons(body) {
  const e = (body && body.error) || {};
  return [...(e.errors || []).map((x) => x && x.reason), ...(e.details || []).map((x) => x && x.reason)].filter(Boolean).map(String);
}

function apiError(status, body) {
  const e = (body && body.error) || {};
  const why = reasons(body);
  if (status === 401) return calendarError('auth', t('errors.calendar.signIn'));
  if (status === 403 && why.some((r) => /^(insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT)$/.test(r))) {
    return calendarError('scope', t('errors.calendar.scope'));
  }
  if (status === 403 && why.some((r) => /^(accessNotConfigured|SERVICE_DISABLED)$/.test(r))) {
    // Google names the page that turns the API on for this client's project; only a link to its console is kept.
    const meta = (e.details || []).map((d) => d && d.metadata).find((m) => m && m.activationUrl);
    let url = 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com';
    try {
      const u = new URL(meta.activationUrl);
      if (u.protocol === 'https:' && ACTIVATION_HOSTS.has(u.hostname)) url = u.toString();
    } catch (_) {
      // No usable link in the error; the library page will do.
    }
    return calendarError('api_disabled', t('errors.calendar.apiDisabled'), { url });
  }
  if (status === 404 || status === 410) return calendarError('not_found', t('errors.calendar.notFound'));
  if (status === 409) return calendarError('conflict', t('errors.calendar.request', { reason: e.message || status }));
  // If-Match failed: the event changed since the version the user saw.
  if (status === 412) return calendarError('changed', t('errors.calendar.changed'));
  // rateLimitExceeded and userRateLimitExceeded are both a pause, not a refusal.
  if (status === 429 || why.some((r) => /^(rateLimitExceeded|userRateLimitExceeded)$/.test(r))) return calendarError('busy', t('errors.calendar.busy'));
  return calendarError('request', t('errors.calendar.request', { reason: e.message || status }));
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// 'YYYY-MM-DD' as local midnight: all-day events belong to the day on the PC, wherever the calendar is.
function localDay(text) {
  const [y, m, d] = String(text).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function plainDescription(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  if (!/<[a-z][\s\S]*>/i.test(s)) return s.trim();
  try {
    return convert(s, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
        { selector: 'img', format: 'skip' }
      ]
    }).trim();
  } catch (_) {
    return s.replace(/<[^>]+>/g, ' ').trim();
  }
}

function person(p) {
  return p ? { name: String(p.displayName || ''), address: String(p.email || '').toLowerCase() } : null;
}

// '#rrggbb' in lower case, from Google's '#RRGGBB' or '#RGB'; null for anything else.
function hexColor(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null;
}

const RESPONSES = new Set(['needsAction', 'accepted', 'declined', 'tentative']);
const VISIBILITIES = new Set(['default', 'public', 'private', 'confidential']);
const METHODS = new Set(['popup', 'email']);
// Events Google made itself: a flight or reservation Gmail found, a contact's birthday. Google takes no new title,
// place or description for them, so Rukoo's dialog can't change them; deleting them works, also when Google marks
// them locked (#43).
// https://developers.google.com/workspace/calendar/api/guides/event-types
const GOOGLE_MADE = new Set(['fromGmail', 'birthday']);

// Reminders with their method, as Google keeps them; SMS reminders are long gone from Google and are left out.
function reminderList(list) {
  return (Array.isArray(list) ? list : []).filter((r) => r && METHODS.has(r.method) && Number.isInteger(r.minutes)).map((r) => ({ method: r.method, minutes: r.minutes }));
}

// Google always has an answer: no reminders field means the calendar's defaults.
function readReminders(r) {
  if (!r || typeof r !== 'object') return { useDefault: true, overrides: [] };
  return { useDefault: r.useDefault === true, overrides: reminderList(r.overrides) };
}

// Google refuses defaults and overrides together.
function googleReminders(r) {
  return r.useDefault ? { useDefault: true } : { useDefault: false, overrides: r.overrides.map(({ method, minutes }) => ({ method, minutes })) };
}

const sameReminders = (a, b) => JSON.stringify(a && googleReminders(a)) === JSON.stringify(b && googleReminders(b));

// A conference Google has made or is making. A request that failed made none.
function conferenceOf(item) {
  const cd = item.conferenceData;
  if (cd && typeof cd === 'object') {
    const status = cd.createRequest && cd.createRequest.status && cd.createRequest.status.statusCode;
    const type = (cd.conferenceSolution && cd.conferenceSolution.key && cd.conferenceSolution.key.type) || (cd.createRequest && cd.createRequest.conferenceSolutionKey && cd.createRequest.conferenceSolutionKey.type);
    if (status === 'failure' && !(cd.entryPoints || []).length) return null;
    return { solution: type === 'hangoutsMeet' ? 'hangoutsMeet' : 'other', pending: status === 'pending' };
  }
  return item.hangoutLink ? { solution: 'hangoutsMeet', pending: false } : null;
}

function originalStartOf(item) {
  const o = item.originalStartTime;
  if (!o) return null;
  const ms = o.date ? localDay(o.date) : Date.parse(o.dateTime);
  return Number.isFinite(ms) ? ms : null;
}

function toEvent(item, cal) {
  const allDay = Boolean(item.start && item.start.date);
  const attendees = (item.attendees || [])
    .filter((a) => a && a.email && !a.resource)
    .map((a) => ({
      ...person(a),
      response: RESPONSES.has(a.responseStatus) ? a.responseStatus : 'needsAction',
      self: Boolean(a.self),
      organizer: Boolean(a.organizer),
      optional: Boolean(a.optional)
    }));
  const me = attendees.find((a) => a.self);
  const organizer = item.organizer ? { ...person(item.organizer), self: Boolean(item.organizer.self) } : null;
  const own = !organizer || organizer.self;
  const video = item.hangoutLink || ((item.conferenceData && item.conferenceData.entryPoints) || []).find((p) => p && p.entryPointType === 'video')?.uri || null;
  const eventType = typeof item.eventType === 'string' ? item.eventType : 'default';
  // A calendar shared without private details can change everything except its private events. A locked event can't
  // be changed, but one Google made itself can still be deleted.
  const allowed = Boolean(cal.writable && (own || item.guestsCanModify) && !item.privateCopy && !(cal.hidesPrivate && item.visibility === 'private'));
  const canEdit = allowed && !item.locked && !GOOGLE_MADE.has(eventType);
  const visibility = VISIBILITIES.has(item.visibility) ? item.visibility : 'default';
  // Guests: the organizer and guests who may change the event edit the list; other guests may only add to it unless
  // the organizer said no. A list Google left partly out can't be edited without dropping the guests it left out.
  const invites = Boolean(cal.writable && !item.locked && !item.privateCopy && !item.attendeesOmitted && eventType === 'default' && !(cal.hidesPrivate && visibility === 'private'));
  let canInvite = false;
  if (invites && (own || item.guestsCanModify)) canInvite = 'edit';
  else if (invites && item.guestsCanInviteOthers !== false) canInvite = 'add';
  const booking = item.extendedProperties && item.extendedProperties.private && item.extendedProperties.private.rukooBooking;
  return {
    calendarId: cal.id,
    eventId: String(item.id),
    // The version of the event; a change or deletion sends it back so it can't land on a newer one.
    etag: typeof item.etag === 'string' ? item.etag : null,
    eventType,
    seriesId: item.recurringEventId ? String(item.recurringEventId) : null,
    title: String(item.summary || ''),
    location: String(item.location || ''),
    description: plainDescription(item.description),
    allDay,
    start: allDay ? localDay(item.start.date) : Date.parse(item.start.dateTime),
    end: allDay ? localDay(item.end.date) : Date.parse(item.end.dateTime),
    startDate: allDay ? item.start.date : null,
    endDate: allDay ? item.end.date : null,
    timeZone: (item.start && item.start.timeZone) || cal.timeZone || null,
    // A flight can start in one zone and land in another; each end keeps its own.
    endTimeZone: (item.end && item.end.timeZone) || (item.start && item.start.timeZone) || cal.timeZone || null,
    status: item.status === 'tentative' ? 'tentative' : 'confirmed',
    busy: item.transparency !== 'transparent',
    response: me && !own ? me.response : null,
    canEdit,
    canDelete: allowed && (!item.locked || GOOGLE_MADE.has(eventType)),
    canRespond: Boolean(me && !own),
    organizer,
    attendees,
    moreAttendees: Boolean(item.attendeesOmitted),
    link: /^https:\/\//.test(item.htmlLink || '') ? item.htmlLink : null,
    meeting: /^https:\/\//.test(video || '') ? video : null,
    uid: typeof item.iCalUID === 'string' ? item.iCalUID : null,
    originalStart: originalStartOf(item),
    recurring: Boolean(item.recurringEventId || (Array.isArray(item.recurrence) && item.recurrence.length)),
    reminders: readReminders(item.reminders),
    visibility,
    bookingId: typeof booking === 'string' && booking ? booking : null,
    canInvite,
    // Google moves only ordinary events, and makes the one who moves it the organizer.
    canMove: canEdit && own && eventType === 'default',
    conference: conferenceOf(item)
  };
}

// The start and end Google wants. A patch that switches between all-day and timed clears the other field.
function times(input, timeZone, { patch = false, endTimeZone = timeZone } = {}) {
  if (input.allDay) {
    const clear = patch ? { dateTime: null, timeZone: null } : {};
    return { start: { ...clear, date: input.startDate }, end: { ...clear, date: input.endDate } };
  }
  const at = (ms, zone) => ({ ...(patch ? { date: null } : {}), dateTime: new Date(ms).toISOString(), ...(zone ? { timeZone: zone } : {}) });
  return { start: at(input.start, timeZone), end: at(input.end, endTimeZone) };
}

const hasGuests = (g) => Boolean(g && ((g.add && g.add.length) || (g.remove && g.remove.length) || (g.optional && Object.keys(g.optional).length)));

// The guest diff applied to the list Google has now. Every entry keeps all its fields (answers, comments, rooms and
// other resources); removing never takes the organizer or a resource off.
function applyGuests(list, diff) {
  const lower = (s) => String(s || '').toLowerCase();
  const gone = new Set((diff.remove || []).map(lower));
  const out = list.filter((a) => !(a && gone.has(lower(a.email)) && !a.organizer && !a.resource)).map((a) => ({ ...a }));
  for (const [address, optional] of Object.entries(diff.optional || {})) {
    const a = out.find((x) => lower(x.email) === lower(address) && !x.resource);
    if (a) a.optional = optional;
  }
  for (const g of diff.add || []) {
    if (out.some((x) => lower(x.email) === g.address)) continue;
    const optional = (diff.optional && diff.optional[g.address]) ?? g.optional;
    out.push({ email: g.address, ...(g.name ? { displayName: g.name } : {}), ...(optional ? { optional: true } : {}), responseStatus: 'needsAction' });
  }
  return out;
}

// ---------- wall clocks and repeat rules ----------

const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
// The date and minute of the day a zone's clock shows at a moment.
function wall(ms, zone) {
  const p = zonedParts(ms, zone);
  const [h, m] = p.time.split(':').map(Number);
  return { date: p.date, minutes: h * 60 + m };
}
const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / DAY;
const daysBetween = (a, b) => Math.round(dayNumber(b) - dayNumber(a));
// How far b lies after a on the clock, in minutes; a clock change in between doesn't count.
const wallDelta = (a, b) => daysBetween(a.date, b.date) * 1440 + (b.minutes - a.minutes);
function shifted(w, minutes) {
  const total = w.minutes + minutes;
  const days = Math.floor(total / 1440);
  return { date: addDays(w.date, days), minutes: total - days * 1440 };
}
const instantOf = (w, zone) => zonedInstant(w.date, hhmm(w.minutes), zone);
const basicDate = (date) => date.replace(/-/g, '');
const basicUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const basicWall = (w) => `${basicDate(w.date)}T${hhmm(w.minutes).replace(':', '')}00`;

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const isRule = (line) => /^RRULE:/i.test(line);
const ruleParts = (rule) =>
  rule
    .split(';')
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).toUpperCase(), p.slice(i + 1)];
    });
const ruleText = (parts) => parts.map(([k, v]) => `${k}=${v}`).join(';');
const rulePart = (parts, key) => (parts.find(([k]) => k === key) || [])[1];
function setPart(parts, key, value) {
  const i = parts.findIndex(([k]) => k === key);
  if (value === null) {
    if (i >= 0) parts.splice(i, 1);
  } else if (i >= 0) parts[i] = [key, value];
  else parts.push([key, value]);
}
const daysInMonth = (date) => {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const nthOf = (date, last) => (last && Number(date.slice(8)) + 7 > daysInMonth(date) ? -1 : Math.ceil(Number(date.slice(8)) / 7));

// A rule for a series whose first occurrence moves from one date to another: the weekday, the day of the month and
// the month it names move along, or the old ones would keep the series where it was and the new start would be an
// extra occurrence. Several weekdays can't follow one move, so that is refused.
function moveRule(rule, from, to) {
  if (!rule || from === to) return rule;
  const parts = ruleParts(rule);
  const refuse = () => calendarError('refused', t('errors.calendar.seriesDayChange'));
  const byday = rulePart(parts, 'BYDAY');
  if (byday) {
    const days = byday.split(',').map((d) => /^([+-]?\d{1,2})?([A-Z]{2})$/i.exec(d));
    const numbered = days.some((m) => m && m[1]);
    const next = days.map((m) => {
      if (!m) return null;
      const n = m[1] ? Number(m[1]) : null;
      return n === null ? WEEKDAYS[weekday(to)] : `${nthOf(to, n < 0)}${WEEKDAYS[weekday(to)]}`;
    });
    const same = weekday(from) === weekday(to) && (!numbered || nthOf(from, false) === nthOf(to, false));
    if (days.length > 1 || !days[0]) {
      if (!same) throw refuse();
    } else setPart(parts, 'BYDAY', next[0]);
  }
  const monthday = rulePart(parts, 'BYMONTHDAY');
  if (monthday && from.slice(8) !== to.slice(8)) {
    if (monthday.includes(',')) throw refuse();
    setPart(parts, 'BYMONTHDAY', monthday === '-1' && Number(to.slice(8)) === daysInMonth(to) ? '-1' : String(Number(to.slice(8))));
  }
  const month = rulePart(parts, 'BYMONTH');
  if (month && from.slice(5, 7) !== to.slice(5, 7)) {
    if (month.includes(',')) throw refuse();
    setPart(parts, 'BYMONTH', String(Number(to.slice(5, 7))));
  }
  return ruleText(parts);
}

// How many times the rule repeats from the series' start up to (not including) the split. EXDATEs and deleted
// occurrences count too: RFC 5545 applies COUNT before it takes them out.
function countBefore(rule, start, split, allDay) {
  const parts = ruleParts(rule).filter(([k]) => k !== 'UNTIL');
  const time = (w) => {
    const [year, month, day] = w.date.split('-').map(Number);
    return allDay ? ICAL.Time.fromData({ year, month, day, isDate: true }) : ICAL.Time.fromData({ year, month, day, hour: Math.floor(w.minutes / 60), minute: w.minutes % 60, second: 0, isDate: false });
  };
  const it = ICAL.Recur.fromString(ruleText(parts)).iterator(time(start));
  const end = time(split);
  let n = 0;
  for (let next = it.next(); next && next.compare(end) < 0 && n < 100000; next = it.next()) n++;
  return n;
}

// The dates in an EXDATE or RDATE line: an instant for timed values, a date for all-day ones.
function lineDates(line, zone) {
  const m = /^(EXDATE|RDATE)((?:;[^:]*)?):(.+)$/i.exec(line);
  if (!m) return null;
  const params = Object.fromEntries(
    m[2]
      .split(';')
      .filter(Boolean)
      .map((p) => [p.slice(0, p.indexOf('=')).toUpperCase(), p.slice(p.indexOf('=') + 1)])
  );
  const tz = params.TZID && isZone(params.TZID) ? params.TZID : zone;
  const values = m[3].split(',').map((v) => {
    const d = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
    if (!d) return null;
    const date = `${d[1]}-${d[2]}-${d[3]}`;
    if (!d[4]) return { date, at: null };
    const at = d[7] ? Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(d[4]), Number(d[5]), Number(d[6])) : zonedInstant(date, `${d[4]}:${d[5]}`, tz);
    return { date: null, at };
  });
  return values.every(Boolean) ? { kind: m[1].toUpperCase(), values } : null;
}

// An EXDATE or RDATE line in the series' own frame.
function dateLine(kind, values, zone, allDay) {
  return allDay ? `${kind};VALUE=DATE:${values.map((w) => basicDate(w.date)).join(',')}` : `${kind};TZID=${zone}:${values.map(basicWall).join(',')}`;
}

// A series' other recurrence lines on either side of a split: what stays with the old series, and what moves to the
// new one shifted by as much as its start moved, written all-day or timed and in the zone (toZone) the new series is.
// Lines Rukoo can't read stay with the old series as they are.
function splitLines(lines, split, zone, toAllDay, shift, toZone = zone) {
  const before = [];
  const after = [];
  for (const line of lines) {
    const parsed = lineDates(line, zone);
    if (!parsed) {
      before.push(line);
      continue;
    }
    const walls = parsed.values.map((v) => (v.at === null ? { date: v.date, minutes: 0 } : wall(v.at, zone)));
    const early = walls.filter((w) => wallDelta(w, split) > 0);
    const late = walls.filter((w) => wallDelta(w, split) <= 0).map((w) => shifted(w, shift));
    if (early.length === walls.length) before.push(line);
    else if (early.length) before.push(dateLine(parsed.kind, early, zone, parsed.values[0].at === null));
    if (late.length) after.push(dateLine(parsed.kind, late, toZone, toAllDay));
  }
  return { before, after };
}

// Whether an UNTIL lies before the split: by date for an all-day series or a date-only UNTIL, else as an instant (a
// floating one on the series' clock).
function untilBefore(until, split, zone, allDay) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(until));
  if (!m) return false;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (allDay || !m[4]) return date < split.wall.date;
  const ms = m[7] ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : instantOf({ date, minutes: m[4] * 60 + Number(m[5]) }, zone) + m[6] * 1000;
  return ms < split.ms;
}

// Whether a series' recurrence lines end before the split: every rule stops before it (an UNTIL before it, or a COUNT
// used up before it) and no extra date (RDATE) lies at or after it. That is what a cut there leaves.
function endsBefore(lines, first, split, zone, allDay) {
  for (const line of lines) {
    if (isRule(line)) {
      const rule = line.slice(6);
      const parts = ruleParts(rule);
      const until = rulePart(parts, 'UNTIL');
      const count = rulePart(parts, 'COUNT');
      const ends = until ? untilBefore(until, split, zone, allDay) : Boolean(count) && countBefore(rule, first, split.wall, allDay) >= Number(count);
      if (!ends) return false;
      continue;
    }
    const d = lineDates(line, zone);
    if (d && d.kind === 'RDATE' && d.values.some((v) => wallDelta(v.at === null ? { date: v.date, minutes: 0 } : wall(v.at, zone), split.wall) <= 0)) return false;
  }
  return true;
}

// A series' EXDATE and RDATE lines when its first occurrence moves by shift minutes on the clock: every occurrence
// moves as far, so these lines must too, or a deleted occurrence comes back. They are written in the zone the series
// is in now, all-day or timed as it is now. Lines Rukoo can't read stay as they are.
function shiftLines(lines, zone, toZone, toAllDay, shift) {
  return lines.map((line) => {
    const parsed = lineDates(line, zone);
    if (!parsed) return line;
    if (!shift && zone === toZone && (parsed.values[0].at === null) === toAllDay) return line;
    return dateLine(parsed.kind, parsed.values.map((v) => shifted(v.at === null ? { date: v.date, minutes: 0 } : wall(v.at, zone), shift)), toZone, toAllDay);
  });
}

// A Google event id (base32hex) that is the same each time the same occurrence of the same series is split, so a
// retry after a lost answer finds the series it made the first time. single: the split makes one event instead of a
// series ("stop repeating"), which gets an id of its own, so a retry never brings back the other kind.
function splitId(masterId, split, single = false) {
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of crypto.createHash('sha256').update(`${masterId}\n${split}${single ? '\nsingle' : ''}`).digest()) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, 26);
}

// Fields an exception can have of its own; the rest comes from its series.
const OWN_FIELDS = ['summary', 'description', 'location', 'transparency', 'visibility', 'colorId', 'reminders', 'attendees'];
// What a new series copies from the one it splits off: everything about the event except its identity and times.
const COPIED = ['summary', 'description', 'location', 'colorId', 'attendees', 'reminders', 'transparency', 'visibility', 'extendedProperties', 'guestsCanModify', 'guestsCanInviteOthers', 'guestsCanSeeOtherGuests', 'anyoneCanAddSelf', 'source', 'attachments'];

class GoogleCalendar {
  // token: () => Promise<string>, a valid access token for the account. timeZone: the PC's zone, for new events, or
  // a function that gives it at each change, so a laptop that travels writes the zone it is in.
  constructor({ token, fetchImpl = (...a) => fetch(...a), timeZone = pcZone }) {
    this.token = token;
    this.fetch = fetchImpl;
    this.zone = typeof timeZone === 'function' ? timeZone : () => timeZone;
    // Every event has an etag, and a change can be made to apply only to that version.
    this.versioned = true;
  }

  // etag: only change the event if it is still this version; Google answers 412 otherwise.
  async request(method, path, { query = {}, body, etag = null } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const token = await this.token();
    let res;
    try {
      res = await this.fetch(url.toString(), {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(etag ? { 'if-match': etag } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT)
      });
    } catch (_) {
      throw calendarError('network', t('errors.calendar.unreachable'));
    }
    if (res.status === 204) return null;
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      // A body that stops halfway is a failed request, never an empty answer: an empty list would clear the calendar.
      if (res.ok) throw calendarError('network', t('errors.calendar.unreachable'));
    }
    if (res.ok) return data;
    throw Object.assign(apiError(res.status, data), { status: res.status });
  }

  // Every page, or an error: a list cut off at the limit would look complete and replace the cached events.
  async pages(path, query, max = 50) {
    const items = [];
    let pageToken;
    for (let i = 0; i < max; i++) {
      const page = await this.request('GET', path, { query: { ...query, pageToken } });
      items.push(...((page && page.items) || []));
      pageToken = page && page.nextPageToken;
      if (!pageToken) return items;
    }
    throw calendarError('too_many', t('errors.calendar.tooMany'));
  }

  async calendars() {
    const items = await this.pages('/users/me/calendarList', { maxResults: 250 });
    return items
      .filter((c) => c && c.id && c.accessRole !== 'freeBusyReader')
      .map((c) => ({
        id: String(c.id),
        name: String(c.summaryOverride || c.summary || c.id),
        primary: Boolean(c.primary),
        writable: c.accessRole === 'owner' || c.accessRole === 'writer' || c.accessRole === 'writerWithoutPrivateAccess',
        hidesPrivate: c.accessRole === 'writerWithoutPrivateAccess',
        accessRole: c.accessRole,
        // Google leaves selected out for a calendar that is switched off in Google Calendar; its default is false.
        selected: c.selected === true,
        timeZone: c.timeZone || null,
        color: hexColor(c.backgroundColor),
        conference: Boolean(c.conferenceProperties && (c.conferenceProperties.allowedConferenceSolutionTypes || []).includes('hangoutsMeet')),
        defaultReminders: reminderList(c.defaultReminders),
        owned: c.accessRole === 'owner'
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary));
  }

  async events(cal, start, end) {
    const items = await this.pages(this.eventsPath(cal), {
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: new Date(start).toISOString(),
      timeMax: new Date(end).toISOString(),
      maxResults: 2500
    });
    return items.filter(shown).map((i) => toEvent(i, cal));
  }

  // Google's own search over titles, descriptions, places and guests, as occurrences. The first pages are enough.
  async search(cal, query, start, end) {
    const items = [];
    let pageToken;
    for (let i = 0; i < 2 && items.length < SEARCH_MAX; i++) {
      const page = await this.request('GET', this.eventsPath(cal), {
        query: { q: query, singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), maxResults: SEARCH_MAX, pageToken }
      });
      items.push(...((page && page.items) || []));
      pageToken = page && page.nextPageToken;
      if (!pageToken) break;
    }
    return items.filter(shown).slice(0, SEARCH_MAX).map((i) => toEvent(i, cal));
  }

  eventsPath(cal) {
    return `/calendars/${encodeURIComponent(cal.id)}/events`;
  }

  eventPath(cal, eventId) {
    return `${this.eventsPath(cal)}/${encodeURIComponent(eventId)}`;
  }

  // The event as Google has it now. A deleted occurrence of a series still answers, as cancelled.
  async get(cal, eventId) {
    const item = await this.request('GET', this.eventPath(cal, eventId));
    if (!item || item.status === 'cancelled') throw calendarError('not_found', t('errors.calendar.notFound'));
    return toEvent(item, cal);
  }

  // Google keeps reminders between 0 and 4 weeks before the start; "on the day at 09:00" can't be stored.
  checkReminders(input) {
    if (input.reminders && input.reminders.overrides.some((r) => r.minutes < 0)) throw calendarError('invalid', t('errors.calendar.invalidReminders'));
  }

  // Everything Rukoo sets on a new event, or on one a retry finds or brings back. requestId names the Meet request:
  // Google makes one meeting per id, so a retry doesn't make a second link.
  fields(input, { bookingId = null, patch = false, conference = null, requestId = null } = {}) {
    const body = { summary: input.title, location: input.location, description: input.description, ...times(input, input.timeZone || this.zone(), { patch }) };
    if (input.guests && input.guests.add && input.guests.add.length) body.attendees = applyGuests([], { add: input.guests.add, optional: input.guests.optional });
    if (typeof input.recurrence === 'string') body.recurrence = [`RRULE:${input.recurrence}`];
    if (input.reminders) body.reminders = googleReminders(input.reminders);
    // New all-day events show as free, timed ones as busy, as other calendars do.
    body.transparency = (input.busy ?? !input.allDay) ? 'opaque' : 'transparent';
    if (input.visibility) body.visibility = input.visibility;
    if (bookingId) body.extendedProperties = { private: { rukooBooking: bookingId } };
    if (input.addMeet === true && !conference) body.conferenceData = meetRequest(requestId);
    if (input.addMeet === false && conference) body.conferenceData = null;
    return body;
  }

  // input.id, when given, is the event's id: a Save that is tried again after a lost answer finds the event it made
  // the first time (Google answers 409) and gives it the latest fields instead of making a second one. A booking event
  // has a uid instead, the booking's own, which the guest's invitation file carries too; a retry finds it by its
  // booking id, or by that uid.
  async create(cal, input, { notify = false, bookingId = null, uid = null } = {}) {
    this.checkReminders(input);
    const requestId = bookingId || input.id || crypto.randomUUID();
    const booking = Boolean(bookingId || uid);
    if (booking) {
      const found = await this.findBooking(cal, bookingId, uid);
      if (found) return this.restore(cal, found, input, { notify, bookingId, requestId });
    }
    const body = { ...(uid ? { iCalUID: uid } : input.id ? { id: input.id } : {}), ...this.fields(input, { bookingId, requestId }) };
    try {
      const item = await this.request('POST', this.eventsPath(cal), { query: { sendUpdates: notify ? 'all' : 'none', conferenceDataVersion: 1 }, body });
      return toEvent(item, cal);
    } catch (err) {
      if (err.code !== 'conflict' || (!input.id && !booking)) throw err;
    }
    const found = booking ? await this.findBooking(cal, bookingId, uid) : await this.request('GET', this.eventPath(cal, input.id));
    if (!found && booking && uid) {
      // The uid is taken by an event the user doesn't organize, such as an invitation that carries it: the booking
      // gets an event of its own, which a retry finds by its booking id.
      const item = await this.request('POST', this.eventsPath(cal), { query: { sendUpdates: notify ? 'all' : 'none', conferenceDataVersion: 1 }, body: this.fields(input, { bookingId, requestId }) });
      return toEvent(item, cal);
    }
    if (!found) throw calendarError('conflict', t('errors.calendar.readOnly'));
    return this.restore(cal, found, input, { notify, bookingId, requestId });
  }

  // A booking event made before, live or deleted (Google keeps deleted events): first by the booking id in its private
  // properties, which Google keeps as written, then by its uid. Google's insert reference doesn't list iCalUID among the
  // fields it takes, so the event may carry a uid Google made up; the event the store returns says which. By uid only an
  // event the user organizes counts: anyone can send an invitation with the booking's uid.
  async findBooking(cal, bookingId, uid) {
    const best = (items, ok) => {
      const list = items.filter((i) => i && !i.recurringEventId && ok(i));
      return list.find((i) => i.status !== 'cancelled') || list[0] || null;
    };
    if (bookingId) {
      const items = await this.pages(this.eventsPath(cal), { privateExtendedProperty: `rukooBooking=${bookingId}`, showDeleted: 'true' });
      const found = best(items, (i) => Boolean(i.extendedProperties && i.extendedProperties.private && i.extendedProperties.private.rukooBooking === bookingId));
      if (found) return found;
    }
    if (!uid) return null;
    return best(await this.pages(this.eventsPath(cal), { iCalUID: uid, showDeleted: 'true' }), (i) => i.iCalUID === uid && Boolean(i.organizer && i.organizer.self));
  }

  // An event a create made before. A live one is the user's own Save that got no answer: it gets the latest fields,
  // without telling guests again. A deleted one (Google keeps them, cancelled, and their ids) comes back with every
  // field, as a new invitation.
  async restore(cal, item, input, { notify, bookingId, requestId }) {
    const cancelled = item.status === 'cancelled';
    if (!cancelled && !(item.organizer && item.organizer.self)) throw calendarError('conflict', t('errors.calendar.readOnly'));
    const body = { ...this.fields(input, { bookingId, patch: true, conference: conferenceOf(item), requestId }), ...(cancelled ? { status: 'confirmed' } : {}) };
    const saved = await this.request('PATCH', this.eventPath(cal, item.id), { query: { sendUpdates: cancelled && notify ? 'all' : 'none', conferenceDataVersion: 1 }, body });
    return toEvent(saved, cal);
  }

  // The fields of a change that aren't title, place, description or times: what the input names, compared with the
  // event when only real changes may go out (a series master).
  extras(input, event, { changesOnly = false, conference = event.conference, requestId } = {}) {
    const body = {};
    const differs = (a, b) => !changesOnly || a !== b;
    if (input.reminders !== undefined && (!changesOnly || !sameReminders(input.reminders, event.reminders))) body.reminders = googleReminders(input.reminders);
    if (input.busy !== undefined && differs(input.busy, event.busy)) body.transparency = input.busy ? 'opaque' : 'transparent';
    if (input.visibility !== undefined && differs(input.visibility, event.visibility)) body.visibility = input.visibility;
    if (input.addMeet === true && !conference) body.conferenceData = meetRequest(requestId);
    if (input.addMeet === false && (!changesOnly || conference)) body.conferenceData = null;
    return body;
  }

  // A new Meet request on an existing event. Google ignores a request id it has seen on the event, so one made again
  // after Meet was taken off needs a new id; the version the change is made on gives one that a retry repeats.
  requestId(event, etag) {
    const base = event.bookingId || event.eventId;
    return etag ? `${base}-${crypto.createHash('sha256').update(etag).digest('hex').slice(0, 8)}` : base;
  }

  // Changes this one event; for a recurring event that is this occurrence. The event keeps its own time zones unless
  // the input names one. Rukoo shows a description as plain text, so an untouched one stays out of the patch and
  // keeps its formatting. etag is the version the user changed; a newer one in Google makes this fail with 'changed'.
  // scope 'all' and 'following' change the series instead (see updateSeries and split).
  async update(cal, event, input, { notify = false, etag = null, scope = 'one', seriesEtag = null } = {}) {
    this.checkReminders(input);
    // A guest who may invite others sends only the guest list; Google keeps the rest for the organizer.
    if (!event.canEdit && hasGuests(input.guests)) {
      const id = event.seriesId && scope === 'all' ? event.seriesId : event.eventId;
      const attendees = await this.guestList(cal, id, input.guests);
      const item = await this.request('PATCH', this.eventPath(cal, id), { query: { sendUpdates: notify ? 'all' : 'none', conferenceDataVersion: 1 }, body: { attendees }, etag: id === event.eventId ? etag : seriesEtag });
      return id === event.eventId ? toEvent(item, cal) : null;
    }
    if (event.seriesId && scope === 'all') return this.updateSeries(cal, event, input, { notify, seriesEtag });
    if (event.seriesId && scope === 'following') return this.split(cal, event, input, { notify, seriesEtag });
    const zone = input.timeZone || event.timeZone;
    const endZone = input.timeZone && input.timeZone !== event.timeZone ? input.timeZone : event.endTimeZone || event.timeZone;
    const body = {
      summary: input.title,
      location: input.location,
      ...(input.description !== event.description ? { description: input.description } : {}),
      ...times(input, zone, { patch: true, endTimeZone: endZone })
    };
    if (hasGuests(input.guests)) body.attendees = await this.guestList(cal, event.eventId, input.guests);
    // A rule on a single event makes it a series; the event becomes its first occurrence.
    if (typeof input.recurrence === 'string' && !event.seriesId) body.recurrence = [`RRULE:${input.recurrence}`];
    Object.assign(body, this.extras(input, event, { requestId: this.requestId(event, etag) }));
    const item = await this.request('PATCH', this.eventPath(cal, event.eventId), { query: { sendUpdates: notify ? 'all' : 'none', conferenceDataVersion: 1 }, body, etag });
    return toEvent(item, cal);
  }

  // The guest list with the diff applied, on a fresh copy with every guest: Google replaces the whole list on a
  // change, so a list from the cache would drop rooms, answers and guests it never had.
  async guestList(cal, id, diff, item = null) {
    const fresh = item || (await this.request('GET', this.eventPath(cal, id), { query: { maxAttendees: 1000 } }));
    if (!fresh || fresh.status === 'cancelled') throw calendarError('not_found', t('errors.calendar.notFound'));
    if (fresh.attendeesOmitted) throw calendarError('refused', t('errors.calendar.guestListPartial'));
    return applyGuests(fresh.attendees || [], diff);
  }

  // The series' first event, as Google has it now, with every guest. seriesEtag: the version the user saw, if any.
  async master(cal, event, seriesEtag = null) {
    const item = await this.request('GET', this.eventPath(cal, event.seriesId), { query: { maxAttendees: 1000 } });
    if (!item || item.status === 'cancelled' || !Array.isArray(item.recurrence)) throw calendarError('not_found', t('errors.calendar.notFound'));
    // Checked before anything is written, so a split never makes a new series it then has to take back.
    if (seriesEtag && item.etag && seriesEtag !== item.etag) throw calendarError('changed', t('errors.calendar.changed'));
    return item;
  }

  zoneOf(item, cal) {
    return (item.start && item.start.timeZone) || cal.timeZone || this.zone();
  }

  // Where the series' first occurrence goes when the user moves the opened occurrence from event's times to input's:
  // by the same distance on the clock in the series' zone, its start and its end each on their own, so a change of
  // clocks between the two occurrences doesn't move the series by an hour. Also the first occurrence's date before (in
  // the old zone) and after (in the zone the series is in from now on), for the rule: Google repeats it in that zone,
  // so a new zone that puts the start on another date takes the weekday along.
  shiftMaster(master, event, input, zone) {
    const m = master.start;
    const mAllDay = Boolean(m.date);
    const endZone = (master.end && master.end.timeZone) || zone;
    const iso = (ms) => new Date(ms).toISOString();
    const timed = (start, end, z, ez) => ({ start: { date: null, dateTime: iso(start), timeZone: z }, end: { date: null, dateTime: iso(end), timeZone: ez } });
    const dated = (start, end) => ({ start: { dateTime: null, timeZone: null, date: start }, end: { dateTime: null, timeZone: null, date: end } });
    if (input.allDay && event.allDay && mAllDay) {
      const to = addDays(m.date, daysBetween(event.startDate, input.startDate));
      return { ...dated(to, addDays(master.end.date, daysBetween(event.endDate, input.endDate))), from: m.date, to };
    }
    if (!input.allDay && !event.allDay && !mAllDay) {
      const ms = Date.parse(m.dateTime);
      const start = instantOf(shifted(wall(ms, zone), wallDelta(wall(event.start, zone), wall(input.start, zone))), zone);
      let end = instantOf(shifted(wall(Date.parse(master.end.dateTime), endZone), wallDelta(wall(event.end, endZone), wall(input.end, endZone))), endZone);
      if (end <= start) end = start + (input.end - input.start);
      return { ...timed(start, end, input.timeZone || zone, input.timeZone || endZone), from: wall(ms, zone).date, to: wall(start, input.timeZone || zone).date };
    }
    if (input.allDay) {
      const from = mAllDay ? m.date : wall(Date.parse(m.dateTime), zone).date;
      const opened = event.allDay ? event.startDate : wall(event.start, zone).date;
      const to = addDays(from, daysBetween(opened, input.startDate));
      return { ...dated(to, addDays(to, daysBetween(input.startDate, input.endDate))), from, to };
    }
    const z = input.timeZone || zone;
    const from = mAllDay ? m.date : wall(Date.parse(m.dateTime), z).date;
    const opened = event.allDay ? event.startDate : wall(event.start, z).date;
    const target = wall(input.start, z);
    const first = { date: addDays(from, daysBetween(opened, target.date)), minutes: target.minutes };
    const start = instantOf(first, z);
    return { ...timed(start, instantOf(shifted(first, wallDelta(target, wall(input.end, z))), z), z, z), from, to: first.date };
  }

  // What the user changed on the opened occurrence besides its times and rule. Only what differs from the occurrence
  // goes out, so a title or agenda that only this occurrence had doesn't spread to the whole series.
  fieldChanges(master, event, input) {
    const body = {};
    if (input.title !== event.title) body.summary = input.title;
    if (input.location !== event.location) body.location = input.location;
    if (input.description !== event.description) body.description = input.description;
    const conference = event.conference || conferenceOf(master);
    return Object.assign(body, this.extras(input, event, { changesOnly: true, conference, requestId: this.requestId({ eventId: master.id, bookingId: event.bookingId }, master.etag) }));
  }

  // The change to the opened occurrence as a change to the series' master, times and rule included. gone: the
  // occurrences Google keeps as deleted exceptions, which it finds by their old start.
  seriesChanges(cal, master, event, input, gone = []) {
    const body = this.fieldChanges(master, event, input);
    const zone = this.zoneOf(master, cal);
    const lines = master.recurrence || [];
    let extra = lines.filter((l) => !isRule(l));
    let rules = lines.filter(isRule).map((l) => l.slice(6));
    let changed = false;
    if (movedTimes(event, input)) {
      const { start, end, from, to } = this.shiftMaster(master, event, input, zone);
      Object.assign(body, { start, end });
      if (typeof input.recurrence !== 'string') {
        const moved = rules.map((r) => moveRule(r, from, to));
        changed = moved.some((r, i) => r !== rules[i]);
        rules = moved;
      }
      // Excluded and added dates move with the series, and occurrences deleted one by one become EXDATEs where the
      // series puts them now; otherwise they would show again at the new time.
      const fromAllDay = Boolean(master.start.date);
      const toAllDay = Boolean(start.date);
      const toZone = toAllDay ? zone : start.timeZone || zone;
      const first = fromAllDay ? { date: master.start.date, minutes: 0 } : wall(Date.parse(master.start.dateTime), zone);
      const shift = wallDelta(first, toAllDay ? { date: start.date, minutes: 0 } : wall(Date.parse(start.dateTime), toZone));
      if (shift || toZone !== zone || toAllDay !== fromAllDay) {
        const next = shiftLines(extra, zone, toZone, toAllDay, shift);
        // Only deleted occurrences at the series' time of day: an earlier move leaves Google's at the old time, where
        // they match nothing, and moved along they could hide a real one. Those an EXDATE has already are left out.
        const key = (w) => `${w.date} ${w.minutes}`;
        const excluded = new Set(
          extra
            .map((l) => lineDates(l, zone))
            .filter((d) => d && d.kind === 'EXDATE')
            .flatMap((d) => d.values.map((v) => key(v.at === null ? { date: v.date, minutes: 0 } : wall(v.at, zone))))
        );
        const deleted = gone.map((i) => originalWall(i, zone)).filter((w) => (fromAllDay || w.minutes === first.minutes) && !excluded.has(key(w)));
        if (deleted.length) next.push(dateLine('EXDATE', deleted.map((w) => shifted(w, shift)), toZone, toAllDay));
        changed = changed || next.length !== extra.length || next.some((l, i) => l !== extra[i]);
        extra = next;
      }
    }
    // A new rule replaces the old one; EXDATE and RDATE lines from another calendar stay.
    if (typeof input.recurrence === 'string') body.recurrence = [`RRULE:${input.recurrence}`, ...extra];
    else if (input.recurrence === null) body.recurrence = extra.filter((l) => /^RDATE/i.test(l));
    else if (changed) body.recurrence = [...rules.map((r) => `RRULE:${r}`), ...extra];
    return body;
  }

  // Changes the whole series through its master. Returns null: the occurrences come back with the store's refetch.
  async updateSeries(cal, event, input, { notify = false, seriesEtag = null } = {}) {
    const master = await this.master(cal, event, seriesEtag);
    const gone = movedStart(event, input) ? (await this.exceptions(cal, master)).filter((i) => i.status === 'cancelled') : [];
    const body = this.seriesChanges(cal, master, event, input, gone);
    if (hasGuests(input.guests)) body.attendees = await this.guestList(cal, master.id, input.guests, master);
    if (Object.keys(body).length) {
      await this.request('PATCH', this.eventPath(cal, master.id), { query: { sendUpdates: notify ? 'all' : 'none', conferenceDataVersion: 1 }, body, etag: seriesEtag || master.etag });
    }
    return null;
  }

  // Where the series is split: the opened occurrence's original start, which a moved occurrence keeps. An event from
  // a cache from before Rukoo kept it is read again.
  async splitPoint(cal, event, zone, allDay) {
    let original = event.originalStart;
    if (original === null || original === undefined) {
      const item = await this.request('GET', this.eventPath(cal, event.eventId));
      original = item ? originalStartOf(item) : null;
      if (original === null) throw calendarError('not_found', t('errors.calendar.notFound'));
    }
    return { ms: original, wall: allDay ? { date: dayKey(new Date(original)), minutes: 0 } : wall(original, zone) };
  }

  // The occurrences Google keeps of their own: changed, or deleted.
  async exceptions(cal, master) {
    const items = await this.pages(this.eventsPath(cal), { iCalUID: master.iCalUID, showDeleted: 'true' });
    return items.filter((i) => i && i.recurringEventId === master.id && i.originalStartTime);
  }

  // The ones at or after the split.
  async laterExceptions(cal, master, split, zone) {
    return (await this.exceptions(cal, master)).filter((i) => wallDelta(split, originalWall(i, zone)) >= 0);
  }

  // Ends the series just before the split: UNTIL one second before the split occurrence (the day before, for all-day
  // series) in place of any COUNT or earlier UNTIL, and the EXDATEs from then on dropped.
  cutRecurrence(master, split, splitMs, zone, allDay) {
    const lines = master.recurrence || [];
    const until = allDay ? basicDate(addDays(split.date, -1)) : basicUtc(splitMs - 1000);
    const rules = lines.filter(isRule).map((l) => {
      const parts = ruleParts(l.slice(6));
      setPart(parts, 'COUNT', null);
      setPart(parts, 'UNTIL', until);
      return `RRULE:${ruleText(parts)}`;
    });
    return [...rules, ...splitLines(lines.filter((l) => !isRule(l)), split, zone, allDay, 0).before];
  }

  // The last step of a cut: the master ends before the split, on the version the user saw.
  cut(cal, master, split, { zone, allDay, sendUpdates, seriesEtag }) {
    return this.request('PATCH', this.eventPath(cal, master.id), {
      query: { sendUpdates, conferenceDataVersion: 1 },
      body: { recurrence: this.cutRecurrence(master, split.wall, split.ms, zone, allDay) },
      etag: seriesEtag || master.etag
    });
  }

  // After a cut that may have been made without an answer saying so: whether the series as Google has it now ends
  // before the split (true), still runs past it (false), or can't be told (null: no answer again, or the series is
  // gone or no longer repeats).
  async cutHeld(cal, master, split, { zone, allDay, first }) {
    try {
      const now = await this.request('GET', this.eventPath(cal, master.id));
      if (!now || now.status === 'cancelled' || !Array.isArray(now.recurrence)) return null;
      return endsBefore(now.recurrence, first, split, zone, allDay);
    } catch (_) {
      return null;
    }
  }

  // Deletes the occurrences the cut series kept of their own after its new end, so they don't show next to the new
  // series. Guests aren't told: they hear about the new series and the cut one already.
  async dropLater(cal, later) {
    for (const item of later) {
      if (item.status === 'cancelled') continue;
      await this.request('DELETE', this.eventPath(cal, item.id), { query: { sendUpdates: 'none' } }).catch(() => {});
    }
  }

  // "This and following": the series is cut before the opened occurrence and a new series starts with the change.
  // The new one is made first, with an id that a retry repeats, and gets the old series' Meet, reminders, guests and
  // private properties, the rest of its COUNT and its UNTIL, and the deleted and changed occurrences from the split on.
  // Only then is the old one cut, on the version the user saw; when Google refuses that, the new one is deleted again.
  // Without a rule ("stop repeating" from here on) the new half is one event: the opened occurrence as it is, with the
  // change. Then it is returned; a new series isn't (the store finds its occurrence after the refetch).
  async split(cal, event, input, { notify = false, seriesEtag = null } = {}) {
    const master = await this.master(cal, event, seriesEtag);
    const zone = this.zoneOf(master, cal);
    const allDay = Boolean(master.start.date);
    const split = await this.splitPoint(cal, event, zone, allDay);
    const first = allDay ? { date: master.start.date, minutes: 0 } : wall(Date.parse(master.start.dateTime), zone);
    if (wallDelta(first, split.wall) <= 0) return this.updateSeries(cal, event, input, { notify, seriesEtag });
    const sendUpdates = notify ? 'all' : 'none';
    const later = await this.laterExceptions(cal, master, split.wall, zone);
    const moved = movedTimes(event, input);
    const changes = this.fieldChanges(master, event, input);
    const lines = master.recurrence || [];
    const repeats = typeof input.recurrence === 'string' || (input.recurrence !== null && lines.some(isRule));
    // The opened occurrence's own title, guests and so on, when it was changed before and becomes the one event.
    const own = repeats ? null : later.find((i) => i.id === event.eventId && i.status !== 'cancelled') || null;

    // The new series starts at the edited occurrence's new time, or where the occurrence belongs when only other
    // fields changed (a moved occurrence then stays an exception of the new series). One event keeps the occurrence's
    // own times.
    const durationDays = allDay ? daysBetween(master.start.date, master.end.date) : 0;
    const mins = allDay ? 0 : wallDelta(wall(Date.parse(master.start.dateTime), zone), wall(Date.parse(master.end.dateTime), (master.end && master.end.timeZone) || zone));
    // The zone the new series repeats in: the one the user picked when the times changed. Its start, rule, EXDATEs and
    // copied occurrences are read on that clock, so a zone that puts the start on another date takes the weekday along.
    const newZone = (moved || !repeats) && !input.allDay ? input.timeZone || zone : zone;
    let startTimes;
    let newStart;
    if (moved || !repeats) {
      startTimes = times(input, input.timeZone || zone, { endTimeZone: input.timeZone || (master.end && master.end.timeZone) || zone });
      newStart = input.allDay ? { date: input.startDate, minutes: 0 } : wall(input.start, newZone);
    } else if (allDay) {
      startTimes = { start: { date: split.wall.date }, end: { date: addDays(split.wall.date, durationDays) } };
      newStart = split.wall;
    } else {
      const end = instantOf(shifted(split.wall, mins), zone);
      startTimes = { start: { dateTime: new Date(split.ms).toISOString(), timeZone: zone }, end: { dateTime: new Date(end).toISOString(), timeZone: (master.end && master.end.timeZone) || zone } };
      newStart = split.wall;
    }
    const newAllDay = Boolean(startTimes.start.date);
    const shift = wallDelta(split.wall, newStart);
    const rules = [];
    if (typeof input.recurrence === 'string') rules.push(input.recurrence);
    else if (input.recurrence !== null) {
      for (const line of lines.filter(isRule)) {
        const parts = ruleParts(moveRule(line.slice(6), split.wall.date, newStart.date));
        const count = rulePart(parts, 'COUNT');
        if (count) setPart(parts, 'COUNT', String(Math.max(1, Number(count) - countBefore(line.slice(6), first, split.wall, allDay))));
        rules.push(ruleText(parts));
      }
    }
    const { after } = splitLines(lines.filter((l) => !isRule(l)), split.wall, zone, newAllDay, shift, newZone);
    // Deleted occurrences from the split on become EXDATEs of the new series, where its rule puts them now.
    const gone = later.filter((i) => i.status === 'cancelled').map((i) => shifted(originalWall(i, zone), shift));
    if (gone.length && rules.length) after.push(dateLine('EXDATE', gone, newZone, newAllDay));

    const id = splitId(master.id, split.ms, !repeats);
    const kept = {};
    if (own) for (const k of OWN_FIELDS) if (k in own && JSON.stringify(own[k]) !== JSON.stringify(master[k])) kept[k] = own[k];
    const body = { id, ...pick(master, COPIED), ...startTimes, ...kept, ...changes };
    if (rules.length) body.recurrence = [...rules.map((r) => `RRULE:${r}`), ...after];
    if (hasGuests(input.guests)) body.attendees = await this.guestList(cal, (own || master).id, input.guests, own || master);
    // The same meeting link, without a request for a new one.
    if (master.conferenceData && !('conferenceData' in changes)) body.conferenceData = copyConference(master.conferenceData);
    if (body.conferenceData && body.conferenceData.createRequest) body.conferenceData.createRequest.requestId = id;
    let made;
    try {
      made = await this.request('POST', this.eventsPath(cal), { query: { sendUpdates, conferenceDataVersion: 1 }, body });
    } catch (err) {
      if (err.code !== 'conflict') throw err;
      // Made by an earlier try whose answer got lost, or deleted again after one that failed later on.
      const { id: _, ...rest } = body;
      made = await this.request('PATCH', this.eventPath(cal, id), { query: { sendUpdates, conferenceDataVersion: 1 }, body: { ...rest, status: 'confirmed' } });
    }
    // A series changed elsewhere in the meantime says so, as CalDAV does; anything else says the split was taken back.
    const undo = async (err) => {
      try {
        await this.request('DELETE', this.eventPath(cal, made.id), { query: { sendUpdates } });
      } catch (_) {
        // Both halves are in the calendar now; the store's refetch shows them, and the error says what went wrong.
        throw err;
      }
      if (err && err.code === 'changed') throw err;
      throw calendarError('split_failed', t('errors.calendar.splitFailed'), { cause: err && err.code });
    };
    try {
      // One event has no occurrences to copy them to; the later ones go with the cut series below.
      if (repeats) await this.copyExceptions(cal, master, made, later, { event, input, moved, shift, zone, newZone });
    } catch (err) {
      await undo(err);
    }
    try {
      await this.cut(cal, master, split, { zone, allDay, sendUpdates, seriesEtag });
    } catch (err) {
      // A cut without an answer, or with a server error, may have been made all the same, and then deleting the new
      // series would take every occurrence from the split on with it. So the old series is read again: a cut that
      // was made finishes the split, and the new one only goes when the old one still runs past the split. When
      // that can't be told, both stay; the error says what went wrong, and a sync shows how the calendar is.
      const held = maybeWritten(err) ? await this.cutHeld(cal, master, split, { zone, allDay, first }) : false;
      if (held === null) throw calendarError('unsure', t('errors.calendar.splitUnsure'), { partial: true, reason: err.code || null });
      if (!held) await undo(err);
    }
    await this.dropLater(cal, later);
    return repeats ? null : toEvent(made, cal);
  }

  // The occurrences the old series changed on their own from the split on, changed the same way in the new series.
  // Their own fields go over; fields the user just changed for the whole new series don't, and neither do the times of
  // the edited occurrence when those are the new series' start.
  async copyExceptions(cal, master, made, later, { event, input, moved, shift, zone, newZone = zone }) {
    for (const item of later) {
      if (item.status === 'cancelled') continue;
      const edited = item.id === event.eventId;
      if (edited && moved) continue;
      const body = {};
      for (const k of OWN_FIELDS) if (k in item && JSON.stringify(item[k]) !== JSON.stringify(master[k])) body[k] = item[k];
      if (edited) for (const k of Object.keys(this.fieldChanges(master, event, input))) delete body[k];
      const original = originalWall(item, zone);
      if (!sameTime(item.start, item.originalStartTime)) Object.assign(body, { start: item.start, end: item.end });
      if (!Object.keys(body).length) continue;
      const at = shifted(original, shift);
      const originalStart = item.originalStartTime.date ? at.date : new Date(instantOf(at, newZone)).toISOString();
      const page = await this.request('GET', `${this.eventPath(cal, made.id)}/instances`, { query: { originalStart, showDeleted: 'true' } });
      const instance = ((page && page.items) || [])[0];
      if (!instance) continue;
      // An earlier try that was taken back left it deleted.
      if (instance.status === 'cancelled') body.status = 'confirmed';
      await this.request('PATCH', this.eventPath(cal, instance.id), { query: { sendUpdates: 'none', conferenceDataVersion: 1 }, body });
    }
  }

  // scope 'all' deletes the series; 'following' cuts it before this occurrence, which at its first occurrence is the
  // same. seriesEtag: the series' version the user saw; without one, Google deletes whatever version it has.
  async remove(cal, event, { notify = false, scope, series = false, etag = null, seriesEtag = null } = {}) {
    const which = scope || (series ? 'all' : 'one');
    const sendUpdates = notify ? 'all' : 'none';
    if (!event.seriesId || which === 'one') {
      await this.request('DELETE', this.eventPath(cal, event.eventId), { query: { sendUpdates }, etag });
      return;
    }
    if (which === 'all') {
      await this.request('DELETE', this.eventPath(cal, event.seriesId), { query: { sendUpdates }, etag: seriesEtag });
      return;
    }
    const master = await this.master(cal, event, seriesEtag);
    const zone = this.zoneOf(master, cal);
    const allDay = Boolean(master.start.date);
    const split = await this.splitPoint(cal, event, zone, allDay);
    const first = allDay ? { date: master.start.date, minutes: 0 } : wall(Date.parse(master.start.dateTime), zone);
    if (wallDelta(first, split.wall) <= 0) {
      await this.request('DELETE', this.eventPath(cal, master.id), { query: { sendUpdates }, etag: seriesEtag || master.etag });
      return;
    }
    const later = await this.laterExceptions(cal, master, split.wall, zone);
    try {
      await this.cut(cal, master, split, { zone, allDay, sendUpdates, seriesEtag });
    } catch (err) {
      // A cut whose answer got lost may have been made: then the deletion is done, as asked.
      const held = maybeWritten(err) ? await this.cutHeld(cal, master, split, { zone, allDay, first }) : false;
      if (held === null) throw calendarError('unsure', t('errors.calendar.splitUnsure'), { partial: true, reason: err.code || null });
      if (!held) throw err;
    }
    await this.dropLater(cal, later);
  }

  // An answer to an invitation: only the user's own entry, with attendeesOmitted, which tells Google the list is
  // partial. Sending the whole list back would overwrite answers other guests gave in the meantime, and drop the
  // guests Google left out of a long list. The organizer is told, as Google Calendar does.
  async respond(cal, event, response, { series = false } = {}) {
    const id = series && event.seriesId ? event.seriesId : event.eventId;
    const item = await this.request('GET', this.eventPath(cal, id));
    const me = (item.attendees || []).find((a) => a.self);
    if (!me) throw calendarError('not_invited', t('errors.calendar.notInvited'));
    const body = { attendeesOmitted: true, attendees: [{ ...me, responseStatus: response }] };
    await this.request('PATCH', this.eventPath(cal, id), { query: { sendUpdates: 'all', conferenceDataVersion: 1 }, body });
  }

  // The series the occurrence belongs to: its rule, its other recurrence lines as they are, and its version.
  async series(cal, event) {
    if (!event.seriesId) throw calendarError('not_found', t('errors.calendar.notFound'));
    const item = await this.master(cal, event);
    const zone = this.zoneOf(item, cal);
    const lines = item.recurrence || [];
    const rules = lines.filter(isRule).map((l) => l.slice(6));
    const extra = lines.filter((l) => !isRule(l));
    const exdates = extra
      .map((l) => lineDates(l, zone))
      .filter((d) => d && d.kind === 'EXDATE')
      .flatMap((d) => d.values.map((v) => (v.at === null ? localDay(v.date) : v.at)));
    const e = toEvent(item, cal);
    return { rule: rules[0] || null, rules, extra, exdates, start: e.start, end: e.end, allDay: e.allDay, startDate: e.startDate, endDate: e.endDate, timeZone: e.timeZone, etag: e.etag };
  }

  // Moves the event, or for an occurrence its whole series (Google can't move one occurrence), to another calendar.
  async move(cal, event, toCal, { notify = false } = {}) {
    const id = event.seriesId || event.eventId;
    const item = await this.request('POST', `${this.eventPath(cal, id)}/move`, { query: { destination: toCal.id, sendUpdates: notify ? 'all' : 'none' } });
    return toEvent(item, toCal);
  }
}

// Working locations ("Home", "Office") are a status in Google Calendar, not something on the schedule.
const shown = (i) => i && i.status !== 'cancelled' && i.eventType !== 'workingLocation' && i.start;

const meetRequest = (requestId) => ({ createRequest: { requestId: String(requestId || crypto.randomUUID()), conferenceSolutionKey: { type: 'hangoutsMeet' } } });

// A conference copied to another event: the same meeting, never a request for a new one.
function copyConference(cd) {
  const out = {};
  for (const k of ['conferenceId', 'conferenceSolution', 'entryPoints', 'notes', 'parameters', 'signature']) if (cd[k] !== undefined) out[k] = cd[k];
  return out;
}

function pick(item, keys) {
  const out = {};
  for (const k of keys) if (item[k] !== undefined) out[k] = JSON.parse(JSON.stringify(item[k]));
  return out;
}

// Whether the user changed the occurrence's times, its zone or all-day.
function movedTimes(event, input) {
  if (input.allDay !== event.allDay) return true;
  if (input.timeZone !== undefined && input.timeZone !== event.timeZone) return true;
  return input.allDay ? input.startDate !== event.startDate || input.endDate !== event.endDate : input.start !== event.start || input.end !== event.end;
}

// The same for its start only: a longer or shorter event leaves every occurrence where it starts.
function movedStart(event, input) {
  if (input.allDay !== event.allDay) return true;
  if (input.timeZone !== undefined && input.timeZone !== event.timeZone) return true;
  return input.allDay ? input.startDate !== event.startDate : input.start !== event.start;
}

function originalWall(item, zone) {
  const o = item.originalStartTime;
  return o.date ? { date: o.date, minutes: 0 } : wall(Date.parse(o.dateTime), zone);
}

function sameTime(a, b) {
  if (!a || !b) return true;
  return a.date ? a.date === b.date : Date.parse(a.dateTime) === Date.parse(b.dateTime);
}

module.exports = {
  GoogleCalendar,
  toEvent,
  apiError,
  calendarError,
  maybeWritten,
  dayKey,
  localDay,
  plainDescription,
  hexColor,
  moveRule,
  countBefore,
  shiftLines,
  splitId,
  hasGuests,
  applyGuests
};
