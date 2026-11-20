'use strict';

// Sending and removing messages (src/main/workspaces/outbox.js) through the chat* IPC methods, against the real
// account server (test/fixtures/real-server.js), as contract 8.4 lists for chat-send. Every answer is the real
// server's. Where a case needs an answer to go missing, the request still reaches the server and only its answer is
// replaced by a network error, as a dropped connection does. The one synthetic state is a workspace restore, which the
// server can't do on demand: the cache's stored generation is changed so the next GET / finds a new one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startRealServer, realServerAvailable, skipWithoutServer, mention } = require('./fixtures/real-server');
const { chatService, settled, watchCalls, twoPeople, until, sleep } = require('./fixtures/chat-app');
const wire = require('../src/main/workspaces/wire');
const { AccountError } = require('../src/main/account/client');
const { chatApi } = require('../src/main/workspaces/ipc');

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
// Small enough that two of the largest messages fill a workspace, for the quota refusal.
const WORKSPACE_BYTES = 20000;

let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') {
    server = await startRealServer({ vars: { WORKSPACE_BYTES: String(WORKSPACE_BYTES) } });
  }
});
test.after(() => server?.close());

// Two people, Olga's workspace, and Bart's service after its first pass, with the IPC table over it.
async function setup(t, options = {}) {
  const made = await twoPeople(server, options);
  t.after(() => {
    made.svc.close();
    made.account.close();
  });
  await settled(made.svc, made.ws.id);
  return { ...made, api: chatApi(() => made.svc) };
}

const route = (ws, rest = '') => `/v1/workspaces/${ws}${rest}`;
const ofKind = (svc, kind) => svc.events.filter((e) => e.kind === kind);
const isPost = (method, url) => method === 'POST' && /\/conversations\/c_[A-Za-z0-9_-]{22}\/messages$/.test(url);
const lostAnswer = () => new AccountError('network', 0, 'socket hang up');

// What the history module does when a room opens: the newest page into the cache, so it ends at head.
async function cacheRoom(svc, ws, room) {
  const row = svc.store.getRoom(ws, room);
  const page = wire.checkEvents(await svc.call(ws, 'GET', `/conversations/${room}/events?before=${row.head + 1}&limit=50`));
  svc.store.appendEvents(ws, room, page.events);
  return svc.store.getRoom(ws, room);
}

// The messages with text the server holds in a room, as person reads them.
async function serverMessages(person, ws, room) {
  const r = await server.call('GET', route(ws, `/conversations/${room}/events?limit=100`), { token: person.token });
  assert.equal(r.status, 200, r.text);
  return r.body.events.filter((e) => e.kind === 'message.posted');
}

// The sent event for local, once it went out.
const sentFor = (svc, local, ms = 15000) => until(() => ofKind(svc, 'sent').find((e) => e.local === local), ms, `sent for ${local}`);

// Until the row is in state (and reason, when given).
const rowIs = (svc, local, state, reason, ms = 15000) =>
  until(() => {
    const row = svc.store.getOutbox(local);
    return row && row.state === state && (reason === undefined || row.reason === reason) ? row : null;
  }, ms, `row ${local} ${state}${reason ? `/${reason}` : ''}`);

// The outbox as a second connection reads the file: what is on disk, committed.
function onDisk(file, local) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM outbox WHERE local = ?').get(local);
    return row ? { ...row } : null;
  } finally {
    db.close();
  }
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, err.message);
    return true;
  });
}

test('the row is on disk before the request, and the operation ID with state sending before the POST', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, svc, api } = await setup(t);
  const general = ws.general;
  const before = await cacheRoom(svc, ws.id, general);
  const seen = [];
  watchCalls(svc.account, async (method, url, real, body) => {
    if (!isPost(method, url)) return undefined;
    // Read from the file through another connection while the request waits to leave.
    const local = svc.store.all('SELECT local FROM outbox').map((r) => r.local)[0];
    seen.push({ body, disk: onDisk(svc.file, local) });
    return undefined;
  });
  const { local, pending } = await api.chatSend(ws.id, general, { text: 'Hoi Olga', mentions: [], root: null });
  assert.match(local, wire.patterns.LOCAL_ID);
  assert.equal(pending.local, local);
  assert.equal(pending.conversation, general);
  assert.equal(pending.text, 'Hoi Olga');
  assert.equal(pending.state, 'queued');
  // The first pending event shows the row as written, before any request.
  const first = ofKind(svc, 'pending')[0];
  assert.equal(first.pending[0].local, local);
  assert.equal(first.pending[0].state, 'queued');

  const sent = await sentFor(svc, local);
  assert.equal(seen.length, 1);
  const { body, disk } = seen[0];
  assert.ok(disk, 'the row was on disk when the POST left');
  assert.equal(disk.state, 'sending');
  assert.equal(disk.operationId, body.operationId);
  assert.match(body.operationId, wire.patterns.UUID_V7);
  assert.deepEqual(Object.keys(body).sort(), ['generation', 'grant', 'mentions', 'operationId', 'root', 'text']);
  assert.equal(body.text, 'Hoi Olga');
  assert.equal(body.grant, before.grantId);
  assert.equal(body.generation, svc.store.getWs(ws.id).generation);

  // The ack: the row went, the event follows the cached range and is cached, and the read positions moved to it.
  assert.equal(svc.store.getOutbox(local), null);
  assert.equal(sent.ws, ws.id);
  assert.equal(sent.conversation, general);
  assert.equal(sent.seq, before.hi + 1);
  const room = svc.store.getRoom(ws.id, general);
  assert.equal(room.hi, sent.seq);
  assert.equal(room.head, sent.seq);
  assert.ok(room.read >= sent.seq && room.readLocal >= sent.seq && room.readSent >= sent.seq);
  const cached = svc.store.eventAt(ws.id, general, sent.seq);
  assert.equal(cached.id, sent.messageId);
  assert.equal(cached.text, 'Hoi Olga');
  assert.equal(cached.actor, svc.store.getWs(ws.id).me);
  const last = ofKind(svc, 'pending').at(-1);
  assert.deepEqual(last.pending, []);
  assert.equal(svc.state().unsent, 0);

  const onServer = await serverMessages(bart, ws.id, general);
  assert.equal(onServer.filter((m) => m.text === 'Hoi Olga').length, 1);
  assert.equal(onServer.find((m) => m.text === 'Hoi Olga').id, sent.messageId);
});

