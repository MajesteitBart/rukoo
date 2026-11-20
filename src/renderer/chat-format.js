// The composer's formatting commands (contract 3.3 "Composer shortcuts"): Markdown markers put around a selection or
// in front of its lines, and taken off again when they are there already. Pure: a command reads the composer's text
// and selection and answers with edits, so the node tests can load it (test/chat-model.test.js) and chat-input.js
// applies the edits to its parts. An edit never reaches into a mention chip: markers go in at the selection's edges
// and at line starts, and only marker characters come out.
//
// format(kind, text, start, end) -> { edits: [{ at, del, ins }], start, end } or null
//   kind     bold, italic, strike, code, link, codeBlock, bullets, numbers, quote
//   edits    in the order to apply them: each one's at is a position in the text as the edits before it left it
//   start, end   the selection afterwards

export const FORMATS = ['bold', 'italic', 'strike', 'code', 'link', 'bullets', 'numbers', 'quote', 'codeBlock'];

// The marker of each inline style. Italic writes underscores, as Slack's Ctrl+I does; an asterisk pair toggles off too.
const INLINE = {
  bold: ['**', ['**', '__']],
  italic: ['_', ['_', '*']],
  strike: ['~~', ['~~']],
  code: ['`', ['`']]
};

// The shortcut of each command, in the order of the formatting bar (contract 3.3: the same as Slack's).
export const SHORTCUTS = {
  bold: 'Ctrl+B',
  italic: 'Ctrl+I',
  strike: 'Ctrl+Shift+X',
  code: 'Ctrl+E',
  link: 'Ctrl+Shift+U',
  bullets: 'Ctrl+Shift+8',
  numbers: 'Ctrl+Shift+7',
  quote: 'Ctrl+Shift+9',
  codeBlock: 'Ctrl+Alt+Shift+C'
};

// The command a key press asks for, or null. e: { key, code, ctrlKey, metaKey, shiftKey, altKey }. The digits are read
// from code, so Shift+8 is the 8 key whatever the layout makes of it.
export function formatForKey(e) {
  if (!e || !(e.ctrlKey || e.metaKey)) return null;
  const key = String(e.key || '').toLowerCase();
  const digit = /^Digit(\d)$/.exec(String(e.code || ''))?.[1] || (/^\d$/.test(key) ? key : null);
  if (e.altKey) return e.shiftKey && (key === 'c' || e.code === 'KeyC') ? 'codeBlock' : null;
  if (e.shiftKey) {
    if (key === 'x' || e.code === 'KeyX') return 'strike';
    if (key === 'u' || e.code === 'KeyU') return 'link';
    if (digit === '8') return 'bullets';
    if (digit === '7') return 'numbers';
    if (digit === '9') return 'quote';
    return null;
  }
  if (key === 'b') return 'bold';
  if (key === 'i') return 'italic';
  if (key === 'e') return 'code';
  return null;
}

// Applies edits to a string: for the tests, and for chat-input.js to check a result.
export function applyEdits(text, edits) {
  let s = String(text);
  for (const e of edits) s = s.slice(0, e.at) + (e.ins || '') + s.slice(e.at + (e.del || 0));
  return s;
}

export function format(kind, text, start, end) {
  const s = String(text ?? '');
  let a = Math.max(0, Math.min(start, s.length));
  let b = Math.max(a, Math.min(end, s.length));
  if (INLINE[kind]) return inline(kind, s, a, b);
  if (kind === 'link') return link(s, a, b);
  if (kind === 'codeBlock') return codeBlock(s, a, b);
  if (kind === 'bullets' || kind === 'numbers' || kind === 'quote') return lines(kind, s, a, b);
  return null;
}

// ---------- inline ----------

function inline(kind, s, a, b) {
  const [marker, alternatives] = INLINE[kind];
  // Selected text that ends in white space keeps it outside the markers: "**word **" isn't bold.
  if (b > a) {
    while (b > a && /\s/.test(s[b - 1])) b--;
    while (a < b && /\s/.test(s[a])) a++;
  }
  for (const m of alternatives) {
    const n = m.length;
    // The markers sit just outside the selection, or the caret is between an empty pair: off.
    if (a - n >= 0 && s.slice(a - n, a) === m && s.slice(b, b + n) === m && !sameRun(s, a - n, m, -1) && !sameRun(s, b + n, m, 1)) {
      return { edits: [{ at: b, del: n }, { at: a - n, del: n }], start: a - n, end: b - n };
    }
    // The selection holds them at both ends: off.
    if (b - a >= 2 * n && s.slice(a, a + n) === m && s.slice(b - n, b) === m) {
      return { edits: [{ at: b - n, del: n }, { at: a, del: n }], start: a, end: b - 2 * n };
    }
  }
  const n = marker.length;
  return { edits: [{ at: b, ins: marker }, { at: a, ins: marker }], start: a + n, end: b + n };
}

// Whether the marker continues past i in direction dir: "***" around a selection is bold and italic, and Ctrl+I there
// must not take a star of the bold.
function sameRun(s, i, m, dir) {
  const c = m[0];
  return dir < 0 ? s[i - 1] === c : s[i] === c;
}

// ---------- links ----------

const URL = /^(https?:\/\/|mailto:)\S+$/i;

