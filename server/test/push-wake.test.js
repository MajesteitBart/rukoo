// Push wakes for team chat (WORKSPACES.md, Push wakes): registering a session's push endpoint on a push service the
// server posts to, which activity sends a wake there and what it says, how a burst is held to one wake per window,
// what the push service's answers do, and that a device with a working socket hears of it there instead. The push
// service is test/fixtures/fake-push.js, whose hosts vitest.config.js lists in WORKSPACE_PUSH_ORIGINS.

import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vapidPublicKey } from '../src/webpush.js';
import { env } from 'cloudflare:workers';
import { FakePush, installFakePush, readVapid } from './fixtures/fake-push.js';
import { accountStub, call, login, signup } from './helpers.js';
import { ON, api, invite, newMember, newWorkspace, openSocket, post, startDm, until, workspaceStub } from './workspace-helpers.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let push;
let uninstall;
beforeEach(() => {
  push = new FakePush();
  uninstall = installFakePush(push);
});
afterEach(() => uninstall());

function register(token, device, vars = {}) {
  const body = device && { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth };
  return call('PUT', '/v1/push-endpoint', { token, body, vars: { ...ON, ...vars } });
}

function unregister(token, vars = {}) {
  return call('DELETE', '/v1/push-endpoint', { token, vars: { ...ON, ...vars } });
}

// Each session of an account and its endpoint, as the account object keeps them.
async function sessions(person) {
  return runInDurableObject(await accountStub(person.email), (instance, state) =>
    state.storage.sql.exec('SELECT id, wakeEndpoint, wakeAt FROM sessions ORDER BY createdAt, id').toArray()
  );
}

// Lets a session try many addresses, past the allowance a phone gets.
async function manyTries(person) {
  await runInDurableObject(await accountStub(person.email), (instance) => {
    instance.wakePutBurst = 1000;
  });
}

// Sets how long the account object waits between two wakes to one session.
async function pushWindow(person, ms) {
  await runInDurableObject(await accountStub(person.email), (instance) => {
    instance.pushWindow = ms;
  });
}

// A workspace with its owner Olga and a member Mila in general, and Mila's phone registered.
async function setUp() {
  const ws = await newWorkspace();
  const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
  const phone = await push.device();
  expect((await register(mila.person.token, phone)).status).toBe(204);
  return { ws, mila, phone };
}

async function dmWith(ws, member) {
  const started = await startDm(ws.person, ws.id, [member.me.id]);
  expect(started.status).toBe(201);
  return started.body.dm.conversation;
}

describe('GET /v1/info', () => {
  it('lists push-wake with the VAPID key while team chat is on', async () => {
    const info = await call('GET', '/v1/info', { vars: ON });
    expect(info.body.workspace.capabilities).toContain('push-wake');
    expect(info.body.workspace.push).toEqual({ vapid: await vapidPublicKey(env) });
    expect(info.body.workspace.push.vapid).toMatch(/^B[A-Za-z0-9_-]{86}$/);
  });

  it('leaves it out when WORKSPACE_PUSH is off, and registering answers 404', async () => {
    const off = { WORKSPACE_PUSH: 'off' };
    const info = await call('GET', '/v1/info', { vars: { ...ON, ...off } });
    expect(info.body.workspace.capabilities).not.toContain('push-wake');
    expect(info.body.workspace.push).toBeUndefined();
    const person = await signup();
    expect((await register(person.token, await push.device(), off)).status).toBe(404);
  });

  it('has neither the capability nor registration while team chat is off', async () => {
    const person = await signup();
    expect((await call('PUT', '/v1/push-endpoint', { token: person.token, body: {} })).status).toBe(404);
  });

  it('still answers without push-wake when PEPPER is missing or too short, instead of failing', async () => {
    for (const PEPPER of [undefined, '', 'short']) {
      const info = await call('GET', '/v1/info', { vars: { ...ON, PEPPER } });
      expect(info.status, String(PEPPER)).toBe(200);
      expect(info.body.features).toContain('workspaces-v1');
      expect(info.body.workspace.capabilities).not.toContain('push-wake');
      expect(info.body.workspace.push).toBeUndefined();
    }
  });
});

