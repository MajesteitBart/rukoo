'use strict';

// RUK-234: an invitation link that comes with a sign-up or sign-in waits in the profile until the person joined with
// it (manage.js), links from rukoo.io and its former address are one server's, and team chat learns whether the
// server has it at start, signed in or not, asking again soon after a failed signed-out ask (index.js). Without the
// account server: the service parts these need are stubbed. test/chat-manage.test.js and the Electron specs cover the
// same against the real server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tempDir } = require('./tmp');
const { Manage } = require('../src/main/workspaces/manage');
const { WorkspaceService } = require('../src/main/workspaces');
const { chatApi } = require('../src/main/workspaces/ipc');
const { fakeClock } = require('./fixtures/chat-app');

const W = 'w_' + 'A'.repeat(22);
const SECRET = 'S'.repeat(43);
const OTHER = 'T'.repeat(43);
const DAY = 24 * 60 * 60 * 1000;
const HOME = { features: ['workspaces-v1'], workspace: { versions: [1, 2], home: { origin: 'https://rukoo.io', installation: 'x' } } };
const linkAt = (server, secret = SECRET) => `${server}/join#w=${W}&i=${secret}`;

// What Manage reads of the service: the profile folder, the clock, the session and the server with its info.
function stub(dir, { tag = 'tag-a', server = 'https://rukoo.io', info = HOME, clock = { now: 1_000_000 } } = {}) {
  const svc = {
    dataDir: dir,
    clock,
    now: () => clock.now,
    server,
    info,
    changes: 0,
    signedIn: Boolean(tag),
    // The session's cache is open (a pending join is offered only then).
    store: tag ? { getWs: () => null } : null,
    account: { sessionTag: tag, status: () => ({ server, info }) },
    stateChanged() {
      this.changes += 1;
    },
    hookFailed(err) {
      throw err;
    }
  };
  svc.manage = new Manage(svc);
  return svc;
}

const file = (dir) => path.join(dir, 'chat-join.json');

test('a pending join survives a restart, is offered once per run, and goes once joined', () => {
  const dir = tempDir('rukoo-join-');
  const a = stub(dir);
  a.manage.rememberJoin(`Hoi! ${linkAt('https://rukoo.io')}.`);
  assert.equal(a.manage.pendingJoin(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file(dir), 'utf8')), { link: linkAt('https://rukoo.io'), tag: 'tag-a', at: 1_000_000 });

  // The next start of the same session finds it.
  const b = stub(dir);
  assert.equal(b.manage.pendingJoin(), true);
  assert.deepEqual(b.manage.takePendingJoin(), { link: linkAt('https://rukoo.io') });
  // Not before the session's cache is open.
  const closed = stub(dir);
  closed.store = null;
  assert.equal(closed.manage.pendingJoin(), false);
  assert.equal(closed.manage.takePendingJoin(), null);
  // Shown once in this run; it stays on disk, so a restart with the dialog still open offers it again.
  assert.equal(b.manage.pendingJoin(), false);
  assert.equal(b.manage.takePendingJoin(), null);
  assert.equal(fs.existsSync(file(dir)), true);
  const c = stub(dir);
  assert.equal(c.manage.pendingJoin(), true);

  // Joining with another link leaves it; joining with its own secret ends it.
  c.manage.settled(OTHER);
  assert.equal(c.manage.pendingJoin(), true);
  c.manage.settled(SECRET);
  assert.equal(c.manage.pendingJoin(), false);
  assert.equal(fs.existsSync(file(dir)), false);
  assert.equal(stub(dir).manage.pendingJoin(), false);
});

