'use strict';

// Rich messages against the real account server (test/fixtures/real-server.js), as rich chat contract 4.7 lists for
// the desktop: reactions reaching a second person's cache and a history page that carries them, mark unread with its
// hold and a second device that follows readMark, and files and link cards end to end. Every answer is the real
// server's. The files and link card cases need the helper's R2 binding and its link fixture (rich contract 2.10);
// without them they skip and say so.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startRealServer, realServerAvailable, skipWithoutServer } = require('./fixtures/real-server');
const { attach, chatService, settled, watchCalls, twoPeople, until, sleep } = require('./fixtures/chat-app');
const { tempDir } = require('./tmp');
const { chatApi } = require('../src/main/workspaces/ipc');
const { filesDir } = require('../src/main/workspaces/store');
const { AccountError } = require('../src/main/account/client');
const wire = require('../src/main/workspaces/wire');

let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') server = await startRealServer();
});
test.after(() => server?.close());

const route = (ws, rest = '') => `/v1/workspaces/${ws}${rest}`;
const FAST = { readFlush: 50 };

// Two people in Olga's workspace, Bart's service after its first pass, and the IPC table over it.
async function setup(t, options = {}) {
  const made = await twoPeople(server, { timing: FAST, ...options });
  t.after(() => {
    made.svc.close();
    made.account.close();
  });
  await settled(made.svc, made.ws.id);
  return { ...made, api: chatApi(() => made.svc) };
}

// Another device of a person, with its own profile.
async function device(t, person, ws) {
  const { account, dir } = attach(server, person);
  const svc = chatService(account, dir, { timing: FAST });
  t.after(() => {
    svc.close();
    account.close();
  });
  await settled(svc, ws);
  return { svc, api: chatApi(() => svc), account, dir };
}

// A reaction as another person's app makes it, through the route itself.
async function react(person, ws, c, message, emoji, on) {
  const r = await server.call('POST', route(ws, `/conversations/${c}/messages/${message}/react`), { token: person.token, body: { emoji, on } });
  assert.equal(r.status, 200, r.text);
  return r.body;
}

const ofKind = (svc, kind) => svc.events.filter((e) => e.kind === kind);
const reactionsOf = (svc, ws, c, message) => wire.toRenderer(svc.store.eventById(ws, message)).reactions;

// Until the open room's cache holds seq.
const cached = (svc, ws, c, seq) => until(() => {
  const r = svc.store.getRoom(ws, c);
  return r && r.hi !== null && r.hi >= seq && !svc.history.loads.size;
}, 15000, `seq ${seq} cached`);

// ---- reactions (rich contract 2.4 and 3.1) ----

