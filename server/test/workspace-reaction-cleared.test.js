// Removing a message also takes who reacted to it, and with what, out of the room's events (RUK-226): its
// reaction.added and reaction.removed events become reaction.cleared, by whoever removed the message, with only the
// target. The rows stay, so the room's sequence numbers stay contiguous.

import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { blob, toBase64url } from '../src/bytes.js';
import { random } from './helpers.js';
import { api, changes, events, newMember, newWorkspace, post, react, workspaceSql, workspaceStub } from './workspace-helpers.js';

const redact = (person, ws, message) => api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${message}/redact`, { token: person.token });
const about = (log, message) => log.filter((e) => e.target === message);

describe('removing a message with reactions', () => {
  it('turns its reaction events into reaction.cleared by the remover, and leaves other reactions alone', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const tess = await newMember(ws, 'Tess', { channels: [ws.general] });
    const gone = (await post(mila.person, ws.id, ws.general, 'Lunch at noon?')).body;
    const kept = (await post(ws.person, ws.id, ws.general, 'Standup moved')).body;
    await react(tess.person, ws.id, ws.general, gone.messageId, '🎉');
    await react(ws.person, ws.id, ws.general, kept.messageId, '❤️');
    await react(mila.person, ws.id, ws.general, gone.messageId, '👍');
    await react(mila.person, ws.id, ws.general, gone.messageId, '👍', false);
    await react(tess.person, ws.id, ws.general, kept.messageId, '👀');
    const before = (await events(ws.person, ws.id, ws.general, `?after=${gone.seq}`)).body;

    // Olga, the channel's manager, removes Mila's message.
    expect((await redact(ws.person, ws, gone.messageId)).status).toBe(200);
    const after = (await events(tess.person, ws.id, ws.general, `?after=${gone.seq}`)).body;
    expect(after.head).toBe(before.head + 1);
    // Every row stays where it was: one event per sequence number, none missing.
    expect(after.events.map((e) => e.seq)).toEqual(Array.from({ length: after.head - gone.seq }, (_, i) => gone.seq + 1 + i));
    const cleared = (seq) => ({ seq, id: expect.stringMatching(/^e_/), kind: 'reaction.cleared', actor: ws.me.id, at: expect.any(Number), target: gone.messageId, targetSeq: gone.seq });
    const wasAbout = about(before.events, gone.messageId).filter((e) => e.kind !== 'message.redacted');
    expect(wasAbout.map((e) => e.kind)).toEqual(['reaction.added', 'reaction.added', 'reaction.removed']);
    expect(about(after.events, gone.messageId)).toEqual([
      ...wasAbout.map((e) => cleared(e.seq)),
      { seq: after.head, id: expect.stringMatching(/^e_/), kind: 'message.redacted', actor: ws.me.id, at: expect.any(Number), target: gone.messageId, targetSeq: gone.seq }
    ]);
    // Each keeps its id and time.
    for (const e of wasAbout) {
      const now = after.events.find((x) => x.seq === e.seq);
      expect([now.id, now.at]).toEqual([e.id, e.at]);
    }
    const page = JSON.stringify(about(after.events, gone.messageId));
    for (const trace of ['🎉', '👍', 'emoji', tess.me.id, mila.me.id]) expect(page).not.toContain(trace);

    // The other message's reactions are as they were.
    const untouched = about(after.events, kept.messageId);
    expect(untouched).toEqual(about(before.events, kept.messageId));
    expect(untouched.map((e) => [e.kind, e.actor, e.emoji])).toEqual([
      ['reaction.added', ws.me.id, '❤️'],
      ['reaction.added', tess.me.id, '👀']
    ]);

    // The open room's inline events in the feed say the same.
    const inline = (await changes(tess.person, ws.id, `?active=${ws.general}&roomAfter=${gone.seq}`)).body.inlineEvents;
    const inlineGone = about(inline, gone.messageId);
    expect(inlineGone.map((e) => e.kind)).toEqual(['reaction.cleared', 'reaction.cleared', 'reaction.cleared', 'message.redacted']);
    for (const e of inlineGone) {
      expect(e.actor).toBe(ws.me.id);
      expect(e).not.toHaveProperty('emoji');
    }
    expect(about(inline, kept.messageId).map((e) => e.emoji)).toEqual(['❤️', '👀']);

    // In the database too.
    const rows = await workspaceSql(ws.id, "SELECT data FROM event WHERE kind IN ('reaction.added', 'reaction.removed', 'reaction.cleared')");
    expect(rows.filter((row) => row.data.includes('🎉') || row.data.includes('👍'))).toEqual([]);

    // Reactions after the removal are untouched, and removing the message again changes nothing.
    await react(mila.person, ws.id, ws.general, kept.messageId, '🙌');
    expect((await redact(ws.person, ws, gone.messageId)).status).toBe(200);
    const last = (await events(ws.person, ws.id, ws.general, `?after=${after.head}`)).body.events;
    expect(last).toEqual([
      { seq: after.head + 1, id: expect.stringMatching(/^e_/), kind: 'reaction.added', actor: mila.me.id, at: expect.any(Number), target: kept.messageId, targetSeq: kept.seq, emoji: '🙌' }
    ]);
  });

  it('names the author as the actor when they remove their own message, and counts nothing as unread', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const sent = (await post(mila.person, ws.id, ws.general, 'Typo')).body;
    await react(ws.person, ws.id, ws.general, sent.messageId, '😅');
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/read`, { token: ws.person.token, body: { seq: sent.seq + 1 } });
    expect((await redact(mila.person, ws, sent.messageId)).status).toBe(200);
    const [event] = (await events(ws.person, ws.id, ws.general, `?after=${sent.seq}`)).body.events;
    expect(event).toMatchObject({ seq: sent.seq + 1, kind: 'reaction.cleared', actor: mila.me.id, target: sent.messageId, targetSeq: sent.seq });
    expect(event).not.toHaveProperty('emoji');
    const room = (await changes(ws.person, ws.id)).body.changes.find((c) => c.conversation === ws.general);
    expect(room.unread).toBe(0);
  });
});

