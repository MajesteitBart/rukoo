'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { Engine } = require('../src/main/engine');
const { t } = require('../src/i18n');

async function freshEngine() {
  const dir = tempDir('sem-test-');
  const engine = new Engine({ dataDir: dir }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  return { engine, acc, dir };
}

const inbox = (engine, acc) => engine.listMessages({ scope: acc.id, view: 'inbox' });
const view = (engine, acc, name) => engine.listMessages({ scope: acc.id, view: name });

// Waits until check() holds; fails instead of hanging.
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}

test('a delete can be undone and the message keeps its flags', async () => {
  const { engine, acc } = await freshEngine();
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  await engine.setFlags(target.id, { starred: true });
  assert.equal(await engine.remove(target.id), 'trash');
  assert.ok(engine.canUndo(target.id));
  assert.ok(!inbox(engine, acc).some((m) => m.subject === target.subject));

  const newMail = [];
  engine.on('new-mail', (list) => newMail.push(...list));
  const restoredId = await engine.undoMove(target.id);
  const back = inbox(engine, acc).find((m) => m.id === restoredId);
  assert.ok(back, 'message is back in the inbox');
  assert.equal(back.starred, true);
  await engine.syncAccount(acc.id);
  assert.equal(inbox(engine, acc).filter((m) => m.subject === target.subject).length, 1);
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'trash' }).some((m) => m.subject === target.subject));
  assert.equal(newMail.length, 0, 'a restored message is not reported as new mail');
  await assert.rejects(engine.undoMove(target.id), /no longer be undone/);
  await engine.close();
});

test('archive moves to the archive folder and can be undone', async () => {
  const { engine, acc } = await freshEngine();
  assert.equal(engine.state().accounts[0].archive, 'Archive');
  const target = inbox(engine, acc)[0];
  await engine.archive(target.id);
  await engine.syncAccount(acc.id);
  assert.ok(engine.listMessages({ scope: acc.id, view: 'archive' }).some((m) => m.subject === target.subject));
  await engine.undoMove(target.id);
  await engine.syncAccount(acc.id);
  assert.ok(inbox(engine, acc).some((m) => m.subject === target.subject));
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'archive' }).some((m) => m.subject === target.subject));
  await engine.close();
});

test('searching everything covers all synced folders', async () => {
  const { engine, acc } = await freshEngine();
  const sent = engine.listMessages({ scope: acc.id, view: 'sent' })[0];
  const word = sent.subject.split(' ').find((w) => w.length > 4);
  assert.ok(!inbox(engine, acc).some((m) => m.id === sent.id));
  const hits = engine.listMessages({ scope: acc.id, view: 'everything', query: word });
  assert.ok(hits.some((m) => m.id === sent.id), 'finds the sent message');
  assert.ok(engine.listMessages({ scope: 'all', view: 'everything' }).length > inbox(engine, acc).length);
  await engine.close();
});

test('the old default signature is dropped, a custom one is kept', () => {
  const dir = tempDir('sem-test-');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ signature: 'Verzonden vanaf mijn pc' }));
  assert.equal(new Engine({ dataDir: dir }).init().settings.signature, '');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ signature: 'Groet, Bart' }));
  assert.equal(new Engine({ dataDir: dir }).init().settings.signature, 'Groet, Bart');
  assert.equal(new Engine({ dataDir: tempDir('sem-test-') }).init().settings.signature, '');
});

test('undo refuses a mailbox whose uids were reassigned and moves nothing', async () => {
  const { engine, acc } = await freshEngine();
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  await engine.remove(target.id);
  // The server rebuilt Prullenbak: same uids, different messages.
  const demo = engine.session(engine.account(acc.id));
  demo.box('Trash').uidValidity = '99';
  demo.persist();
  const before = inbox(engine, acc).length;
  await assert.rejects(engine.undoMove(target.id), /rebuilt/);
  await engine.syncAccount(acc.id);
  assert.equal(inbox(engine, acc).length, before);
  assert.ok(engine.listMessages({ scope: acc.id, view: 'trash' }).some((m) => m.subject === target.subject));
  assert.ok(!engine.canUndo(target.id));
  await engine.close();
});

test('a sync that sees new uids in the destination forgets the undo', async () => {
  const { engine, acc } = await freshEngine();
  const target = inbox(engine, acc)[0];
  await engine.remove(target.id);
  assert.ok(engine.canUndo(target.id));
  const demo = engine.session(engine.account(acc.id));
  demo.box('Trash').uidValidity = '77';
  demo.persist();
  await engine.syncAccount(acc.id);
  assert.ok(!engine.canUndo(target.id));
  await engine.close();
});

test('the signature cleanup runs once; setting it again later sticks', () => {
  const dir = tempDir('sem-test-');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ signature: 'Verzonden vanaf mijn pc' }));
  const first = new Engine({ dataDir: dir }).init();
  assert.equal(first.settings.signature, '');
  first.updateSettings({ signature: 'Verzonden vanaf mijn pc' });
  assert.equal(new Engine({ dataDir: dir }).init().settings.signature, 'Verzonden vanaf mijn pc');
});

