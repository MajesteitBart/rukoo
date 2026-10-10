'use strict';

// Rukoo's MCP tools. Everything goes through the engine, so the tools work the same for IMAP, Google and demo
// accounts. Handlers get (hub, args, call) with call = {agent, identity, remote, meta, conversation}.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { encodeId, decodeId } = require('../engine');
const { RISKY, safeName, markOfTheWeb } = require('../files');
const { htmlToPlain, decodeCharset } = require('../mailutil');
const { toHtml } = require('./markdown');
const { unsafeBlock, unsafeInline, unsafeValue, untag, clipTagged, PDF_FAILED } = require('./context');
const { SkillError, toolDescription } = require('./skills');
const { decodeText, TEXT_TYPES, TEXT_EXT, IMAGE_TYPES } = require('./chatfiles');
const { isPdf } = require('../pdftext');

const TEXT_MAX = 20000;
// The most formatted text a draft may have; the renderer's sanitizeAgentHtml takes no more.
const DRAFT_HTML_MAX = 200000;
const ATTACHMENT_TEXT_MAX = 200000;
const IMAGE_MAX = 5 * 1024 * 1024;
const ATTACHMENT_MAX = 10 * 1024 * 1024;
const RAW = Symbol('mcp-content');

class ToolError extends Error {}

// ---------- schemas ----------

// Marks a field that takes values agents copy from tool results (an address, a subject, a Message-ID): validate()
// drops the <unsafe_content> tags those values come with. Text the agent writes itself, such as a draft body or
// a proposal it asks the user to approve, keeps them, so email it quotes stays marked when Rukoo repeats it.
// A symbol, so the mark stays out of the schemas agents get.
const UNTAG = Symbol('untag');
const copied = (spec) => ({ ...spec, [UNTAG]: true });
// What the user approves: past maxLength the call fails instead of the value being cut, because an agent that
// still has the whole value could carry out more than the card showed.
const WHOLE = Symbol('whole');
const whole = (spec) => ({ ...spec, [WHOLE]: true });

const CONVERSATION = {
  type: 'string',
  description: 'The Rukoo conversation id from your context ("c_..."). Pass it whenever you have one.'
};
const MESSAGE_ID = copied({
  type: 'string',
  description: 'Rukoo message id: the "id" field from get_context or search_mail (not the Message-ID header).'
});
const PERSON = {
  anyOf: [
    copied({ type: 'string', description: 'An address, or "Name <address>".' }),
    { type: 'object', properties: { name: copied({ type: 'string' }), address: copied({ type: 'string' }) }, required: ['address'] }
  ]
};
const PEOPLE = { type: 'array', items: PERSON, maxItems: 50 };

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const MAIL_ACTIONS = ['archive', 'trash', 'move', 'mark_read', 'mark_unread', 'star', 'unstar', 'unsubscribe'];
const TASK_STATUSES = ['proposed', 'todo', 'running', 'done', 'failed', 'skipped'];
const COMPOSER_MODES = { reply: 'reply', reply_all: 'replyAll', forward: 'forward', new: 'new' };

function schema(properties, required = []) {
  return { type: 'object', properties: { ...properties, conversation_id: CONVERSATION }, required };
}

