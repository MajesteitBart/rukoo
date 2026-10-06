'use strict';

const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const util = require('./mailutil');

const PREVIEW_BYTES = 4096;

// Hosts whose SMTP service already files a copy in the Sent folder.
const AUTO_SENT_HOSTS = /(gmail\.com|googlemail\.com|office365\.com|outlook\.com)$/i;

function friendlyError(err) {
  const msg = String((err && (err.responseText || err.response || err.message)) || err);
  if (err && err.oauth) return msg;
  if (err && err.authenticationFailed) return 'Aanmelden mislukt. Controleer je e-mailadres en (app-)wachtwoord.';
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|535|Username and Password not accepted/i.test(msg)) {
    return 'Aanmelden mislukt. Controleer je e-mailadres en (app-)wachtwoord.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'Server niet gevonden. Controleer de servernaam.';
  if (/ECONNREFUSED/i.test(msg)) return 'Verbinding geweigerd. Controleer de server en poort.';
  if (/ETIMEDOUT|timeout/i.test(msg)) return 'Er is een time-out opgetreden bij het verbinden met de server.';
  if (/certificate|self.signed|CERT_/i.test(msg)) return 'Het certificaat van de server is niet vertrouwd.';
  return msg;
}

class ImapAccount {
  // credentials: a password string, or { accessToken: async () => token } for OAuth (XOAUTH2).
  constructor(account, credentials) {
    this.account = account;
    this.credentials = credentials;
    this.client = null;
    this.queue = Promise.resolve();
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

  async connect() {
    if (this.client && this.client.usable) return this.client;
    const client = new ImapFlow(await this.imapOptions());
    const drop = () => {
      if (this.client === client) this.client = null;
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
    this.client = client;
    return client;
  }

  // IMAP commands share one connection, so they run one at a time.
  run(fn) {
    const task = this.queue.then(async () => {
      try {
        return await fn(await this.connect());
      } catch (err) {
        if (this.client && !this.client.usable) this.client = null;
        throw err;
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async verify() {
    const client = new ImapFlow(await this.imapOptions());
    client.on('error', () => {});
    try {
      await client.connect();
      await client.logout();
    } catch (err) {
      client.close();
      throw new Error(`IMAP: ${friendlyError(err)}`);
    }
    try {
      const transport = await this.transport();
      await transport.verify();
      transport.close();
    } catch (err) {
      throw new Error(`SMTP: ${friendlyError(err)}`);
    }
  }

  listFolders() {
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
    });
  }

  syncFolder(path, { limit = 200, known: knownIn = new Map(), uidValidity = null } = {}) {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const box = client.mailbox;
        // After a UIDVALIDITY change old UIDs point at different messages; reuse nothing.
        const known = uidValidity && String(box.uidValidity) === String(uidValidity) ? knownIn : new Map();
        const result = { uidValidity: String(box.uidValidity), exists: box.exists, messages: [] };
        if (!box.exists) return result;
        const start = Math.max(1, box.exists - limit + 1);
        const rows = [];
        for await (const m of client.fetch(`${start}:*`, {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true,
          size: true
        })) {
          rows.push(m);
        }

        // Fetch a few KB of the readable part for messages we have not seen before.
        const previews = new Map();
        const byPart = new Map();
        for (const m of rows) {
          if (known.has(m.uid)) continue;
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

        for (const m of rows) {
          const env = m.envelope || {};
          const prior = known.get(m.uid);
          const flags = m.flags || new Set();
          result.messages.push({
            uid: m.uid,
            messageId: env.messageId || null,
            inReplyTo: env.inReplyTo || null,
            subject: env.subject || '',
            from: util.addressFromEnvelope(env.from)[0] || { name: '', address: '' },
            to: util.addressFromEnvelope(env.to),
            cc: util.addressFromEnvelope(env.cc),
            replyTo: util.addressFromEnvelope(env.replyTo),
            date: new Date(env.date || m.internalDate || Date.now()).getTime(),
            preview: previews.has(m.uid) ? previews.get(m.uid) : prior ? prior.preview : '',
            unread: !flags.has('\\Seen'),
            starred: flags.has('\\Flagged'),
            answered: flags.has('\\Answered'),
            hasAttachments: util.hasAttachments(m.bodyStructure),
            size: m.size || 0
          });
        }
        return result;
      } finally {
        lock.release();
      }
    });
  }

  fetchSource(path, uid) {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error('Bericht niet gevonden op de server.');
        return msg.source;
      } finally {
        lock.release();
      }
    });
  }

  setFlags(path, uid, { unread, starred, answered }) {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        const opts = { uid: true };
        if (unread === true) await client.messageFlagsRemove(String(uid), ['\\Seen'], opts);
        if (unread === false) await client.messageFlagsAdd(String(uid), ['\\Seen'], opts);
        if (starred === true) await client.messageFlagsAdd(String(uid), ['\\Flagged'], opts);
        if (starred === false) await client.messageFlagsRemove(String(uid), ['\\Flagged'], opts);
        if (answered === true) await client.messageFlagsAdd(String(uid), ['\\Answered'], opts);
      } finally {
        lock.release();
      }
    });
  }

  // Returns the message's uid in the destination and that mailbox's UIDVALIDITY, as far as the
  // server reports them (UIDPLUS). With expectUidValidity, refuses to touch a mailbox whose uids
  // were reassigned since: the uid would point at another message.
  move(path, uid, destination, { expectUidValidity = null } = {}) {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        if (expectUidValidity && String(client.mailbox.uidValidity) !== String(expectUidValidity)) {
          throw Object.assign(new Error('De map is op de server opnieuw opgebouwd.'), { code: 'UIDVALIDITY' });
        }
        const res = await client.messageMove(String(uid), destination, { uid: true });
        return {
          uid: res && res.uidMap ? res.uidMap.get(uid) || null : null,
          uidValidity: res && res.uidValidity ? String(res.uidValidity) : null
        };
      } finally {
        lock.release();
      }
    });
  }

  deleteForever(path, uid) {
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        await client.messageDelete(String(uid), { uid: true });
      } finally {
        lock.release();
      }
    });
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
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.logout();
      } catch (_) {
        client.close();
      }
    }
  }
}

module.exports = { ImapAccount, friendlyError };
