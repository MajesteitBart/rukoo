// Rukoo in the browser only (web-shell.js): the notice that points someone who just started in the browser at the Rukoo
// apps, in the order to get them. First the desktop app, for mail, calendar and meetings; then Rukoo on the phone; then
// Rukoo Voice, which dictates and records meetings for the desktop app. It shows while the person is signed in and team
// chat is there, until they close it, and the browser remembers that (DISMISSED_KEY). The desktop app never loads this
// module.
//
// The download links are rukoo.io's own (website/site/_redirects), so they follow its releases; the desktop step offers
// the files that fit the visitor's system (platformOf). Rukoo Voice links to its release page until the site has a
// /download/ address for it.
//
// No imports, so website/tools/web-apps.test.mjs can load the module on its own: web-shell.js passes t, esc and the
// icons.

export const DISMISSED_KEY = 'rukoo.web.apps';

const SITE = 'https://rukoo.io';
export const LINKS = {
  installer: `${SITE}/download/installer`,
  macArm: `${SITE}/download/mac-arm64`,
  macIntel: `${SITE}/download/mac-x64`,
  deb: `${SITE}/download/deb`,
  appImage: `${SITE}/download/appimage`,
  android: `${SITE}/download/android`,
  all: `${SITE}/#download`,
  voice: 'https://github.com/MajesteitBart/rukoo/releases/tag/voice-v0.2.0'
};

// The visitor's system, as far as the browser says: 'windows', 'mac', 'linux', 'android', 'ios' or 'other'. An iPad
// that asks for desktop pages calls itself a Mac with a touch screen. Chrome OS counts as 'other': the desktop app has
// no build for it.
export function platformOf(nav = {}) {
  const ua = String(nav.userAgent || '').toLowerCase();
  const platform = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '').toLowerCase();
  if (platform === 'android' || ua.includes('android')) return 'android';
  if (/iphone|ipad|ipod/.test(ua) || /^(iphone|ipad|ipod|ios)/.test(platform)) return 'ios';
  if ((platform.startsWith('mac') || ua.includes('mac os x')) && Number(nav.maxTouchPoints) > 1) return 'ios';
  if (platform.includes('cros') || platform.includes('chrome os') || ua.includes('cros')) return 'other';
  if (platform.startsWith('win') || ua.includes('windows')) return 'windows';
  if (platform.startsWith('mac') || ua.includes('mac os x') || ua.includes('macintosh')) return 'mac';
  if (platform.includes('linux') || ua.includes('linux') || ua.includes('x11')) return 'linux';
  return 'other';
}

// The desktop step's links for a system: the files for it, then every download on rukoo.io for when the guess is
// wrong. A phone or an unknown system gets only the latter: the desktop app goes on a computer.
export function desktopLinks(platform) {
  const files = {
    windows: [{ key: 'chat.web.apps.downloadWindows', href: LINKS.installer }],
    mac: [
      { key: 'chat.web.apps.downloadMacArm', href: LINKS.macArm },
      { key: 'chat.web.apps.downloadMacIntel', href: LINKS.macIntel }
    ],
    linux: [
      { key: 'chat.web.apps.downloadDeb', href: LINKS.deb },
      { key: 'chat.web.apps.downloadAppImage', href: LINKS.appImage }
    ]
  }[platform];
  return files ? [...files, { key: 'chat.web.apps.otherSystems', href: LINKS.all, quiet: true }] : [{ key: 'chat.web.apps.allDownloads', href: LINKS.all }];
}

// The three steps, in the order to take them.
export function steps(platform) {
  return [
    { id: 'desktop', icon: 'monitor', name: 'chat.web.apps.desktopName', desc: platform === 'android' || platform === 'ios' ? 'chat.web.apps.desktopDescPhone' : 'chat.web.apps.desktopDesc', links: desktopLinks(platform) },
    { id: 'phone', icon: 'phone', name: 'chat.web.apps.phoneName', desc: 'chat.web.apps.phoneDesc', links: [{ key: 'chat.web.apps.downloadAndroid', href: LINKS.android }] },
    { id: 'voice', icon: 'mic', name: 'chat.web.apps.voiceName', desc: 'chat.web.apps.voiceDesc', links: [{ key: 'chat.web.apps.downloadVoice', href: LINKS.voice }] }
  ];
}

// Whether this browser was told to stop showing the notice. Storage that can't be read counts as not dismissed: the
// notice then shows again on the next visit, which is the safe side.
export function dismissed(storage) {
  try {
    return storage.getItem(DISMISSED_KEY) === 'dismissed';
  } catch (_) {
    return false;
  }
}

export function dismiss(storage) {
  try {
    storage.setItem(DISMISSED_KEY, 'dismissed');
  } catch (_) {
    // Blocked storage: the notice goes for this page only.
  }
}

// The notice's markup. t translates, esc escapes, icons is icons.js's set. Links open in a new tab, so a download
// never takes the page, its conversation or its unsent messages with it.
export function noticeHtml({ t, esc, icons, platform }) {
  const link = (l) =>
    `<a class="link-btn web-apps-link${l.quiet ? ' quiet' : ''}" href="${esc(l.href)}" target="_blank" rel="noopener" data-web-apps-link="${esc(l.key)}">${l.quiet ? '' : icons.download}<span>${esc(t(l.key))}</span></a>`;
  const items = steps(platform)
    .map(
      (s, i) => `<li class="web-apps-step" data-step="${s.id}">
        <span class="web-apps-n" aria-hidden="true">${i + 1}</span>
        <div class="web-apps-step-text">
          <div class="web-apps-name"><span class="web-apps-ic" aria-hidden="true">${icons[s.icon] || ''}</span>${esc(t(s.name))}</div>
          <div class="web-apps-desc">${esc(t(s.desc))}</div>
          <div class="web-apps-links">${s.links.map(link).join('')}</div>
        </div>
      </li>`
    )
    .join('');
  return `<section class="web-apps" aria-labelledby="web-apps-title" data-platform-guess="${esc(platform)}">
      <div class="web-apps-head">
        <div class="web-apps-text">
          <h2 class="web-apps-title" id="web-apps-title">${esc(t('chat.web.apps.title'))}</h2>
          <p class="web-apps-intro">${esc(t('chat.web.apps.intro'))}</p>
        </div>
        <button type="button" class="icon-btn web-apps-close" data-web-apps="dismiss" title="${esc(t('chat.web.apps.dismiss'))}" aria-label="${esc(t('chat.web.apps.dismiss'))}">${icons.close}</button>
      </div>
      <ol class="web-apps-steps">${items}</ol>
    </section>`;
}
