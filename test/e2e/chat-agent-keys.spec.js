// Agent keys in team chat (RUK-294): a message or an attached text file with an agent's key in it asks first, and Take
// the key out sends it with [agent key removed] in the key's place, a file uploaded again without it. Add an agent on
// the computer can start from an agent this computer runs in another workspace: its name, whom it answers (Chosen
// people become Only me) and whether it answers other agents, and the agent of Settings, Agents that answers for it;
// the new agent gets a key of its own and runs here after main asks. The real app on a throwaway profile against the
// real account server, with a custom agent that speaks Chat Completions as the one that answers. Captures of the
// question and the form go to the test's output folder.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { skipWithoutServer, startServer, launch, signIn, openChat, twoPeople, dialogBox, workspaceMenu, composer, connected, directoryIn, pickNext, tray, serverMessages, serverGet } = require('./chat-helpers');

skipWithoutServer();

// A made-up key: the shape of one, never a key of any agent.
const KEY = `rka_${'K'.repeat(22)}.${'s'.repeat(43)}`;
const MARK = '[agent key removed]';

let server;
let echo;
let app;
let win;
let dataDir;

// Chat Completions that answers "Echo".
function startEcho() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'echo', object: 'model' }] }));
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Echo' }, finish_reason: 'stop' }] }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) })));
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
  dataDir = tempDir('rukoo-chat-agent-keys-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const pane = () => win.locator('section.chat');
const switcherName = () => win.locator('.sidebar .ch-ws-switch .name');

async function ready(person) {
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, person);
  await openChat(win);
  await expect(win.locator('.sidebar .ch-row[title="general"]')).toBeVisible({ timeout: 15000 });
  await connected(win);
  await directoryIn(app, win);
}

async function capture(testInfo, name) {
  await win.waitForTimeout(300);
  await win.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

const texts = async (olga, ws) => (await serverMessages(server, olga, ws.id, ws.general)).map((e) => e.text);
const toast = () => win.locator('#toast');

// A runner config with KEY in it, as a file the person picks: { file, config }.
function keyFile(ws, name = 'agent.json') {
  const dir = path.join(dataDir, 'attach');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const config = `{\n  "server": "https://rukoo.example",\n  "workspace": "${ws.id}",\n  "key": "${KEY}",\n  "backend": { "type": "claude" }\n}\n`;
  fs.writeFileSync(file, config);
  return { file, config };
}

// Attaches files from disk to the main composer and waits until the tray has ready ones in all.
async function attach(paths, ready) {
  await pickNext(app, paths);
  await pane().locator('.ch-main [data-ch-compose="attach"]').click();
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(ready, { timeout: 20000 });
}

// Holds the bytes of every upload in main until the answer's release() runs, so the test acts while a file uploads.
async function holdUploads() {
  await app.evaluate(() => {
    const files = global.__semChat.files;
    if (!files.heldPut) {
      const put = files.put;
      files.heldPut = put;
      files.put = function (entry) {
        return (global.__semUploadGate || Promise.resolve()).then(() => put.call(this, entry));
      };
    }
    let open;
    global.__semUploadGate = new Promise((resolve) => (open = resolve));
    global.__semUploadRelease = () => {
      global.__semUploadGate = null;
      open();
    };
  });
  return () => app.evaluate(() => global.__semUploadRelease());
}

// Holds main's answers to chatAgents until the answer's release() runs.
async function holdAgentReads() {
  await app.evaluate(() => {
    const api = global.__semApi;
    if (!api.heldAgents) {
      const read = api.chatAgents;
      api.heldAgents = read;
      api.chatAgents = (...args) => (global.__semAgentsGate || Promise.resolve()).then(() => read(...args));
    }
    let open;
    global.__semAgentsGate = new Promise((resolve) => (open = resolve));
    global.__semAgentsRelease = () => {
      global.__semAgentsGate = null;
      open();
    };
  });
  return () => app.evaluate(() => global.__semAgentsRelease());
}

// Olga and Bart in Acme, and Bart's Clark in Beta, which answers Olga there (a chosen person) and other agents, and runs
// on this computer with Echo, a custom agent of Settings, Agents. Acme on screen.
async function clarkInBeta() {
  const { olga, bart, ws } = await twoPeople(server);
  const beta = await server.seedWorkspace(bart, { name: 'Beta', displayName: 'Bart' });
  const olgaInBeta = await server.seedMember(beta, olga, 'Olga');
  await ready(bart);
  const { id: echoId } = await win.evaluate(() => window.mail.call('agentAddCustom', 'openai'));
  await win.evaluate(([agent, url]) => window.mail.call('agentUpdateConfig', { custom: { [agent]: { url, name: 'Echo' } }, defaultAgent: agent }), [echoId, echo.url]);
  await app.evaluate(() => {
    global.__semAgentRunAnswer = 'run';
  });
  const made = await win.evaluate(([w, olgaId]) => window.mail.call('chatCreateAgent', w, { name: 'Clark', answers: 'members', members: [olgaId], agents: true }), [beta.id, olgaInBeta.id]);
  expect(made.key).toBeUndefined();
  await win.evaluate(([w, a, use]) => window.mail.call('agentRunStart', w, a, { use }), [beta.id, made.agent.id, echoId]);
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mail:event', { type: 'chat', payload });
    },
    { kind: 'open', ws: ws.id, conversation: ws.general }
  );
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });
  await directoryIn(app, win);
  return { olga, bart, ws, beta, made, echoId };
}

