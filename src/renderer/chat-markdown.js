// Team chat messages in Markdown: the small vocabulary every app reads the same way. The wire keeps the text with its
// markers; this reads them into blocks and inline nodes, which the chat builds DOM nodes from. It never makes HTML.
// No DOM and no window.mail, so test/chat-markdown.test.js runs it in Node.
//
// Blocks, line by line: a fenced code block between lines of three backticks (an optional language word after the
// first, and the end of the text closes one too); quotes (> at the start); bulleted (- * +) and numbered (1. 1))
// lists, nested two spaces per level, three levels deep; headings (# ## ###); and paragraphs, where one newline is a
// line break and an empty line starts a new paragraph.
//
// Inline: `code`, **bold** and __bold__, *italic* and _italic_, ~~strike~~, [label](address) with an http, https or
// mailto address, bare addresses as linkify.js finds them, backslash escapes, and mentions. An opening delimiter isn't
// followed by white space and a closing one isn't preceded by it; an underscore also needs a non-word character or
// the edge on its outer side, so snake_case_name stays as it is. Unmatched delimiters are text. Formatting doesn't
// cross a line break.
//
// Mentions are the UTF-8 byte ranges of the wire (chat-text.js validMentions). Each is one token: formatting may wrap
// it, nothing splits it, no address is searched inside it, and in code it is text. A blocked author's mentions are
// text, as segments() shows them.
//
// Every step reads the text once from left to right and every search ahead remembers how far it got, so a message
// takes time in proportion to its length, also with long runs of *, _, ` or [ that never close.

import { validMentions } from './chat-text.js';
import { findUrls } from './linkify.js';

// The characters a backslash makes literal.
const ESCAPABLE = '\\`*_~[]()#>-+.!';
// Formatting nested deeper than this shows its markers: no one writes it, and the DOM built from it stays shallow.
const MAX_DEPTH = 20;

const FENCE = /^```[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*$/;
const FENCE_END = /^```[ \t]*$/;
const HEADING = /^(#{1,3}) /;
const LIST = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)]) /;

const isSpace = (c) => c !== '' && /\s/u.test(c);
const isWord = (c) => c !== '' && /[\p{L}\p{N}\p{M}]/u.test(c);

