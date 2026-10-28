import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from './fixtures/booking-vectors.json' with { type: 'json' };
import { sha256, utf8 } from '../src/bytes.js';
import { open } from '../src/seal.js';
import { call, login, signup } from './helpers.js';
import { DAY, HOUR, MINUTE, bookingStub, host, hostKey, meetingType, newHandle, page, publish, slotAhead } from './booking-helpers.js';

afterEach(() => vi.useRealTimers());

const TIMES = { staleMs: 24 * HOUR, darkMs: 7 * DAY };
let net = 0;

function later(ms) {
  vi.setSystemTime(Date.now() + ms);
}

function bookDirect(handle, start, overrides = {}) {
  net += 1;
  return bookingStub(handle).book(
    {
      type: '30min',
      start,
      name: 'Jane Doe',
      email: `jane-${net}@example.com`,
      notes: 'Kickoff',
      timeZone: 'Europe/Amsterdam',
      locale: 'en',
      via: '',
      channel: 'api',
      idempotencyKey: null,
      network: `10.${net % 250}.${Math.floor(net / 250)}.0/24`,
      uidHost: 'accounts.example',
      ...overrides
    },
    TIMES
  );
}

function list(person, query = '') {
  return call('GET', `/v1/booking/bookings${query}`, { token: person.token });
}

function act(person, id, body) {
  return call('POST', `/v1/booking/bookings/${id}`, { token: person.token, body });
}

async function sql(handle, query, ...args) {
  return runInDurableObject(bookingStub(handle), (i, state) => state.storage.sql.exec(query, ...args).toArray());
}

