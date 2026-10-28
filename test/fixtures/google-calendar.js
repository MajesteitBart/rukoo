'use strict';

// A fake Google Calendar API and the helpers the calendar store's tests share: a profile with one Google account
// whose grant covers the calendar, waiting for background fetches, and dates in the current local week.
const fs = require('fs');
const path = require('path');
const { tempDir } = require('../tmp');
const { Engine } = require('../../src/main/engine');
const { Calendars } = require('../../src/main/calendar');
const { CALENDAR_SCOPES } = require('../../src/main/google');
const { zonedParts, zonedInstant, addDays, weekday } = require('../../src/main/calendar/zone');

const DAY = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const pad = (n) => String(n).padStart(2, '0');
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const isObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const basicUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// ---------- repeat rules, worked out on their own so the tests don't check the code with itself ----------

const parseRule = (text) => Object.fromEntries(text.split(';').map((p) => p.split('=')));

function monthDates(rule, year, month, startDate) {
  const ym = `${year}-${pad(month)}`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (rule.BYDAY) {
    const out = [];
    for (const part of rule.BYDAY.split(',')) {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(part);
      const all = [];
      for (let d = 1; d <= last; d++) if (weekday(`${ym}-${pad(d)}`) === WEEKDAYS.indexOf(m[2])) all.push(`${ym}-${pad(d)}`);
      if (!m[1]) out.push(...all);
      else {
        const n = Number(m[1]);
        const pick = n > 0 ? all[n - 1] : all[all.length + n];
        if (pick) out.push(pick);
      }
    }
    return out.sort();
  }
  const days = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : [Number(startDate.slice(8))];
  return days
    .map((d) => (d < 0 ? last + d + 1 : d))
    .filter((d) => d >= 1 && d <= last)
    .map((d) => `${ym}-${pad(d)}`)
    .sort();
}

// The dates a rule makes from the series' first date on, in order (WKST=MO).
function* ruleDates(rule, startDate) {
  const interval = Number(rule.INTERVAL || 1);
  const [y0, m0] = startDate.split('-').map(Number);
  for (let k = 0; k < 4000; k++) {
    let dates = [];
    if (rule.FREQ === 'DAILY') dates = [addDays(startDate, k * interval)];
    else if (rule.FREQ === 'WEEKLY') {
      const monday = addDays(startDate, -((weekday(startDate) + 6) % 7) + 7 * k * interval);
      const days = rule.BYDAY ? rule.BYDAY.split(',').map((d) => WEEKDAYS.indexOf(d)) : [weekday(startDate)];
      dates = days.map((d) => addDays(monday, (d + 6) % 7)).sort();
    } else if (rule.FREQ === 'MONTHLY') {
      const total = m0 - 1 + k * interval;
      dates = monthDates(rule, y0 + Math.floor(total / 12), (total % 12) + 1, startDate);
    } else if (rule.FREQ === 'YEARLY') {
      const d = `${y0 + k * interval}-${startDate.slice(5)}`;
      if (!Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).getUTCDate() === Number(d.slice(8))) dates = [d];
    }
    for (const d of dates) if (d >= startDate) yield d;
  }
}

// EXDATE values: instants for timed series, dates for all-day ones.
function exdates(lines, zone) {
  const out = new Set();
  for (const line of lines) {
    const m = /^EXDATE((?:;[^:]*)?):(.+)$/.exec(line);
    if (!m) continue;
    const tz = (/TZID=([^;:]+)/.exec(m[1]) || [])[1] || zone;
    for (const v of m[2].split(',')) {
      const d = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
      const date = `${d[1]}-${d[2]}-${d[3]}`;
      if (!d[4]) out.add(date);
      else out.add(d[7] ? Date.UTC(+d[1], d[2] - 1, +d[3], +d[4], +d[5], +d[6]) : zonedInstant(date, `${d[4]}:${d[5]}`, tz));
    }
  }
  return out;
}

