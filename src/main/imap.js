'use strict';

const { t } = require('../i18n');

const { ImapFlow } = require('imapflow');
const { hasCapability, canUseFlag } = require('imapflow/lib/tools.js');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const util = require('./mailutil');
const { SIGNAL_HEADERS, headerMap, mailSignals } = require('./categories/signals');
const { appPasswordProvider } = require('./providers');

const PREVIEW_BYTES = 4096;
// What a cached message needs from the server besides its flags. These never change for a uid, so a sync fetches
// them only for messages the cache doesn't have yet; see syncFolder(). References never change either, but a cache
// from before Rukoo kept them fetches them on their own (describe()), so this list leaves them out.
const STORED = ['messageId', 'inReplyTo', 'subject', 'from', 'to', 'cc', 'replyTo', 'date', 'preview', 'hasAttachments', 'size'];

// The longest uid set a command gets, in characters: well under the 8000 octets a server must take for a whole
// command line (RFC 7162, section 4).
const SET_CHARS = 4000;

// uids as IMAP sequence sets such as "4:6,9", runs of consecutive uids as one range, split so that each set stays
// within SET_CHARS: [{ set, uids }], uids being the ones the set names. A range names only uids of the list, all of
// which the folder holds or held.
function uidChunks(uids) {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const chunks = [];
  let chunk = { set: '', uids: [] };
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const part = i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`;
    if (chunk.set && chunk.set.length + 1 + part.length > SET_CHARS) {
      chunks.push(chunk);
      chunk = { set: '', uids: [] };
    }
    chunk.set = chunk.set ? `${chunk.set},${part}` : part;
    chunk.uids.push(...sorted.slice(i, j + 1));
    i = j + 1;
  }
  if (chunk.set) chunks.push(chunk);
  return chunks;
}

const uidSets = (uids) => uidChunks(uids).map((c) => c.set);

// What a move or delete that didn't go as asked gives for an email. refused: the server turned it down, and Rukoo read
// back that nothing changed: the email is still in its folder, by its own UID in the folder's generation the command
// used, and the destination of a move took nothing in (moveTurn()). unsent: Rukoo never sent the command for the
// email (the connection or the folder didn't open, the folder was rebuilt since, code 'UIDVALIDITY', the server has
// no UID EXPUNGE for it, or a quit stopped the batch), so it changed nothing, though it read nothing back either.
// unknown: anything else, such as an answer that never came or one that proves nothing; the engine syncs the folders
// involved before anything is retried. copied: a server without MOVE kept the copy it made (moveTurn()).
const refusal = (key, extra = {}) => Object.assign(new Error(t(key)), { refused: true, ...extra });
const uncertain = (key, extra = {}) => Object.assign(new Error(t(key)), { unknown: true, ...extra });
const unsent = (key) => Object.assign(new Error(t(key)), { unsent: true });

// How many emails of a batch go under one mailbox lock, one turn on the connection. Between turns the user's other
// commands get their go. The flags a delete reads first, and the checks after failures, cover a turn at a time.
const TURN = 100;

// How long Rukoo uses what it knows of a destination's UIDNEXT (ImapAccount.uidNexts) before it asks again. Older
// knowledge would still be safe, only less precise: see moveTurn().
const UIDNEXT_FRESH_MS = 60000;

// imapflow's own test for a capability, which counts what IMAP4rev2 has built in once that version is active.
const has = (client, capability) => Boolean(client.capabilities) && hasCapability({ capabilities: client.capabilities, enabled: client.enabled || new Set() }, capability);

// Whether imapflow's messageMove sends MOVE, by imapflow's own test: the MOVE capability, or IMAP4rev2, whose base
// protocol has MOVE (RFC 9051 section 6.4.8). Without it Rukoo copies and deletes itself; see moveTurn().
const canMove = (client) => !client.capabilities || has(client, 'MOVE');

// Whether the open folder keeps a MODSEQ for each email (CONDSTORE, RFC 7162), by which the server can show that a
// flag is the one Rukoo set (deleteOne()).
const modseqs = (client) => Boolean(client.enabled && client.enabled.has('CONDSTORE') && client.mailbox && !client.mailbox.noModseq);

// UIDVALIDITY and UIDNEXT of a folder other than the open one, as { validity, next }; null when STATUS doesn't give
// both. A STATUS answer only comes for the folder asked: Rukoo doesn't turn on NOTIFY, the one way to get others.
async function folderState(client, path) {
  if (client.usable === false) return null;
  try {
    const status = await client.status(path, { uidNext: true, uidValidity: true });
    if (!status || status.uidNext == null || status.uidValidity == null) return null;
    return { validity: String(status.uidValidity), next: Number(status.uidNext) };
  } catch (_) {
    return null;
  }
}

// What the server says now of these uids in the open folder, read by UID in sets that fit a command line: a Map
// uid → { flags, modseq }, modseq with CONDSTORE only. Only answers that carry one of these UIDs count: a server may
// send a FETCH of another email with them (RFC 9051 section 7.5.2), and imapflow lists that one too. A uid the map
// lacks isn't in the folder. null when the read failed. An EXPUNGE or VANISHED during the read may be of one of these
// emails, after its FETCH line came (RFC 9051 section 7.5.1 lets a server send it during a UID FETCH), so that read
// proves nothing: Rukoo reads once more, and gives null when it happens again.
async function readMany(client, uids) {
  if (client.usable === false) return null;
  const want = new Set(uids.map(Number));
  for (let attempt = 0; attempt < 2; attempt++) {
    let expunged = false;
    const onExpunge = () => {
      expunged = true;
    };
    if (typeof client.on === 'function') client.on('expunge', onExpunge);
    const out = new Map();
    try {
      for (const set of uidSets([...want])) {
        for (const m of (await client.fetchAll(set, { uid: true, flags: true }, { uid: true })) || []) {
          const uid = Number(m && m.uid);
          if (want.has(uid) && m.flags) out.set(uid, { flags: m.flags, modseq: m.modseq != null ? String(m.modseq) : null });
        }
      }
    } catch (_) {
      return null;
    } finally {
      if (typeof client.off === 'function') client.off('expunge', onExpunge);
    }
    if (client.usable === false) return null;
    if (!expunged) return out;
  }
  return null;
}

// What a FETCH line in the answer to a command says of an email: { uid, modseq }.
function fetchLine(untagged) {
  const list = (untagged && untagged.attributes && untagged.attributes[1]) || [];
  const out = { uid: null, modseq: null };
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = String((list[i] && list[i].value) || '').toUpperCase();
    const value = list[i + 1];
    if (key === 'UID') out.uid = Number(value && value.value);
    else if (key === 'MODSEQ' && Array.isArray(value) && value[0] && /^\d+$/.test(String(value[0].value))) out.modseq = String(value[0].value);
  }
  return out;
}

// The code in brackets of a tagged answer, such as MODIFIED, in capitals.
function answerCode(response) {
  const section = response && response.attributes && response.attributes[0] && response.attributes[0].section;
  return section && section[0] && typeof section[0].value === 'string' ? section[0].value.toUpperCase() : '';
}

// How a command Rukoo sent itself ended when it didn't answer OK: 'no' for the server's NO or BAD, 'lost' when no
// answer came.
const failedAs = (client, err) => (client.usable !== false && err && err.responseStatus ? 'no' : 'lost');

// A UID STORE of \Deleted on uid in the open folder: op '+' sets it, '-' takes it off. With since, the server changes
// the email only if nothing changed it after that MODSEQ (UNCHANGEDSINCE, RFC 7162 section 3.1.3). Rukoo sends this
// command itself: imapflow's messageFlagsAdd answers true for a STORE the condition left alone (MODIFIED), and puts
// UNCHANGEDSINCE after the flags, where the RFC has it before them. It runs under a mailbox lock, which keeps imapflow
// from starting IDLE in between. Answers { status, modseq }: 'ok' with the MODSEQ the server gave the change,
// 'modified' when the condition left the email alone, or failedAs(). modseq is null unless exactly one FETCH can be
// of this email: another session's change to it while the STORE runs comes as a FETCH of the same UID, and a FETCH
// without a UID may be of it too, so with more than one Rukoo can't tell which MODSEQ is its own.
async function storeDeleted(client, uid, op, since = null) {
  if (op === '+' && !canUseFlag(client.mailbox, '\\Deleted')) return { status: 'no' };
  const attributes = [{ type: 'SEQUENCE', value: String(uid) }];
  if (since != null) attributes.push([{ type: 'ATOM', value: 'UNCHANGEDSINCE' }, { type: 'ATOM', value: String(since) }]);
  attributes.push({ type: 'ATOM', value: `${op}FLAGS` }, [{ type: 'ATOM', value: '\\Deleted' }]);
  let modseq = null;
  let lines = 0;
  try {
    const response = await client.exec('UID STORE', attributes, {
      untagged: {
        FETCH: async (untagged) => {
          const line = fetchLine(untagged);
          if (line.uid !== Number(uid) && Number.isInteger(line.uid)) return;
          lines++;
          modseq = line.modseq;
        }
      }
    });
    const code = answerCode(response.response);
    response.next();
    return code === 'MODIFIED' ? { status: 'modified' } : { status: 'ok', modseq: lines === 1 ? modseq : null };
  } catch (err) {
    return { status: failedAs(client, err) };
  }
}

// The EXPUNGE of uid, once it carries \Deleted: UID EXPUNGE (UIDPLUS), which leaves other emails marked for deletion
// alone. Rukoo never sends a plain EXPUNGE, which removes every email of the folder that carries \Deleted: one another
// app marked, or one whose earlier delete failed. Without UIDPLUS nothing gets this far (deleteMany(), moveTurn()).
// 'ok', or failedAs().
async function expungeOne(client, uid) {
  try {
    const response = await client.exec('UID EXPUNGE', [{ type: 'SEQUENCE', value: String(uid) }]);
    response.next();
    return 'ok';
  } catch (err) {
    return failedAs(client, err);
  }
}

// Deletes uid from the open folder: a STORE of \Deleted, then an EXPUNGE, each of which can fail on its own. before:
// what readMany() said of the email before its turn. When the EXPUNGE fails, \Deleted comes off again only when the
// server shows that this STORE set it and nothing changed the email since: it had no \Deleted at that read, the STORE
// went on condition that nothing changed it after the read, and taking the flag off goes on condition that nothing
// changed it after the STORE. Anything else, a server without CONDSTORE included, leaves the flag: another app may
// have set it. Answers 'deleted', 'store' (the STORE failed), 'expunge' (the EXPUNGE failed) or 'lost' (an answer
// never came).
async function deleteOne(client, uid, before) {
  const since = before && before.modseq && !before.flags.has('\\Deleted') ? before.modseq : null;
  let set = await storeDeleted(client, uid, '+', since);
  const mine = since != null && set.status === 'ok' ? set.modseq : null;
  // Something changed the email after the read: a plain STORE, whose flag Rukoo can't tell from another app's.
  if (set.status === 'modified') set = await storeDeleted(client, uid, '+');
  if (set.status !== 'ok') return set.status === 'lost' ? 'lost' : 'store';
  const expunged = await expungeOne(client, uid);
  if (expunged !== 'no') return expunged === 'ok' ? 'deleted' : 'lost';
  if (mine && (await storeDeleted(client, uid, '-', mine)).status === 'lost') return 'lost';
  return 'expunge';
}

// A connection and the commands waiting for it: what the user waits for goes first, then background work. idle
// settles when its queue has run dry.
const line = () => ({ client: null, busy: false, idle: Promise.resolve(), queue: { now: [], later: [] } });

// Hosts whose SMTP service already files a copy in the Sent folder.
const AUTO_SENT_HOSTS = /(gmail\.com|googlemail\.com|office365\.com|outlook\.com)$/i;

const errorText = (err) => String((err && (err.responseText || err.response || err.message)) || err);

// Whether the server turned the username and password down, as opposed to not being reached. imapflow marks a failed
// LOGIN or AUTHENTICATE, nodemailer a failed SMTP AUTH with EAUTH. Gmail says "Application-specific password
// required" to a normal Google password, in IMAP and in SMTP.
function authFailed(err) {
  if (!err || err.oauth) return false;
  if (err.authenticationFailed || err.code === 'EAUTH') return true;
  return /AUTHENTICATIONFAILED|Invalid credentials|authentication failed|535|Username and Password not accepted|Application-specific password required/i.test(errorText(err));
}

// account: the account the error is for, when known. A refused sign-in at a provider that only takes an app
// password then says so instead of the general message.
function friendlyError(err, account = null) {
  const msg = errorText(err);
  if (err && err.oauth) return msg;
  if (authFailed(err)) {
    const provider = appPasswordProvider(account);
    if (provider === 'google') return t('errors.connection.googleAppPassword');
    if (provider === 'yahoo') return t('errors.connection.yahooAppPassword');
    return t('errors.connection.auth');
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return t('errors.connection.host');
  if (/ECONNREFUSED/i.test(msg)) return t('errors.connection.refused');
  if (/ETIMEDOUT|timeout/i.test(msg)) return t('errors.connection.timeout');
  if (/certificate|self.signed|CERT_/i.test(msg)) return t('errors.connection.certificate');
  return msg;
}

// What went wrong as one word, for the log in the profile (diaglog.js): never the server's own text, which can name
// the account.
function errorCode(err) {
  if (!err) return null;
  if (err.oauth) return 'oauth';
  if (authFailed(err)) return 'auth';
  const msg = `${errorText(err)} ${typeof err.code === 'string' ? err.code : ''}`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'host';
  if (/ECONNREFUSED/i.test(msg)) return 'refused';
  if (/ETIMEDOUT|timeout/i.test(msg)) return 'timeout';
  if (/certificate|self.signed|CERT_/i.test(msg)) return 'certificate';
  if (typeof err.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,30}$/.test(err.code)) return err.code;
  return 'other';
}

// How many messages in the open folder are unread below uid first, the oldest message of the window a sync fetches;
// null when the server doesn't say. Only below the window: the engine counts the window's unread mail in its cache,
// where reading a message counts at once. With ESEARCH the server sends only the count; otherwise imapflow counts the
// uids it gets.
async function unseenBelow(client, first) {
  if (!first) return null;
  if (first === 1) return 0;
  try {
    const found = await client.search({ seen: false, uid: `1:${first - 1}` }, { uid: true, returnOptions: ['COUNT'] });
    if (Array.isArray(found)) return found.length;
    return found && Number.isInteger(found.count) ? found.count : null;
  } catch (_) {
    return null;
  }
}

// The flags of the messages with these uids in the open folder, as { uid, unread, starred, answered }; a uid the
// server no longer has is left out. null when the server doesn't answer, so the caller keeps what it had.
async function flagsOf(client, uids) {
  try {
    const out = [];
    for await (const m of client.fetch(uids.join(','), { uid: true, flags: true }, { uid: true })) {
      const flags = m.flags || new Set();
      out.push({ uid: m.uid, unread: !flags.has('\\Seen'), starred: flags.has('\\Flagged'), answered: flags.has('\\Answered') });
    }
    return out;
  } catch (_) {
    return null;
  }
}

// The uids in the open folder that match query, within criteria (a uid range, flags). Gmail searches the way its own
// search box does (X-GM-RAW), the message text included; not with gmail false, for Spam and Trash, which that search
// leaves out unless asked. Other servers, and Gmail when its search fails, compare the subject and the addresses.
// imapflow answers false for a search the server refused.
async function searchUids(client, criteria, query, { gmail = true } = {}) {
  if (gmail && client.capabilities && client.capabilities.has('X-GM-EXT-1')) {
    try {
      const found = await client.search({ ...criteria, gmraw: query }, { uid: true });
      if (Array.isArray(found)) return found;
    } catch (_) {
      // The plain search below.
    }
  }
  const found = await client.search({ ...criteria, or: [{ subject: query }, { from: query }, { to: query }, { cc: query }] }, { uid: true });
  if (!Array.isArray(found)) throw new Error(t('errors.search.refused'));
  return found;
}

// The cache's form of the messages in rows (uid and flags each, as a FETCH gave them), in the order of rows. What known
// holds for a uid is reused; envelope, structure and a preview come from the server only for the rest: on a large
// Gmail folder that is the slow part, and repeating it every sync kept the connection busy for minutes. signals: also
// what kind of mail each one is (categories/signals.js). references: also the References of each one, which the
// envelope leaves out. tabs: the Gmail tab of each uid, or null when not asked. A message gone between the fetches
// (moved or deleted meanwhile) is left out.
async function describe(client, rows, { known = new Map(), signals = false, references = false, tabs = null } = {}) {
  // A cached date that isn't a number is one an unreadable Date header left before Rukoo fell back to INTERNALDATE
  // (null on disk): such a message is described again, which gives it the date the server received it.
  const cached = (uid) => {
    const prior = known.get(uid);
    return Boolean(prior) && STORED.every((k) => k in prior) && Number.isFinite(prior.date);
  };
  const fresh = rows.filter((m) => !cached(m.uid)).map((m) => m.uid);
  const details = new Map();
  if (fresh.length) {
    for await (const m of client.fetch(fresh.join(','), { uid: true, envelope: true, bodyStructure: true, internalDate: true, size: true }, { uid: true })) {
      details.set(m.uid, m);
    }
    // imapflow skips a FETCH response it can't parse, and the command still succeeds. It parses 25 levels of
    // parentheses, so a message with some 22 nested multiparts is left out, and would be asked for on every sync
    // and never listed. Asked again without the structure, it lists by its envelope, without a preview or
    // attachment mark, and is cached.
    const missing = fresh.filter((uid) => !details.has(uid));
    if (missing.length) {
      for await (const m of client.fetch(missing.join(','), { uid: true, envelope: true, internalDate: true, size: true }, { uid: true })) {
        details.set(m.uid, m);
      }
    }
  }

  // Fetch a few KB of the readable part for messages we have not seen before.
  const previews = new Map();
  const byPart = new Map();
  for (const m of details.values()) {
    const node = util.findPreviewPart(m.bodyStructure);
    if (!node) continue;
    const key = util.partKey(node);
    if (!byPart.has(key)) byPart.set(key, []);
    byPart.get(key).push({ uid: m.uid, node });
  }
  for (const [key, items] of byPart) {
    const nodes = new Map(items.map((i) => [i.uid, i.node]));
    const uids = items.map((i) => i.uid).join(',');
    for await (const m of client.fetch(uids, { uid: true, bodyParts: [{ key, maxLength: PREVIEW_BYTES }] }, { uid: true })) {
      const node = nodes.get(m.uid);
      const buf = m.bodyParts && m.bodyParts.values().next().value;
      if (!buf || !node) continue;
      const decodedAlready = m.binaryParts && m.binaryParts.size > 0;
      const effective = decodedAlready ? { ...node, encoding: '7bit' } : node;
      try {
        previews.set(m.uid, util.previewFromPart(buf, effective));
      } catch (_) {
        previews.set(m.uid, '');
      }
    }
  }

  // A few header lines, for new messages and for ones cached before Rukoo kept them.
  const kinds = new Map();
  if (signals) {
    const need = rows.filter((r) => details.has(r.uid) || !(known.get(r.uid) || {}).signals).map((r) => r.uid);
    if (need.length) {
      for await (const m of client.fetch(need.join(','), { uid: true, headers: SIGNAL_HEADERS }, { uid: true })) {
        kinds.set(m.uid, mailSignals(m.headers));
      }
    }
  }
  // The References line, by which the reader's related emails find a later reply that names this one
  // (engine.relatedMessages): for new messages, and once for ones cached before Rukoo kept it. That upgrade costs one
  // small header fetch per folder, where a field added to STORED would fetch the whole window again. An empty list
  // means the message has none, so it isn't asked for again.
  const refs = new Map();
  if (references) {
    const need = rows.filter((r) => details.has(r.uid) || !Array.isArray((known.get(r.uid) || {}).references)).map((r) => r.uid);
    for (const set of uidSets(need)) {
      for await (const m of client.fetch(set, { uid: true, headers: ['references'] }, { uid: true })) {
        refs.set(m.uid, util.referenceIds(headerMap(m.headers).references));
      }
    }
  }
  const extra = (uid, prior) => {
    const out = {};
    const kind = kinds.get(uid) || (prior && prior.signals);
    if (kind) out.signals = kind;
    const named = refs.get(uid) || (prior && prior.references);
    if (Array.isArray(named)) out.references = named;
    if (tabs) out.gmailTab = tabs.get(uid) || 'primary';
    else if (prior && prior.gmailTab) out.gmailTab = prior.gmailTab;
    return out;
  };

  const messages = [];
  for (const row of rows) {
    const flags = row.flags || new Set();
    const state = { unread: !flags.has('\\Seen'), starred: flags.has('\\Flagged'), answered: flags.has('\\Answered') };
    const m = details.get(row.uid);
    const prior = known.get(row.uid);
    if (!m) {
      // Gone between the fetches: the next sync no longer lists it.
      if (!cached(row.uid)) continue;
      messages.push({ uid: row.uid, ...Object.fromEntries(STORED.map((k) => [k, prior[k]])), ...state, ...extra(row.uid, prior) });
      continue;
    }
    const env = m.envelope || {};
    messages.push({
      uid: m.uid,
      messageId: env.messageId || null,
      inReplyTo: env.inReplyTo || null,
      subject: env.subject || '',
      from: util.addressFromEnvelope(env.from)[0] || { name: '', address: '' },
      to: util.addressFromEnvelope(env.to),
      cc: util.addressFromEnvelope(env.cc),
      replyTo: util.addressFromEnvelope(env.replyTo),
      // A Date header imapflow couldn't parse comes as its text: the date the server received the email then.
      date: util.validTime(env.date, m.internalDate) ?? Date.now(),
      preview: previews.has(m.uid) ? previews.get(m.uid) : prior ? prior.preview || '' : '',
      ...state,
      hasAttachments: util.hasAttachments(m.bodyStructure),
      size: m.size || 0,
      ...extra(m.uid, prior)
    });
  }
  return messages;
}

class ImapAccount {
  // credentials: a password string, or { accessToken: async () => token } for OAuth (XOAUTH2).
  constructor(account, credentials) {
    this.account = account;
    this.credentials = credentials;
    // Two connections. The main one does all the work: syncs, prefetching, flags, moves. The reader only fetches the
    // message the user opens (read()), so opening one never waits for a sync or prefetch that is running.
    this.main = line();
    this.reader = line();
    // Set when the server turned the reader down: reads then go over the main connection, ahead of its waiting work.
    this.oneConnection = false;
    // Set by close(): the account is gone or uses a new session, so nothing may connect through this one again.
    this.closed = false;
    // What Rukoo knows of folders' UIDNEXT, by path: { validity, next, at }, next being at most the real UIDNEXT. A
    // move's checks use it; see moveTurn().
    this.uidNexts = new Map();
  }

  async auth(user) {
    const c = this.credentials;
    if (c && typeof c === 'object' && c.accessToken) return { user, accessToken: await c.accessToken() };
    return { user, pass: c };
  }

  async imapOptions() {
    const { imap } = this.account;
    return {
      host: imap.host,
      port: Number(imap.port),
      secure: Boolean(imap.secure),
      auth: await this.auth(imap.user || this.account.email),
      logger: false,
      emitLogs: false,
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 5 * 60 * 1000,
      tls: { rejectUnauthorized: !imap.allowInvalidCert }
    };
  }

  async transport() {
    const { smtp } = this.account;
    const auth = await this.auth(smtp.user || this.account.email);
    return nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port),
      secure: Boolean(smtp.secure),
      requireTLS: !smtp.secure,
      auth: auth.accessToken ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : auth,
      connectionTimeout: 20000,
      tls: { rejectUnauthorized: !smtp.allowInvalidCert }
    });
  }

  async connect(conn = this.main) {
    if (conn.client && conn.client.usable) return conn.client;
    const client = new ImapFlow(await this.imapOptions());
    const drop = () => {
      if (conn.client === client) conn.client = null;
    };
    client.on('error', drop);
    client.on('close', drop);
    try {
      await client.connect();
    } catch (err) {
      // A rejected login can leave the TLS socket open.
      client.close();
      throw err;
    }
    // Closed while it connected: the session is gone, so the connection goes too.
    if (this.closed) {
      client.logout().catch(() => client.close());
      throw new Error(t('errors.connection.closed'));
    }
    conn.client = client;
    return client;
  }

  // The commands on a connection run one at a time. Background work waits until nothing else is queued: a flag
  // change goes ahead of the next folder of a sync, but not ahead of the command already running.
  run(fn, { background = false } = {}) {
    return this.queue(this.main, fn, background);
  }

  // Fetching the message the user opens: over the reader connection, which nothing else uses. It only reads, so it
  // can run next to a sync without the two seeing different states of a change.
  read(fn) {
    return this.oneConnection ? this.run(fn) : this.queue(this.reader, fn, false);
  }

  queue(conn, fn, background) {
    return new Promise((resolve, reject) => {
      conn.queue[background ? 'later' : 'now'].push({ fn, resolve, reject });
      this.drain(conn);
    });
  }

  async drain(conn) {
    if (conn.busy) return;
    conn.busy = true;
    let done;
    conn.idle = new Promise((resolve) => (done = resolve));
    try {
      for (let task; (task = conn.queue.now.shift() || conn.queue.later.shift()); ) {
        if (this.closed) {
          task.reject(new Error(t('errors.connection.closed')));
          continue;
        }
        let client;
        try {
          client = await this.connect(conn);
        } catch (err) {
          client = await this.oneAtATime(conn, task, err);
          if (!client) continue;
        }
        // Nothing runs for a session closed while it connected: an account removed, or signed in again.
        if (this.closed) {
          task.reject(new Error(t('errors.connection.closed')));
          continue;
        }
        try {
          task.resolve(await task.fn(client));
        } catch (err) {
          if (conn.client && !conn.client.usable) conn.client = null;
          task.reject(err);
        }
      }
    } finally {
      conn.busy = false;
      done();
    }
  }

  // A server that takes one connection at a time turns down whichever of the two connects second. From then on
  // everything goes over the main connection, reads ahead of waiting background work, as before there was a reader.
  // Returns the client to run task on, or null once task is turned down or handed to the main connection.
  async oneAtATime(conn, task, err) {
    const other = conn === this.reader ? this.main : this.reader;
    if (!other.client || !other.client.usable) {
      task.reject(err);
      return null;
    }
    this.oneConnection = true;
    if (conn === this.reader) {
      for (const waiting of [task, ...conn.queue.now.splice(0)]) this.run(waiting.fn).then(waiting.resolve, waiting.reject);
      return null;
    }
    // The main connection is the one that has to work: the reader finishes the message it is fetching, hands over
    // what waits for it and logs out, and the main connection tries again.
    for (const waiting of this.reader.queue.now.splice(0)) this.run(waiting.fn).then(waiting.resolve, waiting.reject);
    await this.reader.idle;
    const reader = this.reader.client;
    this.reader.client = null;
    if (reader) {
      try {
        await reader.logout();
      } catch (_) {
        reader.close();
      }
    }
    // Closed meanwhile: the command is for a session that is gone.
    if (this.closed) {
      task.reject(new Error(t('errors.connection.closed')));
      return null;
    }
    try {
      return await this.connect(conn);
    } catch (again) {
      task.reject(again);
      return null;
    }
  }

  async verify() {
    const client = new ImapFlow(await this.imapOptions());
    client.on('error', () => {});
    try {
      await client.connect();
      await client.logout();
    } catch (err) {
      client.close();
      throw this.verifyError('IMAP', err);
    }
    try {
      const transport = await this.transport();
      await transport.verify();
      transport.close();
    } catch (err) {
      throw this.verifyError('SMTP', err);
    }
  }

  // The reason after the server that gave it, with code 'auth' when that server turned the sign-in down, so the
  // setup form can tell a wrong password from a server address to correct. A provider that only takes an app
  // password gets its message without the server: the same app password signs in to both. appPasswordProvider names
  // that provider, also for an account added under "Other", so the form links to the page its message points to.
  verifyError(server, err) {
    const auth = authFailed(err);
    const provider = auth ? appPasswordProvider(this.account) : null;
    const out = new Error(provider ? friendlyError(err, this.account) : `${server}: ${friendlyError(err, this.account)}`);
    if (auth) out.code = 'auth';
    if (provider) out.appPasswordProvider = provider;
    return out;
  }

  listFolders({ background = false } = {}) {
    return this.run(async (client) => {
      const list = await client.list();
      return list
        .filter((f) => !(f.flags && f.flags.has && f.flags.has('\\Noselect')))
        .map((f) => {
          const folder = {
            path: f.path,
            name: f.name,
            delimiter: f.delimiter,
            specialUse: f.specialUse || null,
            flags: f.flags ? Array.from(f.flags) : []
          };
          folder.role = util.folderRole(folder);
          delete folder.flags;
          return folder;
        });
    }, { background });
  }

  // Creates a top-level folder in the personal namespace and returns its path.
  createFolder(name) {
    return this.run(async (client) => {
      const prefix = (client.namespace && client.namespace.prefix) || '';
      const res = await client.mailboxCreate(prefix + name);
      return (res && res.path) || prefix + name;
    });
  }

  // limit: how many of the newest messages the cache keeps, or a function that says so when the command runs: Load
  // older can widen the window while the sync waits for the connection. signals: also what kind of mail each message
  // is (categories/signals.js); gmailTabs: also the Gmail tab each message is in. Both are for the inbox and its
  // categories. olderUnseen: also how many messages older than the window are unread, which the inbox's unread count
  // adds to the window's own. keep: uids below the window the cache holds as well (the older mail a server search
  // found), or a function that gives them when the command runs; kept then has the flags of those the server still
  // has, as { uid, unread, starred, answered }. Not after a UIDVALIDITY change, when they are other messages.
  syncFolder(path, { limit = 200, known: knownIn = new Map(), uidValidity = null, background = false, signals = false, gmailTabs = false, olderUnseen = false, keep = null } = {}) {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const box = client.mailbox;
        // After a UIDVALIDITY change old UIDs point at different messages; reuse nothing.
        const same = Boolean(uidValidity) && String(box.uidValidity) === String(uidValidity);
        const known = same ? knownIn : new Map();
        const result = { uidValidity: String(box.uidValidity), exists: box.exists, messages: [] };
        if (!box.exists) return result;
        const size = typeof limit === 'function' ? limit() : limit;
        const start = Math.max(1, box.exists - size + 1);
        // The flags of every message in the window: all that can change about a message the cache already has.
        const rows = [];
        for await (const m of client.fetch(`${start}:*`, { uid: true, flags: true })) rows.push(m);
        const first = rows.length ? Math.min(...rows.map((r) => r.uid)) : null;
        // Gmail doesn't show its tabs as folders, but its own search finds them (X-GM-RAW). Asked again on every sync,
        // since a message can move to another tab. What none of them holds is in Primary.
        let tabs = null;
        if (gmailTabs && rows.length && client.capabilities && client.capabilities.has('X-GM-EXT-1')) {
          tabs = new Map();
          try {
            for (const tab of ['promotions', 'social', 'updates', 'forums']) {
              const uids = await client.search({ uid: `${first}:*`, gmraw: `category:${tab}` }, { uid: true });
              for (const uid of uids || []) tabs.set(uid, tab);
            }
          } catch (_) {
            tabs = null;
          }
        }
        if (olderUnseen) result.olderUnseen = start === 1 ? 0 : await unseenBelow(client, first);
        result.messages = await describe(client, rows, { known, signals, references: true, tabs });
        const older = same && keep ? (typeof keep === 'function' ? keep() : keep).filter((uid) => !first || uid < first) : [];
        if (older.length) result.kept = await flagsOf(client, older);
        return result;
      } finally {
        lock.release();
      }
    }, { background });
  }

  // Older mail that matches query, for a search of more than the cache holds: in the folder at path, below the uid
  // below (the oldest message the cache has; null for the whole folder). The newest limit matches come back in the
  // cache's form, reusing what known has as syncFolder does, with total saying how many matched in all. criteria: more
  // to match, such as { seen: false }. signals as for syncFolder. gmail: false keeps Gmail to the plain search, for its
  // Spam and Trash. The user waits for it, so it goes ahead of a sync.
  searchFolder(path, query, { below = null, limit = 50, known: knownIn = new Map(), uidValidity = null, signals = false, criteria = {}, gmail = true } = {}) {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const box = client.mailbox;
        const known = uidValidity && String(box.uidValidity) === String(uidValidity) ? knownIn : new Map();
        const result = { uidValidity: String(box.uidValidity), total: 0, messages: [] };
        if (!box.exists || below === 1) return result;
        const uids = await searchUids(client, { ...criteria, uid: below ? `1:${below - 1}` : '1:*' }, query, { gmail });
        result.total = uids.length;
        const newest = [...uids].sort((a, b) => b - a).slice(0, limit);
        if (!newest.length) return result;
        const rows = [];
        for await (const m of client.fetch(newest.join(','), { uid: true, flags: true }, { uid: true })) rows.push(m);
        result.messages = await describe(client, rows, { known, signals });
        return result;
      } finally {
        lock.release();
      }
    });
  }

  // The message the user opens comes over the reader, with the folder opened read-only: that connection only reads.
  // A prefetch runs on the main connection and opens the folder read-write, like setFlags: imapflow reopens a folder
  // whenever the mode changes. Either way the fetch leaves the flags alone: imapflow fetches with PEEK.
  fetchSource(path, uid, { background = false } = {}) {
    const fetch = async (client) => {
      const lock = await client.getMailboxLock(path, background ? {} : { readOnly: true });
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error(t('errors.message.serverMissing'));
        return msg.source;
      } finally {
        lock.release();
      }
    };
    return background ? this.run(fetch, { background }) : this.read(fetch);
  }

  // A large message the user opens, without its attachments: its structure and header first, then the parts the
  // reader shows and the MIME header of every part (mailutil.readableParts), rebuilt into a source mailparser reads
  // like the whole message (mailutil.skeletonSource). Over the reader, like fetchSource. null when the message
  // doesn't split.
  fetchReadable(path, uid) {
    return this.read(async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const head = await client.fetchOne(String(uid), { uid: true, bodyStructure: true, headers: true, size: true }, { uid: true });
        if (!head || !head.bodyStructure || !head.headers) throw new Error(t('errors.message.serverMissing'));
        const keys = util.readableParts(head.bodyStructure, head.size);
        if (!keys) return null;
        const msg = await client.fetchOne(String(uid), { uid: true, bodyParts: keys }, { uid: true });
        // Every part asked for, or the whole message: a text part the server left out would read as an empty one.
        if (!msg || !msg.bodyParts || !keys.every((key) => Buffer.isBuffer(msg.bodyParts.get(key.toLowerCase())))) {
          throw new Error(t('errors.message.serverMissing'));
        }
        return util.skeletonSource(head.headers, head.bodyStructure, msg.bodyParts);
      } finally {
        lock.release();
      }
    });
  }

  setFlags(path, uid, patch) {
    return this.setFlagsMany(path, [uid], patch);
  }

  // The flags of many messages in the folder at path: one mailbox lock and one STORE per flag for all of them, a few
  // more when their uids don't fit one command line (uidChunks()). imapflow answers false for a STORE the server turned
  // down, or one it could not send; that throws here, so the engine puts the flags back. The error's stored lists the
  // uids whose sets the server took before that, which keep the change. Like any UID STORE, a uid the folder no longer
  // has is skipped without an error.
  setFlagsMany(path, uids, { unread, starred, answered }) {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(path);
      const stored = [];
      try {
        const opts = { uid: true };
        const store = async (op, set, flag) => {
          if ((await client[op](set, [flag], opts)) === false) throw new Error(t('errors.flags.refused'));
        };
        for (const { set, uids: named } of uidChunks(uids)) {
          if (unread === true) await store('messageFlagsRemove', set, '\\Seen');
          if (unread === false) await store('messageFlagsAdd', set, '\\Seen');
          if (starred === true) await store('messageFlagsAdd', set, '\\Flagged');
          if (starred === false) await store('messageFlagsRemove', set, '\\Flagged');
          if (answered === true) await store('messageFlagsAdd', set, '\\Answered');
          stored.push(...named);
        }
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { stored });
      } finally {
        lock.release();
      }
    });
  }

  // Runs work over uids in turns of TURN, each turn under its own lock of path, and returns what each uid got: a Map
  // uid → { uid, uidValidity } for a move, {} for a delete, or { error } (refusal() and the rest). With
  // expectUidValidity it touches nothing in a path whose uids were given out again since: they would name other
  // emails. work(client, uids, results, sent) records a result for each uid it sends a command for, after adding the
  // uid to sent. A uid it leaves without one goes into the next turn: the connection went before its go, so nothing
  // was sent for it. A turn that fails gives every uid still without a result its error: unsent for those nothing was
  // sent for, unknown (by unknownKey) for any it was. stopped(): true once a quit can't be called off any more
  // (engine.stopBatches()); work finishes the email it is on and sends no further one, and the rest is unsent.
  async inTurns(path, uids, expectUidValidity, unknownKey, work, stopped = null) {
    const results = new Map();
    let todo = [...new Set(uids.map(Number))];
    while (todo.length) {
      if (stopped && stopped()) {
        const quit = Object.assign(new Error(t('errors.connection.closed')), { unsent: true });
        for (const uid of todo) results.set(uid, { error: quit });
        break;
      }
      const turn = todo.slice(0, TURN);
      const sent = new Set();
      try {
        await this.run(async (client) => {
          const lock = await client.getMailboxLock(path);
          try {
            if (expectUidValidity != null && String(client.mailbox.uidValidity) !== String(expectUidValidity)) {
              throw Object.assign(new Error(t('errors.folder.rebuilt')), { code: 'UIDVALIDITY' });
            }
            // A lock on the folder that is open already doesn't end imapflow's IDLE, and the STOREs and EXPUNGEs Rukoo
            // sends itself (storeDeleted()) would wait behind it. A NOOP ends it; the lock keeps a new one from starting.
            if (client.idling) await client.noop();
            await work(client, turn, results, sent);
          } finally {
            lock.release();
          }
        });
      } catch (err) {
        const failed = Object.assign(err instanceof Error ? err : new Error(String(err)), { unsent: true });
        for (const uid of todo) if (!results.has(uid)) results.set(uid, { error: sent.has(uid) ? uncertain(unknownKey) : failed });
        break;
      }
      const left = todo.filter((uid) => !results.has(uid));
      // Not one email had its go: the connection was gone from the start.
      if (left.length === todo.length) {
        const gone = Object.assign(new Error(t('errors.connection.closed')), { unsent: true });
        for (const uid of left) results.set(uid, { error: gone });
        break;
      }
      todo = left;
    }
    return results;
  }

  // What Rukoo knows of destination's UIDNEXT, from uidNexts while it is fresh, or else from a STATUS.
  async destinationState(client, path) {
    const known = this.uidNexts.get(path);
    if (known && Date.now() - known.at < UIDNEXT_FRESH_MS) return known;
    return this.knowState(path, await folderState(client, path));
  }

  // Keeps what a STATUS said of path's UIDVALIDITY and UIDNEXT, or forgets it when it said nothing.
  knowState(path, state) {
    if (!state) {
      this.uidNexts.delete(path);
      return null;
    }
    const known = { ...state, at: Date.now() };
    this.uidNexts.set(path, known);
    return known;
  }

  // After a MOVE or COPY that answered OK: path took the email at uid to, so in that UIDVALIDITY its UIDNEXT is past
  // that. Without a COPYUID Rukoo knows nothing of the folder until its next STATUS.
  movedInto(path, known, to, uidValidity) {
    if (!to || !uidValidity) return this.knowState(path, null);
    const next = known && known.validity === uidValidity ? Math.max(known.next, to + 1) : to + 1;
    return this.knowState(path, { validity: uidValidity, next });
  }

  // One turn of moveMany(): a MOVE (or a COPY and a delete) per email. One that fails counts as refused only with
  // proof that it changed nothing: the email is still in the open folder by its UID, in the UIDVALIDITY of the turn,
  // and the destination took nothing in. For that Rukoo keeps the destination's UIDVALIDITY and UIDNEXT (uidNexts).
  // Within one UIDVALIDITY UIDNEXT only grows, with every email added (RFC 9051 section 2.3.1.1), so what Rukoo knows
  // is never above it. When an OK's COPYUID gives the email exactly that next uid, or a STATUS after the failures
  // still says it, nothing came into the destination in between, from the failures neither. Mail that arrives
  // meanwhile can turn a refusal into unknown, never the other way round. So the checks cost one STATUS per
  // destination and batch, and a FETCH and a STATUS per turn with failures. imapflow answers false for a NO, a BAD and
  // a lost connection alike, and a server can make the copy before it answers NO: RFC 6851 section 3.3 only says it
  // SHOULD NOT leave an email in both folders.
  async moveTurn(client, turn, destination, results, sent, stopped = null) {
    const opts = { uid: true };
    const move = canMove(client);
    // Without MOVE a move is a COPY and a delete, which needs UID EXPUNGE (expungeOne()): nothing is sent, so nothing
    // is copied or marked.
    if (!move && !has(client, 'UIDPLUS')) {
      for (const uid of turn) results.set(uid, { error: unsent('errors.move.noUidExpunge') });
      return;
    }
    const validity = String(client.mailbox.uidValidity);
    // For the deletes after a COPY: the flags before, where MODSEQs can show which \Deleted is Rukoo's.
    const before = !move && modseqs(client) ? await readMany(client, turn) : null;
    let known = await this.destinationState(client, destination);
    const failed = [];
    // The failures not shown yet to have added nothing to the destination, and those shown to.
    let open = [];
    const clean = new Set();
    for (const uid of turn) {
      if (client.usable === false || (stopped && stopped())) break;
      sent.add(uid);
      const res = await client[move ? 'messageMove' : 'messageCopy'](String(uid), destination, opts).catch(() => false);
      if (!res) {
        failed.push(uid);
        open.push(uid);
        continue;
      }
      const to = res.uidMap ? res.uidMap.get(uid) || null : null;
      const uidValidity = res.uidValidity != null ? String(res.uidValidity) : null;
      if (known && to === known.next && uidValidity === known.validity) for (const u of open) clean.add(u);
      open = [];
      known = this.movedInto(destination, known, to, uidValidity);
      // Without MOVE: the copy is made, the original goes. When it doesn't, the copy stays.
      if (!move && (await deleteOne(client, uid, before && before.get(uid))) !== 'deleted') {
        results.set(uid, { error: Object.assign(new Error(t('errors.move.copied')), { copied: true }) });
        continue;
      }
      results.set(uid, { uid: to, uidValidity });
    }
    if (open.length) {
      const now = await folderState(client, destination);
      if (known && now && now.validity === known.validity && now.next === known.next) for (const u of open) clean.add(u);
      this.knowState(destination, now);
    }
    if (!failed.length) return;
    const here = await readMany(client, failed);
    const same = Boolean(here) && Boolean(client.mailbox) && String(client.mailbox.uidValidity) === validity;
    for (const uid of failed) {
      const refused = same && here.has(uid) && clean.has(uid);
      results.set(uid, { error: refused ? refusal('errors.move.refused') : uncertain('errors.move.unknown') });
    }
  }

  // Moves uids from path to destination, one MOVE each, and returns what each got (inTurns()): with UIDPLUS, its uid
  // in destination and that folder's UIDVALIDITY. A server without MOVE gets a COPY and then a delete (deleteOne());
  // imapflow's messageMove does the same, but answers false both when the COPY failed and when the delete failed after
  // the copy was made. After a failed delete the copy stays (errors.move.copied): another app may already have
  // expunged the original. A server with neither MOVE nor UIDPLUS gets nothing (errors.move.noUidExpunge, unsent).
  moveMany(path, uids, destination, { expectUidValidity = null, stopped = null } = {}) {
    return this.inTurns(path, uids, expectUidValidity, 'errors.move.unknown', (client, turn, results, sent) => this.moveTurn(client, turn, destination, results, sent, stopped), stopped);
  }

  // moveMany() for one email: its uid in destination and that folder's UIDVALIDITY, or the error.
  async move(path, uid, destination, opts = {}) {
    const r = (await this.moveMany(path, [uid], destination, opts)).get(Number(uid));
    if (r.error) throw r.error;
    return { uid: r.uid, uidValidity: r.uidValidity };
  }

  // Deletes uids from path for good and returns what each got (inTurns()): {} for an email that's gone, or { error }.
  // refused, with stage 'store' or 'expunge' for the command that failed, when the email is still there by its UID;
  // with errors.delete.stillMarked and marked when it still carries \Deleted. unknown when Rukoo can't tell. The flags
  // before (deleteOne()) and what's left after are read once per turn, for all its emails at once. A server without
  // UIDPLUS gets nothing (errors.delete.noUidExpunge, unsent).
  deleteMany(path, uids, { expectUidValidity = null, stopped = null } = {}) {
    return this.inTurns(path, uids, expectUidValidity, 'errors.delete.unknown', async (client, turn, results, sent) => {
      // Without UID EXPUNGE no email is deleted on its own (expungeOne()): nothing is sent, so nothing is marked.
      if (!has(client, 'UIDPLUS')) {
        for (const uid of turn) results.set(uid, { error: unsent('errors.delete.noUidExpunge') });
        return;
      }
      const validity = String(client.mailbox.uidValidity);
      const before = modseqs(client) ? await readMany(client, turn) : null;
      const stage = new Map();
      for (const uid of turn) {
        if (client.usable === false || (stopped && stopped())) break;
        sent.add(uid);
        const left = await deleteOne(client, uid, before && before.get(uid));
        if (left === 'deleted') results.set(uid, {});
        else if (left === 'lost') results.set(uid, { error: uncertain('errors.delete.unknown') });
        else stage.set(uid, left);
      }
      if (!stage.size) return;
      const read = await readMany(client, [...stage.keys()]);
      // The uids name the same emails only in the generation of the folder the turn began with.
      const after = read && client.mailbox && String(client.mailbox.uidValidity) === validity ? read : null;
      for (const [uid, at] of stage) {
        const m = after && after.get(uid);
        if (!m) results.set(uid, { error: uncertain('errors.delete.unknown') });
        else if (m.flags.has('\\Deleted')) results.set(uid, { error: refusal('errors.delete.stillMarked', { marked: true, stage: at }) });
        else results.set(uid, { error: refusal('errors.delete.refused', { stage: at }) });
      }
    }, stopped);
  }

  // deleteMany() for one email: throws its error.
  async deleteForever(path, uid, opts = {}) {
    const r = (await this.deleteMany(path, [uid], opts)).get(Number(uid));
    if (r.error) throw r.error;
  }

  append(path, raw, flags = []) {
    return this.run(async (client) => {
      const res = await client.append(path, raw, flags);
      return res && res.uid ? res.uid : null;
    });
  }

  static async compose({ keepBcc = false, ...mail }) {
    const node = new MailComposer({ ...mail, attachDataUrls: true }).compile();
    // Drafts keep their Bcc header; sent mail must not reveal it.
    node.keepBcc = keepBcc;
    return node.build();
  }

  // Sends the message and returns the raw RFC 822 source.
  async send(mail) {
    const raw = await ImapAccount.compose(mail);
    const transporter = await this.transport();
    try {
      const recipients = [...(mail.to || []), ...(mail.cc || []), ...(mail.bcc || [])].map((a) => a.address || a);
      await transporter.sendMail({
        envelope: { from: mail.from.address, to: recipients },
        raw
      });
    } catch (err) {
      throw new Error(friendlyError(err));
    } finally {
      transporter.close();
    }
    return raw;
  }

  savesSentCopy() {
    return AUTO_SENT_HOSTS.test(this.account.smtp.host || '');
  }

  async close() {
    this.closed = true;
    const clients = [this.main.client, this.reader.client].filter(Boolean);
    this.main.client = null;
    this.reader.client = null;
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.logout();
        } catch (_) {
          client.close();
        }
      })
    );
  }
}

module.exports = { ImapAccount, friendlyError, errorCode, uidSets };
