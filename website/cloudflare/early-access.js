// POST /api/early-access: someone asks for an invite to booking pages and the Rukoo account. The request becomes one
// email to Bart, sent through Resend. The address it goes to is a Worker secret (EARLY_ACCESS_TO), so it is in neither
// the page nor this repository. The form never sends mail to the address someone types in: that would let anyone use
// it to send mail to strangers. "api" is a reserved handle on the account server, so this path can't be a booking page.

export const PATH = '/api/early-access';

const MAX_BODY = 4096;
const MAX = { name: 100, email: 254 };
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

export async function earlyAccess(request, env) {
  const url = new URL(request.url);
  const json = (request.headers.get('Accept') || '').includes('application/json');
  const reply = (status, ok, error) =>
    json
      ? Response.json(ok ? { ok } : { ok, error }, { status, headers: { 'Cache-Control': 'no-store' } })
      : page(status, ok);

  // Browsers send Origin with every POST. A form on another site, or a script that leaves it out, is turned away.
  if (request.headers.get('Origin') !== url.origin) return reply(403, false, 'origin');

  if (env.EARLY_ACCESS_LIMIT) {
    const { success } = await env.EARLY_ACCESS_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return reply(429, false, 'busy');
  }

  const form = await readForm(request);
  if (!form) return reply(400, false, 'invalid');
  // A hidden field that people never see and bots fill in: they get the answer a person gets, and nothing is sent.
  if (form.website) return reply(200, true);
  const email = form.email.trim();
  const name = form.name.replace(/\s+/g, ' ').trim();
  if (email.length > MAX.email || !EMAIL.test(email) || name.length > MAX.name) return reply(400, false, 'invalid');

  if (!env.RESEND_API_KEY || !env.EARLY_ACCESS_TO || !env.EARLY_ACCESS_FROM) {
    console.error('early access: RESEND_API_KEY, EARLY_ACCESS_TO or EARLY_ACCESS_FROM is not set');
    return reply(503, false, 'send');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EARLY_ACCESS_FROM,
      to: [env.EARLY_ACCESS_TO],
      reply_to: email,
      subject: `Rukoo early access: ${name || email}`,
      text: [
        'Someone asked for early access on rukoo.io. Reply to this email to answer them.',
        '',
        `Name: ${name || '(not given)'}`,
        `Email: ${email}`,
        `Country: ${request.cf?.country || 'unknown'}`,
        `Time: ${new Date().toISOString()}`,
      ].join('\n'),
    }),
  }).catch((err) => {
    console.error('early access: Resend unreachable', err?.name, err?.message);
    return null;
  });
  if (!res?.ok) {
    // The log reads Resend's error text, but a body that stalls or breaks can't keep the visitor from the 502.
    if (res) console.error('early access: Resend answered', res.status, (await res.text().catch(() => '')).slice(0, 300));
    return reply(502, false, 'send');
  }
  return reply(200, true);
}

// The form posts as application/x-www-form-urlencoded, with or without the page's script. Anything else, or a body
// larger than a name and an address need, is refused.
async function readForm(request) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/x-www-form-urlencoded')) return null;
  const body = await readText(request, MAX_BODY);
  if (body === null) return null;
  const params = new URLSearchParams(body);
  const field = (key) => String(params.get(key) ?? '');
  return { name: field('name'), email: field('email'), website: field('website') };
}

// The body as text, counted in bytes while it arrives: past the limit, reading stops and the upload is cancelled,
// so a large body is never buffered whole.
async function readText(request, max) {
  if (Number(request.headers.get('Content-Length')) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// Without the page's script, the browser shows this answer instead of the page, with a way back.
function page(status, ok) {
  const text = ok ? "Thanks. I'll be in touch." : "That didn't go through. Go back and try again.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rukoo Mail</title><link rel="stylesheet" href="/styles.css"></head><body><main class="early-page"><p>${text}</p><a class="btn btn-ghost" href="/#early-access">Back to Rukoo Mail</a></main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
