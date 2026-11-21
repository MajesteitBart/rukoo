// Codes by email (PROTOCOL.md, POST /v1/email-code): asking for one, signing up with one on a verified server, and
// signing in or recovering with one while the account is locked. Mail goes to the stand-in in fixtures/fake-resend.js.

import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { hmac, sha256, toBase64url, utf8 } from '../src/bytes.js';
import { registryObject } from '../src/config.js';
import worker from '../src/index.js';
import { FakeResend, MAIL_VARS, installFakeResend } from './fixtures/fake-resend.js';
import { KDF, call, device, key, newEmail, randomIp, salt, sealed, signup, withVars } from './helpers.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const VERIFIED = { ...MAIL_VARS, SIGNUPS: 'verified' };

const resend = new FakeResend();
let restore;
beforeAll(() => {
  restore = installFakeResend(resend);
});
afterAll(() => restore());
beforeEach(() => resend.reset());
afterEach(() => vi.useRealTimers());

function later(ms) {
  vi.setSystemTime(Date.now() + ms);
}

// A request through the Worker with these vars, which waits for what it does after answering, such as sending mail.
async function post(path, body, vars = VERIFIED, headers = {}) {
  const ctx = createExecutionContext();
  const request = new Request(`https://accounts.example${path}`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': randomIp(), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const response = await worker.fetch(request, withVars(vars), ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

function askCode(email, purpose = 'signup', vars = VERIFIED, extra = {}) {
  return post('/v1/email-code', { email, purpose, ...extra }, vars);
}

// Asks for a code and reads it from the mail: { challenge, code, token }, where token is the long code.
async function codeFor(email, purpose = 'signup', vars = VERIFIED) {
  const res = await askCode(email, purpose, vars);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const code = resend.code(email);
  expect(code).toMatch(/^\d{6}$/);
  return { challenge: res.body.challenge, code, token: resend.token(email) };
}

const sixDigits = ({ challenge, code }) => ({ challenge, code });
const longCode = ({ token }) => ({ token });

function person(email = newEmail()) {
  return {
    email,
    kdf: KDF,
    salt: salt(),
    authKey: key(),
    wrappedKey: sealed(),
    recoveryAuth: key(),
    recoveryWrappedKey: sealed(),
    device: device()
  };
}

function signUp(body, vars = VERIFIED) {
  return post('/v1/signup', body, vars);
}

function signIn(who, emailCode, authKey = who.authKey) {
  return post('/v1/login', { email: who.email, authKey, device: device(), emailCode }, MAIL_VARS);
}

function wrongLogin(email) {
  return call('POST', '/v1/login', { body: { email, authKey: key(), device: device() } });
}

async function lockedAccount() {
  const who = await signup();
  for (let i = 0; i < 10; i++) await wrongLogin(who.email);
  expect((await call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } })).status).toBe(429);
  return who;
}

function registrySql(fn) {
  return runInDurableObject(registryObject(env), (instance, state) => fn(state.storage.sql));
}

const other = (code) => (code === '000000' ? '000001' : '000000');

