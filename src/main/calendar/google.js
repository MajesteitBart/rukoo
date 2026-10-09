'use strict';

const { t } = require('../../i18n');

// Google Calendar over its REST API, with the account's OAuth token. Events come back in the shape the calendar
// store keeps (see index.js); recurring events arrive as single instances because of singleEvents=true.
// https://developers.google.com/workspace/calendar/api/v3/reference
const { convert } = require('html-to-text');

const API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT = 20000;
const ACTIVATION_HOSTS = new Set(['console.developers.google.com', 'console.cloud.google.com']);

function calendarError(code, message, extra = {}) {
  return Object.assign(new Error(message), { calendar: true, code }, extra);
}

// The reason codes Google puts in an error, old style (errors[].reason) and new (details[].reason).
function reasons(body) {
  const e = (body && body.error) || {};
  return [...(e.errors || []).map((x) => x && x.reason), ...(e.details || []).map((x) => x && x.reason)].filter(Boolean).map(String);
}

function apiError(status, body) {
  const e = (body && body.error) || {};
  const why = reasons(body);
  if (status === 401) return calendarError('auth', t('errors.calendar.signIn'));
  if (status === 403 && why.some((r) => /^(insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT)$/.test(r))) {
    return calendarError('scope', t('errors.calendar.scope'));
  }
  if (status === 403 && why.some((r) => /^(accessNotConfigured|SERVICE_DISABLED)$/.test(r))) {
    // Google names the page that turns the API on for this client's project; only a link to its console is kept.
    const meta = (e.details || []).map((d) => d && d.metadata).find((m) => m && m.activationUrl);
    let url = 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com';
    try {
      const u = new URL(meta.activationUrl);
      if (u.protocol === 'https:' && ACTIVATION_HOSTS.has(u.hostname)) url = u.toString();
    } catch (_) {
      // No usable link in the error; the library page will do.
    }
    return calendarError('api_disabled', t('errors.calendar.apiDisabled'), { url });
  }
  if (status === 404 || status === 410) return calendarError('not_found', t('errors.calendar.notFound'));
  if (status === 409) return calendarError('conflict', t('errors.calendar.request', { reason: e.message || status }));
  if (status === 429 || why.some((r) => /rateLimitExceeded/.test(r))) return calendarError('busy', t('errors.calendar.busy'));
  return calendarError('request', t('errors.calendar.request', { reason: e.message || status }));
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// 'YYYY-MM-DD' as local midnight: all-day events belong to the day on the PC, wherever the calendar is.
function localDay(text) {
  const [y, m, d] = String(text).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function plainDescription(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  if (!/<[a-z][\s\S]*>/i.test(s)) return s.trim();
  try {
    return convert(s, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
        { selector: 'img', format: 'skip' }
      ]
    }).trim();
  } catch (_) {
    return s.replace(/<[^>]+>/g, ' ').trim();
  }
}

function person(p) {
  return p ? { name: String(p.displayName || ''), address: String(p.email || '').toLowerCase() } : null;
}

const RESPONSES = new Set(['needsAction', 'accepted', 'declined', 'tentative']);

function toEvent(item, cal) {
  const allDay = Boolean(item.start && item.start.date);
  const attendees = (item.attendees || [])
    .filter((a) => a && a.email && !a.resource)
    .map((a) => ({
      ...person(a),
      response: RESPONSES.has(a.responseStatus) ? a.responseStatus : 'needsAction',
      self: Boolean(a.self),
      organizer: Boolean(a.organizer),
      optional: Boolean(a.optional)
    }));
  const me = attendees.find((a) => a.self);
  const organizer = item.organizer ? { ...person(item.organizer), self: Boolean(item.organizer.self) } : null;
  const own = !organizer || organizer.self;
  const video = item.hangoutLink || ((item.conferenceData && item.conferenceData.entryPoints) || []).find((p) => p && p.entryPointType === 'video')?.uri || null;
  return {
    calendarId: cal.id,
    eventId: String(item.id),
    seriesId: item.recurringEventId ? String(item.recurringEventId) : null,
    title: String(item.summary || ''),
    location: String(item.location || ''),
    description: plainDescription(item.description),
    allDay,
    start: allDay ? localDay(item.start.date) : Date.parse(item.start.dateTime),
    end: allDay ? localDay(item.end.date) : Date.parse(item.end.dateTime),
    startDate: allDay ? item.start.date : null,
    endDate: allDay ? item.end.date : null,
    timeZone: (item.start && item.start.timeZone) || cal.timeZone || null,
    // A flight can start in one zone and land in another; each end keeps its own.
    endTimeZone: (item.end && item.end.timeZone) || (item.start && item.start.timeZone) || cal.timeZone || null,
    status: item.status === 'tentative' ? 'tentative' : 'confirmed',
    busy: item.transparency !== 'transparent',
    response: me && !own ? me.response : null,
    canEdit: Boolean(cal.writable && (own || item.guestsCanModify) && !item.locked && !item.privateCopy),
    canRespond: Boolean(me && !own),
    organizer,
    attendees,
    moreAttendees: Boolean(item.attendeesOmitted),
    link: /^https:\/\//.test(item.htmlLink || '') ? item.htmlLink : null,
    meeting: /^https:\/\//.test(video || '') ? video : null
  };
}

