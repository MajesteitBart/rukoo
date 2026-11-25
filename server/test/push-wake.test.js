// Push wakes for team chat (WORKSPACES.md, Push wakes): registering a session's push endpoint, which activity sends a
// wake there, how a burst is held to one wake per window, what the push service's answers do, and that a device with
// a working socket hears of it there instead. The push service is test/fixtures/fake-push.js.

import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vapidPublicKey } from '../src/webpush.js';
import { env } from 'cloudflare:workers';
import { FakePush, installFakePush, readVapid } from './fixtures/fake-push.js';
import { accountStub, call, login, signup } from './helpers.js';
import { ON, api, newMember, newWorkspace, openSocket, post, startDm, until, workspaceStub } from './workspace-helpers.js';

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

  it('leaves it out when WORKSPACE_PUSH is off, and the routes answer 404', async () => {
    const off = { WORKSPACE_PUSH: 'off' };
    const info = await call('GET', '/v1/info', { vars: { ...ON, ...off } });
    expect(info.body.workspace.capabilities).not.toContain('push-wake');
    expect(info.body.workspace.push).toBeUndefined();
    const person = await signup();
    expect((await register(person.token, await push.device(), off)).status).toBe(404);
    expect((await unregister(person.token, off)).status).toBe(404);
  });

  it('has neither the capability nor the routes while team chat is off', async () => {
    const person = await signup();
    expect((await call('PUT', '/v1/push-endpoint', { token: person.token, body: {} })).status).toBe(404);
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
      for (const column of ['wakeEndpoint', 'wakeKey', 'wakeAuth', 'wakeAt']) state.storage.sql.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
      instance.migrate();
      instance.migrate();
    });
    const device = await push.device();
    expect((await register(person.token, device)).status).toBe(204);
    expect((await sessions(person))[0].wakeEndpoint).toBe(device.endpoint);
  });

  it('needs a session', async () => {
    const device = await push.device();
    expect((await call('PUT', '/v1/push-endpoint', { body: { endpoint: device.endpoint }, vars: ON })).status).toBe(401);
    const person = await signup();
    expect((await call('POST', '/v1/logout', { token: person.token })).status).toBe(204);
    expect((await register(person.token, device)).status).toBe(401);
  });

  it('takes only public https addresses of at most 1,000 bytes, and real keys', async () => {
    const person = await signup();
    const good = await push.device();
    const tries = [
      [{ endpoint: good.endpoint.replace('https:', 'http:') }, 'endpoint'],
      [{ endpoint: good.endpoint.replace('push.example', 'push.example:8443') }, 'endpoint'],
      [{ endpoint: good.endpoint.replace('https://', 'https://user:pw@') }, 'endpoint'],
      [{ endpoint: `${good.endpoint}#x` }, 'endpoint'],
      [{ endpoint: 'https://127.0.0.1/up/1' }, 'endpoint'],
      [{ endpoint: 'https://10.0.0.8/up/1' }, 'endpoint'],
      [{ endpoint: 'https://[fd00::1]/up/1' }, 'endpoint'],
      [{ endpoint: 'https://localhost/up/1' }, 'endpoint'],
      [{ endpoint: 'https://ntfy.internal/up/1' }, 'endpoint'],
      [{ endpoint: 'https://accounts.example/v1/info' }, 'endpoint'],
      // A host name that leads to a private address, and one DNS doesn't know.
      [{ endpoint: 'https://inside.example/up/1' }, 'endpoint'],
      [{ endpoint: 'https://nowhere.example/up/1' }, 'endpoint'],
      [{ endpoint: `https://push.example/up/${'a'.repeat(1000)}` }, 'endpoint'],
      [{ endpoint: 42 }, 'endpoint'],
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
    expect(sent.headers.topic).toBe('rukoo-wake');
    // It says only that there is something, the same as the socket's frame, and no workspace, room or name.
    expect(await push.open(sent)).toEqual({ text: '{"t":"wake"}', rs: 4096 });
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
