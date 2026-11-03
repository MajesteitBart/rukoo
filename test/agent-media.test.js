'use strict';

// Media links (src/main/agents/media.js): GET /media/v1/<token> on a real McpServer with a local and a remote
// listener, a stub Voice that answers media.open and media.read with the synthetic media of the test Voices, and an
// injected clock. Then the same through a real AgentHub: the tool over MCP, the binding to the token the agent called
// with, and Clark's switch. A stub Voice proves Rukoo's side only; Voice's own media.open lives in voice-engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempDir } = require('./tmp');
const { McpServer } = require('../src/main/agents/mcp');
const { MediaLinks, parseRange, mediaFileName, READ_CHUNK, MAX_STREAMS } = require('../src/main/agents/media');
const { VoiceError } = require('../src/main/voice/bridge');

const M = 'm-20261030-171203-4f2a';
const TYPES = { audio: 'audio/wav', frame: 'image/jpeg', video: 'video/mp4' };

// The synthetic audio both test Voices serve for a range (RUK-110 spec 3.4): the canonical 44-byte header for
// (end - start) * 16 samples of 16 kHz mono 16-bit PCM, then sample k = (k mod 64) * 512 - 16384, little-endian.
function syntheticWav(start, end) {
  const samples = (end - start) * 16;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + samples * 2, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(samples * 2, 40);
  const body = Buffer.alloc(samples * 2);
  for (let k = 0; k < samples; k++) body.writeInt16LE((k % 64) * 512 - 16384, k * 2);
  return Buffer.concat([head, body]);
}

// 107 bytes: a JPEG's first and last bytes around zeros, as the test Voices answer a frame.
const syntheticJpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(94), Buffer.from([0xff, 0xd9])]);

// Voice's side of media.open and media.read, scripted. readyAfter: how many opens of new arguments answer ready false
// first. extra: bytes added to every new file, to change a file's size. hold(): a promise each read waits for.
class StubVoice {
  constructor() {
    this.connected = true;
    this.opens = [];
    this.reads = [];
    this.files = new Map();
    this.readyAfter = 1;
    this.extra = 0;
    this.openError = null;
    this.readHook = null;
  }

  async mediaOpen(args) {
    this.opens.push(args);
    if (!this.connected) throw new VoiceError('offline', 'Rukoo Voice is not connected.');
    if (this.openError) throw this.openError;
    const key = JSON.stringify(args);
    let f = this.files.get(key);
    if (!f) {
      const bytes = args.kind === 'frame' ? syntheticJpeg() : syntheticWav(args.start, args.end);
      f = { media: `md-${crypto.randomBytes(16).toString('base64url')}`, bytes: Buffer.concat([bytes, Buffer.alloc(this.extra)]), polls: 0 };
      this.files.set(key, f);
    }
    if (f.polls++ < this.readyAfter) return { media: f.media, ready: false };
    return { media: f.media, ready: true, type: TYPES[args.kind], size: f.bytes.length, start: args.start, end: args.end === undefined ? args.start : args.end };
  }

  async mediaRead(media, offset, length) {
    this.reads.push({ media, offset, length });
    if (this.readHook) await this.readHook(media, offset, length);
    if (!this.connected) throw new VoiceError('offline', 'Rukoo Voice is not connected.');
    const f = [...this.files.values()].find((x) => x.media === media);
    if (!f) throw new VoiceError('not_found', 'No prepared media with that id.');
    return { offset, data: f.bytes.subarray(offset, offset + length).toString('base64') };
  }
}

