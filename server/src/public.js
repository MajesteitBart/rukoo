// What the public booking surfaces share: finding a page, reading its public profile, listing open times, booking,
// and a guest's own booking by its manage key. The JSON API (api.js), the MCP endpoint (mcp.js), the agent text
// (agent-text.js) and the human pages all go through these, so they offer the same times and refuse the same things.
//
// Values here are plain: times in milliseconds, profiles in the shape the host published them, minus what the public
// never sees (windows, busy times, the public key, the owner, limits and private location values).

import { sha256, utf8 } from './bytes.js';
import { blockedHandles, bookingObject, bookingOrigin, bookingTimes, config } from './config.js';
import * as input from './input.js';
import { HttpError } from './input.js';
import { DAY, addDays, daysBetween, zonedInstant, zonedParts } from './zone.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Location kinds as JSON, llms.txt and MCP write them, and the English name an empty label stands for.
export const LOCATION_KIND = { googleMeet: 'google_meet', phone: 'phone', inPerson: 'in_person', link: 'link', none: 'none' };
export const LOCATION_LABEL = { googleMeet: 'Google Meet', phone: 'Phone call', inPerson: 'In person', link: 'Link', none: '' };
export const MAX_SLOT_DAYS = 31;
export const DEFAULT_SLOT_DAYS = 14;

// The addresses a page's public routes use, all absolute.
export function links(env, url, handle) {
  const origin = bookingOrigin(env, url);
  const page = `${origin}/meet/${handle}`;
  return {
    origin,
    page,
    llmsTxt: `${page}/llms.txt`,
    api: `${page}/api`,
    slots: `${page}/api/slots`,
    bookings: `${page}/api/bookings`,
    mcp: `${origin}/meet/mcp`,
    privacy: config(env, url).operator.privacy,
    type: (slug) => `${page}/${slug}`,
    slotsFor: (slug) => `${page}/api/slots?type=${encodeURIComponent(slug)}`,
    prepare: (slug, start) => `${page}/${slug}?slot=${slotParam(start)}`,
    manage: (id, key) => `${page}/booking/${id}?k=${encodeURIComponent(key)}`,
    ics: (id, key) => `${page}/booking/${id}.ics?k=${encodeURIComponent(key)}`
  };
}

// The handle in a path, or a 404 that looks the same for unknown, reserved and blocked handles.
export function pathHandle(env, text) {
  if (input.handleCheck(text, blockedHandles(env))) throw notFound();
  return text;
}

export function notFound(message = 'There is no booking page at this address.') {
  return new HttpError(404, 'not_found', message);
}

// The page behind a handle: { state: 'moved', movedTo } or { state: 'page', handle, profile, accepting, stale, dark,
// publishedAt, enabled }. A handle nobody has, or one the operator blocked, is a 404.
export async function loadPage(env, handle) {
  pathHandle(env, handle);
  const view = await bookingObject(env, handle).view(bookingTimes(env));
  if (view.state === 'none') throw notFound();
  return view;
}

// The profile as anyone may see it. Hidden types are kept, marked hidden: their own links still work.
export function publicProfile(page) {
  const p = page.profile;
  if (!p) return null;
  return {
    name: p.name,
    intro: p.intro,
    timeZone: p.timeZone,
    locale: p.locale,
    contact: p.contact,
    types: p.types.map((t) => ({
      slug: t.slug,
      title: t.title,
      duration: t.duration,
      description: t.description,
      location: publicLocation(t.location),
      needsApproval: t.confirm || page.stale,
      hidden: t.hidden
    }))
  };
}

function publicLocation(location) {
  const out = { kind: location.kind, label: location.label || LOCATION_LABEL[location.kind] };
  if (location.value) out.value = location.value;
  return out;
}

export function visibleTypes(profile) {
  return profile ? profile.types.filter((t) => !t.hidden) : [];
}

// ---- Times ----

const pad = (n) => String(n).padStart(2, '0');

