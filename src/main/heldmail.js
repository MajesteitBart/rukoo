'use strict';

// held.json in the profile: every email Rukoo still answers for after Send, so a crash or a killed process loses none,
// brings none back twice and sends none twice (#256, #309). Two kinds share the file, each under its own id:
//
// - The outbox's emails, which wait out their Undo notice or are on their way (Outbox.journal()).
// - Kept emails: refused by the server, left behind by a quit, reopened after a crash, or sent straight away and not
//   answered for yet. Each stays until the editor that holds it has answered for it: the server took its draft or the
//   email itself, the outbox took it, or the editor closed with an answer. An editor that is merely open, or still
//   loading, holds it in its window's memory only, so a crash before that brings it back at the next start, once.
//
// Every call about a kept email names it by its id, from the moment it starts to the moment it ends: an editor names
// the email it was opened with (composer.js keptId), and only an editor that holds that email can answer for it. A send
// or a Drafts save that is on its way marks its email busy until it ends. Nothing opens a busy email again, and no
// other send can start with it.
//
// A kept email wins over the outbox's entry with the same id: a refused email is kept, with its error, before the
// outbox lets it go. Every change replaces the whole file, written beside it first and then moved over it, so a crash
// halfway leaves the last whole list; synchronously, so a kill straight after the change finds it. A change that can't
// be written leaves the file and the list in memory as they were, removes what it wrote beside the file, and throws a
// JournalError for the caller.
//
// unsent.json is where Rukoo before #309 kept the refused emails a quit left. load() takes them in once. Until that
// file is gone, held.json names the ids it took from it, and from then on those are held.json's.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A change to held.json that couldn't be written. The file and the list in memory hold what they held before.
class JournalError extends Error {
  constructor(cause) {
    super((cause && cause.message) || String(cause));
    this.name = 'JournalError';
    this.code = 'EJOURNAL';
  }
}

// A send of a kept email that another editor holds, or that is on its way already.
class BusyError extends Error {
  constructor() {
    super('This email is already on its way, or open in another window.');
    this.name = 'BusyError';
    this.code = 'EKEPTBUSY';
  }
}

