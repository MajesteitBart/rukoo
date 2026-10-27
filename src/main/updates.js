'use strict';

// Checks GitHub Releases for a newer Rukoo. Only a list of releases is fetched, from the repository in package.json
// ("rukoo": { "releases": "owner/repo" }), so a fork points at its own releases. Nothing is downloaded or installed:
// the sidebar shows a button that opens the release page.
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

// The newest published release above `current`, from the GitHub API's list; null when there is none.
function newest(releases, current) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || !parse(r.tag_name)) continue;
    if (typeof r.html_url !== 'string' || !/^https:\/\/github\.com\//.test(r.html_url)) continue;
    if (compare(r.tag_name, current) <= 0) continue;
    if (!best || compare(r.tag_name, best.tag_name) > 0) best = r;
  }
  if (!best) return null;
  return { version: String(best.tag_name).replace(/^v/, ''), name: String(best.name || best.tag_name), url: best.html_url, prerelease: Boolean(best.prerelease) };
}

class UpdateChecker extends EventEmitter {
  // repo: 'owner/repo'. url overrides the API address, for tests (plain http only to this computer).
  constructor({ current, repo, url, enabled = () => true }) {
    super();
    this.current = current;
    this.url = url || (repo ? `https://api.github.com/repos/${repo}/releases?per_page=20` : null);
    this.enabled = enabled;
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
    return { current: this.current, available: this.available, checkedAt: this.checkedAt, failed: this.failed };
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
    const found = newest(list, this.current);
    const changed = JSON.stringify(found) !== JSON.stringify(this.available);
    this.available = found;
    if (changed) this.emit('changed', this.state());
    return this.state();
  }
}

module.exports = { UpdateChecker, compare, newest, parse };
