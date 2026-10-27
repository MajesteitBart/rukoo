// The routes people open in a browser (PROTOCOL.md, Public routes): the landing page's HTML, a meeting type's booker
// and its filled-in form, the form's POST, and the guest's manage page with its POST. They go through the same
// service layer as the JSON API (public.js), so they offer the same times and refuse the same things, and they answer
// with pages: refusals show the form again with what was filled in.
//
// Every query parameter and form field is checked before use, and anything that doesn't fit is left out rather than
// echoed. No GET or HEAD changes anything: opening a filled-in form or a manage link books, holds and cancels nothing.

import { agentData, agentSection, assistantLine } from './agent-text.js';
import { DEFAULT_LOCALES, html, text } from './booking-text.js';
import { randomBytes, toBase64url } from './bytes.js';
import { clientNetwork, config, limitRate } from './config.js';
import { NOINDEX, meetText, redirect } from './http.js';
import * as input from './input.js';
import { HttpError } from './input.js';
import * as pages from './pages.js';
import { href } from './pages.js';
import {
  cancelBooking,
  checkSlot,
  createBooking,
  findBooking,
  links,
  listSlots,
  loadPage,
  nextSlots,
  requestLocale,
  rescheduleBooking,
  slotParam
} from './public.js';
import { DAY, isDate, isZone, zonedParts } from './zone.js';

const MINUTE = 60000;
const ACTIVE = ['pending', 'confirmed'];
const GUEST_RESCHEDULES = 2;
const LOCALE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,6}$/;
const FIELD_ERRORS = { name: 'error.name', email: 'error.email', notes: 'error.notes', via: 'error.via' };
const REFUSED = { cross_site: 'error.crossSite', rate_limited: 'error.rateLimited', content_type: 'error.form', too_large: 'error.form', invalid: 'error.form' };

// Whether a path under /meet/<handle> is one of the pages, whose errors are pages too.
export function isPage(method, rest) {
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return false;
  if (rest === '') return method !== 'POST';
  if (/^\/booking\/[^/]+$/.test(rest)) return !rest.endsWith('.ics');
  return /^\/[^/]+$/.test(rest) && rest !== '/api' && rest !== '/llms.txt';
}

// GET|HEAD /meet/<handle>/<slug>, POST to the same, and the manage page.
export async function route(request, env, url, handle, rest) {
  const booking = rest.match(/^\/booking\/([^/]+)$/);
  if (booking) {
    return request.method === 'POST' ? managePost(request, env, url, handle, booking[1]) : managePage(request, env, url, handle, booking[1]);
  }
  const slug = rest.slice(1);
  return request.method === 'POST' ? bookPost(request, env, url, handle, slug) : typePage(request, env, url, handle, slug);
}

// ---- What every page needs ----

// The locale times are written in: the browser's most wanted Accept-Language tag in the page's language (en-US gives a
// 12-hour clock), else the language's own default. Tags are checked against what the runtime knows.
export function formatLocale(header, lang) {
  const tags = String(header || '')
    .split(',')
    .slice(0, 20)
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      let q = 1;
      for (const p of params) {
        const [k, v] = p.trim().split('=');
        if (k === 'q') q = Number(v);
      }
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((e) => e.q > 0 && LOCALE_TAG.test(e.tag) && e.tag.split('-')[0].toLowerCase() === lang)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of tags) {
    try {
      const [known] = Intl.DateTimeFormat.supportedLocalesOf([tag]);
      if (known) return known;
    } catch {
      // A tag Intl can't read is skipped.
    }
  }
  return DEFAULT_LOCALES[lang];
}

function hour12Of(locale) {
  const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return cycle === 'h11' || cycle === 'h12';
}

// The first day of the week in a locale, 0 for Sunday; Monday when the runtime can't say.
function weekStartOf(locale) {
  try {
    const l = new Intl.Locale(locale);
    const info = typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    // Monday below.
  }
  return 1;
}