// A gate a test opens when it is ready: hold() waits for it.
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// A real McpServer with both listeners on loopback and a hub that has only mediaRequest. state is what the links
// ask: canRead, agentAllowed, the bindings of live tokens and the clock's skew.
async function setup(t, options = {}) {
  const voice = new StubVoice();
  const state = { canRead: true, allowed: () => true, live: new Set(), skew: 0, voiceGone: false };
  const logs = [];
  const ports = { local: null, remote: null };
  const links = new MediaLinks({
    voice: () => (state.voiceGone ? null : voice),
    canRead: () => state.canRead,
    agentAllowed: (agent, remote) => state.allowed(agent, remote),
    tokenLive: (agent, remote, bind) => state.live.has(bind),
    endpoint: (remote) => ({ host: '127.0.0.1', port: remote ? ports.remote : ports.local }),
    now: () => Date.now() + state.skew,
    log: (...a) => logs.push(a.join(' ')),
    ...options
  });
  const server = new McpServer({ hub: { identify: () => null, mediaRequest: (entry, req, res, p) => links.handle(entry, req, res, p) } });
  ports.local = await server.listen({ host: '127.0.0.1', port: 0 });
  ports.remote = await server.listen({ host: '127.0.0.1', port: 0, remote: true });
  t.after(() => server.close());
  const issue = (over = {}) => links.issue({ agent: 'claude', remote: false, peer: '127.0.0.1', tokenHash: null, meeting: M, kind: 'audio', start: 0, end: 5000, ...over });
  return { voice, state, logs, links, ports, server, issue };
}

// A GET (or HEAD) that resolves when the response is over, also when the server cut it short: complete says whether
// the whole body came.
function get(url, { method = 'GET', headers = {}, port = null, host = null } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: port || u.port, path: u.pathname, method, headers: { ...(host ? { host } : {}), ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => {});
      res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete }));
    });
    req.on('error', reject);
    req.end();
  });
}
const json = (r) => JSON.parse(r.body.toString('utf8'));
const tokenOf = (url) => /\/media\/v1\/([^/]+)\//.exec(url)[1];
// The same link on the other listener.
const onPort = (url, port) => url.replace(/:\d+\/media\//, `:${port}/media/`);

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a link serves the whole file, HEAD and one range, after Voice prepared it', async (t) => {
  const { voice, issue, logs } = await setup(t);
  const link = issue();
  assert.match(link.url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/media/v1/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}/${M}-audio-0-5\\.wav$`));
  const want = syntheticWav(0, 5000);
  const full = await get(link.url);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'audio/wav');
  assert.equal(full.headers['content-length'], String(want.length));
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['cache-control'], 'no-store');
  assert.equal(full.headers['x-content-type-options'], 'nosniff');
  assert.equal(full.headers['referrer-policy'], 'no-referrer');
  assert.equal(full.headers['content-disposition'], `attachment; filename="${M}-audio-0-5.wav"`);
  assert.ok(full.body.equals(want), 'the bytes Voice has');
  // The first media.open said "not ready", so Rukoo asked again with the same arguments.
  assert.deepEqual(voice.opens.slice(0, 2), [
    { meeting: M, kind: 'audio', start: 0, end: 5000 },
    { meeting: M, kind: 'audio', start: 0, end: 5000 }
  ]);
  // 160,044 bytes: one media.read.
  assert.deepEqual(voice.reads.map((r) => [r.offset, r.length]), [[0, want.length]]);

  const head = await get(link.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(want.length));
  assert.equal(head.body.length, 0);
  assert.equal(voice.reads.length, 1, 'HEAD reads nothing');

  const first = await get(link.url, { headers: { range: 'bytes=0-43' } });
  assert.equal(first.status, 206);
  assert.equal(first.headers['content-range'], `bytes 0-43/${want.length}`);
  assert.ok(first.body.equals(want.subarray(0, 44)));
  const tail = await get(link.url, { headers: { range: 'bytes=-10' } });
  assert.equal(tail.status, 206);
  assert.ok(tail.body.equals(want.subarray(want.length - 10)));
  const past = await get(link.url, { headers: { range: `bytes=${want.length}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers['content-range'], `bytes */${want.length}`);
  // Several ranges are ignored: everything, with 200.
  const several = await get(link.url, { headers: { range: 'bytes=0-1,4-5' } });
  assert.equal(several.status, 200);
  assert.equal(several.body.length, want.length);

  // A frame: one JPEG, named after its moment.
  const frame = issue({ kind: 'frame', start: 412000, end: null });
  assert.ok(frame.url.endsWith(`/${M}-frame-412.jpg`));
  const jpeg = await get(frame.url);
  assert.equal(jpeg.status, 200);
  assert.equal(jpeg.headers['content-type'], 'image/jpeg');
  assert.ok(jpeg.body.equals(syntheticJpeg()));
  assert.deepEqual(voice.opens.at(-1), { meeting: M, kind: 'frame', start: 412000 }, 'no end for a frame');
  for (const line of logs) assert.ok(!line.includes(tokenOf(link.url).split('.')[1]), `the token is not logged: ${line}`);
});