describe('POST /v1/email-code', () => {
  it('mails a sign-up code and a long code to a new address, and answers with a challenge', async () => {
    const email = newEmail();
    const res = await askCode(email);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresIn: 600 });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [mail] = resend.to(email);
    expect(mail.from).toBe(MAIL_VARS.MAIL_FROM);
    expect(mail.to).toEqual([email]);
    expect(mail.subject).toBe('Your Rukoo sign-up code');
    const code = resend.code(email);
    const token = resend.token(email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(res.body.challenge);
    expect(mail.text).toContain('Your code to make a Rukoo account on accounts.example:');
    expect(mail.text).toContain('It works once, on any device, for a day:');
    expect(mail.html).toContain(`>${code}</p>`);
    expect(mail.html).toContain(`>${token}</p>`);
    expect(mail.text).not.toContain(res.body.challenge);
  });

  it('writes in Dutch when the request or the browser asks for it', async () => {
    const asked = newEmail();
    await askCode(asked, 'signup', VERIFIED, { lang: 'nl' });
    expect(resend.to(asked)[0].subject).toBe('Je code voor een Rukoo-account');
    expect(resend.to(asked)[0].html).toContain('<html lang="nl">');
    const browser = newEmail();
    await post('/v1/email-code', { email: browser, purpose: 'signup' }, VERIFIED, { 'accept-language': 'nl-NL,nl;q=0.9' });
    expect(resend.to(browser)[0].text).toContain('Vul hem binnen 10 minuten in Rukoo in');
    const english = newEmail();
    await askCode(english, 'signup', VERIFIED, { lang: 'de' });
    expect(resend.to(english)[0].subject).toBe('Your Rukoo sign-up code');
  });

  it('answers the same for an address with an account, and mails a note in place of codes', async () => {
    const who = await signup();
    const res = await askCode(who.email);
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(['challenge', 'expiresIn']);
    const [mail] = resend.to(who.email);
    expect(mail.subject).toBe('You already have a Rukoo account');
    expect(resend.code(who.email)).toBe(null);
    expect(resend.token(who.email)).toBe(null);
  });

  it('mails an unlock code only to an address with an account, with the same answer either way', async () => {
    const nobody = newEmail();
    const none = await askCode(nobody, 'unlock');
    expect(none.status).toBe(202);
    expect(resend.to(nobody)).toHaveLength(0);
    const who = await signup();
    const res = await askCode(who.email, 'unlock', MAIL_VARS);
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(none.body).sort());
    expect(resend.to(who.email)[0].subject).toBe('Your Rukoo sign-in code');
    expect(resend.code(who.email)).toMatch(/^\d{6}$/);
  });

  it('answers 503 without mail, and sends sign-up codes only where sign-ups are verified', async () => {
    for (const vars of [{ SIGNUPS: 'verified' }, { ...VERIFIED, RESEND_API_KEY: '' }, { ...VERIFIED, MAIL_FROM: ' ' }, { ...VERIFIED, REGISTRY: undefined }]) {
      const res = await askCode(newEmail(), 'unlock', vars);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('mail_unavailable');
    }
    for (const mode of ['invite', 'open', 'closed']) {
      const refused = await askCode(newEmail(), 'signup', { ...MAIL_VARS, SIGNUPS: mode });
      expect(refused.status).toBe(400);
      expect(refused.body.field).toBe('purpose');
      expect((await askCode(newEmail(), 'unlock', { ...MAIL_VARS, SIGNUPS: mode })).status).toBe(202);
    }
  });

  it('checks its input', async () => {
    for (const body of [{ purpose: 'signup' }, { email: 'not an address', purpose: 'signup' }, { email: newEmail() }, { email: newEmail(), purpose: 'reset' }]) {
      const res = await post('/v1/email-code', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('invalid');
    }
  });

  it('sends no sign-up code while the server is full', async () => {
    const accounts = await registryObject(env).accounts();
    const res = await askCode(newEmail(), 'signup', { ...VERIFIED, MAX_ACCOUNTS: String(accounts) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signups_closed');
    expect((await askCode(newEmail(), 'unlock', { ...VERIFIED, MAX_ACCOUNTS: String(accounts) })).status).toBe(202);
  });

  it('sends one address a code of each purpose a minute, five an hour and ten a day, with or without an account', async () => {
    for (const email of [newEmail(), (await signup()).email]) {
      expect((await askCode(email)).status).toBe(202);
      const soon = await askCode(email);
      expect(soon.status).toBe(429);
      expect(soon.body.error).toBe('rate_limited');
      expect(Number(soon.headers.get('retry-after'))).toBe(60);
      // Sign-in codes are counted apart, so sign-up requests can't use them up.
      expect((await askCode(email, 'unlock')).status).toBe(202);
      for (let i = 0; i < 4; i++) {
        later(MINUTE + 1000);
        expect((await askCode(email)).status).toBe(202);
      }
      later(MINUTE + 1000);
      const hour = await askCode(email);
      expect(hour.status).toBe(429);
      expect(Number(hour.headers.get('retry-after'))).toBeGreaterThan(50 * 60);
      later(55 * MINUTE);
      for (let i = 0; i < 5; i++) {
        expect((await askCode(email)).status).toBe(202);
        later(MINUTE + 1000);
      }
      const day = await askCode(email);
      expect(day.status).toBe(429);
      expect(Number(day.headers.get('retry-after'))).toBeGreaterThan(20 * 60 * 60);
      later(DAY);
      expect((await askCode(email)).status).toBe(202);
      vi.useRealTimers();
    }
  });

  it('sends at most EMAIL_CODES_PER_HOUR sign-up emails, counting only emails that go out, and no limit on unlock emails', async () => {
    const slot = Math.floor(Date.now() / HOUR);
    const setCount = (count) =>
      registrySql((sql) =>
        sql.exec(
          'INSERT INTO code_mail (purpose, hour, count) VALUES (?, ?, ?) ON CONFLICT (purpose) DO UPDATE SET hour = excluded.hour, count = excluded.count',
          'signup',
          slot,
          count
        )
      );
    const count = () => registrySql((sql) => sql.exec("SELECT count FROM code_mail WHERE purpose = 'signup'").one().count);
    await setCount(4);
    const vars = { ...VERIFIED, EMAIL_CODES_PER_HOUR: '5' };
    // Requests that send nothing, and unlock emails, use none of the hour's sign-up emails.
    for (let i = 0; i < 3; i++) expect((await askCode(newEmail(), 'unlock', vars)).status).toBe(202);
    const first = newEmail();
    expect((await askCode(first, 'signup', vars)).status).toBe(202);
    expect(resend.to(first)).toHaveLength(1);
    expect(await count()).toBe(5);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The answer stays the same when this hour's emails are used up; the email doesn't go.
      const second = newEmail();
      const res = await askCode(second, 'signup', vars);
      expect(res.status).toBe(202);
      expect(resend.to(second)).toHaveLength(0);
      expect(JSON.stringify(errors.mock.calls)).toContain('EMAIL_CODES_PER_HOUR');
      // An email Resend refuses is given back.
      await setCount(0);
      resend.failNext({ status: 422, name: 'validation_error' });
      expect((await askCode(newEmail(), 'signup', vars)).status).toBe(202);
      expect(await count()).toBe(0);
    } finally {
      errors.mockRestore();
    }
    await setCount(5);
    const who = await signup();
    expect((await askCode(who.email, 'unlock', { ...vars, EMAIL_CODES_PER_HOUR: '1' })).status).toBe(202);
    expect(resend.to(who.email)).toHaveLength(1);
  });

  it('keeps a code for 10 minutes only when no email with its long code went out', async () => {
    const until = (challenge) =>
      sha256(utf8(challenge)).then((hash) =>
        registrySql((sql) => sql.exec('SELECT until - codeUntil AS extra FROM codes WHERE challenge = ?', toBase64url(hash)).one().extra)
      );
    const nobody = await askCode(newEmail(), 'unlock');
    expect(await until(nobody.body.challenge)).toBe(0);
    const note = await askCode((await signup()).email, 'signup');
    expect(await until(note.body.challenge)).toBe(0);
    const sent = await askCode(newEmail(), 'signup');
    expect(await until(sent.body.challenge)).toBe(DAY - 10 * MINUTE);
    // An email Resend refused for good carried its long code nowhere, for either purpose.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      resend.failNext({ status: 422, name: 'validation_error' });
      const refusedSignup = await askCode(newEmail(), 'signup');
      expect(await until(refusedSignup.body.challenge)).toBe(0);
      const owner = (await signup()).email;
      resend.failNext({ status: 422, name: 'validation_error' });
      const refusedUnlock = await askCode(owner, 'unlock');
      expect(await until(refusedUnlock.body.challenge)).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps only hashes, and an alarm deletes them a day after the request', async () => {
    const email = newEmail();
    const { challenge, code, token } = await codeFor(email);
    const address = toBase64url(await hmac(env.PEPPER, `email-code address\n${email}`));
    const rows = await registrySql((sql) => ({
      codes: sql.exec('SELECT * FROM codes WHERE address = ?', address).toArray(),
      sends: sql.exec('SELECT * FROM code_sends WHERE address = ?', address).toArray()
    }));
    expect(rows.codes).toHaveLength(1);
    expect(rows.sends).toHaveLength(1);
    const stored = JSON.stringify(rows);
    for (const secret of [email, code, challenge, token]) expect(stored).not.toContain(secret);

    // After 10 minutes the six digits are gone; the long code works for the rest of the day.
    later(10 * MINUTE + 1000);
    await runDurableObjectAlarm(registryObject(env));
    expect((await signUp({ ...person(email), emailCode: { challenge, code } })).body.error).toBe('code_expired');
    expect(await registrySql((sql) => sql.exec('SELECT COUNT(*) AS n FROM codes WHERE address = ?', address).one().n)).toBe(1);
    expect(await runInDurableObject(registryObject(env), (instance, state) => state.storage.getAlarm())).not.toBe(null);

    later(DAY);
    await runDurableObjectAlarm(registryObject(env));
    const left = await registrySql((sql) => ({
      codes: sql.exec('SELECT COUNT(*) AS n FROM codes WHERE address = ?', address).one().n,
      sends: sql.exec('SELECT COUNT(*) AS n FROM code_sends WHERE address = ?', address).one().n
    }));
    expect(left).toEqual({ codes: 0, sends: 0 });
  });

  it('tries Resend again when its limit per second answers, under one idempotency key', async () => {
    resend.failNext({ status: 429, name: 'rate_limit_exceeded', retryAfter: 0 }, { status: 503, name: 'application_error' });
    const email = newEmail();
    expect((await askCode(email)).status).toBe(202);
    expect(resend.to(email)).toHaveLength(1);
    expect(resend.keys).toHaveLength(3);
    expect(new Set(resend.keys).size).toBe(1);
    expect(resend.keys[0]).toMatch(/^email-code\//);
  });

  it('gives up at once on a quota, and after three tries otherwise, logging no address', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      resend.failNext({ status: 429, name: 'daily_quota_exceeded' });
      const quota = newEmail();
      expect((await askCode(quota)).status).toBe(202);
      expect(resend.keys).toHaveLength(1);
      expect(resend.to(quota)).toHaveLength(0);

      resend.status = 500;
      const down = newEmail();
      const res = await askCode(down);
      expect(res.status).toBe(202);
      expect(resend.keys).toHaveLength(4);
      expect(resend.to(down)).toHaveLength(0);
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).toContain('daily_quota_exceeded');
      expect(logged).toContain('500');
      for (const secret of [quota, down, MAIL_VARS.RESEND_API_KEY]) expect(logged).not.toContain(secret);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('signing up on a verified server', () => {
  it('needs a code from the address, and uses it up', async () => {
    const body = person();
    const missing = await signUp(body);
    expect(missing.status).toBe(403);
    expect(missing.body.error).toBe('code_required');
    const codes = await codeFor(body.email);
    const made = await signUp({ ...body, emailCode: sixDigits(codes) });
    expect(made.status).toBe(201);
    expect(made.body.account.email).toBe(body.email);
    const again = await signUp({ ...person(body.email), emailCode: sixDigits(codes) });
    expect(again.status).toBe(403);
    expect(again.body.error).toBe('code_expired');
    // The long code in the same email went with it.
    expect((await signUp({ ...person(body.email), emailCode: longCode(codes) })).body.error).toBe('code_expired');
  });

  it('takes the code as people type it, and checks its shape', async () => {
    const body = person();
    const codes = await codeFor(body.email);
    const typed = `${codes.code.slice(0, 3)} ${codes.code.slice(3)}`;
    for (const bad of [
      { challenge: codes.challenge },
      { challenge: codes.challenge, code: '12345' },
      { challenge: 'short', code: codes.code },
      { token: 'short' },
      { token: 42 },
      'code',
      [codes]
    ]) {
      const res = await signUp({ ...body, emailCode: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.field).toBe('emailCode');
    }
    expect((await signUp({ ...body, emailCode: { challenge: codes.challenge, code: typed } })).status).toBe(201);
  });

  it('gives a challenge five tries, and a stranger without it none at a code someone else asked for', async () => {
    const body = person();
    const mine = await codeFor(body.email);
    later(MINUTE + 1000);
    // Someone else asks for a code for the same address and guesses at it. The mail goes to the owner.
    const theirs = await askCode(body.email);
    const wrong = other(resend.code(body.email));
    for (let left = 4; left >= 0; left--) {
      const res = await signUp({ ...body, emailCode: { challenge: theirs.body.challenge, code: wrong } });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'code_wrong', attemptsLeft: left });
    }
    const out = await signUp({ ...body, emailCode: { challenge: theirs.body.challenge, code: resend.code(body.email) } });
    expect(out.body.error).toBe('code_expired');
    // The owner's own code still works.
    expect((await signUp({ ...body, emailCode: sixDigits(mine) })).status).toBe(201);
  });

  it('lets the owner sign up with the long code from an email someone else asked for, after its tries ran out', async () => {
    const body = person();
    const theirs = await askCode(body.email);
    const token = resend.token(body.email);
    for (let i = 0; i < 5; i++) {
      await signUp({ ...body, emailCode: { challenge: theirs.body.challenge, code: other(resend.code(body.email)) } });
    }
    expect((await signUp({ ...body, emailCode: { token } })).status).toBe(201);
    expect((await signUp({ ...person(body.email), emailCode: { token } })).body.error).toBe('code_expired');
  });

  it('binds a code to its address and its purpose', async () => {
    const body = person();
    const codes = await codeFor(body.email);
    const elsewhere = await signUp({ ...person(), emailCode: sixDigits(codes) });
    expect(elsewhere.body).toMatchObject({ error: 'code_wrong', attemptsLeft: 4 });
    expect((await signUp({ ...person(), emailCode: longCode(codes) })).body.error).toBe('code_expired');
    const who = await signup();
    const unlock = await codeFor(who.email, 'unlock');
    expect((await signUp({ ...person(who.email), emailCode: sixDigits(unlock) })).body.error).toBe('code_wrong');
    expect((await signUp({ ...person(who.email), emailCode: longCode(unlock) })).body.error).toBe('code_expired');
    expect((await signUp({ ...body, emailCode: longCode(codes) })).status).toBe(201);
  });

  it('lets the six digits expire after 10 minutes and the long code after a day', async () => {
    const body = person();
    const codes = await codeFor(body.email);
    later(10 * MINUTE + 1000);
    const res = await signUp({ ...body, emailCode: sixDigits(codes) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('code_expired');
    later(DAY);
    expect((await signUp({ ...body, emailCode: longCode(codes) })).body.error).toBe('code_expired');
  });

  it('keeps the code when the sign-up fails, so it works once the server has room', async () => {
    const body = person();
    const codes = await codeFor(body.email);
    const accounts = await registryObject(env).accounts();
    const full = await signUp({ ...body, emailCode: sixDigits(codes) }, { ...VERIFIED, MAX_ACCOUNTS: String(accounts) });
    expect(full.status).toBe(403);
    expect(full.body.error).toBe('signups_closed');
    expect(await registryObject(env).accounts()).toBe(accounts);
    expect((await signUp({ ...body, emailCode: sixDigits(codes) }, { ...VERIFIED, MAX_ACCOUNTS: String(accounts + 1) })).status).toBe(201);
  });

  it('still takes an invite code without a code from the address', async () => {
    expect((await signUp({ ...person(), invite: 'first-code' })).status).toBe(201);
    const wrong = await signUp({ ...person(), invite: 'third-code' });
    expect(wrong.body.error).toBe('code_required');
  });

  it('works as an invite server while it can’t send mail', async () => {
    const vars = { SIGNUPS: 'verified' };
    const res = await signUp(person(), vars);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invite_required');
    expect((await signUp({ ...person(), invite: 'first-code' }, vars)).status).toBe(201);
    const info = (await call('GET', '/v1/info', { vars })).body;
    expect(info.signups).toBe('invite');
    expect(info.emailCodes).toBeUndefined();
  });

  it('leaves invite, open and closed servers as they were', async () => {
    const mailed = (mode) => ({ ...MAIL_VARS, SIGNUPS: mode });
    expect((await signUp(person(), mailed('invite'))).body.error).toBe('invite_required');
    expect((await signUp({ ...person(), invite: 'second-code' }, mailed('invite'))).status).toBe(201);
    expect((await signUp(person(), mailed('open'))).status).toBe(201);
    expect((await signUp(person(), mailed('closed'))).body.error).toBe('signups_closed');
  });
});

describe('signing in while the account is locked', () => {
  it('lets the owner in with an unlock code, and keeps the lock for everyone else', async () => {
    const who = await lockedAccount();
    const codes = await codeFor(who.email, 'unlock', MAIL_VARS);
    const res = await signIn(who, sixDigits(codes));
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.wrappedKey).toBe(who.wrappedKey);
    const without = await call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } });
    expect(without.status).toBe(429);
    const reused = await signIn(who, sixDigits(codes));
    expect(reused.status).toBe(403);
    expect(reused.body.error).toBe('code_expired');
  });

  it('lets the owner in with the long code from any email, also when strangers used up the address’s codes', async () => {
    const who = await lockedAccount();
    // A stranger asks for every unlock code the address gets this hour. Each email still reaches the owner.
    for (let i = 0; i < 5; i++) {
      expect((await askCode(who.email, 'unlock', MAIL_VARS)).status).toBe(202);
      later(MINUTE + 1000);
    }
    expect((await askCode(who.email, 'unlock', MAIL_VARS)).status).toBe(429);
    const tokens = resend.to(who.email).map((mail) => mail.text.match(/^[A-Za-z0-9_-]{43}$/m)[0]);
    expect(tokens).toHaveLength(5);
    expect((await signIn(who, { token: tokens[0] })).status).toBe(200);
    expect((await signIn(who, { token: tokens[0] })).body.error).toBe('code_expired');
    expect((await signIn(who, { token: tokens[4] })).status).toBe(200);
  });

  it('counts a wrong password with a right code against the code, and not toward the lock', async () => {
    const who = await signup();
    const codes = await codeFor(who.email, 'unlock', MAIL_VARS);
    for (let i = 0; i < 5; i++) expect((await signIn(who, longCode(codes), key())).status).toBe(401);
    expect((await signIn(who, longCode(codes))).body.error).toBe('code_expired');
    expect((await signIn(who, sixDigits(codes))).body.error).toBe('code_expired');
    // Five wrong passwords with the code left the account's own count alone: nine more still don't lock it.
    for (let i = 0; i < 9; i++) expect((await wrongLogin(who.email)).status).toBe(401);
    expect((await call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } })).status).toBe(200);
  });

  it('holds a code for one request at a time', async () => {
    const who = await lockedAccount();
    const codes = await codeFor(who.email, 'unlock', MAIL_VARS);
    const both = await Promise.all([signIn(who, longCode(codes)), signIn(who, longCode(codes))]);
    expect(both.filter((res) => res.status === 200)).toHaveLength(1);
    const loser = both.find((res) => res.status !== 200);
    expect(['code_in_use', 'code_expired']).toContain(loser.body.error);

    // Many wrong passwords at once get no more than the code's five tries.
    const second = await lockedAccount();
    const again = await codeFor(second.email, 'unlock', MAIL_VARS);
    const burst = await Promise.all(Array.from({ length: 8 }, () => signIn(second, longCode(again), key())));
    expect(burst.filter((res) => res.status === 401).length).toBeLessThanOrEqual(5);
    for (const res of burst.filter((r) => r.status !== 401)) expect(['code_in_use', 'code_expired']).toContain(res.body.error);
  });

  it('keeps a claimed code from a second claim until it is settled, or the claim lapses', async () => {
    const who = await signup();
    const codes = await codeFor(who.email, 'unlock', MAIL_VARS);
    const entry = {
      token: toBase64url(await sha256(utf8(codes.token))),
      address: toBase64url(await hmac(env.PEPPER, `email-code address\n${who.email}`)),
      purpose: 'unlock'
    };
    const registry = registryObject(env);
    const failures = () =>
      registrySql((sql) => sql.exec('SELECT failures FROM codes WHERE challenge = ?', first.id).toArray()[0]?.failures ?? null);
    const first = await registry.claimCode(entry, 5);
    expect(first.result).toBe('ok');
    expect((await registry.claimCode(entry, 5)).result).toBe('busy');
    await registry.settleCode(first.id, first.claim, 'keep', 5);
    const second = await registry.claimCode(entry, 5);
    expect(second.result).toBe('ok');
    // A request that never settles holds the code for a minute at most.
    later(61 * 1000);
    const third = await registry.claimCode(entry, 5);
    expect(third.result).toBe('ok');
    // The lapsed claim settling late can't give back the newer claim, but its wrong password still counts.
    await registry.settleCode(second.id, second.claim, 'failed', 5);
    expect(await failures()).toBe(1);
    expect((await registry.claimCode(entry, 5)).result).toBe('busy');
    await registry.settleCode(third.id, third.claim, 'used', 5);
    expect(await failures()).toBe(null);
    expect((await registry.claimCode(entry, 5)).result).toBe('expired');
  });

  it('refuses a wrong code without touching the account', async () => {
    const who = await lockedAccount();
    const codes = await codeFor(who.email, 'unlock', MAIL_VARS);
    const res = await signIn(who, { challenge: codes.challenge, code: other(codes.code) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'code_wrong', attemptsLeft: 4 });
    const asSignup = await signUp({ ...person(who.email), emailCode: sixDigits(codes) });
    expect(asSignup.body.error).toBe('code_wrong');
    expect((await signIn(who, sixDigits(codes))).status).toBe(200);
  });

  it('lets the owner recover a locked account with an unlock code, which recover/finish uses up', async () => {
    const who = await lockedAccount();
    const codes = await codeFor(who.email, 'unlock', MAIL_VARS);
    const emailCode = sixDigits(codes);
    const start = await post('/v1/recover/start', { email: who.email, recoveryAuth: who.recoveryAuth, emailCode }, MAIL_VARS);
    expect(start.status).toBe(200);
    expect(start.body.recoveryWrappedKey).toBe(who.recoveryWrappedKey);
    const finish = {
      email: who.email,
      recoveryAuth: who.recoveryAuth,
      kdf: KDF,
      salt: salt(),
      authKey: key(),
      wrappedKey: sealed(),
      device: device(),
      emailCode
    };
    expect((await post('/v1/recover/finish', finish, MAIL_VARS)).status).toBe(200);
    expect((await post('/v1/recover/finish', finish, MAIL_VARS)).body.error).toBe('code_expired');
    // The old session ended with the recovery, as it always does.
    expect((await call('GET', '/v1/account', { token: who.token })).status).toBe(401);
  });

  it('counts a wrong recovery key with a right code against the code', async () => {
    const who = await lockedAccount();
    const codes = await codeFor(who.email, 'unlock', MAIL_VARS);
    const emailCode = sixDigits(codes);
    const res = await post('/v1/recover/start', { email: who.email, recoveryAuth: key(), emailCode }, MAIL_VARS);
    expect(res.status).toBe(401);
    const challenge = toBase64url(await sha256(utf8(codes.challenge)));
    const failures = await registrySql((sql) => sql.exec('SELECT failures FROM codes WHERE challenge = ?', challenge).one().failures);
    expect(failures).toBe(1);
    expect((await post('/v1/recover/start', { email: who.email, recoveryAuth: who.recoveryAuth, emailCode }, MAIL_VARS)).status).toBe(200);
  });
});

