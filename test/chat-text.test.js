'use strict';

// A team chat message's text and mentions between the composer and the wire (src/renderer/chat-text.js): the
// shared vectors in test/fixtures/chat-vectors.json through toWire, toParts and segments, trimming and line breaks,
// addresses between mentions, and the limits. The editor around it needs a DOM and is in the Electron specs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vectors = require('./fixtures/chat-vectors.json');

// A browser module in a CommonJS package: Node takes it as ESM from a data: URL, with each renderer module it
// imports turned into a data: URL of its own.
function moduleUrl(file) {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8')
    .replace(/from '\.\/([\w-]+\.js)'/g, (_, dep) => `from '${moduleUrl(dep)}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
const loading = import(moduleUrl('chat-text.js'));

// A vector's text as the composer holds it: text between the chips, and a chip { member, label } per mention.
function partsOf(c) {
  const parts = [];
  let i = 0;
  for (const m of c.utf16) {
    if (m.start > i) parts.push(c.text.slice(i, m.start));
    parts.push({ member: m.actor, label: c.text.slice(m.start, m.end) });
    i = m.end;
  }
  if (i < c.text.length) parts.push(c.text.slice(i));
  return parts;
}
const ann = 'u_TSZouSPGbcL97eX33zpRL2';
const bob = 'u_1Sw3x5RkUNDzTu7h42PrUD';

test('every mention vector goes to the wire with its UTF-8 byte ranges', async () => {
  const { toWire } = await loading;
  for (const c of vectors.mentions) {
    const wire = toWire(partsOf(c));
    if (!c.text.includes('\r')) {
      assert.deepEqual(wire, { text: c.text, mentions: c.bytes, bytes: Buffer.byteLength(c.text) }, c.name);
      continue;
    }
    // The composer's CRLF goes out as LF: each range moves back by the CRs before it.
    const text = c.text.replace(/\r\n/g, '\n');
    const crs = (bytes) => (Buffer.from(c.text).subarray(0, bytes).toString().match(/\r/g) || []).length;
    const mentions = c.bytes.map((m) => ({ actor: m.actor, start: m.start - crs(m.start), end: m.end - crs(m.end) }));
    assert.deepEqual(wire, { text, mentions, bytes: Buffer.byteLength(text) }, c.name);
    for (const m of mentions) assert.equal(Buffer.from(text).subarray(m.start, m.end).toString()[0], '@', `${c.name}: a range still covers its chip`);
  }
});

test('every mention vector comes back as the same parts, and as segments that give the text back', async () => {
  const { toParts, segments, toWire, validMentions } = await loading;
  for (const c of vectors.mentions) {
    assert.deepEqual(toParts(c.text, c.bytes), partsOf(c), `${c.name}: toParts`);
    assert.deepEqual(
      validMentions(c.text, c.bytes).map(({ actor, from, to }) => ({ actor, start: from, end: to })),
      c.utf16,
      `${c.name}: every range holds, with its UTF-16 indexes`
    );
    const me = c.bytes[0]?.actor;
    const segs = segments(c.text, c.bytes, { me });
    assert.equal(segs.map((s) => s.text).join(''), c.text, `${c.name}: segments join to the text`);
    const chips = segs.filter((s) => s.mention);
    assert.deepEqual(
      chips.map((s) => [s.mention, s.text, s.me]),
      c.utf16.map((m) => [m.actor, c.text.slice(m.start, m.end), m.actor === me]),
      `${c.name}: one segment per mention`
    );
    if (!c.text.includes('\r')) assert.deepEqual(toWire(toParts(c.text, c.bytes)), { text: c.text, mentions: c.bytes, bytes: Buffer.byteLength(c.text) }, `${c.name}: a draft round trip`);
  }
});

test('a range that breaks a wire rule is dropped and its text shows plain', async () => {
  const { segments, toParts, validMentions } = await loading;
  for (const c of vectors.badMentions) {
    const kept = validMentions(c.text, c.bytes);
    const segs = segments(c.text, c.bytes);
    assert.equal(segs.map((s) => s.text).join(''), c.text, `${c.name}: the text is all there`);
    assert.equal(toParts(c.text, c.bytes).map((p) => (typeof p === 'string' ? p : p.label)).join(''), c.text, `${c.name}: toParts keeps the text`);
    const holds = (m) => kept.some((k) => k.start === m.start && k.end === m.end && k.actor === m.actor);
    switch (c.rule) {
      case 'too_many':
        assert.equal(kept.length, 32, `${c.name}: the first 32 stay`);
        assert.ok(!holds(c.bytes[32]), `${c.name}: the 33rd goes`);
        break;
      case 'out_of_order':
      case 'overlap':
        assert.deepEqual(kept.map(({ actor, start, end }) => ({ actor, start, end })), [c.bytes[0]], `${c.name}: the later range goes`);
        break;
      default:
        assert.deepEqual(kept, [], `${c.name}: the range goes`);
        assert.ok(segs.every((s) => !s.mention), c.name);
    }
  }
  // Touching ranges hold; a text over the limit keeps no ranges.
  assert.equal(validMentions('@Ann@Bob', [{ actor: ann, start: 0, end: 4 }, { actor: bob, start: 4, end: 8 }]).length, 2);
  assert.deepEqual(validMentions(`@Ann ${'x'.repeat(16384)}`, [{ actor: ann, start: 0, end: 4 }]), []);
  assert.deepEqual(segments(null, []), [], 'a removed message has no segments');
  assert.deepEqual(validMentions('@Ann', [{ actor: ann, start: 0.5, end: 4 }, null, { actor: ann, start: '0', end: 4 }]), []);
});

test('white space at either end is trimmed before any offset is counted', async () => {
  const { toWire } = await loading;
  assert.deepEqual(toWire(['  \n Hi ', { member: ann, label: '@Ann' }, ' \n ']), { text: 'Hi @Ann', mentions: [{ actor: ann, start: 3, end: 7 }], bytes: 7 });
  assert.deepEqual(toWire([' ', ' ', { member: ann, label: '@Ann' }, ' ok ']), { text: '@Ann ok', mentions: [{ actor: ann, start: 0, end: 4 }], bytes: 7 }, 'several leading parts');
  assert.deepEqual(toWire(['  ', { member: ann, label: '@Ann' }]), { text: '@Ann', mentions: [{ actor: ann, start: 0, end: 4 }], bytes: 4 }, 'no-break spaces at the start');
  assert.deepEqual(toWire(['  \n\t ']), { text: '', mentions: [], bytes: 0 }, 'only white space is empty');
  assert.deepEqual(toWire([]), { text: '', mentions: [], bytes: 0 });
  assert.deepEqual(toWire(['a ', '', ' b']), { text: 'a  b', mentions: [], bytes: 4 }, 'white space inside stays');
  assert.deepEqual(toWire([{ member: ann, label: '@Ann' }, ' ', { member: bob, label: '@Bob' }]).mentions, [
    { actor: ann, start: 0, end: 4 },
    { actor: bob, start: 5, end: 9 }
  ]);
});

test('a no-break space becomes a space and CRLF or a lone CR becomes LF', async () => {
  const { toWire } = await loading;
  assert.equal(toWire(['a b  c']).text, 'a b  c');
  assert.deepEqual(toWire(['one\r\ntwo\rthree\n', { member: ann, label: '@Ann' }]), {
    text: 'one\ntwo\nthree\n@Ann',
    mentions: [{ actor: ann, start: 14, end: 18 }],
    bytes: 18
  });
  assert.equal(toWire(['x\ud800y']).text, 'x�y', 'a lone surrogate goes out as U+FFFD');
  assert.equal(toWire(['x\ud800y']).bytes, 5);
});

test('addresses are found between mentions and never inside one', async () => {
  const { segments } = await loading;
  const label = '@www.example.com';
  const text = `See https://rukoo.io/docs, ${label} and www.example.net.`;
  const start = Buffer.byteLength(text.slice(0, text.indexOf(label)));
  const segs = segments(text, [{ actor: ann, start, end: start + Buffer.byteLength(label) }], { me: bob });
  assert.deepEqual(segs, [
    { text: 'See ' },
    { text: 'https://rukoo.io/docs', href: 'https://rukoo.io/docs' },
    { text: ', ' },
    { text: label, mention: ann, me: false },
    { text: ' and ' },
    { text: 'www.example.net', href: 'https://www.example.net' },
    { text: '.' }
  ]);
  // An address can't run on into a mention that touches it.
  const touching = 'https://example.com@Ann';
  const at = touching.indexOf('@');
  assert.deepEqual(segments(touching, [{ actor: ann, start: at, end: at + 4 }], { me: ann }), [
    { text: 'https://example.com', href: 'https://example.com' },
    { text: '@Ann', mention: ann, me: true }
  ]);
  assert.deepEqual(segments('plain text', []), [{ text: 'plain text' }]);
});

