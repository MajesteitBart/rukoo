'use strict';

// held.json (src/main/heldmail.js): what Rukoo still answers for after Send, so a crash loses no email, brings none
// back twice and sends none twice (#256, #309). Each test reads the file as the next start would, at the moment a kill
// could come. Every HeldMail runs on the test's own clock, so a write tried again later, or a send or save that runs
// past its time, happens only when a test moves that clock on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { HeldMail, JournalError, BusyError, UnsureError } = require('../src/main/heldmail');
const { Outbox } = require('../src/main/outbox');
const { Engine } = require('../src/main/engine');

const restore = (subject, state = {}) => ({ opts: { mode: 'new' }, html: `<p>${subject}</p>`, state: { subject, ...state } });

function profile() {
  const dir = path.join(tempDir('sem-held-'), 'data');
  return { file: path.join(dir, 'held.json'), legacy: path.join(dir, 'unsent.json') };
}

// A clock the test turns: advance(ms) fires what is due, in order.
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    timers: {
      setTimeout: (fn, ms) => {
        const id = next++;
        timers.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout: (id) => timers.delete(id)
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        timers.delete(id);
        t.fn();
      }
    }
  };
}

// The next start: a new run that loads what the files hold.
function restart({ file, legacy }, outbox = () => [], more = {}) {
  const held = new HeldMail({ file, legacy, outbox, timers: fakeClock().timers, ...more });
  held.load();
  return held;
}

const onDisk = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
// The emails in the file, without the ids it took from unsent.json.
const emails = (file) => onDisk(file).filter((e) => e.restore);
const subjects = (file) => emails(file).map((e) => e.restore.state.subject);
const tick = () => new Promise((resolve) => setImmediate(resolve));
// What a promise came to within a few turns of the event loop: { value } or { error }, or 'pending'.
async function soon(promise) {
  let out = 'pending';
  promise.then(
    (value) => (out = { value }),
    (error) => (out = { error })
  );
  for (let i = 0; i < 5; i += 1) await tick();
  return out;
}

// A delivery the test ends: deliver(accepted) for HeldMail.send(), with what the file held when it started.
function delivery(file) {
  const d = { started: null, calls: 0 };
  d.run = (accepted) => {
    d.calls += 1;
    d.started = onDisk(file);
    d.accepted = accepted;
    return new Promise((resolve, reject) => {
      d.resolve = resolve;
      d.reject = reject;
    });
  };
  return d;
}

const NOSPACE = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
const LOCKED = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

// Makes fs[method] fail for paths under prefix, times times (all of them by default), until restore().
function breakFs(method, prefix, { times = Infinity, error = NOSPACE } = {}) {
  const real = fs[method];
  const broken = { left: times, restore: () => (fs[method] = real) };
  fs[method] = function (file, ...rest) {
    if (String(file).startsWith(prefix) && broken.left > 0) {
      broken.left -= 1;
      if (method === 'writeFileSync') real.call(fs, file, String(rest[0]).slice(0, 10));
      throw error();
    }
    return real.call(fs, file, ...rest);
  };
  return broken;
}

// Runs fn while fs[method] fails for paths under prefix.
function failing(method, prefix, fn, error = NOSPACE) {
  const broken = breakFs(method, prefix, { error });
  try {
    return fn();
  } finally {
    broken.restore();
  }
}

test('a refused email is on disk from the moment it is kept, and stays while its editor only loads or is open', () => {
  const files = profile();
  let journal = [{ id: 'r1', restore: restore('Refused'), origin: 'main', state: 'sending' }];
  const held = restart(files, () => journal);
  // Refused: kept before the outbox lets it go, and the file lists it once although the outbox still has it.
  held.keep({ id: 'r1', restore: restore('Refused'), error: 'Mailbox full' });
  assert.deepEqual(onDisk(files.file), [{ id: 'r1', restore: restore('Refused'), error: 'Mailbox full' }]);
  journal = [];
  held.write();
  assert.deepEqual(subjects(files.file), ['Refused']);
  // Its window is made, then loads, then shows the editor: none of that lets it go.
  assert.equal(held.attach(7, 'r1'), true);
  assert.equal(held.attached('r1'), true);
  assert.deepEqual(subjects(files.file), ['Refused']);
  // A kill now: the next start opens it once, with its error.
  const next = restart(files);
  assert.deepEqual(next.list(), [{ id: 'r1', restore: restore('Refused'), error: 'Mailbox full' }]);
});

test('an email goes from the file only once the editor that holds it answers for it by its id', () => {
  const files = profile();
  const held = restart(files);
  held.keep({ id: 'a', restore: restore('Saved'), error: 'x' });
  held.keep({ id: 'b', restore: restore('Window crashed'), error: 'x' });
  held.attach(1, 'a');
  held.attach(2, 'b');
  // An editor that names another editor's email answers for nothing.
  held.answer(1, 'b');
  held.answer(3, 'a');
  assert.deepEqual(subjects(files.file), ['Saved', 'Window crashed']);
  // b's window closes without an answer, and its email stays for the next start.
  assert.equal(held.detach(2).id, 'b');
  assert.equal(held.attached('b'), false);
  // a's editor closes with an answer, and a second answer does nothing.
  assert.equal(held.answer(1, 'a'), null);
  assert.equal(held.answer(1, 'a'), null);
  assert.deepEqual(subjects(files.file), ['Window crashed']);
  assert.deepEqual(restart(files).list().map((r) => r.id), ['b']);
});

