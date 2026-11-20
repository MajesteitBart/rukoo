'use strict';

// The team chat's emoji (src/renderer/emoji/): the generated data against emojibase-data, search ranking, short codes
// in English and Dutch, skin tones, loading by locale with its fallback, and the recent list and skin tone over a
// localStorage that works and one that refuses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '../src/renderer/emoji');
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

// index.js as a data: URL whose imports of the data are data: URLs too (a browser module in a CommonJS package), with
// the data module of a language replaced when a test needs that. The comment makes each one a module of its own.
let loads = 0;
function indexUrl(replace = {}) {
  const source = read('index.js').replace(/'\.\/(data-(\w+)\.js)'/g, (_, file, lang) => `'${replace[lang] || dataUrl(read(file))}'`);
  return dataUrl(`${source}\n// ${++loads}\n`);
}
const loading = import(indexUrl());
const recentModule = () => import(dataUrl(`${read('recent.js')}\n// ${++loads}\n`));

const RGI = /^\p{RGI_Emoji}$/v;
const chars = (list) => list.map((e) => e.char).join(' ');

test('the data is what scripts/emoji-data.js makes from the installed emojibase-data', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-emoji-'));
  try {
    execFileSync(process.execPath, [path.join(__dirname, '../scripts/emoji-data.js'), out], { stdio: 'pipe' });
    for (const file of ['data-en.js', 'data-nl.js', 'LICENSE']) {
      assert.ok(fs.readFileSync(path.join(out, file)).equals(fs.readFileSync(path.join(DIR, file))), `${file} is up to date`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  assert.match(read('LICENSE'), /MIT License/);
  assert.match(read('data-en.js'), /emojibase-data \d+\.\d+\.\d+ \(MIT, see\n\/\/ LICENSE in this folder\)/);
});

test('every emoji is fully qualified RGI, in both languages in the same order, with emojibase-data up to Emoji 16', async () => {
  const { loadEmoji } = await loading;
  const en = await loadEmoji('en');
  const nl = await loadEmoji('nl');
  const all = (set) => set.groups.flatMap((g) => g.emoji);
  assert.deepEqual(chars(all(nl)), chars(all(en)));
  assert.deepEqual(
    en.groups.map((g) => g.id),
    ['smileys-emotion', 'people-body', 'animals-nature', 'food-drink', 'travel-places', 'activities', 'objects', 'symbols', 'flags'],
  );
  assert.deepEqual(en.groups.slice(0, 2).map((g) => g.label), ['Smileys & emotion', 'People & body']);
  assert.deepEqual(nl.groups.slice(0, 2).map((g) => g.label), ['Smileys & emotie', 'Mensen & lichaam']);
  for (const e of all(en)) {
    assert.ok(RGI.test(e.char), `${e.char} ${e.label}`);
    for (const s of e.skins || []) assert.ok(RGI.test(s), `${s} ${e.label}`);
  }
  // The same emoji as emojibase-data: every group but its components, nothing newer than Emoji 16, and no
  // regional indicators or skin tone modifiers on their own.
  const source = require('emojibase-data/en/data.json').filter((e) => e.group !== undefined && e.group !== 2 && e.version <= 16);
  assert.equal(all(en).length, source.length);
  assert.deepEqual(new Set(all(en).map((e) => e.char)), new Set(source.map((e) => e.emoji)));
  assert.ok(en.byChar('🫩'), 'Emoji 16 is in');
  assert.equal(en.byChar('🫪'), null, 'Emoji 17 waits until the server and Windows know it');
  assert.equal(en.byChar('🏽'), null);
  assert.equal(en.byChar('🇦'), null);
});

test('search: an exact short code first, then labels that start with the query, then word starts, then tags', async () => {
  const { loadEmoji } = await loading;
  const en = await loadEmoji('en');
  assert.equal(en.search('+1')[0].char, '👍');
  assert.equal(en.search('-1')[0].char, '👎');
  assert.equal(en.search(':tada:')[0].char, '🎉');
  assert.deepEqual(chars(en.search('thumbs')), '👍 👎');
  assert.deepEqual(chars(en.search('thumbs up')), '👍');
  assert.deepEqual(chars(en.search('thumbs_up')), '👍');

  const grinning = en.search('grinning');
  // :grinning: itself; then the labels "Grinning …"; then "Grinning cat" (a word of its label) before "Beaming face
  // with smiling eyes" (only a tag).
  assert.equal(grinning[0].char, '😀');
  assert.deepEqual(chars(grinning.slice(1, 5)), '😃 😄 😆 😅');
  assert.ok(grinning.findIndex((e) => e.char === '😺') < grinning.findIndex((e) => e.char === '😁'));

  const smile = en.search('smile');
  assert.equal(smile[0].char, '😄', ':smile:');
  // smile_cat and sweat_smile are short codes with the word; the grinning face only has it as a tag.
  assert.ok(smile.findIndex((e) => e.char === '😸') < smile.findIndex((e) => e.char === '😀'));
  assert.ok(smile.findIndex((e) => e.char === '😅') < smile.findIndex((e) => e.char === '😀'));

  // A shared short code goes to the emoji that lists it first: GitHub's cat is the cat face.
  assert.deepEqual(chars(en.search('cat').slice(0, 2)), '🐱 🐈');
  // Labels read without their punctuation: 'flag n' starts with the flags of places starting with N, and only then
  // come labels with a word for each, such as "Open mailbox with lowered flag" (mailbox_with_no_mail).
  const flags = en.search('flag n');
  const prefix = flags.filter((e) => /^Flag: N/.test(e.label)).length;
  assert.ok(prefix > 10, chars(flags));
  assert.ok(flags.slice(0, prefix).every((e) => /^Flag: N/.test(e.label)), chars(flags));
  assert.ok(flags.slice(prefix).some((e) => e.char === '📭'), chars(flags));
});

test('search folds case and accents, takes a limit, and finds nothing for nothing', async () => {
  const { loadEmoji } = await loading;
  const en = await loadEmoji('en');
  const nl = await loadEmoji('nl');
  assert.equal(en.search('PINATA')[0].char, '🪅');
  assert.equal(en.search('curacao')[0].char, '🇨🇼');
  assert.equal(nl.search('pinguin')[0].char, '🐧');
  assert.equal(en.search('a', 5).length, 5);
  assert.deepEqual(en.search('heart', 0), []);
  for (const q of ['', '   ', ':', '::', undefined, null, 'zzzzzzzz']) assert.deepEqual(en.search(q), [], String(q));
  assert.ok(en.search('a').length > 100, 'no limit gives every match');
});

test('short codes: GitHub and CLDR in English, CLDR Dutch and GitHub in Dutch', async () => {
  const { loadEmoji } = await loading;
  const en = await loadEmoji('en');
  const nl = await loadEmoji('nl');
  assert.deepEqual(en.byShortcode('+1').shortcodes, ['+1', 'thumbsup', 'thumbs_up']);
  assert.deepEqual(nl.byShortcode('+1').shortcodes, ['duim_omhoog', '+1', 'thumbsup']);
  for (const [code, char] of [
    ['thumbsup', '👍'],
    [':thumbs_up:', '👍'],
    ['grinning_face', '😀'],
    ['heart', '❤️'],
    ['t-rex', '🦖'],
    ['trex', '🦖'],
    ['twelve_oclock', '🕛'],
    ['clock12', '🕛'],
    ['flag_netherlands', '🇳🇱'],
    ['netherlands', '🇳🇱'],
    ['cat', '🐱'],
    ['cat2', '🐈'],
    ['TADA', '🎉'],
  ]) {
    assert.equal(en.byShortcode(code)?.char, char, code);
  }
  for (const [code, char] of [
    ['duim_omhoog', '👍'],
    ['thumbsup', '👍'],
    ['vlag_nederland', '🇳🇱'],
    ['grijnzend_gezicht', '😀'],
    // golf is a wave in Dutch, and GitHub's golf flag second.
    ['golf', '🌊'],
  ]) {
    assert.equal(nl.byShortcode(code)?.char, char, code);
  }
  assert.equal(nl.byShortcode('grinning_face'), null, 'English CLDR codes are only in English');
  assert.equal(en.byShortcode('no_such_code'), null);
  assert.equal(en.byShortcode(undefined), null);
  // Codes are lowercase without spaces or colons, so a completion can show them between colons.
  for (const set of [en, nl]) for (const g of set.groups) for (const e of g.emoji) for (const c of e.shortcodes) assert.match(c, /^[a-z0-9_+-]+$/, `${e.char} ${c}`);
});

test('skin tones: five, light to dark, for the emoji that have them', async () => {
  const { loadEmoji, withSkin } = await loading;
  const en = await loadEmoji('en');
  const thumbs = en.byShortcode('+1');
  assert.deepEqual(thumbs.skins, ['👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿']);
  // The usual modifier replaces the variation selector after the first code point.
  assert.deepEqual(en.byShortcode('point_up').skins, ['☝🏻', '☝🏼', '☝🏽', '☝🏾', '☝🏿']);
  assert.deepEqual(en.byShortcode('woman_technologist').skins, ['👩🏻‍💻', '👩🏼‍💻', '👩🏽‍💻', '👩🏾‍💻', '👩🏿‍💻']);
  // Two people take the tone twice; the handshake offers only tones for the whole emoji.
  assert.deepEqual(en.byShortcode('people_holding_hands').skins, ['🧑🏻‍🤝‍🧑🏻', '🧑🏼‍🤝‍🧑🏼', '🧑🏽‍🤝‍🧑🏽', '🧑🏾‍🤝‍🧑🏾', '🧑🏿‍🤝‍🧑🏿']);
  assert.deepEqual(en.byShortcode('handshake').skins, ['🤝🏻', '🤝🏼', '🤝🏽', '🤝🏾', '🤝🏿']);
  assert.equal(en.byShortcode('grinning').skins, null);
  const modifiers = ['🏻', '🏼', '🏽', '🏾', '🏿'];
  for (const g of en.groups) {
    for (const e of g.emoji) {
      if (!e.skins) continue;
      assert.equal(e.skins.length, 5, e.label);
      e.skins.forEach((s, i) => assert.ok(s.includes(modifiers[i]) && modifiers.every((m, j) => j === i || !s.includes(m)), `${e.label} tone ${i + 1}`));
    }
  }
  assert.equal(withSkin(thumbs, 3), '👍🏽');
  assert.equal(withSkin(thumbs, 0), '👍');
  assert.equal(withSkin(thumbs, 6), '👍');
  assert.equal(withSkin(en.byShortcode('grinning'), 2), '😀');
  assert.equal(withSkin(null, 2), '');
  // A character in any tone, or without its variation selector, is its emoji.
  assert.equal(en.byChar('👍🏾'), thumbs);
  assert.equal(en.byChar('❤').char, '❤️');
  assert.equal(en.byChar('x'), null);
});

test('loadEmoji: Dutch for nl locales, English for every other one and when the Dutch data does not load', async () => {
  const { loadEmoji } = await loading;
  assert.equal((await loadEmoji('nl-NL')).byShortcode('+1').label, 'Duim omhoog');
  assert.equal((await loadEmoji('nl_BE')).byShortcode('+1').label, 'Duim omhoog');
  for (const locale of ['en', 'en-GB', 'de', '', undefined]) assert.equal((await loadEmoji(locale)).byShortcode('+1').label, 'Thumbs up', String(locale));
  assert.equal(loadEmoji('nl'), loadEmoji('nl-NL'), 'loaded once per language');
  assert.equal(await loadEmoji('fr'), await loadEmoji('en'));

  const broken = dataUrl("throw new Error('no data');");
  const fallback = await import(indexUrl({ nl: broken }));
  assert.equal((await fallback.loadEmoji('nl')).byShortcode('+1').label, 'Thumbs up');

  const none = await import(indexUrl({ nl: broken, en: broken }));
  const first = none.loadEmoji('en');
  await assert.rejects(first, /no data/);
  const again = none.loadEmoji('en');
  assert.notEqual(again, first, 'a failed load is tried again');
  await assert.rejects(again, /no data/);
});

// A localStorage in memory, and one whose every access throws as a blocked one does.
class MemoryStorage {
  constructor() {
    this.items = new Map();
  }
  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }
  setItem(key, value) {
    this.items.set(key, String(value));
  }
  removeItem(key) {
    this.items.delete(key);
  }
}
function withStorage(storage) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      if (storage === 'throws') throw new Error('SecurityError');
      return storage;
    },
  });
  return () => {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else delete globalThis.localStorage;
  };
}

