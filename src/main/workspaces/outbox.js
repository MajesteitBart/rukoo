'use strict';

// Sending and removing messages (team chat contract 3.8 and 3.14). The service (index.js) and the sync engine
// (sync.js) call the hooks kick() and unsent(); ipc.js turns METHODS into the chat* IPC methods, each as
// (svc, ...checkedArgs) => result.
//
// A message is on disk before anything else happens: chatSend writes its outbox row in one transaction, and a write
// that fails throws not_saved, so the composer keeps the text. The queue then sends the rows, oldest first, one per
// room and two rooms at a time. Before a row's first attempt its operation ID (a UUIDv7 on the server's clock) is saved
// with state sending in its own transaction, and only then does the POST go out. Every attempt sends the same bytes,
// so an answer lost on the way never posts a message twice. Rows stay queued across restarts; the queue starts once the
// workspace has synced in this session.
//
// What the service gives this module: svc.store, svc.epoch, svc.call(ws, method, route, body, { retry }),
// svc.details(ws) (GET /, which also measures the clock and runs the restore path), svc.clock() (the server's time
// minus local time, or null when unknown or older than timing.clockMaxAge), svc.emitChat(payload),
// svc.roomsChanged(ws, ids), svc.sync(ws, why), svc.me(ws), svc.timing (sendBackoff, sendsInFlight, retryDelay),
// svc.now(), svc.timers, svc.runners, svc.lastOk, svc.hook(fn) and svc.isStale(err).
const wire = require('./wire');
const { recount } = require('./sync');
const { ROOM_CACHE_MAX } = require('./store');

const { ChatError, chatError } = wire;

// Rows in these states hold back the later rows of their room, which show as waiting.
const BLOCKING = new Set(['held', 'failed']);

// What a refused send turns into: { state, reason } for the row (contract 3.8 "Answers").
function refusal(err) {
  switch (err.code) {
    case 'stale_grant':
      return { state: 'held', reason: 'stale_grant' };
    case 'operation_conflict':
      return { state: 'failed', reason: 'conflict' };
    case 'archived':
      return { state: 'failed', reason: 'archived' };
    case 'quota':
      return { state: 'failed', reason: 'quota' };
    case 'invalid':
      return { state: 'failed', reason: err.field === 'mentions' ? 'mentions' : 'invalid' };
    case 'not_found':
    case 'forbidden':
      return { state: 'failed', reason: 'no_access' };
    default:
      return { state: 'failed', reason: 'invalid' };
  }
}

// A failure the same request may get past later: the network, a timeout, the server's own trouble, or an answer this
// app couldn't read.
const transient = (err) => err.code === 'network' || (err.code === 'server' && (err.status === 0 || err.status >= 500));

class Outbox {
  // The chat* IPC methods this module answers.
  static METHODS = {
    chatSend: (svc, ws, c, input) => svc.outbox.send(ws, c, input),
    chatResend: (svc, local, opts) => svc.outbox.resend(local, opts),
    chatDiscard: (svc, local) => svc.outbox.discard(local),
    chatRedact: (svc, ws, c, message) => svc.outbox.redact(ws, c, message)
  };

  constructor(svc) {
    this.svc = svc;
    this.queue = null;
    this.timer = null;
    this.timerAt = null;
    this.closed = false;
  }

  // The queue's state for the current session. A new session (a new epoch) starts clean: jobs of the old one finish
  // against their own state and drop their answers, and rows a quit left sending are queued again with their ID.
  current() {
    const svc = this.svc;
    if (!this.queue || this.queue.epoch !== svc.epoch) {
      this.queue = {
        epoch: svc.epoch,
        // Rooms with a send in flight, as `${ws}\n${room}`.
        busy: new Set(),
        // Per row: when its last attempt failed for the network ({ at, back }), for timing.retryDelay.
        netFailed: new Map(),
        // pump() runs one at a time; a call during it asks for another round.
        pumping: false,
        again: false
      };
      if (svc.store) {
        try {
          svc.store.run(`UPDATE outbox SET state = 'queued' WHERE state = 'sending'`);
        } catch (_) {
          // The next session's store.
        }
      }
    }
    return this.queue;
  }

  // ---- hooks ----

