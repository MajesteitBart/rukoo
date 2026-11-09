// node --test "cloudflare/*.test.mjs"   The front Worker with fake bindings, and Resend replaced by a recorder.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from './worker.js';

const ORIGIN = 'https://rukoo.io';
let sent;
let resendStatus;
let resendDown;
let resendBodyBreaks;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  resendStatus = 200;
  resendDown = false;
  resendBodyBreaks = false;
  globalThis.fetch = async (url, init) => {
    if (resendDown) throw new TypeError('connection reset');
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (resendBodyBreaks) return new Response(new ReadableStream({ pull: (c) => c.error(new Error('timed out')) }), { status: 503 });
    return new Response(JSON.stringify({ id: 'email-1' }), { status: resendStatus });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function env({ allowed = true, ...over } = {}) {
  return {
    ASSETS: { fetch: async (req) => new Response(new URL(req.url).pathname === '/' ? 'page' : 'missing', { status: new URL(req.url).pathname === '/' ? 200 : 404 }) },
    ACCOUNT: { fetch: async () => new Response('account') },
    EARLY_ACCESS_LIMIT: { limit: async () => ({ success: allowed }) },
    RESEND_API_KEY: 're_test',
    EARLY_ACCESS_TO: 'owner@example.com',
    EARLY_ACCESS_FROM: 'Rukoo early access <early-access@example.com>',
    ...over,
  };
}

function post(fields, { origin = ORIGIN, accept = 'application/json', type = 'application/x-www-form-urlencoded', body } = {}) {
  const headers = { 'Content-Type': type, Accept: accept, 'CF-Connecting-IP': '203.0.113.7' };
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}/api/early-access`, { method: 'POST', headers, body: body ?? new URLSearchParams(fields).toString() });
}

test('a request becomes one email to the owner, with the visitor as reply-to', async () => {
  const res = await worker.fetch(post({ name: 'Joris  Bakker', email: 'joris@example.com', website: '' }), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(sent.length, 1);
  const [{ url, headers, body }] = sent;
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(headers.Authorization, 'Bearer re_test');
  assert.deepEqual(body.to, ['owner@example.com']);
  assert.equal(body.reply_to, 'joris@example.com');
  assert.equal(body.from, 'Rukoo early access <early-access@example.com>');
  assert.equal(body.subject, 'Rukoo early access: Joris Bakker');
  assert.match(body.text, /Email: joris@example\.com/);
});

test('the name is optional', async () => {
  const res = await worker.fetch(post({ email: 'anna@example.org' }), env());
  assert.equal(res.status, 200);
  assert.equal(sent[0].body.subject, 'Rukoo early access: anna@example.org');
  assert.match(sent[0].body.text, /Name: \(not given\)/);
});

test('a post from another site, or without an Origin, is refused', async () => {
  assert.equal((await worker.fetch(post({ email: 'a@example.com' }, { origin: 'https://evil.example' }), env())).status, 403);
  assert.equal((await worker.fetch(post({ email: 'a@example.com' }, { origin: null }), env())).status, 403);
  assert.equal(sent.length, 0);
});

test('a bot that fills in the hidden field gets a normal answer and sends nothing', async () => {
  const res = await worker.fetch(post({ email: 'bot@example.com', website: 'https://spam.example' }), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(sent.length, 0);
});

test('bad input is refused without sending', async () => {
  for (const fields of [{ email: '' }, { email: 'not-an-email' }, { email: 'a@b' }, { email: `${'a'.repeat(250)}@example.com` }, { email: 'a@example.com', name: 'x'.repeat(101) }]) {
    assert.equal((await worker.fetch(post(fields), env())).status, 400, JSON.stringify(fields).slice(0, 60));
  }
  assert.equal((await worker.fetch(post(null, { type: 'application/json', body: '{"email":"a@example.com"}' }), env())).status, 400);
  assert.equal((await worker.fetch(post(null, { body: `email=a%40example.com&name=${'x'.repeat(5000)}` }), env())).status, 400);
  assert.equal(sent.length, 0);
});

test('the size limit counts bytes, and a large upload is cancelled instead of read whole', async () => {
  // A valid form padded with 2,100 raw "é": about 2,100 characters, but over 4,096 bytes.
  const multibyte = `email=a%40example.com&pad=${'é'.repeat(2100)}`;
  assert.ok(multibyte.length < 4096 && new TextEncoder().encode(multibyte).byteLength > 4096);
  assert.equal((await worker.fetch(post(null, { body: multibyte }), env())).status, 400);
  assert.equal((await worker.fetch(post(null, { body: `email=a%40example.com&pad=${'é'.repeat(1000)}` }), env())).status, 200);
  sent.length = 0;

  let pulled = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode('x'.repeat(1024));
  const stream = new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled > 8192) return controller.close(); // 8 MiB, if nothing stops it
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request(`${ORIGIN}/api/early-access`, {
    method: 'POST',
    headers: { Origin: ORIGIN, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: stream,
    duplex: 'half',
  });
  assert.equal((await worker.fetch(req, env())).status, 400);
  assert.ok(cancelled, 'the upload is cancelled');
  assert.ok(pulled < 16, `read ${pulled} KiB before stopping`);
  assert.equal(sent.length, 0);
});

test('too many requests from one address get a 429', async () => {
  const res = await worker.fetch(post({ email: 'a@example.com' }), env({ allowed: false }));
  assert.equal(res.status, 429);
  assert.equal(sent.length, 0);
});

test('a Resend failure, or a missing secret, is an error for the visitor', async () => {
  resendStatus = 422;
  assert.equal((await worker.fetch(post({ email: 'a@example.com' }), env())).status, 502);
  assert.equal((await worker.fetch(post({ email: 'a@example.com' }), env({ EARLY_ACCESS_TO: undefined }))).status, 503);
});

test('when Resend is unreachable, both kinds of visitor get the form\'s own error', async () => {
  resendDown = true;
  const json = await worker.fetch(post({ email: 'a@example.com' }), env());
  assert.equal(json.status, 502);
  assert.deepEqual(await json.json(), { ok: false, error: 'send' });
  const html = await worker.fetch(post({ email: 'a@example.com' }, { accept: 'text/html' }), env());
  assert.equal(html.status, 502);
  assert.match(await html.text(), /That didn't go through/);

  // Resend answers with an error, then its body breaks off while it's read for the log.
  resendDown = false;
  resendBodyBreaks = true;
  const broken = await worker.fetch(post({ email: 'a@example.com' }), env());
  assert.equal(broken.status, 502);
  assert.deepEqual(await broken.json(), { ok: false, error: 'send' });
});

test('without the page script, the answer is a small page with a way back', async () => {
  const res = await worker.fetch(post({ email: 'a@example.com' }, { accept: 'text/html' }), env());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Thanks\. I'll be in touch\./);
  assert.match(html, /href="\/#early-access"/);
});

test('other methods on the form path are refused; the rest of the site is unchanged', async () => {
  const get = await worker.fetch(new Request(`${ORIGIN}/api/early-access`), env());
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  assert.equal(await (await worker.fetch(new Request(`${ORIGIN}/`), env())).text(), 'page');
  assert.equal(await (await worker.fetch(new Request(`${ORIGIN}/bart`), env())).text(), 'account');
  assert.equal(await (await worker.fetch(new Request(`${ORIGIN}/v1/info`, { method: 'POST' }), env())).text(), 'account');
  const www = await worker.fetch(new Request('https://www.rukoo.io/api/early-access', { method: 'POST' }), env());
  assert.equal(www.status, 301);
  assert.equal(sent.length, 0);
});
