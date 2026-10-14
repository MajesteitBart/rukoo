'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const en = require('../src/i18n/en');
const { MailClient, NAME, PROG_ID, SETTINGS_URL } = require('../src/main/mailclient');

const EXE = 'C:\\Program Files\\Rukoo Mail\\Rukoo Mail.exe';

test('the registration starts Rukoo with the link after "--", and lists it as an email app', async () => {
  const calls = [];
  const client = new MailClient({ exe: EXE, description: 'Email', run: async (args) => calls.push(args) });
  await client.register();
  const value = (key, name) => {
    const c = calls.find((a) => a[1].endsWith(key) && (name === null ? a.includes('/ve') : a[a.indexOf('/v') + 1] === name));
    return c && c[c.indexOf('/d') + 1];
  };
  assert.equal(value(`Classes\\${PROG_ID}\\shell\\open\\command`, null), `"${EXE}" -- "%1"`);
  assert.equal(value(`Clients\\Mail\\${NAME}\\Capabilities\\URLAssociations`, 'mailto'), PROG_ID);
  assert.equal(value('RegisteredApplications', NAME), `Software\\Clients\\Mail\\${NAME}\\Capabilities`);
  assert.ok(calls.every((a) => a[0] === 'add' && a[1].startsWith('HKCU\\Software\\') && a.at(-1) === '/f'));
  assert.equal(SETTINGS_URL, 'ms-settings:defaultapps?registeredAppUser=Rukoo%20Mail');
});

test('the installer writes the same registration as the app', () => {
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macroend'));
  const written = [...install.matchAll(/WriteRegStr HKCU "([^"]+)" "([^"]*)" (?:'([^']*)'|"([^"]*)")/g)].map(([, key, name, single, double]) => [
    `HKCU\\${key.replace('${RUKOO_MAIL_KEYS}', 'Software')}`,
    name || null,
    single ?? double
  ]);
  const app = new MailClient({ exe: '$INSTDIR\\${APP_EXECUTABLE_FILENAME}', description: en['settings.general.mailtoAppDescription'].message }).values();
  assert.deepEqual(written.map(String).sort(), app.map(String).sort());
});

test('at startup the installed app offers itself, a portable copy only when asked, and a moved program is replaced', async () => {
  const cases = [
    { name: 'installed, nothing registered', current: null, portable: false, registers: true },
    { name: 'portable, nothing registered', current: null, portable: true, registers: false },
    { name: 'another copy that is still there', current: 'D:\\Portable\\Rukoo Mail.exe', exists: true, portable: false, registers: false },
    { name: 'a program that is gone', current: 'E:\\Moved\\Rukoo Mail.exe', exists: false, portable: true, registers: true }
  ];
  for (const c of cases) {
    const writes = [];
    const run = async (args) => {
      if (args[0] !== 'query') return writes.push(args);
      if (!c.current) throw new Error('The system was unable to find the specified registry key or value.');
      return `\r\nHKEY_CURRENT_USER\\Software\\Classes\\${PROG_ID}\\shell\\open\\command\r\n    (Default)    REG_SZ    "${c.current}" -- "%1"\r\n`;
    };
    const client = new MailClient({ exe: EXE, run, exists: (file) => file === c.current && Boolean(c.exists) });
    assert.equal(await client.refresh({ portable: c.portable }), c.registers, c.name);
    assert.equal(writes.length > 0, c.registers, c.name);
  }
});

test('registering for real writes values Windows reads back unchanged', { skip: process.platform !== 'win32' }, async () => {
  // A scratch key of its own, so the test never touches Rukoo's real registration.
  const base = `HKCU\\Software\\RukooMailTest-${crypto.randomUUID()}`;
  const client = new MailClient({ exe: EXE, description: 'Rukoo Mail: an email client', base });
  try {
    assert.equal(await client.registered(), false);
    assert.equal(await client.registeredExe(), null);
    await client.register();
    assert.equal(await client.registered(), true);
    assert.equal(await client.registeredExe(), EXE);
    const command = execFileSync('reg', ['query', client.keys.command, '/ve'], { encoding: 'utf8' });
    assert.match(command, /REG_SZ\s+"C:\\Program Files\\Rukoo Mail\\Rukoo Mail\.exe" -- "%1"\r?\n/);
    const protocol = execFileSync('reg', ['query', client.keys.prog, '/v', 'URL Protocol'], { encoding: 'utf8' });
    assert.match(protocol, /URL Protocol\s+REG_SZ\s*\r?\n/);
    // Registering again, from another place on disk, replaces the program.
    await new MailClient({ exe: 'D:\\Apps\\Rukoo Mail.exe', base }).register();
    assert.equal(await client.registeredExe(), 'D:\\Apps\\Rukoo Mail.exe');
  } finally {
    try {
      execFileSync('reg', ['delete', base, '/f'], { stdio: 'ignore' });
    } catch (_) {
      // Never created.
    }
  }
});
