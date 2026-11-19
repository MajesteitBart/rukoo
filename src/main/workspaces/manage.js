'use strict';

// Workspaces, invitations, channels, direct messages and blocks (team chat contract 2.2, 2.3, 3.2, 3.3, 3.12). The
// service (index.js) and main.js call the hooks below; ipc.js turns METHODS into the chat* IPC methods, each as
// (svc, ...checkedArgs) => result. This file holds the hooks only, each doing nothing, until the workspaces package
// fills them in. index.js, sync.js and ipc.js stay as they are when it does.
//
// What the service gives this module: svc.store, svc.call(ws, method, route, body, { retry }) (ws null for the routes
// under /v1/workspaces itself), svc.list() (GET /v1/workspaces), svc.select(ws), svc.sync(ws, why),
// svc.removeWorkspace(ws, reason), svc.refreshDirectory(ws), svc.server (the credential URL), svc.emitChat(payload),
// svc.roomsChanged(ws, ids), svc.stateChanged() and svc.me(ws).

class Manage {
  // The chat* IPC methods this module answers: every Manage row of contract 4.4.
  static METHODS = {};

  constructor(svc) {
    this.svc = svc;
  }

  // The invite field of the sign-up form, for main.js accountSignUp: an invitation link for this server becomes
  // workspaceInvite: { workspace, invite } and link; anything else stays the invite code. Until the workspaces package
  // reads links, everything is an invite code.
  splitInvite(text) {
    return { invite: typeof text === 'string' ? text : '', workspaceInvite: null, link: null };
  }

  // After a sign-up with a link: keep it in memory as the pending join.
  rememberJoin(link) {}

  // Whether a join waits for the Chat view, for ChatState.pendingJoin.
  pendingJoin() {
    return false;
  }

  // After a session's cache was set up.
  onSignedIn() {}
}

module.exports = { Manage };
