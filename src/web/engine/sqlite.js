'use strict';

/*! sql.js 1.15.2 (https://github.com/sql-js/sql.js) | MIT license | Copyright (c) 2017 sql.js authors
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
 * OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */

// node:sqlite's DatabaseSync for the browser, over sql.js (SQLite 3.54.0 compiled to WebAssembly, JSON functions
// included). The web build aliases node:sqlite to this file, so src/main/workspaces/store.js runs unchanged: its
// statements are synchronous, and a transaction never spans an await, which only a synchronous SQLite can keep.
//
// What it covers is what store.js uses: prepare() with all(), get() and run() ({ changes, lastInsertRowid }), exec(),
// close(), positional parameters (and node's named-parameter object), and errors with node's shape: code
// ERR_SQLITE_ERROR, errcode (SQLite's extended result code) and errstr. sql.js reports only the message, so errcode is
// read back from it (errcodeOf below). One difference stays: a PRIMARY KEY violation reads as SQLITE_CONSTRAINT_UNIQUE
// (2067) where node says SQLITE_CONSTRAINT_PRIMARYKEY (1555), because SQLite words both "UNIQUE constraint failed".
// The primary code, 19, which is what store.js looks at, is the same.
//
// Every database is in memory, whatever path it gets: the chat cache doesn't outlive the page (the server keeps the
// history). sql.js must be loaded before the first database: await init() once.
const initSqlJs = require('sql.js/dist/sql-wasm-browser.js');

let SQL = null;
let loading = null;

