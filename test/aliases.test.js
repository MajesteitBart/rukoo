'use strict';

// Sending addresses per account: aliases, the default sender and the Gmail "Send mail as" import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/main/engine');

async function demoEngine(opts = {}) {
  const engine = new Engine({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sem-al-')), ...opts }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  return { engine, acc };
}

test('default sender: aliases, default, validation and the From of sent mail', async () => {
  const { engine, acc } = await demoEngine();
  let pub = engine.publicAccount(engine.account(acc.id));
  assert.equal(pub.defaultFrom, 'demo@voorbeeld.nl');
  assert.equal(pub.identities.length, 1);

  pub = await engine.updateAccount(acc.id, {
    aliases: [{ address: 'Bart@Bvdm.ai', name: 'Bart' }, { address: 'bart@bvdm.ai' }, { address: 'demo@voorbeeld.nl' }]
  });
  assert.deepEqual(pub.identities.map((i) => i.address), ['demo@voorbeeld.nl', 'bart@bvdm.ai'], 'deduplicated, lowercased');
  await assert.rejects(engine.updateAccount(acc.id, { aliases: [{ address: 'geen-adres' }] }), /Ongeldig/);
  await assert.rejects(engine.updateAccount(acc.id, { defaultFrom: 'iemand@anders.nl' }), /hoort niet/);

  pub = await engine.updateAccount(acc.id, { defaultFrom: 'bart@bvdm.ai' });
  assert.equal(pub.defaultFrom, 'bart@bvdm.ai');

  // No explicit From: the default sender is used.
  await engine.send({ accountId: acc.id, to: ['demo@voorbeeld.nl'], subject: 'Via standaard', text: 'x' });
  // Explicit From: the account address.
  await engine.send({ accountId: acc.id, from: 'demo@voorbeeld.nl', to: ['demo@voorbeeld.nl'], subject: 'Via account', text: 'x' });
  await assert.rejects(engine.send({ accountId: acc.id, from: 'vreemd@elders.nl', to: ['demo@voorbeeld.nl'], subject: 'x', text: 'x' }), /niet verzenden als/);
  await engine.syncAccount(acc.id);
  const inbox = engine.listMessages({ scope: acc.id, view: 'inbox' });
  assert.equal(inbox.find((m) => m.subject === 'Via standaard').from.address, 'bart@bvdm.ai');
  assert.equal(inbox.find((m) => m.subject === 'Via standaard').from.name, 'Bart');
  assert.equal(inbox.find((m) => m.subject === 'Via account').from.address, 'demo@voorbeeld.nl');

  assert.ok(!engine.contacts().some((c) => c.address === 'bart@bvdm.ai'), 'own aliases are not suggested as contacts');

  // Removing the default alias falls back to the account address.
  pub = await engine.updateAccount(acc.id, { aliases: [] });
  assert.equal(pub.defaultFrom, 'demo@voorbeeld.nl');
  await engine.close();
});

test('Gmail import keeps verified addresses and adopts Gmail\'s default once', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        sendAs: [
          { sendAsEmail: 'me@bartvandermeeren.nl', isPrimary: true, verificationStatus: undefined },
          { sendAsEmail: 'bart@bvdm.ai', displayName: 'Bart van der Meeren', isDefault: true, verificationStatus: 'accepted' },
          { sendAsEmail: 'oud@elders.nl', verificationStatus: 'pending' }
        ]
      })
    };
  };
  const google = { available: () => true, refresh: async () => ({ accessToken: 'tok', expiresAt: Date.now() + 3600000 }) };
  const engine = new Engine({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sem-alg-')), google, fetchImpl }).init();
  const acc = { id: 'g1', type: 'imap', provider: 'google', auth: 'oauth2', email: 'me@bartvandermeeren.nl', name: 'Bart', secret: 'rt' };
  engine.accounts.push(acc);
  engine.caches.set(acc.id, { folders: [], boxes: {}, lastSync: null });

  let pub = await engine.fetchGmailAliases('g1');
  assert.equal(calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.deepEqual(pub.identities.map((i) => i.address), ['me@bartvandermeeren.nl', 'bart@bvdm.ai'], 'pending addresses are skipped');
  assert.equal(pub.defaultFrom, 'bart@bvdm.ai', "Gmail's default is adopted");

  await engine.updateAccount('g1', { defaultFrom: 'me@bartvandermeeren.nl' });
  pub = await engine.fetchGmailAliases('g1');
  assert.equal(pub.defaultFrom, 'me@bartvandermeeren.nl', 'a choice made in the app is kept');
});
