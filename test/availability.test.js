'use strict';

// Open and free time: interval math against a simple model, weekly hours across the clock changes of 2026, and the
// free-time text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openWindows, merge, subtract, intersect, freeWindows, formatFreeTimes, workWeekly, isRanges, isWeekly } = require('../src/main/calendar/availability');
const { zonedParts, zonedInstant, addDays } = require('../src/main/calendar/zone');

const HOUR = 3600000;
const z = (iso) => Date.parse(iso);
const none = () => [[], [], [], [], [], [], []];
const every = (ranges) => Array.from({ length: 7 }, () => ranges);
const iso = (list) => list.map(([s, e]) => `${new Date(s).toISOString()} ${new Date(e).toISOString()}`);

// The same pseudo-random numbers on every run, so a failure can be replayed.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sorted, not touching, none empty: the form every function here returns.
function assertCanonical(list, label) {
  for (let i = 0; i < list.length; i++) {
    assert.ok(list[i][0] < list[i][1], `${label}: empty interval at ${i}`);
    if (i) assert.ok(list[i][0] > list[i - 1][1], `${label}: ${i} overlaps or touches the one before`);
  }
}

test('merge joins overlapping and touching intervals, drops empty ones and leaves its input alone', () => {
  const input = [[50, 60], [10, 20], [15, 30], [30, 35], [40, 40], [45, 44], [70, 80], [72, 75]];
  const copy = JSON.parse(JSON.stringify(input));
  assert.deepEqual(merge(input), [[10, 35], [50, 60], [70, 80]]);
  assert.deepEqual(input, copy);
  assert.deepEqual(merge([]), []);
  const one = [[1, 2]];
  assert.notEqual(merge(one)[0], one[0], 'returns new pairs');
  assert.throws(() => merge([[1, NaN]]), RangeError);
  assert.throws(() => merge([[1]]), RangeError);
  assert.throws(() => merge('x'), RangeError);
});

test('subtract, intersect and freeWindows on small cases', () => {
  assert.deepEqual(subtract([[0, 100]], [[10, 20], [30, 40]]), [[0, 10], [20, 30], [40, 100]]);
  assert.deepEqual(subtract([[0, 100]], [[-10, 5], [95, 200]]), [[5, 95]]);
  assert.deepEqual(subtract([[0, 10], [20, 30]], [[0, 30]]), []);
  assert.deepEqual(subtract([[0, 10]], []), [[0, 10]]);
  assert.deepEqual(intersect([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]]);
  assert.deepEqual(intersect([[0, 10]], [[10, 20]]), []);
  assert.deepEqual(freeWindows({ open: [[0, 100]], busy: [[10, 20], [25, 70]], minLength: 10 }), [[0, 10], [70, 100]]);
  assert.deepEqual(freeWindows({ open: [[0, 100]], busy: [[10, 20], [25, 70]], minLength: 11 }), [[70, 100]]);
  assert.deepEqual(freeWindows({ open: [[0, 100]] }), [[0, 100]]);
  assert.throws(() => freeWindows({ open: [], busy: [], minLength: -1 }), RangeError);
});

test('interval math matches a minute-by-minute model on random lists', () => {
  const next = random(7);
  const N = 120;
  const list = () => Array.from({ length: Math.floor(next() * 8) }, () => {
    const a = Math.floor(next() * N);
    return [a, a + Math.floor(next() * 30) - 5];
  });
  const bits = (l) => {
    const b = new Array(N + 40).fill(false);
    for (const [s, e] of l) for (let u = Math.max(s, 0); u < e; u++) b[u] = true;
    return b;
  };
  const runs = (b) => {
    const out = [];
    for (let u = 0; u < b.length; u++) {
      if (!b[u]) continue;
      if (out.length && out[out.length - 1][1] === u) out[out.length - 1][1] = u + 1;
      else out.push([u, u + 1]);
    }
    return out;
  };
  for (let round = 0; round < 2000; round++) {
    const a = list();
    const b = list();
    const A = bits(a);
    const B = bits(b);
    const min = Math.floor(next() * 12);
    const label = `round ${round}: ${JSON.stringify(a)} ${JSON.stringify(b)}`;
    for (const [name, got, want] of [
      ['merge', merge(a), runs(A)],
      ['subtract', subtract(a, b), runs(A.map((x, i) => x && !B[i]))],
      ['intersect', intersect(a, b), runs(A.map((x, i) => x && B[i]))],
      ['freeWindows', freeWindows({ open: a, busy: b, minLength: min }), runs(A.map((x, i) => x && !B[i])).filter(([s, e]) => e - s >= min)]
    ]) {
      assertCanonical(got, `${name} ${label}`);
      assert.deepEqual(got, want, `${name} ${label}`);
    }
  }
});

