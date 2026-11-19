// The text of a team chat message and its mentions, between the composer and the wire. No DOM and no window.mail,
// so the node tests can load it (test/chat-text.test.js).
//
// A mention is { actor, start, end } in UTF-8 byte offsets of the exact text: that is the form on the wire, in the
// cache and across IPC. Only the editor works in UTF-16, so the conversions live here: toWire() for what the
// composer sends, toParts() for a saved draft going back into it, and segments() for showing a message.

import { findUrls } from './linkify.js';

// The server's limits: 1 to 16,384 bytes of UTF-8 after trimming, and at most 32 mentions.
export const TEXT_LIMIT = 16384;
export const MENTION_LIMIT = 32;

// A member ID: u_ and 22 base64url characters.
const MEMBER_ID = /^u_[A-Za-z0-9_-]{22}$/;

// The UTF-8 length of a UTF-16 code unit at i of s, and how many code units it takes: a surrogate pair is one
// 4-byte character, and a lone surrogate goes out as U+FFFD, 3 bytes.
function unitAt(s, i) {
  const c = s.charCodeAt(i);
  if (c < 0x80) return [1, 1];
  if (c < 0x800) return [2, 1];
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return [4, 2];
  }
  return [3, 1];
}

// The number of bytes text takes in UTF-8.
export function byteLength(text) {
  const s = String(text ?? '');
  let bytes = 0;
  for (let i = 0; i < s.length; ) {
    const [n, units] = unitAt(s, i);
    bytes += n;
    i += units;
  }
  return bytes;
}

// The UTF-16 index of every byte offset that falls between two characters of text, the end included.
function boundaries(text) {
  const at = new Map([[0, 0]]);
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const [n, units] = unitAt(text, i);
    bytes += n;
    i += units;
    at.set(bytes, i);
  }
  return at;
}

// A lone surrogate can't go out as UTF-8; the wire would carry U+FFFD in its place, so the text does too and the
// byte counts match what the server receives.
const wellFormed = (s) => (typeof s.toWellFormed === 'function' ? s.toWellFormed() : s);

// What the editor typed, as the wire wants it: a no-break space (which contenteditable inserts for a typed space)
// becomes a space, and CRLF or a lone CR becomes LF.
const normalize = (s) => wellFormed(String(s)).replace(/ /g, ' ').replace(/\r\n?/g, '\n');

// Adjacent strings merged and empty ones dropped, then white space trimmed from the start of the first part and the
// end of the last when those are text. A chip is never trimmed: its label is the mention.
function trimParts(parts) {
  const list = [];
  for (const p of parts) {
    if (typeof p === 'string') {
      if (!p) continue;
      if (typeof list[list.length - 1] === 'string') list[list.length - 1] += p;
      else list.push(p);
    } else if (p && typeof p.label === 'string' && p.label) list.push(p);
  }
  if (typeof list[0] === 'string') {
    list[0] = list[0].trimStart();
    if (!list[0]) list.shift();
  }
  const last = list.length - 1;
  if (typeof list[last] === 'string') {
    list[last] = list[last].trimEnd();
    if (!list[last]) list.pop();
  }
  return list;
}

// parts: the composer's content, strings and chips { member, label } in order. Returns { text, mentions, bytes }:
// the exact text, its mentions as UTF-8 byte ranges, and its length in bytes. Every chip is a whole string, so each
// range starts and ends between characters, the ranges come in order and they never overlap. The @ is part of the
// range. bytes says whether the text fits TEXT_LIMIT; mentions.length whether it fits MENTION_LIMIT.
export function toWire(parts) {
  const list = trimParts((parts || []).map((p) => (typeof p === 'string' ? normalize(p) : p && { member: p.member, label: wellFormed(String(p.label ?? '')) })));
  let text = '';
  let bytes = 0;
  const mentions = [];
  for (const p of list) {
    const s = typeof p === 'string' ? p : p.label;
    const n = byteLength(s);
    if (typeof p !== 'string') mentions.push({ actor: p.member, start: bytes, end: bytes + n });
    text += s;
    bytes += n;
  }
  return { text, mentions, bytes };
}

