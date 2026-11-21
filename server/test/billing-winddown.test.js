// Billing wound down (README.md, Billing): BILLING off while Stripe's secrets are still set, in the Worker and in the
// workspace's object alike (vitest.config.js, project winddown). No new Checkout page opens, and everything else keeps
// working for workspaces that still have billing: the webhook, the customer portal, the seats following the members,
// and closing a page left open so the workspace can be deleted. Stripe is test/fixtures/fake-stripe.js.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_STRIPE, billing, billingRow, checkout, deliver, installFakeStripe, portal, settle, stripeFake } from './billing-helpers.js';
import { call } from './helpers.js';
import { ON, api, newMember, newWorkspace, workspaceSql } from './workspace-helpers.js';

let restore;
beforeAll(() => {
  restore = installFakeStripe(stripeFake);
});
afterAll(() => restore());
beforeEach(() => {
  stripeFake.failures = [];
});

const now = () => Math.floor(Date.now() / 1000);
const quantity = (sub) => stripeFake.subscriptions.get(sub.id).items.data[0].quantity;

// What a workspace had made while billing was on: its own customer and a Checkout page, with seats, made by the
// attempt with this ID.
async function openedWhileOn(ws, seats = 1, attempt = 'attemptWhileOn1') {
  const customer = (await stripeFake.route('POST', '/v1/customers', { metadata: { workspace: ws.id } }).json()).id;
  const page = await stripeFake
    .createSession({
      mode: 'subscription',
      customer,
      customer_update: { name: 'auto', address: 'auto' },
      client_reference_id: ws.id,
      line_items: [{ price: FAKE_STRIPE.priceId, quantity: String(seats) }],
      metadata: { workspace: ws.id, attempt },
      subscription_data: { metadata: { workspace: ws.id } },
      success_url: 'https://accounts.example/billing?checkout=done',
      cancel_url: 'https://accounts.example/billing?checkout=cancel'
    })
    .json();
  return { customer, page };
}

// A workspace that set up billing while it was on, and pays for its members.
async function billedWorkspace() {
  const ws = await newWorkspace();
  const { customer, page } = await openedWhileOn(ws);
  const done = stripeFake.completeCheckout(page.id);
  const item = done.subscription.items.data[0];
  await workspaceSql(
    ws.id,
    "INSERT INTO billing (id, live, customer, subscription, item, status, seats, periodEnd, stateAt) VALUES (1, 0, ?, ?, ?, 'active', 1, ?, ?)",
    customer,
    done.subscription.id,
    item.id,
    item.current_period_end * 1000,
    now() - 60
  );
  return { ws, customer, ...done };
}