const TOOLS = [
  {
    name: 'get_context',
    title: 'See what the user sees in Rukoo',
    description:
      "Returns what is on the user's screen in Rukoo: the open email with its full text, the email this chat is about, related mail in the same thread, checked emails, the reply draft in the composer, the user's accounts and folders, and today's date. Call this first.",
    inputSchema: schema({}),
    annotations: READ,
    run: getContext
  },
  {
    name: 'search_mail',
    title: 'Search mail',
    description:
      "Searches the user's mail in every account and folder Rukoo has synced (inbox, sent, archive, drafts, trash and opened folders). All words in query must match the subject, preview, sender or recipients. Newest first. Use read_message for the full text.",
    inputSchema: schema({
      query: copied({ type: 'string', description: 'Words that must all appear, e.g. "proposal thursday".', maxLength: 500 }),
      from: copied({ type: 'string', description: 'Part of the sender name or address.', maxLength: 320 }),
      account: copied({ type: 'string', description: 'Account id or email address, from get_context. Default: all accounts.', maxLength: 320 }),
      folder: copied({ type: 'string', description: 'Folder path or name, or a role: inbox, sent, drafts, archive, trash, junk.', maxLength: 500 }),
      unread: { type: 'boolean', description: 'Only unread (true) or only read (false) mail.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results (default 15).' }
    }),
    annotations: READ,
    run: searchMail
  },
  {
    name: 'read_message',
    title: 'Read an email',
    description:
      'Returns one email: headers (including the Message-ID header to link back to it from other systems, and the List-Unsubscribe links), plain text body and the attachment list. Does not mark it as read.',
    inputSchema: schema(
      { message_id: MESSAGE_ID, max_chars: { type: 'integer', minimum: 200, maximum: 200000, description: 'Maximum body characters (default 20000).' } },
      ['message_id']
    ),
    annotations: READ,
    run: readMessage
  },
  {
    name: 'read_attachment',
    title: 'Read an attachment',
    description:
      "Returns an attachment of an email by its index from read_message. Text files come back as text, images as images, a PDF as the text Rukoo could extract (note says when that is not all of it) with the file as a resource, other files (Office) as a resource; local agents also get local_path to open the file themselves. Up to 10 MB.",
    inputSchema: schema({ message_id: MESSAGE_ID, index: { type: 'integer', minimum: 0, description: 'The attachment index from read_message.' } }, [
      'message_id',
      'index'
    ]),
    annotations: READ,
    run: readAttachment
  },
  {
    name: 'read_chat_file',
    title: 'Read a file the user attached',
    description:
      "Returns a file the user attached to a message in this chat, by the file_id the message gives. Text files come back as text, images as images, a PDF as the text Rukoo could extract (note says when that is not all of it) with the file as a resource, other files as a resource; local agents also get local_path to open the file themselves. Without file_id it lists the chat's files.",
    inputSchema: schema({ file_id: { type: 'string', description: 'The file_id from the message, e.g. "f_1a2b3c4d5e".', maxLength: 100 } }),
    annotations: READ,
    run: readChatFile
  },
  {
    name: 'write_draft',
    title: 'Write the reply draft',
    description:
      "Puts a draft in Rukoo's composer, replacing the body the user sees. It never sends: the user reviews and sends. Mode defaults to a reply to the email of this chat. Write only the body; Rukoo keeps the quoted email and adds the signature. Recipients and subject are optional for replies.",
    inputSchema: schema(
      {
        message_id: MESSAGE_ID,
        mode: { type: 'string', enum: ['reply', 'reply_all', 'forward', 'new'] },
        to: PEOPLE,
        cc: PEOPLE,
        bcc: PEOPLE,
        subject: copied({ type: 'string', maxLength: 1000 }),
        body: { type: 'string', description: 'The draft body.', maxLength: 100000 },
        format: { type: 'string', enum: ['markdown', 'text', 'html'], description: 'Default markdown.' }
      },
      ['body']
    ),
    annotations: WRITE,
    run: writeDraft
  },
  {
    name: 'get_draft',
    title: 'Check the draft',
    description: "Returns the draft that is open in Rukoo's composer now, including the user's own edits, or {open:false}.",
    inputSchema: schema({}),
    annotations: READ,
    run: getDraft
  },
  {
    name: 'show_plan',
    title: 'Show a plan',
    description:
      "Shows or updates a task list in Rukoo's chat panel. Call it again with the same plan_id (or the same task ids) to update statuses and add links as you work. Statuses: proposed, todo, running, done, failed, skipped.",
    inputSchema: schema(
      {
        plan_id: { type: 'string', maxLength: 100 },
        title: { type: 'string', maxLength: 200 },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 100 },
              title: { type: 'string', maxLength: 300 },
              detail: { type: 'string', maxLength: 1000 },
              system: { type: 'string', description: 'Where it happens, e.g. Todoist, Linear, CRM.', maxLength: 60 },
              status: { type: 'string', enum: TASK_STATUSES },
              url: { type: 'string', maxLength: 2000 },
              owner: { type: 'string', maxLength: 100 },
              due: { type: 'string', maxLength: 60 }
            },
            description: 'New tasks need a title; updates only need the id and the fields that change.'
          }
        }
      },
      ['tasks']
    ),
    annotations: WRITE,
    run: showPlan
  },
  {
    name: 'show_sources',
    title: 'Show sources',
    description:
      "Shows the sources you used as cards in Rukoo's chat panel: emails (pass message_id so the user can open them), notes, records or web pages (url).",
    inputSchema: schema(
      {
        title: copied({ type: 'string', maxLength: 200 }),
        sources: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              title: copied({ type: 'string', maxLength: 300 }),
              source: copied({ type: 'string', description: 'Origin, e.g. Email, Obsidian, CRM, Web.', maxLength: 60 }),
              snippet: copied({ type: 'string', maxLength: 600 }),
              url: { type: 'string', maxLength: 2000 },
              message_id: MESSAGE_ID
            },
            required: ['title']
          }
        }
      },
      ['sources']
    ),
    annotations: WRITE,
    run: showSources
  },
  {
    name: 'propose_action',
    title: 'Ask the user for approval',
    description:
      'Shows an approval card in Rukoo for something you want to do elsewhere (send a message, create a task, update a record). Returns at once; stop and wait. When the user approves you get a new message saying so, then do it. If they decline you will be told.',
    inputSchema: schema(
      {
        title: whole({ type: 'string', description: 'What you will do, e.g. "Add 2 tasks to Todoist".', maxLength: 120 }),
        detail: whole({ type: 'string', description: 'The exact content, e.g. the message text.', maxLength: 2000 }),
        fields: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            properties: { label: whole({ type: 'string', maxLength: 60 }), value: whole({ type: 'string', maxLength: 500 }) },
            required: ['label', 'value']
          }
        },
        confirm_label: whole({ type: 'string', description: 'Approve button text, e.g. "Send".', maxLength: 30 })
      },
      ['title']
    ),
    annotations: WRITE,
    run: proposeAction
  },
  {
    name: 'mail_action',
    title: 'Archive, move, flag or unsubscribe',
    description:
      "Asks Rukoo to archive, delete (move to trash), move, mark, star or unsubscribe from emails. Rukoo asks the user first unless they turned that off; you get status waiting_for_user or the result. Works for every account type. Use the ids from search_mail or get_context.",
    inputSchema: schema(
      {
        action: { type: 'string', enum: MAIL_ACTIONS },
        message_ids: { type: 'array', items: MESSAGE_ID, minItems: 1, maxItems: 50 },
        folder: copied({ type: 'string', description: 'Destination folder for move (path or name).', maxLength: 500 })
      },
      ['action', 'message_ids']
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: mailAction
  },
  {
    name: 'read_skill',
    title: 'Read a skill',
    description: toolDescription([]),
    // The description lists the skills there are now; see list().
    describe: (hub) => toolDescription(hub && hub.skills ? hub.skills.list() : []),
    inputSchema: schema({
      name: { type: 'string', description: 'The skill, e.g. "data-deletion-request". Leave it out to list the skills.', maxLength: 64 },
      file: { type: 'string', description: 'One file of the skill by its path, as read_skill lists it, e.g. "references/forms.md".', maxLength: 500 }
    }),
    annotations: READ,
    run: readSkill
  }
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const TOOL_NAMES = TOOLS.map((t) => t.name);

function list(hub = null) {
  return TOOLS.map(({ name, title, description, describe, inputSchema, annotations }) => {
    let text = description;
    if (describe) {
      try {
        text = describe(hub);
      } catch (_) {
        // A skills folder that can't be read must not cost the agent its tools.
      }
    }
    return { name, title, description: text, inputSchema, annotations };
  });
}

// Accepts bare names and the prefixed forms agents report (mcp__rukoo__x, mcp_rukoo_x).
function bareName(name) {
  return String(name || '').replace(/^mcp__rukoo__|^mcp_rukoo_|^rukoo[.:/]/, '');
}

function isRukooTool(name) {
  const n = String(name || '');
  return n === 'rukoo' || /^mcp__rukoo__|^mcp_rukoo_/.test(n) || BY_NAME.has(n);
}

// ---------- argument validation ----------

// A small JSON Schema subset, lenient where models commonly slip: numeric strings, "true"/"false",
// a single value where a list is expected, and text longer than allowed (cut, not refused). Fields marked with
// copied() lose the <unsafe_content> tags of a value taken from a tool result, such as an address for write_draft.
function validate(s, value, where) {
  if (s.anyOf) {
    let last = null;
    for (const option of s.anyOf) {
      try {
        return validate(option, value, where);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }
  switch (s.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolError(`${where} must be an object.`);
      const out = {};
      for (const [key, sub] of Object.entries(s.properties || {})) {
        const v = value[key];
        if (v === undefined || v === null) continue;
        out[key] = validate(sub, v, `${where}.${key}`);
      }
      for (const key of s.required || []) {
        if (out[key] === undefined || out[key] === '') throw new ToolError(`${where}.${key} is required.`);
      }
      return out;
    }
    case 'string': {
      if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
      if (typeof value !== 'string') throw new ToolError(`${where} must be a string.`);
      // A copied value loses its tags here so lookups and the composer get the plain value. Errors that echo
      // an argument tag it again with unsafeValue(), because it may still be a sender's text.
      if (s[UNTAG]) value = untag(value);
      if (s.enum && !s.enum.includes(value)) throw new ToolError(`${where} must be one of: ${s.enum.join(', ')}.`);
      if (s[WHOLE] && value.length > s.maxLength) {
        throw new ToolError(`${where} is ${value.length} characters; at most ${s.maxLength}. The user approves what the card shows, so it is not cut: make it shorter.`);
      }
      // A value that kept its tags is cut without splitting one; see clipTagged().
      return s.maxLength ? clipTagged(value, s.maxLength) : value;
    }
    case 'integer': {
      const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
      if (!Number.isInteger(n)) throw new ToolError(`${where} must be a whole number.`);
      if (s.minimum !== undefined && n < s.minimum) throw new ToolError(`${where} must be at least ${s.minimum}.`);
      if (s.maximum !== undefined && n > s.maximum) throw new ToolError(`${where} must be at most ${s.maximum}.`);
      return n;
    }
    case 'boolean': {
      if (value === 'true' || value === 'false') return value === 'true';
      if (typeof value !== 'boolean') throw new ToolError(`${where} must be true or false.`);
      return value;
    }
    case 'array': {
      const arr = Array.isArray(value) ? value : [value];
      if (s.minItems !== undefined && arr.length < s.minItems) throw new ToolError(`${where} needs at least ${s.minItems} item(s).`);
      if (s.maxItems !== undefined && arr.length > s.maxItems) throw new ToolError(`${where} takes at most ${s.maxItems} items.`);
      return arr.map((v, i) => (s.items ? validate(s.items, v, `${where}[${i}]`) : v));
    }
    default:
      return value;
  }
}

// ---------- results ----------

function raw(content, structuredContent) {
  return { [RAW]: true, content, structuredContent };
}

function toResult(out) {
  if (out && out[RAW]) {
    const res = { content: out.content };
    if (out.structuredContent) res.structuredContent = out.structuredContent;
    return res;
  }
  const data = out === undefined ? { ok: true } : out;
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

async function callTool(hub, identity, name, args, meta = {}) {
  // Turning an agent off also closes Rukoo to it. A tool error rather than a 401, so the agent keeps the
  // server and can tell the user why.
  const agentCfg = hub.cfg && hub.cfg.data && hub.cfg.data[identity.agent];
  if (agentCfg && agentCfg.enabled === false) {
    return errorResult(`${hub.agentName(identity.agent)} is turned off in Rukoo, so Rukoo's tools are not available. The user can turn it on in Settings > Agents.`);
  }
  const tool = BY_NAME.get(bareName(name));
  if (!tool) return errorResult(`Unknown tool "${name}". Rukoo's tools are: ${TOOL_NAMES.join(', ')}.`);
  let clean;
  try {
    clean = validate(tool.inputSchema, args && typeof args === 'object' ? args : {}, 'arguments');
  } catch (err) {
    return errorResult(`${err.message} Check the ${tool.name} input schema and try again.`);
  }
  const call = {
    agent: identity.agent,
    identity,
    remote: Boolean(identity.remote),
    meta: meta || {},
    conversation: hub.resolveConversation(identity, clean, meta || {})
  };
  // A tool call during a turn shows the agent got that turn's input. Stopping the turn stops the PDF reads it
  // started (signal), so they don't hold up another chat's.
  const running = call.conversation && hub.turns && hub.turns.get(call.conversation.id);
  if (running) running.reached = true;
  call.signal = running ? running.controller.signal : null;
  try {
    return toResult(await tool.run(hub, clean, call));
  } catch (err) {
    if (err instanceof ToolError) return errorResult(err.message);
    return errorResult(`Rukoo could not complete ${tool.name}: ${(err && err.message) || err}`);
  }
}

// ---------- message helpers ----------

const normId = (v) => String(v || '').trim().replace(/^<|>$/g, '').toLowerCase();
const lower = (v) => String(v || '').trim().toLowerCase();
const iso = (ms) => (Number.isFinite(Number(ms)) && ms ? new Date(Number(ms)).toISOString() : null);
const addr = (a) => ({ name: String((a && a.name) || ''), address: String((a && a.address) || '') });
// A person as an email names them: the sender wrote both the name and the address.
const emailAddr = (a) => ({ name: unsafeValue(a && a.name), address: unsafeValue(a && a.address) });
// A Message-ID is a key agents pass on to link back to the email, so one in the usual <local@domain> form stays
// plain. Anything else is text the sender wrote and is tagged like the rest, as are In-Reply-To and References:
// mail parsers split a sentence there into one <word> per word, which would pass for a list of ids.
const MESSAGE_ID_FORM = /^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+>$/;
function headerId(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return s.length <= 250 && MESSAGE_ID_FORM.test(s) ? s : unsafeValue(s);
}
// The MIME type a sender declared, without parameters, if it has the plain type/subtype form: for MCP image and
// resource metadata. Anything else is passed on as what it is to Rukoo, unknown bytes.
const MIME_FORM = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
function mimeType(v) {
  const s = String(v || '').split(';')[0].trim().toLowerCase();
  return MIME_FORM.test(s) ? s : 'application/octet-stream';
}
// Gmail's All Mail is 'archive' to agents, as in get_context's folder list. Only the cache keeps 'all'.
const agentRole = (role) => (role === 'all' ? 'archive' : role || null);
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// The charset parameter of a Content-Type value, if any.
function charsetOf(type) {
  const m = /charset="?([^";\s]+)/i.exec(String(type || ''));
  return m ? m[1] : null;
}

function cacheMessage(engine, id) {
  try {
    const { accountId, folder, uid } = decodeId(id);
    const cache = engine.caches.get(accountId);
    const box = cache && cache.boxes[folder];
    return (box && box.messages.find((m) => m.uid === uid)) || null;
  } catch (_) {
    return null;
  }
}

function accountOf(engine, accountId) {
  return engine.accounts.find((a) => a.id === accountId) || null;
}

// The account a live Rukoo id belongs to; saved copies have none.
function accountOfId(id) {
  const v = String(id || '');
  if (!v.includes(':') || v.startsWith('saved:')) return null;
  try {
    return decodeId(v).accountId || null;
  } catch (_) {
    return null;
  }
}

// Finds the Rukoo id of a Message-ID header, within one account when accountId is given. Real folders win
// over Gmail's All Mail copies.
function findByMessageId(engine, header, accountId = null) {
  const want = normId(header);
  if (!want) return null;
  let fallback = null;
  for (const acc of engine.accounts) {
    if (accountId && acc.id !== accountId) continue;
    const cache = engine.caches.get(acc.id);
    if (!cache) continue;
    for (const [folder, box] of Object.entries(cache.boxes)) {
      const hit = box.messages.find((m) => m.messageId && normId(m.messageId) === want);
      if (!hit) continue;
      const role = (cache.folders.find((f) => f.path === folder) || {}).role;
      const id = encodeId(acc.id, folder, hit.uid);
      if (role === 'inbox') return id;
      if (role !== 'all' && (!fallback || fallback.all)) fallback = { id, all: false };
      else if (!fallback) fallback = { id, all: true };
    }
  }
  return fallback ? fallback.id : null;
}

// Every cached copy of a Message-ID header, in every account and folder.
function copiesOf(engine, header) {
  const want = normId(header);
  const out = [];
  if (!want) return out;
  for (const acc of engine.accounts) {
    const cache = engine.caches.get(acc.id);
    if (!cache) continue;
    for (const [folder, box] of Object.entries(cache.boxes)) {
      const role = (cache.folders.find((f) => f.path === folder) || {}).role;
      for (const m of box.messages) {
        if (m.messageId && normId(m.messageId) === want) out.push({ acc, folder, role, id: encodeId(acc.id, folder, m.uid) });
      }
    }
  }
  return out;
}

// Turns what an agent passes as message_id into a current Rukoo id: a live id, a saved copy or a Message-ID header.
function resolveId(hub, value, { allowSaved = true } = {}) {
  const v = String(value || '').trim();
  if (!v) throw new ToolError('message_id is required.');
  const { engine } = hub;
  if (v.startsWith('saved:')) {
    if (allowSaved && engine.saved.some((s) => s.id === v)) return v;
    throw new ToolError(`${unsafeValue(v)} is a copy saved on this device; it cannot be changed with mail_action.`);
  }
  if (cacheMessage(engine, v)) return v;
  if (v.includes('@')) {
    // The same email can have several live copies: in two accounts (mail between your own addresses), or in two
    // folders of one (Inbox and Sent of a mail to yourself, two Gmail labels). A header names none of them, so
    // with more than one only the Rukoo id says which is meant. Gmail's All Mail copy only counts when it is the
    // only one: it is the same message as the copy under a label.
    const copies = copiesOf(engine, v);
    const live = copies.filter((h) => h.role !== 'all');
    const accounts = new Set(copies.map((h) => h.acc.id));
    if (live.length > 1 || accounts.size > 1) {
      const where = (live.length ? live : copies).map((h) => `${h.acc.email} in ${h.folder}`).join(', ');
      const err = new ToolError(`More than one copy of the email with Message-ID ${unsafeValue(v)} is here: ${where}. Pass the Rukoo id of the copy you mean; search_mail and get_context list them.`);
      err.ambiguous = true;
      throw err;
    }
    if (copies.length) return (live[0] || copies[0]).id;
  }
  throw new ToolError(`No email with id ${unsafeValue(v)}. Ids change when mail moves; use search_mail or get_context for current ids.`);
}

// An email as agents see it. What the sender wrote (people, subject, preview, attachment names) is inside
// <unsafe_content> value by value; ids, account, folder, date and flags stay plain for agents to use, and so does
// a Message-ID in the usual form (headerId).
function summary(engine, m) {
  const out = { id: m.id };
  const cached = cacheMessage(engine, m.id);
  if (cached && cached.messageId) out.messageId = headerId(cached.messageId);
  const acc = accountOf(engine, m.accountId);
  Object.assign(out, {
    account: acc ? acc.email : m.accountId || null,
    folder: m.folder || null,
    role: agentRole(m.role),
    date: iso(m.date),
    from: emailAddr(m.from),
    to: (m.to || []).map(emailAddr),
    cc: (m.cc || []).map(emailAddr),
    subject: unsafeValue(m.subject),
    preview: unsafeValue(m.preview),
    unread: Boolean(m.unread),
    starred: Boolean(m.starred),
    has_attachments: Boolean(m.hasAttachments)
  });
  return out;
}

function summaryById(engine, id) {
  // A copy saved on this device has no folder cache: the saved list keeps what a summary needs.
  if (String(id).startsWith('saved:')) {
    const saved = engine.saved.find((s) => s.id === id);
    return saved ? summary(engine, { ...saved, unread: false }) : null;
  }
  const cached = cacheMessage(engine, id);
  if (!cached) return null;
  const { accountId, folder } = decodeId(id);
  const acc = accountOf(engine, accountId);
  return acc ? summary(engine, engine.publicMessage(acc, folder, cached)) : null;
}

function fullView(engine, m, maxChars = TEXT_MAX) {
  const text = String(m.text || '');
  const acc = accountOf(engine, m.accountId);
  const out = {
    id: m.id,
    message_id_header: headerId(m.messageId),
    account: acc ? acc.email : m.accountId || null,
    folder: m.folder || null,
    role: agentRole(m.role),
    date: iso(m.date),
    from: emailAddr(m.from),
    to: (m.to || []).map(emailAddr),
    cc: (m.cc || []).map(emailAddr),
    reply_to: (m.replyTo || []).map(emailAddr),
    subject: unsafeValue(m.subject),
    in_reply_to: unsafeValue(m.inReplyTo) || null,
    references: [].concat(m.references || []).map(unsafeValue).filter(Boolean),
    unread: Boolean(m.unread),
    starred: Boolean(m.starred),
    // The body is third-party text: inside <unsafe_content>, like everything Rukoo passes on from email.
    text: unsafeBlock(text.slice(0, maxChars), { source: 'email', message_id: m.messageId || '' }),
    truncated: text.length > maxChars,
    // The sender names an attachment and declares its type; only the index and size are Rukoo's.
    attachments: (m.attachments || []).map((a) => ({
      index: a.index,
      filename: unsafeValue(a.filename),
      content_type: unsafeValue(a.contentType || 'application/octet-stream'),
      size: a.size
    })),
    unsubscribe: Boolean(m.unsubscribe),
    // The List-Unsubscribe links, for an agent that finishes the page in its own browser
    // (skills/unsubscribe-via-browser). The sender wrote them, so they are tagged like the rest.
    unsubscribe_url: unsafeValue(m.unsubscribe && m.unsubscribe.url) || null,
    unsubscribe_mailto: unsafeValue(m.unsubscribe && m.unsubscribe.mail) || null
  };
  if ((m.bcc || []).length) out.bcc = m.bcc.map(emailAddr);
  return out;
}

function baseSubject(subject) {
  let s = String(subject || '').trim();
  const prefix = /^(?:re|fwd?|fw|antw|aw|doorst)(?:\s*\[\d+\])?\s*:\s*/i;
  for (let prev = null; prev !== s; ) {
    prev = s;
    s = s.replace(prefix, '').trim();
  }
  return s.toLowerCase().replace(/\s+/g, ' ');
}

function ownAddresses(engine) {
  return new Set(engine.accounts.flatMap((a) => engine.identities(a).map((i) => lower(i.address))));
}

const participants = (m) => [m.from, ...(m.to || []), ...(m.cc || [])].map((a) => lower(a && a.address)).filter(Boolean);

// The Message-IDs an email names: its own, the one it answers, and its References.
function threadIds(m) {
  return new Set([m.messageId, m.inReplyTo, ...[].concat(m.references || [])].map(normId).filter(Boolean));
}

// Whether an email is linked by its headers to one that names these ids: it is one of them, it answers one of them,
// or its References name one. The folder cache has no References; an email a chat keeps can have them.
function linked(ids, r) {
  const mid = normId(r.messageId);
  if ((mid && ids.has(mid)) || (r.inReplyTo && ids.has(normId(r.inReplyTo)))) return true;
  return [].concat(r.references || []).some((v) => ids.has(normId(v)));
}

// Related mail: linked by Message-ID/In-Reply-To/References, or the same base subject with someone in common
// other than the user. Few demo emails have threading headers, so the subject rule carries the rest there.
function threadOf(engine, m, limit = 10) {
  const ids = threadIds(m);
  const self = normId(m.messageId);
  const subject = baseSubject(m.subject);
  const own = ownAddresses(engine);
  const theirs = new Set(participants(m).filter((a) => !own.has(a)));
  const seen = new Set();
  const hits = [];
  for (const acc of engine.accounts) {
    const cache = engine.caches.get(acc.id);
    if (!cache) continue;
    const role = (p) => (cache.folders.find((f) => f.path === p) || {}).role;
    // Gmail's All Mail repeats other folders; look at it last so the real copy wins.
    const boxes = Object.entries(cache.boxes).sort(([a], [b]) => Number(role(a) === 'all') - Number(role(b) === 'all'));
    for (const [folder, box] of boxes) {
      for (const r of box.messages) {
        const id = encodeId(acc.id, folder, r.uid);
        const mid = normId(r.messageId);
        if (id === m.id || (mid && mid === self)) continue;
        const link = linked(ids, r);
        const similar = !link && subject && baseSubject(r.subject) === subject && participants(r).some((a) => theirs.has(a));
        if (!link && !similar) continue;
        const key = mid || id;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ acc, folder, r });
      }
    }
  }
  hits.sort((a, b) => (b.r.date || 0) - (a.r.date || 0));
  return hits.slice(0, limit).map(({ acc, folder, r }) => summary(engine, engine.publicMessage(acc, folder, r)));
}

