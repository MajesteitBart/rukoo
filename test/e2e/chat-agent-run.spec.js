// Run on this computer (src/main/agent-runs.js): the real app on a throwaway profile against the real account server,
// with a custom agent of Settings, Agents that speaks Chat Completions as the agent that answers. That agent is a
// small server in this test, so no model runs, but everything between is real: the key step, the runner in Electron's
// utility process with the shipped integrations/agent-runner, the key kept encrypted in the profile, the mention and
// the reply. Bart makes Helper and runs it here; it answers, again after a restart and after New key. Stopped, a
// mention gets the toast that it won't answer; removed, its runner ends and its key leaves the profile.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { skipWithoutServer, startServer, launch, signIn, openChat, twoPeople, dialogBox, menuItem, workspaceMenu, composer, connected, directoryIn, messageRow } = require('./chat-helpers');

skipWithoutServer();

let server;
let echo;
let app;
let win;
let dataDir;

// The agent that answers: Chat Completions that answers "Echo: " and the text of the message it answers.
function startEcho() {
  const asked = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'echo', object: 'model' }] }));
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const data = JSON.parse(body || '{}');
        const input = String((data.messages || []).find((m) => m.role === 'user')?.content || '');
        asked.push({ input, auth: req.headers.authorization || null });
        const m = input.match(/\[The message you answer:\]\n\[[^\]]*\]\n([^\n]*)/);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: `Echo: ${m ? m[1] : '?'}` }, finish_reason: 'stop' }] }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, asked, close: () => new Promise((r) => srv.close(r)) })));
}

test.beforeAll(async () => {
  server = await startServer();
  echo = await startEcho();
});

test.afterAll(async () => {
  await echo?.close();
  await server?.close();
});

