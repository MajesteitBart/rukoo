// Stripe's webhook (WORKSPACES.md, Billing): only signed, recent events count, each once, an older event never
// overwrites a newer state, and every event reaches the workspace it is about. Stripe is test/fixtures/fake-stripe.js.

import { runDurableObjectAlarm } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_STRIPE, billing, billingRow, checkout, deliver, installFakeStripe, settle, stripeFake, subscribe } from './billing-helpers.js';
import { newMember, newWorkspace, workspaceSql, workspaceStub } from './workspace-helpers.js';

let restore;
beforeAll(() => {
  restore = installFakeStripe(stripeFake);
});
afterAll(() => restore());
beforeEach(() => {
  stripeFake.failures = [];
});

const now = () => Math.floor(Date.now() / 1000);

describe('signatures', () => {
  it('takes a signed event and sets up the workspace’s subscription from it', async () => {
    const ws = await newWorkspace();
    await newMember(ws);
    const opened = await checkout(ws.person, ws.id);
    const session = stripeFake.lastSession();
    expect(session.url).toBe(opened.body.url);
    const done = stripeFake.completeCheckout(session.id);
    const res = await deliver(stripeFake.event('checkout.session.completed', done.session));
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(await billingRow(ws.id)).toMatchObject({ subscription: done.subscription.id, status: 'incomplete', checkoutUrl: null });
    // The alarm reads the subscription from Stripe.
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).status === 'active')).toBe(true);
    const shown = (await billing(ws.person, ws.id)).body.billing;
    expect(shown).toMatchObject({ status: 'active', members: 2, seats: 2, syncing: false, canCheckout: false, canManage: true });
    expect(shown.periodEnd).toBe(done.subscription.items.data[0].current_period_end * 1000);
  });

  it('refuses a wrong secret, a changed body, a missing header and a stale or future time, and changes nothing', async () => {
    const ws = await newWorkspace();
    const sub = { id: 'sub_forged', object: 'subscription', status: 'active', customer: 'cus_x', metadata: { workspace: ws.id }, items: { data: [] } };
    const event = stripeFake.event('customer.subscription.updated', sub);
    const payload = JSON.stringify(event);
    const cases = [
      { secret: 'whsec_someone_else' },
      { raw: payload.replace('active', 'past_due'), header: await (await import('../src/stripe.js')).signatureHeader(payload, FAKE_STRIPE.webhookSecret) },
      { header: '' },
      { header: 'garbage' },
      { time: now() - 6 * 60 },
      { time: now() + 6 * 60 }
    ];
    for (const options of cases) {
      const res = await deliver(event, options);
      expect(res.status, JSON.stringify(options)).toBe(400);
      expect(res.body.error).toBe('invalid_signature');
    }
    expect(await billingRow(ws.id)).toBeUndefined();
    // Within five minutes it counts.
    expect((await deliver(event, { time: now() - 4 * 60 })).status).toBe(200);
    expect(await billingRow(ws.id)).toMatchObject({ subscription: 'sub_forged', status: 'active' });
  });

  it('checks the signature over the body’s exact bytes', async () => {
    const ws = await newWorkspace();
    const sub = { id: 'sub_bom', object: 'subscription', status: 'active', customer: 'cus_x', metadata: { workspace: ws.id }, items: { data: [] } };
    const payload = JSON.stringify(stripeFake.event('customer.subscription.updated', sub));
    const { signatureHeader } = await import('../src/stripe.js');
    // A byte order mark in front changes the bytes, though a decoder would drop it.
    const res = await deliver(null, { raw: `\uFEFF${payload}`, header: await signatureHeader(payload, FAKE_STRIPE.webhookSecret) });
    expect(res.status).toBe(400);
    expect(await billingRow(ws.id)).toBeUndefined();
  });

  it('refuses a body that is too large before reading it', async () => {
    const res = await deliver({}, { raw: 'x'.repeat(600 * 1024), header: 't=1,v1=00' });
    expect(res.status).toBe(413);
  });
});

