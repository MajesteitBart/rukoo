'use strict';

// Inbox categories: the inbox split into views, like Gmail's tabs, for every kind of account. Nothing is labelled,
// moved or flagged on the mail server. Which category an email is in lives in the Rukoo account (account/), so every
// device shows the same: the categories themselves, the category each email got, and the corrections a person makes.
//
// An email's category is the first of: a correction for that email, a rule for its sender, the category it got when
// it was first sorted, and else what the rules say now. The first device to sort an email stores the result; the
// others use it. Sorting uses the rules (rules.js), and Jev (jev.js) where this device has a TypeSafe key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { t } = require('../../i18n');
const { PRESETS, PRESET_COLORS, presetFor } = require('./rules');
const jevApi = require('./jev');

const SETTING = 'categories';
const MESSAGE_ID_MAX = 256;
const MAX_CATEGORIES = 12;
const SORT_AFTER = 1500;
const JEV_AT_ONCE = 3;
// Below this, Jev's choice is a guess, and the email goes to the category for when Rukoo isn't sure.
const JEV_CONFIDENT = 0.5;
const COLORS = ['#ff5d73', '#4a7dff', '#2fd6c0', '#f5c542', '#c56cf0', '#ff8a3d', '#5ec2ff', '#7a808e'];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

const lower = (address) => String(address || '').trim().toLowerCase();

class Categories extends EventEmitter {
  constructor({ engine, account, secrets, dataDir, jev = jevApi }) {
    super();
    this.engine = engine;
    this.account = account;
    this.secrets = secrets;
    this.dataDir = dataDir;
    this.jev = jev;
    this.local = {};
    this.timer = null;
    // The sort after TypeSafe was busy, apart from soon()'s timer, which every mail update moves.
    this.retryTimer = null;
    this.sorting = null;
    this.jevBusyUntil = 0;
    // Goes up with every change to Jev's settings; what a request made under older settings answers is dropped.
    this.jevGeneration = 0;
    // Emails "Sort the inbox again" still has to sort, by key, because Jev was busy or stopped before it got to them.
    // Their older category stays until then.
    this.redo = new Set();
  }

  file() {
    return path.join(this.dataDir, 'categories.json');
  }

  init() {
    this.local = readJson(this.file(), {});
    this.redo = new Set(Array.isArray(this.local.redo) ? this.local.redo.filter((k) => typeof k === 'string') : []);
    this.engine.categoryOf = (acc, m) => this.of(acc, m);
    this.account.on('records', ({ collections }) => {
      if (collections.some((c) => ['category', 'classification', 'override', 'sender', 'setting'].includes(c))) this.changed();
    });
    this.engine.on('updated', () => this.soon());
    return this;
  }

