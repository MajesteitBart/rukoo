// Settings > General > Tabs: turning Mail, Calendar, Meet and Chat on and off (src/renderer/modes.js,
// src/main/modes.js). A hidden mode loses its tab, its shortcut, its notifications, sound and badges, and its ways in
// from outside; its account, data and sync stay. The demo account stands in for a real one, and desktop notifications
// are recorded instead of shown. Team chat isn't available in these tests (no account server), so Chat has no tab;
// modes-chat.spec.js covers Chat against the real account server.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const MailComposer = require('nodemailer/lib/mail-composer');
const { tempDir, removeDir } = require('../tmp');
const { closeApp, kill } = require('./close');

let app;
let win;
let dataDir;

async function launch(extra = {}) {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  win.on('dialog', () => {});
  await app.evaluate(({ BrowserWindow, Notification }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 950);
    // In the background, where new mail gets a desktop notification.
    BrowserWindow.getAllWindows()[0].isFocused = () => false;
    global.__shown = [];
    global.__closed = 0;
    Notification.prototype.show = function () {
      global.__shown.push(this);
    };
    Notification.prototype.close = function () {
      global.__closed += 1;
    };
  });
  await win.evaluate(() => {
    window.__badges = [];
    window.__newMail = [];
    window.__opened = [];
    window.mail.on(({ type, payload }) => {
      if (type === 'badge') window.__badges.push(payload);
      if (type === 'new-mail') window.__newMail.push(payload);
      if (type === 'open-message') window.__opened.push(payload);
    });
  });
}

// A new profile with the demo account; settings: what settings.json starts with.
async function start(settings = {}, extra = {}) {
  fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });
  // The tray, so its count and menu can be checked.
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ closeToTray: true, ...settings }));
  await launch(extra);
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
}

