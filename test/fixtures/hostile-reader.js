'use strict';

// A stand-in for pdftext.js in the tests of pdfread.js: it does what the file asks, so the tests can show that a
// reader that never returns, or that takes ever more memory, is ended from outside its process. HANG, BUFFERS and
// HEAP in the file choose; any other file goes to the real reader.
const { pdfText } = require('../../src/main/pdftext');

exports.pdfText = (buffer, opts) => {
  const s = buffer.toString('latin1');
  if (s.includes('HANG')) for (;;);
  const keep = [];
  // Buffers live outside V8's heap, where its heap limit does not reach.
  if (s.includes('BUFFERS')) for (;;) keep.push(Buffer.alloc(8 * 1024 * 1024, 1));
  if (s.includes('HEAP')) for (;;) keep.push({ n: keep.length, s: `x${keep.length}` });
  return pdfText(buffer, opts);
};
