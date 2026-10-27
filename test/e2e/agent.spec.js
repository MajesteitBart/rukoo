// End-to-end tests for the chat panel: the real app with the demo account and the fake agents
// (SEM_AGENT_FAKE=1), in English. Screenshots for review go to tmp/e2e-shots/agent in the checkout, which Git
// ignores; each run replaces them.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { LONG_COMMAND, LONG_COMMAND_TAIL } = require('../../src/main/agents/fake');
const { Skills } = require('../../src/main/agents/skills');
const { makePdf } = require('../fixtures/make-pdf');

const SHOTS = path.join(__dirname, '..', '..', 'tmp', 'e2e-shots', 'agent');
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
  dataDir = tempDir('rukoo-agent-e2e-');
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const item = (text) => win.locator('.item', { hasText: text }).first();
const pane = () => win.locator('.agentpane');
const transcript = () => win.locator('.agentpane .ap-transcript');
const input = () => win.locator('.agentpane .bui-pb__ta');
// The input's text as it is sent, a skill chip as its $name. The input is an editable, which has no form value.
const inputValue = () => input().evaluate((el) => el.value);
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

// Sets the theme and returns once the page has it and the mail list has redrawn. A settings change reaches the
// list as a refresh a moment later; when that redraw came in the middle of the next dragTo, Playwright's drag
// ended without a drop and without an error.
async function setTheme(theme) {
  const watching = await win.evaluate(() => {
    window.__listRedrawn = false;
    const list = document.querySelector('.list-scroll');
    const seen = (_, observer) => {
      observer.disconnect();
      window.__listRedrawn = true;
    };
    if (list) new MutationObserver(seen).observe(list, { childList: true });
    return Boolean(list);
  });
  await win.evaluate((t) => window.mail.call('updateSettings', { theme: t }), theme);
  await expect(win.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light).*$/);
  if (watching) await expect.poll(() => win.evaluate(() => window.__listRedrawn)).toBe(true);
}

// Both themes, the whole window and the panel alone.
async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    // The mail frame redraws for the theme a moment after the page itself.
    await win.waitForTimeout(900);
    await win.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    await pane().screenshot({ path: path.join(SHOTS, `${name}-${theme}-panel.png`) });
  }
  await setTheme('dark');
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
  // The quick action, then Rukoo's skill that finishes the page in the agent's browser.
  await expect(win.locator('.agentpane .bui-pb__cmdname')).toHaveText(['/unsubscribe', '/unsubscribe-via-browser']);
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
  await expect(input()).toHaveAttribute('data-placeholder', 'Ask Hermes...');
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
  await expect(files.locator('.bui-entity').getByRole('button')).toHaveCount(0);
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
  await expect.poll(inputValue).toBe('/shared');
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

test("Rukoo's own skills are slash commands that start with their instructions, from the app's skills folder", async () => {
  const shipped = new Skills({ bundled: path.join(__dirname, '..', '..', 'skills') }).list();
  expect(shipped.map((s) => s.name)).toContain('unsubscribe-via-browser');
  const received = () => app.evaluate(() => global.__semAgents.adapters.get('clark').received.at(-1));
  const idle = () => app.evaluate(() => global.__semAgents.list().every((c) => c.status !== 'running'));
  await openChat('Traffic fines in 2027: what you will pay');
  const rows = win.locator('.agentpane .bui-pb__cmd');
  for (const [i, skill] of shipped.entries()) {
    if (i) await win.click('.agentpane [data-ap="new"]');
    await input().fill(`/${skill.name}`);
    const named = shipped.filter((s) => s.name.startsWith(skill.name));
    await expect(rows.locator('.bui-pb__cmdname')).toHaveText(named.map((s) => `/${s.name}`));
    await expect(rows.first().locator('.bui-pb__cmddesc')).toHaveText(skill.description);
    if (skill.name === 'unsubscribe-via-browser') await shot('18-bundled-skills-menu');
    await input().press('Enter');
    await expect(transcript().locator('.bui-ub')).toHaveText(`/${skill.name}`);
    // The scripted agent reads the skill with read_skill and quotes its first line.
    await expect(transcript()).toContainText(`Following the skill ${skill.name}. It starts with: ${skill.body.split('\n')[0]}`, { timeout: 10000 });
    const got = await received();
    expect(got.action).toBe('skill');
    expect(got.input).toContain(`[The user started the skill "${skill.name}".`);
    expect(got.input.endsWith(`\n\n${skill.body}`)).toBe(true);
    await expect.poll(idle, { timeout: 10000 }).toBe(true);
  }
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
  await expect.poll(inputValue).toBe('');

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
  await expect(files.locator('.bui-entity').getByRole('button')).toHaveCount(0);
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
  // The panel covers the whole workspace, its left edge included.
  await expect
    .poll(() =>
      win.evaluate(() => {
        const [pane, workspace] = ['.agentpane', '.workspace'].map((s) => document.querySelector(s).getBoundingClientRect());
        return [pane.left - workspace.left, pane.right - workspace.right].map((d) => Math.abs(Math.round(d)));
      })
    )
    .toEqual([0, 0]);
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
  await expect(input()).toHaveAttribute('data-placeholder', 'Ask Claude about this email...');
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
  // Linux window managers deliver resize/layout updates asynchronously.
  await expect.poll(async () => (await size()).reader).toBeGreaterThanOrEqual(419);
  await expect.poll(async () => (await size()).agent).toBeLessThan(560);
  // With room to spare the panel takes the width you gave it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1900, 950));
  await expect.poll(async () => (await size()).agent).toBeGreaterThan(450);
  await expect.poll(async () => (await size()).reader).toBeGreaterThanOrEqual(419);
});

// #47: at 125% and 175% the window can be a fraction of a pixel over 1239 CSS px, while window.innerWidth says 1239. The
// CSS docks the panel there (it slides over the reader up to max-width: 1239px), so the layout code has to count it as
// docked too: the reader keeps its 420 px and Escape leaves the panel open. The 860 px breakpoint agrees as well.
test('at 125% and 175% zoom the layout code docks the chat panel where the CSS does, so the reader keeps its 420 px', async () => {
  await openChat('Call on Thursday');
  const toggle = win.locator('.titlebar [data-agent-toggle]');
  // The display's own scale, at 100%.
  const scale = await win.evaluate(() => devicePixelRatio);
  const layout = () =>
    win.evaluate(() => {
      const width = (s) => document.querySelector(s).getBoundingClientRect().width;
      return { css: width('html'), position: getComputedStyle(document.querySelector('.agentpane')).position, reader: width('.reader') };
    });
  const zoomTo = async (zoom) => {
    await win.evaluate((z) => window.mail.call('setZoom', z), zoom);
    await expect.poll(() => win.evaluate(() => devicePixelRatio)).toBeCloseTo((scale * zoom) / 100);
  };
  // Makes the page `dips` wide. Window frames differ per platform (on Windows a frameless window's content size
  // includes its borders), so this measures the page and moves the window's edge by what is missing.
  const fit = (zoom, dips) =>
    expect
      .poll(
        async () => {
          const now = Math.round(((await layout()).css * zoom) / 100);
          if (now !== dips) {
            await app.evaluate(({ BrowserWindow }, off) => {
              const w = BrowserWindow.getAllWindows()[0];
              const [width, height] = w.getSize();
              w.setSize(width + off, height);
            }, dips - now);
          }
          return now;
        },
        { intervals: [250] }
      )
      .toBe(dips);

  for (const [zoom, dips] of [
    [125, 1549],
    [175, 2169]
  ]) {
    await zoomTo(zoom);
    // 1239.2 and 1239.43 CSS px: docked, beside a reader of at least 420 px.
    await fit(zoom, dips);
    const docked = await layout();
    expect(docked.css).toBeGreaterThan(1239);
    expect(docked.css).toBeLessThan(1240);
    expect(docked.position).toBe('static');
    expect(docked.reader).toBeGreaterThanOrEqual(420);
    await input().focus();
    await win.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(pane()).toBeVisible();
    // 1238.4 and 1238.86 CSS px: it slides over the reader, and Escape closes it there.
    await fit(zoom, dips - 1);
    const overlay = await layout();
    expect(overlay.css).toBeLessThan(1239);
    expect(overlay.position).toBe('absolute');
    await input().focus();
    await win.keyboard.press('Escape');
    await expect(pane()).toBeHidden();
    await win.keyboard.press('Control+j');
    await expect(pane()).toBeVisible();
  }

  // 860.57 CSS px, where window.innerWidth says 860: the CSS shows the list and the reader side by side, so another
  // folder opens its newest email as in any wide window.
  await fit(175, 1506);
  const twoPanes = await layout();
  expect(twoPanes.css).toBeGreaterThan(860);
  expect(twoPanes.css).toBeLessThan(861);
  await win.click('[data-view="sent"]');
  await expect(win.locator('.reader-subject')).toBeVisible();
});

test('a PDF is read in a utility process: one that never finishes or takes ever more memory is ended there, the app keeps working, and quitting leaves no reader behind', async () => {
  const reader = path.join(__dirname, '..', 'fixtures', 'hostile-reader.js');
  const readers = () => app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().filter((m) => m.name === 'Rukoo PDF reader').map((m) => m.pid));
  // A read that never finishes, in a utility process of the app; the window meanwhile opens an email.
  const hang = app.evaluate(async (_e, file) => {
    const PdfReader = global.__semAgents.pdf.constructor;
    const started = Date.now();
    const res = await new PdfReader({ timeout: 2500, reader: file }).read(Buffer.from('%PDF-1.4\nHANG\n'));
    return { ...res, ms: Date.now() - started };
  }, reader);
  await expect.poll(readers).toHaveLength(1);
  await item('Your parcel is on its way').click();
  await expect(win.locator('.reader-subject')).toHaveText('Your parcel is on its way');
  const hung = await hang;
  expect(hung.failed).toBe('timeout');
  expect(hung.ms).toBeLessThan(5000);
  // Buffers outside V8's heap: the watchdog in the utility process ends it at its memory cap.
  const buffers = await app.evaluate(async (_e, file) => {
    const PdfReader = global.__semAgents.pdf.constructor;
    return new PdfReader({ rssMax: 300 * 1024 * 1024, reader: file }).read(Buffer.from('%PDF-1.4\nBUFFERS\n'));
  }, reader);
  expect(buffers.failed).toBe('memory');
  await expect.poll(readers).toHaveLength(0);
  // The app's own reader, stuck on a PDF when Rukoo quits: closing ends it.
  await app.evaluate((_e, file) => {
    const pdf = global.__semAgents.pdf;
    pdf.opts.reader = file;
    pdf.read(Buffer.from('%PDF-1.4\nHANG\n'));
  }, reader);
  await expect.poll(readers).toHaveLength(1);
  const [pid] = await readers();
  await app.close();
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  };
  await expect.poll(alive).toBe(false);
});

