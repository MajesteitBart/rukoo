'use strict';

// Settings > General > Open when you sign in: Rukoo as a login item, so it starts hidden when someone signs in to the
// computer and new mail and team chat notify without anyone opening Rukoo first.
//
// Windows and macOS keep the login item themselves, through Electron's app.setLoginItemSettings: Windows in the Run key
// of the current user, which Windows Settings > Apps > Startup turns on and off; macOS under System Settings > General >
// Login Items. Linux desktops start what the XDG autostart folder holds, so there Rukoo writes a desktop entry to
// ~/.config/autostart. The switch shows what the system has now: an entry someone turned off in the system's own
// settings shows off.
//
// Only an installed app registers (loginTarget): the copy the Windows installer put down, the Mac app in Applications,
// the .deb package or an AppImage. A run from a checkout, a test profile, the portable .exe (which runs from a temporary
// copy) and an unpacked build never do, so a login never starts Electron or a folder that is gone by then.
//
// The system is a seam: electronLogin() for Windows and macOS, linuxAutostart() for Linux and memoryLogin() for tests.
// Tests never reach the system's own login items.

const fs = require('fs');
const os = require('os');
const path = require('path');

// What the login item starts Rukoo with on Windows and Linux. macOS says so itself (wasOpenedAtLogin).
const HIDDEN_FLAG = '--start-hidden';
// The autostart entry's file name, the same as the desktop entry the .deb package installs.
const AUTOSTART = 'rukoo-mail.desktop';
// electron-builder's NSIS installer puts its uninstaller beside the program; an unpacked build has none.
const UNINSTALLER = 'Uninstall Rukoo Mail.exe';

