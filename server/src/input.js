// Checks what a client sends before any of it reaches an account's Durable Object. Each check either returns the
// value in the form the object stores or throws an HttpError with the status and code PROTOCOL.md gives.

import { fromBase64url } from './bytes.js';
import { DAY, daysBetween, isDate, isZone } from './zone.js';

// extra goes into the error's JSON next to error and message: field, alternatives, limit.
export class HttpError extends Error {
  constructor(status, code, message, headers = {}, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.extra = extra;
  }
}

export function invalid(message, field) {
  return new HttpError(400, 'invalid', message, {}, field ? { field } : {});
}

export const DEFAULT_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };
// The same floor the apps use when signing in (PROTOCOL.md, Keys), plus ceilings, so a client can't store parameters
// that would make every other device spend minutes or gigabytes on a sign-in.
const KDF_RANGE = { m: [19456, 1048576], t: [2, 10], p: [1, 4] };

// A sealed blob is a version byte 0x01, a 12-byte nonce, the ciphertext and a 16-byte tag.
const SEAL_VERSION = 0x01;
const SEAL_MIN = 1 + 12 + 16;
// A wrapped data key is 61 bytes; the ceiling only keeps the account row small.
const WRAPPED_KEY_MAX = 256;

export const RECORD_BYTES = 16384;
export const BATCH = 500;
export const PULL_LIMIT = 1000;

// Requests other than a push carry a few hundred bytes. A full push is 500 records of at most 16 KiB, which grows by a
// third in base64url, plus the JSON around them.
const BODY_MAX = 64 * 1024;
const PUSH_BODY_MAX = 12 * 1024 * 1024;

// The body, read piece by piece and given up on as soon as it passes max. A body sent in chunks has no
// Content-Length to check first, and reading all of it before checking would let anyone fill the Worker's memory.
export async function readBody(request, max) {
  const tooLarge = () => new HttpError(413, 'too_large', 'The request body is too large.');
  const declared = Number(request.headers.get('content-length'));
  if (declared > max) throw tooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

export async function readJson(request, max = BODY_MAX) {
  const body = await readBody(request, max);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw invalid('The request body must be JSON.');
  }
  if (!isObject(value)) throw invalid('The request body must be a JSON object.');
  return value;
}

export function readPushJson(request) {
  return readJson(request, PUSH_BODY_MAX);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Trimmed and lowercased as PROTOCOL.md says, then checked loosely: an address has one @ with a dot somewhere after
// it. Nothing else about it can be known without sending it mail, which this server never does.
export function email(value) {
  if (typeof value !== 'string') throw invalid('email must be a string.');
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(normalized)) {
    throw invalid('email must be an email address.');
  }
  return normalized;
}

export function key(value, name, length) {
  const bytes = fromBase64url(value);
  if (!bytes || bytes.length !== length) throw invalid(`${name} must be ${length} bytes in base64url.`);
  return bytes;
}

export function sealed(value, name, max = WRAPPED_KEY_MAX) {
  const bytes = fromBase64url(value);
  if (!bytes || bytes.length < SEAL_MIN || bytes.length > max || bytes[0] !== SEAL_VERSION) {
    throw invalid(`${name} must be a sealed value in base64url.`);
  }
  return bytes;
}

// Exactly the four parameters PROTOCOL.md names. A field this server doesn't know is refused rather than dropped:
// a device that relied on it would derive a different key from what the server hands back at the next sign-in.
export function kdf(value) {
  if (!isObject(value)) throw invalid('kdf must be an object.');
  if (Object.keys(value).sort().join(',') !== 'alg,m,p,t')
    throw invalid('kdf must have alg, m, t and p, and nothing else.');
  if (value.alg !== 'argon2id') throw invalid('kdf.alg must be argon2id.');
  for (const [name, [min, max]] of Object.entries(KDF_RANGE)) {
    const n = value[name];
    if (!Number.isInteger(n) || n < min || n > max)
      throw invalid(`kdf.${name} must be a whole number from ${min} to ${max}.`);
  }
  return { alg: 'argon2id', m: value.m, t: value.t, p: value.p };
}

