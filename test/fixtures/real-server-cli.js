'use strict';

// The real account server for tests outside Node, such as Android's AccountLiveTest and WorkspaceLiveTest, or an
// emulator check by hand. It starts the server through real-server.js, writes { url, invite, pid, previews } to
// --ready-file once the Worker answers, and runs until SIGINT, SIGTERM or the deletion of the ready file. Deleting the
// file is the stop signal that also works for a Windows process started without a console. Then it disposes of workerd
// and removes its storage. previews is the origin of the page server link cards may fetch.
//
//   node test/fixtures/real-server-cli.js --port 38850 --ready-file tmp/rukoo-server.json [--no-files] [--signups verified] [--mail]
//
// Without --port it picks a free port from 38800 to 38899. --no-files starts it without a files bucket. --signups sets
// SIGNUPS (open, invite, verified or closed). --mail sends codes by email to the mail stand-in of real-server.js, whose
// origin the ready file has as mail: GET <mail>/messages?to=<address> answers the codes sent to an address. It needs
// only server/node_modules: it never seeds, so it doesn't load the desktop's crypto code. Seed against it with
// connectRealServer(url, { previews }) from real-server.js.
const fs = require('fs');
const path = require('path');
const { startRealServer } = require('./real-server');

const POLL = 500;

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

async function main() {
  const portText = arg('--port');
  const port = portText === null ? null : Number(portText);
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`Not a port: ${portText}`);
  const readyFile = arg('--ready-file') && path.resolve(arg('--ready-file'));
  const files = !process.argv.includes('--no-files');
  const mail = process.argv.includes('--mail');
  const signups = arg('--signups');
  if (signups !== null && !['open', 'invite', 'verified', 'closed'].includes(signups)) throw new Error(`Not a sign-up mode: ${signups}`);

  const server = await startRealServer({ port, files, mail, vars: signups ? { SIGNUPS: signups } : {} });
  // The Worker reports ready before its first request is served; a waiter that reads the file may call at once.
  const info = await server.call('GET', '/v1/info').catch((err) => ({ status: err.message }));
  if (info.status !== 200) {
    await server.close();
    throw new Error(`The server answered GET /v1/info with ${info.status}`);
  }

  const ready = { url: server.url, invite: server.inviteCode, pid: process.pid, previews: server.previewOrigin, mail: server.mail ? server.mail.origin : null };
  if (readyFile) {
    // Written whole and then renamed, so a waiter never reads half of it.
    fs.mkdirSync(path.dirname(readyFile), { recursive: true });
    const partial = `${readyFile}.${process.pid}.tmp`;
    fs.writeFileSync(partial, JSON.stringify(ready));
    fs.renameSync(partial, readyFile);
  }
  console.log(JSON.stringify(ready));

  let stopping = false;
  let watch = null;
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(watch);
    try {
      await server.close();
    } catch (err) {
      console.error(err);
      code = 1;
    }
    if (readyFile) fs.rmSync(readyFile, { force: true });
    process.exit(code);
  }
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  if (readyFile) {
    watch = setInterval(() => {
      if (!fs.existsSync(readyFile)) stop();
    }, POLL);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
