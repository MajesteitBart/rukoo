// @-mentions in the composer: which text is a mention being typed, and who fits it. No DOM and no imports, so the
// node tests can load it; mentions.js does the editor's side.

// What may come right before the @ of a mention: nothing (the start of a line), white space or an opening bracket or
// quote. A letter there makes it an email address typed in the text (name@example.com), which never opens the list.
const OPENERS = /[\s([{"'“‘«]/u;
// A name of a few words fits in this; longer text after an @ is a sentence, not a name.
const MAX_QUERY = 40;

// The mention being typed: text holds what comes before the caret in its text node, prev the character before that
// node in the same line ('' at the start of a line). Returns { start, query } with start the @'s offset in text,
// or null.
export function mentionToken(text, prev = '') {
  const at = text.lastIndexOf('@');
  if (at < 0) return null;
  const before = at > 0 ? text[at - 1] : prev;
  if (before && !OPENERS.test(before)) return null;
  const query = text.slice(at + 1).replace(/\u00a0/g, ' ');
  // A name starts right after the @, and two spaces in a row end it.
  if (query.length > MAX_QUERY || /^\s/.test(query) || /\s\s/.test(query) || /\n/.test(query)) return null;
  return { start: at, query };
}

// Lower case without accents, so "joel" finds "Joël".
const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const ADDRESS = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;

// How well a person fits what was typed after the @: the whole name, a later part of it ("vries" or "de vries" for
// Sanne de Vries), then a part of the address before the @. 0 when nothing fits.
export function matchScore(person, query) {
  const q = fold(query);
  if (!q) return 1;
  const name = fold(person.name);
  if (name.startsWith(q)) return 4;
  const words = name.split(' ');
  for (let i = 1; i < words.length; i++) if (words.slice(i).join(' ').startsWith(q)) return 3;
  const local = fold(person.address).split('@')[0];
  if (local.startsWith(q)) return 2;
  if (local.split(/[._+-]+/).some((part) => part.startsWith(q))) return 2;
  return 0;
}

// The people to suggest: those in the thread first, then the address book, each in its own order among equally good
// matches. A bare @ suggests only the thread. own: your own addresses, which are never suggested. A thread person
// without a name takes the one the address book has. Returns [{ name, address, thread }].
export function rankPeople({ query = '', thread = [], contacts = [], own = [], limit = 6 }) {
  const skip = new Set(own.map((a) => String(a || '').toLowerCase()));
  const names = new Map();
  for (const c of contacts) if (c && c.name && c.address) names.set(String(c.address).toLowerCase(), c.name);
  const seen = new Set();
  const pick = (list, inThread) => {
    const out = [];
    list.forEach((p, i) => {
      const address = String((p && p.address) || '').trim();
      const key = address.toLowerCase();
      if (!ADDRESS.test(address) || skip.has(key) || seen.has(key)) return;
      seen.add(key);
      const person = { name: String((p && p.name) || names.get(key) || '').trim(), address, thread: inThread };
      // The thread may know someone by another name than the address book does; either one finds them.
      const score = Math.max(matchScore(person, query), names.has(key) ? matchScore({ name: names.get(key), address }, query) : 0);
      if (score) out.push({ person, score, i });
    });
    return out.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.person);
  };
  const fromThread = pick(thread, true);
  const fromBook = fold(query) ? pick(contacts, false) : [];
  return [...fromThread, ...fromBook].slice(0, limit);
}

// The text of a mention: @ and the name, or the address when there is no name.
export const mentionLabel = (person) => `@${String(person.name || '').trim() || person.address}`;