// Cut by code point, so a name never ends in half an emoji.
function cut(text, length) {
  return Array.from(text.trim()).slice(0, length).join('').trim();
}

export function device(value) {
  if (!isObject(value) || typeof value.name !== 'string') throw invalid('device must be an object with a name.');
  if (value.platform !== undefined && typeof value.platform !== 'string')
    throw invalid('device.platform must be a string.');
  return { name: cut(value.name, 100), platform: cut(value.platform ?? '', 32) };
}

export function recordId(value) {
  if (typeof value !== 'string' || value.length !== 43 || !fromBase64url(value)) {
    throw invalid('A record id must be 43 characters of base64url.');
  }
  return value;
}

// The records of a push, in order. Data is decoded here so the object only ever sees bytes it can store as they are.
export function records(value) {
  if (!Array.isArray(value)) throw invalid('records must be a list.');
  if (value.length > BATCH) throw new HttpError(413, 'too_large', `A push holds at most ${BATCH} records.`);
  return value.map((item) => {
    if (!isObject(item)) throw invalid('Each record must be an object.');
    const id = recordId(item.id);
    if (item.ifAbsent !== undefined && typeof item.ifAbsent !== 'boolean')
      throw invalid('ifAbsent must be true or false.');
    let data = null;
    if (item.data !== null) {
      // Checked on the text first, so an oversized record isn't decoded at all.
      if (typeof item.data === 'string' && item.data.length > Math.ceil((RECORD_BYTES * 4) / 3)) {
        throw new HttpError(413, 'too_large', `A record's data is at most ${RECORD_BYTES} bytes.`);
      }
      data = sealed(item.data, 'data', RECORD_BYTES);
    }
    return { id, data, ifAbsent: item.ifAbsent === true };
  });
}

// since and limit for a pull. A limit above the maximum is lowered to it rather than refused.
export function pullQuery(url) {
  const since = whole(url.searchParams.get('since'), 0, 'since');
  const limit = whole(url.searchParams.get('limit'), PULL_LIMIT, 'limit');
  if (limit < 1) throw invalid('limit must be at least 1.');
  return { since, limit: Math.min(limit, PULL_LIMIT) };
}

function whole(text, fallback, name) {
  if (text === null) return fallback;
  const n = /^\d{1,15}$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n)) throw invalid(`${name} must be a whole number.`, name);
  return n;
}

// ---- Booking pages (PROTOCOL.md, Booking pages) ----

export const HANDLE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$/;
export const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
export const RESERVED_HANDLES = new Set(
  'api assets v1 meet mcp llms admin help privacy rukoo www mail support account settings login signup book booking bookings cal calendar openapi well-known static abuse security status operator bvdm'.split(
    ' '
  )
);
export const RESERVED_SLUGS = new Set('api mcp booking bookings llms openapi ics assets manage prepare'.split(' '));
export const BOOKING_ID = /^[A-Za-z0-9_-]{22}$/;
export const LOCATION_KINDS = ['googleMeet', 'phone', 'inPerson', 'link', 'none'];
export const OWNER_ACTIONS = ['handled', 'confirm', 'decline', 'cancel', 'reschedule'];
export const CANCEL_REASONS = ['host_cancelled', 'host_deleted', 'guest_declined'];
export const BOOKINGS_LIMIT = 500;
export const PROFILE_BYTES = 64 * 1024;
export const MAX_WINDOWS = 2000;
export const MAX_BUSY = 5000;
const QUARTER = 15 * 60 * 1000;
// A publish carries the profile (at most 64 KiB) plus up to 7000 intervals of two 13-digit numbers.
export const PUBLISH_BODY_MAX = 512 * 1024;
export const FORM_BODY_MAX = 16 * 1024;

// Characters that break a line or reorder what follows it on screen. Text with them is refused, not cleaned, so a
// host or guest sees why. Multi-line fields allow newlines and tabs.
const NOT_IN_LINE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const NOT_IN_TEXT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/;

