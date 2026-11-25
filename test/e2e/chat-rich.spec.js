// Rich team chat (RUK-211 contract 5.2): reactions from the hover bar and live from Olga, Markdown, the formatting bar
// and its shortcuts, files through the picker and the clipboard with the viewer, Olga's file downloading, link cards
// and their removal, Mark unread, and what shows when the server takes no files. The real app on a throwaway profile
// against the real account server with an R2 bucket and a local page for link cards; Olga is acted for over HTTP and
// every outcome is checked from the server's side too. Captures of the states go to the test's output folder.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { mention } = require('../fixtures/real-server');
const {
  skipWithoutServer,
  startServer,
  launch,
  signIn,
  openChat,
  twoPeople,
  roomRow,
  composer,
  connected,
  serverRead,
  messageRow,
  hoverTool,
  png,
  pdf,
  pickNext,
  pasteFile,
  tray,
  serverMessage,
  serverMessages,
  menuItem
} = require('./chat-helpers');

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
  dataDir = tempDir('rukoo-chat-rich-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const pane = () => win.locator('section.chat');
const log = () => win.locator('section.chat .ch-main .ch-log');
const message = (text) => messageRow(win, text);

// Bart signed in, Chat open on general, connected.
async function ready(person) {
  await signIn(win, person);
  await openChat(win);
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await connected(win);
}

async function write(text, { send = true } = {}) {
  await composer(win).click();
  await win.keyboard.type(text);
  if (send) await win.keyboard.press('Enter');
}

// A sent message's row once the server has it: its ID.
async function sentId(row) {
  await expect(row).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  return row.getAttribute('data-id');
}

// A capture once what just opened has finished fading in.
async function capture(testInfo, name) {
  await win.waitForTimeout(300);
  await win.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

test('a reaction from the hover bar shows as a chip, Olga’s arrives live, and a click takes yours back', async ({}, testInfo) => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const posted = await server.post(olga, ws.id, ws.general, 'Lunch at noon?');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const row = message('Lunch at noon?');
  await expect(row).toBeVisible({ timeout: 15000 });

  // React on the hover bar opens the picker; a search and Enter pick the first match.
  await (await hoverTool(row, 'react')).click();
  const picker = win.locator('.ch-emoji');
  await expect(picker).toBeVisible();
  await expect(picker.locator('.ch-emoji-search')).toBeFocused();
  await expect(picker.locator('.ch-emoji-cell').first()).toBeVisible({ timeout: 10000 });
  await win.keyboard.type('thumbs up');
  await expect(picker.locator('.ch-emoji-head')).toHaveText('Search results');
  await capture(testInfo, 'react-picker');
  await win.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  const thumbs = row.locator('.ch-react[data-emoji="👍"]');
  await expect(thumbs).toBeVisible();
  await expect(thumbs.locator('.ch-react-n')).toHaveText('1');
  await expect(thumbs).toHaveAttribute('aria-pressed', 'true');
  await expect(thumbs).toHaveAttribute('title', 'You reacted with 👍');
  await expect
    .poll(async () => (await serverMessage(server, olga, ws.id, ws.general, posted.messageId))?.reactions, { timeout: 15000 })
    .toEqual([{ emoji: '👍', actors: [bartMe.id] }]);

  // Olga's reactions arrive live: a new emoji makes a chip of its own, the same one counts up.
  await server.react(olga, ws.id, ws.general, posted.messageId, '🎉', true);
  const party = row.locator('.ch-react[data-emoji="🎉"]');
  await expect(party.locator('.ch-react-n')).toHaveText('1', { timeout: 15000 });
  await expect(party).toHaveAttribute('aria-pressed', 'false');
  await server.react(olga, ws.id, ws.general, posted.messageId, '👍', true);
  await expect(thumbs.locator('.ch-react-n')).toHaveText('2', { timeout: 15000 });
  await expect(thumbs).toHaveAttribute('title', 'You and Olga Owner reacted with 👍');
  await expect(row.locator('.ch-react')).toHaveCount(2);
  await capture(testInfo, 'reactions');

  // A click on your chip takes your reaction back; Olga's stays.
  await thumbs.click();
  await expect(thumbs.locator('.ch-react-n')).toHaveText('1');
  await expect(thumbs).toHaveAttribute('aria-pressed', 'false');
  const sorted = (list) => (list || []).map((g) => `${g.emoji}=${g.actors.join(',')}`).sort();
  await expect
    .poll(async () => sorted((await serverMessage(server, olga, ws.id, ws.general, posted.messageId))?.reactions), { timeout: 15000 })
    .toEqual(sorted([
      { emoji: '👍', actors: [ws.me.id] },
      { emoji: '🎉', actors: [ws.me.id] }
    ]));

  // By keyboard: Tab from the focused row reaches its hover bar, and Escape closes the picker again.
  await row.focus();
  await win.keyboard.press('Tab');
  await expect(win.locator('section.chat .ch-main li.ch-msg:focus-within .ch-tools')).toBeVisible();
  const focused = await win.evaluate(() => document.activeElement?.closest('li.ch-msg')?.dataset.id || null);
  expect(focused).toBe(posted.messageId);
  await row.locator('[data-ch-tool="react"]').focus();
  await win.keyboard.press('Enter');
  await expect(picker).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
});

test('Markdown shows bold, a list, a code block and a mention inside bold, and the text keeps its markers on the wire', async ({}, testInfo) => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const text = '**Hi @Bart**, the plan:\n- write it\n- ship it\n```\nnpm test\n```\nSee _you_ ~~soon~~ `today`';
  await server.post(olga, ws.id, ws.general, text, { mentions: [mention(text, '@Bart', bartMe.id)] });
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const row = message('the plan');
  await expect(row).toBeVisible({ timeout: 15000 });
  const body = row.locator('.ch-text');
  await expect(body.locator('strong .ch-mention.is-me')).toHaveText('@Bart');
  await expect(body.locator('ul.ch-list > li')).toHaveText(['write it', 'ship it']);
  await expect(body.locator('pre.ch-pre code')).toHaveText('npm test');
  await expect(body.locator('em')).toHaveText('you');
  await expect(body.locator('s')).toHaveText('soon');
  await expect(body.locator('code.ch-code')).toHaveText('today');
  // The markers don't show.
  await expect(body).not.toContainText('**');
  await expect(row).toHaveClass(/mentions-me/);
  await capture(testInfo, 'markdown');
});

