// Agent-written mail goes into the editor of this very document, so it is reduced to plain
// formatting first. Email content reaches agents from strangers and can steer what they write:
// no controls (the composer acts on buttons and fields with its own data attributes), no images
// (a remote image would load here and again at the recipient, leaking whatever its URL carries),
// no styles, classes or ids, and links only to the web or to an address.

const KEEP = new Set(['DIV', 'P', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR', 'H1', 'H2', 'H3']);
// Removed together with everything inside them.
const DROP =
  'script, style, svg, math, iframe, frame, frameset, object, embed, applet, form, button, input, select, option, optgroup, datalist, textarea, template, noscript, link, meta, base, title, video, audio, source, track, picture, img, canvas, map, area';
const SAFE_HREF = /^(https?:|mailto:)/i;
const MAX_INPUT = 200000;

export function sanitizeAgentHtml(html) {
  // An inert document: nothing in it loads or runs while it is cleaned.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${String(html ?? '').slice(0, MAX_INPUT)}</body>`, 'text/html');
  const body = doc.body;
  body.querySelectorAll(DROP).forEach((n) => n.remove());
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((n) => n.remove());
  // Deepest first, so an unwrapped element's children are already clean.
  for (const el of [...body.querySelectorAll('*')].reverse()) {
    const href = el.tagName === 'A' ? String(el.getAttribute('href') || '').trim() : '';
    if (!KEEP.has(el.tagName) || (el.tagName === 'A' && !SAFE_HREF.test(href))) {
      el.replaceWith(...el.childNodes);
      continue;
    }
    for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
    if (href) el.setAttribute('href', href);
  }
  return body.innerHTML;
}

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Plain text in the editor's own structure: a <div> per line, <div><br></div> for an empty one.
export function textToEditorHtml(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line ? `<div>${escapeText(line)}</div>` : '<div><br></div>'))
    .join('');
}
