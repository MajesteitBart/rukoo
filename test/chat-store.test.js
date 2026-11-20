'use strict';

// src/main/workspaces/store.js: the team chat cache on node:sqlite. It runs under plain Node with node --test and
// under Electron's Node (ELECTRON_RUN_AS_NODE=1 npx electron test/chat-store.test.js), which is the one the app uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { tempDir } = require('./tmp');
const { openStore, ROOM_CACHE_MAX, SCHEMA_VERSION } = require('../src/main/workspaces/store');
const { ChatError, toRenderer } = require('../src/main/workspaces/wire');

const id = (prefix, label) => `${prefix}_${crypto.createHash('sha256').update(label).digest('base64url').slice(0, 22)}`;
const W = id('w', 'workspace');
const W2 = id('w', 'other workspace');
const C = id('c', 'general');
const C2 = id('c', 'plans');
const ME = id('u', 'zoe');
const JOEL = id('u', 'joel');
const MILA = id('u', 'mila');
const G = id('g', 'grant');
const GENERATION = 'AbCdEfGhIjKlMnOpQrStUv';
const local = (label) => crypto.createHash('sha256').update(label).digest('base64url').slice(0, 22);

function fresh(t, { now } = {}) {
  const file = path.join(tempDir('rukoo-chat-store-'), 'data', 'chat.db');
  const store = openStore(file, now ? { now } : {});
  t.after(() => store.close());
  return store;
}

const feedRoom = (over = {}) => ({
  conversation: C, kind: 'channel', name: 'general', visibility: 'workspace', archived: false,
  participants: null, startedBy: null, closedReason: null,
  grant: G, role: 'member', members: 3, head: 10, floor: 1, lastAt: 1763550000000, read: 4, unread: 6, mentions: 0,
  removed: [], removedMore: false, ...over
});

const posted = (seq, over = {}) => ({ seq, id: id('e', `posted ${over.room || C} ${seq}`), kind: 'message.posted', actor: JOEL, at: 1000 + seq, text: `Bericht ${seq}`, mentions: [], ...over });

function withRoom(store, ws = W, room = feedRoom()) {
  if (!store.getWs(ws)) store.insertWs({ id: ws, name: 'Rukoo team', role: 'owner', me: ME });
  return store.upsertRoom(ws, room);
}

const outboxRow = (label, over = {}) => ({
  local: local(label), ws: W, room: C, actor: ME, grantId: G, generation: GENERATION, text: `Unsent ${label}`, mentions: [], root: null, createdAt: 1, ...over
});

// ---- schema ----

const COLUMNS = {
  meta: ['key', 'value'],
  ws: ['id', 'name', 'role', 'me', 'myName', 'generation', 'keyId', 'limits', 'retention', 'cursor', 'passing', 'fresh', 'state', 'membersStale', 'channelsStale', 'blocksStale', 'membersMore', 'syncedAt', 'activeAt'],
  room: ['ws', 'id', 'kind', 'name', 'visibility', 'archived', 'closedReason', 'participants', 'startedBy', 'grantId', 'role', 'members', 'head', 'floor', 'lastAt', 'read', 'readLocal', 'readSent', 'unread', 'mentions', 'lo', 'hi', 'notified', 'muted', 'readMark', 'readPaused'],
  pass_room: ['ws', 'id', 'row'],
  event: ['ws', 'room', 'seq', 'id', 'kind', 'actor', 'at', 'root', 'text', 'mentions', 'data', 'redacted', 'attachments', 'previews', 'reactions'],
  tombstone: ['ws', 'message', 'at'],
  member: ['ws', 'id', 'kind', 'name', 'role', 'state', 'joinedAt'],
  channel: ['ws', 'id', 'name', 'visibility', 'archived', 'joined', 'role', 'members'],
  block: ['ws', 'member', 'at'],
  outbox: ['local', 'ws', 'room', 'actor', 'grantId', 'generation', 'text', 'mentions', 'root', 'operationId', 'state', 'reason', 'attempts', 'nextAt', 'createdAt', 'attachments'],
  draft: ['ws', 'room', 'root', 'text', 'mentions', 'at', 'attachments'],
  notice: ['ws', 'room', 'message', 'seq'],
  file_cache: ['ws', 'room', 'file', 'message', 'sha256', 'size', 'name', 'type', 'usedAt']
};

test('a new cache has the schema of contract 3.5 with rich chat 4.2, its pragmas and schema version 2', (t) => {
  const store = fresh(t);
  const db = store.db;
  assert.equal(store.getMeta('schema'), '2');
  assert.equal(store.lostUnsent, 0);
  assert.ok(store.quickCheck());
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((r) => r.name);
  assert.deepEqual(tables, Object.keys(COLUMNS).sort());
  for (const [table, columns] of Object.entries(COLUMNS)) {
    assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name), columns, table);
  }
  const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).all().map((r) => r.name);
  assert.deepEqual(indexes, ['event_id', 'event_root', 'file_cache_message', 'file_cache_sha', 'outbox_room']);
  const withoutRowid = (table) => /WITHOUT ROWID\s*$/.test(db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table).sql);
  for (const table of Object.keys(COLUMNS)) assert.equal(withoutRowid(table), table !== 'outbox', `${table} WITHOUT ROWID`);
  const pragma = (name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
  assert.equal(pragma('journal_mode'), 'wal');
  assert.equal(pragma('synchronous'), 1, 'NORMAL');
  assert.equal(pragma('foreign_keys'), 1);
  assert.equal(pragma('secure_delete'), 1);
  assert.equal(pragma('busy_timeout'), 2000);
  // The cascades: rooms and the directory under ws, events, sends, drafts and notices under their room.
  const parent = (table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all().map((f) => `${f.table}:${f.on_delete}`);
  for (const table of ['room', 'pass_room', 'tombstone', 'member', 'channel', 'block']) assert.deepEqual(parent(table), ['ws:CASCADE'], table);
  for (const table of ['event', 'outbox', 'draft', 'notice', 'file_cache']) assert.deepEqual([...new Set(parent(table))], ['room:CASCADE'], table);
  // The CHECKs.
  assert.throws(() => db.prepare(`INSERT INTO ws (id, name, role, state) VALUES ('w', 'n', 'owner', 'stopped')`).run(), /CHECK/);
});