test("a message with an agent's key asks first: Cancel keeps it, Send anyway sends it, Take the key out sends it without the key", async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  await ready(bart);
  await composer(win).click();
  await win.keyboard.type(`Here is the key ${KEY} for Clark`);
  await win.keyboard.press('Enter');
  const question = dialogBox(win);
  await expect(question.locator('h2')).toHaveText("Send an agent's key?");
  await expect(question.locator('.dialog-body p')).toHaveText([
    "This message holds an agent's key.",
    "Anyone who reads this conversation could use the key to read every channel the agent is in and write there as the agent. An agent's key belongs in its runner, never in a message."
  ]);
  await expect(question.locator('.buttons button')).toHaveText(['Cancel', 'Send anyway', 'Take the key out']);
  await expect(question.locator('.buttons button').last()).toHaveClass(/primary/);
  await capture(testInfo, 'key-question-text');
  // Cancel: nothing goes, and the text stays.
  await question.locator('.buttons button', { hasText: 'Cancel' }).click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  await expect(composer(win)).toContainText(KEY);
  expect((await texts(olga, ws)).some((t) => String(t).includes('Here is the key'))).toBe(false);

  // Take the key out: the mark in its place, and the message goes.
  await composer(win).click();
  await win.keyboard.press('Enter');
  await dialogBox(win).locator('.buttons button', { hasText: 'Take the key out' }).click();
  await expect.poll(() => texts(olga, ws), { timeout: 15000 }).toContain(`Here is the key ${MARK} for Clark`);
  await expect(composer(win)).toHaveText('');

  // Send anyway: the person decided, and the key goes.
  await composer(win).click();
  await win.keyboard.type(`Again ${KEY}`);
  await win.keyboard.press('Enter');
  await dialogBox(win).locator('.buttons button', { hasText: 'Send anyway' }).click();
  await expect.poll(() => texts(olga, ws), { timeout: 15000 }).toContain(`Again ${KEY}`);
});

test('a text file with an agent key asks first, and Take the key out uploads it again without the key before the message goes', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  await ready(bart);
  const dir = path.join(dataDir, 'attach');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agent.json');
  const config = `{\n  "server": "https://rukoo.example",\n  "workspace": "${ws.id}",\n  "key": "${KEY}",\n  "backend": { "type": "claude" }\n}\n`;
  fs.writeFileSync(file, config);
  await pickNext(app, [file]);
  await pane().locator('.ch-main [data-ch-compose="attach"]').click();
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(1, { timeout: 20000 });
  await composer(win).click();
  await win.keyboard.type('The config for Clark');
  await win.keyboard.press('Enter');
  const question = dialogBox(win);
  await expect(question.locator('.dialog-body p').first()).toHaveText("The file “agent.json” holds an agent's key.");
  await capture(testInfo, 'key-question-file');
  await question.locator('.buttons button', { hasText: 'Take the key out' }).click();
  // The message goes by itself once the copy without the key is up.
  await expect
    .poll(async () => (await serverMessages(server, olga, ws.id, ws.general)).filter((e) => (e.attachments || []).some((f) => f.name === 'agent.json')).length, { timeout: 30000 })
    .toBe(1);
  const sent = (await serverMessages(server, olga, ws.id, ws.general)).find((e) => (e.attachments || []).some((f) => f.name === 'agent.json'));
  expect(sent.text).toBe('The config for Clark');
  const got = await server.download(olga, ws.id, ws.general, sent.attachments[0].id);
  expect(got.status).toBe(200);
  expect(got.bytes.toString('utf8')).toBe(config.replace(KEY, MARK));
  // The file on disk stays as the person had it.
  expect(fs.readFileSync(file, 'utf8')).toContain(KEY);
  await expect(tray(win)).toBeHidden();
});

