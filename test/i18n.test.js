'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const i18n = require('../src/i18n');
const en = require('../src/i18n/en');
const nl = require('../src/i18n/nl');
const { Engine } = require('../src/main/engine');

test.beforeEach(() => i18n.setLanguage('en'));

const forms = (value) => typeof value === 'string' ? [value] : Object.values(value);
const parameters = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();

test('registered catalogs have all keys, context, plural forms, and matching named parameters', () => {
  for (const language of i18n.languages) {
    const catalog = require(`../src/i18n/${language.code}`);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort(), language.code);
    for (const [key, entry] of Object.entries(en)) {
      assert.ok(entry.description.length > 15, `Missing context: ${key}`);
      const sourceForms = forms(entry.message);
      for (const text of sourceForms) {
        assert.ok(typeof text === 'string' && text.length, `Empty source: ${key}`);
        assert.deepEqual(parameters(text), parameters(sourceForms[0]), `Source parameters: ${key}`);
      }
      const translated = language.code === 'en' ? catalog[key].message : catalog[key];
      if (typeof entry.message === 'object') {
        assert.equal(typeof translated, 'object', `Missing plural forms: ${language.code}.${key}`);
        assert.ok(translated.other, `Missing plural fallback: ${language.code}.${key}`);
        for (const category of Object.keys(entry.message)) assert.ok(translated[category], `Missing ${category}: ${language.code}.${key}`);
      }
      for (const text of forms(translated)) {
        assert.ok(typeof text === 'string' && text.length, `Empty translation: ${language.code}.${key}`);
        assert.deepEqual(parameters(text), parameters(sourceForms[0]), `Parameters: ${language.code}.${key}`);
      }
    }
  }
});

test('all source translation references and persistent DOM labels exist in the English catalog', () => {
  for (const directory of ['main', 'renderer']) {
    for (const filename of fs.readdirSync(path.join(__dirname, '../src', directory))) {
      if (!/\.(js|html)$/.test(filename)) continue;
      const source = fs.readFileSync(path.join(__dirname, '../src', directory, filename), 'utf8');
      for (const match of source.matchAll(/\bt\(['"]([^'"]+)['"]|data-i18n(?:-[\w-]+)?="([\w.]+)"/g)) {
        const key = match[1] || match[2];
        assert.ok(en[key], `Unknown key ${key} in ${directory}/${filename}`);
      }
    }
  }
});

test('English is the default; missing translations and unsupported preferences fall back to English', () => {
  assert.equal(i18n.getLanguage(), 'en');
  assert.equal(i18n.t('mailbox.folders.inbox'), 'Inbox');
  i18n.setLanguage('nl');
  assert.equal(i18n.t('mailbox.folders.inbox'), 'Postvak IN');
  const saved = nl['mailbox.folders.inbox'];
  delete nl['mailbox.folders.inbox'];
  try {
    assert.equal(i18n.t('mailbox.folders.inbox'), 'Inbox');
  } finally {
    nl['mailbox.folders.inbox'] = saved;
  }
  i18n.setLanguage('unsupported');
  assert.equal(i18n.getLanguage(), 'en');
  assert.throws(() => i18n.t('missing.key'), /Unknown translation key/);
});

test('interpolation keeps user text literal and plural rules handle zero, one, and many', () => {
  assert.equal(i18n.t('setup.account.added', { email: '<b>{count}</b>' }), '<b>{count}</b> has been added');
  assert.throws(() => i18n.t('setup.account.added'), /Missing translation parameter email/);
  assert.equal(i18n.t('native.notifications.newCount', { count: 0 }), '0 new emails');
  assert.equal(i18n.t('native.notifications.newCount', { count: 1 }), '1 new email');
  assert.equal(i18n.t('native.notifications.newCount', { count: 3 }), '3 new emails');
  i18n.setLanguage('nl');
  assert.equal(i18n.t('settings.aliases.count', { count: 1 }), '1 alias');
  assert.equal(i18n.t('settings.aliases.count', { count: 3 }), '3 aliassen');
});

test('the same catalogs load in the sandboxed renderer and update document language', () => {
  const document = { documentElement: {} };
  const context = vm.createContext({ document, Intl });
  for (const filename of ['en.js', 'nl.js', 'index.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/i18n', filename), 'utf8'), context);
  }
  assert.equal(context.RukooI18n.t('composer.actions.send'), 'Send');
  context.RukooI18n.setLanguage('nl');
  assert.equal(context.RukooI18n.t('composer.actions.send'), 'Verzenden');
  assert.equal(document.documentElement.lang, 'nl');
  assert.equal(document.documentElement.dir, 'ltr');
});

test('language persists across restarts, migrates old profiles to English, and leaves folder paths intact', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-i18n-'));
  const engine = new Engine({ dataDir }).init();
  try {
    assert.equal(engine.settings.language, 'en');
    const account = await engine.addAccount({ type: 'demo' });
    await engine.syncAccount(account.id);
    const before = engine.state().accounts[0].folders;
    assert.equal(before.find((folder) => folder.role === 'inbox').name, 'Inbox');
    engine.updateSettings({ language: 'nl' });
    const after = engine.state().accounts[0].folders;
    assert.deepEqual(after.map((folder) => folder.path), before.map((folder) => folder.path));
    assert.equal(after.find((folder) => folder.role === 'inbox').name, 'Postvak IN');
    await engine.close();
    const restarted = new Engine({ dataDir }).init();
    assert.equal(restarted.settings.language, 'nl');
    restarted.updateSettings({ language: 'unknown' });
    assert.equal(restarted.settings.language, 'en');
    await restarted.close();
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    const legacy = new Engine({ dataDir }).init();
    assert.equal(legacy.settings.language, 'en');
    assert.equal(legacy.settings.theme, 'dark');
    await legacy.close();
  } finally {
    await engine.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('date and size formatting follow the selected interface language', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui.js'), 'utf8')
    .split('// ---------- previews ----------')[0]
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export /g, '');
  const context = vm.createContext({ ...i18n, Intl, window: {}, document: {} });
  vm.runInContext(`${source}\nglobalThis.format = { groupLabel, longDate, readerDate, fileSize };`, context);
  const date = new Date(2026, 9, 7, 14, 45).getTime();
  assert.equal(context.format.groupLabel(date, date), 'Today');
  assert.match(context.format.longDate(date), /October/);
  assert.equal(context.format.fileSize(1.5 * 1024 * 1024), '1.5 MB');
  i18n.setLanguage('nl');
  assert.equal(context.format.groupLabel(date, date), 'Vandaag');
  assert.match(context.format.longDate(date), /oktober/);
  assert.equal(context.format.fileSize(1.5 * 1024 * 1024), '1,5 MB');
});
