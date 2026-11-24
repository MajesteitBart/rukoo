// Agents in team chat channels in the browser (server/WORKSPACES.md "Agents"), end to end: the real site and account
// Workers (harness.mjs) and headless Chromium. Olga, the owner, uses the page; Piet is another member, acted for over
// the server's API, with an agent of his own that answers only him. Olga makes an agent in the Agents dialog and gets
// its key and a runner config, which in a browser has no "Use one of my agents" (a): there is no Settings, Agents to
// take it from. She adds the agent to general through Add people, mentions it with the picker, which says Piet's agent
// answers only him, and the agent's reply, posted with its key as a runner does, shows with the Agent tag (b). The same
// in Dutch on a phone (c). Each test fails on a console or page error and on horizontal overflow.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { clean, expect, makeAccount, message, openPage, openRoom, shot, signIn, startWorkers, tr } from './harness.mjs';

const WORKSPACE = 'Acme Studio';
const LIVE_MS = 15000;
const KEY = /^rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

let env = null;
let olga = null;
let piet = null;
let ws = null;
let view = null;
let phone = null;
// The agent Olga makes on the page: { id, key }.
let clark = null;

before(async () => {
  env = await startWorkers();
  olga = await makeAccount(env.origin, { email: 'olga@example.test' });
  piet = await env.seed.seedAccount();
  ws = await env.seed.seedWorkspace(olga, { name: WORKSPACE, displayName: 'Olga Owner' });
  piet.me = await env.seed.seedMember(ws, piet, 'Piet de Vries');
  // Piet's agent answers only him; as its sponsor he adds it to general, a channel the workspace can see.
  const revy = await env.seed.seedAgent(piet, ws, { name: 'Revy', answers: 'sponsor' });
  const added = await env.seed.call('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/members`, { token: piet.token, body: { member: revy.agent.id } });
  assert.equal(added.status, 200);
  await env.seed.post(piet, ws.id, ws.general, 'Morning. Revy is here to help me with the release notes.');
});

after(async () => {
  for (const v of [view, phone]) await v?.context.close().catch(() => {});
  await env?.close();
});

// The dialog on top.
const dialog = (p) => p.locator('.scrim .dialog').last();

async function workspaceMenu(p, item) {
  await expect(p.locator('.sidebar .ch-nav .nav-section')).not.toHaveCount(0);
  await p.locator('.ch-ws-switch').click();
  await p.locator('.menu [role^="menuitem"]', { hasText: item }).first().click();
}

test('a: the Agents dialog makes an agent and shows its key and a runner config, without the desktop agents', async () => {
  view = await openPage(env.browser);
  const p = view.page;
  await view.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.origin });
  await p.goto(`${env.origin}/app/`);
  await signIn(p, olga);
  await openRoom(p, 'general');

  // The host note says what an agent in a channel does with what it reads.
  await workspaceMenu(p, tr('en', 'chat.workspace.settings'));
  await expect(dialog(p).locator('.ch-host')).toContainText(tr('en', 'chat.host.agents'));
  await dialog(p).locator('.buttons button').last().click();

  await workspaceMenu(p, tr('en', 'chat.workspace.agents'));
  const list = dialog(p);
  await expect(list.locator('h2')).toHaveText(tr('en', 'chat.agents.title', { workspace: WORKSPACE }));
  await expect(list.locator('[data-agents] .ch-person-name')).toHaveText(['Revy'], { timeout: LIVE_MS });
  await expect(list.locator('[data-agents] .ch-agent-meta')).toHaveText('Made by Piet de Vries · Answers only Piet de Vries · Not connected yet');
  // Olga owns the workspace, so she may change and remove Piet's agent too, but only Piet makes it a new key.
  await expect(list.locator('[data-agents] [data-agent]')).toHaveCount(1);
  await list.locator('[data-agents] [data-agent]').click();
  await expect(p.locator('.menu [role^="menuitem"]')).toHaveText([tr('en', 'chat.agents.edit'), tr('en', 'chat.agents.remove')]);
  await p.keyboard.press('Escape');
  await shot(p, 'agents-a0-list');

  await list.locator('[data-add-agent]').click();
  const form = dialog(p);
  await expect(form.locator('h2')).toHaveText(tr('en', 'chat.agents.addTitle'));
  // A new agent starts on Only me; Chosen people with nobody picked can't be made.
  await expect(form.locator('[name="answers"][value="sponsor"]')).toBeChecked();
  await form.locator('[name="name"]').fill('Clark');
  await form.locator('[name="answers"][value="members"]').check();
  await expect(form.locator('[data-people] .ch-check-label')).toHaveText(['Piet de Vries']);
  await expect(form.locator('[data-people-count]')).toHaveText(tr('en', 'chat.agents.chosenNone'));
  await expect(form.locator('.buttons button').last()).toBeDisabled();
  await shot(p, 'agents-a1-form');
  await form.locator('[name="answers"][value="everyone"]').check();
  await form.locator('.buttons button').last().click();

  const step = dialog(p);
  await expect(step.locator('h2')).toHaveText(tr('en', 'chat.agents.keyTitle', { name: 'Clark' }), { timeout: LIVE_MS });
  const key = await step.locator('[name="key"]').inputValue();
  assert.match(key, KEY);
  // No Settings, Agents in a browser: the config keeps the placeholder backend.
  await expect(step.locator('[name="use"]')).toHaveCount(0);
  const config = JSON.parse(await step.locator('[name="config"]').inputValue());
  assert.deepEqual(config, {
    server: await step.locator('[name="server"]').inputValue(),
    workspace: ws.id,
    key,
    backend: { type: 'command', command: 'my-agent' },
    context: { threadMessages: 50, channelMessages: 20, maxChars: 30000 },
    instructions: ''
  });
  assert.match(config.server, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
  await shot(p, 'agents-a2-key');
  await step.locator('[data-copy-key]').click();
  await expect.poll(() => p.evaluate(() => navigator.clipboard.readText())).toBe(key);
  await step.locator('.buttons button').last().click();
  await expect(list.locator('[data-agents] .ch-person-name')).toHaveText(['Clark', 'Revy'], { timeout: LIVE_MS });
  await list.locator('.buttons button').last().click();
  await expect(p.locator('.scrim')).toHaveCount(0);

  const me = await env.seed.agentCall(key, 'GET', `/v1/workspaces/${ws.id}/agents/me`);
  assert.equal(me.status, 200);
  clark = { id: me.body.agent.id, key };
  clean(view);
});

