// Mail from the account server, sent through Resend (https://resend.com). The server sends one kind of mail: the codes
// that check an email address (codes.js), to the address someone typed in, with text this server wrote. The API key is
// the RESEND_API_KEY secret and the sender the MAIL_FROM variable. Without both, the server sends no mail and offers
// no codes.

const RESEND = 'https://api.resend.com/emails';
// Codes go out after the answer, in the time the platform gives a request's waitUntil (30 seconds), which looking up
// the account takes a little of: three tries of at most 5 seconds each, with at most 2 seconds between them.
const TIMEOUT = 5000;
const TRIES = 3;
const MAX_WAIT = 2000;

function text(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

// { key, from } when the server can send mail, else null.
export function mailer(env) {
  const key = text(env.RESEND_API_KEY);
  const from = text(env.MAIL_FROM);
  return key && from ? { key, from } : null;
}

// Sends one message: 'sent' when Resend took it, 'refused' when Resend answered that it didn't, and 'unknown' when the
// last try got no answer. A failure that may pass, such as Resend's limit of requests per second or a server error,
// is tried again, under one idempotency key so a message never goes out twice. A failure is logged with Resend's
// status and error name only: never the address, the text or the key.
export async function sendMail(env, { to, subject, text: plain, html }) {
  const mail = mailer(env);
  if (!mail) return 'refused';
  const body = JSON.stringify({ from: mail.from, to: [to], subject, text: plain, html });
  const idempotency = `email-code/${crypto.randomUUID()}`;
  for (let attempt = 1; ; attempt++) {
    const outcome = await post(mail.key, body, idempotency);
    if (outcome.ok) return 'sent';
    if (!outcome.again || attempt >= TRIES) {
      console.error('Sending mail failed: Resend answered', outcome.status ?? 'nothing', outcome.name ?? '');
      return outcome.status ? 'refused' : 'unknown';
    }
    await new Promise((resolve) => setTimeout(resolve, outcome.wait ?? Math.min(attempt * 1000, MAX_WAIT)));
  }
}

// One request to Resend: { ok } or { ok: false, again, wait, status, name }.
async function post(key, body, idempotency) {
  let res;
  try {
    res = await fetch(RESEND, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': idempotency },
      body
    });
  } catch (err) {
    return { ok: false, again: true, name: err?.name };
  }
  if (res.ok) {
    await res.body?.cancel();
    return { ok: true };
  }
  let name = null;
  try {
    const value = (await res.json())?.name;
    name = typeof value === 'string' ? value.slice(0, 60) : null;
  } catch {
    // Not JSON; the status says enough.
  }
  // A daily or monthly quota doesn't pass in seconds. Resend's own limit per second does, and says when.
  const quota = name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded';
  const again = (res.status === 429 && !quota) || res.status >= 500 || (res.status === 409 && name === 'concurrent_idempotent_requests');
  const after = Number(res.headers.get('retry-after'));
  const wait = res.headers.has('retry-after') && Number.isFinite(after) && after >= 0 ? Math.min(after * 1000, MAX_WAIT) : undefined;
  return { ok: false, again, wait, status: res.status, name };
}
