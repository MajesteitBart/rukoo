'use strict';

// Time zone definitions (VTIMEZONE, RFC 5545 3.6.5) for the zones Rukoo writes event times in. A calendar object that
// names a zone (DTSTART;TZID=Europe/Amsterdam:…) has to define it, and readers use that definition rather than their
// own zone data, so it has to give the same offsets as the PC's zone data (Intl) for every time the object holds.
//
// A zone that changes its clocks by a rule gets one DAYLIGHT and one STANDARD observance with a yearly RRULE (month,
// nth or last weekday, local time), as Google, Apple and Outlook write them, so an open-ended series stays right after
// any end Rukoo could probe to. The rule is derived from this and next year's clock changes and checked against the
// zone data for 20 years; a zone that doesn't fit one (Israel, Chile, Morocco) gets every change as an RDATE instead,
// up to the series' end but no more than 20 years ahead, after which the last offset carries on. A zone without clock
// changes gets a single STANDARD. Every observance starts at or before the earliest time it has to cover: before its
// first change a reader has no offset at all (ical.js uses 0).
const ICAL = require('ical.js');
const { zonedParts } = require('./zone');

const DAY = 86400000;
const YEAR = 365.2425 * DAY;
// How far ahead a rule is checked, or clock changes are listed, when nothing ends the series sooner. A series that
// ends later (UNTIL in 9999) is probed no further: every year costs a scan of the zone data.
const AHEAD = 20 * YEAR;
// Clock changes before this aren't looked for, for the same reason: an earlier time gets the offset of 1900.
const FIRST = Date.UTC(1900, 0, 1);
// Clock changes are looked for at this step, then pinned to the minute. Two changes closer than this (that cancel
// each other out) would be missed; no zone has had those.
const STEP = 2 * DAY;
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const pad = (n, width = 2) => String(n).padStart(width, '0');

const offsetAt = (ms, tzid) => zonedParts(ms, tzid).offset;

// A clock reading taken as UTC (the same trick zone.js uses) as its parts.
function parts(wall) {
  const d = new Date(wall);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
}

const local = (wall) => {
  const p = parts(wall);
  return `${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}T${pad(p.hour)}${pad(p.minute)}00`;
};

