'use strict';

// The wake socket (src/main/workspaces/socket.js) and how the WorkspaceService keeps its sockets, as contract 8.4
// lists for chat-socket. With the real account server (test/fixtures/real-server.js): a wake reaches a run, the
// upgrade carries the ticket in its header, 4003 after a removal parks the socket, and the socket comes back after the
// server does. With a fake WebSocket and a fake clock, for what the server can't be made to do on demand: the backoff
// and its jitter, 4001, a missing pong, a ticket answered 429, resume, the cap of eight sockets and the lease run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRealServer, realServerAvailable, skipWithoutServer } = require('./fixtures/real-server');
const { attach, chatService, settled, watchCalls, twoPeople, until, sleep, fakeClock, fakeWebSocket } = require('./fixtures/chat-app');
const { WakeSocket, PROTOCOL } = require('../src/main/workspaces/socket');
const { TIMING } = require('../src/main/workspaces');
const { ChatError } = require('../src/main/workspaces/wire');

// Room for nine workspaces of one owner, for the cap on sockets.
let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') {
    server = await startRealServer({ vars: { MAX_WORKSPACES_PER_ACCOUNT: '20' } });
  }
});
test.after(() => server?.close());

const FAST = { socketBackoff: [100, 200, 400, 800, 1600, 3200, 6000], syncBackoff: [100, 200, 400, 800, 1600] };
const route = (ws, rest = '') => `/v1/workspaces/${ws}${rest}`;

async function live(t, options = {}) {
  const made = await twoPeople(server, { timing: FAST, WebSocket: globalThis.WebSocket, ...options });
  t.after(() => {
    made.svc.close();
    made.account.close();
  });
  await settled(made.svc, made.ws.id);
  await until(() => made.svc.socketState(made.ws.id) === 'open', 10000, 'the socket to open');
  return made;
}

test('a wake reaches a run within a second', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, account } = await live(t);
  // Past the gap between runs and the server's wake window.
  await until(() => !svc.runners.get(ws.id).running, 5000, 'the runs after the socket opened');
  await sleep(700);
  const a = await server.access(olga, ws.id, ws.general);
  const calls = watchCalls(account);
  const started = Date.now();
  const posted = await server.call('POST', route(ws.id, `/conversations/${ws.general}/messages`), {
    token: olga.token,
    body: { operationId: require('./fixtures/real-server').uuidv7(a.time), grant: a.grant, generation: a.generation, text: 'Wake up' }
  });
  assert.equal(posted.status, 201, posted.text);
  await until(() => (svc.store.getRoom(ws.id, ws.general) || {}).head >= posted.body.seq, 3000, 'the run the wake started');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `the run came ${elapsed} ms after the post`);
  assert.ok(calls.some((c) => c.route.startsWith(route(ws.id, '/changes'))));
});

test('the upgrade sends the ticket in its header, never in the address', async (t) => {
  if (skipWithoutServer(t)) return;
  const made = [];
  class Spy extends globalThis.WebSocket {
    constructor(url, init) {
      made.push({ url, init });
      super(url, init);
    }
  }
  const { ws, svc } = await live(t, { WebSocket: Spy });
  assert.ok(made.length >= 1);
  const { url, init } = made[0];
  assert.equal(url, `${server.url.replace(/^http/, 'ws')}/v1/workspaces/${ws.id}/socket`);
  assert.ok(!/ticket/i.test(url), 'no ticket in the address');
  assert.deepEqual(init.protocols, [PROTOCOL]);
  assert.match(init.headers.authorization, /^Ticket [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  // The server took it: the socket opened.
  assert.equal(svc.socketState(ws.id), 'open');
  assert.equal(svc.state().connection, 'online');
});

test('4003 after a removal parks the socket and removes the workspace', async (t) => {
  if (skipWithoutServer(t)) return;
  const made = [];
  class Spy extends globalThis.WebSocket {
    constructor(url, init) {
      made.push(url);
      super(url, init);
    }
  }
  const { olga, ws, bartMe, svc } = await live(t, { WebSocket: Spy });
  const before = made.length;
  const removed = await server.call('DELETE', route(ws.id, `/members/${bartMe.id}`), { token: olga.token });
  assert.equal(removed.status, 204);
  await until(() => svc.events.some((e) => e.kind === 'removed' && e.ws === ws.id), 5000, 'the removal');
  assert.deepEqual(svc.events.filter((e) => e.kind === 'removed').at(-1), { kind: 'removed', ws: ws.id, reason: 'removed' });
  assert.equal(svc.store.getWs(ws.id), null);
  assert.equal(svc.socketState(ws.id), 'off');
  await sleep(500);
  assert.equal(made.length, before, 'no new socket for the workspace');
});

test('the socket connects again after the server stops and starts', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc } = await live(t);
  await server.stop();
  try {
    await until(() => svc.socketState(ws.id) !== 'open', 5000, 'the socket to close');
    await until(() => svc.state().connection !== 'online', 5000, 'the connection to show it');
  } finally {
    await server.start();
  }
  await until(() => svc.socketState(ws.id) === 'open', 20000, 'the socket to open again');
  // And it works: a wake from a post reaches this device.
  const posted = await server.post(olga, ws.id, ws.general, 'Back again');
  await until(() => (svc.store.getRoom(ws.id, ws.general) || {}).head >= posted.seq, 5000, 'the post after the restart');
  await until(() => svc.state().connection === 'online', 5000, 'online again');
});

