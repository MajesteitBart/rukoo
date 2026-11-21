'use strict';

// The Billing section of Workspace settings as rows and labels (src/renderer/chat-billing.js): who sees it, the
// status, the seats and the monthly total from the server's price, the notes and the owner's actions, in English and
// Dutch. chat-dialogs.js draws it; test/e2e/chat-billing.spec.js runs it against the account server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const i18n = require('../src/i18n');

// A browser module in a CommonJS package, loaded from a data: URL as test/chat-model.test.js does.
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat-billing.js'), 'utf8');
const loading = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const en = (key, params) => i18n.translate('en', key, params);
const nl = (key, params) => i18n.translate('nl', key, params);
const PRICE = { amount: 1950, currency: 'eur', interval: 'month', taxBehavior: 'inclusive' };
const NONE = { status: 'none', members: 3, pending: 1, seats: null, periodEnd: null, cancelAtPeriodEnd: false, payment: null, paymentAt: null, syncing: false, canCheckout: true, canManage: false, price: PRICE };
const ACTIVE = { ...NONE, status: 'active', seats: 3, pending: 0, periodEnd: Date.UTC(2026, 11, 21, 12), canCheckout: false, canManage: true };
const values = (m) => Object.fromEntries(m.rows.map((r) => [r.label, r.value]));
const nbsp = (s) => s.replace(/[  ]/g, ' ');

test('the section shows for owners and admins on a server that bills workspaces, and for nobody else', async () => {
  const { showsBilling } = await loading;
  assert.equal(showsBilling(['reactions', 'billing'], 'owner'), true);
  assert.equal(showsBilling(new Set(['billing']), 'admin'), true);
  assert.equal(showsBilling(['billing'], 'member'), false);
  assert.equal(showsBilling(['billing'], 'guest'), false);
  assert.equal(showsBilling(['reactions'], 'owner'), false);
  assert.equal(showsBilling(undefined, 'owner'), false);
});

test('before billing is set up, an owner sees one seat per member, the total with VAT and Set up billing', async () => {
  const { billingModel } = await loading;
  const m = billingModel(NONE, { role: 'owner', locale: 'en-GB', t: en });
  assert.deepEqual(m.status, { label: 'Not set up', tone: 'muted' });
  assert.deepEqual(values(m), { 'Paid seats once set up': '3', 'Monthly total once set up': '€58.50 a month, VAT included' });
  assert.equal(m.rows[1].help, '€19.50 per member a month, VAT included');
  assert.deepEqual(
    m.notes.map((n) => n.text),
    ['Every member who joined is a paid seat, guests included.', "1 open invitation isn't billed until someone joins with it."]
  );
  assert.deepEqual(m.actions, [{ kind: 'checkout', label: 'Set up billing', primary: true }]);
});

test('an active subscription shows the billed seats, the renewal date, vacant seats and Manage billing', async () => {
  const { billingModel } = await loading;
  const m = billingModel({ ...ACTIVE, members: 2, seats: 3 }, { role: 'owner', locale: 'en-GB', t: en });
  assert.deepEqual(m.status, { label: 'Active', tone: 'ok' });
  assert.deepEqual(values(m), { 'Paid seats': '3', 'Monthly total': '€58.50 a month, VAT included', 'Renews on': '21 December 2026' });
  assert.match(m.notes[0].text, /^1 seat is vacant\./);
  assert.deepEqual(m.actions, [{ kind: 'portal', label: 'Manage billing', primary: false }]);
  const ending = billingModel({ ...ACTIVE, cancelAtPeriodEnd: true }, { role: 'owner', locale: 'en-GB', t: en });
  assert.equal(values(ending)['Ends on'], '21 December 2026');
});