test('a reaction goes on and off, another person reaction reaches the cache, and a history page carries them', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, api } = await setup(t);
  const m = await server.post(olga, ws.id, ws.general, 'Wie komt er vrijdag?');
  await api.chatOpen(ws.id, ws.general);
  await cached(svc, ws.id, ws.general, m.seq);

  // Bart's own: the cache changes on the answer, and updated says so.
  assert.equal(await api.chatReact(ws.id, ws.general, m.messageId, '👍', true), true);
  assert.deepEqual(reactionsOf(svc, ws.id, ws.general, m.messageId), [{ emoji: '👍', actors: [bartMe.id] }]);
  const mine = ofKind(svc, 'updated').at(-1);
  assert.equal(mine.ws, ws.id);
  assert.equal(mine.conversation, ws.general);
  assert.deepEqual(mine.events.map((e) => [e.id, e.reactions]), [[m.messageId, [{ emoji: '👍', actors: [bartMe.id] }]]]);
  // The same again changes nothing on the server and here.
  assert.equal(await api.chatReact(ws.id, ws.general, m.messageId, '👍', true), true);
  assert.deepEqual(reactionsOf(svc, ws.id, ws.general, m.messageId), [{ emoji: '👍', actors: [bartMe.id] }]);

  // Olga's, through the feed: the reaction event is stored (the range stays contiguous) and changes its target.
  const before = ofKind(svc, 'updated').length;
  // The badges as the feed has them with Olga's message, before any reaction of hers.
  await svc.sync(ws.id, 'test');
  const unread = svc.store.getRoom(ws.id, ws.general).unread;
  assert.equal(unread, 1);
  await react(olga, ws.id, ws.general, m.messageId, '👍', true);
  await react(olga, ws.id, ws.general, m.messageId, '🎉', true);
  await svc.sync(ws.id, 'test');
  await until(() => reactionsOf(svc, ws.id, ws.general, m.messageId).length === 2, 10000, "Olga's reactions");
  assert.deepEqual(reactionsOf(svc, ws.id, ws.general, m.messageId), [{ emoji: '👍', actors: [bartMe.id, ws.me.id] }, { emoji: '🎉', actors: [ws.me.id] }]);
  assert.ok(ofKind(svc, 'updated').length > before);
  const room = svc.store.getRoom(ws.id, ws.general);
  const kinds = svc.store.eventsFrom(ws.id, ws.general, m.seq, 10).map((e) => e.kind);
  assert.deepEqual(kinds, ['message.posted', 'reaction.added', 'reaction.added', 'reaction.added']);
  assert.equal(room.hi, room.head);
  // Reactions never count as unread or mentions.
  assert.equal(room.unread, unread);
  assert.equal(room.mentions, 0);

  // Taking back.
  assert.equal(await api.chatReact(ws.id, ws.general, m.messageId, '👍', false), true);
  assert.deepEqual(reactionsOf(svc, ws.id, ws.general, m.messageId), [{ emoji: '👍', actors: [ws.me.id] }, { emoji: '🎉', actors: [ws.me.id] }]);
  await svc.sync(ws.id, 'test');
  await until(() => svc.store.getRoom(ws.id, ws.general).hi === svc.store.getRoom(ws.id, ws.general).head, 10000, 'the take-back event');

  // A history page carries the message's reactions as they are now, followed by the events again: the same state.
  const want = reactionsOf(svc, ws.id, ws.general, m.messageId);
  svc.store.dropRoomCache(ws.id, ws.general);
  const view = await api.chatOpen(ws.id, ws.general);
  assert.deepEqual(view.events, []);
  await cached(svc, ws.id, ws.general, m.seq);
  assert.deepEqual(reactionsOf(svc, ws.id, ws.general, m.messageId), want);
  const pushed = ofKind(svc, 'events').at(-1).events.find((e) => e.id === m.messageId);
  assert.deepEqual(pushed.reactions, want);

  // Bad input never reaches the server; a removed message refuses.
  await assert.rejects(api.chatReact(ws.id, ws.general, m.messageId, 'x', true), (err) => err.code === 'invalid' && err.field === 'emoji');
  await server.redact(olga, ws.id, ws.general, m.messageId);
  await assert.rejects(api.chatReact(ws.id, ws.general, m.messageId, '👍', true), (err) => err.code === 'not_found');
});

// ---- mark unread (rich contract 2.5 and 3.2) ----