describe('bookings for the host’s devices', () => {
  it('lists bookings after a cursor, with the sealed details the host can open', async () => {
    const { person, key, handle } = await host(signup);
    const a = await bookDirect(handle, slotAhead(2), { name: 'Zoë <b>Ångström</b>', notes: 'line one\nline two', via: 'ChatGPT' });
    const b = await bookDirect(handle, slotAhead(3));
    expect(a.outcome).toBe('created');
    const res = await list(person);
    expect(res.status).toBe(200);
    expect(res.body.seq).toBe(2);
    expect(res.body.more).toBe(false);
    const [first, second] = res.body.bookings;
    expect(first).toEqual({
      id: a.booking.id,
      type: '30min',
      start: slotAhead(2),
      end: slotAhead(2) + 30 * MINUTE,
      status: 'confirmed',
      version: 1,
      handledVersion: 0,
      seq: 1,
      sealed: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      channel: 'api',
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      expiresAt: null,
      reschedules: 0,
      uid: `${a.booking.id}@accounts.example`,
      notify: true,
      cancelledBy: null,
      reason: null,
      message: null,
      bookedStart: slotAhead(2),
      bookedEnd: slotAhead(2) + 30 * MINUTE
    });
    expect(second.id).toBe(b.booking.id);
    const details = JSON.parse(await open({ privatePkcs8: key.privatePkcs8, handle, bookingId: first.id, blob: first.sealed }));
    expect(details).toEqual({
      name: 'Zoë <b>Ångström</b>',
      email: expect.stringMatching(/@example\.com$/),
      notes: 'line one\nline two',
      timeZone: 'Europe/Amsterdam',
      locale: 'en',
      via: 'ChatGPT',
      manageKey: a.key,
      type: '30min',
      start: first.start,
      end: first.end
    });
    expect(Object.keys(details)).toEqual(Object.keys(vectors.seal[0].plaintext));
    // Only the key's hash is stored.
    const [row] = await sql(handle, 'SELECT keyHash FROM bookings WHERE id = ?', a.booking.id);
    expect(new Uint8Array(row.keyHash)).toEqual(await sha256(utf8(a.key)));

    expect((await list(person, '?since=1')).body.bookings.map((x) => x.id)).toEqual([b.booking.id]);
    const page1 = await list(person, '?limit=1');
    expect(page1.body.bookings).toHaveLength(1);
    expect(page1.body.more).toBe(true);
    expect((await list(person, '?limit=0')).status).toBe(400);
  });

  it('confirms, declines, cancels and reschedules, one version at a time', async () => {
    const { person, handle } = await host(signup, { profile: { types: [meetingType({ confirm: true })] } });
    const pending = await bookDirect(handle, slotAhead(2));
    const declined = await bookDirect(handle, slotAhead(3));
    expect(pending.booking).toMatchObject({ status: 'pending', expiresAt: expect.any(Number) });
    let rows = (await list(person)).body.bookings;
    expect(rows[0].notify).toBe(false);

    const confirmed = await act(person, pending.booking.id, { action: 'confirm', version: 1 });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.booking).toMatchObject({ status: 'confirmed', version: 2, seq: 3, notify: true, expiresAt: null });
    expect(confirmed.body.booking.sealed).not.toBe(null);
    const again = await act(person, pending.booking.id, { action: 'confirm', version: 2 });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'stale_version', booking: { status: 'confirmed', version: 2 } });
    const old = await act(person, pending.booking.id, { action: 'cancel', version: 1 });
    expect(old.body.error).toBe('stale_version');

    const no = await act(person, declined.booking.id, { action: 'decline', version: 1, message: 'Sorry, I’m away that week.' });
    expect(no.body.booking).toMatchObject({ status: 'declined', version: 2, sealed: null, notify: false, message: 'Sorry, I’m away that week.' });

    // Off the grid with host: true; only open times without it.
    const odd = slotAhead(4, '22:10');
    const refused = await act(person, pending.booking.id, { action: 'reschedule', version: 2, start: odd });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('slot_taken');
    expect(refused.body.alternatives).toHaveLength(3);
    expect(refused.body.alternatives.every((t) => typeof t === 'number')).toBe(true);
    const moved = await act(person, pending.booking.id, { action: 'reschedule', version: 2, start: odd, host: true });
    expect(moved.body.booking).toMatchObject({ start: odd, end: odd + 30 * MINUTE, version: 3, notify: false, bookedStart: slotAhead(2) });

    const gone = await act(person, pending.booking.id, { action: 'cancel', version: 3, reason: 'host_deleted', message: 'Removed from my calendar.' });
    expect(gone.body.booking).toMatchObject({
      status: 'cancelled',
      version: 4,
      cancelledBy: 'host',
      reason: 'host_deleted',
      message: 'Removed from my calendar.',
      sealed: null,
      notify: false
    });
    // Six changes so far: two bookings, confirm, decline, reschedule, cancel. The cursor only shows what came after.
    rows = (await list(person, '?since=4')).body.bookings;
    expect(rows.map((r) => [r.status, r.seq])).toEqual([['cancelled', 6]]);
  });

  it("doesn't cancel a booking whose meeting is over", async () => {
    const { person, handle } = await host(signup);
    const b = await bookDirect(handle, slotAhead(2));
    later(3 * DAY);
    const res = await act(person, b.booking.id, { action: 'cancel', version: 1, reason: 'host_cancelled' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'not_active', booking: { status: 'confirmed', version: 1 } });
  });

  it('records what a device handled without making a change', async () => {
    const { person, handle } = await host(signup);
    const b = await bookDirect(handle, slotAhead(2));
    const res = await act(person, b.booking.id, { action: 'handled', version: 1 });
    expect(res.body.booking).toMatchObject({ handledVersion: 1, version: 1, seq: 1 });
    expect((await act(person, b.booking.id, { action: 'handled', version: 0 })).status).toBe(400);
    const above = await act(person, b.booking.id, { action: 'handled', version: 2 });
    expect(above.status).toBe(400);
    expect(above.body.field).toBe('version');
    expect((await list(person)).body.seq).toBe(1);
  });

  it('takes actions only from the booking device, and 404s for unknown bookings', async () => {
    const { person, handle } = await host(signup);
    const b = await bookDirect(handle, slotAhead(2));
    const second = (await login(person)).body;
    const res = await act({ token: second.token }, b.booking.id, { action: 'cancel', version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('other_device');
    expect((await list({ token: second.token })).body.bookings).toHaveLength(1);
    for (const id of ['A'.repeat(22), 'short', 'x'.repeat(23)]) {
      const missing = await act(person, id, { action: 'cancel', version: 1 });
      expect(missing.status, id).toBe(404);
      expect(missing.body.error).toBe('not_found');
    }
    const bad = await act(person, b.booking.id, { action: 'delete', version: 1 });
    expect(bad.body).toMatchObject({ error: 'invalid', field: 'action' });
  });

  it('lets an unconfirmed request lapse 48 hours after it was made', async () => {
    const { person, handle } = await host(signup, { profile: { types: [meetingType({ confirm: true })] } });
    const b = await bookDirect(handle, slotAhead(6));
    expect(b.booking.expiresAt).toBe(b.booking.createdAt + 48 * HOUR);
    later(48 * HOUR + MINUTE);
    const [row] = (await list(person)).body.bookings;
    expect(row).toMatchObject({ status: 'expired', version: 2, seq: 2, sealed: null, notify: false, expiresAt: null });
    expect((await act(person, b.booking.id, { action: 'confirm', version: 2 })).body.error).toBe('stale_version');
  });

  it('lapses a request at its start minus the minimum notice when that comes first', async () => {
    const { person, handle } = await host(signup, { profile: { types: [meetingType({ confirm: true, minNotice: 60 })] } });
    const start = slotAhead(1, '16:00');
    const b = await bookDirect(handle, start);
    expect(b.booking.expiresAt).toBe(start - HOUR);
    vi.setSystemTime(start - HOUR);
    expect((await list(person)).body.bookings[0].status).toBe('expired');
  });
});

