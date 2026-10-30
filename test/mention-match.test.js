'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// A browser module in a CommonJS package: Node takes it as ESM from a data: URL.
async function load() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/mention-match.js'), 'utf8');
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

test('an @ at the start of a line, after a space or an opening bracket starts a mention', async () => {
  const { mentionToken } = await load();
  assert.deepEqual(mentionToken('@'), { start: 0, query: '' });
  assert.deepEqual(mentionToken('Hi @jo'), { start: 3, query: 'jo' });
  assert.deepEqual(mentionToken('Hi\u00a0@Sanne\u00a0de'), { start: 3, query: 'Sanne de' }, 'the editor types no-break spaces');
  assert.deepEqual(mentionToken('(@bob'), { start: 1, query: 'bob' });
  assert.deepEqual(mentionToken('@sa', ''), { start: 0, query: 'sa' }, 'the start of a line');
  assert.deepEqual(mentionToken('@sa', ' '), { start: 0, query: 'sa' }, 'a space in the text node before');
});

test('an email address typed in the text is not a mention', async () => {
  const { mentionToken } = await load();
  assert.equal(mentionToken('mail demo@example.com'), null);
  assert.equal(mentionToken('demo@exa'), null);
  assert.equal(mentionToken('@sa', 'o'), null, 'a letter at the end of the text node before');
  assert.equal(mentionToken('@sanne@ex'), null);
});

test('a mention ends at two spaces, a space right after the @, a line break or a long text', async () => {
  const { mentionToken } = await load();
  assert.equal(mentionToken('@ '), null);
  assert.equal(mentionToken('@Sanne  '), null);
  assert.equal(mentionToken('@a\nb'), null);
  assert.equal(mentionToken(`@${'x'.repeat(41)}`), null);
  assert.deepEqual(mentionToken('@Sanne '), { start: 0, query: 'Sanne ' }, 'one space may lead to the next word of a name');
  assert.equal(mentionToken('no at sign'), null);
});

test('names match from the start of the name or of a later word, then the address, without accents', async () => {
  const { matchScore } = await load();
  const sanne = { name: 'Sanne de Vries', address: 'sanne@example.com' };
  assert.equal(matchScore(sanne, ''), 1);
  assert.equal(matchScore(sanne, 'san'), 4);
  assert.equal(matchScore(sanne, 'Sanne de'), 4);
  assert.equal(matchScore(sanne, 'vries'), 3);
  assert.equal(matchScore(sanne, 'de vr'), 3);
  assert.equal(matchScore(sanne, 'ries'), 0, 'not from the middle of a word');
  assert.equal(matchScore({ name: '', address: 'joris.bakker@example.com' }, 'bakk'), 2);
  assert.equal(matchScore({ name: 'Joël Smit', address: 'j@example.com' }, 'joel'), 4);
  assert.equal(matchScore(sanne, 'example'), 0, 'the domain does not count');
});

test('the thread comes first, the address book after, without duplicates or your own addresses', async () => {
  const { rankPeople } = await load();
  const thread = [
    { name: 'Joris Bakker', address: 'joris@example.com' },
    { name: 'Demo User', address: 'demo@example.com' },
    { name: '', address: 'jo@notary.example' }
  ];
  const contacts = [
    { name: 'Jolien Smit', address: 'jolien@example.com' },
    { name: 'Joris Bakker', address: 'JORIS@example.com' },
    { name: 'Jo Notary', address: 'jo@notary.example' },
    { name: 'Vandebron', address: 'support@vandebron.nl' }
  ];
  const own = ['demo@example.com'];
  const hits = rankPeople({ query: 'jo', thread, contacts, own });
  assert.deepEqual(
    hits.map((p) => [p.address, p.thread]),
    [
      ['joris@example.com', true],
      ['jo@notary.example', true],
      ['jolien@example.com', false]
    ],
    'the thread in its own order, then the address book'
  );
  assert.equal(hits[1].name, 'Jo Notary', 'a thread person without a name takes the address book name');
  const better = rankPeople({ query: 'jo', thread: [{ name: 'Anna Jonker', address: 'anna@example.com' }, { name: 'Jolanda', address: 'jolanda@example.com' }] });
  assert.deepEqual(
    better.map((p) => p.name),
    ['Jolanda', 'Anna Jonker'],
    'a match from the start of the name before one from a later word'
  );

  const bare = rankPeople({ query: '', thread, contacts, own });
  assert.deepEqual(
    bare.map((p) => p.address),
    ['joris@example.com', 'jo@notary.example'],
    'a bare @ offers the thread only, in its own order'
  );
  assert.equal(rankPeople({ query: 'demo', thread, contacts, own }).length, 0, 'never yourself');
  assert.equal(rankPeople({ query: 'x', thread: [{ name: 'X', address: 'not an address' }] }).length, 0);
  assert.equal(rankPeople({ query: '', thread: Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, address: `p${i}@example.com` })) }).length, 6);
});

test('a mention reads @ and the name, or the address without one', async () => {
  const { mentionLabel } = await load();
  assert.equal(mentionLabel({ name: 'Sanne de Vries', address: 'sanne@example.com' }), '@Sanne de Vries');
  assert.equal(mentionLabel({ name: ' ', address: 'info@example.com' }), '@info@example.com');
});
