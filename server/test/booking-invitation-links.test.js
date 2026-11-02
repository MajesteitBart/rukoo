// The guest's links a host's device writes into a booking's invitation (src/main/booking/rules.js guestLinks, whose
// shapes test/booking-rules.test.js holds): <page>/<slug>?reschedule=<id>&k=<key> and <page>/booking/<id>?k=<key>,
// with <page> the address GET and PUT /v1/booking report. Opening them changes nothing, because mail services and
// link previews open links, and they keep working after the guest or the host moved the booking.

import { describe, expect, it } from 'vitest';
import { call, signup } from './helpers.js';
import { book, guest, host, iso, slotAhead } from './booking-helpers.js';

const FORM = 'application/x-www-form-urlencoded';
const ZONE = 'Europe/Amsterdam';

const pathOf = (link) => {
  const u = new URL(link);
  return `${u.pathname}${u.search}`;
};
const open = (link) => call('GET', pathOf(link), { origin: new URL(link).origin });
const amp = (text) => text.replace(/&/g, '&amp;');

function owned(person, id) {
  return call('GET', '/v1/booking/bookings', { token: person.token }).then((res) => res.body.bookings.find((b) => b.id === id));
}

describe('the links in a booking invitation', () => {
  it('open the move and the manage page, change nothing, and keep working after the guest and the host moved it', async () => {
    const h = await host(signup);
    const start = slotAhead(3);
    const res = await book(h.handle, { type: '30min', start: iso(start), ...guest() });
    expect(res.status).toBe(201);
    const id = res.body.booking.id;
    const key = res.body.key;
    const page = h.view.url;
    const reschedule = `${page}/30min?reschedule=${id}&k=${key}`;
    const manage = `${page}/booking/${id}?k=${key}`;
    // The manage page the guest got after booking is the same address.
    expect(res.body.manage_url).toBe(manage);

    const check = async (at, version) => {
      const shown = await open(manage);
      expect(shown.status).toBe(200);
      expect(shown.text).toContain('Cancel booking');
      // Its own Pick another time is the invitation's first link, as a path.
      expect(shown.text).toContain(`href="${amp(pathOf(reschedule))}"`);
      const moving = await open(reschedule);
      expect(moving.status).toBe(200);
      expect(moving.text).toContain('Pick a new time for your booking on');
      expect(await owned(h.person, id)).toMatchObject({ status: 'confirmed', start: at, version });
    };

    await check(start, 1);

    // The guest moves it from the manage page.
    const guestMoved = slotAhead(4);
    const moved = await call('POST', `/meet/${h.handle}/booking/${id}`, {
      body: new URLSearchParams({ k: key, action: 'reschedule', start: iso(guestMoved).replace(/:00Z$/, 'Z'), tz: ZONE }).toString(),
      contentType: FORM,
      headers: { origin: 'https://accounts.example', 'sec-fetch-site': 'same-origin' }
    });
    expect(moved.status).toBe(303);
    await check(guestMoved, 2);

    // The host moves the event in their calendar; the booking device reschedules it.
    const hostMoved = slotAhead(5);
    const again = await call('POST', `/v1/booking/bookings/${id}`, { token: h.person.token, body: { action: 'reschedule', version: 2, start: hostMoved, host: true } });
    expect(again.status).toBe(200);
    await check(hostMoved, 3);
  });
});