test('a write that fails keeps the text with the composer: not_saved, and nothing pending or sent', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, api } = await setup(t);
  const calls = watchCalls(svc.account);
  const store = svc.store;
  // A write SQLite refuses inside the store's own transaction.
  store.insertOutbox = () => store.tx(() => store.run('INSERT INTO outbox (local) VALUES (NULL)'));
  await rejects(api.chatSend(ws.id, ws.general, { text: 'lost?', mentions: [], root: null }), 'not_saved');
  await sleep(50);
  assert.equal(store.countUnsent(), 0);
  assert.equal(ofKind(svc, 'pending').length, 0);
  assert.equal(calls.filter((c) => isPost(c.method, c.route)).length, 0);
});

test('a lost answer after stop() is retried with the same ID and bytes and posts once', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, svc, api } = await setup(t, { timing: { sendBackoff: [200, 400, 800] } });
  t.after(() => server.start());
  const bodies = [];
  let committed = null;
  watchCalls(svc.account, async (method, url, real, body) => {
    if (!isPost(method, url)) return undefined;
    bodies.push(JSON.stringify(body));
    if (committed) return undefined;
    // The server commits the message, then goes away before its answer arrives.
    committed = await real();
    await server.stop();
    throw lostAnswer();
  });
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'once only', mentions: [], root: null });
  const waiting = await rowIs(svc, local, 'queued');
  assert.equal(waiting.attempts >= 1, true);
  assert.equal(waiting.operationId, committed.operationId);
  // While the server is away the retries fail as well, with the same ID.
  await until(() => bodies.length >= 2, 10000, 'a retry while the server is stopped');
  assert.equal(svc.store.getOutbox(local).operationId, committed.operationId);
  await server.start();
  svc.nudge('resume');
  const sent = await sentFor(svc, local);
  assert.equal(sent.messageId, committed.messageId);
  assert.equal(sent.seq, committed.seq);
  assert.ok(bodies.length >= 3);
  assert.equal(new Set(bodies).size, 1, 'every attempt sent the same bytes');
  const onServer = await serverMessages(bart, ws.id, ws.general);
  assert.equal(onServer.filter((m) => m.text === 'once only').length, 1);
});

test('network failures back off 2, 5, 15, 30, 60 s and then every 60 s; a kick retries at once', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, svc, api } = await setup(t);
  // The connection refused before the request reaches the server, as long as down is set.
  let down = true;
  const ids = [];
  watchCalls(svc.account, async (method, url, real, body) => {
    if (!isPost(method, url)) return undefined;
    ids.push(body.operationId);
    if (down) throw new AccountError('network', 0, 'connect ECONNREFUSED');
    return undefined;
  });
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'through a bad connection', mentions: [], root: null });
  const waits = [];
  for (let attempt = 1; attempt <= 7; attempt++) {
    const row = await until(() => {
      const r = svc.store.getOutbox(local);
      return r && r.state === 'queued' && r.attempts === attempt ? r : null;
    }, 10000, `failure ${attempt}`);
    waits.push(row.nextAt - svc.now());
    assert.equal(ofKind(svc, 'pending').at(-1).pending[0].state, 'queued');
    // Focus, resume, a wake or an opened socket: at once.
    if (attempt < 7) svc.outbox.kick(ws.id);
  }
  const expected = [2000, 5000, 15000, 30000, 60000, 60000, 60000];
  waits.forEach((ms, i) => assert.ok(ms <= expected[i] && ms > expected[i] - 1000, `wait ${i + 1}: ${ms} ms, about ${expected[i]}`));
  assert.equal(new Set(ids).size, 1, 'the same ID every time');
  down = false;
  svc.nudge('resume');
  await sentFor(svc, local);
  assert.equal((await serverMessages(bart, ws.id, ws.general)).filter((m) => m.text === 'through a bad connection').length, 1);
});

