// Responses. Every answer is nosniff, and no-store except the booking pages' font files; booking pages add their own
// policy on top (PROTOCOL.md, Public routes).

export function baseHeaders(headers = {}) {
  return { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers };
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: baseHeaders({ 'content-type': 'application/json; charset=utf-8', ...headers })
  });
}

// An object's { status, body, headers } reply. Other properties on it are for the Worker and never sent.
export function send({ status, body, headers }) {
  return status === 204 ? new Response(null, { status, headers: baseHeaders(headers) }) : json(status, body, headers);
}

// The account server's own pages (/, /privacy): no scripts, frames or forms, and only inline style.
export function html(body, method) {
  return new Response(method === 'HEAD' ? null : body, {
    headers: baseHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    })
  });
}

// ---- Booking pages ----

export const MEET_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// What every booking page answer sends. same-origin: other websites never get a page's address, which can hold a manage key
// or a guest's name and email, and the pages' own form posts still carry their real Origin, which no-referrer hides
// (Fetch, "append a request Origin header"); browsers without Sec-Fetch-Site rely on that Origin to book.
export const MEET_REFERRER = 'same-origin';

export function meetHeaders(headers = {}) {
  return baseHeaders({ 'content-security-policy': MEET_CSP, 'referrer-policy': MEET_REFERRER, ...headers });
}

// Only GET reads may be read by other websites; writes never send CORS headers (PROTOCOL.md, Public routes).
export const READ_CORS = { 'access-control-allow-origin': '*' };
export const NOINDEX = { 'x-robots-tag': 'noindex' };

export function meetJson(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: meetHeaders({ 'content-type': 'application/json; charset=utf-8', ...headers })
  });
}

// A text answer (HTML, markdown, plain text or a calendar file). HEAD gets the headers without the body.
export function meetText(status, body, contentType, headers = {}, method = 'GET') {
  return new Response(method === 'HEAD' ? null : body, {
    status,
    headers: meetHeaders({ 'content-type': contentType, ...headers })
  });
}

// A font file (fonts.js). Unlike everything else it may be cached: the files never change under the same name.
export function meetFont(body, method) {
  return new Response(method === 'HEAD' ? null : body, {
    headers: baseHeaders({ 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' })
  });
}

export function meetEmpty(status, headers = {}) {
  return new Response(null, { status, headers: meetHeaders(headers) });
}

export function redirect(status, location, headers = {}) {
  return new Response(null, { status, headers: meetHeaders({ location, ...headers }) });
}
