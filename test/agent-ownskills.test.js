'use strict';

// The agents' own skills (ownskills.js, the hub's $ mentions) and the shortcuts the user keeps in agents.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mentionsIn, claudeDispatch, claudeSkills, cleanList } = require('../src/main/agents/ownskills');
const { AgentConfig } = require('../src/main/agents/config');
const { AgentHub } = require('../src/main/agents/hub');
const { Engine } = require('../src/main/engine');

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function skill(root, name, frontmatter, body = 'Do the thing.') {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), frontmatter === null ? body : `---\n${frontmatter}\n---\n${body}\n`);
}

// ---------- mentions ----------

test('$name counts at the start of a word and up to a space or punctuation, for a skill the agent has; amounts never do', () => {
  const names = ['pdf', 'humanizer', 'codex:rescue', 'h2'];
  assert.deepEqual(mentionsIn('$pdf then $humanizer', names), [
    { name: 'pdf', start: 0, end: 4 },
    { name: 'humanizer', start: 10, end: 20 }
  ]);
  assert.deepEqual(mentionsIn('use $codex:rescue now', names).map((m) => m.name), ['codex:rescue']);
  // Not a skill: an amount, an unknown name, inside a word, or glued to more text.
  assert.deepEqual(mentionsIn('it costs $50, a$pdf, $unknown and $pdf/x', names), []);
  assert.deepEqual(mentionsIn('Try $pdf, then $humanizer.', names).map((m) => m.name), ['pdf', 'humanizer']);
  assert.deepEqual(mentionsIn('$h2', names).map((m) => m.name), ['h2']);
});

test('Claude Code starts the last named skill from the last block; earlier ones read /name', () => {
  assert.deepEqual(claudeDispatch('first $pdf then $humanizer this please', ['pdf', 'humanizer']), { leading: 'first /pdf then', command: '/humanizer this please', name: 'humanizer' });
  assert.deepEqual(claudeDispatch('$humanizer', ['humanizer']), { leading: '', command: '/humanizer', name: 'humanizer' });
  assert.deepEqual(claudeDispatch('Try $humanizer, on this', ['humanizer']), { leading: 'Try', command: '/humanizer , on this', name: 'humanizer' });
  assert.equal(claudeDispatch('no skill here, $5', ['humanizer']), null);
});

// ---------- Claude Code's folders ----------

