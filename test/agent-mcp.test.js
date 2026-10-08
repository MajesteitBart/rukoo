'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { McpServer } = require('../src/main/agents/mcp');
const { AgentHub } = require('../src/main/agents/hub');
const { Engine } = require('../src/main/engine');

const LOCAL = 'local-token';
const REMOTE = 'remote-token';

function fakeHub() {
  const calls = [];
  return {
    calls,
    identify: (t) =>
      t === LOCAL ? { agent: 'claude', conversationId: 'c1', remote: false } : t === REMOTE ? { agent: 'clark', conversationId: null, remote: true } : null,
    listTools: () => [{ name: 'echo', title: 'Echo', description: 'Echoes', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
    callTool: async (identity, name, args, meta) => {
      calls.push({ identity, name, args, meta });
      if (name === 'boom') throw new Error('kaput');
      if (name !== 'echo') return { content: [{ type: 'text', text: `Unknown tool "${name}"` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(args) }], structuredContent: args };
    }
  };
}

function request(port, { method = 'POST', path: p = '/mcp', headers = {}, body, token = LOCAL } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const h = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    if (data) h['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

async function withServer(fn, hub = fakeHub()) {
  const server = new McpServer({ hub, version: '9.9.9' });
  const port = await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    await fn(port, hub, server);
  } finally {
    await server.close();
  }
}

test('initialize echoes a known protocol version and falls back for unknown ones', () =>
  withServer(async (port) => {
    const res = await request(port, { body: rpc(0, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x' } }) });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['mcp-session-id'], undefined, 'stateless: never a session id');
    assert.equal(res.json.id, 0);
    assert.equal(res.json.result.protocolVersion, '2025-11-25');
    assert.deepEqual(res.json.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(res.json.result.serverInfo, { name: 'rukoo', title: 'Rukoo Mail', version: '9.9.9' });
    assert.match(res.json.result.instructions, /untrusted/);
    const codex = await request(port, { body: rpc(1, 'initialize', { protocolVersion: '2025-06-18' }) });
    assert.equal(codex.json.result.protocolVersion, '2025-06-18');
    const future = await request(port, { body: rpc(2, 'initialize', { protocolVersion: '2026-07-28' }) });
    assert.equal(future.json.result.protocolVersion, '2025-06-18');
  }));

test('notifications get 202 with an empty body; requests never do', () =>
  withServer(async (port) => {
    for (const method of ['notifications/initialized', 'notifications/cancelled']) {
      const res = await request(port, { body: { jsonrpc: '2.0', method, params: { requestId: 2 } } });
      assert.equal(res.status, 202, method);
      assert.equal(res.text, '');
    }
    const ping = await request(port, { body: rpc(7, 'ping') });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.json, { jsonrpc: '2.0', id: 7, result: {} });
  }));

test('server/discover and unknown methods are JSON-RPC -32601', () =>
  withServer(async (port) => {
    const discover = await request(port, { body: rpc(0, 'server/discover', { _meta: {} }), headers: { 'mcp-method': 'server/discover' } });
    assert.equal(discover.status, 200);
    assert.equal(discover.json.error.code, -32601);
    const other = await request(port, { body: rpc(3, 'resources/list') });
    assert.equal(other.json.error.code, -32601);
  }));

test('only POST /mcp: other methods 405, other paths 404, JSON bodies', () =>
  withServer(async (port) => {
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await request(port, { method });
      assert.equal(res.status, 405, method);
      assert.match(res.headers['content-type'], /application\/json/);
      assert.equal(res.headers.allow, 'POST');
    }
    const head = await request(port, { method: 'HEAD' });
    assert.equal(head.status, 405);
    const other = await request(port, { path: '/other', body: rpc(1, 'ping') });
    assert.equal(other.status, 404);
    const query = await request(port, { path: '/mcp?x=1', body: rpc(1, 'ping') });
    assert.equal(query.status, 200, 'a query string is fine');
  }));

test('DNS rebinding guard: any Origin or a foreign Host is refused', () =>
  withServer(async (port) => {
    const origin = await request(port, { body: rpc(1, 'ping'), headers: { origin: 'https://evil.example' } });
    assert.equal(origin.status, 403);
    const nullOrigin = await request(port, { body: rpc(1, 'ping'), headers: { origin: 'null' } });
    assert.equal(nullOrigin.status, 403);
    const host = await request(port, { body: rpc(1, 'ping'), headers: { host: `evil.example:${port}` } });
    assert.equal(host.status, 403);
    const wrongPort = await request(port, { body: rpc(1, 'ping'), headers: { host: `127.0.0.1:${port + 1}` } });
    assert.equal(wrongPort.status, 403);
    const localhost = await request(port, { body: rpc(1, 'ping'), headers: { host: `localhost:${port}` } });
    assert.equal(localhost.status, 200);
  }));

test('a missing or unknown bearer token is 401; remote tokens are refused on loopback', () =>
  withServer(async (port) => {
    const none = await request(port, { body: rpc(1, 'ping'), token: null });
    assert.equal(none.status, 401);
    assert.deepEqual(none.json, { error: 'unauthorized' });
    const bad = await request(port, { body: rpc(1, 'ping'), token: 'nope' });
    assert.equal(bad.status, 401);
    const remote = await request(port, { body: rpc(1, 'ping'), token: REMOTE });
    assert.equal(remote.status, 401);
  }));

test('a remote listener takes only remote tokens', async () => {
  const server = new McpServer({ hub: fakeHub() });
  await server.listen({ host: '127.0.0.1', port: 0, remote: false });
  const port = await server.listen({ host: '127.0.0.1', port: 0, remote: true });
  try {
    assert.equal(server.ports().remote, port);
    assert.equal((await request(port, { body: rpc(1, 'ping'), token: LOCAL })).status, 401);
    assert.equal((await request(port, { body: rpc(1, 'ping'), token: REMOTE })).status, 200);
    await server.closeRemote();
    assert.equal(server.ports().remote, null);
    assert.ok(server.ports().local);
  } finally {
    await server.close();
  }
});

test("the remote listener proves it has the key when asked, and tells the bridge about itself", async () => {
  const hub = { ...fakeHub(), proof: (c) => `proof-of-${c}`, hello: (identity, params) => ({ owns: params.conversation_id === 'c1', idle: 5, agent: identity.agent }) };
  const server = new McpServer({ hub });
  const local = await server.listen({ host: '127.0.0.1', port: 0, remote: false });
  const port = await server.listen({ host: '127.0.0.1', port: 0, remote: true });
  const ask = (p, challenge) => request(p, { body: rpc(1, 'ping'), token: null, headers: { 'x-rukoo-challenge': challenge } });
  try {
    const challenge = 'abcdefghijklmnop_-12';
    const asked = await ask(port, challenge);
    assert.equal(asked.status, 401, 'a proof is no way in');
    assert.deepEqual(asked.json, { error: 'unauthorized' });
    assert.equal(asked.headers['x-rukoo-proof'], `proof-of-${challenge}`);
    assert.equal((await ask(port, 'short')).headers['x-rukoo-proof'], undefined);
    assert.equal((await ask(port, 'abcdefghijklmnop.%')).headers['x-rukoo-proof'], undefined);
    assert.equal((await ask(port, 'x'.repeat(129))).headers['x-rukoo-proof'], undefined);
    assert.equal((await ask(local, challenge)).headers['x-rukoo-proof'], undefined, 'only on the Tailscale listener');
    hub.proof = () => '';
    assert.equal((await ask(port, challenge)).headers['x-rukoo-proof'], 'none', 'Rukoo without an API key says so');

    const hello = await request(port, { body: rpc(2, 'rukoo/hello', { conversation_id: 'c1' }), token: REMOTE });
    assert.equal(hello.status, 200);
    assert.deepEqual(hello.json.result, { owns: true, idle: 5, agent: 'clark' });
    assert.equal((await request(port, { body: rpc(3, 'rukoo/hello'), token: null })).status, 401);
  } finally {
    await server.close();
  }
});

test('tools/list and tools/call: happy path, unknown tool and a throwing handler', () =>
  withServer(async (port, hub) => {
    const list = await request(port, { body: rpc(1, 'tools/list', { _meta: { progressToken: 0 } }) });
    assert.equal(list.json.result.tools[0].name, 'echo');
    const ok = await request(port, { body: rpc(2, 'tools/call', { name: 'echo', arguments: { text: 'één café ✓' }, _meta: { threadId: 'th1' } }) });
    assert.equal(ok.json.result.isError, undefined);
    assert.deepEqual(ok.json.result.structuredContent, { text: 'één café ✓' });
    assert.equal(hub.calls[0].meta.threadId, 'th1');
    assert.equal(hub.calls[0].identity.conversationId, 'c1');
    const unknown = await request(port, { body: rpc(3, 'tools/call', { name: 'nope', arguments: {} }) });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.result.isError, true, 'tool problems are results, not JSON-RPC errors');
    const boom = await request(port, { body: rpc(4, 'tools/call', { name: 'boom' }) });
    assert.equal(boom.json.result.isError, true);
    assert.match(boom.json.result.content[0].text, /kaput/);
  }));

test('bodies over 2 MB get 413; batches and bad JSON get 400', () =>
  withServer(async (port) => {
    const big = JSON.stringify(rpc(1, 'tools/call', { name: 'echo', arguments: { text: 'x'.repeat(2 * 1024 * 1024) } }));
    const res = await request(port, { body: big });
    assert.equal(res.status, 413);
    const batch = await request(port, { body: [rpc(1, 'ping'), rpc(2, 'ping')] });
    assert.equal(batch.status, 400);
    assert.equal(batch.json.error.code, -32600);
    const broken = await request(port, { body: '{"jsonrpc":' });
    assert.equal(broken.status, 400);
    assert.equal(broken.json.error.code, -32700);
  }));

// A body sent in chunks with no Content-Length, the way a streaming client uploads.
function chunked(port, size) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/mcp', agent: false, headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL}`, 'transfer-encoding': 'chunked' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    const piece = Buffer.alloc(64 * 1024, 'x');
    for (let sent = 0; sent < size; sent += piece.length) req.write(piece);
    req.end();
  });
}

test('oversized bodies are read to the end, so the client gets the 413 and not a reset', () =>
  withServer(async (port) => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const statuses = await Promise.all(Array.from({ length: 8 }, () => request(port, { body: big }).then((r) => r.status)));
    assert.deepEqual(statuses, Array(8).fill(413));
    assert.equal((await request(port, { body: 'x'.repeat(10 * 1024 * 1024) })).status, 413);
    assert.equal(await chunked(port, 3 * 1024 * 1024), 413);
    assert.equal(await chunked(port, 10 * 1024 * 1024), 413);
    assert.equal((await request(port, { body: rpc(1, 'ping') })).status, 200, 'the server still answers');
  }));

