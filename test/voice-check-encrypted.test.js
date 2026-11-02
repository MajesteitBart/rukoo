// voice/scripts/check-encrypted.mjs: the live run and the by-hand bucket check rely on it to find anything a storage
// provider could read in a folder of bucket objects.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'voice', 'scripts', 'check-encrypted.mjs');
const KID = '0123456789abcdef';
const hex32 = (c) => c.repeat(32);

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-check-encrypted-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, key, bytes) {
  const file = path.join(root, ...key.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

// Random bytes behind the magic, as an encrypted object looks.
const sealed = (n) => Buffer.concat([Buffer.from('RKV1'), crypto.randomBytes(n)]);
const file = (m, f) => `rukoo-voice/rkv1/${KID}/m/${hex32(m)}/o/${hex32(f)}`;

function run(...args) {
  const out = spawnSync(process.execPath, [SCRIPT, ...args, '--json'], { encoding: 'utf8' });
  return { status: out.status, report: out.stdout ? JSON.parse(out.stdout) : null, stderr: out.stderr };
}

test('objects that look encrypted under sync names pass, in the fake S3 layout and as a plain folder', (t) => {
  const dir = folder(t);
  const objects = path.join(dir, 'objects');
  put(objects, file('a', 'b'), sealed(960399 - 4));
  put(objects, file('a', 'c'), sealed(200));
  put(objects, `rukoo-voice/rkv1/${KID}/m/${hex32('a')}/manifest`, sealed(3000));
  put(objects, `rkv1/${KID}/index/${hex32('d')}`, sealed(5000));
  const fake = run(dir);
  assert.equal(fake.status, 0, fake.stderr);
  assert.equal(fake.report.objects, 4);
  assert.deepEqual(fake.report.failed, []);
  // A folder of downloaded objects has the keys as paths, without objects/.
  assert.equal(run(objects).status, 0);
});

test('each signature, a missing magic, a skewed byte count and a telling key fail, and say why', (t) => {
  const dir = folder(t);
  const objects = path.join(dir, 'objects');
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);
  const jfif = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')]);
  put(objects, file('1', '1'), Buffer.concat([sealed(5000), wav, crypto.randomBytes(100)]));
  put(objects, file('1', '2'), Buffer.concat([sealed(5000), jfif]));
  put(objects, file('1', '3'), Buffer.concat([sealed(5000), mp4]));
  put(objects, file('1', '4'), Buffer.concat([sealed(5000), Buffer.from('SQLite format 3\0')]));
  put(objects, file('1', '5'), crypto.randomBytes(5000));
  put(objects, file('1', '6'), Buffer.concat([Buffer.from('RKV1'), Buffer.alloc(8000)]));
  put(objects, file('1', '7'), Buffer.concat([sealed(5000), Buffer.from('m-20261102-091500-abcd')]));
  put(objects, `rukoo-voice/rkv1/${KID}/m/${hex32('1')}/audio/mic/000001.wav`, sealed(5000));
  const { status, report } = run(dir, '--forbid', 'm-20261102-091500-abcd');
  assert.equal(status, 1);
  const why = Object.fromEntries(report.failed.map((f) => [f.key.split('/').pop(), f.problems.join('; ')]));
  assert.match(why[hex32('1')], /a WAV header/);
  assert.match(why[hex32('2')], /a JPEG header/);
  assert.match(why[hex32('3')], /an MP4 box/);
  assert.match(why[hex32('4')], /a SQLite header/);
  assert.match(why[hex32('5')], /does not start with RKV1/);
  assert.match(why[hex32('6')], /one byte value makes up/);
  assert.match(why[hex32('7')], /forbidden text 1/);
  assert.match(why['000001.wav'], /not a sync object name.*shows \.wav/);
  // The report names the rule, never the forbidden text itself.
  assert.ok(!JSON.stringify(report).includes('m-20261102'));
});

test('a signature across the 4 MiB read boundary is found', (t) => {
  const dir = folder(t);
  const head = sealed((4 << 20) - 4 - 6);
  put(dir, `rkv1/${KID}/m/${hex32('e')}/o/${hex32('f')}`, Buffer.concat([head, Buffer.from('SQLite format 3\0'), crypto.randomBytes(100)]));
  const { status, report } = run(dir);
  assert.equal(status, 1);
  assert.match(report.failed[0].problems.join(), /a SQLite header/);
});

test('an empty folder fails, and a bad argument stops with 2', (t) => {
  const dir = folder(t);
  assert.equal(spawnSync(process.execPath, [SCRIPT, dir]).status, 1);
  assert.equal(spawnSync(process.execPath, [SCRIPT]).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, dir, '--nonsense']).status, 2);
});