test("Claude Code's skills: the user's, the project's and enabled plugins', named as the CLI names them", () => {
  const config = tmp('rukoo-claude-cfg-');
  const cwd = tmp('rukoo-claude-ws-');
  const user = path.join(config, 'skills');
  skill(user, 'pdf', 'name: pdf\ndescription: Read and edit PDF files.');
  // Claude Code names a skill after its folder, not the frontmatter name.
  skill(user, 'probe-alias', 'name: something-else\ndescription: Named after its folder.');
  skill(user, 'model-only', 'name: model-only\ndescription: Only for the model.\nuser-invocable: false');
  skill(user, 'switched-off', 'name: switched-off\ndescription: Off in settings.');
  skill(user, 'off-here', 'name: off-here\ndescription: Off in the workspace settings.');
  skill(user, 'off-managed', 'name: off-managed\ndescription: Off in the managed settings.');
  skill(user, 'broken', 'name: broken\ndescription: "never closed');
  skill(user, 'plain', null, 'No frontmatter at all.');
  fs.mkdirSync(path.join(user, 'empty-folder'));
  fs.mkdirSync(path.join(user, '.trash'));
  skill(path.join(cwd, '.claude', 'skills'), 'pdf', 'name: pdf\ndescription: The project copy, which the user copy wins over.');
  skill(path.join(cwd, '.claude', 'skills'), 'deploy', 'name: deploy\ndescription: >\n  Deploy the project,\n  folded over lines.');
  const plugin = path.join(config, 'plugins', 'cache', 'm', 'tools', '1.0.0');
  skill(path.join(plugin, 'skills'), 'review', 'name: review\ndescription: Review a change.');
  const unused = path.join(config, 'plugins', 'cache', 'm', 'unused', '1.0.0');
  skill(path.join(unused, 'skills'), 'nope', 'name: nope\ndescription: From a plugin that is off.');
  fs.writeFileSync(
    path.join(config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'tools@m': [{ scope: 'user', installPath: plugin }], 'unused@m': [{ scope: 'user', installPath: unused }] } })
  );
  // Claude Code takes comments and trailing commas in its settings.
  fs.writeFileSync(
    path.join(config, 'settings.json'),
    '{\n  // Plugins on for every project\n  "enabledPlugins": { "tools@m": true, "unused@m": false, },\n  /* a comment */ "homepage": "https://example.com/a//b",\n  "skillOverrides": { "switched-off": "off" },\n}\n'
  );
  // Strings stay as they are, also when they hold a comma before } or ] or what looks like a comment: here the plugin
  // registry, read the same way, points into a folder whose name has both, and the URL in the settings keeps its //.
  const odd = path.join(config, 'plugins', 'cache', 'm', 'odd,} ,]');
  skill(path.join(odd, 'skills'), 'check', 'name: check\ndescription: From a folder with an odd name.');
  const registry = JSON.parse(fs.readFileSync(path.join(config, 'plugins', 'installed_plugins.json'), 'utf8'));
  registry.plugins['odd@m'] = [{ scope: 'user', installPath: odd }];
  fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify(registry).replace(/}$/, ',}'));
  const settings = fs.readFileSync(path.join(config, 'settings.json'), 'utf8').replace('"tools@m": true,', '"tools@m": true, "odd@m": true,');
  fs.writeFileSync(path.join(config, 'settings.json'), settings);
  // The workspace's settings turn a skill off; its local settings would turn it on again, but a map with an unknown
  // value counts for nothing; the managed settings turn another one off.
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { 'off-here': 'off' } }));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { 'off-here': 'on', pdf: 'sometimes' } }));
  const managed = path.join(config, 'managed-settings.json');
  fs.writeFileSync(managed, JSON.stringify({ skillOverrides: { 'off-managed': 'off' } }));

  assert.deepEqual(claudeSkills({ configDir: config, cwd, managed }), [
    { name: 'deploy', description: 'Deploy the project, folded over lines.', scope: 'project' },
    { name: 'pdf', description: 'Read and edit PDF files.', scope: 'user' },
    { name: 'plain', description: '', scope: 'user' },
    { name: 'probe-alias', description: 'Named after its folder.', scope: 'user' },
    { name: 'odd:check', description: 'From a folder with an odd name.', scope: 'plugin' },
    { name: 'tools:review', description: 'Review a change.', scope: 'plugin' }
  ].sort((a, b) => a.name.localeCompare(b.name)));
  // Without the managed settings that skill is back.
  assert.ok(claudeSkills({ configDir: config, cwd, managed: null }).some((s) => s.name === 'off-managed'));
  // Nothing installed yet: no skills, no error.
  assert.deepEqual(claudeSkills({ configDir: path.join(config, 'missing'), managed: null }), []);
});

test('an adapter list is cleaned for the panel: valid names once, short descriptions', () => {
  assert.deepEqual(
    cleanList([
      { name: 'ok', description: 'Fine' },
      { name: 'ok', description: 'Twice' },
      { name: 'has space', description: 'x' },
      { name: '1234', description: 'no letter' },
      { name: 'cat', description: 'a  b\n c', scope: 'tools' },
      null
    ]),
    [
      { name: 'ok', description: 'Fine' },
      { name: 'cat', description: 'a b c', scope: 'tools' }
    ]
  );
  assert.equal(cleanList([{ name: 'long', description: 'x'.repeat(1000) }])[0].description.length, 400);
});

// ---------- the hub ----------

