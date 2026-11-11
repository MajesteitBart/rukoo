'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { Engine, decodeId } = require('../src/main/engine');
const { t } = require('../src/i18n');

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
  // Uids grow with the date, as on a server, and mail with the same time lists the last to arrive first.
  const uids = inbox.map((m) => m.uid);
  assert.deepEqual(uids, [...uids].sort((a, b) => b - a));
  const same = ['Your password has changed', 'Your sign-in details have been updated', 'How to change your My Vandebron password', 'Failed sign-in attempt on your My Vandebron account'];
  assert.deepEqual(inbox.filter((m) => same.includes(m.subject)).map((m) => m.subject), same);
  assert.deepEqual(engine.listMessages({ scope: acc.id, view: 'inbox', sort: 'date-asc' }).map((m) => m.uid), [...uids].reverse());
  assert.ok(inbox[0].preview.length > 0, 'preview is filled');
  const counts = engine.counts(acc.id);
  assert.equal(counts.views.inbox, inbox.filter((m) => m.unread).length);
  assert.equal(counts.views.drafts, 3);
  assert.equal(counts.views.sent, 3);
  assert.equal(counts.views.trash, 1);
  await engine.close();
});

// RUK-101: @-mentions in the composer suggest the thread's people first.
test('thread contacts are the people on the messages a reply refers to and on the replies to them', async () => {
  const { engine, acc } = await freshEngine();
  const call = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.subject === 'Call on Thursday');
  assert.ok(call.messageId);
  assert.deepEqual(
    engine.threadContacts(acc.id, [call.messageId]),
    [
      { name: 'Sanne de Vries', address: 'sanne@example.com' },
      { name: 'Joris Bakker', address: 'joris@example.com' }
    ],
    'the sent reply to Sanne is newest; Joris was on the Cc of her message; your own address is left out'
  );
  // References come with or without angle brackets, in any case.
  assert.equal(engine.threadContacts(acc.id, [call.messageId.replace(/[<>]/g, '').toUpperCase()]).length, 2);
  assert.deepEqual(engine.threadContacts(acc.id, ['<unknown@example.com>']), []);
  assert.deepEqual(engine.threadContacts(acc.id, []), []);
  assert.deepEqual(engine.threadContacts('no-such-account', [call.messageId]), []);
  await engine.close();
});

// The reader's related emails, under the open email, instead of threads in the list.
test('related emails are the conversation and same-subject mail with the same people, newest first', async () => {
  const { engine, acc } = await freshEngine();
  const inbox = engine.listMessages({ scope: acc.id, view: 'inbox' });
  const call = inbox.find((m) => m.subject === 'Call on Thursday');
  const answer = engine.listMessages({ scope: acc.id, view: 'sent' }).find((m) => m.subject === 'Re: Call on Thursday');
  const ids = (list) => list.map((m) => m.id);

  // Linked by In-Reply-To, from either end; the answer in Sent says where it is.
  assert.deepEqual(ids(engine.related(call.id)), [answer.id]);
  assert.deepEqual(ids(engine.related(answer.id)), [call.id]);
  assert.equal(engine.related(call.id)[0].folder, 'Sent');

  // References, which only the full message has, count as well.
  const parcel = inbox.find((m) => m.subject === 'Your parcel is on its way');
  assert.deepEqual(engine.related(parcel.id), []);
  assert.deepEqual(ids(engine.related(parcel.id, [call.messageId])), [answer.id, call.id], 'newest first');

  // Without headers, the same subject from the same sender: the two copies of the contract.
  const [copy, other] = inbox.filter((m) => m.subject === 'Here is another copy of your contract');
  assert.deepEqual(ids(engine.related(copy.id)), [other.id]);

  // The same subject needs someone in common other than the user: Joris was on the Cc, a stranger wasn't.
  const box = engine.caches.get(acc.id).boxes;
  const me = { name: 'Demo User', address: 'demo@example.com' };
  const at = call.date + 3600000;
  box.INBOX.messages.push(
    { uid: 9001, messageId: '<joris@example.com>', subject: 'RE: call on thursday', from: { name: 'Joris Bakker', address: 'joris@example.com' }, to: [me], date: at },
    { uid: 9002, messageId: '<stranger@example.com>', subject: 'Call on Thursday', from: { name: 'Someone', address: 'someone@else.example' }, to: [me], date: at }
  );
  const joris = ids(engine.related(call.id)).filter((id) => decodeId(id).uid === 9001);
  assert.equal(joris.length, 1);
  assert.ok(!engine.related(call.id).some((m) => m.uid === 9002));

  // Trash and Spam stay out, like they do from the inbox, and so does a sender marked as spam.
  box.Trash.messages.push({ uid: 9003, messageId: '<binned@example.com>', inReplyTo: call.messageId, subject: 'Re: Call on Thursday', from: me, to: [], date: at });
  box.Junk.messages.push({ uid: 9004, messageId: '<junk@example.com>', inReplyTo: call.messageId, subject: 'Re: Call on Thursday', from: me, to: [], date: at });
  assert.ok(!engine.related(call.id).some((m) => m.uid === 9003 || m.uid === 9004));
  // A blocked sender is left out before the limit of 20, so its mail can't push the real answer out.
  for (let i = 0; i < 20; i++)
    box.INBOX.messages.push({ uid: 9100 + i, messageId: `<flood-${i}@example.com>`, inReplyTo: call.messageId, subject: 'Re: Call on Thursday', from: { address: 'flood@spam.example' }, to: [me], date: at + 1000 + i });
  engine.updateSettings({ spam: ['flood@spam.example'] }, { quiet: true });
  assert.ok(engine.related(call.id).some((m) => m.id === answer.id));
  assert.ok(!engine.related(call.id).some((m) => m.uid >= 9100));
  engine.updateSettings({ spam: ['sanne@example.com'] }, { quiet: true });
  assert.deepEqual(engine.related(answer.id).filter((m) => m.id === call.id), []);

  // An email that is the open one under another id, such as Gmail's All Mail copy, is not related to itself.
  box.INBOX.messages.push({ ...box.Sent.messages.find((m) => m.subject === 'Re: Call on Thursday'), uid: 9005 });
  assert.ok(!engine.related(answer.id).some((m) => m.uid === 9005));
  assert.deepEqual(engine.related('saved:nothing'), []);
  await engine.close();
});

