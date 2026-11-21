// Team chat's files in the browser build: src/main/workspaces/files.js bundled with the web's stand-ins for what it takes
// from Node (src/web/build-options.mjs): files in memory (shims/vfs.js under shims/fs.js and fs-promises.js), SHA-256 in
// JavaScript (shims/crypto.js), Buffer's reads (shims/buffer.js), and the transfers on fetch (shims/http.js,
// shims/stream.js). Each stand-in is compared with Node's own where Node can answer, and files.js runs
// on them against a server on 127.0.0.1 that plays the Worker's links, as test/chat-files.test.js does for desktop.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { webEngineOptions } from '../../src/web/build-options.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const websiteDir = path.join(root, 'website');
const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-web-files-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

// files.js, the store and the stand-ins, bundled for the browser, as CommonJS so this process can load them.
const result = await esbuild.build({
  ...webEngineOptions({ root, websiteDir }),
  stdin: {
    contents: `module.exports = {
      files: require('./src/main/workspaces/files.js'),
      store: require('./src/main/workspaces/store.js'),
      wire: require('./src/main/workspaces/wire.js'),
      sqlite: require('./src/web/engine/sqlite.js'),
      vfs: require('./src/web/engine/shims/vfs.js'),
      fs: require('fs'),
      fsp: require('fs/promises'),
      path: require('path'),
      crypto: require('crypto'),
      stream: require('stream'),
      http: require('http'),
      Buffer
    };`,
    resolveDir: root,
    sourcefile: 'web-files-entry.js'
  },
  format: 'cjs',
  write: false,
  logLevel: 'silent'
});
fs.writeFileSync(path.join(temp, 'web-files.cjs'), result.outputFiles[0].text);
globalThis.RukooI18n = require('../../src/i18n/index.js');
const web = require(path.join(temp, 'web-files.cjs'));
const { sqlWasm } = await import('../../src/web/build-options.mjs');
await web.sqlite.init({ wasmBinary: fs.readFileSync(sqlWasm({ websiteDir }).from) });
const desktop = { files: require('../../src/main/workspaces/files.js') };
const WebBuffer = web.Buffer;

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 5000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ---- the stand-ins against Node's own ----

test('SHA-256 of the crypto stand-in is Node\'s, however the bytes are fed in', () => {
  const sizes = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 65536 + 7, 3 * 1024 * 1024 + 11];
  for (const size of sizes) {
    const bytes = crypto.randomBytes(size);
    const want = sha(bytes);
    assert.equal(web.crypto.createHash('sha256').update(bytes).digest('hex'), want, `${size} bytes at once`);
    // Random cuts, the way a file's chunks and a download's come.
    for (let round = 0; round < 3; round++) {
      const hash = web.crypto.createHash('sha256');
      for (let at = 0; at < size; ) {
        const step = Math.min(size - at, 1 + crypto.randomInt(Math.max(1, Math.min(size, 70000))));
        hash.update(bytes.subarray(at, at + step));
        at += step;
      }
      assert.equal(hash.digest('hex'), want, `${size} bytes in random pieces`);
    }
  }
  assert.equal(web.crypto.createHash('sha256').update('héllo').digest('hex'), sha(Buffer.from('héllo')));
  assert.equal(web.crypto.createHash('SHA256').update('x').digest('base64url'), crypto.createHash('sha256').update('x').digest('base64url'));
  const once = web.crypto.createHash('sha256');
  once.digest();
  assert.throws(() => once.update('more'), /Digest already called/);
  assert.throws(() => web.crypto.createHash('md5'), /not supported/);
});

