// The seats Stripe bills follow the members (WORKSPACES.md, Billing): a join raises them at once, prorated, without
// waiting on Stripe; a member who leaves leaves a vacant seat until just before the renewal it belongs to, or after it
// with a credit when Stripe couldn't be reached in time; every try at a seat change reads the subscription first and
// sends a key of its own; a workspace whose last owner goes stops renewing; and a workspace can't be deleted while
// Stripe can still charge it or a Checkout page for it is open.

import { runDurableObjectAlarm } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billing, billingRow, checkout, deliver, installFakeStripe, settle, stripeFake, subscribe } from './billing-helpers.js';
import { call } from './helpers.js';
import { api, bucketKeys, newMember, newWorkspace, post, upload, workspaceSql, workspaceStub } from './workspace-helpers.js';

let restore;
beforeAll(() => {
  restore = installFakeStripe(stripeFake);
});
afterAll(() => restore());
beforeEach(() => {
  stripeFake.failures = [];
});

const HOUR = 60 * 60;
const now = () => Math.floor(Date.now() / 1000);
const seatChanges = (sub) => stripeFake.calls('POST', `/v1/subscription_items/${sub.items.data[0].id}`);
const quantity = (sub) => stripeFake.subscriptions.get(sub.id).items.data[0].quantity;
const leave = (member, ws) => api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: member.person.token });

describe('a member joins', () => {
  it('raises the seats Stripe bills, prorated, and the join doesn’t wait for Stripe', async () => {
    const ws = await newWorkspace();
    await newMember(ws, 'Mila');
    const { subscription } = await subscribe(ws);
    expect(quantity(subscription)).toBe(2);
    // Stripe is down while the third person joins: the join goes through all the same.
    stripeFake.fail(3, 503, (method, path) => path.startsWith('/v1/subscriptions/'));
    await newMember(ws, 'Nora');
    expect((await billing(ws.person, ws.id)).body.billing).toMatchObject({ members: 3, seats: 2, syncing: true });
    expect(await settle(ws.id, () => quantity(subscription) === 3)).toBe(true);
    expect(seatChanges(subscription).at(-1).params).toEqual({ quantity: '3', proration_behavior: 'create_prorations' });
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).syncAt === null)).toBe(true);
    expect((await billing(ws.person, ws.id)).body.billing).toMatchObject({ members: 3, seats: 3, syncing: false });
  });

  it('tries a change Stripe failed again with a new key, after reading the subscription', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    // Stripe fails the first change and keeps that 500 under its key, as it does for a day.
    stripeFake.fail(1, 500, (method, path) => method === 'POST' && path.startsWith('/v1/subscription_items/'));
    const reads = stripeFake.calls('GET', `/v1/subscriptions/${subscription.id}`).length;
    await newMember(ws, 'Mila');
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).tries >= 1 || quantity(subscription) === 2)).toBe(true);
    expect(await settle(ws.id, () => quantity(subscription) === 2)).toBe(true);
    // Each try read the subscription first, and no key was sent twice.
    expect(stripeFake.calls('GET', `/v1/subscriptions/${subscription.id}`).length).toBeGreaterThanOrEqual(reads + 2);
    expect(stripeFake.replayed).toBe(0);
    const keys = seatChanges(subscription).map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('waits longer after each failed try, also when the try read the subscription first', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    stripeFake.fail(2, 500, (method, path) => method === 'POST' && path.startsWith('/v1/subscription_items/'));
    await newMember(ws, 'Mila');
    for (let i = 0; i < 50 && (await billingRow(ws.id)).tries < 1; i++) await runDurableObjectAlarm(workspaceStub(ws.id));
    const once = await billingRow(ws.id);
    expect(once.tries).toBe(1);
    expect(once.syncAt).toBeGreaterThan(Date.now() + 30 * 1000);
    // The alarm comes before its time: nothing is tried.
    const posts = seatChanges(subscription).length;
    await runDurableObjectAlarm(workspaceStub(ws.id));
    expect(seatChanges(subscription).length).toBe(posts);
    expect((await billingRow(ws.id)).tries).toBe(1);
    expect(await settle(ws.id, () => quantity(subscription) === 2)).toBe(true);
  });

  it('keeps no answer about a subscription the workspace no longer has', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    await newMember(ws, 'Mila');
    // While Stripe answers the seat change, the subscription ends and another one takes its place.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const real = stripeFake.handle.bind(stripeFake);
    stripeFake.handle = async (request) => {
      if (request.method === 'POST' && new URL(request.url).pathname.startsWith('/v1/subscription_items/')) await held;
      return real(request);
    };
    try {
      const running = settle(ws.id, () => seatChanges(subscription).length > 0, 20);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // As a paid Checkout page of the workspace's would put it there.
      await workspaceSql(ws.id, "UPDATE billing SET subscription = 'sub_replacement', item = 'si_replacement', status = 'active', seats = 1");
      release();
      await running;
    } finally {
      stripeFake.handle = real;
    }
    const row = await billingRow(ws.id);
    expect(row).toMatchObject({ subscription: 'sub_replacement', item: 'si_replacement', seats: 1 });
  });
});