test('Cancel, signing out, another session and seven days let a pending join go', () => {
  const dir = tempDir('rukoo-join-');
  const a = stub(dir);
  a.manage.rememberJoin(linkAt('https://rukoo.io'));
  a.manage.takePendingJoin();
  assert.equal(a.manage.dropPendingJoin(), true);
  assert.equal(fs.existsSync(file(dir)), false);

  a.manage.rememberJoin(linkAt('https://rukoo.io'));
  a.manage.onSignedOut();
  assert.equal(fs.existsSync(file(dir)), false);

  a.manage.rememberJoin(linkAt('https://rukoo.io'));
  // Another account on this computer never sees it, and its cache set-up removes it.
  const other = stub(dir, { tag: 'tag-b' });
  assert.equal(other.manage.pendingJoin(), false);
  assert.equal(other.manage.takePendingJoin(), null);
  other.manage.onSignedIn();
  assert.equal(fs.existsSync(file(dir)), false);

  // Seven days is the longest an invitation lasts.
  const clock = { now: 5_000_000 };
  const late = stub(dir, { clock });
  late.manage.rememberJoin(linkAt('https://rukoo.io'));
  clock.now += 7 * DAY - 1;
  assert.equal(stub(dir, { clock }).manage.pendingJoin(), true);
  clock.now += 2;
  assert.equal(stub(dir, { clock }).manage.pendingJoin(), false);
  assert.equal(fs.existsSync(file(dir)), false);

  // Signed out, nothing is remembered: a pending join needs the session it belongs to.
  stub(dir, { tag: null }).manage.rememberJoin(linkAt('https://rukoo.io'));
  assert.equal(fs.existsSync(file(dir)), false);
});

test('a pending link that no longer belongs to the server goes when the Join dialog checks it', async () => {
  const dir = tempDir('rukoo-join-');
  // Saved by a build that read another server's link as this one's, such as one that believed a server's own home.
  fs.writeFileSync(file(dir), JSON.stringify({ link: linkAt('https://rukoo.io'), tag: 'tag-a', at: 1_000_000 }));
  const a = stub(dir, { server: 'https://chat.example.com' });
  assert.equal(a.manage.pendingJoin(), true);
  await assert.rejects(() => a.manage.previewInvite(linkAt('https://rukoo.io')), { code: 'other_server' });
  assert.equal(a.manage.pendingJoin(), false);
  assert.equal(fs.existsSync(file(dir)), false);
});

test('without keepJoin (the browser) the pending join stays in memory', () => {
  const dir = tempDir('rukoo-join-');
  const a = stub(dir);
  a.keepJoin = false;
  a.manage.rememberJoin(linkAt('https://rukoo.io'));
  assert.equal(a.manage.pendingJoin(), true);
  assert.equal(fs.existsSync(file(dir)), false);
  assert.deepEqual(a.manage.takePendingJoin(), { link: linkAt('https://rukoo.io') });
  assert.equal(a.manage.dropPendingJoin(), true);
  assert.equal(a.manage.pendingJoin(), false);
  // A file another run left isn't read either.
  fs.writeFileSync(file(dir), JSON.stringify({ link: linkAt('https://rukoo.io'), tag: 'tag-a', at: 1_000_000 }));
  const b = stub(dir);
  b.keepJoin = false;
  assert.equal(b.manage.pendingJoin(), false);
});

test('a broken or foreign file on disk is no pending join', () => {
  const dir = tempDir('rukoo-join-');
  fs.writeFileSync(file(dir), '{not json');
  assert.equal(stub(dir).manage.pendingJoin(), false);
  fs.writeFileSync(file(dir), JSON.stringify({ link: linkAt('https://rukoo.io'), tag: 'tag-a', at: 'yesterday' }));
  assert.equal(stub(dir).manage.pendingJoin(), false);
});

