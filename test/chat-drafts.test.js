'use strict';

// Team chat's draft versions (src/renderer/chat-drafts.js): a send's answer reconciled against the draft of its
// workspace, room and thread as it is when the answer comes, also when the composer that sent it is gone and another
// one for the same draft wrote a newer one (followup-206 item 5). The composer around it needs a DOM and is in
// test/e2e/chat-compose.spec.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function moduleUrl(file) {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
const loading = import(moduleUrl('chat-drafts.js'));

// The drafts on disk, as main keeps them: by workspace, room and thread.
const onDisk = (where) => where.join('/');

// A composer as chat-view.js and chat-input.js mount one for where ([workspace, room, thread root or null]): it writes
// drafts through its slot and to disk, and takes a send's answer back through the slot.
function composer(d, where, disk) {
  const key = d.draftSlotKey(...where);
  const c = {
    key,
    input: [],
    loaded: null,
    live: {
      takeBack(sent) {
        c.input = c.input.length ? [...sent, '\n', ...c.input] : [...sent];
      },
      dropSent(sent) {
        if (c.loaded === sent.join('') && c.input.join('') === sent.join('')) c.input = [];
      }
    },
    write(text) {
      c.input = [text];
      d.draftWritten(key, [text]);
      disk.set(onDisk(where), text);
    },
    // Enter: the input empties and the draft on disk stays until the answer.
    send() {
      const sent = c.input;
      c.input = [];
      const ticket = d.sendStarted(key);
      const save = (p) => (p ? disk.set(onDisk(where), p.join('')) : disk.delete(onDisk(where)));
      return { ok: () => d.sendSettled(ticket, true, sent, save), refuse: () => d.sendSettled(ticket, false, sent, save) };
    },
    // The room or thread left the screen.
    dispose() {
      d.detachDraft(key, c.live);
    }
  };
  d.attachDraft(key, c.live);
  return c;
}

test('a late send answer from a gone composer keeps the newer draft a later composer saved', async () => {
  const d = await loading;
  const room = ['w1', 'general', null];
  const disk = new Map();

  // Taken: the newer draft stays.
  let first = composer(d, room, disk);
  first.write('Old text');
  let send = first.send();
  first.dispose();
  let second = composer(d, room, disk);
  second.write('Newer text');
  send.ok();
  assert.equal(disk.get(onDisk(room)), 'Newer text');
  assert.deepEqual(second.input, ['Newer text']);
  second.dispose();

  // Refused: the sent text comes back before the newer draft in the composer on screen, which saves it like typing.
  disk.clear();
  first = composer(d, room, disk);
  first.write('Old text');
  send = first.send();
  first.dispose();
  second = composer(d, room, disk);
  second.write('Newer text');
  send.refuse();
  assert.deepEqual(second.input, ['Old text', '\n', 'Newer text']);
  assert.equal(disk.get(onDisk(room)), 'Newer text');
  second.dispose();
});

test('with no composer on screen, a refusal goes before the draft written since, and a success deletes only its own', async () => {
  const d = await loading;
  const thread = ['w1', 'general', 'root-1'];
  const disk = new Map();

  let first = composer(d, thread, disk);
  first.write('Sent text');
  let send = first.send();
  first.dispose();
  const second = composer(d, thread, disk);
  second.write('Written since');
  second.dispose();
  send.refuse();
  assert.equal(disk.get(onDisk(thread)), 'Sent text\nWritten since');

  // Nothing written since: the refused text is the draft; a success deletes it.
  disk.clear();
  first = composer(d, thread, disk);
  first.write('Only this');
  send = first.send();
  first.dispose();
  send.refuse();
  assert.equal(disk.get(onDisk(thread)), 'Only this');

  first = composer(d, thread, disk);
  first.write('Gone after');
  send = first.send();
  first.dispose();
  send.ok();
  assert.equal(disk.has(onDisk(thread)), false);
});

test('a success while a remounted composer shows the draft the send left behind empties it', async () => {
  const d = await loading;
  const room = ['w1', 'random', null];
  const disk = new Map();
  const first = composer(d, room, disk);
  first.write('Left behind');
  const send = first.send();
  first.dispose();
  // The room opens again: its composer loads the draft still on disk, unedited.
  const second = composer(d, room, disk);
  second.input = ['Left behind'];
  second.loaded = 'Left behind';
  send.ok();
  assert.equal(disk.has(onDisk(room)), false);
  assert.deepEqual(second.input, []);
  second.dispose();
});

test('drafts of other rooms, threads and workspaces have versions of their own', async () => {
  const d = await loading;
  const room = ['w1', 'general', null];
  const thread = ['w1', 'general', 'root-1'];
  const elsewhere = ['w2', 'general', null];
  assert.notEqual(d.draftSlotKey(...room), d.draftSlotKey(...thread));
  assert.notEqual(d.draftSlotKey(...room), d.draftSlotKey(...elsewhere));
  const disk = new Map();
  const main = composer(d, room, disk);
  main.write('Main draft');
  const send = main.send();
  main.dispose();
  // A thread's draft and another workspace's are written meanwhile; the room's own draft is unchanged.
  const reply = composer(d, thread, disk);
  reply.write('Thread draft');
  const other = composer(d, elsewhere, disk);
  other.write('Other workspace');
  send.ok();
  assert.equal(disk.has(onDisk(room)), false);
  assert.equal(disk.get(onDisk(thread)), 'Thread draft');
  assert.equal(disk.get(onDisk(elsewhere)), 'Other workspace');
  reply.dispose();
  other.dispose();
});