// The WebAssembly at url, instantiated with sql.js's imports. A missing file or an error page is refused here, with
// its status, before anything tries to compile it.
async function instantiate(url, imports) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`sql.js: ${url} answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error(`sql.js: ${url} is not WebAssembly`);
  return WebAssembly.instantiate(bytes, imports);
}

// initSqlJs with a locateFile. Left to itself, sql.js fetches and compiles the file, and when that fails it aborts: its
// promise rejects, but the abort is also thrown into a promise nobody holds (an unhandled rejection in the page) and
// each step is logged as a console error. Through instantiateWasm the file is fetched and compiled here instead, so a
// failure (a 404, a CSP without 'wasm-unsafe-eval') is this one rejection; sql.js then waits for an instance that never
// comes, which holds nothing.
function startSqlJs(options) {
  if (options.wasmBinary || typeof options.instantiateWasm === 'function' || typeof options.locateFile !== 'function') return initSqlJs(options);
  let fail;
  const failed = new Promise((_, reject) => (fail = reject));
  const url = options.locateFile('sql-wasm-browser.wasm', '');
  const instantiateWasm = (imports, done) => {
    instantiate(url, imports).then((result) => done(result.instance), fail);
    return {};
  };
  return Promise.race([initSqlJs({ ...options, instantiateWasm }), failed]);
}

// source: an initialised sql.js module (anything with a Database class), or the options of initSqlJs, such as
// { locateFile: (name) => url } or { wasmBinary: bytes }. Later calls return the first module, whatever they pass.
function init(source = {}) {
  if (SQL) return Promise.resolve(SQL);
  if (!loading) {
    loading = (async () => {
      const module = source && typeof source.Database === 'function' ? source : await startSqlJs(source || {});
      if (!module || typeof module.Database !== 'function') throw new Error('sql.js did not load');
      SQL = module;
      return SQL;
    })();
    // A failed load can be tried again.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

const ready = () => Boolean(SQL);

// ---- errors ----

// sqlite3_errstr() of each primary result code: what node:sqlite puts in errstr, and the message sqlite3_errmsg()
// gives when there is no more specific one.
const ERRSTR = {
  1: 'SQL logic error',
  3: 'access permission denied',
  4: 'query aborted',
  5: 'database is locked',
  6: 'database table is locked',
  7: 'out of memory',
  8: 'attempt to write a readonly database',
  9: 'interrupted',
  10: 'disk I/O error',
  11: 'database disk image is malformed',
  12: 'unknown operation',
  13: 'database or disk is full',
  14: 'unable to open database file',
  15: 'locking protocol',
  17: 'database schema has changed',
  18: 'string or blob too big',
  19: 'constraint failed',
  20: 'datatype mismatch',
  21: 'bad parameter or other API misuse',
  22: 'large file support is disabled',
  23: 'authorization denied',
  25: 'column index out of range',
  26: 'file is not a database',
  27: 'notification message',
  28: 'warning message'
};

// Messages sqlite3_errmsg() words itself, with the extended code that goes with each.
const SPECIFIC = [
  [/^UNIQUE constraint failed/, 2067],
  [/^NOT NULL constraint failed/, 1299],
  [/^CHECK constraint failed/, 275],
  [/^FOREIGN KEY constraint failed/, 787],
  [/^abort due to ROLLBACK/, 516],
  [/^malformed database schema/, 11],
  [/^database table is locked/, 6],
  [/^not authorized/, 23]
];

const BY_ERRSTR = new Map(Object.entries(ERRSTR).map(([code, text]) => [text, Number(code)]));

// The extended result code for an sqlite3_errmsg() text. Anything SQLite words itself and isn't listed above, such as
// a syntax error or "no such table", is SQLITE_ERROR, as it is in SQLite.
function errcodeOf(message) {
  const text = String(message || '');
  if (BY_ERRSTR.has(text)) return BY_ERRSTR.get(text);
  for (const [re, code] of SPECIFIC) if (re.test(text)) return code;
  return 1;
}

function sqliteError(message) {
  const errcode = errcodeOf(message);
  const err = new Error(message);
  err.code = 'ERR_SQLITE_ERROR';
  err.errcode = errcode;
  err.errstr = ERRSTR[errcode & 0xff] || ERRSTR[1];
  return err;
}

function invalidState(message) {
  const err = new Error(message);
  err.code = 'ERR_INVALID_STATE';
  return err;
}

function invalidArg(message) {
  const err = new TypeError(message);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

// What sql.js threw, as node:sqlite would have thrown it. sql.js throws a plain Error with SQLite's message for
// anything SQLite refused, and a string for its own misuse checks.
function mapError(raw) {
  if (raw && (raw.code === 'ERR_SQLITE_ERROR' || raw.code === 'ERR_INVALID_STATE' || raw.code === 'ERR_INVALID_ARG_TYPE')) return raw;
  if (typeof raw === 'string') {
    if (raw === 'Database closed') return invalidState('database is not open');
    // node:sqlite says this for a finalized statement, and also for SQL that holds no statement at all.
    if (raw === 'Statement closed' || raw === 'Nothing to prepare') return invalidState('statement has been finalized');
    if (raw.startsWith('Wrong API use')) return invalidArg(raw);
    return sqliteError(raw);
  }
  if (raw instanceof Error && Object.getPrototypeOf(raw) === Error.prototype) return sqliteError(raw.message);
  // A WebAssembly trap or a bug of ours: as it is.
  return raw;
}

// ---- values ----

const isNamed = (v) => v !== null && typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer);

// A value as sql.js binds it, refused the way node:sqlite refuses it (undefined and booleans included).
function bindable(value, index) {
  if (value === null || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') {
    // sql.js reads integers back as doubles, so only a safe integer survives the round trip.
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    throw invalidArg(`The web SQLite adapter can't bind ${value} to SQLite parameter ${index}: it reads integers back as doubles.`);
  }
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw invalidArg(`Provided value cannot be bound to SQLite parameter ${index}.`);
}

// node:sqlite's parameters: an optional object of named ones first (bare names match :name, @name and $name), then
// the anonymous ones. sql.js binds either kind in one call, not both.
function parameters(args) {
  if (args.length && isNamed(args[0])) {
    if (args.length > 1) throw invalidArg('The web SQLite adapter binds named or anonymous parameters, not both in one call.');
    const out = {};
    for (const [key, value] of Object.entries(args[0])) {
      const v = bindable(value, key);
      if (/^[:@$]/.test(key)) out[key] = v;
      else for (const prefix of [':', '@', '$']) out[prefix + key] = v;
    }
    return out;
  }
  return args.map((value, i) => bindable(value, i + 1));
}

// A row as node:sqlite returns one: an object without a prototype.
function rowOf(names, values) {
  const row = Object.create(null);
  for (let i = 0; i < names.length; i++) row[names[i]] = values[i];
  return row;
}

// ---- the classes ----

class StatementSync {
  constructor(database, statement, sql) {
    this.database = database;
    this.statement = statement;
    this.sql = sql;
  }

