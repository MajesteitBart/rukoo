'use strict';

// Settings > General > Open when you sign in (src/main/loginitem.js), against a fake of the system that reads and
// writes the way Electron 44 does: no test touches this computer's own login items.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tempDir, removeDir } = require('./tmp');
const {
  LoginItem,
  loginTarget,
  memoryLogin,
  hiddenFlag,
  winQuote,
  winCommand,
  winProgram,
  HIDDEN_FLAG,
  UNINSTALLER,
  APP_ID
} = require('../src/main/loginitem');

// The installer's default folder for one user, and the one for all users: both have a space.
const WIN_EXE = 'C:\\Users\\Sanne\\AppData\\Local\\Programs\\rukoo-mail\\Rukoo Mail.exe';
const ALL_USERS_EXE = 'C:\\Program Files\\Rukoo Mail\\Rukoo Mail.exe';
const MAC_EXE = '/Applications/Rukoo Mail.app/Contents/MacOS/Rukoo Mail';
const installedHere = (exe) => (file) => file === path.join(path.dirname(exe), UNINSTALLER);

test('only an installed copy registers: never a run from source, a test profile, the portable app, an unpacked build or Linux', () => {
  const win = { platform: 'win32', packaged: true, execPath: WIN_EXE, exists: installedHere(WIN_EXE) };
  assert.deepEqual(loginTarget({ ...win, env: {} }), { exe: WIN_EXE }, 'the installer put its uninstaller beside it');
  assert.equal(loginTarget({ ...win, packaged: false, env: {} }), null, 'npm start runs Electron itself');
  assert.equal(loginTarget({ ...win, env: { SEM_DATA_DIR: 'C:\\tmp\\profile' } }), null, 'a development or test profile');
  assert.equal(loginTarget({ ...win, env: { SEM_HIDDEN: '1' } }), null, 'a test run');
  assert.equal(loginTarget({ ...win, env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps', PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\Rukoo.exe' } }), null, 'the portable app runs from a temporary copy');
  assert.equal(loginTarget({ ...win, env: {}, exists: () => false }), null, 'win-unpacked has no uninstaller');

  const mac = { platform: 'darwin', packaged: true, execPath: MAC_EXE, env: {} };
  assert.deepEqual(loginTarget({ ...mac, inApplications: () => true }), { exe: MAC_EXE });
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

  // Linux desktops start what their own startup settings hold; Rukoo writes nothing there.
  assert.equal(loginTarget({ platform: 'linux', packaged: true, execPath: '/opt/Rukoo Mail/rukoo-mail', env: { APPIMAGE: '/home/sanne/Rukoo.AppImage' }, exists: () => true }), null);
  assert.equal(loginTarget({ platform: 'freebsd', packaged: true, env: {} }), null);
});

test('without a target the system is never asked, and the switch says why', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const system = memoryLogin({ platform });
    const item = new LoginItem({ platform, target: null, system });
    assert.deepEqual(item.status(), { available: false, on: false, approval: false, platform });
    assert.throws(() => item.set(true), /unavailable/);
    assert.equal(item.fromLogin(['rukoo', HIDDEN_FLAG], { first: true }), false, `${platform}: the flag counts only for an installed copy`);
    assert.deepEqual(system.calls, [], platform);
  }
});

test('Windows quoting follows Electron: the Run value, and how Windows reads a program back', () => {
  assert.equal(winQuote(HIDDEN_FLAG), HIDDEN_FLAG);
  assert.equal(winQuote(WIN_EXE), `"${WIN_EXE}"`);
  assert.equal(winQuote('C:\\dir\\'), '"C:\\dir\\\\"', 'a backslash before the closing quote doubles');
  assert.equal(winQuote('a"b'), '"a\\"b"');
  assert.equal(winCommand(WIN_EXE, [HIDDEN_FLAG]), `"${WIN_EXE}" ${HIDDEN_FLAG}`);
  assert.equal(winCommand(`"${WIN_EXE}"`, [HIDDEN_FLAG]), `"${WIN_EXE}" ${HIDDEN_FLAG}`, 'quotes around the program are taken off first');
  assert.equal(winProgram(`"${WIN_EXE}" ${HIDDEN_FLAG}`), WIN_EXE);
  assert.equal(winProgram(`"${WIN_EXE}"`), WIN_EXE);
  // The cause of the switch reading off: a bare path with a space reads as the part before it.
  assert.equal(winProgram(WIN_EXE), 'C:\\Users\\Sanne\\AppData\\Local\\Programs\\rukoo-mail\\Rukoo');
});

