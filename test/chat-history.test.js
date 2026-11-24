'use strict';

// The history module (src/main/workspaces/history.js) through the chat* IPC table, against the real account server
// (test/fixtures/real-server.js), as contract 8.4 lists for chat-history: opening an uncached room, a slightly behind
// one (forward pages) and a far behind one (newest page); opening at an old seq backfills; older pages to the floor;
// a thread whose root is older than the cache; a history page started under an old grant is dropped; a tombstoned ID
// stays removed. A floor from retention can't be made on demand, so those cases change one field of a real answer.
//
// The server lets one account send 30 messages at once and then 3 a second, so most tests page with smaller numbers
// (SMALL, through the service's timing, the same code paths) instead of posting hundreds of messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRealServer, realServerAvailable, skipWithoutServer, uuidv7 } = require('./fixtures/real-server');
const { chatService, settled, watchCalls, twoPeople, until, sleep } = require('./fixtures/chat-app');
const { chatApi } = require('../src/main/workspaces/ipc');
const { AccountError } = require('../src/main/account/client');

let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') server = await startRealServer();
});
test.after(() => server?.close());

const route = (ws, rest = '') => `/v1/workspaces/${ws}${rest}`;

// The fields of contract 4.6, so a view can't gain or lose one unnoticed.
const ROOM_VIEW = ['at', 'complete', 'draft', 'events', 'hasOlder', 'hi', 'lo', 'pending', 'readAtOpen', 'room'];
const THREAD_VIEW = ['complete', 'draft', 'expired', 'pending', 'replies', 'root'];
// agents: the agents in a channel, which members leaves out (server/WORKSPACES.md "Agents").
const ROOM = [
  'agents', 'archived', 'attention', 'closedReason', 'floor', 'hasCache', 'head', 'id', 'kind', 'lastAt', 'members', 'mentions', 'muted', 'name',
  'participants', 'read', 'readMark', 'readingPaused', 'role', 'startedBy', 'unread', 'visibility'
];
const EVENT = ['actor', 'at', 'attachments', 'data', 'id', 'kind', 'mentions', 'previews', 'reactions', 'redacted', 'root', 'seq', 'text'];
const EVENTS_PUSH = ['conversation', 'events', 'floor', 'head', 'hi', 'kind', 'lo', 'replace', 'ws'];
const keys = (o) => Object.keys(o).sort();
// Pages of 5 for the newest and older ones, 10 forward and backfill, and a room 30 behind loads the newest page.
const SMALL = { eventsNewest: 5, eventsPage: 10, forwardGapMax: 30 };

// Two people in Olga's workspace, Bart's service after its first pass, and the IPC table over it.
async function setup(t, options = {}) {
  const made = await twoPeople(server, options);
  t.after(() => {
    made.svc.close();
    made.account.close();
  });
  await settled(made.svc, made.ws.id);
  made.api = chatApi(() => made.svc);
  return made;
}

// n messages from person, one feed pass for the grant: much faster than server.post for each. A 429 waits its
// Retry-After and sends the same body again. root: replies.
async function postMany(person, wsId, conversation, n, { prefix = 'message', root } = {}) {
  const a = await server.access(person, wsId, conversation);
  const out = [];
  for (let i = 0; i < n; i++) {
    const body = { operationId: uuidv7(a.time + i), grant: a.grant, generation: a.generation, text: `${prefix} ${i + 1}` };
    if (root) body.root = root;
    for (;;) {
      const res = await server.call('POST', route(wsId, `/conversations/${conversation}/messages`), { token: person.token, body });
      if (res.status === 429) {
        await sleep(Number(res.headers.get('retry-after') || 1) * 1000);
        continue;
      }
      if (res.status !== 201) throw new Error(`post: ${res.status} ${res.text}`);
      out.push(res.body);
      break;
    }
  }
  return out;
}

const pushes = (svc, room) => svc.events.filter((e) => e.kind === 'events' && e.conversation === room);
const eventCalls = (calls, room) => calls.filter((c) => c.route.includes(`/conversations/${room}/events`)).map((c) => c.route.split('?')[1]);

// Until no catch-up of the room is in flight and the cache reaches head.
async function caughtUp(svc, ws, room) {
  await until(() => {
    const r = svc.store.getRoom(ws, room);
    return r && r.hi !== null && r.hi >= r.head && !svc.history.loads.size;
  }, 15000, 'the room to reach head');
  await sleep(20);
  return svc.store.getRoom(ws, room);
}

// Holds the first answer that match(route) picks, which the server already gave, until held.release().
function holdNext(account, match) {
  const held = { waiting: false };
  const gate = new Promise((resolve) => (held.release = resolve));
  let armed = true;
  held.calls = watchCalls(account, async (method, url, real) => {
    if (!armed || !match(url, method)) return undefined;
    armed = false;
    const answer = await real();
    held.waiting = true;
    await gate;
    return answer;
  });
  return held;
}

const cachedSeqs = (svc, ws, room) => svc.store.all('SELECT seq FROM event WHERE ws = ? AND room = ? ORDER BY seq', ws, room).map((r) => r.seq);

test('opening an uncached room answers at once, then loads the newest page', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t);
  await postMany(olga, ws.id, ws.general, 3);
  await svc.sync(ws.id);
  const before = svc.store.getRoom(ws.id, ws.general);
  assert.equal(before.hi, null);
  const calls = watchCalls(account);

  const view = await api.chatOpen(ws.id, ws.general);
  assert.deepEqual(keys(view), ROOM_VIEW);
  assert.deepEqual(keys(view.room), ROOM);
  assert.deepEqual(view.events, []);
  assert.equal(view.room.hasCache, false);
  assert.equal(view.readAtOpen, before.readLocal);
  assert.equal(view.at, null);
  assert.equal(view.complete, true);
  assert.equal(view.hasOlder, false);
  assert.deepEqual(view.pending, []);
  assert.equal(view.draft, null);
  assert.deepEqual(svc.active, { ws: ws.id, room: ws.general });

  const room = await caughtUp(svc, ws.id, ws.general);
  assert.deepEqual(eventCalls(calls, ws.general), [`before=${before.head + 1}&limit=50`]);
  assert.equal(room.lo, 1);
  assert.equal(room.hi, room.head);
  const push = pushes(svc, ws.general).at(-1);
  assert.deepEqual(keys(push), EVENTS_PUSH);
  assert.equal(push.replace, true);
  assert.equal(push.lo, 1);
  assert.equal(push.hi, room.head);
  assert.equal(push.events.length, room.head);
  assert.deepEqual(keys(push.events.at(-1)), EVENT);
  assert.equal(push.events.at(-1).text, 'message 3');
  // The feed asks for the open room's inline events after the cached range.
  assert.deepEqual(svc.history.activeQuery(ws.id), { active: ws.general, roomAfter: room.hi });

  // Opened again, it answers from the cache alone.
  const again = await api.chatOpen(ws.id, ws.general);
  assert.equal(again.events.length, room.head);
  assert.equal(again.lo, 1);
  assert.equal(again.hi, room.head);
  assert.equal(again.hasOlder, false);
  assert.equal(again.room.hasCache, true);
  await sleep(50);
  assert.equal(eventCalls(calls, ws.general).length, 1, 'a room at head needs no request');

  assert.equal(await api.chatClose(), true);
  assert.equal(svc.active, null);
  assert.equal(svc.history.activeQuery(ws.id), null);
});

