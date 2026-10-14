'use strict';

// The command queue of ImapAccount, with the connection replaced by a stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ImapAccount } = require('../src/main/imap');

function session(client = { usable: true }) {
  const s = new ImapAccount({ email: 'me@example.com', imap: {}, smtp: {} }, 'secret');
  s.connects = 0;
  s.connect = async () => {
    if (!s.client || !s.client.usable) {
      s.client = typeof client === 'function' ? client() : client;
      s.connects++;
    }
    return s.client;
  };
  return s;
}

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

test('opening a message and marking it read keep the folder in one mode', async () => {
  const modes = [];
  const s = session({
    usable: true,
    getMailboxLock: async (path, opts = {}) => {
      modes.push(`${path} ${opts.readOnly ? 'read-only' : 'read-write'}`);
      return { release() {} };
    },
    fetchOne: async () => ({ source: Buffer.from('Subject: hi\r\n\r\nbody') }),
    messageFlagsAdd: async () => {}
  });
  await s.fetchSource('INBOX', 7);
  await s.setFlags('INBOX', 7, { unread: false });
  await s.fetchSource('INBOX', 8, { background: true });
  assert.deepEqual(modes, ['INBOX read-write', 'INBOX read-write', 'INBOX read-write']);
});