test('recent emoji: the last used first, no repeats, at most 24, kept in localStorage', async (t) => {
  const storage = new MemoryStorage();
  t.after(withStorage(storage));
  const recent = await recentModule();
  assert.deepEqual(recent.recentEmoji(), []);
  recent.useEmoji('👍');
  recent.useEmoji('🎉');
  assert.deepEqual(recent.useEmoji('👍'), ['👍', '🎉']);
  assert.deepEqual(JSON.parse(storage.getItem('rukoo.chat.emoji.recent')), ['👍', '🎉']);
  for (let n = 0; n < 30; n++) recent.useEmoji(String.fromCodePoint(0x1f600 + n));
  const list = recent.recentEmoji();
  assert.equal(list.length, recent.RECENT_LIMIT);
  assert.equal(list.length, 24);
  assert.equal(list[0], String.fromCodePoint(0x1f600 + 29));
  // Nothing that isn't one emoji character goes in.
  for (const bad of ['', ' ', 'two words', 42, null, 'x'.repeat(65)]) recent.useEmoji(bad);
  assert.deepEqual(recent.recentEmoji(), list);
  // What another version or a hand left in storage is read with care.
  storage.setItem('rukoo.chat.emoji.recent', JSON.stringify(['😀', 7, '😀', '', '🎉']));
  assert.deepEqual(recent.recentEmoji(), ['😀', '🎉']);
  for (const junk of ['{"a":1}', 'not json', '"😀"']) {
    storage.setItem('rukoo.chat.emoji.recent', junk);
    assert.deepEqual(recent.recentEmoji(), [], junk);
  }
});

