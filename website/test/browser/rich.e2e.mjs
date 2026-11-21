// Rich team chat in the browser, end to end: files, images, reactions, Markdown and link cards, against the real site
// and account Workers (harness.mjs) with a files bucket and the link card pages, in headless Chromium. Olga uses the
// page; Piet is the other member, acted for over the server's API, and every outcome the page causes is checked from
// his side too. The tests run in order on one page: a file through Attach, uploading without a percentage (a), an image
// dropped on the conversation and shown in the viewer, downloaded and opened (b), a pasted file (c), Piet's files
// arriving and downloading (d), reactions both ways and the emoji picker under the title bar (e), Markdown both ways
// (f), link cards and their removal (g), the same conversation, the picker and a picture whose upload is redirected on
// a phone in Dutch (h), a picked file that changed on disk (i), a reload with files in the tray (j), and, on a page of
// its own, a picture that left the download cache (k). Each test fails on a console or page error and on horizontal
// overflow.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { clean, expect, makeAccount, message, openPage, openRoom, shot, signIn, startWorkers, targets, tr } from './harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// A real PNG of one colour (plain Node, from the server's link card pages).
const { png } = require(path.join(ROOT, 'server', 'test', 'fixtures', 'preview-pages.cjs'));

const WORKSPACE = 'Acme Studio';
const LIVE_MS = 15000;
const pdf = (title) => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n% ${title}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

let env = null;
let olga = null;
let piet = null;
let ws = null;
let view = null;
let phone = null;
// Piet's first message, which the reactions are on.
let morning = null;

before(async () => {
  env = await startWorkers({ files: true });
  olga = await makeAccount(env.origin, { email: 'olga@example.test' });
  piet = await env.seed.seedAccount();
  ws = await env.seed.seedWorkspace(olga, { name: WORKSPACE, displayName: 'Olga Owner' });
  piet.me = await env.seed.seedMember(ws, piet, 'Piet de Vries');
  morning = await env.seed.post(piet, ws.id, ws.general, 'Morning. The plan for the launch is below.');
});

after(async () => {
  for (const v of [view, phone]) await v?.context.close().catch(() => {});
  await env?.close();
});

// The conversation's events as the server has them for Piet.
async function serverEvents(conversation = ws.general) {
  const out = [];
  let after = 0;
  for (;;) {
    const page = await env.seed.call('GET', `/v1/workspaces/${ws.id}/conversations/${conversation}/events?after=${after}&limit=100`, { token: piet.token });
    assert.equal(page.status, 200, page.text);
    const events = page.body.events || [];
    out.push(...events);
    if (events.length < 100) break;
    after = events[events.length - 1].seq;
  }
  return out;
}
const serverMessage = async (id) => (await serverEvents()).find((e) => e.kind === 'message.posted' && e.id === id) || null;

// A message row once the server has it: its ID.
async function sentId(row) {
  await expect(row).toHaveAttribute('data-seq', /^\d+$/, { timeout: LIVE_MS });
  return row.getAttribute('data-id');
}

const tray = (page) => page.locator('section.chat .ch-main .ch-tray');
// The account server's upload and download links (server/src/files.js fileLink): a PUT uploads, a GET downloads.
const FILE_LINK = /\/v1\/workspaces\/[^/]+\/files\/[^/?]+$/;
const composer = (page) => page.locator('section.chat .ch-main .ch-input');

async function write(page, text, { send = true } = {}) {
  await composer(page).click();
  await page.keyboard.type(text);
  if (send) await page.keyboard.press('Enter');
}

// What Piet downloads of a file as a device does: the link, then the bytes.
async function pietGets(file) {
  const got = await env.seed.download(piet, ws.id, ws.general, file);
  assert.equal(got.status, 200);
  return got.bytes;
}

// The bytes of a download the page started.
async function downloaded(download) {
  const file = await download.path();
  return readFileSync(file);
}

// What #toast said while fn ran and for a second after: the toast about a download would come a moment after the
// download itself, once the call that started it has answered.
async function toastsDuring(page, fn) {
  await page.evaluate(() => {
    const el = document.getElementById('toast');
    window.__toasts = [];
    window.__toastWatch?.disconnect();
    window.__toastWatch = new MutationObserver(() => {
      if (el.classList.contains('show')) window.__toasts.push(el.textContent);
    });
    window.__toastWatch.observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  });
  const out = await fn();
  await page.waitForTimeout(1000);
  const texts = await page.evaluate(() => {
    window.__toastWatch.disconnect();
    return window.__toasts;
  });
  return { out, texts };
}

// A PNG of noise, which doesn't compress: about w * h * 3 bytes.
function noisePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.from([0]), randomBytes(w * 3));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

// Scrolls the open conversation's log so locator's top is at about y.
async function placeAt(page, locator, y) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.locator('section.chat .ch-main .ch-scroll').evaluate((el, by) => (el.scrollTop += by), box.y - y);
  await page.waitForTimeout(200);
  return (await locator.boundingBox()).y;
}

