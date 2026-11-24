// The parts of billing that need no workspace: Stripe's form encoding, webhook signatures, the price a seat shows, the
// VAT setting and which workspace an event is about.

import { describe, expect, it } from 'vitest';
import { eventWorkspace } from '../src/billing.js';
import { billingTax, stripeLive } from '../src/config.js';
import { FALLBACK_PRICE, TOLERANCE, formBody, priceOut, signatureHeader, verifySignature } from '../src/stripe.js';
import { parseForm } from './fixtures/fake-stripe.js';

const SECRET = 'whsec_unit_test_secret';
const W = 'w_AAAAAAAAAAAAAAAAAAAAAA';

describe('formBody', () => {
  it('writes nested objects and lists the way Stripe reads them, and leaves out what is null', () => {
    const body = formBody({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 3, tax_rates: ['txr_1'] }],
      metadata: { workspace: W },
      tax_id_collection: { enabled: true },
      automatic_tax: undefined,
      locale: null
    }).toString();
    expect(decodeURIComponent(body)).toBe(
      `mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=3&line_items[0][tax_rates][0]=txr_1&metadata[workspace]=${W}&tax_id_collection[enabled]=true`
    );
    expect(parseForm(body)).toEqual({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: '3', tax_rates: ['txr_1'] }], metadata: { workspace: W }, tax_id_collection: { enabled: 'true' } });
  });
});

describe('verifySignature', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const now = Date.now();
  const t = Math.floor(now / 1000);

  it('takes a signature Stripe would make, with either of two secrets while one is rolled', async () => {
    const header = await signatureHeader(payload, SECRET, t);
    expect(await verifySignature(payload, header, [SECRET], now)).toBe(true);
    expect(await verifySignature(payload, header, ['whsec_new', SECRET], now)).toBe(true);
    // Stripe lists a v1 for each secret while one is rolled, and a v0 nobody checks.
    const both = `${header},v1=${'0'.repeat(64)},v0=${'f'.repeat(64)}`;
    expect(await verifySignature(payload, both, [SECRET], now)).toBe(true);
  });

  it('refuses another secret, a changed body, a missing or broken header, and an empty list of secrets', async () => {
    const header = await signatureHeader(payload, SECRET, t);
    expect(await verifySignature(payload, header, ['whsec_other'], now)).toBe(false);
    expect(await verifySignature(payload.replace('paid', 'payment_failed'), header, [SECRET], now)).toBe(false);
    expect(await verifySignature(`${payload} `, header, [SECRET], now)).toBe(false);
    for (const bad of [null, '', 't=', `t=${t}`, `v1=${'a'.repeat(64)}`, `t=abc,v1=${'a'.repeat(64)}`, header.replace('v1=', 'v2='), header.slice(0, -2)]) {
      expect(await verifySignature(payload, bad, [SECRET], now)).toBe(false);
    }
    expect(await verifySignature(payload, header, [], now)).toBe(false);
  });

  it('signs the body’s bytes as they came: a byte order mark or another byte breaks it', async () => {
    const header = await signatureHeader(payload, SECRET, t);
    const bytes = new TextEncoder().encode(payload);
    expect(await verifySignature(bytes, header, [SECRET], now)).toBe(true);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
    expect(await verifySignature(bom, header, [SECRET], now)).toBe(false);
    const changed = bytes.slice();
    changed[changed.length - 2] ^= 1;
    expect(await verifySignature(changed, header, [SECRET], now)).toBe(false);
  });

  it('refuses a signature older or newer than five minutes', async () => {
    expect(await verifySignature(payload, await signatureHeader(payload, SECRET, t - TOLERANCE + 5), [SECRET], now)).toBe(true);
    expect(await verifySignature(payload, await signatureHeader(payload, SECRET, t - TOLERANCE - 5), [SECRET], now)).toBe(false);
    expect(await verifySignature(payload, await signatureHeader(payload, SECRET, t + TOLERANCE + 5), [SECRET], now)).toBe(false);
  });
});

describe('the price of a seat', () => {
  it('reads a plain recurring price per unit, and nothing else', () => {
    expect(priceOut({ unit_amount: 1950, currency: 'EUR', recurring: { interval: 'month' }, tax_behavior: 'inclusive' })).toEqual(FALLBACK_PRICE);
    expect(priceOut({ unit_amount: 1612, currency: 'eur', recurring: { interval: 'month' }, tax_behavior: 'exclusive' }).taxBehavior).toBe('exclusive');
    expect(priceOut({ unit_amount: 1950, currency: 'eur', recurring: { interval: 'month' } }).taxBehavior).toBe('unspecified');
    expect(priceOut({ unit_amount: null, currency: 'eur', recurring: { interval: 'month' } })).toBeNull();
    expect(priceOut({ unit_amount: 1950, currency: 'eur', recurring: null })).toBeNull();
  });
});

describe('settings', () => {
  it('reads STRIPE_TAX as a tax rate, Stripe Tax or none on purpose, and anything else as not chosen', () => {
    expect(billingTax({ STRIPE_TAX: 'txr_1AbC' })).toEqual({ rate: 'txr_1AbC' });
    expect(billingTax({ STRIPE_TAX: 'automatic' })).toEqual({ automatic: true });
    expect(billingTax({ STRIPE_TAX: 'none' })).toEqual({ none: true });
    for (const value of ['', undefined, 'auto', 'txr_', 'price_1']) expect(billingTax({ STRIPE_TAX: value })).toBeNull();
  });

  it('tells a live key from a test key', () => {
    expect(stripeLive({ STRIPE_SECRET_KEY: 'sk_live_x' })).toBe(true);
    expect(stripeLive({ STRIPE_SECRET_KEY: 'rk_live_x' })).toBe(true);
    expect(stripeLive({ STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(false);
    expect(stripeLive({})).toBe(false);
  });
});

describe('eventWorkspace', () => {
  it('finds the workspace in a session, a subscription and both shapes of invoice', () => {
    expect(eventWorkspace({ data: { object: { object: 'checkout.session', metadata: { workspace: W } } } })).toBe(W);
    expect(eventWorkspace({ data: { object: { object: 'subscription', metadata: { workspace: W } } } })).toBe(W);
    expect(eventWorkspace({ data: { object: { object: 'invoice', parent: { subscription_details: { metadata: { workspace: W } } } } } })).toBe(W);
    expect(eventWorkspace({ data: { object: { object: 'invoice', subscription_details: { metadata: { workspace: W } } } } })).toBe(W);
  });

  it('finds none in anything else', () => {
    expect(eventWorkspace({ data: { object: { object: 'invoice', metadata: { workspace: 'w_short' } } } })).toBeNull();
    expect(eventWorkspace({ data: { object: { object: 'subscription', client_reference_id: W } } })).toBeNull();
    // Anyone can add client_reference_id to a Payment Link's address: it never names the workspace.
    expect(eventWorkspace({ data: { object: { object: 'checkout.session', metadata: {}, client_reference_id: W } } })).toBeNull();
    expect(eventWorkspace({})).toBeNull();
  });
});
