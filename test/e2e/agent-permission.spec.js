// The chat's permission level (Ask, Auto, Full permission): the default in Settings > Agents, a chat's own level from
// the shield button beside Send, and the approval cards Rukoo does or doesn't show for it. The real app with the demo
// account and the fake agents (SEM_AGENT_FAKE=1). Screenshots for review go to tmp/e2e-shots/agent-permission in the
// checkout, which Git ignores.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

const SHOTS = path.join(__dirname, '..', '..', 'tmp', 'e2e-shots', 'agent-permission');
let app;
let win;
let dataDir;

async function launch() {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_AGENT_FAKE: '1', SEM_AGENT_FAKE_SCALE: '0.5' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
}

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-permission-e2e-');
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const pane = () => win.locator('.agentpane');
const transcript = () => win.locator('.agentpane .ap-transcript');
const input = () => win.locator('.agentpane .bui-pb__ta');
const button = () => win.locator('.agentpane .bui-pb__opt[data-pick="permission"]');
const chip = (label) => win.locator('.agentpane .bui-sugg__chip', { hasText: label });
const menuRow = (label) => win.locator('.bui-menu .bui-menu__row').filter({ has: win.locator('.bui-menu__label', { hasText: new RegExp(`^${label}$`) }) });
const cards = () => transcript().locator('.bui-approval');
// The chat on screen, as main has it.
const conversation = () => app.evaluate(() => {
  const c = global.__semAgents.list()[0];
  return c ? { id: c.id, permission: global.__semAgents.conversations.get(c.id).permission } : null;
});

async function openChat(subject) {
  await win.locator('.item', { hasText: subject }).first().click();
  await expect(win.locator('.reader-subject')).toHaveText(subject);
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeVisible();
  await expect(input()).toBeFocused();
}

async function say(text) {
  await input().fill(text);
  await input().press('Enter');
}

async function setTheme(theme) {
  await win.evaluate((t) => window.mail.call('updateSettings', { theme: t }), theme);
  await expect(win.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light).*$/);
}

// Both themes; the panel alone unless whole is set.
async function shot(name, { whole = false } = {}) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    await win.waitForTimeout(600);
    if (whole) await win.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    else await pane().screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
  }
  await setTheme('dark');
}

// Claude Code's calls are bound to their chat, so its chats can have any level (hub.js permissionFor()).
async function useClaude() {
  await win.evaluate(() => window.mail.call('agentUpdateConfig', { defaultAgent: 'claude' }));
}

async function openAgentSettings() {
  await win.click('[data-action="settings"]');
  await win.locator('.page.settings .row', { hasText: 'Claude Code, Codex and OpenClaw' }).click();
  await expect(win.locator('.page.settings h1')).toHaveText('Agents');
}

test('Settings sets the default level, plainly, and a new chat in the panel follows it', async () => {
  await openAgentSettings();
  const row = win.locator('.page.settings [data-a="agent-permission"]');
  await expect(row.locator('.title')).toHaveText('Permission level');
  await expect(row.locator('.value')).toHaveText('Ask');
  await expect(row.locator('.desc')).toContainText('Commands and file changes of Claude Code and Codex follow their own Access below.');
  await expect(win.locator('.page.settings .row', { hasText: 'Let agents archive, move and mark mail without asking' })).toHaveCount(0);
  await row.click();
  const options = win.locator('.radio-row');
  await expect(options.locator('.rl')).toHaveText(['Ask', 'Auto', 'Full permission']);
  await expect(win.locator('.radio-row[aria-checked="true"] .rl')).toHaveText('Ask');
  // Full permission says plainly that it sends without asking.
  await expect(options.nth(2).locator('.rh')).toHaveText(
    'Nothing waits for your approval. Agents can send messages and calendar invitations, delete mail and change other systems without asking. Only for agents you trust completely.'
  );
  await expect(options.nth(1).locator('.rh')).toContainText('Deleting, moving mail to Spam, unsubscribing, invitations and actions in other systems still wait for you.');
  await shot('01-settings-dialog', { whole: true });
  await options.nth(1).click();
  await expect(row.locator('.value')).toHaveText('Auto');
  expect(await app.evaluate(() => global.__semAgents.cfg.data.permission)).toBe('auto');
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'agents.json'), 'utf8')).permission).toBe('auto');
  await shot('02-settings-row', { whole: true });
  await win.click('.page.settings [data-a="back"]');
  await win.click('.page.settings [data-a="back"]');
  await expect(win.locator('.page.settings')).toHaveCount(0);

  // The panel's button follows Settings for a chat without a level of its own.
  await openChat('Call on Thursday');
  await expect(button()).toHaveAttribute('aria-label', 'Permission level: Auto');
  await expect(button().locator('.bui-pb__opttext')).toHaveText('Auto');
  await expect(button().locator('[data-icon="shield-half"]')).toHaveCount(1);
  // And keeps following it while the panel is open.
  await app.evaluate(() => global.__semAgents.updateConfig({ permission: 'full' }));
  await expect(button().locator('.bui-pb__opttext')).toHaveText('Full');
  await expect(button()).toHaveAttribute('data-tone', 'warn');
});

