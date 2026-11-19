'use strict';

// The WorkspaceService (src/main/workspaces/index.js) following the Rukoo account, its state and events, and the IPC
// table (ipc.js), as contract 8.4 lists for chat-service. Against the real account server
// (test/fixtures/real-server.js), with team chat on and, for one test, off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { startRealServer, realServerAvailable, skipWithoutServer } = require('./fixtures/real-server');
const { PASSWORD, attach, signIn, newAccount, chatService, settled, watchCalls, twoPeople, until, sleep } = require('./fixtures/chat-app');
const { tempDir } = require('./tmp');
const { WorkspaceService, chatTiming, blankState, isAvailable } = require('../src/main/workspaces');
const { chatApi } = require('../src/main/workspaces/ipc');
const { openStore, SCHEMA } = require('../src/main/workspaces/store');
const { ChatError } = require('../src/main/workspaces/wire');
const { AccountError } = require('../src/main/account/client');
const { History } = require('../src/main/workspaces/history');
const { Outbox } = require('../src/main/workspaces/outbox');
const { Manage } = require('../src/main/workspaces/manage');
const { Notifier } = require('../src/main/workspaces/notify');

let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') server = await startRealServer();
});
test.after(() => server?.close());

async function setup(t, options = {}) {
  const made = await twoPeople(server, options);
  t.after(() => {
    made.svc.close();
    made.account.close();
  });
  await settled(made.svc, made.ws.id);
  return made;
}

const files = (dir) => ['chat.db', 'chat.db-wal', 'chat.db-shm'].filter((f) => fs.existsSync(path.join(dir, f)));

test('signing in opens the cache and lists; signing out deletes it with its unsent messages', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga);
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const { account, dir } = newAccount(server);
  const svc = chatService(account, dir);
  t.after(() => {
    svc.close();
    account.close();
  });
  // Signed out: nothing on disk, and Chat says so once the server's info is known.
  assert.deepEqual(files(dir), []);
  assert.equal(svc.state().signedIn, false);
  account.attach(bart.email, bart.token, require('crypto').randomBytes(32));
  await settled(svc, ws.id);
  assert.deepEqual(files(dir).sort(), ['chat.db', 'chat.db-shm', 'chat.db-wal']);
  const state = svc.state();
  assert.equal(state.signedIn, true);
  assert.equal(state.available, true);
  assert.equal(state.selected, ws.id);
  assert.deepEqual(svc.me(ws.id), { id: bartMe.id, name: 'Bart', role: 'member' });
  const room = svc.store.getRoom(ws.id, ws.general);
  svc.store.insertOutbox({ local: 'AAAAAAAAAAAAAAAAAAAAAA', ws: ws.id, room: ws.general, actor: bartMe.id, grantId: room.grantId, generation: svc.store.getWs(ws.id).generation, text: 'never sent', mentions: [], createdAt: Date.now() });
  svc.store.putDraft(ws.id, ws.general, null, { text: 'a draft', mentions: [] });
  await account.signOut();
  assert.deepEqual(files(dir), []);
  assert.equal(svc.store, null);
  const after = svc.state();
  assert.equal(after.signedIn, false);
  assert.equal(after.available, true, 'the server still has team chat');
  assert.deepEqual(after.workspaces, []);
  assert.equal(after.unsent, 0);
  assert.equal(after.connection, 'idle');
  await sleep(20);
  assert.equal(svc.events.filter((e) => e.kind === 'state').at(-1).state.signedIn, false);
});

test('deleting the account deletes the cache', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga);
  await server.seedMember(ws, bart, 'Bart');
  const { account, dir } = await signIn(server, bart);
  const svc = chatService(account, dir);
  t.after(() => {
    svc.close();
    account.close();
  });
  await settled(svc, ws.id);
  assert.ok(files(dir).includes('chat.db'));
  await account.deleteAccount(PASSWORD);
  assert.equal(account.signedIn, false);
  assert.deepEqual(files(dir), []);
  assert.equal(svc.state().signedIn, false);
});

