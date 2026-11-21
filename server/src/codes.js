// Codes sent by email (PROTOCOL.md, POST /v1/email-code): six digits that show someone reads the mail of an address.
// With SIGNUPS on verified, a new account without an invite code needs one (purpose signup). On every server that
// sends mail, one also lets the owner sign in or recover while other people's failed attempts lock the account
// (purpose unlock).
//
// Asking for a code answers with a challenge: 32 random bytes that only the asking device knows. A code counts only
// together with its challenge, and wrong tries count against that challenge alone, so nobody can use up the tries of
// a code someone else asked for.
//
// The registry keeps each code as three hashes: of the challenge, of the address, and of the code bound to the
// challenge, the address and the purpose. The last two are made with PEPPER, so a copy of the registry gives away
// neither the address nor, by trying all million codes, the code.
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
// How long a code works, and how many wrong tries one challenge gets.
export const CODE_TTL = 10 * 60 * 1000;
export const ATTEMPTS = 5;
// To one address, whatever the purpose: at least a minute apart, at most five in an hour and ten in a day.
export const CODE_RULES = { ttl: CODE_TTL, gap: 60 * 1000, hourly: 5, daily: 10 };
// The most codes of one purpose the whole server hands out in an hour, unless EMAIL_CODES_PER_HOUR says otherwise.
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
  return purposes.length > 0 ? { purposes, digits: DIGITS, expiresIn: CODE_TTL / 1000 } : null;
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
  const code = newCode();
  const issued = await registryObject(env).issueCode(await hashes(env, email, purpose, challenge, code), {
    ...CODE_RULES,
    perHour: positive(env.EMAIL_CODES_PER_HOUR, PER_HOUR),
    max: purpose === 'signup' ? max : 0
  });
  if (issued.result === 'full') throw new HttpError(403, 'signups_closed', 'This server has no room for new accounts.');
  if (issued.result !== 'ok') {
    const message =
      issued.result === 'busy'
        ? 'This server has sent too many codes this hour. Try again later.'
        : 'This address got too many codes. Try again later.';
    throw new HttpError(429, 'rate_limited', message, { 'retry-after': String(issued.retryAfter) });
  }
  const host = new URL(request.url).host;
  ctx.waitUntil(
    deliver(env, { email, purpose, code, lang, host }).catch((err) => console.error('Sending a code failed:', err?.stack || err))
  );
  return json(202, { challenge, expiresIn: CODE_TTL / 1000 });
}

// Whether the address has an account decides what goes out, so this runs after the answer.
async function deliver(env, { email, purpose, code, lang, host }) {
  const exists = await accountObject(env, await accountName(env, email)).exists();
  const kind = purpose === 'signup' ? (exists ? 'exists' : 'signup') : exists ? 'unlock' : null;
  if (!kind) return;
  const operator = typeof env.OPERATOR_NAME === 'string' && env.OPERATOR_NAME.trim() ? env.OPERATOR_NAME.trim() : null;
  const mail = codeMail(kind, { code: kind === 'exists' ? null : code, host, operator, lang });
  await sendMail(env, { to: email, ...mail });
}

// emailCode in a sign-up, sign-in or recovery: null when it is absent, else { challenge, code }. Spaces and dashes in
// the code are left out, as people type them.
export function emailCodeField(value) {
  if (value === undefined || value === null) return null;
  if (!input.isObjectValue(value)) throw invalid('emailCode must be an object with a challenge and a code.', 'emailCode');
  const challenge = typeof value.challenge === 'string' ? value.challenge : '';
  const bytes = fromBase64url(challenge);
  if (!bytes || bytes.length !== 32) throw invalid('emailCode.challenge must be 32 bytes in base64url.', 'emailCode');
  const code = typeof value.code === 'string' && value.code.length <= 32 ? value.code.replace(/[\s-]/g, '') : '';
  if (!/^[0-9]{6}$/.test(code)) throw invalid(`emailCode.code must be ${DIGITS} digits.`, 'emailCode');
  return { challenge, code };
}

// Checks a code for an address and purpose, and returns its challenge's hash for useCode and failCode. A wrong code
// is 403 code_wrong, with the tries its challenge has left; one that expired, was used or has no tries left is 403
// code_expired.
export async function checkCode(env, email, purpose, emailCode) {
  const registry = registryObject(env);
  if (!registry) throw expired();
  const entry = await hashes(env, email, purpose, emailCode.challenge, emailCode.code);
  const checked = await registry.checkCode(entry, ATTEMPTS);
  if (checked.result === 'wrong') {
    throw new HttpError(403, 'code_wrong', 'The code is wrong.', {}, { attemptsLeft: checked.attemptsLeft });
  }
  if (checked.result !== 'ok') throw expired();
  return entry.challenge;
}

// For POST /v1/signup on a verified server, without an invite code or invitation that works.
export async function signupCode(env, email, value) {
  const emailCode = emailCodeField(value);
  if (!emailCode) {
    throw new HttpError(403, 'code_required', 'This server checks the email address first. Ask for a code and sign up with it.');
  }
  return checkCode(env, email, 'signup', emailCode);
}

export async function useCode(env, challenge) {
  await registryObject(env)?.useCode(challenge);
}

// Runs a sign-in or recovery past the account's lock once emailCode checks out for unlock. run gets the option the
// account object takes for that. A wrong password or recovery key (401) costs the challenge a try, as a wrong code
// does. Success uses the code up, unless keep: recover/start leaves it for recover/finish.
export async function unlocked(env, email, emailCode, run, keep = false) {
  const challenge = await checkCode(env, email, 'unlock', emailCode);
  const result = await run({ unlocked: true });
  const registry = registryObject(env);
  if (result.status === 401) await registry.failCode(challenge, ATTEMPTS);
  else if (result.status === 200 && !keep) await registry.useCode(challenge);
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

async function hashes(env, email, purpose, challenge, code) {
  return {
    challenge: toBase64url(await sha256(utf8(challenge))),
    address: toBase64url(await hmac(env.PEPPER, `email-code address\n${email}`)),
    purpose,
    code: toBase64url(await hmac(env.PEPPER, `email-code\n${purpose}\n${challenge}\n${email}\n${code}`))
  };
}