// The occurrences of a series up to a moment: COUNT counts EXDATE'd ones too, as RFC 5545 says.
function occurrences(master, until) {
  const lines = master.recurrence || [];
  const line = lines.find((l) => l.startsWith('RRULE:'));
  if (!line) return [];
  const rule = parseRule(line.slice(6));
  const allDay = Boolean(master.start.date);
  const zone = master.start.timeZone || 'UTC';
  const startMs = allDay ? null : Date.parse(master.start.dateTime);
  const first = allDay ? master.start.date : zonedParts(startMs, zone).date;
  const time = allDay ? null : zonedParts(startMs, zone).time;
  const skip = exdates(lines, zone);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  let last = null;
  if (rule.UNTIL) {
    const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(rule.UNTIL);
    const date = `${u[1]}-${u[2]}-${u[3]}`;
    last = allDay ? date : u[4] ? Date.UTC(+u[1], u[2] - 1, +u[3], +u[4], +u[5], +u[6]) : zonedInstant(addDays(date, 1), '00:00', zone) - 1;
  }
  const out = [];
  let n = 0;
  for (const date of ruleDates(rule, first)) {
    const at = allDay ? date : zonedInstant(date, time, zone);
    if (last !== null && at > last) break;
    if (++n > count) break;
    if (allDay ? date > until.date : at > until.ms) break;
    if (!skip.has(at)) out.push(allDay ? { date } : { ms: at });
  }
  return out;
}

function instanceOf(master, occ) {
  const { id, recurrence, etag, ...rest } = master;
  const out = { ...clone(rest), recurringEventId: id, etag, iCalUID: master.iCalUID };
  if (occ.date) {
    const days = daysBetween(master.start.date, master.end.date);
    return { ...out, id: `${id}_${occ.date.replace(/-/g, '')}`, start: { date: occ.date }, end: { date: addDays(occ.date, days) }, originalStartTime: { date: occ.date } };
  }
  const length = Date.parse(master.end.dateTime) - Date.parse(master.start.dateTime);
  const zone = master.start.timeZone ? { timeZone: master.start.timeZone } : {};
  const start = { dateTime: new Date(occ.ms).toISOString(), ...zone };
  const end = { dateTime: new Date(occ.ms + length).toISOString(), ...(master.end.timeZone ? { timeZone: master.end.timeZone } : {}) };
  return { ...out, id: `${id}_${basicUtc(occ.ms)}`, start, end, originalStartTime: { ...start } };
}

