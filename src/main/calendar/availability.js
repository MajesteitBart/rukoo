'use strict';

// Open and free time as lists of half-open [start, end) intervals in ms. Hours are wall-clock ranges per weekday in a
// zone ('09:00' to '17:00'); the zone helpers turn each date's ranges into moments, so a clock change shortens or
// lengthens that day the way the zone's own clock does. free.js and the booking publisher build on this; booking
// slots themselves are made on the server.

const { zonedParts, zonedInstant, addDays, weekday, isZone } = require('./zone');

const DAY = 86400000;
const MINUTE = 60000;
// A span longer than this is a bug in the caller, not a question anyone asks; it would only make the loop run long.
const MAX_DAYS = 3660;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const WORK = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

// One day's ranges: [start, end] pairs of 'HH:MM', each ending after it starts and by '24:00', sorted and not
// overlapping (touching is fine). A range past midnight ('22:00' to '02:00') isn't one: split it over two days.
function isRanges(ranges) {
  if (!Array.isArray(ranges)) return false;
  let last = '00:00';
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !TIME.test(r[0]) || !TIME.test(r[1])) return false;
    // 'HH:MM' strings compare like the times they name.
    if (!(r[0] < r[1]) || r[0] < last) return false;
    last = r[1];
  }
  return true;
}

// Seven days of ranges, Sunday first.
function isWeekly(weekly) {
  return Array.isArray(weekly) && weekly.length === 7 && weekly.every(isRanges);
}

function checkSpan(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new RangeError(`Invalid range: ${from} to ${to}`);
  if (to - from > MAX_DAYS * DAY) throw new RangeError('The range is too long');
}

function checkInterval(i) {
  if (!Array.isArray(i) || !Number.isFinite(i[0]) || !Number.isFinite(i[1])) throw new RangeError(`Invalid interval: ${i}`);
}

// Sorted, with overlapping and touching intervals joined and empty ones left out. Never changes its argument.
function merge(list) {
  if (!Array.isArray(list)) throw new RangeError('Intervals must be a list');
  for (const i of list) checkInterval(i);
  const sorted = list.filter((i) => i[0] < i[1]).map((i) => [i[0], i[1]]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const i of sorted) {
    const prev = out[out.length - 1];
    if (prev && i[0] <= prev[1]) prev[1] = Math.max(prev[1], i[1]);
    else out.push(i);
  }
  return out;
}

// The time in a that isn't in b.
function subtract(a, b) {
  const cut = merge(b);
  const out = [];
  let j = 0;
  for (const [start, end] of merge(a)) {
    let s = start;
    // Both lists are sorted, so a cut that ends before this interval also ends before every later one.
    while (j < cut.length && cut[j][1] <= s) j++;
    for (let k = j; k < cut.length && cut[k][0] < end && s < end; k++) {
      if (cut[k][0] > s) out.push([s, cut[k][0]]);
      s = Math.max(s, cut[k][1]);
    }
    if (s < end) out.push([s, end]);
  }
  return out;
}

