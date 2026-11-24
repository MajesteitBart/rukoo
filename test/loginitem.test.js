'use strict';

// Settings > General > Open when you sign in (src/main/loginitem.js), against fakes of the system: no test touches this
// computer's own login items.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('./tmp');
const {
  LoginItem,
  loginTarget,
  memoryLogin,
  linuxAutostart,
  autostartDir,
  autostartEntry,
  entryKeys,
  execArg,
  HIDDEN_FLAG,
  AUTOSTART,
  UNINSTALLER
} = require('../src/main/loginitem');

const WIN_EXE = 'C:\\Users\\Sanne\\AppData\\Local\\Programs\\rukoo-mail\\Rukoo Mail.exe';
const installedHere = (exe) => (file) => file === path.join(path.dirname(exe), UNINSTALLER);

test('only an installed copy registers: never a run from source, a test profile, the portable app or an unpacked build', () => {
  const win = { platform: 'win32', packaged: true, execPath: WIN_EXE, exists: installedHere(WIN_EXE) };
  assert.deepEqual(loginTarget({ ...win, env: {} }), { exe: WIN_EXE }, 'the installer put its uninstaller beside it');
  assert.equal(loginTarget({ ...win, packaged: false, env: {} }), null, 'npm start runs Electron itself');
  assert.equal(loginTarget({ ...win, env: { SEM_DATA_DIR: 'C:\\tmp\\profile' } }), null, 'a development or test profile');
  assert.equal(loginTarget({ ...win, env: { SEM_HIDDEN: '1' } }), null, 'a test run');
  assert.equal(loginTarget({ ...win, env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps', PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\Rukoo.exe' } }), null, 'the portable app runs from a temporary copy');
  assert.equal(loginTarget({ ...win, env: {}, exists: () => false }), null, 'win-unpacked has no uninstaller');

  const mac = { platform: 'darwin', packaged: true, execPath: '/Applications/Rukoo Mail.app/Contents/MacOS/Rukoo Mail', env: {} };
  assert.deepEqual(loginTarget({ ...mac, inApplications: () => true }), { exe: mac.execPath });
  assert.equal(loginTarget({ ...mac, inApplications: () => false }), null, 'from the disk image or Downloads');
  assert.equal(
    loginTarget({
      ...mac,
      inApplications: () => {
        throw new Error('not a Mac');
      }
    }),
    null
  );
  assert.equal(loginTarget({ ...mac, packaged: false, inApplications: () => true }), null, 'a run from source');

  const linux = { platform: 'linux', packaged: true, execPath: '/opt/Rukoo Mail/rukoo-mail', exists: () => false };
  const image = '/home/sanne/Apps/Rukoo-Mail-2.4.0-x86_64.AppImage';
  assert.deepEqual(loginTarget({ ...linux, env: { APPIMAGE: image } }), { exe: image }, 'the AppImage, not its temporary mount');
  assert.equal(loginTarget({ ...linux, env: { APPIMAGE: 'Rukoo.AppImage' } }), null, 'a relative path');
  assert.equal(loginTarget({ ...linux, env: { APPIMAGE: `${image}\nX-Evil=1` } }), null, 'a line break would add keys to the entry');
  const deb = { ...linux, env: { XDG_DATA_DIRS: '/usr/share', XDG_DATA_HOME: '/home/sanne/.local/share' }, exists: (file) => file === path.join('/usr/share', 'applications', AUTOSTART) };
  assert.deepEqual(loginTarget(deb), { exe: linux.execPath }, 'the .deb package installed its desktop entry');
  assert.equal(loginTarget({ ...linux, env: { XDG_DATA_DIRS: '/usr/share', XDG_DATA_HOME: '/home/sanne/.local/share' } }), null, 'linux-unpacked');
  assert.equal(loginTarget({ ...deb, env: { ...deb.env, SEM_DATA_DIR: '/tmp/profile' } }), null);

  assert.equal(loginTarget({ platform: 'freebsd', packaged: true, env: {} }), null);
});

test('without a target the system is never asked, and the switch says why', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const system = memoryLogin();
    const item = new LoginItem({ platform, target: null, system });
    assert.deepEqual(item.status(), { available: false, on: false, approval: false, platform });
    assert.throws(() => item.set(true), /unavailable/);
    assert.equal(item.refresh(), false);
    assert.equal(item.startedHidden(['rukoo']), false);
    assert.deepEqual(system.calls, [], platform);
  }
});

