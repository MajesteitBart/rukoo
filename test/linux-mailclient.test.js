'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { LinuxMailClient, DESKTOP } = require('../src/main/linux-mailclient');

test('Linux mail links require an installed desktop entry and use xdg-mime without a shell', async () => {
  const calls = [];
  let current = 'other.desktop';
  const client = new LinuxMailClient({ env: { XDG_DATA_HOME: '/test/share', XDG_DATA_DIRS: '/usr/share' }, exists: (p) => p === path.join('/test/share', 'applications', DESKTOP), run: async (args) => {
    calls.push(args);
    if (args[0] === 'default') current = args[1];
    return `${current}\n`;
  } });
  assert.deepEqual(await client.status(), { available: true, app: 'other.desktop', rukoo: false });
  assert.equal(await client.register(), true);
  assert.deepEqual(calls[1], ['default', DESKTOP, 'x-scheme-handler/mailto']);
});

test('missing desktop entries never change a default; missing xdg-utils is tolerated on read', async () => {
  let calls = 0;
  const client = new LinuxMailClient({ exists: () => false, run: async () => { calls++; throw new Error('ENOENT'); } });
  assert.equal(await client.register(), false);
  assert.equal(calls, 0);
  assert.deepEqual(await client.status(), { available: false, app: null, rukoo: false });
});

test('a desktop refusing the association is reported as a failure', async () => {
  const client = new LinuxMailClient({ exists: () => true, run: async () => 'other.desktop' });
  assert.equal(await client.register(), false);
});

test('missing xdg-utils reports registration failure', async () => {
  const client = new LinuxMailClient({ exists: () => true, run: async () => { throw new Error('ENOENT'); } });
  assert.equal(await client.register(), false);
});
