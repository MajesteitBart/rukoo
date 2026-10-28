'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { UpdateChecker, compare, newest } = require('../src/main/updates');

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
  assert.deepEqual(newest(list, '2.0.0'), { version: '2.1.0', name: 'v2.1.0', url: 'https://github.com/MajesteitBart/rukoo/releases/tag/v2.1.0', prerelease: false });
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
  assert.deepEqual(await checker.check({ force: true }), { current: '2.0.0', available: null, checkedAt: null, failed: false });
  assert.equal(new UpdateChecker({ current: '2.0.0', repo: 'MajesteitBart/rukoo' }).url, 'https://api.github.com/repos/MajesteitBart/rukoo/releases?per_page=20');
});