  // What stays on this computer: Jev's settings, and the emails a re-sort still has to do (redo), so a restart
  // doesn't forget them.
  saveLocal() {
    this.local.redo = [...this.redo];
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(this.local));
  }

  changed() {
    this.emit('changed');
    this.engine.emit('updated');
  }

  // ---- what the categories are ----

  settings() {
    const v = this.account.get('setting', SETTING) || {};
    return { enabled: v.enabled === true, unsure: typeof v.unsure === 'string' ? v.unsure : 'to-read', seeded: v.seeded === true };
  }

  putSettings(patch) {
    this.account.put('setting', SETTING, { ...this.settings(), ...patch });
  }

  // The categories in order, with the names and descriptions people see. A preset nobody renamed takes its name and
  // description from the translations, so it follows the language.
  list() {
    return this.account
      .list('category')
      .map(({ k, v }) => {
        const preset = PRESETS.includes(k) ? k : null;
        return {
          id: k,
          preset,
          name: (v && v.name) || (preset ? t(`categories.presets.${preset}.name`) : k),
          description: (v && v.description) || (preset ? t(`categories.presets.${preset}.description`) : ''),
          custom: { name: Boolean(v && v.name), description: Boolean(v && v.description) },
          color: (v && v.color) || PRESET_COLORS[preset] || COLORS[0],
          order: Number(v && v.order) || 0
        };
      })
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  // The five presets, the first time categories are turned on.
  seed() {
    if (this.settings().seeded) return;
    PRESETS.forEach((id, order) => {
      if (this.account.get('category', id) === undefined) this.account.put('category', id, { name: null, description: null, color: PRESET_COLORS[id], order });
    });
    this.putSettings({ seeded: true });
  }

  state() {
    const s = this.settings();
    const list = this.list();
    return {
      enabled: s.enabled,
      unsure: list.some((c) => c.id === s.unsure) ? s.unsure : (list[0] && list[0].id) || null,
      categories: list,
      jev: { on: Boolean(this.local.jev && this.local.jev.on), hasKey: Boolean(this.local.jev && this.local.jev.key), error: (this.local.jev && this.local.jev.error) || null, model: jevApi.MODEL },
      // Senders that always go to one category, for Settings.
      senders: this.account
        .list('sender')
        .filter(({ v }) => v && list.some((c) => c.id === v.category))
        .map(({ k, v }) => ({ address: k, category: v.category }))
        .sort((a, b) => a.address.localeCompare(b.address)),
      signedIn: this.account.signedIn,
      limit: MAX_CATEGORIES
    };
  }

  setEnabled(on) {
    if (on) this.seed();
    this.putSettings({ enabled: Boolean(on) });
    this.changed();
    if (on) this.soon(0);
    return this.state();
  }

  setUnsure(id) {
    if (!this.list().some((c) => c.id === id)) throw new Error('invalid');
    this.putSettings({ unsure: id });
    this.changed();
    return this.state();
  }

  // A new category (no id) or changes to one. name or description null goes back to a preset's own.
  saveCategory({ id = null, name, description, color } = {}) {
    const list = this.list();
    const was = id ? this.account.get('category', id) : undefined;
    if (id && was === undefined) throw new Error('invalid');
    if (!id && list.length >= MAX_CATEGORIES) throw new Error(t('categories.errors.tooMany', { count: MAX_CATEGORIES }));
    const key = id || `c-${crypto.randomBytes(5).toString('hex')}`;
    const clean = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const value = {
      ...(was || {}),
      name: name === undefined ? (was && was.name) || null : clean(name, 40),
      description: description === undefined ? (was && was.description) || null : clean(description, 400),
      color: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : (was && was.color) || COLORS[list.length % COLORS.length],
      order: was ? Number(was.order) || 0 : Math.max(-1, ...list.map((c) => c.order)) + 1
    };
    if (!PRESETS.includes(key) && !value.name) throw new Error(t('categories.errors.needName'));
    this.account.put('category', key, value);
    this.changed();
    return this.state();
  }

  removeCategory(id) {
    const list = this.list();
    if (!list.some((c) => c.id === id)) throw new Error('invalid');
    if (list.length <= 1) throw new Error(t('categories.errors.last'));
    this.account.remove('category', id);
    if (this.settings().unsure === id) this.putSettings({ unsure: list.find((c) => c.id !== id).id });
    this.changed();
    return this.state();
  }

  reorder(ids) {
    const list = this.list();
    if (ids.length !== list.length || !list.every((c) => ids.includes(c.id))) throw new Error('invalid');
    ids.forEach((id, order) => {
      const v = this.account.get('category', id);
      if (Number(v.order) !== order) this.account.put('category', id, { ...v, order });
    });
    this.changed();
    return this.state();
  }

  // ---- which category an email is in ----

  // The key an email's records are stored under: the account's address and the email's Message-ID.
  // A Message-ID is the sender's to choose, also its length: a very long one is kept as its hash, so no email can
  // make a record too large to sync.
  key(acc, m) {
    const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
    const id = !m.messageId
      ? `h:${sha(`${lower(m.from && m.from.address)}\n${m.date}\n${m.subject || ''}`)}`
      : m.messageId.length > MESSAGE_ID_MAX
        ? `m:${sha(m.messageId)}`
        : m.messageId;
    return `${lower(acc.email)}\n${id}`;
  }

  own(acc) {
    return [acc.email, ...((acc.aliases || []).map((a) => a.address))].filter(Boolean);
  }

  // Addresses the person has written to, from the Sent folders; worked out again at most every half minute.
  writtenTo() {
    if (this.written && Date.now() - this.written.at < 30000) return this.written.set;
    const set = new Set();
    for (const cache of this.engine.caches.values()) {
      for (const [folderPath, box] of Object.entries(cache.boxes)) {
        if ((cache.folders.find((f) => f.path === folderPath) || {}).role !== 'sent') continue;
        for (const m of box.messages) for (const a of [...(m.to || []), ...(m.cc || [])]) if (a && a.address) set.add(lower(a.address));
      }
    }
    this.written = { set, at: Date.now() };
    return set;
  }

  // The category the rules give an email, among the ones that exist: { category, strength }.
  byRules(acc, m, ids, unsure) {
    const known = this.writtenTo().has(lower(m.from && m.from.address));
    const order = this.list().map((c) => c.id);
    const { preset, strength } = presetFor(m, { own: this.own(acc), vip: this.engine.isVip(m.from), known }, order);
    return ids.has(preset) ? { category: preset, strength } : { category: unsure, strength: 'weak' };
  }

  // An inbox email's category id, or null when categories are off. Called for every message the list shows.
  of(acc, m) {
    const s = this.settings();
    if (!s.enabled) return null;
    const list = this.list();
    if (!list.length) return null;
    const ids = new Set(list.map((c) => c.id));
    const unsure = ids.has(s.unsure) ? s.unsure : list[0].id;
    const key = this.key(acc, m);
    for (const [collection, k] of [['override', key], ['sender', lower(m.from && m.from.address)], ['classification', key]]) {
      const v = this.account.get(collection, k);
      if (v && ids.has(v.category)) return v.category;
    }
    return this.byRules(acc, m, ids, unsure).category;
  }

  // Puts emails in a category, by id; with sender, also every later email from their senders.
  move(ids, category, { sender = false } = {}) {
    if (!this.list().some((c) => c.id === category)) throw new Error('invalid');
    const senders = new Set();
    for (const id of ids) {
      const { acc, msg } = this.engine.locate(id);
      this.account.put('override', this.key(acc, msg), { category, at: Date.now() });
      if (sender && msg.from && msg.from.address) senders.add(lower(msg.from.address));
    }
    for (const address of senders) this.account.put('sender', address, { category, at: Date.now() });
    this.changed();
    return true;
  }

  // Forgets a sender's rule.
  forgetSender(address) {
    this.account.remove('sender', lower(address));
    this.changed();
    return true;
  }

  // ---- sorting ----

  soon(delay = SORT_AFTER) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sort().catch(() => {}), delay);
    if (this.timer.unref) this.timer.unref();
  }

  // Inbox emails nobody has sorted yet, newest first: [{ acc, m, key }].
  unsorted({ again = false } = {}) {
    const out = [];
    for (const acc of this.engine.accounts) {
      const cache = this.engine.caches.get(acc.id);
      if (!cache) continue;
      for (const f of cache.folders.filter((x) => x.role === 'inbox')) {
        const box = cache.boxes[f.path];
        if (!box) continue;
        for (const m of box.messages) {
          const key = this.key(acc, m);
          if (this.account.get('override', key) !== undefined) continue;
          if (!again && !this.redo.has(key) && this.account.get('classification', key) !== undefined) continue;
          out.push({ acc, m, key });
        }
      }
    }
    return out.sort((a, b) => b.m.date - a.m.date);
  }

  // Whether this computer sorts with Jev: on, with a key. Mail Jev should sort waits for it, also while TypeSafe
  // refuses the key or is busy; the rules show a category for it meanwhile (of()), without storing one.
  jevWanted() {
    const j = this.local.jev;
    return Boolean(j && j.on && j.key);
  }

  // The key to call Jev with now: none after TypeSafe refused it (until a new one) or while TypeSafe is busy.
  jevKey() {
    const j = this.local.jev;
    if (!this.jevWanted() || j.error === 'key' || Date.now() < this.jevBusyUntil) return null;
    try {
      return this.secrets.decrypt(j.key);
    } catch (_) {
      return null;
    }
  }

  // Sorts what isn't sorted yet. again: sorts every inbox email again, apart from the ones people moved themselves.
  // A sort asked for while one runs follows it, sorting again if any of those asks did, so nothing asked for is lost:
  // "Sort the inbox again" during an ordinary sort, or the sort a new Jev key starts. The promise covers both.
  sort({ again = false } = {}) {
    if (!this.settings().enabled) return Promise.resolve(0);
    if (this.sorting) {
      this.followUp = { again: Boolean(this.followUp && this.followUp.again) || again };
      return this.sorting;
    }
    this.sorting = (async () => {
      let total = 0;
      for (let ask = { again }; ask; ask = this.followUp) {
        this.followUp = null;
        if (!this.settings().enabled) break;
        total += await this.run(ask.again);
      }
      return total;
    })().finally(() => {
      this.sorting = null;
    });
    return this.sorting;
  }

  async run(again) {
    const list = this.list();
    if (!list.length) return 0;
    const ids = new Set(list.map((c) => c.id));
    const s = this.settings();
    const unsure = ids.has(s.unsure) ? s.unsure : list[0].id;
    const wanted = this.jevWanted();
    const key = this.jevKey();
    const generation = this.jevGeneration;
    // Sorting again replaces what an email had; otherwise the first stored category stays (first write wins).
    const replace = (k) => again || this.redo.has(k);
    const store = (k, value) => {
      const done = replace(k) ? this.account.put('classification', k, value) : this.account.put('classification', k, value, { ifAbsent: true });
      this.redo.delete(k);
      return done;
    };
    const later = (k) => {
      if (replace(k)) this.redo.add(k);
    };
    const forJev = [];
    let sorted = 0;
    for (const item of this.unsorted({ again })) {
      // Cached before Rukoo kept the mail-kind headers: the next sync brings them, and until then the rules would
      // guess with less than they will have. The rules still show a category for it meanwhile.
      if (!item.m.signals) continue;
      const rule = this.byRules(item.acc, item.m, ids, unsure);
      if (rule.strength === 'strong' || !wanted) {
        if (store(item.key, { category: rule.category, source: 'rules', at: Date.now() }) !== false) sorted++;
      } else if (key) forJev.push(item);
      else later(item.key);
    }
    // A re-sort's emails are on file as still to do before Jev is asked, so one the app quits during goes on after a
    // restart. Each leaves the list once its answer is stored.
    const pending = forJev.filter((item) => replace(item.key));
    if (pending.length) {
      for (const item of pending) this.redo.add(item.key);
      this.saveLocal();
    }
    let stop = null;
    // Turning Jev or categories off, or a new key, stops what is still queued: nothing more goes to TypeSafe.
    let cancelled = false;
    const next = async () => {
      while (forJev.length && !stop && !cancelled) {
        if (!this.settings().enabled || this.jevGeneration !== generation || this.jevKey() !== key) {
          cancelled = true;
          break;
        }
        const { acc, m, key: k } = forJev.shift();
        try {
          const own = this.own(acc).map(lower);
          const toMe = (m.to || []).some((a) => own.includes(lower(a.address)));
          const res = await this.jev.classify(key, m, list, { toMe });
          // Settings changed while the answer was on its way (Jev or categories off, a new key): it isn't stored,
          // and the email waits for the sort that follows.
          if (!this.settings().enabled || this.jevGeneration !== generation) {
            later(k);
            cancelled = true;
            break;
          }
          const category = res.confidence >= JEV_CONFIDENT ? res.category : unsure;
          if (store(k, { category, source: 'jev', confidence: res.confidence, model: res.model, at: Date.now() }) !== false) sorted++;
        } catch (err) {
          later(k);
          stop = err;
        }
      }
    };
    const asked = forJev.length;
    await Promise.all(Array.from({ length: JEV_AT_ONCE }, next));
    for (const item of forJev) later(item.key);
    if (this.jevGeneration === generation) {
      if (stop) this.jevFailed(stop);
      // Jev answered again after being busy or out of reach. A refused key only clears with a new key (setJev).
      else if (asked && this.local.jev && (this.local.jev.error === 'busy' || this.local.jev.error === 'network')) this.setJevError(null);
    }
    // Mail waits for Jev while TypeSafe is busy: make sure a sort follows the wait.
    if (wanted && !key && Date.now() < this.jevBusyUntil && !this.retryTimer) this.retryAfter(this.jevBusyUntil - Date.now() + 1000);
    if (this.redo.size || (this.local.redo && this.local.redo.length)) this.saveLocal();
    if (sorted) this.changed();
    return sorted;
  }

  // A wrong key waits for a new one; TypeSafe being busy or out of reach waits a few minutes. The rules keep showing
  // a category for every email in the meantime.
  jevFailed(err) {
    if (err && err.code === 'key') this.setJevError('key');
    else {
      const wait = 5 * 60 * 1000;
      this.jevBusyUntil = Date.now() + wait;
      this.setJevError(err && err.code === 'busy' ? 'busy' : 'network');
      this.retryAfter(wait + 1000);
    }
  }

  retryAfter(ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.sort().catch(() => {});
    }, ms);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  setJevError(code) {
    this.local.jev = { ...(this.local.jev || {}), error: code };
    this.saveLocal();
    this.emit('changed');
  }

  // Jev on this computer: on, off, or a new key. The key stays here, encrypted like mail passwords.
  setJev({ on, key } = {}) {
    const j = { ...(this.local.jev || {}) };
    if (typeof key === 'string' && key.trim()) j.key = this.secrets.encrypt(key.trim());
    if (key === null) delete j.key;
    if (typeof on === 'boolean') j.on = on && Boolean(j.key);
    j.error = null;
    this.local.jev = j;
    this.jevBusyUntil = 0;
    this.jevGeneration += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.saveLocal();
    this.emit('changed');
    if (j.on) this.soon(0);
    return this.state();
  }

  sortAgain() {
    return this.sort({ again: true });
  }

  close() {
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
  }
}

module.exports = { Categories, MAX_CATEGORIES, JEV_CONFIDENT };
