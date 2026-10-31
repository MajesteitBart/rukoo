// Catalog lookup for the pill and Settings. en.json is the English source with descriptions; nl.json holds the
// Dutch strings under the same keys, in the shape Rukoo's catalogs use (src/i18n).

export const LANGUAGES = ['en', 'nl'];

const catalogs = { en: {}, nl: {} };
let current = 'en';

// Both catalogs load before the first render, so a language switch never waits on the network or the disk.
export async function loadCatalogs() {
  await Promise.all(
    LANGUAGES.map(async (code) => {
      const response = await fetch(new URL(`../i18n/${code}.json`, import.meta.url));
      if (!response.ok) throw new Error(`Catalog ${code}: HTTP ${response.status}`);
      catalogs[code] = await response.json();
    })
  );
}

export function setLanguage(code) {
  current = LANGUAGES.includes(code) ? code : 'en';
  document.documentElement.lang = current;
}

export const language = () => current;

function message(key) {
  const local = current === 'en' ? catalogs.en[key]?.message : catalogs[current][key];
  const value = local ?? catalogs.en[key]?.message;
  if (value === undefined) throw new Error(`Unknown string ${key}`);
  return value;
}

function fill(text, params, key, wrap = (value) => value) {
  return text.replace(/\{(\w+)\}/g, (_, name) => {
    if (!params || !(name in params)) throw new Error(`Missing {${name}} for ${key}`);
    return wrap(params[name], name);
  });
}

function form(value, params, key) {
  if (typeof value === 'string') return value;
  if (typeof params?.count !== 'number') throw new Error(`Plural ${key} needs a numeric count`);
  return value[new Intl.PluralRules(current).select(params.count)] ?? value.other;
}

const formatParam = (value) => (typeof value === 'number' ? value.toLocaleString(current) : String(value));

// Plain text, for textContent and attributes.
export function t(key, params) {
  return fill(form(message(key), params, key), params, key, formatParam);
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Markup with the message escaped and the params inserted as given, for params that are markup themselves, such as
// key names drawn as <kbd>. Callers escape what they pass.
export function tHtml(key, params) {
  return fill(esc(form(message(key), params, key)), params, key, (value) => (typeof value === 'number' ? value.toLocaleString(current) : value));
}

// Sets every [data-i18n*] label under root: data-i18n for the text, data-i18n-title, -aria-label and -placeholder
// for those attributes.
export function localize(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const attr of ['title', 'aria-label', 'placeholder']) {
    const data = `i18n${attr.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`;
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.dataset[data]));
  }
}

export function list(items) {
  return new Intl.ListFormat(current, { type: 'conjunction' }).format(items);
}

export function bytes(value) {
  if (!Number.isFinite(value)) return '';
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  let i = 0;
  let n = value;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i += 1;
  }
  const digits = i >= 3 && n < 10 ? 1 : 0;
  return new Intl.NumberFormat(current, { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: digits }).format(n);
}

export function dateTime(ms) {
  return new Intl.DateTimeFormat(current, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}

export function languageName(code) {
  try {
    const name = new Intl.DisplayNames([current], { type: 'language' }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(current) + name.slice(1) : code;
  } catch {
    return code;
  }
}
