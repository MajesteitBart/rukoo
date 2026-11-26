// The help center at https://help.rukoo.io, built from help-center/ into site/help/ by npm run help:build.
//
// That host is answered from site/help/ only: /mail/write/ is site/help/mail/write/index.html. A missing page gets
// the help center's own 404 page with a 404 status, and no request on that host reaches the rest of the site or the
// account server. The help center was at rukoo.io/help/ before, so those addresses redirect to the same page here.

export const HELP_HOST = 'help.rukoo.io';
// Where the help center's files sit among the site's files.
const DIR = '/help';
// The help center under `wrangler dev`. Browsers send *.localhost to this computer.
const LOCAL_HOST = 'help.localhost';

export function isHelpHost(hostname) {
  return hostname === HELP_HOST || hostname === LOCAL_HOST;
}

export function isHelpPath(pathname) {
  return pathname === DIR || pathname.startsWith(DIR + '/');
}

/**
 * rukoo.io/help/mail/write/ moved to https://help.rukoo.io/mail/write/, also from plain http. Under `wrangler dev`
 * the help center is help.localhost on the same scheme and port.
 */
export function helpRedirect(url) {
  const target = url.hostname === 'rukoo.io' ? new URL(`https://${HELP_HOST}`) : new URL(url);
  if (target.hostname !== HELP_HOST) target.hostname = LOCAL_HOST;
  target.pathname = url.pathname.slice(DIR.length) || '/';
  target.search = url.search;
  return new Response(null, { status: 301, headers: { Location: target.toString() } });
}

// Starlight puts small inline scripts on every page (theme, sidebar, search shortcut), and Pagefind's search runs
// WebAssembly. help-center/scripts/publish.mjs gives each HTML page a <meta> policy that allows only the hashes of its
// own inline scripts; the browser enforces that one and this one, so 'unsafe-inline' on a page lets nothing else
// through. Every other file has no such <meta>, so an SVG opened on its own gets no inline scripts at all.
export function helpPolicy({ page = true } = {}) {
  return [
    "default-src 'self'",
    page ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'" : "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

export async function helpResponse(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  let response = await env.ASSETS.fetch(new Request(new URL(DIR + url.pathname + url.search, url), request));
  if (response.status === 404) {
    // Astro writes the 404 page to site/help/404.html, which the assets binding serves as /help/404.
    const page = await env.ASSETS.fetch(new Request(new URL(`${DIR}/404`, url), { method: request.method }));
    response = page.ok
      ? new Response(page.body, { status: 404, headers: page.headers })
      : new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } else {
    response = new Response(response.body, response);
  }
  // The assets binding sends /help/mail/write to /help/mail/write/; on this host that is /mail/write/.
  const location = response.headers.get('Location');
  if (location) {
    const target = new URL(location, url);
    if (target.host === url.host && isHelpPath(target.pathname)) {
      response.headers.set('Location', (target.pathname.slice(DIR.length) || '/') + target.search + target.hash);
    }
  }
  // site/_headers gives every site file the landing page's policy; both would be enforced, so this one replaces it.
  const page = /^text\/html\b/i.test(response.headers.get('Content-Type') || '');
  response.headers.set('Content-Security-Policy', helpPolicy({ page }));
  return response;
}
