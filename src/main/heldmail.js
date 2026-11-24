'use strict';

// held.json in the profile: every email Rukoo still answers for after Send, so a crash or a killed process loses none,
// brings none back twice and sends none twice (#256, #309). Each email has one record under its id, and one owner:
//
// - The outbox (Outbox.journal()) while the email waits out its Undo notice, then while it goes from there.
// - A kept email here once it left the outbox or an earlier run unsent: refused, left by a quit, reopened after a
//   crash, or sent straight from an editor. The editor that holds it (a compose window's webContents id, or 'pane' for
//   the main window's reading pane) is the only one that sends, saves or closes it, and names it by its id
//   (composer.js keptId). An editor that is merely open, or still loading, has it in its window's memory only, so a
//   crash before it answers brings it back at the next start, once.
//
// A kept email wins over the outbox's entry with the same id: a refused email is kept, with its error, before the
// outbox lets it go. A record goes only on proof: the server took the email or its draft, the outbox took it, or its
// editor closed with an answer the file has. The server's word counts at once: memory lets the email go and its id is
// done with for the rest of the run (settled), and the file follows with the next write that can be made. A change that
// must be in the file before something happens (an email listed as on its way before it goes, a draft before the
// server gets it, a discard) leaves memory as it was when the file can't take it, and throws a JournalError. Any other
// change stays in memory when the file can't take it, so the next write still has it, and until then the file keeps
// what it had. A write that fails is tried again a moment later.
//
// A send or Drafts save of a kept email makes it busy until the server answers, or for wait ms at most: nothing opens
// it elsewhere, closes it or starts anything else with it. While a send or save can still end, even after that, no
// second one starts. A send without an answer in time may still go: like one that was on its way when Rukoo ended, it
// is unsure, and Send goes again only once the person has been told to check Sent and says yes (confirmed).
//
// Every change replaces the whole file, written beside it first and then moved over it, so a crash halfway leaves the
// last whole list; synchronously, so a kill straight after the change finds it.
//
// unsent.json is where Rukoo before #309 kept the refused emails a quit left. load() takes them in once, and only once
// held.json could be read: until unsent.json is gone, held.json names the ids it took, and those are held.json's.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A change to held.json that couldn't be written.
class JournalError extends Error {
  constructor(cause) {
    super((cause && cause.message) || String(cause));
    this.name = 'JournalError';
    this.code = 'EJOURNAL';
  }
}

// A send or save of a kept email while one is on its way with it, or while another editor holds it.
class BusyError extends Error {
  constructor() {
    super('This email is already on its way, or open in another window.');
    this.name = 'BusyError';
    this.code = 'EKEPTBUSY';
  }
}

// A call with the id of an email that is done with for this run: it went, waits in the outbox, is in Drafts, or was let
// go. Nothing is done with it again.
class DoneError extends Error {
  constructor() {
    super('This email was sent or saved already.');
    this.name = 'DoneError';
    this.code = 'EKEPTDONE';
  }
}

// An email that may have gone already: sent again without the person's yes, or a send the server didn't answer in time.
class UnsureError extends Error {
  constructor() {
    super('Nobody knows whether this email went.');
    this.name = 'UnsureError';
    this.code = 'EKEPTUNSURE';
  }
}

// What a send or save that runs past wait ms gives instead of its answer.
const LATE = Symbol('late');
// How long the first try at a write that failed waits; each try after that waits twice as long, up to a minute.
const RETRY_MS = 1000;

