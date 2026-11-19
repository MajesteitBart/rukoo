// Signing up with a workspace invitation in place of an invite code, and the page an invitation link opens
// (WORKSPACES.md, Signing up with an invitation and The join page).

import { describe, expect, it } from 'vitest';
import { KDF, call, device, key, newEmail, salt, sealed } from './helpers.js';
import { ON, api, invite, newMember, newWorkspace, workspaceSql } from './workspace-helpers.js';

// A sign-up that offers an invitation and no invite code, as the apps send it when someone pastes a link.
function signUp(workspaceInvite, vars = {}, extra = {}) {
  const person = {
    email: newEmail(),
    kdf: KDF,
    salt: salt(),
    authKey: key(),
    wrappedKey: sealed(),
    recoveryAuth: key(),
    recoveryWrappedKey: sealed()
  };
  return call('POST', '/v1/signup', { body: { ...person, workspaceInvite, device: device(), ...extra }, vars: { ...ON, ...vars } }).then(
    (res) => ({ ...res, person: { ...person, token: res.body?.token } })
  );
}

function refused(res) {
  expect(res.status, res.text).toBe(403);
  expect(res.body.error).toBe('invite_required');
}

describe('signing up with a workspace invitation', () => {
  it('makes one account per open invitation, a full one', async () => {
    const ws = await newWorkspace();
    const { secret } = await invite(ws.person, ws.id);
    const first = await signUp({ workspace: ws.id, invite: secret });
    expect(first.status, first.text).toBe(201);
    const account = await call('GET', '/v1/account', { token: first.person.token });
    expect(account.body.class).toBe('full');
    // Signing up didn't redeem it; the invitation is still open for the join.
    expect((await workspaceSql(ws.id, 'SELECT redeemedAt FROM invite'))[0].redeemedAt).toBe(null);
    refused(await signUp({ workspace: ws.id, invite: secret }));
  });

  it('lets the new account join with the same invitation', async () => {
    const ws = await newWorkspace('Acme');
    const { secret } = await invite(ws.person, ws.id);
    const made = await signUp({ workspace: ws.id, invite: secret });
    expect(made.status).toBe(201);
    const joined = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: made.person.token, body: { invite: secret, name: 'Nina' } });
    expect(joined.status).toBe(201);
    expect((await api('GET', '/v1/workspaces', { token: made.person.token })).body.workspaces).toEqual([
      { id: ws.id, name: 'Acme', role: 'member' }
    ]);
  });

  it('refuses an invitation that is withdrawn, expired, used or unknown', async () => {
    const ws = await newWorkspace();
    const withdrawn = await invite(ws.person, ws.id);
    await api('DELETE', `/v1/workspaces/${ws.id}/invites/${withdrawn.invite.id}`, { token: ws.person.token });
    refused(await signUp({ workspace: ws.id, invite: withdrawn.secret }));

    const expired = await invite(ws.person, ws.id);
    await workspaceSql(ws.id, 'UPDATE invite SET expiresAt = ? WHERE id = ?', Date.now() - 1, expired.invite.id);
    refused(await signUp({ workspace: ws.id, invite: expired.secret }));

    const used = await invite(ws.person, ws.id);
    const someone = await signUp({ workspace: ws.id, invite: (await invite(ws.person, ws.id)).secret });
    await api('POST', `/v1/workspaces/${ws.id}/join`, { token: someone.person.token, body: { invite: used.secret, name: 'P' } });
    refused(await signUp({ workspace: ws.id, invite: used.secret }));

    refused(await signUp({ workspace: ws.id, invite: 'A'.repeat(43) }));
    refused(await signUp({ workspace: 'w_AAAAAAAAAAAAAAAAAAAAAA', invite: (await invite(ws.person, ws.id)).secret }));
    // An invitation whose issuer can no longer invite is as spent as at the join.
    const admin = await newMember(ws, 'Ada');
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${admin.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
    const theirs = await invite(admin.person, ws.id);
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${admin.me.id}`, { token: ws.person.token, body: { role: 'member' } });
    refused(await signUp({ workspace: ws.id, invite: theirs.secret }));
  });

  it('refuses anything that isn’t an invitation the way it refuses a wrong code', async () => {
    const ws = await newWorkspace();
    const { secret } = await invite(ws.person, ws.id);
    for (const value of [undefined, null, 'link', [], { workspace: ws.id }, { invite: secret }, { workspace: 'acme', invite: secret }, { workspace: ws.id, invite: 'short' }]) {
      refused(await signUp(value));
    }
    // A wrong operator code next to it doesn't spoil the invitation.
    expect((await signUp({ workspace: ws.id, invite: secret }, {}, { invite: 'not-a-code' })).status).toBe(201);
  });

  it('refuses it with team chat off, or with WORKSPACE_SIGNUPS off', async () => {
    const ws = await newWorkspace();
    const { secret } = await invite(ws.person, ws.id);
    refused(await signUp({ workspace: ws.id, invite: secret }, { WORKSPACE_MODE: 'off' }));
    refused(await signUp({ workspace: ws.id, invite: secret }, { WORKSPACE_SIGNUPS: 'off' }));
    // Without the registry nothing would hold the invitation to one account.
    refused(await signUp({ workspace: ws.id, invite: secret }, { REGISTRY: undefined }));
    expect((await api('GET', '/v1/info', { vars: { REGISTRY: undefined } })).body.workspace.inviteSignups).toBe(false);
    // None of them used it up.
    expect((await signUp({ workspace: ws.id, invite: secret })).status).toBe(201);
  });

  it('keeps an operator code working as before, and counts it, not the invitation', async () => {
    const ws = await newWorkspace();
    const { secret } = await invite(ws.person, ws.id);
    const coded = await signUp({ workspace: ws.id, invite: secret }, {}, { invite: 'first-code' });
    expect(coded.status).toBe(201);
    expect((await signUp({ workspace: ws.id, invite: secret })).status).toBe(201);
  });

  it('is ignored with open sign-ups, and closed sign-ups stay closed', async () => {
    const ws = await newWorkspace();
    const { secret } = await invite(ws.person, ws.id);
    expect((await signUp('anything', { SIGNUPS: 'open' })).status).toBe(201);
    expect((await signUp({ workspace: ws.id, invite: secret }, { SIGNUPS: 'open' })).status).toBe(201);
    // The open sign-up didn't count the invitation, so it still makes an account where codes are needed.
    expect((await signUp({ workspace: ws.id, invite: secret })).status).toBe(201);
    const closed = await signUp({ workspace: ws.id, invite: (await invite(ws.person, ws.id)).secret }, { SIGNUPS: 'closed' });
    expect(closed.status).toBe(403);
    expect(closed.body.error).toBe('signups_closed');
  });

  it('gives the place back when the sign-up fails, so the invitation still works', async () => {
    const ws = await newWorkspace();
    const { secret } = await invite(ws.person, ws.id);
    const made = await signUp({ workspace: ws.id, invite: secret });
    expect(made.status).toBe(201);
    // The same address again fails after the registry counted the invitation; the use comes back with the place.
    const other = (await invite(ws.person, ws.id)).secret;
    const again = await call('POST', '/v1/signup', {
      body: { ...made.person, token: undefined, workspaceInvite: { workspace: ws.id, invite: other }, device: device() },
      vars: ON
    });
    expect(again.status).toBe(409);
    expect((await signUp({ workspace: ws.id, invite: other })).status).toBe(201);
  });

  it('is announced in GET /v1/info only where it works', async () => {
    const info = async (vars) => (await api('GET', '/v1/info', { vars })).body.workspace.inviteSignups;
    expect(await info({})).toBe(true);
    expect(await info({ WORKSPACE_SIGNUPS: 'off' })).toBe(false);
    expect(await info({ SIGNUPS: 'open' })).toBe(false);
  });
});

describe('the join page', () => {
  it('explains the invitation in English, with the scriptless policy, no referrer and no indexing', async () => {
    const res = await call('GET', '/join', { vars: { ...ON, OPERATOR_NAME: 'Example <Sync>', OPERATOR_URL: 'https://sync.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.text).toContain('<html lang="en">');
    expect(res.text).toContain('team chat workspace on the Rukoo server at accounts.example');
    expect(res.text).toContain('<a href="https://sync.example">Example &lt;Sync&gt;</a>');
    expect(res.text).toContain('<a href="https://rukoo.io">rukoo.io</a>');
    expect(res.text).toContain('choose Join with an invitation link, and paste the address of this page');
    expect(res.text).toContain('paste the address of this page where it asks for an invite code. Chat then opens the invitation.');
    expect(res.text).toContain('after one day unless the person who invited you chose another time.');
    expect(res.text).not.toMatch(/<script|<form|<img|<iframe|src=/i);
    // No language switch: a link would leave the invitation in the fragment behind.
    expect(res.text).not.toContain('?lang=');
  });

  it('speaks Dutch for a Dutch browser', async () => {
    const res = await call('GET', '/join', { vars: ON, headers: { 'accept-language': 'nl-NL,nl;q=0.9' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.text).toContain('<html lang="nl">');
    expect(res.text).toContain('Uitnodiging voor teamchat in Rukoo');
    expect(res.text).toContain('kies Deelnemen met een uitnodigingslink');
    expect(res.text).toContain('Laat deze pagina dus openstaan, of kopieer dat adres nu.');
    expect(res.text).toContain('na één dag als degene die je uitnodigde niets anders koos.');
    expect((await call('GET', '/join?lang=nl', { vars: ON })).text).toContain('<html lang="nl">');
  });

  it('tells someone without an account what works on this server', async () => {
    const text = async (vars, lang = 'en') => (await call('GET', '/join', { vars: { ...ON, ...vars }, headers: { 'accept-language': lang } })).text;
    expect(await text({ WORKSPACE_SIGNUPS: 'off' })).toContain('only with an invite code from whoever runs it');
    expect(await text({ WORKSPACE_SIGNUPS: 'off' }, 'nl')).toContain('alleen nieuwe accounts met een uitnodigingscode van de beheerder');
    // A closed server makes no accounts at all, with a code or without.
    const closed = await text({ SIGNUPS: 'closed' });
    expect(closed).toContain('this server doesn’t take new accounts. Ask the person who invited you.');
    expect(closed).not.toContain('invite code from whoever runs it');
    expect(await text({ SIGNUPS: 'closed' }, 'nl')).toContain('Deze server neemt geen nieuwe accounts aan.');
    expect(await text({ SIGNUPS: 'open' })).toContain('make an account on this server. Then do step 2.');
  });

  it('answers HEAD without a body, and nothing while team chat is off', async () => {
    const head = await call('HEAD', '/join', { vars: ON });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(head.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await call('GET', '/join', { vars: { WORKSPACE_MODE: 'off' } })).status).toBe(404);
    expect((await call('POST', '/join', { vars: ON, body: {} })).status).toBe(404);
  });

  it('leaves /join to the booking pages while team chat is off', async () => {
    // A former booking root still sends it on to BOOKING_ORIGIN, where a page made under the handle join before the
    // handle was reserved would answer.
    const vars = { WORKSPACE_MODE: 'off', BOOKING_ORIGIN: 'https://meet.example', BOOKING_FORMER_ROOTS: 'https://accounts.example' };
    const moved = await call('GET', '/join', { vars });
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('https://meet.example/join');
    // At BOOKING_ORIGIN's root it is a booking page's path; there is no page join here, so the booking pages say so.
    const atRoot = await call('GET', '/join', { vars: { WORKSPACE_MODE: 'off', BOOKING_ORIGIN: 'https://accounts.example' } });
    expect(atRoot.status).toBe(404);
    expect(atRoot.text).not.toContain('Invitation to team chat');
  });

  it('stays on the account server where booking pages used to live', async () => {
    const vars = { ...ON, BOOKING_ORIGIN: 'https://meet.example', BOOKING_FORMER_ROOTS: 'https://accounts.example' };
    const res = await call('GET', '/join', { vars });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Invitation to team chat in Rukoo');
  });
});