test('Windows: the Run entry starts the installed program hidden, and Startup apps turning it off shows off', () => {
  const system = memoryLogin();
  const item = new LoginItem({ platform: 'win32', target: { exe: WIN_EXE }, system });
  assert.deepEqual(item.status(), { available: true, on: false, approval: false, platform: 'win32' }, 'off by default');

  assert.equal(item.set(true).on, true);
  assert.deepEqual(system.calls.find(([c]) => c === 'set')[1], { openAtLogin: true, path: WIN_EXE, args: [HIDDEN_FLAG], enabled: true });
  // Every read compares with this program and its argument.
  assert.ok(system.calls.filter(([c]) => c === 'get').every(([, o]) => o.path === WIN_EXE && o.args[0] === HIDDEN_FLAG));

  // Windows Settings > Apps > Startup turns it off: the Run entry stays, StartupApproved says disabled.
  system.off();
  assert.equal(item.status().on, false);
  // Turning it on again here approves it again.
  assert.equal(item.set(true).on, true);
  assert.equal(system.state.enabled, true);

  assert.equal(item.set(false).on, false);
  assert.deepEqual(system.calls.at(-2), ['set', { openAtLogin: false, path: WIN_EXE, args: [HIDDEN_FLAG], enabled: false }]);
  assert.equal(item.refresh(), false, 'an update installs over the same path; nothing to move');
});

test('Windows: a Run entry for another copy is not this one, and a system that fails reads as off', () => {
  const system = memoryLogin();
  system.set({ openAtLogin: true, path: 'D:\\Old\\Rukoo Mail.exe', args: [HIDDEN_FLAG] });
  const item = new LoginItem({ platform: 'win32', target: { exe: WIN_EXE }, system });
  assert.equal(item.status().on, false);
  const broken = new LoginItem({
    platform: 'win32',
    target: { exe: WIN_EXE },
    system: {
      get: () => {
        throw new Error('registry');
      }
    }
  });
  assert.equal(broken.status().on, false);
});

test('macOS: a login item that waits for approval shows off with the way to allow it', () => {
  const system = memoryLogin();
  const item = new LoginItem({ platform: 'darwin', target: { exe: '/Applications/Rukoo Mail.app/Contents/MacOS/Rukoo Mail' }, system });
  assert.equal(item.set(true).on, true);
  assert.deepEqual(system.calls.find(([c]) => c === 'set')[1], { openAtLogin: true }, 'macOS registers the app itself');
  system.off();
  assert.equal(item.status().on, false, 'removed under Login Items');

  system.state.needsApproval = true;
  assert.deepEqual(item.set(true), { available: true, on: false, approval: true, platform: 'darwin' });
  // A macOS without SMAppService's status answers openAtLogin only.
  const old = new LoginItem({ platform: 'darwin', target: { exe: '/Applications/x' }, system: { get: () => ({ openAtLogin: true }) } });
  assert.equal(old.status().on, true);
});

test('the hidden start: the flag on Windows and Linux, wasOpenedAtLogin on a Mac', () => {
  for (const platform of ['win32', 'linux']) {
    const item = new LoginItem({ platform, target: { exe: '/x' }, system: memoryLogin() });
    assert.equal(item.startedHidden(['rukoo', HIDDEN_FLAG]), true, platform);
    assert.equal(item.startedHidden(['rukoo']), false, platform);
    assert.equal(item.startedHidden(['rukoo', 'mailto:sanne@example.com']), false, platform);
  }
  const system = memoryLogin();
  const mac = new LoginItem({ platform: 'darwin', target: { exe: '/Applications/x' }, system });
  assert.equal(mac.startedHidden(['rukoo']), false);
  system.state.wasOpenedAtLogin = true;
  assert.equal(mac.startedHidden(['rukoo']), true);
  // A development run (no target) doesn't ask the system, even on a Mac.
  const calls = memoryLogin();
  calls.state.wasOpenedAtLogin = true;
  assert.equal(new LoginItem({ platform: 'darwin', target: null, system: calls }).startedHidden(['electron', '.']), false);
  assert.deepEqual(calls.calls, []);
});

