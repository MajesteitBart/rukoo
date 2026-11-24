// Rukoo in the browser (src/web/index.html, served at /app): team chat and the Rukoo account, nothing else. This module
// takes the place of bootstrap.js and app.js there. It draws the desktop's chat markup (app.js renderShell: a sidebar
// with chat.js's list and foot, the chat section beside it), hands chat.js the context it asks app.js for, routes the
// sidebar's clicks, the keys and main's events like app.js does, and hosts the Rukoo account pages in a Settings page of
// its own with Language, Theme and Team chat notifications. window.mail is web/bridge.js, which answers like
// preload.js and main.js do on the desktop.
//
// Besides the desktop: the page shows why chat isn't there when the server has none or its engine didn't start (gate),
// counts what asks for you in the tab's title while the tab is away, and on a phone shows either the list or the
// conversation, with Back. The browser's back closes what is on top (history), and notices sit above a phone's
// composer.
import { setLanguage, localize, languages, t } from './i18n.js';
import { watchErrors } from './diag.js';
import { api, esc, $, toast, dropTaggedToast, applyTheme, onSystemThemeChange, dialog, choiceDialog, confirmDialog, menuOpen, closeMenu } from './ui.js';
import { icons } from './icons.js';
import { DISMISSED_KEY, noticeHtml, platformOf, dismissed as appsWereDismissed, dismiss as dismissApps } from './web-apps.js';

watchErrors();

// The state's settings, as chat-dialogs.js reads ctx.S.data: a page has no mail accounts.
const S = { data: { accounts: [], settings: {} } };

async function loadState() {
  const state = await api('state');
  S.data = { ...state, accounts: [], settings: state && state.settings ? state.settings : {} };
  return S.data;
}

// The language and theme from the bridge, before the modules that draw labels load (as bootstrap.js does). A browser
// too old for team chat (web/bridge.js, code browser_old) gets the page that says so (gate 'old'), in the language the
// bridge chose; it has no settings to give.
let oldBrowser = false;
try {
  await loadState();
} catch (err) {
  oldBrowser = err.code === 'browser_old';
  if (!oldBrowser) toast(err.message, 8000);
}
document.body.classList.toggle('web-old', oldBrowser);
if (S.data.settings.language || !oldBrowser) setLanguage(S.data.settings.language);
applyTheme(S.data.settings.theme);
let drawnLanguage = S.data.settings.language;

const chat = await import('./chat.js');
const { accountPages, ACCOUNT_VIEWS } = await import('./rukoo-account.js');

const root = document.documentElement;
const BASE_TITLE = document.title || 'Rukoo';
// The desktop's widths (app.js SIDEBAR_W, RAIL_W): below 1100px the sidebar is a rail. At 700px and less the page is a
// phone's: the list or the conversation fills the screen.
const SIDEBAR_W = 236;
const RAIL_W = 60;
const RAIL = matchMedia('(max-width: 1099.98px)');
const PHONE = matchMedia('(max-width: 700px)');
// A room that opens this soon after a tap or a key was opened by the person (a row, New message, Browse), so a phone
// shows it. One that opens by itself, when the page loads or a workspace switches, leaves a phone on the list.
const GESTURE_MS = 4000;
const LAYOUT = 'rukoo.web.layout';

const prefs = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT) || '{}');
    return { collapsed: Boolean(saved && saved.collapsed) };
  } catch (_) {
    return { collapsed: false };
  }
})();
function savePrefs() {
  try {
    localStorage.setItem(LAYOUT, JSON.stringify(prefs));
  } catch (_) {
    // Blocked storage only means the sidebar opens expanded next time.
  }
}

// ---------- the page ----------

const app = $('#app');
app.innerHTML = `<div class="web-apps-slot" hidden></div>
  <div class="shell web-shell">
    <aside class="sidebar" data-i18n-aria-label="chat.sidebar.label" aria-label="${esc(t('chat.sidebar.label'))}"><div class="sidebar-main"></div></aside>
    <div class="workspace">
      <section class="chat" data-i18n-aria-label="chat.view.label" aria-label="${esc(t('chat.view.label'))}" data-thread="closed"></section>
      <section class="web-gate" data-i18n-aria-label="chat.view.label" aria-label="${esc(t('chat.view.label'))}" hidden></section>
    </div>
  </div>`;
const shell = $('.shell', app);
const gateEl = $('.web-gate', app);

