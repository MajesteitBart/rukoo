import { t, getLocale } from '../i18n.js';
// The chat panel: a conversation with Clark (Hermes), Claude Code or Codex about the open email.
// Main runs the agents and keeps the conversations; this module draws them, follows the email
// on screen and answers the agents' requests to write into the composer (the UI bridge).
import { icons } from '../icons.js';
import { api, $, toast, listTime, person, hue } from '../ui.js';
import * as B from './bui.js';
import { actionByKey, actionsFor, commandsFor } from './actions.js';
import { replyEnvelope } from '../composer.js';
import { expired } from './expired.js';

const AGENTS = ['clark', 'claude', 'codex'];
// Product names, not translated.
const PRODUCTS = { clark: 'Hermes Agent', claude: 'Claude Code', codex: 'Codex' };
const STATES = ['starting', 'ready', 'offline', 'unconfigured', 'disabled', 'missing', 'unauthorized', 'unknown'];
// Until these are fixed in Settings the agent cannot take a message.
const BLOCKED = new Set(['unconfigured', 'disabled', 'missing', 'unauthorized']);
const CODES = new Set(['offline', 'unauthorized', 'not-configured', 'not-installed', 'disabled', 'spawn-failed', 'busy', 'window', 'timeout', 'protocol', 'rate-limited', 'stopped', 'unknown']);
// Rukoo's own tools: their kind picks the chip icon and their label is ours to translate.
const RUKOO_TOOLS = {
  get_context: 'mail',
  read_message: 'mail',
  search_mail: 'search',
  write_draft: 'draft',
  get_draft: 'draft',
  show_plan: 'plan',
  show_sources: 'sources',
  propose_action: 'approval',
  mail_action: 'approval',
  read_attachment: 'file'
};
const CHOICES = new Set(['allow', 'deny', 'once', 'session', 'always', 'approve', 'decline', 'accept', 'acceptForSession', 'cancel']);
// Main and the adapters label approval buttons in English. Those standard labels are matched back to
// our keys (through the English catalog) so they can be translated; a label the agent wrote itself,
// such as propose_action's "Add tasks", stays as it is.
let choiceKeys = null;
function choiceKey(label) {
  if (!choiceKeys) {
    const en = (globalThis.RukooLocales && globalThis.RukooLocales.en) || {};
    choiceKeys = new Map();
    for (const id of CHOICES) {
      const entry = en[`agent.choices.${id}`];
      if (entry && typeof entry.message === 'string') choiceKeys.set(entry.message.toLowerCase(), `agent.choices.${id}`);
    }
  }
  return choiceKeys.get(String(label || '').trim().toLowerCase()) || null;
}
// Runtime approvals name the kind of tool, so the card can say in the interface language what the agent wants.
const APPROVAL_TITLES = new Set(['command', 'readFile', 'changeFiles', 'web', 'permissions']);
// Field keys the adapters send; 'input' is anything else and keeps the adapter's own label.
const APPROVAL_FIELDS = new Set(['command', 'folder', 'file', 'path', 'url', 'query', 'pattern', 'content', 'before', 'after', 'diff', 'reason']);
const DRAFT_MODES = { reply: 'reply', reply_all: 'replyAll', replyAll: 'replyAll', forward: 'forward', new: 'new' };
const sameMessageId = (a, b) => Boolean(a && b) && String(a).replace(/[<>\s]/g, '').toLowerCase() === String(b).replace(/[<>\s]/g, '').toLowerCase();
const hasKey = (key) => Boolean(globalThis.RukooLocales && globalThis.RukooLocales.en && globalThis.RukooLocales.en[key]);
// Mail results main reports with counts, so they can be said in the interface language.
const MAIL_RESULTS = new Set(['archive', 'trash', 'move', 'mark_read', 'mark_unread', 'star', 'unstar', 'undo']);

const elOf = (x) => (x instanceof Node ? x : x && x.el);
// Main marks text from email with <unsafe_content> tags for the agents. A proposal or a plan keeps the tags of
// email text the agent quoted in it, so Rukoo can repeat it to the agent still marked; the user reads the text
// without them. The same pattern as untag() in main's agents/context.js.
const UNSAFE_TAG = /<\/?unsafe_content(?:\s(?:"[^"]*"|[^">])*)?>/gi;
const untag = (v) => (typeof v === 'string' ? v.replace(UNSAFE_TAG, '') : v);
const rukooTool = (name) => String(name || '').replace(/^(mcp__rukoo__|mcp_rukoo_|rukoo[._:])/i, '');
// These tools put their own card in the transcript (the draft, the plan, the sources, the approval),
// so once they succeed a chip saying the same thing is noise. Running and failed calls keep theirs.
const CARD_TOOLS = new Set(['write_draft', 'show_plan', 'show_sources', 'propose_action', 'mail_action']);
const cardToolDone = (item) => {
  const tool = rukooTool(item.name);
  return item.status === 'done' && CARD_TOOLS.has(tool) && (item.rukoo || tool !== item.name);
};

function toolKind(item) {
  const tool = rukooTool(item.name);
  if (RUKOO_TOOLS[tool]) return RUKOO_TOOLS[tool];
  const n = String(item.name || '').toLowerCase();
  if (/bash|shell|powershell|terminal|command|exec/.test(n) || /^ran a command/i.test(item.label || '')) return 'command';
  if (/web|fetch|browse|url/.test(n)) return 'web';
  if (/read|write|edit|file|glob|grep|patch/.test(n)) return 'file';
  if (/mail/.test(n)) return 'mail';
  if (/search/.test(n)) return 'search';
  return 'tool';
}

// The agents' own common tools, across Claude Code, Codex and Hermes, in the interface language.
// Other MCP servers read as "server: tool", anything else as its name with spaces.
const GENERIC_TOOLS = [
  [/^(bash|terminal|shell|powershell|command|commandexecution|exec(_command)?|run_command|local_shell)$/i, 'command'],
  [/^(execute_code|code_execution)$/i, 'code'],
  [/^(websearch|web_search|websearchtool|search_web|x_search)$/i, 'webSearch'],
  [/^(webfetch|web_fetch|web_extract|fetch_url)$/i, 'webPage'],
  [/^browser/i, 'browser'],
  [/^(read|read_file|view|cat|notebookread)$/i, 'readFile'],
  [/^(write|edit|multiedit|filechange|apply_patch|write_file|patch|notebookedit)$/i, 'changeFiles'],
  [/^(task|agent|delegate_task|subagent.*|collabagenttoolcall)$/i, 'subagent'],
  [/^(glob|grep|ls|search_files)$/i, 'findFiles'],
  [/^(todowrite|todo)$/i, 'todo'],
  [/^(toolsearch|tool_describe|tools_list)$/i, 'lookupTools'],
  [/^(memory|honcho_.+|mem0_.+)$/i, 'memory'],
  [/^(skill|skill_view|skills_list|skill_manage)$/i, 'skill'],
  [/^session_search$/i, 'pastChats'],
  [/^cronjob$/i, 'schedule'],
  [/^send_message$/i, 'sendMessage'],
  [/^(image_generate|imagegeneration)$/i, 'image'],
  [/^(vision_analyze|imageview)$/i, 'vision']
];

