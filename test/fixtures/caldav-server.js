'use strict';

// A CalDAV server for tests, over plain http on this PC: one user, calendars and events in memory, and the requests
// Rukoo makes. Like real servers it sends /.well-known/caldav on to the principal, gives every calendar object an
// etag that changes with it, refuses a write with an older etag in If-Match (412), and filters a calendar-query by
// time only roughly, so the client has to work out the occurrences itself. A server that schedules (RFC 6638) keeps a
// list of the invitations and cancellations it would have emailed for the organizer.
const http = require('http');

const PRINCIPAL = '/dav/principals/me/';
const HOME = '/dav/calendars/me/';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The people on an object (every component of it) and its highest SEQUENCE, from the text as written.
function scheduling(data, user) {
  const text = String(data || '').replace(/\r?\n[ \t]/g, '');
  const organizer = /^ORGANIZER[^:\r\n]*:mailto:([^\r\n]+)$/im.exec(text);
  const attendees = new Set([...text.matchAll(/^ATTENDEE[^:\r\n]*:mailto:([^\r\n]+)$/gim)].map((m) => m[1].trim().toLowerCase()));
  attendees.delete(user);
  const sequence = Math.max(0, ...[...text.matchAll(/^SEQUENCE:(\d+)$/gim)].map((m) => Number(m[1])));
  const uid = (/^UID:([^\r\n]+)$/im.exec(text) || [])[1] || null;
  return { own: Boolean(organizer && organizer[1].trim().toLowerCase() === user), attendees, sequence, uid };
}

