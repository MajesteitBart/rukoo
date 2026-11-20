// Team chat at 200 percent zoom: the sidebar rail and a long dialog. In the rail the list keeps about three rows and
// the whole column scrolls; the open conversation's row comes into view when it opens; a chat dialog whose body scrolls
// shows a hairline above its buttons and a fade while more sits below. At 100 percent none of that changes the
// layout. The real app on a throwaway profile against the real account server, zoomed with webContents.
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { PASSWORD, skipWithoutServer, startServer, launch, signIn, openChat, roomRow, dialogBox, workspaceMenu } = require('./chat-helpers');

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
  dataDir = tempDir('rukoo-chat-zoom-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

async function setZoom(percent) {
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), percent / 100);
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(percent === 200 ? 700 : 1400);
}

// Acme with general, six more channels and two DMs for Bart, an admin, and a person he blocked: enough rows that the
// last DM sits below the rail's fold, and a Workspace settings long enough to scroll at 200 percent.
async function seed() {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const mila = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const milaMe = await server.seedMember(ws, mila, 'Mila');
  await server.call('PATCH', `/v1/workspaces/${ws.id}/members/${bartMe.id}`, { token: olga.token, body: { role: 'admin' } });
  for (const name of ['design', 'events', 'finance', 'roadmap', 'sales', 'support']) await server.seedChannel(olga, ws.id, { name, members: [bartMe.id] });
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await server.post(olga, ws.id, dm.conversation, 'Ten minutes for the roadmap later?');
  const group = await server.seedDm(mila, ws.id, [bartMe.id]);
  await server.post(mila, ws.id, group.conversation, 'Lunch on Thursday?');
  await server.block(bart, ws.id, milaMe.id);
  return { olga, bart, ws, dm, group };
}

async function ready(s) {
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, s.bart);
  await openChat(win);
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });
  await expect(win.locator(`.sidebar [data-ch-open="${s.group.conversation}"]`)).toHaveCount(1, { timeout: 15000 });
}

// The sidebar's sizes, and whether a row shows inside both the list and the sidebar column.
const railState = (id) =>
  win.evaluate((rowId) => {
    const side = document.querySelector('.sidebar');
    const nav = side.querySelector('.ch-nav');
    const row = side.querySelector(`[data-ch-open="${rowId}"]`);
    const s = side.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    const r = row ? row.getBoundingClientRect() : null;
    return {
      collapsed: document.querySelector('.shell').classList.contains('collapsed'),
      sideOver: side.scrollHeight - side.clientHeight,
      navHeight: n.height,
      navTop: nav.scrollTop,
      rowShows: Boolean(r) && r.top >= Math.max(s.top, n.top) - 1 && r.bottom <= Math.min(s.bottom, n.bottom) + 1
    };
  }, id);

test('the rail at 200 percent keeps three rows, scrolls as a column and shows the row that opens', async () => {
  const s = await seed();
  await ready(s);
  await win.locator('.sidebar [data-ch-open]').first().click();

  // 100 percent: the full sidebar fits as before, nothing scrolls.
  const wide = await railState(s.ws.general);
  expect(wide.collapsed).toBe(false);
  expect(wide.sideOver).toBeLessThanOrEqual(0);

  await setZoom(200);
  await expect(win.locator('.shell')).toHaveClass(/collapsed/);
  let rail = await railState(s.ws.general);
  expect(rail.navHeight, 'about three rows of list').toBeGreaterThanOrEqual(119);
  expect(rail.sideOver, 'the column scrolls').toBeGreaterThan(0);

  // Alt+ArrowUp from the first row wraps to the last DM, below the fold; its row comes into view.
  await win.evaluate(() => {
    document.querySelector('.sidebar').scrollTop = 0;
    document.querySelector('.sidebar .ch-nav').scrollTop = 0;
  });
  const last = await win.evaluate(() => [...document.querySelectorAll('.sidebar [data-ch-open]')].pop().dataset.chOpen);
  for (let i = 0; i < 12; i++) {
    const open = await win.evaluate(() => document.querySelector('.sidebar [data-ch-open][aria-current="page"]')?.dataset.chOpen);
    if (open === last) break;
    await win.keyboard.press('Alt+ArrowUp');
    await win.waitForTimeout(150);
  }
  await expect(win.locator(`.sidebar [data-ch-open="${last}"]`)).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => (await railState(last)).rowShows, { message: 'the open row in view' }).toBe(true);

  // A message elsewhere redraws the sidebar; the list keeps its place.
  rail = await railState(last);
  expect(rail.navTop).toBeGreaterThan(0);
  await server.post(s.olga, s.ws.id, s.ws.general, 'Anyone around?');
  await expect(win.locator(`.sidebar [data-ch-open="${s.ws.general}"]`)).toHaveClass(/is-unread/, { timeout: 15000 });
  const after = await railState(last);
  expect(after.navTop).toBe(rail.navTop);
  expect(after.rowShows).toBe(true);

  // Back at 100 percent nothing scrolls.
  await setZoom(100);
  await expect.poll(async () => (await railState(last)).sideOver).toBeLessThanOrEqual(0);
});

test('a chat dialog that scrolls at 200 percent shows a hairline and a fade until its end', async () => {
  const s = await seed();
  await ready(s);
  const dialog = dialogBox(win);
  const look = () =>
    dialog.evaluate((d) => ({
      scrollable: d.classList.contains('is-scrollable'),
      more: d.classList.contains('has-more'),
      line: getComputedStyle(d.querySelector('.buttons')).borderTopWidth,
      mask: getComputedStyle(d.querySelector('.dialog-body')).maskImage
    }));

  // 100 percent: Workspace settings fits, no line, no fade.
  await workspaceMenu(win, 'Workspace settings');
  await expect(dialog.locator('h2')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Unblock' })).toHaveCount(1);
  await expect.poll(look).toEqual({ scrollable: false, more: false, line: '0px', mask: 'none' });
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim')).toHaveCount(0);

  await setZoom(200);
  await workspaceMenu(win, 'Workspace settings');
  await expect(dialog.locator('h2')).toBeVisible();
  await expect.poll(look).toMatchObject({ scrollable: true, more: true, line: '1px' });
  expect((await look()).mask).toContain('linear-gradient');

  // At the end of the body the fade goes and the line stays; scrolling back brings the fade back.
  const body = dialog.locator('.dialog-body');
  await body.evaluate((b) => (b.scrollTop = b.scrollHeight));
  await expect.poll(look).toEqual({ scrollable: true, more: false, line: '1px', mask: 'none' });
  await body.evaluate((b) => (b.scrollTop = 0));
  await expect.poll(look).toMatchObject({ scrollable: true, more: true });

  // Back at 100 percent with the dialog open, the body fits again and both go.
  await setZoom(100);
  await expect.poll(look).toEqual({ scrollable: false, more: false, line: '0px', mask: 'none' });
});