// The open emoji picker lies under the title bar and inside the window, and a tap on its search field reaches it.
async function pickerClearOfBar(page, label) {
  const at = await page.evaluate(() => {
    const picker = document.querySelector('.ch-emoji').getBoundingClientRect();
    const bar = document.querySelector('.titlebar').getBoundingClientRect();
    const s = document.querySelector('.ch-emoji-search').getBoundingClientRect();
    const hit = document.elementFromPoint(s.left + 40, s.top + s.height / 2);
    return { top: picker.top, bottom: picker.bottom, barBottom: bar.bottom, height: innerHeight, search: hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}` : null };
  });
  assert.ok(at.top >= at.barBottom + 7.5, `${label}: the picker starts under the title bar (${at.top} < ${at.barBottom} + 8)`);
  assert.ok(at.bottom <= at.height - 7.5, `${label}: the picker ends inside the window (${at.bottom} > ${at.height} - 8)`);
  assert.equal(at.search, 'input.ch-emoji-search', `${label}: a tap on the search field reaches it`);
}

// Whether the server still holds the upload: a message can take it only then. A cancelled one is files_unavailable.
async function uploadOpen(token, id) {
  try {
    await env.seed.post({ token }, ws.id, ws.general, 'With a staged file', { attachments: [id] });
    return true;
  } catch (err) {
    if (/409 .*files_unavailable/.test(err.message)) return false;
    throw err;
  }
}

test('a: a file attached with Attach uploads in the tray, goes with the message and reaches the other member whole', async () => {
  // Test i changes a picked file under the browser, which logs the upload it refuses.
  view = await openPage(env.browser, { allow: [/^Failed to load resource: net::ERR_UPLOAD_FILE_CHANGED$/] });
  const p = view.page;
  await p.goto(`${env.origin}/app/`);
  await signIn(p, olga);
  await openRoom(p, 'general');
  await expect(message(p, 'The plan for the launch')).toBeVisible();

  // Attach shows: the server takes files.
  const attach = p.locator('.ch-main [data-ch-compose="attach"]');
  await expect(attach).toBeVisible();
  const notes = Buffer.from('Launch notes\n- landing page\n- pricing\n');
  // The upload held at the server's door: until it answers, the tray says the file uploads, without a percentage the
  // page can't know, and the bar runs without one.
  let release = null;
  const held = new Promise((resolve) => (release = resolve));
  let passed = null;
  await p.route(FILE_LINK, (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    passed = held.then(() => route.continue());
    return passed;
  });
  const chooser = p.waitForEvent('filechooser');
  await attach.click();
  await (await chooser).setFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: notes }]);
  const item = tray(p).locator('.ch-tray-item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.ch-file-name')).toHaveText('notes.txt');
  await expect(item).toHaveClass(/is-unmeasured/, { timeout: LIVE_MS });
  await expect(item.locator('.ch-tray-sub')).toContainText(tr('en', 'chat.files.webUploading'));
  await expect(item.locator('.ch-tray-sub')).not.toContainText('%');
  assert.equal(await item.locator('.ch-tray-bar i').evaluate((el) => getComputedStyle(el).animationName), 'shimmer');
  await shot(p, 'rich-a0-uploading');
  release();
  await passed;
  await p.unroute(FILE_LINK);
  await expect(tray(p).locator('.ch-tray-item.is-ready')).toHaveCount(1, { timeout: LIVE_MS });
  await expect(item).not.toHaveClass(/is-unmeasured/);
  await write(p, 'Notes for the launch', { send: false });
  await shot(p, 'rich-a1-tray');
  await p.keyboard.press('Enter');
  await expect(tray(p)).toBeHidden();

  const row = message(p, 'Notes for the launch');
  const id = await sentId(row);
  await expect(row.locator('.ch-file .ch-file-name')).toHaveText('notes.txt');
  const sent = await serverMessage(id);
  assert.equal(sent.attachments.length, 1);
  assert.deepEqual({ name: sent.attachments[0].name, type: sent.attachments[0].type, size: sent.attachments[0].size }, { name: 'notes.txt', type: 'text/plain', size: notes.length });
  assert.ok((await pietGets(sent.attachments[0].id)).equals(notes), 'Piet gets the bytes the page uploaded');
  await shot(p, 'rich-a2-sent');
  clean(view);
});

test('b: an image dropped on the conversation shows in the log and the viewer, downloads, and opens in a new tab', async () => {
  const p = view.page;
  const bytes = png(320, 200, [47, 102, 214]);
  // A drop as the browser makes one: a DataTransfer with the file, over the log.
  const data = await p.evaluateHandle((b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'plan.png', { type: 'image/png' }));
    return dt;
  }, bytes.toString('base64'));
  const log = p.locator('section.chat .ch-main .ch-scroll');
  await log.dispatchEvent('dragenter', { dataTransfer: data });
  await log.dispatchEvent('dragover', { dataTransfer: data });
  await expect(p.locator('.ch-drop')).toBeVisible();
  await log.dispatchEvent('drop', { dataTransfer: data });
  await expect(p.locator('.ch-drop')).toBeHidden();
  const item = tray(p).locator('.ch-tray-item.is-image');
  await expect(item).toHaveCount(1);
  await expect(tray(p).locator('.ch-tray-item.is-ready')).toHaveCount(1, { timeout: LIVE_MS });
  // The tray's thumbnail is the page's own (createImageBitmap and a canvas).
  await expect(item.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await write(p, 'The plan as a picture');
  const row = message(p, 'The plan as a picture');
  const id = await sentId(row);
  const sent = await serverMessage(id);
  assert.deepEqual({ ...sent.attachments[0], id: undefined, expiresAt: undefined }, { id: undefined, expiresAt: undefined, name: 'plan.png', type: 'image/png', size: bytes.length, width: 320, height: 200 });
  assert.equal(sha(await pietGets(sent.attachments[0].id)), sha(bytes));

  // In the log: the picture, from a blob: URL of the page's own.
  const tile = row.locator('.ch-media .ch-img');
  await expect(tile).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
  assert.match(await tile.locator('img').getAttribute('src'), /^blob:/);
  assert.equal(await tile.locator('img').evaluate((img) => img.naturalWidth), 320);

  // The viewer opens under the title bar, with the browser's wording.
  await tile.click();
  const viewer = p.locator('.ch-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.ch-viewer-name')).toHaveText('plan.png');
  await expect(viewer.locator('.ch-viewer-stage')).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
  const bar = await p.locator('.titlebar').boundingBox();
  const box = await viewer.boundingBox();
  assert.ok(box.y >= bar.y + bar.height - 0.5, `the viewer starts under the title bar (${box.y} < ${bar.y + bar.height})`);
  await expect(viewer.locator('[data-viewer="save"]')).toHaveAttribute('title', tr('en', 'chat.viewer.webSaveTitle'));
  await expect(viewer.locator('[data-viewer="save"]')).toHaveText(tr('en', 'chat.viewer.webSave'));
  await expect(viewer.locator('[data-viewer="open"]')).toHaveAttribute('title', tr('en', 'chat.viewer.webOpenTitle'));
  await shot(p, 'rich-b1-viewer');

  // Download: the browser's own, with the file's name and bytes, and no "Saved" toast on top.
  const { out: download, texts } = await toastsDuring(p, async () => {
    const saving = p.waitForEvent('download');
    await viewer.locator('[data-viewer="save"]').click();
    return saving;
  });
  assert.equal(download.suggestedFilename(), 'plan.png');
  assert.ok((await downloaded(download)).equals(bytes));
  assert.deepEqual(texts.filter((s) => s.includes(tr('en', 'chat.files.saved', { name: 'plan.png' }))), [], 'no "Saved" toast');

  // Open: a new tab with the image, as an image of its own type, without a way back to the page.
  const opening = p.waitForEvent('popup');
  await viewer.locator('[data-viewer="open"]').click();
  const tab = await opening;
  await tab.waitForLoadState();
  assert.match(tab.url(), /^blob:/);
  assert.equal(await tab.evaluate(() => document.contentType), 'image/png');
  assert.equal(await tab.evaluate(() => window.opener), null);
  await tab.close();
  await p.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  clean(view);
});

test('c: a pasted file without text is attached', async () => {
  const p = view.page;
  const bytes = pdf('Pricing');
  await composer(p).focus();
  await composer(p).evaluate(
    (el, b64) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'pricing.pdf', { type: 'application/pdf' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    bytes.toString('base64')
  );
  await expect(tray(p).locator('.ch-tray-item.is-ready .ch-file-name')).toHaveText('pricing.pdf', { timeout: LIVE_MS });
  await write(p, 'Pricing, pasted');
  const id = await sentId(message(p, 'Pricing, pasted'));
  const sent = await serverMessage(id);
  assert.equal(sent.attachments[0].name, 'pricing.pdf');
  assert.ok((await pietGets(sent.attachments[0].id)).equals(bytes));
  clean(view);
});

test("d: the other member's files arrive live, his image shows, and his document downloads from its card", async () => {
  const p = view.page;
  const report = pdf('Report');
  const photo = png(200, 120, [31, 157, 92]);
  const doc = await env.seed.upload(piet, ws.id, ws.general, { name: 'report.pdf', type: 'application/pdf', bytes: report });
  const pic = await env.seed.upload(piet, ws.id, ws.general, { name: 'site.png', type: 'image/png', bytes: photo, width: 200, height: 120 });
  await env.seed.post(piet, ws.id, ws.general, 'The report and a screenshot', { attachments: [doc.id, pic.id] });
  const row = message(p, 'The report and a screenshot');
  await expect(row).toBeVisible({ timeout: LIVE_MS });
  await expect(row.locator('.ch-media .ch-img')).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
  const card = row.locator('.ch-file');
  await expect(card.locator('.ch-file-name')).toHaveText('report.pdf');
  // The card says what a click does in a browser: it downloads.
  const main = card.locator('.ch-file-main');
  await expect(main).toHaveAttribute('title', tr('en', 'chat.files.webOpenTitle'));
  await expect(main).toHaveAttribute('aria-label', tr('en', 'chat.files.webOpen', { name: 'report.pdf', size: '0 KB' }).replace('0 KB', await card.locator('.ch-file-meta').innerText()));
  await shot(p, 'rich-d1-received');

  const { out: download, texts } = await toastsDuring(p, async () => {
    const saving = p.waitForEvent('download');
    await card.locator('.ch-file-dl').click();
    const got = await saving;
    // Opening a document downloads it too: a page can't hand it to an app.
    const again = p.waitForEvent('download');
    await main.click();
    assert.ok((await downloaded(await again)).equals(report));
    return got;
  });
  assert.equal(download.suggestedFilename(), 'report.pdf');
  assert.ok((await downloaded(download)).equals(report));
  assert.deepEqual(texts.filter((s) => s.includes('report.pdf')), [], 'no toast about the downloads');

  // A picture the server has no size for shows as a card, which says it opens in a new tab, and does.
  const scan = await env.seed.upload(piet, ws.id, ws.general, { name: 'scan.png', type: 'image/png', bytes: png(40, 30, [120, 120, 120]) });
  await env.seed.post(piet, ws.id, ws.general, 'A scan without its size', { attachments: [scan.id] });
  const scanCard = message(p, 'A scan without its size').locator('.ch-file .ch-file-main');
  await expect(scanCard).toHaveAttribute('title', tr('en', 'chat.files.webOpenImageTitle'), { timeout: LIVE_MS });
  const opening = p.waitForEvent('popup');
  await scanCard.click();
  const tab = await opening;
  await tab.waitForLoadState();
  assert.equal(await tab.evaluate(() => document.contentType), 'image/png');
  await tab.close();
  clean(view);
});

// The hover bar's button for a message row.
async function hoverTool(row, name) {
  await row.hover();
  const b = row.locator(`.ch-tools [data-ch-tool="${name}"]`);
  await expect(b).toBeVisible();
  return b;
}
const sorted = (list) => (list || []).map((g) => `${g.emoji}=${[...g.actors].sort().join(',')}`).sort();

test('e: a reaction from the page reaches the other member, and his arrive live and count up', async () => {
  const p = view.page;
  const row = message(p, 'The plan for the launch');
  await (await hoverTool(row, 'react')).click();
  const picker = p.locator('.ch-emoji');
  await expect(picker).toBeVisible();
  await expect(picker.locator('.ch-emoji-cell').first()).toBeVisible({ timeout: LIVE_MS });
  await p.keyboard.type('thumbs up');
  await p.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  const thumbs = row.locator('.ch-react[data-emoji="\u{1F44D}"]');
  await expect(thumbs.locator('.ch-react-n')).toHaveText('1');
  await expect(thumbs).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => sorted((await serverMessage(morning.messageId))?.reactions), { timeout: LIVE_MS }).toEqual([`\u{1F44D}=${ws.me.id}`]);

  // Piet's: a new emoji gets a chip of its own, the same one counts up, both without a reload.
  await env.seed.react(piet, ws.id, ws.general, morning.messageId, '\u{1F389}', true);
  const party = row.locator('.ch-react[data-emoji="\u{1F389}"]');
  await expect(party.locator('.ch-react-n')).toHaveText('1', { timeout: LIVE_MS });
  await expect(party).toHaveAttribute('aria-pressed', 'false');
  await env.seed.react(piet, ws.id, ws.general, morning.messageId, '\u{1F44D}', true);
  await expect(thumbs.locator('.ch-react-n')).toHaveText('2', { timeout: LIVE_MS });
  await shot(p, 'rich-e1-reactions');

  // A click on her chip takes hers back, here and on the server; Piet's stay.
  await thumbs.click();
  await expect(thumbs.locator('.ch-react-n')).toHaveText('1');
  await expect(thumbs).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(async () => sorted((await serverMessage(morning.messageId))?.reactions), { timeout: LIVE_MS })
    .toEqual(sorted([
      { emoji: '\u{1F44D}', actors: [piet.me.id] },
      { emoji: '\u{1F389}', actors: [piet.me.id] }
    ]));

  // From a reaction halfway down the window the picker fits neither below nor fully above: it stops 8px under the title
  // bar, which lies above it and would take a click on its search field (the desktop window's drag area).
  const add = row.locator('.ch-react-add');
  const y = await placeAt(p, add, 400);
  assert.ok(y > 360 && y < 450, `the anchor sits where the picker can't fit above it (${y})`);
  await add.click();
  await expect(picker.locator('.ch-emoji-cell').first()).toBeVisible({ timeout: LIVE_MS });
  await pickerClearOfBar(p, 'desktop, from the middle');
  await p.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await p.locator('section.chat .ch-main .ch-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
  clean(view);
});

test('f: Markdown renders as formatting in the log, from the page and from the other member', async () => {
  const p = view.page;
  const text = 'Ship it **today**, run `npm test` first and be _careful_';
  await write(p, text);
  const row = message(p, 'Ship it');
  const id = await sentId(row);
  await expect(row.locator('.ch-text strong')).toHaveText('today');
  await expect(row.locator('.ch-text code.ch-code')).toHaveText('npm test');
  await expect(row.locator('.ch-text em')).toHaveText('careful');
  // The server keeps the text as written.
  assert.equal((await serverMessage(id)).text, text);

  await env.seed.post(piet, ws.id, ws.general, '> Quoted from the brief\n\nSteps:\n1. Draft\n2. Review\n\nSee [the docs](https://example.test/docs) and ~~the old plan~~\n```\nnpm run build\n```');
  const his = message(p, 'Steps:');
  await expect(his).toBeVisible({ timeout: LIVE_MS });
  await expect(his.locator('.ch-text blockquote.ch-quote')).toHaveText('Quoted from the brief');
  await expect(his.locator('.ch-text ol.ch-list > li')).toHaveText(['Draft', 'Review']);
  const link = his.locator('.ch-text a', { hasText: 'the docs' });
  await expect(link).toHaveAttribute('href', 'https://example.test/docs');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(his.locator('.ch-text del, .ch-text s')).toHaveText('the old plan');
  await expect(his.locator('.ch-text pre.ch-pre code')).toHaveText('npm run build');
  await shot(p, 'rich-f1-markdown');
  clean(view);
});

test('g: a link card arrives under a link, its image shows, and its author removes it', async () => {
  const p = view.page;
  const url = await env.seed.previewPage({ title: 'Quarterly plan', description: 'What the team does next quarter, and why.', image: { width: 600, height: 300 } });
  // Piet's link: a card with the page's title, description and picture.
  const reading = await env.seed.post(piet, ws.id, ws.general, `Background reading: ${url}`);
  const his = message(p, 'Background reading');
  const card = his.locator('.ch-card');
  await expect(card.locator('.ch-card-title')).toHaveText('Quarterly plan', { timeout: 30000 });
  await expect(card.locator('.ch-card-desc')).toHaveText('What the team does next quarter, and why.');
  await expect(card.locator('.ch-card-title')).toHaveAttribute('href', url);
  await expect(card.locator('.ch-card-img')).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
  assert.match(await card.locator('.ch-card-img img').getAttribute('src'), /^blob:/);
  await expect(card.locator('.ch-card-x')).toHaveCount(0);
  // With a reaction under it, beside the Markdown above, for the capture.
  await env.seed.react(piet, ws.id, ws.general, reading.messageId, '\u{1F440}', true);
  await expect(his.locator('.ch-react[data-emoji="\u{1F440}"]')).toBeVisible({ timeout: LIVE_MS });
  await his.scrollIntoViewIfNeeded();
  await shot(p, 'rich-g1-card');

  // Her own link: a card she can take off, here and on the server.
  await write(p, `Read this first: ${url}`);
  const mine = message(p, 'Read this first');
  const id = await sentId(mine);
  const own = mine.locator('.ch-card');
  await expect(own.locator('.ch-card-title')).toHaveText('Quarterly plan', { timeout: 30000 });
  await own.hover();
  await own.locator('.ch-card-x').click();
  await expect(mine.locator('.ch-card')).toHaveCount(0);
  await expect.poll(async () => (await serverMessage(id))?.previews, { timeout: LIVE_MS }).toEqual([]);
  // The card's title opens the page in a new tab, as any link.
  const opening = p.waitForEvent('popup');
  await card.locator('.ch-card-title').click();
  const tab = await opening;
  assert.equal(tab.url(), url);
  await tab.close();

  // In dark mode too.
  await p.emulateMedia({ colorScheme: 'dark' });
  await expect(p.locator('html')).not.toHaveClass(/\blight\b/);
  await shot(p, 'rich-g2-dark');
  await p.emulateMedia({ colorScheme: 'light' });
  clean(view);
});

test('h: on a phone in Dutch the rich conversation keeps 44px targets, the viewer and the picker clear the bar, and a stray drop stays on the page', async () => {
  // A picture smaller than a fingertip.
  const icon = await env.seed.upload(piet, ws.id, ws.general, { name: 'icon.png', type: 'image/png', bytes: png(16, 16, [214, 102, 47]), width: 16, height: 16 });
  await env.seed.post(piet, ws.id, ws.general, 'A tiny icon', { attachments: [icon.id] });
  phone = await openPage(env.browser, { locale: 'nl-NL', width: 390, height: 844, phone: true });
  const p = phone.page;
  await p.goto(`${env.origin}/app/`);
  await signIn(p, olga);
  await p.locator('.sidebar .ch-row', { hasText: 'general' }).first().click();
  await expect(p.locator('.ch-head .ch-title')).toHaveText('general');
  const row = message(p, 'The report and a screenshot');
  // Pictures load once they come near the view.
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator('.ch-media .ch-img')).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
  await expect(row.locator('.ch-file-main')).toHaveAttribute('title', tr('nl', 'chat.files.webOpenTitle'));
  await targets(p, 'the phone conversation with files');
  await shot(p, 'rich-h1-phone');
  // Reactions in view.
  const reacted = message(p, 'The plan for the launch');
  await reacted.scrollIntoViewIfNeeded();
  await expect(reacted.locator('.ch-react')).toHaveCount(2);
  await targets(p, 'the phone conversation with reactions');

  await row.scrollIntoViewIfNeeded();
  await row.locator('.ch-img').click();
  const viewer = p.locator('.ch-viewer');
  await expect(viewer.locator('.ch-viewer-stage')).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
  const bar = await p.locator('.titlebar').boundingBox();
  const box = await viewer.boundingBox();
  assert.ok(box.y >= bar.y + bar.height - 0.5, `the viewer starts under the phone's title bar (${box.y} < ${bar.y + bar.height})`);
  await expect(viewer.locator('[data-viewer="save"]')).toHaveText(tr('nl', 'chat.viewer.webSave'));
  await targets(p, 'the phone viewer');
  await shot(p, 'rich-h2-phone-viewer');
  await viewer.locator('[data-viewer="close"]').click();
  await expect(viewer).toHaveCount(0);

  // The small picture keeps its own size, and a tap within 44px of it still opens it.
  const tiny = message(p, 'A tiny icon').locator('.ch-media .ch-img');
  await tiny.scrollIntoViewIfNeeded();
  await expect(tiny).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
  const tile = await tiny.boundingBox();
  assert.deepEqual([Math.round(tile.width), Math.round(tile.height)], [16, 16]);
  await targets(p, 'a small picture');
  await p.touchscreen.tap(tile.x + tile.width + 10, tile.y + tile.height / 2);
  await expect(p.locator('.ch-viewer .ch-viewer-name')).toHaveText('icon.png');
  await p.locator('.ch-viewer [data-viewer="close"]').click();
  await expect(p.locator('.ch-viewer')).toHaveCount(0);

  // The emoji picker from a reaction halfway down: under the title bar (whose Back a tap on the search field would hit
  // otherwise), 44px targets, a 16px search field (iOS zooms into a smaller one), and arrows that follow its rows.
  const add = reacted.locator('.ch-react-add');
  const y = await placeAt(p, add, 420);
  assert.ok(y > 330 && y < 470, `the anchor sits where the picker can't fit above it (${y})`);
  await add.tap();
  const picker = p.locator('.ch-emoji');
  await expect(picker.locator('.ch-emoji-cell').first()).toBeVisible({ timeout: LIVE_MS });
  await pickerClearOfBar(p, 'phone');
  assert.equal(await picker.locator('.ch-emoji-search').evaluate((el) => getComputedStyle(el).fontSize), '16px');
  await targets(p, 'the emoji picker');
  await shot(p, 'rich-h3-phone-picker');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('ArrowDown');
  const moved = await picker.evaluate((el) => {
    const cells = [...el.querySelectorAll('.ch-emoji-cell')];
    const row = cells[0].parentElement;
    return { at: cells.indexOf(document.activeElement), columns: getComputedStyle(row).gridTemplateColumns.split(' ').length };
  });
  assert.ok(moved.columns >= 7 && moved.columns < 9, `${moved.columns} cells of 44px to a row`);
  assert.equal(moved.at, moved.columns, 'Down goes to the cell below');
  // The on-screen keyboard makes the page shorter: the picker stays, inside what is left.
  await p.setViewportSize({ width: 390, height: 480 });
  await p.waitForTimeout(200);
  await expect(picker).toHaveCount(1);
  await pickerClearOfBar(p, 'phone with the keyboard open');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(200);
  await expect(picker).toHaveCount(1);
  // Turned, or any change of width: it closes, as on desktop.
  await p.setViewportSize({ width: 400, height: 844 });
  await expect(picker).toHaveCount(0);
  await p.setViewportSize({ width: 390, height: 844 });

  // The tray on a phone: its remove button shows without a hover, with a 44px area.
  const chooser = p.waitForEvent('filechooser');
  await p.locator('.ch-main [data-ch-compose="attach"]').tap();
  await (await chooser).setFiles([{ name: 'phone-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('From the phone\n') }]);
  await expect(tray(p).locator('.ch-tray-item.is-ready')).toHaveCount(1, { timeout: LIVE_MS });
  await targets(p, 'the tray on a phone');
  await tray(p).locator('.ch-tray-x').tap();
  await expect(tray(p)).toBeHidden();

  // A picture and a document whose uploads the server redirects (307, which keeps the method and body): the page refuses
  // them before the browser follows, so nothing reaches where they point. Each failed one takes the row and says why in
  // full, as a touch screen has no tooltip, with a 44px Retry of its own under the reason.
  const target = `${env.origin}/app/moved-upload`;
  const followed = [];
  const onRequest = (req) => req.url() === target && followed.push(req.method());
  p.on('request', onRequest);
  await p.route(FILE_LINK, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 307, headers: { location: target } }) : route.continue()));
  const pick = p.waitForEvent('filechooser');
  await p.locator('.ch-main [data-ch-compose="attach"]').tap();
  await (await pick).setFiles([
    { name: 'moved.png', mimeType: 'image/png', buffer: png(64, 64, [214, 102, 47]) },
    { name: 'quarterly-report.pdf', mimeType: 'application/pdf', buffer: pdf('Moved') }
  ]);
  await expect(tray(p).locator('.ch-tray-item.is-failed')).toHaveCount(2, { timeout: LIVE_MS });
  await p.unroute(FILE_LINK);
  p.off('request', onRequest);
  assert.deepEqual(followed, [], 'the browser followed the redirect');
  const failedItems = [tray(p).locator('.ch-tray-item.is-image'), tray(p).locator('.ch-tray-item.is-file')];
  const trayBox = await tray(p).boundingBox();
  for (const failed of failedItems) {
    const reason = failed.locator('.ch-tray-sub');
    await expect(reason).toBeVisible();
    await expect(reason).toContainText(tr('nl', 'chat.errors.failed'));
    const fit = await reason.evaluate((el) => ({ width: el.clientWidth, cut: el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight }));
    assert.equal(fit.cut, false, 'the reason shows whole');
    assert.ok(fit.width > 200, `the reason has the row's width (${fit.width}px)`);
    const box = await failed.boundingBox();
    assert.ok(Math.abs(box.width - trayBox.width) < 6, `a failed item takes the row (${box.width} of ${trayBox.width})`);
    await expect(failed.locator('.ch-tray-retry')).toBeVisible();
    // The reason beside the picture or the file's icon, and Retry on a line of its own under it, in line with it; also
    // with the longest reason the tray gives, set in its place for the measure.
    for (const text of [null, tr('nl', 'chat.errors.webFileUnreadable')]) {
      const [icon, said, again] = await failed.evaluate((el, longer) => {
        const sub = el.querySelector('.ch-tray-sub');
        const before = sub.textContent;
        if (longer) sub.textContent = longer;
        const boxes = ['.ch-tray-thumb, .ch-file-ic', '.ch-tray-sub', '.ch-tray-retry'].map((sel) => {
          const r = el.querySelector(sel).getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        sub.textContent = before;
        return boxes;
      }, text);
      assert.ok(said.x >= icon.x + icon.width && said.y < icon.y + icon.height, `the reason sits beside the icon (${JSON.stringify([icon, said])})`);
      assert.ok(again.y >= said.y + said.height - 1 && Math.abs(again.x - said.x) < 2, `Retry sits under the reason, in line with it (${JSON.stringify([said, again])})`);
    }
  }
  await targets(p, 'failed files in the tray on a phone');
  // targets() passes over a control that another one's area covers: each Retry's middle is its own, and each remove
  // button's is the remove button's.
  for (const failed of failedItems) {
    for (const [locator, cls] of [[failed.locator('.ch-tray-retry'), 'ch-tray-retry'], [failed.locator('.ch-tray-x'), 'ch-tray-x']]) {
      const box = await locator.boundingBox();
      const hit = await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.className || '', [box.x + box.width / 2, box.y + box.height / 2]);
      assert.match(hit, new RegExp(`\\b${cls}\\b`), `${cls} gets a tap on its middle`);
    }
  }
  // English's Retry is much shorter than Dutch's Opnieuw proberen: it stays a 44px target.
  const retryWith = (label) =>
    failedItems[1].locator('.ch-tray-retry').evaluate((el, text) => {
      const before = el.textContent;
      el.textContent = text;
      const r = el.getBoundingClientRect();
      el.textContent = before;
      return [Math.round(r.width), Math.round(r.height)];
    }, label);
  const [w, h] = await retryWith(tr('en', 'common.actions.retry'));
  assert.ok(w >= 44 && h >= 44, `the English Retry is ${w}x${h}`);
  await shot(p, 'rich-h4-phone-failed-files');
  await p.emulateMedia({ colorScheme: 'dark' });
  await expect(p.locator('html')).not.toHaveClass(/\blight\b/);
  await p.waitForTimeout(300);
  await shot(p, 'rich-h5-phone-failed-files-dark');
  await p.emulateMedia({ colorScheme: 'light' });
  // Retry sends each again, now to the server itself.
  for (const failed of failedItems) await failed.locator('.ch-tray-retry').tap();
  await expect(tray(p).locator('.ch-tray-item.is-ready')).toHaveCount(2, { timeout: LIVE_MS });
  while (await tray(p).locator('.ch-tray-x').count()) await tray(p).locator('.ch-tray-x').first().tap();
  await expect(tray(p)).toBeHidden();

  // A file let go of outside the chat doesn't leave the page (the browser would open it in the tab).
  await p.locator('[data-web="back"]').click();
  const refused = await p.locator('.sidebar').evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'stray.txt', { type: 'text/plain' }));
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(over);
    el.dispatchEvent(drop);
    return { over: over.defaultPrevented, drop: drop.defaultPrevented, effect: over.dataTransfer.dropEffect };
  });
  assert.deepEqual(refused, { over: true, drop: true, effect: 'none' });
  clean(phone);
});

