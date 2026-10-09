// End-to-end tests for the chat panel: the real app with the demo account and the fake agents
// (SEM_AGENT_FAKE=1), in English. Screenshots for review go to %TEMP%\rukoo-agent-shots.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LONG_COMMAND, LONG_COMMAND_TAIL } = require('../../src/main/agents/fake');

const SHOTS = path.join(os.tmpdir(), 'rukoo-agent-shots');
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-agent-e2e-'));
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  // An editor with unsaved changes keeps its window open and asks first; skip that in tests.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app.close().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const item = (text) => win.locator('.item', { hasText: text }).first();
const pane = () => win.locator('.agentpane');
const transcript = () => win.locator('.agentpane .ap-transcript');
const input = () => win.locator('.agentpane .bui-pb__ta');
const chip = (label) => win.locator('.agentpane .bui-sugg__chip', { hasText: label });
// The overlay slides in; wait for it to settle before a screenshot.
const settled = () => pane().evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

async function openChat(subject) {
  await item(subject).click();
  await expect(win.locator('.reader-subject')).toHaveText(subject);
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeVisible();
  await expect(input()).toBeFocused();
}

async function say(text) {
  await input().fill(text);
  await input().press('Enter');
}

// The chat on screen, as main has it.
const conversationId = () => app.evaluate(() => global.__semAgents.list()[0].id);

// Calls one of Rukoo's tools the way an agent does (same handlers as the MCP server), for that chat.
const tool = (cid, name, args = {}) =>
  app.evaluate(
    async (_electron, { cid, name, args }) => {
      const hub = global.__semAgents;
      const agent = hub.conversations.get(cid).agent;
      const res = await hub.callTool({ agent, conversationId: cid, remote: false }, name, { conversation_id: cid, ...args }, {});
      return { error: res.isError ? res.content[0].text : null, data: res.structuredContent || null };
    },
    { cid, name, args }
  );

const composerTitle = () => win.locator('.composer .composer-title');
const editor = () => win.locator('.composer .editor');

// Both themes, the whole window and the panel alone.
async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await win.evaluate((t) => window.mail.call('updateSettings', { theme: t }), theme);
    await expect(win.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light).*$/);
    // The mail frame redraws for the theme a moment after the page itself.
    await win.waitForTimeout(900);
    await win.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    await pane().screenshot({ path: path.join(SHOTS, `${name}-${theme}-panel.png`) });
  }
  await win.evaluate(() => window.mail.call('updateSettings', { theme: 'dark' }));
}

test('the chat drafts a reply into the composer, marks it and can undo it', async () => {
  await openChat('Call on Thursday');
  // A personal email: the email actions, but no Unsubscribe and no inbox overview.
  await expect(win.locator('.agentpane .bui-rec__title')).toHaveText('What should Hermes do with this email?');
  await expect(chip('Draft a reply')).toBeVisible();
  await expect(chip('Brief me')).toBeVisible();
  await expect(chip('Unsubscribe')).toHaveCount(0);
  await expect(chip('What needs me today?')).toHaveCount(0);
  await expect(win.locator('.agentpane .bui-entity__name')).toHaveText('Call on Thursday');
  await shot('01-empty');

  await chip('Draft a reply').click();
  await expect(transcript().locator('.bui-ub')).toHaveText('Draft a reply');
  await expect(transcript().locator('[data-type="thinking"]')).toBeVisible();
  await expect(transcript().locator('.bui-tool').first()).toContainText('Looked at your screen');
  await expect(transcript()).toContainText('I checked your earlier mail with Sanne');
  await expect(transcript()).toContainText('Done. The draft is in the composer.', { timeout: 10000 });
  await expect(transcript().locator('.bui-draft')).toContainText('Wrote a reply');
  // The draft card says what write_draft did, so its chip goes once the call succeeds.
  await expect(transcript().locator('.bui-tool')).toHaveCount(2);
  await expect(transcript().locator('.bui-tool', { hasText: 'Wrote the draft' })).toHaveCount(0);

  // The reply is in the inline composer, marked, and the composer did not take the focus.
  const editor = win.locator('.composer .editor');
  await expect(editor).toContainText('Thursday at 10:00 works for me.');
  await expect(editor).not.toBeFocused();
  await expect(win.locator('.composer #subject')).toHaveValue('Re: Call on Thursday');
  await expect(win.locator('.composer .agent-mark')).toBeVisible();
  await expect(win.locator('.composer .agent-mark')).toContainText('Drafted by Hermes');
  await shot('02-reply');

  // Your own edit shows in the mark; Undo then asks first and restores the empty reply.
  await editor.click();
  await win.keyboard.press('End');
  await win.keyboard.type(' Thanks!');
  await expect(win.locator('.composer .agent-mark')).toContainText('Drafted by Hermes · edited');
  await win.click('.composer [data-c="agent-undo"]');
  await expect(win.locator('.scrim')).toContainText("Undo Hermes's draft?");
  // While that question is open the agent cannot write, so the answer applies to what it asked about.
  const cid = await conversationId();
  const busy = await tool(cid, 'write_draft', { body: 'A second version.' });
  expect(busy.error).toContain('busy');
  await win.click('.scrim .buttons button:text-is("Undo")');
  await expect(editor).not.toContainText('Thursday at 10:00 works for me.');
  await expect(editor).not.toContainText('A second version.');
  await expect(win.locator('.composer .agent-mark')).toBeHidden();
  await expect(transcript().locator('.bui-draft')).toContainText('Undone');
  // Main keeps it, so the card still says so after it is drawn again.
  await expect.poll(() => app.evaluate((_e, cid) => global.__semAgents.conversations.get(cid).items.find((i) => i.type === 'draft').undone, cid)).toBe(true);
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await expect(transcript().locator('.bui-draft')).toContainText('Ongedaan gemaakt');
});

test('a runtime approval waits for the user, then the agent carries on', async () => {
  await openChat('Call on Thursday');
  await say('Add the proposal task; ask for approval first');
  const card = transcript().locator('.bui-approval');
  // The title comes from the kind of tool, in the interface language; the field label from its key.
  await expect(card.locator('.bui-approval__title')).toHaveText('Hermes wants to run a command');
  await expect(card.locator('.bui-approval__k')).toHaveText(['Command']);
  await expect(card.locator('.bui-approval__v.is-code')).toHaveText('td add "Send proposal" --due friday');
  await expect(card).toContainText('Waiting for you');
  // The card says what will run, so no chip claims it already ran.
  await expect(transcript().locator('.bui-tool')).toHaveCount(0);
  await shot('03-approval');
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(card).toContainText('Approved');
  await expect(transcript()).toContainText('Added "Send proposal" to Todoist, due Friday.');
  await expect(transcript().locator('.bui-tool')).toHaveText(['Ran a command']);
});

