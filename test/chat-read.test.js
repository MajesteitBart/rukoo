'use strict';

// Reads, badges, mute and drafts in the history module (src/main/workspaces/history.js), as contract 8.4 lists for
// chat-read: reads coalesce to one POST per 5 s per room; positions never go back; readLocal survives a restart and
// flushes; the badges are recounted from the cache; a block leaves the blocked author's mentions out of that recount;
// mute and drafts persist across a restart. The server is the real one (test/fixtures/real-server.js); the service's
// timers run on a fake clock, so the 5 s rule is checked to the millisecond.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRealServer, realServerAvailable, skipWithoutServer, uuidv7, mention } = require('./fixtures/real-server');
const { attach, chatService, watchCalls, until, sleep, fakeClock } = require('./fixtures/chat-app');
const { chatApi } = require('../src/main/workspaces/ipc');
const { AccountError } = require('../src/main/account/client');

let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') server = await startRealServer();
});
test.after(() => server?.close());

const route = (ws, rest = '') => `/v1/workspaces/${ws}${rest}`;

// Until check() holds, firing the fake clock's due timers (and stepping it by step ms) between real waits for the
// server's answers.
async function drive(clock, check, what, step = 600) {
  return until(async () => {
    await clock.advance(step);
    return check();
  }, 15000, what);
}

// A run of ws, on the fake clock.
async function syncNow(clock, svc, ws) {
  let done = false;
  svc.sync(ws).then(() => (done = true));
  await drive(clock, () => done, `a run of ${ws}`);
}

// Until the service's first pass of ws installed, on the fake clock.
async function settle(clock, svc, ws) {
  await drive(clock, () => {
    const row = svc.store && svc.store.getWs(ws);
    const r = svc.runners.get(ws);
    return row && !row.fresh && !row.passing && !(r && r.running);
  }, `the first pass of ${ws}`);
}

// Until the open room's cache reaches head.
async function caughtUp(clock, svc, ws, room) {
  await drive(clock, () => {
    const r = svc.store.getRoom(ws, room);
    return r && r.hi !== null && r.hi >= r.head && !svc.history.loads.size;
  }, 'the room to reach head', 0);
  return svc.store.getRoom(ws, room);
}

// A service on the fake clock; reads go through the IPC table.
function serviceFor(account, dir, clock, timing = {}) {
  const svc = chatService(account, dir, { now: clock.now, timers: clock, timing });
  svc.api = chatApi(() => svc);
  return svc;
}

// Olga's workspace with Bart in general, Bart's device on a fake clock, and n messages from Olga before it starts.
async function setup(t, { n = 10, mentions = [] } = {}) {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Reads', displayName: 'Olga' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const posts = await postMany(olga, ws.id, ws.general, n, { mentionOf: (i) => (mentions.includes(i) ? bartMe.id : null) });
  const clock = fakeClock();
  const { account, dir } = attach(server, bart);
  const svc = serviceFor(account, dir, clock);
  t.after(() => {
    svc.close();
    account.close();
  });
  await settle(clock, svc, ws.id);
  return { olga, bart, ws, bartMe, posts, clock, account, dir, svc };
}

