// Checks that a folder of bucket objects holds nothing a storage provider could read: the checks of
// voice-sync's `nothing_reaches_the_bucket_unencrypted` test (voice/crates/voice-sync/tests/upload.rs), for objects
// on disk. The live paired run points it at the fake S3's folder; by hand it checks raw objects downloaded from a
// real bucket.
//
//   node voice/scripts/check-encrypted.mjs <folder> [--forbid <text>]... [--json]
//
// <folder> is either the fake S3's --dir, whose objects are in <folder>/objects, or a folder of downloaded objects
// with the bucket's keys as paths. --forbid adds text no object and no key may contain, such as a meeting id or
// title; it is never printed. Exits 0 when every object passes, 1 when one fails, 2 on bad arguments.
//
// Every object must:
// - start with the magic `RKV1`;
// - hold none of these structural signatures: `RIFF` plus 4 bytes plus `WAVEfmt ` (a WAV header);
//   FF D8 FF E0 00 10 'JFIF' 00 (a JPEG header); a 4-byte box size, `ftyp` and four printable ASCII bytes (an MP4);
//   `SQLite format 3\0`; nor any --forbid text. Bare 4-byte strings such as `RIFF` or `ftyp` aren't checked alone,
//   because random ciphertext holds them by chance: about once in nine runs of 166 MB;
// - when larger than 4 KiB, have no byte value making up more than 1.5 % of its bytes, as ciphertext doesn't;
// - have a key of the shape `[<prefix>]rkv1/<16 hex>/index/<32 hex>`, `.../m/<32 hex>/manifest` or
//   `.../m/<32 hex>/o/<32 hex>`, so no meeting id, file name or kind shows; no key contains `m-20`, `.wav`, `.jpg`,
//   `.mp4` or a --forbid text.
//
// The report names objects by key and says which rule failed; it never prints object bytes.

import fs from 'node:fs';
import path from 'node:path';

const CHUNK = 4 << 20;
// The longest signature is 16 bytes; a chunk carries the previous chunk's last bytes so none is cut in two.
const CARRY = 64;
const KEY = /^(?:.*\/)?rkv1\/(?:[0-9a-f]{16}\/(?:index\/[0-9a-f]{32}|m\/[0-9a-f]{32}\/(?:manifest|o\/[0-9a-f]{32})))$/;
const KEY_WORDS = ['m-20', '.wav', '.jpg', '.mp4'];
const JFIF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const SQLITE = Buffer.from('SQLite format 3\0', 'latin1');
const WAVEFMT = Buffer.from('WAVEfmt ', 'latin1');
const RIFF = Buffer.from('RIFF', 'latin1');
const FTYP = Buffer.from('ftyp', 'latin1');

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node voice/scripts/check-encrypted.mjs <folder> [--forbid <text>]... [--json]');
  process.exit(2);
}

function parse(argv) {
  const opts = { folder: null, forbid: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--forbid') {
      const v = argv[++i];
      if (!v) usage('--forbid needs a text');
      opts.forbid.push(v);
    } else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else if (!opts.folder) opts.folder = a;
    else usage('one folder only');
  }
  if (!opts.folder) usage();
  return opts;
}

// Every file under root, as [key with forward slashes, full path].
function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push([path.relative(root, full).split(path.sep).join('/'), full]);
    }
  };
  visit(root);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

function* positions(buf, needle) {
  for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) yield at;
}

const printable = (b) => b >= 0x20 && b < 0x7f;

// Which signatures buf holds. A match in the bytes carried over from the previous chunk is found twice, which does no
// harm: the result is a set.
function signatures(buf, forbid) {
  const found = new Set();
  for (const at of positions(buf, WAVEFMT)) if (at >= 8 && buf.subarray(at - 8, at - 4).equals(RIFF)) found.add('a WAV header');
  if (buf.includes(JFIF)) found.add('a JPEG header');
  for (const at of positions(buf, FTYP)) {
    if (at >= 4 && at + 8 <= buf.length && [...buf.subarray(at + 4, at + 8)].every(printable)) found.add('an MP4 box');
  }
  if (buf.includes(SQLITE)) found.add('a SQLite header');
  forbid.forEach((text, i) => {
    if (buf.includes(text)) found.add(`forbidden text ${i + 1}`);
  });
  return found;
}

function checkObject(key, file, forbid) {
  const problems = [];
  if (!KEY.test(key)) problems.push('its key is not a sync object name');
  for (const word of KEY_WORDS) if (key.includes(word)) problems.push(`its key shows ${word}`);
  forbid.forEach((text, i) => {
    if (key.includes(text.toString('utf8'))) problems.push(`its key holds forbidden text ${i + 1}`);
  });

  const counts = new Float64Array(256);
  let size = 0;
  let carry = Buffer.alloc(0);
  const found = new Set();
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, CHUNK, null);
      if (n === 0) break;
      const fresh = chunk.subarray(0, n);
      if (size === 0 && !(n >= 4 && fresh.subarray(0, 4).toString('latin1') === 'RKV1')) problems.push('it does not start with RKV1');
      for (let i = 0; i < n; i++) counts[fresh[i]]++;
      for (const s of signatures(Buffer.concat([carry, fresh]), forbid)) found.add(s);
      carry = Buffer.from(fresh.subarray(Math.max(0, n - CARRY)));
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (size === 0) problems.push('it is empty');
  for (const s of found) problems.push(`it holds ${s}`);
  let top = 0;
  for (const c of counts) top = Math.max(top, c);
  if (size > 4096 && top > size * 0.015) problems.push(`one byte value makes up ${((top / size) * 100).toFixed(2)} % of it`);
  return { key, size, problems };
}

function main() {
  const opts = parse(process.argv.slice(2));
  const objectsDir = path.join(opts.folder, 'objects');
  const root = fs.existsSync(objectsDir) && fs.statSync(objectsDir).isDirectory() ? objectsDir : opts.folder;
  if (!fs.existsSync(root)) usage(`${root} does not exist`);
  const forbid = opts.forbid.map((t) => Buffer.from(t, 'utf8'));
  const results = walk(root).map(([key, file]) => checkObject(key, file, forbid));
  const failed = results.filter((r) => r.problems.length);
  const summary = {
    folder: root,
    objects: results.length,
    bytes: results.reduce((n, r) => n + r.size, 0),
    largest: results.reduce((n, r) => Math.max(n, r.size), 0),
    failed: failed.map((r) => ({ key: r.key, problems: r.problems }))
  };
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else {
    for (const r of failed) console.log(`FAIL ${r.key}: ${r.problems.join('; ')}`);
    console.log(`${summary.objects} objects, ${summary.bytes} bytes, ${failed.length} failed`);
  }
  if (results.length === 0) {
    console.error(`no objects in ${root}`);
    process.exit(1);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