test("Gmail's All Mail serves as the archive, without showing mail twice", async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  // Gmail: no archive folder, but [Gmail]/All Mail with the \All flag.
  const list = demo.listFolders.bind(demo);
  demo.listFolders = async () => (await list()).map((f) => (f.role === 'archive' ? { ...f, path: f.path, name: 'All Mail', role: 'all' } : f));
  // All Mail also holds a copy of an inbox message.
  const copy = { ...demo.box('INBOX').messages[0], uid: demo.state.nextUid++ };
  demo.box('Archive').messages.push(copy);
  demo.persist();
  await engine.syncAccount(acc.id);

  const pub = engine.state().accounts[0];
  assert.equal(pub.archive, 'Archive');
  assert.deepEqual(pub.folders.find((f) => f.path === 'Archive'), { path: 'Archive', name: 'Archive', role: 'archive' });
  const everything = () => engine.listMessages({ scope: acc.id, view: 'everything' });
  assert.equal(everything().filter((m) => m.subject === copy.subject).length, 1, 'the All Mail copy is hidden');
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'archive' }).some((m) => m.subject === copy.subject));

  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  await engine.archive(target.id);
  await engine.syncAccount(acc.id);
  assert.ok(engine.listMessages({ scope: acc.id, view: 'archive' }).some((m) => m.subject === target.subject));
  assert.ok(everything().some((m) => m.subject === target.subject), 'archived mail can be found');
  await engine.undoMove(target.id);
  await engine.syncAccount(acc.id);
  assert.ok(inbox(engine, acc).some((m) => m.subject === target.subject));
  await engine.close();
});

test('a draft saved on a server without UIDPLUS can still be found and replaced', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const append = demo.append.bind(demo);
  demo.append = async (...args) => {
    await append(...args);
    return null;
  };
  const first = await engine.saveDraft({ accountId: acc.id, to: ['a@example.com'], subject: 'Without a UID', html: '<p>1</p>' });
  assert.ok(first, 'the draft gets an id anyway');
  const second = await engine.saveDraft({ accountId: acc.id, to: ['a@example.com'], subject: 'Without a UID', html: '<p>2</p>', draftId: first });
  assert.ok(second && second !== first);
  assert.equal(engine.listMessages({ scope: acc.id, view: 'drafts' }).filter((m) => m.subject === 'Without a UID').length, 1);
  await engine.close();
});

test('archived Gmail mail that also has a label stays in the archive, and shows once in search', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const list = demo.listFolders.bind(demo);
  demo.listFolders = async () => (await list()).map((f) => (f.role === 'archive' ? { ...f, name: 'All Mail', role: 'all' } : f));
  await engine.syncAccount(acc.id);
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  await engine.archive(target.id);
  // The same message also carries a user label (a cached user folder).
  const archived = demo.box('Archive').messages.find((m) => m.subject === target.subject);
  demo.box('Invoices').messages.push({ ...archived, uid: demo.state.nextUid++ });
  demo.persist();
  await engine.openFolder(acc.id, 'Invoices');
  await engine.syncAccount(acc.id);
  assert.ok(engine.listMessages({ scope: acc.id, view: 'archive' }).some((m) => m.subject === target.subject));
  assert.equal(engine.listMessages({ scope: acc.id, view: 'everything' }).filter((m) => m.subject === target.subject).length, 1);
  await engine.close();
});

// #308: imapflow answers false for a MOVE or EXPUNGE the server turns down, which used to pass as success: the email
// left the list until the next sync brought it back. ImapAccount throws now; the demo refuses for a folder marked
// readOnly, as a server does a shared folder you may only read.
test('a refused move puts the email back at once and says why, and trying again later goes through', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  demo.box('Archive').readOnly = true;
  await assert.rejects(engine.archive(target.id), { message: t('errors.move.refused') });
  const back = inbox(engine, acc).find((m) => m.id === target.id);
  assert.ok(back, 'the same row, with the same id');
  assert.equal(back.unread, target.unread);
  assert.ok(!engine.canUndo(target.id));
  assert.ok(demo.box('INBOX').messages.some((m) => m.uid === target.uid));
  // Deleting moves to Trash, which the server can refuse the same way.
  demo.box('Trash').readOnly = true;
  await assert.rejects(engine.remove(target.id), { message: t('errors.move.refused') });
  assert.ok(inbox(engine, acc).some((m) => m.id === target.id));

  demo.box('Archive').readOnly = false;
  await engine.archive(target.id);
  assert.ok(!inbox(engine, acc).some((m) => m.subject === target.subject));
  await engine.syncAccount(acc.id);
  assert.equal(view(engine, acc, 'archive').filter((m) => m.subject === target.subject).length, 1);
  assert.ok(engine.canUndo(target.id));
  await engine.close();
});

