'use strict';

// The addresses the editor links while you paste or type (src/renderer/linkify.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// A browser module in a CommonJS package: Node takes it as ESM from a data: URL.
async function load() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/linkify.js'), 'utf8');
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}
const found = (list) => list.map((u) => [u.text, u.href]);

test('an address starts with https://, http:// or www.', async () => {
  const { findUrls } = await load();
  assert.deepEqual(found(findUrls('see https://rukoo.io/docs and http://a.example or www.example.com now')), [
    ['https://rukoo.io/docs', 'https://rukoo.io/docs'],
    ['http://a.example', 'http://a.example'],
    ['www.example.com', 'https://www.example.com']
  ]);
  const [url] = findUrls('go to www.example.com');
  assert.deepEqual([url.start, url.end], [6, 21]);
  assert.deepEqual(findUrls('example.com and ftp://files.example and mailto:a@b.example'), []);
  assert.deepEqual(found(findUrls('HTTPS://Rukoo.io WWW.Example.com')), [
    ['HTTPS://Rukoo.io', 'HTTPS://Rukoo.io'],
    ['WWW.Example.com', 'https://WWW.Example.com']
  ]);
});

test('an address needs a site, and never starts inside a word or another address', async () => {
  const { findUrls } = await load();
  assert.deepEqual(findUrls('https:// and www. and www.example and https://.'), []);
  assert.deepEqual(findUrls('awww.example.com demo@www.example.com'), []);
  assert.deepEqual(found(findUrls('https://a.example/?next=https://b.example/www.c.example')), [
    ['https://a.example/?next=https://b.example/www.c.example', 'https://a.example/?next=https://b.example/www.c.example']
  ]);
  assert.deepEqual(found(findUrls('https://[::1]:8080/x https://localhost:3000')), [
    ['https://[::1]:8080/x', 'https://[::1]:8080/x'],
    ['https://localhost:3000', 'https://localhost:3000']
  ]);
});

test('punctuation after an address stays out of the link', async () => {
  const { findUrls } = await load();
  const texts = (s) => findUrls(s).map((u) => u.text);
  assert.deepEqual(texts('Read https://rukoo.io/docs. Then www.example.com, or www.example.org; done'), ['https://rukoo.io/docs', 'www.example.com', 'www.example.org']);
  assert.deepEqual(texts('https://a.example: https://b.example! https://c.example?'), ['https://a.example', 'https://b.example', 'https://c.example']);
  assert.deepEqual(texts('https://a.example/?q=1&r=2. https://b.example/a.b/c.html...'), ['https://a.example/?q=1&r=2', 'https://b.example/a.b/c.html']);
  assert.deepEqual(texts(`"https://a.example" 'https://b.example', “https://c.example” ‘www.d.example’.`), ['https://a.example', 'https://b.example', 'https://c.example', 'www.d.example']);
  assert.deepEqual(texts('<https://a.example> and <a href="https://b.example">'), ['https://a.example', 'https://b.example']);
});

test('a closing bracket stays in the link only with its opening one', async () => {
  const { findUrls } = await load();
  const texts = (s) => findUrls(s).map((u) => u.text);
  assert.deepEqual(texts('(see https://rukoo.io/docs)'), ['https://rukoo.io/docs']);
  assert.deepEqual(texts('(see https://rukoo.io/docs).'), ['https://rukoo.io/docs']);
  assert.deepEqual(texts('https://en.wikipedia.org/wiki/Mail_(disambiguation)'), ['https://en.wikipedia.org/wiki/Mail_(disambiguation)']);
  assert.deepEqual(texts('(https://en.wikipedia.org/wiki/Mail_(disambiguation))'), ['https://en.wikipedia.org/wiki/Mail_(disambiguation)']);
  assert.deepEqual(texts('[www.example.com/a]'), ['www.example.com/a']);
});