// The character before pos and the one at pos of s within [from, to), as whole code points; '' at an edge.
function charBefore(s, pos, from) {
  if (pos <= from) return '';
  const low = s.charCodeAt(pos - 1);
  if (low >= 0xdc00 && low <= 0xdfff && pos - 2 >= from) {
    const high = s.charCodeAt(pos - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(pos - 2, pos);
  }
  return s[pos - 1];
}
function charAt(s, pos, to) {
  if (pos >= to) return '';
  return s.codePointAt(pos) > 0xffff && pos + 1 < to ? s.slice(pos, pos + 2) : s[pos];
}

// An address a link may open: http and https with a host, or mailto.
function safeHref(href) {
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return false;
  const url = URL.parse(href);
  if (!url) return false;
  if (url.protocol === 'mailto:') return /^mailto:./i.test(href);
  if (url.protocol === 'http:' || url.protocol === 'https:') return /^https?:\/\//i.test(href) && Boolean(url.hostname);
  return false;
}

// ---- Inline ----

// One line of inline text t, with its mentions as UTF-16 ranges { actor, from, to, me } inside it, as Inline[].
function inline(t, marks) {
  const mask = new Uint8Array(t.length);
  for (const m of marks) mask.fill(1, m.from, m.to);
  const atoms = scan(t, marks, mask);
  return build(t, linkify(t, merge(atoms)), 0, t.length);
}

// The first reading: escapes, code spans, mentions and links, left to right, whichever starts first. Returns atoms:
// { k: 'text' | 'lit' | 'code' | 'mention' | 'link', start, end, … }; text is what the next steps may still read
// delimiters and addresses in, lit is an escaped character.
function scan(t, marks, mask) {
  const atoms = [];
  let i = 0;
  let plain = 0;
  let mi = 0;
  const flush = () => {
    if (i > plain) atoms.push({ k: 'text', s: t.slice(plain, i), start: plain, end: i });
    plain = i;
  };
  const put = (atom) => {
    flush();
    atoms.push(atom);
    i = plain = atom.end;
  };

  // The runs of backticks outside mentions by length, each with how far the search for a closing one has got.
  let runs = null;
  const closing = (length, after) => {
    if (!runs) {
      runs = new Map();
      for (let p = 0; p < t.length; ) {
        if (t[p] !== '`' || mask[p]) {
          p++;
          continue;
        }
        let q = p;
        while (q < t.length && t[q] === '`' && !mask[q]) q++;
        if (!runs.has(q - p)) runs.set(q - p, { at: [], next: 0 });
        runs.get(q - p).at.push(p);
        p = q;
      }
    }
    const run = runs.get(length);
    if (!run) return -1;
    while (run.next < run.at.length && run.at[run.next] < after) run.next++;
    return run.next < run.at.length ? run.at[run.next] : -1;
  };

  // The address of a link from p, after its (: up to the ) that closes it, with balanced parentheses inside and
  // escapes read. Returns { href, end } with end after the ), or null at white space, a bracket, a mention or the
  // end. A search stops at the next bracket, so the searches of all links together read the line once.
  const address = (p) => {
    let depth = 0;
    let href = '';
    for (let j = p; j < t.length; ) {
      const c = t[j];
      if (mask[j] || isSpace(c) || c === '[' || c === ']' || c === '<' || c === '>') return null;
      if (c === '\\' && j + 1 < t.length && ESCAPABLE.includes(t[j + 1]) && !mask[j + 1]) {
        href += t[j + 1];
        j += 2;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && depth-- === 0) return { href, end: j + 1 };
      href += c;
      j++;
    }
    return null;
  };

  // The [ that may start a link, innermost last: { at: its index in atoms, start }.
  const brackets = [];
  while (i < t.length) {
    while (mi < marks.length && marks[mi].from < i) mi++;
    if (mi < marks.length && marks[mi].from === i) {
      const m = marks[mi++];
      put({ k: 'mention', actor: m.actor, text: t.slice(m.from, m.to), me: m.me, start: m.from, end: m.to });
      continue;
    }
    const c = t[i];
    if (c === '\\' && i + 1 < t.length && ESCAPABLE.includes(t[i + 1]) && !mask[i + 1]) {
      put({ k: 'lit', s: t[i + 1], start: i, end: i + 2 });
    } else if (c === '`') {
      let end = i;
      while (end < t.length && t[end] === '`' && !mask[end]) end++;
      const close = closing(end - i, end);
      // Backticks without a closing run of as many are text.
      if (close < 0) i = end;
      else {
        let code = t.slice(end, close);
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        put({ k: 'code', text: code, start: i, end: close + (end - i) });
      }
    } else if (c === '[') {
      flush();
      brackets.push({ at: atoms.length, start: i });
      put({ k: 'text', s: '[', start: i, end: i + 1 });
    } else if (c === ']' && brackets.length) {
      flush();
      const open = brackets.pop();
      const link = atoms.length > open.at + 1 && t[i + 1] === '(' ? address(i + 2) : null;
      if (link && safeHref(link.href)) {
        const label = atoms.splice(open.at).slice(1);
        put({ k: 'link', href: link.href, children: label, start: open.start, end: link.end, from: open.start + 1, to: i });
        // No link inside a link: the [ before this one are text now.
        brackets.length = 0;
      } else i++;
    } else i++;
  }
  flush();
  return atoms;
}

// Neighbouring text atoms as one, so an address or a run of delimiters isn't cut where a [ or a ` turned out to be text.
function merge(atoms) {
  const out = [];
  for (const a of atoms) {
    const last = out[out.length - 1];
    if (a.k === 'text' && last && last.k === 'text' && last.end === a.start) out[out.length - 1] = { ...last, s: last.s + a.s, end: a.end };
    else out.push(a);
  }
  return out;
}

// Bare addresses in the text atoms (not in a link's label) as url atoms, as linkify.js finds them. They are found before
// the delimiters are, so an address with _ or * in it stays whole. linkify.js takes the ** * or ~~ that close emphasis
// around an address off it, but not _: here an address that ends in _ or __ ends before them when an _ that may open
// italics comes before it, so _see https://example.com_ links https://example.com. An address right after _ is part
// of a word to linkify.js, so _https://example.com_ is italic text without a link.
function linkify(t, atoms) {
  const out = [];
  for (const a of atoms) {
    if (a.k !== 'text') {
      out.push(a);
      continue;
    }
    // Where the first _ that may open italics is in this text, found once.
    let opener;
    const firstOpener = () => {
      if (opener === undefined) {
        opener = -1;
        for (let p = a.s.indexOf('_'); p >= 0; p = a.s.indexOf('_', p + 1)) {
          if (!isWord(charBefore(t, a.start + p, 0))) {
            opener = p;
            break;
          }
        }
      }
      return opener;
    };
    let at = 0;
    for (const url of findUrls(a.s)) {
      let { text, href } = url;
      const under = /_{1,2}$/.exec(text)?.[0].length || 0;
      if (under && text.length - under > 8 && firstOpener() >= 0 && firstOpener() < url.start) {
        text = text.slice(0, -under);
        href = href.slice(0, -under);
      }
      if (url.start > at) out.push({ k: 'text', s: a.s.slice(at, url.start), start: a.start + at, end: a.start + url.start });
      out.push({ k: 'url', text, href, start: a.start + url.start, end: a.start + url.start + text.length });
      at = url.start + text.length;
    }
    if (!at) out.push(a);
    else if (at < a.s.length) out.push({ k: 'text', s: a.s.slice(at), start: a.start + at, end: a.end });
  }
  return out;
}

// The text atoms split into text and runs of delimiters: * and _ of any length, ~ only in pairs. A run may open when
// the character after it isn't white space, and close when the one before it isn't; an _ run also needs a non-word
// character or the edge [from, to) on its outer side.
function delimiters(t, atoms, from, to) {
  const out = [];
  for (const a of atoms) {
    if (a.k !== 'text') {
      out.push(a);
      continue;
    }
    let p = 0;
    let plain = 0;
    const s = a.s;
    while (p < s.length) {
      const c = s[p];
      if (c !== '*' && c !== '_' && c !== '~') {
        p++;
        continue;
      }
      let q = p;
      while (q < s.length && s[q] === c) q++;
      if (c === '~' && q - p !== 2) {
        p = q;
        continue;
      }
      if (p > plain) out.push({ k: 'text', s: s.slice(plain, p) });
      const before = charBefore(t, a.start + p, from);
      const after = charAt(t, a.start + q, to);
      let canOpen = after !== '' && !isSpace(after);
      let canClose = before !== '' && !isSpace(before);
      if (c === '_') {
        canOpen &&= !isWord(before);
        canClose &&= !isWord(after);
      }
      out.push({ k: 'delim', ch: c, count: q - p, canOpen, canClose, opens: [], closes: [] });
      p = plain = q;
    }
    if (plain < s.length) out.push({ k: 'text', s: plain ? s.slice(plain) : s });
  }
  return out;
}

// Pairs the delimiter runs, as CommonMark does without its rule of three: each run that may close takes the nearest
// open run of its character, two characters (bold) when both have two, else one (italic); ~~ always two (strike).
// Runs between such a pair can't pair outside it any more. One stack per character keeps every search at the top,
// and every run goes on and off a stack once. Records the pairs in each run's opens and closes, innermost first.
function emphasis(atoms) {
  const stacks = { '*': [], _: [], '~': [] };
  atoms.forEach((d, pos) => {
    if (d.k !== 'delim') return;
    d.pos = pos;
    const own = stacks[d.ch];
    while (d.canClose && d.count > 0 && own.length) {
      const o = own[own.length - 1];
      const use = d.ch === '~' ? 2 : o.count >= 2 && d.count >= 2 ? 2 : 1;
      const type = d.ch === '~' ? 'strike' : use === 2 ? 'strong' : 'em';
      o.opens.push(type);
      d.closes.push(type);
      o.count -= use;
      d.count -= use;
      for (const stack of Object.values(stacks)) while (stack.length && stack[stack.length - 1].pos > o.pos) stack.pop();
      if (!o.count) own.pop();
    }
    if (d.count > 0 && d.canOpen) own.push(d);
  });
}

const MARKER = { strong: 2, em: 1, strike: 2 };

// Inline[] from atoms of t within [from, to): delimiters found and paired, then the tree built in one pass.
function build(t, atoms, from, to) {
  const list = delimiters(t, atoms, from, to);
  emphasis(list);
  const root = [];
  // The open containers as { children }: where their content goes. One too deep has its parent's children and the
  // marker it shows as text instead, { children, marker }.
  const stack = [{ children: root }];
  const add = (node) => {
    const children = stack[stack.length - 1].children;
    if (node.type === 'text') {
      if (!node.text) return;
      const last = children[children.length - 1];
      if (last && last.type === 'text') {
        last.text += node.text;
        return;
      }
    }
    children.push(node);
  };
  for (const a of list) {
    if (a.k === 'text' || a.k === 'lit') add({ type: 'text', text: a.s });
    else if (a.k === 'code') add({ type: 'code', text: a.text });
    else if (a.k === 'mention') add({ type: 'mention', actor: a.actor, text: a.text, me: a.me });
    else if (a.k === 'url') add({ type: 'link', href: a.href, children: [{ type: 'text', text: a.text }] });
    else if (a.k === 'link') add({ type: 'link', href: a.href, children: build(t, merge(a.children), a.from, a.to) });
    else if (a.k === 'delim') {
      for (let n = 0; n < a.closes.length; n++) {
        const top = stack.pop();
        if (top.marker) add({ type: 'text', text: top.marker });
      }
      add({ type: 'text', text: a.ch.repeat(a.count) });
      for (let n = a.opens.length - 1; n >= 0; n--) {
        const type = a.opens[n];
        if (stack.length > MAX_DEPTH) {
          const marker = a.ch.repeat(MARKER[type]);
          add({ type: 'text', text: marker });
          stack.push({ children: stack[stack.length - 1].children, marker });
        } else {
          const node = { type, children: [] };
          add(node);
          stack.push({ children: node.children });
        }
      }
    }
  }
  return root;
}

// ---- Blocks ----

// The lines of s as [start, end) without their line break: LF, CRLF or a lone CR.
function lines(s) {
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 10 && c !== 13) continue;
    out.push([start, i]);
    if (c === 13 && s.charCodeAt(i + 1) === 10) i++;
    start = i + 1;
  }
  out.push([start, s.length]);
  return out;
}

