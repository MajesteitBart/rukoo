'use strict';

// Video services for bookings (src/main/video): Jitsi rooms without an account, and Zoom and Microsoft Teams against a
// fake of their sign-in and meeting APIs (test/fixtures/video-services.js): the client from the environment or a file,
// the browser sign-in with PKCE, refresh with rotating tokens, making, moving and deleting a meeting, a sign-in that
// stopped working, and the services' failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { videoServer } = require('./fixtures/video-services');
const { VideoServices, withMeeting } = require('../src/main/video');
const { jitsi, roomName, serverAddress } = require('../src/main/video/jitsi');
const { zoom } = require('../src/main/video/zoom');
const { teams } = require('../src/main/video/teams');
const { VIDEO_SERVICES } = require('../src/main/booking/rules');

const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
const MEETING = { title: '30 minute meeting: Bart and Jane Doe', start: Date.UTC(2026, 10, 3, 9), end: Date.UTC(2026, 10, 3, 9, 30), timeZone: 'Europe/Amsterdam' };

async function fake(t) {
  const s = await videoServer();
  t.after(() => s.close());
  return s;
}

// The video services of one computer, with the fake's endpoints; env: its environment.
function services(s, { env = {}, dir = tempDir('rukoo-video-'), now } = {}) {
  const v = new VideoServices({
    dataDir: path.join(dir, 'data'),
    configDir: dir,
    secrets,
    env,
    now,
    openBrowser: s ? s.openBrowser : () => {},
    adapters: [jitsi(), zoom({ endpoints: s ? s.zoomEndpoints : {} }), teams({ endpoints: s ? s.teamsEndpoints : {} })]
  }).init();
  return { v, dir };
}

const byId = (state, id) => state.services.find((x) => x.id === id);

test('every service a meeting type can name has an adapter with the same name', () => {
  const { v } = services(null);
  assert.deepEqual(Object.fromEntries(v.state().services.map((x) => [x.id, x.name])), VIDEO_SERVICES);
});