test('an Exec argument is quoted as the Desktop Entry Specification says', () => {
  assert.equal(execArg('/opt/Rukoo Mail/rukoo-mail'), '"/opt/Rukoo Mail/rukoo-mail"');
  assert.equal(execArg('/home/a$b/"c"/`d`'), '"/home/a\\\\$b/\\\\"c\\\\"/\\\\`d\\\\`"');
  assert.equal(execArg('/home/back\\slash'), '"/home/back\\\\\\\\slash"', 'four backslashes for one');
  assert.equal(execArg('/home/100%/Rukoo.AppImage'), '"/home/100%%/Rukoo.AppImage"');
  const keys = entryKeys(autostartEntry('/opt/Rukoo Mail/rukoo-mail'));
  assert.equal(keys.Exec, `"/opt/Rukoo Mail/rukoo-mail" ${HIDDEN_FLAG}`);
  assert.equal(keys.Type, 'Application');
  assert.equal(keys.Name, 'Rukoo Mail');
});

test('the autostart folder follows XDG_CONFIG_HOME', () => {
  assert.equal(autostartDir({ XDG_CONFIG_HOME: '/home/sanne/.cfg' }), path.join('/home/sanne/.cfg', 'autostart'));
  assert.equal(path.basename(autostartDir({ XDG_CONFIG_HOME: 'relative' })), 'autostart');
  assert.match(autostartDir({}), /[\\/]\.config[\\/]autostart$/);
});

test('Linux: the autostart entry, the desktop turning it off, and a renamed AppImage', (t) => {
  const dir = tempDir('rukoo-autostart-');
  t.after(() => removeDir(dir));
  const autostart = path.join(dir, 'autostart');
  const system = linuxAutostart({ dir: autostart });
  const file = path.join(autostart, AUTOSTART);
  const image = '/home/sanne/Apps/Rukoo-Mail-2.4.0-x86_64.AppImage';
  const item = new LoginItem({ platform: 'linux', target: { exe: image }, system });

  assert.equal(item.status().on, false, 'no entry yet');
  assert.equal(item.refresh(), false, 'refresh never adds one');
  assert.equal(fs.existsSync(file), false);

  assert.equal(item.set(true).on, true);
  assert.equal(entryKeys(fs.readFileSync(file, 'utf8')).Exec, `"${image}" ${HIDDEN_FLAG}`);
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  // GNOME's and KDE's own settings turn an entry off without removing it.
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}Hidden=true\n`);
  assert.equal(item.status().on, false);
  fs.writeFileSync(file, autostartEntry(image).replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'));
  assert.equal(item.status().on, false);
  // A key in another group doesn't count.
  fs.writeFileSync(file, `${autostartEntry(image)}[Desktop Action other]\nHidden=true\n`);
  assert.equal(item.status().on, true);

  // The update moved Rukoo to a file with the new version in its name: the entry follows.
  const next = '/home/sanne/Apps/Rukoo-Mail-2.5.0-x86_64.AppImage';
  assert.equal(item.moved(next), true);
  assert.equal(entryKeys(fs.readFileSync(file, 'utf8')).Exec, `"${next}" ${HIDDEN_FLAG}`);
  assert.equal(item.moved('relative.AppImage'), false);

  // The person renamed the AppImage; the next start points the entry at it again.
  const renamed = new LoginItem({ platform: 'linux', target: { exe: '/home/sanne/Rukoo.AppImage' }, system });
  assert.equal(renamed.refresh(), true);
  assert.equal(renamed.refresh(), false, 'once');
  assert.equal(entryKeys(fs.readFileSync(file, 'utf8')).Exec, `"/home/sanne/Rukoo.AppImage" ${HIDDEN_FLAG}`);

  // An entry the desktop turned off stays as the person left it.
  fs.writeFileSync(file, `${autostartEntry(image)}Hidden=true\n`);
  assert.equal(renamed.refresh(), false);
  assert.match(fs.readFileSync(file, 'utf8'), /Hidden=true/);
  // Turning it on here writes a fresh entry.
  assert.equal(renamed.set(true).on, true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Hidden=true/);

  assert.equal(renamed.set(false).on, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(renamed.set(false).on, false, 'removing twice is fine');
});

test('Linux: a write that fails throws, so Settings can say so', () => {
  const files = {
    mkdirSync() {},
    writeFileSync() {
      throw new Error('EACCES');
    },
    renameSync() {},
    rmSync() {},
    readFileSync() {
      throw new Error('ENOENT');
    }
  };
  const item = new LoginItem({ platform: 'linux', target: { exe: '/opt/Rukoo Mail/rukoo-mail' }, system: linuxAutostart({ dir: '/nowhere', files }) });
  assert.throws(() => item.set(true), /EACCES/);
  assert.equal(item.status().on, false);
});