test('a link larger than one read comes in 1 MiB pieces, each checked', async (t) => {
  const { voice, issue } = await setup(t);
  const link = issue({ start: 0, end: 70000 });
  const want = syntheticWav(0, 70000);
  assert.ok(want.length > 2 * READ_CHUNK);
  const res = await get(link.url);
  assert.equal(res.status, 200);
  assert.ok(res.body.equals(want));
  assert.deepEqual(
    voice.reads.map((r) => [r.offset, r.length]),
    [
      [0, READ_CHUNK],
      [READ_CHUNK, READ_CHUNK],
      [2 * READ_CHUNK, want.length - 2 * READ_CHUNK]
    ]
  );
  // A piece that isn't what was asked for ends the body early: the client sees a short download.
  voice.readHook = async () => {};
  const read = voice.mediaRead.bind(voice);
  voice.mediaRead = async (media, offset, length) => (offset === READ_CHUNK ? { offset, data: 'not base64!' } : read(media, offset, length));
  const bad = await get(link.url);
  assert.equal(bad.status, 200);
  assert.equal(bad.complete, false);
  assert.ok(bad.body.length < want.length);
  voice.mediaRead = async (media, offset, length) => {
    const out = await read(media, offset, length);
    return offset === 0 ? { ...out, offset: 1 } : out;
  };
  assert.equal((await get(link.url)).complete, false, 'a piece from another offset');
});

test('a changed character in the payload or the signature is refused, and 21 bad links block the address', async (t) => {
  const { issue, links } = await setup(t);
  const link = issue();
  const token = tokenOf(link.url);
  const [body, sig] = token.split('.');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  assert.equal((await get(link.url.replace(token, `${flip(body, 5)}.${sig}`))).status, 403);
  assert.equal((await get(link.url.replace(token, `${body}.${flip(sig, 42)}`))).status, 403);
  assert.equal(links.verify(`${flip(body, 5)}.${sig}`), null);
  // Signed by another Rukoo process, such as this one before a restart: refused.
  const other = new MediaLinks({ endpoint: () => ({ host: '127.0.0.1', port: 1 }) });
  const foreign = tokenOf(other.issue({ agent: 'claude', meeting: M, kind: 'audio', start: 0, end: 5000 }).url);
  assert.equal((await get(link.url.replace(token, foreign))).status, 403);
  assert.equal(links.verify(foreign), null);
  assert.ok(links.verify(token), 'the real one verifies');
  // Three bad ones so far, 17 more pass as 403, the 21st blocks the address for five minutes.
  for (let i = 0; i < 17; i++) assert.equal((await get(link.url.replace(token, `${body}.${flip(sig, i)}`))).status, 403);
  const blocked = await get(link.url.replace(token, `${body}.${flip(sig, 30)}`));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '300');
  const after = await get(link.url);
  assert.equal(after.status, 429, 'a good link from that address too');
  assert.ok(Number(after.headers['retry-after']) > 290);
  // A path that isn't a token at all counts the same way.
  assert.equal((await get(link.url.replace(/\/media\/v1\/.*/, '/media/v1/short'))).status, 429);
});

test('an expired link answers 410, and a download that started before expiry finishes', async (t) => {
  const { voice, issue, state, links } = await setup(t, { ttlMs: 60000 });
  const link = issue({ start: 0, end: 40000 });
  const want = syntheticWav(0, 40000);
  const held = gate();
  let first = true;
  voice.readHook = async () => {
    if (!first) return;
    first = false;
    await held.promise;
  };
  const download = get(link.url);
  await until(() => voice.reads.length === 1, 'the first read');
  state.skew = 61000;
  assert.equal((await get(link.url)).status, 410);
  held.open();
  const res = await download;
  assert.equal(res.status, 200);
  assert.equal(res.complete, true);
  assert.ok(res.body.equals(want));
  assert.equal(links.streams, 0);
});

