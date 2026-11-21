// The Rukoo apps notice of the browser app (src/renderer/web-apps.js): which system the page guesses, the links each
// system gets, what the browser remembers, and the markup. The module has no imports; the root package is CommonJS, so
// it loads from its source as a data: URL, as test/calendar-dates.test.js loads a renderer module.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../src/renderer/web-apps.js', import.meta.url), 'utf8');
const apps = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const i18n = require('../../src/i18n/index.js');
const redirects = readFileSync(new URL('../site/_redirects', import.meta.url), 'utf8');

const UA = {
  windows: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', platform: 'Win32' },
  windowsHints: { userAgent: 'Mozilla/5.0', userAgentData: { platform: 'Windows' } },
  mac: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 },
  ipadDesktop: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 },
  iphone: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', platform: 'iPhone' },
  android: { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-F966B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36', platform: 'Linux armv8l' },
  linux: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', platform: 'Linux x86_64' },
  chromeos: { userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', platform: 'Linux x86_64' }
};

test('the page guesses the system from what the browser says, a phone before the system it is built on', () => {
  const guess = (name) => apps.platformOf(UA[name]);
  assert.equal(guess('windows'), 'windows');
  assert.equal(guess('windowsHints'), 'windows');
  assert.equal(guess('mac'), 'mac');
  assert.equal(guess('ipadDesktop'), 'ios', 'an iPad asking for desktop pages is a Mac with a touch screen');
  assert.equal(guess('iphone'), 'ios');
  assert.equal(guess('android'), 'android', 'Android says Linux too');
  assert.equal(guess('linux'), 'linux');
  assert.equal(guess('chromeos'), 'other', 'the desktop app has no build for Chrome OS');
  assert.equal(apps.platformOf({}), 'other');
  assert.equal(apps.platformOf(), 'other');
});

test('the steps come in order, and the desktop step offers the files for the system and then every download', () => {
  const hrefs = (platform) => apps.desktopLinks(platform).map((l) => l.href);
  assert.deepEqual(
    apps.steps('windows').map((s) => s.id),
    ['desktop', 'phone', 'voice']
  );
  assert.deepEqual(hrefs('windows'), [apps.LINKS.installer, apps.LINKS.all]);
  assert.deepEqual(hrefs('mac'), [apps.LINKS.macArm, apps.LINKS.macIntel, apps.LINKS.all]);
  assert.deepEqual(hrefs('linux'), [apps.LINKS.deb, apps.LINKS.appImage, apps.LINKS.all]);
  for (const platform of ['android', 'ios', 'other']) {
    assert.deepEqual(hrefs(platform), [apps.LINKS.all], platform);
    assert.equal(apps.steps(platform)[0].desc, platform === 'other' ? 'chat.web.apps.desktopDesc' : 'chat.web.apps.desktopDescPhone');
  }
  assert.equal(apps.desktopLinks('windows').at(-1).quiet, true, 'every download is the quieter link after the system’s own');
  assert.deepEqual(apps.steps('mac')[1].links.map((l) => l.href), [apps.LINKS.android]);
  assert.deepEqual(apps.steps('mac')[2].links.map((l) => l.href), [apps.LINKS.voice]);
});

test('every rukoo.io download link is one the site redirects', () => {
  for (const [name, href] of Object.entries(apps.LINKS)) {
    const url = new URL(href);
    if (url.hostname !== 'rukoo.io' || !url.pathname.startsWith('/download/')) continue;
    assert.match(redirects, new RegExp(`^${url.pathname}\\s+https://`, 'm'), `${name}: ${url.pathname} is in site/_redirects`);
  }
  assert.match(apps.LINKS.voice, /^https:\/\/github\.com\/MajesteitBart\/rukoo\/releases\/tag\/voice-v\d+\.\d+\.\d+$/);
});

test('closing the notice is remembered, and storage that fails counts as not closed', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(apps.dismissed(storage), false);
  apps.dismiss(storage);
  assert.equal(store.get(apps.DISMISSED_KEY), 'dismissed');
  assert.equal(apps.dismissed(storage), true);
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    }
  };
  assert.equal(apps.dismissed(broken), false);
  assert.doesNotThrow(() => apps.dismiss(broken));
  assert.equal(apps.dismissed(null), false);
  assert.doesNotThrow(() => apps.dismiss(null));
});

test('the markup has every step in order, translated and escaped, with links that open in a new tab', () => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const icons = { download: '<svg data-i="download"></svg>', close: '<svg data-i="close"></svg>', monitor: '<svg data-i="monitor"></svg>', phone: '<svg data-i="phone"></svg>', mic: '<svg data-i="mic"></svg>' };
  for (const lang of ['en', 'nl']) {
    const t = (key, params) => i18n.translate(lang, key, params);
    const html = apps.noticeHtml({ t, esc, icons, platform: 'mac' });
    const order = ['desktop', 'phone', 'voice'].map((id) => html.indexOf(`data-step="${id}"`));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `${lang}: the steps in order`);
    for (const key of ['chat.web.apps.title', 'chat.web.apps.intro', 'chat.web.apps.desktopName', 'chat.web.apps.phoneName', 'chat.web.apps.voiceName', 'chat.web.apps.downloadMacArm', 'chat.web.apps.downloadMacIntel', 'chat.web.apps.otherSystems', 'chat.web.apps.downloadAndroid', 'chat.web.apps.downloadVoice']) {
      assert.ok(html.includes(esc(t(key))), `${lang}: ${key}`);
    }
    assert.ok(html.includes(`aria-label="${esc(t('chat.web.apps.dismiss'))}"`), `${lang}: the close button has a name`);
    const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    assert.equal(links.length, 5, `${lang}: three desktop links on a Mac, Android and Voice`);
    for (const a of links) {
      assert.match(a, /target="_blank"/);
      assert.match(a, /rel="noopener"/);
    }
  }
  // English and Dutch have every key, and Dutch translates the labels (Rukoo Voice is a name).
  for (const key of Object.keys(require('../../src/i18n/en.js')).filter((k) => k.startsWith('chat.web.apps.'))) {
    assert.ok(require('../../src/i18n/nl.js')[key], `nl has ${key}`);
  }
  const html = apps.noticeHtml({ t: (k) => (k === 'chat.web.apps.title' ? '<b>x</b>' : k), esc, icons, platform: 'windows' });
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), 'labels are escaped');
});

test('only the browser app loads the notice: no desktop renderer file imports it', () => {
  const dir = new URL('../../src/renderer/', import.meta.url);
  const importers = readdirSync(dir, { recursive: true })
    .filter((f) => /\.(js|html)$/.test(f))
    .filter((f) => /['"]\.\/web-apps\.js['"]/.test(readFileSync(new URL(f.split(path.sep).join('/'), dir), 'utf8')));
  assert.deepEqual(importers, ['web-shell.js']);
});