test("the hub hands the adapter the skills the user's own text names, from the agent's list", async () => {
  const dir = tmp('rukoo-ownskills-hub-');
  const engine = new Engine({ dataDir: dir }).init();
  const turns = [];
  let lists = 0;
  const adapter = {
    async status() {
      return { state: 'ready' };
    },
    async skills() {
      lists++;
      return [{ name: 'meeting-prep', description: 'Prepare' }, { name: 'crm-update', description: 'CRM' }];
    },
    async runTurn(turn) {
      turns.push(turn);
      return { status: 'done' };
    },
    async dispose() {}
  };
  const hub = new AgentHub({ engine, dataDir: dir, secrets: { encrypt: (s) => s, decrypt: (s) => s }, deps: { appVersion: '1.0.0' }, adapters: { clark: () => adapter }, listen: false });
  await hub.start();
  const finished = async (c) => {
    for (let i = 0; i < 300 && hub.turns.has(c.id); i++) await new Promise((r) => setTimeout(r, 10));
  };
  try {
    assert.deepEqual((await hub.ownSkills('clark')).skills.map((s) => s.name), ['meeting-prep', 'crm-update']);
    const c = hub.create({ agent: 'clark', message: null });
    hub.send(c.id, { text: '$crm-update after $meeting-prep, and $crm-update again; $nope and $20' });
    await finished(c);
    assert.deepEqual(turns.at(-1).skills, [{ name: 'crm-update' }, { name: 'meeting-prep' }]);
    assert.equal(turns.at(-1).text, '$crm-update after $meeting-prep, and $crm-update again; $nope and $20');

    // A message without a $ needs no list; a shortcut's prompt counts, an approval Rukoo wrote never does.
    hub.send(c.id, { text: 'plain text' });
    await finished(c);
    assert.deepEqual(turns.at(-1).skills, []);
    hub.send(c.id, { text: 'Use $meeting-prep for this email', action: 'shortcut', display: 'Prep' });
    await finished(c);
    assert.deepEqual(turns.at(-1).skills, [{ name: 'meeting-prep' }]);
    assert.equal(lists, 1, 'the list is kept a minute');

    // A list that fails gives none, and says why; the message goes as it is.
    adapter.skills = async () => {
      throw Object.assign(new Error('offline'), { code: 'offline', detail: 'connect ECONNREFUSED' });
    };
    hub.skillLists.clear();
    const failed = await hub.ownSkills('clark', { refresh: true });
    assert.deepEqual([failed.skills, failed.error.code], [[], 'offline']);
    hub.send(c.id, { text: '$meeting-prep' });
    await finished(c);
    assert.deepEqual(turns.at(-1).skills, []);
  } finally {
    await hub.dispose();
    await engine.close();
  }
});

// ---------- shortcuts in agents.json ----------

test('config: shortcuts keep their order and only what changed; bad lists are refused, bad files fall back', () => {
  const dir = tmp('rukoo-shortcuts-cfg-');
  const file = path.join(dir, 'agents.json');
  const cfg = new AgentConfig({ file }).load();
  assert.equal(cfg.publicView().shortcuts, null, "Rukoo's own by default");

  const list = [
    { key: 'brief' },
    { key: 'reply', hidden: true, label: '  Answer  ', prompt: 'Reply briefly.' },
    { key: 'follow-up', custom: true, label: 'Follow up', prompt: 'Plan a follow-up.', icon: 'calendar', when: 'always' },
    { key: 'odd', custom: true, label: 'Odd', prompt: 'x', icon: 'rocket', when: 'sometimes' }
  ];
  cfg.update({ shortcuts: list });
  const stored = [
    { key: 'brief' },
    { key: 'reply', hidden: true, label: 'Answer', prompt: 'Reply briefly.' },
    { key: 'follow-up', custom: true, label: 'Follow up', prompt: 'Plan a follow-up.', icon: 'calendar', when: 'always' },
    { key: 'odd', custom: true, label: 'Odd', prompt: 'x', icon: 'sparkle', when: 'email' }
  ];
  assert.deepEqual(cfg.publicView().shortcuts, stored);
  assert.deepEqual(new AgentConfig({ file }).load().publicView().shortcuts, stored, 'kept after a restart');

  const refused = [
    [{ key: 'Bad Name' }],
    [{ key: 'approved' }],
    [{ key: 'brief' }, { key: 'brief' }],
    [{ key: 'mine', custom: true, label: 'No prompt' }],
    [{ key: 'reply', label: 'x'.repeat(61) }],
    Array.from({ length: 41 }, (_, i) => ({ key: `s${i}` })),
    'reply'
  ];
  for (const bad of refused) assert.throws(() => cfg.update({ shortcuts: bad }), /invalid/);
  assert.deepEqual(cfg.publicView().shortcuts, stored, 'a refused list changes nothing');

  cfg.update({ shortcuts: null });
  assert.equal(cfg.publicView().shortcuts, null);
  fs.writeFileSync(file, JSON.stringify({ shortcuts: [{ key: 'bad name' }] }));
  assert.equal(new AgentConfig({ file }).load().publicView().shortcuts, null, 'a list edited by hand into something invalid gives the defaults');
});