// The language, locale, zone and clock of one page, and the helpers its renderer uses. source: where tz, lang and
// clock come from, the query or a posted form. Without tz the host's zone is used, never one guessed from the address;
// booker.js may switch to the browser's.
function context(request, env, url, handle, profile, source = url.searchParams, { known = true } = {}) {
  const asked = source.get('lang');
  const lang = requestLocale(request, { searchParams: source }, profile?.locale ?? 'en');
  const locale = formatLocale(request.headers.get('accept-language'), lang);
  const tzText = source.get('tz');
  const tz = tzText && isZone(tzText) ? tzText : null;
  const clockText = source.get('clock');
  const clock = clockText === '12' || clockText === '24' ? clockText : null;
  const hour12 = clock ? clock === '12' : hour12Of(locale);
  const zone = tz ?? profile?.timeZone ?? 'UTC';
  // What links carry on: only what the guest chose, so defaults stay defaults.
  const keep = {};
  if (asked === 'en' || asked === 'nl') keep.lang = asked;
  if (tz) keep.tz = tz;
  if (clock) keep.clock = clock;
  return {
    lang,
    locale,
    hour12,
    clock: hour12 ? '12' : '24',
    zone,
    zoneAuto: !tz,
    clockAuto: !clock,
    keep,
    url,
    T: (key, values) => text(lang, key, values),
    H: (key, values) => html(lang, key, values),
    f: pages.formatter(locale, zone, hour12),
    host: profile?.name ?? null,
    links: known ? links(env, url, handle) : null,
    base: `/meet/${handle}`,
    operator: config(env, url).operator,
    weekStart: weekStartOf(locale),
    languageLink: (l) => {
      const q = new URLSearchParams(url.searchParams);
      q.set('lang', l);
      return `${url.pathname}?${q}`;
    }
  };
}

// An HTML answer with the /meet headers, the llms.txt link and, for addresses with guest details or keys, noindex.
function respond(ctx, request, status, body, { landing = false, noindex = false, headers = {} } = {}) {
  const extra = { vary: landing ? 'Accept, Accept-Language' : 'Accept-Language', ...headers };
  if (ctx.links) extra.link = `<${ctx.links.llmsTxt}>; rel="alternate"; type="text/markdown"`;
  if (noindex) Object.assign(extra, NOINDEX);
  return meetText(status, body, 'text/html; charset=utf-8', extra, request.method);
}

// To the same page under the handle it was renamed to: 301 for reads, 308 for posts, so the browser sends the form
// again there.
function movedPage(request, env, url, to, rest) {
  return redirect(request.method === 'POST' ? 308 : 301, `${links(env, url, to).page}${rest}${request.method === 'POST' ? '' : url.search}`);
}

function seeOther(location) {
  return redirect(303, location, NOINDEX);
}

// A random Idempotency-Key for each form: pressing Book twice gives the same booking and the same manage page.
function newIdem() {
  return toBase64url(randomBytes(16));
}

export function missingPage(request, env, url, handle) {
  const ctx = context(request, env, url, handle, null, url.searchParams, { known: false });
  return respond(ctx, request, 404, pages.missingHtml(ctx, { kind: 'page' }));
}

// A form post refused before its page was read: from another website, the wrong body or too big.
export function refusedPage(request, env, url, handle, err) {
  const ctx = context(request, env, url, handle, null, url.searchParams, { known: false });
  return respond(ctx, request, err.status, pages.refusedHtml(ctx, ctx.T(REFUSED[err.code] ?? 'error.server')), { noindex: true, headers: err.headers });
}

async function readFormOr(request, env, url, handle) {
  try {
    return { form: await input.readForm(request) };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { refused: refusedPage(request, env, url, handle, err) };
  }
}

// ---- Query parameters ----

function cut(value, max) {
  return Array.from(String(value ?? '')).slice(0, max).join('');
}

// An address from a link or a form: a URL turns '+' into a space, and no address has a space, so it goes back.
function emailText(value) {
  return String(value ?? '')
    .trim()
    .replace(/ /g, '+');
}

// month (YYYY-MM), date (YYYY-MM-DD), slot (a start, Z or an offset), the guest's fields and reschedule=<id>&k=.
export function typeQuery(q) {
  const monthText = q.get('month') ?? '';
  const month = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthText) ? monthText : null;
  const dateText = q.get('date') ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText) && isDate(dateText) ? dateText : null;
  const slotText = q.get('slot');
  let slot = null;
  let badSlot = false;
  if (slotText !== null && slotText !== '') {
    try {
      slot = input.instant(slotText, 'slot');
    } catch {
      badSlot = true;
    }
  }
  const fields = { name: cut(q.get('name'), 80), email: cut(emailText(q.get('email')), 254), notes: cut(q.get('notes'), 1000), via: cut(q.get('via'), 80) };
  const filled = Object.values(fields).some(Boolean);
  const id = q.get('reschedule');
  const reschedule = id ? { id: cut(id, 64), key: cut(q.get('k'), 200) } : null;
  return { month, date: month && date && !date.startsWith(month) ? null : date, slot, badSlot, fields, filled, reschedule };
}

