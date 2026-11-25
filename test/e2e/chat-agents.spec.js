// Agents in team chat channels (server/WORKSPACES.md "Agents"): the real app on a throwaway profile against the real
// account server, with Olga and the agent's key acted for over HTTP. Bart makes an agent in the Agents dialog, copies
// its key, adds it to a channel through Add people and mentions it with the picker; a reply posted with the agent's key
// (the fixture's agentReply, as a runner sends it) shows with the Agent tag. Olga's own agent answers only her, which
// Bart's lists say. Agents never show where only people may go: New message, Message, Block and roles. No real agent
// runs: the reply comes from the test, and "Use one of my agents" only reads Settings.
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { skipWithoutServer, startServer, launch, signIn, openChat, twoPeople, roomRow, dialogBox, menuItem, workspaceMenu, roomMenu, composer, serverMessages, serverGet, connected, directoryIn, messageRow, hoverTool, PASSWORD } = require('./chat-helpers');
const { mention } = require('../fixtures/real-server');

skipWithoutServer();

let server;
let app;
let win;
let dataDir;

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(() => {
  dataDir = tempDir('rukoo-chat-agents-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const pane = () => win.locator('section.chat');
const toast = () => win.locator('#toast');
const picker = () => win.locator('.ch-suggest');
const KEY = /^rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

// Olga's agent Revy, which answers only her, in general.
async function olgasAgent(olga, ws) {
  const revy = await server.seedAgent(olga, ws, { name: 'Revy', answers: 'sponsor' });
  const added = await server.call('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/members`, { token: olga.token, body: { member: revy.agent.id } });
  expect(added.status).toBe(200);
  return revy;
}

async function ready(person) {
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, person);
  await openChat(win);
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });
  await connected(win);
  await directoryIn(app, win);
}

// WCAG's contrast ratio between two computed colors, such as 'rgb(37, 38, 45)'.
function contrast(a, b) {
  const luminance = (color) => {
    const [r, g, bl] = color
      .match(/\d+(\.\d+)?/g)
      .slice(0, 3)
      .map((v) => Number(v) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// Every caption the locator finds passes 4.5:1 against the surface under it: the nearest box with a background. One
// evaluation reads them all, so a list that draws again in between (the mention list does per key) can't detach one.
async function expectReadable(locator, what) {
  // A caption the list drew again between finding it and reading it is detached and has no computed color: read
  // them again until every one is still in the page.
  let pairs = [];
  await expect
    .poll(
      async () => {
        pairs = await locator.evaluateAll((els) =>
          els.map((el) => {
            if (!el.isConnected) return null;
            const alpha = (c) => {
              const v = c.match(/\d+(\.\d+)?/g) || [];
              return v.length > 3 ? Number(v[3]) : 1;
            };
            let box = el;
            while (box && alpha(getComputedStyle(box).backgroundColor) === 0) box = box.parentElement;
            return [getComputedStyle(el).color, box ? getComputedStyle(box).backgroundColor : 'rgb(0, 0, 0)'];
          })
        );
        return pairs.length > 0 && pairs.every((pair) => pair && /\d/.test(pair[0]) && /\d/.test(pair[1]));
      },
      { message: `${what}: every caption is in the page with a computed color`, timeout: 10000 }
    )
    .toBe(true);
  for (const [color, surface] of pairs) expect(contrast(color, surface), `${what}: ${color} on ${surface}`).toBeGreaterThanOrEqual(4.5);
}

test('an agent made in the Agents dialog joins general through Add people, is mentioned with the picker and answers with the Agent tag', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const revy = await olgasAgent(olga, ws);
  await ready(bart);

  // The Agents dialog lists Olga's agent, which Bart can't change.
  await workspaceMenu(win, 'Agents');
  const list = dialogBox(win);
  await expect(list.locator('h2')).toHaveText('Agents in Acme');
  await expect(list.locator('[data-agents] .ch-person-name')).toHaveText(['Revy'], { timeout: 15000 });
  await expect(list.locator('[data-agents] .ch-agent-meta')).toHaveText('Made by Olga Owner · Answers only Olga Owner · Not connected yet');
  await expect(list.locator('[data-agents] [data-agent]')).toHaveCount(0);

  // Add an agent: a name, whom it answers (Chosen people lists only people, never an agent or Bart himself). A new
  // agent starts on Only me, as on Android.
  await list.locator('[data-add-agent]').click();
  const form = dialogBox(win);
  const make = form.locator('.buttons button').last();
  await expect(form.locator('h2')).toHaveText('Add an agent');
  await expect(form.locator('[name="answers"][value="sponsor"]')).toBeChecked();
  await expect(form.locator('[name="agents"]')).not.toBeChecked();
  await expect(form.locator('[data-people-box]')).toBeHidden();
  await expect(make).toBeEnabled();
  // Chosen people with nobody picked can't be made: the button stays off and the line under the list says why.
  await form.locator('[name="answers"][value="members"]').check();
  await expect(form.locator('[data-people] .ch-check-label')).toHaveText(['Olga Owner']);
  await expect(form.locator('[data-people-count]')).toHaveText('Pick at least one person.');
  await expect(form.locator('[data-people-count]')).toHaveClass(/\bch-warn\b/);
  await expect(make).toBeDisabled();
  await form.locator('[name="person"]').check();
  await expect(form.locator('[data-people-count]')).toHaveText('1 person picked');
  await expect(make).toBeEnabled();
  await form.locator('[name="person"]').uncheck();
  await expect(make).toBeDisabled();
  await form.locator('[name="answers"][value="everyone"]').check();
  await expect(make).toBeEnabled();
  await expect(form.locator('[data-people-box]')).toBeHidden();
  await expect(form.locator('.ch-agent-toggle .field-help')).toHaveText('When another agent mentions it. A chain of agents answering each other stops after 3 replies.');
  await form.locator('[name="name"]').fill('Clark');
  await form.locator('.buttons button').last().click();

  // The key shows once, with the server, the workspace and a ready runner config.
  const step = dialogBox(win);
  await expect(step.locator('h2')).toHaveText('Key for Clark', { timeout: 15000 });
  const key = await step.locator('[name="key"]').inputValue();
  expect(key).toMatch(KEY);
  await expect(step.locator('[name="server"]')).toHaveValue(server.url);
  await expect(step.locator('[name="workspace"]')).toHaveValue(ws.id);
  const config = async () => JSON.parse(await step.locator('[name="config"]').inputValue());
  expect(await config()).toEqual({
    server: server.url,
    workspace: ws.id,
    key,
    backend: { type: 'command', command: 'my-agent' },
    context: { threadMessages: 50, channelMessages: 20, maxChars: 30000 },
    instructions: ''
  });
  await expect(step.locator('[data-placeholder]')).toBeVisible();
  // On desktop the config can take one of Bart's agents from Settings, Agents.
  const use = step.locator('[name="use"]');
  await expect(use).toBeVisible({ timeout: 15000 });
  await use.selectOption({ label: 'Claude Code' });
  expect((await config()).backend).toEqual({ type: 'claude' });
  await expect(step.locator('[data-placeholder]')).toBeHidden();
  await use.selectOption({ label: 'OpenClaw' });
  expect((await config()).backend).toEqual({ type: 'openai', url: 'http://127.0.0.1:18789', model: 'openclaw/default' });
  await use.selectOption({ index: 0 });
  expect((await config()).backend).toEqual({ type: 'command', command: 'my-agent' });
  // Closing before copying asks first; Copy key copies it, and then Done is the filled button.
  await expect(step.locator('[data-copy-key]')).toHaveClass(/\bprimary\b/);
  await win.keyboard.press('Escape');
  const ask = win.locator('.scrim').last().locator('.dialog');
  await expect(ask.locator('h2')).toHaveText('Close without copying the key?');
  await ask.locator('.buttons button', { hasText: 'Go back' }).click();
  await step.locator('[data-copy-key]').click();
  await expect(toast()).toHaveText('Key copied');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(key);
  await expect(step.locator('[data-copy-key]')).toHaveClass(/\bsecondary\b/);
  await step.locator('.buttons button').last().click();

  // The list has it, with a menu for Bart; the key works for the agent's own routes.
  await expect(list.locator('[data-agents] .ch-person-name')).toHaveText(['Clark', 'Revy'], { timeout: 15000 });
  await expect(list.locator('[data-agent-row]', { hasText: 'Clark' }).locator('.ch-agent-meta')).toHaveText('Made by Bart · Answers everyone · Not connected yet');
  await expect(list.locator('[data-agent-row]', { hasText: 'Clark' }).locator('[data-agent]')).toHaveCount(1);
  await list.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  const me = await server.agentCall(key, 'GET', `/v1/workspaces/${ws.id}/agents/me`);
  expect(me.status).toBe(200);
  const clark = me.body.agent;
  expect(clark.name).toBe('Clark');

  // Add agents: Bart doesn't manage general, so only his own agent shows, under Agents, with whom it answers, and the
  // picker says it adds agents.
  await roomMenu(win, 'Add agents');
  const members = dialogBox(win);
  await expect(members.locator('.ch-sub')).toHaveText('Add agents to #general', { timeout: 15000 });
  await expect(members.locator('[data-pick] .ch-check-label')).toHaveText(['Clark']);
  await expect(members.locator('[data-pick] .ch-group')).toHaveText(['Agents']);
  await expect(members.locator('[data-pick] .ch-agent-note')).toHaveText('Answers everyone');
  await expect(members.locator('[data-pick] .ch-agents-read')).toHaveText('Agents in a channel pass what they read there on to the system that runs them.');
  // The heading says what they are: no tag on the row.
  await expect(members.locator('[data-pick] [data-kind="agent"] .ch-tag')).toHaveCount(0);
  await members.locator('[data-pick] input[name="pick"]').check();
  await members.locator('[data-add-go]').click();
  // The channel's members: both agents with the tag and who made them; Bart may take out his own agent and not Olga's.
  const people = members.locator('[data-people] .ch-person');
  await expect(people).toHaveCount(4, { timeout: 15000 });
  await expect(people.filter({ hasText: 'Clark' }).locator('.ch-agent-tag')).toHaveText('Agent');
  await expect(people.filter({ hasText: 'Revy' }).locator('.ch-agent-tag')).toHaveText('Agent');
  await expect(people.filter({ hasText: 'Clark' }).locator('.ch-agent-meta')).toHaveText('Made by Bart · Answers everyone');
  await expect(people.filter({ hasText: 'Revy' }).locator('.ch-agent-meta')).toHaveText('Made by Olga Owner · Answers only Olga Owner');
  await expect(people.filter({ hasNot: win.locator('.ch-agent-tag') }).locator('.ch-agent-meta')).toHaveCount(0);
  // All of Bart's agents are in: the list's Add agents button hides.
  await expect(members.locator('[data-add]')).toBeHidden();
  await expect(people.filter({ hasText: 'Revy' }).locator('[data-person]')).toHaveCount(0);
  await people.filter({ hasText: 'Clark' }).locator('[data-person]').click();
  await expect(win.locator('.menu [role^="menuitem"]')).toHaveText(['Remove from #general']);
  await win.keyboard.press('Escape');
  await members.locator('.buttons button').last().click();
  await expect(pane().locator('.ch-main .ch-meta')).toHaveText('2 members · 2 agents', { timeout: 15000 });
  // Add agents again: nothing left, said for his agents alone, with no "Everyone is in" and no Invite people.
  await roomMenu(win, 'Add agents');
  const again = dialogBox(win);
  await expect(again.locator('[data-pick] [data-empty]')).toHaveAttribute('data-empty', 'agents', { timeout: 15000 });
  await expect(again.locator('[data-pick] [data-empty]')).toHaveText('All your agents are in #general already');
  await expect(again.locator('[data-invite]')).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim')).toHaveCount(0);

  // The mention list: both agents with the tag; Revy says it answers only Olga, and can still be mentioned.
  const input = composer(win);
  await input.click();
  await win.keyboard.type('@');
  const option = (name) => picker().locator('[role="option"]', { has: win.locator('.mention-name', { hasText: name }) });
  await expect(option('Revy').locator('.mention-tag')).toHaveText('Agent', { timeout: 15000 });
  await expect(option('Revy').locator('.mention-note')).toHaveText('Answers only Olga Owner');
  await expect(option('Clark').locator('.mention-tag')).toHaveText('Agent');
  await expect(option('Clark').locator('.mention-note')).toHaveCount(0);
  await expect(option('Olga Owner').locator('.mention-tag')).toHaveCount(0);
  await win.keyboard.type('Cla');
  await expect(picker().locator('[role="option"] .mention-name')).toHaveText(['Clark']);
  await win.keyboard.press('Enter');
  await expect(input.locator(`.ch-chip[data-member="${clark.id}"]`)).toHaveText('@Clark');
  await win.keyboard.type('what changed today?');
  await win.keyboard.press('Enter');
  let asked = null;
  await expect
    .poll(async () => {
      asked = (await serverMessages(server, olga, ws.id, ws.general)).find((m) => m.mentions.some((x) => x.actor === clark.id)) || null;
      return Boolean(asked);
    }, { timeout: 15000 })
    .toBe(true);
  expect(asked.text).toBe('@Clark what changed today?');

  // The agent's reply, posted with its key as a runner does, shows in the thread of the question with the Agent tag.
  await server.agentReply(key, ws.id, ws.general, { trigger: asked.id, text: 'Two fixes went out.' });
  const reply = messageRow(win, 'Two fixes went out.');
  await expect(reply).toHaveCount(1, { timeout: 15000 });
  await expect(reply).toHaveAttribute('data-root', asked.id);
  await expect(reply.locator('.ch-name')).toHaveText('Clark');
  await expect(reply.locator('.ch-tag')).toHaveText('Agent');
  await expect(reply.locator('.avatar')).toHaveClass(/\bis-agent\b/);
  // Its menu has no Message Clark and no Block Clark, and Remove message for Bart, who made Clark.
  await (await hoverTool(reply, 'menu')).click();
  const items = win.locator('.menu [role^="menuitem"]');
  await expect(items.first()).toBeVisible();
  await expect(items.filter({ hasText: 'Clark' })).toHaveCount(0);
  await expect(items.filter({ hasText: 'Remove message' })).toHaveCount(1);
  await win.keyboard.press('Escape');
  // Mentioning Revy goes out too, although Revy won't answer Bart (the server refuses that reply).
  await input.click();
  await win.keyboard.type('@Rev');
  await expect(picker().locator('[role="option"] .mention-name')).toHaveText(['Revy'], { timeout: 15000 });
  await win.keyboard.press('Enter');
  await win.keyboard.type('hello');
  await win.keyboard.press('Enter');
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, '@Revy hello')).length, { timeout: 15000 }).toBe(1);
  const toRevy = (await serverMessages(server, olga, ws.id, ws.general, '@Revy hello'))[0];
  await expect(server.agentReply(revy.key, ws.id, ws.general, { trigger: toRevy.id, text: 'Not for you' })).rejects.toThrow(/403.*not_answered/);

  // Bart removes his agent's reply: it goes for everyone, as his own message would.
  const replyId = await reply.getAttribute('data-id');
  await (await hoverTool(reply, 'menu')).click();
  await menuItem(win, 'Remove message').click();
  const confirm = dialogBox(win);
  await expect(confirm.locator('h2')).toHaveText('Remove this message?');
  await confirm.locator('.buttons button').last().click();
  await expect(win.locator(`li.ch-msg[data-id="${replyId}"] .ch-removed`)).toHaveText('Message removed', { timeout: 15000 });
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general)).find((e) => e.id === replyId)?.redacted, { timeout: 15000 }).toBe(true);
});

