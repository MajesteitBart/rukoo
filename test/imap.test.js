'use strict';

// The command queues of ImapAccount, with the connections replaced by stand-ins, and its sign-in check against the
// test IMAP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { t } = require('../src/i18n');
const { ImapAccount, friendlyError, uidSets } = require('../src/main/imap');
const { imapServer, imapMailbox, nestedStructure, textStructure, GMAIL_APP_PASSWORD_REQUIRED } = require('./fixtures/imap-server');

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

// #56: a large message's text before its attachments.
test('a large message comes over the reader as its structure and then its text parts, rebuilt for mailparser', async () => {
  const MailComposer = require('nodemailer/lib/mail-composer');
  const { simpleParser } = require('mailparser');
  const { mimeClient } = require('./fixtures/mime-server');
  const raw = await new MailComposer({
    from: 'sanne@example.com',
    to: 'me@example.com',
    subject: 'Report',
    text: 'The report is attached.',
    html: '<p>The report is attached.</p>',
    attachments: [{ filename: 'report.pdf', content: Buffer.alloc(3 * 1024 * 1024, 7), contentType: 'application/pdf' }]
  })
    .compile()
    .build();
  const log = [];
  const modes = [];
  const s = session((name) => {
    const client = mimeClient(raw, { log });
    const lock = client.getMailboxLock;
    client.getMailboxLock = async (path, opts = {}) => {
      modes.push(`${name}: ${path} ${opts.readOnly ? 'read-only' : 'read-write'}`);
      return lock(path, opts);
    };
    return client;
  });
  let finishSync;
  const sync = s.run(() => new Promise((resolve) => (finishSync = resolve)), { background: true });
  await tick();
  const skeleton = await s.fetchReadable('INBOX', 7);
  // Next to a running sync, over the reader, which only reads.
  assert.deepEqual(modes, ['reader: INBOX read-only']);
  assert.deepEqual(log.map((q) => Object.keys(q).filter((k) => k !== 'uid').sort()), [['bodyStructure', 'headers', 'size'], ['bodyParts']]);
  assert.ok(!log[1].bodyParts.includes('2'), 'the attachment stays on the server');
  assert.ok(skeleton.length < 8 * 1024, `${skeleton.length} bytes`);
  const parsed = await simpleParser(skeleton);
  assert.equal(parsed.text, 'The report is attached.');
  assert.deepEqual(parsed.attachments.map((a) => [a.filename, Number(a.headers.get('x-rukoo-omitted')) > 3000000]), [['report.pdf', true]]);
  finishSync();
  await sync;

  // A message of one part has nothing to leave out: one fetch, and the whole message comes as before.
  log.length = 0;
  const single = session(() => mimeClient('Subject: hi\r\nContent-Type: text/plain\r\n\r\nbody', { log }));
  assert.equal(await single.fetchReadable('INBOX', 7), null);
  assert.equal(log.length, 1);
  // A server that leaves out a part's header or its text fails the split; the engine reads the whole message then.
  const leaving = (drop) =>
    session(() => {
      const client = mimeClient(raw);
      const fetchOne = client.fetchOne;
      client.fetchOne = async (seq, query) => {
        const msg = await fetchOne(seq, query);
        if (msg.bodyParts) for (const key of [...msg.bodyParts.keys()]) if (drop(key)) msg.bodyParts.delete(key);
        return msg;
      };
      return client;
    });
  const missing = { message: t('errors.message.serverMissing') };
  await assert.rejects(leaving((key) => key.endsWith('.mime')).fetchReadable('INBOX', 7), missing);
  await assert.rejects(leaving((key) => key === '1.1').fetchReadable('INBOX', 7), missing, 'the text part');
});

// A server folder for syncFolder: messages by sequence number, and every FETCH it was asked. A message marked
// goneBeforeDetails is gone by the time its details are asked; one marked nested is left out of any fetch that asks
// for its structure, as imapflow leaves out a structure nested too deep to parse.
function folder(messages) {
  const asked = [];
  // The uids a set such as 3:5,9 names.
  const inSet = (range) => {
    const out = new Set();
    for (const part of String(range).split(',')) {
      const [a, b = a] = part.split(':').map(Number);
      for (let n = a; n <= b; n++) out.add(n);
    }
    return out;
  };
  // The header lines with these names, as a server answers BODY.PEEK[HEADER.FIELDS (...)], folded lines included.
  const fields = (text, names) =>
    String(text || '')
      .split(/\r\n(?![ \t])/)
      .filter((line) => names.includes(line.slice(0, line.indexOf(':')).trim().toLowerCase()))
      .map((line) => `${line}\r\n`)
      .join('');
  const client = {
    usable: true,
    mailbox: { exists: messages.length, uidValidity: 9 },
    getMailboxLock: async () => ({ release() {} }),
    async *fetch(range, query, opts = {}) {
      asked.push({ range, query: Object.keys(query).filter((k) => k !== 'uid'), byUid: Boolean(opts.uid), ...(query.headers ? { headers: query.headers } : {}) });
      let list;
      if (opts.uid) {
        const uids = inSet(range);
        list = messages.filter((m) => uids.has(m.uid) && !m.goneBeforeDetails && !(m.nested && query.bodyStructure));
      } else {
        const start = Number(String(range).split(':')[0]);
        list = messages.slice(start - 1);
      }
      for (const m of list) {
        const row = { uid: m.uid };
        if (query.flags) row.flags = new Set(m.flags);
        // m.date: the envelope's date as imapflow gives it, which is the header's text when it couldn't parse it.
        if (query.envelope) row.envelope = { subject: m.subject, messageId: `<${m.uid}@x>`, from: [{ name: '', address: 'a@x' }], to: [], cc: [], replyTo: [], date: 'date' in m ? m.date : new Date(2026, 9, m.uid) };
        if (query.bodyStructure) row.bodyStructure = { type: 'text/plain', part: '1', size: 10, encoding: '7bit' };
        if (query.internalDate) row.internalDate = 'internalDate' in m ? m.internalDate : new Date(2026, 9, m.uid);
        if (query.size) row.size = 100 + m.uid;
        if (query.bodyParts) row.bodyParts = new Map([['1', Buffer.from(`preview of ${m.uid}`)]]);
        if (query.headers) row.headers = Buffer.from(fields(m.headers, query.headers));
        yield row;
      }
    }
  };
  return { client, asked };
}