test('a session that ended elsewhere deletes the cache at the next request', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, svc, dir } = await setup(t);
  assert.equal((await server.call('POST', '/v1/logout', { token: bart.token })).status, 204);
  const state = await chatApi(() => svc).chatSync();
  assert.equal(state.signedIn, false);
  assert.deepEqual(files(dir), []);
  await assert.rejects(chatApi(() => svc).chatView(svc.selected || 'w_AAAAAAAAAAAAAAAAAAAAAA'), (err) => err.code === 'signed_out');
});

test('a cache of another session or server is deleted and made again', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, account, dir } = await setup(t);
  const tag = account.sessionTag;
  assert.equal(svc.store.getMeta('session'), tag);
  assert.equal(svc.store.getMeta('server'), server.url);
  let current = svc;
  for (const [key, value] of [
    ['session', 'AnotherSessionTagXXXXX'],
    ['server', 'https://other.example']
  ]) {
    current.store.putDraft(ws.id, ws.general, null, { text: `left by ${key}`, mentions: [] });
    current.store.setMeta(key, value);
    current.close();
    // The next start finds a file that isn't this session's.
    const next = chatService(account, dir);
    t.after(() => next.close());
    assert.equal(next.store.getMeta('session'), tag);
    assert.equal(next.store.getMeta('server'), server.url);
    assert.equal(next.store.getDraft(ws.id, ws.general, null), null);
    assert.ok(!fs.readFileSync(path.join(dir, 'chat.db')).includes(Buffer.from(`left by ${key}`)));
    await settled(next, ws.id);
    assert.ok(next.store.getRoom(ws.id, ws.general));
    current = next;
  }
  current.close();
  // The same session's file is shown at once: the rooms are there as init() returns, before any answer, and the sync
  // goes on in the background.
  const again = new WorkspaceService({ account, dataDir: dir, timing: { coalesce: 5 }, WebSocket: null });
  again.init();
  t.after(() => again.close());
  assert.ok(again.store.getRoom(ws.id, ws.general), 'cached rooms without waiting for the server');
  const state = again.state();
  assert.equal(state.workspaces[0].status, 'ok');
  assert.equal(state.selected, ws.id);
  assert.equal(again.listedAt, -Infinity, 'no listing has answered yet');
});

test('a server without team chat gets no workspace requests, and Chat is unavailable', async (t) => {
  if (skipWithoutServer(t)) return;
  const off = await startRealServer({ vars: { WORKSPACE_MODE: 'off' } });
  t.after(() => off.close());
  const bart = await off.seedAccount();
  const { account, dir } = newAccount(off);
  const routes = [];
  const http = account.http;
  account.http = (srv, method, route, opts) => {
    routes.push(`${method} ${route}`);
    return http(srv, method, route, opts);
  };
  const svc = chatService(account, dir);
  t.after(() => {
    svc.close();
    account.close();
  });
  account.attach(bart.email, bart.token, require('crypto').randomBytes(32));
  await until(() => routes.filter((r) => r === 'GET /v1/info').length >= 1, 5000, 'the info refresh after the sign-in');
  await sleep(300);
  svc.setFocused(true);
  svc.nudge('resume');
  await sleep(200);
  assert.deepEqual(routes.filter((r) => r.includes('/v1/workspaces')), []);
  const state = svc.state();
  assert.equal(state.available, false);
  assert.equal(state.signedIn, true);
  assert.equal(state.connection, 'idle');
  assert.deepEqual(files(dir), [], 'no cache file without team chat');
  await assert.rejects(chatApi(() => svc).chatSync(), (err) => err.code === 'signed_out');
  assert.equal(isAvailable(account.status().info), false);
});