test("Buffer's reads, concat and latin1 text are Node's", () => {
  const bytes = crypto.randomBytes(64);
  const ours = WebBuffer.from(bytes);
  for (let at = 0; at <= 60; at += 7) {
    assert.equal(ours.readUInt16BE(at), bytes.readUInt16BE(at));
    assert.equal(ours.readUInt16LE(at), bytes.readUInt16LE(at));
    assert.equal(ours.readUInt32BE(at), bytes.readUInt32BE(at));
    assert.equal(ours.readUInt32LE(at), bytes.readUInt32LE(at));
    assert.equal(ours.readUIntLE(at, 3), bytes.readUIntLE(at, 3));
    assert.equal(ours.toString('latin1', at, at + 4), bytes.toString('latin1', at, at + 4));
  }
  assert.throws(() => ours.readUInt32BE(61), RangeError);
  assert.throws(() => ours.readUInt16LE(-1), RangeError);
  assert.equal(ours.toString('latin1'), bytes.toString('latin1'));
  assert.equal(ours.toString('hex', 2, 6), bytes.toString('hex', 2, 6));
  assert.equal(ours.subarray(3, 9).toString('base64'), bytes.subarray(3, 9).toString('base64'));
  const parts = [WebBuffer.from('ab'), new Uint8Array([99, 100]), WebBuffer.alloc(0), WebBuffer.from('é')];
  assert.equal(WebBuffer.concat(parts).toString('utf8'), 'abcdé');
  assert.equal(WebBuffer.concat(parts, 3).toString('utf8'), 'abc');
  assert.ok(WebBuffer.concat([]) instanceof WebBuffer);
  assert.equal(WebBuffer.isBuffer(ours), true);
});

test('image headers read through the stand-ins as on desktop', () => {
  const png = (w, h) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const jpeg = (w, h, orientation) => {
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'latin1');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), Buffer.from('Exif\0\0', 'latin1'), tiff]);
    app1.writeUInt16BE(app1.length - 2, 2);
    const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3]);
    sof.writeUInt16BE(h, 5);
    sof.writeUInt16BE(w, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(12)]);
  };
  const webp = (chunk) => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'latin1');
    b.write(`WEBP${chunk}`, 8, 'latin1');
    if (chunk === 'VP8X') {
      b.writeUIntLE(99, 24, 3);
      b.writeUIntLE(49, 27, 3);
    } else if (chunk === 'VP8 ') {
      b.writeUInt16LE(321, 26);
      b.writeUInt16LE(123, 28);
    } else {
      b[20] = 0x2f;
      b[21] = 0x3f;
      b[22] = 0x81;
      b[23] = 0x12;
      b[24] = 0x05;
    }
    return b;
  };
  const cases = [png(640, 480), png(70000, 10), jpeg(400, 300, 6), jpeg(400, 300, 1), Buffer.from('GIF89a\x20\x00\x10\x00rest', 'latin1'), webp('VP8X'), webp('VP8 '), webp('VP8L'), Buffer.from('%PDF-1.7 and more')];
  for (const head of cases) assert.deepEqual(web.files.imageInfo(WebBuffer.from(head)), desktop.files.imageInfo(head), head.subarray(0, 12).toString('latin1'));
  assert.deepEqual(web.files.imageInfo(WebBuffer.from(jpeg(400, 300, 6))), { type: 'image/jpeg', width: 300, height: 400 });
  // The names files.js derives types and names from.
  for (const name of ['plan.PDF', 'a.tar.gz', '.bashrc', 'noext', 'dir.d/file', 'trailing.', 'x/y.PNG']) {
    assert.equal(web.path.extname(name), path.posix.extname(name), name);
    assert.equal(web.files.typeFromName(name), desktop.files.typeFromName(name), name);
    assert.equal(web.files.nameOf(name), desktop.files.nameOf(name), name);
  }
});

