'use strict';

// Agent events the chat panel must not miss while it is not listening yet. The hub starts before the main window
// opens, and a remote agent can call in before the panel has loaded; IPC does not replay an event for a listener
// that came late. What would be lost waits here until the panel says it listens: a reveal, an approval that waits
// for the user, and a request for the composer. Everything else goes out at once: before a chat is open the
// panel fetches what it shows, so the rest has nothing to update. At max the oldest goes first.
function held(payload) {
  if (!payload) return false;
  const { kind, item } = payload;
  return kind === 'reveal' || kind === 'ui' || (kind === 'item' && Boolean(item) && item.type === 'approval' && item.status === 'pending');
}

class PanelGate {
  constructor(send, max = 500) {
    this.send = send;
    this.max = max;
    this.listening = false;
    this.waiting = [];
  }

  event(payload) {
    if (this.listening || !held(payload)) return this.send(payload);
    if (this.waiting.length >= this.max) this.waiting.shift();
    this.waiting.push(payload);
  }

  // The panel listens: what waited goes out, in order.
  open() {
    this.listening = true;
    const waiting = this.waiting;
    this.waiting = [];
    for (const payload of waiting) this.send(payload);
  }

  // The window reloads or closes: hold again until a new panel listens.
  close() {
    this.listening = false;
  }
}

module.exports = { PanelGate, held };