test('SEM_CHAT_RETRY_DELAY holds the first retry until that long after the workspace answers again', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, api } = await setup(t, { timing: { sendBackoff: [100], retryDelay: 1500 } });
  let down = true;
  const posts = [];
  watchCalls(svc.account, async (method, url) => {
    if (!isPost(method, url)) return undefined;
    posts.push(Date.now());
    if (down) throw new AccountError('network', 0, 'connect ECONNREFUSED');
    return undefined;
  });
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'held a moment', mentions: [], root: null });
  await rowIs(svc, local, 'queued');
  await until(() => posts.length === 1 && svc.store.getOutbox(local).attempts === 1, 10000, 'the failure');
  down = false;
  // The backoff alone would retry after 100 ms; nothing has answered from the workspace since the failure.
  await sleep(500);
  assert.equal(posts.length, 1);
  // A run reaches the workspace again: the retry follows retryDelay later.
  await svc.sync(ws.id);
  const back = Date.now();
  await sentFor(svc, local);
  assert.equal(posts.length, 2);
  assert.ok(posts[1] - back >= 1300, `held ${posts[1] - back} ms`);
});

test('a new service on the same file resumes a queued send and one a quit left sending, in order', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, account, dir, svc, api } = await setup(t, { timing: { sendBackoff: [60000] } });
  t.after(() => server.start());
  await server.stop();
  const one = await api.chatSend(ws.id, ws.general, { text: 'first, written offline', mentions: [], root: null });
  await rowIs(svc, one.local, 'queued');
  const two = await api.chatSend(ws.id, ws.general, { text: 'second, written offline', mentions: [], root: null });
  await until(() => svc.store.getOutbox(one.local).attempts >= 1, 10000, 'the first attempt to fail');
  // As if Rukoo quit while the first one's POST was on its way.
  const operationId = svc.store.getOutbox(one.local).operationId;
  assert.match(operationId, wire.patterns.UUID_V7);
  svc.store.updateOutbox(one.local, { state: 'sending' });
  assert.equal(svc.store.getOutbox(two.local).operationId, null, 'the second waited behind the first');
  svc.close();
  await server.start();

  const bodies = [];
  watchCalls(account, async (method, url, real, body) => {
    if (isPost(method, url)) bodies.push(body);
    return undefined;
  });
  const again = chatService(account, dir);
  t.after(() => again.close());
  assert.equal(again.state().unsent, 2);
  const a = await sentFor(again, one.local);
  const b = await sentFor(again, two.local);
  assert.equal(bodies[0].operationId, operationId, 'the row left sending went with its ID');
  assert.ok(a.seq < b.seq, 'in the order they were written');
  assert.equal(again.store.countUnsent(), 0);
  const texts = (await serverMessages(bart, ws.id, ws.general)).map((m) => m.text);
  assert.deepEqual(texts.filter((x) => /written offline/.test(x)), ['first, written offline', 'second, written offline']);
});

test('stale_grant holds, a held row holds back only its room, and Send keeps the ID', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc, api } = await setup(t);
  const project = await server.seedChannel(olga, ws.id, { name: 'project', members: [bartMe.id] });
  await svc.sync(ws.id);
  const oldGrant = svc.store.getRoom(ws.id, project.id).grantId;
  // The first POST to project waits until Bart left and rejoined on another device.
  const gate = {};
  gate.open = new Promise((resolve) => (gate.release = resolve));
  let hold = true;
  const bodies = [];
  watchCalls(svc.account, async (method, url, real, body) => {
    if (!isPost(method, url) || !url.includes(project.id)) return undefined;
    bodies.push(body);
    if (!hold) return undefined;
    hold = false;
    gate.waiting = true;
    await gate.open;
    return real();
  });
  const held = await api.chatSend(ws.id, project.id, { text: 'written before I left', mentions: [], root: null });
  await until(() => gate.waiting, 10000, 'the POST to wait');
  let r = await server.call('DELETE', route(ws.id, `/channels/${project.id}/members/me`), { token: bart.token });
  assert.equal(r.status, 204, r.text);
  r = await server.call('POST', route(ws.id, `/channels/${project.id}/join`), { token: bart.token });
  assert.equal(r.status, 200, r.text);
  gate.release();
  const row = await rowIs(svc, held.local, 'held', 'stale_grant');
  const operationId = row.operationId;
  assert.equal(row.grantId, oldGrant);
  let pending = ofKind(svc, 'pending').filter((e) => e.conversation === project.id).at(-1).pending;
  assert.deepEqual(pending.map((p) => [p.state, p.reason]), [['held', 'stale_grant']]);

  // A later message in project, written once the feed brought the new grant, waits behind it; one in general goes.
  await svc.sync(ws.id);
  assert.notEqual(svc.store.getRoom(ws.id, project.id).grantId, oldGrant);
  assert.equal(svc.store.getOutbox(held.local).state, 'held', 'the new grant leaves the held row as it is');
  const later =await api.chatSend(ws.id, project.id, { text: 'and this one', mentions: [], root: null });
  assert.equal(later.pending.state, 'waiting');
  const elsewhere = await api.chatSend(ws.id, ws.general, { text: 'meanwhile in general', mentions: [], root: null });
  await sentFor(svc, elsewhere.local);
  await sleep(100);
  assert.equal(bodies.length, 1, 'nothing more went to project');
  assert.equal(svc.store.getOutbox(later.local).state, 'queued');
  assert.equal(svc.store.getOutbox(later.local).operationId, null);
  assert.equal(svc.state().unsent, 2);

  // A mode that doesn't fit the row is refused.
  await rejects(api.chatResend(held.local, { mode: 'retry' }), 'invalid');
  // Send: the room's new grant from the feed, the same operation ID.
  const resent = await api.chatResend(held.local, { mode: 'send' });
  assert.equal(resent.pending.local, held.local);
  const sent = await sentFor(svc, held.local);
  await sentFor(svc, later.local);
  const resentBody = bodies.find((b, i) => i > 0 && b.text === 'written before I left');
  assert.equal(resentBody.operationId, operationId);
  assert.notEqual(resentBody.grant, oldGrant);
  assert.equal(resentBody.grant, svc.store.getRoom(ws.id, project.id).grantId);
  const op = await server.call('GET', route(ws.id, `/conversations/${project.id}/operations/${operationId}`), { token: bart.token });
  assert.equal(op.status, 200);
  assert.equal(op.body.messageId, sent.messageId);
  const texts = (await serverMessages(bart, ws.id, project.id)).map((m) => m.text);
  assert.deepEqual(texts, ['written before I left', 'and this one']);
  pending = ofKind(svc, 'pending').filter((e) => e.conversation === project.id).at(-1).pending;
  assert.deepEqual(pending, []);
});