test('working hours in an ordinary week', () => {
  const weekly = workWeekly({ workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '17:00' });
  const got = openWindows({ weekly, timeZone: 'Europe/Amsterdam', from: z('2026-11-01T00:00:00Z'), to: z('2026-11-08T00:00:00Z') });
  assert.deepEqual(got, [2, 3, 4, 5, 6].map((d) => [z(`2026-11-0${d}T08:00:00Z`), z(`2026-11-0${d}T16:00:00Z`)]));
  // Clipped to [from, to): from inside Tuesday's hours, to inside Thursday's.
  const clipped = openWindows({ weekly, timeZone: 'Europe/Amsterdam', from: z('2026-11-03T10:15:00Z'), to: z('2026-11-05T09:00:00Z') });
  assert.deepEqual(iso(clipped), iso([
    [z('2026-11-03T10:15:00Z'), z('2026-11-03T16:00:00Z')],
    [z('2026-11-04T08:00:00Z'), z('2026-11-04T16:00:00Z')],
    [z('2026-11-05T08:00:00Z'), z('2026-11-05T09:00:00Z')]
  ]));
  assert.deepEqual(openWindows({ weekly, timeZone: 'UTC', from: 10, to: 10 }), []);
  assert.deepEqual(openWindows({ weekly, timeZone: 'UTC', from: 10, to: 5 }), []);
});

test('several ranges a day, and days that meet at midnight join up', () => {
  const weekly = none();
  weekly[2] = [['09:00', '12:00'], ['12:00', '13:00'], ['14:00', '24:00']];
  weekly[3] = [['00:00', '02:00'], ['08:30', '09:00']];
  const got = openWindows({ weekly, timeZone: 'UTC', from: z('2026-11-02T00:00:00Z'), to: z('2026-11-05T00:00:00Z') });
  assert.deepEqual(iso(got), iso([
    [z('2026-11-03T09:00:00Z'), z('2026-11-03T13:00:00Z')],
    [z('2026-11-03T14:00:00Z'), z('2026-11-04T02:00:00Z')],
    [z('2026-11-04T08:30:00Z'), z('2026-11-04T09:00:00Z')]
  ]));
});

test('date overrides replace a day, [] blocks it, and other keys do nothing', () => {
  const weekly = workWeekly({});
  const overrides = JSON.parse('{"2026-11-03": [], "2026-11-04": [["07:00", "08:00"], ["20:00", "21:30"]], "2026-11-14": [["10:00", "11:00"]], "__proto__": [["00:00", "24:00"]], "constructor": 5}');
  const got = openWindows({ weekly, overrides, timeZone: 'Europe/Amsterdam', from: z('2026-11-02T00:00:00Z'), to: z('2026-11-06T00:00:00Z') });
  assert.deepEqual(iso(got), iso([
    [z('2026-11-02T08:00:00Z'), z('2026-11-02T16:00:00Z')],
    [z('2026-11-04T06:00:00Z'), z('2026-11-04T07:00:00Z')],
    [z('2026-11-04T19:00:00Z'), z('2026-11-04T20:30:00Z')],
    [z('2026-11-05T08:00:00Z'), z('2026-11-05T16:00:00Z')]
  ]));
  // An override opens a day the week keeps closed.
  const sunday = openWindows({ weekly, overrides: { '2026-11-08': [['10:00', '12:00']] }, timeZone: 'Europe/Amsterdam', from: z('2026-11-07T00:00:00Z'), to: z('2026-11-09T00:00:00Z') });
  assert.deepEqual(sunday, [[z('2026-11-08T09:00:00Z'), z('2026-11-08T11:00:00Z')]]);
});

