// Billing team workspaces per member through Stripe (README.md, Billing; WORKSPACES.md, Billing). Off unless the
// operator turns it on (config.js, billingOn). With BILLING off and Stripe's secrets still set, the subscriptions
// workspaces already have keep working and only Checkout is closed (config.js, stripeOn). The workspace's object keeps
// the billing state and talks to Stripe for Checkout, the customer portal and seat changes; this file checks requests,
// adds the price of a seat, takes Stripe's webhook and serves the page Stripe sends people back to.

import { billingOn, stripeLive, stripeOn, webhookSecrets, workspaceObject, workspaceOrigin } from './config.js';
import { html, json, send } from './http.js';
import * as input from './input.js';
import { HttpError } from './input.js';
import { escape, link } from './page.js';
import { seatPrice, verifySignature } from './stripe.js';

const WORKSPACE_ID = /^w_[A-Za-z0-9_-]{22}$/;
const EVENT_ID = /^evt_[A-Za-z0-9]{1,64}$/;
// The events a workspace's billing follows. Stripe sends others too when the endpoint asks for them; they are taken
// and ignored.
const EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed'
]);
// A Stripe event is a few kilobytes; this is far more than any of them.
const WEBHOOK_BYTES = 512 * 1024;
const LOCALES = ['auto', 'en', 'nl'];

const notFound = () => new HttpError(404, 'not_found', 'There is nothing here.');

// The addresses Stripe sends people back to: the server's /billing page on the workspace's address.
function origin(env, url) {
  return workspaceOrigin(env) ?? url.origin;
}

// The language Checkout and the portal speak: the one the app asked for, else Stripe's guess from the browser.
async function locale(request) {
  if (request.body === null) return 'auto';
  const body = await input.readJson(request);
  return LOCALES.includes(body.locale) ? body.locale : 'auto';
}

// GET /v1/workspaces/{id}/billing and POST …/billing/checkout and …/billing/portal. rest: the path after the
// workspace's id. ask(op, args) asks the workspace's object as the caller. Checkout only while billing is on; the rest
// while Stripe's secrets are set, for the workspaces that still have billing.
export async function billingRoute(request, env, url, rest, ask) {
  if (!stripeOn(env)) throw notFound();
  const route = `${request.method} ${rest.join('/')}`;
  if (route === 'GET billing') {
    const result = await ask('billing.get');
    if (result.status !== 200) return send(result);
    // A subscription is shown at the price on its own item, which Stripe goes on charging when STRIPE_PRICE_ID names
    // another; a workspace without one at the price Checkout would sell it.
    const price = result.body.billing.price ?? (await seatPrice(env));
    return json(200, { billing: { ...result.body.billing, price } });
  }
  if (route === 'POST billing/checkout') {
    if (!billingOn(env)) throw notFound();
    return send(await ask('billing.checkout', { origin: origin(env, url), locale: await locale(request) }));
  }
  if (route === 'POST billing/portal') return send(await ask('billing.portal', { origin: origin(env, url), locale: await locale(request) }));
  throw notFound();
}

// The workspace a Stripe event is about, from the metadata the server put on the Checkout session and the
// subscription; an invoice carries its subscription's metadata. null for anything else, such as a payment for
// something that isn't a workspace in the same Stripe account. A session's client_reference_id doesn't count: anyone
// can add one to the address of a Payment Link. The workspace then checks that the event is about the page, customer
// or subscription it has (workspace.js, Billing).
export function eventWorkspace(event) {
  const object = event?.data?.object ?? {};
  const candidates = [object.metadata?.workspace, object.parent?.subscription_details?.metadata?.workspace, object.subscription_details?.metadata?.workspace];
  return candidates.find((id) => typeof id === 'string' && WORKSPACE_ID.test(id)) ?? null;
}

