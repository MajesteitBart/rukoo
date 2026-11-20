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

// The page's width in CSS pixels follows the window's content width at the zoom. That width comes from the window: once
// a frameless window has been shown, Windows makes it 16 px wider than launch() asked for.
async function setZoom(percent) {
  await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), percent / 100);
  const content = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds().width);
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(Math.round((content * 100) / percent));
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
  // With the modes in the title bar the rail holds this list at 200 percent in the usual window. A window 620 px high
  // is short enough that the rail still runs out of height.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 620));
  await expect.poll(() => win.evaluate(() => window.innerHeight)).toBeLessThan(640);
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

// The fullest title bar in the smallest one: four mode tabs and a screen recording's indicator at 200 percent in a
// 760x560 window. Nothing runs off the bar, and the actions end at least 12px before the window buttons.
test('four mode tabs and a recording at 200 percent in the smallest window keep the title bar clear of the window buttons', async () => {
  test.skip(process.platform === 'darwin', 'macOS has traffic lights, without a window controls overlay');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, await server.seedAccount({ password: PASSWORD }));
  await expect(win.locator('.titlebar-modes [data-mode]')).toHaveCount(4, { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560));
  await win.evaluate(() => window.mail.call('setZoom', 200));
  await expect.poll(() => win.evaluate(() => innerWidth)).toBeLessThan(400);
  // What a recording with the screen hidden from it shows: the dot, the clock and the eye.
  await win.evaluate(() => {
    const b = document.querySelector('[data-meeting-indicator]');
    b.hidden = false;
    b.classList.add('is-hidden');
    b.querySelector('.rec-time').textContent = '1:23:45';
  });
  const fit = () =>
    win.evaluate(() => {
      const bar = document.querySelector('.titlebar');
      const area = navigator.windowControlsOverlay.getTitlebarAreaRect();
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const [tabs, search, actions] = [box('.mode-tabs'), box('.titlebar-search'), box('.titlebar-actions')];
      return {
        overflow: bar.scrollWidth - bar.clientWidth,
        clear: Math.round(area.x + area.width - actions.right),
        apart: tabs.right <= search.left + 0.5 && search.right <= actions.left + 0.5
      };
    });
  await expect.poll(fit).toEqual({ overflow: 0, clear: 12, apart: true });
  await expect(win.locator('.titlebar-actions .rec-dot')).toBeVisible();
  // The search is narrower than its input here; a press on what shows of it still puts the cursor in it.
  await win.locator('.titlebar-search').click({ position: { x: 4, y: 15 } });
  await expect(win.locator('#search')).toBeFocused();
  await win.evaluate(() => window.mail.call('setZoom', 100));
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