test('an approval card shows the whole command, folded until Show all', async () => {
  await openChat('Call on Thursday');
  await say('Run the long command for me');
  const card = transcript().locator('.bui-approval');
  await expect(card.locator('.bui-approval__title')).toHaveText('Hermes wants to run a command');
  const value = card.locator('.bui-approval__v.is-code');
  // Nothing is cut: the full 900 characters are in the card, folded to a few lines.
  await expect(value.locator('.bui-approval__text')).toHaveText(LONG_COMMAND);
  expect(LONG_COMMAND.length).toBe(900);
  await expect(value).toHaveClass(/is-folded/);
  const height = () => value.locator('.bui-approval__text').evaluate((el) => el.getBoundingClientRect().height);
  const folded = await height();
  expect(folded).toBeLessThan(140);
  await shot('10-long-command');
  await value.getByRole('button', { name: 'Show all' }).click();
  await expect(value).not.toHaveClass(/is-folded/);
  expect(await height()).toBeGreaterThan(folded * 2);
  // The end of the command, where a hidden tail would sit, is readable now.
  const tail = await value.locator('.bui-approval__text').evaluate((el, tail) => {
    const range = document.createRange();
    const text = el.firstChild;
    const at = text.textContent.indexOf(tail);
    range.setStart(text, at);
    range.setEnd(text, at + tail.length);
    const r = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return r.height > 0 && r.bottom <= box.bottom + 1;
  }, LONG_COMMAND_TAIL);
  expect(tail).toBe(true);
  await expect(value.getByRole('button', { name: 'Show less' })).toBeVisible();
  // Deny stays an ordinary button; a command that was denied never ran, so no chip says it did.
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect(card).toContainText('Declined');
  await expect(transcript()).toContainText('OK, I did not run it.');
  await expect(transcript().locator('.bui-tool')).toHaveCount(0);
});

test('agent markdown shows as formatted text, not as raw markers', async () => {
  await openChat('Call on Thursday');
  await say('Show me the plan in markdown');
  const answer = transcript().locator('[data-type="assistant"]').last();
  await expect(answer.locator('li')).toHaveCount(3, { timeout: 10000 });
  await expect(answer).toContainText('The agenda is at', { timeout: 10000 });
  await expect(answer.locator('.bui-stream__caret')).toHaveCount(0, { timeout: 10000 });
  await expect(answer.locator('strong')).toHaveText('plan');
  await expect(answer.locator('em')).toHaveText('Thursday');
  await expect(answer.locator('code')).toHaveText('10:00');
  await expect(answer.locator('a', { hasText: 'the proposal' })).toHaveAttribute('href', 'https://example.com/proposal-v3');
  await expect(answer.locator('a', { hasText: 'https://example.com/agenda' })).toHaveAttribute('href', 'https://example.com/agenda');
  await expect(answer).not.toContainText('**');
  await expect(answer).not.toContainText('`');
  await shot('11-markdown');
});

test('tool chips say what runs now, merge repeats and name other servers plainly', async () => {
  await openChat('Call on Thursday');
  await say('Hello there');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  const cid = await conversationId();
  // Tool calls as an agent reports them; the panel only draws them.
  await app.evaluate((_e, cid) => {
    const hub = global.__semAgents;
    const c = hub.conversations.get(cid);
    const add = (name, status, detail) => hub.addItem(c, { type: 'tool', name, label: name, detail, status, startedAt: Date.now(), endedAt: status === 'running' ? null : Date.now(), rukoo: false });
    for (const skill of ['email-triage', 'sales', 'todoist', 'notes']) add('Skill', 'done', skill);
    add('mcp__strap__strap_search', 'done', 'sanne');
    global.__running = add('Bash', 'running', 'td list');
  }, cid);
  const chips = transcript().locator('.bui-tool');
  await expect(chips).toHaveText(['Read a skill×4', 'strap: search', 'Running a command...']);
  await chips.first().click();
  await expect(transcript().locator('.bui-tool__detail:not([hidden])')).toHaveText('email-triage sales todoist notes');
  await shot('12-tools');
  await app.evaluate((_e, cid) => {
    const hub = global.__semAgents;
    Object.assign(global.__running, { status: 'done', endedAt: Date.now() });
    hub.updateItem(hub.conversations.get(cid), global.__running);
  }, cid);
  await expect(chips).toHaveText(['Read a skill×4', 'strap: search', 'Ran a command']);
  // The open chip stayed open while its neighbour changed.
  await expect(transcript().locator('.bui-tool__detail:not([hidden])')).toHaveCount(1);
});

test('agent drafts only go into the composer they belong to', async () => {
  await openChat('Call on Thursday');
  await chip('Draft a reply').click();
  await expect(editor()).toContainText('Thursday at 10:00 works for me.', { timeout: 10000 });
  await expect(transcript()).toContainText('Done. The draft is in the composer.', { timeout: 10000 });
  const cid = await conversationId();
  const cards = transcript().locator('.bui-draft');
  const undo = (i) => cards.nth(i).getByRole('button', { name: 'Undo' });

  // A reply-all is not a reply: it gets its own composer, with Joris in Cc from the reply-all rules.
  // The agent's reply is kept as a draft, and its card's Undo goes off with its composer.
  let res = await tool(cid, 'write_draft', { mode: 'reply_all', body: 'Hi both, Thursday at 10:00 works.' });
  expect(res.error).toBeNull();
  await expect(composerTitle()).toHaveText('Reply all');
  await expect(win.locator('.composer [data-rfield="cc"] .recipient')).toHaveText(['Joris Bakker']);
  await expect(win.locator('[data-view="drafts"] .count')).toHaveText('4');
  await expect(cards).toHaveCount(2);
  await expect(undo(0)).toBeDisabled();
  await expect(undo(1)).toBeEnabled();

  // An empty Cc from the agent clears the field; the same composer takes the rewrite.
  res = await tool(cid, 'write_draft', { mode: 'reply_all', cc: [], body: 'Hi Sanne, Thursday at 10:00 works.' });
  expect(res.error).toBeNull();
  await expect(win.locator('.composer [data-rfield="cc"]')).toBeHidden();
  await expect(editor()).toContainText('Hi Sanne, Thursday');
  await expect(cards).toHaveCount(3);

  // Undo on the last card takes back both writes into this composer and marks both of their cards.
  await undo(2).click();
  await expect(cards.nth(1)).toContainText('Undone');
  await expect(cards.nth(2)).toContainText('Undone');
  await expect(cards.nth(0)).not.toContainText('Undone');
  await expect(win.locator('.composer [data-rfield="cc"] .recipient')).toHaveText(['Joris Bakker']);
  await expect(editor()).not.toContainText('Thursday at 10:00');

  // Show on the first card opens the reply it wrote, now a stored draft; a rewrite goes into that
  // draft instead of a second one.
  await cards.nth(0).getByRole('button', { name: 'Show' }).click();
  await expect(composerTitle()).toHaveText('Draft');
  await expect(editor()).toContainText('Thursday at 10:00 works for me.');
  await expect(win.locator('[data-view="drafts"] .count')).toHaveText('5');
  res = await tool(cid, 'write_draft', { body: 'Hi Sanne,\n\nSee you Thursday at 10:00.' });
  expect(res.error).toBeNull();
  await expect(composerTitle()).toHaveText('Draft');
  await expect(editor()).toContainText('See you Thursday at 10:00.');

  // A message you write yourself is never taken over: the agent is told to ask you instead.
  await win.click('[data-action="compose"]');
  await expect(composerTitle()).toHaveText('New message');
  await expect(win.locator('[data-view="drafts"] .count')).toHaveText('5');
  await win.locator('.composer [data-field="subject"]').fill('My own message');
  await editor().click();
  await win.keyboard.type('Words of my own.');
  for (const args of [{ mode: 'new', to: ['team@example.com'], subject: 'Team update', body: 'Hello team' }, { body: 'Hi Sanne' }]) {
    res = await tool(cid, 'write_draft', args);
    expect(res.error).toContain('writing another email');
  }
  await expect(win.locator('.composer [data-field="subject"]')).toHaveValue('My own message');
  await expect(editor()).toContainText('Words of my own.');

  // A chat that is not on screen says so with a toast, and leaves the composer alone too.
  const other = await app.evaluate(() => global.__semAgents.create({ agent: 'claude', message: null }).id);
  res = await tool(other, 'write_draft', { mode: 'new', body: 'From another chat' });
  expect(res.error).toContain('writing another email');
  await expect(win.locator('#toast')).toContainText("Claude has a draft for you. Finish or close the email you're writing first.");
  await expect(editor()).toContainText('Words of my own.');
});