  get sourceSQL() {
    return this.sql;
  }

  // fn() with the parameters bound, the statement reset before and after (as node:sqlite does), so no statement holds
  // a read open between calls, and every error in node's shape.
  call(args, fn) {
    this.database.check();
    const statement = this.statement;
    try {
      statement.reset();
      const params = parameters(args);
      if (Array.isArray(params) ? params.length : Object.keys(params).length) statement.bind(params);
      return fn(statement);
    } catch (err) {
      throw mapError(err);
    } finally {
      try {
        statement.reset();
      } catch (_) {
        // Finalized by close() meanwhile; the error above, if any, is the one that counts.
      }
    }
  }

  all(...args) {
    return this.call(args, (statement) => {
      const rows = [];
      let names = null;
      while (statement.step()) {
        names ||= statement.getColumnNames();
        rows.push(rowOf(names, statement.get()));
      }
      return rows;
    });
  }

  get(...args) {
    return this.call(args, (statement) => (statement.step() ? rowOf(statement.getColumnNames(), statement.get()) : undefined));
  }

  run(...args) {
    return this.call(args, (statement) => {
      while (statement.step()) {
        // A statement with RETURNING yields rows; run() goes through them, as node's does.
      }
      return { changes: this.database.db.getRowsModified(), lastInsertRowid: this.database.lastRowid() };
    });
  }
}

class DatabaseSync {
  // location is kept for what it says; the database itself is always in memory. options.open false waits for open().
  // options.enableForeignKeyConstraints defaults to true, as in node:sqlite.
  constructor(location = ':memory:', options = {}) {
    this.location = String(location);
    this.options = options || {};
    this.db = null;
    this.rowid = null;
    this.statements = new Map();
    if (this.options.open !== false) this.open();
  }

  get isOpen() {
    return Boolean(this.db);
  }

  open() {
    if (this.db) throw invalidState('database is already open');
    if (!SQL) throw new Error('sql.js is not loaded: await init() from src/web/engine/sqlite.js before opening a database');
    try {
      this.db = new SQL.Database();
      // Each database is a file of its own in sql.js's memory, with this one connection. store.js turns WAL on
      // (store.js PRAGMAS); in exclusive locking mode SQLite keeps the WAL index on its heap and never maps a -shm
      // file, which Emscripten's file system only emulates.
      this.db.run('PRAGMA locking_mode = EXCLUSIVE');
      if (this.options.enableForeignKeyConstraints !== false) this.db.run('PRAGMA foreign_keys = ON');
    } catch (err) {
      this.db = null;
      throw mapError(err);
    }
  }

  check() {
    if (!this.db) throw invalidState('database is not open');
  }

  exec(sql) {
    this.check();
    try {
      this.db.run(String(sql));
    } catch (err) {
      throw mapError(err);
    }
  }

  // One statement per SQL text, kept until close(). sql.js holds every statement in WebAssembly memory until it's freed
  // or the database closes, and a discarded wrapper frees nothing, so preparing the same text again (store.js
  // countOutbox, the schema checks) reuses it instead of growing the heap. Sharing is safe: every call() resets the
  // statement before and after, and all of it runs synchronously.
  prepare(sql) {
    this.check();
    const text = String(sql);
    const kept = this.statements.get(text);
    if (kept) return kept;
    try {
      const statement = new StatementSync(this, this.db.prepare(text), text);
      this.statements.set(text, statement);
      return statement;
    } catch (err) {
      throw mapError(err);
    }
  }

  // sqlite3_last_insert_rowid(), which sql.js doesn't export, through a statement kept for it.
  lastRowid() {
    this.rowid ||= this.db.prepare('SELECT last_insert_rowid() AS id');
    try {
      return this.rowid.step() ? this.rowid.get()[0] : 0;
    } finally {
      this.rowid.reset();
    }
  }

  // sql.js frees every statement of the database with it, so a statement used afterwards says the database is closed.
  close() {
    this.check();
    const db = this.db;
    this.db = null;
    this.rowid = null;
    this.statements = new Map();
    try {
      db.close();
    } catch (err) {
      throw mapError(err);
    }
  }
}

module.exports = { init, ready, DatabaseSync, StatementSync, errcodeOf };
