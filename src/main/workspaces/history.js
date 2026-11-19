'use strict';

// The open room, its history, threads, reads, drafts and mute (team chat contract 3.7, 3.9 and 3.13). The service
// (index.js) and the sync engine (sync.js) call the hooks below; ipc.js turns METHODS into the chat* IPC methods,
// each as (svc, ...checkedArgs) => result. This file holds the hooks only, each doing nothing, until the history
// package fills them in. index.js, sync.js and ipc.js stay as they are when it does.
//
// What the service gives this module: svc.store (null while signed out), svc.epoch, svc.call(ws, method, route, body),
// svc.emitChat(payload), svc.roomsChanged(ws, ids), svc.sync(ws, why), svc.isOnScreen(ws, room), svc.me(ws),
// svc.setActive({ ws, room } | null) for the room on screen, svc.touch(ws), svc.timing, svc.now(), svc.isStale(err)
// and svc.notifier.

class History {
  // The chat* IPC methods this module answers: chatOpen, chatClose, chatOlder, chatThread, chatRoomMembers, chatRead,
  // chatMarkRead, chatMute and chatSaveDraft.
  static METHODS = {};

  constructor(svc) {
    this.svc = svc;
  }

  // The open room's part of a /changes query outside a pass: { active, roomAfter }, or null when no room of ws is
  // open. roomAfter is the room's hi when it has a cache; leave it out otherwise.
  activeQuery(ws) {
    return null;
  }

  // After an incremental page's transaction, and after the transaction that installs a pass (result.pass), with the
  // page's PageResult (sync.js): push events for the open room (result.appended), catch up when it is behind. Pages of
  // a pass in progress don't come here.
  afterPage(ws, result) {}

  // At the end of a run: flush due reads.
  afterRun(ws) {}

  // After the transaction of a 410 reset_required, which deleted the workspace's cached events.
  onReset(ws) {}

  // After the transaction that deleted an evicted room.
  onEvicted(ws, room) {}

  // After the transaction that deleted the workspace.
  onWorkspaceGone(ws) {}
}

module.exports = { History };
