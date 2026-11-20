'use strict';

// The team chat invitation a page was opened with. A link https://<server>/join#w=<w_id>&i=<secret> reaches the app
// as /app/#w=…&i=…: the site Worker answers /join with a 302 to /app/ when the account server says the page is an
// invitation (website/cloudflare/web-app.js), and the browser keeps the fragment (RFC 9110 §10.2.2). The fragment
// never reaches a server.
//
// createJoin() reads it once, before anything renders: with the rules of parseInviteLink (src/main/workspaces/wire.js)
// it is taken as the link <server>/join#…, kept in sessionStorage under rukoo.web.join as the link's text, and taken
// out of the address bar with history.replaceState, so the secret isn't left in the history, a bookmark or a shared
// screen. sessionStorage keeps it through a reload and a sign-in in this tab, and keeps it out of other tabs.
//
// The bridge (src/web/bridge.js, host.js) gives it to the chat engine as a pending join after a sign-up, sign-in or
// recovery, as main.js does after a sign-up with a link in the invite field (manage.rememberJoin), and clears it after
// the join or a sign-out.
const { parseInviteLink, inviteLink } = require('../main/workspaces/wire');

const STORAGE_KEY = 'rukoo.web.join';

// A fragment that names an invitation's parts, also one that is broken: it leaves the address bar too, since it may
// hold most of a secret.
const LOOKS_LIKE_INVITE = /(^|&)(w|i)=/;

// sessionStorage that may be missing or throw (blocked site data): what it refuses is kept for the open page.
function tabStore(storage) {
  let memory = null;
  let inMemory = false;
  return {
    get() {
      if (inMemory) return memory;
      try {
        return storage ? storage.getItem(STORAGE_KEY) : null;
      } catch (_) {
        return null;
      }
    },
    set(value) {
      try {
        if (!storage) throw new Error('no storage');
        storage.setItem(STORAGE_KEY, value);
        inMemory = false;
        memory = null;
      } catch (_) {
        inMemory = true;
        memory = value;
      }
    },
    remove() {
      inMemory = false;
      memory = null;
      try {
        if (storage) storage.removeItem(STORAGE_KEY);
      } catch (_) {
        // Storage that throws here threw at set() too, so the link was only in memory.
      }
    }
  };
}

// { link, server, workspace, secret } for a fragment (with or without its #) that holds an invitation to server, or
// null. server: the address the page was opened at, without a trailing slash.
function parseHash(hash, server) {
  const fragment = String(hash || '').replace(/^#/, '');
  if (!fragment || !server) return null;
  try {
    const found = parseInviteLink(`${server}/join#${fragment}`, server);
    return { link: inviteLink(found.server, found.workspace, found.secret), server: found.server, workspace: found.workspace, secret: found.secret };
  } catch (_) {
    return null;
  }
}

// location, history and storage (sessionStorage) are the page's; server defaults to location.origin.
function createJoin({ location, history, storage, server } = {}) {
  const at = String(server || (location && location.origin) || '').replace(/\/+$/, '');
  const store = tabStore(storage);
  const hash = location ? String(location.hash || '') : '';
  const found = parseHash(hash, at);
  if (found) store.set(found.link);
  if (found || LOOKS_LIKE_INVITE.test(hash.replace(/^#/, ''))) {
    try {
      history.replaceState(history.state, '', `${location.pathname || '/'}${location.search || ''}`);
    } catch (_) {
      // A page without history (or one that refuses it) keeps the address; the link is stored all the same.
    }
  }

  // The stored invitation, or null. Text that no longer reads as one (edited by hand) goes.
  function peek() {
    const text = store.get();
    if (!text) return null;
    try {
      const parsed = parseInviteLink(text);
      return { link: inviteLink(parsed.server, parsed.workspace, parsed.secret), server: parsed.server, workspace: parsed.workspace, secret: parsed.secret };
    } catch (_) {
      store.remove();
      return null;
    }
  }

  return {
    // What the address held when the page opened, or null.
    found,
    peek,
    // The stored invitation once: it is cleared as it is read.
    take() {
      const link = peek();
      store.remove();
      return link;
    },
    clear() {
      store.remove();
    }
  };
}

module.exports = { createJoin, parseHash, STORAGE_KEY };