// A workspace whose messages were removed by a version from before RUK-226 still has their reaction.added and
// reaction.removed events. Its object rewrites them once, when it starts on this version (#upgrade), as a removal does
// now. The old state is made by removing a message and putting its reaction events back as they were, which is all
// the older removal did differently, and by dropping the upgrade table such a workspace doesn't have.
describe('a workspace with messages removed before removals cleared their reactions', () => {
  const REACTION_ROWS =
    "SELECT conversation, seq, id, kind, actor, at, data FROM event WHERE kind IN ('reaction.added', 'reaction.removed', 'reaction.cleared') ORDER BY conversation, seq";
  const putBack = (id, rows) =>
    runInDurableObject(workspaceStub(id), (instance, state) => {
      for (const row of rows) {
        state.storage.sql.exec('UPDATE event SET kind = ?, actor = ?, data = ? WHERE conversation = ? AND seq = ?', row.kind, row.actor, row.data, row.conversation, row.seq);
      }
    });
  // Starts the object again, as after a restart, and waits for its upgrade. The runtime holds requests back while
  // blockConcurrencyWhile runs and resets the object when it fails; here the start only waits for it, so a failure
  // stays in the test. sync stands in for storage.sync. Answers whether the backfill ran, its error, and the rows
  // every query of the start read.
  const start = (id, { sync } = {}) =>
    runInDurableObject(workspaceStub(id), async (instance, state) => {
      const { sql } = state.storage;
      const exec = sql.exec;
      const cursors = [];
      let upgrading = null;
      // The runtime only takes its own state object, so its methods are swapped for the start and put back after.
      sql.exec = (...args) => {
        const cursor = exec.apply(sql, args);
        cursors.push(cursor);
        return cursor;
      };
      state.blockConcurrencyWhile = (fn) => (upgrading = fn());
      if (sync) state.storage.sync = sync;
      try {
        new instance.constructor(state, instance.env);
        const error = upgrading && (await upgrading.then(() => null, (err) => err));
        return { ran: upgrading !== null, error: error?.message ?? null, rowsRead: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0) };
      } finally {
        delete sql.exec;
        delete state.blockConcurrencyWhile;
        delete state.storage.sync;
      }
    });
  const steps = (id) => workspaceSql(id, 'SELECT step FROM upgrade');
  const memberKey = async (id, member) => (await workspaceSql(id, 'SELECT n FROM member WHERE id = ?', member))[0].n;
  const roomKey = async (id, conversation) => (await workspaceSql(id, 'SELECT n FROM conversation WHERE id = ?', conversation))[0].n;
  const leftover = (id) => workspaceSql(id, "SELECT name FROM sqlite_master WHERE name IN ('upgrade_at', 'upgrade_removed')");

  // Writes count removed messages into a room as a version from before RUK-226 left them: each message.posted row
  // removed, a reaction.added event that still names who reacted with what, and the message.redacted event of whoever
  // removed it, all at one time as #redact writes them. 'together' keeps each message's three events in a row;
  // 'apart' writes every message, then every reaction, then every removal, which made the old backfill read the rest of
  // the room once per removal. kept adds messages that stay, each with a reaction, before the removed ones. Returns
  // the reaction rows as written, with the remover of each removed message's reaction.
  const oldRemovals = (id, room, { count, layout, authors, removers, kept = 0 }) =>
    runInDurableObject(workspaceStub(id), (instance, state) => {
      const sql = state.storage.sql;
      let seq = sql.exec('SELECT head FROM conversation WHERE n = ?', room).one().head;
      const at = Date.now();
      const reactions = [];
      const write = (kind, actor, data, redactedAt = null) => {
        seq += 1;
        const row = { conversation: room, seq, kind, actor, data: data && JSON.stringify(data) };
        sql.exec(
          'INSERT INTO event (conversation, seq, id, kind, actor, at, data, redactedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          room,
          seq,
          blob(random(16)),
          kind,
          actor,
          at,
          row.data,
          redactedAt
        );
        return row;
      };
      const reaction = (message, i, remover) => {
        const data = { target: message.target, targetSeq: message.seq, emoji: ['🎉', '👍', '❤️'][i % 3] };
        reactions.push({ row: write('reaction.added', authors[(i + 1) % authors.length], data), message, remover });
      };
      const post = (i, removed) => ({ target: `e_${toBase64url(random(16))}`, seq: write('message.posted', authors[i % authors.length], null, removed ? at : null).seq });
      for (let i = 0; i < kept; i++) reaction(post(i, false), i, null);
      const messages = [];
      for (let i = 0; i < count; i++) {
        const message = post(i, true);
        messages.push(message);
        if (layout === 'together') {
          reaction(message, i, removers[i % removers.length]);
          write('message.redacted', removers[i % removers.length], { target: message.target, targetSeq: message.seq });
        }
      }
      if (layout === 'apart') {
        messages.forEach((message, i) => reaction(message, i, removers[i % removers.length]));
        messages.forEach((message, i) => write('message.redacted', removers[i % removers.length], { target: message.target, targetSeq: message.seq }));
      }
      sql.exec('UPDATE conversation SET head = ? WHERE n = ?', seq, room);
      return reactions;
    });
  // What #redact leaves of a reaction event: reaction.cleared by the remover, with only the target.
  const clearedRow = ({ row, message, remover }) => ({ ...row, kind: 'reaction.cleared', actor: remover, data: JSON.stringify({ target: message.target, targetSeq: message.seq }) });
  const reactionRows = (id, room) =>
    workspaceSql(id, "SELECT conversation, seq, kind, actor, data FROM event WHERE conversation = ? AND kind IN ('reaction.added', 'reaction.removed', 'reaction.cleared') ORDER BY seq", room);

  it('turns their reaction events into reaction.cleared by the remover, once, and leaves other reactions alone', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const tess = await newMember(ws, 'Tess', { channels: [ws.general] });
    const gone = (await post(mila.person, ws.id, ws.general, 'Lunch at noon?')).body;
    const kept = (await post(ws.person, ws.id, ws.general, 'Standup moved')).body;
    await react(tess.person, ws.id, ws.general, gone.messageId, '🎉');
    await react(ws.person, ws.id, ws.general, kept.messageId, '❤️');
    await react(mila.person, ws.id, ws.general, gone.messageId, '👍');
    await react(mila.person, ws.id, ws.general, gone.messageId, '👍', false);
    const original = await workspaceSql(ws.id, REACTION_ROWS);
    // Olga, the channel's manager, removes Mila's message, and the database goes back to what the old version left.
    expect((await redact(ws.person, ws, gone.messageId)).status).toBe(200);
    await putBack(ws.id, original);
    await workspaceSql(ws.id, 'DROP TABLE IF EXISTS upgrade');
    const old = (await events(ws.person, ws.id, ws.general, `?after=${gone.seq}`)).body;
    expect(about(old.events, gone.messageId).map((e) => [e.kind, e.actor, e.emoji])).toEqual([
      ['reaction.added', tess.me.id, '🎉'],
      ['reaction.added', mila.me.id, '👍'],
      ['reaction.removed', mila.me.id, '👍'],
      ['message.redacted', ws.me.id, undefined]
    ]);

    await start(ws.id);
    const after = (await events(tess.person, ws.id, ws.general, `?after=${gone.seq}`)).body;
    expect(after.head).toBe(old.head);
    // Each keeps its place, id and time, and names Olga, who removed the message.
    const cleared = (e) => ({ seq: e.seq, id: e.id, kind: 'reaction.cleared', actor: ws.me.id, at: e.at, target: gone.messageId, targetSeq: gone.seq });
    const wasAbout = about(old.events, gone.messageId);
    expect(about(after.events, gone.messageId)).toEqual([...wasAbout.slice(0, 3).map(cleared), wasAbout[3]]);
    expect(about(after.events, kept.messageId)).toEqual(about(old.events, kept.messageId));
    expect(about(after.events, kept.messageId).map((e) => [e.kind, e.actor, e.emoji])).toEqual([['reaction.added', ws.me.id, '❤️']]);
    // The database holds what a removal makes now, and the step is recorded.
    const olga = await memberKey(ws.id, ws.me.id);
    const data = JSON.stringify({ target: gone.messageId, targetSeq: gone.seq });
    const rows = await workspaceSql(ws.id, REACTION_ROWS);
    expect(rows).toEqual(original.map((row) => (JSON.parse(row.data).target === gone.messageId ? { ...row, kind: 'reaction.cleared', actor: olga, data } : row)));
    expect(rows.filter((row) => row.data.includes('🎉') || row.data.includes('👍'))).toEqual([]);
    expect(await steps(ws.id)).toEqual([{ step: 'reactions.cleared' }]);

    // Once: with the step recorded, a later start doesn't look again, so even events put back as they were stay.
    await putBack(ws.id, original);
    await start(ws.id);
    expect(await workspaceSql(ws.id, REACTION_ROWS)).toEqual(original);
    // Safe to run again: without the record it makes the same rows, and the start after that changes nothing.
    await workspaceSql(ws.id, 'DELETE FROM upgrade');
    await start(ws.id);
    expect(await workspaceSql(ws.id, REACTION_ROWS)).toEqual(rows);
    await start(ws.id);
    expect(await workspaceSql(ws.id, REACTION_ROWS)).toEqual(rows);
    expect(await steps(ws.id)).toEqual([{ step: 'reactions.cleared' }]);
  });

  it('clears them too when retention has already taken the message, from its message.redacted event', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const gone = (await post(mila.person, ws.id, ws.general, 'Typo')).body;
    await react(ws.person, ws.id, ws.general, gone.messageId, '😅');
    const original = await workspaceSql(ws.id, REACTION_ROWS);
    expect((await redact(mila.person, ws, gone.messageId)).status).toBe(200);
    await putBack(ws.id, original);
    await workspaceSql(ws.id, 'DROP TABLE IF EXISTS upgrade');
    // Retention deletes a conversation's events oldest first, as #expire does: here up to the message itself.
    const [{ n: room }] = await workspaceSql(ws.id, 'SELECT n FROM conversation WHERE id = ?', ws.general);
    await workspaceSql(ws.id, 'DELETE FROM event WHERE conversation = ? AND seq <= ?', room, gone.seq);
    await workspaceSql(ws.id, 'UPDATE conversation SET floor = ? WHERE n = ?', gone.seq + 1, room);

    await start(ws.id);
    const author = await memberKey(ws.id, mila.me.id);
    expect(await workspaceSql(ws.id, REACTION_ROWS)).toEqual([
      { ...original[0], kind: 'reaction.cleared', actor: author, data: JSON.stringify({ target: gone.messageId, targetSeq: gone.seq }) }
    ]);
  });

  it('leaves the reactions of a workspace without removed messages as they are', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const sent = (await post(ws.person, ws.id, ws.general, 'Hello')).body;
    await react(ws.person, ws.id, ws.general, sent.messageId, '👋');
    const original = await workspaceSql(ws.id, REACTION_ROWS);
    await workspaceSql(ws.id, 'DROP TABLE IF EXISTS upgrade');
    await start(ws.id);
    expect(await workspaceSql(ws.id, REACTION_ROWS)).toEqual(original);
    expect(await steps(ws.id)).toEqual([{ step: 'reactions.cleared' }]);
  });

  it('is recorded as done in a workspace this version makes, which never runs it', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    expect(await steps(ws.id)).toEqual([{ step: 'reactions.cleared' }]);
    const room = await roomKey(ws.id, ws.general);
    const olga = await memberKey(ws.id, ws.me.id);
    const written = await oldRemovals(ws.id, room, { count: 3, layout: 'together', authors: [olga], removers: [olga] });
    expect((await start(ws.id)).ran).toBe(false);
    expect(await reactionRows(ws.id, room)).toEqual(written.map((r) => r.row));
  });

  it('clears thousands of removed messages in one pass that reads each event about once', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const room = await roomKey(ws.id, ws.general);
    const olga = await memberKey(ws.id, ws.me.id);
    const author = await memberKey(ws.id, mila.me.id);
    const written = await oldRemovals(ws.id, room, { count: 3000, layout: 'apart', authors: [author, olga], removers: [olga, author], kept: 20 });
    await workspaceSql(ws.id, 'DROP TABLE upgrade');
    const [{ n: events }] = await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM event');

    const result = await start(ws.id);
    expect(result).toMatchObject({ ran: true, error: null });
    expect(await reactionRows(ws.id, room)).toEqual(written.map((r) => (r.remover === null ? r.row : clearedRow(r))));
    // A read per event, and a lookup and an update per reaction. Reading the rest of the room once per removed
    // message, as the backfill first did, reads over 20 million rows here.
    expect(result.rowsRead).toBeLessThan(3 * events);
    expect(await steps(ws.id)).toEqual([{ step: 'reactions.cleared' }]);
    expect(await leftover(ws.id)).toEqual([]);
  });

  it('goes on where a start that stopped partway left off, without going over what it did again', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const room = await roomKey(ws.id, ws.general);
    const olga = await memberKey(ws.id, ws.me.id);
    const author = await memberKey(ws.id, mila.me.id);
    // 1,800 events: two batches.
    const written = await oldRemovals(ws.id, room, { count: 600, layout: 'together', authors: [author, olga], removers: [olga, author] });
    await workspaceSql(ws.id, 'DROP TABLE upgrade');

    // The first start stops after its first batch, as when the runtime's limits end it.
    const stopped = await start(ws.id, { sync: () => Promise.reject(new Error('stopped by the runtime')) });
    expect(stopped).toMatchObject({ ran: true, error: 'stopped by the runtime' });
    expect(await steps(ws.id)).toEqual([]);
    const [at] = await workspaceSql(ws.id, 'SELECT conversation, seq FROM upgrade_at');
    expect(at.conversation).toBe(room);
    // Newest first: the batch cleared every reaction from the last event it read up, and none below.
    expect(await reactionRows(ws.id, room)).toEqual(written.map((r) => (r.row.seq >= at.seq ? clearedRow(r) : r.row)));
    // It read one removal whose reaction is below, which the next start has to clear by what the first one noted.
    expect(written.some((r) => r.row.seq < at.seq && r.row.seq + 1 >= at.seq)).toBe(true);

    // A reaction put back as it was, among what the first start did, stays so: the next start doesn't go over it.
    const redone = written.at(-1);
    await workspaceSql(ws.id, 'UPDATE event SET kind = ?, actor = ?, data = ? WHERE conversation = ? AND seq = ?', redone.row.kind, redone.row.actor, redone.row.data, room, redone.row.seq);
    expect(await start(ws.id)).toMatchObject({ ran: true, error: null });
    expect(await reactionRows(ws.id, room)).toEqual(written.map((r) => (r === redone ? r.row : clearedRow(r))));
    expect(await steps(ws.id)).toEqual([{ step: 'reactions.cleared' }]);
    expect(await leftover(ws.id)).toEqual([]);

    // Run again from the top, it clears that one as well and changes nothing else.
    await workspaceSql(ws.id, 'DELETE FROM upgrade');
    expect(await start(ws.id)).toMatchObject({ ran: true, error: null });
    expect(await reactionRows(ws.id, room)).toEqual(written.map(clearedRow));
    expect(await leftover(ws.id)).toEqual([]);
  });
});
