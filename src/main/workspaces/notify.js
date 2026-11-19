'use strict';

// Alerts for direct messages and mentions, and taking them back (team chat contract 3.10). The service (index.js) and
// the sync engine (sync.js) call the hooks below. This file holds the hooks only, each doing nothing, until the alerts
// package fills them in. index.js, sync.js and ipc.js stay as they are when it does.
//
// What the service gives this module: svc.store, svc.call(ws, method, route, body), svc.settings()
// (chatNotifications), svc.isOnScreen(ws, room), svc.me(ws), svc.show({ id, title, body, open }) and svc.hide(id),
// which main.js turns into desktop notifications, svc.timing (notifyRooms), svc.now() and svc.isStale(err).

class Notifier {
  // Notifications have no IPC methods of their own; this stays empty.
  static METHODS = {};

  constructor(svc) {
    this.svc = svc;
  }

  // At the end of a run. changedIds: the rooms the run's pages changed. pass: whether a pass installed in the run.
  afterRun(ws, changedIds, { pass } = {}) {}

  // After this device read a room to a new position.
  onRead(ws, room) {}

  // After messages of a room were removed: removed IDs, removedMore and floors.
  onRemoved(ws, room, ids) {}

  // After an evicted room was deleted.
  onEvicted(ws, room) {}

  // After the workspace was deleted.
  onWorkspaceGone(ws) {}

  // At a wipe: the session ended, so every alert goes.
  clear() {}
}

module.exports = { Notifier };
