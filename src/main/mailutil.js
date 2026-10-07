'use strict';

const libqp = require('libqp');
const iconv = require('iconv-lite');
const { convert } = require('html-to-text');

const ROLE_NAMES = {
  inbox: 'Postvak IN',
  sent: 'Verzonden',
  drafts: 'Concepten',
  trash: 'Prullenbak',
  junk: 'Spam',
  archive: 'Archief'
};

const SPECIAL_USE = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
  '\\Important': 'important'
};

// Fallback for servers without SPECIAL-USE: match common names in English and Dutch.
const NAME_ROLES = [
  [/^(inbox|postvak in)$/i, 'inbox'],
  [/^(sent|sent items|sent mail|sent messages|verzonden|verzonden items)$/i, 'sent'],
  [/^(drafts|draft|concepten)$/i, 'drafts'],
  [/^(trash|deleted|deleted items|deleted messages|bin|prullenbak|verwijderde items)$/i, 'trash'],
  [/^(junk|spam|junk e-mail|junk email|bulk mail|ongewenste e-mail)$/i, 'junk'],
  [/^(archive|archives|archief)$/i, 'archive']
];

function folderRole(folder) {
  if (folder.path && folder.path.toUpperCase() === 'INBOX') return 'inbox';
  if (folder.specialUse && SPECIAL_USE[folder.specialUse]) return SPECIAL_USE[folder.specialUse];
  for (const flag of folder.flags || []) {
    if (SPECIAL_USE[flag]) return SPECIAL_USE[flag];
  }
  const leaf = String(folder.name || folder.path || '').trim();
  for (const [re, role] of NAME_ROLES) {
    if (re.test(leaf)) return role;
  }
  return null;
}

function displayFolderName(folder) {
  if (folder.role && ROLE_NAMES[folder.role]) return ROLE_NAMES[folder.role];
  return folder.name || folder.path;
}

// Walks an imapflow bodyStructure tree depth-first.
function walkStructure(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.childNodes || []) walkStructure(child, visit);
}

function partKey(node) {
  // Single-part messages have no part number; IMAP addresses their body as part 1.
  return node.part || '1';
}

function isAttachmentNode(node) {
  const type = String(node.type || '').toLowerCase();
  if (type.startsWith('multipart/')) return false;
  if (node.disposition === 'attachment') return true;
  if (type === 'message/rfc822') return true;
  if (type.startsWith('text/') && node.disposition !== 'attachment') return false;
  // Inline images referenced by cid are part of the body, not attachments.
  if (node.disposition === 'inline' && node.id) return false;
  return Boolean(node.dispositionParameters?.filename || node.parameters?.name);
}

function findPreviewPart(structure) {
  let plain = null;
  let html = null;
  walkStructure(structure, (node) => {
    if (isAttachmentNode(node)) return;
    const type = String(node.type || '').toLowerCase();
    if (type === 'text/plain' && !plain) plain = node;
    if (type === 'text/html' && !html) html = node;
  });
  return plain || html;
}

function hasAttachments(structure) {
  let found = false;
  walkStructure(structure, (node) => {
    if (isAttachmentNode(node)) found = true;
  });
  return found;
}

function decodeTransfer(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') {
    // Partial fetches can cut a base64 group in half; drop the incomplete tail.
    const clean = buffer.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
  }
  if (enc === 'quoted-printable') return libqp.decode(buffer.toString('latin1'));
  return buffer;
}

function decodeCharset(buffer, charset) {
  const cs = String(charset || 'utf-8').toLowerCase();
  try {
    if (iconv.encodingExists(cs)) return iconv.decode(buffer, cs);
  } catch (_) {
    // Unknown charset: fall through to utf-8.
  }
  return buffer.toString('utf8');
}

function htmlToPlain(html) {
  try {
    return convertHtml(html);
  } catch (_) {
    // A preview is never worth failing a sync over; fall back to stripping tags.
    return String(html || '')
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ');
  }
}

function convertHtml(html) {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'head', format: 'skip' },
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h) => ({ selector: h, options: { uppercase: false } })),
      { selector: 'table', format: 'block' }
    ]
  });
}

function makePreview(text, max = 200) {
  return String(text || '')
    .replace(/ |‌|​|͏|﻿/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function previewFromPart(buffer, node) {
  if (!buffer || !node) return '';
  const decoded = decodeCharset(decodeTransfer(buffer, node.encoding), node.parameters?.charset);
  const type = String(node.type || '').toLowerCase();
  // Truncated HTML may end mid-tag; html-to-text tolerates that.
  const text = type === 'text/html' ? htmlToPlain(decoded) : decoded;
  return makePreview(text);
}

function addressFromEnvelope(list) {
  return (list || []).map((a) => ({ name: a.name || '', address: a.address || '' }));
}

function addressFromParsed(field) {
  if (!field) return [];
  const values = Array.isArray(field) ? field.flatMap((f) => f.value || []) : field.value || [];
  const out = [];
  for (const v of values) {
    if (v.group) out.push(...v.group.map((g) => ({ name: g.name || '', address: g.address || '' })));
    else out.push({ name: v.name || '', address: v.address || '' });
  }
  return out;
}

// Removes active content from email HTML before it is shown in the sandboxed reader frame.
function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<\/?(iframe|object|embed|frame|frameset|applet|form|base)\b[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToHtml(text) {
  const linked = escapeHtml(text).replace(
    /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g,
    '<a href="$1">$1</a>'
  );
  return `<div style="white-space:pre-wrap;word-wrap:break-word">${linked}</div>`;
}

// The List-Unsubscribe header (RFC 2369), with one-click support (RFC 8058) for https links.
function unsubscribeInfo(parsed) {
  const list = parsed && parsed.headers && parsed.headers.get('list');
  const u = list && list.unsubscribe;
  if (!u) return null;
  const url = u.url && /^https?:\/\//i.test(u.url) ? u.url : null;
  const mail = u.mail ? `mailto:${u.mail}` : null;
  const post = list['unsubscribe-post'];
  const oneClick = Boolean(url && /^https:/i.test(url) && post && /one-click/i.test(post.name || ''));
  return url || mail ? { url, mail, oneClick } : null;
}

module.exports = {
  ROLE_NAMES,
  unsubscribeInfo,
  folderRole,
  displayFolderName,
  walkStructure,
  partKey,
  isAttachmentNode,
  findPreviewPart,
  hasAttachments,
  decodeTransfer,
  decodeCharset,
  htmlToPlain,
  makePreview,
  previewFromPart,
  addressFromEnvelope,
  addressFromParsed,
  sanitizeHtml,
  escapeHtml,
  textToHtml
};
