'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { UpdateInstaller, installKind } = require('../src/main/installer');

// Behaves like electron-updater's NsisUpdater/AppImageUpdater as far as installer.js uses it. feeds: folder →
// version its update description names; a version in `broken` fails to download.
function fakeUpdater({ feeds, broken = [] }) {
  const u = new EventEmitter();
  u.calls = [];
  u.setFeedURL = (opts) => {
    u.calls.push(['feed', opts.url]);
    u.feed = opts.url;
  };
  u.checkForUpdates = async () => {
    if (!(u.feed in feeds)) throw new Error('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
    return { updateInfo: { version: feeds[u.feed] } };
  };
  u.downloadUpdate = async () => {
    const version = feeds[u.feed];
    u.calls.push(['download', version]);
    u.emit('download-progress', { percent: 41.7 });
    await new Promise((r) => setTimeout(r, 5));
    if (broken.includes(version)) throw new Error('sha512 checksum mismatch');
    return [`/tmp/${version}`];
  };
  u.install = (silent, restart) => {
    u.calls.push(['install', silent, restart]);
    return true;
  };
  return u;
}

const found = (version, feed = `https://github.com/MajesteitBart/rukoo/releases/download/v${version}/`) => ({ version, feed });

test('only the Windows installer and the AppImage replace themselves', () => {
  assert.equal(installKind({ platform: 'win32', packaged: true, env: {} }), 'nsis');
  assert.equal(installKind({ platform: 'win32', packaged: true, env: { PORTABLE_EXECUTABLE_DIR: 'C:\\Apps' } }), null, 'portable');
  assert.equal(installKind({ platform: 'linux', packaged: true, env: { APPIMAGE: '/home/me/Rukoo.AppImage' } }), 'appimage');
  assert.equal(installKind({ platform: 'linux', packaged: true, env: {} }), null, 'the .deb package');
  assert.equal(installKind({ platform: 'darwin', packaged: true, env: {} }), null, 'ad-hoc signed Mac builds');
  assert.equal(installKind({ platform: 'win32', packaged: false, env: {} }), null, 'npm start');
  assert.equal(new UpdateInstaller({ kind: null }).state(), null);
});

test('a found release downloads from its own folder, reports progress, and installs at the end of a quit', async () => {
  const u = fakeUpdater({ feeds: { [found('2.1.1').feed]: '2.1.1' } });
  const installer = new UpdateInstaller({ kind: 'nsis', createUpdater: () => u });
  const seen = [];
  installer.on('changed', (s) => seen.push(`${s.status} ${s.percent}`));
  assert.equal(installer.install(), false, 'nothing to install yet');
  await installer.download(found('2.1.1'));
  assert.deepEqual(seen, ['downloading 0', 'downloading 41', 'ready 100']);
  assert.deepEqual(installer.state(), { status: 'ready', version: '2.1.1', percent: 100 });
  assert.equal(u.autoDownload, false);
  assert.equal(u.autoInstallOnAppQuit, false, 'Rukoo installs itself, after the windows have closed');
  assert.equal(u.allowPrerelease, true, 'updates.js already chose the channel');
  await installer.download(found('2.1.1'));
  assert.equal(u.calls.filter(([c]) => c === 'download').length, 1, 'the same release downloads once');
  assert.equal(installer.install({ restart: true }), true);
  assert.deepEqual(u.calls.at(-1), ['install', true, true], 'silent, and the new version starts');
});

test('a release without a feed, or another version in it, downloads nothing; a failure tries again next check', async () => {
  const u = fakeUpdater({ feeds: { [found('2.1.1').feed]: '2.1.0', [found('2.1.2').feed]: '2.1.2' }, broken: ['2.1.2'] });
  const installer = new UpdateInstaller({ kind: 'appimage', createUpdater: () => u });
  await installer.download({ version: '2.1.1', feed: null });
  assert.equal(installer.status, null);
  await installer.download(found('2.1.1'));
  assert.equal(installer.status, 'failed', "the folder's description is for another version");
  assert.equal(u.calls.some(([c]) => c === 'download'), false);
  await installer.download(found('2.1.2'));
  assert.deepEqual([installer.status, installer.install()], ['failed', false], 'a broken download never installs');
  await installer.download(found('2.1.2'));
  assert.deepEqual(u.calls.filter(([c]) => c === 'download').map(([, v]) => v), ['2.1.2', '2.1.2'], 'the next check tries again');
});

test('a newer release found while one downloads comes next', async () => {
  const feeds = { [found('2.1.1').feed]: '2.1.1', [found('2.1.2').feed]: '2.1.2' };
  const u = fakeUpdater({ feeds });
  const installer = new UpdateInstaller({ kind: 'nsis', createUpdater: () => u });
  const first = installer.download(found('2.1.1'));
  await installer.download(found('2.1.2'));
  await first;
  assert.deepEqual(u.calls.filter(([c]) => c === 'download').map(([, v]) => v), ['2.1.1', '2.1.2']);
  assert.deepEqual(installer.state(), { status: 'ready', version: '2.1.2', percent: 100 });
});
