'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { mailSignals } = require('../src/main/categories/signals');
const { presetFor, looksLikePerson } = require('../src/main/categories/rules');
const jev = require('../src/main/categories/jev');
const { Categories } = require('../src/main/categories');
const { AccountService } = require('../src/main/account');

const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-categories-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('mail headers become a few signals', () => {
  const raw = Buffer.from(
    'List-Unsubscribe: <https://example.com/u>,\r\n <mailto:u@example.com>\r\nPrecedence: bulk\r\nX-Mailer: MailChimp Mailer\r\nAuto-Submitted: no\r\n'
  );
  assert.deepEqual(mailSignals(raw), { list: true, bulk: true, campaign: true });
  assert.deepEqual(mailSignals({ 'Auto-Submitted': 'auto-generated', 'Feedback-ID': '1:2:3' }), { bulk: true, auto: true });
  assert.deepEqual(mailSignals(undefined), {});
  assert.deepEqual(mailSignals('Subject: hello\r\n'), {});
});

test('the rules place mail by what it says about itself', () => {
  const own = ['me@work.example'];
  const msg = (from, extra = {}) => ({ from, to: [{ address: 'me@work.example' }], subject: 'Hello', ...extra });
  const pick = (m, opts = {}) => presetFor(m, { own, ...opts });

  assert.deepEqual(pick(msg({ name: 'Boss', address: 'boss@corp.example' }), { vip: true }), { preset: 'needs-you', strength: 'strong' });
  assert.equal(pick(msg({ name: 'Shop', address: 'hi@shop.example' }, { signals: { campaign: true } })).preset, 'promotions');
  assert.equal(pick(msg({ name: 'Shop', address: 'hi@shop.example' }, { gmailTab: 'promotions' })).preset, 'promotions');
  assert.equal(pick(msg({ name: 'ANWB', address: 'newsletter@anwb.nl' })).preset, 'promotions');
  assert.equal(pick(msg({ name: 'Energy', address: 'hi@energy.example' }, { subject: 'Your invoice for October' })).preset, 'money');
  assert.equal(pick(msg({ name: 'Energie', address: 'hi@energie.example' }, { subject: 'Je factuur van oktober' })).preset, 'money');
  assert.deepEqual(pick(msg({ name: 'App', address: 'no-reply@app.example' })), { preset: 'updates', strength: 'strong' });
  assert.equal(pick(msg({ name: 'App', address: 'hi@app.example' }, { signals: { auto: true } })).preset, 'updates');
  assert.equal(pick(msg({ name: 'Forum', address: 'hi@forum.example' }, { gmailTab: 'forums' })).preset, 'updates');
  // A newsletter, unless the sender is someone you write to.
  assert.equal(pick(msg({ name: 'Club', address: 'board@club.example' }, { signals: { list: true } })).preset, 'promotions');
  assert.equal(pick(msg({ name: 'Club', address: 'board@club.example' }, { signals: { list: true } }), { known: true }).preset, 'needs-you');
  assert.equal(pick(msg({ name: 'Bank', address: 'service@bank.example' }, { signals: { bulk: true } })).preset, 'updates');
  // People: to you directly needs you, copied is to read.
  assert.equal(pick(msg({ name: 'Sanne de Vries', address: 'sanne@studio.example' })).preset, 'needs-you');
  assert.equal(pick({ ...msg({ name: 'Sanne de Vries', address: 'sanne@studio.example' }), to: [{ address: 'team@studio.example' }], cc: [{ address: 'me@work.example' }] }).preset, 'to-read');
  assert.equal(pick(msg({ name: 'Colleague', address: 'x@work.example' })).preset, 'needs-you');
  assert.equal(pick(msg({ name: 'Friend', address: 'friend@gmail.com' })).preset, 'needs-you');
  assert.equal(pick(msg({ name: 'Vandebron', address: 'support@vandebron.nl' })).preset, 'updates');
  assert.equal(pick(msg({ name: 'Vandebron', address: 'support@vandebron.nl' }), { known: true }).preset, 'needs-you');
});