test('a room a little behind pages forward to head; one far behind loads the newest page', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t, { timing: SMALL });
  await postMany(olga, ws.id, ws.general, 2);
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general);
  let room = await caughtUp(svc, ws.id, ws.general);
  await api.chatClose();

  // 12 behind: two forward pages of 10, appended.
  await postMany(olga, ws.id, ws.general, 12, { prefix: 'near' });
  await svc.sync(ws.id);
  const { lo, hi } = room;
  const calls = watchCalls(account);
  const near = await api.chatOpen(ws.id, ws.general);
  assert.equal(near.hi, hi, 'the answer comes from the cache as it was');
  room = await caughtUp(svc, ws.id, ws.general);
  assert.equal(room.hi, hi + 12);
  assert.deepEqual(eventCalls(calls, ws.general), [`after=${hi}&limit=10`, `after=${hi + 10}&limit=10`]);
  const forward = pushes(svc, ws.general).slice(-2);
  assert.deepEqual(forward.map((p) => p.replace), [false, false]);
  assert.deepEqual(forward.map((p) => p.events.length), [10, 2]);
  assert.deepEqual(forward[1].events.map((e) => e.text), ['near 11', 'near 12']);
  assert.equal(room.lo, lo, 'the range grew without a gap');
  assert.equal(cachedSeqs(svc, ws.id, ws.general).length, room.hi - room.lo + 1);
  await api.chatClose();

  // More than FORWARD_GAP_MAX (30 here) behind: the cache goes, and the newest page replaces it.
  await postMany(olga, ws.id, ws.general, 31, { prefix: 'far' });
  await svc.sync(ws.id);
  const head = svc.store.getRoom(ws.id, ws.general).head;
  const farCalls = watchCalls(account);
  await api.chatOpen(ws.id, ws.general);
  room = await caughtUp(svc, ws.id, ws.general);
  assert.deepEqual(eventCalls(farCalls, ws.general), [`before=${head + 1}&limit=5`]);
  assert.equal(room.lo, head - 4);
  assert.equal(room.hi, head);
  assert.equal(cachedSeqs(svc, ws.id, ws.general).length, 5);
  const last = pushes(svc, ws.general).at(-1);
  assert.equal(last.replace, true);
  assert.deepEqual(
    last.events.map((e) => e.text),
    ['far 27', 'far 28', 'far 29', 'far 30', 'far 31']
  );
});

test('opening at an old seq backfills to it, and says so when the pages run out', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t, { timing: SMALL });
  await postMany(olga, ws.id, ws.general, 30);
  await svc.sync(ws.id);
  const head = svc.store.getRoom(ws.id, ws.general).head;
  const calls = watchCalls(account);
  const at = 5;

  const view = await api.chatOpen(ws.id, ws.general, { at });
  assert.deepEqual(keys(view), ROOM_VIEW);
  assert.equal(view.complete, true);
  assert.equal(view.at, at);
  assert.equal(view.hi, head);
  assert.ok(view.events.some((e) => e.seq === at), 'the event it points at is in the answer');
  assert.equal(view.events[0].seq, 1);
  assert.equal(view.events.at(-1).seq, head, 'from there through head, without a gap');
  assert.equal(view.events.length, head);
  const lo = head - 4;
  const expected = [`before=${head + 1}&limit=5`];
  for (let b = lo; b > at; b -= 10) expected.push(`before=${b}&limit=10`);
  assert.deepEqual(eventCalls(calls, ws.general), expected);
  assert.ok(svc.store.getRoom(ws.id, ws.general).lo <= at, 'the backfill joined the cache');
  // The answer held everything: no events push raced it.
  assert.equal(pushes(svc, ws.general).length, 0);
  await api.chatClose();

  // One page of backfill isn't enough: the room opens at its oldest loaded event.
  svc.store.dropRoomCache(ws.id, ws.general);
  svc.timing.backfillPages = 1;
  const short = await api.chatOpen(ws.id, ws.general, { at });
  assert.equal(short.complete, false);
  assert.equal(short.events[0].seq, lo - 10);
  assert.equal(short.at, lo - 10);
  assert.equal(short.hasOlder, true);
  assert.equal(short.events.at(-1).seq, head);
  svc.timing.backfillPages = 10;
});

