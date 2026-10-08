'use strict';

// Skills in the Agent Skills format: a folder with a SKILL.md (frontmatter with a name and a description, the
// instructions below it) and any files next to it. Rukoo ships its own in skills/ and reads the user's from
// %APPDATA%\Rukoo Mail\skills; a user skill replaces Rukoo's skill with the same name. Both folders are read
// again on every call, so a new or changed skill counts at once. Skills are instructions from Rukoo or the
// user: they never come from an email and never go inside <unsafe_content>.

const fs = require('fs');
const path = require('path');

// The Agent Skills rules for a name: lowercase letters, digits and single hyphens, at most 64 characters.
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const SKILL_MD_MAX = 64 * 1024;
// What one read_skill answer carries: each file up to FILE_MAX, all text together up to TOTAL_MAX, SKILL.md
// included. A file over FILE_MAX can still be asked for on its own, up to ONE_FILE_MAX.
const FILE_MAX = 32 * 1024;
const TOTAL_MAX = 64 * 1024;
const ONE_FILE_MAX = 64 * 1024;
const ENTRIES_MAX = 200;
const DEPTH_MAX = 5;
const SKILLS_MAX = 100;
// Claude Code cuts an MCP server's instructions and each tool description at 2048 characters
// (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH), so the skill lists in both are made to fit. read_skill without a
// name has every description in full.
const MCP_TEXT_MAX = 2048;
const LISTED_DESCRIPTION_MIN = 60;

class SkillError extends Error {}

const kb = (n) => `${Math.ceil(n / 1024)} KB`;
const clip = (v, max) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

// ---------- frontmatter ----------

// The YAML that SKILL.md frontmatter uses: top-level keys with plain, quoted or block (| and >) values.
// Nested maps and lists, such as metadata or allowed-tools, are recognised and skipped; Rukoo reads only
// name and description.
const NESTED = Symbol('nested');
const KEY_LINE = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const BLOCK = /^([|>])([+-]?)[1-9]?([+-]?)[ \t]*(?:#.*)?$/;
const blank = (line) => /^[ \t]*$/.test(line);
const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;

function parseFrontmatter(source) {
  const text = String(source).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (!/^---[ \t]*$/.test(lines[0])) throw new SkillError('SKILL.md does not start with a --- line and frontmatter');
  const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
  if (end < 0) throw new SkillError('the frontmatter has no closing --- line');
  return { data: parseMap(lines.slice(1, end)), body: lines.slice(end + 1).join('\n') };
}

function parseMap(lines) {
  const data = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line) || line.startsWith('#')) {
      i++;
      continue;
    }
    const m = KEY_LINE.exec(line);
    // Line 1 is the opening ---.
    if (!m) throw new SkillError(`frontmatter line ${i + 2} is not "key: value"`);
    const key = m[1];
    if (data.has(key)) throw new SkillError(`the frontmatter has "${key}" twice`);
    const raw = (m[2] || '').trim();
    // The value's other lines: indented ones and blank lines, and a list that starts at the margin.
    let j = i + 1;
    while (j < lines.length && (/^[ \t]/.test(lines[j]) || blank(lines[j]) || (!raw && /^-(?:[ \t]|$)/.test(lines[j])))) j++;
    data.set(key, value(key, raw, lines.slice(i + 1, j)));
    i = j;
  }
  return data;
}