test('submission_expired resolves through the lookup to held/unknown, and Send again takes a new ID', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, svc, api } = await setup(t);
  // A clock that says the message was written 31 days ago, longer than the server accepts.
  svc.store.setMeta('clockOffset', String(-31 * DAY));
  svc.store.setMeta('clockAt', String(svc.now()));
  const calls = watchCalls(svc.account);
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'from long ago', mentions: [], root: null });
  const row = await rowIs(svc, local, 'held', 'unknown');
  const oldId = row.operationId;
  const routes = calls.map((c) => `${c.method} ${c.route.replace(/\?.*$/, '')}`);
  const post = routes.indexOf(`POST ${route(ws.id, `/conversations/${ws.general}/messages`)}`);
  const lookup = routes.indexOf(`GET ${route(ws.id, `/conversations/${ws.general}/operations/${oldId}`)}`);
  assert.ok(post >= 0 && lookup > post, 'the refused POST, then the lookup');
  const pending = ofKind(svc, 'pending').at(-1).pending;
  assert.deepEqual(pending.map((p) => [p.state, p.reason]), [['held', 'unknown']]);

  // The person said to send it again: the clock is measured again and a new ID is made.
  svc.store.deleteMeta('clockAt');
  await api.chatResend(local, { mode: 'send' });
  const sent = await sentFor(svc, local);
  const op = await server.call('GET', route(ws.id, `/conversations/${ws.general}/operations/${oldId}`), { token: bart.token });
  assert.equal(op.status, 404, 'the old ID never committed');
  const texts = (await serverMessages(bart, ws.id, ws.general)).filter((m) => m.text === 'from long ago');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].id, sent.messageId);
});

test('Start over and a generation change resolve unsent messages through the lookup', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc, api } = await setup(t, { timing: { sendBackoff: [600000] } });
  const other = await server.seedChannel(olga, ws.id, { name: 'other', members: [bartMe.id] });
  await svc.sync(ws.id);
  // Answers go missing: the first kind after the server committed the message, the second before it got there.
  let mode = 'after';
  const committed = [];
  const calls = watchCalls(svc.account, async (method, url, real) => {
    if (!isPost(method, url) || !mode) return undefined;
    if (mode === 'after') committed.push(await real());
    throw lostAnswer();
  });

  // Start over: every unsent message of the workspace is looked up before anything is sent again.
  const one = await api.chatSend(ws.id, ws.general, { text: 'arrived before Start over', mentions: [], root: null });
  await until(() => svc.store.getOutbox(one.local)?.attempts === 1, 10000, 'the lost answer');
  mode = null;
  const postsBefore = calls.filter((c) => isPost(c.method, c.route)).length;
  await api.chatReload(ws.id);
  const a = await sentFor(svc, one.local);
  assert.equal(a.messageId, committed[0].messageId);
  assert.ok(calls.some((c) => c.route.endsWith(`/operations/${committed[0].operationId}`)));
  assert.equal(calls.filter((c) => isPost(c.method, c.route)).length, postsBefore, 'nothing was posted again');
  await settled(svc, ws.id);

  // A restore, as GET / reports it: the cache's generation is the old one, and so is the generation the unsent
  // messages were written under.
  mode = 'after';
  const two = await api.chatSend(ws.id, ws.general, { text: 'arrived before the restore', mentions: [], root: null });
  await until(() => svc.store.getOutbox(two.local)?.attempts === 1, 10000, 'the second lost answer');
  mode = 'before';
  // In another room: a queued row holds back the later rows of its own.
  const three = await api.chatSend(ws.id, other.id, { text: 'never arrived', mentions: [], root: null });
  await until(() => svc.store.getOutbox(three.local)?.attempts === 1, 10000, 'the third lost answer');
  mode = null;
  const old = 'G'.repeat(22);
  svc.store.updateWs(ws.id, { generation: old });
  svc.store.run('UPDATE outbox SET generation = ?', old);
  await svc.details(ws.id);
  const b = await sentFor(svc, two.local);
  assert.equal(b.messageId, committed[1].messageId);
  const unknown = await rowIs(svc, three.local, 'held', 'unknown');
  assert.equal(unknown.generation, old);
  // Send again takes the current generation and a new ID.
  await api.chatResend(three.local, { mode: 'send' });
  await sentFor(svc, three.local);
  const texts = [...(await serverMessages(bart, ws.id, ws.general)), ...(await serverMessages(bart, ws.id, other.id))].map((m) => m.text);
  for (const text of ['arrived before Start over', 'arrived before the restore', 'never arrived']) {
    assert.equal(texts.filter((x) => x === text).length, 1, text);
  }
});

