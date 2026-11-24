'use strict';

// held.json (src/main/heldmail.js): what Rukoo still answers for after Send, so a crash loses no email, brings none
// back twice and sends none twice (#256, #309). Each test reads the file as the next start would, at the moment a kill
// could come.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { HeldMail, JournalError, BusyError } = require('../src/main/heldmail');
const { Engine } = require('../src/main/engine');

const restore = (subject, state = {}) => ({ opts: { mode: 'new' }, html: `<p>${subject}</p>`, state: { subject, ...state } });

function profile() {
  const dir = path.join(tempDir('sem-held-'), 'data');
  return { file: path.join(dir, 'held.json'), legacy: path.join(dir, 'unsent.json') };
}

// The next start: a new run that loads what the files hold.
function restart({ file, legacy }, outbox = () => [], more = {}) {
  const held = new HeldMail({ file, legacy, outbox, ...more });
  held.load();
  return held;
}

const onDisk = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
// The emails in the file, without the ids it took from unsent.json.
const emails = (file) => onDisk(file).filter((e) => e.restore);
const subjects = (file) => emails(file).map((e) => e.restore.state.subject);
const tick = () => new Promise((resolve) => setImmediate(resolve));

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

// Runs fn while fs[method] fails for paths under prefix, as on a full disk.
function failing(method, prefix, fn, error = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })) {
  const real = fs[method];
  fs[method] = function (file, ...rest) {
    if (String(file).startsWith(prefix)) {
      if (method === 'writeFileSync') real.call(fs, file, String(rest[0]).slice(0, 10));
      throw error;
    }
    return real.call(fs, file, ...rest);
  };
  try {
    return fn();
  } finally {
    fs[method] = real;
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
  assert.equal(held.answer(1, 'b'), false);
  assert.equal(held.answer(3, 'a'), false);
  // b's window closes without an answer, and its email stays for the next start.
  assert.equal(held.detach(2).id, 'b');
  assert.equal(held.attached('b'), false);
  // a's editor closes with an answer.
  assert.equal(held.answer(1, 'a'), true);
  assert.equal(held.answer(1, 'a'), false, 'a second answer does nothing');
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
});

// Review finding: a send that ended settled whatever the reading pane held by then, and the email whose send was still
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

// Review finding: a send straight away wrote only state 'sending', so a kill brought back the version from before the
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
  assert.equal(held.answer(4, err.keptId), true);
  assert.equal(fs.existsSync(files.file), false);
});

// Review finding: a Drafts save was settled only when the renderer said so after the engine had already removed the
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
  const find = (d) => engine.findDraft(d.accountId, d.messageId);
  assert.equal(await next.recover('k', find), false, 'Drafts has it, so it does not open again');
  assert.equal(fs.existsSync(files.file), false);
  // The draft it would have replaced is still there too, so nothing an editor pointed at went.
  assert.ok(await engine.getMessage(first));

  // A save that never reached the server opens again; so does one nobody can check.
  const other = profile();
  const again = restart(other);
  again.keep({ id: 'n', restore: restore('Not stored'), error: 'x' });
  again.attach(1, 'n');
  session.append = () => new Promise(() => {});
  again.save(1, 'n', restore('Not stored'), (hooks) => engine.saveDraft({ ...mail, subject: 'Not stored' }, hooks));
  await tick();
  while (!emails(other.file)[0].draft) await tick();
  const later = restart(other);
  assert.equal(await later.recover('n', find), true);
  assert.equal(await later.recover('n', () => Promise.reject(new Error('offline'))), true);
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

// Review finding: when unsent.json couldn't be removed, it was read again at every start and brought back emails
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
  const locked = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  const start = () => failing('rmSync', files.legacy, () => restart(files), locked);
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