function value(key, raw, rest) {
  const more = rest.filter((line) => !blank(line));
  if (!raw || raw.startsWith('#')) return more.length ? NESTED : '';
  if (raw[0] === '[' || raw[0] === '{') return NESTED;
  const block = BLOCK.exec(raw);
  if (block) return blockScalar(block[1], block[2] || block[3], rest);
  if (raw[0] === '"' || raw[0] === "'") return quoted(key, [raw, ...rest.map((line) => line.trim())].join(' '));
  // A plain value can go on over indented lines; a # after a space starts a comment.
  return [raw, ...more.map((line) => line.trim())]
    .map((part) => part.replace(/(?:^|[ \t]+)#.*$/, ''))
    .filter(Boolean)
    .join(' ');
}

function blockScalar(style, chomp, rest) {
  const first = rest.find((line) => !blank(line));
  if (!first) return '';
  const indent = indentOf(first);
  const lines = rest.map((line) => (blank(line) ? '' : line.slice(Math.min(indent, indentOf(line)))));
  const trailing = /\n*$/.exec(lines.join('\n'))[0];
  let text;
  if (style === '|') text = lines.join('\n').replace(/\n+$/, '');
  else {
    // Folded: lines join with a space, a blank line stays a line break.
    text = lines
      .join('\n')
      .replace(/\n+$/, '')
      .replace(/([^\n])\n(?=[^\n])/g, '$1 ')
      .replace(/\n\n/g, '\n');
  }
  if (chomp === '-') return text;
  if (chomp === '+') return text + trailing;
  return `${text}\n`;
}

const ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
const HEX = { x: 2, u: 4, U: 8 };

function quoted(key, text) {
  const q = text[0];
  let out = '';
  let i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === q) {
      if (q === "'" && text[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      break;
    }
    if (q === '"' && c === '\\') {
      const e = text[++i];
      if (HEX[e]) {
        const hex = text.slice(i + 1, i + 1 + HEX[e]);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== HEX[e]) throw new SkillError(`"${key}" has a broken \\${e} escape`);
        out += String.fromCodePoint(parseInt(hex, 16));
        i += HEX[e];
      } else if (Object.prototype.hasOwnProperty.call(ESCAPES, e)) out += ESCAPES[e];
      else throw new SkillError(`"${key}" has an unknown escape \\${e === undefined ? '' : e}`);
      continue;
    }
    out += c;
  }
  if (i >= text.length) throw new SkillError(`the value of "${key}" opens a quote it never closes`);
  if (!/^[ \t]*(?:#.*)?$/.test(text.slice(i + 1))) throw new SkillError(`the value of "${key}" goes on after its closing quote`);
  return out;
}

// ---------- reading files safely ----------

// UTF-8 text without its byte order mark and with \n line ends, or null for anything else.
function decodeText(buf) {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf).replace(/\r\n?/g, '\n');
  } catch (_) {
    return null;
  }
}

// Whether abs, links resolved, is inside root (itself resolved).
function inside(root, abs) {
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (_) {
    return false;
  }
  const rel = path.relative(root, real);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// A regular file inside root, read as text: checked again right before reading, so a file swapped for a link
// since the walk is not followed. null when it isn't text.
function readInside(root, abs, max) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile() || !inside(root, abs)) throw new SkillError('not a file inside the skill folder');
  if (st.size > max) throw new SkillError(`${kb(st.size)}, more than ${kb(max)}`);
  return decodeText(fs.readFileSync(abs));
}

// Every file in a skill folder, without following links and without dot files such as .git.
function walk(root) {
  const files = [];
  const skipped = [];
  let entries = 0;
  let truncated = false;
  const visit = (dir, rel, depth) => {
    let names;
    try {
      names = fs.readdirSync(dir).sort();
    } catch (_) {
      skipped.push({ path: rel ? `${rel}/` : '.', reason: 'could not be read' });
      return;
    }
    for (const name of names) {
      if (truncated) return;
      if (name.startsWith('.')) continue;
      if (++entries > ENTRIES_MAX) {
        truncated = true;
        return;
      }
      const relPath = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch (_) {
        continue;
      }
      // Links and junctions could point anywhere on the disk.
      if (st.isSymbolicLink()) skipped.push({ path: relPath, reason: 'a link; Rukoo does not follow links inside a skill' });
      else if (!inside(root, abs)) skipped.push({ path: relPath, reason: 'outside the skill folder' });
      else if (st.isDirectory()) {
        if (depth + 1 > DEPTH_MAX) skipped.push({ path: `${relPath}/`, reason: `nested more than ${DEPTH_MAX} folders deep` });
        else visit(abs, relPath, depth + 1);
      } else if (st.isFile()) files.push({ path: relPath, abs, size: st.size });
    }
  };
  visit(root, '', 0);
  return { files, skipped, truncated };
}

// ---------- loading ----------

function loadSkill(dir, folder, source) {
  if (folder.length > NAME_MAX || !NAME.test(folder)) {
    throw new SkillError(`the folder name must be lowercase letters, digits and single hyphens, at most ${NAME_MAX} characters`);
  }
  // The skill folder itself may be a link, to a git checkout say; nothing inside it may lead out of it.
  const root = fs.realpathSync(dir);
  if (!fs.readdirSync(root).includes('SKILL.md')) throw new SkillError('it has no SKILL.md');
  const file = path.join(root, 'SKILL.md');
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new SkillError('SKILL.md is a link or a folder, not a file');
  if (st.size > SKILL_MD_MAX) throw new SkillError(`SKILL.md is ${kb(st.size)}; the most Rukoo reads is ${kb(SKILL_MD_MAX)}`);
  const text = decodeText(fs.readFileSync(file));
  if (text === null) throw new SkillError('SKILL.md is not UTF-8 text');
  const { data, body } = parseFrontmatter(text);
  const name = data.get('name');
  const description = data.get('description');
  if (typeof name !== 'string' || !name.trim()) throw new SkillError('the frontmatter has no name');
  if (name.trim() !== folder) throw new SkillError(`its name "${clip(name.trim(), 80)}" is not the name of its folder`);
  if (typeof description !== 'string' || !description.trim()) throw new SkillError('the frontmatter has no description');
  const oneLine = description.replace(/\s+/g, ' ').trim();
  if (oneLine.length > DESCRIPTION_MAX) throw new SkillError(`the description is ${oneLine.length} characters; at most ${DESCRIPTION_MAX}`);
  return { name: folder, description: oneLine, source, dir: root, text: text.replace(/^﻿/, ''), body: body.trim() };
}