// n messages, "message 1" to "message n"; mentionOf(i) names the member mentioned in message i, or null.
async function postMany(person, wsId, conversation, n, { prefix = 'message', mentionOf = () => null } = {}) {
  const a = await server.access(person, wsId, conversation);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const who = mentionOf(i);
    const text = who ? `${prefix} ${i} @Bart` : `${prefix} ${i}`;
    const body = { operationId: uuidv7(a.time + i), grant: a.grant, generation: a.generation, text };
    if (who) body.mentions = [mention(text, '@Bart', who)];
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

// Each POST /read, with the seq it sent.
function watchReads(account, answer = null) {
  const reads = [];
  watchCalls(account, async (method, url, real, body) => {
    if (method !== 'POST' || !url.endsWith('/read')) return undefined;
    reads.push({ room: url.split('/conversations/')[1].split('/')[0], seq: body.seq });
    return answer ? answer(url, real, body) : undefined;
  });
  return reads;
}

// The read position the server keeps for person in a room: the room row of a full feed pass.
async function serverRead(person, wsId, room) {
  let cursor = null;
  let read = null;
  for (;;) {
    const res = await server.call('GET', route(wsId, `/changes${cursor ? `?after=${cursor}` : ''}`), { token: person.token });
    const row = res.body.changes.find((c) => c.conversation === room);
    if (row) read = row.read;
    cursor = res.body.next;
    if (!res.body.more) return read;
  }
}

test('reads coalesce to one POST per 5 s per room, and positions never go back', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, posts, clock, account, svc } = await setup(t);
  const project = await server.seedChannel(olga, ws.id, { name: 'project', members: [bartMe.id] });
  await postMany(olga, ws.id, project.id, 1, { prefix: 'project' });
  await syncNow(clock, svc, ws.id);
  assert.ok(svc.store.getRoom(ws.id, project.id).readLocal < svc.store.getRoom(ws.id, project.id).head);
  const reads = watchReads(account);
  const seqs = posts.map((p) => p.seq);
  const room = () => svc.store.getRoom(ws.id, ws.general);
  const start = room().readLocal;
  assert.ok(start < seqs[0]);

  // The first read of a room goes at once.
  assert.equal(await svc.api.chatRead(ws.id, ws.general, seqs[2]), true);
  assert.equal(room().readLocal, seqs[2], 'on disk before any request');
  await until(() => room().readSent === seqs[2], 5000, 'the first flush');
  assert.deepEqual(reads, [{ room: ws.general, seq: seqs[2] }]);

  // Two more within 5 s wait for one POST with the higher of them.
  await svc.api.chatRead(ws.id, ws.general, seqs[4]);
  await svc.api.chatRead(ws.id, ws.general, seqs[6]);
  assert.equal(room().readLocal, seqs[6]);
  await clock.advance(4999);
  await sleep(30);
  assert.equal(reads.length, 1, 'nothing before 5 s');
  // Another room has its own 5 s.
  await svc.api.chatRead(ws.id, project.id, svc.store.getRoom(ws.id, project.id).head);
  await until(() => reads.length === 2, 5000, 'the other room');
  assert.equal(reads[1].room, project.id);
  await clock.advance(1);
  await until(() => reads.length === 3, 5000, 'the coalesced flush');
  assert.deepEqual(reads[2], { room: ws.general, seq: seqs[6] });
  await until(() => room().readSent === seqs[6], 5000, 'its answer');
  assert.equal(await serverRead(bart, ws.id, ws.general), seqs[6]);

  // Never back: a lower seq changes nothing and sends nothing.
  await svc.api.chatRead(ws.id, ws.general, seqs[1]);
  assert.equal(room().readLocal, seqs[6]);
  await clock.advance(10000);
  await sleep(30);
  assert.equal(reads.length, 3);
  // Past head is head.
  const head = room().head;
  await svc.api.chatRead(ws.id, ws.general, head + 50);
  assert.equal(room().readLocal, head);
  await until(() => reads.length === 4, 5000, 'the flush to head');
  assert.equal(reads[3].seq, head);
  // The feed confirms it, and keeps it there.
  await syncNow(clock, svc, ws.id);
  assert.equal(room().readLocal, head);
  assert.equal(room().read, head);

  // Invalid arguments are refused before anything happens.
  await assert.rejects(svc.api.chatRead(ws.id, ws.general, -1), (err) => err.code === 'invalid' && err.field === 'seq');
  await assert.rejects(svc.api.chatRead(ws.id, 'c_AAAAAAAAAAAAAAAAAAAAAA', 1), (err) => err.code === 'not_found' && err.scope === 'conversation');
});

