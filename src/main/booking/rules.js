'use strict';

// The booking page's rules that need no server or calendar: what a settings record may hold, the handle and slug
// rules, what gets published, how guest details are checked once opened, and the short guest name that is the only
// guest text in anything the host's calendar mails. tmp/cal/contracts.md sections g and h, server/PROTOCOL.md.

const crypto = require('crypto');
const { t, translate } = require('../../i18n');
const { isZone, zonedParts } = require('../calendar/zone');
const { isRanges, isWeekly, merge, intersect } = require('../calendar/availability');

const MINUTE = 60000;
const QUARTER = 15 * MINUTE;
const HANDLE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
const BOOKING_ID = /^[A-Za-z0-9_-]{22}$/;
// A guest's manage key: 32 random bytes as base64url (server/PROTOCOL.md, Sealed guest details).
const MANAGE_KEY = /^[A-Za-z0-9_-]{43}$/;
// The booking page's address as the account server reports it, which Rukoo only partly trusts: URL characters only,
// at most 300 of them. get_booking_link has the same rule (agents/tools.js bookingUrl).
const PAGE_URL = /^[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]{1,300}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The server's reserved handles and slugs (server/src/input.js): its own paths, words people would take for Rukoo's,
// and the website's paths at the root of rukoo.io. The renderer keeps a copy (booking-settings.js);
// test/booking-rules.test.js holds both to the server's.
const RESERVED_HANDLES = new Set(
  [
    'api assets v1 meet mcp llms admin help privacy rukoo www mail support account settings login signup book booking',
    'bookings cal calendar openapi well-known static abuse security status operator bvdm',
    'img media download downloads github releases styles app film video docs blog about pricing features terms legal',
    'press contact changelog android windows mac linux robots sitemap favicon index booker 404 500'
  ]
    .join(' ')
    .split(' ')
);
const RESERVED_SLUGS = new Set('api mcp booking bookings llms openapi ics assets manage prepare'.split(' '));
const LOCATIONS = ['googleMeet', 'phone', 'inPerson', 'link', 'none'];
// The settings record before sealing, in UTF-8 bytes (contracts g).
const SETTINGS_BYTES = 12288;
const MAX_TYPES = 10;
const MAX_OVERRIDES = 60;
const MAX_RANGES = 6;
const MAX_BUSY = 5000;
// Line breaks and the characters that reorder text on screen; refused in one-line fields, as on the server.
const NOT_IN_LINE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const NOT_IN_TEXT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/;
// A plain address, as the server checks a guest's: a dot-atom local part and a host name.
const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";
const EMAIL = new RegExp(`^[${ATEXT}]+(?:\\.[${ATEXT}]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$`);

const plain = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const points = (text) => Array.from(text).length;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// An error a window can act on: booking: true, a code (the server's, 'invalid' for a refused field, or the name of
// the desktop's own reason) and for 'invalid' the field. The message is booking.errors.<name>.
function bookingError(name, { code = null, field = null, message = null } = {}) {
  const err = new Error(message || t(`booking.errors.${name}`));
  err.booking = true;
  err.code = code || (field ? 'invalid' : name);
  if (field) err.field = field;
  return err;
}

const refused = (name, field) => bookingError(name, { code: 'invalid', field });

// null when a handle can be used, else 'invalid' or 'reserved'.
function handleProblem(text) {
  if (typeof text !== 'string' || !HANDLE.test(text)) return 'invalid';
  return RESERVED_HANDLES.has(text) ? 'reserved' : null;
}

function slugProblem(text) {
  if (typeof text !== 'string' || !SLUG.test(text)) return 'invalid';
  return RESERVED_SLUGS.has(text) ? 'reserved' : null;
}

// Lowercase letters and digits joined by single hyphens, accents dropped, at most 32 characters.
function handleFrom(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

// The handle setup suggests: the default account's name, else its address's local part (contracts h).
function defaultHandle(name, email) {
  for (const candidate of [handleFrom(name), handleFrom(String(email || '').split('@')[0])]) {
    if (!handleProblem(candidate)) return candidate;
  }
  return '';
}

// One line of text: trimmed, within max code points, without control or direction characters. null when it isn't.
function line(value, { min = 0, max }) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (NOT_IN_LINE.test(text)) return null;
  const n = points(text);
  return n >= min && n <= max ? text : null;
}