describe('the mail budget, per booking version', () => {
  it('turns bookings into requests past 10 invitations a day, and mutes guest cancellations past it', async () => {
    const { person, handle } = await host(signup, { profile: { dailyCap: 50 } });
    const made = [];
    for (let i = 0; i < 10; i++) made.push(await bookDirect(handle, slotAhead(2 + Math.floor(i / 8), `${String(9 + (i % 8)).padStart(2, '0')}:00`)));
    expect(made.every((b) => b.booking.status === 'confirmed')).toBe(true);
    const eleventh = await bookDirect(handle, slotAhead(5));
    expect(eleventh.booking.status).toBe('pending');
    const view = await call('GET', '/v1/booking', { token: person.token });
    expect(view.body.today).toEqual({ bookings: 11, cap: 50, mail: 10, mailMax: 10 });

    // Past the budget a guest can't move a confirmed booking: that would mail again.
    const moved = await bookingStub(handle).guestReschedule(made[1].booking.id, await sha256(utf8(made[1].key)), slotAhead(6), TIMES);
    expect(moved).toMatchObject({ ok: false, error: 'limit_reached', limit: 'mail' });

    const keyHash = await sha256(utf8(made[0].key));
    const cancelled = await bookingStub(handle).guestCancel(made[0].booking.id, keyHash, TIMES);
    expect(cancelled.booking.status).toBe('cancelled');
    const rows = (await list(person)).body.bookings;
    expect(rows.find((r) => r.id === made[0].booking.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'guest', notify: false });

    // The host's own confirm always sends, and still counts.
    const ok = await act(person, eleventh.booking.id, { action: 'confirm', version: 1 });
    expect(ok.body.booking.notify).toBe(true);
    expect((await call('GET', '/v1/booking', { token: person.token })).body.today.mail).toBe(11);
  });

  it('lets a guest cancellation within the budget send mail', async () => {
    const { person, handle } = await host(signup);
    const b = await bookDirect(handle, slotAhead(2));
    await bookingStub(handle).guestCancel(b.booking.id, await sha256(utf8(b.key)), TIMES);
    const [row] = (await list(person, '?since=1')).body.bookings;
    expect(row).toMatchObject({ status: 'cancelled', cancelledBy: 'guest', reason: null, notify: true, version: 2 });
  });
});

