'use strict';

// Calendar date math in the window (src/renderer/calendar-dates.js), with the PC's clock pinned to a zone and a moment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { zonedInstant, zonedParts } = require('../src/main/calendar/zone');

// A browser module in a CommonJS package: Node takes it as ESM from a data: URL.
const dates = import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, '../src/renderer/calendar-dates.js'), 'utf8'))}`);

// Runs fn with the PC in a zone; Node reads TZ again whenever it is set.
function inZone(zone, fn) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

// When a new event starts, as the zone's clock shows it: 'YYYY-MM-DD HH:MM'.
async function nextIn(zone, date, time, extra = 0) {
  const { nextHalfHour } = await dates;
  return inZone(zone, () => {
    const p = zonedParts(nextHalfHour(zonedInstant(date, time, zone) + extra), zone);
    return `${p.date} ${p.time}`;
  });
}

test('late on a Sunday the next half hour is Monday midnight, in next week', async () => {
  // When CI on UTC failed: a new event made from the toolbar on Sunday 15 November at 23:40 starts the next day.
  assert.equal(await nextIn('UTC', '2026-11-15', '23:40'), '2026-11-16 00:00');
  assert.equal(await nextIn('Europe/Amsterdam', '2026-11-15', '23:31'), '2026-11-16 00:00');
  assert.equal(await nextIn('UTC', '2026-11-15', '23:10'), '2026-11-15 23:30');
});

test('the next half hour is one on the PC clock, also where the zone is 45 minutes off the hour', async () => {
  // Rounding the time since 1970 put these at 10:15 and 10:45.
  assert.equal(await nextIn('Asia/Kathmandu', '2026-11-16', '10:05'), '2026-11-16 10:30');
  assert.equal(await nextIn('Asia/Kathmandu', '2026-11-16', '10:20'), '2026-11-16 10:30');
  assert.equal(await nextIn('Pacific/Chatham', '2026-11-16', '10:40'), '2026-11-16 11:00');
  assert.equal(await nextIn('Asia/Kolkata', '2026-11-16', '10:05'), '2026-11-16 10:30');
});

test('a time on the half hour stays, and a second past it goes on to the next one', async () => {
  assert.equal(await nextIn('Asia/Kathmandu', '2026-11-16', '10:30'), '2026-11-16 10:30');
  assert.equal(await nextIn('Asia/Kathmandu', '2026-11-16', '10:30', 1000), '2026-11-16 11:00');
  assert.equal(await nextIn('Europe/Amsterdam', '2026-11-16', '09:00', 1), '2026-11-16 09:30');
});

test('the night the clocks go back, the half hours follow the clock', async () => {
  // Amsterdam on 25 October 2026: 03:00 summer time is 02:00 winter time, and 02:40 happens twice.
  const second = zonedInstant('2026-10-25', '02:40', 'Europe/Amsterdam') + 3600000;
  assert.equal(zonedParts(second, 'Europe/Amsterdam').time, '02:40');
  assert.equal(await nextIn('Europe/Amsterdam', '2026-10-25', '02:40'), '2026-10-25 02:00');
  assert.equal(await nextIn('Europe/Amsterdam', '2026-10-25', '02:40', 3600000), '2026-10-25 03:00');
});
