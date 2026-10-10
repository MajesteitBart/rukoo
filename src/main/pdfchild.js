'use strict';

// The process pdfread.js starts to read one PDF: it gets the file's bytes and maxChars, answers with pdftext.js's
// result and waits to be ended. argv: the memory cap in bytes, and the reader module (tests swap in their own).
// A watchdog thread ends the process outright once it uses more memory than the cap. Buffers live outside V8's
// heap, so the heap limit pdfread.js sets does not cap them, and the reader can't look at the clock or its memory
// while it runs.
const { Worker } = require('worker_threads');

const rssMax = Number(process.argv[2]) || 512 * 1024 * 1024;
const reader = process.argv[3] || './pdftext';

new Worker(
  `const { workerData } = require('worker_threads');
  setInterval(() => {
    if (process.memoryUsage.rss() <= workerData) return;
    require('fs').writeSync(2, 'rukoo-pdf: over the memory cap\\n');
    process.kill(process.pid, 'SIGKILL');
  }, 25);`,
  { eval: true, workerData: rssMax }
).unref();

function read(msg) {
  const { pdfText } = require(reader);
  const bytes = msg.data;
  return pdfText(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { maxChars: msg.maxChars });
}

// Electron's utility process talks over parentPort; a Node child over its IPC channel, which closes when Rukoo is
// gone, and this process goes with it.
if (process.parentPort) {
  process.parentPort.on('message', (e) => process.parentPort.postMessage(read(e.data)));
} else {
  process.on('message', (msg) => process.send(read(msg)));
  process.on('disconnect', () => process.exit(0));
}
