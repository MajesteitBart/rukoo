'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ZOOM_LEVELS, normalizeZoom, nextZoom, zoomKey } = require('../src/main/zoom');
const { Engine } = require('../src/main/engine');

// An input as webContents' before-input-event reports it for Ctrl plus a key.
const ctrl = (key, code, extra = {}) => ({ type: 'keyDown', key, code, control: true, shift: false, alt: false, meta: false, ...extra });

test('zoom steps in and out through the levels and stops at both ends', () => {
  assert.deepEqual(ZOOM_LEVELS, [80, 90, 100, 110, 125, 150, 175, 200]);
  assert.equal(nextZoom(100, 'in'), 110);
  assert.equal(nextZoom(110, 'in'), 125);
  assert.equal(nextZoom(125, 'in'), 150);
  assert.equal(nextZoom(100, 'out'), 90);
  assert.equal(nextZoom(90, 'out'), 80);
  assert.equal(nextZoom(200, 'in'), 200);
  assert.equal(nextZoom(80, 'out'), 80);
  assert.equal(nextZoom(175, 'reset'), 100);
  assert.equal(nextZoom(125, 'sideways'), 125);
  // From a value between steps, a step starts at the nearest level.
  assert.equal(nextZoom(118, 'in'), 150);
});

test('a stored zoom level snaps to the nearest step, and anything else falls back to 100', () => {
  assert.equal(normalizeZoom(125), 125);
  assert.equal(normalizeZoom(130), 125);
  assert.equal(normalizeZoom(10), 80);
  assert.equal(normalizeZoom(900), 200);
  for (const value of [undefined, null, '125', NaN, Infinity, true, {}]) assert.equal(normalizeZoom(value), 100, String(value));
});

test('zoom keys cover the US keys, the numpad and other layouts, and leave other shortcuts alone', () => {
  assert.equal(zoomKey(ctrl('=', 'Equal')), 'in');
  assert.equal(zoomKey(ctrl('+', 'Equal', { shift: true })), 'in');
  assert.equal(zoomKey(ctrl('+', 'NumpadAdd')), 'in');
  // German and Dutch layouts have a key of their own for "+".
  assert.equal(zoomKey(ctrl('+', 'BracketRight')), 'in');
  assert.equal(zoomKey(ctrl('-', 'Minus')), 'out');
  assert.equal(zoomKey(ctrl('_', 'Minus', { shift: true })), 'out');
  assert.equal(zoomKey(ctrl('-', 'NumpadSubtract')), 'out');
  assert.equal(zoomKey(ctrl('-', 'Slash')), 'out');
  assert.equal(zoomKey(ctrl('0', 'Digit0')), 'reset');
  assert.equal(zoomKey(ctrl('0', 'Numpad0')), 'reset');
  // AZERTY: the 0 key types "à".
  assert.equal(zoomKey(ctrl('à', 'Digit0')), 'reset');

  // Numpad 0 with Num Lock off is Insert: Ctrl+Insert copies.
  assert.equal(zoomKey(ctrl('Insert', 'Numpad0')), null);
  // Only the US "=" key zooms in. German keyboards type "=" with Shift+0, which counts as the 0 key.
  assert.equal(zoomKey(ctrl('=', 'Digit0', { shift: true })), 'reset');
  assert.equal(zoomKey(ctrl('=', 'BracketRight')), null);
  // AltGr arrives as Ctrl+Alt and types characters.
  assert.equal(zoomKey(ctrl('-', 'Minus', { alt: true })), null);
  assert.equal(zoomKey({ ...ctrl('=', 'Equal'), control: false }), null);
  assert.equal(zoomKey(ctrl('=', 'Equal', { meta: true })), null);
  assert.equal(zoomKey(ctrl('=', 'Equal', { type: 'keyUp' })), null);
  for (const [key, code] of [['j', 'KeyJ'], ['n', 'KeyN'], ['z', 'KeyZ'], ['1', 'Digit1'], ['Enter', 'Enter']]) {
    assert.equal(zoomKey(ctrl(key, code)), null, key);
  }
  assert.equal(zoomKey(null), null);
});

test('the zoom level is saved in settings.json, normalized on load, and a quiet save does not redraw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-zoom-'));
  try {
    const engine = new Engine({ dataDir: dir }).init();
    assert.equal(engine.settings.zoomLevel, 100);
    let updates = 0;
    engine.on('updated', () => updates++);
    assert.equal(engine.updateSettings({ zoomLevel: 125 }, { quiet: true }).zoomLevel, 125);
    assert.equal(updates, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).zoomLevel, 125);
    assert.equal(new Engine({ dataDir: dir }).init().settings.zoomLevel, 125);

    engine.updateSettings({ zoomLevel: 'big' });
    assert.equal(engine.settings.zoomLevel, 100);
    assert.equal(updates, 1);

    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ zoomLevel: 133 }));
    assert.equal(new Engine({ dataDir: dir }).init().settings.zoomLevel, 125);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
