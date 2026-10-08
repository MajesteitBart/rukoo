// End-to-end tests for zoom: the keys and Ctrl+mouse wheel in the main window and the compose windows,
// the Settings row, and the level after a restart. Launches the real app with a throwaway profile.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

let app;
let win;
let dataDir;

async function launch() {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
}

async function quit() {
  // An editor with unsaved changes keeps its window open and asks first; skip that in tests.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app.close();
}

test.beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-e2e-'));
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await quit();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Zoom per window in percent, keyed by page: { 'index.html': [100], 'compose.html': [100, 100] }.
const zoom = () =>
  app.evaluate(({ BrowserWindow }) => {
    const out = {};
    for (const w of BrowserWindow.getAllWindows()) {
      const page = w.webContents.getURL().split('/').pop();
      (out[page] = out[page] || []).push(Math.round(w.webContents.getZoomFactor() * 100));
    }
    return out;
  });
const mainZoom = async () => (await zoom())['index.html'][0];
const savedZoom = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'settings.json'), 'utf8')).zoomLevel;

// Playwright's keyboard goes through DevTools and skips before-input-event. sendInputEvent takes the route of a
// real key press: main's before-input-event first, then the focused element, the email's frame included.
// keyCode uses Electron's accelerator names: '=', 'Plus' (Shift+=), 'numadd', '-', 'numsub', '0', 'num0'.
const press = (page, keyCode, modifiers = ['control']) =>
  app.evaluate(
    ({ BrowserWindow }, [page, keyCode, modifiers]) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith(page));
      for (const type of ['keyDown', 'keyUp']) w.webContents.sendInputEvent({ type, keyCode, modifiers });
    },
    [page, keyCode, modifiers]
  );

// One notch of the mouse wheel with Ctrl held, at a point of the page. sendInputEvent adds a phase-end event
// that counts as a second notch, so the tests check the direction rather than the number of steps.
const wheel = async (page, locator, direction) => {
  const box = await locator.boundingBox();
  await app.evaluate(
    ({ BrowserWindow }, [page, x, y, ticks]) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith(page));
      w.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaY: ticks * 120, wheelTicksY: ticks, modifiers: ['control'], canScroll: true });
    },
    [page, Math.round(box.x + box.width / 2), Math.round(box.y + Math.min(box.height / 2, 40)), direction === 'in' ? 1 : -1]
  );
};

// Keydown events that reach the page, in the main document and in the email's frame.
async function recordKeys() {
  await win.evaluate(() => {
    window.__keys = [];
    document.addEventListener('keydown', (e) => window.__keys.push(e.key), true);
    const frame = document.querySelector('.mail-frame');
    if (frame) frame.contentDocument.addEventListener('keydown', (e) => window.__keys.push(`frame:${e.key}`), true);
  });
}
const keys = () => win.evaluate(() => window.__keys);

test('Ctrl+Plus, Ctrl+Minus and Ctrl+0 zoom with the focus in the list, the reading pane, the email and the editor', async () => {
  expect(await mainZoom()).toBe(100);
  await win.locator('.item').first().click();
  await expect(win.frameLocator('.mail-frame').locator('body')).toContainText('Traffic fines');
  await recordKeys();

  // The message list.
  await expect.poll(() => win.evaluate(() => document.activeElement.className)).toBe('list-scroll');
  await press('index.html', '=');
  await expect.poll(mainZoom).toBe(110);
  await press('index.html', 'Plus');
  await expect.poll(mainZoom).toBe(125);
  await press('index.html', 'numadd');
  await expect.poll(mainZoom).toBe(150);
  expect(savedZoom()).toBe(150);

  // The reading pane.
  await win.locator('.reader-subject').click();
  await expect.poll(() => win.evaluate(() => document.activeElement.className)).toBe('reader-scroll');
  await press('index.html', '-');
  await expect.poll(mainZoom).toBe(125);
  await press('index.html', 'numsub');
  await expect.poll(mainZoom).toBe(110);

  // Inside the email's frame, where the page's own keydown handler hears nothing.
  await win.frameLocator('.mail-frame').locator('body').click({ position: { x: 4, y: 4 } });
  await expect.poll(() => win.evaluate(() => document.activeElement.className)).toBe('mail-frame');
  await press('index.html', 'num0');
  await expect.poll(mainZoom).toBe(100);
  await press('index.html', '=');
  await expect.poll(mainZoom).toBe(110);
  // A plain key still reaches the frame: the zoom keys were stopped in main, not lost on the way.
  await press('index.html', 'x', []);
  await expect.poll(keys).toEqual(['frame:x']);

  // The editor in the reading pane: nothing is typed and no editor shortcut runs.
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  await win.locator('.composer .editor').click();
  await press('index.html', '0');
  await expect.poll(mainZoom).toBe(100);
  await press('index.html', '-');
  await expect.poll(mainZoom).toBe(90);
  await expect(win.locator('.composer .editor')).toHaveText('');
  // None of the zoom keys reached a keydown handler, so no app shortcut can fire on them.
  expect(await keys()).toEqual(['frame:x']);
  expect(savedZoom()).toBe(90);
  await press('index.html', '0');
  await expect.poll(mainZoom).toBe(100);
});