test('a read that could not be sent survives a restart and goes out after the first run', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, posts, clock, account, dir, svc } = await setup(t);
  let offline = true;
  const reads = watchReads(account, () => {
    if (offline) throw new AccountError('network', 0, 'The server could not be reached.');
    return undefined;
  });
  const target = posts[5].seq;
  await svc.api.chatRead(ws.id, ws.general, target);
  await until(() => reads.length === 1, 5000, 'the failed flush');
  await sleep(30);
  let room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.readLocal, target);
  assert.ok(room.readSent < target);
  // A failed flush waits for the end of the next run, not for a timer.
  await clock.advance(60000);
  await sleep(30);
  assert.equal(reads.length, 1);
  svc.close();

  offline = false;
  const again = serviceFor(account, dir, clock);
  t.after(() => again.close());
  await drive(clock, () => {
    const r = again.store && again.store.getRoom(ws.id, ws.general);
    return r && r.readSent === target;
  }, 'the flush after the restart');
  room = again.store.getRoom(ws.id, ws.general);
  assert.equal(room.readLocal, target);
  assert.equal(room.read, target);
  assert.equal(reads.at(-1).seq, target);
  assert.equal(await serverRead(bart, ws.id, ws.general), target);
});

test('badges are recounted from the cache after a local read, and the notifier hears of it', async (t) => {
  if (skipWithoutServer(t)) return;
  // Messages 3, 6 and 9 mention Bart.
  const { ws, posts, clock, account, svc } = await setup(t, { n: 10, mentions: [3, 6, 9] });
  let room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.unread, 10);
  assert.equal(room.mentions, 3);
  const heard = [];
  svc.notifier.onRead = (w, c) => heard.push([w, c]);
  // Flushes fail, so the server's numbers can't stand in for the recount.
  watchReads(account, () => {
    throw new AccountError('network', 0, 'The server could not be reached.');
  });

  // Without a cache covering what's after the read position, the server's numbers stay.
  await svc.api.chatRead(ws.id, ws.general, posts[1].seq);
  room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.readLocal, posts[1].seq);
  assert.equal(room.unread, 10);
  assert.deepEqual(heard, [[ws.id, ws.general]]);

  // With the room cached up to head, the badges count what's after the local read.
  await svc.api.chatOpen(ws.id, ws.general);
  await caughtUp(clock, svc, ws.id, ws.general);
  room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.unread, 8, 'messages 3 to 10');
  assert.equal(room.mentions, 3);
  await svc.api.chatRead(ws.id, ws.general, posts[5].seq);
  room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.unread, 4);
  assert.equal(room.mentions, 1);
  // The rooms event goes out after the service's coalescing delay, on the fake clock.
  await clock.advance(200);
  const latest = svc.events.filter((e) => e.kind === 'rooms').at(-1);
  const shown = latest.rooms.find((r) => r.id === ws.general);
  assert.equal(shown.read, posts[5].seq);
  assert.equal(shown.unread, 4);
  assert.equal(shown.attention, 1, 'a channel asks for its mentions');

  // Mark as read: everything up to head, badges at zero.
  assert.equal(await svc.api.chatMarkRead(ws.id, ws.general), true);
  room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.readLocal, room.head);
  assert.equal(room.unread, 0);
  assert.equal(room.mentions, 0);
  assert.equal(heard.length, 3);
  assert.equal(svc.state().attention, 0);
});

test('a block leaves the blocked author out of the mention recount, not out of unread', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, clock, account, svc } = await setup(t, { n: 0 });
  const mila = await server.seedAccount();
  const milaMe = await server.seedMember(ws, mila, 'Mila');
  // Olga and Mila each post three, the second of each mentioning Bart.
  const olgaPosts = await postMany(olga, ws.id, ws.general, 3, { prefix: 'olga', mentionOf: (i) => (i === 2 ? bartMe.id : null) });
  const milaPosts = await postMany(mila, ws.id, ws.general, 3, { prefix: 'mila', mentionOf: (i) => (i === 2 ? bartMe.id : null) });
  await server.block(bart, ws.id, ws.me.id);
  await syncNow(clock, svc, ws.id);
  assert.deepEqual(svc.store.listBlocks(ws.id).map((b) => b.member), [ws.me.id]);
  assert.ok(milaMe.id);
  watchReads(account, () => {
    throw new AccountError('network', 0, 'The server could not be reached.');
  });
  await svc.api.chatOpen(ws.id, ws.general);
  await caughtUp(clock, svc, ws.id, ws.general);

  // Read up to Olga's first message: Olga's mention and Mila's remain after it, but only Mila's counts.
  await svc.api.chatRead(ws.id, ws.general, olgaPosts[0].seq);
  const room = svc.store.getRoom(ws.id, ws.general);
  assert.equal(room.unread, 5, "Olga's two and Mila's three still count as unread");
  assert.equal(room.mentions, 1, "only Mila's mention counts");
  assert.ok(milaPosts.length === 3);
});