test('opening at a seq while offline opens at it from the cache, or at the newest cached event', async (t) => {
  if (skipWithoutServer(t)) return;
  // A window of 5 events before the one opened at, so a cache of 30 is large next to it.
  const { olga, ws, svc, api, account } = await setup(t, { timing: { ...SMALL, around: 5 } });
  await postMany(olga, ws.id, ws.general, 30);
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general, { at: 1 });
  await api.chatClose();
  const { lo, hi } = svc.store.getRoom(ws.id, ws.general);
  assert.equal(lo, 1);
  // Three more arrive through the feed, so the room is behind head and opening at a seq has to catch up first.
  await postMany(olga, ws.id, ws.general, 3, { prefix: 'later' });
  await svc.sync(ws.id);
  const head = svc.store.getRoom(ws.id, ws.general).head;
  assert.equal(head, hi + 3);
  assert.equal(svc.store.getRoom(ws.id, ws.general).hi, hi);
  const cached = cachedSeqs(svc, ws.id, ws.general).length;
  assert.equal(cached, hi);

  // The server can't be reached for history.
  const calls = watchCalls(account, (method, url) => {
    if (url.includes(`/conversations/${ws.general}/events`)) throw new AccountError('network', 0, 'The server could not be reached.');
    return undefined;
  });

  // A cached message: the view is the window around it, through hi.
  const at = hi - 10;
  const view = await api.chatOpen(ws.id, ws.general, { at });
  assert.ok(eventCalls(calls, ws.general).length > 0, 'the catch-up was tried');
  assert.equal(view.complete, true);
  assert.equal(view.at, at);
  assert.equal(view.hi, hi);
  assert.ok(view.events.some((e) => e.seq === at), 'the event it points at is in the answer');
  assert.equal(view.events[0].seq, at - 5);
  assert.equal(view.lo, at - 5);
  assert.equal(view.events.at(-1).seq, hi);
  assert.equal(view.events.length, hi - at + 6);
  assert.ok(view.events.length < cached, 'not the whole cache');
  assert.equal(view.hasOlder, true);
  await api.chatClose();

  // Newer than anything cached: the room opens at the newest cached event and says it didn't get there.
  const newer = await api.chatOpen(ws.id, ws.general, { at: head });
  assert.equal(newer.complete, false);
  assert.equal(newer.at, hi);
  assert.equal(newer.hi, hi);
  assert.equal(newer.events[0].seq, hi - 5);
  assert.equal(newer.events.at(-1).seq, hi);
  assert.equal(newer.events.length, 6);
  await api.chatClose();
  assert.equal(svc.store.getRoom(ws.id, ws.general).lo, lo, 'the cache stayed as it was');
});

test('opening offline at a seq older than the cache opens at the newest cached event, in a window of 51', async (t) => {
  if (skipWithoutServer(t)) return;
  // The default window of 50 before the event opened at, and a cache of over 70 from an online open at 15.
  const { olga, ws, svc, api, account } = await setup(t, { timing: SMALL });
  await postMany(olga, ws.id, ws.general, 80);
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general, { at: 15 });
  await api.chatClose();
  const { lo, hi, head } = svc.store.getRoom(ws.id, ws.general);
  assert.equal(hi, head);
  assert.ok(lo > 3 && lo <= 15, `lo ${lo}`);
  const cached = cachedSeqs(svc, ws.id, ws.general).length;
  assert.equal(cached, hi - lo + 1);
  assert.ok(cached > 51);

  const calls = watchCalls(account, (method, url) => {
    if (url.includes(`/conversations/${ws.general}/events`)) throw new AccountError('network', 0, 'The server could not be reached.');
    return undefined;
  });

  // At head already, so only the backfill is tried, and its first page fails: no pages ran out, so the room opens at
  // the newest cached event, not the oldest.
  const at = lo - 3;
  const view = await api.chatOpen(ws.id, ws.general, { at });
  assert.deepEqual(eventCalls(calls, ws.general), [`before=${lo}&limit=10`]);
  assert.equal(view.complete, false);
  assert.equal(view.at, hi);
  assert.equal(view.hi, hi);
  assert.equal(view.events.length, 51);
  assert.equal(view.events[0].seq, hi - 50);
  assert.equal(view.lo, hi - 50);
  assert.equal(view.events.at(-1).seq, hi);
  assert.equal(view.hasOlder, true);
  await api.chatClose();

  // Behind head as well: the catch-up fails first, and the room opens at the newest cached event the same way.
  await postMany(olga, ws.id, ws.general, 2, { prefix: 'later' });
  await svc.sync(ws.id);
  assert.equal(svc.store.getRoom(ws.id, ws.general).head, hi + 2);
  const behind = await api.chatOpen(ws.id, ws.general, { at });
  assert.equal(behind.complete, false);
  assert.equal(behind.at, hi);
  assert.equal(behind.events.length, 51);
  assert.equal(behind.events.at(-1).seq, hi);
  await api.chatClose();
  assert.equal(svc.store.getRoom(ws.id, ws.general).lo, lo, 'the cache stayed as it was');
});

test('older pages come from the cache, then the server, down to the floor', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t, { timing: SMALL });
  await postMany(olga, ws.id, ws.general, 22);
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general);
  let room = await caughtUp(svc, ws.id, ws.general);
  const head = room.head;
  assert.equal(room.lo, head - 4);

  const calls = watchCalls(account);
  let before = room.lo;
  let pages = 0;
  let last;
  do {
    last = await api.chatOlder(ws.id, ws.general, before);
    assert.deepEqual(keys(last), ['events', 'hasOlder', 'lo']);
    assert.equal(last.events.at(-1).seq, before - 1, 'each page ends right below the one before');
    assert.equal(last.lo, last.events[0].seq);
    assert.equal(calls.at(-1).route.split('?')[1], `before=${before}&limit=5`);
    before = last.lo;
    pages += 1;
  } while (last.hasOlder && pages < 20);
  assert.equal(last.hasOlder, false);
  assert.equal(last.lo, 1, 'the floor of a new channel is its first event');
  assert.equal(eventCalls(calls, ws.general).length, pages);
  room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.lo, 1, 'the pages were prepended to the cache');
  assert.equal(room.hi, head);
  assert.equal(cachedSeqs(svc, ws.id, ws.general).length, head);

  // The renderer scrolled away and back: what the cache has comes without a request.
  const cached = await api.chatOlder(ws.id, ws.general, 12);
  assert.deepEqual(
    cached.events.map((e) => e.seq),
    [7, 8, 9, 10, 11]
  );
  assert.equal(cached.lo, 7);
  assert.equal(cached.hasOlder, true);
  assert.equal(eventCalls(calls, ws.general).length, pages);

  // A floor from retention (synthetic: the real answer with floor raised) stops the history and trims the cache.
  svc.store.dropRoomCache(ws.id, ws.general);
  await api.chatClose();
  await api.chatOpen(ws.id, ws.general);
  room = await caughtUp(svc, ws.id, ws.general);
  const floor = room.lo - 3;
  watchCalls(account, async (method, url, real) => {
    if (!url.includes(`/conversations/${ws.general}/events?before=${room.lo}&`)) return undefined;
    return { ...(await real()), floor };
  });
  const aged = await api.chatOlder(ws.id, ws.general, room.lo);
  assert.equal(aged.hasOlder, false);
  assert.equal(aged.events[0].seq, floor);
  assert.equal(aged.events.length, 3);
  room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.floor, floor);
  assert.equal(room.lo, floor);
  assert.equal(Math.min(...cachedSeqs(svc, ws.id, ws.general)), floor);
  assert.deepEqual(await api.chatOlder(ws.id, ws.general, floor), { events: [], lo: floor, hasOlder: false });
});