test('workspace members show the agents in a group of their own, with no Message, Block or role; New message leaves them out', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  await olgasAgent(olga, ws);
  const mine = await server.seedAgent(bart, ws, { name: 'Clark' });
  await ready(bart);

  await workspaceMenu(win, 'Members');
  const dialog = dialogBox(win);
  await expect(dialog.locator('.ch-group')).toHaveText(['Owners', 'Members', 'Agents'], { timeout: 15000 });
  const agents = dialog.locator('.ch-person[data-kind="agent"]');
  await expect(agents.locator('.ch-person-name')).toHaveText(['Clark', 'Revy']);
  // The group heading says what they are: no tag on the rows. Each says who made it and whom it answers.
  await expect(agents.locator('.ch-tag')).toHaveCount(0);
  await expect(agents.locator('.ch-agent-meta')).toHaveText(['Made by Bart · Answers everyone', 'Made by Olga Owner · Answers only Olga Owner']);
  // Olga's agent: Bart, a member, has nothing to do with it.
  await expect(agents.filter({ hasText: 'Revy' }).locator('[data-person]')).toHaveCount(0);
  // His own: Edit, New key and Remove, and never Message, Block or a role.
  await agents.filter({ hasText: 'Clark' }).locator('[data-person]').click();
  await expect(win.locator('.menu [role^="menuitem"]')).toHaveText(['Edit agent', 'New key', 'Remove agent']);
  await menuItem(win, 'Edit agent').click();
  const form = dialogBox(win);
  await expect(form.locator('h2')).toHaveText('Edit Clark');
  await form.locator('[name="answers"][value="sponsor"]').check();
  await form.locator('[name="agents"]').check();
  await form.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(1, { timeout: 15000 });
  const changed = await server.agentCall(mine.key, 'GET', `/v1/workspaces/${ws.id}/agents/me`);
  expect([changed.body.agent.answers, changed.body.agent.agents]).toEqual(['sponsor', true]);

  // New key: asked first; the old key stops, and the new one shows once.
  await agents.filter({ hasText: 'Clark' }).locator('[data-person]').click();
  await menuItem(win, 'New key').click();
  const confirm = dialogBox(win);
  await expect(confirm.locator('h2')).toHaveText('Make a new key for Clark?');
  await confirm.locator('.buttons button').last().click();
  const step = dialogBox(win);
  await expect(step.locator('h2')).toHaveText('Key for Clark', { timeout: 15000 });
  const key = await step.locator('[name="key"]').inputValue();
  expect(key).toMatch(KEY);
  expect(key).not.toBe(mine.key);
  expect((await server.agentCall(mine.key, 'GET', `/v1/workspaces/${ws.id}/agents/me`)).status).toBe(401);
  expect((await server.agentCall(key, 'GET', `/v1/workspaces/${ws.id}/agents/me`)).status).toBe(200);
  await step.locator('[data-copy-config]').click();
  await expect(toast()).toHaveText('Config copied');
  await step.locator('.buttons button').last().click();
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);

  // New message lists only people.
  await win.locator('.sidebar [data-ch-side="new-message"]').click();
  const nm = dialogBox(win);
  await expect(nm.locator('h2')).toHaveText('New message');
  await expect(nm.locator('[data-list] .ch-person-name')).toHaveText(['Olga Owner']);
  await nm.locator('[name="to"]').fill('Cla');
  await expect(nm.locator('[data-list] [data-pick]')).toHaveCount(0);
  await expect(nm.locator('[data-none]')).toHaveText('Nobody found');
});