test('links of rukoo.io and rukoo-account.bvdm.ai are one server for sign-up, sign-in and the setup page', () => {
  const dir = tempDir('rukoo-join-');
  // A device that still uses the former address, and one at rukoo.io: each takes the other's links.
  const old = stub(dir, { server: 'https://rukoo-account.bvdm.ai' });
  assert.deepEqual(old.manage.splitInvite(linkAt('https://rukoo.io')), {
    invite: '',
    workspaceInvite: { workspace: W, invite: SECRET },
    link: linkAt('https://rukoo.io')
  });
  assert.deepEqual(old.manage.checkLink(linkAt('https://rukoo.io')), { link: linkAt('https://rukoo.io'), host: 'rukoo.io' });
  const fresh = stub(tempDir('rukoo-join-'));
  assert.deepEqual(fresh.manage.checkLink(` ${linkAt('https://rukoo-account.bvdm.ai')} `), { link: linkAt('https://rukoo-account.bvdm.ai'), host: 'rukoo-account.bvdm.ai' });
  fresh.manage.rememberJoin(linkAt('https://rukoo-account.bvdm.ai'));
  assert.equal(fresh.manage.pendingJoin(), true);
  // Another server's link is refused at sign-up and on the setup page.
  assert.throws(() => fresh.manage.splitInvite(linkAt('https://chat.example.net')), { code: 'other_server' });
  assert.throws(() => fresh.manage.checkLink(linkAt('https://chat.example.net')), { code: 'other_server' });
  assert.throws(() => fresh.manage.checkLink('no link here'), { code: 'bad_link' });
});

// ---- GET /v1/info at start (index.js) ----

class FakeAccount extends EventEmitter {
  constructor({ saved = null, at = null, now = Date.now } = {}) {
    super();
    this.calls = 0;
    this.saved = saved;
    this.at = at;
    this.clock = now;
  }
  status() {
    return { signedIn: false, server: 'https://rukoo.io', info: this.saved };
  }
  get sessionTag() {
    return null;
  }
  infoAt() {
    return this.at;
  }
  async serverInfo() {
    this.calls += 1;
    this.saved = HOME;
    this.at = this.clock();
    this.emit('info', HOME);
    return HOME;
  }
}

function service(account, opts = {}) {
  const svc = new WorkspaceService({ account, dataDir: tempDir('rukoo-info-'), timing: { coalesce: 1 }, WebSocket: null, ...opts }).init();
  return svc;
}

test('signed out, Chat learns at start whether the server has team chat, once', async () => {
  const account = new FakeAccount();
  const svc = service(account);
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(account.calls, 1);
    assert.equal(svc.state().available, true);
    assert.equal(svc.state().signedIn, false);
    // More status events within the hour ask nothing.
    account.emit('status');
    account.emit('status');
    assert.equal(account.calls, 1);
  } finally {
    svc.close();
  }
});

test('a saved answer from the last hour is used as it is; an older one is asked again', async () => {
  const now = Date.now();
  const fresh = new FakeAccount({ saved: HOME, at: now - 10 * 60 * 1000 });
  const a = service(fresh);
  const old = new FakeAccount({ saved: HOME, at: now - 2 * 60 * 60 * 1000 });
  const b = service(old);
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(fresh.calls, 0);
    assert.equal(a.state().available, true);
    assert.equal(old.calls, 1);
  } finally {
    a.close();
    b.close();
  }
});

test('asks on their way are shared, and the hourly ask skips an answer that is still fresh', async () => {
  let release;
  const account = new FakeAccount();
  const slow = account.serverInfo.bind(account);
  account.serverInfo = () => {
    account.calls += 1;
    return new Promise((resolve) => (release = () => resolve(slow().then(() => (account.calls -= 1)))));
  };
  const svc = service(account);
  try {
    // The start asked; a second ask while it is on its way shares it.
    const again = svc.refreshInfo();
    assert.equal(account.calls, 1);
    release();
    await again;
    assert.equal(account.calls, 1);
    // A fresh answer: the hourly ask (maxAge 54 minutes) leaves it.
    svc.infoTries.clear();
    svc.maybeRefreshInfo({ maxAge: 54 * 60 * 1000 });
    assert.equal(account.calls, 1);
  } finally {
    svc.close();
  }
});