describe('PUT /v1/push-endpoint', () => {
  it('keeps the endpoint with the session that sent it', async () => {
    const person = await signup();
    const device = await push.device();
    expect((await register(person.token, device)).status).toBe(204);
    const [row] = await sessions(person);
    expect(row.wakeEndpoint).toBe(device.endpoint);
  });

  it('works for an account made before sessions had endpoints', async () => {
    const person = await signup();
    await runInDurableObject(await accountStub(person.email), (instance, state) => {
      for (const column of ['wakeEndpoint', 'wakeKey', 'wakeAuth', 'wakeAt', 'wakeFailedSince']) state.storage.sql.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
      instance.migrate();
      instance.migrate();
    });
    const device = await push.device();
    expect((await register(person.token, device)).status).toBe(204);
    expect((await sessions(person))[0].wakeEndpoint).toBe(device.endpoint);
  });

  it('needs a live session, checked before the address is', async () => {
    const device = await push.device();
    expect((await call('PUT', '/v1/push-endpoint', { body: { endpoint: device.endpoint }, vars: ON })).status).toBe(401);
    const person = await signup();
    expect((await call('POST', '/v1/logout', { token: person.token })).status).toBe(204);
    expect((await register(person.token, device)).status).toBe(401);
    // An ended session with a body that would be refused gets 401, not 400: nothing is checked for it.
    const res = await call('PUT', '/v1/push-endpoint', { token: person.token, body: { endpoint: 'not a url' }, vars: ON });
    expect([res.status, res.body.error]).toEqual([401, 'unauthorized']);
  });

  it('takes the known push services and the ones the operator lists, and refuses others as not allowed', async () => {
    const person = await signup();
    await manyTries(person);
    const keys = await push.device();
    const put = (endpoint, vars = {}) =>
      call('PUT', '/v1/push-endpoint', { token: person.token, body: { endpoint, p256dh: keys.p256dh, auth: keys.auth }, vars: { ...ON, ...vars } });
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/dAbCdEf:APA91bHabc',
      'https://ntfy.sh/upAbCdEf123?up=1',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABabc'
    ]) {
      expect((await put(endpoint)).status, endpoint).toBe(204);
    }
    for (const endpoint of [
      'https://ntfy.example.org/upAbC?up=1',
      'https://push.example:8443/up/1',
      'https://127.0.0.1/up/1',
      'https://10.0.0.8/up/1',
      'https://[fd00::1]/up/1',
      'https://localhost/up/1',
      'https://accounts.example/v1/info',
      'https://fcm.googleapis.com.evil.example/fcm/send/x'
    ]) {
      const res = await put(endpoint);
      expect([res.status, res.body.error, res.body.field], endpoint).toEqual([400, 'push_not_allowed', 'endpoint']);
    }
    // An operator's own ntfy, listed as an origin; entries that aren't bare https origins count for nothing.
    const own = { WORKSPACE_PUSH_ORIGINS: 'https://ntfy.example.org, http://plain.example.org, https://path.example.org/up' };
    expect((await put('https://ntfy.example.org/upAbC?up=1', own)).status).toBe(204);
    expect((await put('https://plain.example.org/up', own)).body.error).toBe('push_not_allowed');
    expect((await put('https://path.example.org/up/x', own)).body.error).toBe('push_not_allowed');
  });

  it('refuses malformed addresses and keys as invalid', async () => {
    const person = await signup();
    await manyTries(person);
    const good = await push.device();
    const tries = [
      [{ endpoint: good.endpoint.replace('https:', 'http:') }, 'endpoint'],
      [{ endpoint: good.endpoint.replace('https://', 'https://user:pw@') }, 'endpoint'],
      [{ endpoint: `${good.endpoint}#x` }, 'endpoint'],
      [{ endpoint: `https://push.example/up/${'a'.repeat(1000)}` }, 'endpoint'],
      [{ endpoint: 42 }, 'endpoint'],
      [{ endpoint: 'not a url' }, 'endpoint'],
      [{ p256dh: good.p256dh.slice(0, 40) }, 'p256dh'],
      // 65 bytes that aren't a point on the curve.
      [{ p256dh: `B${'A'.repeat(86)}` }, 'p256dh'],
      [{ auth: 'AAAA' }, 'auth']
    ];
    for (const [change, field] of tries) {
      const res = await call('PUT', '/v1/push-endpoint', {
        token: person.token,
        body: { endpoint: good.endpoint, p256dh: good.p256dh, auth: good.auth, ...change },
        vars: ON
      });
      expect([res.status, res.body.error, res.body.field], JSON.stringify(change)).toEqual([400, 'invalid', field]);
    }
    expect((await sessions(person))[0].wakeEndpoint).toBeNull();
    // An endpoint of exactly 1,000 bytes is fine.
    const exact = `https://push.example/up/${'b'.repeat(1000 - 'https://push.example/up/'.length)}`;
    const res = await call('PUT', '/v1/push-endpoint', { token: person.token, body: { ...good, endpoint: exact }, vars: ON });
    expect(res.status).toBe(204);
  });

  it('has an allowance per session, apart from the sign-in routes', async () => {
    const person = await signup();
    const other = (await login(person, 'Tablet')).body.token;
    const ip = '10.9.9.9';
    const put = async (token) => {
      const device = await push.device();
      return call('PUT', '/v1/push-endpoint', { token, ip, body: { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth }, vars: ON });
    };
    for (let i = 0; i < 6; i++) expect((await put(person.token)).status).toBe(204);
    const over = await put(person.token);
    expect([over.status, over.body.error]).toEqual([429, 'rate_limited']);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another session of the account, from the same address, has its own.
    expect((await put(other)).status).toBe(204);
    // Taking an endpoint back isn't counted.
    expect((await unregister(person.token)).status).toBe(204);
  });

  it('forgets the allowance of a session that ended, and one that filled up again', async () => {
    const person = await signup();
    const phone = (await login(person, 'Phone')).body.token;
    const tablet = (await login(person, 'Tablet')).body.token;
    for (const token of [person.token, phone, tablet]) expect((await register(token, await push.device())).status).toBe(204);
    const kept = async () =>
      runInDurableObject(await accountStub(person.email), (instance, state) => {
        const names = new Map(state.storage.sql.exec('SELECT id FROM sessions').toArray().map((r, i) => [r.id, i]));
        return [...instance.wakePuts.keys()].map((id) => (names.has(id) ? 'live' : 'ended'));
      });
    expect(await kept()).toEqual(['live', 'live', 'live']);
    // Signing out drops that session's.
    expect((await call('POST', '/v1/logout', { token: tablet })).status).toBe(204);
    expect(await kept()).toEqual(['live', 'live']);
    // One that is full again goes at the next check, whoever's check it is.
    await runInDurableObject(await accountStub(person.email), (instance) => {
      for (const [id, entry] of instance.wakePuts) instance.wakePuts.set(id, { ...entry, at: entry.at - 10 * 60 * 1000 });
    });
    expect((await register(phone, await push.device())).status).toBe(204);
    expect((await kept()).length).toBe(1);
    // A new password ends every other session, and their allowances with them.
    expect((await register(person.token, await push.device())).status).toBe(204);
    expect(
      (
        await call('POST', '/v1/password', {
          token: person.token,
          body: { authKey: person.authKey, kdf: person.kdf, salt: person.salt, newAuthKey: person.authKey, wrappedKey: person.wrappedKey }
        })
      ).status
    ).toBe(204);
    expect(await kept()).toEqual(['live']);
  });

  it('answers 503 when the account object fails, so the device tries again', async () => {
    const person = await signup();
    const device = await push.device();
    // An account binding whose object fails every call, as during an outage.
    const failing = () => ({
      jurisdiction() {
        return this;
      },
      idFromName: (name) => name,
      get: () => ({
        checkWakeSession: async () => {
          throw new Error('the object is unavailable');
        },
        clearWakeEndpoint: async () => {
          throw new Error('the object is unavailable');
        }
      })
    });
    const res = await register(person.token, device, { ACCOUNTS: failing() });
    expect([res.status, res.body.error, res.headers.get('retry-after')]).toEqual([503, 'unavailable', '30']);
    const removed = await unregister(person.token, { ACCOUNTS: failing() });
    expect([removed.status, removed.body.error]).toEqual([503, 'unavailable']);
  });

  it('replaces the session’s endpoint, and takes it from another session of the account that had it', async () => {
    const person = await signup();
    const second = (await login(person, 'Phone')).body.token;
    const first = await push.device();
    const next = await push.device('other-push.example');
    expect((await register(person.token, first)).status).toBe(204);
    expect((await register(person.token, next)).status).toBe(204);
    expect((await sessions(person)).map((s) => s.wakeEndpoint)).toEqual([next.endpoint, null]);
    // The phone signed in again and registers what it has: the old session lets go of it.
    expect((await register(second, next)).status).toBe(204);
    expect((await sessions(person)).map((s) => s.wakeEndpoint)).toEqual([null, next.endpoint]);
  });

  it('keeps ten sessions’ endpoints at most, dropping the oldest', async () => {
    const person = await signup();
    const tokens = [person.token];
    for (let i = 0; i < 10; i++) tokens.push((await login(person, `Phone ${i}`)).body.token);
    for (const token of tokens) {
      expect((await register(token, await push.device())).status).toBe(204);
      await pause(2);
    }
    const rows = await sessions(person);
    expect(rows.filter((r) => r.wakeEndpoint).length).toBe(10);
    expect(rows[0].wakeEndpoint).toBeNull();
  });
});

