'use strict';

// Exercises the real IMAP/SMTP path against a disposable Ethereal mailbox (ethereal.email).
// Skips when the service is unreachable, so offline runs stay green.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
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

  const engine = new Engine({ dataDir: tempDir('sem-imap-') }).init();
  await assert.rejects(
    engine.addAccount({ provider: 'other', email: eth.user, password: 'wrong-password', imap: eth.imap, smtp: eth.smtp }),
    /Sign-in failed|IMAP/
  );

  const acc = await engine.addAccount({ provider: 'other', email: eth.user, password: eth.pass, imap: eth.imap, smtp: eth.smtp });
  await engine.syncAccount(acc.id);
  const folders = engine.state().accounts[0].folders;
  assert.ok(folders.some((f) => f.role === 'inbox'), `inbox found in ${JSON.stringify(folders)}`);

  // Put a multipart message with an attachment straight into the inbox.
  const raw = await ImapAccount.compose({
    from: { name: 'Integration test', address: 'test@example.com' },
    to: [{ name: '', address: eth.user }],
    subject: 'Integration €',
    text: 'Plain text with café and a link https://example.com',
    html: '<p>HTML with <b>café</b></p>',
    attachments: [{ filename: 'note.txt', content: 'hello' }]
  });
  const session = engine.session(engine.account(acc.id));
  await session.append('INBOX', raw, []);
  await engine.syncAccount(acc.id);
  const msg = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.subject === 'Integration €');
  assert.ok(msg, 'appended message synced');
  assert.equal(msg.unread, true);
  assert.equal(msg.hasAttachments, true);
  assert.match(msg.preview, /Plain text with café/);

  const full = await engine.getMessage(msg.id);
  assert.match(full.html, /café/);
  assert.equal(full.attachments[0].filename, 'note.txt');
  assert.equal((await engine.attachment(msg.id, full.attachments[0].index)).content.toString(), 'hello');

  await engine.setFlags(msg.id, { unread: false, starred: true });
  engine.caches.get(acc.id).boxes.INBOX.messages.forEach((m) => (m.unread = true));
  await engine.syncAccount(acc.id);
  const again = engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.id === msg.id);
  assert.equal(again.unread, false, 'seen flag persisted on the server');
  assert.equal(again.starred, true, 'flagged flag persisted on the server');

  // SMTP send; Ethereal captures it and exposes the message over IMAP.
  await engine.send({ accountId: acc.id, to: [eth.user], subject: 'Sent via SMTP', html: '<p>Hi</p>' });
  const delivered = await waitFor(async () => {
    await engine.syncAccount(acc.id);
    return engine.listMessages({ scope: acc.id, view: 'inbox' }).some((m) => m.subject === 'Sent via SMTP');
  });
  assert.ok(delivered);

  const where = await engine.remove(msg.id);
  assert.ok(['trash', 'deleted'].includes(where));
  await engine.syncAccount(acc.id);
  assert.ok(!engine.listMessages({ scope: acc.id, view: 'inbox' }).some((m) => m.id === msg.id));
  await engine.close();
});