test('stale_generation looks the message up instead of sending it again', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, api } = await setup(t);
  // The row says it was written in a life of the workspace the server no longer has.
  const old = 'G'.repeat(22);
  const store = svc.store;
  const insert = store.insertOutbox.bind(store);
  store.insertOutbox = (row) => insert({ ...row, generation: old });
  const calls = watchCalls(svc.account);
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'written before a restore', mentions: [], root: null });
  const row = await rowIs(svc, local, 'held', 'unknown');
  const routes = calls.map((c) => `${c.method} ${c.route.replace(/\?.*$/, '')}`);
  const post = routes.indexOf(`POST ${route(ws.id, `/conversations/${ws.general}/messages`)}`);
  const details = routes.indexOf(`GET ${route(ws.id)}`, post);
  const lookup = routes.indexOf(`GET ${route(ws.id, `/conversations/${ws.general}/operations/${row.operationId}`)}`);
  assert.ok(post >= 0 && details > post && lookup > details, 'the POST, GET / and then the lookup');
  assert.equal(calls.filter((c) => isPost(c.method, c.route)).length, 1);
});

test('archived, quota and the mentions refusal, with Retry and Send without mentions', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc, api } = await setup(t);
  const old = await server.seedChannel(olga, ws.id, { name: 'old', members: [bartMe.id] });
  const solo = await server.seedChannel(bart, ws.id, { name: 'solo' });
  await svc.sync(ws.id);

  // archived: the channel was archived after the cache last saw it.
  let r = await server.call('PATCH', route(ws.id, `/channels/${old.id}`), { token: olga.token, body: { archived: true } });
  assert.equal(r.status, 200, r.text);
  const archived = await api.chatSend(ws.id, old.id, { text: 'too late', mentions: [], root: null });
  await rowIs(svc, archived.local, 'failed', 'archived');
  await rejects(api.chatResend(archived.local, { mode: 'send' }), 'invalid');
  assert.equal(await api.chatDiscard(archived.local), true);
  assert.equal(svc.store.getOutbox(archived.local), null);
  assert.deepEqual(ofKind(svc, 'pending').filter((e) => e.conversation === old.id).at(-1).pending, []);
  // Once the feed says so, the app refuses before writing anything.
  await svc.sync(ws.id);
  await rejects(api.chatSend(ws.id, old.id, { text: 'still too late', mentions: [], root: null }), 'archived');

  // mentions: Olga isn't in solo.
  const text = 'Look @Olga';
  const mentions = [mention(text, '@Olga', ws.me.id)];
  const mentioned = await api.chatSend(ws.id, solo.id, { text, mentions, root: null });
  const refused = await rowIs(svc, mentioned.local, 'failed', 'mentions');
  await api.chatResend(mentioned.local, { mode: 'withoutMentions' });
  await sentFor(svc, mentioned.local);
  const inSolo = await serverMessages(bart, ws.id, solo.id);
  assert.equal(inSolo.length, 1);
  assert.equal(inSolo[0].text, text);
  assert.deepEqual(inSolo[0].mentions || [], []);
  const op = await server.call('GET', route(ws.id, `/conversations/${solo.id}/operations/${refused.operationId}`), { token: bart.token });
  assert.equal(op.status, 404, 'Send without mentions made a new ID');

  // quota: two of the largest messages don't fit in this server's workspaces.
  const big = (c) => c.repeat(wire.limits.TEXT_BYTES);
  const fits = await api.chatSend(ws.id, ws.general, { text: big('a'), mentions: [], root: null });
  const first = await sentFor(svc, fits.local);
  const full = await api.chatSend(ws.id, ws.general, { text: big('b'), mentions: [], root: null });
  const quota = await rowIs(svc, full.local, 'failed', 'quota');
  // Removing the first makes room; Retry sends the same ID.
  await api.chatRedact(ws.id, ws.general, first.messageId);
  const bodies = [];
  watchCalls(svc.account, async (method, url, real, body) => {
    if (isPost(method, url)) bodies.push(body);
    return undefined;
  });
  await api.chatResend(full.local, { mode: 'retry' });
  await sentFor(svc, full.local);
  assert.equal(bodies[0].operationId, quota.operationId);
});

