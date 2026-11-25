// End-to-end tests for Settings > General > Open when you sign in (src/main/loginitem.js) and the hidden start it sets
// up. Test mode never touches the system's login items: main keeps the login item in memory (memoryLogin), behaving as
// Electron does on Windows or on a Mac. A Linux machine, which has no switch itself, runs both through SEM_LOGIN_ITEM;
// Windows and macOS run their own. A real sign-in is checked by hand on an installed build.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp, kill } = require('./close');

const LINUX = process.platform === 'linux';
// Whether this system has a tray icon for a hidden window; a Mac has the Dock.
const TRAY = process.platform !== 'darwin';
const SHAPES = LINUX ? ['win32', 'darwin'] : [process.platform];
// The program the Windows-shaped login item registers in test mode (main.js TEST_LOGIN_EXE): the default path for all
// users, with its spaces.
const WIN_EXE = 'C:\\Program Files\\Rukoo Mail\\Rukoo Mail.exe';
// The toast when the system kept the login item as it was (settings.general.openAtLoginFailed).
const FAILED = "Rukoo couldn't change this.";

let app;
let win;
let dataDir;
let running;

// shape: the system main's login item plays; env: more of the environment, such as SEM_LOGIN_OPENED. early: runs as
// soon as Rukoo has started, before its first window is up.
async function launch({ shape, args = [], env: more = {}, early = null } = {}) {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', ...more };
  if (shape) env.SEM_LOGIN_ITEM = shape;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', ...args], cwd: path.join(__dirname, '..', '..'), env });
  running = true;
  app.process().once('exit', () => (running = false));
  if (early) await early();
  win = await app.firstWindow();
}

// A profile with the demo account, closed again unless open.
function writeSettings(settings) {
  fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language: 'en', ...settings }));
}

async function demoProfile({ shape, open = true, settings = {}, env = {} } = {}) {
  writeSettings(settings);
  await launch({ shape, env });
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  if (!open) await closeApp(app);
}

test.beforeEach(() => {
  dataDir = tempDir('sem-e2e-');
});

test.afterEach(async () => {
  if (running) await closeApp(app);
  removeDir(dataDir);
});

// What the system has: the Windows Run value, or the Mac's SMAppService status.
const system = () => app.evaluate(() => global.__semLoginItem.system.state);
// What the system's own settings do: Windows' Startup apps turns the entry off, and turning Rukoo off under the Mac's
// Login Items leaves it waiting for approval.
const turnOffInSystem = () => app.evaluate(() => global.__semLoginItem.system.off());
const row = () => win.locator('.settings [data-a="open-at-login"]');
const isOn = () => expect(row().locator('.switch')).toHaveClass(/\bon\b/);
const isOff = () => expect(row().locator('.switch')).not.toHaveClass(/\bon\b/);

// The main window, as main sees it.
const main = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html'));
    return w ? { visible: w.isVisible(), focused: w.isFocused() } : null;
  });

const heldFile = () => path.join(dataDir, 'data', 'held.json');
const unsentFile = () => path.join(dataDir, 'data', 'unsent.json');
const subjectsIn = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.restore.state.subject).sort();
const composeWindows = () => app.windows().filter((p) => p.url().endsWith('compose.html'));
// The subjects of the compose windows open now, once there are count of them.
async function composeSubjects(count) {
  await expect.poll(() => composeWindows().length, { timeout: 15000 }).toBe(count);
  const subjects = [];
  for (const w of composeWindows()) {
    await w.waitForSelector('.composer .editor');
    subjects.push(await w.locator('[data-field="subject"]').inputValue());
  }
  return subjects.sort();
}
// Sending fails, and so does keeping the email in Drafts: what a quit then can't keep goes to unsent.json. No
// autosave settles an email before the test looks either.
const mailFails = () =>
  app.evaluate(() => {
    global.__semEngine.send = () => Promise.reject(new Error('Mailbox full'));
    global.__semEngine.saveDraft = () => Promise.reject(new Error('No connection'));
  });