// Whether a wire form can be sent: some text, within the byte limit and the mention limit. Returns null when it
// can, else 'empty', 'tooLong' or 'tooManyMentions'.
export function sendProblem(wire) {
  if (!wire || !wire.text) return 'empty';
  if (wire.bytes > TEXT_LIMIT) return 'tooLong';
  if (wire.mentions.length > MENTION_LIMIT) return 'tooManyMentions';
  return null;
}

// The mentions of text that hold, each with its UTF-16 range: { actor, start, end, from, to }, where start and end
// are the byte offsets and from and to the UTF-16 indexes. A range is dropped when it starts or ends inside a
// character or past the end, is empty, starts before the previous kept one ends, names no member, or comes after
// the 32nd. A text over TEXT_LIMIT keeps none: the server never accepts one, so its ranges mean nothing.
export function validMentions(text, mentions) {
  const s = typeof text === 'string' ? text : '';
  if (!s || !Array.isArray(mentions) || !mentions.length) return [];
  if (byteLength(s) > TEXT_LIMIT) return [];
  const at = boundaries(s);
  const kept = [];
  let prevEnd = 0;
  for (const m of mentions) {
    if (kept.length >= MENTION_LIMIT) break;
    if (!m || typeof m.actor !== 'string' || !MEMBER_ID.test(m.actor)) continue;
    const { start, end } = m;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || start < prevEnd) continue;
    if (!at.has(start) || !at.has(end)) continue;
    kept.push({ actor: m.actor, start, end, from: at.get(start), to: at.get(end) });
    prevEnd = end;
  }
  return kept;
}

// A saved draft or a message back as the composer's parts: strings and locked chips { member, label }, where the
// label is the text the chip covers. Ranges that don't hold come back as plain text.
export function toParts(text, mentions) {
  const s = typeof text === 'string' ? text : '';
  const parts = [];
  let i = 0;
  for (const m of validMentions(s, mentions)) {
    if (m.from > i) parts.push(s.slice(i, m.from));
    parts.push({ member: m.actor, label: s.slice(m.from, m.to) });
    i = m.to;
  }
  if (i < s.length) parts.push(s.slice(i));
  return parts;
}

// Plain text with its web addresses as link segments.
function withLinks(s, out) {
  let i = 0;
  for (const url of findUrls(s)) {
    if (url.start > i) out.push({ text: s.slice(i, url.start) });
    out.push({ text: url.text, href: url.href });
    i = url.end;
  }
  if (i < s.length) out.push({ text: s.slice(i) });
}

// A message as the log shows it: [{ text }, { text, mention: actorId, me }, { text, href }] in order, which joined
// give the text back. Mentions are the valid ranges only (validMentions); a dropped range shows as plain text.
// Addresses are found in the text between mentions, never inside one. opts.me: your member ID, so a mention of you
// says me: true. opts.blocked: the author is someone you blocked, whose mentions show as plain text.
export function segments(text, mentions, { me = null, blocked = false } = {}) {
  const s = typeof text === 'string' ? text : '';
  const out = [];
  let i = 0;
  for (const m of blocked ? [] : validMentions(s, mentions)) {
    if (m.from > i) withLinks(s.slice(i, m.from), out);
    out.push({ text: s.slice(m.from, m.to), mention: m.actor, me: Boolean(me) && m.actor === me });
    i = m.to;
  }
  if (i < s.length) withLinks(s.slice(i), out);
  return out;
}

// Whether a message mentions you, by the same rules the log shows it with: a valid range naming you, from an author
// you didn't block.
export function mentionsMember(text, mentions, me, { blocked = false } = {}) {
  if (!me || blocked) return false;
  return validMentions(text, mentions).some((m) => m.actor === me);
}
