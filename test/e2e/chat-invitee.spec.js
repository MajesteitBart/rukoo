// A colleague with an invitation link and a fresh install (RUK-234): the first-run page offers team chat beside mail,
// the link and a Rukoo account are enough to end in the workspace with Chat open, the join waits across a restart, and
// Chat names Rukoo's other apps once. The real app on a throwaway profile against the real account server, without a
// mail account; Olga, who invites, is acted for over HTTP.
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { PASSWORD, skipWithoutServer, startServer, emulateFocus, roomRow, dialogBox, serverGet } = require('./chat-helpers');

skipWithoutServer();

let server;
let app;
let win;
let dataDir;

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(() => {
  dataDir = tempDir('rukoo-invitee-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

// Rukoo on dataDir against the server, without picking a mail account: the setup page on a new profile, Chat after a
// restart with a Rukoo account.
async function start() {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_CHAT_FAST: '1', RUKOO_ACCOUNT_SERVER: server.url };
  delete env.ELECTRON_RUN_AS_NODE;
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await emulateFocus(win);
  await win.waitForFunction(() => document.querySelector('.provider-grid, .item, section.chat .ch-empty, section.chat .ch-main'), null, { timeout: 30000 });
}

async function restart() {
  await closeApp(app);
  app = null;
  await start();
}

const setup = () => win.locator('.page.setup');
const chatTab = () => win.locator('.titlebar-modes [data-mode="chat"]');
const switcherName = () => win.locator('.sidebar .ch-ws-switch .name');

test('a fresh install joins with the link, a new Rukoo account and no mail account, and ends in the workspace', async () => {
  const olga = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const { link } = await server.createInvite(olga, ws.id, { role: 'member' });
  await start();

  // The first-run page asks the server at start, so team chat shows beside mail before anyone signs in.
  const offer = setup().locator('[data-setup-chat]');
  await expect(offer).toBeVisible({ timeout: 15000 });
  await expect(offer.locator('h2')).toHaveText('Team chat');
  await expect(offer).toContainText('Team chat works without a mail account.');
  await offer.locator('[data-s="chat-link"]').click();

  // Step 1: the link, checked on this computer before an account exists. Another server's is refused with its name.
  const linkForm = setup().locator('form[data-form="chat-link"]');
  await linkForm.locator('[name="link"]').fill(link.replace(/^http:\/\/127\.0\.0\.1:\d+/, 'https://chat.example.net'));
  await linkForm.locator('button[type=submit]').click();
  await expect(linkForm.locator('[data-error]')).toContainText('chat.example.net');
  await linkForm.locator('[name="link"]').fill(`Join us: ${link}.`);
  await linkForm.locator('button[type=submit]').click();

  // Step 2: a Rukoo account. The server takes the invitation as invite code, so the form asks for none.
  const form = setup().locator('form[data-form="chat-signup"]');
  await expect(setup().locator('.login-head h2')).toHaveText('Create a Rukoo account');
  await expect(form).toContainText('Rukoo opens the workspace your link invites you to');
  await expect(form.locator('[name="invite"]')).toHaveCount(0);
  await form.locator('[name="email"]').fill(`invitee-${Date.now()}@example.com`);
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('[name="repeat"]').fill(PASSWORD);
  await form.locator('button[type=submit]').click();
  await expect(form.locator('[data-error]')).not.toBeEmpty();
  await form.locator('[name="understand"]').check();
  await form.locator('button[type=submit]').click();
  const key = dialogBox(win);
  await expect(key.locator('h2')).toHaveText('Save your recovery key', { timeout: 20000 });
  await key.locator('.buttons button').last().click();

  // The setup page makes way for Chat, which opens the Join dialog with the link and its card.
  await expect(setup()).toHaveCount(0, { timeout: 15000 });
  await expect(chatTab()).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Join a workspace', { timeout: 15000 });
  await expect(dialog.locator('[name="link"]')).toHaveValue(link);
  await expect(dialog.locator('[data-preview] .ch-join-ws')).toHaveText('Acme', { timeout: 15000 });
  await dialog.locator('[name="name"]').fill('Invitee');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });
  await expect(roomRow(win, 'general')).toHaveAttribute('aria-current', 'page', { timeout: 15000 });
  const { members } = await serverGet(server, olga, ws.id, '/members');
  expect(members.some((m) => m.name === 'Invitee' && m.state === 'active')).toBe(true);
  expect(await win.evaluate(() => window.mail.call('chatState').then((s) => s.pendingJoin))).toBe(false);

  // After the first workspace, Chat names the other apps once.
  const apps = win.locator('.sidebar .ch-apps');
  await expect(apps).toBeVisible();
  await expect(apps.locator('.ch-apps-name')).toHaveText(['Rukoo for Android', 'Rukoo Voice']);
  await expect(apps.locator('[data-ch-side="apps-android"]')).toHaveAttribute('title', 'https://rukoo.io/download/android');

  // Mail needs a mail account: its tab opens the setup page, and Back returns to Chat.
  await win.locator('.titlebar-modes [data-mode="mail"]').click();
  await expect(setup().locator('.provider-grid')).toBeVisible();
  await expect(setup().locator('[data-setup-chat]')).toBeHidden();
  await setup().locator('[data-s="close"]').click();
  await expect(setup()).toHaveCount(0);
  await expect(chatTab()).toHaveAttribute('aria-selected', 'true');

  // Hidden, the card stays hidden after a restart, which opens straight in Chat.
  await apps.locator('[data-ch-side="apps-hide"]').click();
  await expect(apps).toHaveCount(0);
  await restart();
  await expect(setup()).toHaveCount(0);
  await expect(chatTab()).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });
  await expect(win.locator('.sidebar .ch-apps')).toHaveCount(0);
  await expect(win.locator('.scrim')).toHaveCount(0);
});

