'use strict';

// RUK-234: an invitation link that comes with a sign-up or sign-in waits in the profile until the person joined with
// it (manage.js), links from rukoo.io and its former address are one server's, and team chat learns whether the
// server has it at start, signed in or not (index.js). Without the account server: the service parts these need are
// stubbed. test/chat-manage.test.js and the Electron specs cover the same against the real server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tempDir } = require('./tmp');
const { Manage } = require('../src/main/workspaces/manage');
const { WorkspaceService } = require('../src/main/workspaces');

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
  const info = { ...HOME };
  const a = stub(dir, { server: 'https://rukoo-account.bvdm.ai', info });
  a.account.status = () => ({ server: 'https://rukoo-account.bvdm.ai', info: a.info });
  a.manage.rememberJoin(linkAt('https://rukoo.io'));
  assert.equal(a.manage.pendingJoin(), true);
  // The server no longer names rukoo.io as its home: the link is another server's now.
  a.info = null;
  await assert.rejects(() => a.manage.previewInvite(linkAt('https://rukoo.io')), { code: 'other_server' });
  assert.equal(a.manage.pendingJoin(), false);
  assert.equal(fs.existsSync(file(dir)), false);
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
  // Another server's link stays an invite code for sign-up, and the setup page refuses it.
  assert.equal(fresh.manage.splitInvite(linkAt('https://chat.example.net')).workspaceInvite, null);
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
