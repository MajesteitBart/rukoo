// Stripe's API in memory, for the billing tests (test/billing-*.test.js) and the app's Electron test of the Billing
// section, which serves it over HTTP (test/fixtures/stripe-server.js in the repository's root). It uses only web APIs,
// so it runs inside the Workers runtime and in Node alike. installFakeStripe() points the runtime's fetch at it for
// requests to its address; the Worker, the Durable Objects and the tests share one isolate, so the server's own
// requests reach it too.
//
// It checks what Stripe checks for the calls the server makes: the secret key, an API version, an idempotency key on
// every POST (a repeat with the same key and body gets the first answer, a 500 included, as Stripe keeps it for a day;
// the same key with another body an idempotency_error), and the parameters each route needs. It answers in the shapes
// of API version 2025-03-31: a subscription's period end on its item. fail() makes the next requests fail, as a Stripe
// that is down.

const enc = new TextEncoder();

// The stand-ins vitest.config.js gives the billing project. None of them is a credential.
export const FAKE_STRIPE = {
  api: 'https://api.stripe-fake.test',
  secretKey: 'sk_test_fake_not_a_real_key_0001',
  webhookSecret: 'whsec_fake_not_a_real_secret_0001',
  priceId: 'price_fakeSeat1950',
  taxRate: 'txr_fakeVat21nl'
};

export function stripeVars(s = FAKE_STRIPE) {
  return {
    BILLING: 'on',
    STRIPE_API: s.api,
    STRIPE_SECRET_KEY: s.secretKey,
    STRIPE_WEBHOOK_SECRET: s.webhookSecret,
    STRIPE_PRICE_ID: s.priceId,
    STRIPE_TAX: s.taxRate
  };
}

const DAY = 24 * 60 * 60;
let counter = 0;
const id = (prefix) => `${prefix}_${(++counter).toString(36).padStart(6, '0')}${Math.random().toString(36).slice(2, 10)}`;

// a[b][0][c]=v into { a: { b: [{ c: 'v' }] } }.
export function parseForm(text) {
  const out = {};
  for (const [name, value] of new URLSearchParams(text)) {
    const keys = name.replace(/\]/g, '').split('[');
    let at = out;
    keys.forEach((key, i) => {
      const last = i === keys.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(keys[i + 1]);
      if (last) at[key] = value;
      else at = at[key] ??= nextIsIndex ? [] : {};
    });
  }
  return out;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status, message, extra = {}) => json(status, { error: { type: 'invalid_request_error', message, ...extra } });

export class FakeStripe {
  constructor(settings = FAKE_STRIPE) {
    this.settings = settings;
    this.origin = new URL(settings.api).origin;
    this.prices = new Map([
      [
        settings.priceId,
        {
          id: settings.priceId,
          object: 'price',
          active: true,
          type: 'recurring',
          billing_scheme: 'per_unit',
          unit_amount: 1950,
          currency: 'eur',
          recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
          tax_behavior: 'inclusive'
        }
      ]
    ]);
    this.reset();
  }

  reset() {
    this.customers = new Map();
    this.sessions = new Map();
    this.subscriptions = new Map();
    this.portals = [];
    // { method, path, params, key } of every request that passed the key check.
    this.log = [];
    this.keys = new Map();
    this.failures = [];
    this.refused = 0;
    this.replayed = 0;
  }

  // The next count requests fail: with status (a number), without an answer ('network'), or with a 500 after the
  // request took effect ('after'), which Stripe says a 500 can mean. match(method, path), when given, picks the
  // requests that fail; the others go through.
  fail(count = 1, how = 500, match = null) {
    for (let i = 0; i < count; i++) this.failures.push({ how, match });
  }

  calls(method, prefix) {
    return this.log.filter((entry) => entry.method === method && entry.path.startsWith(prefix));
  }

