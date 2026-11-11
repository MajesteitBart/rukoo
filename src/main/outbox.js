'use strict';

// Undo send (#104). After Send an email waits here for the time set in Settings > General > Undo send, while the
// main window shows a notice whose Undo takes it back. It sits above Engine.send, so IMAP and the demo account wait
// the same way. Calendar answers and booking mail call engine.send themselves and go at once.
//
// The queue is kept in memory only. A quit sends what still waits before Rukoo exits (flush(), from will-quit in
// main.js); what the quit can't send or keep in Drafts, main writes down for the next start (unsent.json). A crash
// loses the queue, apart from a draft the editor had saved: that stays on the server until the email is sent,
// because Engine.send deletes it only afterwards.
const crypto = require('crypto');

class Outbox {
  // send(payload): sends one email (engine.send). sent(entry) runs after it went, failed(entry, err) after it was
  // refused, and flush() waits for both. timers and now are the clock, which the tests replace.
  constructor({ send, sent = () => {}, failed = () => {}, timers = { setTimeout, clearTimeout }, now = Date.now }) {
    this.sendMail = send;
    this.afterSent = sent;
    this.afterFailed = failed;
    this.timers = timers;
    this.now = now;
    // id -> { id, payload, restore, origin, until, state: 'waiting' | 'sending', timer, done }
    this.entries = new Map();
  }

  // Emails that still wait or are on their way.
  get size() {
    return this.entries.size;
  }

  // Those emails: { id, payload, restore, origin, state }.
  left() {
    return [...this.entries.values()].map(({ id, payload, restore, origin, state }) => ({ id, payload, restore, origin, state }));
  }

  // Holds an email for ms, then sends it. restore: what opens its editor again (composer.js undoState); origin:
  // 'main' when it was written in the main window, 'window' for a compose window. Returns { id, until }.
  queue({ payload, restore = null, origin = 'main', ms }) {
    const id = crypto.randomUUID();
    const entry = { id, payload, restore, origin, until: this.now() + ms, state: 'waiting', timer: null, done: null };
    entry.timer = this.timers.setTimeout(() => this.go(entry), ms);
    this.entries.set(id, entry);
    return { id, until: entry.until };
  }

  // Takes back an email that still waits: { payload, restore, origin }. null once it is on its way or sent, or for
  // an id this outbox doesn't know.
  undo(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'waiting') return null;
    this.timers.clearTimeout(entry.timer);
    this.entries.delete(id);
    return { payload: entry.payload, restore: entry.restore, origin: entry.origin };
  }

  // Sends every email that waits, now. Resolves once all of them, and any already on their way, are sent or refused
  // and their sent() or failed() has run. Never rejects.
  flush() {
    for (const entry of this.entries.values()) {
      if (entry.state !== 'waiting') continue;
      this.timers.clearTimeout(entry.timer);
      this.go(entry);
    }
    return Promise.all([...this.entries.values()].map((entry) => entry.done)).then(() => {});
  }

  go(entry) {
    if (entry.state !== 'waiting') return entry.done;
    entry.state = 'sending';
    entry.done = Promise.resolve()
      .then(() => this.sendMail(entry.payload))
      .then(
        () => this.afterSent(entry),
        (err) => this.afterFailed(entry, err)
      )
      .catch(() => {})
      .finally(() => this.entries.delete(entry.id));
    return entry.done;
  }
}

module.exports = { Outbox };