test('the memory files: what files.js writes, streams, renames and deletes', async () => {
  const { fs: wfs, fsp, vfs } = web;
  const dir = 'rukoo-web/test-memory';
  await fsp.mkdir(`${dir}/chat-uploads`, { recursive: true });
  assert.equal(wfs.existsSync(`${dir}/chat-uploads`), true);
  assert.deepEqual(wfs.readdirSync(dir), ['chat-uploads']);
  const bytes = crypto.randomBytes(3 * 1024 * 1024 + 5);
  await fsp.writeFile(`${dir}/chat-uploads/a`, new Uint8Array(bytes));
  const stat = await fsp.stat(`${dir}/chat-uploads/a`);
  assert.equal(stat.size, bytes.length);
  assert.equal(stat.isFile(), true);
  assert.equal((await fsp.stat(dir)).isDirectory(), true);
  await assert.rejects(fsp.stat(`${dir}/nothing`), (err) => err.code === 'ENOENT');

  // A read stream: the whole file in chunks, or a range with an inclusive end, as Node's.
  const chunks = [];
  for await (const chunk of wfs.createReadStream(`${dir}/chat-uploads/a`)) chunks.push(chunk);
  assert.ok(chunks.length > 1 && chunks.every((c) => c instanceof WebBuffer));
  assert.ok(Buffer.concat(chunks).equals(bytes));
  const part = [];
  for await (const chunk of wfs.createReadStream(`${dir}/chat-uploads/a`, { start: 10, end: 19 })) part.push(chunk);
  assert.ok(Buffer.concat(part).equals(bytes.subarray(10, 20)));
  await assert.rejects(async () => {
    for await (const _ of wfs.createReadStream(`${dir}/missing`));
  }, (err) => err.code === 'ENOENT');
  const missing = wfs.createReadStream(`${dir}/missing`);
  const failed = await new Promise((resolve) => missing.on('error', resolve));
  assert.equal(failed.code, 'ENOENT');

  // The header read, a copy that shares the bytes, a rename, a temporary folder.
  const handle = await fsp.open(`${dir}/chat-uploads/a`, 'r');
  const head = WebBuffer.alloc(16);
  assert.equal((await handle.read(head, 0, 16, 0)).bytesRead, 16);
  await handle.close();
  assert.ok(Buffer.from(head).equals(bytes.subarray(0, 16)));
  await fsp.copyFile(`${dir}/chat-uploads/a`, `${dir}/copy`);
  await fsp.rename(`${dir}/copy`, `${dir}/moved`);
  assert.equal(wfs.existsSync(`${dir}/copy`), false);
  assert.ok((await fsp.readFile(`${dir}/moved`)).subarray(0, 32).every((b, i) => b === bytes[i]));
  const tmp = await fsp.mkdtemp('/tmp/rukoo-chat-');
  assert.match(tmp, /^\/tmp\/rukoo-chat-[A-Za-z0-9]{6}$/);
  assert.equal(wfs.existsSync(tmp), true);

  // A write stream exists once ended, and not at all once destroyed, which closes it.
  const out = wfs.createWriteStream(`${dir}/.x.part`);
  out.write(WebBuffer.from('half'));
  assert.equal(wfs.existsSync(`${dir}/.x.part`), false);
  await new Promise((resolve) => {
    out.once('close', resolve);
    out.end();
  });
  assert.equal(String(await fsp.readFile(`${dir}/.x.part`, 'utf8')), 'half');
  const gone = wfs.createWriteStream(`${dir}/.y.part`);
  gone.write(WebBuffer.from('never'));
  await new Promise((resolve) => (gone.once('close', resolve), gone.destroy()));
  assert.equal(gone.closed, true);
  assert.equal(wfs.existsSync(`${dir}/.y.part`), false);

  // Removal: a folder with what is in it, and a watcher hears each file go.
  const removed = [];
  const stop = vfs.watch((e) => e.type === 'remove' && removed.push(e.path));
  wfs.rmSync(`${dir}/chat-uploads`, { recursive: true, force: true });
  stop();
  assert.deepEqual(removed, [`${dir}/chat-uploads/a`]);
  assert.equal(wfs.existsSync(`${dir}/chat-uploads`), false);
  assert.throws(() => wfs.rmSync(`${dir}/chat-uploads`), (err) => err.code === 'ENOENT');
  wfs.rmSync(`${dir}/chat-uploads`, { force: true });
  wfs.rmSync(dir, { recursive: true, force: true });
  wfs.rmSync(tmp, { recursive: true, force: true });
  // The chat cache's own files are never here: store.js and the service see none (sqlite.js keeps them).
  assert.equal(wfs.existsSync('rukoo-web/chat.db'), false);
});

test('a pipeline ends its streams once, on success and on an error of any of them', async () => {
  const { stream, fs: wfs, fsp } = web;
  await fsp.writeFile('rukoo-web/pipe/src', new Uint8Array(crypto.randomBytes(2 * 1024 * 1024)));
  let seen = 0;
  const meter = new stream.Transform({
    transform(chunk, _e, done) {
      seen += chunk.length;
      done(null, chunk);
    }
  });
  const calls = [];
  await new Promise((resolve) => stream.pipeline(wfs.createReadStream('rukoo-web/pipe/src'), meter, wfs.createWriteStream('rukoo-web/pipe/dst'), (err) => (calls.push(err), resolve())));
  assert.deepEqual(calls, [undefined]);
  assert.equal(seen, 2 * 1024 * 1024);
  assert.equal((await fsp.stat('rukoo-web/pipe/dst')).size, seen);

  const refuse = new stream.Transform({ transform: (_c, _e, done) => done(new Error('too long')) });
  const sink = wfs.createWriteStream('rukoo-web/pipe/never');
  const errors = [];
  await new Promise((resolve) => stream.pipeline(wfs.createReadStream('rukoo-web/pipe/src'), refuse, sink, (err) => (errors.push(err), resolve())));
  await sleep(5);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'too long');
  assert.equal(sink.closed, true, 'the destination closed');
  assert.equal(wfs.existsSync('rukoo-web/pipe/never'), false);
  wfs.rmSync('rukoo-web/pipe', { recursive: true, force: true });
});