describe('ending a registration', () => {
  it('DELETE works whatever the settings, so a phone can take its endpoint back after push wakes went off', async () => {
    const person = await signup();
    for (const vars of [{ WORKSPACE_PUSH: 'off' }, { WORKSPACE_MODE: 'off' }]) {
      expect((await register(person.token, await push.device())).status).toBe(204);
      expect((await call('DELETE', '/v1/push-endpoint', { token: person.token, vars: { ...ON, ...vars } })).status).toBe(204);
      expect((await sessions(person))[0].wakeEndpoint).toBeNull();
    }
    expect((await call('DELETE', '/v1/push-endpoint', { vars: ON })).status).toBe(401);
  });

  it('DELETE clears this session’s endpoint and no other', async () => {
    const person = await signup();
    const second = (await login(person, 'Phone')).body.token;
    await register(person.token, await push.device());
    await register(second, await push.device());
    expect((await unregister(person.token)).status).toBe(204);
    expect((await unregister(person.token)).status).toBe(204);
    expect((await sessions(person)).map((s) => Boolean(s.wakeEndpoint))).toEqual([false, true]);
  });

  it('goes with the session: signing out, and being signed out from another device', async () => {
    const person = await signup();
    const phone = (await login(person, 'Phone')).body;
    const tablet = (await login(person, 'Tablet')).body;
    for (const token of [person.token, phone.token, tablet.token]) await register(token, await push.device());

    expect((await call('POST', '/v1/logout', { token: tablet.token })).status).toBe(204);
    expect((await sessions(person)).length).toBe(2);
    const phoneId = phone.account.devices.find((d) => d.current).id;
    expect((await call('DELETE', `/v1/devices/${phoneId}`, { token: person.token })).status).toBe(204);
    const left = await sessions(person);
    expect(left.length).toBe(1);
    expect(left[0].wakeEndpoint).not.toBeNull();
  });

  it('a wake to a session that signed out goes nowhere', async () => {
    const { ws, mila, phone } = await setUp();
    expect((await call('POST', '/v1/logout', { token: mila.person.token })).status).toBe(204);
    const dm = await startDm(ws.person, ws.id, [mila.me.id]);
    await post(ws.person, ws.id, dm.body.dm.conversation, 'hello?');
    await pause(300);
    expect(push.to(phone.endpoint)).toEqual([]);
  });
});

