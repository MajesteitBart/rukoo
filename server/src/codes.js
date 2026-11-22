// Codes sent by email (PROTOCOL.md, POST /v1/email-code): proof that someone reads the mail of an address. With
// SIGNUPS on verified, a new account without an invite code needs one (purpose signup). On every server that sends
// mail, one also lets the owner sign in or recover while other people's failed attempts lock the account (purpose
// unlock).
//
// Each email holds two codes. The six digits are for the device that asked: they count only together with the
// challenge, 32 random bytes that only that device got back, and wrong tries count against that challenge alone, so
// nobody can use up the tries of a code someone else asked for. The long code, 32 random bytes, works on its own on
// any device for a day. It can't be guessed, so it needs no limit on tries, and it is what lets the owner of the
// address get in with any email they got, also one a stranger asked for to use up the address's codes.
//
// The registry keeps each code as hashes: of the challenge, of the long code, of the address and of the six digits
// bound to the challenge, the address and the purpose. The last two are made with PEPPER, so a copy of the registry
// gives away neither the address nor, by trying all million, the six digits.
//
// Asking gets the same answer, just as fast, whether or not the address has an account: the mail goes out after the
// answer. A sign-up code asked for an address with an account becomes a note saying so, and an unlock code for an
// address without one isn't sent at all.

import { fromBase64url, hmac, randomBytes, sha256, toBase64url, utf8 } from './bytes.js';
import { accountName, accountObject, emailCodesOn, limit, limitRate, positive, registryObject, signups } from './config.js';
import { codeMail } from './code-text.js';
import { json } from './http.js';
import * as input from './input.js';
import { HttpError, invalid } from './input.js';
import { sendMail } from './mail.js';
import { language } from './privacy.js';
import { verifiedSignup } from './signups.js';

export const PURPOSES = ['signup', 'unlock'];
export const DIGITS = 6;
// How long the six digits work, how long the long code works, and how many wrong tries each code gets: of the six
// digits, and of the password or recovery key sent with a right code.
export const CODE_TTL = 10 * 60 * 1000;
export const TOKEN_TTL = 24 * 60 * 60 * 1000;
export const ATTEMPTS = 5;
// To one address, for each purpose: at least a minute apart, at most five in an hour and ten in a day.
export const CODE_RULES = { ttl: CODE_TTL, tokenTtl: TOKEN_TTL, gap: 60 * 1000, hourly: 5, daily: 10 };
// The most sign-up emails the whole server sends in an hour, unless EMAIL_CODES_PER_HOUR says otherwise. They are the
// ones that reach addresses without an account.
const PER_HOUR = 100;
// Unlock emails go only to accounts on this server. One always goes to an address that has no long code left to use;
// the others count toward ten a day to one mailbox, counted when they go out, so deleting an account and making one
// again, or making accounts at tags of one mailbox, doesn't give it ten more, and toward a budget for the whole server,
// UNLOCK_EMAILS_PER_DAY unless that says otherwise (0 for none). A stranger who spends the limits still leaves the
// owner a long code that gets them in (Registry.chargeUnlock).
const UNLOCK_PER_DAY = 1000;

// What this server sends codes for: nothing without mail and the registry, unlock wherever it sends mail, and signup
// as well when sign-ups are verified.
export function codePurposes(env) {
  if (!emailCodesOn(env)) return [];
  return signups(env) === 'verified' ? [...PURPOSES] : ['unlock'];
}

// emailCodes in GET /v1/info, or null where the server sends no codes.
export function codesInfo(env) {
  const purposes = codePurposes(env);
  return purposes.length > 0 ? { purposes, digits: DIGITS, expiresIn: CODE_TTL / 1000, tokenExpiresIn: TOKEN_TTL / 1000 } : null;
}

// POST /v1/email-code. max: MAX_ACCOUNTS, so a full server sends no sign-up codes.
export async function requestCode(request, env, ctx, max) {
  await limitRate(request, env.RATE_LIMITER);
  const body = await input.readJson(request);
  const email = input.email(body.email);
  if (!PURPOSES.includes(body.purpose)) throw invalid('purpose must be signup or unlock.', 'purpose');
  const purpose = body.purpose;
  const purposes = codePurposes(env);
  if (purposes.length === 0) throw new HttpError(503, 'mail_unavailable', 'This server does not send codes by email.');
  if (!purposes.includes(purpose)) throw invalid('This server does not use codes to make accounts.', 'purpose');
  const signup = purpose === 'signup';
  if (signup) input.newAddress(email);
  const lang = language(body.lang, request.headers.get('accept-language'));
  const challenge = toBase64url(randomBytes(32));
  const token = toBase64url(randomBytes(32));
  const code = newCode();
  const entry = {
    ...(await codeHashes(env, email, purpose, challenge, code)),
    token: await tokenHash(token),
    sends: await sendsHash(env, email, purpose)
  };
  // A sign-up code for an address whose domain made its accounts for today would make no account, so none goes out
  // (silent). The answer is the one any other request gets: a 429 here would tell anyone that someone at the domain
  // made accounts today, which for a domain of one person tells who. The sign-up itself says so (index.js), and only
  // with a code that works.
  const rules = { ...CODE_RULES, max: signup ? max : 0, domain: signup ? await verifiedSignup(env, email) : null };
  const issued = await registryObject(env).issueCode(entry, rules);
  if (issued.result === 'full') throw new HttpError(403, 'signups_closed', 'This server has no room for new accounts.');
  if (issued.result !== 'ok') {
    throw new HttpError(429, 'rate_limited', 'This address got too many codes. Try again later.', {
      'retry-after': String(issued.retryAfter)
    });
  }
  if (issued.silent) return json(202, { challenge, expiresIn: CODE_TTL / 1000 });
  const host = new URL(request.url).host;
  ctx.waitUntil(
    deliver(env, { email, purpose, code, token, lang, host, id: entry.challenge }).catch((err) =>
      console.error('Sending a code failed:', err?.stack || err)
    )
  );
  return json(202, { challenge, expiresIn: CODE_TTL / 1000 });
}

