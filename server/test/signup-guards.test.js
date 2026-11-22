// What keeps verified sign-ups and unlock emails within bounds, and the sign-in lock from telling who has an account
// (README.md, "Limits on verified sign-ups"): the limit per domain, accounts that are never used, the operator's
// alert, the budget for unlock emails and their count per mailbox, tries of a code that count before anything is
// compared, and the lock per address. Mail goes to the stand-in in fixtures/fake-resend.js.

import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmac, sha256, toBase64url, utf8 } from '../src/bytes.js';
import { lockObject, registryObject } from '../src/config.js';
import worker from '../src/index.js';
import { lockHash as lockKey } from '../src/lock.js';
import { PUBLIC_PROVIDERS, exemptDomains, registrableDomain } from '../src/signups.js';
import { FakeResend, MAIL_VARS, installFakeResend } from './fixtures/fake-resend.js';
import { host } from './booking-helpers.js';
import { KDF, accountStub, call, device, key, newEmail, push, random, randomIp, recordId, salt, sealed, signup, withVars } from './helpers.js';
import { ON } from './workspace-helpers.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const VERIFIED = { ...MAIL_VARS, SIGNUPS: 'verified' };
const OPS = 'ops@operator.test';

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

// A day of its own for each test that counts per day: ten in the morning (UTC), some days ahead of the last.
let days = 0;
function freshDay() {
  days += 3;
  vi.setSystemTime((Math.floor(Date.now() / DAY) + days) * DAY + 10 * HOUR);
}

let domains = 0;
function newDomain() {
  domains += 1;
  return `d${domains}-${toBase64url(random(4)).toLowerCase().replace(/[^a-z0-9]/g, '')}.test`;
}