describe('what sends a wake', () => {
  it('a direct message: one encrypted wake, signed for the push service, to the other person only', async () => {
    const { ws, mila, phone } = await setUp();
    const olgaPhone = await push.device();
    await register(ws.person.token, olgaPhone);
    const dm = await dmWith(ws, mila);
    expect((await post(ws.person, ws.id, dm, 'lunch?')).status).toBe(201);
    expect(await until(() => push.to(phone.endpoint).length === 1)).toBe(true);

    const [sent] = push.to(phone.endpoint);
    expect(sent.method).toBe('POST');
    expect(sent.headers['content-encoding']).toBe('aes128gcm');
    expect(sent.headers['content-type']).toBe('application/octet-stream');
    expect(sent.headers.ttl).toBe('86400');
    expect(sent.headers.urgency).toBe('high');
    // No Topic: a push service holding wakes for an offline phone must not let a later wake for another workspace
    // replace this one and drop its workspace.
    expect(sent.headers.topic).toBeUndefined();
    // It says only that there is something and in which workspace, encrypted for the phone: no room, name or text.
    expect(await push.open(sent)).toEqual({ text: JSON.stringify({ t: 'wake', w: [ws.id] }), rs: 4096 });
    // Padded, so its length says nothing about how many workspaces it names.
    expect(sent.body.length).toBe(422);
    const vapid = await readVapid(sent.headers.authorization);
    expect(vapid.valid).toBe(true);
    expect(vapid.key).toBe(await vapidPublicKey(env));
    expect(vapid.claims.aud).toBe('https://push.example');
    expect(vapid.claims.exp).toBeGreaterThan(Date.now() / 1000);
    // The sender's own phone gets nothing.
    await pause(200);
    expect(push.to(olgaPhone.endpoint)).toEqual([]);
  });

  it('in a channel: a mention and a reply to your message, not every message', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 0);
    await post(ws.person, ws.id, ws.general, 'morning all');
    await pause(300);
    expect(push.to(phone.endpoint)).toEqual([]);

    const text = 'hi @Mila';
    await post(ws.person, ws.id, ws.general, text, { mentions: [{ actor: mila.me.id, start: 3, end: 8 }] });
    expect(await until(() => push.to(phone.endpoint).length === 1)).toBe(true);

    const mine = await post(mila.person, ws.id, ws.general, 'a question');
    expect(push.to(phone.endpoint).length).toBe(1);
    await post(ws.person, ws.id, ws.general, 'an answer', { root: mine.body.messageId });
    expect(await until(() => push.to(phone.endpoint).length === 2)).toBe(true);
    // Someone else's reply in a thread Mila only reads doesn't.
    const olgas = await post(ws.person, ws.id, ws.general, 'thread start');
    await post(ws.person, ws.id, ws.general, 'thread reply', { root: olgas.body.messageId });
    await pause(300);
    expect(push.to(phone.endpoint).length).toBe(2);
  });

  it('nothing from someone the member blocked', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 0);
    expect((await api('POST', `/v1/workspaces/${ws.id}/blocks`, { token: mila.person.token, body: { member: ws.me.id } })).status).toBe(201);
    await post(ws.person, ws.id, ws.general, 'hi @Mila', { mentions: [{ actor: mila.me.id, start: 3, end: 8 }] });
    await pause(300);
    expect(push.to(phone.endpoint)).toEqual([]);
  });

  it('every session of the member that has an endpoint', async () => {
    const { ws, mila, phone } = await setUp();
    const tablet = await push.device('other-push.example');
    const second = (await login(mila.person, 'Tablet')).body.token;
    await register(second, tablet);
    await post(ws.person, ws.id, await dmWith(ws, mila), 'hello');
    expect(await until(() => push.to(phone.endpoint).length === 1 && push.to(tablet.endpoint).length === 1)).toBe(true);
  });
});

