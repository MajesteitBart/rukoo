'use strict';

// Sender logos: the icon a brand publishes on its own website, fetched once and cached on disk.
// Mail from people at free-mail providers keeps its initials; those domains say nothing about the sender.
const fs = require('fs');
const path = require('path');
const { request } = require('./net');

// The icon itself, or null: only a 200 with a body of acceptable size counts.
async function download(url) {
  const res = await request(url, { maxBytes: MAX_BYTES, timeout: 3000 });
  return res && res.status === 200 ? res.body : null;
}

const PERSONAL = new Set(
  [
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.nl', 'live.com', 'live.nl', 'msn.com',
    'yahoo.com', 'yahoo.nl', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'mail.com', 'gmx.com',
    'gmx.net', 'gmx.de', 'web.de', 'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'fastmail.com', 'hey.com',
    'duck.com', 'ziggo.nl', 'kpnmail.nl', 'kpnplanet.nl', 'planet.nl', 'home.nl', 'hetnet.nl', 'xs4all.nl',
    'telfort.nl', 'casema.nl', 'chello.nl', 'upcmail.nl', 'quicknet.nl', 'tele2.nl', 'online.nl', 'zonnet.nl',
    'freedom.nl', 'caiway.nl', 'solcon.nl', 'onsbrabantnet.nl', 'telenet.be', 'skynet.be'
  ]
);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc']);
const RETRY_AFTER = 7 * 24 * 3600 * 1000;
const MAX_BYTES = 256 * 1024;

// "nieuwsbrieven.anwb.nl" -> "anwb.nl", "mail.bbc.co.uk" -> "bbc.co.uk".
function siteOf(address) {
  const domain = String(address || '').split('@')[1];
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return null;
  const labels = domain.toLowerCase().split('.');
  const take = labels.length > 2 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  const site = labels.slice(-take).join('.');
  return PERSONAL.has(site) || PERSONAL.has(domain.toLowerCase()) ? null : site;
}

function imageType(buf) {
  if (buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

class Logos {
  // getImpl(url) resolves to the response body as a Buffer, or null.
  constructor(dir, { getImpl = download, enabled = true } = {}) {
    this.dir = dir;
    this.get1 = getImpl;
    this.enabled = enabled;
    this.inflight = new Map();
    this.queue = [];
    this.running = 0;
    fs.mkdirSync(dir, { recursive: true });
  }

  // { site: dataUrl | null } for the given sites; unknown ones are fetched.
  async get(sites) {
    const out = {};
    await Promise.all(
      [...new Set(sites)].filter(Boolean).slice(0, 200).map(async (site) => {
        out[site] = await this.one(site);
      })
    );
    return out;
  }

  one(site) {
    if (!/^[a-z0-9.-]+$/.test(site)) return Promise.resolve(null);
    const file = path.join(this.dir, `${site}.logo`);
    const none = path.join(this.dir, `${site}.none`);
    try {
      const buf = fs.readFileSync(file);
      const type = imageType(buf);
      if (type) return Promise.resolve(`data:${type};base64,${buf.toString('base64')}`);
    } catch (_) {
      // Not cached yet.
    }
    try {
      if (Date.now() - fs.statSync(none).mtimeMs < RETRY_AFTER) return Promise.resolve(null);
    } catch (_) {
      // Never failed before.
    }
    if (!this.enabled) return Promise.resolve(null);
    if (!this.inflight.has(site)) {
      const job = this.limited(() => this.download(site))
        .then((buf) => {
          if (!buf) {
            fs.writeFileSync(none, '');
            return null;
          }
          fs.writeFileSync(file, buf);
          return `data:${imageType(buf)};base64,${buf.toString('base64')}`;
        })
        .catch(() => null)
        .finally(() => this.inflight.delete(site));
      this.inflight.set(site, job);
    }
    return this.inflight.get(site);
  }

  // At most four downloads at a time.
  limited(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.running < 4 && this.queue.length) {
      const { task, resolve, reject } = this.queue.shift();
      this.running++;
      task()
        .then(resolve, reject)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  async download(site) {
    for (const url of [`https://${site}/apple-touch-icon.png`, `https://www.${site}/apple-touch-icon.png`, `https://${site}/favicon.ico`, `https://www.${site}/favicon.ico`]) {
      const buf = await this.get1(url).catch(() => null);
      if (buf && buf.length > 64 && buf.length <= MAX_BYTES && imageType(buf)) return buf;
    }
    return null;
  }
}

module.exports = { Logos, siteOf, imageType };
