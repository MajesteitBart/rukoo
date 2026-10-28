'use strict';

// The time zone definitions (VTIMEZONE) Rukoo writes into calendar objects. Other apps, and Rukoo itself, turn a
// time written in a zone into a moment through that definition, so read back by ical.js it has to give the moments
// the PC's zone data (Intl) gives, years ahead, for zones with and without clock changes and with irregular ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { vtimezone, changes } = require('../src/main/calendar/vtimezone');
const { zonedParts } = require('../src/main/calendar/zone');

const NOW = Date.UTC(2026, 9, 27);
const DAY = 86400000;
const YEAR = 365.25 * DAY;

function parse(tzid, opts) {
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', vtimezone(tzid, { now: NOW, ...opts }).toString(), 'END:VCALENDAR', ''].join('\r\n');
  return { text, zone: new ICAL.Component(ICAL.parse(text)).getTimeZoneByID(tzid) };
}

// The moment ical.js gives the clock reading the zone shows at ms, as a reader of a TZID time gets it. A reading the
// clock shows twice (the hour it goes back) may be either.
function readsBack(zone, tzid, ms) {
  const p = zonedParts(ms, tzid);
  const [year, month, day] = p.date.split('-').map(Number);
  const [hour, minute] = p.time.split(':').map(Number);
  const back = ICAL.Time.fromData({ year, month, day, hour, minute, second: 0 }, zone).toUnixTime() * 1000;
  if (back === ms) return true;
  const q = zonedParts(back, tzid);
  return q.date === p.date && q.time === p.time;
}

// Every three hours of a year, and the hours around each clock change in it.
function moments(tzid, from) {
  const out = [];
  for (let t = from; t < from + YEAR; t += 3 * 3600000) out.push(t + 1800000);
  for (const c of changes(tzid, from, from + YEAR)) for (let d = -3; d <= 3; d++) out.push(c.at + d * 1800000);
  return out;
}

function checkYearsOut(tzid, opts = {}) {
  const { text, zone } = parse(tzid, { from: NOW, ...opts });
  for (const years of [1, 5, 15]) {
    const from = NOW + Math.round(years * YEAR);
    for (const ms of moments(tzid, from)) assert.ok(readsBack(zone, tzid, ms), `${tzid} at ${new Date(ms).toISOString()}\n${text}`);
  }
  return text;
}

const onsets = (text) => [...text.matchAll(/\r\nDTSTART:(\d{8}T\d{6})\r\n/g)].map((m) => m[1]);
const observances = (text) => [...text.matchAll(/BEGIN:(STANDARD|DAYLIGHT)\r\n([\s\S]*?)END:\1/g)].map((m) => ({ kind: m[1], body: m[2] }));