// A mailto: link for the running Rukoo: its compose window, filled in, which closing asks about.
async function mailtoWindow(subject) {
  const link = `mailto:someone@example.com?subject=${encodeURIComponent(subject)}&body=Written%20at%20sign-in.`;
  const [page] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ app }, link) => app.emit('second-instance', {}, ['rukoo', link], process.cwd()), link)]);
  page.on('dialog', () => {});
  await page.waitForSelector('.composer .editor');
  return page;
}

// What the last run leaves: an email that waits out its Undo notice when Rukoo is killed (held.json), and one a quit
// couldn't send or keep in Drafts (unsent.json), here the same email under another subject. Rukoo is not running after.
async function leaveMail(shape) {
  // Undo send on for 30 seconds, so the email waits in the outbox (main.js undoSendDelay).
  await demoProfile({ shape, settings: { undoSend: 30 }, env: { SEM_UNDO_SEND: '1' } });
  await app.evaluate(() => {
    global.__semEngine.send = () => new Promise(() => {});
  });
  await win.click('[data-action="compose"]');
  const c = win.locator('.composer');
  await c.locator('[data-rinput="to"]').fill('someone@example.com');
  await c.locator('[data-rinput="to"]').press('Enter');
  await c.locator('[data-field="subject"]').fill('Held at sign-in');
  await c.locator('.editor').click();
  await win.keyboard.type('Kept through the restart.');
  await c.locator('[data-c="send"]').click();
  await expect(c).toHaveCount(0, { timeout: 10000 });
  await expect.poll(() => fs.existsSync(heldFile())).toBe(true);
  const exited = app.waitForEvent('close');
  kill(app.process());
  await exited;
  const [held] = JSON.parse(fs.readFileSync(heldFile(), 'utf8'));
  const restore = JSON.parse(JSON.stringify(held.restore));
  restore.state.subject = 'Unsent at sign-in';
  fs.writeFileSync(unsentFile(), JSON.stringify([{ id: 'unsent-1', restore, error: 'Mailbox full' }]));
}
const LEFT = ['Held at sign-in', 'Unsent at sign-in'];

