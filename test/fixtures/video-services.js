'use strict';

// A fake Zoom and a fake Microsoft identity platform with Microsoft Graph, on one local HTTP server, and a fake browser
// that answers their sign-in pages. The token routes check PKCE and hand out access and refresh tokens that rotate on
// every refresh, as Zoom's and Microsoft's do; the API routes check the access token and keep meetings in memory.
// fail(request) may return [status, body] to answer instead, as a service refusing or breaking would.
const http = require('http');
const crypto = require('crypto');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function videoServer() {
  const s = {
    requests: [],
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
    meetings: new Map(),
    fail: null,
    expiresIn: 3600,
    // What the browser does on the sign-in page: 'allow', 'deny', or 'wrong-state'.
    browser: 'allow',
    pages: [],
    n: 0
  };
  const issue = (service) => {
    s.n += 1;
    const access = `${service}-access-${s.n}`;
    const refresh = `${service}-refresh-${s.n}`;
    s.access.set(access, service);
    s.refresh.set(refresh, service);
    return { access_token: access, refresh_token: refresh, expires_in: s.expiresIn, token_type: 'bearer' };
  };

  function token(service, r) {
    const f = r.form;
    if (f.grant_type === 'authorization_code') {
      const code = s.codes.get(f.code);
      if (!code || code.service !== service || code.redirect !== f.redirect_uri) return [400, { error: 'invalid_grant' }];
      const challenge = b64url(crypto.createHash('sha256').update(String(f.code_verifier)).digest());
      if (challenge !== code.challenge) return [400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }];
      s.codes.delete(f.code);
      return [200, issue(service)];
    }
    if (f.grant_type === 'refresh_token') {
      if (s.refresh.get(f.refresh_token) !== service) return service === 'zoom' ? [401, { reason: 'Invalid Token!', error: 'invalid_request' }] : [400, { error: 'invalid_grant', error_description: 'AADSTS70000: The refresh token was revoked.' }];
      // Rotation: the old refresh token stops working.
      s.refresh.delete(f.refresh_token);
      return [200, issue(service)];
    }
    return [400, { error: 'unsupported_grant_type' }];
  }

  function authed(service, r) {
    const m = /^Bearer (.+)$/.exec(r.headers.authorization || '');
    return Boolean(m && s.access.get(m[1]) === service);
  }

  function zoom(r, path) {
    if (path === '/zoom/oauth/token' && r.method === 'POST') return token('zoom', r);
    if (!authed('zoom', r)) return [401, { code: 124, message: 'Invalid access token.' }];
    if (path === '/zoom/v2/users/me') return [200, { email: 'Host@Example.com', first_name: 'Bart', last_name: 'Host', display_name: 'Bart Host' }];
    if (path === '/zoom/v2/users/me/meetings' && r.method === 'POST') {
      s.n += 1;
      const id = 81000000000 + s.n;
      s.meetings.set(String(id), { service: 'zoom', ...r.json });
      return [201, { id, join_url: `https://us05web.zoom.us/j/${id}?pwd=abc${s.n}`, password: 'abc' }];
    }
    const m = /^\/zoom\/v2\/meetings\/([^/]+)$/.exec(path);
    if (m) {
      if (!s.meetings.has(m[1])) return [404, { code: 3001, message: 'Meeting does not exist: ' + m[1] }];
      if (r.method === 'PATCH') {
        Object.assign(s.meetings.get(m[1]), r.json);
        return [204, null];
      }
      if (r.method === 'DELETE') {
        s.meetings.delete(m[1]);
        return [204, null];
      }
    }
    return [404, { code: 404, message: 'No such route' }];
  }

  function teams(r, path) {
    if (/^\/ms\/[^/]+\/oauth2\/v2\.0\/token$/.test(path) && r.method === 'POST') return token('teams', r);
    if (!authed('teams', r)) return [401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' } }];
    if (path === '/graph/me') return [200, { displayName: 'Bart Host', mail: null, userPrincipalName: 'bart@contoso.example' }];
    if (path === '/graph/me/onlineMeetings' && r.method === 'POST') {
      s.n += 1;
      const id = `MSo1N2Y5ZGFjYy0${s.n}`;
      s.meetings.set(id, { service: 'teams', ...r.json });
      return [201, { id, joinWebUrl: `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${s.n}%40thread.v2/0`, subject: r.json.subject }];
    }
    const m = /^\/graph\/me\/onlineMeetings\/([^/]+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!s.meetings.has(id)) return [404, { error: { code: 'NotFound', message: 'The meeting was not found.' } }];
      if (r.method === 'PATCH') {
        Object.assign(s.meetings.get(id), r.json);
        return [200, { id }];
      }
      if (r.method === 'DELETE') {
        s.meetings.delete(id);
        return [204, null];
      }
    }
    return [404, { error: { code: 'NotFound', message: 'No such route' } }];
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const r = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, raw, form: {}, json: null };
      if (/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) r.form = Object.fromEntries(new URLSearchParams(raw));
      if (/json/.test(req.headers['content-type'] || '') && raw) r.json = JSON.parse(raw);
      s.requests.push(r);
      const answer = (s.fail && s.fail(r)) || (r.path.startsWith('/zoom/') ? zoom(r, r.path) : teams(r, r.path));
      const [status, body] = answer;
      if (status === 204 || body === null) res.writeHead(status).end();
      else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  s.url = base;
  s.zoomEndpoints = { auth: `${base}/zoom/oauth/authorize`, token: `${base}/zoom/oauth/token`, api: `${base}/zoom/v2` };
  s.teamsEndpoints = { login: `${base}/ms`, api: `${base}/graph` };

  // The browser: reads the sign-in address Rukoo opened, and goes back to its loopback address with a code (or an
  // error, or a state that isn't Rukoo's).
  s.openBrowser = (address) => {
    const u = new URL(address);
    const service = u.pathname.startsWith('/zoom/') ? 'zoom' : 'teams';
    s.opened = u;
    const back = new URL(u.searchParams.get('redirect_uri'));
    if (s.browser === 'deny') back.searchParams.set('error', 'access_denied');
    else if (s.browser === 'wait') return;
    else {
      const code = `code-${++s.n}`;
      s.codes.set(code, { service, challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri') });
      back.searchParams.set('code', code);
    }
    back.searchParams.set('state', s.browser === 'wrong-state' ? 'not-the-state' : u.searchParams.get('state'));
    setImmediate(() =>
      fetch(back)
        .then((res) => res.text())
        .then((html) => s.pages.push(html))
        .then(() => {
          // After a wrong state, the real answer still comes, as when the user retries from the right tab.
          if (s.browser === 'wrong-state') {
            s.browser = 'allow';
            s.openBrowser(address);
          }
        })
        .catch(() => {})
    );
  };
  s.close = () => new Promise((resolve) => server.close(resolve));
  return s;
}

module.exports = { videoServer };
