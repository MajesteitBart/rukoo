'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { UpdateChecker, channelFor, compare, manifestName, newest } = require('../src/main/updates');

const release = (tag, extra = {}) => ({ tag_name: tag, name: tag, html_url: `https://github.com/MajesteitBart/rukoo/releases/tag/${tag}`, draft: false, prerelease: false, ...extra });

test('versions compare the way Semantic Versioning orders them', () => {
  assert.equal(compare('v2.0.0', '2.0.0'), 0);
  assert.equal(compare('v2.1.0', 'v2.0.9'), 1);
  assert.equal(compare('v2.0.0', 'v10.0.0'), -1);
  assert.equal(compare('v2.0.0-rc.1', 'v2.0.0'), -1);
  assert.equal(compare('v2.0.0-rc.2', 'v2.0.0-rc.10'), -1);
  assert.equal(compare('v2.0.0-beta.1', 'v2.0.0-rc.1'), -1);
  assert.equal(compare('nonsense', 'v1.0.0'), 0);
});

test('the newest published release above this version is offered, and nothing else', () => {
  const list = [release('v2.0.0'), release('v2.2.0', { draft: true }), release('v2.1.0'), release('v2.1.0-rc.1', { prerelease: true }), release('v1.6.0')];
  assert.deepEqual(newest(list, '2.0.0'), { version: '2.1.0', name: 'v2.1.0', url: 'https://github.com/MajesteitBart/rukoo/releases/tag/v2.1.0', prerelease: false, feed: null });
  assert.equal(newest(list, '2.1.0'), null, 'a draft is never offered');
  assert.equal(newest([release('v3.0.0', { html_url: 'https://evil.example/download' })], '2.0.0'), null, 'only GitHub pages open');
  assert.equal(newest('not a list', '2.0.0'), null);
});

async function fakeGitHub(t, body, status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/releases`, seen };
}

test('a check finds a newer release and says so once', async (t) => {
  const gh = await fakeGitHub(t, [release('v2.1.0'), release('v2.0.0')]);
  const checker = new UpdateChecker({ current: '2.0.0', url: gh.url });
  const events = [];
  checker.on('changed', (s) => events.push(s));
  const state = await checker.check();
  assert.equal(state.available.version, '2.1.0');
  assert.ok(state.checkedAt);
  await checker.check();
  assert.equal(events.length, 1, 'the same release again is no news');
  assert.match(gh.seen[0]['user-agent'], /^Rukoo\/2\.0\.0$/);
});

test('switched off, it asks nothing unless asked to; a failed answer keeps what it knew', async (t) => {
  const gh = await fakeGitHub(t, [release('v2.1.0')]);
  let on = false;
  const checker = new UpdateChecker({ current: '2.0.0', url: gh.url, enabled: () => on });
  assert.equal((await checker.check()).available, null);
  assert.equal(gh.seen.length, 0);
  assert.equal((await checker.check({ force: true })).available.version, '2.1.0');
  on = true;
  const broken = await fakeGitHub(t, 'not json');
  checker.url = broken.url;
  let state = await checker.check();
  assert.equal(state.available.version, '2.1.0');
  assert.equal(state.failed, true, 'Check now says it failed, not that Rukoo is up to date');
  const down = await fakeGitHub(t, { message: 'rate limited' }, 403);
  checker.url = down.url;
  state = await checker.check({ force: true });
  assert.deepEqual([state.available.version, state.failed], ['2.1.0', true]);
  checker.url = gh.url;
  assert.equal((await checker.check()).failed, false);
});

test('without a repository there is nothing to check', async () => {
  const checker = new UpdateChecker({ current: '2.0.0', repo: null });
  assert.equal(checker.url, null);
  assert.deepEqual(await checker.check({ force: true }), { current: '2.0.0', channel: 'stable', available: null, checkedAt: null, failed: false });
  assert.equal(new UpdateChecker({ current: '2.0.0', repo: 'MajesteitBart/rukoo' }).url, 'https://api.github.com/repos/MajesteitBart/rukoo/releases?per_page=100');
});

const nightly = (tag) => release(tag, { prerelease: true });
const withManifest = (r, name = 'latest.yml', base = `https://github.com/MajesteitBart/rukoo/releases/download/${r.tag_name}/`) => ({
  ...r,
  assets: [{ name: 'Rukoo-Mail-Setup.exe', browser_download_url: `${base}Rukoo-Mail-Setup.exe` }, { name, browser_download_url: `${base}${name}` }]
});

