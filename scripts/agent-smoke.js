'use strict';

// Live smoke test of one agent adapter against the real agent, outside Electron:
//   node scripts/agent-smoke.js clark|claude|codex [--all] [--allow]
//
// It starts Rukoo's MCP server (src/main/agents/mcp.js) on a random loopback port behind a minimal hub
// stand-in that offers one tool, get_context, returning a fixed demo email. Then it runs one turn,
// "Call the rukoo get_context tool, then reply with the email subject in five words or fewer.", and
// prints every adapter event and the result.
//
// --all adds a second turn (does the agent remember the first?), an approval turn for Claude and Codex
// (a harmless file write that the script denies, or allows with --allow), and a turn stopped halfway.
// Clark cannot reach this MCP server (its Hermes is not set up for Rukoo), so for Clark the script
// always checks streaming, two-turn session continuity and stop instead.
//
// Clark: key from RUKOO_CLARK_KEY or ~/.rukoo-dev/clark.key, URL from RUKOO_CLARK_URL
// (default http://100.91.52.84:8642). Claude: CLAUDE_CONFIG_DIR as set in the environment.
// Afterwards the script deletes what it created: the Hermes session, the Claude transcript, the Codex thread.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const AGENTS = ['clark', 'claude', 'codex'];
const agent = process.argv[2];
const ALL = process.argv.includes('--all');
const ALLOW = process.argv.includes('--allow');
if (!AGENTS.includes(agent)) {
  console.error('usage: node scripts/agent-smoke.js clark|claude|codex [--all] [--allow]');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'rukoo-agent-smoke');
const WORKSPACE = path.join(WORK, 'workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

const DEMO_EMAIL = {
  id: 'demo:INBOX:42',
  messageId: '<call-thursday@example.com>',
  account: 'demo@rukoo.app',
  folder: 'INBOX',
  from: { name: 'Sanne de Vries', address: 'sanne@example.com' },
  to: [{ name: 'Demo', address: 'demo@rukoo.app' }],
  date: '2026-10-06T09:12:00.000Z',
  subject: 'Call on Thursday about the proposal',
  text: 'Hi,\n\nCan we have a call on Thursday at 10:00 about the proposal? Let me know if that works.\n\nSanne'
};

const GET_CONTEXT = {
  name: 'get_context',
  title: 'Get context',
  description: 'What the user sees in Rukoo Mail right now: the open email and the conversation.',
  inputSchema: { type: 'object', properties: { conversation_id: { type: 'string' } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(8);
const say = (...args) => console.log(stamp(), ...args);
const short = (value, max = 160) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
};

// The parts of AgentHub the adapters and the MCP server use.
class HubStandIn {
  constructor() {
    this.tokens = new Map();
    this.threads = new Map();
    this.calls = [];
  }
  hash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }
  issueToken({ agent: who, conversationId }) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.set(this.hash(token), { agent: who, conversationId: conversationId || null, remote: false });
    return token;
  }
  revokeToken(token) {
    this.tokens.delete(this.hash(token));
  }
  identify(token) {
    return token ? this.tokens.get(this.hash(token)) || null : null;
  }
  mapThread(threadId, conversationId) {
    this.threads.set(threadId, conversationId);
  }
  expireApproval(conversationId, itemId) {
    say('hub.expireApproval', conversationId, itemId);
  }
  listTools() {
    return [GET_CONTEXT];
  }
  async callTool(identity, name, args, meta) {
    const bare = String(name).replace(/^mcp__rukoo__|^mcp_rukoo_/, '');
    this.calls.push({ identity, name, args, meta });
    say(`MCP tools/call ${name} from ${identity.agent}`, short(args), meta && meta.threadId ? `threadId=${meta.threadId}` : '');
    if (bare !== 'get_context') return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    const result = {
      conversation_id: args.conversation_id || identity.conversationId || (meta && this.threads.get(meta.threadId)) || null,
      agent: identity.agent,
      today: new Date().toISOString().slice(0, 10),
      open_message: DEMO_EMAIL,
      composer: null
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }
}

// A tiny stateless MCP endpoint, only used when src/main/agents/mcp.js is not there.
function inlineMcp(hub) {
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });
    const auth = /^Bearer\s+(\S+)/i.exec(req.headers.authorization || '');
    const identity = hub.identify(auth && auth[1]);
    if (!identity) return reply(401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (msg.id === undefined) return reply(202);
      const ok = (result) => reply(200, { jsonrpc: '2.0', id: msg.id, result });
      const p = msg.params || {};
      if (msg.method === 'initialize') {
        return ok({ protocolVersion: p.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'rukoo', version: 'smoke' } });
      }
      if (msg.method === 'ping') return ok({});
      if (msg.method === 'tools/list') return ok({ tools: hub.listTools(identity) });
      if (msg.method === 'tools/call') return ok(await hub.callTool(identity, p.name, p.arguments || {}, p._meta || {}));
      reply(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    });
  });
  return {
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve())))
  };
}

