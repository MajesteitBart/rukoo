'use strict';

// src/i18n/index.js for the browser build. The page loads src/i18n/en.js, nl.js and index.js as classic scripts before
// web/bridge.js, which set globalThis.RukooI18n. Bundling index.js would load both catalogs a second time and give the
// engine a language of its own; this hands it the page's, so a language change reaches alert text at once.
const api = globalThis.RukooI18n;
if (!api || typeof api.t !== 'function') {
  throw new Error('RukooI18n is missing: load i18n/en.js, nl.js and index.js before web/bridge.js');
}

module.exports = api;
