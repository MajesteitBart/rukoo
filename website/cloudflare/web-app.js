// Rukoo in the browser: the app under /app and the invitation links at /join.
//
// /app/* comes from site/app/, which tools/build-app.mjs assembles from the desktop renderer. It is answered from the
// site's files only, so a file the build left out is a 404 the app can see. The account server would otherwise take
// the path for a booking page and redirect it to meet.rukoo.io (BOOKING_FORMER_ROOTS).
//
// A workspace invitation link is <server>/join#w=…&i=…. The account server answers /join with a plain page, and marks
// it with X-Rukoo-Workspace-Invite: 1 when it is the invitation page (server/src/index.js). Only then does this send
// the browser to /app/; the browser carries the fragment over to the new address (RFC 9110 §10.2.2), where the app
// reads the invitation. Anything else at /join, such as a booking page under the handle join, a server deployed before
// the header, or team chat being off, passes through untouched.

export const APP = '/app/';

export function isAppPath(pathname) {
  return pathname === '/app' || pathname.startsWith(APP);
}

// One policy for the page and its workers. 'wasm-unsafe-eval' is for SQLite (sql.js) on the page and Argon2 (hash-wasm)
// in its worker; nothing else is evaluated. Inline styles carry the renderer's per-item custom properties
// (style="--h:…"). The socket address is spelled out besides 'self', which not every browser applies to WebSockets;
// ws:// only on a plain http address, which is local development.
export function appPolicy(url) {
  const sockets = [`wss://${url.host}`];
  if (url.protocol === 'http:') sockets.push(`ws://${url.host}`);
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self'",
    `connect-src 'self' ${sockets.join(' ')}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

export async function appResponse(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  // Relative, so it stays on whatever address the browser used, also behind a local proxy that rewrites the host.
  if (url.pathname === '/app') return new Response(null, { status: 301, headers: { Location: APP + url.search } });
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  // site/_headers gives every site file a policy for the landing page; both would be enforced, so this one replaces it.
  response.headers.set('Content-Security-Policy', appPolicy(url));
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // The file names carry no version, so a browser checks each one again on every load.
  response.headers.set('Cache-Control', 'no-cache');
  return response;
}

// GET and HEAD only; a POST to /join is the account server's business.
export async function joinResponse(request, env) {
  const page = await env.ACCOUNT.fetch(request);
  if (page.headers.get('X-Rukoo-Workspace-Invite') !== '1') return page;
  await page.body?.cancel();
  return new Response(null, {
    status: 302,
    headers: { Location: APP, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' }
  });
}
