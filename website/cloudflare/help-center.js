// The help center under /help, built from help-center/ into site/help/ by npm run help:build.
//
// /help/* is answered from the site's files only, like /app/*: a missing page gets the help center's own 404 page
// with a 404 status, and nothing under /help reaches the account server (help is a reserved booking handle there).

export const HELP = '/help/';

export function isHelpPath(pathname) {
  return pathname === '/help' || pathname.startsWith(HELP);
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
  if (url.pathname === '/help') return new Response(null, { status: 301, headers: { Location: HELP + url.search } });
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404) {
    // Astro writes the 404 page to site/help/404.html, which the assets binding serves as /help/404.
    const page = await env.ASSETS.fetch(new Request(new URL(`${HELP}404`, url), { method: request.method }));
    response = page.ok
      ? new Response(page.body, { status: 404, headers: page.headers })
      : new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } else {
    response = new Response(response.body, response);
  }
  // site/_headers gives every site file the landing page's policy; both would be enforced, so this one replaces it.
  const page = /^text\/html\b/i.test(response.headers.get('Content-Type') || '');
  response.headers.set('Content-Security-Policy', helpPolicy({ page }));
  return response;
}