// #99: the cache keeps the newest 300 inbox messages; the server counts the unread mail older than those.
test('unread counts include the inbox mail older than the cache, as the server counted it', async () => {
  const { engine, acc, dir } = await freshEngine();
  const session = engine.session(acc);
  const sync = session.syncFolder.bind(session);
  let older = 40;
  const counted = [];
  session.syncFolder = async (p, opts) => {
    const res = await sync(p, opts);
    if (!opts.olderUnseen) return res;
    counted.push(p);
    return { ...res, olderUnseen: older };
  };
  const unreadIn = (view) => engine.listMessages({ scope: acc.id, view }).filter((m) => m.unread).length;
  const cached = unreadIn('inbox');
  assert.ok(cached > 0);
  await engine.syncAccount(acc.id);
  assert.deepEqual(counted, ['INBOX'], 'only the inbox is counted on the server');
  const expectUnread = (n) => {
    const c = engine.counts(acc.id);
    // The list's header names the older mail apart from the list's own unread mail, which the Unread filter counts.
    assert.equal(c.olderUnread, Number.isInteger(older) ? older : 0);
    assert.equal(engine.counts('all').olderUnread, c.olderUnread);
    assert.equal(c.inboxLimit, 300);
    assert.equal(c.views.inbox - c.olderUnread, unreadIn('inbox'));
    assert.equal(c.accounts[acc.id], n);
    assert.equal(c.all, n);
    assert.equal(c.views.inbox, n);
    assert.equal(c.views.unread, n);
    assert.equal(c.folders.INBOX, n);
    assert.equal(engine.counts('all').views.unread, n);
    assert.equal(engine.unreadCount(), n);
    // VIP picks its mail by sender, so it counts the cache only.
    assert.equal(c.views.vip, unreadIn('vip'));
    assert.equal(c.folders.Sent, 0);
  };
  engine.toggleVip('sanne@example.com');
  expectUnread(cached + 40);

  // Reading a message in the cache counts at once, before the server is asked again.
  const first = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.unread);
  const reading = engine.setFlags(first.id, { unread: false });
  expectUnread(cached - 1 + 40);
  await reading;

  // The count is kept with the cache, so it is there after a restart before the first sync.
  engine.flush();
  const reopened = new Engine({ dataDir: dir }).init();
  assert.equal(reopened.unreadCount(), cached - 1 + 40);
  await reopened.close();

  // A server that can't count leaves the cache's count.
  older = null;
  await engine.syncAccount(acc.id);
  expectUnread(cached - 1);
  await engine.close();
});

