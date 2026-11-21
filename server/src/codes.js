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
import { accountName, accountObject, emailCodesOn, limitRate, positive, registryObject, signups } from './config.js';
import { codeMail } from './code-text.js';
import { json } from './http.js';
import * as input from './input.js';
import { HttpError, invalid } from './input.js';
import { sendMail } from './mail.js';
import { language } from './privacy.js';

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
// ones that reach addresses without an account. Unlock emails go only to accounts on this server, at most ten a day
// each, so MAX_ACCOUNTS bounds them, and a limit for the whole server would only let a stranger use them up.
const PER_HOUR = 100;

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
  const lang = language(body.lang, request.headers.get('accept-language'));
  const challenge = toBase64url(randomBytes(32));
  const token = toBase64url(randomBytes(32));
  const code = newCode();
  const entry = { ...(await codeHashes(env, email, purpose, challenge, code)), token: await tokenHash(token) };
  const issued = await registryObject(env).issueCode(entry, { ...CODE_RULES, max: purpose === 'signup' ? max : 0 });
  if (issued.result === 'full') throw new HttpError(403, 'signups_closed', 'This server has no room for new accounts.');
  if (issued.result !== 'ok') {
    throw new HttpError(429, 'rate_limited', 'This address got too many codes. Try again later.', {
      'retry-after': String(issued.retryAfter)
    });
  }
  const host = new URL(request.url).host;
  ctx.waitUntil(
    deliver(env, { email, purpose, code, token, lang, host, id: entry.challenge }).catch((err) =>
      console.error('Sending a code failed:', err?.stack || err)
    )
  );
  return json(202, { challenge, expiresIn: CODE_TTL / 1000 });
}

// Whether the address has an account decides what goes out, so this runs after the answer. Sign-up emails count
// toward the hourly limit, and one Resend refused is given back. A code whose long code didn't go out, because no
// email or only the note went or Resend refused the email, is kept for its 10 minutes and not a day.
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
  const operator = typeof env.OPERATOR_NAME === 'string' && env.OPERATOR_NAME.trim() ? env.OPERATOR_NAME.trim() : null;
  const codes = kind === 'exists' ? {} : { code, token };
  const sent = await sendMail(env, { to: email, ...codeMail(kind, { ...codes, host, operator, lang }) });
  // Resend refused it for good, so the long code went nowhere: the row goes with the six digits, as above.
  if (sent === 'refused') {
    await registry.shortenCode(id);
    if (slot !== null) await registry.refundMail('signup', slot);
  }
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

// Runs a sign-in or recovery past the account's lock with a code for unlock, which it holds for the whole call. run
// gets the option the account object takes for that. A wrong password or recovery key (401) costs the code a try.
// Success uses the code up, unless keep: recover/start leaves it for recover/finish.
export async function unlocked(env, email, emailCode, run, keep = false) {
  const held = await claimCode(env, email, 'unlock', emailCode);
  let result = null;
  try {
    result = await run({ unlocked: true });
  } finally {
    const outcome = result?.status === 401 ? 'failed' : result?.status === 200 && !keep ? 'used' : 'keep';
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
