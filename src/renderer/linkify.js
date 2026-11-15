// Finding web addresses in text, for the links the editor makes while you paste or type (editor-links.js).
// No DOM in here, so node can test it (test/linkify.test.js).

// An address starts with https://, http:// or www., not in the middle of a word or of another address, and runs to
// the next space, angle bracket or double quote.
const CANDIDATE = /(?<![\p{L}\p{N}@._/+=-])(?:https?:\/\/|www\.)[^\s<>"“”«»]+/giu;
// Punctuation that ends a sentence rather than an address.
const TRAILING = '.,;:!?\'"’‘”';
const CLOSERS = { ')': '(', ']': '[' };

// The address without the punctuation after it: "(see www.example.com)." keeps www.example.com, while a closing
// bracket that has its opening one in the address stays. The brackets are counted once, so a long run of them after
// an address takes no longer than any other text.
function trimUrl(text) {
  const n = { '(': 0, ')': 0, '[': 0, ']': 0 };
  for (let i = 0; i < text.length; i++) if (text[i] in n) n[text[i]]++;
  let end = text.length;
  while (end > 0) {
    const last = text[end - 1];
    if (TRAILING.includes(last)) end--;
    else if (CLOSERS[last] && n[last] > n[CLOSERS[last]]) {
      n[last]--;
      end--;
    } else break;
  }
  return text.slice(0, end);
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
  const s = String(before || '');
  // The last word, found from the end: a pattern such as /\S+$/ would try every start inside a long word.
  let start = s.length;
  while (start > 0 && !/\s/.test(s[start - 1])) start--;
  // Nothing typed since the last space.
  if (start === s.length) return null;
  const word = s.slice(start);
  const url = findUrls(word).pop();
  if (!url || trimUrl(word.slice(url.start)) !== url.text) return null;
  return { ...url, start: start + url.start, end: start + url.end };
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
  // An email address: one @, no space or slash, and a dot with something on both sides after the @. Two simple
  // tests, because one pattern for it backtracks over every dot and stalls on a long input.
  const email = /^[^\s@/]+@[^\s@/]+$/.test(s) && /.\../.test(s.slice(s.indexOf('@') + 1));
  return email ? `mailto:${s}` : `https://${s}`;
}

// A long address with its middle left out, so both the site and the end of the path stay readable.
export function shortenUrl(url, max = 44) {
  const s = String(url || '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.62);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}
