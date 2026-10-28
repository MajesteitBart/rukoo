// A moved booking keeps its length (PROTOCOL.md, Slots), also after the host shortened its type: every way to move it
// checks the new time at the booking's own length, and the times offered for the move are those that fit it.
//
// The page: a 60-minute type, booked at 10:00 three days ahead; then the host makes the type 30 minutes and gets
// busy from 10:30 to 11:00 two days later. On that day 10:00 is open for a new 30-minute booking, but not for the
// 60-minute one moving there; neither is 16:30, whose hour runs past the 17:00 end of the open hours.

import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, signup } from './helpers.js';
import { HOUR, MINUTE, book, guest, host, iso, meetingType, page, publish, slotAhead } from './booking-helpers.js';
import { checkSlot, listSlots, nextSlots } from '../src/public.js';
import { movingType } from '../src/slots.js';
import { zonedInstant, zonedParts } from '../src/zone.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ZONE = 'Europe/Amsterdam';
const LONG = meetingType({ slug: 'talk', title: 'Talk', duration: 60, slotInterval: 30 });
const amsterdam = (ms) => zonedParts(ms, ZONE);
const slotOf = (ms) => iso(ms).replace(/:00Z$/, 'Z');
const FORM = 'application/x-www-form-urlencoded';

function decode(text) {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function slotLinks(html) {
  return [...html.matchAll(/<a class="slot" href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => decode(m[1]));
}

function post(path, fields) {
  return call('POST', path, {
    body: new URLSearchParams(fields).toString(),
    contentType: FORM,
    headers: { origin: 'https://accounts.example', 'sec-fetch-site': 'same-origin' }
  });
}

function owned(person) {
  return call('GET', '/v1/booking/bookings', { token: person.token });
}

// A 60-minute booking on a type the host then shortened to 30 minutes, with busy time where only the hour collides.
async function shortened() {
  const h = await host(signup, { profile: { types: [LONG] } });
  const start = slotAhead(3);
  const res = await book(h.handle, { type: 'talk', start: iso(start), ...guest() });
  expect(res.status).toBe(201);
  expect(res.body.booking.status).toBe('confirmed');
  const target = slotAhead(5);
  const day = amsterdam(target).date;
  const busy = [[target + 30 * MINUTE, target + HOUR]];
  const again = await publish(h.person, page(h.handle, h.key, { profile: { types: [{ ...LONG, duration: 30 }] }, busy }));
  expect(again.status).toBe(200);
  return {
    ...h,
    id: res.body.booking.id,
    manageKey: res.body.key,
    start,
    target,
    day,
    busy: busy[0],
    late: zonedInstant(day, '16:30', ZONE),
    early: zonedInstant(day, '09:30', ZONE)
  };
}

// Whether an hour from a start runs into the busy time.
const collides = (start, [a, b]) => start < b && start + HOUR > a;

describe('movingType', () => {
  it('gives the type the booking’s length and keeps the rest; another type’s booking or none leaves it', () => {
    const short = meetingType({ duration: 30, bufferBefore: 5, bufferAfter: 10 });
    const t = 1_800_000_000_000;
    expect(movingType(short, { type: '30min', start: t, end: t + HOUR })).toEqual({ ...short, duration: 60 });
    expect(movingType(short, { type: '30min', start: t, end: t + 15 * MINUTE }).duration).toBe(15);
    expect(movingType(short, { type: '30min', start: t, end: t + 30 * MINUTE })).toBe(short);
    expect(movingType(short, { type: 'other', start: t, end: t + HOUR })).toBe(short);
    expect(movingType(short, null)).toBe(short);
  });
});

describe('moving a booking whose type got shorter', () => {
  it('keeps the booking’s length through the JSON API, and offers only times that fit it', async () => {
    const s = await shortened();
    const move = (start) => call('POST', `/meet/${s.handle}/api/bookings/${s.id}/reschedule`, { token: s.manageKey, body: { start: iso(start) } });

    // A new booking of the shortened type still gets 10:00.
    expect((await call('GET', `/meet/${s.handle}/api/slots?type=talk&from=${s.day}&to=${s.day}`)).body.slots.map((x) => Date.parse(x.start_utc))).toContain(s.target);

    const refused = await move(s.target);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('slot_taken');
    expect(refused.body.alternatives.length).toBeGreaterThan(0);
    for (const alt of refused.body.alternatives) {
      const at = Date.parse(alt.start_utc);
      expect(Date.parse(alt.end) - at).toBe(HOUR);
      expect(collides(at, s.busy)).toBe(false);
    }
    expect((await move(s.late)).body.error).toBe('slot_taken');

    const moved = await move(s.early);
    expect(moved.status).toBe(200);
    expect(Date.parse(moved.body.booking.start_utc)).toBe(s.early);
    expect(Date.parse(moved.body.booking.end_utc)).toBe(s.early + HOUR);
    expect((await owned(s.person)).body.bookings.at(-1)).toMatchObject({ id: s.id, start: s.early, end: s.early + HOUR, reschedules: 1 });
  });

  it('keeps it through the MCP tool', async () => {
    const s = await shortened();
    const tool = (args) => call('POST', '/meet/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reschedule_booking', arguments: args } },
      headers: { accept: 'application/json, text/event-stream' }
    });
    const refused = (await tool({ link: s.handle, booking_id: s.id, key: s.manageKey, start: iso(s.target) })).body.result;
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error).toBe('slot_taken');
    for (const alt of refused.structuredContent.alternatives) {
      expect(Date.parse(alt.end) - Date.parse(alt.start_utc)).toBe(HOUR);
      expect(collides(Date.parse(alt.start_utc), s.busy)).toBe(false);
    }
    const moved = (await tool({ link: s.handle, booking_id: s.id, key: s.manageKey, start: iso(s.early) })).body.result;
    expect(moved.isError).toBe(false);
    expect(Date.parse(moved.structuredContent.booking.end_utc)).toBe(s.early + HOUR);
  });

  it('keeps it on the guest’s pages: the booker, the confirmation and the manage form', async () => {
    const s = await shortened();
    const typePath = `/meet/${s.handle}/talk`;
    const moving = `${typePath}?reschedule=${s.id}&k=${s.manageKey}`;

    // The booker for the move offers the times an hour fits, and says how long the meeting is.
    const booker = await call('GET', `${moving}&date=${s.day}`);
    expect(booker.status).toBe(200);
    expect(booker.text).toContain('<span>60 min</span>');
    const offered = slotLinks(booker.text);
    expect(offered).toContain(`${moving}&slot=${slotOf(s.early)}`);
    expect(offered.some((h) => h.endsWith(`slot=${slotOf(s.target)}`))).toBe(false);
    expect(offered.some((h) => h.endsWith(`slot=${slotOf(s.late)}`))).toBe(false);
    // The booker for a new booking offers 10:00 for 30 minutes.
    const plain = await call('GET', `${typePath}?date=${s.day}`);
    expect(plain.text).toContain('<span>30 min</span>');
    expect(slotLinks(plain.text).some((h) => h.endsWith(`slot=${slotOf(s.target)}`))).toBe(true);

    // A link to 10:00 for the move shows it isn't open, with times that fit.
    const gone = await call('GET', `${moving}&slot=${slotOf(s.target)}`);
    expect(gone.status).toBe(200);
    expect(gone.text).not.toContain('Move your booking to this time?');
    expect(slotLinks(gone.text).length).toBeGreaterThan(0);
    // 09:30 asks to move it to 09:30 until 10:30.
    const confirm = await call('GET', `${moving}&slot=${slotOf(s.early)}`);
    expect(confirm.text).toContain('Move your booking to this time?');
    expect(confirm.text).toMatch(/<dt>New<\/dt><dd><strong>[^<]*09:30[^<]*10:30[^<]*<\/strong>/);
    expect(confirm.text).toContain('<span>60 min</span>');

    // Posting 10:00 from the manage page anyway is refused, and nothing moved.
    const refused = await post(`/meet/${s.handle}/booking/${s.id}`, { k: s.manageKey, action: 'reschedule', start: slotOf(s.target), tz: ZONE });
    expect(refused.status).toBe(409);
    expect(refused.text).toContain('<span>60 min</span>');
    expect((await owned(s.person)).body.bookings.at(-1)).toMatchObject({ id: s.id, start: s.start, end: s.start + HOUR, reschedules: 0 });
    const moved = await post(`/meet/${s.handle}/booking/${s.id}`, { k: s.manageKey, action: 'reschedule', start: slotOf(s.early), tz: ZONE });
    expect(moved.status).toBe(303);
    expect((await owned(s.person)).body.bookings.at(-1)).toMatchObject({ id: s.id, start: s.early, end: s.early + HOUR, reschedules: 1 });
  });

  it('lists, checks and finds the first open time at the booking’s length for the guest moving it, and only with its key', async () => {
    const s = await shortened();
    const exclude = { id: s.id, key: s.manageKey };
    const listed = (ex) => listSlots(env, s.handle, { type: 'talk', from: s.day, to: s.day, timeZone: ZONE, exclude: ex });
    const forMove = await listed(exclude);
    expect(forMove.starts).toContain(s.early);
    expect(forMove.starts).not.toContain(s.target);
    expect(forMove.starts).not.toContain(s.late);
    expect(forMove.type.duration).toBe(60);
    // Without the right key it is a new booking's listing: 30 minutes.
    for (const ex of [null, { id: s.id, key: 'wrong' }]) {
      const fresh = await listed(ex);
      expect(fresh.starts).toContain(s.target);
      expect(fresh.type.duration).toBe(30);
    }
    const check = await checkSlot(env, s.handle, { type: 'talk', start: s.target, exclude });
    expect(check).toMatchObject({ ok: true, open: false });
    expect(check.alternatives.every((a) => !collides(a, s.busy))).toBe(true);
    expect((await checkSlot(env, s.handle, { type: 'talk', start: s.target, exclude: null })).open).toBe(true);
    const next = await nextSlots(env, s.handle, { days: 31, limit: 400, slug: 'talk', exclude });
    expect(next.slots.talk).not.toContain(s.target);
    expect(next.slots.talk).not.toContain(s.late);
    expect(next.slots.talk).toContain(s.early);
  });

  it('keeps it when the host moves it to an open time, and lets the host put it anywhere with host: true', async () => {
    const s = await shortened();
    const act = (body) => call('POST', `/v1/booking/bookings/${s.id}`, { token: s.person.token, body });
    const refused = await act({ action: 'reschedule', version: 1, start: s.target });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('slot_taken');
    expect(refused.body.alternatives.length).toBeGreaterThan(0);
    expect(refused.body.alternatives.every((a) => !collides(a, s.busy))).toBe(true);
    expect((await act({ action: 'reschedule', version: 1, start: s.late })).body.error).toBe('slot_taken');
    const open = await act({ action: 'reschedule', version: 1, start: s.early });
    expect(open.body.booking).toMatchObject({ start: s.early, end: s.early + HOUR, version: 2 });
    const anywhere = await act({ action: 'reschedule', version: 2, start: s.target, host: true });
    expect(anywhere.body.booking).toMatchObject({ start: s.target, end: s.target + HOUR, version: 3 });
  });
});