const isRestore = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// What the file keeps of an email, or null for one nobody could open again: { id, restore, error, state, origin,
// draft }. state: 'waiting' or 'sending' for an outbox email; 'sending' also for a kept one that may have gone. draft:
// { accountId, messageId } of the Drafts save that was on its way with it (save()).
function record(e) {
  if (!e || typeof e !== 'object' || !isRestore(e.restore)) return null;
  // Every Rukoo that wrote these gave each an id. One without gets the same id at every read, so a list read twice
  // (a kill while load() takes unsent.json in) still lists it once.
  const id = typeof e.id === 'string' && e.id ? e.id : crypto.createHash('sha256').update(JSON.stringify([e.restore, e.error || ''])).digest('hex').slice(0, 32);
  const r = { id, restore: e.restore };
  if (typeof e.error === 'string' && e.error) r.error = e.error;
  if (e.state === 'waiting' || e.state === 'sending') r.state = e.state;
  if (typeof e.origin === 'string') r.origin = e.origin;
  const d = e.draft;
  if (d && typeof d === 'object' && typeof d.accountId === 'string' && typeof d.messageId === 'string') r.draft = { accountId: d.accountId, messageId: d.messageId };
  return r;
}

// Windows refuses a file for a moment while another program, such as a virus scanner, has it open, so there each step
// on the files is tried a few times, 20 ms apart, before it counts as failed.
function retried(fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err && err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

// A JSON list from a file: { list }, empty with missing: true when there is no file; { error } when the file is there
// but can't be read (unreadable: true), or holds something else.
function read(file) {
  let text;
  try {
    text = retried(() => fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return err && err.code === 'ENOENT' ? { list: [], missing: true } : { error: err, unreadable: true };
  }
  try {
    const list = JSON.parse(text);
    if (Array.isArray(list)) return { list };
  } catch (err) {
    return { error: err };
  }
  return { error: new Error('not a list') };
}

// held.json's list: the emails, and the ids it took from unsent.json ({ legacy: [ids] }, which no Rukoo opens as an
// email because it has no restore).
function split(list) {
  const records = [];
  const imported = new Set();
  for (const e of list) {
    if (e && typeof e === 'object' && !e.restore && Array.isArray(e.legacy)) {
      for (const id of e.legacy) if (typeof id === 'string') imported.add(id);
    } else records.push(e);
  }
  return { records, imported };
}

class HeldMail {
  // file: held.json. legacy: unsent.json, or null. outbox(): the outbox's journal() as it is now. orphaned(id): a kept
  // email nobody holds after its send or save ended, or ran past wait, which main opens again. log(message): what went
  // wrong with the files, for the log in the profile. wait: how long a send or save keeps its email busy at most.
  // timers: the clock, which the tests replace.
  constructor({ file, legacy = null, outbox = () => [], orphaned = () => {}, log = () => {}, wait = 60000, timers = { setTimeout, clearTimeout } }) {
    this.file = file;
    this.legacy = legacy;
    this.outbox = outbox;
    this.orphaned = orphaned;
    this.log = log;
    this.wait = wait;
    this.timers = timers;
    // id -> record, oldest first. Records are replaced, never changed, so a change that can't be written goes back.
    this.kept = new Map();
    // The editor that holds each kept email now -> its id.
    this.editors = new Map();
    // The editor -> the last email it held, also once that one is done with: what a compose window whose page loads
    // again opens (opening()). Gone with the window (detach()).
    this.last = new Map();
    // id -> 'send' or 'save', while that waits for the server, for wait ms at most.
    this.busy = new Map();
    // The ids whose send or save hasn't ended yet, also after wait.
    this.inflight = new Set();
    // The ids whose send ran past wait without an answer in this run.
    this.unanswered = new Set();
    // id -> { as: 'sent' | 'queued' | 'saved' | 'discarded' }: done with for the rest of the run.
    this.settled = new Map();
    // id -> what waits for that email to stop being busy (idle()).
    this.waiters = new Map();
    // The ids held.json took from unsent.json, while that file is still there.
    this.imported = new Set();
    // Why held.json couldn't be read at the start, while it still can't: nothing is written over it until it can.
    this.unread = null;
    this.retry = null;
    this.retryMs = RETRY_MS;
  }

  // At the start, before anything can be queued: what the last run left, kept now, oldest first. An email listed in
  // both files counts once, as unsent.json has it the first time: an older Rukoo wrote a refused email there before the
  // outbox let it go from held.json. After that the ids held.json took are its own, also while unsent.json can't be
  // removed. A file that can't be read, or holds something else, is never removed as if it had been taken in, and
  // unsent.json waits for a start that can read held.json.
  load() {
    // A list that never became the file: what the file holds is what was written last.
    try {
      fs.rmSync(`${this.file}.tmp`, { force: true });
    } catch (_) {
      // Written over by the next change.
    }
    const held = this.readHeld();
    if (held.failed) {
      if (this.legacy && fs.existsSync(this.legacy)) this.log("unsent.json waits for a start that can read held.json");
      return [];
    }
    const legacy = this.legacy ? read(this.legacy) : { list: [], missing: true };
    if (legacy.error) this.log(`unsent.json can't be read and stays as it is: ${legacy.error.message}`);
    const list = [];
    const add = (r) => r && !list.some((x) => x.id === r.id) && list.push(r);
    let taken = 0;
    for (const e of legacy.list || []) {
      const r = record(e);
      if (!r || held.imported.has(r.id)) continue;
      this.imported.add(r.id);
      add(r);
      taken += 1;
    }
    for (const id of held.imported) this.imported.add(id);
    for (const e of held.records) add(record(e));
    for (const r of list) this.kept.set(r.id, r);
    if (legacy.missing) this.imported.clear();
    if (legacy.missing || legacy.error) return list;
    // held.json takes over what unsent.json listed, with the ids, before that file goes.
    if (taken && !this.write()) return list;
    try {
      retried(() => fs.rmSync(this.legacy, { force: true }));
    } catch (err) {
      this.log(`unsent.json can't be removed; held.json answers for its emails: ${err.message}`);
      return list;
    }
    // The ids are no longer needed; a file that still names them does no harm until the next change.
    if (this.imported.size) {
      this.imported.clear();
      this.write();
    }
    return list;
  }

  // held.json as the start finds it: { records, imported, failed }. One that holds something else is put aside beside
  // it, so nothing is written over what it holds; one that can't be read now is read again before the first write
  // (reread()). failed: it couldn't be read either way.
  readHeld() {
    const got = read(this.file);
    if (!got.error) return { ...split(got.list), failed: false };
    const none = { records: [], imported: new Set(), failed: true };
    if (got.unreadable) {
      this.unread = got.error;
      this.log(`held.json can't be read: ${got.error.message}`);
      return none;
    }
    const aside = `${this.file}.unreadable-${Date.now()}`;
    try {
      retried(() => fs.renameSync(this.file, aside));
      this.log(`held.json isn't a list Rukoo can read, and is kept as ${path.basename(aside)}: ${got.error.message}`);
    } catch (err) {
      this.unread = err;
      this.log(`held.json isn't a list Rukoo can read, and can't be put aside: ${err.message}`);
    }
    return none;
  }

  // held.json couldn't be read at the start. Before anything is written over it, it is read again, and what it lists
  // is kept too, for the next start. Throws a JournalError while it still can't be read.
  reread() {
    this.unread = null;
    const { records, imported } = this.readHeld();
    if (this.unread) throw new JournalError(this.unread);
    for (const e of records) {
      const r = record(e);
      if (r && !this.kept.has(r.id) && !this.settled.has(r.id)) this.kept.set(r.id, r);
    }
    for (const id of imported) this.imported.add(id);
  }

  get(id) {
    return this.kept.get(id) || null;
  }

  // Every kept email, oldest first.
  list() {
    return [...this.kept.values()];
  }

  get size() {
    return this.kept.size;
  }

  // Whether a send or a Drafts save of this kept email waits for the server.
  isBusy(id) {
    return this.busy.has(id);
  }

  // Whether this kept email may have gone already: it was on its way when Rukoo ended, or its send ran past wait.
  unsure(id) {
    const r = this.kept.get(id);
    return Boolean(r && r.state === 'sending');
  }

  // The editor that holds this kept email, or undefined.
  holder(id) {
    for (const [editor, held] of this.editors) if (held === id) return editor;
    return undefined;
  }

  // Whether an editor holds this kept email now.
  attached(id) {
    return this.holder(id) !== undefined;
  }

  hold(editor, id) {
    this.editors.set(editor, id);
    this.last.set(editor, id);
  }

  // Writes what is in memory: the kept emails, then the outbox's that aren't among them, and while unsent.json is still
  // there, the ids taken from it. Throws a JournalError when the profile can't be written to; the file then holds what
  // it held, no copy of the emails stays beside it, and the write is tried again a moment later.
  commit() {
    const tmp = `${this.file}.tmp`;
    try {
      if (this.unread) this.reread();
      let all;
      try {
        all = [...this.kept.values(), ...this.outbox().filter((e) => !this.kept.has(e.id))];
      } catch (_) {
        all = [...this.kept.values()];
      }
      if (this.imported.size) all.push({ legacy: [...this.imported] });
      if (!all.length) {
        retried(() => fs.rmSync(this.file, { force: true }));
      } else {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(all));
        retried(() => fs.renameSync(tmp, this.file));
      }
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (_) {
        // load() removes it at the next start.
      }
      this.later();
      throw err instanceof JournalError ? err : new JournalError(err);
    }
    if (this.retry) this.timers.clearTimeout(this.retry);
    this.retry = null;
    this.retryMs = RETRY_MS;
  }

  // commit() for what goes on without the file where it must: true once written. The log has why not.
  write() {
    try {
      this.commit();
      return true;
    } catch (err) {
      this.log(`held.json can't be written: ${err.message}`);
      return false;
    }
  }

  // Memory has what the file doesn't yet: it is written again a moment later, and later still while that fails.
  later() {
    if (this.retry) return;
    const ms = this.retryMs;
    this.retryMs = Math.min(ms * 2, 60000);
    this.retry = this.timers.setTimeout(() => {
      this.retry = null;
      this.write();
    }, ms);
    if (this.retry && typeof this.retry.unref === 'function') this.retry.unref();
  }

  // Before Rukoo exits: a write that still waits to be tried again goes now.
  flush() {
    if (this.retry) this.write();
  }

  // A change that must be in the file before what comes next happens: when it can't be written, memory goes back to
  // what it was and the JournalError goes to the caller.
  change(fn) {
    const kept = new Map(this.kept);
    const editors = new Map(this.editors);
    const last = new Map(this.last);
    const imported = new Set(this.imported);
    fn();
    try {
      this.commit();
    } catch (err) {
      this.kept = kept;
      this.editors = editors;
      this.last = last;
      this.imported = imported;
      throw err;
    }
  }

  // A change to what has happened already: memory keeps it, also when the file can't take it yet, so the next write has
  // it. Returns whether it was written.
  note(fn, what) {
    fn();
    try {
      this.commit();
      return true;
    } catch (err) {
      this.log(`held.json can't ${what} yet: ${err.message}`);
      return false;
    }
  }

  // Keeps an email that left the outbox unsent: { id, restore, error }. Returns its record, or null when nobody could
  // open it again. Kept in memory also when the file can't take it, and the outbox's own record of it stays in the file
  // until a write can be made: it is never in neither.
  keep(item) {
    const r = record(item);
    if (!r) return null;
    this.note(() => this.kept.set(r.id, r), 'keep a refused email');
    return r;
  }

  // The editor opened with this kept email. An editor holds one; a second attach replaces the first, which then stays
  // kept for the next start. false when the email isn't kept, another editor holds it, or it is busy.
  attach(editor, id) {
    if (!this.kept.has(id) || this.busy.has(id)) return false;
    const holder = this.holder(id);
    if (holder !== undefined && holder !== editor) return false;
    this.hold(editor, id);
    return true;
  }

  // The editor went: its window closed, or its page crashed or loaded again. Its email stays kept, for another editor
  // or the next start. Returns the record, or null when the editor held none.
  detach(editor) {
    const id = this.editors.get(editor);
    this.editors.delete(editor);
    this.last.delete(editor);
    return id !== undefined ? this.get(id) : null;
  }

  // The kept email an editor's call is about, by the id the editor names: that id when this editor holds it, or when
  // nobody does, as for an editor that opened it while its hand-off to the reading pane ended (the editor then holds it
  // from now on). null for no id: an email nobody kept. Throws a DoneError for an id that is done with, or that this run
  // never kept, and a BusyError while the email is busy, another editor holds it, or this editor holds another one.
  claim(editor, id) {
    if (typeof id !== 'string' || !id) return null;
    if (!this.kept.has(id)) throw new DoneError();
    if (this.busy.has(id)) throw new BusyError();
    const holder = this.holder(id);
    if (holder === editor) return id;
    if (holder !== undefined || this.editors.has(editor)) throw new BusyError();
    this.hold(editor, id);
    return id;
  }

  // The server took the email or its draft, or the outbox took it: memory lets it go at once, every editor that held it
  // holds nothing now, and its id is done with for the rest of the run. The file follows now, or with the next write
  // that can be made; a kill before that brings it back, as on its way when it was, with the note to check Sent.
  settle(id, as) {
    this.settled.set(id, { as });
    if (!this.kept.has(id)) return;
    this.note(() => {
      this.kept.delete(id);
      for (const [editor, held] of [...this.editors]) if (held === id) this.editors.delete(editor);
    }, 'let an email go');
  }

  // A kept email nobody holds, and that isn't busy, after its send or save ended or ran past wait: main opens it again.
  unheld(id) {
    if (this.kept.has(id) && !this.attached(id) && !this.busy.has(id)) this.orphaned(id);
  }

  // The editor closed with an answer: Delete, Don't save, or nothing left to keep. The email it names goes once the
  // file has that. Returns null when it did, or nothing needed it (no id, one done with, or one that is on its way and
  // answers for itself). When the file can't take it, the email stays kept for the next start, held by nobody, and the
  // JournalError comes back for the editor to say so before it closes.
  answer(editor, keptId) {
    let id;
    try {
      id = this.claim(editor, keptId);
    } catch (_) {
      return null;
    }
    if (!id) return null;
    // Done with before the write, so a held.json read again in it (reread()) can't bring the email back.
    this.settled.set(id, { as: 'discarded' });
    try {
      this.change(() => {
        this.kept.delete(id);
        this.editors.delete(editor);
      });
    } catch (err) {
      this.settled.delete(id);
      this.editors.delete(editor);
      return err;
    }
    return null;
  }

  // Send with Undo send. enqueue() puts the email in the outbox, whose write of held.json lists it (main.js gives the
  // outbox commit() as its changed()). A kept email this editor holds leaves the file in that same write, so a kill
  // finds it once, as itself or as queued. When the write fails, it stays kept, held by this editor, and the error goes
  // to the caller. One that may have gone already goes only with confirmed. Returns what enqueue() returns.
  queue(editor, keptId, enqueue, { confirmed = false } = {}) {
    const id = this.claim(editor, keptId);
    if (!id) return enqueue();
    if (this.inflight.has(id)) throw new BusyError();
    if (this.unsure(id) && !confirmed) throw new UnsureError();
    const kept = new Map(this.kept);
    const editors = new Map(this.editors);
    // Done with before the outbox's write, so a held.json read again in it (reread()) can't list it twice.
    this.settled.set(id, { as: 'queued' });
    this.kept.delete(id);
    this.editors.delete(editor);
    try {
      return enqueue();
    } catch (err) {
      this.settled.delete(id);
      this.kept = kept;
      this.editors = editors;
      throw err;
    }
  }

  // Marks the email busy while work runs, for wait ms at most. Resolves or rejects as work does, or resolves to LATE once
  // the time is up; work goes on then, and what it comes to still counts.
  busyFor(id, kind, work) {
    this.busy.set(id, kind);
    return new Promise((resolve, reject) => {
      let ended = false;
      const end = (settle) => (value) => {
        if (ended) return;
        ended = true;
        this.timers.clearTimeout(timer);
        this.busy.delete(id);
        const waiting = this.waiters.get(id) || [];
        this.waiters.delete(id);
        for (const wake of waiting) wake();
        settle(value);
      };
      const timer = this.timers.setTimeout(() => end(resolve)(LATE), this.wait);
      work.then(end(resolve), end(reject));
    });
  }

  // Resolves once this email isn't busy.
  idle(id) {
    if (!this.busy.has(id)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) || []), resolve]));
  }

  // Send straight away, without Undo send. Before deliver() starts, the file has the email as on its way, as the editor
  // holds it now (restore): under the kept email's id when this editor holds one, under a new id otherwise; when the
  // file can't take that, it isn't sent and a JournalError says so. So a kill while it goes brings back what was sent,
  // with the note to check Sent first. deliver(accepted) sends it and calls accepted() the moment the server took it;
  // from then on its id is done with, whatever comes after. Refused, the email stays kept with the server's error for
  // the editor that sent it, which hears its id (err.keptId); one whose editor went meanwhile goes to orphaned(). No
  // answer within wait: an UnsureError, with its id, and the email stays as on its way; an answer that comes later
  // still counts. Throws a BusyError while the email is on its way or another editor holds it, and an UnsureError for
  // one that may have gone already without confirmed, in each case before anything is sent.
  async send(editor, keptId, restore, deliver, { confirmed = false } = {}) {
    const claimed = this.claim(editor, keptId);
    if (claimed && this.inflight.has(claimed)) throw new BusyError();
    if (claimed && this.unsure(claimed) && !confirmed) throw new UnsureError();
    if (!isRestore(restore)) {
      // Nothing to open its editor from, as for a send that never had one.
      await deliver(() => {});
      if (claimed) this.settle(claimed, 'sent');
      return;
    }
    const id = claimed || crypto.randomUUID();
    const before = claimed ? this.kept.get(id) : null;
    const base = { id, restore, ...(before && before.origin ? { origin: before.origin } : {}) };
    this.change(() => {
      this.kept.set(id, { ...base, state: 'sending' });
      this.hold(editor, id);
    });
    this.inflight.add(id);
    this.unanswered.delete(id);
    let took = false;
    const accepted = () => {
      if (took) return;
      took = true;
      this.settle(id, 'sent');
    };
    const work = Promise.resolve()
      .then(() => deliver(accepted))
      .then(
        () => accepted(),
        (err) => {
          // What fails after the server took it, such as its Sent copy, doesn't make it refused. An email let go
          // meanwhile, by Delete after an answer came too late, stays gone.
          if (took) return;
          const r = this.kept.get(id);
          if (r) {
            const { state: _state, ...rest } = r;
            this.note(() => this.kept.set(id, { ...rest, error: (err && err.message) || String(err) }), 'note a refused email');
          }
          throw err;
        }
      )
      .finally(() => {
        this.inflight.delete(id);
        this.unanswered.delete(id);
      });
    let result;
    try {
      result = await this.busyFor(id, 'send', work);
    } catch (err) {
      if (err && typeof err === 'object') err.keptId = id;
      this.unheld(id);
      throw err;
    }
    if (result !== LATE || took) return;
    // No answer in time: it may still go. The file keeps it as on its way, and its editor hears that.
    this.unanswered.add(id);
    const err = new UnsureError();
    err.keptId = id;
    this.unheld(id);
    throw err;
  }

  // A Drafts save from an editor. For a kept email this editor holds, the file gets what the editor holds now (restore)
  // and the draft's Message-ID in one write, right before the server gets the draft (hooks.appending); when the file
  // can't take that, the draft isn't saved. The moment the server took the draft (hooks.accepted), the email's id is
  // done with, before the save removes the draft it replaces: a kill at any point leaves either the email in the file,
  // with the draft its attachments come from still on the server, or the new draft in Drafts, which the next start
  // finds (recover()). store(hooks) runs the save and resolves to what it gives. A save that fails leaves the email kept
  // with what the editor holds; one whose editor went meanwhile goes to orphaned(). After wait the email is no longer
  // busy, and an editor that took it over then goes on with it: the save's answer no longer lets it go. Throws a
  // DoneError or BusyError as claim() does, and a BusyError while a send or save of it can still end.
  async save(editor, keptId, restore, store) {
    const id = this.claim(editor, keptId);
    if (!id) return store({});
    if (this.inflight.has(id)) throw new BusyError();
    const snapshot = isRestore(restore) ? restore : null;
    // Whether this save still answers for the email: nobody else took it over after wait.
    const ours = () => this.kept.has(id) && [undefined, editor].includes(this.holder(id));
    let noted = false;
    let took = false;
    const appending = ({ accountId, messageId } = {}) => {
      if (!ours()) throw new BusyError();
      this.change(() => {
        const { draft: _draft, ...r } = this.kept.get(id);
        this.kept.set(id, { ...r, ...(snapshot ? { restore: snapshot } : {}), draft: { accountId: String(accountId || ''), messageId: String(messageId || '') } });
      });
      noted = true;
    };
    const accepted = () => {
      if (took) return;
      took = true;
      if (ours()) this.settle(id, 'saved');
      else this.log('A draft reached Drafts after its email opened in another editor, which goes on with it.');
    };
    this.inflight.add(id);
    const work = Promise.resolve()
      .then(() => store({ appending, accepted }))
      .then(
        (value) => {
          accepted();
          return value;
        },
        (err) => {
          // Saved nowhere: what the editor holds now stays here for a crash, as far as the file can take it.
          if (!took && !noted && snapshot && ours()) this.note(() => this.kept.set(id, { ...this.kept.get(id), restore: snapshot }), 'take what an editor holds');
          throw err;
        }
      )
      .finally(() => this.inflight.delete(id));
    let result;
    try {
      result = await this.busyFor(id, 'save', work);
    } catch (err) {
      this.unheld(id);
      throw err;
    }
    if (result !== LATE) return result;
    // The editor goes on waiting for the server, as for any draft; nothing else waits for it any more.
    this.unheld(id);
    return work;
  }

  // At the start, for a kept email: what to do with it. has(draft) asks the server whether Drafts has the draft that was
  // on its way with it when Rukoo ended, by its Message-ID: true or false, or a rejection when nobody can tell now (no
  // connection, the account or its Drafts gone). 'gone' when Drafts has it: the email's id is done with. 'open' when it
  // has no such draft, or none was on its way: it opens again as it was kept. 'unsure' when nobody can tell: it opens
  // again all the same, still naming that draft, so its editor says it may be in Drafts already. Nothing is deleted or
  // sent on that guess.
  async recover(id, has) {
    const r = this.kept.get(id);
    if (!r) return 'gone';
    if (!r.draft) return 'open';
    let found;
    try {
      found = await has(r.draft);
    } catch (_) {
      return 'unsure';
    }
    if (this.kept.get(id) !== r) return this.kept.has(id) ? 'open' : 'gone';
    if (found === true) {
      this.settle(id, 'saved');
      return 'gone';
    }
    if (found !== false) return 'unsure';
    const { draft: _draft, ...rest } = r;
    this.note(() => this.kept.set(id, rest), 'note a draft that never got there');
    return 'open';
  }

  // What a compose window opens with, as main has its email now, also when its page loads again after a crash: once a
  // send or save of it has ended or ran past wait, { id, record } for a kept email, or { id, settled } once it is done
  // with. null for a window that held no kept email.
  async opening(editor) {
    const id = this.last.get(editor);
    if (id === undefined) return null;
    await this.idle(id);
    if (this.kept.has(id)) return { id, record: this.kept.get(id) };
    return { id, settled: this.settled.get(id) || { as: 'gone' } };
  }
}

module.exports = { HeldMail, JournalError, BusyError, DoneError, UnsureError };