test('rows are upserted, never replaced', () => {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/main/workspaces/store.js'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.doesNotMatch(source, /OR\s+REPLACE/i);
  assert.doesNotMatch(source, /REPLACE\s+INTO/i);
});

// ---- meta and workspaces ----

test('meta keys and workspace rows are written, updated and read back', (t) => {
  const store = fresh(t);
  store.setMeta('selected', W);
  store.setMeta('selected', W2);
  assert.equal(store.getMeta('selected'), W2);
  store.deleteMeta('selected');
  assert.equal(store.getMeta('selected'), null);

  const row = store.insertWs({ id: W, name: 'Rukoo team', role: 'owner' });
  assert.equal(row.passing, 1);
  assert.equal(row.fresh, 1);
  assert.equal(row.state, 'ok');
  assert.equal(row.cursor, null);
  store.updateWs(W, { cursor: 'abc', passing: false, limits: { members: 100 }, generation: GENERATION, notAColumn: 1 });
  // Listing it again changes only its name and role.
  store.insertWs({ id: W, name: 'Renamed', role: 'admin' });
  const after = store.getWs(W);
  assert.equal(after.name, 'Renamed');
  assert.equal(after.role, 'admin');
  assert.equal(after.cursor, 'abc');
  assert.equal(after.passing, 0);
  assert.deepEqual(JSON.parse(after.limits), { members: 100 });
  store.insertWs({ id: W2, name: 'Andere', role: 'guest', me: JOEL });
  assert.deepEqual(store.listWs().map((w) => w.id), [W, W2].sort());
  assert.equal(store.getWs(W2).me, JOEL);
});

// ---- rooms ----

test('a new room comes in uncached at the server read, and a later page never moves local reads back', (t) => {
  const store = fresh(t);
  const first = withRoom(store);
  assert.equal(first.inserted, true);
  assert.equal(first.row.lo, null);
  assert.equal(first.row.hi, null);
  assert.equal(first.row.readLocal, 4);
  assert.equal(first.row.readSent, 4);
  store.setRoomFields(W, C, { readLocal: 8, readSent: 6, muted: true, notified: 9 });
  const again = store.upsertRoom(W, feedRoom({ read: 5, head: 12, name: 'algemeen', unread: 7 }));
  assert.equal(again.inserted, false);
  assert.equal(again.row.readLocal, 8);
  assert.equal(again.row.readSent, 6);
  assert.equal(again.row.read, 5);
  assert.equal(again.row.name, 'algemeen');
  assert.equal(again.row.unread, 7);
  assert.equal(again.row.muted, 1);
  assert.equal(again.row.notified, 9);
  const ahead = store.upsertRoom(W, feedRoom({ read: 11, head: 12 }));
  assert.equal(ahead.row.readLocal, 11);
  assert.equal(ahead.row.readSent, 11);
  // A DM keeps its participants as JSON and its close.
  const dm = store.upsertRoom(W, feedRoom({ conversation: C2, kind: 'dm', name: null, visibility: 'dm', archived: true, participants: [ME, JOEL], startedBy: JOEL, closedReason: 'left' }));
  assert.equal(dm.row.participants, JSON.stringify([ME, JOEL]));
  assert.equal(dm.row.closedReason, 'left');
  assert.equal(dm.row.name, null);
  assert.deepEqual(store.listRooms(W).map((r) => r.id), [C, C2].sort());
});

test('an upsert keeps the room\'s events, sends, drafts and notices; a new grant empties only its cache', (t) => {
  const store = fresh(t);
  withRoom(store);
  store.appendEvents(W, C, [posted(1), posted(2), posted(3)]);
  store.insertOutbox(outboxRow('a'));
  store.putDraft(W, C, null, { text: 'Concept', mentions: [] });
  store.addNotices(W, C, [{ message: posted(3).id, seq: 3 }]);

  const same = store.upsertRoom(W, feedRoom({ head: 11 }));
  assert.equal(same.grantChanged, false);
  assert.equal(store.eventsFrom(W, C, 1, 10).length, 3);
  assert.equal(store.getRoom(W, C).lo, 1);
  assert.equal(store.getRoom(W, C).hi, 3);
  assert.equal(store.outboxForRoom(W, C).length, 1);
  assert.equal(store.getDraft(W, C, null).text, 'Concept');
  assert.equal(store.noticesForRoom(W, C).length, 1);

  const regrant = store.upsertRoom(W, feedRoom({ grant: id('g', 'new grant') }));
  assert.equal(regrant.grantChanged, true);
  assert.equal(store.eventsFrom(W, C, 1, 10).length, 0);
  assert.equal(regrant.row.lo, null);
  assert.equal(regrant.row.hi, null);
  // The send keeps the grant it was written under; the server's stale_grant decides.
  assert.equal(store.outboxForRoom(W, C)[0].grantId, G);
  assert.equal(store.getDraft(W, C, null).text, 'Concept');
  assert.equal(store.noticesForRoom(W, C).length, 1);

  // keepLocal false forgets this device's reads and cache, and keeps mute and alerts.
  store.appendEvents(W, C, [posted(4)]);
  store.setRoomFields(W, C, { readLocal: 9, muted: 1, notified: 4 });
  const reset = store.upsertRoom(W, feedRoom({ grant: id('g', 'new grant'), read: 2 }), { keepLocal: false });
  assert.equal(reset.row.readLocal, 2);
  assert.equal(reset.row.lo, null);
  assert.equal(reset.row.muted, 1);
  assert.equal(reset.row.notified, 4);
  assert.equal(store.outboxForRoom(W, C).length, 1);
});