test('i: a picked file that changed on disk says to attach it again, without a Retry that cannot work', async () => {
  const p = view.page;
  await p.setViewportSize({ width: 1280, height: 800 });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rukoo-web-pick-'));
  try {
    // Large enough that measuring it takes a while, so it changes before the page has read it.
    const file = path.join(dir, 'changing.bin');
    writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, 5));
    const chooser = p.waitForEvent('filechooser');
    await p.locator('.ch-main [data-ch-compose="attach"]').click();
    await (await chooser).setFiles(file);
    writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1, 6));
    const item = tray(p).locator('.ch-tray-item');
    await expect(item).toHaveClass(/is-failed/, { timeout: LIVE_MS });
    await expect(item.locator('.ch-tray-sub')).toContainText(tr('en', 'chat.errors.webFileUnreadable'));
    // All of it shows, not cut off for a tooltip a touch screen doesn't have.
    assert.equal(await item.locator('.ch-tray-sub').evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight), true);
    // Chromium refuses to read that File again: only the chooser gives the page a new one, so there is no Retry.
    await expect(item.locator('.ch-tray-retry')).toBeHidden();
    await shot(p, 'rich-i1-changed-file');
    await item.locator('.ch-tray-x').click();
    await expect(tray(p)).toBeHidden();
    // Attached again, it goes.
    const again = p.waitForEvent('filechooser');
    await p.locator('.ch-main [data-ch-compose="attach"]').click();
    await (await again).setFiles(file);
    await expect(tray(p).locator('.ch-tray-item.is-ready')).toHaveCount(1, { timeout: 60000 });
    await tray(p).locator('.ch-tray-x').click();
    await expect(tray(p)).toBeHidden();

    // Changed after it was measured, while its reservation was on its way: Chromium refuses the upload
    // (ERR_UPLOAD_FILE_CHANGED), which files.js reports as a network failure, and the page then finds the File
    // unreadable: the tray says the same, without a Retry.
    const notes = path.join(dir, 'notes.txt');
    writeFileSync(notes, 'the first version of the notes\n');
    let release = null;
    const held = new Promise((resolve) => (release = resolve));
    const RESERVE = /\/conversations\/[^/]+\/uploads$/;
    await p.route(RESERVE, async (route) => {
      if (route.request().method() === 'POST') await held;
      return route.continue();
    });
    const late = p.waitForEvent('filechooser');
    await p.locator('.ch-main [data-ch-compose="attach"]').click();
    await (await late).setFiles(notes);
    await p.waitForFunction(() => [...window.__rukooWebTest.engine.svc.files.staged.values()].some((e) => e.sha256), null, { timeout: LIVE_MS });
    writeFileSync(notes, 'a second version, longer than the first\n');
    release();
    const changed = tray(p).locator('.ch-tray-item');
    await expect(changed.locator('.ch-tray-sub')).toContainText(tr('en', 'chat.errors.webFileUnreadable'), { timeout: LIVE_MS });
    await expect(changed.locator('.ch-tray-retry')).toBeHidden();
    await p.unroute(RESERVE);
    assert.equal(view.allowed.filter((text) => /ERR_UPLOAD_FILE_CHANGED/.test(text)).length, 1, 'the browser refused the changed upload');
    await shot(p, 'rich-i2-changed-after-measuring');
    await changed.locator('.ch-tray-x').click();
    await expect(tray(p)).toBeHidden();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  clean(view);
});

