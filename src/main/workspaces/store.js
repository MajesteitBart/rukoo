'use strict';

// The team chat cache: one SQLite file per signed-in session, <profile>/data/chat.db, opened with node:sqlite. The
// schema is the team chat contract's (section 3.5), the same SQL Android runs. Everything here is synchronous, and a
// transaction never spans an await. The queries are the contract's store API (section 4.2); a module may prepare its
// own statements on store.db in its own file.
//
// Rows are written with INSERT ... ON CONFLICT ... DO UPDATE, never INSERT OR REPLACE: a replace deletes the row first,
// and the cascade would take a room's events, queued sends, drafts and notices with it.
//
// Version 2 (rich chat contract 4.2) adds what rich messages need: a message's files, link cards and reactions, the
// files of an unsent message and of a draft, a room's readMark and whether this device holds back its reads of it,
// and the index of downloaded files. Version 3 adds the seq a cached message's reactions and cards are current to. An
// older file migrates in place; a new file is made as version 1 and migrated the same way, so both end with the same
// tables.
const fs = require('fs');
const path = require('path');
const { ChatError, jsonList } = require('./wire');

const SCHEMA_VERSION = 3;
const ROOM_CACHE_MAX = 2000;
// Downloaded files live next to chat.db (rich contract 4.6); staged uploads made from dropped or pasted bytes too.
const FILES_DIR = 'chat-files';
const UPLOADS_DIR = 'chat-uploads';

// busy_timeout first, so a lock another connection holds a moment longer is waited for from the first statement on.
const PRAGMAS = `
PRAGMA busy_timeout = 2000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;
`;

const SCHEMA_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- schema = '1'; session = the session tag; server = the credential URL; selected = a w_ ID;
-- clockOffset = server time minus local time in ms; clockAt = local ms when it was measured

CREATE TABLE ws (
  id TEXT PRIMARY KEY,                      -- w_
  name TEXT NOT NULL,
  role TEXT NOT NULL,                       -- owner | admin | member | guest
  me TEXT, myName TEXT,                     -- from GET /
  generation TEXT, keyId TEXT,              -- from GET /; sends carry generation
  limits TEXT, retention TEXT,              -- JSON from GET /
  cursor TEXT,                              -- sealed; NULL means the next fetch starts a pass
  passing INTEGER NOT NULL DEFAULT 1,
  fresh INTEGER NOT NULL DEFAULT 1,         -- 1 until the first pass installs; that pass alerts nothing
  state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'quarantined', 'upgrade')),
  membersStale INTEGER NOT NULL DEFAULT 1,
  channelsStale INTEGER NOT NULL DEFAULT 1,
  blocksStale INTEGER NOT NULL DEFAULT 1,
  membersMore INTEGER NOT NULL DEFAULT 0,
  syncedAt INTEGER, activeAt INTEGER
) WITHOUT ROWID;

CREATE TABLE room (
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- c_
  kind TEXT NOT NULL,                       -- channel | dm
  name TEXT, visibility TEXT NOT NULL,      -- workspace | private | dm
  archived INTEGER NOT NULL, closedReason TEXT,
  participants TEXT, startedBy TEXT,        -- DMs: JSON array of u_ IDs, the caller included; the initiator
  grantId TEXT NOT NULL, role TEXT,         -- the caller's grant and its role: manager | member
  members INTEGER NOT NULL,
  head INTEGER NOT NULL, floor INTEGER NOT NULL, lastAt INTEGER,
  read INTEGER NOT NULL,                    -- the server's read position, as last seen
  readLocal INTEGER NOT NULL,               -- max(read, what this device marked read)
  readSent INTEGER NOT NULL,                -- the highest position the server confirmed from this device
  unread INTEGER NOT NULL, mentions INTEGER NOT NULL,   -- as shown, 0..100
  lo INTEGER, hi INTEGER,                   -- the cached range; both NULL when nothing is cached
  notified INTEGER NOT NULL DEFAULT 0,      -- the highest seq an alert covered
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ws, id)
) WITHOUT ROWID;

CREATE TABLE pass_room (                    -- the room rows of a pass in progress
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  row TEXT NOT NULL,                        -- the feed's room row as JSON
  PRIMARY KEY (ws, id)
) WITHOUT ROWID;

CREATE TABLE event (
  ws TEXT NOT NULL, room TEXT NOT NULL, seq INTEGER NOT NULL,
  id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL,
  root TEXT,                                -- e_ of the thread's root, for a reply
  text TEXT,                                -- NULL when removed or not a message
  mentions TEXT,                            -- JSON [{actor,start,end}] in UTF-8 bytes, as the server sent them
  data TEXT,                                -- JSON of the other fields of other kinds
  redacted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ws, room, seq),
  FOREIGN KEY (ws, room) REFERENCES room(ws, id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE UNIQUE INDEX event_id ON event (ws, id);
CREATE INDEX event_root ON event (ws, room, root, seq) WHERE root IS NOT NULL;

CREATE TABLE tombstone (                    -- removed message IDs, so a slow history page can't bring a body back
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE,
  message TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (ws, message)
) WITHOUT ROWID;

CREATE TABLE member (
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE, id TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, joinedAt INTEGER NOT NULL,
  PRIMARY KEY (ws, id)
) WITHOUT ROWID;

CREATE TABLE channel (                      -- GET /channels
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE, id TEXT NOT NULL,
  name TEXT NOT NULL, visibility TEXT NOT NULL, archived INTEGER NOT NULL,
  joined INTEGER NOT NULL, role TEXT, members INTEGER NOT NULL,
  PRIMARY KEY (ws, id)
) WITHOUT ROWID;

CREATE TABLE block (                        -- GET /blocks
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE, member TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (ws, member)
) WITHOUT ROWID;

CREATE TABLE outbox (
  local TEXT PRIMARY KEY,                   -- 16 random bytes in base64url: the UI's handle
  ws TEXT NOT NULL, room TEXT NOT NULL,
  actor TEXT NOT NULL, grantId TEXT NOT NULL, generation TEXT NOT NULL,
  text TEXT NOT NULL, mentions TEXT NOT NULL, root TEXT,   -- exactly what goes on the wire
  operationId TEXT UNIQUE,                  -- UUIDv7, saved before the first attempt
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'held', 'failed')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL,
  FOREIGN KEY (ws, room) REFERENCES room(ws, id) ON DELETE CASCADE
);
CREATE INDEX outbox_room ON outbox (ws, room, createdAt);

