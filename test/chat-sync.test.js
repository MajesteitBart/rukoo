'use strict';

// The feed engine (src/main/workspaces/sync.js) through the WorkspaceService, against the real account server
// (test/fixtures/real-server.js), as contract 8.4 lists for chat-sync. Answers the real server can't give on demand
// (a floor from retention, removedMore, 409 history_regressed, a malformed field) are synthetic: a real answer with one
// field changed, or the error the server sends for that case, handed to the service in place of the real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startRealServer, realServerAvailable, skipWithoutServer } = require('./fixtures/real-server');
const { attach, chatService, settled, watchCalls, twoPeople, until, sleep } = require('./fixtures/chat-app');
const wire = require('../src/main/workspaces/wire');
const { AccountError } = require('../src/main/account/client');
const { chatApi } = require('../src/main/workspaces/ipc');

let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') server = await startRealServer();
});
test.after(() => server?.close());

// Two people, Olga's workspace, and Bart's service after its first pass. Closed with the test.
async function setup(t, options = {}) {
  const made = await twoPeople(server, options);
  t.after(() => {
    made.svc.close();
    made.account.close();
  });
  await settled(made.svc, made.ws.id);
  return made;
}

// What the history module does when a room opens: the newest page into the cache.
async function cacheRoom(svc, ws, room) {
  const row = svc.store.getRoom(ws, room);
  const page = wire.checkEvents(await svc.call(ws, 'GET', `/conversations/${room}/events?before=${row.head + 1}&limit=50`));
  svc.store.appendEvents(ws, room, page.events);
  return svc.store.getRoom(ws, room);
}

const ofKind = (svc, kind) => svc.events.filter((e) => e.kind === kind);

// The outbox sends nothing: for the tests about what the sync engine marks in rows they wrote themselves.
const holdOutbox = (svc) => {
  svc.outbox.pump = () => {};
};
const route = (ws, rest = '') => `/v1/workspaces/${ws}${rest}`;

// Holds the next /changes answer, which the server already gave, until held.release(). held.waiting turns true once
// the answer is in.
function holdNextPage(svc, ws) {
  const held = { waiting: false };
  const gate = new Promise((resolve) => (held.release = resolve));
  let hold = true;
  watchCalls(svc.account, async (method, url, real) => {
    if (!hold || !url.startsWith(route(ws, '/changes'))) return undefined;
    hold = false;
    const answer = await real();
    held.waiting = true;
    await gate;
    return answer;
  });
  return held;
}

test('a first pass over several pages installs at once and survives a restart between pages', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Pages' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  for (const name of ['one', 'two', 'three', 'four']) await server.seedChannel(olga, ws.id, { name, members: [bartMe.id] });
  const { account, dir } = attach(server, bart);
  t.after(() => account.close());
  // One room per page, two pages per run, and the run that follows a cut-short one held back.
  const timing = { feedLimit: 1, pagesPerRun: 2, moreAfter: 600000 };
  const first = chatService(account, dir, { timing });
  await until(() => {
    const row = first.store && first.store.getWs(ws.id);
    return row && row.cursor && !(first.runners.get(ws.id) || {}).running;
  }, 15000, 'two pages of the pass');
  // Halfway: two rooms wait in pass_room, none is in room, and the workspace still passes.
  let row = first.store.getWs(ws.id);
  assert.equal(row.passing, 1);
  assert.equal(row.fresh, 1);
  assert.deepEqual(first.store.listRooms(ws.id), []);
  assert.equal(first.store.listPassRooms(ws.id).length, 2);
  assert.equal(first.state().workspaces[0].status, 'loading');
  const cursor = row.cursor;
  first.close();

  // A new start on the same file goes on from the stored cursor and pass_room.
  const calls = watchCalls(account);
  const second = chatService(account, dir, { timing: { feedLimit: 1, pagesPerRun: 50 } });
  t.after(() => second.close());
  await settled(second, ws.id);
  const feed = calls.filter((c) => c.route.startsWith(route(ws.id, '/changes')));
  assert.ok(feed[0].route.includes(`after=${cursor}`), 'the first page after the restart starts from the stored cursor');
  row = second.store.getWs(ws.id);
  assert.equal(row.passing, 0);
  assert.equal(row.fresh, 0);
  assert.equal(second.store.listPassRooms(ws.id).length, 0);
  const rooms = second.store.listRooms(ws.id);
  assert.equal(rooms.length, 5);
  // The first pass alerts nothing: every room counts as notified up to its head.
  for (const room of rooms) assert.equal(room.notified, room.head);
  // The rooms arrived together: one rooms event lists all five.
  const roomEvents = ofKind(second, 'rooms').filter((e) => e.ws === ws.id);
  assert.equal(roomEvents.length, 1);
  assert.equal(roomEvents[0].rooms.length, 5);
  assert.equal(second.state().workspaces[0].status, 'ok');
  // Members, channels and blocks came with it.
  assert.equal(second.store.listMembers(ws.id).length, 2);
  assert.equal(second.store.listChannels(ws.id).length, 5);
});