test('mentions from someone you blocked show as plain text and never as yours', async () => {
  const { segments, mentionsMember } = await loading;
  const mentions = [{ actor: ann, start: 3, end: 7 }];
  assert.deepEqual(segments('Hi @Ann www.example.com', mentions, { me: ann, blocked: true }), [
    { text: 'Hi @Ann ' },
    { text: 'www.example.com', href: 'https://www.example.com' }
  ]);
  assert.equal(mentionsMember('Hi @Ann', mentions, ann), true);
  assert.equal(mentionsMember('Hi @Ann', mentions, ann, { blocked: true }), false);
  assert.equal(mentionsMember('Hi @Ann', mentions, bob), false);
  assert.equal(mentionsMember('Hi @Ann', [{ actor: ann, start: 3, end: 9 }], ann), false, 'an invalid range mentions nobody');
});

test('16,384 bytes fit the text limit and 16,385 do not; 32 mentions fit and 33 do not', async () => {
  const { TEXT_LIMIT, MENTION_LIMIT, byteLength, toWire, sendProblem } = await loading;
  assert.equal(TEXT_LIMIT, 16384);
  assert.equal(MENTION_LIMIT, 32);
  assert.equal(byteLength('aé王👏🏽'), 1 + 2 + 3 + 4 + 4);
  assert.equal(byteLength('\ud800'), 3, 'a lone surrogate counts as U+FFFD');
  for (const s of ['', 'abc', 'Zoë', '请 @王小明', '👨‍👩‍👧‍👦', 'a\r\nb']) assert.equal(byteLength(s), Buffer.byteLength(s), s);

  const fits = toWire(['x'.repeat(16384)]);
  assert.equal(fits.bytes, 16384);
  assert.equal(sendProblem(fits), null);
  assert.equal(sendProblem(toWire(['x'.repeat(16385)])), 'tooLong');
  assert.equal(sendProblem(toWire(['é'.repeat(8192)])), null, '8,192 two-byte characters are 16,384 bytes');
  assert.equal(sendProblem(toWire([`${'é'.repeat(8192)}x`])), 'tooLong');
  assert.equal(sendProblem(toWire(['   ', 'x'.repeat(16384), '\n\n'])), null, 'trimmed before counting');

  const chips = (n) => Array.from({ length: n }, (_, i) => [{ member: ann, label: `@A${i}` }, ' ']).flat();
  assert.equal(toWire(chips(32)).mentions.length, 32);
  assert.equal(sendProblem(toWire(chips(32))), null);
  assert.equal(sendProblem(toWire(chips(33))), 'tooManyMentions');
  assert.equal(sendProblem(toWire([' \n'])), 'empty');
});

