'use strict';

// The composer's pure checks (src/renderer/composer-match.js), apart from the DOM around them: pairing a save's
// attachments with the stored draft's, and whether an editor still holds what it last sent (#309). The editor itself is
// in test/e2e/undo-send.spec.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/composer-match.js'), 'utf8');
const loading = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const fwd = (key, forwardIndex, filename) => ({ key, forwardIndex, filename, size: 10 });
const stored = (index, filename) => ({ index, filename, size: 10 });

test('a save that sent what the draft holds pairs them in order, files from disk first', async () => {
  const { attachmentPairs } = await loading;
  const sent = [fwd(1, 0, 'a.pdf'), { key: 2, path: '/tmp/b.pdf', filename: 'b.pdf' }];
  const pairs = attachmentPairs(sent, [stored(1, 'a.pdf'), stored(0, 'b.pdf')]);
  assert.equal(pairs.get(2).index, 0);
  assert.equal(pairs.get(1).index, 1);
});

test('fewer attachments than the draft holds pair by name, and a name the draft lacks pairs nothing', async () => {
  const { attachmentPairs } = await loading;
  const pairs = attachmentPairs([fwd(1, 1, 'b.pdf')], [stored(0, 'a.pdf'), stored(1, 'b.pdf')]);
  assert.equal(pairs.get(1).index, 1);
  assert.equal(attachmentPairs([fwd(1, 0, 'c.pdf')], [stored(0, 'a.pdf'), stored(1, 'b.pdf')]), null);
});

// Final review of #309: a late save left two files named report.pdf in Drafts, and the editor that took the email over
// had removed the first. Pairing by name pointed the one it kept at the removed file. Two files of one name pair nothing.
test('two files of the same name in the draft pair neither, so an attachment never points at another file', async () => {
  const { attachmentPairs } = await loading;
  const late = [stored(0, 'report.pdf'), stored(1, 'report.pdf')];
  assert.equal(attachmentPairs([fwd(7, 1, 'report.pdf')], late), null, 'the kept report.pdf is not paired with the removed one');
  assert.equal(attachmentPairs([fwd(7, 0, 'report.pdf'), fwd(8, 1, 'report.pdf')], [...late, stored(2, 'x.pdf')]), null);
  // Every name once: paired as before.
  assert.equal(attachmentPairs([fwd(7, 1, 'report.pdf')], [stored(0, 'notes.pdf'), stored(1, 'report.pdf')]).get(7).index, 1);
});

// An editor as composer.js undoState() gives it.
const snapshot = (over = {}) => ({
  opts: { mode: 'new', id: null, accountId: null },
  original: null,
  html: '<div>One copy only.</div>',
  state: {
    accountId: 'demo',
    from: 'me@example.com',
    to: [{ name: '', address: 'someone@example.com' }],
    cc: [],
    bcc: [],
    showCc: false,
    showBcc: false,
    subject: 'Taken late',
    attachments: [{ forwardIndex: 0, filename: 'a.pdf', size: 10 }],
    include: true,
    quoted: null,
    inReplyTo: null,
    references: [],
    draftId: 'd1',
    replyToId: null,
    forwardId: 'd1',
    ...over
  }
});

// Final review of #309 (P1): an editor heard that the email it sent went after all, while it held a correction typed
// since. It closed and the correction was lost. It closes only when it holds what it sent.
test('an editor holds what it sent until text, subject, sender, recipients, attachments or the quote change', async () => {
  const { sameEmail } = await loading;
  const sent = snapshot();
  assert.equal(sameEmail(sent, snapshot()), true);
  // Where it is kept, which fields show, and where a copied attachment is read from don't change the email.
  assert.equal(sameEmail(sent, snapshot({ draftId: 'd2', forwardId: 'd2', showCc: true, attachments: [{ forwardIndex: 3, filename: 'a.pdf', size: 10 }] })), true);
  assert.equal(sameEmail(sent, { ...snapshot(), html: '<div>One copy only. Typed after it went.</div>' }), false, 'text');
  assert.equal(sameEmail(sent, snapshot({ subject: 'Taken late, corrected' })), false, 'subject');
  assert.equal(sameEmail(sent, snapshot({ from: 'alias@example.com' })), false, 'sender');
  assert.equal(sameEmail(sent, snapshot({ to: [] })), false, 'To');
  assert.equal(sameEmail(sent, snapshot({ cc: [{ name: 'Ann', address: 'ann@example.com' }] })), false, 'Cc');
  assert.equal(sameEmail(sent, snapshot({ bcc: [{ name: '', address: 'b@example.com' }] })), false, 'Bcc');
  assert.equal(sameEmail(sent, snapshot({ attachments: [] })), false, 'attachment removed');
  assert.equal(sameEmail(sent, snapshot({ attachments: [{ forwardIndex: 0, filename: 'a.pdf', size: 10 }, { path: '/tmp/b.pdf', filename: 'b.pdf', size: 5 }] })), false, 'attachment added');
  assert.equal(sameEmail(sent, snapshot({ include: false })), false, 'quote left out');
});