for (const exe of [WIN_EXE, ALL_USERS_EXE]) {
  test(`Windows, ${exe}: on after Rukoo turns it on, off after Startup apps turns it off, on again from Rukoo`, () => {
    const system = memoryLogin({ platform: 'win32', execPath: exe });
    const item = new LoginItem({ platform: 'win32', target: { exe }, system });
    assert.deepEqual(item.status(), { available: true, on: false, approval: false, platform: 'win32' }, 'off by default');

    assert.equal(item.set(true).on, true);
    // The Run value Electron writes: the program quoted, then the flag.
    assert.equal(system.state.run[APP_ID], `"${exe}" ${HIDDEN_FLAG}`);
    assert.equal(system.get(item.options()).openAtLogin, true, 'the older openAtLogin check agrees');

    // Windows Settings > Apps > Startup turns it off: the Run value stays, StartupApproved says disabled.
    system.off();
    assert.equal(item.status().on, false);
    // Turning it on again here approves it again.
    assert.equal(item.set(true).on, true);
    assert.equal(system.state.approved[APP_ID], undefined);

    assert.equal(item.set(false).on, false);
    assert.deepEqual(system.state.run, {});
    assert.deepEqual(system.calls.at(-2), ['set', { openAtLogin: false, path: `"${exe}"`, args: [HIDDEN_FLAG], enabled: false }]);
  });
}

