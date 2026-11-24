// Run on this computer (src/main/agent-runs.js): the real app on a throwaway profile against the real account server,
// with a custom agent of Settings, Agents that speaks Chat Completions as the agent that answers. That agent is a
// small server in this test, so no model runs, but everything between is real: the key step, main's question before
// it runs (answered through global.__semAgentRunAnswer, as the quit question is), the runner in Electron's utility
// process with the shipped integrations/agent-runner, the key kept encrypted in the profile, the mention and the
// reply. Bart makes Helper and runs it here; it answers, again after a restart and after New key. Stopped, a mention
// gets the toast that it won't answer; removed, its runner ends and its key leaves the profile. Another address for
// Echo in Settings stops Helper until Bart runs it again and says yes to the new address. The window never has the
// key: Copy config goes through main, and a reload ends what main held for the window.
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
let other;
let app;
let win;
let dataDir;

// The agent that answers: Chat Completions that answers prefix, ": " and the text of the message it answers.
function startEcho(prefix = 'Echo') {
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
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: `${prefix}: ${m ? m[1] : '?'}` }, finish_reason: 'stop' }] }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, asked, close: () => new Promise((r) => srv.close(r)) })));
}

test.beforeAll(async () => {
  server = await startServer();
  echo = await startEcho('Echo');
  other = await startEcho('Other');
});

