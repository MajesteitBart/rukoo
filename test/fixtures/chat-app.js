'use strict';

// What the team chat Node tests share: the desktop's own AccountService signed in at the real server
// (test/fixtures/real-server.js), a WorkspaceService on top of it as main.js makes one, a fake clock for timers, and a
// fake WebSocket for the socket cases the real server can't produce on demand. The server is always the real one:
// nothing here answers a workspace route.
//
//   const { account, dir } = attach(server, bart);           // signed in with a seeded person's session
//   const svc = chatService(account, dir, { timing: { feedLimit: 2 } });
//   await settled(svc, ws.id);                               // the first pass installed
const crypto = require('crypto');
const { tempDir } = require('../tmp');
const { AccountService } = require('../../src/main/account');
const { WorkspaceService } = require('../../src/main/workspaces');

// As in account.test.js: the plain stand-in for safeStorage.
const secrets = {
  encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`,
  decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString()
};
const PASSWORD = 'a long enough password';

// Unref'd, so a timeout that lost its race doesn't keep the test process alive.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

async function until(check, ms = 10000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await sleep(15);
  }
}

function newAccount(server, dir = tempDir('rukoo-chat-')) {
  const account = new AccountService({ dataDir: dir, secrets, defaultServer: server.url, deviceName: 'Chat test', platform: 'linux' }).init();
  return { account, dir };
}

// A device signed in with a seeded person's session, without Argon2: the session is what team chat rides on. The
// person's records key is random, which is right for a person seeded with random keys, who has no records.
function attach(server, person, { dir } = {}) {
  const made = newAccount(server, dir);
  made.account.attach(person.email, person.token, crypto.randomBytes(32));
  return made;
}

// A device that signs in with a password through the desktop's own code (prelogin, Argon2, login).
async function signIn(server, person, { dir } = {}) {
  const made = newAccount(server, dir);
  await made.account.signIn({ email: person.email, password: person.password });
  return made;
}

// A WorkspaceService as main.js makes one, collecting its events in svc.events and its notifications in svc.notices.
// WebSocket null keeps sockets off, so runs happen only when a test asks.
function chatService(account, dir, { timing = {}, WebSocket = null, now, random, timers, settings } = {}) {
  const svc = new WorkspaceService({
    account,
    dataDir: dir,
    settings: settings || (() => ({ chatNotifications: true })),
    timing: { coalesce: 5, ...timing },
    WebSocket,
    ...(now ? { now } : {}),
    ...(random ? { random } : {}),
    ...(timers ? { timers } : {})
  });
  svc.events = [];
  svc.notices = [];
  svc.on('event', (e) => svc.events.push(e));
  svc.on('notify', (n) => svc.notices.push(n));
  return svc.init();
}

// Until no run of ws is going on and its first pass has installed.
async function settled(svc, ws, ms = 15000) {
  await until(() => {
    const row = svc.store && svc.store.getWs(ws);
    const r = svc.runners.get(ws);
    return row && !row.fresh && !row.passing && !(r && r.running);
  }, ms, `the first pass of ${ws}`);
  // The coalesced events of that run.
  await sleep(20);
}

// Each request the account makes for team chat: { method, route }. Answers can be replaced: answer(method, route,
// real) returns a value, throws, or returns undefined to let the real answer through (real() fetches it).
function watchCalls(account, answer = null) {
  const calls = [];
  const real = account.workspaceCall.bind(account);
  account.workspaceCall = async (method, route, body) => {
    calls.push({ method, route });
    if (answer) {
      const out = await answer(method, route, () => real(method, route, body), body);
      if (out !== undefined) return out;
    }
    return real(method, route, body);
  };
  return calls;
}

// A clock whose timers fire only when the test advances it. advance() lets promises and I/O callbacks that the timers
// start run between them.
function fakeClock(start = 1800000000000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    // Timers due now or earlier.
    async tick() {
      await clock.advance(0);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = Math.max(now, t.at);
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = end;
      await new Promise((resolve) => setImmediate(resolve));
    },
    // The delays of the timers that wait, in order of when they fire.
    pending() {
      return [...timers.values()].sort((a, b) => a.at - b.at).map((t) => ({ in: t.at - now, ms: t.ms }));
    }
  };
  return clock;
}

// A WebSocket that does what the test says. FakeSocket.made lists every one constructed, with its url and init.
function fakeWebSocket() {
  class FakeSocket {
    constructor(url, init = {}) {
      this.url = url;
      this.init = init;
      this.sent = [];
      this.listeners = {};
      this.readyState = 0;
      this.closedWith = null;
      FakeSocket.made.push(this);
      if (FakeSocket.auto) queueMicrotask(() => FakeSocket.auto(this));
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    fire(type, event = {}) {
      for (const fn of this.listeners[type] || []) fn(event);
    }
    open() {
      this.readyState = 1;
      this.fire('open');
    }
    message(data) {
      this.fire('message', { data });
    }
    // The server closing it.
    drop(code = 1006) {
      this.readyState = 3;
      this.fire('close', { code });
    }
    // A ping gets a pong, as the server's auto-response gives one, unless FakeSocket.pong is false.
    send(data) {
      this.sent.push(data);
      if (data === 'ping' && FakeSocket.pong && this.readyState === 1) queueMicrotask(() => this.readyState === 1 && this.message('pong'));
    }
    // The client closing it.
    close(code) {
      this.closedWith = code;
      this.readyState = 3;
    }
  }
  FakeSocket.made = [];
  // auto(socket): what each new socket does at once, such as open() or drop().
  FakeSocket.auto = null;
  FakeSocket.pong = true;
  // The sockets the client hasn't closed and the server hasn't dropped.
  FakeSocket.live = () => FakeSocket.made.filter((s) => s.readyState < 3 && s.closedWith === null);
  return FakeSocket;
}

// A person, a workspace of Olga's with that person as a member in general, and the person's device and service.
async function twoPeople(server, { name = 'Acme', timing, WebSocket, now, random, timers } = {}) {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name, displayName: 'Olga' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const { account, dir } = attach(server, bart);
  const svc = chatService(account, dir, { timing, WebSocket, now, random, timers });
  return { olga, bart, ws, bartMe, account, dir, svc };
}

module.exports = { secrets, PASSWORD, sleep, until, attach, signIn, newAccount, chatService, settled, watchCalls, fakeClock, fakeWebSocket, twoPeople };