CREATE TABLE draft (
  ws TEXT NOT NULL, room TEXT NOT NULL, root TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL, mentions TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (ws, room, root),
  FOREIGN KEY (ws, room) REFERENCES room(ws, id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE notice (                       -- alerts on screen, so a read or a removal can take them back
  ws TEXT NOT NULL, room TEXT NOT NULL, message TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (ws, room, message),
  FOREIGN KEY (ws, room) REFERENCES room(ws, id) ON DELETE CASCADE
) WITHOUT ROWID;
`;

// Each version's changes to the one before, in order. MIGRATIONS[v] takes a file of version v - 1 to version v.
const MIGRATIONS = {
  2: `
ALTER TABLE event ADD COLUMN attachments TEXT;      -- a message's files, JSON [File]; NULL means []
ALTER TABLE event ADD COLUMN previews TEXT;         -- its link cards, JSON [Preview]; NULL means []
ALTER TABLE event ADD COLUMN reactions TEXT;        -- its reactions, JSON [{ emoji, actors }]; NULL means []
ALTER TABLE outbox ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';   -- JSON [File] the message sends
ALTER TABLE draft ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';    -- JSON [File] with expiresAt
ALTER TABLE room ADD COLUMN readMark INTEGER NOT NULL DEFAULT 0;        -- the feed's readMark as last seen
ALTER TABLE room ADD COLUMN readPaused INTEGER NOT NULL DEFAULT 0;      -- 1 after Mark unread until the room opens again

CREATE TABLE file_cache (                   -- downloaded files in chat-files/, each named by its SHA-256
  ws TEXT NOT NULL, room TEXT NOT NULL,
  file TEXT NOT NULL,                       -- f_
  message TEXT,                             -- e_ of the message whose file or card image it is, when known
  sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  name TEXT NOT NULL, type TEXT NOT NULL,   -- as the download route answered
  usedAt INTEGER NOT NULL,                  -- for the least recently used to go first
  PRIMARY KEY (ws, file),
  FOREIGN KEY (ws, room) REFERENCES room(ws, id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX file_cache_message ON file_cache (ws, message) WHERE message IS NOT NULL;
CREATE INDEX file_cache_sha ON file_cache (sha256);
`,
  3: `
ALTER TABLE event ADD COLUMN asOf INTEGER;          -- a message's: the seq its reactions and cards are current to
`
};

// The tables of the current version, as a new file gets them.
const SCHEMA = [SCHEMA_V1, ...Object.keys(MIGRATIONS).sort((a, b) => a - b).map((v) => MIGRATIONS[v])].join('\n');

// The columns a caller may set through updateWs, setRoomFields and updateOutbox. Everything else is the store's.
const WS_FIELDS = [
  'name', 'role', 'me', 'myName', 'generation', 'keyId', 'limits', 'retention', 'cursor', 'passing', 'fresh', 'state',
  'membersStale', 'channelsStale', 'blocksStale', 'membersMore', 'syncedAt', 'activeAt'
];
const ROOM_FIELDS = [
  'kind', 'name', 'visibility', 'archived', 'closedReason', 'participants', 'startedBy', 'grantId', 'role', 'members',
  'head', 'floor', 'lastAt', 'read', 'readLocal', 'readSent', 'unread', 'mentions', 'lo', 'hi', 'notified', 'muted',
  'readMark', 'readPaused'
];
const OUTBOX_FIELDS = ['grantId', 'generation', 'text', 'mentions', 'root', 'operationId', 'state', 'reason', 'attempts', 'nextAt', 'attachments'];
const JSON_FIELDS = new Set(['limits', 'retention', 'participants', 'mentions', 'attachments']);
// The fields of an event besides its own columns, kept as JSON in data.
const EVENT_COLUMNS = new Set(['seq', 'id', 'kind', 'actor', 'at', 'root', 'text', 'mentions', 'redacted']);
// A message's own columns since version 2. Other kinds keep fields of these names in data, such as the cards of a
// message.previewed.
const RICH_COLUMNS = new Set(['attachments', 'previews', 'reactions']);
// The events that change a cached message instead of showing as one (rich contract 3.1).
const CHANGE_KINDS = new Set(['reaction.added', 'reaction.removed', 'message.previewed']);

// A list as a column stores it: JSON, or NULL for an empty one.
const listColumn = (list) => (Array.isArray(list) && list.length ? JSON.stringify(list) : null);

// An event's data column as an object, {} for NULL or anything else.
function parseData(text) {
  if (text === null || text === undefined) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

// A message's reactions after actor added (on) or took back emoji, or null when that changes nothing (rich contract
// 3.1): an added actor goes at the end of the emoji's group, a new group at the end; a group that empties goes.
function reactionChange(list, emoji, actor, on) {
  const groups = Array.isArray(list) ? list.map((g) => ({ emoji: g.emoji, actors: Array.isArray(g.actors) ? [...g.actors] : [] })) : [];
  const group = groups.find((g) => g.emoji === emoji);
  if (on) {
    if (group && group.actors.includes(actor)) return null;
    if (group) group.actors.push(actor);
    else groups.push({ emoji, actors: [actor] });
    return groups;
  }
  if (!group || !group.actors.includes(actor)) return null;
  group.actors = group.actors.filter((a) => a !== actor);
  return group.actors.length ? groups : groups.filter((g) => g !== group);
}

// The folders of downloaded and staged files of the cache at file. They go with it.
const filesDir = (file) => path.join(path.dirname(file), FILES_DIR);
const uploadsDir = (file) => path.join(path.dirname(file), UPLOADS_DIR);

function removeFileFolders(file) {
  for (const dir of [filesDir(file), uploadsDir(file)]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_) {
      // A file another process holds; the files module sweeps what no row names at the next start.
    }
  }
}

const sidecars = (file) => [file, `${file}-wal`, `${file}-shm`];

// A value node:sqlite can bind: booleans as 0 and 1, objects as JSON, undefined as NULL.
function bindable(key, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (JSON_FIELDS.has(key) && typeof value === 'object') return JSON.stringify(value);
  return value;
}

const isSqliteError = (err) => err && typeof err === 'object' && (err.code === 'ERR_SQLITE_ERROR' || typeof err.errcode === 'number');

// SQLite's primary result codes that prove the file itself is bad: SQLITE_CORRUPT and SQLITE_NOTADB. Anything else
// (SQLITE_BUSY, SQLITE_LOCKED, an I/O error, a full disk) may pass, so the file stays and the caller tries again later.
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const isBrokenFile = (err) => Boolean(err && typeof err.errcode === 'number' && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(err.errcode & 0xff));

// Deletes the file with its -wal and -shm files. Returns true when none of the three is left: on Windows a virus
// scanner or the indexer can hold a handle past rmSync's retries, and the file then stays.
function removeFiles(file) {
  for (const f of sidecars(file)) {
    try {
      fs.rmSync(f, { force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_) {
      // Checked below.
    }
  }
  return sidecars(file).every((f) => !fs.existsSync(f));
}

class Store {
  constructor(db, file, { now = Date.now, lostUnsent = 0 } = {}) {
    this.db = db;
    this.file = file;
    this.now = now;
    // How many unsent messages a broken file held when it was replaced, for ChatState.lostUnsent.
    this.lostUnsent = lostUnsent;
    this.statements = new Map();
    this.depth = 0;
    this.closed = false;
    this.hidden = new Set();
  }

  // ---- plumbing ----

  q(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  all(sql, ...args) {
    return this.q(sql).all(...args).map((row) => ({ ...row }));
  }

  get(sql, ...args) {
    const row = this.q(sql).get(...args);
    return row ? { ...row } : null;
  }

  run(sql, ...args) {
    return this.q(sql).run(...args);
  }

  // fn() inside BEGIN IMMEDIATE and COMMIT, rolled back when it throws. A transaction inside another runs in a
  // SAVEPOINT: when it throws, its own writes are rolled back and the outer transaction can catch the error and go on.
  // At every level a write SQLite refuses (a full disk, a constraint) surfaces as ChatError('not_saved'); other errors
  // keep their own. fn must be synchronous: a transaction never spans an await.
  tx(fn) {
    if (this.depth > 0) return this.inner(fn);
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      throw isSqliteError(err) ? new ChatError('not_saved', { cause: err }) : err;
    }
    this.depth = 1;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('A store transaction must not be asynchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {
        // SQLite rolled back already, as it does on some errors.
      }
      throw isSqliteError(err) ? new ChatError('not_saved', { cause: err }) : err;
    } finally {
      this.depth = 0;
    }
  }

  inner(fn) {
    const name = `s${this.depth}`;
    try {
      this.db.exec(`SAVEPOINT ${name}`);
    } catch (err) {
      throw isSqliteError(err) ? new ChatError('not_saved', { cause: err }) : err;
    }
    this.depth += 1;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('A store transaction must not be asynchronous');
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
      } catch (_) {
        // SQLite rolled the whole transaction back already; the outer COMMIT then fails as not_saved.
      }
      throw isSqliteError(err) ? new ChatError('not_saved', { cause: err }) : err;
    } finally {
      this.depth -= 1;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try {
      this.db.close();
    } catch (_) {
      // Closed already.
    }
  }

  // Ends the cache of a session (contract 3.4). The rows of every table go first, while the database is still open:
  // secure_delete zeroes their pages, and the checkpoint moves those pages into the file and empties the WAL. Then the
  // database closes and the file goes with its -wal and -shm files. Returns true when no file is left. False means a
  // file stayed, held by another process: its content is erased, meta.schema included, so openStore treats it as
  // broken and tries to replace it again, but the caller must not take it for an empty cache of the new session.
  wipe() {
    if (!this.closed) {
      try {
        this.erase();
      } catch (_) {
        // A database this broken may still go with its file; the return value says whether it did.
      }
    }
    this.close();
    removeFileFolders(this.file);
    return removeFiles(this.file);
  }

  erase() {
    const tables = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all()
      .map((r) => r.name);
    // The cascades take each child row with its parent, so the order doesn't matter.
    this.tx(() => {
      for (const table of tables) this.db.exec(`DELETE FROM "${table.replaceAll('"', '""')}"`);
    });
    this.checkpoint();
  }

  quickCheck() {
    const rows = this.db.prepare('PRAGMA quick_check').all();
    return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
  }

  // Moves what the WAL holds into the file and empties it, so deleted pages don't linger there. Desktop runs it after
  // a workspace is deleted (contract 3.5); it can't run inside a transaction.
  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  setFields(table, fields, allowed, where, keys) {
    const names = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!names.length) return 0;
    const sql = `UPDATE ${table} SET ${names.map((k) => `${k} = ?`).join(', ')} WHERE ${where}`;
    return this.tx(() => Number(this.run(sql, ...names.map((k) => bindable(k, fields[k])), ...keys).changes));
  }

  // ---- meta ----

  getMeta(key) {
    const row = this.get('SELECT value FROM meta WHERE key = ?', key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.tx(() => this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value)));
  }

  deleteMeta(key) {
    this.tx(() => this.run('DELETE FROM meta WHERE key = ?', key));
  }

  // ---- ws ----

  // A workspace the server said is gone but whose rows couldn't be deleted yet (removeWorkspace) is hidden: listWs and
  // getWs leave it out, so nothing reads its cache, until deleteWs succeeds.
  listWs() {
    const rows = this.all('SELECT * FROM ws ORDER BY id');
    return this.hidden.size ? rows.filter((r) => !this.hidden.has(r.id)) : rows;
  }

  getWs(id) {
    if (this.hidden.has(id)) return null;
    return this.get('SELECT * FROM ws WHERE id = ?', id);
  }

  hideWs(id) {
    this.hidden.add(id);
  }

  // A role across the guest line changes the channel directory (contract 3.6 Directory): a demoted guest has none, so
  // it goes at once; a promoted member has none yet, so it is loaded at the next run. Called wherever the role
  // changes: the listing, GET / and the member list.
  roleChanged(id, before, after) {
    if (!before || !after || (before === 'guest') === (after === 'guest')) return;
    if (after === 'guest') this.replaceChannels(id, []);
    else this.updateWs(id, { channelsStale: 1 });
  }

  // A workspace from the listing. One already here keeps everything but its name and role. Other fields of row are
  // set as updateWs sets them.
  insertWs(row) {
    return this.tx(() => {
      const before = this.get('SELECT role FROM ws WHERE id = ?', row.id);
      this.run(
        `INSERT INTO ws (id, name, role) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role`,
        row.id,
        row.name,
        row.role
      );
      const extra = { ...row };
      delete extra.id;
      delete extra.name;
      delete extra.role;
      this.updateWs(row.id, extra);
      if (before) this.roleChanged(row.id, before.role, row.role);
      return this.getWs(row.id);
    });
  }

  updateWs(id, fields) {
    return this.setFields('ws', fields, WS_FIELDS, 'id = ?', [id]);
  }

  // The workspace and everything under it, through the cascade. A hidden one stays hidden while this fails.
  deleteWs(id) {
    const deleted = this.tx(() => Number(this.run('DELETE FROM ws WHERE id = ?', id).changes) > 0);
    this.hidden.delete(id);
    return deleted;
  }

  // ---- rooms ----

  listRooms(ws) {
    return this.all('SELECT * FROM room WHERE ws = ? ORDER BY id', ws);
  }

  getRoom(ws, id) {
    return this.get('SELECT * FROM room WHERE ws = ? AND id = ?', ws, id);
  }

  // A room row from the feed (wire.checkRoom), with the rules of contract 3.6:
  // - a new room comes in uncached, with readLocal and readSent at the server's read;
  // - a grant other than the cached one empties the cache first, and outbox rows keep the old grant;
  // - every field is updated, readLocal and readSent rise to read, and events below floor go.
  // keepLocal false also forgets what this device read and cached, as for a new room; muted and notified stay.
  // The badges are the server's; the caller recounts them with countBadges when readLocal is ahead (3.9).
  //
  // readMark (rich contract 3.2) counts how often the person marked the room unread. A row with a higher one than the
  // cached is the first since a Mark unread: read, readLocal and readSent take its read, also when that is lower, and
  // this device holds back its reads of the room until it opens it again. A row with a lower one left the server
  // before the last Mark unread this device knows of, so its read position and badges are from before it and stay
  // out; everything else of the row counts. A new grant has a readMark of its own: the row's replaces the cached one,
  // and the hold of the old grant ends.
  // Returns { row, inserted, grantChanged, dropped }: dropped lists the message IDs the floor took.
  upsertRoom(ws, feed, { keepLocal = true } = {}) {
    return this.tx(() => {
      const before = this.getRoom(ws, feed.conversation);
      const grantChanged = Boolean(before && before.grantId !== feed.grant);
      if (before && (grantChanged || !keepLocal)) this.dropRoomCache(ws, feed.conversation);
      // What this device read counts only under the grant it read in.
      const local = before && keepLocal && !grantChanged;
      const mark = feed.readMark ?? 0;
      // Older: from before the last Mark unread. Newer: the first row since one. Neither under a new grant.
      const older = grantChanged ? '0' : 'excluded.readMark < room.readMark';
      const newer = grantChanged ? '0' : 'excluded.readMark > room.readMark';
      this.run(
        `INSERT INTO room (ws, id, kind, name, visibility, archived, closedReason, participants, startedBy, grantId, role,
           members, head, floor, lastAt, read, readLocal, readSent, unread, mentions, readMark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ws, id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, visibility = excluded.visibility, archived = excluded.archived,
           closedReason = excluded.closedReason, participants = excluded.participants, startedBy = excluded.startedBy,
           grantId = excluded.grantId, role = excluded.role, members = excluded.members, head = excluded.head,
           floor = excluded.floor, lastAt = excluded.lastAt,
           read = CASE WHEN ${older} THEN room.read ELSE excluded.read END,
           readLocal = CASE WHEN ${older} THEN room.readLocal WHEN ${newer} THEN excluded.read
                            ELSE ${local ? 'MAX(room.readLocal, excluded.read)' : 'excluded.read'} END,
           readSent = CASE WHEN ${older} THEN room.readSent WHEN ${newer} THEN excluded.read
                           ELSE ${local ? 'MAX(room.readSent, excluded.read)' : 'excluded.read'} END,
           unread = CASE WHEN ${older} THEN room.unread ELSE excluded.unread END,
           mentions = CASE WHEN ${older} THEN room.mentions ELSE excluded.mentions END,
           readPaused = ${grantChanged ? '0' : `CASE WHEN ${newer} THEN 1 ELSE room.readPaused END`},
           readMark = ${grantChanged ? 'excluded.readMark' : 'MAX(room.readMark, excluded.readMark)'}`,
        ws,
        feed.conversation,
        feed.kind,
        feed.name ?? null,
        feed.visibility,
        feed.archived ? 1 : 0,
        feed.closedReason ?? null,
        feed.participants ? JSON.stringify(feed.participants) : null,
        feed.startedBy ?? null,
        feed.grant,
        feed.role ?? null,
        feed.members ?? 0,
        feed.head,
        feed.floor,
        feed.lastAt ?? null,
        feed.read,
        feed.read,
        feed.read,
        feed.unread,
        feed.mentions,
        mark
      );
      const dropped = this.applyFloor(ws, feed.conversation, feed.floor);
      return { row: this.getRoom(ws, feed.conversation), inserted: !before, grantChanged, dropped };
    });
  }

  setRoomFields(ws, id, fields) {
    return this.setFields('room', fields, ROOM_FIELDS, 'ws = ? AND id = ?', [ws, id]);
  }

  // The room and its events, queued sends, drafts and notices. Returns how many unsent messages went with it, for the
  // evicted event's droppedSends: 0 when there was no such room, so the count is never negative. A caller that needs
  // to know whether the room was cached asks getRoom first.
  deleteRoom(ws, id) {
    return this.tx(() => {
      const sends = this.get('SELECT COUNT(*) AS n FROM outbox WHERE ws = ? AND room = ?', ws, id).n;
      this.run('DELETE FROM room WHERE ws = ? AND id = ?', ws, id);
      return sends;
    });
  }

  // The room's cached events go and its range empties; the room itself stays.
  dropRoomCache(ws, id) {
    this.tx(() => {
      this.run('DELETE FROM event WHERE ws = ? AND room = ?', ws, id);
      this.run('UPDATE room SET lo = NULL, hi = NULL WHERE ws = ? AND id = ?', ws, id);
    });
  }

  // ---- pass ----

  putPassRoom(ws, row) {
    this.tx(() =>
      this.run(
        'INSERT INTO pass_room (ws, id, row) VALUES (?, ?, ?) ON CONFLICT (ws, id) DO UPDATE SET row = excluded.row',
        ws,
        row.conversation,
        JSON.stringify(row)
      )
    );
  }

  // A room a page of the pass evicted: the install then deletes it with everything under it.
  deletePassRooms(ws, ids) {
    this.tx(() => {
      for (const id of ids) this.run('DELETE FROM pass_room WHERE ws = ? AND id = ?', ws, id);
    });
  }

  listPassRooms(ws) {
    return this.all('SELECT row FROM pass_room WHERE ws = ? ORDER BY id', ws).map((r) => JSON.parse(r.row));
  }

  clearPass(ws) {
    this.tx(() => this.run('DELETE FROM pass_room WHERE ws = ?', ws));
  }

  // ---- events ----

  // Writes checked events (wire.checkEvent) and returns the rows as stored. A tombstoned message is stored removed, a
  // removed one never gets its text back, and a message.redacted removes its target and tombstones it.
  //
  // Rich messages (rich contract 3.1): a message keeps its files, cards and reactions as the server sent them. Reaction
  // and card events are stored like every event, so the range stays contiguous, and change their target when it is
  // cached. A message carries its reactions and cards as they were when its answer was made: asOf is the seq they are
  // current to, the page's or feed answer's head (at least the message's own seq). Each cached message keeps its asOf,
  // and a reaction or card event changes it only when the event is newer, after which the event's seq is its asOf. So
  // an older page can't take back what came in meanwhile, the events of a page that its messages already hold apply
  // nothing, and applying one twice changes nothing. touched, a Set, collects the IDs of cached messages whose
  // reactions or cards changed, for the updated event.
  writeEvents(ws, room, events, { touched = null, asOf = null } = {}) {
    const stored = [];
    const messages = new Set();
    let from = Infinity;
    // A message cached with newer reactions and cards than these keeps them.
    const newer = 'COALESCE(event.asOf, event.seq) > excluded.asOf';
    for (const e of events) {
      const message = e.kind === 'message.posted';
      const removed = message && (e.redacted === true || this.hasTombstone(ws, e.id));
      const data = {};
      for (const [k, v] of Object.entries(e)) if (!EVENT_COLUMNS.has(k) && !(message && RICH_COLUMNS.has(k))) data[k] = v;
      const rich = message && !removed;
      const current = rich ? Math.max(e.seq, asOf ?? 0) : null;
      this.run(
        `INSERT INTO event (ws, room, seq, id, kind, actor, at, root, text, mentions, data, redacted, attachments, previews, reactions, asOf)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ws, room, seq) DO UPDATE SET
           id = excluded.id, kind = excluded.kind, actor = excluded.actor, at = excluded.at, root = excluded.root,
           text = CASE WHEN event.redacted = 1 OR excluded.redacted = 1 THEN NULL ELSE excluded.text END,
           mentions = CASE WHEN event.redacted = 1 OR excluded.redacted = 1 THEN NULL ELSE excluded.mentions END,
           attachments = CASE WHEN event.redacted = 1 OR excluded.redacted = 1 THEN NULL ELSE excluded.attachments END,
           previews = CASE WHEN event.redacted = 1 OR excluded.redacted = 1 THEN NULL WHEN ${newer} THEN event.previews ELSE excluded.previews END,
           reactions = CASE WHEN event.redacted = 1 OR excluded.redacted = 1 THEN NULL WHEN ${newer} THEN event.reactions ELSE excluded.reactions END,
           asOf = CASE WHEN event.redacted = 1 OR excluded.redacted = 1 THEN NULL ELSE MAX(COALESCE(event.asOf, event.seq), excluded.asOf) END,
           data = excluded.data, redacted = MAX(event.redacted, excluded.redacted)`,
        ws,
        room,
        e.seq,
        e.id,
        e.kind,
        e.actor,
        e.at,
        e.root ?? null,
        rich ? e.text : null,
        rich ? JSON.stringify(e.mentions || []) : null,
        Object.keys(data).length ? JSON.stringify(data) : null,
        removed ? 1 : 0,
        rich ? listColumn(e.attachments) : null,
        rich ? listColumn(e.previews) : null,
        rich ? listColumn(e.reactions) : null,
        current
      );
      if (e.kind === 'message.redacted' && e.target) {
        this.addTombstones(ws, [e.target]);
        this.redact(ws, [e.target]);
      }
      if (rich) {
        messages.add(e.id);
        from = Math.min(from, current);
      }
      if (CHANGE_KINDS.has(e.kind) && this.applyChange(ws, room, e) && touched) touched.add(e.target);
      stored.push(e.seq);
    }
    // The cached reaction and card events newer than these messages' reactions and cards, on top of them in order.
    if (messages.size) {
      const later = this.all(
        `SELECT seq, kind, actor, data FROM event WHERE ws = ? AND room = ? AND seq > ?
           AND kind IN ('reaction.added', 'reaction.removed', 'message.previewed') ORDER BY seq`,
        ws,
        room,
        from
      );
      for (const row of later) {
        const data = parseData(row.data);
        if (!messages.has(data.target)) continue;
        this.applyChange(ws, room, { ...data, kind: row.kind, actor: row.actor, seq: row.seq });
      }
    }
    return stored.map((seq) => this.eventAt(ws, room, seq)).filter(Boolean);
  }

  // A reaction or card event on its cached target, a message of the room that isn't removed, when the event is newer
  // than what the target holds (its asOf), which then becomes the event's seq. An event without a seq (this device's
  // own reaction or card removal, as the server answered it) always applies. Returns whether the target changed.
  applyChange(ws, room, e) {
    if (!e || typeof e.target !== 'string') return false;
    const target = this.get('SELECT room, seq, kind, redacted, previews, reactions, asOf FROM event WHERE ws = ? AND id = ?', ws, e.target);
    if (!target || target.room !== room || target.kind !== 'message.posted' || target.redacted) return false;
    const seq = Number.isSafeInteger(e.seq) ? e.seq : null;
    if (seq !== null && seq <= (target.asOf ?? target.seq)) return false;
    let column = null;
    let value = null;
    if (e.kind === 'message.previewed') {
      value = listColumn(Array.isArray(e.previews) ? e.previews : []);
      if (value !== target.previews) column = 'previews';
    } else {
      const next = reactionChange(jsonList(target.reactions), e.emoji, e.actor, e.kind === 'reaction.added');
      if (next) {
        column = 'reactions';
        value = listColumn(next);
      }
    }
    if (column) this.run(`UPDATE event SET ${column} = ?, asOf = COALESCE(?, asOf) WHERE ws = ? AND room = ? AND seq = ?`, value, seq, ws, room, target.seq);
    else if (seq !== null) this.run('UPDATE event SET asOf = ? WHERE ws = ? AND room = ? AND seq = ?', seq, ws, room, target.seq);
    return Boolean(column);
  }

  // This device's own reaction, answered by the server (chatReact): the cached message changes at once, before its
  // reaction event comes through the feed, which then changes nothing. Returns whether it changed.
  react(ws, room, message, emoji, actor, on) {
    return this.tx(() => this.applyChange(ws, room, { kind: on ? 'reaction.added' : 'reaction.removed', target: message, emoji, actor }));
  }

  // A message's cards as the server answered after the author removed one. Returns whether it changed.
  setPreviews(ws, room, message, previews) {
    return this.tx(() => this.applyChange(ws, room, { kind: 'message.previewed', target: message, previews }));
  }

  // Events after the cached range, ascending: hi rises to the last, lo is set when the room had no cache, head follows,
  // and a room over ROOM_CACHE_MAX loses its lowest events. The caller checks that they start at hi + 1 (3.6). asOf as
  // for writeEvents.
  appendEvents(ws, room, events, { max = ROOM_CACHE_MAX, touched = null, asOf = null } = {}) {
    if (!events.length) return [];
    return this.tx(() => {
      const stored = this.writeEvents(ws, room, events, { touched, asOf });
      const first = events[0].seq;
      const last = events[events.length - 1].seq;
      this.run('UPDATE room SET lo = COALESCE(lo, ?), hi = MAX(COALESCE(hi, ?), ?), head = MAX(head, ?) WHERE ws = ? AND id = ?', first, last, last, last, ws, room);
      this.trimRoom(ws, room, max);
      return stored.filter((row) => this.eventAt(ws, room, row.seq));
    });
  }

  // Events before the cached range, ascending: lo falls to the first, hi is set when the room had no cache.
  prependEvents(ws, room, events, { touched = null, asOf = null } = {}) {
    if (!events.length) return [];
    return this.tx(() => {
      const stored = this.writeEvents(ws, room, events, { touched, asOf });
      const first = events[0].seq;
      const last = events[events.length - 1].seq;
      this.run('UPDATE room SET lo = MIN(COALESCE(lo, ?), ?), hi = COALESCE(hi, ?), head = MAX(head, ?) WHERE ws = ? AND id = ?', first, first, last, last, ws, room);
      return stored;
    });
  }

  // The newest limit events below seq, ascending.
  eventsBefore(ws, room, seq, limit) {
    return this.all('SELECT * FROM event WHERE ws = ? AND room = ? AND seq < ? ORDER BY seq DESC LIMIT ?', ws, room, seq, limit).reverse();
  }

  // limit events from seq up, ascending.
  eventsFrom(ws, room, seq, limit) {
    return this.all('SELECT * FROM event WHERE ws = ? AND room = ? AND seq >= ? ORDER BY seq LIMIT ?', ws, room, seq, limit);
  }

  eventById(ws, id) {
    return this.get('SELECT * FROM event WHERE ws = ? AND id = ?', ws, id);
  }

  eventAt(ws, room, seq) {
    return this.get('SELECT * FROM event WHERE ws = ? AND room = ? AND seq = ?', ws, room, seq);
  }

  // The cached replies to a thread root, in order.
  replies(ws, room, root) {
    return this.all('SELECT * FROM event WHERE ws = ? AND room = ? AND root = ? ORDER BY seq', ws, room, root);
  }

  // For each root: { count, lastSeq, lastAt } of its cached replies, removed ones included, because a removed reply
  // keeps its row. Roots without replies are left out.
  replyCounts(ws, room, roots) {
    const out = {};
    const sql = `SELECT COUNT(*) AS count, MAX(seq) AS lastSeq, MAX(at) AS lastAt FROM event
                 WHERE ws = ? AND room = ? AND root = ? AND kind = 'message.posted'`;
    for (const root of roots) {
      const row = this.get(sql, ws, room, root);
      if (row && row.count > 0) out[root] = { count: row.count, lastSeq: row.lastSeq, lastAt: row.lastAt };
    }
    return out;
  }

  // Retention's floor: events below it go; lo rises to it, or the range empties when hi is below it. Returns the IDs
  // of the messages that went, so the notifier can take their alerts back: the cached ones, and those an alert showed
  // by its notice row's seq, as an alert may show a message the cache never held.
  applyFloor(ws, room, floor) {
    return this.tx(() => {
      const gone = this.all(`SELECT id FROM event WHERE ws = ? AND room = ? AND seq < ? AND kind = 'message.posted'`, ws, room, floor).map((r) => r.id);
      for (const n of this.all('SELECT message FROM notice WHERE ws = ? AND room = ? AND seq < ?', ws, room, floor)) {
        if (!gone.includes(n.message)) gone.push(n.message);
      }
      this.run('DELETE FROM event WHERE ws = ? AND room = ? AND seq < ?', ws, room, floor);
      // The floor is stored with the deletion, also from a page of a pass that hasn't installed yet: a history page
      // that comes in meanwhile is checked against it, so it can't put back what retention removed.
      this.run(
        `UPDATE room SET lo = CASE WHEN hi IS NULL OR hi < ? THEN NULL ELSE MAX(lo, ?) END,
                         hi = CASE WHEN hi IS NULL OR hi < ? THEN NULL ELSE hi END,
                         floor = MAX(floor, ?)
         WHERE ws = ? AND id = ?`,
        floor,
        floor,
        floor,
        floor,
        ws,
        room
      );
      return gone;
    });
  }

  // Removed messages lose their text and mentions, and their files, cards and reactions, in any room of the workspace.
  // Returns { [room]: ids } for the ones that were cached with text, so the service can emit redacted.
  redact(ws, ids) {
    return this.tx(() => {
      const out = {};
      for (const id of ids) {
        const row = this.get('SELECT room, redacted FROM event WHERE ws = ? AND id = ?', ws, id);
        if (!row) continue;
        this.run(
          'UPDATE event SET text = NULL, mentions = NULL, attachments = NULL, previews = NULL, reactions = NULL, redacted = 1 WHERE ws = ? AND id = ?',
          ws,
          id
        );
        if (!row.redacted) (out[row.room] ||= []).push(id);
      }
      return out;
    });
  }

  // At most max events in the room: the lowest go and lo moves up. Returns how many went.
  trimRoom(ws, room, max = ROOM_CACHE_MAX) {
    return this.tx(() => {
      const count = this.get('SELECT COUNT(*) AS n FROM event WHERE ws = ? AND room = ?', ws, room).n;
      if (count <= max) return 0;
      const cut = this.get('SELECT seq FROM event WHERE ws = ? AND room = ? ORDER BY seq DESC LIMIT 1 OFFSET ?', ws, room, max - 1).seq;
      const gone = Number(this.run('DELETE FROM event WHERE ws = ? AND room = ? AND seq < ?', ws, room, cut).changes);
      this.run('UPDATE room SET lo = ? WHERE ws = ? AND id = ?', cut, ws, room);
      return gone;
    });
  }

  // Every cached event of the workspace, and every room's range.
  deleteWsEvents(ws) {
    this.tx(() => {
      this.run('DELETE FROM event WHERE ws = ?', ws);
      this.run('UPDATE room SET lo = NULL, hi = NULL WHERE ws = ?', ws);
    });
  }

  // The badges of the cached messages after a read position (contract 3.9): unread counts messages that aren't the
  // person's own and aren't removed; mentions counts the ones of those that name me, from authors the person hasn't
  // blocked. blocked is a list of u_ IDs, or the workspace's block rows when omitted. Each is capped at 100. The
  // caller checks that the cache covers the range.
  countBadges(ws, room, after, me, blocked) {
    const list = Array.isArray(blocked) ? blocked : this.listBlocks(ws).map((b) => b.member);
    const unread = this.get(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM event WHERE ws = ? AND room = ? AND seq > ? AND kind = 'message.posted'
         AND actor != ? AND redacted = 0 LIMIT 100)`,
      ws,
      room,
      after,
      me
    ).n;
    const mentions = this.get(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM event e WHERE e.ws = ? AND e.room = ? AND e.seq > ? AND e.kind = 'message.posted'
         AND e.actor != ? AND e.redacted = 0
         AND e.actor NOT IN (SELECT value FROM json_each(?))
         AND EXISTS (SELECT 1 FROM json_each(e.mentions) m WHERE json_extract(m.value, '$.actor') = ?)
         LIMIT 100)`,
      ws,
      room,
      after,
      me,
      JSON.stringify(list),
      me
    ).n;
    return { unread, mentions };
  }

  // ---- tombstones ----

  addTombstones(ws, ids, at = this.now()) {
    this.tx(() => {
      for (const id of ids) {
        this.run('INSERT INTO tombstone (ws, message, at) VALUES (?, ?, ?) ON CONFLICT (ws, message) DO NOTHING', ws, id, at);
      }
    });
  }

  hasTombstone(ws, id) {
    return Boolean(this.get('SELECT 1 AS x FROM tombstone WHERE ws = ? AND message = ?', ws, id));
  }

  // Tombstones from before the time go; a pass that installs prunes those older than 14 days.
  pruneTombstones(ws, before) {
    return this.tx(() => Number(this.run('DELETE FROM tombstone WHERE ws = ? AND at < ?', ws, before).changes));
  }

  // ---- directory ----

  // Each replaces the workspace's rows and clears its stale flag.
  replaceMembers(ws, rows, more = false) {
    this.tx(() => {
      this.run('DELETE FROM member WHERE ws = ?', ws);
      for (const m of rows) {
        this.run('INSERT INTO member (ws, id, kind, name, role, state, joinedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', ws, m.id, m.kind, m.name, m.role, m.state, m.joinedAt);
      }
      this.run('UPDATE ws SET membersStale = 0, membersMore = ? WHERE id = ?', more ? 1 : 0, ws);
    });
  }

  listMembers(ws) {
    return this.all('SELECT id, kind, name, role, state, joinedAt FROM member WHERE ws = ? ORDER BY id', ws);
  }

  replaceChannels(ws, rows) {
    this.tx(() => {
      this.run('DELETE FROM channel WHERE ws = ?', ws);
      for (const c of rows) {
        this.run(
          'INSERT INTO channel (ws, id, name, visibility, archived, joined, role, members) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ws,
          c.id,
          c.name,
          c.visibility,
          c.archived ? 1 : 0,
          c.joined ? 1 : 0,
          c.role ?? null,
          c.members
        );
      }
      this.run('UPDATE ws SET channelsStale = 0 WHERE id = ?', ws);
    });
  }

  listChannels(ws) {
    return this.all('SELECT id, name, visibility, archived, joined, role, members FROM channel WHERE ws = ? ORDER BY id', ws).map((c) => ({
      ...c,
      archived: Boolean(c.archived),
      joined: Boolean(c.joined)
    }));
  }

  replaceBlocks(ws, rows) {
    this.tx(() => {
      this.run('DELETE FROM block WHERE ws = ?', ws);
      for (const b of rows) this.run('INSERT INTO block (ws, member, at) VALUES (?, ?, ?)', ws, b.member, b.at);
      this.run('UPDATE ws SET blocksStale = 0 WHERE id = ?', ws);
    });
  }

  // Newest first, as GET /blocks lists them.
  listBlocks(ws) {
    return this.all('SELECT member, at FROM block WHERE ws = ? ORDER BY at DESC, member', ws);
  }

  // ---- outbox ----

  // A message to send, written before anything goes out (contract 3.8). mentions are stored as the wire's JSON, and
  // attachments as the File objects it sends (rich contract 3.5), whose IDs go on the wire.
  insertOutbox(row) {
    this.tx(() =>
      this.run(
        `INSERT INTO outbox (local, ws, room, actor, grantId, generation, text, mentions, root, operationId, state, reason, attempts, nextAt, createdAt, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.local,
        row.ws,
        row.room,
        row.actor,
        row.grantId,
        row.generation,
        row.text,
        JSON.stringify(row.mentions || []),
        row.root ?? null,
        row.operationId ?? null,
        row.state ?? 'queued',
        row.reason ?? null,
        row.attempts ?? 0,
        row.nextAt ?? 0,
        row.createdAt ?? this.now(),
        JSON.stringify(row.attachments || [])
      )
    );
    return this.getOutbox(row.local);
  }

  getOutbox(local) {
    return this.get('SELECT * FROM outbox WHERE local = ?', local);
  }

  updateOutbox(local, fields) {
    return this.setFields('outbox', fields, OUTBOX_FIELDS, 'local = ?', [local]);
  }

  deleteOutbox(local) {
    return this.tx(() => Number(this.run('DELETE FROM outbox WHERE local = ?', local).changes) > 0);
  }

  // The room's unsent messages, oldest first. Two written in the same millisecond keep the order they were written in:
  // outbox is a rowid table, and a new row's rowid is above every rowid in the table.
  outboxForRoom(ws, room) {
    return this.all('SELECT * FROM outbox WHERE ws = ? AND room = ? ORDER BY createdAt, rowid', ws, room);
  }

  outboxForWs(ws) {
    return this.all('SELECT * FROM outbox WHERE ws = ? ORDER BY createdAt, rowid', ws);
  }

  // The sends whose turn it is, oldest first, at most limit: per room only its oldest row, and only when that row is
  // queued and due. A row sending, held or failed holds back the later rows of its room. Workspaces that aren't ok
  // send nothing.
  nextDue(now, limit) {
    return this.all(
      `SELECT o.* FROM outbox o JOIN ws w ON w.id = o.ws
       WHERE w.state = 'ok' AND o.state = 'queued' AND o.nextAt <= ?
         AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.ws = o.ws AND p.room = o.room
                         AND (p.createdAt < o.createdAt OR (p.createdAt = o.createdAt AND p.rowid < o.rowid)))
       ORDER BY o.createdAt, o.rowid LIMIT ?`,
      now,
      limit
    );
  }

  countUnsent() {
    return this.get('SELECT COUNT(*) AS n FROM outbox').n;
  }

  // After a restore or Start over: every queued, sending and held/stale_grant row of the workspace, or only those
  // written under generation when given, waits for a lookup of its operation before anything else (contract 3.8).
  // Returns how many rows it marked.
  markLookup(ws, generation = null) {
    return this.tx(() => {
      const one = generation !== null && generation !== undefined;
      return Number(
        this.run(
          `UPDATE outbox SET state = 'queued', reason = 'lookup', nextAt = 0
           WHERE ws = ?${one ? ' AND generation = ?' : ''}
             AND (state IN ('queued', 'sending') OR (state = 'held' AND reason = 'stale_grant'))`,
          ...(one ? [ws, generation] : [ws])
        ).changes
      );
    });
  }

  // ---- drafts ----

  // root null is the room's main composer. attachments: the ready files the draft keeps, File objects with expiresAt.
  getDraft(ws, room, root) {
    const row = this.get('SELECT text, mentions, attachments, at FROM draft WHERE ws = ? AND room = ? AND root = ?', ws, room, root || '');
    return row ? { text: row.text, mentions: JSON.parse(row.mentions), attachments: jsonList(row.attachments), at: row.at } : null;
  }

  putDraft(ws, room, root, draft) {
    this.tx(() =>
      this.run(
        `INSERT INTO draft (ws, room, root, text, mentions, attachments, at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ws, room, root) DO UPDATE SET text = excluded.text, mentions = excluded.mentions,
           attachments = excluded.attachments, at = excluded.at`,
        ws,
        room,
        root || '',
        draft.text,
        JSON.stringify(draft.mentions || []),
        JSON.stringify(draft.attachments || []),
        this.now()
      )
    );
  }

  deleteDraft(ws, room, root) {
    this.tx(() => this.run('DELETE FROM draft WHERE ws = ? AND room = ? AND root = ?', ws, room, root || ''));
  }

  // ---- notices ----

  addNotices(ws, room, rows) {
    this.tx(() => {
      for (const n of rows) {
        this.run(
          'INSERT INTO notice (ws, room, message, seq) VALUES (?, ?, ?, ?) ON CONFLICT (ws, room, message) DO UPDATE SET seq = excluded.seq',
          ws,
          room,
          n.message,
          n.seq
        );
      }
    });
  }

  noticesForRoom(ws, room) {
    return this.all('SELECT message, seq FROM notice WHERE ws = ? AND room = ? ORDER BY seq', ws, room);
  }

  // The room's notices for those messages, or all of them when messages is omitted. Returns the ones that went.
  deleteNotices(ws, room, messages) {
    return this.tx(() => {
      const rows = this.noticesForRoom(ws, room).filter((n) => !messages || messages.includes(n.message));
      for (const n of rows) this.run('DELETE FROM notice WHERE ws = ? AND room = ? AND message = ?', ws, room, n.message);
      return rows;
    });
  }

  // ---- downloaded files (rich contract 4.6) ----

  // The cached message of the room that holds file f_ as one of its files or as a card's image: { message, file }
  // with the File object, or null.
  messageWithFile(ws, room, file) {
    const needle = `"id":"${file}"`;
    const rows = this.all(
      `SELECT id, attachments, previews FROM event WHERE ws = ? AND room = ? AND kind = 'message.posted' AND redacted = 0
         AND (instr(attachments, ?) > 0 OR instr(previews, ?) > 0) ORDER BY seq DESC LIMIT 5`,
      ws,
      room,
      needle,
      needle
    );
    for (const row of rows) {
      const found = jsonList(row.attachments).find((f) => f && f.id === file) || jsonList(row.previews).map((p) => p && p.image).find((f) => f && f.id === file);
      if (found) return { message: row.id, file: found };
    }
    return null;
  }

  getCachedFile(ws, file) {
    return this.get('SELECT * FROM file_cache WHERE ws = ? AND file = ?', ws, file);
  }

  putCachedFile(row) {
    this.tx(() =>
      this.run(
        `INSERT INTO file_cache (ws, room, file, message, sha256, size, name, type, usedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ws, file) DO UPDATE SET room = excluded.room, message = COALESCE(excluded.message, file_cache.message),
           sha256 = excluded.sha256, size = excluded.size, name = excluded.name, type = excluded.type, usedAt = excluded.usedAt`,
        row.ws,
        row.room,
        row.file,
        row.message ?? null,
        row.sha256,
        row.size,
        row.name,
        row.type,
        row.usedAt ?? this.now()
      )
    );
  }

  touchCachedFile(ws, file, at = this.now()) {
    this.tx(() => this.run('UPDATE file_cache SET usedAt = ? WHERE ws = ? AND file = ?', at, ws, file));
  }

  // The rows of removed messages' files go; the files module then deletes what no row names any more.
  dropCachedFilesOf(ws, messages) {
    return this.tx(() => {
      let n = 0;
      for (const message of messages) n += Number(this.run('DELETE FROM file_cache WHERE ws = ? AND message = ?', ws, message).changes);
      return n;
    });
  }

  deleteCachedFile(ws, file) {
    this.tx(() => this.run('DELETE FROM file_cache WHERE ws = ? AND file = ?', ws, file));
  }

  // Each downloaded file once, with its size and when any row of it was last used, least recently used first.
  cachedFiles() {
    return this.all('SELECT sha256, MAX(size) AS size, MAX(usedAt) AS usedAt FROM file_cache GROUP BY sha256 ORDER BY usedAt, sha256');
  }

  // Every row of one downloaded file goes, for the size limit.
  forgetCachedSha(sha256) {
    this.tx(() => this.run('DELETE FROM file_cache WHERE sha256 = ?', sha256));
  }

  hasCachedSha(sha256) {
    return Boolean(this.get('SELECT 1 AS x FROM file_cache WHERE sha256 = ? LIMIT 1', sha256));
  }
}

// What a file that can't be used still says about its unsent messages, or 0.
function countOutbox(db) {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
  } catch (_) {
    return 0;
  }
}

function connect(DatabaseSync, file) {
  const db = new DatabaseSync(file);
  try {
    db.exec(PRAGMAS);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

// The file's state: 'ok' for a cache of this schema, 'empty' for a new file, 'old' for one of an earlier version that
// migrates, 'broken' for one to replace.
function inspect(db) {
  const check = db.prepare('PRAGMA quick_check').all();
  if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') return 'broken';
  if (!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table'`).get()) return 'empty';
  if (!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get()) return 'broken';
  const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get();
  if (version && version.value === String(SCHEMA_VERSION)) return 'ok';
  const from = version ? Number(version.value) : NaN;
  return Number.isSafeInteger(from) && from >= 1 && from < SCHEMA_VERSION ? 'old' : 'broken';
}

