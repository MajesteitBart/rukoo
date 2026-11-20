'use strict';

// The real-server helper (test/fixtures/real-server.js) and its command-line wrapper: what every chat test and
// Android's live tests rely on. Needs server/node_modules (npm ci --prefix server); skips without it, and fails
// without it in CI or with RUKOO_REQUIRE_REAL_SERVER=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { tempDir, removeDir } = require('./tmp');
const {
  startRealServer,
  connectRealServer,
  realServerAvailable,
  skipWithoutServer,
  uuidv7,
  mention,
  portLockFile,
  claimPort,
  releasePort,
  INVITE
} = require('./fixtures/real-server');
const keys = require('../src/main/account/crypto.js');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'a long enough password';
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let server;
test.before(async () => {
  if (realServerAvailable()) server = await startRealServer();
});
test.after(() => server?.close());

// Unref'd, so a timeout that lost its race doesn't keep the test process alive.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

async function until(check, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await sleep(20);
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

// Every process below pid, from the system's process table.
function descendants(pid) {
  let rows;
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
      { encoding: 'utf8', windowsHide: true }
    );
    rows = out.split(/\r?\n/);
  } else {
    rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n');
  }
  const children = new Map();
  for (const row of rows) {
    const [child, parent] = row.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const found = [];
  const queue = [pid];
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (child === pid || found.includes(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

test('the Worker binds 127.0.0.1 on a port from 38800 to 38899 and has team chat on', async (t) => {
  if (skipWithoutServer(t)) return;
  const url = new URL(server.url);
  assert.equal(url.hostname, '127.0.0.1');
  const port = Number(url.port);
  assert.ok(port >= 38800 && port <= 38899, `port ${port}`);
  assert.equal(server.url, `http://127.0.0.1:${port}`);
  assert.equal(server.inviteCode, INVITE);
  const info = await server.call('GET', '/v1/info');
  assert.equal(info.status, 200);
  assert.ok(info.body.features.includes('workspaces-v1'));
  // Nothing at the repository root: the bundle goes to the temporary folder and cf.json isn't fetched.
  assert.equal(fs.existsSync(path.join(ROOT, '.wrangler')), false);
  // The port's lock names this process.
  assert.equal(server.lockFile, portLockFile(port));
  assert.equal(fs.readFileSync(server.lockFile, 'utf8'), String(process.pid));
});

// A port from the range that nothing listens on and no helper has locked, counted down from the top so it rarely
// meets the helper's own picks.
async function unusedPort() {
  for (let p = 38899; p >= 38800; p--) if (!fs.existsSync(portLockFile(p)) && (await portFree(p))) return p;
  throw new Error('no free port from 38800 to 38899');
}

// A Node process that waits until it's killed, and the ID of one that has ended.
function sleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => {
    if (child.exitCode === null) process.kill(child.pid);
  });
  return child.pid;
}
async function endedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

// Removes a lock file this test wrote, unless a helper has taken it since.
function removeLock(file, ...owners) {
  try {
    if (owners.map(String).includes(fs.readFileSync(file, 'utf8'))) fs.rmSync(file, { force: true });
  } catch (_) {
    // Already gone.
  }
}

test("a port another living process has locked isn't used, and its lock stays", async (t) => {
  if (skipWithoutServer(t)) return;
  const port = await unusedPort();
  const file = portLockFile(port);
  const other = sleeper(t);
  fs.writeFileSync(file, String(other));
  t.after(() => removeLock(file, other));
  await assert.rejects(startRealServer({ port }), /in use by another test server/);
  assert.equal(fs.readFileSync(file, 'utf8'), String(other));
});

test('a lock left by a process that ended is taken over, and close() removes it', async (t) => {
  if (skipWithoutServer(t)) return;
  const port = await unusedPort();
  const file = portLockFile(port);
  const ended = await endedPid();
  fs.writeFileSync(file, String(ended));
  t.after(() => removeLock(file, ended, process.pid));
  const own = await startRealServer({ port });
  try {
    assert.equal(own.url, `http://127.0.0.1:${port}`);
    assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
    // stop() and start() keep the lock.
    await own.stop();
    assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
    await own.start();
  } finally {
    await own.close();
  }
  assert.equal(fs.existsSync(file), false);
});

// The takeover of a stale lock is one process's at a time. Before the guard, one process could move aside the lock
// another had just made in place of the stale one, and a third then made its own: two owners of one port.
test('a stale lock is left alone while another process takes it over, and a guard left behind goes', async (t) => {
  const port = await unusedPort();
  const file = portLockFile(port);
  const guard = `${file}.takeover`;
  const ended = await endedPid();
  fs.writeFileSync(file, String(ended));
  fs.writeFileSync(guard, String(ended));
  t.after(() => {
    fs.rmSync(guard, { force: true });
    removeLock(file, ended, process.pid);
  });
  assert.equal(claimPort(port), false, 'a takeover under way keeps the port');
  assert.equal(fs.readFileSync(file, 'utf8'), String(ended));
  assert.ok(fs.existsSync(guard));
  // A guard older than ten seconds was left by a process that ended mid-takeover. It goes, and the next claim takes
  // the stale lock over.
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(guard, old, old);
  assert.equal(claimPort(port), false);
  assert.equal(fs.existsSync(guard), false);
  assert.equal(claimPort(port), true);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  assert.equal(fs.existsSync(guard), false, 'the takeover removes its guard');
  releasePort(port);
  assert.equal(fs.existsSync(file), false);
});

test('processes that claim one stale lock at the same moment: exactly one gets it', async (t) => {
  const port = await unusedPort();
  const file = portLockFile(port);
  const ended = await endedPid();
  fs.writeFileSync(file, String(ended));
  t.after(() => fs.rmSync(`${file}.takeover`, { force: true }));
  // Each child waits for the same moment, claims, says whether it got the port and holds it until its stdin closes,
  // so a winner that ended early can't hand the port to a later claimant.
  const at = Date.now() + 1500;
  const script = `
    const { claimPort } = require(${JSON.stringify(path.join(__dirname, 'fixtures', 'real-server.js'))});
    while (Date.now() < ${at}) {}
    process.stdout.write(String(claimPort(${port})) + '\\n');
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
  `;
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', script], { windowsHide: true }));
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
  const answers = await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve, reject) => {
          let out = '';
          child.stdout.on('data', (chunk) => {
            out += chunk;
            if (out.includes('\n')) resolve(out.trim());
          });
          child.once('exit', (code) => reject(new Error(`a claimant ended with ${code} before answering`)));
        })
    )
  );
  const winners = children.filter((_, i) => answers[i] === 'true');
  assert.equal(winners.length, 1, `answers: ${answers.join(', ')}`);
  assert.equal(fs.readFileSync(file, 'utf8'), String(winners[0].pid));
  const exits = children.map((child) => new Promise((resolve) => child.once('exit', resolve)));
  for (const child of children) child.stdin.end();
  await Promise.all(exits);
  assert.equal(fs.existsSync(file), false, "the winner's exit frees the port");
});