// The title bar keeps the brand. A phone gets Back (from a conversation to the list) before it, and Settings at the
// other end, where the desktop's window buttons would be.
$('.titlebar').insertAdjacentHTML(
  'afterbegin',
  `<button type="button" class="web-back" data-web="back" data-i18n-title="chat.web.backTitle" title="${esc(t('chat.web.backTitle'))}" data-i18n-aria-label="chat.web.backTitle" aria-label="${esc(t('chat.web.backTitle'))}">${icons.back}<span data-i18n="common.actions.back">${esc(t('common.actions.back'))}</span></button>`
);
$('.titlebar-actions').innerHTML = `<button type="button" class="icon-btn web-bar-settings" data-web="settings" data-i18n-title="settings.title.short" title="${esc(t('settings.title.short'))}" data-i18n-aria-label="settings.title.short" aria-label="${esc(t('settings.title.short'))}">${icons.settings}</button>`;
$('.titlebar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-web]');
  if (!b) return;
  if (b.dataset.web === 'back') showList();
  if (b.dataset.web === 'settings') openPanel();
});

// ---------- the server: does it have team chat? ----------

// What GET /v1/info said: 'loading', 'on', 'off' (no team chat there) or 'unreachable'. Chat's own state says
// available once the engine has the same info; until then this tells "not yet" from "not here".
const server = { info: 'loading', host: location.host };
// As rukoo-account.js chatIn() and main's isAvailable() decide it (contract 3.1).
const chatIn = (info) => Boolean(info && Array.isArray(info.features) && info.features.includes('workspaces-v1') && info.workspace && Array.isArray(info.workspace.versions) && info.workspace.versions.includes(1));
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch (_) {
    return '';
  }
};

async function checkServer() {
  server.info = 'loading';
  update();
  const status = await api('accountStatus').catch(() => null);
  if (status && status.server) server.host = hostOf(status.server) || server.host;
  try {
    server.info = chatIn(await api('accountServerInfo')) ? 'on' : 'off';
  } catch (_) {
    server.info = 'unreachable';
  }
  update();
}
window.addEventListener('online', () => {
  if (server.info === 'unreachable') checkServer();
});

const signedIn = () => Boolean(chat.CH.state && chat.CH.state.signedIn);
const host = () => (chat.CH.state && chat.CH.state.host) || server.host;

// The chat engine didn't start: chatState itself failed, or the bridge says so (engineFailed, with the reason in
// engineError for the console). Only a reload starts it again; the account still works.
const engineFailed = () => chat.known() && (!chat.CH.state || chat.CH.state.engineFailed === true);

// What the page shows in place of chat while it isn't available: null when chat shows.
function gateKind() {
  if (oldBrowser) return 'old';
  if (chat.available()) return null;
  if (engineFailed()) return 'failed';
  if (server.info === 'off' || server.info === 'unreachable') return server.info;
  return 'loading';
}

let gateDrawn = null;
function drawGate(kind) {
  const key = `${kind}|${drawnLanguage}|${host()}|${signedIn()}`;
  if (key === gateDrawn) return;
  gateDrawn = key;
  if (kind === 'loading') {
    gateEl.innerHTML = `<div class="ch-empty is-busy" aria-busy="true" aria-label="${esc(t('chat.empty.loading'))}"><span class="spinner"></span></div>`;
    return;
  }
  const box = (icon, title, body, actions) => `<div class="ch-empty">${icons[icon]}
      <h2 class="ch-empty-title">${esc(title)}</h2><p class="ch-empty-body">${esc(body)}</p>
      <div class="ch-empty-actions">${actions.map((a) => `<button type="button" class="btn ${a.primary ? 'primary' : 'secondary'}" data-gate="${a.id}">${esc(a.label)}</button>`).join('')}</div>
    </div>`;
  const settings = { id: 'settings', label: t('chat.web.settings') };
  if (kind === 'off') {
    gateEl.innerHTML = box('chat', t('chat.web.offTitle'), t('chat.web.offBody', { host: host() }), signedIn() ? [{ id: 'sign-out', label: t('chat.web.signOut') }, settings] : [settings]);
  } else if (kind === 'unreachable') {
    gateEl.innerHTML = box('warning', t('chat.web.unreachableTitle', { host: host() }), t('chat.web.unreachableBody'), [settings, { id: 'retry', label: t('chat.web.tryAgain'), primary: true }]);
  } else if (kind === 'old') {
    // Nothing on the page works in this browser, Settings and a reload included.
    gateEl.innerHTML = box('warning', t('chat.web.oldTitle'), t('chat.web.oldBody'), []);
  } else {
    // 'failed': no spinner that never ends, but the way out.
    gateEl.innerHTML = box('warning', t('chat.empty.storageTitle'), t('chat.empty.webStorageBody'), [settings, { id: 'reload', label: t('chat.web.reload'), primary: true }]);
  }
}