test('a floor deletes the events below it and moves or empties the range', (t) => {
  const store = fresh(t);
  withRoom(store);
  store.appendEvents(W, C, [1, 2, 3, 4, 5].map((s) => posted(s)));
  const moved = store.upsertRoom(W, feedRoom({ floor: 3 }));
  assert.deepEqual(moved.dropped, [posted(1).id, posted(2).id]);
  assert.deepEqual([moved.row.lo, moved.row.hi], [3, 5]);
  assert.deepEqual(store.eventsFrom(W, C, 0, 10).map((e) => e.seq), [3, 4, 5]);
  const emptied = store.applyFloor(W, C, 7);
  assert.equal(emptied.length, 3);
  assert.deepEqual([store.getRoom(W, C).lo, store.getRoom(W, C).hi], [null, null]);
});

test('deleting a room takes its events, sends, drafts and notices, and counts the sends', (t) => {
  const store = fresh(t);
  withRoom(store);
  withRoom(store, W, feedRoom({ conversation: C2, name: 'plans' }));
  store.appendEvents(W, C, [posted(1), posted(2)]);
  store.appendEvents(W, C2, [posted(1, { room: C2 })]);
  store.insertOutbox(outboxRow('a'));
  store.insertOutbox(outboxRow('b'));
  store.insertOutbox(outboxRow('c', { room: C2 }));
  store.putDraft(W, C, null, { text: 'Main', mentions: [] });
  store.putDraft(W, C, posted(1).id, { text: 'Thread', mentions: [] });
  store.addNotices(W, C, [{ message: posted(2).id, seq: 2 }]);

  assert.equal(store.deleteRoom(W, C), 2);
  assert.equal(store.getRoom(W, C), null);
  const count = (table, room) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ws = ? AND room = ?`).get(W, room).n;
  for (const table of ['event', 'outbox', 'draft', 'notice']) assert.equal(count(table, C), 0, table);
  assert.equal(count('event', C2), 1);
  assert.equal(count('outbox', C2), 1);
  assert.equal(store.deleteRoom(W, C), 0, 'no such room: nothing went, and never a negative count');
});

test('deleting a workspace takes everything under it and leaves the other workspace alone', (t) => {
  const store = fresh(t);
  for (const ws of [W, W2]) {
    withRoom(store, ws);
    store.appendEvents(ws, C, [posted(1)]);
    store.insertOutbox(outboxRow(`send ${ws}`, { ws }));
    store.putDraft(ws, C, null, { text: 'x', mentions: [] });
    store.addNotices(ws, C, [{ message: posted(1).id, seq: 1 }]);
    store.addTombstones(ws, [id('e', 'gone')]);
    store.replaceMembers(ws, [{ id: ME, kind: 'human', name: 'Zoë', role: 'owner', state: 'active', joinedAt: 1 }]);
    store.replaceChannels(ws, [{ id: C, name: 'general', visibility: 'workspace', archived: false, joined: true, role: 'member', members: 1 }]);
    store.replaceBlocks(ws, [{ member: JOEL, at: 1 }]);
    store.putPassRoom(ws, feedRoom());
    store.putCachedFile({ ws, room: C, file: id('f', 'file'), message: posted(1).id, sha256: 'a'.repeat(64), size: 3, name: 'a.txt', type: 'text/plain' });
  }
  assert.equal(store.deleteWs(W), true);
  for (const table of Object.keys(COLUMNS).filter((x) => x !== 'meta')) {
    const column = table === 'ws' ? 'id' : 'ws';
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(W).n, 0, table);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(W2).n, 1, `${table} of the other workspace`);
  }
  assert.equal(store.deleteWs(W), false);
});

// ---- events ----

test('events append and prepend to one range, and read back in order', (t) => {
  const store = fresh(t);
  withRoom(store, W, feedRoom({ head: 5 }));
  const stored = store.appendEvents(W, C, [posted(5), posted(6)]);
  assert.deepEqual(stored.map((e) => e.seq), [5, 6]);
  let room = store.getRoom(W, C);
  assert.deepEqual([room.lo, room.hi, room.head], [5, 6, 6]);
  store.prependEvents(W, C, [posted(3), posted(4)]);
  room = store.getRoom(W, C);
  assert.deepEqual([room.lo, room.hi], [3, 6]);
  assert.deepEqual(store.eventsBefore(W, C, 6, 2).map((e) => e.seq), [4, 5]);
  assert.deepEqual(store.eventsFrom(W, C, 4, 10).map((e) => e.seq), [4, 5, 6]);
  assert.equal(store.eventById(W, posted(4).id).seq, 4);
  assert.equal(store.eventAt(W, C, 6).text, 'Bericht 6');
  assert.equal(store.eventById(W, id('e', 'nothing')), null);
  assert.deepEqual(store.appendEvents(W, C, []), []);
});

test('events of every kind keep their fields and come out as the renderer\'s Event', (t) => {
  const store = fresh(t);
  withRoom(store);
  const mention = [{ actor: ME, start: 4, end: 9 }];
  store.appendEvents(W, C, [
    { seq: 1, id: id('e', 'created'), kind: 'channel.created', actor: ME, at: 1, name: 'general', visibility: 'workspace' },
    { seq: 2, id: id('e', 'joined'), kind: 'member.joined', actor: ME, at: 2, member: JOEL },
    posted(3, { text: 'Hoi @Zoë', mentions: mention }),
    { seq: 4, id: id('e', 'dm'), kind: 'dm.started', actor: ME, at: 4, members: [ME, JOEL] }
  ]);
  const events = store.eventsFrom(W, C, 1, 10).map(toRenderer);
  assert.deepEqual(events[0].data, { name: 'general', visibility: 'workspace' });
  assert.equal(events[0].text, null);
  assert.deepEqual(events[1].data, { member: JOEL });
  assert.deepEqual(events[2], { seq: 3, id: posted(3).id, kind: 'message.posted', actor: JOEL, at: 1003, root: null, text: 'Hoi @Zoë', mentions: mention, redacted: false, data: {}, attachments: [], previews: [], reactions: [] });
  assert.deepEqual(events[3].data, { members: [ME, JOEL] });
});

test('removed messages stay removed: tombstones, redacted events and later pages', (t) => {
  const store = fresh(t, { now: () => 5000 });
  withRoom(store);
  const gone = posted(2);
  store.addTombstones(W, [gone.id]);
  assert.ok(store.hasTombstone(W, gone.id));
  // A slow page that still has the body stores it removed.
  store.appendEvents(W, C, [posted(1), gone, posted(3, { redacted: true, text: undefined, mentions: undefined })]);
  assert.equal(store.eventAt(W, C, 2).text, null);
  assert.equal(store.eventAt(W, C, 2).redacted, 1);
  assert.equal(store.eventAt(W, C, 3).redacted, 1);
  // A removal in a page redacts the target in any room and tells which rooms changed.
  assert.deepEqual(store.redact(W, [posted(1).id, gone.id, id('e', 'not cached')]), { [C]: [posted(1).id] });
  assert.equal(store.eventAt(W, C, 1).text, null);
  assert.equal(store.eventAt(W, C, 1).mentions, null);
  // The same event again with its text doesn't bring the text back.
  store.appendEvents(W, C, [posted(1)]);
  assert.equal(store.eventAt(W, C, 1).text, null);
  // A message.redacted event removes and tombstones its target.
  store.appendEvents(W, C, [posted(4)]);
  store.appendEvents(W, C, [{ seq: 5, id: id('e', 'redaction'), kind: 'message.redacted', actor: JOEL, at: 6, target: posted(4).id, targetSeq: 4 }]);
  assert.equal(store.eventAt(W, C, 4).text, null);
  assert.ok(store.hasTombstone(W, posted(4).id));
  assert.deepEqual(JSON.parse(store.eventAt(W, C, 5).data), { target: posted(4).id, targetSeq: 4 });
  // Pruning goes by when the tombstone was written.
  store.addTombstones(W, [id('e', 'old')], 100);
  assert.equal(store.pruneTombstones(W, 1000), 1);
  assert.ok(!store.hasTombstone(W, id('e', 'old')));
  assert.ok(store.hasTombstone(W, gone.id));
});

test(`a room keeps at most ${ROOM_CACHE_MAX} events: the lowest go and lo moves up`, (t) => {
  const store = fresh(t);
  withRoom(store, W, feedRoom({ head: 0 }));
  const events = Array.from({ length: ROOM_CACHE_MAX + 5 }, (_, i) => posted(i + 1));
  const stored = store.appendEvents(W, C, events);
  assert.equal(stored.length, ROOM_CACHE_MAX);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, ROOM_CACHE_MAX);
  assert.deepEqual([store.getRoom(W, C).lo, store.getRoom(W, C).hi], [6, ROOM_CACHE_MAX + 5]);
  assert.equal(store.trimRoom(W, C, 10), ROOM_CACHE_MAX - 10);
  assert.deepEqual([store.getRoom(W, C).lo, store.getRoom(W, C).hi], [ROOM_CACHE_MAX - 4, ROOM_CACHE_MAX + 5]);
  assert.equal(store.trimRoom(W, C, 10), 0);
  store.deleteWsEvents(W);
  assert.deepEqual([store.getRoom(W, C).lo, store.getRoom(W, C).hi], [null, null]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM event').get().n, 0);
});

test('replies and reply counts come from the thread index', (t) => {
  const store = fresh(t);
  withRoom(store);
  const root = posted(1);
  store.appendEvents(W, C, [root, posted(2), posted(3, { root: root.id, at: 50 }), posted(4, { root: root.id, at: 60, redacted: true, text: undefined, mentions: undefined }), posted(5, { root: posted(2).id })]);
  assert.deepEqual(store.replies(W, C, root.id).map((e) => e.seq), [3, 4]);
  assert.deepEqual(store.replyCounts(W, C, [root.id, posted(2).id, posted(5).id]), {
    [root.id]: { count: 2, lastSeq: 4, lastAt: 60 },
    [posted(2).id]: { count: 1, lastSeq: 5, lastAt: 1005 }
  });
});

test('local badges leave out own and removed messages, and mentions by blocked people', (t) => {
  const store = fresh(t);
  withRoom(store);
  const me = [{ actor: ME, start: 0, end: 4 }];
  store.appendEvents(W, C, [
    posted(1, { text: '@Zoe hoi', mentions: me }),
    posted(2, { actor: ME, text: 'Mijn eigen' }),
    posted(3, { actor: MILA, text: '@Zoe let op', mentions: me }),
    posted(4, { redacted: true, text: undefined, mentions: undefined }),
    posted(5, { text: '@Mila', mentions: [{ actor: MILA, start: 0, end: 5 }] }),
    { seq: 6, id: id('e', 'joined'), kind: 'member.joined', actor: MILA, at: 6, member: MILA }
  ]);
  assert.deepEqual(store.countBadges(W, C, 0, ME, []), { unread: 3, mentions: 2 });
  assert.deepEqual(store.countBadges(W, C, 1, ME, []), { unread: 2, mentions: 1 });
  // A blocked author still counts as unread, never as a mention.
  assert.deepEqual(store.countBadges(W, C, 0, ME, [MILA]), { unread: 3, mentions: 1 });
  store.replaceBlocks(W, [{ member: JOEL, at: 1 }]);
  assert.deepEqual(store.countBadges(W, C, 0, ME), { unread: 3, mentions: 1 }, 'the block rows when no list is given');
  assert.deepEqual(store.countBadges(W, C, 6, ME, []), { unread: 0, mentions: 0 });
  // Capped at 100.
  store.appendEvents(W, C, Array.from({ length: 150 }, (_, i) => posted(10 + i, { text: '@Zoe', mentions: me })));
  assert.deepEqual(store.countBadges(W, C, 0, ME, []), { unread: 100, mentions: 100 });
});

// ---- passes and the directory ----

test('a pass keeps its room rows apart until it installs', (t) => {
  const store = fresh(t);
  withRoom(store);
  store.putPassRoom(W, feedRoom({ head: 20 }));
  store.putPassRoom(W, feedRoom({ head: 21 }));
  store.putPassRoom(W, feedRoom({ conversation: C2, name: 'plans' }));
  assert.deepEqual(store.listPassRooms(W).map((r) => [r.conversation, r.head]), [[C, 21], [C2, 10]].sort());
  assert.equal(store.getRoom(W, C).head, 10, 'the room list keeps the previous rows');
  store.clearPass(W);
  assert.deepEqual(store.listPassRooms(W), []);
});

test('the directory replaces its rows and clears its stale flag', (t) => {
  const store = fresh(t);
  store.insertWs({ id: W, name: 'Rukoo team', role: 'owner' });
  const ws = () => store.getWs(W);
  assert.deepEqual([ws().membersStale, ws().channelsStale, ws().blocksStale], [1, 1, 1]);
  const zoe = { id: ME, kind: 'human', name: 'Zoë', role: 'owner', state: 'active', joinedAt: 1 };
  store.replaceMembers(W, [zoe, { id: JOEL, kind: 'human', name: '', role: 'member', state: 'deleted', joinedAt: 2 }], true);
  assert.equal(store.listMembers(W).length, 2);
  assert.equal(ws().membersMore, 1);
  store.replaceMembers(W, [zoe], false);
  assert.deepEqual(store.listMembers(W), [zoe]);
  assert.deepEqual([ws().membersStale, ws().membersMore], [0, 0]);
  const channel = { id: C, name: 'general', visibility: 'workspace', archived: false, joined: true, role: 'manager', members: 2 };
  store.replaceChannels(W, [channel, { ...channel, id: C2, name: 'plans', joined: false, role: null }]);
  assert.deepEqual(store.listChannels(W).find((c) => c.id === C), channel);
  assert.equal(ws().channelsStale, 0);
  store.replaceBlocks(W, [{ member: JOEL, at: 1 }, { member: MILA, at: 5 }]);
  assert.deepEqual(store.listBlocks(W), [{ member: MILA, at: 5 }, { member: JOEL, at: 1 }]);
  assert.equal(ws().blocksStale, 0);
  store.replaceBlocks(W, []);
  assert.deepEqual(store.listBlocks(W), []);
});

// ---- outbox, drafts and notices ----

test('the outbox hands out one due send per room, oldest first, and a held row holds back its room', (t) => {
  const store = fresh(t);
  withRoom(store);
  withRoom(store, W, feedRoom({ conversation: C2, name: 'plans' }));
  store.insertOutbox(outboxRow('c1', { createdAt: 10 }));
  store.insertOutbox(outboxRow('c2', { createdAt: 20 }));
  store.insertOutbox(outboxRow('p1', { room: C2, createdAt: 15, mentions: [{ actor: JOEL, start: 0, end: 2 }] }));
  assert.deepEqual(JSON.parse(store.getOutbox(local('p1')).mentions), [{ actor: JOEL, start: 0, end: 2 }]);
  assert.equal(store.countUnsent(), 3);
  assert.deepEqual(store.nextDue(100, 10).map((r) => r.local), [local('c1'), local('p1')]);
  assert.deepEqual(store.nextDue(100, 1).map((r) => r.local), [local('c1')]);
  store.updateOutbox(local('c1'), { state: 'sending', operationId: '019a9bc5-7380-7011-a233-445566778899' });
  assert.deepEqual(store.nextDue(100, 10).map((r) => r.local), [local('p1')], 'a send in flight holds back its room');
  store.updateOutbox(local('c1'), { state: 'held', reason: 'stale_grant' });
  assert.deepEqual(store.nextDue(100, 10).map((r) => r.local), [local('p1')], 'so does a held one');
  store.updateOutbox(local('p1'), { nextAt: 500 });
  assert.deepEqual(store.nextDue(100, 10), [], 'not due yet');
  assert.deepEqual(store.nextDue(500, 10).map((r) => r.local), [local('p1')]);
  store.updateWs(W, { state: 'quarantined' });
  assert.deepEqual(store.nextDue(500, 10), [], 'a stopped workspace sends nothing');
  store.updateWs(W, { state: 'ok' });
  assert.equal(store.deleteOutbox(local('c1')), true);
  assert.deepEqual(store.nextDue(500, 10).map((r) => r.local), [local('p1'), local('c2')], 'oldest first across rooms');
  assert.deepEqual(store.outboxForRoom(W, C).map((r) => r.local), [local('c2')]);
  assert.equal(store.outboxForWs(W).length, 2);
  assert.equal(store.deleteOutbox(local('c1')), false);
  // The CHECK on state is a write SQLite refuses.
  assert.throws(() => store.updateOutbox(local('c2'), { state: 'lost' }), (err) => err instanceof ChatError && err.code === 'not_saved');
});

test('sends written in the same millisecond go out and list in the order they were written', (t) => {
  const store = fresh(t);
  withRoom(store);
  withRoom(store, W, feedRoom({ conversation: C2, name: 'plans' }));
  // Written in the reverse order of their random handles, so ordering by local would turn them around.
  const labels = ['m1', 'm2', 'm3', 'm4'].sort((a, b) => (local(a) < local(b) ? 1 : -1));
  for (const label of labels) store.insertOutbox(outboxRow(label, { createdAt: 50 }));
  store.insertOutbox(outboxRow('other', { room: C2, createdAt: 50 }));
  const written = labels.map(local);
  assert.deepEqual(store.outboxForRoom(W, C).map((r) => r.local), written);
  assert.deepEqual(store.outboxForWs(W).map((r) => r.local), [...written, local('other')]);
  assert.deepEqual(store.nextDue(100, 10).map((r) => r.local), [written[0], local('other')]);
  store.deleteOutbox(written[0]);
  assert.deepEqual(store.nextDue(100, 10).map((r) => r.local), [written[1], local('other')]);
  // A row written after the newest one was deleted still comes last.
  store.deleteOutbox(written[3]);
  store.insertOutbox(outboxRow('m5', { createdAt: 50 }));
  assert.deepEqual(store.outboxForRoom(W, C).map((r) => r.local), [written[1], written[2], local('m5')]);
});

test('markLookup sends unconfirmed rows to a lookup, for one generation or all', (t) => {
  const store = fresh(t);
  withRoom(store);
  const rows = {
    queued: { state: 'queued' },
    sending: { state: 'sending', operationId: '019a9bc5-7380-7011-a233-445566778899' },
    stale: { state: 'held', reason: 'stale_grant' },
    unknown: { state: 'held', reason: 'unknown' },
    failed: { state: 'failed', reason: 'quota' },
    otherGen: { state: 'queued', generation: 'ZyXwVuTsRqPoNmLkJiHgFe' }
  };
  for (const [label, over] of Object.entries(rows)) store.insertOutbox(outboxRow(label, { ...over, nextAt: 99 }));
  assert.equal(store.markLookup(W, GENERATION), 3);
  const state = (label) => {
    const r = store.getOutbox(local(label));
    return [r.state, r.reason];
  };
  for (const label of ['queued', 'sending', 'stale']) {
    assert.deepEqual(state(label), ['queued', 'lookup'], label);
    assert.equal(store.getOutbox(local(label)).nextAt, 0);
  }
  assert.deepEqual(state('unknown'), ['held', 'unknown']);
  assert.deepEqual(state('failed'), ['failed', 'quota']);
  assert.deepEqual(state('otherGen'), ['queued', null]);
  assert.equal(store.markLookup(W), 4, 'without a generation every one of the workspace');
  assert.deepEqual(state('otherGen'), ['queued', 'lookup']);
  assert.equal(store.getOutbox(local('sending')).operationId, '019a9bc5-7380-7011-a233-445566778899', 'the operation ID stays');
});

test('drafts are kept per room and thread, and notices per message', (t) => {
  const store = fresh(t, { now: () => 777 });
  withRoom(store);
  const root = id('e', 'root');
  store.putDraft(W, C, null, { text: 'Main', mentions: [] });
  store.putDraft(W, C, root, { text: 'Thread @Zoë', mentions: [{ actor: ME, start: 7, end: 12 }] });
  store.putDraft(W, C, null, { text: 'Main, again', mentions: [] });
  assert.deepEqual(store.getDraft(W, C, null), { text: 'Main, again', mentions: [], attachments: [], at: 777 });
  assert.deepEqual(store.getDraft(W, C, root).mentions, [{ actor: ME, start: 7, end: 12 }]);
  store.deleteDraft(W, C, null);
  assert.equal(store.getDraft(W, C, null), null);
  assert.ok(store.getDraft(W, C, root));

  store.addNotices(W, C, [{ message: id('e', 'a'), seq: 3 }, { message: id('e', 'b'), seq: 5 }]);
  assert.deepEqual(store.noticesForRoom(W, C).map((n) => n.seq), [3, 5]);
  assert.deepEqual(store.deleteNotices(W, C, [id('e', 'a')]).map((n) => n.seq), [3]);
  assert.deepEqual(store.deleteNotices(W, C).map((n) => n.seq), [5]);
  assert.deepEqual(store.noticesForRoom(W, C), []);
});

// ---- transactions ----

test('a transaction commits as a whole, rolls back on a throw and refuses to span an await', (t) => {
  const store = fresh(t);
  withRoom(store);
  assert.equal(store.tx(() => store.tx(() => 'joined')), 'joined');
  assert.throws(
    () =>
      store.tx(() => {
        store.insertOutbox(outboxRow('first'));
        store.insertOutbox(outboxRow('second', { state: 'pending' }));
      }),
    (err) => err instanceof ChatError && err.code === 'not_saved' && err.message.length > 0
  );
  assert.equal(store.countUnsent(), 0, 'the first write rolled back with the second');
  assert.throws(() => store.tx(() => {
    store.insertOutbox(outboxRow('third'));
    throw new ChatError('invalid', { field: 'text' });
  }), (err) => err.code === 'invalid', 'a ChatError keeps its code');
  assert.equal(store.countUnsent(), 0);
  assert.throws(() => store.tx(async () => store.insertOutbox(outboxRow('fourth'))), TypeError);
  assert.equal(store.countUnsent(), 0);
  // A room for a workspace that doesn't exist breaks the foreign key.
  assert.throws(() => store.upsertRoom(W2, feedRoom()), (err) => err.code === 'not_saved');
  store.insertOutbox(outboxRow('fifth'));
  assert.equal(store.countUnsent(), 1, 'the store still writes after a failed transaction');
});

test('a nested transaction that fails rolls back only its own writes, as not_saved, and the outer one goes on', (t) => {
  const store = fresh(t);
  withRoom(store);
  const result = store.tx(() => {
    store.setMeta('outer', '1');
    assert.throws(
      () =>
        store.tx(() => {
          store.setMeta('inner', '1');
          store.insertOutbox(outboxRow('bad', { state: 'pending' }));
        }),
      (err) => err instanceof ChatError && err.code === 'not_saved',
      'the inner level converts SQLite errors too'
    );
    // A named query is a nested transaction of its own.
    assert.throws(() => store.insertOutbox(outboxRow('bad2', { state: 'pending' })), (err) => err instanceof ChatError && err.code === 'not_saved');
    assert.throws(() => store.tx(() => {
      store.setMeta('thrown', '1');
      throw new ChatError('invalid', { field: 'text' });
    }), (err) => err.code === 'invalid');
    store.insertOutbox(outboxRow('good'));
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(store.getMeta('outer'), '1');
  assert.equal(store.getMeta('inner'), null, 'the failed inner block left nothing behind');
  assert.equal(store.getMeta('thrown'), null);
  assert.deepEqual(store.outboxForWs(W).map((r) => r.local), [local('good')]);
  // Nested levels that succeed commit with the outer one, and a throw at the top still takes them all back.
  assert.throws(() => store.tx(() => {
    store.tx(() => store.tx(() => store.setMeta('deep', '1')));
    throw new Error('outer fails');
  }), /outer fails/);
  assert.equal(store.getMeta('deep'), null);
  store.tx(() => store.tx(() => store.tx(() => store.setMeta('deep', '2'))));
  assert.equal(store.getMeta('deep'), '2');
});

// ---- lifetime ----

test('wipe closes the database and leaves no file behind', (t) => {
  const dir = tempDir('rukoo-chat-store-');
  const file = path.join(dir, 'data', 'chat.db');
  const store = openStore(file);
  withRoom(store);
  store.appendEvents(W, C, [posted(1)]);
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(`${file}-wal`));
  assert.equal(store.wipe(), true);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) assert.ok(!fs.existsSync(f), f);
  assert.ok(fs.existsSync(path.dirname(file)), 'the data folder stays');
  assert.equal(store.wipe(), true, 'a second wipe has nothing left to do');
  // A new store on the same path starts empty.
  const again = openStore(file);
  t.after(() => again.close());
  assert.deepEqual(again.listWs(), []);
  assert.equal(again.lostUnsent, 0);
});

test('a reopened cache keeps what was written', (t) => {
  const file = path.join(tempDir('rukoo-chat-store-'), 'chat.db');
  const first = openStore(file);
  withRoom(first);
  first.appendEvents(W, C, [posted(1)]);
  first.insertOutbox(outboxRow('kept'));
  first.close();
  const second = openStore(file);
  t.after(() => second.close());
  assert.equal(second.lostUnsent, 0);
  assert.equal(second.eventAt(W, C, 1).text, 'Bericht 1');
  assert.equal(second.countUnsent(), 1);
});

function filesBytes(file) {
  return Buffer.concat([file, `${file}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)));
}

