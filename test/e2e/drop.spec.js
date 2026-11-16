// Drops on the sidebar's folders and on the composer (#184), in the real app with a throwaway profile and the demo
// account. Chromium loses a drop in two ways. When the element under the pointer changed on the last update before the
// drop, it sends that element a dragenter and no dragover, and a dragenter nobody takes refuses the drop. When that
// element was drawn again after the last update, the drop goes to the old one, which has left the page.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-drop-e2e-');
  fs.mkdirSync(path.join(dataDir, 'data'));
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const item = (text) => win.locator('.item', { hasText: text }).first();
const inboxCount = () => win.locator('.nav-item[data-view="inbox"] .count');

// Drags a message from the list onto a sidebar row with the mouse and keeps the button down there. The row is found,
// scrolled to and measured in one step in the page, as dragToChat in agent.spec.js does, so no redraw of the list
// comes in between. Returns where the pointer is.
async function holdOver(subject, row) {
  const [from, to] = await win.evaluate(
    ([text, row]) => {
      const el = [...document.querySelectorAll('.list-scroll .item')].find((x) => x.textContent.includes(text));
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const a = el.getBoundingClientRect();
      const b = document.querySelector(row).getBoundingClientRect();
      return [
        [a.x + a.width / 2, a.y + a.height / 2],
        [b.x + b.width / 2, b.y + b.height / 2]
      ];
    },
    [subject, row]
  );
  await win.mouse.move(...from);
  await win.mouse.down();
  await win.mouse.move(...to, { steps: 5 });
  return to;
}

test('an email let go over a folder just after the sidebar was due to be drawn again still moves there, and Undo brings it back', async () => {
  await expect(inboxCount()).toHaveText('7');
  const anwb = await item('ANWB Newsletter').getAttribute('data-id');
  const at = await holdOver('Sign in to Bencompare', '[data-folder="Invoices"]');
  // The row itself is under the pointer while an email is dragged, not its name or its icon.
  const over = await win.evaluate(([x, y]) => {
    window.__row = document.querySelector('[data-folder="Invoices"]');
    return { row: document.elementFromPoint(x, y) === window.__row, marked: window.__row.classList.contains('drop-target') };
  }, at);
  expect(over).toEqual({ row: true, marked: true });

  // Mail changes while the email is held there: another message is read on another device, so the counts change.
  await app.evaluate((_e, id) => global.__semEngine.setFlags(id, { unread: false }), anwb);
  await expect(item('ANWB Newsletter')).not.toHaveClass(/unread/);
  // The list shows it. The sidebar waits until the drag is over, so the row under the pointer stays on the page.
  expect(await win.evaluate(() => window.__row.isConnected)).toBe(true);
  await expect(inboxCount()).toHaveText('7');

  await win.mouse.up();
  await expect(win.locator('#toast')).toContainText('Moved to Invoices');
  await expect(win.locator('.item', { hasText: 'Sign in to Bencompare' })).toHaveCount(0);
  // Once the drag is over, the sidebar catches up, also when the list drew the dragged row again and its dragend
  // reached nothing: the next mouse move ends it.
  await win.mouse.move(at[0], at[1] + 60);
  await expect(inboxCount()).toHaveText('6');
  await expect(win.locator('body.dragging-mail')).toHaveCount(0);
  expect(await win.evaluate(() => window.__row.isConnected)).toBe(false);

  await win.click('#toast button');
  await expect(item('Sign in to Bencompare')).toBeVisible();
  await win.click('[data-folder="Invoices"]');
  await expect(win.locator('.list-title h1')).toHaveText('Invoices');
  await expect(win.locator('.item', { hasText: 'Sign in to Bencompare' })).toHaveCount(0);
});

