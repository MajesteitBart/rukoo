// Mail from the account server, sent through Resend (https://resend.com). The server sends one kind of mail: the codes
// that check an email address (codes.js), to the address someone typed in, with text this server wrote. The API key is
// the RESEND_API_KEY secret and the sender the MAIL_FROM variable. Without both, the server sends no mail and offers
// no codes.

const RESEND = 'https://api.resend.com/emails';
const TIMEOUT = 10000;

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

// Sends one message and says whether Resend took it. A failure is logged with Resend's status and error name only:
// never the address, the text or the key.
export async function sendMail(env, { to, subject, text: plain, html }) {
  const mail = mailer(env);
  if (!mail) return false;
  let res;
  try {
    res = await fetch(RESEND, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { authorization: `Bearer ${mail.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: mail.from, to: [to], subject, text: plain, html })
    });
  } catch (err) {
    console.error('Sending mail failed: Resend could not be reached.', err?.name);
    return false;
  }
  if (res.ok) {
    await res.body?.cancel();
    return true;
  }
  let name = null;
  try {
    name = (await res.json())?.name ?? null;
  } catch {
    // Not JSON; the status says enough.
  }
  console.error('Sending mail failed: Resend answered', res.status, typeof name === 'string' ? name.slice(0, 60) : '');
  return false;
}