test('Add an agent copies one this computer runs in another workspace: its settings without its chosen people, and what answers for it', async ({}, testInfo) => {
  test.setTimeout(240000);
  const { olga, ws, made, echoId } = await clarkInBeta();

  await workspaceMenu(win, 'Agents');
  await dialogBox(win).locator('[data-add-agent]').click();
  const form = dialogBox(win);
  const copy = form.locator('[name="copy"]');
  await expect(copy.locator('option')).toHaveText(["Don't copy", 'Clark, in Beta']);
  await expect(form.locator('[data-copy-help]')).toHaveText(
    'Takes the name, whom it answers, whether it answers other agents and what answers for it from an agent this computer runs in another workspace. The new agent gets a key of its own.'
  );
  await copy.selectOption({ label: 'Clark, in Beta' });
  await expect(form.locator('[name="name"]')).toHaveValue('Clark');
  await expect(form.locator('[name="answers"][value="sponsor"]')).toBeChecked();
  await expect(form.locator('[name="agents"]')).toBeChecked();
  await expect(form.locator('[data-copy-help]')).toHaveText('Clark answers chosen people in Beta. They are members of that workspace, so the new agent starts on Only me here.');
  await capture(testInfo, 'copy-form');
  await form.locator('.buttons button').last().click();

  // The key step picks Echo, which answers for Clark in Beta, and runs the new agent here after main asks.
  const step = dialogBox(win);
  await expect(step.locator('h2')).toHaveText('Connect Clark', { timeout: 15000 });
  await expect(step.locator('[name="use"]')).toHaveValue(echoId);
  await capture(testInfo, 'copy-key-step');
  const before = await app.evaluate(() => (global.__semAgentRunAsked || []).length);
  await step.locator('[data-run]').click();
  await expect.poll(() => app.evaluate(() => (global.__semAgentRunAsked || []).length)).toBe(before + 1);
  await expect.poll(() => app.evaluate(() => global.__semAgentRuns.snapshot().runs.length), { timeout: 15000 }).toBe(2);
  const setups = await app.evaluate(() => global.__semAgentRuns.snapshot().runs.map((r) => ({ ws: r.ws, agent: r.agent, use: r.use })));
  const here = setups.find((r) => r.ws === ws.id);
  expect(here.use).toBe(echoId);
  expect(here.agent).not.toBe(made.agent.id);
  // On the server: Clark in Acme answers only Bart and other agents, as a new agent of its own.
  const agents = (await serverGet(server, olga, ws.id, '/agents')).agents;
  const clark = agents.find((a) => a.name === 'Clark');
  expect(clark).toMatchObject({ answers: 'sponsor', agents: true });
  expect(clark.id).toBe(here.agent);
});

// RUK-294 review, P1: a draft kept a key-bearing file's upload but not what the scan found, so after a restart Send
// posted it without asking.
test("a draft's file with an agent key asks again after a restart, and Take the key out then says to attach it again", async ({}, testInfo) => {
  test.setTimeout(180000);
  const { olga, bart, ws } = await twoPeople(server);
  await ready(bart);
  const { file } = keyFile(ws);
  await attach([file], 1);
  await composer(win).click();
  await win.keyboard.type('The config for Clark');
  // The draft keeps the file with what the scan found.
  await expect
    .poll(() => win.evaluate(([w, c]) => window.mail.call('chatDraft', w, c, null).then((d) => (d ? d.attachments.map((f) => [f.name, f.agentKey === true]) : [])), [ws.id, ws.general]), { timeout: 15000 })
    .toEqual([['agent.json', true]]);
  await closeApp(app);
  ({ app, win } = await launch(server, { dataDir }));
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await connected(win);
  await expect(composer(win)).toContainText('The config for Clark', { timeout: 15000 });
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(1, { timeout: 15000 });
  await composer(win).click();
  await win.keyboard.press('Enter');
  const question = dialogBox(win);
  await expect(question.locator('.dialog-body p').first()).toHaveText("The file “agent.json” holds an agent's key.");
  await question.locator('.buttons button', { hasText: 'Take the key out' }).click();
  await expect(toast()).toHaveText("Rukoo can't take the key out of “agent.json”: it no longer has the copy that was uploaded. Remove the file and attach it again.");
  await capture(testInfo, 'key-file-gone');
  // Nothing went: the text and the file stay, and Send asks again.
  await win.waitForTimeout(1500);
  expect((await texts(olga, ws)).some((t) => String(t).includes('The config for Clark'))).toBe(false);
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(1);
  await composer(win).click();
  await win.keyboard.press('Enter');
  await expect(dialogBox(win).locator('h2')).toHaveText("Send an agent's key?");
  await dialogBox(win).locator('.buttons button', { hasText: 'Cancel' }).click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  expect((await texts(olga, ws)).some((t) => String(t).includes('The config for Clark'))).toBe(false);
});