test('mark unread moves the read position back, holds reads until the room opens again, and another device follows', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, svc, api, account } = await setup(t);
  // Every POST /read names the readMark the device knows, so the server can drop one from before a Mark unread.
  const reads = [];
  watchCalls(account, async (method, url, real, body) => {
    if (method === 'POST' && url.endsWith(`/conversations/${ws.general}/read`)) reads.push(body);
  });
  const posts = [];
  for (const text of ['een', 'twee', 'drie']) posts.push(await server.post(olga, ws.id, ws.general, text));
  const other = await device(t, bart, ws.id);
  await api.chatOpen(ws.id, ws.general);
  await cached(svc, ws.id, ws.general, posts[2].seq);
  await api.chatMarkRead(ws.id, ws.general);
  await until(() => svc.store.getRoom(ws.id, ws.general).readSent >= posts[2].seq, 10000, 'the read to reach the server');
  assert.deepEqual(reads.at(-1), { seq: posts[2].seq, readMark: 0 });
  await other.svc.sync(ws.id, 'test');
  assert.equal(other.svc.store.getRoom(ws.id, ws.general).readLocal, posts[2].seq);

  const answer = await api.chatMarkUnread(ws.id, ws.general, posts[1].messageId);
  assert.deepEqual(answer, { read: posts[1].seq - 1 });
  let r = svc.store.getRoom(ws.id, ws.general);
  assert.deepEqual([r.read, r.readLocal, r.readSent, r.readMark, r.readPaused], [posts[1].seq - 1, posts[1].seq - 1, posts[1].seq - 1, 1, 1]);
  assert.equal(r.unread, 2, 'counted again from the cache');
  const shown = ofKind(svc, 'rooms').flatMap((e) => e.rooms).filter((x) => x.id === ws.general).at(-1);
  await until(() => {
    const x = ofKind(svc, 'rooms').flatMap((e) => e.rooms).filter((y) => y.id === ws.general).at(-1);
    return x && x.readingPaused && x.read === posts[1].seq - 1 && x.readMark === 1;
  }, 5000, 'the rooms event');
  assert.ok(shown);

  // While held, the timeline's reports change nothing; the server agrees after a sync.
  await api.chatRead(ws.id, ws.general, posts[2].seq);
  await sleep(150);
  assert.equal(svc.store.getRoom(ws.id, ws.general).readLocal, posts[1].seq - 1);
  await svc.sync(ws.id, 'test');
  r = svc.store.getRoom(ws.id, ws.general);
  assert.deepEqual([r.read, r.readLocal, r.readMark, r.unread], [posts[1].seq - 1, posts[1].seq - 1, 1, 2]);

  // The other device follows the feed's readMark: read positions back, and its reads held too. notified stays.
  const notified = other.svc.store.getRoom(ws.id, ws.general).notified;
  await other.svc.sync(ws.id, 'test');
  const o = other.svc.store.getRoom(ws.id, ws.general);
  assert.deepEqual([o.read, o.readLocal, o.readSent, o.readMark, o.readPaused, o.unread], [posts[1].seq - 1, posts[1].seq - 1, posts[1].seq - 1, 1, 1, 2]);
  assert.equal(o.notified, notified);
  assert.equal(other.svc.notices.length, 0, 'marking unread never alerts again');

  // Opening the room again ends the hold; reading then goes through.
  await api.chatClose();
  const view = await api.chatOpen(ws.id, ws.general);
  assert.equal(view.room.readingPaused, false);
  assert.equal(view.readAtOpen, posts[1].seq - 1);
  await api.chatRead(ws.id, ws.general, posts[2].seq);
  await until(() => svc.store.getRoom(ws.id, ws.general).readSent === posts[2].seq, 10000, 'the read after opening again');
  assert.deepEqual(reads.at(-1), { seq: posts[2].seq, readMark: 1 });

  // Mark as read works during a hold, and ends it.
  await api.chatMarkUnread(ws.id, ws.general, posts[2].messageId);
  assert.equal(svc.store.getRoom(ws.id, ws.general).readPaused, 1);
  await api.chatMarkRead(ws.id, ws.general);
  r = svc.store.getRoom(ws.id, ws.general);
  assert.deepEqual([r.readLocal, r.readPaused, r.unread], [posts[2].seq, 0, 0]);
  await until(() => svc.store.getRoom(ws.id, ws.general).readSent === posts[2].seq, 10000, 'Mark as read to reach the server');
  assert.deepEqual(reads.at(-1), { seq: posts[2].seq, readMark: 2 });
  // A read never moves past the target's position back once the other device had read further.
  await assert.rejects(api.chatMarkUnread(ws.id, ws.general, `e_${crypto.randomBytes(16).toString('base64url')}`), (err) => err.code === 'not_found');
});

// ---- files and link cards (rich contract 2.6, 2.7, 3.5 and 4.6), with the helper's R2 binding ----

const helperReady = () => Boolean(server && typeof server.upload === 'function' && typeof server.download === 'function' && typeof server.previewPage === 'function');
function skipWithoutFiles(t) {
  if (skipWithoutServer(t)) return true;
  if (helperReady()) return false;
  t.skip('the real-server helper has no R2 binding and file helpers yet (rich contract 2.10)');
  return true;
}

