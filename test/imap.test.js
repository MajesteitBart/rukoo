'use strict';

// The command queues of ImapAccount, with the connections replaced by stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ImapAccount } = require('../src/main/imap');

// client: the stand-in, or a function that makes one for each connection (it gets 'main' or 'reader').
function session(client = { usable: true }) {
  const s = new ImapAccount({ email: 'me@example.com', imap: {}, smtp: {} }, 'secret');
  s.connects = 0;
  s.connect = async (conn = s.main) => {
    if (!conn.client || !conn.client.usable) {
      conn.client = typeof client === 'function' ? client(conn === s.reader ? 'reader' : 'main') : client;
      s.connects++;
    }
    return conn.client;
  };
  return s;
}

const tick = () => new Promise((r) => setImmediate(r));

test('a command the user waits for goes ahead of queued background work, not ahead of the running one', async () => {
  const s = session();
  const order = [];
  let finishInbox;
  const inbox = s.run(
    () =>
      new Promise((resolve) => {
        order.push('sync INBOX');
        finishInbox = resolve;
      }),
    { background: true }
  );
  const sent = s.run(async () => order.push('sync Sent'), { background: true });
  const prefetch = s.run(async () => order.push('prefetch'), { background: true });
  const open = s.run(async () => order.push('open message'));
  const star = s.run(async () => order.push('star message'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['sync INBOX']);
  finishInbox();
  await Promise.all([inbox, sent, prefetch, open, star]);
  assert.deepEqual(order, ['sync INBOX', 'open message', 'star message', 'sync Sent', 'prefetch']);
});

test('a failed command rejects only itself, and a broken connection is opened again', async () => {
  const s = session(() => ({ usable: true }));
  const failing = s.run(async (client) => {
    client.usable = false;
    throw new Error('connection lost');
  });
  const next = s.run(async () => 'ok', { background: true });
  await assert.rejects(failing, /connection lost/);
  assert.equal(await next, 'ok');
  assert.equal(s.connects, 2);
});

test('a closed session turns down the work still waiting, and connects no more', async () => {
  const s = session(() => ({ usable: true, logout: async () => {} }));
  let finish;
  const running = s.run(() => new Promise((resolve) => (finish = resolve)));
  const waiting = s.run(async () => 'fetched', { background: true });
  await new Promise((r) => setImmediate(r));
  await s.close();
  finish('done');
  assert.equal(await running, 'done');
  await assert.rejects(waiting, /connection to the mail server was closed/);
  await assert.rejects(s.run(async () => 'later'), /connection to the mail server was closed/);
  assert.equal(s.connects, 1);
});

test('the reader opens a folder read-only; on the main connection a prefetch and marking read keep it in one mode', async () => {
  const modes = [];
  const s = session((name) => ({
    usable: true,
    getMailboxLock: async (path, opts = {}) => {
      modes.push(`${name}: ${path} ${opts.readOnly ? 'read-only' : 'read-write'}`);
      return { release() {} };
    },
    fetchOne: async () => ({ source: Buffer.from('Subject: hi\r\n\r\nbody') }),
    messageFlagsAdd: async () => {}
  }));
  await s.fetchSource('INBOX', 7);
  await s.setFlags('INBOX', 7, { unread: false });
  await s.fetchSource('INBOX', 8, { background: true });
  assert.deepEqual(modes, ['reader: INBOX read-only', 'main: INBOX read-write', 'main: INBOX read-write']);
});

// fetchOne: what fetching a message does, by default answering at once.
const reading = (name, log, fetchOne) => ({
  usable: true,
  name,
  getMailboxLock: async () => ({ release() {} }),
  fetchOne:
    fetchOne ||
    (async (uid) => {
      log.push(`${name} fetch ${uid}`);
      return { source: Buffer.from(`message ${uid}`) };
    }),
  logout() {
    this.usable = false;
    log.push(`${name} logout`);
    return Promise.resolve();
  }
});

// A server that takes one connection at a time, once limited is set: the second to connect is turned down.
function oneConnectionServer(s, state) {
  const connect = s.connect;
  s.connect = async (conn = s.main) => {
    const other = conn === s.main ? s.reader : s.main;
    if (state.limited && !(conn.client && conn.client.usable) && other.client && other.client.usable) throw new Error('Unexpected close');
    return connect(conn);
  };
}

test('opening a message does not wait for a sync that is running', async () => {
  const log = [];
  const s = session((name) => reading(name, log));
  let finishSync;
  const sync = s.run(() => new Promise((resolve) => (finishSync = resolve)), { background: true });
  await tick();
  const raw = await s.fetchSource('INBOX', 7);
  assert.equal(String(raw), 'message 7');
  assert.deepEqual(log, ['reader fetch 7']);
  assert.equal(s.connects, 2);
  finishSync('synced');
  assert.equal(await sync, 'synced');
  await s.close();
  assert.deepEqual(log.slice(1).sort(), ['main logout', 'reader logout']);
});

test('a server that turns the reader down gets reads on the main connection, after its running command', async () => {
  const log = [];
  const s = session((name) => reading(name, log));
  const connect = s.connect;
  s.connect = async (conn = s.main) => {
    if (conn === s.reader) throw new Error('Too many simultaneous connections');
    return connect(conn);
  };
  let finishSync;
  const sync = s.run(
    () =>
      new Promise((resolve) => {
        log.push('main sync');
        finishSync = resolve;
      }),
    { background: true }
  );
  const later = s.run(async () => log.push('main next folder'), { background: true });
  await tick();
  const opened = s.fetchSource('INBOX', 7);
  await tick();
  assert.deepEqual(log, ['main sync']);
  finishSync();
  assert.equal(String(await opened), 'message 7');
  await Promise.all([sync, later]);
  assert.deepEqual(log, ['main sync', 'main fetch 7', 'main next folder']);
  assert.equal(s.oneConnection, true);
  // From then on reads go straight to the main connection; the reader isn't tried again.
  s.connect = async (conn = s.main) => {
    assert.notEqual(conn, s.reader);
    return connect(conn);
  };
  assert.equal(String(await s.fetchSource('INBOX', 8)), 'message 8');
});

test('on a server that takes one connection, a reader that got in first makes room for the main connection', async () => {
  const log = [];
  const s = session((name) => reading(name, log));
  oneConnectionServer(s, { limited: true });
  assert.equal(String(await s.fetchSource('INBOX', 7)), 'message 7');
  assert.equal(await s.run(async () => 'synced', { background: true }), 'synced');
  assert.deepEqual(log, ['reader fetch 7', 'reader logout']);
  assert.equal(s.oneConnection, true);
  assert.equal(String(await s.fetchSource('INBOX', 8)), 'message 8');
  assert.deepEqual(log.slice(2), ['main fetch 8']);
});

test('the main connection reconnecting past a busy reader waits for its fetch, then takes the slot', async () => {
  const log = [];
  const pending = [];
  const s = session((name) =>
    reading(name, log, (uid) => {
      log.push(`${name} fetch ${uid}`);
      return new Promise((resolve) => pending.push(() => resolve({ source: Buffer.from(`message ${uid}`) })));
    })
  );
  const state = { limited: false };
  oneConnectionServer(s, state);
  await s.run(async () => 'connected', { background: true });
  const opening = s.fetchSource('INBOX', 7);
  const queued = s.fetchSource('INBOX', 9);
  await tick();
  assert.deepEqual(log, ['reader fetch 7']);
  // The server drops the main connection and lets only one back in.
  state.limited = true;
  s.main.client.usable = false;
  const sync = s.run(async () => 'synced', { background: true });
  await tick();
  assert.deepEqual(log, ['reader fetch 7'], 'the reader finishes first');
  pending.shift()();
  assert.equal(String(await opening), 'message 7');
  await tick();
  assert.equal(await sync, 'synced');
  await tick();
  pending.shift()();
  assert.equal(String(await queued), 'message 9');
  assert.deepEqual(log, ['reader fetch 7', 'reader logout', 'main fetch 9']);
  assert.equal(s.oneConnection, true);
});

test('a session closed while the main connection waits for the reader runs nothing and connects no more', async () => {
  const log = [];
  const pending = [];
  const s = session((name) =>
    reading(name, log, (uid) => {
      log.push(`${name} fetch ${uid}`);
      return new Promise((resolve) => pending.push(() => resolve({ source: Buffer.from(`message ${uid}`) })));
    })
  );
  const state = { limited: false };
  oneConnectionServer(s, state);
  await s.run(async () => 'connected', { background: true });
  const opening = s.fetchSource('INBOX', 7);
  await tick();
  state.limited = true;
  s.main.client.usable = false;
  let ran = false;
  const move = s.run(async () => (ran = true));
  await tick();
  const connects = s.connects;
  const closing = s.close();
  pending.shift()();
  await opening;
  await closing;
  await assert.rejects(move, /connection to the mail server was closed/);
  assert.equal(ran, false);
  assert.equal(s.connects, connects);
});

test('without any connection a read fails with the reason', async () => {
  const s = session();
  s.connect = async () => {
    throw new Error('getaddrinfo ENOTFOUND imap.example.com');
  };
  await assert.rejects(s.fetchSource('INBOX', 7), /ENOTFOUND/);
  assert.equal(s.oneConnection, false);
});

// A server folder for syncFolder: messages by sequence number, and every FETCH it was asked.
function folder(messages) {
  const asked = [];
  const client = {
    usable: true,
    mailbox: { exists: messages.length, uidValidity: 9 },
    getMailboxLock: async () => ({ release() {} }),
    async *fetch(range, query, opts = {}) {
      asked.push({ range, query: Object.keys(query).filter((k) => k !== 'uid'), byUid: Boolean(opts.uid) });
      let list;
      if (opts.uid) {
        const uids = new Set(String(range).split(',').map(Number));
        list = messages.filter((m) => uids.has(m.uid) && !m.goneBeforeDetails);
      } else {
        const start = Number(String(range).split(':')[0]);
        list = messages.slice(start - 1);
      }
      for (const m of list) {
        const row = { uid: m.uid };
        if (query.flags) row.flags = new Set(m.flags);
        if (query.envelope) row.envelope = { subject: m.subject, messageId: `<${m.uid}@x>`, from: [{ name: '', address: 'a@x' }], to: [], cc: [], replyTo: [], date: new Date(2026, 9, m.uid) };
        if (query.bodyStructure) row.bodyStructure = { type: 'text/plain', part: '1', size: 10, encoding: '7bit' };
        if (query.internalDate) row.internalDate = new Date(2026, 9, m.uid);
        if (query.size) row.size = 100 + m.uid;
        if (query.bodyParts) row.bodyParts = new Map([['1', Buffer.from(`preview of ${m.uid}`)]]);
        if (query.headers) row.headers = Buffer.from(m.headers || '');
        yield row;
      }
    }
  };
  return { client, asked };
}

const stored = (uid, subject) => ({ uid, messageId: `<${uid}@x>`, inReplyTo: null, subject, from: { name: '', address: 'a@x' }, to: [], cc: [], replyTo: [], date: 1, preview: `kept ${uid}`, hasAttachments: false, size: 1, unread: true, starred: false, answered: false });

test('a sync fetches only the flags of messages the cache has, and the rest only for new ones', async () => {
  const { client, asked } = folder([
    { uid: 3, subject: 'old', flags: ['\\Seen'] },
    { uid: 4, subject: 'old too', flags: ['\\Flagged'] },
    { uid: 5, subject: 'new', flags: [] }
  ]);
  const s = session(client);
  const known = new Map([
    [3, stored(3, 'cached subject')],
    [4, stored(4, 'cached subject 4')]
  ]);
  const res = await s.syncFolder('INBOX', { limit: 10, known, uidValidity: '9', background: true });
  assert.deepEqual(asked[0], { range: '1:*', query: ['flags'], byUid: false });
  assert.deepEqual(asked[1], { range: '5', query: ['envelope', 'bodyStructure', 'internalDate', 'size'], byUid: true });
  assert.equal(asked.length, 3, 'and a preview for the new one');
  const byUid = new Map(res.messages.map((m) => [m.uid, m]));
  assert.deepEqual([...byUid.keys()], [3, 4, 5]);
  assert.equal(byUid.get(3).subject, 'cached subject');
  assert.equal(byUid.get(3).preview, 'kept 3');
  assert.equal(byUid.get(3).unread, false, 'the flags come from the server');
  assert.equal(byUid.get(4).starred, true);
  assert.equal(byUid.get(5).subject, 'new');
  assert.equal(byUid.get(5).size, 105);
  assert.equal(byUid.get(5).unread, true);
});

test('a sync fetches everything again for a cached message that lacks a field, and skips one gone meanwhile', async () => {
  const { client, asked } = folder([
    { uid: 3, subject: 'old', flags: [] },
    { uid: 4, subject: 'moved away', flags: [], goneBeforeDetails: true }
  ]);
  const s = session(client);
  const partial = stored(3, 'cached');
  delete partial.replyTo;
  const res = await s.syncFolder('INBOX', { limit: 10, known: new Map([[3, partial]]), uidValidity: '9' });
  assert.equal(asked[1].range, '3,4');
  assert.deepEqual(res.messages.map((m) => [m.uid, m.subject]), [[3, 'old']]);
  assert.deepEqual(res.messages[0].replyTo, []);
});

test('after a UIDVALIDITY change a sync uses nothing of the cache', async () => {
  const { client, asked } = folder([{ uid: 3, subject: 'reassigned', flags: [] }]);
  const s = session(client);
  const res = await s.syncFolder('INBOX', { limit: 10, known: new Map([[3, stored(3, 'stale')]]), uidValidity: '8' });
  assert.equal(asked[1].range, '3');
  assert.equal(res.messages[0].subject, 'reassigned');
});

test('an inbox sync collects the mail-kind headers once and asks Gmail for its tabs every time', async () => {
  const { client, asked } = folder([
    { uid: 3, subject: 'old newsletter', flags: [], headers: 'List-Unsubscribe: <https://x>\r\n' },
    { uid: 4, subject: 'old, kinds known', flags: [] },
    { uid: 5, subject: 'new', flags: [], headers: 'Auto-Submitted: auto-generated\r\n' }
  ]);
  client.capabilities = new Map([['X-GM-EXT-1', true]]);
  const searched = [];
  client.search = async (query) => {
    searched.push(query);
    return { 'category:promotions': [3], 'category:updates': [5] }[query.gmraw] || [];
  };
  const s = session(client);
  const known = new Map([
    [3, stored(3, 'cached')],
    [4, { ...stored(4, 'cached 4'), signals: { bulk: true }, gmailTab: 'social' }]
  ]);
  const res = await s.syncFolder('INBOX', { limit: 10, known, uidValidity: '9', signals: true, gmailTabs: true });
  const headers = asked.find((a) => a.query.includes('headers'));
  assert.equal(headers.range, '3,5', 'not for the message whose kind is known');
  assert.deepEqual(searched.map((q) => q.gmraw), ['category:promotions', 'category:social', 'category:updates', 'category:forums']);
  assert.equal(searched[0].uid, '3:*');
  const byUid = new Map(res.messages.map((m) => [m.uid, m]));
  assert.deepEqual(byUid.get(3).signals, { list: true });
  assert.deepEqual(byUid.get(4).signals, { bulk: true });
  assert.deepEqual(byUid.get(5).signals, { auto: true });
  assert.deepEqual([3, 4, 5].map((uid) => byUid.get(uid).gmailTab), ['promotions', 'primary', 'updates']);

  // Without Gmail's extension the tabs aren't asked, and what the cache had stays.
  client.capabilities = new Map();
  searched.length = 0;
  const again = await s.syncFolder('INBOX', { limit: 10, known: new Map(res.messages.map((m) => [m.uid, m])), uidValidity: '9', signals: true, gmailTabs: true });
  assert.equal(searched.length, 0);
  assert.equal(again.messages.find((m) => m.uid === 3).gmailTab, 'promotions');
});

test('a sync of another folder asks for neither', async () => {
  const { client, asked } = folder([{ uid: 3, subject: 'sent', flags: [] }]);
  client.search = async () => assert.fail('no search');
  const s = session(client);
  const res = await s.syncFolder('Sent', { limit: 10, known: new Map(), uidValidity: '9' });
  assert.ok(!asked.some((a) => a.query.includes('headers')));
  assert.equal('signals' in res.messages[0], false);
  assert.equal('olderUnseen' in res, false);
});

test('an inbox sync counts the unread mail below the window by uid, and says null when the server does not tell', async () => {
  const flags = { 3: [], 4: ['\\Seen'], 5: [], 6: [], 7: ['\\Seen'] };
  const { client } = folder(Object.entries(flags).map(([uid, f]) => ({ uid: Number(uid), subject: `m${uid}`, flags: f })));
  const searched = [];
  client.search = async (query, opts) => {
    searched.push({ query, opts });
    const [from, to] = query.uid.split(':').map(Number);
    return { count: Object.keys(flags).map(Number).filter((uid) => uid >= from && uid <= to && !flags[uid].includes('\\Seen')).length };
  };
  const s = session(client);
  // The window is the newest two, uids 6 and 7. Below it 3 and 5 are unread and 4 is read.
  const res = await s.syncFolder('INBOX', { limit: 2, olderUnseen: true });
  assert.deepEqual(res.messages.map((m) => m.uid), [6, 7]);
  assert.deepEqual(searched, [{ query: { seen: false, uid: '1:5' }, opts: { uid: true, returnOptions: ['COUNT'] } }]);
  assert.equal(res.olderUnseen, 2);

  // An answer with the uids instead of a count.
  client.search = async () => [3, 5];
  assert.equal((await s.syncFolder('INBOX', { limit: 2, olderUnseen: true })).olderUnseen, 2);

  // A refused or failed search leaves the count unknown, and the sync itself goes through.
  client.search = async () => false;
  const refused = await s.syncFolder('INBOX', { limit: 2, olderUnseen: true });
  assert.equal(refused.olderUnseen, null);
  assert.deepEqual(refused.messages.map((m) => m.uid), [6, 7]);
  client.search = async () => {
    throw new Error('BAD');
  };
  assert.equal((await s.syncFolder('INBOX', { limit: 2, olderUnseen: true })).olderUnseen, null);

  // A window that holds the whole folder has nothing below it to ask about.
  client.search = async () => assert.fail('no search');
  assert.equal((await s.syncFolder('INBOX', { limit: 10, olderUnseen: true })).olderUnseen, 0);
  assert.equal('olderUnseen' in (await s.syncFolder('INBOX', { limit: 2 })), false);
});