describe('events', () => {
  it('handles a repeated event once', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    const payment = async () => (await billing(ws.person, ws.id)).body.billing;
    const failed = stripeFake.event('invoice.payment_failed', stripeFake.invoice(subscription), { created: now() - 10 });
    expect((await deliver(failed)).status).toBe(200);
    expect(await payment()).toMatchObject({ payment: 'failed' });
    const paid = stripeFake.event('invoice.paid', stripeFake.invoice(subscription, { old: true }), { created: now() });
    expect((await deliver(paid)).status).toBe(200);
    expect(await payment()).toMatchObject({ payment: 'paid' });
    // Stripe sends the failure again: it was handled, and is answered without a change.
    expect((await deliver(failed)).status).toBe(200);
    expect(await payment()).toMatchObject({ payment: 'paid', paymentAt: paid.created * 1000 });
    expect((await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM billing_event WHERE id = ?', failed.id))[0].n).toBe(1);
  });

  it('never lets an older event overwrite a newer state, and reads the subscription back after each event', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    const late = { ...structuredClone(subscription), status: 'past_due' };
    expect((await deliver(stripeFake.event('customer.subscription.updated', late, { created: now() - 3600 }))).status).toBe(200);
    expect((await billingRow(ws.id)).status).toBe('active');
    // A renewal fails: Stripe's subscription is past due, and so is the event.
    stripeFake.subscriptions.get(subscription.id).status = 'past_due';
    const later = structuredClone(stripeFake.subscriptions.get(subscription.id));
    expect((await deliver(stripeFake.event('customer.subscription.updated', later, { created: now() + 1 }))).status).toBe(200);
    expect((await billingRow(ws.id)).status).toBe('past_due');
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).syncAt === null)).toBe(true);
    expect((await billingRow(ws.id)).status).toBe('past_due');
  });

  it('keeps a newer event over a read of the subscription that Stripe answered late, and reads again', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    // Stripe answers the next read of the subscription with what it was when asked, but only once let go.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let asked = false;
    let answered = false;
    const real = stripeFake.handle.bind(stripeFake);
    stripeFake.handle = async (request) => {
      if (request.method === 'GET' && new URL(request.url).pathname === `/v1/subscriptions/${subscription.id}` && !asked) {
        asked = true;
        const then = await real(request);
        await held;
        answered = true;
        return then;
      }
      return real(request);
    };
    try {
      // An older event, which changes nothing but has the alarm read the subscription back.
      await deliver(stripeFake.event('customer.subscription.updated', stripeFake.subscriptions.get(subscription.id), { created: now() - 30 }));
      const running = runDurableObjectAlarm(workspaceStub(ws.id));
      for (let i = 0; i < 200 && !asked; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(asked).toBe(true);
      // Meanwhile a renewal fails, and its event comes in.
      stripeFake.subscriptions.get(subscription.id).status = 'past_due';
      // In the same second as the read was asked, so the time alone can't tell which is newer.
      await deliver(stripeFake.event('customer.subscription.updated', stripeFake.subscriptions.get(subscription.id), { created: now() }));
      expect((await billingRow(ws.id)).status).toBe('past_due');
      // The read's answer comes seconds after the event, though it was asked before.
      await new Promise((resolve) => setTimeout(resolve, 2200));
      release();
      await running;
      for (let i = 0; i < 200 && !answered; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      stripeFake.handle = real;
    }
    // The late read said active, from before the event; the event's state stays, and the read it asked for still comes.
    expect((await billingRow(ws.id)).status).toBe('past_due');
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).syncAt === null)).toBe(true);
    expect((await billingRow(ws.id)).status).toBe('past_due');
  });

  it('keeps an ended subscription ended, even against an event of the same second that says otherwise', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    const at = now() + 5;
    const active = structuredClone(stripeFake.subscriptions.get(subscription.id));
    stripeFake.subscriptions.get(subscription.id).status = 'canceled';
    const canceled = structuredClone(stripeFake.subscriptions.get(subscription.id));
    await deliver(stripeFake.event('customer.subscription.deleted', canceled, { created: at }));
    await deliver(stripeFake.event('customer.subscription.updated', active, { created: at }));
    expect((await billingRow(ws.id)).status).toBe('canceled');
  });

  it('never lets a subscription that ended come back, also after another one followed it', async () => {
    const ws = await newWorkspace();
    const first = await subscribe(ws);
    const a = stripeFake.subscriptions.get(first.subscription.id);
    const activeA = structuredClone(a);
    a.status = 'canceled';
    await deliver(stripeFake.event('customer.subscription.deleted', a, { created: now() + 1 }));
    const second = await subscribe(ws);
    const b = stripeFake.subscriptions.get(second.subscription.id);
    b.status = 'canceled';
    await deliver(stripeFake.event('customer.subscription.deleted', b, { created: now() + 2 }));
    // An old event about the first one comes late.
    await deliver(stripeFake.event('customer.subscription.updated', activeA, { created: now() + 3 }));
    expect(await billingRow(ws.id)).toMatchObject({ subscription: b.id, status: 'canceled' });
  });

  it('keeps each subscription’s invoices apart', async () => {
    const ws = await newWorkspace();
    const first = await subscribe(ws);
    const a = stripeFake.subscriptions.get(first.subscription.id);
    a.status = 'canceled';
    await deliver(stripeFake.event('customer.subscription.deleted', a, { created: now() + 1 }));
    await checkout(ws.person, ws.id);
    const done = stripeFake.completeCheckout(stripeFake.lastSession().id);
    // The new subscription's first payment fails, and its own events haven't come yet; then a late invoice of the old one.
    await deliver(stripeFake.event('invoice.payment_failed', stripeFake.invoice(done.subscription), { created: now() + 2 }));
    await deliver(stripeFake.event('invoice.paid', stripeFake.invoice(a), { created: now() + 3 }));
    await deliver(stripeFake.event('checkout.session.completed', done.session));
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).subscription === done.subscription.id && (await billingRow(ws.id)).syncAt === null)).toBe(true);
    expect((await billing(ws.person, ws.id)).body.billing.payment).toBe('failed');
  });

  it('keeps an invoice that comes before its subscription’s own events', async () => {
    const ws = await newWorkspace();
    await checkout(ws.person, ws.id);
    const done = stripeFake.completeCheckout(stripeFake.lastSession().id);
    // invoice.paid first, then the session, then nothing else: the payment shows once the subscription is there.
    await deliver(stripeFake.event('invoice.paid', stripeFake.invoice(done.subscription)));
    await deliver(stripeFake.event('checkout.session.completed', done.session));
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).status === 'active')).toBe(true);
    expect((await billing(ws.person, ws.id)).body.billing).toMatchObject({ status: 'active', payment: 'paid' });
  });

  it('records a cancellation at the period’s end and an ended subscription, after which the owner can set billing up again', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    const kept = stripeFake.subscriptions.get(subscription.id);
    kept.cancel_at_period_end = true;
    await deliver(stripeFake.event('customer.subscription.updated', kept, { created: now() + 1 }));
    expect((await billing(ws.person, ws.id)).body.billing).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    kept.status = 'canceled';
    await deliver(stripeFake.event('customer.subscription.deleted', kept, { created: now() + 2 }));
    const shown = (await billing(ws.person, ws.id)).body.billing;
    expect(shown).toMatchObject({ status: 'canceled', seats: null, periodEnd: null, canCheckout: true, canManage: true });
  });

  it('keeps the first subscription when a second one arrives for the same workspace', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    const other = { ...structuredClone(subscription), id: 'sub_secondOne' };
    await deliver(stripeFake.event('customer.subscription.created', other, { created: now() + 5 }));
    await deliver(stripeFake.event('checkout.session.completed', { object: 'checkout.session', mode: 'subscription', subscription: 'sub_secondOne', customer: subscription.customer, metadata: { workspace: ws.id } }));
    expect((await billingRow(ws.id)).subscription).toBe(subscription.id);
  });

  it('takes and ignores events that aren’t for a workspace here, are of the other mode, or of a kind billing doesn’t follow', async () => {
    const ws = await newWorkspace();
    const sub = { id: 'sub_elsewhere', object: 'subscription', status: 'active', customer: 'cus_x', metadata: {}, items: { data: [] } };
    for (const event of [
      stripeFake.event('customer.subscription.updated', sub),
      stripeFake.event('customer.subscription.updated', { ...sub, metadata: { workspace: 'w_BBBBBBBBBBBBBBBBBBBBBB' } }),
      stripeFake.event('customer.subscription.updated', { ...sub, metadata: { workspace: ws.id } }, { livemode: true }),
      stripeFake.event('charge.refunded', { object: 'charge', metadata: { workspace: ws.id } })
    ]) {
      const res = await deliver(event);
      expect(res.status, res.text).toBe(200);
    }
    expect(await billingRow(ws.id)).toBeUndefined();
  });

  it('refuses something signed that isn’t an event', async () => {
    expect((await deliver({ hello: 'world' })).status).toBe(400);
    expect((await deliver(null, { raw: 'not json' })).status).toBe(400);
  });
});