// A message as the cache holds it, with its References (none) as Rukoo keeps them now.
const stored = (uid, subject) => ({ uid, messageId: `<${uid}@x>`, inReplyTo: null, subject, from: { name: '', address: 'a@x' }, to: [], cc: [], replyTo: [], date: 1, preview: `kept ${uid}`, hasAttachments: false, size: 1, unread: true, starred: false, answered: false, references: [] });
// The same, cached before Rukoo kept References.
const storedBefore = (uid, subject) => {
  const m = stored(uid, subject);
  delete m.references;
  return m;
};
const REFERENCES = { query: ['headers'], byUid: true, headers: ['references'] };

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
  assert.deepEqual(asked.slice(2), [{ range: '5', query: ['bodyParts'], byUid: true }, { range: '5', ...REFERENCES }], 'and a preview and the References for the new one');
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

test('a message whose structure could not be read lists by its envelope, and the next sync only asks its flags', async () => {
  const messages = [
    { uid: 3, subject: 'plain', flags: [] },
    { uid: 4, subject: 'deeply nested', flags: ['\\Seen'], nested: true },
    { uid: 5, subject: 'nested and moved away', flags: [], nested: true, goneBeforeDetails: true }
  ];
  const { client, asked } = folder(messages);
  const s = session(client);
  const res = await s.syncFolder('INBOX', { limit: 10, known: new Map(), uidValidity: '9' });
  assert.deepEqual(asked[1], { range: '3,4,5', query: ['envelope', 'bodyStructure', 'internalDate', 'size'], byUid: true });
  assert.deepEqual(asked[2], { range: '4,5', query: ['envelope', 'internalDate', 'size'], byUid: true });
  assert.deepEqual(asked[3], { range: '3', query: ['bodyParts'], byUid: true }, 'a preview only for the one with a structure');
  assert.deepEqual(asked[4], { range: '3:5', ...REFERENCES });
  assert.equal(asked.length, 5);
  assert.deepEqual(res.messages.map((m) => m.uid), [3, 4], 'one gone meanwhile is still left out');
  const nested = res.messages[1];
  assert.equal(nested.subject, 'deeply nested');
  assert.equal(nested.size, 104);
  assert.equal(nested.preview, '');
  assert.equal(nested.hasAttachments, false);
  assert.equal(nested.unread, false);

  // Cached now, it is not asked for again. The one that moved is no longer in the folder.
  messages.pop();
  client.mailbox.exists = messages.length;
  asked.length = 0;
  const again = await s.syncFolder('INBOX', { limit: 10, known: new Map(res.messages.map((m) => [m.uid, m])), uidValidity: '9' });
  assert.deepEqual(asked, [{ range: '1:*', query: ['flags'], byUid: false }]);
  assert.deepEqual(again.messages.map((m) => [m.uid, m.subject]), [[3, 'plain'], [4, 'deeply nested']]);
});

