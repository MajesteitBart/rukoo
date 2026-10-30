'use strict';

// The chat's permission level (src/main/agents/permission.js): Ask, Auto or Full permission, as a default in Settings
// and per chat. Rukoo's tools check it in the main process: mail_action, create_event and propose_action show an
// approval card or go ahead. The demo account for mail and its calendar, the Google fake for guests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { Engine } = require('../src/main/engine');
const { AgentHub } = require('../src/main/agents/hub');
const { AgentConfig } = require('../src/main/agents/config');
const { PhoneHost } = require('../src/main/agents/phonehost');
const { PERMISSIONS, needsApproval } = require('../src/main/agents/permission');
const context = require('../src/main/agents/context');
const { Calendars } = require('../src/main/calendar');
const { free } = require('../src/main/calendar/free');
const { fakeCalendar, setup: googleSetup, monday, at } = require('./fixtures/google-calendar');

const local = (conversationId) => ({ agent: 'claude', conversationId, remote: false });
const data = (res) => {
  assert.ok(!res.isError, res.content && res.content[0].text);
  return res.structuredContent;
};
const cards = (c) => c.items.filter((i) => i.type === 'approval');

async function idle(hub, cid, ms = 20000) {
  const end = Date.now() + ms;
  while (hub.turns.has(cid)) {
    if (Date.now() > end) throw new Error('turn did not finish');
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setImmediate(r));
}

// The demo account with its mail and calendar. agents: what agents.json holds before Rukoo starts.
async function demo({ agents = null, adapters = {} } = {}) {
  const dir = tempDir('sem-permission-');
  const engine = new Engine({ dataDir: dir }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  if (agents) fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents));
  const calendars = new Calendars({ engine });
  const unsubscribed = [];
  const hub = new AgentHub({
    engine,
    dataDir: dir,
    deps: {
      appVersion: '1.0.0',
      tempDir: path.join(dir, 'agent-tmp'),
      unsubscribe: async (id) => (unsubscribed.push(id), { done: true }),
      calendars,
      calendarFree: (o) => free(calendars, engine.settings, null, o)
    },
    adapters,
    listen: false
  });
  await hub.start();
  const find = (subject, view = 'inbox') => engine.listMessages({ scope: acc.id, view }).find((m) => m.subject === subject);
  const done = async () => {
    await hub.dispose();
    calendars.flush();
    await engine.close();
  };
  return { dir, engine, acc, hub, calendars, unsubscribed, find, done };
}

// An adapter that only records what each turn sends.
function recorder() {
  const inputs = [];
  const adapter = {
    async status() {
      return { state: 'ready' };
    },
    async runTurn(turn) {
      inputs.push(turn.input);
      return { status: 'done' };
    },
    async dispose() {}
  };
  return { inputs, adapter };
}

// ---------- the policy ----------

test('the policy: Ask asks before everything, Auto only before what others see or is hard to undo, Full never', () => {
  const requests = {
    archive: { kind: 'mail', action: 'archive' },
    move: { kind: 'mail', action: 'move' },
    moveIntoTrash: { kind: 'mail', action: 'move', intoTrash: true },
    markRead: { kind: 'mail', action: 'mark_read' },
    markUnread: { kind: 'mail', action: 'mark_unread' },
    star: { kind: 'mail', action: 'star' },
    unstar: { kind: 'mail', action: 'unstar' },
    trash: { kind: 'mail', action: 'trash' },
    unsubscribe: { kind: 'mail', action: 'unsubscribe' },
    ownEvent: { kind: 'calendar', guests: 0, owned: true },
    ownEventWithGuests: { kind: 'calendar', guests: 2, owned: true },
    sharedEvent: { kind: 'calendar', guests: 0, owned: false },
    proposal: { kind: 'proposal' },
    unknown: { kind: 'something new' }
  };
  const asks = (level) => Object.keys(requests).filter((k) => needsApproval(level, requests[k]));
  assert.deepEqual(asks('ask'), Object.keys(requests));
  assert.deepEqual(asks('auto'), ['moveIntoTrash', 'trash', 'unsubscribe', 'ownEventWithGuests', 'sharedEvent', 'proposal', 'unknown']);
  assert.deepEqual(asks('full'), []);
  // A level Rukoo does not know asks, like Ask.
  for (const level of [undefined, null, '', 'everything', 'FULL']) assert.deepEqual(asks(level), Object.keys(requests), String(level));
  assert.deepEqual(PERMISSIONS, ['ask', 'auto', 'full']);
});

