'use strict';

// Checks GitHub Releases for a newer Rukoo. Only a list of releases is fetched, from the repository in package.json
// ("rukoo": { "releases": "owner/repo" }), so a fork points at its own releases. What it finds goes to the sidebar's
// update button; installer.js downloads it where this kind of install can replace itself.
//
// Two channels: stable sees releases, nightly also the pre-releases (nightly builds and release candidates). A nightly
// build follows nightly until the user picks stable. Leaving nightly offers nothing older than what is installed: the
// next stable release is newer than the nightlies before it (their version is the next patch, -nightly.DATE.RUN).
const { EventEmitter } = require('events');
const http = require('http');
const dns = require('dns');
const { request } = require('./net');

const FIRST_CHECK = 15 * 1000;
const EVERY = 6 * 60 * 60 * 1000;

// 'v2.1.0-rc.1' → [2, 1, 0, 'rc.1'], or null for anything else.
function parse(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(tag || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || ''] : null;
}

// Semantic Versioning order: numbers first, then a pre-release comes before its release.
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  const p = x[3].split('.');
  const q = y[3].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]);
    const m = /^\d+$/.test(q[i]);
    if (n && m && Number(p[i]) !== Number(q[i])) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    if (n !== m) return n ? -1 : 1;
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

const CHANNELS = ['stable', 'nightly'];

const isNightly = (version) => /-nightly\./.test(String(version || ''));

// The channel a setting asks for; without one, a nightly build stays on nightly and a release on stable.
function channelFor(setting, current) {
  return CHANNELS.includes(setting) ? setting : isNightly(current) ? 'nightly' : 'stable';
}

// Whether a channel offers a version: stable only releases, nightly also pre-releases.
function onChannel(channel, version, prerelease) {
  const v = parse(version);
  return Boolean(v) && (channel === 'nightly' || (!prerelease && !v[3]));
}

// The update description electron-builder writes next to this platform's packages (see installer.js).
function manifestName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'latest.yml';
  if (platform === 'darwin') return 'latest-mac.yml';
  return `latest-linux${arch === 'x64' ? '' : `-${arch}`}.yml`;
}

// The folder the release's update description downloads from, or null when the release has none for this platform,
// as releases from before Rukoo installed its own updates. Only GitHub's release downloads count; local: a test
// server on this computer.
function feedOf(release, manifest, local) {
  const asset = (Array.isArray(release.assets) ? release.assets : []).find((a) => a && a.name === manifest);
  const url = asset && typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
  const ok = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(url) || (local && /^http:\/\/127\.0\.0\.1:\d+\//.test(url));
  return ok ? url.slice(0, url.lastIndexOf('/') + 1) : null;
}

// The newest published release above `current` on the channel, from the GitHub API's list; null when there is none.
function newest(releases, current, { channel = 'stable', manifest = manifestName(), local = false } = {}) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    const version = r && parse(r.tag_name);
    if (!version || r.draft) continue;
    if (!onChannel(channel, r.tag_name, r.prerelease)) continue;
    if (typeof r.html_url !== 'string' || !/^https:\/\/github\.com\//.test(r.html_url)) continue;
    if (compare(r.tag_name, current) <= 0) continue;
    if (!best || compare(r.tag_name, best.tag_name) > 0) best = r;
  }
  if (!best) return null;
  return {
    version: String(best.tag_name).replace(/^v/, ''),
    name: String(best.name || best.tag_name),
    url: best.html_url,
    prerelease: Boolean(best.prerelease),
    feed: feedOf(best, manifest, local)
  };
}

class UpdateChecker extends EventEmitter {
  // repo: 'owner/repo'. url overrides the API address, for tests (plain http only to this computer).
  // channel: () => 'stable' or 'nightly', read at every check.
  constructor({ current, repo, url, enabled = () => true, channel = () => 'stable' }) {
    super();
    this.current = current;
    // A hundred: the stable release has to be on the first page behind two weeks of nightlies.
    this.url = url || (repo ? `https://api.github.com/repos/${repo}/releases?per_page=100` : null);
    this.enabled = enabled;
    this.channel = channel;
    this.available = null;
    this.checkedAt = null;
    // The last check couldn't ask GitHub or read its answer; what an earlier check found stays.
    this.failed = false;
    this.timers = [];
  }

  start() {
    if (!this.url) return this;
    this.timers.push(setTimeout(() => this.check().catch(() => {}), FIRST_CHECK));
    this.timers.push(setInterval(() => this.check().catch(() => {}), EVERY));
    for (const t of this.timers) if (t.unref) t.unref();
    return this;
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  state() {
    return { current: this.current, channel: this.channel(), available: this.available, checkedAt: this.checkedAt, failed: this.failed };
  }

  // Settings switched the channel. An offer the new channel doesn't make goes at once: the next check can fail and
  // keep what it found before, and a nightly downloaded before the switch to stable would still install on quit.
  channelChanged() {
    const a = this.available;
    if (!a || onChannel(this.channel(), a.version, a.prerelease)) return;
    this.available = null;
    this.emit('changed', this.state());
  }

  // Asks GitHub now; resolves to the state. Off in Settings, it asks nothing and keeps what it found before.
  async check({ force = false } = {}) {
    if (!this.url || (!force && !this.enabled())) return this.state();
    const local = /^http:\/\/127\.0\.0\.1[:/]/.test(this.url);
    let list;
    try {
      const res = await request(this.url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `Rukoo/${this.current}` },
        maxBytes: 2 * 1024 * 1024,
        timeout: 15000,
        ...(local ? { transport: http, protocol: 'http:', lookup: dns.lookup } : {})
      });
      if (!res || res.status !== 200) throw new Error('status');
      list = JSON.parse(res.body.toString('utf8'));
    } catch (_) {
      this.failed = true;
      return this.state();
    }
    this.failed = false;
    this.checkedAt = Date.now();
    const found = newest(list, this.current, { channel: this.channel(), local });
    const changed = JSON.stringify(found) !== JSON.stringify(this.available);
    this.available = found;
    if (changed) this.emit('changed', this.state());
    this.emit('checked', this.state());
    return this.state();
  }
}

module.exports = { UpdateChecker, CHANNELS, channelFor, compare, isNightly, manifestName, newest, parse };