describe('what the server says about codes', () => {
  it('advertises email codes in GET /v1/info only while it sends them, and keeps older apps on invite codes', async () => {
    const info = async (vars) => (await call('GET', '/v1/info', { vars })).body;
    const off = await info({});
    expect(off.features).toEqual(['booking']);
    expect(off.emailCodes).toBeUndefined();
    const codes = (purposes) => ({ purposes, digits: 6, expiresIn: 600, tokenExpiresIn: 86400 });
    const invite = await info(MAIL_VARS);
    expect(invite).toMatchObject({ version: pkg.version, signups: 'invite', features: ['booking', 'email-codes'], emailCodes: codes(['unlock']) });
    // A verified server tells apps from before emailed codes to show the invite code field, which works there too.
    const verified = await info(VERIFIED);
    expect(verified.signups).toBe('invite');
    expect(verified.emailCodes).toEqual(codes(['signup', 'unlock']));
    expect((await info({ ...MAIL_VARS, SIGNUPS: 'open' })).signups).toBe('open');
    const chat = await info({ ...VERIFIED, WORKSPACE_MODE: 'on' });
    expect(chat.features).toEqual(['booking', 'workspaces-v1', 'email-codes']);
    expect(chat.workspace.inviteSignups).toBe(true);
    expect((await info({ ...VERIFIED, REGISTRY: undefined })).emailCodes).toBeUndefined();
  });

  it('says on / that addresses are checked', async () => {
    const res = await call('GET', '/', { vars: VERIFIED });
    expect(res.text).toContain('after confirming their email address with a code sent to it.');
  });

  it('covers codes in the privacy statement, in both languages, only while the server sends them', async () => {
    const page = async (lang, vars) => (await call('GET', `/privacy?lang=${lang}`, { vars })).text;
    const languages = {
      en: {
        heading: '<h2 id="email-codes">Email codes</h2>',
        resend: 'Resend, a service of Resend, Inc. in the United States',
        days: 'keeps them for 30 days',
        signup: 'Unless you sign up with an invite code or an invitation, we check it',
        unlock: 'lets you sign in or recover your account during the lock',
        kept: 'It keeps both also when no email goes out because the address has no account.',
        none: 'We don’t send mail to it and don’t check it.'
      },
      nl: {
        heading: '<h2 id="email-codes">E-mailcodes</h2>',
        resend: 'Resend, een dienst van Resend, Inc. in de Verenigde Staten',
        days: 'bewaart ze 30 dagen',
        signup: 'Tenzij je een account maakt met een uitnodigingscode of een uitnodiging, controleren we het',
        unlock: 'kun je tijdens de blokkade toch inloggen of je account herstellen',
        kept: 'Beide bewaart hij ook als er geen e-mail uitgaat omdat het adres geen account heeft.',
        none: 'We sturen er geen mail naar en controleren het niet.'
      }
    };
    for (const [lang, t] of Object.entries(languages)) {
      const verified = await page(lang, VERIFIED);
      for (const part of [t.heading, t.resend, t.days, t.signup, t.unlock, t.kept]) expect(verified, part).toContain(part);
      expect(verified).not.toContain(t.none);
      const unlockOnly = await page(lang, MAIL_VARS);
      for (const part of [t.heading, t.resend, t.unlock, t.kept]) expect(unlockOnly, part).toContain(part);
      expect(unlockOnly).not.toContain(t.signup);
      const off = await page(lang, {});
      expect(off).toContain(t.none);
      for (const part of [t.heading, t.resend, t.unlock]) expect(off, part).not.toContain(part);
    }
  });
});