async function startMcp(hub) {
  let McpServer = null;
  try {
    ({ McpServer } = require(path.join(ROOT, 'src', 'main', 'agents', 'mcp.js')));
  } catch {}
  if (McpServer) {
    const server = new McpServer({ hub, version: 'smoke', log: (...a) => say('mcp:', ...a) });
    const port = await server.listen({ host: '127.0.0.1', port: 0 });
    return { port, close: () => server.close(), kind: 'src/main/agents/mcp.js' };
  }
  const server = inlineMcp(hub);
  const port = await server.listen();
  return { port, close: () => server.close(), kind: 'inline stand-in' };
}

function instructions(name) {
  try {
    return require(path.join(ROOT, 'src', 'main', 'agents', 'context.js')).instructions({ agent, agentName: name });
  } catch {
    return 'You are working inside Rukoo Mail, the user\'s desktop email client. Rukoo gives you an MCP server called "rukoo". Keep answers short.';
  }
}

function clarkConfig() {
  const keyFile = path.join(os.homedir(), '.rukoo-dev', 'clark.key');
  const key = (process.env.RUKOO_CLARK_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '')).trim();
  if (!key) throw new Error(`No Clark key: set RUKOO_CLARK_KEY or create ${keyFile}`);
  return { enabled: true, name: 'Clark', url: process.env.RUKOO_CLARK_URL || 'http://100.91.52.84:8642', key, model: '' };
}

function makeAdapter(hub) {
  const log = (...args) => say('log:', ...args.map((a) => (a instanceof Error ? a.message : a)));
  const paths = { workspace: WORKSPACE };
  if (agent === 'clark') {
    const { HermesAdapter } = require(path.join(ROOT, 'src', 'main', 'agents', 'hermes.js'));
    const config = clarkConfig();
    return { adapter: new HermesAdapter({ id: 'clark', config: () => config, hub, log, paths }), name: 'Clark' };
  }
  if (agent === 'claude') {
    const { ClaudeAdapter } = require(path.join(ROOT, 'src', 'main', 'agents', 'claude.js'));
    const config = { enabled: true, exe: '', configDir: process.env.CLAUDE_CONFIG_DIR || '', model: '', access: 'ask' };
    return { adapter: new ClaudeAdapter({ id: 'claude', config: () => config, hub, log, paths }), name: 'Claude' };
  }
  const { CodexAdapter } = require(path.join(ROOT, 'src', 'main', 'agents', 'codex.js'));
  const config = { enabled: true, exe: '', model: '', access: 'ask' };
  return { adapter: new CodexAdapter({ id: 'codex', config: () => config, hub, log, paths }), name: 'Codex' };
}

