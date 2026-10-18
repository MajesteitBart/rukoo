'use strict';

const mailto = require('./mailto');

function windowChrome(platform, bar) {
  return platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: bar };
}

// macOS delivers open-url before ready as well as while the app is running.
// Keep every early link until the services and the main window are ready.
class MailtoQueue {
  constructor(open) { this.open = open; this.pending = []; this.started = false; }
  accept(url) {
    if (!mailto.isMailto(url)) return false;
    if (this.started) this.open(url);
    else this.pending.push(url);
    return true;
  }
  start() {
    this.started = true;
    for (const url of this.pending.splice(0)) this.open(url);
  }
}

class MacMailClient {
  constructor(app, isolated = false) { this.app = app; this.available = app.isPackaged && !isolated; }
  status() {
    let name = null;
    try { name = this.app.getApplicationNameForProtocol('mailto:') || null; } catch { /* No registered handler. */ }
    return { available: this.available, app: name, rukoo: this.app.isDefaultProtocolClient('mailto'), platform: 'darwin' };
  }
  register() { return this.available && this.app.setAsDefaultProtocolClient('mailto'); }
}

function macMenu(t, edit) {
  return [
    { role: 'appMenu' },
    { label: t('native.menu.edit'), submenu: [
      { label: t('native.menu.undo'), accelerator: 'Command+Z', click: () => edit('undo') },
      { label: t('native.menu.redo'), accelerator: 'Command+Shift+Z', click: () => edit('redo') },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' },
      { type: 'separator' },
      { label: t('native.menu.selectAll'), accelerator: 'Command+A', click: () => edit('selectAll') }
    ] },
    { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }] }
  ];
}

module.exports = { windowChrome, MailtoQueue, MacMailClient, macMenu };
