'use strict';

// Files the user attaches to a chat message. Until the message goes out they wait here in memory (staged); the
// renderer only holds a token for each. Main reads a picked file itself and takes dropped or pasted files as bytes,
// so no path from the renderer is ever opened. Sent, a file goes into the chat's own folder in the agent
// workspace. Claude Code and Codex work in that folder, so they open the copy without asking, and every agent can
// read it with read_chat_file. The folder survives a restart and goes with the chat.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iconv = require('iconv-lite');
const { RISKY, safeName, markOfTheWeb } = require('../files');
const { isPdf } = require('../pdftext');

// The same cap as read_attachment's.
const FILE_MAX = 10 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_EMAILS = 10;
// Files the user attached but has not sent yet, across chats. Past these a new file is refused ('full'): a file
// that waits is never let go of to make room for another, so a chip in the message being written keeps its file
// until it is sent, removed or past STAGED_TTL.
const STAGED_MAX = 30;
const STAGED_BYTES = 120 * 1024 * 1024;
const STAGED_TTL = 2 * 60 * 60 * 1000;
// How much of a file's text goes along with the message; read_chat_file returns more.
const FILE_TEXT_INLINE = 20000;
const TURN_TEXT_MAX = 60000;
// Images up to this size go along with the message itself (Claude Code, Codex); Claude's API takes 5 MB, base64.
const INLINE_IMAGE_MAX = Math.floor(3.75 * 1024 * 1024);

// A file's bytes, read up to max, in steps, without blocking. null when it holds more: at most max + 1 bytes are
// read, whatever its size said before.
async function readCapped(file, max) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const parts = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, max + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      parts.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > max) return null;
    }
    return Buffer.concat(parts, total);
  } finally {
    await handle.close();
  }
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|ics)\b)/;
const TEXT_EXT = /\.(csv|md|markdown|ics|txt|json|xml|yaml|yml|log|vcf)$/i;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const TYPES = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  html: 'text/html',
  htm: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  eml: 'message/rfc822',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  zip: 'application/zip'
};

const rand = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);

// The type goes by the name, or by the bytes for a PDF; never by what the renderer says.
function typeOf(name, data) {
  if (data && isPdf(data)) return 'application/pdf';
  return TYPES[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
}

// What Rukoo does with it: 'text' and 'pdf' go along as text, 'image' as an image, 'file' as the file alone.
function kindOf(name, type) {
  if (type === 'application/pdf') return 'pdf';
  if (IMAGE_TYPES.test(type)) return 'image';
  if (TEXT_TYPES.test(type) || TEXT_EXT.test(name)) return 'text';
  return 'file';
}

// One file name, no folders, at most 150 characters with its extension.
function cleanName(name) {
  const n = safeName(name);
  if (n.length <= 150) return n;
  const ext = path.extname(n).slice(0, 20);
  return n.slice(0, 150 - ext.length) + ext;
}

// A user's text file: UTF-16 or UTF-8 by its byte order mark, else UTF-8, else Windows-1252.
function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return iconv.decode(buffer.subarray(2), 'utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return iconv.decode(buffer.subarray(2), 'utf16be');
  const body = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (_) {
    return iconv.decode(body, 'win1252');
  }
}

// What the renderer and the transcript get to see of a file.
const shown = (f) => ({ id: f.id, name: f.name, size: f.size, type: f.type, kind: f.kind });

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // A file an agent still holds open; the next start removes the folder.
  }
}

// A chat's folder name. Rukoo's ids are safe as they are; anything else becomes a hash, so no id can point outside.
const folderOf = (cid) => (/^[A-Za-z0-9_-]{1,100}$/.test(String(cid)) ? String(cid) : `c_${crypto.createHash('sha256').update(String(cid)).digest('hex').slice(0, 24)}`);

class ChatFiles {
  // pdf: the PdfReader (pdfread.js) that reads a PDF's text in a process of its own.
  constructor(root, pdf) {
    this.root = root;
    this.pdf = pdf;
    this.staged = new Map();
  }