test('a Date header no parser reads gives an email the date the server received it, and an email cached without a date is described again', async () => {
  const received = new Date(2026, 10, 3, 9, 30);
  const { client, asked } = folder([
    { uid: 3, subject: 'unreadable date', flags: [], date: 'Mon, 32 Foo 2026 25:61:00 +0000', internalDate: received },
    { uid: 4, subject: 'no date at all', flags: [], date: undefined, internalDate: received },
    { uid: 5, subject: 'neither readable', flags: [], date: 'garbage', internalDate: 'garbage too' },
    { uid: 6, subject: 'cached without a date', flags: [], date: 'still garbage', internalDate: received },
    { uid: 7, subject: 'cached fine', flags: [] }
  ]);
  const s = session(client);
  const before = Date.now();
  // An earlier Rukoo stored NaN for uid 6, which the cache file kept as null.
  const known = new Map([
    [6, { ...stored(6, 'cached without a date'), date: null }],
    [7, stored(7, 'cached fine')]
  ]);
  const res = await s.syncFolder('INBOX', { limit: 10, known, uidValidity: '9' });
  assert.deepEqual(asked[1], { range: '3,4,5,6', query: ['envelope', 'bodyStructure', 'internalDate', 'size'], byUid: true }, 'uid 6 is described again, uid 7 is not');
  const byUid = new Map(res.messages.map((m) => [m.uid, m]));
  assert.equal(byUid.get(3).date, received.getTime());
  assert.equal(byUid.get(4).date, received.getTime());
  assert.ok(byUid.get(5).date >= before && byUid.get(5).date <= Date.now(), 'with no readable date at all, when Rukoo first saw it');
  assert.equal(byUid.get(6).date, received.getTime());
  assert.equal(byUid.get(7).date, 1, 'a cached date stays');
  for (const m of res.messages) assert.ok(Number.isFinite(m.date), `uid ${m.uid} has a date`);
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
  const headers = asked.find((a) => a.headers && a.headers.includes('list-id'));
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

test('a sync of another folder asks for neither mail kinds nor tabs, only the References line', async () => {
  const { client, asked } = folder([{ uid: 3, subject: 'sent', flags: [], headers: 'List-Id: <l@x>\r\nReferences: <a@x>\r\n' }]);
  client.search = async () => assert.fail('no search');
  const s = session(client);
  const res = await s.syncFolder('Sent', { limit: 10, known: new Map(), uidValidity: '9' });
  assert.deepEqual(asked.filter((a) => a.query.includes('headers')), [{ range: '3', ...REFERENCES }]);
  assert.equal('signals' in res.messages[0], false);
  assert.deepEqual(res.messages[0].references, ['<a@x>']);
  assert.equal('olderUnseen' in res, false);
});

// #230: related emails find a later reply that names the open one only in its References.
test('a sync fetches the References line once for messages cached before Rukoo kept it, without their envelopes', async () => {
  const long = Array.from({ length: 60 }, (_, i) => `<r${i + 1}@x>`).join(' ');
  const { client, asked } = folder([
    // Folded over two lines, as long headers are, next to other header lines.
    { uid: 3, subject: 'old reply', flags: [], headers: 'Subject: old reply\r\nReferences: <a@x>\r\n <b@x>\r\nList-Id: <l@x>\r\n' },
    { uid: 4, subject: 'old, no References', flags: ['\\Seen'] },
    { uid: 5, subject: 'new, long thread', flags: [], headers: `References: ${long}\r\n` }
  ]);
  const s = session(client);
  const known = new Map([
    [3, storedBefore(3, 'old reply')],
    [4, storedBefore(4, 'old, no References')]
  ]);
  const res = await s.syncFolder('INBOX', { limit: 10, known, uidValidity: '9' });
  const envelopes = asked.filter((a) => a.query.includes('envelope'));
  assert.deepEqual(envelopes.map((a) => a.range), ['5'], 'the cached window is not fetched again');
  assert.deepEqual(asked.filter((a) => a.query.includes('headers')), [{ range: '3:5', ...REFERENCES }], 'one header fetch for the window');
  const byUid = new Map(res.messages.map((m) => [m.uid, m]));
  assert.deepEqual(byUid.get(3).references, ['<a@x>', '<b@x>']);
  assert.equal(byUid.get(3).subject, 'old reply', 'the rest comes from the cache');
  assert.deepEqual(byUid.get(4).references, [], 'none, so not asked again');
  assert.equal(byUid.get(5).references.length, 50, 'the newest 50 of a long thread');
  assert.deepEqual([byUid.get(5).references[0], byUid.get(5).references[49]], ['<r11@x>', '<r60@x>']);

  // The next sync asks for nothing but the flags.
  asked.length = 0;
  const again = await s.syncFolder('INBOX', { limit: 10, known: byUid, uidValidity: '9' });
  assert.deepEqual(asked, [{ range: '1:*', query: ['flags'], byUid: false }]);
  assert.deepEqual(again.messages.find((m) => m.uid === 3).references, ['<a@x>', '<b@x>']);

  // A server search keeps what the cache has and asks for no References.
  asked.length = 0;
  client.search = async () => [3, 4];
  const found = await s.searchFolder('INBOX', 'old', { known: byUid, uidValidity: '9' });
  assert.ok(!asked.some((a) => a.query.includes('headers')));
  assert.deepEqual(found.messages.find((m) => m.uid === 3).references, ['<a@x>', '<b@x>']);
});

test('uid sets put runs of uids in one range and split before a command line gets too long', () => {
  assert.deepEqual(uidSets([9, 1, 2, 3, 5, 3]), ['1:3,5,9']);
  assert.deepEqual(uidSets([]), []);
  const many = Array.from({ length: 3000 }, (_, i) => 1000000 + 2 * i);
  const sets = uidSets(many);
  assert.ok(sets.length > 1);
  assert.ok(sets.every((set) => set.length <= 4000));
  assert.deepEqual(sets.join(',').split(',').map(Number), many);
});

// #242: marking 300 emails read was 300 round trips, each with its own mailbox lock.
test('flags for many messages of a folder go in one STORE per flag under one lock, and a refused STORE throws', async () => {
  const log = [];
  let answer;
  const client = {
    usable: true,
    getMailboxLock: async (path) => {
      log.push(`lock ${path}`);
      return { release: () => log.push('release') };
    },
    messageFlagsAdd: async (set, flags, opts) => {
      log.push(`+${flags.join(' ')} ${set} ${opts.uid ? 'uid' : 'seq'}`);
      return answer;
    },
    messageFlagsRemove: async (set, flags, opts) => {
      log.push(`-${flags.join(' ')} ${set} ${opts.uid ? 'uid' : 'seq'}`);
      return answer;
    }
  };
  const s = session(client);
  answer = true;
  await s.setFlagsMany('INBOX', [3, 1, 2, 7], { unread: false, starred: true });
  assert.deepEqual(log, ['lock INBOX', '+\\Seen 1:3,7 uid', '+\\Flagged 1:3,7 uid', 'release']);

  log.length = 0;
  await s.setFlags('INBOX', 8, { unread: true, starred: false, answered: true });
  assert.deepEqual(log, ['lock INBOX', '-\\Seen 8 uid', '-\\Flagged 8 uid', '+\\Answered 8 uid', 'release']);

  // More uids than one command line holds: a few STOREs, still one lock.
  log.length = 0;
  await s.setFlagsMany('INBOX', Array.from({ length: 3000 }, (_, i) => 1000000 + 2 * i), { unread: false });
  assert.equal(log.filter((l) => l.startsWith('lock')).length, 1);
  assert.ok(log.filter((l) => l.startsWith('+')).length > 1);

  // imapflow answers false for a STORE the server turned down.
  log.length = 0;
  answer = false;
  await assert.rejects(s.setFlagsMany('INBOX', [1, 2], { unread: false }), { message: t('errors.flags.refused'), stored: [] });
  assert.deepEqual(log, ['lock INBOX', '+\\Seen 1:2 uid', 'release']);

  // Refused halfway, on the second command line: the error names the uids the first one stored.
  const sparse = Array.from({ length: 3000 }, (_, i) => 1000000 + 2 * i);
  let calls = 0;
  client.messageFlagsAdd = async () => ++calls === 1;
  const err = await s.setFlagsMany('INBOX', sparse, { unread: false }).catch((e) => e);
  assert.equal(err.message, t('errors.flags.refused'));
  const first = uidSets(sparse)[0].split(',').map(Number);
  assert.deepEqual(err.stored, first);
  assert.ok(first.length > 0 && first.length < sparse.length);
});

// #308: moves and deletes. A stand-in for imapflow that logs what it is asked, in the folder it has open. The email
// has flags, or is gone when flags is null. move and copy: what messageMove and messageCopy answer (a function runs
// instead). deletes: what each messageDelete does, in turn: true (the email is gone), false (\Deleted is set and the
// EXPUNGE fails), 'unstored' (the STORE fails too, so no flag) or a function. unflag: whether taking \Deleted off works.
// uidNext: what each STATUS of the destination says, in turn; an Error throws.
function mover({ caps = ['IMAP4rev1', 'MOVE', 'UIDPLUS'], enabled = [], move = null, copy = null, deletes = [], unflag = true, flags = [], uidNext = ['40', '40'] } = {}) {
  const log = [];
  let current = flags && new Set(flags);
  const client = {
    usable: true,
    capabilities: new Map(caps.map((c) => [c, true])),
    enabled: new Set(enabled),
    mailbox: null,
    getMailboxLock: async (path) => {
      client.mailbox = { path, uidValidity: path === 'Archive' ? 9n : 3n };
      log.push(`lock ${path}`);
      return { release: () => log.push(`release ${path}`) };
    },
    status: async (path) => {
      log.push(`STATUS ${path}`);
      const next = uidNext.shift();
      if (next instanceof Error) throw next;
      return next == null ? { path } : { path, uidNext: Number(next) };
    },
    messageMove: async (set, destination) => {
      log.push(`MOVE ${set} ${destination}`);
      return typeof move === 'function' ? move() : move;
    },
    messageCopy: async (set, destination) => {
      log.push(`COPY ${set} ${destination}`);
      return typeof copy === 'function' ? copy() : copy;
    },
    messageDelete: async (set) => {
      log.push(`delete ${set} in ${client.mailbox.path}`);
      const answer = deletes.shift();
      if (typeof answer === 'function') return answer();
      if (answer === true) current = null;
      else if (answer === false && current) current.add('\\Deleted');
      return answer === true;
    },
    messageFlagsRemove: async (set, list) => {
      log.push(`-${list.join(' ')} ${set}`);
      if (unflag && current) for (const flag of list) current.delete(flag);
      return unflag;
    },
    fetchOne: async (set, query) => {
      log.push(`${query.flags ? 'flags' : 'uid'} ${set}`);
      return current && { uid: Number(set), flags: new Set(current) };
    }
  };
  // gone(): another app expunged the email.
  return { log, client, s: session(client), gone: () => (current = null), flags: () => current };
}
// What imapflow gives for a COPY or MOVE with UIDPLUS: uid became to in Archive.
const copyUid = (uid, to) => ({ path: 'INBOX', destination: 'Archive', uidValidity: 9n, uidMap: new Map([[uid, to]]) });

test('a MOVE the server turns down throws refused once Rukoo has checked that nothing changed', async () => {
  let m = mover({ move: copyUid(5, 41) });
  assert.deepEqual(await m.s.move('INBOX', 5, 'Archive'), { uid: 41, uidValidity: '9' });
  assert.deepEqual(m.log, ['lock INBOX', 'STATUS Archive', 'MOVE 5 Archive', 'release INBOX']);

  // imapflow answers false for a NO. The email is still in Inbox and Archive's UIDNEXT didn't move: nothing changed.
  m = mover({ move: false });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), { message: t('errors.move.refused'), refused: true });
  assert.deepEqual(m.log, ['lock INBOX', 'STATUS Archive', 'MOVE 5 Archive', 'uid 5', 'STATUS Archive', 'release INBOX']);

  // A throw from messageMove is checked the same way.
  m = mover({
    move: () => {
      throw new Error('Socket closed');
    }
  });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), { message: t('errors.move.refused'), refused: true });
});