test('a link works only on the listener it was made for, and only from the address that asked for it', async (t) => {
  const { issue, ports } = await setup(t);
  const local = issue();
  const remote = issue({ agent: 'clark', remote: true, peer: '127.0.0.1' });
  assert.ok(remote.url.includes(`:${ports.remote}/`));
  assert.equal((await get(remote.url)).status, 200);
  assert.equal((await get(onPort(remote.url, ports.local))).status, 404, 'a remote link on the local listener');
  assert.equal((await get(onPort(local.url, ports.remote))).status, 404, 'a local link on the remote listener');
  // Clark asked from another address than this one.
  assert.equal((await get(issue({ agent: 'clark', remote: true, peer: '100.64.0.9' }).url)).status, 403);
  // No address known: loopback on the local listener only.
  assert.equal((await get(issue({ peer: null }).url)).status, 200);
  assert.equal((await get(issue({ agent: 'clark', remote: true, peer: null }).url)).status, 403);
});

test('a link without an address is refused from an address that is not loopback', async (t) => {
  const { links, issue } = await setup(t);
  // A server whose sockets say they come from a tailnet address.
  const spoofed = http.createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '100.64.0.5', configurable: true });
    links.handle({ remote: false }, req, res, req.url);
  });
  await new Promise((r) => spoofed.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => spoofed.close(r)));
  const port = spoofed.address().port;
  assert.equal((await get(issue({ peer: null }).url, { port })).status, 403);
  assert.equal((await get(issue({ peer: '100.64.0.5' }).url, { port })).status, 200, 'the address that asked');
});

test('"Agents can read meetings" off, the agent turned off and a token gone each refuse the link', async (t) => {
  const { issue, state, links } = await setup(t);
  const link = issue();
  state.canRead = false;
  const off = await get(link.url);
  assert.equal(off.status, 403);
  assert.equal(json(off).error, 'meetings-off');
  state.canRead = true;
  state.allowed = (agent) => agent !== 'claude';
  assert.equal(json(await get(link.url)).error, 'agent-off');
  state.allowed = () => true;
  // Bound to a token: only while it is live.
  const hash = crypto.createHash('sha256').update('a chat token').digest('hex');
  const bound = issue({ tokenHash: hash });
  assert.equal(links.verify(tokenOf(bound.url)).t, links.bindOf(hash));
  assert.equal(json(await get(bound.url)).error, 'token-gone');
  state.live.add(links.bindOf(hash));
  assert.equal((await get(bound.url)).status, 200);
});

test('Voice offline, slow, without the media or too old: the link says so', async (t) => {
  const { voice, issue, state } = await setup(t, { prepareWaitMs: 600 });
  const link = issue();
  voice.connected = false;
  const offline = await get(link.url);
  assert.equal(offline.status, 503);
  assert.equal(offline.headers['retry-after'], '10');
  state.voiceGone = true;
  assert.equal((await get(link.url)).status, 503, 'no voice service at all');
  state.voiceGone = false;
  voice.connected = true;
  voice.readyAfter = Infinity;
  const started = Date.now();
  const slow = await get(link.url);
  assert.equal(slow.status, 503);
  assert.equal(slow.headers['retry-after'], '15');
  assert.equal(json(slow).error, 'preparing');
  assert.ok(Date.now() - started < 3000, 'within the injected wait');
  assert.ok(voice.opens.length >= 2, 'it asked again while waiting');
  voice.readyAfter = 0;
  for (const [code, status] of [['not_available', 404], ['not_found', 404], ['unknown_command', 501], ['bad_request', 400], ['failed', 502], ['timeout', 503]]) {
    voice.openError = new VoiceError(code, code);
    assert.equal((await get(link.url)).status, status, code);
  }
  voice.openError = null;
  // A ready answer of the wrong type is not passed on.
  const open = voice.mediaOpen.bind(voice);
  voice.mediaOpen = async (args) => ({ ...(await open(args)), type: 'text/html' });
  assert.equal((await get(link.url)).status, 502);
});