// RUK-294 review, P1: a file edited on disk after its version with the key uploaded was read again for Take the key out,
// found without the key, and its upload, the bytes with the key, went with the message.
test('Take the key out on a file that changed after it uploaded says to attach it again and sends nothing; attached again it goes', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  await ready(bart);
  const { file, config } = keyFile(ws);
  await attach([file], 1);
  const edited = config.replace(KEY, 'in the runner');
  fs.writeFileSync(file, edited);
  await composer(win).click();
  await win.keyboard.type('The config for Clark');
  await win.keyboard.press('Enter');
  await dialogBox(win).locator('.buttons button', { hasText: 'Take the key out' }).click();
  await expect(toast()).toHaveText("“agent.json” changed after it was attached, so Rukoo can't take the key out of the copy that was uploaded. Remove the file and attach it again.");
  await capture(testInfo, 'key-file-changed');
  await win.waitForTimeout(1500);
  expect((await texts(olga, ws)).some((t) => String(t).includes('The config for Clark'))).toBe(false);
  // Send asks again.
  await composer(win).click();
  await win.keyboard.press('Enter');
  await expect(dialogBox(win).locator('h2')).toHaveText("Send an agent's key?");
  await dialogBox(win).locator('.buttons button', { hasText: 'Cancel' }).click();
  // Removed and attached again, the file holds no key, and the message goes without a question.
  await tray(win).locator('.ch-tray-x').first().click();
  await expect(tray(win)).toBeHidden();
  await attach([file], 1);
  await composer(win).click();
  await win.keyboard.press('Enter');
  await expect.poll(() => texts(olga, ws), { timeout: 15000 }).toContain('The config for Clark');
  const sent = (await serverMessages(server, olga, ws.id, ws.general)).find((e) => e.text === 'The config for Clark');
  const got = await server.download(olga, ws.id, ws.general, sent.attachments[0].id);
  expect(got.bytes.toString('utf8')).toBe(edited);
});

// RUK-294 review, P2: after Take the key out on a file, the composer stayed open while the copy uploaded, and the
// message went with whatever it held by then.
test('after Take the key out on a file, a change to the text or the files while the copy uploads stops the message going by itself', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  await ready(bart);
  const { file, config } = keyFile(ws);
  await attach([file], 1);
  await composer(win).click();
  await win.keyboard.type('The config for Clark');
  let release = await holdUploads();
  await win.keyboard.press('Enter');
  await dialogBox(win).locator('.buttons button', { hasText: 'Take the key out' }).click();
  await expect(toast()).toHaveText('The key is out of the file. The message goes once the file has uploaded again, unless you change the message first.');
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(0);
  await capture(testInfo, 'key-out-uploading');
  // Text typed while the copy uploads.
  await composer(win).click();
  await win.keyboard.press('Control+End');
  await win.keyboard.type(', and one more thing');
  await expect(toast()).toHaveText("You changed the message, so it won't go by itself. Press Send when it's ready.");
  await release();
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(1, { timeout: 20000 });
  await win.waitForTimeout(1500);
  expect((await texts(olga, ws)).some((t) => String(t).includes('The config for Clark'))).toBe(false);
  // Send: no question, since the file is the copy without the key.
  await composer(win).click();
  await win.keyboard.press('Enter');
  await expect.poll(() => texts(olga, ws), { timeout: 15000 }).toContain('The config for Clark, and one more thing');
  const sent = (await serverMessages(server, olga, ws.id, ws.general)).find((e) => e.text === 'The config for Clark, and one more thing');
  expect((await server.download(olga, ws.id, ws.general, sent.attachments[0].id)).bytes.toString('utf8')).toBe(config.replace(KEY, MARK));

  // A file attached while the copy uploads stops it too.
  await attach([file], 1);
  await composer(win).click();
  await win.keyboard.type('Second try');
  release = await holdUploads();
  await win.keyboard.press('Enter');
  await dialogBox(win).locator('.buttons button', { hasText: 'Take the key out' }).click();
  await expect(toast()).toHaveText('The key is out of the file. The message goes once the file has uploaded again, unless you change the message first.');
  const notes = path.join(dataDir, 'attach', 'notes.txt');
  fs.writeFileSync(notes, 'No key here.\n');
  await pickNext(app, [notes]);
  await pane().locator('.ch-main [data-ch-compose="attach"]').click();
  await expect(tray(win).locator('.ch-tray-item')).toHaveCount(2);
  await expect(toast()).toHaveText("You changed the message, so it won't go by itself. Press Send when it's ready.");
  await release();
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(2, { timeout: 20000 });
  await win.waitForTimeout(1500);
  expect(await texts(olga, ws)).not.toContain('Second try');
  await composer(win).click();
  await win.keyboard.press('Enter');
  await expect.poll(() => texts(olga, ws), { timeout: 15000 }).toContain('Second try');
  const second = (await serverMessages(server, olga, ws.id, ws.general)).find((e) => e.text === 'Second try');
  expect(second.attachments.map((f) => f.name).sort()).toEqual(['agent.json', 'notes.txt']);
});