describe('bursts', () => {
  it('sends one wake at once and one more when the window ends, for everything in it', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 600);
    const dm = await dmWith(ws, mila);
    for (let i = 0; i < 5; i++) await post(ws.person, ws.id, dm, `line ${i}`);
    expect(await until(() => push.to(phone.endpoint).length === 1)).toBe(true);
    expect(await until(() => push.to(phone.endpoint).length === 2, 1500)).toBe(true);
    const [first, second] = push.to(phone.endpoint);
    expect(second.at - first.at).toBeGreaterThanOrEqual(550);
    await pause(900);
    expect(push.to(phone.endpoint).length).toBe(2);
    // A quiet window sends nothing more; the next message is a wake at once again.
    await post(ws.person, ws.id, dm, 'later');
    expect(await until(() => push.to(phone.endpoint).length === 3)).toBe(true);
  });

  it('the wake at the end of a window names every workspace that had something', async () => {
    const { ws, mila, phone } = await setUp();
    const other = await newWorkspace('Other');
    const { secret } = await invite(other.person, other.id);
    const joined = await api('POST', `/v1/workspaces/${other.id}/join`, { token: mila.person.token, body: { invite: secret, name: 'Mila' } });
    expect(joined.status).toBe(201);
    const inOther = { me: joined.body.me };
    await pushWindow(mila.person, 500);
    await post(ws.person, ws.id, await dmWith(ws, mila), 'first');
    expect(await until(() => push.to(phone.endpoint).length === 1)).toBe(true);
    await post(ws.person, ws.id, ws.general, 'hi @Mila', { mentions: [{ actor: mila.me.id, start: 3, end: 8 }] });
    const dm = await startDm(other.person, other.id, [inOther.me.id]);
    await post(other.person, other.id, dm.body.dm.conversation, 'from the other team');
    expect(await until(() => push.to(phone.endpoint).length === 2, 1500)).toBe(true);
    const last = JSON.parse((await push.open(push.to(phone.endpoint)[1])).text);
    expect(last.t).toBe('wake');
    expect(last.w.sort()).toEqual([ws.id, other.id].sort());
    expect(push.to(phone.endpoint).map((sent) => sent.body.length)).toEqual([422, 422]);
  });

  it('a lone message in a quiet window sends no second wake', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 400);
    await post(ws.person, ws.id, await dmWith(ws, mila), 'one');
    expect(await until(() => push.to(phone.endpoint).length === 1)).toBe(true);
    await pause(800);
    expect(push.to(phone.endpoint).length).toBe(1);
  });
});