// Two test processes that start a server on one port within milliseconds: without the lock both got it without an
// error and then shared requests.
test('two processes starting on one port at the same moment: one gets it, the other an error', async (t) => {
  if (skipWithoutServer(t)) return;
  const dir = tempDir('rukoo-real-server-race-');
  t.after(() => removeDir(dir));
  const port = await unusedPort();
  const script = path.join(dir, 'race.js');
  fs.writeFileSync(
    script,
    [
      `const { startRealServer } = require(${JSON.stringify(path.join(__dirname, 'fixtures', 'real-server.js'))});`,
      'const [port, at] = process.argv.slice(2).map(Number);',
      '(async () => {',
      '  while (Date.now() < at) await new Promise((r) => setTimeout(r, 1));',
      '  let server;',
      '  try { server = await startRealServer({ port }); } catch (err) { console.log(JSON.stringify({ error: err.message })); return; }',
      "  const r = await server.call('GET', '/v1/info');",
      '  console.log(JSON.stringify({ url: server.url, status: r.status }));',
      '  await new Promise((r) => setTimeout(r, 3000));',
      '  await server.close();',
      '})();'
    ].join('\n')
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const at = Date.now() + 1500;
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, String(port), String(at)], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.once('exit', () => {
        try {
          resolve(JSON.parse(out.trim().split('\n').at(-1)));
        } catch (_) {
          resolve({ output: out });
        }
      });
    });
  const results = await Promise.all([run(), run()]);
  const won = results.filter((r) => r.url);
  const lost = results.filter((r) => r.error);
  assert.equal(won.length, 1, JSON.stringify(results));
  assert.deepEqual(won[0], { url: `http://127.0.0.1:${port}`, status: 200 });
  assert.equal(lost.length, 1, JSON.stringify(results));
  assert.match(lost[0].error, /in use/);
  assert.equal(fs.existsSync(portLockFile(port)), false);
});