test("a chat's own level: Ask shows the card, Full permission lets the proposal through, and the level survives a restart", async () => {
  await useClaude();
  await openChat('Call on Thursday');
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Claude');
  await expect(button()).toHaveAttribute('aria-label', 'Permission level: Ask');
  await expect(button().locator('[data-icon="shield"]')).toHaveCount(1);
  await chip('Plan follow-ups').click();
  await expect(cards()).toHaveCount(1);
  await expect(cards().first()).toContainText('Add 2 tasks to Todoist');
  await expect(transcript()).toContainText("I'll add them once you approve.");

  // The menu: the default from Settings, then the three levels, each with what it means.
  await button().click();
  await expect(win.locator('.bui-menu .bui-menu__heading')).toHaveText('Permission level');
  await expect(win.locator('.bui-menu .bui-menu__label')).toHaveText(['Default', 'Ask', 'Auto', 'Full permission']);
  await expect(menuRow('Default').locator('.bui-menu__tag')).toHaveText('Ask');
  await expect(menuRow('Default')).toHaveAttribute('aria-selected', 'true');
  await expect(menuRow('Full permission').locator('.bui-menu__sub')).toHaveText('Never asks, not even before sending');
  await shot('03-menu');
  await menuRow('Full permission').click();
  await expect(button().locator('.bui-pb__opttext')).toHaveText('Full');
  await expect(button()).toHaveAttribute('data-tone', 'warn');
  await expect.poll(async () => (await conversation()).permission).toBe('full');
  // Settings still says Ask: the level is this chat's own.
  expect(await app.evaluate(() => global.__semAgents.cfg.data.permission)).toBe('ask');

  // The same request again: no new card, a line that says it went through, and the agent carries on in its turn.
  await input().fill('/tasks');
  await expect(win.locator('.agentpane .bui-pb__cmdname').first()).toHaveText('/tasks');
  await input().press('Enter');
  await expect(transcript().locator('.bui-notice', { hasText: 'Allowed without asking: Add 2 tasks to Todoist' })).toBeVisible({ timeout: 10000 });
  await expect(transcript()).toContainText('Done. I added 2 tasks and linked them in the plan.', { timeout: 10000 });
  await expect(cards()).toHaveCount(1);
  await shot('04-full-no-card');

  // After a restart the chat still has its own level.
  const { id } = await conversation();
  await closeApp(app);
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  expect(await app.evaluate((_e, cid) => global.__semAgents.conversations.get(cid).permission, id)).toBe('full');
  await openChat('Call on Thursday');
  await expect(transcript()).toContainText('Allowed without asking: Add 2 tasks to Todoist');
  await expect(button().locator('.bui-pb__opttext')).toHaveText('Full');
  // Back to the default: the chat follows Settings again.
  await button().click();
  await menuRow('Default').click();
  await expect(button().locator('.bui-pb__opttext')).toHaveText('Ask');
  await expect.poll(async () => (await conversation()).permission).toBe(null);
});

test('Auto adds an event without guests to your own calendar without a card, and the panel speaks Dutch', async () => {
  await useClaude();
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await expect(win.locator('.list-title h1')).toHaveText('Postvak IN');
  await openChat('Call on Thursday');
  await expect(button()).toHaveAttribute('aria-label', 'Toestemmingsniveau: Vragen');
  await button().click();
  await expect(win.locator('.bui-menu .bui-menu__heading')).toHaveText('Toestemmingsniveau');
  await expect(win.locator('.bui-menu .bui-menu__label')).toHaveText(['Standaard', 'Vragen', 'Auto', 'Volledige toestemming']);
  await expect(menuRow('Auto').locator('.bui-menu__sub')).toHaveText('Vraagt bij verwijderen of wat anderen zien');
  await shot('05-menu-nl');
  await menuRow('Auto').click();
  await expect(button().locator('.bui-pb__opttext')).toHaveText('Auto');
  await say('Schedule a call with Sanne');
  await expect(transcript()).toContainText('"Call with Sanne" staat in je agenda', { timeout: 10000 });
  await expect(transcript()).toContainText('I added the call there.');
  await expect(cards()).toHaveCount(0);
  const made = await app.evaluate(async () => {
    const now = Date.now();
    const { events } = await global.__semCalendars.read({ start: now, end: now + 16 * 86400000, maxAgeMs: 0 });
    return events.filter((e) => e.title === 'Call with Sanne').map((e) => e.calendarId);
  });
  expect(made).toEqual(['personal']);
  await shot('06-auto-event-nl');
  // Auto still asks before deleting: the card comes.
  const cid = (await conversation()).id;
  const res = await app.evaluate(async (_e, cid) => {
    const hub = global.__semAgents;
    const id = hub.engine.listMessages({ view: 'inbox' })[0].id;
    const out = await hub.callTool({ agent: 'claude', conversationId: cid, remote: false }, 'mail_action', { conversation_id: cid, action: 'trash', message_ids: [id] }, {});
    return out.structuredContent;
  }, cid);
  expect(res.status).toBe('waiting_for_user');
  await expect(cards()).toHaveCount(1);
});