describe('the push service’s answers', () => {
  for (const status of [404, 410]) {
    it(`${status} ends the registration`, async () => {
      const { ws, mila, phone } = await setUp();
      await pushWindow(mila.person, 0);
      push.answers.set(phone.endpoint, status);
      const dm = await dmWith(ws, mila);
      await post(ws.person, ws.id, dm, 'one');
      expect(await until(async () => (await sessions(mila.person))[0].wakeEndpoint === null)).toBe(true);
      await post(ws.person, ws.id, dm, 'two');
      await pause(300);
      expect(push.to(phone.endpoint).length).toBe(1);
    });
  }

  it('another failure keeps it for the next wake', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 0);
    push.answers.set(phone.endpoint, 500);
    const dm = await dmWith(ws, mila);
    await post(ws.person, ws.id, dm, 'one');
    expect(await until(() => push.to(phone.endpoint).length === 1)).toBe(true);
    push.answers.delete(phone.endpoint);
    await post(ws.person, ws.id, dm, 'two');
    expect(await until(() => push.to(phone.endpoint).length === 2)).toBe(true);
    expect((await sessions(mila.person))[0].wakeEndpoint).toBe(phone.endpoint);
  });

  it('a registration made again at the same address with new keys stays when the old one answers 410', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 0);
    push.answers.set(phone.endpoint, 410);
    const release = push.hold(phone.endpoint);
    await post(ws.person, ws.id, await dmWith(ws, mila), 'one');
    expect(await until(() => push.to(phone.endpoint).length === 1)).toBe(true);
    // While the wake to the old registration waits for its answer, the phone registers again: same address, new keys.
    const again = await push.device('push.example', phone.endpoint);
    expect((await register(mila.person.token, again)).status).toBe(204);
    release();
    await pause(300);
    const [row] = await runInDurableObject(await accountStub(mila.person.email), (instance, state) =>
      state.storage.sql.exec('SELECT wakeEndpoint, wakeKey FROM sessions').toArray()
    );
    expect(row.wakeEndpoint).toBe(phone.endpoint);
    expect(new Uint8Array(row.wakeKey)).toEqual(again.publicKey);
  });

  it('an endpoint whose wakes have failed for seven days goes, and one that works again stays', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 0);
    const failingSince = async (at) =>
      runInDurableObject(await accountStub(mila.person.email), (instance, state) => {
        if (at !== undefined) state.storage.sql.exec('UPDATE sessions SET wakeFailedSince = ?', at);
        return state.storage.sql.exec('SELECT wakeFailedSince FROM sessions').one().wakeFailedSince;
      });
    const dm = await dmWith(ws, mila);
    push.answers.set(phone.endpoint, 507);
    await post(ws.person, ws.id, dm, 'one');
    expect(await until(async () => (await failingSince()) !== null)).toBe(true);
    // Working again clears the clock.
    push.answers.delete(phone.endpoint);
    await post(ws.person, ws.id, dm, 'two');
    expect(await until(async () => (await failingSince()) === null)).toBe(true);
    // Failing since eight days ago: the next failure ends it.
    push.answers.set(phone.endpoint, 507);
    await failingSince(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await post(ws.person, ws.id, dm, 'three');
    expect(await until(async () => (await sessions(mila.person))[0].wakeEndpoint === null)).toBe(true);
  });

  it('a registration made again meanwhile stays when the old endpoint answers 410', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 0);
    push.answers.set(phone.endpoint, 410);
    // The phone registers a new endpoint while the wake to the old one is on its way.
    const fresh = await push.device();
    const dm = await dmWith(ws, mila);
    await post(ws.person, ws.id, dm, 'one');
    await register(mila.person.token, fresh);
    await pause(300);
    expect((await sessions(mila.person))[0].wakeEndpoint).toBe(fresh.endpoint);
  });
});