// Runs one turn and prints its events. stopAfter: abort once that many text characters arrived.
async function runTurn({ adapter, hub, conversation, mcpPort, name }, input, { stopAfter = 0 } = {}) {
  const controller = new AbortController();
  const stats = { text: '', events: {}, approvals: 0, tools: [] };
  let line = '';
  const flush = () => {
    if (line) say(`  text  ${JSON.stringify(line)}`);
    line = '';
  };
  const token = conversation.token || (conversation.token = hub.issueToken({ agent, conversationId: conversation.id }));
  const turn = {
    id: `t_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    conversation,
    input,
    instructions: instructions(name),
    mcp: { url: `http://127.0.0.1:${mcpPort}/mcp`, token },
    signal: controller.signal,
    emit(event) {
      stats.events[event.type] = (stats.events[event.type] || 0) + 1;
      if (event.type === 'text') {
        stats.text += event.delta;
        line += event.delta;
        if (line.includes('\n') || line.length > 100) flush();
        if (stopAfter && stats.text.length >= stopAfter && !controller.signal.aborted) {
          flush();
          say('  -> stopping the turn (turn.signal.abort())');
          controller.abort();
        }
        return;
      }
      flush();
      if (event.type === 'thinking') {
        if (event.delta) say(`  thinking ${JSON.stringify(short(event.delta, 120))}`);
        else say('  thinking (started)');
        return;
      }
      if (event.type === 'tool-start') stats.tools.push(event.name);
      if (event.type === 'usage') return say(`  usage ${short(event, 200)}`);
      say(`  ${event.type}`, short({ ...event, type: undefined }, 220));
    },
    approve(request) {
      flush();
      stats.approvals++;
      say('  approval', short(request, 400));
      const choice = ALLOW ? request.choices.find((c) => c.kind === 'primary').id : request.choices.find((c) => c.kind === 'danger').id;
      say(`  -> answering ${choice}`);
      const promise = new Promise((resolve) => setTimeout(() => resolve(choice), 300));
      promise.itemId = `i_smoke_${stats.approvals}`;
      return promise;
    },
    setProvider(patch) {
      Object.assign(conversation.provider, patch);
      say('  setProvider', short(patch));
    }
  };
  say(`turn: ${JSON.stringify(short(input, 120))}`);
  const started = Date.now();
  const result = await adapter.runTurn(turn);
  flush();
  say(`result ${JSON.stringify(result)} in ${((Date.now() - started) / 1000).toFixed(1)} s; events ${JSON.stringify(stats.events)}`);
  return { result, ...stats };
}

async function cleanup({ adapter, conversation }) {
  const provider = conversation.provider;
  if (agent === 'clark' && provider.sessionId) {
    const res = await adapter.request('DELETE', `/api/sessions/${encodeURIComponent(provider.sessionId)}`).catch((err) => ({ status: err.message }));
    say(`cleanup: deleted Hermes session ${provider.sessionId}: HTTP ${res.status}`);
  }
  if (agent === 'claude' && provider.sessionId) {
    await adapter.dispose();
    await new Promise((r) => setTimeout(r, 1500));
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const project = path.join(configDir, 'projects', WORKSPACE.replace(/[^A-Za-z0-9]/g, '-'));
    for (const entry of [`${provider.sessionId}.jsonl`, provider.sessionId]) {
      const file = path.join(project, entry);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { recursive: true, force: true });
        say(`cleanup: removed ${file}`);
      }
    }
    try {
      if (fs.existsSync(project) && fs.readdirSync(project).length === 0) fs.rmdirSync(project);
    } catch {}
  }
  if (agent === 'codex' && provider.threadId) {
    // thread/delete hangs while the thread is loaded in the process that ran it; a fresh app-server
    // deletes it in a second or two.
    await adapter.dispose();
    await new Promise((r) => setTimeout(r, 1000));
    const server = await adapter.ensureServer(await adapter.exe(), { mcp: {} });
    const res = await server.request('thread/delete', { threadId: provider.threadId }, 60000).then(() => 'ok', (err) => err.message);
    say(`cleanup: thread/delete ${provider.threadId}: ${res}`);
  }
}

