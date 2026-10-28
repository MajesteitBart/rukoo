'use strict';

// Wall-clock math in named zones, checked at the clock changes of 2026.
const test = require('node:test');
const assert = require('node:assert/strict');
const { zonedParts, zonedInstant, addDays, weekday, isZone, pcZone } = require('../src/main/calendar/zone');

const HOUR = 3600000;
const z = (iso) => Date.parse(iso);
const clock = (ms, zone) => {
  const p = zonedParts(ms, zone);
  return `${p.date} ${p.time} ${p.offset}`;
};
const dayLength = (date, zone) => (zonedInstant(addDays(date, 1), '00:00', zone) - zonedInstant(date, '00:00', zone)) / HOUR;

// Every quarter hour over the three days around a change: the clock read back gives the same moment, or the
// earlier one when the clock showed that time twice.
function roundTrip(zone, date) {
  const from = zonedInstant(addDays(date, -1), '00:00', zone);
  const to = zonedInstant(addDays(date, 2), '00:00', zone);
  for (let t = from; t < to; t += 15 * 60000) {
    const p = zonedParts(t, zone);
    const back = zonedInstant(p.date, p.time, zone);
    assert.ok(back <= t && t - back <= HOUR, `${zone} ${new Date(t).toISOString()} read back as ${new Date(back).toISOString()}`);
    const q = zonedParts(back, zone);
    assert.deepEqual([q.date, q.time], [p.date, p.time], `${zone} ${p.date} ${p.time}`);
  }
}

test('Europe/Amsterdam: the spring jump and the autumn repeat', () => {
  const zone = 'Europe/Amsterdam';
  assert.equal(clock(z('2026-03-29T00:59:00Z'), zone), '2026-03-29 01:59 60');
  assert.equal(clock(z('2026-03-29T01:00:00Z'), zone), '2026-03-29 03:00 120');
  // 02:00 to 02:59 doesn't exist; it moves forward by the hour.
  assert.equal(zonedInstant('2026-03-29', '02:00', zone), z('2026-03-29T01:00:00Z'));
  assert.equal(zonedInstant('2026-03-29', '02:30', zone), z('2026-03-29T01:30:00Z'));
  assert.equal(zonedInstant('2026-03-29', '03:00', zone), z('2026-03-29T01:00:00Z'));
  // 02:00 to 02:59 happens twice; the first one counts.
  assert.equal(clock(z('2026-10-25T00:30:00Z'), zone), '2026-10-25 02:30 120');
  assert.equal(clock(z('2026-10-25T01:30:00Z'), zone), '2026-10-25 02:30 60');
  assert.equal(zonedInstant('2026-10-25', '02:30', zone), z('2026-10-25T00:30:00Z'));
  assert.equal(zonedInstant('2026-10-25', '03:00', zone), z('2026-10-25T02:00:00Z'));
  assert.equal(dayLength('2026-03-29', zone), 23);
  assert.equal(dayLength('2026-10-25', zone), 25);
  assert.equal(dayLength('2026-06-01', zone), 24);
  roundTrip(zone, '2026-03-29');
  roundTrip(zone, '2026-10-25');
});

test('America/New_York: west of UTC, so the local date runs behind', () => {
  const zone = 'America/New_York';
  assert.equal(zonedInstant('2026-03-08', '02:30', zone), z('2026-03-08T07:30:00Z'));
  assert.equal(clock(z('2026-03-08T07:30:00Z'), zone), '2026-03-08 03:30 -240');
  assert.equal(zonedInstant('2026-11-01', '01:30', zone), z('2026-11-01T05:30:00Z'));
  assert.equal(clock(z('2026-11-01T05:30:00Z'), zone), '2026-11-01 01:30 -240');
  assert.equal(clock(z('2026-11-01T06:30:00Z'), zone), '2026-11-01 01:30 -300');
  assert.equal(clock(z('2026-11-02T03:00:00Z'), zone), '2026-11-01 22:00 -300');
  assert.equal(dayLength('2026-03-08', zone), 23);
  assert.equal(dayLength('2026-11-01', zone), 25);
  roundTrip(zone, '2026-03-08');
  roundTrip(zone, '2026-11-01');
});

