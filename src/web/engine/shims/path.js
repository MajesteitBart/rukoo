'use strict';

// path for the browser build: '/'-separated names for the in-memory cache, which the WorkspaceService builds with
// join(dataDir, 'chat.db') and store.js takes apart with dirname(). No name here reaches a disk.
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

module.exports = { sep, join, dirname, basename, normalize };