test('a channel left on another device is evicted with its unsent messages', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc } = await setup(t);
  const channel = await server.seedChannel(olga, ws.id, { name: 'project', members: [bartMe.id] });
  await svc.sync(ws.id);
  const room = svc.store.getRoom(ws.id, channel.id);
  assert.ok(room, 'the new channel arrived');
  svc.store.insertOutbox({
    local: 'AAAAAAAAAAAAAAAAAAAAAA',
    ws: ws.id,
    room: channel.id,
    actor: bartMe.id,
    grantId: room.grantId,
    generation: svc.store.getWs(ws.id).generation,
    text: 'unsent words',
    mentions: [],
    createdAt: Date.now()
  });
  const left = await server.call('DELETE', route(ws.id, `/channels/${channel.id}/members/me`), { token: bart.token });
  assert.equal(left.status, 204);
  await svc.sync(ws.id);
  assert.equal(svc.store.getRoom(ws.id, channel.id), null);
  assert.equal(svc.store.countUnsent(), 0);
  const evicted = ofKind(svc, 'evicted');
  assert.deepEqual(evicted.at(-1), { kind: 'evicted', ws: ws.id, conversation: channel.id, droppedSends: 1 });
  await sleep(20);
  const rooms = ofKind(svc, 'rooms').at(-1);
  assert.ok(rooms.removed.includes(channel.id));
  assert.ok(!rooms.rooms.some((r) => r.id === channel.id));
});

test('a removal in a room nobody opened takes the text and leaves a tombstone', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc } = await setup(t);
  const kept = await server.post(olga, ws.id, ws.general, 'This stays');
  const gone = await server.post(olga, ws.id, ws.general, 'This goes');
  await svc.sync(ws.id);
  const cached = await cacheRoom(svc, ws.id, ws.general);
  assert.equal(cached.hi, cached.head);
  assert.equal(svc.store.eventById(ws.id, gone.messageId).text, 'This goes');
  // A message that was never cached gets a tombstone too, so a later history page can't bring it back.
  const late = await server.post(olga, ws.id, ws.general, 'Never cached');
  await server.redact(olga, ws.id, ws.general, gone.messageId);
  await server.redact(olga, ws.id, ws.general, late.messageId);
  await svc.sync(ws.id);
  const removed = svc.store.eventById(ws.id, gone.messageId);
  assert.equal(removed.text, null);
  assert.equal(removed.mentions, null);
  assert.equal(removed.redacted, 1);
  assert.equal(svc.store.eventById(ws.id, kept.messageId).text, 'This stays');
  assert.ok(svc.store.hasTombstone(ws.id, gone.messageId));
  assert.ok(svc.store.hasTombstone(ws.id, late.messageId));
  const redacted = ofKind(svc, 'redacted');
  assert.deepEqual(redacted.at(-1), { kind: 'redacted', ws: ws.id, conversation: ws.general, ids: [gone.messageId] });
  // The text is out of the file: the WAL is checkpointed into it and secure_delete zeroed the page.
  svc.store.checkpoint();
  assert.ok(!fs.readFileSync(svc.file).includes(Buffer.from('This goes')));
});

