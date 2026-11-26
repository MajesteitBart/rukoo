'use strict';

// Rukoo Voice's bucket on the user's other computers (docs/meetings.md, "Your other computers"). Voice's bucket
// settings, its bucket secret and its recovery code travel as one record of the user's Rukoo account, sealed twice on
// this device: inside the record with a key only Rukoo versions that know voicesync derive (account.putSealed), so an
// older Rukoo or the Android app that keeps the record holds only sealed bytes, and as every record is before it
// leaves (server/PROTOCOL.md, Collections: voicesync). Voice hands them over
// with sync.settings.get and takes them with sync.settings.set (voice/PROTOCOL.md).
//
// Sharing is the user's choice on each computer. share: this computer writes its bucket to the account, again when
// Voice's settings change here. follow: the user used the account's bucket here once, so a newer one (a new secret,
// a moved bucket) is used here too without asking. Both are kept in voice-share.json for the account they were made
// in, and go when the account signs out. Voice's settings themselves stay in memory, and the renderer gets only the
// other computer's name and the bucket's name.
//
// Everything a share or a use does after it waited (for Voice, mostly) belongs to the session it started in: when the
// user signed out or into another account meanwhile, it writes nothing and keeps no choice.

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
// sync.settings.set tests the bucket before it answers, which can take minutes; Voice keeps answering the heartbeat
// meanwhile. When the answer doesn't come, the next look at Voice's settings tells whether it worked.
const SET_TIMEOUT_MS = 5 * 60 * 1000;
// How long Rukoo waits for a use whose answer was lost to show in Voice's settings: Voice may still be testing the
// bucket, each request of which can take 120 s.
const UNSURE_MS = 5 * 60 * 1000;
// A use that failed by itself for a reason that may pass (Voice away, the bucket down) is tried again after these
// waits, doubling up to the last; one Voice refused for good (key_in_use, settings it refuses) only when the record
// changes.
const RETRY_MS = [60 * 1000, 60 * 60 * 1000];
const FOR_GOOD_REASONS = new Set(['key_in_use', 'settings']);
const FOR_GOOD_CODES = new Set(['bad_request', 'not_available', 'unknown_command']);
// Voice refuses to hand over its settings while it takes or puts back another computer's (reason applying): they are
// half old and half new then. Rukoo publishes nothing, changes no choice, and looks again after this wait.
const AGAIN_MS = 15 * 1000;
const DEVICE_MAX = 100;

// Settings compared without keeping them: a digest of every field.
const digest = (settings) => (settings ? crypto.createHash('sha256').update(JSON.stringify(SYNC_FIELDS.map((k) => settings[k]))).digest('base64url') : null);

