'use strict';

// Remembers the size and position of the main window and the compose windows between runs.
const fs = require('fs');
const { screen } = require('electron');

class WindowState {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      this.data = {};
    }
  }

  // Bounds for a new window: the saved ones if they are still on a connected screen, else the defaults centred.
  bounds(kind, defaults) {
    const saved = this.data[kind];
    if (saved && saved.width && saved.height) {
      const size = { width: Math.max(saved.width, defaults.minWidth || 0), height: Math.max(saved.height, defaults.minHeight || 0) };
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && visible({ ...saved, ...size })) {
        return { ...size, x: saved.x, y: saved.y, maximized: Boolean(saved.maximized) };
      }
      return { ...size, maximized: Boolean(saved.maximized) };
    }
    return { width: defaults.width, height: defaults.height, maximized: false };
  }

  track(kind, win) {
    const save = () => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const maximized = win.isMaximized();
      // Keep the restored size while maximized, so un-maximizing next run gives a sensible window.
      const b = maximized ? (this.data[kind] || win.getNormalBounds()) : win.getBounds();
      this.data[kind] = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
      this.write();
    };
    let timer = null;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(save, 400);
    };
    win.on('resize', later);
    win.on('move', later);
    win.on('maximize', save);
    win.on('unmaximize', save);
    win.on('close', () => {
      clearTimeout(timer);
      save();
    });
  }

  write() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (_) {
      // Losing a window position is harmless.
    }
  }
}

// At least a 120x60 strip of the title bar has to land on some display.
function visible(b) {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + 60, a.y + a.height) - Math.max(b.y, a.y);
    return w >= 120 && h >= 30;
  });
}

module.exports = { WindowState };
