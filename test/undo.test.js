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

test('emptying a folder counts the emails deleted, moved to Trash, kept and unknown apart', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const trash = engine.folderByRole(acc.id, 'trash');
  const total = view(engine, acc, 'trash').length;
  assert.ok(total > 0);
  const none = { stayed: null, unsure: null };
  demo.box(trash.path).readOnly = true;
  assert.deepEqual(await engine.emptyFolder(acc.id, trash.path), {
    total,
    trashed: 0,
    deleted: 0,
    stayed: total,
    unsure: 0,
    reasons: { ...none, stayed: t('errors.delete.refused') }
  });
  assert.equal(view(engine, acc, 'trash').length, total);
  demo.box(trash.path).readOnly = false;
  assert.deepEqual(await engine.emptyFolder(acc.id, trash.path), { total, trashed: 0, deleted: total, stayed: 0, unsure: 0, reasons: none });
  assert.equal(view(engine, acc, 'trash').length, 0);

  // Emptying any other folder moves to Trash: here one email goes, one is refused, and one's result isn't known.
  const archive = engine.folderByRole(acc.id, 'archive') || { path: 'Archive' };
  for (const m of inbox(engine, acc).slice(0, 3)) await engine.archive(m.id);
  await engine.syncAccount(acc.id);
  const archived = engine.listMessages({ scope: acc.id, view: 'folder', folder: archive.path });
  assert.ok(archived.length >= 3);
  const [b, c] = archived;
  const uidOf = (m) => Number(decodeURIComponent(m.id.split(':')[2]));
  const move = demo.move.bind(demo);
  demo.move = async (p, uid, ...rest) => {
    if (uid === uidOf(b)) throw Object.assign(new Error(t('errors.move.refused')), { refused: true });
    if (uid === uidOf(c)) throw Object.assign(new Error(t('errors.move.unknown')), { unknown: true });
    return move(p, uid, ...rest);
  };
  assert.deepEqual(await engine.emptyFolder(acc.id, archive.path), {
    total: archived.length,
    trashed: archived.length - 2,
    deleted: 0,
    stayed: 1,
    unsure: 1,
    reasons: { stayed: t('errors.move.refused'), unsure: t('errors.move.unknown') }
  });
  await engine.close();
});

// #308 review: a move or delete whose result nobody knows reaches the window with code 'uncertain', which the message
// list counts apart from an email that stayed; a refusal has no code.
test('an unknown result reaches the window as uncertain, a refusal without a code', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const [a, b] = inbox(engine, acc);
  demo.box('Archive').readOnly = true;
  await assert.rejects(engine.archive(a.id), (err) => err.message === t('errors.move.refused') && err.code === undefined);
  demo.box('Archive').readOnly = false;
  demo.move = async () => {
    throw Object.assign(new Error(t('errors.move.unknown')), { unknown: true });
  };
  await assert.rejects(engine.archive(b.id), { message: t('errors.move.unknown'), code: 'uncertain' });
  demo.move = async () => {
    throw Object.assign(new Error(t('errors.move.copied')), { copied: true });
  };
  await assert.rejects(engine.remove(b.id), { message: t('errors.move.copied'), code: 'uncertain' });
  const trashed = view(engine, acc, 'trash')[0];
  demo.deleteForever = async () => {
    throw Object.assign(new Error(t('errors.delete.unknown')), { unknown: true });
  };
  await assert.rejects(engine.remove(trashed.id), { message: t('errors.delete.unknown'), code: 'uncertain' });
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
    throw Object.assign(new Error(t('errors.move.unknown')), { unknown: true });
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
  await assert.rejects(engine.archive(target.id), { message: t('errors.move.unknown'), code: 'uncertain' });
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
    throw Object.assign(new Error(t('errors.move.unknown')), { unknown: true });
  };
  await assert.rejects(engine.undoMove(target.id), { message: t('errors.move.unknown'), code: 'uncertain' });
  assert.ok(!engine.canUndo(target.id));
  await engine.close();
});

