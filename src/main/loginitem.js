'use strict';

// Settings > General > Open when you sign in: Rukoo as a login item, so it starts hidden when someone signs in to the
// computer and new mail and team chat notify without anyone opening Rukoo first.
//
// Windows and macOS keep the login item themselves, through Electron's app.setLoginItemSettings: Windows in the Run key
// of the current user, which Windows Settings > Apps > Startup turns on and off; macOS under System Settings > General >
// Login Items. The switch shows what the system has now: an item someone turned off in the system's own settings shows
// off. Linux isn't offered the switch: its desktops start what their own startup settings hold.
//
// Only an installed app registers (loginTarget): the copy the Windows installer put down and the Mac app in
// Applications. A run from a checkout, a test profile, the portable .exe (which runs from a temporary copy) and an
// unpacked build never do, so a login never starts Electron or a folder that is gone by then.
//
// The system is a seam: electronLogin() for Windows and macOS, memoryLogin() for tests, which behaves as Electron's
// does on the platform it plays. Tests never reach the system's own login items.

const fs = require('fs');
const path = require('path');

// What the Windows login item starts Rukoo with. macOS says so itself (wasOpenedAtLogin).
const HIDDEN_FLAG = '--start-hidden';
// electron-builder's NSIS installer puts its uninstaller beside the program; an unpacked build has none.
const UNINSTALLER = 'Uninstall Rukoo Mail.exe';
// The name Electron gives the Run value: the AppUserModelID of the installed app (main.js APP_ID).
const APP_ID = 'nl.bvdm.rukoo-mail';

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
  return null;
}

// Whether argv carries HIDDEN_FLAG as one of Rukoo's own switches: before a "--", after which everything is an
// argument. The first start and a second one (second-instance) both ask this.
function hiddenFlag(argv) {
  for (const arg of Array.isArray(argv) ? argv.slice(1) : []) {
    if (arg === '--') return false;
    if (arg === HIDDEN_FLAG) return true;
  }
  return false;
}