// Holds main's Take the key out (chatRedactStaged) for the nth file it is asked for, until the answer's release() runs.
async function holdRedact(n) {
  await app.evaluate((_, n) => {
    const files = global.__semChat.files;
    const redact = files.heldRedact || files.redactKeys;
    files.heldRedact = redact;
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    global.__semRedactCalls = 0;
    global.__semRedactRelease = open;
    files.redactKeys = function (stage) {
      global.__semRedactCalls += 1;
      return global.__semRedactCalls === n ? gate.then(() => redact.call(this, stage)) : redact.call(this, stage);
    };
  }, n);
  return () => app.evaluate(() => global.__semRedactRelease());
}

// Main's staged files by name: [state, agentKey].
const stagedInMain = () => app.evaluate(() => Object.fromEntries([...global.__semChat.files.staged.values()].map((e) => [e.name, [e.state, e.agentKey === true]])));

// RUK-294 second review, P2: with two files to take the key out of, the first copy became ready while the second still
// showed its upload with the key, so the composer sent, asked about the key again and forgot that it was to go.
test('Take the key out of two files sends once both copies without the key are ready, and asks nothing again', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  await ready(bart);
  const one = keyFile(ws, 'agent.json');
  const two = keyFile(ws, 'second.json');
  await attach([one.file, two.file], 2);
  await composer(win).click();
  await win.keyboard.type('Two configs');
  const release = await holdRedact(2);
  await win.keyboard.press('Enter');
  await expect(dialogBox(win).locator('.dialog-body p').first()).toHaveText("The files “agent.json”, “second.json” hold an agent's key.");
  await dialogBox(win).locator('.buttons button', { hasText: 'Take the key out' }).click();
  // The copy of the first is up while main still has the second as it uploaded, with its key.
  await expect.poll(() => app.evaluate(() => global.__semRedactCalls), { timeout: 15000 }).toBe(2);
  await expect.poll(stagedInMain, { timeout: 20000 }).toEqual({ 'agent.json': ['ready', false], 'second.json': ['ready', true] });
  await win.waitForTimeout(1500);
  await expect(win.locator('.scrim')).toHaveCount(0);
  expect(await texts(olga, ws)).not.toContain('Two configs');
  await capture(testInfo, 'key-out-two-files');
  await release();
  // Both copies ready: the message goes by itself, with neither key.
  await expect.poll(() => texts(olga, ws), { timeout: 30000 }).toContain('Two configs');
  await expect(win.locator('.scrim')).toHaveCount(0);
  const sent = (await serverMessages(server, olga, ws.id, ws.general)).find((e) => e.text === 'Two configs');
  expect(sent.attachments.map((f) => f.name).sort()).toEqual(['agent.json', 'second.json']);
  for (const f of sent.attachments) {
    const got = await server.download(olga, ws.id, ws.general, f.id);
    expect(got.bytes.toString('utf8')).toBe(one.config.replace(KEY, MARK));
  }
});