// [selection](|) with the caret where the address goes, or [](address) with the caret in the label when the
// selection is an address. Without a selection [|]().
function link(s, a, b) {
  const sel = s.slice(a, b);
  if (b > a && URL.test(sel.trim())) {
    return { edits: [{ at: b, ins: ')' }, { at: a, ins: '[](' }], start: a + 1, end: a + 1 };
  }
  if (b > a) {
    return { edits: [{ at: b, ins: ']()' }, { at: a, ins: '[' }], start: b + 3, end: b + 3 };
  }
  return { edits: [{ at: a, ins: '[]()' }], start: a + 1, end: a + 1 };
}

// ---------- lines ----------

const lineStart = (s, i) => s.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (s, i) => {
  const n = s.indexOf('\n', i);
  return n < 0 ? s.length : n;
};

// The start of every line the selection touches. A selection that ends right after a line break leaves that line out.
function touched(s, a, b) {
  const last = b > a && s[b - 1] === '\n' ? b - 1 : b;
  const out = [];
  let i = lineStart(s, a);
  for (;;) {
    out.push(i);
    const e = lineEnd(s, i);
    if (e >= last || e >= s.length) break;
    i = e + 1;
  }
  return out;
}

const PREFIX = {
  bullets: /^[-*+] /,
  numbers: /^\d{1,9}[.)] /,
  quote: /^> ?/
};

// Bulleted list, numbered list and quote: every touched line gets the prefix, or loses it when all of them have it.
// A line that has another list's prefix trades it for this one.
function lines(kind, s, a, b) {
  const starts = touched(s, a, b);
  const has = (i) => PREFIX[kind].exec(s.slice(i, lineEnd(s, i)));
  const all = starts.every((i) => has(i));
  const edits = [];
  // From the last line up, so every at is still right when its edit applies.
  const numbered = starts.map((i, n) => [i, n]).reverse();
  for (const [i, n] of numbered) {
    const line = s.slice(i, lineEnd(s, i));
    let del = 0;
    let ins = '';
    if (all) del = has(i)[0].length;
    else if (has(i)) continue;
    else {
      // A list line of the other kind trades its marker; a quote keeps its own and gets the list inside it.
      for (const k of ['bullets', 'numbers']) {
        const m = k !== kind && kind !== 'quote' && PREFIX[k].exec(line);
        if (m) del = m[0].length;
      }
      ins = kind === 'bullets' ? '- ' : kind === 'numbers' ? `${n + 1}. ` : '> ';
    }
    edits.push({ at: i, del, ins });
  }
  if (!edits.length) return null;
  return { edits, start: mapPos(a, edits), end: mapPos(b, edits) };
}

// Where a position ends up after edits: before an edit it stays, after it it moves by the change, and inside a deleted
// range it goes to the end of what was put in.
export function mapPos(pos, edits) {
  let p = pos;
  for (const e of edits) {
    const del = e.del || 0;
    const ins = (e.ins || '').length;
    if (p < e.at) continue;
    if (p >= e.at + del) p += ins - del;
    else p = e.at + ins;
  }
  return p;
}

// ---------- code blocks ----------

const FENCE = '```';

// The selection between fence lines of its own, or a fence pair around an empty line with the caret on it. Fences
// right around the selected lines already: both go.
function codeBlock(s, a, b) {
  const first = lineStart(s, a);
  const lastEnd = lineEnd(s, b > a && s[b - 1] === '\n' ? b - 1 : b);
  const before = first > 0 ? s.slice(lineStart(s, first - 1), first - 1) : null;
  const after = lastEnd < s.length ? s.slice(lastEnd + 1, lineEnd(s, lastEnd + 1)) : null;
  if (b > a && before !== null && after !== null && /^```\w*$/.test(before) && after === FENCE) {
    const openAt = lineStart(s, first - 1);
    const closeLen = FENCE.length + 1;
    return {
      edits: [
        { at: lastEnd, del: closeLen },
        { at: openAt, del: first - openAt }
      ],
      start: a - (first - openAt),
      end: b - (first - openAt)
    };
  }
  if (b > a) {
    // Fences go on lines of their own: around the whole lines the selection touches.
    const open = `${FENCE}\n`;
    const close = `\n${FENCE}`;
    return {
      edits: [
        { at: lastEnd, ins: close },
        { at: first, ins: open }
      ],
      start: a + open.length,
      end: b + open.length
    };
  }
  // A caret: a block with an empty line, on a line of its own.
  const atStart = a === lineStart(s, a);
  const atEnd = a === lineEnd(s, a);
  const lead = atStart ? '' : '\n';
  const tail = atEnd ? '' : '\n';
  const ins = `${lead}${FENCE}\n\n${FENCE}${tail}`;
  const caret = a + lead.length + FENCE.length + 1;
  return { edits: [{ at: a, ins }], start: caret, end: caret };
}

// ---------- emoji short codes ----------

// The ":code" being typed before the caret, for the completion list (contract 3.4): a colon after white space, an
// opening bracket or the start, then two or more letters, digits, _, + or -. Returns { start, query } with start the
// colon's position in before, or null.
export function emojiToken(before) {
  const m = /(^|[\s([{])(:([a-z0-9_+-]{2,40}))$/i.exec(String(before || ''));
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[3].toLowerCase() };
}

// A whole ":code:" just typed before the caret: { start, code }, for replacing it with its emoji.
export function emojiCode(before) {
  const m = /(^|[\s([{]):([a-z0-9_+-]{1,40}):$/i.exec(String(before || ''));
  if (!m) return null;
  return { start: m.index + m[1].length, code: m[2].toLowerCase() };
}