test('Stop while a PDF is read ends its reader at once, and the next message tells the agent what the stopped one brought', async () => {
  await openChat('Call on Thursday');
  const readers = () => app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().filter((m) => m.name === 'Rukoo PDF reader').length);
  const last = () => app.evaluate(() => global.__semAgents.adapters.get('clark').received.at(-1) || null);
  // The app's own reader gets stuck on this PDF; its time limit is 10 s.
  await app.evaluate((_e, file) => (global.__semAgents.pdf.opts.reader = file), path.join(__dirname, '..', 'fixtures', 'hostile-reader.js'));
  await dropFiles([{ name: 'stuck.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4\nHANG\n') }]);
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['stuck.pdf']);
  await say('Read this');
  await expect.poll(readers).toBe(1);
  const send = win.locator('.agentpane .bui-pb__send');
  await expect(send).toHaveClass(/is-stop/);
  await send.click();
  await expect.poll(readers, { timeout: 2000 }).toBe(0);
  await expect(send).not.toHaveClass(/is-stop/);
  await say('Never mind');
  await expect.poll(async () => ((await last()) || {}).text).toBe('Never mind');
  const got = await last();
  expect(got.input).toContain('Since your last turn: The user attached <unsafe_content source="file name">stuck.pdf</unsafe_content>');
  expect((await app.evaluate(() => global.__semAgents.adapters.get('clark').received.map((r) => r.text))).includes('Read this')).toBe(false);
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

test('the bell counts chats with news from off screen; its list follows them live and opens a chat with its email', async () => {
  const bell = () => win.locator('.agentpane [data-ap="history"]');
  const toggle = () => win.locator('.titlebar [data-agent-toggle]');
  const chatRow = (title) => win.locator('.bui-menu .bui-menu__row').filter({ has: win.locator('.bui-menu__label', { hasText: new RegExp(`^${title}$`) }) });
  await openChat('Call on Thursday');
  await expect(bell()).toHaveAttribute('aria-label', 'Recent chats');
  await say('Add the proposal task; ask for approval first');
  await expect(transcript().locator('.bui-approval')).toContainText('Waiting for you');
  const cid = await conversationId();
  // On another email the chat waits in the background, and the bell says an agent waits for you.
  await item('Your parcel is on its way').click();
  await expect(win.locator('.reader-subject')).toHaveText('Your parcel is on its way');
  await expect(bell()).toHaveClass(/has-news/);
  await expect(bell()).toHaveAttribute('data-tone', 'waiting');
  await expect(bell()).toHaveAttribute('aria-label', 'Recent chats, 1 new');
  await expect(bell().locator('.ap-count')).toHaveText('1');
  await bell().click();
  const row = chatRow('Call on Thursday');
  await expect(row.locator('.bui-menu__sub')).toHaveText('Hermes · Waiting for you');
  await expect(row.locator('.bui-dot--busy')).toBeVisible();
  // Approved elsewhere, the agent finishes while the list is open: the row and the bell follow without reopening.
  await app.evaluate((_e, cid) => {
    const hub = global.__semAgents;
    hub.decide(cid, hub.get(cid).items.find((i) => i.type === 'approval').id, 'allow');
  }, cid);
  await expect(row.locator('.bui-menu__sub')).toHaveText('Hermes · Reply ready');
  await expect(row.locator('.bui-dot--unread')).toBeVisible();
  await expect(bell()).toHaveAttribute('data-tone', 'unread');

  // The email has moved to the archive since. Picking the chat opens it, and its email from where it is now.
  const was = await app.evaluate((_e, cid) => global.__semAgents.get(cid).message.id, cid);
  await app.evaluate((_e, id) => global.__semEngine.archive(id), was);
  await expect(win.locator(`.item[data-id="${was}"]`)).toHaveCount(0);
  await row.click();
  await expect(transcript()).toContainText('Added "Send proposal" to Todoist, due Friday.');
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await expect(bell()).not.toHaveClass(/has-news/);
  await expect(bell()).toHaveAttribute('aria-label', 'Recent chats');
  await bell().click();
  await expect(row.locator('.bui-menu__sub')).toHaveText('Hermes · Added "Send proposal" to Todoist, due Friday.');
  await expect(row).toHaveClass(/is-checked/);
  await win.keyboard.press('Escape');

  // An answer that comes while the panel is closed puts a dot on its title bar button; opening the panel shows that
  // chat, which reads it.
  await win.click('.agentpane [data-ap="close"]');
  await expect(pane()).toBeHidden();
  await expect(toggle()).not.toHaveClass(/has-news/);
  await app.evaluate((_e, cid) => global.__semAgents.send(cid, { text: 'And now?' }), cid);
  await expect(toggle()).toHaveClass(/has-news/, { timeout: 10000 });
  await expect(toggle()).toHaveAttribute('data-news', 'unread');
  await toggle().click();
  await expect(transcript()).toContainText('You asked: "And now?"');
  await expect(toggle()).not.toHaveClass(/has-news/);
  await expect(bell()).not.toHaveClass(/has-news/);
  // The answer was read, also as far as main is concerned.
  expect(await app.evaluate((_e, cid) => global.__semAgents.get(cid).unread, cid)).toBe(false);

  // Closed again, with another email opened meanwhile: reopening shows that email, and the answer that came in the
  // chat from before stays unread, although the panel still held that chat while it was closed.
  await win.click('.agentpane [data-ap="close"]');
  await expect(pane()).toBeHidden();
  await item('Your parcel is on its way').click();
  await expect(win.locator('.reader-subject')).toHaveText('Your parcel is on its way');
  await app.evaluate((_e, cid) => global.__semAgents.send(cid, { text: 'And after that?' }), cid);
  await expect(toggle()).toHaveClass(/has-news/, { timeout: 10000 });
  await toggle().click();
  await expect(win.locator('.agentpane .ap-empty')).toBeVisible();
  await expect(bell()).toHaveAttribute('aria-label', 'Recent chats, 1 new');
  expect(await app.evaluate((_e, cid) => global.__semAgents.get(cid).unread, cid)).toBe('reply');
});

// #79: the closed panel still holds chat A, whose answer is unread. "Show" on another chat's approval toast must open that
// chat without telling main that A was on screen for a moment, which would mark A's answer read.
test('Show on an approval toast opens that chat and leaves the unread answer in the chat the closed panel held unread', async () => {
  const bell = () => win.locator('.agentpane [data-ap="history"]');
  const toggle = () => win.locator('.titlebar [data-agent-toggle]');
  const unread = (cid) => app.evaluate((_e, cid) => global.__semAgents.get(cid).unread, cid);
  const done = (cid) => expect.poll(() => app.evaluate((_e, cid) => global.__semAgents.turns.has(cid), cid)).toBe(false);
  // C: a chat about the parcel email, done for now.
  await openChat('Your parcel is on its way');
  await say('Hello there');
  await expect(transcript()).toContainText('You asked: "Hello there"', { timeout: 10000 });
  const c = await conversationId();
  await done(c);
  // A: the chat about the email on screen when the panel closes.
  await item('Call on Thursday').click();
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await expect(win.locator('.agentpane .ap-empty')).toBeVisible();
  await say('Summarize this');
  await expect(transcript()).toContainText('You asked: "Summarize this"', { timeout: 10000 });
  const a = await conversationId();
  expect(a).not.toBe(c);
  await done(a);
  await win.click('.agentpane [data-ap="close"]');
  await expect(pane()).toBeHidden();

  // A answers while the panel is closed: news on the title bar button.
  await app.evaluate((_e, cid) => global.__semAgents.send(cid, { text: 'And now?' }), a);
  await expect.poll(() => unread(a), { timeout: 10000 }).toBe('reply');
  await expect(toggle()).toHaveAttribute('data-news', 'unread');
  // C's agent asks for approval; a toast says so.
  await app.evaluate((_e, cid) => global.__semAgents.send(cid, { text: 'Add the proposal task; ask for approval first' }), c);
  const toast = win.locator('#toast');
  await expect(toast).toContainText('An agent is waiting for your approval', { timeout: 10000 });
  await toast.locator('button', { hasText: 'Show' }).click();

  // The panel opens on C, its approval card included; the email on screen stays.
  await expect(pane()).toBeVisible();
  await expect(transcript()).toContainText('You asked: "Hello there"');
  await expect(transcript().locator('.bui-approval')).toContainText('Waiting for you');
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  expect(await app.evaluate(() => global.__semAgents.watching)).toBe(c);
  // A's answer is still news: in main, on the bell and, with the panel closed again, on the title bar button.
  expect(await unread(a)).toBe('reply');
  await expect(bell()).toHaveAttribute('aria-label', 'Recent chats, 1 new');
  await expect(bell()).toHaveAttribute('data-tone', 'unread');
  await win.click('.agentpane [data-ap="close"]');
  await expect(pane()).toBeHidden();
  await expect(toggle()).toHaveClass(/has-news/);
  expect(await unread(a)).toBe('reply');

  // A chat that cannot be loaded still opens the panel, and the toast says why: here main refuses the id.
  await app.evaluate(() => global.__semAgents.emitEvent({ kind: 'reveal', conversationId: 'x'.repeat(201) }));
  await expect(pane()).toBeVisible();
  await expect(toast).toHaveText('invalid');
  await expect(transcript()).toContainText('You asked: "Hello there"');
});