test('end to end: a real hub on a demo engine answers initialize, tools/list and get_context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-mcp-'));
  const engine = new Engine({ dataDir: dir }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  // Port 0 in agents.json is out of range, so write a free high port instead of the default 47800.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ mcp: { port: free < 1024 ? 47899 : free } }));
  const hub = new AgentHub({ engine, dataDir: dir, deps: { appVersion: '1.2.3' }, adapters: {} });
  await hub.start();
  try {
    const port = hub.mcp.ports().local;
    assert.ok(port);
    const call = engine.listMessages({ view: 'inbox' }).find((m) => m.subject === 'Call on Thursday');
    hub.view({ openMessageId: call.id, checkedIds: [], scope: 'all', view: 'inbox', folder: null, composer: null });
    const c = hub.create({ agent: 'claude', message: { id: call.id } });
    const token = hub.tokenFor(c);
    const init = await request(port, { token, body: rpc(0, 'initialize', { protocolVersion: '2025-11-25' }) });
    assert.equal(init.json.result.serverInfo.version, '1.2.3');
    assert.equal((await request(port, { token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
    const list = await request(port, { token, body: rpc(1, 'tools/list') });
    assert.deepEqual(
      list.json.result.tools.map((t) => t.name),
      ['get_context', 'search_mail', 'read_message', 'read_attachment', 'write_draft', 'get_draft', 'show_plan', 'show_sources', 'propose_action', 'mail_action']
    );
    for (const t of list.json.result.tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.equal(t.annotations.openWorldHint, false, t.name);
    }
    const ctx = await request(port, { token, body: rpc(2, 'tools/call', { name: 'get_context', arguments: {} }) });
    const data = JSON.parse(ctx.json.result.content[0].text);
    assert.equal(data.conversation_id, c.id, 'the per-conversation token resolves the conversation');
    // Text from the email carries its tags in the JSON text too; the Message-ID stays usable as it is.
    assert.equal(data.open_message.subject, '<unsafe_content>Call on Thursday</unsafe_content>');
    assert.equal(data.open_message.message_id_header, '<demo-13@example.com>');
    assert.ok(data.thread.some((m) => m.subject === '<unsafe_content>Re: Call on Thursday</unsafe_content>'));
    hub.revokeToken(token);
    assert.equal((await request(port, { token, body: rpc(3, 'ping') })).status, 401);
  } finally {
    await hub.dispose();
    await engine.close();
  }
});