function png(width, height, extra = 'rest of the picture') {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  return Buffer.concat([b, Buffer.from(extra)]);
}

const stagedFor = (svc, stage) => until(() => {
  const e = svc.files.staged.get(stage);
  return e && ['ready', 'failed'].includes(e.state) && svc.files.view(e);
}, 20000, `stage ${stage}`);

test('an image and a PDF are staged, uploaded with progress and sent; Olga downloads them byte for byte', async (t) => {
  if (skipWithoutFiles(t)) return;
  const { olga, ws, svc, api, dir } = await setup(t);
  const files = tempDir('rukoo-chat-attach-');
  const image = png(320, 200, crypto.randomBytes(256 * 1024).toString('hex'));
  const pdf = Buffer.from(`%PDF-1.7 ${'plan '.repeat(1000)}`);
  fs.writeFileSync(path.join(files, 'foto.png'), image);
  fs.writeFileSync(path.join(files, 'plan.pdf'), pdf);
  svc.host = { pickFiles: async () => [path.join(files, 'foto.png'), path.join(files, 'plan.pdf')] };
  const picked = await api.chatPickFiles();
  assert.deepEqual(picked.map((p) => p.name), ['foto.png', 'plan.pdf']);
  const a = await api.chatStage(ws.id, ws.general, null, { path: picked[0].path });
  const b = await api.chatStage(ws.id, ws.general, null, { path: picked[1].path });
  const one = await stagedFor(svc, a.stage);
  const two = await stagedFor(svc, b.stage);
  assert.deepEqual([one.state, one.width, one.height, one.type], ['ready', 320, 200, 'image/png']);
  assert.deepEqual([two.state, two.type], ['ready', 'application/pdf']);
  assert.ok(ofKind(svc, 'staged').some((e) => e.staged.some((s) => s.stage === a.stage && s.state === 'uploading')));
  assert.deepEqual((await api.chatStaged(ws.id, ws.general, null)).map((s) => s.state), ['ready', 'ready']);

  // Send is enabled with only files; the outbox row keeps them, and the staged list lets them go.
  const { local, pending } = await api.chatSend(ws.id, ws.general, { text: '', mentions: [], root: null, attachments: [one.file, two.file] });
  assert.deepEqual(pending.attachments.map((f) => f.id), [one.file, two.file]);
  assert.deepEqual(pending.attachments[0], { id: one.file, name: 'foto.png', type: 'image/png', size: image.length, width: 320, height: 200 });
  assert.deepEqual(await api.chatStaged(ws.id, ws.general, null), []);
  const sent = await until(() => ofKind(svc, 'sent').find((e) => e.local === local), 15000, 'sent');
  // Read as Rukoo reads it now, in version 2 of the workspace protocol: a message of files only has no text. A reader
  // of version 1 gets a text standing in for it.
  const read = async (version) => {
    const res = await server.call('GET', route(ws.id, `/conversations/${ws.general}/events?limit=100`), { token: olga.token, headers: { 'rukoo-workspace-version': version } });
    return res.body.events.find((e) => e.id === sent.messageId);
  };
  const message = await read('2');
  assert.deepEqual(message.attachments.map((f) => f.id), [one.file, two.file]);
  assert.equal(message.text, '');
  assert.notEqual((await read('1')).text, '');

  // Olga's download is the same bytes, with the serving headers of contract 2.6.
  const got = await server.download(olga, ws.id, ws.general, one.file);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(got.bytes), image);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');

  // Bart's own download through chatFile: checked, cached by digest, and shown through a link of this session.
  svc.host = { openPath: async () => '', saveDialog: async () => null };
  const { url } = await api.chatFile(ws.id, ws.general, one.file, 'view');
  const hit = svc.files.serve(url);
  assert.equal(hit.type, 'image/png');
  assert.deepEqual(fs.readFileSync(hit.path), image);
  assert.equal(path.basename(hit.path), crypto.createHash('sha256').update(image).digest('hex'));
  assert.equal(await api.chatFile(ws.id, ws.general, two.file, 'save'), false, 'Save cancelled');
  assert.ok(fs.readdirSync(filesDir(svc.store.file)).length >= 2);
  // A wipe (sign-out) takes them with the cache.
  const cache = filesDir(svc.store.file);
  svc.store.wipe();
  svc.store = null;
  assert.equal(fs.existsSync(cache), false);
  assert.ok(dir);
});