// A request through the Worker with these vars, which waits for what it does after answering, such as sending mail.
async function post(path, body, vars = VERIFIED) {
  const ctx = createExecutionContext();
  const request = new Request(`https://accounts.example${path}`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': randomIp(), 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const response = await worker.fetch(request, withVars(vars), ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

function askCode(email, purpose = 'signup', vars = VERIFIED) {
  return post('/v1/email-code', { email, purpose }, vars);
}

async function codeFor(email, purpose = 'signup', vars = VERIFIED) {
  const res = await askCode(email, purpose, vars);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return { challenge: res.body.challenge, code: resend.code(email), token: resend.token(email) };
}

function person(email = newEmail()) {
  return { email, kdf: KDF, salt: salt(), authKey: key(), wrappedKey: sealed(), recoveryAuth: key(), recoveryWrappedKey: sealed(), device: device() };
}

// An account made with an emailed code: the sign-up's answer, with the person.
async function verifiedAccount(email, vars = VERIFIED) {
  const codes = await codeFor(email, 'signup', vars);
  const who = person(email);
  const res = await post('/v1/signup', { ...who, emailCode: { challenge: codes.challenge, code: codes.code } }, vars);
  return { ...res, who };
}

function wrongLogin(email) {
  return call('POST', '/v1/login', { body: { email, authKey: key(), device: device() } });
}

function registrySql(fn, object = registryObject(env)) {
  return runInDurableObject(object, (instance, state) => fn(state.storage.sql));
}

// How long the code with this challenge is kept past its six digits: 0 when no email with its long code goes out.
async function keptPast(challenge) {
  const hash = toBase64url(await sha256(utf8(challenge)));
  return registrySql((sql) => sql.exec('SELECT until - codeUntil AS extra FROM codes WHERE challenge = ?', hash).one().extra);
}

// A name for a mailbox at a provider, different each time.
function boxName() {
  return newEmail().split('@')[0].replace(/[^a-z0-9]/g, '');
}

async function tables(email) {
  return runInDurableObject(await accountStub(email), (instance, state) =>
    state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((r) => r.name)
  );
}

describe('the limit on verified sign-ups per domain', () => {
  it('counts an address under its registrable domain, as mail systems read it', () => {
    expect(registrableDomain('a@example.com')).toBe('example.com');
    expect(registrableDomain('a@mail.eu.example.com')).toBe('example.com');
    expect(registrableDomain('a@example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('a@mx.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('a@shop.example.ne.jp')).toBe('example.ne.jp');
    expect(registrableDomain('a@example.com.')).toBe('example.com');
    expect(registrableDomain('a@googlemail.com')).toBe('gmail.com');
    expect(registrableDomain('a@ｅｘａｍｐｌｅ．ｃｏｍ')).toBe('example.com');
    expect(registrableDomain('a@sub.bücher.de')).toBe('xn--bcher-kva.de');
    // A country domain's own two labels stay two.
    expect(registrableDomain('a@co.uk')).toBe('co.uk');
    // A name that isn't a public suffix is a domain someone owns, so its subdomains count as that one domain.
    expect(registrableDomain('a@a.biz.nl')).toBe('biz.nl');
    expect(registrableDomain('b@b.biz.nl')).toBe('biz.nl');
    // A suffix the list doesn't know pools its registrants in one count.
    expect(registrableDomain('a@school.pvt.k12.ma.us')).toBe('ma.us');
    // Under a country domain, the second labels registries keep for registrations count as public suffixes, so one
    // registrant there can't use up the day for everyone under it.
    expect(registrableDomain('a@shop.co.ae')).toBe('shop.co.ae');
    expect(registrableDomain('b@mail.other.co.ae')).toBe('other.co.ae');
    expect(registrableDomain('a@firm.com.cy')).toBe('firm.com.cy');
    expect(registrableDomain('a@agency.gouv.fr')).toBe('agency.gouv.fr');
    expect(registrableDomain('a@uni.edu.pl')).toBe('uni.edu.pl');
    // One organization's own subdomains still count together.
    expect(registrableDomain('a@tbs-sct.gc.ca')).toBe('gc.ca');
    // A domain that isn't a host name has no registrable domain, so its spellings can't each count apart. A soft
    // hyphen is no such case: host names leave it out, so the address counts as the domain without it.
    expect(registrableDomain('a@exa‌mple.com')).toBeNull();
    expect(registrableDomain('a@exa‍mple.com')).toBeNull();
    expect(registrableDomain('a@[1.2.3.4]')).toBeNull();
    expect(registrableDomain('a@exa­mple.com')).toBe('example.com');
  });

  it('lists every large provider as the registrable domain it counts under', () => {
    for (const provider of PUBLIC_PROVIDERS) expect(registrableDomain(`x@${provider}`), provider).toBe(provider);
    for (const provider of ['outlook.fr', 't-online.de', 'orange.fr', 'libero.it', 'yandex.ru', 'mail.ru', 'qq.com', 'gmx.at', 'laposte.net']) {
      expect(PUBLIC_PROVIDERS.has(provider), provider).toBe(true);
    }
    for (const alias of ['duck.com', 'fastmail.com', 'passmail.net', 'mozmail.com', 'simplelogin.com']) expect(PUBLIC_PROVIDERS.has(alias), alias).toBe(false);
  });

  it('lets a domain make DOMAIN_SIGNUPS_PER_DAY accounts with emailed codes a day, its subdomains included', async () => {
    freshDay();
    const vars = { ...VERIFIED, DOMAIN_SIGNUPS_PER_DAY: '5' };
    const domain = newDomain();
    // A code asked for before the domain made its accounts.
    const early = await codeFor(`c@${domain}`, 'signup', vars);
    for (let i = 0; i < 5; i++) expect((await verifiedAccount(`a${i}@${i % 2 ? 'mail.' : ''}${domain}`, vars)).status).toBe(201);

    // The code from before makes no account today, and stays for tomorrow.
    const refused = await post('/v1/signup', { ...person(`c@${domain}`), emailCode: { challenge: early.challenge, code: early.code } }, vars);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'rate_limited', limit: 'domain' });
    expect(Number(refused.headers.get('retry-after'))).toBe(14 * 60 * 60);

    // Other domains, and the large providers, aren't held back.
    expect((await verifiedAccount(`a@${newDomain()}`, vars)).status).toBe(201);
    for (let i = 0; i < 3; i++) expect((await verifiedAccount(`${boxName()}@gmail.com`, vars)).status).toBe(201);

    // The next day the domain starts again, and the long code from yesterday's email still works.
    later(14 * HOUR + MINUTE);
    expect((await post('/v1/signup', { ...person(`c@${domain}`), emailCode: { token: early.token } }, vars)).status).toBe(201);
  });

  it('answers a code request at a domain that made its accounts as any other request, and sends nothing', async () => {
    freshDay();
    const vars = { ...VERIFIED, DOMAIN_SIGNUPS_PER_DAY: '5' };
    const full = newDomain();
    for (let i = 0; i < 5; i++) expect((await verifiedAccount(`a${i}@${full}`, vars)).status).toBe(201);
    later(MINUTE + 1000);
    const open = newDomain();
    const answers = {};
    for (const domain of [full, open]) {
      const email = `d@${domain}`;
      const first = await askCode(email, 'signup', vars);
      // Asking again within the minute, and six wrong digits for the challenge, answer as anywhere.
      const again = await askCode(email, 'signup', vars);
      const wrong = await post('/v1/signup', { ...person(email), emailCode: { challenge: first.body.challenge, code: '000000' } }, vars);
      answers[domain] = {
        status: first.status,
        keys: Object.keys(first.body).sort(),
        expiresIn: first.body.expiresIn,
        again: [again.status, again.body.error, again.body.limit],
        wrong: [wrong.status, wrong.body.error, wrong.body.attemptsLeft]
      };
      expect(resend.to(email)).toHaveLength(domain === full ? 0 : 1);
      // The code there is kept only for its 10 minutes, as one whose email didn't go.
      expect(await keptPast(first.body.challenge)).toBe(domain === full ? 0 : DAY - 10 * MINUTE);
    }
    expect(answers[full]).toEqual(answers[open]);
    expect(answers[full].status).toBe(202);
    expect(answers[full].again[0]).toBe(429);
    // An address with an account there gets no note either.
    expect((await askCode(`a0@${full}`, 'signup', vars)).status).toBe(202);
    expect(resend.to(`a0@${full}`)).toHaveLength(1);
  });

  it('counts only accounts that were made, so asking for codes uses up no domain', async () => {
    freshDay();
    const vars = { ...VERIFIED, DOMAIN_SIGNUPS_PER_DAY: '5' };
    const domain = newDomain();
    // A stranger asks for codes for many addresses at someone else's domain, and can't read them.
    for (let i = 0; i < 6; i++) expect((await askCode(`x${i}@${domain}`, 'signup', vars)).status).toBe(202);
    // A sign-up that fails after its place was taken, here because the address got an account meanwhile, gives its
    // count back.
    const codes = await codeFor(`taken@${domain}`, 'signup', vars);
    expect((await post('/v1/signup', { ...person(`taken@${domain}`), invite: 'first-code' }, vars)).status).toBe(201);
    const late = await post('/v1/signup', { ...person(`taken@${domain}`), emailCode: { token: codes.token } }, vars);
    expect(late.status).toBe(409);
    for (let i = 0; i < 5; i++) expect((await verifiedAccount(`a${i}@${domain}`, vars)).status).toBe(201);
    expect((await askCode(`c@${domain}`, 'signup', vars)).status).toBe(202);
    expect(resend.to(`c@${domain}`)).toHaveLength(0);
  });

  it('leaves invite codes out of the count, and counts a limit under 5 as 5', async () => {
    freshDay();
    const vars = { ...VERIFIED, DOMAIN_SIGNUPS_PER_DAY: '1' };
    const domain = newDomain();
    for (let i = 0; i < 3; i++) {
      expect((await post('/v1/signup', { ...person(`i${i}@${domain}`), invite: 'first-code' }, vars)).status).toBe(201);
    }
    for (let i = 0; i < 5; i++) expect((await verifiedAccount(`a${i}@${domain}`, vars)).status).toBe(201);
    expect((await askCode(`b@${domain}`, 'signup', vars)).status).toBe(202);
    expect(resend.to(`b@${domain}`)).toHaveLength(0);
    // 0 turns the limit off.
    expect((await verifiedAccount(`c@${domain}`, { ...VERIFIED, DOMAIN_SIGNUPS_PER_DAY: '0' })).status).toBe(201);
  });

  it('leaves the large free providers and the domains in SIGNUP_DOMAINS_EXEMPT out of the count', async () => {
    freshDay();
    const domain = newDomain();
    const vars = { ...VERIFIED, DOMAIN_SIGNUPS_PER_DAY: '5', SIGNUP_DOMAINS_EXEMPT: ` other.test , Mail.${domain.toUpperCase()}.` };
    expect(exemptDomains(vars)).toEqual(new Set(['other.test', domain]));
    // Two mailboxes at a free provider can't use up its day for everyone else there.
    for (let i = 0; i < 6; i++) expect((await verifiedAccount(`${boxName()}@outlook.fr`, vars)).status).toBe(201);
    for (let i = 0; i < 6; i++) expect((await verifiedAccount(`${boxName()}@t-online.de`, vars)).status).toBe(201);
    // An exempt domain counts as its registrable domain, with every subdomain.
    for (let i = 0; i < 6; i++) expect((await verifiedAccount(`a${i}@${i % 2 ? 'x.' : ''}${domain}`, vars)).status).toBe(201);
  });

  it('names a domain that made its accounts for the day in the log, and to the operator once a day', async () => {
    freshDay();
    const vars = { ...VERIFIED, DOMAIN_SIGNUPS_PER_DAY: '5', OPERATOR_EMAIL: OPS, ALERT_SIGNUPS_PER_HOUR: '0', MAX_ACCOUNTS: '0' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const capped = [];
      for (const day of [0, 0, 1]) {
        if (day) later(DAY);
        const domain = newDomain();
        capped.push(domain);
        for (let i = 0; i < 4; i++) expect((await verifiedAccount(`a${i}@${domain}`, vars)).status).toBe(201);
        expect(JSON.stringify(errors.mock.calls)).not.toContain(domain);
        expect((await verifiedAccount(`a4@sub.${domain}`, vars)).status).toBe(201);
        expect(JSON.stringify(errors.mock.calls)).toContain(`at ${domain} reached DOMAIN_SIGNUPS_PER_DAY (5) today`);
      }
      const mails = resend.to(OPS);
      // The first domain of each day goes to the operator; the second of the day is in the log only.
      expect(mails).toHaveLength(2);
      expect(mails[0].text).toContain(`The addresses at ${capped[0]} made 5 accounts`);
      expect(mails[0].text).toContain('SIGNUP_DOMAINS_EXEMPT');
      expect(mails[1].text).toContain(`The addresses at ${capped[2]} made 5 accounts`);
      expect(JSON.stringify(mails)).not.toContain(capped[1]);
      expect(JSON.stringify(mails)).not.toContain(`a4@sub.${capped[0]}`);
    } finally {
      errors.mockRestore();
    }
  });

  it('turns away an address for a new account whose domain isn’t a host name, or that holds invisible characters', async () => {
    const domain = newDomain();
    const codes = await codeFor(`a@${domain}`);
    // Invisible characters, which a host name drops or refuses, and a domain that is no host name at all: each would
    // otherwise count apart from the domain it looks like.
    for (const email of [`a@exa‌mple-${domain}`, `a­@${domain}`, `a@${domain.replace('.', '‍.')}`, `a@ex%zz-${domain}`]) {
      const asked = await askCode(email);
      expect(asked.status, email).toBe(400);
      expect(asked.body.error).toBe('invalid');
      expect((await post('/v1/signup', { ...person(email), emailCode: { token: codes.token } })).status, email).toBe(400);
    }
    // Invite codes don't count domains, but take no invisible characters either.
    expect((await post('/v1/signup', { ...person(`b‌@${domain}`), invite: 'first-code' })).status).toBe(400);
    expect(resend.sent).toHaveLength(1);
  });

  it('keeps only a hash of the domain, for the day', async () => {
    freshDay();
    const vars = { ...VERIFIED, DOMAIN_SIGNUPS_PER_DAY: '5' };
    const domain = newDomain();
    expect((await verifiedAccount(`a@${domain}`, vars)).status).toBe(201);
    const hash = toBase64url(await hmac(env.PEPPER, `signup domain\n${domain}`));
    const rows = await registrySql((sql) => sql.exec('SELECT * FROM signup_domains WHERE domain = ?', hash).toArray());
    expect(rows).toEqual([{ domain: hash, day: Math.floor(Date.now() / DAY), count: 1 }]);
    expect(JSON.stringify(await registrySql((sql) => sql.exec('SELECT * FROM signup_domains').toArray()))).not.toContain(domain);
    later(DAY);
    await runDurableObjectAlarm(registryObject(env));
    expect(await registrySql((sql) => sql.exec('SELECT COUNT(*) AS n FROM signup_domains WHERE domain = ?', hash).one().n)).toBe(0);
  });
});

describe('accounts that are never used', () => {
  const EXPIRE = { EXPIRE_UNUSED_DAYS: '7' };

  // When the account's check is due, and its alarm.
  async function expiry(email) {
    return runInDurableObject(await accountStub(email), async (instance, state) => {
      const sql = state.storage.sql;
      const armed = sql.exec("SELECT name FROM sqlite_master WHERE name = 'expiry'").toArray().length > 0;
      return { at: armed ? sql.exec('SELECT at FROM expiry').one().at : null, alarm: await state.storage.getAlarm() };
    });
  }

  it('arms nothing while EXPIRE_UNUSED_DAYS is unset, as in wrangler.jsonc', async () => {
    const who = await signup();
    expect(await expiry(who.email)).toEqual({ at: null, alarm: null });
  });

  it('deletes an account N days after sign-up when nothing ever used it, and gives its place back', async () => {
    const who = await signup({ vars: EXPIRE });
    const at = await expiry(who.email);
    expect(at.at).toBe(who.account.createdAt + 7 * DAY);
    expect(at.alarm).toBe(at.at);
    // A sign-in on the day it was made doesn't count as use.
    expect((await call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } })).status).toBe(200);

    const stub = await accountStub(who.email);
    later(6 * DAY);
    expect(await stub.expireUnused(7)).toBe('waiting');
    expect(await tables(who.email)).toContain('account');

    later(DAY + MINUTE);
    const before = await registryObject(env).accounts();
    expect(await stub.expireUnused(7)).toBe('deleted');
    expect(await tables(who.email)).toEqual([]);
    expect(await registryObject(env).accounts()).toBe(before - 1);
    expect((await call('GET', '/v1/account', { token: who.token })).status).toBe(401);
    // The address is free for a new account.
    expect((await call('POST', '/v1/signup', { body: { ...person(who.email), invite: 'first-code' } })).status).toBe(201);
  });

  it('keeps an account with records, a booking page, a workspace, or a device that came back after the sign-up day', async () => {
    const withRecords = await signup({ vars: EXPIRE });
    expect((await push(withRecords.token, [{ id: recordId(), data: sealed() }])).status).toBe(200);
    // Records deleted again still count.
    const deleted = await signup({ vars: EXPIRE });
    const id = recordId();
    await push(deleted.token, [{ id, data: sealed() }]);
    await push(deleted.token, [{ id, data: null }]);
    const withPage = (await host(() => signup({ vars: EXPIRE }))).person;
    const inWorkspace = await signup({ vars: EXPIRE });
    const made = await call('POST', '/v1/workspaces', { token: inWorkspace.token, body: { name: 'Acme', displayName: 'Olga' }, vars: ON });
    expect(made.status, made.text).toBe(201);
    // A workspace made and deleted again on the first day leaves no reference, and still counts.
    const formerOwner = await signup({ vars: EXPIRE });
    const gone = await call('POST', '/v1/workspaces', { token: formerOwner.token, body: { name: 'Gone', displayName: 'Olga' }, vars: ON });
    expect(gone.status, gone.text).toBe(201);
    const deletedWs = await call('DELETE', `/v1/workspaces/${gone.body.workspace.id}`, { token: formerOwner.token, vars: ON });
    expect(deletedWs.status, deletedWs.text).toBe(204);
    const signedIn = await signup({ vars: EXPIRE });
    const connected = await signup({ vars: EXPIRE });

    later(DAY + HOUR);
    // A sign-in after the sign-up day, and a session ended again: the account was used.
    const again = await call('POST', '/v1/login', { body: { email: signedIn.email, authKey: signedIn.authKey, device: device() } });
    expect(again.status).toBe(200);
    expect((await call('POST', '/v1/logout', { token: again.body.token })).status).toBe(204);
    expect(await tables(signedIn.email)).not.toContain('expiry');
    // A device that stayed signed in and connects.
    expect((await call('GET', '/v1/account', { token: connected.token })).status).toBe(200);

    later(7 * DAY);
    for (const who of [withRecords, deleted, withPage, inWorkspace, formerOwner, signedIn, connected]) {
      const result = await (await accountStub(who.email)).expireUnused(7);
      expect(['kept', 'none'], who.email).toContain(result);
      expect(await tables(who.email)).toContain('account');
      expect(await tables(who.email)).not.toContain('expiry');
    }
  });

  it('keeps every account when the setting was turned off before the check', async () => {
    const who = await signup({ vars: EXPIRE });
    later(8 * DAY);
    // The objects in the tests run without EXPIRE_UNUSED_DAYS, as a server does once the operator removes it.
    expect(await runDurableObjectAlarm(await accountStub(who.email))).toBe(true);
    expect(await tables(who.email)).toContain('account');
    expect(await tables(who.email)).not.toContain('expiry');
  });

  it('checks again later when the operator raised the number of days', async () => {
    const who = await signup({ vars: EXPIRE });
    later(8 * DAY);
    const stub = await accountStub(who.email);
    expect(await stub.expireUnused(30)).toBe('waiting');
    expect(await expiry(who.email)).toEqual({ at: who.account.createdAt + 30 * DAY, alarm: who.account.createdAt + 30 * DAY });
  });

  it('checks no sooner than two days after sign-up, so no request of the first day is still running', async () => {
    const who = await signup({ vars: { EXPIRE_UNUSED_DAYS: '1' } });
    expect((await expiry(who.email)).at).toBe(who.account.createdAt + 2 * DAY);
    later(DAY + HOUR);
    expect(await (await accountStub(who.email)).expireUnused(1)).toBe('waiting');
    expect((await call('GET', '/privacy', { vars: { EXPIRE_UNUSED_DAYS: '1' } })).text).toContain('deleted 2 days after it was made');
  });

  it('gives an expired account’s place back once, however often its alarm tries', async () => {
    const registry = registryObject(env);
    const before = await registry.accounts();
    const key = toBase64url(random(32));
    await registry.releaseOnce(key);
    await registry.releaseOnce(key);
    expect(await registry.accounts()).toBe(before - 1);
    await registry.reserve(0);
  });

  // What a check leaves when giving the place back failed: the account's tables are gone, and the alarm finishes.
  async function leaveExpired(email, key) {
    await runInDurableObject(await accountStub(email), async (instance, state) => {
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS expired (id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL, released INTEGER NOT NULL)');
      state.storage.sql.exec('INSERT INTO expired (id, key, released) VALUES (1, ?, 0)', key);
      await state.storage.setAlarm(Date.now() + 60 * 1000);
    });
  }

  it('finishes an expiry that failed halfway from its alarm, giving the place back once and never the account', async () => {
    const registry = registryObject(env);
    const email = newEmail();
    const key = toBase64url(random(16));
    const before = await registry.accounts();
    await leaveExpired(email, key);
    expect(await runDurableObjectAlarm(await accountStub(email))).toBe(true);
    expect(await tables(email)).toEqual([]);
    expect(await registry.accounts()).toBe(before - 1);
    // The same key again, as from a retry after the registry answered but before the object noted it: nothing more.
    await leaveExpired(email, key);
    await runDurableObjectAlarm(await accountStub(email));
    expect(await registry.accounts()).toBe(before - 1);
    expect(await tables(email)).toEqual([]);
    await registry.reserve(0);
  });

  it('tries again, waiting longer each time, when the registry can’t take an expired account’s place back', async () => {
    const registry = registryObject(env);
    const email = newEmail();
    const before = await registry.accounts();
    await leaveExpired(email, toBase64url(random(16)));
    const stub = await accountStub(email);
    const unreachable = {
      idFromName: (name) => name,
      get: () => ({ releaseOnce: () => Promise.reject(new Error('The registry is unreachable.')) })
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [attempts, wait] of [
        [1, MINUTE],
        [2, 2 * MINUTE],
        [3, 4 * MINUTE]
      ]) {
        const start = Date.now();
        const state = await runInDurableObject(stub, async (instance, st) => {
          const real = instance.env;
          instance.env = { ...real, REGISTRY: unreachable };
          try {
            await instance.alarm();
          } finally {
            instance.env = real;
          }
          return { alarm: await st.storage.getAlarm(), row: st.storage.sql.exec('SELECT released, attempts FROM expired').one() };
        });
        expect(state.row).toEqual({ released: 0, attempts });
        expect(state.alarm).toBeGreaterThanOrEqual(start + wait);
        expect(state.alarm).toBeLessThanOrEqual(Date.now() + wait);
      }
    } finally {
      errors.mockRestore();
    }
    expect(await registry.accounts()).toBe(before);
    // Once the registry answers, the alarm gives the place back and wipes the rest.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await tables(email)).toEqual([]);
    expect(await registry.accounts()).toBe(before - 1);
    await registry.reserve(0);
  });

  it('keeps what an expired account left when an account made at its address since is deleted', async () => {
    const registry = registryObject(env);
    const who = await signup();
    await leaveExpired(who.email, toBase64url(random(16)));
    const before = await registry.accounts();
    expect((await call('DELETE', '/v1/account', { token: who.token, body: { authKey: who.authKey } })).status).toBe(204);
    // The deleted account's own place is back, and the expired one's waits for the alarm.
    expect(await registry.accounts()).toBe(before - 1);
    expect(await tables(who.email)).toContain('expired');
    expect(await tables(who.email)).not.toContain('account');
    await runDurableObjectAlarm(await accountStub(who.email));
    await runDurableObjectAlarm(await accountStub(who.email));
    expect(await registry.accounts()).toBe(before - 2);
    expect(await tables(who.email)).toEqual([]);
    await registry.reserve(0);
    await registry.reserve(0);
  });

  it('leaves an account made at the address since alone when it finishes', async () => {
    const who = await signup();
    const before = await registryObject(env).accounts();
    await leaveExpired(who.email, toBase64url(random(16)));
    expect(await runDurableObjectAlarm(await accountStub(who.email))).toBe(true);
    expect(await tables(who.email)).toContain('account');
    expect(await tables(who.email)).not.toContain('expired');
    expect((await call('GET', '/v1/account', { token: who.token })).status).toBe(200);
    expect(await registryObject(env).accounts()).toBe(before - 1);
    await registryObject(env).reserve(0);
  });
});

