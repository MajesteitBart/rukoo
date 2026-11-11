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

// Refused emails main keeps for the main window until its page has opened them (holdRefused in main.js). Each item
// has an id. The page asks what waits (waiting()), claims one when its reading pane is free to take it (claim()),
// and says so once the editor is open with it (ack()). Until that ack the email stays here, so a page that is still
// loading, or crashes, closes or reloads halfway through a batch, loses none: letGo() sends every one still held to
// elsewhere(items), and a quit writes them down from list(). An email opens once: an ack, claim or release for one
// that is no longer held does nothing.
//
// One nobody claimed within ms goes to elsewhere([item]) by itself, for a page that never asks. A claim stops that
// timer: the editor opens a moment later, and the timer would then open the email a second time. A page that
// reloads starts over (unclaim()). release(id) sends one to elsewhere() at the page's request, when its reading pane
// can't take it after all. timers is the clock, which the tests replace.
class Handoff {
  constructor({ elsewhere, ms, timers = { setTimeout, clearTimeout } }) {
    this.elsewhere = elsewhere;
    this.ms = ms;
    this.timers = timers;
    // id -> { item, timer, claimed }, oldest first.
    this.held = new Map();
  }

  get size() {
    return this.held.size;
  }

  // Every email still held, claimed or not, oldest first.
  list() {
    return [...this.held.values()].map((h) => h.item);
  }

  // Those the page hasn't claimed yet, oldest first. They stay held.
  waiting() {
    return [...this.held.values()].filter((h) => !h.claimed).map((h) => h.item);
  }

  hold(item) {
    this.drop(item.id);
    const held = { item, timer: null, claimed: false };
    this.held.set(item.id, held);
    this.arm(held);
  }

  // The page's reading pane takes this one now. false when it is gone, or another call already claimed it.
  claim(id) {
    const held = this.held.get(id);
    if (!held || held.claimed) return false;
    held.claimed = true;
    this.timers.clearTimeout(held.timer);
    return true;
  }

  // The page reloaded: what it had claimed but not opened waits for the new page, with a new timer.
  unclaim() {
    for (const held of this.held.values()) {
      if (!held.claimed) continue;
      held.claimed = false;
      this.arm(held);
    }
  }

  // Its editor is open with the email, which main no longer keeps. false for an id that is not held.
  ack(id) {
    return Boolean(this.drop(id));
  }

  // Opens one elsewhere at the page's request. false when it is no longer held.
  release(id) {
    const held = this.drop(id);
    if (held) this.elsewhere([held.item]);
    return Boolean(held);
  }

  letGo() {
    const items = [...this.held.keys()].map((id) => this.drop(id).item);
    if (items.length) this.elsewhere(items);
  }

  arm(held) {
    held.timer = this.timers.setTimeout(() => {
      if (this.held.get(held.item.id) !== held || held.claimed) return;
      this.release(held.item.id);
    }, this.ms);
  }

  drop(id) {
    const held = this.held.get(id);
    if (!held) return null;
    this.timers.clearTimeout(held.timer);
    this.held.delete(id);
    return held;
  }
}

module.exports = { Outbox, Handoff };