// Text that may have several lines: line breaks become \n.
function paragraph(value, { max }) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (NOT_IN_TEXT.test(text)) return null;
  return points(text) <= max ? text : null;
}

// The first meeting type (contracts h): '30min', titled in the page's language, Google Meet when the destination
// calendar can add it.
function defaultType(locale, { conference = false } = {}) {
  return {
    slug: '30min',
    title: translate(locale, 'booking.defaults.typeTitle'),
    duration: 30,
    description: '',
    location: { kind: conference ? 'googleMeet' : 'none', label: '', value: '', public: false },
    bufferBefore: 0,
    bufferAfter: 0,
    minNotice: 240,
    horizon: 30,
    slotInterval: null,
    dailyLimit: null,
    confirm: false,
    hidden: false
  };
}

// A meeting type as given, with defaults for what it leaves out. Checked afterwards by checkType().
function typeWithDefaults(type, base) {
  const t0 = plain(type) ? type : {};
  const loc = plain(t0.location) ? t0.location : {};
  const b = base.location;
  const pick = (k) => (own(t0, k) ? t0[k] : base[k]);
  return {
    slug: pick('slug'),
    title: pick('title'),
    duration: pick('duration'),
    description: pick('description'),
    location: {
      kind: own(loc, 'kind') ? loc.kind : b.kind,
      label: own(loc, 'label') ? loc.label : b.label,
      value: own(loc, 'value') ? loc.value : b.value,
      public: own(loc, 'public') ? loc.public : b.public
    },
    bufferBefore: pick('bufferBefore'),
    bufferAfter: pick('bufferAfter'),
    minNotice: pick('minNotice'),
    horizon: pick('horizon'),
    slotInterval: pick('slotInterval'),
    dailyLimit: pick('dailyLimit'),
    confirm: pick('confirm'),
    hidden: pick('hidden')
  };
}

// One meeting type, checked field by field. meet: whether the destination can add Google Meet.
function checkType(type, i, { meet }) {
  const f = (name) => `types[${i}].${name}`;
  if (!plain(type)) throw refused('invalidType', `types[${i}]`);
  const slug = slugProblem(type.slug);
  if (slug) throw refused(slug === 'reserved' ? 'reservedSlug' : 'invalidSlug', f('slug'));
  const title = line(type.title, { min: 1, max: 100 });
  if (title === null) throw refused('invalidType', f('title'));
  if (!int(type.duration, 5, 480) || type.duration % 5) throw refused('invalidType', f('duration'));
  const description = paragraph(type.description ?? '', { max: 500 });
  if (description === null) throw refused('invalidType', f('description'));
  const loc = plain(type.location) ? type.location : {};
  if (!LOCATIONS.includes(loc.kind)) throw refused('invalidType', f('location.kind'));
  const label = line(loc.label ?? '', { max: 100 });
  if (label === null) throw refused('invalidType', f('location.label'));
  const value = line(loc.value ?? '', { max: 500 });
  if (value === null) throw refused('invalidType', f('location.value'));
  if (loc.kind === 'link' && value) {
    let url = null;
    try {
      url = new URL(value);
    } catch (_) {
      url = null;
    }
    if (!url || url.protocol !== 'https:') throw refused('invalidType', f('location.value'));
  }
  if (loc.kind === 'googleMeet' && !meet) throw refused('noMeet', f('location.kind'));
  if (typeof loc.public !== 'boolean') throw refused('invalidType', f('location.public'));
  const out = {
    slug: type.slug,
    title,
    duration: type.duration,
    description,
    location: { kind: loc.kind, label, value, public: loc.public },
    bufferBefore: type.bufferBefore,
    bufferAfter: type.bufferAfter,
    minNotice: type.minNotice,
    horizon: type.horizon,
    slotInterval: type.slotInterval,
    dailyLimit: type.dailyLimit,
    confirm: type.confirm,
    hidden: type.hidden
  };
  for (const [k, lo, hi] of [['bufferBefore', 0, 240], ['bufferAfter', 0, 240], ['minNotice', 0, 43200], ['horizon', 1, 90]]) {
    if (!int(out[k], lo, hi)) throw refused('invalidType', f(k));
  }
  if (out.slotInterval !== null && !int(out.slotInterval, 5, 480)) throw refused('invalidType', f('slotInterval'));
  if (out.dailyLimit !== null && !int(out.dailyLimit, 1, 50)) throw refused('invalidType', f('dailyLimit'));
  if (typeof out.confirm !== 'boolean') throw refused('invalidType', f('confirm'));
  if (typeof out.hidden !== 'boolean') throw refused('invalidType', f('hidden'));
  return out;
}