test('the formatting bar and Ctrl+B wrap the selection, and the message goes out with Markdown markers', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const box = pane().locator('.ch-main .ch-box');
  const bar = box.locator('.ch-fmt');
  const toggle = box.locator('[data-ch-compose="format"]');
  await expect(bar).toBeHidden();
  await toggle.click();
  await expect(bar).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.locator('[data-format="bold"]')).toHaveAttribute('title', 'Bold (Ctrl+B)');

  // Ctrl+B on a selection.
  await write('make this bold', { send: false });
  for (let i = 0; i < 4; i++) await win.keyboard.press('Shift+ArrowLeft');
  await win.keyboard.press('Control+B');
  await expect(composer(win)).toHaveJSProperty('value', 'make this **bold**');
  // Ctrl+B again takes it off, and the bar's Italic wraps the same selection.
  await win.keyboard.press('Control+B');
  await expect(composer(win)).toHaveJSProperty('value', 'make this bold');
  await bar.locator('[data-format="italic"]').click();
  await expect(composer(win)).toHaveJSProperty('value', 'make this _bold_');
  await win.keyboard.press('End');
  // Ctrl+Shift+8 makes the line a list item.
  await win.keyboard.press('Shift+Enter');
  await win.keyboard.type('and a list');
  await win.keyboard.press('Control+Shift+Digit8');
  await expect(composer(win)).toHaveJSProperty('value', 'make this _bold_\n- and a list');
  await capture(testInfo, 'formatting-bar');
  await win.keyboard.press('Enter');
  const row = message('make this');
  await sentId(row);
  await expect(row.locator('.ch-text em')).toHaveText('bold');
  await expect(row.locator('.ch-text ul.ch-list > li')).toHaveText(['and a list']);
  expect((await serverMessages(server, olga, ws.id, ws.general, 'make this _bold_\n- and a list')).length).toBe(1);
  // The bar stays as the person left it.
  await expect(bar).toBeVisible();
});