  async handle(request) {
    const url = new URL(request.url);
    if (request.headers.get('authorization') !== `Bearer ${this.settings.secretKey}`) {
      this.refused += 1;
      return json(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided.' } });
    }
    if (!request.headers.get('stripe-version')) return refuse(400, 'This fake wants a Stripe-Version.');
    const method = request.method;
    const text = method === 'GET' ? url.search.slice(1) : new TextDecoder().decode(await request.arrayBuffer());
    const params = parseForm(text);
    const key = request.headers.get('idempotency-key');
    if (method === 'POST' && !key) return refuse(400, 'This fake wants an Idempotency-Key on every POST.');
    const seen = method === 'POST' ? this.keys.get(key) : null;
    if (seen) {
      this.replayed += 1;
      if (seen.body !== text) return json(400, { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } });
      return json(seen.status, seen.answer);
    }
    const at = this.failures.findIndex((f) => !f.match || f.match(method, url.pathname));
    const failure = at < 0 ? null : this.failures.splice(at, 1)[0].how;
    if (failure === 'network') throw new TypeError('fetch failed');
    if (failure === 'after') {
      this.log.push({ method, path: url.pathname, params, key });
      this.route(method, url.pathname, params);
      const answer = { error: { type: 'api_error', message: 'Something went wrong on the fake, after the change.' } };
      if (method === 'POST') this.keys.set(key, { body: text, status: 500, answer });
      return json(500, answer);
    }
    if (failure) {
      const answer = { error: { type: 'api_error', message: 'Something went wrong on the fake.' } };
      // Stripe keeps a 500 under its key like any other answer.
      if (method === 'POST' && failure >= 500) this.keys.set(key, { body: text, status: failure, answer });
      return json(failure, answer);
    }
    this.log.push({ method, path: url.pathname, params, key });
    if (method === 'POST') {
      const response = this.route(method, url.pathname, params);
      const answer = await response.clone().json();
      this.keys.set(key, { body: text, status: response.status, answer });
      return response;
    }
    return this.route(method, url.pathname, params);
  }

  route(method, path, params) {
    let m;
    if (method === 'GET' && (m = path.match(/^\/v1\/prices\/([^/]+)$/))) {
      const price = this.prices.get(decodeURIComponent(m[1]));
      return price ? json(200, price) : refuse(404, 'No such price.', { code: 'resource_missing' });
    }
    if (method === 'POST' && path === '/v1/customers') {
      const customer = { id: id('cus'), object: 'customer', metadata: params.metadata ?? {} };
      this.customers.set(customer.id, customer);
      return json(200, customer);
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') return this.createSession(params);
    if (method === 'GET' && path === '/v1/checkout/sessions') {
      const found = [...this.sessions.values()].filter(
        (session) => (!params.customer || session.customer === params.customer) && (!params.status || session.status === params.status)
      );
      return json(200, { object: 'list', data: found.slice(0, Number(params.limit) || 10).map((session) => this.sessionOut(session)), has_more: false });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
      const session = this.sessions.get(decodeURIComponent(m[1]));
      return session ? json(200, this.sessionOut(session)) : refuse(404, 'No such checkout session.', { code: 'resource_missing' });
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) {
      const session = this.sessions.get(decodeURIComponent(m[1]));
      if (!session) return refuse(404, 'No such checkout session.', { code: 'resource_missing' });
      if (session.status !== 'open') return refuse(400, 'Only Checkout Sessions with a status in ["open"] can be expired.');
      session.status = 'expired';
      return json(200, this.sessionOut(session));
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const sub = this.subscriptions.get(decodeURIComponent(m[1]));
      if (!sub) return refuse(404, 'No such subscription.', { code: 'resource_missing' });
      if (params.cancel_at_period_end !== undefined) sub.cancel_at_period_end = params.cancel_at_period_end === 'true';
      return json(200, sub);
    }
    if (method === 'POST' && path === '/v1/billing_portal/sessions') {
      // A customer Checkout made counts as one the account has.
      if (!this.customers.has(params.customer)) return refuse(400, 'No such customer.', { code: 'resource_missing', param: 'customer' });
      if (!/^https?:\/\//.test(params.return_url ?? '')) return refuse(400, 'return_url is required.', { param: 'return_url' });
      const portal = { id: id('bps'), object: 'billing_portal.session', customer: params.customer, return_url: params.return_url, locale: params.locale ?? null };
      portal.url = `https://billing.stripe-fake.test/p/session/${portal.id}`;
      this.portals.push(portal);
      return json(200, portal);
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const sub = this.subscriptions.get(decodeURIComponent(m[1]));
      return sub ? json(200, sub) : refuse(404, 'No such subscription.', { code: 'resource_missing' });
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/subscription_items\/([^/]+)$/))) {
      const itemId = decodeURIComponent(m[1]);
      const sub = [...this.subscriptions.values()].find((s) => s.items.data.some((i) => i.id === itemId));
      if (!sub) return refuse(404, 'No such subscription item.', { code: 'resource_missing' });
      const quantity = Number(params.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1) return refuse(400, 'Invalid quantity.', { param: 'quantity' });
      if (!['create_prorations', 'none', 'always_invoice'].includes(params.proration_behavior)) return refuse(400, 'Invalid proration_behavior.', { param: 'proration_behavior' });
      const item = sub.items.data.find((i) => i.id === itemId);
      item.quantity = quantity;
      return json(200, item);
    }
    return refuse(404, `Unrecognized request URL (${method}: ${path}).`);
  }

