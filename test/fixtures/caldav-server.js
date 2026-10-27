'use strict';

// A CalDAV server for tests, over plain http on this PC: one user, calendars and events in memory, and the requests
// Rukoo makes. Like real servers it sends /.well-known/caldav on to the principal, gives every calendar object an
// etag that changes with it, refuses a write with an older etag in If-Match (412), and filters a calendar-query by
// time only roughly, so the client has to work out the occurrences itself.
const http = require('http');

const PRINCIPAL = '/dav/principals/me/';
const HOME = '/dav/calendars/me/';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// objects: { 'home/standup.ics': 'BEGIN:VCALENDAR…' }. scheduling: say calendar-auto-schedule in the DAV header.
// etagOnPut: answer a PUT with the new ETag, as most servers do; without it the client has to fetch it.
function caldavServer({ user = 'me@example.com', password: initialPassword = 'secret', objects = {}, scheduling = false, etagOnPut = true, fail = null } = {}) {
  let password = initialPassword;
  // Colours as servers write Apple's calendar-color: with an opacity, as Apple does, or without; the task list has none.
  const calendars = {
    home: { name: 'Home', comps: ['VEVENT'], write: true, color: '#7B61FFFF' },
    shared: { name: 'Shared with me', comps: ['VEVENT'], write: false, color: '#16A765' },
    tasks: { name: 'Tasks', comps: ['VTODO'], write: true }
  };
  const store = new Map();
  let version = 0;
  const nextEtag = () => `"v${++version}"`;
  for (const [name, data] of Object.entries(objects)) store.set(HOME + name, { data, etag: nextEtag() });
  const requests = [];

  const multistatus = (responses) => `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${responses.join('')}</d:multistatus>`;
  const response = (href, props, missing = '') =>
    `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${
      missing ? `<d:propstat><d:prop>${missing}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>` : ''
    }</d:response>`;

  function handle(req, res, body) {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push({ method: req.method, path, depth: req.headers.depth, ifMatch: req.headers['if-match'] || null, ifNoneMatch: req.headers['if-none-match'] || null, body });
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

    if (req.method === 'OPTIONS') return send(200, '', { dav: `1, 2, 3, calendar-access${scheduling ? ', calendar-auto-schedule' : ''}` });
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
                (c.color ? `<a:calendar-color xmlns:a="http://apple.com/ns/ical/">${c.color}</a:calendar-color>` : ''),
              `<a:calendar-order xmlns:a="http://apple.com/ns/ical/"/>${c.color ? '' : '<a:calendar-color xmlns:a="http://apple.com/ns/ical/"/>'}`
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
      store.set(path, { data: body, etag });
      return send(item ? 204 : 201, '', etagOnPut ? { etag } : {});
    }
    if (req.method === 'DELETE') {
      if (!item) return send(404);
      if (req.headers['if-match'] && item.etag !== req.headers['if-match']) return send(412);
      store.delete(path);
      return send(204);
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
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

module.exports = { caldavServer };