test('a sign-in with the link keeps the join across a restart until it is joined', async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const { link } = await server.createInvite(olga, ws.id, { role: 'member' });
  await start();
  await setup().locator('[data-setup-chat] [data-s="chat-link"]').click();
  await setup().locator('form[data-form="chat-link"] [name="link"]').fill(link);
  await setup().locator('form[data-form="chat-link"] button[type=submit]').click();
  await setup().locator('[data-s="chat-to-signin"]').click();
  const form = setup().locator('form[data-form="chat-signin"]');
  await expect(setup().locator('.login-head h2')).toHaveText('Sign in to Rukoo');
  await form.locator('[name="email"]').fill(bart.email);
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('button[type=submit]').click();
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Join a workspace', { timeout: 20000 });
  await expect(dialog.locator('[data-preview] .ch-join-ws')).toHaveText('Acme', { timeout: 15000 });

  // Rukoo closes with the dialog open: the next start offers the same link again, in Chat.
  await restart();
  await expect(chatTab()).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  const again = dialogBox(win);
  await expect(again.locator('h2')).toHaveText('Join a workspace', { timeout: 15000 });
  await expect(again.locator('[name="link"]')).toHaveValue(link);
  await expect(again.locator('[data-preview] .ch-join-ws')).toHaveText('Acme', { timeout: 15000 });
  await again.locator('[name="name"]').fill('Bart');
  await again.locator('.buttons button').last().click();
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });

  // Joined: a restart has nothing left to offer.
  await restart();
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });
  await win.waitForTimeout(1000);
  await expect(win.locator('.scrim')).toHaveCount(0);
});

test('signed out with a mail account, Chat is there at start and its Join button takes the same steps', async () => {
  const olga = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const { link } = await server.createInvite(olga, ws.id, { role: 'member' });
  await start();
  await setup().locator('[data-s="demo"]').click();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  // No Settings visit first: the server's info came at start.
  await expect(chatTab()).toBeVisible({ timeout: 15000 });
  await chatTab().click();
  const pane = win.locator('section.chat');
  await expect(pane.locator('.ch-empty-title')).toHaveText('Sign in to use team chat');
  await pane.locator('[data-ch-empty="join"]').click();
  await expect(setup().locator('form[data-form="chat-link"]')).toBeVisible();
  // Back from its first step closes the page.
  await setup().locator('[data-s="chat-back"]').click();
  await expect(setup()).toHaveCount(0);
  await pane.locator('[data-ch-empty="join"]').click();
  await setup().locator('form[data-form="chat-link"] [name="link"]').fill(link);
  await setup().locator('form[data-form="chat-link"] button[type=submit]').click();
  await expect(setup().locator('form[data-form="chat-signup"]')).toBeVisible();
  // Back goes to the link, which is still there.
  await setup().locator('[data-s="chat-back"]').click();
  await expect(setup().locator('form[data-form="chat-link"] [name="link"]')).toHaveValue(link);
  await win.keyboard.press('Escape');
  await expect(setup()).toHaveCount(0);
});

test('with a mail account, a sign-up with a link that Rukoo quits during opens Chat and Join at the next start', async () => {
  const olga = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const { link } = await server.createInvite(olga, ws.id, { role: 'member' });
  await start();
  await setup().locator('[data-s="demo"]').click();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  // Signing up in Settings with the link in the invite field; Rukoo quits while the recovery key shows.
  await win.click('[data-action="settings"]');
  const page = win.locator('.page.settings');
  await page.locator('[data-a="rukoo"]').click();
  await page.locator('[data-a="rukoo-go:rukoo-signup"]').click();
  const form = page.locator('form[data-form="rukoo-signup"]');
  await form.locator('[name="email"]').fill(`quits-${Date.now()}@example.com`);
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('[name="repeat"]').fill(PASSWORD);
  await form.locator('[name="invite"]').fill(link);
  await form.locator('[name="understand"]').check();
  await form.locator('button[type=submit]').click();
  await expect(dialogBox(win).locator('h2')).toHaveText('Save your recovery key', { timeout: 20000 });
  await restart();

  // The window was in Mail; the pending join brings Chat and its Join dialog.
  await expect(chatTab()).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Join a workspace', { timeout: 15000 });
  await expect(dialog.locator('[name="link"]')).toHaveValue(link);
  // Cancel lets it go: the next start stays where it is.
  await dialog.locator('.buttons button').first().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  await expect.poll(() => win.evaluate(() => window.mail.call('chatState').then((s) => s.pendingJoin))).toBe(false);
  await win.locator('.titlebar-modes [data-mode="mail"]').click();
  await restart();
  await expect(win.locator('.titlebar-modes [data-mode="mail"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  await win.waitForTimeout(1500);
  await expect(win.locator('.scrim')).toHaveCount(0);
});