// ---------- the setting ----------

test('the default level is Ask; the old mail switch never becomes a looser level', () => {
  const dir = tempDir('sem-permission-cfg-');
  const file = path.join(dir, 'agents.json');
  const load = (stored) => {
    if (stored === undefined) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(stored));
    return new AgentConfig({ file }).load();
  };
  assert.equal(load(undefined).data.permission, 'ask');
  // "Let agents archive, move and mark mail without asking" covered mail only. Auto would also add events without
  // asking, so that user starts at Ask too.
  assert.equal(load({ autoMailActions: true }).data.permission, 'ask');
  assert.equal(load({ autoMailActions: false }).data.permission, 'ask');
  assert.equal(load({ permission: 'full', autoMailActions: false }).data.permission, 'full');
  assert.equal(load({ permission: 'auto' }).data.permission, 'auto');
  assert.equal(load({ permission: 'root' }).data.permission, 'ask');

  const cfg = load({ autoMailActions: true });
  const view = cfg.publicView();
  assert.equal(view.permission, 'ask');
  assert.equal('autoMailActions' in view, false);
  cfg.update({ permission: 'full' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.permission, 'full');
  assert.equal('autoMailActions' in saved, false, 'the old switch is gone from the file once saved');
  for (const bad of ['', 'Full', null, true, 2]) assert.throws(() => cfg.update({ permission: bad }), /invalid/, JSON.stringify(bad));
  assert.equal(cfg.data.permission, 'full', 'a refused patch changes nothing');
});

test("a chat's own level wins over Settings, null follows Settings again, and it survives a restart", async () => {
  const t = await demo({ agents: { permission: 'auto' } });
  try {
    const c = t.hub.create({ agent: 'claude', message: null, permission: 'full' });
    assert.equal(c.permission, 'full');
    assert.equal(t.hub.permissionOf(c), 'full');
    const events = [];
    t.hub.on('event', (e) => events.push(e));
    assert.deepEqual(t.hub.setChoice(c.id, { permission: 'ask' }), { model: null, effort: null, permission: 'ask' });
    assert.deepEqual(events.at(-1), { kind: 'conversation', conversation: { id: c.id, model: null, effort: null, permission: 'ask' } });
    assert.equal(t.hub.permissionOf(c), 'ask');
    // A model change leaves the level alone.
    t.hub.setChoice(c.id, { model: 'opus' });
    assert.equal(c.permission, 'ask');
    assert.throws(() => t.hub.setChoice(c.id, { permission: 'root' }), (err) => err.code === 'invalid');
    assert.throws(() => t.hub.create({ agent: 'claude', permission: 'yes' }), (err) => err.code === 'invalid');
    assert.equal(c.permission, 'ask');
    t.hub.setChoice(c.id, { permission: null });
    assert.equal(t.hub.permissionOf(c), 'auto', 'back to the level in Settings');
    t.hub.setChoice(c.id, { permission: 'full' });
    // Settings changes the default, not a chat that has its own.
    await t.hub.updateConfig({ permission: 'ask' });
    assert.equal(t.hub.permissionOf(c), 'full');
    assert.equal(t.hub.permissionOf(t.hub.create({ agent: 'claude' })), 'ask');
    t.hub.flush();
    const again = new AgentHub({ engine: t.engine, dataDir: t.dir, deps: { appVersion: '1.0.0' }, adapters: {}, listen: false });
    await again.start();
    try {
      assert.equal(again.conversations.get(c.id).permission, 'full');
      assert.equal(again.cfg.data.permission, 'ask');
    } finally {
      await again.dispose();
    }
  } finally {
    await t.done();
  }
});

