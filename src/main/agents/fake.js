'use strict';

// A deterministic stand-in for all three agents, used when SEM_AGENT_FAKE=1 (e2e tests, screenshots).
// It calls Rukoo's real tool handlers through hub.callTool, the same code the MCP server runs.

const { untag } = require('./context');

const STEP_CHARS = 6;
const STEP_MS = 30;

const STOPPED = Symbol('stopped');

const ECHO_TAIL =
  'This is the fake agent. It answers every message with a short, fixed reply so tests and screenshots ' +
  'have something real to show. It streams six characters every thirty milliseconds, the way a model ' +
  'would, and it stops as soon as you press stop.';

// "long command": a 900-character command, so tests can check that approval cards never clip it.
// It ends in LONG_COMMAND_TAIL, which only shows once the card is expanded.
const LONG_COMMAND_TAIL = '" --priority 1 --end-of-command';
const LONG_COMMAND = (
  'td add "Send proposal" --due friday --project Sales --label follow-up --note "' +
  'Call Sanne on Thursday at 10:00 about proposal v3 and confirm the pricing table with Joris. '.repeat(12)
).slice(0, 900 - LONG_COMMAND_TAIL.length) + LONG_COMMAND_TAIL;

// "markdown": bold, italic, a list, a code span, a link and a bare URL.
const MARKDOWN_REPLY =
  'Here is the **plan** for *Thursday*:\n\n' +
  '- Confirm the call at `10:00`\n' +
  '- Review [the proposal](https://example.com/proposal-v3)\n' +
  '- Send notes to Joris\n\n' +
  'The agenda is at https://example.com/agenda.';

// What each agent's model menu offers, in the shape the real adapters' models() return: Claude's aliases, two
// Codex models whose efforts differ, and Hermes models of two providers plus a route alias.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = {
  claude: {
    models: [
      { id: 'fable', label: 'Fable', efforts: LEVELS },
      { id: 'opus', label: 'Opus', efforts: LEVELS },
      { id: 'sonnet', label: 'Sonnet', efforts: LEVELS }
    ],
    efforts: LEVELS,
    custom: LEVELS
  },
  codex: {
    models: [
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: [...LEVELS, 'ultra'], defaultEffort: 'medium' },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: ['low', 'medium', 'high'], defaultEffort: 'low' }
    ],
    efforts: ['low', 'medium', 'high'],
    custom: []
  },
  clark: {
    models: [
      { id: 'anthropic::claude-opus-5-5', label: 'claude-opus-5-5', group: 'Anthropic', efforts: LEVELS, isDefault: true },
      { id: 'openrouter::openai/gpt-6-astra', label: 'openai/gpt-6-astra', group: 'OpenRouter', efforts: LEVELS },
      { id: 'openrouter::mistral/small-4', label: 'mistral/small-4', group: 'OpenRouter', efforts: [] },
      { id: 'quick', label: 'quick', tag: 'mistral/small-4', route: true, efforts: LEVELS }
    ],
    efforts: LEVELS,
    custom: LEVELS
  }
};

class FakeAdapter {
  // scale multiplies every delay; tests pass a small value to run the same scripts quickly.
  constructor({ id, hub, scale } = {}) {
    this.id = id;
    this.hub = hub;
    const env = process.env.SEM_AGENT_FAKE_SCALE ? Number(process.env.SEM_AGENT_FAKE_SCALE) : NaN;
    this.scale = Number.isFinite(scale) ? scale : Number.isFinite(env) ? env : 1;
    // What each turn handed the agent, newest last, so tests can check the exact text and the chat's model and effort.
    this.received = [];
  }

  async status() {
    return { state: 'ready', detail: 'Fake agent (SEM_AGENT_FAKE=1)' };
  }

  async models() {
    return JSON.parse(JSON.stringify(MODELS[this.id] || MODELS.claude));
  }

  async dispose() {}

  async runTurn(turn) {
    this.received.push({ conversationId: turn.conversation.id, input: turn.input, text: turn.text, action: turn.action, instructions: turn.instructions, model: turn.model || null, effort: turn.effort || null });
    if (this.received.length > 20) this.received.shift();
    const run = new FakeRun(this, turn);
    try {
      return (await run.play()) || { status: 'done' };
    } catch (err) {
      if (err === STOPPED || turn.signal.aborted) return { status: 'stopped' };
      return { status: 'error', error: { code: 'unknown', detail: (err && err.message) || String(err) } };
    }
  }
}