  // Sends what is due: after each run, on focus, resume and socket open, and after a restore or Start over, whose
  // transaction already ran store.markLookup. Each of those retries at once a row that waits after a network failure
  // or a 5xx (attempts > 0), except as long as the test knob retryDelay holds it. A 429's Retry-After is kept: its row
  // waits with attempts 0 and nextAt at the end of the wait, both on disk, so a restart keeps it too. ws: only that
  // workspace's rows are retried at once; the queue itself always runs for every workspace.
  //
  // A row left sending while no send of its room is in flight is an orphan: the answer to its POST came but couldn't
  // be written (acked), or the job stopped. It is looked up with its saved operation ID, which decides it.
  kick(ws) {
    const svc = this.svc;
    if (this.closed || !svc.store || !svc.live()) return;
    const q = this.current();
    const now = svc.now();
    const only = ws ? ' AND ws = ?' : '';
    const args = ws ? [ws] : [];
    for (const row of svc.store.all(`SELECT local, ws, room FROM outbox WHERE state = 'sending'${only}`, ...args)) {
      if (q.busy.has(`${row.ws}\n${row.room}`)) continue;
      svc.store.updateOutbox(row.local, { state: 'queued', reason: 'lookup', nextAt: 0 });
      this.emitPending(row.ws, row.room);
    }
    svc.store.run(`UPDATE outbox SET nextAt = ? WHERE state = 'queued' AND attempts > 0 AND nextAt > ?${only}`, now, now, ...args);
    this.pump();
  }

  // How many messages wait to be sent, held and failed ones included: for ChatState.unsent and the sign-out dialogs.
  unsent() {
    return this.svc.store ? this.svc.store.countUnsent() : 0;
  }

  close() {
    this.closed = true;
    this.clearTimer();
  }

  // ---- the renderer's view ----

  // The room's unsent messages as Pending (contract 4.6), oldest first. A held or failed row holds back the later
  // rows of its room, which show as waiting. For the pending event and RoomView.pending.
  pendingFor(ws, room) {
    const store = this.svc.store;
    if (!store) return [];
    let blocked = false;
    return store.outboxForRoom(ws, room).map((row) => {
      const out = wire.toPending(row, { waiting: blocked });
      if (BLOCKING.has(row.state)) blocked = true;
      return out;
    });
  }

  emitPending(ws, room) {
    if (!this.svc.store || !this.svc.store.getRoom(ws, room)) return;
    this.svc.emitChat({ kind: 'pending', ws, conversation: room, pending: this.pendingFor(ws, room) });
    this.svc.stateChanged();
  }

  // ---- IPC ----

  // chatSend: the row goes to disk first, in one transaction; only then does the message show as pending and the queue
  // send it. Returns { local, pending }.
  async send(ws, room, input) {
    const svc = this.svc;
    const store = svc.store;
    const epoch = svc.epoch;
    let row = this.writable(ws, room);
    if (!row.ws.generation || !row.ws.me) {
      await svc.details(ws);
      svc.guard(epoch);
      row = this.writable(ws, room);
    }
    // An archived channel or a closed DM takes no messages; the composer shows a bar instead.
    if (row.room.archived || row.room.closedReason) throw new ChatError('archived');
    const local = wire.localId();
    store.tx(() =>
      store.insertOutbox({
        local,
        ws,
        room,
        actor: row.ws.me,
        grantId: row.room.grantId,
        generation: row.ws.generation,
        text: input.text,
        mentions: input.mentions,
        root: input.root,
        state: 'queued',
        operationId: null,
        createdAt: svc.now()
      })
    );
    const pending = this.pendingFor(ws, room).find((p) => p.local === local);
    this.emitPending(ws, room);
    this.pump();
    return { local, pending };
  }

  // The workspace and room rows a write needs, or the error the person sees.
  writable(ws, room) {
    const store = this.svc.store;
    const wsRow = store.getWs(ws);
    if (!wsRow) throw new ChatError('not_found', { scope: 'workspace' });
    if (wsRow.state === 'quarantined') throw new ChatError('paused');
    if (wsRow.state === 'upgrade') throw new ChatError('upgrade_required');
    const roomRow = store.getRoom(ws, room);
    if (!roomRow) throw new ChatError('not_found', { scope: 'conversation' });
    return { ws: wsRow, room: roomRow };
  }