// Windows' quoting of one argument, as CommandLineToArgvW reads it back: Electron's AddQuoteForArg
// (shell/common/command_line_util_win.cc), which quotes anything with a space, a backslash or a double quote.
function winQuote(arg) {
  if (!/[ \\"]/.test(arg)) return arg;
  let out = '"';
  for (let i = 0; i < arg.length; i++) {
    if (arg[i] === '\\') {
      let end = i + 1;
      while (end < arg.length && arg[end] === '\\') end++;
      const run = end - i;
      out += '\\'.repeat(end === arg.length || arg[end] === '"' ? run * 2 : run);
      i = end - 1;
    } else if (arg[i] === '"') out += '\\"';
    else out += arg[i];
  }
  return `${out}"`;
}

// The Run value Electron writes for a program and its arguments (browser_win.cc FormatCommandLineString): the
// program's surrounding quotes taken off, then every part quoted as Windows reads it.
function winCommand(exe, args = []) {
  const bare = exe.length >= 2 && exe.startsWith('"') && exe.endsWith('"') ? exe.slice(1, -1) : exe;
  return [winQuote(bare), ...args.map(winQuote)].join(' ');
}

// The program of a Windows command line, as CommandLineToArgvW reads its first part: up to the next quote when it
// starts with one, otherwise up to the first space or tab. Electron reads both the Run values and the path it is asked
// about this way (base::CommandLine::FromString(...).GetProgram()), so an unquoted path with a space reads as the part
// before that space.
function winProgram(command) {
  const s = String(command).replace(/^[ \t]+/, '');
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end < 0 ? s.slice(1) : s.slice(1, end);
  }
  return s.split(/[ \t]/)[0];
}

// Windows and macOS: Electron's login items. Only main makes one, and only for a loginTarget().
function electronLogin(app) {
  return {
    get: (options) => app.getLoginItemSettings(options),
    set: (settings) => app.setLoginItemSettings(settings)
  };
}

// Tests: Electron's login items in memory, behaving as Electron 44 does on the platform it plays. On Windows it keeps
// Run values as command lines and Startup apps' state beside them, and reads them back the way browser_win.cc does;
// on a Mac it keeps SMAppService's status. off() is what the system's own settings do: Startup apps turns the entry
// off, and on a Mac removing Rukoo under Login Items leaves it waiting for approval again.
function memoryLogin({ platform = process.platform, execPath = process.execPath, opened = false } = {}) {
  const state = { run: {}, approved: {}, status: 'not-registered', needsApproval: false, wasOpenedAtLogin: opened === true };
  const calls = [];
  const win = platform === 'win32';
  return {
    state,
    calls,
    get(options = {}) {
      calls.push(['get', options]);
      if (!win) {
        return { openAtLogin: state.status === 'enabled', status: state.status, wasOpenedAtLogin: state.wasOpenedAtLogin };
      }
      const exe = options.path || execPath;
      const wanted = winProgram(exe).toLowerCase();
      const items = Object.entries(state.run)
        .filter(([, command]) => winProgram(command).toLowerCase() === wanted)
        .map(([name, command]) => ({ name, command, enabled: state.approved[name] === undefined || state.approved[name] === 2 }));
      return {
        openAtLogin: state.run[APP_ID] === winCommand(exe, options.args || []),
        executableWillLaunchAtLogin: items.some((i) => i.enabled),
        launchItems: items.map((i) => ({ name: i.name, path: winProgram(i.command), scope: 'user', enabled: i.enabled }))
      };
    },
    set(settings) {
      calls.push(['set', settings]);
      if (!win) {
        state.status = settings.openAtLogin ? (state.needsApproval ? 'requires-approval' : 'enabled') : 'not-registered';
        return;
      }
      if (settings.openAtLogin) {
        state.run[APP_ID] = winCommand(settings.path || execPath, settings.args || []);
        if (settings.enabled === false) state.approved[APP_ID] = 3;
        else delete state.approved[APP_ID];
      } else {
        delete state.run[APP_ID];
        delete state.approved[APP_ID];
      }
    },
    off() {
      if (win) state.approved[APP_ID] = 3;
      else if (state.status === 'enabled') state.status = 'requires-approval';
    }
  };
}

class LoginItem {
  // target: loginTarget(), or null where this copy may not register. system: electronLogin() or memoryLogin().
  constructor({ platform = process.platform, target, system }) {
    this.platform = platform;
    this.target = target || null;
    this.system = system;
  }

  // Windows reads the program it is asked about as a command line, so a path with a space (Program Files, "Rukoo
  // Mail.exe") goes quoted; Electron takes the quotes off again when it writes the Run value. macOS ignores both.
  options() {
    return this.platform === 'win32' ? { path: `"${this.target.exe}"`, args: [HIDDEN_FLAG] } : {};
  }

  // What Settings shows: { available, on, approval, platform }. approval: macOS has the login item but waits for the
  // person to allow it under Login Items. available: false where this copy may not register; the system isn't asked.
  status() {
    const base = { available: Boolean(this.target), on: false, approval: false, platform: this.platform };
    if (!this.target) return base;
    try {
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
    if (this.platform === 'darwin') this.system.set({ openAtLogin: Boolean(on) });
    // enabled: Windows' Startup apps turns it back on too, when someone had turned it off there.
    else this.system.set({ openAtLogin: Boolean(on), ...this.options(), enabled: Boolean(on) });
    return this.status();
  }

  // Whether a start with argv came from the login item: only an installed copy's. Windows passes HIDDEN_FLAG; macOS
  // says it of the start itself, so only the first start can ask it (first).
  fromLogin(argv, { first = false } = {}) {
    if (!this.target) return false;
    if (this.platform === 'win32') return hiddenFlag(argv);
    if (this.platform !== 'darwin' || !first) return false;
    try {
      return this.system.get({}).wasOpenedAtLogin === true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { LoginItem, loginTarget, electronLogin, memoryLogin, hiddenFlag, winQuote, winCommand, winProgram, HIDDEN_FLAG, UNINSTALLER, APP_ID };