// Whether the address has an account decides what goes out, so this runs after the answer. Sign-up emails count
// toward the hourly limit, and unlock emails toward their mailbox's ten a day and the daily budget; one Resend refused
// is given back. A code whose long code didn't go out, because no email or only the note went, a limit held it back
// or Resend refused the email, is kept for its 10 minutes and not a day.
async function deliver(env, { email, purpose, code, token, lang, host, id }) {
  const registry = registryObject(env);
  const exists = await accountObject(env, await accountName(env, email)).exists();
  const kind = purpose === 'signup' ? (exists ? 'exists' : 'signup') : exists ? 'unlock' : null;
  if (kind !== 'signup' && kind !== 'unlock') await registry.shortenCode(id);
  if (!kind) return;
  let slot = null;
  if (purpose === 'signup') {
    slot = await registry.chargeMail('signup', positive(env.EMAIL_CODES_PER_HOUR, PER_HOUR));
    if (slot === null) {
      await registry.shortenCode(id);
      console.error("A sign-up email was not sent: this hour's are used up (EMAIL_CODES_PER_HOUR).");
      return;
    }
  }
  let unlock = null;
  if (kind === 'unlock') {
    unlock = { box: await unlockHash(env, email), address: await addressHash(env, email) };
    const charged = await registry.chargeUnlock(unlock.box, {
      address: unlock.address,
      id,
      daily: CODE_RULES.daily,
      budget: unlockBudget(env),
      attempts: ATTEMPTS
    });
    if (!charged.ok) {
      await registry.shortenCode(id);
      console.error(
        charged.reason === 'budget'
          ? "An unlock email was not sent: today's are used up (UNLOCK_EMAILS_PER_DAY)."
          : 'An unlock email was not sent: its mailbox had ten today.'
      );
      return;
    }
    unlock.ticket = charged;
  }
  const operator = typeof env.OPERATOR_NAME === 'string' && env.OPERATOR_NAME.trim() ? env.OPERATOR_NAME.trim() : null;
  const codes = kind === 'exists' ? {} : { code, token };
  const sent = await sendMail(env, { to: email, ...codeMail(kind, { ...codes, host, operator, lang }) });
  // Resend took it: the long code is in the mailbox, which the limits on unlock emails go by. With no answer it may or
  // may not be, and the next unlock email isn't held back by it.
  if (sent === 'sent' && kind !== 'exists') await registry.markSent(id);
  // Resend refused it for good, so the long code went nowhere: the row goes with the six digits, as above.
  if (sent === 'refused') {
    await registry.shortenCode(id);
    if (slot !== null) await registry.refundMail('signup', slot);
    if (unlock) await registry.refundUnlock(unlock.box, unlock.ticket, unlock.address);
  }
}

// UNLOCK_EMAILS_PER_DAY: the budget for unlock emails past each mailbox's first in a day, 0 for none.
export function unlockBudget(env) {
  return limit(env.UNLOCK_EMAILS_PER_DAY, UNLOCK_PER_DAY);
}

// emailCode in a sign-up, sign-in or recovery: null when it is absent, else { challenge, code } for the six digits or
// { token } for the long code. Spaces and dashes in the six digits are left out, as people type them.
export function emailCodeField(value) {
  if (value === undefined || value === null) return null;
  if (!input.isObjectValue(value)) throw invalid('emailCode must be an object with a challenge and a code, or a token.', 'emailCode');
  if (value.token !== undefined) {
    const bytes = fromBase64url(typeof value.token === 'string' ? value.token.trim() : '');
    if (!bytes || bytes.length !== 32) throw invalid('emailCode.token must be 32 bytes in base64url.', 'emailCode');
    return { token: value.token.trim() };
  }
  const challenge = typeof value.challenge === 'string' ? value.challenge : '';
  const bytes = fromBase64url(challenge);
  if (!bytes || bytes.length !== 32) throw invalid('emailCode.challenge must be 32 bytes in base64url.', 'emailCode');
  const code = typeof value.code === 'string' && value.code.length <= 32 ? value.code.replace(/[\s-]/g, '') : '';
  if (!/^[0-9]{6}$/.test(code)) throw invalid(`emailCode.code must be ${DIGITS} digits.`, 'emailCode');
  return { challenge, code };
}