describe('with BILLING off and Stripe’s secrets still set', () => {
  it('shows an owner the subscription and opens the portal, but opens no Checkout page', async () => {
    const { ws, customer } = await billedWorkspace();
    const shown = await billing(ws.person, ws.id);
    expect(shown.status, shown.text).toBe(200);
    expect(shown.body.billing).toMatchObject({ status: 'active', seats: 1, canCheckout: false, canManage: true });
    const opened = await portal(ws.person, ws.id);
    expect(opened.status, opened.text).toBe(200);
    expect(stripeFake.portals.at(-1)).toMatchObject({ customer, return_url: 'https://accounts.example/billing?portal=done' });
    // Stripe sends the owner back to a page that is still there.
    expect((await call('GET', '/billing?portal=done', { vars: ON })).text).toContain('Changes you made in Stripe');
    const sessions = stripeFake.sessions.size;
    expect((await checkout(ws.person, ws.id)).status).toBe(404);
    // A workspace without billing can't set it up.
    const other = await newWorkspace('Other');
    expect((await billing(other.person, other.id)).body.billing).toMatchObject({ status: 'none', canCheckout: false, canManage: false });
    expect((await checkout(other.person, other.id)).status).toBe(404);
    expect(stripeFake.sessions.size).toBe(sessions);
    // The apps still find billing, and /privacy still names Stripe, which still processes it.
    expect((await call('GET', '/v1/info', { vars: ON })).body.workspace.capabilities).toContain('billing');
    expect((await call('GET', '/privacy', { vars: ON })).text).toContain('<h2 id="billing">Billing</h2>');
  });

  it('takes Stripe’s events and keeps the seats in step with the members', async () => {
    const { ws, subscription } = await billedWorkspace();
    const mila = await newMember(ws, 'Mila');
    expect(await settle(ws.id, () => quantity(subscription) === 2)).toBe(true);
    expect(stripeFake.calls('POST', `/v1/subscription_items/${subscription.items.data[0].id}`).at(-1).params).toEqual({
      quantity: '2',
      proration_behavior: 'create_prorations'
    });
    // The owner cancels in the portal; Stripe says so.
    const kept = stripeFake.subscriptions.get(subscription.id);
    kept.cancel_at_period_end = true;
    const res = await deliver(stripeFake.event('customer.subscription.updated', kept, { created: now() + 5 }));
    expect(res.status, res.text).toBe(200);
    expect(await billingRow(ws.id)).toMatchObject({ cancelAtPeriodEnd: 1 });
    kept.status = 'canceled';
    await deliver(stripeFake.event('customer.subscription.deleted', kept, { created: now() + 6 }));
    // Ended, the workspace can go, and its owner sees no Billing to set up again.
    expect((await billing(ws.person, ws.id)).body.billing).toMatchObject({ status: 'canceled', canCheckout: false });
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token })).status).toBe(204);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
  });

  it('expires a Checkout page left open when billing went off, so the workspace can be deleted', async () => {
    const ws = await newWorkspace();
    const { customer, page } = await openedWhileOn(ws);
    await workspaceSql(ws.id, 'INSERT INTO billing (id, live, customer, checkoutId, checkoutUrl, checkoutSeats) VALUES (1, 0, ?, ?, ?, 1)', customer, page.id, page.url);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(stripeFake.sessions.get(page.id).status).toBe('expired');
  });

  it('expires a page an unanswered attempt left behind, so the workspace can be deleted', async () => {
    const ws = await newWorkspace();
    // The attempt's answer never came, so the workspace knows no page, only that one may be open.
    const { customer, page } = await openedWhileOn(ws);
    await workspaceSql(ws.id, "INSERT INTO billing (id, live, customer, checkoutPending, checkoutAttempt) VALUES (1, 0, ?, 1, 'attemptWhileOn1')", customer);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(stripeFake.sessions.get(page.id).status).toBe('expired');
  });

  it('lets go of a page once it can only have expired, while Stripe can still be asked', async () => {
    const ws = await newWorkspace();
    const { customer, page } = await openedWhileOn(ws);
    await workspaceSql(
      ws.id,
      'INSERT INTO billing (id, live, customer, checkoutId, checkoutUrl, checkoutSeats, checkoutUntil) VALUES (1, 0, ?, ?, ?, 1, ?)',
      customer,
      page.id,
      page.url,
      Date.now() - 1000
    );
    stripeFake.sessions.get(page.id).status = 'expired';
    // Nobody deletes the workspace; the alarm asks Stripe, so the page doesn't outlive the secrets.
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).checkoutId === null)).toBe(true);
    expect(await billingRow(ws.id)).toMatchObject({ checkoutPending: 0, subscription: null });
    // And a page that was paid without its event gives the workspace its subscription.
    const other = await newWorkspace('Other');
    const left = await openedWhileOn(other);
    await workspaceSql(
      other.id,
      'INSERT INTO billing (id, live, customer, checkoutId, checkoutUrl, checkoutSeats, checkoutUntil) VALUES (1, 0, ?, ?, ?, 1, ?)',
      left.customer,
      left.page.id,
      left.page.url,
      Date.now() - 1000
    );
    const done = stripeFake.completeCheckout(left.page.id);
    expect(await settle(other.id, async () => (await billingRow(other.id)).status === 'active')).toBe(true);
    expect(await billingRow(other.id)).toMatchObject({ subscription: done.subscription.id, checkoutId: null });
  });

  it('keeps a workspace whose left-open page was paid, and takes its subscription', async () => {
    const ws = await newWorkspace();
    const { customer, page } = await openedWhileOn(ws);
    await workspaceSql(ws.id, 'INSERT INTO billing (id, live, customer, checkoutId, checkoutUrl, checkoutSeats) VALUES (1, 0, ?, ?, ?, 1)', customer, page.id, page.url);
    const done = stripeFake.completeCheckout(page.id);
    const refused = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('billing_active');
    expect(await billingRow(ws.id)).toMatchObject({ subscription: done.subscription.id, checkoutId: null, checkoutPending: 0 });
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).status === 'active')).toBe(true);
  });
});