test('the open chat list goes by the last message: a chat moves up as soon as its agent writes, before its turn ends', async () => {
  const labels = () => win.locator('.bui-menu .bui-menu__row .bui-menu__label');
  const sub = (title) => win.locator('.bui-menu .bui-menu__row').filter({ has: win.locator('.bui-menu__label', { hasText: new RegExp(`^${title}$`) }) }).locator('.bui-menu__sub');
  // A waits for an approval; B, about another email, answers after that.
  await openChat('Call on Thursday');
  await say('Add the proposal task; ask for approval first');
  await expect(transcript().locator('.bui-approval')).toContainText('Waiting for you');
  const a = await conversationId();
  await item('Your parcel is on its way').click();
  await expect(win.locator('.reader-subject')).toHaveText('Your parcel is on its way');
  // The panel has left A's chat for a new one about this email.
  await expect(win.locator('.agentpane .ap-empty')).toBeVisible();
  await say('Hello there');
  await expect(transcript()).toContainText('You asked: "Hello there"', { timeout: 10000 });
  // B's turn has ended and the list has had the refresh that brought, so nothing else is on its way. (A's turn stays
  // open while it waits for the approval.)
  const b = await conversationId();
  await expect.poll(() => app.evaluate((_e, cid) => global.__semAgents.turns.has(cid), b)).toBe(false);
  await win.waitForTimeout(400);
  await win.click('.agentpane [data-ap="history"]');
  await expect(labels()).toHaveText(['Your parcel is on its way', 'Call on Thursday']);
  // A's agent says something while its turn still runs: only that message's item event reaches the panel, and A moves up.
  await app.evaluate((_e, cid) => {
    const hub = global.__semAgents;
    hub.addItem(hub.get(cid), { type: 'assistant', text: 'One moment, I am checking Todoist first.', status: 'done', interim: true });
  }, a);
  await expect(labels()).toHaveText(['Call on Thursday', 'Your parcel is on its way']);
  await expect(sub('Call on Thursday')).toHaveText('Hermes · Waiting for you');
});

