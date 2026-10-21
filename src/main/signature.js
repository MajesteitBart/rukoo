'use strict';

// Signatures are stored as HTML: pasted from another mail app or a web page, or written in Settings. They go into
// every mail the user sends, so they are reduced here to static formatting: text, links, tables, inline styles and
// images. Nothing that runs, loads a page or submits anything, and no app class names the composer acts on.
// The result is rebuilt from scratch, so only what is listed here can come out.

const { parseDocument } = require('htmlparser2');
const { t } = require('../i18n');
const util = require('./mailutil');

// Removed together with everything inside them.
const DROP = new Set([
  'script', 'style', 'head', 'title', 'meta', 'link', 'base', 'template', 'noscript', 'xmp', 'plaintext', 'noembed', 'noframes',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'form', 'input', 'button', 'select', 'option',
  'optgroup', 'datalist', 'textarea', 'output', 'svg', 'math', 'video', 'audio', 'source', 'track', 'picture', 'canvas',
  'map', 'area', 'dialog', 'slot'
]);
// Kept with the attributes listed for them; any other element is replaced by its content.
const COMMON = ['style', 'title', 'dir', 'align'];
const CELL = ['width', 'height', 'colspan', 'rowspan', 'valign', 'bgcolor', 'nowrap'];
const KEEP = {
  div: [], p: [], br: [], span: [], b: [], strong: [], i: [], em: [], u: [], s: [], strike: [], small: [], big: [],
  sub: [], sup: [], code: [], pre: [], blockquote: [], hr: ['width', 'size', 'color', 'noshade'], center: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: ['type'], ol: ['type', 'start'], li: [],
  font: ['color', 'face', 'size'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height', 'border', 'hspace', 'vspace'],
  table: ['width', 'border', 'cellpadding', 'cellspacing', 'bgcolor'],
  caption: [], thead: [], tbody: [], tfoot: [], colgroup: ['span', 'width'], col: ['span', 'width'],
  tr: ['valign', 'bgcolor', 'height'], td: CELL, th: CELL
};
const VOID = new Set(['br', 'hr', 'img', 'col']);
const SAFE_HREF = /^(https?:|mailto:|tel:)/i;
// Raster images only: inline data, which is sent as an inline attachment, or a picture on the web.
const SAFE_SRC = /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$)/i;
// Presentational attribute values: sizes, colors, alignment and font names.
const SAFE_VALUE = /^[\w\s#%.,'"-]{0,100}$/;
const STYLE_PROPS =
  /^(color|background|background-color|font|font-(family|size|style|weight|variant)|text-(align|decoration|transform|indent)|line-height|letter-spacing|word-spacing|white-space|vertical-align|(margin|padding)(-(top|right|bottom|left))?|border(-(top|right|bottom|left))?(-(width|style|color))?|border-(collapse|spacing|radius)|(min-|max-)?(width|height)|display|list-style(-type)?|direction|overflow|float|clear)$/;
// Anything that could load or run something, or escape the declaration.
const UNSAFE_STYLE = /url\s*\(|image-set|expression|javascript:|behavior|binding|@import|[<>\\{}]/i;
const MAX_INPUT = 5 * 1024 * 1024;
// Mostly inline images; the signature goes into every mail and into settings.json.
const MAX_HTML = 1024 * 1024;
const MAX_DEPTH = 100;

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

function cleanStyle(style) {
  const out = [];
  for (const decl of String(style).split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const value = decl.slice(at + 1).trim();
    if (!STYLE_PROPS.test(prop) || !value || value.length > 200 || UNSAFE_STYLE.test(value)) continue;
    // A pasted signature must not cover the composer or slip out of its place.
    if (prop === 'display' && !/^(block|inline|inline-block|table|table-row|table-cell|none)$/i.test(value)) continue;
    out.push(`${prop}:${value}`);
  }
  return out.join(';');
}

function cleanAttrs(name, attribs) {
  const allowed = new Set([...COMMON, ...KEEP[name]]);
  const out = [];
  for (const [rawKey, rawValue] of Object.entries(attribs || {})) {
    const key = rawKey.toLowerCase();
    if (!allowed.has(key)) continue;
    let value = String(rawValue).trim();
    if (key === 'style') value = cleanStyle(value);
    else if (key === 'href') {
      if (!SAFE_HREF.test(value)) continue;
    } else if (key === 'src') {
      if (!SAFE_SRC.test(value)) continue;
    } else if (key === 'alt' || key === 'title') value = value.slice(0, 300);
    else if (!SAFE_VALUE.test(value)) continue;
    if (key === 'style' && !value) continue;
    out.push(` ${key}="${escapeAttr(value)}"`);
  }
  return out.join('');
}

function serialize(nodes, depth) {
  let html = '';
  for (const node of nodes || []) {
    if (node.type === 'text') {
      html += escapeText(node.data);
      continue;
    }
    // Comments (Outlook's conditional ones among them), directives and CDATA go.
    if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') continue;
    const name = String(node.name || '').toLowerCase();
    if (DROP.has(name) || depth > MAX_DEPTH) continue;
    if (!Object.prototype.hasOwnProperty.call(KEEP, name)) {
      html += serialize(node.children, depth + 1);
      continue;
    }
    // A link or image whose address is not allowed keeps only its text.
    if (name === 'a' && !SAFE_HREF.test(String((node.attribs && node.attribs.href) || '').trim())) {
      html += serialize(node.children, depth + 1);
      continue;
    }
    if (name === 'img' && !SAFE_SRC.test(String((node.attribs && node.attribs.src) || '').trim())) continue;
    html += `<${name}${cleanAttrs(name, node.attribs)}>`;
    if (VOID.has(name)) continue;
    html += `${serialize(node.children, depth + 1)}</${name}>`;
  }
  return html;
}

// The signature as safe HTML; '' for nothing. Throws when the result is too large to put under every mail.
function cleanSignatureHtml(html) {
  const source = String(html ?? '');
  if (source.length > MAX_INPUT) throw new Error(t('settings.signature.tooLarge'));
  const doc = parseDocument(source, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  const clean = serialize(doc.children, 0).trim();
  if (clean.length > MAX_HTML) throw new Error(t('settings.signature.tooLarge'));
  // Only whitespace and empty elements: no signature.
  return signatureText(clean) || /<img\b/.test(clean) ? clean : '';
}

// The readable text of a signature: for the plain-text part, and for older versions that only know text.
function signatureText(html) {
  return util
    .htmlToPlain(String(html || ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { cleanSignatureHtml, signatureText };