// The Message-IDs of earlier mail in an email's thread, within one account, by headers only: the emails it names
// (In-Reply-To, References), and older mail linked to one of those the way threadOf links mail. That older mail is
// what the folder cache has, plus known: emails in the account whose headers Rukoo kept ({messageId, inReplyTo,
// references, date}), such as a chat's own, which count when they have left the cache. A shared subject does not
// count: "Invoice" or "Hello" says nothing about a thread.
function earlierInThread(engine, m, accountId, known = []) {
  const self = normId(m.messageId);
  const named = new Set([...threadIds(m)].filter((v) => v !== self));
  const out = new Set(named);
  const cache = accountId ? engine.caches.get(accountId) : null;
  const date = Number(m.date) || 0;
  // An email that answers nothing starts its thread: most mail stops here, before the cache is looked through.
  if (!named.size || !date) return out;
  const older = (r) => {
    const mid = normId(r.messageId);
    if (mid && mid !== self && (Number(r.date) || 0) < date && linked(named, r)) out.add(mid);
  };
  if (cache) for (const box of Object.values(cache.boxes)) for (const r of box.messages) older(r);
  for (const r of known) older(r);
  return out;
}

function findAccount(engine, value) {
  const v = lower(value);
  const acc = engine.accounts.find((a) => a.id === value || lower(a.email) === v || lower(a.label) === v);
  if (!acc) throw new ToolError(`Unknown account ${unsafeValue(value)}. Accounts: ${engine.accounts.map((a) => `${a.email} (id ${a.id})`).join(', ') || 'none'}.`);
  return acc;
}