test('folder, Archive and Trash rows take a dragged email on dragenter', async () => {
  const result = await win.evaluate(() => {
    const ev = (type, dataTransfer) => new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true });
    const dt = new DataTransfer();
    [...document.querySelectorAll('.list-scroll .item')].find((x) => x.textContent.includes('Sign in to Bencompare')).dispatchEvent(ev('dragstart', dt));
    const out = { dragging: document.body.classList.contains('dragging-mail') };
    for (const row of ['[data-folder="Invoices"]', '[data-drop-role="archive"]', '[data-drop-role="trash"]']) {
      const label = document.querySelector(`${row} .label`);
      out[row] = { taken: !label.dispatchEvent(ev('dragenter', dt)), passesThrough: getComputedStyle(label).pointerEvents === 'none' };
    }
    // The account switcher is no folder.
    out.account = !document.querySelector('.account-switch').dispatchEvent(ev('dragenter', dt));
    document.querySelector('[data-drop-role="trash"] .label').dispatchEvent(ev('drop', dt));
    return out;
  });
  expect(result).toEqual({
    dragging: true,
    '[data-folder="Invoices"]': { taken: true, passesThrough: true },
    '[data-drop-role="archive"]': { taken: true, passesThrough: true },
    '[data-drop-role="trash"]': { taken: true, passesThrough: true },
    account: false
  });
  await expect(win.locator('#toast')).toContainText('Trash');
  await expect(win.locator('.item', { hasText: 'Sign in to Bencompare' })).toHaveCount(0);
  // When the drag ends, a row's name and icon take clicks again.
  await win.evaluate(() => document.dispatchEvent(new DragEvent('dragend')));
  await expect(win.locator('body.dragging-mail')).toHaveCount(0);
  expect(await win.evaluate(() => getComputedStyle(document.querySelector('[data-folder="Invoices"] .label')).pointerEvents)).toBe('auto');
  await win.click('#toast button');
  await expect(item('Sign in to Bencompare')).toBeVisible();
});

// Files from Explorer: drag events whose DataTransfer holds a file. A file made in the page has no path on disk, as one
// dragged out of Outlook or a zip; a drop attaches it from its bytes (#240, tested further down). This is about the
// drop target. Returns what the composer shows while the files are over its text.
const filesOver = (page) =>
  page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['hello'], 'note.txt', { type: 'text/plain' }));
    window.__files = dt;
    const composer = document.querySelector('.composer');
    const editor = composer.querySelector('.editor');
    const taken = !editor.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const r = editor.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(20, r.height / 2));
    return { taken, overlay: composer.classList.contains('drop-files'), target: hit === composer, hint: composer.dataset.dropHint, shown: getComputedStyle(composer, '::after').content };
  });
// The files leave the window, or are let go over the composer.
const filesEnd = (page, type) =>
  page.evaluate((type) => {
    const composer = document.querySelector('.composer');
    composer.dispatchEvent(new DragEvent(type, { dataTransfer: window.__files, bubbles: true, cancelable: true, relatedTarget: null }));
    const r = composer.querySelector('.editor').getBoundingClientRect();
    return { overlay: composer.classList.contains('drop-files'), text: composer.querySelector('.editor').contains(document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(20, r.height / 2))) };
  }, type);

test('files dragged over the composer are taken on dragenter by the composer itself, inline and in the compose window, in English and Dutch', async () => {
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');

  const inline = await filesOver(win);
  expect(inline).toMatchObject({ taken: true, overlay: true, target: true, hint: 'Drop to attach' });
  expect(inline.shown).not.toContain('Loslaten');
  expect(await filesEnd(win, 'dragleave')).toEqual({ overlay: false, text: true });

  // An image moved within the text carries Files too, but it is the editor's: no overlay, and the editor keeps the
  // drop. Files from Explorer right after it are taken again (below), also when that drag's dragend never reached the
  // composer.
  const inner = await win.evaluate(() => {
    const editor = document.querySelector('.composer .editor');
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    editor.prepend(img);
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'image.png', { type: 'image/png' }));
    img.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const taken = !editor.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const overlay = document.querySelector('.composer').classList.contains('drop-files');
    const editorKeepsDrop = editor.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    img.remove();
    return { taken, overlay, editorKeepsDrop };
  });
  expect(inner).toEqual({ taken: false, overlay: false, editorKeepsDrop: true });

  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await expect(win.locator('.composer [data-c="send"]')).toContainText('Verzenden');
  expect(await filesOver(win)).toMatchObject({ taken: true, overlay: true, target: true, hint: 'Loslaten om bij te voegen' });
  expect(await filesEnd(win, 'drop')).toEqual({ overlay: false, text: true });
  // The drop attaches the file, though it has no path on disk (#240).
  await expect(win.locator('.composer .att-chip .n')).toHaveText(['note.txt']);

  const [compose] = await Promise.all([app.waitForEvent('window'), win.click('[data-c="popout"]')]);
  compose.on('dialog', () => {});
  await compose.waitForSelector('.compose .editor');
  await expect(compose.locator('.att-chip .n')).toHaveText(['note.txt']);
  expect(await filesOver(compose)).toMatchObject({ taken: true, overlay: true, target: true, hint: 'Loslaten om bij te voegen' });
  expect(await filesEnd(compose, 'dragleave')).toEqual({ overlay: false, text: true });
  expect(await filesOver(compose)).toMatchObject({ taken: true, overlay: true, target: true });
  expect(await filesEnd(compose, 'drop')).toEqual({ overlay: false, text: true });
  await expect(compose.locator('.att-chip .n')).toHaveText(['note.txt', 'note.txt']);
});

