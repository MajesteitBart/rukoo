'use strict';

// Rukoo Voice's bucket on the user's other computers (docs/meetings.md, "Your other computers"). Voice's bucket
// settings, its bucket secret and its recovery code travel as one record of the user's Rukoo account, which the
// account seals on this device before it leaves (server/PROTOCOL.md, Collections: voicesync). Voice hands them over
// with sync.settings.get and takes them with sync.settings.set (voice/PROTOCOL.md).
//
// Sharing is the user's choice on each computer. share: this computer writes its bucket to the account, again when
// Voice's settings change here. follow: the user used the account's bucket here once, so a newer one (a new secret,
// a moved bucket) is used here too without asking. Both are kept in voice-share.json for the account they were made
// in, and go when the account signs out. Voice's settings themselves stay in memory, and the renderer gets only the
// other computer's name and the bucket's name.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { syncSettingsResult, SYNC_FIELDS } = require('./protocol');

const COLLECTION = 'voicesync';
const KEY = 'bucket';
const FILE = 'voice-share.json';
// How often Rukoo reads Voice's settings again, besides each time Voice connects.
const EVERY_MS = 5 * 60 * 1000;
// sync.settings.set tests the bucket before it answers.
const SET_TIMEOUT_MS = 60000;
const DEVICE_MAX = 100;

// Settings compared without keeping them: a digest of every field.
const digest = (settings) => (settings ? crypto.createHash('sha256').update(JSON.stringify(SYNC_FIELDS.map((k) => settings[k]))).digest('base64url') : null);

class VoiceShare extends EventEmitter {
  constructor({ account, voice, dataDir, everyMs = EVERY_MS, setTimeoutMs = SET_TIMEOUT_MS, now = Date.now, log = () => {} }) {
    super();
    this.account = account;
    this.voice = voice;
    this.file = path.join(dataDir, FILE);
    this.everyMs = everyMs;
    this.setTimeoutMs = setTimeoutMs;
    this.now = now;
    this.log = log;
    this.prefs = {};
    // Voice's settings as it last said them: undefined until Rukoo asked, null while sync is off there.
    this.here = undefined;
    // false once Voice answered unknown_command: an older Voice.
    this.supported = null;
    // 'sharing' or 'applying' while that runs; error: { action, code, reason } of the last one that failed.
    this.busy = null;
    this.error = null;
    this.appliedAt = null;
    // The record whose use failed by itself (follow): tried again only when it changes.
    this.failedFor = null;
    // Looks, shares and uses run one at a time, so a look that read Voice before a use can't mistake the use for a
    // change the user made. pending: a look that waits in the queue, which a later request joins.
    this.queue = Promise.resolve();
    this.pending = null;
    this.timer = null;
  }