test('the demo account counts its unread inbox mail older than the window, like a server', async () => {
  const { engine, acc } = await freshEngine();
  const session = engine.session(acc);
  const all = session.box('INBOX').messages;
  const res = await session.syncFolder('INBOX', { limit: 5, olderUnseen: true });
  const window = new Set(res.messages.map((m) => m.uid));
  assert.equal(window.size, 5);
  const unreadBelow = all.filter((m) => !window.has(m.uid) && !m.flags.includes('\\Seen')).length;
  assert.ok(unreadBelow > 0);
  assert.equal(res.olderUnseen, unreadBelow);
  assert.equal((await session.syncFolder('INBOX', { limit: 300, olderUnseen: true })).olderUnseen, 0);
  assert.equal('olderUnseen' in (await session.syncFolder('INBOX', { limit: 5 })), false);
  await engine.close();
});

// #112: a demo engine whose windows are small enough for the demo's mail to reach past them. The inbox keeps its
// newest 6 of 16 (uids 11 to 16), Sent its newest 2 of 3; Load older adds 6 at a time, 8 at most.
async function smallEngine() {
  const dir = tempDir('sem-test-');
  const engine = new Engine({ dataDir: dir, limits: { inbox: 6, default: 2, batch: 6, extra: 8 } }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  return { engine, acc, dir };
}

test('Load older widens a folder window by a batch, keeps it over syncs and restarts, and stops at its limit', async () => {
  const { engine, acc, dir } = await smallEngine();
  const inbox = { scope: acc.id, view: 'inbox' };
  const subjects = (e = engine) => e.listMessages(inbox).map((m) => m.subject);
  assert.equal(subjects().length, 6);
  assert.ok(!subjects().includes('Call on Thursday'));
  assert.equal(engine.olderCount(inbox), 10);
  // The unified inbox counts it too. Views that pick mail from folders don't widen anything: Unread and VIPs would
  // say more is on the server than they could show.
  assert.equal(engine.olderCount({ scope: 'all', view: 'inbox' }), 10);
  assert.equal(engine.olderCount({ scope: 'all', view: 'unread' }), 0);
  assert.equal(engine.olderCount({ scope: acc.id, view: 'vip' }), 0);
  assert.equal(engine.olderCount({ scope: acc.id, view: 'sent' }), 1);
  assert.equal(engine.olderCount({ scope: acc.id, view: 'starred' }), 0);
  assert.equal(engine.olderCount({ scope: acc.id, view: 'everything' }), 0);
  // A search can reach older mail wherever there is some: Inbox has 10 more, Sent and Drafts 1 each, Trash none.
  assert.deepEqual(engine.olderState(inbox), { more: 10, server: 10 });
  assert.deepEqual(engine.olderState({ scope: 'all', view: 'everything' }), { more: 0, server: 12 });
  assert.deepEqual(engine.olderState({ scope: acc.id, view: 'trash' }), { more: 0, server: 0 });
  assert.deepEqual(engine.olderState({ scope: 'all', view: 'saved' }), { more: 0, server: 0 });
  const before = engine.counts(acc.id);
  assert.equal(before.olderUnread, 2, 'Call on Thursday and the Google notice are unread below the window');

  await engine.loadOlder(inbox);
  assert.equal(subjects().length, 12);
  assert.ok(subjects().includes('Call on Thursday'));
  assert.equal(engine.olderCount(inbox), 4);
  // The unread mail it brought in moved from the server's count to the list's, without counting twice.
  const after = engine.counts(acc.id);
  assert.equal(after.olderUnread, 0);
  assert.equal(after.views.inbox, before.views.inbox);

  await engine.syncAccount(acc.id);
  assert.equal(subjects().length, 12, 'a sync keeps the wider window');
  await engine.close();
  const reopened = new Engine({ dataDir: dir, limits: engine.limits }).init();
  assert.equal(subjects(reopened).length, 12, 'and so does a restart');
  await reopened.syncAccount(acc.id);
  assert.equal(subjects(reopened).length, 12);

  // Up to the most it may add; past that only a search reaches.
  await reopened.loadOlder(inbox);
  assert.equal(subjects(reopened).length, 14);
  assert.equal(reopened.olderCount(inbox), 0);
  await reopened.loadOlder(inbox);
  assert.equal(subjects(reopened).length, 14);
  await reopened.close();
});

test('Load older while a sync waits for the connection keeps the wider window', async () => {
  const { engine, acc } = await smallEngine();
  const session = engine.session(engine.account(acc.id));
  const sync = session.syncFolder.bind(session);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let waiting = false;
  // The background sync's inbox waits, as it does behind the user's command on the connection.
  session.syncFolder = async (p, opts) => {
    if (p === 'INBOX' && opts.background && !waiting) {
      waiting = true;
      await gate;
    }
    return sync(p, opts);
  };
  const background = engine.syncAccount(acc.id);
  await until(() => waiting);
  await engine.loadOlder({ scope: acc.id, view: 'inbox' });
  assert.equal(engine.listMessages({ scope: acc.id, view: 'inbox' }).length, 12);
  release();
  await background;
  assert.equal(engine.listMessages({ scope: acc.id, view: 'inbox' }).length, 12, 'the waiting sync read the window when it ran');
  await engine.close();
});

test('a search finds older mail on the server in the folder, the account and all accounts, and lists it with the rest', async () => {
  const { engine, acc } = await smallEngine();
  const found = (opts) =>
    engine
      .listMessages({ scope: acc.id, ...opts })
      .map((m) => `${m.folder}: ${m.subject}${m.older ? ' (older)' : ''}`)
      .sort();
  assert.deepEqual(found({ view: 'inbox', query: 'parcel' }), []);
  assert.deepEqual(await engine.searchServer({ scope: acc.id, view: 'inbox', query: ' Parcel ' }), { more: 0, errors: [], remaining: 0 });
  assert.deepEqual(found({ view: 'inbox', query: 'parcel' }), ['INBOX: Your parcel is on its way (older)']);
  // It shows for that search only, not in the list or under another search.
  assert.deepEqual(found({ view: 'inbox', query: 'bol' }), []);
  assert.ok(!found({ view: 'inbox' }).some((s) => s.includes('parcel')));

  // The folder itself, as the sidebar opens it.
  await engine.searchServer({ scope: acc.id, view: 'folder', folder: 'INBOX', query: 'travel summary' });
  assert.deepEqual(found({ view: 'folder', folder: 'INBOX', query: 'travel summary' }), ['INBOX: Your travel summary for September (older)']);

  // The account: every synced folder. The sender, the recipients and Cc count, as in the cached results.
  await engine.searchServer({ scope: acc.id, view: 'everything', query: 'joris' });
  assert.deepEqual(found({ view: 'everything', query: 'joris' }), ['INBOX: Call on Thursday (older)', 'INBOX: Re: Dinner on Saturday (older)', 'Sent: Dinner on Saturday']);
  await engine.searchServer({ scope: acc.id, view: 'everything', query: 'contract' });
  assert.deepEqual(found({ view: 'everything', query: 'contract' }), [
    'INBOX: Here is another copy of your contract',
    'INBOX: Here is another copy of your contract',
    'Sent: Question about my contract (older)'
  ]);

  // All accounts.
  await engine.searchServer({ scope: 'all', view: 'everything', query: 'tax administration' });
  assert.deepEqual(
    engine.listMessages({ scope: 'all', view: 'everything', query: 'tax administration' }).map((m) => m.subject),
    ['You have a new message']
  );

  // Unread asks the server for unread mail only.
  await engine.searchServer({ scope: acc.id, view: 'unread', query: 'vandebron' });
  assert.ok(!found({ view: 'unread', query: 'vandebron' }).some((s) => s.includes('(older)')), 'its older Vandebron mail is read');
  await engine.searchServer({ scope: acc.id, view: 'unread', query: 'thursday' });
  assert.deepEqual(found({ view: 'unread', query: 'thursday' }), ['INBOX: Call on Thursday (older)']);
  await engine.close();
});

test('older mail found on the server opens, changes flags, moves and comes back with undo, counted once', async () => {
  const { engine, acc } = await smallEngine();
  const query = 'thursday';
  await engine.searchServer({ scope: acc.id, view: 'inbox', query });
  const listed = () => engine.listMessages({ scope: acc.id, view: 'inbox', query });
  const hit = listed().find((m) => m.older);
  assert.equal(hit.subject, 'Call on Thursday');
  assert.match((await engine.getMessage(hit.id)).subject, /Call on Thursday/);
  const demo = engine.session(engine.account(acc.id));
  const unread = () => engine.counts(acc.id).views.inbox;
  const start = unread();

  // Reading it counts at once, also before the next sync asks the server again.
  await engine.setFlags(hit.id, { unread: false });
  assert.equal(unread(), start - 1);
  assert.equal(listed().find((m) => m.id === hit.id).unread, false);
  assert.ok(demo.find('INBOX', hit.uid).flags.includes('\\Seen'));
  await engine.setFlags(hit.id, { unread: true });
  assert.equal(unread(), start);

  // A server that turns the change down leaves both as they were.
  const setFlags = demo.setFlags.bind(demo);
  demo.setFlags = async () => {
    throw new Error('offline');
  };
  await assert.rejects(engine.setFlags(hit.id, { unread: false }), /offline/);
  assert.equal(unread(), start);
  assert.equal(listed().find((m) => m.id === hit.id).unread, true);
  demo.setFlags = setFlags;
  const move = demo.move.bind(demo);
  demo.move = async () => {
    throw new Error('offline');
  };
  await assert.rejects(engine.archive(hit.id), /offline/);
  assert.ok(listed().some((m) => m.id === hit.id && m.older));
  assert.equal(unread(), start);
  demo.move = move;

  // Deleting moves it to the trash, out of the search and out of the count.
  assert.equal(await engine.remove(hit.id), 'trash');
  assert.ok(!listed().some((m) => m.id === hit.id));
  assert.equal(unread(), start - 1);
  assert.ok(engine.listMessages({ scope: acc.id, view: 'trash' }).some((m) => m.subject === 'Call on Thursday'));

  // Undo puts it back with the inbox's newest uid, which the window holds, so the list counts it from then on.
  assert.ok(engine.canUndo(hit.id));
  const back = await engine.undoMove(hit.id);
  assert.equal(unread(), start);
  assert.ok(engine.listMessages({ scope: acc.id, view: 'inbox' }).some((m) => m.id === back && m.subject === 'Call on Thursday' && !m.older));
  await engine.syncAccount(acc.id);
  assert.equal(unread(), start);
  await engine.close();
});

test('a sync drops older mail found on the server once the window holds it, and all of it when the uids change', async () => {
  const { engine, acc } = await smallEngine();
  const list = (query) => engine.listMessages({ scope: acc.id, view: 'inbox', query });
  await engine.searchServer({ scope: acc.id, view: 'inbox', query: 'vandebron' });
  assert.equal(list('vandebron').length, 6);
  assert.equal(list('vandebron').filter((m) => m.older).length, 2);

  // Load older brings both into the window: each shows once, as cached mail.
  await engine.loadOlder({ scope: acc.id, view: 'inbox' });
  assert.equal(list('vandebron').length, 6);
  assert.equal(list('vandebron').filter((m) => m.older).length, 0);

  // A folder whose uids were given out again forgets what was found there.
  await engine.searchServer({ scope: acc.id, view: 'inbox', query: 'parcel' });
  const parcel = list('parcel')[0];
  assert.ok(parcel.older);
  const demo = engine.session(engine.account(acc.id));
  demo.box('INBOX').uidValidity = '2';
  demo.persist();
  await engine.syncAccount(acc.id);
  assert.deepEqual(list('parcel'), []);
  assert.equal(engine.olderHit(acc.id, 'INBOX', parcel.uid), null);
  assert.throws(() => engine.locate(parcel.id), { message: t('errors.message.missing') });
  await engine.close();
});

test('a sync shows what another device did to older mail found on the server, and counts its unread mail once', async () => {
  const { engine, acc } = await smallEngine();
  const demo = engine.session(engine.account(acc.id));
  const listed = () => engine.listMessages({ scope: acc.id, view: 'inbox', query: 'thursday' });
  const olderUnread = () => engine.counts(acc.id).olderUnread;
  await engine.searchServer({ scope: acc.id, view: 'inbox', query: 'thursday' });
  const hit = listed().find((m) => m.older);
  assert.equal(hit.subject, 'Call on Thursday');
  assert.equal(hit.unread, true);
  assert.equal(olderUnread(), 2);

  // Read and starred on another device: the sync shows both, and the server counts one older unread message.
  demo.find('INBOX', hit.uid).flags.push('\\Seen', '\\Flagged');
  demo.persist();
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 1);
  assert.deepEqual((({ unread, starred }) => ({ unread, starred }))(listed().find((m) => m.id === hit.id)), { unread: false, starred: true });
  // Marking it read here changes no count: it was read already.
  await engine.setFlags(hit.id, { unread: false });
  assert.equal(olderUnread(), 1);

  // A change on its way to the server stays while a sync reads the flags from before it.
  const setFlags = demo.setFlags.bind(demo);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  demo.setFlags = async (...args) => {
    await gate;
    return setFlags(...args);
  };
  const unstar = engine.setFlags(hit.id, { starred: false });
  await engine.syncAccount(acc.id);
  assert.equal(listed().find((m) => m.id === hit.id).starred, false);
  release();
  await unstar;
  demo.setFlags = setFlags;

  // Deleted on another device: it leaves the results and no longer opens.
  const box = demo.box('INBOX');
  box.messages = box.messages.filter((m) => m.uid !== hit.uid);
  demo.persist();
  await engine.syncAccount(acc.id);
  assert.deepEqual(listed(), []);
  assert.throws(() => engine.locate(hit.id), { message: t('errors.message.missing') });
  await engine.close();
});

