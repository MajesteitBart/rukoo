'use strict';

// The cache's side of rich messages (rich chat contract 3.1, 3.2 and 4.2): the migration from version 1, reactions and
// link cards applied to cached messages, a history page that already holds the result, readMark from the feed, and the
// files of unsent messages, drafts and downloads. Plain node:sqlite, no server.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { tempDir } = require('./tmp');
const { openStore, SCHEMA_V1, SCHEMA_VERSION, PRAGMAS, reactionChange, filesDir } = require('../src/main/workspaces/store');
const wire = require('../src/main/workspaces/wire');
const sync = require('../src/main/workspaces/sync');

const id = (prefix, label) => `${prefix}_${crypto.createHash('sha256').update(label).digest('base64url').slice(0, 22)}`;
const W = id('w', 'workspace');
const C = id('c', 'general');
const C2 = id('c', 'plans');
const ME = id('u', 'zoe');
const JOEL = id('u', 'joel');
const MILA = id('u', 'mila');
const G = id('g', 'grant');
const F = id('f', 'plan');
const F2 = id('f', 'photo');
const GENERATION = 'AbCdEfGhIjKlMnOpQrStUv';
const local = (label) => crypto.createHash('sha256').update(label).digest('base64url').slice(0, 22);

function fresh(t, file = path.join(tempDir('rukoo-chat-rich-'), 'data', 'chat.db')) {
  const store = openStore(file);
  t.after(() => store.close());
  return store;
}

const feedRoom = (over = {}) => ({
  conversation: C, kind: 'channel', name: 'general', visibility: 'workspace', archived: false,
  participants: null, startedBy: null, closedReason: null,
  grant: G, role: 'member', members: 3, head: 20, floor: 1, lastAt: 1763550000000, read: 4, unread: 6, mentions: 0,
  removed: [], removedMore: false, readMark: 0, ...over
});

const posted = (seq, over = {}) => ({
  seq, id: id('e', `posted ${over.room || C} ${seq}`), kind: 'message.posted', actor: JOEL, at: 1000 + seq, text: `Bericht ${seq}`, mentions: [],
  attachments: [], previews: [], reactions: [], ...over
});
const reacted = (seq, target, emoji, actor, on = true) => ({
  seq, id: id('e', `reaction ${seq}`), kind: on ? 'reaction.added' : 'reaction.removed', actor, at: 1000 + seq, target: target.id, targetSeq: target.seq, emoji
});
const previewed = (seq, target, previews) => ({
  seq, id: id('e', `previewed ${seq}`), kind: 'message.previewed', actor: target.actor, at: 1000 + seq, target: target.id, targetSeq: target.seq, previews
});
const file = { id: F, name: 'plan.pdf', type: 'application/pdf', size: 1234 };
const photo = { id: F2, name: 'foto.png', type: 'image/png', size: 99, width: 640, height: 480 };
const card = (over = {}) => ({ url: 'https://example.com/a', title: 'A page', description: 'About it', site: 'example.com', image: null, video: false, ...over });

function withRoom(store, room = feedRoom()) {
  if (!store.getWs(W)) store.insertWs({ id: W, name: 'Rukoo team', role: 'owner', me: ME });
  return store.upsertRoom(W, room);
}

const reactionsOf = (store, seq) => wire.toRenderer(store.eventAt(W, C, seq)).reactions;

// ---- the migration (rich contract 4.2) ----

// A version 1 cache as the desktop chat PR wrote it, with a room, a message, an unsent message and a draft.
function versionOne(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  db.exec(SCHEMA_V1);
  db.exec(`INSERT INTO meta (key, value) VALUES ('schema', '1'), ('session', 'tag')`);
  db.prepare(`INSERT INTO ws (id, name, role, me) VALUES (?, 'Old', 'member', ?)`).run(W, ME);
  db.prepare(
    `INSERT INTO room (ws, id, kind, name, visibility, archived, grantId, members, head, floor, read, readLocal, readSent, unread, mentions, lo, hi)
     VALUES (?, ?, 'channel', 'general', 'workspace', 0, ?, 2, 3, 1, 2, 3, 2, 1, 0, 3, 3)`
  ).run(W, C, G);
  db.prepare(`INSERT INTO event (ws, room, seq, id, kind, actor, at, text, mentions) VALUES (?, ?, 3, ?, 'message.posted', ?, 3, 'Hoi', '[]')`).run(W, C, posted(3).id, JOEL);
  db.prepare(
    `INSERT INTO outbox (local, ws, room, actor, grantId, generation, text, mentions, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, 'unsent', '[]', 'queued', 1)`
  ).run(local('one'), W, C, ME, G, GENERATION);
  db.prepare(`INSERT INTO draft (ws, room, root, text, mentions, at) VALUES (?, ?, '', 'a draft', '[]', 1)`).run(W, C);
  db.close();
}

