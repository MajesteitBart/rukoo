'use strict';

// The agent's own skills, the ones the user installed for Hermes, Claude Code or Codex, as opposed to Rukoo's skills
// (skills.js), which every agent gets through Rukoo's MCP server. The panel offers them after a $, and a message
// that mentions one ($name) starts it the way that agent starts a skill. Each adapter lists its skills: Hermes and
// Codex ask the agent; Claude Code has no command for it, so this reads its folders the way the CLI does.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFrontmatter } = require('./skills');

const SKILLS_MAX = 500;
const DESCRIPTION_MAX = 400;
const SKILL_MD_MAX = 256 * 1024;

// $name at the start of a word, ending at a space, punctuation or the end of the text. A skill name has a letter
// somewhere, so an amount such as $50 or $1.5k is never one. The shape of t3code's composer tokens, with $ only.
const MENTION = /(^|\s)\$(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=[\s,.;!?)]|$)/g;

const clip = (v, max) => {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// The skills a message names, in the order it names them, each once. names: what the agent has.
function mentionsIn(text, names) {
  const known = names instanceof Set ? names : new Set(names || []);
  const out = [];
  for (const m of String(text || '').matchAll(MENTION)) {
    const name = m[2];
    if (!known.has(name)) continue;
    const start = m.index + m[1].length;
    out.push({ name, start, end: m.index + m[0].length });
  }
  return out;
}

// Claude Code starts a skill only from the last text block of a message, and only when that block begins with
// /name: the CLI puts the skill's instructions in its place and passes the rest as its arguments. Only one skill
// starts per message. So the text up to the last mentioned skill becomes the block before it, the earlier mentions
// read /name there, and /name with what follows it is the last block.
function claudeDispatch(text, names) {
  const mentions = mentionsIn(text, names);
  const last = mentions[mentions.length - 1];
  if (!last) return null;
  const s = String(text);
  let leading = s.slice(0, last.start);
  for (const m of mentions.slice(0, -1).reverse()) leading = `${leading.slice(0, m.start)}/${m.name}${leading.slice(m.end)}`;
  // Claude Code reads the command up to a space: "$pdf, then" becomes "/pdf , then".
  const rest = s.slice(last.end);
  return { leading: leading.trimEnd(), command: `/${last.name}${rest && !/^\s/.test(rest) ? ' ' : ''}${rest}`.trimEnd(), name: last.name };
}

// ---------- Claude Code ----------

// Claude Code reads yes/no and on/off as booleans too.
function flag(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['true', 'yes', 'on', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'off', 'n', '0'].includes(s)) return false;
  return undefined;
}

// Claude Code's settings are edited by hand and it takes comments and trailing commas in them, so this does too.
// Outside strings, // and /* */ comments go; then, also outside strings, so does a comma before } or ]. Strings are
// copied as they are.
const STRING = /"(?:[^"\\]|\\.)*"/y;

function outsideStrings(text, step) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      STRING.lastIndex = i;
      const m = STRING.exec(text);
      if (!m) return null;
      out += m[0];
      i += m[0].length - 1;
    } else {
      const skip = step(text, i);
      if (skip === 0) out += text[i];
      else i += skip - 1;
    }
  }
  return out;
}

function lenient(text) {
  const bare = outsideStrings(text, (t, i) => {
    if (t[i] === '/' && t[i + 1] === '/') {
      const end = t.indexOf('\n', i);
      return (end < 0 ? t.length : end) - i;
    }
    if (t[i] === '/' && t[i + 1] === '*') {
      const end = t.indexOf('*/', i + 2);
      return (end < 0 ? t.length : end + 2) - i;
    }
    return 0;
  });
  const closing = /\s*[}\]]/y;
  const trailing = (t, i) => {
    if (t[i] !== ',') return 0;
    closing.lastIndex = i + 1;
    return closing.test(t) ? 1 : 0;
  };
  return bare === null ? text : outsideStrings(bare, trailing) || text;
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (_) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    try {
      return JSON.parse(lenient(text));
    } catch (__) {
      return null;
    }
  }
}