// The time in both a and b.
function intersect(a, b) {
  const x = merge(a);
  const y = merge(b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const s = Math.max(x[i][0], y[j][0]);
    const e = Math.min(x[i][1], y[j][1]);
    if (s < e) out.push([s, e]);
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return out;
}

// The open hours between from and to as moments, clipped to [from, to) and merged. An override replaces a date's
// weekly ranges; [] blocks the date. Times follow zonedInstant: a time the clock skips moves forward by the jump, a
// time it shows twice is its first instance, '24:00' is the next day's start. Ranges of adjacent days that meet
// (Monday to '24:00', Tuesday from '00:00') come back as one interval.
function openWindows({ weekly, overrides = {}, timeZone, from, to } = {}) {
  if (!isWeekly(weekly)) throw new RangeError('Invalid weekly hours');
  if (overrides !== null && typeof overrides !== 'object') throw new RangeError('Invalid date overrides');
  if (!isZone(timeZone)) throw new RangeError(`Invalid time zone: ${timeZone}`);
  checkSpan(from, to);
  if (to <= from) return [];
  const out = [];
  const last = zonedParts(to, timeZone).date;
  // A range of one date ends by the next date's start, so the date before from's can't reach it; it is read anyway,
  // because it costs one day and needs no argument about zones whose midnight is skipped.
  for (let date = addDays(zonedParts(from, timeZone).date, -1); date <= last; date = addDays(date, 1)) {
    const ranges = own(overrides, date) ? overrides[date] : weekly[weekday(date)];
    if (!isRanges(ranges)) throw new RangeError(`Invalid hours for ${date}`);
    for (const [s, e] of ranges) {
      const start = Math.max(zonedInstant(date, s, timeZone), from);
      const end = Math.min(zonedInstant(date, e, timeZone), to);
      // A range inside a skipped hour can end up empty or reversed; it has no time that day.
      if (start < end) out.push([start, end]);
    }
  }
  return merge(out);
}

// Open time that no busy interval touches, in pieces of at least minLength ms.
function freeWindows({ open, busy = [], minLength = 0 } = {}) {
  if (!Number.isFinite(minLength) || minLength < 0) throw new RangeError(`Invalid length: ${minLength}`);
  return subtract(open, busy).filter(([s, e]) => e - s >= minLength);
}

// The clock a locale uses, or the one hour12 asks for: 'h11' and 'h12' are 12-hour clocks.
function hourCycle(locale, hour12) {
  const o = { hour: 'numeric' };
  if (typeof hour12 === 'boolean') o.hour12 = hour12;
  return new Intl.DateTimeFormat(locale, o).resolvedOptions().hourCycle || 'h23';
}

// Free time as text, one line per day in the zone: 'Tue 3 Nov: 10:00–11:30, 14:00–15:00' (en-GB), with the day and
// the times in the locale's own form. A window past midnight is split over its days; an end at the day's end reads
// '24:00' (or '12:00 AM' on a 12-hour clock). Starts round up and ends round down to the minute, so the text never
// offers a second that isn't free.
function formatFreeTimes(windows, { locale, timeZone, hour12 } = {}) {
  if (!isZone(timeZone)) throw new RangeError(`Invalid time zone: ${timeZone}`);
  const cycle = hourCycle(locale, hour12);
  const twelve = cycle === 'h11' || cycle === 'h12';
  // 24-hour clocks read '09:00', as the rest of Rukoo shows times; 12-hour clocks '9:00 AM'.
  const clock = { hour: twelve ? 'numeric' : '2-digit', minute: '2-digit', hourCycle: twelve ? cycle : 'h23' };
  const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  const time = new Intl.DateTimeFormat(locale, { ...clock, timeZone });
  // The end of a day: midnight on a clock that counts to 24, or the locale's own midnight on a 12-hour clock.
  const dayEnd = new Intl.DateTimeFormat(locale, { ...clock, timeZone: 'UTC', hourCycle: twelve ? cycle : 'h24' }).format(0);
  // Newer ICU puts a narrow no-break space before AM/PM; plain text in mail and agent replies reads better with a space.
  const plain = (s) => s.replace(/[  ]/g, ' ');
  const dash = twelve ? ' – ' : '–';
  const days = new Map();
  for (const [from, to] of merge(windows)) {
    let s = Math.ceil(from / MINUTE) * MINUTE;
    const e = Math.floor(to / MINUTE) * MINUTE;
    while (s < e) {
      const date = zonedParts(s, timeZone).date;
      const next = zonedInstant(addDays(date, 1), '00:00', timeZone);
      const end = next > s ? Math.min(e, next) : e;
      if (!days.has(date)) days.set(date, { label: plain(day.format(s)), parts: [] });
      days.get(date).parts.push(plain(time.format(s)) + dash + plain(end === next ? dayEnd : time.format(end)));
      s = end;
    }
  }
  return [...days.values()].map((d) => `${d.label}: ${d.parts.join(', ')}`);
}

// Working hours from settings.calendar as weekly ranges: the work days get [workStart, workEnd], the others nothing.
// Settings that don't make a valid range fall back to the defaults (Monday to Friday, 09:00 to 17:00).
function workWeekly(calendar) {
  const c = calendar && typeof calendar === 'object' ? calendar : {};
  const days = Array.isArray(c.workDays) ? c.workDays : WORK.days;
  const range = isRanges([[c.workStart, c.workEnd]]) ? [c.workStart, c.workEnd] : [WORK.start, WORK.end];
  return Array.from({ length: 7 }, (_, d) => (days.includes(d) ? [[range[0], range[1]]] : []));
}

module.exports = { openWindows, merge, subtract, intersect, freeWindows, formatFreeTimes, workWeekly, isRanges, isWeekly };
