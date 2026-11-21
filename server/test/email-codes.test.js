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
const VERIFIED = { ...MAIL_VARS, SIGNUPS: 'verified' };

const resend = new FakeResend();
let restore;
beforeAll(() => {
  restore = installFakeResend(resend);
});
afterAll(() => restore());
beforeEach(() => {
  resend.status = 200;
});
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

// Asks for a code and reads it from the mail: { challenge, code }.
async function codeFor(email, purpose = 'signup', vars = VERIFIED) {
  const res = await askCode(email, purpose, vars);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const code = resend.code(email);
  expect(code).toMatch(/^\d{6}$/);
  return { challenge: res.body.challenge, code };
}

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

describe('POST /v1/email-code', () => {
  it('mails a sign-up code to a new address and answers with a challenge', async () => {
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
    expect(mail.text).toContain('Your code to make a Rukoo account on accounts.example:');
    expect(mail.html).toContain(`>${code}</p>`);
    expect(mail.text).not.toContain(res.body.challenge);
  });

  it('writes in Dutch when the request or the browser asks for it', async () => {
    const asked = newEmail();
    await askCode(asked, 'signup', VERIFIED, { lang: 'nl' });
    expect(resend.to(asked)[0].subject).toBe('Je code voor een Rukoo-account');
    expect(resend.to(asked)[0].html).toContain('<html lang="nl">');
    const browser = newEmail();
    await post('/v1/email-code', { email: browser, purpose: 'signup' }, VERIFIED, { 'accept-language': 'nl-NL,nl;q=0.9' });
    expect(resend.to(browser)[0].text).toContain('Vul hem binnen 10 minuten in Rukoo in.');
    const other = newEmail();
    await askCode(other, 'signup', VERIFIED, { lang: 'de' });
    expect(resend.to(other)[0].subject).toBe('Your Rukoo sign-up code');
  });

  it('answers the same for an address with an account, and mails a note in place of a code', async () => {
    const who = await signup();
    const res = await askCode(who.email);
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(['challenge', 'expiresIn']);
    const [mail] = resend.to(who.email);
    expect(mail.subject).toBe('You already have a Rukoo account');
    expect(resend.code(who.email)).toBe(null);
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

  it('sends one address a code a minute, five an hour and ten a day, with or without an account', async () => {
    for (const email of [newEmail(), (await signup()).email]) {
      const first = await askCode(email);
      expect(first.status).toBe(202);
      const soon = await askCode(email, 'unlock');
      expect(soon.status).toBe(429);
      expect(soon.body.error).toBe('rate_limited');
      expect(Number(soon.headers.get('retry-after'))).toBe(60);
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
      later(24 * 60 * MINUTE);
      expect((await askCode(email)).status).toBe(202);
      vi.useRealTimers();
    }
  });

  it('stops at EMAIL_CODES_PER_HOUR for the whole server, for each purpose on its own', async () => {
    const used = (purpose) =>
      registrySql((sql) => {
        const row = sql.exec('SELECT hour, count FROM code_hour WHERE purpose = ?', purpose).toArray()[0];
        return row && row.hour === Math.floor(Date.now() / (60 * MINUTE)) ? row.count : 0;
      });
    const vars = { ...VERIFIED, EMAIL_CODES_PER_HOUR: String((await used('signup')) + 2) };
    expect((await askCode(newEmail(), 'signup', vars)).status).toBe(202);
    expect((await askCode(newEmail(), 'signup', vars)).status).toBe(202);
    const busy = await askCode(newEmail(), 'signup', vars);
    expect(busy.status).toBe(429);
    expect(busy.body.error).toBe('rate_limited');
    expect(Number(busy.headers.get('retry-after'))).toBeLessThanOrEqual(3600);
    // Unlock codes have a count of their own.
    if ((await used('unlock')) + 1 < Number(vars.EMAIL_CODES_PER_HOUR)) {
      expect((await askCode(newEmail(), 'unlock', vars)).status).toBe(202);
    }
  });

  it('keeps only hashes, and an alarm deletes them when their time is up', async () => {
    const email = newEmail();
    const { challenge, code } = await codeFor(email);
    const address = toBase64url(await hmac(env.PEPPER, `email-code address\n${email}`));
    const rows = await registrySql((sql) => ({
      codes: sql.exec('SELECT * FROM codes WHERE address = ?', address).toArray(),
      sends: sql.exec('SELECT * FROM code_sends WHERE address = ?', address).toArray()
    }));
    expect(rows.codes).toHaveLength(1);
    expect(rows.sends).toHaveLength(1);
    const stored = JSON.stringify(rows);
    for (const secret of [email, code, challenge]) expect(stored).not.toContain(secret);

    later(10 * MINUTE + 1000);
    await runDurableObjectAlarm(registryObject(env));
    const left = await registrySql((sql) => ({
      codes: sql.exec('SELECT COUNT(*) AS n FROM codes WHERE address = ?', address).one().n,
      sends: sql.exec('SELECT COUNT(*) AS n FROM code_sends WHERE address = ?', address).one().n
    }));
    expect(left).toEqual({ codes: 0, sends: 1 });
    // The alarm comes back for the times codes were sent, which go a day after the last one.
    expect(await runInDurableObject(registryObject(env), (instance, state) => state.storage.getAlarm())).not.toBe(null);
    later(24 * 60 * MINUTE);
    await runDurableObjectAlarm(registryObject(env));
    expect(await registrySql((sql) => sql.exec('SELECT COUNT(*) AS n FROM code_sends WHERE address = ?', address).one().n)).toBe(0);
  });

  it('answers 202 when Resend fails, and logs no address', async () => {
    resend.status = 500;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const email = newEmail();
      const res = await askCode(email);
      expect(res.status).toBe(202);
      expect(resend.to(email)).toHaveLength(0);
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).toContain('500');
      expect(logged).not.toContain(email);
      expect(logged).not.toContain(MAIL_VARS.RESEND_API_KEY);
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
    const emailCode = await codeFor(body.email);
    const made = await signUp({ ...body, emailCode });
    expect(made.status).toBe(201);
    expect(made.body.account.email).toBe(body.email);
    const again = await signUp({ ...person(body.email), emailCode });
    expect(again.status).toBe(403);
    expect(again.body.error).toBe('code_expired');
  });

  it('takes the code as people type it, and checks its shape', async () => {
    const body = person();
    const emailCode = await codeFor(body.email);
    const typed = `${emailCode.code.slice(0, 3)} ${emailCode.code.slice(3)}`;
    for (const bad of [{ challenge: emailCode.challenge }, { ...emailCode, code: '12345' }, { ...emailCode, challenge: 'short' }, 'code', [emailCode]]) {
      const res = await signUp({ ...body, emailCode: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.field).toBe('emailCode');
    }
    expect((await signUp({ ...body, emailCode: { ...emailCode, code: typed } })).status).toBe(201);
  });

  it('gives a challenge five tries, and a stranger without it none at a code someone else asked for', async () => {
    const body = person();
    const mine = await codeFor(body.email);
    later(MINUTE + 1000);
    // Someone else asks for a code for the same address and guesses at it. The mail goes to the owner.
    const theirs = await askCode(body.email);
    const wrong = resend.code(body.email) === '000000' ? '000001' : '000000';
    for (let left = 4; left >= 0; left--) {
      const res = await signUp({ ...body, emailCode: { challenge: theirs.body.challenge, code: wrong } });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'code_wrong', attemptsLeft: left });
    }
    const out = await signUp({ ...body, emailCode: { challenge: theirs.body.challenge, code: resend.code(body.email) } });
    expect(out.body.error).toBe('code_expired');
    // The owner's own code still works.
    expect((await signUp({ ...body, emailCode: mine })).status).toBe(201);
  });

  it('binds a code to its address and its purpose', async () => {
    const body = person();
    const emailCode = await codeFor(body.email);
    const elsewhere = await signUp({ ...person(), emailCode });
    expect(elsewhere.body).toMatchObject({ error: 'code_wrong', attemptsLeft: 4 });
    const who = await signup();
    const unlock = await codeFor(who.email, 'unlock');
    const asSignup = await signUp({ ...person(who.email), emailCode: unlock });
    expect(asSignup.body.error).toBe('code_wrong');
    expect((await signUp({ ...body, emailCode })).status).toBe(201);
  });

  it('lets a code expire after 10 minutes', async () => {
    const body = person();
    const emailCode = await codeFor(body.email);
    later(10 * MINUTE + 1000);
    const res = await signUp({ ...body, emailCode });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('code_expired');
  });

  it('keeps the code when the sign-up fails, so it works once the server has room', async () => {
    const body = person();
    const emailCode = await codeFor(body.email);
    const accounts = await registryObject(env).accounts();
    const full = await signUp({ ...body, emailCode }, { ...VERIFIED, MAX_ACCOUNTS: String(accounts) });
    expect(full.status).toBe(403);
    expect(full.body.error).toBe('signups_closed');
    expect(await registryObject(env).accounts()).toBe(accounts);
    expect((await signUp({ ...body, emailCode }, { ...VERIFIED, MAX_ACCOUNTS: String(accounts + 1) })).status).toBe(201);
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
    expect((await call('GET', '/v1/info', { vars })).body.signups).toBe('invite');
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
    const emailCode = await codeFor(who.email, 'unlock', MAIL_VARS);
    const res = await post('/v1/login', { email: who.email, authKey: who.authKey, device: device(), emailCode }, MAIL_VARS);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.wrappedKey).toBe(who.wrappedKey);
    const without = await call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } });
    expect(without.status).toBe(429);
    const reused = await post('/v1/login', { email: who.email, authKey: who.authKey, device: device(), emailCode }, MAIL_VARS);
    expect(reused.status).toBe(403);
    expect(reused.body.error).toBe('code_expired');
  });

  it('counts a wrong password with a right code against the code, and not toward the lock', async () => {
    const who = await signup();
    const emailCode = await codeFor(who.email, 'unlock', MAIL_VARS);
    for (let i = 0; i < 5; i++) {
      const res = await post('/v1/login', { email: who.email, authKey: key(), device: device(), emailCode }, MAIL_VARS);
      expect(res.status).toBe(401);
    }
    const spent = await post('/v1/login', { email: who.email, authKey: who.authKey, device: device(), emailCode }, MAIL_VARS);
    expect(spent.body.error).toBe('code_expired');
    // Five wrong passwords with the code left the account's own count alone: nine more still don't lock it.
    for (let i = 0; i < 9; i++) expect((await wrongLogin(who.email)).status).toBe(401);
    expect((await call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } })).status).toBe(200);
  });

  it('refuses a wrong code without touching the account', async () => {
    const who = await lockedAccount();
    const emailCode = await codeFor(who.email, 'unlock', MAIL_VARS);
    const wrong = emailCode.code === '999999' ? '999998' : '999999';
    const res = await post('/v1/login', { email: who.email, authKey: who.authKey, device: device(), emailCode: { ...emailCode, code: wrong } }, MAIL_VARS);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'code_wrong', attemptsLeft: 4 });
    const signupCode = { ...emailCode };
    const asSignup = await signUp({ ...person(who.email), emailCode: signupCode });
    expect(asSignup.body.error).toBe('code_wrong');
    expect((await post('/v1/login', { email: who.email, authKey: who.authKey, device: device(), emailCode }, MAIL_VARS)).status).toBe(200);
  });

  it('lets the owner recover a locked account with an unlock code, which recover/finish uses up', async () => {
    const who = await lockedAccount();
    const emailCode = await codeFor(who.email, 'unlock', MAIL_VARS);
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
    const done = await post('/v1/recover/finish', finish, MAIL_VARS);
    expect(done.status).toBe(200);
    expect((await post('/v1/recover/finish', finish, MAIL_VARS)).body.error).toBe('code_expired');
    // The old session ended with the recovery, as it always does.
    expect((await call('GET', '/v1/account', { token: who.token })).status).toBe(401);
  });

  it('counts a wrong recovery key with a right code against the code', async () => {
    const who = await lockedAccount();
    const emailCode = await codeFor(who.email, 'unlock', MAIL_VARS);
    const res = await post('/v1/recover/start', { email: who.email, recoveryAuth: key(), emailCode }, MAIL_VARS);
    expect(res.status).toBe(401);
    const challenge = toBase64url(await sha256(utf8(emailCode.challenge)));
    const attempts = await registrySql((sql) => sql.exec('SELECT attempts FROM codes WHERE challenge = ?', challenge).one().attempts);
    expect(attempts).toBe(1);
    // The account's own count stays as the lock left it: the right recovery key with the code still works.
    expect((await post('/v1/recover/start', { email: who.email, recoveryAuth: who.recoveryAuth, emailCode }, MAIL_VARS)).status).toBe(200);
  });
});