test('a deleted room\'s message text is gone from the file bytes once the WAL is checkpointed', (t) => {
  const file = path.join(tempDir('rukoo-chat-store-'), 'chat.db');
  const store = openStore(file);
  t.after(() => store.close());
  withRoom(store);
  withRoom(store, W, feedRoom({ conversation: C2, name: 'plans' }));
  const secrets = { event: 'Vertrouwelijk-bericht-7f3a91', outbox: 'Nog-niet-verstuurd-2c8e44', draft: 'Half-geschreven-9b1d07' };
  // Enough text that the room fills pages of its own, next to a room that stays.
  store.appendEvents(W, C, Array.from({ length: 200 }, (_, i) => posted(i + 1, { text: `${secrets.event} ${i} ${'x'.repeat(200)}` })));
  store.appendEvents(W, C2, [posted(1, { room: C2, text: 'Blijft staan' })]);
  store.insertOutbox(outboxRow('secret', { text: secrets.outbox }));
  store.putDraft(W, C, null, { text: secrets.draft, mentions: [] });
  // Once in the WAL and once checkpointed into the file itself, the hardest place to get it out of.
  store.checkpoint();
  const before = filesBytes(file);
  for (const text of Object.values(secrets)) assert.ok(before.includes(Buffer.from(text)), `${text} is on disk before`);

  assert.equal(store.deleteRoom(W, C), 1);
  store.checkpoint();
  const after = filesBytes(file);
  assert.equal(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0, 0, 'the WAL is empty');
  for (const text of Object.values(secrets)) assert.ok(!after.includes(Buffer.from(text)), `${text} is gone`);
  assert.ok(after.includes(Buffer.from('Blijft staan')), 'the other room stays');
  assert.ok(store.quickCheck());
});