test('Voice forgetting the file mid-download: opened again once, the same size goes on, another size is cut short', async (t) => {
  const { voice, issue } = await setup(t);
  const link = issue({ start: 0, end: 40000 });
  const want = syntheticWav(0, 40000);
  let forgot = false;
  voice.readHook = async (media, offset) => {
    if (offset > 0 && !forgot) {
      forgot = true;
      voice.files.clear();
    }
  };
  const res = await get(link.url);
  assert.equal(res.status, 200);
  assert.equal(res.complete, true);
  assert.ok(res.body.equals(want));
  assert.notEqual(voice.reads[0].media, voice.reads.at(-1).media, 'the file came back under a new id');
  assert.equal(voice.reads.at(-1).offset, READ_CHUNK, 'from the same offset');

  // Opened again, it is a different file: the body stops instead of mixing two.
  forgot = false;
  voice.readHook = async (media, offset) => {
    if (offset > 0 && !forgot) {
      forgot = true;
      voice.files.clear();
      voice.extra = 2;
    }
  };
  const cut = await get(issue({ start: 0, end: 39000 }).url);
  assert.equal(cut.status, 200);
  assert.equal(cut.complete, false);
});

test('a fourth download at once waits its turn, and a stalled one is cut at its hard end', async (t) => {
  const { voice, issue, links } = await setup(t, { ttlMs: 1000, streamMaxMs: 1000 });
  const held = gate();
  voice.readHook = () => held.promise;
  const downloads = Array.from({ length: MAX_STREAMS }, () => get(issue().url));
  await until(() => links.streams === MAX_STREAMS && voice.reads.length === MAX_STREAMS, 'three streams');
  const fourth = await get(issue().url);
  assert.equal(fourth.status, 429);
  assert.equal(fourth.headers['retry-after'], '5');
  // Nothing comes from Voice: the timer ends each response 15 minutes (here 1 s) after the link expired.
  const results = await Promise.all(downloads);
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal(r.complete, false);
  }
  await until(() => links.streams === 0, 'every stream given back');
  held.open();
});

test('turning "Agents can read meetings" off mid-download stops it after the piece under way, and so does the hard end', async (t) => {
  const { voice, issue, state } = await setup(t, { ttlMs: 60000, streamMaxMs: 1000 });
  const want = syntheticWav(0, 70000);
  let held = gate();
  voice.readHook = (media, offset) => (offset === 0 ? held.promise : undefined);
  const download = get(issue({ start: 0, end: 70000 }).url);
  await until(() => voice.reads.length === 1, 'the first read');
  state.canRead = false;
  held.open();
  const res = await download;
  assert.equal(res.status, 200);
  assert.equal(res.complete, false);
  assert.ok(res.body.length < want.length);
  assert.equal(voice.reads.length, 1, 'no piece after the switch');

  // Past x + streamMaxMs by the clock: the next piece never starts.
  state.canRead = true;
  held = gate();
  voice.reads.length = 0;
  const late = get(issue({ start: 0, end: 70000 }).url);
  await until(() => voice.reads.length === 1, 'the first read');
  state.skew = 62000;
  held.open();
  const cut = await late;
  assert.equal(cut.complete, false);
  assert.equal(voice.reads.length, 1);
});