describe('what the server says about codes', () => {
  it('advertises email codes in GET /v1/info only while it sends them', async () => {
    const info = async (vars) => (await call('GET', '/v1/info', { vars })).body;
    const off = await info({});
    expect(off.features).toEqual(['booking']);
    expect(off.emailCodes).toBeUndefined();
    const invite = await info(MAIL_VARS);
    expect(invite).toMatchObject({
      version: pkg.version,
      signups: 'invite',
      features: ['booking', 'email-codes'],
      emailCodes: { purposes: ['unlock'], digits: 6, expiresIn: 600 }
    });
    const verified = await info(VERIFIED);
    expect(verified.signups).toBe('verified');
    expect(verified.emailCodes).toEqual({ purposes: ['signup', 'unlock'], digits: 6, expiresIn: 600 });
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
        signup: 'Unless you sign up with an invite code or an invitation, we check it',
        unlock: 'lets you sign in or recover your account during the lock',
        kept: 'until a day after the last one',
        none: 'We don’t send mail to it and don’t check it.'
      },
      nl: {
        heading: '<h2 id="email-codes">E-mailcodes</h2>',
        resend: 'Resend, een dienst van Resend, Inc. in de Verenigde Staten',
        signup: 'Tenzij je een account maakt met een uitnodigingscode of een uitnodiging, controleren we het',
        unlock: 'kun je tijdens de blokkade toch inloggen of je account herstellen',
        kept: 'tot een dag na de laatste',
        none: 'We sturen er geen mail naar en controleren het niet.'
      }
    };
    for (const [lang, t] of Object.entries(languages)) {
      const verified = await page(lang, VERIFIED);
      for (const part of [t.heading, t.resend, t.signup, t.unlock, t.kept]) expect(verified, part).toContain(part);
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