test('leaving a channel and joining it again empties its cache', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc } = await setup(t);
  const channel = await server.seedChannel(olga, ws.id, { name: 'project', members: [bartMe.id] });
  await server.post(olga, ws.id, channel.id, 'Before you left');
  await svc.sync(ws.id);
  const before = await cacheRoom(svc, ws.id, channel.id);
  assert.ok(before.lo !== null);
  assert.equal(await server.call('DELETE', route(ws.id, `/channels/${channel.id}/members/me`), { token: bart.token }).then((r) => r.status), 204);
  assert.equal(await server.call('POST', route(ws.id, `/channels/${channel.id}/join`), { token: bart.token }).then((r) => r.status), 200);
  await svc.sync(ws.id);
  const after = svc.store.getRoom(ws.id, channel.id);
  assert.ok(after, 'the room is back');
  assert.notEqual(after.grantId, before.grantId);
  assert.equal(after.lo, null);
  assert.equal(after.hi, null);
  assert.equal(svc.store.eventsFrom(ws.id, channel.id, 0, 100).length, 0);
});

test("another member's cursor gets 410 and a clean pass from the start", async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc } = await setup(t);
  await server.post(olga, ws.id, ws.general, 'Cached before the reset');
  await svc.sync(ws.id);
  await cacheRoom(svc, ws.id, ws.general);
  const theirs = await server.call('GET', route(ws.id, '/changes'), { token: olga.token });
  svc.store.updateWs(ws.id, { cursor: theirs.body.next });
  const calls = watchCalls(svc.account);
  const outcome = await svc.sync(ws.id);
  assert.ok(!outcome.error, `the run got through: ${outcome.error && outcome.error.code}`);
  const feed = calls.filter((c) => c.route.startsWith(route(ws.id, '/changes')));
  assert.ok(feed[0].route.includes('after='), 'the first request carried the foreign cursor');
  assert.ok(!feed[1].route.includes('after='), 'the next started a pass');
  assert.ok(calls.some((c) => c.route === route(ws.id)), 'GET / came between them');
  const row = svc.store.getWs(ws.id);
  assert.equal(row.passing, 0);
  assert.equal(row.state, 'ok');
  assert.notEqual(row.cursor, theirs.body.next);
  assert.equal(svc.debugState().workspaces[0].events, 0);
  const general = svc.store.getRoom(ws.id, ws.general);
  assert.equal(general.lo, null);
  assert.ok(general.head > 0);
});

test('the directory flags load members, channels and blocks again', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, svc } = await setup(t);
  assert.equal(svc.store.listMembers(ws.id).length, 2);
  assert.equal(svc.store.listChannels(ws.id).length, 1);
  assert.equal(svc.store.listBlocks(ws.id).length, 0);
  const carol = await server.seedAccount();
  const carolMe = await server.seedMember(ws, carol, 'Carol');
  const directory = ofKind(svc, 'directory').length;
  await svc.sync(ws.id);
  assert.equal(svc.store.listMembers(ws.id).length, 3);
  assert.ok(svc.store.listMembers(ws.id).some((m) => m.id === carolMe.id && m.name === 'Carol'));
  assert.ok(ofKind(svc, 'directory').length > directory);

  await server.seedChannel(olga, ws.id, { name: 'open-to-all' });
  await svc.sync(ws.id);
  const channels = svc.store.listChannels(ws.id);
  assert.equal(channels.length, 2);
  assert.ok(channels.some((c) => c.name === 'open-to-all' && c.joined === false));

  const blocked = await server.call('POST', route(ws.id, '/blocks'), { token: bart.token, body: { member: carolMe.id } });
  assert.ok([200, 201].includes(blocked.status), blocked.text);
  await svc.sync(ws.id);
  assert.deepEqual(svc.store.listBlocks(ws.id).map((b) => b.member), [carolMe.id]);
  const row = svc.store.getWs(ws.id);
  assert.equal(row.membersStale + row.channelsStale + row.blocksStale, 0);
});