test.afterAll(async () => {
  await echo?.close();
  await other?.close();
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
const ANY_KEY = /rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/;
const MASK = '••••••••••••';

async function ready(person) {
  ({ app, win } = await launch(server, { dataDir }));
  if (person) await signIn(win, person);
  await openChat(win);
  await expect(win.locator('.sidebar .ch-row[title="general"]')).toBeVisible({ timeout: 15000 });
  await connected(win);
  await directoryIn(app, win);
}

// The answer to main's next questions ('run', 'copy', 'save' or 'cancel'), and the questions asked so far.
const answer = (id) =>
  app.evaluate((_e, a) => {
    global.__semAgentRunAnswer = a;
  }, id);
const asked = () => app.evaluate(() => global.__semAgentRunAsked || []);

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
async function answered(question, prefix = 'Echo') {
  const reply = messageRow(win, `${prefix}: @Helper ${question}`);
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

// Add an agent called Helper, up to its key step.
async function makeHelper() {
  await workspaceMenu(win, 'Agents');
  const list = dialogBox(win);
  await list.locator('[data-add-agent]').click();
  const form = dialogBox(win);
  await form.locator('[name="name"]').fill('Helper');
  await form.locator('[name="answers"][value="everyone"]').check();
  await form.locator('.buttons button').last().click();
  const step = dialogBox(win);
  await expect(step.locator('h2')).toHaveText('Connect Helper', { timeout: 15000 });
  return { list, step };
}

test('Run on this computer: main asks first, the agent answers a mention with no terminal, again after a restart and after New key; stopped it gets the toast, removed its runner ends', async () => {
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

  // Connect Helper: Answers with is on Echo, which keeps its own tools, and Run on this computer is the filled button.
  const step = dialogBox(win);
  await expect(step.locator('h2')).toHaveText('Connect Helper', { timeout: 15000 });
  await expect(step.locator('[name="use"]')).toHaveValue(echoId);
  await expect(step.locator('[data-tools]')).toHaveText('Echo keeps its own tools and can use them for anyone Helper answers in a channel.');
  await expect(step.locator('[data-run]')).toBeFocused();
  // Main asks first, naming the address; a no runs nothing.
  await answer('cancel');
  await step.locator('[data-run]').click();
  await expect.poll(async () => (await asked()).length).toBe(1);
  const question = (await asked())[0];
  expect(question.kind).toBe('run');
  expect(question.message).toBe('Run Helper on this computer with Echo?');
  expect(question.detail).toContain(echo.url);
  expect(question.detail).toContain('Echo keeps its own tools and can use them for anyone Helper answers.');
  expect(question.buttons).toEqual(['Cancel', 'Run on this computer']);
  await expect(step.locator('[data-run]')).toBeVisible();
  await expect(step.locator('[data-error=""]')).toBeHidden();
  expect((await runs()).runs).toEqual([]);
  await answer('run');
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
  // The config for another computer: the key hidden, and gone from what main held, since it runs here now.
  await step.locator('[data-elsewhere] summary').click();
  expect(JSON.parse(await step.locator('[name="config"]').inputValue()).key).toBe(MASK);
  await expect(step.locator('[data-copy-config]')).toBeDisabled();
  await expect(step.locator('[data-key-gone]')).toHaveText('Rukoo keeps this key for Helper on this computer now. To run Helper somewhere else instead, remove it from this computer and make a new key.');
  expect(await win.evaluate(() => document.body.innerHTML)).not.toMatch(ANY_KEY);
  const stored = fs.readFileSync(path.join(dataDir, 'data', 'agent-runs.json'), 'utf8');
  expect(stored).not.toMatch(ANY_KEY);
  expect(JSON.parse(stored).runs[0].key).toMatch(/^enc:/);
  expect(JSON.parse(stored).runs[0].approved).toEqual({ use: echoId, kind: 'custom', type: 'openai', address: echo.url });
  // No config file: the runner got its config with the key in its first message. The folder holds only its state file,
  // once it wrote one.
  const runsDir = path.join(dataDir, 'data', 'agent-runs');
  const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
  expect(files.filter((f) => !f.endsWith('.state.json'))).toEqual([]);
  for (const f of files) expect(fs.readFileSync(path.join(dataDir, 'data', 'agent-runs', f), 'utf8')).not.toMatch(ANY_KEY);
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

  // Rukoo quits and starts again: Helper runs again without a step or a question, and answers.
  await closeApp(app);
  app = null;
  await ready(null);
  await expect.poll(async () => (await runs()).runs.map((r) => r.phase).join(), { timeout: 30000 }).toBe('running');
  expect(await asked()).toEqual([]);
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
  expect(JSON.parse(await again.locator('[name="config"]').inputValue()).key).toBe(MASK);
  await expect(again.locator('[data-copy-config]')).toBeDisabled();
  await expect(again.locator('[data-key-gone]')).toHaveText('Rukoo keeps this key for Helper on this computer now. To run Helper somewhere else instead, remove it from this computer and make a new key.');
  expect(await asked()).toEqual([]);
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

  // Start again, with what was approved: no question. Then Remove agent: its runner ends and its key leaves the profile.
  ({ row } = await agentsRow());
  await rowMenu(row, 'Start on this computer');
  await expect(row.locator('.ch-agent-run .ch-run-text')).toHaveText(/^Running on this computer/, { timeout: 30000 });
  expect(await asked()).toEqual([]);
  await rowMenu(row, 'Remove agent');
  await dialogBox(win).locator('.buttons button').last().click();
  await expect(dialogBox(win).locator('[data-agents] .ch-agents-none')).toHaveText('No agents yet.', { timeout: 15000 });
  expect((await runs()).runs).toEqual([]);
  await expect.poll(() => app.evaluate(() => global.__semAgentRuns.procs.size)).toBe(0);
  expect(fs.existsSync(path.join(dataDir, 'data', 'agent-runs.json'))).toBe(false);
  await expect.poll(() => (fs.existsSync(path.join(dataDir, 'data', 'agent-runs')) ? fs.readdirSync(path.join(dataDir, 'data', 'agent-runs')) : [])).toEqual([]);
});

test('another address for what Helper answers with stops it until Bart runs it again and says yes to the new address', async () => {
  test.setTimeout(180000);
  const { bart } = await twoPeople(server);
  await ready(bart);
  const echoId = await addEcho();
  const { list, step } = await makeHelper();
  await answer('run');
  await step.locator('[data-run]').click();
  await expect(step.locator('[data-run-state] .ch-run-text')).toHaveText(/^Running on this computer/, { timeout: 30000 });
  await step.locator('.buttons button').last().click();
  await list.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  await ask('first?');
  await answered('first?');

  // Settings now send Echo's mentions elsewhere: Helper stops here, and the row says why.
  await win.evaluate(([agent, url]) => window.mail.call('agentUpdateConfig', { custom: { [agent]: { url } } }), [echoId, other.url]);
  const { row } = await agentsRow();
  await expect(row.locator('.ch-agent-run .ch-run-text')).toHaveText('Stopped: Echo changed in Settings > Agents. Run it again on this computer to approve it as it is now.', { timeout: 30000 });
  await expect.poll(() => app.evaluate(() => global.__semAgentRuns.procs.size)).toBe(0);
  await row.locator('[data-agent]').click();
  await expect(win.locator('.menu [role^="menuitem"]')).toHaveText(['Edit agent', 'New key', 'Run again on this computer', 'Remove from this computer', 'Remove agent']);
  await win.keyboard.press('Escape');
  // Run again asks, naming the new address. A no keeps it stopped.
  await app.evaluate(() => {
    global.__semAgentRunAsked = [];
    global.__semAgentRunAnswer = 'cancel';
  });
  await rowMenu(row, 'Run again on this computer');
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect((await asked())[0].detail).toContain(other.url);
  expect((await runs()).runs[0].phase).toBe('changed');
  await answer('run');
  await rowMenu(row, 'Run again on this computer');
  await expect(row.locator('.ch-agent-run .ch-run-text')).toHaveText(/^Running on this computer/, { timeout: 30000 });
  await closeDialogs();
  const before = echo.asked.length;
  await ask('second?');
  await answered('second?', 'Other');
  expect(echo.asked.length).toBe(before);
});

test('Copy config goes through main, which asks first; a reload ends the key main held for the window', async () => {
  test.setTimeout(120000);
  const { bart, ws } = await twoPeople(server);
  await ready(bart);
  await addEcho();
  const { step } = await makeHelper();
  await step.locator('[data-elsewhere] summary').click();
  const shown = JSON.parse(await step.locator('[name="config"]').inputValue());
  expect(shown.key).toBe(MASK);
  await expect(step.locator('[data-key-gone]')).toHaveText('Rukoo keeps the key out of this window, so nothing shown here can read it. Copy config asks you first, then copies it with the key.');
  // A no copies nothing.
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await answer('cancel');
  await step.locator('[data-copy-config]').click();
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect((await asked())[0]).toMatchObject({ kind: 'export', message: "Copy the config with Helper's key?", buttons: ['Cancel', 'Save to a file…', 'Copy config'] });
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('before');
  // Copy: the config the step shows, with the key.
  await answer('copy');
  await step.locator('[data-copy-config]').click();
  await expect(toast()).toHaveText('Config copied');
  const copied = JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText()));
  expect(copied.key).toMatch(KEY);
  expect({ ...copied, key: MASK }).toEqual(shown);
  // Save to a file writes the same config.
  const file = path.join(dataDir, 'helper.json');
  await app.evaluate((_e, f) => {
    global.__semAgentRunSaveTo = f;
    global.__semAgentRunAnswer = 'save';
  }, file);
  await step.locator('[data-copy-config]').click();
  await expect(toast()).toHaveText('Config saved');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(copied);
  // No call answers the key, and after a reload main holds nothing for this window: no export, no start.
  const helper = (await win.evaluate((w) => window.mail.call('chatAgents', w), ws.id)).agents.find((a) => a.name === 'Helper');
  await expect(win.evaluate(([w, a]) => window.mail.call('agentRunHeldKey', w, a), [ws.id, helper.id])).rejects.toThrow(/Onbekende actie/);
  await win.reload();
  await win.waitForFunction(() => window.mail && document.readyState === 'complete');
  await answer('copy');
  await expect(win.evaluate(([w, a]) => window.mail.call('agentRunExport', w, a, { use: 'own' }), [ws.id, helper.id])).rejects.toThrow(/no_key/);
  await expect(win.evaluate(([w, a]) => window.mail.call('agentRunStart', w, a, { use: 'own' }), [ws.id, helper.id])).rejects.toThrow(/no_key/);
  expect((await runs()).runs).toEqual([]);
});

test('signing out stops the agents this computer runs and deletes their keys', async () => {
  test.setTimeout(120000);
  const { bart } = await twoPeople(server);
  await ready(bart);
  await addEcho();
  const { step } = await makeHelper();
  await answer('run');
  await step.locator('[data-run]').click();
  await expect(step.locator('[data-run-state] .ch-run-text')).toHaveText(/^Running on this computer/, { timeout: 30000 });
  await closeDialogs();
  expect(fs.existsSync(path.join(dataDir, 'data', 'agent-runs.json'))).toBe(true);

  await win.evaluate(() => window.mail.call('accountSignOut'));
  await expect.poll(async () => (await runs()).runs.length, { timeout: 15000 }).toBe(0);
  await expect.poll(() => app.evaluate(() => global.__semAgentRuns.procs.size)).toBe(0);
  expect(fs.existsSync(path.join(dataDir, 'data', 'agent-runs.json'))).toBe(false);
  await expect.poll(() => fs.existsSync(path.join(dataDir, 'data', 'agent-runs'))).toBe(false);
});

test("Rukoo's window can't read the clipboard, and paste by the person still works in chat and in the composer", async () => {
  test.setTimeout(120000);
  const { bart } = await twoPeople(server);
  await ready(bart);
  // What main put on the clipboard, such as an exported config, a page can't read back.
  await app.evaluate(({ clipboard }) => clipboard.writeText('pasted by the person'));
  await composer(win).click();
  const read = await win.evaluate(() => navigator.clipboard.readText().then((text) => `read ${text}`, (err) => `refused ${err.name}: ${err.message}`));
  // Refused for want of permission, in a window that has the focus.
  expect(read).toMatch(/^refused NotAllowedError/);
  expect(read).not.toMatch(/focus/i);
  expect(await win.evaluate(() => navigator.permissions.query({ name: 'clipboard-read' }).then((p) => p.state, () => 'unknown'))).not.toBe('granted');
  // Ctrl+V in the chat's message field pastes.
  const input = composer(win);
  await input.click();
  await win.keyboard.press('Control+V');
  await expect(input).toContainText('pasted by the person');
  await win.keyboard.press('Control+A');
  await win.keyboard.press('Backspace');
  // And in the composer of a new email.
  const mail = win.locator('.titlebar-modes [data-mode="mail"]');
  await mail.click();
  await expect(mail).toHaveAttribute('aria-selected', 'true');
  await win.click('[data-action="compose"]');
  const editor = win.locator('.composer .editor');
  await editor.click();
  await win.keyboard.press('Control+V');
  await expect(editor).toContainText('pasted by the person');
});