// RUK-294 second review, P2: a file pasted while the copy without the key uploaded was still being read when the copy
// was ready, so the message went without it, and the file came into the tray after.
test('a file pasted while the copy without the key uploads stops the message going by itself, also while it is still being read', async ({}, testInfo) => {
  const { olga, bart, ws } = await twoPeople(server);
  await ready(bart);
  const { file } = keyFile(ws);
  await attach([file], 1);
  await composer(win).click();
  await win.keyboard.type('The config and the notes');
  const releaseUpload = await holdUploads();
  await win.keyboard.press('Enter');
  await dialogBox(win).locator('.buttons button', { hasText: 'Take the key out' }).click();
  await expect(toast()).toHaveText('The key is out of the file. The message goes once the file has uploaded again, unless you change the message first.');
  // Reading a pasted file waits until the test lets it go.
  await win.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    window.__semReadRelease = () => {
      Blob.prototype.arrayBuffer = read;
      open();
    };
    Blob.prototype.arrayBuffer = function () {
      return gate.then(() => read.call(this));
    };
  });
  await composer(win).evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['No key here.\n'], 'notes.txt', { type: 'text/plain' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(toast()).toHaveText("You changed the message, so it won't go by itself. Press Send when it's ready.");
  // The copy is up while the pasted file is still being read: nothing goes.
  await releaseUpload();
  await expect.poll(stagedInMain, { timeout: 20000 }).toEqual({ 'agent.json': ['ready', false] });
  await win.waitForTimeout(1500);
  expect(await texts(olga, ws)).not.toContain('The config and the notes');
  await win.evaluate(() => window.__semReadRelease());
  await expect(tray(win).locator('.ch-tray-item.is-ready')).toHaveCount(2, { timeout: 20000 });
  await win.waitForTimeout(1000);
  expect(await texts(olga, ws)).not.toContain('The config and the notes');
  // Send: both files go, the copy without the key among them, and nothing asks.
  await composer(win).click();
  await win.keyboard.press('Enter');
  await expect.poll(() => texts(olga, ws), { timeout: 15000 }).toContain('The config and the notes');
  await expect(win.locator('.scrim')).toHaveCount(0);
  const sent = (await serverMessages(server, olga, ws.id, ws.general)).find((e) => e.text === 'The config and the notes');
  expect(sent.attachments.map((f) => f.name).sort()).toEqual(['agent.json', 'notes.txt']);
});

// RUK-294 third review, P2: after Take the key out, an older file picker that ended empty let the message go while a
// newer one was still open (the browser's host opens a new chooser when an old one never said it closed), and a pick
// that ended with a file too large to attach left the message waiting for good.
test('after Take the key out the message waits while any file picker is open, and goes when the last one adds nothing', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  await ready(bart);
  const { file } = keyFile(ws);
  await attach([file], 1);
  // Each pick from here waits until the test answers it with the paths picked.
  await app.evaluate(() => {
    global.__semPicks = [];
    global.__semChat.files.host.pickFiles = () => new Promise((resolve) => global.__semPicks.push(resolve));
  });
  const picks = () => app.evaluate(() => global.__semPicks.length);
  const answerPick = (i, paths) => app.evaluate((_, [i, paths]) => void global.__semPicks[i](paths), [i, paths]);
  await composer(win).click();
  await win.keyboard.type('Waits for the pickers');
  const release = await holdUploads();
  await win.keyboard.press('Enter');
  await dialogBox(win).locator('.buttons button', { hasText: 'Take the key out' }).click();
  await expect(toast()).toHaveText('The key is out of the file. The message goes once the file has uploaded again, unless you change the message first.');
  const attachButton = pane().locator('.ch-main [data-ch-compose="attach"]');
  await attachButton.click();
  await attachButton.click();
  await expect.poll(picks).toBe(2);
  // The copy without the key is up while both pickers are open: nothing goes.
  await release();
  await expect.poll(stagedInMain, { timeout: 20000 }).toEqual({ 'agent.json': ['ready', false] });
  await win.waitForTimeout(1500);
  expect(await texts(olga, ws)).not.toContain('Waits for the pickers');
  // The older picker ends empty while the newer one is still open: still nothing.
  await answerPick(0, []);
  await win.waitForTimeout(1500);
  expect(await texts(olga, ws)).not.toContain('Waits for the pickers');
  // The newer one ends with a file over the server's 25 MiB: it stays out of the tray, the message is as it was
  // confirmed, and it goes.
  const big = path.join(dataDir, 'attach', 'big.bin');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 26 * 1024 * 1024);
  await answerPick(1, [big]);
  await expect.poll(() => texts(olga, ws), { timeout: 15000 }).toContain('Waits for the pickers');
  const sent = (await serverMessages(server, olga, ws.id, ws.general)).find((e) => e.text === 'Waits for the pickers');
  expect(sent.attachments.map((f) => f.name)).toEqual(['agent.json']);
  await expect(win.locator('.scrim')).toHaveCount(0);
});