// What the file keeps of an email, or null for one nobody could open again: { id, restore, error, state, origin,
// draft }. state: 'waiting' or 'sending' for an outbox email; 'sending' also for a kept one whose editor sends it
// straight away. draft: { accountId, messageId } of the Drafts save that was on its way for it (save()).
function record(e) {
  if (!e || typeof e !== 'object' || !e.restore || typeof e.restore !== 'object' || Array.isArray(e.restore)) return null;
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

// A JSON list from a file: { list }, empty with missing: true when there is no file; { error } when the file is there
// but can't be read (unreadable: true), or holds something else.
function read(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
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

// Moves the new list over the file. Windows refuses that for a moment while another program, such as a virus
// scanner, has either file open, so there it tries again a few times, 20 ms apart, before the change counts as failed.
function moveOver(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err && err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
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
  // email whose send or save ended without the server taking it after its editor went, which main opens again.
  // log(message): what went wrong with the files, for the log in the profile.
  constructor({ file, legacy = null, outbox = () => [], orphaned = () => {}, log = () => {} }) {
    this.file = file;
    this.legacy = legacy;
    this.outbox = outbox;
    this.orphaned = orphaned;
    this.log = log;
    // id -> record, oldest first. Records are replaced, never changed, so a change that can't be written goes back.
    this.kept = new Map();
    // The editor that holds each kept email now: a compose window's webContents id, or 'pane' for the main window's
    // reading pane -> the email's id.
    this.editors = new Map();
    // id -> 'send' or 'save', while one of those is on its way with that email.
    this.busy = new Map();
    // The ids held.json took from unsent.json, while that file is still there.
    this.imported = new Set();
    // Why held.json couldn't be read at the start, while it still can't: nothing is written over it until it can.
    this.unread = null;
  }

  // At the start, before anything can be queued: what the last run left, kept now, oldest first. An email listed in
  // both files counts once, as unsent.json has it the first time: an older Rukoo wrote a refused email there before the
  // outbox let it go from held.json. After that the ids held.json took are its own, also while unsent.json can't be
  // removed. A file that can't be read, or holds something else, is never removed as if it had been taken in.
  load() {
    // A list that never became the file: what the file holds is what was written last.
    try {
      fs.rmSync(`${this.file}.tmp`, { force: true });
    } catch (_) {
      // Written over by the next change.
    }
    const held = this.readHeld();
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
    if (taken) {
      try {
        this.commit();
      } catch (err) {
        this.log(`held.json can't take in unsent.json, which stays: ${err.message}`);
        return list;
      }
    }
    try {
      fs.rmSync(this.legacy, { force: true });
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

  // held.json as the start finds it. One that holds something else is put aside beside it, so nothing is written over
  // what it holds; one that can't be read now is read again before the first write (reread()).
  readHeld() {
    const got = read(this.file);
    if (!got.error) return split(got.list);
    if (got.unreadable) {
      this.unread = got.error;
      this.log(`held.json can't be read: ${got.error.message}`);
      return split([]);
    }
    const aside = `${this.file}.unreadable-${Date.now()}`;
    try {
      fs.renameSync(this.file, aside);
      this.log(`held.json isn't a list Rukoo can read, and is kept as ${path.basename(aside)}: ${got.error.message}`);
    } catch (err) {
      this.unread = err;
      this.log(`held.json isn't a list Rukoo can read, and can't be put aside: ${err.message}`);
    }
    return split([]);
  }

  // held.json couldn't be read at the start. Before anything is written over it, it is read again, and what it lists
  // is kept too, for the next start. Throws a JournalError while it still can't be read.
  reread() {
    this.unread = null;
    const { records, imported } = this.readHeld();
    if (this.unread) throw new JournalError(this.unread);
    for (const e of records) {
      const r = record(e);
      if (r && !this.kept.has(r.id)) this.kept.set(r.id, r);
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

  // Whether a send or a Drafts save is on its way with this kept email.
  isBusy(id) {
    return this.busy.has(id);
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

  // Applies fn to the lists in memory and writes the file. When it can't be written, the lists go back to what they
  // were and the JournalError goes to the caller.
  change(fn) {
    if (this.unread) this.reread();
    const kept = new Map(this.kept);
    const editors = new Map(this.editors);
    const imported = new Set(this.imported);
    fn();
    try {
      this.commit();
    } catch (err) {
      this.kept = kept;
      this.editors = editors;
      this.imported = imported;
      throw err;
    }
  }

  // Writes what is in memory: the kept emails, then the outbox's that aren't among them, and while unsent.json is still
  // there, the ids taken from it. Throws a JournalError when the profile can't be written to; the file then holds what
  // it held, and no copy of the emails stays beside it.
  commit() {
    if (this.unread) this.reread();
    let all;
    try {
      all = [...this.kept.values(), ...this.outbox().filter((e) => !this.kept.has(e.id))];
    } catch (_) {
      all = [...this.kept.values()];
    }
    if (this.imported.size) all.push({ legacy: [...this.imported] });
    const tmp = `${this.file}.tmp`;
    try {
      if (!all.length) {
        fs.rmSync(this.file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(all));
      moveOver(tmp, this.file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (_) {
        // load() removes it at the next start.
      }
      throw new JournalError(err);
    }
  }

  // For the outbox's changed(), which goes on without a journal where it can: true once written.
  write() {
    try {
      this.commit();
      return true;
    } catch (err) {
      this.log(`held.json can't be written: ${err.message}`);
      return false;
    }
  }

  // Keeps an email that left the outbox unsent: { id, restore, error }. Returns its record, or null when nobody could
  // open it again. Throws a JournalError when the file can't take it; it is then not kept.
  keep(item) {
    const r = record(item);
    if (!r) return null;
    this.change(() => this.kept.set(r.id, r));
    return r;
  }

  // The editor opened with this kept email. An editor holds one; a second attach replaces the first, which then stays
  // kept for the next start. false when the email isn't kept, another editor holds it, or it is on its way.
  attach(editor, id) {
    if (!this.kept.has(id) || this.busy.has(id)) return false;
    const holder = this.holder(id);
    if (holder !== undefined && holder !== editor) return false;
    this.editors.set(editor, id);
    return true;
  }

  // The editor went without an answer: its window closed or crashed. Its email stays kept, for another editor or the
  // next start. Returns the record, or null when the editor held none.
  detach(editor) {
    const id = this.editors.get(editor);
    this.editors.delete(editor);
    return id !== undefined ? this.get(id) : null;
  }

  // The kept email an editor's call is about, by the id the editor names: that id when this editor holds it, or when
  // nobody does and nothing is on its way with it, as for an editor that opened it while its hand-off to the reading
  // pane ended (the editor then holds it from now on). null for no id, or one that isn't kept any more. false when
  // another editor holds it, when this editor holds another one, or when a send or save is on its way with it.
  claim(editor, id) {
    if (typeof id !== 'string' || !this.kept.has(id)) return null;
    if (this.busy.has(id)) return false;
    const holder = this.holder(id);
    if (holder === editor) return id;
    if (holder !== undefined || this.editors.has(editor)) return false;
    this.editors.set(editor, id);
    return id;
  }

  // Lets a kept email go: the server or the outbox took it, or its editor closed with an answer. Every editor that held
  // it holds nothing now. Throws a JournalError when the file can't be written; it then stays, held as before.
  release(id) {
    if (!this.kept.has(id)) return false;
    this.change(() => {
      this.kept.delete(id);
      for (const [editor, held] of [...this.editors]) if (held === id) this.editors.delete(editor);
    });
    return true;
  }

  // release() for an email that is answered for whatever the file says: when it can't be written, the email stays as
  // the file has it, and the editor's next answer, or the next start, tries again.
  settled(id) {
    try {
      this.release(id);
    } catch (err) {
      this.log(`held.json can't let an email go: ${err.message}`);
    }
  }

  // A kept email nobody holds, and nothing is on its way with, after its send or save ended: main opens it again.
  unheld(id) {
    if (this.kept.has(id) && !this.attached(id) && !this.busy.has(id)) this.orphaned(id);
  }

  // The editor closed with an answer (sent, saved, deleted, or nothing to keep): the email it names goes. Returns
  // whether it did.
  answer(editor, keptId) {
    const id = this.claim(editor, keptId);
    if (!id) return false;
    try {
      this.release(id);
      return true;
    } catch (err) {
      this.log(`held.json can't let an email go: ${err.message}`);
      return false;
    }
  }

  // Send with Undo send. enqueue() puts the email in the outbox, whose write of held.json lists it (main.js gives the
  // outbox commit() as its changed()). A kept email this editor holds leaves the file in that same write, so a kill
  // finds it once, as itself or as queued. When the write fails, it stays kept, held by this editor, and the error goes
  // to the caller. Returns what enqueue() returns.
  queue(editor, keptId, enqueue) {
    const id = this.claim(editor, keptId);
    if (id === false) throw new BusyError();
    if (!id) return enqueue();
    const kept = new Map(this.kept);
    const editors = new Map(this.editors);
    this.kept.delete(id);
    this.editors.delete(editor);
    try {
      return enqueue();
    } catch (err) {
      this.kept = kept;
      this.editors = editors;
      throw err;
    }
  }

  // Send straight away, without Undo send. Before deliver() starts, the file has the email as on its way, as the editor
  // holds it now (restore): under the kept email's id when this editor holds one, under a new id otherwise. So a kill
  // while it goes brings back what was sent, with the note to check Sent first. deliver(accepted) sends it and calls
  // accepted() the moment the server took it; from then on the file lets it go, whatever comes after. Refused, the
  // email stays kept with the server's error for the editor that sent it, which hears its id (err.keptId); one whose
  // editor went meanwhile goes to orphaned(). Throws a BusyError when the email is on its way already or another editor
  // holds it, and a JournalError when the file can't take it, in both cases before anything is sent.
  async send(editor, keptId, restore, deliver) {
    const claimed = this.claim(editor, keptId);
    if (claimed === false) throw new BusyError();
    if (!restore || typeof restore !== 'object' || Array.isArray(restore)) {
      // Nothing to open its editor from, as for a send that never had one.
      await deliver(() => {});
      if (claimed) this.settled(claimed);
      return;
    }
    const id = claimed || crypto.randomUUID();
    const before = claimed ? this.kept.get(id) : null;
    const base = { id, restore, ...(before && before.origin ? { origin: before.origin } : {}) };
    this.change(() => {
      this.kept.set(id, { ...base, state: 'sending' });
      this.editors.set(editor, id);
    });
    this.busy.set(id, 'send');
    let took = false;
    const accepted = () => {
      if (took) return;
      took = true;
      this.busy.delete(id);
      this.settled(id);
    };
    try {
      await deliver(accepted);
    } catch (err) {
      // The server took it before what failed after, such as its Sent copy: it went.
      if (took) return;
      this.busy.delete(id);
      try {
        this.change(() => this.kept.set(id, { ...base, error: (err && err.message) || String(err) }));
      } catch (journal) {
        // The file keeps it as on its way, so a crash now says to check Sent first.
        this.log(`held.json can't note a refused email: ${journal.message}`);
      }
      if (err && typeof err === 'object') err.keptId = id;
      this.unheld(id);
      throw err;
    }
    accepted();
  }

  // A Drafts save from an editor. For a kept email this editor holds, the file first gets what the editor holds now
  // (restore), and then, right before the server gets the draft, its Message-ID (hooks.appending), so the next start can
  // tell whether the draft got there (recover()). The moment the server took the draft (hooks.accepted), the file lets
  // the email go, before the save removes the draft it replaces: a kill at any point leaves either the email in the
  // file, with the draft its attachments come from still on the server, or the new draft. store(hooks) runs the save
  // and resolves to what it gives. A save that fails leaves the email kept; one whose editor went meanwhile goes to
  // orphaned().
  async save(editor, keptId, restore, store) {
    const id = this.claim(editor, keptId);
    if (!id) return store({});
    const current = () => {
      const { draft: _draft, ...r } = this.kept.get(id);
      return r;
    };
    if (restore && typeof restore === 'object' && !Array.isArray(restore)) {
      try {
        this.change(() => this.kept.set(id, { ...current(), restore }));
      } catch (err) {
        this.log(`held.json can't take what an editor holds: ${err.message}`);
      }
    }
    this.busy.set(id, 'save');
    let took = false;
    const accepted = () => {
      if (took) return;
      took = true;
      this.busy.delete(id);
      this.settled(id);
    };
    const appending = ({ accountId, messageId } = {}) => {
      if (took || !this.kept.has(id) || typeof messageId !== 'string') return;
      try {
        this.change(() => this.kept.set(id, { ...current(), draft: { accountId: String(accountId || ''), messageId } }));
      } catch (err) {
        this.log(`held.json can't note a draft on its way: ${err.message}`);
      }
    };
    try {
      const result = await store({ appending, accepted });
      accepted();
      return result;
    } catch (err) {
      if (!took) {
        this.busy.delete(id);
        this.unheld(id);
      }
      throw err;
    }
  }

  // At the start, for a kept email: whether to open it again. One whose editor was saving it to Drafts when Rukoo ended
  // may be there already: find(draft) looks for that draft by its Message-ID. Found, Drafts has the email and the file
  // lets it go. Not found, or when nobody can tell (no connection, the account gone), it opens again.
  async recover(id, find) {
    const r = this.kept.get(id);
    if (!r) return false;
    if (!r.draft) return true;
    let found = null;
    try {
      found = await find(r.draft);
    } catch (_) {
      return true;
    }
    if (!found) return true;
    this.settled(id);
    return false;
  }
}

module.exports = { HeldMail, JournalError, BusyError };
