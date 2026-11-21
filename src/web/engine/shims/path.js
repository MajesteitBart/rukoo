'use strict';

// path for the browser build: '/'-separated names for the in-memory cache and files (shims/vfs.js). The WorkspaceService
// builds them with join(dataDir, 'chat.db'), store.js takes them apart with dirname(), and files.js names files with
// basename() and extname(). No name here reaches a disk.
const sep = '/';

function normalize(name) {
  const absolute = name.startsWith('/');
  const parts = [];
  for (const part of name.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  const out = parts.join('/');
  return absolute ? `/${out}` : out || '.';
}

function join(...names) {
  const joined = names.filter((n) => String(n) !== '').map(String).join('/');
  return joined ? normalize(joined) : '.';
}

function dirname(name) {
  const text = String(name).replace(/\/+$/, '');
  const at = text.lastIndexOf('/');
  if (at < 0) return '.';
  if (at === 0) return '/';
  return text.slice(0, at);
}

function basename(name) {
  const text = String(name).replace(/\/+$/, '');
  return text.slice(text.lastIndexOf('/') + 1);
}

// From the last '.' of the last part on, as Node's: '' for 'a', '.bashrc' or 'a/', '.' for 'a.'.
function extname(name) {
  const base = basename(name);
  const at = base.lastIndexOf('.');
  return at <= 0 ? '' : base.slice(at);
}

module.exports = { sep, join, dirname, basename, extname, normalize };
