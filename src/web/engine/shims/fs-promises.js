'use strict';

// fs/promises for the browser build, over the files in memory (shims/vfs.js). What files.js does with it: stat a
// picked or cached file, read an image's header (open, read, close) and a small GIF or WebP whole (readFile), write
// pasted or dropped bytes (writeFile), put a finished download in place (rename), make the copy chatFile 'open' and
// 'save' hand to the host (mkdtemp, copyFile), and delete (rm). mkdir only marks a folder: folders are names.
const path = require('./path');
const vfs = require('./vfs');
const { Buffer } = require('./buffer');

const later = () => new Promise((resolve) => setTimeout(resolve, 0));

function need(name, syscall) {
  const blob = vfs.get(name);
  if (!blob) throw vfs.error(vfs.kind(name) === 'dir' ? 'EISDIR' : 'ENOENT', path.normalize(String(name)), syscall);
  return blob;
}

async function stat(name) {
  const what = vfs.kind(name);
  if (!what) throw vfs.error('ENOENT', path.normalize(String(name)), 'stat');
  const size = what === 'file' ? vfs.get(name).size : 0;
  return {
    size,
    isFile: () => what === 'file',
    isDirectory: () => what === 'dir',
    isSymbolicLink: () => false
  };
}

// A handle for reading parts of a file: read(buffer, offset, length, position) as Node's FileHandle.read.
async function open(name, flags = 'r') {
  if (flags !== 'r') throw new TypeError(`The browser build opens files for reading only, not ${flags}`);
  const blob = need(name, 'open');
  let closed = false;
  return {
    async read(buffer, offset = 0, length = buffer.length - offset, position = 0) {
      if (closed) throw vfs.error('EBADF', String(name), 'read');
      const start = Math.max(0, Number(position) || 0);
      const bytes = new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
      buffer.set(bytes, offset);
      return { bytesRead: bytes.length, buffer };
    },
    async close() {
      closed = true;
    }
  };
}

async function readFile(name, options) {
  const blob = need(name, 'open');
  // As ReadStream in shims/fs.js: the Uint8Array constructor takes an ArrayBuffer of any realm, where Buffer.from's
  // instanceof check doesn't, such as a picked File's from the page that made it.
  const bytes = new Buffer(await blob.arrayBuffer());
  const encoding = typeof options === 'string' ? options : options && options.encoding;
  return encoding ? bytes.toString(encoding) : bytes;
}

async function writeFile(name, data) {
  vfs.put(name, data);
}

async function mkdir(name) {
  vfs.mkdir(name);
}

async function rm(name, { force = false, recursive = false } = {}) {
  if (!vfs.remove(name, { recursive }) && !force) throw vfs.error('ENOENT', path.normalize(String(name)), 'rm');
}

async function unlink(name) {
  need(name, 'unlink');
  vfs.remove(name);
}

async function rename(from, to) {
  vfs.rename(from, to);
}

// The same Blob under another name: Blobs never change, so the copy costs nothing and stays the same when the
// original goes.
async function copyFile(from, to) {
  vfs.put(to, need(from, 'copyfile'));
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// prefix and six random letters, as a new folder.
async function mkdtemp(prefix) {
  await later();
  for (;;) {
    const bytes = new Uint8Array(6);
    globalThis.crypto.getRandomValues(bytes);
    const name = String(prefix) + Array.from(bytes, (b) => LETTERS[b % LETTERS.length]).join('');
    if (vfs.kind(name)) continue;
    vfs.mkdir(name);
    return name;
  }
}

module.exports = { stat, open, readFile, writeFile, mkdir, rm, unlink, rename, copyFile, mkdtemp };