test('a thread whose root is older than the cache pages back to it', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api } = await setup(t, { timing: SMALL });
  const [rootPost] = await postMany(olga, ws.id, ws.general, 1, { prefix: 'the root' });
  await postMany(olga, ws.id, ws.general, 25, { prefix: 'chatter' });
  await postMany(olga, ws.id, ws.general, 3, { prefix: 'reply', root: rootPost.messageId });
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general);
  const room = await caughtUp(svc, ws.id, ws.general);
  assert.ok(room.lo > rootPost.seq, 'the root is older than the cache');

  const thread = await api.chatThread(ws.id, ws.general, rootPost.messageId);
  assert.deepEqual(keys(thread), THREAD_VIEW);
  assert.equal(thread.complete, true);
  assert.equal(thread.expired, false);
  assert.equal(thread.root.id, rootPost.messageId);
  assert.equal(thread.root.text, 'the root 1');
  assert.deepEqual(keys(thread.root), EVENT);
  assert.deepEqual(
    thread.replies.map((r) => r.text),
    ['reply 1', 'reply 2', 'reply 3']
  );
  assert.ok(thread.replies.every((r) => r.root === rootPost.messageId));
  assert.deepEqual(thread.pending, []);
  assert.equal(thread.draft, null);
  assert.ok(svc.store.getRoom(ws.id, ws.general).lo <= rootPost.seq);

  // One page of backfill per call here (ten in the app): each call pages further, until one reaches the root.
  svc.store.dropRoomCache(ws.id, ws.general);
  await api.chatClose();
  await api.chatOpen(ws.id, ws.general);
  await caughtUp(svc, ws.id, ws.general);
  svc.timing.backfillPages = 1;
  const first = await api.chatThread(ws.id, ws.general, rootPost.messageId);
  assert.equal(first.complete, false);
  assert.equal(first.expired, false);
  assert.equal(first.root, null);
  assert.equal(first.replies.length, 3, 'the replies are newer than the root, so they are cached');
  let calls = 1;
  let later = first;
  while (!later.complete && calls < 6) {
    later = await api.chatThread(ws.id, ws.general, rootPost.messageId);
    calls += 1;
  }
  assert.equal(later.complete, true);
  assert.equal(later.root.id, rootPost.messageId);
  assert.ok(calls >= 3, `it took ${calls} calls`);

  // A root below the floor (synthetic, as retention would make it): expired.
  svc.timing.backfillPages = 10;
  svc.store.dropRoomCache(ws.id, ws.general);
  await api.chatClose();
  await api.chatOpen(ws.id, ws.general);
  await caughtUp(svc, ws.id, ws.general);
  watchCalls(svc.account, async (method, url, real) => {
    if (!url.includes(`/conversations/${ws.general}/events?before=`)) return undefined;
    return { ...(await real()), floor: rootPost.seq + 1 };
  });
  const aged = await api.chatThread(ws.id, ws.general, rootPost.messageId);
  assert.equal(aged.root, null);
  assert.equal(aged.complete, false);
  assert.equal(aged.expired, true);
  assert.equal(aged.replies.length, 3);
});

test('a history page started under an old grant is dropped', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc, api, account } = await setup(t, { timing: SMALL });
  const channel = await server.seedChannel(olga, ws.id, { name: 'project', members: [bartMe.id] });
  await postMany(olga, ws.id, channel.id, 12);
  await svc.sync(ws.id);
  const old = svc.store.getRoom(ws.id, channel.id);
  assert.equal(old.hi, null);

  // Every write of events into the room, as [first, last].
  const writes = [];
  const write = svc.store.writeEvents.bind(svc.store);
  svc.store.writeEvents = (w, room, events) => {
    if (room === channel.id && events.length) writes.push([events[0].seq, events.at(-1).seq]);
    return write(w, room, events);
  };

  // The newest page under the old grant is on its way while Bart leaves and joins again on another device.
  const held = holdNext(account, (url) => url.includes(`/conversations/${channel.id}/events?before=`));
  await api.chatOpen(ws.id, channel.id);
  await until(() => held.waiting, 10000, 'the held page');
  await api.chatClose();
  assert.equal((await server.call('DELETE', route(ws.id, `/channels/${channel.id}/members/me`), { token: bart.token })).status, 204);
  assert.equal((await server.call('POST', route(ws.id, `/channels/${channel.id}/join`), { token: bart.token })).status, 200);
  await svc.sync(ws.id);
  const now = svc.store.getRoom(ws.id, channel.id);
  assert.notEqual(now.grantId, old.grantId, 'the feed brought the new grant');
  assert.equal(now.head, old.head + 2, 'the leave and the join are events too');
  held.release();

  const room = await caughtUp(svc, ws.id, channel.id);
  // The held page (ending at the old head) was never written; the page asked again under the new grant was.
  assert.ok(!writes.some(([, last]) => last === old.head), `a page under the old grant was written: ${JSON.stringify(writes)}`);
  assert.deepEqual(writes, [[now.head - 4, now.head]]);
  assert.deepEqual(eventCalls(held.calls, channel.id), [`before=${old.head + 1}&limit=5`, `before=${now.head + 1}&limit=5`]);
  assert.equal(room.lo, now.head - 4);
  assert.equal(room.hi, now.head);
});

