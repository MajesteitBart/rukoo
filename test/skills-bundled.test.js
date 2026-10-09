'use strict';

// The skills Rukoo ships in skills/, loaded the way the app loads them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Skills, instructions, toolDescription, DESCRIPTION_MAX, MCP_TEXT_MAX, NAME_MAX } = require('../src/main/agents/skills');
const { skillTurn, SKILL_TURN_MAX } = require('../src/main/agents/context');
const { TOOL_NAMES } = require('../src/main/agents/tools');

const BUNDLED = path.join(__dirname, '..', 'skills');
const folders = fs.readdirSync(BUNDLED).filter((f) => !f.startsWith('.') && fs.statSync(path.join(BUNDLED, f)).isDirectory());

test('every bundled skill loads: none is skipped, each name is its folder, each description fits', () => {
  assert.ok(folders.length > 0, 'skills/ has skills');
  const logged = [];
  const { skills, skipped } = new Skills({ bundled: BUNDLED, user: null, log: (line) => logged.push(line) }).load();
  assert.deepEqual(skipped, []);
  assert.deepEqual(logged, []);
  assert.deepEqual([...skills.keys()].sort(), [...folders].sort());
  for (const skill of skills.values()) {
    assert.equal(skill.source, 'rukoo');
    assert.ok(skill.name.length <= NAME_MAX);
    assert.ok(skill.description.length >= 40 && skill.description.length <= DESCRIPTION_MAX, `${skill.name}: description of ${skill.description.length} characters`);
    assert.ok(skill.body.length > 0, `${skill.name} has instructions`);
    // Started with /name, the whole body goes along in the message instead of a pointer to read_skill.
    assert.ok(skill.body.length <= SKILL_TURN_MAX, `${skill.name}: body of ${skill.body.length} characters`);
    assert.ok(skillTurn(skill).endsWith(skill.body));
  }
});

test("Rukoo's own skills are listed in full, never shortened, in the MCP instructions and in read_skill's description", () => {
  const list = new Skills({ bundled: BUNDLED, user: null }).list();
  const text = instructions(list);
  const tool = toolDescription(list);
  assert.ok(text.length <= MCP_TEXT_MAX && tool.length <= MCP_TEXT_MAX);
  for (const s of list) {
    assert.ok(text.includes(`- ${s.name}: ${s.description}`), `${s.name} in the instructions`);
    assert.ok(tool.includes(`- ${s.name}: ${s.description}`), `${s.name} in read_skill's description`);
  }
});

test('a bundled skill only names tools Rukoo has', () => {
  const list = new Skills({ bundled: BUNDLED, user: null }).list();
  for (const s of list) {
    // Backticked snake_case words that look like tool names: read_message, mail_action and so on.
    const named = [...s.body.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]);
    const tools = named.filter((n) => /^(get|search|read|write|show|propose|mail)_/.test(n));
    for (const t of tools) assert.ok(TOOL_NAMES.includes(t), `${s.name} names ${t}, which is not one of Rukoo's tools`);
  }
});