const ROLE_WORDS = { inbox: 'inbox', sent: 'sent', drafts: 'drafts', draft: 'drafts', archive: 'archive', trash: 'trash', deleted: 'trash', bin: 'trash', junk: 'junk', spam: 'junk' };

// The exact path wins. A name, or a path in another case, must belong to one folder only: "2026" can be both
// Projects/2026 and Archive/2026, and then the call fails and asks for the path.
function resolveFolder(engine, acc, value) {
  const v = String(value || '').trim();
  const lv = v.toLowerCase();
  const folders = engine.publicAccount(acc).folders;
  const exact = folders.find((f) => f.path === v);
  if (exact) return exact.path;
  for (const same of [(f) => f.path.toLowerCase() === lv, (f) => String(f.name || '').toLowerCase() === lv]) {
    const hits = folders.filter(same);
    if (hits.length > 1) {
      const err = new ToolError(`More than one folder in ${acc.email} is called ${unsafeValue(v)}: ${hits.map((f) => f.path).join(', ')}. Pass the full path.`);
      err.ambiguous = true;
      throw err;
    }
    if (hits.length) return hits[0].path;
  }
  const role = ROLE_WORDS[lv];
  const byRole = role && folders.find((f) => f.role === role);
  return byRole ? byRole.path : null;
}

function folderList(engine, accounts) {
  return accounts.map((a) => `${a.email}: ${engine.publicAccount(a).folders.map((f) => f.path).join(', ')}`).join('; ');
}

async function loadMessage(engine, id) {
  try {
    return await engine.getMessage(id);
  } catch (_) {
    return null;
  }
}

// ---------- tools ----------

async function getContext(hub, args, call) {
  const { engine } = hub;
  const view = hub.viewState;
  const c = call.conversation;
  const openId = view.openMessageId && (cacheMessage(engine, view.openMessageId) || String(view.openMessageId).startsWith('saved:')) ? view.openMessageId : null;
  const boundId = c && c.message ? await hub.currentMessageId(c) : null;
  const [open, bound] = await Promise.all([
    openId ? loadMessage(engine, openId) : null,
    boundId && boundId !== openId ? loadMessage(engine, boundId) : null
  ]);
  const focus = bound || open;
  let composer = null;
  if (view.composer) composer = await hub.ui('getDraft', {}, 4000).then(draftView).catch(() => null);
  const today = new Date();
  return {
    conversation_id: c ? c.id : null,
    agent: call.agent,
    today: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    user: {
      accounts: engine.state().accounts.map((a) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        identities: (a.identities || []).map((i) => ({ address: i.address, name: i.name })),
        folders: (a.folders || []).map((f) => ({ path: f.path, role: f.role }))
      }))
    },
    open_message: open ? fullView(engine, open) : null,
    chat_message: bound ? fullView(engine, bound) : null,
    // The chat is about an email Rukoo cannot find right now (moved to an unsynced folder, or deleted).
    ...(c && c.message && !boundId ? { chat_message_missing: true, chat_message_subject: unsafeValue(c.message.subject) } : {}),
    thread: focus && focus.id && !String(focus.id).startsWith('saved:') ? threadOf(engine, focus) : [],
    selection: (view.checkedIds || []).slice(0, 20).map((id) => summaryById(engine, id)).filter(Boolean),
    composer,
    view: { scope: view.scope, view: view.view, folder: view.folder }
  };
}