test('a deleted workspace\'s text is gone from the file bytes too', (t) => {
  const file = path.join(tempDir('rukoo-chat-store-'), 'chat.db');
  const store = openStore(file);
  t.after(() => store.close());
  withRoom(store);
  store.appendEvents(W, C, Array.from({ length: 50 }, (_, i) => posted(i + 1, { text: `Werkruimte-geheim-41c7 ${i} ${'y'.repeat(300)}` })));
  store.replaceMembers(W, [{ id: ME, kind: 'human', name: 'Naam-uit-lijst-55e2', role: 'owner', state: 'active', joinedAt: 1 }]);
  store.checkpoint();
  assert.ok(filesBytes(file).includes(Buffer.from('Werkruimte-geheim-41c7')));
  store.deleteWs(W);
  store.checkpoint();
  const after = filesBytes(file);
  assert.ok(!after.includes(Buffer.from('Werkruimte-geheim-41c7')));
  assert.ok(!after.includes(Buffer.from('Naam-uit-lijst-55e2')));
});

test('a wipe whose file can\'t be deleted says so, and leaves no text of the session in the file', (t) => {
  const file = path.join(tempDir('rukoo-chat-store-'), 'chat.db');
  const store = openStore(file);
  const session = 'SessieLabel-6d0e2a';
  store.setMeta('session', session);
  withRoom(store);
  const secrets = { event: 'Oude-sessie-bericht-3a7f', outbox: 'Oude-sessie-onverstuurd-81c2', draft: 'Oude-sessie-concept-c94d', member: 'Oude-sessie-naam-5be0' };
  store.appendEvents(W, C, Array.from({ length: 120 }, (_, i) => posted(i + 1, { text: `${secrets.event} ${i} ${'q'.repeat(200)}` })));
  store.insertOutbox(outboxRow('old', { text: secrets.outbox }));
  store.putDraft(W, C, null, { text: secrets.draft, mentions: [] });
  store.replaceMembers(W, [{ id: ME, kind: 'human', name: secrets.member, role: 'owner', state: 'active', joinedAt: 1 }]);
  store.checkpoint();
  // Some in the file, the latest in the WAL.
  store.putDraft(W, C, posted(1).id, { text: `${secrets.draft} thread`, mentions: [] });
  const before = filesBytes(file);
  for (const text of [session, ...Object.values(secrets)]) assert.ok(before.includes(Buffer.from(text)), `${text} is on disk before`);

  // A virus scanner holds the files past rmSync's retries.
  const rm = t.mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  });
  assert.equal(store.wipe(), false);
  assert.ok(rm.mock.callCount() >= 1);
  assert.ok(fs.existsSync(file), 'the file stayed');
  const after = filesBytes(file);
  for (const text of [session, ...Object.values(secrets)]) assert.ok(!after.includes(Buffer.from(text)), `${text} is gone from the bytes`);
  assert.ok(fs.existsSync(file));

  // The next open can't replace it either, and refuses it instead of making a cache on top.
  assert.throws(() => openStore(file), (err) => err instanceof ChatError && err.code === 'not_saved');

  // Once the handle is gone the file is replaced by a new, empty cache.
  rm.mock.restore();
  const next = openStore(file);
  t.after(() => next.close());
  assert.equal(next.getMeta('schema'), String(SCHEMA_VERSION));
  assert.equal(next.getMeta('session'), null);
  assert.deepEqual(next.listWs(), []);
  assert.equal(next.countUnsent(), 0);
  assert.equal(next.lostUnsent, 0);
});