  // chatResend: the person's answer to a held or failed row (contract 3.8 "Resend modes"). Returns { pending }.
  async resend(local, { mode }) {
    const svc = this.svc;
    const store = svc.store;
    const epoch = svc.epoch;
    let row = store.getOutbox(local);
    if (!row) throw new ChatError('not_found');
    const fits =
      (mode === 'send' && row.state === 'held' && (row.reason === 'stale_grant' || row.reason === 'unknown')) ||
      (mode === 'retry' && row.state === 'failed' && row.reason === 'quota') ||
      (mode === 'withoutMentions' && row.state === 'failed' && row.reason === 'mentions');
    if (!fits) throw new ChatError('invalid', { field: 'mode' });
    let { room } = this.writable(row.ws, row.room);
    // The grant this device last saw is the one the server refused: the feed knows the new one.
    if (mode === 'send' && row.reason === 'stale_grant' && room.grantId === row.grantId) {
      const confirmed = row;
      await svc.sync(row.ws, 'resend');
      svc.guard(epoch);
      row = store.getOutbox(local);
      if (!row) throw new ChatError('not_found');
      // Meanwhile another Send went ahead with it, or a restore marked it for lookup: what the person confirmed is no
      // longer the row, which stays as that left it.
      if (row.state !== confirmed.state || row.reason !== confirmed.reason || row.operationId !== confirmed.operationId) {
        return { pending: this.pendingFor(row.ws, row.room).find((p) => p.local === local) };
      }
      ({ room } = this.writable(row.ws, row.room));
    }
    const fields = { state: 'queued', reason: null, attempts: 0, nextAt: 0 };
    if (mode === 'send' && row.reason === 'stale_grant') {
      // Same ID: the server checks for a duplicate before the grant, so a message that did commit gets its answer.
      fields.grantId = room.grantId;
    } else if (mode === 'send') {
      // held/unknown, after the person said to send it again: a new ID, the current grant and generation.
      fields.operationId = null;
      fields.grantId = room.grantId;
      fields.generation = store.getWs(row.ws).generation;
    } else if (mode === 'withoutMentions') {
      fields.operationId = null;
      fields.mentions = [];
    }
    store.updateOutbox(local, fields);
    this.forget(local);
    const pending = this.pendingFor(row.ws, row.room).find((p) => p.local === local);
    this.emitPending(row.ws, row.room);
    this.pump();
    return { pending };
  }

  // chatDiscard: the row goes. A POST already on its way may still land; the feed then shows the message.
  discard(local) {
    const store = this.svc.store;
    const row = store.getOutbox(local);
    if (!row) return true;
    store.deleteOutbox(local);
    this.forget(local);
    this.emitPending(row.ws, row.room);
    this.pump();
    return true;
  }