for (const shape of SHAPES) {
  const MAC = shape === 'darwin';
  // How a start from the login item looks: the flag on Windows, the start itself on a Mac.
  const loginStart = MAC ? { env: { SEM_LOGIN_OPENED: '1' } } : { args: ['--start-hidden'] };

  test.describe(MAC ? 'a Mac login item' : 'a Windows login item', () => {
    test('the switch turns the login item on and off, starts off, and shows what the system has', async () => {
      await demoProfile({ shape });
      await win.click('[data-action="settings"]');
      await expect(row()).toContainText(MAC ? 'Open at login' : 'Open when you sign in');
      await expect(row()).toContainText('new mail and team chat notify you without opening Rukoo first');
      await isOff();

      await row().click();
      await isOn();
      await expect(row()).toBeFocused();
      if (MAC) {
        // The Mac registers the app bundle itself, without a path or arguments.
        expect((await system()).status).toBe('enabled');
        const sets = await app.evaluate(() => global.__semLoginItem.system.calls.filter(([c]) => c === 'set').map(([, s]) => s));
        expect(sets).toEqual([{ openAtLogin: true }]);
      } else {
        // The installed program, quoted for its spaces, started hidden.
        expect((await system()).run).toEqual({ 'nl.bvdm.rukoo-mail': `"${WIN_EXE}" --start-hidden` });
      }

      // Turned off in the system's own settings: coming back to Rukoo shows it.
      await turnOffInSystem();
      await win.evaluate(() => window.dispatchEvent(new Event('focus')));
      if (MAC) {
        // Still registered, waiting for approval: on, with the way out.
        await expect(row()).toContainText('or turn this off to cancel');
        await isOn();
        await row().click();
        await isOff();
        await expect(row()).not.toContainText('Login Items');
        expect((await system()).status).toBe('not-registered');
      } else {
        await isOff();
        // On again here approves it again, and off removes it.
        await row().click();
        await isOn();
        expect((await system()).approved).toEqual({});
        await row().click();
        await isOff();
        expect((await system()).run).toEqual({});
      }
    });

    test('a copy that may not register shows why, without a switch, and main refuses it too', async () => {
      await demoProfile({ shape });
      // What loginTarget() gives a portable or unpacked copy and a run from source.
      await app.evaluate(() => (global.__semLoginItem.target = null));
      // The Mac's start asked whether it came from the login item; nothing asks the system from here on.
      const asked = await app.evaluate(() => global.__semLoginItem.system.calls.length);
      await win.click('[data-action="settings"]');
      const line = win.locator('.settings [data-login]');
      await expect(line).toContainText(MAC ? 'Move Rukoo Mail to Applications and open it there first.' : 'Only the installed app can open when you sign in.');
      await expect(line.locator('.switch')).toHaveCount(0);
      await expect(row()).toHaveCount(0);
      const refused = await win.evaluate(() => window.mail.call('setOpenAtLogin', true).then(() => 'set', (err) => err.message));
      expect(refused).toContain('Only the installed app');
      expect(await app.evaluate(() => global.__semLoginItem.system.calls.length)).toBe(asked);
    });

    test('started by the login item, the window stays hidden with a tray icon, also with close to tray off', async () => {
      // Close to tray and minimize to tray off, as on Linux by default.
      await demoProfile({ shape, open: false, settings: { closeToTray: false, minimizeToTray: false } });
      await launch({ shape, ...loginStart });
      await win.waitForLoadState('domcontentloaded');
      await expect(win.locator('.item').first()).toBeAttached({ timeout: 15000 });
      // It stays hidden, and nothing took the focus.
      await win.waitForTimeout(1500);
      expect(await main()).toEqual({ visible: false, focused: false });
      if (TRAY) expect(await app.evaluate(() => Boolean(global.__semTray))).toBe(true);

      if (!MAC) {
        // The login item starting Rukoo again changes nothing; the flag after "--" is no flag.
        await app.evaluate(({ app }) => app.emit('second-instance', {}, ['rukoo', '--start-hidden'], process.cwd()));
        await win.waitForTimeout(500);
        expect((await main()).visible).toBe(false);
        await app.evaluate(({ app }) => app.emit('second-instance', {}, ['rukoo', '--', '--start-hidden'], process.cwd()));
      } else {
        await app.evaluate(({ app }) => app.emit('second-instance', {}, ['rukoo'], process.cwd()));
      }
      // The person starting it shows the window.
      await expect.poll(async () => (await main()).visible).toBe(true);
      // The tray icon stays for this run.
      if (TRAY) expect(await app.evaluate(() => Boolean(global.__semTray))).toBe(true);

      // With close to tray off, closing the window quits, as that setting says.
      if (TRAY) {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).close());
        await expect.poll(() => running, { timeout: 30000 }).toBe(false);
      }
    });

    test('a profile without any account starts with its window, also from the login item', async () => {
      writeSettings({ closeToTray: false, minimizeToTray: false });
      await launch({ shape, ...loginStart });
      await win.waitForSelector('.provider-grid');
      await expect.poll(async () => (await main()).visible).toBe(true);
      expect(await app.evaluate(() => Boolean(global.__semTray))).toBe(false);
    });

    test('mail the last run left unsent waits on disk until the window first shows', async () => {
      await leaveMail(shape);
      await launch({ shape, ...loginStart, env: { ...(loginStart.env || {}), SEM_UNDO_SEND: '1' } });
      await expect(win.locator('.item').first()).toBeAttached({ timeout: 15000 });
      await win.waitForTimeout(2000);
      // Nothing opened at sign-in, and both files keep their emails.
      expect(app.windows().length).toBe(1);
      expect((await main()).visible).toBe(false);
      expect(subjectsIn(unsentFile())).toEqual(['Unsent at sign-in']);
      expect(subjectsIn(heldFile())).toEqual(['Held at sign-in']);

      await mailFails();
      await app.evaluate(({ app }) => app.emit('second-instance', {}, ['rukoo'], process.cwd()));
      await expect.poll(async () => (await main()).visible).toBe(true);
      expect(await composeSubjects(2)).toEqual(LEFT);
      expect(fs.existsSync(unsentFile())).toBe(false);
    });

    test('a second start before the window has rendered still opens the mail the last run left', async () => {
      await leaveMail(shape);
      // The person starts Rukoo again right after the start from sign-in, while its page still loads. Playwright's
      // evaluate can run in the middle of main's startup code; a real second start comes as an event of its own, after
      // that code, so it goes through a timer here.
      const early = async () => {
        const shown = await app.evaluate(
          ({ app, BrowserWindow }) =>
            new Promise((resolve) => {
              const go = () => {
                const w = BrowserWindow.getAllWindows()[0];
                if (!w) return setTimeout(go, 5);
                global.__order = [];
                w.once('ready-to-show', () => global.__order.push('rendered'));
                setTimeout(() => {
                  app.emit('second-instance', {}, ['rukoo'], process.cwd());
                  global.__order.push('shown');
                  resolve(w.isVisible());
                }, 0);
              };
              go();
            })
        );
        expect(shown).toBe(true);
      };
      await launch({ shape, ...loginStart, env: { ...(loginStart.env || {}), SEM_UNDO_SEND: '1' }, early });
      // The window showed first and rendered after.
      await expect.poll(() => app.evaluate(() => global.__order), { timeout: 15000 }).toEqual(['shown', 'rendered']);
      await mailFails();
      expect(await composeSubjects(2)).toEqual(LEFT);
      expect((await main()).visible).toBe(true);
      expect(fs.existsSync(unsentFile())).toBe(false);
    });

    test('an .ics file at the start from sign-in shows the window, and the mail the last run left opens with it', async () => {
      await leaveMail(shape);
      const start = Date.now() + 86400000;
      const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const file = path.join(dataDir, 'Dentist.ics');
      const ics = ['BEGIN:VCALENDAR', 'PRODID:-//Rukoo tests//EN', 'VERSION:2.0', 'METHOD:PUBLISH', 'BEGIN:VEVENT', 'UID:dentist-1@example.com'];
      ics.push(`DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 1800000)}`, 'SUMMARY:Dentist', 'END:VEVENT', 'END:VCALENDAR', '');
      fs.writeFileSync(file, ics.join('\r\n'));
      await launch({ shape, args: [...(loginStart.args || []), '--', file], env: { ...(loginStart.env || {}), SEM_UNDO_SEND: '1' } });
      await expect(win.locator('.scrim .dialog .invite-title')).toHaveText('Dentist', { timeout: 15000 });
      expect((await main()).visible).toBe(true);
      await mailFails();
      expect(await composeSubjects(2)).toEqual(LEFT);
      expect(fs.existsSync(unsentFile())).toBe(false);
    });

    if (MAC) {
      test('a login item that still waits for approval after the switch turned it off says so', async () => {
        await demoProfile({ shape });
        await win.click('[data-action="settings"]');
        await row().click();
        await isOn();
        await turnOffInSystem();
        await win.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(row()).toContainText('or turn this off to cancel');
        // Electron logs a failed unregister without throwing, and macOS still waits for approval.
        await app.evaluate(() => {
          const system = global.__semLoginItem.system;
          system.set = (settings) => system.calls.push(['set', settings]);
        });
        await row().click();
        await expect(win.locator('#toast')).toContainText(FAILED);
        await isOn();
        await expect(row()).toContainText('or turn this off to cancel');
      });
    }
  });
}