test('two seeded accounts: random keys, and a password the desktop signs in with', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  assert.match(olga.email, /^person-\d+-[0-9a-f]{8}@example\.com$/);
  assert.equal(typeof olga.token, 'string');
  assert.equal((await server.call('GET', '/v1/workspaces', { token: olga.token })).status, 200);

  const bart = await server.seedAccount({ email: 'Bart@Example.com', password: PASSWORD });
  assert.equal(bart.email, 'bart@example.com');
  assert.ok(bart.recoveryKey);
  // The steps AccountService.login takes, with the desktop's own key code: prelogin, password keys for the server's
  // address, login, and the data key unwraps.
  const pre = await server.call('POST', '/v1/prelogin', { body: { email: bart.email } });
  assert.equal(pre.status, 200);
  const { authKey, wrapKey } = await keys.passwordKeys(PASSWORD, keys.unb64u(pre.body.salt, 16), keys.checkKdf(pre.body.kdf), server.url);
  const login = await server.call('POST', '/v1/login', { body: { email: bart.email, authKey: keys.b64u(authKey), device: { name: 'Test', platform: 'linux' } } });
  assert.equal(login.status, 200, login.text);
  assert.equal(keys.unwrapDataKey(wrapKey, keys.unb64u(login.body.wrappedKey)).length, 32);
});

test('a workspace, an invitation link and a member who is in general', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  assert.match(ws.id, /^w_[A-Za-z0-9_-]{22}$/);
  assert.equal(ws.owner, olga);
  assert.ok(ws.general);

  const made = await server.createInvite(olga, ws.id, { role: 'member' });
  assert.match(made.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(made.link, `${server.url}/join#w=${ws.id}&i=${made.secret}`);
  assert.ok(made.invite.id);

  const me = await server.seedMember(ws, bart, 'Bart');
  assert.equal(me.name, 'Bart');
  const general = (await server.channels(bart, ws.id)).find((c) => c.id === ws.general);
  assert.equal(general.joined, true);
  const members = await server.call('GET', `/v1/workspaces/${ws.id}/members`, { token: olga.token });
  assert.equal(members.status, 200);
  assert.ok(members.body.members.some((m) => m.id === me.id));
});

test("a post wakes the member's socket, opened with the ticket in the Authorization header, within 2 s", async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga);
  await server.seedMember(ws, bart, 'Bart');
  const live = await server.openSocket(bart, ws.id);
  t.after(() => live.close());
  assert.equal(live.socket.protocol, 'rukoo.workspace.v1');

  const started = Date.now();
  const posted = await server.post(olga, ws.id, ws.general, 'Welcome, Bart');
  await until(() => live.frames.length > 0, 2000, 'the wake');
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(live.frames, ['{"t":"wake"}']);
  assert.match(posted.operationId, UUIDV7);

  const events = await server.call('GET', `/v1/workspaces/${ws.id}/conversations/${ws.general}/events?after=0`, { token: bart.token });
  assert.equal(events.status, 200);
  assert.equal(events.body.events.at(-1).text, 'Welcome, Bart');
});