  init() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object') this.prefs = saved;
    } catch (_) {
      this.prefs = {};
    }
    this.account.on('records', ({ collections } = {}) => {
      if (Array.isArray(collections) && collections.includes(COLLECTION)) this.check();
    });
    this.account.on('status', () => this.onAccount());
    this.voice.bridge.on('welcome', () => this.check());
    this.voice.bridge.on('closed', () => {
      this.here = undefined;
      this.changed();
    });
    this.timer = setInterval(() => this.check(), this.everyMs);
    if (this.timer.unref) this.timer.unref();
    this.onAccount();
    return this;
  }

  close() {
    clearInterval(this.timer);
  }

  // ---------- what the renderer sees ----------

  state() {
    const record = this.record();
    const signedIn = this.account.signedIn;
    const connected = this.voice.connected;
    // Never this computer's own bucket, also after Voice here stopped syncing to it.
    const differs = Boolean(record) && this.here !== undefined && digest(record.settings) !== digest(this.here) && digest(record.settings) !== this.prefs.wrote;
    const follow = Boolean(this.prefs.follow);
    return {
      signedIn,
      connected,
      supported: this.supported,
      // Whether Voice syncs to a bucket here, or null before Rukoo knows.
      syncHere: this.here === undefined ? null : Boolean(this.here),
      share: Boolean(this.prefs.share),
      follow,
      // The other computer's bucket, when it isn't the one Voice uses here. Hidden while Rukoo uses it by itself,
      // unless that failed.
      offer: signedIn && connected && differs && (!follow || Boolean(this.error)) ? { device: record.device, bucket: record.settings.bucket, at: record.at } : null,
      busy: this.busy,
      error: this.error,
      appliedAt: this.appliedAt
    };
  }

  changed() {
    this.emit('changed', this.state());
  }

  // The account's record, checked, or null.
  record() {
    if (!this.account.signedIn) return null;
    const v = this.account.get(COLLECTION, KEY);
    if (!v || typeof v !== 'object') return null;
    let settings;
    try {
      settings = syncSettingsResult({ settings: v.settings });
    } catch (_) {
      return null;
    }
    if (!settings) return null;
    return { settings, at: Number.isFinite(v.at) ? v.at : 0, device: typeof v.device === 'string' ? v.device.slice(0, DEVICE_MAX) : '' };
  }

  // ---------- the account ----------

  // The choices belong to the account they were made in: signed out, or in another account, they start over.
  onAccount() {
    const acct = this.account.acct;
    if (this.prefs.acct !== acct) {
      this.prefs = acct ? { acct } : {};
      this.error = null;
      this.failedFor = null;
      this.save();
    }
    if (acct) this.check();
    else this.changed();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.prefs));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log('share', `voice-share.json wasn't saved: ${err.message}`);
    }
  }

  setPrefs(patch) {
    this.prefs = { ...this.prefs, ...patch };
    this.save();
  }

  write(settings) {
    this.account.put(COLLECTION, KEY, { settings, at: this.now(), device: this.account.deviceName });
    this.setPrefs({ wrote: digest(settings) });
  }

  // ---------- Voice ----------

  // Voice's settings now: the settings, or null while sync is off there. Throws a VoiceError.
  async read() {
    try {
      const here = syncSettingsResult(await this.voice.bridge.command('sync.settings.get', {}));
      this.supported = true;
      this.here = here;
      return here;
    } catch (err) {
      if (err && err.code === 'unknown_command') this.supported = false;
      throw err;
    }
  }

  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // A look at Voice's settings and the account's record. Requests made while one waits join it.
  check() {
    if (this.pending) return this.pending;
    this.pending = this.serial(() => {
      this.pending = null;
      return this.step();
    });
    return this.pending;
  }

  async step() {
    if (!this.account.signedIn || !this.voice.connected || this.supported === false) {
      this.changed();
      return;
    }
    let here;
    try {
      here = await this.read();
    } catch (err) {
      // A meeting records the screen (busy), or Voice went away: the next look tries again.
      this.changed();
      return;
    }
    const mine = digest(here);
    // The user changed Voice's sync here since Rukoo last looked.
    const movedHere = Boolean(this.prefs.seen) && this.prefs.seen !== mine;
    this.setPrefs({ seen: mine });
    const record = this.record();
    const theirs = record && digest(record.settings);
    if (movedHere && this.prefs.follow && !this.prefs.share) {
      // Voice here moved away from the account's bucket on purpose: Rukoo stops following it, and offers it again.
      this.setPrefs({ follow: false });
    }
    if (this.prefs.share && here && (movedHere || !record)) {
      this.write(here);
    } else if (this.prefs.follow && record && theirs !== mine && !movedHere && this.failedFor !== theirs) {
      await this.apply(record, { auto: true });
      return;
    }
    this.changed();
  }

  // Uses the account's bucket here: sync.settings.set, which leaves Voice as it was when it fails.
  async apply(record, { auto = false } = {}) {
    this.busy = 'applying';
    this.error = null;
    this.changed();
    try {
      await this.voice.bridge.command('sync.settings.set', { settings: record.settings }, { timeoutMs: this.setTimeoutMs });
      this.here = record.settings;
      this.failedFor = null;
      this.appliedAt = this.now();
      this.setPrefs({ follow: true, seen: digest(record.settings) });
      this.log('share', `uses the bucket of ${record.device || 'another computer'} now`);
      return true;
    } catch (err) {
      this.error = { action: 'use', code: String((err && err.code) || 'failed').slice(0, 40), reason: err && typeof err.reason === 'string' ? err.reason.slice(0, 40) : null };
      if (auto) this.failedFor = digest(record.settings);
      this.log('share', `the bucket of another computer wasn't used: ${this.error.code}${this.error.reason ? ` (${this.error.reason})` : ''}`);
      return false;
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  // ---------- the user's choices ----------

  // "Use this bucket on my other computers". On: Voice's bucket goes into the account now and whenever it changes
  // here. Off: the account's record goes.
  setShare(on) {
    if (!this.account.signedIn) return Promise.reject(Object.assign(new Error('signed_out'), { code: 'signed_out' }));
    return this.serial(() => this.share(on));
  }

  async share(on) {
    if (!on) {
      this.setPrefs({ share: false });
      this.account.remove(COLLECTION, KEY);
      this.error = null;
      this.changed();
      return this.state();
    }
    this.busy = 'sharing';
    this.error = null;
    this.changed();
    try {
      const here = await this.read();
      if (!here) throw Object.assign(new Error('sync is off'), { code: 'sync_off' });
      this.write(here);
      this.setPrefs({ share: true, seen: digest(here) });
    } catch (err) {
      this.error = { action: 'share', code: String((err && err.code) || 'failed').slice(0, 40), reason: err && typeof err.reason === 'string' ? err.reason.slice(0, 40) : null };
    } finally {
      this.busy = null;
      this.changed();
    }
    return this.state();
  }

  // "Use it here too".
  use() {
    return this.serial(async () => {
      const record = this.record();
      if (record) await this.apply(record);
      return this.state();
    });
  }
}

module.exports = { VoiceShare, COLLECTION, KEY };