const STATE_KEYS = [
  'available', 'storage', 'signedIn', 'server', 'host', 'operator', 'jurisdiction', 'signups', 'inviteSignups', 'retention', 'limits',
  'notifications', 'pendingJoin', 'unsent', 'lostUnsent', 'selected', 'connection', 'attention', 'unread', 'workspaces'
].sort();
const SUMMARY_KEYS = ['id', 'name', 'role', 'status', 'syncing', 'socket', 'error', 'attention', 'unread'].sort();
const ROOM_KEYS = [
  'id', 'kind', 'name', 'visibility', 'archived', 'closedReason', 'participants', 'startedBy', 'role', 'members', 'head', 'floor', 'lastAt',
  'read', 'unread', 'mentions', 'attention', 'muted', 'hasCache'
].sort();

test('ChatState, WorkspaceView and the events have the shapes of contract 4.5 and 4.6', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc } = await setup(t);
  const state = svc.state();
  assert.deepEqual(Object.keys(state).sort(), STATE_KEYS);
  assert.deepEqual(Object.keys(state.workspaces[0]).sort(), SUMMARY_KEYS);
  assert.equal(state.server, server.url);
  assert.equal(state.host, new URL(server.url).host);
  assert.deepEqual(state.operator, { name: 'Test operator', url: 'https://example.test' });
  assert.equal(state.signups, 'invite');
  assert.deepEqual(Object.keys(state.retention).sort(), ['contentDays', 'feedDays']);
  assert.deepEqual(Object.keys(state.limits).sort(), ['members', 'workspacesPerAccount']);
  assert.equal(state.notifications, true);
  assert.equal(state.workspaces[0].status, 'ok');
  assert.equal(state.workspaces[0].socket, 'off');
  const view = await chatApi(() => svc).chatView(ws.id);
  assert.deepEqual(Object.keys(view).sort(), ['blocks', 'channels', 'me', 'members', 'membersMore', 'rooms', 'ws']);
  assert.deepEqual(Object.keys(view.rooms[0]).sort(), ROOM_KEYS);
  assert.deepEqual(Object.keys(view.me).sort(), ['id', 'joinedAt', 'kind', 'name', 'role', 'state']);
  assert.deepEqual(Object.keys(view.channels[0]).sort(), ['archived', 'id', 'joined', 'members', 'name', 'role', 'visibility']);
  assert.equal(view.me.name, 'Bart');
  assert.equal(view.rooms[0].hasCache, false);

  // Olga's message shows as unread in general, and the totals follow: a channel asks for attention on mentions only.
  svc.events.length = 0;
  await server.post(olga, ws.id, ws.general, 'Morning');
  await svc.sync(ws.id);
  await sleep(30);
  const rooms = svc.events.filter((e) => e.kind === 'rooms');
  assert.equal(rooms.length, 1);
  assert.deepEqual(Object.keys(rooms[0]).sort(), ['kind', 'removed', 'rooms', 'ws']);
  assert.deepEqual(Object.keys(rooms[0].rooms[0]).sort(), ROOM_KEYS);
  assert.equal(rooms[0].rooms[0].unread, 1);
  assert.equal(rooms[0].rooms[0].attention, 0);
  const states = svc.events.filter((e) => e.kind === 'state');
  assert.ok(states.length >= 1);
  assert.deepEqual(Object.keys(states.at(-1)).sort(), ['kind', 'state']);
  assert.equal(states.at(-1).state.unread, true);
  assert.equal(states.at(-1).state.attention, 0);

  // Many changes inside the coalescing window go out as one rooms event, and a state equal to the last isn't sent.
  svc.events.length = 0;
  for (let n = 0; n < 5; n++) svc.roomsChanged(ws.id, [ws.general]);
  svc.emitChat({ kind: 'state' });
  await sleep(30);
  assert.equal(svc.events.filter((e) => e.kind === 'rooms').length, 1);
  assert.equal(svc.events.filter((e) => e.kind === 'state').length, 0);
  // Other kinds go at once.
  svc.emitChat({ kind: 'directory', ws: ws.id });
  assert.deepEqual(svc.events.at(-1), { kind: 'directory', ws: ws.id });
  // Muting a room takes its attention away; a DM asks for its unread messages.
  svc.store.setRoomFields(ws.id, ws.general, { mentions: 3 });
  assert.equal(svc.state().attention, 3);
  svc.store.setRoomFields(ws.id, ws.general, { muted: 1 });
  assert.equal(svc.state().attention, 0);
  assert.equal(svc.state().unread, false);
  // Notifications go to main.js by id.
  const shown = [];
  const hidden = [];
  svc.on('notify', (n) => shown.push(n));
  svc.on('unnotify', (id) => hidden.push(id));
  svc.show({ id: 'n1', title: '#general', body: 'Olga: Morning', open: { ws: ws.id, conversation: ws.general, seq: 4 } });
  svc.hide('n1');
  assert.equal(shown[0].id, 'n1');
  assert.deepEqual(hidden, ['n1']);
});