  createSession(params) {
    if (params.mode !== 'subscription') return refuse(400, 'This fake takes subscription mode only.', { param: 'mode' });
    if (params.customer !== undefined && !this.customers.has(params.customer)) return refuse(400, 'No such customer.', { code: 'resource_missing', param: 'customer' });
    if (params.customer === undefined && params.customer_update !== undefined) return refuse(400, 'customer_update needs a customer.', { param: 'customer_update' });
    const line = params.line_items?.[0];
    if (!line || !this.prices.has(line.price)) return refuse(400, 'No such price.', { param: 'line_items[0][price]' });
    const quantity = Number(line.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) return refuse(400, 'Invalid quantity.', { param: 'line_items[0][quantity]' });
    for (const field of ['success_url', 'cancel_url']) if (!/^https?:\/\//.test(params[field] ?? '')) return refuse(400, `${field} is required.`, { param: field });
    const expires = Number(params.expires_at);
    const now = Math.floor(Date.now() / 1000);
    if (params.expires_at !== undefined && (!Number.isSafeInteger(expires) || expires < now + 1800 - 5 || expires > now + DAY)) {
      return refuse(400, 'expires_at must be 30 minutes to 24 hours away.', { param: 'expires_at' });
    }
    if (params.tax_id_collection?.enabled === 'true' && params.customer !== undefined && params.customer_update?.name !== 'auto') {
      return refuse(400, 'tax_id_collection needs customer_update[name]=auto with a customer.', { param: 'customer_update' });
    }
    for (const rate of line.tax_rates ?? []) if (!/^txr_/.test(rate)) return refuse(400, 'No such tax rate.', { param: 'line_items[0][tax_rates]' });
    const session = {
      id: id('cs_test'),
      object: 'checkout.session',
      mode: 'subscription',
      status: 'open',
      customer: params.customer ?? null,
      client_reference_id: params.client_reference_id ?? null,
      metadata: params.metadata ?? {},
      expires_at: params.expires_at === undefined ? now + DAY : expires,
      locale: params.locale ?? null,
      params
    };
    session.url = `https://checkout.stripe-fake.test/c/pay/${session.id}`;
    this.sessions.set(session.id, session);
    return json(200, this.sessionOut(session));
  }

  // A session as Stripe answers with it: no url once it isn't open.
  sessionOut(session) {
    return { ...session, params: undefined, url: session.status === 'open' ? session.url : null };
  }

  // The owner paid on the Checkout page: the subscription starts, with the seats the session had. Returns
  // { session, subscription }, the objects Stripe's events carry.
  completeCheckout(sessionId, { status = 'active', periodEnd = Math.floor(Date.now() / 1000) + 30 * DAY } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No such session ${sessionId}`);
    if (session.status !== 'open') throw new Error(`Session ${sessionId} is ${session.status}`);
    // Checkout makes the customer when the owner pays, unless the session named one.
    if (!session.customer) {
      const customer = { id: id('cus'), object: 'customer', metadata: {} };
      this.customers.set(customer.id, customer);
      session.customer = customer.id;
    }
    const line = session.params.line_items[0];
    const subscription = {
      id: id('sub'),
      object: 'subscription',
      customer: session.customer,
      status,
      cancel_at_period_end: false,
      cancel_at: null,
      metadata: session.params.subscription_data?.metadata ?? {},
      items: {
        object: 'list',
        data: [{ id: id('si'), object: 'subscription_item', quantity: Number(line.quantity), price: this.prices.get(line.price), current_period_end: periodEnd }]
      }
    };
    this.subscriptions.set(subscription.id, subscription);
    session.status = 'complete';
    session.subscription = subscription.id;
    session.payment_status = 'paid';
    return { session: this.sessionOut(session), subscription };
  }

  // The newest session made, for tests that don't keep its id.
  lastSession() {
    return [...this.sessions.values()].at(-1) ?? null;
  }

  // An event as Stripe sends it to a webhook. created: seconds; Stripe's time of the change.
  event(type, object, { created = Math.floor(Date.now() / 1000), livemode = false } = {}) {
    return { id: id('evt'), object: 'event', api_version: '2025-03-31.basil', created, livemode, type, data: { object: structuredClone(object) } };
  }

  // An invoice of a subscription, in the 2025-03-31 shape (parent.subscription_details) or the older one (old: true).
  invoice(sub, { old = false } = {}) {
    const details = { subscription: sub.id, metadata: sub.metadata };
    return old
      ? { id: id('in'), object: 'invoice', customer: sub.customer, subscription: sub.id, subscription_details: { metadata: sub.metadata } }
      : { id: id('in'), object: 'invoice', customer: sub.customer, parent: { type: 'subscription_details', subscription_details: details } };
  }
}

export function installFakeStripe(fake) {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(address).origin !== fake.origin) return real(input, init);
    const signal = init?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return fake.handle(new Request(input, init));
  };
  return () => {
    globalThis.fetch = real;
  };
}

export const bytes = (s) => enc.encode(s);
