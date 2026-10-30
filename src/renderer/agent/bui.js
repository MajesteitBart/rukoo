// Ported from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
// Vanilla DOM ports of the components the agent panel uses. No HTML strings for anything the agent or
// the user wrote: text goes in through textContent. Every label is a parameter; there is no i18n here.

// ---------- helpers ----------

// h('div', { class, text, title, onClick, style: {…} }, ...children). Strings become text nodes.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'style') Object.assign(el.style, value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child);
  return el;
}

// Static SVG markup only; never pass agent text through here.
function svgFrom(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup;
  return tpl.content.firstElementChild;
}

// BUI icons on a 24 grid: [paths, default stroke width]. Width 0 means a filled shape.
const ICONS = {
  plus: ['<path d="M12 5v14M5 12h14"/>', 2],
  clock: ['<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 2],
  more: ['<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></g>', 2],
  send: ['<path d="M12 19V5M5 12l7-7 7 7"/>', 2.4],
  stop: ['<rect x="4.5" y="4.5" width="15" height="15" rx="3" fill="currentColor" stroke="none"/>', 0],
  check: ['<path d="M20 6L9 17l-5-5"/>', 2.5],
  x: ['<path d="M18 6L6 18M6 6l12 12"/>', 2.2],
  chevron: ['<path d="M6 9l6 6 6-6"/>', 2.2],
  'chevron-up': ['<path d="M18 15l-6-6-6 6"/>', 2.2],
  'chevron-right': ['<path d="M9 6l6 6-6 6"/>', 2.2],
  file: ['<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', 1.8],
  'file-text': ['<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>', 1.8],
  image: ['<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.6-4.6a1.5 1.5 0 0 0-2.1 0L5 21"/>', 1.8],
  clip: ['<path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>', 1.8],
  globe: ['<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>', 1.8],
  layers: ['<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>', 1.8],
  chart: ['<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', 1.8],
  mic: ['<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>', 2],
  sparkle: ['<path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" fill="currentColor" stroke="none"/>', 0],
  search: ['<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', 2],
  mail: ['<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7.5 8.5 6 8.5-6"/>', 1.8],
  list: ['<path d="M4 6h16M4 12h16M4 18h10"/>', 2.2],
  'list-check': ['<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>', 2],
  link: ['<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', 1.8],
  'arrow-right': ['<path d="M5 12h14M12 5l7 7-7 7"/>', 2],
  'arrow-out': ['<path d="M7 17L17 7M7 7h10v10"/>', 2.5],
  undo: ['<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>', 1.8],
  pen: ['<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>', 2],
  terminal: ['<path d="M4 17l6-5-6-5M12 19h8"/>', 2],
  retry: ['<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>', 2],
  copy: ['<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 1.8],
  shield: ['<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>', 1.8],
  wrench: ['<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>', 1.8],
  person: ['<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', 1.8],
  calendar: ['<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>', 1.8],
  info: ['<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.2"/>', 2],
  minus: ['<path d="M5 12h14"/>', 2.5],
  bolt: ['<path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12z"/>', 1.8],
  // An agent's own skill, as t3code shows one: Lucide's box.
  skill: ['<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>', 1.85],
  sliders: ['<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>', 1.8]
};

export function icon(name, size = 16, strokeWidth) {
  if (name === 'spinner') return h('span', { class: 'bui-spin', 'aria-hidden': 'true' });
  const key = Object.hasOwn(ICONS, name) ? name : 'wrench';
  const def = ICONS[key];
  const sw = Number(strokeWidth ?? def[1]) || 0;
  const stroke = sw ? `stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"` : 'stroke="none"';
  return svgFrom(`<svg width="${Number(size) || 16}" height="${Number(size) || 16}" viewBox="0 0 24 24" fill="none" ${stroke} aria-hidden="true" data-icon="${key}">${def[0]}</svg>`);
}

// A dial whose needle stands at level, from 0 (left) to 1 (right). Without a level only its centre shows: the
// effort button while the agent decides.
export function gauge(level = null, size = 13) {
  let mark = '<circle cx="12" cy="17" r="1.3" fill="currentColor" stroke="none"/>';
  if (typeof level === 'number' && Number.isFinite(level)) {
    const a = Math.PI * (1 - Math.max(0, Math.min(1, level)));
    mark = `<path d="M12 17l${(6.5 * Math.cos(a)).toFixed(2)} ${(-6.5 * Math.sin(a)).toFixed(2)}"/>`;
  }
  const n = Number(size) || 13;
  return svgFrom(`<svg width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" data-icon="gauge"><path d="M3.5 17a8.5 8.5 0 1 1 17 0"/>${mark}</svg>`);
}

// Same hash as ui.js hue(), so a sender gets the same colour as in the list.
function hueOf(text) {
  let v = 7;
  for (const c of String(text || '').toLowerCase()) v = (v * 31 + c.charCodeAt(0)) % 360;
  return v;
}

function initialsOf(label) {
  const raw = String(label || '?')
    .replace(/\(.*?\)|["'<>[\]]/g, ' ')
    .trim();
  const words = raw.includes('@') && !raw.includes(' ') ? [raw.split('@')[0]] : raw.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]];
  const last = words.length > 1 ? [...words[words.length - 1]] : [];
  return (first[0] + (last[0] || first[1] || '')).toUpperCase();
}

export function monogram({ label = '', hue, size = 16, src = null, agent = false } = {}) {
  const el = h('span', { class: 'bui-mono' + (agent ? ' bui-mono--agent' : ''), 'aria-hidden': 'true' });
  const key = hue ?? label;
  el.style.setProperty('--h', String(typeof key === 'number' ? key : hueOf(key)));
  if (size !== 16) Object.assign(el.style, { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.56)}px` });
  if (src) {
    el.classList.add('has-img');
    const img = h('img', { src, alt: '' });
    img.addEventListener('error', () => {
      el.classList.remove('has-img');
      el.replaceChildren(initialsOf(label));
    });
    el.append(img);
  } else {
    el.textContent = [...String(label)].length <= 2 ? String(label).toUpperCase() : initialsOf(label);
  }
  return el;
}

export function button({ label, kind = 'secondary', size = 'md', icon: iconName = null, onClick, disabled = false, title } = {}) {
  const el = h('button', { type: 'button', class: `bui-btn bui-btn--${kind} bui-btn--${size}`, title }, iconName ? icon(iconName, size === 'md' ? 15 : 13) : null, label);
  el.disabled = Boolean(disabled);
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

export function entityChip({ label, sub, monogram: mono, onRemove, removeLabel } = {}) {
  const avatar = mono instanceof Node ? mono : monogram(typeof mono === 'string' ? { label: mono } : mono || { label });
  const el = h('span', { class: 'bui-entity' + (onRemove ? ' has-remove' : '') }, avatar, h('span', { class: 'bui-entity__name', text: label, title: label }));
  if (sub) el.append(h('span', { class: 'bui-entity__sub', text: sub, title: sub }));
  if (onRemove) el.append(h('button', { type: 'button', class: 'bui-entity__x', 'aria-label': removeLabel || null, onClick: onRemove }, icon('x', 10, 2.5)));
  return el;
}

// A file or email that goes along with a message: an icon badge instead of a monogram, a name and a detail (the
// size, the sender). With onRemove it has an x. pending: still on its way (busy: what assistive tech hears); it
// has no x until it is there.
export function attachmentChip({ label, sub, icon: iconName = 'file', onRemove, removeLabel, pending = false, busy = '' } = {}) {
  const badge = h('span', { class: 'bui-entity__badge bui-entity__badge--file', 'aria-hidden': 'true' }, icon(iconName, 10, 2.2));
  const el = entityChip({ label, sub, monogram: badge, onRemove: pending ? null : onRemove, removeLabel });
  el.classList.add('bui-entity--attached');
  if (pending) {
    el.classList.add('is-pending');
    el.setAttribute('aria-busy', 'true');
    if (busy) el.setAttribute('aria-label', busy);
  }
  return el;
}

// A dashed entity chip that is a button: an empty place to put something (back) into.
export function addChip({ label, title, onClick } = {}) {
  return h('button', { type: 'button', class: 'bui-entity bui-entity--add', title: title || null, onClick }, icon('plus', 11, 2.4), h('span', { class: 'bui-entity__name', text: label }));
}

export function shimmer(text) {
  return h('span', { class: 'bui-shimmer', text });
}

// Stops a timer once the element has been attached and then removed, so forgotten components do not tick forever.
function autoStop(el, stop) {
  let seen = false;
  return () => {
    if (el.isConnected) seen = true;
    else if (seen) stop();
  };
}

export function loadingState({ label } = {}) {
  const cells = [];
  for (let i = 0; i < 9; i++) {
    const delay = ((i % 3) + Math.abs(Math.floor(i / 3) - 1)) * 90;
    cells.push(h('span', { class: 'bui-load__cell', style: { '--delay': `${delay}ms` } }));
  }
  const time = h('span', { class: 'bui-load__time', text: '0.0s' });
  const el = h('div', { class: 'bui-load', role: 'status' }, h('span', { class: 'bui-load__grid', 'aria-hidden': 'true' }, cells), h('span', { class: 'bui-load__label', text: label || '' }), time);
  const started = performance.now();
  const check = autoStop(el, () => clearInterval(timer));
  const timer = setInterval(() => {
    const t = (performance.now() - started) / 1000;
    time.textContent = t < 60 ? `${t.toFixed(1)}s` : `${Math.floor(t / 60)}m ${(t % 60).toFixed(1)}s`;
    check();
  }, 100);
  el.stop = () => clearInterval(timer);
  return el;
}

// ---------- markdown (a small, safe subset, built as DOM) ----------

// Agents write markdown. The transcript shows paragraphs and line breaks, **bold**, *italic*, `code`,
// fenced code, -, * and 1. lists, # headings (as bold lines), > quotes, rules and links. Every piece of
// text goes in as a text node; links only for http, https and mailto, anything else stays plain text.
const SAFE_LINK = /^(https?:|mailto:)/i;
const INLINE_RE =
  /(`+)([^`\n](?:[\s\S]*?[^`])?)\1(?!`)|\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)|(\*\*|__)(?=\S)([\s\S]*?\S)\5|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])|\bhttps?:\/\/[^\s<>"']+|\bmailto:[^\s<>"']+/g;

function link(href, text) {
  return h('a', { href, target: '_blank', rel: 'noreferrer', text });
}

// Text with its single line breaks as <br>.
function textNodes(str, into) {
  String(str)
    .split('\n')
    .forEach((line, i) => {
      if (i) into.append(h('br'));
      if (line) into.append(line);
    });
}

// open: the text is still streaming, so a ** or ` that is not closed yet formats up to the end
// instead of showing as a stray marker for a moment.
function closeOpen(str) {
  let s = str;
  for (const marker of ['**', '`']) {
    const n = s.split(marker).length - 1;
    if (n % 2 === 0) continue;
    if (/(\*\*|`)\s*$/.test(s) && s.trimEnd().endsWith(marker)) s = s.trimEnd().slice(0, -marker.length);
    else s += marker;
  }
  return s;
}

function inline(str, into, open = false) {
  const src = open ? closeOpen(str) : str;
  // Its own copy: bold and italic recurse, and a shared lastIndex would send this loop back to the start.
  const re = new RegExp(INLINE_RE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    let end = m.index + m[0].length;
    let node;
    if (m[1]) node = h('code', { text: m[2] });
    else if (m[3]) {
      if (SAFE_LINK.test(m[4])) node = link(m[4], m[3]);
      else node = document.createTextNode(m[3]);
    } else if (m[5]) {
      node = h('strong');
      inline(m[6], node);
    } else if (m[7] || m[8]) {
      node = h('em');
      inline(m[7] || m[8], node);
    } else {
      // A bare URL, without the punctuation that ends the sentence or an unmatched closing bracket.
      let url = m[0].replace(/[.,;:!?]+$/, '');
      while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
      end = m.index + url.length;
      node = link(url, url);
      re.lastIndex = end;
    }
    textNodes(src.slice(last, m.index), into);
    into.append(node);
    last = end;
  }
  textNodes(src.slice(last), into);
}

const FENCE_RE = /^\s*(```|~~~)/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const HEAD_RE = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

// One list, from line i; deeper items nest under the item before them. Returns the next line.
function list(lines, i, into, open) {
  const first = LIST_RE.exec(lines[i]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const el = h(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) !== 1) el.setAttribute('start', String(parseInt(first[2], 10)));
  into.append(el);
  let li = null;
  let text = [];
  const flush = (atEnd) => {
    if (li && text.length) inline(text.join('\n'), li, open && atEnd);
    text = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_RE.exec(line);
    if (m && m[1].length <= indent && /\d/.test(m[2]) === ordered && !RULE_RE.test(line)) {
      if (m[1].length < indent && li) break;
      flush(false);
      li = h('li');
      el.append(li);
      text = [m[3]];
      i++;
      continue;
    }
    if (m && m[1].length > indent && li) {
      flush(false);
      i = list(lines, i, li, open);
      continue;
    }
    if (!line.trim()) {
      // A blank line ends the list unless another item of it follows.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length && LIST_RE.exec(lines[j]);
      if (next && next[1].length >= indent && (next[1].length > indent || /\d/.test(next[2]) === ordered)) {
        i = j;
        continue;
      }
      break;
    }
    // An indented line carries on the item above it.
    if (li && /^\s+\S/.test(line) && !m) {
      text.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  flush(i >= lines.length);
  return i;
}

function blocks(src, into, open = false) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  let i = 0;
  const flush = () => {
    if (!para.length) return;
    const p = h('p');
    inline(para.join('\n'), p, open && i >= lines.length);
    into.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      flush();
      const fence = FENCE_RE.exec(line)[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      into.append(h('pre', null, h('code', { text: code.join('\n') })));
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    if (RULE_RE.test(line)) {
      flush();
      into.append(h('hr'));
      i++;
      continue;
    }
    const head = HEAD_RE.exec(line);
    if (head) {
      flush();
      const p = h('p', { class: 'bui-md-h' });
      i++;
      inline(head[1], p, open && i >= lines.length);
      into.append(p);
      continue;
    }
    if (QUOTE_RE.test(line)) {
      flush();
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) inner.push(QUOTE_RE.exec(lines[i++])[1]);
      const quote = h('blockquote');
      blocks(inner.join('\n'), quote, open && i >= lines.length);
      into.append(quote);
      continue;
    }
    // A list can start right under a line of text ("Most urgent first:"), as long as it starts at 1.
    const item = LIST_RE.exec(line);
    if (item && (!para.length || !/\d/.test(item[2]) || parseInt(item[2], 10) === 1)) {
      flush();
      i = list(lines, i, into, open);
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
}

// The innermost last block of the rendered text, where the caret goes.
function caretHost(root) {
  let node = root.lastElementChild;
  while (node) {
    const inner = node.lastElementChild;
    if (/^(UL|OL|BLOCKQUOTE)$/.test(node.tagName) && inner) node = inner;
    else if (node.tagName === 'LI' && inner && /^(UL|OL)$/.test(inner.tagName) && node.lastChild === inner) node = inner;
    else if (node.tagName === 'PRE' && inner) return inner;
    else return node;
  }
  return null;
}

// Blurs the last n characters of the text, inside whatever formatting they sit in.
function blurTail(root, n) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last = null;
  while (walker.nextNode()) if (walker.currentNode.textContent) last = walker.currentNode;
  if (!last || n <= 0) return;
  const s = last.textContent;
  const cut = Math.max(0, s.length - n);
  const tail = h('span', { class: 'bui-stream__tail', text: s.slice(cut) });
  last.textContent = s.slice(0, cut);
  last.after(tail);
}

// ---------- stream text ----------

// Re-rendering the markdown on every character is wasted work; this often is plenty.
const RENDER_MS = 80;

export function streamText({ interim = false } = {}) {
  const el = h('div', { class: 'bui-stream' + (interim ? ' bui-stream--interim' : '') });
  const caret = h('span', { class: 'bui-stream__caret is-streaming', 'aria-hidden': 'true' });
  let text = '';
  let count = 0;
  let done = false;
  let timer = null;
  // Text up to `settled` sits in finished blocks that are never drawn again; the rest is redrawn.
  let settled = 0;
  let live = [];
  let lastRender = 0;
  let lastCount = 0;
  let final = false;
  const check = autoStop(el, () => {
    count = text.length;
    stop();
  });

  // The last blank line outside a code fence in s, after `from`: everything before it is complete.
  function settleCut(s, from) {
    let cut = from;
    let fence = false;
    let offset = from;
    const lines = s.slice(from).split('\n');
    // The last line can still grow, so it never counts.
    for (let k = 0; k < lines.length - 1; k++) {
      if (FENCE_RE.test(lines[k])) fence = !fence;
      offset += lines[k].length + 1;
      if (!fence && !lines[k].trim()) cut = offset;
    }
    return cut;
  }

  function reset() {
    el.replaceChildren();
    settled = 0;
    live = [];
    lastCount = 0;
    final = false;
  }

  function render() {
    lastRender = performance.now();
    const streaming = count < text.length;
    if (done && !streaming) {
      // The finished text, drawn once from the start so the structure is right everywhere.
      if (final) return;
      final = true;
      const box = document.createDocumentFragment();
      blocks(text, box);
      el.replaceChildren(box);
      live = [];
      return;
    }
    const shown = text.slice(0, count);
    const cut = settleCut(shown, settled);
    for (const node of live) node.remove();
    live = [];
    if (cut > settled) {
      const box = document.createDocumentFragment();
      blocks(shown.slice(settled, cut), box);
      el.append(box);
      settled = cut;
    }
    const box = h('div');
    blocks(shown.slice(settled), box, true);
    if (streaming) blurTail(box, Math.min(24, Math.max(6, count - lastCount)));
    lastCount = count;
    if (!box.childElementCount) box.append(h('p'));
    (caretHost(box) || box).append(caret);
    live = [...box.childNodes];
    el.append(...live);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  function tick() {
    check();
    if (count >= text.length) {
      stop();
      render();
      return;
    }
    // Catch up quickly when a big chunk arrived, otherwise 2 chars per 9 ms like the original.
    const backlog = text.length - count;
    count = Math.min(text.length, count + Math.max(2, Math.ceil(backlog / 40)));
    if (count < text.length && /[\uD800-\uDBFF]/.test(text[count - 1])) count++;
    if (count >= text.length || performance.now() - lastRender >= RENDER_MS) render();
  }

  function start() {
    if (!timer) timer = setInterval(tick, 9);
  }

  render();
  return {
    el,
    append(delta) {
      if (!delta) return;
      text += String(delta);
      start();
    },
    set(next) {
      next = String(next ?? '');
      if (!next.startsWith(text)) {
        count = 0;
        reset();
      }
      text = next;
      final = false;
      start();
    },
    finish() {
      done = true;
      caret.classList.remove('is-streaming');
      // Text that was finished before any of it showed (a reopened chat) appears at once.
      if (count === 0) count = text.length;
      if (count >= text.length) {
        stop();
        render();
      }
    },
    get streaming() {
      return !done || count < text.length;
    },
    get text() {
      return text;
    }
  };
}

// ---------- thinking ----------

export function thinking({ labels = {}, startedAt } = {}) {
  const state = { text: '', status: 'running', startedAt: startedAt || Date.now(), endedAt: null, manual: null };
  const ico = h('span', { class: 'bui-think__icon' }, icon('sparkle', 16));
  const active = h('span', { class: 'bui-think__active', text: labels.thinking || '' });
  const secs = h('span', { class: 'bui-think__secs' });
  const doneLabel = h('span', { class: 'bui-think__done', hidden: true });
  const chev = icon('chevron', 14);
  chev.classList.add('bui-think__chev');
  const head = h('button', { type: 'button', class: 'bui-think__head', 'aria-expanded': 'false' }, ico, h('span', { class: 'bui-think__status', role: 'status' }, active, secs, doneLabel), chev);
  const textEl = h('div', { class: 'bui-think__text' });
  const trace = h('div', { class: 'bui-think__trace' }, textEl);
  const rail = h('span', { class: 'bui-think__rail', 'aria-hidden': 'true' });
  const collapse = h('div', { class: 'bui-think__collapse' }, h('div', null, h('div', { class: 'bui-think__wrap' }, rail, trace)));
  const el = h('div', { class: 'bui-think is-working' }, head, collapse);

  const seconds = () => Math.max(1, Math.round(((state.endedAt || Date.now()) - state.startedAt) / 1000));
  const check = autoStop(el, () => clearInterval(timer));
  const timer = setInterval(() => {
    if (state.status === 'running') secs.textContent = `${seconds()}s`;
    check();
  }, 500);
  secs.textContent = `${seconds()}s`;

  function expanded() {
    if (state.manual !== null) return state.manual;
    return state.status === 'running' && Boolean(state.text);
  }
  function layout() {
    const hasText = Boolean(state.text);
    const open = hasText && expanded();
    el.classList.toggle('has-text', hasText);
    el.classList.toggle('is-expanded', open);
    head.setAttribute('aria-expanded', String(open));
    head.disabled = !hasText;
    chev.hidden = !hasText;
    requestAnimationFrame(() => {
      rail.style.height = `${Math.max(0, trace.offsetHeight - 2)}px`;
    });
  }
  head.addEventListener('click', () => {
    if (!state.text) return;
    state.manual = !expanded();
    layout();
  });

  function update(next = {}) {
    if (next.text !== undefined) {
      state.text = next.text || '';
      textEl.textContent = state.text;
    }
    if (next.startedAt) state.startedAt = next.startedAt;
    if (next.endedAt !== undefined) state.endedAt = next.endedAt;
    if (next.status && next.status !== state.status) {
      state.status = next.status;
      if (state.status !== 'running') {
        if (!state.endedAt) state.endedAt = Date.now();
        clearInterval(timer);
        el.classList.remove('is-working');
        active.hidden = true;
        secs.hidden = true;
        doneLabel.textContent = typeof labels.thoughtFor === 'function' ? labels.thoughtFor(seconds()) : String(labels.thoughtFor || '');
        doneLabel.hidden = false;
      }
    }
    layout();
  }
  layout();
  return { el, update };
}

// ---------- tool chips ----------

const KIND_ICONS = {
  mail: 'mail',
  search: 'search',
  draft: 'pen',
  plan: 'list-check',
  sources: 'layers',
  approval: 'shield',
  command: 'terminal',
  web: 'globe',
  file: 'file',
  calendar: 'calendar',
  link: 'link',
  // Rukoo Voice's meeting tools: the transcript, the notes and the screen.
  meeting: 'mic',
  tool: 'wrench'
};

// count: several calls in a row with the same label share one chip ("Read a skill ×4"); their
// details are listed one per line.
export function toolChip(item = {}) {
  const ico = h('span', { class: 'bui-tool__ico' });
  const label = h('span', { class: 'bui-tool__label' });
  const times = h('span', { class: 'bui-tool__count', hidden: true });
  const status = h('span', { class: 'bui-tool__status' });
  const el = h('button', { type: 'button', class: 'bui-tool', 'aria-expanded': 'false' }, ico, label, times, status);
  const detail = h('div', { class: 'bui-tool__detail', hidden: true });
  let current = {};

  function update(next = {}) {
    current = { ...current, ...next };
    ico.replaceChildren(icon(KIND_ICONS[current.kind] || 'wrench', 14));
    label.textContent = current.label || current.name || '';
    const n = Number(current.count) || 1;
    times.textContent = n > 1 ? `×${n}` : '';
    times.hidden = n <= 1;
    const st = current.status || 'done';
    el.classList.toggle('is-running', st === 'running');
    el.classList.toggle('is-done', st === 'done');
    el.classList.toggle('is-error', st === 'error');
    el.classList.toggle('is-rukoo', Boolean(current.rukoo));
    status.replaceChildren(st === 'running' ? icon('spinner') : st === 'error' ? icon('x', 11, 3) : icon('check', 11, 3));
    const text = current.detail ? String(current.detail) : '';
    el.classList.toggle('has-detail', Boolean(text));
    el.title = text;
    detail.textContent = text;
    detail.classList.toggle('is-mono', current.kind === 'command');
    if (!text && !detail.hidden) toggle(false);
  }
  function toggle(open) {
    detail.hidden = !open;
    el.setAttribute('aria-expanded', String(open));
    el.dispatchEvent(new CustomEvent('bui-toggle', { bubbles: true, detail: { open } }));
  }
  el.addEventListener('click', () => {
    if (current.detail) toggle(detail.hidden);
  });
  update(item);
  return { el, detail, update, toggle };
}

export function toolGroup() {
  const row = h('div', { class: 'bui-tools__row' });
  const details = h('div', { class: 'bui-tools__details' });
  const el = h('div', { class: 'bui-tools' }, row, details);
  const chips = [];
  el.addEventListener('bui-toggle', (e) => {
    if (!e.detail.open) return;
    for (const chip of chips) if (chip.el !== e.target && !chip.detail.hidden) chip.toggle(false);
  });
  // Moves only the chips that are out of place, so the others keep their state and do not animate again.
  function place(parent, nodes) {
    nodes.forEach((node, i) => {
      if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null);
    });
    while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  }
  return {
    el,
    add(chip) {
      chips.push(chip);
      row.append(chip.el);
      details.append(chip.detail);
      return chip;
    },
    // The whole row at once, in this order.
    set(list) {
      chips.splice(0, chips.length, ...list);
      place(row, list.map((c) => c.el));
      place(details, list.map((c) => c.detail));
    }
  };
}

// ---------- transcript lines ----------

// ---------- the agent's own skills in text ----------

// A $name of one of the agent's skills, read the way the hub reads it (ownskills.js): at the start of a word, with a
// letter in the name, ending at a space, punctuation or the end of the text. While typing, the end of the text does
// not count yet, so a name still being typed stays text: t3code's rule.
const SKILL_SENT = /(^|\s)\$(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=[\s,.;!?)]|$)/g;
const SKILL_TYPED = /(^|\s)\$(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=[\s,.;!?)])/g;

// What a chip says for a skill: its display name, or the words of its name with a capital each (t3code's label).
export function skillLabel(skill) {
  const display = skill && typeof skill.displayName === 'string' ? skill.displayName.trim() : '';
  if (display) return display;
  return String((skill && skill.name) || '')
    .split(/[\s:_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// One of the agent's skills as t3code shows it in text: a chip with the box and its label. The input puts it in a
// message as $name; the tooltip says that name and what the skill does. labels.skill(label): its accessible name.
export function skillChip(skill, labels = {}) {
  const label = skillLabel(skill);
  const description = String(skill.description || '').trim();
  return h(
    'span',
    {
      class: 'bui-skill',
      'data-skill': skill.name,
      title: description ? `$${skill.name}\n${description}` : `$${skill.name}`,
      'aria-label': typeof labels.skill === 'function' ? labels.skill(label) : label
    },
    icon('skill', 12),
    h('span', { class: 'bui-skill__name', text: label })
  );
}

// text split into strings and the skills it names ({name, description}), for the agent's skills. typing: a name at
// the very end is still being typed. after: what comes before text is a chip, so its start is no word start.
function skillParts(text, skills, { typing = false, after = false } = {}) {
  const known = new Map((skills || []).map((s) => [s.name, s]));
  const out = [];
  if (!known.size || !text.includes('$')) return text ? [text] : [];
  // A leading character that is no space stands for the chip before the text.
  const lead = after ? '.' : '';
  const s = lead + text;
  let at = lead.length;
  for (const m of s.matchAll(typing ? SKILL_TYPED : SKILL_SENT)) {
    const skill = known.get(m[2]);
    const start = m.index + m[1].length;
    if (!skill || start < at) continue;
    if (start > at) out.push(s.slice(at, start));
    out.push(skill);
    at = start + 1 + m[2].length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

// A message's text with the agent's skills it names as chips, for a bubble.
export function skillText(text, skills, labels = {}) {
  return skillParts(String(text || ''), skills).map((p) => (typeof p === 'string' ? p : skillChip(p, labels)));
}

// A copy event on text that holds skill chips (sent messages): each chip goes as its $name, so pasting it starts the
// skill again. A copy without chips is left to the browser.
export function copySkills(e) {
  const sel = document.getSelection();
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!r || r.collapsed || !e.clipboardData) return;
  const copied = r.cloneContents();
  const chips = copied.querySelectorAll('.bui-skill');
  if (!chips.length) return;
  for (const chip of chips) chip.replaceWith(`$${chip.dataset.skill}`);
  // innerText of the copy, laid out off screen, has the line breaks a plain copy has.
  const box = h('div', { style: { position: 'fixed', left: '-10000px', top: '0', whiteSpace: 'pre-wrap' } }, copied);
  document.body.append(box);
  const text = box.innerText;
  box.remove();
  e.preventDefault();
  e.clipboardData.setData('text/plain', text);
}

// attachments: chips for what went along with the message, above its text. A message can be attachments alone.
// skills: the agent's own skills, shown as chips where the text names them.
export function userBubble({ text, action, labels = {}, attachments = [], skills = [] } = {}) {
  if (action === 'approved' || action === 'declined') {
    return h(
      'div',
      { class: `bui-sys bui-sys--${action}` },
      h('span', { class: 'bui-sys__ico' }, icon(action === 'approved' ? 'check' : 'x', 9, 3.5)),
      h('span', { text: labels[action] || '' }),
      h('span', { class: 'bui-sys__title', text: text || '', title: text || '' })
    );
  }
  const chips = attachments.length ? h('div', { class: 'bui-ubatt' }, attachments) : null;
  // The agent's own skills the text names show as the chips they were in the input.
  return h('div', { class: 'bui-ubwrap' }, chips, text || !chips ? h('div', { class: 'bui-ub' }, skillText(text, skills, labels)) : null);
}

export function noticeLine(item = {}, { labels = {}, onUndo } = {}) {
  const ico = h('span', { class: 'bui-notice__ico' });
  const text = h('span', { class: 'bui-notice__text' });
  const undo = h('button', { type: 'button', class: 'bui-notice__undo', text: labels.undo || '', hidden: true });
  const el = h('div', { class: 'bui-notice' }, ico, text, undo);
  let current = {};
  undo.addEventListener('click', () => {
    undo.disabled = true;
    if (onUndo) onUndo(current);
  });
  function update(next = {}) {
    current = { ...current, ...next };
    const tone = current.tone || 'info';
    el.className = `bui-notice bui-notice--${tone}`;
    ico.replaceChildren(tone === 'success' ? icon('check', 9, 3.5) : tone === 'error' ? icon('x', 9, 3.5) : icon('minus', 9, 3));
    text.textContent = current.text || '';
    undo.hidden = !current.undo || !onUndo;
  }
  update(item);
  return { el, update };
}

function donePill(tone, label) {
  const mark = tone === 'red' ? icon('x', 11, 3) : tone === 'grey' ? icon('minus', 11, 3) : icon('check', 11, 3);
  return h('span', { class: `bui-donepill bui-donepill--${tone}` }, h('span', { class: 'bui-donepill__circle' }, mark), h('span', { text: label }));
}

// ---------- approval card ----------

const KIND_ORDER = { danger: 0, default: 1, primary: 2 };
// Commands, paths and file contents: monospaced, in a box across the card.
const CODE_FIELDS = new Set(['command', 'path', 'file', 'folder', 'pattern', 'diff', 'content', 'before', 'after']);
// Longer values fold to about six lines with a "Show all" toggle. Nothing is ever cut off for good:
// the card shows exactly what the user approves.
const LONG_CHARS = 400;
const LONG_LINES = 6;

// labels: { approved, denied, expired, waiting, showAll, showLess, truncated(n) }. Fields:
// [{ key?, label, value, truncated? }] where truncated counts the characters main left out.
export function approvalCard(item = {}, { labels = {}, onChoose } = {}) {
  const title = h('div', { class: 'bui-approval__title' });
  const detail = h('div', { class: 'bui-approval__detail' });
  const fields = h('div', { class: 'bui-approval__fields' });
  const state = h('div', { class: 'bui-approval__state' });
  const actions = h('div', { class: 'bui-approval__actions' });
  const el = h('div', { class: 'bui-approval' }, h('div', { class: 'bui-approval__card' }, h('div', { class: 'bui-approval__pad' }, title, detail, fields), h('div', { class: 'bui-approval__footer' }, state, actions)));
  let current = {};
  let shownStatus = null;
  // Fields the user unfolded; they stay open when the card is drawn again.
  const unfolded = new Set();

  function field(f, i) {
    const value = String(f.value ?? '');
    const code = CODE_FIELDS.has(f.key);
    const text = h('div', { class: 'bui-approval__text', text: value });
    const v = h('div', { class: 'bui-approval__v' + (code ? ' is-code' : '') }, text);
    if (value.length > LONG_CHARS || value.split('\n').length > LONG_LINES) {
      const more = h('button', { type: 'button', class: 'bui-approval__more' });
      const show = () => {
        const open = unfolded.has(i);
        v.classList.toggle('is-folded', !open);
        more.textContent = open ? labels.showLess || '' : labels.showAll || '';
        more.setAttribute('aria-expanded', String(open));
      };
      more.addEventListener('click', () => {
        if (!unfolded.delete(i)) unfolded.add(i);
        show();
      });
      show();
      v.append(more);
    }
    const cut = Number(f.truncated) || 0;
    if (cut > 0) v.append(h('div', { class: 'bui-approval__cut', text: typeof labels.truncated === 'function' ? labels.truncated(cut) : String(labels.truncated || '') }));
    return [h('span', { class: 'bui-approval__k' + (code ? ' is-code' : ''), text: f.label || '' }), v];
  }

  function update(next = {}) {
    current = { ...current, ...next };
    title.textContent = current.title || '';
    detail.textContent = current.detail || '';
    detail.hidden = !current.detail;
    fields.replaceChildren(...(current.fields || []).flatMap(field));
    fields.hidden = !fields.childElementCount;
    const status = current.status || 'pending';
    el.dataset.status = status;
    // Which card it is (proposal, mail, calendar, runtime), for its styles.
    if (current.kind) el.dataset.kind = current.kind;
    if (status === shownStatus) return;
    shownStatus = status;
    if (status === 'pending') {
      state.replaceChildren(shimmer(labels.waiting || ''));
      const choices = [...(current.choices || [])].sort((a, b) => (KIND_ORDER[a.kind] ?? 1) - (KIND_ORDER[b.kind] ?? 1));
      // Four choices (Hermes) do not fit on one row: two by two, so the primary never ends up alone.
      actions.classList.toggle('is-many', choices.length > 3);
      actions.replaceChildren(
        ...choices.map((c) =>
          button({
            label: c.label,
            kind: c.kind === 'primary' ? 'primary' : c.kind === 'danger' ? 'danger' : 'secondary',
            size: 'sm',
            onClick: () => {
              for (const b of actions.querySelectorAll('button')) b.disabled = true;
              if (onChoose) onChoose(c.id);
            }
          })
        )
      );
    } else {
      const tone = status === 'approved' ? 'green' : status === 'denied' ? 'red' : 'grey';
      const label = labels[status] || status;
      // Name the chosen option only when there were several to choose from ("Approved · Allow for this turn").
      const choices = current.choices || [];
      const choice = choices.length > 2 ? choices.find((c) => c.id === current.decision) : null;
      state.replaceChildren(donePill(tone, label));
      if (choice && choice.label !== label) state.append(h('span', { class: 'bui-approval__choice', text: choice.label }));
      actions.replaceChildren();
    }
  }
  update(item);
  return { el, update };
}

// ---------- task rows (plan) ----------

function ring(n, active, muted) {
  const track = svgFrom(
    '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="var(--line)" stroke-width="2"/>' +
      (active ? '<circle cx="12" cy="12" r="11" fill="none" stroke="var(--ink-3)" stroke-width="2" stroke-linecap="round" stroke-dasharray="19.352 49.763"/>' : '') +
      '</svg>'
  );
  return h('span', { class: 'bui-ring' + (active ? ' is-active' : '') + (muted ? ' is-muted' : '') }, track, h('span', { class: 'bui-ring__n', text: String(n) }));
}

// "example.com" for web links, the scheme ("obsidian") for app links.
function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : u.protocol.replace(/:$/, '');
  } catch {
    return String(url || '');
  }
}

export function taskRows(item = {}, { labels = {}, onOpen } = {}) {
  const statuses = labels.statuses || {};
  const titleEl = h('span', { class: 'bui-plan__title' });
  const count = h('span', { class: 'bui-count' });
  const list = h('div', { class: 'bui-tasks' });
  const el = h('div', { class: 'bui-plan' }, h('div', { class: 'bui-plan__head' }, titleEl, count), list);
  const rows = new Map();

  function makeRow(index) {
    const slot = h('span', { class: 'bui-task__slot' });
    const label = h('span', { class: 'bui-task__label' });
    const amount = h('span', { class: 'bui-task__amount' });
    const pill = h('span', { class: 'bui-task__pill', hidden: true });
    const chev = h('span', { class: 'bui-task__chev', 'aria-hidden': 'true' }, icon('chevron', 15));
    const head = h('button', { type: 'button', class: 'bui-task__head', 'aria-expanded': 'false' }, slot, label, amount, pill, chev);
    const steps = h('div', { class: 'bui-task__steps' });
    const row = h('div', { class: 'bui-task', style: { '--i': String(index) } }, head, h('div', { class: 'bui-task__drawer' }, h('div', { class: 'bui-task__clip' }, h('div', { class: 'bui-task__detail' }, h('span', { class: 'bui-task__rail' }), steps))));
    let task = {};
    let lastStatus = null;
    head.addEventListener('click', () => {
      if (!row.classList.contains('has-detail')) return;
      const open = !row.classList.contains('is-open');
      row.classList.toggle('is-open', open);
      head.setAttribute('aria-expanded', String(open));
    });
    function update(next, i) {
      task = next;
      label.textContent = task.title || '';
      // Long titles wrap to two lines; the tooltip has the rest.
      label.title = task.title || '';
      amount.textContent = task.system || '';
      amount.hidden = !task.system;
      const status = task.status || 'todo';
      row.classList.toggle('is-skipped', status === 'skipped');
      if (status !== lastStatus) {
        lastStatus = status;
        slot.replaceChildren(
          status === 'done'
            ? h('span', { class: 'bui-badge bui-badge--green' }, icon('check', 13, 3.5))
            : status === 'failed'
              ? h('span', { class: 'bui-badge bui-badge--red' }, icon('x', 12, 3.5))
              : status === 'skipped'
                ? h('span', { class: 'bui-badge bui-badge--grey' }, icon('minus', 12, 3))
                : ring(i + 1, status === 'running', status === 'proposed')
        );
        const pillFor = { done: 'done', failed: 'failed', proposed: 'proposed', skipped: 'skipped' }[status];
        pill.hidden = !pillFor;
        if (pillFor) {
          pill.className = `bui-task__pill bui-task__pill--${pillFor}`;
          pill.replaceChildren(statuses[pillFor] || pillFor);
        }
      }
      const parts = [];
      if (task.detail) parts.push(h('div', { class: 'bui-task__text', text: task.detail }));
      if (task.owner) parts.push(h('div', { class: 'bui-task__step' }, h('span', null, icon('person', 12), task.owner)));
      if (task.due) parts.push(h('div', { class: 'bui-task__step' }, h('span', null, icon('calendar', 12), task.due)));
      if (task.url) {
        const link = h('button', { type: 'button', class: 'bui-task__link', title: task.url }, h('span', { text: hostOf(task.url) }), icon('arrow-out', 10, 2.5));
        link.addEventListener('click', (e) => {
          e.stopPropagation();
          if (onOpen) onOpen(task.url, task);
        });
        parts.push(h('div', { class: 'bui-task__step' }, h('span', null, link)));
      }
      parts.forEach((p, j) => p.style.setProperty('--j', String(j)));
      steps.replaceChildren(...parts);
      row.classList.toggle('has-detail', parts.length > 0);
      chev.hidden = parts.length === 0;
      if (!parts.length) row.classList.remove('is-open');
    }
    return { el: row, update };
  }

  function update(next = {}) {
    titleEl.textContent = next.title || '';
    const tasks = Array.isArray(next.tasks) ? next.tasks : [];
    count.textContent = String(tasks.length);
    const seen = new Set();
    tasks.forEach((task, i) => {
      const id = task.id || `#${i}`;
      seen.add(id);
      let row = rows.get(id);
      if (!row) {
        row = makeRow(rows.size);
        rows.set(id, row);
      }
      row.update(task, i);
      list.append(row.el);
    });
    for (const [id, row] of rows) if (!seen.has(id)) {
      row.el.remove();
      rows.delete(id);
    }
  }
  update(item);
  return { el, update };
}

// ---------- context cards (sources) ----------

export function contextCards(item = {}, { onOpen, labels = {} } = {}) {
  const titleEl = h('span', { class: 'bui-ctx__title' });
  const count = h('span', { class: 'bui-count' });
  const head = h('div', { class: 'bui-ctx__head' }, titleEl, count);
  const el = h('div', { class: 'bui-ctx' }, head);
  let shownTimer = null;

  function card(source, i) {
    const isMail = Boolean(source.messageId);
    const target = isMail || source.url;
    const host = source.url ? hostOf(source.url) : '';
    const bar = h(
      target ? 'button' : 'div',
      { class: 'bui-ctx__bar' + (target ? ' is-link' : ''), type: target ? 'button' : null, title: source.url || null },
      h('span', { class: 'bui-ctx__name' }, icon(isMail ? 'mail' : source.url ? 'globe' : 'list', 13, 2), h('span', { text: source.title || source.source || host })),
      host ? h('span', { class: 'bui-ctx__size', text: host }) : null
    );
    if (target) bar.addEventListener('click', () => onOpen && onOpen(source));
    const label = source.source || (isMail ? labels.email || '' : host);
    // An email always gets the mail badge, whatever the agent called its source.
    const badge = h('span', { class: 'bui-ctx__badge' + (isMail ? ' bui-ctx__badge--mail' : '') });
    if (isMail) badge.append(icon('mail', 9, 2.2));
    else {
      badge.textContent = initialsOf(label).slice(0, 2);
      badge.style.setProperty('--h', String(hueOf(label)));
    }
    const chip = h(target ? 'button' : 'span', { class: 'bui-ctx__chip', type: target ? 'button' : null, style: { '--i': String(i) } }, badge, h('span', { text: label }), target ? icon('arrow-out', 9, 2.5) : null);
    if (target) chip.addEventListener('click', () => onOpen && onOpen(source));
    return h('div', { class: 'bui-ctx__card', style: { '--i': String(i) } }, bar, source.snippet ? h('p', { class: 'bui-ctx__body', text: source.snippet }) : null, h('div', { class: 'bui-ctx__foot' }, chip));
  }

  function update(next = {}) {
    titleEl.textContent = next.title || '';
    const sources = Array.isArray(next.sources) ? next.sources : [];
    count.textContent = String(sources.length);
    el.replaceChildren(head, ...sources.map(card));
    el.classList.remove('chips-shown');
    clearTimeout(shownTimer);
    shownTimer = setTimeout(() => el.classList.add('chips-shown'), 150);
  }
  update(item);
  return { el, update };
}

// ---------- recommendation card ----------

export function recommendationCard({ eyebrow, title, body, actions = [], icon: eyebrowIcon = null } = {}, onAction) {
  const foot = h(
    'div',
    { class: 'bui-rec__foot' },
    actions.map((a) =>
      button({
        label: a.label,
        kind: a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'danger' : 'secondary',
        size: 'sm',
        onClick: () => onAction && onAction(a.id)
      })
    )
  );
  const el = h(
    'div',
    { class: 'bui-rec' },
    h(
      'div',
      { class: 'bui-rec__top' },
      eyebrow ? h('div', { class: 'bui-rec__eyebrow' }, eyebrowIcon instanceof Node ? eyebrowIcon : null, h('span', { text: eyebrow })) : null,
      h('div', { class: 'bui-rec__title', text: title || '' }),
      body ? h('p', { class: 'bui-rec__body', text: body }) : null
    ),
    actions.length ? foot : null
  );
  return { el };
}

// ---------- draft card ----------

function people(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => (typeof p === 'string' ? p : p && (p.name || p.address)) || '')
    .filter(Boolean)
    .join(', ');
}

// item.canUndo === false: the composer this draft went into is gone or has moved on, so Undo is off.
export function draftCard(item = {}, { labels = {}, onAction } = {}) {
  const title = h('span', { class: 'bui-draft__title', text: labels.title || '' });
  const acts = h('div', { class: 'bui-draft__acts' });
  const meta = h('div', { class: 'bui-draft__meta' });
  const sum = h('div', { class: 'bui-draft__sum' });
  const el = h('div', { class: 'bui-draft' }, h('div', { class: 'bui-draft__bar' }, h('span', { class: 'bui-draft__ico' }, icon('pen', 12, 2)), title, acts), meta, sum);
  let current = {};
  let undone = null;
  let undo = null;
  function update(next = {}) {
    current = { ...current, ...next };
    const to = people(current.to);
    meta.textContent = [to, current.subject].filter(Boolean).join(' · ');
    meta.title = meta.textContent;
    meta.hidden = !meta.textContent;
    sum.textContent = current.summary || '';
    sum.hidden = !current.summary;
    const isUndone = Boolean(current.undone);
    if (isUndone !== undone) {
      undone = isUndone;
      el.classList.toggle('is-undone', isUndone);
      undo = isUndone ? null : button({ label: labels.undo || '', kind: 'quiet', size: 'xs', onClick: () => onAction && onAction('undo', current) });
      acts.replaceChildren(button({ label: labels.show || '', kind: 'secondary', size: 'xs', onClick: () => onAction && onAction('show', current) }), undo || h('span', { class: 'bui-draft__undone', text: labels.undone || '' }));
    }
    if (undo) {
      undo.disabled = current.canUndo === false;
      undo.title = undo.disabled ? labels.cannotUndo || '' : '';
    }
  }
  update(item);
  return { el, update };
}

// ---------- suggestion chips ----------

export function suggestionChips(list = [], onPick) {
  return h(
    'div',
    { class: 'bui-sugg' },
    list.map((s, i) => h('button', { type: 'button', class: 'bui-sugg__chip', style: { '--i': String(i) }, onClick: () => onPick && onPick(s.id) }, s.icon ? icon(s.icon, 13) : null, s.label))
  );
}

// Not in BUI: the quiet round chip after the suggestions that leads to where they are set up. index: its place in
// the row, so it pops in after them.
export function suggestionEdit({ label, index = 0, onClick } = {}) {
  return h('button', { type: 'button', class: 'bui-sugg__chip bui-sugg__edit', style: { '--i': String(index) }, 'aria-label': label || null, title: label || null, onClick }, icon('sliders', 13));
}

// ---------- offer row ----------

// Not in BUI: a quiet row that offers one thing to pick up, such as an earlier chat. A button: a monogram, the
// offer, a line under it, and a chevron.
export function offerRow({ label, sub, monogram: mono, title, onClick } = {}) {
  const avatar = mono instanceof Node ? mono : monogram({ size: 20, ...(typeof mono === 'string' ? { label: mono } : mono || { label }) });
  return h(
    'button',
    { type: 'button', class: 'bui-offer', title: title || null, onClick },
    avatar,
    h('span', { class: 'bui-offer__text' }, h('span', { class: 'bui-offer__label', text: label || '' }), sub ? h('span', { class: 'bui-offer__sub', text: sub }) : null),
    icon('chevron-right', 13, 2.2)
  );
}

// ---------- glide menu ----------

let openMenu = null;

// The agents' connection states, and a chat's: 'unread' (an answer you have not seen), 'waiting' (for your approval),
// 'error', and 'none' (an empty slot that keeps the rows aligned).
const DOT_TONES = { ready: 'ready', offline: 'offline', unauthorized: 'offline', error: 'offline', busy: 'busy', waiting: 'busy', unread: 'unread', none: 'none' };
function statusDot(status) {
  if (status === 'running') return icon('spinner');
  const tone = DOT_TONES[status] || null;
  return h('span', { class: 'bui-dot' + (tone ? ` bui-dot--${tone}` : ''), 'aria-hidden': 'true' });
}

// A row with sub has a second line under its label, and its tag sits on the first line, after the label.
function menuRow(it, pick) {
  const label = h('span', { class: 'bui-menu__label', text: it.label || '' });
  const tag = it.tag ? h('span', { class: 'bui-menu__tag', text: it.tag }) : null;
  const two = Boolean(it.sub);
  const row = h(
    'button',
    {
      type: 'button',
      class: 'bui-menu__row' + (two ? ' bui-menu__row--two' : '') + (it.checked ? ' is-checked' : ''),
      role: 'option',
      'aria-selected': String(Boolean(it.checked)),
      'data-menu-row': '',
      'data-id': it.id == null ? null : String(it.id),
      title: it.title || null
    },
    it.icon ? h('span', { class: 'bui-menu__ico' }, it.icon instanceof Node ? it.icon : icon(it.icon, 14)) : null,
    it.status ? (two ? h('span', { class: 'bui-menu__mark' }, statusDot(it.status)) : statusDot(it.status)) : null,
    two ? h('span', { class: 'bui-menu__text' }, h('span', { class: 'bui-menu__top' }, label, tag), h('span', { class: 'bui-menu__sub', text: it.sub })) : label,
    two ? null : tag,
    h('span', { class: 'bui-menu__check' }, icon('check', 13, 2.5))
  );
  row.disabled = Boolean(it.disabled);
  row.addEventListener('click', () => pick(it));
  return row;
}

// update(items) redraws the rows of a menu that is open, such as the chat list while a chat finishes; the row with
// the keyboard focus keeps it when it is still there.
export function glideMenu({ items = [], anchor, onPick, align = 'left', width } = {}) {
  if (openMenu) openMenu.close();
  const hl = h('span', { class: 'bui-glide__hl', 'aria-hidden': 'true' });
  const list = h('div', { class: 'bui-menu__list bui-glide', role: 'listbox' }, hl);
  let rows = [];
  const pick = (it) => {
    close();
    if (onPick) onPick(it.id, it);
  };
  function fill(next) {
    rows = [];
    list.replaceChildren(hl);
    for (const it of next) {
      if (!it) continue;
      if (it.separator) {
        list.append(h('div', { class: 'bui-menu__sep', role: 'separator' }));
        continue;
      }
      if (it.heading) {
        list.append(h('div', { class: 'bui-menu__heading', text: it.heading }));
        continue;
      }
      const row = menuRow(it, pick);
      rows.push(row);
      list.append(row);
    }
  }
  fill(items);
  const el = h('div', { class: 'bui bui-menu', style: width ? { width: `${width}px` } : null }, list);

  function moveTo(target) {
    const row = target && target.closest ? target.closest('[data-menu-row]') : null;
    if (!row || !list.contains(row)) return;
    const c = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    hl.style.top = `${r.top - c.top}px`;
    hl.style.height = `${r.height}px`;
    hl.style.opacity = '1';
  }
  list.addEventListener('mouseover', (e) => moveTo(e.target));
  list.addEventListener('mouseleave', () => {
    hl.style.opacity = '0';
  });
  list.addEventListener('focusin', (e) => moveTo(e.target));
  list.addEventListener('focusout', (e) => {
    if (!list.contains(e.relatedTarget)) hl.style.opacity = '0';
  });

  function close() {
    if (openMenu !== menu) return;
    openMenu = null;
    el.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
  }
  function onDown(e) {
    if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) close();
  }
  function onKey(e) {
    const enabled = rows.filter((r) => !r.disabled);
    const i = enabled.indexOf(document.activeElement);
    // The keys the menu handles stay in it; the app's own shortcuts also skip anything inside .bui-menu.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === 'ArrowDown' ? 1 : enabled.length - 1;
      enabled[(Math.max(i, 0) + (i < 0 && step === 1 ? 0 : step)) % enabled.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      enabled[e.key === 'Home' ? 0 : enabled.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      if (anchor) anchor.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  }
  function update(next) {
    if (openMenu !== menu) return;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.id : undefined;
    fill(next);
    hl.style.opacity = '0';
    if (focused === undefined) return;
    // When the row that had the focus is gone, the first row takes it, so the focus stays in the menu.
    (rows.find((r) => r.dataset.id === focused && !r.disabled) || rows.find((r) => !r.disabled))?.focus();
  }
  const menu = { el, close, update };
  openMenu = menu;
  document.body.append(el);

  // Place it below the anchor when there is room, otherwise above (the composer sits at the bottom).
  const r = anchor ? anchor.getBoundingClientRect() : { left: 8, right: 8, top: 8, bottom: 8 };
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  const below = r.bottom + 8 + mh <= window.innerHeight - 8;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  el.style.left = `${left}px`;
  el.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - mh - 8)}px`;
  el.style.transformOrigin = `${below ? 'top' : 'bottom'} ${align === 'right' ? 'right' : 'left'}`;
  if (anchor) anchor.setAttribute('aria-expanded', 'true');

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  (rows.find((row) => row.classList.contains('is-checked')) || rows[0])?.focus();
  return menu;
}

// ---------- chat composer ----------

// The $ menu shows this many skills at most; typing narrows them down.
const SKILL_ROWS_MAX = 200;
// Undo steps the input keeps, and how long a pause in typing may be before the next keys are a step of their own.
const HISTORY_MAX = 100;
const HISTORY_MERGE_MS = 1000;
const HISTORY_MERGING = new Set(['insertText', 'deleteContentBackward', 'deleteContentForward']);

// The input's content as parts: strings, and {name} for each skill chip. Two strings never follow each other.
const partsText = (parts) => parts.map((p) => (typeof p === 'string' ? p : `$${p.name}`)).join('');
const partLength = (p) => (typeof p === 'string' ? p.length : p.name.length + 1);
const endsWithBreak = (parts) => typeof parts[parts.length - 1] === 'string' && parts[parts.length - 1].endsWith('\n');

function pushPart(out, p) {
  if (typeof p !== 'string') out.push(p);
  else if (!p) return;
  else if (typeof out[out.length - 1] === 'string') out[out.length - 1] += p;
  else out.push(p);
}

function mergedParts(list) {
  const out = [];
  for (const p of list) pushPart(out, p);
  return out;
}

const sameParts = (a, b) => a.length === b.length && a.every((p, i) => (typeof p === 'string' ? p === b[i] : typeof b[i] !== 'string' && b[i].name === p.name));

// The parts from position from to position to in their text. A chip only comes along whole.
function cutParts(parts, from, to) {
  const out = [];
  let at = 0;
  for (const p of parts) {
    const len = partLength(p);
    if (typeof p === 'string') {
      const a = Math.max(from, at);
      const b = Math.min(to, at + len);
      if (b > a) out.push(p.slice(a - at, b - at));
    } else if (at >= from && at + len <= to) out.push(p);
    at += len;
  }
  return out;
}

const spliceParts = (parts, start, end, text) => mergedParts([...cutParts(parts, 0, start), text, ...cutParts(parts, end, Infinity)]);

export function chatComposer(opts = {}, handlers = {}) {
  const labels = opts.labels || {};
  const state = {
    running: false,
    disabled: false,
    agents: Array.isArray(opts.agents) ? opts.agents : [],
    agentId: opts.agentId || null,
    commands: Array.isArray(opts.commands) ? opts.commands : [],
    // The agent's own skills for the $ menu (setSkills): the list, whether it is still loading, why it failed, and
    // the line above it.
    skills: { items: [], loading: false, error: '', heading: '' },
    // The menu on screen: '/' for commands, '$' for skills.
    sigil: null,
    dismissed: false,
    rows: [],
    active: 0,
    engaged: false,
    query: null,
    // Files or emails go along: a message can be those alone.
    attached: false,
    // Something the message takes is still on its way (setHolding): nothing can be sent or started until it is
    // there, and the text stays. holdLabel says so on the Send button.
    holding: false,
    holdLabel: '',
    // Where the caret was in the text, for when the input gets the focus back.
    caret: 0
  };
  // The chips row: the paperclip, the email the chat is about, then what the user attached. The paperclip leads,
  // so it stays put as chips come and go, and the footer keeps its room for the agent, model and effort menus.
  const attach = handlers.onAttach
    ? h('button', { type: 'button', class: 'bui-pb__attach', 'aria-label': labels.attach || null, title: labels.attach || null }, icon('clip', 15))
    : null;
  const contextSlot = h('span', { class: 'bui-pb__slot' });
  const attachedSlot = h('span', { class: 'bui-pb__slot' });
  const files = h('div', { class: 'bui-pb__files', hidden: true }, attach, contextSlot, attachedSlot);
  // A plain-text editable rather than a textarea, so a skill can sit in the text as a chip, as in t3code.
  const ta = h('div', {
    class: 'bui-pb__ta is-empty',
    contenteditable: 'plaintext-only',
    role: 'textbox',
    'aria-multiline': 'true',
    spellcheck: 'true',
    'data-placeholder': opts.placeholder || '',
    'aria-placeholder': opts.placeholder || null,
    'aria-label': opts.placeholder || labels.send || ''
  });
  const disabledRow = h('div', { class: 'bui-pb__disabled', hidden: true });
  let dot = statusDot(null);
  const agentName = h('span');
  const agentBtn = h('button', { type: 'button', class: 'bui-pb__modelbtn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': labels.agent || '' }, dot, agentName, icon('chevron', 11, 2.4));
  // The model and effort menus next to the agent picker. The caller fills them (setPicker); items is a
  // function, so a menu shows what is current when it opens.
  const pickers = {};
  for (const kind of ['model', 'effort']) {
    const text = h('span', { class: 'bui-pb__opttext' });
    const lead = kind === 'effort' ? gauge(null) : null;
    const btn = h('button', { type: 'button', class: 'bui-pb__opt', 'data-pick': kind, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', hidden: true }, lead, text, icon('chevron', 11, 2.4));
    pickers[kind] = { btn, text, lead, meter: null, items: () => [], menu: null };
    btn.addEventListener('click', () => openPicker(kind));
  }
  const send = h('button', { type: 'button', class: 'bui-pb__send', 'aria-label': labels.send || '' }, icon('send', 16));
  const row = h('div', { class: 'bui-pb__row' }, agentBtn, pickers.model.btn, pickers.effort.btn, h('span', { class: 'bui-pb__spacer' }), send);
  const box = h('div', { class: 'bui-pb__box' }, files, ta, disabledRow, row);
  const el = h('div', { class: 'bui-pb' }, box);
  let menu = null;
  let hl = null;
  // While an IME composes (Japanese, Chinese) the text is its own: no chips, no undo steps until it is done.
  let composing = false;
  // The undo list: what the input held after each step ({parts, caret}), and the one on screen. A textarea has its
  // own; an editable's would undo the chips' DOM wrongly, so the input keeps this one instead.
  // from: where the edit under way started, for record() to tell typing on from typing elsewhere.
  const history = { list: [{ parts: [], caret: 0 }], at: 0, type: '', last: 0, from: null };

  // ---------- the input's text ----------

  // The DOM holds text nodes and chips. The browser can add a line break as a <br> or a <div> (a drop, a test's
  // fill); settle() makes text of those. Positions count the text as it is sent, a chip as its $name.
  const isChip = (n) => n.nodeType === 1 && Boolean(n.dataset.skill);

  function partsOf(node, out = []) {
    // A <div> or <p> is a line of its own, an empty one too: a line break goes before it, unless it comes first,
    // and before what follows it.
    let first = true;
    let block = false;
    for (const n of node.childNodes) {
      const isBlock = n.nodeType === 1 && (n.nodeName === 'DIV' || n.nodeName === 'P');
      if ((isBlock && !first) || (block && !isBlock)) pushPart(out, '\n');
      if (n.nodeType === 3) pushPart(out, n.data);
      else if (isChip(n)) pushPart(out, { name: n.dataset.skill });
      // A <br> that ends its line only holds an empty line open.
      else if (n.nodeName === 'BR' && n !== node.lastChild) pushPart(out, '\n');
      else if (n.nodeType === 1 && n.nodeName !== 'BR') partsOf(n, out);
      first = false;
      block = isBlock;
    }
    return out;
  }
  // What the input holds. A line break that ends its last text only shows the empty line after a break before it.
  function current() {
    const parts = partsOf(ta);
    const last = ta.lastChild;
    if (last && last.nodeType === 3 && last.data.endsWith('\n') && endsWithBreak(parts)) {
      parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1);
      return mergedParts(parts);
    }
    return parts;
  }
  const value = () => partsText(current());
  // Read like a textarea's, for the Electron tests and anything else that looks at the element.
  Object.defineProperty(ta, 'value', { get: value });
  const canonical = () => [...ta.childNodes].every((n) => n.nodeType === 3 || isChip(n));
  function offsetAt(node, offset) {
    const r = document.createRange();
    r.setStart(ta, 0);
    r.setEnd(node, offset);
    return partsText(partsOf(r.cloneContents())).length;
  }
  // The selection in the text: start and end, and anchor and focus, which keep its direction. Without one in the
  // input, the caret where it last was.
  function selection() {
    const sel = document.getSelection();
    if (sel && sel.rangeCount && ta.contains(sel.anchorNode) && ta.contains(sel.focusNode)) {
      const len = value().length;
      const anchor = Math.min(offsetAt(sel.anchorNode, sel.anchorOffset), len);
      const focus = Math.min(offsetAt(sel.focusNode, sel.focusOffset), len);
      state.caret = Math.min(anchor, focus);
      return { start: state.caret, end: Math.max(anchor, focus), anchor, focus };
    }
    const at = Math.min(state.caret, value().length);
    return { start: at, end: at, anchor: at, focus: at };
  }
  const caret = () => selection().start;
  // The DOM point for a position: in a text node, or before or after a chip (never inside one).
  function pointAt(at) {
    let left = at;
    const nodes = ta.childNodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const len = n.nodeType === 3 ? n.data.length : isChip(n) ? n.dataset.skill.length + 1 : 0;
      if (left <= len) return n.nodeType === 3 ? [n, left] : [ta, left === 0 ? i : i + 1];
      left -= len;
    }
    return [ta, nodes.length];
  }
  function placeSelection(anchor, focus = anchor) {
    document.getSelection().setBaseAndExtent(...pointAt(anchor), ...pointAt(focus));
  }
  const skillOf = (name) => state.skills.items.find((s) => s.name === name) || { name };
  function chipFor(name) {
    const chip = skillChip(skillOf(name), labels);
    chip.setAttribute('contenteditable', 'false');
    return chip;
  }
  // Draws parts with the selection from anchor to focus (a caret when they are the same). It only moves when it was
  // in the input: a selection elsewhere, in the email say, stays there, and the input keeps the caret for when it
  // gets the focus.
  function render(parts, anchor, focus = anchor) {
    const sel = document.getSelection();
    const mine = document.activeElement === ta || Boolean(sel && sel.rangeCount && ta.contains(sel.anchorNode));
    const nodes = parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : chipFor(p.name)));
    // A text that ends in a line break needs one more for the empty line after it to show.
    if (endsWithBreak(parts)) nodes[nodes.length - 1].appendData('\n');
    ta.replaceChildren(...nodes);
    const len = partsText(parts).length;
    const clamp = (x) => Math.max(0, Math.min(x, len));
    state.caret = Math.min(clamp(anchor), clamp(focus));
    if (mine) placeSelection(clamp(anchor), clamp(focus));
    ta.classList.toggle('is-empty', !parts.length);
  }
  // parts with each $name of the agent's skills as a chip. typing: one at the very end is still being typed.
  function chipify(parts, typing) {
    const out = [];
    parts.forEach((p, i) => {
      if (typeof p !== 'string') return out.push(p);
      // Text right before a chip does not end there: "$pdf" + a chip is no skill.
      const opts = { typing: typing || i < parts.length - 1, after: i > 0 };
      for (const q of skillParts(p, state.skills.items, opts)) out.push(typeof q === 'string' ? q : { name: q.name });
    });
    return mergedParts(out);
  }
  // parts as the hub will read them: a chip stays one with a word start before it, a space, punctuation or the end
  // after it, and its skill in the agent's list (while a list loads, any). One that no longer reads as its skill,
  // such as $pdf with "x" typed after it, is text again; a $name of the list with a space after it becomes a chip.
  function reconcile(parts) {
    const known = new Set(state.skills.items.map((k) => k.name));
    const kept = parts.map((p, i) => {
      if (typeof p === 'string') return p;
      const before = parts[i - 1];
      const after = parts[i + 1];
      const starts = i === 0 || (typeof before === 'string' && /\s$/.test(before));
      const ends = after === undefined || (typeof after === 'string' && /^[\s,.;!?)]/.test(after));
      return starts && ends && (state.skills.loading || known.has(p.name)) ? p : `$${p.name}`;
    });
    return chipify(mergedParts(kept), true);
  }
  // Focus puts the caret back where it was, as a textarea's does.
  function focusInput() {
    if (document.activeElement === ta) return;
    ta.focus({ preventScroll: true });
    placeSelection(Math.min(state.caret, value().length));
  }

  // ---------- undo ----------

  // Adds what the input holds now as a step. Keys typed in a row, without a pause and from where the last ones
  // ended, are one step: moving the caret starts a new one, as in a textarea.
  function record(type = '') {
    const snap = { parts: current(), caret: caret() };
    const top = history.list[history.at];
    const from = history.from;
    history.from = null;
    if (sameParts(top.parts, snap.parts)) {
      top.caret = snap.caret;
      return;
    }
    const now = Date.now();
    const merge = HISTORY_MERGING.has(type) && type === history.type && from === top.caret && now - history.last < HISTORY_MERGE_MS && history.at > 0;
    history.list.length = history.at + 1;
    if (merge) history.list[history.at] = snap;
    else {
      history.list.push(snap);
      history.at += 1;
      if (history.list.length > HISTORY_MAX) {
        history.list.shift();
        history.at -= 1;
      }
    }
    history.type = type;
    history.last = now;
  }
  function resetHistory() {
    history.list = [{ parts: current(), caret: state.caret }];
    history.at = 0;
    history.type = '';
  }
  // step -1 undoes, 1 redoes.
  function undo(step) {
    const i = history.at + step;
    if (i < 0 || i >= history.list.length) return;
    history.at = i;
    history.type = '';
    const snap = history.list[i];
    // The agent may have changed since: its list decides which chips the step shows.
    render(reconcile(snap.parts), snap.caret);
    state.dismissed = false;
    refreshMenu();
    updateSend();
  }

  // After the user changed the text: a $name of a skill with a space or punctuation after it becomes a chip, a line
  // break the browser added as an element becomes text, and the change is a step to undo.
  function settle(type) {
    const parts = current();
    const next = reconcile(parts);
    const chipped = !sameParts(parts, next);
    if (chipped || !canonical()) {
      const { anchor, focus } = selection();
      render(next, anchor, focus);
    } else ta.classList.toggle('is-empty', !parts.length);
    record(chipped ? 'chip' : type);
  }
  // Puts text in place of the selection, as typing would.
  function insert(text, type) {
    const { start, end } = selection();
    let add = text;
    // A pasted skill at the end becomes a chip at once, as a picked one does (t3code).
    const rest = value().slice(end);
    const last = /(?:^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)$/.exec(add);
    if (type === 'paste' && last && state.skills.items.some((s) => s.name === last[1]) && !/^[\s,.;!?)]/.test(rest)) add += ' ';
    render(reconcile(spliceParts(current(), start, end, add)), start + add.length);
    record(type);
    state.dismissed = false;
    refreshMenu();
    updateSend();
  }
  // The chips follow the agent's list: a name it has becomes one, a chip for one it does not have is text again.
  // The selection stays where it was.
  function restyle() {
    if (composing) return;
    const parts = current();
    const next = reconcile(parts);
    if (sameParts(parts, next)) return;
    const { anchor, focus } = selection();
    render(next, anchor, focus);
    // The step on screen is what the input holds now.
    history.list[history.at] = { parts: next, caret: state.caret };
  }

  function updateSend() {
    send.replaceChildren(icon(state.running ? 'stop' : 'send', 16));
    send.setAttribute('aria-label', state.running ? labels.stop || '' : labels.send || '');
    send.classList.toggle('is-stop', state.running);
    send.disabled = state.running ? false : state.disabled || state.holding || (!value().trim() && !state.attached);
    const why = !state.running && state.holding ? state.holdLabel : '';
    send.title = why;
    if (why) send.setAttribute('aria-description', why);
    else send.removeAttribute('aria-description');
  }
  function refreshFiles() {
    if (attach) attach.hidden = state.disabled;
    files.hidden = !(attach && !attach.hidden) && !contextSlot.childNodes.length && !attachedSlot.childNodes.length;
  }
  function renderAgent() {
    const agent = state.agents.find((a) => a.id === state.agentId) || state.agents[0];
    agentName.textContent = agent ? agent.name : '';
    dot.replaceWith((dot = statusDot(agent ? agent.status : null)));
    agentBtn.hidden = !state.agents.length;
  }

  // A / command or a $ skill: the token must sit at the start of a word, just before the caret. A $ followed by a
  // digit is an amount, not a skill.
  function token() {
    const at = caret();
    const before = value().slice(0, at);
    const m = /(^|\s)([/$])([\w:-]*)$/.exec(before);
    if (!m || (m[2] === '$' && /^[0-9]/.test(m[3]))) return null;
    return { sigil: m[2], query: m[3].toLowerCase(), start: m.index + m[1].length, end: at };
  }
  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
    hl = null;
    state.rows = [];
    state.query = null;
    state.sigil = null;
    state.engaged = false;
  }
  // The skills for what was typed after the $: names that start with it first, then names with a word that does,
  // then names and descriptions that hold it anywhere.
  function skillMatches(query) {
    const items = state.skills.items;
    if (!query) return items.slice(0, SKILL_ROWS_MAX);
    const scored = [];
    for (const k of items) {
      const name = k.name.toLowerCase();
      const score = name.startsWith(query) ? 0 : name.split(/[-_:]/).some((w) => w.startsWith(query)) ? 1 : name.includes(query) ? 2 : String(k.description || '').toLowerCase().includes(query) ? 3 : -1;
      if (score >= 0) scored.push({ k, score });
    }
    return scored
      .sort((a, b) => a.score - b.score || a.k.name.localeCompare(b.k.name))
      .slice(0, SKILL_ROWS_MAX)
      .map((x) => x.k);
  }
  function highlight() {
    if (!hl) return;
    const row = state.rows[state.active];
    if (!row || !state.engaged) {
      hl.style.opacity = '0';
      return;
    }
    hl.style.top = `${row.el.offsetTop}px`;
    hl.style.height = `${row.el.offsetHeight}px`;
    hl.style.opacity = '1';
  }
  function refreshMenu() {
    // While holding no command can start, so none is offered.
    const tok = state.disabled || state.dismissed || state.holding ? null : token();
    if (!tok) {
      closeMenu();
      return;
    }
    const skills = tok.sigil === '$';
    const same = tok.query === state.query && tok.sigil === state.sigil;
    // The row the user is on, so a list that comes in while the menu is open keeps it.
    const was = same && state.rows[state.active] ? state.rows[state.active].cmd.name : null;
    if (!same) {
      state.active = 0;
      state.engaged = false;
    }
    const opened = !menu || tok.sigil !== state.sigil;
    state.query = tok.query;
    state.sigil = tok.sigil;
    const matches = skills
      ? skillMatches(tok.query).map((k) => ({ name: k.name, label: k.description, description: k.description, tag: k.scope, icon: 'skill', skill: true }))
      : state.commands.filter((c) => String(c.name).toLowerCase().startsWith(tok.query));
    const kept = was === null ? -1 : matches.findIndex((m) => m.name === was);
    state.active = kept >= 0 ? kept : Math.min(state.active, Math.max(matches.length - 1, 0));
    if (!menu) {
      menu = h('div', { class: 'bui-pb__menu', role: 'listbox' });
      el.prepend(menu);
    }
    hl = h('span', { class: 'bui-glide__hl', 'aria-hidden': 'true' });
    const list = h('div', { class: 'bui-pb__list' }, hl);
    const sigil = skills ? '$' : '/';
    state.rows = matches.map((cmd, i) => {
      const rowEl = h(
        'button',
        { type: 'button', class: 'bui-pb__cmd', role: 'option', 'aria-selected': String(i === state.active), tabindex: '-1', title: cmd.description || null },
        h('span', { class: 'bui-pb__cmdicon' }, cmd.icon ? icon(cmd.icon, 15) : null),
        h('span', { class: 'bui-pb__cmdname', text: `${sigil}${cmd.name}` }),
        h('span', { class: 'bui-pb__cmddesc', text: cmd.label || cmd.description || '' }),
        cmd.tag ? h('span', { class: 'bui-pb__cmdtag', text: cmd.tag }) : null
      );
      rowEl.addEventListener('mousedown', (e) => e.preventDefault());
      rowEl.addEventListener('mouseenter', () => {
        state.active = i;
        state.engaged = true;
        highlight();
      });
      rowEl.addEventListener('click', () => pick(cmd));
      list.append(rowEl);
      return { el: rowEl, cmd };
    });
    list.addEventListener('mouseleave', () => {
      state.engaged = false;
      highlight();
    });
    const k = state.skills;
    const empty = (text, busy = false) => h('div', { class: 'bui-pb__empty', role: busy ? 'status' : null }, busy ? icon('spinner') : null, h('span', { text: text || '' }));
    let body;
    if (matches.length) body = list;
    else if (skills && k.loading) body = empty(labels.skillsLoading, true);
    else if (skills && k.error) body = empty(k.error);
    else if (skills && !k.items.length) body = empty(labels.noSkills);
    else body = empty(typeof labels.noMatches === 'function' ? labels.noMatches(tok.query) : labels.noMatches || '');
    const heading = skills && k.heading ? h('div', { class: 'bui-pb__heading', text: k.heading }) : null;
    menu.replaceChildren(...(heading ? [heading] : []), body);
    highlight();
    // The owner may refresh the list now (skills are read from disk, or asked of the agent). Last, so the menu that
    // setCommands or setSkills draws from the new list is the one that stays.
    if (opened && !skills && handlers.onSlash) handlers.onSlash();
    if (opened && skills && handlers.onDollar) handlers.onDollar();
  }
  // A skill goes into the text as its chip, with a space after it, for the message the user is writing. The
  // command's token goes only once the owner takes the command: onCommand returns false for one it refuses (a
  // message is still being sent, say), and the token stays where it was, as with submit().
  function pick(cmd) {
    const tok = token();
    closeMenu();
    state.dismissed = false;
    focusInput();
    if (cmd.skill && tok && tok.sigil === '$') {
      const parts = current();
      const spaced = /^\s/.test(partsText(parts).slice(tok.end));
      render(reconcile(spliceParts(parts, tok.start, tok.end, `$${cmd.name}${spaced ? '' : ' '}`)), tok.start + cmd.name.length + 2);
      record('pick');
      updateSend();
      return;
    }
    if (handlers.onCommand && handlers.onCommand(cmd.name) === false) return;
    if (tok) {
      render(spliceParts(current(), tok.start, tok.end, ''), tok.start);
      record('pick');
    }
    updateSend();
  }
  // The text goes only once the owner takes it: onSend returns false for a message it refuses (one is still being
  // sent, say), and the text stays where it was.
  function submit() {
    const text = value().trim();
    if ((!text && !state.attached) || state.disabled || state.holding) return;
    if (handlers.onSend && handlers.onSend(text) === false) return;
    render([], 0);
    resetHistory();
    closeMenu();
    updateSend();
  }

  if (attach) attach.addEventListener('click', () => handlers.onAttach());
  // Pasted files (a screenshot, files copied in Explorer) go along with the message. A paste that has text as well,
  // such as a selection copied from Word, is text: plain text, with a chip for each skill it names.
  ta.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    const pasted = data ? [...data.files] : [];
    const types = data ? [...data.types] : [];
    e.preventDefault();
    if (pasted.length && handlers.onFiles && !state.disabled && !types.includes('text/plain')) {
      handlers.onFiles(pasted.map((file) => ({ file, folder: false })));
      return;
    }
    const text = data ? data.getData('text/plain').replace(/\r\n?/g, '\n') : '';
    if (text) insert(text, 'paste');
  });
  // A copied chip is its $name again.
  function copy(e, cut) {
    const sel = document.getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!r || r.collapsed || !ta.contains(r.commonAncestorContainer)) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', partsText(partsOf(r.cloneContents())));
    if (cut) insert('', 'cut');
  }
  ta.addEventListener('copy', (e) => copy(e, false));
  ta.addEventListener('cut', (e) => copy(e, true));

  ta.addEventListener('compositionstart', () => {
    composing = true;
  });
  ta.addEventListener('compositionend', () => {
    composing = false;
    settle('insertText');
    refreshMenu();
    updateSend();
  });
  ta.addEventListener('input', (e) => {
    state.dismissed = false;
    if (!composing && !e.isComposing) settle(e.inputType);
    refreshMenu();
    updateSend();
  });
  ta.addEventListener('beforeinput', (e) => {
    // Undo from the context menu.
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      undo(e.inputType === 'historyUndo' ? -1 : 1);
      return;
    }
    const { start, end } = selection();
    history.from = start === end ? start : null;
  });
  ta.addEventListener('blur', () => {
    caret();
    closeMenu();
  });
  ta.addEventListener('click', () => refreshMenu());
  ta.addEventListener('keydown', (e) => {
    // While an IME composes (Japanese, Chinese), Enter, Tab, the arrows and Escape are its keys: they must not
    // pick a command or send.
    if (e.isComposing || e.keyCode === 229) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'z' || key === 'y')) {
      e.preventDefault();
      undo(key === 'y' || e.shiftKey ? 1 : -1);
      return;
    }
    if (menu && state.rows.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = state.rows.length;
        state.active = (state.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        state.engaged = true;
        state.rows.forEach((r, i) => r.el.setAttribute('aria-selected', String(i === state.active)));
        state.rows[state.active].el.scrollIntoView({ block: 'nearest' });
        highlight();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(state.rows[state.active].cmd);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (menu) {
        e.preventDefault();
        e.stopPropagation();
        state.dismissed = true;
        closeMenu();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!state.running) submit();
    }
  });
  send.addEventListener('click', () => {
    if (state.running) {
      if (handlers.onStop) handlers.onStop();
    } else submit();
  });
  agentBtn.addEventListener('click', () => {
    if (agentBtn.getAttribute('aria-expanded') === 'true') {
      if (openMenu) openMenu.close();
      return;
    }
    glideMenu({
      anchor: agentBtn,
      align: 'left',
      items: state.agents.map((a) => ({ id: a.id, label: a.name, tag: a.tag, status: a.status, checked: a.id === state.agentId })),
      onPick: (id) => {
        focusInput();
        if (handlers.onAgent) handlers.onAgent(id);
      }
    });
  });
  // again: the items changed while the menu is open (a list came in), so it is drawn anew in place.
  function openPicker(kind, again = false) {
    const p = pickers[kind];
    if (!again && p.btn.getAttribute('aria-expanded') === 'true') {
      if (openMenu) openMenu.close();
      return;
    }
    const items = p.items();
    p.shown = JSON.stringify(items);
    p.menu = glideMenu({
      anchor: p.btn,
      align: 'left',
      items,
      onPick: (id) => {
        focusInput();
        if (handlers.onPick) handlers.onPick(kind, id);
      }
    });
  }

  const api = {
    el,
    focus() {
      focusInput();
    },
    // A text set here starts the undo list, as a textarea's value does. A skill it names, also at the very end, is
    // a chip.
    setValue(text) {
      const s = String(text ?? '');
      render(chipify(s ? [s] : [], false), s.length);
      resetHistory();
      updateSend();
    },
    getValue() {
      return value();
    },
    setRunning(running) {
      state.running = Boolean(running);
      updateSend();
    },
    // holding: something the message takes is still on its way. label: why Send is off, for its tooltip and screen
    // readers. Once it is there, a / the caret sits after offers its commands again.
    setHolding(holding, label = '') {
      const was = state.holding;
      state.holding = Boolean(holding);
      state.holdLabel = String(label || '');
      el.classList.toggle('is-holding', state.holding);
      if (state.holding) closeMenu();
      else if (was && document.activeElement === ta) refreshMenu();
      updateSend();
    },
    setDisabled(disabled, reason) {
      state.disabled = Boolean(disabled);
      el.classList.toggle('is-disabled', state.disabled);
      ta.hidden = state.disabled;
      disabledRow.hidden = !state.disabled;
      disabledRow.replaceChildren();
      if (state.disabled && reason != null) disabledRow.append(reason instanceof Node ? reason : String(reason));
      if (state.disabled) closeMenu();
      refreshFiles();
      updateSend();
    },
    setAgents(list, currentId) {
      state.agents = Array.isArray(list) ? list : [];
      if (currentId !== undefined) state.agentId = currentId;
      renderAgent();
    },
    // kind: 'model' or 'effort'. text is what the button shows (empty: only its icon), label its accessible name,
    // items a function that returns glideMenu items. hidden takes the button away. meter: the effort dial's level
    // (0 to 1, null for none).
    setPicker(kind, { text = '', label = '', items, hidden = false, meter = null } = {}) {
      const p = pickers[kind];
      if (!p) return;
      if (p.lead && meter !== p.meter) {
        const next = gauge(meter);
        p.lead.replaceWith(next);
        p.lead = next;
        p.meter = meter;
      }
      p.text.textContent = text;
      p.text.hidden = !text;
      p.btn.setAttribute('aria-label', label);
      p.btn.title = label;
      p.btn.hidden = Boolean(hidden);
      if (typeof items === 'function') p.items = items;
      // An open menu is drawn again only when its items changed, so the row in focus stays put otherwise.
      const open = p.menu && openMenu === p.menu;
      if (open && p.btn.hidden) openMenu.close();
      else if (open && JSON.stringify(p.items()) !== p.shown) openPicker(kind, true);
    },
    setContext(chip) {
      contextSlot.replaceChildren();
      if (chip) {
        const remove = chip.querySelector ? chip.querySelector('.bui-entity__x') : null;
        if (remove && labels.removeContext && !remove.getAttribute('aria-label')) remove.setAttribute('aria-label', labels.removeContext);
        contextSlot.append(chip);
      }
      refreshFiles();
    },
    // Chips for the files and emails the user attached to the message being written.
    setAttachments(chips) {
      const list = Array.isArray(chips) ? chips.filter(Boolean) : [];
      // The focus was on a chip's x that is gone now: the input takes it, not the page.
      const lost = attachedSlot.contains(document.activeElement);
      attachedSlot.replaceChildren(...list);
      state.attached = list.length > 0;
      refreshFiles();
      updateSend();
      if (lost && !attachedSlot.contains(document.activeElement)) focusInput();
    },
    setCommands(list) {
      state.commands = Array.isArray(list) ? list : [];
      if (menu && state.sigil === '/') refreshMenu();
    },
    // The agent's own skills for the $ menu: items [{name, description, scope}], loading while they are on their way,
    // error why there are none, heading the line above the list.
    setSkills({ items = [], loading = false, error = '', heading = '' } = {}) {
      state.skills = { items: Array.isArray(items) ? items : [], loading: Boolean(loading), error: String(error || ''), heading: String(heading || '') };
      restyle();
      if (menu && state.sigil === '$') refreshMenu();
    },
    setPlaceholder(text) {
      ta.dataset.placeholder = String(text ?? '');
      if (text) ta.setAttribute('aria-placeholder', String(text));
      else ta.removeAttribute('aria-placeholder');
    }
  };
  renderAgent();
  api.setContext(opts.context || null);
  updateSend();
  return api;
}