test('a 404 for the workspace after a removal deletes it and lists again', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, dir } = await setup(t);
  await server.post(olga, ws.id, ws.general, 'Soon gone');
  await svc.sync(ws.id);
  await cacheRoom(svc, ws.id, ws.general);
  const removed = await server.call('DELETE', route(ws.id, `/members/${bartMe.id}`), { token: olga.token });
  assert.equal(removed.status, 204, removed.text);
  const calls = watchCalls(svc.account);
  await svc.sync(ws.id);
  assert.equal(svc.store.getWs(ws.id), null);
  assert.deepEqual(svc.store.listRooms(ws.id), []);
  assert.deepEqual(ofKind(svc, 'removed').at(-1), { kind: 'removed', ws: ws.id, reason: 'removed' });
  await until(() => calls.some((c) => c.route === '/v1/workspaces'), 5000, 'the listing after the removal');
  assert.equal(svc.state().selected, null);
  assert.equal(svc.state().workspaces.length, 0);
  assert.ok(!fs.readFileSync(path.join(dir, 'chat.db')).includes(Buffer.from('Soon gone')));
});

test('a 401 after the session was revoked deletes the cache file', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, svc, account, dir } = await setup(t);
  const file = path.join(dir, 'chat.db');
  assert.ok(fs.existsSync(file));
  assert.equal((await server.call('POST', '/v1/logout', { token: bart.token })).status, 204);
  await svc.sync(ws.id);
  await until(() => !account.signedIn, 5000, 'the sign-out');
  assert.equal(account.status().error, 'signed_out');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) assert.equal(fs.existsSync(f), false, `${path.basename(f)} is gone`);
  assert.equal(svc.store, null);
  const state = svc.state();
  assert.equal(state.signedIn, false);
  assert.deepEqual(state.workspaces, []);
});

test('a floor from retention deletes the events below it', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc } = await setup(t);
  for (const text of ['one', 'two', 'three']) await server.post(olga, ws.id, ws.general, text);
  await svc.sync(ws.id);
  const cached = await cacheRoom(svc, ws.id, ws.general);
  const floor = cached.head - 1;
  // The next page says the room's floor rose, as the daily sweep makes it after retention.
  watchCalls(svc.account, async (method, url, real) => {
    if (!url.startsWith(route(ws.id, '/changes'))) return undefined;
    const page = await real();
    const room = page.changes.find((c) => c.conversation === ws.general) || { ...rawRoom(cached), conversation: ws.general };
    room.floor = floor;
    page.changes = [room, ...page.changes.filter((c) => c.conversation !== ws.general)];
    return page;
  });
  await svc.sync(ws.id);
  const after = svc.store.getRoom(ws.id, ws.general);
  assert.equal(after.lo, floor);
  assert.equal(after.hi, cached.hi);
  assert.equal(svc.store.eventsBefore(ws.id, ws.general, floor, 100).length, 0);
  assert.equal(after.floor, floor);
});

test('removedMore drops the room cache as a whole', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc } = await setup(t);
  await server.post(olga, ws.id, ws.general, 'cached');
  await svc.sync(ws.id);
  const cached = await cacheRoom(svc, ws.id, ws.general);
  assert.ok(cached.lo !== null);
  watchCalls(svc.account, async (method, url, real) => {
    if (!url.startsWith(route(ws.id, '/changes'))) return undefined;
    const page = await real();
    const room = page.changes.find((c) => c.conversation === ws.general) || { ...rawRoom(cached), conversation: ws.general };
    room.removedMore = true;
    page.changes = [room, ...page.changes.filter((c) => c.conversation !== ws.general)];
    return page;
  });
  await svc.sync(ws.id);
  const after = svc.store.getRoom(ws.id, ws.general);
  assert.equal(after.lo, null);
  assert.equal(after.hi, null);
  assert.equal(svc.store.eventsFrom(ws.id, ws.general, 0, 100).length, 0);
});