test('skin tone: none until chosen, 1 to 5, kept in localStorage', async (t) => {
  const storage = new MemoryStorage();
  t.after(withStorage(storage));
  const recent = await recentModule();
  assert.equal(recent.skinTone(), 0);
  assert.equal(recent.setSkinTone(3), 3);
  assert.equal(recent.skinTone(), 3);
  assert.equal(storage.getItem('rukoo.chat.emoji.skin'), '3');
  for (const bad of [0, 6, -1, 2.5, '4', null]) {
    assert.equal(recent.setSkinTone(bad), 0, String(bad));
    assert.equal(recent.skinTone(), 0);
  }
  assert.equal(storage.getItem('rukoo.chat.emoji.skin'), null);
  storage.setItem('rukoo.chat.emoji.skin', 'dark');
  assert.equal(recent.skinTone(), 0);
});

test('a localStorage that throws: recent emoji and the skin tone last as long as the window', async (t) => {
  t.after(withStorage('throws'));
  const recent = await recentModule();
  assert.deepEqual(recent.recentEmoji(), []);
  assert.equal(recent.skinTone(), 0);
  assert.deepEqual(recent.useEmoji('👍'), ['👍']);
  assert.deepEqual(recent.useEmoji('🎉'), ['🎉', '👍']);
  assert.deepEqual(recent.recentEmoji(), ['🎉', '👍']);
  assert.equal(recent.setSkinTone(4), 4);
  assert.equal(recent.skinTone(), 4);
});

test('a localStorage whose methods throw, as a full one does', async (t) => {
  const storage = new MemoryStorage();
  storage.setItem('rukoo.chat.emoji.recent', JSON.stringify(['😀']));
  storage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  t.after(withStorage(storage));
  const recent = await recentModule();
  assert.deepEqual(recent.recentEmoji(), ['😀']);
  assert.deepEqual(recent.useEmoji('👍'), ['👍', '😀']);
  assert.deepEqual(recent.recentEmoji(), ['👍', '😀']);
  assert.equal(recent.setSkinTone(2), 2);
  assert.equal(recent.skinTone(), 2);
});
