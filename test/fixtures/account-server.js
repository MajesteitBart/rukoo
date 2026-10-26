'use strict';

// A Rukoo account server in memory, for tests of the desktop app. It follows server/PROTOCOL.md closely enough for
// the app's side; the real server in server/ has its own tests. Start one with startAccountServer().
const http = require('http');
const crypto = require('crypto');

const sha = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64url')).digest('base64url');
const token = () => crypto.randomBytes(32).toString('base64url');
const DEFAULT_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };

function startAccountServer({ signups = 'open', invites = [], limit = 1000, jurisdiction = 'eu', kdf = DEFAULT_KDF } = {}) {
  const accounts = new Map();
  const sessions = new Map();
  const calls = [];

  const info = () => ({
    protocol: 1,
    version: '1.0.0-test',
    operator: { name: 'Test operator', url: 'https://example.test', contact: 'ops@example.test', privacy: 'https://example.test/privacy' },
    hosting: { provider: 'Cloudflare', company: 'Cloudflare, Inc.', country: 'US', jurisdiction },
    signups,
    limits: { records: 250000, bytes: 104857600, recordBytes: 16384, batch: 500 }
  });
  const accountView = (acc, current) => ({
    email: acc.email,
    createdAt: acc.createdAt,
    kdf: acc.kdf,
    usage: { records: [...acc.records.values()].filter((r) => r.data).length, bytes: [...acc.records.values()].reduce((n, r) => n + (r.data ? Buffer.from(r.data, 'base64url').length : 0), 0) },
    limits: info().limits,
    devices: [...sessions.entries()]
      .filter(([, s]) => s.email === acc.email)
      .map(([tok, s]) => ({ id: s.id, name: s.name, platform: s.platform, createdAt: s.createdAt, lastSeenAt: s.createdAt, current: tok === current }))
  });
  const newSession = (acc, device) => {
    const tok = token();
    sessions.set(tok, { email: acc.email, id: crypto.randomBytes(8).toString('hex'), name: device.name, platform: device.platform, createdAt: Date.now() });
    return tok;
  };
  const endSessions = (email, keep) => {
    for (const [tok, s] of sessions) if (s.email === email && tok !== keep) sessions.delete(tok);
  };

  const routes = {
    'GET /v1/info': () => [200, info()],
    'POST /v1/prelogin': ({ body }) => {
      const acc = accounts.get(body.email);
      const fake = crypto.createHash('sha256').update(`salt\n${body.email}`).digest().subarray(0, 16).toString('base64url');
      return [200, acc ? { kdf: acc.kdf, salt: acc.salt } : { kdf, salt: fake }];
    },
    'POST /v1/signup': ({ body }) => {
      if (signups === 'closed') return [403, { error: 'signups_closed' }];
      if (signups === 'invite' && !invites.includes(body.invite)) return [403, { error: 'invite_required' }];
      if (accounts.has(body.email)) return [409, { error: 'exists' }];
      const acc = {
        email: body.email,
        createdAt: Date.now(),
        kdf: body.kdf,
        salt: body.salt,
        auth: sha(body.authKey),
        wrappedKey: body.wrappedKey,
        recovery: sha(body.recoveryAuth),
        recoveryWrappedKey: body.recoveryWrappedKey,
        records: new Map(),
        seq: 0
      };
      accounts.set(acc.email, acc);
      const tok = newSession(acc, body.device);
      return [201, { token: tok, account: accountView(acc, tok) }];
    },
    'POST /v1/login': ({ body }) => {
      const acc = accounts.get(body.email);
      if (!acc || acc.auth !== sha(body.authKey)) return [401, { error: 'unauthorized' }];
      const tok = newSession(acc, body.device);
      return [200, { token: tok, wrappedKey: acc.wrappedKey, account: accountView(acc, tok) }];
    },
    'POST /v1/recover/start': ({ body }) => {
      const acc = accounts.get(body.email);
      if (!acc || acc.recovery !== sha(body.recoveryAuth)) return [401, { error: 'unauthorized' }];
      return [200, { recoveryWrappedKey: acc.recoveryWrappedKey, kdf: acc.kdf }];
    },
    'POST /v1/recover/finish': ({ body }) => {
      const acc = accounts.get(body.email);
      if (!acc || acc.recovery !== sha(body.recoveryAuth)) return [401, { error: 'unauthorized' }];
      Object.assign(acc, { kdf: body.kdf, salt: body.salt, auth: sha(body.authKey), wrappedKey: body.wrappedKey });
      endSessions(acc.email, null);
      const tok = newSession(acc, body.device);
      return [200, { token: tok, account: accountView(acc, tok) }];
    },
    'POST /v1/logout': ({ tok }) => {
      sessions.delete(tok);
      return [204];
    },
    'GET /v1/account': ({ acc, tok }) => [200, accountView(acc, tok)],
    'POST /v1/password': ({ acc, tok, body }) => {
      if (acc.auth !== sha(body.authKey)) return [403, { error: 'wrong_password' }];
      Object.assign(acc, { kdf: body.kdf, salt: body.salt, auth: sha(body.newAuthKey), wrappedKey: body.wrappedKey });
      endSessions(acc.email, tok);
      return [204];
    },
    'POST /v1/recovery': ({ acc, body }) => {
      if (acc.auth !== sha(body.authKey)) return [403, { error: 'wrong_password' }];
      Object.assign(acc, { recovery: sha(body.recoveryAuth), recoveryWrappedKey: body.recoveryWrappedKey });
      return [204];
    },
    'DELETE /v1/account': ({ acc, body }) => {
      if (acc.auth !== sha(body.authKey)) return [403, { error: 'wrong_password' }];
      accounts.delete(acc.email);
      endSessions(acc.email, null);
      return [204];
    },
    'GET /v1/records': ({ acc, url }) => {
      const since = Number(url.searchParams.get('since')) || 0;
      const max = Math.min(Number(url.searchParams.get('limit')) || limit, limit);
      const all = [...acc.records.entries()].map(([id, r]) => ({ id, seq: r.seq, data: r.data })).filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
      return [200, { records: all.slice(0, max), seq: acc.seq, more: all.length > max }];
    },
    'POST /v1/records': ({ acc, body }) => {
      const results = body.records.map((r) => {
        const had = acc.records.get(r.id);
        if (r.ifAbsent && had && had.data) return { id: r.id, seq: had.seq, stored: false };
        acc.seq += 1;
        acc.records.set(r.id, { seq: acc.seq, data: r.data });
        return { id: r.id, seq: acc.seq, stored: true };
      });
      return [200, { results, seq: acc.seq }];
    }
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.startsWith('/v1/devices/') && req.method === 'DELETE' ? 'DELETE /v1/devices' : `${req.method} ${url.pathname}`;
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch (_) {
        body = {};
      }
      calls.push({ route, body });
      const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const session = sessions.get(tok);
      const acc = session && accounts.get(session.email);
      const send = (status, json) => {
        res.writeHead(status, json ? { 'content-type': 'application/json' } : {});
        res.end(json ? JSON.stringify(json) : undefined);
      };
      if (route === 'DELETE /v1/devices') {
        if (!acc) return send(401, { error: 'unauthorized' });
        const id = decodeURIComponent(url.pathname.slice('/v1/devices/'.length));
        const found = [...sessions.entries()].find(([, s]) => s.email === acc.email && s.id === id);
        if (!found) return send(404, { error: 'not_found' });
        sessions.delete(found[0]);
        return send(204);
      }
      const handler = routes[route];
      if (!handler) return send(404, { error: 'not_found' });
      const open = ['GET /v1/info', 'POST /v1/prelogin', 'POST /v1/signup', 'POST /v1/login', 'POST /v1/recover/start', 'POST /v1/recover/finish'];
      if (!open.includes(route) && !acc) return send(401, { error: 'unauthorized' });
      const [status, json] = handler({ body, url, acc, tok });
      send(status, json);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        accounts,
        sessions,
        calls,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

module.exports = { startAccountServer };
