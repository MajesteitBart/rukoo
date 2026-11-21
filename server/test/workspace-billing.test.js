// Billing is off as wrangler.jsonc ships it, with team chat on or off: no routes, no word of it in /v1/info or /privacy,
// and /billing stays a booking page's path. test/billing-*.test.js covers it switched on.

import { describe, expect, it } from 'vitest';
import { call } from './helpers.js';
import { ON, api, newWorkspace, workspaceSql } from './workspace-helpers.js';

describe('billing as shipped', () => {
  it('is off, even with team chat on', async () => {
    const ws = await newWorkspace();
    for (const [method, path] of [
      ['GET', `/v1/workspaces/${ws.id}/billing`],
      ['POST', `/v1/workspaces/${ws.id}/billing/checkout`],
      ['POST', `/v1/workspaces/${ws.id}/billing/portal`]
    ]) {
      const res = await api(method, path, { token: ws.person.token, body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await call('POST', '/v1/billing/webhook', { body: '{}', vars: ON })).status).toBe(404);
    const info = await call('GET', '/v1/info', { vars: ON });
    expect(info.body.workspace.capabilities).not.toContain('billing');
    for (const lang of ['en', 'nl']) expect((await call('GET', `/privacy?lang=${lang}`, { vars: ON })).text).not.toContain('Stripe');
    expect((await call('GET', '/billing?checkout=done', { vars: ON })).text).not.toContain('Stripe');
    // A new workspace makes the billing table with the rest, and leaves it empty.
    expect(await workspaceSql(ws.id, 'SELECT * FROM billing')).toEqual([]);
  });

  it('stays off with BILLING on but no Stripe settings', async () => {
    const ws = await newWorkspace();
    const vars = { BILLING: 'on' };
    expect((await api('GET', `/v1/workspaces/${ws.id}/billing`, { token: ws.person.token, vars })).status).toBe(404);
    expect((await call('GET', '/v1/info', { vars: { ...ON, ...vars } })).body.workspace.capabilities).not.toContain('billing');
  });
});
