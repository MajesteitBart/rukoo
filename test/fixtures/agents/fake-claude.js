'use strict';

// Stands in for `claude -p --input-format stream-json --output-format stream-json` in the adapter tests.
// It answers each stdin user message with JSONL recorded from Claude Code 2.1.291 (trimmed), choosing
// the script by the message text. FAKE_CLAUDE_LOG, when set, receives argv/env and every stdin line.
const fs = require('fs');
const crypto = require('crypto');

const args = process.argv.slice(2);
const log = process.env.FAKE_CLAUDE_LOG;
const note = (entry) => log && fs.appendFileSync(log, JSON.stringify(entry) + '\n');
note({ argv: args, env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null, CLAUDECODE: process.env.CLAUDECODE || null, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || null }, cwd: process.cwd() });

const flag = (name) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const resume = flag('resume');
const sessionId = resume || flag('session-id') || crypto.randomUUID();

const out = (msg) => process.stdout.write(JSON.stringify({ ...msg, session_id: sessionId, uuid: crypto.randomUUID() }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (resume === '00000000-0000-4000-8000-000000000000') {
  // What the CLI does for an unknown session id.
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, result: '', errors: [`No conversation found with session ID: ${resume}`] });
  process.exit(1);
}

let pending = null; // resolves with the next control_response for a can_use_tool request
let interrupted = null; // resolves when an interrupt control_request arrives
let resolveInterrupt = null;
let interruptRequested = false;

const stream = (event) => out({ type: 'stream_event', event, parent_tool_use_id: null });
const init = () => out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Bash', 'mcp__rukoo__get_context'], mcp_servers: [{ name: 'rukoo', status: 'connected' }], model: 'claude-opus-5-5', permissionMode: 'default', apiKeySource: 'none', claude_code_version: '2.1.291' });
const result = (fields = {}) => out({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 1, duration_ms: 10, stop_reason: 'end_turn', total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 5 }, terminal_reason: 'completed', ...fields });

async function textBlock(index, parts, delay = 0) {
  stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  for (const text of parts) {
    if (interruptRequested) return false;
    stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
    if (delay) await sleep(delay);
  }
  stream({ type: 'content_block_stop', index });
  return true;
}

async function hello() {
  stream({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking the email.' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } });
  stream({ type: 'content_block_stop', index: 0 });
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_ctx', name: 'mcp__rukoo__get_context', input: {} } });
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"conversation_id":"c_1"}' } });
  stream({ type: 'content_block_stop', index: 1 });
  out({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ctx', name: 'mcp__rukoo__get_context', input: { conversation_id: 'c_1' } }] }, parent_tool_use_id: null });
  stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  stream({ type: 'message_stop' });
  out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_ctx', type: 'tool_result', content: [{ type: 'text', text: '{"open_message":null}' }] }] }, parent_tool_use_id: null });
  // A subagent's own stream must not reach the transcript.
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUBAGENT' } }, parent_tool_use_id: 'toolu_task' });
  stream({ type: 'message_start', message: { id: 'msg_2', role: 'assistant', content: [] } });
  await textBlock(0, ['Hel', 'lo ', 'één ✓']);
  out({ type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Hello één ✓' }] }, parent_tool_use_id: null });
  stream({ type: 'message_stop' });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } });
  result({ result: 'Hello één ✓' });
}

async function approve() {
  stream({ type: 'message_start', message: { id: 'msg_3', role: 'assistant', content: [] } });
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} } });
  stream({ type: 'content_block_stop', index: 0 });
  const input = { command: 'echo hi > out.txt', description: 'Write a file' };
  out({ type: 'assistant', message: { id: 'msg_3', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input }] }, parent_tool_use_id: null });
  const requestId = 'req-can-use-1';
  const answer = new Promise((resolve) => (pending = { requestId, resolve }));
  out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input, description: 'Write a file', tool_use_id: 'toolu_bash' } });
  const reply = await answer;
  const allowed = reply.response.response.behavior === 'allow';
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: allowed ? 'hi' : reply.response.response.message, is_error: !allowed }] }, parent_tool_use_id: null });
  stream({ type: 'message_start', message: { id: 'msg_4', role: 'assistant', content: [] } });
  await textBlock(0, [allowed ? 'allowed' : 'denied']);
  result();
}

// "approve tool {json}": a permission request for any tool, {tool_name, input, description?}.
async function approveTool(spec) {
  const requestId = 'req-tool-1';
  const answer = new Promise((resolve) => (pending = { requestId, resolve }));
  out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: spec.tool_name, display_name: spec.tool_name, input: spec.input, description: spec.description, tool_use_id: 'toolu_any' } });
  const reply = await answer;
  stream({ type: 'message_start', message: { id: 'msg_t', role: 'assistant', content: [] } });
  await textBlock(0, [reply.response.response.behavior === 'allow' ? 'allowed' : 'denied']);
  result();
}

async function slow() {
  stream({ type: 'message_start', message: { id: 'msg_5', role: 'assistant', content: [] } });
  const parts = Array.from({ length: 200 }, (_, i) => `${i} `);
  await Promise.race([textBlock(0, parts, 20), interrupted]);
  if (!interruptRequested) return result();
  out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '' });
}

async function cancelApproval() {
  const answer = new Promise((resolve) => (pending = { requestId: 'req-can-use-2', resolve }));
  out({ type: 'control_request', request_id: 'req-can-use-2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'C:\\x.txt', content: 'x' }, tool_use_id: 'toolu_w' } });
  await Promise.race([answer, interrupted]);
  out({ type: 'control_cancel_request', request_id: 'req-can-use-2' });
  result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: '' });
}

async function turn(text) {
  interruptRequested = false;
  interrupted = new Promise((resolve) => (resolveInterrupt = resolve));
  init();
  if (text.startsWith('approve tool ')) return approveTool(JSON.parse(text.slice('approve tool '.length)));
  if (/crash/.test(text)) {
    stream({ type: 'message_start', message: { id: 'msg_c', role: 'assistant', content: [] } });
    await textBlock(0, ['partial']);
    process.stderr.write('Error: boom\n');
    process.exit(3);
  }
  if (/hang/.test(text)) return; // never answers, not even an interrupt
  if (/fail/.test(text)) return result({ subtype: 'success', is_error: true, result: 'API Error: 429 rate limit reached', api_error_status: 429 });
  if (/approve/.test(text)) return approve();
  if (/slow/.test(text)) return slow();
  if (/cancel/.test(text)) return cancelApproval();
  return hello();
}

let queue = Promise.resolve();
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    note({ stdin: line });
    const msg = JSON.parse(line);
    if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'interrupt') {
      interruptRequested = true;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
      if (resolveInterrupt) resolveInterrupt();
    } else if (msg.type === 'control_response') {
      if (pending && msg.response.request_id === pending.requestId) pending.resolve(msg);
    } else if (msg.type === 'user') {
      const text = msg.message.content.map((c) => c.text).join('');
      queue = queue.then(() => turn(text));
    }
  }
});
process.stdin.on('end', () => queue.then(() => process.exit(0)));