test("an admin edits and removes someone else's agent but gets no New key; a private channel offers only agents whose sponsor is in it", async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const admin = await server.call('PATCH', `/v1/workspaces/${ws.id}/members/${bartMe.id}`, { token: olga.token, body: { role: 'admin' } });
  expect(admin.status).toBe(200);
  await server.seedAgent(olga, ws, { name: 'Revy', answers: 'sponsor' });
  await server.seedAgent(bart, ws, { name: 'Clark' });
  const secret = await server.seedChannel(bart, ws.id, { name: 'secret', visibility: 'private' });
  await ready(bart);

  // Workspace members: Olga's agent has Edit agent and Remove agent for Bart, an admin, and New key only for Olga.
  await workspaceMenu(win, 'Members');
  const dialog = dialogBox(win);
  const agents = dialog.locator('.ch-person[data-kind="agent"]');
  await expect(agents.locator('.ch-person-name')).toHaveText(['Clark', 'Revy'], { timeout: 15000 });
  await agents.filter({ hasText: 'Revy' }).locator('[data-person]').click();
  await expect(win.locator('.menu [role^="menuitem"]')).toHaveText(['Edit agent', 'Remove agent']);
  await win.keyboard.press('Escape');
  await agents.filter({ hasText: 'Clark' }).locator('[data-person]').click();
  await expect(win.locator('.menu [role^="menuitem"]')).toHaveText(['Edit agent', 'New key', 'Remove agent']);
  await win.keyboard.press('Escape');
  await dialog.locator('.buttons button').last().click();
  // The Agents dialog says the same.
  await workspaceMenu(win, 'Agents');
  const list = dialogBox(win);
  await list.locator('[data-agent-row]', { hasText: 'Revy' }).locator('[data-agent]').click();
  await expect(win.locator('.menu [role^="menuitem"]')).toHaveText(['Edit agent', 'Remove agent']);
  await win.keyboard.press('Escape');
  await list.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);

  // Private #secret, which Bart manages and Olga isn't in: Add people offers Olga as a person, and of the agents only
  // Clark, since Revy comes in only while Olga is in it.
  await roomRow(win, 'secret').click();
  await roomMenu(win, 'Add people');
  let picker = dialogBox(win);
  await expect(picker.locator('.ch-sub')).toHaveText('Add people to #secret', { timeout: 15000 });
  await expect(picker.locator('[data-pick] .ch-group')).toHaveText(['People', 'Agents']);
  await expect(picker.locator('[data-pick] [data-kind="agent"] .ch-check-label')).toHaveText(['Clark']);
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim')).toHaveCount(0);

  // With Olga in it, Revy is offered. If she leaves before Add, the server's refusal shows in plain words.
  const added = await server.call('POST', `/v1/workspaces/${ws.id}/channels/${secret.id}/members`, { token: bart.token, body: { member: ws.me.id } });
  expect(added.status).toBe(200);
  await roomMenu(win, 'Add people');
  picker = dialogBox(win);
  await expect(picker.locator('[data-pick] [data-kind="agent"] .ch-check-label')).toHaveText(['Clark', 'Revy'], { timeout: 15000 });
  await picker.locator('[data-pick] [data-kind="agent"]', { hasText: 'Revy' }).locator('input[name="pick"]').check();
  const left = await server.call('DELETE', `/v1/workspaces/${ws.id}/channels/${secret.id}/members/me`, { token: olga.token });
  expect([200, 204]).toContain(left.status);
  await picker.locator('[data-add-go]').click();
  await expect(picker.locator('[data-error="pick"]')).toHaveText("Couldn't add Revy. An agent can be in a private channel only while the person who made it is in it.", { timeout: 15000 });
  // The list loads again without Olga, so Revy isn't offered any more.
  await expect(picker.locator('[data-pick] [data-kind="agent"] .ch-check-label')).toHaveText(['Clark'], { timeout: 15000 });
});