test('focus lists the workspaces again at most once a minute', async (t) => {
  if (skipWithoutServer(t)) return;
  let offset = 0;
  const now = () => Date.now() + offset;
  const { svc, account, ws } = await setup(t, { now });
  const calls = watchCalls(account);
  const listings = () => calls.filter((c) => c.route === '/v1/workspaces').length;
  svc.setFocused(true);
  svc.setFocused(false);
  svc.nudge('resume');
  svc.setFocused(true);
  await sleep(200);
  assert.equal(listings(), 0, 'listed at start, under a minute ago');
  // The selected workspace runs on focus, at most once per 5 seconds.
  await until(() => calls.some((c) => c.route.includes('/changes')), 3000, 'a run on focus');
  offset += 61000;
  svc.setFocused(false);
  svc.setFocused(true);
  await until(() => listings() === 1, 3000, 'a listing on focus a minute later');
  svc.setFocused(false);
  svc.setFocused(true);
  svc.nudge('resume');
  await sleep(200);
  assert.equal(listings(), 1);
  offset += 61000;
  svc.nudge('resume');
  await until(() => listings() === 2, 3000, 'a listing on resume');
  assert.ok(svc.store.getWs(ws.id));
});

test('the IPC table checks arguments first, needs a cache and never passes the engines\' own codes on', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, account } = await setup(t);
  const api = chatApi(() => svc);
  const calls = watchCalls(account);
  for (const [method, args, field] of [
    ['chatSelect', ['w_short'], 'ws'],
    ['chatView', [42], 'ws'],
    ['chatSync', ['c_AAAAAAAAAAAAAAAAAAAAAA'], 'ws'],
    ['chatReload', [null], 'ws']
  ]) {
    await assert.rejects(api[method](...args), (err) => err instanceof ChatError && err.code === 'invalid' && err.field === field, method);
  }
  assert.equal(calls.length, 0, 'no request for a refused argument');
  await assert.rejects(api.chatView('w_AAAAAAAAAAAAAAAAAAAAAA'), (err) => err.code === 'not_found' && err.scope === 'workspace');
  // chatState answers without a service; the rest need one with a cache.
  const none = chatApi(() => null);
  assert.deepEqual(await none.chatState(), blankState());
  await assert.rejects(none.chatSelect(ws.id), (err) => err.code === 'signed_out');
  // A code the engines handle never reaches the window; an answer for an ended session reads as signed_out.
  watchCalls(account, async () => {
    throw new AccountError('stale_grant', 409, 'stale', { scope: 'conversation' });
  });
  svc.select(null);
  const fake = { ...svc, store: svc.store, select: () => svc.call(ws.id, 'GET', '/channels') };
  await assert.rejects(chatApi(() => fake).chatSelect(ws.id), (err) => err.code === 'server');
  const stale = { store: svc.store, select: () => Promise.reject(Object.assign(new Error('x'), { stale: true })) };
  await assert.rejects(chatApi(() => stale).chatSelect(ws.id), (err) => err.code === 'signed_out');
  // Selecting is kept for the next start.
  account.workspaceCall = Object.getPrototypeOf(account).workspaceCall.bind(account);
  const state = await api.chatSelect(ws.id);
  assert.equal(state.selected, ws.id);
  assert.equal(svc.store.getMeta('selected'), ws.id);
});