// The transition days of 2026 in each zone, with the length of that day in hours.
const CHANGES = [
  ['Europe/Amsterdam', '2026-03-29', 23], ['Europe/Amsterdam', '2026-10-25', 25],
  ['America/New_York', '2026-03-08', 23], ['America/New_York', '2026-11-01', 25],
  ['Australia/Sydney', '2026-04-05', 25], ['Australia/Sydney', '2026-10-04', 23],
  ['America/Santiago', '2026-04-04', 25], ['America/Santiago', '2026-09-06', 23],
  ['Australia/Lord_Howe', '2026-04-05', 24.5], ['Australia/Lord_Howe', '2026-10-04', 23.5]
];

test('a whole day open is as long as the zone makes it: 23, 25, 23.5 and 24.5 hours', () => {
  for (const [zone, date, hours] of CHANGES) {
    const from = zonedInstant(addDays(date, -2), '00:00', zone);
    const to = zonedInstant(addDays(date, 3), '00:00', zone);
    const got = openWindows({ weekly: none(), overrides: { [date]: [['00:00', '24:00']] }, timeZone: zone, from, to });
    assert.equal(got.length, 1, `${zone} ${date}`);
    assert.equal((got[0][1] - got[0][0]) / HOUR, hours, `${zone} ${date}`);
    assert.equal(got[0][0], zonedInstant(date, '00:00', zone), `${zone} ${date} starts at the day's first moment`);
    // Open every day: one interval from start to end, with no gap or overlap at the change.
    assert.deepEqual(openWindows({ weekly: every([['00:00', '24:00']]), timeZone: zone, from, to }), [[from, to]], `${zone} ${date} all week`);
  }
});

test('ranges across a skipped or repeated hour: skipped times move forward, repeated ones take the first instance', () => {
  const day = (zone, date, ranges) => openWindows({ weekly: none(), overrides: { [date]: ranges }, timeZone: zone, from: zonedInstant(addDays(date, -1), '00:00', zone), to: zonedInstant(addDays(date, 2), '00:00', zone) });
  const ams = 'Europe/Amsterdam';
  // 29 March: 02:00 jumps to 03:00 (01:00 UTC).
  assert.deepEqual(day(ams, '2026-03-29', [['01:00', '04:00']]), [[z('2026-03-29T00:00:00Z'), z('2026-03-29T02:00:00Z')]]);
  assert.deepEqual(day(ams, '2026-03-29', [['02:30', '05:00']]), [[z('2026-03-29T01:30:00Z'), z('2026-03-29T03:00:00Z')]]);
  assert.deepEqual(day(ams, '2026-03-29', [['02:00', '02:30']]), [[z('2026-03-29T01:00:00Z'), z('2026-03-29T01:30:00Z')]]);
  // A range from inside the gap to its end is reversed once moved, so it has no time.
  assert.deepEqual(day(ams, '2026-03-29', [['02:30', '03:00']]), []);
  // 25 October: 03:00 goes back to 02:00 (01:00 UTC).
  assert.deepEqual(day(ams, '2026-10-25', [['01:00', '04:00']]), [[z('2026-10-24T23:00:00Z'), z('2026-10-25T03:00:00Z')]]);
  assert.deepEqual(day(ams, '2026-10-25', [['01:00', '02:30']]), [[z('2026-10-24T23:00:00Z'), z('2026-10-25T00:30:00Z')]]);
  assert.deepEqual(day(ams, '2026-10-25', [['02:30', '03:00']]), [[z('2026-10-25T00:30:00Z'), z('2026-10-25T02:00:00Z')]]);
  // New York.
  assert.deepEqual(day('America/New_York', '2026-03-08', [['09:00', '17:00']]), [[z('2026-03-08T13:00:00Z'), z('2026-03-08T21:00:00Z')]]);
  assert.deepEqual(day('America/New_York', '2026-03-06', [['09:00', '17:00']]), [[z('2026-03-06T14:00:00Z'), z('2026-03-06T22:00:00Z')]]);
  assert.deepEqual(day('America/New_York', '2026-11-01', [['01:00', '02:00']]), [[z('2026-11-01T05:00:00Z'), z('2026-11-01T07:00:00Z')]]);
  // Sydney: summer time starts on 4 October.
  assert.deepEqual(day('Australia/Sydney', '2026-10-04', [['01:00', '04:00']]), [[z('2026-10-03T15:00:00Z'), z('2026-10-03T17:00:00Z')]]);
  assert.deepEqual(day('Australia/Sydney', '2026-04-05', [['01:00', '04:00']]), [[z('2026-04-04T14:00:00Z'), z('2026-04-04T18:00:00Z')]]);
  // Santiago: 6 September has no 00:00, and on 4 April 23:00 to 24:00 happens twice.
  assert.deepEqual(day('America/Santiago', '2026-09-06', [['00:00', '09:00']]), [[z('2026-09-06T04:00:00Z'), z('2026-09-06T12:00:00Z')]]);
  assert.deepEqual(day('America/Santiago', '2026-09-06', [['00:00', '00:30']]), [[z('2026-09-06T04:00:00Z'), z('2026-09-06T04:30:00Z')]]);
  assert.deepEqual(day('America/Santiago', '2026-04-04', [['20:00', '24:00']]), [[z('2026-04-04T23:00:00Z'), z('2026-04-05T04:00:00Z')]]);
  // Lord Howe: half-hour changes.
  assert.deepEqual(day('Australia/Lord_Howe', '2026-10-04', [['01:00', '04:00']]), [[z('2026-10-03T14:30:00Z'), z('2026-10-03T17:00:00Z')]]);
  assert.deepEqual(day('Australia/Lord_Howe', '2026-04-05', [['01:00', '03:00']]), [[z('2026-04-04T14:00:00Z'), z('2026-04-04T16:30:00Z')]]);
});

