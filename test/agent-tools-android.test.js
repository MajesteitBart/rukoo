'use strict';

// Clark's bridge caches one tool list and one set of instructions for every device it finds, a desktop or a phone, so
// Rukoo for Android has to serve the desktop's to the byte. Android's ToolListTest compares its list with the fixture
// below; this test keeps the fixture equal to what the desktop serves, and the copies of the instructions equal to
// the desktop's, so a change on one side fails here until the other side has it too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { list } = require('../src/main/agents/tools');
const mcp = require('../src/main/agents/mcp');
const context = require('../src/main/agents/context');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const FIXTURE = 'android/app/src/test/resources/mcp/desktop-tools-list.json';
const MCP_HANDLER = 'android/app/src/main/java/nl/bvdm/rukoo/mcp/McpHandler.kt';
const TURN_CONTEXT = 'android/app/src/main/java/nl/bvdm/rukoo/agents/TurnContext.kt';
const BRIDGE = 'integrations/hermes/rukoo_bridge.py';

// The double-quoted string literals of an assignment that spans lines, joined: "a " + "b" in Kotlin, ("a " "b") in
// Python. Both escape the way JSON does for the characters these texts use. more(line): whether the next line
// belongs to it too.
function literals(source, start, more) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} is there`);
  const out = [];
  for (const raw of source.slice(from + start.length).split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    const parts = text.match(/"(?:[^"\\]|\\.)*"/g);
    if (!parts) break;
    out.push(...parts.map((p) => JSON.parse(p)));
    if (!more(text)) break;
  }
  return out.join('');
}
const python = (text) => !text.endsWith(')');
const kotlin = (text) => text.endsWith('+');

test("Android's fixture is the desktop's tools.list(null), key order included", () => {
  const fixture = JSON.parse(read(FIXTURE));
  assert.equal(JSON.stringify(fixture.tools), JSON.stringify(list(null)));
  // The phone serves the meeting tools too, after checking their arguments, and answers that it has no meetings.
  assert.deepEqual(
    fixture.tools.map((t) => t.name).slice(-8),
    ['list_events', 'find_free_time', 'create_event', 'get_booking_link', 'read_meeting_transcript', 'search_meetings', 'read_meeting_notes', 'get_meeting_frame']
  );
});

test("the tools' schemas use only what Android's SchemaBuilder can write", () => {
  // Schema.kt writes type, description, maxLength, enum, minimum, maximum, minItems, maxItems, items, properties,
  // required and anyOf. A schema with anything else (number, format, pattern, default) can't be the same there.
  const allowed = new Set(['type', 'description', 'maxLength', 'enum', 'minimum', 'maximum', 'minItems', 'maxItems', 'items', 'properties', 'required', 'anyOf']);
  const types = new Set(['string', 'integer', 'boolean', 'object', 'array']);
  const walk = (s, where) => {
    for (const key of Object.keys(s)) assert.ok(allowed.has(key), `${where}: ${key}`);
    if (s.type !== undefined) assert.ok(types.has(s.type), `${where}: type ${s.type}`);
    for (const [k, sub] of Object.entries(s.properties || {})) walk(sub, `${where}.${k}`);
    if (s.items) walk(s.items, `${where}[]`);
    for (const [i, sub] of (s.anyOf || []).entries()) walk(sub, `${where}|${i}`);
  };
  for (const tool of list(null)) walk(tool.inputSchema, tool.name);
});

test("the bridge's and the phone's MCP instructions are the desktop's, word for word", () => {
  assert.equal(literals(read(BRIDGE), 'INSTRUCTIONS = (', python), mcp.INSTRUCTIONS);
  assert.equal(literals(read(MCP_HANDLER), 'const val INSTRUCTIONS =', kotlin), mcp.INSTRUCTIONS);
  // McpHandlerTest pins the length, so the phone's room for skills is known.
  assert.match(read('android/app/src/test/java/nl/bvdm/rukoo/mcp/McpHandlerTest.kt'), new RegExp(`assertEquals\\(${mcp.INSTRUCTIONS.length}, McpHandler\\.INSTRUCTIONS\\.length\\)`));
});

test("the phone's turn instructions name the same tools and say the same about untrusted content", () => {
  const source = read(TURN_CONTEXT);
  const from = source.indexOf('const val INSTRUCTIONS = """') + 'const val INSTRUCTIONS = """'.length;
  const phone = source.slice(from, source.indexOf('"""', from)).split('\n\n');
  const desktop = context.INSTRUCTIONS.split('\n\n');
  assert.equal(phone[1], desktop[1], 'the tool list');
  assert.equal(phone.at(-1), desktop.at(-1), 'the paragraph on untrusted content');
  // TurnContextTest checks the rest line by line against the desktop's text in this fixture.
  assert.equal(JSON.parse(read('android/app/src/test/resources/agents/context-fixtures.json')).instructions, context.INSTRUCTIONS);
});