describe('guest reschedules on a stale page', () => {
  it('refuses to move a confirmed booking, moves a pending one, and still cancels', async () => {
    const { handle } = await host(signup);
    const stub = bookingStub(handle);
    const start = slotAhead(3);
    const confirmed = await bookDirect(handle, start);
    expect(confirmed.booking.status).toBe('confirmed');
    later(25 * HOUR);
    const pending = await bookDirect(handle, slotAhead(4));
    expect(pending.booking.status).toBe('pending');
    const confirmedKey = await sha256(utf8(confirmed.key));
    const refused = await stub.guestReschedule(confirmed.booking.id, confirmedKey, slotAhead(5), TIMES);
    expect(refused).toMatchObject({ ok: false, error: 'limit_reached', limit: 'stale' });
    expect((await stub.guestGet(confirmed.booking.id, confirmedKey, TIMES)).booking).toMatchObject({ start, reschedules: 0, version: 1 });
    const moved = await stub.guestReschedule(pending.booking.id, await sha256(utf8(pending.key)), slotAhead(6), TIMES);
    expect(moved).toMatchObject({ ok: true, booking: { status: 'pending', start: slotAhead(6), reschedules: 1 } });
    expect((await stub.guestCancel(confirmed.booking.id, confirmedKey, TIMES)).booking.status).toBe('cancelled');
  });
});

describe('the calendar file’s SEQUENCE', () => {
  it('counts moves of the confirmed booking, not status changes or moves while it waited', async () => {
    const { person, handle } = await host(signup, { profile: { types: [meetingType({ confirm: true })] } });
    const stub = bookingStub(handle);
    const b = await bookDirect(handle, slotAhead(3));
    const hash = await sha256(utf8(b.key));
    // Moved while it waits for the host: the host's invitation is made at the confirm, and starts at 0.
    expect((await stub.guestReschedule(b.booking.id, hash, slotAhead(4), TIMES)).booking).toMatchObject({ version: 2, sequence: 0 });
    expect((await act(person, b.booking.id, { action: 'confirm', version: 2 })).status).toBe(200);
    expect((await stub.guestGet(b.booking.id, hash, TIMES)).booking).toMatchObject({ status: 'confirmed', version: 3, sequence: 0 });
    expect((await stub.guestReschedule(b.booking.id, hash, slotAhead(5), TIMES)).booking).toMatchObject({ version: 4, sequence: 1 });
    expect((await act(person, b.booking.id, { action: 'reschedule', version: 4, start: slotAhead(6, '15:10'), host: true })).status).toBe(200);
    expect((await stub.guestGet(b.booking.id, hash, TIMES)).booking).toMatchObject({ version: 5, sequence: 2 });
  });
});

describe('one synchronous stretch per booking', () => {
  it('books one slot twice at once and takes exactly one', async () => {
    const { handle } = await host(signup);
    const start = slotAhead(3);
    const results = await Promise.all([bookDirect(handle, start), bookDirect(handle, start), bookDirect(handle, start)]);
    expect(results.filter((r) => r.ok && r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === 'slot_taken')).toHaveLength(2);
  });
});