test('a zone with a yearly clock change gets one DAYLIGHT and one STANDARD observance with a rule, right 1, 5 and 15 years out', () => {
  const rules = {
    'Europe/Amsterdam': ['FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU'],
    'America/New_York': ['FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'FREQ=YEARLY;BYMONTH=11;BYDAY=1SU'],
    // In the southern hemisphere summer time starts in October.
    'Australia/Sydney': ['FREQ=YEARLY;BYMONTH=10;BYDAY=1SU', 'FREQ=YEARLY;BYMONTH=4;BYDAY=1SU'],
    // Lord Howe Island moves its clocks by half an hour.
    'Australia/Lord_Howe': ['FREQ=YEARLY;BYMONTH=10;BYDAY=1SU', 'FREQ=YEARLY;BYMONTH=4;BYDAY=1SU']
  };
  for (const [tzid, [daylight, standard]] of Object.entries(rules)) {
    const text = checkYearsOut(tzid);
    const list = observances(text);
    assert.deepEqual(list.map((o) => o.kind), ['DAYLIGHT', 'STANDARD'], tzid);
    assert.match(list[0].body, new RegExp(`RRULE:${daylight}\\r\\n`), tzid);
    assert.match(list[1].body, new RegExp(`RRULE:${standard}\\r\\n`), tzid);
    assert.doesNotMatch(text, /RDATE/, tzid);
  }
  assert.match(observances(checkYearsOut('Australia/Lord_Howe'))[0].body, /TZOFFSETFROM:\+1030\r\nTZOFFSETTO:\+1100/);
});

test('a zone without clock changes gets a single STANDARD observance', () => {
  for (const [tzid, offset] of [['Asia/Kolkata', '+0530'], ['UTC', '+0000']]) {
    const text = checkYearsOut(tzid);
    const list = observances(text);
    assert.deepEqual(list.map((o) => o.kind), ['STANDARD'], tzid);
    assert.match(list[0].body, new RegExp(`TZOFFSETFROM:\\${offset}\\r\\nTZOFFSETTO:\\${offset}\\r\\n`));
    assert.doesNotMatch(text, /RRULE|RDATE/);
  }
});

test('a zone whose changes no weekday rule describes gets every change as an RDATE, up to the end of the series or 20 years', () => {
  // Chile changes at midnight after the first Saturday, Israel on the Friday before the last Sunday of March.
  for (const tzid of ['America/Santiago', 'Asia/Jerusalem']) {
    const text = checkYearsOut(tzid);
    assert.doesNotMatch(text, /RRULE/, tzid);
    const dates = [...text.matchAll(/RDATE:(\d{4})/g)].map((m) => Number(m[1]));
    assert.ok(Math.max(...dates) >= 2045, `${tzid} ends ${Math.max(...dates)}`);
    // A series that ends in two years needs no more than that.
    const short = parse(tzid, { from: NOW, until: NOW + 2 * YEAR }).text;
    assert.ok(Math.max(...[...short.matchAll(/RDATE:(\d{4})/g)].map((m) => Number(m[1]))) <= 2029, short);
  }
});

test('every definition starts at or before the earliest time it covers, also one in winter or long ago', () => {
  for (const [tzid, from] of [['Europe/Amsterdam', Date.UTC(2026, 0, 15, 9)], ['America/New_York', Date.UTC(2019, 5, 3, 14)], ['Australia/Sydney', Date.UTC(2026, 6, 1)], ['Asia/Jerusalem', Date.UTC(2026, 0, 2)], ['Asia/Kolkata', Date.UTC(2026, 0, 1)]]) {
    const { text, zone } = parse(tzid, { from });
    const p = zonedParts(from, tzid);
    const earliest = onsets(text).sort()[0];
    assert.ok(earliest <= `${p.date.replace(/-/g, '')}T${p.time.replace(':', '')}00`, `${tzid}: ${earliest}\n${text}`);
    // ical.js has no offset before the first observance; here it has the right one.
    for (let ms = from; ms < from + 30 * DAY; ms += 6 * 3600000) assert.ok(readsBack(zone, tzid, ms), `${tzid} at ${new Date(ms).toISOString()}`);
  }
});

test('a series that ends far off is probed 20 years ahead at most, and a time long ago no further back than 1900', () => {
  // UNTIL in the year 9999 used to take seconds and, for Chile, thousands of RDATEs.
  for (const tzid of ['America/Santiago', 'Europe/Amsterdam']) {
    const started = Date.now();
    const { text, zone } = parse(tzid, { from: NOW, until: Date.UTC(9999, 11, 31) });
    assert.ok(Date.now() - started < 2000, `${tzid} took ${Date.now() - started} ms`);
    const dates = [...text.matchAll(/RDATE:(\d{4})/g)].map((m) => Number(m[1]));
    assert.ok(dates.length <= 50 && Math.max(0, ...dates) <= 2047, `${tzid}: ${dates.length} RDATEs, the last in ${Math.max(...dates)}`);
    for (const ms of moments(tzid, NOW + 5 * YEAR)) assert.ok(readsBack(zone, tzid, ms), `${tzid} at ${new Date(ms).toISOString()}`);
  }
  // A time in the year 1000 is still covered, and from 1900 on the definition follows the zone data.
  const from = Date.UTC(1000, 0, 1, 12);
  const { text, zone } = parse('Europe/Amsterdam', { from });
  assert.ok(onsets(text).sort()[0] <= '10000101T120000', text);
  for (const ms of [...moments('Europe/Amsterdam', Date.UTC(1950, 0, 1)), ...moments('Europe/Amsterdam', NOW + 5 * YEAR)]) assert.ok(readsBack(zone, 'Europe/Amsterdam', ms), new Date(ms).toISOString());
});

test('the same zone and range give the same definition', () => {
  const a = vtimezone('Europe/Amsterdam', { from: NOW, now: NOW }).toString();
  const b = vtimezone('Europe/Amsterdam', { from: NOW + 3600000, now: NOW }).toString();
  assert.equal(a, b);
  assert.match(a, /^BEGIN:VTIMEZONE\r\nTZID:Europe\/Amsterdam\r\n/);
});