// null when a handle can be used, else why not: 'invalid' or 'reserved'. blocked is the operator's BLOCKED_HANDLES.
export function handleCheck(text, blocked = []) {
  if (typeof text !== 'string' || !HANDLE.test(text)) return 'invalid';
  if (RESERVED_HANDLES.has(text) || blocked.includes(text)) return 'reserved';
  return null;
}

export function slugCheck(text) {
  if (typeof text !== 'string' || !SLUG.test(text)) return 'invalid';
  if (RESERVED_SLUGS.has(text)) return 'reserved';
  return null;
}

function codePoints(text) {
  return Array.from(text).length;
}

// One line of text: trimmed, min to max code points, without control or direction characters.
export function line(value, field, { min = 0, max }) {
  if (typeof value !== 'string') throw invalid(`${field} must be text.`, field);
  const text = value.trim();
  if (NOT_IN_LINE.test(text)) throw invalid(`${field} can't contain line breaks or control characters.`, field);
  const n = codePoints(text);
  if (n < min) throw invalid(min === 1 ? `${field} can't be empty.` : `${field} needs at least ${min} characters.`, field);
  if (n > max) throw invalid(`${field} can be at most ${max} characters.`, field);
  return text;
}

// Text that may have several lines: line breaks become \n.
export function paragraph(value, field, { max }) {
  if (typeof value !== 'string') throw invalid(`${field} must be text.`, field);
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (NOT_IN_TEXT.test(text)) throw invalid(`${field} can't contain control characters.`, field);
  if (codePoints(text) > max) throw invalid(`${field} can be at most ${max} characters.`, field);
  return text;
}