// ---- the socket alone, with a fake WebSocket and a fake clock ----

function wakeSocket({ ticket, random = () => 1, timing = {} } = {}) {
  const clock = fakeClock();
  const WS = fakeWebSocket();
  const seen = { open: 0, wake: 0, lease: 0, removed: 0, tickets: 0 };
  const socket = new WakeSocket({
    url: 'ws://127.0.0.1:1/v1/workspaces/w_AAAAAAAAAAAAAAAAAAAAAA/socket',
    ticket: async () => {
      seen.tickets += 1;
      return ticket ? ticket(seen.tickets) : 'payload.mac';
    },
    WebSocket: WS,
    timing: { ...TIMING, ...timing },
    random,
    now: clock.now,
    timers: clock,
    onOpen: () => seen.open++,
    onWake: () => seen.wake++,
    onLease: () => seen.lease++,
    onRemoved: () => seen.removed++
  });
  return { clock, WS, socket, seen };
}

test('the backoff doubles to a minute, each delay times a random factor from 0.5 to 1.0', async () => {
  const factors = [0, 1, 0.5, 0.25, 0.75, 0.1, 0.9, 0.3, 0.6];
  let i = 0;
  const { clock, WS, socket } = wakeSocket({ random: () => factors[i++ % factors.length] });
  WS.auto = (s) => s.drop(1006);
  socket.start();
  await clock.tick();
  const bases = [1, 2, 4, 8, 16, 32, 60, 60, 60].map((s) => s * 1000);
  const delays = [];
  for (let n = 0; n < bases.length; n++) {
    assert.equal(socket.state, 'down');
    delays.push(socket.lastDelay);
    assert.ok(socket.lastDelay >= bases[n] * 0.5 && socket.lastDelay <= bases[n], `attempt ${n + 1}: ${socket.lastDelay} ms for ${bases[n]}`);
    assert.equal(socket.lastDelay, Math.round(bases[n] * (0.5 + 0.5 * factors[n])));
    // Nothing happens before the delay.
    const made = WS.made.length;
    await clock.advance(socket.lastDelay - 1);
    assert.equal(WS.made.length, made);
    await clock.advance(1);
    assert.equal(WS.made.length, made + 1);
  }
  assert.equal(delays.length, 9);
  socket.stop();
});