test('a chat saved before the levels follows Settings, and one with a level Rukoo does not know follows it too', async () => {
  const dir = tempDir('sem-permission-old-');
  const engine = new Engine({ dataDir: dir }).init();
  await engine.addAccount({ type: 'demo' });
  const old = { id: 'c_old', agent: 'claude', title: 'Old chat', message: null, origin: 'panel', createdAt: 1, updatedAt: 1, status: 'idle', provider: {}, notes: [], items: [] };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ permission: 'auto' }));
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify({ version: 1, conversations: [old, { ...old, id: 'c_odd', permission: 'root' }] }));
  const hub = new AgentHub({ engine, dataDir: dir, deps: { appVersion: '1.0.0' }, adapters: {}, listen: false });
  await hub.start();
  try {
    for (const id of ['c_old', 'c_odd']) {
      const c = hub.conversations.get(id);
      assert.equal(c.permission, null, id);
      assert.equal(hub.permissionOf(c), 'auto', id);
    }
  } finally {
    await hub.dispose();
    await engine.close();
  }
});

test('a permission change in Settings restarts no agent, and the panel hears of it', async () => {
  const t = await demo();
  try {
    let restarts = 0;
    t.hub.adapters.set('claude', { configChanged: () => restarts++, status: async () => ({ state: 'ready' }), dispose: async () => {} });
    const events = [];
    t.hub.on('event', (e) => events.push(e));
    const view = await t.hub.updateConfig({ permission: 'full' });
    assert.equal(view.permission, 'full');
    await new Promise((r) => setImmediate(r));
    assert.equal(restarts, 0);
    assert.ok(events.some((e) => e.kind === 'agents'));
  } finally {
    await t.done();
  }
});

// ---------- mail_action ----------

test('mail_action per level: Ask shows a card, Auto archives at once but asks before deleting, Full deletes without asking', async () => {
  const t = await demo();
  try {
    const call = t.find('Call on Thursday');
    const ask = t.hub.create({ agent: 'claude', message: null });
    const asked = data(await t.hub.callTool(local(ask.id), 'mail_action', { action: 'archive', message_ids: [call.id] }));
    assert.equal(asked.status, 'waiting_for_user');
    assert.equal(cards(ask).length, 1);
    assert.ok(t.find('Call on Thursday'), 'nothing moved before the user decided');

    const auto = t.hub.create({ agent: 'claude', message: null, permission: 'auto' });
    const archived = data(await t.hub.callTool(local(auto.id), 'mail_action', { action: 'archive', message_ids: [call.id] }));
    assert.equal(archived.status, 'done');
    assert.equal(archived.done, 1);
    assert.equal(cards(auto).length, 0);
    assert.equal(t.find('Call on Thursday'), undefined, 'archived');
    assert.ok(auto.items.find((i) => i.type === 'notice' && i.undo), 'the notice keeps its Undo');

    const other = t.engine.listMessages({ scope: t.acc.id, view: 'inbox' })[0];
    const trash = data(await t.hub.callTool(local(auto.id), 'mail_action', { action: 'trash', message_ids: [other.id] }));
    assert.equal(trash.status, 'waiting_for_user', 'Auto still asks before deleting');
    const unsubscribe = data(await t.hub.callTool(local(auto.id), 'mail_action', { action: 'unsubscribe', message_ids: [other.id] }));
    assert.equal(unsubscribe.status, 'waiting_for_user', 'and before unsubscribing');
    const intoTrash = data(await t.hub.callTool(local(auto.id), 'mail_action', { action: 'move', message_ids: [other.id], folder: 'Trash' }));
    assert.equal(intoTrash.status, 'waiting_for_user', 'and before a move into Trash');
    assert.equal(cards(auto).length, 3);
    assert.deepEqual(t.unsubscribed, []);

    const full = t.hub.create({ agent: 'claude', message: null, permission: 'full' });
    const deleted = data(await t.hub.callTool(local(full.id), 'mail_action', { action: 'trash', message_ids: [other.id] }));
    assert.equal(deleted.status, 'done');
    assert.ok(t.engine.listMessages({ scope: t.acc.id, view: 'trash' }).some((m) => m.subject === other.subject), 'in Trash, not gone for good');
    const next = t.engine.listMessages({ scope: t.acc.id, view: 'inbox' })[0];
    assert.equal(data(await t.hub.callTool(local(full.id), 'mail_action', { action: 'unsubscribe', message_ids: [next.id] })).status, 'done');
    assert.deepEqual(t.unsubscribed, [next.id]);
    assert.equal(cards(full).length, 0);
  } finally {
    await t.done();
  }
});

