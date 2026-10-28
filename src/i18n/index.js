// Shared by the sandboxed renderer and Electron's main process. No bundler required.
(function (root) {
  const catalogs = typeof module === 'object' && module.exports
    ? { en: require('./en'), nl: require('./nl') }
    : root.RukooLocales;
  const languages = Object.freeze([
    { code: 'en', name: 'English', locale: 'en-GB', direction: 'ltr' },
    { code: 'nl', name: 'Nederlands', locale: 'nl-NL', direction: 'ltr' }
  ]);
  let language = 'en';
  const normalizeLanguage = (code) => languages.some((item) => item.code === code) ? code : 'en';
  const getLanguage = () => language;
  const getLocale = () => languages.find((item) => item.code === language).locale;
  function setLanguage(code) {
    const next = normalizeLanguage(code);
    const changed = language !== next;
    language = next;
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next;
      document.documentElement.dir = languages.find((item) => item.code === next).direction;
    }
    return changed;
  }
  function message(catalog, key, params, locale) {
    const entry = catalog?.[key];
    const value = entry && Object.hasOwn(entry, 'message') ? entry.message : entry;
    if (value && typeof value === 'object') {
      const category = new Intl.PluralRules(locale).select(Number(params.count));
      return value[category] ?? value.other;
    }
    return value;
  }
  // Text in one language whatever the interface shows, for what other people read in theirs, such as the events and
  // the email footer of a booking page. An unknown language and a missing key fall back to English, as in t().
  function translate(code, key, params = {}) {
    const lang = normalizeLanguage(code);
    const locale = languages.find((item) => item.code === lang).locale;
    const text = message(catalogs[lang], key, params, locale) ?? message(catalogs.en, key, params, locale);
    if (text === undefined) throw new Error(`Unknown translation key: ${key}`);
    // Interpolation is one pass: placeholder-like text in user input stays literal.
    return text.replace(/\{(\w+)\}/g, (placeholder, name) => {
      if (!Object.hasOwn(params, name)) throw new Error(`Missing translation parameter ${name} for ${key}`);
      return String(params[name]);
    });
  }
  const t = (key, params = {}) => translate(language, key, params);
  const api = { languages, normalizeLanguage, getLanguage, getLocale, setLanguage, t, translate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RukooI18n = api;
})(globalThis);
