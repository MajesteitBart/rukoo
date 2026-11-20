'use strict';

// Files in team chat on this computer (src/main/workspaces/files.js, rich chat contract 3.5 and 4.6): staging,
// measuring images, uploads with progress and cancel, retries, drafts' files, downloads into the cache, the cache's
// limit and cleanup, and the rukoo-chat-file: links. The workspace routes are answered by a stand-in for svc.call, as
// the rich routes' contract gives them; the upload and download links point at a server on 127.0.0.1 that plays the
// Worker's part. The real server's side is in chat-rich.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempDir } = require('./tmp');
const { openStore, filesDir, uploadsDir } = require('../src/main/workspaces/store');
const wire = require('../src/main/workspaces/wire');
const { Files, imageInfo, typeFromName, nameOf } = require('../src/main/workspaces/files');
const { AccountError } = require('../src/main/account/client');

const { ChatError } = wire;
const id = (prefix, label) => `${prefix}_${crypto.createHash('sha256').update(label).digest('base64url').slice(0, 22)}`;
const W = id('w', 'workspace');
const C = id('c', 'general');
const ME = id('u', 'zoe');
const G = id('g', 'grant');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

async function until(check, ms = 5000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ---- images ----

function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  return Buffer.concat([b, Buffer.from('rest of the picture')]);
}

// A JPEG whose EXIF orientation turns it a quarter (6), stored as width by height.
function jpeg(width, height, orientation = 6) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(app1.length + 2, 4);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([head, app1, sof, Buffer.from([0xff, 0xd9])]);
}