test('a private channel with a member, a mention past an accent, a removal and a read position', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const zoe = await server.seedAccount();
  const ws = await server.seedWorkspace(olga);
  const zoeMe = await server.seedMember(ws, zoe, 'Zoë');
  const channel = await server.seedChannel(olga, ws.id, { name: 'plans', visibility: 'private', members: [zoeMe.id] });
  assert.equal(channel.visibility, 'private');
  assert.ok((await server.channels(zoe, ws.id)).some((c) => c.id === channel.id && c.joined));

  const text = 'Hoi Zoë en @Zoë!';
  const at = mention(text, '@Zoë', zoeMe.id);
  assert.deepEqual(at, { actor: zoeMe.id, start: 12, end: 17 });
  const posted = await server.post(olga, ws.id, channel.id, text, { mentions: [at] });
  const page = await server.call('GET', `/v1/workspaces/${ws.id}/conversations/${channel.id}/events?after=0`, { token: zoe.token });
  const event = page.body.events.find((e) => e.id === posted.messageId);
  assert.deepEqual(event.mentions, [at]);

  const removed = await server.redact(olga, ws.id, channel.id, posted.messageId);
  assert.equal(removed.redacted, true);
  const after = await server.call('GET', `/v1/workspaces/${ws.id}/conversations/${channel.id}/events?after=0`, { token: zoe.token });
  const gone = after.body.events.find((e) => e.id === posted.messageId);
  assert.equal(gone.redacted, true);
  assert.equal(gone.text, undefined);

  const head = after.body.head;
  assert.deepEqual(await server.read(zoe, ws.id, channel.id, head), { read: head });
});

test('blocks and direct messages, once the server has their routes', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga);
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  if ((await server.call('GET', `/v1/workspaces/${ws.id}/blocks`, { token: olga.token })).status === 404) {
    t.skip('this server has no DM and block routes yet');
    return;
  }
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  assert.ok(dm.conversation);
  assert.equal((await server.seedDm(olga, ws.id, [bartMe.id])).conversation, dm.conversation);
  const blocked = await server.block(olga, ws.id, bartMe.id);
  assert.equal(blocked.member, bartMe.id);
});

test('stop() then start() keeps the address, the session and the message; an open socket closes on the stop', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const ws = await server.seedWorkspace(olga);
  await server.post(olga, ws.id, ws.general, 'Before the restart');
  const live = await server.openSocket(olga, ws.id);
  const closed = new Promise((resolve) => live.socket.addEventListener('close', (e) => resolve(e.code), { once: true }));
  const url = server.url;

  await server.stop();
  assert.ok(typeof (await Promise.race([closed, sleep(3000).then(() => 'still open')])) === 'number');
  await assert.rejects(server.call('GET', '/v1/info'));

  await server.start();
  assert.equal(server.url, url);
  const events = await server.call('GET', `/v1/workspaces/${ws.id}/conversations/${ws.general}/events?after=0`, { token: olga.token });
  assert.equal(events.status, 200);
  assert.equal(events.body.events.at(-1).text, 'Before the restart');
});

test('close() stops the server and removes its temporary folder, and can be called twice', async (t) => {
  if (skipWithoutServer(t)) return;
  const own = await startRealServer();
  assert.ok(fs.existsSync(own.dir));
  assert.notEqual(own.url, server.url);
  assert.ok(fs.existsSync(own.lockFile));
  await own.close();
  assert.equal(fs.existsSync(own.dir), false);
  assert.equal(fs.existsSync(own.lockFile), false);
  // The shared server keeps its own lock.
  assert.ok(fs.existsSync(server.lockFile));
  await own.close();
  await assert.rejects(own.call('GET', '/v1/info'));
});

