'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const i18n = require('../src/i18n');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export /g, '');
}

test('Mac shortcut labels use Command in both languages without changing user values', () => {
  const context = vm.createContext({ RukooI18n: i18n, mail: { platform: 'darwin' } });
  vm.runInContext(`${source('i18n.js')}\nglobalThis.labels = { t, shortcutLabel };`, context);
  try {
    for (const language of ['en', 'nl']) {
      i18n.setLanguage(language);
      assert.match(context.labels.t('composer.actions.sendShortcut'), /⌘\+Enter/);
      assert.equal(context.labels.shortcutLabel('Ctrl+Shift+R'), '⌘+Shift+R');
      assert.match(context.labels.t('settings.general.mailtoHandler', { app: 'Ctrl Mail' }), /Ctrl Mail/);
    }
    context.mail.platform = 'linux';
    assert.match(context.labels.t('composer.actions.sendShortcut'), /Ctrl\+Enter/);
  } finally {
    i18n.setLanguage('en');
  }
});

test('native Edit menu routes text editing to Chromium and mailbox actions to shortcuts', async () => {
  let receive;
  const native = [];
  const styles = new Map();
  const dispatched = [];
  const active = { matches: () => false, isContentEditable: false, dispatchEvent: (event) => dispatched.push(event) };
  const context = vm.createContext({
    ...i18n,
    window: {
      matchMedia: () => ({}),
      addEventListener() {},
      mail: { platform: 'darwin', on: (listener) => { receive = listener; }, call: async (...args) => native.push(args) }
    },
    document: { activeElement: active, documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } }, addEventListener() {} },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  });
  vm.runInContext(source('ui.js'), context);
  for (const action of ['undo', 'redo', 'selectAll']) receive({ type: 'menu-edit', payload: { action } });
  assert.deepEqual(dispatched.map((event) => [event.key, event.metaKey, event.shiftKey]), [
    ['z', true, false], ['z', true, true], ['a', true, false]
  ]);
  assert.ok(dispatched.every((event) => event.bubbles && event.cancelable));
  active.matches = () => true;
  receive({ type: 'menu-edit', payload: { action: 'undo' } });
  active.matches = () => false;
  active.isContentEditable = true;
  receive({ type: 'menu-edit', payload: { action: 'selectAll' } });
  receive({ type: 'menu-edit', payload: { action: 'unrecognized' } });
  assert.deepEqual(native, [['nativeEdit', 'undo'], ['nativeEdit', 'selectAll']]);
  assert.equal(dispatched.length, 3);
  for (const percent of [80, 100, 150, 200]) {
    receive({ type: 'zoom', payload: percent });
    const inset = parseFloat(styles.get('--mac-titlebar-inset'));
    assert.equal(inset * percent / 100, 86, `native controls retain 86 screen pixels at ${percent}%`);
  }
  receive({ type: 'zoom', payload: 0 });
  assert.equal(styles.get('--mac-titlebar-inset'), '43px');
  context.window.mail.platform = 'linux';
  receive({ type: 'zoom', payload: 100 });
  assert.equal(styles.get('--mac-titlebar-inset'), '43px', 'Linux chrome is unaffected');
});