gateEl.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-gate]');
  if (!b) return;
  switch (b.dataset.gate) {
    case 'settings':
      return openPanel();
    case 'retry':
      return checkServer();
    case 'reload':
      return location.reload();
    case 'sign-out': {
      // The account the dialog is for, as Settings' Sign out names it (rukoo-account.js): another tab can sign this
      // browser in to another account while the dialog is open, and the bridge then stops instead of ending that one.
      let status;
      try {
        status = await api('accountStatus');
      } catch (err) {
        return toast(err.message, 6000);
      }
      // Signed out meanwhile: the state event that says so redraws the gate without the button.
      if (!status.signedIn) return;
      const ok = await confirmDialog(t('settings.rukoo.signOut'), t('settings.rukoo.webSignOutHelp'), t('settings.rukoo.signOut'));
      if (!ok) return;
      try {
        await api('accountSignOut', { email: status.email });
        toast(t('settings.rukoo.signedOut'));
      } catch (err) {
        toast(err.message, 6000);
      }
      return checkServer();
    }
  }
});

// The foot's status line while chat isn't there.
function gateStatus(kind) {
  if (kind === 'off') return { cls: '', text: t('chat.web.statusOff'), title: t('chat.web.offBody', { host: host() }) };
  if (kind === 'unreachable') return { cls: '', text: t('chat.status.offline'), title: t('chat.errors.network', { host: host() }) };
  if (kind === 'failed') return { cls: 'error', text: t('chat.web.statusFailed'), title: t('chat.empty.webStorageBody') };
  if (kind === 'old') return { cls: 'error', text: t('chat.web.statusFailed'), title: t('chat.web.oldBody') };
  return { cls: 'busy', text: t('chat.status.connecting'), title: '' };
}

// ---------- layout: desktop widths, the rail, the phone ----------

// The phone's pane: 'list' or 'main'.
const pane = { show: 'list', gesture: 0, ws: null, open: null, preview: null };
// Settings while it is open (settingsPanel), or null.
let panel = null;
const railForced = () => RAIL.matches && !PHONE.matches;
const collapsed = () => !PHONE.matches && (RAIL.matches || prefs.collapsed);

// The list has something to pick from: a workspace on screen. Otherwise a phone shows the pane, which says why
// (signed out, no workspace yet, loading, gone).
const listUsable = () => chat.available() && signedIn() && Boolean(chat.CH.ws) && !chat.CH.gone;

function layout() {
  const phone = PHONE.matches;
  const rail = collapsed();
  shell.classList.toggle('collapsed', rail);
  document.body.classList.toggle('collapsed-sidebar', rail);
  shell.classList.toggle('web-phone', phone);
  document.body.classList.toggle('web-phone', phone);
  root.style.setProperty('--sidebar-w', `${rail ? RAIL_W : SIDEBAR_W}px`);
  const which = !phone ? '' : listUsable() ? pane.show : 'main';
  shell.dataset.pane = which;
  document.body.dataset.webPane = which;
  document.body.classList.toggle('web-can-back', phone && listUsable() && pane.show === 'main');
  syncHistory();
  placeToast();
}

// While a phone shows the list, no room is open for the engine: an open room holds back its alerts (the engine treats
// it as read on screen), and on the list nobody sees it. No room opens by itself then (ctx.listOnly, chat.js
// openDefault), and one that was open when the list came back is closed here, while chat.js keeps it as the one the
// list marks. A tap on a row opens it again (chatOpen); a wider window opens it again through chat.show().
let parked = false;
function park() {
  if (parked || !PHONE.matches || pane.show !== 'list' || !chat.CH.openId) return;
  parked = true;
  api('chatClose').catch(() => {});
}

function showMain() {
  // Every way to the conversation opens a room first (a row, New message, Browse, a notification).
  parked = false;
  if (PHONE.matches) pane.show = 'main';
  layout();
}

// Title bar's Back, and the back gesture over the conversation (closeLayer).
function showList() {
  pane.show = 'list';
  layout();
  park();
}

// The pointer and keys the person used; a synthetic Escape from closeLayer isn't a gesture.
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, (e) => e.isTrusted && (pane.gesture = Date.now()), true);

// ---------- history: what the back gesture closes ----------

// Above the page's own entry the history holds one entry per layer on screen that the browser's back (Android's back
// gesture) closes, bottom to top: on a phone 'conversation' (it shows instead of the list) and 'thread' (over the
// conversation); one 'settings' per page of Settings' own stack, at any width, since Settings covers the page and holds
// forms half filled in; and on a phone one 'dialog' per open dialog and a 'menu' while a menu is open, as Android's back
// closes those. Back closes the layer on top, as its own Back control does. A layer that closes another way (its own Back, Escape, a sign-in that
// closes Settings, a sign-out that empties the list) takes its entry back, so the history is never deeper than what
// shows, and back with nothing open leaves the page.
const layers = [];
// Our own history.go is on its way; nothing is pushed until its popstate, which comes in order after it.
let traversing = false;
let traverseTimer = null;
// closeLayer is closing what a back took away: the history is made to match after all of it closed.
let closing = false;
// How many of our layers' entries lie under and at a history entry.
const depthOf = (state) => (state && state.rukooWeb && Number.isSafeInteger(state.depth) && state.depth > 0 ? state.depth : 0);
const threadShows = () => Boolean(shell.querySelector('.chat[data-thread="open"]'));

