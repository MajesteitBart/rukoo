// Decodes random quoted-printable with libqp, the decoder desktop Rukoo's decodeTransfer uses, and writes the
// inputs and outputs to src/test/resources/mail/qp-vectors.json for MailTextTest. From the repository root, with
// the desktop app's node_modules installed:
//   node android/app/src/test/mail-fixtures/make-qp-vectors.js
'use strict';

const fs = require('fs');
const path = require('path');
const libqp = require('libqp');

const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const out = path.join(root, 'android/app/src/test/resources/mail');
fs.mkdirSync(out, { recursive: true });

// mulberry32 with a fixed seed: the same file on every run.
let seed = 0x5eed2026;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// The bytes that matter to the decoder, and a few that don't.
const ALPHABET = [0x3d, 0x3d, 0x3d, 0x0d, 0x0a, 0x0a, 0x20, 0x20, 0x09, 0x41, 0x61, 0x66, 0x34, 0x31, 0x44, 0x33, 0x47, 0x78, 0x80, 0xc3, 0xff];

const cases = [];
for (let n = 0; n < 500; n++) {
  const length = Math.floor(random() * 24);
  const bytes = Buffer.from(Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]));
  cases.push({ input: bytes.toString('hex'), output: libqp.decode(bytes).toString('hex') });
}
fs.writeFileSync(path.join(out, 'qp-vectors.json'), JSON.stringify(cases, null, 1) + '\n');
console.log(`wrote ${cases.length} cases`);