test('several refused emails come back once each, after one crash and after a second crash during recovery', () => {
  const files = profile();
  const first = restart(files);
  for (const id of ['a', 'b', 'c']) first.keep({ id, restore: restore(id), error: 'Mailbox full' });
  // Kill. The next start reopens all three and dies before any editor answers.
  const second = restart(files);
  assert.deepEqual(second.list().map((r) => r.id), ['a', 'b', 'c']);
  second.attach(1, 'a');
  second.attach(2, 'b');
  second.attach(3, 'c');
  assert.deepEqual(subjects(files.file), ['a', 'b', 'c']);
  // Kill again, in the middle of recovery. The third start still has each once; one is answered for, then another kill.
  const third = restart(files);
  assert.deepEqual(third.list().map((r) => r.id), ['a', 'b', 'c']);
  third.attach(1, 'b');
  third.answer(1, 'b');
  assert.deepEqual(restart(files).list().map((r) => r.id), ['a', 'c']);
});

test('an email in both unsent.json and held.json comes back once, as unsent.json had it, and the old file goes', () => {
  const files = profile();
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  // What Rukoo before #309 left after a kill during a quit: the refused email in unsent.json with its error, and still
  // in held.json as on its way, because the outbox hadn't let it go yet; another email only in held.json.
  fs.writeFileSync(files.legacy, JSON.stringify([{ id: 'r', restore: restore('Refused in a quit'), error: 'Mailbox full' }]));
  fs.writeFileSync(
    files.file,
    JSON.stringify([
      { id: 'r', restore: restore('Refused in a quit'), origin: 'main', state: 'sending' },
      { id: 'w', restore: restore('Waiting'), origin: 'window', state: 'waiting' }
    ])
  );
  const held = restart(files);
  assert.deepEqual(held.list(), [
    { id: 'r', restore: restore('Refused in a quit'), error: 'Mailbox full' },
    { id: 'w', restore: restore('Waiting'), origin: 'window', state: 'waiting' }
  ]);
  assert.equal(fs.existsSync(files.legacy), false);
  // With unsent.json gone, held.json lists only the emails.
  assert.deepEqual(onDisk(files.file).map((e) => e.id), ['r', 'w']);
  // Started again before anything answered: still each once.
  assert.deepEqual(restart(files).list().map((r) => r.id), ['r', 'w']);
});

test('a kill while the start takes unsent.json in lists each email once at the following start, also one without an id', () => {
  const files = profile();
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  const legacy = [{ restore: restore('No id'), error: 'Mailbox full' }];
  fs.writeFileSync(files.legacy, JSON.stringify(legacy));
  const held = restart(files);
  const [first] = held.list();
  assert.match(first.id, /^[0-9a-f]{32}$/);
  // The kill came after held.json was written and before unsent.json went.
  fs.writeFileSync(files.legacy, JSON.stringify(legacy));
  const again = restart(files);
  assert.deepEqual(again.list(), [first]);
});

test('sending again with Undo send moves a kept email to the outbox in one write, so a kill never finds it twice', () => {
  const files = profile();
  let journal = [];
  const held = restart(files, () => journal);
  held.keep({ id: 'old', restore: restore('Again'), error: 'x' });
  held.attach(5, 'old');
  const writes = [];
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, data, ...rest) => {
    if (String(file).startsWith(files.file)) writes.push(JSON.parse(data).map((e) => e.id));
    return write.call(fs, file, data, ...rest);
  };
  let queued;
  try {
    // main.js api.send: the outbox's queue() writes the file through commit(), once.
    queued = held.queue(5, 'old', () => {
      journal = [{ id: 'new', restore: restore('Again'), origin: 'window', state: 'waiting' }];
      held.commit();
      return { id: 'new' };
    });
  } finally {
    fs.writeFileSync = write;
  }
  assert.deepEqual(queued, { id: 'new' });
  assert.deepEqual(writes, [['new']]);
  assert.equal(held.get('old'), null);
  assert.equal(held.attached('old'), false);
  // The outbox has it now: its old id is done with, and no editor sends it again under that id.
  assert.throws(() => held.queue(5, 'old', () => assert.fail('queued twice')), { code: 'EKEPTDONE' });
});

// First review: a send that ended settled whatever the reading pane held by then, and the email whose send was still
// running opened again for a second send.
test('a send settles its own email by id when it ends, whatever the editor holds by then, and nothing reopens or resends it meanwhile', async () => {
  const files = profile();
  const orphaned = [];
  const held = restart(files, () => [], { orphaned: (id) => orphaned.push(id) });
  held.keep({ id: 'k1', restore: restore('Retried'), error: 'Mailbox full' });
  assert.equal(held.attach('pane', 'k1'), true);
  const d = delivery(files.file);
  const sending = held.send('pane', 'k1', restore('Retried, edited'), d.run);
  await tick();
  assert.equal(held.isBusy('k1'), true);
  // The main window's page crashes: the pane lets go of it (main.js paneGone), and nothing may open it while it goes.
  assert.equal(held.detach('pane').id, 'k1');
  assert.equal(held.attach(9, 'k1'), false, 'no compose window takes an email that is on its way');
  await assert.rejects(held.send(9, 'k1', restore('Second try'), () => assert.fail('sent twice')), BusyError);
  // The new page's pane opens another refused email.
  held.keep({ id: 'k2', restore: restore('Another'), error: 'Mailbox full' });
  assert.equal(held.attach('pane', 'k2'), true);
  // The first send ends: only its own email goes.
  d.accepted();
  d.resolve();
  await sending;
  assert.equal(d.calls, 1);
  assert.equal(held.get('k1'), null);
  assert.equal(held.holder('k2'), 'pane');
  assert.deepEqual(subjects(files.file), ['Another']);
  assert.deepEqual(orphaned, []);
});

test('a send refused after its editor went hands the email back once, as it was sent and with the new error', async () => {
  const files = profile();
  const orphaned = [];
  const held = restart(files, () => [], { orphaned: (id) => orphaned.push(id) });
  held.keep({ id: 'k', restore: restore('Retried'), error: 'Mailbox full' });
  held.attach('pane', 'k');
  const d = delivery(files.file);
  const sending = held.send('pane', 'k', restore('Retried, edited'), d.run);
  await tick();
  held.detach('pane');
  d.reject(new Error('Quota exceeded'));
  const err = await sending.catch((e) => e);
  assert.equal(err.message, 'Quota exceeded');
  assert.equal(err.keptId, 'k');
  assert.deepEqual(orphaned, ['k']);
  assert.deepEqual(held.get('k'), { id: 'k', restore: restore('Retried, edited'), error: 'Quota exceeded' });
  assert.deepEqual(restart(files).list(), [{ id: 'k', restore: restore('Retried, edited'), error: 'Quota exceeded' }]);
});

