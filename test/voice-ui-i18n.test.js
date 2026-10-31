'use strict';

// Rukoo Voice's pill and Settings keep every string in voice/ui/i18n/en.json (English, with descriptions) and
// nl.json (Dutch). These checks follow test/i18n.test.js for Rukoo's own catalogs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ui = path.join(__dirname, '..', 'voice', 'ui');
const en = JSON.parse(fs.readFileSync(path.join(ui, 'i18n', 'en.json'), 'utf8'));
const nl = JSON.parse(fs.readFileSync(path.join(ui, 'i18n', 'nl.json'), 'utf8'));

const forms = (value) => (typeof value === 'string' ? [value] : Object.values(value));
const parameters = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();

// The files the pages load. dev/ holds development tools, which use no catalog strings.
function sources() {
  const files = [];
  for (const dir of ['', 'lib', 'mock']) {
    for (const name of fs.readdirSync(path.join(ui, dir))) {
      if (/\.(js|html)$/.test(name)) files.push(path.join(ui, dir, name));
    }
  }
  return files.map((file) => ({ file: path.relative(ui, file), text: fs.readFileSync(file, 'utf8') }));
}

// Every quoted string that looks like a catalog key, and every data-i18n* attribute. The lookarounds keep one
// string's closing quote from hiding the next one's opening quote, as in `title="${t('common.back')}"`.
const QUOTED_KEY = /(?<=['"`])((?:common|pill|settings|app)(?:\.[A-Za-z0-9]+)+)(?=['"`])/g;
const FILE = /\.(?:css|js|html|json|woff2|txt|md)$/;
function usedKeys() {
  const used = new Map();
  for (const { file, text } of sources()) {
    for (const [, key] of text.matchAll(QUOTED_KEY)) if (!FILE.test(key)) used.set(key, file);
    for (const [, key] of text.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) used.set(key, file);
  }
  return used;
}

test('en.json and nl.json have the same keys', () => {
  assert.deepEqual(Object.keys(nl).sort(), Object.keys(en).sort());
  assert.ok(Object.keys(en).length > 100, 'en.json lost its strings');
});

test('every English entry has a message and a description with context', () => {
  for (const [key, entry] of Object.entries(en)) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'message'], key);
    assert.ok(typeof entry.description === 'string' && entry.description.length > 15, `Missing context: ${key}`);
    for (const text of forms(entry.message)) assert.ok(typeof text === 'string' && text.trim().length, `Empty source: ${key}`);
  }
});

test('translations keep every placeholder and plural form', () => {
  for (const [key, entry] of Object.entries(en)) {
    const source = forms(entry.message);
    for (const text of source) assert.deepEqual(parameters(text), parameters(source[0]), `Source parameters differ between forms: ${key}`);
    const dutch = nl[key];
    if (typeof entry.message === 'object') {
      assert.ok(entry.message.other, `Missing English plural fallback: ${key}`);
      assert.equal(typeof dutch, 'object', `Missing plural forms: nl.${key}`);
      assert.ok(dutch.other, `Missing plural fallback: nl.${key}`);
      for (const category of Object.keys(entry.message)) assert.ok(dutch[category], `Missing ${category}: nl.${key}`);
      assert.ok(parameters(source[0]).includes('count'), `A plural needs {count}: ${key}`);
    } else {
      assert.equal(typeof dutch, 'string', `Expected a string: nl.${key}`);
    }
    for (const text of forms(dutch)) {
      assert.ok(typeof text === 'string' && text.trim().length, `Empty translation: nl.${key}`);
      assert.deepEqual(parameters(text), parameters(source[0]), `Parameters: nl.${key}`);
    }
  }
});

test('every key the pages use exists in both catalogs', () => {
  const used = usedKeys();
  assert.ok(used.size > 100, 'found too few keys; did the scan break?');
  for (const [key, file] of used) {
    assert.ok(key in en, `${file} uses ${key}, which en.json lacks`);
    assert.ok(key in nl, `${file} uses ${key}, which nl.json lacks`);
  }
});

test('keys are written out in full, so the checks above can see them', () => {
  for (const { file, text } of sources()) {
    assert.doesNotMatch(text, /\bt(?:Html)?\(\s*`[^`]*\$\{/, `${file} builds a catalog key at run time`);
    assert.doesNotMatch(text, /\bt(?:Html)?\(\s*['"][\w.]+\.['"]\s*\+/, `${file} concatenates a catalog key`);
  }
});

test('every string is used by a page or by the app', () => {
  const used = usedKeys();
  const api = fs.readFileSync(path.join(ui, 'API.md'), 'utf8');
  for (const key of Object.keys(en)) {
    if (key.startsWith('app.')) assert.ok(api.includes(`\`${key}\``), `${key} is for the app, so API.md lists it`);
    else assert.ok(used.has(key), `${key} is never used`);
  }
});

test('the strings API.md says the app reads exist in both catalogs', () => {
  const api = fs.readFileSync(path.join(ui, 'API.md'), 'utf8');
  const section = api.slice(api.indexOf('### Strings the app reads'), api.indexOf('## Settings'));
  const keys = [...section.matchAll(/`((?:pill|settings|app)\.[\w.]+)`/g)].map((match) => match[1]);
  assert.ok(keys.includes('pill.stopButton') && keys.includes('settings.title') && keys.includes('app.tray.quit'));
  for (const key of keys) assert.ok(key in en && key in nl, `API.md names ${key}, which the catalogs lack`);
});

test('the two HTML pages are localized from the catalogs', () => {
  const settings = fs.readFileSync(path.join(ui, 'settings.html'), 'utf8');
  assert.match(settings, /<title data-i18n="settings\.title">/);
});