// An archived channel keeps its history, and an agent's key reads it on until the agent leaves (server/WORKSPACES.md
// "Channels"). So the channel's managers and the agent's sponsor can still take it out there; nothing else changes.
test("an archived channel keeps an agent's Remove for its managers and the agent's sponsor, and nothing else", async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const revy = await server.seedAgent(olga, ws, { name: 'Revy', answers: 'sponsor' });
  const clark = await server.seedAgent(bart, ws, { name: 'Clark' });
  // Bart's #launch with Olga and both agents; Olga's #ops with Bart, Revy and Clark, whom Bart adds as its sponsor.
  const launch = await server.seedChannel(bart, ws.id, { name: 'launch', members: [ws.me.id, clark.agent.id, revy.agent.id] });
  const ops = await server.seedChannel(olga, ws.id, { name: 'ops', members: [bartMe.id, revy.agent.id] });
  const added = await server.call('POST', `/v1/workspaces/${ws.id}/channels/${ops.id}/members`, { token: bart.token, body: { member: clark.agent.id } });
  expect(added.status).toBe(200);
  const inside = async (channel) => (await serverGet(server, olga, ws.id, `/channels/${channel.id}/members`)).members.map((m) => m.member);
  // Archived while it is open, so it stays in the sidebar.
  const archive = async (person, channel) => {
    await roomRow(win, channel.name).click();
    const done = await server.call('PATCH', `/v1/workspaces/${ws.id}/channels/${channel.id}`, { token: person.token, body: { archived: true } });
    expect(done.status).toBe(200);
    await expect(pane().locator('.ch-main .ch-bar-text')).toHaveText(`#${channel.name} is archived. You can still read it.`, { timeout: 15000 });
  };
  await ready(bart);
  const dialog = dialogBox(win);
  const people = dialog.locator('[data-people] .ch-person');
  const row = (name) => people.filter({ has: win.locator('.ch-person-name', { hasText: name }) });

  // #launch, which Bart manages: no Add people and no menu for Olga, but each agent keeps Remove, and only that.
  await archive(bart, launch);
  await roomMenu(win, 'Members');
  await expect(people).toHaveCount(4, { timeout: 15000 });
  await expect(dialog.locator('[data-add]')).toHaveCount(0);
  await expect(row('Olga Owner').locator('[data-person]')).toHaveCount(0);
  await expect(row('Clark').locator('[data-person]')).toHaveCount(1);
  await row('Revy').locator('[data-person]').click();
  await expect(win.locator('.menu [role^="menuitem"]')).toHaveText(['Remove from #launch']);
  // Bart takes Olga's agent out as the channel's manager; the server agrees and the list loses it.
  await menuItem(win, 'Remove from #launch').click();
  await expect(dialog.locator('h2')).toHaveText('Remove Revy from #launch?');
  await dialog.locator('.buttons button').last().click();
  await expect(dialog.locator('h2')).toHaveText('Members of #launch');
  await expect(people).toHaveCount(3, { timeout: 15000 });
  await expect(row('Revy')).toHaveCount(0);
  expect(await inside(launch)).not.toContain(revy.agent.id);
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);

  // Olga's #ops, where Bart is a member: only his own agent has a menu, with Remove; Olga and Revy have none.
  await archive(olga, ops);
  await roomMenu(win, 'Members');
  await expect(people).toHaveCount(4, { timeout: 15000 });
  await expect(dialog.locator('[data-add]')).toHaveCount(0);
  await expect(row('Olga Owner').locator('[data-person]')).toHaveCount(0);
  await expect(row('Revy').locator('[data-person]')).toHaveCount(0);
  await row('Clark').locator('[data-person]').click();
  await expect(win.locator('.menu [role^="menuitem"]')).toHaveText(['Remove from #ops']);
  await menuItem(win, 'Remove from #ops').click();
  await dialog.locator('.buttons button').last().click();
  await expect(row('Clark')).toHaveCount(0, { timeout: 15000 });
  expect(await inside(ops)).not.toContain(clark.agent.id);
});

