'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mailto = require('../src/main/mailto');

const who = (list) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address));

test('recipients come from the address part and from to, cc and bcc', () => {
  const m = mailto.parse('mailto:a@example.com,b@example.com?to=c@example.com&cc=d@example.com,e@example.com&bcc=f@example.com');
  assert.deepEqual(who(m.to), ['a@example.com', 'b@example.com', 'c@example.com']);
  assert.deepEqual(who(m.cc), ['d@example.com', 'e@example.com']);
  assert.deepEqual(who(m.bcc), ['f@example.com']);
  assert.deepEqual(who(mailto.parse('mailto:?to=a@example.com&subject=Hello').to), ['a@example.com']);
});

test('subject and body are decoded, with a plus kept as a plus', () => {
  const m = mailto.parse('mailto:a@example.com?subject=1+1%3D2%20%E2%82%AC&body=Line%201%0D%0ALine%202');
  assert.equal(m.subject, '1+1=2 €');
  assert.equal(m.body, 'Line 1\nLine 2');
});

test('the scheme and field names are case-insensitive, and the first subject counts', () => {
  const m = mailto.parse('MAILTO:a@example.com?SUBJECT=First&Subject=Second&CC=b@example.com');
  assert.deepEqual(who(m.to), ['a@example.com']);
  assert.equal(m.subject, 'First');
  assert.deepEqual(who(m.cc), ['b@example.com']);
});

test('a malformed escape stays as it is, and the rest of the link still counts', () => {
  const m = mailto.parse('mailto:a%zz@example.com,b@example.com?subject=100%25%20sure%2&body=ok');
  assert.deepEqual(who(m.to), ['a%zz@example.com', 'b@example.com']);
  assert.equal(m.subject, '100% sure%2');
  assert.equal(m.body, 'ok');
});

test('names and quoted names with commas are kept with their address', () => {
  const m = mailto.parse('mailto:%22Doe%2C%20Jane%22%20%3Cjane@example.com%3E,Joe%20%3Cjoe@example.com%3E');
  assert.deepEqual(m.to, [
    { name: 'Doe, Jane', address: 'jane@example.com' },
    { name: 'Joe', address: 'joe@example.com' }
  ]);
});

test('attachments and other fields are ignored, and so is anything that is not a mailto: link', () => {
  const m = mailto.parse('mailto:a@example.com?attach=C:%5Csecret.txt&attachment=x&in-reply-to=%3Cx@y%3E&x-other=1');
  assert.deepEqual(m, { to: [{ name: '', address: 'a@example.com' }], cc: [], bcc: [], subject: '', body: '' });
  assert.deepEqual(mailto.parse('https://example.com/?to=a@example.com'), { to: [], cc: [], bcc: [], subject: '', body: '' });
  assert.deepEqual(mailto.parse('mailto:'), { to: [], cc: [], bcc: [], subject: '', body: '' });
});

test('a link with a fragment or hundreds of recipients stays bounded', () => {
  assert.equal(mailto.parse('mailto:a@example.com?subject=Hi#ignored').subject, 'Hi');
  const many = Array.from({ length: 150 }, (_, i) => `u${i}@example.com`).join(',');
  assert.equal(mailto.parse(`mailto:${many}`).to.length, 100);
});

test('the link Windows passes on the command line is found after the program itself', () => {
  assert.equal(mailto.fromArgs(['C:\\Rukoo Mail.exe', '--', 'mailto:a@example.com']), 'mailto:a@example.com');
  assert.equal(mailto.fromArgs(['electron.exe', '.', 'MAILTO:a@example.com']), 'MAILTO:a@example.com');
  assert.equal(mailto.fromArgs(['mailto:program-itself.exe']), null);
  assert.equal(mailto.fromArgs(['electron.exe', '.']), null);
  assert.equal(mailto.fromArgs(undefined), null);
});