test('over a whole year, a moment is open exactly when its wall-clock time is in that date\'s ranges', () => {
  const next = random(2026);
  const time = (q) => q === 96 ? '24:00' : `${String(Math.floor(q / 4)).padStart(2, '0')}:${String((q % 4) * 15).padStart(2, '0')}`;
  // Up to three sorted ranges on a 15-minute grid, sometimes ending at 24:00.
  const ranges = () => {
    const cuts = [...new Set(Array.from({ length: 2 * Math.floor(next() * 4) }, () => Math.floor(next() * 97)))].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i + 1 < cuts.length; i += 2) out.push([time(cuts[i]), time(cuts[i + 1])]);
    return out;
  };
  for (const zone of ['Europe/Amsterdam', 'America/New_York', 'Australia/Sydney', 'America/Santiago', 'Australia/Lord_Howe', 'Asia/Kolkata']) {
    const weekly = Array.from({ length: 7 }, ranges);
    const overrides = {};
    for (let i = 0; i < 40; i++) overrides[addDays('2026-01-01', Math.floor(next() * 365))] = ranges();
    // Every transition day gets its own hours too, so the year covers ranges across the changes.
    for (const [z2, date] of CHANGES) if (z2 === zone) overrides[date] = [['00:00', '01:30'], ['02:15', '03:45'], ['23:00', '24:00']];
    const from = z('2026-01-01T00:00:00Z') + Math.floor(next() * HOUR);
    const to = z('2027-01-01T00:00:00Z') - Math.floor(next() * HOUR);
    const got = openWindows({ weekly, overrides, timeZone: zone, from, to });
    assertCanonical(got, zone);
    assert.ok(!got.length || (got[0][0] >= from && got[got.length - 1][1] <= to), `${zone} inside [from, to)`);
    let j = 0;
    let checked = 0;
    for (let t = from + Math.floor(next() * 7 * 60000); t < to; t += 7 * 60000 + Math.floor(next() * 50 * 60000)) {
      while (j < got.length && got[j][1] <= t) j++;
      const open = j < got.length && got[j][0] <= t;
      // Near a clock change, wall-clock membership and moments part ways by design; the vectors above cover that.
      if (zonedParts(t - 3 * HOUR, zone).offset !== zonedParts(t + 3 * HOUR, zone).offset) continue;
      const p = zonedParts(t, zone);
      const list = Object.prototype.hasOwnProperty.call(overrides, p.date) ? overrides[p.date] : weekly[p.weekday];
      const want = list.some(([s, e]) => s <= p.time && p.time < e);
      assert.equal(open, want, `${zone} ${new Date(t).toISOString()} (${p.date} ${p.time})`);
      checked++;
    }
    assert.ok(checked > 10000, `${zone}: ${checked} moments checked`);
  }
});

