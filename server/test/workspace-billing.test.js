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

  it('keeps a workspace that still has billing or a Checkout page when Stripe’s secrets are gone', async () => {
    // Nothing can ask Stripe whether the page was paid or the subscription ended, so the workspace stays until the
    // secrets are back (README.md, Billing, turning billing off).
    for (const row of [
      "INSERT INTO billing (id, live, customer, checkoutId, checkoutUrl, checkoutSeats) VALUES (1, 0, 'cus_left1', 'cs_test_left1', 'https://checkout.stripe.com/c/pay/cs_test_left1', 1)",
      "INSERT INTO billing (id, live, customer, checkoutPending) VALUES (1, 0, 'cus_left2', 1)",
      "INSERT INTO billing (id, live, customer, subscription, status) VALUES (1, 1, 'cus_left3', 'sub_left3', 'active')"
    ]) {
      const ws = await newWorkspace();
      await workspaceSql(ws.id, row);
      const refused = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
      expect(refused.status, row).toBe(409);
      expect(refused.body.error).toBe('billing_active');
    }
  });

  it('stays off with BILLING on but no Stripe settings', async () => {
    const ws = await newWorkspace();
    const vars = { BILLING: 'on' };
    expect((await api('GET', `/v1/workspaces/${ws.id}/billing`, { token: ws.person.token, vars })).status).toBe(404);
    expect((await call('GET', '/v1/info', { vars: { ...ON, ...vars } })).body.workspace.capabilities).not.toContain('billing');
  });
});