// Whatever this run writes to unsent.json before the window first shows keeps what the last run left there: when a
// quit can't send an email or keep it in Drafts, and when that quit is called off.
test.describe('mail the last run left, while a start from sign-in quits', () => {
  const shape = SHAPES[0];
  const loginStart = shape === 'darwin' ? { env: { SEM_LOGIN_OPENED: '1', SEM_UNDO_SEND: '1' } } : { args: ['--start-hidden'], env: { SEM_UNDO_SEND: '1' } };

  // A compose window from a link, sent: it closes, and the email waits in the outbox.
  async function sendFromLink(subject) {
    const page = await mailtoWindow(subject);
    const closed = page.waitForEvent('close');
    await page.click('[data-c="send"]').catch(() => {});
    await closed;
    await expect.poll(() => app.evaluate(() => global.__semOutbox.size)).toBe(1);
  }

  test('a quit that can neither send an email nor keep it in Drafts adds it to what unsent.json has', async () => {
    await leaveMail(shape);
    await launch({ shape, ...loginStart });
    await expect(win.locator('.item').first()).toBeAttached({ timeout: 15000 });
    await mailFails();
    await sendFromLink('Failed while quitting');
    expect((await main()).visible).toBe(false);

    await closeApp(app);
    expect(subjectsIn(unsentFile())).toEqual(['Failed while quitting', 'Unsent at sign-in']);
    expect(subjectsIn(heldFile())).toEqual(['Held at sign-in']);
  });

  test('a quit called off after it wrote unsent.json leaves what the last run left there', async () => {
    await leaveMail(shape);
    await launch({ shape, ...loginStart });
    await expect(win.locator('.item').first()).toBeAttached({ timeout: 15000 });
    await mailFails();
    await sendFromLink('Failed while quitting');
    // An editor the link filled in holds the quit with its question.
    const asking = await mailtoWindow('Half written');
    await app.evaluate(({ app }) => {
      app.quit();
    });
    await expect(asking.locator('.scrim')).toContainText('Save draft?');
    // The send fails while the quit waits, and so does the Drafts save: written down at once, beside the last run's.
    await app.evaluate(() => global.__semOutbox.flush());
    await expect.poll(() => fs.existsSync(unsentFile()) && subjectsIn(unsentFile())).toEqual(['Failed while quitting', 'Unsent at sign-in']);

    // Cancel: this run's email opens now, and the last run's stays for the window's first show.
    const [again] = await Promise.all([app.waitForEvent('window'), asking.click('.scrim .buttons button:text-is("Cancel")')]);
    await again.waitForSelector('.composer .editor');
    await expect(again.locator('[data-field="subject"]')).toHaveValue('Failed while quitting');
    expect(subjectsIn(unsentFile())).toEqual(['Unsent at sign-in']);
    expect(subjectsIn(heldFile())).toEqual(['Held at sign-in']);

    // The person opens Rukoo: the last run's mail opens, once.
    await app.evaluate(({ app }) => app.emit('second-instance', {}, ['rukoo'], process.cwd()));
    await expect.poll(async () => ((await main()) || {}).visible).toBe(true);
    expect(await composeSubjects(4)).toEqual(['Failed while quitting', 'Half written', ...LEFT]);
    expect(fs.existsSync(unsentFile())).toBe(false);
  });
});

test('a normal start shows the window and leaves the tray as the settings say', async () => {
  await demoProfile({ shape: SHAPES[0], open: false, settings: { closeToTray: false, minimizeToTray: false } });
  await launch({ shape: SHAPES[0] });
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  expect((await main()).visible).toBe(true);
  expect(await app.evaluate(() => Boolean(global.__semTray))).toBe(false);
});

test('Linux has no switch: the row says the desktop starts Rukoo', async () => {
  test.skip(!LINUX, 'Linux only');
  await demoProfile();
  await win.click('[data-action="settings"]');
  const line = win.locator('.settings [data-login]');
  await expect(line).toContainText('Open when you sign in');
  await expect(line).toContainText("Your desktop's own startup settings can start Rukoo when you sign in.");
  await expect(line).not.toContainText('hidden in the tray');
  await expect(line.locator('.switch')).toHaveCount(0);
  const refused = await win.evaluate(() => window.mail.call('setOpenAtLogin', true).then(() => 'set', (err) => err.message));
  expect(refused).toContain('Only the installed app');
  // A start with the flag is an ordinary start there.
  await closeApp(app);
  await launch({ args: ['--start-hidden'] });
  await expect.poll(async () => (await main()).visible).toBe(true);
});
