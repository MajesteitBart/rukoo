// A session made in a browser (device platform web) uses the account and team chat, and nothing that reads or changes
// the encrypted records or the booking page (PROTOCOL.md, Sessions made in a browser). Its token sits in the site's
// local storage, so these tests check both sides: what such a session is refused, and that everything Rukoo in the
// browser needs still works for it.

import { describe, expect, it } from 'vitest';
import { KDF, call, device, key, pull, push, recordId, salt, sealed, signup } from './helpers.js';
import { DAY, HOUR, bookingStub, host, hostKey, newHandle, page, publish } from './booking-helpers.js';
import { api, channels, invite, newWorkspace, openSocket, post } from './workspace-helpers.js';

const TIMES = { staleMs: 24 * HOUR, darkMs: 7 * DAY };
const BROWSER = device('Firefox · Windows', 'web');

// A sign-in from the browser to an account a desktop made: the browser's token.
async function browserLogin(person) {
  const res = await call('POST', '/v1/login', { body: { email: person.email, authKey: person.authKey, device: BROWSER } });
  expect(res.status).toBe(200);
  return res.body.token;
}

function expectRefused(res) {
  expect(res.status).toBe(403);
  expect(res.body).toMatchObject({ error: 'browser_session' });
  expect(res.body.message).toEqual(expect.any(String));
}

describe('a session made in a browser', () => {
  it('can neither read nor write the records, and a push stores nothing', async () => {
    const person = await signup();
    const web = await browserLogin(person);
    expectRefused(await push(web, [{ id: recordId(), data: sealed(40) }]));
    expectRefused(await pull(web));
    expectRefused(await pull(web, '?since=0&limit=10'));

    // The desktop's session still syncs, and sees that the browser's push stored nothing.
    const before = await pull(person.token);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ records: [], seq: 0 });
    expect((await push(person.token, [{ id: recordId(), data: sealed(40) }])).status).toBe(200);
    expect((await pull(person.token)).body.records).toHaveLength(1);
    expectRefused(await pull(web));
    expect((await call('GET', '/v1/account', { token: person.token })).body.usage.records).toBe(1);

    // An ended browser session is told it ended, as everywhere else.
    expect((await call('POST', '/v1/logout', { token: web })).status).toBe(204);
    expect((await pull(web)).status).toBe(401);
  });

  it('is refused on every booking-owner route, and the page stays as the booking device left it', async () => {
    const { person, handle, key: pageKey } = await host(signup);
    const web = await browserLogin(person);

    expectRefused(await call('GET', '/v1/booking', { token: web }));
    expectRefused(await publish({ token: web }, page(handle, pageKey)));
    expectRefused(await publish({ token: web }, page(handle, pageKey, { takeover: true })));
    expectRefused(await publish({ token: web }, page(newHandle(), pageKey)));
    expectRefused(await call('DELETE', '/v1/booking', { token: web }));
    expectRefused(await call('GET', '/v1/booking/bookings', { token: web }));
    expectRefused(await call('GET', `/v1/booking/handles/${newHandle()}`, { token: web }));
    expectRefused(await call('POST', '/v1/booking/bookings/b_anything', { token: web, body: { action: 'confirm' } }));

    // The page is on, under its handle, with the desktop still its booking device.
    const view = await bookingStub(handle).view(TIMES);
    expect(view).toMatchObject({ state: 'page', accepting: true });
    const owner = await call('GET', '/v1/booking', { token: person.token });
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ handle, enabled: true, device: { current: true } });
    expect((await publish(person, page(handle, pageKey))).status).toBe(200);
  });

  it('keeps what it may do from when it was made, whatever other devices do', async () => {
    // Signed up in the browser: that session is the browser's.
    const person = await signup({ device: BROWSER });
    expect(person.account.devices).toEqual([expect.objectContaining({ platform: 'web', current: true })]);
    expectRefused(await pull(person.token));

    // A desktop signing in later gets a full session; the browser's stays as it was.
    const desktop = await call('POST', '/v1/login', { body: { email: person.email, authKey: person.authKey, device: device() } });
    expect(desktop.status).toBe(200);
    expect((await pull(desktop.body.token)).status).toBe(200);
    expect((await call('GET', '/v1/booking', { token: desktop.body.token })).status).toBe(200);
    expectRefused(await pull(person.token));

    // Recovering in the browser makes a browser session too.
    const recovered = await call('POST', '/v1/recover/finish', {
      body: { email: person.email, recoveryAuth: person.recoveryAuth, kdf: KDF, salt: salt(), authKey: key(), wrappedKey: sealed(), device: BROWSER }
    });
    expect(recovered.status).toBe(200);
    expectRefused(await pull(recovered.body.token));
    expectRefused(await call('GET', '/v1/booking', { token: recovered.body.token }));
  });

  it('still uses the account, its devices and team chat', async () => {
    const ws = await newWorkspace();
    const { secret } = await invite(ws.person, ws.id);
    const person = await signup({ device: BROWSER });
    const joined = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: person.token, body: { invite: secret, name: 'Wendy Web' } });
    expect(joined.status).toBe(201);

    expect((await api('GET', '/v1/workspaces', { token: person.token })).status).toBe(200);
    const general = (await channels(person, ws.id)).find((c) => c.name === 'general');
    expect((await post(person, ws.id, general.id, 'Hello from the browser')).status).toBe(201);
    const socket = await openSocket(person, ws.id);
    expect(socket.status).toBe(101);
    socket.socket.close(1000);

    // The account page: its devices, signing one out, and the password check before a deletion.
    const phone = await call('POST', '/v1/login', { body: { email: person.email, authKey: person.authKey, device: device('Phone', 'android') } });
    const account = await call('GET', '/v1/account', { token: person.token });
    expect(account.status).toBe(200);
    expect(account.body.devices.map((d) => [d.platform, d.current])).toEqual([
      ['web', true],
      ['android', false]
    ]);
    const phoneId = account.body.devices.find((d) => !d.current).id;
    expect((await call('DELETE', `/v1/devices/${phoneId}`, { token: person.token })).status).toBe(204);
    expect((await call('GET', '/v1/account', { token: phone.body.token })).status).toBe(401);
    expect((await call('POST', '/v1/password/check', { token: person.token, body: { authKey: person.authKey } })).status).toBe(204);

    expect((await call('POST', '/v1/logout', { token: person.token })).status).toBe(204);
    expect((await call('GET', '/v1/account', { token: person.token })).status).toBe(401);
  });

  it('can delete the account with the password, which wipes the booking page as from any device', async () => {
    const { person, handle } = await host(signup);
    const web = await browserLogin(person);
    expect((await call('DELETE', '/v1/account', { token: web, body: { authKey: key() } })).status).toBe(403);
    expect((await bookingStub(handle).view(TIMES)).accepting).toBe(true);

    const res = await call('DELETE', '/v1/account', { token: web, body: { authKey: person.authKey } });
    expect(res.status).toBe(204);
    expect(await bookingStub(handle).view(TIMES)).toMatchObject({ state: 'page', accepting: false, profile: null });
    // Without the handle key a desktop would send, the handle stays reserved for nobody.
    const again = await signup({ email: person.email });
    expect((await publish(again, page(handle, await hostKey()))).body.error).toBe('handle_reserved');
  });
});