test('a chat picked from the list opens with the newest email it was continued from', async () => {
  await openChat('Call on Thursday');
  await say('Summarize this');
  await expect(transcript()).toContainText('You asked: "Summarize this"', { timeout: 10000 });
  // The reply in Sent continues the same chat.
  await win.click('[data-view="sent"]');
  await item('Re: Call on Thursday').click();
  await win.locator('.agentpane .bui-offer').click();
  await expect(transcript()).toContainText('You asked: "Summarize this"');
  // Elsewhere in the inbox, the chat from the list brings back the reply, not the email it started with.
  await win.click('[data-view="inbox"]');
  await item('Your parcel is on its way').click();
  await expect(win.locator('.agentpane .ap-empty')).toBeVisible();
  await win.click('.agentpane [data-ap="history"]');
  await win.locator('.bui-menu .bui-menu__row', { hasText: 'Call on Thursday' }).click();
  await expect(win.locator('.reader-subject')).toHaveText('Re: Call on Thursday');
  await expect(transcript()).toContainText('You asked: "Summarize this"');
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
  // By the agent that starts the row's second line: the Hermes chat's last answer names a claude model.
  await row('Call on Thursday').filter({ has: win.locator('.bui-menu__sub', { hasText: /^Claude · / }) }).click();
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
  await expect(input()).toHaveAttribute('data-placeholder', 'Vraag Hermes iets over deze e-mail...');
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
  await win.locator('.page.settings .row', { hasText: 'Claude Code, Codex and OpenClaw' }).click();
  await expect(win.locator('.page.settings h1')).toHaveText('Agents');
  await expect(win.locator('[data-agent-status="clark"] .title')).toHaveText('Ready');
  await expect(win.locator('[data-agent-field="clark.name"]')).toHaveValue('Hermes');
  await win.locator('[data-agent-field="clark.name"]').fill('Clark');
  await win.locator('[data-agent-field="clark.name"]').press('Enter');
  await expect(win.locator('[data-agent-name="clark"]').first()).toHaveText('Clark');
  // Clark is the default agent, so that row follows the new name too.
  await expect(win.locator('[data-agent-default]')).toHaveText('Clark');
  // Copy Hermes setup starts with the download of the bridge from this Rukoo's own release, so the two speak the
  // same bridge protocol. Recorded in main rather than put on the desktop's own clipboard.
  await app.evaluate(() => {
    global.__semAgents.deps.clipboard = { writeText: (text) => (global.__copiedSetup = text) };
  });
  await win.locator('.page.settings .row', { hasText: 'Copy Hermes setup' }).click();
  await expect(win.locator('#toast')).toContainText("Paste it into ~/.hermes/config.yaml on Clark's machine.");
  const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
  const copied = await app.evaluate(() => global.__copiedSetup);
  expect(copied).toContain(`#    curl -fsSL -o ~/.hermes/rukoo_bridge.py https://raw.githubusercontent.com/MajesteitBart/rukoo/v${version}/integrations/hermes/rukoo_bridge.py\n`);
  expect(copied).toContain('      RUKOO_KEY: ${API_SERVER_KEY}\n');
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

test('OpenClaw has a card in Settings and answers in the chat like the other agents', async () => {
  await win.click('[data-action="settings"]');
  await win.locator('.page.settings .row', { hasText: 'Claude Code, Codex and OpenClaw' }).click();
  const status = win.locator('[data-agent-status="openclaw"]');
  await expect(status.locator('.title')).toHaveText('Ready');
  await expect(status.getByRole('button')).toHaveText('Test connection');
  await expect(win.locator('[data-agent-field="openclaw.url"]')).toHaveValue('http://127.0.0.1:18789');
  // The copied setup needs the token, which goes into a field of its own, next to Hermes' key.
  await win.locator('.page.settings .row', { hasText: 'Copy OpenClaw setup' }).click();
  await expect(win.locator('#toast')).toContainText('Save the gateway token first.');
  const token = win.locator('[data-agent-key="openclaw"]');
  await expect(token).toHaveAttribute('placeholder', 'Paste the gateway token or password');
  await token.fill('gateway-token-123');
  await token.press('Enter');
  if (process.platform === 'linux') {
    // Playwright starts Electron with password-store=basic, and on Linux Rukoo saves no credential without a real
    // keyring. The token is put in the profile the way an older Rukoo stored one instead.
    await expect(win.locator('#toast')).toContainText('Rukoo cannot securely save credentials.');
    await app.evaluate(() => {
      const hub = global.__semAgents;
      hub.cfg.data.openclaw.key = `plain:${Buffer.from('gateway-token-123').toString('base64')}`;
      hub.refreshRemoteHash();
    });
  } else {
    await expect(win.locator('[data-agent-key-box="openclaw"]')).toContainText('Token saved');
    await expect(win.locator('[data-agent-key="clark"]')).toBeVisible();
  }
  await win.locator('[data-agent-field="openclaw.agent"]').fill('research');
  await win.locator('[data-agent-field="openclaw.agent"]').press('Enter');
  await expect.poll(() => win.evaluate(() => window.mail.call('agentConfig').then((c) => c.openclaw))).toMatchObject({ agent: 'research', hasKey: true });
  // The token stays in main: the config the window gets says only that there is one.
  expect(JSON.stringify(await win.evaluate(() => window.mail.call('agentConfig')))).not.toContain('gateway-token-123');
  // What the copy row puts on the clipboard (not clicked here: the clipboard is the desktop's own).
  const setup = await app.evaluate(() => global.__semAgents.cfg.openclawSetup({ port: global.__semAgents.mcp.ports().local }));
  expect(setup).toMatch(/^openclaw mcp set rukoo '\{"url":"http:\/\/127\.0\.0\.1:\d+\/mcp","transport":"streamable-http","headers":\{"Authorization":"Bearer [A-Za-z0-9_-]+"\}\}'\n$/);
  // A gateway on another computer: an explicit opt-in that opens the Tailscale listener. This test machine gets an
  // address nobody has (TEST-NET), so nothing listens on a real tailnet; the card says so, and nothing is copied.
  await app.evaluate(() => global.__semAgents.updateConfig({ mcp: { remoteHost: '192.0.2.1' } }));
  const remoteRow = win.locator('.page.settings [data-a="agent-openclaw-remote"]');
  const copyDesc = win.locator('.page.settings [data-a="agent-copy-openclaw"] .desc');
  await expect(remoteRow).toContainText('Let OpenClaw use Rukoo from another computer');
  await expect(remoteRow).toContainText('For a gateway elsewhere in your tailnet.');
  await expect(copyDesc).toContainText('A command for this computer');
  await remoteRow.click();
  await expect(remoteRow.locator('.switch')).toHaveClass(/on/);
  await expect.poll(() => win.evaluate(() => window.mail.call('agentConfig').then((c) => c.openclaw.remote))).toBe(true);
  await expect(remoteRow.locator('[data-openclaw-address]')).toContainText('Could not listen on 192.0.2.1');
  await expect(copyDesc).toContainText("with Rukoo's Tailscale address");
  await win.locator('.page.settings .row', { hasText: 'Copy OpenClaw setup' }).click();
  await expect(win.locator('#toast')).toContainText("Rukoo isn't listening on a Tailscale address.");
  await remoteRow.click();
  await expect(remoteRow.locator('.switch')).not.toHaveClass(/on/);
  await expect(copyDesc).toContainText('A command for this computer');
  await win.click('.page.settings [data-a="back"]');
  await win.click('.page.settings [data-a="back"]');

  await openChat('Call on Thursday');
  await win.click('.agentpane [data-ap="new"]');
  await win.click('.agentpane .bui-pb__modelbtn');
  await win.locator('.bui-menu .bui-menu__row').filter({ has: win.locator('.bui-menu__label', { hasText: /^OpenClaw$/ }) }).click();
  await expect(win.locator('.agentpane .ap-agent')).toHaveText('OpenClaw');
  await say('Hello OpenClaw');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  const got = await app.evaluate(() => global.__semAgents.adapters.get('openclaw').received.at(-1));
  expect(got.text).toBe('Hello OpenClaw');
  expect(await app.evaluate(() => global.__semAgents.list()[0].agent)).toBe('openclaw');
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

test('agent text goes above a formatted signature and leaves it as it is', async () => {
  await win.evaluate(() =>
    window.mail.call('updateSettings', {
      signatureHtml: '<table><tr><td><b style="color:#1c2340">Demo Sender</b><br><a href="https://example.com/team">example.com/team</a></td></tr></table>'
    })
  );
  await win.reload();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await openChat('Call on Thursday');
  await say('Hello there');
  await expect(transcript()).toContainText('You asked', { timeout: 10000 });
  const cid = await conversationId();
  const layout = () =>
    editor().evaluate((el) => ({
      first: el.firstElementChild.textContent,
      last: el.lastElementChild.className,
      signature: el.querySelector(':scope > .signature').innerHTML
    }));
  expect((await tool(cid, 'write_draft', { mode: 'reply', body: 'Agent text.' })).error).toBeNull();
  await expect(editor()).toContainText('Agent text.');
  const before = await layout();
  expect(before.first).toBe('Agent text.');
  expect(before.last).toBe('signature');
  expect(before.signature).toContain('<b style="color:#1c2340">Demo Sender</b>');
  expect(before.signature).toContain('<a href="https://example.com/team">');
  // A rewrite replaces the text above the signature only.
  expect((await tool(cid, 'write_draft', { mode: 'reply', format: 'html', body: '<p>Second <b>version</b>.</p>' })).error).toBeNull();
  await expect(editor()).toContainText('Second version.');
  await expect(editor()).not.toContainText('Agent text.');
  const after = await layout();
  expect(after.first).toBe('Second version.');
  expect(after.signature).toBe(before.signature);
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

// The phone's side of pairing and the export (agents/phonehost.js), over HTTP like Rukoo on a phone.
function phoneCall(url, { method = 'GET', token, body } = {}) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, { method, agent: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// The Tailscale listener goes on 127.0.0.2, so nothing listens on a real tailnet, and the test counts the requests
// it makes as coming from the tailnet.
test('phone: Settings pairs a phone with the code it shows, lists it, sends the accounts again and removes it', async () => {
  await app.evaluate(async () => {
    const hub = global.__semAgents;
    await hub.updateConfig({ mcp: { remoteHost: '127.0.0.2' } });
    hub.phoneHost.isPeer = () => true;
  });
  await win.click('[data-action="settings"]');
  await win.locator('.page.settings .row', { hasText: 'Claude Code, Codex and OpenClaw' }).click();
  const toggle = win.locator('.page.settings [data-a="agent-phone"]');
  await expect(toggle).toContainText('Let my phone use this computer');
  await expect(toggle).toContainText('Your phone runs Claude Code and Codex chats here over Tailscale.');
  await expect(toggle.locator('.switch')).not.toHaveClass(/\bon\b/);

  // Cancel: the code stops working.
  const pairRow = win.locator('.page.settings [data-a="agent-phone-pair"]');
  await pairRow.click();
  await win.locator('.radio-row', { hasText: 'Pair only' }).click();
  const dialog = win.locator('.dialog', { hasText: 'Pair a phone' });
  await expect(dialog.locator('.phone-pair-code')).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  await expect(dialog).toContainText('The code works for 5 more minutes.');
  await expect(dialog).not.toContainText('fetch your accounts');
  // Pairing turned the switch on, which shows where Rukoo listens.
  await expect(toggle.locator('.switch')).toHaveClass(/\bon\b/);
  const address = await dialog.locator('.phone-pair-address').textContent();
  expect(address).toMatch(/^http:\/\/127\.0\.0\.2:\d+$/);
  await expect(toggle).toContainText(address);
  const cancelled = await dialog.locator('.phone-pair-code').textContent();
  await dialog.locator('.buttons button', { hasText: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  const device = { name: 'Galaxy Z Fold7', platform: 'android', model: 'SM-F966B', appVersion: '0.1.0' };
  expect((await phoneCall(`${address}/phone/v1/pair`, { method: 'POST', body: { code: cancelled, device } })).status).toBe(410);

  // Pair and send: the dialog closes when the phone pairs, and the phone is listed.
  await pairRow.click();
  await win.locator('.radio-row', { hasText: 'Pair and send my accounts and agent settings' }).click();
  await expect(dialog).toContainText('Your phone can then fetch your accounts and agent settings once, in the next 10 minutes.');
  const code = await dialog.locator('.phone-pair-code').textContent();
  const paired = await phoneCall(`${address}/phone/v1/pair`, { method: 'POST', body: { code: code.toLowerCase(), device } });
  expect(paired.status).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect(win.locator('#toast')).toContainText('Paired with Galaxy Z Fold7');
  const phoneRow = win.locator('.page.settings [data-a^="agent-phone-manage:"]');
  await expect(phoneRow).toContainText('Galaxy Z Fold7');
  await expect(phoneRow).toContainText('Can fetch your accounts and settings now');

  // The phone fetches them once: the window says so, and the row no longer offers them.
  const exported = await phoneCall(`${address}/phone/v1/export`, { token: paired.json.token });
  expect(exported.status).toBe(200);
  expect(exported.json.accounts.map((a) => a.type)).toEqual(['demo']);
  await expect(win.locator('#toast')).toContainText('Sent your accounts and settings to Galaxy Z Fold7');
  await expect(phoneRow).toContainText('Last seen');
  await expect(phoneRow).not.toContainText('Can fetch');
  expect((await phoneCall(`${address}/phone/v1/export`, { token: paired.json.token })).status).toBe(403);

  await phoneRow.click();
  await win.locator('.radio-row', { hasText: 'Send accounts and settings again' }).click();
  await expect(win.locator('#toast')).toContainText('Your phone can fetch them in the next 10 minutes');
  await expect(phoneRow).toContainText('Can fetch your accounts and settings now');

  await phoneRow.click();
  await win.locator('.radio-row', { hasText: 'Remove this phone' }).click();
  const confirm = win.locator('.dialog', { hasText: 'Galaxy Z Fold7 can no longer use this computer.' });
  await confirm.locator('.buttons button', { hasText: 'Remove' }).click();
  await expect(win.locator('#toast')).toContainText('Removed Galaxy Z Fold7');
  await expect(phoneRow).toHaveCount(0);
  expect((await phoneCall(`${address}/phone/v1/hello`, { token: paired.json.token })).status).toBe(401);

  // Off: the switch closes the listener again, since nothing else wants it.
  await toggle.click();
  await expect(toggle.locator('.switch')).not.toHaveClass(/\bon\b/);
  await expect(toggle).toContainText('Your phone runs Claude Code and Codex chats here over Tailscale.');
  expect(await app.evaluate(() => global.__semAgents.mcp.ports().remote)).toBe(null);
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

// ---------- files and emails attached to a message ----------

// Drops files on the chat panel the way Explorer does: drag events whose DataTransfer holds them. over: stop
// before the drop, with the panel showing where they go.
const dropFiles = (list, { over = false } = {}) =>
  win.evaluate(
    ({ list, over }) => {
      const dt = new DataTransfer();
      for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const target = document.querySelector('.agentpane .ap-transcript');
      for (const type of over ? ['dragenter', 'dragover'] : ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { list: list.map((f) => ({ name: f.name, type: f.type, b64: Buffer.from(f.data).toString('base64') })), over }
  );
// The files attached to the message being written; one still on its way (pending) is not one yet.
const fileChips = () => win.locator('.agentpane .bui-pb__files .bui-entity--attached:not(.is-pending)').filter({ has: win.locator('.bui-entity__badge [data-icon^="file"], .bui-entity__badge [data-icon="image"]') });
// Drags an email from the list onto the chat with the mouse. Not dragTo: the list redraws its rows whenever a
// refresh comes in (an email marked read, a setting saved), and a redraw between dragTo's checks of the row and its
// press made Playwright end the drag without a drop and without an error. The row is found, scrolled to and
// measured in one step in the page, so no redraw comes in between; the mouse then drags whatever row is under it.
async function dragToChat(subject) {
  const from = await win.evaluate((text) => {
    const row = [...document.querySelectorAll('.list-scroll .item')].find((el) => el.textContent.includes(text));
    // Instant: a smooth scroll would still be moving the row when it is measured.
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = row.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }, subject);
  const box = await transcript().boundingBox();
  await win.mouse.move(...from);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await win.mouse.up();
}
const received = (agent = 'clark') => app.evaluate((_e, agent) => global.__semAgents.adapters.get(agent).received.at(-1), agent);
const pickFilesWith = (paths) =>
  app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, paths);

test('a PDF from the paperclip or dropped on the chat goes to the agent, which reads it; a chip can be removed first', async () => {
  await openChat('Call on Thursday');
  const report = path.join(dataDir, 'Quarterly report.pdf');
  fs.writeFileSync(report, makePdf([['Quarterly report 2026', 'Revenue grew by 12%'], ['Page two']]));
  const program = path.join(dataDir, 'setup.exe');
  fs.writeFileSync(program, 'MZ');
  // The paperclip opens main's own dialog. A program is refused with a short notice, not a dialog.
  await pickFilesWith([report, program]);
  await win.click('.agentpane .bui-pb__attach');
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['Quarterly report.pdf']);
  await expect(win.locator('#toast')).toContainText("setup.exe is a program or script. Rukoo doesn't hand those to agents.");
  await expect(input()).toBeFocused();

  // Dropped from Explorer: a second PDF and a text file. A file over 10 MB never leaves the renderer.
  await dropFiles([
    { name: 'Minutes.pdf', type: 'application/pdf', data: makePdf([['Minutes of the board meeting']], { type0: true }) },
    { name: 'notes.txt', type: 'text/plain', data: Buffer.from('Remember the deadline') },
    { name: 'video.mp4', type: 'video/mp4', data: Buffer.alloc(10 * 1024 * 1024 + 1) }
  ]);
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['Quarterly report.pdf', 'Minutes.pdf', 'notes.txt']);
  await expect(win.locator('#toast')).toContainText("video.mp4 is larger than 10 MB, so it can't go to the agent.");
  await expect(pane()).not.toHaveClass(/is-drop/);
  // Files alone are a message: Send is on with an empty input.
  await expect(win.locator('.agentpane .bui-pb__send')).toBeEnabled();
  await shot('20-attachments');

  // Removed before sending: the chip goes, and so does main's copy.
  await win.locator('.agentpane .bui-pb__files').getByRole('button', { name: 'Remove notes.txt' }).click();
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['Quarterly report.pdf', 'Minutes.pdf']);
  await expect(input()).toBeFocused();
  expect(await app.evaluate(() => [...global.__semAgents.files.staged.values()].map((s) => s.name))).toEqual(['Quarterly report.pdf', 'Minutes.pdf']);

  await say('What is in these files?');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveText(['Quarterly report.pdf', 'Minutes.pdf']);
  await expect(transcript().locator('.bui-ub')).toHaveText('What is in these files?');
  await expect(fileChips()).toHaveCount(0);
  // The scripted agent reads each one with read_chat_file, as a real one would.
  await expect(transcript()).toContainText('Quarterly report.pdf starts with: Quarterly report 2026', { timeout: 10000 });
  await expect(transcript()).toContainText('Minutes.pdf starts with: Minutes of the board meeting');
  await expect(transcript().locator('.bui-tool', { hasText: 'Read an attached file' })).toBeVisible();
  const got = await received();
  expect(got.files.map((f) => [f.name, f.kind])).toEqual([['Quarterly report.pdf', 'pdf'], ['Minutes.pdf', 'pdf']]);
  expect(got.input).toMatch(/<unsafe_content source="file" file_id="f_[0-9a-f]{10}" filename="Quarterly report\.pdf">\nQuarterly report 2026\nRevenue grew by 12%\n\nPage two\n<\/unsafe_content>/);
  // Hermes runs elsewhere, so it gets no paths, only read_chat_file.
  expect(got.input).not.toContain('local copy');
  expect(got.input.endsWith('\n\nWhat is in these files?')).toBe(true);
  await settled();
  await shot('21-attachments-sent');

  // Claude Code works on this PC: it gets the copy in its working folder as well, and a picture as a picture.
  await win.click('.agentpane [data-ap="new"]');
  await win.click('.agentpane .bui-pb__modelbtn');
  await win.locator('.bui-menu .bui-menu__row', { hasText: 'Claude' }).click();
  // A pasted screenshot is attached; a paste that has text as well (a selection from Word) stays text.
  const paste = (withText) =>
    input().evaluate((ta, withText) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], 'photo.png', { type: 'image/png' }));
      if (withText) dt.setData('text/plain', 'Copied text');
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, withText);
  await paste(true);
  await expect.poll(inputValue).toBe('Copied text');
  await input().fill('');
  await paste(false);
  await pickFilesWith([report]);
  await win.click('.agentpane .bui-pb__attach');
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['photo.png', 'Quarterly report.pdf']);
  await input().press('Enter');
  await expect(transcript()).toContainText('I looked at photo.png.', { timeout: 10000 });
  const claude = await received('claude');
  const copies = claude.files.map((f) => f.path);
  expect(copies.every((p) => p.startsWith(path.join(dataDir, 'agent-workspace', 'files')) && fs.existsSync(p))).toBe(true);
  expect(claude.input).toContain(`local copy: ${copies[1]}`);
  expect(claude.files.map((f) => [f.kind, f.inline])).toEqual([['image', true], ['pdf', false]]);
  expect(claude.input).toContain('[The user sent this without a message.]');
});

test('picking more large files than a message takes stages only what it keeps, so all of those go out', async () => {
  await openChat('Call on Thursday');
  // Thirteen files just under 10 MB: together past the 120 MB Rukoo keeps for messages not yet sent.
  const big = Buffer.alloc(Math.floor(9.5 * 1024 * 1024), 1);
  const picked = Array.from({ length: 13 }, (_, i) => {
    const file = path.join(dataDir, `scan-${String(i + 1).padStart(2, '0')}.bin`);
    fs.writeFileSync(file, big);
    return file;
  });
  await pickFilesWith(picked);
  await win.click('.agentpane .bui-pb__attach');
  await expect(fileChips()).toHaveCount(10);
  await expect(fileChips().locator('.bui-entity__name').first()).toHaveText('scan-01.bin');
  await expect(win.locator('#toast')).toContainText('A message takes up to 10 files.');
  expect(await app.evaluate(() => global.__semAgents.files.staged.size)).toBe(10);
  await say('All of these');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveCount(10);
  await expect.poll(async () => ((await received()) || { files: [] }).files.length).toBe(10);
});

test('a chat started with only a file is named after it in the header straight away', async () => {
  await openChat('Call on Thursday');
  // Without the email it is a chat of its own, with no name yet.
  await win.locator('.agentpane .bui-pb__files').getByRole('button', { name: 'Leave this email out' }).click();
  await dropFiles([{ name: 'Budget 2027.xlsx', type: 'application/octet-stream', data: Buffer.from('PK') }]);
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['Budget 2027.xlsx']);
  await input().press('Enter');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveText(['Budget 2027.xlsx']);
  await expect(win.locator('.agentpane .ap-title')).toHaveText('Budget 2027.xlsx');
});

// Dropped files stay on their way until the test lets each go by name, as a large file or a slow disk would keep
// them: nothing here depends on how long a read takes. A file let go before it is read is read at once.
const holdReads = () =>
  win.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    const waiting = new Map();
    const free = new Set();
    window.__letGo = (name) => {
      free.add(name);
      for (const go of waiting.get(name) || []) go();
      waiting.delete(name);
    };
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve) => (free.has(file.name) ? resolve() : waiting.set(file.name, [...(waiting.get(file.name) || []), resolve]))).then(() => read.call(file));
    };
  });
