// node --test "cloudflare/*.test.mjs"   /help through the front Worker, with fake bindings.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.js';
import { helpPolicy } from './help-center.js';

// What site/_headers puts on every site file; /help must not keep it.
const SITE_POLICY = "default-src 'self'; script-src 'self' 'sha256-x'";

const TYPES = { js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };

function env({ notFoundPage = true } = {}) {
  const files = new Map([
    ['/help/', 'help home'],
    ['/help/mail/write/', 'write mail'],
    ['/help/pagefind/pagefind.js', 'search'],
    ['/help/favicon.svg', '<svg/>'],
    ...(notFoundPage ? [['/help/404', 'help 404 page']] : []),
    ['/', 'landing page']
  ]);
  const calls = { assets: [], account: [] };
  return {
    calls,
    ASSETS: {
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        calls.assets.push(`${req.method} ${path}`);
        // The assets binding sends a page's address without the trailing slash to the address with it.
        if (files.has(`${path}/`)) return new Response(null, { status: 307, headers: { Location: `${path}/`, 'Content-Security-Policy': SITE_POLICY } });
        const found = files.has(path);
        return new Response(found && req.method === 'GET' ? files.get(path) : null, {
          status: found ? 200 : 404,
          headers: { 'Content-Type': TYPES[path.split('.').at(-1)] ?? 'text/html; charset=utf-8', 'Content-Security-Policy': SITE_POLICY, 'X-Content-Type-Options': 'nosniff' }
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

const get = (path, bindings, { method = 'GET' } = {}) => worker.fetch(new Request('https://rukoo.io' + path, { method }), bindings);

test('/help redirects to /help/, keeping the query', async () => {
  const bindings = env();
  const bare = await get('/help', bindings);
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('Location'), '/help/');
  assert.equal((await get('/help?q=x', bindings)).headers.get('Location'), '/help/?q=x');
  assert.deepEqual(bindings.calls, { assets: [], account: [] });
});

test('help files come from the site files, with the help policy in place of the site one', async () => {
  const bindings = env();
  const files = [
    ['/help/', 'help home', helpPolicy({ page: true })],
    ['/help/mail/write/', 'write mail', helpPolicy({ page: true })],
    ['/help/pagefind/pagefind.js', 'search', helpPolicy({ page: false })],
    ['/help/favicon.svg', '<svg/>', helpPolicy({ page: false })]
  ];
  for (const [path, body, policy] of files) {
    const file = await get(path, bindings);
    assert.equal(file.status, 200, path);
    assert.equal(await file.text(), body, path);
    assert.equal(file.headers.get('Content-Security-Policy'), policy, path);
    // Headers the help center has no opinion on stay as the site set them.
    assert.equal(file.headers.get('X-Content-Type-Options'), 'nosniff', path);
  }
  // Only HTML pages, which narrow it with their own <meta> policy, may run inline scripts.
  assert.match(helpPolicy({ page: true }), /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';/);
  assert.match(helpPolicy({ page: false }), /script-src 'self' 'wasm-unsafe-eval';/);
  assert.doesNotMatch(helpPolicy({ page: false }), /unsafe-inline' 'wasm|script-src[^;]*unsafe-inline/);
  assert.match(helpPolicy(), /frame-ancestors 'none'$/);
  const slashless = await get('/help/mail/write', bindings);
  assert.equal(slashless.status, 307);
  assert.equal(slashless.headers.get('Location'), '/help/mail/write/');
  assert.equal(slashless.headers.get('Content-Security-Policy'), helpPolicy({ page: false }));
  assert.deepEqual(bindings.calls.account, []);
});

test('a missing help page gets the help 404 page with a 404 status, and never reaches the account server', async () => {
  const bindings = env();
  const missing = await get('/help/mail/nothing-here/', bindings);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'help 404 page');
  assert.equal(missing.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(missing.headers.get('Content-Security-Policy'), helpPolicy());
  const head = await get('/help/nothing-here/', bindings, { method: 'HEAD' });
  assert.equal(head.status, 404);
  assert.equal(await head.text(), '');
  assert.deepEqual(bindings.calls.assets.slice(-2), ['HEAD /help/nothing-here/', 'HEAD /help/404']);
  assert.deepEqual(bindings.calls.account, []);
});

test('without a built help center, /help/ is a plain 404 that still stays off the account server', async () => {
  const bindings = env({ notFoundPage: false });
  const missing = await get('/help/nothing-here/', bindings);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'Not found');
  assert.deepEqual(bindings.calls.account, []);
});

test('other methods under /help are refused; /helpful is not the help center', async () => {
  const bindings = env();
  const post = await get('/help/mail/write/', bindings, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  assert.equal(await (await get('/helpful', bindings)).text(), 'account');
  assert.deepEqual(bindings.calls.account, ['GET /helpful']);
});
