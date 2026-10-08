'use strict';

// Turns an agent's draft body into the HTML structure Rukoo's composer uses: one <div> per line,
// <div><br></div> for an empty line. The renderer sanitizes the result again before it touches the editor.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const EMPTY = '<div><br></div>';

function clean(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    // Control characters (except tab and newline) have no place in a draft and would collide with placeholders.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function line(html) {
  return html ? `<div>${html}</div>` : EMPTY;
}

function textToHtml(text) {
  const lines = clean(text).replace(/^\n+|\n+$/g, '').split('\n');
  return lines.map((l) => line(esc(l))).join('');
}

// Inline markdown: code spans, links, bare URLs, bold, italic. Everything else is escaped.
function inline(src) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src;
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, label, url) =>
    SAFE_HREF.test(url) ? keep(`<a href="${esc(url)}">${inlineText(label)}</a>`) : keep(inlineText(label))
  );
  s = s.replace(/\b(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]])/g, (url) => keep(`<a href="${esc(url)}">${esc(url)}</a>`));
  s = s.replace(/\bmailto:[^\s<>()]+[^\s<>().,;:!?'"\]]/g, (url) => keep(`<a href="${esc(url)}">${esc(url.slice(7))}</a>`));
  return emphasis(esc(s)).replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

// Link labels may carry emphasis but no further links.
function inlineText(src) {
  return emphasis(esc(src));
}

function emphasis(html) {
  return html
    .replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w])__(?=\S)([^_]+?)(?<=\S)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1<i>$2</i>')
    // Underscores only count at word edges, so snake_case and file_names stay as they are.
    .replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<i>$2</i>');
}

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}```/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

function markdownToHtml(text) {
  const lines = clean(text).replace(/^\n+|\n+$/g, '').split('\n');
  const out = [];
  let blank = false;
  const block = (html) => {
    if (blank && out.length) out.push(EMPTY);
    blank = false;
    out.push(html);
  };
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (!l.trim()) {
      blank = true;
      i++;
      continue;
    }
    if (FENCE.test(l)) {
      const body = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      i++;
      block(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (RULE.test(l)) {
      block('<hr>');
      i++;
      continue;
    }
    const list = BULLET.test(l) ? BULLET : ORDERED.test(l) ? ORDERED : null;
    if (list) {
      const items = [];
      for (; i < lines.length && list.test(lines[i]); i++) items.push(`<li>${inline(list.exec(lines[i])[1])}</li>`);
      const tag = list === BULLET ? 'ul' : 'ol';
      block(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    if (QUOTE.test(l)) {
      const quoted = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(QUOTE.exec(lines[i])[1]);
      block(`<blockquote>${quoted.map((q) => line(inline(q))).join('')}</blockquote>`);
      continue;
    }
    const heading = HEADING.exec(l);
    // Headings read as shouting in an email; a bold line keeps the structure without the size.
    block(line(heading ? `<b>${inline(heading[1])}</b>` : inline(l)));
    i++;
  }
  return out.join('');
}

function toHtml(text, format = 'markdown') {
  if (format === 'html') return String(text == null ? '' : text);
  if (format === 'text') return textToHtml(text);
  return markdownToHtml(text);
}

module.exports = { toHtml, textToHtml, markdownToHtml, escapeHtml: esc };