// SQLite's result codes that say nothing about the file: it is busy or locked elsewhere, the disk failed or is full,
// or it can't be opened now. A migration that fails with one leaves the file for the next attempt.
const PASSING = new Set([5, 6, 10, 13, 14]);
const passing = (err) => Boolean(err && typeof err.errcode === 'number' && PASSING.has(err.errcode & 0xff));

// The migrations from version from up to SCHEMA_VERSION, in one transaction with the new meta.schema.
function migrate(db, from) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]);
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema'`).run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // SQLite rolled back already.
    }
    throw err;
  }
}

// Opens the cache at file, or makes it. A file that fails PRAGMA quick_check, isn't a database, or has another
// meta.schema (a newer Rukoo's) is deleted and made again; how many unsent messages it still held is in
// store.lostUnsent (contract 3.4). Only that proof replaces a file: a lock another connection holds, or an I/O error,
// is thrown as it is, and the file with its unsent messages and drafts stays for the service's next attempt. Throws
// too when node:sqlite itself can't open a database here, and ChatError('not_saved') when a file to replace can't be
// deleted; the service then shows the storage state and tries again.
function openStore(file, { now = Date.now } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lostUnsent = 0;
  let db = null;
  let state = 'broken';
  try {
    db = connect(DatabaseSync, file);
    state = inspect(db);
  } catch (err) {
    if (!isBrokenFile(err)) {
      try {
        if (db) db.close();
      } catch (_) {
        // Closed already.
      }
      throw err;
    }
    // Not a database, or a corrupt one: counted as far as it can be, then replaced.
    state = 'broken';
  }
  if (state === 'old') {
    // An earlier version migrates in place (rich contract 4.2). A migration that fails for the file's sake replaces
    // it as a broken one would be (contract 3.4); one the disk or a lock stopped leaves it for the next attempt.
    try {
      const from = Number(db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get().value);
      migrate(db, from);
      state = 'ok';
    } catch (err) {
      if (passing(err)) {
        db.close();
        throw err;
      }
      state = 'broken';
    }
  }
  if (state === 'broken') {
    if (db) {
      lostUnsent = countOutbox(db);
      try {
        db.close();
      } catch (_) {
        // Closed already.
      }
    }
    if (!removeFiles(file)) throw new ChatError('not_saved');
    // The downloaded files of the replaced cache go with it.
    removeFileFolders(file);
    db = connect(DatabaseSync, file);
    state = 'empty';
  }
  if (state === 'empty') {
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(SCHEMA);
      db.prepare(`INSERT INTO meta (key, value) VALUES ('schema', ?)`).run(String(SCHEMA_VERSION));
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {
        // Nothing began.
      }
      db.close();
      throw err;
    }
  }
  return new Store(db, file, { now, lostUnsent });
}

module.exports = {
  openStore,
  Store,
  SCHEMA,
  SCHEMA_V1,
  MIGRATIONS,
  PRAGMAS,
  SCHEMA_VERSION,
  ROOM_CACHE_MAX,
  reactionChange,
  filesDir,
  uploadsDir
};
