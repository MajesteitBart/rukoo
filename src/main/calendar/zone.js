'use strict';

// Wall-clock math in named time zones, for free time, booking hours, reminders and all-day events. A date is
// 'YYYY-MM-DD', a time 'HH:MM' and a zone an IANA name such as 'Europe/Amsterdam' (or 'UTC'). The offsets come from
// the zone data built into Node (Intl), so a clock change lands where the PC's own clock would put it.

const DAY = 86400000;
// An IANA name: letters first, then parts split by slashes. Intl also takes offsets such as '+01:00', which aren't
// zones a calendar can store.
const NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const MAX_NAME = 64;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

const pad = (n, width = 2) => String(n).padStart(width, '0');

const formatters = new Map();
// A formatter that reads the clock in a zone, to the second. Throws a RangeError for a name that isn't a zone.
function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (f) return f;
  if (typeof timeZone !== 'string' || timeZone.length > MAX_NAME || !NAME.test(timeZone)) throw new RangeError(`Invalid time zone: ${timeZone}`);
  f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  // Names differ only in case ('europe/amsterdam'), so the cache stays small unless something feeds it junk.
  if (formatters.size >= 1000) formatters.clear();
  formatters.set(timeZone, f);
  return f;
}

// Milliseconds for a clock reading taken as UTC. Unlike Date.UTC, years 0 to 99 stay themselves.
function utc(year, month, day, hour = 0, minute = 0, second = 0) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

// How far the zone's clock is ahead of UTC at a moment, in milliseconds (whole seconds).
function offsetAt(f, ms) {
  const v = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') v[p.type] = p.value;
  const year = /^B/.test(v.era) ? 1 - Number(v.year) : Number(v.year);
  return utc(year, Number(v.month), Number(v.day), Number(v.hour) % 24, Number(v.minute), Number(v.second)) - Math.floor(ms / 1000) * 1000;
}

function parseDate(date) {
  const m = DATE.exec(typeof date === 'string' ? date : '');
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // setUTCFullYear rolls 2026-02-30 over into March; reading the same day back means the date exists.
    const ms = utc(y, mo, d);
    if (mo >= 1 && mo <= 12 && new Date(ms).getUTCDate() === d) return ms;
  }
  throw new RangeError(`Invalid date: ${date}`);
}

// Minutes since midnight; '24:00' is the end of the day.
function parseTime(time) {
  const m = TIME.exec(typeof time === 'string' ? time : '');
  if (m) {
    const [h, mi] = [Number(m[1]), Number(m[2])];
    if ((h < 24 && mi < 60) || (h === 24 && mi === 0)) return h * 60 + mi;
  }
  throw new RangeError(`Invalid time: ${time}`);
}

// A UTC clock reading as 'YYYY-MM-DD'.
function dateText(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return `${y < 0 ? '-' + pad(-y, 4) : pad(y, 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// The date, time, weekday and offset (minutes east of UTC) a zone's clock shows at a moment. Seconds are dropped.
function zonedParts(ms, timeZone) {
  const f = formatter(timeZone);
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new RangeError(`Invalid time value: ${ms}`);
  const offset = offsetAt(f, ms);
  const local = new Date(ms + offset);
  return {
    date: dateText(local.getTime()),
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
    weekday: local.getUTCDay(),
    offset: Math.round(offset / 60000)
  };
}

// The moment a zone's clock shows a date and time. A time the clock skips (02:30 when it jumps from 02:00 to 03:00)
// moves forward by the jump, to 03:30, as RFC 5545 and Google read it. A time the clock shows twice (when it goes
// back) is its first instance. '24:00' is 00:00 of the next day.
function zonedInstant(date, time, timeZone) {
  const f = formatter(timeZone);
  const wall = parseDate(date) + parseTime(time) * 60000;
  // The offsets a day either side; a clock change between them makes them differ.
  const before = offsetAt(f, wall - DAY);
  const after = offsetAt(f, wall + DAY);
  // The larger offset gives the earlier moment, so it is tried first.
  for (const t of [wall - Math.max(before, after), wall - Math.min(before, after)]) {
    if (t + offsetAt(f, t) === wall) return t;
  }
  // Skipped: read the time with the offset from before the jump, which lands as far past the jump as the time was.
  return wall - before;
}

function addDays(date, n) {
  if (!Number.isInteger(n)) throw new RangeError(`Invalid number of days: ${n}`);
  return dateText(parseDate(date) + n * DAY);
}

// 0 Sunday to 6 Saturday, for the calendar date itself (no zone involved).
function weekday(date) {
  return new Date(parseDate(date)).getUTCDay();
}

function isZone(text) {
  try {
    formatter(text);
    return true;
  } catch (_) {
    return false;
  }
}

// The PC's own zone, or 'UTC' when the system doesn't name one Intl knows.
function pcZone() {
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isZone(zone) ? zone : 'UTC';
}

module.exports = { zonedParts, zonedInstant, addDays, weekday, isZone, pcZone };
