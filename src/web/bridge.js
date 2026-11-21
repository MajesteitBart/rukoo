'use strict';

// window.mail for Rukoo in the browser: what src/main/preload.js gives the desktop window, with src/web/host.js in the
// place of the main process. website/tools/build-app.mjs bundles this file (src/web/build-options.mjs) into
// web/bridge.js, a classic script the page loads after the i18n catalogs and before web-shell.js.
//
// Everything below runs while the script evaluates: window.mail exists before any module asks for it, the stored
// invitation leaves the address bar before anything renders, and the chat engine's module reads the bridge's own
// address (document.currentScript, only set now) to find sql-wasm.wasm beside it. The account and the engine then
// start behind the one promise every call waits for.
(function (page) {
  // URL.parse came with Chrome 126, Firefox 126 and Safari 18; the chat's Markdown and links call it for every link
  // (chat-markdown.js safeHref, linkify.js), and an older browser would fail to draw such a message. Same answers: a
  // URL, or null where new URL throws.
  if (page.URL && typeof page.URL.parse !== 'function') {
    const Url = page.URL;
    Object.defineProperty(Url, 'parse', {
      value: function parse(url, base) {
        try {
          return new Url(url, base);
        } catch (_) {
          return null;
        }
      },
      configurable: true,
      writable: true
    });
  }
  // Two things the page needs that not every browser in use has: the RegExp v flag (Chrome 112, Firefox 116, Safari 17),
  // which the chat's emoji check (src/main/workspaces/wire.js) compiles as it loads, and String isWellFormed (Chrome
  // 111, Firefox 119, Safari 16.4), which checks every message. Without them team chat can't run at all, so the page
  // says to update the browser (web-shell.js, code browser_old) instead of failing at its first step.
  const current = (() => {
    try {
      return new RegExp('^\\p{RGI_Emoji}$', 'v').test('\u{1F44D}') && typeof ''.isWellFormed === 'function';
    } catch (_) {
      return false;
    }
  })();
  let mail;
  try {
    if (!current) throw Object.assign(new Error('This browser is too old for Rukoo'), { code: 'browser_old' });
    const { createHost } = require('./host');
    mail = createHost(page).mail;
  } catch (err) {
    // Without its catalogs or Web Crypto (a page over plain http) the page can't run: every call says why, and the
    // shell shows that, instead of failing at a missing window.mail.
    const old = Boolean(err && err.code === 'browser_old');
    let message = (err && err.message) || String(err);
    if (old) {
      // In the page's language, which the shell then keeps: no settings come from here.
      try {
        page.RukooI18n.setLanguage(require('./language').pageLanguage(page));
        message = page.RukooI18n.t('chat.web.oldBody');
      } catch (_) {
        // No catalogs: the English line above.
      }
      (page.console || console).warn('[web] Rukoo needs a newer browser');
    } else (page.console || console).error('[web] Rukoo could not start', err);
    const answer = old ? { ok: false, error: message, code: 'browser_old' } : { ok: false, error: message };
    mail = Object.freeze({
      platform: 'web',
      async invoke() {
        return { ...answer };
      },
      async call() {
        throw new Error(message);
      },
      on() {
        return () => {};
      },
      pathForFile() {
        return '';
      }
    });
  }
  Object.defineProperty(page, 'mail', { value: mail, enumerable: true, configurable: false, writable: false });
})(globalThis);
