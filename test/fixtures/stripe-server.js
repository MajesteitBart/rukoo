'use strict';

// The server's stand-in for Stripe (server/test/fixtures/fake-stripe.js) over HTTP on 127.0.0.1, for tests of the apps
// against the real account server with billing on (test/e2e/chat-billing.spec.js). The account server reaches it
// through STRIPE_API; nothing goes to Stripe.
//
//   const stripe = await startStripe();
//   const server = await startServer({ vars: stripe.vars });
//   const done = stripe.fake.completeCheckout(stripe.fake.lastSession().id);       // the owner paid
//   await stripe.deliver(server, stripe.fake.event('checkout.session.completed', done.session));
//   await stripe.close();
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const SERVER = path.join(__dirname, '..', '..', 'server');
const load = (file) => import(pathToFileURL(path.join(SERVER, file)).href);

async function startStripe() {
  const { FakeStripe, FAKE_STRIPE, stripeVars } = await load('test/fixtures/fake-stripe.js');
  const { signatureHeader } = await load('src/stripe.js');
  let fake = null;
  const listener = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks);
        const request = new Request(`${fake.origin}${req.url}`, {
          method: req.method,
          headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
        });
        const answer = await fake.handle(request);
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(Buffer.from(await answer.arrayBuffer()));
      } catch (err) {
        // The fake's 'network' failure: the connection drops without an answer.
        res.destroy(err);
      }
    });
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${listener.address().port}`;
  fake = new FakeStripe({ ...FAKE_STRIPE, api });
  return {
    fake,
    api,
    vars: stripeVars({ ...FAKE_STRIPE, api }),
    // Sends a Stripe event to server's webhook, signed as Stripe signs it.
    async deliver(server, event) {
      const payload = JSON.stringify(event);
      const res = await fetch(`${server.url}/v1/billing/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': await signatureHeader(payload, FAKE_STRIPE.webhookSecret) },
        body: payload
      });
      if (res.status !== 200) throw new Error(`webhook: ${res.status} ${await res.text()}`);
    },
    close: () => new Promise((resolve) => listener.close(() => resolve()))
  };
}

module.exports = { startStripe };