describe('a member leaves', () => {
  it('leaves a vacant seat that a newcomer takes without a new charge', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const { subscription } = await subscribe(ws);
    const before = seatChanges(subscription).length;
    expect((await leave(mila, ws)).status).toBe(204);
    await settle(ws.id, async () => true, 3);
    expect((await billing(ws.person, ws.id)).body.billing).toMatchObject({ members: 1, seats: 2, syncing: false });
    expect((await billingRow(ws.id)).trimBy).toBe(subscription.items.data[0].current_period_end * 1000);
    await newMember(ws, 'Nora');
    await settle(ws.id, async () => true, 3);
    expect(seatChanges(subscription).length).toBe(before);
    expect(quantity(subscription)).toBe(2);
    expect((await billingRow(ws.id)).trimBy).toBeNull();
  });

  it('drops seats still vacant just before the renewal, without a credit', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const nora = await newMember(ws, 'Nora');
    // The period ends in two hours, so the vacancy is inside the last three.
    const { subscription } = await subscribe(ws, { periodEnd: now() + 2 * HOUR });
    expect(quantity(subscription)).toBe(3);
    await leave(mila, ws);
    await api('DELETE', `/v1/workspaces/${ws.id}/members/${nora.me.id}`, { token: ws.person.token });
    expect(await settle(ws.id, () => quantity(subscription) === 1)).toBe(true);
    expect(seatChanges(subscription).at(-1).params).toEqual({ quantity: '1', proration_behavior: 'none' });
    expect(await billingRow(ws.id)).toMatchObject({ trimBy: null, trimMissed: null });
  });

  it('drops a seat still vacant after its renewal with a credit, and notes the renewal that billed it', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const { subscription } = await subscribe(ws);
    await leave(mila, ws);
    await settle(ws.id, async () => true, 3);
    // The renewal came and went while Stripe couldn't be reached: the vacancy belonged to the period that ended.
    const missed = Date.now() - 60 * 1000;
    await workspaceSql(ws.id, 'UPDATE billing SET trimBy = ?', missed);
    await deliver(stripeFake.event('customer.subscription.updated', stripeFake.subscriptions.get(subscription.id), { created: now() + 1 }));
    expect(await settle(ws.id, () => quantity(subscription) === 1)).toBe(true);
    expect(seatChanges(subscription).at(-1).params).toEqual({ quantity: '1', proration_behavior: 'create_prorations' });
    expect(await billingRow(ws.id)).toMatchObject({ trimBy: null, trimMissed: missed });
  });

  it('notes a late trim also when Stripe made the change but answered with an error', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const { subscription } = await subscribe(ws);
    await leave(mila, ws);
    await settle(ws.id, async () => true, 3);
    const missed = Date.now() - 60 * 1000;
    await workspaceSql(ws.id, 'UPDATE billing SET trimBy = ?', missed);
    stripeFake.fail(1, 'after', (method, path) => method === 'POST' && path.startsWith('/v1/subscription_items/'));
    await deliver(stripeFake.event('customer.subscription.updated', stripeFake.subscriptions.get(subscription.id), { created: now() + 1 }));
    expect(await settle(ws.id, async () => quantity(subscription) === 1 && (await billingRow(ws.id)).syncAt === null)).toBe(true);
    expect(await billingRow(ws.id)).toMatchObject({ seats: 1, trimBy: null, trimMissed: missed });
  });
});

