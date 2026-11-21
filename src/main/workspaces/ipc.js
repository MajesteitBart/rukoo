'use strict';

// The chat* IPC methods (team chat contract 4.4) as one table that main.js spreads into its api. The core answers
// chatState, chatSelect, chatView, chatSync and chatReload; History.METHODS, Outbox.METHODS, Manage.METHODS and
// Files.METHODS add the rest. Each entry of those is (svc, ...args) => result. Here every one is wrapped the same way:
// - its arguments go through wire.checkArgs (wire.input.*) before anything else, and a refused one throws
//   ChatError('invalid', { field }) before any request;
// - every method but chatState throws ChatError('signed_out') while the service is missing or has no cache;
// - what it throws reaches the window as a ChatError with a code of contract 3.15. The codes the engines handle
//   themselves (stale_grant and the like) never do: they read as server, and an answer for a session that ended
//   meanwhile reads as signed_out.
const { ChatError, chatError, isInternal, checkArgs } = require('./wire');
const { blankState } = require('./index');
const { History } = require('./history');
const { Outbox } = require('./outbox');
const { Manage } = require('./manage');
const { Files } = require('./files');

const CORE = {
  chatState: (svc) => svc.state({ take: true }),
  chatSelect: (svc, ws) => svc.select(ws),
  chatView: (svc, ws) => svc.view(ws),
  chatSync: (svc, ws) => svc.syncNow(ws),
  chatReload: (svc, ws) => svc.reload(ws),
  // The network may be back (the window went online, the setup page opened): a signed-out GET /v1/info that failed
  // goes again (index.js retryInfo).
  chatRetryInfo: (svc) => (svc.retryInfo(), true)
};

// Methods that work without a cache.
const SIGNED_OUT = new Set(['chatCheckLink', 'chatRetryInfo']);

function callError(err) {
  if (err && err.stale === true) return new ChatError('signed_out');
  const e = chatError(err);
  return isInternal(e.code) ? new ChatError('server', { cause: err }) : e;
}

// get: () => the WorkspaceService, or null before main.js made it.
function chatApi(get) {
  const table = { ...History.METHODS, ...Outbox.METHODS, ...Manage.METHODS, ...Files.METHODS, ...CORE };
  const api = {};
  for (const [name, fn] of Object.entries(table)) {
    if (typeof fn !== 'function') continue;
    api[name] = async (...args) => {
      const checked = checkArgs(name, args);
      const svc = get();
      if (name === 'chatState') return svc ? svc.state({ take: true }) : blankState();
      // Reading a link needs no session: the setup page checks one before there is an account.
      if (!svc || (!svc.store && !SIGNED_OUT.has(name))) throw new ChatError('signed_out');
      try {
        return await fn(svc, ...checked);
      } catch (err) {
        throw callError(err);
      }
    };
  }
  return api;
}

module.exports = { chatApi, CORE };