test('4001 runs at once and connects again at once, but only once in ten seconds', async () => {
  const { clock, WS, socket, seen } = wakeSocket();
  WS.auto = (s) => s.open();
  socket.start();
  await clock.tick();
  assert.equal(socket.state, 'open');
  assert.equal(seen.open, 1);
  WS.made[0].message('{"t":"wake"}');
  assert.equal(seen.wake, 1);
  WS.made[0].drop(4001);
  await clock.tick();
  assert.equal(seen.lease, 1, 'a run for the swallowed wake');
  assert.equal(WS.made.length, 2, 'a new socket without waiting');
  assert.equal(socket.state, 'open');
  // Another 4001 within ten seconds waits for the backoff.
  await clock.advance(5000);
  WS.made[1].drop(4001);
  await clock.tick();
  assert.equal(seen.lease, 2);
  assert.equal(WS.made.length, 2);
  assert.equal(socket.state, 'down');
  assert.ok(socket.lastDelay >= 500 && socket.lastDelay <= 1000);
  await clock.advance(socket.lastDelay);
  assert.equal(WS.made.length, 3);
  // Ten seconds on, the next 4001 connects at once again.
  await clock.advance(10000);
  WS.made[2].drop(4001);
  await clock.tick();
  assert.equal(WS.made.length, 4);
  socket.stop();
});

test('frames other than a wake, over 1 KB or binary are ignored', async () => {
  const { clock, WS, socket, seen } = wakeSocket();
  WS.auto = (s) => s.open();
  socket.start();
  await clock.tick();
  const s = WS.made[0];
  s.message(`{"t":"wake","pad":"${'x'.repeat(1100)}"}`);
  s.message(Buffer.from('{"t":"wake"}'));
  s.message('{"t":"sleep"}');
  s.message('not json');
  s.message('pong');
  assert.equal(seen.wake, 0);
  s.message('{"t":"wake"}');
  assert.equal(seen.wake, 1);
  socket.stop();
  assert.equal(s.closedWith, 1000);
  assert.equal(socket.state, 'off');
  // A stopped socket stays down.
  await clock.advance(120000);
  assert.equal(WS.made.length, 1);
});

test('a ping without an answer for ten seconds closes the socket and connects again', async () => {
  const { clock, WS, socket } = wakeSocket();
  WS.auto = (s) => s.open();
  WS.pong = false;
  socket.start();
  await clock.tick();
  const first = WS.made[0];
  await clock.advance(30000);
  assert.deepEqual(first.sent, ['ping']);
  await clock.advance(9999);
  assert.equal(socket.state, 'open');
  // Any frame answers it: a wake in the meantime would keep it.
  await clock.advance(1);
  assert.equal(first.closedWith, 1000);
  assert.equal(socket.state, 'down');
  await clock.advance(socket.lastDelay);
  assert.equal(WS.made.length, 2);
  assert.equal(socket.state, 'open');
  // With the server's pong, the socket stays.
  WS.pong = true;
  await clock.advance(5 * 60000);
  assert.equal(WS.made.length, 2);
  assert.equal(socket.state, 'open');
  socket.stop();
});

test('a ticket answered 429 waits for Retry-After before trying again', async () => {
  const { clock, WS, socket, seen } = wakeSocket({
    ticket: (n) => {
      if (n === 1) throw new ChatError('rate_limited', { retryAfter: 7 });
      return 'payload.mac';
    }
  });
  WS.auto = (s) => s.open();
  socket.start();
  await clock.tick();
  assert.equal(socket.state, 'down');
  assert.equal(socket.lastDelay, 7000);
  assert.equal(WS.made.length, 0);
  await clock.advance(6999);
  assert.equal(seen.tickets, 1);
  await clock.advance(1);
  assert.equal(seen.tickets, 2);
  assert.equal(socket.state, 'open');
  socket.stop();
});

test('a ticket refused for good parks the socket', async () => {
  for (const err of [new ChatError('signed_out'), new ChatError('not_found', { scope: 'workspace' }), new ChatError('upgrade_required'), Object.assign(new Error('stale'), { stale: true })]) {
    const { clock, WS, socket, seen } = wakeSocket({
      ticket: () => {
        throw err;
      }
    });
    socket.start();
    await clock.tick();
    assert.equal(socket.state, 'off', err.code || 'stale');
    await clock.advance(120000);
    assert.equal(seen.tickets, 1);
    assert.equal(WS.made.length, 0);
  }
});