function tokens(query) {
  return fold(query)
    .split(/\s+/)
    .map((t) => t.replace(/^["'(\[]+|["')\].,;:!?]+$/g, ''))
    .filter(Boolean);
}

async function searchMail(hub, args) {
  const { engine } = hub;
  const acc = args.account ? findAccount(engine, args.account) : null;
  let list;
  const unloaded = [];
  if (args.folder) {
    const targets = acc ? [acc] : engine.accounts;
    const paths = targets.map((a) => [a, resolveFolder(engine, a, args.folder)]).filter(([, p]) => p);
    if (!paths.length) throw new ToolError(`No folder ${unsafeValue(args.folder)}. Folders: ${folderList(engine, targets)}.`);
    // User folders are only in the cache after they were opened once. When opening fails (offline, signed
    // out), a folder with an earlier copy is searched in that copy; one without has nothing to search, and
    // the agent must not tell the user there is no such mail.
    await Promise.all(
      paths.map(([a, p]) =>
        engine.openFolder(a.id, p).catch((err) => {
          const cache = engine.caches.get(a.id);
          if (!(cache && cache.boxes[p])) unloaded.push({ account: a.email, folder: p, error: (err && err.message) || String(err) });
        })
      )
    );
    if (unloaded.length === paths.length) {
      const where = unloaded.map((u) => `"${u.folder}" in ${u.account} (${u.error})`).join(', ');
      throw new ToolError(`Rukoo could not load ${where}, so it could not search there. Tell the user; this does not mean there is no such mail.`);
    }
    list = paths.flatMap(([a, p]) => engine.listMessages({ scope: a.id, view: 'folder', folder: p, sort: 'date-desc' }));
  } else {
    list = engine.listMessages({ scope: acc ? acc.id : 'all', view: 'everything', sort: 'date-desc' });
  }
  const words = tokens(args.query);
  const from = fold(args.from).trim();
  const person = (a) => `${(a && a.name) || ''} ${(a && a.address) || ''}`;
  const hits = list.filter((m) => {
    if (args.unread !== undefined && Boolean(m.unread) !== args.unread) return false;
    if (from && !fold(person(m.from)).includes(from)) return false;
    if (!words.length) return true;
    const hay = fold([m.subject, m.preview, person(m.from), ...(m.to || []).map(person), ...(m.cc || []).map(person)].join(' '));
    return words.every((w) => hay.includes(w));
  });
  hits.sort((a, b) => b.date - a.date);
  const out = { results: hits.slice(0, args.limit || 15).map((m) => summary(engine, m)), total: hits.length };
  if (unloaded.length) out.unloaded_folders = unloaded;
  return out;
}

async function readMessage(hub, args) {
  const id = resolveId(hub, args.message_id);
  const m = await hub.engine.getMessage(id);
  return fullView(hub.engine, m, args.max_chars || TEXT_MAX);
}

function sizeText(n) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Local agents get a real file next to the content, named and marked like Rukoo's own temp attachments.
function writeTemp(hub, name, content) {
  try {
    // The hub's long-form path, the same folder Claude gets as --add-dir.
    const base = typeof hub.tempBase === 'function' ? hub.tempBase() : hub.deps.tempDir || path.join(os.tmpdir(), 'rukoo-agent');
    const dir = path.join(base, crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    // The hub removes these on quit; only its own, so a second Rukoo instance keeps its files.
    if (hub.tempDirs) hub.tempDirs.add(dir);
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    markOfTheWeb(file);
    return file;
  } catch (_) {
    return null;
  }
}

async function readAttachment(hub, args, call) {
  const { engine } = hub;
  const id = resolveId(hub, args.message_id);
  const full = await engine.getMessage(id);
  const meta = (full.attachments || []).find((a) => a.index === args.index);
  if (!meta) {
    const have = (full.attachments || []).map((a) => `${a.index}: ${unsafeValue(a.filename)}`).join(', ') || 'none';
    throw new ToolError(`That email has no attachment with index ${args.index}. Attachments: ${have}.`);
  }
  const a = await engine.attachment(id, args.index);
  const name = safeName(a.filename);
  const declared = String(a.contentType || meta.contentType || 'application/octet-stream').toLowerCase();
  // What Rukoo goes by and hands to the MCP client as mimeType; the sender's own words only show, tagged.
  const type = mimeType(declared);
  const bytes = a.content.length;
  // The file name and type are the sender's text, so they are tagged; local_path stays plain for the agent to open.
  const info = { message_id: id, index: args.index, filename: unsafeValue(name), content_type: unsafeValue(declared), size: bytes };
  if (RISKY.test(name)) {
    return { ...info, blocked: true, note: 'Rukoo does not hand out programs or scripts from email. Tell the user what it is instead.' };
  }
  if (bytes > ATTACHMENT_MAX) throw new ToolError(`${unsafeValue(name)} is ${sizeText(bytes)}; Rukoo hands out attachments up to 10 MB.`);
  const local = call.remote ? null : writeTemp(hub, name, a.content);
  return fileResult(hub, info, {
    name,
    type,
    content: a.content,
    local,
    uri: `rukoo://attachment/${encodeURIComponent(id)}/${args.index}`,
    source: 'attachment',
    signal: call.signal,
    // In the charset the attachment declares (Rukoo's own decoder, as for mail bodies); UTF-8 without one.
    decode: (buffer) => decodeCharset(buffer, a.charset || charsetOf(meta.contentType) || 'utf-8')
  });
}

// A file as read_attachment and read_chat_file hand it out: text as text, an image as an image, a PDF as its text
// with the file as a resource, anything else as a resource. local: a copy local agents can open. The text sits
// inside <unsafe_content>; source says where it came from.
async function fileResult(hub, info, { name, type, content, local = null, uri, source, decode, signal = null }) {
  const out = local ? { ...info, local_path: local } : { ...info };
  if (TEXT_TYPES.test(type) || TEXT_EXT.test(name)) {
    const text = decode(content).replace(/^\uFEFF/, '');
    return { ...out, text: unsafeBlock(text.slice(0, ATTACHMENT_TEXT_MAX), { source, filename: name }), truncated: text.length > ATTACHMENT_TEXT_MAX };
  }
  const data = content.toString('base64');
  if (IMAGE_TYPES.test(type) && content.length <= IMAGE_MAX) {
    // No structured result: Codex passes only that on when there is one, and the image would never reach it.
    return raw([{ type: 'text', text: JSON.stringify(out) }, { type: 'image', data, mimeType: type }]);
  }
  const resource = { type: 'resource', resource: { uri, mimeType: type, blob: data } };
  const saved = local ? ' and saved at local_path' : '';
  if (isPdf(content)) {
    // Codex takes no PDF, and Hermes elsewhere gets the file without a reader, so the text comes along. The note
    // tells the agent when that is not all of it: past ATTACHMENT_TEXT_MAX there is more text (truncated), and a
    // reader that stopped early or failed leaves the rest only in the file (partial, failed).
    const pdf = await hub.pdf.read(content, { maxChars: ATTACHMENT_TEXT_MAX, signal });
    const file = `The file itself is attached as a resource${saved}.`;
    let note;
    if (pdf.failed) note = `Rukoo could not extract text from this PDF: ${PDF_FAILED[pdf.failed] || PDF_FAILED.error}. ${file}`;
    else if (!pdf.text) note = `${pdf.encrypted ? 'The PDF is encrypted, so Rukoo could not read its text.' : pdf.partial ? "Rukoo's reader stopped at its limits before it found text in this PDF." : 'Rukoo found no text in this PDF; it may be scanned.'} ${file}`;
    else if (pdf.partial) note = `text is only part of the PDF's text: Rukoo's reader stopped at its limits before the end, so the rest is only in the file itself. ${file}`;
    else if (pdf.truncated) note = `text is the first ${ATTACHMENT_TEXT_MAX} characters of the PDF's text as Rukoo extracted it; the file itself has the rest. ${file}`;
    else note = `text is the PDF's text as Rukoo extracted it, without images or layout. ${file}`;
    const full = {
      ...out,
      pages: pdf.pages,
      ...(pdf.text ? { text: unsafeBlock(pdf.text, { source, filename: name }), truncated: pdf.truncated } : {}),
      ...(pdf.partial ? { partial: true } : {}),
      ...(pdf.failed ? { failed: pdf.failed } : {}),
      note
    };
    return raw([{ type: 'text', text: JSON.stringify(full) }, resource], full);
  }
  const note = `The file is attached as a resource${saved}.`;
  return raw([{ type: 'text', text: JSON.stringify({ ...out, note }) }, resource], { ...out, note });
}

// The files the user attached to messages in this chat (hub.send keeps them in the chat's folder). Their names are
// the user's file names, which anyone can have chosen, so they are tagged like an email's attachment names.
async function readChatFile(hub, args, call) {
  const c = call.conversation;
  if (!c) throw new ToolError('Rukoo does not know which chat this is. Pass the conversation_id from the message.');
  const list = Array.isArray(c.files) ? c.files : [];
  const listing = () => list.map((f) => ({ file_id: f.id, filename: unsafeValue(f.name), content_type: f.type, size: f.size }));
  if (!args.file_id) return { conversation_id: c.id, files: listing() };
  const want = String(args.file_id).trim();
  const f = list.find((x) => x.id === want);
  if (!f) {
    const have = list.map((x) => `${x.id}: ${unsafeValue(x.name)}`).join(', ') || 'none';
    throw new ToolError(`This chat has no file with file_id ${unsafeValue(want)}. Its files: ${have}.`);
  }
  let content;
  try {
    content = hub.files.read(c.id, f);
  } catch (_) {
    throw new ToolError(`Rukoo no longer has ${unsafeValue(f.name)}. Ask the user to attach it again.`);
  }
  const info = { conversation_id: c.id, file_id: f.id, filename: unsafeValue(f.name), content_type: f.type, size: content.length };
  return fileResult(hub, info, {
    name: f.name,
    type: f.type,
    content,
    // The chat's own copy, in the folder Claude Code and Codex work in.
    local: call.remote ? null : hub.files.path(c.id, f),
    // Hermes names the copy it saves after the last part.
    uri: `rukoo://chat-file/${encodeURIComponent(c.id)}/${f.id}/${encodeURIComponent(f.name)}`,
    source: 'file',
    signal: call.signal,
    decode: decodeText
  });
}

const ADDRESS = /^[^@\s<>,;]+@[^@\s<>,;]+$/;

function people(list, field) {
  if (list === undefined) return undefined;
  const out = [];
  for (const v of list) {
    const parts = typeof v === 'string' ? v.split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/) : [v];
    for (const p of parts) {
      let name = '';
      let address = '';
      if (typeof p === 'string') {
        const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(p);
        if (m) [name, address] = [m[1].trim(), m[2].trim()];
        else address = p.trim();
      } else {
        name = String(p.name || '').trim();
        address = String(p.address || '').trim();
      }
      if (!address) continue;
      if (!ADDRESS.test(address)) throw new ToolError(`${field}: ${unsafeValue(address)} is not an email address.`);
      out.push({ name: name.slice(0, 200), address: address.slice(0, 320) });
    }
  }
  return out;
}

function windowError(err, what) {
  const code = err && err.code;
  if (code === 'window') return new ToolError(`Rukoo's window is closed, so ${what}. Ask the user to open Rukoo Mail.`);
  if (code === 'timeout') return new ToolError(`Rukoo did not respond in time, so ${what}. Check with get_draft before trying again.`);
  if (code === 'busy' && /writing another email/i.test((err && err.detail) || '')) {
    return new ToolError(
      "The user is writing another email in Rukoo's composer, so the draft was not shown. Do not retry on your own: ask the user to finish or close that email, then write the draft again. You can put the text in the chat meanwhile."
    );
  }
  if (code === 'busy') return new ToolError('The composer is busy (sending or closing). Wait a moment and try again.');
  return new ToolError(`Rukoo could not update the composer: ${(err && (err.detail || err.message)) || err}`);
}

async function writeDraft(hub, args, call) {
  // Without a conversation yet (an external caller), the one ensureConversation finds or makes is about the
  // open email, so the open email is the right default there too.
  const bound = call.conversation;
  const mode = args.mode || null;
  let messageId = null;
  if (args.message_id) messageId = resolveId(hub, args.message_id, { allowSaved: true });
  else if (mode !== 'new') {
    if (bound && bound.message) {
      // Never fall back to whatever email is open: the reply would go to someone else.
      messageId = await hub.currentMessageId(bound);
      // Finding a moved email can sync a folder first; the user may have deleted the chat meanwhile.
      if (hub.conversations.get(bound.id) !== bound) throw new ToolError('This chat was deleted, so Rukoo did not write the draft.');
      if (!messageId) {
        throw new ToolError(
          'Rukoo cannot find the email this chat is about any more (it may have moved to another folder or been deleted). Pass message_id: search_mail with its folder finds the current id.'
        );
      }
    } else messageId = hub.openMessageId() || null;
  }
  const finalMode = mode || (messageId ? 'reply' : 'new');
  if (finalMode !== 'new' && !messageId) throw new ToolError(`Mode "${finalMode}" needs an email: pass message_id, or use mode "new".`);
  // Recipients the agent did not pass stay absent, so the composer keeps its own; an empty list clears the field.
  const to = people(args.to, 'to');
  const cc = people(args.cc, 'cc');
  const bcc = people(args.bcc, 'bcc');
  const format = args.format || 'markdown';
  const html = toHtml(args.body, format);
  // The composer takes at most this much formatted text (sanitizeAgentHtml in the renderer). Past it the
  // draft would be cut off mid-way, so it is refused whole instead, before a chat is made for it.
  if (html.length > DRAFT_HTML_MAX) {
    throw new ToolError(`The draft is too long for the composer: ${html.length} characters once formatted, the limit is ${DRAFT_HTML_MAX}. Write a shorter one.`);
  }
  const c = hub.ensureConversation(call);
  // html-to-text turns each <div><br></div> spacer into an extra blank line; fold those back.
  const bodyText = (format === 'text' ? String(args.body) : htmlToPlain(html).replace(/\n{3,}/g, '\n\n')).trim();
  const request = {
    messageId: finalMode === 'new' ? null : messageId,
    mode: COMPOSER_MODES[finalMode],
    html,
    agentName: hub.agentName(call.agent),
    conversationId: c.id
  };
  if (to) request.to = to;
  if (cc) request.cc = cc;
  if (bcc) request.bcc = bcc;
  if (args.subject !== undefined) request.subject = args.subject;
  let res;
  try {
    res = await hub.ui('writeDraft', request, 20000);
  } catch (err) {
    throw windowError(err, 'the draft could not be shown');
  }
  const shown = (res && (res.draft || res)) || {};
  const shownTo = Array.isArray(shown.to) ? shown.to.map(addr) : to || [];
  const shownCc = Array.isArray(shown.cc) ? shown.cc.map(addr) : cc || [];
  const subject = typeof shown.subject === 'string' ? shown.subject : args.subject || '';
  hub.addItem(c, {
    type: 'draft',
    mode: finalMode,
    to: shownTo,
    subject,
    summary: bodyText.replace(/\s+/g, ' ').slice(0, 160),
    messageRef: request.messageId,
    // The composer that holds this draft; the card's Show and Undo only act on that one.
    composerKey: typeof shown.key === 'string' && shown.key ? shown.key.slice(0, 100) : null,
    undone: false
  });
  // What the composer holds now, as the renderer read it back; the agent's own text only if it said nothing.
  const composerText = typeof shown.text === 'string' ? shown.text : bodyText;
  // A reply's recipients and subject come from the email, so the agent gets them tagged; the card above keeps
  // them plain for the user.
  return {
    ok: true,
    conversation_id: c.id,
    draft: { mode: finalMode, to: shownTo.map(emailAddr), cc: shownCc.map(emailAddr), subject: unsafeValue(subject), body_text: composerText.slice(0, TEXT_MAX) },
    note: 'The draft is in the composer. The user reviews and sends it; you cannot send email.'
  };
}

// The composer as agents see it. A reply's recipients and subject are filled in from the email it answers, so
// they are tagged like the email's own; from is one of the user's addresses and stays plain.
function draftView(d) {
  if (!d || typeof d !== 'object') return null;
  const text = String(d.text || '');
  return {
    open: true,
    mode: d.mode || null,
    from: d.from || null,
    to: Array.isArray(d.to) ? d.to.map(emailAddr) : [],
    cc: Array.isArray(d.cc) ? d.cc.map(emailAddr) : [],
    bcc: Array.isArray(d.bcc) ? d.bcc.map(emailAddr) : [],
    subject: unsafeValue(d.subject),
    text: text.slice(0, TEXT_MAX),
    truncated: text.length > TEXT_MAX,
    agent: d.agent ? (typeof d.agent === 'object' ? d.agent.name || null : String(d.agent)) : null,
    dirty: Boolean(d.dirty)
  };
}

async function getDraft(hub) {
  let d;
  try {
    d = await hub.ui('getDraft', {}, 5000);
  } catch (err) {
    if (err && err.code === 'window') return { open: false, note: "Rukoo's window is closed." };
    throw windowError(err, 'the draft could not be read');
  }
  return draftView(d) || { open: false };
}

const SAFE_URL = /^(https?:\/\/|mailto:|obsidian:\/\/)/i;
const safeUrl = (u) => (u && SAFE_URL.test(String(u).trim()) ? String(u).trim() : null);

function showPlan(hub, args, call) {
  // With no conversation to update, every task is new: checked before one is made, so a bad call from
  // outside a chat leaves nothing behind.
  const untitled = args.tasks.find((t) => !t.title);
  if (untitled && !call.conversation && !hub.externalFor(call.agent)) {
    throw new ToolError(`Task ${untitled.id || '(no id)'} is new and needs a title. Pass conversation_id to update a plan you showed earlier.`);
  }
  const c = hub.ensureConversation(call);
  const plans = c.items.filter((i) => i.type === 'plan');
  let item = args.plan_id ? plans.find((p) => p.planId === args.plan_id) : null;
  if (!item && !args.plan_id) {
    const latest = plans[plans.length - 1];
    if (latest && args.tasks.every((t) => t.id && latest.tasks.some((x) => x.id === t.id))) item = latest;
  }
  const isNew = !item;
  // Check before changing anything, so a bad call leaves the plan on screen as it was.
  for (const t of args.tasks) {
    const known = item && t.id && item.tasks.some((x) => x.id === t.id);
    if (!known && !t.title) throw new ToolError(`Task ${t.id || '(no id)'} is new and needs a title.`);
  }
  if (isNew) {
    let n = plans.length + 1;
    while (plans.some((p) => p.planId === `p${n}`)) n++;
    item = { type: 'plan', planId: args.plan_id || `p${n}`, title: args.title || '', tasks: [] };
  } else if (args.title !== undefined) {
    item.title = args.title;
  }
  const nextId = () => {
    let n = item.tasks.length + 1;
    while (item.tasks.some((t) => t.id === `t${n}`)) n++;
    return `t${n}`;
  };
  for (const t of args.tasks) {
    const existing = t.id ? item.tasks.find((x) => x.id === t.id) : null;
    const task = existing || { id: t.id || nextId(), title: '', detail: '', system: '', status: 'todo', url: null, owner: '', due: '' };
    for (const k of ['title', 'detail', 'system', 'status', 'owner', 'due']) if (t[k] !== undefined) task[k] = t[k];
    if (t.url !== undefined) task.url = safeUrl(t.url);
    if (!existing) item.tasks.push(task);
  }
  if (isNew) item = hub.addItem(c, item);
  else hub.updateItem(c, item);
  return { conversation_id: c.id, plan_id: item.planId, tasks: item.tasks.map(({ id, title, status }) => ({ id, title, status })) };
}

async function showSources(hub, args, call) {
  const c = hub.ensureConversation(call);
  const sources = [];
  for (const s of args.sources) {
    let messageId = null;
    if (s.message_id) {
      try {
        messageId = resolveId(hub, s.message_id);
      } catch (_) {
        messageId = null;
      }
    }
    // Rukoo ids change when mail moves, and a saved copy can be deleted; the Message-ID header and the account
    // let the card find the email again later (hub.locate). A copy saved before Rukoo kept its header has it in
    // its file.
    const known = messageId ? hub.liveMessage(messageId) : null;
    let header = known && known.messageId;
    if (!header && messageId && messageId.startsWith('saved:')) header = ((await loadMessage(hub.engine, messageId)) || {}).messageId;
    const messageHeader = header ? String(header).slice(0, 1000) : null;
    const accountId = messageId ? accountOfId(messageId) || (known && known.accountId) || null : null;
    sources.push({ title: s.title, source: s.source || (messageId ? 'Email' : ''), snippet: s.snippet || '', url: safeUrl(s.url), messageId, messageHeader, accountId });
  }
  hub.addItem(c, { type: 'sources', title: args.title || '', sources });
  return { ok: true, conversation_id: c.id, shown: sources.length };
}

function proposeAction(hub, args, call) {
  const c = hub.ensureConversation(call);
  const pending = hub.requestApproval(c.id, {
    title: args.title,
    detail: args.detail || '',
    fields: (args.fields || []).map((f) => ({ label: f.label, value: f.value })),
    choices: [
      { id: 'approve', label: args.confirm_label || 'Approve', kind: 'primary' },
      { id: 'decline', label: 'Decline', kind: 'default' }
    ],
    source: call.agent,
    kind: 'proposal'
  });
  return {
    conversation_id: c.id,
    proposal_id: pending.itemId,
    status: 'waiting_for_user',
    note: 'Stop here and wait. When the user approves, you receive a new message that says so; then carry it out. If they decline, you will be told.'
  };
}

const VERBS = {
  archive: ['Archive', 'Archived'],
  trash: ['Delete', 'Moved to Trash:'],
  move: ['Move', 'Moved'],
  mark_read: ['Mark as read', 'Marked as read:'],
  mark_unread: ['Mark as unread', 'Marked as unread:'],
  star: ['Star', 'Starred'],
  unstar: ['Unstar', 'Removed the star from'],
  unsubscribe: ['Unsubscribe', 'Unsubscribed from']
};
const MOVES = new Set(['archive', 'trash', 'move']);
const emails = (n) => `${n} email${n === 1 ? '' : 's'}`;

// From the email, so one line and short: it ends up in card titles and in the agent's notes.
function senderName(engine, id) {
  const m = cacheMessage(engine, id);
  const name = (m && m.from && (m.from.name || m.from.address)) || '';
  return String(name).replace(/\s+/g, ' ').trim().slice(0, 80) || 'this sender';
}

// What the card was made for, so an approval never lands on another message that took over the same
// folder and uid (a rebuilt server mailbox gets a new UIDVALIDITY and hands out the uids again).
function pinOf(engine, id) {
  const { accountId, folder } = decodeId(id);
  const cache = engine.caches.get(accountId);
  const box = cache && cache.boxes[folder];
  const m = cacheMessage(engine, id);
  return { messageId: (m && m.messageId) || null, uidValidity: box && box.uidValidity != null ? String(box.uidValidity) : null };
}

function samePin(engine, id, pin) {
  if (!pin) return true;
  const now = pinOf(engine, id);
  if (pin.uidValidity && now.uidValidity && pin.uidValidity !== now.uidValidity) return false;
  if (pin.messageId && normId(now.messageId) !== normId(pin.messageId)) return false;
  return true;
}

function mailTitle(engine, { action, ids, folder }) {
  const n = ids.length;
  switch (action) {
    case 'move':
      return `Move ${emails(n)} to ${folder}`;
    case 'trash':
      return `Delete ${emails(n)}`;
    case 'mark_read':
      return `Mark ${emails(n)} as read`;
    case 'mark_unread':
      return `Mark ${emails(n)} as unread`;
    case 'unsubscribe': {
      const senders = [...new Set(ids.map((id) => senderName(engine, id)))];
      return senders.length === 1 ? `Unsubscribe from ${senders[0]}` : `Unsubscribe from ${senders.length} senders`;
    }
    default:
      return `${VERBS[action][0]} ${emails(n)}`;
  }
}

async function mailAction(hub, args, call) {
  const { engine } = hub;
  const ids = [];
  const bad = [];
  for (const v of [...new Set(args.message_ids)]) {
    try {
      ids.push(resolveId(hub, v, { allowSaved: false }));
    } catch (err) {
      // An email in more than one account is not unknown: say which accounts have it.
      if (err && err.ambiguous) throw err;
      bad.push(v);
    }
  }
  if (bad.length) throw new ToolError(`Unknown message ids: ${bad.map((b) => unsafeValue(b)).join(', ')}. Ids change when mail moves; use search_mail for current ids.`);
  const accounts = [...new Set(ids.map((id) => decodeId(id).accountId))].map((a) => accountOf(engine, a)).filter(Boolean);
  if (args.action === 'move') {
    if (!args.folder) throw new ToolError('folder is required for move.');
    const missing = accounts.filter((a) => !resolveFolder(engine, a, args.folder));
    if (missing.length) throw new ToolError(`No folder ${unsafeValue(args.folder)}. Folders: ${folderList(engine, missing)}.`);
  }
  if (args.action === 'archive') {
    const none = accounts.filter((a) => !engine.archiveFolder(a.id));
    if (none.length) throw new ToolError(`${none.map((a) => a.email).join(', ')} has no archive folder. Use move instead.`);
  }
  const c = hub.ensureConversation(call);
  const spec = { action: args.action, ids, folder: args.action === 'move' ? args.folder : null, pins: ids.map((id) => pinOf(engine, id)) };
  const title = mailTitle(engine, spec);
  // The setting covers archive, move and mark. Deleting and unsubscribing always ask, and so does a move
  // that lands in Trash, which is a delete by another name.
  const intoTrash =
    spec.action === 'move' &&
    accounts.some((a) => {
      const target = resolveFolder(engine, a, args.folder);
      return engine.publicAccount(a).folders.some((f) => f.path === target && f.role === 'trash');
    });
  if (hub.cfg.data.autoMailActions && spec.action !== 'unsubscribe' && spec.action !== 'trash' && !intoTrash) {
    // The agent's call waits for this, but its client gives up after 120 s, and a slow IMAP server can take longer.
    // Then the call answers that the work goes on, and the outcome comes with the agent's next message, which
    // waits for it, the same way an approved action reports.
    // The actions run on the conversation's mail chain, after earlier mail work, so they happen in the order they
    // were asked for. Whichever comes first decides: the work ends (the call answers with the result) or the wait
    // does (the call says the work goes on, and the outcome becomes a note).
    let late = false;
    let finished = false;
    let answer;
    const first = new Promise((resolve) => (answer = resolve));
    const timer = setTimeout(() => {
      if (finished) return;
      late = true;
      answer(null);
    }, hub.mailWait || AUTO_MAIL_WAIT_MS);
    hub.settleMail(
      c,
      async () => {
        let result = null;
        let error = null;
        try {
          result = await executeMail(hub, c, spec);
        } catch (err) {
          error = err;
        }
        finished = true;
        clearTimeout(timer);
        if (!late) return answer({ result, error });
        const action = unsafeInline(title, 'mail action');
        c.notes.push(
          error
            ? `Rukoo could not finish ${action}: ${unsafeInline((error && (error.detail || error.message)) || String(error), 'mail result')}. Part of it may be done; check the mail before you try again.`
            : `Rukoo finished ${action}: ${unsafeInline(result.text, 'mail result')}.`
        );
        hub.touch(c);
        if (error) throw error;
      },
      title
    );
    const outcome = await first;
    if (!outcome) {
      return {
        conversation_id: c.id,
        status: 'in_progress',
        note: 'Rukoo is still doing this. You will be told the outcome in your next message; do not repeat the request.'
      };
    }
    if (outcome.error) throw outcome.error;
    const result = outcome.result;
    return { conversation_id: c.id, status: 'done', done: result.done.length, failed: result.failed, undoable: result.undo.length > 0, summary: result.text };
  }
  const fields = ids.slice(0, 6).map((id) => {
    const m = cacheMessage(engine, id) || {};
    return { label: (m.from && (m.from.name || m.from.address)) || '', value: m.subject || '(no subject)' };
  });
  if (ids.length > 6) fields.push({ label: '', value: `and ${ids.length - 6} more` });
  const pending = hub.requestApproval(c.id, {
    title,
    detail: '',
    fields,
    choices: [
      { id: 'approve', label: VERBS[spec.action][0], kind: 'primary' },
      { id: 'decline', label: 'Cancel', kind: 'default' }
    ],
    source: 'rukoo',
    kind: 'mail',
    mail: spec
  });
  return {
    conversation_id: c.id,
    proposal_id: pending.itemId,
    status: 'waiting_for_user',
    note: 'Rukoo is asking the user. Do not repeat the request; you will be told the outcome in your next message.'
  };
}

// Runs an approved (or auto-approved) mail action, adds a notice to the conversation and returns what happened.
// How long a mail_action call waits for actions that run without asking: a client gives up on a tool call after
// 120 s. Past this the call answers that the work goes on; see mailAction().
const AUTO_MAIL_WAIT_MS = 90000;

async function executeMail(hub, c, { action, ids, folder, pins = [] }) {
  const { engine } = hub;
  const done = [];
  const failed = [];
  const undo = [];
  // Unsubscribes by what Rukoo could do: done (one-click), the page opened in the browser, or an email opened
  // to send (its address). Only the first is finished; the others wait for the user.
  const unsubscribed = [];
  const opened = [];
  const mailed = [];
  for (const [i, id] of ids.entries()) {
    try {
      const cached = cacheMessage(engine, id);
      if (!cached || !samePin(engine, id, pins[i])) throw new Error('The email is no longer there (it may have moved).');
      const { accountId, folder: current } = decodeId(id);
      const acc = engine.account(accountId);
      if (action === 'archive') await engine.archive(id);
      else if (action === 'trash') {
        const trash = engine.folderByRole(accountId, 'trash');
        // Never delete for good: mail that is already in the trash stays there.
        if (!(trash && trash.path === current)) {
          const r = await engine.remove(id);
          if (r === 'confirm') throw new Error(`${acc.email} has no Trash folder.`);
        }
      } else if (action === 'move') {
        // The folder was there when the action was asked for. Its name came from the agent and may be a sender's
        // text, and this message reaches the agent, so it does not repeat the name.
        let dest;
        try {
          dest = resolveFolder(engine, acc, folder);
        } catch (_) {
          throw new Error(`More than one folder in ${acc.email} has the destination's name now. Ask again with its full path.`);
        }
        if (!dest) throw new Error(`The destination folder is no longer in ${acc.email}.`);
        await engine.move(id, dest);
      } else if (action === 'mark_read') await engine.setFlags(id, { unread: false });
      else if (action === 'mark_unread') await engine.setFlags(id, { unread: true });
      else if (action === 'star') await engine.setFlags(id, { starred: true });
      else if (action === 'unstar') await engine.setFlags(id, { starred: false });
      else if (action === 'unsubscribe') {
        if (!hub.deps.unsubscribe) throw new Error('Unsubscribe is not available.');
        const r = (await hub.deps.unsubscribe(id)) || {};
        if (r.opened) opened.push(id);
        else if (r.mailto) {
          // The sender only takes requests by email: open it, filled in, like the reader's Unsubscribe
          // button does. The user sends it; Rukoo never does.
          const to = mailtoAddress(r.mailto);
          if (!to || !hub.deps.openMailto) throw new Error('This sender only takes unsubscribe requests by email.');
          await hub.deps.openMailto(String(r.mailto));
          mailed.push(to);
        } else unsubscribed.push(id);
      }
      done.push(id);
      if (MOVES.has(action) && engine.canUndo(id)) undo.push(id);
    } catch (err) {
      failed.push({ id, error: (err && err.message) || String(err) });
    }
  }
  let text;
  if (action === 'unsubscribe') {
    // Only a one-click unsubscribe is done. A page in the browser may still ask to confirm or sign in, and
    // Rukoo cannot see whether it worked.
    const parts = [];
    if (unsubscribed.length) {
      const senders = [...new Set(unsubscribed.map((id) => senderName(engine, id)))];
      parts.push(senders.length === 1 ? `Unsubscribed from ${senders[0]}` : `Unsubscribed from ${senders.length} senders`);
    }
    if (opened.length) {
      parts.push(
        opened.length === 1
          ? `Opened the unsubscribe page for ${senderName(engine, opened[0])} in the browser. Finish there; Rukoo cannot tell whether it worked`
          : `Opened ${opened.length} unsubscribe pages in the browser. Finish there; Rukoo cannot tell whether they worked`
      );
    }
    if (mailed.length) parts.push(mailed.length === 1 ? `Opened an unsubscribe email to ${mailed[0]}. Send it to finish` : `Opened ${mailed.length} unsubscribe emails. Send them to finish`);
    text = parts.join('. ');
  } else if (action === 'move') text = `Moved ${emails(done.length)} to ${folder}`;
  else text = `${VERBS[action][1]} ${emails(done.length)}`;
  if (!done.length) text = `Could not ${VERBS[action][0].toLowerCase()} ${emails(ids.length)}`;
  if (failed.length) text += `. ${failed.length} failed: ${failed[0].error}`;
  hub.addItem(c, {
    type: 'notice',
    text,
    tone: done.length ? 'success' : 'error',
    code: null,
    undo: undo.length ? { kind: 'move', ids: undo } : null,
    // An unsubscribe that still needs sending, or finishing in the browser, is not "Unsubscribed": the renderer
    // translates a result of only one kind and shows a mixed one as it is.
    mail: {
      action: mailed.length ? 'unsubscribe_email' : opened.length ? 'unsubscribe_page' : action,
      count: done.length,
      failed: failed.length,
      folder: folder || null,
      mailed: mailed.length,
      to: mailed.length === 1 ? String(mailed[0]).slice(0, 320) : null,
      opened: opened.length,
      sender: opened.length === 1 ? senderName(engine, opened[0]) : null
    }
  });
  return { done, failed, undo, text };
}

// ---------- skills ----------

// Skills come from Rukoo's skills folder and the user's, never from an email, so nothing here is tagged.
function readSkill(hub, args) {
  if (args.file && !args.name) throw new ToolError('Pass the name of the skill the file belongs to.');
  if (!hub.skills) return { skills: [] };
  try {
    return hub.skills.read({ name: args.name || '', file: args.file || '' });
  } catch (err) {
    if (err instanceof SkillError) throw new ToolError(err.message);
    throw err;
  }
}

// The first address of a mailto: link, or null.
function mailtoAddress(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'mailto:') return null;
    const first = decodeURIComponent(u.pathname).split(',')[0].trim();
    return ADDRESS.test(first) ? first.slice(0, 320) : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  TOOLS,
  TOOL_NAMES,
  list,
  callTool,
  executeMail,
  isRukooTool,
  bareName,
  validate,
  findByMessageId,
  copiesOf,
  accountOfId,
  cacheMessage,
  summaryById,
  threadOf,
  earlierInThread,
  baseSubject,
  resolveFolder,
  mailTitle,
  ToolError
};