// #240: files without a path on disk, as an attachment dragged out of Outlook, a file inside a zip or a picture from an
// email. Chromium hands the page such a file with its bytes only; one made in the page is the same. files: [{ name,
// text } or { name, size }], let go over the composer's text.
const dropFiles = (page, files) =>
  page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([f.size ? new Uint8Array(f.size) : f.text], f.name, { type: 'text/plain' }));
    const composer = document.querySelector('.composer');
    composer.querySelector('.editor').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    composer.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
// The attachments of the sent email with this subject, with their text.
const sentAttachments = (subject) =>
  app.evaluate(async (_e, subject) => {
    const engine = global.__semEngine;
    const id = engine.accounts[0].id;
    await engine.syncAccount(id);
    const copy = engine.listMessages({ scope: id, view: 'sent' }).find((m) => m.subject === subject);
    if (!copy) return null;
    const full = await engine.getMessage(copy.id);
    return Promise.all(full.attachments.map(async (a) => [a.filename, (await engine.attachment(copy.id, a.index)).content.toString()]));
  }, subject);
async function address(page, subject) {
  await page.locator('[data-rinput="to"]').fill('demo@example.com');
  await page.locator('[data-rinput="to"]').press('Enter');
  await page.locator('[data-field="subject"]').fill(subject);
}

test('a file without a path on disk dropped on the composer is attached and goes with the email, inline and in the compose window', async () => {
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  await dropFiles(win, [{ name: 'note.txt', text: 'Notes from the call' }]);
  await expect(win.locator('.composer .att-chip .n')).toHaveText(['note.txt']);
  await expect(win.locator('.composer')).toHaveAttribute('data-dirty', 'true');
  await address(win, 'Dropped inline');
  await win.click('.composer [data-c="send"]');
  await expect(win.locator('.composer')).toHaveCount(0, { timeout: 10000 });
  await expect.poll(() => sentAttachments('Dropped inline')).toEqual([['note.txt', 'Notes from the call']]);

  const [compose] = await Promise.all([app.waitForEvent('window'), win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }))]);
  await compose.waitForSelector('.compose .editor');
  await dropFiles(compose, [{ name: 'agenda.txt', text: 'Agenda for Thursday' }, { name: 'list.txt', text: 'Three items' }]);
  await expect(compose.locator('.att-chip .n')).toHaveText(['agenda.txt', 'list.txt']);
  await address(compose, 'Dropped in a window');
  await Promise.all([compose.waitForEvent('close'), compose.click('[data-c="send"]')]);
  await expect.poll(() => sentAttachments('Dropped in a window')).toEqual([
    ['agenda.txt', 'Agenda for Thursday'],
    ['list.txt', 'Three items']
  ]);
});

test('Send right after a drop waits until the dropped file is read, and the email carries it', async () => {
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  await address(win, 'Sent right after the drop');
  // A slow read, as of a large file from Outlook: Send comes while it is still on its way.
  await win.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      return new Promise((resolve) => setTimeout(resolve, 800)).then(() => read.call(this));
    };
  });
  await dropFiles(win, [{ name: 'late.txt', text: 'Read slowly' }]);
  await win.click('.composer [data-c="send"]');
  await expect(win.locator('.composer')).toHaveCount(0, { timeout: 10000 });
  await expect.poll(() => sentAttachments('Sent right after the drop')).toEqual([['late.txt', 'Read slowly']]);
});

// A compose window with nothing to keep closes at once, but not while a dropped file is still being read: closing it
// or quitting waits for the file, and then asks about it. The read holds until the test lets it go.
const holdReads = (page) =>
  page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    window.__reads = [];
    File.prototype.arrayBuffer = function () {
      return new Promise((resolve) => window.__reads.push(resolve)).then(() => read.call(this));
    };
  });
const releaseReads = (page) => page.evaluate(() => window.__reads.splice(0).forEach((go) => go()));
const composeOpen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith('compose.html')));
// The draft whose attachments include filename, or null.
const draftWith = (filename) =>
  app.evaluate(async (_e, filename) => {
    const engine = global.__semEngine;
    const id = engine.accounts[0].id;
    await engine.syncAccount(id);
    for (const m of engine.listMessages({ scope: id, view: 'drafts' })) {
      const full = await engine.getMessage(m.id);
      if ((full.attachments || []).some((a) => a.filename === filename)) return m.id;
    }
    return null;
  }, filename);