// RUK-294 second review, P2: choosing the same agent to copy again while its first read was out took that read's answer:
// when it failed, Add agent came on with the form's fallback while the second read still loaded.
test("choosing the agent to copy again while its settings load waits for that choice's own read", async ({}, testInfo) => {
  test.setTimeout(240000);
  const { beta } = await clarkInBeta();
  await workspaceMenu(win, 'Agents');
  await dialogBox(win).locator('[data-add-agent]').click();
  const form = dialogBox(win);
  const make = form.locator('.buttons button').last();
  const copy = form.locator('[name="copy"]');
  // Each read of Beta's agents waits until the test answers it: ok, or a failure.
  await app.evaluate((_, betaId) => {
    const api = global.__semApi;
    const read = api.heldAgents || api.chatAgents;
    api.heldAgents = read;
    global.__semBetaReads = [];
    api.chatAgents = (...args) =>
      args[0] !== betaId
        ? read(...args)
        : new Promise((resolve, reject) => global.__semBetaReads.push({ ok: () => read(...args).then(resolve, reject), fail: () => reject(Object.assign(new Error('offline'), { code: 'offline' })) }));
  }, beta.id);
  const answer = (i, how) => app.evaluate((_, [i, how]) => void global.__semBetaReads[i][how](), [i, how]);
  const reads = () => app.evaluate(() => global.__semBetaReads.length);
  await form.locator('[name="name"]').fill('Helper');
  await copy.selectOption({ label: 'Clark, in Beta' });
  await expect.poll(reads).toBe(1);
  await copy.selectOption({ label: "Don't copy" });
  await expect(make).toBeEnabled();
  await copy.selectOption({ label: 'Clark, in Beta' });
  await expect.poll(reads).toBe(2);
  await expect(make).toBeDisabled();
  // The first read fails: the choice made since still waits for its own.
  await answer(0, 'fail');
  await win.waitForTimeout(800);
  await expect(make).toBeDisabled();
  await expect(form.locator('[data-copy-help]')).toHaveText('Reading the settings of Clark in Beta…');
  await capture(testInfo, 'copy-second-read');
  await answer(1, 'ok');
  await expect(form.locator('[name="answers"][value="sponsor"]')).toBeChecked();
  await expect(form.locator('[name="name"]')).toHaveValue('Clark');
  await expect(make).toBeEnabled();
});

// RUK-294 third review, P2: a read of the agent to copy from an older choice, answered after a newer one, replaced what
// Add an agent kept of that workspace, so choosing the agent again filled the form with the older settings.
test("an older read of the agent to copy, answered last, doesn't replace the newer settings Add an agent keeps", async () => {
  test.setTimeout(240000);
  const { beta } = await clarkInBeta();
  await workspaceMenu(win, 'Agents');
  await dialogBox(win).locator('[data-add-agent]').click();
  const form = dialogBox(win);
  const copy = form.locator('[name="copy"]');
  // Each read of Beta's agents waits until the test answers it: ok, or with settings older than Beta's now, in which
  // its agents answer everyone.
  await app.evaluate((_, betaId) => {
    const api = global.__semApi;
    const read = api.heldAgents || api.chatAgents;
    api.heldAgents = read;
    global.__semBetaReads = [];
    api.chatAgents = (...args) =>
      args[0] !== betaId
        ? read(...args)
        : new Promise((resolve, reject) =>
            global.__semBetaReads.push({
              ok: () => read(...args).then(resolve, reject),
              old: () => read(...args).then((res) => resolve({ ...res, agents: res.agents.map((a) => ({ ...a, answers: 'everyone' })) }), reject)
            })
          );
  }, beta.id);
  const answer = (i, how) => app.evaluate((_, [i, how]) => void global.__semBetaReads[i][how](), [i, how]);
  const reads = () => app.evaluate(() => global.__semBetaReads.length);
  await form.locator('[name="name"]').fill('Helper');
  await copy.selectOption({ label: 'Clark, in Beta' });
  await expect.poll(reads).toBe(1);
  await copy.selectOption({ label: "Don't copy" });
  await copy.selectOption({ label: 'Clark, in Beta' });
  await expect.poll(reads).toBe(2);
  await answer(1, 'ok');
  await expect(form.locator('[name="answers"][value="sponsor"]')).toBeChecked();
  // The first choice's read answers last, with the older settings: the form and what it keeps stay the newer.
  await answer(0, 'old');
  await win.waitForTimeout(800);
  await expect(form.locator('[name="answers"][value="sponsor"]')).toBeChecked();
  await copy.selectOption({ label: "Don't copy" });
  await form.locator('[name="answers"][value="everyone"]').check();
  await copy.selectOption({ label: 'Clark, in Beta' });
  await expect(form.locator('[name="answers"][value="sponsor"]')).toBeChecked();
  expect(await reads()).toBe(2);
});