test('b: Add people adds the agent to general, the mention list tags both agents, and its reply shows with the Agent tag', async () => {
  const p = view.page;
  await p.locator('.ch-head [data-ch="more"]').click();
  await p.locator('.menu [role^="menuitem"]', { hasText: tr('en', 'chat.head.addPeople') }).first().click();
  const members = dialog(p);
  await expect(members.locator('[data-pick] .ch-check-label')).toHaveText(['Clark'], { timeout: LIVE_MS });
  await expect(members.locator('[data-pick] .ch-group')).toHaveText([tr('en', 'chat.roles.agents')]);
  await expect(members.locator('[data-pick] .ch-agent-note')).toHaveText(tr('en', 'chat.agents.answersEveryone'));
  await expect(members.locator('[data-pick] .ch-agents-read')).toHaveText(tr('en', 'chat.host.agents'));
  await shot(p, 'agents-b0-add');
  await members.locator('[data-pick] input[name="pick"]').check();
  await members.locator('[data-add-go]').click();
  await expect(members.locator('[data-people] .ch-agent-tag')).toHaveCount(2, { timeout: LIVE_MS });
  // Each agent says who made it and whom it answers, as on Android.
  await expect(members.locator('[data-people] .ch-agent-meta')).toHaveText(['Made by Olga Owner · Answers everyone', 'Made by Piet de Vries · Answers only Piet de Vries']);
  await shot(p, 'agents-b1-members');
  await members.locator('.buttons button').last().click();
  await expect(p.locator('.ch-head .ch-meta')).toHaveText('2 members · 2 agents', { timeout: LIVE_MS });

  // The mention list: Revy answers only Piet, and says so; Clark answers Olga.
  const input = p.locator('.ch-compose .ch-input');
  await input.click();
  await p.keyboard.type('@');
  const option = (name) => p.locator('.ch-suggest [role="option"]', { has: p.locator('.mention-name', { hasText: name }) });
  await expect(option('Revy').locator('.mention-note')).toHaveText('Answers only Piet de Vries', { timeout: LIVE_MS });
  await expect(option('Revy').locator('.mention-tag')).toHaveText('Agent');
  await expect(option('Clark').locator('.mention-tag')).toHaveText('Agent');
  await expect(option('Clark').locator('.mention-note')).toHaveCount(0);
  await shot(p, 'agents-b2-mention');
  await p.keyboard.type('Cla');
  await expect(p.locator('.ch-suggest [role="option"] .mention-name')).toHaveText(['Clark']);
  await p.keyboard.press('Enter');
  await p.keyboard.type('summarise the morning');
  await p.keyboard.press('Enter');
  const asked = message(p, 'summarise the morning');
  await expect(asked.and(p.locator('[data-seq]'))).toHaveCount(1, { timeout: LIVE_MS });
  const trigger = await asked.getAttribute('data-id');

  await env.seed.agentReply(clark.key, ws.id, ws.general, { trigger, text: 'Piet asked Revy for the release notes.' });
  const reply = message(p, 'Piet asked Revy for the release notes.');
  await expect(reply).toBeVisible({ timeout: LIVE_MS });
  await expect(reply.locator('.ch-name')).toHaveText('Clark');
  await expect(reply.locator('.ch-tag')).toHaveText('Agent');
  await expect(reply.locator('.avatar')).toHaveClass(/\bis-agent\b/);
  await shot(p, 'agents-b3-reply');
  clean(view);
});