test('hours that break the rules are refused, not guessed at', () => {
  const base = { timeZone: 'UTC', from: 0, to: 7 * 86400000 };
  for (const day of [
    [['22:00', '02:00']],
    [['09:00', '09:00']],
    [['24:00', '24:00']],
    [['09:00', '12:00'], ['11:00', '13:00']],
    [['13:00', '14:00'], ['09:00', '10:00']],
    [['9:00', '10:00']],
    [['09:00', '24:30']],
    [['09:00']],
    'all day'
  ]) {
    const weekly = none();
    weekly[3] = day;
    assert.equal(isWeekly(weekly), false, JSON.stringify(day));
    assert.throws(() => openWindows({ ...base, weekly }), RangeError, JSON.stringify(day));
    assert.throws(() => openWindows({ ...base, weekly: none(), overrides: { '1970-01-03': day } }), RangeError, `override ${JSON.stringify(day)}`);
  }
  assert.equal(isRanges([['00:00', '24:00']]), true);
  assert.equal(isRanges([['09:00', '12:00'], ['12:00', '13:00']]), true);
  assert.equal(isRanges([]), true);
  assert.throws(() => openWindows({ ...base, weekly: none().slice(1) }), RangeError);
  assert.throws(() => openWindows({ ...base, weekly: none(), timeZone: 'Mars/Olympus' }), RangeError);
  assert.throws(() => openWindows({ ...base, weekly: none(), to: Infinity }), RangeError);
  assert.throws(() => openWindows({ ...base, weekly: none(), to: 20 * 365 * 86400000 }), RangeError);
  assert.throws(() => openWindows({ ...base, weekly: none(), overrides: 'x' }), RangeError);
});

test('working hours from calendar settings', () => {
  assert.deepEqual(workWeekly({ workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '17:00' }), [[], [['09:00', '17:00']], [['09:00', '17:00']], [['09:00', '17:00']], [['09:00', '17:00']], [['09:00', '17:00']], []]);
  assert.deepEqual(workWeekly({ workDays: [0, 6], workStart: '14:00', workEnd: '24:00' }), [[['14:00', '24:00']], [], [], [], [], [], [['14:00', '24:00']]]);
  assert.deepEqual(workWeekly({ workDays: [], workStart: '09:00', workEnd: '17:00' }), none());
  // Settings that don't make a range fall back to the defaults.
  assert.deepEqual(workWeekly({ workDays: [3], workStart: '17:00', workEnd: '09:00' })[3], [['09:00', '17:00']]);
  assert.deepEqual(workWeekly(null), workWeekly({ workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '17:00' }));
  const w = workWeekly({ workDays: [1], workStart: '08:00', workEnd: '12:00' });
  assert.notEqual(w[1][0], workWeekly({ workDays: [1], workStart: '08:00', workEnd: '12:00' })[1][0], 'fresh arrays every time');
  assert.equal(isWeekly(w), true);
});

