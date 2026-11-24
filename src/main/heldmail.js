'use strict';

// held.json in the profile: every email Rukoo still answers for after Send, so a crash or a killed process loses none
// (#256, #309). Two kinds share the file, each under the email's id in the outbox:
//
// - The outbox's own emails, which wait out their Undo notice or are on their way (Outbox.journal()).
// - Kept emails, which left the outbox or an earlier run unsent: refused by the server, left behind by a quit, or
//   reopened after a crash. Each stays until the editor that holds it has saved it as a draft, sent or queued it, or
//   closed with an answer (settle()). An editor that is merely open, or still loading, holds it in its window's memory
//   only, so a crash before that brings it back at the next start, once.
//
// A kept email wins over the outbox's entry with the same id: a refused email is kept, with its error, before the
// outbox lets it go. Every change replaces the whole file, written beside it first and then moved over it, so a crash
// halfway leaves the last whole list; synchronously, so a kill straight after the change finds it.
//
// unsent.json is where Rukoo before #309 kept the refused emails a quit left. load() folds it in once.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// What the file keeps of an email, or null for one nobody could open again: { id, restore, error, state, origin }.
// state: 'waiting' or 'sending' for an outbox email; 'sending' also for a kept one whose editor sends it straight away.
function record(e) {
  if (!e || typeof e !== 'object' || !e.restore || typeof e.restore !== 'object' || Array.isArray(e.restore)) return null;
  // Every Rukoo that wrote these gave each an id. One without gets the same id at every read, so a list read twice
  // (a kill while load() folds unsent.json in) still lists it once.
  const id = typeof e.id === 'string' && e.id ? e.id : crypto.createHash('sha256').update(JSON.stringify([e.restore, e.error || ''])).digest('hex').slice(0, 32);
  const r = { id, restore: e.restore };
  if (typeof e.error === 'string' && e.error) r.error = e.error;
  if (e.state === 'waiting' || e.state === 'sending') r.state = e.state;
  if (typeof e.origin === 'string') r.origin = e.origin;
  return r;
}

function read(file) {
  if (!file) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

class HeldMail {
  // file: held.json. legacy: unsent.json, or null. outbox(): the outbox's journal() as it is now.
  constructor({ file, legacy = null, outbox = () => [] }) {
    this.file = file;
    this.legacy = legacy;
    this.outbox = outbox;
    // id -> record, oldest first.
    this.kept = new Map();
    // The editor that holds each kept email now: a compose window's webContents id, or 'pane' for the main window's
    // reading pane -> the email's id.
    this.editors = new Map();
  }

  // At the start, before anything can be queued: what the last run left, kept now, oldest first. An email listed in
  // both files counts once, as unsent.json has it: an older Rukoo wrote a refused email there before the outbox let it
  // go from held.json. unsent.json goes only once held.json has its emails, so a kill in between reads them again.
  load() {
    const list = [];
    for (const e of [...read(this.legacy), ...read(this.file)]) {
      const r = record(e);
      if (r && !list.some((x) => x.id === r.id)) list.push(r);
    }
    for (const r of list) this.kept.set(r.id, r);
    if (this.write() && this.legacy) {
      try {
        fs.rmSync(this.legacy, { force: true });
      } catch (_) {
        // Read again at the next start, which finds the same emails here and lists each once.
      }
    }
    return list;
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

  // Keeps an email that left the outbox unsent: { id, restore, error }. Returns its record, or null when nobody could
  // open it again.
  keep(item) {
    const r = record(item);
    if (!r) return null;
    this.kept.set(r.id, r);
    this.write();
    return r;
  }

  // The editor opened with this kept email. An editor holds one; a second attach replaces the first, which then
  // stays kept for the next start.
  attach(editor, id) {
    if (!this.kept.has(id)) return false;
    this.editors.set(editor, id);
    return true;
  }

  // Whether an editor holds this kept email now.
  attached(id) {
    for (const held of this.editors.values()) if (held === id) return true;
    return false;
  }

  // The editor went without an answer: its window closed or crashed. Its email stays kept, for another editor or the
  // next start. Returns the record, or null when the editor held none.
  detach(editor) {
    const id = this.editors.get(editor);
    this.editors.delete(editor);
    return id !== undefined ? this.get(id) : null;
  }

  // The editor saved its email as a draft, sent or queued it, or closed with an answer, so it is kept no longer.
  // Returns its id, or null when the editor held none. write: false when the caller's own write follows at once (the
  // outbox's queue()), so the file goes from this email to the queued one in a single step.
  settle(editor, { write = true } = {}) {
    const id = this.editors.get(editor);
    if (id === undefined) return null;
    this.editors.delete(editor);
    this.kept.delete(id);
    if (write) this.write();
    return id;
  }

  // The editor sends its kept email straight away, without Undo send. Until the server answers, the email counts as on
  // its way, so a crash meanwhile reopens it with the note to check Sent first. Returns what puts it back as it was
  // when the server refused it and the editor stays open.
  sending(editor) {
    const r = this.get(this.editors.get(editor));
    if (!r) return () => {};
    const before = r.state;
    r.state = 'sending';
    this.write();
    return () => {
      if (this.kept.get(r.id) !== r) return;
      if (before) r.state = before;
      else delete r.state;
      this.write();
    };
  }

  // The kept emails, then the outbox's that aren't among them. Returns false when the profile couldn't be written to;
  // the last whole list then stays.
  write() {
    let all;
    try {
      all = [...this.kept.values(), ...this.outbox().filter((e) => !this.kept.has(e.id))];
    } catch (_) {
      all = [...this.kept.values()];
    }
    try {
      if (!all.length) {
        fs.rmSync(this.file, { force: true });
        return true;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(all));
      fs.renameSync(`${this.file}.tmp`, this.file);
      return true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { HeldMail };