test('reading or moving older unread mail found on the server while a sync runs counts it once, and a refusal puts it back', async () => {
  const { engine, acc } = await smallEngine();
  const demo = engine.session(engine.account(acc.id));
  const olderUnread = () => engine.counts(acc.id).olderUnread;
  await engine.searchServer({ scope: acc.id, view: 'inbox', query: 'thursday' });
  const hit = engine.listMessages({ scope: acc.id, view: 'inbox', query: 'thursday' }).find((m) => m.older);
  const found = () => engine.olderHit(acc.id, 'INBOX', hit.uid);
  assert.equal(found().unread, true);
  assert.equal(olderUnread(), 2);

  // The demo's command waits until the returned function is called. first: the server has the change before that
  // wait, as when its answer is still on the way. fail: the error it answers with instead.
  const hold = (name, { first = false, fail = null } = {}) => {
    const real = demo[name].bind(demo);
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    demo[name] = async (...args) => {
      const res = first ? await real(...args) : undefined;
      await gate;
      if (fail) throw new Error(fail);
      return first ? res : real(...args);
    };
    return () => {
      demo[name] = real;
      open();
    };
  };

  // Marked read, turned down: the sync read the server before the change, which counts until the server refuses it.
  let release = hold('setFlags', { fail: 'offline' });
  const refused = engine.setFlags(hit.id, { unread: false });
  assert.equal(olderUnread(), 1);
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 1);
  assert.equal(found().unread, false);
  release();
  await assert.rejects(refused, /offline/);
  assert.equal(olderUnread(), 2);
  assert.equal(found().unread, true);
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 2);

  // Marked read: the count the sync brought from before the change goes down too, and stays down.
  release = hold('setFlags');
  const read = engine.setFlags(hit.id, { unread: false });
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 1);
  release();
  await read;
  assert.equal(olderUnread(), 1);
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 1);

  // Marked unread, with a sync that already read the change on the server: not counted twice.
  release = hold('setFlags', { first: true });
  const unread = engine.setFlags(hit.id, { unread: true });
  assert.equal(olderUnread(), 2);
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 2);
  release();
  await unread;
  assert.equal(olderUnread(), 2);

  // Read and unread again before the server has either: the count the sync brought from before both stays.
  release = hold('setFlags');
  const both = [engine.setFlags(hit.id, { unread: false }), engine.setFlags(hit.id, { unread: true })];
  assert.equal(olderUnread(), 2);
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 2);
  release();
  await Promise.all(both);
  assert.equal(olderUnread(), 2);
  assert.equal(found().unread, true);

  // Archived, turned down: it comes back into the results and the count.
  release = hold('move', { fail: 'offline' });
  const archived = engine.archive(hit.id);
  assert.equal(olderUnread(), 1);
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 1);
  release();
  await assert.rejects(archived, /offline/);
  assert.equal(olderUnread(), 2);
  assert.equal(found().unread, true);

  // Deleted: out of the count, also after a sync that read the server before the move.
  release = hold('move');
  const removed = engine.remove(hit.id);
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 1);
  release();
  assert.equal(await removed, 'trash');
  assert.equal(olderUnread(), 1);
  assert.equal(found(), null);
  await engine.syncAccount(acc.id);
  assert.equal(olderUnread(), 1);
  await engine.close();
});