// '2026-11-03T10:00:00+01:00': a moment on a zone's clock, with its offset.
export function isoIn(ms, zone) {
  const p = zonedParts(ms, zone);
  const off = Math.abs(p.offset);
  const seconds = pad(Math.floor((((ms % 60000) + 60000) % 60000) / 1000));
  return `${p.date}T${p.time}:${seconds}${p.offset < 0 ? '-' : '+'}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
}

// '2026-11-03T09:00:00Z'.
export function utcIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// '2026-11-03T09:00Z', the canonical slot in links.
export function slotParam(ms) {
  return utcIso(ms).replace(/:00Z$/, 'Z');
}

// 'Tue 3 Nov 2026'.
export function dayText(ms, zone) {
  const p = zonedParts(ms, zone);
  const [y, m, d] = p.date.split('-').map(Number);
  return `${WEEKDAYS[p.weekday]} ${d} ${MONTHS[m - 1]} ${y}`;
}

// 'Tue 3 Nov 2026 10:00–10:30 Europe/Amsterdam', for messages an assistant passes on.
export function whenText(start, end, zone) {
  const a = zonedParts(start, zone);
  const b = zonedParts(end, zone);
  const span = a.date === b.date || (b.time === '00:00' && end - start <= DAY) ? `${a.time}–${b.time}` : `${a.time} to ${dayText(end, zone)} ${b.time}`;
  return `${dayText(start, zone)} ${span} ${zone}`;
}

// 'UTC+01:00', 'UTC-03:00', 'UTC+05:45'.
export function offsetText(ms, zone) {
  const o = zonedParts(ms, zone).offset;
  return `UTC${o < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
}

// The day range of a slot listing, in a zone: from and to are dates, inclusive. Defaults: today and 13 days later.
export function slotRange({ from, to, timeZone }, now = Date.now()) {
  const today = zonedParts(now, timeZone).date;
  const start = from ?? (to ? (daysBetween(today, to) < 0 ? to : today) : today);
  const end = to ?? addDays(start, DEFAULT_SLOT_DAYS - 1);
  const days = daysBetween(start, end);
  if (days < 0) throw input.invalid('to must not be before from.', 'to');
  if (days > MAX_SLOT_DAYS) throw input.invalid(`from and to can be at most ${MAX_SLOT_DAYS} days apart.`, 'to');
  return {
    from: start,
    to: end,
    fromMs: zonedInstant(start, '00:00', timeZone),
    toMs: zonedInstant(addDays(end, 1), '00:00', timeZone)
  };
}

// ---- Reading and booking ----

// Open starts of one type in a date range on a zone's clock. query: { type, from, to, timeZone } as slotQuery()
// returns them. Returns { ok: true, page, type, starts, timeZone, from, to, nextFrom } or the object's failure.
export async function listSlots(env, handle, query) {
  pathHandle(env, handle);
  const stub = bookingObject(env, handle);
  const times = bookingTimes(env);
  const view = await stub.view(times);
  if (view.state === 'none') throw notFound();
  if (view.state === 'moved') return { ok: false, error: 'moved', movedTo: view.movedTo };
  if (!view.accepting) return { ok: false, error: 'not_accepting', page: view };
  const timeZone = query.timeZone ?? view.profile.timeZone;
  const range = slotRange({ from: query.from, to: query.to, timeZone });
  const result = await stub.slots({ type: query.type ?? null, from: range.fromMs, to: range.toMs }, times);
  if (!result.ok) return result;
  const horizonEnd = result.now + result.type.horizon * DAY;
  return {
    ok: true,
    page: result.page,
    type: result.type,
    starts: result.starts,
    timeZone,
    from: range.from,
    to: range.to,
    nextFrom: horizonEnd > range.toMs ? addDays(range.to, 1) : null
  };
}

// The next open times of every visible type (or of one type, hidden ones too), for the landing page, the type
// pages and llms.txt: the next days days, at most limit each.
export async function nextSlots(env, handle, { days = 7, limit = 40, slug = null } = {}) {
  const now = Date.now();
  const result = await bookingObject(env, handle).overview({ from: now, to: now + days * DAY, limit, slug }, bookingTimes(env));
  if (!result.ok && result.error === 'not_found') throw notFound();
  return result;
}

// Makes a booking. fields: what guestBooking() returns, timeZone already defaulted or null; ctx: { url, channel,
// idempotencyKey, network, locale }. Returns the object's result: { ok: true, outcome: 'created' | 'replayed' |
// 'already', booking, key, page } or { ok: false, error, ... }.
export async function createBooking(env, handle, fields, ctx) {
  pathHandle(env, handle);
  const stub = bookingObject(env, handle);
  return stub.book(
    {
      type: fields.type,
      start: fields.start,
      name: fields.name,
      email: fields.email,
      notes: fields.notes,
      timeZone: fields.timeZone,
      locale: fields.locale ?? ctx.locale ?? 'en',
      via: fields.via,
      channel: ctx.channel,
      idempotencyKey: ctx.idempotencyKey ?? null,
      network: ctx.network,
      uidHost: new URL(bookingOrigin(env, ctx.url)).host
    },
    bookingTimes(env)
  );
}

async function keyHash(key) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) return null;
  return sha256(utf8(key));
}

// A guest's booking by id and manage key. A wrong key, like an unknown id, is not_found.
export async function findBooking(env, handle, id, key) {
  pathHandle(env, handle);
  const hash = await keyHash(key);
  if (!hash || !input.BOOKING_ID.test(id)) return { ok: false, error: 'not_found' };
  return bookingObject(env, handle).guestGet(id, hash, bookingTimes(env));
}

export async function cancelBooking(env, handle, id, key) {
  pathHandle(env, handle);
  const hash = await keyHash(key);
  if (!hash || !input.BOOKING_ID.test(id)) return { ok: false, error: 'not_found' };
  return bookingObject(env, handle).guestCancel(id, hash, bookingTimes(env));
}

export async function rescheduleBooking(env, handle, id, key, start) {
  pathHandle(env, handle);
  const hash = await keyHash(key);
  if (!hash || !input.BOOKING_ID.test(id)) return { ok: false, error: 'not_found' };
  return bookingObject(env, handle).guestReschedule(id, hash, start, bookingTimes(env));
}

// The page's language for a request: ?lang, then Accept-Language, then the page's own.
export function requestLocale(request, url, fallback = 'en') {
  const asked = url.searchParams.get('lang');
  if (asked === 'en' || asked === 'nl') return asked;
  for (const part of (request.headers.get('accept-language') || '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (tag === 'nl' || tag.startsWith('nl-')) return 'nl';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return fallback;
}