// ---- files.js on the stand-ins ----

// The Worker's links on 127.0.0.1, as test/chat-files.test.js has them. behave: per upload or download what to do
// instead of answering normally, once.
// target: the requests that reached a redirect's target, with their bodies. huge: what the server wrote of a too long
// answer before the other side closed.
async function linkServer(t) {
  const state = { put: new Map(), headers: new Map(), files: new Map(), behave: new Map(), target: [], huge: null };
  const server = http.createServer(async (req, res) => {
    const [, kind, key] = req.url.split('/');
    const act = state.behave.get(key);
    state.behave.delete(key);
    if (kind === 'target') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      state.target.push({ method: req.method, key, bytes: Buffer.concat(chunks) });
      return reply(res, 200, { upload: { id: key, ready: true } });
    }
    if (kind === 'put') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      state.headers.set(key, req.headers);
      if (act === 'expired') return reply(res, 410, { error: 'expired' }, { 'retry-after': '3' });
      // A redirect of the PUT to another address of this server that keeps the method and body (307 and 308).
      if (act === '307' || act === '308') {
        res.writeHead(Number(act), { location: `${state.base}/target/${key}`, 'content-length': 0 });
        return res.end();
      }
      // An answer of 64 MiB, written as fast as the other side reads it, until it closes.
      if (act === 'huge') {
        const huge = (state.huge = { written: 0, closed: false });
        res.on('close', () => (huge.closed = true));
        res.writeHead(200, { 'content-type': 'application/json' });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        const drained = () =>
          new Promise((resolve) => {
            const go = () => {
              res.off('drain', go);
              res.off('close', go);
              resolve();
            };
            res.on('drain', go);
            res.on('close', go);
          });
        while (huge.written < 64 * 1024 * 1024 && !huge.closed) {
          huge.written += chunk.length;
          if (!res.write(chunk)) await drained();
        }
        return res.end();
      }
      if (act === 'slow') await sleep(400);
      if (Number(req.headers['content-length']) !== body.length) return reply(res, 400, { error: 'invalid', field: 'size' });
      state.put.set(key, body);
      return reply(res, 200, { upload: { id: key, ready: true } });
    }
    if (kind === 'get') {
      if (act === 'redirect') {
        res.writeHead(302, { location: `${state.base}/get/other` });
        return res.end();
      }
      if (act === 'expired') return reply(res, 410, { error: 'expired' });
      if (act === 'hold') return void state.held.push(res);
      const bytes = state.files.get(key);
      if (!bytes) return reply(res, 404, { error: 'not_found' });
      const out = act === 'corrupt' ? Buffer.concat([bytes.subarray(1), Buffer.from('!')]) : bytes;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': out.length });
      return res.end(out);
    }
    reply(res, 404, { error: 'not_found' });
  });
  state.held = [];
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    for (const r of state.held) r.destroy();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return state;
}

function reply(res, status, json, headers = {}) {
  const body = Buffer.from(JSON.stringify(json));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers });
  res.end(body);
}

const W = `w_${'W'.repeat(22)}`;
const C = `c_${'C'.repeat(22)}`;
const G = `g_${'G'.repeat(22)}`;
const ME = `u_${'M'.repeat(22)}`;
let rooms = 0;