// POST /v1/billing/webhook: Stripe's events. The signature is checked over the body exactly as it came, before
// anything in it is read. Every event Stripe signed gets 200 once the workspace has taken it, or when it isn't for a
// workspace here, so Stripe stops sending it; only a failure on this side answers 500, and Stripe tries again. It
// stays while Stripe's secrets are set, also with BILLING off, so the subscriptions workspaces have keep counting.
export async function stripeWebhook(request, env) {
  if (!stripeOn(env)) throw notFound();
  const raw = await readCapped(request);
  if (!(await verifySignature(raw, request.headers.get('stripe-signature'), webhookSecrets(env)))) {
    throw new HttpError(400, 'invalid_signature', 'This request is not signed by Stripe for this server.');
  }
  let event;
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
  } catch {
    throw new HttpError(400, 'invalid', 'The body is not JSON.');
  }
  if (typeof event?.id !== 'string' || !EVENT_ID.test(event.id) || typeof event.type !== 'string') {
    throw new HttpError(400, 'invalid', 'The body is not a Stripe event.');
  }
  // A test event on a server with a live key, or the other way round, is about objects this server doesn't know.
  if (event.livemode !== stripeLive(env) || !EVENTS.has(event.type)) return json(200, { received: true });
  const workspace = eventWorkspace(event);
  if (!workspace) {
    const object = event.data?.object;
    if (object?.object === 'checkout.session' && typeof object.client_reference_id === 'string' && WORKSPACE_ID.test(object.client_reference_id)) {
      console.error('A Checkout session named a workspace only in client_reference_id, as a Payment Link can; ignored.');
    }
    return json(200, { received: true });
  }
  await workspaceObject(env, workspace).billingEvent({ id: event.id, type: event.type, created: event.created, object: event.data?.object ?? null });
  return json(200, { received: true });
}

async function readCapped(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > WEBHOOK_BYTES) throw new HttpError(413, 'too_large', 'This request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WEBHOOK_BYTES) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'too_large', 'This request is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

// ---- The page Stripe sends people back to ----

const TEXT = {
  en: {
    title: 'Billing for your Rukoo workspace',
    done: 'Thank you. Stripe is setting up the subscription. You can close this tab and go back to Rukoo, where Workspace settings shows the billing status in a moment.',
    cancel: 'Billing wasn’t set up, and nothing was charged. You can close this tab and go back to Rukoo, and set up billing in Workspace settings whenever you’re ready.',
    portal: 'You can close this tab and go back to Rukoo. Changes you made in Stripe show in Workspace settings in a moment.',
    other: 'You can close this tab and go back to Rukoo.',
    runBy: (op) => `This server is run by ${op}.`,
    privacy: 'Privacy statement'
  },
  nl: {
    title: 'Betalen voor je Rukoo-werkruimte',
    done: 'Bedankt. Stripe zet het abonnement klaar. Je kunt dit tabblad sluiten en teruggaan naar Rukoo, waar Instellingen van de werkruimte zo de betaalstatus laat zien.',
    cancel: 'Betalen is niet ingesteld en er is niets afgeschreven. Je kunt dit tabblad sluiten en teruggaan naar Rukoo, en betalen instellen in Instellingen van de werkruimte wanneer je wilt.',
    portal: 'Je kunt dit tabblad sluiten en teruggaan naar Rukoo. Wat je in Stripe veranderde, zie je zo in Instellingen van de werkruimte.',
    other: 'Je kunt dit tabblad sluiten en teruggaan naar Rukoo.',
    runBy: (op) => `Deze server wordt beheerd door ${op}.`,
    privacy: 'Privacyverklaring'
  }
};

// GET /billing: where Checkout and the portal return to (?checkout=done, ?checkout=cancel, ?portal=done). It names
// nothing about the workspace, runs no script and says how to go on.
export function billingPage({ operator }, url, lang = 'en') {
  const T = TEXT[lang] || TEXT.en;
  const checkout = url.searchParams.get('checkout');
  const message = checkout === 'done' ? T.done : checkout === 'cancel' ? T.cancel : url.searchParams.get('portal') === 'done' ? T.portal : T.other;
  const runBy = operator.name ? `<p>${T.runBy(link(operator.url, operator.name))}</p>` : '';
  const footer = operator.privacy ? `<p>${link(operator.privacy, T.privacy)}</p>` : '';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(T.title)}</title>
<style>
body { font: 16px/1.55 system-ui, sans-serif; max-width: 38rem; margin: 2.5rem auto; padding: 0 1.25rem; color: #1f2328; }
h1 { font-size: 1.5rem; } a { color: #0b62c4; }
@media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e8eb; } a { color: #6cb0ff; } }
</style>
</head>
<body>
<h1>${escape(T.title)}</h1>
<p>${escape(message)}</p>
${runBy}
${footer}
</body>
</html>
`;
}

export function billingPageResponse(cfg, url, lang, method) {
  const response = html(billingPage(cfg, url, lang), method);
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-robots-tag', 'noindex');
  return response;
}
