'use strict';

// Sending and removing messages (team chat contract 3.8 and 3.14). The service (index.js) and the sync engine
// (sync.js) call the hooks below; ipc.js turns METHODS into the chat* IPC methods, each as
// (svc, ...checkedArgs) => result. This file holds the hooks only, each doing nothing, until the sending package fills
// them in. index.js, sync.js and ipc.js stay as they are when it does.
//
// What the service gives this module: svc.store, svc.epoch, svc.call(ws, method, route, body, { retry }),
// svc.details(ws) (GET /, which also measures the clock and runs the restore path), svc.clock() (the server's time
// minus local time, or null when unknown or older than timing.clockMaxAge), svc.emitChat(payload),
// svc.roomsChanged(ws, ids), svc.sync(ws, why), svc.me(ws), svc.timing (sendBackoff, retryDelay), svc.now(),
// svc.timers and svc.isStale(err).

class Outbox {
  // The chat* IPC methods this module answers: chatSend, chatResend, chatDiscard and chatRedact.
  static METHODS = {};

  constructor(svc) {
    this.svc = svc;
  }

  // Sends what is due: after each run, on focus, resume and socket open, and after a restore or Start over, whose
  // transaction already ran store.markLookup. ws: only that workspace's rooms, or every workspace when omitted.
  kick(ws) {}

  // How many messages wait to be sent, for ChatState.unsent and the sign-out dialogs.
  unsent() {
    return 0;
  }
}

module.exports = { Outbox };
