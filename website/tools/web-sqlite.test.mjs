// The browser's SQLite (src/web/engine/sqlite.js, node:sqlite's DatabaseSync over sql.js) and the desktop's chat cache
// (src/main/workspaces/store.js) running on it. Both come from one test bundle made with the browser build's own
// options (src/web/build-options.mjs), so store.js reaches the adapter through the same node:sqlite alias and shims
// as on the page. Where node:sqlite itself can answer, the adapter's answer is compared with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync as NodeDatabase } from 'node:sqlite';
import * as esbuild from 'esbuild';
import { webEngineOptions, sqlWasm } from '../../src/web/build-options.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const websiteDir = path.join(root, 'website');
const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-web-sqlite-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

// The adapter and the real store.js, bundled for the browser, as CommonJS so this process can load them.
async function loadWeb() {
  const result = await esbuild.build({
    ...webEngineOptions({ root, websiteDir }),
    stdin: {
      contents: "module.exports = { sqlite: require('./src/web/engine/sqlite.js'), store: require('./src/main/workspaces/store.js') };",
      resolveDir: root,
      sourcefile: 'web-sqlite-entry.js'
    },
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  });
  const file = path.join(temp, 'web-sqlite.cjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  // The page's i18n scripts, which the bundle reads instead of bundling its own (wire.js needs t()).
  globalThis.RukooI18n = require('../../src/i18n/index.js');
  const web = require(file);
  await web.sqlite.init({ wasmBinary: fs.readFileSync(sqlWasm({ websiteDir }).from) });
  return web;
}

const web = await loadWeb();
const { DatabaseSync: WebDatabase } = web.sqlite;

// What a call threw, in the fields node:sqlite sets.
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return { type: err.constructor.name, code: err.code, errcode: err.errcode, message: err.message };
  }
  assert.fail('expected a throw');
}

const SCHEMA = `
  CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT NOT NULL UNIQUE, c INTEGER CHECK (c > 0), d BLOB);
  CREATE TABLE u (x INTEGER REFERENCES t(a));
  CREATE TABLE ev (seq INTEGER PRIMARY KEY, actor TEXT, mentions TEXT);
`;