const letGo = (name) => win.evaluate((n) => window.__letGo(n), name);
const pendingChips = () => win.locator('.agentpane .bui-pb__files .bui-entity.is-pending');
const textFile = (name) => ({ name, type: 'text/plain', data: Buffer.from(`The text of ${name}`) });
const conversations = () => app.evaluate(() => [...global.__semAgents.conversations.values()].map((c) => ({ email: c.message ? c.message.id : null, sent: c.items.filter((i) => i.type === 'user').map((i) => i.text) })));

test('nothing goes while a dropped file is still being added: Enter keeps the text, a quick action waits, and then text and file go together', async () => {
  await openChat('Call on Thursday');
  await holdReads();
  await input().fill('What is in this?');
  await dropFiles([textFile('notes.txt')]);
  // On its way: a chip at once, still busy, and Send off with the reason.
  await expect(pendingChips()).toHaveCount(1);
  await expect(pendingChips()).toHaveAttribute('aria-label', 'Adding notes.txt');
  const sendButton = win.locator('.agentpane .bui-pb__send');
  await expect(sendButton).toBeDisabled();
  await expect(sendButton).toHaveAttribute('title', 'Wait until the files are added, then send.');
  await input().press('Enter');
  await expect.poll(inputValue).toBe('What is in this?');
  await chip('Summarize').click();
  await expect(win.locator('#toast')).toContainText('Wait until the files are added, then send.');
  await expect(transcript().locator('.bui-ub')).toHaveCount(0);
  expect(await conversations()).toEqual([]);
  // There: Send is back, and Enter sends the text with the file.
  await letGo('notes.txt');
  await expect(pendingChips()).toHaveCount(0);
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['notes.txt']);
  await expect(sendButton).toBeEnabled();
  await input().press('Enter');
  await expect(transcript().locator('.bui-ub')).toHaveText('What is in this?');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveText(['notes.txt']);
  await expect.poll(async () => ((await received()) || { files: [] }).files.map((f) => f.name)).toEqual(['notes.txt']);
  await expect.poll(inputValue).toBe('');
  await expect(fileChips()).toHaveCount(0);
});

test('a message held for a file goes to the chat it is sent from, not to an email opened while the file was on its way', async () => {
  await openChat('Call on Thursday');
  const thursday = await item('Call on Thursday').getAttribute('data-id');
  await holdReads();
  await input().fill('Question for Thursday');
  await dropFiles([textFile('agenda.txt')]);
  await input().press('Enter');
  // Another email opens while the file is on its way; the draft goes along, and nothing is sent.
  await item('Your parcel is on its way').click();
  await expect(win.locator('.reader-subject')).toHaveText('Your parcel is on its way');
  await letGo('agenda.txt');
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['agenda.txt']);
  await expect.poll(inputValue).toBe('Question for Thursday');
  expect(await conversations()).toEqual([]);
  // Back on Thursday the user sends: the message and the file go to that chat.
  await item('Call on Thursday').click();
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await input().press('Enter');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveText(['agenda.txt']);
  await expect.poll(conversations).toEqual([{ email: thursday, sent: ['Question for Thursday'] }]);
  await expect.poll(async () => ((await received()) || { files: [] }).files.map((f) => f.name)).toEqual(['agenda.txt']);
});

test('a file dropped while another is still on its way goes with the same message', async () => {
  await openChat('Call on Thursday');
  await holdReads();
  await input().fill('Both of these');
  await dropFiles([textFile('first.txt')]);
  await input().press('Enter');
  await dropFiles([textFile('second.txt')]);
  await letGo('first.txt');
  // The second is still on its way: still nothing goes.
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['first.txt']);
  await expect(pendingChips()).toHaveCount(1);
  await input().press('Enter');
  await expect.poll(inputValue).toBe('Both of these');
  await letGo('second.txt');
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['first.txt', 'second.txt']);
  await input().press('Enter');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveText(['first.txt', 'second.txt']);
  await expect.poll(async () => ((await received()) || { files: [] }).files.map((f) => f.name)).toEqual(['first.txt', 'second.txt']);
  await expect(fileChips()).toHaveCount(0);
});