function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${field} must be a whole number from ${min} to ${max}.`, field);
  }
  return value;
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw invalid(`${field} must be true or false.`, field);
  return value;
}

function zone(value, field) {
  if (!isZone(value)) throw invalid(`${field} must be an IANA time zone such as Europe/Amsterdam.`, field);
  return value;
}

export function isObjectValue(value) {
  return isObject(value);
}

// A handle in a request body. Reserved handles are a 409, like a taken one, so the app can say so next to the field.
export function handle(value, blocked = []) {
  const problem = handleCheck(value, blocked);
  if (problem === 'invalid') {
    throw invalid('handle must be 3 to 32 lowercase letters, digits and single hyphens inside.', 'handle');
  }
  if (problem === 'reserved') throw new HttpError(409, 'handle_reserved', 'This handle is reserved.');
  return value;
}

function slug(value, field) {
  const problem = slugCheck(value);
  if (problem === 'invalid') throw invalid(`${field} must be 1 to 40 lowercase letters, digits and single hyphens inside.`, field);
  if (problem === 'reserved') throw invalid(`${field} is a reserved word; pick another.`, field);
  return value;
}

function location(value, field) {
  if (!isObject(value)) throw invalid(`${field} must be an object.`, field);
  if (!LOCATION_KINDS.includes(value.kind)) throw invalid(`${field}.kind must be one of ${LOCATION_KINDS.join(', ')}.`, `${field}.kind`);
  const out = { kind: value.kind, label: line(value.label ?? '', `${field}.label`, { max: 100 }) };
  if (value.value !== undefined && value.value !== null) {
    const text = line(value.value, `${field}.value`, { max: 500 });
    if (value.kind === 'link') {
      let url = null;
      try {
        url = new URL(text);
      } catch {
        url = null;
      }
      if (!url || url.protocol !== 'https:') throw invalid(`${field}.value must be an https link.`, `${field}.value`);
    }
    if (text) out.value = text;
  }
  return out;
}

function meetingType(value, field, schedules) {
  if (!isObject(value)) throw invalid(`${field} must be an object.`, field);
  const type = {
    slug: slug(value.slug, `${field}.slug`),
    title: line(value.title, `${field}.title`, { min: 1, max: 100 }),
    duration: integer(value.duration, `${field}.duration`, 5, 480),
    description: paragraph(value.description ?? '', `${field}.description`, { max: 500 }),
    location: location(value.location ?? { kind: 'none' }, `${field}.location`),
    bufferBefore: integer(value.bufferBefore ?? 0, `${field}.bufferBefore`, 0, 240),
    bufferAfter: integer(value.bufferAfter ?? 0, `${field}.bufferAfter`, 0, 240),
    minNotice: integer(value.minNotice ?? 240, `${field}.minNotice`, 0, 43200),
    horizon: integer(value.horizon ?? 30, `${field}.horizon`, 1, 90),
    slotInterval: integer(value.slotInterval ?? value.duration, `${field}.slotInterval`, 5, 480),
    dailyLimit: value.dailyLimit === null || value.dailyLimit === undefined ? null : integer(value.dailyLimit, `${field}.dailyLimit`, 1, 50),
    confirm: bool(value.confirm ?? false, `${field}.confirm`),
    hidden: bool(value.hidden ?? false, `${field}.hidden`),
    schedule: value.schedule ?? 'default'
  };
  if (type.duration % 5 !== 0) throw invalid(`${field}.duration must be a multiple of 5 minutes.`, `${field}.duration`);
  if (typeof type.schedule !== 'string' || !schedules.includes(type.schedule)) {
    throw invalid(`${field}.schedule must name a schedule in windows.`, `${field}.schedule`);
  }
  return type;
}

// The published profile, with exactly the fields PROTOCOL.md lists. Fields this server doesn't know are dropped.
export function profile(value, schedules = ['default']) {
  if (!isObject(value)) throw invalid('profile must be an object.', 'profile');
  if (new TextEncoder().encode(JSON.stringify(value)).length > PROFILE_BYTES) {
    throw new HttpError(413, 'too_large', `The profile can be at most ${PROFILE_BYTES} bytes of JSON.`);
  }
  const keyId = fromBase64url(value.keyId);
  if (!keyId || keyId.length !== 8) throw invalid('profile.keyId must be 8 bytes in base64url.', 'profile.keyId');
  const publicKey = fromBase64url(value.publicKey);
  if (!publicKey || publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw invalid('profile.publicKey must be an uncompressed P-256 point in base64url.', 'profile.publicKey');
  }
  if (value.locale !== 'en' && value.locale !== 'nl') throw invalid('profile.locale must be en or nl.', 'profile.locale');
  if (!Array.isArray(value.types) || value.types.length < 1 || value.types.length > 10) {
    throw invalid('profile.types must hold 1 to 10 meeting types.', 'profile.types');
  }
  const types = value.types.map((t, i) => meetingType(t, `profile.types[${i}]`, schedules));
  const slugs = new Set();
  types.forEach((t, i) => {
    if (slugs.has(t.slug)) throw invalid(`profile.types[${i}].slug is used twice.`, `profile.types[${i}].slug`);
    slugs.add(t.slug);
  });
  return {
    name: line(value.name, 'profile.name', { min: 1, max: 100 }),
    intro: paragraph(value.intro ?? '', 'profile.intro', { max: 1000 }),
    timeZone: zone(value.timeZone, 'profile.timeZone'),
    locale: value.locale,
    keyId: value.keyId,
    publicKey: value.publicKey,
    contact: value.contact === null || value.contact === undefined ? null : line(value.contact, 'profile.contact', { max: 200 }) || null,
    dailyCap: integer(value.dailyCap ?? 20, 'profile.dailyCap', 1, 50),
    types
  };
}

// Sorted, non-overlapping [start, end] pairs in milliseconds, each inside [from, to] and, with align, on its grid.
export function intervals(value, field, { max, from, to, align = 0 }) {
  if (!Array.isArray(value)) throw invalid(`${field} must be a list of [start, end] pairs.`, field);
  if (value.length > max) throw invalid(`${field} can hold at most ${max} intervals.`, field);
  let last = -Infinity;
  return value.map((pair, i) => {
    const f = `${field}[${i}]`;
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isSafeInteger)) {
      throw invalid(`${f} must be [start, end] in milliseconds.`, f);
    }
    const [s, e] = pair;
    if (s >= e) throw invalid(`${f} must start before it ends.`, f);
    if (s < last) throw invalid(`${field} must be sorted and must not overlap.`, f);
    if (s < from || e > to) throw invalid(`${f} is outside the range this server takes.`, f);
    if (align && (s % align !== 0 || e % align !== 0)) throw invalid(`${f} must be on a 15-minute grid.`, f);
    last = e;
    return [s, e];
  });
}

// PUT /v1/booking, apart from the key id check, which needs a hash (owner.js does it).
export function bookingPut(body, now, blocked = []) {
  const h = handle(body.handle, blocked);
  const enabled = bool(body.enabled, 'enabled');
  const takeover = body.takeover === undefined ? false : bool(body.takeover, 'takeover');
  if (!isObject(body.windows)) throw invalid('windows must be an object such as { "default": [...] }.', 'windows');
  const names = Object.keys(body.windows);
  if (!names.includes('default') || !names.every((n) => SLUG.test(n))) {
    throw invalid('windows must have a "default" list and only simple names.', 'windows');
  }
  let count = 0;
  const windows = {};
  for (const name of names) {
    windows[name] = intervals(body.windows[name], `windows.${name}`, { max: MAX_WINDOWS, from: now - 2 * DAY, to: now + 92 * DAY });
    count += windows[name].length;
  }
  if (count > MAX_WINDOWS) throw invalid(`windows can hold at most ${MAX_WINDOWS} intervals.`, 'windows');
  const busy = intervals(body.busy, 'busy', { max: MAX_BUSY, from: now - 3 * DAY, to: now + 93 * DAY, align: QUARTER });
  return { handle: h, enabled, takeover, profile: profile(body.profile, names), windows, busy };
}

export function ownerAction(body) {
  if (!OWNER_ACTIONS.includes(body.action)) throw invalid(`action must be one of ${OWNER_ACTIONS.join(', ')}.`, 'action');
  const out = { action: body.action, version: integer(body.version, 'version', 1, 1e9) };
  if (body.action === 'reschedule') {
    if (!Number.isSafeInteger(body.start) || body.start <= 0) throw invalid('start must be a time in milliseconds.', 'start');
    out.start = body.start;
    out.host = body.host === undefined ? false : bool(body.host, 'host');
  }
  if (body.action === 'cancel') {
    const reason = body.reason ?? 'host_cancelled';
    if (!CANCEL_REASONS.includes(reason)) throw invalid(`reason must be one of ${CANCEL_REASONS.join(', ')}.`, 'reason');
    out.reason = reason;
  }
  if (body.action === 'cancel' || body.action === 'decline') {
    out.message = body.message === undefined || body.message === null ? null : paragraph(body.message, 'message', { max: 500 }) || null;
  }
  return out;
}

export function bookingsQuery(url) {
  const since = whole(url.searchParams.get('since'), 0, 'since');
  const limit = whole(url.searchParams.get('limit'), BOOKINGS_LIMIT, 'limit');
  if (limit < 1) throw invalid('limit must be at least 1.', 'limit');
  return { since, limit: Math.min(limit, BOOKINGS_LIMIT) };
}

export function bookingId(value) {
  if (typeof value !== 'string' || !BOOKING_ID.test(value) || !fromBase64url(value)) {
    throw new HttpError(404, 'not_found', 'There is no such booking.');
  }
  return value;
}

// ---- What guests and their assistants send ----

const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";
const EMAIL = new RegExp(
  `^[${ATEXT}]+(?:\\.[${ATEXT}]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$`
);

// A plain address: a dot-atom local part, no quotes, commas, angle brackets or semicolons. Lowercased.
export function guestEmail(value, field = 'email') {
  if (typeof value !== 'string') throw invalid(`${field} must be an email address.`, field);
  const text = value.trim().toLowerCase();
  const local = text.split('@')[0];
  if (text.length > 254 || local.length > 64 || !EMAIL.test(text)) {
    throw invalid(`${field} must be a plain email address such as jane@example.com.`, field);
  }
  return text;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:([Zz])|([+ -])(\d{2})(?::?(\d{2}))?)$/;
const INSTANT_HELP = 'Send it as an ISO 8601 time with Z or an offset, such as 2026-11-03T09:00:00Z.';

// A moment written as ISO 8601 with Z or an offset. A space before the offset is a '+' that a URL turned into a
// space. A time without an offset is refused: it would be read in some zone nobody chose.
export function instant(value, field = 'start') {
  const m = typeof value === 'string' ? ISO.exec(value.trim()) : null;
  if (!m) throw invalid(`${field} isn't a time this server reads. ${INSTANT_HELP}`, field);
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const s = Number(m[6] ?? 0);
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  const offset = m[8] ? 0 : (m[9] === '-' ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11] ?? 0));
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isDate(date) || h > 23 || mi > 59 || s > 59 || Number(m[10] ?? 0) > 18 || Number(m[11] ?? 0) > 59) {
    throw invalid(`${field} isn't a valid time. ${INSTANT_HELP}`, field);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offset * 60000;
}

