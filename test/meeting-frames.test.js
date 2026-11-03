'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/meeting-frames.js'), 'utf8');
const folding = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('frame folding keeps new titles, substantial changes and unknown OCR separate', async () => {
  const { foldFrames } = await folding;
  const frame = (id, text, extra = {}) => ({ id, at: id * 1000, text, ...extra });
  const frames = [
    frame(1, 'Meet\nSanne Bart Launch review'),
    frame(2, 'Meet\nSanne Bart Launch review'),
    frame(3, 'Slide 1\nLaunch checklist support training on Monday'),
    frame(4, 'Slide 2\nLaunch checklist support training on Monday'),
    frame(5, 'Slide 2\nAnnual budget sales and revenue'),
    frame(6, '', { textOmitted: true }),
    frame(7, '', { textOmitted: true }),
    frame(8, ''),
    frame(9, '')
  ];
  assert.deepEqual(foldFrames(frames).map((group) => group.map((f) => f.id)), [[1, 2], [3], [4], [5], [6], [7], [8, 9]]);
  assert.deepEqual(frames.map((f) => f.id), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'folding never removes stored frames');
});