test('a page with a message removed while it was on its way keeps it removed', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t);
  const [secret] = await postMany(olga, ws.id, ws.general, 1, { prefix: 'secret plan' });
  await postMany(olga, ws.id, ws.general, 2, { prefix: 'other' });
  await svc.sync(ws.id);

  const held = holdNext(account, (url) => url.includes(`/conversations/${ws.general}/events?before=`));
  await api.chatOpen(ws.id, ws.general);
  await until(() => held.waiting, 10000, 'the held page');
  // The page has the message with its text. Olga removes it, and the feed tombstones it.
  await api.chatClose();
  await server.redact(olga, ws.id, ws.general, secret.messageId);
  await svc.sync(ws.id);
  assert.ok(svc.store.hasTombstone(ws.id, secret.messageId));
  held.release();

  await caughtUp(svc, ws.id, ws.general);
  const row = svc.store.eventById(ws.id, secret.messageId);
  assert.equal(row.redacted, 1);
  assert.equal(row.text, null);
  assert.equal(row.mentions, null);
  const view = await api.chatOpen(ws.id, ws.general);
  const shown = view.events.find((e) => e.id === secret.messageId);
  assert.equal(shown.redacted, true);
  assert.equal(shown.text, null);
  assert.deepEqual(shown.mentions, []);
  assert.ok(!JSON.stringify(svc.events).includes('secret plan'), 'no push carried the removed text');
});

test('a removal arriving in a history page redacts the cached message and tells the renderer', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api } = await setup(t);
  const [gone] = await postMany(olga, ws.id, ws.general, 1, { prefix: 'soon gone' });
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general);
  await caughtUp(svc, ws.id, ws.general);
  await api.chatClose();
  // Removed while the room is closed and unread by the feed: the forward page brings message.redacted.
  await server.redact(olga, ws.id, ws.general, gone.messageId);
  const head = svc.store.getRoom(ws.id, ws.general).head;
  svc.store.setRoomFields(ws.id, ws.general, { head: head + 1 });
  await api.chatOpen(ws.id, ws.general);
  await caughtUp(svc, ws.id, ws.general);
  const row = svc.store.eventById(ws.id, gone.messageId);
  assert.equal(row.redacted, 1);
  assert.equal(row.text, null);
  const redacted = svc.events.filter((e) => e.kind === 'redacted' && e.conversation === ws.general);
  assert.deepEqual(redacted.at(-1), { kind: 'redacted', ws: ws.id, conversation: ws.general, ids: [gone.messageId] });
  assert.ok(svc.store.hasTombstone(ws.id, gone.messageId));
});

test('a room keeps at most ROOM_CACHE_MAX events, dropping the oldest', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api } = await setup(t, { timing: { ...SMALL, roomCacheMax: 3 } });
  await postMany(olga, ws.id, ws.general, 8);
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general);
  const room = await caughtUp(svc, ws.id, ws.general);
  assert.equal(cachedSeqs(svc, ws.id, ws.general).length, 3);
  assert.equal(room.lo, room.head - 2);
  // Older pages still come back to the renderer, even though the cache can't keep them.
  const older = await api.chatOlder(ws.id, ws.general, room.lo);
  assert.equal(older.events.length, 5);
  assert.equal(older.events.at(-1).seq, room.lo - 1);
  assert.ok(older.events.every((e) => e.text === null || e.text.startsWith('message')));
  assert.equal(cachedSeqs(svc, ws.id, ws.general).length, 3);
  assert.equal(svc.store.getRoom(ws.id, ws.general).hi, room.head, 'the range still ends at head');
});

test('the open room catches up from the feed: inline events, then forward pages', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t);
  await api.chatOpen(ws.id, ws.general);
  let room = await caughtUp(svc, ws.id, ws.general);
  // A few: the feed carries them inline.
  await postMany(olga, ws.id, ws.general, 3, { prefix: 'live' });
  const calls = watchCalls(account);
  await svc.sync(ws.id);
  room = await caughtUp(svc, ws.id, ws.general);
  const feed = calls.find((c) => c.route.startsWith(route(ws.id, '/changes')));
  assert.ok(feed.route.includes(`active=${ws.general}`) && feed.route.includes('roomAfter='), feed.route);
  assert.deepEqual(eventCalls(calls, ws.general), [], 'inline events needed no history request');
  assert.deepEqual(
    pushes(svc, ws.general).at(-1).events.map((e) => e.text),
    ['live 1', 'live 2', 'live 3']
  );
  // More than the feed carries inline (20): the rest comes from a forward page.
  await postMany(olga, ws.id, ws.general, 30, { prefix: 'burst' });
  const more = watchCalls(account);
  await svc.sync(ws.id);
  room = await caughtUp(svc, ws.id, ws.general);
  assert.equal(room.hi, room.head);
  assert.deepEqual(eventCalls(more, ws.general), [`after=${room.head - 10}&limit=100`]);
  const texts = pushes(svc, ws.general).flatMap((p) => p.events.map((e) => e.text)).filter((x) => x && x.startsWith('burst'));
  assert.equal(new Set(texts).size, 30);
});

test('a dropped cache of the open room is shown again with replace', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, svc, api } = await setup(t);
  await postMany(olga, ws.id, ws.general, 5);
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general);
  await caughtUp(svc, ws.id, ws.general);
  // Bart leaves and joins general again on another device: a new grant drops the cache.
  assert.equal((await server.call('DELETE', route(ws.id, `/channels/${ws.general}/members/me`), { token: bart.token })).status, 204);
  assert.equal((await server.call('POST', route(ws.id, `/channels/${ws.general}/join`), { token: bart.token })).status, 200);
  const count = pushes(svc, ws.general).length;
  await svc.sync(ws.id);
  await caughtUp(svc, ws.id, ws.general);
  const after = pushes(svc, ws.general).slice(count);
  assert.ok(after.some((p) => p.replace), 'the renderer was told to drop what it shows');
  const room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.hi, room.head);
});

test('chatRoomMembers asks the server for a channel and the cache for a DM', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, api, account } = await setup(t);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await svc.sync(ws.id);
  const calls = watchCalls(account);
  const channel = await api.chatRoomMembers(ws.id, ws.general);
  assert.deepEqual(
    channel.members.map((m) => m.member).sort(),
    [ws.me.id, bartMe.id].sort()
  );
  assert.equal(channel.members.find((m) => m.member === ws.me.id).role, 'manager');
  assert.deepEqual(calls.map((c) => c.route), [route(ws.id, `/channels/${ws.general}/members`)]);
  const direct = await api.chatRoomMembers(ws.id, dm.conversation);
  assert.deepEqual(
    direct.members.map((m) => m.member).sort(),
    [ws.me.id, bartMe.id].sort()
  );
  assert.equal(calls.length, 1, 'a DM needs no request');
  await assert.rejects(api.chatRoomMembers(ws.id, 'c_AAAAAAAAAAAAAAAAAAAAAA'), (err) => err.code === 'not_found' && err.scope === 'conversation');
});