test('Jitsi turns on without an account and gives each meeting its own room nobody can guess', async () => {
  const { v, dir } = services(null);
  assert.equal(v.status('jitsi'), 'off');
  await assert.rejects(v.create('jitsi', MEETING), (err) => err.code === 'off' && /Jitsi Meet isn't connected/.test(err.message));

  await v.connect('jitsi');
  assert.equal(v.status('jitsi'), 'connected');
  const one = await v.create('jitsi', MEETING);
  const two = await v.create('jitsi', MEETING);
  assert.equal(one.service, 'jitsi');
  assert.match(one.url, /^https:\/\/meet\.jit\.si\/rukoo-[a-z]{22}$/);
  assert.equal(one.url, `https://meet.jit.si/${one.id}`);
  assert.notEqual(one.id, two.id);
  assert.ok(!one.url.includes('Jane'), 'nothing from the booking is in the room name');
  // A room has no time and nothing to delete.
  await v.update(one, MEETING);
  await v.remove(one);

  // A server of the host's own; meet.jit.si again when it is emptied.
  v.setRoom('jitsi', { server: 'jitsi.example.org/team/' });
  assert.equal(byId(v.state(), 'jitsi').server, 'https://jitsi.example.org/team');
  assert.match((await v.create('jitsi', MEETING)).url, /^https:\/\/jitsi\.example\.org\/team\/rukoo-[a-z]{22}$/);
  for (const bad of ['http://jitsi.example.org', 'https://user:pw@jitsi.example.org', 'https://jitsi.example.org/?room=1', 'ftp://x']) {
    assert.throws(() => v.setRoom('jitsi', { server: bad }), (err) => err.code === 'invalid', bad);
  }
  // It stays as it was after a restart.
  const again = new VideoServices({ dataDir: path.join(dir, 'data'), configDir: dir, secrets, env: {} }).init();
  assert.equal(again.status('jitsi'), 'connected');
  assert.equal(byId(again.state(), 'jitsi').server, 'https://jitsi.example.org/team');
  again.setRoom('jitsi', { server: '' });
  assert.equal(byId(again.state(), 'jitsi').server, 'https://meet.jit.si');
  again.disconnect('jitsi');
  assert.equal(again.status('jitsi'), 'off');
});

test('a room name is 22 letters, each equally likely, after rukoo-', () => {
  let i = 0;
  // Bytes from 234 up are skipped rather than folded onto the first letters.
  const bytes = Buffer.from([255, 234, 0, 25, 26, 233, ...Array(48).fill(1)]);
  const name = roomName(() => bytes.subarray(i, (i += 48)));
  // 0 → a, 25 → z, 26 → a, 233 → z (233 = 8 × 26 + 25), then 1s.
  assert.equal(name, `rukoo-azaz${'b'.repeat(18)}`);
  assert.equal(serverAddress('meet.jit.si'), '', 'the default is kept as empty');
});

test('Zoom and Teams are unavailable without an OAuth client, and take one from the environment or a client file', async (t) => {
  const s = await fake(t);
  const { v, dir } = services(s);
  const state = v.state();
  assert.equal(byId(state, 'zoom').status, 'unavailable');
  assert.equal(byId(state, 'teams').status, 'unavailable');
  await assert.rejects(v.connect('zoom'), (err) => err.code === 'unavailable' && /Zoom needs an OAuth app/.test(err.message));
  await assert.rejects(v.create('teams', MEETING), (err) => err.code === 'off');

  const file = path.join(dir, 'chosen.json');
  fs.writeFileSync(file, JSON.stringify({ nothing: true }));
  assert.throws(() => v.importClient('zoom', file), (err) => /no client_id for Zoom/.test(err.message));
  fs.writeFileSync(file, JSON.stringify({ client_id: 'zoom-client', client_secret: 'zoom-secret', extra: 'dropped' }));
  v.importClient('zoom', file);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'zoom-oauth.json'), 'utf8')), { client_id: 'zoom-client', client_secret: 'zoom-secret' });
  assert.equal(v.status('zoom'), 'off');
  assert.deepEqual(v.client('zoom'), { id: 'zoom-client', secret: 'zoom-secret', tenant: null });

  const env = services(s, { env: { SEM_TEAMS_CLIENT_ID: 'teams-client', SEM_TEAMS_TENANT: 'contoso.example' } }).v;
  assert.equal(env.status('teams'), 'off');
  assert.deepEqual(env.client('teams'), { id: 'teams-client', secret: null, tenant: 'contoso.example' });
});

test('Zoom signs in with PKCE on a 127.0.0.1 loopback, keeps the refresh token encrypted, and makes, moves and deletes meetings', async (t) => {
  const s = await fake(t);
  const { v } = services(s, { env: { SEM_ZOOM_CLIENT_ID: 'zoom-client', SEM_ZOOM_CLIENT_SECRET: 'zoom-secret' } });
  const seen = [];
  v.on('changed', (st) => seen.push(st.pending));
  await v.connect('zoom');

  // The sign-in page: Rukoo's client, S256, and a redirect Zoom matches without the port.
  const q = s.opened.searchParams;
  assert.equal(s.opened.pathname, '/zoom/oauth/authorize');
  assert.equal(q.get('client_id'), 'zoom-client');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(q.get('scope'), null, "Zoom's scopes come from the app's settings");
  assert.ok(seen.includes('zoom'), 'Settings saw the sign-in open');
  assert.match(s.pages[0], /You are signed in/);
  // A confidential client's secret goes as Basic authentication, with the verifier in the form.
  const exchange = s.requests.find((r) => r.form.grant_type === 'authorization_code');
  assert.equal(exchange.headers.authorization, `Basic ${Buffer.from('zoom-client:zoom-secret').toString('base64')}`);
  assert.equal(exchange.form.client_secret, undefined);
  assert.ok(exchange.form.code_verifier.length >= 43);

  const state = v.state();
  assert.equal(byId(state, 'zoom').status, 'connected');
  assert.deepEqual(byId(state, 'zoom').account, { email: 'host@example.com', name: 'Bart Host' });
  assert.equal(state.pending, null);
  const stored = fs.readFileSync(v.path, 'utf8');
  assert.ok(!stored.includes('zoom-refresh-'), 'the refresh token is stored encrypted');
  assert.equal(secrets.decrypt(JSON.parse(stored).accounts.zoom.secret), [...s.refresh.keys()][0]);

  const made = await v.create('zoom', MEETING);
  assert.equal(made.service, 'zoom');
  assert.match(made.url, /^https:\/\/us05web\.zoom\.us\/j\/\d+\?pwd=/);
  assert.deepEqual(s.meetings.get(made.id), { service: 'zoom', topic: MEETING.title, type: 2, start_time: '2026-11-03T09:00:00Z', duration: 30, timezone: 'Europe/Amsterdam' });

  await v.update(made, { ...MEETING, start: MEETING.start + 3600000, end: MEETING.end + 3600000 + 1800000 });
  assert.equal(s.meetings.get(made.id).start_time, '2026-11-03T10:00:00Z');
  assert.equal(s.meetings.get(made.id).duration, 60);
  await v.remove(made);
  assert.equal(s.meetings.has(made.id), false);
  // Gone already: deleting it again is done.
  await v.remove(made);
  // Moving one that was deleted in Zoom says so.
  await assert.rejects(v.update(made, MEETING), (err) => err.code === 'not_found' && /no longer has this meeting/.test(err.message));
});

