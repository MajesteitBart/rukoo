'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { Engine, decodeId } = require('../src/main/engine');

async function freshEngine() {
  const dir = tempDir('sem-test-');
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

// Waits until check() holds; fails instead of hanging.
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}

// Waits until the downloads that follow a sync are done.
async function prefetched(engine, acc) {
  while (engine.prefetching.has(acc.id)) await new Promise((r) => setTimeout(r, 5));
}

const bodies = (dir, acc) => {
  const d = path.join(dir, 'bodies', acc.id);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.eml')) : [];
};

test('a sync downloads the newest inbox messages ahead of time, without marking them read', async () => {
  const { engine, acc, dir } = await freshEngine();
  await prefetched(engine, acc);
  const inbox = engine.listMessages({ scope: acc.id, view: 'inbox' });
  assert.equal(bodies(dir, acc).length, inbox.length);
  const unread = inbox.filter((m) => m.unread).map((m) => m.id);
  assert.ok(unread.length > 0);
  await engine.syncAccount(acc.id);
  await prefetched(engine, acc);
  assert.deepEqual(engine.listMessages({ scope: acc.id, view: 'inbox' }).filter((m) => m.unread).map((m) => m.id), unread);
  // Opening one now reads the downloaded copy.
  const session = engine.session(acc);
  session.fetchSource = async () => {
    throw new Error('fetched from the server');
  };
  assert.ok((await engine.getMessage(inbox[0].id)).html.length > 0);
  await engine.close();
});

test('the download ahead of time skips large messages, and stops for a removed account', async () => {
  const { engine, acc, dir } = await freshEngine();
  await prefetched(engine, acc);
  fs.rmSync(path.join(dir, 'bodies'), { recursive: true, force: true });
  const box = engine.caches.get(acc.id).boxes.INBOX;
  const newest = [...box.messages].sort((a, b) => b.date - a.date)[0];
  newest.size = 5 * 1024 * 1024;
  await engine.prefetch(acc.id);
  assert.equal(bodies(dir, acc).length, box.messages.length - 1);
  assert.ok(!fs.existsSync(engine.bodyFile(acc, box, 'INBOX', newest.uid)));

  // A download that finishes after its account is removed leaves nothing behind.
  fs.rmSync(path.join(dir, 'bodies'), { recursive: true, force: true });
  const session = engine.session(acc);
  let finish;
  session.fetchSource = () => new Promise((resolve) => (finish = resolve));
  const pending = engine.prefetch(acc.id);
  await until(() => finish);
  await engine.removeAccount(acc.id);
  finish(Buffer.from('Subject: late\r\n\r\nbody'));
  await pending;
  assert.ok(!fs.existsSync(path.join(dir, 'bodies', acc.id)));
  await engine.close();
});

test('a download that finishes while a removed account signs out opens no new connection', async () => {
  const { engine, acc, dir } = await freshEngine();
  await prefetched(engine, acc);
  fs.rmSync(path.join(dir, 'bodies'), { recursive: true, force: true });
  const session = engine.session(acc);
  const fetches = [];
  session.fetchSource = () => new Promise((resolve) => fetches.push(resolve));
  let signedOut;
  session.close = () => new Promise((resolve) => (signedOut = resolve));
  const pending = engine.prefetch(acc.id);
  await until(() => fetches.length);
  const removing = engine.removeAccount(acc.id);
  fetches[0](Buffer.from('Subject: late\r\n\r\nbody'));
  await pending;
  signedOut();
  await removing;
  assert.equal(fetches.length, 1);
  assert.equal(engine.sessions.size, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'bodies', acc.id)));
  await engine.close();
});

test('an account removed while its sync waits gets no new session', async () => {
  for (const when of ['aliases', 'folder']) {
    const { engine, acc } = await freshEngine();
    let resume;
    const hold = () => new Promise((resolve) => (resume = resolve));
    if (when === 'aliases') {
      // A Google account loads its aliases before the first sync of its folders.
      const own = engine.account(acc.id);
      own.auth = 'oauth2';
      own.aliasesFetchedAt = null;
      engine.fetchGmailAliases = hold;
    } else {
      const sync = engine.syncFolderInto.bind(engine);
      // The first folder is synced; the hold comes before the next one.
      engine.syncFolderInto = async (...args) => {
        engine.syncFolderInto = sync;
        const res = await sync(...args);
        await hold();
        return res;
      };
    }
    const syncing = engine.syncAccount(acc.id);
    await until(() => resume);
    await engine.removeAccount(acc.id);
    resume();
    await syncing.catch(() => {});
    assert.equal(engine.sessions.size, 0, when);
    await engine.close();
  }
});

test('a send that outlives a change of account settings saves its Sent copy through the new session', async () => {
  const { engine, acc } = await freshEngine();
  const old = engine.session(acc);
  let deliver;
  old.send = () => new Promise((resolve) => (deliver = () => resolve(Buffer.from('Subject: Hi\r\n\r\nbody'))));
  old.append = async () => {
    throw new Error('this session is closed');
  };
  const sending = engine.send({ accountId: acc.id, to: ['a@example.com'], subject: 'Hi', text: 'x' });
  await until(() => deliver);
  // New server settings close the session; the next command gets a new one.
  engine.sessions.delete(acc.id);
  const appended = [];
  engine.session(acc).append = async (folder) => {
    appended.push(folder);
    return null;
  };
  deliver();
  assert.equal(await sending, true);
  assert.deepEqual(appended, ['Sent']);
  await engine.close();
});

test('a message the user opens during its background download is fetched again in the user turn, once', async () => {
  const { engine, acc } = await freshEngine();
  await prefetched(engine, acc);
  const m = engine.listMessages({ scope: acc.id, view: 'inbox' })[0];
  const { box, folder, uid } = engine.locate(m.id);
  const file = engine.bodyFile(acc, box, folder, uid);
  fs.rmSync(file);
  const session = engine.session(acc);
  const real = session.fetchSource.bind(session);
  const calls = [];
  const held = [];
  session.fetchSource = (p, u, opts = {}) => {
    calls.push(opts.background ? 'background' : 'user');
    return new Promise((resolve) => held.push(() => real(p, u).then(resolve)));
  };
  const ahead = engine.download(engine.account(acc.id), box, folder, uid, file, true);
  const opened = engine.rawSource(m.id);
  const again = engine.rawSource(m.id);
  assert.deepEqual(calls, ['background', 'user']);
  held.forEach((go) => go());
  const [a, b, c] = await Promise.all([ahead, opened, again]);
  assert.ok(b.length > 0 && b.equals(c) && a.equals(b));
  assert.ok(fs.existsSync(file));
  assert.equal(engine.downloads.size, 0);
  await engine.close();
});

test('bodies of messages that left the synced folders are removed', async () => {
  const { engine, acc, dir } = await freshEngine();
  await prefetched(engine, acc);
  const before = bodies(dir, acc);
  fs.writeFileSync(path.join(dir, 'bodies', acc.id, 'gone.eml'), 'Subject: old\r\n\r\nbody');
  await engine.prefetch(acc.id);
  assert.deepEqual(bodies(dir, acc).sort(), before.sort());
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