describe('a workspace without owners', () => {
  it('sets its subscription to end with its period when the last owner’s account goes', async () => {
    const ws = await newWorkspace();
    await newMember(ws, 'Mila');
    const { subscription } = await subscribe(ws);
    const gone = await call('DELETE', '/v1/account', { token: ws.person.token, body: { authKey: ws.person.authKey } });
    expect(gone.status, gone.text).toBe(204);
    expect(await settle(ws.id, () => stripeFake.subscriptions.get(subscription.id).cancel_at_period_end === true)).toBe(true);
    expect(stripeFake.calls('POST', `/v1/subscriptions/${subscription.id}`).at(-1).params).toEqual({ cancel_at_period_end: 'true' });
    expect(await settle(ws.id, async () => (await billingRow(ws.id)).cancelAtPeriodEnd === 1)).toBe(true);
    expect((await billingRow(ws.id)).orphaned).toBe(0);
  });
});

describe('a workspace without owners, when Stripe fails', () => {
  it('waits longer after each failed try at ending the subscription', async () => {
    const ws = await newWorkspace();
    await newMember(ws, 'Mila');
    const { subscription } = await subscribe(ws);
    stripeFake.fail(2, 500, (method, path) => method === 'POST' && path === `/v1/subscriptions/${subscription.id}`);
    expect((await call('DELETE', '/v1/account', { token: ws.person.token, body: { authKey: ws.person.authKey } })).status).toBe(204);
    for (let i = 0; i < 50 && (await billingRow(ws.id)).tries < 1; i++) await runDurableObjectAlarm(workspaceStub(ws.id));
    const once = await billingRow(ws.id);
    expect(once).toMatchObject({ tries: 1, orphaned: 1 });
    expect(once.syncAt).toBeGreaterThan(Date.now() + 30 * 1000);
    expect(await settle(ws.id, () => stripeFake.subscriptions.get(subscription.id).cancel_at_period_end === true)).toBe(true);
  });
});

describe('a subscription that starts after the last owner went', () => {
  it('ends with its period too', async () => {
    const ws = await newWorkspace();
    await newMember(ws, 'Mila');
    await checkout(ws.person, ws.id);
    const session = stripeFake.lastSession();
    expect((await call('DELETE', '/v1/account', { token: ws.person.token, body: { authKey: ws.person.authKey } })).status).toBe(204);
    // The page the owner opened is paid afterwards.
    const done = stripeFake.completeCheckout(session.id);
    await deliver(stripeFake.event('checkout.session.completed', done.session));
    expect(await settle(ws.id, () => stripeFake.subscriptions.get(done.subscription.id).cancel_at_period_end === true)).toBe(true);
  });
});