test('the zoom stops at 80% and 200%', async () => {
  for (let i = 0; i < 9; i++) await press('index.html', '=');
  await expect.poll(mainZoom).toBe(200);
  for (let i = 0; i < 12; i++) await press('index.html', '-');
  await expect.poll(mainZoom).toBe(80);
  expect(savedZoom()).toBe(80);
});

test('Ctrl+mouse wheel zooms in steps over the list, the reading pane and the email', async () => {
  await win.locator('.item').first().click();
  await expect(win.frameLocator('.mail-frame').locator('body')).toContainText('Traffic fines');
  const steps = [80, 90, 100, 110, 125, 150, 175, 200];

  await wheel('index.html', win.locator('.list-scroll'), 'in');
  await expect.poll(mainZoom).toBeGreaterThan(100);
  const afterList = await mainZoom();
  expect(steps).toContain(afterList);

  await wheel('index.html', win.locator('.mail-frame'), 'in');
  await expect.poll(mainZoom).toBeGreaterThan(afterList);
  const afterFrame = await mainZoom();
  expect(steps).toContain(afterFrame);
  expect(savedZoom()).toBe(afterFrame);

  await wheel('index.html', win.locator('.reader-subject'), 'out');
  await expect.poll(mainZoom).toBeLessThan(afterFrame);
  expect(steps).toContain(await mainZoom());
  // The wheel never leaves Chromium's own zoom, or a pinch zoom, on top of the step.
  expect(await win.evaluate(() => window.visualViewport.scale)).toBe(1);
});

test('compose windows share the zoom with the main window, both ways', async () => {
  await press('index.html', '=');
  await expect.poll(mainZoom).toBe(110);
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  const [popped] = await Promise.all([app.waitForEvent('window'), win.click('[data-c="popout"]')]);
  await popped.waitForSelector('.compose .editor');
  // A new compose window starts at the stored level.
  await expect.poll(async () => (await zoom())['compose.html']).toEqual([110]);

  await popped.locator('.compose .editor').click();
  await press('compose.html', 'Plus');
  await expect.poll(zoom).toEqual({ 'index.html': [125], 'compose.html': [125] });
  await wheel('compose.html', popped.locator('.compose .editor'), 'out');
  await expect.poll(mainZoom).toBeLessThan(125);
  expect((await zoom())['compose.html']).toEqual([await mainZoom()]);
  await press('compose.html', '0');
  await expect.poll(zoom).toEqual({ 'index.html': [100], 'compose.html': [100] });
  await expect(popped.locator('.compose .editor')).toHaveText('');
});

test('Settings shows the zoom, follows the keys while open and resets to 100%', async () => {
  await win.click('[data-action="settings"]');
  const value = win.locator('.settings [data-zoom-value]');
  const reset = win.locator('.settings [data-a="zoom-reset"]');
  await expect(value).toHaveText('100%');
  await expect(reset).toBeDisabled();
  await expect(win.locator('.settings [data-zoom]')).toContainText('Ctrl+Plus');

  await press('index.html', '=');
  await expect(value).toHaveText('110%');
  await expect(reset).toBeEnabled();
  await press('index.html', 'Plus');
  await expect(value).toHaveText('125%');
  await press('index.html', 'numadd');
  await expect(value).toHaveText('150%');
  await wheel('index.html', win.locator('.settings h1'), 'out');
  await expect(value).not.toHaveText('150%');
  expect(await value.textContent()).toBe(`${await mainZoom()}%`);

  await reset.click();
  await expect(value).toHaveText('100%');
  await expect(reset).toBeDisabled();
  expect(await mainZoom()).toBe(100);
  expect(savedZoom()).toBe(100);
});

test('the zoom survives a restart and applies to compose windows opened after it', async () => {
  await press('index.html', '=');
  await press('index.html', '=');
  await expect.poll(mainZoom).toBe(125);
  expect(savedZoom()).toBe(125);

  await quit();
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(mainZoom).toBe(125);
  await win.click('[data-action="settings"]');
  await expect(win.locator('.settings [data-zoom-value]')).toHaveText('125%');
  await win.click('.settings [data-a="back"]');

  const [compose] = await Promise.all([app.waitForEvent('window'), win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }))]);
  await compose.waitForSelector('.compose .editor');
  await expect.poll(zoom).toEqual({ 'index.html': [125], 'compose.html': [125] });
  // The page itself is zoomed, not only reported so: at 125% the window holds 1.25 times fewer CSS pixels.
  const contentWidth = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).getContentBounds().width
  );
  expect(contentWidth / (await win.evaluate(() => window.innerWidth))).toBeCloseTo(1.25, 1);
});
