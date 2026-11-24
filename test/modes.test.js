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

test('without a mail account Chat is the tab that stays: its switch is locked and a stored list cannot hide it', async () => {
  const { canHide, withMode, modeFor } = await load();
  // The sequence that locked people out: Use Chat only, Calendar back on, then Chat off.
  const chatOnly = ['mail', 'calendar', 'meeting'];
  assert.deepEqual(main.visibleModes(chatOnly, true, false), ['chat']);
  const calendarBack = withMode(chatOnly, 'calendar', false, true, false);
  assert.deepEqual(calendarBack, ['mail', 'meeting']);
  assert.deepEqual(main.visibleModes(calendarBack, true, false), ['calendar', 'chat']);
  assert.equal(canHide(calendarBack, 'chat', true, false), false, 'Calendar shows, but it needs a mail account');
  assert.equal(withMode(calendarBack, 'chat', true, true, false), null);
  // Mail, Calendar and Meet can still go: Chat remains.
  assert.equal(canHide([], 'mail', true, false), true);
  assert.equal(canHide(['mail'], 'calendar', true, false), true);

  // A list stored before this rule (or edited by hand) that hides Chat: Chat shows anyway, and the window lands there.
  assert.deepEqual(main.visibleModes(['mail', 'meeting', 'chat'], true, false), ['calendar', 'chat']);
  assert.equal(main.modeHidden(['mail', 'meeting', 'chat'], 'chat', true, false), false, 'its alerts come back too');
  assert.equal(modeFor('calendar', ['mail', 'meeting', 'chat'], true, false), 'calendar');
  assert.equal(modeFor('mail', ['mail', 'meeting', 'chat'], true, false), 'chat', 'the first mode that can be used');
  assert.deepEqual(main.visibleModes(['calendar', 'meeting', 'chat'], true, false), ['mail', 'chat']);

  // With a mail account the rule is the one before: Mail is the fallback.
  assert.deepEqual(main.visibleModes(['mail', 'calendar', 'meeting'], false, true), ['mail']);
  assert.equal(canHide(['mail', 'meeting'], 'chat', true, true), true, 'Calendar can be used with a mail account');
  // Neither a mail account nor team chat: the setup page's case, where Mail stands in.
  assert.deepEqual(main.visibleModes(['mail', 'calendar', 'meeting'], false, false), ['mail']);
});

test('a stored list that turned Chat off, without a mail account, leaves the other switches free', async () => {
  const { canHide, withMode } = await load();
  // Chat shows although the list turns it off: it is what stays without a mail account. Calendar can still go and
  // come back, and the change saves the list as the tabs showed it, with Chat on.
  const stored = ['mail', 'meeting', 'chat'];
  assert.deepEqual(main.visibleModes(stored, true, false), ['calendar', 'chat']);
  assert.deepEqual(main.effectiveHidden(stored, true, false), ['mail', 'meeting']);
  assert.equal(canHide(stored, 'calendar', true, false), true, 'Calendar is not the one that has to stay');
  assert.equal(canHide(stored, 'chat', true, false), false, 'Chat is');
  const calendarOff = withMode(stored, 'calendar', true, true, false);
  assert.deepEqual(calendarOff, ['mail', 'calendar', 'meeting']);
  assert.deepEqual(main.visibleModes(calendarOff, true, false), ['chat']);
  assert.deepEqual(withMode(calendarOff, 'calendar', false, true, false), ['mail', 'meeting']);
  // Meet on works the same way: Chat stays on in what is saved.
  assert.deepEqual(withMode(stored, 'meeting', false, true, false), ['mail']);
  // Mail standing in with a mail account, while Chat is away: turning Calendar on saves Mail as on too.
  assert.deepEqual(main.visibleModes(['mail', 'calendar', 'meeting'], false, true), ['mail']);
  assert.deepEqual(withMode(['mail', 'calendar', 'meeting'], 'calendar', false, false, true), ['meeting']);
  // A mode turned off that doesn't show stays off in what is saved, Chat while it is away included.
  assert.deepEqual(main.effectiveHidden(['calendar', 'chat'], false, true), ['calendar', 'chat']);
});

test("main and the window agree on every setting, with and without team chat or a mail account", async () => {
  const renderer = await load();
  for (const hidden of subsets()) {
    for (const chat of [true, false]) {
      for (const mail of [true, false]) {
        const label = `${JSON.stringify(hidden)} chat ${chat} mail ${mail}`;
        assert.deepEqual(renderer.normalizeHidden(hidden), main.normalizeHidden(hidden), label);
        assert.deepEqual(renderer.visibleModes(hidden, chat, mail), main.visibleModes(hidden, chat, mail), label);
        assert.deepEqual(renderer.effectiveHidden(hidden, chat, mail), main.effectiveHidden(hidden, chat, mail), label);
        // What is saved after a change shows the same tabs as before it, apart from the mode switched.
        const shown = main.visibleModes(hidden, chat, mail);
        assert.deepEqual(main.visibleModes(main.effectiveHidden(hidden, chat, mail), chat, mail), shown, label);
        // A switch that shows on is locked only when its mode is the one usable mode left: every other usable mode
        // that shows can go.
        const usableShown = shown.filter((m) => main.usable(m, chat, mail));
        for (const mode of shown) {
          const free = renderer.canHide(hidden, mode, chat, mail);
          const alone = usableShown.length === 0 || (usableShown.length === 1 && usableShown[0] === mode);
          assert.equal(free, !alone, `${label} - ${mode} switch`);
          // Switching it off and on again gives the list the tabs showed.
          if (free) {
            const off = renderer.withMode(hidden, mode, true, chat, mail);
            assert.deepEqual(main.visibleModes(off, chat, mail), shown.filter((m) => m !== mode), `${label} - ${mode} off`);
            assert.deepEqual(main.visibleModes(renderer.withMode(off, mode, false, chat, mail), chat, mail), shown, `${label} - ${mode} back`);
          }
        }
        // Whatever is stored, a mode that can be used shows whenever one can.
        if (chat || mail) assert.ok(main.visibleModes(hidden, chat, mail).some((m) => main.usable(m, chat, mail)), label);
        // What the window offers to switch off always leaves a mode that can be used and shows by itself, without
        // the fallback.
        for (const mode of main.MODES.filter((m) => !hidden.includes(m))) {
          const next = renderer.withMode(hidden, mode, true, chat, mail);
          if (next) assert.ok(main.MODES.some((m) => !next.includes(m) && main.usable(m, chat, mail)), `${label} - ${mode}`);
        }
      }
    }
  }
});