test('debugState shows the cache and sockets without tokens, tickets or message text', async (t) => {
  if (skipWithoutServer(t)) return;
  const tickets = [];
  const made = await twoPeople(server, { WebSocket: globalThis.WebSocket });
  const { olga, bart, ws, svc, account } = made;
  t.after(() => {
    svc.close();
    account.close();
  });
  watchCalls(account, async (method, url, real) => {
    if (!url.endsWith('/socket-ticket')) return undefined;
    const answer = await real();
    tickets.push(answer.ticket);
    return answer;
  });
  await settled(svc, ws.id);
  await server.post(olga, ws.id, ws.general, 'A secret message text');
  await svc.sync(ws.id);
  svc.store.appendEvents(ws.id, ws.general, (await svc.call(ws.id, 'GET', `/conversations/${ws.general}/events?after=0&limit=50`)).events);
  svc.updateSockets();
  await until(() => svc.socketState(ws.id) === 'open' && tickets.length > 0, 10000, 'a socket');
  const debug = svc.debugState();
  const json = JSON.stringify(debug);
  assert.ok(!json.includes(bart.token), 'no session token');
  assert.ok(!json.includes(bart.token.split('.')[1]), 'no part of it');
  for (const ticket of tickets) assert.ok(!json.includes(ticket), 'no ticket');
  assert.ok(!json.includes('A secret message text'), 'no message text');
  assert.equal(debug.workspaces[0].socket, 'open');
  assert.equal(debug.workspaces[0].cursor, true);
  assert.ok(debug.workspaces[0].events > 0);
  assert.equal(debug.file, path.join(made.dir, 'chat.db'));
});

test('a broken cache file is replaced, and its unsent messages are reported once', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga);
  await server.seedMember(ws, bart, 'Bart');
  const dir = tempDir('rukoo-chat-broken-');
  // A file of a newer schema with two unsent messages in it.
  const db = new DatabaseSync(path.join(dir, 'chat.db'));
  try {
    db.exec(SCHEMA);
    db.exec(`INSERT INTO meta (key, value) VALUES ('schema', '2')`);
    db.exec(`INSERT INTO ws (id, name, role) VALUES ('w', 'Old', 'member')`);
    db.exec(`INSERT INTO room (ws, id, kind, visibility, archived, grantId, members, head, floor, read, readLocal, readSent, unread, mentions)
             VALUES ('w', 'c', 'channel', 'workspace', 0, 'g', 2, 1, 1, 0, 0, 0, 0, 0)`);
    for (const local of ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB']) {
      db.prepare(`INSERT INTO outbox (local, ws, room, actor, grantId, generation, text, mentions, state, createdAt) VALUES (?, 'w', 'c', 'u', 'g', 'x', 'lost words', '[]', 'queued', 1)`).run(local);
    }
  } finally {
    db.close();
  }
  const { account } = attach(server, bart, { dir });
  const svc = chatService(account, dir);
  t.after(() => {
    svc.close();
    account.close();
  });
  assert.equal(svc.state().lostUnsent, 2);
  assert.equal((await chatApi(() => svc).chatState()).lostUnsent, 2);
  assert.equal(svc.state().lostUnsent, 0, 'reported once');
  await settled(svc, ws.id);
  assert.equal(svc.store.getMeta('schema'), '1');
  assert.equal(svc.store.countUnsent(), 0);
});