test('j: a reload with files in the tray asks first, and their reservations go with the page', async () => {
  const p = view.page;
  const chooser = p.waitForEvent('filechooser');
  await p.locator('.ch-main [data-ch-compose="attach"]').click();
  await (await chooser).setFiles([
    { name: 'kept-a.txt', mimeType: 'text/plain', buffer: Buffer.from('first\n') },
    { name: 'kept-b.txt', mimeType: 'text/plain', buffer: Buffer.from('second\n') }
  ]);
  await expect(tray(p).locator('.ch-tray-item.is-ready')).toHaveCount(2, { timeout: LIVE_MS });
  const ids = await p.evaluate(() => [...window.__rukooWebTest.engine.svc.files.staged.values()].map((e) => e.file));
  const token = await p.evaluate(() => JSON.parse(localStorage.getItem('rukoo.web.session')).token);
  assert.equal(ids.length, 2);
  // The browser asks before the files go (beforeunload), and the page goes once the person says so.
  let asked = null;
  p.once('dialog', async (dialog) => {
    asked = dialog.type();
    await dialog.accept();
  });
  await p.reload();
  assert.equal(asked, 'beforeunload');
  await expect(p.locator('.ch-ws-switch')).toBeVisible({ timeout: LIVE_MS });
  // The cancels the page sent as it went (keepalive, which Playwright doesn't report from a page that has gone) reached
  // the server: neither upload can go with a message any more. Checked once each, after a moment for those requests,
  // because a check that finds one still open sends it.
  await p.waitForTimeout(2000);
  for (const id of ids) assert.equal(await uploadOpen(token, id), false, `${id} is still open on the server`);
  clean(view);
});