test('the command line writes { url, invite, pid }, connectRealServer seeds against it, and deleting the file stops it', async (t) => {
  if (skipWithoutServer(t)) return;
  const dir = tempDir('rukoo-real-server-cli-');
  t.after(() => removeDir(dir));
  const readyFile = path.join(dir, 'ready', 'rukoo-server.json');
  const port = await unusedPort();

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'real-server-cli.js'), '--port', String(port), '--ready-file', readyFile], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  await until(() => fs.existsSync(readyFile) || child.exitCode !== null, 30000, 'the ready file');
  assert.equal(child.exitCode, null, output);
  const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  assert.deepEqual(ready, { url: `http://127.0.0.1:${port}`, invite: INVITE, pid: child.pid });

  const remote = connectRealServer(ready.url);
  assert.equal(remote.stop, undefined);
  assert.equal(remote.close, undefined);
  const olga = await remote.seedAccount();
  const bart = await remote.seedAccount({ password: PASSWORD });
  const ws = await remote.seedWorkspace(olga);
  await remote.seedMember(ws, bart, 'Bart');
  const posted = await remote.post(olga, ws.id, ws.general, 'Through the command line');
  assert.ok(posted.seq > 0);

  const below = descendants(child.pid);
  assert.ok(below.length > 0, 'workerd runs under the command line');
  fs.rmSync(readyFile);
  assert.equal(await Promise.race([exited, sleep(15000).then(() => 'still running')]), 0, output);
  await until(() => below.every((pid) => !alive(pid)), 5000, `the processes ${below.join(', ')} to end`);
  assert.equal(await portFree(port), true);
  assert.equal(fs.existsSync(portLockFile(port)), false);
});

test('uuidv7 puts the time in the first 48 bits', () => {
  const id = uuidv7(1763550000000);
  assert.match(id, UUIDV7);
  assert.equal(parseInt(id.replace(/-/g, '').slice(0, 12), 16), 1763550000000);
});

// A copy of the helper in a folder whose server/ has no node_modules, run as its own test process.
test('without server/node_modules a test skips with the message, and fails in CI or with RUKOO_REQUIRE_REAL_SERVER=1', () => {
  const root = tempDir('rukoo-real-server-missing-');
  try {
    for (const file of ['test/fixtures/real-server.js', 'test/tmp.js', 'src/main/account/client.js']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
    }
    fs.mkdirSync(path.join(root, 'server'));
    const probe = path.join(root, 'test', 'probe.test.js');
    fs.writeFileSync(
      probe,
      [
        "const test = require('node:test');",
        "const { skipWithoutServer, startRealServer } = require('./fixtures/real-server');",
        "test('needs the server', async (t) => { if (skipWithoutServer(t)) return; await startRealServer(); });"
      ].join('\n')
    );
    const run = (extra) => {
      const env = { ...process.env, ...extra };
      for (const name of ['CI', 'RUKOO_REQUIRE_REAL_SERVER', 'NODE_TEST_CONTEXT']) if (!(name in extra)) delete env[name];
      try {
        return { code: 0, out: execFileSync(process.execPath, ['--test', '--test-reporter=tap', probe], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }) };
      } catch (err) {
        return { code: err.status, out: `${err.stdout}${err.stderr}` };
      }
    };

    const skipped = run({});
    assert.equal(skipped.code, 0, skipped.out);
    assert.match(skipped.out, /# SKIP run npm ci in server\/ to test chat against the real server/);

    const required = run({ RUKOO_REQUIRE_REAL_SERVER: '1' });
    assert.notEqual(required.code, 0, required.out);
    assert.match(required.out, /The real account server is missing: run npm ci in server\//);

    const ci = run({ CI: 'true' });
    assert.notEqual(ci.code, 0, ci.out);
  } finally {
    removeDir(root);
  }
});