test('a refused Undo leaves the email where it was moved, with its row there, and Undo can be tried again', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  await engine.archive(target.id);
  await until(() => view(engine, acc, 'archive').some((m) => m.subject === target.subject));
  const archived = view(engine, acc, 'archive').find((m) => m.subject === target.subject);

  demo.box('Archive').readOnly = true;
  await assert.rejects(engine.undoMove(target.id), { message: t('errors.move.refused') });
  assert.ok(view(engine, acc, 'archive').some((m) => m.id === archived.id), 'the archive row is back');
  assert.ok(!inbox(engine, acc).some((m) => m.subject === target.subject));
  assert.ok(engine.canUndo(target.id), 'Undo is kept for another try');

  demo.box('Archive').readOnly = false;
  const restored = await engine.undoMove(target.id);
  assert.ok(inbox(engine, acc).some((m) => m.id === restored && m.subject === target.subject));
  await engine.syncAccount(acc.id);
  assert.ok(!view(engine, acc, 'archive').some((m) => m.subject === target.subject));
  assert.equal(inbox(engine, acc).filter((m) => m.subject === target.subject).length, 1);
  assert.ok(!engine.canUndo(target.id));
  await engine.close();
});

test('a refused delete for good keeps the email in Trash, and a refused draft discard keeps the draft', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const trashed = view(engine, acc, 'trash')[0];
  demo.box('Trash').readOnly = true;
  await assert.rejects(engine.remove(trashed.id), { message: t('errors.delete.refused') });
  assert.ok(view(engine, acc, 'trash').some((m) => m.id === trashed.id));
  demo.box('Trash').readOnly = false;
  assert.equal(await engine.remove(trashed.id), 'deleted');
  assert.ok(!view(engine, acc, 'trash').some((m) => m.id === trashed.id));

  const draft = view(engine, acc, 'drafts')[0];
  demo.box('Drafts').readOnly = true;
  await assert.rejects(engine.discardDraft(draft.id), { message: t('errors.delete.refused') });
  assert.ok(view(engine, acc, 'drafts').some((m) => m.id === draft.id));
  await engine.close();
});

test('emptying a folder says how many emails the server deleted and why the rest stayed', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const trash = engine.folderByRole(acc.id, 'trash');
  const total = view(engine, acc, 'trash').length;
  assert.ok(total > 0);
  demo.box(trash.path).readOnly = true;
  assert.deepEqual(await engine.emptyFolder(acc.id, trash.path), { count: 0, total, error: t('errors.delete.refused') });
  assert.equal(view(engine, acc, 'trash').length, total);
  demo.box(trash.path).readOnly = false;
  assert.deepEqual(await engine.emptyFolder(acc.id, trash.path), { count: total, total, error: null });
  assert.equal(view(engine, acc, 'trash').length, 0);
  await engine.close();
});

test('a move that left a copy behind keeps the original, offers no Undo, and syncs the copy into view', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  // A server without MOVE copied it and then didn't confirm removing it from Inbox.
  demo.move = async (p, uid, destination) => {
    const m = demo.find(p, uid);
    demo.box(destination).messages.push({ ...m, uid: demo.state.nextUid++ });
    demo.persist();
    throw Object.assign(new Error(t('errors.move.copied')), { copied: true });
  };
  await assert.rejects(engine.archive(target.id), { message: t('errors.move.copied') });
  assert.ok(inbox(engine, acc).some((m) => m.id === target.id));
  assert.ok(!engine.canUndo(target.id));
  await until(() => view(engine, acc, 'archive').some((m) => m.subject === target.subject));
  assert.ok(inbox(engine, acc).some((m) => m.id === target.id));
  await engine.close();
});

test('a move whose connection went before the answer puts the email back, then a sync shows where it is', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  const move = demo.move.bind(demo);
  // The server moved it; the answer never came.
  demo.move = async (...args) => {
    await move(...args);
    throw Object.assign(new Error(t('errors.connection.closed')), { unknown: true });
  };
  // The syncs that follow wait until the test has looked.
  const syncFolder = demo.syncFolder.bind(demo);
  let go;
  const gate = new Promise((r) => (go = r));
  const asked = [];
  demo.syncFolder = async (p, ...rest) => {
    asked.push(p);
    await gate;
    return syncFolder(p, ...rest);
  };
  await assert.rejects(engine.archive(target.id), { message: t('errors.connection.closed') });
  assert.ok(inbox(engine, acc).some((m) => m.id === target.id), 'back at once, as nothing is known');
  assert.deepEqual(asked.sort(), ['Archive', 'INBOX']);
  go();
  await until(() => !inbox(engine, acc).some((m) => m.subject === target.subject) && view(engine, acc, 'archive').some((m) => m.subject === target.subject));
  await engine.close();
});

test('an Undo that left a copy in the old folder is not offered again', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  await engine.archive(target.id);
  demo.move = async () => {
    throw Object.assign(new Error(t('errors.move.copied')), { copied: true });
  };
  await assert.rejects(engine.undoMove(target.id), { message: t('errors.move.copied') });
  assert.ok(!engine.canUndo(target.id));
  await engine.close();
});

test('an Undo whose result is unknown is not offered again before the folders are reconciled', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  await engine.archive(target.id);
  demo.move = async () => {
    throw Object.assign(new Error(t('errors.connection.closed')), { unknown: true });
  };
  await assert.rejects(engine.undoMove(target.id), { message: t('errors.connection.closed') });
  assert.ok(!engine.canUndo(target.id));
  await engine.close();
});