// "mcp__strap__strap_search" reads as "strap: search", "mcp__todoist__add_task" as "todoist: add task".
function mcpLabel(name) {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name) || /^mcp_([a-z0-9-]+)_(.+)$/i.exec(name);
  if (!m) return null;
  const server = m[1];
  let tool = m[2];
  if (tool.toLowerCase().startsWith(`${server.toLowerCase()}_`)) tool = tool.slice(server.length + 1);
  return `${server.replace(/_/g, ' ')}: ${tool.replace(/_/g, ' ')}`;
}

// While a tool runs its chip says what it is doing ("Searching your mail…"), afterwards what it did.
function toolProps(item) {
  const tool = rukooTool(item.name);
  const name = String(item.name || '');
  const tense = item.status === 'running' ? 'running.' : '';
  let label;
  if (RUKOO_TOOLS[tool] && (item.rukoo || tool !== item.name)) label = t(`agent.tools.${tense}${tool}`);
  else {
    const generic = GENERIC_TOOLS.find(([re]) => re.test(name));
    if (generic) label = t(`agent.tools.${tense}generic.${generic[1]}`);
    else label = mcpLabel(name) || (item.label && item.label !== name ? item.label : name.replace(/_/g, ' ').trim()) || t(`agent.tools.${tense}unknown`);
  }
  return { ...item, label, kind: toolKind(item) };
}

// "busy", "offline: connect ECONNREFUSED …" or an object with a code: a sentence for people plus the technical detail.
function describeError(err, name) {
  const source = err && err.code ? err : err && err.error && err.error.code ? err.error : null;
  let code = source ? source.code : null;
  let detail = source ? String(source.detail || '') : String((err && err.message) || err || '');
  const m = !code && detail.match(/^([a-z-]+)(?::\s*([\s\S]*))?$/);
  if (m && CODES.has(m[1])) {
    code = m[1];
    detail = m[2] || '';
  }
  if (!CODES.has(code)) return { code: null, text: detail || t('agent.errors.unknown', { name }), detail: '' };
  return { code, text: t(`agent.errors.${code}`, { name }), detail };
}

