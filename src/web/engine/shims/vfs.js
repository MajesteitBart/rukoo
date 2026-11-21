'use strict';

// The browser build's file system: files held in memory as Blobs under '/'-separated names (shims/path.js), for what
// src/main/workspaces/files.js keeps on disk on desktop: staged uploads (chat-uploads/), the download cache
// (chat-files/), the copies chatFile 'open' and 'save' make, and the files a person picked (src/web/files.js puts them
// here). shims/fs.js and shims/fs-promises.js are Node's API over it. The chat cache itself (chat.db) never comes
// here: sqlite.js keeps it in memory, so store.js and the service still find no file of it.
//
// Folders exist once something made them (mkdir) or a file is under them, as far as readdir and exists can tell. A
// page reload starts empty: the cache's files go with the page, and the server has them.
const path = require('./path');

// name -> Blob
const files = new Map();
// Folders mkdir made, which stay until rm takes them.
const dirs = new Set();
// fn({ type: 'put' | 'remove', path, blob }) for every change, for src/web/files.js.
const watchers = new Set();

const norm = (name) => path.normalize(String(name));

function code(err, name, syscall) {
  const e = new Error(`${err}: no such file or directory, ${syscall} '${name}'`);
  e.code = err;
  e.errno = err === 'ENOENT' ? -2 : -1;
  e.syscall = syscall;
  e.path = name;
  return e;
}

function notify(type, name, blob) {
  for (const fn of [...watchers]) {
    try {
      fn({ type, path: name, blob });
    } catch (err) {
      // A watcher's failure (a download the browser refused) doesn't undo the change.
      console.error('[web] a file watcher failed', err);
    }
  }
}

const inside = (name, dir) => name.startsWith(dir === '/' ? '/' : `${dir}/`);

function isDir(name) {
  if (dirs.has(name)) return true;
  for (const f of files.keys()) if (inside(f, name)) return true;
  for (const d of dirs) if (inside(d, name)) return true;
  return false;
}

// What is at name: 'file', 'dir' or null.
function kind(name) {
  const n = norm(name);
  if (files.has(n)) return 'file';
  return isDir(n) ? 'dir' : null;
}

function get(name) {
  return files.get(norm(name)) || null;
}

// data: a Blob, bytes (any typed array or ArrayBuffer) or a string, as fs.writeFile takes them.
function toBlob(data) {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  if (typeof data === 'string') return new Blob([data]);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data]);
  throw new TypeError('The data must be a string, a Blob or bytes');
}

function put(name, data) {
  const n = norm(name);
  if (dirs.has(n)) throw code('EISDIR', n, 'open');
  const blob = toBlob(data);
  const before = files.get(n);
  files.set(n, blob);
  if (before) notify('remove', n, before);
  notify('put', n, blob);
  return blob;
}

function mkdir(name) {
  const n = norm(name);
  if (files.has(n)) throw code('EEXIST', n, 'mkdir');
  // Every folder on the way, as mkdir { recursive: true } makes them.
  for (let d = n; d && d !== '.' && d !== '/'; d = path.dirname(d)) dirs.add(d);
}

// Removes a file, or a folder with everything in it when recursive. Returns whether something went.
function remove(name, { recursive = false } = {}) {
  const n = norm(name);
  const blob = files.get(n);
  if (blob) {
    files.delete(n);
    notify('remove', n, blob);
    return true;
  }
  if (!isDir(n)) return false;
  const under = [...files.keys()].filter((f) => inside(f, n));
  if (!recursive && (under.length || [...dirs].some((d) => inside(d, n)))) throw code('ENOTEMPTY', n, 'rmdir');
  for (const f of under) {
    const b = files.get(f);
    files.delete(f);
    notify('remove', f, b);
  }
  for (const d of [...dirs]) if (d === n || inside(d, n)) dirs.delete(d);
  return true;
}

function rename(from, to) {
  const a = norm(from);
  const b = norm(to);
  const blob = files.get(a);
  if (!blob) throw code('ENOENT', a, 'rename');
  if (a === b) return;
  files.delete(a);
  notify('remove', a, blob);
  put(b, blob);
}

// The names directly in a folder.
function list(name) {
  const n = norm(name);
  if (files.has(n)) throw code('ENOTDIR', n, 'scandir');
  if (!isDir(n)) throw code('ENOENT', n, 'scandir');
  const out = new Set();
  const cut = n === '/' ? 1 : n.length + 1;
  for (const f of [...files.keys(), ...dirs]) {
    if (!inside(f, n)) continue;
    const rest = f.slice(cut);
    if (rest) out.add(rest.split('/')[0]);
  }
  return [...out];
}

// Every file under a folder, at any depth.
function under(name) {
  const n = norm(name);
  return [...files.keys()].filter((f) => inside(f, n));
}

function watch(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

// Everything goes, for tests.
function reset() {
  files.clear();
  dirs.clear();
}

module.exports = { get, put, mkdir, remove, rename, list, under, kind, watch, reset, error: code, size: () => files.size };