// #308 review: Undo while the sync that follows the move is still running. The sync comes back while Undo holds the
// email's row out of Archive, so the row isn't in the cache when the server refuses the Undo. It has to come back
// anyway: the email is in Archive.
async function undoDuringSync({ rebuilt = false } = {}) {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  const syncFolder = demo.syncFolder.bind(demo);
  let syncGo;
  const syncGate = new Promise((r) => (syncGo = r));
  let synced;
  const archiveSynced = new Promise((r) => (synced = r));
  const asked = [];
  demo.syncFolder = async (p, ...rest) => {
    asked.push(p);
    if (p !== 'Archive' || asked.filter((x) => x === 'Archive').length > 1) return syncFolder(p, ...rest);
    await syncGate;
    const res = await syncFolder(p, ...rest);
    setImmediate(synced);
    return res;
  };
  await engine.archive(target.id);
  assert.deepEqual(asked, ['Archive'], 'the sync after the move is waiting');

  let moveGo;
  const moveGate = new Promise((r) => (moveGo = r));
  demo.move = async () => {
    await moveGate;
    throw Object.assign(new Error(t('errors.move.refused')), { refused: true });
  };
  const undo = engine.undoMove(target.id);
  // The sync comes back while Undo waits for the server.
  syncGo();
  await archiveSynced;
  assert.ok(!view(engine, acc, 'archive').some((m) => m.subject === target.subject), 'held out while Undo runs');
  if (rebuilt) engine.caches.get(acc.id).boxes.Archive.uidValidity = 'rebuilt';
  moveGo();
  await assert.rejects(undo, { message: t('errors.move.refused') });
  return { engine, acc, target, asked };
}

test('a refused Undo during the sync that followed the move brings the row back in the destination', async () => {
  const { engine, acc, target, asked } = await undoDuringSync();
  assert.ok(view(engine, acc, 'archive').some((m) => m.subject === target.subject), 'the archive row is back');
  assert.deepEqual(asked, ['Archive'], 'from the move, without another sync');
  assert.ok(!inbox(engine, acc).some((m) => m.subject === target.subject));
  assert.ok(engine.canUndo(target.id), 'Undo is kept for another try');
  await engine.close();
});

test('a refused Undo resyncs the destination when its UIDVALIDITY changed since the move', async () => {
  const { engine, acc, target, asked } = await undoDuringSync({ rebuilt: true });
  assert.deepEqual(asked, ['Archive', 'Archive'], 'a second sync of Archive');
  await until(() => view(engine, acc, 'archive').some((m) => m.subject === target.subject));
  await engine.close();
});

// #308 follow-up, finding 3: an Undo that failed without proof that the email is still where it was moved. Here another
// app moved it on from Archive, a sync showed Archive without it (same UIDVALIDITY), and then Undo's SELECT failed, so
// Undo sent nothing. Rukoo mustn't make up a row for it or offer Undo again; a sync shows where things are.
test('an Undo that failed without a confirmed refusal puts no row back, offers no Undo again, and syncs', async () => {
  for (const error of [Object.assign(new Error('Connection lost'), { unsent: true }), new Error('Something else went wrong')]) {
    const { engine, acc } = await freshEngine();
    const demo = engine.session(engine.account(acc.id));
    const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
    await engine.archive(target.id);
    await until(() => view(engine, acc, 'archive').some((m) => m.subject === target.subject));
    // Another app moves it from Archive to Travel, and Archive syncs.
    const archive = demo.box('Archive');
    const gone = archive.messages.find((m) => m.subject === target.subject);
    archive.messages = archive.messages.filter((m) => m !== gone);
    demo.box('Travel').messages.push(gone);
    await engine.syncFolderAndNotify(engine.account(acc.id), 'Archive');
    assert.ok(!view(engine, acc, 'archive').some((m) => m.subject === target.subject));

    const syncFolder = demo.syncFolder.bind(demo);
    const asked = [];
    let go;
    const gate = new Promise((r) => (go = r));
    demo.syncFolder = async (p, ...rest) => {
      asked.push(p);
      await gate;
      return syncFolder(p, ...rest);
    };
    demo.move = async () => {
      throw error;
    };
    await assert.rejects(engine.undoMove(target.id), (err) => err.message === error.message);
    assert.ok(!view(engine, acc, 'archive').some((m) => m.subject === target.subject), `no row made up (${error.message})`);
    assert.ok(!engine.canUndo(target.id), `no Undo again (${error.message})`);
    assert.ok(asked.includes('Archive'), 'Archive syncs');
    go();
    await engine.close();
  }
});

