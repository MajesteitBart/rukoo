'use strict';

// A fake Google Calendar API and the helpers the calendar store's tests share: a profile with one Google account
// whose grant covers the calendar, waiting for background fetches, and dates in the current local week.
const fs = require('fs');
const path = require('path');
const { tempDir } = require('../tmp');
const { Engine } = require('../../src/main/engine');
const { Calendars } = require('../../src/main/calendar');
const { CALENDAR_SCOPES } = require('../../src/main/google');

const DAY = 86400000;

// A Google Calendar with two calendars, answering the calls Rukoo makes and recording them. Like Google, it names
// selected only for calendars that show, gives every event an etag that changes with it, and answers a change sent
// with an older etag in If-Match with 412.
function fakeCalendar({ events = [], fail = null } = {}) {
  const calendars = [
    { id: 'me@example.com', summary: 'me@example.com', primary: true, accessRole: 'owner', timeZone: 'Europe/Amsterdam', selected: true },
    { id: 'nl#holiday@group.v.calendar.google.com', summary: 'Holidays', accessRole: 'reader', selected: false },
    { id: 'busy@example.com', summary: 'Free/busy only', accessRole: 'freeBusyReader' },
    { id: 'team@example.com', summary: 'Team', accessRole: 'writerWithoutPrivateAccess' }
  ];
  const store = events.map((e) => ({ calendarId: 'me@example.com', etag: '"1"', ...e }));
  const requests = [];
  let next = 1;
  let version = 1;
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    const ifMatch = opts.headers['if-match'] || null;
    requests.push({ method, path: decodeURIComponent(u.pathname.replace('/calendar/v3', '')), query: Object.fromEntries(u.searchParams), body, auth: opts.headers.authorization, ifMatch });
    if (fail) {
      const answer = fail({ method, url: u, body });
      if (answer) return json(answer.status, answer.body);
    }
    const parts = u.pathname.replace('/calendar/v3/', '').split('/').map(decodeURIComponent);
    if (parts[0] === 'users') return json(200, { items: calendars });
    const calendarId = parts[1];
    const eventId = parts[3];
    if (!eventId && method === 'GET') {
      const from = Date.parse(u.searchParams.get('timeMin'));
      const to = Date.parse(u.searchParams.get('timeMax'));
      const at = (t) => (t.date ? new Date(`${t.date}T00:00:00`).getTime() : Date.parse(t.dateTime));
      return json(200, { items: store.filter((e) => e.calendarId === calendarId && at(e.start) < to && at(e.end) > from) });
    }
    if (!eventId && method === 'POST') {
      if (body.id && store.some((e) => e.calendarId === calendarId && e.id === body.id)) {
        return json(409, { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } });
      }
      const item = { ...body, calendarId, id: body.id || `new${next++}`, etag: `"${++version}"`, status: 'confirmed', organizer: { email: 'me@example.com', self: true }, htmlLink: 'https://www.google.com/calendar/event?eid=x' };
      store.push(item);
      return json(200, item);
    }
    const item = store.find((e) => e.calendarId === calendarId && e.id === eventId);
    if (!item) return json(404, { error: { code: 404, message: 'Not Found' } });
    if (method === 'GET') return json(200, item);
    if (ifMatch && ifMatch !== item.etag) return json(412, { error: { code: 412, message: 'Precondition Failed', errors: [{ reason: 'conditionNotMet' }] } });
    if (method === 'PATCH') {
      for (const [k, v] of Object.entries(body)) item[k] = v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries({ ...item[k], ...v }).filter(([, x]) => x !== null)) : v;
      item.etag = `"${++version}"`;
      return json(200, item);
    }
    if (method === 'DELETE') {
      store.splice(store.indexOf(item), 1);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return json(400, {});
  };
  return { fetchImpl, requests, store };
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
