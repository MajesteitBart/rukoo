'use strict';

// Undo send (#104): the outbox that holds an email after Send (src/main/outbox.js), with a clock the test turns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { Outbox, Handoff } = require('../src/main/outbox');
const { Engine } = require('../src/main/engine');

// Timers that only fire when the test says so.
function fakeClock() {
  let now = 1000;
  const timers = new Map();
  let next = 1;
  return {
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => {
        const id = next++;
        timers.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout: (id) => timers.delete(id)
    },
    // Moves the clock on and fires what is due, in order.
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        timers.delete(id);
        t.fn();
      }
    },
    pending: () => timers.size
  };
}

// An outbox whose sends are recorded. failWith: every send fails with it. hold: sends wait until release().
function outbox({ failWith = null, hold = false } = {}) {
  const clock = fakeClock();
  const log = [];
  const held = [];
  const box = new Outbox({
    send: async (payload) => {
      log.push(['send', payload.subject]);
      if (hold) await new Promise((resolve) => held.push(resolve));
      if (failWith) throw new Error(failWith);
    },
    sent: (entry) => log.push(['sent', entry.payload.subject, entry.origin]),
    failed: async (entry, err) => log.push(['failed', entry.payload.subject, err.message, entry.restore]),
    timers: clock.timers,
    now: clock.now
  });
  return { box, clock, log, release: () => held.splice(0).forEach((resolve) => resolve()) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an email waits for its time, then goes and runs sent()', async () => {
  const { box, clock, log } = outbox();
  const { id, until } = box.queue({ payload: { subject: 'Hi' }, restore: { html: 'x' }, origin: 'window', ms: 5000 });
  assert.equal(typeof id, 'string');
  assert.equal(until, 6000);
  assert.equal(box.size, 1);
  clock.advance(4999);
  await settle();
  assert.deepEqual(log, [], 'nothing goes before its time');
  clock.advance(1);
  await box.flush();
  assert.deepEqual(log, [['send', 'Hi'], ['sent', 'Hi', 'window']]);
  assert.equal(box.size, 0);
});

test('undo takes back a waiting email with what reopens its editor, and it never goes', async () => {
  const { box, clock, log } = outbox();
  const restore = { html: '<div>text</div>', state: { subject: 'Hi' } };
  const { id } = box.queue({ payload: { subject: 'Hi' }, restore, origin: 'main', ms: 5000 });
  const back = box.undo(id);
  assert.deepEqual(back, { payload: { subject: 'Hi' }, restore, origin: 'main' });
  assert.equal(box.size, 0);
  assert.equal(clock.pending(), 0, 'its timer is gone');
  clock.advance(10000);
  await box.flush();
  assert.deepEqual(log, []);
  assert.equal(box.undo(id), null, 'a second undo finds nothing');
  assert.equal(box.undo('no-such-id'), null);
});

test('undo is too late once the email is on its way', async () => {
  const { box, clock, log, release } = outbox({ hold: true });
  const { id } = box.queue({ payload: { subject: 'Hi' }, restore: {}, ms: 5000 });
  clock.advance(5000);
  await settle();
  assert.deepEqual(log, [['send', 'Hi']]);
  assert.equal(box.undo(id), null);
  assert.equal(box.size, 1, 'still counted while it is being sent');
  release();
  await box.flush();
  assert.deepEqual(log, [['send', 'Hi'], ['sent', 'Hi', 'main']]);
});

test('flush sends everything that waits at once, and waits for emails already on their way', async () => {
  const { box, clock, log, release } = outbox({ hold: true });
  box.queue({ payload: { subject: 'First' }, restore: {}, ms: 5000 });
  clock.advance(5000);
  box.queue({ payload: { subject: 'Second' }, restore: {}, ms: 30000 });
  let done = false;
  const flushing = box.flush().then(() => (done = true));
  await settle();
  assert.deepEqual(log, [['send', 'First'], ['send', 'Second']], 'the second goes without waiting its 30 s');
  assert.equal(clock.pending(), 0);
  assert.equal(done, false, 'flush waits until the sends are done');
  release();
  await flushing;
  assert.equal(box.size, 0);
  assert.deepEqual(log.slice(2), [['sent', 'First', 'main'], ['sent', 'Second', 'main']]);
});

test('left() lists what still waits or is on its way, for the quit to write down', async () => {
  const { box, clock, release } = outbox({ hold: true });
  const a = box.queue({ payload: { subject: 'A' }, restore: { html: 'a' }, origin: 'window', ms: 5000 });
  const b = box.queue({ payload: { subject: 'B' }, restore: { html: 'b' }, ms: 30000 });
  clock.advance(5000);
  assert.deepEqual(
    box.left().map(({ id, state, restore, origin }) => [id, state, restore.html, origin]),
    [
      [a.id, 'sending', 'a', 'window'],
      [b.id, 'waiting', 'b', 'main']
    ]
  );
  const flushing = box.flush();
  await settle();
  release();
  await flushing;
  assert.deepEqual(box.left(), []);
});

test('a refused send runs failed() with the error and the editor to reopen, and flush waits for it', async () => {
  const { box, clock, log } = outbox({ failWith: 'Mailbox full' });
  const restore = { html: '<div>keep me</div>' };
  box.queue({ payload: { subject: 'Hi' }, restore, ms: 5000 });
  clock.advance(5000);
  await box.flush();
  assert.deepEqual(log, [['send', 'Hi'], ['failed', 'Hi', 'Mailbox full', restore]]);
  assert.equal(box.size, 0);
});