test('files from the picker and the clipboard upload in the tray, go with the message, and an image opens in the viewer', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const files = path.join(dataDir, 'attach');
  fs.mkdirSync(files, { recursive: true });
  const photo = path.join(files, 'photo.png');
  const plan = path.join(files, 'plan.pdf');
  fs.writeFileSync(photo, png(320, 200));
  fs.writeFileSync(plan, pdf('Plan'));

  // The picker path: Attach, then main's dialog answers with the two files.
  await pickNext(app, [photo, plan]);
  await pane().locator('.ch-main [data-ch-compose="attach"]').click();
  const items = tray(win).locator('.ch-tray-item');
  await expect(items).toHaveCount(2, { timeout: 15000 });
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(2, { timeout: 20000 });
  await expect(tray(win).locator('.ch-tray-item.is-image img')).toHaveCount(1);
  await expect(tray(win).locator('.ch-tray-item.is-file .ch-file-name')).toHaveText('plan.pdf');
  await write('Here are the files', { send: false });
  await capture(testInfo, 'tray');
  await expect(pane().locator('.ch-main .ch-send')).toBeEnabled();
  await win.keyboard.press('Enter');
  await expect(tray(win)).toBeHidden();
  const row = message('Here are the files');
  const id = await sentId(row);
  await expect(row.locator('.ch-media .ch-img')).toHaveCount(1);
  await expect(row.locator('.ch-file .ch-file-name')).toHaveText('plan.pdf');
  await expect(row.locator('.ch-img')).toHaveClass(/is-loaded/, { timeout: 15000 });
  await expect.poll(async () => (await serverMessage(server, olga, ws.id, ws.general, id))?.attachments?.map((f) => f.name), { timeout: 15000 }).toEqual(['photo.png', 'plan.pdf']);
  const sent = await serverMessage(server, olga, ws.id, ws.general, id);
  expect(sent.attachments[0]).toMatchObject({ type: 'image/png', width: 320, height: 200 });

  // The clipboard: a pasted image with no text is a message of its own.
  await pasteFile(win, { name: 'pasted.png', type: 'image/png', bytes: png(64, 48, [31, 157, 92]) });
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(1, { timeout: 20000 });
  await composer(win).focus();
  await win.keyboard.press('Enter');
  await expect(tray(win)).toBeHidden();
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general)).filter((e) => (e.attachments || []).some((f) => f.name === 'pasted.png')).length, { timeout: 15000 }).toBe(1);
  await expect(log().locator('li.ch-msg .ch-img')).toHaveCount(2, { timeout: 15000 });

  // The viewer: the image at fit size, its name, Open and Save; Escape closes it.
  await row.locator('.ch-img').click();
  const viewer = win.locator('.ch-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.ch-viewer-name')).toHaveText('photo.png');
  await expect(viewer.locator('.ch-viewer-stage')).toHaveClass(/is-loaded/, { timeout: 15000 });
  await expect(viewer.locator('[data-viewer="open"]')).toBeVisible();
  await expect(viewer.locator('[data-viewer="save"]')).toBeVisible();
  await capture(testInfo, 'viewer');
  await win.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});

test('Olga’s file arrives as a card, downloads to where Bart saves it, and opens in its app', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  const bytes = pdf('Report');
  const { id: file } = await server.upload(olga, ws.id, ws.general, { name: 'report.pdf', type: 'application/pdf', bytes });
  await server.post(olga, ws.id, ws.general, 'The report', { attachments: [file] });
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const row = message('The report');
  const card = row.locator('.ch-file');
  await expect(card.locator('.ch-file-name')).toHaveText('report.pdf', { timeout: 15000 });
  await capture(testInfo, 'file-card');
  const to = path.join(dataDir, 'saved-report.pdf');
  await app.evaluate((_e, p) => {
    global.__semChatSaveTo = p;
  }, to);
  await card.locator('.ch-file-dl').click();
  await expect(win.locator('#toast')).toContainText('Saved report.pdf', { timeout: 15000 });
  expect(fs.readFileSync(to)).toEqual(bytes);
  // Open: main downloads it (from its cache now) and hands it to the system.
  await card.locator('.ch-file-main').click();
  await expect.poll(() => app.evaluate(() => (global.__semChatOpened || []).length), { timeout: 15000 }).toBe(1);
  const opened = await app.evaluate(() => global.__semChatOpened[0]);
  expect(path.basename(opened)).toBe('report.pdf');
  expect(fs.readFileSync(opened)).toEqual(bytes);
});