// One day's booking hours: the Weekly rules plus at most 6 ranges.
const dayRanges = (ranges) => isRanges(ranges) && ranges.length <= MAX_RANGES;

// A portable calendar key: the lowercased account email and the calendar id, joined by a newline.
function portableKey(email, calendarId) {
  return `${String(email || '').trim().toLowerCase()}\n${calendarId}`;
}

function parsePortable(key) {
  if (typeof key !== 'string' || key.length > 1400) return null;
  const at = key.indexOf('\n');
  if (at < 3) return null;
  const email = key.slice(0, at);
  const calendarId = key.slice(at + 1);
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !calendarId || calendarId.length > 1000) return null;
  return { email, calendarId };
}

// The whole settings record checked (contracts h). Returns the record as it is stored; throws a booking error that
// names the first field refused. o.today: the first date overrides may have, in the page's zone (older ones are
// dropped). o.meet: whether the destination can add Google Meet.
function checkSettings(s, { today = null, meet = false } = {}) {
  if (!plain(s)) throw refused('invalidType', 'settings');
  const handle = handleProblem(s.handle);
  if (handle) throw refused(handle === 'reserved' ? 'reservedHandle' : 'invalidHandle', 'handle');
  const name = line(s.name, { min: 1, max: 100 });
  if (name === null) throw refused('invalidName', 'name');
  const intro = paragraph(s.intro ?? '', { max: 1000 });
  if (intro === null) throw refused('invalidIntro', 'intro');
  if (!isZone(s.timeZone)) throw refused('invalidZone', 'timeZone');
  const locale = s.locale === 'nl' ? 'nl' : s.locale === 'en' ? 'en' : null;
  if (!locale) throw refused('invalidType', 'locale');
  let contact = null;
  if (s.contact !== null && s.contact !== undefined) {
    contact = line(s.contact, { max: 200 });
    if (contact === null) throw refused('invalidContact', 'contact');
    contact = contact || null;
  }
  if (!int(s.dailyCap, 1, 50)) throw refused('invalidCap', 'dailyCap');
  const hours = plain(s.hours) ? s.hours : { custom: false, weekly: null };
  if (typeof hours.custom !== 'boolean') throw refused('invalidHours', 'hours');
  let weekly = null;
  if (hours.weekly !== null && hours.weekly !== undefined) {
    if (!isWeekly(hours.weekly) || !hours.weekly.every(dayRanges)) throw refused('invalidHours', 'hours.weekly');
    weekly = hours.weekly.map((day) => day.map(([a, b]) => [a, b]));
  }
  if (hours.custom && !weekly) throw refused('invalidHours', 'hours.weekly');
  const overrides = {};
  const given = plain(s.overrides) ? s.overrides : {};
  for (const [date, ranges] of Object.entries(given)) {
    if (!DATE.test(date) || !Array.isArray(ranges) || (ranges.length && !dayRanges(ranges))) throw refused('invalidOverrides', `overrides.${date}`);
    if (today && date < today) continue;
    overrides[date] = ranges.map(([a, b]) => [a, b]);
  }
  if (Object.keys(overrides).length > MAX_OVERRIDES) throw refused('invalidOverrides', 'overrides');
  const destination = s.destination === null || s.destination === undefined ? null : s.destination;
  if (destination !== null && !parsePortable(destination)) throw refused('noDestination', 'destination');
  if (!Array.isArray(s.types) || s.types.length < 1 || s.types.length > MAX_TYPES) throw refused('invalidType', 'types');
  const types = s.types.map((type, i) => checkType(type, i, { meet }));
  const slugs = new Set();
  types.forEach((type, i) => {
    if (slugs.has(type.slug)) throw refused('duplicateSlug', `types[${i}].slug`);
    slugs.add(type.slug);
  });
  const out = {
    v: 1,
    handle: s.handle,
    url: typeof s.url === 'string' ? s.url.slice(0, 2000) : '',
    name,
    intro,
    timeZone: s.timeZone,
    locale,
    contact,
    dailyCap: s.dailyCap,
    hours: { custom: hours.custom, weekly },
    overrides,
    destination,
    device: typeof s.device === 'string' && s.device.length <= 200 ? s.device : null,
    types
  };
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > SETTINGS_BYTES) throw bookingError('tooLarge', { code: 'too_large' });
  return out;
}