// First review: a send straight away wrote only state 'sending', so a kill brought back the version from before the
// edits, addressed to the old recipients.
test('a send straight away has the file hold what the editor sends, as on its way, before delivery starts', async () => {
  const files = profile();
  const held = restart(files);
  held.keep({ id: 'k', restore: restore('Old subject', { to: ['old@example.com'] }), error: 'Mailbox full' });
  held.attach(4, 'k');
  const sent = restore('New subject', { to: ['new@example.com'] });
  const d = delivery(files.file);
  const sending = held.send(4, 'k', sent, d.run);
  await tick();
  assert.deepEqual(d.started, [{ id: 'k', restore: sent, state: 'sending' }]);
  // A kill now: the next start opens what was sent, with the note to check Sent first (state 'sending').
  assert.deepEqual(restart(files).list(), [{ id: 'k', restore: sent, state: 'sending' }]);
  d.accepted();
  d.resolve();
  await sending;
  assert.equal(fs.existsSync(files.file), false);

  // An email that was never kept is held the same way while it goes, and kept for its editor when it is refused.
  const fresh = delivery(files.file);
  const going = held.send(4, null, restore('Fresh'), fresh.run);
  await tick();
  assert.equal(fresh.started.length, 1);
  assert.deepEqual(fresh.started[0].restore, restore('Fresh'));
  assert.equal(fresh.started[0].state, 'sending');
  fresh.reject(new Error('Mailbox full'));
  const err = await going.catch((e) => e);
  assert.equal(err.keptId, fresh.started[0].id);
  assert.equal(held.holder(err.keptId), 4);
  assert.deepEqual(subjects(files.file), ['Fresh']);
  // The editor closes with an answer, naming that id.
  assert.equal(held.answer(4, err.keptId), null);
  assert.equal(fs.existsSync(files.file), false);
});