test('follow-ups show as a plan, and approving the proposal starts the next turn', async () => {
  await openChat('Call on Thursday');
  await chip('Plan follow-ups').click();
  const rows = transcript().locator('.bui-task');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Confirm the call on Thursday at 10:00');
  await expect(rows.nth(1).locator('.bui-task__pill')).toHaveText('Proposed');
  const card = transcript().locator('.bui-approval');
  await expect(card).toContainText('Add 2 tasks to Todoist');
  // The agent's own button label stays; the standard one is translated by the panel.
  await expect(card.getByRole('button', { name: 'Add tasks' })).toBeVisible();
  await expect(transcript()).toContainText("I'll add them once you approve.");
  await shot('04-plan');
  await card.getByRole('button', { name: 'Add tasks' }).click();
  await expect(transcript().locator('.bui-sys--approved')).toContainText('Add 2 tasks to Todoist');
  await expect(transcript()).toContainText('Done. I added 2 tasks and linked them in the plan.', { timeout: 10000 });
  await expect(rows.nth(1).locator('.bui-task__pill')).toHaveText('Done');
});

test('an Obsidian note in the sources opens, through the route only agent cards use', async () => {
  // Stands in for the shell, so the test sees what would open without starting Obsidian.
  await app.evaluate(({ shell }) => {
    global.__opened = [];
    shell.openExternal = async (url) => {
      global.__opened.push(url);
    };
  });
  await openChat('Call on Thursday');
  await chip('Brief me').click();
  const card = transcript().locator('.bui-ctx__card', { hasText: 'Call notes' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.locator('.bui-ctx__bar').click();
  await expect.poll(() => app.evaluate(() => global.__opened)).toEqual(['obsidian://open?vault=Personal&file=Call%20notes']);
  // The mail frames' route still refuses it, so a link in an email cannot start an Obsidian action.
  await win.evaluate(() => window.mail.call('openExternal', 'obsidian://new?content=x'));
  expect(await app.evaluate(() => global.__opened)).toHaveLength(1);
});

test('newsletters offer Unsubscribe, and without an email the inbox overview is offered', async () => {
  await openChat('Traffic fines in 2027: what you will pay');
  await expect(chip('Unsubscribe')).toBeVisible();
  // Once a chat about the newsletter exists, /unsubscribe is still there.
  await chip('Summarize').click();
  await expect(transcript()).toContainText('It needs a short reply from you, today.', { timeout: 10000 });
  await input().fill('/unsub');
  await expect(win.locator('.agentpane .bui-pb__cmd')).toHaveCount(1);
  // Main keeps that on the chat's email too, so it holds once the newsletter is off screen.
  expect(await app.evaluate(() => global.__semAgents.list()[0].message.unsubscribe)).toBe(true);
  await input().fill('');
  await win.click('.agentpane [data-ap="new"]');
  await expect(chip('Unsubscribe')).toBeVisible();
  // The x on the email chip starts the next chat without the email.
  await win.click('.agentpane .bui-entity__x');
  await expect(win.locator('.agentpane .bui-rec__title')).toHaveText('Ask Hermes about your mail');
  await expect(chip('What needs me today?')).toBeVisible();
  await expect(chip('Unsubscribe')).toHaveCount(0);
  // Slash commands map to the same actions.
  await input().fill('/tri');
  await expect(win.locator('.agentpane .bui-pb__cmd')).toHaveCount(1);
  await input().press('Enter');
  await expect(transcript().locator('.bui-ub')).toHaveText('What needs me today?');
  await expect(win.locator('.agentpane .ap-title')).toHaveText('What needs me today?');
  await expect(transcript().locator('.bui-ctx__card').first()).toBeVisible({ timeout: 10000 });
  await expect(transcript()).toContainText('Most urgent first');
  await shot('05-triage');
});

test('an email left out of a new chat comes back with one click, and goes with the first message', async () => {
  await openChat('Call on Thursday');
  const files = win.locator('.agentpane .bui-pb__files');
  const email = files.locator('.bui-entity__name');
  const remove = files.getByRole('button', { name: 'Leave this email out' });
  const add = files.getByRole('button', { name: 'Add this email' });
  const title = win.locator('.agentpane .bui-rec__title');
  await expect(email).toHaveText('Call on Thursday');

  // Left out: the chat is about your mail in general, and a dashed chip in its place offers the email back.
  await remove.click();
  await expect(title).toHaveText('Ask Hermes about your mail');
  await expect(win.locator('.agentpane .bui-rec__body')).toHaveText('Add the email to work on it, or start with what needs you today.');
  await expect(input()).toHaveAttribute('placeholder', 'Ask Hermes...');
  await expect(add).toHaveAttribute('title', 'Call on Thursday');
  await expect(remove).toHaveCount(0);
  await shot('14-email-left-out');
  await add.click();
  await expect(add).toHaveCount(0);
  await expect(email).toHaveText('Call on Thursday');
  await expect(title).toHaveText('What should Hermes do with this email?');
  await expect(input()).toBeFocused();

  // By keyboard: the add chip sits just before the input.
  await remove.click();
  await expect(input()).toBeFocused();
  await win.keyboard.press('Shift+Tab');
  await expect(add).toBeFocused();
  await win.keyboard.press('Enter');
  await expect(remove).toBeVisible();
  await expect(input()).toBeFocused();

  // Leaving it out lasts while the email is on screen: after another email it is back.
  await remove.click();
  await item('Sign in to Bencompare').click();
  await expect(email).toHaveText('Sign in to Bencompare');
  await item('Call on Thursday').click();
  await expect(email).toHaveText('Call on Thursday');
  await expect(remove).toBeVisible();

  // Put back before the first message, the email goes to the agent with it.
  await remove.click();
  await add.click();
  await app.evaluate(() => {
    const adapter = global.__semAgents.adapters.get('clark');
    const real = adapter.runTurn.bind(adapter);
    global.__inputs = [];
    adapter.runTurn = (turn) => {
      global.__inputs.push(turn.input);
      return real(turn);
    };
  });
  await say('Hello there');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  expect(await app.evaluate(() => global.__semAgents.list()[0].message.subject)).toBe('Call on Thursday');
  const [first] = await app.evaluate(() => global.__inputs);
  expect(first).toMatch(/<unsafe_content[^>]* source="email"/);
  expect(first).toContain('Subject: Call on Thursday');

  // The chat has the email now, so its chip has no x; New chat starts one that can leave it out.
  await expect(email).toHaveText('Call on Thursday');
  await expect(files.getByRole('button')).toHaveCount(0);
  await shot('15-email-in-chat');
  await win.click('.agentpane [data-ap="new"]');
  await expect(remove).toBeVisible();
});

test('/name starts a skill from the user skills folder; the agent gets its instructions outside the email, and /reply stays the quick action', async () => {
  await openChat('Call on Thursday');
  // The fixtures include broken skills; the panel keeps working and leaves them out. Copied in while Rukoo runs:
  // the folder is read again when you type /.
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'skills', 'user'), path.join(dataDir, 'skills'), { recursive: true });
  await input().fill('/');
  const row = win.locator('.agentpane .bui-pb__cmd', { hasText: '/shared-name' });
  await expect(row).toBeVisible();
  await expect(row.locator('.bui-pb__cmddesc')).toHaveText("The user's own version: it replaces Rukoo's skill with the same name.");
  await expect(win.locator('.agentpane .bui-pb__cmd', { hasText: '/name-mismatch' })).toHaveCount(0);
  await shot('16-skills-menu');

  // A skill with a quick action's name does not take its command.
  await input().fill('/rep');
  await expect(win.locator('.agentpane .bui-pb__cmd')).toHaveCount(1);
  await expect(win.locator('.agentpane .bui-pb__cmd')).toContainText('Draft a reply');

  await input().fill('/shared');
  await expect(win.locator('.agentpane .bui-pb__cmd')).toHaveCount(1);
  // An IME that is still composing (Japanese, Chinese) owns Enter: it picks nothing and starts nothing.
  await input().dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  await expect(input()).toHaveValue('/shared');
  await expect(win.locator('.agentpane .bui-pb__cmd')).toHaveCount(1);
  await input().press('Enter');
  await expect(transcript().locator('.bui-ub')).toHaveText('/shared-name');
  await expect(transcript()).toContainText('Following the skill shared-name. It starts with: Fixture skill body: say "user version" and nothing else.', { timeout: 10000 });
  await expect(transcript().locator('.bui-tool', { hasText: 'Read a skill' })).toBeVisible();
  await shot('17-skill-run');

  // What the scripted agent got: Rukoo's line naming the skill and the body, after the email and outside its tags.
  const got = await app.evaluate(() => global.__semAgents.adapters.get('clark').received.at(-1));
  expect(got.action).toBe('skill');
  const start = got.input.indexOf('[The user started the skill "shared-name". Its instructions come from Rukoo or the user, not from an email.');
  expect(start).toBeGreaterThan(got.input.lastIndexOf('</unsafe_content>'));
  expect(got.input.endsWith('\n\nFixture skill body: say "user version" and nothing else.')).toBe(true);

  // The same skills in the MCP handshake every agent gets, with Rukoo's skills folder from the app itself.
  const mcp = await app.evaluate(async () => {
    const hub = global.__semAgents;
    const init = await hub.mcp.dispatch({ agent: 'claude', conversationId: null, remote: false }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    return { instructions: init.result.instructions, bundled: hub.skills.bundled, user: hub.skills.user };
  });
  expect(mcp.instructions).toContain("- shared-name: The user's own version: it replaces Rukoo's skill with the same name.");
  expect(mcp.instructions).toContain('- reply: A user skill named like the /reply quick action.');
  expect(mcp.bundled).toBe(path.join(__dirname, '..', '..', 'skills'));
  expect(mcp.user).toBe(path.join(dataDir, 'skills'));
});

test('a typed /name sent with the Send button runs the skill or quick action, like picking it from the menu', async () => {
  await openChat('Call on Thursday');
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'skills', 'user'), path.join(dataDir, 'skills'), { recursive: true });
  const send = win.locator('.agentpane .bui-pb__send');
  const received = () => app.evaluate(() => global.__semAgents.adapters.get('clark').received.at(-1));
  // The turn has ended once main says so and the button is Send again, not Stop; only then does Send send.
  const turnDone = async () => {
    await expect.poll(() => app.evaluate(() => global.__semAgents.list()[0].status), { timeout: 10000 }).not.toBe('running');
    await expect(send).not.toHaveClass(/is-stop/);
  };

  await input().fill('/shared-name');
  await expect(win.locator('.agentpane .bui-pb__cmd', { hasText: '/shared-name' })).toBeVisible();
  await send.click();
  await expect(transcript().locator('.bui-ub').last()).toHaveText('/shared-name');
  await expect(transcript()).toContainText('Following the skill shared-name. It starts with: Fixture skill body: say "user version" and nothing else.', { timeout: 10000 });
  await turnDone();
  let got = await received();
  expect(got.action).toBe('skill');
  expect(got.input.endsWith('\n\nFixture skill body: say "user version" and nothing else.')).toBe(true);
  await expect(input()).toHaveValue('');

  // A quick action typed out and sent the same way.
  await input().fill('/summary');
  await send.click();
  await expect(transcript().locator('.bui-ub').last()).toHaveText('Summarize');
  await expect(transcript()).toContainText('It needs a short reply from you, today.', { timeout: 10000 });
  await turnDone();
  expect((await received()).action).toBe('summary');

  // A slash word that isn't one of the commands is ordinary chat text.
  await input().fill('/not-a-command');
  await send.click();
  await expect(transcript().locator('.bui-ub').last()).toHaveText('/not-a-command');
  await expect(transcript()).toContainText('You asked: "/not-a-command".', { timeout: 10000 });
  await turnDone();
  got = await received();
  expect(got.action).toBe(null);
  expect(got.text).toBe('/not-a-command');
});