test('text typed while files are on their way is never lost, however often Enter is pressed', async () => {
  await openChat('Call on Thursday');
  await holdReads();
  await input().fill('First message');
  await dropFiles([textFile('slow.txt')]);
  await input().press('Enter');
  await expect.poll(inputValue).toBe('First message');
  await input().press('End');
  await input().pressSequentially(' and the second');
  await input().press('Enter');
  await expect.poll(inputValue).toBe('First message and the second');
  await letGo('slow.txt');
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['slow.txt']);
  await input().press('Enter');
  await expect(transcript().locator('.bui-ub')).toHaveText('First message and the second');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveText(['slow.txt']);
  await expect.poll(inputValue).toBe('');
});

test('picked files are read without blocking Rukoo: a slow drive leaves other requests answered at once', async () => {
  await openChat('Call on Thursday');
  const slow = path.join(dataDir, 'slow-drive.txt');
  fs.writeFileSync(slow, 'From a slow drive');
  // Opening or reading this file takes 1.5 s, whichever way it is read: the sync calls block, the async ones wait.
  // The dialog closes after 200 ms.
  await app.evaluate(({ dialog }, file) => {
    const fsm = process.mainModule.require('fs');
    const slowFile = (name) => String(name).includes('slow-drive');
    const block = () => {
      for (const end = Date.now() + 1500; Date.now() < end; );
    };
    const wait = () => new Promise((resolve) => setTimeout(resolve, 1500));
    for (const fn of ['readFileSync', 'openSync']) {
      const orig = fsm[fn];
      fsm[fn] = function (name, ...rest) {
        if (slowFile(name)) block();
        return orig.call(this, name, ...rest);
      };
    }
    for (const fn of ['readFile', 'open']) {
      const orig = fsm.promises[fn];
      fsm.promises[fn] = async function (name, ...rest) {
        if (slowFile(name)) await wait();
        return orig.call(this, name, ...rest);
      };
    }
    dialog.showOpenDialog = () => new Promise((resolve) => setTimeout(() => resolve({ canceled: false, filePaths: [file] }), 200));
  }, slow);
  await win.click('.agentpane .bui-pb__attach');
  // 400 ms later main is reading; another request still comes back at once, while the file is still on its way.
  const took = await win.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const started = performance.now();
    await window.mail.call('agentSkills');
    return performance.now() - started;
  });
  expect(took).toBeLessThan(500);
  expect(await fileChips().count()).toBe(0);
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['slow-drive.txt']);
});

test('an email that is gone takes only its own chip, and one added from another folder stays', async () => {
  await openChat('Call on Thursday');
  const names = win.locator('.agentpane .bui-pb__files .bui-entity__name');
  // One from the Sent folder (with another sent email open, so the dragged one is not the chat's own), then back to
  // the inbox for another.
  await win.click('.nav-item[data-view="sent"]');
  await item('Dinner on Saturday').click();
  await expect(win.locator('.reader-subject')).toHaveText('Dinner on Saturday');
  await dragToChat('Question about my contract');
  await win.click('.nav-item[data-view="inbox"]');
  await item('Call on Thursday').click();
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await dragToChat('Your parcel is on its way');
  await expect(names).toContainText(['Question about my contract', 'Your parcel is on its way']);
  // The parcel email is deleted before the message goes.
  const parcel = await item('Your parcel is on its way').getAttribute('data-id');
  await app.evaluate((_e, id) => global.__semEngine.remove(id), parcel);
  await say('Compare these');
  await expect(win.locator('#toast')).toContainText('An email you added is no longer here.');
  await expect(names).toContainText(['Question about my contract']);
  await expect(names.filter({ hasText: 'Your parcel is on its way' })).toHaveCount(0);
  // Sent again, the sent email goes along.
  await input().press('Enter');
  await expect.poll(async () => ((await received()) || { emails: [] }).emails.length).toBe(1);
});

test('a file that is gone takes only its own chip, and the other one still goes out', async () => {
  await openChat('Call on Thursday');
  await dropFiles([
    { name: 'first.txt', type: 'text/plain', data: Buffer.from('first') },
    { name: 'second.txt', type: 'text/plain', data: Buffer.from('second') }
  ]);
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['first.txt', 'second.txt']);
  // Main lets go of the first, as it does after two hours.
  await app.evaluate(() => {
    const files = global.__semAgents.files;
    files.unstage([...files.staged.values()].find((s) => s.name === 'first.txt').id);
  });
  await say('Both');
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['second.txt']);
  await expect(win.locator('#toast')).toContainText('1 file you attached was no longer ready to send');
  await input().press('Enter');
  await expect.poll(async () => ((await received()) || { files: [] }).files.map((f) => f.name)).toEqual(['second.txt']);
});

test('a send that fails while the files are copied keeps every chip, and sending again delivers them all', async () => {
  await openChat('Call on Thursday');
  await dropFiles([
    { name: 'a.txt', type: 'text/plain', data: Buffer.from('first') },
    { name: 'b.txt', type: 'text/plain', data: Buffer.from('second') }
  ]);
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['a.txt', 'b.txt']);
  // The disk fills up halfway through main's copy of the second file, once.
  await app.evaluate(() => {
    const fs = process.mainModule.require('fs');
    const write = fs.writeFileSync;
    let copies = 0;
    fs.writeFileSync = function (file, data, ...rest) {
      if (/[\\/]agent-workspace[\\/]files[\\/]/.test(String(file)) && !/:Zone\.Identifier$/.test(file) && ++copies === 2) {
        fs.writeFileSync = write;
        write.call(this, file, data.subarray(0, 2), ...rest);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return write.call(this, file, data, ...rest);
    };
  });
  await say('Both, please');
  await expect(win.locator('#toast')).toContainText('ENOSPC');
  // Nothing went out: the chips and the words are back, and main still has both files.
  await expect(fileChips().locator('.bui-entity__name')).toHaveText(['a.txt', 'b.txt']);
  await expect.poll(inputValue).toBe('Both, please');
  await expect(transcript().locator('.bui-ub')).toHaveCount(0);
  expect(await app.evaluate(() => [...global.__semAgents.files.staged.values()].map((s) => s.name))).toEqual(['a.txt', 'b.txt']);
  await input().press('Enter');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveText(['a.txt', 'b.txt']);
  await expect(fileChips()).toHaveCount(0);
  await expect.poll(async () => ((await received()) || { files: [] }).files.map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
});

test('two emails dragged from the list show up as chips, and the agent reads both', async () => {
  await openChat('Call on Thursday');
  const names = win.locator('.agentpane .bui-pb__files .bui-entity__name');
  await dragToChat('Your parcel is on its way');
  await dragToChat('Sign in to Bencompare');
  // The chat's own email is in it already, and an email added twice counts once.
  await dragToChat('Call on Thursday');
  await dragToChat('Sign in to Bencompare');
  await expect(names).toHaveText(['Call on Thursday', 'Your parcel is on its way', 'Sign in to Bencompare']);
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  // While something is dragged over the panel it says where it goes.
  await win.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('application/x-rukoo-ids', '[]');
    document.querySelector('.agentpane .ap-transcript').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(win.locator('.agentpane .ap-drop')).toHaveText('Drop files or emails here to add them to your message');
  await shot('22-drop-here');
  await win.evaluate(() => document.dispatchEvent(new DragEvent('dragend')));
  await expect(win.locator('.agentpane .ap-drop')).toBeHidden();
  await shot('23-emails-attached');

  // A third one can go again before sending; by keyboard, its x is a button.
  await dragToChat('Your password has changed');
  const third = win.locator('.agentpane .bui-pb__files').getByRole('button', { name: 'Remove Your password has changed' });
  await third.focus();
  await win.keyboard.press('Enter');
  await expect(names).toHaveText(['Call on Thursday', 'Your parcel is on its way', 'Sign in to Bencompare']);
  await expect(input()).toBeFocused();

  // Sent with no text: the emails are the message.
  await input().press('Enter');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveText(['Your parcel is on its way', 'Sign in to Bencompare']);
  await expect(transcript().locator('.bui-ub')).toHaveCount(0);
  await expect(transcript()).toContainText('The email "Your parcel is on its way" is from', { timeout: 10000 });
  await expect(transcript()).toContainText('The email "Sign in to Bencompare" is from');
  const got = await received();
  const ids = await win.evaluate(() => ['Your parcel is on its way', 'Sign in to Bencompare'].map((s) => [...document.querySelectorAll('.item')].find((el) => el.textContent.includes(s)).dataset.id));
  expect(got.emails).toEqual(ids);
  expect(got.input).toContain('[The user attached 2 emails to this message. Read them with read_message.]');
  expect(got.input).toContain(`- id ${ids[0]}: <unsafe_content source="email subject">Your parcel is on its way</unsafe_content>`);
  await settled();
  await shot('24-emails-sent');
});

test('an attached email archived after Send still reads with the id the agent got, after a restart too, and a new session gets the id it has now', async () => {
  await openChat('Call on Thursday');
  await dragToChat('Your parcel is on its way');
  await say('Compare these');
  await expect(transcript()).toContainText('The email "Your parcel is on its way" is from', { timeout: 10000 });
  const [given] = (await received()).emails;
  const cid = await conversationId();

  // Archived from the toolbar with the chat closed. The id the agent got names nothing now.
  await input().focus();
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeHidden();
  await item('Your parcel is on its way').click();
  await expect(win.locator('.reader-subject')).toHaveText('Your parcel is on its way');
  await win.click('[data-reader="archive"]');
  await expect(win.locator('#toast')).toContainText('Archive');
  await expect(win.locator('.item', { hasText: 'Your parcel is on its way' })).toHaveCount(0);
  const unbound = await app.evaluate(async (_e, id) => {
    const res = await global.__semAgents.callTool({ agent: 'clark', conversationId: null, remote: false }, 'read_message', { message_id: id }, {});
    return res.isError ? res.content[0].text : null;
  }, given);
  expect(unbound).toMatch(/Ids change when mail moves/);

  // Back in the chat, the agent reads it with the id it got.
  const reads = () => transcript().evaluate((el) => el.innerText.split('The email "Your parcel is on its way" is in Archive now.').length - 1);
  await openChat('Call on Thursday');
  await say('Read them again');
  await expect.poll(reads, { timeout: 10000 }).toBe(1);
  await settled();
  await shot('27-attached-email-archived');

  // Rukoo restarts. The message kept the email's Message-ID, so the old id still reads.
  await app.close();
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await item('Call on Thursday').click();
  if (!(await pane().isVisible())) await win.keyboard.press('Control+j');
  await expect(transcript().locator('.bui-ubatt .bui-entity__name')).toHaveText(['Your parcel is on its way']);
  await say('Read them again');
  await expect.poll(reads, { timeout: 10000 }).toBe(2);
  const now = (await tool(cid, 'read_message', { message_id: given })).data;
  expect(now.folder).toBe('Archive');
  expect(now.id).not.toBe(given);

  // A lost session: the recap names the email by the id it has now.
  await say('Did you keep a lost session?');
  await expect(transcript()).toContainText('I started a new session. Rukoo sent me the email and a recap of our chat.', { timeout: 10000 });
  const recap = (await received()).input;
  expect(recap).toContain(`User: Compare these [attached: the email "Your parcel is on its way" (id ${now.id})]`);
  expect(recap).not.toContain(given);
  await settled();
  await shot('28-attached-email-new-session');
});

test('the newer email a chat was continued from, dropped on the chat, is not added to the message again', async () => {
  await win.click('[data-view="sent"]');
  await openChat('Dinner on Saturday');
  await say('Did Joris answer?');
  await expect(transcript()).toContainText('You asked: "Did Joris answer?"', { timeout: 10000 });
  await win.click('[data-view="inbox"]');
  await item('Re: Dinner on Saturday').click();
  await win.locator('.agentpane .bui-offer').click();
  const names = win.locator('.agentpane .bui-pb__files .bui-entity__name');
  await expect(names).toHaveText(['Dinner on Saturday', 'Re: Dinner on Saturday']);
  // The answer goes with the next message as the newer email already; another email is added as usual.
  await dragToChat('Re: Dinner on Saturday');
  await dragToChat('Your parcel is on its way');
  await expect(names).toHaveText(['Dinner on Saturday', 'Re: Dinner on Saturday', 'Your parcel is on its way']);
  await say('What did he say?');
  await expect.poll(async () => ((await received()) || {}).text).toBe('What did he say?');
  const got = await received();
  expect(got.emails).toEqual([await item('Your parcel is on its way').getAttribute('data-id')]);
  expect(got.input).toContain('Great, I will book a table for 19:30.');
  expect(got.input).toContain('[The user attached an email to this message. Read it with read_message.]');
});

test('an email the list shows twice, under two ids, is added to the message once, and a copy of the chat own email not at all', async () => {
  await openChat('Call on Thursday');
  const names = win.locator('.agentpane .bui-pb__files .bui-entity__name');
  // A second copy of two emails in the inbox, under new ids with the same Message-ID, as Inbox and Sent of a mail to
  // yourself or two Gmail labels give.
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const box = engine.caches.get(engine.accounts[0].id).boxes.INBOX;
    for (const [subject, uid] of [['Your parcel is on its way', 90001], ['Call on Thursday', 90002]]) {
      box.messages.push({ ...structuredClone(box.messages.find((m) => m.subject === subject)), uid });
    }
    engine.emit('updated');
  });
  const idsOf = (subject) => win.evaluate((subject) => [...document.querySelectorAll('.list-scroll .item')].filter((el) => el.textContent.includes(subject)).map((el) => el.dataset.id), subject);
  await expect.poll(async () => (await idsOf('Your parcel is on its way')).length).toBe(2);
  const ids = [...(await idsOf('Your parcel is on its way')), ...(await idsOf('Call on Thursday'))];
  expect(ids).toHaveLength(4);
  // All four dropped on the chat at once, as when they are checked and dragged.
  await win.evaluate((ids) => {
    const dt = new DataTransfer();
    dt.setData('application/x-rukoo-ids', JSON.stringify(ids));
    const target = document.querySelector('.agentpane .ap-transcript');
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, ids);
  await expect(names).toHaveText(['Call on Thursday', 'Your parcel is on its way']);
});