// First review: a Drafts save was settled only when the renderer said so after the engine had already removed the
// draft the kept email's attachments came from, so a kill in between reopened a duplicate whose attachments were gone.
test('a draft save lets its email go the moment the server has the draft, before the draft it replaces goes', async () => {
  const files = profile();
  const engine = new Engine({ dataDir: tempDir('sem-held-engine-') }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  const mail = { accountId: acc.id, to: ['someone@example.com'], html: '<p>Body</p>' };
  const first = await engine.saveDraft({ ...mail, subject: 'First save' });
  const held = restart(files);
  held.keep({ id: 'k', restore: restore('First save', { draftId: first }), error: 'Mailbox full' });
  held.attach(3, 'k');
  const session = engine.session(engine.account(acc.id));
  const append = session.append.bind(session);
  const remove = session.deleteForever.bind(session);
  const seen = {};
  session.append = async (...args) => {
    seen.atAppend = emails(files.file);
    return append(...args);
  };
  session.deleteForever = async (...args) => {
    seen.atRemove = emails(files.file);
    return remove(...args);
  };
  const id = await held.save(3, 'k', restore('Edited', { draftId: first }), (hooks) => engine.saveDraft({ ...mail, subject: 'Edited', draftId: first }, hooks));
  assert.ok(id);
  // Right before the server got it, the file had what the editor held and the draft's Message-ID.
  assert.equal(seen.atAppend.length, 1);
  assert.deepEqual(seen.atAppend[0].restore, restore('Edited', { draftId: first }));
  assert.match(seen.atAppend[0].draft.messageId, /^<.+@.+>$/);
  assert.equal(seen.atAppend[0].draft.accountId, acc.id);
  const stored = await engine.getMessage(id);
  assert.equal(stored.messageId.replace(/[<>]/g, ''), seen.atAppend[0].draft.messageId.replace(/[<>]/g, ''));
  // When the replaced draft went, the email was gone from the file already.
  assert.deepEqual(seen.atRemove, []);
  assert.equal(held.get('k'), null);
  await engine.close();
});

test('a kill after the server took a draft lets its email go at the next start, and one before that opens it again', async () => {
  const files = profile();
  const engine = new Engine({ dataDir: tempDir('sem-held-engine-') }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  const mail = { accountId: acc.id, to: ['someone@example.com'], html: '<p>Body</p>' };
  const first = await engine.saveDraft({ ...mail, subject: 'First save' });
  const held = restart(files);
  held.keep({ id: 'k', restore: restore('First save', { draftId: first }), error: 'Mailbox full' });
  held.attach(3, 'k');
  // The server stores the draft, and Rukoo is killed before it hears back.
  const session = engine.session(engine.account(acc.id));
  const append = session.append.bind(session);
  let stored = false;
  session.append = async (...args) => {
    await append(...args);
    stored = true;
    return new Promise(() => {});
  };
  held.save(3, 'k', restore('Edited', { draftId: first }), (hooks) => engine.saveDraft({ ...mail, subject: 'Edited', draftId: first }, hooks));
  while (!stored) await tick();
  const [left] = emails(files.file);
  assert.ok(left.draft, 'the file names the draft on its way');

  const next = restart(files);
  const has = (d) => engine.hasDraft(d.accountId, d.messageId);
  assert.equal(await next.recover('k', has), 'gone', 'Drafts has it, so it does not open again');
  assert.equal(fs.existsSync(files.file), false);
  // The draft it would have replaced is still there too, so nothing an editor pointed at went.
  assert.ok(await engine.getMessage(first));

  // A save that never reached the server opens again: as it was kept when the server says so, and naming the draft
  // when nobody can ask the server.
  const other = profile();
  const again = restart(other);
  again.keep({ id: 'n', restore: restore('Not stored'), error: 'x' });
  again.attach(1, 'n');
  session.append = () => new Promise(() => {});
  again.save(1, 'n', restore('Not stored'), (hooks) => engine.saveDraft({ ...mail, subject: 'Not stored' }, hooks));
  await tick();
  while (!emails(other.file)[0].draft) await tick();
  const later = restart(other);
  assert.equal(await later.recover('n', () => Promise.reject(new Error('offline'))), 'unsure');
  assert.ok(later.get('n').draft);
  assert.equal(await later.recover('n', has), 'open');
  assert.equal(later.get('n').draft, undefined);
  assert.deepEqual(later.list().map((r) => r.id), ['n']);
  await engine.close();
});

test('a save that fails leaves the email kept with what the editor held, and one whose editor went is handed back', async () => {
  const files = profile();
  const orphaned = [];
  const held = restart(files, () => [], { orphaned: (id) => orphaned.push(id) });
  held.keep({ id: 'k', restore: restore('Before'), error: 'Mailbox full' });
  held.attach('pane', 'k');
  let fail;
  const saving = held.save('pane', 'k', restore('Typed since'), () => new Promise((_resolve, reject) => (fail = reject)));
  await tick();
  assert.equal(held.isBusy('k'), true);
  held.detach('pane');
  assert.deepEqual(orphaned, [], 'not while the save is on its way');
  fail(new Error('No connection'));
  await assert.rejects(saving, /No connection/);
  assert.deepEqual(orphaned, ['k']);
  assert.deepEqual(held.get('k'), { id: 'k', restore: restore('Typed since'), error: 'Mailbox full' });
  // An editor that holds no kept email saves without the file.
  assert.equal(await held.save(8, null, restore('x'), (hooks) => Object.keys(hooks).length), 0);
});

// First review: when unsent.json couldn't be removed, it was read again at every start and brought back emails
// held.json had let go, or overrode a newer state.
test('once held.json has taken in unsent.json, it answers for those emails, also while unsent.json cannot be removed', async () => {
  const files = profile();
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  fs.writeFileSync(
    files.legacy,
    JSON.stringify([
      { id: 'settled', restore: restore('Answered for'), error: 'Mailbox full' },
      { id: 'resent', restore: restore('Sent again'), error: 'Mailbox full' }
    ])
  );
  const start = () => failing('rmSync', files.legacy, () => restart(files), LOCKED);
  const held = start();
  assert.ok(fs.existsSync(files.legacy));
  assert.deepEqual(held.list().map((r) => r.id), ['settled', 'resent']);
  held.attach(1, 'settled');
  held.answer(1, 'settled');
  held.attach(2, 'resent');
  const d = delivery(files.file);
  held.send(2, 'resent', restore('Sent again'), d.run);
  await tick();
  // A kill now, with unsent.json still there: neither comes back as unsent.json had it.
  const next = start();
  assert.deepEqual(next.list(), [{ id: 'resent', restore: restore('Sent again'), state: 'sending' }]);
  assert.deepEqual(start().list().map((r) => r.id), ['resent']);
  // Once the file can go, it goes, and held.json lists only the email.
  const last = restart(files);
  assert.equal(fs.existsSync(files.legacy), false);
  assert.deepEqual(last.list().map((r) => r.id), ['resent']);
  assert.deepEqual(onDisk(files.file).map((e) => e.id), ['resent']);
});

// First review: a failed write returned success and could leave the emails beside the file. Now a change that must be
// in the file first is refused and leaves memory as it was; one that happened already waits in memory for the next
// write; neither leaves a copy beside the file.
test('a write that fails: what must be in the file first is refused, what happened already waits in memory, and no copy stays beside the file', async () => {
  const files = profile();
  const clock = fakeClock();
  const held = restart(files, () => [], { timers: clock.timers });
  held.keep({ id: 'a', restore: restore('Kept'), error: 'x' });
  held.attach(1, 'a');
  const tmp = `${files.file}.tmp`;
  for (const method of ['writeFileSync', 'renameSync']) {
    // A refused email is kept in memory although the file can't take it yet; the file keeps what it had.
    failing(method, files.file, () => held.keep({ id: `b-${method}`, restore: restore(`Not yet written, ${method}`) }));
    assert.ok(held.get(`b-${method}`));
    assert.deepEqual(subjects(files.file), ['Kept']);
    assert.equal(fs.existsSync(tmp), false, `nothing left beside the file after ${method} failed`);
  }
  // A discard is refused: the email stays, in memory as in the file, held by nobody.
  assert.ok(failing('renameSync', files.file, () => held.answer(1, 'a')) instanceof JournalError);
  assert.ok(held.get('a'));
  assert.equal(held.attached('a'), false);
  // Nothing is sent that the file can't hold as on its way.
  held.attach(1, 'a');
  let delivered = false;
  const full = breakFs('renameSync', files.file);
  await assert.rejects(
    held.send(1, 'a', restore('Edited'), () => {
      delivered = true;
    }),
    JournalError
  );
  full.restore();
  assert.equal(delivered, false);
  assert.deepEqual(held.get('a'), { id: 'a', restore: restore('Kept'), error: 'x' });
  assert.equal(held.isBusy('a'), false);
  // The outbox can't take it either: it stays kept for this editor, and the error goes to the caller.
  assert.throws(() => held.queue(1, 'a', () => failing('renameSync', files.file, () => held.commit())), JournalError);
  assert.equal(held.holder('a'), 1);
  // The write that waits is tried again a moment later, with all that memory has.
  assert.deepEqual(subjects(files.file), ['Kept']);
  clock.advance(1000);
  assert.deepEqual(subjects(files.file), ['Kept', 'Not yet written, writeFileSync', 'Not yet written, renameSync']);
  // A copy a kill left beside the file never was the file, and goes at the next start.
  fs.writeFileSync(tmp, JSON.stringify([{ id: 'z', restore: restore('Never written') }]));
  assert.deepEqual(restart(files).list().map((r) => r.id), ['a', 'b-writeFileSync', 'b-renameSync']);
  assert.equal(fs.existsSync(tmp), false);
});

test('on Windows a file another program holds for a moment is tried again before the change counts as failed', { skip: process.platform !== 'win32' }, () => {
  const files = profile();
  const held = restart(files);
  held.keep({ id: 'other', restore: restore('Other') });
  const brief = breakFs('renameSync', files.file, { times: 2, error: LOCKED });
  held.keep({ id: 'a', restore: restore('Scanned') });
  brief.restore();
  assert.deepEqual(subjects(files.file), ['Other', 'Scanned']);
  held.attach(1, 'a');
  assert.ok(failing('renameSync', files.file, () => held.answer(1, 'a'), LOCKED) instanceof JournalError);
  assert.deepEqual(subjects(files.file), ['Other', 'Scanned']);
});

// First review: an unsent.json that couldn't be read or parsed counted as empty and was removed as if taken in.
test('an unsent.json or held.json that cannot be read is never removed or written over', () => {
  const files = profile();
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  fs.writeFileSync(files.legacy, '[{"id":"r","restore":{"state":{"subject":"Half wr');
  const held = restart(files);
  assert.deepEqual(held.list(), []);
  assert.equal(fs.readFileSync(files.legacy, 'utf8'), '[{"id":"r","restore":{"state":{"subject":"Half wr');
  assert.equal(fs.existsSync(files.file), false);
  // Not a list, or not a file at all: the same.
  fs.writeFileSync(files.legacy, '{"id":"r"}');
  restart(files);
  assert.equal(fs.readFileSync(files.legacy, 'utf8'), '{"id":"r"}');
  fs.rmSync(files.legacy);
  fs.mkdirSync(files.legacy);
  restart(files);
  assert.ok(fs.statSync(files.legacy).isDirectory());

  // A held.json that isn't a list is put aside beside it, so nothing is written over it.
  const other = profile();
  fs.mkdirSync(path.dirname(other.file), { recursive: true });
  fs.writeFileSync(other.file, '[{"id":"q","restore":');
  const next = restart(other);
  const aside = fs.readdirSync(path.dirname(other.file)).filter((f) => f.startsWith('held.json.unreadable-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(other.file), aside[0]), 'utf8'), '[{"id":"q","restore":');
  next.keep({ id: 'n', restore: restore('New') });
  assert.deepEqual(subjects(other.file), ['New']);

  // One that can't be read at the start is read again before the first write, and nothing is written over it before.
  const third = profile();
  fs.mkdirSync(path.dirname(third.file), { recursive: true });
  fs.writeFileSync(third.file, JSON.stringify([{ id: 'old', restore: restore('From the last run'), error: 'x' }]));
  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  const blocked = failing('readFileSync', third.file, () => restart(third), busy);
  assert.deepEqual(blocked.list(), []);
  failing('readFileSync', third.file, () => blocked.keep({ id: 'n', restore: restore('New') }), busy);
  assert.ok(blocked.get('n'), 'memory keeps it until the file can be read');
  assert.deepEqual(subjects(third.file), ['From the last run']);
  assert.equal(blocked.write(), true);
  assert.deepEqual(subjects(third.file).sort(), ['From the last run', 'New']);
});

test('records nobody could open again are left out, and an email another editor holds is not sent from a second one', async () => {
  const files = profile();
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  fs.writeFileSync(files.file, JSON.stringify([null, { id: 'x' }, { id: 'y', restore: [] }, { id: 'z', restore: restore('Kept') }]));
  const held = restart(files);
  assert.deepEqual(held.list().map((r) => r.id), ['z']);
  assert.equal(held.keep({ id: 'none' }), null);
  held.attach(1, 'z');
  assert.equal(held.attach(2, 'z'), false);
  await assert.rejects(held.send(2, 'z', restore('Kept'), () => assert.fail('sent from the wrong editor')), BusyError);
  // An editor that opened it while nobody held it, as when the reading pane's hand-off ended, holds it from then on.
  held.detach(1);
  assert.equal(held.answer('pane', 'z'), null);
  assert.equal(held.size, 0);
});

// Second review (P1): when the write that lists a queued email as on its way failed, the email didn't go; when the
// write that kept it for its editor failed too, the outbox let it go, and the next write that worked left it out.
test('an email the file could take neither as on its way nor as kept stays in memory, and in the file as it was, until a write goes through', async () => {
  for (const failures of [2, 3]) {
    const files = profile();
    const clock = fakeClock();
    let box = null;
    const held = restart(files, () => (box ? box.journal() : []), { timers: clock.timers });
    box = new Outbox({
      send: async () => assert.fail('an email the file could not list as on its way went'),
      // main.js waitedMailFailed: keep the refused email for its editor. Before, a keep that failed threw, and main
      // opened a window that held the email in its memory only.
      failed: (entry, err) => {
        try {
          held.keep({ id: entry.id, restore: entry.restore, error: err.message });
        } catch (_) {
          // The memory-only window.
        }
      },
      changed: () => held.commit(),
      timers: fakeClock().timers,
      now: () => 0
    });
    const { id } = box.queue({ payload: { subject: 'Never went' }, restore: restore('Never went'), ms: 5000 });
    assert.deepEqual(emails(files.file).map((e) => [e.id, e.state]), [[id, 'waiting']]);
    // The disk is full: the write that lists it as on its way fails, then the one that keeps it, and with 3 failures
    // also the outbox's own after it let the email go.
    const full = breakFs('writeFileSync', files.file, { times: failures });
    await box.flush();
    full.restore();
    assert.equal(box.size, 0);
    assert.ok(held.get(id), 'memory still has the email');
    assert.equal(held.get(id).restore.state.subject, 'Never went');
    assert.match(held.get(id).error, /ENOSPC/);
    if (failures === 2) {
      assert.deepEqual(emails(files.file).map((e) => [e.id, e.state, Boolean(e.error)]), [[id, undefined, true]]);
    } else {
      // Every write failed: the file still has it as it was, waiting, so a kill now brings it back unsent.
      assert.deepEqual(emails(files.file).map((e) => [e.id, e.state]), [[id, 'waiting']]);
      assert.deepEqual(restart(files).list().map((r) => r.id), [id]);
      // A moment later the write goes through, with the email as kept.
      clock.advance(1000);
      assert.deepEqual(emails(files.file).map((e) => [e.id, e.state, Boolean(e.error)]), [[id, undefined, true]]);
    }
  }
});

// Second review (P1): a compose window whose page loaded again after a crash still had the email and id it was opened
// with. Once the server took the first send, the id counted as new, and Send went a second time. A save while that
// send was on its way went through as an ordinary one.
test('an email the server took is done with for the run: a window that loads again sees that, and no send or save starts with its id', async () => {
  const files = profile();
  const held = restart(files);
  held.keep({ id: 'k', restore: restore('Sent once'), error: 'Mailbox full' });
  assert.equal(held.attach(7, 'k'), true);
  const d = delivery(files.file);
  const sending = held.send(7, 'k', restore('Sent once, edited'), d.run);
  await tick();
  // While it goes: no save and no second send.
  await assert.rejects(held.save(7, 'k', restore('x'), () => assert.fail('saved while it was sent')), BusyError);
  await assert.rejects(held.send(7, 'k', restore('x'), () => assert.fail('sent twice')), BusyError);
  d.accepted();
  d.resolve();
  await sending;
  // The id the page was opened with is done with: Send and save with it are refused, and nothing goes again.
  await assert.rejects(held.send(7, 'k', restore('Sent once, edited'), () => assert.fail('sent a second time')), { code: 'EKEPTDONE' });
  await assert.rejects(held.save(7, 'k', restore('x'), () => assert.fail('saved')), { code: 'EKEPTDONE' });
  assert.equal(held.attach(9, 'k'), false);
  assert.equal(d.calls, 1);
  // A page that loads again gets the email as main has it now: after the send, that it went; while it goes, it waits.
  assert.deepEqual(await held.opening(7), { id: 'k', settled: { as: 'sent' } });
  held.keep({ id: 'w', restore: restore('Waits'), error: 'Mailbox full' });
  held.attach(6, 'w');
  assert.deepEqual(await held.opening(6), { id: 'w', record: held.get('w') });
  const slow = delivery(files.file);
  const goes = held.send(6, 'w', restore('Waits'), slow.run);
  await tick();
  const reloaded = held.opening(6);
  assert.equal(await soon(reloaded), 'pending');
  slow.reject(new Error('Mailbox full'));
  await goes.catch(() => {});
  assert.deepEqual(await reloaded, { id: 'w', record: { id: 'w', restore: restore('Waits'), error: 'Mailbox full' } });
  // A window that opened a fresh email and sent it is the same: once it went, a page that loads again shows that.
  const fresh = delivery(files.file);
  const going = held.send(8, null, restore('Fresh'), fresh.run);
  await tick();
  fresh.accepted();
  fresh.resolve();
  await going;
  assert.equal((await held.opening(8)).settled.as, 'sent');
  assert.equal(await held.opening(5), null, 'a window that never held a kept email opens as it was made');
});

// Second review (P2): when the write of the draft's Message-ID failed, the save went on, so a kill after the server
// took the draft reopened the email as if it had never been saved.
test('a draft whose Message-ID the file cannot take is not saved, and the server never gets it', async () => {
  const files = profile();
  const engine = new Engine({ dataDir: tempDir('sem-held-engine-') }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  const held = restart(files);
  held.keep({ id: 'k', restore: restore('Kept'), error: 'Mailbox full' });
  held.attach(3, 'k');
  const session = engine.session(engine.account(acc.id));
  const append = session.append.bind(session);
  let appended = 0;
  session.append = async (...args) => {
    appended += 1;
    return append(...args);
  };
  const mail = { accountId: acc.id, to: ['someone@example.com'], subject: 'Edited', html: '<p>Body</p>' };
  const full = breakFs('writeFileSync', files.file);
  await assert.rejects(
    held.save(3, 'k', restore('Edited'), (hooks) => engine.saveDraft(mail, hooks)),
    JournalError
  );
  full.restore();
  assert.equal(appended, 0, 'the server never got the draft');
  assert.deepEqual(emails(files.file), [{ id: 'k', restore: restore('Kept'), error: 'Mailbox full' }]);
  assert.equal(held.isBusy('k'), false);
  assert.equal(held.holder('k'), 3);
  // Once the file can take it, the save goes, and the file names the draft before the server gets it.
  let named = null;
  session.append = async (...args) => {
    named = emails(files.file)[0].draft;
    return append(...args);
  };
  assert.ok(await held.save(3, 'k', restore('Edited'), (hooks) => engine.saveDraft(mail, hooks)));
  assert.match(named.messageId, /^<.+@.+>$/);
  assert.equal(held.get('k'), null);
  await engine.close();
});

// Second review (P2): the start looked for the draft in the newest drafts the cache keeps, so one just outside them
// counted as absent; and a lookup that failed counted as absent too.
test('the next start asks the server whether Drafts has the draft, however many there are, and opens the email when nobody can tell', async () => {
  const engine = new Engine({ dataDir: tempDir('sem-held-engine-'), limits: { default: 2 } }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  const mail = { accountId: acc.id, to: ['someone@example.com'], html: '<p>Body</p>' };
  let messageId = null;
  await engine.saveDraft({ ...mail, subject: 'On its way' }, { appending: (d) => (messageId = d.messageId) });
  for (const subject of ['Newer 1', 'Newer 2', 'Newer 3']) await engine.saveDraft({ ...mail, subject });
  const drafts = engine.folderByRole(acc.id, 'drafts');
  assert.equal(engine.uidByMessageId(acc.id, drafts.path, messageId), null, 'the cache keeps only the newest two');
  const has = (d) => engine.hasDraft(d.accountId, d.messageId);
  const left = (draft) => {
    const files = profile();
    fs.mkdirSync(path.dirname(files.file), { recursive: true });
    fs.writeFileSync(files.file, JSON.stringify([{ id: 'k', restore: restore('On its way'), error: 'Mailbox full', draft }]));
    return restart(files);
  };
  // Drafts has it: the email doesn't open again.
  const found = left({ accountId: acc.id, messageId });
  assert.equal(await found.recover('k', has), 'gone');
  assert.equal(found.get('k'), null);
  // Nobody can tell now: it opens all the same, still naming the draft, and nothing is deleted.
  const offline = left({ accountId: acc.id, messageId });
  assert.equal(await offline.recover('k', () => Promise.reject(new Error('No connection'))), 'unsure');
  assert.deepEqual(offline.get('k').draft, { accountId: acc.id, messageId });
  const gone = left({ accountId: 'removed-account', messageId });
  assert.equal(await gone.recover('k', has), 'unsure');
  // The server has no such draft: it opens as it was kept.
  const absent = left({ accountId: acc.id, messageId: '<not-there@example.com>' });
  assert.equal(await absent.recover('k', has), 'open');
  assert.equal(absent.get('k').draft, undefined);
  await engine.close();
});

// Second review (P2): a send or save that never ended kept its email busy for the rest of the run, so it never opened
// again after its page crashed, and a quit waited on it.
test('a send without an answer keeps its email busy for wait only: its editor then hears it may have gone, and no second try starts while the first can still end', async () => {
  const files = profile();
  const clock = fakeClock();
  const orphaned = [];
  const held = restart(files, () => [], { timers: clock.timers, wait: 60000, orphaned: (id) => orphaned.push(id) });
  held.keep({ id: 'k', restore: restore('Hangs'), error: 'Mailbox full' });
  held.attach('pane', 'k');
  const d = delivery(files.file);
  const sending = held.send('pane', 'k', restore('Hangs'), d.run);
  await tick();
  // The page crashes meanwhile: nothing opens the email while the send waits for the server.
  held.detach('pane');
  clock.advance(59999);
  assert.equal(held.isBusy('k'), true);
  assert.deepEqual(orphaned, []);
  clock.advance(1);
  assert.equal(held.isBusy('k'), false);
  const ended = await soon(sending);
  assert.notEqual(ended, 'pending', 'its editor hears back');
  assert.equal(ended.error.code, 'EKEPTUNSURE', 'its editor hears that nobody knows whether it went');
  assert.ok(ended.error instanceof UnsureError);
  assert.equal(ended.error.keptId, 'k');
  // It opens again, as on its way, and no second try starts while the first can still end, even with a yes.
  assert.deepEqual(orphaned, ['k']);
  assert.equal(held.unsure('k'), true);
  assert.deepEqual(emails(files.file).map((e) => e.state), ['sending']);
  assert.equal(held.attach(5, 'k'), true);
  await assert.rejects(held.send(5, 'k', restore('Again'), () => assert.fail('a second try while the first could still end'), { confirmed: true }), BusyError);
  await assert.rejects(held.save(5, 'k', restore('Again'), () => assert.fail('saved while the send could still end')), BusyError);
  // The first try ends after all, taken by the server: the email is done with, and the window that has it hears so.
  d.accepted();
  d.resolve();
  await soon(Promise.resolve());
  assert.equal(held.get('k'), null);
  await assert.rejects(held.send(5, 'k', restore('Again'), () => assert.fail('sent twice'), { confirmed: true }), { code: 'EKEPTDONE' });
  assert.equal(d.calls, 1);

  // Refused after its time: it is kept with the error, no longer on its way, and Send works again.
  held.keep({ id: 'r', restore: restore('Refused late'), error: 'x' });
  held.attach(6, 'r');
  const late = delivery(files.file);
  const going = held.send(6, 'r', restore('Refused late'), late.run);
  await tick();
  clock.advance(60000);
  assert.equal((await soon(going)).error.code, 'EKEPTUNSURE');
  late.reject(new Error('Mailbox full'));
  await soon(Promise.resolve());
  assert.deepEqual(held.get('r'), { id: 'r', restore: restore('Refused late'), error: 'Mailbox full' });
  const retry = delivery(files.file);
  const again = held.send(6, 'r', restore('Refused late'), retry.run);
  await tick();
  assert.equal(retry.calls, 1);
  retry.accepted();
  retry.resolve();
  await again;
});

test('a Drafts save without an answer keeps its email busy for wait only, and an editor that takes it over then goes on with it', async () => {
  const files = profile();
  const clock = fakeClock();
  const orphaned = [];
  const held = restart(files, () => [], { timers: clock.timers, wait: 60000, orphaned: (id) => orphaned.push(id) });
  held.keep({ id: 'k', restore: restore('Saving'), error: 'Mailbox full' });
  held.attach('pane', 'k');
  let accept;
  let resolve;
  const saving = held.save('pane', 'k', restore('Typed'), (hooks) => new Promise((r) => ((accept = hooks.accepted), (resolve = r))));
  await tick();
  held.detach('pane');
  clock.advance(60000);
  assert.equal(held.isBusy('k'), false);
  await tick();
  assert.deepEqual(orphaned, ['k']);
  // A compose window opens it now; its own saves wait while the first can still end.
  assert.equal(held.attach(4, 'k'), true);
  await assert.rejects(held.save(4, 'k', restore('x'), () => assert.fail('a second save while the first could still end')), BusyError);
  // The first save reaches Drafts after all: the window that has the email now goes on with it.
  accept();
  resolve('draft-1');
  assert.equal(await saving, 'draft-1');
  assert.ok(held.get('k'));
  assert.equal(held.holder('k'), 4);
});

// Second review (P2): when the file couldn't follow the server's word, the email stayed in memory as before, so it
// could open again; a discard the file couldn't take closed the editor as if it had; and the last email's file was
// removed without the tries Windows needs.
test("when the file can't follow the server's word, memory lets the email go at once, nothing opens it again, and the file follows a moment later", async () => {
  const files = profile();
  const clock = fakeClock();
  const orphaned = [];
  const held = restart(files, () => [], { timers: clock.timers, orphaned: (id) => orphaned.push(id) });
  held.keep({ id: 'k', restore: restore('Went'), error: 'Mailbox full' });
  held.keep({ id: 'other', restore: restore('Other'), error: 'Mailbox full' });
  held.attach('pane', 'k');
  const d = delivery(files.file);
  const sending = held.send('pane', 'k', restore('Went'), d.run);
  await tick();
  held.detach('pane');
  const locked = breakFs('renameSync', files.file);
  d.accepted();
  d.resolve();
  await sending;
  locked.restore();
  assert.equal(held.get('k'), null);
  assert.deepEqual(orphaned, []);
  await assert.rejects(held.send(1, 'k', restore('Went'), () => assert.fail('sent again')), { code: 'EKEPTDONE' });
  // The file still lists it as on its way until the write is tried again; a kill now would reopen it with the note to
  // check Sent first, and Send would ask before it went again.
  assert.deepEqual(emails(files.file).map((e) => [e.id, e.state]), [['k', 'sending'], ['other', undefined]]);
  clock.advance(1000);
  assert.deepEqual(emails(files.file).map((e) => e.id), ['other']);
});

test("a discard the file can't take comes back to the editor as an error, and the email stays for the next start, held by nobody", () => {
  const files = profile();
  const held = restart(files);
  held.keep({ id: 'k', restore: restore('Deleted'), error: 'Mailbox full' });
  held.keep({ id: 'other', restore: restore('Other'), error: 'Mailbox full' });
  held.attach(2, 'k');
  const err = failing('renameSync', files.file, () => held.answer(2, 'k'));
  assert.ok(err instanceof JournalError);
  assert.ok(held.get('k'));
  assert.equal(held.attached('k'), false);
  assert.deepEqual(restart(files).list().map((r) => r.id), ['k', 'other']);
  // Once the file can take it, the answer goes through.
  held.attach(2, 'k');
  assert.equal(held.answer(2, 'k'), null);
  assert.equal(held.get('k'), null);
  assert.deepEqual(subjects(files.file), ['Other']);
});

test('on Windows the last email leaves the file also while another program holds the file for a moment', { skip: process.platform !== 'win32' }, () => {
  const files = profile();
  const held = restart(files);
  held.keep({ id: 'o', restore: restore('Only') });
  held.attach(1, 'o');
  const brief = breakFs('rmSync', files.file, { times: 2, error: LOCKED });
  assert.equal(held.answer(1, 'o'), null);
  brief.restore();
  assert.equal(fs.existsSync(files.file), false);
});

// Second review (P2): when held.json couldn't be read at the first try, the start took unsent.json in before it knew
// which ids held.json had taken already, and brought back an email held.json had let go.
test('unsent.json waits while held.json cannot be read at the start, so an email held.json let go does not come back from it', () => {
  const files = profile();
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  // held.json took both from unsent.json, which couldn't be removed; 'settled' was answered for since.
  const legacy = JSON.stringify([
    { id: 'settled', restore: restore('Answered for'), error: 'Mailbox full' },
    { id: 'other', restore: restore('Other'), error: 'Mailbox full' }
  ]);
  fs.writeFileSync(files.legacy, legacy);
  fs.writeFileSync(files.file, JSON.stringify([{ id: 'other', restore: restore('Other'), error: 'Mailbox full' }, { legacy: ['settled', 'other'] }]));
  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  const blocked = failing('readFileSync', files.file, () => restart(files), busy);
  assert.deepEqual(blocked.list(), []);
  assert.equal(fs.readFileSync(files.legacy, 'utf8'), legacy);
  // held.json is read again before the first write; nothing from unsent.json comes with it.
  blocked.keep({ id: 'n', restore: restore('New') });
  assert.deepEqual(subjects(files.file).sort(), ['New', 'Other']);
  assert.equal(blocked.get('settled'), null);
  // A start that can read held.json takes nothing from unsent.json that held.json took already, and removes it.
  const next = restart(files);
  assert.deepEqual(next.list().map((r) => r.id).sort(), ['n', 'other']);
  assert.equal(fs.existsSync(files.legacy), false);
});

// Second review, the limit that predates it: an email that may have gone already opened with "Check Sent", and one
// click on Send after closing that note delivered it a second time.
test('an email that may have gone already goes again only with the yes of the person who read the warning', async () => {
  const files = profile();
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  fs.writeFileSync(files.file, JSON.stringify([{ id: 'k', restore: restore('Maybe sent'), origin: 'window', state: 'sending' }]));
  const held = restart(files);
  held.attach(1, 'k');
  let delivered = 0;
  const refused = await held.send(1, 'k', restore('Maybe sent'), () => (delivered += 1)).catch((e) => e);
  assert.equal(delivered, 0, 'sent without a yes');
  assert.equal(refused.code, 'EKEPTUNSURE');
  assert.throws(() => held.queue(1, 'k', () => assert.fail('queued without a yes')), { code: 'EKEPTUNSURE' });
  assert.equal(held.unsure('k'), true);
  assert.deepEqual(emails(files.file).map((e) => e.state), ['sending']);
  // With it, it goes.
  const d = delivery(files.file);
  const going = held.send(1, 'k', restore('Maybe sent'), d.run, { confirmed: true });
  await tick();
  assert.equal(d.calls, 1);
  d.accepted();
  d.resolve();
  await going;
  assert.equal(held.get('k'), null);
});