// An address with a time, guest details or a manage key in it is kept out of search engines, whatever page it shows.
function privateQuery(q) {
  return q.slot !== null || q.badSlot || q.filled || Boolean(q.reschedule);
}

// ---- Landing and booker ----

// GET /meet/<handle> as HTML. data: agentData() for the page, already loaded for the markdown check.
export async function landingPage(request, env, url, handle, data) {
  const page = data.page;
  const profile = page.profile;
  const ctx = context(request, env, url, handle, profile);
  const q = typeQuery(url.searchParams);
  const noindex = privateQuery(q);
  if (!data.accepting || !profile) return respond(ctx, request, 200, pages.offHtml(ctx, profile), { landing: true, noindex });
  const visible = profile.types.filter((t) => !t.hidden);
  if (visible.length === 1) {
    return bookerPage(ctx, request, env, handle, { page, type: visible[0], landing: true, data, q });
  }
  const body = pages.landingHtml(ctx, {
    profile,
    types: visible,
    slots: data.slots,
    approval: (t) => t.confirm || page.stale,
    agentSection: agentSection(data),
    assistantLine: assistantLine(data)
  });
  return respond(ctx, request, 200, body, { landing: true, noindex });
}

async function typePage(request, env, url, handle, slug) {
  const page = await loadPage(env, handle);
  if (page.state === 'moved') return movedPage(request, env, url, page.movedTo, `/${slug}`);
  const profile = page.profile;
  const ctx = context(request, env, url, handle, profile);
  const q = typeQuery(url.searchParams);
  const noindex = privateQuery(q);
  if (!page.accepting || !profile) return respond(ctx, request, 200, pages.offHtml(ctx, profile), { noindex });
  const type = profile.types.find((t) => t.slug === slug);
  if (!type) return respond(ctx, request, 404, pages.missingHtml(ctx, { kind: 'type', profile }), { noindex });

  let reschedule = null;
  if (q.reschedule) {
    const found = await findBooking(env, handle, q.reschedule.id, q.reschedule.key);
    if (!found.ok && found.error === 'moved') return movedPage(request, env, url, found.movedTo, `/${slug}`);
    if (!found.ok) return respond(ctx, request, 404, pages.missingHtml(ctx, { kind: 'booking', profile }), { noindex: true });
    const b = found.booking;
    // A booking of another type, or one that can't move any more: its manage page says why.
    if (b.type !== slug || !ACTIVE.includes(b.status) || b.start <= Date.now() || b.reschedules >= GUEST_RESCHEDULES) {
      return seeOther(href(`${ctx.base}/booking/${b.id}`, { k: q.reschedule.key, ...ctx.keep }));
    }
    reschedule = { booking: b, key: q.reschedule.key };
  }

  // The booking's own time isn't a new one: a link to it shows the booker.
  if (q.slot !== null && q.slot !== reschedule?.booking.start) return preparedPage(ctx, request, env, handle, { page, type, q, reschedule });
  const data = reschedule ? null : await agentData(env, url, handle, { slug, page });
  return bookerPage(ctx, request, env, handle, { page, type, landing: false, data, q, reschedule });
}