test('stable offers releases only; nightly also nightlies and release candidates', () => {
  const list = [release('v2.1.0'), nightly('v2.1.1-nightly.20261031.57'), nightly('v2.1.1-nightly.20261101.58'), nightly('v2.2.0-rc.1'), release('v2.3.0-rc.2')];
  assert.equal(newest(list, '2.1.0'), null, 'a stable install sees no pre-release, marked or not');
  assert.equal(newest(list, '2.1.0', { channel: 'nightly' }).version, '2.3.0-rc.2');
  assert.equal(newest(list.slice(0, 3), '2.1.0', { channel: 'nightly' }).version, '2.1.1-nightly.20261101.58', 'the newest nightly, by date and run');
  assert.equal(newest(list.slice(0, 3), '2.1.1-nightly.20261101.58', { channel: 'nightly' }), null);
  assert.equal(newest([...list.slice(0, 3), release('v2.1.1')], '2.1.1-nightly.20261101.58', { channel: 'nightly' }).version, '2.1.1', 'the release a nightly led up to');
  assert.equal(newest(list.slice(0, 3), '2.1.1-nightly.20261101.58', { channel: 'stable' }), null, 'back on stable, nothing older installs');
});

test('a nightly build follows nightly until the setting says otherwise', () => {
  assert.equal(channelFor(null, '2.1.1-nightly.20261031.57'), 'nightly');
  assert.equal(channelFor(null, '2.1.0'), 'stable');
  assert.equal(channelFor(null, '2.2.0-rc.1'), 'stable');
  assert.equal(channelFor('stable', '2.1.1-nightly.20261031.57'), 'stable');
  assert.equal(channelFor('nightly', '2.1.0'), 'nightly');
  assert.equal(channelFor('beta', '2.1.0'), 'stable');
});

test("the feed is the release's download folder, when it has this platform's update description", () => {
  assert.equal(manifestName('win32', 'x64'), 'latest.yml');
  assert.equal(manifestName('linux', 'x64'), 'latest-linux.yml');
  assert.equal(manifestName('linux', 'arm64'), 'latest-linux-arm64.yml');
  assert.equal(manifestName('darwin', 'arm64'), 'latest-mac.yml');
  const found = (r, opts) => newest([r], '2.0.0', { manifest: 'latest.yml', ...opts });
  assert.equal(found(withManifest(release('v2.1.0'))).feed, 'https://github.com/MajesteitBart/rukoo/releases/download/v2.1.0/');
  assert.equal(found(withManifest(release('v2.1.0'), 'latest-linux.yml')).feed, null, "another platform's description");
  assert.equal(found(release('v2.1.0')).feed, null, 'a release from before Rukoo updated itself');
  assert.equal(found(withManifest(release('v2.1.0'), 'latest.yml', 'https://evil.example/v2.1.0/')).feed, null, 'only GitHub release downloads');
  assert.equal(found(withManifest(release('v2.1.0'), 'latest.yml', 'http://127.0.0.1:4000/v2.1.0/')).feed, null);
  assert.equal(found(withManifest(release('v2.1.0'), 'latest.yml', 'http://127.0.0.1:4000/v2.1.0/'), { local: true }).feed, 'http://127.0.0.1:4000/v2.1.0/', 'a test server on this computer');
});

test('each check reads the channel, and says it checked even when nothing changed', async (t) => {
  const gh = await fakeGitHub(t, [release('v2.1.0'), nightly('v2.1.1-nightly.20261031.57')]);
  let channel = 'stable';
  const checker = new UpdateChecker({ current: '2.1.0', url: gh.url, channel: () => channel });
  const checked = [];
  checker.on('checked', (s) => checked.push(s.available && s.available.version));
  assert.equal((await checker.check()).available, null);
  channel = 'nightly';
  const state = await checker.check();
  assert.deepEqual([state.channel, state.available.version], ['nightly', '2.1.1-nightly.20261031.57']);
  await checker.check();
  assert.deepEqual(checked, [null, '2.1.1-nightly.20261031.57', '2.1.1-nightly.20261031.57']);
});
