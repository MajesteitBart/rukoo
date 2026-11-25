const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

// Custom agents (Settings > Agents > Add an agent): Booper and other servers with the Runs API or OpenAI's Chat
// Completions. The scripted agents (SEM_AGENT_FAKE) stand in for the servers, so this checks Settings, the panel and
// main's handling, not a live server.

const SHOTS = path.join(__dirname, '..', '..', 'tmp', 'e2e-shots', 'custom-agents');
let app;
let win;
let dataDir;

async function launch({ theme = 'light', language = 'en' } = {}) {
  fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language, theme, calendar: { notifiedUpgrade: true } }));
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_AGENT_FAKE: '1', SEM_AGENT_FAKE_SCALE: '0.5' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  // The copy rows write to main's clipboard; record it instead of the desktop's own. The keys and token seeds go into a
  // reversible stand-in for the system keyring: this checks custom agents, not the keyring, which a Linux session
  // without an unlocked Secret Service doesn't have (test/agent-custom.test.js checks that they are stored encrypted).
  await app.evaluate(() => {
    global.__semAgents.deps.clipboard = { writeText: (text) => (global.__copied = text) };
    global.__semAgents.cfg.secrets = { encrypt: (s) => `test:${Buffer.from(s).toString('hex')}`, decrypt: (s) => Buffer.from(String(s).slice(5), 'hex').toString() };
  });
}