class FakeRun {
  constructor(adapter, turn) {
    this.adapter = adapter;
    this.hub = adapter.hub;
    this.turn = turn;
    this.cid = turn.conversation.id;
    this.toolCount = 0;
  }

  check() {
    if (this.turn.signal.aborted) throw STOPPED;
  }

  sleep(ms) {
    this.check();
    return new Promise((resolve, reject) => {
      const done = () => {
        this.turn.signal.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms * this.adapter.scale));
      const abort = () => {
        clearTimeout(timer);
        reject(STOPPED);
      };
      this.turn.signal.addEventListener('abort', abort, { once: true });
    });
  }

  async think(summary, ms) {
    this.turn.emit({ type: 'thinking', delta: summary });
    await this.sleep(ms);
    this.turn.emit({ type: 'thinking-done' });
  }

  async say(text) {
    for (let i = 0; i < text.length; i += STEP_CHARS) {
      this.check();
      this.turn.emit({ type: 'text', delta: text.slice(i, i + STEP_CHARS) });
      await this.sleep(STEP_MS);
    }
  }

  // Runs one of Rukoo's tools with tool-start/tool-end around it, like a real agent's MCP call.
  async tool(name, args = {}) {
    this.check();
    const key = `fake-${++this.toolCount}`;
    const detail = args.query || args.title || args.action || '';
    this.turn.emit({ type: 'tool-start', key, name: `mcp__rukoo__${name}`, detail });
    const identity = { agent: this.adapter.id, conversationId: this.cid, remote: false };
    const res = await this.hub.callTool(identity, name, { conversation_id: this.cid, ...args }, {});
    this.turn.emit({ type: 'tool-end', key, error: Boolean(res.isError) });
    this.check();
    if (res.isError) return { error: (res.content && res.content[0] && res.content[0].text) || 'tool failed' };
    return res.structuredContent || {};
  }

  email(ctx) {
    return (ctx && (ctx.chat_message || ctx.open_message)) || null;
  }

  // Names and subjects in tool results are tagged as email; like a real agent, the fake reads through the tags.
  firstName(m) {
    const name = untag(m && m.from && (m.from.name || m.from.address)) || 'them';
    return name.split(/[\s@]/)[0];
  }

  async messageId() {
    // A chat about an email never falls back to another open email, like write_draft.
    const c = this.turn.conversation;
    return c.message ? this.hub.currentMessageId(c) : this.hub.openMessageId();
  }

  async play() {
    const action = this.turn.action;
    const text = String(this.turn.text || '');
    const lower = text.toLowerCase();
    if (action === 'approved' || /^approved:/i.test(text)) return this.followUp();
    const byAction = { reply: 'reply', brief: 'brief', tasks: 'tasks', team: 'team', unsubscribe: 'unsubscribe', triage: 'triage', summary: 'summary', update: 'update' };
    if (byAction[action]) return this[byAction[action]]();
    if (action === 'skill') return this.skill(text);
    if (/\blost session\b/.test(lower)) return this.lostSession();
    if (/\bwhich model\b/.test(lower)) return this.say(`Model: ${this.turn.model || 'default'}. Effort: ${this.turn.effort || 'default'}.`);
    if (/\blong command\b/.test(lower)) return this.approval(LONG_COMMAND);
    if (/\bmarkdown\b/.test(lower)) return this.markdown();
    if (/\bapproval\b/.test(lower)) return this.approval();
    if (/\berror\b/.test(lower)) return this.error();
    if (/reply/.test(lower)) return this.reply();
    return this.echo(text);
  }

  async reply() {
    await this.think('Reading the thread and checking what we agreed earlier.', 600);
    const ctx = await this.tool('get_context');
    const name = this.firstName(this.email(ctx));
    await this.tool('search_mail', { query: name === 'them' ? '' : name, limit: 5 });
    await this.say(`I checked your earlier mail with ${name} and kept the reply short. `);
    const res = await this.tool('write_draft', {
      body: `Hi ${name},\n\nThursday at 10:00 works for me. I'll call you then.\n\nBest,\nDemo`
    });
    if (res.error) return this.say(`I could not put the draft in the composer: ${res.error}`);
    return this.say('Done. The draft is in the composer.');
  }

  async brief() {
    const ctx = await this.tool('get_context');
    const m = this.email(ctx);
    const name = this.firstName(m);
    const found = await this.tool('search_mail', { query: name === 'them' ? '' : name, limit: 5 });
    const other = ((found && found.results) || []).find((r) => !m || r.id !== m.id) || ((found && found.results) || [])[0];
    const sources = [];
    if (other) sources.push({ title: other.subject || '(no subject)', source: 'Email', snippet: other.preview, message_id: other.id });
    sources.push(
      { title: `${name} (CRM)`, source: 'CRM', snippet: 'Prospect since March. Proposal v3 went out last week.', url: 'https://crm.example.com/contacts/sanne' },
      { title: 'Call notes', source: 'Obsidian', snippet: 'Wants a decision on the proposal before the end of the month.', url: 'obsidian://open?vault=Personal&file=Call%20notes' }
    );
    await this.tool('show_sources', { title: 'What I used', sources });
    return this.say(
      `${name} wants a call on Thursday at 10:00 about the proposal. You already said yes to that time in your earlier reply. ` +
        'Open question: whether version 3 of the proposal is final. Decide that before the call.'
    );
  }

  async tasks() {
    await this.tool('show_plan', {
      title: 'Follow-ups',
      tasks: [
        { id: 't1', title: 'Confirm the call on Thursday at 10:00', system: 'Email', status: 'done', url: 'https://example.com/calendar/thursday' },
        { id: 't2', title: 'Review Proposal-v3.pdf', system: 'Todoist', owner: 'You', due: 'Wednesday', status: 'proposed' },
        { id: 't3', title: 'Send notes to Joris after the call', system: 'Todoist', owner: 'You', due: 'Friday', status: 'proposed' }
      ]
    });
    await this.say('Two of these belong in Todoist. ');
    await this.tool('propose_action', {
      title: 'Add 2 tasks to Todoist',
      detail: 'Review Proposal-v3.pdf (due Wednesday) and send notes to Joris after the call (due Friday).',
      fields: [
        { label: 'Task', value: 'Review Proposal-v3.pdf, due Wednesday' },
        { label: 'Task', value: 'Send notes to Joris after the call, due Friday' }
      ],
      confirm_label: 'Add tasks'
    });
    return this.say("I'll add them once you approve.");
  }

  async update() {
    await this.tool('show_plan', {
      title: 'Updates',
      tasks: [
        { id: 'u1', title: 'Log the call request on the contact', system: 'CRM', status: 'proposed' },
        { id: 'u2', title: 'Add a note with the proposal status', system: 'Obsidian', status: 'proposed' }
      ]
    });
    await this.tool('propose_action', { title: 'Update 2 systems', detail: 'CRM contact and the Obsidian note for this email.', confirm_label: 'Update' });
    return this.say("I'll make these updates once you approve.");
  }

  async team() {
    const ctx = await this.tool('get_context');
    const m = this.email(ctx);
    await this.tool('propose_action', {
      title: 'Send a Slack message to #sales',
      detail: `${this.firstName(m)} asks for a call on Thursday at 10:00 about proposal v3. Message-ID ${(m && m.message_id_header) || 'unknown'}.`,
      fields: [{ label: 'Channel', value: '#sales' }],
      confirm_label: 'Send'
    });
    return this.say("I'll post it once you approve.");
  }

  async unsubscribe() {
    const id = await this.messageId();
    if (!id) return this.say('Open the newsletter first, then ask again.');
    const res = await this.tool('mail_action', { action: 'unsubscribe', message_ids: [id] });
    if (res.error) return this.say(`That did not work: ${res.error}`);
    return this.say('Rukoo will ask you before it unsubscribes.');
  }

  async triage() {
    const found = await this.tool('search_mail', { folder: 'inbox', unread: true, limit: 4 });
    const results = (found && found.results) || [];
    if (results.length) {
      await this.tool('show_sources', {
        title: 'Needs you today',
        sources: results.map((r) => ({ title: r.subject || '(no subject)', source: 'Email', snippet: r.preview, message_id: r.id }))
      });
    }
    const lines = results.map((r, i) => `${i + 1}. ${untag(r.subject)} (${untag(r.from && (r.from.name || r.from.address))})`);
    return this.say(lines.length ? `Most urgent first:\n${lines.join('\n')}` : 'Nothing in your inbox needs you today.');
  }

  // A skill the user started: read it like a real agent would, then say which one and how it starts.
  async skill(text) {
    const name = (/^\[The user started the skill "([a-z0-9-]+)"/.exec(text) || [])[1];
    if (!name) return this.say('I did not get a skill name.');
    const res = await this.tool('read_skill', { name });
    if (res.error) return this.say(`I could not read the skill: ${res.error}`);
    const first = String(res.skill_md || '').split('---').slice(2).join('---').trim().split('\n')[0] || '';
    return this.say(`Following the skill ${name}. It starts with: ${first}`);
  }

  async summary() {
    await this.think('Reading the email.', 300);
    return this.say('- Sanne asks for a call on Thursday at 10:00.\n- She attached Proposal-v3.pdf.\n- Joris is in cc.\n\nIt needs a short reply from you, today.');
  }

  // A Claude-style Bash approval. The card gets the full command, however long.
  async approval(command = 'td add "Send proposal" --due friday') {
    const key = `fake-${++this.toolCount}`;
    this.turn.emit({ type: 'tool-start', key, name: 'Bash', detail: command });
    const choice = await this.turn.approve({
      title: 'Run a command',
      fields: [{ key: 'command', label: 'Command', value: command }],
      tool: { name: 'Bash', kind: 'command' },
      choices: [
        { id: 'allow', label: 'Allow', kind: 'primary' },
        { id: 'deny', label: 'Deny', kind: 'danger' }
      ]
    });
    this.check();
    this.turn.emit({ type: 'tool-end', key, error: choice !== 'allow' });
    if (choice === 'allow') return this.say('Added "Send proposal" to Todoist, due Friday.');
    if (choice === 'cancel') throw STOPPED;
    return this.say('OK, I did not run it.');
  }

  async markdown() {
    await this.think('Putting the plan in order.', 200);
    return this.say(MARKDOWN_REPLY);
  }

  // "lost session": the agent no longer has the chat's session, like Claude Code after it deleted an old
  // transcript. Rukoo sends the email and a recap again; the answer says which of the two came along.
  async lostSession() {
    this.turn.emit({ type: 'notice', tone: 'info', code: 'new-session', text: `${this.hub.agentName(this.adapter.id)} started a new session` });
    const input = typeof this.turn.startOver === 'function' ? await this.turn.startOver() : this.turn.input;
    this.check();
    const got = [];
    if (String(input).includes('<unsafe_content source="email"')) got.push('the email');
    if (String(input).includes('<unsafe_content source="earlier chat">')) got.push('a recap of our chat');
    return this.say(got.length ? `I started a new session. Rukoo sent me ${got.join(' and ')}.` : 'I started a new session.');
  }

  async error() {
    const error = { code: 'offline', detail: 'connect ECONNREFUSED 100.91.52.84:8642' };
    this.turn.emit({ type: 'error', ...error });
    return { status: 'error', error };
  }

  async followUp() {
    const c = this.turn.conversation;
    const plan = [...c.items].reverse().find((i) => i.type === 'plan');
    const open = plan ? plan.tasks.filter((t) => t.status !== 'done') : [];
    if (open.length) {
      await this.tool('show_plan', {
        plan_id: plan.planId,
        tasks: open.map((t, i) => ({ id: t.id, status: 'done', url: `https://todoist.com/showTask?id=fake${i + 1}` }))
      });
    }
    return this.say(open.length ? `Done. I added ${open.length === 1 ? 'the task' : `${open.length} tasks`} and linked them in the plan.` : 'Done.');
  }

  async echo(text) {
    await this.think('Thinking about your question.', 400);
    const asked = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    return this.say(`You asked: "${asked}". ${ECHO_TAIL}`);
  }
}

module.exports = { FakeAdapter, LONG_COMMAND, LONG_COMMAND_TAIL, MARKDOWN_REPLY };
