// Meeting types with several lengths (PROTOCOL.md, Slots and Public routes): the host publishes durations with
// duration as the default, and a guest picks one on the page, through the JSON API or MCP. Open times, the booking's
// end, its sealed details and the free time, notice and daily limits all follow the length picked; leaving it out
// means the default, and a type with one length works as before.

import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { open } from '../src/seal.js';
import { call, signup } from './helpers.js';
import { DAY, HOUR, book, bookingStub, guest, host, iso, meetingType, page, publish, slotAhead } from './booking-helpers.js';
import { zonedInstant, zonedParts } from '../src/zone.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ZONE = 'Europe/Amsterdam';
const TIMES = { staleMs: 24 * HOUR, darkMs: 7 * DAY };
const FORM = 'application/x-www-form-urlencoded';
// A type a guest takes for 15, 30 or 60 minutes, 30 by default, whose start times follow the length.
const CHAT = meetingType({ slug: 'chat', title: 'Chat', duration: 30, durations: [15, 30, 60], slotInterval: null, minNotice: 0 });
const amsterdam = (ms) => zonedParts(ms, ZONE);
const at = (day, time) => zonedInstant(amsterdam(slotAhead(day)).date, time, ZONE);
const slotOf = (ms) => iso(ms).replace(/:00Z$/, 'Z');