// bookingSave's merge (contracts g): top-level fields replace, types and hours replace whole, overrides merge per
// date with null deleting one, and v, url and device stay what the record says (the server reports them).
function mergeSettings(current, patch) {
  const p = plain(patch) ? patch : {};
  const out = { ...current };
  for (const [k, v] of Object.entries(p)) {
    if (k === 'v' || k === 'url' || k === 'device' || !own(current, k)) continue;
    if (k === 'overrides') {
      const next = { ...(plain(current.overrides) ? current.overrides : {}) };
      for (const [date, ranges] of Object.entries(plain(v) ? v : {})) {
        if (ranges === null) delete next[date];
        else next[date] = ranges;
      }
      out.overrides = next;
    } else out[k] = v;
  }
  return out;
}

// What a type looks like on the page (contracts h): the private location value only when the host made it public,
// the slot interval as a number.
function publishedType(type, { confirm = false } = {}) {
  const location = { kind: type.location.kind, label: type.location.label };
  if (type.location.public && type.location.value) location.value = type.location.value;
  return {
    slug: type.slug,
    title: type.title,
    duration: type.duration,
    description: type.description,
    location,
    bufferBefore: type.bufferBefore,
    bufferAfter: type.bufferAfter,
    minNotice: type.minNotice,
    horizon: type.horizon,
    slotInterval: type.slotInterval ?? type.duration,
    dailyLimit: type.dailyLimit,
    confirm: type.confirm || confirm,
    hidden: type.hidden,
    schedule: 'default'
  };
}

// The published profile. confirmAll: every type waits for the host, because a calendar couldn't be checked.
// invites: whether the destination calendar sends the guest an invitation; a demo calendar doesn't, and then the
// guest's pages say so (design 1.2).
function profileOf(settings, { keyId, publicKey }, { confirmAll = false, invites = true } = {}) {
  return {
    name: settings.name,
    intro: settings.intro,
    timeZone: settings.timeZone,
    locale: settings.locale,
    keyId,
    publicKey,
    contact: settings.contact,
    dailyCap: settings.dailyCap,
    ...(invites ? {} : { invites: false }),
    types: settings.types.map((type) => publishedType(type, { confirm: confirmAll }))
  };
}

// Busy time as published: only where it can matter (the open windows, widened by the largest buffer), widened to
// whole quarter hours, and at most 5000 intervals. Past that, the closest ones are joined, so time is never shown as
// free that wasn't.
function publishedBusy(busy, windows, bufferMs) {
  const near = merge(windows.map(([s, e]) => [s - bufferMs, e + bufferMs]));
  let out = merge(intersect(merge(busy), near).map(([s, e]) => [Math.floor(s / QUARTER) * QUARTER, Math.ceil(e / QUARTER) * QUARTER]));
  for (let gap = QUARTER; out.length > MAX_BUSY; gap *= 2) {
    out = merge(out.map(([s, e]) => [s, e + gap])).map(([s, e]) => [s, e - gap]);
  }
  return out;
}

