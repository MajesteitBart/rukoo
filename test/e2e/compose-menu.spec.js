// The context menu in the composer's text: spelling suggestions, Add to dictionary, cut, copy and paste, in the editor
// in the reading pane and in a compose window. The real app with a throwaway profile and the demo account.
//
// Each computer's spell checker finds other words and suggests others, so the computer's own is switched off and main
// gets its spelling from the test instead, in the window's own context-menu event. The window's replaceMisspelling
// and the dictionary only record what they were asked; the replacement is typed over the selection, the misspelled
// word that Chromium's own replaceMisspelling replaces. The clipboard is the real one.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

async function launch(language) {
  dataDir = tempDir('rukoo-compose-menu-e2e-');
  fs.mkdirSync(path.join(dataDir, 'data'));
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language }));
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
}

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

// The spelling main reports for the next right-clicks in every open window: { word, suggestions }, or null for none.
const spelling = (spell) =>
  app.evaluate(({ BrowserWindow, session }, spell) => {
    global.__spell = spell;
    global.__spellCalls = global.__spellCalls || [];
    session.defaultSession.setSpellCheckerEnabled(false);
    session.defaultSession.addWordToSpellCheckerDictionary = (word) => {
      global.__spellCalls.push({ add: word });
      return true;
    };
    for (const w of BrowserWindow.getAllWindows()) {
      const contents = w.webContents;
      if (contents.__spellStub) continue;
      contents.__spellStub = true;
      const where = /compose\.html$/.test(contents.getURL()) ? 'compose' : 'main';
      contents.prependListener('context-menu', (_event, params) => {
        params.misspelledWord = global.__spell ? global.__spell.word : '';
        params.dictionarySuggestions = global.__spell ? global.__spell.suggestions : [];
      });
      contents.replaceMisspelling = (word) => {
        global.__spellCalls.push({ replace: word, where });
        contents.insertText(word);
      };
    }
  }, spell);
const spellCalls = () => app.evaluate(() => global.__spellCalls);
// data: { text, html }, or null to empty the clipboard.
const setClipboard = (data) =>
  app.evaluate(({ clipboard, ClipboardItem }, data) => {
    if (!data) return clipboard.clear();
    const item = { 'text/plain': data.text };
    if (data.html) item['text/html'] = data.html;
    return clipboard.write([new ClipboardItem(item)]);
  }, data);
const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText());

const menu = (page) => page.locator('.menu');
// The menu opens once main's answer comes, a moment after the right-click.
const labels = async (page) => {
  await expect(menu(page)).toBeVisible();
  return menu(page).locator('button .ml').allTextContents();
};
const enabled = async (page) => {
  await expect(menu(page)).toBeVisible();
  return menu(page).locator('button:not(:disabled) .ml').allTextContents();
};
const pick = (page, label) => menu(page).locator('button', { hasText: label }).first().click();

// Writes the text in the editor and selects the given part of it.
async function write(page, text) {
  await page.click('.editor');
  await page.keyboard.type(text);
}
async function select(page, part) {
  return page.evaluate((part) => {
    const editor = document.querySelector('.editor');
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(part);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + part.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    throw new Error(`"${part}" is not in the editor`);
  }, part);
}
const editorText = (page) => page.locator('.editor').evaluate((e) => e.innerText.replace(/ /g, ' ').trim());
const editorFocused = (page) => page.evaluate(() => document.activeElement === document.querySelector('.editor'));