test('409 history_regressed stops the workspace, and Start over brings it back', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc } = await setup(t);
  holdOutbox(svc);
  await server.post(olga, ws.id, ws.general, 'cached');
  await svc.sync(ws.id);
  await cacheRoom(svc, ws.id, ws.general);
  const room = svc.store.getRoom(ws.id, ws.general);
  svc.store.insertOutbox({ local: 'BBBBBBBBBBBBBBBBBBBBBB', ws: ws.id, room: ws.general, actor: bartMe.id, grantId: room.grantId, generation: svc.store.getWs(ws.id).generation, text: 'waits', mentions: [], createdAt: Date.now() });
  let regress = true;
  watchCalls(svc.account, async (method, url) => {
    if (regress && url.startsWith(route(ws.id, '/changes'))) {
      regress = false;
      throw new AccountError('history_regressed', 409, 'This workspace is behind what this device has seen.', { scope: 'workspace' });
    }
    return undefined;
  });
  const outcome = await svc.sync(ws.id);
  assert.deepEqual(outcome, { quarantined: true });
  let row = svc.store.getWs(ws.id);
  assert.equal(row.state, 'quarantined');
  assert.equal(svc.debugState().workspaces[0].events, 0);
  for (const r of svc.store.listRooms(ws.id)) assert.deepEqual([r.unread, r.mentions, r.lo], [0, 0, null]);
  assert.equal(svc.state().workspaces[0].status, 'quarantined');
  // Stopped: a run does nothing, and nothing sends.
  assert.deepEqual(await svc.sync(ws.id), { skipped: true });
  assert.deepEqual(svc.store.nextDue(Date.now() + 1, 10), []);

  const api = chatApi(() => svc);
  const state = await api.chatReload(ws.id);
  // Running again at once; 'loading' is only for a workspace's first pass.
  assert.equal(state.workspaces[0].status, 'ok');
  row = svc.store.getWs(ws.id);
  assert.equal(row.state, 'ok');
  assert.equal(row.passing, 1);
  // The unsent message waits for a lookup of its operation before anything else.
  assert.deepEqual([svc.store.getOutbox('BBBBBBBBBBBBBBBBBBBBBB').state, svc.store.getOutbox('BBBBBBBBBBBBBBBBBBBBBB').reason], ['queued', 'lookup']);
  await until(() => svc.store.getWs(ws.id).passing === 0 && !svc.runners.get(ws.id).running, 10000, 'the pass after Start over');
  assert.equal(svc.state().workspaces[0].status, 'ok');
  assert.ok(svc.store.getRoom(ws.id, ws.general).head > 0);
});