test('a file over the limit, Remove, files_unavailable and a lost answer retried once', async (t) => {
  if (skipWithoutFiles(t)) return;
  const { ws, svc, api } = await setup(t);
  const limit = JSON.parse(svc.store.getWs(ws.id).limits).fileBytes;
  assert.ok(Number.isSafeInteger(limit));
  await assert.rejects(
    api.chatStage(ws.id, ws.general, null, { name: 'big.bin', type: 'application/octet-stream', bytes: new Uint8Array(limit + 1) }),
    (err) => err.code === 'too_large' && err.limit === 'fileBytes'
  );
  // Remove cancels the reservation on the server.
  const calls = watchCalls(svc.account);
  const s = await api.chatStage(ws.id, ws.general, null, { name: 'a.txt', type: 'text/plain', bytes: new Uint8Array(Buffer.from('a')) });
  const ready = await stagedFor(svc, s.stage);
  assert.equal(await api.chatUnstage(s.stage), true);
  await until(() => calls.some((c) => c.method === 'DELETE' && c.route.endsWith(`/uploads/${ready.file}`)), 5000, 'the cancel');
  // An upload cancelled behind the tray's back (another device of Bart's, say) is no longer available: the row fails
  // with reason files.
  const b = await api.chatStage(ws.id, ws.general, null, { name: 'b.txt', type: 'text/plain', bytes: new Uint8Array(Buffer.from('b')) });
  const bReady = await stagedFor(svc, b.stage);
  await svc.call(ws.id, 'DELETE', `/conversations/${ws.general}/uploads/${bReady.file}`);
  const { local } = await api.chatSend(ws.id, ws.general, { text: 'met bestand', mentions: [], root: null, attachments: [bReady.file] });
  await until(() => {
    const row = svc.store.getOutbox(local);
    return row && row.state === 'failed' && row.reason === 'files';
  }, 15000, 'failed/files');
  const pending = ofKind(svc, 'pending').at(-1).pending.find((p) => p.local === local);
  assert.deepEqual([pending.state, pending.reason, pending.attachments.length], ['failed', 'files', 1]);
  // Discard: a failed row holds back the later ones of its room.
  await api.chatDiscard(local);

  // A lost answer: the POST reaches the server, the answer doesn't, and the retry with the same bytes gets the first.
  const c = await api.chatStage(ws.id, ws.general, null, { name: 'c.txt', type: 'text/plain', bytes: new Uint8Array(Buffer.from('c')) });
  const cReady = await stagedFor(svc, c.stage);
  let lost = 0;
  const bodies = [];
  watchCalls(svc.account, async (method, url, real, body) => {
    if (method !== 'POST' || !url.endsWith('/messages')) return undefined;
    bodies.push(body);
    if (lost++ === 0) {
      await real();
      throw new AccountError('network', 0, 'socket hang up');
    }
    return undefined;
  });
  const sent = await api.chatSend(ws.id, ws.general, { text: 'nog een', mentions: [], root: null, attachments: [cReady.file] });
  await svc.outbox.kick(ws.id);
  const done = await until(() => ofKind(svc, 'sent').find((e) => e.local === sent.local), 20000, 'the retried send');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[0].attachments, [cReady.file]);
  assert.match(done.messageId, wire.patterns.EVENT_ID);
});