  // Why a file can't go to an agent, known before Rukoo reads it: a program or script, or too big. null when it can.
  refuse(name, size) {
    if (RISKY.test(cleanName(name))) return 'blocked';
    if (Number(size) > FILE_MAX) return 'too-big';
    return null;
  }

  // The files the user picked in main's own dialog (the paperclip), staged in the order picked. room: how many more
  // the message takes; past it a file is neither read nor staged ('too-many'), so a selection of many large files
  // can't crowd out the ones the message keeps. A file can grow or be replaced after its size was checked (an
  // active log, a file on a share), so it is read up to FILE_MAX and refused as too big past that, never read whole.
  async stagePaths(paths, room) {
    let left = Number.isInteger(room) ? Math.max(0, Math.min(room, MAX_FILES)) : MAX_FILES;
    const out = [];
    for (const file of paths) {
      const name = path.basename(file);
      if (!left) {
        out.push({ name, error: 'too-many' });
        continue;
      }
      try {
        const refused = this.refuse(name, (await fs.promises.stat(file)).size);
        const data = refused ? null : await readCapped(file, FILE_MAX);
        const staged = refused ? { name, error: refused } : data ? this.stage(name, data) : { name, error: 'too-big' };
        if (!staged.error) left--;
        out.push(staged);
      } catch (_) {
        out.push({ name, error: 'unreadable' });
      }
    }
    return out;
  }

  // Keeps a file for a message the user is writing. {id, name, size, type, kind}, or {name, error}.
  stage(name, data) {
    const clean = cleanName(name);
    const error = this.refuse(clean, data.length);
    if (error) return { name: clean, error };
    this.trim();
    const bytes = [...this.staged.values()].reduce((n, s) => n + s.size, 0);
    if (this.staged.size >= STAGED_MAX || bytes + data.length > STAGED_BYTES) return { name: clean, error: 'full' };
    const type = typeOf(clean, data);
    const entry = { id: `s_${rand(16)}`, name: clean, size: data.length, type, kind: kindOf(clean, type), data, at: Date.now() };
    this.staged.set(entry.id, entry);
    // Let go after STAGED_TTL even when nothing else is staged, so a message never sent doesn't keep its files.
    entry.timer = setTimeout(() => this.unstage(entry.id), STAGED_TTL);
    if (entry.timer.unref) entry.timer.unref();
    return shown(entry);
  }

  unstage(id) {
    const s = this.staged.get(id);
    if (s) clearTimeout(s.timer);
    return this.staged.delete(id);
  }

  // Lets go of the files past STAGED_TTL, whose timers may not have fired yet.
  trim() {
    const now = Date.now();
    for (const [id, s] of this.staged) if (now - s.at > STAGED_TTL) this.unstage(id);
  }

  // Rukoo is closing: the staged files go.
  dispose() {
    for (const id of [...this.staged.keys()]) this.unstage(id);
  }

  // The tokens of these that name no staged file (any more).
  missing(ids) {
    return [...new Set(ids)].filter((id) => !this.pending([id]));
  }

  // The staged files these tokens name, or null when one of them is gone, also when it is past STAGED_TTL.
  pending(ids) {
    const out = [];
    for (const id of ids) {
      const s = this.staged.get(id);
      if (!s || Date.now() - s.at > STAGED_TTL) return null;
      if (!out.includes(s)) out.push(s);
    }
    return out;
  }

  dir(cid) {
    return path.join(this.root, folderOf(cid));
  }

  // Only the file's own name counts, so a changed conversations.json can't point anywhere else.
  path(cid, f) {
    return path.join(this.dir(cid), path.basename(String((f && f.file) || '')));
  }

  read(cid, f) {
    return fs.readFileSync(this.path(cid, f));
  }

