'use strict';

// Exercises the real IMAP/SMTP path against a disposable Ethereal mailbox (ethereal.email).
// Skips when the service is unreachable, so offline runs stay green.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodemailer = require('nodemailer');
const { Engine } = require('../src/main/engine');
const { ImapAccount } = require('../src/main/imap');

async function testAccount() {
  try {
    return await Promise.race([
      nodemailer.createTestAccount(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
    ]);
  } catch (_) {
    return null;
  }
}

async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 1500));
  }
}

test('real IMAP/SMTP account: add, sync, preview, flags, send, append, delete', { timeout: 180000 }, async (t) => {
  const eth = await testAccount();
  if (!eth) return t.skip('Ethereal not reachable');

  const engine = new Engine({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sem-imap-')) }).init();
  await assert.rejects(
    engine.addAccount({ provider: 'other', email: eth.user, password: 'wrong-password', imap: eth.imap, smtp: eth.smtp }),
    /Aanmelden mislukt|IMAP/
  );

  const acc = await engine.addAccount({ provider: 'other', email: eth.user, password: eth.pass, imap: eth.imap, smtp: eth.smtp });
  await engine.syncAccount(acc.id);
  const folders = engine.state().accounts[0].folders;
  assert.ok(folders.some((f) => f.role === 'inbox'), `inbox found in ${JSON.stringify(folders)}`);

  // Put a multipart message with an attachment straight into the inbox.
  const raw = await ImapAccount.compose({
    from: { name: 'Integratietest', address: 'test@voorbeeld.nl' },
    to: [{ name: '', address: eth.user }],
    subject: 'Integratie €',
    text: 'Platte tekst met café en een link https://example.com',
    html: '<p>HTML met <b>café</b></p>',
    attachments: [{ filename: 'notitie.txt', content: 'hallo' }]
  });
  const session = engine.session(engine.account(acc.id));
  await session.append('INBOX', raw, []);
  await engine.syncAccount(acc.id);
  const msg = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.subject === 'Integratie €');
  assert.ok(msg, 'appended message synced');
  assert.equal(msg.unread, true);
  assert.equal(msg.hasAttachments, true);
  assert.match(msg.preview, /Platte tekst met café/);

  const full = await engine.getMessage(msg.id);
  assert.match(full.html, /café/);
  assert.equal(full.attachments[0].filename, 'notitie.txt');
  assert.equal((await engine.attachment(msg.id, full.attachments[0].index)).content.toString(), 'hallo');

  await engine.setFlags(msg.id, { unread: false, starred: true });
  engine.caches.get(acc.id).boxes.INBOX.messages.forEach((m) => (m.unread = true));
  await engine.syncAccount(acc.id);
  const again = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.id === msg.id);
  assert.equal(again.unread, false, 'seen flag persisted on the server');
  assert.equal(again.starred, true, 'flagged flag persisted on the server');

  // SMTP send; Ethereal captures it and exposes the message over IMAP.
  await engine.send({ accountId: acc.id, to: [eth.user], subject: 'Via SMTP verzonden', html: '<p>Hoi</p>' });
  const delivered = await waitFor(async () => {
    await engine.syncAccount(acc.id);
    return engine.listMessages({ scope: acc.id, view: 'inbox' }).some((m) => m.subject === 'Via SMTP verzonden');
  });
  assert.ok(delivered);

  const where = await engine.remove(msg.id);
  assert.ok(['trash', 'deleted'].includes(where));
  await engine.syncAccount(acc.id);
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'inbox' }).some((m) => m.id === msg.id));
  await engine.close();
});