test('a misspelled word gets its suggestions in the reading pane, and a pick replaces it', async () => {
  await launch('en');
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  await spelling({ word: 'Thsi', suggestions: ['This', 'Thai', 'Tis'] });
  await write(win, 'Thsi is the plan.');
  const at = await select(win, 'Thsi');
  await win.mouse.click(at.x, at.y, { button: 'right' });
  expect(await labels(win)).toEqual(['This', 'Thai', 'Tis', 'Add to dictionary', 'Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all']);
  // The menu opens at the pointer, with its first suggestion focused, and leaves the formatting bar out of the way.
  const box = await menu(win).boundingBox();
  expect(Math.abs(box.x - at.x)).toBeLessThan(16);
  expect(Math.abs(box.y - at.y)).toBeLessThan(16);
  expect(await win.evaluate(() => document.activeElement.textContent)).toBe('This');
  await expect(win.locator('.composer .float-bar')).toBeHidden();

  await pick(win, 'This');
  await expect(menu(win)).toHaveCount(0);
  await expect.poll(() => editorText(win)).toBe('This is the plan.');
  expect(await spellCalls()).toEqual([{ replace: 'This', where: 'main' }]);
  expect(await editorFocused(win)).toBe(true);
  // The pick is an edit like any other: the draft has changed.
  await expect(win.locator('.composer')).toHaveAttribute('data-dirty', 'true');

  // Main takes only a suggestion it offered, once.
  const refused = await win.evaluate(() => window.mail.invoke('replaceMisspelling', 'Thai'));
  expect(refused).toMatchObject({ ok: false, error: 'invalid' });

  // Add to dictionary adds the word main reported; no suggestions say so.
  await spelling({ word: 'Rukoo', suggestions: [] });
  await write(win, ' Rukoo');
  const word = await select(win, 'Rukoo');
  await win.mouse.click(word.x, word.y, { button: 'right' });
  expect(await labels(win)).toEqual(['No suggestions', 'Add to dictionary', 'Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all']);
  await expect(menu(win).locator('button', { hasText: 'No suggestions' })).toBeDisabled();
  await pick(win, 'Add to dictionary');
  await expect.poll(spellCalls).toEqual([{ replace: 'This', where: 'main' }, { add: 'Rukoo' }]);
  expect(await editorFocused(win)).toBe(true);
});

test('cut, copy, paste, paste as plain text and select all act on the text in the reading pane', async () => {
  await launch('en');
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  await spelling(null);
  await write(win, 'Hello brave new world');

  // Nothing selected and nothing on the clipboard: only Select all.
  await setClipboard(null);
  await win.click('.editor');
  await win.keyboard.press('End');
  const end = await win.locator('.editor').boundingBox();
  await win.mouse.click(end.x + end.width - 20, end.y + 10, { button: 'right' });
  expect(await labels(win)).toEqual(['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all']);
  expect(await enabled(win)).toEqual(['Select all']);
  await win.keyboard.press('Escape');
  await expect(menu(win)).toHaveCount(0);
  expect(await editorFocused(win)).toBe(true);

  // Cut takes the selection out and onto the clipboard.
  let at = await select(win, 'brave ');
  await win.mouse.click(at.x, at.y, { button: 'right' });
  expect(await enabled(win)).toEqual(['Cut', 'Copy', 'Select all']);
  await pick(win, 'Cut');
  await expect.poll(() => editorText(win)).toBe('Hello new world');
  expect(await clipboardText()).toBe('brave ');
  await expect(win.locator('.composer')).toHaveAttribute('data-dirty', 'true');

  // Paste puts it back over a selection.
  at = await select(win, 'new ');
  await win.mouse.click(at.x, at.y, { button: 'right' });
  expect(await enabled(win)).toEqual(['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all']);
  await pick(win, 'Paste');
  await expect.poll(() => editorText(win)).toBe('Hello brave world');

  // Copy leaves the text as it is.
  at = await select(win, 'world');
  await win.mouse.click(at.x, at.y, { button: 'right' });
  await pick(win, 'Copy');
  await expect.poll(clipboardText).toBe('world');
  expect(await editorText(win)).toBe('Hello brave world');

  // Paste keeps the formatting; Paste as plain text drops it.
  await setClipboard({ text: 'Loud', html: '<b style="color:#d6336c">Loud</b>' });
  at = await select(win, 'brave');
  await win.mouse.click(at.x, at.y, { button: 'right' });
  await pick(win, 'Paste as plain text');
  await expect.poll(() => editorText(win)).toBe('Hello Loud world');
  expect(await win.locator('.editor b').count()).toBe(0);
  at = await select(win, 'Loud');
  await win.mouse.click(at.x, at.y, { button: 'right' });
  await pick(win, 'Paste');
  await expect(win.locator('.editor b')).toHaveText('Loud');

  // Select all selects the message text, not the window.
  await win.mouse.click(at.x, at.y, { button: 'right' });
  await pick(win, 'Select all');
  await expect.poll(() => win.evaluate(() => String(getSelection()).replace(/ /g, ' ').trim())).toBe('Hello Loud world');
  expect(await editorFocused(win)).toBe(true);
});