test('a link card arrives under a posted link, and its author removes it', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  const url = await server.previewPage({ title: 'Quarterly plan', description: 'What the team does next quarter, and why.', image: true });
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await write(`Read this first: ${url}`);
  const row = message('Read this first');
  const id = await sentId(row);
  const card = row.locator('.ch-card');
  await expect(card.locator('.ch-card-title')).toHaveText('Quarterly plan', { timeout: 20000 });
  await expect(card.locator('.ch-card-desc')).toHaveText('What the team does next quarter, and why.');
  await expect(card.locator('.ch-card-title')).toHaveAttribute('href', new RegExp(`^${new URL(url).origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await expect(card.locator('.ch-card-img')).toHaveClass(/is-loaded/, { timeout: 15000 });
  await capture(testInfo, 'link-card');
  // The author's remove button shows on hover; the card goes here and on the server.
  await card.hover();
  await card.locator('.ch-card-x').click();
  await expect(row.locator('.ch-card')).toHaveCount(0);
  await expect.poll(async () => (await serverMessage(server, olga, ws.id, ws.general, id))?.previews, { timeout: 15000 }).toEqual([]);
  // Olga's message with a link has a card, without a remove button for Bart.
  await server.post(olga, ws.id, ws.general, `Also ${url}`);
  const hers = message('Also');
  await expect(hers.locator('.ch-card-title')).toHaveText('Quarterly plan', { timeout: 20000 });
  await expect(hers.locator('.ch-card-x')).toHaveCount(0);
});

test('Mark unread puts the New divider before the message, brings the badge back, and holds reads until the room opens again', async ({}, testInfo) => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const random = await server.seedChannel(olga, ws.id, { name: 'random', members: [bartMe.id] });
  await server.post(olga, ws.id, ws.general, 'First note');
  const second = await server.post(olga, ws.id, ws.general, 'Second note');
  await server.post(olga, ws.id, ws.general, 'Third note');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await expect(message('Third note')).toBeVisible({ timeout: 15000 });
  // Read up to the end.
  await expect.poll(() => serverRead(server, bart, ws.id, ws.general), { timeout: 15000 }).toBeGreaterThanOrEqual(second.seq + 1);

  const row = message('Second note');
  await (await hoverTool(row, 'menu')).click();
  await menuItem(win, 'Mark unread').click();
  await expect(win.locator('#toast')).toContainText('Marked unread');
  await expect.poll(() => serverRead(server, bart, ws.id, ws.general), { timeout: 15000 }).toBe(second.seq - 1);
  // The divider sits right before the message, and the sidebar counts two unread again.
  const divider = log().locator('li.ch-new');
  await expect(divider).toBeVisible();
  expect(await divider.evaluate((el) => el.nextElementSibling?.dataset.id)).toBe(second.messageId);
  await expect(roomRow(win, 'general').locator('.count')).toHaveText('2', { timeout: 15000 });
  await capture(testInfo, 'mark-unread');
  // The room on screen doesn't read them again by itself.
  await win.waitForTimeout(2500);
  expect(await serverRead(server, bart, ws.id, ws.general)).toBe(second.seq - 1);
  // Opening it again ends the pause.
  await roomRow(win, 'random').click();
  await expect(pane().locator('.ch-title')).toHaveText('random');
  await roomRow(win, 'general').click();
  await expect(pane().locator('.ch-title')).toHaveText('general');
  await expect.poll(() => serverRead(server, bart, ws.id, ws.general), { timeout: 15000 }).toBeGreaterThan(second.seq);
  expect(random.id).toBeTruthy();
});

test('Mark unread on another device moves the New divider of the room open here and holds its reads', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const first = await server.post(olga, ws.id, ws.general, 'First note');
  const second = await server.post(olga, ws.id, ws.general, 'Second note');
  const third = await server.post(olga, ws.id, ws.general, 'Third note');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await expect(message('Third note')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => serverRead(server, bart, ws.id, ws.general), { timeout: 15000 }).toBeGreaterThanOrEqual(third.seq);
  // Opened with three unread notes: the New divider sits before the first, and stays there while the room is open.
  const divider = log().locator('li.ch-new');
  const nextId = () => divider.evaluate((el) => el.nextElementSibling?.dataset.id);
  await expect(divider).toBeVisible();
  expect(await nextId()).toBe(first.messageId);
  // Bart's phone marks the second note unread; this window follows through the feed, divider included.
  await server.markUnread(bart, ws.id, ws.general, second.messageId);
  await expect.poll(nextId, { timeout: 15000 }).toBe(second.messageId);
  await expect(roomRow(win, 'general').locator('.count')).toHaveText('2', { timeout: 15000 });
  // The room on screen doesn't read them again by itself.
  await win.waitForTimeout(2500);
  expect(await serverRead(server, bart, ws.id, ws.general)).toBe(second.seq - 1);
});

test('without files on the server, Attach, paste and drop add nothing, and reactions still work', async ({}, testInfo) => {
  const plain = await startServer({ files: false });
  try {
    const { olga, bart, ws } = await twoPeople(plain);
    await plain.post(olga, ws.id, ws.general, 'No files here');
    ({ app, win } = await launch(plain, { dataDir }));
    await ready(bart);
    const row = message('No files here');
    await expect(row).toBeVisible({ timeout: 15000 });
    const box = pane().locator('.ch-main .ch-box');
    await expect(box.locator('[data-ch-compose="mention"]')).toBeVisible();
    await expect(box.locator('[data-ch-compose="emoji"]')).toBeVisible();
    await expect(box.locator('[data-ch-compose="attach"]')).toBeHidden();
    await pasteFile(win, { name: 'pasted.png', type: 'image/png', bytes: png(8, 8) });
    await expect(tray(win).locator('.ch-tray-item')).toHaveCount(0);
    // A drop shows no target either.
    await composer(win).evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1, 2, 3])], 'a.bin'));
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(pane().locator('.ch-drop')).toBeHidden();
    await expect(row.locator('[data-ch-tool="react"]')).toHaveCount(1);
    await capture(testInfo, 'files-off');
  } finally {
    await closeApp(app);
    app = null;
    await plain.close();
  }
});

test('captures: a populated conversation in both themes, in Dutch, and in a narrow window', async ({}, testInfo) => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const { id: file } = await server.upload(olga, ws.id, ws.general, { name: 'Kwartaalplan 2027.pdf', type: 'application/pdf', bytes: pdf('Plan') });
  const shots = [];
  for (const [i, color] of [[47, 102, 214], [31, 157, 92], [210, 59, 59], [194, 124, 0], [120, 80, 200]].entries()) {
    shots.push((await server.upload(olga, ws.id, ws.general, { name: `shot-${i + 1}.png`, type: 'image/png', bytes: png(480, 300, color), width: 480, height: 300 })).id);
  }
  const intro = '## Launch notes\n**Ship** the _new_ composer:\n1. reactions\n2. files\n> Keep it calm.';
  const m1 = await server.post(olga, ws.id, ws.general, intro);
  await server.react(olga, ws.id, ws.general, m1.messageId, '🎉', true);
  await server.post(olga, ws.id, ws.general, 'The plan and the screens', { attachments: [file, ...shots] });
  const url = await server.previewPage({ title: 'Design review', description: 'Notes from the review of the chat composer and its new tools.', image: { width: 800, height: 420 } });
  await server.post(olga, ws.id, ws.general, `Notes: ${url}`);
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  // The profile follows the system's theme: dark first, on purpose.
  await win.evaluate(() => window.mail.call('updateSettings', { theme: 'dark' }));
  await expect(win.locator('html')).not.toHaveClass(/light/);
  await expect(message('Notes:').locator('.ch-card-title')).toHaveText('Design review', { timeout: 20000 });
  await server.react(olga, ws.id, ws.general, m1.messageId, '👍', true);
  await expect(message('Launch notes').locator('.ch-react[data-emoji="👍"] .ch-react-n')).toHaveText('1', { timeout: 15000 });
  // Enter typed while the emoji data still loads picks the first match once it's in.
  await (await hoverTool(message('Launch notes'), 'react')).click();
  await win.keyboard.type('thumbs up');
  await win.keyboard.press('Enter');
  await expect(message('Launch notes').locator('.ch-react[data-emoji="👍"] .ch-react-n')).toHaveText('2', { timeout: 15000 });
  await pane().locator('.ch-main [data-ch-compose="format"]').click();
  await write('Drafting a reply with **bold**', { send: false });
  await message('Launch notes').hover();
  await capture(testInfo, 'dark-1400');
  // The wide link card, and a file in the tray.
  await message('Notes:').scrollIntoViewIfNeeded();
  await pasteFile(win, { name: 'screenshot.png', type: 'image/png', bytes: png(200, 120, [120, 80, 200]) });
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(1, { timeout: 20000 });
  await capture(testInfo, 'dark-1400-card-tray');
  await win.evaluate(() => window.mail.call('updateSettings', { theme: 'light' }));
  await expect(win.locator('html')).toHaveClass(/light/);
  await message('Launch notes').hover();
  await capture(testInfo, 'light-1400');
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await expect(pane().locator('.ch-main [data-ch-compose="attach"]')).toHaveAttribute('title', 'Bestanden toevoegen');
  await capture(testInfo, 'light-nl');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 900));
  await message('The plan').hover();
  await capture(testInfo, 'light-nl-900');
  await win.evaluate(() => window.mail.call('updateSettings', { theme: 'dark', language: 'en' }));
  await pane().locator('.ch-main [data-ch-compose="emoji"]').click();
  await expect(win.locator('.ch-emoji .ch-emoji-cell').first()).toBeVisible({ timeout: 10000 });
  await capture(testInfo, 'dark-900-emoji');
  await win.keyboard.press('Escape');
  await message('The plan').locator('.ch-img').nth(3).click();
  await expect(win.locator('.ch-viewer .ch-viewer-meta')).toContainText('4 of 5');
  await capture(testInfo, 'dark-900-viewer');
  await win.keyboard.press('Escape');
  expect(bartMe.id).toBeTruthy();
});

// Issue 377: the picker's group tabs showed each group's first emoji, so a click on one read as picking that emoji, and
// nothing went in. The tabs are line icons now that only jump to their group; an emoji picked from a composer's picker
// goes in at that composer's caret, over its selection, and the typing goes on there.
test('an emoji picked from a composer’s picker goes in at its caret, in the conversation and in a thread, and a group tab only jumps to its group', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  await server.post(olga, ws.id, ws.general, 'Lunch on Friday?');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const main = composer(win);
  const reply = composer(win, { thread: true });
  const value = (input) => input.evaluate((el) => el.value);
  const picker = win.locator('.ch-emoji');
  const tabs = picker.locator('.ch-emoji-tab');
  async function openPicker(scope) {
    await pane().locator(`${scope} [data-ch-compose="emoji"]`).click();
    await expect(picker.locator('.ch-emoji-cell').first()).toBeVisible({ timeout: 10000 });
    await expect(picker.locator('.ch-emoji-search')).toBeFocused();
  }

  // The caret in the middle of the text.
  await main.click();
  await win.keyboard.type('Hello world');
  for (let i = 0; i < 6; i++) await win.keyboard.press('ArrowLeft');
  await openPicker('.ch-main');
  // A tab per group, drawn as a line icon with no emoji in it; the group at the top of the list is the selected one.
  await expect(tabs).toHaveCount(9);
  await expect(tabs.locator('svg')).toHaveCount(9);
  expect(await picker.locator('.ch-emoji-tabs').textContent()).not.toMatch(/\p{Extended_Pictographic}/u);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  // A tab only jumps to its group: it shows as selected, the picker stays open and the text stays as it was.
  const people = picker.locator('.ch-emoji-tab[data-group="people-body"]');
  await people.click();
  await expect(people).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'false');
  await expect(picker).toBeVisible();
  expect(await value(main)).toBe('Hello world');
  // Once the list is there, its group is at the top and its tab is still the selected one.
  const grid = picker.locator('.ch-emoji-grid');
  const settled = () => grid.evaluate((el) => {
    const sec = (id) => el.querySelector(`.ch-emoji-sec[data-group="${id}"]`).offsetTop;
    const end = el.scrollHeight - el.clientHeight;
    return { top: Math.round(el.scrollTop), people: sec('people-body'), flags: Math.round(Math.min(sec('flags'), end)) };
  });
  await expect.poll(async () => { const s = await settled(); return s.top === s.people; }, { timeout: 5000 }).toBe(true);
  await win.waitForTimeout(300);
  await expect(people).toHaveAttribute('aria-selected', 'true');
  await capture(testInfo, 'emoji-tab-jumped');
  // A long jump to the last group, over groups not drawn yet (taller than the room kept for them): it gets there, and the
  // groups it passes don't take the selection.
  const flags = picker.locator('.ch-emoji-tab[data-group="flags"]');
  await flags.click();
  await expect.poll(async () => { const s = await settled(); return Math.abs(s.top - s.flags) <= 1; }, { timeout: 5000 }).toBe(true);
  await win.waitForTimeout(300);
  await expect(flags).toHaveAttribute('aria-selected', 'true');
  await expect(picker.locator('.ch-emoji-tab[aria-selected="true"]')).toHaveCount(1);
  expect(await value(main)).toBe('Hello world');
  // A press in the list during a jump stops the list where it is, so the emoji under the pointer is still there at its
  // release. The jump back to the first group is the longest one.
  await tabs.first().click();
  const stopped = await grid.evaluate(async (el) => {
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    await frame();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await frame();
    const at = el.scrollTop;
    for (let i = 0; i < 12; i++) await frame();
    return el.scrollTop === at;
  });
  expect(stopped).toBe(true);
  // Scrolling by hand moves the selection with the list.
  await grid.evaluate((el) => el.scrollTo({ top: el.querySelector('.ch-emoji-sec[data-group="people-body"]').offsetTop }));
  await expect(people).toHaveAttribute('aria-selected', 'true');
  // An emoji goes in at the caret, and the typing goes on after it.
  await picker.locator('.ch-emoji-sec[data-group="people-body"] .ch-emoji-cell').first().click();
  await expect(picker).toHaveCount(0);
  await expect(main).toBeFocused();
  await win.keyboard.type('!');
  expect(await value(main)).toBe('Hello👋! world');
  // A search, then a click: the emoji takes the selection's place.
  await win.keyboard.press('End');
  for (let i = 0; i < 5; i++) await win.keyboard.press('Shift+ArrowLeft');
  await openPicker('.ch-main');
  await win.keyboard.type('tada');
  await expect(picker.locator('.ch-emoji-head')).toHaveText('Search results');
  await picker.locator('.ch-emoji-cell').first().click();
  await expect(main).toBeFocused();
  expect(await value(main)).toBe('Hello👋! 🎉');
  await capture(testInfo, 'emoji-main-composer');

  // The thread's composer, with the formatting bar open: an emoji from Recently used goes in there and nowhere else.
  await (await hoverTool(message('Lunch on Friday?'), 'reply')).click();
  await expect(reply).toBeFocused();
  await win.keyboard.type('Count me in ');
  await pane().locator('.ch-thread [data-ch-compose="format"]').click();
  await expect(pane().locator('.ch-thread .ch-fmt')).toBeVisible();
  await openPicker('.ch-thread');
  await expect(tabs.first()).toHaveAttribute('data-group', 'recent');
  await picker.locator('.ch-emoji-sec[data-group="recent"] .ch-emoji-cell').first().click();
  await expect(picker).toHaveCount(0);
  await expect(reply).toBeFocused();
  await win.keyboard.type('!');
  expect(await value(reply)).toBe('Count me in 🎉!');
  expect(await value(main)).toBe('Hello👋! 🎉');
  await capture(testInfo, 'emoji-thread-composer');
  await win.keyboard.press('Enter');
  await expect(messageRow(win, 'Count me in 🎉!', { thread: true })).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, 'Count me in 🎉!')).length, { timeout: 15000 }).toBe(1);
});