test('an admin sees the same without actions, and is told only owners change it', async () => {
  const { billingModel } = await loading;
  const m = billingModel(ACTIVE, { role: 'admin', locale: 'en-GB', t: en });
  assert.deepEqual(m.actions, []);
  assert.equal(m.notes.at(-1).text, 'Only owners can change billing.');
  // canCheckout and canManage come from the server for the caller; an admin's are false, and the role decides too.
  assert.deepEqual(billingModel({ ...NONE, canCheckout: true }, { role: 'admin', locale: 'en', t: en }).actions, []);
});

test('a failed payment, a seat change on its way and every status get their words and tone', async () => {
  const { billingModel } = await loading;
  const failed = billingModel({ ...ACTIVE, status: 'past_due', payment: 'failed', syncing: true }, { role: 'owner', locale: 'en', t: en });
  assert.deepEqual(failed.status, { label: 'Payment overdue', tone: 'danger' });
  assert.deepEqual(failed.notes[0], { text: 'The last payment failed. Update the payment method in Manage billing.', tone: 'danger' });
  assert.ok(failed.notes.some((n) => n.text === 'Updating the seats in Stripe…'));
  assert.equal(billingModel({ ...ACTIVE, payment: 'failed' }, { role: 'admin', locale: 'en', t: en }).notes[0].text, 'The last payment failed. An owner can update the payment method.');
  const tones = {
    none: 'muted', incomplete_expired: 'muted', incomplete: 'warn', trialing: 'ok', active: 'ok', past_due: 'danger', unpaid: 'danger', paused: 'warn', canceled: 'muted', something_new: 'muted'
  };
  for (const [status, tone] of Object.entries(tones)) {
    const m = billingModel({ ...ACTIVE, status }, { role: 'owner', locale: 'en', t: en });
    assert.equal(m.status.tone, tone, status);
    assert.ok(!m.status.label.startsWith('chat.'), status);
  }
  // A subscription that ended bills nothing: the seats are one per member again.
  const ended = billingModel({ ...ACTIVE, status: 'canceled', members: 2, seats: null, periodEnd: null, canCheckout: true }, { role: 'owner', locale: 'en', t: en });
  assert.equal(values(ended)['Paid seats once set up'], '2');
  assert.deepEqual(ended.actions.map((a) => a.kind), ['checkout', 'portal']);
});

test('the price comes from the server: another amount, a price without VAT and another currency', async () => {
  const { billingModel, money } = await loading;
  const exclusive = billingModel({ ...ACTIVE, seats: 2, price: { amount: 1612, currency: 'eur', interval: 'month', taxBehavior: 'exclusive' } }, { role: 'owner', locale: 'en-GB', t: en });
  assert.equal(values(exclusive)['Monthly total'], '€32.24 a month plus VAT');
  const plain = billingModel({ ...ACTIVE, seats: 1, price: { amount: 2000, currency: 'usd', interval: 'month', taxBehavior: 'unspecified' } }, { role: 'owner', locale: 'en-US', t: en });
  assert.equal(values(plain)['Monthly total'], '$20.00 a month');
  assert.equal(money(1950, 'jpy', 'en-US'), '¥1,950');
  // Ten seats of 19.50 in whole cents: no rounding on the way.
  assert.equal(values(billingModel({ ...ACTIVE, seats: 10 }, { role: 'owner', locale: 'en-GB', t: en }))['Monthly total'], '€195.00 a month, VAT included');
});

test('Dutch reads as Dutch, with Dutch numbers and dates', async () => {
  const { billingModel } = await loading;
  const m = billingModel({ ...ACTIVE, members: 1, seats: 3, pending: 2 }, { role: 'owner', locale: 'nl-NL', t: nl });
  assert.equal(m.status.label, 'Actief');
  const rows = values(m);
  assert.equal(nbsp(rows['Per maand']), '€ 58,50 per maand, inclusief btw');
  assert.equal(rows['Verlengt op'], '21 december 2026');
  assert.match(m.notes[0].text, /^2 plekken zijn vrij\./);
  assert.match(m.notes[1].text, /^2 open uitnodigingen kosten niets/);
  assert.deepEqual(m.actions.map((a) => a.label), ['Betalen beheren']);
});