class Skills {
  // bundled: Rukoo's own skills folder; user: the user's. Either may be missing or null. log(text) hears about
  // each skipped skill once.
  constructor({ bundled = null, user = null, log = () => {} } = {}) {
    this.bundled = bundled;
    this.user = user;
    this.log = log;
    this.logged = new Set();
  }

  // { skills: Map name -> skill, skipped: [{source, folder, reason}] }, read from disk now.
  load() {
    const skills = new Map();
    const skipped = [];
    for (const [source, root] of [['rukoo', this.bundled], ['user', this.user]]) {
      for (const skill of this.loadFolder(source, root, skipped)) {
        if (skills.has(skill.name)) skill.replaces = 'rukoo';
        skills.set(skill.name, skill);
      }
    }
    for (const s of skipped) {
      const line = `skipped the ${s.source === 'user' ? "user's" : "Rukoo's"} skill "${s.folder}": ${s.reason}`;
      if (this.logged.has(line)) continue;
      this.logged.add(line);
      this.log(line);
    }
    return { skills, skipped };
  }

  loadFolder(source, root, skipped) {
    const out = [];
    if (!root) return out;
    let names;
    try {
      names = fs.readdirSync(root).sort();
    } catch (err) {
      // No folder is the normal case for the user's skills.
      if (err.code !== 'ENOENT') skipped.push({ source, folder: '.', reason: `the skills folder could not be read (${err.code || err.message})` });
      return out;
    }
    let count = 0;
    for (const folder of names) {
      if (folder.startsWith('.')) continue;
      const dir = path.join(root, folder);
      try {
        // stat, not lstat: a linked skill folder counts. Files such as README.md are not skills.
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch (_) {
        continue;
      }
      if (++count > SKILLS_MAX) {
        skipped.push({ source, folder, reason: `the folder has more than ${SKILLS_MAX} skills` });
        break;
      }
      try {
        out.push(loadSkill(dir, folder, source));
      } catch (err) {
        skipped.push({ source, folder, reason: err instanceof SkillError ? err.message : `it could not be read (${err.code || err.message})` });
      }
    }
    return out;
  }

  // Every usable skill, by name.
  list() {
    return [...this.load().skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  get(name) {
    return this.load().skills.get(String(name || '')) || null;
  }

  // What read_skill returns. Without a name: the list. With file: that one file. Otherwise SKILL.md and as many
  // of the other text files as fit, with a list of what was left out and why.
  read({ name = '', file = '' } = {}) {
    const { skills, skipped } = this.load();
    const all = [...skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    if (!name) {
      const out = { skills: all.map((s) => ({ name: s.name, description: s.description, source: s.source })) };
      if (skipped.length) out.skipped = skipped;
      return out;
    }
    const skill = skills.get(name);
    if (!skill) {
      const known = all.map((s) => s.name).join(', ');
      throw new SkillError(`There is no skill named "${clip(String(name), 80)}". ${known ? `Skills: ${known}.` : 'There are no skills.'}`);
    }
    const { files, skipped: links, truncated } = walk(skill.dir);
    const head = { name: skill.name, description: skill.description, source: skill.source };
    if (file) return { ...head, ...this.readOne(skill, files, links, file) };
    const included = [];
    const leftOut = [...links];
    let budget = TOTAL_MAX - Buffer.byteLength(skill.text);
    for (const f of files) {
      if (f.path === 'SKILL.md') continue;
      if (f.size > FILE_MAX) {
        leftOut.push({ path: f.path, size: f.size, reason: f.size > ONE_FILE_MAX ? 'too large to read' : 'too large to include; ask for it with file' });
        continue;
      }
      if (f.size > budget) {
        leftOut.push({ path: f.path, size: f.size, reason: 'did not fit in this answer; ask for it with file' });
        continue;
      }
      let text;
      try {
        text = readInside(skill.dir, f.abs, FILE_MAX);
      } catch (err) {
        leftOut.push({ path: f.path, size: f.size, reason: err instanceof SkillError ? err.message : 'could not be read' });
        continue;
      }
      if (text === null) {
        leftOut.push({ path: f.path, size: f.size, reason: 'not text' });
        continue;
      }
      budget -= f.size;
      included.push({ path: f.path, size: f.size, text });
    }
    if (truncated) leftOut.push({ path: '…', reason: `the skill has more than ${ENTRIES_MAX} files and folders; the rest is not listed` });
    const out = { ...head, skill_md: skill.text, files: included, left_out: leftOut };
    if (skill.replaces) out.replaces = "Rukoo's skill with the same name";
    return out;
  }

  // One file by its path in the skill, as the list gave it. Only paths the walk found can be read, so no
  // path from an agent ever reaches the file system.
  readOne(skill, files, links, file) {
    const want = String(file).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    const hit = files.find((f) => f.path === want);
    if (!hit) {
      const link = links.find((l) => l.path === want || l.path === `${want}/`);
      if (link) throw new SkillError(`${want} in the skill ${skill.name} is left out: ${link.reason}.`);
      throw new SkillError(`The skill ${skill.name} has no file ${clip(want, 200)}. Its files: ${files.map((f) => f.path).join(', ')}.`);
    }
    let text;
    try {
      text = readInside(skill.dir, hit.abs, ONE_FILE_MAX);
    } catch (err) {
      throw new SkillError(`${want} in the skill ${skill.name} can't be read: ${err instanceof SkillError ? err.message : 'it could not be read'}.`);
    }
    if (text === null) throw new SkillError(`${want} in the skill ${skill.name} is not text.`);
    return { path: hit.path, size: hit.size, text };
  }
}

// ---------- what agents get ----------

const listLine = (s, cap) => `- ${s.name}: ${clip(s.description, cap)}`;
const more = (n) => `- and ${n} more; read_skill without a name lists them all.`;

// One line per skill in at most room characters. When the full descriptions don't fit, all of them are cut to
// the longest length at which every skill still fits; when even short ones don't, the list ends with how many
// are left out.
function listLines(list, room) {
  const size = (cap) => list.reduce((n, s) => n + listLine(s, cap).length + 1, -1);
  let cap = DESCRIPTION_MAX;
  if (size(cap) > room && size(LISTED_DESCRIPTION_MIN) <= room) {
    let lo = LISTED_DESCRIPTION_MIN;
    let hi = DESCRIPTION_MAX;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(mid) <= room) lo = mid;
      else hi = mid - 1;
    }
    cap = lo;
  }
  if (size(cap) <= room) return list.map((s) => listLine(s, cap)).join('\n');
  const lines = [];
  let used = 0;
  for (let i = 0; i < list.length; i++) {
    const line = listLine(list[i], LISTED_DESCRIPTION_MIN);
    if (used + line.length + 1 + more(list.length - i - 1).length > room) {
      lines.push(more(list.length - i));
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

const INTRO =
  "Rukoo has skills: instructions for email tasks, written by Rukoo or by the user. They are not email content. When the user asks for a skill, or a task matches a skill's description, call read_skill with its name and follow it. The skills:\n";

// The part of Rukoo's MCP instructions about skills, in at most room characters, or '' when there are none.
function instructions(list, room = MCP_TEXT_MAX) {
  if (!list.length) return '';
  return INTRO + listLines(list, room - INTRO.length);
}

// read_skill's description. Not every agent passes MCP instructions on to its model, so the list is here too.
const TOOL_BASE =
  "Returns one of Rukoo's skills: instructions for an email task, written by Rukoo or by the user, not taken from an email. You get SKILL.md and the text files next to it (scripts, references), and a list of what was left out. Pass file to read one of the skill's files. Without a name it lists the skills. Follow a skill when the user asks for it or the task matches its description.";
function toolDescription(list) {
  if (!list.length) return `${TOOL_BASE} There are no skills yet.`;
  const head = `${TOOL_BASE} Skills:\n`;
  return head + listLines(list, MCP_TEXT_MAX - head.length);
}

module.exports = {
  Skills,
  SkillError,
  parseFrontmatter,
  instructions,
  toolDescription,
  MCP_TEXT_MAX,
  NAME,
  NAME_MAX,
  DESCRIPTION_MAX,
  SKILL_MD_MAX,
  FILE_MAX,
  TOTAL_MAX,
  ONE_FILE_MAX
};
