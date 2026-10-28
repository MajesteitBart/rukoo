// Slots on the host's wall clock, checked at the clock changes of 2026 in the zones the desktop's zone tests use.
import { describe, expect, it } from 'vitest';
import { candidates, expiresAt, isOpen, merge, nearest, openSlots, resolveType } from '../src/slots.js';
import { addDays, isZone, zonedInstant, zonedParts } from '../src/zone.js';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const z = (iso) => Date.parse(iso);
const clock = (ms, zone) => {
  const p = zonedParts(ms, zone);
  return `${p.date} ${p.time} ${p.offset}`;
};

// The local times of a day's candidates inside [from, to) local.
function day(zone, date, { from = '00:00', to = '24:00', interval = 30, duration = interval } = {}) {
  const windows = [[zonedInstant(date, from, zone), zonedInstant(date, to, zone)]];
  return candidates({ windows, timeZone: zone, interval, duration, from: windows[0][0], to: windows[0][1] }).map((c) => ({
    utc: new Date(c.start).toISOString().slice(11, 16),
    local: zonedParts(c.start, zone).time,
    date: c.date
  }));
}

const locals = (list) => list.map((c) => c.local);

describe('the zone port matches the desktop module', () => {
  it('reads and writes clocks across the 2026 changes', () => {
    expect(clock(z('2026-03-29T01:00:00Z'), 'Europe/Amsterdam')).toBe('2026-03-29 03:00 120');
    expect(zonedInstant('2026-03-29', '02:30', 'Europe/Amsterdam')).toBe(z('2026-03-29T01:30:00Z'));
    expect(zonedInstant('2026-10-25', '02:30', 'Europe/Amsterdam')).toBe(z('2026-10-25T00:30:00Z'));
    expect(zonedInstant('2026-11-01', '01:30', 'America/New_York')).toBe(z('2026-11-01T05:30:00Z'));
    expect(zonedInstant('2026-04-05', '02:30', 'Australia/Sydney')).toBe(z('2026-04-04T15:30:00Z'));
    expect(zonedInstant('2026-09-06', '00:00', 'America/Santiago')).toBe(z('2026-09-06T04:00:00Z'));
    expect(zonedInstant('2026-04-04', '24:00', 'America/Santiago')).toBe(z('2026-04-05T04:00:00Z'));
    expect(zonedInstant('2026-10-04', '02:15', 'Australia/Lord_Howe')).toBe(z('2026-10-03T15:45:00Z'));
    expect(zonedInstant('2026-04-05', '01:45', 'Australia/Lord_Howe')).toBe(z('2026-04-04T14:45:00Z'));
    expect(zonedParts(z('2026-04-04T15:30:00Z'), 'Australia/Sydney')).toEqual({ date: '2026-04-05', time: '02:30', weekday: 0, offset: 660 });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('knows zone names from offsets and junk', () => {
    for (const name of ['UTC', 'Europe/Amsterdam', 'America/Argentina/Buenos_Aires', 'Australia/Lord_Howe']) expect(isZone(name)).toBe(true);
    for (const name of ['', 'Mars/Olympus', '+01:00', 'W. Europe Standard Time', '../etc', 'A'.repeat(65), null, 42]) expect(isZone(name)).toBe(false);
  });
});

describe('wall-clock candidates at clock changes', () => {
  it('Europe/Amsterdam: skips the spring hour and takes the first of the autumn one', () => {
    const spring = day('Europe/Amsterdam', '2026-03-29', { to: '05:00' });
    expect(locals(spring)).toEqual(['00:00', '00:30', '01:00', '01:30', '03:00', '03:30', '04:00', '04:30']);
    const autumn = day('Europe/Amsterdam', '2026-10-25', { to: '05:00' });
    expect(locals(autumn)).toEqual(['00:00', '00:30', '01:00', '01:30', '02:00', '02:30', '03:00', '03:30', '04:00', '04:30']);
    expect(autumn.find((c) => c.local === '02:00').utc).toBe('00:00');
    expect(autumn.find((c) => c.local === '03:00').utc).toBe('02:00');
    // A normal day around them steps as usual, all on the same date.
    const plain = day('Europe/Amsterdam', '2026-06-01', { from: '09:00', to: '12:00' });
    expect(locals(plain)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    expect(plain.every((c) => c.date === '2026-06-01')).toBe(true);
  });

  it('America/New_York: west of UTC', () => {
    expect(locals(day('America/New_York', '2026-03-08', { to: '04:00', interval: 60 }))).toEqual(['00:00', '01:00', '03:00']);
    const back = day('America/New_York', '2026-11-01', { to: '03:00', interval: 30 });
    expect(locals(back)).toEqual(['00:00', '00:30', '01:00', '01:30', '02:00', '02:30']);
    expect(back.find((c) => c.local === '01:30').utc).toBe('05:30');
    expect(back.find((c) => c.local === '02:00').utc).toBe('07:00');
  });

  it('Australia/Sydney: southern summer time', () => {
    expect(locals(day('Australia/Sydney', '2026-10-04', { from: '01:00', to: '04:00' }))).toEqual(['01:00', '01:30', '03:00', '03:30']);
    const april = day('Australia/Sydney', '2026-04-05', { from: '01:00', to: '04:00' });
    expect(locals(april)).toEqual(['01:00', '01:30', '02:00', '02:30', '03:00', '03:30']);
    expect(april.find((c) => c.local === '02:30').utc).toBe('15:30');
  });

  it('America/Santiago: the clock changes at midnight', () => {
    // 6 September has no 00:00: the day's first candidates are from 01:00.
    const september = day('America/Santiago', '2026-09-06', { to: '03:00' });
    expect(locals(september)).toEqual(['01:00', '01:30', '02:00', '02:30']);
    expect(september[0].utc).toBe('04:00');
    expect(september.every((c) => c.date === '2026-09-06')).toBe(true);
    // 4 April shows 23:00 to 23:59 twice; only the first counts, and 5 April starts after both.
    const april = day('America/Santiago', '2026-04-04', { from: '22:00', to: '24:00' });
    expect(locals(april)).toEqual(['22:00', '22:30', '23:00', '23:30']);
    expect(april.map((c) => c.utc)).toEqual(['01:00', '01:30', '02:00', '02:30']);
    expect(locals(day('America/Santiago', '2026-04-05', { to: '01:00' }))).toEqual(['00:00', '00:30']);
  });

  it('Australia/Lord_Howe: half-hour clock changes', () => {
    // 4 October: 02:00 jumps to 02:30.
    expect(locals(day('Australia/Lord_Howe', '2026-10-04', { from: '01:30', to: '03:00', interval: 15 }))).toEqual([
      '01:30',
      '01:45',
      '02:30',
      '02:45'
    ]);
    // 5 April: 02:00 goes back to 01:30, so 01:30 to 01:59 happens twice.
    const april = day('Australia/Lord_Howe', '2026-04-05', { from: '01:00', to: '02:30', interval: 15 });
    expect(locals(april)).toEqual(['01:00', '01:15', '01:30', '01:45', '02:00', '02:15']);
    expect(april.find((c) => c.local === '01:45').utc).toBe('14:45');
    expect(april.find((c) => c.local === '02:00').utc).toBe('15:30');
  });

  it('steps from local midnight each day, even when the step doesn’t divide the day', () => {
    const list = day('Europe/Amsterdam', '2026-06-01', { from: '00:00', to: '03:00', interval: 45 });
    expect(locals(list)).toEqual(['00:00', '00:45', '01:30', '02:15']);
  });

  it('needs the whole meeting inside one window', () => {
    const windows = [[z('2026-06-01T07:00:00Z'), z('2026-06-01T08:00:00Z')]];
    const list = candidates({ windows, timeZone: 'UTC', interval: 15, duration: 45, from: windows[0][0] - DAY, to: windows[0][1] + DAY });
    expect(list.map((c) => new Date(c.start).toISOString().slice(11, 16))).toEqual(['07:00', '07:15']);
  });
});

describe('open slots', () => {
  const zone = 'Europe/Amsterdam';
  const now = z('2026-11-02T08:00:00Z'); // Monday 09:00 in Amsterdam
  const type = {
    slug: '30min',
    duration: 30,
    bufferBefore: 0,
    bufferAfter: 0,
    minNotice: 240,
    horizon: 30,
    slotInterval: 30,
    dailyLimit: null,
    confirm: false,
    hidden: false,
    schedule: 'default'
  };
  const other = { ...type, slug: 'long', duration: 60, bufferBefore: 15, bufferAfter: 30 };
  const profile = { timeZone: zone, dailyCap: 20, types: [type, other] };
  const windowsFor = (dates, from = '09:00', to = '17:00') => ({
    default: dates.map((d) => [zonedInstant(d, from, zone), zonedInstant(d, to, zone)])
  });
  const at = (date, time) => zonedInstant(date, time, zone);
  const base = { profile, windows: windowsFor(['2026-11-02', '2026-11-03']), busy: [], bookings: [], type, now };
  const times = (list) => list.map((s) => `${s.date} ${zonedParts(s.start, zone).time}`);

  it('starts after the minimum notice and stops at the horizon', () => {
    const list = openSlots({ ...base, from: now, to: now + 2 * DAY });
    expect(times(list)[0]).toBe('2026-11-02 13:00');
    expect(times(list).at(-1)).toBe('2026-11-03 16:30');
    // A one-day horizon ends at 09:00 tomorrow, before that day's hours begin.
    const short = openSlots({ ...base, type: { ...type, horizon: 1 }, from: now, to: now + 2 * DAY });
    expect(times(short).at(-1)).toBe('2026-11-02 16:30');
  });

  it('keeps meetings and their buffers clear of busy times and other bookings', () => {
    const busy = [[at('2026-11-03', '10:00'), at('2026-11-03', '11:00')]];
    const list = times(openSlots({ ...base, busy, from: at('2026-11-03', '09:00'), to: at('2026-11-03', '12:00') }));
    expect(list).toEqual(['2026-11-03 09:00', '2026-11-03 09:30', '2026-11-03 11:00', '2026-11-03 11:30']);
    // With 15 minutes before and 30 after, 09:30 and 11:00 are too close.
    const buffered = { ...type, bufferBefore: 15, bufferAfter: 30 };
    const tight = times(openSlots({ ...base, type: buffered, busy, from: at('2026-11-03', '09:00'), to: at('2026-11-03', '12:00') }));
    expect(tight).toEqual(['2026-11-03 09:00', '2026-11-03 11:30']);
    // A booking of another type blocks with its own buffers: 'long' at 14:00 holds 13:45 to 15:30.
    const bookings = [{ id: 'b1', type: 'long', start: at('2026-11-03', '14:00'), end: at('2026-11-03', '15:00') }];
    const around = times(openSlots({ ...base, bookings, from: at('2026-11-03', '13:00'), to: at('2026-11-03', '16:00') }));
    expect(around).toEqual(['2026-11-03 13:00', '2026-11-03 15:30']);
    // The booking being rescheduled doesn't block itself.
    const self = times(openSlots({ ...base, bookings, exclude: 'b1', from: at('2026-11-03', '13:00'), to: at('2026-11-03', '16:00') }));
    expect(self).toHaveLength(6);
  });

  it('keeps each day under the type’s limit and the page’s cap', () => {
    const bookings = [
      { id: 'a', type: '30min', start: at('2026-11-03', '09:00'), end: at('2026-11-03', '09:30') },
      { id: 'b', type: 'long', start: at('2026-11-03', '11:00'), end: at('2026-11-03', '12:00') }
    ];
    const limited = openSlots({ ...base, type: { ...type, dailyLimit: 1 }, bookings, from: now, to: now + 2 * DAY });
    expect(limited.every((s) => s.date === '2026-11-02')).toBe(true);
    const capped = openSlots({ ...base, profile: { ...profile, dailyCap: 2 }, bookings, from: now, to: now + 2 * DAY });
    expect(capped.every((s) => s.date === '2026-11-02')).toBe(true);
    expect(openSlots({ ...base, bookings, from: now, to: now + 2 * DAY }).some((s) => s.date === '2026-11-03')).toBe(true);
  });

  it('offers nothing on a dark page', () => {
    expect(openSlots({ ...base, dark: true, from: now, to: now + 2 * DAY })).toEqual([]);
  });

  it('says whether one start is open, and finds the nearest others', () => {
    expect(isOpen({ ...base }, at('2026-11-03', '10:00'))).toBe(true);
    expect(isOpen({ ...base }, at('2026-11-03', '10:15'))).toBe(false);
    expect(isOpen({ ...base }, at('2026-11-02', '10:00'))).toBe(false);
    const busy = [[at('2026-11-03', '10:00'), at('2026-11-03', '11:00')]];
    const near = nearest({ ...base, busy }, at('2026-11-03', '10:00'));
    // 09:00 and 11:00 are an hour away either side; the earlier one goes first.
    expect(near.map((t) => zonedParts(t, zone).time)).toEqual(['09:30', '09:00', '11:00']);
  });

  it('lets a request lapse at 48 hours or at its start minus the notice', () => {
    expect(expiresAt(0, 100 * HOUR, 240)).toBe(48 * HOUR);
    expect(expiresAt(0, 10 * HOUR, 240)).toBe(6 * HOUR);
  });

  it('picks the only visible type, or names the choices', () => {
    const hidden = { ...other, hidden: true };
    expect(resolveType({ types: [type, hidden] }, null).type.slug).toBe('30min');
    expect(resolveType({ types: [type, hidden] }, 'long').type.slug).toBe('long');
    expect(resolveType({ types: [type, other] }, null)).toEqual({ error: 'type_required', visible: ['30min', 'long'] });
    expect(resolveType({ types: [type] }, 'nope')).toEqual({ error: 'unknown_type', visible: ['30min'] });
  });

  it('merges overlapping intervals', () => {
    expect(merge([[5, 8], [1, 3], [2, 4], [8, 9], [10, 10]])).toEqual([[1, 4], [5, 9]]);
  });
});