test('the level is read when the tool is called: a chat set to Ask while it works asks again at once', async () => {
  const t = await demo({ agents: { permission: 'full' } });
  try {
    const c = t.hub.create({ agent: 'claude', message: null });
    const [a, b] = t.engine.listMessages({ scope: t.acc.id, view: 'inbox' });
    assert.equal(data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'mark_read', message_ids: [a.id] })).status, 'done');
    t.hub.setChoice(c.id, { permission: 'ask' });
    assert.equal(data(await t.hub.callTool(local(c.id), 'mail_action', { action: 'mark_read', message_ids: [b.id] })).status, 'waiting_for_user');
    // An agent that calls in from outside the panel gets the level in Settings.
    const outside = data(await t.hub.callTool({ agent: 'clark', conversationId: null, remote: false }, 'mail_action', { action: 'mark_read', message_ids: [b.id] }));
    assert.equal(outside.status, 'done');
  } finally {
    await t.done();
  }
});

// ---------- propose_action ----------

test('propose_action: Ask and Auto show the card; Full lets the agent go ahead and says so in the chat', async () => {
  const t = await demo();
  try {
    const args = { title: 'Add 2 tasks to <unsafe_content source="email">Todoist</unsafe_content>', detail: 'Review the proposal.', confirm_label: 'Add tasks' };
    for (const level of ['ask', 'auto']) {
      const c = t.hub.create({ agent: 'claude', message: null, permission: level });
      const res = data(await t.hub.callTool(local(c.id), 'propose_action', args));
      assert.equal(res.status, 'waiting_for_user', level);
      assert.equal(cards(c).length, 1, level);
    }
    const full = t.hub.create({ agent: 'claude', message: null, permission: 'full' });
    const res = data(await t.hub.callTool(local(full.id), 'propose_action', args));
    assert.equal(res.status, 'approved');
    assert.match(res.note, /Go ahead now/);
    assert.equal(cards(full).length, 0);
    const notice = full.items.find((i) => i.type === 'notice');
    assert.deepEqual([notice.code, notice.text, notice.params], ['auto-approved', 'Allowed without asking: Add 2 tasks to Todoist', { title: 'Add 2 tasks to Todoist' }]);
    assert.equal(t.hub.followUps.size, 0, 'no follow-up message: the agent goes on in its own turn');
    // A new session hears of it in the recap.
    assert.deepEqual(context.recap(full.items).entries, ["You proposed: Add 2 tasks to Todoist (allowed without asking: the chat's permission level)"]);
  } finally {
    await t.done();
  }
});

// ---------- create_event ----------