// A service as files.js sees it (test/chat-files.test.js setup), over the web store in memory and the memory files.
async function setup(t, { host = {} } = {}) {
  const links = await linkServer(t);
  const dir = `rukoo-web/files-${++rooms}`;
  const store = web.store.openStore(`${dir}/chat.db`);
  store.insertWs({ id: W, name: 'Acme', role: 'member', me: ME, limits: { fileBytes: 25 * 1024 * 1024 } });
  store.upsertRoom(W, { conversation: C, kind: 'channel', name: 'general', visibility: 'workspace', archived: false, grant: G, role: 'member', members: 2, head: 1, floor: 1, lastAt: null, read: 1, unread: 0, mentions: 0, readMark: 0 });
  const calls = [];
  const downloads = new Map();
  // download: what the next download links do instead of answering normally; expireNext: the next upload's link
  // answers 410 expired once; put: what the next upload links do instead (linkServer).
  const answer = { download: [], expireNext: false, put: [] };
  const svc = {
    store,
    epoch: 1,
    server: links.base,
    timing: {},
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (x) => clearTimeout(x) },
    now: () => Date.now(),
    clock: () => 0,
    capabilities: () => ['files'],
    filesInfo: () => ({ maxBytes: 25 * 1024 * 1024, workspaceBytes: 1e9, origin: '' }),
    events: [],
    emitChat: (p) => svc.events.push(JSON.parse(JSON.stringify(p))),
    guard(epoch) {
      if (epoch !== svc.epoch) throw Object.assign(new Error('stale'), { stale: true });
    },
    isStale: (e) => Boolean(e && e.stale),
    hookFailed: (err) => (svc.hookError = err),
    host,
    async call(ws, method, route, body) {
      calls.push({ method, route, body });
      if (method === 'POST' && route.endsWith('/uploads')) {
        const id = `f_${web.wire.localId()}`;
        if (answer.expireNext) {
          answer.expireNext = false;
          links.behave.set(id, 'expired');
        }
        const act = answer.put.shift();
        if (act) links.behave.set(id, act);
        return { upload: { id, expiresAt: Date.now() + 3600000 }, put: { url: `${links.base}/put/${id}`, expiresAt: Date.now() + 3600000 } };
      }
      if (method === 'DELETE') return null;
      const m = /\/files\/(f_[\w-]{22})\/download$/.exec(route);
      if (m) {
        const f = downloads.get(m[1]);
        if (!f) throw Object.assign(new Error('gone'), { code: 'not_found', status: 404 });
        const token = crypto.randomBytes(6).toString('hex');
        links.files.set(token, f.bytes);
        const act = answer.download.shift();
        if (act) links.behave.set(token, act);
        return { url: `${links.base}/get/${token}`, expiresAt: Date.now() + 60000, name: f.name, type: f.type, size: f.bytes.length, sha256: sha(f.bytes) };
      }
      throw new Error(`no route ${method} ${route}`);
    }
  };
  svc.files = new web.files.Files(svc);
  t.after(() => {
    svc.files.close();
    store.wipe();
  });
  const ready = (stage) => until(() => ['ready', 'failed'].includes(svc.files.staged.get(stage)?.state) && svc.files.staged.get(stage), 10000, `stage ${stage}`);
  return { svc, store, links, calls, downloads, answer, dir, ready };
}

// A cached message of the room with these files, so a download is kept.
function holding(store, files) {
  store.appendEvents(W, C, [{ seq: 1, id: `e_${'E'.repeat(22)}`, kind: 'message.posted', actor: ME, at: 1, text: 'files', mentions: [], attachments: files }]);
}