// An agent's captions (who made it, whom it answers, when it last connected) are 12px, so they take chat's caption
// grey: at least 4.5:1 on the dialogs and the mention list, which open outside the chat view, in dark and light.
test("an agent's captions pass 4.5:1 in the Agents and Members dialogs, Add agents and the mention list, in dark and light", async () => {
  const { olga, bart, ws } = await twoPeople(server);
  await olgasAgent(olga, ws);
  await server.seedAgent(bart, ws, { name: 'Clark' });
  await ready(bart);

  for (const theme of ['dark', 'light']) {
    await win.evaluate((value) => window.mail.call('updateSettings', { theme: value }), theme);
    if (theme === 'light') await expect(win.locator('html')).toHaveClass(/\blight\b/);
    else await expect(win.locator('html')).not.toHaveClass(/\blight\b/);

    await workspaceMenu(win, 'Agents');
    await expect(dialogBox(win).locator('[data-agents] .ch-agent-meta')).toHaveCount(2, { timeout: 15000 });
    await expectReadable(dialogBox(win).locator('[data-agents] .ch-agent-meta'), `${theme}, Agents`);
    await win.keyboard.press('Escape');
    await expect(win.locator('.scrim')).toHaveCount(0);

    await workspaceMenu(win, 'Members');
    await expect(dialogBox(win).locator('.ch-person[data-kind="agent"] .ch-agent-meta')).toHaveCount(2, { timeout: 15000 });
    await expectReadable(dialogBox(win).locator('.ch-person[data-kind="agent"] .ch-agent-meta'), `${theme}, workspace members`);
    await win.keyboard.press('Escape');
    await expect(win.locator('.scrim')).toHaveCount(0);

    await roomMenu(win, 'Members');
    await expect(dialogBox(win).locator('[data-people] .ch-agent-meta')).toHaveText('Made by Olga Owner · Answers only Olga Owner', { timeout: 15000 });
    await expectReadable(dialogBox(win).locator('[data-people] .ch-agent-meta'), `${theme}, #general's members`);
    await win.keyboard.press('Escape');
    await expect(win.locator('.scrim')).toHaveCount(0);

    await roomMenu(win, 'Add agents');
    await expect(dialogBox(win).locator('[data-pick] .ch-agent-note')).toHaveText('Answers everyone', { timeout: 15000 });
    await expectReadable(dialogBox(win).locator('[data-pick] .ch-agent-note'), `${theme}, Add agents`);
    await win.keyboard.press('Escape');
    await expect(win.locator('.scrim')).toHaveCount(0);

    // The mention list, and its row Enter picks, which has the selected-row grey under the note.
    await composer(win).click();
    await win.keyboard.type('@');
    await expect(picker().locator('.mention-note')).toHaveText(['Answers only Olga Owner'], { timeout: 15000 });
    await expectReadable(picker().locator('.mention-note'), `${theme}, mentions`);
    await win.keyboard.type('Rev');
    await expect(picker().locator('[role="option"] .mention-name')).toHaveText(['Revy']);
    await expect(picker().locator('[role="option"].active .mention-note')).toHaveText('Answers only Olga Owner');
    await expectReadable(picker().locator('[role="option"].active .mention-note'), `${theme}, the mention Enter picks`);
    await win.keyboard.press('Escape');
    await expect(picker()).toHaveCount(0);
    await win.keyboard.press('ControlOrMeta+a');
    await win.keyboard.press('Backspace');
  }
});
