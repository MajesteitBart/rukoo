// node --test "cloudflare/*.test.mjs"   /app and /join through the front Worker, with fake bindings.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.js';
import { appPolicy } from './web-app.js';

// What site/_headers puts on every site file; /app must not keep it.
const SITE_POLICY = "default-src 'self'; script-src 'self' 'sha256-x'";
const APP_FILES = new Set(['/app/', '/app/styles.css', '/app/web/bridge.js', '/app/web/argon2-worker.js', '/app/web/sql-wasm.wasm']);

function env({ account } = {}) {
  const calls = { assets: [], account: [] };
  return {
    calls,
    ASSETS: {
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        calls.assets.push(`${req.method} ${path}`);
        const found = APP_FILES.has(path) || path === '/';
        return new Response(found && req.method === 'GET' ? `file ${path}` : null, {
          status: found ? 200 : 404,
          headers: { 'Content-Security-Policy': SITE_POLICY, 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=()' }
        });
      }
    },
    ACCOUNT: {
      fetch: async (req) => {
        calls.account.push(`${req.method} ${new URL(req.url).pathname}`);
        return account ? account(req) : new Response('account');
      }
    }
  };
}

const get = (path, bindings, { method = 'GET', origin = 'https://rukoo.io' } = {}) => worker.fetch(new Request(origin + path, { method }), bindings);
const invitePage = () => new Response('<h1>Invitation</h1>', { headers: { 'X-Rukoo-Workspace-Invite': '1', 'Content-Type': 'text/html' } });

test('/app redirects to /app/, keeping the query', async () => {
  const bindings = env();
  const bare = await get('/app', bindings);
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('Location'), '/app/');
  assert.equal((await get('/app?x=1', bindings)).headers.get('Location'), '/app/?x=1');
  assert.equal((await get('/app', bindings, { method: 'HEAD' })).status, 301);
  assert.deepEqual(bindings.calls, { assets: [], account: [] });
});

test('app files come from the site files, with the app policy in place of the site one', async () => {
  const bindings = env();
  const page = await get('/app/', bindings);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'file /app/');
  assert.equal(page.headers.get('Content-Security-Policy'), appPolicy(new URL('https://rukoo.io/app/')));
  assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex');
  assert.equal(page.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(page.headers.get('Cache-Control'), 'no-cache');
  assert.equal(page.headers.get('X-Content-Type-Options'), 'nosniff');
  // Headers the app has no opinion on stay as the site set them.
  assert.equal(page.headers.get('Permissions-Policy'), 'camera=()');
  for (const path of ['/app/web/bridge.js', '/app/web/argon2-worker.js', '/app/web/sql-wasm.wasm']) {
    const file = await get(path, bindings);
    assert.equal(file.status, 200, path);
    assert.match(file.headers.get('Content-Security-Policy'), /script-src 'self' 'wasm-unsafe-eval';/, path);
  }
  const head = await get('/app/styles.css', bindings, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('Cache-Control'), 'no-cache');
  assert.deepEqual(bindings.calls.account, []);
});

test('a missing app file stays a 404 and never reaches the account server', async () => {
  const bindings = env();
  const missing = await get('/app/nothing-here.js', bindings);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Content-Security-Policy'), appPolicy(new URL('https://rukoo.io/app/')));
  assert.equal((await get('/app/nothing-here.js', bindings, { method: 'HEAD' })).status, 404);
  assert.deepEqual(bindings.calls.account, []);
});

test('only GET and HEAD reach the app files', async () => {
  const bindings = env();
  const posted = await get('/app/', bindings, { method: 'POST' });
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get('Allow'), 'GET, HEAD');
  assert.equal((await get('/app', bindings, { method: 'PUT' })).status, 405);
  assert.deepEqual(bindings.calls, { assets: [], account: [] });
});

test('the policy is exactly the agreed one, with plain ws:// only on an http address', () => {
  assert.equal(
    appPolicy(new URL('https://rukoo.io/app/')),
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self'; media-src 'self'; connect-src 'self' wss://rukoo.io; frame-src 'none'; " +
      "object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
  );
  assert.match(appPolicy(new URL('http://127.0.0.1:8787/app/')), /connect-src 'self' wss:\/\/127\.0\.0\.1:8787 ws:\/\/127\.0\.0\.1:8787;/);
  assert.doesNotMatch(appPolicy(new URL('https://rukoo.io/app/')), /ws:\/\//);
});

test('an invitation page at /join sends the browser to the app', async () => {
  const bindings = env({ account: invitePage });
  const res = await get('/join', bindings);
  assert.equal(res.status, 302);
  // Relative and without a fragment, so the browser keeps the invitation's #w=…&i=… on the new address.
  assert.equal(res.headers.get('Location'), '/app/');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(res.headers.get('X-Rukoo-Workspace-Invite'), null);
  assert.equal(await res.text(), '');
  const head = await get('/join', bindings, { method: 'HEAD' });
  assert.equal(head.status, 302);
  assert.equal(head.headers.get('Location'), '/app/');
  // The account server decides; the site files are never asked.
  assert.deepEqual(bindings.calls, { assets: [], account: ['GET /join', 'HEAD /join'] });
});

test('anything else at /join passes through as the account server answered it', async () => {
  // A booking page made under the handle join, a server deployed before the header, or team chat off.
  const booking = await get('/join', env({ account: () => new Response('booking page', { headers: { 'Content-Type': 'text/html' } }) }));
  assert.equal(booking.status, 200);
  assert.equal(await booking.text(), 'booking page');
  const off = await get('/join', env({ account: () => new Response('not found', { status: 404 }) }));
  assert.equal(off.status, 404);
  const moved = await get('/join', env({ account: () => new Response(null, { status: 301, headers: { Location: 'https://meet.rukoo.io/join' } }) }));
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('Location'), 'https://meet.rukoo.io/join');
  // Only the exact value counts.
  const other = await get('/join', env({ account: () => new Response('page', { headers: { 'X-Rukoo-Workspace-Invite': 'yes' } }) }));
  assert.equal(other.status, 200);
  // A post is the account server's, page or not.
  const bindings = env({ account: invitePage });
  const posted = await get('/join', bindings, { method: 'POST' });
  assert.equal(posted.status, 200);
  assert.equal(await posted.text(), '<h1>Invitation</h1>');
  assert.deepEqual(bindings.calls, { assets: [], account: ['POST /join'] });
});

test('paths that only start like /app or /join are the site\'s as before', async () => {
  const bindings = env();
  assert.equal(await (await get('/apps', bindings)).text(), 'account');
  assert.equal(await (await get('/join/x', bindings)).text(), 'account');
  assert.deepEqual(bindings.calls.assets, ['GET /apps', 'GET /join/x']);
  assert.deepEqual(bindings.calls.account, ['GET /apps', 'GET /join/x']);
});