// A cache with two unsent messages, closed so everything is in the file.
function cacheWithSends(file) {
  const store = openStore(file);
  withRoom(store);
  store.appendEvents(W, C, Array.from({ length: 300 }, (_, i) => posted(i + 1, { text: `Body ${i} ${'z'.repeat(100)}` })));
  store.insertOutbox(outboxRow('one'));
  store.insertOutbox(outboxRow('two'));
  store.checkpoint();
  store.close();
}

test('a file that fails quick_check is replaced, and its unsent messages are counted', (t) => {
  const file = path.join(tempDir('rukoo-chat-store-'), 'chat.db');
  cacheWithSends(file);
  // Break the event table's root page, which the outbox doesn't share.
  const db = new DatabaseSync(file);
  const { rootpage } = db.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'event'`).get();
  const { page_size: pageSize } = db.prepare('PRAGMA page_size').get();
  db.close();
  const bytes = fs.readFileSync(file);
  bytes.fill(0xa5, (rootpage - 1) * pageSize, rootpage * pageSize);
  fs.writeFileSync(file, bytes);
  const broken = new DatabaseSync(file);
  assert.notEqual(Object.values(broken.prepare('PRAGMA quick_check').get())[0], 'ok', 'the file is broken');
  assert.equal(broken.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 2, 'and its outbox can still be counted');
  broken.close();

  const store = openStore(file);
  t.after(() => store.close());
  assert.equal(store.lostUnsent, 2);
  assert.ok(store.quickCheck());
  assert.equal(store.getMeta('schema'), String(SCHEMA_VERSION));
  assert.deepEqual(store.listWs(), []);
  assert.equal(store.countUnsent(), 0);
});

test('a file of a newer schema is replaced, and its unsent messages are counted', (t) => {
  const file = path.join(tempDir('rukoo-chat-store-'), 'chat.db');
  cacheWithSends(file);
  const db = new DatabaseSync(file);
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema'`).run(String(SCHEMA_VERSION + 1));
  db.close();
  const store = openStore(file);
  t.after(() => store.close());
  assert.equal(store.lostUnsent, 2);
  assert.equal(store.getMeta('schema'), String(SCHEMA_VERSION));
  assert.deepEqual(store.listWs(), []);
});

