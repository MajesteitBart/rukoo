'use strict';

const { t, setLanguage, normalizeLanguage, getLocale } = require('../i18n');

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
// Earlier versions put this signature under every mail by default; it is now opt-in.
const OLD_DEFAULT_SIGNATURE = 'Verzonden vanaf mijn pc';
// How long a move or delete can be undone.
const UNDO_MS = 10 * 60 * 1000;
// Folders whose mail is not archived, even though Gmail's All Mail also holds it.
const SYSTEM_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'junk'];

const DEFAULT_SETTINGS = {
  language: 'en',
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
  signature: '',
  senderLogos: true
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
  constructor({ dataDir, secrets, google = null, fetchImpl = null }) {
    super();
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.dataDir = dataDir;
    this.secrets = secrets || { encrypt: (s) => s, decrypt: (s) => s };
    this.google = google;
    // Short-lived OAuth access tokens per account, kept in memory only.
    this.tokens = new Map();
    this.accounts = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.caches = new Map();
    this.sessions = new Map();
    this.syncs = new Map();
    this.saved = [];
    this.saveTimers = new Map();
    // Local changes whose IMAP command has not finished yet; re-applied over sync results.
    this.pending = new Map();
    // Recent moves, keyed by the id the message had before it moved, so they can be reversed.
    this.undoable = new Map();
  }

  file(...parts) {
    return path.join(this.dataDir, ...parts);
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.accounts = readJson(this.file('accounts.json'), []);
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.file('settings.json'), {}) };
    this.settings.language = normalizeLanguage(this.settings.language);
    setLanguage(this.settings.language);
    // Once only, so a user who sets this signature again keeps it.
    if (!this.settings.signatureOptIn) {
      if (this.settings.signature === OLD_DEFAULT_SIGNATURE) this.settings.signature = '';
      this.settings.signatureOptIn = true;
      if (fs.existsSync(this.file('settings.json'))) this.persistSettings();
    }
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
    if (!acc) throw new Error(t('errors.account.missing'));
    return acc;
  }

  session(acc) {
    if (this.sessions.has(acc.id)) return this.sessions.get(acc.id);
    const s =
      acc.type === 'demo' ? new DemoAccount(acc, this.file('demo-server.json')) : new ImapAccount(acc, this.credentials(acc));
    this.sessions.set(acc.id, s);
    return s;
  }

  credentials(acc) {
    if (acc.auth === 'oauth2') return { accessToken: () => this.accessToken(acc) };
    return this.secrets.decrypt(acc.secret);
  }

  // Returns a valid Google access token, refreshing it with the stored refresh token when needed.
  accessToken(acc) {
    const cached = this.tokens.get(acc.id);
    if (cached && cached.accessToken && cached.expiresAt - Date.now() > 60000) return Promise.resolve(cached.accessToken);
    if (cached && cached.refreshing) return cached.refreshing;
    if (!this.google) return Promise.reject(new Error(t('errors.google.unavailable')));
    const refreshing = this.google
      .refresh(this.secrets.decrypt(acc.secret))
      .then((t) => {
        this.tokens.set(acc.id, t);
        return t.accessToken;
      })
      .catch((err) => {
        this.tokens.delete(acc.id);
        throw err;
      });
    this.tokens.set(acc.id, { refreshing });
    return refreshing;
  }

  // Adds a Google account after the browser sign-in, or refreshes the grant of an existing one.
  async addGoogleAccount(grant, { reauthId = null } = {}) {
    const email = String(grant.email || '').toLowerCase();
    if (reauthId) {
      const acc = this.account(reauthId);
      if (acc.email.toLowerCase() !== email) {
        throw new Error(t('errors.google.wrongAccount', { signedInEmail: grant.email, accountEmail: acc.email }));
      }
      acc.auth = 'oauth2';
      acc.secret = this.secrets.encrypt(grant.refreshToken);
      this.tokens.set(acc.id, { accessToken: grant.accessToken, expiresAt: grant.expiresAt });
      const old = this.sessions.get(acc.id);
      this.sessions.delete(acc.id);
      if (old) await old.close();
      this.persistAccounts();
      this.syncAccount(acc.id).catch(() => {});
      return this.publicAccount(acc);
    }
    const defaults = serverDefaults('google', email);
    const acc = {
      id: crypto.randomUUID(),
      type: 'imap',
      provider: 'google',
      auth: 'oauth2',
      email,
      name: grant.name || email.split('@')[0],
      label: email,
      color: COLORS[this.accounts.length % COLORS.length],
      signature: null,
      imap: { ...defaults.imap, user: email },
      smtp: { ...defaults.smtp, user: email },
      secret: this.secrets.encrypt(grant.refreshToken),
      createdAt: Date.now()
    };
    this.tokens.set(acc.id, { accessToken: grant.accessToken, expiresAt: grant.expiresAt });
    return this.finishAdd(acc);
  }

  // Every address this account can send from: the account address first, then its aliases.
  identities(acc) {
    const own = { address: acc.email, name: acc.name || '', primary: true };
    const aliases = (acc.aliases || [])
      .filter((a) => a.address && a.address.toLowerCase() !== acc.email.toLowerCase())
      .map((a) => ({ address: a.address, name: a.name || acc.name || '', primary: false }));
    return [own, ...aliases];
  }

  identity(acc, address) {
    const list = this.identities(acc);
    if (!address) return list.find((i) => i.address.toLowerCase() === String(acc.defaultFrom || '').toLowerCase()) || list[0];
    return list.find((i) => i.address.toLowerCase() === String(address).toLowerCase()) || null;
  }

  // Reads verified "Send mail as" addresses from Gmail. The https://mail.google.com/ scope covers this call.
  async fetchGmailAliases(id) {
    const acc = this.account(id);
    if (acc.auth !== 'oauth2') throw new Error(t('errors.google.aliasesAuth'));
    const token = await this.accessToken(acc);
    let res;
    try {
      res = await this.fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error'
      });
    } catch (_) {
      throw new Error(t('errors.google.unreachable'));
    }
    if (!res.ok) throw new Error(t('errors.google.aliases', { status: res.status }));
    const body = await res.json();
    const usable = (body.sendAs || []).filter((s) => s.isPrimary || s.verificationStatus === 'accepted');
    acc.aliases = usable
      .filter((s) => s.sendAsEmail.toLowerCase() !== acc.email.toLowerCase())
      .map((s) => ({ address: s.sendAsEmail.toLowerCase(), name: s.displayName || '' }));
    const gmailDefault = usable.find((s) => s.isDefault);
    // Only adopt Gmail's default when the user has not picked one in this app.
    if (!acc.defaultFrom && gmailDefault) acc.defaultFrom = gmailDefault.sendAsEmail.toLowerCase();
    if (acc.defaultFrom && !this.identity(acc, acc.defaultFrom)) acc.defaultFrom = null;
    acc.aliasesFetchedAt = Date.now();
    this.persistAccounts();
    this.emit('updated');
    return this.publicAccount(acc);
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
      auth: acc.auth || (acc.type === 'demo' ? 'none' : 'password'),
      identities: this.identities(acc),
      defaultFrom: this.identity(acc).address,
      imap: acc.imap ? { ...acc.imap } : null,
      smtp: acc.smtp ? { ...acc.smtp } : null,
      isDefault: this.defaultAccount() === acc,
      lastSync: cache.lastSync || null,
      error: cache.error || null,
      syncing: this.syncs.has(acc.id),
      archive: (this.archiveFolder(acc.id) || {}).path || null,
      folders: (cache.folders || [])
        .filter((f) => f.role !== 'flagged' && f.role !== 'important' && (f.role !== 'all' || this.archiveFolder(acc.id) === f))
        // Gmail's All Mail is where archived mail goes, so it is shown as the archive.
        .map((f) => (f.role === 'all' ? { ...f, role: 'archive' } : f))
        .map((f) => ({ path: f.path, name: util.displayFolderName(f), role: f.role || null }))
    };
  }

  state() {
    return {
      accounts: this.accounts.map((a) => this.publicAccount(a)),
      settings: this.settings,
      providers: publicProviders(),
      googleAvailable: Boolean(this.google && this.google.available()),
      demoEmail: DEMO_EMAIL
    };
  }

  async addAccount(input) {
    const email = String(input.email || '').trim();
    if (input.type !== 'demo' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error(t('errors.account.invalidEmail'));
    }
    const finalEmail = input.type === 'demo' ? DEMO_EMAIL : email;
    const defaults = serverDefaults(input.provider || 'other', finalEmail);
    const acc = {
      id: crypto.randomUUID(),
      type: input.type === 'demo' ? 'demo' : 'imap',
      provider: input.type === 'demo' ? 'demo' : input.provider || 'other',
      email: finalEmail,
      name: input.name || (input.type === 'demo' ? t('setup.demo.name') : finalEmail.split('@')[0]),
      label: finalEmail,
      color: COLORS[this.accounts.length % COLORS.length],
      signature: null,
      imap: input.type === 'demo' ? null : { ...defaults.imap, user: finalEmail, ...(input.imap || {}) },
      smtp: input.type === 'demo' ? null : { ...defaults.smtp, user: finalEmail, ...(input.smtp || {}) },
      secret: input.type === 'demo' ? null : this.secrets.encrypt(String(input.password || '')),
      createdAt: Date.now()
    };
    if (acc.type === 'imap' && !input.password) throw new Error(t('errors.account.password'));
    return this.finishAdd(acc);
  }

  async finishAdd(acc) {
    if (this.accounts.some((a) => a.email.toLowerCase() === acc.email.toLowerCase())) {
      throw new Error(t('errors.account.duplicate'));
    }
    const session = this.session(acc);
    try {
      await session.verify();
    } catch (err) {
      this.sessions.delete(acc.id);
      this.tokens.delete(acc.id);
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
    if (patch.aliases) {
      // Validate the whole list before touching the account, so a typo cannot wipe existing aliases.
      const seen = new Set([acc.email.toLowerCase()]);
      const next = [];
      for (const a of patch.aliases) {
        const address = String(a.address || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error(t('common.errors.invalidEmailValue', { address: a.address }));
        if (seen.has(address)) continue;
        seen.add(address);
        next.push({ address, name: a.name || '' });
      }
      acc.aliases = next;
      if (acc.defaultFrom && !this.identity(acc, acc.defaultFrom)) acc.defaultFrom = null;
    }
    if (patch.defaultFrom !== undefined) {
      if (patch.defaultFrom && !this.identity(acc, patch.defaultFrom)) throw new Error(t('errors.account.identity'));
      acc.defaultFrom = patch.defaultFrom ? patch.defaultFrom.toLowerCase() : null;
    }
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
        secret: patch.password && acc.auth !== 'oauth2' ? this.secrets.encrypt(patch.password) : acc.secret
      };
      const probe = new ImapAccount(next, this.credentials(next));
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
    this.tokens.delete(id);
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
    this.settings.language = normalizeLanguage(this.settings.language);
    setLanguage(this.settings.language);
    this.persistSettings();
    this.emit('updated');
    return this.settings;
  }

  // ---------- sync ----------

  // Gmail has no archive folder; archiving there means moving to All Mail.
  archiveFolder(accountId) {
    return this.folderByRole(accountId, 'archive') || this.folderByRole(accountId, 'all');
  }

  folderByRole(accountId, role) {
    const cache = this.caches.get(accountId);
    return cache && cache.folders.find((f) => f.role === role);
  }

  folderInfo(accountId, folderPath) {
    const cache = this.caches.get(accountId);
    return cache && cache.folders.find((f) => f.path === folderPath);
  }

  // Syncs every account; rejects with the collected errors if any account failed.
  async syncAll() {
    const errors = [];
    await Promise.all(
      this.accounts.map((a) => this.syncAccount(a.id).catch((err) => errors.push(`${a.email}: ${friendlyError(err)}`)))
    );
    if (errors.length) throw new Error(errors.join('\n'));
  }

  pendingKey(accountId, folder, uid) {
    return `${accountId}\n${folder}\n${uid}`;
  }

  // Tracks an optimistic change until its IMAP command settles, so a sync that read
  // server state just before the command cannot undo it in the cache.
  async withPending(acc, folder, uid, patch, op) {
    const key = this.pendingKey(acc.id, folder, uid);
    this.pending.set(key, { ...(this.pending.get(key) || {}), ...patch });
    try {
      return await op();
    } finally {
      this.pending.delete(key);
    }
  }

  applyPending(accountId, folder, messages) {
    if (!this.pending.size) return messages;
    const out = [];
    for (const m of messages) {
      const p = this.pending.get(this.pendingKey(accountId, folder, m.uid));
      if (!p) out.push(m);
      else if (!p.removed) out.push({ ...m, ...p });
    }
    return out;
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
    // Pick up Gmail aliases once for Google accounts; failures here never block mail sync.
    if (acc.auth === 'oauth2' && !acc.aliasesFetchedAt) await this.fetchGmailAliases(id).catch(() => {});
    try {
      cache.folders = await session.listFolders();
      const targets = cache.folders.filter((f) => SYNC_ROLES.includes(f.role)).map((f) => f.path);
      const archive = this.archiveFolder(id);
      if (archive && !targets.includes(archive.path)) targets.push(archive.path);
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
    const res = await this.session(acc).syncFolder(folderPath, {
      limit,
      known,
      uidValidity: prev ? prev.uidValidity : null
    });
    const sameValidity = prev && prev.uidValidity === res.uidValidity;
    const maxKnown = sameValidity ? Math.max(0, ...prev.messages.map((m) => m.uid)) : Infinity;
    cache.boxes[folderPath] = {
      uidValidity: res.uidValidity,
      exists: res.exists,
      syncedAt: Date.now(),
      messages: this.applyPending(acc.id, folderPath, res.messages)
    };
    if (!sameValidity && prev) {
      fs.rmSync(this.file('bodies', acc.id), { recursive: true, force: true });
      for (const [key, r] of this.undoable) if (r.accountId === acc.id && r.destination === folderPath) this.undoable.delete(key);
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
    await this.syncFolderAndNotify(acc, folderPath);
  }

  // For syncs outside runSync (after a move, opening a folder): still report new mail.
  async syncFolderAndNotify(acc, folderPath) {
    const fresh = await this.syncFolderInto(acc, folderPath);
    this.changed(acc.id);
    if (fresh.length) this.emit('new-mail', fresh);
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
        // Gmail's All Mail also holds every message of the other folders. Normally its copies of those
        // are hidden; the archive view only drops what is still in a system folder, so archived mail
        // with a label stays visible there.
        const elsewhere = info.role === 'all' ? this.messageIdsOutside(cache, folderPath, predicate.archive ? SYSTEM_ROLES : null) : null;
        for (const m of box.messages) {
          if (elsewhere && m.messageId && elsewhere.has(m.messageId)) continue;
          if (predicate(info, m)) out.push(this.publicMessage(acc, folderPath, m));
        }
      }
    }
    return out;
  }

  messageIdsOutside(cache, folderPath, roles = null) {
    const ids = new Set();
    for (const [p, box] of Object.entries(cache.boxes)) {
      if (p === folderPath) continue;
      if (roles && !roles.includes((cache.folders.find((f) => f.path === p) || {}).role)) continue;
      for (const m of box.messages) if (m.messageId) ids.add(m.messageId);
    }
    return ids;
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
      case 'everything':
        return () => true;
      case 'archive':
        return Object.assign((info) => info.role === 'archive' || info.role === 'all', { archive: true });
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
      list.sort((a, b) => (a.from.name || a.from.address).localeCompare(b.from.name || b.from.address, getLocale()) || byDate(a, b));
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
    if (!msg) throw new Error(t('errors.message.missing'));
    return { acc, cache, box, msg, folder, uid };
  }

  async rawSource(id) {
    if (String(id).startsWith('saved:')) {
      const item = this.saved.find((s) => s.id === id);
      if (!item) throw new Error(t('errors.message.savedMissing'));
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
      inReplyTo: parsed.inReplyTo || null,
      references: [].concat(parsed.references || []),
      html,
      isHtml: Boolean(parsed.html),
      unsubscribe: util.unsubscribeInfo(parsed),
      text: parsed.text || util.htmlToPlain(parsed.html || ''),
      attachments: (parsed.attachments || [])
        .map((a, index) => ({
          index,
          filename: a.filename || t('native.attachments.defaultNumbered', { number: index + 1 }),
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
    if (!a) throw new Error(t('errors.attachment.missing'));
    return { filename: a.filename || t('native.attachments.defaultNumbered', { number: index + 1 }), content: a.content, contentType: a.contentType };
  }

  async setFlags(id, flags) {
    const { acc, msg, folder, uid } = this.locate(id);
    const patch = {};
    for (const k of ['unread', 'starred', 'answered']) if (flags[k] !== undefined) patch[k] = Boolean(flags[k]);
    Object.assign(msg, patch);
    this.changed(acc.id);
    try {
      await this.withPending(acc, folder, uid, patch, () => this.session(acc).setFlags(folder, uid, patch));
    } catch (err) {
      // Revert on whatever object the cache holds now; a sync may have replaced it.
      try {
        const now = this.locate(id).msg;
        for (const k of Object.keys(patch)) now[k] = !patch[k];
      } catch (_) {
        // The message left the cache in the meantime.
      }
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
    let moved;
    try {
      moved = await this.withPending(acc, folder, uid, { removed: true }, () => this.session(acc).move(folder, uid, destination));
    } catch (err) {
      const box = this.caches.get(acc.id).boxes[folder];
      if (box) box.messages.push(msg);
      this.changed(acc.id);
      throw new Error(friendlyError(err));
    }
    // Servers without UIDPLUS do not report the new uid; such a move cannot be undone.
    if (moved && moved.uid && moved.uidValidity) {
      this.rememberMove(id, { accountId: acc.id, folder, destination, uid: moved.uid, uidValidity: moved.uidValidity, msg });
    }
    if (this.caches.get(acc.id).boxes[destination]) {
      this.syncFolderAndNotify(acc, destination).catch(() => {});
    }
  }

  rememberMove(id, record) {
    const now = Date.now();
    for (const [key, r] of this.undoable) if (now - r.at > UNDO_MS) this.undoable.delete(key);
    this.undoable.set(id, { ...record, at: now });
  }

  canUndo(id) {
    return this.undoable.has(id);
  }

  // Moves a message back to where it was before move(), remove() or archive().
  // Returns the id it gets in its old folder.
  async undoMove(id) {
    const rec = this.undoable.get(id);
    this.undoable.delete(id);
    if (!rec || Date.now() - rec.at > UNDO_MS) throw new Error(t('errors.undo.expired'));
    const acc = this.account(rec.accountId);
    this.removeFromCache(acc, rec.destination, rec.uid);
    this.changed(acc.id);
    let uid;
    try {
      const back = await this.withPending(acc, rec.destination, rec.uid, { removed: true }, () =>
        this.session(acc).move(rec.destination, rec.uid, rec.folder, { expectUidValidity: rec.uidValidity })
      );
      uid = back && back.uid;
    } catch (err) {
      if (this.caches.get(acc.id).boxes[rec.destination]) this.syncFolderAndNotify(acc, rec.destination).catch(() => {});
      if (err && err.code === 'UIDVALIDITY') throw new Error(t('errors.undo.rebuilt'));
      throw new Error(friendlyError(err));
    }
    // Put it back right away; with the new uid in the cache, the follow-up sync does not report it as new mail.
    const box = this.caches.get(acc.id).boxes[rec.folder];
    if (box && uid && !box.messages.some((m) => m.uid === uid)) box.messages.push({ ...rec.msg, uid });
    this.changed(acc.id);
    if (box) this.syncFolderAndNotify(acc, rec.folder).catch(() => {});
    return uid ? encodeId(acc.id, rec.folder, uid) : null;
  }

  // The account a message (or a saved copy) belongs to.
  messageAccount(id) {
    if (String(id).startsWith('saved:')) {
      const s = this.saved.find((x) => x.id === id);
      return s ? this.account(s.accountId) : null;
    }
    return this.account(decodeId(id).accountId);
  }

  async createFolder(accountId, name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error(t('errors.folder.nameRequired'));
    if (clean.length > 100 || /[\\/%*]/.test(clean)) throw new Error(t('errors.folder.invalidName'));
    const acc = this.account(accountId);
    const cache = this.caches.get(acc.id);
    if (cache.folders.some((f) => (f.name || '').toLowerCase() === clean.toLowerCase())) throw new Error(t('errors.folder.duplicate'));
    const created = await this.session(acc).createFolder(clean);
    cache.folders = await this.session(acc).listFolders();
    this.changed(acc.id);
    return created;
  }

  async archive(id) {
    const { acc } = this.locate(id);
    const target = this.archiveFolder(acc.id);
    if (!target) throw new Error(t('errors.folder.noArchive'));
    await this.move(id, target.path);
  }

  // Moves to Prullenbak, or deletes for good when the message is already there.
  // Without a Prullenbak it returns 'confirm' and changes nothing until called with force.
  async remove(id, { force = false } = {}) {
    const { acc, folder, uid, msg } = this.locate(id);
    const trash = this.folderByRole(acc.id, 'trash');
    if (trash && trash.path !== folder) return this.move(id, trash.path).then(() => 'trash');
    if (!trash && !force) return 'confirm';
    this.removeFromCache(acc, folder, uid);
    this.changed(acc.id);
    try {
      await this.withPending(acc, folder, uid, { removed: true }, () => this.session(acc).deleteForever(folder, uid));
    } catch (err) {
      this.caches.get(acc.id).boxes[folder].messages.push(msg);
      this.changed(acc.id);
      throw new Error(friendlyError(err));
    }
    return 'deleted';
  }

  async emptyFolder(accountId, folderPath) {
    const ids = this.listMessages({ scope: accountId, view: 'folder', folder: folderPath }).map((m) => m.id);
    for (const id of ids) await this.remove(id, { force: true }).catch(() => {});
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
    const from = this.identity(acc, payload.from || null);
    if (!from) throw new Error(t('errors.send.identity', { address: payload.from }));
    return {
      from: { name: from.name || acc.name || '', address: from.address },
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
    const own = new Set(this.accounts.flatMap((a) => this.identities(a).map((i) => i.address.toLowerCase())));
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
    if (!mail.to.length && !mail.cc.length && !mail.bcc.length) throw new Error(t('errors.send.noRecipients'));
    for (const a of [...mail.to, ...mail.cc, ...mail.bcc]) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.address)) throw new Error(t('common.errors.invalidEmailValue', { address: a.address }));
    }
    const session = this.session(acc);
    const raw = await session.send(mail);
    const sent = this.folderByRole(acc.id, 'sent');
    if (sent && !session.savesSentCopy()) {
      await session.append(sent.path, raw, ['\\Seen']).catch(() => {});
    }
    if (payload.draftId) await this.discardDraft(payload.draftId).catch(() => {});
    if (payload.replyToId) {
      // The original may have been moved in the meantime; that is fine.
      await this.setFlags(payload.replyToId, { answered: true }).catch(() => {});
    }
    this.syncAccount(acc.id).catch(() => {});
    return true;
  }

  async saveDraft(payload) {
    const acc = this.account(payload.accountId);
    const drafts = this.folderByRole(acc.id, 'drafts');
    if (!drafts) throw new Error(t('errors.folder.noDrafts'));
    const mail = await this.buildMail(acc, payload);
    // A Message-ID of our own finds the stored draft again on servers that do not report its uid.
    mail.messageId = `<${crypto.randomUUID()}@${mail.from.address.split('@')[1] || 'rukoo.invalid'}>`;
    // Keep Bcc in the stored draft so it survives reopening.
    const raw = await ImapAccount.compose({ ...mail, keepBcc: true });
    const session = this.session(acc);
    const uid = await session.append(drafts.path, raw, ['\\Seen', '\\Draft']);
    if (payload.draftId) await this.discardDraft(payload.draftId).catch(() => {});
    await this.syncFolderInto(acc, drafts.path);
    this.changed(acc.id);
    const stored = uid || this.uidByMessageId(acc.id, drafts.path, mail.messageId);
    return stored ? encodeId(acc.id, drafts.path, stored) : null;
  }

  uidByMessageId(accountId, folderPath, messageId) {
    const box = this.caches.get(accountId).boxes[folderPath];
    const norm = (v) => String(v || '').replace(/[<>]/g, '').toLowerCase();
    const hit = box && box.messages.find((m) => m.messageId && norm(m.messageId) === norm(messageId));
    return hit ? hit.uid : null;
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
