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
  let mail;
  try {
    const { createHost } = require('./host');
    mail = createHost(page).mail;
  } catch (err) {
    // Without its catalogs or Web Crypto (a page over plain http) the page can't run: every call says why, and the
    // shell shows that, instead of failing at a missing window.mail.
    const message = (err && err.message) || String(err);
    (page.console || console).error('[web] Rukoo could not start', err);
    mail = Object.freeze({
      platform: 'web',
      async invoke() {
        return { ok: false, error: message };
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