// #56: a large message shows its text in about the time a text-only message takes, and reads like the whole one.
test('real IMAP account: a large message opens with its text first, and its attachments follow whole', { timeout: 180000 }, async (t) => {
  const eth = await testAccount();
  if (!eth) return t.skip('Ethereal not reachable');
  const crypto = require('crypto');
  const { simpleParser } = require('mailparser');

  const engine = new Engine({ dataDir: tempDir('sem-imap-large-') }).init();
  try {
    const acc = await engine.addAccount({ provider: 'other', email: eth.user, password: eth.pass, imap: eth.imap, smtp: eth.smtp });
    await engine.syncAccount(acc.id);
    const session = engine.session(engine.account(acc.id));
    const pdf = crypto.randomBytes(5 * 1024 * 1024);
    const logo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const mail = (subject, attachments) =>
      ImapAccount.compose({
        from: { name: 'Integration test', address: 'test@example.com' },
        to: [{ name: '', address: eth.user }],
        subject,
        text: 'The report is attached, café included.',
        html: '<p>The report is attached, <b>café</b> included.</p><img src="cid:logo@example.com">',
        attachments
      });
    await session.append('INBOX', await mail('Text only', [{ filename: 'logo.png', content: logo, cid: 'logo@example.com' }]), []);
    await session.append('INBOX', await mail('Large report', [{ filename: 'logo.png', content: logo, cid: 'logo@example.com' }, { filename: 'report.pdf', content: pdf }]), []);
    await engine.syncAccount(acc.id);
    const find = (subject) => engine.listMessages({ scope: acc.id, view: 'inbox' }).find((m) => m.subject === subject);
    const large = find('Large report');
    const small = find('Text only');
    assert.ok(large && small, 'both synced');
    const { folder, uid, msg } = engine.locate(large.id);
    assert.ok(msg.size > 5 * 1024 * 1024, `${msg.size} bytes on the server`);

    const timed = async (fn) => {
      const start = Date.now();
      const value = await fn();
      return [value, Date.now() - start];
    };
    // The reader connection is open and in the folder before anything is timed.
    await session.fetchSource(folder, engine.locate(small.id).uid);
    const [, textOnlyMs] = await timed(() => session.fetchSource(folder, engine.locate(small.id).uid));
    // The whole message straight from the session, which keeps nothing on disk, before the background download runs.
    const [source, wholeMs] = await timed(() => session.fetchSource(folder, uid));
    const [partial, partialMs] = await timed(() => engine.getMessage(large.id, { fast: true }));
    t.diagnostic(`text-only message: ${textOnlyMs} ms; large message, text first: ${partialMs} ms; large message whole: ${wholeMs} ms`);

    assert.equal(partial.partial, true);
    assert.match(partial.html, /caf&eacute;|café/);
    assert.match(partial.html, /data:image\/png;base64,iVBOR/, 'the inline picture came along');
    assert.deepEqual(partial.attachments.map((a) => a.filename), ['report.pdf']);
    assert.ok(Math.abs(partial.attachments[0].size - pdf.length) < pdf.length * 0.03, `${partial.attachments[0].size}`);
    assert.ok(partialMs < wholeMs, `text first (${partialMs} ms) is quicker than the whole message (${wholeMs} ms)`);

    // The whole message follows in the background; then the reader has it from disk, attachment and all.
    assert.equal(await engine.downloaded(large.id), true);
    const whole = await engine.getMessage(large.id, { fast: true });
    assert.equal(whole.partial, undefined);
    assert.equal(whole.html, partial.html);
    assert.deepEqual(whole.attachments.map((a) => [a.index, a.filename]), partial.attachments.map((a) => [a.index, a.filename]));
    const a = await engine.attachment(large.id, whole.attachments[0].index);
    assert.ok(a.content.equals(pdf), 'the attachment is whole');
    assert.equal((await simpleParser(source)).attachments.find((x) => x.filename === 'report.pdf').size, pdf.length);
  } finally {
    await engine.close();
  }
});

// #99, with a window of two messages instead of the inbox's 300.
test('real IMAP account: the unread mail below the synced window is counted on the server', { timeout: 120000 }, async (t) => {
  const eth = await testAccount();
  if (!eth) return t.skip('Ethereal not reachable');

  const session = new ImapAccount({ email: eth.user, imap: eth.imap, smtp: eth.smtp }, eth.pass);
  try {
    const before = (await session.syncFolder('INBOX', { limit: 1000 })).messages.filter((m) => m.unread).length;
    // Oldest first. Below a window of two: Older 1 and Older 3 unread, Older 2 read.
    for (const [n, seen] of [[1, false], [2, true], [3, false], [4, false], [5, true]]) {
      const raw = await ImapAccount.compose({ from: { name: 'Integration test', address: 'test@example.com' }, to: [{ name: '', address: eth.user }], subject: `Older ${n}`, text: `Message ${n}` });
      await session.append('INBOX', raw, seen ? ['\\Seen'] : []);
    }
    const res = await session.syncFolder('INBOX', { limit: 2, olderUnseen: true });
    assert.deepEqual(res.messages.map((m) => m.subject), ['Older 4', 'Older 5']);
    assert.equal(res.olderUnseen, before + 2);

    // Read on the server, it no longer counts at the next sync.
    const all = await session.syncFolder('INBOX', { limit: 1000, olderUnseen: true });
    assert.equal(all.olderUnseen, 0, 'nothing is below a window that holds the whole inbox');
    await session.setFlags('INBOX', all.messages.find((m) => m.subject === 'Older 1').uid, { unread: false });
    assert.equal((await session.syncFolder('INBOX', { limit: 2, olderUnseen: true })).olderUnseen, before + 1);
  } finally {
    await session.close();
  }
});