// One skill folder: null when it has no SKILL.md, or a frontmatter Claude Code would not read either. A SKILL.md
// without frontmatter still counts, by its folder's name.
function readSkill(dir) {
  const file = path.join(dir, 'SKILL.md');
  let source;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > SKILL_MD_MAX) return null;
    source = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  if (!/^﻿?---[ \t]*\r?\n/.test(source)) return { description: '', invocable: true };
  try {
    const { data } = parseFrontmatter(source);
    const description = data.get('description');
    return { description: typeof description === 'string' ? description : '', invocable: flag(data.get('user-invocable')) !== false };
  } catch (_) {
    return null;
  }
}

// The folders in root that hold a skill, sorted. A folder may be a link, as installed skills often are.
function skillDirs(root) {
  let names = [];
  try {
    names = fs.readdirSync(root).sort();
  } catch (_) {
    return [];
  }
  return names.filter((n) => !n.startsWith('.')).map((n) => ({ name: n, dir: path.join(root, n) }));
}

// skillOverrides as Claude Code applies them in the folder it runs in: the user's settings, then the project's and
// its local ones, then the settings an administrator manages; a later file wins for a skill. "off" takes a skill
// away; the other values keep it on the menu. Claude Code drops a file's whole map when one value is unknown, and
// so does this.
const OVERRIDES = new Set(['on', 'name-only', 'user-invocable-only', 'off']);

function managedSettings() {
  if (process.platform === 'win32') return process.env.PROGRAMDATA ? path.join(process.env.PROGRAMDATA, 'ClaudeCode', 'managed-settings.json') : null;
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

function overridesIn(configDir, cwd, managed = managedSettings()) {
  const files = [path.join(configDir, 'settings.json'), ...(cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : []), managed].filter(Boolean);
  const out = {};
  for (const file of files) {
    const settings = readJson(file);
    const o = settings && settings.skillOverrides;
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Object.values(o).every((v) => OVERRIDES.has(v))) continue;
    Object.assign(out, o);
  }
  return out;
}

// Plugins the user turned on for every project (enabledPlugins), with where each is installed.
function userPlugins(configDir) {
  const settings = readJson(path.join(configDir, 'settings.json')) || {};
  const enabled = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  const installed = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
  const plugins = installed && installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : {};
  const out = [];
  for (const [id, installs] of Object.entries(plugins)) {
    if (enabled[id] !== true || !Array.isArray(installs)) continue;
    const user = installs.find((i) => i && i.scope === 'user' && typeof i.installPath === 'string');
    if (user) out.push({ name: id.split('@')[0], dir: user.installPath });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// What Claude Code offers as /name in the folder it runs in (cwd): the user's skills, the project's, and the skills
// of the plugins the user turned on, named plugin:skill. Claude Code names a skill after its folder, not the
// frontmatter name, and a user skill wins over a project skill with the same name. Skills marked
// user-invocable: false are for the model only, so the menu leaves them out.
// managed: the administrator's settings file (tests pass their own; null for none).
function claudeSkills({ configDir, cwd, managed } = {}) {
  const root = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const overrides = overridesIn(root, cwd, managed === undefined ? managedSettings() : managed);
  const found = new Map();
  const add = (name, dir, scope) => {
    if (found.size >= SKILLS_MAX || found.has(name) || overrides[name] === 'off') return;
    const skill = readSkill(dir);
    if (!skill || !skill.invocable) return;
    found.set(name, { name, description: clip(skill.description, DESCRIPTION_MAX), scope });
  };
  for (const { name, dir } of skillDirs(path.join(root, 'skills'))) add(name, dir, 'user');
  if (cwd) for (const { name, dir } of skillDirs(path.join(cwd, '.claude', 'skills'))) add(name, dir, 'project');
  for (const plugin of userPlugins(root)) {
    for (const { name, dir } of skillDirs(path.join(plugin.dir, 'skills'))) add(`${plugin.name}:${name}`, dir, 'plugin');
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// An adapter's list in one shape for the panel: [{name, description, scope}], each name once.
function cleanList(list) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (out.length >= SKILLS_MAX) break;
    const name = s && typeof s.name === 'string' ? s.name.trim() : '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(name) || name.length > 120 || !/[a-zA-Z]/.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: clip(s.description, DESCRIPTION_MAX), ...(s.scope ? { scope: clip(s.scope, 40) } : {}) });
  }
  return out;
}

module.exports = { mentionsIn, claudeDispatch, claudeSkills, cleanList, SKILLS_MAX };
