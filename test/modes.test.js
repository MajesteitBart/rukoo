'use strict';

// Settings > General > Tabs: which of Mail, Calendar, Meet and Chat show (src/main/modes.js for main's notifications,
// badges and tray; src/renderer/modes.js for the tabs and the setting).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const main = require('../src/main/modes');

// A browser module in a CommonJS package: Node takes it as ESM from a data: URL.
async function load() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/modes.js'), 'utf8');
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

// Every list of hidden modes there can be, as subsets of the four.
const subsets = () => Array.from({ length: 16 }, (_, n) => main.MODES.filter((_, i) => n & (1 << i)));

test('a stored list keeps known modes once, in tab order, and never hides all four', () => {
  assert.deepEqual(main.normalizeHidden(['chat', 'mail', 'mail', 'inbox', 7]), ['mail', 'chat']);
  assert.deepEqual(main.normalizeHidden('mail'), []);
  assert.deepEqual(main.normalizeHidden(null), []);
  assert.deepEqual(main.normalizeHidden(['mail', 'calendar', 'meeting', 'chat']), [], 'one mode always shows');
});

test('hidden modes leave the tabs; Chat shows only while team chat is available', () => {
  assert.deepEqual(main.visibleModes([], true), ['mail', 'calendar', 'meeting', 'chat']);
  assert.deepEqual(main.visibleModes([], false), ['mail', 'calendar', 'meeting']);
  assert.deepEqual(main.visibleModes(['mail'], true), ['calendar', 'meeting', 'chat']);
  assert.deepEqual(main.visibleModes(['mail', 'calendar', 'meeting'], true), ['chat'], 'Chat only');
  assert.deepEqual(main.visibleModes(['calendar', 'meeting', 'chat'], true), ['mail'], 'Mail only');
  assert.equal(main.modeHidden(['mail'], 'mail', true), true);
  assert.equal(main.modeHidden(['mail'], 'calendar', true), false);
  assert.equal(main.modeHidden([], 'chat', false), true, 'the setting cannot bring Chat');
});

test('with nothing left that can show, such as Chat alone while team chat is away, Mail shows', () => {
  assert.deepEqual(main.visibleModes(['mail', 'calendar', 'meeting'], false), ['mail']);
  assert.equal(main.modeHidden(['mail', 'calendar', 'meeting'], 'mail', false), false, 'mail notifications come back with it');
  assert.equal(main.modeHidden(['mail', 'calendar', 'meeting'], 'calendar', false), true);
});

test('the last mode that shows cannot be switched off', async () => {
  const { canHide, withMode } = await load();
  assert.equal(canHide([], 'mail', true), true);
  assert.equal(canHide(['calendar', 'meeting', 'chat'], 'mail', true), false, 'Mail is the only one left');
  assert.equal(canHide(['mail', 'calendar', 'meeting'], 'chat', true), false, 'Chat is the only one left');
  assert.equal(canHide(['calendar', 'meeting'], 'mail', false), false, 'Chat is off the server, so it cannot take over');
  assert.equal(canHide(['calendar', 'meeting'], 'mail', true), true);
  assert.equal(canHide(['mail'], 'mail', true), true, 'a hidden mode can always be switched back');

  assert.deepEqual(withMode([], 'mail', true, true), ['mail']);
  assert.deepEqual(withMode(['mail', 'chat'], 'mail', false, true), ['chat']);
  assert.equal(withMode(['calendar', 'meeting', 'chat'], 'mail', true, true), null);
  assert.equal(withMode([], 'inbox', true, true), null);
});

test('the window leaves a hidden mode for the first one that shows, and keeps one that still shows', async () => {
  const { modeFor } = await load();
  assert.equal(modeFor('mail', ['mail'], true), 'calendar');
  assert.equal(modeFor('chat', [], false), 'mail', 'Chat gone from the server');
  assert.equal(modeFor('meeting', ['mail'], true), 'meeting');
  assert.equal(modeFor('mail', ['mail', 'calendar', 'meeting'], true), 'chat');
});

test('the setting starts empty, is saved across a restart, and a hand-edited list is cleaned', async () => {
  const { tempDir } = require('./tmp');
  const { Engine } = require('../src/main/engine');
  const dir = tempDir('rukoo-modes-');
  try {
    const engine = new Engine({ dataDir: dir }).init();
    assert.deepEqual(engine.settings.hiddenModes, []);
    engine.updateSettings({ hiddenModes: ['mail', 'chat'] });
    const again = new Engine({ dataDir: dir }).init();
    assert.deepEqual(again.settings.hiddenModes, ['mail', 'chat']);
    engine.updateSettings({ hiddenModes: ['mail', 'calendar', 'meeting', 'chat'] });
    assert.deepEqual(engine.settings.hiddenModes, [], 'all four hidden is refused');
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hiddenModes: 'mail' }));
    const edited = new Engine({ dataDir: dir }).init();
    assert.deepEqual(edited.settings.hiddenModes, []);
    await Promise.all([engine.close(), again.close(), edited.close()]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("main and the window agree on every setting, with and without team chat", async () => {
  const renderer = await load();
  for (const hidden of subsets()) {
    for (const chat of [true, false]) {
      assert.deepEqual(renderer.normalizeHidden(hidden), main.normalizeHidden(hidden), JSON.stringify(hidden));
      assert.deepEqual(renderer.visibleModes(hidden, chat), main.visibleModes(hidden, chat), `${JSON.stringify(hidden)} chat ${chat}`);
      // What the window offers to switch off always leaves a mode that shows by itself, without the fallback to Mail.
      for (const mode of main.MODES.filter((m) => !hidden.includes(m))) {
        const next = renderer.withMode(hidden, mode, true, chat);
        if (next) assert.ok(main.MODES.some((m) => !next.includes(m) && (m !== 'chat' || chat)), `${JSON.stringify(hidden)} - ${mode}`);
      }
    }
  }
});