// Whether the .deb package installed Rukoo here: its desktop entry is in one of the applications folders.
function packageInstalled(env, exists) {
  const roots = [env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
  return roots.filter((root) => path.isAbsolute(root)).some((root) => exists(path.join(root, 'applications', AUTOSTART)));
}

// The program a login starts, as { exe }, or null where this copy of Rukoo may not register itself.
// inApplications: macOS's app.isInApplicationsFolder(), asked only on a Mac.
function loginTarget({ platform = process.platform, packaged, env = process.env, execPath = process.execPath, exists = fs.existsSync, inApplications = () => false } = {}) {
  if (!packaged || env.SEM_DATA_DIR || env.SEM_HIDDEN) return null;
  if (platform === 'win32') {
    if (env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_FILE) return null;
    return exists(path.join(path.dirname(execPath), UNINSTALLER)) ? { exe: execPath } : null;
  }
  if (platform === 'darwin') {
    let installed = false;
    try {
      installed = inApplications() === true;
    } catch (_) {
      installed = false;
    }
    return installed ? { exe: execPath } : null;
  }
  if (platform === 'linux') {
    // The AppImage the person keeps, not its temporary mount (execPath).
    if (env.APPIMAGE) return path.isAbsolute(env.APPIMAGE) && !/[\0\r\n]/.test(env.APPIMAGE) ? { exe: env.APPIMAGE } : null;
    return packageInstalled(env, exists) ? { exe: execPath } : null;
  }
  return null;
}

// Windows and macOS: Electron's login items. Only main makes one, and only for a loginTarget().
function electronLogin(app) {
  return {
    get: (options) => app.getLoginItemSettings(options),
    set: (settings) => app.setLoginItemSettings(settings)
  };
}

// Tests: Electron's login items in memory, for every platform. off() is what the system's own settings do.
function memoryLogin() {
  const state = { openAtLogin: false, path: null, args: [], enabled: true, wasOpenedAtLogin: false, status: 'not-registered' };
  const calls = [];
  return {
    state,
    calls,
    get(options = {}) {
      calls.push(['get', options]);
      const here = state.openAtLogin && (!options.path || options.path === state.path);
      return {
        openAtLogin: here,
        executableWillLaunchAtLogin: here && state.enabled,
        wasOpenedAtLogin: state.wasOpenedAtLogin,
        status: state.status,
        launchItems: here ? [{ name: 'nl.bvdm.rukoo-mail', path: state.path, args: state.args, scope: 'user', enabled: state.enabled }] : []
      };
    },
    set(settings) {
      calls.push(['set', settings]);
      state.openAtLogin = settings.openAtLogin === true;
      state.path = state.openAtLogin ? settings.path || null : null;
      state.args = state.openAtLogin ? settings.args || [] : [];
      state.enabled = settings.enabled !== false;
      state.status = state.openAtLogin ? (state.needsApproval ? 'requires-approval' : 'enabled') : 'not-registered';
    },
    off() {
      state.enabled = false;
      state.status = 'not-registered';
    }
  };
}

// The XDG autostart folder: $XDG_CONFIG_HOME/autostart, or ~/.config/autostart.
function autostartDir(env = process.env) {
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config');
  return path.join(config, 'autostart');
}

// One argument of a desktop entry's Exec key, quoted as the Desktop Entry Specification says: inside double quotes,
// a backslash before " ` $ and \, every backslash doubled again for the string escape, and % doubled for field codes.
function execArg(value) {
  const quoted = String(value).replace(/["`$\\]/g, (c) => `\\${c}`);
  return `"${quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')}"`;
}

// The autostart entry for exe, which a login runs with HIDDEN_FLAG.
function autostartEntry(exe) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Rukoo Mail',
    'Comment=Starts Rukoo Mail hidden, so new mail and team chat notify you',
    `Exec=${execArg(exe)} ${HIDDEN_FLAG}`,
    'Icon=rukoo-mail',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

// The keys of a desktop entry's [Desktop Entry] group.
function entryKeys(text) {
  const keys = {};
  let group = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) {
      group = head[1];
      continue;
    }
    if (group !== 'Desktop Entry') continue;
    const eq = line.indexOf('=');
    if (eq > 0) keys[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return keys;
}

// Linux: the autostart entry in dir. Synchronous, so the AppImage update can move it during the quit (moved()).
function linuxAutostart({ dir = autostartDir(), files = fs } = {}) {
  const file = path.join(dir, AUTOSTART);
  return {
    file,
    read() {
      try {
        return files.readFileSync(file, 'utf8');
      } catch (_) {
        return null;
      }
    },
    write(text) {
      files.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      files.writeFileSync(tmp, text, { mode: 0o644 });
      files.renameSync(tmp, file);
    },
    remove() {
      files.rmSync(file, { force: true });
    }
  };
}

class LoginItem {
  // target: loginTarget(), or null where this copy may not register. system: electronLogin(), linuxAutostart() or
  // memoryLogin(), by platform.
  constructor({ platform = process.platform, target, system }) {
    this.platform = platform;
    this.target = target || null;
    this.system = system;
  }

  get linux() {
    return this.platform === 'linux';
  }

  // Windows compares the program and its arguments with the Run key's; macOS ignores both.
  options() {
    return this.platform === 'win32' ? { path: this.target.exe, args: [HIDDEN_FLAG] } : {};
  }

  // What Settings shows: { available, on, approval, platform }. approval: macOS waits for the person to allow it under
  // Login Items. available: false where this copy may not register; the system isn't asked then.
  status() {
    const base = { available: Boolean(this.target), on: false, approval: false, platform: this.platform };
    if (!this.target) return base;
    try {
      if (this.linux) {
        const text = this.system.read();
        if (text === null) return base;
        const keys = entryKeys(text);
        const off = /^true$/i.test(keys.Hidden || '') || /^false$/i.test(keys['X-GNOME-Autostart-enabled'] || '');
        return { ...base, on: !off };
      }
      const s = this.system.get(this.options()) || {};
      if (this.platform === 'darwin') {
        if (s.status) return { ...base, on: s.status === 'enabled', approval: s.status === 'requires-approval' };
        return { ...base, on: s.openAtLogin === true };
      }
      // Windows: a Run entry for this program that Startup apps hasn't turned off, with any arguments.
      const on = typeof s.executableWillLaunchAtLogin === 'boolean' ? s.executableWillLaunchAtLogin : s.openAtLogin === true;
      return { ...base, on };
    } catch (_) {
      return base;
    }
  }

  // Turns the login item on or off and says what the system has now. Throws where this copy may not register.
  set(on) {
    if (!this.target) throw new Error('unavailable');
    if (this.linux) {
      if (on) this.system.write(autostartEntry(this.target.exe));
      else this.system.remove();
      return this.status();
    }
    if (this.platform === 'darwin') this.system.set({ openAtLogin: Boolean(on) });
    // enabled: Windows' Startup apps turns it back on too, when someone had turned it off there.
    else this.system.set({ openAtLogin: Boolean(on), ...this.options(), enabled: Boolean(on) });
    return this.status();
  }

  // At startup: on Linux an autostart entry for another program, such as an AppImage the person renamed or moved, now
  // starts this one. One the desktop turned off stays off. Windows and macOS need nothing: an update installs the new
  // version over the old one, at the same path. True when it rewrote the entry.
  refresh() {
    if (!this.target || !this.linux) return false;
    try {
      const text = this.system.read();
      if (text === null) return false;
      const wanted = autostartEntry(this.target.exe);
      if (entryKeys(text).Exec === entryKeys(wanted).Exec || !this.status().on) return false;
      this.system.write(wanted);
      return true;
    } catch (_) {
      return false;
    }
  }

  // The AppImage update moved Rukoo to a file with the new version in its name (electron-updater's
  // appimage-filename-updated): the autostart entry follows, during the quit that installs it.
  moved(exe) {
    if (!this.target || !this.linux || !exe || !path.isAbsolute(exe)) return false;
    this.target = { exe };
    return this.refresh();
  }

  // Whether this start came from the login item, so the main window stays hidden. Windows and Linux pass HIDDEN_FLAG;
  // macOS says it of the start itself, asked only of an installed app.
  startedHidden(argv = process.argv) {
    if (argv.includes(HIDDEN_FLAG)) return true;
    if (this.platform !== 'darwin' || !this.target) return false;
    try {
      return this.system.get({}).wasOpenedAtLogin === true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { LoginItem, loginTarget, electronLogin, memoryLogin, linuxAutostart, autostartDir, autostartEntry, entryKeys, execArg, HIDDEN_FLAG, AUTOSTART, UNINSTALLER };