test.beforeEach(() => {
  dataDir = tempDir('rukoo-modes-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const tab = (mode) => win.locator(`.titlebar-modes [data-mode="${mode}"]`);
const shell = () => win.locator('#app .shell');
const settingsPage = () => win.locator('.page.settings');
const modeSwitch = (mode) => settingsPage().locator(`[data-a="mode:${mode}"]`);
const notice = () => win.locator('#toast');

// Escape goes back a page at a time: Tabs, then General, then the window.
async function closeSettings() {
  while (await settingsPage().count()) await win.keyboard.press('Escape');
  await expect(settingsPage()).toHaveCount(0);
}

async function openTabsSettings() {
  await win.click('[data-action="settings"]');
  await settingsPage().locator('[data-a="tabs"]').click();
  await expect(modeSwitch('mail')).toBeVisible();
}

// The setting as Settings > General > Tabs leaves it, without the page: the window follows main's 'updated'.
async function setHidden(list) {
  await win.evaluate((hiddenModes) => window.mail.call('updateSettings', { hiddenModes }), list);
  await expect.poll(() => win.evaluate(async () => JSON.stringify((await import('./app.js')).S.data.settings.hiddenModes))).toBe(JSON.stringify(list));
}

// An email lands in the demo inbox, and a sync finds it.
const arrive = (subject) =>
  app.evaluate(async (_e, subject) => {
    const engine = global.__semEngine;
    const raw = [
      'From: Sanne de Vries <sanne@example.com>',
      'To: demo@example.com',
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@example.com>`,
      '',
      'Hallo'
    ].join('\r\n');
    await engine.session(engine.accounts[0]).append('INBOX', raw);
    await engine.syncAll();
  }, subject);

const tray = () => app.evaluate(() => ({ tooltip: global.__semTray.tray.tooltip, dot: global.__semTray.dot, compose: Boolean(global.__semTray.menu.getMenuItemById('compose')) }));
const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test('hidden Mail leaves the tabs, the shortcut, notifications, badges and the tray, and comes back as it was', async () => {
  await start();
  await expect(tab('mail')).toBeVisible();
  await expect(shell()).not.toHaveClass(/calendar-mode/);
  // A notification that is still out when Mail goes.
  await arrive('Before Mail goes');
  await expect.poll(() => app.evaluate(() => global.__shown.length)).toBe(1);
  // The tray's menu as it was drawn while Mail showed, with New email.
  const staleCompose = await app.evaluate(() => Boolean(global.__semTray.menu.getMenuItemById('compose')));
  expect(staleCompose).toBe(true);

  await openTabsSettings();
  await expect(modeSwitch('chat')).toHaveCount(0);
  // The row is the switch: the button that takes the focus carries the role and its state.
  await expect(modeSwitch('mail')).toHaveAttribute('role', 'switch');
  await expect(modeSwitch('mail')).toHaveAttribute('aria-checked', 'true');
  await expect(modeSwitch('mail').locator('.switch')).toHaveAttribute('aria-hidden', 'true');
  await modeSwitch('mail').click();
  await expect(modeSwitch('mail')).toHaveAttribute('aria-checked', 'false');
  await expect(modeSwitch('mail').locator('.switch')).not.toHaveClass(/\bon\b/);
  await closeSettings();

  // The window left Mail for the first mode that shows, and Mail's tab and shortcut are gone.
  await expect(tab('mail')).toHaveCount(0);
  await expect(tab('calendar')).toHaveAttribute('aria-selected', 'true');
  await expect(shell()).toHaveClass(/calendar-mode/);
  await win.keyboard.press('Control+1');
  await expect(shell()).toHaveClass(/calendar-mode/);

  // Mail's notification that was still out closed, and a click on it now brings nothing.
  expect(await app.evaluate(() => global.__closed)).toBe(1);
  expect(await app.evaluate(() => global.__semClosedModes)).toEqual(['mail']);
  await app.evaluate(() => global.__shown[0].emit('click'));
  await win.waitForTimeout(300);
  expect(await win.evaluate(() => window.__opened)).toEqual([]);

  // New mail: no notification, no new-mail cue in the window, no badge count, no tray dot or count.
  await win.evaluate(() => {
    window.__badges = [];
    window.__newMail = [];
  });
  await arrive('While Mail is hidden');
  await expect.poll(() => app.evaluate(() => global.__semHiddenMail || 0)).toBeGreaterThan(0);
  expect(await app.evaluate(() => global.__shown.length)).toBe(1);
  expect(await win.evaluate(() => window.__newMail)).toEqual([]);
  expect((await win.evaluate(() => window.__badges)).filter((n) => n > 0)).toEqual([]);
  expect(await tray()).toEqual({ tooltip: 'Rukoo Mail', dot: false, compose: false });

  // A tray menu drawn before Mail went still had New email: its click asks again and opens nothing.
  await app.evaluate(() => global.__semTray.actions.compose());
  await expect(notice()).toContainText('Mail is turned off');
  expect(await windowCount()).toBe(1);

  // An email link whose notice goes without Turn on: main lets the link go, recipients and text included.
  const heldLinks = () => app.evaluate(() => global.__semHeldMailto.size);
  await app.evaluate(({ app }) => app.emit('second-instance', {}, ['Rukoo Mail.exe', '--', 'mailto:joris@example.com?subject=Private&body=Not%20for%20later'], process.cwd()));
  await expect(notice()).toContainText("Mail is turned off, so Rukoo didn't start a new email.");
  expect(await heldLinks()).toBe(1);
  await win.evaluate(() => window.mail.call('toastMain', 'Something else'));
  await expect(notice()).toContainText('Something else');
  await expect.poll(heldLinks).toBe(0);

  // An email link opened with Rukoo: no compose window, and a notice that offers to turn Mail on.
  await app.evaluate(({ app }) => app.emit('second-instance', {}, ['Rukoo Mail.exe', '--', 'mailto:sanne@example.com?subject=Hoi'], process.cwd()));
  await expect(notice()).toContainText("Mail is turned off, so Rukoo didn't start a new email.");
  expect(await windowCount()).toBe(1);
  expect(await heldLinks()).toBe(1);

  // The notice's Turn on brings Mail back, with what came in meanwhile, and starts the email the link asked for.
  const [compose] = await Promise.all([app.waitForEvent('window'), notice().locator('button').click()]);
  await compose.waitForSelector('.composer .editor');
  await expect(compose.locator('[data-field="subject"]')).toHaveValue('Hoi');
  expect(await heldLinks()).toBe(0);
  await expect(tab('mail')).toBeVisible();
  await expect(shell()).not.toHaveClass(/calendar-mode/);
  await expect(win.locator('.item', { hasText: 'While Mail is hidden' })).toBeVisible();
  expect((await tray()).compose).toBe(true);
  await arrive('Mail is back');
  await expect.poll(() => app.evaluate(() => global.__shown.length)).toBe(2);
  // Settings' test notification belongs to no tab and still shows.
  const sent = await win.evaluate(() => window.mail.call('testNotification'));
  expect(['sent', 'unavailable']).toContain(sent.result);
});

test('the last tab that shows stays on; a restart keeps the choice and starts in a mode that shows', async () => {
  await start();
  await openTabsSettings();
  await modeSwitch('mail').click();
  await expect(modeSwitch('mail').locator('.switch')).not.toHaveClass(/\bon\b/);
  await modeSwitch('calendar').click();
  await expect(modeSwitch('calendar').locator('.switch')).not.toHaveClass(/\bon\b/);
  // Meet is the only one left: its switch can't go off.
  await expect(modeSwitch('meeting')).toBeDisabled();
  await expect(modeSwitch('meeting')).toContainText('The only tab that shows');
  await modeSwitch('meeting').click({ force: true });
  await expect(modeSwitch('meeting').locator('.switch')).toHaveClass(/\bon\b/);
  expect(await app.evaluate(() => global.__semEngine.settings.hiddenModes)).toEqual(['mail', 'calendar']);
  await closeSettings();
  // One mode: no tabs at all, and the window is in it.
  await expect(win.locator('.titlebar-modes .mode-tabs')).toHaveCount(0);
  await expect(shell()).toHaveClass(/meeting-mode/);

  // The window was in Mail when it last closed; after the restart it starts in Meet.
  await win.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('rukoo.layout') || '{}');
    localStorage.setItem('rukoo.layout', JSON.stringify({ ...prefs, mode: 'mail' }));
  });
  await closeApp(app);
  await launch();
  await expect(shell()).toHaveClass(/meeting-mode/, { timeout: 15000 });
  await expect(win.locator('.titlebar-modes .mode-tabs')).toHaveCount(0);
  await expect(win.locator('.list-scroll')).toBeHidden();

  // Calendar back on: two tabs again, in their order.
  await openTabsSettings();
  await expect(modeSwitch('meeting')).toBeDisabled();
  await modeSwitch('calendar').click();
  await expect(modeSwitch('meeting')).toBeEnabled();
  await closeSettings();
  await expect(win.locator('.titlebar-modes [role="tab"]')).toHaveText(['Calendar', 'Meet']);
  await win.keyboard.press('Control+2');
  await expect(shell()).toHaveClass(/calendar-mode/);
});

// ---------- Calendar off ----------

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function ics({ method = 'REQUEST', uid, title, start, end }) {
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'VERSION:2.0',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `DTSTAMP:${stamp(Date.now())}`,
    'ORGANIZER;CN=Joris Bakker:mailto:joris@example.com',
    `UID:${uid}`,
    'ATTENDEE;CN=Joris Bakker;PARTSTAT=ACCEPTED:mailto:joris@example.com',
    'ATTENDEE;CN=Demo User;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:demo@example.com',
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    `SUMMARY:${title}`,
    'LOCATION:Room 4.12',
    'URL:https://meet.google.com/abc-defg-hij',
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ].join('\r\n');
}

async function invitation(subject, calendar) {
  const raw = await new MailComposer({
    from: 'Joris Bakker <joris@example.com>',
    to: 'demo@example.com',
    subject,
    date: new Date(),
    text: `${subject}\n\nJoris Bakker invited you.`,
    html: `<p>${subject}</p><p>Joris Bakker invited you.</p>`,
    icalEvent: { method: 'REQUEST', content: calendar }
  })
    .compile()
    .build();
  await app.evaluate(async (_, mail) => {
    const engine = global.__semEngine;
    await engine.session(engine.accounts[0]).append('INBOX', mail);
    await engine.syncAll();
  }, raw.toString());
}

test('with Calendar off an invitation shows as text, the composer has no calendar button, and an .ics file opens after Turn on', async ({}, testInfo) => {
  await start();
  const at = Date.now() + 3 * 86400000;
  await invitation('Invitation: Lunch talk', ics({ uid: 'lunch-talk-modes@example.com', title: 'Lunch talk', start: at, end: at + 3600000 }));
  await win.locator('.item', { hasText: 'Invitation: Lunch talk' }).first().click();
  const card = win.locator('.reader .invite');
  await expect(card.locator('[data-invite-answer="accepted"]')).toBeVisible();
  await expect(card.locator('[data-invite="add"]')).toBeVisible();
  // The composer of a reply has the calendar button while Calendar shows.
  await win.click('[data-reader="reply"]');
  const bar = win.locator('.composer [data-c="calendar"]');
  await expect(bar).toBeVisible();

  // Calendar off: in the window that is open, the card keeps what the invitation says and loses its calendar actions.
  await setHidden(['calendar']);
  await expect(bar).toBeHidden();
  await win.locator('.composer [data-c="discard"]').click();
  await expect(win.locator('.composer')).toHaveCount(0);
  await expect(card.locator('.invite-title')).toHaveText('Lunch talk');
  await expect(card.locator('.invite-row')).toContainText(['Room 4.12', '2 guests']);
  await expect(card.locator('[data-invite="join"]')).toBeVisible();
  await expect(card.locator('[data-invite-answer]')).toHaveCount(0);
  await expect(card.locator('[data-invite="add"], [data-invite="open"]')).toHaveCount(0);
  await expect(card.locator('.invite-note')).toHaveCount(0);
  await win.screenshot({ path: testInfo.outputPath('invite-calendar-off.png') });
  // A new reply has no calendar button either.
  await win.click('[data-reader="reply"]');
  await expect(win.locator('.composer [data-c="calendar"]')).toBeHidden();

  // Back on: the same open window gets the answers, Add to calendar and the button back.
  await setHidden([]);
  await expect(win.locator('.composer [data-c="calendar"]')).toBeVisible();
  await win.locator('.composer [data-c="discard"]').click();
  await expect(card.locator('[data-invite-answer="accepted"]')).toBeVisible();
  await expect(card.locator('[data-invite="add"]')).toBeVisible();
  await expect(card.locator('.invite-note')).toHaveText('Your answer goes to joris@example.com by email.');

  // An .ics file while Calendar is off: no card, and the notice's Turn on opens it at once.
  await setHidden(['calendar']);
  const file = path.join(dataDir, 'Concert.ics');
  fs.writeFileSync(file, ics({ method: 'PUBLISH', uid: 'concert-modes@example.com', title: 'Concert', start: at, end: at + 7200000 }));
  await app.evaluate(({ app }, [args, cwd]) => app.emit('second-instance', {}, args, cwd), [['Rukoo Mail.exe', '--', 'Concert.ics'], dataDir]);
  await expect(notice()).toContainText("Calendar is turned off, so Rukoo can't show this.");
  const dialog = win.locator('.scrim .dialog');
  await expect(dialog).toHaveCount(0);
  await notice().locator('button').click();
  await expect(dialog.locator('.invite-title')).toHaveText('Concert');
  await expect(dialog.locator('[data-invite="add"]')).toBeVisible();
  expect(await app.evaluate(() => global.__semEngine.settings.hiddenModes)).toEqual([]);
});

// A main-process call held until release(): calls that start meanwhile wait at the gate, so a test can change the
// setting while a window awaits one.
async function gate(target, method) {
  await app.evaluate(
    (_e, [target, method]) => {
      const obj = global[target];
      global.__gates ||= {};
      const real = obj[method];
      const g = { real, waiting: 0 };
      g.open = new Promise((resolve) => (g.release = resolve));
      obj[method] = async function (...args) {
        g.waiting += 1;
        await g.open;
        return real.apply(this, args);
      };
      global.__gates[method] = { g, obj };
    },
    [target, method]
  );
  return {
    waiting: () => app.evaluate((_e, method) => global.__gates[method].g.waiting, method),
    release: () =>
      app.evaluate((_e, method) => {
        const { g, obj } = global.__gates[method];
        obj[method] = g.real;
        g.release();
      }, method)
  };
}

test('Calendar going off reaches an open compose window at once and closes calendar controls that are open, writing nothing', async () => {
  test.setTimeout(120000);
  await start();
  const at = Date.now() + 3 * 86400000;
  await invitation('Invitation: Board review', ics({ uid: 'board-review-modes@example.com', title: 'Board review', start: at, end: at + 3600000 }));
  await win.locator('.item', { hasText: 'Invitation: Board review' }).first().click();
  const card = win.locator('.reader .invite');
  await expect(card.locator('[data-invite="add"]')).toBeVisible();
  // Every write an invitation's card can make, counted.
  await app.evaluate(() => {
    const inv = global.__semInvitations;
    global.__inviteWrites = 0;
    for (const name of ['add', 'answer']) {
      const real = inv[name].bind(inv);
      inv[name] = (...args) => {
        global.__inviteWrites += 1;
        return real(...args);
      };
    }
  });

  // A compose window with its free-times dialog open, and the invitation's calendar picker open in the main window.
  await win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }));
  await expect.poll(() => app.windows().length).toBe(2);
  const popped = app.windows().find((w) => w !== win);
  await popped.waitForSelector('.composer .editor');
  await popped.locator('.editor').click({ position: { x: 4, y: 4 } });
  await popped.keyboard.type('Hello');
  await popped.click('.composer [data-c="calendar"]');
  await popped.locator('.menu button', { hasText: 'Insert my free times…' }).click();
  const timesDialog = popped.locator('.scrim .dialog');
  await expect(timesDialog.locator('h2')).toHaveText('Insert free times');
  await card.locator('[data-invite="add"]').click();
  await expect(win.locator('.menu')).toBeVisible();

  // Calendar off in the main window: the compose window follows without being focused, and what was open closes.
  await setHidden(['calendar']);
  await expect(win.locator('.menu')).toHaveCount(0);
  await expect(popped.locator('.composer [data-c="calendar"]')).toBeHidden();
  await expect(timesDialog).toHaveCount(0);
  await expect(popped.locator('.editor')).not.toContainText("I'm free at these times");

  // An .ics file's dialog that is open when Calendar goes closes too.
  await setHidden([]);
  await expect(popped.locator('.composer [data-c="calendar"]')).toBeVisible();
  const file = path.join(dataDir, 'Offsite.ics');
  fs.writeFileSync(file, ics({ method: 'PUBLISH', uid: 'offsite-modes@example.com', title: 'Offsite', start: at, end: at + 7200000 }));
  await app.evaluate(({ app }, [args, cwd]) => app.emit('second-instance', {}, args, cwd), [['Rukoo Mail.exe', '--', 'Offsite.ics'], dataDir]);
  const fileDialog = win.locator('.scrim .dialog');
  await expect(fileDialog.locator('[data-invite="add"]')).toBeVisible();
  await setHidden(['calendar']);
  await expect(fileDialog).toHaveCount(0);

  // A click that was waiting on main when Calendar went: the calendar picker doesn't open after all.
  await setHidden([]);
  await expect(card.locator('[data-invite="add"]')).toBeVisible();
  const list = await gate('__semCalendars', 'loadCalendars');
  await card.locator('[data-invite="add"]').click();
  await expect.poll(() => list.waiting()).toBeGreaterThan(0);
  await setHidden(['calendar']);
  await list.release();
  await win.waitForTimeout(400);
  await expect(win.locator('.menu')).toHaveCount(0);

  // The same for the free-times dialog, which waits for the booking page's state before it opens.
  await setHidden([]);
  const bookingGate = await gate('__semBooking', 'load');
  await popped.click('.composer [data-c="calendar"]');
  await popped.locator('.menu button', { hasText: 'Insert my free times…' }).click();
  await expect.poll(() => bookingGate.waiting()).toBeGreaterThan(0);
  await setHidden(['calendar']);
  await bookingGate.release();
  await popped.waitForTimeout(400);
  await expect(popped.locator('.scrim')).toHaveCount(0);
  await expect(popped.locator('.editor')).not.toContainText("I'm free at these times");
  expect(await app.evaluate(() => global.__inviteWrites)).toBe(0);
});

test('an invitation card stops listening for tab changes when the reader moves on or its dialog closes', async () => {
  await start();
  const at = Date.now() + 4 * 86400000;
  await invitation('Invitation: Retro', ics({ uid: 'retro-modes@example.com', title: 'Retro', start: at, end: at + 3600000 }));
  // Each listener for tab changes the window adds, and whether its signal has let it go since.
  await win.evaluate(() => {
    const real = document.addEventListener;
    window.__modeListeners = [];
    document.addEventListener = function (type, fn, opts) {
      if (type === 'rukoo:modes-changed') window.__modeListeners.push(opts && opts.signal ? opts.signal : { aborted: false, never: true });
      return real.call(this, type, fn, opts);
    };
  });
  const live = () => win.evaluate(() => window.__modeListeners.filter((s) => !s.aborted).length);
  const invite = win.locator('.item', { hasText: 'Invitation: Retro' }).first();
  const other = win.locator('.item', { hasText: 'Call on Thursday' }).first();

  // The same invitation opened three times, with another email in between: one card listens, the one on screen.
  for (let i = 0; i < 3; i++) {
    await invite.click();
    await expect(win.locator('.reader .invite [data-invite="add"]')).toBeVisible();
    expect(await live()).toBe(1);
    await other.click();
    await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
    expect(await live()).toBe(0);
  }

  // An .ics file's dialog: its card and the dialog listen while it is open, and nothing once it is closed.
  const file = path.join(dataDir, 'Retro.ics');
  fs.writeFileSync(file, ics({ method: 'PUBLISH', uid: 'retro-file-modes@example.com', title: 'Retro file', start: at, end: at + 3600000 }));
  await app.evaluate(({ app }, [args, cwd]) => app.emit('second-instance', {}, args, cwd), [['Rukoo Mail.exe', '--', 'Retro.ics'], dataDir]);
  const dialog = win.locator('.scrim .dialog');
  await expect(dialog.locator('.invite-title')).toHaveText('Retro file');
  expect(await live()).toBe(2);
  await dialog.locator('.buttons button', { hasText: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await live()).toBe(0);
});

// ---------- emails being written while Mail is off ----------

// Clicks a control that closes its own window, such as Send in a compose window, and waits for the close.
async function clickClosing(page, selector) {
  const closed = page.waitForEvent('close');
  closed.catch(() => {});
  try {
    await page.click(selector);
  } catch (err) {
    if (!page.isClosed() && !/has been closed/.test(err.message)) throw err;
  }
  await closed;
}

const subjects = (view) =>
  app.evaluate(async (_e, view) => {
    const engine = global.__semEngine;
    const id = engine.accounts[0].id;
    await engine.syncAccount(id);
    return engine.listMessages({ scope: id, view }).map((m) => m.subject);
  }, view);

test('with Mail off an open compose window still saves and sends, and Undo send, a refusal and a restart open the email again', async () => {
  test.setTimeout(150000);
  await start({ undoSend: 30, language: 'en' }, { SEM_UNDO_SEND: '1' });
  await win.click('[data-action="compose"]');
  await expect(win.locator('.composer .editor')).toBeVisible();
  const [popped] = await Promise.all([app.waitForEvent('window'), win.locator('.composer [data-c="popout"]').click()]);
  await popped.waitForSelector('.composer .editor');

  // Mail goes while the compose window is open: the window stays, and works.
  await setHidden(['mail']);
  await expect(shell()).toHaveClass(/calendar-mode/);
  expect(popped.isClosed()).toBe(false);
  await popped.fill('[data-rinput="to"]', 'demo@example.com');
  await popped.press('[data-rinput="to"]', 'Enter');
  await popped.fill('[data-field="subject"]', 'Written while Mail is off');
  await popped.click('.editor');
  await popped.keyboard.type('Still on its way.');
  await popped.keyboard.press('Control+s');
  await expect(popped.locator('.composer')).toHaveAttribute('data-dirty', 'false');
  expect(await subjects('drafts')).toContain('Written while Mail is off');
  await clickClosing(popped, '[data-c="send"]');

  // The main window's notice offers Undo, which brings the email back in a compose window, Mail still off.
  await expect(notice()).toContainText('Sending email…');
  const [again] = await Promise.all([app.waitForEvent('window'), notice().locator('button').click()]);
  await again.waitForSelector('.composer .editor');
  await expect(again.locator('.editor')).toContainText('Still on its way.');
  await expect(shell()).toHaveClass(/calendar-mode/);
  await expect(win.locator('#app .reader .composer')).toHaveCount(0);
  await clickClosing(again, '[data-c="send"]');
  await app.evaluate(() => global.__semOutbox.flush());
  await expect(notice()).toContainText('Email sent');
  expect(await subjects('sent')).toContain('Written while Mail is off');

  // A refusal: the email opens again with the server's answer, in a compose window.
  await app.evaluate(() => {
    const engine = global.__semEngine;
    global.__send = engine.send;
    engine.send = async () => {
      throw new Error('Mailbox full');
    };
  });
  const c = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  expect(c).toBe(1);
  await win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }));
  await expect.poll(() => app.windows().length).toBe(2);
  const third = app.windows().find((w) => w !== win);
  await third.waitForSelector('.composer .editor');
  await third.fill('[data-rinput="to"]', 'someone@example.com');
  await third.press('[data-rinput="to"]', 'Enter');
  await third.fill('[data-field="subject"]', 'Refused while Mail is off');
  await clickClosing(third, '[data-c="send"]');
  const [refused] = await Promise.all([app.waitForEvent('window'), app.evaluate(() => global.__semOutbox.flush())]);
  await refused.waitForSelector('.composer .editor');
  await expect(refused.locator('[data-field="subject"]')).toHaveValue('Refused while Mail is off');
  await expect(refused.locator('body')).toContainText('Mailbox full');
  await expect(shell()).toHaveClass(/calendar-mode/);
  await refused.close();

  // Rukoo dies while an email waits: the next start opens it in a compose window, Mail still off.
  await app.evaluate(() => {
    global.__semEngine.send = () => new Promise(() => {});
  });
  await win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }));
  await expect.poll(() => app.windows().length).toBe(2);
  const fourth = app.windows().find((w) => w !== win);
  await fourth.waitForSelector('.composer .editor');
  await fourth.fill('[data-rinput="to"]', 'someone@example.com');
  await fourth.press('[data-rinput="to"]', 'Enter');
  await fourth.fill('[data-field="subject"]', 'Kept through a crash, Mail off');
  await clickClosing(fourth, '[data-c="send"]');
  await expect(notice()).toContainText('Sending email…');
  const exited = app.waitForEvent('close');
  kill(app.process());
  await exited;
  await launch({ SEM_UNDO_SEND: '1' });
  await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(2);
  const reopened = app.windows().find((w) => w !== win);
  await reopened.waitForSelector('.composer .editor');
  await expect(reopened.locator('[data-field="subject"]')).toHaveValue('Kept through a crash, Mail off');
  await expect(shell()).toHaveClass(/calendar-mode/, { timeout: 15000 });
  expect(await app.evaluate(() => global.__semEngine.settings.hiddenModes)).toEqual(['mail']);
});

// ---------- the chat panel and Mail off ----------

test('with Mail off an email source and a draft card in the chat panel say so, and Turn on opens what they are then', async ({}, testInfo) => {
  test.setTimeout(120000);
  await start({}, { SEM_AGENT_FAKE: '1', SEM_AGENT_FAKE_SCALE: '0.5' });
  const pane = win.locator('.agentpane');
  const transcript = pane.locator('.ap-transcript');
  const chip = (label) => pane.locator('.bui-sugg__chip', { hasText: label });
  await win.locator('.item', { hasText: 'Call on Thursday' }).first().click();
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await win.keyboard.press('Control+j');
  await expect(pane).toBeVisible();
  await chip('Brief me').click();
  // The email among the sources, by its mail badge.
  const source = transcript.locator('.bui-ctx__card').filter({ has: win.locator('.bui-ctx__badge--mail') }).first();
  await expect(source).toBeVisible({ timeout: 10000 });
  // The brief's last words: the turn is over, so the next message starts a turn of its own.
  await expect(transcript).toContainText('Decide that before the call.', { timeout: 10000 });
  const sourceTitle = (await source.locator('.bui-ctx__name').textContent()).trim();
  await expect.poll(() => app.evaluate(() => global.__semAgents.list().every((c) => c.status !== 'running')), { timeout: 10000 }).toBe(true);
  const selected = () => win.evaluate(async () => (await import('./app.js')).S.selectedId);
  const unreadOf = (subject) =>
    app.evaluate((_e, subject) => {
      const engine = global.__semEngine;
      const m = engine.listMessages({ scope: engine.accounts[0].id, view: 'everything' }).find((x) => x.subject === subject);
      return m ? m.unread : null;
    }, subject);

  // Mail goes while the source is being looked up: the notice, and the email stays unread.
  const sourceId = await app.evaluate((_e, subject) => {
    const engine = global.__semEngine;
    return engine.listMessages({ scope: engine.accounts[0].id, view: 'everything' }).find((x) => x.subject === subject).id;
  }, sourceTitle);
  await app.evaluate((_e, id) => global.__semEngine.setFlags(id, { unread: true }), sourceId);
  await expect.poll(() => unreadOf(sourceTitle)).toBe(true);
  const locating = await gate('__semAgents', 'locate');
  await source.locator('.bui-ctx__bar').click();
  await expect.poll(() => locating.waiting()).toBeGreaterThan(0);
  await setHidden(['mail']);
  await locating.release();
  await expect(notice()).toContainText("Mail is turned off, so Rukoo can't open this email.");
  await win.waitForTimeout(500);
  expect(await unreadOf(sourceTitle)).toBe(true);
  await setHidden([]);
  await expect(tab('mail')).toBeVisible();

  await win.locator('.agentpane .bui-pb__ta').fill('Draft a reply');
  await win.locator('.agentpane .bui-pb__ta').press('Enter');
  await expect(transcript.locator('.bui-draft')).toContainText('Wrote a reply', { timeout: 10000 });
  await expect(transcript).toContainText('Done. The draft is in the composer.', { timeout: 10000 });
  // Saved and closed: the card keeps the stored draft.
  const cid = await app.evaluate(() => [...global.__semAgents.conversations.values()].find((c) => c.items.some((i) => i.type === 'draft')).id);
  const draftOf = () => app.evaluate((_e, cid) => global.__semAgents.conversations.get(cid).items.find((i) => i.type === 'draft').draftId || null, cid);
  await win.locator('.composer .editor').click();
  await win.keyboard.press('Control+s');
  await expect(win.locator('.composer .save-state')).toHaveText('Draft saved');
  await win.keyboard.press('Escape');
  await expect(win.locator('.composer')).toHaveCount(0);
  await expect.poll(draftOf).not.toBeNull();
  const first = await draftOf();

  const before = await selected();
  const unread = await unreadOf(sourceTitle);

  await setHidden(['mail']);
  await expect(shell()).toHaveClass(/calendar-mode/);
  await expect(pane).toBeVisible();

  // The source: a notice, and the reading pane behind the calendar stays where it was.
  await source.locator('.bui-ctx__bar').click();
  await expect(notice()).toContainText("Mail is turned off, so Rukoo can't open this email.");
  await expect(notice().locator('button')).toHaveText('Turn on');
  await win.screenshot({ path: testInfo.outputPath('agent-source-mail-off.png') });
  await win.waitForTimeout(300);
  expect(await selected()).toBe(before);
  expect(await unreadOf(sourceTitle)).toBe(unread);

  // The draft card's Show: the same notice. While it is up the draft is saved again in a compose window, which gives
  // the card a newer draft; Turn on shows that one.
  await transcript.locator('.bui-draft').getByRole('button', { name: 'Show' }).click();
  await expect(notice()).toContainText("Mail is turned off, so Rukoo can't open this email.");
  await notice().hover();
  await win.evaluate((id) => window.mail.call('openCompose', { mode: 'draft', id }), first);
  await expect.poll(() => app.windows().length).toBe(2);
  const popped = app.windows().find((w) => w !== win);
  await popped.waitForSelector('.composer .editor');
  await popped.click('.composer .editor');
  await popped.keyboard.press('Control+End');
  await popped.keyboard.type(' See you then.');
  await popped.keyboard.press('Control+s');
  await expect.poll(draftOf).not.toBe(first);
  await popped.close();
  await expect(notice()).toContainText("Mail is turned off, so Rukoo can't open this email.");
  await notice().locator('button').click();
  await expect(tab('mail')).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('.composer .editor')).toContainText('See you then.');
  await expect(win.locator('.composer .editor')).toContainText('Thursday at 10:00 works for me.');
  expect(await app.evaluate(() => global.__semEngine.settings.hiddenModes)).toEqual([]);
});

// ---------- the sorting panel, new mail and Mail off ----------

test('with Mail off an email from the sorting panel opens after Turn on as the email it was, and says so when it is gone', async () => {
  test.setTimeout(120000);
  await start();
  const engineInbox = () =>
    app.evaluate(() => {
      const engine = global.__semEngine;
      return engine.listMessages({ scope: engine.accounts[0].id, view: 'inbox' }).map((m) => ({ id: m.id, uid: m.uid, subject: m.subject, unread: m.unread }));
    });
  const [target, other] = (await engineInbox()).filter((m) => m.unread);
  const selected = () => win.evaluate(async () => (await import('./app.js')).S.selectedId);
  // Jev's last decision as the sorting panel shows it (sort-activity.js), and a click on it.
  const sortedClick = async (m) => {
    await win.evaluate(async (m) => {
      const sa = await import('./sort-activity.js');
      sa.setCategories({ enabled: true, categories: [] });
      sa.setActivity({ recent: [{ id: m.id, subject: m.subject, from: 'Jev', category: 'none', chose: 'none', confidence: 0.9, sure: true, at: Date.now() }] });
      if (!sa.sortPanelOpen()) sa.toggleSortPanel();
    }, m);
    await win.locator('.sort-panel .sa-item').first().evaluate((b) => b.click());
  };
  const unreadOf = async (subject) => (await engineInbox()).find((m) => m.subject === subject)?.unread;
  const before = await selected();

  // Mail goes while the inbox loads for the email: nothing opens, it stays unread, and the notice offers it.
  const state = await gate('__semApi', 'state');
  await sortedClick(target);
  await expect.poll(() => state.waiting()).toBeGreaterThan(0);
  await win.evaluate(() => window.mail.call('updateSettings', { hiddenModes: ['mail'] }));
  await state.release();
  await expect(notice()).toContainText("Mail is turned off, so Rukoo can't open this email.");
  await expect(tab('mail')).toHaveCount(0);
  expect(await selected()).toBe(before);
  expect(await unreadOf(target.subject)).toBe(true);

  // While the notice is up the server gives the inbox's uids out again: the email's old id now names another one.
  await notice().hover();
  await app.evaluate(async (_e, [a, b]) => {
    const engine = global.__semEngine;
    const demo = engine.session(engine.accounts[0]);
    const box = demo.box('INBOX');
    const x = box.messages.find((m) => m.uid === a);
    const y = box.messages.find((m) => m.uid === b);
    [x.uid, y.uid] = [y.uid, x.uid];
    box.uidValidity = '2';
    demo.persist();
    await engine.syncAll();
  }, [target.uid, other.uid]);
  expect(await app.evaluate((_e, id) => global.__semEngine.locate(id).msg.subject, target.id)).toBe(other.subject);
  // Turn on opens the email that was clicked, under its new id.
  await notice().locator('button').click();
  await expect(tab('mail')).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('.reader-subject')).toHaveText(target.subject);

  // Clicked while Mail is off, then deleted before Turn on: the notice says it is gone, and nothing opens.
  const now = (await engineInbox()).find((m) => m.subject === other.subject);
  await setHidden(['mail']);
  const shown = await selected();
  await sortedClick(now);
  await expect(notice()).toContainText("Mail is turned off, so Rukoo can't open this email.");
  await notice().hover();
  await app.evaluate(async (_e, uid) => {
    const engine = global.__semEngine;
    const demo = engine.session(engine.accounts[0]);
    const box = demo.box('INBOX');
    box.messages = box.messages.filter((m) => m.uid !== uid);
    demo.persist();
    await engine.syncAll();
  }, now.uid);
  await notice().locator('button').click();
  await expect(notice()).toContainText('That email is no longer in Rukoo, so there is nothing to open.');
  expect(await selected()).toBe(shown);
});

test('new mail that is being shown when Mail is turned off leaves no notice', async () => {
  await start();
  // In Calendar the list isn't on screen, so new mail would get a toast.
  await win.keyboard.press('Control+2');
  await expect(shell()).toHaveClass(/calendar-mode/);
  const [m] = await app.evaluate(() => {
    const engine = global.__semEngine;
    return engine.listMessages({ scope: engine.accounts[0].id, view: 'inbox' }).map((x) => ({ id: x.id }));
  });
  const deliver = () =>
    app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows()[0].webContents.send('mail:event', { type: 'new-mail', payload: { mails: [{ id, from: 'Sanne de Vries', subject: 'Late news', category: null }], toast: true, sound: false } });
    }, m.id);
  // With Mail on, the window says so.
  await deliver();
  await expect(notice()).toContainText('New email from Sanne de Vries: Late news');
  await win.evaluate(() => window.mail.call('toastMain', 'Cleared'));
  await expect(notice()).toContainText('Cleared');

  // Mail goes while the window loads the new mail: no notice.
  const state = await gate('__semApi', 'state');
  await deliver();
  await expect.poll(() => state.waiting()).toBeGreaterThan(0);
  await win.evaluate(() => window.mail.call('updateSettings', { hiddenModes: ['mail'] }));
  await state.release();
  await expect(tab('mail')).toHaveCount(0);
  await win.waitForTimeout(600);
  await expect(notice()).not.toContainText('Sanne de Vries');
});