// The same statements on any DatabaseSync; rows copied, so prototypes don't take part in the comparison.
function exercise(Database) {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;' + SCHEMA);
  const plain = (row) => (row ? { ...row } : row);
  const out = {};
  out.insert = db.prepare('INSERT INTO t (b, c, d) VALUES (?, ?, ?)').run('one', 1, new Uint8Array([1, 2, 3]));
  out.insert2 = db.prepare('INSERT INTO t (b, c) VALUES (?, ?)').run('two', 1763668000000);
  out.update = db.prepare('UPDATE t SET c = c + 1').run();
  out.get = plain(db.prepare('SELECT a, b, c, d FROM t WHERE b = ?').get('one'));
  out.big = plain(db.prepare('SELECT c, typeof(c) AS type FROM t WHERE b = ?').get('two'));
  out.none = db.prepare('SELECT a FROM t WHERE b = ?').get('nobody');
  out.all = db.prepare('SELECT a, b FROM t ORDER BY a').all().map(plain);
  out.named = plain(db.prepare('SELECT :x AS x, $y AS y, @z AS z').get({ x: 1, y: 'two', z: null }));
  out.nulls = plain(db.prepare('SELECT ? AS p, ? AS q').get(null));
  db.prepare('INSERT INTO ev (seq, actor, mentions) VALUES (?, ?, ?)').run(1, 'u_a', JSON.stringify([{ actor: 'u_me' }]));
  db.prepare('INSERT INTO ev (seq, actor, mentions) VALUES (?, ?, ?)').run(2, 'u_b', JSON.stringify([{ actor: 'u_other' }]));
  out.json = plain(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ev e WHERE e.actor NOT IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM json_each(e.mentions) m WHERE json_extract(m.value, '$.actor') = ?)`
      )
      .get(JSON.stringify(['u_blocked']), 'u_me')
  );
  out.quickCheck = db.prepare('PRAGMA quick_check').all().map(plain);
  // The statements store.js runs and expects to fail, and the codes it tells apart.
  out.errors = {
    unique: thrown(() => db.prepare('INSERT INTO t (b, c) VALUES (?, ?)').run('one', 1)),
    notNull: thrown(() => db.prepare('INSERT INTO t (b, c) VALUES (NULL, 1)').run()),
    check: thrown(() => db.prepare("INSERT INTO t (b, c) VALUES ('z', 0)").run()),
    foreignKey: thrown(() => db.prepare('INSERT INTO u (x) VALUES (99)').run()),
    syntax: thrown(() => db.prepare('SELEC 1')),
    noTable: thrown(() => db.prepare('SELECT * FROM nope')),
    nested: thrown(() => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('BEGIN IMMEDIATE');
      } finally {
        db.exec('ROLLBACK');
      }
    }),
    commit: thrown(() => db.exec('COMMIT')),
    savepoint: thrown(() => db.exec('RELEASE s9')),
    tooMany: thrown(() => db.prepare('SELECT ? AS v').get(1, 2))
  };
  db.close();
  return out;
}

test('the adapter answers as node:sqlite does', () => {
  const ours = exercise(WebDatabase);
  const node = exercise(NodeDatabase);
  // SQLite words a PRIMARY KEY violation "UNIQUE constraint failed" too, and sql.js reports only the words: the
  // adapter says SQLITE_CONSTRAINT_UNIQUE (2067). This one has no primary key in it, so the codes match exactly.
  assert.deepEqual(ours, node);
  assert.deepEqual(ours.insert, { changes: 1, lastInsertRowid: 1 });
  assert.deepEqual(ours.big, { c: 1763668000001, type: 'integer' });
  assert.deepEqual(ours.json, { n: 1 });
  assert.equal(ours.errors.unique.code, 'ERR_SQLITE_ERROR');
  assert.equal(ours.errors.unique.errcode, 2067);
});

test('a primary key violation keeps its primary result code', () => {
  const db = new WebDatabase();
  db.exec('CREATE TABLE p (id TEXT PRIMARY KEY) WITHOUT ROWID');
  db.prepare('INSERT INTO p VALUES (?)').run('a');
  const err = thrown(() => db.prepare('INSERT INTO p VALUES (?)').run('a'));
  assert.equal(err.code, 'ERR_SQLITE_ERROR');
  assert.equal(err.errcode & 0xff, 19);
  db.close();
});

test('rows, bindings and a closed database behave as in node:sqlite', () => {
  const db = new WebDatabase('ignored/chat.db');
  const row = db.prepare('SELECT 1 AS one').get();
  assert.equal(Object.getPrototypeOf(row), null);
  assert.equal(row.one, 1);
  for (const value of [undefined, true, () => 1]) {
    const err = thrown(() => db.prepare('SELECT ? AS v').get(value));
    assert.deepEqual([err.type, err.code, err.message], ['TypeError', 'ERR_INVALID_ARG_TYPE', 'Provided value cannot be bound to SQLite parameter 1.']);
  }
  assert.deepEqual({ ...db.prepare('SELECT ? AS v').get(42n) }, { v: 42 });
  assert.equal(thrown(() => db.prepare('')).code, 'ERR_INVALID_STATE');
  const kept = db.prepare('SELECT 1 AS one');
  assert.equal(db.isOpen, true);
  db.close();
  assert.equal(db.isOpen, false);
  for (const fn of [() => db.close(), () => db.exec('SELECT 1'), () => db.prepare('SELECT 1'), () => kept.get()]) {
    assert.deepEqual(thrown(fn), { type: 'Error', code: 'ERR_INVALID_STATE', errcode: undefined, message: 'database is not open' });
  }
});

test('the codes store.js treats as a broken file are read from their messages', () => {
  const { errcodeOf } = web.sqlite;
  assert.equal(errcodeOf('database disk image is malformed'), 11);
  assert.equal(errcodeOf('malformed database schema (event_id)'), 11);
  assert.equal(errcodeOf('file is not a database'), 26);
  assert.equal(errcodeOf('database or disk is full'), 13);
  assert.equal(errcodeOf('database is locked'), 5);
  assert.equal(errcodeOf('NOT NULL constraint failed: t.b'), 1299);
  assert.equal(errcodeOf('no such column: x'), 1);
});

// One scripted session of the chat cache, from openStore to wipe, as plain data to compare.
const WS = 'w_AAAAAAAAAAAAAAAAAAAAAA';
const ROOM = 'c_AAAAAAAAAAAAAAAAAAAAAA';
const ME = 'u_MeMeMeMeMeMeMeMeMeMeMe';
const OTHER = 'u_OtherOtherOtherOtherOt';

function storeSession({ openStore }, file) {
  const store = openStore(file, { now: () => 1800000000000 });
  const out = {};
  out.schema = store.getMeta('schema');
  out.tables = store.all(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((r) => r.name);
  out.quickCheck = store.quickCheck();

  out.inserted = store.insertWs({ id: WS, name: 'Acme', role: 'member', me: ME, myName: 'Me' });
  out.updated = store.updateWs(WS, { syncedAt: 1800000000123, limits: { members: 50 }, passing: false });
  out.ws = store.getWs(WS);

  // A transaction rolls back whole, and a failed inner one only itself.
  try {
    store.tx(() => {
      store.setMeta('selected', WS);
      throw new Error('stop');
    });
  } catch (err) {
    out.rolledBack = err.message;
  }
  out.afterRollback = store.getMeta('selected');
  store.tx(() => {
    store.setMeta('clockAt', '1');
    try {
      store.tx(() => {
        store.setMeta('clockOffset', '2');
        throw new Error('inner');
      });
    } catch (_) {
      // The outer transaction goes on.
    }
  });
  out.savepoint = { clockAt: store.getMeta('clockAt'), clockOffset: store.getMeta('clockOffset') };

  const feed = {
    conversation: ROOM,
    kind: 'channel',
    name: 'general',
    visibility: 'workspace',
    archived: false,
    grant: 'g_AAAAAAAAAAAAAAAAAAAAAA',
    role: 'member',
    members: 2,
    head: 3,
    floor: 1,
    lastAt: 1800000000000,
    read: 0,
    unread: 3,
    mentions: 1
  };
  out.room = store.upsertRoom(WS, feed);
  const message = (seq, actor, text, mentions = []) => ({ seq, id: `e_${String(seq).padStart(22, '0')}`, kind: 'message.posted', actor, at: 1800000000000 + seq, text, mentions });
  out.appended = store.appendEvents(WS, ROOM, [
    message(1, OTHER, 'Hello @Me', [{ actor: ME, start: 6, end: 9 }]),
    message(2, OTHER, 'No mention'),
    message(3, ME, 'Mine')
  ]);
  // countBadges is the query with json_each and json_extract.
  out.badges = store.countBadges(WS, ROOM, 0, ME, []);
  out.blockedBadges = store.countBadges(WS, ROOM, 0, ME, [OTHER]);
  out.redacted = store.redact(WS, ['e_0000000000000000000002']);

  const send = (local, createdAt) => ({ local, ws: WS, room: ROOM, actor: ME, grantId: feed.grant, generation: 'G'.repeat(22), text: local, createdAt });
  store.insertOutbox(send('L'.repeat(22), 5));
  store.insertOutbox(send('M'.repeat(22), 5));
  out.due = store.nextDue(1800000000000, 10).map((r) => r.local);
  out.unsent = store.countUnsent();
  // A write SQLite refuses is ChatError('not_saved'), with SQLite's error as its cause.
  for (const [name, fn] of [
    ['duplicate', () => store.insertOutbox(send('L'.repeat(22), 6))],
    ['badState', () => store.updateOutbox('M'.repeat(22), { state: 'lost' })]
  ]) {
    try {
      fn();
      out[name] = 'no error';
    } catch (err) {
      out[name] = { chat: err.chat === true, code: err.code, cause: err.cause && err.cause.code, primary: err.cause && err.cause.errcode & 0xff };
    }
  }
  store.putDraft(WS, ROOM, null, { text: 'draft', mentions: [] });
  out.draft = store.getDraft(WS, ROOM, null);
  out.deletedRoom = store.deleteRoom(WS, ROOM);
  out.cascade = store.get('SELECT (SELECT COUNT(*) FROM event) + (SELECT COUNT(*) FROM outbox) + (SELECT COUNT(*) FROM draft) AS n').n;
  out.wiped = store.wipe();
  out.closed = store.closed;
  return { out, store };
}

test('the real Store runs on the adapter as it runs on node:sqlite', () => {
  const ours = storeSession(web.store, 'rukoo-web/chat.db');
  const desktop = storeSession(require('../../src/main/workspaces/store.js'), path.join(temp, 'desktop', 'chat.db'));
  assert.ok(ours.store.db instanceof WebDatabase, 'store.js opened its database through the node:sqlite alias');
  assert.equal(ours.store.db.isOpen, false, 'wipe() closed the database');
  assert.deepEqual(ours.out, desktop.out);
  // And what that session was meant to show, so a regression on both sides doesn't pass as agreement.
  const o = ours.out;
  assert.equal(o.schema, String(web.store.SCHEMA_VERSION));
  assert.deepEqual(o.tables, ['block', 'channel', 'draft', 'event', 'file_cache', 'member', 'meta', 'notice', 'outbox', 'pass_room', 'room', 'tombstone', 'ws']);
  assert.equal(o.quickCheck, true);
  assert.equal(o.ws.syncedAt, 1800000000123);
  assert.equal(o.ws.limits, '{"members":50}');
  assert.equal(o.rolledBack, 'stop');
  assert.equal(o.afterRollback, null);
  assert.deepEqual(o.savepoint, { clockAt: '1', clockOffset: null });
  assert.deepEqual(o.badges, { unread: 2, mentions: 1 });
  assert.deepEqual(o.blockedBadges, { unread: 2, mentions: 0 });
  assert.deepEqual(o.due, ['L'.repeat(22)]);
  assert.equal(o.unsent, 2);
  assert.deepEqual(o.duplicate, { chat: true, code: 'not_saved', cause: 'ERR_SQLITE_ERROR', primary: 19 });
  assert.deepEqual(o.badState, { chat: true, code: 'not_saved', cause: 'ERR_SQLITE_ERROR', primary: 19 });
  assert.equal(o.deletedRoom, 2);
  assert.equal(o.cascade, 0);
  assert.equal(o.wiped, true);
});

test('a wiped cache opens again empty, as a file deleted on desktop does', () => {
  const first = web.store.openStore('rukoo-web/chat.db');
  first.setMeta('session', 'tag');
  assert.equal(first.wipe(), true);
  const second = web.store.openStore('rukoo-web/chat.db');
  assert.equal(second.getMeta('session'), null);
  assert.equal(second.getMeta('schema'), String(web.store.SCHEMA_VERSION));
  second.close();
});

// Rich messages (schema versions 2 and 3): files, link cards and reactions on cached messages, their asOf, Mark unread's
// readMark, drafts that keep files, and the cache of downloaded files with its upserts and partial index, scripted as
// one session as above.
const FILE_A = 'f_AAAAAAAAAAAAAAAAAAAAAA';
const FILE_B = 'f_BBBBBBBBBBBBBBBBBBBBBB';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const eid = (seq) => `e_${String(seq).padStart(22, '0')}`;

function richSession({ openStore }, file) {
  let clock = 1800000000000;
  const store = openStore(file, { now: () => clock });
  const out = {};
  out.columns = Object.fromEntries(
    ['event', 'outbox', 'draft', 'room', 'file_cache'].map((t) => [t, store.all(`SELECT name FROM pragma_table_info('${t}') ORDER BY cid`).map((r) => r.name)])
  );
  out.indexes = store.all(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'file_cache' ORDER BY name`);
  store.insertWs({ id: WS, name: 'Acme', role: 'member', me: ME, myName: 'Me' });
  const feed = { conversation: ROOM, kind: 'channel', name: 'general', visibility: 'workspace', archived: false, grant: 'g_AAAAAAAAAAAAAAAAAAAAAA', role: 'member', members: 2, head: 2, floor: 1, lastAt: clock, read: 0, unread: 2, mentions: 0, readMark: 1 };
  store.upsertRoom(WS, feed);
  out.readMark = store.get('SELECT readMark, readPaused FROM room WHERE ws = ? AND id = ?', WS, ROOM);
  // A newer readMark than the cached one: the person marked the room unread on another device.
  store.upsertRoom(WS, { ...feed, readMark: 2 });
  out.readMarkAfter = store.get('SELECT readMark, readPaused FROM room WHERE ws = ? AND id = ?', WS, ROOM);

  const image = { id: FILE_A, name: 'plan.png', type: 'image/png', size: 4, width: 64, height: 32 };
  const card = { url: 'https://example.test/plan', title: 'Plan', image: { id: FILE_B, name: 'card.png', type: 'image/png', size: 4 } };
  store.appendEvents(
    WS,
    ROOM,
    [
      { seq: 1, id: eid(1), kind: 'message.posted', actor: OTHER, at: clock + 1, text: 'Look', mentions: [], attachments: [image], reactions: [{ emoji: '\u{1F44D}', actors: [OTHER] }] },
      { seq: 2, id: eid(2), kind: 'message.posted', actor: ME, at: clock + 2, text: 'https://example.test/plan', mentions: [], previews: [card] }
    ],
    { asOf: 2 }
  );
  // A reaction event in the feed (seq 3), another person's reaction applied without a seq, and an older page that must
  // not take either back.
  const touched = new Set();
  store.appendEvents(WS, ROOM, [{ seq: 3, id: eid(3), kind: 'reaction.added', actor: ME, at: clock + 3, target: eid(1), emoji: '\u{1F44D}' }], { touched });
  out.touched = [...touched];
  out.reacted = store.react(WS, ROOM, eid(1), '\u{1F389}', OTHER, true);
  out.message = store.get('SELECT attachments, previews, reactions, asOf FROM event WHERE ws = ? AND id = ?', WS, eid(1));
  out.cardRemoved = store.setPreviews(WS, ROOM, eid(2), []);
  out.cards = store.get('SELECT previews, asOf FROM event WHERE ws = ? AND id = ?', WS, eid(2));
  out.withFile = store.messageWithFile(WS, ROOM, FILE_A);
  out.withoutFile = store.messageWithFile(WS, ROOM, FILE_B);

  store.putDraft(WS, ROOM, null, { text: 'draft', mentions: [], attachments: [{ ...image, expiresAt: clock + 3600000 }] });
  out.draft = store.getDraft(WS, ROOM, null);

  // The download cache: an upsert keeps the message it knew, two files with the same bytes count once, and the least
  // recently used comes first.
  store.putCachedFile({ ws: WS, room: ROOM, file: FILE_A, message: eid(1), sha256: SHA_A, size: 4, name: 'plan.png', type: 'image/png' });
  clock += 10;
  store.putCachedFile({ ws: WS, room: ROOM, file: FILE_A, message: null, sha256: SHA_A, size: 4, name: 'plan.png', type: 'image/png' });
  store.putCachedFile({ ws: WS, room: ROOM, file: FILE_B, message: eid(2), sha256: SHA_B, size: 7, name: 'card.png', type: 'image/png', usedAt: clock - 100 });
  out.cached = store.getCachedFile(WS, FILE_A);
  out.lru = store.cachedFiles();
  store.touchCachedFile(WS, FILE_B, clock + 50);
  out.lruAfter = store.cachedFiles().map((f) => f.sha256);
  out.hasA = store.hasCachedSha(SHA_A);
  out.dropped = store.dropCachedFilesOf(WS, [eid(2)]);
  out.hasB = store.hasCachedSha(SHA_B);
  store.forgetCachedSha(SHA_A);
  out.left = store.cachedFiles().length;
  out.queryPlan = store.all(`EXPLAIN QUERY PLAN SELECT file FROM file_cache WHERE ws = ? AND message = ?`, WS, eid(1)).map((r) => r.detail);
  out.wiped = store.wipe();
  return out;
}