test('closing a clean compose window or quitting while a dropped file is read waits for it, then asks to save it', async () => {
  const [compose] = await Promise.all([app.waitForEvent('window'), win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }))]);
  compose.on('dialog', () => {});
  await compose.waitForSelector('.compose .editor');
  await expect(compose.locator('.composer')).toHaveAttribute('data-dirty', 'false');
  await holdReads(compose);
  await dropFiles(compose, [{ name: 'held.txt', text: 'Read late' }]);
  await expect.poll(() => compose.evaluate(() => window.__reads.length)).toBe(1);

  // The window's close button: it stays while the file is read, then asks.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('compose.html')).close());
  await compose.waitForTimeout(500);
  expect(await composeOpen()).toBe(true);
  await expect(compose.locator('.scrim')).toHaveCount(0);
  await releaseReads(compose);
  await expect(compose.locator('.scrim')).toContainText('Save draft?');
  await expect(compose.locator('.att-chip .n')).toHaveText(['held.txt']);
  await Promise.all([compose.waitForEvent('close'), compose.click('.scrim .buttons button:text-is("Save")')]);
  await expect.poll(() => draftWith('held.txt')).not.toBeNull();

  // A quit does the same; Cancel then keeps Rukoo running with the file attached.
  const [again] = await Promise.all([app.waitForEvent('window'), win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }))]);
  again.on('dialog', () => {});
  await again.waitForSelector('.compose .editor');
  await holdReads(again);
  await dropFiles(again, [{ name: 'quit.txt', text: 'Read during the quit' }]);
  await expect.poll(() => again.evaluate(() => window.__reads.length)).toBe(1);
  await app.evaluate(({ app }) => app.quit());
  await again.waitForTimeout(500);
  expect(await composeOpen()).toBe(true);
  await releaseReads(again);
  await expect(again.locator('.scrim')).toContainText('Save draft?');
  await again.click('.scrim .buttons button:text-is("Cancel")');
  await expect(again.locator('.scrim')).toHaveCount(0);
  await expect(again.locator('.att-chip .n')).toHaveText(['quit.txt']);
  expect(await composeOpen()).toBe(true);
});

test('a dropped file that is too large or cannot be read says so, attaches nothing and leaves the draft unchanged', async () => {
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  const composer = win.locator('.composer');
  await expect(composer).toHaveAttribute('data-dirty', 'false');

  await dropFiles(win, [{ name: 'recording.wav', size: 50 * 1024 * 1024 + 1 }]);
  await expect(win.locator('#toast')).toHaveText('recording.wav is larger than 50 MB. Save it to a folder first, then attach it from there.');
  await expect(composer.locator('.att-chip')).toHaveCount(0);
  await expect(composer).toHaveAttribute('data-dirty', 'false');

  // The file goes away before Rukoo has read it, as a zip closed meanwhile.
  await win.evaluate(() => {
    window.__arrayBuffer = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = () => Promise.reject(new DOMException('The file could not be read', 'NotReadableError'));
  });
  await dropFiles(win, [{ name: 'note.txt', text: 'gone' }]);
  await expect(win.locator('#toast')).toHaveText("note.txt couldn't be read, so it isn't attached.");
  await dropFiles(win, [{ name: 'a.txt', text: 'gone' }, { name: 'b.txt', text: 'gone' }]);
  await expect(win.locator('#toast')).toHaveText("2 files couldn't be read, so they aren't attached.");
  await expect(composer.locator('.att-chip')).toHaveCount(0);
  await expect(composer).toHaveAttribute('data-dirty', 'false');
  await expect(composer.locator('.save-state')).toHaveText('');

  // Readable again, in Dutch: one file of two is attached, and the other is named.
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await expect(composer.locator('[data-c="send"]')).toContainText('Verzenden');
  await win.evaluate(() => {
    const read = window.__arrayBuffer;
    File.prototype.arrayBuffer = function () {
      return this.name === 'kapot.txt' ? Promise.reject(new DOMException('weg', 'NotReadableError')) : read.call(this);
    };
  });
  await dropFiles(win, [{ name: 'notitie.txt', text: 'ok' }, { name: 'kapot.txt', text: 'gone' }]);
  await expect(composer.locator('.att-chip .n')).toHaveText(['notitie.txt']);
  await expect(win.locator('#toast')).toHaveText('kapot.txt kon niet worden gelezen en is niet bijgevoegd.');
  await expect(composer).toHaveAttribute('data-dirty', 'true');
});