test('files.js stages bytes, measures, reserves and uploads them over fetch, and downloads into the memory cache', async (t) => {
  const thumbs = [];
  const { svc, links, calls, downloads, store, dir, ready } = await setup(t, { host: { thumbnail: async (file, side) => (thumbs.push([file, side]), 'data:image/png;base64,AAAA') } });
  const image = (() => {
    const b = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(320, 16);
    b.writeUInt32BE(200, 20);
    return Buffer.concat([b, crypto.randomBytes(200 * 1024)]);
  })();
  const staged = await svc.files.stage(W, C, null, { name: 'plan.png', type: 'image/png', bytes: new Uint8Array(image) });
  assert.equal(staged.state, 'measuring');
  // The bytes went to the memory files, under the cache's chat-uploads/.
  assert.ok(web.fs.readdirSync(`${dir}/chat-uploads`).length === 1);
  const done = await ready(staged.stage);
  assert.equal(done.state, 'ready', done.error);
  assert.deepEqual([done.width, done.height, done.thumb], [320, 200, 'data:image/png;base64,AAAA']);
  assert.match(thumbs[0][0], new RegExp(`^${dir}/chat-uploads/[0-9a-f]{32}$`));
  const reserve = calls.find((c) => c.method === 'POST' && c.route.endsWith('/uploads'));
  assert.deepEqual(reserve.body, { name: 'plan.png', type: 'image/png', size: image.length, sha256: sha(image), width: 320, height: 200 });
  assert.ok(links.put.get(done.file).equals(image), 'the server got exactly the bytes');
  // fetch sets the length itself; the headers a page can't set were left out.
  const headers = links.headers.get(done.file);
  assert.equal(Number(headers['content-length']), image.length);
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  // Progress went out as the upload went.
  const states = svc.events.filter((e) => e.kind === 'staged').map((e) => e.staged[0]?.state);
  assert.ok(states.includes('uploading') && states.at(-1) === 'ready', states.join(' '));
  // Unstaged after the send: its bytes in memory go.
  svc.files.consume(W, C, null, [done.file]);
  await until(() => web.fs.readdirSync(`${dir}/chat-uploads`).length === 0, 2000, 'the staged bytes to go');

  // A download: checked, cached under its digest, and a view link that serve() answers with the memory file.
  const report = crypto.randomBytes(100 * 1024);
  const file = `f_${'R'.repeat(22)}`;
  downloads.set(file, { name: 'report.pdf', type: 'application/pdf', bytes: report });
  holding(store, [{ id: file, name: 'report.pdf', type: 'application/pdf', size: report.length }]);
  const view = await svc.files.file(W, C, file, 'view');
  assert.match(view.url, /^rukoo-chat-file:\/\/view\/[A-Za-z0-9_-]+$/);
  const served = svc.files.serve(view.url);
  assert.deepEqual({ ...served, path: undefined }, { path: undefined, type: 'application/octet-stream', name: 'report.pdf' });
  assert.equal(served.path, `${dir}/chat-files/${sha(report)}`);
  assert.ok(Buffer.from(await web.fsp.readFile(served.path)).equals(report));
  // A second view comes from the cache, without a request.
  const before = calls.length;
  await svc.files.file(W, C, file, 'view');
  assert.equal(calls.length, before);

  // Save: the host's place gets a copy (the page downloads it from there, src/web/files.js).
  let saved = null;
  svc.host.saveDialog = async (name) => `rukoo-web/downloads/x/${name}`;
  const stop = web.vfs.watch((e) => e.type === 'put' && e.path.startsWith('rukoo-web/downloads/') && (saved = e));
  assert.equal(await svc.files.file(W, C, file, 'save'), true);
  stop();
  assert.equal(saved.path, 'rukoo-web/downloads/x/report.pdf');
  assert.ok(Buffer.from(await saved.blob.arrayBuffer()).equals(report));
});

test("files.js on fetch: an expired link is reserved again, a redirect and a wrong digest are refused, and a session's end stops a download", async (t) => {
  const { svc, links, calls, downloads, store, dir, ready, answer } = await setup(t);
  // The upload link expired (410 with the server's error and Retry-After): files.js cancels that reservation, reserves
  // once more and sends again.
  const bytes = crypto.randomBytes(5000);
  answer.expireNext = true;
  const staged = await svc.files.stage(W, C, null, { name: 'notes.txt', type: 'text/plain', bytes: new Uint8Array(bytes) });
  const done = await ready(staged.stage);
  assert.equal(done.state, 'ready', done.error);
  const reserves = calls.filter((c) => c.method === 'POST' && c.route.endsWith('/uploads'));
  assert.equal(reserves.length, 2, 'reserved again after the 410');
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1, 'the expired reservation was cancelled');
  assert.ok(links.put.get(done.file).equals(bytes));
  assert.equal(links.put.size, 1);

  const file = `f_${'D'.repeat(22)}`;
  const good = crypto.randomBytes(30000);
  downloads.set(file, { name: 'd.bin', type: 'application/octet-stream', bytes: good });
  holding(store, [{ id: file, name: 'd.bin', type: 'application/octet-stream', size: good.length }]);
  // A redirect is refused.
  answer.download.push('redirect');
  await assert.rejects(svc.files.file(W, C, file, 'view'), (err) => err.code === 'server' || err.code === 'network');
  // A wrong digest is refused, and leaves no part behind.
  answer.download.push('corrupt');
  await assert.rejects(svc.files.file(W, C, file, 'view'), (err) => err.code === 'server');
  assert.deepEqual((web.fs.existsSync(`${dir}/chat-files`) ? web.fs.readdirSync(`${dir}/chat-files`) : []).filter((n) => n.endsWith('.part')), []);
  // An expired download link is asked for again once.
  answer.download.push('expired');
  const view = await svc.files.file(W, C, file, 'view');
  assert.ok(svc.files.serve(view.url));
  // A download running when the session ends stops, and leaves no part.
  const other = `f_${'H'.repeat(22)}`;
  downloads.set(other, { name: 'h.bin', type: 'application/octet-stream', bytes: crypto.randomBytes(1000) });
  answer.download.push('hold');
  const running = svc.files.file(W, C, other, 'view');
  await until(() => links.held.length === 1, 3000, 'the held download');
  // The session ends, as the service ends it: a new epoch, then the files module lets go.
  svc.epoch += 1;
  svc.files.clear();
  await assert.rejects(running, (err) => err.stale === true);
  await sleep(20);
  assert.deepEqual(web.fs.readdirSync(`${dir}/chat-files`).filter((n) => n.endsWith('.part')), []);
});

