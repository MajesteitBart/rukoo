'use strict';

// What every team chat spec needs (contract 8.5): the real account server (test/fixtures/real-server.js) with team
// chat on, the app launched on a throwaway profile against it, a person signed in, and the second person acted for
// over HTTP. Nothing here answers a workspace route.
//
//   test.beforeAll(async () => { server = await startServer(); });
//   ({ app, win } = await launch(server, { dataDir }));
//   const { olga, bart, ws } = await twoPeople(server);
//   await signIn(win, bart);
//   await openChat(win);
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');
const { startRealServer, realServerAvailable } = require('../fixtures/real-server');

const PASSWORD = 'a long enough password';
const UNAVAILABLE = 'run npm ci in server/ to test chat against the real server';

// Outside CI the chat specs skip when server/node_modules is missing; in CI (or with RUKOO_REQUIRE_REAL_SERVER=1)
// they fail instead, so a forgotten install can't pass them by skipping.
function skipWithoutServer() {
  const required = Boolean(process.env.CI) || process.env.RUKOO_REQUIRE_REAL_SERVER === '1';
  test.skip(!realServerAvailable() && !required, UNAVAILABLE);
}

async function startServer(options = {}) {
  return startRealServer(options);
}

// The page behaves as in a focused window: a test window is shown inactive off screen, and team chat reports reads
// only while the window has focus (contract 3.9).
async function emulateFocus(win) {
  try {
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return true;
  } catch (_) {
    return false;
  }
}

// Rukoo on dataDir against server: SEM_HIDDEN, SEM_CHAT_FAST, the account server, a 1400x950 window and the demo mail
// account (picked on a new profile, already there on a restart). focus: false leaves the window without focus, so
// nothing counts as read. env: more environment variables.
async function launch(server, { dataDir, env: extra = {}, focus = true, size = [1400, 950] } = {}) {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_CHAT_FAST: '1', RUKOO_ACCOUNT_SERVER: server.url, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  // The session is stored with safeStorage, which needs the real keyring on Linux (see the IMAP tests).
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  const app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size);
  if (focus) await emulateFocus(win);
  // A new profile shows the account picker; a restart shows the mailbox, or Chat when that was the mode.
  await win.waitForFunction(() => document.querySelector('.provider-grid, .item'), null, { timeout: 30000 });
  if (await win.locator('.provider-grid').count()) {
    await win.click('[data-s="demo"]');
    await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  }
  return { app, win };
}

// Signs the app in as person (seeded with a password) through main, as Settings would.
async function signIn(win, person) {
  await win.evaluate((p) => window.mail.call('accountSignIn', p), { email: person.email, password: person.password });
  await expect.poll(() => win.evaluate(() => window.mail.call('accountStatus').then((s) => Boolean(s.signedIn))), { timeout: 15000 }).toBe(true);
}

// Chat mode, once the server's info says it has team chat.
async function openChat(win) {
  const seg = win.locator('.sidebar-mode [data-mode="chat"]');
  await expect(seg).toBeVisible({ timeout: 15000 });
  await seg.click();
  await expect(seg).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('section.chat')).toBeVisible();
}

// Olga (random keys, the owner) and Bart (a password, so the app can sign in), in a workspace with Bart as a member of
// general.
async function twoPeople(server, { workspace = 'Acme' } = {}) {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: workspace, displayName: 'Olga Owner' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  return { olga, bart, ws, bartMe };
}

// Main's view of team chat (contract 4.8), without message text or tokens.
async function debugState(app) {
  return app.evaluate(() => (global.__semChat ? global.__semChat.debugState() : null));
}

// The chat notifications main recorded instead of showing them.
async function notices(app) {
  return app.evaluate(() => (global.__semNotices || []).filter((n) => n && n.chat));
}

// The person's read position in a conversation as the server has it, from their own feed.
async function serverRead(server, person, wsId, conversation) {
  let cursor = null;
  let read = null;
  for (;;) {
    const route = `/v1/workspaces/${wsId}/changes${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`;
    const page = await server.call('GET', route, { token: person.token });
    if (page.status !== 200) throw new Error(`feed: ${page.status} ${page.text}`);
    const room = page.body.changes.find((c) => c.conversation === conversation);
    if (room) read = room.read;
    cursor = page.body.next;
    if (!page.body.more) break;
  }
  return read;
}

// The sidebar row of a conversation by its name.
const roomRow = (win, name) => win.locator(`.sidebar .ch-row[title="${name}"]`);

module.exports = { PASSWORD, skipWithoutServer, startServer, launch, emulateFocus, signIn, openChat, twoPeople, debugState, notices, serverRead, roomRow };
