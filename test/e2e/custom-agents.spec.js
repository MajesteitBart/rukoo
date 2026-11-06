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
  await expect(settings().locator('[data-agent-default]')).toHaveText('Clark');
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
  await expect(settings().locator('[data-agent-default]')).toHaveText('Hermes');
  expect(await app.evaluate((_e, t) => global.__semAgents.identify(t), token)).toBe(null);
  expect((await app.evaluate(() => global.__semAgents.list())).some((c) => c.agent === id)).toBe(true);
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