// RUK-294 second review, P2: closing Add an agent while the copied agent was being made lost the agent of Settings that
// answers for the one it copies, and the key step picked the default instead.
test('closing Add an agent while the copied agent is made keeps the agent that answers for it in the key step', async ({}, testInfo) => {
  test.setTimeout(240000);
  const { echoId } = await clarkInBeta();
  // Another agent of Settings, the default now, so the key step picks it unless the copied agent's comes along.
  const { id: otherId } = await win.evaluate(() => window.mail.call('agentAddCustom', 'openai'));
  await win.evaluate(([agent, url]) => window.mail.call('agentUpdateConfig', { custom: { [agent]: { url, name: 'Other' } }, defaultAgent: agent }), [otherId, echo.url]);
  await workspaceMenu(win, 'Agents');
  await dialogBox(win).locator('[data-add-agent]').click();
  const form = dialogBox(win);
  const make = form.locator('.buttons button').last();
  await form.locator('[name="copy"]').selectOption({ label: 'Clark, in Beta' });
  await expect(form.locator('[name="name"]')).toHaveValue('Clark');
  await expect(make).toBeEnabled();
  // Making the agent waits on the server; Escape closes the dialog meanwhile. The key step still starts with Echo,
  // which answers for Clark in Beta.
  await app.evaluate(() => {
    const api = global.__semApi;
    const create = api.heldCreate || api.chatCreateAgent;
    api.heldCreate = create;
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    global.__semCreateRelease = open;
    api.chatCreateAgent = (...args) => gate.then(() => create(...args));
  });
  await make.click();
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim .dialog h2', { hasText: 'Add an agent' })).toHaveCount(0);
  await app.evaluate(() => global.__semCreateRelease());
  const step = dialogBox(win);
  await expect(step.locator('h2')).toHaveText('Connect Clark', { timeout: 15000 });
  await capture(testInfo, 'copy-closed-key-step');
  await expect(step.locator('[name="use"]')).toHaveValue(echoId);
  expect(echoId).not.toBe(otherId);
});

// RUK-294 review, P2: picking an agent to copy and making the agent at once made it with what the form held before the
// copied agent's settings came in.
test("Add an agent waits for a copied agent's settings before it makes the agent, and makes it with them", async ({}, testInfo) => {
  test.setTimeout(240000);
  const { olga, ws } = await clarkInBeta();
  await workspaceMenu(win, 'Agents');
  await dialogBox(win).locator('[data-add-agent]').click();
  const form = dialogBox(win);
  const make = form.locator('.buttons button').last();
  await form.locator('[name="name"]').fill('Helper');
  await form.locator('[name="answers"][value="everyone"]').check();
  await expect(make).toBeEnabled();
  const release = await holdAgentReads();
  await form.locator('[name="copy"]').selectOption({ label: 'Clark, in Beta' });
  await expect(form.locator('[data-copy-help]')).toHaveText('Reading the settings of Clark in Beta…');
  await expect(make).toBeDisabled();
  await capture(testInfo, 'copy-loading');
  // Enter in the name field makes nothing while they load.
  await form.locator('[name="name"]').press('Enter');
  await win.waitForTimeout(800);
  expect((await serverGet(server, olga, ws.id, '/agents')).agents).toEqual([]);
  await release();
  await expect(form.locator('[name="answers"][value="sponsor"]')).toBeChecked();
  await expect(form.locator('[name="name"]')).toHaveValue('Clark');
  await expect(make).toBeEnabled();
  await make.click();
  await expect(dialogBox(win).locator('h2')).toHaveText('Connect Clark', { timeout: 15000 });
  const agents = (await serverGet(server, olga, ws.id, '/agents')).agents;
  expect(agents.map((a) => [a.name, a.answers, a.agents])).toEqual([['Clark', 'sponsor', true]]);
});