test('a Hermes chat offers no level looser than Settings, in English and Dutch', async () => {
  await openChat('Call on Thursday');
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Hermes');
  await button().click();
  await expect(win.locator('.bui-menu .bui-menu__label')).toHaveText(['Default', 'Ask', 'Auto', 'Full permission']);
  await expect(menuRow('Ask')).toBeEnabled();
  for (const level of ['Auto', 'Full permission']) {
    await expect(menuRow(level)).toBeDisabled();
    await expect(menuRow(level).locator('.bui-menu__sub')).toHaveText('For Hermes, only in Settings');
  }
  await shot('08-hermes-menu');
  await menuRow('Full permission').click({ force: true });
  await expect(win.locator('.bui-menu')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect.poll(async () => (await conversation()) && (await conversation()).permission).toBeFalsy();

  // Settings at Auto: Auto is the default, and only Full permission stays out of reach.
  await app.evaluate(() => global.__semAgents.updateConfig({ permission: 'auto' }));
  await expect(button().locator('.bui-pb__opttext')).toHaveText('Auto');
  await button().click();
  await expect(menuRow('Auto')).toBeEnabled();
  await expect(menuRow('Auto').locator('.bui-menu__sub')).toHaveText('Asks before deleting or what others see');
  await expect(menuRow('Full permission')).toBeDisabled();
  await win.keyboard.press('Escape');
  // A stricter level for the chat counts.
  await say('Hello');
  await expect.poll(async () => Boolean(await conversation())).toBe(true);
  await expect.poll(() => app.evaluate(() => global.__semAgents.turns.size), { timeout: 15000 }).toBe(0);
  await button().click();
  await menuRow('Ask').click();
  await expect(button().locator('.bui-pb__opttext')).toHaveText('Ask');
  await expect.poll(async () => (await conversation()).permission).toBe('ask');
  // A looser level saved for the chat before shows as the default it comes down to.
  const { id } = await conversation();
  await app.evaluate((_e, cid) => global.__semAgents.setChoice(cid, { permission: 'full' }), id);
  await expect.poll(async () => (await conversation()).permission).toBe('full');
  await expect(button().locator('.bui-pb__opttext')).toHaveText('Auto');
  await expect(button()).not.toHaveAttribute('data-tone', 'warn');

  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await expect(win.locator('.list-title h1')).toHaveText('Postvak IN');
  await button().click();
  await expect(menuRow('Volledige toestemming').locator('.bui-menu__sub')).toHaveText('Voor Hermes alleen in Instellingen');
  await shot('09-hermes-menu-nl');
});

test('in a narrow panel the button keeps its shield and drops its name', async () => {
  await openChat('Call on Thursday');
  await app.evaluate(() => global.__semAgents.updateConfig({ permission: 'full' }));
  await expect(button()).toHaveAttribute('data-tone', 'warn');
  await expect(button().locator('.bui-pb__opttext')).toBeVisible();
  // The divider makes the panel as narrow as it goes (320 px).
  await win.locator('.agent-divider').focus();
  for (let i = 0; i < 4; i++) await win.keyboard.press('ArrowRight');
  await expect.poll(() => pane().evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(320);
  expect(await win.locator('.agentpane .bui-pb__row').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(330);
  await expect(button().locator('.bui-pb__opttext')).toBeHidden();
  await expect(button().locator('[data-icon="shield-off"]')).toBeVisible();
  await expect(button()).toHaveAttribute('aria-label', 'Permission level: Full permission');
  await shot('07-narrow', { whole: true });
});
