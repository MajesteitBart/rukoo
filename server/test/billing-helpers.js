// Shared by the billing tests (test/billing-*.test.js), which run in vitest.config.js's billing project: team chat and
// billing on, and Stripe answered by test/fixtures/fake-stripe.js inside the runtime.

import { runDurableObjectAlarm } from 'cloudflare:test';
import { signatureHeader } from '../src/stripe.js';
import { FAKE_STRIPE, FakeStripe, installFakeStripe } from './fixtures/fake-stripe.js';
import { call } from './helpers.js';
import { ON, api, workspaceSql, workspaceStub } from './workspace-helpers.js';

export const stripeFake = new FakeStripe();
export { FAKE_STRIPE, installFakeStripe };

export function billing(person, id, vars) {
  return api('GET', `/v1/workspaces/${id}/billing`, { token: person.token, vars });
}

export function checkout(person, id, body = { locale: 'en' }, vars) {
  return api('POST', `/v1/workspaces/${id}/billing/checkout`, { token: person.token, body, vars });
}

export function portal(person, id, body = { locale: 'en' }, vars) {
  return api('POST', `/v1/workspaces/${id}/billing/portal`, { token: person.token, body, vars });
}

// Sends a Stripe event to the webhook, signed as Stripe signs it. options: secret, time (seconds), header (instead of
// a signature), raw (the body as it is sent).
export async function deliver(event, { secret = FAKE_STRIPE.webhookSecret, time, header, raw, vars } = {}) {
  const payload = raw ?? JSON.stringify(event);
  const signature = header ?? (await signatureHeader(payload, secret, time));
  return call('POST', '/v1/billing/webhook', { body: payload, headers: { 'stripe-signature': signature }, vars: { ...ON, ...vars } });
}

// The workspace's billing row as it is stored, or undefined.
export async function billingRow(id) {
  return (await workspaceSql(id, 'SELECT * FROM billing'))[0];
}

// Runs the workspace's alarm until check() holds, as the runtime would over time. A retry that waits for later is
// made due first, which stands in for that time passing: the alarm does nothing for billing before its time. The
// runtime may run a due alarm by itself as well; either way check() decides.
export async function settle(id, check, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const now = Date.now();
    await workspaceSql(id, 'UPDATE billing SET syncAt = ? WHERE syncAt > ?', now, now).catch(() => {});
    await runDurableObjectAlarm(workspaceStub(id));
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return Boolean(await check());
}

// An owner's checkout, paid: the session is completed at the fake and its event delivered, and the alarm reads the
// subscription. Returns { session, subscription }.
export async function subscribe(ws, options = {}) {
  const opened = await checkout(ws.person, ws.id);
  if (opened.status !== 200) throw new Error(`Checkout failed: ${opened.status} ${opened.text}`);
  const session = [...stripeFake.sessions.values()].find((s) => s.url === opened.body.url);
  const done = stripeFake.completeCheckout(session.id, options);
  const answer = await deliver(stripeFake.event('checkout.session.completed', done.session));
  if (answer.status !== 200) throw new Error(`Webhook failed: ${answer.status} ${answer.text}`);
  const ok = await settle(ws.id, async () => (await billingRow(ws.id))?.status === (options.status ?? 'active'));
  if (!ok) throw new Error('The subscription never arrived in the workspace.');
  return done;
}