  // chatRedact (contract 3.14): after the server's 200 the cached event is marked removed in one transaction, with a
  // tombstone so a slow history page can't bring its text back, and the main window hears redacted. A 429 waits for
  // Retry-After and tries again (contract 4.4); a removal is idempotent, so that is safe.
  async redact(ws, room, message) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.writable(ws, room);
    const answer = wire.checkRedact(await svc.call(ws, 'POST', `/conversations/${room}/messages/${message}/redact`, undefined, { retry: true }));
    svc.guard(epoch);
    const store = svc.store;
    if (!store.getRoom(ws, room)) return true;
    const changed = store.tx(() => {
      store.addTombstones(ws, [answer.messageId]);
      store.redact(ws, [answer.messageId]);
      return recount(store, ws, room);
    });
    svc.emitChat({ kind: 'redacted', ws, conversation: room, ids: [answer.messageId] });
    if (changed) svc.roomsChanged(ws, [room]);
    svc.hook(() => svc.history.onRemoved(ws, room, [answer.messageId]));
    svc.hook(() => svc.notifier.onRemoved(ws, room, [answer.messageId]));
    svc.sync(ws, 'write');
    return true;
  }

  // ---- the queue ----

  // Whether ws's queue may run: its first sync of this session succeeded (contract 3.8). The run's own kick comes
  // after it stored syncedAt.
  ready(ws) {
    const r = this.svc.runners.get(ws);
    if (!r) return false;
    if (r.ok) return true;
    const row = this.svc.store.getWs(ws);
    return Boolean(r.running && row && row.syncedAt !== null && row.syncedAt >= r.lastStart);
  }

  // With the test knob retryDelay: a row whose last attempt failed for the network waits until the app reached its
  // workspace again (svc.lastOk after the failure), and then retryDelay more. Returns the time it may go, or null
  // while the workspace hasn't answered yet.
  netHold(q, row) {
    const delay = this.svc.timing.retryDelay;
    const failed = q.netFailed.get(row.local);
    if (!delay || !failed) return 0;
    if (failed.back === null) {
      const ok = this.svc.lastOk.get(row.ws);
      if (!(ok > failed.at)) return null;
      failed.back = this.svc.now();
    }
    return failed.back + delay;
  }

  // Starts the sends whose turn it is, up to sendsInFlight rooms at once, and sets a timer for the next one due.
  pump() {
    const svc = this.svc;
    if (this.closed || !svc.store || !svc.live()) return;
    const q = this.current();
    if (q.pumping) {
      q.again = true;
      return;
    }
    q.pumping = true;
    try {
      do {
        q.again = false;
        const now = svc.now();
        let wake = null;
        const due = svc.store.nextDue(now, 200);
        for (const row of due) {
          if (q.busy.size >= svc.timing.sendsInFlight) break;
          const key = `${row.ws}\n${row.room}`;
          if (q.busy.has(key) || !this.ready(row.ws)) continue;
          const hold = this.netHold(q, row);
          if (hold === null) continue;
          if (hold > now) {
            wake = wake === null ? hold : Math.min(wake, hold);
            continue;
          }
          q.busy.add(key);
          this.job(q, row).finally(() => {
            q.busy.delete(key);
            if (this.queue === q) this.pump();
          });
        }
        const next = svc.store.get(`SELECT MIN(nextAt) AS at FROM outbox o JOIN ws w ON w.id = o.ws WHERE w.state = 'ok' AND o.state = 'queued' AND o.nextAt > ?`, now);
        if (next && next.at !== null) wake = wake === null ? next.at : Math.min(wake, next.at);
        this.armTimer(wake);
      } while (q.again);
    } finally {
      q.pumping = false;
    }
  }

  armTimer(at) {
    if (at === null) return;
    if (this.timer && this.timerAt <= at) return;
    this.clearTimer();
    this.timerAt = at;
    this.timer = this.svc.timers.setTimeout(() => {
      this.timer = null;
      this.timerAt = null;
      this.pump();
    }, Math.max(0, at - this.svc.now()));
  }

  clearTimer() {
    if (this.timer) this.svc.timers.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
  }

  forget(local) {
    if (!this.queue) return;
    this.queue.netFailed.delete(local);
  }

  // One turn of one row: a lookup when it is marked for one, else an attempt.
  async job(q, row) {
    try {
      if (row.reason === 'lookup' && row.operationId) await this.lookup(q, row);
      else await this.attempt(q, row);
    } catch (err) {
      if (!this.svc.isStale(err)) this.svc.hookFailed(err);
    }
  }

  // The row as it stands, when it is still the one this job started with: same session, same operation ID, and in
  // one of states. Else null, and the job leaves it alone.
  still(q, row, operationId, states) {
    const store = this.svc.store;
    if (this.queue !== q || q.epoch !== this.svc.epoch || !store) return null;
    const now = store.getOutbox(row.local);
    if (!now || now.operationId !== operationId || !states.includes(now.state)) return null;
    return now;
  }

  // The operation ID for the next attempt on the server's clock, measured by GET / when it is unknown or older than
  // six hours (contract 3.8).
  async operationId(ws, { fresh = false } = {}) {
    const svc = this.svc;
    const epoch = svc.epoch;
    if (fresh || svc.clock() === null) {
      await svc.details(ws);
      svc.guard(epoch);
    }
    const offset = svc.clock() ?? 0;
    return wire.uuidv7(Math.max(0, Math.round(svc.now() + offset)));
  }

  // One attempt of a queued row (a row marked for lookup before it ever had an ID never went out, so it comes here
  // too). Every attempt sends the row's stored bytes; only a refusal of the ID itself as ahead of the server's clock
  // makes a new one, once.
  async attempt(q, row) {
    const svc = this.svc;
    let operationId = row.operationId;
    if (!operationId) {
      try {
        operationId = await this.operationId(row.ws);
      } catch (err) {
        if (svc.isStale(err)) throw err;
        return this.failed(q, row, null, chatError(err), { states: ['queued'] });
      }
      if (!this.still(q, row, null, ['queued'])) return;
    }
    let clockRetried = false;
    for (;;) {
      // The ID is on disk, with state sending, before the request leaves.
      svc.store.updateOutbox(row.local, { operationId, state: 'sending', reason: null });
      this.emitPending(row.ws, row.room);
      const current = svc.store.getOutbox(row.local);
      const body = {
        operationId,
        grant: current.grantId,
        generation: current.generation,
        text: current.text,
        mentions: JSON.parse(current.mentions),
        root: current.root ?? null
      };
      let answer;
      try {
        answer = wire.checkPost(await svc.call(row.ws, 'POST', `/conversations/${row.room}/messages`, body));
      } catch (raw) {
        if (svc.isStale(raw)) throw raw;
        const err = chatError(raw);
        // The server's clock is behind the ID: a 400 means it never committed, so a new ID on a fresh clock, once.
        if (err.code === 'invalid' && err.field === 'operationId' && !clockRetried) {
          clockRetried = true;
          if (!this.still(q, row, operationId, ['sending'])) return;
          let fresh;
          try {
            fresh = await this.operationId(row.ws, { fresh: true });
          } catch (e) {
            if (svc.isStale(e)) throw e;
            return this.failed(q, row, operationId, chatError(e));
          }
          if (!this.still(q, row, operationId, ['sending'])) return;
          operationId = fresh;
          continue;
        }
        return this.failed(q, row, operationId, err);
      }
      return this.acked(q, row, operationId, answer, { visible: true, states: ['sending'] });
    }
  }

  // GET /conversations/{c}/operations/{operationId} for a row marked for lookup: 200 means it arrived, 404 that
  // nobody can tell, and the person decides.
  async lookup(q, row) {
    const svc = this.svc;
    const operationId = row.operationId;
    let answer;
    try {
      answer = wire.checkOperation(await svc.call(row.ws, 'GET', `/conversations/${row.room}/operations/${operationId}`));
    } catch (raw) {
      if (svc.isStale(raw)) throw raw;
      const err = chatError(raw);
      if (!this.still(q, row, operationId, ['queued'])) return;
      if (err.code === 'not_found' && !err.scope) return this.settle(q, row, { state: 'held', reason: 'unknown' });
      return this.failed(q, row, operationId, err, { states: ['queued'], keep: { reason: 'lookup' } });
    }
    if (!this.still(q, row, operationId, ['queued', 'sending'])) return;
    return this.acked(q, row, operationId, answer, { visible: answer.visible, states: ['queued', 'sending'] });
  }

  // A refused or failed attempt (or lookup), by the table of contract 3.8. states: what the row must still be for this
  // answer to count (an attempt's row is sending; a restore that marked it for lookup meanwhile wins).
  async failed(q, row, operationId, err, { states = ['sending'], keep = {} } = {}) {
    const svc = this.svc;
    const now = svc.now();
    const current = this.still(q, row, operationId, states);
    if (!current) return;
    if (transient(err)) {
      const table = svc.timing.sendBackoff;
      const attempts = current.attempts + 1;
      this.settle(q, row, { state: 'queued', attempts, nextAt: now + table[Math.min(attempts - 1, table.length - 1)], ...keep });
      if (err.code === 'network') q.netFailed.set(row.local, { at: now, back: null });
      return;
    }
    if (err.code === 'rate_limited') {
      // attempts 0 marks the wait as the server's own, which kick() doesn't cut short. The server answered, so a
      // network failure after it backs off from the start again.
      return this.settle(q, row, { state: 'queued', attempts: 0, nextAt: now + (err.retryAfter || 1) * 1000, ...keep });
    }
    // The workspace waits for a newer Rukoo (call() parked it), or the session ended: the row waits as it is.
    if (err.code === 'upgrade_required' || err.code === 'signed_out' || err.code === 'paused') {
      return this.settle(q, row, { state: 'queued', ...keep });
    }
    // call() ran the removal path; the row went with the workspace.
    if (err.code === 'not_found' && err.scope === 'workspace') return;
    if (err.code === 'submission_expired') {
      // Too old to send: did it arrive? The lookup runs as the row's next turn.
      return this.settle(q, row, { state: 'queued', reason: 'lookup', nextAt: 0 });
    }
    if (err.code === 'stale_generation') {
      // The workspace was restored: GET / runs the restore path, whose markLookup takes this row too. A row of a
      // generation the store no longer has (a race with an earlier restore) is marked here.
      try {
        await svc.details(row.ws);
      } catch (e) {
        if (svc.isStale(e)) throw e;
      }
      if (!this.still(q, row, operationId, ['sending', 'queued'])) return;
      return this.settle(q, row, { state: 'queued', reason: 'lookup', nextAt: 0 });
    }
    return this.settle(q, row, refusal(err));
  }

  // The row's new state, with whatever held it in memory forgotten; the caller sets a new hold after.
  settle(q, row, fields) {
    const store = this.svc.store;
    if (this.queue !== q || !store || !store.getOutbox(row.local)) return;
    this.forget(row.local);
    store.updateOutbox(row.local, fields);
    this.emitPending(row.ws, row.room);
  }

  // The message committed: one transaction deletes the row, caches the event when it follows the cached range at once,
  // and moves the read positions to at least its seq, as the server moved the sender's. Then sent goes out.
  //
  // states: what the row must still be under operationId for this answer to count. A POST's answer counts only while
  // its row is sending: a restore or Start over that marked the row for lookup meanwhile leaves the decision to the
  // lookup, as the generation the POST went out under may be gone. When the transaction fails (a disk error), the row
  // waits for a lookup with its saved ID after the backoff, so the room's queue doesn't stall until a restart.
  acked(q, row, operationId, answer, { visible, states }) {
    const svc = this.svc;
    const store = svc.store;
    if (this.queue !== q || !store) return;
    const { ws, room } = row;
    let done;
    try {
      done = this.ackTx(row, operationId, answer, { visible, states });
    } catch (err) {
      const current = this.still(q, row, operationId, states);
      if (current) {
        const table = svc.timing.sendBackoff;
        const attempts = current.attempts + 1;
        try {
          this.settle(q, row, { state: 'queued', reason: 'lookup', attempts, nextAt: svc.now() + table[Math.min(attempts - 1, table.length - 1)] });
        } catch (_) {
          // The disk refuses this too: the row stays sending, and the next kick() takes it up as an orphan.
        }
      }
      throw err;
    }
    this.forget(row.local);
    if (!done) return;
    svc.emitChat({ kind: 'sent', ws, conversation: room, local: row.local, messageId: answer.messageId, seq: answer.seq });
    this.emitPending(ws, room);
    svc.roomsChanged(ws, [room]);
    svc.sync(ws, 'sent');
  }

  ackTx(row, operationId, answer, { visible, states }) {
    const svc = this.svc;
    const store = svc.store;
    const { ws, room } = row;
    return store.tx(() => {
      const current = store.getOutbox(row.local);
      if (!current || current.operationId !== operationId || !states.includes(current.state)) return null;
      store.deleteOutbox(row.local);
      const r = store.getRoom(ws, room);
      if (!r) return { current };
      const seq = answer.seq;
      const at = Math.round(svc.now() + (svc.clock() ?? 0));
      if (r.hi !== null && seq === r.hi + 1) {
        store.appendEvents(ws, room, [
          {
            seq,
            id: answer.messageId,
            kind: 'message.posted',
            actor: current.actor,
            at,
            root: current.root ?? null,
            text: current.text,
            mentions: JSON.parse(current.mentions),
            redacted: !visible
          }
        ], { max: svc.timing.roomCacheMax || ROOM_CACHE_MAX });
      }
      const fresh = store.getRoom(ws, room);
      const fields = {
        head: Math.max(fresh.head, seq),
        read: Math.max(fresh.read, seq),
        readLocal: Math.max(fresh.readLocal, seq),
        readSent: Math.max(fresh.readSent, seq)
      };
      if (seq > fresh.head) fields.lastAt = Math.max(fresh.lastAt ?? 0, at);
      store.setRoomFields(ws, room, fields);
      this.badges(ws, room);
      return { current };
    });
  }

  // The server's badges count after its read position, which just moved to the sender's message: nothing when that
  // is the head, else what the cache holds after it, when it covers the rest.
  badges(ws, room) {
    const store = this.svc.store;
    const r = store.getRoom(ws, room);
    if (r.read >= r.head) {
      if (r.unread || r.mentions) store.setRoomFields(ws, room, { unread: 0, mentions: 0 });
      return;
    }
    const me = store.getWs(ws)?.me;
    const covers = r.lo !== null && r.hi !== null && r.hi >= r.head && r.lo <= r.read + 1;
    if (covers && me) store.setRoomFields(ws, room, store.countBadges(ws, room, r.read, me));
  }
}

module.exports = { Outbox };