// objects: { 'home/standup.ics': 'BEGIN:VCALENDAR…' }. scheduling: say calendar-auto-schedule in the DAV header, and
// keep what it would send in sent. etagOnPut: answer a PUT with the new ETag, as most servers do; without it the
// client has to fetch it. move: take WebDAV MOVE (otherwise 405). more: calendars besides home, shared and tasks.
function caldavServer({ user = 'me@example.com', password: initialPassword = 'secret', objects = {}, scheduling: schedules = false, etagOnPut = true, move = true, more = {}, fail = null } = {}) {
  let password = initialPassword;
  const calendars = {
    home: { name: 'Home', comps: ['VEVENT'], write: true, color: '#2952A3FF', timeZone: 'Europe/Amsterdam' },
    shared: { name: 'Shared with me', comps: ['VEVENT'], write: false, color: '#E6C800' },
    tasks: { name: 'Tasks', comps: ['VTODO'], write: true },
    ...more
  };
  const store = new Map();
  let version = 0;
  const nextEtag = () => `"v${++version}"`;
  for (const [name, data] of Object.entries(objects)) store.set(HOME + name, { data, etag: nextEtag() });
  const requests = [];
  const sent = [];

  // What a scheduling server emails for the organizer when an object changes from before to after (null: none).
  function schedule(before, after) {
    if (!schedules) return;
    const a = before ? scheduling(before, user) : null;
    const b = after ? scheduling(after, user) : null;
    if (!(a && a.own) && !(b && b.own)) return;
    const uid = (b || a).uid;
    for (const to of b ? b.attendees : []) {
      if (!a || !a.attendees.has(to)) sent.push({ method: 'REQUEST', to, uid });
      else if (b.sequence > a.sequence) sent.push({ method: 'REQUEST', to, uid, update: true });
    }
    for (const to of a ? a.attendees : []) if (!b || !b.attendees.has(to)) sent.push({ method: 'CANCEL', to, uid });
  }

  const multistatus = (responses) => `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${responses.join('')}</d:multistatus>`;
  const response = (href, props, missing = '') =>
    `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${
      missing ? `<d:propstat><d:prop>${missing}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>` : ''
    }</d:response>`;
  const zoneData = (tzid) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:${tzid}\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n`;

  function handle(req, res, body) {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push({ method: req.method, path, depth: req.headers.depth, ifMatch: req.headers['if-match'] || null, ifNoneMatch: req.headers['if-none-match'] || null, destination: req.headers.destination || null, overwrite: req.headers.overwrite || null, body });
    const send = (status, text = '', headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8', ...headers });
      res.end(text);
    };
    if (fail) {
      const answer = fail({ method: req.method, path, body });
      if (answer) return send(answer.status, answer.body || '');
    }
    if (path === '/.well-known/caldav') return send(301, '', { location: '/dav/' });
    const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    if (req.headers.authorization !== expected) return send(401, '', { 'www-authenticate': 'Basic realm="test"' });

    if (req.method === 'OPTIONS') return send(200, '', { dav: `1, 2, 3, calendar-access${schedules ? ', calendar-auto-schedule' : ''}` });
    if (req.method === 'PROPFIND') {
      // The server root only names the principal, so finding the home takes the second step.
      if (path === '/dav/') return send(207, multistatus([response('/dav/', `<d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>`, '<cal:calendar-home-set/>')]));
      if (path === PRINCIPAL) {
        return send(207, multistatus([response(PRINCIPAL, `<d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal><cal:calendar-home-set><d:href>${HOME}</d:href></cal:calendar-home-set>`)]));
      }
      if (path === HOME) {
        const list = [
          response(HOME, '<d:resourcetype><d:collection/></d:resourcetype><d:displayname>me</d:displayname>'),
          // An inbox for scheduling is a collection, but not a calendar.
          response(`${HOME}inbox/`, '<d:resourcetype><d:collection/><cal:schedule-inbox/></d:resourcetype>'),
          ...Object.entries(calendars).map(([id, c]) =>
            response(
              `${HOME}${id}/`,
              `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>${esc(c.name)}</d:displayname>` +
                `<cal:supported-calendar-component-set>${c.comps.map((n) => `<cal:comp name="${n}"/>`).join('')}</cal:supported-calendar-component-set>` +
                `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${c.write ? '<d:privilege><d:write/></d:privilege>' : ''}</d:current-user-privilege-set>` +
                (c.color ? `<a:calendar-color xmlns:a="http://apple.com/ns/ical/">${esc(c.color)}</a:calendar-color>` : '') +
                (c.timeZone ? `<cal:calendar-timezone>${esc(zoneData(c.timeZone))}</cal:calendar-timezone>` : '') +
                (c.sharedBy ? `<cs:shared-url xmlns:cs="http://calendarserver.org/ns/"><d:href>/dav/calendars/${esc(c.sharedBy)}/</d:href></cs:shared-url>` : ''),
              '<a:calendar-order xmlns:a="http://apple.com/ns/ical/"/>'
            )
          )
        ];
        return send(207, multistatus(list));
      }
      return send(404);
    }
    const [, id] = path.slice(HOME.length).split('/');
    const cal = path.startsWith(HOME) ? calendars[path.slice(HOME.length).split('/')[0]] : null;
    if (req.method === 'REPORT') {
      if (!cal || path !== `${HOME}${path.slice(HOME.length).split('/')[0]}/`) return send(404);
      const items = [...store.entries()].filter(([p]) => p.startsWith(path));
      return send(207, multistatus(items.map(([p, o]) => response(p, `<d:getetag>${esc(o.etag)}</d:getetag><cal:calendar-data>${esc(o.data)}</cal:calendar-data>`))));
    }
    if (!cal || !id) return send(405);
    const item = store.get(path);
    if (req.method === 'GET') return item ? send(200, item.data, { 'content-type': 'text/calendar; charset=utf-8', etag: item.etag }) : send(404);
    if (req.method === 'PUT') {
      if (!cal.write) return send(403);
      if (req.headers['if-none-match'] === '*' && item) return send(412);
      if (req.headers['if-match'] && (!item || item.etag !== req.headers['if-match'])) return send(412);
      const etag = nextEtag();
      schedule(item && item.data, body);
      store.set(path, { data: body, etag });
      return send(item ? 204 : 201, '', etagOnPut ? { etag } : {});
    }
    if (req.method === 'DELETE') {
      if (!item) return send(404);
      if (req.headers['if-match'] && item.etag !== req.headers['if-match']) return send(412);
      schedule(item.data, null);
      store.delete(path);
      return send(204);
    }
    if (req.method === 'MOVE') {
      // A move keeps the object and what the server knows about its invitations: nothing is sent.
      if (!move) return send(405);
      if (!item) return send(404);
      if (req.headers['if-match'] && item.etag !== req.headers['if-match']) return send(412);
      let to;
      try {
        to = decodeURIComponent(new URL(req.headers.destination).pathname);
      } catch (_) {
        return send(400);
      }
      const target = to.startsWith(HOME) ? calendars[to.slice(HOME.length).split('/')[0]] : null;
      if (!target || !to.slice(HOME.length).split('/')[1]) return send(409);
      if (!cal.write || !target.write) return send(403);
      if (store.has(to) && /^f$/i.test(String(req.headers.overwrite || 'T'))) return send(412);
      store.delete(path);
      store.set(to, { data: item.data, etag: item.etag });
      return send(201);
    }
    return send(405);
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => handle(req, res, body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url,
        home: `${url}${HOME}`,
        calendarUrl: (id) => `${url}${HOME}${id}/`,
        // The stored object by its name in the home, such as 'home/standup.ics'.
        object: (name) => store.get(HOME + name) || null,
        put: (name, data) => store.set(HOME + name, { data, etag: nextEtag() }),
        names: () => [...store.keys()].map((p) => p.slice(HOME.length)),
        // As when the user changes the password at the provider.
        setPassword: (next) => (password = next),
        requests,
        // The invitations (REQUEST) and cancellations (CANCEL) a scheduling server would have emailed.
        sent,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

module.exports = { caldavServer };