function optionalLine(value, field, max) {
  if (value === undefined || value === null) return '';
  return line(value, field, { max });
}

// The JSON body of a booking (POST /meet/<handle>/api/bookings and book_meeting), in the form the Booking object
// takes. type stays null when absent; the page picks its only visible type.
export function guestBooking(body) {
  const out = {
    type: body.type === undefined || body.type === null || body.type === '' ? null : typeSlug(body.type),
    start: instant(body.start, 'start'),
    name: line(body.name ?? '', 'name', { min: 1, max: 80 }),
    email: guestEmail(body.email),
    notes: body.notes === undefined || body.notes === null ? '' : paragraph(body.notes, 'notes', { max: 1000 }),
    timeZone: body.time_zone === undefined || body.time_zone === null || body.time_zone === '' ? null : zone(body.time_zone, 'time_zone'),
    via: optionalLine(body.via, 'via', 80),
    locale: body.locale === 'nl' || body.locale === 'en' ? body.locale : null
  };
  return out;
}

// A type named by a guest: anything that can't be a slug is simply unknown.
export function typeSlug(value) {
  if (typeof value !== 'string' || !SLUG.test(value)) {
    throw new HttpError(404, 'unknown_type', 'There is no meeting type with that name.', {}, { field: 'type' });
  }
  return value;
}