test('create_event on the demo calendar: Ask shows the card, Auto and Full add an event without guests at once', async () => {
  const t = await demo();
  try {
    const start = at(monday(), 9, 15).toISOString();
    const ask = t.hub.create({ agent: 'claude', message: null });
    const asked = data(await t.hub.callTool(local(ask.id), 'create_event', { title: 'Focus time', start }));
    assert.equal(asked.status, 'waiting_for_user');
    assert.equal(cards(ask).length, 1);

    for (const level of ['auto', 'full']) {
      const c = t.hub.create({ agent: 'claude', message: null, permission: level });
      const res = data(await t.hub.callTool(local(c.id), 'create_event', { title: `Focus ${level}`, start, calendar: 'Work' }));
      assert.equal(res.status, 'done', level);
      assert.ok(res.event_id, level);
      assert.match(res.summary, /^<unsafe_content source="calendar result">Added the event in Work \(demo@example\.com\), id .*<\/unsafe_content>$/);
      assert.equal(cards(c).length, 0, level);
      const notice = c.items.find((i) => i.type === 'notice');
      assert.deepEqual([notice.calendar.action, notice.calendar.title, 'guests' in notice.calendar], ['created', `Focus ${level}`, false]);
      const { events } = await t.calendars.read({ start: Date.parse(start) - 3600000, end: Date.parse(start) + 3 * 3600000, maxAgeMs: 0 });
      assert.ok(events.some((e) => e.title === `Focus ${level}` && e.calendarId === 'work'), level);
    }
  } finally {
    await t.done();
  }
});

test('create_event on Google: Auto asks before guests and before a calendar someone else owns; Full invites without asking', async () => {
  const fake = fakeCalendar();
  const { engine, calendars, dataDir } = googleSetup(fake);
  const hub = new AgentHub({
    engine,
    dataDir,
    deps: { appVersion: '1.0.0', tempDir: path.join(dataDir, 'agent-tmp'), calendars, calendarFree: (o) => free(calendars, engine.settings, null, o) },
    adapters: {},
    listen: false
  });
  await hub.start();
  const posts = () => fake.requests.filter((r) => r.method === 'POST');
  try {
    const event = { title: 'Proposal review', start: '2026-11-03T14:00:00+01:00', end: '2026-11-03T14:30:00+01:00', time_zone: 'Europe/Amsterdam' };
    const call = (c, args) => hub.callTool({ agent: 'codex', conversationId: c.id, remote: false }, 'create_event', args);
    const auto = hub.create({ agent: 'codex', message: null, permission: 'auto' });
    assert.equal(data(await call(auto, { ...event, guests: ['sanne@example.com'] })).status, 'waiting_for_user', 'guests get an invitation: ask');
    assert.equal(data(await call(auto, { ...event, calendar: 'Team' })).status, 'waiting_for_user', 'a calendar shared with the user: ask');
    assert.equal(posts().length, 0, 'nothing went out');
    assert.equal(data(await call(auto, event)).status, 'done', "the user's own calendar without guests: no card");
    assert.equal(posts().length, 1);

    const full = hub.create({ agent: 'codex', message: null, permission: 'full' });
    const res = data(await call(full, { ...event, guests: ['Sanne de Vries <sanne@example.com>', 'joris@example.com'] }));
    assert.equal(res.status, 'done');
    assert.match(res.summary, /The guests get an invitation/);
    assert.equal(cards(full).length, 0);
    const post = posts().at(-1);
    assert.equal(post.query.sendUpdates, 'all', 'the guests get their invitation');
    assert.deepEqual(post.body.attendees.map((a) => a.email), ['sanne@example.com', 'joris@example.com']);
    const notice = full.items.find((i) => i.type === 'notice');
    assert.equal(notice.calendar.guests, 2, 'the notice can say that guests were invited');
  } finally {
    await hub.dispose();
    calendars.flush();
    await engine.close();
  }
});