test('tests that name no server of their own ask nothing (autoInfo off)', async () => {
  const account = new FakeAccount();
  const svc = service(account, { autoInfo: false });
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(account.calls, 0);
    assert.equal(svc.state().available, false);
  } finally {
    svc.close();
  }
});

// A fresh install started before the network was up (RUK-234 review): Chat and the setup page's team chat show soon
// after the network comes, not at the next hourly tick.
// asked counts every GET /v1/info. down: each one fails as without network. hold: the answer waits for release().
function failingAccount(clock) {
  const account = new FakeAccount({ now: clock.now });
  const answer = account.serverInfo.bind(account);
  account.asked = 0;
  account.down = true;
  account.hold = false;
  account.serverInfo = () => {
    account.asked += 1;
    if (account.down) return Promise.reject(new Error('offline'));
    if (account.hold) return new Promise((resolve) => (account.release = () => resolve(answer())));
    return answer();
  };
  return account;
}

test('a signed-out ask that failed comes again after 15 s, a minute and five minutes, then at the hourly tick', async () => {
  const clock = fakeClock(10_000_000);
  const account = failingAccount(clock);
  const svc = service(account, { now: clock.now, timers: clock });
  try {
    await clock.tick();
    assert.equal(account.asked, 1);
    assert.equal(svc.state().available, false);
    for (const [wait, asked] of [[15_000, 2], [60_000, 3], [5 * 60_000, 4]]) {
      await clock.advance(wait - 1);
      assert.equal(account.asked, asked - 1, `not before ${wait} ms`);
      await clock.advance(1);
      assert.equal(account.asked, asked, `after ${wait} ms`);
    }
    // No more retries of their own: the hourly tick asks next.
    await clock.advance(50 * 60_000);
    assert.equal(account.asked, 4);
    account.down = false;
    await clock.advance(10 * 60_000);
    assert.equal(account.asked, 5);
    assert.equal(svc.state().available, true);
    assert.equal(svc.infoRetryTimers.size, 0);
  } finally {
    svc.close();
  }
});

test('focus, a wake, going online and the setup page ask again after a failure, within the shared gate', async () => {
  const clock = fakeClock(10_000_000);
  const account = failingAccount(clock);
  const svc = service(account, { now: clock.now, timers: clock });
  const api = chatApi(() => svc);
  try {
    await clock.tick();
    assert.equal(account.asked, 1);
    // Within 15 s of the last ask, a focus or the setup page asks nothing.
    await clock.advance(5_000);
    svc.setFocused(true);
    svc.setFocused(false);
    assert.equal(await api.chatRetryInfo(), true);
    assert.equal(account.asked, 1);
    // The first retry fails too, and the next would wait a minute.
    await clock.advance(10_000);
    assert.equal(account.asked, 2);
    // The network is back 20 s later: the window's online event asks at once, and the retry timer goes.
    await clock.advance(20_000);
    account.down = false;
    account.hold = true;
    assert.equal(await api.chatRetryInfo(), true);
    assert.equal(account.asked, 3);
    assert.equal(svc.infoRetryTimers.size, 0);
    // A wake, a focus and the setup page share the ask on its way.
    svc.nudge('resume');
    svc.setFocused(true);
    await api.chatRetryInfo();
    assert.equal(account.asked, 3);
    account.release();
    await clock.tick();
    assert.equal(svc.state().available, true);
    // After an answer nothing asks again before the hour.
    await clock.advance(5 * 60_000);
    svc.setFocused(false);
    svc.setFocused(true);
    await api.chatRetryInfo();
    assert.equal(account.asked, 3);
  } finally {
    svc.close();
  }
});

