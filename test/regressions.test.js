'use strict';

// Regression tests for issues found in code review.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { simpleParser } = require('mailparser');
const { Engine } = require('../src/main/engine');
const { RISKY, safeName } = require('../src/main/files');

async function freshEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-reg-'));
  const engine = new Engine({ dataDir: dir }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  return { engine, acc, dir };
}

test('delete without a Prullenbak asks first and only expunges with force', async () => {
  const { engine, acc } = await freshEngine();
  const cache = engine.caches.get(acc.id);
  cache.folders = cache.folders.filter((f) => f.role !== 'trash');
  const first = engine.listMessages({ scope: acc.id, view: 'inbox' })[0];
  assert.equal(await engine.remove(first.id), 'confirm');
  assert.ok(engine.listMessages({ scope: acc.id, view: 'inbox' }).some((m) => m.id === first.id), 'still there');
  assert.equal(await engine.remove(first.id, { force: true }), 'deleted');
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'inbox' }).some((m) => m.id === first.id));
  await engine.close();
});

test('a sync that runs during a flag change does not undo it', async () => {
  const { engine, acc } = await freshEngine();
  const session = engine.session(engine.account(acc.id));
  const realSetFlags = session.setFlags.bind(session);
  let release;
  session.setFlags = (...args) => new Promise((r) => (release = r)).then(() => realSetFlags(...args));
  const target = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.unread);
  const flagging = engine.setFlags(target.id, { unread: false });
  await engine.syncAccount(acc.id); // reads server state where the message is still unread
  const during = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.id === target.id);
  assert.equal(during.unread, false, 'optimistic state survives the sync');
  release();
  await flagging;
  await engine.syncAccount(acc.id);
  assert.equal(engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.id === target.id).unread, false);
  await engine.close();
});

test('a sync during a move does not bring the message back', async () => {
  const { engine, acc } = await freshEngine();
  const session = engine.session(engine.account(acc.id));
  const realMove = session.move.bind(session);
  let release;
  session.move = (...args) => new Promise((r) => (release = r)).then(() => realMove(...args));
  const target = engine.listMessages({ scope: acc.id, view: 'inbox' })[0];
  const moving = engine.remove(target.id);
  await engine.syncAccount(acc.id);
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'inbox' }).some((m) => m.id === target.id));
  release();
  assert.equal(await moving, 'trash');
  await engine.close();
});

test('re-saving and sending a draft keeps its attachments, Bcc and threading', async () => {
  const { engine, acc } = await freshEngine();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sem-att-')), 'offerte.pdf');
  fs.writeFileSync(file, '%PDF-1.4 test');
  const firstId = await engine.saveDraft({
    accountId: acc.id,
    to: ['klant@voorbeeld.nl'],
    bcc: ['archief@voorbeeld.nl'],
    subject: 'Re: Offerte',
    html: '<p>concept</p>',
    attachments: [{ path: file, filename: 'offerte.pdf' }],
    inReplyTo: '<orig@voorbeeld.nl>',
    references: ['<orig@voorbeeld.nl>']
  });
  const draft = await engine.getMessage(firstId);
  assert.equal(draft.attachments.length, 1);
  assert.deepEqual(draft.bcc.map((a) => a.address), ['archief@voorbeeld.nl']);
  assert.equal(draft.inReplyTo, '<orig@voorbeeld.nl>');

  // What the compose window does when a reopened draft is saved again.
  const secondId = await engine.saveDraft({
    accountId: acc.id,
    to: draft.to,
    bcc: draft.bcc,
    subject: draft.subject,
    html: '<p>concept v2</p>',
    forwardId: firstId,
    forwardIndexes: draft.attachments.map((a) => a.index),
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    draftId: firstId
  });
  const second = await engine.getMessage(secondId);
  assert.equal(second.attachments[0].filename, 'offerte.pdf');
  assert.equal(engine.listMessages({ scope: acc.id, view: 'drafts' }).filter((m) => m.subject === 'Re: Offerte').length, 1);

  await engine.send({
    accountId: acc.id,
    to: ['demo@voorbeeld.nl'],
    bcc: second.bcc,
    subject: second.subject,
    html: '<p>definitief</p>',
    forwardId: secondId,
    forwardIndexes: second.attachments.map((a) => a.index),
    inReplyTo: second.inReplyTo,
    references: second.references,
    draftId: secondId
  });
  await engine.syncAccount(acc.id);
  const received = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.subject === 'Re: Offerte');
  const full = await engine.getMessage(received.id);
  assert.equal(full.attachments[0].filename, 'offerte.pdf');
  assert.equal(full.inReplyTo, '<orig@voorbeeld.nl>');
  assert.equal(full.bcc.length, 0, 'sent mail does not reveal Bcc');
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'drafts' }).some((m) => m.subject === 'Re: Offerte'));
  await engine.close();
});

