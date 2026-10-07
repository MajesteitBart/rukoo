'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const dns = require('dns');
const { request, oneClickUnsubscribe, isPublicAddress } = require('../src/main/net');

test('only public addresses count as public', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', 'geen-ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('requests to private hosts are refused before connecting', async () => {
  assert.equal(await request('https://127.0.0.1/apple-touch-icon.png'), null);
  assert.equal(await request('https://localhost/apple-touch-icon.png'), null);
  assert.equal(await request('http://example.com/'), null, 'plain http is refused');
});

// A local server stands in for the internet; the test lets it through by allowing plain http and loopback.
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
  });
}
const local = (server) => ({
  transport: http,
  protocol: 'http:',
  lookup: (host, options, cb) => dns.lookup(host, options, cb),
  base: `http://127.0.0.1:${server.address().port}`
});

test('redirects are followed a few times, and a body over the limit is dropped', async () => {
  let seen = 0;
  const server = await serve((req, res) => {
    if (req.url === '/hop') return res.writeHead(302, { location: '/icon' }).end();
    if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/big') {
      res.writeHead(200);
      const chunk = Buffer.alloc(64 * 1024);
      const send = () => {
        while (seen < 4 * 1024 * 1024 && res.write(chunk)) seen += chunk.length;
        if (seen < 4 * 1024 * 1024) res.once('drain', send);
        else res.end();
      };
      res.on('close', () => {});
      return send();
    }
    res.writeHead(200, { 'content-type': 'image/png' }).end('icon');
  });
  const o = local(server);
  const hop = await request(`${o.base}/hop`, o);
  assert.equal(hop.status, 200);
  assert.equal(hop.body.toString(), 'icon');
  const loop = await request(`${o.base}/loop`, o);
  assert.equal(loop.status, 302, 'stops after a few redirects');
  assert.equal(await request(`${o.base}/big`, { ...o, maxBytes: 256 * 1024 }), null);
  assert.ok(seen < 4 * 1024 * 1024, 'the download was cut off, not read to the end');
  server.close();
});

test('one-click unsubscribe counts only a direct 2xx', async () => {
  const posts = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push({ url: req.url, method: req.method, body });
      if (req.url === '/ok') return res.writeHead(200).end('afgemeld');
      if (req.url === '/moved') return res.writeHead(302, { location: '/ok' }).end();
      res.writeHead(500).end();
    });
  });
  const o = local(server);
  assert.equal(await oneClickUnsubscribe(`${o.base}/ok`, o), true);
  assert.deepEqual(posts[0], { url: '/ok', method: 'POST', body: 'List-Unsubscribe=One-Click' });
  assert.equal(await oneClickUnsubscribe(`${o.base}/moved`, o), false, 'a redirect is not an unsubscribe');
  assert.equal(posts.filter((p) => p.url === '/ok').length, 1, 'the redirect was not followed');
  assert.equal(await oneClickUnsubscribe(`${o.base}/fail`, o), false);
  server.close();
});

test('IPv4 addresses written inside IPv6 are checked as IPv4', async () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:c0a8:1', '::7f00:1', '64:ff9b::7f00:1', 'fec0::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('::ffff:808:808'), true);
  assert.equal(await request('https://[::ffff:127.0.0.1]/'), null);
  assert.equal(await request('https://[::ffff:c0a8:1]/'), null);
});

test('a redirect body is not downloaded', { timeout: 5000 }, async () => {
  let written = 0;
  const server = await serve((req, res) => {
    if (req.url === '/icon') return res.writeHead(200).end('icon');
    res.writeHead(302, { location: '/icon' });
    const chunk = Buffer.alloc(64 * 1024);
    const send = () => {
      while (written < 8 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) return res.once('drain', send);
      }
      res.end();
    };
    send();
  });
  const o = local(server);
  const res = await request(`${o.base}/start`, { ...o, maxBytes: 1024 });
  assert.equal(res.body.toString(), 'icon');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(written < 2 * 1024 * 1024, `only a little of the redirect body went out (${written} bytes)`);
  server.closeAllConnections();
  server.close();
});

test('a server that trickles bytes is cut off at the deadline', { timeout: 5000 }, async () => {
  const server = await serve((req, res) => {
    res.writeHead(200);
    const tick = setInterval(() => res.write('x'), 10);
    res.on('close', () => clearInterval(tick));
  });
  const o = local(server);
  const started = Date.now();
  assert.equal(await request(`${o.base}/slow`, { ...o, timeout: 150 }), null);
  assert.ok(Date.now() - started < 600, 'resolved near the deadline');
  server.closeAllConnections();
  server.close();
});
