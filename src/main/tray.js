'use strict';

// The tray icon: its picture, tooltip and menu. main.js decides when there is one and what the menu items do.
const { EventEmitter } = require('events');
const { Tray, Menu, nativeImage } = require('electron');
const { t } = require('../i18n');

// The colour of the taskbar badge (drawBadge in app.js); the dot on the tray icon stands in for that badge.
const DOT = { red: 0xd6, green: 0x33, blue: 0x6c };

// Paints the dot into the bottom-right corner of a square bitmap in nativeImage's format on Windows: BGRA with
// premultiplied alpha. The macOS menu bar icon assumes the same order. A transparent ring keeps the dot apart from
// the pigeon. Returns a new buffer.
function withDot(bitmap, size) {
  const out = Buffer.from(bitmap);
  const radius = size * 0.22;
  const ring = Math.max(1, size / 16);
  const centre = size - radius;
  const coverage = (edge, d) => Math.min(1, Math.max(0, edge + 0.5 - d));
  const colour = [DOT.blue, DOT.green, DOT.red, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
      const clear = coverage(radius + ring, d);
      if (!clear) continue;
      const fill = coverage(radius, d);
      const i = (y * size + x) * 4;
      for (let k = 0; k < 4; k++) {
        const kept = out[i + k] * (1 - clear);
        out[i + k] = Math.round(colour[k] * fill + kept * (1 - fill));
      }
    }
  }
  return out;
}

function tooltip(unread) {
  return unread > 0 ? t('native.tray.tooltip', { count: unread }) : 'Rukoo Mail';
}

// The icon's representations: a scale factor and a size in pixels for each. Windows draws tray icons at 16 px at
// 100% scaling, and an image of exactly that size stays sharp. The macOS menu bar wants an 18 pt icon, as tall as
// the system icons next to it, with a 2x copy for Retina screens; one bitmap of 32 px would show at 32 pt.
function traySizes(platform, scaleFactor) {
  if (platform === 'darwin') return [{ scaleFactor: 1, size: 18 }, { scaleFactor: 2, size: 36 }];
  return [{ scaleFactor: 1, size: Math.round(16 * scaleFactor) }];
}

// The plain icon and the one with the dot.
function trayImages(icon, platform, scaleFactor) {
  const sizes = traySizes(platform, scaleFactor);
  // nativeImage reads from inside app.asar, like the notification icon does.
  const source = nativeImage.createFromPath(icon);
  if (platform !== 'darwin') {
    // Windows and Linux keep the resized image itself. Asked for a higher scale factor, it resizes the source
    // again, which Linux's tray does on HiDPI screens; a bitmap added as a representation can't do that.
    const [{ size }] = sizes;
    const plain = source.resize({ width: size, height: size, quality: 'best' });
    return { plain, dot: nativeImage.createFromBitmap(withDot(plain.toBitmap(), size), { width: size, height: size }) };
  }
  const plain = nativeImage.createEmpty();
  const dot = nativeImage.createEmpty();
  for (const { scaleFactor: scale, size } of sizes) {
    const bitmap = source.resize({ width: size, height: size, quality: 'best' }).toBitmap();
    plain.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: bitmap });
    dot.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: withDot(bitmap, size) });
  }
  return { plain, dot };
}

// Test mode (SEM_HIDDEN) puts no icon in the notification area; tests click this one through global.__semTray.
class TestTray extends EventEmitter {
  setImage(image) {
    this.image = image;
  }
  setToolTip(text) {
    this.tooltip = text;
  }
  setContextMenu(menu) {
    this.menu = menu;
  }
  destroy() {
    this.destroyed = true;
  }
}

class TrayIcon {
  // actions: { open, compose, sync, quit }. platform and scaleFactor (the primary display's) pick the sizes.
  constructor({ icon, platform, scaleFactor, actions, test = false }) {
    this.images = trayImages(icon, platform, scaleFactor);
    const { plain } = this.images;
    this.actions = actions;
    this.unread = 0;
    this.dot = false;
    this.tray = test ? new TestTray() : new Tray(plain);
    if (test) this.tray.setImage(plain);
    this.tray.on('click', () => actions.open());
    this.relabel();
  }

  // Builds the menu and the tooltip again, in the current language.
  relabel() {
    const a = this.actions;
    this.menu = Menu.buildFromTemplate([
      { id: 'open', label: t('native.tray.open'), click: () => a.open() },
      { id: 'compose', label: t('native.tray.compose'), click: () => a.compose() },
      { id: 'sync', label: t('native.tray.sync'), click: () => a.sync() },
      { type: 'separator' },
      { id: 'quit', label: t('native.tray.quit'), click: () => a.quit() }
    ]);
    this.tray.setContextMenu(this.menu);
    this.tray.setToolTip(tooltip(this.unread));
  }

  // unread: the count in the tooltip. dot: whether the taskbar badge has a count, which a hidden window can't show.
  update({ unread, dot }) {
    if (unread !== this.unread) this.tray.setToolTip(tooltip(unread));
    if (dot !== this.dot) this.tray.setImage(dot ? this.images.dot : this.images.plain);
    this.unread = unread;
    this.dot = dot;
  }

  destroy() {
    this.tray.destroy();
  }
}

module.exports = { TrayIcon, withDot, tooltip, traySizes, trayImages };
