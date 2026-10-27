// The setup form in the real app with a throwaway profile: the app password note for Google and Yahoo, a refused
// password, and an account added with a calendar server. The mail servers are stand-ins on this PC: the test IMAP
// server in test/fixtures, or a session that accepts any sign-in. The calendar server is the CalDAV test server.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { imapServer, GMAIL_APP_PASSWORD_REQUIRED } = require('../fixtures/imap-server');
const { caldavServer } = require('../fixtures/caldav-server');

let app;
let win;
let dataDir;

test.beforeEach(async () => {
  dataDir = tempDir('sem-e2e-setup-');
  fs.mkdirSync(path.join(dataDir, 'data'));
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language: 'en' }));
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  // No Google OAuth client, as in a build from source: the Google tile shows the password form.
  delete env.SEM_GOOGLE_CLIENT_ID;
  delete env.SEM_GOOGLE_CLIENT_SECRET;
  // Adding an account stores its password with safeStorage, which needs the real keyring on Linux (see the IMAP tests).
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 950));
  await win.waitForSelector('.provider-grid', { timeout: 15000 });
  // Stand-in for the browser: record what would open.
  await app.evaluate(({ shell }) => {
    global.__opened = [];
    shell.openExternal = async (url) => global.__opened.push(url);
  });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const opened = () => app.evaluate(() => global.__opened);
const form = () => win.locator('.setup form');

test('Gmail and Yahoo say to use an app password before sign-in, and a refused password says so without the server fields', async () => {
  const server = await imapServer({ login: GMAIL_APP_PASSWORD_REQUIRED });
  try {
    await win.click('[data-provider="google"]');
    await expect(win.locator('.login-head h2')).toHaveText('Sign in to Google');
    const callout = win.locator('.setup-callout');
    await expect(callout).toContainText('Gmail only accepts an app password here, not your normal Google password.');
    // The note comes before the password field, and the field asks for an app password.
    const order = await form().evaluate((f) => [...f.querySelectorAll('.setup-callout, [name=password]')].map((e) => (e.name ? 'password' : 'callout')));
    expect(order).toEqual(['callout', 'password']);
    await expect(form().locator('[name=password]')).toHaveAttribute('placeholder', 'App password');
    await callout.locator('[data-s="app-password"]').click();
    expect(await opened()).toEqual(['https://myaccount.google.com/apppasswords']);
    // Without an OAuth client the form says why it shows no browser sign-in, and offers the import.
    await expect(win.locator('.setup-foot')).toContainText('Browser sign-in isn\'t available: this copy of Rukoo has no Google OAuth client.');
    await expect(win.locator('.setup-foot [data-s="import-google"]')).toHaveText('Import Google OAuth client');
    // Gmail has no CalDAV for app passwords, so its server fields leave the calendar out.
    await expect(form().locator('[name=caldavUrl]')).toHaveCount(0);

    // The sign-in goes to the test IMAP server, which answers as Gmail does to a normal Google password.
    await app.evaluate((_electron, port) => {
      const engine = global.__semEngine;
      const session = engine.session.bind(engine);
      global.__imapPort = port;
      engine.session = (acc) => {
        if (acc.type === 'imap') acc.imap = { ...acc.imap, host: '127.0.0.1', port: global.__imapPort, secure: false };
        return session(acc);
      };
    }, server.port);
    await form().locator('[name=email]').fill('me@gmail.com');
    await form().locator('[name=password]').fill('normal-password');
    await form().locator('button[type=submit]').click();
    const error = form().locator('[data-error]');
    await expect(error).toContainText("Google didn't accept this password. Gmail only works here with an app password", { timeout: 15000 });
    expect(await error.textContent()).not.toContain('IMAP:');
    expect(server.logins).toHaveLength(1);
    // A refused password is not a server problem: the server fields stay closed.
    await expect(form().locator('.manual')).toBeHidden();
    await expect(form().locator('[data-s="manual"]')).toBeVisible();
    await error.locator('[data-s="app-password"]').click();
    expect(await opened()).toEqual(['https://myaccount.google.com/apppasswords', 'https://myaccount.google.com/apppasswords']);
    expect(await app.evaluate(() => global.__semEngine.accounts.length)).toBe(0);

    // Yahoo gets the same note, with its own page.
    await win.click('[data-s="grid"]');
    await win.click('[data-provider="yahoo"]');
    await expect(win.locator('.setup-callout')).toContainText('Yahoo Mail only accepts an app password here');
    await expect(form().locator('[name=password]')).toHaveAttribute('placeholder', 'App password');
    await expect(win.locator('.setup-foot')).toHaveCount(0);
    await win.locator('.setup-callout [data-s="app-password"]').click();
    expect((await opened()).at(-1)).toBe('https://login.yahoo.com/account/security');

    // Other providers keep the note under the password field and the general placeholder.
    await win.click('[data-s="grid"]');
    await win.click('[data-provider="outlook"]');
    await expect(win.locator('.setup-callout')).toHaveCount(0);
    await expect(form().locator('.note')).toContainText('Only works if your account allows IMAP');
    await expect(form().locator('[name=password]')).toHaveAttribute('placeholder', 'Password or app password');

    // Elsewhere a refused password keeps the general message after the server's name, and the server fields still
    // stay closed: "IMAP" in the message used to open them.
    await win.click('[data-s="grid"]');
    await win.click('[data-provider="other"]');
    await form().locator('[name=email]').fill('me@example.com');
    await form().locator('[name=password]').fill('wrong-password');
    await form().locator('button[type=submit]').click();
    await expect(error).toHaveText('IMAP: Sign-in failed. Check your email address and password or app password.', { timeout: 15000 });
    await expect(form().locator('.manual')).toBeHidden();
    await expect(error.locator('[data-s="app-password"]')).toHaveCount(0);

    // A server that doesn't answer still opens them, as before.
    const gone = await imapServer();
    await gone.close();
    await app.evaluate((_electron, port) => (global.__imapPort = port), gone.port);
    await form().locator('button[type=submit]').click();
    await expect(error).toHaveText(/^IMAP: Connection refused/, { timeout: 15000 });
    await expect(form().locator('.manual')).toBeVisible();
  } finally {
    await server.close();
  }
});