test('a MOVE whose result is unknown throws unknown, never refused', async () => {
  const unknown = { message: t('errors.move.unknown'), unknown: true };
  // An untagged COPYUID and then a tagged NO: the original stayed, but Archive's UIDNEXT moved, so there may be a copy.
  let m = mover({ move: false, uidNext: ['40', '41'] });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), (err) => err.message === unknown.message && err.unknown && !err.refused);

  // The original left Inbox: the server may well have moved it.
  m = mover({
    move: () => {
      m.gone();
      return false;
    }
  });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), unknown);

  // The connection closed before the answer.
  m = mover({
    move: () => {
      m.client.usable = false;
      return false;
    }
  });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), unknown);
  assert.deepEqual(m.log, ['lock INBOX', 'STATUS Archive', 'MOVE 5 Archive', 'release INBOX']);

  // A throw after the command went out, with the connection gone.
  m = mover({
    move: () => {
      m.client.usable = false;
      throw new Error('Connection closed');
    }
  });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), unknown);

  // Without Archive's UIDNEXT from before, nothing proves the server didn't add the email there.
  m = mover({ move: false, uidNext: [new Error('NO'), '40'] });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), unknown);
  m = mover({ move: false, uidNext: [null, '40'] });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), unknown);
  // Nor without the email read back in Inbox.
  m = mover({ move: false });
  m.client.fetchOne = async () => {
    throw new Error('Command failed');
  };
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), unknown);
});

// RFC 9051 makes MOVE part of IMAP4rev2, so a server of that version alone needn't list it. imapflow's messageMove
// sends MOVE to such a server, and Rukoo mustn't take the COPY-and-delete way there.
test('an IMAP4rev2 server gets MOVE without the MOVE capability, as imapflow decides it', async () => {
  let m = mover({ caps: ['IMAP4rev2', 'UIDPLUS'], move: copyUid(5, 41) });
  assert.deepEqual(await m.s.move('INBOX', 5, 'Archive'), { uid: 41, uidValidity: '9' });
  assert.ok(m.log.includes('MOVE 5 Archive') && !m.log.some((l) => l.startsWith('COPY')));

  // A server of both versions, with IMAP4rev2 enabled.
  m = mover({ caps: ['IMAP4rev1', 'IMAP4rev2', 'UIDPLUS'], enabled: ['IMAP4REV2'], move: copyUid(5, 41) });
  await m.s.move('INBOX', 5, 'Archive');
  assert.ok(m.log.includes('MOVE 5 Archive') && !m.log.some((l) => l.startsWith('COPY')));

  // The same server with IMAP4rev2 not enabled runs as IMAP4rev1, without MOVE.
  m = mover({ caps: ['IMAP4rev1', 'IMAP4rev2', 'UIDPLUS'], copy: copyUid(5, 41), deletes: [true] });
  await m.s.move('INBOX', 5, 'Archive');
  assert.ok(m.log.includes('COPY 5 Archive') && !m.log.some((l) => l.startsWith('MOVE')));
});

test('a delete for good that fails takes off only a \\Deleted it set itself', async () => {
  let m = mover({ deletes: [true] });
  await m.s.deleteForever('Trash', 7);
  assert.deepEqual(m.log, ['lock Trash', 'flags 7', 'delete 7 in Trash', 'release Trash']);

  // The EXPUNGE refused after this delete set \Deleted: the flag comes off again.
  m = mover({ deletes: [false] });
  await assert.rejects(m.s.deleteForever('Trash', 7), { message: t('errors.delete.refused'), refused: true });
  assert.deepEqual(m.log, ['lock Trash', 'flags 7', 'delete 7 in Trash', 'flags 7', '-\\Deleted 7', 'flags 7', 'release Trash']);
  assert.ok(!m.flags().has('\\Deleted'));

  // The STORE refused as well: there is no flag to take off.
  m = mover({ deletes: ['unstored'] });
  await assert.rejects(m.s.deleteForever('Trash', 7), { message: t('errors.delete.refused'), refused: true });
  assert.ok(!m.log.some((l) => l.startsWith('-')));

  // Another app had marked the email before: its flag stays, and the notice says the email is still marked.
  m = mover({ deletes: [false], flags: ['\\Deleted'] });
  await assert.rejects(m.s.deleteForever('Trash', 7), { message: t('errors.delete.stillMarked'), refused: true, marked: true });
  assert.ok(!m.log.some((l) => l.startsWith('-')));
  assert.ok(m.flags().has('\\Deleted'));

  // Flags that couldn't be read first: Rukoo doesn't know who set the flag, so it stays.
  m = mover({ deletes: [false] });
  const fetchOne = m.client.fetchOne;
  let reads = 0;
  m.client.fetchOne = async (...args) => {
    if (reads++ === 0) throw new Error('Command failed');
    return fetchOne(...args);
  };
  await assert.rejects(m.s.deleteForever('Trash', 7), { message: t('errors.delete.stillMarked'), marked: true });
  assert.ok(!m.log.some((l) => l.startsWith('-')));

  // Taking the flag off failed.
  m = mover({ deletes: [false], unflag: false });
  await assert.rejects(m.s.deleteForever('Trash', 7), { message: t('errors.delete.stillMarked'), marked: true });

  // The email is gone after all, or the connection went: nobody knows what the server did.
  m = mover({
    deletes: [
      () => {
        m.gone();
        return false;
      }
    ]
  });
  await assert.rejects(m.s.deleteForever('Trash', 7), { message: t('errors.delete.unknown'), unknown: true });
  m = mover({
    deletes: [
      () => {
        m.client.usable = false;
        return false;
      }
    ]
  });
  await assert.rejects(m.s.deleteForever('Trash', 7), { message: t('errors.delete.unknown'), unknown: true });
  assert.ok(!m.log.some((l) => l.startsWith('-')));
});