test('link cards arrive through message.previewed, and the author removes one', async (t) => {
  if (skipWithoutFiles(t)) return;
  const { olga, ws, svc, api } = await setup(t);
  const page = await server.previewPage({ title: 'Plan voor vrijdag', description: 'Wat we gaan doen', image: true });
  const m = await server.post(olga, ws.id, ws.general, `Kijk ${page}`);
  await api.chatOpen(ws.id, ws.general);
  await until(async () => {
    await svc.sync(ws.id, 'test');
    return wire.toRenderer(svc.store.eventById(ws.id, m.messageId) || { kind: 'x' }).previews.length === 1;
  }, 20000, 'the card');
  const card = wire.toRenderer(svc.store.eventById(ws.id, m.messageId)).previews[0];
  assert.equal(card.title, 'Plan voor vrijdag');
  assert.equal(card.description, 'Wat we gaan doen');
  // The renderer heard of it: an updated event when the message was on screen before its card came, else the events
  // push that brought both.
  const told = [...ofKind(svc, 'updated'), ...ofKind(svc, 'events')].some((e) => e.events.some((x) => x.id === m.messageId && x.previews.length === 1));
  assert.ok(told);
  // The card's image downloads like a file of the message.
  if (card.image) {
    const { url } = await api.chatFile(ws.id, ws.general, card.image.id, 'view');
    assert.ok(svc.files.serve(url));
  }
  // Only the author removes a card: Bart is refused, Olga's removal reaches Bart's cache.
  await assert.rejects(api.chatRemovePreview(ws.id, ws.general, m.messageId, card.url), (err) => err.code === 'forbidden');
  const r = await server.call('POST', route(ws.id, `/conversations/${ws.general}/messages/${m.messageId}/previews`), { token: olga.token, body: { remove: card.url } });
  assert.equal(r.status, 200, r.text);
  await until(async () => {
    await svc.sync(ws.id, 'test');
    return wire.toRenderer(svc.store.eventById(ws.id, m.messageId)).previews.length === 0;
  }, 20000, 'the card to go');

  // Bart's own link: his chatRemovePreview takes the card off at once, and the server never brings it back.
  const own = await server.previewPage({ title: 'Mijn pagina' });
  const { local } = await api.chatSend(ws.id, ws.general, { text: `Zie ${own}`, mentions: [], root: null });
  const sent = await until(() => ofKind(svc, 'sent').find((e) => e.local === local), 15000, 'sent');
  await until(async () => {
    await svc.sync(ws.id, 'test');
    const row = svc.store.eventById(ws.id, sent.messageId);
    return row && wire.toRenderer(row).previews.length === 1;
  }, 20000, "the card of Bart's link");
  const mine = wire.toRenderer(svc.store.eventById(ws.id, sent.messageId)).previews[0];
  assert.equal(mine.title, 'Mijn pagina');
  const updates = ofKind(svc, 'updated').length;
  assert.equal(await api.chatRemovePreview(ws.id, ws.general, sent.messageId, mine.url), true);
  assert.deepEqual(wire.toRenderer(svc.store.eventById(ws.id, sent.messageId)).previews, []);
  const told2 = ofKind(svc, 'updated').slice(updates).find((e) => e.events.some((x) => x.id === sent.messageId));
  assert.deepEqual(told2.events.find((x) => x.id === sent.messageId).previews, []);
  await svc.sync(ws.id, 'test');
  assert.deepEqual(wire.toRenderer(svc.store.eventById(ws.id, sent.messageId)).previews, []);
});

// ---- alerts (rich contract 3.7) ----

test('a DM with only a file alerts as Sent a file, and one with Markdown without its markers', async (t) => {
  if (skipWithoutFiles(t)) return;
  const { olga, ws, bartMe, svc } = await setup(t);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  const file = await server.upload(olga, ws.id, dm.conversation, { name: 'plan.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.7 plan') });
  const sent = await server.post(olga, ws.id, dm.conversation, '', { attachments: [file.id] });
  await svc.sync(ws.id);
  const alert = svc.notices.find((n) => n.open.conversation === dm.conversation);
  assert.equal(alert.body, 'Olga: Sent a file');
  assert.equal(alert.open.seq, sent.seq);
  await server.post(olga, ws.id, dm.conversation, '**Vrijdag** om _drie_ uur, zie `plan.pdf`');
  await svc.sync(ws.id);
  // The next alert shows what came after the first.
  assert.equal(svc.notices.at(-1).body, 'Olga: Vrijdag om drie uur, zie plan.pdf');
});
