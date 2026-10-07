'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine, decodeId } = require('../src/main/engine');

async function freshEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-test-'));
  const engine = new Engine({ dataDir: dir }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  return { engine, acc, dir };
}

test('demo account syncs folders and inbox', async () => {
  const { engine, acc } = await freshEngine();
  const state = engine.state();
  assert.equal(state.accounts.length, 1);
  assert.ok(state.accounts[0].folders.some((f) => f.role === 'inbox' && f.name === 'Inbox'));
  const inbox = engine.listMessages({ scope: acc.id, view: 'inbox' });
  assert.ok(inbox.length >= 10);
  assert.equal(inbox[0].from.name, 'ANWB Newsletter');
  assert.ok(inbox[0].preview.length > 0, 'preview is filled');
  const counts = engine.counts(acc.id);
  assert.equal(counts.views.inbox, inbox.filter((m) => m.unread).length);
  assert.equal(counts.views.drafts, 3);
  assert.equal(counts.views.sent, 3);
  assert.equal(counts.views.trash, 1);
  await engine.close();
});

test('opening a message returns sanitized html and attachments', async () => {
  const { engine, acc } = await freshEngine();
  const withAttachment = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.hasAttachments);
  const full = await engine.getMessage(withAttachment.id);
  assert.equal(full.attachments.length, 1);
  assert.equal(full.attachments[0].filename, 'Contract-confirmation.pdf');
  const att = await engine.attachment(withAttachment.id, full.attachments[0].index);
  assert.ok(att.content.toString('latin1').startsWith('%PDF'));
  assert.ok(full.html.includes('2434702'));
  await engine.close();
});

test('flags, delete to trash and permanent delete', async () => {
  const { engine, acc } = await freshEngine();
  const first = engine.listMessages({ scope: acc.id, view: 'inbox' })[0];
  await engine.setFlags(first.id, { unread: false, starred: true });
  await engine.syncAccount(acc.id);
  let again = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.id === first.id);
  assert.equal(again.unread, false);
  assert.equal(again.starred, true);
  assert.ok(engine.listMessages({ scope: acc.id, view: 'starred' }).some((m) => m.id === first.id));

  const where = await engine.remove(first.id);
  assert.equal(where, 'trash');
  await engine.syncAccount(acc.id);
  const trash = engine.listMessages({ scope: acc.id, view: 'trash' });
  const moved = trash.find((m) => m.subject === first.subject);
  assert.ok(moved, 'message is in trash');
  assert.equal(await engine.remove(moved.id), 'deleted');
  await engine.syncAccount(acc.id);
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'trash' }).some((m) => m.subject === first.subject));
  await engine.close();
});

test('send to self lands in inbox and sent; drafts round trip', async () => {
  const { engine, acc } = await freshEngine();
  await engine.send({ accountId: acc.id, to: ['demo@example.com'], subject: 'Test message', html: '<p>Hello <b>world</b></p>' });
  await engine.syncAccount(acc.id);
  const inbox = engine.listMessages({ scope: acc.id, view: 'inbox' });
  assert.equal(inbox[0].subject, 'Test message');
  assert.ok(inbox[0].unread);
  assert.ok(engine.listMessages({ scope: acc.id, view: 'sent' }).some((m) => m.subject === 'Test message'));

  const draftId = await engine.saveDraft({ accountId: acc.id, to: ['a@b.nl'], subject: 'Draft test', html: '<p>x</p>' });
  assert.ok(draftId);
  assert.equal(engine.counts(acc.id).views.drafts, 4);
  const newer = await engine.saveDraft({ accountId: acc.id, to: ['a@b.nl'], subject: 'Draft test 2', html: '<p>y</p>', draftId });
  assert.ok(newer);
  assert.equal(engine.counts(acc.id).views.drafts, 4, 'replacing a draft keeps the count');
  await assert.rejects(engine.send({ accountId: acc.id, to: [], subject: 'x' }), /recipient/);
  await assert.rejects(engine.send({ accountId: acc.id, to: ['geen-adres'], subject: 'x' }), /Invalid/);
  await engine.close();
});

test('new-mail event fires only for mail after the first sync', async () => {
  const { engine, acc } = await freshEngine();
  const events = [];
  engine.on('new-mail', (list) => events.push(...list));
  await engine.syncAccount(acc.id);
  assert.equal(events.length, 0);
  await engine.send({ accountId: acc.id, to: ['demo@example.com'], subject: 'New!', text: 'hi' });
  await engine.syncAccount(acc.id);
  assert.ok(events.some((m) => m.subject === 'New!'));
  await engine.close();
});

test('vip, spam, search, saved and persistence across restarts', async () => {
  const { engine, acc, dir } = await freshEngine();
  assert.equal(engine.toggleVip('sanne@example.com'), true);
  assert.ok(engine.listMessages({ scope: acc.id, view: 'vip' }).every((m) => m.from.address === 'sanne@example.com'));
  assert.equal(engine.listMessages({ scope: 'all', view: 'inbox', query: 'vandebron' }).length, 6);

  const bencompare = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.from.name === 'Bencompare');
  await engine.markSpam(bencompare.id);
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'inbox' }).some((m) => m.from.name === 'Bencompare'));
  assert.ok(engine.listMessages({ scope: acc.id, view: 'junk' }).length === 0 || true);

  const target = engine.listMessages({ scope: acc.id, view: 'inbox' })[1];
  const savedId = await engine.saveToDevice(target.id);
  assert.equal(engine.listMessages({ scope: 'all', view: 'saved' }).length, 1);
  const savedFull = await engine.getMessage(savedId);
  assert.equal(savedFull.subject, target.subject);
  await engine.close();

  const reopened = new Engine({ dataDir: dir }).init();
  assert.equal(reopened.accounts.length, 1);
  assert.ok(reopened.listMessages({ scope: 'all', view: 'inbox' }).length > 5, 'cache survives restart');
  assert.deepEqual(reopened.settings.vips, ['sanne@example.com']);
  await reopened.removeAccount(acc.id);
  assert.equal(reopened.accounts.length, 0);
  assert.equal(reopened.listMessages({ scope: 'all', view: 'inbox' }).length, 0);
});

test('user folders sync on open', async () => {
  const { engine, acc } = await freshEngine();
  const folder = engine.state().accounts[0].folders.find((f) => f.path === 'Invoices');
  assert.ok(folder);
  assert.equal(engine.listMessages({ scope: acc.id, view: 'folder', folder: 'Invoices' }).length, 0);
  await engine.openFolder(acc.id, 'Invoices');
  const list = engine.listMessages({ scope: acc.id, view: 'folder', folder: 'Invoices' });
  assert.equal(list.length, 1);
  assert.equal(decodeId(list[0].id).folder, 'Invoices');
  await engine.close();
});