test('a public Zoom client without a secret sends its id in the form', async (t) => {
  const s = await fake(t);
  const { v } = services(s, { env: { SEM_ZOOM_CLIENT_ID: 'zoom-public' } });
  await v.connect('zoom');
  const exchange = s.requests.find((r) => r.form.grant_type === 'authorization_code');
  assert.equal(exchange.headers.authorization, undefined);
  assert.equal(exchange.form.client_id, 'zoom-public');
});

test('an expired access token is refreshed once for calls at the same time, and the rotated refresh token is kept', async (t) => {
  const s = await fake(t);
  let clock = Date.UTC(2026, 9, 30, 12);
  const { v, dir } = services(s, { env: { SEM_ZOOM_CLIENT_ID: 'zoom-client' }, now: () => clock });
  await v.connect('zoom');
  const first = [...s.refresh.keys()][0];
  clock += 2 * 3600000;
  const [a, b] = await Promise.all([v.create('zoom', MEETING), v.create('zoom', MEETING)]);
  assert.notEqual(a.id, b.id);
  const refreshes = s.requests.filter((r) => r.form.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1, 'one refresh for both');
  assert.equal(refreshes[0].form.refresh_token, first);
  const now = [...s.refresh.keys()];
  assert.equal(now.length, 1);
  assert.notEqual(now[0], first, 'Zoom rotated it');
  // The new one is what a restart refreshes with.
  const again = new VideoServices({ dataDir: path.join(dir, 'data'), configDir: dir, secrets, env: { SEM_ZOOM_CLIENT_ID: 'zoom-client' }, adapters: [jitsi(), zoom({ endpoints: s.zoomEndpoints }), teams()] }).init();
  await again.create('zoom', MEETING);
  assert.equal(s.requests.filter((r) => r.form.grant_type === 'refresh_token').pop().form.refresh_token, now[0]);
});

test('a revoked sign-in turns into "needs renewing", and signing in again renews it', async (t) => {
  const s = await fake(t);
  let clock = Date.UTC(2026, 9, 30, 12);
  const { v } = services(s, { env: { SEM_ZOOM_CLIENT_ID: 'zoom-client' }, now: () => clock });
  await v.connect('zoom');
  // Revoked in the Zoom account: refresh tokens stop working.
  s.refresh.clear();
  clock += 2 * 3600000;
  const changes = [];
  v.on('changed', (st) => changes.push(byId(st, 'zoom').status));
  await assert.rejects(v.create('zoom', MEETING), (err) => err.code === 'renew' && /Zoom connection needs renewing/.test(err.message));
  assert.equal(v.status('zoom'), 'renew');
  assert.deepEqual(changes, ['renew']);
  // It stays so without asking Zoom again.
  const before = s.requests.length;
  await assert.rejects(v.create('zoom', MEETING), (err) => err.code === 'renew');
  assert.equal(s.requests.length, before);

  await v.connect('zoom');
  assert.equal(v.status('zoom'), 'connected');
  assert.ok(await v.create('zoom', MEETING));
});