test('Windows: a Run entry for another copy is not this one, and a system that fails reads as off', () => {
  const system = memoryLogin({ platform: 'win32', execPath: WIN_EXE });
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

test('macOS: registers the app itself, and a login item waiting for approval can be turned off again', () => {
  const system = memoryLogin({ platform: 'darwin' });
  const item = new LoginItem({ platform: 'darwin', target: { exe: MAC_EXE }, system });
  assert.equal(item.set(true).on, true);
  assert.deepEqual(system.calls.find(([c]) => c === 'set')[1], { openAtLogin: true }, 'macOS registers the app bundle, without a path or arguments');

  // Removed under Login Items: macOS keeps it, waiting for the person's approval.
  system.off();
  assert.deepEqual(item.status(), { available: true, on: false, approval: true, platform: 'darwin' });
  // Turning it off here unregisters it.
  assert.deepEqual(item.set(false), { available: true, on: false, approval: false, platform: 'darwin' });
  assert.equal(system.state.status, 'not-registered');

  system.state.needsApproval = true;
  assert.deepEqual(item.set(true), { available: true, on: false, approval: true, platform: 'darwin' });
  // A macOS without SMAppService's status answers openAtLogin only.
  const old = new LoginItem({ platform: 'darwin', target: { exe: MAC_EXE }, system: { get: () => ({ openAtLogin: true }) } });
  assert.equal(old.status().on, true);
});

test('one parser for the flag: only before "--", for the first start and a second one', () => {
  assert.equal(hiddenFlag(['Rukoo Mail.exe', HIDDEN_FLAG]), true);
  assert.equal(hiddenFlag(['electron', '.', HIDDEN_FLAG]), true);
  assert.equal(hiddenFlag(['Rukoo Mail.exe']), false);
  assert.equal(hiddenFlag(['Rukoo Mail.exe', '--', HIDDEN_FLAG]), false, 'after -- it is an argument');
  assert.equal(hiddenFlag([HIDDEN_FLAG]), false, 'argv[0] is the program');
  assert.equal(hiddenFlag(['Rukoo Mail.exe', 'mailto:sanne@example.com']), false);
  assert.equal(hiddenFlag(null), false);

  const item = new LoginItem({ platform: 'win32', target: { exe: WIN_EXE }, system: memoryLogin({ platform: 'win32' }) });
  assert.equal(item.fromLogin(['Rukoo Mail.exe', HIDDEN_FLAG], { first: true }), true);
  assert.equal(item.fromLogin(['Rukoo Mail.exe', HIDDEN_FLAG]), true, 'a second start from the login item');
  assert.equal(item.fromLogin(['Rukoo Mail.exe', '--', HIDDEN_FLAG], { first: true }), false);
});

test('macOS: a start at login says so itself, asked of the first start of an installed app only', () => {
  const system = memoryLogin({ platform: 'darwin' });
  const mac = new LoginItem({ platform: 'darwin', target: { exe: MAC_EXE }, system });
  assert.equal(mac.fromLogin(['Rukoo Mail'], { first: true }), false);
  assert.equal(mac.fromLogin(['Rukoo Mail', HIDDEN_FLAG], { first: true }), false, 'the Mac login item passes no flag');
  system.state.wasOpenedAtLogin = true;
  assert.equal(mac.fromLogin(['Rukoo Mail'], { first: true }), true);
  assert.equal(mac.fromLogin(['Rukoo Mail']), false, 'a later start is the person');
  assert.equal(new LoginItem({ platform: 'darwin', target: { exe: MAC_EXE }, system: memoryLogin({ platform: 'darwin', opened: true }) }).fromLogin([], { first: true }), true);
  // A development run (no target) doesn't ask the system.
  const dev = memoryLogin({ platform: 'darwin', opened: true });
  assert.equal(new LoginItem({ platform: 'darwin', target: null, system: dev }).fromLogin(['electron', '.'], { first: true }), false);
  assert.deepEqual(dev.calls, []);
});

// makensis from RUKOO_MAKENSIS, or the one electron-builder downloaded to build the installer; null without one.
function makensis() {
  if (process.env.RUKOO_MAKENSIS) return process.env.RUKOO_MAKENSIS;
  // Cache/nsis-<version>/nsis-<version>-<id>/makensis.exe
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  try {
    for (const version of fs.readdirSync(cache).filter((d) => /^nsis-\d/.test(d))) {
      for (const dir of fs.readdirSync(path.join(cache, version))) {
        const exe = path.join(cache, version, dir, 'makensis.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch (_) {
    // No cache.
  }
  return null;
}

test('the uninstaller takes the Run value only when its whole program is this installation', { skip: process.platform !== 'win32' || !makensis() ? 'needs makensis on Windows' : false }, (t) => {
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  const remove = nsh.slice(nsh.indexOf('!macro rukooRemoveLoginItem'), nsh.indexOf('!macroend', nsh.indexOf('!macro rukooRemoveLoginItem')));
  // The value Electron writes, under its name, compared with the whole program.
  assert.ok(remove.includes(String.raw`ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "` + APP_ID + '"'));
  assert.ok(remove.includes('${if} $1 == "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"'));
  assert.equal(winCommand(ALL_USERS_EXE, [HIDDEN_FLAG])[0], '"', 'Electron quotes every path with a backslash');

  // rukooRunProgram, run in a small program of its own that only writes a file.
  const dir = tempDir('rukoo-nsis-');
  t.after(() => removeDir(dir));
  const cases = [
    [`"${ALL_USERS_EXE}" ${HIDDEN_FLAG}`, ALL_USERS_EXE],
    [`"${ALL_USERS_EXE}"`, ALL_USERS_EXE],
    [`"${ALL_USERS_EXE}.old" ${HIDDEN_FLAG}`, `${ALL_USERS_EXE}.old`],
    [`${ALL_USERS_EXE} ${HIDDEN_FLAG}`, ''],
    [`"${ALL_USERS_EXE}`, ''],
    ['', '']
  ];
  const out = path.join(dir, 'out.txt');
  const script = [
    'Unicode true',
    '!include LogicLib.nsh',
    `!include "${path.join(__dirname, '..', 'build', 'installer.nsh')}"`,
    `OutFile "${path.join(dir, 'harness.exe')}"`,
    'SilentInstall silent',
    'RequestExecutionLevel user',
    'Section',
    `  FileOpen $9 "${out}" w`,
    ...cases.flatMap(([value]) => [`  StrCpy $0 '${value}'`, '  !insertmacro rukooRunProgram', '  FileWrite $9 "[$1]$\\n"']),
    '  FileClose $9',
    'SectionEnd',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'harness.nsi'), script);
  execFileSync(makensis(), ['/V1', path.join(dir, 'harness.nsi')], { stdio: 'pipe' });
  execFileSync(path.join(dir, 'harness.exe'), [], { stdio: 'pipe' });
  const lines = fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean);
  assert.deepEqual(lines, cases.map(([, program]) => `[${program}]`));
});