test('a version 1 cache migrates in place and keeps its rows', (t) => {
  const file = path.join(tempDir('rukoo-chat-migrate-'), 'data', 'chat.db');
  versionOne(file);
  const store = fresh(t, file);
  assert.equal(store.getMeta('schema'), String(SCHEMA_VERSION));
  assert.equal(store.getMeta('session'), 'tag');
  assert.equal(store.lostUnsent, 0);
  const room = store.getRoom(W, C);
  assert.deepEqual([room.readLocal, room.readMark, room.readPaused], [3, 0, 0]);
  const e = wire.toRenderer(store.eventAt(W, C, 3));
  assert.deepEqual([e.text, e.attachments, e.previews, e.reactions], ['Hoi', [], [], []]);
  const row = store.getOutbox(local('one'));
  assert.equal(row.attachments, '[]');
  assert.deepEqual(wire.toPending(row).attachments, []);
  assert.deepEqual(store.getDraft(W, C, null).attachments, []);
  assert.deepEqual(store.cachedFiles(), []);
  // A migrated file has the tables, indexes and columns a new one has.
  const names = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL ORDER BY name`).all().map((r) => r.name);
  const other = fresh(t);
  assert.deepEqual(names(store.db), names(other.db));
  for (const table of ['event', 'room', 'outbox', 'draft', 'file_cache']) {
    const columns = (db) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => `${c.name} ${c.type} ${c.notnull} ${c.dflt_value}`);
    assert.deepEqual(columns(store.db), columns(other.db), table);
  }
});

test('a version 1 cache whose migration fails for its own sake is replaced, and its unsent messages are counted', (t) => {
  const file = path.join(tempDir('rukoo-chat-migrate-'), 'data', 'chat.db');
  versionOne(file);
  // A column the migration adds is there already, so its ALTER TABLE fails.
  const db = new DatabaseSync(file);
  db.exec('ALTER TABLE event ADD COLUMN reactions TEXT');
  db.close();
  const store = fresh(t, file);
  assert.equal(store.getMeta('schema'), String(SCHEMA_VERSION));
  assert.equal(store.lostUnsent, 1);
  assert.equal(store.getWs(W), null);
});

// ---- reactions and cards (rich contract 3.1) ----

test('reactionChange adds at the end, takes back, drops an empty group and changes nothing twice', () => {
  let list = reactionChange([], '👍', JOEL, true);
  assert.deepEqual(list, [{ emoji: '👍', actors: [JOEL] }]);
  list = reactionChange(list, '🎉', MILA, true);
  list = reactionChange(list, '👍', MILA, true);
  assert.deepEqual(list, [{ emoji: '👍', actors: [JOEL, MILA] }, { emoji: '🎉', actors: [MILA] }]);
  assert.equal(reactionChange(list, '👍', MILA, true), null, 'already there');
  assert.equal(reactionChange(list, '❤️', MILA, false), null, 'not there');
  list = reactionChange(list, '🎉', MILA, false);
  assert.deepEqual(list, [{ emoji: '👍', actors: [JOEL, MILA] }]);
});

test('reaction events change their cached target in the same transaction, once, and only a live message of the room', (t) => {
  const store = fresh(t);
  withRoom(store);
  withRoom(store, feedRoom({ conversation: C2, name: 'plans', grant: id('g', 'plans') }));
  const m = posted(5, { reactions: [{ emoji: '👍', actors: [MILA] }] });
  store.appendEvents(W, C, [posted(4), m]);
  const touched = new Set();
  store.appendEvents(W, C, [reacted(6, m, '👍', JOEL), reacted(7, m, '🎉', JOEL), reacted(8, m, '👍', JOEL)], { touched });
  assert.deepEqual([...touched], [m.id]);
  assert.deepEqual(reactionsOf(store, 5), [{ emoji: '👍', actors: [MILA, JOEL] }, { emoji: '🎉', actors: [JOEL] }]);
  // Stored as events, so the range stays contiguous, and shown as none.
  assert.equal(store.getRoom(W, C).hi, 8);
  assert.deepEqual(wire.toRenderer(store.eventAt(W, C, 6)).data, { target: m.id, targetSeq: 5, emoji: '👍' });
  assert.deepEqual(wire.toRenderer(store.eventAt(W, C, 6)).reactions, []);
  // Taking back, and the last of a group.
  store.appendEvents(W, C, [reacted(9, m, '🎉', JOEL, false), reacted(10, m, '👍', MILA, false)]);
  assert.deepEqual(reactionsOf(store, 5), [{ emoji: '👍', actors: [JOEL] }]);
  // Reactions never count as unread or mentions.
  assert.equal(store.countBadges(W, C, 4, ME).unread, 1);
  // A removed target keeps nothing; one in another room isn't touched.
  store.redact(W, [m.id]);
  const after = new Set();
  store.appendEvents(W, C, [reacted(11, m, '👍', MILA)], { touched: after });
  assert.equal(after.size, 0);
  assert.equal(store.eventAt(W, C, 5).reactions, null);
  const other = posted(1, { room: C2 });
  store.appendEvents(W, C2, [other]);
  store.appendEvents(W, C, [reacted(12, other, '👍', MILA)]);
  assert.deepEqual(wire.toRenderer(store.eventAt(W, C2, 1)).reactions, []);
});

test('a history page carries reactions as they were, and the cached events after it apply on top again', (t) => {
  const store = fresh(t);
  withRoom(store);
  const m = posted(5);
  // The cache holds 10 to 12: two reactions to message 5 and one taken back, which came through the feed.
  store.appendEvents(W, C, [reacted(10, m, '👍', JOEL), reacted(11, m, '🎉', MILA), reacted(12, m, '🎉', MILA, false)]);
  assert.equal(store.getRoom(W, C).lo, 10);
  // A page made before seq 10 lands after them: message 5 without reactions.
  store.prependEvents(W, C, [posted(4), m, posted(6), posted(7), posted(8), posted(9)]);
  assert.deepEqual(reactionsOf(store, 5), [{ emoji: '👍', actors: [JOEL] }]);
  // A page made now holds the result, followed by the events again: the same state.
  store.writeEvents(W, C, [{ ...m, reactions: [{ emoji: '👍', actors: [JOEL] }] }, posted(6), posted(7), posted(8), posted(9), reacted(10, m, '👍', JOEL), reacted(11, m, '🎉', MILA), reacted(12, m, '🎉', MILA, false)]);
  assert.deepEqual(reactionsOf(store, 5), [{ emoji: '👍', actors: [JOEL] }]);
  // Applied twice more, still the same.
  store.writeEvents(W, C, [reacted(10, m, '👍', JOEL), reacted(10, m, '👍', JOEL)]);
  assert.deepEqual(reactionsOf(store, 5), [{ emoji: '👍', actors: [JOEL] }]);
});

test('paging back keeps reactions and cards as of the page head: its own events and older cached ones apply nothing', (t) => {
  const store = fresh(t);
  withRoom(store);
  const m = posted(5);
  const n = posted(8, { previews: [card()] });
  // The cache holds 10 to 12, from the feed: Joel's thumbs up to 5, a removal of Mila's party to 8 and a card update
  // of 8, all before either message was cached, so they changed nothing then.
  store.appendEvents(W, C, [reacted(10, m, '👍', JOEL), reacted(11, n, '🎉', MILA, false), previewed(12, n, [card(), card({ url: 'https://example.org/b' })])]);
  // Joel took his thumbs up back at 14, which the cache doesn't have yet. A page before 10, made at head 15, brings
  // 5 without reactions, 8 as it is now, and the older events: Mila's reaction to 5 at 6 (taken back at 13) and her
  // party to 8 at 9.
  const touched = new Set();
  store.prependEvents(
    W,
    C,
    [posted(4), m, reacted(6, m, '🙌', MILA), posted(7), { ...n, previews: [card(), card({ url: 'https://example.org/b' })] }, reacted(9, n, '🎉', MILA)],
    { touched, asOf: 15 }
  );
  assert.deepEqual(reactionsOf(store, 5), []);
  assert.deepEqual(reactionsOf(store, 8), []);
  assert.equal(wire.toRenderer(store.eventAt(W, C, 8)).previews.length, 2);
  assert.equal(touched.size, 0);
  assert.equal(store.eventAt(W, C, 5).asOf, 15);
  // The feed then brings 13 to 15, which the page already holds, and a new reaction at 16, which applies.
  store.appendEvents(W, C, [reacted(13, m, '🙌', MILA, false), reacted(14, m, '👍', JOEL, false), posted(15)]);
  assert.deepEqual(reactionsOf(store, 5), []);
  store.appendEvents(W, C, [reacted(16, m, '❤️', JOEL)], { touched });
  assert.deepEqual(reactionsOf(store, 5), [{ emoji: '❤️', actors: [JOEL] }]);
  assert.deepEqual([...touched], [m.id]);
  assert.equal(store.eventAt(W, C, 5).asOf, 16);
  // A slower page made at head 12 lands last: message 5 keeps what is newer than it.
  store.writeEvents(W, C, [{ ...m, reactions: [{ emoji: '👍', actors: [JOEL] }] }], { asOf: 12 });
  assert.deepEqual(reactionsOf(store, 5), [{ emoji: '❤️', actors: [JOEL] }]);
  assert.equal(store.eventAt(W, C, 5).asOf, 16);
});

test('message.previewed replaces the target cards, also on top of an older page; a message keeps its files', (t) => {
  const store = fresh(t);
  withRoom(store);
  const m = posted(5, { text: 'Kijk https://example.com/a', attachments: [file, photo] });
  store.appendEvents(W, C, [m]);
  const touched = new Set();
  store.appendEvents(W, C, [previewed(6, m, [card(), card({ url: 'https://example.org/b', image: { ...photo, id: id('f', 'card') } })])], { touched });
  assert.deepEqual([...touched], [m.id]);
  const e = wire.toRenderer(store.eventAt(W, C, 5));
  assert.deepEqual(e.attachments, [file, photo]);
  assert.equal(e.previews.length, 2);
  assert.equal(e.previews[1].image.id, id('f', 'card'));
  // The author removed one.
  store.appendEvents(W, C, [previewed(7, m, [card()])]);
  assert.deepEqual(wire.toRenderer(store.eventAt(W, C, 5)).previews, [card()]);
  // A page with message 5 from before its cards: the cached message.previewed after it wins again.
  store.writeEvents(W, C, [{ ...m, previews: [] }]);
  assert.deepEqual(wire.toRenderer(store.eventAt(W, C, 5)).previews, [card()]);
  // setPreviews is what chatRemovePreview stores.
  assert.equal(store.setPreviews(W, C, m.id, []), true);
  assert.equal(store.setPreviews(W, C, m.id, []), false);
  // A removed message loses its files, cards and reactions with its text.
  store.redact(W, [m.id]);
  const gone = wire.toRenderer(store.eventAt(W, C, 5));
  assert.deepEqual([gone.attachments, gone.previews, gone.reactions, gone.redacted], [[], [], [], true]);
  assert.deepEqual(Object.values(store.get('SELECT attachments, previews, reactions FROM event WHERE seq = 5')), [null, null, null]);
});

test('react() stores the person own reaction the server answered, and changes nothing the second time', (t) => {
  const store = fresh(t);
  withRoom(store);
  const m = posted(5);
  store.appendEvents(W, C, [m]);
  assert.equal(store.react(W, C, m.id, '👍', ME, true), true);
  assert.equal(store.react(W, C, m.id, '👍', ME, true), false);
  // The feed's reaction event for it then changes nothing.
  const touched = new Set();
  store.appendEvents(W, C, [reacted(6, m, '👍', ME)], { touched });
  assert.equal(touched.size, 0);
  assert.deepEqual(reactionsOf(store, 5), [{ emoji: '👍', actors: [ME] }]);
  assert.equal(store.react(W, C, m.id, '👍', ME, false), true);
  assert.deepEqual(reactionsOf(store, 5), []);
  assert.equal(store.react(W, C, id('e', 'not cached'), '👍', ME, true), false);
});

// ---- readMark from the feed (rich contract 3.2) ----

test('a feed row with a higher readMark moves the read positions back and holds reads; an older one changes no read', (t) => {
  const store = fresh(t);
  withRoom(store, feedRoom({ read: 10, unread: 0 }));
  store.setRoomFields(W, C, { readLocal: 15 });
  // Another device marked the room unread: read 6, readMark 1.
  store.upsertRoom(W, feedRoom({ read: 6, unread: 4, readMark: 1 }));
  let r = store.getRoom(W, C);
  assert.deepEqual([r.read, r.readLocal, r.readSent, r.readMark, r.readPaused, r.unread], [6, 6, 6, 1, 1, 4]);
  // notified stays, so marking unread never alerts again.
  assert.equal(r.notified, 0);
  // A row that left the server before that mark: its read and badges stay out, the rest counts.
  store.upsertRoom(W, feedRoom({ read: 10, unread: 0, readMark: 0, name: 'renamed' }));
  r = store.getRoom(W, C);
  assert.deepEqual([r.read, r.readLocal, r.readSent, r.readMark, r.unread, r.name], [6, 6, 6, 1, 4, 'renamed']);
  // The same readMark again is an ordinary row: reads only go forward.
  store.upsertRoom(W, feedRoom({ read: 8, unread: 2, readMark: 1 }));
  r = store.getRoom(W, C);
  assert.deepEqual([r.read, r.readLocal, r.readMark, r.readPaused], [8, 8, 1, 1]);
  store.upsertRoom(W, feedRoom({ read: 7, unread: 3, readMark: 1 }));
  assert.equal(store.getRoom(W, C).readLocal, 8);
  // toRoom gives the renderer readMark and readingPaused.
  const room = wire.toRoom(store.getRoom(W, C));
  assert.deepEqual([room.readMark, room.readingPaused], [1, true]);
});

test('a feed row of a new grant brings its own readMark and ends the hold of the old grant', (t) => {
  const store = fresh(t);
  withRoom(store, feedRoom({ read: 10, unread: 0 }));
  // Marked unread three times under the old grant, and held.
  store.upsertRoom(W, feedRoom({ read: 6, unread: 4, readMark: 3 }));
  assert.deepEqual([store.getRoom(W, C).readMark, store.getRoom(W, C).readPaused], [3, 1]);
  // Left and joined again: the new grant counts from 0, and its read and badges count, though its readMark is lower.
  // What this device read under the old grant goes with it, though it was further.
  const { grantChanged } = store.upsertRoom(W, feedRoom({ grant: id('g', 'again'), read: 2, unread: 9, readMark: 0 }));
  assert.equal(grantChanged, true);
  let r = store.getRoom(W, C);
  assert.deepEqual([r.grantId, r.read, r.readLocal, r.readSent, r.unread, r.readMark, r.readPaused], [id('g', 'again'), 2, 2, 2, 9, 0, 0]);
  // Its first Mark unread is newer than 0, and holds again.
  store.upsertRoom(W, feedRoom({ grant: id('g', 'again'), read: 1, unread: 10, readMark: 1 }));
  r = store.getRoom(W, C);
  assert.deepEqual([r.read, r.readLocal, r.readMark, r.readPaused], [1, 1, 1, 1]);
});

// ---- files of unsent messages, drafts and downloads ----

test('unsent messages and drafts keep their files; the file cache index goes with its room', (t) => {
  const store = fresh(t);
  withRoom(store);
  store.insertOutbox({ local: local('files'), ws: W, room: C, actor: ME, grantId: G, generation: GENERATION, text: '', mentions: [], root: null, attachments: [file, photo], createdAt: 1 });
  assert.deepEqual(wire.toPending(store.getOutbox(local('files'))).attachments, [file, photo]);
  store.putDraft(W, C, null, { text: '', mentions: [], attachments: [{ ...photo, expiresAt: 99 }] });
  assert.deepEqual(store.getDraft(W, C, null).attachments, [{ ...photo, expiresAt: 99 }]);
  const m = posted(5, { attachments: [file], previews: [card({ image: photo })] });
  store.appendEvents(W, C, [m]);
  assert.deepEqual(store.messageWithFile(W, C, F), { message: m.id, file });
  assert.deepEqual(store.messageWithFile(W, C, F2), { message: m.id, file: photo });
  assert.equal(store.messageWithFile(W, C, id('f', 'other')), null);
  store.putCachedFile({ ws: W, room: C, file: F, message: m.id, sha256: 'a'.repeat(64), size: 3, name: 'plan.pdf', type: 'application/pdf', usedAt: 5 });
  store.putCachedFile({ ws: W, room: C, file: F2, message: m.id, sha256: 'b'.repeat(64), size: 4, name: 'foto.png', type: 'image/png', usedAt: 2 });
  assert.deepEqual(store.cachedFiles().map((f) => f.sha256), ['b'.repeat(64), 'a'.repeat(64)], 'least recently used first');
  assert.ok(store.hasCachedSha('a'.repeat(64)));
  assert.equal(store.dropCachedFilesOf(W, [m.id]), 2);
  store.putCachedFile({ ws: W, room: C, file: F, message: null, sha256: 'a'.repeat(64), size: 3, name: 'plan.pdf', type: 'application/pdf' });
  store.deleteRoom(W, C);
  assert.equal(store.getCachedFile(W, F), null, 'the room took its rows');
});

test('a wipe takes the downloaded and staged files with the cache', () => {
  const dir = tempDir('rukoo-chat-rich-');
  const store = openStore(path.join(dir, 'chat.db'));
  fs.mkdirSync(filesDir(store.file), { recursive: true });
  fs.writeFileSync(path.join(filesDir(store.file), 'a'.repeat(64)), 'x');
  fs.mkdirSync(path.join(dir, 'chat-uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chat-uploads', 'staged'), 'y');
  assert.equal(store.wipe(), true);
  assert.equal(fs.existsSync(path.join(dir, 'chat-files')), false);
  assert.equal(fs.existsSync(path.join(dir, 'chat-uploads')), false);
});

// ---- the feed applies inline reaction events to the open room ----

test('inline reaction and card events of the open room come back as updated message IDs', (t) => {
  const store = fresh(t);
  withRoom(store, feedRoom({ head: 5 }));
  const m = posted(5);
  store.appendEvents(W, C, [posted(4), m]);
  store.updateWs(W, { passing: 0, fresh: 0, cursor: 'abc' });
  const svc = { store, revision: () => 0, bumpRevision() {}, now: () => 1, timing: { tombstoneDays: 14 } };
  const page = {
    changes: [feedRoom({ head: 7 })],
    evictions: [],
    inlineEvents: [reacted(6, m, '👍', MILA), previewed(7, m, [card()])],
    directory: { members: false, channels: false, blocks: false },
    next: 'def',
    more: false
  };
  const result = sync.applyPage(svc, W, page, { active: C });
  assert.deepEqual(result.updated, { [C]: [m.id] });
  assert.deepEqual(result.appended.events.map((e) => e.kind), ['reaction.added', 'message.previewed']);
  const e = wire.toRenderer(store.eventAt(W, C, 5));
  assert.deepEqual([e.reactions, e.previews], [[{ emoji: '👍', actors: [MILA] }], [card()]]);
  // A message of a later answer is current to that answer's newest event, though the cached head is further: a
  // reaction after it still applies.
  store.setRoomFields(W, C, { head: 10 });
  const o = posted(8);
  sync.applyPage(svc, W, { ...page, changes: [], inlineEvents: [o], next: 'ghi' }, { active: C });
  assert.equal(store.eventAt(W, C, 8).asOf, 8);
  store.appendEvents(W, C, [reacted(9, o, '👍', JOEL)]);
  assert.deepEqual(reactionsOf(store, 8), [{ emoji: '👍', actors: [JOEL] }]);
});

// ---- alert text (rich contract 3.7) ----

test('alert text drops Markdown markers, keeps mentions whole, and says how many files a message without text sent', () => {
  const { alertText, plainText } = require('../src/main/workspaces/notify');
  assert.equal(plainText('**Bold**, _it_, *em*, ~~gone~~ and `code`'), 'Bold, it, em, gone and code');
  assert.equal(plainText('snake_case_name and 2 * 3 * 4'), 'snake_case_name and 2 * 3 * 4');
  assert.equal(plainText('[the plan](https://example.com/plan) and [x](javascript:alert(1))'), 'the plan and [x](javascript:alert(1))');
  assert.equal(plainText('# Plan\n> quoted\n- item\n1. first\n```js\nconst a = 1;\n```'), 'Plan\nquoted\nitem\n1. first\nconst a = 1;');
  assert.equal(plainText('not \\*bold\\* here'), 'not *bold* here');
  const text = 'Hoi **@Olga_Bakker_**, kijk';
  const start = Buffer.byteLength('Hoi **');
  const end = start + Buffer.byteLength('@Olga_Bakker_');
  assert.equal(alertText(text, [{ actor: MILA, start, end }]), 'Hoi @Olga_Bakker_, kijk');
  assert.equal(alertText('', [], 1), 'Sent a file');
  assert.equal(alertText('', [], 3), 'Sent 3 files');
  assert.equal(alertText('Met tekst', [], 2), 'Met tekst');
});