test('429 holds the message for Retry-After, and a kick does not send it sooner', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, api } = await setup(t);
  // The first post is refused with 429 and Retry-After, as when Bart's send lane is used up from another device. The
  // test makes that answer itself: on a slow machine a lane drained beforehand refills before the first try.
  const statuses = [];
  let refused = false;
  watchCalls(svc.account, async (method, url, real) => {
    if (!isPost(method, url)) return undefined;
    if (!refused) {
      refused = true;
      statuses.push(429);
      throw new AccountError('rate_limited', 429, 'Too many requests.', { retryAfter: 1, scope: 'workspace' });
    }
    try {
      const out = await real();
      statuses.push(200);
      return out;
    } catch (err) {
      statuses.push(err.status);
      throw err;
    }
  });
  const at = svc.now();
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'after the wait', mentions: [], root: null });
  await until(() => statuses.length >= 1, 10000, 'the first answer');
  assert.equal(statuses[0], 429);
  const row = await rowIs(svc, local, 'queued');
  assert.ok(row.nextAt - at >= 900, `waits Retry-After (${row.nextAt - at} ms)`);
  assert.equal(row.attempts, 0);
  svc.outbox.kick(ws.id);
  assert.equal(svc.store.getOutbox(local).nextAt, row.nextAt, 'a kick keeps Retry-After');
  const sent = await sentFor(svc, local, 20000);
  assert.ok(svc.now() >= row.nextAt);
  assert.equal(statuses.at(-1), 200);
  assert.ok(sent.messageId);
});

for (const [name, skew] of [
  ['ahead', 10 * MINUTE],
  ['behind', -10 * MINUTE]
]) {
  test(`a computer clock ten minutes ${name} still makes an accepted operation ID`, async (t) => {
    if (skipWithoutServer(t)) return;
    const now = () => Date.now() + skew;
    const { bart, ws, svc, api } = await setup(t, { now });
    const bodies = [];
    watchCalls(svc.account, async (method, url, real, body) => {
      if (isPost(method, url)) bodies.push(body);
      return undefined;
    });
    const { local } = await api.chatSend(ws.id, ws.general, { text: `clock ${name}`, mentions: [], root: null });
    await sentFor(svc, local);
    assert.equal(bodies.length, 1);
    const ms = parseInt(bodies[0].operationId.replace(/-/g, '').slice(0, 12), 16);
    assert.ok(Math.abs(ms - Date.now()) < MINUTE, 'the ID carries the server time');
    const op = await server.call('GET', route(ws.id, `/conversations/${ws.general}/operations/${bodies[0].operationId}`), { token: bart.token });
    assert.equal(op.status, 200);
  });
}

test('an ID ahead of the server refreshes the clock and goes once more with a new ID', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, svc, api } = await setup(t, { now: () => Date.now() + 10 * MINUTE });
  // A clock measured as matching, which the computer's ten minutes ahead make wrong.
  svc.store.setMeta('clockOffset', '0');
  svc.store.setMeta('clockAt', String(svc.now()));
  const calls = watchCalls(svc.account);
  const bodies = [];
  watchCalls(svc.account, async (method, url, real, body) => {
    if (isPost(method, url)) bodies.push(body);
    return undefined;
  });
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'from the future', mentions: [], root: null });
  await sentFor(svc, local);
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0].operationId, bodies[1].operationId);
  const routes = calls.map((c) => `${c.method} ${c.route.replace(/\?.*$/, '')}`);
  const posts = routes.map((x, i) => (x.startsWith('POST') && x.endsWith('/messages') ? i : -1)).filter((i) => i >= 0);
  assert.ok(routes.slice(posts[0], posts[1]).includes(`GET ${route(ws.id)}`), 'GET / between the two');
  const texts = (await serverMessages(bart, ws.id, ws.general)).filter((m) => m.text === 'from the future');
  assert.equal(texts.length, 1);
});

test('redact marks the cached event removed at once and waits out a 429', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, svc, api } = await setup(t);
  await cacheRoom(svc, ws.id, ws.general);
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'take this back', mentions: [], root: null });
  const sent = await sentFor(svc, local);
  assert.equal(svc.store.eventById(ws.id, sent.messageId).text, 'take this back');

  // The first removal is refused with 429 and Retry-After, as when Bart's control lane is used up from another device:
  // the removal waits and goes again. The test makes that answer itself: on a slow machine a lane drained beforehand
  // refills before the first try.
  const statuses = [];
  let refused = false;
  watchCalls(svc.account, async (method, url, real) => {
    if (!url.endsWith('/redact')) return undefined;
    if (!refused) {
      refused = true;
      statuses.push(429);
      throw new AccountError('rate_limited', 429, 'Too many requests.', { retryAfter: 1, scope: 'workspace' });
    }
    try {
      const out = await real();
      statuses.push(200);
      return out;
    } catch (err) {
      statuses.push(err.status);
      throw err;
    }
  });
  const syncs = [];
  const sync = svc.sync.bind(svc);
  svc.sync = (w, why) => {
    syncs.push(why);
    return sync(w, why);
  };
  assert.equal(await api.chatRedact(ws.id, ws.general, sent.messageId), true);
  assert.equal(statuses[0], 429);
  assert.equal(statuses.at(-1), 200);
  // At once, before any feed page: the text is gone from the cache, and a tombstone keeps it gone.
  const cached = svc.store.eventById(ws.id, sent.messageId);
  assert.equal(cached.redacted, 1);
  assert.equal(cached.text, null);
  assert.equal(cached.mentions, null);
  assert.ok(svc.store.hasTombstone(ws.id, sent.messageId));
  assert.deepEqual(ofKind(svc, 'redacted').at(-1), { kind: 'redacted', ws: ws.id, conversation: ws.general, ids: [sent.messageId] });
  assert.ok(syncs.includes('write'), 'the feed is asked to confirm');
  // Olga sees it removed.
  const theirs = (await serverMessages(olga, ws.id, ws.general)).find((m) => m.id === sent.messageId);
  assert.equal(theirs.redacted, true);
  assert.equal(theirs.text, undefined);

  // Someone else's message: only its author or a channel manager removes it.
  const hers = await server.post(olga, ws.id, ws.general, 'mine to keep');
  await rejects(api.chatRedact(ws.id, ws.general, hers.messageId), 'forbidden');
});