// A Google Calendar with four calendars, answering the calls Rukoo makes and recording them. Like Google, it names
// selected only for calendars that show, gives every event an etag that changes with it, answers a change sent
// with an older etag in If-Match with 412, expands series into occurrences for singleEvents=true (an occurrence that
// is changed or deleted becomes an exception of its own), keeps deleted events as cancelled (410 after that), makes a
// Meet link only with conferenceDataVersion=1 (pending for a few reads with conference: 'pending'), moves events
// between calendars, and finds events by q, by iCalUID and by a private extended property.
// Two things Google's reference leaves open are options. insertUid: what events.insert does with an iCalUID in the
// body; its reference doesn't list the field, so by default the fake ignores it and makes its own ('keep' honours it
// and answers 409 for one it has). attendeeCap: how many guests Google sends back at most; an event with more comes
// back with only the user's own entry and attendeesOmitted, also when maxAttendees asks for more.
// fail answers a request before the fake looks at it; lose lets the fake carry it out and then loses the answer, as
// on a connection that drops: fetch fails, or with a status the answer is that error instead.
function fakeCalendar({ events = [], fail = null, lose = null, conference = 'ready', pendingReads = 1, insertUid = 'ignore', attendeeCap = Infinity } = {}) {
  const calendars = [
    {
      id: 'me@example.com',
      summary: 'me@example.com',
      primary: true,
      accessRole: 'owner',
      timeZone: 'Europe/Amsterdam',
      selected: true,
      backgroundColor: '#9FE1E7',
      conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] },
      defaultReminders: [
        { method: 'popup', minutes: 10 },
        { method: 'email', minutes: 1440 }
      ]
    },
    { id: 'nl#holiday@group.v.calendar.google.com', summary: 'Holidays', accessRole: 'reader', selected: false, backgroundColor: '#16a765' },
    { id: 'busy@example.com', summary: 'Free/busy only', accessRole: 'freeBusyReader' },
    { id: 'team@example.com', summary: 'Team', accessRole: 'writerWithoutPrivateAccess', backgroundColor: '#FA573C', conferenceProperties: { allowedConferenceSolutionTypes: ['eventHangout'] } }
  ];
  let next = 1;
  let version = 1;
  let meetings = 0;
  const pending = new WeakMap();
  // An exception has its series' iCalUID.
  const store = events.map((e) => ({ calendarId: 'me@example.com', etag: '"1"', ...e, iCalUID: e.iCalUID || `${e.recurringEventId || e.id}@google.com` }));
  const requests = [];
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(body) });
  const gone = () => json(410, { error: { code: 410, message: 'Resource has been deleted' } });
  const notFound = () => json(404, { error: { code: 404, message: 'Not Found' } });
  const at = (t) => (t.date ? new Date(`${t.date}T00:00:00`).getTime() : Date.parse(t.dateTime));
  const masterOf = (e) => e.recurringEventId && store.find((m) => m.calendarId === e.calendarId && m.id === e.recurringEventId && m.recurrence);

  // Occurrences of one series up to a moment, with its exceptions in their place and the ones its rule no longer
  // makes kept as they are.
  function seriesItems(master, to) {
    const own = store.filter((e) => e.calendarId === master.calendarId && e.recurringEventId === master.id);
    if (master.status === 'cancelled') return [];
    const out = [];
    for (const occ of occurrences(master, { ms: to, date: new Date(to).toISOString().slice(0, 10) })) {
      const made = instanceOf(master, occ);
      if (!own.some((x) => x.id === made.id)) out.push(made);
    }
    return [...out, ...own];
  }

  function expanded(calendarId, to) {
    const out = [];
    for (const e of store.filter((x) => x.calendarId === calendarId)) {
      if (e.recurrence) out.push(...seriesItems(e, to));
      else if (!masterOf(e)) out.push(e);
    }
    return out;
  }

  // A stored event, or an occurrence of a series by its id.
  function find(calendarId, id) {
    const stored = store.find((e) => e.calendarId === calendarId && e.id === id);
    if (stored) return { item: stored, stored: true };
    const m = /^(.+)_(\d{8})(?:T(\d{6})Z)?$/.exec(id);
    const master = m && store.find((e) => e.calendarId === calendarId && e.id === m[1] && e.recurrence && e.status !== 'cancelled');
    if (!master) return null;
    const date = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6)}`;
    const target = m[3] ? Date.UTC(+date.slice(0, 4), date.slice(5, 7) - 1, +date.slice(8), +m[3].slice(0, 2), +m[3].slice(2, 4), +m[3].slice(4)) : null;
    const occ = occurrences(master, { ms: target === null ? Infinity : target, date }).find((o) => (target === null ? o.date === date : o.ms === target));
    return occ ? { item: instanceOf(master, occ), stored: false, master } : null;
  }

  function meet(item, request) {
    const n = ++meetings;
    const ready = { conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' }, conferenceId: `abc-${n}`, entryPoints: [{ entryPointType: 'video', uri: `https://meet.google.com/abc-${n}` }] };
    const createRequest = { requestId: request.requestId, conferenceSolutionKey: request.conferenceSolutionKey };
    if (conference === 'pending') {
      item.conferenceData = { createRequest: { ...createRequest, status: { statusCode: 'pending' } } };
      pending.set(item, { reads: pendingReads, ready: { ...ready, createRequest: { ...createRequest, status: { statusCode: 'success' } } }, link: ready.entryPoints[0].uri });
    } else {
      item.conferenceData = { ...ready, createRequest: { ...createRequest, status: { statusCode: 'success' } } };
      item.hangoutLink = ready.entryPoints[0].uri;
    }
  }

  // Google ignores conference data without conferenceDataVersion=1, and a request id it has seen on the event.
  function applyConference(item, body, query) {
    if (!('conferenceData' in body) || query.conferenceDataVersion !== '1') return;
    const cd = clone(body.conferenceData);
    if (cd === null) {
      delete item.conferenceData;
      delete item.hangoutLink;
    } else if (cd.createRequest) {
      const seen = item.conferenceData && item.conferenceData.createRequest && item.conferenceData.createRequest.requestId;
      if (seen !== cd.createRequest.requestId) meet(item, cd.createRequest);
    } else {
      item.conferenceData = clone(cd);
      const video = (cd.entryPoints || []).find((p) => p.entryPointType === 'video');
      if (video) item.hangoutLink = video.uri;
    }
  }

  // Google lists the organizer among the guests once there are guests.
  function withOrganizer(item) {
    if (!Array.isArray(item.attendees) || !item.attendees.length || !item.organizer) return;
    if (!item.attendees.some((a) => a.email === item.organizer.email)) item.attendees.unshift({ email: item.organizer.email, organizer: true, self: Boolean(item.organizer.self), responseStatus: 'accepted' });
  }

  // A conference Google is making: it is ready after a few reads.
  function read(item) {
    const p = pending.get(item);
    if (!p) return;
    if (--p.reads > 0) return;
    pending.delete(item);
    item.conferenceData = p.ready;
    item.hangoutLink = p.link;
    item.etag = `"${++version}"`;
  }

  const matches = (e, q) => [e.summary, e.description, e.location, ...(e.attendees || []).flatMap((a) => [a.email, a.displayName])].some((s) => String(s || '').toLowerCase().includes(q.toLowerCase()));

  // An event as Google sends it: a list longer than maxAttendees, or than Google sends at all, has only the user.
  function present(item, query) {
    const limit = Math.min(attendeeCap, query.maxAttendees ? Number(query.maxAttendees) : Infinity);
    if (!item || !Array.isArray(item.attendees) || item.attendees.length <= limit) return item;
    return { ...item, attendees: item.attendees.filter((a) => a.self), attendeesOmitted: true };
  }

  const serve = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    const ifMatch = opts.headers['if-match'] || null;
    const query = Object.fromEntries(u.searchParams);
    requests.push({ method, path: decodeURIComponent(u.pathname.replace('/calendar/v3', '')), query, body, auth: opts.headers.authorization, ifMatch });
    if (fail) {
      const answer = fail({ method, url: u, body });
      if (answer) return json(answer.status, answer.body);
    }
    const parts = u.pathname.replace('/calendar/v3/', '').split('/').map(decodeURIComponent);
    if (parts[0] === 'users') return json(200, { items: calendars });
    const calendarId = parts[1];
    const eventId = parts[3];
    const action = parts[4];
    const showDeleted = query.showDeleted === 'true';

    if (!eventId && method === 'GET') {
      const from = query.timeMin ? Date.parse(query.timeMin) : -Infinity;
      const to = query.timeMax ? Date.parse(query.timeMax) : Infinity;
      let items;
      if (query.iCalUID) items = store.filter((e) => e.calendarId === calendarId && e.iCalUID === query.iCalUID);
      else if (query.singleEvents === 'true') items = expanded(calendarId, to).filter((e) => at(e.start) < to && at(e.end) > from);
      else items = store.filter((e) => e.calendarId === calendarId);
      if (query.privateExtendedProperty) {
        const [name, ...value] = query.privateExtendedProperty.split('=');
        items = items.filter((e) => e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private[name] === value.join('='));
      }
      if (!showDeleted) items = items.filter((e) => e.status !== 'cancelled');
      if (query.q) items = items.filter((e) => matches(e, query.q));
      if (query.orderBy === 'startTime') items = items.slice().sort((a, b) => at(a.start) - at(b.start));
      return json(200, { items: items.map((e) => present(e, query)) });
    }
    if (!eventId && method === 'POST') {
      const uid = insertUid === 'keep' ? body.iCalUID : undefined;
      if ((body.id && store.some((e) => e.calendarId === calendarId && e.id === body.id)) || (uid && store.some((e) => e.calendarId === calendarId && e.iCalUID === uid))) {
        return json(409, { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } });
      }
      const { conferenceData, iCalUID, ...fields } = body;
      const id = body.id || `new${next++}`;
      const item = {
        ...clone(fields),
        calendarId,
        id,
        iCalUID: uid || `${id}@google.com`,
        etag: `"${++version}"`,
        status: 'confirmed',
        organizer: { email: 'me@example.com', self: true },
        htmlLink: 'https://www.google.com/calendar/event?eid=x'
      };
      applyConference(item, body, query);
      withOrganizer(item);
      store.push(item);
      return json(200, item);
    }

    if (action === 'instances' && method === 'GET') {
      const master = store.find((e) => e.calendarId === calendarId && e.id === eventId && e.recurrence);
      if (!master) return notFound();
      let items = seriesItems(master, query.timeMax ? Date.parse(query.timeMax) : Date.parse(query.originalStart || '2100-01-01T00:00:00Z') + DAY);
      if (query.originalStart) {
        const want = query.originalStart;
        items = items.filter((e) => e.originalStartTime && (e.originalStartTime.date ? e.originalStartTime.date === want : Date.parse(e.originalStartTime.dateTime) === Date.parse(want)));
      }
      if (!showDeleted) items = items.filter((e) => e.status !== 'cancelled');
      return json(200, { items: items.map((e) => present(e, query)) });
    }
    if (action === 'move' && method === 'POST') {
      const item = store.find((e) => e.calendarId === calendarId && e.id === eventId && e.status !== 'cancelled');
      if (!item) return notFound();
      if (item.recurringEventId || (item.eventType && item.eventType !== 'default')) return json(400, { error: { code: 400, message: 'Cannot change the organizer of an instance.' } });
      for (const e of store.filter((x) => x.calendarId === calendarId && x.recurringEventId === eventId)) e.calendarId = query.destination;
      item.calendarId = query.destination;
      item.etag = `"${++version}"`;
      return json(200, item);
    }

    const found = find(calendarId, eventId);
    if (!found) return notFound();
    if (method === 'GET') {
      read(found.stored ? found.item : found.master);
      const again = find(calendarId, eventId);
      return json(200, present(again.item, query));
    }
    if (method === 'DELETE' && found.item.status === 'cancelled') return gone();
    if (ifMatch && ifMatch !== found.item.etag) return json(412, { error: { code: 412, message: 'Precondition Failed', errors: [{ reason: 'conditionNotMet' }] } });
    let item = found.item;
    // A change to one occurrence of a series makes it an exception of its own.
    if (!found.stored) {
      item = clone(item);
      store.push(item);
    }
    if (method === 'PATCH') {
      const { conferenceData, attendeesOmitted, ...fields } = clone(body);
      // A partial list (an answer to an invitation) changes only the guests it names.
      if (attendeesOmitted && Array.isArray(fields.attendees)) {
        const list = (item.attendees || []).map((a) => ({ ...a }));
        for (const a of fields.attendees) {
          const i = list.findIndex((x) => x.email === a.email);
          if (i >= 0) list[i] = { ...list[i], ...a };
          else list.push(a);
        }
        fields.attendees = list;
      }
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'reminders' || !isObject(v)) item[k] = v;
        else if (k === 'extendedProperties') item[k] = { ...item[k], ...Object.fromEntries(Object.entries(v).map(([scope, props]) => [scope, { ...((item[k] || {})[scope] || {}), ...props }])) };
        else item[k] = Object.fromEntries(Object.entries({ ...item[k], ...v }).filter(([, x]) => x !== null));
      }
      applyConference(item, body, query);
      withOrganizer(item);
      item.etag = `"${++version}"`;
      return json(200, present(item, query));
    }
    if (method === 'DELETE') {
      item.status = 'cancelled';
      item.etag = `"${++version}"`;
      if (item.recurrence) for (const e of store.filter((x) => x.calendarId === calendarId && x.recurringEventId === item.id)) e.status = 'cancelled';
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return json(400, {});
  };
  const fetchImpl = async (url, opts = {}) => {
    const answer = await serve(url, opts);
    const lost = lose && lose({ method: opts.method || 'GET', url: new URL(url), body: opts.body ? JSON.parse(opts.body) : null });
    if (lost === true) throw new TypeError('fetch failed');
    if (lost) return json(lost, { error: { code: lost, message: 'Backend Error', errors: [{ reason: 'backendError' }] } });
    return answer;
  };
  return { fetchImpl, requests, store, calendars, find: (id, calendarId = 'me@example.com') => (find(calendarId, id) || {}).item || null };
}

function setup(fake, { scopes = CALENDAR_SCOPES, extra = [] } = {}) {
  const dataDir = tempDir('sem-cal-');
  fs.writeFileSync(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify([{ id: 'g1', type: 'imap', provider: 'google', auth: 'oauth2', email: 'me@example.com', color: '#4a7dff', secret: 'rt', scopes: ['https://mail.google.com/', ...scopes] }, ...extra])
  );
  const google = { available: () => true, refresh: async () => ({ accessToken: 'token-1', expiresAt: Date.now() + 3600000 }) };
  const engine = new Engine({ dataDir, google }).init();
  const calendars = new Calendars({ engine, fetchImpl: fake.fetchImpl });
  return { engine, calendars, dataDir };
}

// Waits for the background fetches a view started.
async function settle(calendars) {
  for (let i = 0; i < 5; i++) await Promise.all([...calendars.queues.values()]);
}

function monday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
const at = (base, days, h, m = 0) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d;
};
const iso = (d) => d.toISOString();
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

module.exports = { DAY, fakeCalendar, setup, settle, monday, at, iso, day };