// XMLHttpRequest as a browser has it, over Node's fetch: it follows a redirect by itself, a 307 or 308 with the same
// method and body, and reads all of the answer before onload. A page has it, so the tests below put it in place, and
// an upload must not go through it.
function browserXhr(record) {
  return class BrowserXMLHttpRequest {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.responseURL = '';
      record.push(this);
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    getAllResponseHeaders() {
      return Object.entries(this.responseHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    }
    abort() {
      this.aborted = true;
    }
    async send(body) {
      const bytes = Buffer.from(await body.arrayBuffer());
      this.upload.onprogress?.({ loaded: bytes.length, total: bytes.length });
      const res = await fetch(this.url, { method: this.method, headers: this.headers, body: bytes, redirect: 'follow' });
      this.status = res.status;
      this.responseURL = res.url;
      this.responseHeaders = Object.fromEntries(res.headers);
      this.response = await res.arrayBuffer();
      this.onload?.();
    }
  };
}

test('an upload goes with fetch: only headers a page may set, and the tray counts the bytes once the server answered', async (t) => {
  const record = [];
  globalThis.XMLHttpRequest = browserXhr(record);
  t.after(() => delete globalThis.XMLHttpRequest);
  const { svc, links, ready } = await setup(t);
  const bytes = crypto.randomBytes(400 * 1024);
  const staged = await svc.files.stage(W, C, null, { name: 'big.bin', type: 'application/octet-stream', bytes: new Uint8Array(bytes) });
  const done = await ready(staged.stage);
  assert.equal(done.state, 'ready', done.error);
  assert.equal(record.length, 0, 'no XMLHttpRequest');
  assert.ok(links.put.get(done.file).equals(bytes));
  const headers = links.headers.get(done.file);
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.equal(headers.accept, 'application/json');
  for (const name of ['cookie', 'authorization', 'referer']) assert.equal(headers[name], undefined, name);
  // What the tray saw while the file uploaded: nothing sent until the answer, then all of it, and no share in between
  // that the page can't know.
  const loaded = svc.events.filter((e) => e.kind === 'staged').map((e) => e.staged[0]).filter((s) => s.state === 'uploading').map((s) => s.loaded);
  assert.ok(loaded.length > 0, 'the tray saw the upload');
  assert.ok(loaded.every((n) => n === 0 || n === bytes.length), loaded.join(' '));
});

test('an upload refuses a 307 or 308 before its body goes anywhere else',async (t) => {
  const record = [];
  globalThis.XMLHttpRequest = browserXhr(record);
  t.after(() => delete globalThis.XMLHttpRequest);
  const { svc, links, answer, ready } = await setup(t);
  const bytes = crypto.randomBytes(100 * 1024);
  for (const status of ['307', '308']) {
    answer.put.push(status);
    const moved = await svc.files.stage(W, C, null, { name: `moved-${status}.bin`, type: 'application/octet-stream', bytes: new Uint8Array(bytes) });
    const refused = await ready(moved.stage);
    assert.equal(refused.state, 'failed', status);
    assert.equal(refused.error, 'server', status);
    // The PUT got the redirect, and nothing reached where it pointed.
    assert.ok(links.headers.has(refused.file), `${status}: the PUT reached the server`);
    assert.deepEqual(links.target, [], `${status}: nothing may reach the redirect's target`);
  }
  // transfer() itself rejects with the redirect's error.
  await web.fsp.writeFile('rukoo-web/redirect/body', new Uint8Array(bytes));
  links.behave.set('direct', '308');
  const err = await web.files
    .transfer(`${links.base}/put/direct`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: web.fs.createReadStream('rukoo-web/redirect/body') })
    .then(() => null, (e) => e);
  assert.deepEqual([err && err.code, err && err.status, err && err.message], ['server', 308, 'redirect refused']);
  assert.deepEqual(links.target, []);
  web.fs.rmSync('rukoo-web/redirect', { recursive: true, force: true });
  assert.equal(record.length, 0, 'no XMLHttpRequest');
});