// Goes down the open menu with the arrow keys to the item, and picks it with Enter.
async function choose(label) {
  await expect(win.locator('.menu')).toBeVisible();
  for (let i = 0; i < 20; i++) {
    if ((await win.evaluate(() => document.activeElement?.querySelector('.ml')?.textContent || '')) === label) return win.keyboard.press('Enter');
    await win.keyboard.press('ArrowDown');
  }
  throw new Error(`no ${label} in the menu`);
}

test('emails go into the chat by keyboard as well: Add to chat in the menu for checked emails and in an email menu', async () => {
  const names = win.locator('.agentpane .bui-pb__files .bui-entity__name');
  // The chat is closed. The email on screen and the one below it are checked with the keyboard, and the menu for
  // checked emails adds them: the chat opens on the email on screen, which is its own, and the other one goes along.
  await item('Call on Thursday').click();
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await expect(pane()).toBeHidden();
  const below = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.list-scroll .item')];
    const at = rows.findIndex((el) => el.textContent.includes('Call on Thursday'));
    return rows[at + 1].querySelector('.subject').textContent;
  });
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('Shift+ArrowDown');
  await expect(win.locator('.sel-count')).toHaveText('2 selected');
  await win.locator('.list-tools [data-bulk="more"]').focus();
  await win.keyboard.press('Enter');
  await choose('Add to chat');
  await expect(pane()).toBeVisible();
  await expect(names).toHaveText(['Call on Thursday', below]);
  await expect(input()).toBeFocused();
  await settled();
  await shot('26-add-to-chat');

  // In the menu of the email on screen it is the chat's own, so nothing is added twice, and the notice says why.
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('Escape');
  await expect(win.locator('.list-tools.selecting')).toHaveCount(0);
  await win.locator('[data-reader="more"]').focus();
  await win.keyboard.press('Enter');
  await choose('Add to chat');
  await expect(win.locator('#toast')).toContainText('That email is in the chat already.');
  await expect(names).toHaveText(['Call on Thursday', below]);

  // Sent, the agent gets the one email.
  await input().press('Enter');
  await expect.poll(async () => ((await received()) || { emails: [] }).emails.length).toBe(1);
});

test('Add to chat just after another email opens goes to the chat for that email, not the one before', async () => {
  const names = win.locator('.agentpane .bui-pb__files .bui-entity__name');
  await openChat('Call on Thursday');
  await expect(names).toHaveText(['Call on Thursday']);
  // An open panel follows a newly opened email a moment later (agentViewChanged's timer). Held back here, so the
  // moment lasts: only Add to chat can make the panel follow.
  await win.evaluate(() => {
    const later = window.setTimeout;
    window.__setTimeout = later;
    window.setTimeout = (fn, ms, ...rest) => (String(fn).includes("'agentView'") ? 0 : later(fn, ms, ...rest));
  });
  await item('Your parcel is on its way').click();
  await expect(win.locator('.reader-subject')).toHaveText('Your parcel is on its way');
  await expect(names).toHaveText(['Call on Thursday']);
  await win.locator('[data-reader="more"]').focus();
  await win.keyboard.press('Enter');
  await choose('Add to chat');
  // The panel now shows the chat for the parcel email, whose own email it is: nothing goes to the chat before.
  await expect(names).toHaveText(['Your parcel is on its way']);
  await expect(win.locator('#toast')).toContainText('That email is in the chat already.');
  await win.evaluate(() => (window.setTimeout = window.__setTimeout));
  await item('Call on Thursday').click();
  await expect(names).toHaveText(['Call on Thursday']);
});