// #308 follow-up, finding 4: a move whose result is unknown syncs both folders, a destination the cache doesn't hold
// yet included, so a copy left there shows.
test('a move whose result is unknown syncs a destination the cache has never opened', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  assert.ok(!engine.caches.get(acc.id).boxes.Travel);
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  // The server made the copy and never answered.
  demo.move = async (p, uid, destination) => {
    demo.box(destination).messages.push({ ...demo.find(p, uid), uid: demo.state.nextUid++ });
    demo.persist();
    throw Object.assign(new Error(t('errors.move.unknown')), { unknown: true });
  };
  await assert.rejects(engine.move(target.id, 'Travel'), { code: 'uncertain' });
  await until(() => engine.listMessages({ scope: acc.id, view: 'folder', folder: 'Travel' }).some((m) => m.subject === target.subject));
  assert.ok(inbox(engine, acc).some((m) => m.subject === target.subject));
  await engine.close();
});

// #308 follow-up, finding 5: an Undo whose folder was rebuilt can't say where the email is by its old uid. The window
// counts it as not confirmed (code 'rebuilt') and gives the reason; it isn't offered again.
test('an Undo whose folder was rebuilt counts as not confirmed, with the reason, next to one that went', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const [a, b] = inbox(engine, acc);
  const [archived] = await engine.moveMany([a.id], 'Archive');
  const [trashed] = await engine.removeMany([b.id]);
  assert.deepEqual([archived, trashed], [{ id: a.id }, { id: b.id, where: 'trash' }]);
  demo.box('Archive').uidValidity = 'rebuilt';
  const answers = await engine.undoMany([a.id, b.id]);
  assert.deepEqual(answers[0], { id: a.id, error: t('errors.undo.rebuilt'), code: 'rebuilt' });
  assert.ok(answers[1].restored && !answers[1].error);
  assert.ok(!engine.canUndo(a.id));
  await assert.rejects(engine.undoMove(a.id), { message: t('errors.undo.expired') });
  await engine.close();
});

test('a single Undo whose folder was rebuilt reaches the window with code rebuilt and its reason', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const target = inbox(engine, acc).find((m) => m.subject === 'Sign in to Bencompare');
  await engine.archive(target.id);
  demo.box('Archive').uidValidity = 'rebuilt';
  await assert.rejects(engine.undoMove(target.id), { message: t('errors.undo.rebuilt'), code: 'rebuilt' });
  assert.ok(!engine.canUndo(target.id));
  await engine.close();
});

// #308 follow-up, finding 6: a batch goes to the account's session once per folder, so its checks cost a round trip
// per batch (test/imap.test.js counts the commands), and each email still gets its own outcome.
test('moving, deleting and undoing many emails is one call to the server per folder, with an outcome per email', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const calls = [];
  for (const name of ['moveMany', 'deleteMany']) {
    const real = demo[name].bind(demo);
    demo[name] = async (p, uids, ...rest) => {
      calls.push(`${name} ${p} ${uids.length}`);
      return real(p, uids, ...rest);
    };
  }
  const list = inbox(engine, acc);
  const ids = list.slice(0, 4).map((m) => m.id);
  // One of them the server turns down; it alone comes back.
  const refusedUid = list[1].uid;
  const move = demo.move.bind(demo);
  demo.move = async (p, uid, ...rest) => {
    if (p === 'INBOX' && uid === refusedUid) throw Object.assign(new Error(t('errors.move.refused')), { refused: true });
    return move(p, uid, ...rest);
  };
  const moved = await engine.moveMany(ids, 'Archive');
  assert.deepEqual(calls, ['moveMany INBOX 4']);
  assert.deepEqual(moved.map((r) => r.error || null), [null, t('errors.move.refused'), null, null]);
  assert.ok(inbox(engine, acc).some((m) => m.id === ids[1]));
  assert.deepEqual(ids.map((id) => engine.canUndo(id)), [true, false, true, true]);

  calls.length = 0;
  const undone = await engine.undoMany([ids[0], ids[2], ids[3]]);
  assert.deepEqual(calls, ['moveMany Archive 3']);
  assert.ok(undone.every((r) => r.restored));

  calls.length = 0;
  const trash = view(engine, acc, 'trash').map((m) => m.id);
  const result = await engine.emptyFolder(acc.id, 'Trash');
  assert.deepEqual(calls, [`deleteMany Trash ${trash.length}`]);
  assert.equal(result.deleted, trash.length);
  await engine.close();
});

