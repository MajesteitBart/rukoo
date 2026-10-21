'use strict';

// Ends a Rukoo test instance after a test. Its windows go first: an editor with unsaved changes would otherwise keep
// its window open and ask. app.close() then quits Rukoo and waits until its process has exited.
//
// A quit that never ends would hold the hook until the test times out, and the worker after it. Rukoo's main process
// stops in a modal box, for one, when an error is thrown in it (Electron's "A JavaScript error occurred"), and in a
// test nobody closes that box. So the close gets CLOSE_WAIT; after that this instance's own processes are killed and
// the test fails, so the hang still shows. Only its own: Playwright starts Electron as the leader of a new process
// group outside Windows, and taskkill /T follows the process tree on Windows.
//
// Windows gets longer. There Rukoo's own part of a quit ends within about 2 s, but Electron's process can live on
// for a while after its last JavaScript has run, while Chromium shuts down: up to 9 s on a CI runner that was busy,
// and past 15 s when the runner stalled (#87). The test's timeout grows by the wait, so a close that runs out of time
// still ends here, with its own error, instead of in a hook timeout that also takes the worker down.
const { execFileSync } = require('child_process');
const { test } = require('@playwright/test');

const CLOSE_WAIT = process.platform === 'win32' ? 45000 : 15000;

function wait(ms) {
  let timer;
  const done = new Promise((resolve) => (timer = setTimeout(resolve, ms, 'timeout')));
  return { done, cancel: () => clearTimeout(timer) };
}

function kill(proc) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-proc.pid, 'SIGKILL');
  } catch (_) {
    // Gone already.
  }
}

async function closeApp(app) {
  if (!app) return;
  let proc;
  try {
    proc = app.process();
  } catch (_) {
    // Closed already, by the test itself.
    return;
  }
  // Called in a hook or a test; outside one (a script) there is no timeout to grow.
  try {
    const info = test.info();
    if (info.timeout) info.setTimeout(info.timeout + CLOSE_WAIT + 5000);
  } catch (_) {
    // Not in a test.
  }
  const closing = (async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
    // An instance that has exited already, after a test that quit it, has nothing left to close.
    await app.close().catch(() => {});
    return 'closed';
  })();
  const limit = wait(CLOSE_WAIT);
  const outcome = await Promise.race([closing, limit.done]);
  limit.cancel();
  if (outcome === 'closed') return;
  kill(proc);
  const after = wait(5000);
  await Promise.race([closing, after.done]);
  after.cancel();
  throw new Error(`Rukoo (pid ${proc.pid}) did not exit within ${CLOSE_WAIT / 1000} s of closing, so the test killed it`);
}

module.exports = { closeApp, CLOSE_WAIT };