// A gate a watched call waits at until the test releases it.
function gate() {
  const g = {};
  g.wait = new Promise((resolve) => (g.release = resolve));
  g.reached = new Promise((resolve) => (g.reach = resolve));
  return g;
}

test('two Sends of a held/stale_grant row at once post it once, with its operation ID', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, bartMe, ws, svc, api } = await setup(t);
  // Taken out of general and back in on another device: the cache still has the old grant.
  let r = await server.call('DELETE', route(ws.id, `/channels/${ws.general}/members/${bartMe.id}`), { token: olga.token });
  assert.equal(r.status, 204, r.text);
  r = await server.call('POST', route(ws.id, `/channels/${ws.general}/join`), { token: bart.token });
  assert.equal(r.status, 200, r.text);
  const ids = [];
  watchCalls(svc.account, async (method, url, real, body) => {
    if (isPost(method, url)) ids.push(body.operationId);
    return undefined;
  });
  const text = 'confirmed once, sent once';
  const { local } = await api.chatSend(ws.id, ws.general, { text, mentions: [], root: null });
  const held = await rowIs(svc, local, 'held', 'stale_grant');
  // A double click: both wait for the feed's new grant, and only the first may change the row.
  const results = await Promise.all([api.chatResend(local, { mode: 'send' }), api.chatResend(local, { mode: 'send' })]);
  assert.ok(results.every((x) => x.pending && x.pending.local === local));
  await sentFor(svc, local);
  await settled(svc, ws.id);
  assert.ok(ids.length >= 2);
  assert.deepEqual([...new Set(ids)], [held.operationId], 'every POST carried the ID the person confirmed');
  assert.equal((await serverMessages(bart, ws.id, ws.general)).filter((m) => m.text === text).length, 1);
});

test('a POST answer that arrives after a restore marked its row leaves the row to the lookup', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, api } = await setup(t);
  const home = route(ws.id);
  const newGeneration = 'G'.repeat(22);
  const post = gate();
  const calls = watchCalls(svc.account, async (method, url, real, body) => {
    if (isPost(method, url)) {
      // An answer from the old life of the workspace; the restored one never saw this operation.
      post.reach();
      await post.wait;
      return { operationId: body.operationId, messageId: `e_${'A'.repeat(22)}`, seq: svc.store.getRoom(ws.id, ws.general).head + 1 };
    }
    if (method === 'GET' && url === home) {
      const answer = await real();
      return { ...answer, workspace: { ...answer.workspace, generation: newGeneration } };
    }
    return undefined;
  });
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'written before the restore', mentions: [], root: null });
  await post.reached;
  await svc.details(ws.id);
  assert.equal(svc.store.getOutbox(local).reason, 'lookup');
  post.release();
  // The lookup decides: the restored workspace doesn't know the operation.
  const row = await rowIs(svc, local, 'held', 'unknown');
  assert.equal(row.text, 'written before the restore');
  assert.ok(calls.some((c) => c.route.endsWith(`/operations/${row.operationId}`)), 'the lookup ran');
  assert.equal(ofKind(svc, 'sent').filter((e) => e.local === local).length, 0);
});

test('a lookup answer that arrives after a restore leaves the row to a lookup of its own, and the text stays', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, svc, api } = await setup(t, { timing: { sendBackoff: [600000] } });
  const home = route(ws.id);
  const text = 'never reached the restored workspace';
  const head = svc.store.getRoom(ws.id, ws.general).head;
  const lookup = gate();
  let restoredTo = null;
  let held = false;
  const calls = watchCalls(svc.account, async (method, url, real) => {
    // The POST's answer goes missing before the server got it: the message never arrived.
    if (isPost(method, url)) throw lostAnswer();
    if (method === 'GET' && url.includes('/operations/') && !held) {
      held = true;
      lookup.reach();
      await lookup.wait;
      // The workspace's life before the restore had the message, nine events further on.
      return { messageId: `e_${'A'.repeat(22)}`, seq: head + 9, visible: true };
    }
    if (method === 'GET' && url === home && restoredTo) {
      const answer = await real();
      return { ...answer, workspace: { ...answer.workspace, generation: restoredTo } };
    }
    return undefined;
  });
  const { local } = await api.chatSend(ws.id, ws.general, { text, mentions: [], root: null });
  await until(() => svc.store.getOutbox(local)?.attempts === 1, 10000, 'the lost answer');
  // Start over marks the row for a lookup, which goes out and is held.
  await api.chatReload(ws.id);
  await lookup.reached;
  // A restore while the lookup waits: the row stays queued with the same operation ID.
  restoredTo = 'G'.repeat(22);
  await svc.details(ws.id);
  const marked = svc.store.getOutbox(local);
  assert.equal(marked.state, 'queued');
  assert.equal(marked.reason, 'lookup');
  lookup.release();
  // The old answer decides nothing; a new lookup asks the restored workspace, which doesn't know the operation.
  const row = await rowIs(svc, local, 'held', 'unknown');
  assert.equal(row.text, text);
  assert.equal(row.operationId, marked.operationId);
  assert.equal(calls.filter((c) => c.route.endsWith(`/operations/${row.operationId}`)).length, 2, 'looked up again');
  assert.equal(ofKind(svc, 'sent').filter((e) => e.local === local).length, 0);
  assert.ok(svc.store.getRoom(ws.id, ws.general).head < head + 9, "the old life's seq didn't move the room's head");
  assert.equal((await serverMessages(bart, ws.id, ws.general)).filter((m) => m.text === text).length, 0);
});