test('a failing after-step does not break the outbox or reject flush', async () => {
  const clock = fakeClock();
  const box = new Outbox({
    send: async () => {},
    sent: () => {
      throw new Error('window gone');
    },
    timers: clock.timers,
    now: clock.now
  });
  box.queue({ payload: {}, restore: {}, ms: 1 });
  await box.flush();
  assert.equal(box.size, 0);
});

// ---------- refused emails held for the main window (Handoff) ----------

function handoff() {
  const clock = fakeClock();
  const elsewhere = [];
  const box = new Handoff({ ms: 15000, elsewhere: (items) => elsewhere.push(items.map((i) => i.id)), timers: clock.timers });
  return { box, clock, elsewhere };
}

test('a refused email stays held until the main window takes it, then nothing else opens it', () => {
  const { box, clock, elsewhere } = handoff();
  box.hold({ id: 'a', restore: { html: 'a' }, error: 'Mailbox full' });
  box.hold({ id: 'b', restore: { html: 'b' }, error: 'Mailbox full' });
  assert.equal(box.size, 2);
  assert.deepEqual(box.list().map((i) => i.id), ['a', 'b'], 'listed for a quit to write down');
  // A page that is still loading takes nothing yet; once it does, it gets every one, oldest first.
  clock.advance(14999);
  assert.deepEqual(box.take(), [
    { id: 'a', restore: { html: 'a' }, error: 'Mailbox full' },
    { id: 'b', restore: { html: 'b' }, error: 'Mailbox full' }
  ]);
  assert.equal(box.size, 0);
  assert.equal(clock.pending(), 0, 'their timers are gone');
  assert.deepEqual(box.take(), [], 'a second take finds nothing');
  box.letGo();
  clock.advance(60000);
  assert.deepEqual(elsewhere, []);
});

test('a refused email the main window does not take in time opens elsewhere, once', () => {
  const { box, clock, elsewhere } = handoff();
  box.hold({ id: 'a', restore: {}, error: 'x' });
  clock.advance(5000);
  box.hold({ id: 'b', restore: {}, error: 'x' });
  clock.advance(10000);
  assert.deepEqual(elsewhere, [['a']]);
  assert.deepEqual(box.list().map((i) => i.id), ['b'], 'the newer one still waits for the window');
  clock.advance(5000);
  assert.deepEqual(elsewhere, [['a'], ['b']]);
  assert.deepEqual(box.take(), []);
});

test('a main window that closes or crashes before it takes them lets every held email go elsewhere', () => {
  const { box, clock, elsewhere } = handoff();
  box.letGo();
  assert.deepEqual(elsewhere, [], 'nothing held, nothing opens');
  box.hold({ id: 'a', restore: {}, error: 'x' });
  box.hold({ id: 'b', restore: {}, error: 'x' });
  box.letGo();
  assert.deepEqual(elsewhere, [['a', 'b']]);
  assert.equal(box.size, 0);
  clock.advance(60000);
  assert.deepEqual(elsewhere, [['a', 'b']], 'their timers do not open them a second time');
});

// ---------- the setting and the checks Send makes before it waits ----------

test('Undo send is 5 seconds by default and keeps only the offered values', () => {
  const dir = tempDir('sem-undo-send-');
  const engine = new Engine({ dataDir: dir }).init();
  assert.equal(engine.settings.undoSend, 5);
  for (const v of [0, 10, 20, 30]) assert.equal(engine.updateSettings({ undoSend: v }).undoSend, v);
  assert.equal(engine.updateSettings({ undoSend: 7 }).undoSend, 5);
  assert.equal(engine.updateSettings({ undoSend: '10' }).undoSend, 5);
  engine.updateSettings({ undoSend: 20 });
  assert.equal(new Engine({ dataDir: dir }).init().settings.undoSend, 20, 'kept across restarts');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ undoSend: -1 }));
  assert.equal(new Engine({ dataDir: dir }).init().settings.undoSend, 5, 'a hand-edited value falls back to the default');
});

test('checkSend refuses what send() would, before anything is built or sent', async () => {
  const dir = tempDir('sem-undo-send-');
  const engine = new Engine({ dataDir: dir }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  assert.equal(engine.checkSend({ accountId: acc.id, to: ['a@example.com'], subject: 'x' }), engine.account(acc.id));
  assert.ok(engine.checkSend({ accountId: acc.id, to: [], bcc: [{ name: 'B', address: 'b@example.com' }] }));
  assert.throws(() => engine.checkSend({ accountId: acc.id, to: [], cc: [], subject: 'x' }), /recipient/);
  assert.throws(() => engine.checkSend({ accountId: acc.id, to: [{ name: '', address: '' }] }), /recipient/);
  assert.throws(() => engine.checkSend({ accountId: acc.id, to: ['geen-adres'] }), /Invalid/);
  assert.throws(() => engine.checkSend({ accountId: acc.id, from: 'someone@else.example', to: ['a@example.com'] }), /someone@else\.example/);
  assert.throws(() => engine.checkSend({ accountId: 'gone', to: ['a@example.com'] }));
  await engine.close();
});
