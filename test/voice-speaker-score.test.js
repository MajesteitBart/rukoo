'use strict';

// The live run's speaker label scorer (voice/scripts/lib/speaker-score.mjs) against the vectors Voice's Rust scorer
// passes too (voice/fixtures/speaker-score-vectors.json, read where it is).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const VECTORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'voice', 'fixtures', 'speaker-score-vectors.json'), 'utf8'));
const scorer = () => import(pathToFileURL(path.join(ROOT, 'voice', 'scripts', 'lib', 'speaker-score.mjs')).href);

test('the scorer passes every vector', async () => {
  const { accuracy } = await scorer();
  assert.ok(VECTORS.cases.length >= 5);
  for (const c of VECTORS.cases) {
    const got = accuracy(c.passages, c.reference);
    assert.ok(Math.abs(got - c.accuracy) < 1e-9, `${c.name}: ${got} instead of ${c.accuracy}`);
  }
});

test('ids map one to one, the largest overlap first', async () => {
  const { mapping } = await scorer();
  const [, reordered, , twoIds] = VECTORS.cases;
  assert.deepEqual(mapping(reordered.passages, reordered.reference), { 'call-1': 'S2', 'call-2': 'S3', 'call-3': 'S1' });
  // One voice heard as two ids: only the id with more time gets the speaker.
  assert.deepEqual(mapping(twoIds.passages, twoIds.reference), { 'call-2': 'S1' });
});

test('nothing to score is perfect, and passages outside every turn are left out', async () => {
  const { accuracy } = await scorer();
  assert.equal(accuracy([], []), 1);
  assert.equal(accuracy([{ start: 0, end: 1000, speaker: null }], [{ start: 5000, end: 6000, speaker: 'S1' }]), 1);
  assert.equal(accuracy([{ start: 0, end: 1000, speaker: null }], [{ start: 0, end: 1000, speaker: 'S1' }]), 0);
});
