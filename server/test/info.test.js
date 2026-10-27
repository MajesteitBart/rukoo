import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { call, device, key, newEmail, salt, sealed, KDF, INVITE, withVars } from './helpers.js';
import worker from '../src/index.js';
import { createExecutionContext } from 'cloudflare:test';

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const OPERATOR = {
  OPERATOR_NAME: 'Example Sync',
  OPERATOR_URL: 'https://sync.example',
  OPERATOR_CONTACT: 'help@sync.example',
  PRIVACY_URL: 'https://sync.example/privacy'
};

describe('GET /', () => {
  it('describes the server, its operator, where data is and what the server can see', async () => {
    const res = await call('GET', '/', { vars: { ...OPERATOR, JURISDICTION: 'eu' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.text).toContain('Rukoo account server');
    expect(res.text).toContain('<a href="https://sync.example">Example Sync</a>');
    expect(res.text).toContain('mailto:help@sync.example');
    expect(res.text).toContain('Cloudflare, Inc., a company in the United States');
    expect(res.text).toContain('in the European Union');
    expect(res.text).toContain('Device names and platforms, and when each device last connected.');
    expect(res.text).toContain("IP addresses, in Cloudflare's request logs and in the rate limiter.");
    // Booking pages change what the server sees, and the page says how far the sealing goes.
    expect(res.text).toContain('Account holders can also turn on a booking page here');
    expect(res.text).toContain("pass through the server readable when they book; it stores them sealed to a key only the host's devices hold.");
    expect(res.text).toContain('href="https://sync.example/privacy"');
    expect(res.text).toContain('href="https://github.com/MajesteitBart/rukoo/blob/main/server/PROTOCOL.md"');
    expect(res.text).not.toMatch(/<script|<link|<img|src=/i);
  });

  it('escapes the operator settings and links only web addresses', async () => {
    const res = await call('GET', '/', {
      vars: { OPERATOR_NAME: '<script>alert(1)</script>', OPERATOR_URL: 'javascript:alert(1)', PRIVACY_URL: '' }
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).not.toContain('javascript:');
    // Without a PRIVACY_URL the page links the statement the server serves itself.
    expect(res.text).toContain('<a href="https://accounts.example/privacy">Privacy statement</a>');
  });

  it('works without operator settings and without a pepper', async () => {
    const res = await call('GET', '/', { vars: { PEPPER: undefined } });
    expect(res.status).toBe(200);
    expect(res.text).toContain("hasn't filled in their name");
  });
});

describe('GET /privacy', () => {
  it('names the operator, the data, Cloudflare and where accounts are kept', async () => {
    const res = await call('GET', '/privacy', { vars: { ...OPERATOR, PRIVACY_URL: '', JURISDICTION: 'eu' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.text).toContain('<html lang="en">');
    expect(res.text).toContain('<a href="https://sync.example">Example Sync</a> runs this server');
    expect(res.text).toContain('mailto:help@sync.example');
    expect(res.text).toContain('Accounts are stored and handled in the European Union.');
    expect(res.text).toContain('Cloudflare, Inc. in the United States');
    expect(res.text).toContain('article 6(1)(b) GDPR');
    expect(res.text).not.toMatch(/<script|<link|<img|src=/i);
  });

  it('tells hosts and guests what a booking page shares, where it goes and how long it stays', async () => {
    const en = (await call('GET', '/privacy?lang=en')).text;
    const nl = (await call('GET', '/privacy?lang=nl')).text;
    for (const [text, heading, next] of [
      [en, '<h2 id="booking-pages">Booking pages</h2>', '<h2>Security</h2>'],
      [nl, '<h2 id="booking-pages">Afsprakenpagina’s</h2>', '<h2>Beveiliging</h2>']
    ]) {
      expect(text.indexOf(heading)).toBeGreaterThan(-1);
      expect(text.indexOf(heading)).toBeLessThan(text.indexOf(next));
    }
    for (const part of [
      'you are a guest',
      'the assistant’s name',
      'the host’s calendar and mail provider, such as Google, sends you the invitation',
      'article 6(1)(b) GDPR',
      'keeps only that sealed copy',
      'the details do pass through the server readable at the moment of booking, so the operator',
      'until 30 days after the meeting',
      'When the guest cancels, the host declines or a request lapses, the sealed details and the email hash are deleted at once',
      'hashes made with a key that changes every day',
      'Report this page',
      'If you turn it on, it also runs your booking page',
      'removes the account, every record and your booking page with its bookings at once'
    ]) {
      expect(en, part).toContain(escapeHtml(part));
    }
    for (const part of [
      'dan ben je gast',
      'de naam van die assistent',
      'de agenda- en mailprovider van de host, zoals Google, stuurt je de uitnodiging',
      'artikel 6 lid 1 onder b AVG',
      'bewaart alleen die verzegelde kopie',
      'Maar op het moment van boeken gaan de gegevens leesbaar door de server.',
      'tot 30 dagen na de afspraak',
      'dan worden de verzegelde gegevens en de hash van het e-mailadres meteen verwijderd',
      'gemaakt met een sleutel die elke dag wisselt',
      'Pagina melden',
      'draait het ook je afsprakenpagina',
      'je afsprakenpagina met de afspraken erop in één keer'
    ]) {
      expect(nl, part).toContain(escapeHtml(part));
    }
    // What stopped being true: the address is used for more than sign-ins now.
    expect(en).not.toContain('uses it only to limit how often one address may try to sign in');
    expect(nl).not.toContain('gebruikt het alleen om te beperken');
  });

  it('speaks Dutch when the browser or the address asks for it', async () => {
    const browser = await call('GET', '/privacy', { headers: { 'accept-language': 'nl-NL,nl;q=0.9,en;q=0.8' } });
    expect(browser.text).toContain('<html lang="nl">');
    expect(browser.text).toContain('Privacyverklaring voor Rukoo-accounts');
    const asked = await call('GET', '/privacy?lang=nl', { headers: { 'accept-language': 'en' } });
    expect(asked.text).toContain('<html lang="nl">');
    const english = await call('GET', '/privacy?lang=en', { headers: { 'accept-language': 'nl' } });
    expect(english.text).toContain('<html lang="en">');
    const other = await call('GET', '/privacy', { headers: { 'accept-language': 'de-DE,fr' } });
    expect(other.text).toContain('<html lang="en">');
  });

  it('escapes the operator settings', async () => {
    const res = await call('GET', '/privacy', { vars: { OPERATOR_NAME: '<b>x</b>', OPERATOR_URL: 'javascript:alert(1)', OPERATOR_CONTACT: '"><i>' } });
    expect(res.text).not.toContain('<b>x</b>');
    expect(res.text).not.toContain('javascript:');
    expect(res.text).not.toContain('"><i>');
  });

  it('works without operator settings and without a pepper', async () => {
    const res = await call('GET', '/privacy', { vars: { PEPPER: undefined } });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Whoever runs this server hasn’t filled in their name.');
  });
});

describe('GET /v1/info', () => {
  it('reports the protocol, version, operator, hosting, sign-ups and limits', async () => {
    const res = await call('GET', '/v1/info', { vars: { ...OPERATOR, JURISDICTION: 'eu' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      protocol: 1,
      version: pkg.version,
      operator: {
        name: 'Example Sync',
        url: 'https://sync.example',
        contact: 'help@sync.example',
        privacy: 'https://sync.example/privacy'
      },
      hosting: { provider: 'Cloudflare', company: 'Cloudflare, Inc.', country: 'US', jurisdiction: 'eu' },
      signups: 'invite',
      limits: { records: 250000, bytes: 104857600, recordBytes: 16384, batch: 500 },
      features: ['booking']
    });
  });

  it('reports empty settings as null and follows the variables', async () => {
    const res = await call('GET', '/v1/info', { vars: { SIGNUPS: 'open', MAX_RECORDS: '10', MAX_BYTES: 2048 } });
    expect(res.body.operator).toEqual({ name: null, url: null, contact: null, privacy: 'https://accounts.example/privacy' });
    expect(res.body.hosting.jurisdiction).toBe(null);
    expect(res.body.signups).toBe('open');
    expect(res.body.limits).toEqual({ records: 10, bytes: 2048, recordBytes: 16384, batch: 500 });
  });

  it('treats an unknown sign-up mode as closed', async () => {
    const res = await call('GET', '/v1/info', { vars: { SIGNUPS: 'opne' } });
    expect(res.body.signups).toBe('closed');
  });

  it('answers without a pepper', async () => {
    const res = await call('GET', '/v1/info', { vars: { PEPPER: undefined } });
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe(1);
  });
});

describe('not_configured', () => {
  const calls = [
    ['POST', '/v1/prelogin', { email: 'a@example.com' }],
    ['POST', '/v1/signup', {}],
    ['POST', '/v1/login', {}],
    ['POST', '/v1/recover/start', {}],
    ['GET', '/v1/account'],
    ['GET', '/v1/records'],
    ['POST', '/v1/nothing-here'],
    ['GET', '/v1/booking'],
    ['PUT', '/v1/booking', {}],
    ['DELETE', '/v1/booking'],
    ['GET', '/v1/booking/handles/bart'],
    ['GET', '/v1/booking/bookings'],
    ['POST', '/v1/booking/bookings/Rf63vMqqWdS0MICDAHKmrw', {}],
    ['GET', '/meet/bart'],
    ['GET', '/meet/bart/api'],
    ['GET', '/meet/bart/api/slots'],
    ['POST', '/meet/bart/api/bookings', {}],
    ['GET', '/meet/bart/llms.txt'],
    ['POST', '/meet/mcp', {}]
  ];

  for (const [method, path, body] of calls) {
    it(`${method} ${path} needs a pepper`, async () => {
      const res = await call(method, path, { body, vars: { PEPPER: undefined } });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('not_configured');
      expect(res.body.message).toContain('npx wrangler secret put PEPPER');
    });
  }

  it('refuses a pepper that is too short', async () => {
    const res = await call('POST', '/v1/prelogin', { body: { email: 'a@example.com' }, vars: { PEPPER: 'short' } });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('not_configured');
  });

  it('refuses an unknown jurisdiction rather than guessing', async () => {
    const res = await call('POST', '/v1/prelogin', {
      body: { email: 'a@example.com' },
      vars: { JURISDICTION: 'mars' }
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('not_configured');
    expect(res.body.message).toContain('JURISDICTION');
  });
});

describe('routing', () => {
  it('answers 404 for unknown paths and methods, with no CORS headers', async () => {
    for (const [method, path] of [
      ['GET', '/nothing'],
      ['GET', '/v1/nothing'],
      ['PUT', '/v1/records'],
      ['GET', '/v1/login'],
      ['OPTIONS', '/v1/login'],
      ['POST', '/v1/info'],
      ['POST', '/v1/booking'],
      ['PATCH', '/v1/booking'],
      ['GET', '/v1/booking/nothing'],
      ['POST', '/v1/booking/handles/bart'],
      ['GET', '/v1/booking/bookings/Rf63vMqqWdS0MICDAHKmrw'],
      ['DELETE', '/v1/booking/bookings/Rf63vMqqWdS0MICDAHKmrw'],
      ['OPTIONS', '/v1/booking'],
      ['GET', '/meeting'],
      ['GET', '/meet'],
      ['GET', '/meet/'],
      ['GET', '/meet/assets/nothing.js'],
      ['POST', '/meet/assets/booker.js'],
      ['DELETE', '/meet/nobody-has-this']
    ]) {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error).toBe('not_found');
      expect(res.headers.get('access-control-allow-origin')).toBe(null);
    }
  });

  // Pages people open answer with a page, the same one for every handle that has no page.
  it('answers 404 pages for booking pages that aren’t there', async () => {
    const bodies = new Set();
    for (const [method, path] of [
      ['GET', '/meet/nobody-has-this'],
      ['GET', '/meet/Bart'],
      ['GET', '/meet/api'],
      ['GET', '/meet/nobody-has-this/30min'],
      ['POST', '/meet/nobody-has-this/30min'],
      ['GET', '/meet/nobody-has-this/booking/Rf63vMqqWdS0MICDAHKmrw']
    ]) {
      const res = await call(method, path, method === 'POST' ? { body: 'name=x', contentType: 'application/x-www-form-urlencoded' } : {});
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('access-control-allow-origin')).toBe(null);
      expect(res.headers.get('link')).toBe(null);
      if (path.split('/').length === 3) bodies.add(res.text.replace(/<footer[\s\S]*<\/footer>/, ''));
    }
    expect(bodies.size).toBe(1);
  });

  // The local runtime has no jurisdictions, so the namespace is wrapped to see which one the Worker asks for.
  it('finds accounts in the configured jurisdiction', async () => {
    const asked = [];
    const ACCOUNTS = {
      jurisdiction(where) {
        asked.push(where);
        return env.ACCOUNTS;
      },
      idFromName: (name) => env.ACCOUNTS.idFromName(name),
      get: (id) => env.ACCOUNTS.get(id)
    };
    const REGISTRY = {
      jurisdiction(where) {
        asked.push(`registry:${where}`);
        return env.REGISTRY;
      }
    };
    const body = {
      email: newEmail(),
      invite: INVITE,
      kdf: KDF,
      salt: salt(),
      authKey: key(),
      wrappedKey: sealed(),
      recoveryAuth: key(),
      recoveryWrappedKey: sealed(),
      device: device()
    };
    const request = new Request('https://accounts.example/v1/signup', { method: 'POST', body: JSON.stringify(body) });
    const res = await worker.fetch(request, withVars({ ACCOUNTS, REGISTRY, JURISDICTION: 'eu' }), createExecutionContext());
    expect(res.status).toBe(201);
    expect(asked).toEqual(['registry:eu', 'eu']);

    const plain = await worker.fetch(
      new Request('https://accounts.example/v1/prelogin', {
        method: 'POST',
        body: JSON.stringify({ email: body.email })
      }),
      withVars({ ACCOUNTS, JURISDICTION: '' }),
      createExecutionContext()
    );
    expect(plain.status).toBe(200);
    expect(asked).toEqual(['registry:eu', 'eu'], 'prelogin without a jurisdiction asks for none');
  });
});

describe('rate limiting', () => {
  it('limits sign-in calls per client address, and skips the limit without the binding', async () => {
    const ip = '192.0.2.77';
    let limited = null;
    for (let i = 0; i < 100 && !limited; i++) {
      const res = await call('POST', '/v1/prelogin', { body: { email: 'someone@example.com' }, ip });
      if (res.status === 429) limited = res;
      else expect(res.status).toBe(200);
    }
    expect(limited?.body.error).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('60');

    const other = await call('POST', '/v1/prelogin', { body: { email: 'someone@example.com' }, ip: '192.0.2.78' });
    expect(other.status).toBe(200);
    const unbound = await call('POST', '/v1/prelogin', {
      body: { email: 'someone@example.com' },
      ip,
      vars: { RATE_LIMITER: undefined }
    });
    expect(unbound.status).toBe(200);
  });

  it('counts IPv6 clients by their /64', async () => {
    let limited = false;
    for (let i = 0; i < 100 && !limited; i++) {
      const ip = `2001:db8:1:2:${i.toString(16)}::${(i * 7).toString(16)}`;
      const res = await call('POST', '/v1/prelogin', { body: { email: 'someone@example.com' }, ip });
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  });

  it('leaves signed-in calls alone', async () => {
    const ip = '192.0.2.99';
    for (let i = 0; i < 40; i++) {
      const res = await call('GET', '/v1/account', { ip, token: `${'a'.repeat(43)}.${'b'.repeat(43)}` });
      expect(res.status).toBe(401);
    }
  });
});

describe('request bodies', () => {
  it('stops reading a body sent in chunks once it passes the limit', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    const stream = new ReadableStream({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      }
    });
    const request = new Request('https://accounts.example/v1/prelogin', { method: 'POST', body: stream, duplex: 'half' });
    const res = await worker.fetch(request, env, createExecutionContext());
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('too_large');
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * chunk.byteLength);
  });
});
