'use strict';

// Downloads and installs the release updates.js found, on the installs that can replace themselves: the Windows
// installer (NSIS) and the Linux AppImage. The portable Windows app, the .deb package and the Mac app (which can't
// update itself while its builds are ad-hoc signed) keep the update button that opens the release page.
//
// electron-updater reads the release's update description (latest.yml and the like, written by electron-builder),
// downloads the package beside it and checks it against the SHA-512 in that description. Rukoo installs it itself,
// at the end of a quit (main.js), once every window has closed and the agents have stopped: electron-updater's own
// quitAndInstall starts the installer before the windows are asked, and a compose window can still call a quit off.
const { EventEmitter } = require('events');

// Which kind of install can replace itself here; null for the others.
function installKind({ platform = process.platform, packaged, env = process.env } = {}) {
  if (!packaged) return null;
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_DIR ? null : 'nsis';
  if (platform === 'linux') return env.APPIMAGE ? 'appimage' : null;
  return null;
}

function electronUpdater(kind) {
  const { NsisUpdater, AppImageUpdater } = require('electron-updater');
  const Updater = kind === 'nsis' ? NsisUpdater : AppImageUpdater;
  return new Updater({ provider: 'generic', url: 'https://github.com/' });
}

class UpdateInstaller extends EventEmitter {
  // kind: from installKind(). createUpdater: for tests, an object that behaves like electron-updater's.
  constructor({ kind, createUpdater = electronUpdater }) {
    super();
    this.kind = kind;
    this.createUpdater = createUpdater;
    this.updater = null;
    // 'downloading', 'ready' or 'failed', for `version`; null before the first download.
    this.status = null;
    this.version = null;
    this.percent = 0;
    // A release found while another downloads; it downloads next.
    this.next = null;
  }

  get supported() {
    return Boolean(this.kind);
  }

  // null where this install can't update itself.
  state() {
    return this.kind ? { status: this.status, version: this.version, percent: this.percent } : null;
  }

  setup() {
    if (this.updater) return this.updater;
    const u = this.createUpdater(this.kind);
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    // updates.js has chosen the release, channel and all.
    u.allowPrerelease = true;
    u.allowDowngrade = false;
    // Each release has its own download folder, so the blockmap of the installed version isn't beside the new one.
    u.disableDifferentialDownload = true;
    u.logger = null;
    u.on('download-progress', (p) => {
      const percent = Math.max(0, Math.min(100, Math.floor(Number(p && p.percent) || 0)));
      if (this.status !== 'downloading' || percent === this.percent) return;
      this.percent = percent;
      this.emit('changed', this.state());
    });
    // A failure also rejects the call that caused it; download() handles that.
    u.on('error', () => {});
    this.updater = u;
    return u;
  }

  // found: updates.js's `available`. Without a feed (an older release, or another platform's) nothing downloads.
  async download(found) {
    if (!this.kind || !found || !found.feed) return this.state();
    if (found.version === this.version && this.status !== 'failed') return this.state();
    if (this.status === 'downloading') {
      this.next = found;
      return this.state();
    }
    const u = this.setup();
    Object.assign(this, { status: 'downloading', version: found.version, percent: 0, next: null });
    this.emit('changed', this.state());
    try {
      u.setFeedURL({ provider: 'generic', url: found.feed });
      const result = await u.checkForUpdates();
      // The description must be for the release updates.js found, not whatever else the folder holds.
      if (!result || !result.updateInfo || result.updateInfo.version !== found.version) throw new Error('mismatch');
      await u.downloadUpdate();
      this.status = 'ready';
      this.percent = 100;
    } catch (_) {
      this.status = 'failed';
    }
    this.emit('changed', this.state());
    const next = this.next;
    this.next = null;
    if (next && next.version !== this.version) return this.download(next);
    return this.state();
  }

  // At the very end of a quit: starts the installer, synchronously. restart: the new version starts once installed.
  // false when nothing is ready or the installer couldn't start.
  install({ restart = false } = {}) {
    if (this.status !== 'ready' || !this.updater) return false;
    try {
      return this.updater.install(true, restart) === true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { UpdateInstaller, installKind };