// The start and end Google wants. A patch that switches between all-day and timed clears the other field.
function times(input, timeZone, { patch = false, endTimeZone = timeZone } = {}) {
  if (input.allDay) {
    const clear = patch ? { dateTime: null, timeZone: null } : {};
    return { start: { ...clear, date: input.startDate }, end: { ...clear, date: input.endDate } };
  }
  const at = (ms, zone) => ({ ...(patch ? { date: null } : {}), dateTime: new Date(ms).toISOString(), ...(zone ? { timeZone: zone } : {}) });
  return { start: at(input.start, timeZone), end: at(input.end, endTimeZone) };
}

class GoogleCalendar {
  // token: () => Promise<string>, a valid access token for the account.
  constructor({ token, fetchImpl = (...a) => fetch(...a), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
    this.token = token;
    this.fetch = fetchImpl;
    this.timeZone = timeZone;
  }

  async request(method, path, { query = {}, body } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const token = await this.token();
    let res;
    try {
      res = await this.fetch(url.toString(), {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT)
      });
    } catch (_) {
      throw calendarError('network', t('errors.calendar.unreachable'));
    }
    if (res.status === 204) return null;
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      // A body that stops halfway is a failed request, never an empty answer: an empty list would clear the calendar.
      if (res.ok) throw calendarError('network', t('errors.calendar.unreachable'));
    }
    if (res.ok) return data;
    throw apiError(res.status, data);
  }

  // Every page, or an error: a list cut off at the limit would look complete and replace the cached events.
  async pages(path, query, max = 50) {
    const items = [];
    let pageToken;
    for (let i = 0; i < max; i++) {
      const page = await this.request('GET', path, { query: { ...query, pageToken } });
      items.push(...((page && page.items) || []));
      pageToken = page && page.nextPageToken;
      if (!pageToken) return items;
    }
    throw calendarError('too_many', t('errors.calendar.tooMany'));
  }

  async calendars() {
    const items = await this.pages('/users/me/calendarList', { maxResults: 250 });
    return items
      .filter((c) => c && c.id && c.accessRole !== 'freeBusyReader')
      .map((c) => ({
        id: String(c.id),
        name: String(c.summaryOverride || c.summary || c.id),
        primary: Boolean(c.primary),
        writable: c.accessRole === 'owner' || c.accessRole === 'writer',
        selected: c.selected !== false,
        timeZone: c.timeZone || null
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary));
  }

  async events(cal, start, end) {
    const items = await this.pages(`/calendars/${encodeURIComponent(cal.id)}/events`, {
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: new Date(start).toISOString(),
      timeMax: new Date(end).toISOString(),
      maxResults: 2500
    });
    // Working locations ("Home", "Office") are a status in Google Calendar, not something on the schedule.
    return items.filter((i) => i && i.status !== 'cancelled' && i.eventType !== 'workingLocation' && i.start).map((i) => toEvent(i, cal));
  }

  eventPath(cal, eventId) {
    return `/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(eventId)}`;
  }

  // input.id, when given, is the event's id: a Save that is tried again after a lost answer finds the event it
  // made the first time (Google answers 409) and gives it the latest fields instead of making a second one.
  async create(cal, input) {
    const fields = { summary: input.title, location: input.location, description: input.description };
    const body = { ...(input.id ? { id: input.id } : {}), ...fields, ...times(input, this.timeZone) };
    try {
      return toEvent(await this.request('POST', `/calendars/${encodeURIComponent(cal.id)}/events`, { body }), cal);
    } catch (err) {
      if (err.code !== 'conflict' || !input.id) throw err;
    }
    const made = await this.request('GET', this.eventPath(cal, input.id));
    if (!made.organizer || !made.organizer.self) throw calendarError('conflict', t('errors.calendar.readOnly'));
    const item = await this.request('PATCH', this.eventPath(cal, input.id), { query: { sendUpdates: 'none' }, body: { ...fields, ...times(input, this.timeZone, { patch: true }) } });
    return toEvent(item, cal);
  }

  // Changes this one event; for a recurring event that is this occurrence. The event keeps its own time zones.
  // Rukoo shows a description as plain text, so an untouched one stays out of the patch and keeps its formatting.
  async update(cal, event, input, { notify = false } = {}) {
    const body = {
      summary: input.title,
      location: input.location,
      ...(input.description !== event.description ? { description: input.description } : {}),
      ...times(input, event.timeZone, { patch: true, endTimeZone: event.endTimeZone || event.timeZone })
    };
    const item = await this.request('PATCH', this.eventPath(cal, event.eventId), { query: { sendUpdates: notify ? 'all' : 'none' }, body });
    return toEvent(item, cal);
  }

  async remove(cal, event, { notify = false, series = false } = {}) {
    const id = series && event.seriesId ? event.seriesId : event.eventId;
    await this.request('DELETE', this.eventPath(cal, id), { query: { sendUpdates: notify ? 'all' : 'none' } });
  }

  // An answer to an invitation: the user's own entry in the guest list. The organizer is told, as Google Calendar does.
  async respond(cal, event, response, { series = false } = {}) {
    const id = series && event.seriesId ? event.seriesId : event.eventId;
    const item = await this.request('GET', this.eventPath(cal, id));
    const attendees = (item.attendees || []).map((a) => (a.self ? { ...a, responseStatus: response } : a));
    if (!attendees.some((a) => a.self)) throw calendarError('not_invited', t('errors.calendar.notInvited'));
    await this.request('PATCH', this.eventPath(cal, id), { query: { sendUpdates: 'all' }, body: { attendees } });
  }
}

module.exports = { GoogleCalendar, toEvent, apiError, calendarError, dayKey, localDay };