test.beforeEach(() => {
  dataDir = tempDir('rukoo-custom-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const settings = () => win.locator('.page.settings');
const card = () => settings().locator('[data-custom-card]').first();
const transcript = () => win.locator('.agentpane .ap-transcript');
const input = () => win.locator('.agentpane .bui-pb__ta');
// After the dialog's and the menu's animations, so a capture shows where they end.
async function shot(name) {
  await win.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  await win.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function openAgents() {
  await win.click('[data-action="settings"]');
  await settings().locator('[data-a="agents"]').click();
}

test('add Booper, set it up, chat with it, and remove it', async () => {
  await launch();
  await openAgents();
  await expect(settings().locator('[data-custom-card]')).toHaveCount(0);
  await settings().locator('.row', { hasText: 'Add an agent' }).click();
  const dialog = win.locator('.dialog');
  await expect(dialog.locator('.radio-row')).toHaveCount(3);
  await expect(dialog).toContainText('An agent on Booper, reached through its app channel.');
  await dialog.locator('.radio-row', { hasText: 'Booper' }).click();
  await expect(card()).toBeVisible();
  const id = await card().getAttribute('data-custom-card');
  expect(id).toMatch(/^cx_[a-z0-9]{10}$/);
  await expect(settings().locator('.agent-group', { hasText: 'Booper' })).toBeVisible();
  await expect(card().locator('.agent-status .title')).toHaveText('Ready', { timeout: 10000 });

  // Name, address and key, as the user types them.
  const name = card().locator(`[data-agent-field="${id}.name"]`);
  await name.fill('Clark');
  await name.press('Enter');
  await expect(settings().locator(`.agent-group [data-agent-name="${id}"]`)).toHaveText('Clark');
  await expect(settings().locator('.agent-group', { hasText: 'Clark' }).locator('.agent-product').last()).toHaveText('Booper');
  const url = card().locator(`[data-agent-field="${id}.url"]`);
  await url.fill('http://100.64.0.9:8662');
  await url.press('Enter');
  await card().locator(`[data-agent-key="${id}"]`).fill('dudan-token');
  await card().locator(`[data-a="agent-key-save:${id}"]`).click();
  await expect(card()).toContainText('Key saved');
  const stored = await win.evaluate(() => window.mail.call('agentConfig'));
  const entry = stored.custom.find((x) => x.id === id);
  expect([entry.name, entry.url, entry.hasKey, entry.preset, entry.protocol]).toEqual(['Clark', 'http://100.64.0.9:8662', true, 'booper', 'runs']);
  expect(JSON.stringify(stored)).not.toContain('dudan-token');
  await card().scrollIntoViewIfNeeded();
  await shot('01-booper-card');

  // Rukoo's tools for it: the setup for booper.yaml, with a token of its own.
  await card().locator('.row', { hasText: 'Copy Clark setup' }).click();
  await expect(win.locator('#toast')).toContainText('Copied. Add it to Clark on this computer');
  const copied = await app.evaluate(() => global.__copied);
  expect(copied).toContain('headersEnv: { Authorization: RUKOO_MCP_AUTHORIZATION }');
  expect(copied).toMatch(/RUKOO_MCP_AUTHORIZATION=Bearer [A-Za-z0-9_-]{40,}/);
  expect(copied).toContain('url: http://127.0.0.1:');
  expect(copied).not.toContain('dudan-token');
  const token = copied.match(/Bearer ([A-Za-z0-9_-]+)/)[1];
  expect(await app.evaluate((_e, t) => global.__semAgents.identify(t), token)).toEqual({ agent: id, conversationId: null, remote: false });

  // The default agent can be the custom one.
  await settings().locator('[data-a="agent-default"]').click();
  await win.locator('.dialog .radio-row', { hasText: 'Clark' }).click();
  await expect(settings().locator('[data-agent-default]')).toHaveText('Clark · Ready');
  await win.click('.page.settings [data-a="back"]');
  await win.click('.page.settings [data-a="back"]');

  // A chat with it, from the panel.
  await win.locator('.item', { hasText: 'Call on Thursday' }).first().click();
  await win.keyboard.press('Control+j');
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Clark');
  await win.click('.agentpane .bui-pb__modelbtn');
  const row = win.locator('.bui-menu .bui-menu__row').filter({ has: win.locator('.bui-menu__label', { hasText: /^Clark$/ }) });
  await expect(row).toContainText('Booper');
  await shot('02-agent-menu');
  await win.keyboard.press('Escape');
  await input().fill('Hello Booper');
  await input().press('Enter');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  const chats = await app.evaluate(() => global.__semAgents.list());
  expect(chats[0].agent).toBe(id);
  await shot('03-chat');

  // Remove it: the chat stays, and its token stops working.
  await openAgents();
  await card().locator('.row', { hasText: 'Remove Clark' }).click();
  await expect(win.locator('.dialog')).toContainText('Your chats with Clark stay');
  await shot('04-remove-confirm');
  await win.locator('.dialog button', { hasText: /^Remove$/ }).click();
  await expect(settings().locator('[data-custom-card]')).toHaveCount(0);
  await expect(settings().locator('[data-agent-default]')).toHaveText('Hermes · Ready');
  expect(await app.evaluate((_e, t) => global.__semAgents.identify(t), token)).toBe(null);
  expect((await app.evaluate(() => global.__semAgents.list())).some((c) => c.agent === id)).toBe(true);
});

test('a chat with an agent removed before Send reached main is refused, never moved to the default, and the draft stays', async () => {
  await launch();
  const id = await win.evaluate(() => window.mail.call('agentAddCustom', 'booper').then((r) => r.id));
  await win.locator('.item', { hasText: 'Call on Thursday' }).first().click();
  await win.keyboard.press('Control+j');
  await win.click('.agentpane .bui-pb__modelbtn');
  await win.locator('.bui-menu .bui-menu__row').filter({ has: win.locator('.bui-menu__label', { hasText: /^Booper$/ }) }).click();
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Booper');
  await input().fill('Hello Booper');
  // Removed in main before the panel heard of it: the config changes without telling the window.
  await app.evaluate((_e, x) => global.__semAgents.cfg.removeCustom(x), id);
  await input().press('Enter');
  await expect(win.locator('#toast')).toContainText("Booper is no longer in Settings, so your message wasn't sent. Pick another agent.");
  expect(await app.evaluate(() => global.__semAgents.list().length)).toBe(0);
  // The panel says the agent is gone, keeps the message, and offers the agents that are ready.
  await expect(win.locator('.agentpane .bui-rec__title')).toHaveText('Booper was removed');
  await expect(win.locator('.agentpane .bui-pb__disabled')).toContainText('Booper was removed in Settings.');
  await expect(win.locator('.agentpane .bui-pb__disabled .link-btn')).toHaveCount(0);
  await expect(win.locator('.agentpane .bui-rec__foot .bui-btn')).toHaveText(['Chat with Claude', 'Chat with Codex']);
  await win.locator('.agentpane .bui-rec__foot .bui-btn', { hasText: 'Chat with Claude' }).click();
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Claude');
  expect(await input().evaluate((el) => el.value)).toBe('Hello Booper');
  await input().press('Enter');
  await expect.poll(() => app.evaluate(() => global.__semAgents.list().map((c) => c.agent))).toEqual(['claude']);
});

const agentHead = () => win.locator('.agentpane .ap-agent');
const pickAgentRow = async (name) => {
  await win.click('.agentpane .bui-pb__modelbtn');
  await win.locator('.bui-menu .bui-menu__row').filter({ has: win.locator('.bui-menu__label', { hasText: new RegExp(`^${name}$`) }) }).click();
  await expect(agentHead()).toHaveText(name);
};
const userMessages = () => app.evaluate(() => global.__semAgents.list().map((c) => [c.agent, global.__semAgents.conversations.get(c.id).items.filter((i) => i.type === 'user').map((i) => i.text)]));

// Send takes its agent once: the chat is asked for Booper, and the error names Booper, also when the person has opened
// a Codex chat by the time main answers.
test('a refusal that comes after the person opened another chat names the agent Send went to', async () => {
  await launch();
  const id = await win.evaluate(() => window.mail.call('agentAddCustom', 'booper').then((r) => r.id));
  await win.locator('.item', { hasText: 'Call on Thursday' }).first().click();
  await win.keyboard.press('Control+j');
  // A saved Codex chat, to open from the list while Booper's chat is being made.
  await pickAgentRow('Codex');
  await input().fill('Hello Codex');
  await input().press('Enter');
  await expect.poll(() => app.evaluate(() => global.__semAgents.list().map((c) => c.agent))).toEqual(['codex']);
  await win.click('.agentpane [data-ap="new"]');
  await pickAgentRow('Booper');
  await input().fill('Hello Booper');
  // Main holds the new chat until the test lets it answer, and Booper is removed meanwhile without telling the window.
  await app.evaluate((_e, x) => {
    const hub = global.__semAgents;
    const create = hub.create.bind(hub);
    global.__asked = [];
    global.__create = new Promise((resolve) => (global.__answerCreate = resolve));
    hub.create = (req) => {
      global.__asked.push(req.agent);
      return global.__create.then(() => create(req));
    };
    hub.cfg.removeCustom(x);
  }, id);
  await input().press('Enter');
  await expect.poll(() => input().evaluate((el) => el.value)).toBe('');
  // The person opens the Codex chat before main answers.
  await win.click('.agentpane [data-ap="history"]');
  await win.locator('.bui-menu .bui-menu__row', { hasText: 'Codex' }).click();
  await expect(agentHead()).toHaveText('Codex');
  await expect(transcript().locator('.bui-ub')).toHaveText(['Hello Codex']);
  await app.evaluate(() => global.__answerCreate());
  await expect(win.locator('#toast')).toContainText("Booper is no longer in Settings, so your message wasn't sent. Pick another agent.");
  expect(await app.evaluate(() => global.__asked)).toEqual([id]);
  expect(await userMessages()).toEqual([['codex', ['Hello Codex']]]);
});

// Pasted into the chat input the way the system clipboard does: the file becomes an attachment of the message.
const pasteFile = (name, text) =>
  input().evaluate(
    (ta, { name, text }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: 'text/plain' }));
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { name, text }
  );
const attachedNames = () => win.locator('.agentpane .bui-pb__files .bui-entity--attached:not(.is-pending) .bui-entity__name');

// Send for a custom agent removed before the panel heard of it, and a second message started before main refused the
// first. The refused text used to stay out, because the input held the second message by then.
test('a refused message comes back above the one started since, with both files, and nothing is sent', async () => {
  await launch();
  const id = await win.evaluate(() => window.mail.call('agentAddCustom', 'booper').then((r) => r.id));
  await win.locator('.item', { hasText: 'Call on Thursday' }).first().click();
  await win.keyboard.press('Control+j');
  await pickAgentRow('Booper');
  await input().fill('Hello Booper');
  await pasteFile('first.txt', 'For Booper');
  await expect(attachedNames()).toHaveText(['first.txt']);
  // Main holds the new chat until the test lets it answer, and Booper is removed meanwhile without telling the window.
  await app.evaluate((_e, x) => {
    const hub = global.__semAgents;
    const create = hub.create.bind(hub);
    global.__asked = [];
    global.__create = new Promise((resolve) => (global.__answerCreate = resolve));
    hub.create = (req) => {
      global.__asked.push(req.agent);
      return global.__create.then(() => create(req));
    };
    hub.cfg.removeCustom(x);
  }, id);
  await input().press('Enter');
  await expect.poll(() => input().evaluate((el) => el.value)).toBe('');
  await expect(attachedNames()).toHaveCount(0);
  // The next message, started before main answers.
  await input().fill('A second message');
  await pasteFile('second.txt', 'Also for Booper');
  await expect(attachedNames()).toHaveText(['second.txt']);
  await app.evaluate(() => global.__answerCreate());
  await expect(win.locator('#toast')).toContainText("Booper is no longer in Settings, so your message wasn't sent. Pick another agent.");
  await expect.poll(() => input().evaluate((el) => el.value)).toBe('Hello Booper\n\nA second message');
  await expect(attachedNames()).toHaveText(['first.txt', 'second.txt']);
  expect(await app.evaluate(() => global.__asked)).toEqual([id]);
  expect(await app.evaluate(() => global.__semAgents.list().length)).toBe(0);
  // Another agent: all of it is in its input to edit, and goes there with the next Send.
  await pickAgentRow('Claude');
  await expect(input()).toBeEditable();
  expect(await input().evaluate((el) => el.value)).toBe('Hello Booper\n\nA second message');
  await expect(attachedNames()).toHaveText(['first.txt', 'second.txt']);
  await input().press('Enter');
  await expect.poll(() => app.evaluate(() => global.__semAgents.list().map((c) => c.agent))).toEqual(['claude']);
  const received = () =>
    app.evaluate(() => {
      const r = global.__semAgents.adapters.get('claude').received.at(-1);
      return r ? { both: String(r.text).includes('Hello Booper\n\nA second message'), files: r.files.map((f) => f.name) } : null;
    });
  await expect.poll(received).toEqual({ both: true, files: ['first.txt', 'second.txt'] });
});

// Text written in a chat whose custom agent is then removed is never out of reach: the input of that chat is off, and
// picking another agent brings the text into a new chat with that agent, where it can be sent.
test('a follow-up written in a chat whose agent is then removed comes along when the person picks another agent', async () => {
  await launch();
  const id = await win.evaluate(() => window.mail.call('agentAddCustom', 'booper').then((r) => r.id));
  await win.locator('.item', { hasText: 'Call on Thursday' }).first().click();
  await win.keyboard.press('Control+j');
  await pickAgentRow('Booper');
  await input().fill('Hello Booper');
  await input().press('Enter');
  await expect(transcript().locator('.bui-ub')).toHaveText(['Hello Booper']);
  await expect.poll(() => app.evaluate(() => global.__semAgents.list().map((c) => c.agent))).toEqual([id]);
  await input().fill('A follow-up for Booper');
  // Removed in Settings while the chat is open.
  await win.evaluate((x) => window.mail.call('agentRemoveCustom', x), id);
  await expect(win.locator('.agentpane .bui-pb__disabled')).toContainText('Booper was removed in Settings.');
  // Another agent from the menu: a new chat about the same email, with the follow-up in its input.
  await pickAgentRow('Claude');
  await expect(transcript().locator('.bui-ub')).toHaveCount(0);
  await expect(input()).toBeEditable();
  expect(await input().evaluate((el) => el.value)).toBe('A follow-up for Booper');
  await input().press('Enter');
  await expect.poll(async () => (await userMessages()).sort()).toEqual([['claude', ['A follow-up for Booper']], [id, ['Hello Booper']]]);
});

// The input of a chat whose agent was removed used to be hidden with the text in it: out of sight until another agent
// was picked, which needs a second agent set up.
test('a chat whose agent was removed keeps its unsent text readable and copyable, and cannot send it', async () => {
  await launch();
  const id = await win.evaluate(() => window.mail.call('agentAddCustom', 'booper').then((r) => r.id));
  await win.locator('.item', { hasText: 'Call on Thursday' }).first().click();
  await win.keyboard.press('Control+j');
  await pickAgentRow('Booper');
  await input().fill('Hello Booper');
  await input().press('Enter');
  await expect(transcript().locator('.bui-ub')).toHaveText(['Hello Booper']);
  await input().fill('A follow-up for Booper');
  await win.evaluate((x) => window.mail.call('agentRemoveCustom', x), id);
  await expect(win.locator('.agentpane .bui-pb__disabled')).toContainText('Booper was removed in Settings.');
  await expect(input()).toBeVisible();
  await expect(input()).toHaveText('A follow-up for Booper');
  await expect(input()).not.toBeEditable();
  // It can be selected, and a copy gives the text; a cut copies too and leaves the text where it is.
  await input().selectText();
  expect(await win.evaluate(() => document.getSelection().toString())).toBe('A follow-up for Booper');
  const clip = (type) =>
    input().evaluate((ta, type) => {
      const dt = new DataTransfer();
      ta.dispatchEvent(new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData('text/plain');
    }, type);
  expect(await clip('copy')).toBe('A follow-up for Booper');
  expect(await clip('cut')).toBe('A follow-up for Booper');
  await expect(input()).toHaveText('A follow-up for Booper');
  // Nothing sends it.
  await expect(win.locator('.agentpane .bui-pb__send')).toBeDisabled();
  await win.keyboard.press('Enter');
  expect(await userMessages()).toEqual([[id, ['Hello Booper']]]);
});

// The read-only input took no keyboard focus, so its text was only reachable with the mouse.
test("a removed agent's read-only text can be reached with Tab and copied with the keyboard, and undo leaves it", async () => {
  await launch();
  const id = await win.evaluate(() => window.mail.call('agentAddCustom', 'booper').then((r) => r.id));
  await win.locator('.item', { hasText: 'Call on Thursday' }).first().click();
  await win.keyboard.press('Control+j');
  await pickAgentRow('Booper');
  await input().fill('Hello Booper');
  await input().press('Enter');
  await expect(transcript().locator('.bui-ub')).toHaveText(['Hello Booper']);
  await input().fill('A follow-up for Booper');
  await win.evaluate((x) => window.mail.call('agentRemoveCustom', x), id);
  await expect(input()).not.toBeEditable();
  // The agent menu comes right after the input: Shift+Tab from it lands in the text.
  await win.locator('.agentpane .bui-pb__modelbtn').focus();
  await win.keyboard.press('Shift+Tab');
  await expect(input()).toBeFocused();
  await win.keyboard.press('Control+a');
  expect(await win.evaluate(() => document.getSelection().toString())).toBe('A follow-up for Booper');
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await win.keyboard.press('Control+c');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('A follow-up for Booper');
  // The editor's undo doesn't change text that can't be edited: typing it was a step it could take back.
  await win.keyboard.press('Control+z');
  await expect(input()).toHaveText('A follow-up for Booper');
  await win.keyboard.press('Control+z');
  await win.keyboard.press('Control+y');
  await expect(input()).toHaveText('A follow-up for Booper');
  await expect(input()).toBeFocused();
});

test('an OpenAI-compatible agent: its own toggles, and the setup most MCP clients take', async () => {
  await launch();
  await openAgents();
  await settings().locator('.row', { hasText: 'Add an agent' }).click();
  await win.locator('.dialog .radio-row', { hasText: 'OpenAI-compatible agent' }).click();
  await expect(card()).toBeVisible();
  const id = await card().getAttribute('data-custom-card');
  const history = card().locator('.row', { hasText: 'Send earlier messages' });
  await expect(history.locator('.switch')).toHaveClass(/on/);
  await history.click();
  await expect(history.locator('.switch')).not.toHaveClass(/on/);
  expect((await win.evaluate(() => window.mail.call('agentConfig'))).custom[0].history).toBe(false);

  const remote = card().locator('.row', { hasText: 'from another computer' });
  await expect(remote).toContainText('For an agent elsewhere in your tailnet.');
  await remote.click();
  await expect(remote.locator('.switch')).toHaveClass(/on/);
  expect(await app.evaluate(() => global.__semAgents.wantsRemote())).toBe(true);
  await remote.click();
  await expect(remote.locator('.switch')).not.toHaveClass(/on/);
  expect(await app.evaluate(() => global.__semAgents.wantsRemote())).toBe(false);

  await card().locator('.row', { hasText: /Copy .* setup/ }).click();
  const copied = await app.evaluate(() => global.__copied);
  const json = JSON.parse(copied.split('\n').filter((l) => !l.startsWith('//')).join('\n'));
  expect(json.rukoo.transport).toBe('streamable-http');
  expect(json.rukoo.headers.Authorization).toMatch(/^Bearer /);
  await card().scrollIntoViewIfNeeded();
  await shot('05-openai-card');
  expect(id).toMatch(/^cx_/);
});

// When Rukoo can't open its Tailscale listener, the remote row says why, in the interface's language (#253). The test
// machine gets an address nobody has (TEST-NET), so nothing listens on a real tailnet.
test("a custom agent's remote row says in Dutch why Rukoo isn't listening", async () => {
  await launch({ language: 'nl' });
  const { id } = await win.evaluate(() => window.mail.call('agentAddCustom', 'openai'));
  await app.evaluate(() => global.__semAgents.updateConfig({ mcp: { remoteHost: '192.0.2.1' } }));
  await openAgents();
  const remote = settings().locator(`[data-a="agent-custom-remote:${id}"]`);
  await remote.click();
  await expect(remote.locator('.switch')).toHaveClass(/on/);
  const address = remote.locator(`[data-custom-address="${id}"]`);
  // The address is there; Rukoo couldn't listen on it, and the note says why.
  await expect(address).toContainText('Rukoo luistert niet op 192.0.2.1');
  await expect(address).not.toContainText('Geen Tailscale-adres');
  await expect(address.locator('.agent-note')).toContainText('Rukoo kan niet luisteren op 192.0.2.1:');
  await expect(address).not.toContainText('Could not listen');
});

for (const [theme, language] of [
  ['light', 'en'],
  ['dark', 'en'],
  ['light', 'nl'],
  ['dark', 'nl']
]) {
  test(`the Booper card in ${theme} mode, ${language === 'nl' ? 'Dutch' : 'English'}`, async () => {
    await launch({ theme, language });
    await win.evaluate(() => window.mail.call('agentAddCustom', 'booper'));
    await win.click('[data-action="settings"]');
    await settings().locator('[data-a="agents"]').click();
    await expect(card()).toBeVisible();
    await expect(card().locator('.agent-status .title')).toHaveText(language === 'nl' ? 'Beschikbaar' : 'Ready', { timeout: 10000 });
    await card().scrollIntoViewIfNeeded();
    await shot(`10-booper-${theme}-${language}`);
    // A narrow window keeps the card's rows readable.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 900));
    await card().scrollIntoViewIfNeeded();
    await shot(`11-booper-narrow-${theme}-${language}`);
  });
}