test('image headers give the type and the size the picture shows as', () => {
  assert.deepEqual(imageInfo(png(640, 480)), { type: 'image/png', width: 640, height: 480 });
  assert.deepEqual(imageInfo(jpeg(400, 300)), { type: 'image/jpeg', width: 300, height: 400 });
  assert.deepEqual(imageInfo(jpeg(400, 300, 1)), { type: 'image/jpeg', width: 400, height: 300 });
  const gif = Buffer.from('GIF89a\x20\x00\x10\x00rest', 'latin1');
  assert.deepEqual(imageInfo(gif), { type: 'image/gif', width: 32, height: 16 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8X', 8, 'latin1');
  webp.writeUIntLE(99, 24, 3);
  webp.writeUIntLE(49, 27, 3);
  assert.deepEqual(imageInfo(webp), { type: 'image/webp', width: 100, height: 50 });
  assert.deepEqual(imageInfo(png(70000, 10)), { type: 'image/png', width: null, height: null });
  assert.equal(imageInfo(Buffer.from('%PDF-1.7 and more')), null);
  assert.equal(typeFromName('Plan.PDF'), 'application/pdf');
  assert.equal(typeFromName('archive.tar.unknown'), 'application/octet-stream');
  assert.equal(nameOf('C:\\files\\plan.pdf'.replace(/\\/g, path.sep)), 'plan.pdf');
  const long = `${'x'.repeat(300)}.docx`;
  assert.equal(nameOf(long), `${'x'.repeat(250)}.docx`);
});

// ---- the stand-in ----

// The Worker's links on 127.0.0.1. put: what each upload received; behave: per upload or download, what to do
// instead of answering normally.
async function linkServer(t) {
  // got: the token of each download asked for; held: what answers a download held by 'hold'.
  const state = { put: new Map(), files: new Map(), behave: new Map(), aborted: [], slow: 0, got: [], held: [] };
  const server = http.createServer(async (req, res) => {
    const [, kind, key] = req.url.split('/');
    // What this request does instead of answering normally, as many times as asked.
    const how = state.behave.get(key);
    const act = how && how.times > 0 ? (how.times--, how.act) : null;
    if (kind === 'put') {
      const chunks = [];
      let aborted = false;
      req.on('aborted', () => {
        aborted = true;
        state.aborted.push(key);
      });
      req.on('close', () => {
        if (!req.complete && !aborted) state.aborted.push(key);
      });
      try {
        for await (const chunk of req) {
          chunks.push(chunk);
          if (state.slow) await sleep(state.slow);
        }
      } catch (_) {
        // The client stopped sending.
        if (!state.aborted.includes(key)) state.aborted.push(key);
        return;
      }
      const body = Buffer.concat(chunks);
      if (act === 'fail') return reply(res, 500, { error: 'server' });
      if (act === 'expired') return reply(res, 410, { error: 'expired' });
      if (act === 'digest') return reply(res, 400, { error: 'invalid', field: 'sha256' });
      if (Number(req.headers['content-length']) !== body.length) return reply(res, 400, { error: 'invalid', field: 'size' });
      state.put.set(key, body);
      return reply(res, 200, { upload: { id: key, ready: true } });
    }
    if (kind === 'get') {
      state.got.push(key);
      if (act === 'hold') await new Promise((resolve) => state.held.push(resolve));
      if (act === 'redirect') {
        res.writeHead(302, { location: `${state.base}/get/other` });
        return res.end();
      }
      if (act === 'expired') return reply(res, 410, { error: 'expired' });
      const bytes = state.files.get(key);
      if (!bytes) return reply(res, 404, { error: 'not_found' });
      const out = act === 'corrupt' ? Buffer.concat([bytes.subarray(1), Buffer.from('!')]) : bytes;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': out.length });
      return res.end(out);
    }
    reply(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return state;
}

function reply(res, status, json) {
  const body = Buffer.from(JSON.stringify(json));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

// A service with the store, the clock, the events and the files module, whose workspace routes are answered here as
// the contract gives them: POST /uploads reserves, DELETE cancels, POST /files/{f}/download links.
async function setup(t, { capabilities = ['reactions', 'unread', 'files', 'previews'], fileBytes = 25 * 1024 * 1024, cacheMax, host = {}, origin = '' } = {}) {
  const links = await linkServer(t);
  const dir = tempDir('rukoo-chat-files-');
  const store = openStore(path.join(dir, 'data', 'chat.db'));
  store.insertWs({ id: W, name: 'Rukoo team', role: 'member', me: ME, limits: { members: 10, conversations: 10, textBytes: 16384, fileBytes } });
  store.upsertRoom(W, {
    conversation: C, kind: 'channel', name: 'general', visibility: 'workspace', archived: false, participants: null, startedBy: null, closedReason: null,
    grant: G, role: 'member', members: 2, head: 1, floor: 1, lastAt: null, read: 1, unread: 0, mentions: 0, removed: [], removedMore: false, readMark: 0
  });
  const calls = [];
  const uploads = new Map();
  const downloads = new Map();
  const answer = { reserve: [], download: [] };
  const svc = {
    store,
    epoch: 1,
    server: links.base,
    timing: { fileCacheMax: cacheMax },
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (x) => clearTimeout(x) },
    now: () => Date.now(),
    clock: () => 0,
    capabilities: () => capabilities,
    filesInfo: () => (capabilities.includes('files') ? { maxBytes: fileBytes, workspaceBytes: 1e9, origin } : null),
    events: [],
    emitChat(p) {
      svc.events.push(JSON.parse(JSON.stringify(p)));
    },
    guard(epoch) {
      if (epoch !== svc.epoch) throw Object.assign(new Error('stale'), { stale: true });
    },
    isStale: (e) => Boolean(e && e.stale),
    hookFailed(err) {
      svc.hookError = err;
    },
    host,
    async call(ws, method, route, body) {
      calls.push({ method, route, body });
      await sleep(1);
      let m = /^\/conversations\/(c_[\w-]{22})\/uploads$/.exec(route);
      if (m && method === 'POST') {
        const scripted = answer.reserve.shift();
        if (scripted) throw scripted;
        const fileId = wire.localId().replace(/^/, 'f_');
        uploads.set(fileId, { ...body, state: 'reserved' });
        const expiresAt = Date.now() + 3600 * 1000;
        return { upload: { id: fileId, expiresAt }, put: { url: `${links.base}/put/${fileId}`, expiresAt } };
      }
      m = /^\/conversations\/(c_[\w-]{22})\/uploads\/(f_[\w-]{22})$/.exec(route);
      if (m && method === 'DELETE') {
        uploads.delete(m[2]);
        return null;
      }
      m = /^\/conversations\/(c_[\w-]{22})\/files\/(f_[\w-]{22})\/download$/.exec(route);
      if (m && method === 'POST') {
        const scripted = answer.download.shift();
        if (scripted instanceof Error) throw scripted;
        const f = downloads.get(m[2]);
        if (!f) throw new AccountError('not_found', 404, 'gone');
        const token = crypto.randomBytes(6).toString('hex');
        links.files.set(token, f.bytes);
        // A behaviour goes with the next link only.
        if (f.behave) links.behave.set(token, f.behave);
        f.behave = null;
        return { url: `${scripted && scripted.url ? scripted.url : links.base}/get/${token}`, expiresAt: Date.now() + 60000, name: f.name, type: f.type, size: f.bytes.length, sha256: sha(f.bytes) };
      }
      throw new AccountError('not_found', 404, `no route ${method} ${route}`);
    }
  };
  svc.files = new Files(svc);
  t.after(() => {
    svc.files.close();
    store.close();
  });
  const pick = async (...files) => {
    host.pickFiles = async () => files;
    return svc.files.pick();
  };
  return { svc, store, links, calls, uploads, downloads, answer, dir, pick };
}

const stagedEvents = (svc) => svc.events.filter((e) => e.kind === 'staged');
const ready = (svc, stage) => until(() => svc.files.staged.get(stage) && ['ready', 'failed'].includes(svc.files.staged.get(stage).state) && svc.files.staged.get(stage), 10000, `stage ${stage}`);

function writeFile(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

// ---- staging and uploads ----

test('a picked image and PDF are measured, reserved and uploaded, with their states in staged events', async (t) => {
  const thumbs = [];
  const { svc, links, calls, uploads, pick, dir } = await setup(t, {
    host: {
      thumbnail: (file, side) => {
        thumbs.push([file, side]);
        return 'data:image/png;base64,AAAA';
      }
    }
  });
  const image = png(640, 480);
  const pdf = Buffer.from('%PDF-1.7 a small document');
  const picked = await pick(writeFile(dir, 'foto.png', image), writeFile(dir, 'plan.pdf', pdf));
  assert.deepEqual(picked.map((p) => [p.name, p.size, p.type]), [['foto.png', image.length, 'image/png'], ['plan.pdf', pdf.length, 'application/pdf']]);
  const a = await svc.files.stage(W, C, null, { path: picked[0].path });
  const b = await svc.files.stage(W, C, null, { path: picked[1].path });
  assert.equal(a.state, 'measuring');
  assert.match(a.stage, wire.patterns.LOCAL_ID);
  assert.deepEqual(Object.keys(a).sort(), ['conversation', 'error', 'expiresAt', 'file', 'height', 'loaded', 'name', 'root', 'size', 'stage', 'state', 'thumb', 'type', 'width', 'ws']);
  const one = await ready(svc, a.stage);
  const two = await ready(svc, b.stage);
  assert.deepEqual([one.state, one.width, one.height, one.type, one.thumb], ['ready', 640, 480, 'image/png', 'data:image/png;base64,AAAA']);
  assert.deepEqual([two.state, two.width, two.height, two.type, two.thumb], ['ready', null, null, 'application/pdf', null]);
  assert.match(one.file, wire.patterns.FILE_ID);
  assert.ok(one.expiresAt > Date.now());
  assert.equal(thumbs.length, 1);
  // What was reserved and sent: the declared size and digest, and exactly the bytes.
  // The two stage at the same time, and the PDF needs no measuring, so either can reserve first.
  const reserves = calls.filter((c) => c.method === 'POST' && c.route.endsWith('/uploads'));
  assert.equal(reserves.length, 2);
  const reserved = (name) => reserves.find((c) => c.body.name === name).body;
  assert.deepEqual(reserved('foto.png'), { name: 'foto.png', type: 'image/png', size: image.length, sha256: sha(image), width: 640, height: 480 });
  assert.deepEqual(reserved('plan.pdf'), { name: 'plan.pdf', type: 'application/pdf', size: pdf.length, sha256: sha(pdf) });
  assert.deepEqual(links.put.get(one.file), image);
  assert.deepEqual(links.put.get(two.file), pdf);
  assert.equal(uploads.size, 2);
  // The staged events went from measuring through uploading to ready, for the whole list.
  const states = stagedEvents(svc).map((e) => e.staged.find((s) => s.stage === a.stage)?.state).filter(Boolean);
  assert.equal(states[0], 'measuring');
  assert.ok(states.includes('uploading'));
  assert.equal(states.at(-1), 'ready');
  assert.deepEqual(stagedEvents(svc).at(-1).staged.map((s) => s.stage), [a.stage, b.stage]);
  assert.deepEqual(stagedEvents(svc).at(-1), { kind: 'staged', ws: W, conversation: C, root: null, staged: stagedEvents(svc).at(-1).staged });
  assert.deepEqual((await svc.files.list(W, C, null)).map((s) => s.state), ['ready', 'ready']);
  assert.deepEqual(await svc.files.list(W, C, id('e', 'a thread')), []);
});

test('only a path chatPickFiles answered with can be staged, and a file over the limit, an 11th file or files off are refused', async (t) => {
  const { svc, pick, dir } = await setup(t, { fileBytes: 10 });
  const big = writeFile(dir, 'big.bin', Buffer.alloc(11, 1));
  await assert.rejects(svc.files.stage(W, C, null, { path: big }), (err) => err.code === 'invalid' && err.field === 'path');
  await pick(big);
  await assert.rejects(svc.files.stage(W, C, null, { path: big }), (err) => err instanceof ChatError && err.code === 'too_large' && err.limit === 'fileBytes');
  await assert.rejects(svc.files.stage(W, C, null, { name: 'big.bin', type: null, bytes: new Uint8Array(11) }), (err) => err.code === 'too_large');
  await assert.rejects(svc.files.stage(W, C, null, { name: 'empty.txt', type: null, bytes: new Uint8Array(0) }), (err) => err.code === 'invalid' && err.field === 'size');
  for (let i = 0; i < 10; i++) await svc.files.stage(W, C, null, { name: `n${i}.txt`, type: 'text/plain', bytes: Buffer.from(`file ${i}`) });
  await assert.rejects(svc.files.stage(W, C, null, { name: 'eleven.txt', type: 'text/plain', bytes: Buffer.from('x') }), (err) => err.code === 'invalid' && err.field === 'attachments');
  // A thread has a list of its own.
  await svc.files.stage(W, C, id('e', 'root'), { name: 'eleven.txt', type: 'text/plain', bytes: Buffer.from('x') });
  const off = await setup(t, { capabilities: ['reactions'] });
  await assert.rejects(off.svc.files.stage(W, C, null, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('x') }), (err) => err.code === 'files_off');
  await assert.rejects(off.svc.files.stage(W, id('c', 'unknown'), null, { name: 'a.txt', bytes: Buffer.from('x') }), (err) => err.code === 'not_found');
});

test('pasted bytes go to a file in the profile first, and an image takes the type and turned size of its bytes', async (t) => {
  const { svc, links, store } = await setup(t);
  const bytes = jpeg(400, 300);
  const s = await svc.files.stage(W, C, null, { name: 'image.png', type: 'image/png', bytes: new Uint8Array(bytes) });
  const entry = svc.files.staged.get(s.stage);
  assert.ok(entry.path.startsWith(uploadsDir(store.file)));
  assert.deepEqual(fs.readFileSync(entry.path), bytes);
  const done = await ready(svc, s.stage);
  assert.deepEqual([done.type, done.width, done.height], ['image/jpeg', 300, 400]);
  assert.deepEqual(links.put.get(done.file), bytes);
  // Removing it takes the temporary file with it.
  svc.files.unstage(s.stage);
  await until(() => !fs.existsSync(entry.path), 2000, 'the temporary file to go');
});

test('progress goes out at most every 100 ms, and Remove cancels the upload on its way and on the server', async (t) => {
  const { svc, links, calls, uploads, pick, dir } = await setup(t);
  links.slow = 25;
  // Larger than the socket buffers of Linux and macOS together, which take a 1 MiB body whole before the server reads.
  const bytes = crypto.randomBytes(16 * 1024 * 1024);
  const [p] = await pick(writeFile(dir, 'large.bin', bytes));
  const s = await svc.files.stage(W, C, null, { path: p.path });
  // A progress event: uploading with part of the file.
  await until(
    () => stagedEvents(svc).some((e) => e.staged.some((x) => x.stage === s.stage && x.state === 'uploading' && x.loaded > 0 && x.loaded < x.size)),
    10000,
    'a progress event'
  );
  const fileId = svc.files.staged.get(s.stage).file;
  assert.ok(uploads.has(fileId));
  assert.equal(svc.files.unstage(s.stage), true);
  await until(() => links.aborted.includes(fileId), 5000, 'the server to see the upload stop');
  await until(() => calls.some((c) => c.method === 'DELETE' && c.route.endsWith(`/uploads/${fileId}`)), 2000, 'the cancel');
  assert.equal(uploads.has(fileId), false);
  assert.deepEqual(stagedEvents(svc).at(-1).staged, []);
  assert.equal(links.put.has(fileId), false);
  await sleep(150);
  assert.equal(svc.files.staged.has(s.stage), false, 'nothing brings it back');
});

test('cancelling an upload on its way closes the file it reads, and its temporary file can be deleted', async (t) => {
  const { svc, links, store } = await setup(t);
  links.slow = 25;
  // The upload's own read of the file; measuring reads it without a range.
  const real = fs.createReadStream;
  t.after(() => (fs.createReadStream = real));
  const reads = [];
  fs.createReadStream = (file, options) => {
    const stream = real(file, options);
    if (options && options.start === 0) reads.push(stream);
    return stream;
  };
  // Larger than what the sockets on the way buffer, so the upload is still reading it when Remove comes.
  const s = await svc.files.stage(W, C, null, { name: 'large.bin', type: 'application/octet-stream', bytes: crypto.randomBytes(16 * 1024 * 1024) });
  const temp = svc.files.staged.get(s.stage).path;
  assert.ok(temp.startsWith(uploadsDir(store.file)));
  await until(() => stagedEvents(svc).some((e) => e.staged.some((x) => x.stage === s.stage && x.loaded > 0 && x.loaded < x.size)), 10000, 'part of the file on its way');
  assert.equal(reads.length, 1);
  const [source] = reads;
  assert.equal(source.readableEnded, false, 'the file is still being read');
  svc.files.unstage(s.stage);
  await until(() => source.closed, 2000, 'the upload to close its file');
  assert.equal(source.readableEnded, false, 'closed, not read to the end');
  await until(() => !fs.existsSync(temp), 2000, 'the temporary file to go');
  fs.rmSync(uploadsDir(store.file), { recursive: true });
  assert.equal(fs.existsSync(uploadsDir(store.file)), false);
});

test('progress events of one upload are spaced by 100 ms', async (t) => {
  const { svc, links, pick, dir } = await setup(t);
  links.slow = 10;
  const [p] = await pick(writeFile(dir, 'large.bin', crypto.randomBytes(1536 * 1024)));
  const times = [];
  const emit = svc.emitChat;
  svc.emitChat = (e) => {
    const x = e.kind === 'staged' && e.staged[0];
    if (x && x.state === 'uploading' && x.loaded > 0 && x.loaded < x.size) times.push(Date.now());
    emit(e);
  };
  const s = await svc.files.stage(W, C, null, { path: p.path });
  await ready(svc, s.stage);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 90, `events ${times[i] - times[i - 1]} ms apart`);
});

test('a failed upload offers Retry; an expired link or a reservation that went is reserved again once by itself', async (t) => {
  const { svc, links, calls, pick, dir, answer } = await setup(t);
  const [p] = await pick(writeFile(dir, 'plan.pdf', Buffer.from('%PDF-1.7 plan')));
  // The first PUT fails with a 5xx.
  const once = (act) => {
    const real = svc.call;
    svc.call = async (...args) => {
      const out = await real(...args);
      if (out && out.put) {
        links.behave.set(out.upload.id, { act, times: 1 });
        svc.call = real;
      }
      return out;
    };
  };
  once('fail');
  const s = await svc.files.stage(W, C, null, { path: p.path });
  const failed = await ready(svc, s.stage);
  assert.deepEqual([failed.state, failed.error], ['failed', 'server']);
  const view = svc.files.retry(s.stage);
  assert.equal(view.state, 'uploading');
  assert.equal((await ready(svc, s.stage)).state, 'ready');
  assert.equal(calls.filter((c) => c.route.endsWith('/uploads')).length, 1, 'the same reservation');
  // An expired link: a new reservation, and the old one cancelled.
  once('expired');
  const e = await svc.files.stage(W, C, null, { path: p.path });
  const done = await ready(svc, e.stage);
  assert.equal(done.state, 'ready');
  assert.equal(calls.filter((c) => c.route.endsWith('/uploads')).length, 3);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
  // A reservation the server refuses: failed with its code, which the renderer words.
  answer.reserve.push(new AccountError('quota', 413, 'full', { limit: 'files' }));
  const q = await svc.files.stage(W, C, null, { path: p.path });
  const quota = await ready(svc, q.stage);
  assert.deepEqual([quota.state, quota.error], ['failed', 'quota']);
  // A file that changed since it was measured is measured again on Retry.
  once('digest');
  const d = await svc.files.stage(W, C, null, { path: p.path });
  assert.deepEqual([(await ready(svc, d.stage)).error], ['invalid']);
  fs.writeFileSync(p.path, '%PDF-1.7 plan, changed');
  svc.files.retry(d.stage);
  const again = await ready(svc, d.stage);
  assert.equal(again.state, 'ready');
  assert.equal(again.size, Buffer.byteLength('%PDF-1.7 plan, changed'));
  assert.deepEqual(links.put.get(again.file), fs.readFileSync(p.path));
});

test('sending takes ready files of the same room and root, and a draft keeps them until they expire', async (t) => {
  const { svc, store } = await setup(t);
  const s = await svc.files.stage(W, C, null, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('a') });
  const r = await ready(svc, s.stage);
  const files = svc.files.forSend(W, C, null, [r.file]);
  assert.deepEqual(files, [{ id: r.file, name: 'a.txt', type: 'text/plain', size: 1 }]);
  assert.throws(() => svc.files.forSend(W, C, id('e', 'thread'), [r.file]), (err) => err.code === 'invalid' && err.field === 'attachments');
  assert.throws(() => svc.files.forSend(W, C, null, [id('f', 'unknown')]), (err) => err.code === 'invalid' && err.field === 'attachments');
  assert.deepEqual(svc.files.forSend(W, C, null, []), []);
  svc.files.consume(W, C, null, [r.file]);
  assert.deepEqual(await svc.files.list(W, C, null), []);
  // A draft from before a restart: its unexpired files are staged again as ready, the expired go and are counted.
  const kept = { id: id('f', 'kept'), name: 'kept.png', type: 'image/png', size: 9, width: 4, height: 3, expiresAt: Date.now() + 60000 };
  const old = { id: id('f', 'old'), name: 'old.pdf', type: 'application/pdf', size: 9, expiresAt: Date.now() - 1 };
  store.putDraft(W, C, null, { text: '', mentions: [], attachments: [kept, old] });
  assert.deepEqual(svc.files.forSend(W, C, null, [kept.id]), [{ id: kept.id, name: 'kept.png', type: 'image/png', size: 9, width: 4, height: 3 }]);
  assert.throws(() => svc.files.forSend(W, C, null, [old.id]), (err) => err.field === 'attachments');
  const restored = svc.files.restore(W, C, null, [kept, old]);
  assert.deepEqual(restored, { attachments: [kept], expired: 1 });
  const list = await svc.files.list(W, C, null);
  assert.deepEqual(list.map((x) => [x.file, x.state, x.width]), [[kept.id, 'ready', 4]]);
  svc.files.restore(W, C, null, [kept]);
  assert.equal((await svc.files.list(W, C, null)).length, 1, 'restored once');
  // Removing it from the tray cancels it and the draft lets it go.
  svc.files.unstage(list[0].stage);
  assert.deepEqual(store.getDraft(W, C, null).attachments.map((f) => f.id), [old.id]);
});

test('two attaches at once never pass ten files, and the refused one leaves no bytes behind', async (t) => {
  const { svc, store } = await setup(t);
  for (let i = 0; i < 9; i++) await svc.files.stage(W, C, null, { name: `n${i}.txt`, type: 'text/plain', bytes: Buffer.from(`file ${i}`) });
  // Both pass the first count while they write their bytes.
  const both = await Promise.allSettled(['ten.txt', 'eleven.txt'].map((name) => svc.files.stage(W, C, null, { name, type: 'text/plain', bytes: Buffer.from(name) })));
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const refused = both.find((r) => r.status === 'rejected').reason;
  assert.deepEqual([refused.code, refused.field], ['invalid', 'attachments']);
  assert.equal((await svc.files.list(W, C, null)).length, 10);
  assert.equal(fs.readdirSync(uploadsDir(store.file)).length, 10, 'one file of bytes per staged entry');
});

test('restoring a draft takes a file whose upload expired out of the tray, so it can no longer be sent', async (t) => {
  const { svc, store } = await setup(t);
  const s = await svc.files.stage(W, C, null, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('a') });
  const r = await ready(svc, s.stage);
  const kept = { id: r.file, name: 'a.txt', type: 'text/plain', size: 1, expiresAt: r.expiresAt };
  store.putDraft(W, C, null, { text: '', mentions: [], attachments: [kept] });
  // Two hours later the upload has expired, and the draft is read again.
  const later = Date.now() + 2 * 3600 * 1000;
  svc.now = () => later;
  const before = stagedEvents(svc).length;
  assert.deepEqual(svc.files.restore(W, C, null, [kept]), { attachments: [], expired: 1 });
  assert.deepEqual(await svc.files.list(W, C, null), []);
  assert.ok(stagedEvents(svc).length > before);
  assert.deepEqual(stagedEvents(svc).at(-1).staged, []);
  assert.throws(() => svc.files.forSend(W, C, null, [r.file]), (err) => err.code === 'invalid' && err.field === 'attachments');
});

// ---- downloads ----

test('a download is checked, cached by its digest, viewed through a link of this session, opened as a copy and saved', async (t) => {
  const opened = [];
  const saved = [];
  const host = {
    openPath: async (file) => {
      opened.push(file);
      return '';
    },
    saveDialog: async (name) => (saved.push(name), saved.length === 1 ? path.join(tempDir('rukoo-chat-save-'), name) : null),
    askRisky: async () => 'cancel'
  };
  const { svc, store, calls, downloads } = await setup(t, { host });
  const fileId = id('f', 'photo');
  const bytes = png(10, 10);
  downloads.set(fileId, { name: 'foto.png', type: 'image/png', bytes });
  store.appendEvents(W, C, [{ seq: 1, id: id('e', 'm'), kind: 'message.posted', actor: ME, at: 1, text: '', mentions: [], attachments: [{ id: fileId, name: 'foto.png', type: 'image/png', size: bytes.length, width: 10, height: 10 }] }]);
  const { url } = await svc.files.file(W, C, fileId, 'view');
  assert.match(url, /^rukoo-chat-file:\/\/view\/[\w-]+$/);
  const hit = svc.files.serve(url);
  assert.equal(hit.type, 'image/png');
  assert.deepEqual(fs.readFileSync(hit.path), bytes);
  assert.equal(path.basename(hit.path), sha(bytes));
  assert.equal(path.dirname(hit.path), filesDir(store.file));
  assert.equal(store.getCachedFile(W, fileId).message, id('e', 'm'));
  // The second time comes from the cache.
  const before = calls.length;
  assert.equal(await svc.files.file(W, C, fileId, 'open'), true);
  assert.equal(calls.length, before);
  assert.equal(path.basename(opened[0]), 'foto.png');
  assert.notEqual(path.dirname(opened[0]), filesDir(store.file));
  assert.deepEqual(fs.readFileSync(opened[0]), bytes);
  assert.equal(await svc.files.file(W, C, fileId, 'save'), true);
  assert.equal(await svc.files.file(W, C, fileId, 'save'), false, 'Save cancelled');
  // Links of another scheme or token, or after the session ended, serve nothing.
  assert.equal(svc.files.serve('rukoo-chat-file://view/nope'), null);
  assert.equal(svc.files.serve('https://example.com/x'), null);
  svc.epoch += 1;
  assert.equal(svc.files.serve(url), null);
  svc.epoch -= 1;
  // A risky type asks first, and Cancel opens nothing.
  const risky = id('f', 'risky');
  downloads.set(risky, { name: 'setup.exe', type: 'application/octet-stream', bytes: Buffer.from('MZ') });
  assert.equal(await svc.files.file(W, C, risky, 'open'), false);
  assert.equal(opened.length, 1);
  // Anything but the viewer's image types is served as a download.
  const doc = id('f', 'doc');
  downloads.set(doc, { name: 'page.html', type: 'text/html', bytes: Buffer.from('<script>alert(1)</script>') });
  const link = await svc.files.file(W, C, doc, 'view');
  assert.equal(svc.files.serve(link.url).type, 'application/octet-stream');
});

test('a download is refused for another origin, a redirect or a wrong digest, and an expired link is asked for again once', async (t) => {
  const { svc, store, downloads, answer, calls } = await setup(t);
  const fileId = id('f', 'doc');
  const bytes = Buffer.from('the document');
  downloads.set(fileId, { name: 'doc.txt', type: 'text/plain', bytes });
  answer.download.push({ url: 'http://127.0.0.2:1' });
  await assert.rejects(svc.files.file(W, C, fileId, 'view'), (err) => err.code === 'server');
  downloads.set(fileId, { name: 'doc.txt', type: 'text/plain', bytes, behave: { act: 'redirect', times: 1 } });
  await assert.rejects(svc.files.file(W, C, fileId, 'view'), (err) => err.code === 'server');
  downloads.set(fileId, { name: 'doc.txt', type: 'text/plain', bytes, behave: { act: 'corrupt', times: 1 } });
  await assert.rejects(svc.files.file(W, C, fileId, 'view'), (err) => err.code === 'server');
  assert.equal(store.getCachedFile(W, fileId), null);
  assert.deepEqual(fs.existsSync(filesDir(store.file)) ? fs.readdirSync(filesDir(store.file)) : [], [], 'nothing is left of the failures');
  // The first link has expired by the time it is used; the second works.
  downloads.set(fileId, { name: 'doc.txt', type: 'text/plain', bytes, behave: { act: 'expired', times: 1 } });
  const n = calls.length;
  const { url } = await svc.files.file(W, C, fileId, 'view');
  assert.ok(svc.files.serve(url));
  assert.equal(calls.length - n, 2, 'two links');
  // A file the server no longer gives is not_found.
  await assert.rejects(svc.files.file(W, C, id('f', 'gone'), 'view'), (err) => err.code === 'not_found');
});

// A message of the room with one file, cached.
function withFile(store, downloads, label, seq, bytes) {
  const fileId = id('f', label);
  const message = id('e', label);
  downloads.set(fileId, { name: `${label}.png`, type: 'image/png', bytes });
  store.appendEvents(W, C, [{ seq, id: message, kind: 'message.posted', actor: ME, at: 1, text: '', mentions: [], attachments: [{ id: fileId, name: `${label}.png`, type: 'image/png', size: bytes.length }] }]);
  return { fileId, message };
}

const cacheNames = (store) => (fs.existsSync(filesDir(store.file)) ? fs.readdirSync(filesDir(store.file)) : []);

test('a file whose message is removed, or whose room gets another grant, while it downloads is not kept', async (t) => {
  const { svc, store, downloads } = await setup(t);
  const a = withFile(store, downloads, 'a', 1, png(10, 10));
  const b = withFile(store, downloads, 'b', 2, png(20, 20));
  // What happens between the server's link and the end of the download.
  let meanwhile = null;
  const call = svc.call;
  svc.call = async (...args) => {
    const out = await call(...args);
    if (out && out.sha256 && meanwhile) meanwhile();
    return out;
  };
  // The removal's cleanup runs before the download has a row to clean up.
  meanwhile = () => {
    store.addTombstones(W, [a.message]);
    store.redact(W, [a.message]);
    svc.files.onRemoved(W, C, [a.message]);
  };
  await assert.rejects(svc.files.file(W, C, a.fileId, 'view'), (err) => err.code === 'not_found');
  assert.equal(store.getCachedFile(W, a.fileId), null);
  assert.deepEqual(cacheNames(store), []);
  // Left and joined again: the grant the download started under is gone.
  meanwhile = () => store.setRoomFields(W, C, { grantId: id('g', 'again') });
  await assert.rejects(svc.files.file(W, C, b.fileId, 'view'), (err) => err.code === 'not_found');
  assert.equal(store.getCachedFile(W, b.fileId), null);
  assert.deepEqual(cacheNames(store), []);
  // Without either, it is kept.
  meanwhile = null;
  assert.ok(svc.files.serve((await svc.files.file(W, C, b.fileId, 'view')).url));
  assert.equal(store.getCachedFile(W, b.fileId).message, b.message);
});

test('the cache answers by itself only for a live cached message of the same room, and a view link only for its own file', async (t) => {
  const { svc, store, downloads, calls } = await setup(t);
  const C2 = id('c', 'plans');
  store.upsertRoom(W, {
    conversation: C2, kind: 'channel', name: 'plans', visibility: 'workspace', archived: false, participants: null, startedBy: null, closedReason: null,
    grant: id('g', 'plans'), role: 'member', members: 2, head: 1, floor: 1, lastAt: null, read: 1, unread: 0, mentions: 0, removed: [], removedMore: false, readMark: 0
  });
  // The server gives no file of general through plans.
  const call = svc.call;
  svc.call = async (ws, method, route, body) => {
    if (route.startsWith(`/conversations/${C2}/files/`)) {
      calls.push({ method, route, body });
      throw new AccountError('not_found', 404, 'not here');
    }
    return call(ws, method, route, body);
  };
  // Two files with the same bytes: one file on disk, two rows.
  const bytes = png(10, 10);
  const a = withFile(store, downloads, 'a', 1, bytes);
  const b = withFile(store, downloads, 'b', 2, bytes);
  const viewA = (await svc.files.file(W, C, a.fileId, 'view')).url;
  const viewB = (await svc.files.file(W, C, b.fileId, 'view')).url;
  assert.deepEqual(cacheNames(store), [sha(bytes)]);
  const downloadsAsked = () => calls.filter((c) => c.route.endsWith('/download')).length;
  let n = downloadsAsked();
  await svc.files.file(W, C, a.fileId, 'view');
  assert.equal(downloadsAsked(), n, 'from the cache');
  // Through another room the server is asked, and refuses.
  await assert.rejects(svc.files.file(W, C2, a.fileId, 'view'), (err) => err.code === 'not_found');
  assert.equal(downloadsAsked(), n + 1);
  // A removed message's link stops, though another row names the same bytes.
  svc.files.onRemoved(W, C, [a.message]);
  assert.equal(svc.files.serve(viewA), null);
  assert.ok(svc.files.serve(viewB));
  // A message the cache no longer holds: the server is asked again, and its bytes on disk are used.
  store.dropRoomCache(W, C);
  n = downloadsAsked();
  const again = await svc.files.file(W, C, b.fileId, 'view');
  assert.equal(downloadsAsked(), n + 1);
  assert.ok(svc.files.serve(again.url));
  assert.equal(store.getCachedFile(W, b.fileId).message, b.message, 'the row keeps the message it learned');
});

test('a cache hit whose message is removed during the disk check asks the server instead', async (t) => {
  const { svc, store, downloads, calls } = await setup(t);
  const a = withFile(store, downloads, 'a', 1, png(10, 10));
  await svc.files.file(W, C, a.fileId, 'view');
  const downloadsAsked = () => calls.filter((c) => c.route.endsWith('/download')).length;
  const n = downloadsAsked();
  // The removal lands while the cached file's size and digest are checked.
  const intact = svc.files.intact.bind(svc.files);
  let meanwhile = () => {
    store.addTombstones(W, [a.message]);
    store.redact(W, [a.message]);
    svc.files.onRemoved(W, C, [a.message]);
  };
  svc.files.intact = async (...args) => {
    const whole = await intact(...args);
    if (meanwhile) meanwhile();
    meanwhile = null;
    return whole;
  };
  await assert.rejects(svc.files.file(W, C, a.fileId, 'view'), (err) => err.code === 'not_found');
  assert.equal(downloadsAsked(), n + 1);
  assert.equal(store.getCachedFile(W, a.fileId), null);
});

test('a download whose file can no longer be written fails, and leaves no part behind', async (t) => {
  const { svc, store, downloads } = await setup(t);
  const a = withFile(store, downloads, 'a', 1, crypto.randomBytes(256 * 1024));
  // The disk is full: every write of the download's file fails.
  const real = fs.createWriteStream;
  t.after(() => (fs.createWriteStream = real));
  const full = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
  fs.createWriteStream = (file, options) => {
    const stream = real(file, options);
    stream._write = (chunk, encoding, done) => done(full());
    stream._writev = (chunks, done) => done(full());
    return stream;
  };
  await assert.rejects(svc.files.file(W, C, a.fileId, 'view'), (err) => err instanceof ChatError && err.code === 'server');
  assert.equal(store.getCachedFile(W, a.fileId), null);
  assert.deepEqual(cacheNames(store), []);
  // With room again, the same file downloads.
  fs.createWriteStream = real;
  assert.ok(svc.files.serve((await svc.files.file(W, C, a.fileId, 'view')).url));
});

test('a download whose file can not be opened fails without crashing main', async (t) => {
  const { svc, store, downloads } = await setup(t);
  const a = withFile(store, downloads, 'a', 1, png(10, 10));
  // The folder the file opens in is gone.
  const real = fs.createWriteStream;
  t.after(() => (fs.createWriteStream = real));
  fs.createWriteStream = (file, options) => real(path.join(path.dirname(file), 'gone', path.basename(file)), options);
  await assert.rejects(svc.files.file(W, C, a.fileId, 'view'), (err) => err instanceof ChatError);
  assert.equal(store.getCachedFile(W, a.fileId), null);
  assert.deepEqual(cacheNames(store), []);
});

test('signing out cancels downloads waiting for a turn and stops those running, and leaves no file of the old session', async (t) => {
  const { svc, store, downloads, links, calls } = await setup(t);
  const dir = filesDir(store.file);
  // Three downloads take every turn; the server holds their answers.
  const running = ['a', 'b', 'c'].map((label, i) => withFile(store, downloads, label, i + 1, png(10 + i, 10)));
  for (const f of running) downloads.get(f.fileId).behave = { act: 'hold', times: 1 };
  const waiting = withFile(store, downloads, 'd', 4, png(40, 40));
  const asked = () => calls.filter((c) => c.route.endsWith('/download')).length;
  const all = running.map((f) => svc.files.file(W, C, f.fileId, 'view'));
  await until(() => links.held.length === 3, 5000, 'three downloads on their way');
  all.push(svc.files.file(W, C, waiting.fileId, 'view'));
  await until(() => asked() === 4, 2000, 'the fourth link');
  await sleep(50);
  assert.equal(links.got.length, 3, 'the fourth waits for a turn');
  // Sign-out, as the service does it: the session ends, then its cache is wiped.
  svc.epoch += 1;
  svc.files.clear();
  store.wipe();
  svc.store = null;
  for (const release of links.held) release();
  const results = await Promise.allSettled(all);
  assert.deepEqual(results.map((r) => r.status === 'rejected' && r.reason.stale === true), [true, true, true, true]);
  await sleep(100);
  assert.equal(links.got.length, 3, 'the waiting download never started');
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'nothing of the old session is on disk');

  // A download that lands just after the session ended: its file goes.
  const late = await setup(t);
  const e = withFile(late.store, late.downloads, 'e', 1, png(50, 50));
  const download = late.svc.files.download.bind(late.svc.files);
  late.svc.files.download = async (...args) => {
    await download(...args);
    late.svc.epoch += 1;
  };
  await assert.rejects(late.svc.files.file(W, C, e.fileId, 'view'), (err) => err.stale === true);
  assert.deepEqual(cacheNames(late.store), []);
  assert.equal(late.store.getCachedFile(W, e.fileId), null);
});

test('the cache keeps its limit, least recently used first, and removed messages and leftovers go', async (t) => {
  const { svc, store, downloads } = await setup(t, { cacheMax: 20 });
  const put = (label, size, message) => {
    const fileId = id('f', label);
    const bytes = crypto.randomBytes(size);
    downloads.set(fileId, { name: `${label}.bin`, type: 'application/octet-stream', bytes });
    if (message) store.appendEvents(W, C, [{ seq: message, id: id('e', label), kind: 'message.posted', actor: ME, at: 1, text: '', mentions: [], attachments: [{ id: fileId, name: `${label}.bin`, type: 'application/octet-stream', size }] }]);
    return { fileId, bytes };
  };
  const a = put('a', 8, 1);
  const b = put('b', 8, 2);
  const c = put('c', 8, 3);
  await svc.files.file(W, C, a.fileId, 'view');
  await sleep(5);
  await svc.files.file(W, C, b.fileId, 'view');
  await sleep(5);
  // a is used again, so b is the least recently used when c comes.
  await svc.files.file(W, C, a.fileId, 'view');
  await sleep(5);
  await svc.files.file(W, C, c.fileId, 'view');
  const names = () => fs.readdirSync(filesDir(store.file)).sort();
  assert.deepEqual(names(), [sha(a.bytes), sha(c.bytes)].sort());
  assert.equal(store.getCachedFile(W, b.fileId), null);
  // A removed message takes its file.
  svc.files.onRemoved(W, C, [id('e', 'a')]);
  assert.deepEqual(names(), [sha(c.bytes)]);
  // Leftovers no row names go when the cache opens.
  fs.writeFileSync(path.join(filesDir(store.file), 'f'.repeat(64)), 'old');
  fs.writeFileSync(path.join(filesDir(store.file), '.half.part'), 'old');
  fs.mkdirSync(uploadsDir(store.file), { recursive: true });
  svc.files.onOpened();
  assert.deepEqual(names(), [sha(c.bytes)]);
  assert.equal(fs.existsSync(uploadsDir(store.file)), false);
  // An evicted room's rows go with it, and its files with the sweep.
  store.deleteRoom(W, C);
  svc.files.onEvicted(W, C);
  assert.deepEqual(names(), []);
});