// Settles with p, or fails after ms: a batch that waits for itself never settles.
async function within(p, ms = 3000) {
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('the batch never settled')), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

// #308 round 4, finding 1: Remove of a selection with an email in Inbox and one in Trash. The move to Trash goes first,
// and while it runs the server rebuilds Trash, where the selected email's uid now names another email. The delete for
// good goes for the email that was selected, in the generation it was selected in: nothing is deleted, and Trash syncs.
test('a bulk Remove deletes for good only the email it looked up, also when Trash is rebuilt during the move to Trash', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const a = inbox(engine, acc)[0];
  const selected = view(engine, acc, 'trash')[0];
  const move = demo.move.bind(demo);
  demo.move = async (...args) => {
    const trash = demo.box('Trash');
    trash.uidValidity = 'rebuilt';
    trash.messages = trash.messages.map((m) => (m.uid === selected.uid ? { ...m, subject: 'Replacement', messageId: '<replacement@example.com>' } : m));
    demo.persist();
    await engine.syncFolderAndNotify(engine.account(acc.id), 'Trash');
    return move(...args);
  };
  const answers = await within(engine.removeMany([a.id, selected.id]));
  assert.equal(answers[0].where, 'trash');
  assert.ok(answers[1].error && !answers[1].where, `not reported deleted: ${JSON.stringify(answers[1])}`);
  assert.ok(demo.box('Trash').messages.some((m) => m.subject === 'Replacement'), 'the email that has the uid now is still there');
  await until(() => view(engine, acc, 'trash').some((m) => m.subject === 'Replacement'));
  await engine.close();
});

// #308 round 4, finding 1, the same shape after a send: the draft is looked up when the send begins. Drafts rebuilt
// while the email goes out gives its uid to another draft, which stays.
test('sending a draft discards that draft only, also when Drafts is rebuilt while the email goes out', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const draft = view(engine, acc, 'drafts')[0];
  const send = demo.send.bind(demo);
  demo.send = async (mail) => {
    const drafts = demo.box('Drafts');
    drafts.uidValidity = 'rebuilt';
    drafts.messages = drafts.messages.map((m) => (m.uid === draft.uid ? { ...m, subject: 'Another draft', messageId: '<another-draft@example.com>' } : m));
    demo.persist();
    await engine.syncFolderAndNotify(engine.account(acc.id), 'Drafts');
    return send(mail);
  };
  await engine.send({ accountId: acc.id, to: ['a@example.com'], subject: 'Hi', text: 'x', draftId: draft.id });
  assert.ok(demo.box('Drafts').messages.some((m) => m.subject === 'Another draft'), 'the other draft stays');
  await engine.close();
});

// #308 round 4, finding 6: an email given twice in one batch goes to the server once, and both get its result.
test('an email given twice in one batch is acted on once, and both get its result', async () => {
  const { engine, acc } = await freshEngine();
  const demo = engine.session(engine.account(acc.id));
  const [a, b] = inbox(engine, acc);
  const calls = [];
  for (const name of ['move', 'deleteForever']) {
    const real = demo[name].bind(demo);
    demo[name] = async (p, uid, ...rest) => {
      calls.push(`${name} ${p} ${uid}`);
      return real(p, uid, ...rest);
    };
  }
  const removed = await within(engine.removeMany([a.id, b.id, a.id]));
  assert.deepEqual(removed, [{ id: a.id, where: 'trash' }, { id: b.id, where: 'trash' }, { id: a.id, where: 'trash' }]);
  assert.equal(calls.length, 2);

  const undone = await within(engine.undoMany([a.id, a.id]));
  assert.ok(undone[0].restored && undone[0].restored === undone[1].restored, JSON.stringify(undone));

  calls.length = 0;
  const trashed = view(engine, acc, 'trash')[0];
  const gone = await within(engine.removeMany([trashed.id, trashed.id]));
  assert.deepEqual(gone, [{ id: trashed.id, where: 'deleted' }, { id: trashed.id, where: 'deleted' }]);
  assert.equal(calls.length, 1);
  await engine.close();
});