test('a clipboard with one address and nothing else is a link for the selection', async () => {
  const { soleUrl } = await load();
  assert.equal(soleUrl('https://rukoo.io/docs'), 'https://rukoo.io/docs');
  assert.equal(soleUrl('  www.example.com\n'), 'https://www.example.com');
  assert.equal(soleUrl('see https://rukoo.io'), null);
  assert.equal(soleUrl('https://rukoo.io.'), null, 'a full stop makes it a sentence');
  assert.equal(soleUrl('https://a.example https://b.example'), null);
  assert.equal(soleUrl('rukoo.io'), null);
  assert.equal(soleUrl(''), null);
  assert.equal(soleUrl(null), null);
});

test('the address typed last is found in front of the caret', async () => {
  const { typedUrl } = await load();
  const at = (before) => {
    const u = typedUrl(before);
    return u && [before.slice(u.start, u.end), u.href];
  };
  assert.deepEqual(at('go to www.example.com'), ['www.example.com', 'https://www.example.com']);
  assert.deepEqual(at('https://rukoo.io/docs'), ['https://rukoo.io/docs', 'https://rukoo.io/docs']);
  assert.deepEqual(at('see www.example.com'), ['www.example.com', 'https://www.example.com'], 'the editor types no-break spaces');
  assert.deepEqual(at('It is at www.example.com.'), ['www.example.com', 'https://www.example.com']);
  assert.deepEqual(at('(see https://rukoo.io/docs),'), ['https://rukoo.io/docs', 'https://rukoo.io/docs']);
  assert.equal(at('www.example.com '), null, 'the space was typed already');
  assert.equal(at('www.example.com/a<b'), null, 'the address ended before the word did');
  assert.equal(at('just words'), null);
  assert.equal(at(''), null);
});

test('pasted text keeps its lines and spaces around the links', async () => {
  const { linkedHtml } = await load();
  assert.equal(linkedHtml('no address here'), null);
  assert.equal(linkedHtml('See https://rukoo.io/docs, then www.example.com.'), 'See <a href="https://rukoo.io/docs">https://rukoo.io/docs</a>, then <a href="https://www.example.com">www.example.com</a>.');
  assert.equal(linkedHtml('a < b & "c" https://a.example/?x=1&y=2'), 'a &lt; b &amp; &quot;c&quot; <a href="https://a.example/?x=1&amp;y=2">https://a.example/?x=1&amp;y=2</a>');
  assert.equal(
    linkedHtml('one\r\n\r\n two  wide\twww.example.com\n'),
    '<div>one</div><div><br></div><div>&nbsp;two&nbsp; wide<span style="white-space:pre">\t</span><a href="https://www.example.com">www.example.com</a></div><div><br></div>'
  );
  assert.equal(linkedHtml('www.a.example\nb', 'li'), '<li><a href="https://www.a.example">www.a.example</a></li><li>b</li>');
});

test('the Link field takes an address with or without its scheme', async () => {
  const { linkHref } = await load();
  assert.equal(linkHref(' https://rukoo.io '), 'https://rukoo.io');
  assert.equal(linkHref('http://a.example'), 'http://a.example');
  assert.equal(linkHref('mailto:demo@example.com'), 'mailto:demo@example.com');
  assert.equal(linkHref('rukoo.io/docs'), 'https://rukoo.io/docs');
  assert.equal(linkHref('www.example.com'), 'https://www.example.com');
  assert.equal(linkHref('demo@example.com'), 'mailto:demo@example.com');
  assert.equal(linkHref('javascript:alert(1)'), 'https://javascript:alert(1)');
  assert.equal(linkHref('  '), '');
});

test('a long address loses its middle', async () => {
  const { shortenUrl } = await load();
  assert.equal(shortenUrl('https://rukoo.io/docs'), 'https://rukoo.io/docs');
  const long = 'https://www.example.com/a/very/long/path/that/goes/on/and/on/report-2026.pdf';
  const short = shortenUrl(long, 44);
  assert.equal(short.length, 44);
  assert.ok(short.startsWith('https://www.example.com/a/'));
  assert.ok(short.endsWith('report-2026.pdf'));
  assert.ok(short.includes('…'));
});