test('a person is a name of two words that matches the address', () => {
  assert.equal(looksLikePerson({ name: 'Sanne de Vries', address: 'sanne.devries@x.example' }), true);
  assert.equal(looksLikePerson({ name: 'Joris Bakker', address: 'jbakker@x.example' }), true);
  assert.equal(looksLikePerson({ name: 'José Müller', address: 'jose@x.example' }), true);
  assert.equal(looksLikePerson({ name: 'Matthew Berman', address: 'newsletter@x.example' }), false);
  assert.equal(looksLikePerson({ name: 'Vandebron', address: 'vandebron@x.example' }), false);
});

test('Jev gets one choice question with the categories as options', async () => {
  const sent = [];
  const request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.write = (body) => sent.push({ url, opts, body: JSON.parse(body) });
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      cb(res);
      const question = sent[0].body.questions.category;
      const choice = Object.keys(question.criteria)[2];
      res.emit('data', Buffer.from(JSON.stringify({ model: 'jev-1.13.0', answers: { category: { type: 'choice', choice, confidence: 0.82, probabilities: {} } } })));
      res.emit('end');
    };
    return req;
  };
  const categories = [
    { id: 'needs-you', name: 'Needs you', description: 'Asks you to act' },
    { id: 'c-1', name: 'Needs you', description: 'A duplicate name' },
    { id: 'money', name: 'Geldzaken', description: 'Facturen' }
  ];
  const m = { from: { name: 'A', address: 'a@x.example' }, subject: 'Factuur', preview: 'x'.repeat(5000), signals: { list: true }, gmailTab: 'updates' };
  const res = await jev.classify('KEY', m, categories, { toMe: true, request });
  assert.deepEqual(res, { category: 'money', confidence: 0.82, model: 'jev-1.13.0' });
  const { body, opts, url } = sent[0];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(opts.headers.authorization, 'Bearer KEY');
  assert.equal(body.model, jev.MODEL);
  assert.deepEqual(Object.keys(body.questions.category.criteria), ['needs_you', 'needs_you_2', 'geldzaken']);
  assert.equal(body.state.text.length, jev.TEXT_CHARS);
  assert.equal(body.state.addressed_to_me, true);
  assert.equal(body.state.mailing_list, true);
  assert.equal(body.state.gmail_tab, 'updates');
});

test('Jev errors say what went wrong', async () => {
  const failing = (status) => (url, opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = status;
      cb(res);
      res.emit('data', Buffer.from('{"error":"x"}'));
      res.emit('end');
    };
    return req;
  };
  const cats = [{ id: 'a', name: 'A' }];
  await assert.rejects(jev.classify('K', {}, cats, { request: failing(401) }), { code: 'key' });
  await assert.rejects(jev.classify('K', {}, cats, { request: failing(429) }), { code: 'busy' });
  await assert.rejects(jev.classify('K', {}, cats, { request: failing(500) }), { code: 'server' });
});

// An engine with one account and an inbox, enough for the categories.
function fakeEngine(messages, sent = []) {
  const engine = new EventEmitter();
  const acc = { id: 'acc1', email: 'me@work.example', aliases: [] };
  engine.accounts = [acc];
  engine.caches = new Map([
    [
      acc.id,
      {
        folders: [
          { path: 'INBOX', role: 'inbox' },
          { path: 'Sent', role: 'sent' }
        ],
        boxes: { INBOX: { messages }, Sent: { messages: sent } }
      }
    ]
  ]);
  engine.vips = new Set();
  engine.isVip = (from) => engine.vips.has(String(from && from.address).toLowerCase());
  engine.locate = (id) => ({ acc, msg: messages.find((m) => m.uid === Number(id)) });
  return { engine, acc };
}

function setup(t, messages, { jevImpl, sent } = {}) {
  const dir = tmpDir(t);
  const { engine, acc } = fakeEngine(messages, sent);
  const account = new AccountService({ dataDir: dir, secrets, defaultServer: '', deviceName: 'desk' }).init();
  const cats = new Categories({ engine, account, secrets, dataDir: dir, jev: jevImpl || jev }).init();
  t.after(() => {
    cats.close();
    account.close();
  });
  return { cats, account, engine, acc };
}

