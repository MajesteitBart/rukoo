// Public booking pages (PROTOCOL.md, Public routes): at the root of BOOKING_ORIGIN, or under /meet without it. No
// session; every answer carries the booking pages' headers (http.js meetHeaders). Writes check where they come from
// before anything else, reads may be shared with other websites, and no GET or HEAD changes anything.

import { agentData, llmsTxt, siteLlmsTxt, wantsMarkdown } from './agent-text.js';
import * as api from './api.js';
import { BOOKER_JS } from './booker-script.js';
import { bookerPath, bookingOrigins, bookingPrefix, checkConfig, clientNetwork, limitRate } from './config.js';
import { NOINDEX, READ_CORS, meetEmpty, meetJson, meetText, redirect } from './http.js';
import * as input from './input.js';
import { HttpError } from './input.js';
import { mcp } from './mcp.js';
import { findBooking, links, pathHandle, requestLocale, utcIso } from './public.js';
import * as web from './web.js';

const JSON_BODY_MAX = 64 * 1024;
const READS = [/^$/, /^\/llms\.txt$/, /^\/api$/, /^\/api\/slots$/, /^\/api\/bookings\/[^/]+$/];

// Errors carry the booking pages' headers too, and a refused read can be read by the site that asked.
export async function meet(request, env, url) {
  try {
    return await route(request, env, url);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const sub = url.pathname.slice(bookingPrefix(env, url).length);
    const rest = sub.replace(/^\/[^/]+/, '');
    const read = request.method === 'GET' && sub !== '/mcp' && READS.slice(1).some((r) => r.test(rest));
    return meetJson(err.status, { error: err.code, message: err.message, ...err.extra }, { ...(read ? READ_CORS : {}), ...err.headers });
  }
}

async function route(request, env, url) {
  checkConfig(env);
  const prefix = bookingPrefix(env, url);
  const path = url.pathname;
  // The path after the prefix: /<handle>…, /mcp, and at the root /booker.js and /llms.txt.
  const sub = path.slice(prefix.length);
  const method = request.method;
  const reading = method === 'GET' || method === 'HEAD';
  if (sub === '/mcp') return mcp(request, env, url);
  if (path === bookerPath(env, url) && reading) {
    return meetText(200, BOOKER_JS, 'text/javascript; charset=utf-8', {}, method);
  }
  if (!prefix && sub === '/llms.txt' && reading) {
    return meetText(200, siteLlmsTxt(env, url), 'text/markdown; charset=utf-8', READ_CORS, method);
  }
  const match = sub.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) throw notFound();
  const rest = match[2] ?? '';
  // The pages people open answer their errors with pages; the JSON routes keep answering JSON.
  const page = match[1] !== 'assets' && web.isPage(method, rest);
  let handle;
  try {
    handle = pathHandle(env, match[1]);
  } catch (err) {
    if (page && err instanceof HttpError && err.status === 404) return web.missingPage(request, env, url, match[1]);
    throw err;
  }

  if (method === 'OPTIONS') return preflight(rest);
  if (method === 'POST') {
    try {
      writable(request, env, url);
    } catch (err) {
      if (page && err instanceof HttpError) return web.refusedPage(request, env, url, handle, err);
      throw err;
    }
  }
  if (page) {
    try {
      return rest === '' ? await landing(request, env, url, handle) : await web.route(request, env, url, handle, rest);
    } catch (err) {
      // A handle nobody has: the same page as for reserved and blocked ones.
      if (err instanceof HttpError && err.status === 404 && err.code === 'not_found') return web.missingPage(request, env, url, handle);
      throw err;
    }
  }

  if ((method === 'GET' || method === 'HEAD') && rest === '/llms.txt') return llms(request, env, url, handle);
  const reply = (result, extra = {}) => answer(request, url, rest, result, extra);
  if (method === 'GET') {
    if (rest === '/api') return reply(await api.getIndex(env, url, handle), READ_CORS);
    if (rest === '/api/slots') return reply(await api.getSlots(env, url, handle, url.searchParams), READ_CORS);
    const one = rest.match(/^\/api\/bookings\/([^/]+)$/);
    if (one) {
      const zone = input.guestZone(url.searchParams.get('time_zone'));
      return reply(await api.getGuestBooking(env, url, handle, one[1], bearer(request), zone), { ...READ_CORS, ...NOINDEX });
    }
    const ics = rest.match(/^\/booking\/([^/]+)\.ics$/);
    if (ics) return calendarFile(env, url, handle, ics[1], url.searchParams.get('k'));
  }
  if (method === 'POST') {
    if (rest === '/api/bookings') return reply(await book(request, env, url, handle), NOINDEX);
    const write = rest.match(/^\/api\/bookings\/([^/]+)\/(cancel|reschedule)$/);
    if (write) return reply(await change(request, env, url, handle, write[1], write[2]), NOINDEX);
  }
  throw notFound();
}

function notFound(message = 'There is nothing here.') {
  return new HttpError(404, 'not_found', message);
}

// A JSON answer. A renamed page's answer is a redirect to the same route under the new handle: 301 for reads,
// 308 for writes, so a client sends its POST again.
function answer(request, url, rest, { status, body, headers }, extra = {}) {
  if (status === 301) {
    const location = `${headers.location}${rest}${url.search}`;
    return meetJson(request.method === 'POST' ? 308 : 301, body, { ...extra, location });
  }
  return meetJson(status, body, { ...extra, ...headers });
}