// A Start over, or a restore that GET / outside the run finds (the listing, a 4003, the outbox), resets the feed
// while a page of the old position is on its way. That page is dropped: applied, it would set a cursor of the old feed
// under passing = 1, and the next page would install a pass that lacks every room that hadn't changed.
for (const [what, reset] of [
  ['Start over', (svc, ws) => chatApi(() => svc).chatReload(ws)],
  [
    'a restore',
    async (svc, ws) => {
      svc.store.updateWs(ws, { generation: 'OldGenerationXXXXXXXXX' });
      await svc.details(ws);
    }
  ]
]) {
  test(`${what} while a page is on its way drops that page and keeps every room`, async (t) => {
    if (skipWithoutServer(t)) return;
    const { olga, ws, bartMe, svc } = await setup(t);
    holdOutbox(svc);
    await server.seedChannel(olga, ws.id, { name: 'second', members: [bartMe.id] });
    await svc.sync(ws.id);
    const before = svc.store.listRooms(ws.id).map((r) => r.id);
    assert.equal(before.length, 2);
    const room = svc.store.getRoom(ws.id, ws.general);
    const local = 'GGGGGGGGGGGGGGGGGGGGGG';
    svc.store.insertOutbox({ local, ws: ws.id, room: ws.general, actor: bartMe.id, grantId: room.grantId, generation: svc.store.getWs(ws.id).generation, text: 'waits', mentions: [], createdAt: Date.now() });
    await server.post(olga, ws.id, ws.general, 'On its way');
    const held = holdNextPage(svc, ws.id);
    const running = svc.sync(ws.id);
    await until(() => held.waiting, 5000, 'the held page');
    await reset(svc, ws.id);
    assert.equal(svc.store.getWs(ws.id).passing, 1);
    assert.equal(svc.store.getWs(ws.id).cursor, null);
    held.release();
    // The run that held the page went on with the pass.
    const outcome = await running;
    assert.equal(outcome.pass, true, JSON.stringify(outcome));
    await until(() => svc.store.getWs(ws.id).passing === 0 && !svc.runners.get(ws.id).running, 10000, 'the runs after the reset');
    assert.deepEqual(svc.store.listRooms(ws.id).map((r) => r.id), before);
    assert.deepEqual(ofKind(svc, 'evicted'), []);
    assert.ok(svc.store.getWs(ws.id).cursor);
    assert.equal(svc.store.listPassRooms(ws.id).length, 0);
    // The unsent message is still there, waiting for its lookup.
    assert.equal(svc.store.countUnsent(), 1);
    if (what === 'Start over') assert.equal(svc.store.getOutbox(local).reason, 'lookup');
    // The page that was dropped is in the pass: the room has the post.
    assert.equal(svc.store.getRoom(ws.id, ws.general).head, room.head + 1);
  });
}

// A pass from the start lists no removals (the server answers removed: [] without a cursor), so a message removed on
// the server since this device's last page would keep its text in the cache. Start over, a restore and a new key drop
// the cached bodies, as a 410 does (contract 3.6); the rooms and the unsent messages stay.
for (const [what, startPass] of [
  ['Start over', (svc, ws) => chatApi(() => svc).chatReload(ws)],
  [
    'a restore',
    async (svc, ws) => {
      svc.store.updateWs(ws, { generation: 'OldGenerationXXXXXXXXX' });
      await svc.details(ws);
    }
  ],
  [
    'a new key',
    async (svc, ws) => {
      svc.store.updateWs(ws, { keyId: 'an-old-key' });
      await svc.details(ws);
    }
  ]
]) {
  test(`${what} drops cached bodies, so text removed meanwhile leaves the cache`, async (t) => {
    if (skipWithoutServer(t)) return;
    const { olga, ws, bartMe, svc } = await setup(t);
    holdOutbox(svc);
    const kept = await server.post(olga, ws.id, ws.general, 'Still here');
    const gone = await server.post(olga, ws.id, ws.general, 'Removed while away');
    await svc.sync(ws.id);
    await cacheRoom(svc, ws.id, ws.general);
    assert.equal(svc.store.eventById(ws.id, gone.messageId).text, 'Removed while away');
    const room = svc.store.getRoom(ws.id, ws.general);
    const local = 'HHHHHHHHHHHHHHHHHHHHHH';
    svc.store.insertOutbox({ local, ws: ws.id, room: ws.general, actor: bartMe.id, grantId: room.grantId, generation: svc.store.getWs(ws.id).generation, text: 'waits', mentions: [], createdAt: Date.now() });
    // Removed on the server; this device doesn't run before the pass from the start.
    await server.redact(olga, ws.id, ws.general, gone.messageId);
    await startPass(svc, ws.id);
    await until(() => svc.store.getWs(ws.id).passing === 0 && !svc.runners.get(ws.id).running, 10000, `the pass after ${what}`);
    assert.equal(svc.store.eventById(ws.id, gone.messageId), null);
    assert.equal(svc.store.eventById(ws.id, kept.messageId), null, 'every cached body went, as for a 410');
    const after = svc.store.getRoom(ws.id, ws.general);
    assert.deepEqual([after.lo, after.hi], [null, null]);
    assert.equal(after.head, room.head + 1, 'the room is still there, with the removal counted in its head');
    assert.equal(svc.store.countUnsent(), 1, 'the unsent message stays');
    svc.store.checkpoint();
    assert.ok(!fs.readFileSync(svc.file).includes(Buffer.from('Removed while away')));
  });
}