describe('giving back a failed sign-up', () => {
  it('takes the counts back from the day and hour they were counted in, also after midnight', async () => {
    freshDay();
    vi.setSystemTime(Math.floor(Date.now() / DAY) * DAY + DAY - 1000);
    const domain = toBase64url(random(16));
    const verified = { domain, cap: 5 };
    const registry = registryObject(env);
    const count = () => registrySql((sql) => sql.exec('SELECT day, count FROM signup_domains WHERE domain = ?', domain).one());
    const first = await registry.reserve(0, null, 0, false, verified);
    expect(first.result).toBe('ok');
    later(2000);
    expect((await registry.reserve(0, null, 0, false, verified)).result).toBe('ok');
    // The first sign-up fails after midnight: its count was yesterday's, and today's stays.
    await registry.release(null, verified, first.counted);
    expect(await count()).toEqual({ day: first.counted.day + 1, count: 1 });
    await registry.release();
  });
});

describe('the operator alert', () => {
  const VARS = { ...VERIFIED, OPERATOR_EMAIL: OPS, ALERT_SIGNUPS_PER_HOUR: '2', DOMAIN_SIGNUPS_PER_DAY: '0' };

  it('mails OPERATOR_EMAIL once a day when sign-ups with emailed codes reach ALERT_SIGNUPS_PER_HOUR', async () => {
    freshDay();
    const first = await verifiedAccount(newEmail(), VARS);
    expect(first.status).toBe(201);
    expect(resend.to(OPS)).toHaveLength(0);
    // Resend refuses the first alert: the next sign-up tries again.
    const email = newEmail();
    const codes = await codeFor(email, 'signup', VARS);
    resend.failNext({ status: 422, name: 'validation_error' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await post('/v1/signup', { ...person(email), emailCode: { challenge: codes.challenge, code: codes.code } }, VARS)).status).toBe(201);
    } finally {
      errors.mockRestore();
    }
    expect(resend.to(OPS)).toHaveLength(0);
    const third = await verifiedAccount(newEmail(), VARS);
    expect(third.status).toBe(201);
    const [mail] = resend.to(OPS);
    expect(mail.subject).toBe('Rukoo account server on accounts.example: sign-ups need a look');
    expect(mail.text).toContain('3 accounts were made with an emailed code on accounts.example this hour (UTC)');
    for (const address of [first.who.email, email, third.who.email]) expect(JSON.stringify(mail)).not.toContain(address);

    // One a day.
    expect((await verifiedAccount(newEmail(), VARS)).status).toBe(201);
    expect(resend.to(OPS)).toHaveLength(1);
    later(DAY);
    expect((await verifiedAccount(newEmail(), VARS)).status).toBe(201);
    expect((await verifiedAccount(newEmail(), VARS)).status).toBe(201);
    expect(resend.to(OPS)).toHaveLength(2);
  });

  it('mails OPERATOR_EMAIL when the accounts reach 80% of MAX_ACCOUNTS, and nobody without it', async () => {
    freshDay();
    const invite = (vars) => post('/v1/signup', { ...person(), invite: 'first-code' }, { ...MAIL_VARS, ...vars });
    const count = await registryObject(env).accounts();
    expect((await invite({ OPERATOR_EMAIL: OPS, MAX_ACCOUNTS: String((count + 1) * 10) })).status).toBe(201);
    expect((await invite({ MAX_ACCOUNTS: String(count + 2) })).status).toBe(201);
    expect(resend.sent).toHaveLength(0);
    expect((await invite({ OPERATOR_EMAIL: OPS, MAX_ACCOUNTS: String(count + 3) })).status).toBe(201);
    const [mail] = resend.to(OPS);
    expect(mail.text).toContain(`holds ${count + 3} accounts. That is 100% of MAX_ACCOUNTS, ${count + 3}.`);
  });
});