test('Australia/Sydney: southern summer time, ahead of UTC', () => {
  const zone = 'Australia/Sydney';
  // Summer time ends on 5 April: 02:00 to 02:59 twice.
  assert.equal(zonedInstant('2026-04-05', '02:30', zone), z('2026-04-04T15:30:00Z'));
  assert.equal(clock(z('2026-04-04T16:30:00Z'), zone), '2026-04-05 02:30 600');
  // It starts on 4 October: 02:00 jumps to 03:00.
  assert.equal(zonedInstant('2026-10-04', '02:30', zone), z('2026-10-03T16:30:00Z'));
  const p = zonedParts(z('2026-04-04T15:30:00Z'), zone);
  assert.deepEqual(p, { date: '2026-04-05', time: '02:30', weekday: 0, offset: 660 });
  assert.equal(dayLength('2026-04-05', zone), 25);
  assert.equal(dayLength('2026-10-04', zone), 23);
  roundTrip(zone, '2026-04-05');
  roundTrip(zone, '2026-10-04');
});

test('America/Santiago: the clock changes at midnight', () => {
  const zone = 'America/Santiago';
  // 6 September has no 00:00: the day starts at 01:00.
  assert.equal(zonedInstant('2026-09-06', '00:00', zone), z('2026-09-06T04:00:00Z'));
  assert.equal(clock(z('2026-09-06T04:00:00Z'), zone), '2026-09-06 01:00 -180');
  assert.equal(clock(z('2026-09-06T03:59:00Z'), zone), '2026-09-05 23:59 -240');
  assert.equal(zonedInstant('2026-09-05', '24:00', zone), z('2026-09-06T04:00:00Z'));
  assert.equal(zonedInstant('2026-09-06', '00:30', zone), z('2026-09-06T04:30:00Z'));
  // On 4 April the clock goes from 24:00 back to 23:00, so 23:00 to 23:59 happens twice and 5 April starts after both.
  assert.equal(zonedInstant('2026-04-04', '23:30', zone), z('2026-04-05T02:30:00Z'));
  assert.equal(clock(z('2026-04-05T03:30:00Z'), zone), '2026-04-04 23:30 -240');
  assert.equal(zonedInstant('2026-04-05', '00:00', zone), z('2026-04-05T04:00:00Z'));
  assert.equal(zonedInstant('2026-04-04', '24:00', zone), z('2026-04-05T04:00:00Z'));
  assert.equal(dayLength('2026-04-04', zone), 25);
  assert.equal(dayLength('2026-09-06', zone), 23);
  roundTrip(zone, '2026-04-04');
  roundTrip(zone, '2026-09-06');
});

test('Australia/Lord_Howe: summer time moves the clock by half an hour', () => {
  const zone = 'Australia/Lord_Howe';
  assert.equal(clock(z('2026-07-01T00:00:00Z'), zone), '2026-07-01 10:30 630');
  // 4 October: 02:00 jumps to 02:30, so 02:15 becomes 02:45.
  assert.equal(zonedInstant('2026-10-04', '02:15', zone), z('2026-10-03T15:45:00Z'));
  assert.equal(clock(z('2026-10-03T15:45:00Z'), zone), '2026-10-04 02:45 660');
  // 5 April: 02:00 goes back to 01:30, so 01:45 happens twice.
  assert.equal(zonedInstant('2026-04-05', '01:45', zone), z('2026-04-04T14:45:00Z'));
  assert.equal(clock(z('2026-04-04T15:15:00Z'), zone), '2026-04-05 01:45 630');
  assert.equal(dayLength('2026-04-05', zone), 24.5);
  assert.equal(dayLength('2026-10-04', zone), 23.5);
  roundTrip(zone, '2026-04-05');
  roundTrip(zone, '2026-10-04');
});