test('resume tries a socket that waits at once, from the first step of the backoff', async () => {
  const { clock, WS, socket, seen } = wakeSocket();
  WS.auto = (s) => s.drop(1006);
  socket.start();
  await clock.tick();
  for (let n = 0; n < 4; n++) await clock.advance(socket.lastDelay);
  assert.equal(socket.attempt, 5);
  assert.ok(socket.lastDelay >= 8000);
  const tickets = seen.tickets;
  socket.nudge();
  await clock.tick();
  assert.equal(seen.tickets, tickets + 1, 'tried at once');
  assert.ok(socket.lastDelay <= 1000, `back at the first step: ${socket.lastDelay}`);
  // An open socket pings at once instead.
  WS.auto = (s) => s.open();
  await clock.advance(socket.lastDelay);
  assert.equal(socket.state, 'open');
  const open = WS.made.at(-1);
  socket.nudge();
  assert.deepEqual(open.sent, ['ping']);
  socket.stop();
});

// ---- the service's sockets ----

test('at most eight sockets: the selected workspace and the seven most recently active', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ids = [];
  for (let n = 1; n <= 9; n++) {
    const ws = await server.seedWorkspace(olga, { name: `Team ${n}` });
    await server.seedMember(ws, bart, 'Bart');
    ids.push(ws.id);
  }
  const WS = fakeWebSocket();
  WS.auto = (s) => s.open();
  const { account, dir } = attach(server, bart);
  const svc = chatService(account, dir, { WebSocket: WS });
  t.after(() => {
    svc.close();
    account.close();
  });
  for (const id of ids) await settled(svc, id);
  await until(() => svc.sockets.size === 8 && [...svc.sockets.values()].every((s) => s.state === 'open'), 10000, 'eight open sockets');
  assert.equal(svc.store.listWs().length, 9);
  assert.equal(WS.live().length, 8);
  const selected = svc.state().selected;
  assert.ok(svc.sockets.has(selected));
  const left = ids.find((id) => !svc.sockets.has(id));
  assert.ok(left && left !== selected);
  const urls = WS.made.map((s) => s.url);
  assert.ok(!urls.some((u) => u.includes(left)));
  // Selecting the ninth gives it a socket and takes one from the least recently active.
  svc.select(left);
  await until(() => svc.socketState(left) === 'open', 10000, 'a socket for the selected workspace');
  assert.equal(svc.sockets.size, 8);
  assert.equal(WS.live().length, 8);
  assert.ok(WS.made.some((s) => s.closedWith === 1000));
  // Each socket asked for a ticket of its own over the real server.
  for (const s of WS.made) assert.match(s.init.headers.authorization, /^Ticket \S+$/);
});

test('a socket that stays open gets a run before its lease runs out at ten minutes', async (t) => {
  if (skipWithoutServer(t)) return;
  const clock = fakeClock(Date.now());
  const WS = fakeWebSocket();
  WS.auto = (s) => s.open();
  const made = await twoPeople(server, { WebSocket: WS, now: clock.now, timers: clock, random: () => 0.5 });
  const { ws, svc, account } = made;
  t.after(() => {
    svc.close();
    account.close();
  });
  // Fake timers fire only when the clock moves; real requests need real time between the steps.
  const pump = async (check, what) => {
    const end = Date.now() + 15000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await clock.advance(600);
      await sleep(10);
    }
  };
  const idle = () => !(svc.runners.get(ws.id) || {}).running && !svc.listing;
  await pump(() => svc.store && svc.store.getWs(ws.id) && !svc.store.getWs(ws.id).fresh && svc.socketState(ws.id) === 'open' && idle(), 'the first pass');
  // Whatever followed the opening settles.
  for (let n = 0; n < 5; n++) {
    await clock.advance(600);
    await until(idle, 5000, 'the runs to end');
  }
  const calls = watchCalls(account);
  const feed = () => calls.filter((c) => c.route.startsWith(route(ws.id, '/changes'))).length;
  const last = svc.lastOk.get(ws.id);
  const due = last + 10 * 60000 - clock.now();
  assert.ok(due > 9 * 60000, `the run is due in ${due} ms`);
  await clock.advance(due - 30000);
  assert.equal(feed(), 0, 'no run before the lease needs one');
  await clock.advance(30000);
  await until(() => feed() > 0, 5000, 'the lease run');
  await until(idle, 5000, 'the lease run to end');
  assert.equal(svc.socketState(ws.id), 'open');
});
