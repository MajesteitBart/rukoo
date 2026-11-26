// node --test "cloudflare/*.test.mjs"   help.rukoo.io and the old rukoo.io/help addresses through the front Worker,
// with fake bindings.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.js';
import { helpPolicy } from './help-center.js';

// What site/_headers puts on every site file; the help center must not keep it.
const SITE_POLICY = "default-src 'self'; script-src 'self' 'sha256-x'";

const TYPES = { js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8', xml: 'application/xml' };

function env({ notFoundPage = true } = {}) {
  const files = new Map([
    ['/help/', 'help home'],
    ['/help/mail/write/', 'write mail'],
    ['/help/pagefind/pagefind.js', 'search'],
    ['/help/favicon.svg', '<svg/>'],
    ['/help/robots.txt', 'help robots'],
    ['/help/sitemap-index.xml', '<sitemapindex/>'],
    ...(notFoundPage ? [['/help/404', 'help 404 page']] : []),
    ['/', 'landing page'],
    ['/pricing.html', 'pricing'],
    ['/app/', 'web app']
  ]);
  const calls = { assets: [], account: [] };
  return {
    calls,
    ASSETS: {
      fetch: async (req) => {
        const url = new URL(req.url);
        calls.assets.push(`${req.method} ${url.pathname}${url.search}`);
        // The assets binding sends a page's address without the trailing slash to the address with it.
        if (files.has(`${url.pathname}/`)) return new Response(null, { status: 307, headers: { Location: `${url.pathname}/${url.search}`, 'Content-Security-Policy': SITE_POLICY } });
        const found = files.has(url.pathname);
        return new Response(found && req.method === 'GET' ? files.get(url.pathname) : null, {
          status: found ? 200 : 404,
          headers: { 'Content-Type': TYPES[url.pathname.split('.').at(-1)] ?? 'text/html; charset=utf-8', 'Content-Security-Policy': SITE_POLICY, 'X-Content-Type-Options': 'nosniff' }
        });
      }
    },
    ACCOUNT: {
      fetch: async (req) => {
        calls.account.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response('account');
      }
    }
  };
}

const request = (origin) => (path, bindings, { method = 'GET' } = {}) => worker.fetch(new Request(origin + path, { method }), bindings);
const help = request('https://help.rukoo.io');
const site = request('https://rukoo.io');

test('the old rukoo.io/help addresses redirect to the same page on help.rukoo.io', async () => {
  const bindings = env();
  const moved = [
    ['/help', 'https://help.rukoo.io/'],
    ['/help/', 'https://help.rukoo.io/'],
    ['/help?q=x', 'https://help.rukoo.io/?q=x'],
    ['/help/mail/write/', 'https://help.rukoo.io/mail/write/'],
    ['/help/mail/write/?q=x', 'https://help.rukoo.io/mail/write/?q=x'],
    ['/help/pagefind/pagefind.js', 'https://help.rukoo.io/pagefind/pagefind.js']
  ];
  for (const [path, location] of moved) {
    const response = await site(path, bindings);
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get('Location'), location, path);
  }
  // Plain http still goes to the https address.
  const plain = await worker.fetch(new Request('http://rukoo.io/help/mail/write/?q=x'), bindings);
  assert.equal(plain.headers.get('Location'), 'https://help.rukoo.io/mail/write/?q=x');
  // Under `wrangler dev` the help center is help.localhost, on the same scheme and port.
  const local = await worker.fetch(new Request('http://127.0.0.1:8787/help/mail/write/?q=x'), bindings);
  assert.equal(local.headers.get('Location'), 'http://help.localhost:8787/mail/write/?q=x');
  assert.deepEqual(bindings.calls, { assets: [], account: [] });
});

test('help.rukoo.io is answered from site/help/, with the help policy in place of the site one', async () => {
  const bindings = env();
  const files = [
    ['/', 'help home', helpPolicy({ page: true })],
    ['/mail/write/', 'write mail', helpPolicy({ page: true })],
    ['/pagefind/pagefind.js', 'search', helpPolicy({ page: false })],
    ['/favicon.svg', '<svg/>', helpPolicy({ page: false })],
    ['/robots.txt', 'help robots', helpPolicy({ page: false })],
    ['/sitemap-index.xml', '<sitemapindex/>', helpPolicy({ page: false })]
  ];
  for (const [path, body, policy] of files) {
    const file = await help(path, bindings);
    assert.equal(file.status, 200, path);
    assert.equal(await file.text(), body, path);
    assert.equal(file.headers.get('Content-Security-Policy'), policy, path);
    // Headers the help center has no opinion on stay as the site set them.
    assert.equal(file.headers.get('X-Content-Type-Options'), 'nosniff', path);
  }
  assert.deepEqual(bindings.calls.assets.slice(0, 2), ['GET /help/', 'GET /help/mail/write/']);
  // Only HTML pages, which narrow it with their own <meta> policy, may run inline scripts.
  assert.match(helpPolicy({ page: true }), /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';/);
  assert.match(helpPolicy({ page: false }), /script-src 'self' 'wasm-unsafe-eval';/);
  assert.doesNotMatch(helpPolicy({ page: false }), /unsafe-inline' 'wasm|script-src[^;]*unsafe-inline/);
  assert.match(helpPolicy(), /frame-ancestors 'none'$/);
  assert.deepEqual(bindings.calls.account, []);
});

test('the slash redirect of the assets binding points at the help center address', async () => {
  const bindings = env();
  const slashless = await help('/mail/write', bindings);
  assert.equal(slashless.status, 307);
  assert.equal(slashless.headers.get('Location'), '/mail/write/');
  assert.equal(slashless.headers.get('Content-Security-Policy'), helpPolicy({ page: false }));
  assert.equal((await help('/mail/write?q=x', bindings)).headers.get('Location'), '/mail/write/?q=x');
  assert.deepEqual(bindings.calls.account, []);
});

test('a missing help page gets the help 404 page with a 404 status', async () => {
  const bindings = env();
  const missing = await help('/mail/nothing-here/', bindings);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'help 404 page');
  assert.equal(missing.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(missing.headers.get('Content-Security-Policy'), helpPolicy());
  const head = await help('/nothing-here/', bindings, { method: 'HEAD' });
  assert.equal(head.status, 404);
  assert.equal(await head.text(), '');
  assert.deepEqual(bindings.calls.assets.slice(-2), ['HEAD /help/nothing-here/', 'HEAD /help/404']);
  assert.deepEqual(bindings.calls.account, []);
});

test('help.rukoo.io never serves the rest of the site or reaches the account server', async () => {
  const bindings = env();
  for (const path of ['/pricing.html', '/app/', '/v1/account', '/join', '/help/', '/early-access']) {
    const response = await help(path, bindings);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), 'help 404 page', path);
  }
  assert.deepEqual(bindings.calls.account, []);
});

test('without a built help center, help.rukoo.io is a plain 404 that stays off the account server', async () => {
  const bindings = env({ notFoundPage: false });
  const missing = await help('/nothing-here/', bindings);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'Not found');
  assert.deepEqual(bindings.calls.account, []);
});

test('help.rukoo.io refuses other methods; rukoo.io/helpful is not the help center', async () => {
  const bindings = env();
  const post = await help('/mail/write/', bindings, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  assert.equal(await (await site('/helpful', bindings)).text(), 'account');
  assert.deepEqual(bindings.calls.account, ['GET /helpful']);
});