// Reads may be fetched from other websites; writes get no preflight, so a browser never sends them cross-site.
function preflight(rest) {
  if (!READS.some((r) => r.test(rest))) throw notFound();
  return meetEmpty(204, {
    ...READ_CORS,
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'accept, authorization',
    'access-control-max-age': '86400'
  });
}

// A write from another website is refused before anything else: an Origin that isn't the page's own, or a browser
// saying the request is cross-site. Server-side clients send neither.
//
// The pages' own forms send their real Origin (Referrer-Policy: same-origin). A browser or an extension that forces
// no-referrer on every page makes it "Origin: null" (Fetch, "append a request Origin header"); that passes only together
// with Sec-Fetch-Site: same-origin, which no other website can make a browser send.
export function writable(request, env, url) {
  const origin = request.headers.get('origin');
  const site = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  const ours = origin === null || bookingOrigins(env, url).has(origin) || (origin === 'null' && site === 'same-origin');
  if (!ours || site === 'cross-site') {
    throw new HttpError(403, 'cross_site', "Booking from another website isn't allowed. Open the booking page itself.");
  }
}

async function jsonBody(request, env) {
  if (input.mediaType(request) !== 'application/json') {
    throw new HttpError(415, 'content_type', 'Send the body as application/json.');
  }
  await limitRate(request, env.BOOKING_LIMITER);
  return input.readJson(request, JSON_BODY_MAX);
}

function bearer(request) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(\S{1,200})$/i);
  return m ? m[1] : null;
}

async function book(request, env, url, handle) {
  const body = await jsonBody(request, env);
  const idempotencyKey = input.idempotencyKey(request.headers.get('idempotency-key'));
  return api.postBooking(env, url, handle, body, {
    channel: 'api',
    idempotencyKey,
    network: clientNetwork(request),
    locale: requestLocale(request, url, null)
  });
}

async function change(request, env, url, handle, id, action) {
  const body = await jsonBody(request, env);
  const key = bearer(request);
  return action === 'cancel'
    ? api.postCancel(env, url, handle, id, key, input.guestZone(body.time_zone))
    : api.postReschedule(env, url, handle, id, key, body);
}

async function llms(request, env, url, handle) {
  const data = await agentData(env, url, handle);
  if (data.moved) return moved(env, url, data.moved, '/llms.txt');
  return meetText(200, llmsTxt(data), 'text/markdown; charset=utf-8', READ_CORS, request.method);
}

function moved(env, url, to, rest) {
  return redirect(301, `${links(env, url, to).page}${rest}${url.search}`);
}

// GET|HEAD /<handle>. Markdown for clients that prefer it, else the page (web.js). Both vary with Accept, and
// the page with Accept-Language too, so they say both.
async function landing(request, env, url, handle) {
  const data = await agentData(env, url, handle);
  if (data.moved) return moved(env, url, data.moved, '');
  if (wantsMarkdown(request.headers.get('accept'))) {
    return meetText(200, llmsTxt(data), 'text/markdown; charset=utf-8', { vary: 'Accept, Accept-Language' }, request.method);
  }
  return web.landingPage(request, env, url, handle, data);
}

// ---- The guest's calendar file ----

// RFC 5545 text: backslash, semicolon, comma and line breaks escaped.
export function icsText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Lines of at most 75 octets, continued with a space, without splitting a character.
function fold(line) {
  const bytes = (s) => new TextEncoder().encode(s).length;
  if (bytes(line) <= 75) return line;
  const out = [];
  let current = '';
  for (const ch of line) {
    if (bytes(current + ch) > (out.length ? 74 : 75)) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.join('\r\n ');
}

const stamp = (ms) => utcIso(ms).replace(/[-:]/g, '');

export function icsFile({ booking, title, hostName, location, manageUrl, now = Date.now() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rukoo//Booking//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // The booking's UID, or the one the host's calendar gave the event when it kept another (owner action handled).
    `UID:${icsText(booking.uid)}`,
    // The host's invitation starts at 0 when it is made (at booking, or at the host's confirm) and goes up when the
    // meeting moves; status changes before that, such as the confirm itself, don't count.
    `SEQUENCE:${booking.sequence}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(booking.start)}`,
    `DTEND:${stamp(booking.end)}`,
    `SUMMARY:${icsText(`${title} with ${hostName}`)}`,
    ...(location ? [`LOCATION:${icsText(location)}`] : []),
    `DESCRIPTION:${icsText(`Change or cancel: ${manageUrl}`)}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

async function calendarFile(env, url, handle, id, key) {
  const result = await findBooking(env, handle, id, key);
  if (!result.ok && result.error === 'moved') return moved(env, url, result.movedTo, `/booking/${id}.ics`);
  if (!result.ok || result.booking.status !== 'confirmed') throw notFound('There is no such booking, or the key is wrong.');
  const p = result.page.profile;
  const type = p?.types.find((t) => t.slug === result.booking.type);
  const location = type ? [type.location.label, type.location.value].filter(Boolean).join(', ') : '';
  const body = icsFile({
    booking: result.booking,
    title: type?.title ?? result.booking.type,
    hostName: p?.name ?? handle,
    location,
    manageUrl: links(env, url, handle).manage(id, key)
  });
  return meetText(200, body, 'text/calendar; charset=utf-8', {
    'content-disposition': 'attachment; filename="booking.ics"',
    ...NOINDEX
  });
}
