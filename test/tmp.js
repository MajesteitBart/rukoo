'use strict';

// Temp folders for tests: profiles, data folders and fixtures. Each one goes when the test process ends, also after a
// failed or timed-out test whose own cleanup never ran, so a test run leaves nothing behind in Temp.
const fs = require('fs');
const os = require('os');
const path = require('path');

const made = new Set();

// A Windows process that just closed can still hold a file for a moment, so removal tries a few times. It never
// throws: a folder that stays is removed again when the process ends.
function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    made.delete(dir);
  } catch (_) {
    // Tried again at exit.
  }
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
}

// A folder that still can't go, held by a process that outlived its test, is named on stderr, so a passing run
// doesn't hide it. writeSync, because nothing asynchronous runs any more at exit.
process.on('exit', () => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (err) {
      fs.writeSync(2, `Could not remove the test folder ${dir}: ${err.code || err.message}\n`);
    }
  }
});

module.exports = { tempDir, removeDir };
