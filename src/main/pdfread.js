'use strict';

// Reads a PDF's text in a process of its own: pdfchild.js runs pdftext.js there. PDFs come from anywhere, and the
// reader is a parser of untrusted input; in Rukoo's main process one built to make it work or allocate without
// end would freeze or crash the whole app. In a process of its own the worst such a PDF can do is use up TIMEOUT,
// after which the process is killed and the PDF counts as unreadable.
//
// In Electron the process is a utility process; plain Node (the unit tests) forks one. One process per PDF: it
// starts in a fraction of a second, leaves nothing behind once the PDF is read, and a killed one takes no other
// reads down with it.
const path = require('path');

// An ordinary PDF of a thousand pages reads in a fifth of a second, process start included, and pdftext's own
// budgets end the reading of a hostile one within a second or two. This leaves room for a slow machine; a PDF that
// still takes longer gets no text.
const TIMEOUT = 10000;
// The whole process, Buffers included; a watchdog in the child checks it (see pdfchild.js). pdftext keeps decoded
// streams, and the content it reads, under 64 MB each, and an ordinary large PDF stays far below this.
const RSS_MAX = 768 * 1024 * 1024;
// V8's own heap within that, so a runaway heap ends in an out-of-memory exit before it reaches the cap.
const HEAP_MB = 512;
// A message can bring ten PDFs, and each process may use up to RSS_MAX.
const AT_ONCE = 2;

const CHILD = path.join(__dirname, 'pdfchild.js');

const failed = (why) => ({ text: '', pages: 0, truncated: false, encrypted: false, failed: why });

function spawn({ rssMax, reader }) {
  const args = [String(rssMax), ...(reader ? [reader] : [])];
  const execArgv = [`--max-old-space-size=${HEAP_MB}`];
  if (process.versions.electron && process.type === 'browser') {
    const { utilityProcess } = require('electron');
    // With ELECTRON_RUN_AS_NODE inherited (Electron terminals export it), the utility process would not start as one.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = utilityProcess.fork(CHILD, args, { execArgv, env, stdio: ['ignore', 'ignore', 'pipe'], serviceName: 'Rukoo PDF reader' });
    return {
      send: (msg) => child.postMessage(msg),
      onMessage: (fn) => child.on('message', fn),
      onExit: (fn) => child.on('exit', fn),
      stderr: child.stderr,
      kill: () => child.kill()
    };
  }
  const { fork } = require('child_process');
  // execArgv in full: a fork would inherit the parent's, such as the test runner's.
  const child = fork(CHILD, args, { execArgv, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  return {
    send: (msg) => child.send(msg),
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', fn),
    stderr: child.stderr,
    kill: () => child.kill()
  };
}

class PdfReader {
  // timeout, rssMax: the limits above. reader: another module for the child to read with, for tests.
  constructor({ timeout = TIMEOUT, rssMax = RSS_MAX, reader = null } = {}) {
    this.opts = { timeout, rssMax, reader };
    this.queue = [];
    this.running = new Set();
    this.stopped = false;
  }

  // pdftext's {text, pages, truncated, partial, encrypted} and failed: null once the reader finished, or why it has
  // no text: 'timeout', 'memory' (over the cap), 'error' (the process ended without an answer) or 'stopped' (signal
  // aborted, or Rukoo is closing). signal: the turn or tool call it is for; once that is stopped the read leaves the
  // queue, or its process is killed, so it never keeps another chat's PDF waiting. Never rejects.
  read(buffer, { maxChars = 200000, signal = null } = {}) {
    if (this.stopped || (signal && signal.aborted)) return Promise.resolve(failed('stopped'));
    return new Promise((resolve) => {
      const job = { buffer, maxChars, signal, resolve, run: null, done: false };
      if (signal) {
        job.onAbort = () => {
          if (job.run) return job.run.finish(failed('stopped'));
          this.queue = this.queue.filter((j) => j !== job);
          this.settle(job, failed('stopped'));
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.queue.push(job);
      this.next();
    });
  }

  settle(job, result) {
    if (job.done) return;
    job.done = true;
    if (job.signal) job.signal.removeEventListener('abort', job.onAbort);
    job.resolve(result);
  }

  // A stopped turn aborts all its reads at once; the ones still queued then must not start a process first.
  next() {
    while (!this.stopped && this.running.size < AT_ONCE && this.queue.length) {
      const job = this.queue.shift();
      if (job.signal && job.signal.aborted) this.settle(job, failed('stopped'));
      else this.start(job);
    }
  }

  start(job) {
    let child;
    try {
      child = spawn(this.opts);
    } catch (_) {
      this.settle(job, failed('error'));
      return;
    }
    let stderr = '';
    let done = false;
    const run = {
      finish: (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.running.delete(run);
        try {
          child.kill();
        } catch (_) {
          // Gone already.
        }
        this.settle(job, result);
        this.next();
      }
    };
    job.run = run;
    this.running.add(run);
    const timer = setTimeout(() => run.finish(failed('timeout')), this.opts.timeout);
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        if (stderr.length < 2000) stderr += d;
      });
    }
    child.onMessage((msg) => run.finish(msg && typeof msg.text === 'string' ? { ...msg, failed: null } : failed('error')));
    // The watchdog, or V8 when the heap is full, says why on stderr just before the process ends; what it wrote can
    // come in after the exit.
    child.onExit(() => setTimeout(() => run.finish(failed(/over the memory cap|heap out of memory/i.test(stderr) ? 'memory' : 'error')), 100));
    try {
      child.send({ data: job.buffer, maxChars: job.maxChars });
    } catch (_) {
      run.finish(failed('error'));
    }
  }

  // Rukoo is closing: no new reads, and those still running are ended now.
  dispose() {
    this.stopped = true;
    for (const job of this.queue.splice(0)) this.settle(job, failed('stopped'));
    for (const run of [...this.running]) run.finish(failed('stopped'));
  }
}

module.exports = { PdfReader, TIMEOUT, RSS_MAX, HEAP_MB };
