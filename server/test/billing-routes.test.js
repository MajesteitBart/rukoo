// Billing's routes for owners and admins (WORKSPACES.md, Billing): what GET /billing shows, Checkout with one seat per
// member, the customer portal, who may do what, and what /v1/info, /privacy and /billing say while billing is on and
// off. Stripe is test/fixtures/fake-stripe.js.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { forgetPrice } from '../src/stripe.js';
import { FAKE_STRIPE, billing, billingRow, checkout, deliver, installFakeStripe, portal, settle, stripeFake, subscribe } from './billing-helpers.js';
import { call } from './helpers.js';
import { ON, api, guest, invite, newMember, newWorkspace } from './workspace-helpers.js';

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let restore;
beforeAll(() => {
  restore = installFakeStripe(stripeFake);
});
afterAll(() => restore());
beforeEach(() => {
  stripeFake.failures = [];
  forgetPrice();
});

// A workspace of an owner, an admin, a member and a guest, with one open invitation nobody used.
async function team() {
  const ws = await newWorkspace();
  const admin = await newMember(ws, 'Ada Admin');
  await api('PATCH', `/v1/workspaces/${ws.id}/members/${admin.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
  const member = await newMember(ws, 'Mila Member');
  const visitor = await guest(ws, 'Gita Guest', [ws.general]);
  await invite(ws.person, ws.id, { role: 'member' });
  return { ws, admin, member, visitor };
}

describe('GET /billing', () => {
  it('shows an owner the seats, the open invitations and the price from Stripe before billing is set up', async () => {
    const { ws } = await team();
    const res = await billing(ws.person, ws.id);
    expect(res.status, res.text).toBe(200);
    expect(res.body.billing).toEqual({
      status: 'none',
      members: 4,
      pending: 1,
      seats: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      payment: null,
      paymentAt: null,
      syncing: false,
      canCheckout: true,
      canManage: false,
      price: { amount: 1950, currency: 'eur', interval: 'month', taxBehavior: 'inclusive' }
    });
  });

  it('shows an admin the same without the owner’s actions, and refuses members and guests', async () => {
    const { ws, admin, member, visitor } = await team();
    const seen = await billing(admin.person, ws.id);
    expect(seen.status).toBe(200);
    expect(seen.body.billing).toMatchObject({ members: 4, canCheckout: false, canManage: false });
    for (const who of [member, visitor]) {
      const res = await billing(who.person, ws.id);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    }
  });

  it('shows the fallback price when Stripe can’t be asked, and the real one once it can', async () => {
    const ws = await newWorkspace();
    stripeFake.prices.get(FAKE_STRIPE.priceId).unit_amount = 2100;
    stripeFake.fail(3, 'network', (method, path) => path.startsWith('/v1/prices/'));
    expect((await billing(ws.person, ws.id)).body.billing.price).toEqual({ amount: 1950, currency: 'eur', interval: 'month', taxBehavior: 'inclusive' });
    expect((await billing(ws.person, ws.id)).body.billing.price.amount).toBe(2100);
    stripeFake.prices.get(FAKE_STRIPE.priceId).unit_amount = 1950;
  });

  it('shows a subscription at the price it was made with, and a workspace without one at the configured price', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    // The subscription has an older price than STRIPE_PRICE_ID names now, which Stripe keeps charging it.
    const older = { ...structuredClone(stripeFake.prices.get(FAKE_STRIPE.priceId)), id: 'price_olderSeat', unit_amount: 1500, tax_behavior: 'exclusive' };
    const kept = stripeFake.subscriptions.get(subscription.id);
    kept.items.data[0].price = older;
    await deliver(stripeFake.event('customer.subscription.updated', kept, { created: now() + 1 }));
    const charged = { amount: 1500, currency: 'eur', interval: 'month', taxBehavior: 'exclusive' };
    expect((await billing(ws.person, ws.id)).body.billing).toMatchObject({ status: 'active', seats: 1, price: charged });
    // So does the alarm's read of it.
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).syncAt === null)).toBe(true);
    expect((await billing(ws.person, ws.id)).body.billing.price).toEqual(charged);
    // A workspace without billing, and this one once its subscription ended, see what Checkout would charge.
    const configured = { amount: 1950, currency: 'eur', interval: 'month', taxBehavior: 'inclusive' };
    const other = await newWorkspace('Other');
    expect((await billing(other.person, other.id)).body.billing.price).toEqual(configured);
    kept.status = 'canceled';
    await deliver(stripeFake.event('customer.subscription.deleted', kept, { created: now() + 2 }));
    expect((await billing(ws.person, ws.id)).body.billing).toMatchObject({ status: 'canceled', price: configured });
  });

  it('answers 404 for someone outside the workspace', async () => {
    const { ws } = await team();
    const other = await newWorkspace('Other');
    expect((await billing(other.person, ws.id)).status).toBe(404);
  });
});

describe('POST /billing/checkout', () => {
  it('opens Checkout for a subscription with one seat per member, guests included and open invitations not', async () => {
    const { ws } = await team();
    const before = stripeFake.log.length;
    const res = await checkout(ws.person, ws.id, { locale: 'nl' });
    expect(res.status, res.text).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe-fake\.test\/c\/pay\/cs_test_/);
    // The seat price is checked first. The workspace gets a customer of its own, with nothing on it but its ID, and
    // its open pages are looked for before a new one is made.
    const [price, customer, list, session] = stripeFake.log.slice(before);
    expect(price).toMatchObject({ method: 'GET', path: `/v1/prices/${FAKE_STRIPE.priceId}` });
    expect(customer).toMatchObject({ method: 'POST', path: '/v1/customers', params: { metadata: { workspace: ws.id } } });
    expect(Object.keys(customer.params)).toEqual(['metadata']);
    const row = await billingRow(ws.id);
    expect(list).toMatchObject({ method: 'GET', path: '/v1/checkout/sessions', params: { customer: row.customer, status: 'open' } });
    expect(session.path).toBe('/v1/checkout/sessions');
    expect(session.params).toEqual({
      mode: 'subscription',
      customer: row.customer,
      customer_update: { name: 'auto', address: 'auto' },
      client_reference_id: ws.id,
      line_items: [{ price: FAKE_STRIPE.priceId, quantity: '4', tax_rates: [FAKE_STRIPE.taxRate] }],
      metadata: { workspace: ws.id },
      subscription_data: { metadata: { workspace: ws.id } },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: 'true' },
      locale: 'nl',
      success_url: 'https://accounts.example/billing?checkout=done',
      cancel_url: 'https://accounts.example/billing?checkout=cancel'
    });
    expect(session.key).toMatch(/^rukoo-/);
    expect(row).toMatchObject({ checkoutUrl: res.body.url, checkoutSeats: 4 });
  });

  it('hands out the open Checkout page again, also to two clicks at once, so one workspace never pays twice', async () => {
    const { ws } = await team();
    const sessions = stripeFake.sessions.size;
    const [a, b] = await Promise.all([checkout(ws.person, ws.id), checkout(ws.person, ws.id)]);
    expect(a.status).toBe(200);
    expect(b.body.url).toBe(a.body.url);
    expect((await checkout(ws.person, ws.id)).body.url).toBe(a.body.url);
    expect(stripeFake.sessions.size).toBe(sessions + 1);
  });

  it('expires an open page before it makes one for another number of seats, or one about to expire', async () => {
    const ws = await newWorkspace();
    const first = await checkout(ws.person, ws.id);
    const old = stripeFake.lastSession();
    await newMember(ws, 'Mila');
    const second = await checkout(ws.person, ws.id);
    expect(second.body.url).not.toBe(first.body.url);
    expect(old.status).toBe('expired');
    expect(stripeFake.lastSession().params.line_items[0].quantity).toBe('2');
    // Ten minutes from its end, a page isn't handed out again either.
    const almost = stripeFake.lastSession();
    almost.expires_at = Math.floor(Date.now() / 1000) + 5 * 60;
    const third = await checkout(ws.person, ws.id);
    expect(third.body.url).not.toBe(second.body.url);
    expect(almost.status).toBe('expired');
    expect([...stripeFake.sessions.values()].filter((s) => s.client_reference_id === ws.id && s.status === 'open')).toHaveLength(1);
  });

  it('takes the subscription of a page that was paid before its event came, and opens no other', async () => {
    const ws = await newWorkspace();
    await checkout(ws.person, ws.id);
    const done = stripeFake.completeCheckout(stripeFake.lastSession().id);
    const sessions = stripeFake.sessions.size;
    const res = await checkout(ws.person, ws.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('billing_active');
    expect(stripeFake.sessions.size).toBe(sessions);
    expect(await billingRow(ws.id)).toMatchObject({ subscription: done.subscription.id, checkoutId: null });
  });

  it('opens no other page when the open one is paid while Checkout waits on Stripe', async () => {
    const ws = await newWorkspace();
    await checkout(ws.person, ws.id);
    const first = stripeFake.lastSession();
    // Stripe holds the next click's read of the seat price; meanwhile the owner pays the first page and its event comes.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let asked = false;
    const real = stripeFake.handle.bind(stripeFake);
    stripeFake.handle = async (request) => {
      if (!asked && request.method === 'GET' && new URL(request.url).pathname.startsWith('/v1/prices/')) {
        asked = true;
        await held;
      }
      return real(request);
    };
    let again;
    let sessions;
    try {
      const opening = checkout(ws.person, ws.id);
      for (let i = 0; i < 300 && !asked; i++) await sleep(10);
      expect(asked).toBe(true);
      const done = stripeFake.completeCheckout(first.id);
      expect((await deliver(stripeFake.event('checkout.session.completed', done.session))).status).toBe(200);
      sessions = stripeFake.sessions.size;
      release();
      again = await opening;
    } finally {
      stripeFake.handle = real;
    }
    expect(again.status, again.text).toBe(409);
    expect(again.body.error).toBe('billing_active');
    expect(stripeFake.sessions.size).toBe(sessions);
    expect([...stripeFake.sessions.values()].filter((page) => page.client_reference_id === ws.id && page.status === 'open')).toHaveLength(0);
  });

  it('lets only an owner open Checkout', async () => {
    const { ws, admin, member } = await team();
    for (const who of [admin, member]) {
      const res = await checkout(who.person, ws.id);
      expect(res.status).toBe(403);
    }
  });

  it('never sends a key again that Stripe answered with an error', async () => {
    const ws = await newWorkspace();
    stripeFake.fail(1, 500, (method, path) => method === 'POST' && path === '/v1/checkout/sessions');
    const failed = await checkout(ws.person, ws.id);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe('billing_unavailable');
    // Stripe keeps that 500 under its key for a day; the next click asks with a new key.
    const ok = await checkout(ws.person, ws.id);
    expect(ok.status, ok.text).toBe(200);
    expect(stripeFake.replayed).toBe(0);
  });

  it('leaves no second page payable after a 500 that made one all the same', async () => {
    const ws = await newWorkspace();
    stripeFake.fail(1, 'after', (method, path) => method === 'POST' && path === '/v1/checkout/sessions');
    const failed = await checkout(ws.person, ws.id);
    expect(failed.status).toBe(502);
    const stray = stripeFake.lastSession();
    expect(stray.status).toBe('open');
    const ok = await checkout(ws.person, ws.id);
    expect(ok.status, ok.text).toBe(200);
    expect(stray.status).toBe('expired');
    const open = [...stripeFake.sessions.values()].filter((page) => page.client_reference_id === ws.id && page.status === 'open');
    expect(open.map((page) => page.url)).toEqual([ok.body.url]);
  });

  it('waits while the seat price isn’t a monthly price per seat', async () => {
    const ws = await newWorkspace();
    const price = stripeFake.prices.get(FAKE_STRIPE.priceId);
    price.recurring.interval = 'year';
    try {
      const res = await checkout(ws.person, ws.id);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('billing_unavailable');
      expect(stripeFake.calls('POST', '/v1/checkout/sessions').some((c) => c.params.client_reference_id === ws.id)).toBe(false);
    } finally {
      price.recurring.interval = 'month';
    }
  });

  it('refuses a second subscription while one is live', async () => {
    const ws = await newWorkspace();
    await subscribe(ws);
    const res = await checkout(ws.person, ws.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('billing_active');
  });
});

describe('POST /billing/portal', () => {
  it('is for an owner of a workspace with billing, and returns to the server’s /billing page', async () => {
    const ws = await newWorkspace();
    const admin = await newMember(ws, 'Ada Admin');
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${admin.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
    const none = await portal(ws.person, ws.id);
    expect(none.status).toBe(409);
    expect(none.body.error).toBe('billing_none');
    await subscribe(ws);
    const res = await portal(ws.person, ws.id, { locale: 'nl' });
    expect(res.status, res.text).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/billing\.stripe-fake\.test\/p\/session\//);
    expect(stripeFake.portals.at(-1)).toMatchObject({ customer: (await billingRow(ws.id)).customer, return_url: 'https://accounts.example/billing?portal=done', locale: 'nl' });
    expect((await portal(admin.person, ws.id)).status).toBe(403);
    expect((await billing(admin.person, ws.id)).body.billing).toMatchObject({ status: 'active', seats: 2, canManage: false });
    expect((await billing(ws.person, ws.id)).body.billing).toMatchObject({ status: 'active', seats: 2, canManage: true, canCheckout: false });
  });
});

describe('while billing is on', () => {
  it('lists billing in /v1/info', async () => {
    const res = await call('GET', '/v1/info', { vars: ON });
    expect(res.body.workspace.capabilities).toContain('billing');
  });

  it('names Stripe in the privacy statement, in English and Dutch', async () => {
    const en = (await call('GET', '/privacy?lang=en', { vars: ON })).text;
    const nl = (await call('GET', '/privacy?lang=nl', { vars: ON })).text;
    expect(en).toContain('<h2 id="billing">Billing</h2>');
    expect(en).toContain('Paying for a team workspace goes through Stripe (see Billing).');
    expect(en).toContain('This server never receives card or bank details.');
    expect(nl).toContain('<h2 id="billing">Betalen</h2>');
    expect(nl).toContain('Betalen voor een teamwerkruimte gaat via Stripe (zie Betalen).');
  });

  it('serves the page Stripe sends people back to, in English and Dutch', async () => {
    const done = await call('GET', '/billing?checkout=done&lang=en', { vars: ON });
    expect(done.status).toBe(200);
    expect(done.headers.get('content-type')).toContain('text/html');
    expect(done.headers.get('referrer-policy')).toBe('no-referrer');
    expect(done.text).toContain('Stripe is setting up the subscription');
    expect((await call('GET', '/billing?checkout=cancel&lang=nl', { vars: ON })).text).toContain('er is niets afgeschreven');
    expect((await call('GET', '/billing?portal=done', { vars: ON })).text).toContain('Changes you made in Stripe');
  });
});

describe('with billing off', () => {
  const OFF = { BILLING: 'off' };
  const NO_TAX = { STRIPE_TAX: '' };
  const NO_PRICE = { STRIPE_PRICE_ID: '' };
  const NO_SECRET = { STRIPE_WEBHOOK_SECRET: undefined };
  const NO_KEY = { STRIPE_SECRET_KEY: '' };

  it('opens no Checkout page while Stripe’s secrets keep the existing subscriptions running', async () => {
    const ws = await newWorkspace();
    // The rest of a workspace's billing keeps working; test/billing-winddown.test.js runs it with BILLING off throughout.
    for (const vars of [OFF, NO_TAX, NO_PRICE]) {
      expect((await checkout(ws.person, ws.id, {}, vars)).status).toBe(404);
      expect((await portal(ws.person, ws.id, {}, vars)).body.error).toBe('billing_none');
      expect((await call('POST', '/v1/billing/webhook', { body: '{}', vars: { ...ON, ...vars } })).status).toBe(400);
      expect((await call('GET', '/v1/info', { vars: { ...ON, ...vars } })).body.workspace.capabilities).toContain('billing');
      expect((await call('GET', '/privacy', { vars: { ...ON, ...vars } })).text).toContain('Stripe');
      expect((await call('GET', '/billing?checkout=done', { vars: { ...ON, ...vars } })).text).toContain('Stripe is setting up');
    }
  });

  it('answers 404 on every billing route without Stripe’s secrets, says nothing in /v1/info and /privacy, and leaves /billing to booking pages', async () => {
    const ws = await newWorkspace();
    for (const vars of [NO_SECRET, NO_KEY, { ...OFF, ...NO_KEY }]) {
      expect((await billing(ws.person, ws.id, vars)).status).toBe(404);
      expect((await checkout(ws.person, ws.id, {}, vars)).status).toBe(404);
      expect((await portal(ws.person, ws.id, {}, vars)).status).toBe(404);
      expect((await call('POST', '/v1/billing/webhook', { body: '{}', vars: { ...ON, ...vars } })).status).toBe(404);
      expect((await call('GET', '/v1/info', { vars: { ...ON, ...vars } })).body.workspace.capabilities).not.toContain('billing');
      const privacy = (await call('GET', '/privacy', { vars: { ...ON, ...vars } })).text;
      expect(privacy).not.toContain('Stripe');
      expect((await call('GET', '/billing?checkout=done', { vars: { ...ON, ...vars } })).text).not.toContain('Stripe is setting up');
    }
  });
});