test('Asia/Kolkata and UTC: fixed offsets, a half hour and none', () => {
  assert.deepEqual(zonedParts(z('2026-01-01T18:30:00Z'), 'Asia/Kolkata'), { date: '2026-01-02', time: '00:00', weekday: 5, offset: 330 });
  assert.equal(zonedInstant('2026-06-15', '09:00', 'Asia/Kolkata'), z('2026-06-15T03:30:00Z'));
  assert.equal(dayLength('2026-03-29', 'Asia/Kolkata'), 24);
  assert.deepEqual(zonedParts(0, 'UTC'), { date: '1970-01-01', time: '00:00', weekday: 4, offset: 0 });
  assert.deepEqual(zonedParts(z('2026-10-27T13:45:59.999Z'), 'UTC'), { date: '2026-10-27', time: '13:45', weekday: 2, offset: 0 });
  assert.equal(zonedInstant('2026-03-29', '02:30', 'UTC'), z('2026-03-29T02:30:00Z'));
  assert.equal(zonedInstant('2026-12-31', '24:00', 'UTC'), z('2027-01-01T00:00:00Z'));
  assert.equal(zonedInstant('0050-01-01', '00:00', 'UTC'), z('0050-01-01T00:00:00Z'));
  assert.equal(zonedParts(z('0050-06-01T00:00:00Z'), 'UTC').date, '0050-06-01');
});

test('dates step by calendar day, regardless of clock changes', () => {
  assert.equal(addDays('2026-03-28', 1), '2026-03-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-10-27', 0), '2026-10-27');
  assert.equal(addDays('2026-01-31', 365), '2027-01-31');
  assert.equal(weekday('2026-10-27'), 2);
  assert.equal(weekday('2026-10-25'), 0);
  assert.equal(weekday('2026-10-31'), 6);
  assert.equal(weekday('2028-02-29'), 2);
});

test('zone names: IANA names and UTC, not offsets, Windows names or junk', () => {
  for (const name of ['UTC', 'Europe/Amsterdam', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5', 'Asia/Calcutta', 'europe/amsterdam']) {
    assert.equal(isZone(name), true, name);
  }
  for (const name of ['', 'Mars/Olympus', '+01:00', '-0500', 'W. Europe Standard Time', 'Europe/Amsterdam ', '/Europe', 'Europe//Amsterdam', 'Etc/Unknown', 'A'.repeat(65), null, undefined, 42, {}]) {
    assert.equal(isZone(name), false, String(name));
  }
  assert.equal(isZone(pcZone()), true);
});

test('bad input is refused with a RangeError', () => {
  assert.throws(() => zonedInstant('2026-02-30', '09:00', 'UTC'), RangeError);
  assert.throws(() => zonedInstant('2026-13-01', '09:00', 'UTC'), RangeError);
  assert.throws(() => zonedInstant('2026-3-1', '09:00', 'UTC'), RangeError);
  assert.throws(() => zonedInstant('2026-03-01', '9:00', 'UTC'), RangeError);
  assert.throws(() => zonedInstant('2026-03-01', '24:01', 'UTC'), RangeError);
  assert.throws(() => zonedInstant('2026-03-01', '12:60', 'UTC'), RangeError);
  assert.throws(() => zonedInstant('2026-03-01', '09:00:00', 'UTC'), RangeError);
  assert.throws(() => zonedInstant('2026-03-01', '09:00', 'Mars/Olympus'), RangeError);
  assert.throws(() => zonedInstant('2026-03-01', '09:00', '+01:00'), RangeError);
  assert.throws(() => zonedParts(NaN, 'UTC'), RangeError);
  assert.throws(() => zonedParts('0', 'UTC'), RangeError);
  assert.throws(() => zonedParts(0, 'Mars/Olympus'), RangeError);
  assert.throws(() => addDays('2026-03-01', 1.5), RangeError);
  assert.throws(() => addDays('2026-02-29', 1), RangeError);
  assert.throws(() => weekday(20261027), RangeError);
});
