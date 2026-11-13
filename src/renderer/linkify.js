// Finding web addresses in text, for the links the editor makes while you paste or type (editor-links.js).
// No DOM in here, so node can test it (test/linkify.test.js).

// An address starts with https://, http:// or www., not in the middle of a word or of another address, and runs to
// the next space, angle bracket or double quote.
const CANDIDATE = /(?<![\p{L}\p{N}@._/+=-])(?:https?:\/\/|www\.)[^\s<>"“”«»]+/giu;
// Punctuation that ends a sentence rather than an address.
const TRAILING = '.,;:!?\'"’‘”';
const CLOSERS = { ')': '(', ']': '[' };

const count = (s, ch) => s.split(ch).length - 1;

// The address without the punctuation after it: "(see www.example.com)." keeps www.example.com, while a closing
// bracket that has its opening one in the address stays.
function trimUrl(text) {
  let s = text;
  for (;;) {
    const last = s.slice(-1);
    if (!last) return s;
    if (TRAILING.includes(last)) s = s.slice(0, -1);
    else if (CLOSERS[last] && count(s, last) > count(s, CLOSERS[last])) s = s.slice(0, -1);
    else return s;
  }
}

const hasHost = (text) => (/^www\./i.test(text) ? /^www\.[\p{L}\p{N}-]+\.[\p{L}\p{N}]/iu.test(text) : /^https?:\/\/[\p{L}\p{N}\[]/iu.test(text));

// The address a link to text gets: www.example.com opens over https.
const hrefFor = (text) => (/^www\./i.test(text) ? `https://${text}` : text);

// The addresses in text, in order: [{ start, end, text, href }].
export function findUrls(text) {
  const found = [];
  for (const m of String(text || '').matchAll(CANDIDATE)) {
    const url = trimUrl(m[0]);
    if (hasHost(url)) found.push({ start: m.index, end: m.index + url.length, text: url, href: hrefFor(url) });
  }
  return found;
}

// The link address when text is one address and nothing else, as a clipboard holds after Copy link.
export function soleUrl(text) {
  const s = String(text || '').trim();
  const [url, ...more] = findUrls(s);
  return url && !more.length && url.start === 0 && url.end === s.length ? url.href : null;
}

// The address typed last in before, the text in front of the caret, once a space, Enter or Tab ends it:
// { start, end, text, href } within before, or null. Punctuation between the address and the caret stays outside.
export function typedUrl(before) {
  const word = /\S+$/.exec(String(before || ''));
  if (!word) return null;
  const url = findUrls(word[0]).pop();
  if (!url || trimUrl(word[0].slice(url.start)) !== url.text) return null;
  return { ...url, start: word.index + url.start, end: word.index + url.end };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A line of plain text as HTML that shows the same spaces: Chromium's paste keeps a run of spaces, a space at either
// end of a line and a tab this way too.
const lineText = (s) =>
  esc(s)
    .replace(/\t/g, '<span style="white-space:pre">\t</span>')
    .replace(/ {2,}/g, (run) => `${'&nbsp;'.repeat(run.length - 1)} `);

function lineHtml(line) {
  let html = '';
  let at = 0;
  for (const url of findUrls(line)) {
    html += `${lineText(line.slice(at, url.start))}<a href="${esc(url.href)}">${esc(url.text)}</a>`;
    at = url.end;
  }
  return html + lineText(line.slice(at));
}

// Pasted plain text with its addresses as links, or null when it has none: one line as it is, several lines as the
// blocks Chromium's own paste makes. block: the tag of those blocks, 'li' inside a list.
export function linkedHtml(text, block = 'div') {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  if (!findUrls(s).length) return null;
  const lines = s.split('\n');
  if (lines.length === 1) return lineHtml(s);
  // A space that starts a block would not show.
  return lines.map((line) => `<${block}>${line ? lineHtml(line).replace(/^ /, '&nbsp;') : '<br>'}</${block}>`).join('');
}

// What the Link field of the link popover means: an address with its scheme stays, an email address becomes a
// mailto: link and anything else opens over https.
export function linkHref(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^(https?:|mailto:)/i.test(s)) return s;
  return /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(s) ? `mailto:${s}` : `https://${s}`;
}

// A long address with its middle left out, so both the site and the end of the path stay readable.
export function shortenUrl(url, max = 44) {
  const s = String(url || '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.62);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}
