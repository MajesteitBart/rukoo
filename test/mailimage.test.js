'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mailImage, imageName, MAX_BYTES } = require('../src/main/mailimage');

// A 1x1 PNG and the first bytes of a GIF, a JPEG and an SVG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const dataUrl = (type, buf) => `data:${type};base64,${buf.toString('base64')}`;
const response = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers });

test('a data: image keeps its bytes and gets a name from what it is, not what it says', async () => {
  const img = await mailImage(dataUrl('image/jpeg', PNG));
  assert.equal(img.type, 'image/png');
  assert.equal(img.name, 'image.png');
  assert.deepEqual(img.content, PNG);
});

test('a data: image with percent escapes instead of base64 reads as its bytes', async () => {
  const escaped = [...GIF].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
  const img = await mailImage(`data:image/gif,${escaped}`);
  assert.equal(img.type, 'image/gif');
  assert.deepEqual(img.content, GIF);
});

test('an image on the web is fetched once, and named after its address', async () => {
  const asked = [];
  const fetch = async (url, opts) => {
    asked.push(url);
    assert.ok(opts.signal, 'the request has a deadline');
    return response(GIF);
  };
  const img = await mailImage('https://cdn.example.com/news/hero%20banner.png?w=600', { fetch });
  assert.deepEqual(asked, ['https://cdn.example.com/news/hero%20banner.png?w=600']);
  assert.equal(img.type, 'image/gif');
  assert.equal(img.name, 'hero banner.gif');
});

test('names are flattened to one safe file name', () => {
  assert.equal(imageName('https://example.com/a/..%2F..%2Fevil.exe', 'image/jpeg'), '_.._evil.jpg');
  assert.equal(imageName('https://example.com/', 'image/webp'), 'image.webp');
  assert.equal(imageName('https://example.com/%E0%A4%A', 'image/png'), 'image.png');
  assert.equal(imageName('data:image/png;base64,AAAA', 'image/png'), 'image.png');
});

test('SVG, other files and other schemes are refused', async () => {
  await assert.rejects(mailImage(dataUrl('image/svg+xml', SVG)), /can't copy or save this kind of image/);
  await assert.rejects(mailImage('data:image/svg+xml,%3Csvg%3E%3C/svg%3E'), /can't copy or save/);
  await assert.rejects(mailImage('https://example.com/x.png', { fetch: async () => response(SVG) }), /can't copy or save/);
  await assert.rejects(mailImage('file:///C:/Windows/win.ini', { fetch: async () => assert.fail('no fetch') }), /can't copy or save/);
  await assert.rejects(mailImage(42), /can't copy or save/);
});

test('a failed, refused or oversized download reads as unavailable', async () => {
  await assert.rejects(mailImage('https://example.com/x.jpg', { fetch: async () => response(JPEG, { status: 404 }) }), /couldn't get this image/);
  await assert.rejects(mailImage('https://example.com/x.jpg', { fetch: async () => { throw new TypeError('fetch failed'); } }), /couldn't get/);
  const declared = response(JPEG, { headers: { 'content-length': String(MAX_BYTES + 1) } });
  await assert.rejects(mailImage('https://example.com/x.jpg', { fetch: async () => declared }), /couldn't get/);
  // No length given: the download stops once it passes the limit.
  let sent = 0;
  const endless = new ReadableStream({
    pull(controller) {
      sent += 1024 * 1024;
      controller.enqueue(new Uint8Array(1024 * 1024).fill(0xff));
    }
  });
  await assert.rejects(mailImage('https://example.com/x.jpg', { fetch: async () => response(endless) }), /couldn't get/);
  assert.ok(sent <= MAX_BYTES + 2 * 1024 * 1024, `read ${sent} bytes`);
});

test('a slow server runs out of time', async () => {
  const fetch = (url, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(mailImage('https://example.com/x.jpg', { fetch, timeout: 30 }), /couldn't get/);
});
