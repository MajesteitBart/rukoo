'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { simpleParser } = require('mailparser');
const { ImapAccount, friendlyError } = require('./imap');
const { DemoAccount, DEMO_EMAIL } = require('./demo');
const { serverDefaults, publicProviders } = require('./providers');
const util = require('./mailutil');

const COLORS = ['#2fd6c0', '#4a7dff', '#ff8a3d', '#c56cf0', '#f5c542', '#ff5d73', '#5ec2ff'];
const SYNC_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive'];
const LIMITS = { inbox: 300, default: 100 };
const VIEW_ROLES = { drafts: 'drafts', sent: 'sent', trash: 'trash', junk: 'junk', archive: 'archive' };

const DEFAULT_SETTINGS = {
  theme: 'system',
  swipeActions: true,
  fitContent: true,
  darkEmails: true,
  notifications: true,
  badge: 'new',
  density: 'standard',
  sort: 'date-desc',
  syncInterval: 5,
  hiddenViews: [],
  vips: [],
  spam: [],
  defaultAccountId: null,
  signature: 'Verzonden vanaf mijn pc'
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function encodeId(accountId, folder, uid) {
  return [accountId, folder, uid].map(encodeURIComponent).join(':');
}

function decodeId(id) {
  const [accountId, folder, uid] = String(id).split(':').map(decodeURIComponent);
  return { accountId, folder, uid: Number(uid) };
}

function sha(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function lowerAddr(a) {
  return String((a && a.address) || a || '').trim().toLowerCase();
}

class Engine extends EventEmitter {
  constructor({ dataDir, secrets }) {
    super();
    this.dataDir = dataDir;
    this.secrets = secrets || { encrypt: (s) => s, decrypt: (s) => s };
    this.accounts = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.caches = new Map();
    this.sessions = new Map();
    this.syncs = new Map();
    this.saved = [];
    this.saveTimers = new Map();
  }

  file(...parts) {
    return path.join(this.dataDir, ...parts);
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.accounts = readJson(this.file('accounts.json'), []);
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.file('settings.json'), {}) };
    this.saved = readJson(this.file('saved.json'), []);
    for (const acc of this.accounts) {
      this.caches.set(acc.id, readJson(this.file('cache', `${acc.id}.json`), { folders: [], boxes: {}, lastSync: null }));
    }
    return this;
  }

  // ---------- persistence ----------

  persistAccounts() {
    writeJson(this.file('accounts.json'), this.accounts);
  }

  persistSettings() {
    writeJson(this.file('settings.json'), this.settings);
  }

  persistCache(accountId) {
    clearTimeout(this.saveTimers.get(accountId));
    this.saveTimers.set(
      accountId,
      setTimeout(() => {
        const cache = this.caches.get(accountId);
        if (cache) writeJson(this.file('cache', `${accountId}.json`), cache);
      }, 250)
    );
  }

  flush() {
    for (const [accountId, timer] of this.saveTimers) {
      clearTimeout(timer);
      const cache = this.caches.get(accountId);
      if (cache) writeJson(this.file('cache', `${accountId}.json`), cache);
    }
    this.saveTimers.clear();
  }

  changed(accountId) {
    if (accountId) this.persistCache(accountId);
    this.emit('updated');
  }

  // ---------- accounts ----------

  account(id) {
    const acc = this.accounts.find((a) => a.id === id);
    if (!acc) throw new Error('Account niet gevonden.');
    return acc;
  }

  session(acc) {
    if (this.sessions.has(acc.id)) return this.sessions.get(acc.id);
    const s =
      acc.type === 'demo'
        ? new DemoAccount(acc, this.file('demo-server.json'))
        : new ImapAccount(acc, this.secrets.decrypt(acc.secret));
    this.sessions.set(acc.id, s);
    return s;
  }

  defaultAccount() {
    return this.accounts.find((a) => a.id === this.settings.defaultAccountId) || this.accounts[0] || null;
  }

  publicAccount(acc) {
    const cache = this.caches.get(acc.id) || {};
    return {
      id: acc.id,
      type: acc.type,
      provider: acc.provider,
      email: acc.email,
      name: acc.name,
      label: acc.label || acc.email,
      color: acc.color,
      signature: acc.signature,
      imap: acc.imap ? { ...acc.imap } : null,
      smtp: acc.smtp ? { ...acc.smtp } : null,
      isDefault: this.defaultAccount() === acc,
      lastSync: cache.lastSync || null,
      error: cache.error || null,
      syncing: this.syncs.has(acc.id),
      folders: (cache.folders || [])
        .filter((f) => f.role !== 'all' && f.role !== 'flagged' && f.role !== 'important')
        .map((f) => ({ path: f.path, name: util.displayFolderName(f), role: f.role || null }))
    };
  }

  state() {
    return {
      accounts: this.accounts.map((a) => this.publicAccount(a)),
      settings: this.settings,
      providers: publicProviders(),
      demoEmail: DEMO_EMAIL
    };
  }

  async addAccount(input) {
    const email = String(input.email || '').trim();
    if (input.type !== 'demo' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error('Voer een geldig e-mailadres in.');
    }
    const finalEmail = input.type === 'demo' ? DEMO_EMAIL : email;
    if (this.accounts.some((a) => a.email.toLowerCase() === finalEmail.toLowerCase())) {
      throw new Error('Dit account is al toegevoegd.');
    }
    const defaults = serverDefaults(input.provider || 'other', finalEmail);
    const acc = {
      id: crypto.randomUUID(),
      type: input.type === 'demo' ? 'demo' : 'imap',
      provider: input.type === 'demo' ? 'demo' : input.provider || 'other',
      email: finalEmail,
      name: input.name || (input.type === 'demo' ? 'Demo Gebruiker' : finalEmail.split('@')[0]),
      label: finalEmail,
      color: COLORS[this.accounts.length % COLORS.length],
      signature: null,
      imap: input.type === 'demo' ? null : { ...defaults.imap, user: finalEmail, ...(input.imap || {}) },
      smtp: input.type === 'demo' ? null : { ...defaults.smtp, user: finalEmail, ...(input.smtp || {}) },
      secret: input.type === 'demo' ? null : this.secrets.encrypt(String(input.password || '')),
      createdAt: Date.now()
    };
    if (acc.type === 'imap' && !input.password) throw new Error('Voer je wachtwoord in.');
    const session = this.session(acc);
    try {
      await session.verify();
    } catch (err) {
      this.sessions.delete(acc.id);
      await session.close();
      throw err;
    }
    this.accounts.push(acc);
    this.caches.set(acc.id, { folders: [], boxes: {}, lastSync: null });
    if (!this.settings.defaultAccountId) {
      this.settings.defaultAccountId = acc.id;
      this.persistSettings();
    }
    this.persistAccounts();
    this.emit('updated');
    this.syncAccount(acc.id).catch(() => {});
    return this.publicAccount(acc);
  }

  async updateAccount(id, patch) {
    const acc = this.account(id);
    if (patch.name !== undefined) acc.name = String(patch.name);
    if (patch.signature !== undefined) acc.signature = patch.signature;
    if (patch.color) acc.color = patch.color;
    if (patch.makeDefault) {
      this.settings.defaultAccountId = id;
      this.persistSettings();
    }
    const serverChange = patch.imap || patch.smtp || patch.password;
    if (serverChange && acc.type === 'imap') {
      const next = {
        ...acc,
        imap: { ...acc.imap, ...(patch.imap || {}) },
        smtp: { ...acc.smtp, ...(patch.smtp || {}) },
        secret: patch.password ? this.secrets.encrypt(patch.password) : acc.secret
      };
      const probe = new ImapAccount(next, this.secrets.decrypt(next.secret));
      await probe.verify();
      Object.assign(acc, next);
      const old = this.sessions.get(id);
      this.sessions.delete(id);
      if (old) old.close();
    }
    this.persistAccounts();
    this.emit('updated');
    return this.publicAccount(acc);
  }

  async removeAccount(id) {
    const acc = this.account(id);
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s) await s.close();
    this.accounts = this.accounts.filter((a) => a !== acc);
    this.caches.delete(id);
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    fs.rmSync(this.file('cache', `${id}.json`), { force: true });
    fs.rmSync(this.file('bodies', id), { recursive: true, force: true });
    if (acc.type === 'demo') fs.rmSync(this.file('demo-server.json'), { force: true });
    if (this.settings.defaultAccountId === id) {
      this.settings.defaultAccountId = this.accounts[0] ? this.accounts[0].id : null;
      this.persistSettings();
    }
    this.persistAccounts();
    this.emit('updated');
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.persistSettings();
    this.emit('updated');
    return this.settings;
  }

  // ---------- sync ----------

  folderByRole(accountId, role) {
    const cache = this.caches.get(accountId);
    return cache && cache.folders.find((f) => f.role === role);
  }

  folderInfo(accountId, folderPath) {
    const cache = this.caches.get(accountId);
    return cache && cache.folders.find((f) => f.path === folderPath);
  }

  syncAll() {
    return Promise.all(this.accounts.map((a) => this.syncAccount(a.id).catch(() => {})));
  }

  syncAccount(id, extraFolders = []) {
    if (this.syncs.has(id)) return this.syncs.get(id);
    const job = this.runSync(id, extraFolders).finally(() => {
      this.syncs.delete(id);
      this.emit('updated');
    });
    this.syncs.set(id, job);
    this.emit('updated');
    return job;
  }

  async runSync(id, extraFolders) {
    const acc = this.account(id);
    const cache = this.caches.get(id);
    const session = this.session(acc);
    const fresh = [];
    try {
      cache.folders = await session.listFolders();
      const targets = cache.folders.filter((f) => SYNC_ROLES.includes(f.role)).map((f) => f.path);
      // Keep user folders that were opened before in sync too.
      for (const p of [...extraFolders, ...Object.keys(cache.boxes)]) {
        if (!targets.includes(p) && cache.folders.some((f) => f.path === p)) targets.push(p);
      }
      for (const p of targets) {
        fresh.push(...(await this.syncFolderInto(acc, p)));
      }
      for (const p of Object.keys(cache.boxes)) {
        if (!cache.folders.some((f) => f.path === p)) delete cache.boxes[p];
      }
      cache.lastSync = Date.now();
      cache.error = null;
    } catch (err) {
      cache.error = friendlyError(err);
      this.changed(id);
      throw err;
    }
    this.changed(id);
    if (fresh.length) this.emit('new-mail', fresh);
    return fresh;
  }

  async syncFolderInto(acc, folderPath) {
    const cache = this.caches.get(acc.id);
    const info = cache.folders.find((f) => f.path === folderPath) || { path: folderPath };
    const prev = cache.boxes[folderPath];
    const known = new Map();
    if (prev) for (const m of prev.messages) known.set(m.uid, m);
    const limit = info.role === 'inbox' ? LIMITS.inbox : LIMITS.default;
    const res = await this.session(acc).syncFolder(folderPath, { limit, known: prev && prev.uidValidity ? known : new Map() });
    const sameValidity = prev && prev.uidValidity === res.uidValidity;
    const maxKnown = sameValidity ? Math.max(0, ...prev.messages.map((m) => m.uid)) : Infinity;
    cache.boxes[folderPath] = {
      uidValidity: res.uidValidity,
      exists: res.exists,
      syncedAt: Date.now(),
      messages: res.messages
    };
    if (!sameValidity && prev) {
      fs.rmSync(this.file('bodies', acc.id), { recursive: true, force: true });
    }
    // Only report mail that arrived after an earlier sync, never the initial download.
    if (info.role !== 'inbox' || !prev) return [];
    return res.messages
      .filter((m) => m.uid > maxKnown && m.unread && !this.isSpam(m.from))
      .map((m) => this.publicMessage(acc, folderPath, m));
  }

  async openFolder(accountId, folderPath) {
    const cache = this.caches.get(accountId);
    const box = cache && cache.boxes[folderPath];
    if (box && Date.now() - box.syncedAt < 60000) return;
    const acc = this.account(accountId);
    await this.syncFolderInto(acc, folderPath);
    this.changed(accountId);
  }

  // ---------- listing ----------

  isSpam(from) {
    return this.settings.spam.includes(lowerAddr(from));
  }

  isVip(from) {
    return this.settings.vips.includes(lowerAddr(from));
  }

  publicMessage(acc, folderPath, m) {
    const info = this.folderInfo(acc.id, folderPath);
    return {
      id: encodeId(acc.id, folderPath, m.uid),
      accountId: acc.id,
      accountColor: acc.color,
      folder: folderPath,
      role: (info && info.role) || null,
      uid: m.uid,
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc,
      date: m.date,
      preview: m.preview,
      unread: m.unread,
      starred: m.starred,
      answered: m.answered,
      hasAttachments: m.hasAttachments,
      vip: this.isVip(m.from)
    };
  }

  scopeAccounts(scope) {
    return !scope || scope === 'all' ? this.accounts : this.accounts.filter((a) => a.id === scope);
  }

  collect(scope, predicate) {
    const out = [];
    for (const acc of this.scopeAccounts(scope)) {
      const cache = this.caches.get(acc.id);
      if (!cache) continue;
      for (const [folderPath, box] of Object.entries(cache.boxes)) {
        const info = cache.folders.find((f) => f.path === folderPath) || { path: folderPath };
        for (const m of box.messages) {
          if (predicate(info, m)) out.push(this.publicMessage(acc, folderPath, m));
        }
      }
    }
    return out;
  }

  viewPredicate(view, folder) {
    const inbox = (info, m) => info.role === 'inbox' && !this.isSpam(m.from);
    switch (view) {
      case 'inbox':
        return inbox;
      case 'unread':
        return (info, m) => inbox(info, m) && m.unread;
      case 'vip':
        return (info, m) => inbox(info, m) && this.isVip(m.from);
      case 'starred':
        return (info, m) => m.starred && info.role !== 'trash' && info.role !== 'junk';
      case 'folder':
        return (info) => info.path === folder;
      default:
        if (VIEW_ROLES[view]) return (info) => info.role === VIEW_ROLES[view];
        return () => false;
    }
  }

  listMessages({ scope = 'all', view = 'inbox', folder = null, query = '', sort } = {}) {
    let list =
      view === 'saved'
        ? this.saved.filter((s) => scope === 'all' || s.accountId === scope).map((s) => ({ ...s, unread: false }))
        : this.collect(scope, this.viewPredicate(view, folder));
    const q = String(query || '').trim().toLowerCase();
    if (q) {
      list = list.filter((m) =>
        [m.subject, m.preview, m.from && m.from.name, m.from && m.from.address, ...(m.to || []).map((t) => `${t.name} ${t.address}`)]
          .join(' ')
          .toLowerCase()
          .includes(q)
      );
    }
    const order = sort || this.settings.sort;
    const byDate = (a, b) => b.date - a.date;
    if (order === 'date-asc') list.sort((a, b) => a.date - b.date);
    else if (order === 'unread') list.sort((a, b) => Number(b.unread) - Number(a.unread) || byDate(a, b));
    else if (order === 'sender') {
      list.sort((a, b) => (a.from.name || a.from.address).localeCompare(b.from.name || b.from.address, 'nl') || byDate(a, b));
    } else list.sort(byDate);
    return list;
  }

  counts(scope = 'all') {
    const res = { accounts: {}, views: {} };
    for (const acc of this.accounts) {
      res.accounts[acc.id] = this.collect(acc.id, this.viewPredicate('unread')).length;
    }
    res.all = Object.values(res.accounts).reduce((a, b) => a + b, 0);
    const count = (view, onlyUnread) =>
      this.collect(scope, this.viewPredicate(view)).filter((m) => !onlyUnread || m.unread).length;
    res.views = {
      inbox: count('inbox', true),
      unread: count('unread', true),
      vip: count('vip', true),
      starred: count('starred'),
      saved: this.saved.filter((s) => scope === 'all' || s.accountId === scope).length,
      drafts: count('drafts'),
      sent: count('sent'),
      trash: count('trash'),
      junk: count('junk', true),
      archive: count('archive', true)
    };
    res.folders = {};
    if (scope !== 'all') {
      const cache = this.caches.get(scope);
      for (const [p, box] of Object.entries((cache && cache.boxes) || {})) {
        res.folders[p] = box.messages.filter((m) => m.unread).length;
      }
    }
    return res;
  }

  // ---------- messages ----------

  locate(id) {
    const { accountId, folder, uid } = decodeId(id);
    const acc = this.account(accountId);
    const cache = this.caches.get(accountId);
    const box = cache.boxes[folder];
    const msg = box && box.messages.find((m) => m.uid === uid);
    if (!msg) throw new Error('Bericht niet gevonden.');
    return { acc, cache, box, msg, folder, uid };
  }

  async rawSource(id) {
    if (String(id).startsWith('saved:')) {
      const item = this.saved.find((s) => s.id === id);
      if (!item) throw new Error('Opgeslagen e-mail niet gevonden.');
      return fs.readFileSync(this.file('saved', item.file));
    }
    const { acc, box, folder, uid } = this.locate(id);
    const file = this.file('bodies', acc.id, `${sha(`${folder}|${box.uidValidity}|${uid}`)}.eml`);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const raw = await this.session(acc).fetchSource(folder, uid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
    return raw;
  }

  async getMessage(id) {
    const raw = await this.rawSource(id);
    const parsed = await simpleParser(raw);
    const base = String(id).startsWith('saved:')
      ? { ...this.saved.find((s) => s.id === id) }
      : (() => {
          const { acc, folder, msg } = this.locate(id);
          return this.publicMessage(acc, folder, msg);
        })();
    const html = parsed.html ? util.sanitizeHtml(parsed.html) : util.textToHtml(parsed.text || '');
    return {
      ...base,
      from: util.addressFromParsed(parsed.from)[0] || base.from,
      to: util.addressFromParsed(parsed.to),
      cc: util.addressFromParsed(parsed.cc),
      bcc: util.addressFromParsed(parsed.bcc),
      replyTo: util.addressFromParsed(parsed.replyTo),
      subject: parsed.subject || base.subject || '',
      date: parsed.date ? parsed.date.getTime() : base.date,
      messageId: parsed.messageId || null,
      references: [].concat(parsed.references || []),
      html,
      isHtml: Boolean(parsed.html),
      text: parsed.text || util.htmlToPlain(parsed.html || ''),
      attachments: (parsed.attachments || [])
        .map((a, index) => ({
          index,
          filename: a.filename || `bijlage-${index + 1}`,
          contentType: a.contentType,
          size: a.size,
          related: Boolean(a.related || (a.contentDisposition === 'inline' && a.cid))
        }))
        .filter((a) => !a.related)
    };
  }

  async attachment(id, index) {
    const parsed = await simpleParser(await this.rawSource(id));
    const a = (parsed.attachments || [])[index];
    if (!a) throw new Error('Bijlage niet gevonden.');
    return { filename: a.filename || `bijlage-${index + 1}`, content: a.content, contentType: a.contentType };
  }

  async setFlags(id, flags) {
    const { acc, msg, folder, uid } = this.locate(id);
    const before = { unread: msg.unread, starred: msg.starred };
    if (flags.unread !== undefined) msg.unread = Boolean(flags.unread);
    if (flags.starred !== undefined) msg.starred = Boolean(flags.starred);
    this.changed(acc.id);
    try {
      await this.session(acc).setFlags(folder, uid, flags);
    } catch (err) {
      Object.assign(msg, before);
      this.changed(acc.id);
      throw new Error(friendlyError(err));
    }
  }

  async markAllRead(scope, view, folder) {
    const list = this.listMessages({ scope, view, folder }).filter((m) => m.unread && !String(m.id).startsWith('saved:'));
    for (const m of list) await this.setFlags(m.id, { unread: false }).catch(() => {});
    return list.length;
  }

  removeFromCache(acc, folder, uid) {
    const cache = this.caches.get(acc.id);
    const box = cache.boxes[folder];
    if (box) box.messages = box.messages.filter((m) => m.uid !== uid);
  }

  async move(id, destination) {
    const { acc, msg, folder, uid } = this.locate(id);
    if (destination === folder) return;
    this.removeFromCache(acc, folder, uid);
    this.changed(acc.id);
    try {
      await this.session(acc).move(folder, uid, destination);
    } catch (err) {
      const box = this.caches.get(acc.id).boxes[folder];
      if (box) box.messages.push(msg);
      this.changed(acc.id);
      throw new Error(friendlyError(err));
    }
    if (this.caches.get(acc.id).boxes[destination]) {
      this.syncFolderInto(acc, destination).then(() => this.changed(acc.id)).catch(() => {});
    }
  }

  // Moves to Prullenbak, or deletes for good when the message is already there.
  async remove(id) {
    const { acc, folder, uid } = this.locate(id);
    const trash = this.folderByRole(acc.id, 'trash');
    if (trash && trash.path !== folder) return this.move(id, trash.path).then(() => 'trash');
    const { msg } = this.locate(id);
    this.removeFromCache(acc, folder, uid);
    this.changed(acc.id);
    try {
      await this.session(acc).deleteForever(folder, uid);
    } catch (err) {
      this.caches.get(acc.id).boxes[folder].messages.push(msg);
      this.changed(acc.id);
      throw new Error(friendlyError(err));
    }
    return 'deleted';
  }

  async emptyFolder(accountId, folderPath) {
    const ids = this.listMessages({ scope: accountId, view: 'folder', folder: folderPath }).map((m) => m.id);
    for (const id of ids) await this.remove(id).catch(() => {});
    return ids.length;
  }

  toggleVip(address) {
    const a = lowerAddr(address);
    const vips = new Set(this.settings.vips);
    if (vips.has(a)) vips.delete(a);
    else vips.add(a);
    this.updateSettings({ vips: [...vips] });
    return vips.has(a);
  }

  async markSpam(id) {
    const { acc, msg } = this.locate(id);
    const a = lowerAddr(msg.from);
    if (!this.settings.spam.includes(a)) this.updateSettings({ spam: [...this.settings.spam, a] });
    const junk = this.folderByRole(acc.id, 'junk');
    if (junk) await this.move(id, junk.path);
  }

  async saveToDevice(id) {
    const raw = await this.rawSource(id);
    const { acc, folder, msg } = this.locate(id);
    const pub = this.publicMessage(acc, folder, msg);
    const savedId = `saved:${crypto.randomUUID()}`;
    const file = `${savedId.slice(6)}.eml`;
    fs.mkdirSync(this.file('saved'), { recursive: true });
    fs.writeFileSync(this.file('saved', file), raw);
    this.saved.push({ ...pub, id: savedId, file, role: 'saved', folder: null, starred: false, unread: false });
    writeJson(this.file('saved.json'), this.saved);
    this.emit('updated');
    return savedId;
  }

  deleteSaved(id) {
    const item = this.saved.find((s) => s.id === id);
    if (!item) return;
    fs.rmSync(this.file('saved', item.file), { force: true });
    this.saved = this.saved.filter((s) => s !== item);
    writeJson(this.file('saved.json'), this.saved);
    this.emit('updated');
  }

  // ---------- compose ----------

  async buildMail(acc, payload) {
    const addrs = (list) =>
      (list || [])
        .map((a) => (typeof a === 'string' ? { name: '', address: a.trim() } : a))
        .filter((a) => a.address);
    return {
      from: { name: acc.name || '', address: acc.email },
      to: addrs(payload.to),
      cc: addrs(payload.cc),
      bcc: addrs(payload.bcc),
      subject: payload.subject || '',
      html: payload.html || undefined,
      text: payload.text || (payload.html ? util.htmlToPlain(payload.html) : ''),
      inReplyTo: payload.inReplyTo || undefined,
      references: payload.references && payload.references.length ? payload.references : undefined,
      date: new Date(),
      attachments: [
        ...(payload.attachments || []).map((a) =>
          a.path
            ? { filename: a.filename || path.basename(a.path), path: a.path }
            : { filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType }
        ),
        ...(await this.forwardAttachments(payload))
      ]
    };
  }

  // Attachments of the original message that the user kept when forwarding.
  async forwardAttachments(payload) {
    if (!payload.forwardId || !(payload.forwardIndexes || []).length) return [];
    const out = [];
    for (const index of payload.forwardIndexes) {
      const a = await this.attachment(payload.forwardId, index);
      out.push({ filename: a.filename, content: a.content, contentType: a.contentType });
    }
    return out;
  }

  contacts() {
    const map = new Map();
    const add = (a, weight) => {
      const key = lowerAddr(a);
      if (!key || !key.includes('@') || /no-?reply|do-?not-?reply/.test(key)) return;
      const prev = map.get(key) || { name: '', address: a.address, score: 0 };
      if (!prev.name && a.name) prev.name = a.name;
      prev.score += weight;
      map.set(key, prev);
    };
    const own = new Set(this.accounts.map((a) => a.email.toLowerCase()));
    for (const cache of this.caches.values()) {
      for (const [folderPath, box] of Object.entries(cache.boxes)) {
        const info = cache.folders.find((f) => f.path === folderPath) || {};
        for (const m of box.messages) {
          // People you write to rank above people who write to you.
          if (info.role === 'sent') (m.to || []).concat(m.cc || []).forEach((a) => add(a, 3));
          else add(m.from, 1);
        }
      }
    }
    return [...map.values()]
      .filter((c) => !own.has(c.address.toLowerCase()))
      .sort((a, b) => b.score - a.score)
      .map(({ name, address }) => ({ name, address }));
  }

  async send(payload) {
    const acc = this.account(payload.accountId);
    const mail = await this.buildMail(acc, payload);
    if (!mail.to.length && !mail.cc.length && !mail.bcc.length) throw new Error('Voeg minstens één ontvanger toe.');
    for (const a of [...mail.to, ...mail.cc, ...mail.bcc]) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.address)) throw new Error(`Ongeldig e-mailadres: ${a.address}`);
    }
    const session = this.session(acc);
    const raw = await session.send(mail);
    const sent = this.folderByRole(acc.id, 'sent');
    if (sent && !session.savesSentCopy()) {
      await session.append(sent.path, raw, ['\\Seen']).catch(() => {});
    }
    if (payload.draftId) await this.discardDraft(payload.draftId).catch(() => {});
    if (payload.replyToId) {
      try {
        const { msg } = this.locate(payload.replyToId);
        msg.answered = true;
      } catch (_) {
        // The original may have been moved in the meantime.
      }
    }
    this.syncAccount(acc.id).catch(() => {});
    return true;
  }

  async saveDraft(payload) {
    const acc = this.account(payload.accountId);
    const drafts = this.folderByRole(acc.id, 'drafts');
    if (!drafts) throw new Error('Deze account heeft geen map Concepten.');
    const mail = await this.buildMail(acc, payload);
    const raw = await ImapAccount.compose(mail);
    const session = this.session(acc);
    const uid = await session.append(drafts.path, raw, ['\\Seen', '\\Draft']);
    if (payload.draftId) await this.discardDraft(payload.draftId).catch(() => {});
    await this.syncFolderInto(acc, drafts.path);
    this.changed(acc.id);
    return uid ? encodeId(acc.id, drafts.path, uid) : null;
  }

  async discardDraft(id) {
    const { acc, folder, uid } = this.locate(id);
    this.removeFromCache(acc, folder, uid);
    this.changed(acc.id);
    await this.session(acc).deleteForever(folder, uid);
  }

  async close() {
    this.flush();
    await Promise.all([...this.sessions.values()].map((s) => s.close().catch(() => {})));
    this.sessions.clear();
  }
}

module.exports = { Engine, encodeId, decodeId, DEFAULT_SETTINGS };