// A stable hash of what a publish sends, so an unchanged page isn't sent again.
function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
}

// The guest's name as it may appear in the event title, the one guest text that reaches mail the host's calendar
// sends: letters, marks, spaces, apostrophes, hyphens and periods, at most 4 words and 40 characters.
function shortName(name) {
  const words = String(name || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}'’\-.\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-'’.]+|[-'’]+$/g, ''))
    .filter((w) => /\p{L}/u.test(w))
    .slice(0, 4);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (points(next) > 40) break;
    out = next;
  }
  if (!out && words.length) out = Array.from(words[0]).slice(0, 40).join('');
  return out;
}

// The guest's details as opened from the sealed blob, checked again here (PROTOCOL.md, Sealed guest details): name
// at most 80 characters without control characters, notes at most 1000, a plain address, a known zone, and the
// type and times the booking was made for. Returns { name, email, notes, timeZone, locale, via, manageKey } or null.
// manageKey is null when it isn't 43 characters of base64url: the event then goes without the guest's links, and the
// booking still goes through.
function checkGuest(text, row) {
  let d;
  try {
    d = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!plain(d)) return null;
  const name = line(d.name, { min: 1, max: 80 });
  const email = typeof d.email === 'string' ? d.email.trim().toLowerCase() : '';
  const notes = paragraph(d.notes ?? '', { max: 1000 });
  const via = line(d.via ?? '', { max: 80 });
  if (name === null || notes === null || via === null) return null;
  if (email.length > 254 || email.split('@')[0].length > 64 || !EMAIL.test(email)) return null;
  if (!isZone(d.timeZone)) return null;
  if (d.locale !== 'en' && d.locale !== 'nl') return null;
  if (d.type !== row.type || d.start !== row.bookedStart || d.end !== row.bookedEnd) return null;
  const manageKey = typeof d.manageKey === 'string' && MANAGE_KEY.test(d.manageKey) ? d.manageKey : null;
  return { name, email, notes, timeZone: d.timeZone, locale: d.locale, via, manageKey };
}

// The page's address when it may go into mail: a plain https address without a query or fragment, or http on this
// computer (wrangler dev, the test server). null otherwise.
function pageUrl(v) {
  if (typeof v !== 'string' || !PAGE_URL.test(v) || /[?#]/.test(v)) return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) return v.replace(/\/+$/, '');
  } catch (_) {
    // Not an address.
  }
  return null;
}

// The guest's links to a booking, as its manage page has them (server/PROTOCOL.md, Public routes): reschedule opens the
// booker for a move, manage the page with Cancel. Opening either changes nothing. A move keeps the booking's id and
// key, so the links keep working after one. null when the address, the id or the key fails its check; reschedule is
// null without a slug the page has.
function guestLinks(url, { id, slug = null, key }) {
  const page = pageUrl(url);
  if (!page || typeof id !== 'string' || !BOOKING_ID.test(id) || typeof key !== 'string' || !MANAGE_KEY.test(key)) return null;
  return {
    reschedule: slugProblem(slug) === null ? `${page}/${slug}?reschedule=${id}&k=${key}` : null,
    manage: `${page}/booking/${id}?k=${key}`
  };
}

// The page's first open date: today in its zone, for dropping old date overrides.
const todayIn = (timeZone, now) => zonedParts(now, isZone(timeZone) ? timeZone : 'UTC').date;

module.exports = {
  BOOKING_ID,
  SETTINGS_BYTES,
  RESERVED_HANDLES,
  RESERVED_SLUGS,
  bookingError,
  handleProblem,
  slugProblem,
  defaultHandle,
  defaultType,
  typeWithDefaults,
  checkSettings,
  mergeSettings,
  portableKey,
  parsePortable,
  publishedType,
  profileOf,
  publishedBusy,
  payloadHash,
  shortName,
  checkGuest,
  pageUrl,
  guestLinks,
  todayIn
};
