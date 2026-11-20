// The team chat's emoji: groups for the picker, search for its field and for the composer's ':' completion, and
// short codes. The data is generated per locale (data-en.js, data-nl.js, by scripts/emoji-data.js from emojibase-data)
// and loaded the first time a picker or a completion needs it. No DOM, so test/chat-emoji.test.js runs it in Node.
//
// Emoji = { char, label, shortcodes: string[], skins: string[] | null }: char is the fully qualified RGI emoji without
// a skin tone, shortcodes are without colons, and skins holds its five tones from light to dark when it has them.

const FE0F = '️';

// Lowercase without accents, so "cafe" finds "café".
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
// The words of a label, and of a short code: the code itself and its parts between _ and -.
const labelWords = (label) => fold(label).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const codeWords = (code) => [code, ...code.split(/[_-]+/).filter(Boolean)];
// The short code '=' in the data stands for: the label as a CLDR code, grinning_face for "Grinning face"
// (scripts/emoji-data.js writes it with the same rule).
const labelCode = (label) => fold(label).replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');

// A skin tone the usual way: the modifier for tone 1 to 5 right after the first code point, which loses the
// variation selector it may have. The data writes '+' for the emoji that take their tones this way.
function toned(char, tone) {
  const points = [...char];
  if (points[1] === FE0F) points.splice(1, 1);
  points.splice(1, 0, String.fromCodePoint(0x1f3fa + tone));
  return points.join('');
}

// The character for emoji in a skin tone from 1 to 5, or its own when it has no tones or tone is 0 (none chosen).
export function withSkin(emoji, tone) {
  if (!emoji) return '';
  const n = Number(tone);
  return emoji.skins && Number.isInteger(n) && n >= 1 && n <= 5 ? emoji.skins[n - 1] : emoji.char;
}

// The loaded data of one locale as { groups, search, byShortcode, byChar }.
function build({ groups: heads, emoji: text }) {
  const sections = text.split('\n\n');
  const all = [];
  const groups = heads.map(([id, label], g) => {
    const emoji = [];
    for (const line of (sections[g] || '').split('\n')) {
      if (!line) continue;
      const [char, label, codes = '', words = '', tones = ''] = line.split('\t');
      const shortcodes = codes ? codes.split(' ').map((c) => (c === '=' ? labelCode(label) : c)) : [];
      const skins = tones === '+' ? [1, 2, 3, 4, 5].map((t) => toned(char, t)) : tones ? tones.split(' ') : null;
      const e = Object.freeze({ char, label, shortcodes: Object.freeze(shortcodes), skins: skins && Object.freeze(skins) });
      emoji.push(e);
      all.push({
        e,
        // The label as its words, so 'flag n' finds "Flag: Netherlands".
        label: labelWords(label).join(' '),
        // The words a query's words are looked up in: the label's and the short codes', then the other search words.
        words: [...labelWords(label), ...shortcodes.flatMap(codeWords)],
        tags: words ? words.split(' ') : [],
      });
    }
    return Object.freeze({ id, label, emoji: Object.freeze(emoji) });
  });

  // A short code two emoji share, such as cat (GitHub's cat face and CLDR's cat), belongs to the one that lists it
  // first: the locale's own codes come first in the data. A tie goes to picker order.
  const codes = new Map();
  const chars = new Map();
  for (const { e } of all) {
    e.shortcodes.forEach((code, at) => {
      if (!codes.has(code) || codes.get(code).at > at) codes.set(code, { e, at });
    });
    for (const c of [e.char, ...(e.skins || [])]) {
      if (!chars.has(c)) chars.set(c, e);
      // The same emoji written without its variation selectors, as text from elsewhere may have it.
      const bare = c.replaceAll(FE0F, '');
      if (!chars.has(bare)) chars.set(bare, e);
    }
  }

  // The emoji for a query, best first: those with a short code that is the query (the one byShortcode gives first),
  // then labels that start with it, then those with a word starting with each of its words (in the label or a short
  // code), then the same with the other search words too. Within each, picker order. A query may be ':thumbs',
  // 'thumbs up' or 'thumbs_up'. limit: how many at most, all when left out.
  function search(query, limit = Infinity) {
    const q = fold(String(query ?? '')).trim().replace(/^:+/, '').replace(/:+$/, '').trim();
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
    if (!q || !max) return [];
    // A query such as +1 or -1 is a short code only: its digits don't start a label.
    const asLabel = /^[\p{L}\p{N}]/u.test(q) ? labelWords(q).join(' ') : '';
    const words = q.split(/[^\p{L}\p{N}+]+/u).filter(Boolean);
    const ranks = [[], [], [], []];
    for (const item of all) {
      if (item.e.shortcodes.includes(q)) ranks[0].push(item.e);
      else if (asLabel && item.label.startsWith(asLabel)) ranks[1].push(item.e);
      else if (!words.length) continue;
      else if (words.every((w) => item.words.some((x) => x.startsWith(w)))) ranks[2].push(item.e);
      else if (words.every((w) => item.words.some((x) => x.startsWith(w)) || item.tags.some((x) => x.startsWith(w)))) ranks[3].push(item.e);
    }
    const first = codes.get(q)?.e;
    if (first) ranks[0] = [first, ...ranks[0].filter((e) => e !== first)];
    return ranks.flat().slice(0, max);
  }

  // The emoji with this short code, with or without its colons, or null.
  function byShortcode(code) {
    const c = String(code ?? '').trim().toLowerCase().replace(/^:/, '').replace(/:$/, '');
    return codes.get(c)?.e || null;
  }

  // The emoji a character is, in any of its skin tones, or null: for a reaction or a recent emoji.
  function byChar(char) {
    const c = String(char ?? '');
    return chars.get(c) || chars.get(c.replaceAll(FE0F, '')) || null;
  }

  // The groups and emoji are shared by every picker, so they can't be changed; the object itself stays open for a
  // caller's own cache.
  return { groups: Object.freeze(groups), search, byShortcode, byChar };
}

// The data per language, loaded once: 'nl' for Dutch and English for every other locale.
const loaded = new Map();
const languageOf = (locale) => (String(locale ?? '').toLowerCase().split(/[-_]/)[0] === 'nl' ? 'nl' : 'en');
const importData = (lang) => (lang === 'nl' ? import('./data-nl.js') : import('./data-en.js'));

// The emoji in a locale's language: { groups: [{ id, label, emoji: Emoji[] }], search(query, limit), byShortcode(code),
// byChar(char) }. English when the locale has no data of its own or its data doesn't load. A load that fails
// altogether is tried again on the next call.
export function loadEmoji(locale) {
  const lang = languageOf(locale);
  if (!loaded.has(lang)) {
    const loading = importData(lang)
      .catch((err) => (lang === 'en' ? Promise.reject(err) : importData('en')))
      .then(build);
    loading.catch(() => loaded.delete(lang));
    loaded.set(lang, loading);
  }
  return loaded.get(lang);
}