test('a Gmail or Yahoo address added under Other gets the app password message and link after a refused password', async () => {
  const server = await imapServer({ login: GMAIL_APP_PASSWORD_REQUIRED });
  try {
    // Only the connection goes to the test IMAP server: the account keeps Gmail's or Yahoo's server, which is how
    // Rukoo knows the provider when the tile was Other.
    await app.evaluate((_electron, port) => {
      const engine = global.__semEngine;
      const session = engine.session.bind(engine);
      engine.session = (acc) => {
        const s = session(acc);
        if (acc.type === 'imap' && !s.__testServer) {
          const options = s.imapOptions.bind(s);
          s.imapOptions = async () => ({ ...(await options()), host: '127.0.0.1', port, secure: false });
          s.__testServer = true;
        }
        return s;
      };
    }, server.port);
    const error = form().locator('[data-error]');
    const servers = () => app.evaluate(() => global.__semEngine.sessions.size);

    await win.click('[data-provider="other"]');
    await expect(win.locator('.setup-callout')).toHaveCount(0);
    await form().locator('[name=email]').fill('me@gmail.com');
    await form().locator('[name=password]').fill('normal-password');
    await form().locator('button[type=submit]').click();
    await expect(error).toContainText("Google didn't accept this password. Gmail only works here with an app password", { timeout: 15000 });
    expect(server.logins).toHaveLength(1);
    await expect(form().locator('.manual')).toBeHidden();
    await error.locator('[data-s="app-password"]').click();
    expect(await opened()).toEqual(['https://myaccount.google.com/apppasswords']);
    expect(await servers()).toBe(0);

    // The same form with a Yahoo address links to Yahoo's page, and only once.
    await form().locator('[name=email]').fill('me@yahoo.com');
    await form().locator('button[type=submit]').click();
    await expect(error).toContainText("Yahoo didn't accept this password.", { timeout: 15000 });
    await expect(error.locator('[data-s="app-password"]')).toHaveCount(1);
    await error.locator('[data-s="app-password"]').click();
    expect((await opened()).at(-1)).toBe('https://login.yahoo.com/account/security');
    expect(await app.evaluate(() => global.__semEngine.accounts.length)).toBe(0);
  } finally {
    await server.close();
  }
});