async function bookerPage(ctx, request, env, handle, { page, type, landing, data, q, reschedule = null }) {
  const zone = ctx.zone;
  const now = Date.now();
  const today = zonedParts(now, zone).date;
  const thisMonth = today.slice(0, 7);
  const lastMonth = pages.monthOf(now + type.horizon * DAY, zone);
  const exclude = reschedule ? { id: reschedule.booking.id, key: reschedule.key } : null;
  // While a booking moves it doesn't block its own neighbours, but its own time isn't offered: it isn't a new one.
  const own = reschedule ? reschedule.booking.start : null;

  // The first open time decides where the month opens; the agent data usually has it already.
  let first = exclude ? null : (data?.slots?.[type.slug]?.[0] ?? null);
  if (first === null) {
    const next = await nextSlots(env, handle, { days: type.horizon + 1, limit: own === null ? 1 : 2, slug: type.slug, exclude });
    first = next.ok ? ((next.slots?.[type.slug] ?? []).find((s) => s !== own) ?? null) : null;
  }
  let month = q.month ?? q.date?.slice(0, 7) ?? (first !== null ? pages.monthOf(first, zone) : thisMonth);
  if (month < thisMonth) month = thisMonth;
  if (month > lastMonth) month = lastMonth;

  const byDate = new Map();
  if (first !== null) {
    const listed = await listSlots(env, handle, { type: type.slug, from: `${month}-01`, to: pages.lastDay(month), timeZone: zone, exclude });
    for (const s of listed.ok ? listed.starts : []) {
      if (s === own) continue;
      const d = zonedParts(s, zone).date;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }
  }
  let date = q.date && q.date.startsWith(month) ? q.date : null;
  if (!date && first !== null) date = pages.monthOf(first, zone) === month ? zonedParts(first, zone).date : ([...byDate.keys()][0] ?? null);

  const keep = { ...ctx.keep };
  if (reschedule) Object.assign(keep, { reschedule: reschedule.booking.id, k: reschedule.key });
  // Fields an assistant put in the link travel with every day and time, so the form opens filled in.
  if (q.filled) Object.assign(keep, q.fields);
  const v = {
    profile: page.profile,
    type,
    landing,
    reschedule,
    badSlot: q.badSlot,
    approval: type.confirm || page.stale,
    month,
    days: pages.monthDays(month, new Set(byDate.keys()), today),
    date,
    times: date ? (byDate.get(date) ?? []) : [],
    first,
    prevMonth: month > thisMonth ? pages.addMonths(month, -1) : null,
    nextMonth: month < lastMonth ? pages.addMonths(month, 1) : null,
    path: landing ? ctx.base : `${ctx.base}/${type.slug}`,
    slotPath: `${ctx.base}/${type.slug}`,
    keep,
    weekStart: ctx.weekStart,
    agentSection: data ? agentSection(data) : '',
    assistantLine: data ? assistantLine(data) : ''
  };
  return respond(ctx, request, 200, pages.bookerHtml(ctx, v), { landing, noindex: Boolean(reschedule) || privateQuery(q) });
}

// GET /meet/<handle>/<slug>?slot=: the form for that time, filled in from the link, or the nearest open times when
// it is gone. With reschedule, the confirmation of the move instead.
async function preparedPage(ctx, request, env, handle, { page, type, q, reschedule }) {
  const exclude = reschedule ? { id: reschedule.booking.id, key: reschedule.key } : null;
  const check = await checkSlot(env, handle, { type: type.slug, start: q.slot, exclude });
  if (!check.ok) return refusal(ctx, request, env, { page, error: check.error, movedTo: check.movedTo, rest: `/${type.slug}` });
  const start = q.slot;
  const end = start + type.duration * MINUTE;
  if (reschedule) {
    const alternatives = otherTimes(check.alternatives, reschedule.booking);
    const body = pages.rescheduleHtml(ctx, { profile: page.profile, type, booking: reschedule.booking, key: reschedule.key, start, end, open: check.open, alternatives, switchable: true });
    return respond(ctx, request, 200, body, { noindex: true });
  }
  const body = pages.formHtml(ctx, {
    profile: page.profile,
    type,
    start,
    end,
    fields: q.fields,
    filled: q.filled,
    open: check.open,
    alternatives: check.alternatives,
    approval: type.confirm || page.stale,
    idem: newIdem(),
    multiple: true,
    switchable: true
  });
  return respond(ctx, request, 200, body, { noindex: true });
}

// The nearest open times offered for a move, without the time the booking already has.
function otherTimes(alternatives, booking) {
  return (alternatives ?? []).filter((s) => s !== booking.start);
}

// The object refused before anything was shown: the page moved, closed, or lost the type.
function refusal(ctx, request, env, { page, error, movedTo, rest, status }) {
  if (error === 'moved') return movedPage(request, env, ctx.url, movedTo, rest);
  if (error === 'not_accepting') return respond(ctx, request, status ?? 200, pages.offHtml(ctx, page.profile), { noindex: true });
  return respond(ctx, request, 404, pages.missingHtml(ctx, { kind: 'type', profile: page.profile }), { noindex: true });
}

// ---- Booking with the form ----

