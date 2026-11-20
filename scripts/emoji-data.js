// Generates the team chat's emoji data, src/renderer/emoji/data-en.js and data-nl.js, from the emojibase-data
// package (a devDependency, MIT), and copies its license next to them. Run it after updating emojibase-data:
//   node scripts/emoji-data.js [folder]
// The same package version always gives the same files; test/chat-emoji.test.js writes them to a folder of its own
// and compares. src/renderer/emoji/index.js reads them.
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '../src/renderer/emoji');
const SOURCE = path.dirname(require.resolve('emojibase-data/package.json'));
const { version } = require('emojibase-data/package.json');
const read = (file) => JSON.parse(fs.readFileSync(path.join(SOURCE, file), 'utf8'));

// The newest Emoji version the picker offers. The server takes a reaction only when it matches /^\p{RGI_Emoji}$/v
// in its JavaScript engine, and Windows' emoji font has to draw it, so newer emoji wait until both know them.
const NEWEST = 16;
// Emoji per locale: its labels and search words, and its short codes in the order a completion shows them. GitHub's
// codes, such as :+1: and :tada:, are English but the ones people know, so the Dutch data has them too.
const LOCALES = {
  en: { shortcodes: ['en/shortcodes/github.json', 'en/shortcodes/cldr.json'] },
  nl: { shortcodes: ['nl/shortcodes/cldr.json', 'en/shortcodes/github.json'] },
};
// The groups the picker shows, by emojibase's group number: every group except components (2), the skin tones
// and hair styles that only exist as parts of other emoji.
const COMPONENT = 2;

const RGI = /^\p{RGI_Emoji}$/v;
const FE0F = '\uFE0F';
const modifier = (tone) => String.fromCodePoint(0x1f3fa + tone);

// The usual way a skin tone goes into an emoji: the modifier right after the first code point, which loses the
// variation selector it may have. All but a handful of the emoji with tones follow it; the others list theirs.
function toned(char, tone) {
  const points = [...char];
  if (points[1] === FE0F) points.splice(1, 1);
  points.splice(1, 0, modifier(tone));
  return points.join('');
}

// The five tones of an emoji, light to dark, or null when it has none the picker can offer: each one a single tone
// for the whole emoji (not the mixed ones of two people), no newer than NEWEST.
function skinsOf(entry) {
  const tones = (entry.skins || []).filter((s) => typeof s.tone === 'number' && s.version <= NEWEST);
  if (tones.length !== 5) return null;
  tones.sort((a, b) => a.tone - b.tone);
  if (tones.some((s, i) => s.tone !== i + 1)) return null;
  return tones.map((s) => s.emoji);
}

// Lowercase words without accents, the way index.js splits a label (words) and a short code (codeWords) into them.
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const codeWords = (code) => [fold(code), ...fold(code).split(/[_-]+/).filter(Boolean)];
// The CLDR short code a label usually has, such as grinning_face for "Grinning face". The data writes = for a code
// that is this one, which saves a fifth of its size; index.js's labelCode() reads it back.
const labelCode = (label) => fold(label).replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');

const upperFirst = (s, locale) => {
  const first = String.fromCodePoint(s.codePointAt(0));
  return first.toLocaleUpperCase(locale) + s.slice(first.length);
};

// A field may not hold what would end it or the template literal it sits in.
function field(s, what) {
  if (/[\t\n\r`\\]|\$\{/.test(s)) throw new Error(`emoji-data: ${what} ${JSON.stringify(s)} has a character the data can't hold`);
  return s;
}

function generate(locale) {
  const data = read(`${locale}/data.json`);
  const messages = read(`${locale}/messages.json`);
  const meta = read('meta/groups.json');
  const codesOf = new Map();
  for (const file of LOCALES[locale].shortcodes) {
    for (const [hexcode, codes] of Object.entries(read(file))) {
      const list = codesOf.get(hexcode) || [];
      for (const code of [].concat(codes)) if (!list.includes(code)) list.push(code);
      codesOf.set(hexcode, list);
    }
  }

  const byGroup = new Map();
  for (const entry of data) {
    if (entry.group === undefined || entry.group === COMPONENT || entry.version > NEWEST) continue;
    if (!RGI.test(entry.emoji)) throw new Error(`emoji-data: ${entry.emoji} (${entry.label}) isn't fully qualified RGI here; is this Node's ICU older than Emoji ${NEWEST}?`);
    const skins = skinsOf(entry);
    for (const s of skins || []) if (!RGI.test(s)) throw new Error(`emoji-data: the tone ${s} of ${entry.label} isn't RGI here`);
    const codes = (codesOf.get(entry.hexcode) || []).map((c) => field(c.toLowerCase(), 'short code'));
    if (codes.some((c) => /\s/.test(c))) throw new Error(`emoji-data: a short code of ${entry.label} has a space`);
    // Search words the label and the codes don't already give.
    const known = new Set([...words(entry.label), ...codes.flatMap(codeWords)]);
    const extra = [];
    for (const tag of entry.tags || []) for (const w of words(tag)) if (!known.has(w)) known.add(w), extra.push(w);
    const tone = !skins ? '' : skins.every((s, i) => s === toned(entry.emoji, i + 1)) ? '+' : skins.join(' ');
    const shown = field(upperFirst(entry.label, locale), 'label');
    if (codes.includes('=')) throw new Error(`emoji-data: ${entry.label} has the short code =, which the data uses for its own`);
    const written = codes.map((c) => (c === labelCode(shown) ? '=' : c));
    const row = [field(entry.emoji, 'emoji'), shown, written.join(' '), extra.join(' '), tone];
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
    byGroup.get(entry.group).push({ order: entry.order, row: row.join('\t').replace(/\t+$/, '') });
  }

  const groups = [...byGroup.keys()].sort((a, b) => a - b);
  const label = (key) => messages.groups.find((g) => g.key === key).message;
  const lines = [
    `// The team chat's emoji in ${locale === 'nl' ? 'Dutch' : 'English'}: generated by scripts/emoji-data.js from emojibase-data ${version} (MIT, see`,
    "// LICENSE in this folder). Run that script instead of editing this file; index.js reads it.",
    '//',
    '// groups: [id, label] in the order the picker shows them. emoji: a line per emoji in picker order with a blank line',
    "// between groups. Its fields, split by tabs and empty ones at the end left out: the character, its label, its short",
    "// codes ('=' for the label's own, grinning_face for \"Grinning face\"), more search words, and its skin tones: '+' for",
    '// the usual modifier after the first code point, or the five characters from light to dark.',
    'export const groups = [',
    ...groups.map((g) => `  ${JSON.stringify([meta.groups[g], upperFirst(label(meta.groups[g]), locale)])},`),
    '];',
    '',
    'export const emoji = `',
  ];
  const body = groups
    .map((g) => byGroup.get(g).sort((a, b) => a.order - b.order).map((e) => e.row.replace(/\t/g, '\\t')).join('\n'))
    .join('\n\n');
  return `${lines.join('\n')}${body}\`;\n`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const locale of Object.keys(LOCALES)) {
  const file = path.join(OUT, `data-${locale}.js`);
  fs.writeFileSync(file, generate(locale));
  console.log(`${path.relative(process.cwd(), file)}: ${fs.statSync(file).size} bytes`);
}
fs.copyFileSync(path.join(SOURCE, 'LICENSE'), path.join(OUT, 'LICENSE'));