test('a file that is no database at all is replaced with nothing to count', (t) => {
  const file = path.join(tempDir('rukoo-chat-store-'), 'chat.db');
  fs.writeFileSync(file, Buffer.alloc(8192, 0x42));
  fs.writeFileSync(`${file}-wal`, 'leftover');
  const store = openStore(file);
  t.after(() => store.close());
  assert.equal(store.lostUnsent, 0);
  assert.ok(store.quickCheck());
  assert.equal(store.getMeta('schema'), String(SCHEMA_VERSION));
});

// Review 206A item 2: a lock another connection held made openStore take the file for broken; when the lock went
// before the deletion, the unsent message and the draft went with the file and lostUnsent said 0.
test('a file another connection holds locked is left as it is, and opens once the lock is gone', (t) => {
  const file = path.join(tempDir('rukoo-chat-store-'), 'chat.db');
  const store = openStore(file);
  withRoom(store);
  store.insertOutbox(outboxRow('locked'));
  store.putDraft(W, C, null, { text: 'Draft under a lock', mentions: [] });
  store.close();
  const holder = new DatabaseSync(file);
  holder.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  let held = true;
  // The lock goes the moment anything tries to delete the file, as when the other connection finishes just then.
  const rm = t.mock.method(fs, 'rmSync', function (...args) {
    if (held) {
      held = false;
      holder.close();
    }
    return rm.mock.original.apply(this, args);
  });
  t.after(() => held && holder.close());
  assert.throws(
    () => openStore(file),
    (err) => !(err instanceof ChatError) && (err.errcode & 0xff) === 5
  );
  assert.equal(rm.mock.callCount(), 0, 'nothing tried to delete the file');
  if (held) {
    held = false;
    holder.close();
  }
  const again = openStore(file);
  t.after(() => again.close());
  assert.equal(again.lostUnsent, 0);
  assert.equal(again.countUnsent(), 1);
  assert.equal(again.getDraft(W, C, null).text, 'Draft under a lock');
});

test('a database without the chat schema is replaced too', (t) => {
  const file = path.join(tempDir('rukoo-chat-store-'), 'chat.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE something (x)');
  db.close();
  const store = openStore(file);
  t.after(() => store.close());
  assert.equal(store.getMeta('schema'), String(SCHEMA_VERSION));
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'something'`).get().n, 0);
});