function wantedLayers() {
  const out = [];
  const phone = PHONE.matches;
  if (phone && listUsable() && pane.show === 'main') {
    out.push('conversation');
    if (threadShows()) out.push('thread');
  }
  for (let i = panel ? panel.depth() : 0; i > 0; i--) out.push('settings');
  if (phone) for (let i = document.querySelectorAll('.scrim').length; i > 0; i--) out.push('dialog');
  if (phone && menuOpen()) out.push('menu');
  return out;
}

function goBy(delta) {
  traversing = true;
  clearTimeout(traverseTimer);
  // A traversal the browser doesn't make sends no popstate: after a while the history counts as it is.
  traverseTimer = setTimeout(() => {
    traversing = false;
    syncHistory();
  }, 1000);
  history.go(delta);
}

// The history follows what shows: entries for layers that closed go (one traversal back over all of them), entries for
// layers that opened come.
function syncHistory() {
  if (traversing || closing) return;
  const want = wantedLayers();
  let same = 0;
  while (same < layers.length && layers[same] === want[same]) same++;
  if (same < layers.length) {
    const extra = layers.length - same;
    layers.length = same;
    // What is still missing goes on after this traversal's popstate.
    return goBy(-extra);
  }
  for (const layer of want.slice(same)) {
    layers.push(layer);
    history.pushState({ rukooWeb: layer, depth: layers.length }, '');
  }
}