async function main() {
  const hub = new HubStandIn();
  const mcp = await startMcp(hub);
  const { adapter, name } = makeAdapter(hub);
  say(`${agent}: MCP server (${mcp.kind}) on 127.0.0.1:${mcp.port}`);
  say(`status: ${JSON.stringify(await adapter.status())}`);
  const conversation = { id: `c_smoke_${Date.now().toString(36)}`, agent, title: 'Rukoo smoke test', provider: {}, items: [], notes: [], message: null };
  const ctx = { adapter, hub, conversation, mcpPort: mcp.port, name };
  const checks = [];
  const check = (label, ok, extra = '') => {
    checks.push({ label, ok });
    say(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' ' + extra : ''}`);
  };
  try {
    if (agent === 'clark') {
      const t1 = await runTurn(ctx, 'This is a short test from Rukoo. Remember the word mango. Reply with just OK.');
      check('turn 1 streams and completes', t1.result.status === 'done' && t1.text.length > 0);
      check('turn 1 created a Hermes session', Boolean(conversation.provider.sessionId), conversation.provider.sessionId);
      const t2 = await runTurn(ctx, 'Which word did I ask you to remember? Reply with just that word.');
      check('turn 2 remembers turn 1 (same session)', t2.result.status === 'done' && /mango/i.test(t2.text), JSON.stringify(t2.text.trim()));
      const t3 = await runTurn(ctx, 'Count from 1 to 300 in English words, one number per line. Do not use any tools.', { stopAfter: 40 });
      check('turn 3 stops when asked', t3.result.status === 'stopped');
    } else {
      const t1 = await runTurn(ctx, 'Call the rukoo get_context tool, then reply with the email subject in five words or fewer.');
      const called = hub.calls.some((c) => /get_context$/.test(c.name));
      check('turn 1 completes', t1.result.status === 'done');
      check('turn 1 called rukoo get_context over MCP', called);
      check('turn 1 answer names the subject', /thursday|proposal|call/i.test(t1.text), JSON.stringify(t1.text.trim()));
      if (agent === 'codex') check('Codex tool call carried the mapped thread id', hub.calls.some((c) => c.meta && hub.threads.get(c.meta.threadId) === conversation.id));
      if (ALL) {
        const t2 = await runTurn(ctx, 'Which subject did you just report? Repeat it exactly, nothing else.');
        check('turn 2 remembers turn 1', t2.result.status === 'done' && /thursday|proposal|call/i.test(t2.text), JSON.stringify(t2.text.trim()));
        const t3 = await runTurn(ctx, 'Use a shell command to create a file named rukoo-smoke.txt containing the word hi in the current folder. If you are not allowed, say so in one sentence.');
        check('turn 3 asked for approval through Rukoo', t3.approvals > 0 && t3.result.status !== 'error', `(${t3.approvals} card(s), ${ALLOW ? 'allowed' : 'denied'})`);
        const t4 = await runTurn(ctx, 'Write the numbers from 1 to 300 in English words, one per line. Do not use any tools.', { stopAfter: 40 });
        check('turn 4 stops when asked', t4.result.status === 'stopped');
        const t5 = await runTurn(ctx, 'Reply with just the word "back".');
        check('turn 5 works after the stop', t5.result.status === 'done' && /back/i.test(t5.text));
      }
    }
  } finally {
    await cleanup(ctx).catch((err) => say('cleanup failed:', err.message));
    await adapter.dispose();
    await mcp.close();
    try {
      fs.rmSync(path.join(WORKSPACE, 'rukoo-smoke.txt'), { force: true });
    } catch {}
  }
  const failed = checks.filter((c) => !c.ok);
  say(failed.length ? `${failed.length} of ${checks.length} checks failed` : `all ${checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