  // Writes staged files into the chat's folder and forgets them. Returns what the chat keeps of each. A copy is
  // named after its file_id: the user's file name can be anyone's text, and the path is shown to the agent plain.
  // All or nothing: when a write fails (a full disk), the copies made so far go and every file stays staged, so
  // the message can be sent again as it was.
  keep(cid, entries) {
    const dir = this.dir(cid);
    fs.mkdirSync(dir, { recursive: true });
    const kept = [];
    const written = [];
    try {
      for (const s of entries) {
        const id = `f_${rand(10)}`;
        const ext = path.extname(s.name).toLowerCase();
        const file = `${id}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''}`;
        const full = path.join(dir, file);
        written.push(full);
        fs.writeFileSync(full, s.data);
        markOfTheWeb(full);
        kept.push({ id, name: s.name, file, size: s.size, type: s.type, kind: s.kind, at: Date.now() });
      }
    } catch (err) {
      for (const full of written) {
        try {
          fs.rmSync(full, { force: true });
        } catch (_) {
          // In use already; the copy is not in the chat, and goes with its folder.
        }
      }
      throw err;
    }
    for (const s of entries) this.unstage(s.id);
    return kept;
  }

  // What goes along with the message: each file with its path, and the start of its text for text files and PDFs.
  // The PDFs are read side by side, each in a process of its own; the text then shares TURN_TEXT_MAX in order.
  // truncated: there is more text than went along. partial: the reader stopped before the end of the PDF, so the
  // rest is only in the file. failed: why the reader got no text at all (pdfread.js). signal: the turn; stopped, its
  // PDFs stop being read.
  async forTurn(cid, files, { signal = null } = {}) {
    const loaded = await Promise.all(
      files.map(async (f) => {
        const out = { ...shown(f), path: this.path(cid, f) };
        let data;
        try {
          data = this.read(cid, f);
        } catch (_) {
          return { out: { ...out, missing: true } };
        }
        const pdf = f.kind === 'pdf' ? await this.pdf.read(data, { maxChars: FILE_TEXT_INLINE, signal }) : null;
        return { out, data, pdf };
      })
    );
    let room = TURN_TEXT_MAX;
    return loaded.map(({ out, data, pdf }) => {
      if (out.missing) return out;
      const max = Math.min(FILE_TEXT_INLINE, room);
      // omitted: the file has text, but the files before it used up TURN_TEXT_MAX; read_chat_file returns it.
      if (out.kind === 'text') {
        if (max > 0) {
          const text = decodeText(data);
          out.text = text.slice(0, max);
          out.truncated = text.length > max;
        } else out.omitted = data.length > 0;
      } else if (pdf) {
        if (max > 0 && pdf.text) {
          out.text = pdf.text.slice(0, max);
          out.truncated = pdf.truncated || pdf.text.length > max;
        } else if (pdf.text) out.omitted = true;
        out.partial = pdf.partial === true;
        out.failed = pdf.failed || null;
        out.encrypted = pdf.encrypted;
        out.empty = !pdf.text;
      } else if (out.kind === 'image') {
        out.inline = data.length <= INLINE_IMAGE_MAX;
      }
      room -= (out.text || '').length;
      return out;
    });
  }

  remove(cid) {
    removeDir(this.dir(cid));
  }

  // Folders of chats that are gone: removed while Rukoo was closed, or a removal a file in use stopped.
  prune(cids) {
    const known = new Set([...cids].map(folderOf));
    let names = [];
    try {
      names = fs.readdirSync(this.root);
    } catch (_) {
      return;
    }
    for (const name of names) if (!known.has(name)) removeDir(path.join(this.root, name));
  }
}

module.exports = {
  ChatFiles,
  decodeText,
  typeOf,
  kindOf,
  cleanName,
  shown,
  TEXT_TYPES,
  TEXT_EXT,
  IMAGE_TYPES,
  FILE_MAX,
  STAGED_TTL,
  MAX_FILES,
  MAX_EMAILS,
  FILE_TEXT_INLINE,
  TURN_TEXT_MAX,
  INLINE_IMAGE_MAX
};