class VoiceShare extends EventEmitter {
  constructor({ account, voice, dataDir, everyMs = EVERY_MS, setTimeoutMs = SET_TIMEOUT_MS, unsureMs = UNSURE_MS, retryMs = RETRY_MS, againMs = AGAIN_MS, now = Date.now, log = () => {} }) {
    super();
    this.account = account;
    this.voice = voice;
    this.file = path.join(dataDir, FILE);
    this.everyMs = everyMs;
    this.setTimeoutMs = setTimeoutMs;
    this.unsureMs = unsureMs;
    this.retryMs = retryMs;
    this.againMs = againMs;
    this.now = now;
    this.log = log;
    this.prefs = {};
    // Voice's settings as it last said them: undefined until Rukoo asked, null while sync is off there.
    this.here = undefined;
    // false once this Voice answered unknown_command: an older Voice. Asked again when Voice connects again, which
    // may be a newer one.
    this.supported = null;
    // 'sharing' or 'applying' while that runs; error: { action, code, reason } of the last one that failed.
    this.busy = null;
    this.error = null;
    this.appliedAt = null;
    // The record whose use failed by itself (follow) for good: tried again only when it changes. retry: one that
    // failed for a reason that may pass, { digest, tries, until }, tried again from until on.
    this.failedFor = null;
    this.retry = null;
    this.retryTimer = null;
    this.againTimer = null;
    // A use whose answer never came (Voice went away or took too long): { digest, session, until }. A look at Voice
    // that finds those settings says it worked; until then, or until the session changes or the time is up, Voice may
    // still be at it, so Rukoo neither sends it again nor takes the change for one the user made.
    this.unsure = null;
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
    this.voice.bridge.on('welcome', () => {
      this.supported = null;
      this.check();
    });
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
    clearTimeout(this.retryTimer);
    clearTimeout(this.againTimer);
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

  // The account's record, opened and checked, or null.
  record() {
    if (!this.account.signedIn) return null;
    const v = this.account.getSealed(COLLECTION, KEY);
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
      this.retry = null;
      this.unsure = null;
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

  // The session now, to hand to live() after a wait.
  session() {
    return this.account.session;
  }

  // Whether the session a share or a use started in is still the one signed in.
  live(session) {
    return Boolean(session) && this.account.session === session;
  }

  write(settings) {
    this.account.putSealed(COLLECTION, KEY, { settings, at: this.now(), device: this.account.deviceName });
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
    const session = this.session();
    let here;
    try {
      here = await this.read();
    } catch (err) {
      // A meeting records the screen (busy), or Voice went away: the next look tries again. While Voice takes or puts
      // back settings, that look comes soon: a use whose answer was lost shows once Voice is done.
      if (err && err.code === 'busy' && err.reason === 'applying') this.lookAgain();
      this.changed();
      return;
    }
    if (!this.live(session)) {
      this.changed();
      return;
    }
    const mine = digest(here);
    // A use whose answer was lost: Voice uses the record's settings now when it worked.
    const unsure = this.unsure;
    if (unsure && (!this.live(unsure.session) || this.now() >= unsure.until)) this.unsure = null;
    else if (unsure && unsure.digest === mine) {
      this.unsure = null;
      this.used(here, 'its answer was lost on the way');
    }
    // The user changed Voice's sync here since Rukoo last looked. seen is the last bucket Voice synced to here, kept
    // while sync is off, so a bucket that changed meanwhile counts once sync is back.
    const movedHere = Boolean(this.prefs.seen) && this.prefs.seen !== mine;
    if (mine && mine !== this.prefs.seen) this.setPrefs({ seen: mine });
    const record = this.record();
    const theirs = record && digest(record.settings);
    if (movedHere && this.prefs.follow && !this.prefs.share) {
      // Voice here moved away from the account's bucket on purpose: Rukoo stops following it, and offers it again.
      this.setPrefs({ follow: false });
    }
    // Shared again only after the settings changed here: a record another computer removed (sharing turned off there)
    // stays removed until then, or until the user turns sharing on here again.
    if (this.prefs.share && here && movedHere) {
      this.write(here);
    } else if (this.prefs.follow && record && theirs !== mine && !movedHere && this.failedFor !== theirs && !this.waiting(theirs) && !this.maybeUsing(theirs)) {
      await this.apply(record, { auto: true, session });
      return;
    }
    this.changed();
  }

  // Whether an automatic use of these settings waits to be tried again.
  waiting(theirs) {
    return Boolean(this.retry) && this.retry.digest === theirs && this.now() < this.retry.until;
  }

  // Whether Voice may still be using these settings after Rukoo lost its answer.
  maybeUsing(theirs) {
    return Boolean(this.unsure) && this.unsure.digest === theirs;
  }

  // Voice uses settings from the account now: Rukoo follows the record from here on.
  used(settings, how) {
    this.here = settings;
    this.unsure = null;
    this.failedFor = null;
    this.retry = null;
    this.error = null;
    this.appliedAt = this.now();
    this.setPrefs({ follow: true, seen: digest(settings) });
    this.log('share', `uses the bucket of another computer now${how ? ` (${how})` : ''}`);
  }

  // Uses the account's bucket here: sync.settings.set, which leaves Voice as it was when it fails. session: the one
  // the use started in; a use that outlives it keeps no choice for the account signed in now.
  async apply(record, { auto = false, session } = {}) {
    if (!this.live(session)) return false;
    const theirs = digest(record.settings);
    this.busy = 'applying';
    this.error = null;
    this.changed();
    try {
      await this.voice.bridge.command('sync.settings.set', { settings: record.settings }, { timeoutMs: this.setTimeoutMs });
      if (!this.live(session)) {
        this.here = record.settings;
        return false;
      }
      this.used(record.settings, null);
      return true;
    } catch (err) {
      if (!this.live(session)) return false;
      const code = String((err && err.code) || 'failed').slice(0, 40);
      const reason = err && typeof err.reason === 'string' ? err.reason.slice(0, 40) : null;
      this.error = { action: 'use', code, reason };
      // Voice may still finish what Rukoo stopped waiting for.
      if (code === 'offline' || code === 'timeout') this.unsure = { digest: theirs, session, until: this.now() + this.unsureMs };
      if (auto && (FOR_GOOD_REASONS.has(reason) || FOR_GOOD_CODES.has(code))) this.failedFor = theirs;
      else if (auto) this.later(theirs);
      this.log('share', `the bucket of another computer wasn't used: ${code}${reason ? ` (${reason})` : ''}`);
      return false;
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  // An automatic use that failed for a reason that may pass goes again later, each time after a longer wait. The
  // timer makes the try due when it fires: a timer can fire a little before this.now() reaches until, and the try
  // would otherwise wait for the next look.
  later(theirs) {
    const tries = this.retry && this.retry.digest === theirs ? this.retry.tries + 1 : 1;
    const [first, most] = this.retryMs;
    const wait = Math.min(first * 2 ** (tries - 1), most);
    const retry = { digest: theirs, tries, until: this.now() + wait };
    this.retry = retry;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.retry === retry) retry.until = Math.min(retry.until, this.now());
      this.check();
    }, wait);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  // One look at Voice's settings after againMs, however often Voice says it is still applying meanwhile.
  lookAgain() {
    if (this.againTimer) return;
    this.againTimer = setTimeout(() => {
      this.againTimer = null;
      this.check();
    }, this.againMs);
    if (this.againTimer.unref) this.againTimer.unref();
  }

  // ---------- the user's choices ----------

  // "Use this bucket on my other computers". On: Voice's bucket goes into the account now and whenever it changes
  // here. Off: the account's record goes.
  setShare(on) {
    if (!this.account.signedIn) return Promise.reject(Object.assign(new Error('signed_out'), { code: 'signed_out' }));
    const session = this.session();
    return this.serial(() => this.share(on, session));
  }

  async share(on, session) {
    if (!this.live(session)) return this.state();
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
      if (!this.live(session)) return this.state();
      if (!here) throw Object.assign(new Error('sync is off'), { code: 'sync_off' });
      this.write(here);
      this.setPrefs({ share: true, seen: digest(here) });
    } catch (err) {
      if (!this.live(session)) return this.state();
      this.error = { action: 'share', code: String((err && err.code) || 'failed').slice(0, 40), reason: err && typeof err.reason === 'string' ? err.reason.slice(0, 40) : null };
    } finally {
      this.busy = null;
      this.changed();
    }
    return this.state();
  }

  // "Use it here too".
  use() {
    const session = this.session();
    return this.serial(async () => {
      const record = this.live(session) ? this.record() : null;
      if (record) await this.apply(record, { session });
      return this.state();
    });
  }
}

module.exports = { VoiceShare, COLLECTION, KEY };