test.beforeEach(() => {
  dataDir = tempDir('rukoo-chat-agent-run-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const pane = () => win.locator('section.chat');
const toast = () => win.locator('#toast');
const runs = () => app.evaluate(() => global.__semAgentRuns.snapshot());
const KEY = /^rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

async function ready(person) {
  ({ app, win } = await launch(server, { dataDir }));
  if (person) await signIn(win, person);
  await openChat(win);
  await expect(win.locator('.sidebar .ch-row[title="general"]')).toBeVisible({ timeout: 15000 });
  await connected(win);
  await directoryIn(app, win);
}

// Echo, a custom agent of Settings, Agents at the test's server, as Bart's default agent.
async function addEcho() {
  const { id } = await win.evaluate(() => window.mail.call('agentAddCustom', 'openai'));
  await win.evaluate(([agent, url]) => window.mail.call('agentUpdateConfig', { custom: { [agent]: { url, name: 'Echo' } }, defaultAgent: agent }), [id, echo.url]);
  return id;
}

// Mentions Helper in general with the picker.
async function ask(question) {
  const input = composer(win);
  await input.click();
  await win.keyboard.type('@Hel');
  await expect(win.locator('.ch-suggest [role="option"] .mention-name')).toHaveText(['Helper'], { timeout: 15000 });
  await win.keyboard.press('Enter');
  await win.keyboard.type(question);
  await win.keyboard.press('Enter');
}

// Helper's reply, which the echo agent makes from the question.
async function answered(question) {
  const reply = messageRow(win, `Echo: @Helper ${question}`);
  await expect(reply).toHaveCount(1, { timeout: 60000 });
  await expect(reply.locator('.ch-name')).toHaveText('Helper');
  await expect(reply.locator('.ch-tag')).toHaveText('Agent');
}

// The Agents dialog's row for Helper.
async function agentsRow() {
  await workspaceMenu(win, 'Agents');
  const list = dialogBox(win);
  const row = list.locator('[data-agent-row]', { hasText: 'Helper' });
  await expect(row).toHaveCount(1, { timeout: 15000 });
  return { list, row };
}

async function rowMenu(row, item) {
  await row.locator('[data-agent]').click();
  await menuItem(win, item).first().click();
}

async function closeDialogs() {
  while ((await win.locator('.scrim').count()) > 0) await dialogBox(win).locator('.buttons button').last().click();
}

test('Run on this computer: the agent answers a mention with no terminal, again after a restart and after New key; stopped it gets the toast, removed its runner ends', async () => {
  test.setTimeout(300000);
  const { bart, ws } = await twoPeople(server);
  await ready(bart);
  const echoId = await addEcho();

  // Add an agent: the dialog and the form say Rukoo runs it here.
  await workspaceMenu(win, 'Agents');
  const list = dialogBox(win);
  await expect(list.locator('.ch-agents-intro')).toContainText('Rukoo can run it on this computer');
  await list.locator('[data-add-agent]').click();
  const form = dialogBox(win);
  await expect(form.locator('.ch-agent-runs')).toHaveText('Next you choose who answers for it, and Rukoo runs it on this computer.');
  await form.locator('[name="name"]').fill('Helper');
  await form.locator('[name="answers"][value="everyone"]').check();
  await form.locator('.buttons button').last().click();

  // Connect Helper: Answers with is on Echo, and Run on this computer is the filled button with the focus.
  const step = dialogBox(win);
  await expect(step.locator('h2')).toHaveText('Connect Helper', { timeout: 15000 });
  await expect(step.locator('[name="use"]')).toHaveValue(echoId);
  await expect(step.locator('[data-run]')).toBeFocused();
  await step.locator('[data-run]').click();
  // It runs here: the button gives way to the line of what it does, and Done is the filled button.
  await expect(step.locator('[data-run]')).toBeHidden({ timeout: 15000 });
  await expect(step.locator('[data-run-state] .ch-run-text')).toHaveText(/^Running on this computer/, { timeout: 30000 });
  await expect(step).not.toHaveClass(/\bch-quiet-close\b/);
  // What the window sees of it has no key; the profile has the key encrypted, and the runner's files hold none.
  const setup = await runs();
  expect(setup.available).toBe(true);
  expect(setup.runs).toHaveLength(1);
  expect(setup.runs[0]).toMatchObject({ ws: ws.id, name: 'Helper', use: echoId, on: true, phase: 'running' });
  expect(JSON.stringify(setup)).not.toMatch(/rka_/);
  await step.locator('[data-elsewhere] summary').click();
  await expect(step.locator('[name="config"]')).not.toHaveValue('');
  const key = JSON.parse(await step.locator('[name="config"]').inputValue()).key;
  expect(key).toMatch(KEY);
  const stored = fs.readFileSync(path.join(dataDir, 'data', 'agent-runs.json'), 'utf8');
  expect(stored).not.toContain(key);
  expect(JSON.parse(stored).runs[0].key).toMatch(/^enc:/);
  for (const f of fs.readdirSync(path.join(dataDir, 'data', 'agent-runs'))) expect(fs.readFileSync(path.join(dataDir, 'data', 'agent-runs', f), 'utf8')).not.toContain(key);
  // Done: no question, and Helper joins general, which is on screen.
  await step.locator('.buttons button').last().click();
  await expect(list.locator('[data-agent-row]', { hasText: 'Helper' }).locator('.ch-agent-run .ch-run-text')).toHaveText(/^Running on this computer/, { timeout: 15000 });
  await list.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  await expect(pane().locator('.ch-main .ch-meta')).toHaveText('2 members · 1 agent', { timeout: 15000 });

  // A mention: Helper answers in its thread, through the runner here.
  await ask('what is two plus two?');
  await answered('what is two plus two?');
  // Echo got the message with the runner's instructions, and no key: Echo has none in Settings.
  expect(echo.asked.at(-1).input).toContain('@Helper what is two plus two?');
  expect(echo.asked.at(-1).auth).toBe(null);

  // Rukoo quits and starts again: Helper runs again without a step, and answers.
  await closeApp(app);
  app = null;
  await ready(null);
  await expect.poll(async () => (await runs()).runs.map((r) => r.phase).join(), { timeout: 30000 }).toBe('running');
  await ask('are you back?');
  await answered('are you back?');

  // New key: the step doesn't offer Run on this computer again, since Helper runs here with the new key already.
  let { row } = await agentsRow();
  await rowMenu(row, 'New key');
  const confirm = dialogBox(win);
  await expect(confirm).toContainText('Helper keeps running on this computer with the new key.');
  await confirm.locator('.buttons button').last().click();
  const again = dialogBox(win);
  await expect(again.locator('h2')).toHaveText('Connect Helper', { timeout: 15000 });
  await expect(again.locator('[data-run]')).toBeHidden();
  await expect(again.locator('[data-run-state] .ch-run-text')).toHaveText(/^Running on this computer/, { timeout: 30000 });
  await again.locator('[data-elsewhere] summary').click();
  await expect(again.locator('[name="config"]')).not.toHaveValue('');
  const renewed = JSON.parse(await again.locator('[name="config"]').inputValue()).key;
  expect(renewed).toMatch(KEY);
  expect(renewed).not.toBe(key);
  expect((await server.agentCall(key, 'GET', `/v1/workspaces/${ws.id}/agents/me`)).status).toBe(401);
  await closeDialogs();
  await ask('still there?');
  await answered('still there?');

  // Stop: the row says so, and a mention goes out with a toast that Helper won't answer.
  ({ row } = await agentsRow());
  await rowMenu(row, 'Stop on this computer');
  await expect(row.locator('.ch-agent-run .ch-run-text')).toHaveText('Stopped on this computer', { timeout: 15000 });
  await row.locator('[data-agent]').click();
  await expect(win.locator('.menu [role^="menuitem"]')).toHaveText(['Edit agent', 'New key', 'Start on this computer', 'Remove from this computer', 'Remove agent']);
  await win.keyboard.press('Escape');
  await closeDialogs();
  await ask('anyone home?');
  await expect(toast()).toHaveText("Helper is stopped on this computer, so it won't answer unless it runs somewhere else.", { timeout: 15000 });
  expect((await runs()).runs[0].phase).toBe('stopped');

  // Start again, then Remove agent: its runner here ends and its key leaves the profile.
  ({ row } = await agentsRow());
  await rowMenu(row, 'Start on this computer');
  await expect(row.locator('.ch-agent-run .ch-run-text')).toHaveText(/^Running on this computer/, { timeout: 30000 });
  await rowMenu(row, 'Remove agent');
  await dialogBox(win).locator('.buttons button').last().click();
  await expect(dialogBox(win).locator('[data-agents] .ch-agents-none')).toHaveText('No agents yet.', { timeout: 15000 });
  expect((await runs()).runs).toEqual([]);
  await expect.poll(() => app.evaluate(() => [...global.__semAgentRuns.live.values()].filter((s) => s.child).length)).toBe(0);
  expect(fs.existsSync(path.join(dataDir, 'data', 'agent-runs.json'))).toBe(false);
  await expect.poll(() => (fs.existsSync(path.join(dataDir, 'data', 'agent-runs')) ? fs.readdirSync(path.join(dataDir, 'data', 'agent-runs')) : [])).toEqual([]);
});

test('signing out stops the agents this computer runs and deletes their keys', async () => {
  test.setTimeout(120000);
  const { bart } = await twoPeople(server);
  await ready(bart);
  await addEcho();
  await workspaceMenu(win, 'Agents');
  await dialogBox(win).locator('[data-add-agent]').click();
  const form = dialogBox(win);
  await form.locator('[name="name"]').fill('Helper');
  await form.locator('.buttons button').last().click();
  const step = dialogBox(win);
  await expect(step.locator('h2')).toHaveText('Connect Helper', { timeout: 15000 });
  await step.locator('[data-run]').click();
  await expect(step.locator('[data-run-state] .ch-run-text')).toHaveText(/^Running on this computer/, { timeout: 30000 });
  await closeDialogs();
  expect(fs.existsSync(path.join(dataDir, 'data', 'agent-runs.json'))).toBe(true);

  await win.evaluate(() => window.mail.call('accountSignOut'));
  await expect.poll(async () => (await runs()).runs.length, { timeout: 15000 }).toBe(0);
  await expect.poll(() => app.evaluate(() => [...global.__semAgentRuns.live.values()].filter((s) => s.child).length)).toBe(0);
  expect(fs.existsSync(path.join(dataDir, 'data', 'agent-runs.json'))).toBe(false);
  await expect.poll(() => fs.existsSync(path.join(dataDir, 'data', 'agent-runs'))).toBe(false);
});