test('the compose window has the same menu, in Dutch, by mouse and by keyboard', async () => {
  await launch('nl');
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  const [compose] = await Promise.all([app.waitForEvent('window'), win.click('[data-c="popout"]')]);
  await compose.waitForSelector('.compose .editor');
  await spelling({ word: 'Thsi', suggestions: ['This', 'Thai'] });
  await setClipboard({ text: 'klembord' });
  await write(compose, 'Thsi werkt');
  let at = await select(compose, 'Thsi');
  await compose.mouse.click(at.x, at.y, { button: 'right' });
  expect(await labels(compose)).toEqual(['This', 'Thai', 'Toevoegen aan woordenboek', 'Knippen', 'Kopiëren', 'Plakken', 'Plakken als platte tekst', 'Alles selecteren']);
  // Only the window that was right-clicked shows it.
  await expect(menu(win)).toHaveCount(0);
  await pick(compose, 'This');
  await expect.poll(() => editorText(compose)).toBe('This werkt');
  expect(await spellCalls()).toEqual([{ replace: 'This', where: 'compose' }]);

  // Shift+F10 opens it at the caret; the arrow keys move through it and Escape gives the text its focus back.
  await spelling(null);
  at = await select(compose, 'werkt');
  await compose.keyboard.press('Shift+F10');
  await expect(menu(compose)).toBeVisible();
  const box = await menu(compose).boundingBox();
  expect(Math.abs(box.y - at.y)).toBeLessThan(40);
  expect(await compose.evaluate(() => document.activeElement.textContent)).toContain('Knippen');
  await compose.keyboard.press('ArrowDown');
  expect(await compose.evaluate(() => document.activeElement.textContent)).toContain('Kopiëren');
  await compose.keyboard.press('Escape');
  await expect(menu(compose)).toHaveCount(0);
  expect(await editorFocused(compose)).toBe(true);
  // The selection survived the menu, so Ctrl+C still copies it.
  expect(await compose.evaluate(() => String(getSelection()))).toBe('werkt');
  // The compose window stays open: Escape closed the menu, not the editor.
  expect(compose.isClosed()).toBe(false);

  // The menu key does the same.
  await compose.keyboard.press('ContextMenu');
  await expect(menu(compose)).toBeVisible();
  await compose.keyboard.press('Escape');
  await expect(menu(compose)).toHaveCount(0);
});

test('the quoted email in a reply keeps its own menu, and a right-click elsewhere opens no editor menu', async () => {
  await launch('en');
  await spelling(null);
  await win.locator('.item').first().click();
  await expect(win.frameLocator('.mail-frame').locator('body')).not.toBeEmpty();
  await win.click('[data-reader="reply"]');
  await win.waitForSelector('.composer .editor');
  await win.click('.composer .quote-pill');
  const quote = win.frameLocator('.composer .quote-frame');
  await expect(quote.locator('body')).not.toBeEmpty();
  await quote.locator('body').click({ button: 'right', position: { x: 30, y: 10 } });
  expect(await labels(win)).toEqual(['Select all']);
  await win.keyboard.press('Escape');
  await expect(menu(win)).toHaveCount(0);

  // The subject is a text field too, and main reports it, but the editor's menu is for the editor alone.
  await win.locator('.composer [data-field="subject"]').click({ button: 'right' });
  await win.waitForTimeout(300);
  await expect(menu(win)).toHaveCount(0);
  await win.locator('.composer .editor').click({ button: 'right' });
  await expect(menu(win)).toHaveCount(1);
  expect(await labels(win)).toEqual(['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all']);
});
