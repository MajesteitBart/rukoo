'use strict';

// What a window may send to the calendar calls in main.js, checked before the store sees it. Today's event fields keep
// their old coercion; the newer ones stay undefined when they are missing or don't fit, which tells the store to leave
// them as they are (or take the provider's default on a new event). They never get a default here. The store checks
// their contents again. A booking id or uid is never read from a window: only the booking service makes booking events.

const DAY = 86400000;
const VISIBILITIES = ['default', 'public', 'private', 'confidential'];

const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const isPlain = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const shortText = (v, max) => typeof v === 'string' && v.length <= max;

function calendarRange(range) {
  const { start, end } = plainObject(range);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 400 * DAY) throw new Error('invalid');
  return { start, end };
}

function calendarInput(input) {
  const i = plainObject(input);
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    accountId: text(i.accountId, 200),
    calendarId: text(i.calendarId, 1000),
    title: text(i.title, 1000),
    location: text(i.location, 1000),
    description: text(i.description, 20000),
    allDay: i.allDay === true,
    start: Number(i.start),
    end: Number(i.end),
    startDate: text(i.startDate, 10),
    endDate: text(i.endDate, 10),
    id: text(i.id, 1024),
    timeZone: shortText(i.timeZone, 64) ? i.timeZone : undefined,
    guests: calendarGuests(i.guests),
    recurrence: i.recurrence === null ? null : shortText(i.recurrence, 500) ? i.recurrence : undefined,
    reminders: calendarReminders(i.reminders),
    busy: typeof i.busy === 'boolean' ? i.busy : undefined,
    visibility: VISIBILITIES.includes(i.visibility) ? i.visibility : undefined,
    addMeet: typeof i.addMeet === 'boolean' ? i.addMeet : undefined
  };
}

// A guest diff: added guests, removed addresses and optional flags. One part that doesn't fit drops the whole diff.
function calendarGuests(g) {
  if (!isPlain(g)) return undefined;
  const out = {};
  if (g.add !== undefined) {
    const ok = Array.isArray(g.add) && g.add.length <= 100 && g.add.every((a) => isPlain(a) && shortText(a.address, 320) && (a.name === undefined || shortText(a.name, 200)) && (a.optional === undefined || typeof a.optional === 'boolean'));
    if (!ok) return undefined;
    out.add = g.add.map((a) => ({ address: a.address, name: a.name || '', optional: a.optional === true }));
  }
  if (g.remove !== undefined) {
    if (!Array.isArray(g.remove) || g.remove.length > 100 || !g.remove.every((a) => shortText(a, 320))) return undefined;
    out.remove = [...g.remove];
  }
  if (g.optional !== undefined) {
    if (!isPlain(g.optional) || Object.keys(g.optional).length > 100 || !Object.entries(g.optional).every(([k, v]) => k.length <= 320 && typeof v === 'boolean')) return undefined;
    out.optional = { ...g.optional };
  }
  return out;
}

function calendarReminders(r) {
  if (!isPlain(r) || typeof r.useDefault !== 'boolean' || !Array.isArray(r.overrides) || r.overrides.length > 5) return undefined;
  const ok = r.overrides.every((o) => isPlain(o) && (o.method === 'popup' || o.method === 'email') && Number.isInteger(o.minutes) && o.minutes >= -1439 && o.minutes <= 40320);
  return ok ? { useDefault: r.useDefault, overrides: r.overrides.map((o) => ({ method: o.method, minutes: o.minutes })) } : undefined;
}

// Which occurrences of a series a change or deletion is for.
function calendarScope(opts) {
  const scope = plainObject(opts).scope;
  return scope === 'following' || scope === 'all' ? scope : 'one';
}

// The version of the event the user saw; Google's etags are short quoted strings.
function calendarEtag(opts) {
  const etag = plainObject(opts).etag;
  return typeof etag === 'string' && etag && etag.length <= 200 ? etag : null;
}

function calendarSeriesEtag(opts) {
  const etag = plainObject(opts).seriesEtag;
  return typeof etag === 'string' && etag && etag.length <= 200 ? etag : null;
}

function calendarEventId(id) {
  if (typeof id !== 'string' || !id || id.length > 3000) throw new Error('invalid');
  return id;
}

function calendarCalendarId(id) {
  if (typeof id !== 'string' || !id || id.length > 1000) throw new Error('invalid');
  return id;
}

// The conflict line asks about at most a month, leaving out the event being edited.
function calendarConflicts(opts) {
  const o = plainObject(opts);
  const { start, end } = calendarRange(o);
  if (end - start > 31 * DAY) throw new Error('invalid');
  const exclude = (Array.isArray(o.exclude) ? o.exclude.slice(0, 20) : []).filter((id) => typeof id === 'string' && id && id.length <= 3000);
  return { start, end, exclude };
}

// Free time; free() checks the range and length itself.
function calendarFreeOpts(opts) {
  const o = plainObject(opts);
  return {
    start: Number(o.start),
    end: Number(o.end),
    length: Number(o.length),
    hours: ['booking', 'working', 'any'].includes(o.hours) ? o.hours : 'working',
    timeZone: shortText(o.timeZone, 64) ? o.timeZone : undefined,
    locale: o.locale === 'en' || o.locale === 'nl' ? o.locale : undefined,
    hour12: typeof o.hour12 === 'boolean' ? o.hour12 : undefined
  };
}

module.exports = {
  calendarRange,
  calendarInput,
  calendarGuests,
  calendarReminders,
  calendarScope,
  calendarEtag,
  calendarSeriesEtag,
  calendarEventId,
  calendarCalendarId,
  calendarConflicts,
  calendarFreeOpts
};