test('k: a picture that left the download cache loads again, in the viewer and in the log', async () => {
  // The page's 256 MiB against images of up to 25 MiB, scaled down: a cache of 300 KB and pictures of about 200 KB. The
  // browser may log the one load of the address that went, before the page asks again.
  const small = await openPage(env.browser, { timing: { fileCacheMax: 300 * 1024 }, allow: [/^Failed to load resource: net::ERR_FILE_NOT_FOUND$/] });
  const p = small.page;
  try {
    await env.seed.seedChannel(olga, ws.id, { name: 'photos' });
    await p.goto(`${env.origin}/app/`);
    await signIn(p, olga);
    await openRoom(p, 'general');
    const first = await env.seed.upload(piet, ws.id, ws.general, { name: 'first.png', type: 'image/png', bytes: noisePng(256, 256), width: 256, height: 256 });
    await env.seed.post(piet, ws.id, ws.general, 'First photo', { attachments: [first.id] });
    const one = message(p, 'First photo').locator('.ch-media .ch-img');
    await expect(one).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
    const src = await one.locator('img').getAttribute('src');
    const second = await env.seed.upload(piet, ws.id, ws.general, { name: 'second.png', type: 'image/png', bytes: noisePng(256, 256), width: 256, height: 256 });
    await env.seed.post(piet, ws.id, ws.general, 'Second photo', { attachments: [second.id] });
    await expect(message(p, 'Second photo').locator('.ch-media .ch-img')).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
    // The second pushed the first out of the cache, and its address with it.
    const cached = (file) => p.evaluate(([w, f]) => Boolean(window.__rukooWebTest.engine.svc.store.getCachedFile(w, f)), [ws.id, file]);
    await expect.poll(() => cached(first.id)).toBe(false);
    assert.equal(await cached(second.id), true);
    // The viewer asks for it again, and it downloads once more.
    await one.click();
    const viewer = p.locator('.ch-viewer');
    await expect(viewer.locator('.ch-viewer-stage')).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
    assert.notEqual(await viewer.locator('.ch-viewer-img').getAttribute('src'), src);
    await p.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    // That download pushed the second out in turn. The log drawn again, after a visit to another channel, asks for the
    // second picture the same way, and shows both.
    await expect.poll(() => cached(second.id)).toBe(false);
    await openRoom(p, 'photos');
    await openRoom(p, 'general');
    for (const name of ['First photo', 'Second photo']) {
      const tile = message(p, name).locator('.ch-media .ch-img');
      await tile.scrollIntoViewIfNeeded();
      await expect(tile).toHaveClass(/is-loaded/, { timeout: LIVE_MS });
      await expect(tile).not.toHaveClass(/is-failed/);
    }
    clean(small);
  } finally {
    await small.context.close();
  }
});