test('an open room shows again after Start over and loads its messages from the server, without the removed text', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc } = await setup(t);
  const api = chatApi(() => svc);
  const kept = await server.post(olga, ws.id, ws.general, 'Still here');
  const gone = await server.post(olga, ws.id, ws.general, 'Removed while away');
  await svc.sync(ws.id);
  const view = await api.chatOpen(ws.id, ws.general);
  await until(() => svc.store.getRoom(ws.id, ws.general).hi === svc.store.getRoom(ws.id, ws.general).head, 5000, 'the open room cached');
  assert.ok(view.events.some((e) => e.id === gone.messageId) || svc.store.eventById(ws.id, gone.messageId));
  await server.redact(olga, ws.id, ws.general, gone.messageId);
  const before = svc.events.length;
  await api.chatReload(ws.id);
  // The renderer drops what it showed at once.
  const replaced = svc.events.slice(before).find((e) => e.kind === 'events' && e.conversation === ws.general && e.replace);
  assert.ok(replaced, 'the open room was shown again');
  assert.deepEqual(replaced.events, []);
  // Then the room loads again from the server, which sends the removed message without its text.
  await until(() => {
    const r = svc.store.getRoom(ws.id, ws.general);
    return svc.store.getWs(ws.id).passing === 0 && r.hi !== null && r.hi === r.head && svc.store.eventById(ws.id, kept.messageId);
  }, 10000, 'the open room loaded again');
  assert.equal(svc.store.eventById(ws.id, kept.messageId).text, 'Still here');
  const removed = svc.store.eventById(ws.id, gone.messageId);
  assert.ok(!removed || removed.text === null, 'the removed message has no text');
  await api.chatClose();
  svc.store.checkpoint();
  assert.ok(!fs.readFileSync(svc.file).includes(Buffer.from('Removed while away')));
});

test('a restore or a new key that GET / finds outside a run starts the pass at once', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc } = await setup(t);
  const calls = watchCalls(svc.account);
  const feed = () => calls.filter((c) => c.route.startsWith(route(ws.id, '/changes'))).length;
  for (const [field, value] of [
    ['generation', 'OldGenerationXXXXXXXXX'],
    ['keyId', 'an-old-key']
  ]) {
    calls.length = 0;
    svc.store.updateWs(ws.id, { [field]: value });
    await svc.details(ws.id);
    assert.equal(svc.store.getWs(ws.id).passing, 1, field);
    assert.equal(svc.store.getWs(ws.id).cursor, null, field);
    // The window isn't focused, so the catch-up timer waits five minutes: this run comes from details().
    await until(() => svc.store.getWs(ws.id).passing === 0 && !svc.runners.get(ws.id).running, 3000, `the pass after a new ${field}`);
    assert.ok(feed() > 0, field);
    assert.ok(svc.store.getWs(ws.id).cursor, field);
  }
  // A run that asks GET / itself goes on with the pass, and no second run follows it.
  svc.store.updateWs(ws.id, { generation: 'OldGenerationXXXXXXXXX' });
  svc.runner(ws.id).detailsDue = true;
  calls.length = 0;
  const outcome = await svc.sync(ws.id);
  assert.equal(outcome.pass, true, JSON.stringify(outcome));
  const pages = feed();
  await sleep(800);
  assert.equal(feed(), pages, 'no run after the one that did the pass');
  assert.equal(svc.store.getWs(ws.id).passing, 0);
});