test('signed in, a failed ask is left to the hourly tick', async () => {
  const clock = fakeClock(10_000_000);
  const account = failingAccount(clock);
  account.status = () => ({ signedIn: true, server: 'https://rukoo.io', info: null });
  const svc = new WorkspaceService({ account, dataDir: tempDir('rukoo-info-'), timing: { coalesce: 1 }, WebSocket: null, now: clock.now, timers: clock });
  svc.openCache = () => {};
  svc.startNetwork = () => {};
  svc.init();
  try {
    await clock.tick();
    assert.equal(account.asked, 1);
    await clock.advance(10 * 60_000);
    svc.retryInfo();
    svc.nudge('focus');
    assert.equal(account.asked, 1);
    assert.equal(svc.infoRetryTimers.size, 0);
  } finally {
    svc.close();
  }
});

// A server switch while asks fail (RUK-234 review): each server keeps its own retry, and one asks only while it is the
// configured server.
function switchingAccount(clock) {
  const account = failingAccount(clock);
  account.server = 'https://rukoo.io';
  account.status = () => ({ signedIn: false, server: account.server, info: account.server === 'https://rukoo.io' ? account.saved : null });
  account.switchTo = (server) => {
    account.server = server;
    account.emit('status');
  };
  return account;
}

test("switching servers and back keeps the first server's retry", async () => {
  const clock = fakeClock(10_000_000);
  const account = switchingAccount(clock);
  const svc = service(account, { now: clock.now, timers: clock });
  try {
    await clock.tick();
    assert.equal(account.asked, 1);
    // Another server for a moment: it is asked, fails and gets a retry of its own.
    await clock.advance(5_000);
    account.switchTo('https://chat.example.com');
    await clock.tick();
    assert.equal(account.asked, 2);
    // Back within the short gap: nothing asks at once, and the first server's retry still comes at 15 s.
    await clock.advance(5_000);
    account.switchTo('https://rukoo.io');
    await clock.tick();
    assert.equal(account.asked, 2);
    await clock.advance(5_000);
    assert.equal(account.asked, 3);
    // The other server's retry comes while it isn't configured: it asks nothing.
    await clock.advance(5_000);
    assert.equal(account.asked, 3);
    // Switching to it after its retry was due asks at once.
    account.switchTo('https://chat.example.com');
    await clock.tick();
    assert.equal(account.asked, 4);
  } finally {
    svc.close();
  }
});

test("an ask of the former server that fails after a switch leaves the new server's retry", async () => {
  const clock = fakeClock(10_000_000);
  const account = switchingAccount(clock);
  const waiting = [];
  account.serverInfo = (server) => {
    account.asked += 1;
    return new Promise((resolve, reject) => waiting.push({ server, reject }));
  };
  const svc = service(account, { now: clock.now, timers: clock });
  try {
    await clock.tick();
    account.switchTo('https://chat.example.com');
    await clock.tick();
    assert.deepEqual(waiting.map((w) => w.server), ['https://rukoo.io', 'https://chat.example.com']);
    waiting[1].reject(new Error('offline'));
    await clock.advance(1_000);
    waiting[0].reject(new Error('offline'));
    await clock.tick();
    // The configured server's retry, 15 s after its failure, still comes.
    await clock.advance(14_100);
    assert.equal(account.asked, 3);
    assert.equal(waiting[2].server, 'https://chat.example.com');
  } finally {
    svc.close();
  }
});

test('an answer that came another way ends the retries of a failed ask', async () => {
  const clock = fakeClock(10_000_000);
  const account = failingAccount(clock);
  const svc = service(account, { now: clock.now, timers: clock });
  try {
    await clock.tick();
    assert.equal(account.asked, 1);
    // The account page in Settings fetched the info itself (account/index.js serverInfo), five seconds later.
    await clock.advance(5_000);
    account.saved = HOME;
    account.at = clock.now();
    account.emit('info', HOME);
    await clock.tick();
    assert.equal(svc.state().available, true);
    // The retry due at 15 s asks nothing, and neither does a focus.
    await clock.advance(20_000);
    svc.setFocused(true);
    assert.equal(account.asked, 1);
  } finally {
    svc.close();
  }
});
