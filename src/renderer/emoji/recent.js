// The emoji this device used last and the skin tone it chose, for the chat's emoji picker and reactions. Both are per
// device, in localStorage. Storage can be missing or refuse (a private window, cleared or blocked site data), so
// every access is in try/catch: then the list is empty, the tone is none, and changes last until the window closes.

const RECENT = 'rukoo.chat.emoji.recent';
const SKIN = 'rukoo.chat.emoji.skin';
// How many recent emoji the picker keeps, reactions and the composer together.
export const RECENT_LIMIT = 24;
// The longest character an emoji is: the server takes 64 bytes of UTF-8, which is at most 64 UTF-16 code units.
const LONGEST = 64;

// What this window remembers when storage refuses a write.
let recentHere = null;
let skinHere = null;

const isEmoji = (c) => typeof c === 'string' && c.length > 0 && c.length <= LONGEST && !/\s/.test(c);

function load(key) {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    if (value === null) globalThis.localStorage.removeItem(key);
    else globalThis.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function clean(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) if (isEmoji(c) && !out.includes(c)) out.push(c);
  return out.slice(0, RECENT_LIMIT);
}

// The recent emoji, the last used first, as the characters useEmoji() was given.
export function recentEmoji() {
  if (recentHere) return [...recentHere];
  try {
    return clean(JSON.parse(load(RECENT) || '[]'));
  } catch {
    return [];
  }
}

// Records an emoji as used now, and returns the new list. Give it the emoji without a skin tone (Emoji.char), so the
// recent list shows the tone chosen at the time; an emoji with a tone is kept as it is.
export function useEmoji(char) {
  if (!isEmoji(char)) return recentEmoji();
  const list = [char, ...recentEmoji().filter((c) => c !== char)].slice(0, RECENT_LIMIT);
  recentHere = save(RECENT, JSON.stringify(list)) ? null : list;
  return [...list];
}

// The chosen skin tone, 1 (light) to 5 (dark), or 0 for none.
export function skinTone() {
  if (skinHere !== null) return skinHere;
  const n = Number(load(SKIN));
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
}

// Chooses a skin tone, 1 to 5, or 0 or anything else for none. Returns the tone that holds now.
export function setSkinTone(n) {
  const tone = Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
  skinHere = save(SKIN, tone ? String(tone) : null) ? null : tone;
  return tone;
}