// POST /meet/<handle>/<slug>: books, then 303 to the manage page; or the form again with the error and the fields.
async function bookPost(request, env, url, handle, slug) {
  const read = await readFormOr(request, env, url, handle);
  if (read.refused) return read.refused;
  const form = read.form;
  const page = await loadPage(env, handle);
  if (page.state === 'moved') return movedPage(request, env, url, page.movedTo, `/${slug}`);
  const profile = page.profile;
  const ctx = context(request, env, url, handle, profile, form);
  const fields = { name: form.get('name') ?? '', email: emailText(form.get('email')), notes: form.get('notes') ?? '', via: form.get('via') ?? '' };
  const startText = form.get('start') ?? '';
  let start = null;
  try {
    start = input.instant(startText, 'start');
  } catch {
    start = null;
  }
  ctx.languageLink = (l) => href(`${ctx.base}/${slug}`, { ...ctx.keep, lang: l, slot: start === null ? null : slotParam(start), ...fields });
  if (!page.accepting || !profile) return respond(ctx, request, 409, pages.offHtml(ctx, profile), { noindex: true });
  const type = profile.types.find((t) => t.slug === slug);
  if (!type) return respond(ctx, request, 404, pages.missingHtml(ctx, { kind: 'type', profile }), { noindex: true });

  let idem = null;
  try {
    idem = input.idempotencyKey(form.get('idem') || null);
  } catch {
    idem = null;
  }
  const approval = type.confirm || page.stale;
  // The form again, as it was sent, with what went wrong. A start that can't be read shows the booker instead.
  const again = (status, error, extra = {}, headers = {}) => {
    if (start === null) {
      return bookerPage(ctx, request, env, handle, { page, type, landing: false, data: null, q: { ...typeQuery(new URLSearchParams()), badSlot: true } }).then((res) => withStatus(res, status));
    }
    const body = pages.formHtml(ctx, { profile, type, start, end: start + type.duration * MINUTE, fields, filled: false, open: true, alternatives: [], approval, idem: idem ?? newIdem(), multiple: true, switchable: false, error, ...extra });
    return respond(ctx, request, status, body, { noindex: true, headers });
  };

  try {
    await limitRate(request, env.BOOKING_LIMITER);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return again(429, { message: ctx.T('error.rateLimited') }, {}, err.headers);
    throw err;
  }
  let booking;
  try {
    // The zone the page was written in: tz when the server can read it, else the host's. The guest can't change a
    // hidden field, so a zone this server doesn't know never refuses the booking.
    booking = input.guestBooking({ type: slug, start: startText, name: fields.name, email: fields.email, notes: fields.notes, time_zone: ctx.zone, via: fields.via });
  } catch (err) {
    if (!(err instanceof HttpError) || err.code !== 'invalid') throw err;
    const field = err.extra.field;
    return again(400, { field, message: ctx.T(FIELD_ERRORS[field] ?? 'error.start') });
  }
  booking.locale = ctx.lang;

  const result = await createBooking(env, handle, booking, { url, channel: 'web', idempotencyKey: idem, network: clientNetwork(request), locale: ctx.lang });
  if (result.ok) {
    if (result.key) return seeOther(href(`${ctx.base}/booking/${result.booking.id}`, { k: result.key, tz: booking.timeZone, lang: ctx.keep.lang, clock: ctx.keep.clock }));
    const body = pages.alreadyHtml(ctx, { profile, type, start: result.booking.start, end: result.booking.end, email: booking.email });
    return respond(ctx, request, 200, body, { noindex: true });
  }
  const host = profile.name;
  switch (result.error) {
    case 'slot_taken': {
      const alternatives = result.alternatives ?? [];
      return again(409, { message: ctx.T(alternatives.length ? 'error.slotTaken' : 'error.slotTakenNone') }, { open: false, alternatives });
    }
    case 'limit_reached':
      return again(403, { message: ctx.T(`error.limit.${result.limit}`, { host }) });
    case 'idempotency_mismatch':
      idem = newIdem();
      return again(409, { message: ctx.T('error.idempotency') });
    default:
      return refusal(ctx, request, env, { page, error: result.error, movedTo: result.movedTo, rest: `/${slug}`, status: 409 });
  }
}

function withStatus(res, status) {
  return new Response(res.body, { status, headers: res.headers });
}

// ---- The guest's manage page ----