function decode(text) {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function slots(handle, query) {
  return call('GET', `/meet/${handle}/api/slots?${query}`);
}

// The open starts of one host-local day, as HH:MM.
async function dayTimes(handle, query, day) {
  const date = amsterdam(slotAhead(day)).date;
  const res = await slots(handle, `${query}&from=${date}&to=${date}`);
  expect(res.status).toBe(200);
  return res.body.slots.map((s) => amsterdam(Date.parse(s.start_utc)).time);
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

function mcp(name, args) {
  return call('POST', '/meet/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: { accept: 'application/json' } });
}

function stored(handle) {
  return runInDurableObject(bookingStub(handle), (instance, state) => JSON.parse(state.storage.sql.exec('SELECT profile FROM page').one().profile));
}

describe('publishing a type with several lengths', () => {
  it('keeps the lengths shortest first, duration as the default, and start times that follow the length', async () => {
    const h = await host(signup, { profile: { types: [{ ...CHAT, durations: [60, 15, 30] }] } });
    const [type] = (await stored(h.handle)).types;
    expect(type.duration).toBe(30);
    expect(type.durations).toEqual([15, 30, 60]);
    expect(type.slotInterval).toBe(null);
  });

  it('takes a publish without durations, as older apps send it: one length, start times every duration', async () => {
    const legacy = meetingType({ duration: 45 });
    delete legacy.durations;
    delete legacy.slotInterval;
    const h = await host(signup, { profile: { types: [legacy] } });
    const [type] = (await stored(h.handle)).types;
    expect(type.durations).toEqual([45]);
    expect(type.slotInterval).toBe(45);
  });

  it('refuses lengths without the default, a length twice, too many, or one that is no multiple of 5', async () => {
    const h = await host(signup);
    for (const [durations, field] of [
      [[15, 60], 'profile.types[0].durations'],
      [[30, 30], 'profile.types[0].durations'],
      [[5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], 'profile.types[0].durations'],
      [[30, 33], 'profile.types[0].durations[1]'],
      [[30, 600], 'profile.types[0].durations[1]'],
      ['30', 'profile.types[0].durations']
    ]) {
      const res = await publish(h.person, page(h.handle, h.key, { profile: { types: [{ ...CHAT, durations }] } }));
      expect(res.status, JSON.stringify(durations)).toBe(400);
      expect(res.body.field).toBe(field);
    }
  });
});

describe('open times for a length', () => {
  it('lists every length in the JSON overview, with duration as the default', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const res = await call('GET', `/meet/${h.handle}/api`);
    expect(res.body.types[0]).toMatchObject({ slug: 'chat', duration: 30, durations: [15, 30, 60] });
  });

  it('gives the default length without duration, and the picked one with it, each on its own grid', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const date = amsterdam(slotAhead(3)).date;
    const plain = await slots(h.handle, `type=chat&from=${date}&to=${date}`);
    expect(plain.body).toMatchObject({ type: 'chat', duration: 30, durations: [15, 30, 60] });
    expect(plain.body.slots).toHaveLength(16);
    expect(plain.body.slots[0].book_url).toBe(`https://accounts.example/meet/${h.handle}/chat?slot=${slotOf(at(3, '09:00'))}`);
    expect(plain.body.message).toBe('16 open times for 30 minutes. Send one of these start values exactly as listed to book.');

    const hour = await slots(h.handle, `type=chat&duration=60&from=${date}&to=${date}`);
    expect(hour.body.duration).toBe(60);
    // On the hour, 09:00 to 16:00: a meeting that starts at 16:30 would run past the 17:00 end of the open hours.
    expect(hour.body.slots.map((s) => amsterdam(Date.parse(s.start_utc)).time)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
    expect(Date.parse(hour.body.slots[0].end) - Date.parse(hour.body.slots[0].start)).toBe(HOUR);
    expect(hour.body.slots[0].book_url).toBe(`https://accounts.example/meet/${h.handle}/chat?slot=${slotOf(at(3, '09:00'))}&duration=60`);
    expect(hour.body.message).toBe('8 open times for 60 minutes. Send one of these start values exactly as listed, with duration 60, to book.');

    expect(await dayTimes(h.handle, 'type=chat&duration=15', 3)).toHaveLength(32);
  });

  it('keeps a step the host set for every length', async () => {
    const h = await host(signup, { profile: { types: [{ ...CHAT, slotInterval: 30 }] } });
    expect((await dayTimes(h.handle, 'type=chat&duration=60', 3)).slice(0, 3)).toEqual(['09:00', '09:30', '10:00']);
    expect(await dayTimes(h.handle, 'type=chat&duration=15', 3)).toHaveLength(16);
  });

  it('refuses a length the type doesn’t offer, naming the ones it does', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    for (const duration of ['45', 'abc', '0']) {
      const res = await slots(h.handle, `type=chat&duration=${duration}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid', field: 'duration' });
    }
    const res = await slots(h.handle, 'type=chat&duration=45');
    expect(res.body.message).toBe('This meeting type is 15, 30 or 60 minutes long. Send duration as one of: 15, 30, 60, or leave it out for the default.');
  });
});

describe('booking a length', () => {
  it('ends the booking, its sealed details and the host’s row at the length picked', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const start = at(3, '10:00');
    const res = await book(h.handle, { type: 'chat', duration: 60, start: iso(start), ...guest() });
    expect(res.status).toBe(201);
    expect(res.body.booking.duration).toBe(60);
    expect(Date.parse(res.body.booking.end_utc)).toBe(start + HOUR);
    const [row] = (await owned(h.person)).body.bookings;
    expect([row.end, row.bookedEnd]).toEqual([start + HOUR, start + HOUR]);
    const details = JSON.parse(await open({ privatePkcs8: h.key.privatePkcs8, handle: h.handle, bookingId: row.id, blob: row.sealed }));
    expect([details.start, details.end]).toEqual([start, start + HOUR]);
  });

  it('books the default length when duration is left out, and refuses one the type doesn’t offer', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const start = at(3, '10:00');
    const plain = await book(h.handle, { type: 'chat', start: iso(start), ...guest() });
    expect(plain.status).toBe(201);
    expect(plain.body.booking.duration).toBe(30);
    const odd = await book(h.handle, { type: 'chat', duration: 45, start: iso(at(3, '14:00')), ...guest() });
    expect(odd.status).toBe(400);
    expect(odd.body).toMatchObject({ error: 'invalid', field: 'duration' });
  });

  it('refuses a start the length doesn’t fit, offering the nearest that do at that length', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const res = await book(h.handle, { type: 'chat', duration: 60, start: iso(at(3, '16:30')), ...guest() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('slot_taken');
    expect(res.body.alternatives[0].book_url).toContain('&duration=60');
    for (const a of res.body.alternatives) expect(Date.parse(a.end) - Date.parse(a.start)).toBe(HOUR);
  });

  it('replays an Idempotency-Key for the same length and refuses it for another', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const body = { type: 'chat', duration: 60, start: iso(at(3, '10:00')), ...guest() };
    const headers = { 'idempotency-key': 'lengths-key-0123456789' };
    const first = await book(h.handle, body, { headers });
    const again = await book(h.handle, body, { headers });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.booking.id).toBe(first.body.booking.id);
    const other = await book(h.handle, { ...body, duration: 15 }, { headers });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('idempotency_mismatch');
  });

  it('books a length through MCP, which sends it as a string', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const date = amsterdam(slotAhead(3)).date;
    const found = await mcp('find_available_times', { link: `https://accounts.example/meet/${h.handle}/chat`, duration: '60', from: date, to: date });
    expect(found.body.result.structuredContent.duration).toBe(60);
    expect(found.body.result.content[0].text).toContain('8 open times for chat (60 minutes)');
    const start = found.body.result.structuredContent.slots[1].start;
    const booked = await mcp('book_meeting', { link: h.handle, type: 'chat', duration: '60', start, name: 'Jane Doe', email: 'jane@example.com' });
    expect(booked.body.result.isError).toBe(false);
    expect(booked.body.result.structuredContent.booking.duration).toBe(60);
    const types = await mcp('get_meeting_types', { link: h.handle });
    expect(types.body.result.content[0].text).toContain('15, 30 or 60 minutes (pick one with duration; default 30)');
  });
});

describe('free time, notice and limits for every length', () => {
  it('keeps free time around a booking of one length from times of every other length', async () => {
    const type = { ...CHAT, bufferAfter: 15 };
    const h = await host(signup, { profile: { types: [type] } });
    expect((await book(h.handle, { type: 'chat', duration: 60, start: iso(at(3, '10:00')), ...guest() })).status).toBe(201);
    // Busy 10:00 to 11:15 with the free time after it. A 15-minute meeting keeps its own 15 minutes after, so 09:30
    // still fits before it, and the first one after starts at 11:15.
    const short = await dayTimes(h.handle, 'type=chat&duration=15', 3);
    expect(short.slice(0, 4)).toEqual(['09:00', '09:15', '09:30', '11:15']);
    const long = await dayTimes(h.handle, 'type=chat&duration=60', 3);
    expect(long.slice(0, 1)).toEqual(['12:00']);
  });

  it('keeps the minimum notice for every length', async () => {
    const h = await host(signup, { profile: { types: [{ ...CHAT, minNotice: 2880 }] } });
    const earliest = Date.now() + 2 * DAY;
    for (const duration of [15, 30, 60]) {
      const res = await slots(h.handle, `type=chat&duration=${duration}`);
      expect(res.body.slots.length).toBeGreaterThan(0);
      for (const s of res.body.slots) expect(Date.parse(s.start_utc)).toBeGreaterThanOrEqual(earliest);
    }
  });

  it('counts a booking of any length toward the type’s limit per day', async () => {
    const h = await host(signup, { profile: { types: [{ ...CHAT, dailyLimit: 1 }] } });
    expect((await book(h.handle, { type: 'chat', duration: 15, start: iso(at(3, '10:00')), ...guest() })).status).toBe(201);
    for (const duration of [15, 30, 60]) expect(await dayTimes(h.handle, `type=chat&duration=${duration}`, 3)).toEqual([]);
    expect((await dayTimes(h.handle, 'type=chat&duration=60', 4)).length).toBeGreaterThan(0);
  });
});

describe('a type that changes while a booking is sealed', () => {
  // The host publishes a new profile while the guest's details are being sealed: the first seal of the attempt
  // swaps the page's profile underneath it, as a publish in between would.
  async function bookWhileChanging(h, input, changed) {
    return runInDurableObject(bookingStub(h.handle), async (instance, state) => {
      const generate = crypto.subtle.generateKey.bind(crypto.subtle);
      let swapped = false;
      vi.spyOn(crypto.subtle, 'generateKey').mockImplementation(async (...args) => {
        if (!swapped) {
          swapped = true;
          const profile = JSON.parse(state.storage.sql.exec('SELECT profile FROM page').one().profile);
          profile.types = [changed];
          state.storage.sql.exec('UPDATE page SET profile = ?, publishedAt = publishedAt + 1', JSON.stringify(profile));
        }
        return generate(...args);
      });
      return instance.book(
        {
          type: 'chat',
          duration: null,
          start: at(3, '10:00'),
          name: 'Jane Doe',
          email: 'jane@example.com',
          notes: '',
          timeZone: ZONE,
          locale: 'en',
          via: '',
          channel: 'api',
          idempotencyKey: null,
          network: '10.9.9.0/24',
          uidHost: 'accounts.example',
          ...input
        },
        TIMES
      );
    });
  }

  it('seals again at the new default length when the guest picked none', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const result = await bookWhileChanging(h, {}, { ...CHAT, duration: 60 });
    expect(result.ok).toBe(true);
    expect(result.booking.end - result.booking.start).toBe(HOUR);
    const [row] = (await owned(h.person)).body.bookings;
    const details = JSON.parse(await open({ privatePkcs8: h.key.privatePkcs8, handle: h.handle, bookingId: row.id, blob: row.sealed }));
    expect(details.end - details.start).toBe(HOUR);
    expect(row.bookedEnd).toBe(details.end);
  });

  it('books nothing when the length the guest picked went away', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const result = await bookWhileChanging(h, { duration: 60 }, { ...CHAT, durations: [15, 30] });
    expect(result).toMatchObject({ ok: false, error: 'unknown_duration', durations: [15, 30] });
    expect((await owned(h.person)).body.bookings).toEqual([]);
  });
});

describe('the booker', () => {
  const lengthLinks = (html) =>
    [...html.matchAll(/<a href="([^"]*)" data-swap="length-(\d+)"( aria-current="true")?>([^<]*)<\/a>/g)].map((m) => ({
      href: decode(m[1]),
      minutes: Number(m[2]),
      current: Boolean(m[3]),
      text: m[4]
    }));

  it('shows one link per length under the title, the default picked, each keeping the day', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const date = amsterdam(slotAhead(3)).date;
    const res = await call('GET', `/meet/${h.handle}/chat?date=${date}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div class="lengths" id="lengths" role="group" aria-label="Length">');
    const links = lengthLinks(res.text);
    expect(links.map((l) => [l.text, l.current])).toEqual([
      ['15 min', false],
      ['30 min', true],
      ['1 h', false]
    ]);
    const month = date.slice(0, 7);
    expect(links[0].href).toBe(`/meet/${h.handle}/chat?duration=15&month=${month}&date=${date}`);
    expect(links[1].href).toBe(`/meet/${h.handle}/chat?month=${month}&date=${date}`);
  });

  it('shows the times of the length picked, and every link and form on the page keeps it', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const date = amsterdam(slotAhead(3)).date;
    const res = await call('GET', `/meet/${h.handle}/chat?duration=60&date=${date}`);
    const html = decode(res.text);
    expect(lengthLinks(res.text).find((l) => l.current).minutes).toBe(60);
    const times = [...html.matchAll(/<a class="slot" href="([^"]*)"/g)].map((m) => m[1]);
    expect(times).toHaveLength(8);
    expect(times[0]).toBe(`/meet/${h.handle}/chat?duration=60&slot=${slotOf(at(3, '09:00'))}`);
    expect(html).toContain('<input type="hidden" name="duration" value="60">');
    expect(html).toMatch(/data-clock="12"/);
    expect(html).toContain(`/meet/${h.handle}/chat?duration=60&month=${date.slice(0, 7)}&date=${date}&clock=12`);
    // The language links keep it too; booker.js swaps them (#languages) when the length changes without a reload.
    expect(html).toContain(`<nav id="languages" aria-label="Language"><a href="/meet/${h.handle}/chat?duration=60&date=${date}&lang=en"`);
  });

  it('ignores a length the type doesn’t offer: the default is picked, and the times and lengths don’t carry it on', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const res = await call('GET', `/meet/${h.handle}/chat?duration=45`);
    expect(res.status).toBe(200);
    expect(lengthLinks(res.text).find((l) => l.current).minutes).toBe(30);
    for (const l of lengthLinks(res.text)) expect(l.href).not.toContain('duration=45');
    const times = [...decode(res.text).matchAll(/<a class="slot" href="([^"]*)"/g)].map((m) => m[1]);
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(t).not.toContain('duration');
    expect(res.text).not.toContain('name="duration"');
  });

  it('shows no picker for a type with one length', async () => {
    const h = await host(signup);
    const res = await call('GET', `/meet/${h.handle}/30min`);
    expect(res.text).not.toContain('id="lengths"');
    expect(res.text).toContain('<span>30 min</span>');
  });

  it('is in Dutch too', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const res = await call('GET', `/meet/${h.handle}/chat?lang=nl`);
    expect(res.text).toContain('aria-label="Duur"');
    expect(lengthLinks(res.text).map((l) => l.text)).toEqual(['15 min', '30 min', '1 uur']);
  });

  it('lists the lengths on the landing page', async () => {
    const h = await host(signup, { profile: { types: [CHAT, meetingType({ slug: 'other', title: 'Other' })] } });
    const res = await call('GET', `/meet/${h.handle}`);
    expect(res.text).toContain('<span>15 min, 30 min or 1 h</span>');
  });

  it('keeps a moving booking at its own length, without a picker', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const made = await book(h.handle, { type: 'chat', duration: 60, start: iso(at(3, '10:00')), ...guest() });
    const res = await call('GET', `/meet/${h.handle}/chat?reschedule=${made.body.booking.id}&k=${made.body.key}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('id="lengths"');
    expect(res.text).toContain('<span>1 h</span>');
  });
});