// Claims a code for an address and purpose for this one request, and returns { id, claim } for settleCode. Six digits that
// don't match are 403 code_wrong, with the tries their challenge has left. A code that is unknown, expired, used or
// out of tries is 403 code_expired, and one another request is using right now 409 code_in_use.
export async function claimCode(env, email, purpose, emailCode) {
  const registry = registryObject(env);
  if (!registry) throw expired();
  const entry = emailCode.token
    ? { token: await tokenHash(emailCode.token), address: await addressHash(env, email), purpose }
    : await codeHashes(env, email, purpose, emailCode.challenge, emailCode.code);
  const claimed = await registry.claimCode(entry, ATTEMPTS);
  if (claimed.result === 'ok') return { id: claimed.id, claim: claimed.claim };
  if (claimed.result === 'wrong') {
    throw new HttpError(403, 'code_wrong', 'The code is wrong.', {}, { attemptsLeft: claimed.attemptsLeft });
  }
  if (claimed.result === 'busy') {
    throw new HttpError(409, 'code_in_use', 'This code is being used by another request. Try again in a moment.');
  }
  throw expired();
}

// held: what claimCode returned. outcome: 'used', 'failed' (a wrong password or recovery key with the code) or 'keep'.
// The claim already counted a try (Registry.claimCode), so a request that ends before it settles keeps it used.
export async function settleCode(env, held, outcome) {
  await registryObject(env)?.settleCode(held.id, held.claim, outcome, ATTEMPTS);
}

// For POST /v1/signup on a verified server, without an invite code or invitation that works: the claimed code.
export async function signupCode(env, email, value) {
  const emailCode = emailCodeField(value);
  if (!emailCode) {
    throw new HttpError(403, 'code_required', 'This server checks the email address first. Ask for a code and sign up with it.');
  }
  return claimCode(env, email, 'signup', emailCode);
}

// Runs a sign-in or recovery past the address's lock with a code for unlock, which it holds for the whole call. run
// gets the option the account object takes for that. A wrong password or recovery key (401) costs the code a try, and
// so does a call that failed without an answer, which may have compared the secret all the same. Success uses the code
// up, unless keep: recover/start leaves it for recover/finish, and gives its try back.
export async function unlocked(env, email, emailCode, run, keep = false) {
  const held = await claimCode(env, email, 'unlock', emailCode);
  let result = null;
  try {
    result = await run({ unlocked: true });
  } finally {
    const outcome = result?.status === 200 ? (keep ? 'keep' : 'used') : 'failed';
    await settleCode(env, held, outcome);
  }
  return result;
}

function expired() {
  return new HttpError(403, 'code_expired', 'This code has expired or was used. Ask for a new one.');
}

// Six digits, each code as likely as any other.
function newCode() {
  const range = 10 ** DIGITS;
  const limit = 2 ** 32 - (2 ** 32 % range);
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n < limit) return String(n % range).padStart(DIGITS, '0');
  }
}

async function addressHash(env, email) {
  return toBase64url(await hmac(env.PEPPER, `email-code address\n${email}`));
}

// The mailbox an address reaches, as far as the address itself shows: the name without a +tag, on every domain, and
// at Gmail without dots, with googlemail.com as gmail.com. Fullwidth letters and dots become plain ones first, as mail
// systems read a domain. Only the limits per address use it. A code stays bound to the address as typed, as does the
// account (config.js, accountName).
export function mailbox(typed) {
  const email = typed.normalize('NFKC').toLowerCase().replace(/[。．｡]/g, '.');
  const at = email.lastIndexOf('@');
  let name = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = name.indexOf('+');
  if (plus > 0) name = name.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') name = name.replaceAll('.', '') || name;
  return `${name}@${domain}`;
}

// What the limits per address count under. Sign-up codes count per mailbox, so the tags and dots of one inbox share
// its ten emails a day and one person can't make an account a minute with them. Unlock codes count per address: they
// go out only to an account, and counted per mailbox, a stranger could use up a locked owner's codes by asking for
// codes for other spellings of the address, which have no account and get no email.
async function sendsHash(env, email, purpose) {
  const counted = purpose === 'signup' ? mailbox(email) : email;
  return toBase64url(await hmac(env.PEPPER, `email-code sends\n${purpose}\n${counted}`));
}

// What unlock emails that go out count under: the mailbox. Only emails to an account count there, so requests for
// spellings without an account still can't use up an owner's, while the accounts at the tags of one mailbox, and the
// accounts made again at an address, share its ten a day.
async function unlockHash(env, email) {
  return toBase64url(await hmac(env.PEPPER, `email-code unlock mail\n${mailbox(email)}`));
}

async function tokenHash(token) {
  return toBase64url(await sha256(utf8(token)));
}

async function codeHashes(env, email, purpose, challenge, code) {
  return {
    challenge: toBase64url(await sha256(utf8(challenge))),
    address: await addressHash(env, email),
    purpose,
    code: toBase64url(await hmac(env.PEPPER, `email-code\n${purpose}\n${challenge}\n${email}\n${code}`))
  };
}