function manageView(ctx, found, key, { error = null, switchable = true } = {}) {
  const b = found.booking;
  const now = Date.now();
  const profile = found.page.profile;
  const type = profile?.types.find((t) => t.slug === b.type) ?? null;
  const canMove = Boolean(type && found.page.accepting && ACTIVE.includes(b.status) && b.start > now && b.reschedules < GUEST_RESCHEDULES);
  return pages.manageHtml(ctx, { profile, booking: b, type, key, now, canMove, error, switchable });
}

async function managePage(request, env, url, handle, id) {
  const key = url.searchParams.get('k') ?? '';
  const found = await findBooking(env, handle, id, key);
  if (!found.ok && found.error === 'moved') return movedPage(request, env, url, found.movedTo, `/booking/${id}`);
  if (!found.ok) {
    // The same answer whether the page, the booking or only the key is wrong.
    const ctx = context(request, env, url, handle, null, url.searchParams, { known: false });
    return respond(ctx, request, 404, pages.missingHtml(ctx, { kind: 'booking' }), { noindex: true });
  }
  const ctx = context(request, env, url, handle, found.page.profile);
  return respond(ctx, request, 200, manageView(ctx, found, key), { noindex: true });
}

// POST /meet/<handle>/booking/<id>: k, action (cancel or reschedule), and for a move start and tz. 303 back to the
// manage page, or the page again with the error.
async function managePost(request, env, url, handle, id) {
  const read = await readFormOr(request, env, url, handle);
  if (read.refused) return read.refused;
  const form = read.form;
  const key = form.get('k') ?? '';
  const action = form.get('action');
  const current = await findBooking(env, handle, id, key);
  if (!current.ok && current.error === 'moved') return movedPage(request, env, url, current.movedTo, `/booking/${id}`);
  if (!current.ok) {
    const ctx = context(request, env, url, handle, null, form, { known: false });
    return respond(ctx, request, 404, pages.missingHtml(ctx, { kind: 'booking' }), { noindex: true });
  }
  const ctx = context(request, env, url, handle, current.page.profile, form);
  const back = href(`${ctx.base}/booking/${id}`, { k: key, ...ctx.keep });
  ctx.languageLink = (l) => href(`${ctx.base}/booking/${id}`, { k: key, ...ctx.keep, lang: l });
  const host = current.page.profile?.name ?? ctx.T('page.anon');
  const shown = async (status, message, headers = {}) => {
    const fresh = await findBooking(env, handle, id, key);
    const found = fresh.ok ? fresh : current;
    return respond(ctx, request, status, manageView(ctx, found, key, { error: { message }, switchable: false }), { noindex: true, headers });
  };

  try {
    await limitRate(request, env.BOOKING_LIMITER);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return shown(429, ctx.T('error.rateLimited'), err.headers);
    throw err;
  }
  let result;
  if (action === 'cancel') {
    result = await cancelBooking(env, handle, id, key);
  } else if (action === 'reschedule') {
    let start;
    try {
      start = input.instant(form.get('start') ?? '', 'start');
    } catch {
      return shown(400, ctx.T('error.start'));
    }
    result = await rescheduleBooking(env, handle, id, key, start);
    if (!result.ok && result.error === 'slot_taken') {
      const profile = current.page.profile;
      const type = profile?.types.find((t) => t.slug === current.booking.type);
      if (type) {
        const alternatives = otherTimes(result.alternatives, current.booking);
        const body = pages.rescheduleHtml(ctx, {
          profile,
          type,
          booking: current.booking,
          key,
          start,
          end: start + (current.booking.end - current.booking.start),
          open: false,
          alternatives,
          error: { message: ctx.T(alternatives.length ? 'error.slotTaken' : 'error.slotTakenNone') }
        });
        return respond(ctx, request, 409, body, { noindex: true });
      }
    }
  } else {
    return shown(400, ctx.T('error.form'));
  }
  if (result.ok) return seeOther(back);
  switch (result.error) {
    case 'moved':
      return movedPage(request, env, url, result.movedTo, `/booking/${id}`);
    case 'limit_reached':
      return shown(403, ctx.T(`error.limit.${result.limit}`, { host }));
    case 'not_accepting':
      return shown(409, ctx.T('off.host', { host }));
    case 'slot_taken':
      return shown(409, ctx.T('error.slotTakenNone'));
    case 'not_found': {
      const body = pages.missingHtml(ctx, { kind: 'booking' });
      return respond(ctx, request, 404, body, { noindex: true });
    }
    default:
      return shown(409, ctx.T('error.notActive'));
  }
}