describe('a device with a working socket', () => {
  it('hears of it on the socket and gets no wake; another session of the member does', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 0);
    const tablet = await push.device('other-push.example');
    const second = (await login(mila.person, 'Tablet')).body.token;
    await register(second, tablet);
    const socket = await openSocket(mila.person, ws.id);
    expect(socket.status).toBe(101);

    await post(ws.person, ws.id, await dmWith(ws, mila), 'hello');
    expect(await until(() => socket.frames.length > 0)).toBe(true);
    expect(await until(() => push.to(tablet.endpoint).length === 1)).toBe(true);
    await pause(200);
    expect(push.to(phone.endpoint)).toEqual([]);
    socket.socket.close(1000);
  });

  it('a socket that stopped pinging, as a dozing phone’s does, counts as gone; a ping brings it back', async () => {
    const { ws, mila, phone } = await setUp();
    await pushWindow(mila.person, 0);
    const socket = await openSocket(mila.person, ws.id);
    const dm = await dmWith(ws, mila);
    // The socket opened 80 seconds ago and never pinged since.
    await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      for (const s of state.getWebSockets()) s.serializeAttachment({ ...s.deserializeAttachment(), at: Date.now() - 80_000 });
    });
    await post(ws.person, ws.id, dm, 'are you awake?');
    expect(await until(() => push.to(phone.endpoint).length === 1)).toBe(true);

    socket.socket.send('ping');
    expect(await until(() => socket.frames.includes('pong'))).toBe(true);
    const before = socket.frames.length;
    await post(ws.person, ws.id, dm, 'now?');
    expect(await until(() => socket.frames.length > before)).toBe(true);
    await pause(300);
    expect(push.to(phone.endpoint).length).toBe(1);
    socket.socket.close(1000);
  });
});

describe('the privacy statement', () => {
  const lines = {
    en: 'Rukoo for Android can ask this server to wake it',
    nl: 'Rukoo voor Android kan deze server vragen hem te wekken'
  };
  // What the route through Google's FCM shares, which phones without a UnifiedPush app take.
  const google = {
    en: 'Google LLC then gets from this server, with each wake, the token Google gave that phone',
    nl: 'Google LLC krijgt dan bij elk wekbericht van deze server het token dat Google die telefoon gaf'
  };

  it('says what a wake shares, in English and Dutch, while push wakes are on', async () => {
    for (const [lang, line] of Object.entries(lines)) {
      const on = await call('GET', `/privacy?lang=${lang}`, { vars: ON });
      expect(on.text, lang).toContain(line);
      expect(on.text, lang).toContain(google[lang]);
      const off = await call('GET', `/privacy?lang=${lang}`, { vars: { ...ON, WORKSPACE_PUSH: 'off' } });
      expect(off.text, lang).not.toContain(line);
      // Without team chat there is nothing to wake for.
      expect((await call('GET', `/privacy?lang=${lang}`)).text, lang).not.toContain(line);
    }
  });
});