describe('unlock emails', () => {
  async function lockedAccount(options = {}) {
    const who = await signup(options);
    for (let i = 0; i < 10; i++) await wrongLogin(who.email);
    return who;
  }
  const tally = (name) => registrySql((sql) => sql.exec('SELECT slot, count FROM tallies WHERE name = ?', name).toArray()[0] ?? null);
  const setTally = (name, slot, count) =>
    registrySql((sql) =>
      sql.exec(
        'INSERT INTO tallies (name, slot, count) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET slot = excluded.slot, count = excluded.count',
        name,
        slot,
        count
      )
    );

  it("sends an address with no long code left its email when the day's budget is spent, and again once the owner used it", async () => {
    freshDay();
    const vars = { ...MAIL_VARS, UNLOCK_EMAILS_PER_DAY: '5' };
    await setTally('unlock', Math.floor(Date.now() / DAY), 5);
    const who = await lockedAccount();
    const signIn = (token) => post('/v1/login', { email: who.email, authKey: who.authKey, device: device(), emailCode: { token } }, MAIL_VARS);
    expect((await askCode(who.email, 'unlock', vars)).status).toBe(202);
    expect(resend.to(who.email)).toHaveLength(1);
    const token = resend.token(who.email);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The owner still has that code, so the next email counts toward the budget, which is spent.
      later(MINUTE + 1000);
      expect((await askCode(who.email, 'unlock', vars)).status).toBe(202);
      expect(resend.to(who.email)).toHaveLength(1);
      expect(JSON.stringify(errors.mock.calls)).toContain('UNLOCK_EMAILS_PER_DAY');
      // Once the owner used it, the next one goes again, and works.
      expect((await signIn(token)).status).toBe(200);
      later(MINUTE + 1000);
      expect((await askCode(who.email, 'unlock', vars)).status).toBe(202);
      expect(resend.to(who.email)).toHaveLength(2);
      expect((await signIn(resend.token(who.email))).status).toBe(200);
      // Two a day go past the limits like that; someone who reads the mailbox can't use them up and ask again forever.
      later(MINUTE + 1000);
      expect((await askCode(who.email, 'unlock', vars)).status).toBe(202);
      expect(resend.to(who.email)).toHaveLength(2);
    } finally {
      errors.mockRestore();
    }
  });

  it('sends a new code past the budget when the last one has less than an hour left', async () => {
    freshDay();
    const vars = { ...MAIL_VARS, UNLOCK_EMAILS_PER_DAY: '1' };
    await setTally('unlock', Math.floor(Date.now() / DAY), 1);
    const who = await lockedAccount();
    expect((await askCode(who.email, 'unlock', vars)).status).toBe(202);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      later(HOUR);
      await askCode(who.email, 'unlock', vars);
      expect(resend.to(who.email)).toHaveLength(1);
      // The first code runs out within the hour the limits can make its owner wait, so a new one goes.
      later(22 * HOUR + MINUTE);
      await setTally('unlock', Math.floor(Date.now() / DAY), 1);
      expect((await askCode(who.email, 'unlock', vars)).status).toBe(202);
      expect(resend.to(who.email)).toHaveLength(2);
    } finally {
      errors.mockRestore();
    }
  });

  it('sends each account at the tags of one mailbox its own email when the budget is spent', async () => {
    freshDay();
    const vars = { ...MAIL_VARS, UNLOCK_EMAILS_PER_DAY: '1' };
    await setTally('unlock', Math.floor(Date.now() / DAY), 1);
    const name = newEmail().split('@')[0].replace(/[^a-z0-9]/g, '');
    const plain = await lockedAccount({ email: `${name}@example.com` });
    const tagged = await lockedAccount({ email: `${name}+work@example.com` });
    for (const who of [plain, tagged]) {
      expect((await askCode(who.email, 'unlock', vars)).status).toBe(202);
      expect(resend.to(who.email)).toHaveLength(1);
      const res = await post('/v1/login', { email: who.email, authKey: who.authKey, device: device(), emailCode: { token: resend.token(who.email) } }, MAIL_VARS);
      expect(res.status).toBe(200);
    }
  });

  it('counts unlock emails to addresses that still have a code toward UNLOCK_EMAILS_PER_DAY, and gives back one Resend refused', async () => {
    freshDay();
    const vars = { ...MAIL_VARS, UNLOCK_EMAILS_PER_DAY: '2' };
    const a = await signup();
    const b = await signup();
    for (let i = 0; i < 3; i++) {
      expect((await askCode(a.email, 'unlock', vars)).status).toBe(202);
      later(MINUTE + 1000);
    }
    expect(resend.to(a.email)).toHaveLength(3);
    expect((await tally('unlock')).count).toBe(2);
    expect((await askCode(b.email, 'unlock', vars)).status).toBe(202);
    expect(resend.to(b.email)).toHaveLength(1);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      later(MINUTE + 1000);
      await askCode(b.email, 'unlock', vars);
      expect(resend.to(b.email)).toHaveLength(1);
      // A day later the budget starts again; an email Resend refuses doesn't count.
      later(DAY);
      await askCode(b.email, 'unlock', vars);
      later(MINUTE + 1000);
      resend.failNext({ status: 422, name: 'validation_error' });
      await askCode(b.email, 'unlock', vars);
      expect((await tally('unlock')).count).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  it('counts unlock emails per mailbox, so the accounts at its tags share ten a day', async () => {
    freshDay();
    const name = newEmail().split('@')[0].replace(/[^a-z0-9]/g, '');
    const plain = await signup({ email: `${name}@example.com` });
    const tagged = await signup({ email: `${name}+work@example.com` });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const who of [plain, tagged]) {
        for (let i = 0; i < 5; i++) {
          expect((await askCode(who.email, 'unlock', MAIL_VARS)).status).toBe(202);
          later(MINUTE + 1000);
        }
      }
      expect(resend.to(plain.email)).toHaveLength(5);
      expect(resend.to(tagged.email)).toHaveLength(5);
      // Each address's first went past the count, as neither had a code; the other eight counted. Each address may ask
      // again within its own ten a day, but after two more the mailbox had its ten.
      later(HOUR);
      for (let i = 0; i < 2; i++) {
        expect((await askCode(plain.email, 'unlock', MAIL_VARS)).status).toBe(202);
        later(MINUTE + 1000);
      }
      expect(resend.to(plain.email)).toHaveLength(7);
      expect((await askCode(plain.email, 'unlock', MAIL_VARS)).status).toBe(202);
      expect(resend.to(plain.email)).toHaveLength(7);
      expect(JSON.stringify(errors.mock.calls)).toContain('its mailbox had ten today');
      // A day after the first, they go again.
      later(DAY);
      expect((await askCode(plain.email, 'unlock', MAIL_VARS)).status).toBe(202);
      expect(resend.to(plain.email)).toHaveLength(8);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('tries of a code', () => {
  it('counts a try when a code is claimed, so requests that never finish still use up its five', async () => {
    const who = await signup();
    const res = await askCode(who.email, 'unlock', MAIL_VARS);
    expect(res.status).toBe(202);
    const token = resend.token(who.email);
    const entry = {
      token: toBase64url(await sha256(utf8(token))),
      address: toBase64url(await hmac(env.PEPPER, `email-code address\n${who.email}`)),
      purpose: 'unlock'
    };
    const registry = registryObject(env);
    // Five requests whose clients go away after the claim: none of them settles.
    for (let i = 0; i < 5; i++) {
      expect((await registry.claimCode(entry, 5)).result).toBe('ok');
      later(61 * 1000);
    }
    expect((await registry.claimCode(entry, 5)).result).toBe('expired');
    const login = await post('/v1/login', { email: who.email, authKey: who.authKey, device: device(), emailCode: { token } }, MAIL_VARS);
    expect(login.body.error).toBe('code_expired');
  });

  it('leaves a code alone that a newer request holds, when a request that lapsed settles late', async () => {
    const who = await signup();
    expect((await askCode(who.email, 'unlock', MAIL_VARS)).status).toBe(202);
    const entry = {
      token: toBase64url(await sha256(utf8(resend.token(who.email)))),
      address: toBase64url(await hmac(env.PEPPER, `email-code address\n${who.email}`)),
      purpose: 'unlock'
    };
    const registry = registryObject(env);
    for (let i = 0; i < 3; i++) {
      const held = await registry.claimCode(entry, 5);
      await registry.settleCode(held.id, held.claim, 'failed', 5);
    }
    const slow = await registry.claimCode(entry, 5);
    later(61 * 1000);
    // The newer request's try makes five; the late one must not end the code under it.
    const newer = await registry.claimCode(entry, 5);
    expect(newer.result).toBe('ok');
    await registry.settleCode(slow.id, slow.claim, 'failed', 5);
    await registry.settleCode(newer.id, newer.claim, 'keep', 5);
    expect((await registry.claimCode(entry, 5)).result).toBe('ok');
  });
});

describe('the lock on sign-ins', () => {
  const RULES = { max: 10, window: 15 * MINUTE, lockTime: 15 * MINUTE };
  // The hash an address is locked under, and the registry object that keeps its lock.
  async function lockOf(email) {
    const address = await lockKey(env, email);
    return { address, object: lockObject(env, address) };
  }
  const rightLogin = (who) => call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } });

  it('locks an address without an account exactly as one with an account, and stores nothing in its object', async () => {
    const who = await signup();
    const nobody = newEmail();
    const tenth = {};
    for (const email of [who.email, nobody]) {
      for (let i = 0; i < 9; i++) expect((await wrongLogin(email)).status).toBe(401);
      const res = await wrongLogin(email);
      tenth[email] = { status: res.status, body: res.body, retryAfter: res.headers.get('retry-after') };
    }
    expect(tenth[nobody]).toEqual({
      status: 429,
      body: { error: 'locked', message: 'Too many failed attempts. Try again later.' },
      retryAfter: '900'
    });
    expect(tenth[nobody]).toEqual(tenth[who.email]);
    // Recovery shares the lock, for both.
    for (const email of [who.email, nobody]) {
      expect((await call('POST', '/v1/recover/start', { body: { email, recoveryAuth: key() } })).status).toBe(429);
    }
    expect(await tables(nobody)).toEqual([]);
    // The registry keeps a hash, never the address, and lets it go when the lock ends.
    const lock = await lockOf(nobody);
    const rows = await registrySql((sql) => sql.exec('SELECT * FROM locks WHERE address = ?', lock.address).toArray(), lock.object);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(await registrySql((sql) => sql.exec('SELECT * FROM locks').toArray(), lock.object))).not.toContain(nobody);
    later(16 * MINUTE);
    await runDurableObjectAlarm(lock.object);
    expect(await registrySql((sql) => sql.exec('SELECT COUNT(*) AS n FROM locks WHERE address = ?', lock.address).one().n, lock.object)).toBe(0);
    expect((await call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } })).status).toBe(200);
  });

  it('gives attempts sent at once no more than ten tries between them', async () => {
    const who = await signup();
    const burst = await Promise.all(Array.from({ length: 16 }, () => wrongLogin(who.email)));
    expect(burst.filter((res) => res.status === 401).length).toBeLessThanOrEqual(9);
    for (const res of burst.filter((r) => r.status !== 401)) expect(res.body.error).toBe('locked');
    expect((await call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } })).status).toBe(429);
  });

  it('holds attempts that never came back against the ten, and counts them as wrong after a minute', async () => {
    const who = await signup();
    const { address, object } = await lockOf(who.email);
    for (let i = 0; i < 10; i++) expect((await object.lockAttempt(address, RULES)).result).toBe('ok');
    const signIn = () => call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } });
    const running = await signIn();
    expect(running.status).toBe(429);
    expect(Number(running.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    later(61 * 1000);
    const lost = await signIn();
    expect(lost.status).toBe(429);
    // The lock started when they ran out, a minute after they came in, not when someone next asked.
    expect(Number(lost.headers.get('retry-after'))).toBe(15 * 60 - 1);
  });

  it('carries attempts still running over into the next window', async () => {
    const who = await signup();
    const { address, object } = await lockOf(who.email);
    // Nine attempts come in just before the window that the first wrong one started is over.
    expect((await wrongLogin(who.email)).status).toBe(401);
    later(15 * MINUTE - 5000);
    for (let i = 0; i < 9; i++) expect((await object.lockAttempt(address, RULES)).result).toBe('ok');
    later(10 * 1000);
    // A new window starts, and the nine still running hold nine of its ten.
    expect((await wrongLogin(who.email)).status).toBe(401);
    expect((await wrongLogin(who.email)).status).toBe(429);
  });

  it('never lets an owner’s right attempt that is still running help a stranger lock the address', async () => {
    const who = await signup();
    const { address, object } = await lockOf(who.email);
    for (let i = 0; i < 9; i++) expect((await wrongLogin(who.email)).status).toBe(401);
    // The owner's right attempt is let in and still running when the stranger tries a tenth time.
    const owner = await object.lockAttempt(address, RULES);
    expect(owner.result).toBe('ok');
    const tenth = await wrongLogin(who.email);
    expect(tenth.status).toBe(429);
    expect(Number(tenth.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect((await object.lockSettle(address, owner.ticket, true, RULES)).result).toBe('ok');
    // Nothing locked the address, and the right attempt reset the count.
    for (let i = 0; i < 9; i++) expect((await wrongLogin(who.email)).status).toBe(401);
    expect((await rightLogin(who)).status).toBe(200);
  });

  it('counts an attempt that never came back in the window it ran out in, not the one it came in with', async () => {
    const who = await signup();
    const { address, object } = await lockOf(who.email);
    // Nine wrong attempts at minute 0, and one let in at 14:59 that never comes back.
    for (let i = 0; i < 9; i++) expect((await wrongLogin(who.email)).status).toBe(401);
    later(14 * MINUTE + 59 * 1000);
    expect((await object.lockAttempt(address, RULES)).result).toBe('ok');
    // It counts as wrong at 15:59, when the window of the nine was over: it starts a new one, and locks nothing.
    later(61 * 1000);
    expect((await rightLogin(who)).status).toBe(200);
  });

  it('keeps each lock in one of the registry objects its hash picks, and none in the server’s own', async () => {
    const emails = Array.from({ length: 6 }, () => newEmail());
    const objects = new Set();
    for (const email of emails) {
      expect((await wrongLogin(email)).status).toBe(401);
      const lock = await lockOf(email);
      objects.add(lock.address.slice(0, 1));
      expect(await registrySql((sql) => sql.exec('SELECT COUNT(*) AS n FROM locks WHERE address = ?', lock.address).one().n, lock.object)).toBe(1);
      expect(await registrySql((sql) => sql.exec('SELECT COUNT(*) AS n FROM locks WHERE address = ?', lock.address).one().n)).toBe(0);
    }
    // The same hash always picks the same object, and the first character of the hash names it.
    const lock = await lockOf(emails[0]);
    const same = lockObject(env, `${lock.address.slice(0, 1)}${'x'.repeat(42)}`);
    expect(await registrySql((sql) => sql.exec('SELECT COUNT(*) AS n FROM locks WHERE address = ?', lock.address).one().n, same)).toBe(1);
    expect(objects.size).toBeGreaterThan(1);
  });

  it('locks only the address tried, so other spellings of a mailbox keep signing in', async () => {
    const name = newEmail().split('@')[0].replace(/[^a-z0-9]/g, '');
    const owner = await signup({ email: `${name}@gmail.com` });
    for (let i = 0; i < 10; i++) await wrongLogin(`${name}+x@gmail.com`);
    for (let i = 0; i < 10; i++) await wrongLogin(`${name.slice(0, 2)}.${name.slice(2)}@gmail.com`);
    expect((await call('POST', '/v1/login', { body: { email: owner.email, authKey: owner.authKey, device: device() } })).status).toBe(200);
  });

  it('lets the owner past the lock with an unlock code, and keeps it for everyone else', async () => {
    const who = await signup();
    for (let i = 0; i < 10; i++) await wrongLogin(who.email);
    const codes = await codeFor(who.email, 'unlock', MAIL_VARS);
    const res = await post('/v1/login', { email: who.email, authKey: who.authKey, device: device(), emailCode: { challenge: codes.challenge, code: codes.code } }, MAIL_VARS);
    expect(res.status).toBe(200);
    expect((await call('POST', '/v1/login', { body: { email: who.email, authKey: who.authKey, device: device() } })).status).toBe(429);
  });
});

describe('what the privacy statement says', () => {
  it('says accounts that are never used are deleted, in both languages, only while EXPIRE_UNUSED_DAYS is set', async () => {
    const page = async (lang, vars) => (await call('GET', `/privacy?lang=${lang}`, { vars })).text;
    const text = {
      en: { on: 'An account that is never used is deleted 30 days after it was made', off: 'Inactive accounts aren’t deleted on their own;' },
      nl: { on: 'Een account dat nooit wordt gebruikt, verwijderen we 30 dagen nadat het is gemaakt', off: 'Inactieve accounts worden niet vanzelf verwijderd;' }
    };
    for (const [lang, t] of Object.entries(text)) {
      const on = await page(lang, { EXPIRE_UNUSED_DAYS: '30' });
      expect(on).toContain(t.on);
      expect(on).not.toContain(t.off);
      const off = await page(lang, {});
      expect(off).toContain(t.off);
      expect(off).not.toContain(t.on);
    }
  });
});