export function guestZone(value, field = 'time_zone') {
  if (value === undefined || value === null || value === '') return null;
  return zone(value, field);
}

export function idempotencyKey(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length < 16 || text.length > 200 || !/^[\x21-\x7e]+$/.test(text)) {
    throw invalid('Idempotency-Key must be 16 to 200 visible ASCII characters.', 'idempotency_key');
  }
  return text;
}

// from and to (dates, inclusive), type and time_zone for a slot listing. Defaults are the caller's.
export function slotQuery(params) {
  const get = (name) => {
    const v = params.get(name);
    return v === null || v === '' ? null : v;
  };
  const type = get('type') === null ? null : typeSlug(get('type'));
  const timeZone = guestZone(get('time_zone'));
  const date = (name) => {
    const v = get(name);
    if (v !== null && !isDate(v)) throw invalid(`${name} must be a date such as 2026-11-03.`, name);
    return v;
  };
  const from = date('from');
  const to = date('to');
  if (from && to) {
    const days = daysBetween(from, to);
    if (days < 0) throw invalid('to must not be before from.', 'to');
    if (days > 31) throw invalid('from and to can be at most 31 days apart.', 'to');
  }
  return { type, from, to, timeZone };
}

// The media type of a request body, lowercased, without parameters.
export function mediaType(request) {
  return (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

// A URL-encoded form, at most 16 KiB, as URLSearchParams. Multipart is refused.
export async function readForm(request, max = FORM_BODY_MAX) {
  if (mediaType(request) !== 'application/x-www-form-urlencoded') {
    throw new HttpError(415, 'content_type', 'Send the form as application/x-www-form-urlencoded.');
  }
  const body = await readBody(request, max);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw invalid('The form must be UTF-8.');
  }
  return new URLSearchParams(text);
}