test("an upload's answer is read as it comes, and reading stops past transfer()'s 1 MiB", async (t) => {
  const record = [];
  globalThis.XMLHttpRequest = browserXhr(record);
  t.after(() => delete globalThis.XMLHttpRequest);
  const { svc, links, answer, ready } = await setup(t);
  const bytes = crypto.randomBytes(100 * 1024);
  // An answer of 64 MiB: reading stops at 1 MiB, the connection closes, and the upload fails.
  answer.put.push('huge');
  const flood = await svc.files.stage(W, C, null, { name: 'flood.bin', type: 'application/octet-stream', bytes: new Uint8Array(bytes) });
  const cut = await ready(flood.stage);
  assert.equal(cut.state, 'failed');
  await until(() => links.huge && links.huge.closed, 5000, 'the answer to close');
  assert.ok(links.huge.written < 16 * 1024 * 1024, `the server wrote ${links.huge.written} bytes of the answer before it closed`);
  assert.equal(record.length, 0, 'no XMLHttpRequest');
});

test("the idle timer gives an upload's body time to go, which the page can't watch", async (t) => {
  const links = await linkServer(t);
  // Whether a request whose answer comes 400 ms after the server took the body times out at 100 ms.
  const timesOut = (method, body) =>
    new Promise((resolve, reject) => {
      const key = `${method}-${crypto.randomBytes(4).toString('hex')}`;
      links.behave.set(key, 'slow');
      const req = web.http.request(`${links.base}/put/${key}`, { method, timeout: 100 }, (res) => {
        res.resume();
        resolve(false);
      });
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
        resolve(true);
      });
      req.on('error', (e) => (e.message === 'timeout' ? null : reject(e)));
      req.end(body);
    });
  // 64 KiB to send: the timer allows 100 ms and the body's 4 s at 16 KiB/s.
  assert.equal(await timesOut('PUT', new Uint8Array(64 * 1024)), false);
  // Without a body nothing is on its way: no answer for 100 ms is a timeout.
  assert.equal(await timesOut('GET'), true);
});

// files.js sends three uploads at once (TRANSFERS). On one connection of 24 KiB/s, above the shim's 16 KiB/s, each gets
// 8 KiB/s: none may time out for going at its share of the pace.
test('uploads that share a slow connection get the time all of them take, and all arrive', { timeout: 60000 }, async (t) => {
  const links = await linkServer(t);
  const STEP = 4 * 1024;
  const SIZE = 48 * 1024;
  // The connection: one STEP at a time, in turn, at 24 KiB/s. A body's fetch starts once all of it went.
  const queue = [];
  const link = setInterval(() => queue.shift()?.(), (STEP / (24 * 1024)) * 1000);
  t.after(() => clearInterval(link));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init && init.body;
    for (let sent = 0; body && sent < body.size; sent += STEP) {
      await new Promise((resolve) => queue.push(resolve));
      if (init.signal && init.signal.aborted) throw init.signal.reason;
    }
    return realFetch(url, init);
  };
  t.after(() => (globalThis.fetch = realFetch));
  const started = Date.now();
  const upload = (n) =>
    new Promise((resolve) => {
      const req = web.http.request(`${links.base}/put/shared-${n}`, { method: 'PUT', timeout: 500 }, (res) => {
        res.resume();
        resolve(`answered ${res.statusCode}`);
      });
      req.on('timeout', () => {
        resolve(`timeout after ${Date.now() - started} ms`);
        req.destroy(new Error('timeout'));
      });
      req.on('error', () => {});
      req.end(new Uint8Array(SIZE).fill(n));
    });
  // Alone, each would have 500 ms and 3 s for its 48 KiB; together they take about 6 s.
  assert.deepEqual(await Promise.all([1, 2, 3].map(upload)), ['answered 200', 'answered 200', 'answered 200']);
  assert.ok(Date.now() - started > 5000, 'the connection was as slow as it says');
  for (const n of [1, 2, 3]) assert.equal(links.put.get(`shared-${n}`).length, SIZE);
});