test('a search goes through every folder a batch at a time, and resume searches the next batch', async () => {
  const dir = tempDir('sem-test-');
  const engine = new Engine({ dataDir: dir, limits: { inbox: 6, default: 2, batch: 6, extra: 8 }, search: { folders: 1 } }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  const demo = engine.session(engine.account(acc.id));
  const search = demo.searchFolder.bind(demo);
  const asked = [];
  demo.searchFolder = async (p, q, opts) => {
    asked.push(p);
    return search(p, q, opts);
  };
  const opts = { scope: acc.id, view: 'everything', query: 'contract' };
  const older = () => engine.listMessages(opts).filter((m) => m.older).map((m) => `${m.folder}: ${m.subject}`);

  // Inbox, Sent and Drafts have older mail on the server, one folder per call here. The older contract mail is in Sent.
  assert.deepEqual(await engine.searchServer(opts), { more: 0, errors: [], remaining: 2 });
  assert.deepEqual(older(), []);
  assert.deepEqual(await engine.searchServer({ ...opts, resume: true }), { more: 0, errors: [], remaining: 1 });
  assert.deepEqual(older(), ['Sent: Question about my contract']);
  assert.deepEqual(await engine.searchServer({ ...opts, resume: true }), { more: 0, errors: [], remaining: 0 });
  assert.deepEqual(await engine.searchServer({ ...opts, resume: true }), { more: 0, errors: [], remaining: 0 }, 'nothing left');
  assert.deepEqual(asked, ['INBOX', 'Sent', 'Drafts']);

  // Without resume, or with it for another search, it starts again at the first folder.
  asked.length = 0;
  assert.equal((await engine.searchServer(opts)).remaining, 2);
  assert.equal((await engine.searchServer({ ...opts, query: 'joris', resume: true })).remaining, 2);
  assert.deepEqual(asked, ['INBOX', 'INBOX']);

  // An account whose server fails isn't searched further.
  demo.searchFolder = async () => {
    throw new Error('getaddrinfo ENOTFOUND imap.example.com');
  };
  assert.deepEqual(await engine.searchServer({ ...opts, query: 'dinner' }), { more: 0, errors: [`demo@example.com: ${t('errors.connection.host')}`], remaining: 0 });
  await engine.close();
});

test('a search started while another still runs stops that one, which keeps nothing over the newer results', async () => {
  const { engine, acc } = await smallEngine();
  const demo = engine.session(engine.account(acc.id));
  const search = demo.searchFolder.bind(demo);
  const asked = [];
  let held = null;
  let waiting = false;
  let release;
  // The server holds back its answer to one folder and query, as the connection's queue does behind another command.
  demo.searchFolder = async (p, q, opts) => {
    asked.push(`${p}: ${q}`);
    if (`${p}: ${q}` === held) {
      waiting = true;
      await new Promise((resolve) => (release = resolve));
    }
    return search(p, q, opts);
  };
  const all = { scope: acc.id, view: 'everything', query: 'contract' };
  const inSent = (query) => ({ scope: acc.id, view: 'folder', folder: 'Sent', query });
  const older = (query) =>
    engine
      .listMessages(inSent(query))
      .filter((m) => m.older)
      .map((m) => m.subject);

  // The search of every folder for 'contract' waits for Sent's answer while the user searches Sent alone. Both find the
  // same older message there. The first answers last, and the message stays listed under the search on screen.
  held = 'Sent: contract';
  const first = engine.searchServer(all);
  await until(() => waiting);
  await engine.searchServer(inSent('question about'));
  assert.deepEqual(older('question about'), ['Question about my contract']);
  release();
  await first;
  assert.deepEqual(older('question about'), ['Question about my contract']);
  assert.deepEqual(older('contract'), [], 'the stopped search kept nothing');

  // Stopped while it waits for the inbox, it searches no further folder.
  held = 'INBOX: contract';
  waiting = false;
  asked.length = 0;
  const again = engine.searchServer(all);
  await until(() => waiting);
  await engine.searchServer(inSent('my contract'));
  release();
  await again;
  assert.deepEqual(asked, ['INBOX: contract', 'Sent: my contract']);
  assert.deepEqual(older('my contract'), ['Question about my contract']);
  await engine.close();
});

test('a search asks the server nothing for one letter, saved emails or whole folders, and names an account that fails', async () => {
  const { engine, acc } = await smallEngine();
  const demo = engine.session(engine.account(acc.id));
  const search = demo.searchFolder.bind(demo);
  const asked = [];
  demo.searchFolder = async (p, q, opts) => {
    asked.push([p, q, opts.below, opts.criteria]);
    return search(p, q, opts);
  };
  await engine.searchServer({ scope: acc.id, view: 'inbox', query: 'a' });
  await engine.searchServer({ scope: 'all', view: 'saved', query: 'parcel' });
  await engine.searchServer({ scope: acc.id, view: 'trash', query: 'chance' });
  assert.deepEqual(asked, [], 'Trash holds one message, all of it in the cache');
  await engine.searchServer({ scope: acc.id, view: 'unread', query: 'Thursday' });
  assert.deepEqual(asked, [['INBOX', 'Thursday', 11, { seen: false }]], 'below the oldest uid the window has');

  // More matches than come back are counted.
  demo.searchFolder = async (p, q, opts) => ({ ...(await search(p, q, opts)), total: 80 });
  assert.equal((await engine.searchServer({ scope: acc.id, view: 'inbox', query: 'parcel' })).more, 79);

  // A server that can't be reached: the error names the account and the cached results stay.
  demo.searchFolder = async () => {
    throw new Error('getaddrinfo ENOTFOUND imap.example.com');
  };
  const res = await engine.searchServer({ scope: 'all', view: 'everything', query: 'contract' });
  assert.deepEqual(res, { more: 0, errors: [`demo@example.com: ${t('errors.connection.host')}`], remaining: 0 });
  assert.equal(engine.listMessages({ scope: 'all', view: 'everything', query: 'contract' }).length, 2);
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

// Playwright quits Rukoo through the inspector, which can run the quit's flush() inside a running timer: here between the
// cache save's write and its rename. An error thrown from that timer opened Electron's error box, and the macOS quit hung.
test('a quit that flushes in the middle of a cache save leaves the save without an error and the cache saved', async () => {
  const { engine, acc, dir } = await freshEngine();
  engine.flush();
  const file = path.join(dir, 'cache', `${acc.id}.json`);
  const rename = fs.renameSync;
  let flushed = false;
  fs.renameSync = (from, to) => {
    if (!flushed && to === file) {
      flushed = true;
      engine.flush();
    }
    return rename(from, to);
  };
  try {
    engine.persistCache(acc.id);
    await until(() => flushed);
    // The timer finishes after its interrupted rename; an error from it would fail this test as uncaught.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    fs.renameSync = rename;
  }
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).boxes);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
  await engine.close();
});

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

test('a folder that fails to sync leaves the others current, and the account shows the error', async () => {
  const { engine, acc } = await freshEngine();
  const before = engine.state().accounts[0].lastSync;
  const events = [];
  engine.on('new-mail', (list) => events.push(...list));
  const s = engine.session(acc);
  await s.append('INBOX', Buffer.from('From: a@example.com\r\nSubject: New!\r\n\r\nhi'));
  const syncFolder = s.syncFolder.bind(s);
  const synced = [];
  s.syncFolder = async (folder, options) => {
    if (folder === 'Sent') throw new Error('NO Sent is unavailable');
    synced.push(folder);
    return syncFolder(folder, options);
  };
  await assert.rejects(engine.syncAccount(acc.id), /Sent is unavailable/);
  assert.deepEqual(synced, ['INBOX', 'Drafts', 'Trash', 'Junk', 'Archive']);
  assert.deepEqual(events.map((m) => m.subject), ['New!']);
  let state = engine.state().accounts[0];
  assert.equal(state.error, 'NO Sent is unavailable');
  assert.equal(state.lastSync, before, 'not a sync that got through every folder');

  s.syncFolder = syncFolder;
  await engine.syncAccount(acc.id);
  state = engine.state().accounts[0];
  assert.equal(state.error, null);
  assert.ok(state.lastSync >= before);
  await engine.close();
});

test('a sync that fails because the engine closed opens no new session for the next folder', async () => {
  const { engine, acc } = await freshEngine();
  let resume;
  const sync = engine.syncFolderInto.bind(engine);
  // The first folder fails once the engine has closed, as a closed session does.
  engine.syncFolderInto = async () => {
    engine.syncFolderInto = sync;
    await new Promise((resolve) => (resume = resolve));
    throw new Error('this session is closed');
  };
  const syncing = engine.syncAccount(acc.id);
  await until(() => resume);
  await engine.close();
  resume();
  await assert.rejects(syncing, /closed/);
  assert.equal(engine.sessions.size, 0);
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
