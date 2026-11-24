'use strict';

// held.json (src/main/heldmail.js): what Rukoo still answers for after Send, so a crash loses no email and brings none
// back twice (#256, #309). Each test reads the file as the next start would, at the moment a kill could come.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { HeldMail } = require('../src/main/heldmail');

const restore = (subject) => ({ opts: { mode: 'new' }, html: `<p>${subject}</p>`, state: { subject } });

function profile() {
  const dir = path.join(tempDir('sem-held-'), 'data');
  return { file: path.join(dir, 'held.json'), legacy: path.join(dir, 'unsent.json') };
}

// The next start: a new run that loads what the files hold.
function restart({ file, legacy }, outbox = () => []) {
  const held = new HeldMail({ file, legacy, outbox });
  held.load();
  return held;
}

const onDisk = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
const subjects = (file) => onDisk(file).map((e) => e.restore.state.subject);

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

test('an email goes from the file only once its editor answers for it, and a closed window leaves it for the next start', () => {
  const files = profile();
  const held = restart(files);
  held.keep({ id: 'a', restore: restore('Saved'), error: 'x' });
  held.keep({ id: 'b', restore: restore('Window crashed'), error: 'x' });
  held.attach(1, 'a');
  held.attach(2, 'b');
  // b's window closes without an answer.
  assert.equal(held.detach(2).id, 'b');
  assert.equal(held.attached('b'), false);
  assert.equal(held.settle(2), null, 'a detached editor answers for nothing');
  // a's editor saves a draft.
  assert.equal(held.settle(1), 'a');
  assert.equal(held.settle(1), null, 'a second answer does nothing');
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
  // Kill again, in the middle of recovery. The third start still has each once; one is saved, then another kill.
  const third = restart(files);
  assert.deepEqual(third.list().map((r) => r.id), ['a', 'b', 'c']);
  third.attach(1, 'b');
  third.settle(1);
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
  assert.deepEqual(subjects(files.file), ['Refused in a quit', 'Waiting']);
  // Started again before anything answered: still each once.
  assert.deepEqual(restart(files).list().map((r) => r.id), ['r', 'w']);
});

test('a kill while the start folds unsent.json in lists each email once at the following start, also one without an id', () => {
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

test('sending again moves a kept email to the outbox in one write, so a kill never finds it twice', () => {
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
  try {
    // api.send: settle without a write, then the outbox's queue() writes once.
    held.settle(5, { write: false });
    journal = [{ id: 'new', restore: restore('Again'), origin: 'window', state: 'waiting' }];
    held.write();
  } finally {
    fs.writeFileSync = write;
  }
  assert.deepEqual(writes, [['new']]);
});

test('a kept email sent straight away counts as on its way until the server answers, and as before when refused', () => {
  const files = profile();
  const held = restart(files);
  held.keep({ id: 'k', restore: restore('Straight'), error: 'Mailbox full' });
  held.attach('pane', 'k');
  const refusedAgain = held.sending('pane');
  // A kill now: the next start says to check Sent first.
  assert.equal(restart(files).get('k').state, 'sending');
  refusedAgain();
  assert.equal(onDisk(files.file)[0].state, undefined);
  assert.equal(restart(files).get('k').error, 'Mailbox full');
  // Sent this time.
  held.sending('pane');
  held.settle('pane');
  assert.equal(fs.existsSync(files.file), false);
  // An editor that holds nothing marks nothing.
  held.sending(9)();
  assert.equal(fs.existsSync(files.file), false);
});

test('records nobody could open again are left out, and an unreadable profile keeps the last whole list', () => {
  const files = profile();
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  fs.writeFileSync(files.file, JSON.stringify([null, { id: 'x' }, { id: 'y', restore: [] }, { id: 'z', restore: restore('Kept') }]));
  const held = restart(files);
  assert.deepEqual(held.list().map((r) => r.id), ['z']);
  assert.equal(held.keep({ id: 'none' }), null);
  // A directory where the file should be: writes fail and the run goes on.
  const blocked = profile();
  fs.mkdirSync(blocked.file, { recursive: true });
  const stuck = restart(blocked);
  assert.equal(stuck.write(), false);
  assert.ok(stuck.keep({ id: 'q', restore: restore('Memory only') }));
  assert.equal(stuck.size, 1);
});