// What a back took away closes, as its own Back control would close it.
function closeLayer(layer) {
  if (layer === 'menu') closeMenu({ refocus: true });
  else if (layer === 'dialog') {
    // The dialog on top closes as with Escape (ui.js dialog()); one that asks first may stay, and gets its entry again.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  } else if (layer === 'settings') panel?.back();
  else if (layer === 'thread') shell.querySelector('.chat[data-thread="open"] .ch-thread-back')?.click();
  else if (layer === 'conversation') showList();
}

window.addEventListener('popstate', (e) => {
  traversing = false;
  clearTimeout(traverseTimer);
  const depth = depthOf(e.state);
  // Forward onto an entry whose layer has closed, or one of a load before a reload: back to the top of what shows.
  if (depth > layers.length) return goBy(layers.length - depth);
  if (depth < layers.length) {
    const gone = layers.splice(depth).reverse();
    closing = true;
    try {
      for (const layer of gone) closeLayer(layer);
    } finally {
      closing = false;
    }
  }
  syncHistory();
});

// A reload keeps the history of the load before it, and nothing of it shows now: back to the page's own entry.
if (depthOf(history.state) > 0) goBy(-depthOf(history.state));

// A thread opening or closing, and a dialog or a menu coming or going, change the layers on a phone.
const layerWatch = new MutationObserver(() => {
  syncHistory();
  placeToast();
});
layerWatch.observe($('.chat', shell), { attributes: true, attributeFilter: ['data-thread'] });
layerWatch.observe(document.body, { childList: true });

// ---------- notices above a phone's composer ----------

// The notice sits at the window's bottom (styles.css .toast), where a phone has the conversation's composer or the
// list's status line. It goes 8px above whichever shows: the composer (the thread's while a thread covers the log) at
// its height now, since it grows with the text and the on-screen keyboard moves it, or the list's foot. web.css reads
// --web-toast-bottom.
const TOAST_GAP = 8;
const toastEl = $('#toast');
const composerSize = new ResizeObserver(() => placeToast());
const watchedComposers = new Set();

function bottomBar() {
  // Settings covers the list and the conversation, and has nothing at its bottom.
  if (!PHONE.matches || panel) return null;
  const shown = (el) => (el && el.getClientRects().length && el.offsetHeight ? el : null);
  // The foot is drawn again with the list (renderSidebar), which places the notice again through layout().
  if (shell.dataset.pane === 'list') return shown(shell.querySelector('.sidebar-foot'));
  if (shell.dataset.pane !== 'main' || gateEl.hidden === false) return null;
  // The composers stay for the page's life (chat-view.js mountView): their size is watched.
  const el = shell.querySelector(threadShows() ? '.ch-thread:not([hidden]) .ch-thread-compose' : '.ch-main > .ch-compose');
  if (el && !watchedComposers.has(el)) {
    watchedComposers.add(el);
    composerSize.observe(el);
  }
  return shown(el);
}

function placeToast() {
  const bar = bottomBar();
  const lift = bar ? Math.ceil(document.documentElement.clientHeight - bar.getBoundingClientRect().top) : 0;
  if (lift > 0) root.style.setProperty('--web-toast-bottom', `${lift + TOAST_GAP}px`);
  else root.style.removeProperty('--web-toast-bottom');
}
window.addEventListener('resize', () => placeToast());
window.visualViewport?.addEventListener('resize', () => placeToast());
// Measured again as a notice shows: the composer may have moved since.
if (toastEl) new MutationObserver(() => toastEl.classList.contains('show') && placeToast()).observe(toastEl, { attributes: true, attributeFilter: ['class'] });

// A conversation (or a channel's preview) the person opened goes on screen on a phone: a new one, such as New message's
// DM or a channel from Browse, shortly after a tap. While the phone shows the list no room opens by itself (listOnly),
// so a sign-in, a reload or a workspace switch leaves it on the list.
function followRoom() {
  const { ws, openId, preview } = chat.CH;
  const previewId = preview ? preview.id : null;
  const replaced = (openId && openId !== pane.open) || (previewId && previewId !== pane.preview);
  const sameWs = ws === pane.ws;
  pane.ws = ws;
  pane.open = openId;
  pane.preview = previewId;
  if (replaced && sameWs && Date.now() - pane.gesture < GESTURE_MS) showMain();
}

for (const query of [RAIL, PHONE]) {
  query.addEventListener('change', () => {
    layout();
    renderSidebar();
  });
}
// A phone's list hides the conversation: its room closes for the engine. A wider window shows the conversation again,
// so the room opens again, or the last one does (chat.js show(), as at a desktop width).
PHONE.addEventListener('change', () => {
  if (PHONE.matches) return park();
  if (!parked && chat.CH.openId) return;
  parked = false;
  if (chat.available()) chat.show();
});

// ---------- the Rukoo apps ----------

// Above the page, while the person is signed in and chat is there: which Rukoo apps exist and in what order to get them
// (web-apps.js). Closing it hides it in every tab of this browser, for good. A sign-out hides it until the next sign-in.
const appsSlot = $('.web-apps-slot', app);
const appsStorage = (() => {
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
})();
let appsClosed = appsWereDismissed(appsStorage);
// { language } it was drawn in, or null while it isn't drawn.
let appsDrawn = null;

function renderApps() {
  syncTyping();
  const show = !appsClosed && !gateKind() && signedIn();
  if (show && (!appsDrawn || appsDrawn.language !== drawnLanguage)) {
    appsSlot.innerHTML = noticeHtml({ t, esc, icons, platform: platformOf(navigator) });
    appsDrawn = { language: drawnLanguage };
  }
  if (appsSlot.hidden === !show) return;
  appsSlot.hidden = !show;
  placeToast();
}

// byKeyboard: closed with Enter or Space on its button. The keyboard then goes on to the conversation's text, or the
// list's first control on a phone that shows the list. A tap leaves the focus alone, so a phone's keyboard doesn't
// come up for a composer the person didn't touch.
function closeApps(byKeyboard = false) {
  appsClosed = true;
  const had = appsSlot.contains(document.activeElement);
  renderApps();
  // Not the conversation's composer under an open thread, which is inert then.
  const shown = (el) => el.offsetParent !== null && !el.closest('[inert]');
  if (had && byKeyboard) ([...shell.querySelectorAll('.chat .ch-input')].find(shown) || [...shell.querySelectorAll('.sidebar button')].find(shown))?.focus({ preventScroll: true });
}

appsSlot.addEventListener('click', (e) => {
  if (!e.target.closest('[data-web-apps="dismiss"]')) return;
  dismissApps(appsStorage);
  // A click from Enter or Space has no pointer behind it: detail 0.
  closeApps(e.detail === 0);
});
// Closed in another tab of this browser.
window.addEventListener('storage', (e) => {
  if (e.key === DISMISSED_KEY && appsWereDismissed(appsStorage)) closeApps();
});
// While the composer has the focus, a phone's on-screen keyboard is up and the notice makes way (web.css). A class
// rather than :has(), which Firefox only has from 121 on. A focused composer that a redraw removes fires no focusout in
// WebKit and Firefox, so every chat redraw (renderApps) checks the focus again.
const typingIn = (el) => Boolean(el && el.closest && el.closest('.workspace .ch-input'));
function syncTyping(el = document.activeElement) {
  document.body.classList.toggle('web-typing', typingIn(el));
}
document.addEventListener('focusin', (e) => syncTyping(e.target));
document.addEventListener('focusout', (e) => syncTyping(e.relatedTarget));

// ---------- the sidebar ----------

function sidebarFoot(kind) {
  const status = kind ? gateStatus(kind) : chat.footStatus();
  const collapse = railForced()
    ? ''
    : `<button class="icon-btn web-foot-collapse" data-action="collapse" title="${esc(collapsed() ? t('mailbox.sidebar.expand') : t('mailbox.sidebar.collapse'))}">${icons.panelLeft}</button>`;
  return `<div class="sidebar-foot">
      <button class="sync-status ${status.cls}" data-action="sync" title="${esc(status.title)}"><span class="dot"></span><span class="t">${esc(status.text)}</span></button>
      <button class="icon-btn web-foot-settings" data-action="settings" data-i18n-title="settings.title.short" title="${esc(t('settings.title.short'))}">${icons.settings}</button>
      ${collapse}
    </div>`;
}

function renderSidebar() {
  const main = $('.sidebar-main', shell);
  if (!main) return;
  const kind = gateKind();
  // Every chat state redraws the sidebar (chat.js redrawSide), also one that only says the engine failed after all:
  // the gate follows it here, or its spinner would stay.
  showGate(kind);
  renderApps();
  main.innerHTML = (kind ? '<div class="ch-side-fill" aria-hidden="true"></div>' : chat.sidebarHtml()) + sidebarFoot(kind);
  followRoom();
  layout();
  updateBadge();
}

shell.querySelector('.sidebar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (chat.available() && chat.sidebarClick(b, e)) {
    if (b.dataset.chOpen) showMain();
    return;
  }
  switch (b.dataset.action) {
    case 'settings':
      return openPanel();
    case 'sync':
      // Chat's line syncs, or opens the Rukoo account while signed out; without chat it asks the server again, and
      // without an engine it reloads the page, as the gate's button does.
      if (chat.available()) return chat.reconnect();
      if (engineFailed()) return location.reload();
      return server.info === 'unreachable' ? checkServer() : openPanel('rukoo');
    case 'collapse':
      prefs.collapsed = !collapsed();
      savePrefs();
      return renderSidebar();
  }
});

