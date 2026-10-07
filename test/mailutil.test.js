'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('../src/main/mailutil');

test('folderRole uses special-use flags and Dutch/English names', () => {
  assert.equal(util.folderRole({ path: 'INBOX' }), 'inbox');
  assert.equal(util.folderRole({ path: '[Gmail]/Verzonden berichten', specialUse: '\\Sent' }), 'sent');
  assert.equal(util.folderRole({ path: 'Verwijderde items', name: 'Verwijderde items' }), 'trash');
  assert.equal(util.folderRole({ path: 'INBOX.Drafts', name: 'Drafts' }), 'drafts');
  assert.equal(util.folderRole({ path: 'Klanten', name: 'Klanten' }), null);
});

test('findPreviewPart prefers text/plain and skips attachments', () => {
  const structure = {
    type: 'multipart/mixed',
    childNodes: [
      {
        part: '1',
        type: 'multipart/alternative',
        childNodes: [
          { part: '1.1', type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } },
          { part: '1.2', type: 'text/html', encoding: 'base64' }
        ]
      },
      { part: '2', type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' } }
    ]
  };
  assert.equal(util.findPreviewPart(structure).part, '1.1');
  assert.equal(util.hasAttachments(structure), true);
  assert.equal(util.partKey({ type: 'text/plain' }), '1');
});

test('previewFromPart decodes quoted-printable, base64 and html', () => {
  const qp = Buffer.from('Caf=C3=A9 at 10:00 =\r\ntomorrow');
  assert.equal(util.previewFromPart(qp, { type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } }), 'Café at 10:00 tomorrow');
  // Truncated base64 (partial fetch) must not throw.
  const b64 = Buffer.from(Buffer.from('<p>Hello <b>there</b></p><style>x{}</style>').toString('base64').slice(0, 30));
  const out = util.previewFromPart(b64, { type: 'text/html', encoding: 'base64' });
  assert.match(out, /^Hello/);
  const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  assert.equal(util.previewFromPart(latin, { type: 'text/plain', encoding: '8bit', parameters: { charset: 'iso-8859-1' } }), 'café');
});

test('sanitizeHtml strips scripts, handlers and javascript urls', () => {
  const dirty = '<div onclick="x()">a<script>alert(1)</script><a href="javascript:alert(1)">l</a><iframe src="x"></iframe><img src=x onerror=alert(1)></div>';
  const clean = util.sanitizeHtml(dirty);
  assert.ok(!/script|onclick|onerror|javascript:|iframe/i.test(clean), clean);
  assert.ok(clean.includes('<a href="#">l</a>'));
});

test('textToHtml escapes and links urls', () => {
  const html = util.textToHtml('<b> see https://example.com/a?b=1.');
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(html.includes('<a href="https://example.com/a?b=1">'));
});
