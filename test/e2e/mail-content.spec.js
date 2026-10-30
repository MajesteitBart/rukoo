// The context menu in an email's content: links, images and selected text. The real app with a throwaway profile and
// the demo account; an email with an inline image and one from a local web server goes in through the demo engine.
// The browser, the image viewer and the save dialog are stubbed in the main process; the clipboard is the real one.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;
let server;
let remote;

// Two images drawn in the main process: the inline one 40 x 30, the one on the web 60 x 20.
const pngs = () =>
  app.evaluate(({ nativeImage }) => {
    const draw = (width, height, bgra) => nativeImage.createFromBitmap(Buffer.alloc(width * height * 4).map((_, i) => bgra[i % 4]), { width, height }).toPNG().toString('base64');
    return { inline: draw(40, 30, [0xd0, 0x80, 0x30, 0xff]), remote: draw(60, 20, [0x40, 0xa0, 0x20, 0xff]) };
  });

function raw(inline, remoteUrl) {
  const html = `<p id="intro">Here are the photos from Saturday.</p>
<p><a id="album" href="https://example.com/album">See the whole album</a> or write to <a id="mail" href="mailto:sanne@example.com?subject=Photos">Sanne</a>.</p>
<p><img id="inline" src="cid:pic1@example.com" width="40" height="30" alt="Inline"> <img id="remote" src="${remoteUrl}" width="60" height="20" alt="Remote"></p>`;
  return [
    'From: Sanne de Vries <sanne@example.com>',
    'To: demo@example.com',
    'Subject: Photos from the trip',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.photos@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '--b1',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <pic1@example.com>',
    'Content-Disposition: inline; filename="pic.png"',
    '',
    inline,
    '--b1--',
    ''
  ].join('\r\n');
}

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-content-e2e-');
  // The dark theme, whatever the computer's: copying depends on how the frame draws the email.
  fs.mkdirSync(path.join(dataDir, 'data'));
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });

  const images = await pngs();
  remote = Buffer.from(images.remote, 'base64');
  server = http.createServer((req, res) => {
    if (req.url !== '/pic/banner.png') return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(remote);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/pic/banner.png`;
  await app.evaluate(async (_, mail) => {
    const engine = global.__semEngine;
    await engine.session(engine.accounts[0]).append('INBOX', mail);
    await engine.syncAll();
  }, raw(images.inline, url));
  // The browser, the image viewer and the save dialog only record what they were asked.
  await app.evaluate(({ shell, dialog }, dir) => {
    const fs = process.mainModule.require('fs');
    const path = process.mainModule.require('path');
    global.__opened = [];
    global.__paths = [];
    shell.openExternal = async (url) => void global.__opened.push(url);
    shell.openPath = async (file) => {
      global.__paths.push({ file, size: fs.statSync(file).size });
      return '';
    };
    dialog.showSaveDialog = async (_win, opts) => ({ canceled: false, filePath: path.join(dir, path.basename(opts.defaultPath)) });
  }, dataDir);
  await win.locator('.item', { hasText: 'Photos from the trip' }).first().click();
  await expect(frame().locator('#intro')).toBeVisible();
  await expect.poll(() => frame().locator('#remote').evaluate((img) => img.naturalWidth)).toBe(60);
});

test.afterEach(async () => {
  await closeApp(app);
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  removeDir(dataDir);
});

const frame = () => win.frameLocator('.mail-frame');
const menu = () => win.locator('.menu');
const labels = () => menu().locator('button .ml').allTextContents();
const pick = (label) => menu().locator('button', { hasText: label }).click();
// What the clipboard holds: its text, and the size of its image, if any.
const clipboard = () =>
  app.evaluate(async ({ clipboard, nativeImage }) => {
    const [item] = await clipboard.read();
    const png = item && item.types.includes('image/png') ? await item.getType('image/png') : null;
    const image = png ? nativeImage.createFromBuffer(Buffer.from(await png.arrayBuffer())).getSize() : null;
    return { text: await clipboard.readText(), image, types: item ? item.types : [] };
  });
const clearClipboard = () => app.evaluate(({ clipboard }) => clipboard.clear());

test('a link opens in the browser or copies its address; a mailto link writes to its address', async () => {
  await clearClipboard();
  await frame().locator('#album').click({ button: 'right' });
  expect(await labels()).toEqual(['Open link', 'Copy link address', 'Select all']);
  // The menu opens where the pointer is, in the window around the frame.
  const link = await frame().locator('#album').boundingBox();
  const box = await menu().boundingBox();
  expect(Math.abs(box.y - (link.y + link.height / 2))).toBeLessThan(16);
  await pick('Copy link address');
  await expect(win.locator('#toast')).toHaveText('Link copied');
  expect((await clipboard()).text).toBe('https://example.com/album');

  await frame().locator('#album').click({ button: 'right' });
  await pick('Open link');
  await expect.poll(() => app.evaluate(() => global.__opened)).toEqual(['https://example.com/album']);

  await frame().locator('#mail').click({ button: 'right' });
  expect(await labels()).toEqual(['New message', 'Copy email address', 'Select all']);
  await expect(menu().locator('button', { hasText: 'New message' }).locator('.ms')).toHaveText('sanne@example.com');
  await pick('Copy email address');
  expect((await clipboard()).text).toBe('sanne@example.com');
  await frame().locator('#mail').click({ button: 'right' });
  const [compose] = await Promise.all([app.waitForEvent('window'), pick('New message')]);
  await expect(compose.locator('[data-field="subject"]')).toHaveValue('Photos');
  await expect(compose.locator('[data-rfield="to"] .recipient')).toHaveText(['sanne@example.com']);
});

test('an inline image and one on the web open, copy and save as the images they are', async () => {
  await frame().locator('#inline').click({ button: 'right' });
  expect(await labels()).toEqual(['Open image', 'Copy image', 'Save image as…', 'Select all']);
  await clearClipboard();
  await pick('Copy image');
  await expect(win.locator('#toast')).toHaveText('Image copied');
  expect((await clipboard()).image).toEqual({ width: 40, height: 30 });

  await frame().locator('#inline').click({ button: 'right' });
  await pick('Save image as…');
  await expect(win.locator('#toast')).toHaveText('Image saved');
  const inline = fs.readFileSync(path.join(dataDir, 'image.png'));
  expect(inline.subarray(1, 4).toString()).toBe('PNG');

  await frame().locator('#inline').click({ button: 'right' });
  await pick('Open image');
  await expect.poll(() => app.evaluate(() => global.__paths.length)).toBe(1);
  const opened = await app.evaluate(() => global.__paths[0]);
  expect(path.basename(opened.file)).toBe('image.png');
  expect(opened.size).toBe(inline.length);

  // The image from the web is saved with its own name and bytes, and copied at its own size.
  await frame().locator('#remote').click({ button: 'right' });
  await pick('Save image as…');
  await expect(win.locator('#toast')).toHaveText('Image saved');
  expect(fs.readFileSync(path.join(dataDir, 'banner.png')).equals(remote)).toBe(true);
  await frame().locator('#remote').click({ button: 'right' });
  await pick('Copy image');
  await expect.poll(async () => (await clipboard()).image).toEqual({ width: 60, height: 20 });
});

test('selected text copies as with Ctrl+C, and the menu closes on Escape or a click in the email', async () => {
  await frame().locator('#intro').click({ button: 'right' });
  expect(await labels()).toEqual(['Select all']);
  await pick('Select all');
  await expect.poll(() => frame().locator('body').evaluate((b) => b.ownerDocument.getSelection().toString())).toContain('Here are the photos');

  await clearClipboard();
  await frame().locator('#intro').click({ button: 'right' });
  expect(await labels()).toEqual(['Copy', 'Select all']);
  await pick('Copy');
  await expect.poll(async () => (await clipboard()).text).toContain('Here are the photos from Saturday.');
  expect((await clipboard()).text).toContain('See the whole album');
  // HTML mail is drawn light and inverted, so its rich copy keeps the email's own colours.
  expect((await clipboard()).types).toContain('text/html');

  await frame().locator('#intro').click({ button: 'right' });
  await expect(menu()).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(menu()).toHaveCount(0);
  await frame().locator('#intro').click({ button: 'right' });
  await expect(menu()).toBeVisible();
  await frame().locator('#intro').click();
  await expect(menu()).toHaveCount(0);
});

test('in the dark theme a plain-text email copies as plain text, not as light grey HTML', async () => {
  await win.locator('.item', { hasText: 'Call on Thursday' }).first().click();
  await expect(frame().locator('body')).toContainText('Shall we have a call on Thursday');
  await frame().locator('body').click({ button: 'right', position: { x: 30, y: 10 } });
  await pick('Select all');
  await clearClipboard();
  await frame().locator('body').click({ button: 'right', position: { x: 30, y: 10 } });
  await pick('Copy');
  await expect.poll(async () => (await clipboard()).text).toContain('Shall we have a call on Thursday');
  expect((await clipboard()).types).not.toContain('text/html');
});