test('an event added without asking that outlasts its call says so, and the outcome comes with the next message', async () => {
  const { inputs, adapter } = recorder();
  const t = await demo({ agents: { permission: 'auto' }, adapters: { claude: adapter } });
  try {
    t.hub.mailWait = 50;
    const c = t.hub.create({ agent: 'claude', message: null });
    const create = t.calendars.create.bind(t.calendars);
    t.calendars.create = async (...a) => (await new Promise((r) => setTimeout(r, 300)), create(...a));
    const res = data(await t.hub.callTool(local(c.id), 'create_event', { title: 'Slow focus', start: at(monday(), 9, 15).toISOString() }));
    assert.equal(res.status, 'in_progress');
    t.hub.send(c.id, { text: 'Done?' });
    await idle(t.hub, c.id);
    assert.match(inputs.at(-1), /Rukoo did .*Add "Slow focus" to the calendar.*: .*Added the event in/s);
  } finally {
    await t.done();
  }
});

// ---------- what the agent is told ----------

test('the turn names the level when it is not Ask, and Ask once more after the agent heard of another', async () => {
  const { inputs, adapter } = recorder();
  const t = await demo({ adapters: { claude: adapter } });
  try {
    const c = t.hub.create({ agent: 'claude', message: null });
    const turn = async (text) => {
      t.hub.send(c.id, { text });
      await idle(t.hub, c.id);
      return inputs.at(-1);
    };
    const { ask, auto, full } = context.PERMISSION_LINES;
    const levels = (input) => [ask, auto, full].filter((line) => input.includes(line));
    assert.deepEqual(levels(await turn('First')), [], 'Ask is what the instructions say');
    assert.deepEqual(levels(await turn('Second')), []);
    t.hub.setChoice(c.id, { permission: 'full' });
    assert.deepEqual(levels(await turn('Third')), [full]);
    assert.deepEqual(levels(await turn('Fourth')), [full], 'every turn while it is not Ask');
    t.hub.setChoice(c.id, { permission: 'auto' });
    assert.deepEqual(levels(await turn('Fifth')), [auto]);
    t.hub.setChoice(c.id, { permission: null });
    assert.deepEqual(levels(await turn('Sixth')), [ask], 'back at Ask: said once');
    assert.deepEqual(levels(await turn('Seventh')), []);
    assert.equal(c.toldPermission, 'ask');
    assert.match(full, /invitations to guests included/);
    assert.match(auto, /still asks before deleting, unsubscribing, and events with guests/);
  } finally {
    await t.done();
  }
});

test('the tool descriptions are true at every level, so one cached list fits every device', () => {
  const { list } = require('../src/main/agents/tools');
  const tools = Object.fromEntries(list(null).map((t) => [t.name, t.description]));
  assert.match(tools.mail_action, /Rukoo asks the user first unless they turned that off; you get status waiting_for_user or the result/);
  assert.match(tools.create_event, /Rukoo shows the user a card first unless they let it act without asking; you get status waiting_for_user and the outcome with your next message, or the result/);
  assert.match(tools.propose_action, /With status waiting_for_user, stop and wait.*With status approved, the user lets you act without asking: do it now/);
});

// ---------- the phone ----------

test('the phone gets the level, and "mail without asking" only for Auto and Full', () => {
  for (const [permission, auto] of [
    ['ask', false],
    ['auto', true],
    ['full', true]
  ]) {
    const data = { defaultAgent: 'clark', permission, shortcuts: null, claude: { model: '', access: 'ask' }, codex: { model: '', access: 'ask' }, mcp: { port: 47800 } };
    const cfg = { data, get: () => ({ enabled: true, name: 'Hermes', url: '', key: '', model: '', agent: '' }) };
    const host = Object.create(PhoneHost.prototype);
    host.hub = { cfg, engine: null, deps: { appVersion: '1.0.0' } };
    host.now = () => 1;
    host.hostname = () => 'pc';
    const bundle = host.bundle();
    assert.equal(bundle.agents.permission, permission);
    assert.equal(bundle.agents.autoMailActions, auto, permission);
  }
});