test('free times as text, one line per day, in the locale\'s own form', () => {
  const zone = 'Europe/Amsterdam';
  const windows = [
    [z('2026-11-03T13:00:00Z'), z('2026-11-03T14:00:00Z')],
    [z('2026-11-03T09:00:00Z'), z('2026-11-03T10:30:00Z')],
    [z('2026-11-04T08:00:00Z'), z('2026-11-04T09:00:00Z')]
  ];
  assert.deepEqual(formatFreeTimes(windows, { locale: 'en-GB', timeZone: zone }), ['Tue 3 Nov: 10:00–11:30, 14:00–15:00', 'Wed 4 Nov: 09:00–10:00']);
  assert.deepEqual(formatFreeTimes(windows, { locale: 'nl-NL', timeZone: zone }), ['di 3 nov: 10:00–11:30, 14:00–15:00', 'wo 4 nov: 09:00–10:00']);
  assert.deepEqual(formatFreeTimes(windows, { locale: 'en-GB', timeZone: zone, hour12: true }), ['Tue 3 Nov: 10:00 am – 11:30 am, 2:00 pm – 3:00 pm', 'Wed 4 Nov: 9:00 am – 10:00 am']);
  assert.deepEqual(formatFreeTimes(windows, { locale: 'en-US', timeZone: zone }), ['Tue, Nov 3: 10:00 AM – 11:30 AM, 2:00 PM – 3:00 PM', 'Wed, Nov 4: 9:00 AM – 10:00 AM']);
  assert.deepEqual(formatFreeTimes(windows, { locale: 'en-US', timeZone: zone, hour12: false }), ['Tue, Nov 3: 10:00–11:30, 14:00–15:00', 'Wed, Nov 4: 09:00–10:00']);
  // The same moments in another zone fall on other days and times.
  assert.deepEqual(formatFreeTimes(windows, { locale: 'en-GB', timeZone: 'Australia/Sydney' }), ['Tue 3 Nov: 20:00–21:30', 'Wed 4 Nov: 00:00–01:00, 19:00–20:00']);
  assert.deepEqual(formatFreeTimes([], { locale: 'en-GB', timeZone: zone }), []);
  assert.throws(() => formatFreeTimes(windows, { locale: 'en-GB', timeZone: 'Mars/Olympus' }), RangeError);
});

test('free times past midnight are split over their days, and the end of a day reads 24:00', () => {
  const zone = 'Europe/Amsterdam';
  const long = [[z('2026-11-03T16:00:00Z'), z('2026-11-05T08:00:00Z')]];
  assert.deepEqual(formatFreeTimes(long, { locale: 'en-GB', timeZone: zone }), ['Tue 3 Nov: 17:00–24:00', 'Wed 4 Nov: 00:00–24:00', 'Thu 5 Nov: 00:00–09:00']);
  assert.deepEqual(formatFreeTimes(long, { locale: 'en-US', timeZone: zone }), ['Tue, Nov 3: 5:00 PM – 12:00 AM', 'Wed, Nov 4: 12:00 AM – 12:00 AM', 'Thu, Nov 5: 12:00 AM – 9:00 AM']);
  // The 25-hour day is one piece, not two.
  const autumn = [[zonedInstant('2026-10-25', '00:00', zone), zonedInstant('2026-10-26', '00:00', zone)]];
  assert.deepEqual(formatFreeTimes(autumn, { locale: 'en-GB', timeZone: zone }), ['Sun 25 Oct: 00:00–24:00']);
  // Santiago's 6 September starts at 01:00, so 5 September ends there.
  const santiago = formatFreeTimes([[z('2026-09-05T20:00:00Z'), z('2026-09-06T06:00:00Z')]], { locale: 'en-GB', timeZone: 'America/Santiago' });
  assert.equal(santiago.length, 2);
  assert.match(santiago[0], /^Sat 5 \S+: 16:00–24:00$/);
  assert.match(santiago[1], /^Sun 6 \S+: 01:00–03:00$/);
});

test('free-time text never offers a second that isn\'t free', () => {
  const zone = 'UTC';
  const windows = [[z('2026-11-03T10:00:30Z'), z('2026-11-03T10:30:59Z')], [z('2026-11-03T11:00:10Z'), z('2026-11-03T11:00:50Z')]];
  assert.deepEqual(formatFreeTimes(windows, { locale: 'en-GB', timeZone: zone }), ['Tue 3 Nov: 10:01–10:30']);
  // Overlapping input is merged first.
  assert.deepEqual(formatFreeTimes([[z('2026-11-03T10:00:00Z'), z('2026-11-03T11:00:00Z')], [z('2026-11-03T10:30:00Z'), z('2026-11-03T12:00:00Z')]], { locale: 'en-GB', timeZone: zone }), ['Tue 3 Nov: 10:00–12:00']);
});