test('mute and drafts persist across a restart', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, posts, clock, account, dir, svc } = await setup(t, { n: 2, mentions: [1] });
  const root = posts[0].messageId;
  assert.equal(svc.state().attention, 1);

  const muted = await svc.api.chatMute(ws.id, ws.general, true);
  assert.deepEqual(Object.keys(muted), ['room']);
  assert.equal(muted.room.muted, true);
  assert.equal(muted.room.attention, 0);
  await sleep(20);
  await clock.advance(200);
  const rooms = svc.events.filter((e) => e.kind === 'rooms').at(-1);
  assert.equal(rooms.rooms.find((r) => r.id === ws.general).muted, true);
  assert.equal(svc.state().attention, 0, 'a muted room asks for no attention');

  const main = { text: 'Hoi @Zoë, nog even', mentions: [{ actor: ws.me.id, start: 4, end: 9 }] };
  const reply = { text: 'in the thread', mentions: [] };
  assert.equal(await svc.api.chatSaveDraft(ws.id, ws.general, null, main), true);
  assert.equal(await svc.api.chatSaveDraft(ws.id, ws.general, root, reply), true);
  await assert.rejects(
    svc.api.chatSaveDraft(ws.id, ws.general, null, { text: '@Zoë', mentions: [{ actor: ws.me.id, start: 0, end: 4 }] }),
    (err) => err.code === 'invalid' && err.field === 'mentions'
  );
  // chatDraft reads a kept draft without opening the room (Undo of Discard from another room).
  assert.deepEqual(await svc.api.chatDraft(ws.id, ws.general, null), main);
  assert.deepEqual(await svc.api.chatDraft(ws.id, ws.general, root), reply);
  assert.equal(await svc.api.chatDraft(ws.id, ws.general, posts[1].messageId), null);
  await assert.rejects(svc.api.chatDraft(ws.id, 'c_' + 'x'.repeat(22), null), (err) => err.code === 'not_found');
  svc.close();

  const again = serviceFor(account, dir, clock);
  t.after(() => again.close());
  await drive(clock, () => again.store && again.store.getRoom(ws.id, ws.general), 'the cache to open');
  const view = await again.api.chatOpen(ws.id, ws.general);
  assert.equal(view.room.muted, true);
  assert.deepEqual(view.draft, main);
  await caughtUp(clock, again, ws.id, ws.general);
  const thread = await again.api.chatThread(ws.id, ws.general, root);
  assert.deepEqual(thread.draft, reply);
  // A feed pass keeps mute: the room row comes again, muted stays local.
  await again.api.chatReload(ws.id);
  await drive(clock, () => {
    const row = again.store.getWs(ws.id);
    const r = again.runners.get(ws.id);
    return row && !row.passing && !(r && r.running);
  }, 'the pass after Start over');
  assert.equal(again.store.getRoom(ws.id, ws.general).muted, 1);

  // Unmuted, and the drafts cleared with null and empty text.
  assert.equal((await again.api.chatMute(ws.id, ws.general, false)).room.muted, false);
  assert.equal(await again.api.chatSaveDraft(ws.id, ws.general, null, null), true);
  assert.equal(await again.api.chatSaveDraft(ws.id, ws.general, root, { text: '', mentions: [] }), true);
  assert.equal(again.store.getDraft(ws.id, ws.general, null), null);
  assert.equal(again.store.getDraft(ws.id, ws.general, root), null);
  assert.equal(await again.api.chatDraft(ws.id, ws.general, null), null);
  assert.equal(again.state().attention, 1);
});