test('a service on a new session drops the open room', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, api } = await setup(t);
  await api.chatOpen(ws.id, ws.general);
  await caughtUp(svc, ws.id, ws.general);
  assert.ok(svc.history.activeQuery(ws.id));
  svc.endSession();
  assert.equal(svc.history.activeQuery(ws.id), null);
  // A workspace that went takes its open room with it.
  svc.close();
  const again = chatService(svc.account, svc.dataDir);
  t.after(() => again.close());
  await settled(again, ws.id);
  const api2 = chatApi(() => again);
  await api2.chatOpen(ws.id, ws.general);
  again.removeWorkspace(ws.id, 'left');
  assert.equal(again.history.open, null);
  assert.equal(again.active, null);
});

// Contract 3.6: a page asked for before Start over belongs to the cache as it stood, with removals the pass from the
// start can no longer list. It is dropped, and the page asked again under the new cache revision is the one cached.
test('a history page that comes after Start over is dropped, and the text it carried stays out', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t, { timing: { minFetchGap: 0 } });
  const [removed] = await postMany(olga, ws.id, ws.general, 1, { prefix: 'from before Start over' });
  await svc.sync(ws.id);
  const held = holdNext(account, (url) => url.includes(`/conversations/${ws.general}/events?`));
  await api.chatOpen(ws.id, ws.general);
  await until(() => held.waiting, 10000, 'the held page');
  await server.redact(olga, ws.id, ws.general, removed.messageId);
  await api.chatReload(ws.id);
  await settled(svc, ws.id);
  assert.equal(svc.store.eventById(ws.id, removed.messageId), null, 'Start over emptied the cache');
  const mark = svc.events.length;
  held.release();

  await caughtUp(svc, ws.id, ws.general);
  const row = svc.store.eventById(ws.id, removed.messageId);
  assert.equal(row.redacted, 1);
  assert.equal(row.text, null);
  assert.ok(!JSON.stringify(svc.events.slice(mark)).includes('from before Start over'), 'no push carried the removed text');
  assert.ok(pushes(svc, ws.general).slice(-1)[0].events.some((e) => e.id === removed.messageId && e.redacted));
});

// Contract 3.6: removedMore says more messages went than the feed can list, so no tombstone keeps their text out. A
// history page asked for before it carries that text; the feed page drops the room's cache and raises the cache
// revision, so the page is dropped and the one asked again is cached. removedMore is synthetic (see chat-sync).
test('a history page held across a removedMore page writes nothing', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t);
  const [secret] = await postMany(olga, ws.id, ws.general, 1, { prefix: 'secret plan' });
  await postMany(olga, ws.id, ws.general, 2, { prefix: 'other' });
  await svc.sync(ws.id);
  const old = svc.store.getRoom(ws.id, ws.general);
  assert.equal(old.hi, null);

  // Every event written into the room's cache.
  const written = [];
  const write = svc.store.writeEvents.bind(svc.store);
  svc.store.writeEvents = (w, room, events) => {
    if (room === ws.general) written.push(...events);
    return write(w, room, events);
  };

  const held = holdNext(account, (url) => url.includes(`/conversations/${ws.general}/events?before=`));
  await api.chatOpen(ws.id, ws.general);
  await until(() => held.waiting, 10000, 'the held page');
  await api.chatClose();
  // Olga removes the message; the feed says only that more went than it can list.
  await server.redact(olga, ws.id, ws.general, secret.messageId);
  let rewrite = true;
  watchCalls(account, async (method, url, real) => {
    if (!rewrite || !url.startsWith(route(ws.id, '/changes'))) return undefined;
    rewrite = false;
    const page = await real();
    const room = page.changes.find((c) => c.conversation === ws.general);
    assert.ok(room, 'the redaction lists the room');
    room.removed = [];
    room.removedMore = true;
    return page;
  });
  const revision = svc.revision(ws.id);
  const outcome = await svc.sync(ws.id);
  assert.ok(outcome.changed.includes(ws.general), 'the run that applied the page got through');
  assert.ok(svc.revision(ws.id) > revision, 'removedMore raised the cache revision');
  assert.equal(svc.store.hasTombstone(ws.id, secret.messageId), false, 'nothing lists the removed message');
  const now = svc.store.getRoom(ws.id, ws.general);
  const mark = svc.events.length;
  held.release();

  await until(() => !svc.history.loads.size, 15000, 'the catch-up to finish');
  assert.ok(!written.some((e) => typeof e.text === 'string' && e.text.startsWith('secret plan')), 'the held page was written');
  const calls = eventCalls(held.calls, ws.general);
  assert.equal(calls[0], `before=${old.head + 1}&limit=50`);
  assert.equal(calls[1], `before=${now.head + 1}&limit=50`, 'the newest page was asked again');
  const row = svc.store.eventById(ws.id, secret.messageId);
  assert.equal(row.redacted, 1);
  assert.equal(row.text, null);
  const view = await api.chatOpen(ws.id, ws.general);
  assert.ok(view.events.some((e) => e.id === secret.messageId && e.redacted && e.text === null));
  assert.ok(!JSON.stringify(svc.events.slice(mark)).includes('secret plan'), 'no push carried the removed text');
  assert.ok(!JSON.stringify(view).includes('secret plan'));
});

