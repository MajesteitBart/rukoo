'use strict';
// Dev helper: renders src/renderer/agent-gallery.html in a bare Electron window (no Rukoo main) and
// saves screenshots in dark and light to <outDir>. Each theme gets two PNGs: one while the live column
// is still streaming with the slash menu open, one settled with the agent picker open.
// Usage: node scripts/agent-gallery.js <outDir>   (default: %TEMP%\rukoo-gallery)
//        node scripts/agent-gallery.js --check     runs the behaviour checks in the renderer, no PNGs
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

if (typeof electron === 'string') {
  // Running under Node: relaunch under Electron with this file as the main script. Clear
  // ELECTRON_RUN_AS_NODE like scripts/start.js, otherwise electron.exe behaves like plain Node.
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = process.argv.slice(2);
  const out = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.tmpdir(), 'rukoo-gallery'));
  const child = spawn(electron, [__filename, ...args.filter((a) => a.startsWith('--')), out], { stdio: 'inherit', env, cwd: path.join(__dirname, '..') });
  child.on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow } = electron;
const out = process.argv[process.argv.length - 1];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({
    width: 1400,
    height: 1600,
    useContentSize: true,
    show: false,
    backgroundColor: '#141519',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setMenuBarVisibility(false);
  // A never-shown window does not paint, so park it off-screen without focus (same trick as main.js).
  win.once('ready-to-show', () => {
    win.setPosition(-5000, -5000);
    win.showInactive();
  });
  win.webContents.on('console-message', (e, ...rest) => {
    // Electron 44 passes a details object; older versions pass (event, level, message).
    const level = typeof e.level === 'number' ? ['debug', 'info', 'warning', 'error'][e.level] : e.level || ['debug', 'info', 'warning', 'error'][rest[0]];
    const message = e.message || rest[1];
    if (level === 'warning' || level === 'error') errors.push(`${level}: ${message}`);
  });
  win.webContents.on('render-process-gone', (e, d) => errors.push(`renderer gone: ${d.reason}`));
  // Runs page code and surfaces the real exception instead of Electron's generic "script failed".
  const js = async (code) => {
    const result = await win.webContents.executeJavaScript(`(async () => { try { ${code}; return 'ok'; } catch (e) { return 'ERR ' + ((e && e.stack) || e); } })()`, true);
    if (String(result).startsWith('ERR ')) throw new Error(result.slice(4));
    return result;
  };
  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name), image.toPNG());
    console.log(path.join(out, name));
  };

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'agent-gallery.html'));
  await js('await document.fonts.ready');
  if (process.argv.includes('--check')) {
    // Behaviour checks run inside the real renderer; the page returns the list of failures.
    const fails = JSON.parse(await js('return JSON.stringify(await window.gallery.check())'));
    // Then the same page with reduced motion asked for: what moves must stop.
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    fails.push(...JSON.parse(await js('return JSON.stringify(await window.gallery.checkReducedMotion())')));
    console.log(fails.length ? `FAIL\n${fails.map((f) => `  - ${f}`).join('\n')}` : 'agent gallery checks: all passed');
    if (errors.length) console.log(errors.join('\n'));
    app.exit(fails.length || errors.length ? 1 : 0);
    return;
  }
  // Grow the window to the page so one PNG shows every component (1400 wide, at least 1600 tall).
  const height = await js('return Math.min(4000, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))');
  win.setContentSize(1400, Math.max(1600, Number(height) || 1600));
  await sleep(300);
  for (const theme of ['dark', 'light']) {
    await js(`document.documentElement.classList.toggle('light', ${theme === 'light'}); window.gallery.restart('slash')`);
    await sleep(1800);
    await shot(`${theme}-1.png`);
    await js('window.gallery.openAgents()');
    await sleep(6500);
    await shot(`${theme}-2.png`);
  }
  if (errors.length) console.log(errors.join('\n'));
  app.exit(errors.some((e) => e.startsWith('error') || e.startsWith('renderer')) ? 1 : 0);
}).catch((e) => {
  console.error(e);
  if (errors.length) console.error(errors.join('\n'));
  app.exit(1);
});