test('rich messages: files, cards, reactions and the download cache run on the adapter as on node:sqlite', () => {
  const ours = richSession(web.store, 'rukoo-web/rich/chat.db');
  const desktop = richSession(require('../../src/main/workspaces/store.js'), path.join(temp, 'rich', 'chat.db'));
  assert.deepEqual(ours, desktop);
  // What the session was meant to show, so a regression on both sides doesn't pass as agreement.
  assert.ok(ours.columns.event.includes('attachments') && ours.columns.event.includes('asOf'), ours.columns.event.join(', '));
  assert.ok(ours.columns.outbox.includes('attachments') && ours.columns.draft.includes('attachments'));
  assert.ok(ours.columns.room.includes('readMark') && ours.columns.room.includes('readPaused'));
  assert.deepEqual(ours.indexes.map((i) => i.name), ['file_cache_message', 'file_cache_sha']);
  assert.match(ours.indexes[0].sql, /WHERE message IS NOT NULL/);
  assert.deepEqual(ours.readMark, { readMark: 1, readPaused: 0 });
  assert.deepEqual(ours.readMarkAfter, { readMark: 2, readPaused: 1 });
  assert.deepEqual(ours.touched, [eid(1)]);
  assert.equal(ours.reacted, true);
  assert.deepEqual(JSON.parse(ours.message.reactions), [
    { emoji: '\u{1F44D}', actors: [OTHER, ME] },
    { emoji: '\u{1F389}', actors: [OTHER] }
  ]);
  assert.equal(ours.message.asOf, 3);
  assert.equal(JSON.parse(ours.message.attachments)[0].id, FILE_A);
  assert.equal(ours.cardRemoved, true);
  assert.equal(ours.cards.previews, null);
  assert.equal(ours.withFile.file.id, FILE_A);
  assert.equal(ours.withoutFile, null, 'the card that held it was removed');
  assert.equal(ours.draft.attachments[0].id, FILE_A);
  assert.equal(ours.cached.message, eid(1), 'an upsert without a message keeps the one it knew');
  assert.equal(ours.cached.usedAt, 1800000000010);
  assert.deepEqual(ours.lru.map((f) => f.sha256), [SHA_B, SHA_A]);
  assert.deepEqual(ours.lruAfter, [SHA_A, SHA_B]);
  assert.equal(ours.hasA, true);
  assert.equal(ours.dropped, 1);
  assert.equal(ours.hasB, false);
  assert.equal(ours.left, 0);
  assert.ok(ours.queryPlan.some((d) => d.includes('file_cache_message')), ours.queryPlan.join('; '));
  assert.equal(ours.wiped, true);
});