test('an access token the API turns down is refreshed and tried once more; turned down again, the sign-in needs renewing', async (t) => {
  const s = await fake(t);
  const { v } = services(s, { env: { SEM_ZOOM_CLIENT_ID: 'zoom-client' } });
  await v.connect('zoom');
  // The token is cut off on Zoom's side before it expires.
  s.access.clear();
  const made = await v.create('zoom', MEETING);
  assert.ok(made.url);
  assert.equal(s.requests.filter((r) => r.form.grant_type === 'refresh_token').length, 1);

  // Every token turned down: after one refresh, renew.
  s.fail = (r) => (r.path.startsWith('/zoom/v2/') ? [401, { code: 124, message: 'Invalid access token.' }] : null);
  await assert.rejects(v.create('zoom', MEETING), (err) => err.code === 'renew');
  assert.equal(v.status('zoom'), 'renew');
});

test("the services' failures say what happened: refused, broken, unreachable", async (t) => {
  const s = await fake(t);
  const { v } = services(s, { env: { SEM_ZOOM_CLIENT_ID: 'zoom-client', SEM_TEAMS_CLIENT_ID: 'teams-client' } });
  await v.connect('zoom');
  await v.connect('teams');

  s.fail = (r) => (r.method === 'POST' && r.path.endsWith('/meetings') ? [400, { code: 3161, message: 'Your user account is not allowed meeting hosting and scheduling capabilities.' }] : null);
  await assert.rejects(v.create('zoom', MEETING), (err) => err.code === 'refused' && err.message === 'Zoom refused the request: Your user account is not allowed meeting hosting and scheduling capabilities.');
  s.fail = (r) => (r.path === '/graph/me/onlineMeetings' ? [403, { error: { code: 'Forbidden', message: 'Insufficient privileges to complete the operation.' } }] : null);
  await assert.rejects(v.create('teams', MEETING), (err) => err.code === 'refused' && /Microsoft Teams refused the request: Insufficient privileges/.test(err.message));
  s.fail = () => [503, { error: { code: 'ServiceUnavailable', message: 'Try later' } }];
  await assert.rejects(v.create('teams', MEETING), (err) => err.code === 'failed' && err.message === 'Microsoft Teams answered with an error: Try later');
  // An answer without a link is no meeting.
  s.fail = (r) => (r.method === 'POST' && r.path.endsWith('/meetings') ? [201, { id: 5 }] : null);
  await assert.rejects(v.create('zoom', MEETING), (err) => err.code === 'failed' && /sent no link/.test(err.message));
  s.fail = null;
  // Zoom's servers gone: the connection stays, the call says it couldn't reach them.
  await s.close();
  await assert.rejects(v.create('zoom', MEETING), (err) => err.code === 'network' && /couldn't reach Zoom/.test(err.message));
  assert.equal(v.status('zoom'), 'connected');
});

test('Microsoft Teams signs in as a public client of the organizations tenant and makes online meetings with Graph', async (t) => {
  const s = await fake(t);
  const { v } = services(s, { env: { SEM_TEAMS_CLIENT_ID: 'teams-client' } });
  await v.connect('teams');
  const q = s.opened.searchParams;
  assert.equal(s.opened.pathname, '/ms/organizations/oauth2/v2.0/authorize');
  assert.match(q.get('redirect_uri'), /^http:\/\/localhost:\d+$/, 'Microsoft matches localhost without its port');
  assert.deepEqual(q.get('scope').split(' '), ['offline_access', 'User.Read', 'OnlineMeetings.ReadWrite']);
  assert.equal(q.get('code_challenge_method'), 'S256');
  const exchange = s.requests.find((r) => r.form.grant_type === 'authorization_code');
  assert.equal(exchange.headers.authorization, undefined);
  assert.equal(exchange.form.client_id, 'teams-client');
  assert.equal(exchange.form.client_secret, undefined);
  assert.deepEqual(byId(v.state(), 'teams').account, { email: 'bart@contoso.example', name: 'Bart Host' });

  const made = await v.create('teams', MEETING);
  assert.match(made.url, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  assert.deepEqual(s.meetings.get(made.id), { service: 'teams', subject: MEETING.title, startDateTime: '2026-11-03T09:00:00.000Z', endDateTime: '2026-11-03T09:30:00.000Z' });
  await v.update(made, { ...MEETING, start: MEETING.start + 86400000, end: MEETING.end + 86400000 });
  assert.equal(s.meetings.get(made.id).startDateTime, '2026-11-04T09:00:00.000Z');
  await v.remove(made);
  assert.equal(s.meetings.has(made.id), false);

  // A refresh asks for the same scopes, as Microsoft wants; a revoked one needs renewing.
  s.access.clear();
  await v.create('teams', MEETING);
  const refresh = s.requests.filter((r) => r.form.grant_type === 'refresh_token').pop();
  assert.equal(refresh.form.scope, 'offline_access User.Read OnlineMeetings.ReadWrite');
  s.access.clear();
  s.refresh.clear();
  await assert.rejects(v.create('teams', MEETING), (err) => err.code === 'renew');

  // A tenant of the host's own, from the client file.
  const other = services(s, {}).v;
  fs.writeFileSync(path.join(other.configDir, 'teams-oauth.json'), JSON.stringify({ client_id: 'teams-client', tenant: 'contoso.example' }));
  await other.connect('teams');
  assert.equal(s.opened.pathname, '/ms/contoso.example/oauth2/v2.0/authorize');
});

test('a sign-in can be denied, cancelled, and ignores an answer meant for another one', async (t) => {
  const s = await fake(t);
  const { v } = services(s, { env: { SEM_ZOOM_CLIENT_ID: 'zoom-client' } });
  s.browser = 'deny';
  await assert.rejects(v.connect('zoom'), (err) => err.code === 'denied' && err.message === "Zoom didn't give Rukoo access.");
  assert.equal(v.status('zoom'), 'off');
  assert.equal(v.state().pending, null);

  s.browser = 'wait';
  const signing = v.connect('zoom');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(v.state().pending, 'zoom');
  v.cancel();
  await assert.rejects(signing, (err) => err.code === 'cancelled');
  assert.equal(v.state().pending, null);

  // A redirect with a state that isn't this sign-in's is refused; the real one still completes it.
  s.browser = 'wrong-state';
  await v.connect('zoom');
  assert.match(s.pages.find((p) => /Sign-in failed/.test(p)), /Start sign-in again/);
  assert.equal(v.status('zoom'), 'connected');

  v.disconnect('zoom');
  assert.equal(v.status('zoom'), 'off');
  assert.equal(JSON.parse(fs.readFileSync(v.path, 'utf8')).accounts.zoom, undefined);
});

test("a booking's event gets the link as its location and a first line in the page's language", () => {
  const input = { title: 'Intro', location: '', description: 'Bring the numbers.\n\nBooked via https://meet.example/bart' };
  const meeting = { service: 'zoom', id: '1', url: 'https://us05web.zoom.us/j/1?pwd=x' };
  assert.deepEqual(withMeeting(input, meeting, { locale: 'en', name: 'Zoom' }), {
    title: 'Intro',
    location: meeting.url,
    description: `Join with Zoom: ${meeting.url}\n\nBring the numbers.\n\nBooked via https://meet.example/bart`
  });
  assert.match(withMeeting(input, meeting, { locale: 'nl', name: 'Zoom' }).description, /^Doe mee via Zoom: https:/);
  assert.equal(withMeeting(input, null, { locale: 'en', name: '' }), input);
});