describe('deleting a workspace with billing', () => {
  it('waits until its subscription has ended, also one set to end with its period', async () => {
    const ws = await newWorkspace();
    const { subscription } = await subscribe(ws);
    const kept = stripeFake.subscriptions.get(subscription.id);
    kept.cancel_at_period_end = true;
    await deliver(stripeFake.event('customer.subscription.updated', kept, { created: now() + 2 }));
    const refused = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('billing_active');
    kept.status = 'canceled';
    await deliver(stripeFake.event('customer.subscription.deleted', kept, { created: now() + 3 }));
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    // Stripe's later events about it are taken and go nowhere.
    expect((await deliver(stripeFake.event('invoice.paid', stripeFake.invoice(kept), { created: now() + 4 }))).status).toBe(200);
  });

  it('expires an open Checkout page first, so nobody can start a subscription for a workspace that is gone', async () => {
    const ws = await newWorkspace();
    await checkout(ws.person, ws.id);
    const session = stripeFake.lastSession();
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(session.status).toBe('expired');
    expect(() => stripeFake.completeCheckout(session.id)).toThrow(/expired/);
  });

  it('stays when the open page was paid just before, and takes its subscription', async () => {
    const ws = await newWorkspace();
    await checkout(ws.person, ws.id);
    const done = stripeFake.completeCheckout(stripeFake.lastSession().id);
    const refused = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('billing_active');
    expect((await billingRow(ws.id)).subscription).toBe(done.subscription.id);
  });

  it('refuses while a Checkout page is being made, and makes none while it deletes', async () => {
    const ws = await newWorkspace();
    // Stripe holds the request that makes the page.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const real = stripeFake.handle.bind(stripeFake);
    let making = false;
    stripeFake.handle = async (request) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/v1/checkout/sessions') {
        making = true;
        await held;
      }
      return real(request);
    };
    try {
      const opening = checkout(ws.person, ws.id);
      for (let i = 0; i < 300 && !making; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const refused = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
      expect(refused.status).toBe(409);
      release();
      expect((await opening).status).toBe(200);
    } finally {
      stripeFake.handle = real;
    }
    // While a deletion asks Stripe about the open page, nobody makes another one.
    let listing;
    const listed = new Promise((resolve) => (listing = resolve));
    stripeFake.handle = async (request) => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/v1/checkout/sessions') await listed;
      return real(request);
    };
    try {
      const deleting = api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const sessions = stripeFake.sessions.size;
      expect((await checkout(ws.person, ws.id)).status).toBe(409);
      listing();
      expect((await deleting).status).toBe(204);
      expect(stripeFake.sessions.size).toBe(sessions);
    } finally {
      stripeFake.handle = real;
    }
    expect([...stripeFake.sessions.values()].filter((page) => page.client_reference_id === ws.id && page.status === 'open')).toHaveLength(0);
  });

  it('keeps a live-mode subscription when the server has a test key, and makes no test billing over it', async () => {
    const ws = await newWorkspace();
    await subscribe(ws);
    // As if the subscription had been made with a live key, and the server now has a test one.
    await workspaceSql(ws.id, 'UPDATE billing SET live = 1');
    const refused = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('billing_active');
    const opened = await checkout(ws.person, ws.id);
    expect(opened.status).toBe(409);
    expect(await billingRow(ws.id)).toMatchObject({ live: 1, status: 'active' });
  });

  it('expires a page that a 500 left behind before it deletes', async () => {
    const ws = await newWorkspace();
    stripeFake.fail(1, 'after', (method, path) => method === 'POST' && path === '/v1/checkout/sessions');
    expect((await checkout(ws.person, ws.id)).status).toBe(502);
    const stray = stripeFake.lastSession();
    expect((await billingRow(ws.id)).checkoutPending).toBe(1);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
    expect(stray.status).toBe('expired');
  });

  it('lets go of a paid page whose subscription ended before the page’s event came', async () => {
    const ws = await newWorkspace();
    await checkout(ws.person, ws.id);
    const done = stripeFake.completeCheckout(stripeFake.lastSession().id);
    const sub = stripeFake.subscriptions.get(done.subscription.id);
    sub.status = 'canceled';
    await deliver(stripeFake.event('customer.subscription.deleted', sub, { created: now() + 1 }));
    await deliver(stripeFake.event('checkout.session.completed', done.session));
    expect((await billingRow(ws.id)).checkoutId).toBeNull();
    expect((await checkout(ws.person, ws.id)).status).toBe(200);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(204);
  });

  it('stays, files and all, when Stripe can’t say whether the open page was paid', async () => {
    const ws = await newWorkspace();
    const file = await upload(ws.person, ws.id, ws.general);
    expect((await post(ws.person, ws.id, ws.general, 'See this', { attachments: [file.id] })).status).toBe(201);
    const files = await bucketKeys(ws.id);
    expect(files.length).toBeGreaterThan(0);
    await checkout(ws.person, ws.id);
    stripeFake.fail(3, 503, (method, path) => path.startsWith('/v1/checkout/sessions/'));
    const refused = await api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token });
    expect(refused.status).toBe(502);
    expect(refused.body.error).toBe('billing_unavailable');
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(200);
    expect(await bucketKeys(ws.id)).toEqual(files);
  });
});