describe('the booking form', () => {
  it('posts the length it shows, and the booking gets it', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const start = at(3, '10:00');
    const form = await call('GET', `/meet/${h.handle}/chat?slot=${slotOf(start)}&duration=60`);
    expect(form.status).toBe(200);
    expect(form.text).toContain('<input type="hidden" name="duration" value="60">');
    expect(form.text).toContain('<span>1 h</span>');
    const idem = form.text.match(/name="idem" value="([^"]+)"/)[1];
    const res = await post(`/meet/${h.handle}/chat`, { start: slotOf(start), duration: '60', tz: ZONE, name: 'Jane Doe', email: 'jane@example.com', idem });
    expect(res.status).toBe(303);
    const [row] = (await owned(h.person)).body.bookings;
    expect(row.end - row.start).toBe(HOUR);
  });

  it('sends the default length too when the type has several, and none when it has one', async () => {
    const h = await host(signup, { profile: { types: [CHAT, meetingType()] } });
    const start = slotOf(at(3, '10:00'));
    expect((await call('GET', `/meet/${h.handle}/chat?slot=${start}`)).text).toContain('<input type="hidden" name="duration" value="30">');
    expect((await call('GET', `/meet/${h.handle}/30min?slot=${start}`)).text).not.toContain('name="duration"');
  });

  it('books nothing for a length the type no longer offers, and says so above the booker', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const res = await post(`/meet/${h.handle}/chat`, { start: slotOf(at(3, '10:00')), duration: '45', tz: ZONE, name: 'Jane Doe', email: 'jane@example.com' });
    expect(res.status).toBe(409);
    expect(decode(res.text)).toContain("That length isn't offered any more. Pick a length and a time below.".replace("'", '’'));
    expect(res.text).toContain('id="lengths"');
    expect((await owned(h.person)).body.bookings).toEqual([]);
  });
});

describe('llms.txt', () => {
  it('names the lengths, the default, and the open times link for each other length', async () => {
    const h = await host(signup, { profile: { types: [CHAT] } });
    const res = await call('GET', `/meet/${h.handle}/llms.txt`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('- chat: From "Bart van der Meeren": "Chat". 15, 30 or 60 minutes, as your user picks; 30 when you send no duration.');
    expect(res.text).toContain(`  For 60 minutes: https://accounts.example/meet/${h.handle}/api/slots?type=chat&duration=60`);
    expect(res.text).toContain('Add "duration" with the minutes');
  });

  it('stays as it was for types with one length', async () => {
    const h = await host(signup);
    const res = await call('GET', `/meet/${h.handle}/llms.txt`);
    expect(res.text).toContain('. 30 minutes. ');
    expect(res.text).not.toContain('duration');
  });
});