test('a newer email in a thread offers the earlier chat, and continuing gives the agent the newer email', async () => {
  // Hermes talks about the dinner invitation the user sent; Joris's answer is in the inbox.
  await win.click('[data-view="sent"]');
  await openChat('Dinner on Saturday');
  await say('Did Joris answer?');
  await expect(transcript()).toContainText('You asked: "Did Joris answer?"', { timeout: 10000 });
  await win.click('[data-view="inbox"]');
  await item('Re: Dinner on Saturday').click();
  await expect(win.locator('.reader-subject')).toHaveText('Re: Dinner on Saturday');

  // No chat of its own: the empty state as always, with the earlier chat offered under the actions.
  const offer = win.locator('.agentpane .bui-offer');
  const files = win.locator('.agentpane .bui-pb__files');
  await expect(win.locator('.agentpane .bui-rec__title')).toHaveText('What should Hermes do with this email?');
  await expect(offer.locator('.bui-offer__label')).toHaveText('Continue the chat about the earlier message');
  await expect(offer.locator('.bui-offer__sub')).toHaveText(/^Hermes · \d{2}:\d{2}$/);
  await expect(offer).toHaveAttribute('title', 'Dinner on Saturday');
  await expect(files.locator('.bui-entity__name')).toHaveText('Re: Dinner on Saturday');
  await settled();
  await shot('16-continue-offer');

  // An email without a related chat has no offer.
  await item('Your parcel is on its way').click();
  await expect(files.locator('.bui-entity__name')).toHaveText('Your parcel is on its way');
  await expect(offer).toHaveCount(0);
  await item('Re: Dinner on Saturday').click();
  await expect(offer).toBeVisible();

  // Another agent picked for a new chat: the offer still names the chat's own agent, and continuing goes to it.
  await win.click('.agentpane .bui-pb__modelbtn');
  await win.locator('.bui-menu .bui-menu__row', { hasText: 'Claude' }).click();
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Claude');
  await expect(offer.locator('.bui-offer__sub')).toContainText('Hermes');
  await app.evaluate(() => {
    const adapter = global.__semAgents.adapters.get('clark');
    const real = adapter.runTurn.bind(adapter);
    global.__inputs = [];
    adapter.runTurn = (turn) => {
      global.__inputs.push(turn.input);
      return real(turn);
    };
  });
  // By keyboard: the offer is a button.
  await offer.focus();
  await win.keyboard.press('Enter');
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Hermes');
  await expect(transcript()).toContainText('You asked: "Did Joris answer?"');
  await expect(input()).toBeFocused();
  // The chat is still about the invitation; the answer on screen shows next to it.
  await expect(files.locator('.bui-entity__name')).toHaveText(['Dinner on Saturday', 'Re: Dinner on Saturday']);
  await expect(files.locator('.bui-entity__sub')).toHaveText(['Demo User', 'Newer message']);
  await expect(files.locator('.bui-entity__sub').last()).toHaveAttribute('title', 'You continued this chat from this newer message. It goes to Hermes with your next message.');
  await expect(files.getByRole('button')).toHaveCount(0);
  await settled();
  await shot('17-continued');

  await say('What did he say?');
  await expect(transcript()).toContainText('You asked: "What did he say?"', { timeout: 10000 });
  const [next] = await app.evaluate(() => global.__inputs);
  expect(next).toContain('[The user now looks at a newer email in the same thread and continues this chat from it.');
  expect(next).toMatch(/<unsafe_content source="email" id="[^"]*:INBOX:\d+" message_id="<demo-\d+@example\.com>"/);
  expect(next).toContain('Great, I will book a table for 19:30.');
  expect(next).not.toContain('Could you book a table?');
  await expect(files.locator('.bui-entity__sub').last()).toHaveAttribute('title', 'You continued this chat from this newer message. Hermes has it.');

  // Back on the answer later, the chat shows at once.
  await item('Your parcel is on its way').click();
  await expect(offer).toHaveCount(0);
  await expect(transcript()).not.toContainText('What did he say?');
  await item('Re: Dinner on Saturday').click();
  await expect(transcript()).toContainText('You asked: "What did he say?"');
  await expect(offer).toHaveCount(0);
  expect(await app.evaluate(() => global.__semAgents.list().length)).toBe(1);
});

