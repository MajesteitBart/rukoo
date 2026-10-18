'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tempDir } = require('./tmp');
const { onPath, resolveExe, start, cliPath, cleanEnv } = require('../src/main/agents/proc');
const { CodexAdapter } = require('../src/main/agents/codex');

function fixture(t) {
  const dir = tempDir('rukoo-agent-discovery-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('POSIX discovery finds executable symlinks without which and skips non-executable files', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fixture(t);
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'bin with spaces');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const blocked = path.join(first, 'codex');
  fs.writeFileSync(blocked, 'not executable', { mode: 0o600 });
  const script = path.join(dir, 'launcher');
  fs.writeFileSync(script, '#!/bin/sh\nprintf "agent-ready"\n', { mode: 0o700 });
  const executable = path.join(second, 'codex');
  fs.symlinkSync(script, executable);
  const oldPath = process.env.PATH;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  process.env.PATH = [first, second].join(path.delimiter);
  assert.deepEqual(await onPath('codex', { platform: 'linux' }), [executable]);
  assert.equal(await resolveExe([blocked], 'codex'), executable);
  assert.equal(await resolveExe([blocked], null), null);
  assert.equal(await resolveExe([second], null), null);
  const child = start(executable, []);
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0);
  assert.equal(output, 'agent-ready');
});

test('Codex finds a per-user Linux installation when the desktop PATH omits it', { skip: process.platform === 'win32' }, async (t) => {
  const home = fixture(t);
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'codex');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  t.mock.method(os, 'homedir', () => home);
  const adapter = new CodexAdapter({ config: () => ({ enabled: true }) });
  assert.equal(await adapter.exe(), executable);
  assert.equal(adapter.defaultExe(), executable);
});

test('macOS supplements Finder PATH with local and both Homebrew locations without changing inherited precedence', () => {
  const base = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', KEEP: 'yes', CODEX_THREAD_ID: 'private' };
  const options = { platform: 'darwin', home: '/Users/Mail User' };
  const expected = '/usr/bin:/bin:/usr/sbin:/sbin:/Users/Mail User/.local/bin:/opt/homebrew/bin:/usr/local/bin';
  assert.equal(cliPath(base, options), expected);
  assert.equal(cliPath({}, options), expected);
  assert.deepEqual(cleanEnv({}, base, options), { PATH: expected, KEEP: 'yes' });
  assert.equal(base.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'does not mutate the parent environment');
  assert.equal(cliPath({ PATH: '/usr/local/bin:/usr/bin:/opt/homebrew/bin' }, options), '/usr/local/bin:/usr/bin:/opt/homebrew/bin:/Users/Mail User/.local/bin');
  for (const platform of ['linux', 'win32']) {
    assert.equal(cliPath(base, { platform }), base.PATH);
    assert.deepEqual(cleanEnv({}, { KEEP: 'yes' }, { platform }), { KEEP: 'yes' });
  }
});

test('macOS discovery and child PATH agree for npm launchers that need env node', { skip: process.platform === 'win32' }, async (t) => {
  const home = fixture(t);
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'rukoo-fake-agent');
  fs.writeFileSync(executable, '#!/usr/bin/env node\nprocess.stdout.write("node-ready");\n', { mode: 0o700 });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const options = { platform: 'darwin', home };
  const base = { PATH: path.join(home, 'empty-path') };
  assert.deepEqual(await onPath('rukoo-fake-agent', { ...options, env: base }), [executable]);
  const child = start(executable, [], { env: cleanEnv({}, base, options) });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0);
  assert.equal(output, 'node-ready');
});