const inbox = () => [
  { uid: 1, messageId: '<1@x>', from: { name: 'Sanne de Vries', address: 'sanne@studio.example' }, to: [{ address: 'me@work.example' }], subject: 'Can you sign this?', date: 3 },
  { uid: 2, messageId: '<2@x>', from: { name: 'Shop', address: 'news@shop.example' }, to: [{ address: 'me@work.example' }], subject: 'Sale', date: 2, signals: { list: true } },
  { uid: 3, messageId: '<3@x>', from: { name: 'App', address: 'noreply@app.example' }, to: [{ address: 'me@work.example' }], subject: 'New login', date: 1 }
];

test('categories start off, and turning them on brings the five in order', (t) => {
  const { cats, acc, engine } = setup(t, inbox());
  assert.equal(cats.of(acc, engine.caches.get('acc1').boxes.INBOX.messages[0]), null);
  const state = cats.setEnabled(true);
  assert.deepEqual(state.categories.map((c) => c.id), ['needs-you', 'to-read', 'money', 'updates', 'promotions']);
  assert.equal(state.categories[0].name, 'Needs you');
  assert.equal(state.unsure, 'to-read');
  const [a, b, c] = engine.caches.get('acc1').boxes.INBOX.messages;
  assert.deepEqual([cats.of(acc, a), cats.of(acc, b), cats.of(acc, c)], ['needs-you', 'promotions', 'updates']);
  // Turning them off and on again doesn't bring back a deleted preset.
  cats.removeCategory('money');
  cats.setEnabled(false);
  cats.setEnabled(true);
  assert.equal(cats.state().categories.some((x) => x.id === 'money'), false);
});

test('a correction wins over a sender rule, which wins over the stored and the ruled category', (t) => {
  const { cats, acc, account, engine } = setup(t, inbox());
  cats.setEnabled(true);
  const [a] = engine.caches.get('acc1').boxes.INBOX.messages;
  const key = cats.key(acc, a);
  account.put('classification', key, { category: 'money', source: 'jev' }, { ifAbsent: true });
  assert.equal(cats.of(acc, a), 'money');
  account.put('sender', 'sanne@studio.example', { category: 'to-read' });
  assert.equal(cats.of(acc, a), 'to-read');
  cats.move(['1'], 'updates');
  assert.equal(cats.of(acc, a), 'updates');
  // A category that no longer exists is skipped.
  cats.removeCategory('updates');
  assert.equal(cats.of(acc, a), 'to-read');
});

test('moving with the sender sets a rule for later mail', (t) => {
  const { cats, acc, account, engine } = setup(t, inbox());
  cats.setEnabled(true);
  cats.move(['2'], 'to-read', { sender: true });
  assert.deepEqual(account.get('sender', 'news@shop.example').category, 'to-read');
  const later = { uid: 9, messageId: '<9@x>', from: { name: 'Shop', address: 'News@Shop.example' }, to: [], subject: 'More', date: 9, signals: { list: true } };
  assert.equal(cats.of(acc, later), 'to-read');
  assert.deepEqual(cats.state().senders, [{ address: 'news@shop.example', category: 'to-read' }]);
  cats.forgetSender('news@shop.example');
  assert.equal(cats.of(acc, later), 'promotions');
  assert.ok(engine);
});

test('sorting stores the rules result once, first write wins', async (t) => {
  const { cats, acc, account, engine } = setup(t, inbox());
  cats.setEnabled(true);
  const sorted = await cats.sort();
  assert.equal(sorted, 3);
  const [a] = engine.caches.get('acc1').boxes.INBOX.messages;
  assert.deepEqual(
    (({ category, source }) => ({ category, source }))(account.get('classification', cats.key(acc, a))),
    { category: 'needs-you', source: 'rules' }
  );
  assert.equal(await cats.sort(), 0, 'nothing left to sort');
  // Sorting again overwrites, apart from what was moved by hand.
  cats.move(['3'], 'money');
  engine.vips.add('sanne@studio.example');
  assert.equal(await cats.sortAgain(), 2);
});