// Contract 3.7, 3.13, 3.14: a thread root the cache couldn't keep lives in the thread's memory. Removing it takes its
// text out of that memory at once, and a floor past it expires the thread.
test('a thread root kept outside the cache loses its text when removed and goes below the floor', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, svc, api, account } = await setup(t, { timing: { ...SMALL, roomCacheMax: 3 } });
  const [root] = await postMany(bart, ws.id, ws.general, 1, { prefix: 'the old root' });
  await postMany(olga, ws.id, ws.general, 2, { prefix: 'reply', root: root.messageId });
  await postMany(olga, ws.id, ws.general, 4, { prefix: 'newer' });
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general);
  const room = await caughtUp(svc, ws.id, ws.general);
  assert.ok(room.lo > root.seq + 2, 'the root and its replies are older than the cache');

  const thread = await api.chatThread(ws.id, ws.general, root.messageId);
  assert.equal(thread.root.text, 'the old root 1');
  assert.deepEqual(thread.replies.map((r) => r.text), ['reply 1', 'reply 2']);
  assert.equal(svc.store.eventById(ws.id, root.messageId), null, 'the root is held outside SQLite');

  await api.chatRedact(ws.id, ws.general, root.messageId);
  const held = [...svc.history.threadMemory.extra.values()].find((e) => e.id === root.messageId);
  assert.equal(held.text, null, 'the memory lost the text when the removal was learned');
  assert.equal(held.redacted, true);
  const again = await api.chatThread(ws.id, ws.general, root.messageId);
  assert.equal(again.root.redacted, true);
  assert.equal(again.root.text, null);
  assert.deepEqual(again.root.mentions, []);
  assert.equal(again.replies.length, 2);
  // A run takes the removal from the feed first, so the page that brings the floor lists no removed IDs and the cache
  // has nothing below the floor: the memory must still be checked against it.
  await svc.sync(ws.id);

  // Retention passes the root and its replies (one field of a real feed answer, as retention can't be made on demand).
  await postMany(olga, ws.id, ws.general, 1, { prefix: 'after' });
  const floor = root.seq + 3;
  watchCalls(account, async (method, url, real) => {
    if (!url.includes('/changes')) return undefined;
    const answer = await real();
    return { ...answer, changes: answer.changes.map((c) => (c.conversation === ws.general ? { ...c, floor } : c)) };
  });
  await svc.sync(ws.id);
  assert.equal(svc.store.getRoom(ws.id, ws.general).floor, floor);
  assert.ok(![...svc.history.threadMemory.extra.values()].some((e) => e.seq < floor), 'what aged out left the memory');
  const aged = await api.chatThread(ws.id, ws.general, root.messageId);
  assert.equal(aged.root, null);
  assert.equal(aged.expired, true);
  assert.deepEqual(aged.replies, []);
});

// Contract 3.7, 3.14: opening at a seq returns events of pages the cache couldn't keep. A removal learned while the
// backfill runs shows in the answer, and one learned later reaches the renderer by ID.
test('opening at a seq returns detached events as they stand, and tells the renderer of a later removal', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t, { timing: { ...SMALL, roomCacheMax: 3 } });
  const notes = await postMany(olga, ws.id, ws.general, 30, { prefix: 'note' });
  await svc.sync(ws.id);
  const at = notes[1].seq;
  // The third events request is the backfill's second page: it waits while a removal reaches the feed.
  let count = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let waiting = false;
  watchCalls(account, async (method, url, real) => {
    if (!url.includes(`/conversations/${ws.general}/events?before=`)) return undefined;
    count += 1;
    if (count !== 3) return undefined;
    const answer = await real();
    waiting = true;
    await gate;
    return answer;
  });
  const opening = api.chatOpen(ws.id, ws.general, { at });
  await until(() => waiting, 10000, 'the held backfill page');
  const early = notes[24];
  assert.ok(early.seq < svc.store.getRoom(ws.id, ws.general).lo, 'the removed note is outside the cache');
  await server.redact(olga, ws.id, ws.general, early.messageId);
  await svc.sync(ws.id);
  assert.ok(svc.store.hasTombstone(ws.id, early.messageId));
  release();
  const view = await opening;
  assert.equal(view.complete, true);
  const shown = view.events.find((e) => e.id === early.messageId);
  assert.equal(shown.redacted, true);
  assert.equal(shown.text, null);
  assert.ok(!JSON.stringify(view).includes('note 25'));

  // Removed after the view was answered: the renderer hears the ID, as the store's redacted covers cached ones only.
  const later = notes[19];
  assert.equal(view.events.find((e) => e.id === later.messageId).text, 'note 20');
  assert.equal(svc.store.eventById(ws.id, later.messageId), null);
  await server.redact(olga, ws.id, ws.general, later.messageId);
  await svc.sync(ws.id);
  assert.ok(
    svc.events.some((e) => e.kind === 'redacted' && e.conversation === ws.general && e.ids.includes(later.messageId)),
    'the renderer heard of the removal'
  );
});

test('an opening at a seq answers with the read position of a Mark unread that came while it waited', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, svc, api, account } = await setup(t, { timing: SMALL });
  const notes = await postMany(olga, ws.id, ws.general, 30, { prefix: 'note' });
  await svc.sync(ws.id);
  const head = svc.store.getRoom(ws.id, ws.general).head;
  await api.chatMarkRead(ws.id, ws.general);
  await until(() => svc.store.getRoom(ws.id, ws.general).readSent >= head, 10000, 'the read to reach the server');
  // The first backfill page waits while Bart marks a note unread on another device.
  let held = false;
  let waiting = false;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  watchCalls(account, async (method, url, real) => {
    if (held || !url.includes(`/conversations/${ws.general}/events?before=`)) return undefined;
    held = true;
    const answer = await real();
    waiting = true;
    await gate;
    return answer;
  });
  const opening = api.chatOpen(ws.id, ws.general, { at: notes[1].seq });
  await until(() => waiting, 10000, 'the held backfill page');
  const marked = await server.call('POST', route(ws.id, `/conversations/${ws.general}/unread`), { token: bart.token, body: { message: notes[10].messageId } });
  assert.equal(marked.status, 200);
  await svc.sync(ws.id);
  assert.equal(svc.store.getRoom(ws.id, ws.general).readLocal, notes[10].seq - 1);
  release();
  const view = await opening;
  assert.equal(view.readAtOpen, notes[10].seq - 1);
});