describe('the daily alarm', () => {
  it('returns early in an object without tables and leaves it empty', async () => {
    const stub = bookingStub(newHandle('empty'));
    const names = await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      return state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray();
    });
    expect(names).toEqual([]);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it('purges old bookings and idempotency entries, and schedules itself again', async () => {
    const { handle } = await host(signup);
    const done = await bookDirect(handle, slotAhead(1), { idempotencyKey: 'retry-me-0123456789' });
    const cancelled = await bookDirect(handle, slotAhead(9));
    await bookingStub(handle).guestCancel(cancelled.booking.id, await sha256(utf8(cancelled.key)), TIMES);
    const kept = await bookDirect(handle, slotAhead(20));
    expect((await sql(handle, 'SELECT COUNT(*) AS n FROM idem'))[0].n).toBe(1);
    later(2 * DAY);
    expect(await runDurableObjectAlarm(bookingStub(handle))).toBe(true);
    expect((await sql(handle, 'SELECT COUNT(*) AS n FROM idem'))[0].n).toBe(0);
    later(30 * DAY);
    await runDurableObjectAlarm(bookingStub(handle));
    const ids = (await sql(handle, 'SELECT id FROM bookings')).map((r) => r.id);
    expect(ids).not.toContain(done.booking.id);
    expect(ids).not.toContain(cancelled.booking.id);
    expect(ids).toContain(kept.booking.id);
    const alarm = await runInDurableObject(bookingStub(handle), (i, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now());
  });

  // The page's owner becomes an account name nobody has.
  async function orphan(handle) {
    await runInDurableObject(bookingStub(handle), (i, state) => {
      state.storage.sql.exec('UPDATE page SET owner = ?, checkedAt = 0', 'N'.repeat(43));
    });
  }

  // Runs the alarm with some of the Worker's vars changed, as after an operator edited wrangler.jsonc.
  async function alarmWith(handle, vars) {
    await runInDurableObject(bookingStub(handle), async (instance) => {
      const saved = instance.env;
      instance.env = { ...saved, ...vars };
      try {
        await instance.alarm();
      } finally {
        instance.env = saved;
      }
    });
  }

  it('wipes a page whose account is missing on two checks a day apart, keeping the handle reserved for nobody', async () => {
    const { handle } = await host(signup);
    await bookDirect(handle, slotAhead(3));
    await orphan(handle);
    await runDurableObjectAlarm(bookingStub(handle));
    // Once isn't enough: the page and its bookings stay, and the next check is a day later.
    let [p] = await sql(handle, 'SELECT profile, retiredAt, missingSince FROM page');
    expect(p).toMatchObject({ profile: expect.any(String), retiredAt: null, missingSince: expect.any(Number) });
    await runDurableObjectAlarm(bookingStub(handle));
    expect((await sql(handle, 'SELECT profile FROM page'))[0].profile).not.toBe(null);
    later(DAY);
    await runDurableObjectAlarm(bookingStub(handle));
    [p] = await sql(handle, 'SELECT owner, profile, retiredAt, enabled, missingSince FROM page');
    // Not for the account's routing name either: a new sign-up with the same email would match it.
    expect(p).toMatchObject({ owner: expect.stringMatching(/^deleted:[A-Za-z0-9_-]{43}$/), profile: null, enabled: 0, retiredAt: expect.any(Number), missingSince: null });
    expect((await sql(handle, 'SELECT COUNT(*) AS n FROM bookings'))[0].n).toBe(0);
  });

  it('starts counting again when the account turns up between two checks', async () => {
    const { handle } = await host(signup);
    const [{ owner }] = await sql(handle, 'SELECT owner FROM page');
    await orphan(handle);
    await runDurableObjectAlarm(bookingStub(handle));
    await runInDurableObject(bookingStub(handle), (i, state) => {
      state.storage.sql.exec('UPDATE page SET owner = ?', owner);
    });
    later(DAY);
    await runDurableObjectAlarm(bookingStub(handle));
    expect((await sql(handle, 'SELECT missingSince FROM page'))[0].missingSince).toBe(null);
    await orphan(handle);
    later(DAY);
    await runDurableObjectAlarm(bookingStub(handle));
    expect((await sql(handle, 'SELECT profile FROM page'))[0].profile).not.toBe(null);
  });

  it('leaves the page alone while JURISDICTION is broken or not the one the page was claimed under', async () => {
    const { handle } = await host(signup);
    await bookDirect(handle, slotAhead(3));
    await orphan(handle);
    // A typo: the Worker answers not_configured, and the alarm doesn't look the account up in the wrong place.
    for (let day = 0; day < 3; day++) {
      await alarmWith(handle, { JURISDICTION: 'europe' });
      later(DAY);
    }
    // Claimed under "eu"; the operator then emptied the setting, which looks up accounts outside the EU.
    await runInDurableObject(bookingStub(handle), (i, state) => {
      state.storage.sql.exec("UPDATE page SET jurisdiction = 'eu'");
    });
    for (let day = 0; day < 3; day++) {
      await alarmWith(handle, { JURISDICTION: '' });
      later(DAY);
    }
    const [p] = await sql(handle, 'SELECT profile, retiredAt, missingSince, checkedAt FROM page');
    expect(p).toMatchObject({ profile: expect.any(String), retiredAt: null, missingSince: null, checkedAt: 0 });
    expect((await sql(handle, 'SELECT COUNT(*) AS n FROM bookings'))[0].n).toBe(1);
  });

  it('records the jurisdiction a page was claimed under', async () => {
    const { handle } = await host(signup);
    expect((await sql(handle, 'SELECT jurisdiction FROM page'))[0].jurisdiction).toBe('');
  });

  it('leaves a page whose account exists, and notes the check', async () => {
    const { handle } = await host(signup);
    await runDurableObjectAlarm(bookingStub(handle));
    const [p] = await sql(handle, 'SELECT profile, checkedAt, missingSince FROM page');
    expect(p.profile).not.toBe(null);
    expect(p.checkedAt).toBeGreaterThan(0);
    expect(p.missingSince).toBe(null);
  });

  it('drops the day’s network counters and salt once the host’s day is over, also when nobody books', async () => {
    const { person, handle } = await host(signup);
    await bookDirect(handle, slotAhead(3));
    // The same day, nothing goes.
    await runDurableObjectAlarm(bookingStub(handle));
    expect((await sql(handle, "SELECT COUNT(*) AS n FROM counters WHERE kind LIKE 'network:%'"))[0].n).toBe(1);
    expect((await sql(handle, 'SELECT daySalt FROM page'))[0].daySalt).not.toBe(null);
    later(2 * DAY);
    await runInDurableObject(bookingStub(handle), (instance) => instance.alarm());
    expect((await sql(handle, 'SELECT COUNT(*) AS n FROM counters'))[0].n).toBe(0);
    expect((await sql(handle, 'SELECT day, daySalt FROM page'))[0]).toEqual({ day: null, daySalt: null });
    // The next booking makes a new salt for its day, and the host's today starts at 0.
    expect((await call('GET', '/v1/booking', { token: person.token })).body.today).toMatchObject({ bookings: 0, mail: 0 });
    const next = await bookDirect(handle, slotAhead(5));
    expect(next.outcome).toBe('created');
    expect((await sql(handle, 'SELECT daySalt FROM page'))[0].daySalt).not.toBe(null);
    expect((await call('GET', '/v1/booking', { token: person.token })).body.today).toMatchObject({ bookings: 1 });
  });

  it('drops published data 60 days after the last publish, once no bookings lie ahead', async () => {
    const { person, key, handle } = await host(signup);
    later(61 * DAY);
    await runDurableObjectAlarm(bookingStub(handle));
    const view = await bookingStub(handle).view(TIMES);
    expect(view).toMatchObject({ state: 'page', profile: null, accepting: false });
    // The claim stays: the owner publishes again on the same handle.
    expect((await publish(person, page(handle, key))).status).toBe(200);
  });

  it('frees a handle 12 months after it was given up, and stops redirecting after 180 days', async () => {
    const { person, key, handle } = await host(signup);
    const next = newHandle('next');
    expect((await publish(person, page(next, key))).status).toBe(200);
    later(181 * DAY);
    await runDurableObjectAlarm(bookingStub(handle));
    expect((await bookingStub(handle).view(TIMES)).state).toBe('page');
    later(185 * DAY);
    await runDurableObjectAlarm(bookingStub(handle));
    const names = await runInDurableObject(bookingStub(handle), (i, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
    );
    expect(names).toEqual([]);
    expect(await runInDurableObject(bookingStub(handle), (i, state) => state.storage.getAlarm())).toBe(null);
    const stranger = await signup();
    expect((await publish(stranger, page(handle, await hostKey()))).status).toBe(200);
  });
});