test('c: in Dutch on a phone the Agents dialog and the agent tag fit', async () => {
  phone = await openPage(env.browser, { locale: 'nl-NL', width: 390, height: 844, phone: true, colorScheme: 'dark' });
  const p = phone.page;
  await p.goto(`${env.origin}/app/`);
  await signIn(p, olga);
  await workspaceMenu(p, tr('nl', 'chat.workspace.agents'));
  const list = dialog(p);
  await expect(list.locator('h2')).toHaveText(tr('nl', 'chat.agents.title', { workspace: WORKSPACE }));
  await expect(list.locator('[data-agents] .ch-person-name')).toHaveText(['Clark', 'Revy'], { timeout: LIVE_MS });
  await expect(list.locator('[data-agent-row]', { hasText: 'Revy' }).locator('.ch-agent-meta')).toHaveText('Gemaakt door Piet de Vries · Antwoordt alleen Piet de Vries · Nog niet verbonden');
  await shot(p, 'agents-c0-list-nl-phone');
  await list.locator('[data-add-agent]').click();
  const form = dialog(p);
  await expect(form.locator('h2')).toHaveText(tr('nl', 'chat.agents.addTitle'));
  await form.locator('[name="answers"][value="members"]').check();
  await shot(p, 'agents-c1-form-nl-phone');
  await form.locator('.buttons button').first().click();
  await list.locator('.buttons button').last().click();
  await expect(p.locator('.scrim')).toHaveCount(0);
  await openRoom(p, 'general');
  await expect(message(p, 'Piet asked Revy for the release notes.').locator('.ch-tag')).toHaveText('Agent', { timeout: LIVE_MS });
  await shot(p, 'agents-c2-reply-nl-phone');
  clean(phone);
});