test('replying sets \\Answered on the server', async () => {
  const { engine, acc } = await freshEngine();
  const original = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.from.name === 'Sanne de Vries');
  await engine.send({ accountId: acc.id, to: ['sanne@voorbeeld.nl'], subject: 'Re: x', text: 'ok', replyToId: original.id });
  await engine.syncAccount(acc.id);
  assert.equal(engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.id === original.id).answered, true);
  await engine.close();
});

test('syncAll reports failing accounts instead of claiming success', async () => {
  const { engine, acc } = await freshEngine();
  engine.session(engine.account(acc.id)).listFolders = async () => {
    throw new Error('Verbinding geweigerd');
  };
  await assert.rejects(engine.syncAll(), /demo@voorbeeld\.nl: Verbinding geweigerd/);
  assert.equal(engine.state().accounts[0].error, 'Verbinding geweigerd');
  await engine.close();
});

test('attachment names cannot escape the folder or hide an executable', () => {
  assert.equal(safeName('..\\..\\Startup\\x.bat'), '_.._Startup_x.bat');
  assert.ok(!safeName('../../etc/passwd').includes('/'));
  assert.ok(RISKY.test(safeName('factuur.pdf.exe')));
  assert.ok(RISKY.test(safeName('invoice‮fdp.exe')), 'right-to-left override does not hide .exe');
  assert.ok(RISKY.test(safeName('script.js.')), 'trailing dots are stripped');
  assert.ok(RISKY.test(safeName('Snelkoppeling.LNK')));
  assert.ok(!RISKY.test(safeName('Contractbevestiging.pdf')));
  assert.equal(safeName(''), 'bijlage');
});

test('message ids from a draft parse back with Bcc only when kept', async () => {
  const { ImapAccount } = require('../src/main/imap');
  const mail = { from: 'a@b.nl', to: 'c@d.nl', bcc: 'x@y.nl', subject: 's', text: 't' };
  assert.equal((await simpleParser(await ImapAccount.compose({ ...mail, keepBcc: true }))).bcc.text, 'x@y.nl');
  assert.equal((await simpleParser(await ImapAccount.compose(mail))).bcc, undefined);
});

test('demo mail of today stays in the past and in order at any hour', () => {
  const { seed } = require('../src/main/demo');
  const order = (now) =>
    seed(now)
      .boxes.INBOX.messages.filter((m) => new Date(m.date).toDateString() === new Date(now).toDateString())
      .sort((a, b) => b.date - a.date)
      .map((m) => m.subject);
  const evening = order(new Date(2026, 9, 7, 21, 0).getTime());
  for (const [h, min] of [[0, 5], [9, 30], [13, 30], [14, 50]]) {
    const now = new Date(2026, 9, 7, h, min).getTime();
    assert.deepEqual(order(now), evening, `order at ${h}:${min}`);
    assert.ok(seed(now).boxes.INBOX.messages.every((m) => m.date <= now), `all in the past at ${h}:${min}`);
  }
});