test('importing a Google OAuth client from the Gmail form goes on to browser sign-in', async () => {
  const client = path.join(dataDir, 'client.json');
  fs.writeFileSync(client, JSON.stringify({ installed: { client_id: 'test-client.apps.googleusercontent.com', client_secret: 'test-secret' } }));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, client);
  await win.click('[data-provider="google"]');
  await win.click('.setup-foot [data-s="import-google"]');
  await expect(win.locator('#toast')).toHaveText('Google sign-in is ready');
  await expect(win.locator('.login-head h2')).toHaveText('Sign in to Google');
  await expect(win.locator('[data-s="google"]')).toHaveText('Sign in with Google');
  await expect(win.locator('.setup-foot')).toHaveCount(0);
});

test('an account added with a calendar server shows its calendar without a visit to Server settings', async () => {
  test.setTimeout(60000);
  const ME = 'me@example.com';
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const day = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', 'UID:standup', `DTSTART:${day}T093000`, `DTEND:${day}T094500`, 'SUMMARY:Stand-up', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const calendar = await caldavServer({ objects: { 'home/standup.ics': ics } });
  try {
    // Mail servers that accept the sign-in and have no mail, so only the calendar server is real here.
    await app.evaluate(() => {
      const engine = global.__semEngine;
      const session = engine.session.bind(engine);
      engine.session = (acc) => {
        if (acc.type !== 'imap') return session(acc);
        if (!engine.sessions.has(acc.id)) engine.sessions.set(acc.id, { verify: async () => {}, listFolders: async () => [], close: async () => {} });
        return engine.sessions.get(acc.id);
      };
    });
    await win.click('[data-provider="other"]');
    await form().locator('[name=email]').fill(ME);
    await form().locator('[name=password]').fill('secret');
    // The calendar server is one of the manual server fields, empty and optional.
    await expect(form().locator('[name=caldavUrl]')).toBeHidden();
    await win.click('[data-s="manual"]');
    const field = form().locator('[name=caldavUrl]');
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('placeholder', 'Optional, for example caldav.example.com');
    await expect(form().locator('.manual .field-help')).toHaveText('Rukoo signs in with the username and password above. Leave this empty to show no calendar for this account.');

    // An address Rukoo won't send the password to fails the form with its reason; nothing is saved.
    await field.fill('http://dav.example.com/');
    await form().locator('button[type=submit]').click();
    await expect(form().locator('[data-error]')).toHaveText(/Use an https:\/\/ address/);
    expect(await app.evaluate(() => global.__semEngine.accounts.length)).toBe(0);
    await expect(form().locator('.manual')).toBeVisible();

    await field.fill(`${calendar.url}/`);
    await form().locator('button[type=submit]').click();
    await expect(win.locator('#toast')).toHaveText(`${ME} has been added`, { timeout: 15000 });
    const saved = await app.evaluate(() => global.__semEngine.accounts.map((a) => a.caldav));
    expect(saved).toEqual([{ url: `${calendar.url}/`, home: calendar.home }]);

    await win.click('[data-mode="calendar"]');
    await expect(win.locator('.sidebar .cal-toggle', { hasText: 'Home' })).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.calendar [data-ev]', { hasText: 'Stand-up' }).first()).toBeVisible({ timeout: 10000 });
  } finally {
    await calendar.close();
  }
});