test('Undo of Discard puts the message after a kept draft on a new line, its ranges moved by the bytes before it', async () => {
  const { appendToDraft, toWire, toParts } = await loading;
  // A draft with a non-ASCII word before its mention, so UTF-16 and byte offsets differ.
  const kept = toWire(['Één ', { member: ann, label: '@Joël' }, ' kijk even']);
  const discarded = toWire(['Over to ', { member: bob, label: '@Zoë' }, ' for review']);
  const merged = appendToDraft({ text: kept.text, mentions: kept.mentions }, discarded.text, discarded.mentions);
  assert.equal(merged.text, 'Één @Joël kijk even\nOver to @Zoë for review');
  const shift = Buffer.byteLength('Één @Joël kijk even\n');
  assert.deepEqual(merged.mentions, [
    { actor: ann, start: 6, end: 12 },
    { actor: bob, start: shift + 8, end: shift + 13 }
  ]);
  for (const m of merged.mentions) assert.equal(Buffer.from(merged.text).subarray(m.start, m.end).toString()[0], '@');
  // The same as appending the parts in the composer of an open room.
  assert.deepEqual(merged, (({ text, mentions }) => ({ text, mentions }))(toWire([...toParts(kept.text, kept.mentions), '\n', ...toParts(discarded.text, discarded.mentions)])));

  // Without a kept draft, or with an empty one, the message alone; a range of the draft that doesn't hold drops out.
  assert.deepEqual(appendToDraft(null, discarded.text, discarded.mentions), { text: discarded.text, mentions: discarded.mentions });
  assert.deepEqual(appendToDraft({ text: '', mentions: [] }, 'Hoi', []), { text: 'Hoi', mentions: [] });
  assert.deepEqual(appendToDraft({ text: 'Zoë', mentions: [{ actor: ann, start: 0, end: 3 }] }, 'Hoi', undefined), { text: 'Zoë\nHoi', mentions: [] });
});