// ---------- chat or the gate ----------

function showGate(kind) {
  shell.classList.toggle('chat-mode', !kind);
  document.body.classList.toggle('chat-mode', !kind);
  gateEl.hidden = !kind;
  if (kind) drawGate(kind);
  else gateDrawn = null;
}

let shownAvailable = null;
function update() {
  renderSidebar();
  // Settings shows Team chat notifications only while chat is there.
  if (shownAvailable !== chat.available()) {
    shownAvailable = chat.available();
    if (panel && panel.view() === 'main') panel.render();
  }
}

// ---------- the title: what asks for you, while the tab is away ----------

// chat.modeBadge(): a count of mentions and direct messages, else a dot for anything unread (contract 3.10). The
// count shows in the tab's title while the tab is hidden or another window has the focus, which is when the bridge
// leaves alerts to the title instead of showing them as a toast.
function updateBadge() {
  const away = document.visibilityState === 'hidden' || !document.hasFocus();
  const b = away ? chat.modeBadge() : null;
  const title = b && b.count ? `(${b.text}) ${BASE_TITLE}` : b && b.dot ? `• ${BASE_TITLE}` : BASE_TITLE;
  if (document.title !== title) document.title = title;
}
document.addEventListener('visibilitychange', updateBadge);
window.addEventListener('focus', updateBadge);
window.addEventListener('blur', updateBadge);

// ---------- files dropped outside the chat ----------