test('without MOVE a failed delete after COPY keeps the copy and reports the partial move', async () => {
  const caps = ['IMAP4rev1', 'UIDPLUS'];
  let m = mover({ caps, copy: copyUid(5, 41), deletes: [true] });
  assert.deepEqual(await m.s.move('INBOX', 5, 'Archive'), { uid: 41, uidValidity: '9' });
  assert.deepEqual(m.log, ['lock INBOX', 'COPY 5 Archive', 'flags 5', 'delete 5 in INBOX', 'release INBOX']);

  // The COPY refused: nothing changed, and nothing is deleted.
  m = mover({ caps, copy: false });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), { message: t('errors.move.refused'), refused: true });
  assert.deepEqual(m.log, ['lock INBOX', 'COPY 5 Archive', 'release INBOX']);

  // The COPY's answer never came: it may have been made.
  m = mover({
    caps,
    copy: () => {
      m.client.usable = false;
      return false;
    }
  });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), { message: t('errors.move.unknown'), unknown: true });

  // The delete failed after the copy: the original's \Deleted comes off again and the copy stays.
  m = mover({ caps, copy: copyUid(5, 41), deletes: [false] });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), { message: t('errors.move.copied'), copied: true });
  assert.deepEqual(m.log, ['lock INBOX', 'COPY 5 Archive', 'flags 5', 'delete 5 in INBOX', 'flags 5', '-\\Deleted 5', 'flags 5', 'release INBOX']);

  // Unless another app had set it.
  m = mover({ caps, copy: copyUid(5, 41), deletes: [false], flags: ['\\Deleted'] });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), { copied: true });
  assert.ok(!m.log.some((l) => l.startsWith('-')));

  // The original was already expunged. An OK from STORE alone would not prove it was still present.
  m = mover({ caps, copy: copyUid(5, 41), deletes: [false], flags: null });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), { copied: true });
  assert.deepEqual(m.log, ['lock INBOX', 'COPY 5 Archive', 'flags 5', 'delete 5 in INBOX', 'flags 5', 'release INBOX']);

  // A disconnect after COPY can throw from messageDelete before it sends anything.
  m = mover({
    caps,
    copy: copyUid(5, 41),
    deletes: [
      () => {
        m.client.usable = false;
        throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
      }
    ]
  });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), { message: t('errors.move.copied'), copied: true });
  assert.deepEqual(m.log, ['lock INBOX', 'COPY 5 Archive', 'flags 5', 'delete 5 in INBOX', 'release INBOX']);

  // A server without UIDPLUS may not report the copy's new UID either.
  m = mover({ caps: ['IMAP4rev1'], copy: { path: 'INBOX', destination: 'Archive' }, deletes: [false] });
  await assert.rejects(m.s.move('INBOX', 5, 'Archive'), { copied: true });
  assert.ok(!m.log.includes('lock Archive'));
});

// The same over TCP, against the fixture mailbox, which turns commands down when told: this is what imapflow does
// with the server's answers.
const tcpAccount = (port) => new ImapAccount({ type: 'imap', email: 'me@example.test', imap: { host: '127.0.0.1', port, secure: false }, smtp: {} }, 'secret');

test('over a real connection, a refused MOVE or EXPUNGE throws and clears only its own deletion flag', async () => {
  const box = await imapMailbox({ email: 'me@example.test' });
  const s = tcpAccount(box.port);
  const inbox = box.folders.get('INBOX');
  try {
    const a = box.put('INBOX', { subject: 'Stays' });
    box.refuse((command) => /^UID MOVE /i.test(command));
    await assert.rejects(s.move('INBOX', a.uid, 'Archive'), { message: t('errors.move.refused'), refused: true });
    assert.deepEqual(inbox.messages.map((m) => m.subject), ['Stays']);
    assert.equal(box.folders.get('Archive').messages.length, 0);

    box.refuse((command) => /^UID EXPUNGE /i.test(command));
    await assert.rejects(s.deleteForever('INBOX', a.uid), { message: t('errors.delete.refused') });
    assert.deepEqual(inbox.messages.map((m) => m.subject), ['Stays']);
    assert.ok(!inbox.messages[0].flags.has('\\Deleted'), 'a later expunge must not delete the restored email');

    // Another app marked it for deletion first. Rukoo leaves that flag alone and says so.
    inbox.messages[0].flags.add('\\Deleted');
    const sent = box.commands.length;
    await assert.rejects(s.deleteForever('INBOX', a.uid), { message: t('errors.delete.stillMarked') });
    assert.ok(inbox.messages[0].flags.has('\\Deleted'));
    assert.ok(box.commands.slice(sent).some((c) => /^UID EXPUNGE /i.test(c)));
    assert.ok(!box.commands.slice(sent).some((c) => /^UID STORE \S+ -FLAGS/i.test(c)));
    inbox.messages[0].flags.delete('\\Deleted');

    box.refuse(null);
    assert.equal((await s.move('INBOX', a.uid, 'Archive')).uidValidity, '7');
    assert.equal(inbox.messages.length, 0);
  } finally {
    await s.close();
    await box.close();
  }
});