test('a POST answer that arrives after Start over leaves the row to the lookup, which finds the message', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, svc, api } = await setup(t);
  const post = gate();
  let committed = null;
  const calls = watchCalls(svc.account, async (method, url, real) => {
    if (!isPost(method, url)) return undefined;
    committed = await real();
    post.reach();
    await post.wait;
    return committed;
  });
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'sent before Start over', mentions: [], root: null });
  await post.reached;
  await api.chatReload(ws.id);
  assert.equal(svc.store.getOutbox(local).reason, 'lookup');
  post.release();
  const sent = await sentFor(svc, local);
  assert.equal(sent.messageId, committed.messageId);
  assert.ok(calls.some((c) => c.route.endsWith(`/operations/${committed.operationId}`)), 'the lookup decided');
  assert.equal(svc.store.getOutbox(local), null);
  assert.equal((await serverMessages(bart, ws.id, ws.general)).filter((m) => m.text === 'sent before Start over').length, 1);
});

test('an answer the disk refuses to record is looked up later, and a row left sending is taken up by a kick', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, svc, api } = await setup(t, { timing: { sendBackoff: [60000] } });
  const store = svc.store;
  // The ack's transaction fails: the row's DELETE is refused.
  store.run(`CREATE TEMP TRIGGER no_delete BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'disk trouble'); END`);
  const one = await api.chatSend(ws.id, ws.general, { text: 'committed, not recorded', mentions: [], root: null });
  const waiting = await rowIs(svc, one.local, 'queued', 'lookup');
  assert.equal(svc.hookError.code, 'not_saved');
  assert.match(waiting.operationId, wire.patterns.UUID_V7);
  assert.ok(waiting.nextAt > svc.now(), 'after the backoff');
  store.run('DROP TRIGGER no_delete');
  svc.outbox.kick(ws.id);
  const a = await sentFor(svc, one.local);
  assert.equal(store.getOutbox(one.local), null);

  // The disk refuses the way back to queued as well: the row stays sending until a kick finds it without a send.
  const calls = watchCalls(svc.account, async (method, url, real) => {
    if (!isPost(method, url)) return undefined;
    const answer = await real();
    store.run(`CREATE TEMP TRIGGER no_delete BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'disk trouble'); END`);
    store.run(`CREATE TEMP TRIGGER no_update BEFORE UPDATE ON outbox BEGIN SELECT RAISE(ABORT, 'disk trouble'); END`);
    return answer;
  });
  const hookErrors = svc.hookError;
  const two = await api.chatSend(ws.id, ws.general, { text: 'committed, stuck sending', mentions: [], root: null });
  await until(() => svc.hookError !== hookErrors && svc.hookError?.code === 'not_saved', 10000, 'the refused ack');
  await sleep(50);
  assert.equal(store.getOutbox(two.local).state, 'sending');
  store.run('DROP TRIGGER no_delete');
  store.run('DROP TRIGGER no_update');
  svc.outbox.kick(ws.id);
  const b = await sentFor(svc, two.local);
  assert.ok(calls.some((c) => c.route.includes('/operations/')), 'the orphan was looked up');
  const texts = (await serverMessages(bart, ws.id, ws.general)).map((m) => m.text);
  assert.equal(texts.filter((x) => x === 'committed, not recorded').length, 1);
  assert.equal(texts.filter((x) => x === 'committed, stuck sending').length, 1);
  assert.ok(a.seq < b.seq);
});

test('a 429 Retry-After survives a restart: the new service and its kicks wait it out', async (t) => {
  if (skipWithoutServer(t)) return;
  const { ws, svc, api, account, dir } = await setup(t);
  watchCalls(account, async (method, url) => {
    if (isPost(method, url)) throw new AccountError('rate_limited', 429, 'Wait', { retryAfter: 30 });
    return undefined;
  });
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'rate limited', mentions: [], root: null });
  const row = await until(() => {
    const r = svc.store.getOutbox(local);
    return r && r.state === 'queued' && r.nextAt > svc.now() + 20000 ? r : null;
  }, 10000, 'the 429');
  assert.equal(row.attempts, 0);
  svc.close();
  const posts = [];
  watchCalls(account, async (method, url) => {
    if (isPost(method, url)) posts.push(url);
    return undefined;
  });
  const again = chatService(account, dir);
  t.after(() => again.close());
  await settled(again, ws.id);
  again.outbox.kick(ws.id);
  again.nudge('resume');
  await sleep(300);
  assert.deepEqual(posts, [], 'nothing went before Retry-After');
  assert.equal(again.store.getOutbox(local).nextAt, row.nextAt);
});
