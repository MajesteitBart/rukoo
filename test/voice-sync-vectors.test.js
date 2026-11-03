'use strict';

// voice/fixtures/sync-vectors.json holds the known answers voice-sync's Rust tests check its encryption against. The
// script that writes them must still write the same file, so the fixture can be made again and checked by a second
// implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');

const ROOT = path.join(__dirname, '..');

test('the sync vectors script writes the committed fixture byte for byte', () => {
  const out = path.join(tempDir('rukoo-sync-vectors-'), 'sync-vectors.json');
  execFileSync(process.execPath, [path.join(ROOT, 'voice', 'scripts', 'sync-vectors.mjs'), out], { stdio: 'pipe' });
  // Git may check the fixture out with CRLF line ends on Windows.
  const committed = fs.readFileSync(path.join(ROOT, 'voice', 'fixtures', 'sync-vectors.json'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(fs.readFileSync(out, 'utf8'), committed);
});