export function mountAgentPanel(ctx) {
  const { S } = ctx;
  const pane = $('.agentpane');
  const P = {
    config: null,
    status: null,
    unavailable: false,
    // The agent a new conversation goes to.
    agentId: 'clark',
    conv: null,
    // The email the panel last followed, and whether it had fully loaded.
    emailId: null,
    emailKey: undefined,
    // The user took the email off the chat: the next one starts without it.
    detached: false,
    // An email opened from the panel itself (a source, a draft): the chat stays as it is.
    keepFor: null
  };

  pane.innerHTML = `
    <header class="ap-head">
      <span class="ap-mono" aria-hidden="true"></span>
      <div class="ap-who">
        <div class="ap-line"><span class="ap-agent"></span><span class="ap-dot" data-state="starting"></span></div>
        <div class="ap-title"></div>
      </div>
      <button class="icon-btn sm" data-ap="history" aria-haspopup="menu">${icons.clock}</button>
      <button class="icon-btn sm" data-ap="new">${icons.plus}</button>
      <button class="icon-btn sm" data-ap="close">${icons.close}</button>
    </header>
    <div class="ap-body">
      <div class="ap-scroll" tabindex="-1"><div class="ap-transcript" role="log"></div></div>
      <button class="ap-jump" data-ap="jump" hidden>${icons.down}</button>
    </div>
    <div class="ap-foot"></div>`;
  const head = {
    mono: $('.ap-mono', pane),
    agent: $('.ap-agent', pane),
    dot: $('.ap-dot', pane),
    title: $('.ap-title', pane)
  };
  const scroller = $('.ap-scroll', pane);
  const transcript = $('.ap-transcript', pane);
  const jump = $('[data-ap="jump"]', pane);
  const foot = $('.ap-foot', pane);

  // ---------- agents ----------

  const currentAgent = () => (P.conv ? P.conv.agent : P.agentId);
  const agentName = (id) => (id === 'clark' ? (P.config && P.config.clark && P.config.clark.name) || 'Hermes' : id === 'claude' ? 'Claude' : id === 'codex' ? 'Codex' : String(id || ''));
  const stateOf = (id) => {
    const s = P.unavailable ? 'unknown' : P.status && P.status[id] ? P.status[id].state : 'starting';
    return STATES.includes(s) ? s : 'unknown';
  };
  const dotOf = (state) => (state === 'ready' ? 'ready' : state === 'offline' || state === 'unauthorized' ? 'offline' : state === 'starting' ? 'starting' : 'unconfigured');
  const statusText = (id) => t(`agent.status.${stateOf(id)}`);
  const agentRows = () =>
    AGENTS.map((id) => ({ id, name: agentName(id), label: agentName(id), tag: PRODUCTS[id], status: dotOf(stateOf(id)), checked: id === currentAgent() }));

  // The config is local and answers at once; status can wait on the network (an offline Hermes server takes
  // seconds). So the default agent and the panel come first, and the status fills in when it arrives.
  async function loadAgents() {
    try {
      const config = await api('agentConfig');
      const before = P.config ? P.config.defaultAgent : null;
      P.config = config;
      P.unavailable = false;
      // A new default in Settings applies to the next new chat; an open chat keeps its own agent.
      if (AGENTS.includes(config.defaultAgent) && config.defaultAgent !== before) P.agentId = config.defaultAgent;
    } catch (err) {
      // No agent support in main (yet): show the panel, but say so instead of failing quietly.
      if (!P.config) P.unavailable = true;
    }
    redrawAgents();
    if (P.unavailable) return;
    try {
      P.status = await api('agentStatus');
    } catch (_) {
      // The status lines keep their last known state.
    }
    redrawAgents();
  }

  function redrawAgents() {
    renderHead();
    refreshComposer();
    if (!P.conv) renderEmpty();
  }

  // ---------- header ----------

  function renderHead() {
    const id = currentAgent();
    const name = agentName(id);
    head.mono.replaceChildren(elOf(B.monogram({ label: [...name][0] || '?', size: 24, agent: true })));
    head.agent.textContent = name;
    head.dot.dataset.state = dotOf(stateOf(id));
    head.dot.title = statusText(id);
    head.title.textContent = P.conv ? P.conv.title || t('agent.panel.newChat') : P.unavailable ? t('agent.status.unavailable') : statusText(id);
    head.title.title = head.title.textContent;
  }

  function localizeChrome() {
    for (const [action, key] of [['history', 'agent.panel.history'], ['new', 'agent.panel.new'], ['close', 'agent.panel.close'], ['jump', 'agent.panel.jump']]) {
      const b = $(`[data-ap="${action}"]`, pane);
      b.title = t(key);
      b.setAttribute('aria-label', t(key));
    }
    transcript.setAttribute('aria-label', t('agent.panel.transcript'));
  }

  // ---------- chat input ----------

  let chat = null;
  const contextEmail = () => (P.conv ? P.conv.message : P.detached ? null : currentEmail());
  // The slash commands go by the email itself when it is on screen: it knows whether it can unsubscribe,
  // also for chats saved before their reference carried that.
  const slashEmail = () => {
    const m = contextEmail();
    const open = currentEmail();
    return m && open && open.id === m.id ? open : m;
  };
  const placeholder = () => {
    const name = agentName(currentAgent());
    return contextEmail() ? t('agent.panel.placeholderEmail', { name }) : t('agent.panel.placeholder', { name });
  };
  // The email the next message is about; its x leaves the email out.
  const contextChip = () => {
    const m = contextEmail();
    if (!m) return null;
    const from = person(m.from);
    return elOf(
      B.entityChip({
        label: m.subject || t('mailbox.message.noSubject'),
        sub: from,
        monogram: { label: from || '?', hue: hue((m.from && m.from.address) || from) },
        onRemove: () => detach(),
        removeLabel: t('agent.panel.removeContext')
      })
    );
  };

  function buildComposer() {
    const value = chat ? chat.getValue() : '';
    if (chat) chat.el.remove();
    chat = B.chatComposer(
      {
        placeholder: placeholder(),
        labels: {
          send: t('agent.panel.send'),
          stop: t('agent.panel.stop'),
          agent: t('agent.panel.pickAgent'),
          removeContext: t('agent.panel.removeContext'),
          noMatches: t('agent.panel.noMatches')
        },
        agents: agentRows(),
        agentId: currentAgent(),
        commands: commandsFor(slashEmail()),
        context: contextChip()
      },
      {
        onSend: (text) => send(text),
        onStop: () => P.conv && api('agentStop', P.conv.id).catch((err) => showError(err)),
        onAgent: (id) => pickAgent(id),
        onCommand: (name) => runAction(name),
        onRemoveContext: () => detach()
      }
    );
    foot.append(chat.el);
    if (value) chat.setValue(value);
  }

  // Why the input is off, with the way to fix it: "Hermes isn't set up yet. Set up Hermes".
  function setupNote(id, state) {
    const name = agentName(id);
    const note = document.createElement('span');
    note.className = 'ap-setup';
    const text = document.createElement('span');
    text.textContent = P.unavailable ? t('agent.status.unavailable') : t(`agent.setup.${state}`, { name });
    note.append(text);
    if (!P.unavailable) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'link-btn';
      link.dataset.ap = 'setup';
      link.textContent = t('agent.panel.setUp', { name });
      note.append(link);
    }
    return note;
  }

  // Agent, email, commands and availability follow what is on screen.
  function refreshComposer() {
    if (!chat) return;
    const id = currentAgent();
    chat.setAgents(agentRows(), id);
    chat.setContext(contextChip());
    chat.setCommands(commandsFor(slashEmail()));
    chat.setRunning(Boolean(P.conv && P.conv.status === 'running'));
    chat.setPlaceholder(placeholder());
    const state = stateOf(id);
    const blocked = P.unavailable || BLOCKED.has(state);
    chat.setDisabled(blocked, blocked ? setupNote(id, state) : null);
  }

  // ---------- following the email on screen ----------

  function currentEmail() {
    const m = S.message;
    return m && m.id && m.id === S.selectedId && !m.error && m.role !== 'drafts' ? m : null;
  }
  // Changes once more when the full message arrives, with its Message-ID and unsubscribe details.
  const emailKey = (m) => (m ? `${m.id}|${m.html === null || m.html === undefined ? '' : 'full'}` : '');
  const messageRef = (m) => ({
    id: m.id,
    messageId: m.messageId || null,
    accountId: m.accountId || null,
    subject: m.subject || '',
    from: m.from ? { name: m.from.name || '', address: m.from.address || '' } : null,
    date: m.date || null,
    // Keeps /unsubscribe available once the chat exists.
    unsubscribe: Boolean(m.unsubscribe)
  });

  // turn: the latest request for what the panel shows; a slower one that lost the race does nothing.
  // lookups: only the searches for the chat of the email on screen.
  let turn = 0;
  let lookups = 0;
  async function sync() {
    if (!ctx.agentOpen()) return;
    const m = currentEmail();
    const key = emailKey(m);
    if (key === P.emailKey) return;
    const otherEmail = (m ? m.id : null) !== P.emailId;
    P.emailKey = key;
    P.emailId = m ? m.id : null;
    // Goes by the selection, not the loaded message: an email from another folder can take a while to
    // load, and the chat it was opened from stays on screen meanwhile.
    if (P.keepFor && S.selectedId !== P.keepFor) P.keepFor = null;
    if (otherEmail) P.detached = false;
    // Without an email, or one opened from this chat, the conversation on screen stays.
    if (!m || P.keepFor || (P.detached && !otherEmail)) {
      // A lookup for the email before must not replace the chat that is kept now (a chat being opened
      // from history keeps going).
      if (P.keepFor) lookups++;
      if (!P.conv) renderEmpty();
      return refreshComposer();
    }
    const mine = ++turn;
    const look = ++lookups;
    let found = null;
    try {
      found = await api('agentFindFor', { id: m.id, messageId: m.messageId || null, accountId: m.accountId || null });
    } catch (_) {
      found = null;
    }
    if (mine !== turn || look !== lookups) return;
    if (found && found.id) {
      if (P.conv && P.conv.id === found.id) return refreshComposer();
      return openConversation(found.id);
    }
    if (P.conv && !otherEmail && P.conv.message && P.conv.message.id === m.id) return refreshComposer();
    // A chat about another email keeps running in the background; this email starts fresh.
    showEmpty();
  }

  async function openConversation(id) {
    const mine = ++turn;
    let conv = null;
    try {
      conv = await api('agentGet', id);
    } catch (err) {
      return showError(err);
    }
    if (mine !== turn || !conv) return;
    showConversation(conv);
  }

  function showConversation(conv) {
    P.conv = { ...conv, items: (conv.items || []).map((i) => ({ ...i })) };
    renderHead();
    renderTranscript();
    refreshComposer();
  }

  function showEmpty() {
    turn++;
    P.conv = null;
    renderHead();
    renderEmpty();
    refreshComposer();
  }

  function detach() {
    P.detached = true;
    showEmpty();
    chat.focus();
  }

  function pickAgent(id) {
    if (!AGENTS.includes(id)) return;
    P.agentId = id;
    // A conversation stays with its agent; another agent starts a new one about the same email.
    if (P.conv && P.conv.agent !== id) return showEmpty();
    renderHead();
    if (!P.conv) renderEmpty();
    refreshComposer();
  }

  // ---------- sending ----------

  async function ensureConversation() {
    if (P.conv) return P.conv;
    const m = contextEmail();
    const conv = await api('agentCreate', { agent: P.agentId, message: m ? messageRef(m) : null });
    showConversation(conv);
    return P.conv;
  }

  let sending = false;
  async function send(text, action = null) {
    const body = String(text || '').trim();
    if (!body || sending) return;
    sending = true;
    clearTurnError();
    try {
      const conv = await ensureConversation();
      await api('agentSend', conv.id, action ? { text: action.prompt, action: action.key, display: action.label } : { text: body });
      follow(true);
    } catch (err) {
      if (!action && chat && !chat.getValue()) chat.setValue(body);
      showError(err);
    } finally {
      sending = false;
    }
  }

  function runAction(name) {
    const action = actionByKey(name);
    if (!action) return;
    if (action.needsEmail && !contextEmail()) return toast(t('agent.panel.needsEmail'));
    send(action.label, action);
  }

  function showError(err) {
    const { text, detail } = describeError(err, agentName(currentAgent()));
    toast(detail ? `${text} (${detail})` : text, 6000);
  }

  // ---------- transcript ----------

  // item id -> { item, update(item), delta(text) }
  const views = new Map();
  let toolRun = null;
  let pendingEl = null;
  let turnErrorEl = null;
  // A running tool that waits on the approval card right under it: tool item id -> approval item id.
  // The card says what the tool will do, so the chip stays out of sight until the user allows it.
  const waitsFor = new Map();

  function renderTranscript() {
    views.clear();
    waitsFor.clear();
    toolRun = null;
    pendingEl = null;
    turnErrorEl = null;
    transcript.replaceChildren();
    pane.classList.remove('is-empty');
    for (const item of P.conv.items) addItem(item);
    showPending();
    follow(true);
  }

  function wrap(el, item) {
    const box = document.createElement('div');
    box.className = 'ap-item';
    box.dataset.type = item.type;
    box.dataset.id = item.id;
    if (item.interim) box.classList.add('is-interim');
    box.append(el);
    return box;
  }

  // Consecutive tool calls share one row of chips. A call whose card says it all (a successful
  // write_draft, show_plan, ...) or that waits on an approval has no chip; calls in a row with the same
  // label and status share one ("Read a skill ×4").
  function newRun(item) {
    const group = B.toolGroup();
    const box = wrap(elOf(group), item);
    transcript.append(box);
    return { group, box, ids: [], chips: new Map() };
  }

  function waiting(item) {
    const approvalId = waitsFor.get(item.id);
    const view = approvalId && views.get(approvalId);
    return Boolean(view && view.item.status !== 'approved');
  }

  function drawRun(run) {
    const runs = [];
    for (const id of run.ids) {
      const view = views.get(id);
      if (!view || cardToolDone(view.item) || waiting(view.item)) continue;
      const props = toolProps(view.item);
      const status = view.item.status || 'done';
      const last = runs[runs.length - 1];
      if (last && last.label === props.label && last.status === status && last.kind === props.kind) last.items.push(view.item);
      else runs.push({ key: id, label: props.label, status, kind: props.kind, rukoo: Boolean(view.item.rukoo), items: [view.item] });
    }
    const keep = new Map();
    const list = runs.map((r) => {
      const props = { label: r.label, status: r.status, kind: r.kind, rukoo: r.rukoo, count: r.items.length, detail: r.items.map((i) => i.detail).filter(Boolean).join('\n') };
      let chip = run.chips.get(r.key);
      if (chip) chip.update(props);
      else chip = B.toolChip(props);
      chip.el.dataset.id = r.key;
      keep.set(r.key, chip);
      return chip;
    });
    run.chips = keep;
    run.group.set(list);
    run.box.hidden = !list.length;
  }

  function addItem(item) {
    if (item.type === 'tool') {
      if (!toolRun) toolRun = newRun(item);
      const run = toolRun;
      run.ids.push(item.id);
      views.set(item.id, { item, run, update: () => drawRun(run) });
      drawRun(run);
      return;
    }
    toolRun = null;
    const view = buildView(item);
    if (!view) return;
    transcript.append(wrap(view.el, item));
    views.set(item.id, { item, ...view });
    if (item.type === 'approval') linkApproval(item);
  }

  // A runtime approval right after a tool that was still running (or ended after the card came) is that
  // tool asking for permission.
  function linkApproval(item) {
    if (item.kind !== 'runtime' || !P.conv) return;
    const items = P.conv.items;
    const prev = items[items.findIndex((x) => x.id === item.id) - 1];
    if (!prev || prev.type !== 'tool') return;
    if (prev.status !== 'running' && !(prev.endedAt && item.at && prev.endedAt >= item.at)) return;
    waitsFor.set(prev.id, item.id);
    const view = views.get(prev.id);
    if (view && view.run) drawRun(view.run);
  }

  // The chip waiting on this approval shows again once it is allowed.
  function approvalChanged(approvalId) {
    for (const [toolId, id] of waitsFor) {
      if (id !== approvalId) continue;
      const view = views.get(toolId);
      if (view && view.run) drawRun(view.run);
    }
  }

  function buildView(item) {
    switch (item.type) {
      case 'user':
        return { el: elOf(B.userBubble({ text: item.text || '', action: item.action || null, labels: { approved: t('agent.items.youApproved'), declined: t('agent.items.youDeclined') } })) };
      case 'assistant': {
        const s = B.streamText({ interim: Boolean(item.interim) });
        let shown = item.text || '';
        let finished = false;
        const finish = (i) => {
          if (finished || i.status === 'streaming') return;
          finished = true;
          s.finish();
        };
        s.set(shown);
        finish(item);
        const el = elOf(s);
        return {
          el,
          delta: (text) => {
            shown += text;
            s.append(text);
          },
          update: (next) => {
            // The final item carries the whole text; it corrects anything a lost delta left out.
            if ((next.text || '') !== shown) {
              shown = next.text || '';
              s.set(shown);
            }
            finish(next);
            el.parentElement?.classList.toggle('is-stopped', next.status === 'stopped');
          }
        };
      }
      case 'thinking': {
        const view = B.thinking({ labels: { thinking: t('agent.items.thinking'), thoughtFor: (seconds) => t('agent.items.thoughtFor', { count: Math.max(1, Math.round(seconds)) }) }, startedAt: item.startedAt || item.at });
        const show = (i) => view.update({ text: i.text || '', status: i.status, endedAt: i.endedAt || null });
        show(item);
        return { el: elOf(view), update: show, delta: () => show(views.get(item.id).item) };
      }
      case 'approval': {
        const card = B.approvalCard(localizeApproval(item), {
          labels: {
            approved: t('agent.items.approved'),
            denied: t('agent.items.denied'),
            expired: t('agent.items.expired'),
            waiting: t('agent.items.waiting'),
            showAll: t('agent.approval.showAll'),
            showLess: t('agent.approval.showLess'),
            truncated: (count) => t('agent.approval.truncated', { count, shown: count.toLocaleString(getLocale()) })
          },
          onChoose: (choiceId) => decide(item.id, choiceId)
        });
        return {
          el: elOf(card),
          update: (next) => {
            card.update(localizeApproval(next));
            approvalChanged(next.id);
          }
        };
      }
      case 'plan': {
        const shownTask = (task) => ({ ...task, title: untag(task.title), detail: untag(task.detail), system: untag(task.system), owner: untag(task.owner), due: untag(task.due) });
        const titled = (i) => ({ ...i, title: untag(i.title) || t('agent.items.plan'), tasks: Array.isArray(i.tasks) ? i.tasks.map(shownTask) : i.tasks });
        const rows = B.taskRows(titled(item), {
          labels: { statuses: Object.fromEntries(['proposed', 'todo', 'running', 'done', 'failed', 'skipped'].map((s) => [s, t(`agent.plan.${s}`)])) },
          onOpen: (url) => openUrl(url)
        });
        return { el: elOf(rows), update: (next) => rows.update(titled(next)) };
      }
      case 'sources': {
        const titled = (i) => ({ ...i, title: i.title || t('agent.items.sources') });
        const cards = B.contextCards(titled(item), { labels: { email: t('agent.items.emailSource') }, onOpen: (source) => openSource(source) });
        return { el: elOf(cards), update: (next) => cards.update(titled(next)) };
      }
      case 'draft': {
        const labels = (i) => ({ title: t(`agent.draft.${DRAFT_MODES[i.mode] || 'reply'}`), show: t('agent.draft.show'), undo: t('common.actions.undo'), undone: t('agent.draft.undone'), cannotUndo: t('agent.draft.cannotUndo') });
        const card = B.draftCard({ ...item, canUndo: canUndoDraft(item) }, { labels: labels(item), onAction: (id) => draftAction(views.get(item.id).item, id) });
        return { el: elOf(card), update: (next) => card.update({ ...next, canUndo: canUndoDraft(next) }) };
      }
      case 'notice':
        return noticeView(item, () => undoNotice(item.id));
      default:
        return null;
    }
  }

  // Main and the adapters write approvals in English; the kind of tool, the field keys and the standard
  // choices let the card say it in the interface language. What the user approves (the values) is shown
  // exactly as the agent sent it; only a proposal loses the tags main keeps for the agent (see untag).
  function localizeApproval(item) {
    const name = agentName(AGENTS.includes(item.source) ? item.source : P.conv ? P.conv.agent : currentAgent());
    const tool = item.tool && typeof item.tool === 'object' ? item.tool : null;
    // A runtime approval shows a tool's input, which runs exactly as written, tags and all.
    const shown = item.kind === 'proposal' ? untag : (v) => v;
    let title = shown(item.title);
    if (tool && APPROVAL_TITLES.has(tool.kind)) title = t(`agent.approval.${tool.kind}`, { name });
    else if (tool && tool.kind === 'mcp' && (tool.server || tool.tool)) title = t('agent.approval.tool', { name, tool: [tool.server, tool.tool].filter(Boolean).join(' · ') });
    else if (tool && tool.name) title = t('agent.approval.tool', { name, tool: mcpLabel(tool.name) || tool.name });
    const fields = (item.fields || []).map((input) => {
      const f = { ...input, label: shown(input.label), value: shown(input.value) };
      if (APPROVAL_FIELDS.has(f.key)) return { ...f, label: t(`agent.approval.field.${f.key}`) };
      // A raw parameter name ("output_mode") reads as words.
      const raw = String(f.label || '');
      return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(raw) ? { ...f, label: (raw[0].toUpperCase() + raw.slice(1)).replace(/_/g, ' ') } : f;
    });
    const itemDetail = shown(item.detail);
    // A detail that only repeats a field (Claude describes a Read by its path) is left out.
    const detail = itemDetail && fields.some((f) => String(f.value || '').trim() === String(itemDetail).trim()) ? '' : itemDetail;
    return {
      ...item,
      title,
      detail,
      fields,
      choices: (item.choices || []).map((c) => {
        // A runtime approval's choices are always the adapter's standard ones; elsewhere a label the agent
        // wrote itself (propose_action's "Add tasks") stays as it is.
        const key = item.kind === 'runtime' && CHOICES.has(c.id) ? `agent.choices.${c.id}` : choiceKey(c.label);
        return key ? { ...c, label: t(key) } : c;
      })
    };
  }

  // Notices from main are English; errors and mail results carry a code or counts we can translate.
  function localizeNotice(item) {
    if (item.code && hasKey(`agent.notices.${item.code}`)) {
      const params = item.code === 'kept-approval' || item.code === 'approval-too-long' ? { title: String((item.params && item.params.title) || '') } : {};
      return { ...item, text: t(`agent.notices.${item.code}`, { name: agentName(P.conv ? P.conv.agent : currentAgent()), ...params }) };
    }
    if (item.code && (CODES.has(item.code) || item.tone === 'error')) return { ...item, text: describeError({ code: item.code }, agentName(P.conv ? P.conv.agent : currentAgent())).text };
    const m = item.mail;
    // Only unsubscribe emails were opened: the user still has to send them.
    if (m && m.action === 'unsubscribe_email' && m.mailed > 0 && m.mailed === m.count && !m.failed) {
      return { ...item, text: m.mailed === 1 && m.to ? t('agent.mail.unsubscribeEmailOne', { address: m.to }) : t('agent.mail.unsubscribeEmailMany', { count: m.mailed }) };
    }
    // Only unsubscribe pages were opened: the user finishes in the browser.
    if (m && m.action === 'unsubscribe_page' && m.opened > 0 && m.opened === m.count && !m.failed) {
      return { ...item, text: m.opened === 1 && m.sender ? t('agent.mail.unsubscribePageOne', { name: m.sender }) : t('agent.mail.unsubscribePageMany', { count: m.opened }) };
    }
    if (m && MAIL_RESULTS.has(m.action) && m.count > 0 && !m.failed && (m.action !== 'move' || m.folder)) {
      return { ...item, text: t(`agent.mail.${m.action}`, { count: m.count, folder: m.folder || '' }) };
    }
    return item;
  }

  // A notice line, with the technical detail of an error in small type under it.
  function noticeView(item, onUndo) {
    const line = B.noticeLine(localizeNotice(item), { labels: { undo: t('common.actions.undo') }, onUndo });
    const el = document.createElement('div');
    const detail = document.createElement('div');
    detail.className = 'ap-detail';
    el.append(elOf(line), detail);
    const show = (i) => {
      detail.textContent = i.tone === 'error' ? String(i.detail || '') : '';
      detail.hidden = !detail.textContent;
    };
    show(item);
    return {
      el,
      update: (next) => {
        line.update(localizeNotice(next));
        show(next);
      }
    };
  }

  function upsertItem(item) {
    const items = P.conv.items;
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items[i] = item;
    else items.push(item);
    const view = views.get(item.id);
    if (view) {
      view.item = item;
      view.update?.(item);
    } else {
      addItem(item);
    }
    showPending();
    follow();
  }

  // "Clark is working…" between your message and the first sign of life from the agent.
  function showPending() {
    const last = P.conv && P.conv.items[P.conv.items.length - 1];
    const want = Boolean(P.conv && P.conv.status === 'running' && (!last || last.type === 'user'));
    if (want && !pendingEl) {
      pendingEl = document.createElement('div');
      pendingEl.className = 'ap-item ap-pending';
      pendingEl.append(elOf(B.shimmer(t('agent.items.working', { name: agentName(P.conv.agent) }))));
      transcript.append(pendingEl);
    } else if (!want && pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
    if (pendingEl && pendingEl !== transcript.lastElementChild) transcript.append(pendingEl);
  }

  // A turn that failed without leaving a notice of its own still says why.
  function showTurnError(error) {
    const last = P.conv.items[P.conv.items.length - 1];
    if (last && last.type === 'notice' && last.tone === 'error') return;
    clearTurnError();
    const item = { id: 'turn-error', type: 'notice', text: '', detail: error.detail || '', tone: 'error', code: error.code || 'unknown', undo: null };
    turnErrorEl = wrap(noticeView(item, null).el, item);
    transcript.append(turnErrorEl);
    follow();
  }

  function clearTurnError() {
    turnErrorEl?.remove();
    turnErrorEl = null;
  }

  // ---------- empty state ----------

  function renderEmpty() {
    if (P.conv) return;
    views.clear();
    waitsFor.clear();
    toolRun = null;
    pendingEl = null;
    turnErrorEl = null;
    pane.classList.add('is-empty');
    const id = currentAgent();
    const name = agentName(id);
    const m = contextEmail();
    const state = stateOf(id);
    const box = document.createElement('div');
    box.className = 'ap-empty';
    const blocked = P.unavailable || BLOCKED.has(state);
    const card = B.recommendationCard(
      {
        eyebrow: name,
        title: blocked ? t('agent.empty.setupTitle', { name }) : m ? t('agent.empty.title', { name }) : t('agent.empty.titleNoEmail', { name }),
        body: blocked ? t('agent.empty.setupBody', { name }) : m ? t('agent.empty.body', { name }) : t('agent.empty.bodyNoEmail', { name }),
        actions: [],
        icon: B.icon('sparkle', 11)
      },
      () => {}
    );
    box.append(elOf(card));
    if (!blocked) {
      const chips = B.suggestionChips(
        actionsFor(m).map((a) => ({ id: a.key, label: a.label, icon: a.icon })),
        (key) => runAction(key)
      );
      const row = elOf(chips);
      row.classList.add('ap-actions');
      box.append(row);
    }
    transcript.replaceChildren(box);
    jump.hidden = true;
  }

  // ---------- actions from the transcript ----------

  function decide(itemId, choiceId) {
    if (!P.conv) return;
    api('agentDecide', P.conv.id, itemId, choiceId).catch((err) => showError(err));
  }

  // Source and plan links: besides http(s) and mailto, an Obsidian note (main's openAgentLink).
  function openUrl(url) {
    if (url) api('openAgentLink', String(url)).catch((err) => showError(err));
  }

  // A source being looked up: finding a moved email can sync a folder first, so clicks meanwhile are ignored.
  let locating = false;

  async function openSource(source) {
    if (source && source.messageId) {
      if (locating) return;
      // The email may have moved since the agent showed it; main finds it again by its Message-ID.
      let id = source.messageId;
      locating = true;
      try {
        id = (await api('agentLocate', { id: source.messageId, messageHeader: source.messageHeader || null, accountId: source.accountId || null })) || null;
      } catch (_) {
        // An older main without agentLocate: try the stored id.
      } finally {
        locating = false;
      }
      if (!id) return toast(t('agent.panel.sourceGone'));
      P.keepFor = id;
      return ctx.openMessage(id);
    }
    if (source && source.url) openUrl(source.url);
  }

  // ---------- draft cards ----------

  // A draft card belongs to one write into one composer: its composerKey is "<composer key>:<write>".
  // Show and Undo act on that composer only. A composer that closed leaves a stored draft behind; main keeps
  // which one on its cards (draftId), and follows it when it is saved again, sent or discarded in any window.
  // write key -> conversation id, so an Undo in the composer reaches a card that is not on screen.
  const writes = new Map();
  let writeCount = 0;
  const composerOf = (writeKey) => String(writeKey || '').split(':')[0];
  const openComposerFor = (item) => {
    const c = S.composer;
    return c && item.composerKey && c.key === composerOf(item.composerKey) ? c : null;
  };
  const canUndoDraft = (item) => {
    const c = openComposerFor(item);
    return Boolean(c && !item.undone && c.canUndoAgent(item.composerKey));
  };

  function refreshDrafts() {
    if (!P.conv) return;
    for (const item of P.conv.items) {
      if (item.type !== 'draft') continue;
      const view = views.get(item.id);
      if (view) view.update?.(view.item);
    }
  }

  // app.js reports every inline composer that closes.
  function composerClosed(c) {
    if (!c || !c.key) return;
    // A reopened draft that is saved again gets a new id; cards that pointed at the old one follow it.
    const was = c.opts && c.opts.mode === 'draft' ? c.opts.id : null;
    api('agentKeepDraft', c.key, c.savedDraftId || null, was).catch(() => {});
    refreshDrafts();
  }

  function draftAction(item, action) {
    const c = openComposerFor(item);
    if (action === 'show') {
      if (c) return c.focus();
      if (item.draftId) return ctx.compose({ mode: 'draft', id: item.draftId });
      if (item.messageRef) {
        P.keepFor = item.messageRef;
        return ctx.openMessage(item.messageRef);
      }
      return toast(t('agent.draft.gone'));
    }
    // The composer announces the undo (agent-undo), which marks the cards; see below.
    if (action === 'undo') {
      if (!c || !c.canUndoAgent(item.composerKey)) {
        refreshDrafts();
        return toast(t('agent.draft.gone'));
      }
      c.undoAgent(item.composerKey);
    }
  }

  // Undo from a card or from the composer's own link: the cards of the writes it took back say so,
  // in main too, so it survives a redraw and a restart.
  document.addEventListener('agent-undo', async (e) => {
    const ids = new Set(((e.detail && e.detail.writeIds) || []).map(String));
    if (!ids.size) return refreshDrafts();
    const byConversation = new Map();
    for (const key of ids) {
      const cid = writes.get(key) || (P.conv && P.conv.id);
      if (cid) byConversation.set(cid, [...(byConversation.get(cid) || []), key]);
    }
    for (const [cid, keys] of byConversation) {
      let items = P.conv && P.conv.id === cid ? P.conv.items : null;
      if (!items) items = await api('agentGet', cid).then((conv) => (conv && conv.items) || [], () => []);
      for (const item of items) {
        if (item.type !== 'draft' || item.undone || !keys.includes(String(item.composerKey))) continue;
        if (P.conv && P.conv.id === cid) {
          const view = views.get(item.id);
          item.undone = true;
          if (view) {
            view.item = { ...view.item, undone: true };
            view.update?.(view.item);
          }
        }
        api('agentPatchItem', cid, item.id, { undone: true }).catch(() => {});
      }
    }
    refreshDrafts();
  });

  function undoNotice(itemId) {
    if (!P.conv) return;
    api('agentUndo', P.conv.id, itemId)
      .then(() => ctx.refresh())
      .catch((err) => showError(err));
  }

  // ---------- history ----------

  async function showHistory(anchor) {
    let list = [];
    try {
      list = await api('agentList');
    } catch (err) {
      return showError(err);
    }
    const items = list.slice(0, 40).map((c) => ({
      id: c.id,
      label: c.title || t('agent.panel.newChat'),
      tag: `${agentName(c.agent)} · ${listTime(c.updatedAt)}`,
      status: c.status === 'running' ? 'running' : c.status === 'error' ? 'offline' : undefined,
      checked: Boolean(P.conv && c.id === P.conv.id)
    }));
    if (!items.length) items.push({ id: '', label: t('agent.panel.noHistory'), tag: '', disabled: true });
    B.glideMenu({ items, anchor, align: 'right', onPick: (id) => id && pickConversation(id) });
  }

  // A chat you chose stays while the email on screen finishes loading.
  function keepChat() {
    const m = currentEmail();
    P.keepFor = m ? m.id : S.selectedId || null;
  }

  function pickConversation(id) {
    keepChat();
    return openConversation(id);
  }

  // ---------- scrolling ----------

  // Follows the newest text unless you scrolled up to read; then a small arrow takes you back down.
  let stick = true;
  let frame = 0;
  scroller.addEventListener(
    'scroll',
    () => {
      stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      if (stick) jump.hidden = true;
    },
    { passive: true }
  );
  function follow(force = false) {
    if (force) stick = true;
    if (!stick) {
      if (P.conv) jump.hidden = false;
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      scroller.scrollTop = scroller.scrollHeight;
      jump.hidden = true;
    });
  }

  // ---------- events ----------

  pane.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ap]');
    if (!b || !pane.contains(b)) return;
    switch (b.dataset.ap) {
      case 'history':
        return showHistory(b);
      case 'new':
        P.detached = false;
        showEmpty();
        return chat.focus();
      case 'close':
        return ctx.closeAgent();
      case 'jump':
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
        stick = true;
        jump.hidden = true;
        return;
      case 'setup':
        return ctx.openSettings('agents');
    }
  });

  // Escape closes the panel where it covers the mail; menus and the input handle it first.
  pane.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && ctx.agentOverlay()) {
      e.preventDefault();
      ctx.closeAgent();
    }
  });

  function onConversation(conv) {
    if (conv.removed) {
      if (P.conv && P.conv.id === conv.id) showEmpty();
      return;
    }
    if (!P.conv || P.conv.id !== conv.id) return;
    if (!Array.isArray(conv.items)) {
      Object.assign(P.conv, conv, { items: P.conv.items });
      renderHead();
      return refreshComposer();
    }
    // Merge rather than redraw, so streaming text and the scroll position survive.
    const ids = new Set(conv.items.map((i) => i.id));
    if (P.conv.items.some((i) => !ids.has(i.id))) return showConversation(conv);
    Object.assign(P.conv, conv, { items: P.conv.items });
    for (const item of conv.items) upsertItem({ ...item });
    renderHead();
    refreshComposer();
  }

  function onItem({ conversationId, item }) {
    // An agent waiting for you in a chat that is not on screen: say so instead of letting it hang.
    if (item.type === 'approval' && item.status === 'pending' && (!ctx.agentOpen() || !P.conv || P.conv.id !== conversationId)) {
      toast(t('agent.panel.needsYou'), { action: { label: t('agent.panel.show'), run: () => reveal(conversationId) } });
    }
    if (!P.conv || P.conv.id !== conversationId) return;
    // Main names an untitled chat after its first message without a conversation event; follow suit.
    if (item.type === 'user' && !P.conv.title && item.text) {
      P.conv.title = String(item.text).replace(/\s+/g, ' ').trim().slice(0, 80);
      renderHead();
    }
    upsertItem({ ...item });
  }

  // Main dropped the oldest items of a long chat; only their ids come, not the whole transcript again.
  function onTrim({ conversationId, itemIds }) {
    if (!P.conv || P.conv.id !== conversationId || !Array.isArray(itemIds)) return;
    const gone = new Set(itemIds);
    P.conv.items = P.conv.items.filter((i) => !gone.has(i.id));
    const runs = new Set();
    for (const id of gone) {
      const view = views.get(id);
      if (!view) continue;
      views.delete(id);
      waitsFor.delete(id);
      if (view.run) {
        view.run.ids = view.run.ids.filter((x) => x !== id);
        runs.add(view.run);
      } else transcript.querySelector(`.ap-item[data-id="${CSS.escape(id)}"]`)?.remove();
    }
    for (const run of runs) {
      drawRun(run);
      if (!run.ids.length) {
        run.box.remove();
        if (toolRun === run) toolRun = null;
      }
    }
  }

  function onDelta({ conversationId, itemId, text }) {
    if (!P.conv || P.conv.id !== conversationId) return;
    const view = views.get(itemId);
    if (!view) return;
    view.item.text = (view.item.text || '') + text;
    view.delta?.(text);
    follow();
  }

  function onStatus({ conversationId, status, error }) {
    if (!P.conv || P.conv.id !== conversationId) return;
    P.conv.status = status;
    chat.setRunning(status === 'running');
    if (status === 'running') clearTurnError();
    showPending();
    if (status === 'error' && error) showTurnError(error);
  }

  function reveal(conversationId) {
    // Before the panel opens, so its catch-up with the email on screen leaves this chat alone.
    if (conversationId) keepChat();
    ctx.revealAgent();
    if (conversationId) openConversation(conversationId);
  }

  // ---------- UI bridge: agents writing into the composer ----------

  // The Message-ID header of the email a draft answers, to recognize a reopened reply draft.
  async function headerOf(id, args) {
    if (args.targetMessageId) return args.targetMessageId;
    if (S.message && S.message.id === id && S.message.messageId) return S.message.messageId;
    return api('get', id).then((m) => (m && m.messageId) || null, () => null);
  }

  // Whether the open composer is the one this write is for:
  // - the same email in exactly the same mode (a reply is not a reply-all, nor a forward);
  // - a reopened draft that answers that email (rewritten in place, so no second draft appears);
  // - for a new email, an open new message that is untouched or this chat's own.
  async function fits(d, id, mode, args, mine, theirs) {
    if (!id) return d.mode === 'new' && (mine || !theirs);
    if (d.mode === 'draft') return (mode === 'reply' || mode === 'replyAll') && Boolean(d.inReplyTo) && sameMessageId(d.inReplyTo, await headerOf(id, args));
    return d.messageRef === id && d.mode === mode;
  }

  const busy = () => Object.assign(new Error('The user is writing another email in the composer.'), { code: 'busy' });

  async function writeDraft(args, attempt = 0) {
    let mode = DRAFT_MODES[args.mode] || (args.messageId ? 'reply' : 'new');
    const id = mode === 'new' ? null : args.messageId || null;
    if (!id) mode = 'new';
    const cid = args.conversationId ? String(args.conversationId) : null;
    const conv = P.conv && P.conv.id === cid ? P.conv : null;
    const name = String(args.agentName || agentName(conv ? conv.agent : currentAgent()));
    // A chat that is not on screen, or one an agent started from elsewhere, never closes what the user is writing.
    // Asked again after each wait, so it sees the user close the panel or switch to another chat meanwhile.
    const isBackground = () => !(P.conv && P.conv.id === cid) || !ctx.agentOpen() || P.conv.origin === 'external';
    const background = isBackground();
    const blocked = () => {
      if (background) toast(t('agent.panel.draftBlocked', { name }), { action: { label: t('agent.panel.show'), run: () => reveal(cid) } });
      return busy();
    };
    let c = S.composer;
    let envelope = null;
    if (c) {
      const d = c.getDraft();
      // This chat's agent wrote what is there, even if the user changed it since.
      const mine = Boolean(d.agent && (cid && d.agent.conversationId ? d.agent.conversationId === cid : d.agent.name === name));
      // The user's own words, saved or not: what they typed since the composer opened, a draft they reopened,
      // or an agent draft they changed since. An address they are still typing counts too, though it is no
      // recipient yet (and no edit until they finish it).
      const typing = Object.values(d.pendingRecipients || {}).some(Boolean);
      const theirs = typing || (d.agent ? Boolean(d.agent.edited) : Boolean(d.userEdited || d.mode === 'draft'));
      const fit = await fits(d, id, mode, args, mine, theirs);
      // A reopened draft keeps no record of whether it was a reply or a reply-all, so recipients the agent
      // left out are set for the mode it asked for: a private reply never keeps the old Cc.
      if (fit && d.mode === 'draft' && (mode === 'reply' || mode === 'replyAll') && (args.to === undefined || args.cc === undefined)) {
        const m = await api('get', id).catch(() => null);
        const acc = m && ((S.data && S.data.accounts) || []).find((a) => a.id === m.accountId);
        if (!m || !acc) throw Object.assign(new Error('The email this draft answers could not be loaded.'), { code: 'busy' });
        envelope = replyEnvelope(acc, m, mode);
      }
      // Everything above may have waited. If the composer, its contents or the panel changed in the
      // meantime, decide again; nothing below waits before the write.
      const now = S.composer === c ? c.getDraft() : null;
      const pending = (x) => JSON.stringify(x.pendingRecipients || {});
      if (!now || now.revision !== d.revision || pending(now) !== pending(d) || isBackground() !== background) {
        if (attempt < 2) return writeDraft(args, attempt + 1);
        throw busy();
      }
      // A chat that is not on screen leaves the user's words alone even where it would fit; the chat on
      // screen may rewrite them, because the user just asked it to (and Undo brings their text back).
      if (background && theirs) throw blocked();
      if (!fit) {
        // A chat that is not on screen never replaces what is open, even a clean reply the user opened
        // themselves; the chat on screen does, unless the user (or another agent) wrote in it.
        if (background || ((d.dirty || theirs) && !mine)) throw blocked();
        c = null;
        envelope = null;
      }
    }
    if (!c) {
      // Keeps the chat input focused; a composer with changes is saved as a draft first. The email loads first:
      // if the chat went on or off screen meanwhile, nothing opens and the write is decided again.
      c = await ctx.compose({ mode, id, focus: false, still: () => isBackground() === background });
      if (isBackground() !== background) {
        if (attempt < 2) return writeDraft(args, attempt + 1);
        throw busy();
      }
      if (!c || c !== S.composer) throw Object.assign(new Error('The composer did not open.'), { code: 'busy' });
    }
    const writeKey = `${c.key}:${++writeCount}`;
    // Only what the agent gave: a field it left out stays as it is, an empty list clears it. For a reopened
    // draft, each recipient field the agent left out comes from the reply rules instead.
    const content = { html: args.html, text: args.html == null ? args.text : undefined };
    if (envelope) {
      content.to = envelope.to;
      content.cc = envelope.cc;
    }
    for (const field of ['to', 'cc', 'bcc', 'subject']) if (args[field] !== undefined) content[field] = args[field];
    c.setContent(content, { mode: 'replace', by: { name, conversationId: cid }, writeId: writeKey });
    if (cid) writes.set(writeKey, cid);
    refreshDrafts();
    const d = c.getDraft();
    return { ok: true, draft: { key: writeKey, mode: d.mode, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: d.text } };
  }

  async function bridge(request) {
    // Main gave up on a request the panel only gets now (it was still loading): leave the composer as it is.
    if (expired(request)) return;
    const { requestId, action, args } = request;
    let ok = true;
    let result = null;
    try {
      if (action === 'writeDraft') result = await writeDraft(args || {});
      else if (action === 'getDraft') result = S.composer ? S.composer.getDraft() : null;
      else if (action === 'openMessage') {
        P.keepFor = args && args.messageId;
        await ctx.openMessage(args.messageId);
        result = { ok: true };
      } else throw Object.assign(new Error(`Unknown request: ${action}`), { code: 'protocol' });
    } catch (err) {
      ok = false;
      result = { code: (err && err.code) || 'unknown', detail: String((err && err.message) || err).slice(0, 300) };
    }
    api('agentUiReply', requestId, ok, result).catch(() => {});
  }

  const onEvent = ({ type, payload }) => {
    if (type !== 'agent' || !payload) return;
    switch (payload.kind) {
      case 'conversation':
        return payload.conversation && onConversation(payload.conversation);
      case 'item':
        return payload.item && onItem(payload);
      case 'delta':
        return onDelta(payload);
      case 'trim':
        return onTrim(payload);
      case 'status':
        return onStatus(payload);
      case 'agents':
        P.status = payload.status || P.status;
        return loadAgents();
      case 'ui':
        return bridge(payload);
      case 'reveal':
        return reveal(payload.conversationId);
    }
  };
  window.mail.on(onEvent);
  // Main held a reveal, a waiting approval or a composer request that came before this; it sends them now.
  api('agentPanelReady').catch(() => {});

  // ---------- start ----------

  localizeChrome();
  renderHead();
  buildComposer();
  renderEmpty();
  refreshComposer();
  loadAgents();
  // Open since the last session: follow the email that is already on screen.
  if (ctx.agentOpen()) sync();

  return {
    // The panel became visible: catch up with the email on screen.
    opened({ focus = false } = {}) {
      sync();
      if (focus) chat.focus();
      follow(true);
    },
    // What is on screen changed (an email, the composer): follow it, and let draft cards check their composer.
    sync() {
      refreshDrafts();
      return sync();
    },
    composerClosed,
    inputFocused: () => Boolean(chat && chat.el.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)),
    // False while the agent is not set up or turned off: the input is hidden then.
    inputAvailable: () => Boolean(chat && !chat.el.classList.contains('is-disabled')),
    inputValue: () => (chat ? chat.getValue() : ''),
    relocalize() {
      localizeChrome();
      buildComposer();
      renderHead();
      if (P.conv) renderTranscript();
      else renderEmpty();
      refreshComposer();
    }
  };
}