test('over a real connection, a MOVE that copied before its NO, or lost its answer, is unknown', async () => {
  const box = await imapMailbox({ email: 'me@example.test' });
  const s = tcpAccount(box.port);
  const inbox = box.folders.get('INBOX');
  const archive = box.folders.get('Archive');
  try {
    const a = box.put('INBOX', { subject: 'Copied' });
    // * OK [COPYUID ...] and then a NO: the server made a copy and kept the original.
    box.refuse((command) => (/^UID MOVE /i.test(command) ? 'copied' : false));
    await assert.rejects(s.move('INBOX', a.uid, 'Archive'), (err) => err.message === t('errors.move.unknown') && err.unknown && !err.refused);
    assert.deepEqual(inbox.messages.map((m) => m.subject), ['Copied']);
    assert.deepEqual(archive.messages.map((m) => m.subject), ['Copied']);

    // The server moved it and the connection closed before the answer.
    const b = box.put('INBOX', { subject: 'Dropped' });
    box.refuse((command) => (/^UID MOVE /i.test(command) ? 'drop' : false));
    await assert.rejects(s.move('INBOX', b.uid, 'Archive'), { message: t('errors.move.unknown'), unknown: true });
    assert.ok(!inbox.messages.some((m) => m.subject === 'Dropped'));
    assert.ok(archive.messages.some((m) => m.subject === 'Dropped'));
  } finally {
    await s.close();
    await box.close();
  }
});

test('over a real connection, a server of IMAP4rev2 alone gets UID MOVE', async () => {
  const box = await imapMailbox({ email: 'me@example.test', rev: 'IMAP4rev2', capabilities: ['UIDPLUS'] });
  const s = tcpAccount(box.port);
  try {
    const a = box.put('INBOX', { subject: 'Moves' });
    assert.equal((await s.move('INBOX', a.uid, 'Archive')).uidValidity, '7');
    assert.ok(box.commands.some((c) => /^UID MOVE /i.test(c)));
    assert.ok(!box.commands.some((c) => /^UID COPY /i.test(c)));
    assert.deepEqual(box.folders.get('Archive').messages.map((m) => m.subject), ['Moves']);
    assert.equal(box.folders.get('INBOX').messages.length, 0);
  } finally {
    await s.close();
    await box.close();
  }
});