test('typing instead of continuing starts a new chat about the email on screen', async () => {
  await openChat('Call on Thursday');
  await say('Summarize this');
  await expect(transcript()).toContainText('You asked: "Summarize this"', { timeout: 10000 });
  await win.click('[data-view="sent"]');
  await item('Re: Call on Thursday').click();
  await expect(win.locator('.agentpane .bui-offer')).toBeVisible();
  await say('Hello');
  await expect(transcript()).toContainText('You asked: "Hello"', { timeout: 10000 });
  await expect(transcript()).not.toContainText('Summarize this');
  const chats = await app.evaluate(() => global.__semAgents.list().map((c) => ({ subject: c.message.subject, continued: global.__semAgents.conversations.get(c.id).continued.length })));
  expect(chats).toEqual([
    { subject: 'Re: Call on Thursday', continued: 0 },
    { subject: 'Call on Thursday', continued: 0 }
  ]);
});

test('the panel docks in wide windows, slides over the reader in narrower ones and fills narrow ones', async () => {
  await openChat('Call on Thursday');
  // The title bar holds the only sparkle button; the reading pane toolbar has none.
  const toggle = win.locator('.titlebar [data-agent-toggle]');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveClass(/\bon\b/);
  await expect(win.locator('.reader-bar [data-reader="agent"]')).toHaveCount(0);
  await expect(win.locator('.agent-divider')).toBeVisible();
  const style = () => pane().evaluate((el) => ({ position: getComputedStyle(el).position, width: el.getBoundingClientRect().width }));
  expect(await style()).toEqual({ position: 'static', width: 380 });
  // The title bar button closes and opens the panel, like Ctrl+J.
  await toggle.click();
  await expect(pane()).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).not.toHaveClass(/\bon\b/);
  await toggle.click();
  await expect(pane()).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
  await expect.poll(async () => (await style()).position).toBe('absolute');
  await expect(win.locator('.agent-divider')).toBeHidden();
  fs.mkdirSync(SHOTS, { recursive: true });
  await settled();
  expect(await pane().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await win.screenshot({ path: path.join(SHOTS, '07-overlay.png') });
  // Where it covers the mail, Escape closes it.
  await input().focus();
  await win.keyboard.press('Escape');
  await expect(pane()).toBeHidden();
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeVisible();

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 700));
  // The panel covers the whole workspace.
  await expect
    .poll(() => win.evaluate(() => Math.abs(Math.round(document.querySelector('.agentpane').getBoundingClientRect().width - document.querySelector('.workspace').clientWidth))))
    .toBe(0);
  expect(await win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(860);
  await settled();
  await win.screenshot({ path: path.join(SHOTS, '08-narrow.png') });
  await win.click('.agentpane [data-ap="close"]');
  await expect(pane()).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('keys inside the panel do not reach the mailbox shortcuts', async () => {
  await openChat('Call on Thursday');
  await win.focus('.agentpane [data-ap="new"]');
  await win.keyboard.press('Delete');
  await win.keyboard.press('j');
  await win.keyboard.press('Control+a');
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await expect(item('Call on Thursday')).toBeVisible();
  await expect(win.locator('.list-tools.selecting')).toHaveCount(0);
  await expect(win.locator('#toast')).not.toContainText('Trash');
  // The agent picker lives on the body, outside the panel; its keys must not reach the mailbox either.
  const count = await win.locator('.item').count();
  await win.click('.agentpane .bui-pb__modelbtn');
  await expect(win.locator('.bui-menu')).toBeVisible();
  for (const key of ['ArrowDown', 'Delete', 'Control+a', 'j']) await win.keyboard.press(key);
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await expect(win.locator('.item')).toHaveCount(count);
  await expect(win.locator('.list-tools.selecting')).toHaveCount(0);
  await expect(win.locator('#toast')).not.toContainText('Trash');
  await win.keyboard.press('Escape');
  await expect(win.locator('.bui-menu')).toHaveCount(0);
  // Ctrl+J from an empty chat input closes the panel again.
  await input().focus();
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeHidden();
});

test('a new default agent applies at once, and Ctrl+J still closes a panel whose agent is off', async () => {
  await openChat('Call on Thursday');
  await win.evaluate(() => window.mail.call('agentUpdateConfig', { defaultAgent: 'claude' }));
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Claude');
  await expect(input()).toHaveAttribute('placeholder', 'Ask Claude about this email...');
  await win.evaluate(() => window.mail.call('agentUpdateConfig', { claude: { enabled: false } }));
  await expect(win.locator('.agentpane .bui-pb__disabled')).toContainText('Claude is turned off.');
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeHidden();
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeVisible();
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeHidden();
});

test('a wide chat panel gives way, so the reader keeps its 420 px', async () => {
  await openChat('Call on Thursday');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1300, 900));
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1240);
  await win.focus('.agent-divider');
  for (let i = 0; i < 12; i++) await win.keyboard.press('ArrowLeft');
  const size = () =>
    win.evaluate(() => ({
      reader: Math.round(document.querySelector('.reader').getBoundingClientRect().width),
      agent: Math.round(document.querySelector('.agentpane').getBoundingClientRect().width)
    }));
  expect((await size()).reader).toBeGreaterThanOrEqual(419);
  expect((await size()).agent).toBeLessThan(560);
  // With room to spare the panel takes the width you gave it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1900, 950));
  await expect.poll(async () => (await size()).agent).toBeGreaterThan(450);
  expect((await size()).reader).toBeGreaterThanOrEqual(419);
});

test('errors read as a sentence with the technical cause underneath', async () => {
  await openChat('Call on Thursday');
  await say('Show me an error');
  const notice = transcript().locator('[data-type="notice"]');
  await expect(notice).toContainText("Can't reach Hermes.");
  await expect(notice.locator('.ap-detail')).toHaveText('connect ECONNREFUSED 100.91.52.84:8642');
});

test('conversations come back after a reload', async () => {
  await openChat('Call on Thursday');
  await chip('Summarize').click();
  await expect(transcript()).toContainText('It needs a short reply from you, today.', { timeout: 10000 });
  await win.reload();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await item('Call on Thursday').click();
  // The panel stays open across a restart and finds the chat for this email again.
  await expect(pane()).toBeVisible();
  await expect(transcript()).toContainText('It needs a short reply from you, today.');
  await expect(transcript().locator('.bui-ub')).toHaveText('Summarize');
  await win.click('.agentpane [data-ap="history"]');
  await expect(win.locator('.bui-menu .bui-menu__row')).toContainText(['Call on Thursday']);
});