test('the paperclip and chips fit next to the agent, model and effort menus from 320 to 560 px', async () => {
  await openChat('Call on Thursday');
  await win.click('.agentpane .bui-pb__modelbtn');
  await win.locator('.bui-menu .bui-menu__row', { hasText: 'Claude' }).click();
  await win.click('.agentpane .bui-pb__opt[data-pick="model"]');
  await win.locator('.bui-menu .bui-menu__row', { hasText: 'Sonnet' }).click();
  await dropFiles([{ name: 'A very long file name for the quarterly report of 2026.pdf', type: 'application/pdf', data: makePdf([['x']]) }]);
  await dragToChat('Your parcel is on its way');
  for (const width of [320, 400, 560]) {
    await win.evaluate((w) => document.documentElement.style.setProperty('--agent-w', `${w}px`), width);
    await expect.poll(() => win.evaluate(() => Math.round(document.querySelector('.agentpane').getBoundingClientRect().width))).toBe(width);
    const fit = await win.evaluate(() => {
      const box = document.querySelector('.agentpane .bui-pb__box').getBoundingClientRect();
      const inside = (el) => {
        const r = el.getBoundingClientRect();
        return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
      };
      const row = document.querySelector('.agentpane .bui-pb__row');
      return {
        row: row.scrollWidth <= row.clientWidth + 1,
        chips: [...document.querySelectorAll('.agentpane .bui-pb__attach, .agentpane .bui-pb__files .bui-entity')].every(inside),
        controls: [...row.children].filter((el) => !el.hidden).every(inside)
      };
    });
    expect(fit, `${width} px`).toEqual({ row: true, chips: true, controls: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    await pane().screenshot({ path: path.join(SHOTS, `25-attachments-${width}.png`) });
  }
});

test("$ offers the agent's own skills: Hermes' from its server, Claude Code's and Codex's from their setup; a picked skill goes with the message", async () => {
  await openChat('Call on Thursday');
  const rows = win.locator('.agentpane .bui-pb__cmd');
  const names = win.locator('.agentpane .bui-pb__cmdname');
  await input().fill('$');
  await expect(win.locator('.agentpane .bui-pb__heading')).toHaveText("Hermes's skills");
  await expect(names).toHaveText(['$meeting-prep', '$invoice-check', '$crm-update']);
  await expect(rows.first().locator('.bui-pb__cmdtag')).toHaveText('productivity');
  await settled();
  await shot('30-skills-dollar');

  // Typing narrows the list down; Enter puts the skill in the message instead of sending it.
  await input().fill('Please $inv');
  await expect(names).toHaveText(['$invoice-check']);
  await input().press('Enter');
  await expect.poll(inputValue).toBe('Please $invoice-check ');
  // It goes in as t3code shows a skill: a chip with the box and its name in words.
  await expect(input().locator('.bui-skill')).toHaveText('Invoice Check');
  await expect(input().locator('.bui-skill')).toHaveAttribute('aria-label', 'Skill Invoice Check');
  await expect(rows).toHaveCount(0);
  await expect(transcript().locator('.bui-ub')).toHaveCount(0);
  await shot('32-skill-chip');
  // Typed, a name becomes a chip once a space follows it. Backspace takes the chip whole; Ctrl+Z brings it back.
  await input().fill('');
  await input().pressSequentially('Then $crm-update');
  await expect(input().locator('.bui-skill')).toHaveCount(0);
  await input().pressSequentially(' ');
  await expect(input().locator('.bui-skill')).toHaveText('Crm Update');
  await expect.poll(inputValue).toBe('Then $crm-update ');
  await input().press('Backspace');
  await input().press('Backspace');
  await expect(input().locator('.bui-skill')).toHaveCount(0);
  await expect.poll(inputValue).toBe('Then ');
  await input().press('Control+z');
  await expect(input().locator('.bui-skill')).toHaveText('Crm Update');
  await expect.poll(inputValue).toBe('Then $crm-update ');
  // Typing somewhere else is an undo step of its own, as in a textarea.
  await input().fill('');
  await input().pressSequentially('hello');
  await input().press('Home');
  await input().pressSequentially('X');
  await input().press('Control+z');
  await expect.poll(inputValue).toBe('hello');
  // A description matches too, after the names.
  await input().fill('$quote');
  await expect(names).toHaveText(['$invoice-check']);
  // An amount opens nothing, and / still offers the shortcuts and Rukoo's skills, not the agent's.
  await input().fill('It costs $5');
  await expect(win.locator('.agentpane .bui-pb__menu')).toHaveCount(0);
  await input().fill('/');
  await expect(names.first()).toHaveText('/reply');
  await expect(win.locator('.agentpane .bui-pb__cmdname', { hasText: '$' })).toHaveCount(0);

  await input().fill('Please $invoice-check for this email');
  await expect(input().locator('.bui-skill')).toHaveText('Invoice Check');
  await input().press('Enter');
  // The message shows the skill as the chip it was; the agent gets $name.
  await expect(transcript().locator('.bui-ub')).toHaveText('Please Invoice Check for this email');
  await expect(transcript().locator('.bui-ub .bui-skill[data-skill="invoice-check"]')).toBeVisible();
  await expect(transcript()).toContainText('Started $invoice-check.', { timeout: 10000 });
  const got = await received('clark');
  expect(got.skills).toEqual([{ name: 'invoice-check' }]);
  expect(got.text).toBe('Please $invoice-check for this email');

  // Another agent: its own skills, a plugin skill under its plugin's name.
  await win.click('.agentpane [data-ap="new"]');
  await win.click('.agentpane .bui-pb__modelbtn');
  await win.locator('.bui-menu .bui-menu__row', { hasText: 'Claude' }).click();
  await input().fill('$');
  await expect(win.locator('.agentpane .bui-pb__heading')).toHaveText("Claude's skills");
  await expect(names).toHaveText(['$humanizer', '$pdf', '$codex:rescue']);
  await input().fill('$res');
  await expect(names).toHaveText(['$codex:rescue']);
  await input().press('Tab');
  await expect.poll(inputValue).toBe('$codex:rescue ');
  await expect(input().locator('.bui-skill')).toHaveText('Codex Rescue');
  // Hermes does not have it: switching agents makes the chip text again.
  await win.click('.agentpane .bui-pb__modelbtn');
  await win.locator('.bui-menu .bui-menu__row', { hasText: 'Hermes' }).click();
  await expect(input().locator('.bui-skill')).toHaveCount(0);
  await expect.poll(inputValue).toBe('$codex:rescue ');
});

test('shortcuts: the user hides, orders, edits and adds them in Settings; new chats follow, with every agent, after a restart too', async () => {
  const closeSettings = async () => {
    while (await win.locator('.page.settings').count()) await win.keyboard.press('Escape');
  };
  // Functions, so they find the window again after the restart.
  const chips = () => win.locator('.agentpane .ap-actions .bui-sugg__chip:not(.bui-sugg__edit)');
  await openChat('Call on Thursday');
  await expect(chips()).toHaveText(['Draft a reply', 'Brief me', 'Plan follow-ups', 'Tell the team', 'Update systems', 'Summarize']);

  // The round chip after the shortcuts opens their page.
  await win.click('.agentpane .bui-sugg__edit');
  await expect(win.locator('.page.settings h1')).toHaveText('Shortcuts');
  const rows = () => win.locator('.page.settings .shortcut-row .shortcut-main .title');
  await expect(rows()).toHaveText(['Draft a reply', 'Brief me', 'Plan follow-ups', 'Tell the team', 'Update systems', 'Unsubscribe', 'Summarize', 'What needs me today?']);
  await win.screenshot({ path: path.join(SHOTS, '31-shortcuts-settings.png') });

  // Off, and up twice: the page redraws in place and keeps the focus on the control.
  await win.click('.page.settings [data-a="sc-show:team"]');
  await expect(win.locator('.page.settings [data-a="sc-show:team"]')).toHaveAttribute('aria-checked', 'false');
  await win.click('.page.settings [data-a="sc-up:summary"]');
  await expect(win.locator('.page.settings [data-a="sc-up:summary"]')).toBeFocused();
  await win.keyboard.press('Enter');
  await expect(rows()).toHaveText(['Draft a reply', 'Brief me', 'Plan follow-ups', 'Tell the team', 'Summarize', 'Update systems', 'Unsubscribe', 'What needs me today?']);
  await expect(win.locator('.page.settings [data-a="sc-up:summary"]')).toBeFocused();

  // One of Rukoo's gets its own name; its command stays.
  await win.click('.page.settings [data-a="sc-edit:reply"]');
  await expect(win.locator('.dialog [name="key"]')).toBeDisabled();
  await win.locator('.dialog [name="label"]').fill('Answer');
  await win.click('.dialog .buttons button:last-child');
  await expect(rows().first()).toHaveText('Answer');
  await expect(win.locator('.page.settings .shortcut-row').first().locator('.desc')).toHaveText('/reply · With an open email · Edited');

  // A shortcut of the user's own, for every new chat.
  await win.click('.page.settings [data-a="sc-add"]');
  await expect(win.locator('.dialog h2')).toHaveText('New shortcut');
  await win.click('.dialog .buttons button:last-child');
  await expect(win.locator('.dialog [data-error]')).toHaveText('Give the shortcut a name.');
  await win.locator('.dialog [name="label"]').fill('Follow up');
  await win.locator('.dialog [name="key"]').fill('reply');
  await win.locator('.dialog [name="prompt"]').fill('Plan a follow-up call about this email and propose a time with propose_action.');
  await win.click('.dialog .buttons button:last-child');
  await expect(win.locator('.dialog [data-error]')).toHaveText('/reply is already a command.');
  await win.locator('.dialog [name="key"]').fill('follow-up');
  await win.click('.dialog [data-when="always"]');
  await win.click('.dialog [data-icon="calendar"]');
  await win.screenshot({ path: path.join(SHOTS, '32-shortcut-new.png') });
  await win.click('.dialog .buttons button:last-child');
  await expect(rows().last()).toHaveText('Follow up');
  await expect(win.locator('.page.settings .shortcut-row').last().locator('.desc')).toHaveText('/follow-up · Always');

  await closeSettings();
  await expect(chips()).toHaveText(['Answer', 'Brief me', 'Plan follow-ups', 'Summarize', 'Update systems', 'Follow up']);
  await expect(win.locator('.agentpane .ap-actions [data-icon="calendar"]')).toHaveCount(1);
  await settled();
  await shot('33-shortcuts-chips');
  // A hidden shortcut keeps its command.
  await input().fill('/te');
  await expect(win.locator('.agentpane .bui-pb__cmdname')).toHaveText(['/team']);
  await input().fill('/fol');
  await expect(win.locator('.agentpane .bui-pb__cmdname')).toHaveText(['/follow-up']);
  await input().fill('');

  // The user's shortcut sends its instructions; the bubble shows its name.
  await chips().filter({ hasText: 'Follow up' }).click();
  await expect(transcript().locator('.bui-ub')).toHaveText('Follow up');
  await expect.poll(async () => ((await received('clark')) || {}).action).toBe('shortcut');
  expect((await received('clark')).text).toBe('Plan a follow-up call about this email and propose a time with propose_action.');

  // With no email in the chat the shortcut for always is there, next to the inbox overview; so it is with Claude.
  await win.click('.agentpane [data-ap="new"]');
  await win.click('.agentpane .bui-entity__x');
  await win.click('.agentpane .bui-pb__modelbtn');
  await win.locator('.bui-menu .bui-menu__row', { hasText: 'Claude' }).click();
  await expect(chips()).toHaveText(['What needs me today?', 'Follow up']);

  // After a restart it is all still there.
  await app.close();
  await launch();
  await item('Call on Thursday').click();
  if (!(await pane().isVisible())) await win.keyboard.press('Control+j');
  // The email has the chat from before; a new one shows the shortcuts.
  await expect(transcript().locator('.bui-ub')).toHaveText('Follow up');
  await win.click('.agentpane [data-ap="new"]');
  await expect(chips()).toHaveText(['Answer', 'Brief me', 'Plan follow-ups', 'Summarize', 'Update systems', 'Follow up']);

  // Restoring brings Rukoo's own back, in their own order.
  await win.click('.agentpane .bui-sugg__edit');
  await win.click('.page.settings [data-a="sc-reset"]');
  await win.click('.dialog .buttons button:last-child');
  await expect(rows()).toHaveText(['Draft a reply', 'Brief me', 'Plan follow-ups', 'Tell the team', 'Update systems', 'Unsubscribe', 'Summarize', 'What needs me today?']);
  await closeSettings();
  await expect(chips()).toHaveText(['Draft a reply', 'Brief me', 'Plan follow-ups', 'Tell the team', 'Update systems', 'Summarize']);
});