// Review finding: a failed write returned success, kept the change in memory and could leave the emails beside the file.
test('a write that fails is a failure the caller hears, memory stays as written last, and no copy stays beside the file', async () => {
  const files = profile();
  const held = restart(files);
  held.keep({ id: 'a', restore: restore('Kept'), error: 'x' });
  held.keep({ id: 'c', restore: restore('Other'), error: 'x' });
  held.attach(1, 'a');
  const tmp = `${files.file}.tmp`;
  for (const method of ['writeFileSync', 'renameSync']) {
    assert.throws(() => failing(method, files.file, () => held.keep({ id: 'b', restore: restore('Not kept') })), JournalError);
    assert.deepEqual(held.list().map((r) => r.id), ['a', 'c']);
    assert.deepEqual(subjects(files.file), ['Kept', 'Other']);
    assert.equal(fs.existsSync(tmp), false, `nothing left beside the file after ${method} failed`);
  }
  // Letting it go fails too: it stays kept, held by the same editor, in memory as on disk, until the next answer.
  assert.equal(failing('renameSync', files.file, () => held.answer(1, 'a')), false);
  assert.equal(held.holder('a'), 1);
  assert.deepEqual(subjects(files.file), ['Kept', 'Other']);
  // The same for the last email, whose file goes instead.
  held.attach(2, 'c');
  const only = restart(profile());
  only.keep({ id: 'o', restore: restore('Only') });
  only.attach(1, 'o');
  assert.equal(failing('rmSync', only.file, () => only.answer(1, 'o')), false);
  assert.deepEqual(subjects(only.file), ['Only']);
  assert.equal(only.holder('o'), 1);
  // The outbox can't take it either: it stays kept for this editor, and the error goes to the caller.
  assert.throws(
    () => held.queue(1, 'a', () => failing('renameSync', files.file, () => held.commit())),
    JournalError
  );
  assert.equal(held.holder('a'), 1);
  // Nothing is sent that the file can't hold as on its way.
  let delivered = false;
  await assert.rejects(
    failing('renameSync', files.file, () =>
      held.send(1, 'a', restore('Edited'), () => {
        delivered = true;
      })
    ),
    JournalError
  );
  assert.equal(delivered, false);
  assert.deepEqual(held.get('a'), { id: 'a', restore: restore('Kept'), error: 'x' });
  assert.equal(held.isBusy('a'), false);
  // write(), for the outbox's changes that go on without the file, says false.
  assert.equal(failing('renameSync', files.file, () => held.write()), false);
  // Once it can be written, the answer goes through.
  assert.equal(held.answer(1, 'a'), true);
  assert.deepEqual(subjects(files.file), ['Other']);
  assert.equal(held.answer(2, 'c'), true);
  assert.equal(fs.existsSync(files.file), false);
  // A copy a kill left beside the file never was the file, and goes at the next start.
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify([{ id: 'z', restore: restore('Never written') }]));
  assert.deepEqual(restart(files).list(), []);
  assert.equal(fs.existsSync(tmp), false);
});

test('on Windows a file another program holds for a moment is tried again before the change counts as failed', { skip: process.platform !== 'win32' }, () => {
  const files = profile();
  const held = restart(files);
  const real = fs.renameSync;
  let refusals = 2;
  fs.renameSync = (from, to) => {
    if (String(from).startsWith(files.file) && refusals > 0) {
      refusals -= 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return real.call(fs, from, to);
  };
  try {
    held.keep({ id: 'a', restore: restore('Scanned') });
    assert.deepEqual(subjects(files.file), ['Scanned']);
    refusals = Infinity;
    assert.throws(() => held.keep({ id: 'b', restore: restore('Locked') }), JournalError);
    assert.deepEqual(subjects(files.file), ['Scanned']);
  } finally {
    fs.renameSync = real;
  }
});

// Review finding: an unsent.json that couldn't be read or parsed counted as empty and was removed as if taken in.
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
  const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  const blocked = failing('readFileSync', third.file, () => restart(third), busy);
  assert.deepEqual(blocked.list(), []);
  assert.throws(() => failing('readFileSync', third.file, () => blocked.keep({ id: 'n', restore: restore('New') }), busy), JournalError);
  assert.deepEqual(subjects(third.file), ['From the last run']);
  blocked.keep({ id: 'n', restore: restore('New') });
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
  assert.equal(held.answer('pane', 'z'), true);
  assert.equal(held.size, 0);
});