// A file let go of anywhere but where chat takes it would make the browser open it in place of the page, and the
// conversation, its draft and the files held in memory would go with it. The desktop window refuses that navigation
// itself (main.js will-navigate). Chat's own drop areas handle their files first (chat-view.js); everywhere else the
// pointer says nothing can be dropped there, and nothing happens.
const dragsFiles = (e) => Boolean(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    if (!dragsFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
}

// ---------- settings: language, theme, notifications, the Rukoo account ----------

const THEMES = () => [
  { value: 'system', label: t('settings.theme.system') },
  { value: 'light', label: t('settings.theme.light') },
  { value: 'dark', label: t('settings.theme.dark') }
];

// settings.js promptDialog, for the account pages' text prompts.
function promptDialog(title, value = '', { placeholder = '' } = {}) {
  return dialog({
    title,
    buttons: [
      { label: t('common.actions.cancel'), value: null },
      { label: t('common.actions.save'), value: (scrim) => scrim.querySelector('.form-input').value }
    ],
    render(body) {
      body.innerHTML = `<div class="form" style="padding:0"><input class="form-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}"/></div>`;
    }
  });
}

// view: open on one page, such as 'rukoo-signin' from chat's signed-out state; Back leads to the overview, as on the
// desktop. A sign-in, sign-up or recovery that worked closes Settings: chat then shows, and a pending invitation opens
// its Join dialog (chat.js maybeTakeJoin, on rukoo:settings-closed). Every page of Settings' stack has a history entry
// (syncHistory), so the browser's back goes where Settings' own Back goes.
function openPanel(view = null) {
  if (panel) {
    if (view && view !== panel.view()) panel.go(view);
    return;
  }
  panel = settingsPanel(view);
  syncHistory();
  placeToast();
}

function settingsPanel(start) {
  const page = document.createElement('div');
  page.className = 'page settings web-settings';
  $('#overlays').appendChild(page);
  const stack = start ? ['main', start] : ['main'];
  const view = () => stack[stack.length - 1];

  const close = () => {
    if (!page.isConnected) return;
    page.remove();
    document.removeEventListener('keydown', onKey, true);
    unsubscribe();
    panel = null;
    document.dispatchEvent(new Event('rukoo:settings-closed'));
    // Back where it was opened from: the gear or the empty state's button.
    (document.activeElement === document.body ? $('.web-foot-settings') : null)?.focus({ preventScroll: true });
    // Its history entries go (a Join dialog that the close opened gets one of its own).
    syncHistory();
    placeToast();
  };
  const back = () => {
    if (stack.length > 1) {
      stack.pop();
      render();
      syncHistory();
    } else close();
  };
  const go = (name) => {
    stack.push(name);
    render();
    syncHistory();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.scrim') && !menuOpen()) {
      e.stopPropagation();
      back();
    }
  };
  document.addEventListener('keydown', onKey, true);
  // The account's status from the bridge, as Settings gets it on the desktop.
  const unsubscribe = window.mail.on(({ type, payload }) => {
    if (type === 'account') account.onStatus(payload);
  });

  // settings.js row(): a switch row carries the role and its state on the button that takes the focus.
  const row = ({ title, desc, value, action, toggle, cls = '', lead = '' }) => `
    <button class="row ${cls}" ${action ? `data-a="${action}"` : ''}${toggle !== undefined ? ` role="switch" aria-checked="${Boolean(toggle)}"` : ''}>
      ${lead}
      <div class="text"><div class="title ${cls.includes('danger') ? 'danger' : ''}">${title}</div>
      ${desc ? `<div class="desc">${desc}</div>` : ''}${value ? `<div class="value">${value}</div>` : ''}</div>
      ${toggle !== undefined ? `<span class="switch ${toggle ? 'on' : ''}" aria-hidden="true"></span>` : ''}
    </button>`;

  // The account pages. Their success path calls back(); here it closes Settings, so the person lands in chat.
  const account = accountPages({
    row,
    go,
    back: () => close(),
    close: () => close(),
    showChat: () => {},
    rerender: () => render(),
    current: view,
    promptDialog
  });

  // What the bridge says of notifications (notificationState), read as the overview draws: 'unsupported' also where
  // the browser has Notification but won't let a page construct one (Android's Chrome), which the bridge knows.
  let notify = { supported: false, permission: 'unsupported' };

  function notificationRows(s) {
    if (!chat.available()) return '';
    const on = s.chatNotifications !== false;
    const permission = notify.permission;
    let desc = t('settings.general.chatNotificationsHelp');
    if (permission === 'unsupported') desc = t('settings.web.notificationsUnsupported');
    else if (permission === 'denied' && on) desc = t('settings.web.notificationsBlocked');
    const allow = on && permission === 'default' ? row({ title: esc(t('settings.web.notificationsAllow')), desc: esc(t('settings.web.notificationsAllowHelp')), action: 'notify-allow' }) : '';
    return row({ title: esc(t('settings.general.chatNotifications')), desc: esc(desc), action: 'toggle:chatNotifications', toggle: on }) + allow;
  }

  function mainPage() {
    const s = S.data.settings;
    const language = languages.find((l) => l.code === s.language)?.name || languages[0].name;
    const theme = THEMES().find((x) => x.value === (s.theme || 'system'))?.label || '';
    return `
      <div class="settings-group-title">${esc(t('settings.web.groupAccount'))}</div>
      <div class="card">${account.rowHtml()}</div>
      <div class="settings-group-title">${esc(t('settings.groups.general'))}</div>
      <div class="card">
        ${row({ title: esc(t('settings.general.language')), desc: esc(t('settings.general.languageHelp')), value: esc(language), action: 'language' })}
        ${row({ title: esc(t('settings.general.theme')), value: esc(theme), action: 'theme' })}
        ${notificationRows(s)}
      </div>`;
  }

  async function render() {
    const name = view();
    await account.prepare(name);
    if (name === 'main') notify = await api('notificationState').catch(() => ({ supported: false, permission: 'unsupported' }));
    if (!page.isConnected || view() !== name) return;
    let title = t('settings.title.short');
    let body = '';
    if (name === 'main') body = mainPage();
    else if (ACCOUNT_VIEWS.includes(name)) ({ title, body } = account.view(name));
    // A redraw keeps the keyboard on the control with the same action.
    const focused = page.contains(document.activeElement) ? document.activeElement.dataset.a : null;
    page.innerHTML = `
      <div class="page-bar"><button class="icon-btn" data-a="back" title="${esc(t('common.actions.back'))}" aria-label="${esc(t('common.actions.back'))}">${icons.back}</button><h1>${esc(title)}</h1></div>
      <div class="page-scroll"><div class="page-inner">${body}</div></div>`;
    if (focused) page.querySelector(`[data-a="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    account.fill(name);
  }

  const set = async (patch) => {
    try {
      await api('updateSettings', patch);
    } catch (err) {
      toast(err.message, 5000);
    }
    await settingsChanged();
  };

  page.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    if (String(form.dataset.form || '').startsWith('rukoo')) account.submit(form);
  });

  page.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    const s = S.data.settings;
    if (a === 'back') return back();
    if (a.startsWith('rukoo') && (await account.click(a))) return;
    if (a === 'language') {
      const value = await choiceDialog(t('settings.general.language'), languages.map((l) => ({ value: l.code, label: l.name })), s.language);
      if (value && value !== s.language) await set({ language: value });
      return;
    }
    if (a === 'theme') {
      const value = await choiceDialog(t('settings.general.theme'), THEMES(), s.theme || 'system');
      if (value && value !== s.theme) await set({ theme: value });
      return;
    }
    if (a === 'toggle:chatNotifications') {
      const on = s.chatNotifications === false;
      // Turned on: the browser asks once. Asked first, while the click still counts as the person's.
      const asked = on && notify.permission === 'default' ? Notification.requestPermission().catch(() => {}) : null;
      await set({ chatNotifications: on });
      if (asked) await asked;
      return render();
    }
    if (a === 'notify-allow') {
      // The row shows only while the permission is 'default', which a browser without notifications never says.
      if (notify.permission === 'default') await Notification.requestPermission().catch(() => {});
      return render();
    }
  });

  render();
  return { close, back, go, render, view, depth: () => stack.length, onStatus: (status) => account.onStatus(status) };
}

// The bridge saved a setting, or says the language or theme changed: everything drawn follows.
async function settingsChanged() {
  try {
    await loadState();
  } catch (_) {
    return;
  }
  const s = S.data.settings;
  applyTheme(s.theme);
  if (s.language !== drawnLanguage) {
    drawnLanguage = s.language;
    setLanguage(s.language);
    localize();
    chat.relocalize();
    gateDrawn = null;
    update();
  }
  panel?.render();
}

// ---------- events and keys ----------

window.mail.on(({ type, payload }) => {
  // Team chat (contract 4.5). A click on a notification comes as kind 'open': that conversation, at that message.
  if (type === 'chat' && payload && typeof payload === 'object') {
    if (payload.kind === 'open') {
      if (!chat.available()) return;
      panel?.close();
      chat.openConversation(payload.ws, payload.conversation, Number.isSafeInteger(payload.seq) ? payload.seq : null);
      pane.gesture = Date.now();
      showMain();
    } else chat.onEvent(payload);
  }
  if (type === 'chat-toast' && payload) toast(payload.body, { tag: payload.id });
  if (type === 'chat-toast-hide') dropTaggedToast(payload);
  if (type === 'toast') toast(payload);
  if (type === 'language' || type === 'theme') settingsChanged();
});

onSystemThemeChange(() => applyTheme(S.data.settings.theme));

document.addEventListener('keydown', (e) => {
  if (menuOpen()) return;
  if (document.querySelector('.page, .scrim')) return;
  if (chat.available() && chat.onKey(e)) e.preventDefault();
});

// ---------- start ----------

// What chat.js asks of app.js (chat.js init, redrawSide, ensureView). chatMode: the page is always in Chat. The gate
// hides the chat section while chat isn't available, so nothing in it counts as read then.
const ctx = {
  S,
  openSettings: (view) => openPanel(view || null),
  chatMode: () => true,
  // A phone showing the list: no room opens by itself (chat.js openDefault).
  listOnly: () => PHONE.matches && pane.show === 'list',
  sidebarReady: () => Boolean($('.sidebar-main', shell)),
  renderSidebar: () => renderSidebar(),
  renderModeSwitch: () => updateBadge(),
  chatAvailability: () => update()
};

layout();
chat.init(ctx);
chat.show();
update();
checkServer();