test('over a real connection, a server without MOVE keeps the copy when the EXPUNGE is refused', async () => {
  const old = await imapMailbox({ email: 'me@example.test', capabilities: ['UIDPLUS'] });
  const s2 = tcpAccount(old.port);
  try {
    const b = old.put('INBOX', { subject: 'Moves later' });
    // Inbox turns the EXPUNGE down after the copy.
    old.refuse((command, folder) => /EXPUNGE/i.test(command) && folder === 'INBOX');
    await assert.rejects(s2.move('INBOX', b.uid, 'Archive'), { message: t('errors.move.copied'), copied: true });
    assert.ok(old.commands.some((c) => /^UID COPY /i.test(c)));
    assert.ok(!old.commands.some((c) => /^UID MOVE /i.test(c)));
    assert.deepEqual(old.folders.get('Archive').messages.map((m) => m.subject), ['Moves later']);
    assert.deepEqual(old.folders.get('INBOX').messages.map((m) => [m.subject, m.flags.has('\\Deleted')]), [['Moves later', false]]);

    // With the copy in Archive, a user can delete the original when the server allows it.
    old.refuse(null);
    await s2.deleteForever('INBOX', b.uid);
    assert.equal(old.folders.get('INBOX').messages.length, 0);
    assert.deepEqual(old.folders.get('Archive').messages.map((m) => m.subject), ['Moves later']);
  } finally {
    await s2.close();
    await old.close();
  }
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

// #112: Load older widens the window while a sync waits for the connection, so the sync reads it when it runs.
test('a sync reads a window given as a function when its command runs', async () => {
  const { client, asked } = folder([3, 4, 5, 6].map((uid) => ({ uid, subject: `m${uid}`, flags: [] })));
  const s = session(client);
  let size = 1;
  let finish;
  s.run(() => new Promise((resolve) => (finish = resolve)));
  const sync = s.syncFolder('INBOX', { limit: () => size, background: true });
  await tick();
  size = 3;
  finish();
  assert.deepEqual((await sync).messages.map((m) => m.uid), [4, 5, 6]);
  assert.equal(asked[0].range, '2:*');
});

// #112: older mail a server search found stays current, read or deleted on another device.
test('a sync asks the flags of the older uids it keeps, leaves out the ones gone, and asks nothing for other uids', async () => {
  const { client, asked } = folder([1, 2, 3, 5, 6].map((uid) => ({ uid, subject: `m${uid}`, flags: uid === 2 ? ['\\Seen', '\\Flagged'] : [] })));
  const s = session(client);
  const known = new Map([5, 6].map((uid) => [uid, stored(uid, `m${uid}`)]));
  // The window is 5 and 6; 6 is in it, and 4 is gone from the server.
  const res = await s.syncFolder('INBOX', { limit: 2, known, uidValidity: '9', keep: () => [2, 3, 4, 6] });
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[1], { range: '2,3,4', query: ['flags'], byUid: true });
  assert.deepEqual(res.kept, [
    { uid: 2, unread: false, starred: true, answered: false },
    { uid: 3, unread: true, starred: false, answered: false }
  ]);
  assert.deepEqual(res.messages.map((m) => m.uid), [5, 6]);

  // After a UIDVALIDITY change, or on a first sync, those uids are other messages: nothing is asked.
  for (const uidValidity of ['8', null]) {
    asked.length = 0;
    const other = await s.syncFolder('INBOX', { limit: 2, known, uidValidity, keep: [2, 3] });
    assert.equal('kept' in other, false);
    assert.ok(!asked.some((a) => a.range === '2,3'));
  }

  // A server that doesn't answer leaves kept null, so the cache keeps what it had.
  const fetch = client.fetch;
  client.fetch = function (range, ...rest) {
    if (range === '3') throw new Error('BAD');
    return fetch.call(this, range, ...rest);
  };
  assert.equal((await s.syncFolder('INBOX', { limit: 2, known, uidValidity: '9', keep: [3] })).kept, null);
});

// #112: the search of older mail than the cache holds.
test('a server search looks below the window at the subject and addresses, and describes only the newest matches', async () => {
  const { client, asked } = folder([1, 2, 3, 4, 5, 6, 7, 8].map((uid) => ({ uid, subject: `m${uid}`, flags: uid === 5 ? ['\\Seen'] : [] })));
  const searched = [];
  client.search = async (query, opts) => {
    searched.push({ query, opts });
    return [2, 3, 5, 6];
  };
  const s = session(client);
  const known = new Map([[6, stored(6, 'found before')]]);
  const res = await s.searchFolder('Archive', 'Invoice', { below: 7, limit: 2, known, uidValidity: '9', criteria: { seen: false } });
  const words = [{ subject: 'Invoice' }, { from: 'Invoice' }, { to: 'Invoice' }, { cc: 'Invoice' }];
  assert.deepEqual(searched, [{ query: { seen: false, uid: '1:6', or: words }, opts: { uid: true } }]);
  assert.equal(res.total, 4);
  assert.equal(res.uidValidity, '9');
  // The flags of the two newest, then the rest only for the one the cache didn't have.
  assert.deepEqual(asked[0], { range: '6,5', query: ['flags'], byUid: true });
  assert.deepEqual(asked[1], { range: '5', query: ['envelope', 'bodyStructure', 'internalDate', 'size'], byUid: true });
  const byUid = new Map(res.messages.map((m) => [m.uid, m]));
  assert.deepEqual([...byUid.keys()].sort(), [5, 6]);
  assert.equal(byUid.get(6).subject, 'found before');
  assert.equal(byUid.get(5).subject, 'm5');
  assert.equal(byUid.get(5).unread, false, 'with the flags from the server');

  // A folder rebuilt since (another UIDVALIDITY) reuses nothing.
  asked.length = 0;
  await s.searchFolder('Archive', 'Invoice', { below: 7, limit: 2, known, uidValidity: '8' });
  assert.equal(asked[1].range, '5,6');

  // Nothing is below the first uid, so nothing is asked.
  client.search = async () => assert.fail('no search');
  assert.deepEqual(await s.searchFolder('Archive', 'Invoice', { below: 1 }), { uidValidity: '9', total: 0, messages: [] });
});

test("a server search uses Gmail's own search, falls back to the plain one, and says when the server refuses", async () => {
  const { client } = folder([{ uid: 4, subject: 'Invoice March', flags: [] }]);
  client.capabilities = new Map([['X-GM-EXT-1', true]]);
  const searched = [];
  let gmail = async () => [4];
  client.search = async (query) => {
    searched.push(query);
    return query.gmraw ? gmail() : [4];
  };
  const s = session(client);
  const res = await s.searchFolder('[Gmail]/All Mail', 'invoice march');
  assert.deepEqual(searched, [{ uid: '1:*', gmraw: 'invoice march' }]);
  assert.deepEqual(res.messages.map((m) => m.subject), ['Invoice March']);

  // Gmail's search failing, or refused, gives the plain search.
  for (const failing of [async () => Promise.reject(new Error('BAD')), async () => false]) {
    searched.length = 0;
    gmail = failing;
    assert.equal((await s.searchFolder('INBOX', 'march')).total, 1);
    assert.deepEqual(searched.map((q) => Object.keys(q).sort()), [['gmraw', 'uid'], ['or', 'uid']]);
  }

  // Spam and Trash get the plain search: Gmail's own leaves them out unless asked.
  searched.length = 0;
  gmail = async () => [4];
  await s.searchFolder('[Gmail]/Trash', 'march', { gmail: false });
  assert.deepEqual(searched.map((q) => Object.keys(q).sort()), [['or', 'uid']]);

  // A plain search the server refuses fails with a reason.
  client.capabilities = new Map();
  client.search = async () => false;
  await assert.rejects(s.searchFolder('INBOX', 'march'), { message: t('errors.search.refused') });
});

// #112 with the deeply nested messages of a sync: an older match imapflow can't read the structure of is still found.
test('a server search lists a deeply nested match by its envelope', async () => {
  const { client, asked } = folder([
    { uid: 2, subject: 'Invoice plain', flags: [] },
    { uid: 3, subject: 'Invoice nested', flags: ['\\Seen'], nested: true }
  ]);
  client.search = async () => [2, 3];
  const res = await session(client).searchFolder('INBOX', 'invoice', { below: 9 });
  assert.deepEqual(asked[2], { range: '3', query: ['envelope', 'internalDate', 'size'], byUid: true });
  assert.equal(res.total, 2);
  const byUid = new Map(res.messages.map((m) => [m.uid, m]));
  assert.deepEqual([...byUid.keys()].sort(), [2, 3]);
  assert.equal(byUid.get(3).subject, 'Invoice nested');
  assert.equal(byUid.get(3).preview, '');
  assert.equal(byUid.get(3).hasAttachments, false);
  assert.equal(byUid.get(3).unread, false);
});

test('over a real connection, a message nested too deep for imapflow lists by its envelope and stays cached', async () => {
  const server = await imapServer({
    mailbox: {
      path: 'INBOX',
      uidValidity: 9,
      messages: [
        { uid: 7, flags: ['\\Seen'], subject: 'Plain one', size: 120, bodyStructure: textStructure(11), parts: { 1: 'Hello there' } },
        { uid: 8, flags: [], subject: 'Nested one', from: ['Nest', 'nest@example.com'], size: 900, bodyStructure: nestedStructure(30) }
      ]
    }
  });
  const s = new ImapAccount({ type: 'imap', email: 'me@example.com', imap: { host: '127.0.0.1', port: server.port, secure: false }, smtp: {} }, 'secret');
  try {
    const res = await s.syncFolder('INBOX', { limit: 10 });
    const byUid = new Map(res.messages.map((m) => [m.uid, m]));
    assert.deepEqual([...byUid.keys()], [7, 8]);
    assert.equal(byUid.get(7).preview, 'Hello there');
    const nested = byUid.get(8);
    assert.equal(nested.subject, 'Nested one');
    assert.deepEqual(nested.from, { name: 'Nest', address: 'nest@example.com' });
    assert.equal(nested.size, 900);
    assert.equal(nested.preview, '');
    assert.equal(nested.hasAttachments, false);
    assert.equal(nested.unread, true);
    const fetches = server.commands.filter((c) => /^UID FETCH/i.test(c));
    assert.match(fetches[0], /^UID FETCH 7,8 .*BODYSTRUCTURE/i);
    assert.match(fetches[1], /^UID FETCH 8 /i);
    assert.doesNotMatch(fetches[1], /BODYSTRUCTURE/i);

    // The next sync asks only the flags.
    server.commands.length = 0;
    const again = await s.syncFolder('INBOX', { limit: 10, known: byUid, uidValidity: res.uidValidity });
    assert.deepEqual(again.messages.map((m) => [m.uid, m.subject]), [[7, 'Plain one'], [8, 'Nested one']]);
    assert.deepEqual(server.commands.filter((c) => /FETCH/i.test(c)).map((c) => c.split(' ')[0]), ['FETCH']);
  } finally {
    await s.close();
    await server.close();
  }
});

test('over a real connection, an unreadable Date header gives the INTERNALDATE, and the next sync only asks the flags', async () => {
  const server = await imapServer({
    mailbox: {
      path: 'INBOX',
      uidValidity: 9,
      messages: [
        { uid: 7, flags: [], subject: 'Odd date', date: 'Tue, 31 Febtember 2026 99:99:99 +9999', internalDate: '05-Nov-2026 08:15:00 +0000', size: 120, bodyStructure: textStructure(11), parts: { 1: 'Hello there' } },
        { uid: 8, flags: [], subject: 'Good date', size: 120, bodyStructure: textStructure(11), parts: { 1: 'Hello again' } }
      ]
    }
  });
  const s = new ImapAccount({ type: 'imap', email: 'me@example.com', imap: { host: '127.0.0.1', port: server.port, secure: false }, smtp: {} }, 'secret');
  try {
    const res = await s.syncFolder('INBOX', { limit: 10 });
    const byUid = new Map(res.messages.map((m) => [m.uid, m]));
    assert.equal(byUid.get(7).date, Date.UTC(2026, 10, 5, 8, 15));
    assert.equal(byUid.get(8).date, Date.UTC(2026, 10, 7, 10, 0));
    // As the cache file keeps it: a date that is a number.
    const cached = new Map(JSON.parse(JSON.stringify(res.messages)).map((m) => [m.uid, m]));
    assert.equal(cached.get(7).date, Date.UTC(2026, 10, 5, 8, 15));
    server.commands.length = 0;
    const again = await s.syncFolder('INBOX', { limit: 10, known: cached, uidValidity: res.uidValidity });
    assert.deepEqual(server.commands.filter((c) => /FETCH/i.test(c)).map((c) => c.split(' ')[0]), ['FETCH']);
    assert.equal(again.messages[0].date, Date.UTC(2026, 10, 5, 8, 15));
  } finally {
    await s.close();
    await server.close();
  }
});

// ---------- signing in ----------

// An account on the test IMAP server. Its SMTP check is a stand-in that passes, or throws smtpError.
function signIn(port, account, { smtpError = null } = {}) {
  const s = new ImapAccount({ type: 'imap', email: 'me@gmail.com', imap: { host: '127.0.0.1', port, secure: false, user: 'me@gmail.com' }, smtp: {}, ...account }, 'normal-password');
  s.transport = async () => ({
    verify: async () => {
      if (smtpError) throw smtpError;
    },
    close() {}
  });
  return s;
}

test('Gmail turning down a normal password says to use an app password, as a refused sign-in', async () => {
  const server = await imapServer({ login: GMAIL_APP_PASSWORD_REQUIRED });
  try {
    // code 'auth' keeps the setup form from opening the server fields; the message has no "IMAP: " in front.
    // appPasswordProvider tells the form which provider's app password page to link to.
    await assert.rejects(signIn(server.port, { provider: 'google' }).verify(), { code: 'auth', appPasswordProvider: 'google', message: t('errors.connection.googleAppPassword') });
    assert.match(server.logins[0], /LOGIN "?me@gmail\.com"? "?normal-password"?/);
    await assert.rejects(signIn(server.port, { provider: 'yahoo' }).verify(), { code: 'auth', appPasswordProvider: 'yahoo', message: t('errors.connection.yahooAppPassword') });
    // Other servers keep the general message, after the server that gave it, and get no link.
    await assert.rejects(signIn(server.port, { provider: 'other' }).verify(), (err) => {
      assert.equal(err.code, 'auth');
      assert.equal(err.message, `IMAP: ${t('errors.connection.auth')}`);
      assert.equal('appPasswordProvider' in err, false);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('an account added under Other at Gmail or Yahoo names that provider with its refused sign-in, for the link', async () => {
  const server = await imapServer({ login: GMAIL_APP_PASSWORD_REQUIRED });
  try {
    // The account keeps the provider's server address; only the connection goes to the test server.
    const at = (host) => {
      const s = signIn(server.port, { provider: 'other', imap: { host, port: 993, secure: true, user: 'me@gmail.com' } });
      const options = s.imapOptions.bind(s);
      s.imapOptions = async () => ({ ...(await options()), host: '127.0.0.1', port: server.port, secure: false });
      return s;
    };
    await assert.rejects(at('imap.gmail.com').verify(), { code: 'auth', appPasswordProvider: 'google', message: t('errors.connection.googleAppPassword') });
    await assert.rejects(at('imap.mail.yahoo.com').verify(), { code: 'auth', appPasswordProvider: 'yahoo', message: t('errors.connection.yahooAppPassword') });
    assert.equal(server.logins.length, 2);
  } finally {
    await server.close();
  }
});

test('SMTP turning down the password is a refused sign-in too, also for the answer Gmail gives there', async () => {
  const server = await imapServer();
  try {
    await signIn(server.port, { provider: 'google' }).verify();
    const refused = Object.assign(new Error('Invalid login: 534-5.7.9 Application-specific password required.'), { code: 'EAUTH', responseCode: 534, command: 'AUTH PLAIN' });
    await assert.rejects(signIn(server.port, { provider: 'google' }, { smtpError: refused }).verify(), { code: 'auth', message: t('errors.connection.googleAppPassword') });
    await assert.rejects(signIn(server.port, { provider: 'other' }, { smtpError: refused }).verify(), { code: 'auth', message: `SMTP: ${t('errors.connection.auth')}` });
  } finally {
    await server.close();
  }
});

test('a mail server that is not there is no refused sign-in', async () => {
  // Nothing listens on port 1 and no test server can be given it, so the connection is always refused. A port freed
  // by closing a test server could be handed to a server in another test file that runs at the same time.
  const port = 1;
  await assert.rejects(signIn(port, { provider: 'google' }).verify(), (err) => {
    assert.equal(err.code, undefined);
    assert.equal(err.message, `IMAP: ${t('errors.connection.refused')}`);
    return true;
  });
});

test('the app password message goes to password accounts at Google and Yahoo, also when added under Other', () => {
  const refused = Object.assign(new Error('Command failed'), { authenticationFailed: true, response: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)' });
  const account = (extra) => ({ type: 'imap', email: 'me@example.com', provider: 'other', imap: { host: 'imap.example.com' }, ...extra });
  assert.equal(friendlyError(refused, account({ provider: 'google' })), t('errors.connection.googleAppPassword'));
  assert.equal(friendlyError(refused, account({ imap: { host: 'imap.gmail.com' } })), t('errors.connection.googleAppPassword'));
  assert.equal(friendlyError(refused, account({ imap: { host: 'imap.mail.yahoo.com' } })), t('errors.connection.yahooAppPassword'));
  // Signed in through the browser there is no password to replace. Other providers and unknown accounts keep the
  // general message.
  assert.equal(friendlyError(refused, account({ provider: 'google', auth: 'oauth2' })), t('errors.connection.auth'));
  assert.equal(friendlyError(refused, account({ provider: 'outlook', imap: { host: 'outlook.office365.com' } })), t('errors.connection.auth'));
  assert.equal(friendlyError(refused), t('errors.connection.auth'));
});