test('a cache that can\'t be opened shows the storage state and is tried again', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga);
  await server.seedMember(ws, bart, 'Bart');
  const dir = tempDir('rukoo-chat-storage-');
  // A folder where the file goes: SQLite can't open it, and it can't be deleted as a file.
  fs.mkdirSync(path.join(dir, 'chat.db'));
  const { account } = attach(server, bart, { dir });
  const svc = chatService(account, dir, { timing: { wipeRetry: 200 } });
  t.after(() => {
    svc.close();
    account.close();
  });
  await until(() => svc.state().available, 5000, 'the server info');
  const state = svc.state();
  assert.equal(state.storage, false);
  assert.equal(state.signedIn, true);
  assert.deepEqual(state.workspaces, []);
  await assert.rejects(chatApi(() => svc).chatSync(), (err) => err.code === 'signed_out');
  // Once the way is clear, the retry opens the cache and the workspace syncs.
  fs.rmdirSync(path.join(dir, 'chat.db'));
  await settled(svc, ws.id);
  assert.equal(svc.state().storage, true);
});

test('chatTiming turns the test knobs on only in test mode', () => {
  assert.deepEqual(chatTiming({}), {});
  assert.deepEqual(chatTiming({ SEM_CHAT_FAST: '1', SEM_CHAT_RETRY_DELAY: '3000' }), {});
  const fast = chatTiming({ SEM_HIDDEN: '1', SEM_CHAT_FAST: '1' });
  assert.equal(fast.readFlush, 300);
  assert.equal(fast.catchupFocused, 2000);
  assert.equal(fast.catchupAway, 2000);
  for (const key of ['syncBackoff', 'sendBackoff', 'socketBackoff']) assert.equal(fast[key][0], 100, key);
  assert.equal(chatTiming({ SEM_HIDDEN: '1', SEM_CHAT_RETRY_DELAY: '3000' }).retryDelay, 3000);
  assert.equal(chatTiming({ SEM_HIDDEN: '1', SEM_CHAT_RETRY_DELAY: 'soon' }).retryDelay, undefined);
});

test('the modules other packages fill in start as hooks that do nothing', () => {
  const svc = {};
  for (const Module of [History, Outbox, Manage, Notifier]) {
    // A module that its package filled in answers its chat* methods; the others still answer none.
    for (const fn of Object.values(Module.METHODS)) assert.equal(typeof fn, 'function');
    assert.equal(new Module(svc).svc, svc);
  }
  const history = new History(svc);
  assert.equal(history.activeQuery('w'), null);
  for (const hook of ['afterPage', 'afterRun', 'onReset', 'onEvicted', 'onWorkspaceGone']) assert.equal(typeof history[hook], 'function');
  const outbox = new Outbox(svc);
  assert.equal(outbox.unsent(), 0);
  assert.equal(typeof outbox.kick, 'function');
  const manage = new Manage(svc);
  assert.deepEqual(manage.splitInvite('an-invite-code'), { invite: 'an-invite-code', workspaceInvite: null, link: null });
  assert.equal(manage.pendingJoin(), false);
  for (const hook of ['rememberJoin', 'onSignedIn']) assert.equal(typeof manage[hook], 'function');
  const notifier = new Notifier(svc);
  for (const hook of ['afterRun', 'onRead', 'onRemoved', 'onEvicted', 'onWorkspaceGone', 'clear']) assert.equal(typeof notifier[hook], 'function');
  // The core methods, and those the modules add.
  const modules = [History, Outbox, Manage].flatMap((Module) => Object.keys(Module.METHODS));
  assert.deepEqual(Object.keys(chatApi(() => null)).sort(), ['chatReload', 'chatSelect', 'chatState', 'chatSync', 'chatView', ...modules].sort());
});

test('close() is synchronous and leaves the cache for the next start', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, account, dir } = await setup(t, { WebSocket: globalThis.WebSocket });
  await until(() => svc.socketState(ws.id) === 'open', 10000, 'the socket');
  const socket = svc.sockets.get(ws.id);
  svc.close();
  assert.equal(socket.state, 'off');
  assert.equal(svc.store, null);
  assert.ok(files(dir).includes('chat.db'));
  const store = openStore(path.join(dir, 'chat.db'));
  assert.ok(store.getWs(ws.id));
  store.close();
  assert.equal(account.signedIn, true);
});