// Indentation in columns: a tab to the next multiple of four.
function columns(indent) {
  let n = 0;
  for (const c of indent) n = c === '\t' ? n + 4 - (n % 4) : n + 1;
  return n;
}

// The blocks of a message: text, its mentions as the wire has them, and opts.me (your member ID, so a mention of you
// says me: true) and opts.blocked (the author is someone you blocked: no mentions). Returns Block[]:
//   { type: 'paragraph', lines: Inline[][] }
//   { type: 'heading', level: 1 | 2 | 3, content: Inline[] }
//   { type: 'quote', lines: Inline[][] }
//   { type: 'list', ordered, start, items: [{ depth: 0 | 1 | 2, content: Inline[], ordered, number }] }
//   { type: 'code', lang: string | null, text }
// with Inline = { type: 'text', text } | { type: 'code', text } | { type: 'strong' | 'em' | 'strike', children }
//   | { type: 'link', href, children } | { type: 'mention', actor, text, me }.
// A list item also says whether it is numbered and its number (null for a bullet): an item nested in a list of the
// other kind keeps its own. A list's start is its first item's number.
export function parse(text, mentions, { me = null, blocked = false } = {}) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  // A mention over a line break would be cut by the blocks; it shows as text.
  const marks = (blocked ? [] : validMentions(s, mentions)).filter((m) => !/[\n\r]/.test(s.slice(m.from, m.to)));
  const mask = new Uint8Array(s.length);
  for (const m of marks) mask.fill(1, m.from, m.to);
  const free = (a, b) => !mask.subarray(a, b).includes(1);
  let mi = 0;
  // The mentions inside [a, b) relative to a. Every call starts after the last one ended, so each mention is read once.
  const marksIn = (a, b) => {
    while (mi < marks.length && marks[mi].from < a) mi++;
    const out = [];
    for (; mi < marks.length && marks[mi].from < b; mi++) {
      const m = marks[mi];
      if (m.to <= b) out.push({ actor: m.actor, from: m.from - a, to: m.to - a, me: Boolean(me) && m.actor === me });
    }
    return out;
  };
  const content = (a, b) => inline(s.slice(a, b), marksIn(a, b));

  const all = lines(s);
  const blocks = [];
  // The block that the next line of its kind continues.
  let open = null;
  for (let n = 0; n < all.length; n++) {
    const [start, end] = all[n];
    const line = s.slice(start, end);
    const fence = free(start, end) && FENCE.exec(line);
    if (fence) {
      const body = [];
      for (n++; n < all.length; n++) {
        const l = s.slice(all[n][0], all[n][1]);
        if (FENCE_END.test(l)) break;
        body.push(l);
      }
      blocks.push({ type: 'code', lang: fence[1] || null, text: body.join('\n') });
      open = null;
      continue;
    }
    if (!line.trim()) {
      open = null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading && free(start, start + heading[0].length) && line.slice(heading[0].length).trim()) {
      const lead = line.length - line.slice(heading[0].length).trimStart().length;
      const trail = line.length - line.trimEnd().length;
      blocks.push({ type: 'heading', level: heading[1].length, content: content(start + lead, end - trail) });
      open = null;
      continue;
    }
    if (line[0] === '>' && free(start, start + 1)) {
      const skip = line[1] === ' ' && free(start + 1, start + 2) ? 2 : 1;
      if (open?.type !== 'quote') blocks.push((open = { type: 'quote', lines: [] }));
      open.lines.push(content(start + skip, end));
      continue;
    }
    const item = LIST.exec(line);
    if (item && free(start, start + item[0].length)) {
      const ordered = item[3] !== undefined;
      const number = ordered ? Number(item[3]) : null;
      const cols = columns(item[1]);
      if (open?.type === 'list') {
        const { levels } = open;
        while (levels.length > 1 && cols < levels[levels.length - 1]) levels.pop();
        if (cols >= levels[levels.length - 1] + 2 && levels.length < 3) levels.push(cols);
        // A first-level item of the other kind starts a list of its own.
        if (levels.length === 1 && ordered !== open.ordered) open = null;
      }
      if (open?.type !== 'list') blocks.push((open = { type: 'list', ordered, start: number ?? 1, items: [], levels: [cols] }));
      const rest = line.slice(item[0].length);
      const lead = item[0].length + rest.length - rest.trimStart().length;
      open.items.push({ depth: open.levels.length - 1, content: content(start + lead, end), ordered, number });
      continue;
    }
    if (open?.type !== 'paragraph') blocks.push((open = { type: 'paragraph', lines: [] }));
    open.lines.push(content(start, end));
  }
  for (const b of blocks) if (b.type === 'list') delete b.levels;
  return blocks;
}

// ---- Plain text ----

function inlineText(nodes, out) {
  for (const node of nodes) {
    if (node.children) inlineText(node.children, out);
    else out.push(node.text);
  }
  return out;
}
const join = (nodes) => inlineText(nodes, []).join('');

// The text of a message without its markers, for notifications, room previews and summaries for screen readers: a
// line per line of text, heading, quote line and list item, code as it is, a link as its label. mentions: as for
// parse(), so a mention's text is never read as markers.
export function plainText(text, mentions = []) {
  const out = [];
  for (const b of parse(text, mentions)) {
    if (b.type === 'paragraph' || b.type === 'quote') for (const l of b.lines) out.push(join(l));
    else if (b.type === 'heading') out.push(join(b.content));
    else if (b.type === 'list') for (const item of b.items) out.push(join(item.content));
    else out.push(b.text);
  }
  return out.join('\n');
}