test('a new generation from GET / marks unsent messages of the old one for a lookup', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc } = await setup(t);
  holdOutbox(svc);
  await server.post(olga, ws.id, ws.general, 'cached');
  await svc.sync(ws.id);
  await cacheRoom(svc, ws.id, ws.general);
  const real = svc.store.getWs(ws.id).generation;
  const old = 'OldGenerationXXXXXXXXX';
  const room = svc.store.getRoom(ws.id, ws.general);
  const row = (local, generation, state, reason = null) =>
    svc.store.insertOutbox({ local, ws: ws.id, room: ws.general, actor: bartMe.id, grantId: room.grantId, generation, text: local, mentions: [], state, reason, createdAt: Date.now() });
  row('CCCCCCCCCCCCCCCCCCCCCC', old, 'sending');
  row('DDDDDDDDDDDDDDDDDDDDDD', old, 'held', 'stale_grant');
  row('EEEEEEEEEEEEEEEEEEEEEE', old, 'failed', 'quota');
  row('FFFFFFFFFFFFFFFFFFFFFF', real, 'queued');
  // As if the workspace was restored on the server since this device last asked.
  svc.store.updateWs(ws.id, { generation: old });
  await svc.details(ws.id);
  const out = (local) => {
    const o = svc.store.getOutbox(local);
    return [o.state, o.reason];
  };
  assert.deepEqual(out('CCCCCCCCCCCCCCCCCCCCCC'), ['queued', 'lookup']);
  assert.deepEqual(out('DDDDDDDDDDDDDDDDDDDDDD'), ['queued', 'lookup']);
  assert.deepEqual(out('EEEEEEEEEEEEEEEEEEEEEE'), ['failed', 'quota']);
  assert.deepEqual(out('FFFFFFFFFFFFFFFFFFFFFF'), ['queued', null]);
  const ws2 = svc.store.getWs(ws.id);
  assert.equal(ws2.generation, real);
  assert.equal(ws2.passing, 1);
  assert.equal(ws2.cursor, null);
  assert.equal(svc.debugState().workspaces[0].events, 0);
  // The clock came with it.
  assert.equal(typeof svc.clock(), 'number');
  await svc.sync(ws.id);
  assert.equal(svc.store.getWs(ws.id).passing, 0);
});

test('a page with one bad field changes nothing', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc } = await setup(t);
  await server.post(olga, ws.id, ws.general, 'changes the room');
  const before = { ws: svc.store.getWs(ws.id), rooms: svc.store.listRooms(ws.id) };
  let bad = true;
  watchCalls(svc.account, async (method, url, real) => {
    if (!bad || !url.startsWith(route(ws.id, '/changes'))) return undefined;
    bad = false;
    const page = await real();
    assert.ok(page.changes.length > 0);
    page.changes[0].head = -1;
    return page;
  });
  const outcome = await svc.sync(ws.id);
  assert.equal(outcome.error.code, 'server');
  assert.equal(outcome.error.where, 'changes.changes[0].head');
  assert.deepEqual(svc.store.getWs(ws.id), before.ws);
  assert.deepEqual(svc.store.listRooms(ws.id), before.rooms);
  assert.equal(svc.state().workspaces[0].error, 'server');
  // The next run gets the real page.
  await svc.sync(ws.id);
  assert.ok(svc.store.getRoom(ws.id, ws.general).head > before.rooms[0].head);
  assert.equal(svc.state().workspaces[0].error, null);
});

// A cached room row as the feed would send it, for a synthetic page that has to list a room the real page didn't.
function rawRoom(row) {
  return {
    conversation: row.id,
    kind: row.kind,
    name: row.name,
    visibility: row.visibility,
    archived: Boolean(row.archived),
    grant: row.grantId,
    role: row.role,
    members: row.members,
    head: row.head,
    floor: row.floor,
    lastAt: row.lastAt,
    read: row.read,
    unread: row.unread,
    mentions: row.mentions,
    removed: [],
    removedMore: false
  };
}