// Contract 3.6: a new grant empties the room's cache, as the feed can't list what was removed while the person was out.
// Detached events an opening at a seq loaded under the old grant go with it: the new grant raises the cache revision.
// The removal is kept out of the feed page (synthetic), as for removedMore.
test('an opening at a seq drops the detached events it loaded under the old grant', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, svc, api, account } = await setup(t, { timing: { ...SMALL, roomCacheMax: 3 } });
  const notes = await postMany(olga, ws.id, ws.general, 30, { prefix: 'note' });
  await svc.sync(ws.id);
  const at = notes[1].seq;
  // The third events request is the backfill's second page: it waits while Bart leaves and joins again elsewhere.
  let count = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let waiting = false;
  watchCalls(account, async (method, url, real) => {
    if (!url.includes(`/conversations/${ws.general}/events?before=`)) return undefined;
    count += 1;
    if (count !== 3) return undefined;
    const answer = await real();
    waiting = true;
    await gate;
    return answer;
  });
  const old = svc.store.getRoom(ws.id, ws.general);
  const opening = api.chatOpen(ws.id, ws.general, { at });
  await until(() => waiting, 10000, 'the held backfill page');
  const early = notes[24];
  assert.ok(early.seq < svc.store.getRoom(ws.id, ws.general).lo, 'the removed note is outside the cache');
  await server.redact(olga, ws.id, ws.general, early.messageId);
  assert.equal((await server.call('DELETE', route(ws.id, `/channels/${ws.general}/members/me`), { token: bart.token })).status, 204);
  assert.equal((await server.call('POST', route(ws.id, `/channels/${ws.general}/join`), { token: bart.token })).status, 200);
  let strip = true;
  watchCalls(account, async (method, url, real) => {
    if (!strip || !url.startsWith(route(ws.id, '/changes'))) return undefined;
    strip = false;
    const page = await real();
    for (const room of page.changes) room.removed = [];
    if (page.inlineEvents) page.inlineEvents = page.inlineEvents.filter((e) => e.kind !== 'message.redacted');
    return page;
  });
  await svc.sync(ws.id);
  assert.notEqual(svc.store.getRoom(ws.id, ws.general).grantId, old.grantId, 'the feed brought the new grant');
  assert.equal(svc.store.hasTombstone(ws.id, early.messageId), false, 'nothing lists the removed note');
  release();
  const view = await opening;
  assert.ok(!JSON.stringify(view).includes('note 25'), 'a detached event from the old grant came back');
});

// Follow-up 206 item 4: a thread or an opening at a seq whose pages were on their way when the workspace was revoked
// answers nothing of its cache, also when SQLite couldn't delete it yet and the cached text is still on disk.
test('a thread or an opening at a seq that answers after the workspace was revoked returns no cached text', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api, account } = await setup(t);
  const [root] = await postMany(olga, ws.id, ws.general, 1, { prefix: 'revoked root' });
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general);
  const room = await caughtUp(svc, ws.id, ws.general);
  assert.equal(svc.store.eventById(ws.id, root.messageId).text, 'revoked root 1');
  // The cache is one behind, so both catch up first, through one held forward page.
  svc.store.setRoomFields(ws.id, ws.general, { head: room.head + 1 });
  const held = holdNext(account, (url) => url.includes(`/conversations/${ws.general}/events?after=`));
  const thread = api.chatThread(ws.id, ws.general, root.messageId);
  const opening = api.chatOpen(ws.id, ws.general, { at: root.seq });
  await until(() => held.waiting, 10000, 'the held page');
  svc.store.db.exec(`CREATE TRIGGER refuse_ws_delete BEFORE DELETE ON ws BEGIN SELECT RAISE(ABORT, 'simulated write error'); END`);
  svc.removeWorkspace(ws.id, 'left');
  assert.ok(svc.store.eventById(ws.id, root.messageId), 'the text is still on disk');
  held.release();
  await assert.rejects(thread, (err) => err.code === 'not_found');
  await assert.rejects(opening, (err) => err.code === 'not_found');
});

// Follow-up 206 item 6: a removal a history page brings for a message the renderer shows but SQLite trimmed reaches
// the renderer by ID, as the store's redacted only covers cached messages.
test('a removal in a history page for a message the cache trimmed tells the renderer', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, svc, api } = await setup(t, { timing: { ...SMALL, roomCacheMax: 3 } });
  const notes = await postMany(olga, ws.id, ws.general, 8, { prefix: 'kept outside' });
  await svc.sync(ws.id);
  await api.chatOpen(ws.id, ws.general);
  const room = await caughtUp(svc, ws.id, ws.general);
  const older = await api.chatOlder(ws.id, ws.general, room.lo);
  const target = notes.find((n) => n.seq === older.events.at(-1).seq);
  assert.equal(older.events.at(-1).text, target ? `kept outside ${notes.indexOf(target) + 1}` : null);
  assert.equal(svc.store.eventById(ws.id, target.messageId), null, 'the renderer holds it, SQLite does not');
  // Olga removes it; the forward page (not the feed) brings message.redacted.
  await server.redact(olga, ws.id, ws.general, target.messageId);
  svc.store.setRoomFields(ws.id, ws.general, { head: room.head + 1 });
  await svc.history.catchUp(ws.id, ws.general);
  assert.ok(svc.store.hasTombstone(ws.id, target.messageId));
  assert.ok(
    svc.events.some((e) => e.kind === 'redacted' && e.conversation === ws.general && e.ids.includes(target.messageId)),
    'the renderer heard of the removal'
  );
});

// Review of #376, finding 9: the thread a window shows belongs to the opening of the room that reported it.
test("the thread shown beside a room belongs to its opening: other rooms' calls are ignored, and closing, reopening and the window going clear it", async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, api } = await setup(t);
  const root = await server.post(olga, ws.id, ws.general, 'Thread root');
  const other = (await server.seedChannel(olga, ws.id, { name: 'other', members: [bartMe.id] })).id;
  await svc.sync(ws.id);
  assert.equal(await api.chatThreadShown(ws.id, ws.general, root.messageId), false, 'no room open: ignored');
  await api.chatOpen(ws.id, ws.general, {});
  assert.equal(await api.chatThreadShown(ws.id, ws.general, root.messageId), true);
  assert.equal(svc.history.openThread(ws.id, ws.general), root.messageId);
  assert.equal(await api.chatThreadShown(ws.id, other, null), false, 'a call for another room is ignored');
  assert.equal(svc.history.openThread(ws.id, ws.general), root.messageId);
  await api.chatClose();
  assert.equal(svc.history.openThread(ws.id, ws.general), null, 'closing the room clears it');
  await api.chatOpen(ws.id, ws.general, {});
  assert.equal(svc.history.openThread(ws.id, ws.general), null, 'reopening starts without a thread');
  await api.chatThreadShown(ws.id, ws.general, root.messageId);
  await api.chatOpen(ws.id, other, {});
  assert.equal(svc.history.openThread(ws.id, ws.general), null, 'another room opening clears it');
  await api.chatOpen(ws.id, ws.general, {});
  assert.equal(svc.history.openThread(ws.id, ws.general), null);
  await api.chatThreadShown(ws.id, ws.general, root.messageId);
  svc.history.rendererGone();
  assert.equal(svc.history.openThread(ws.id, ws.general), null, 'the window going clears it');
});
