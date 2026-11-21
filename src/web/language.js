'use strict';

// The page's language before anything else runs: the one the person chose (the settings src/web/host.js keeps), else
// the first of the browser's languages Rukoo has. Without other modules, so web/bridge.js can word its own message
// when the browser is too old to start the rest (bridge.js).

const SETTINGS_KEY = 'rukoo.web.settings';

// The first of the browser's languages Rukoo has, nl or en, else English (desktop asks on first run instead).
function firstLanguage(navigator) {
  const list = navigator && Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator && navigator.language];
  for (const tag of list) {
    const code = String(tag || '').toLowerCase();
    if (code.startsWith('nl')) return 'nl';
    if (code.startsWith('en')) return 'en';
  }
  return 'en';
}

// The stored choice, where storage can be read and holds one, else firstLanguage.
function pageLanguage(page) {
  try {
    const saved = JSON.parse(page.localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved && typeof saved.language === 'string' && saved.language) return saved.language;
  } catch (_) {
    // Blocked or unreadable storage: the browser's languages decide.
  }
  return firstLanguage(page.navigator);
}

module.exports = { SETTINGS_KEY, firstLanguage, pageLanguage };