const utcOffset = (minutes) => `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// ---------- clock changes ----------

const years = new Map();

// The clock changes of one UTC year: { at, from, to }, at the moment of the change, offsets in minutes east of UTC.
function changesIn(tzid, year) {
  const key = `${tzid}\n${year}`;
  if (years.has(key)) return years.get(key);
  const out = [];
  const end = Date.UTC(year + 1, 0, 1);
  let t = Date.UTC(year, 0, 1);
  let off = offsetAt(t, tzid);
  while (t < end) {
    const next = Math.min(t + STEP, end);
    const o = offsetAt(next, tzid);
    if (o !== off) {
      // The first minute with the new offset. Offsets and local change times are whole minutes, so the moment is too.
      let lo = t;
      let hi = next;
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
        if (offsetAt(mid, tzid) === off) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, from: off, to: offsetAt(hi, tzid) });
      off = offsetAt(hi, tzid);
      t = hi;
    } else {
      t = next;
    }
  }
  if (years.size > 2000) years.clear();
  years.set(key, out);
  return out;
}

function changes(tzid, start, end) {
  const out = [];
  for (let y = new Date(start).getUTCFullYear(); y <= new Date(end).getUTCFullYear(); y++) out.push(...changesIn(tzid, y));
  return out.filter((c) => c.at >= start && c.at < end);
}

// The wall clock a change happens at, on the clock before it (as VTIMEZONE writes DTSTART and RDATE).
const onsetWall = (c) => c.at + c.from * 60000;

// ---------- yearly rules ----------

// How a change's day can be named as a rule: its month, weekday, time and which weekday of the month it is (1 to 4,
// or -1 for the last). A day can be both the 4th and the last.
function shape(c) {
  const p = parts(onsetWall(c));
  const nth = Math.ceil(p.day / 7);
  return { month: p.month, weekday: p.weekday, hour: p.hour, minute: p.minute, nth: nth <= 4 ? nth : null, last: p.day + 7 > daysIn(p.year, p.month), from: c.from, to: c.to };
}

// The moment a rule changes the clock in a year.
function ruleAt(rule, year) {
  let day;
  if (rule.n === -1) {
    day = daysIn(year, rule.month);
    while (new Date(Date.UTC(year, rule.month - 1, day)).getUTCDay() !== rule.weekday) day--;
  } else {
    day = 1;
    while (new Date(Date.UTC(year, rule.month - 1, day)).getUTCDay() !== rule.weekday) day++;
    day += (rule.n - 1) * 7;
  }
  return Date.UTC(year, rule.month - 1, day, rule.hour, rule.minute) - rule.from * 60000;
}

const sameChange = (a, b) => a.at === b.at && a.from === b.from && a.to === b.to;

// Two rules, one for each direction, from the changes of a year and the next; null when the zone doesn't change its
// clocks twice a year on the same weekday of the same month at the same time.
function candidates(tzid, base) {
  const a = changesIn(tzid, base);
  const b = changesIn(tzid, base + 1);
  if (a.length !== 2 || b.length !== 2) return null;
  const options = [];
  for (const up of [true, false]) {
    const x = shape(a.find((c) => (c.to > c.from) === up) || {});
    const y = shape(b.find((c) => (c.to > c.from) === up) || {});
    if (x.from === undefined || y.from === undefined) return null;
    if (x.month !== y.month || x.weekday !== y.weekday || x.hour !== y.hour || x.minute !== y.minute || x.from !== y.from || x.to !== y.to) return null;
    const ns = [];
    if (x.last && y.last) ns.push(-1);
    if (x.nth && x.nth === y.nth) ns.push(x.nth);
    if (!ns.length) return null;
    options.push(ns.map((n) => ({ daylight: up, month: x.month, weekday: x.weekday, hour: x.hour, minute: x.minute, from: x.from, to: x.to, n })));
  }
  const out = [];
  for (const d of options[0]) for (const s of options[1]) out.push([d, s]);
  return out;
}

// The first UTC year from which the rules give exactly the zone's changes up to end, or null.
function fitsFrom(rules, actual, start, end) {
  const first = new Date(start).getUTCFullYear() - 1;
  const last = new Date(end).getUTCFullYear() + 1;
  const predicted = (y) => rules.map((r) => ({ at: ruleAt(r, y), from: r.from, to: r.to })).filter((c) => c.at >= start && c.at < end);
  const actualIn = (y) => actual.filter((c) => new Date(c.at).getUTCFullYear() === y);
  let from = null;
  for (let y = last; y >= first; y--) {
    const p = predicted(y).sort((a, b) => a.at - b.at);
    const q = actualIn(y);
    if (p.length !== q.length || p.some((c, i) => !sameChange(c, q[i]))) break;
    from = y;
  }
  return from;
}

// ---------- the component ----------

function observance(name, from, to, start, extra = []) {
  return [`BEGIN:${name}`, `TZOFFSETFROM:${utcOffset(from)}`, `TZOFFSETTO:${utcOffset(to)}`, `DTSTART:${local(start)}`, ...extra, `END:${name}`];
}

// The lines of a VTIMEZONE for tzid that covers from (ms) on, up to until (ms) when the times it has to cover end.
function lines(tzid, { from, until = null, now = Date.now() }) {
  const start = from - YEAR;
  const base = Math.max(from, now);
  const end = Math.max(Math.min(until === null ? Infinity : until + DAY, base + AHEAD), start + 2 * YEAR);
  const actual = changes(tzid, Math.max(start, FIRST), end);
  const out = [];
  const onsets = [];
  const rdates = (list) => {
    // One observance for each kind of change, with every change of that kind; the first is also its DTSTART, which
    // ical.js doesn't count as a change on its own when there are RDATEs.
    const groups = new Map();
    for (const c of list) {
      const key = `${c.to > c.from}\n${c.from}\n${c.to}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const group of groups.values()) {
      const [first] = group;
      out.push(...observance(first.to > first.from ? 'DAYLIGHT' : 'STANDARD', first.from, first.to, onsetWall(first), group.map((c) => `RDATE:${local(onsetWall(c))}`)));
      onsets.push(first.at);
    }
  };
  const yearOf = new Date(base).getUTCFullYear();
  const options = actual.length ? candidates(tzid, yearOf) || [] : [];
  let fitted = null;
  for (const rules of options) {
    const y = fitsFrom(rules, actual, start, end);
    if (y !== null && y <= yearOf) {
      fitted = { rules, year: y };
      break;
    }
  }
  if (fitted) {
    const begins = Math.min(...fitted.rules.map((r) => ruleAt(r, fitted.year)));
    rdates(actual.filter((c) => c.at < begins));
    for (const r of fitted.rules) {
      const at = ruleAt(r, fitted.year);
      out.push(...observance(r.daylight ? 'DAYLIGHT' : 'STANDARD', r.from, r.to, at + r.from * 60000, [`RRULE:FREQ=YEARLY;BYMONTH=${r.month};BYDAY=${r.n}${DAYS[r.weekday]}`]));
      onsets.push(at);
    }
  } else if (actual.length) {
    rdates(actual);
  }
  // Nothing defines the offset at the earliest time yet: the zone had no change in the year before it.
  if (!onsets.some((at) => at <= from)) {
    const offset = offsetAt(Math.max(start, FIRST), tzid);
    const day = parts(start + offset * 60000);
    out.unshift(...observance('STANDARD', offset, offset, Date.UTC(day.year, day.month - 1, day.day)));
  }
  return ['BEGIN:VTIMEZONE', `TZID:${tzid}`, ...out, 'END:VTIMEZONE'];
}

const made = new Map();

// A VTIMEZONE component for tzid (an IANA name the PC knows) that covers from on, up to until (null: an open end).
function vtimezone(tzid, { from, until = null, now = Date.now() } = {}) {
  const day = (ms) => Math.floor(ms / DAY);
  const key = [tzid, day(from), until === null ? '' : day(until), day(now)].join('\n');
  if (!made.has(key)) {
    if (made.size > 500) made.clear();
    made.set(key, lines(tzid, { from: day(from) * DAY, until: until === null ? null : (day(until) + 1) * DAY, now }).join('\r\n'));
  }
  return new ICAL.Component(ICAL.parse(made.get(key)));
}

module.exports = { vtimezone, changes };
