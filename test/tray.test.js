'use strict';

// The tray's pure parts: the dot on the icon, the tooltip, the two settings, and saving the window's bounds
// when it hides. The tray itself is covered end to end in test/e2e/tray.spec.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const i18n = require('../src/i18n');
const { withDot, tooltip } = require('../src/main/tray');
const { WindowState } = require('../src/main/windowstate');
const { Engine } = require('../src/main/engine');

test.beforeEach(() => i18n.setLanguage('en'));

const DOT = [0x6c, 0x33, 0xd6, 255];
const bitmap = (size, pixel) => Buffer.alloc(size * size * 4).map((_, i) => pixel[i % 4]);
const at = (buf, size, x, y) => [...buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

test('the dot sits in the bottom-right corner with a clear ring, and leaves the rest of the icon alone', () => {
  for (const size of [16, 24, 32]) {
    const white = bitmap(size, [255, 255, 255, 255]);
    const out = withDot(white, size);
    assert.notEqual(out, white);
    assert.deepEqual(at(white, size, size - 1, size - 1), [255, 255, 255, 255], 'the input stays as it was');
    // The middle of the dot is the badge colour, in BGRA.
    const centre = Math.floor(size - size * 0.22);
    assert.deepEqual(at(out, size, centre, centre), DOT, `centre at ${size} px`);
    // The top-left half of the icon is untouched.
    for (let y = 0; y < size / 2; y++) for (let x = 0; x < size / 2; x++) assert.deepEqual(at(out, size, x, y), [255, 255, 255, 255]);
    // On the diagonal towards the corner, a (nearly) transparent ring comes before the dot.
    const diagonal = Array.from({ length: size }, (_, i) => at(out, size, i, i));
    const ring = diagonal.findIndex((p) => p[3] < 128);
    const dot = diagonal.findIndex((p) => p.join() === DOT.join());
    assert.ok(ring > size / 2 && ring < dot, `ring at ${size} px: ${ring}, dot from ${dot}`);
  }
});

test('on a transparent icon the dot is opaque and premultiplied edges stay valid', () => {
  const size = 16;
  const out = withDot(bitmap(size, [0, 0, 0, 0]), size);
  assert.deepEqual(at(out, size, 12, 12), DOT);
  assert.deepEqual(at(out, size, 0, 0), [0, 0, 0, 0]);
  // Premultiplied alpha: no colour channel exceeds the pixel's alpha.
  for (let i = 0; i < out.length; i += 4) assert.ok(Math.max(out[i], out[i + 1], out[i + 2]) <= out[i + 3], `pixel ${i / 4}`);
});

test('the tooltip counts unread mail in the interface language', () => {
  assert.equal(tooltip(0), 'Rukoo Mail');
  assert.equal(tooltip(1), 'Rukoo Mail: 1 unread email');
  assert.equal(tooltip(12), 'Rukoo Mail: 12 unread emails');
  i18n.setLanguage('nl');
  assert.equal(tooltip(1), 'Rukoo Mail: 1 ongelezen e-mail');
  assert.equal(tooltip(12), 'Rukoo Mail: 12 ongelezen e-mails');
  assert.equal(tooltip(0), 'Rukoo Mail');
});

test('close to the tray is on and minimize to the tray off by default; both are saved and normalized', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-tray-'));
  try {
    const engine = new Engine({ dataDir: dir }).init();
    assert.equal(engine.settings.closeToTray, true);
    assert.equal(engine.settings.minimizeToTray, false);
    engine.updateSettings({ closeToTray: false, minimizeToTray: true });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.closeToTray, false);
    assert.equal(saved.minimizeToTray, true);
    const again = new Engine({ dataDir: dir }).init();
    assert.equal(again.settings.closeToTray, false);
    assert.equal(again.settings.minimizeToTray, true);
    // A hand-edited file: anything but false keeps the window in the tray, anything but true leaves minimize as is.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ closeToTray: 'no', minimizeToTray: 'yes' }));
    const edited = new Engine({ dataDir: dir }).init();
    assert.equal(edited.settings.closeToTray, true);
    assert.equal(edited.settings.minimizeToTray, false);
    await Promise.all([engine.close(), again.close(), edited.close()]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the unread count for the tray matches the count of the taskbar badge', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-tray-'));
  try {
    const engine = new Engine({ dataDir: dir }).init();
    const acc = await engine.addAccount({ type: 'demo' });
    await engine.syncAccount(acc.id);
    const unread = engine.unreadCount();
    assert.ok(unread > 0);
    assert.equal(unread, engine.counts('all').all);
    const first = engine.listMessages({ view: 'unread' })[0];
    await engine.setFlags(first.id, { unread: false });
    assert.equal(engine.unreadCount(), unread - 1);
    await engine.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Enough of a BrowserWindow for WindowState.track.
class FakeWindow extends EventEmitter {
  constructor(bounds) {
    super();
    this.bounds = bounds;
    this.minimized = false;
  }
  isDestroyed() {
    return false;
  }
  isMinimized() {
    return this.minimized;
  }
  isMaximized() {
    return false;
  }
  getBounds() {
    return { ...this.bounds };
  }
}

test('the window bounds are saved when the window hides, not only when it closes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-tray-'));
  const file = path.join(dir, 'window-state.json');
  try {
    const state = new WindowState(file);
    const win = new FakeWindow({ x: 100, y: 80, width: 1200, height: 800 });
    state.track('main', win);
    win.emit('hide');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).main, { x: 100, y: 80, width: 1200, height: 800, maximized: false });
    // Minimized to the tray, a window reports no useful bounds: the ones saved before stay.
    win.bounds = { x: -32000, y: -32000, width: 160, height: 28 };
    win.minimized = true;
    win.emit('hide');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).main, { x: 100, y: 80, width: 1200, height: 800, maximized: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