test('after a restart, an agent that lost its session says so and gets the email and a recap', async () => {
  await openChat('Call on Thursday');
  await chip('Summarize').click();
  await expect(transcript()).toContainText('It needs a short reply from you, today.', { timeout: 10000 });
  // Rukoo quits and starts again with the same data folder; the chat comes back from conversations.json.
  await app.close();
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await item('Call on Thursday').click();
  if (!(await pane().isVisible())) await win.keyboard.press('Control+j');
  await expect(transcript()).toContainText('It needs a short reply from you, today.');
  // The fake agent's "lost session" finds its session gone, like Claude Code after it deleted an old transcript.
  await say('Did you keep a lost session?');
  await expect(transcript().locator('.bui-notice__text', { hasText: 'started a new session' })).toHaveText('Hermes started a new session', { timeout: 10000 });
  await expect(transcript()).toContainText('I started a new session. Rukoo sent me the email and a recap of our chat.', { timeout: 10000 });
  await settled();
  await shot('lost-session');
});

test('each chat has its own model and effort: the next turn uses them, and they come back after a restart', async () => {
  // Functions: the window is a new one after the restart.
  const modelButton = () => win.locator('.agentpane .bui-pb__opt[data-pick="model"]');
  const effortButton = () => win.locator('.agentpane .bui-pb__opt[data-pick="effort"]');
  // A menu row by its label alone: a Default row's tag can name a model too.
  const exact = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`);
  const row = (label) => win.locator('.bui-menu .bui-menu__row').filter({ has: win.locator('.bui-menu__label', { hasText: exact(label) }) });
  const received = (agent) => app.evaluate((_e, agent) => global.__semAgents.adapters.get(agent).received.at(-1), agent);
  const pickAgent = async (name) => {
    await win.click('.agentpane .bui-pb__modelbtn');
    await row(name).click();
    await expect(win.locator('.agentpane .ap-agent')).toHaveText(name);
  };
  await openChat('Call on Thursday');
  // A new chat follows the agent's default.
  await expect(modelButton()).toHaveText('Default model');
  await expect(effortButton()).toHaveAttribute('aria-label', 'Effort: Default');

  // Claude, before the first message: a model by mouse, an effort by keyboard.
  await pickAgent('Claude');
  await modelButton().click();
  await expect(win.locator('.bui-menu .bui-menu__row')).toHaveText(['Default', 'Fable', 'Opus', 'Sonnet']);
  await row('Sonnet').click();
  await expect(modelButton()).toHaveText('Sonnet');
  await effortButton().focus();
  await win.keyboard.press('Enter');
  await expect(win.locator('.bui-menu .bui-menu__row')).toHaveText(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  await expect(row('Default')).toBeFocused();
  for (let i = 0; i < 4; i++) await win.keyboard.press('ArrowDown');
  await win.keyboard.press('Enter');
  await expect(effortButton()).toHaveText('Extra high');
  await expect(input()).toBeFocused();
  await say('Which model do you use?');
  await expect(transcript()).toContainText('Model: sonnet. Effort: xhigh.', { timeout: 10000 });
  expect(await received('claude')).toMatchObject({ model: 'sonnet', effort: 'xhigh' });
  // A chat that has started takes a new choice from its next turn.
  await modelButton().click();
  await row('Opus').click();
  await effortButton().click();
  await row('Low').click();
  await say('And which model now?');
  await expect(transcript()).toContainText('Model: opus. Effort: low.', { timeout: 10000 });
  await settled();
  await shot('19-model-effort');

  // Codex in a new chat: each model offers the efforts it supports, and Default says what it comes down to.
  await win.click('.agentpane [data-ap="new"]');
  await pickAgent('Codex');
  await expect(modelButton()).toHaveText('Default model');
  await modelButton().click();
  await row('GPT-6-Luna').click();
  await effortButton().click();
  await expect(win.locator('.bui-menu .bui-menu__row')).toHaveText(['DefaultLow', 'Low', 'Medium', 'High']);
  await row('High').click();
  await say('Which model do you use?');
  await expect(transcript()).toContainText('Model: gpt-6-luna. Effort: high.', { timeout: 10000 });
  expect(await received('codex')).toMatchObject({ model: 'gpt-6-luna', effort: 'high' });

  // Hermes in a new chat: models grouped by provider; one without effort levels has no effort menu.
  await win.click('.agentpane [data-ap="new"]');
  await pickAgent('Hermes');
  await modelButton().click();
  await expect(win.locator('.bui-menu .bui-menu__heading')).toHaveText(['Model', 'Anthropic', 'OpenRouter', 'Model routes']);
  await row('mistral/small-4').click();
  await expect(effortButton()).toBeHidden();
  await modelButton().click();
  await row('claude-opus-5-5').click();
  await effortButton().click();
  await row('Max').click();
  await say('Which model do you use?');
  await expect(transcript()).toContainText('Model: anthropic::claude-opus-5-5. Effort: max.', { timeout: 10000 });
  expect(await received('clark')).toMatchObject({ model: 'anthropic::claude-opus-5-5', effort: 'max' });

  // After a restart each chat has its own choice again, and switching chats shows the other's.
  await app.close();
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await item('Call on Thursday').click();
  if (!(await pane().isVisible())) await win.keyboard.press('Control+j');
  await expect(transcript()).toContainText('Model: anthropic::claude-opus-5-5. Effort: max.');
  await expect(modelButton()).toHaveText('claude-opus-5-5');
  await expect(effortButton()).toHaveText('Max');
  await win.click('.agentpane [data-ap="history"]');
  await row('Call on Thursday').filter({ hasText: 'Claude' }).click();
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Claude');
  await expect(modelButton()).toHaveText('Opus');
  await expect(effortButton()).toHaveText('Low');
  await say('Still the same model?');
  await expect(transcript()).toContainText('You asked: "Still the same model?"', { timeout: 10000 });
  expect(await received('claude')).toMatchObject({ model: 'opus', effort: 'low' });
});

test('the panel follows a language change, the open conversation included', async () => {
  await openChat('Call on Thursday');
  await chip('Plan follow-ups').click();
  await expect(transcript().locator('.bui-approval')).toContainText('Waiting for you');
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await expect(win.locator('.list-title h1')).toHaveText('Postvak IN');
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Hermes');
  await expect(input()).toHaveAttribute('placeholder', 'Vraag Hermes iets over deze e-mail...');
  await expect(transcript().locator('.bui-approval')).toContainText('Wacht op jou');
  await expect(transcript().locator('.bui-approval').getByRole('button', { name: 'Afwijzen' })).toBeVisible();
  await expect(transcript().locator('.bui-task__pill').nth(1)).toHaveText('Voorgesteld');
  // The plan and the approval have their own cards, so no chips repeat them.
  await expect(transcript().locator('.bui-tool')).toHaveCount(0);
  // Hermes's four choices, in Dutch, sit two by two at the default width without being cut off.
  const cid = await conversationId();
  await app.evaluate((_e, cid) => {
    global.__semAgents.requestApproval(cid, {
      title: 'Clark wants to run a command',
      fields: [{ key: 'command', label: 'Command', value: 'td add "Send proposal" --due friday' }],
      choices: [
        { id: 'once', label: 'Allow once', kind: 'primary' },
        { id: 'session', label: 'Allow for this turn', kind: 'default' },
        { id: 'always', label: 'Always allow', kind: 'default' },
        { id: 'deny', label: 'Deny', kind: 'danger' }
      ],
      kind: 'proposal'
    });
  }, cid);
  const four = transcript().locator('.bui-approval').last().locator('.bui-approval__actions button');
  await expect(four).toHaveText(['Weigeren', 'Toestaan voor dit antwoord', 'Altijd toestaan', 'Eén keer toestaan']);
  const fit = await four.evaluateAll((buttons) => buttons.map((b) => ({ top: Math.round(b.getBoundingClientRect().top), cut: b.scrollWidth > b.clientWidth + 1 })));
  expect(fit.map((b) => b.cut)).toEqual([false, false, false, false]);
  expect(fit[0].top).toBe(fit[1].top);
  expect(fit[2].top).toBe(fit[3].top);
  await transcript().locator('.bui-approval').last().scrollIntoViewIfNeeded();
  await pane().screenshot({ path: path.join(SHOTS, '13-dutch-choices-light-panel.png') });
  // An adapter's info line with a code ("Claude started a new session") is said in Dutch too.
  await app.evaluate((_e, cid) => {
    const hub = global.__semAgents;
    hub.addItem(hub.conversations.get(cid), { type: 'notice', text: 'Claude started a new session', tone: 'info', code: 'new-session', undo: null });
  }, cid);
  await expect(transcript().locator('.bui-notice__text').last()).toHaveText('Hermes is een nieuwe sessie begonnen');
  await expect(win.locator('.agentpane [data-ap="new"]')).toHaveAttribute('title', 'Nieuwe chat');
  await win.click('.agentpane [data-ap="new"]');
  await expect(win.locator('.agentpane .bui-rec__title')).toHaveText('Wat moet Hermes met deze e-mail?');
  await expect(chip('Antwoord opstellen')).toBeVisible();
  await shot('09-dutch');
});

// The screenshots switch themes with the email open; the mail must be redrawn in the new theme.
test('the open email follows a theme change made in Settings', async () => {
  await item('Call on Thursday').click();
  // The frame is replaced while it redraws; a read that lands mid-swap just tries again.
  const color = () => win.frameLocator('.mail-frame').locator('html').evaluate((el) => getComputedStyle(el).color).catch(() => null);
  await win.evaluate(() => window.mail.call('updateSettings', { theme: 'dark' }));
  await expect.poll(color).toBe('rgb(230, 232, 238)');
  await win.evaluate(() => window.mail.call('updateSettings', { theme: 'light' }));
  await expect.poll(color).toBe('rgb(21, 23, 28)');
  await win.evaluate(() => window.mail.call('updateSettings', { theme: 'dark' }));
  await expect.poll(color).toBe('rgb(230, 232, 238)');
});

test('agent-written HTML loses controls, images, styles and unsafe links', async () => {
  const out = await win.evaluate(async () => {
    const { sanitizeAgentHtml, textToEditorHtml } = await import('./agent/richtext.js');
    return {
      html: sanitizeAgentHtml(
        '<p style="color:red" class="signature" data-c="send">Hi <b onclick="x()">there</b></p>' +
          '<button data-c="send">Send</button><input data-field="subject"><img src="https://evil.example/?leak=1">' +
          '<script>alert(1)</script><a href="javascript:alert(1)">bad</a> <a href=" https://example.com ">ok</a>' +
          '<custom-tag>kept text</custom-tag><svg><text>no</text></svg><!-- note -->'
      ),
      text: textToEditorHtml('One <b>\n\nTwo')
    };
  });
  expect(out.html).toBe('<p>Hi <b>there</b></p>bad <a href="https://example.com">ok</a>kept text');
  expect(out.text).toBe('<div>One &lt;b&gt;</div><div><br></div><div>Two</div>');
});

test('Settings has an Agents page with status and a way back', async () => {
  await win.click('[data-action="settings"]');
  await win.locator('.page.settings .row', { hasText: 'Claude Code and Codex' }).click();
  await expect(win.locator('.page.settings h1')).toHaveText('Agents');
  await expect(win.locator('[data-agent-status="clark"] .title')).toHaveText('Ready');
  await expect(win.locator('[data-agent-field="clark.name"]')).toHaveValue('Hermes');
  await win.locator('[data-agent-field="clark.name"]').fill('Clark');
  await win.locator('[data-agent-field="clark.name"]').press('Enter');
  await expect(win.locator('[data-agent-name="clark"]').first()).toHaveText('Clark');
  // Clark is the default agent, so that row follows the new name too.
  await expect(win.locator('[data-agent-default]')).toHaveText('Clark');
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await win.evaluate((t) => window.mail.call('updateSettings', { theme: t }), theme);
    await win.waitForTimeout(250);
    await win.screenshot({ path: path.join(SHOTS, `06-settings-${theme}.png`) });
    await win.locator('.page-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await win.screenshot({ path: path.join(SHOTS, `06-settings-${theme}-bottom.png`) });
    await win.locator('.page-scroll').evaluate((el) => el.scrollTo(0, 0));
  }
  await win.click('.page.settings [data-a="back"]');
  await win.click('.page.settings [data-a="back"]');
  await expect(win.locator('.page.settings')).toHaveCount(0);
  // The new name is what the chat calls the agent.
  await win.keyboard.press('Control+j');
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Clark');
});

test('a reopened reply-all draft rewritten as a private reply loses the old Cc', async () => {
  await openChat('Call on Thursday');
  await say('Hello there');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  const cid = await conversationId();
  let res = await tool(cid, 'write_draft', { mode: 'reply_all', body: 'Hi both, Thursday works.' });
  expect(res.error).toBeNull();
  await expect(win.locator('.composer [data-rfield="cc"] .recipient')).toHaveText(['Joris Bakker']);
  // Stored, then reopened from its card: a draft no longer says whether it was a reply or a reply-all.
  await editor().click();
  await win.keyboard.press('Control+s');
  await expect(win.locator('.composer .save-state')).toHaveText('Draft saved');
  await win.keyboard.press('Escape');
  await expect(win.locator('.composer')).toHaveCount(0);
  await transcript().locator('.bui-draft').first().getByRole('button', { name: 'Show' }).click();
  await expect(composerTitle()).toHaveText('Draft');
  await expect(win.locator('.composer [data-rfield="cc"] .recipient')).toHaveText(['Joris Bakker']);
  res = await tool(cid, 'write_draft', { mode: 'reply', body: 'Just for you, Sanne.' });
  expect(res.error).toBeNull();
  await expect(composerTitle()).toHaveText('Draft');
  await expect(editor()).toContainText('Just for you, Sanne.');
  await expect(win.locator('.composer [data-rfield="to"] .recipient')).toHaveText(['Sanne de Vries']);
  await expect(win.locator('.composer [data-rfield="cc"] .recipient')).toHaveCount(0);
});

test('a chat that is not on screen never overwrites your own words, even after they were saved', async () => {
  await openChat('Call on Thursday');
  await say('Hello there');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  const cid = await conversationId();
  // Your own reply, saved, so the composer is no longer dirty.
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeHidden();
  await win.click('[data-reader="reply"]');
  await editor().click();
  await win.keyboard.type('My own words.');
  await win.keyboard.press('Control+s');
  await expect(win.locator('.composer .save-state')).toHaveText('Draft saved');
  // The chat is closed, so it writes from the background: the reply fits, but the words are yours.
  const res = await tool(cid, 'write_draft', { body: 'Agent text.' });
  expect(res.error).toContain('writing another email');
  await expect(editor()).toContainText('My own words.');
  await expect(editor()).not.toContainText('Agent text.');
});

test('a reopened reply-all draft with only a new To still drops the old Cc', async () => {
  await openChat('Call on Thursday');
  await say('Hello there');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  const cid = await conversationId();
  expect((await tool(cid, 'write_draft', { mode: 'reply_all', body: 'Hi both.' })).error).toBeNull();
  await editor().click();
  await win.keyboard.press('Control+s');
  await expect(win.locator('.composer .save-state')).toHaveText('Draft saved');
  await win.keyboard.press('Escape');
  await expect(win.locator('.composer')).toHaveCount(0);
  await transcript().locator('.bui-draft').first().getByRole('button', { name: 'Show' }).click();
  await expect(win.locator('.composer [data-rfield="cc"] .recipient')).toHaveText(['Joris Bakker']);
  // The agent names the recipient but says nothing about Cc: a private reply still has none.
  expect((await tool(cid, 'write_draft', { mode: 'reply', to: ['sanne@example.com'], body: 'Just you.' })).error).toBeNull();
  await expect(editor()).toContainText('Just you.');
  await expect(win.locator('.composer [data-rfield="cc"] .recipient')).toHaveCount(0);
});

test('Settings opens at once while agent status is slow, and fills it in when it comes', async () => {
  // A Hermes server that does not answer: status takes seconds.
  await app.evaluate(() => {
    const hub = global.__semAgents;
    const real = hub.status.bind(hub);
    hub.status = (...args) => new Promise((resolve) => setTimeout(() => resolve(real(...args)), 6000));
  });
  const opened = Date.now();
  await win.click('[data-action="settings"]');
  await expect(win.locator('.settings [data-a="agents"]')).toBeVisible({ timeout: 1500 });
  expect(Date.now() - opened).toBeLessThan(3000);
  await expect(win.locator('.settings [data-a="agents"] .desc')).toContainText('Ready', { timeout: 10000 });
});

test('the panel takes a new default agent at once, before slow status probes answer', async () => {
  await openChat('Call on Thursday');
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Hermes');
  // Settings made Claude the default while the Hermes server is slow to answer status probes.
  await app.evaluate(() => {
    const hub = global.__semAgents;
    const real = hub.status.bind(hub);
    hub.status = (...args) => new Promise((resolve) => setTimeout(() => resolve(real(...args)), 6000));
    hub.cfg.data.defaultAgent = 'claude';
    hub.emitEvent({ kind: 'agents', status: hub.statuses });
  });
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('Claude', { timeout: 1500 });
});

test('a draft card opens the draft it left behind, also after a restart', async () => {
  await openChat('Call on Thursday');
  await chip('Draft a reply').click();
  await expect(editor()).toContainText('Thursday at 10:00 works for me.', { timeout: 10000 });
  await expect(transcript()).toContainText('Done. The draft is in the composer.', { timeout: 10000 });
  await editor().click();
  await win.keyboard.press('Control+s');
  await expect(win.locator('.composer .save-state')).toHaveText('Draft saved');
  await win.keyboard.press('Escape');
  await expect(win.locator('.composer')).toHaveCount(0);
  // A restart empties what the panel remembered; the card itself knows its draft.
  await win.reload();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await item('Call on Thursday').click();
  await expect(pane()).toBeVisible();
  await transcript().locator('.bui-draft').getByRole('button', { name: 'Show' }).click();
  await expect(composerTitle()).toHaveText('Draft');
  await expect(editor()).toContainText('Thursday at 10:00 works for me.');
  // A draft in a folder with a long or non-Latin name has a long id; main takes it.
  const long = `demo:${encodeURIComponent('Концепты'.repeat(8))}:1`;
  expect(long.length).toBeGreaterThan(200);
  expect(await win.evaluate((id) => window.mail.call('agentKeepDraft', 'k-long', id, null).then(() => 'ok', (e) => e.message), long)).toBe('ok');
});

test('a draft card follows its draft into a window of its own: saved again there, then sent', async () => {
  await openChat('Call on Thursday');
  await chip('Draft a reply').click();
  await expect(editor()).toContainText('Thursday at 10:00 works for me.', { timeout: 10000 });
  await expect(transcript()).toContainText('Done. The draft is in the composer.', { timeout: 10000 });
  const cid = await conversationId();
  const draftOf = () => app.evaluate((_e, cid) => global.__semAgents.conversations.get(cid).items.find((i) => i.type === 'draft').draftId || null, cid);
  const [popped] = await Promise.all([app.waitForEvent('window'), win.click('.composer [data-c="popout"]')]);
  await popped.waitForSelector('.compose .editor');
  await expect.poll(draftOf).not.toBeNull();
  const first = await draftOf();
  // Saved again in the window: a new stored draft, and the card points at it.
  await popped.click('.compose .editor');
  await popped.keyboard.press('End');
  await popped.keyboard.type(' See you then.');
  await popped.keyboard.press('Control+s');
  await expect.poll(draftOf).not.toBe(first);
  expect(await draftOf()).not.toBeNull();
  // Sent from the window: the card has no draft left, so Show opens the email it answered.
  await Promise.all([popped.waitForEvent('close'), popped.click('[data-c="send"]')]);
  await expect.poll(draftOf).toBeNull();
  await transcript().locator('.bui-draft').getByRole('button', { name: 'Show' }).click();
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await expect(win.locator('.composer')).toHaveCount(0);
});

for (const [how, away] of [
  ['the panel closes', () => win.click('.agentpane [data-ap="close"]')],
  ['another chat opens', () => win.click('.agentpane [data-ap="new"]')]
]) {
  test(`a chat that goes off screen while its email loads leaves the open composer alone: ${how}`, async () => {
    await openChat('Call on Thursday');
    await say('Hello there');
    await expect(transcript()).toContainText('You asked', { timeout: 10000 });
    const cid = await conversationId();
    // An untouched new message: the chat on screen may put its reply in its place.
    await win.click('[data-action="compose"]');
    await expect(composerTitle()).toHaveText('New message');
    await app.evaluate(() => {
      const engine = global.__semEngine;
      const real = engine.getMessage.bind(engine);
      engine.getMessage = (id) => new Promise((resolve) => setTimeout(() => resolve(real(id)), 1500));
    });
    const pending = tool(cid, 'write_draft', { body: 'Agent text.' });
    // The user looks away from the chat while the email loads.
    await win.waitForTimeout(400);
    await away();
    const res = await pending;
    expect(res.error).toContain('writing another email');
    await expect(composerTitle()).toHaveText('New message');
    await expect(editor()).not.toContainText('Agent text.');
  });
}

test('a chat that is not on screen leaves a reply alone while you are still typing an address', async () => {
  await openChat('Call on Thursday');
  await say('Hello there');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  const cid = await conversationId();
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeHidden();
  // The reply this chat would fit, untouched but for an address that is not finished yet.
  await win.click('[data-reader="reply"]');
  const to = win.locator('.composer [data-rinput="to"]');
  await to.click();
  await win.keyboard.type('pieter@exa');
  const res = await tool(cid, 'write_draft', { to: ['joris@example.com'], body: 'Agent text.' });
  expect(res.error).toContain('writing another email');
  await expect(to).toHaveValue('pieter@exa');
  await expect(to).toBeFocused();
  await expect(win.locator('.composer [data-rfield="to"] .recipient')).toHaveText(['Sanne de Vries']);
  await expect(editor()).not.toContainText('Agent text.');
});

test('a chat that is not on screen leaves an unrelated reply alone, even an empty one', async () => {
  await openChat('Call on Thursday');
  await say('Hello there');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  const cid = await conversationId();
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeHidden();
  // The user opened a reply to another email, nothing typed yet.
  await item('Sign in to Bencompare').click();
  await win.click('[data-reader="reply"]');
  await expect(win.locator('.composer #subject')).toHaveValue('Re: Sign in to Bencompare');
  const res = await tool(cid, 'write_draft', { body: 'Agent text.' });
  expect(res.error).toContain('writing another email');
  await expect(win.locator('.composer #subject')).toHaveValue('Re: Sign in to Bencompare');
  await expect(editor()).not.toContainText('Agent text.');
});