test("mcp.js's own checks run first: an Origin or a wrong Host is refused, other methods get 405", async (t) => {
  const { issue, ports } = await setup(t);
  const link = issue();
  assert.equal((await get(link.url, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await get(link.url, { host: `evil.example:${ports.local}` })).status, 403);
  const post = await get(link.url, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal((await get(link.url.replace('/media/v1/', '/media/v2/'))).status, 403, 'not a link path');
});

test('parseRange reads one byte range and leaves the rest to a full answer', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('', 100), null);
  assert.deepEqual(parseRange('bytes=0-43', 100), { start: 0, end: 43 });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('BYTES = 1 - 2', 100), { start: 1, end: 2 });
  assert.equal(parseRange('bytes=0-1,4-5', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.equal(parseRange('bytes=-', 100), null);
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-3', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
  assert.equal(mediaFileName({ meeting: M, kind: 'video', start: 60000, end: 360000 }), `${M}-video-60-360.mp4`);
});

// ---------- through a real hub ----------

const { Engine } = require('../src/main/engine');
const { AgentHub } = require('../src/main/agents/hub');
const { VoiceService } = require('../src/main/voice');

async function freePort() {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

function rpc(port, token, name, args) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/mcp', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).result));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('over MCP: a link is bound to the token the agent called with, and Clark\'s to "Let Clark use Rukoo"', async (t) => {
  const dir = tempDir('rukoo-media-hub-');
  const engine = new Engine({ dataDir: dir }).init();
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ mcp: { port: await freePort(), remoteHost: '127.0.0.1' } }));
  const voice = new VoiceService({ dataDir: path.join(dir, 'voice'), discovery: null }).init();
  const stub = new StubVoice();
  stub.readyAfter = 0;
  Object.defineProperty(voice, 'connected', { get: () => true });
  voice.mediaOpen = (args) => stub.mediaOpen(args);
  voice.mediaRead = (...a) => stub.mediaRead(...a);
  voice.onEvent({ type: 'event', seq: 1, event: 'meeting.started', meeting: M, createdAt: Date.now(), data: { title: 'Weekly', startedAt: Date.now() - 600000, tracks: ['mic', 'call'], screen: 'off', startedBy: 'voice', context: null } });
  voice.onEvent({ type: 'event', seq: 2, event: 'meeting.state', meeting: M, createdAt: Date.now(), data: { state: 'recording', at: 0 } });
  const hub = new AgentHub({ engine, dataDir: dir, deps: { appVersion: '1.0.0', voice, tempDir: path.join(dir, 'agent-tmp') }, adapters: {} });
  await hub.start();
  t.after(async () => {
    await hub.dispose();
    voice.close();
    await engine.close();
  });
  const local = hub.mcp.ports().local;

  // A chat's token: the link names this computer's listener and the address that asked, and dies with the chat.
  const c = hub.create({ agent: 'claude', meeting: { id: M } });
  const token = hub.tokenFor(c);
  const res = await rpc(local, token, 'get_meeting_media_link', { kind: 'audio', from_seconds: 0, to_seconds: 5, conversation_id: c.id });
  assert.equal(res.isError, undefined, res.content[0].text);
  const link = res.structuredContent;
  assert.equal(link.meeting_id, M, "the chat's meeting");
  assert.ok(link.url.startsWith(`http://127.0.0.1:${local}/media/v1/`));
  const payload = hub.mediaLinks.verify(tokenOf(link.url));
  assert.equal(payload.p, '127.0.0.1');
  assert.equal(payload.r, false);
  assert.equal(payload.a, 'claude');
  assert.equal(payload.t, hub.mediaLinks.bindOf(crypto.createHash('sha256').update(token).digest('hex')));
  const got = await get(link.url);
  assert.equal(got.status, 200);
  assert.ok(got.body.equals(syntheticWav(0, 5000)));
  hub.remove(c.id);
  const gone = await get(link.url);
  assert.equal(gone.status, 403);
  assert.equal(json(gone).error, 'token-gone');

  // Clark over the remote listener (on loopback here): the link follows "Let Clark use Rukoo".
  hub.setSecret('clark', 'hermes-key');
  hub.cfg.update({ mcp: { remote: true } });
  const remotePort = await hub.mcp.listen({ host: '127.0.0.1', port: 0, remote: true });
  const remoteToken = hub.cfg.remoteToken();
  const clark = (await rpc(remotePort, remoteToken, 'get_meeting_media_link', { meeting_id: M, kind: 'audio', from_seconds: 1, to_seconds: 3 })).structuredContent;
  assert.ok(clark.url.startsWith(`http://127.0.0.1:${remotePort}/media/v1/`), clark.url);
  assert.equal(hub.mediaLinks.verify(tokenOf(clark.url)).r, true);
  assert.equal((await get(clark.url)).status, 200);
  assert.equal((await get(onPort(clark.url, local))).status, 404);
  hub.cfg.update({ mcp: { remote: false } });
  const off = await get(clark.url);
  assert.equal(off.status, 403);
  assert.equal(json(off).error, 'agent-off');
  hub.cfg.update({ mcp: { remote: true } });
  assert.equal((await get(clark.url)).status, 200);
  // A new API key replaces Clark's token: the old token's links stop.
  hub.setSecret('clark', 'another-key');
  assert.equal(json(await get(clark.url)).error, 'token-gone');
});