test('Jev sorts the uncertain mail, and an unsure answer goes to the unsure category', async (t) => {
  const calls = [];
  const fake = {
    MODEL: 'jev-test',
    classify: async (key, m, list) => {
      calls.push({ key, subject: m.subject, options: list.map((c) => c.id) });
      return m.subject === 'Can you sign this?' ? { category: 'money', confidence: 0.9, model: 'jev-test' } : { category: 'promotions', confidence: 0.3, model: 'jev-test' };
    }
  };
  const msgs = inbox();
  // From a sender whose address doesn't say it sends offers, so only the unsubscribe link points that way.
  msgs[1].from = { name: 'Shop', address: 'hello@shop.example' };
  msgs.push({ uid: 4, messageId: '<4@x>', from: { name: 'Club', address: 'board@club.example' }, to: [{ address: 'me@work.example' }], subject: 'Meeting notes', date: 0, signals: { list: true } });
  const { cats, acc, account } = setup(t, msgs, { jevImpl: fake });
  cats.setEnabled(true);
  cats.setJev({ key: 'SECRET', on: true });
  assert.equal(cats.state().jev.on, true);
  assert.ok(!JSON.stringify(cats.local).includes('SECRET') || cats.local.jev.key.startsWith('plain:'), 'the key is stored through secrets');
  await cats.sort();
  // The noreply login alert is a strong rule and never goes to Jev.
  assert.deepEqual(calls.map((c) => c.subject).sort(), ['Can you sign this?', 'Meeting notes', 'Sale']);
  assert.equal(calls[0].key, 'SECRET');
  const get = (uid) => account.get('classification', cats.key(acc, msgs.find((m) => m.uid === uid)));
  assert.deepEqual((({ category, source, confidence }) => ({ category, source, confidence }))(get(1)), { category: 'money', source: 'jev', confidence: 0.9 });
  assert.equal(get(2).category, 'to-read', 'below the confidence line it goes to the unsure category');
  assert.equal(get(3).source, 'rules');
});

test('a refused Jev key stops Jev until a new key, and busy waits', async (t) => {
  let fail = 'key';
  const fake = {
    MODEL: 'jev-test',
    classify: async () => {
      throw Object.assign(new Error(fail), { code: fail });
    }
  };
  const { cats } = setup(t, inbox(), { jevImpl: fake });
  cats.setEnabled(true);
  cats.setJev({ key: 'BAD', on: true });
  await cats.sort();
  assert.equal(cats.state().jev.error, 'key');
  cats.setJev({ key: 'NEW' });
  assert.equal(cats.state().jev.error, null);
  fail = 'busy';
  await cats.sort();
  assert.equal(cats.state().jev.error, 'busy');
  assert.ok(cats.jevBusyUntil > Date.now());
});

test('categories can be added, renamed, reordered and deleted, within limits', (t) => {
  const { cats } = setup(t, inbox());
  cats.setEnabled(true);
  assert.throws(() => cats.saveCategory({ name: '  ' }), /name/);
  let state = cats.saveCategory({ name: 'Kids', description: 'School and sports clubs', color: '#4a7dff' });
  const kids = state.categories.find((c) => c.name === 'Kids');
  assert.equal(kids.order, 5);
  state = cats.saveCategory({ id: 'money', name: 'Finance' });
  assert.equal(state.categories.find((c) => c.id === 'money').name, 'Finance');
  state = cats.saveCategory({ id: 'money', name: null });
  assert.equal(state.categories.find((c) => c.id === 'money').name, 'Money', 'back to the preset name');
  state = cats.reorder([kids.id, 'needs-you', 'to-read', 'money', 'updates', 'promotions']);
  assert.equal(state.categories[0].id, kids.id);
  assert.throws(() => cats.reorder(['needs-you']), /invalid/);
  cats.setUnsure(kids.id);
  state = cats.removeCategory(kids.id);
  assert.notEqual(state.unsure, kids.id);
  for (let i = state.categories.length; i < 12; i++) cats.saveCategory({ name: `C${i}` });
  assert.throws(() => cats.saveCategory({ name: 'One more' }), /12/);
});
