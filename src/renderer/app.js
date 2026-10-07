import { t, setLanguage, localize } from './i18n.js';
import { icons } from './icons.js';
import {
  api,
  esc,
  $,
  $$,
  listTime,
  groupLabel,
  longDate,
  readerDate,
  hhmm,
  numericDate,
  fileSize,
  person,
  formatAddress,
  avatar,
  hue,
  initials,
  cleanPreview,
  toast,
  runToastAction,
  showMenu,
  closeMenu,
  menuOpen,
  confirmDialog,
  choiceDialog,
  applyTheme,
  onSystemThemeChange,
  isLight
} from './ui.js';
import { fillFrame } from './mailframe.js';
import { mountComposer } from './composer.js';
import { openSettings, promptDialog } from './settings.js';
import { openSetup } from './setup.js';

// Sidebar entries. `drop` marks a folder role that accepts dragged messages.
const VIEWS = [
  { id: 'inbox', get label() { return t('mailbox.folders.inbox'); }, icon: 'inbox', count: 'strong', drop: 'inbox' },
  { id: 'vip', get label() { return t('mailbox.folders.vip'); }, icon: 'vip', count: 'muted' },
  { id: 'starred', get label() { return t('mailbox.folders.starred'); }, icon: 'star' },
  { id: 'drafts', get label() { return t('mailbox.folders.drafts'); }, icon: 'drafts', count: 'muted' },
  { id: 'sent', get label() { return t('mailbox.folders.sent'); }, icon: 'sent' },
  { id: 'archive', get label() { return t('mailbox.folders.archive'); }, icon: 'archive', role: true, drop: 'archive' },
  { id: 'junk', get label() { return t('mailbox.folders.junk'); }, icon: 'junk', role: true, count: 'muted', drop: 'junk' },
  { id: 'trash', get label() { return t('mailbox.folders.trash'); }, icon: 'trash', drop: 'trash' },
  { id: 'saved', get label() { return t('mailbox.folders.saved'); }, icon: 'saved' }
];
const LABELS = Object.fromEntries(VIEWS.map((v) => [v.id, () => v.label]));
const FILTERS = [
  { id: 'all', get label() { return t('mailbox.filters.all'); } },
  { id: 'unread', get label() { return t('mailbox.filters.unread'); } },
  { id: 'starred', get label() { return t('mailbox.filters.starred'); } },
  { id: 'attachments', get label() { return t('mailbox.filters.attachments'); } }
];
const LIST_MIN = 300;
const LIST_MAX = 640;
const SIDEBAR_W = 236;
const RAIL_W = 60;

export const S = {
  data: null,
  scope: 'all',
  view: 'inbox',
  folder: null,
  query: '',
  searchScope: 'view',
  filter: 'all',
  list: [],
  counts: null,
  selectedId: null,
  checked: new Set(),
  anchorId: null,
  // The keyboard position while Shift+arrows grow a selection. selectedId stays the message on screen.
  cursorId: null,
  message: null,
  loading: false,
  expanded: false,
  details: false,
  attachmentsOpen: true,
  // Stacks of mail from one sender that the user unfolded.
  openStacks: new Set(),
  // Open the newest message after the next load (at start and on a folder switch).
  autoOpen: true,
  // The inline editor in the reading pane, when one is open.
  composer: null
};

// Layout preferences live in the renderer; they only matter to this window.
const prefs = { listWidth: 400, sidebarCollapsed: false, ...readPrefs() };
function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem('rukoo.layout') || '{}');
  } catch (_) {
    return {};
  }
}
function savePrefs() {
  localStorage.setItem('rukoo.layout', JSON.stringify(prefs));
}

const root = document.documentElement;

// ---------- data ----------

let renderedLanguage = null;
let refreshTimer = null;
let pending = null;
let again = false;

export function scheduleRefresh(ms = 60) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

// Coalesces overlapping refreshes: a call during a running refresh triggers exactly one more pass.
export function refresh() {
  if (pending) {
    again = true;
    return pending;
  }
  pending = (async () => {
    do {
      again = false;
      await refreshOnce();
    } while (again);
  })().finally(() => {
    pending = null;
  });
  return pending;
}

function searchingAll() {
  return Boolean(S.query.trim()) && S.searchScope !== 'view';
}

async function refreshOnce() {
  const data = await api('state');
  S.data = data;
  const languageChanged = renderedLanguage !== data.settings.language;
  setLanguage(data.settings.language);
  renderedLanguage = data.settings.language;
  localize();
  if (languageChanged) {
    if (S.message) renderReader();
    S.composer?.retheme(data);
  }
  // With one account, "Alle accounts" would just repeat it; show the account itself.
  if (data.accounts.length === 1) S.scope = data.accounts[0].id;
  else if (!data.accounts.some((a) => a.id === S.scope)) S.scope = 'all';
  if (S.searchScope === 'account' && S.scope === 'all') S.searchScope = 'all';
  const query = searchingAll()
    ? { scope: S.searchScope === 'all' ? 'all' : S.scope, view: 'everything', query: S.query }
    : { scope: S.scope, view: S.view, folder: S.folder, query: S.query };
  const [list, counts] = await Promise.all([api('list', query), api('counts', S.scope)]);
  S.list = list;
  S.counts = counts;
  const ids = new Set(list.map((m) => m.id));
  for (const id of S.checked) if (!ids.has(id)) S.checked.delete(id);
  applyTheme(data.settings.theme);
  renderShell();
  if (!data.accounts.length) {
    if (!document.querySelector('.page.setup')) openSetup(ctx, { first: true });
    return;
  }
  renderSearch();
  renderSidebar();
  renderList();
  if (S.checked.size > 1) renderReader();
  else renderReaderNav();
  autoOpen();
}

// Show the newest message instead of an empty reading pane. It stays unread until you open it yourself.
function autoOpen() {
  if (!S.autoOpen) return;
  S.autoOpen = false;
  if (S.composer || S.selectedId || S.checked.size || S.query.trim() || window.innerWidth <= 860) return;
  // The newest message, whatever order the list is sorted in; a stack it is folded into opens with it.
  const newest = rows().reduce((a, b) => (!a || b.date > a.date ? b : a), null);
  if (newest) openMessage(newest.id, { auto: true });
}

function account(id) {
  return S.data.accounts.find((a) => a.id === id);
}

function scopedAccounts() {
  return S.scope === 'all' ? S.data.accounts : [account(S.scope)].filter(Boolean);
}

function viewLabel() {
  if (S.view === 'folder') {
    const acc = account(S.scope);
    const f = acc && acc.folders.find((x) => x.path === S.folder);
    return f ? f.name : S.folder;
  }
  return LABELS[S.view]?.() || t('mailbox.folders.inbox');
}

function folderName(m) {
  const acc = account(m.accountId);
  const f = acc && acc.folders.find((x) => x.path === m.folder);
  return f ? f.name : m.folder;
}

// The shortest label that still tells the accounts apart: "gmail", "gmail.com", the name before the @, or the address.
let labelCache = { key: '', labels: {} };
function accountLabel(acc) {
  const accounts = S.data.accounts;
  const key = accounts.map((a) => a.email).join(',');
  if (labelCache.key !== key) {
    const unique = (list) => new Set(list.map((x) => x.toLowerCase())).size === list.length;
    const domain = (a) => a.email.split('@')[1] || a.email;
    const candidates = [
      accounts.map((a) => domain(a).replace(/\.[^.]+$/, '')),
      accounts.map(domain),
      accounts.map((a) => a.email.split('@')[0]),
      accounts.map((a) => a.email)
    ];
    const pick = candidates.find(unique) || candidates[3];
    labelCache = { key, labels: Object.fromEntries(accounts.map((a, i) => [a.id, pick[i]])) };
  }
  return labelCache.labels[acc.id] || acc.email;
}

// The list as shown: S.list narrowed by the quick filter.
function rows() {
  switch (S.filter) {
    case 'unread':
      return S.list.filter((m) => m.unread);
    case 'starred':
      return S.list.filter((m) => m.starred);
    case 'attachments':
      return S.list.filter((m) => m.hasAttachments);
    default:
      return S.list;
  }
}

function byId(id) {
  return S.list.find((x) => x.id === id) || (S.message && S.message.id === id ? S.message : null);
}

function checkedMessages() {
  return S.list.filter((m) => S.checked.has(m.id));
}

// What an action applies to: the checked messages, or else the message on screen.
function targets() {
  if (S.checked.size) return checkedMessages();
  // While the editor fills the reading pane, there is no message on screen to act on.
  if (S.composer) return [];
  const m = S.message && (byId(S.message.id) || S.message);
  return m && m.id ? [m] : [];
}

function cursor() {
  return S.cursorId && visibleRows().some((m) => m.id === S.cursorId) ? S.cursorId : S.selectedId;
}

// ---------- shell ----------

function sidebarCollapsed() {
  return prefs.sidebarCollapsed || window.innerWidth < 1100;
}

function listWidth() {
  const max = Math.max(LIST_MIN, Math.min(LIST_MAX, window.innerWidth - (sidebarCollapsed() ? RAIL_W : SIDEBAR_W) - 420));
  return Math.round(Math.max(LIST_MIN, Math.min(max, prefs.listWidth)));
}

function renderShell() {
  const app = $('#app');
  if (!app.querySelector('.shell')) {
    app.innerHTML = `<div class="shell">
      <aside class="sidebar" data-i18n-aria-label="mailbox.layout.folders" aria-label="${esc(t('mailbox.layout.folders'))}"></aside>
      <div class="workspace">
        <section class="listpane" data-i18n-aria-label="mailbox.layout.messages" aria-label="${esc(t('mailbox.layout.messages'))}">
          <div class="list-head"></div>
          <div class="list-tools"></div>
          <div class="list-scroll" tabindex="0" role="listbox" aria-multiselectable="true" data-i18n-aria-label="mailbox.layout.messages" aria-label="${esc(t('mailbox.layout.messages'))}"></div>
        </section>
        <div class="divider" role="separator" aria-orientation="vertical" data-i18n-aria-label="mailbox.layout.listWidth" aria-label="${esc(t('mailbox.layout.listWidth'))}" tabindex="0"></div>
        <section class="reader" data-i18n-aria-label="mailbox.layout.message" aria-label="${esc(t('mailbox.layout.message'))}"></section>
      </div>
    </div>`;
    bindSidebar();
    bindList();
    bindDivider();
    bindReader();
    renderReader();
  }
  const shell = app.querySelector('.shell');
  const collapsed = sidebarCollapsed();
  shell.classList.toggle('collapsed', collapsed);
  shell.classList.toggle('expanded', S.expanded);
  shell.classList.toggle('has-message', Boolean(S.selectedId) || S.checked.size > 1 || Boolean(S.composer));
  shell.classList.toggle('compact', S.data?.settings.density === 'compact');
  shell.classList.toggle('selecting', S.checked.size > 0);
  root.style.setProperty('--sidebar-w', `${collapsed ? RAIL_W : SIDEBAR_W}px`);
  root.style.setProperty('--list-w', `${listWidth()}px`);
  document.body.classList.toggle('no-accounts', !S.data?.accounts.length);
  document.body.classList.toggle('collapsed-sidebar', collapsed);
}

// ---------- search (in the title bar) ----------

function searchScopeLabel(scope = S.searchScope) {
  if (scope === 'account') return t('mailbox.search.account');
  if (scope === 'all') return S.data.accounts.length > 1 ? t('mailbox.search.allAccounts') : t('mailbox.search.allFolders');
  return t('mailbox.search.folder');
}

function renderSearch() {
  const box = $('.titlebar-search');
  if (!box.querySelector('input')) {
    box.innerHTML = `<span class="s-ic">${icons.search}</span>
      <input id="search" type="search" autocomplete="off" spellcheck="false" data-i18n-aria-label="mailbox.search.label" aria-label="${esc(t('mailbox.search.label'))}"/>
      <button class="search-scope" data-action="search-scope" data-i18n-title="mailbox.search.scope" title="${esc(t('mailbox.search.scope'))}" aria-haspopup="menu"><span></span>${icons.chevronDown}</button>
      <kbd class="search-kbd">Ctrl+E</kbd>`;
    const input = box.querySelector('input');
    input.addEventListener('input', () => {
      S.query = input.value;
      box.classList.toggle('has-text', Boolean(input.value));
      scheduleRefresh(120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (input.value) clearSearch();
        else $('.list-scroll').focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        const first = visibleRows()[0];
        if (first) openMessage(first.id);
        $('.list-scroll').focus();
      }
    });
    box.querySelector('.search-scope').addEventListener('click', (e) => {
      const multi = S.data.accounts.length > 1;
      const options = ['view', multi && S.scope !== 'all' ? 'account' : null, 'all'].filter(Boolean);
      showMenu(
        e.currentTarget,
        [
          { heading: t('mailbox.search.in') },
          ...options.map((o) => ({
            label: o === 'view' ? t('mailbox.search.folderNamed', { folder: viewLabel() }) : searchScopeLabel(o),
            checked: S.searchScope === o,
            action: () => {
              S.searchScope = o;
              refresh();
              input.focus();
            }
          }))
        ],
        { align: 'right' }
      );
    });
  }
  const input = box.querySelector('input');
  box.title = `${t('mailbox.search.label')} (Ctrl+E)`;
  input.placeholder = S.searchScope === 'view' ? t('mailbox.search.placeholder', { scope: viewLabel() }) : t('mailbox.search.placeholder', { scope: searchScopeLabel().toLowerCase() });
  box.querySelector('.search-scope span').textContent = searchScopeLabel();
  if (document.activeElement !== input && input.value !== S.query) input.value = S.query;
  box.classList.toggle('has-text', Boolean(S.query));
}

function focusSearch() {
  const input = $('#search');
  if (!input) return;
  input.focus();
  input.select();
}

function clearSearch() {
  S.query = '';
  const input = $('#search');
  if (input) input.value = '';
  $('.titlebar-search')?.classList.remove('has-text');
  refresh();
}

// ---------- sidebar ----------

function syncStatus() {
  const accounts = scopedAccounts();
  if (accounts.some((a) => a.syncing)) return { cls: 'busy', text: t('mailbox.sync.syncing'), title: '' };
  const failed = accounts.find((a) => a.error);
  if (failed) return { cls: 'error', text: t('mailbox.sync.failed'), title: `${failed.email}: ${failed.error}` };
  const times = accounts.map((a) => a.lastSync).filter(Boolean);
  if (!times.length) return { cls: '', text: t('mailbox.sync.never'), title: '' };
  const syncedAt = Math.min(...times);
  const minutes = Math.floor((Date.now() - syncedAt) / 60000);
  const today = new Date(syncedAt).toDateString() === new Date().toDateString();
  const text =
    minutes < 1 ? t('mailbox.sync.justNow') : minutes < 60 ? t('mailbox.sync.minutesAgo', { count: minutes }) : today ? t('mailbox.sync.time', { time: hhmm(syncedAt) }) : t('mailbox.sync.date', { date: numericDate(syncedAt) });
  return { cls: 'ok', text, title: t('mailbox.sync.tooltip', { date: numericDate(syncedAt), time: hhmm(syncedAt) }) };
}

// Keeps "5 min geleden" current without re-rendering the sidebar.
setInterval(() => {
  const el = $('.sync-status');
  if (!el || !S.data) return;
  const status = syncStatus();
  el.className = `sync-status ${status.cls}`;
  el.title = status.title;
  el.querySelector('.t').textContent = status.text;
}, 30000);

function accountAvatar(acc) {
  return `<span class="avatar acc" style="--acc:${esc(acc.color || '#6f9cf2')}" aria-hidden="true">${esc((acc.name || acc.email).trim()[0] || '?').toUpperCase()}</span>`;
}

function renderSidebar() {
  const el = $('.sidebar');
  const counts = S.counts;
  const current = account(S.scope);
  const accounts = S.data.accounts;
  const hidden = new Set(S.data.settings.hiddenViews || []);
  const roles = new Set(scopedAccounts().flatMap((a) => a.folders.map((f) => f.role)));
  const fmt = (n) => (n > 999 ? '999+' : String(n));
  const countHtml = (v, n) => {
    if (!v.count || !n) return '';
    return `<span class="count ${v.count}" aria-label="${esc(t(v.id === 'drafts' ? 'mailbox.sidebar.draftCount' : 'mailbox.sidebar.unreadCount', { count: n }))}">${fmt(n)}</span>`;
  };

  const views = VIEWS.filter((v) => !hidden.has(v.id) && (!v.role || roles.has(v.id)));
  const viewRows = views
    .map((v) => {
      const active = S.view === v.id;
      return `<button class="nav-item ${active ? 'active' : ''}" data-view="${v.id}" ${v.drop ? `data-drop-role="${v.drop}"` : ''} title="${esc(v.label)}" ${
        active ? 'aria-current="page"' : ''
      }><span class="ic">${icons[v.icon]}</span><span class="label">${esc(v.label)}</span>${countHtml(v, counts.views[v.id] || 0)}</button>`;
    })
    .join('');

  // Your own folders get a colour of their own, and a letter in the collapsed rail.
  let folderRows = '';
  if (current) {
    const user = current.folders.filter((f) => !f.role && !hidden.has(`folder:${f.path}`));
    folderRows =
      `<div class="nav-section"><span data-i18n="mailbox.layout.folders">${esc(t('mailbox.layout.folders'))}</span><button class="icon-btn xs" data-action="new-folder" data-i18n-title="mailbox.folders.new" title="${esc(t('mailbox.folders.new'))}">${icons.plus}</button></div>` +
      user
        .map((f) => {
          const active = S.view === 'folder' && S.folder === f.path;
          const n = counts.folders[f.path] || 0;
          return `<button class="nav-item ${active ? 'active' : ''}" data-folder="${esc(f.path)}" data-drop-path="${esc(f.path)}" title="${esc(f.name)}" ${
            active ? 'aria-current="page"' : ''
          }><span class="ic fdot" style="--h:${hue(f.name)}"><i></i><b>${esc(initials({ name: f.name }).slice(0, 1))}</b></span><span class="label">${esc(f.name)}</span>${
            n ? `<span class="count muted">${fmt(n)}</span>` : ''
          }</button>`;
        })
        .join('');
  }

  const who = current
    ? `${accountAvatar(current)}<span class="who"><span class="name">${esc(current.name || current.email.split('@')[0])}</span><span class="email">${esc(current.email)}</span></span>`
    : `<span class="avatar acc all" aria-hidden="true">${icons.inbox}</span><span class="who"><span class="name" data-i18n="mailbox.search.allAccounts">${esc(t('mailbox.search.allAccounts'))}</span><span class="email">${esc(t('mailbox.sidebar.accountCount', { count: accounts.length }))}</span></span>`;
  const status = syncStatus();

  el.innerHTML = `
    <button class="account-switch" data-action="accounts" aria-haspopup="menu" title="${esc(current ? current.email : t('mailbox.search.allAccounts'))}">${who}<span class="chev">${icons.chevronUpDown}</span></button>
    <button class="btn compose-btn" data-action="compose" data-i18n-title="composer.titles.newShortcut" title="${esc(t('composer.titles.newShortcut'))}">${icons.compose}<span data-i18n="composer.titles.new">${esc(t('composer.titles.new'))}</span></button>
    <nav class="nav" data-i18n-aria-label="mailbox.layout.folders" aria-label="${esc(t('mailbox.layout.folders'))}">${viewRows}${folderRows}</nav>
    <div class="sidebar-foot">
      <button class="sync-status ${status.cls}" data-action="sync" title="${esc(status.title)}"><span class="dot"></span><span class="t">${esc(status.text)}</span></button>
      <button class="icon-btn" data-action="settings" data-i18n-title="settings.title.short" title="${esc(t('settings.title.short'))}">${icons.settings}</button>
      <button class="icon-btn" data-action="collapse" title="${sidebarCollapsed() ? t('mailbox.sidebar.expand') : t('mailbox.sidebar.collapse')}">${icons.panelLeft}</button>
    </div>`;
}

function accountMenu(anchor) {
  const accounts = S.data.accounts;
  const counts = S.counts.accounts || {};
  const items = accounts.map((a) => ({
    icon: accountAvatar(a),
    label: a.email,
    hint: counts[a.id] ? String(counts[a.id]) : '',
    current: S.scope === a.id,
    action: () => switchScope(a.id)
  }));
  if (accounts.length > 1) {
    items.push({ icon: 'inbox', get label() { return t('mailbox.search.allAccounts'); }, hint: S.counts.all ? String(S.counts.all) : '', current: S.scope === 'all', action: () => switchScope('all') });
  }
  items.push({ separator: true });
  items.push({ icon: 'plus', get label() { return t('settings.accounts.add'); }, action: () => openSetup(ctx, { first: false }) });
  items.push({ icon: 'settings', get label() { return t('settings.accounts.overview'); }, action: () => openSettings(ctx) });
  showMenu(anchor, items, { align: 'left' });
}

function switchScope(scope) {
  S.scope = scope;
  if (S.view === 'folder') {
    S.view = 'inbox';
    S.folder = null;
  }
  changeView();
}

function bindSidebar() {
  const el = $('.sidebar');
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    switch (t.dataset.action) {
      case 'accounts':
        return accountMenu(t);
      case 'compose':
        return compose({ mode: 'new' });
      case 'settings':
        return openSettings(ctx);
      case 'sync':
        return syncNow();
      case 'collapse':
        prefs.sidebarCollapsed = !sidebarCollapsed();
        savePrefs();
        renderShell();
        return renderSidebar();
      case 'new-folder':
        return newFolder();
    }
    if (t.dataset.view) {
      S.view = t.dataset.view;
      S.folder = null;
      return changeView();
    }
    if (t.dataset.folder) {
      S.view = 'folder';
      S.folder = t.dataset.folder;
      changeView();
      api('openFolder', S.scope, S.folder).catch((err) => toast(err.message));
    }
  });

  // Messages dragged from the list can be dropped on folders.
  const target = (e) => e.target.closest('[data-drop-role], [data-drop-path]');
  el.addEventListener('dragover', (e) => {
    const t = target(e);
    if (!t || !e.dataTransfer.types.includes('application/x-rukoo-ids')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.nav-item.drop-target').forEach((x) => x !== t && x.classList.remove('drop-target'));
    t.classList.add('drop-target');
  });
  el.addEventListener('dragleave', (e) => {
    const t = target(e);
    if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-target');
  });
  el.addEventListener('drop', (e) => {
    const t = target(e);
    $$('.nav-item.drop-target').forEach((x) => x.classList.remove('drop-target'));
    if (!t) return;
    e.preventDefault();
    let ids = [];
    try {
      ids = JSON.parse(e.dataTransfer.getData('application/x-rukoo-ids'));
    } catch (_) {
      return;
    }
    const list = ids.map(byId).filter(Boolean);
    const label = t.querySelector('.label')?.textContent || '';
    if (t.dataset.dropRole === 'trash') return removeMessages(list);
    if (t.dataset.dropRole) return moveMessages(list, { role: t.dataset.dropRole }, label);
    moveMessages(list, { path: t.dataset.dropPath, accountId: S.scope }, label);
  });
}

function changeView() {
  S.query = '';
  S.filter = 'all';
  S.checked.clear();
  S.autoOpen = true;
  // A message from the previous folder would look like it belongs to this one.
  if (S.selectedId) closeReader();
  const input = $('#search');
  if (input) input.value = '';
  $('.list-scroll')?.scrollTo(0, 0);
  refresh();
}

async function newFolder() {
  const name = await promptDialog(t('mailbox.folders.new'), '', { placeholder: t('mailbox.folders.name') });
  if (!name || !name.trim()) return;
  try {
    const path = await api('createFolder', S.scope, name);
    toast(t('mailbox.folders.created', { name: name.trim() }));
    S.view = 'folder';
    S.folder = path;
    changeView();
  } catch (err) {
    toast(err.message, 5000);
  }
}

// ---------- list ----------

function senderLine(m) {
  if (m.role === 'sent' || m.role === 'drafts') {
    const names = (m.to || []).map(person).filter(Boolean);
    return names.length ? t('mailbox.list.sentTo', { recipients: names.join(', ') }) : t('mailbox.message.noRecipient');
  }
  return person(m.from) || '(Onbekende afzender)';
}

function listTitle() {
  if (S.query.trim()) {
    return { title: t('mailbox.search.results'), sub: t('mailbox.search.summary', { count: rows().length, query: S.query.trim(), scope: S.searchScope === 'view' ? viewLabel() : searchScopeLabel().toLowerCase() }) };
  }
  const acc = account(S.scope);
  const unread = S.view === 'inbox' || S.view === 'folder' || S.view === 'vip' || S.view === 'junk' || S.view === 'archive' ? S.list.filter((m) => m.unread).length : 0;
  const where = acc ? acc.email : t('mailbox.search.allAccounts');
  return { title: viewLabel(), sub: unread ? t('mailbox.list.unreadSummary', { count: unread, scope: where }) : where };
}

function renderListHead() {
  const head = $('.list-head');
  const { title, sub } = listTitle();
  head.innerHTML = `<div class="list-title"><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
    ${S.query.trim() ? `<button class="tbtn" data-action="search-clear" data-i18n-title="mailbox.search.clearShortcut" title="${esc(t('mailbox.search.clearShortcut'))}">${icons.close}<span data-i18n="common.actions.clear">${esc(t('common.actions.clear'))}</span></button>` : ''}
    <button class="icon-btn" data-action="sync" data-i18n-title="mailbox.sync.shortcut" title="${esc(t('mailbox.sync.shortcut'))}">${icons.sync}</button>
    <button class="icon-btn" data-action="list-more" data-i18n-title="common.actions.moreOptions" title="${esc(t('common.actions.moreOptions'))}" aria-haspopup="menu">${icons.more}</button>`;
}

function renderListTools() {
  const tools = $('.list-tools');
  if (S.checked.size) {
    const n = S.checked.size;
    const all = rows().length > 0 && rows().every((m) => S.checked.has(m.id));
    const list = checkedMessages();
    const anyUnread = list.some((m) => m.unread);
    const canArchive = list.some((m) => account(m.accountId)?.archive && m.role !== 'archive');
    tools.className = 'list-tools selecting';
    tools.innerHTML = `<button class="check ${all ? 'on' : 'some'}" data-action="check-all" title="${all ? t('mailbox.selection.none') : t('mailbox.selection.allShortcut')}" role="checkbox" aria-checked="${all ? 'true' : 'mixed'}">${icons.check}</button>
      <span class="sel-count">${esc(t('mailbox.selection.count', { count: n }))}</span>
      <span class="spacer"></span>
      <button class="icon-btn" data-bulk="${anyUnread ? 'read' : 'unread'}" title="${anyUnread ? t('mailbox.actions.readShortcut') : t('mailbox.actions.unreadShortcut')}">${anyUnread ? icons.mailOpen : icons.markUnread}</button>
      <button class="icon-btn" data-bulk="star" data-i18n-title="mailbox.actions.star" title="${esc(t('mailbox.actions.star'))}">${icons.star}</button>
      <button class="icon-btn" data-bulk="move" data-i18n-title="mailbox.actions.moveShortcut" title="${esc(t('mailbox.actions.moveShortcut'))}">${icons.move}</button>
      ${canArchive ? `<button class="icon-btn" data-bulk="archive" data-i18n-title="common.actions.archive" title="${esc(t('common.actions.archive'))}">${icons.archive}</button>` : ''}
      <button class="icon-btn" data-bulk="delete" data-i18n-title="mailbox.actions.deleteShortcut" title="${esc(t('mailbox.actions.deleteShortcut'))}">${icons.trash}</button>
      <button class="icon-btn" data-bulk="clear" data-i18n-title="mailbox.selection.clearShortcut" title="${esc(t('mailbox.selection.clearShortcut'))}">${icons.close}</button>`;
    return;
  }
  tools.className = 'list-tools';
  const n = (id) => {
    if (id === 'unread') return S.list.filter((m) => m.unread).length;
    if (id === 'starred') return S.list.filter((m) => m.starred).length;
    if (id === 'attachments') return S.list.filter((m) => m.hasAttachments).length;
    return 0;
  };
  tools.innerHTML = `<div class="filters" role="tablist" data-i18n-aria-label="mailbox.filters.label" aria-label="${esc(t('mailbox.filters.label'))}">${FILTERS.map((f) => {
    const c = n(f.id);
    return `<button class="filter ${S.filter === f.id ? 'active' : ''}" role="tab" aria-selected="${S.filter === f.id}" data-filter="${f.id}">${esc(f.label)}${c ? `<span class="n">${c}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

function renderList() {
  // Re-rendering mid-drag would detach the row being swiped; render once the gesture ends.
  if (swipeState.el) {
    swipeState.renderPending = true;
    return;
  }
  renderShell();
  renderListHead();
  renderListTools();
  const scroll = $('.list-scroll');
  scroll.innerHTML = listHtml();
  renderShell();
}

// Three or more messages in a row from one sender, on the same day, fold into one row.
function stackKey(m) {
  if (m.role === 'sent' || m.role === 'drafts') return null;
  return ((m.from && m.from.address) || '').toLowerCase() || null;
}

function stackLayout() {
  const list = rows();
  const out = { heads: new Map(), hidden: new Set(), members: new Set() };
  const byDate = S.data.settings.sort === 'date-desc' || S.data.settings.sort === 'date-asc';
  if (!byDate || S.query.trim()) return out;
  for (let i = 0; i < list.length; ) {
    const key = stackKey(list[i]);
    const day = groupLabel(list[i].date);
    let j = i + 1;
    if (key) while (j < list.length && stackKey(list[j]) === key && groupLabel(list[j].date) === day) j++;
    const rest = list.slice(i + 1, j);
    if (key && rest.length >= 2) {
      const id = `${day}|${key}`;
      // A selected message inside a stack keeps it open, so the selection never hides.
      const forced = rest.some((m) => m.id === S.selectedId || S.checked.has(m.id));
      const open = forced || S.openStacks.has(id);
      out.heads.set(list[i].id, { id, count: rest.length + 1, open, forced, unread: rest.some((m) => m.unread) });
      for (const m of rest) (open ? out.members : out.hidden).add(m.id);
    }
    i = j;
  }
  return out;
}

// The rows on screen, in order: the list without the folded stack members.
function visibleRows() {
  const { hidden } = stackLayout();
  return rows().filter((m) => !hidden.has(m.id));
}

function listHtml() {
  const list = rows();
  if (!list.length) {
    const scoped = scopedAccounts();
    const syncing = scoped.some((a) => a.syncing);
    const failed = scoped.find((a) => a.error);
    let msg = t('mailbox.empty.folder');
    let hint = '';
    if (S.query.trim()) {
      msg = t('mailbox.empty.search');
      hint = S.searchScope === 'view' ? t('mailbox.empty.searchAll') : t('mailbox.empty.searchOther');
    } else if (S.filter !== 'all') {
      msg = t('mailbox.empty.filter');
      hint = `<button class="link-btn" data-filter="all" data-i18n="mailbox.empty.showAll">${esc(t('mailbox.empty.showAll'))}</button>`;
    } else if (syncing) msg = t('mailbox.empty.syncing');
    const error = failed && !syncing ? `<p class="error">${esc(failed.email)}: ${esc(failed.error)}</p>` : '';
    const searchAll =
      S.query.trim() && S.searchScope === 'view' ? `<button class="btn secondary sm" data-action="search-everywhere" data-i18n="mailbox.empty.searchAllAction">${esc(t('mailbox.empty.searchAllAction'))}</button>` : '';
    return `<div class="empty">${icons.mailOpen}<div class="t">${msg}</div>${hint && !hint.startsWith('<') ? `<div class="h">${hint}</div>` : hint}${searchAll}${error}</div>`;
  }
  const byDate = S.data.settings.sort === 'date-desc' || S.data.settings.sort === 'date-asc';
  const opts = {
    multi: S.data.accounts.length > 1 && (S.scope === 'all' || searchingAll()),
    showFolder: searchingAll() || S.view === 'starred'
  };
  const layout = stackLayout();
  let out = '';
  let label = null;
  for (const m of list) {
    if (layout.hidden.has(m.id)) continue;
    const l = byDate ? groupLabel(m.date) : null;
    if (l !== label) {
      label = l;
      if (l) out += `<div class="group-head" role="presentation">${esc(l)}</div>`;
    }
    out += itemHtml(m, { ...opts, stack: layout.heads.get(m.id), stacked: layout.members.has(m.id) });
  }
  wantLogos(list);
  return out;
}

function itemHtml(m, { multi, showFolder, stack, stacked }) {
  const acc = multi && account(m.accountId);
  const draft = m.role === 'drafts';
  const pills = [
    m.vip ? `<span class="pill vip" data-i18n="mailbox.message.vip">${esc(t('mailbox.message.vip'))}</span>` : '',
    showFolder ? `<span class="pill">${esc(folderName(m))}</span>` : '',
    acc ? `<span class="pill acc" style="--acc:${esc(acc.color)}" title="${esc(acc.email)}">${esc(accountLabel(acc))}</span>` : ''
  ].join('');
  const swipe = S.data.settings.swipeActions
    ? `<div class="swipe-bg read">${icons.mailOpen}<span>${m.unread ? t('mailbox.message.read') : t('mailbox.filters.unread')}</span></div>
       <div class="swipe-bg delete"><span data-i18n="common.actions.clear">${esc(t('common.actions.clear'))}</span>${icons.trash}</div>`
    : '';
  const selected = S.selectedId === m.id;
  const checked = S.checked.has(m.id);
  const atCursor = (S.cursorId || S.selectedId) === m.id;
  const who = m.role === 'sent' || draft ? (m.to || [])[0] : m.from;
  const preview = cleanPreview(m.preview);
  const stackBtn = stack
    ? stack.open
      ? stack.forced
        ? ''
        : `<button class="stack-btn open" data-stack="${esc(stack.id)}" tabindex="-1" data-i18n-title="mailbox.message.collapse" title="${esc(t('mailbox.message.collapse'))}" aria-expanded="true">${icons.up}</button>`
      : `<button class="stack-btn ${stack.unread ? 'unread' : ''}" data-stack="${esc(stack.id)}" tabindex="-1" title="${esc(t('mailbox.message.stack', { count: stack.count - 1, sender: person(m.from) }))}" aria-expanded="false">+${stack.count - 1}</button>`
    : '';
  return `<div class="item-wrap ${stacked ? 'stacked' : ''}" data-id="${esc(m.id)}">${swipe}
    <div class="item ${m.unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${checked ? 'checked' : ''} ${atCursor ? 'cursor' : ''} ${stack && !stack.open ? 'folded' : ''}" data-id="${esc(m.id)}" role="option" aria-selected="${selected || checked}" draggable="true">
      <span class="unread-dot" aria-hidden="true"></span>
      <div class="lead">${senderAvatar(who)}<button class="check ${checked ? 'on' : ''}" data-check role="checkbox" aria-checked="${checked}" data-i18n-aria-label="mailbox.message.select" aria-label="${esc(t('mailbox.message.select'))}" tabindex="-1">${icons.check}</button></div>
      <div class="body">
        <div class="line1">
          <span class="sender">${draft ? `<span class="draft-tag" data-i18n="composer.titles.draft">${esc(t('composer.titles.draft'))}</span>` : ''}${esc(senderLine(m))}</span>
          ${stackBtn}
          <span class="meta">${m.answered ? `<span class="ic-ans" data-i18n-title="mailbox.message.replied" title="${esc(t('mailbox.message.replied'))}">${icons.reply}</span>` : ''}${m.hasAttachments ? `<span class="ic-att" data-i18n-title="mailbox.message.attachment" title="${esc(t('mailbox.message.attachment'))}">${icons.clip}</span>` : ''}<time>${listTime(m.date)}</time></span>
        </div>
        <div class="line2">
          <span class="subject">${esc(m.subject || t('mailbox.message.noSubject'))}</span><span class="sep"> - </span><span class="preview-inline">${esc(preview)}</span>
          <span class="flags">${pills}${
            m.role === 'saved'
              ? ''
              : `<button class="star-btn ${m.starred ? 'on' : ''}" data-star tabindex="-1" title="${m.starred ? t('mailbox.actions.unstar') : t('mailbox.actions.addStar')}">${m.starred ? icons.starFilled : icons.star}</button>`
          }</span>
        </div>
        <div class="preview">${esc(preview)}</div>
      </div>
    </div>
  </div>`;
}

// ---------- sender logos ----------

// address -> data url, or null when there is none (people, or nothing found).
const logos = new Map();
const logoQueue = new Set();
let logoTimer = null;

function senderAvatar(who, cls = '') {
  const address = ((who && who.address) || '').toLowerCase();
  const logo = address && logos.get(address);
  if (logo) return `<span class="avatar logo ${cls}" data-addr="${esc(address)}" aria-hidden="true"><img src="${logo}" alt=""></span>`;
  return avatar(who || { name: '?' }, cls).replace('<span class="avatar', `<span data-addr="${esc(address)}" class="avatar`);
}

function wantLogos(list) {
  if (S.data.settings.senderLogos === false) return;
  for (const m of list) {
    const who = m.role === 'sent' || m.role === 'drafts' ? (m.to || [])[0] : m.from;
    const address = ((who && who.address) || '').toLowerCase();
    if (address && !logos.has(address)) logoQueue.add(address);
  }
  if (logoQueue.size && !logoTimer) logoTimer = setTimeout(fetchLogos, 30);
}

// One request per sender, so a slow site does not hold up the others; each logo appears when it arrives.
function fetchLogos() {
  logoTimer = null;
  for (const address of logoQueue) {
    logoQueue.delete(address);
    logos.set(address, null);
    api('senderLogos', [address])
      .then((found) => {
        const url = found && found[address];
        if (!url) return;
        logos.set(address, url);
        for (const el of $$(`.avatar[data-addr="${CSS.escape(address)}"]:not(.logo)`)) {
          el.classList.add('logo');
          el.innerHTML = `<img src="${url}" alt="">`;
        }
      })
      .catch(() => {});
  }
}

function syncRowClasses() {
  // A selection inside a folded stack unfolds it.
  if (S.selectedId && !$(`.list-scroll .item[data-id="${CSS.escape(S.selectedId)}"]`) && rows().some((m) => m.id === S.selectedId)) {
    const scroll = $('.list-scroll');
    const top = scroll ? scroll.scrollTop : 0;
    scroll.innerHTML = listHtml();
    scroll.scrollTop = top;
  }
  const at = cursor();
  for (const el of $$('.list-scroll .item')) {
    const id = el.dataset.id;
    const selected = id === S.selectedId;
    const checked = S.checked.has(id);
    el.classList.toggle('selected', selected);
    el.classList.toggle('checked', checked);
    el.classList.toggle('cursor', id === at);
    el.setAttribute('aria-selected', String(selected || checked));
    const box = el.querySelector('.check');
    box?.classList.toggle('on', checked);
    box?.setAttribute('aria-checked', String(checked));
  }
}

function revealRow(id) {
  $(`.list-scroll .item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function selectionChanged() {
  syncRowClasses();
  renderListTools();
  renderShell();
  // The reader shows the selection while it holds several messages, and the open message otherwise.
  if (S.checked.size > 1 || $('.reader .multi')) renderReader();
}

function toggleCheck(id) {
  // The first Ctrl+click keeps the open message in the selection, like Explorer and Outlook.
  if (!S.checked.size && S.selectedId && S.selectedId !== id && rows().some((m) => m.id === S.selectedId)) S.checked.add(S.selectedId);
  if (S.checked.has(id)) S.checked.delete(id);
  else S.checked.add(id);
  S.anchorId = id;
  S.cursorId = id;
  selectionChanged();
}

function checkRange(toId) {
  const list = visibleRows();
  const from = list.findIndex((m) => m.id === (S.anchorId || S.selectedId));
  const to = list.findIndex((m) => m.id === toId);
  if (to < 0) return;
  const [a, b] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
  S.checked = new Set(list.slice(a, b + 1).map((m) => m.id));
  S.cursorId = toId;
  selectionChanged();
}

function clearChecks() {
  if (!S.checked.size) return false;
  S.checked.clear();
  S.cursorId = S.selectedId;
  selectionChanged();
  return true;
}

function bindList() {
  const pane = $('.listpane');
  const scroll = $('.list-scroll');
  pane.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && btn.dataset.action) return listAction(btn.dataset.action, btn);
    if (btn && btn.dataset.filter) {
      S.filter = btn.dataset.filter;
      return renderList();
    }
    if (btn && btn.dataset.bulk) return bulkAction(btn.dataset.bulk, btn);
    if (btn && btn.dataset.stack) {
      const id = btn.dataset.stack;
      if (S.openStacks.has(id)) S.openStacks.delete(id);
      else S.openStacks.add(id);
      return renderList();
    }
    const item = e.target.closest('.item');
    if (!item || swipeState.moved) return;
    const id = item.dataset.id;
    if (btn && btn.hasAttribute('data-star')) {
      const m = byId(id);
      if (m) setStarred([m], !m.starred);
      return;
    }
    if (btn && btn.hasAttribute('data-check')) return toggleCheck(id);
    if (e.ctrlKey || e.metaKey) return toggleCheck(id);
    if (e.shiftKey) return checkRange(id);
    if (S.checked.size) {
      S.checked.clear();
      selectionChanged();
    }
    S.anchorId = id;
    openMessage(id);
  });
  pane.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.item');
    if (!item || e.target.closest('button')) return;
    const m = byId(item.dataset.id);
    if (m && m.role === 'drafts') compose({ mode: 'draft', id: m.id });
  });
  pane.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    e.preventDefault();
    const id = item.dataset.id;
    if (S.checked.size > 1 && S.checked.has(id)) return showMenu(null, bulkMenu(checkedMessages()), { at: { x: e.clientX, y: e.clientY } });
    const m = byId(id);
    if (m) showMenu(null, messageMenu(m), { at: { x: e.clientX, y: e.clientY } });
  });
  pane.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const id = item.dataset.id;
    const ids = S.checked.has(id) ? [...S.checked] : [id];
    e.dataTransfer.setData('application/x-rukoo-ids', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = ids.length === 1 ? (byId(id)?.subject || t('mailbox.drag.one')).slice(0, 60) : t('mailbox.drag.messages', { count: ids.length });
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, -12, -8);
    setTimeout(() => ghost.remove(), 0);
    document.body.classList.add('dragging-mail');
  });
  pane.addEventListener('dragend', () => {
    document.body.classList.remove('dragging-mail');
    $$('.nav-item.drop-target').forEach((x) => x.classList.remove('drop-target'));
  });
  scroll.addEventListener('pointerdown', () => scroll.classList.remove('kbd'));
  bindSwipe(pane);
}

function listAction(action, btn) {
  switch (action) {
    case 'sync':
      return syncNow();
    case 'search-clear':
      return clearSearch();
    case 'search-everywhere':
      S.searchScope = S.data.accounts.length > 1 && S.scope !== 'all' ? 'account' : 'all';
      return refresh();
    case 'check-all': {
      const list = rows();
      const all = list.every((m) => S.checked.has(m.id));
      S.checked = all ? new Set() : new Set(list.map((m) => m.id));
      return selectionChanged();
    }
    case 'list-more': {
      const compact = S.data.settings.density === 'compact';
      return showMenu(btn, [
        { icon: 'mailOpen', get label() { return t('mailbox.actions.readAll'); }, action: markAllRead },
        { icon: 'sync', get label() { return t('mailbox.actions.sync'); }, shortcut: 'F5', action: syncNow },
        { separator: true },
        { get label() { return t('mailbox.actions.compact'); }, checked: compact, action: () => setDensity(compact ? 'standard' : 'compact') },
        { icon: 'chevronUpDown', get label() { return t('mailbox.sort.menu'); }, action: chooseSort },
        S.view === 'trash' || S.view === 'junk' ? { separator: true } : null,
        S.view === 'trash' || S.view === 'junk' ? { icon: 'trash', label: t('mailbox.emptyFolder.action', { folder: viewLabel() }), action: emptyCurrent, danger: true } : null,
        { separator: true },
        { icon: 'settings', get label() { return t('settings.title.short'); }, action: () => openSettings(ctx) }
      ]);
    }
  }
}

async function setDensity(density) {
  await api('updateSettings', { density });
  refresh();
}

async function markAllRead() {
  const n = await api('markAllRead', S.scope, S.view, S.folder);
  toast(n ? t('mailbox.actions.readCount', { count: n }) : t('mailbox.actions.alreadyRead'));
}

export async function syncNow() {
  toast(t('mailbox.sync.syncing'));
  try {
    await api('sync', S.scope === 'all' ? null : S.scope);
    toast(t('mailbox.sync.done'));
  } catch (err) {
    toast(err.message, 5000);
  }
}

async function chooseSort() {
  const v = await choiceDialog(
    t('mailbox.sort.title'),
    [
      { get label() { return t('mailbox.sort.newest'); }, value: 'date-desc' },
      { get label() { return t('mailbox.sort.oldest'); }, value: 'date-asc' },
      { get label() { return t('mailbox.sort.unread'); }, value: 'unread' },
      { get label() { return t('mailbox.sort.sender'); }, value: 'sender' }
    ],
    S.data.settings.sort
  );
  if (v) {
    await api('updateSettings', { sort: v });
    refresh();
  }
}

async function emptyCurrent() {
  const accounts = scopedAccounts();
  const what =
    S.view === 'trash'
      ? t('mailbox.emptyFolder.permanent')
      : t('mailbox.emptyFolder.trash');
  const ok = await confirmDialog(t('mailbox.emptyFolder.title', { folder: viewLabel() }), what, t('mailbox.emptyFolder.confirm'), true);
  if (!ok) return;
  let n = 0;
  for (const a of accounts) {
    const f = a.folders.find((x) => x.role === S.view);
    if (f) n += await api('emptyFolder', a.id, f.path);
  }
  toast(t('mailbox.delete.deletedCount', { count: n }));
}

// ---------- swipe (touch and pen only; a mouse drags messages to folders) ----------

const swipeState = { el: null, startX: 0, startY: 0, dx: 0, moved: false, id: null };
const SWIPE_TRIGGER = 110;

function bindSwipe(pane) {
  pane.addEventListener('pointerdown', (e) => {
    if (!S.data?.settings.swipeActions || e.pointerType === 'mouse' || e.button !== 0) return;
    const item = e.target.closest('.item');
    if (!item || e.target.closest('button')) return;
    Object.assign(swipeState, { el: item, startX: e.clientX, startY: e.clientY, dx: 0, moved: false, id: item.dataset.id, pointer: e.pointerId });
  });
  pane.addEventListener('pointermove', (e) => {
    const st = swipeState;
    if (!st.el || e.pointerId !== st.pointer) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (!st.moved) {
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      st.moved = true;
      try {
        st.el.setPointerCapture(e.pointerId);
      } catch (_) {
        // Pointer already released; the move still works without capture.
      }
      st.el.style.transition = 'none';
    }
    st.dx = dx;
    st.el.style.transform = `translateX(${dx}px)`;
    const wrap = st.el.parentElement;
    const strength = Math.min(1, Math.abs(dx) / SWIPE_TRIGGER);
    const read = wrap.querySelector('.swipe-bg.read');
    const del = wrap.querySelector('.swipe-bg.delete');
    if (read) read.style.opacity = dx > 0 ? strength : 0;
    if (del) del.style.opacity = dx < 0 ? strength : 0;
  });
  const end = (e) => {
    const st = swipeState;
    if (!st.el || e.pointerId !== st.pointer) return;
    const { el, dx, id, moved } = st;
    st.el = null;
    const flush = () => {
      if (st.renderPending) {
        st.renderPending = false;
        renderList();
      }
    };
    if (!moved) return flush();
    el.style.transition = 'transform 200ms cubic-bezier(0.2,0.8,0.2,1)';
    const m = byId(id);
    if (dx <= -SWIPE_TRIGGER && m) {
      el.style.transform = 'translateX(-110%)';
      setTimeout(() => removeMessages([m]), 160);
    } else {
      el.style.transform = '';
      el.parentElement.querySelectorAll('.swipe-bg').forEach((b) => (b.style.opacity = 0));
      if (dx >= SWIPE_TRIGGER && m && m.role !== 'saved') setUnread([m], !m.unread);
    }
    flush();
    // Swallow the click that follows a drag.
    setTimeout(() => (st.moved = false), 0);
  };
  // Listen on window: a drag released over the reader must still end the swipe.
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

// ---------- divider ----------

function bindDivider() {
  const div = $('.divider');
  const set = (w) => {
    prefs.listWidth = Math.round(w);
    root.style.setProperty('--list-w', `${listWidth()}px`);
  };
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    div.classList.add('dragging');
    const left = $('.listpane').getBoundingClientRect().left;
    const move = (ev) => set(ev.clientX - left);
    const up = () => {
      div.classList.remove('dragging');
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
      prefs.listWidth = listWidth();
      savePrefs();
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
  });
  div.addEventListener('dblclick', () => {
    set(400);
    savePrefs();
  });
  div.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    set(listWidth() + (e.key === 'ArrowRight' ? 24 : -24));
    savePrefs();
  });
}

// ---------- actions ----------

async function setUnread(list, unread) {
  list = list.filter((m) => m.role !== 'saved');
  for (const m of list) m.unread = unread;
  renderList();
  for (const m of list) await api('setFlags', m.id, { unread }).catch((err) => toast(err.message));
}

async function setStarred(list, starred) {
  list = list.filter((m) => m.role !== 'saved');
  for (const m of list) {
    m.starred = starred;
    if (S.message && S.message.id === m.id) S.message.starred = starred;
  }
  renderList();
  if (S.message && list.some((m) => m.id === S.message.id)) renderReader();
  for (const m of list) await api('setFlags', m.id, { starred }).catch((err) => toast(err.message));
}

// Takes messages out of the list right away and opens the next one if the open message left.
function detach(list) {
  const ids = new Set(list.map((m) => m.id));
  const visible = visibleRows();
  let next = null;
  const wasOpen = ids.has(S.selectedId);
  if (wasOpen) {
    const i = visible.findIndex((x) => x.id === S.selectedId);
    next = visible.slice(i + 1).find((x) => !ids.has(x.id)) || visible.slice(0, Math.max(0, i)).reverse().find((x) => !ids.has(x.id)) || null;
  }
  S.list = S.list.filter((x) => !ids.has(x.id));
  for (const id of ids) S.checked.delete(id);
  if (wasOpen) {
    if (next) openMessage(next.id);
    else closeReader();
  }
  renderList();
  if (!wasOpen && S.checked.size < 2 && $('.reader .multi')) renderReader();
  return wasOpen;
}

async function offerUndo(ids, message, reopen) {
  const can = await Promise.all(ids.map((id) => api('canUndo', id).catch(() => false)));
  const undoable = ids.filter((_, i) => can[i]);
  if (!undoable.length) return toast(message);
  toast(message, { action: { get label() { return t('common.actions.undo'); }, run: () => undoMoves(undoable, reopen) } });
}

async function undoMoves(ids, reopen) {
  const restored = [];
  for (const id of ids) {
    try {
      restored.push(await api('undoMove', id));
    } catch (err) {
      toast(err.message, 5000);
    }
  }
  await refresh();
  const back = restored.filter(Boolean);
  if (reopen && back.length === 1) openMessage(back[0]);
  if (back.length) toast(back.length === 1 ? t('mailbox.undo.restored') : t('mailbox.undo.restoredCount', { count: back.length }));
}

export async function removeMessages(list) {
  list = list.filter(Boolean);
  if (!list.length) return;
  const permanent = list.filter((m) => m.role === 'trash' || m.role === 'saved');
  if (permanent.length) {
    const ok = await confirmDialog(
      t('mailbox.delete.title'),
      permanent.length === 1 ? t('mailbox.delete.one') : t('mailbox.delete.permanentCount', { count: permanent.length }),
      t('common.actions.delete'),
      true
    );
    if (!ok) return renderList();
  }
  const reopen = detach(list);
  const moved = [];
  const confirm = [];
  let deleted = 0;
  for (const m of list) {
    try {
      const where = await api('remove', m.id);
      if (where === 'trash') moved.push(m.id);
      else if (where === 'confirm') confirm.push(m);
      else deleted++;
    } catch (err) {
      toast(err.message, 5000);
      refresh();
    }
  }
  if (confirm.length) {
    const ok = await confirmDialog(
      t('mailbox.delete.title'),
      confirm.length === 1
        ? t('mailbox.delete.noTrash')
        : t('mailbox.delete.noTrashCount', { count: confirm.length }),
      t('common.actions.delete'),
      true
    );
    if (!ok) return refresh();
    for (const m of confirm) {
      try {
        await api('remove', m.id, { force: true });
        deleted++;
      } catch (err) {
        toast(err.message, 5000);
      }
    }
  }
  if (moved.length) offerUndo(moved, moved.length === 1 ? t('mailbox.delete.movedOne') : t('mailbox.delete.movedCount', { count: moved.length }), reopen);
  else if (deleted) toast(deleted === 1 ? t('mailbox.delete.deletedOne') : t('mailbox.delete.deletedCount', { count: deleted }));
}

function destination(m, target) {
  const acc = account(m.accountId);
  if (!acc) return null;
  if (target.path) return m.accountId === target.accountId ? target.path : null;
  if (target.role === 'archive') return acc.archive;
  return (acc.folders.find((f) => f.role === target.role) || {}).path || null;
}

async function moveMessages(list, target, label) {
  const plan = list
    .filter((m) => m && m.role !== 'saved')
    .map((m) => ({ m, path: destination(m, target) }))
    .filter((p) => p.path && p.path !== p.m.folder);
  if (!plan.length) return toast(target.role === 'archive' ? t('mailbox.move.noArchive') : t('mailbox.move.alreadyThere'));
  const reopen = detach(plan.map((p) => p.m));
  const moved = [];
  for (const { m, path } of plan) {
    try {
      await api('move', m.id, path);
      moved.push(m.id);
    } catch (err) {
      toast(err.message, 5000);
      refresh();
    }
  }
  if (moved.length) offerUndo(moved, moved.length === 1 ? t('mailbox.move.one', { folder: label }) : t('mailbox.move.count', { count: moved.length, folder: label }), reopen);
}

function archiveMessages(list) {
  return moveMessages(list, { role: 'archive' }, t('mailbox.folders.archive'));
}

async function pickFolder(list) {
  const accountIds = [...new Set(list.map((m) => m.accountId))];
  const here = new Set(list.map((m) => m.folder));
  let options;
  if (accountIds.length === 1) {
    const acc = account(accountIds[0]);
    options = acc.folders
      .filter((f) => f.role !== 'drafts' && f.role !== 'sent' && !(here.size === 1 && here.has(f.path)))
      .map((f) => ({ label: f.name, value: f.role ? { role: f.role, label: f.name } : { path: f.path, accountId: acc.id, label: f.name } }));
  } else {
    options = ['inbox', 'archive', 'junk', 'trash'].map((role) => ({ label: LABELS[role](), value: { role, label: LABELS[role]() } }));
  }
  return choiceDialog(list.length === 1 ? t('mailbox.move.title') : t('mailbox.move.countTitle', { count: list.length }), options, null);
}

async function moveWithPicker(list) {
  list = list.filter((m) => m && m.role !== 'saved');
  if (!list.length) return;
  const target = await pickFolder(list);
  if (!target) return;
  if (target.role === 'trash') return removeMessages(list);
  return moveMessages(list, target, target.label);
}

function bulkAction(action, btn) {
  const list = checkedMessages();
  switch (action) {
    case 'read':
      return setUnread(list, false);
    case 'unread':
      return setUnread(list, true);
    case 'star':
      return setStarred(list, !list.every((m) => m.starred));
    case 'move':
      return moveWithPicker(list);
    case 'archive':
      return archiveMessages(list);
    case 'delete':
      return removeMessages(list);
    case 'clear':
      return clearChecks();
    case 'more':
      return showMenu(btn, bulkMenu(list));
  }
}

function bulkMenu(list) {
  const anyUnread = list.some((m) => m.unread);
  const canArchive = list.some((m) => account(m.accountId)?.archive && m.role !== 'archive');
  return [
    { icon: anyUnread ? 'mailOpen' : 'markUnread', label: anyUnread ? t('mailbox.actions.read') : t('mailbox.actions.unread'), shortcut: anyUnread ? 'Ctrl+Q' : 'Ctrl+U', action: () => setUnread(list, !anyUnread) },
    { icon: 'star', label: list.every((m) => m.starred) ? t('mailbox.actions.unstar') : t('mailbox.actions.addStar'), action: () => setStarred(list, !list.every((m) => m.starred)) },
    { separator: true },
    { icon: 'move', get label() { return t('mailbox.actions.moveMenu'); }, shortcut: 'Ctrl+Shift+V', action: () => moveWithPicker(list) },
    canArchive ? { icon: 'archive', get label() { return t('common.actions.archive'); }, action: () => archiveMessages(list) } : null,
    { separator: true },
    { icon: 'trash', label: t('mailbox.delete.countAction', { count: list.length }), shortcut: 'Delete', action: () => removeMessages(list), danger: true }
  ];
}

function messageMenu(m) {
  const saved = m.role === 'saved';
  const draft = m.role === 'drafts';
  const acc = account(m.accountId);
  const canArchive = Boolean(acc && acc.archive && m.role !== 'archive' && !saved && !draft);
  return [
    draft ? { icon: 'edit', get label() { return t('composer.actions.editDraft'); }, shortcut: 'Enter', action: () => compose({ mode: 'draft', id: m.id }) } : null,
    draft ? null : { icon: 'reply', get label() { return t('composer.titles.reply'); }, shortcut: 'Ctrl+R', action: () => compose({ mode: 'reply', id: m.id }) },
    draft ? null : { icon: 'replyAll', get label() { return t('composer.titles.replyAll'); }, shortcut: 'Ctrl+Shift+R', action: () => compose({ mode: 'replyAll', id: m.id }) },
    draft ? null : { icon: 'forward', get label() { return t('composer.titles.forward'); }, shortcut: 'Ctrl+F', action: () => compose({ mode: 'forward', id: m.id }) },
    { separator: true },
    saved ? null : { icon: m.unread ? 'mailOpen' : 'markUnread', label: m.unread ? t('mailbox.actions.read') : t('mailbox.actions.unread'), shortcut: m.unread ? 'Ctrl+Q' : 'Ctrl+U', action: () => setUnread([m], !m.unread) },
    saved ? null : { icon: 'star', label: m.starred ? t('mailbox.actions.unstar') : t('mailbox.actions.addStar'), action: () => setStarred([m], !m.starred) },
    saved ? null : { icon: 'move', get label() { return t('mailbox.actions.moveMenu'); }, shortcut: 'Ctrl+Shift+V', action: () => moveWithPicker([m]) },
    canArchive ? { icon: 'archive', get label() { return t('common.actions.archive'); }, action: () => archiveMessages([m]) } : null,
    { separator: true },
    {
      icon: 'vip',
      label: m.vip ? t('mailbox.vip.remove') : t('mailbox.vip.add'),
      action: async () => {
        const on = await api('toggleVip', m.from.address);
        toast(on ? t('mailbox.vip.addedSender', { sender: person(m.from) }) : t('mailbox.vip.removedSender', { sender: person(m.from) }));
      }
    },
    saved || m.role === 'sent' || draft
      ? null
      : {
          icon: 'ban',
          get label() { return t('mailbox.spam.add'); },
          action: async () => {
            const ok = await confirmDialog(t('mailbox.spam.confirm'), t('mailbox.spam.confirmHelp', { address: m.from.address }), t('common.actions.add'));
            if (!ok) return;
            if (S.selectedId === m.id) closeReader();
            try {
              await api('markSpam', m.id);
              toast(t('mailbox.spam.added'));
            } catch (err) {
              toast(err.message, 5000);
            }
          }
        },
    saved
      ? null
      : {
          icon: 'saved',
          get label() { return t('mailbox.saved.save'); },
          action: async () => {
            await api('saveToDevice', m.id);
            toast(t('mailbox.saved.saved'));
          }
        },
    {
      icon: 'export',
      get label() { return t('mailbox.export.action'); },
      action: async () => {
        const p = await api('exportEml', m.id).catch((err) => toast(err.message));
        if (p) toast(t('mailbox.export.done'));
      }
    },
    { icon: 'print', get label() { return t('mailbox.actions.print'); }, shortcut: 'Ctrl+P', action: () => printMessage(m.id) },
    { separator: true },
    { icon: 'trash', get label() { return t('common.actions.delete'); }, shortcut: 'Delete', action: () => removeMessages([m]), danger: true }
  ];
}

async function printMessage(id) {
  const full = S.message && S.message.id === id && S.message.html != null ? S.message : await api('get', id);
  const head = `<h2 style="font:600 20px Segoe UI,sans-serif;margin:0 0 8px">${esc(full.subject)}</h2>
    <div style="font:13px Segoe UI,sans-serif;color:#444;margin-bottom:16px">Van: ${esc(formatAddress(full.from))}<br>Aan: ${esc(full.to.map(formatAddress).join(', '))}<br>Datum: ${esc(longDate(full.date))}</div><hr>`;
  await api('print', `<!doctype html><meta charset="utf-8"><body style="margin:24px">${head}${full.html}</body>`);
}

// Writing happens in the reading pane; the pop-out button moves it to a window of its own.
// Each request to write (or to open a message) takes a number; a request that a newer one overtook
// while it waited stops, so a slow reply can never replace the message you started after it.
let composeTurn = 0;

async function compose(opts) {
  if (!S.data || !S.data.accounts.length) return;
  const turn = ++composeTurn;
  if (opts.mode === 'draft' && S.composer && S.composer.draftId === opts.id) return S.composer.focus();
  // A draft that is open in a compose window stays there.
  if (opts.mode === 'draft' && (await api('draftWindow', opts.id).catch(() => false))) return;
  if (turn !== composeTurn) return;
  const accountId = S.scope !== 'all' ? S.scope : null;
  const full = { accountId, ...opts };
  let message = null;
  if (full.id) {
    try {
      message = await api('get', full.id);
    } catch (err) {
      if (turn === composeTurn) toast(err.message, 5000);
      return;
    }
    if (turn !== composeTurn) return;
  }
  // Whatever is being written now is kept as a draft before the new message takes its place.
  if (S.composer && !(await S.composer.leave())) return;
  if (turn !== composeTurn || S.composer) return;
  const host = $('.reader');
  host.innerHTML = '';
  S.expanded = false;
  S.composer = mountComposer(host, {
    data: S.data,
    opts: full,
    message,
    inline: true,
    onDone: () => {
      S.composer = null;
      renderShell();
      renderReader();
    },
    onPopOut: (o) => api('openCompose', { accountId, ...o }).catch((err) => toast(err.message, 5000))
  });
  renderShell();
}

// ---------- reader ----------

// auto: shown without being asked for (the newest message on load); it stays unread.
export async function openMessage(id, { auto = false } = {}) {
  // Opening a message cancels a reply or forward that is still loading.
  const turn = ++composeTurn;
  if (S.composer && !(await S.composer.leave())) return;
  if (turn !== composeTurn) return;
  const m = S.list.find((x) => x.id === id);
  S.selectedId = id;
  S.anchorId = id;
  S.cursorId = id;
  S.details = false;
  S.loading = true;
  S.message = m ? { ...m, html: null, attachments: [] } : S.message;
  syncRowClasses();
  revealRow(id);
  renderShell();
  renderReader();
  try {
    const full = await api('get', id);
    if (S.selectedId !== id) return;
    S.message = full;
  } catch (err) {
    if (S.selectedId !== id) return;
    S.message = { ...(m || {}), error: err.message };
  } finally {
    if (S.selectedId === id) S.loading = false;
  }
  renderReader();
  if (m && m.unread && m.role !== 'drafts' && !auto) setUnread([m], false);
}

export function closeReader() {
  S.selectedId = null;
  S.message = null;
  S.expanded = false;
  renderShell();
  renderReader();
  syncRowClasses();
}

function renderReaderNav() {
  const list = visibleRows();
  const i = list.findIndex((x) => x.id === S.selectedId);
  const up = $('[data-reader="prev"]');
  const down = $('[data-reader="next"]');
  if (up) up.disabled = i <= 0;
  if (down) down.disabled = i < 0 || i >= list.length - 1;
}

function attachmentKind(name) {
  const ext = (String(name).match(/\.([a-z0-9]{1,5})$/i) || [])[1]?.toLowerCase() || '';
  const kinds = {
    pdf: 'pdf',
    doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', txt: 'doc',
    xls: 'sheet', xlsx: 'sheet', csv: 'sheet', ods: 'sheet',
    ppt: 'slides', pptx: 'slides', key: 'slides',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', heic: 'image', svg: 'image',
    zip: 'archive', rar: 'archive', '7z': 'archive', gz: 'archive',
    ics: 'cal', eml: 'mail', msg: 'mail'
  };
  return { ext: ext ? ext.toUpperCase().slice(0, 4) : 'FILE', kind: kinds[ext] || 'other' };
}

function ownAddresses() {
  return new Set(S.data.accounts.flatMap((a) => [a.email, ...a.identities.map((i) => i.address)]).map((x) => String(x).toLowerCase()));
}

// "aan mij, Joris Bakker"; the chevron opens the full header.
function recipientsHtml(m) {
  const own = ownAddresses();
  const all = [...(m.to || []), ...(m.cc || []), ...(m.bcc || [])];
  const names = all.map((a) => (own.has(String(a.address).toLowerCase()) ? t('reader.recipients.me') : person(a)));
  const unique = [...new Set(names)];
  const shown = unique.slice(0, 3).join(', ') + (unique.length > 3 ? t('reader.recipients.others', { count: unique.length - 3 }) : '');
  return `<button class="to-summary" data-reader="details" aria-expanded="${S.details}" title="${esc(t(S.details ? 'reader.details.hide' : 'reader.details.show'))}">${
    all.length ? t('reader.recipients.summary', { recipients: esc(shown) }) : t('reader.recipients.unknown')
  }${icons.chevronDown}</button>`;
}

function detailsHtml(m) {
  if (!S.details) return '';
  const people = (list) =>
    (list || [])
      .map((a) => `<button class="person" data-person="${esc(a.address)}" data-name="${esc(a.name || '')}">${esc(formatAddress(a))}</button>`)
      .join(', ');
  const from = m.from || {};
  const replyTo = (m.replyTo || []).filter((a) => String(a.address).toLowerCase() !== String(from.address || '').toLowerCase());
  const row = (k, v) => (v ? `<span class="k">${k}</span><span class="v">${v}</span>` : '');
  return `<div class="details">
    ${row(t('reader.headers.from'), people([from]))}
    ${row(t('reader.headers.to'), people(m.to))}
    ${row(t('reader.headers.cc'), people(m.cc))}
    ${row(t('reader.headers.bcc'), people(m.bcc))}
    ${row(t('reader.headers.replyTo'), people(replyTo))}
    ${row(t('reader.headers.date'), esc(longDate(m.date)))}
  </div>`;
}

const previews = new Map();

// One attachment is just its card; several get a header with "Alles opslaan". Images show a thumbnail.
function attachmentsHtml(m) {
  const list = m.attachments || [];
  if (!list.length) return '';
  const total = list.reduce((n, a) => n + (a.size || 0), 0);
  const open = list.length === 1 || S.attachmentsOpen;
  const card = (a) => {
    const { ext, kind } = attachmentKind(a.filename);
    const thumb = previews.get(`${m.id}|${a.index}`);
    if (kind === 'image') {
      return `<div class="att image" data-preview="${a.index}">
        <button class="att-open" data-open-att="${a.index}" title="Openen: ${esc(a.filename)}"><span class="thumb">${thumb ? `<img src="${thumb}" alt="">` : `<span class="ftype image">${esc(ext)}</span>`}</span>
        <span class="att-text"><span class="att-name">${esc(a.filename)}</span><span class="att-size">${fileSize(a.size)}</span></span></button>
        <button class="icon-btn sm" data-save-att="${a.index}" data-i18n-title="common.actions.save" title="${esc(t('common.actions.save'))}">${icons.download}</button>
      </div>`;
    }
    return `<div class="att">
      <button class="att-open" data-open-att="${a.index}" title="Openen: ${esc(a.filename)}"><span class="ftype ${kind}">${esc(ext)}</span><span class="att-text"><span class="att-name">${esc(a.filename)}</span><span class="att-size">${fileSize(a.size)}</span></span></button>
      <button class="icon-btn sm" data-save-att="${a.index}" data-i18n-title="common.actions.save" title="${esc(t('common.actions.save'))}">${icons.download}</button>
    </div>`;
  };
  const head =
    list.length > 1
      ? `<div class="atts-head">
          <button class="atts-toggle" data-reader="toggle-atts" aria-expanded="${open}">${icons.chevronDown}<span>${list.length} bijlagen</span><span class="atts-size">${fileSize(total)}</span></button>
          <button class="link-btn" data-reader="save-all">${icons.download}<span data-i18n="reader.attachments.saveAll">${esc(t('reader.attachments.saveAll'))}</span></button>
        </div>`
      : '';
  return `<section class="atts ${open ? '' : 'closed'}" data-i18n-aria-label="mailbox.filters.attachments" aria-label="${esc(t('mailbox.filters.attachments'))}">${head}${open ? `<div class="atts-list">${list.map(card).join('')}</div>` : ''}</section>`;
}

async function loadPreviews(m) {
  for (const a of m.attachments || []) {
    const key = `${m.id}|${a.index}`;
    if (attachmentKind(a.filename).kind !== 'image' || previews.has(key)) continue;
    previews.set(key, null);
    const url = await api('attachmentPreview', m.id, a.index).catch(() => null);
    previews.set(key, url);
    const el = url && S.message && S.message.id === m.id && $(`.att.image[data-preview="${a.index}"] .thumb`);
    if (el) el.innerHTML = `<img src="${url}" alt="">`;
  }
}

function readerBar(m) {
  const draft = m.role === 'drafts';
  const saved = m.role === 'saved';
  const acc = account(m.accountId);
  const canArchive = Boolean(acc && acc.archive && m.role !== 'archive' && !saved && !draft);
  const nav = `<span class="bar-subject" aria-hidden="true">${esc(m.subject || '')}</span>
    <span class="spacer"></span>
    <button class="icon-btn" data-reader="prev" data-i18n-title="reader.navigation.previous" title="${esc(t('reader.navigation.previous'))}">${icons.up}</button>
    <button class="icon-btn" data-reader="next" data-i18n-title="reader.navigation.next" title="${esc(t('reader.navigation.next'))}">${icons.down}</button>
    <button class="icon-btn wide-only" data-reader="expand" title="${S.expanded ? t('reader.navigation.showList') : t('reader.navigation.expand')}">${S.expanded ? icons.collapse : icons.expand}</button>`;
  const back = `<button class="icon-btn narrow-only" data-reader="back" data-i18n-title="reader.navigation.back" title="${esc(t('reader.navigation.back'))}">${icons.back}</button>`;
  if (draft) {
    return `<div class="reader-bar" role="toolbar" data-i18n-aria-label="reader.actions.label" aria-label="${esc(t('reader.actions.label'))}">${back}
      <button class="tbtn primary" data-reader="edit" data-i18n-title="reader.actions.editDraftShortcut" title="${esc(t('reader.actions.editDraftShortcut'))}">${icons.edit}<span data-i18n="reader.actions.edit">${esc(t('reader.actions.edit'))}</span></button>
      <button class="icon-btn" data-reader="delete" data-i18n-title="mailbox.actions.deleteShortcut" title="${esc(t('mailbox.actions.deleteShortcut'))}">${icons.trash}</button>
      ${nav}</div>`;
  }
  return `<div class="reader-bar" role="toolbar" data-i18n-aria-label="reader.actions.label" aria-label="${esc(t('reader.actions.label'))}">${back}
    <button class="tbtn" data-reader="reply" data-i18n-title="reader.actions.replyShortcut" title="${esc(t('reader.actions.replyShortcut'))}">${icons.reply}<span data-i18n="composer.titles.reply">${esc(t('composer.titles.reply'))}</span></button>
    <button class="icon-btn" data-reader="replyAll" data-i18n-title="reader.actions.replyAllShortcut" title="${esc(t('reader.actions.replyAllShortcut'))}">${icons.replyAll}</button>
    <button class="icon-btn" data-reader="forward" data-i18n-title="reader.actions.forwardShortcut" title="${esc(t('reader.actions.forwardShortcut'))}">${icons.forward}</button>
    <span class="bar-sep"></span>
    ${canArchive ? `<button class="icon-btn" data-reader="archive" data-i18n-title="common.actions.archive" title="${esc(t('common.actions.archive'))}">${icons.archive}</button>` : ''}
    <button class="icon-btn" data-reader="delete" data-i18n-title="mailbox.actions.deleteShortcut" title="${esc(t('mailbox.actions.deleteShortcut'))}">${icons.trash}</button>
    ${saved ? '' : `<button class="icon-btn" data-reader="move" data-i18n-title="mailbox.actions.moveShortcut" title="${esc(t('mailbox.actions.moveShortcut'))}">${icons.move}</button>`}
    ${saved ? '' : `<button class="icon-btn" data-reader="unread" data-i18n-title="mailbox.actions.unreadShortcut" title="${esc(t('mailbox.actions.unreadShortcut'))}">${icons.markUnread}</button>`}
    <button class="icon-btn" data-reader="more" data-i18n-title="reader.actions.more" title="${esc(t('reader.actions.more'))}" aria-haspopup="menu">${icons.more}</button>
    ${nav}</div>`;
}

function renderReader() {
  const el = $('.reader');
  if (!el || S.composer) return;
  el.classList.remove('scrolled');
  if (S.checked.size > 1) {
    const list = checkedMessages();
    const canArchive = list.some((m) => account(m.accountId)?.archive && m.role !== 'archive');
    el.innerHTML = `<div class="reader-empty multi">
      <div class="stack" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="t">${esc(t('mailbox.selection.summary', { count: list.length }))}</div>
      <div class="multi-actions">
        <button class="tbtn" data-bulk="${list.some((m) => m.unread) ? 'read' : 'unread'}">${list.some((m) => m.unread) ? icons.mailOpen : icons.markUnread}<span>${list.some((m) => m.unread) ? t('mailbox.message.read') : t('mailbox.filters.unread')}</span></button>
        <button class="tbtn" data-bulk="move">${icons.move}<span data-i18n="common.actions.move">${esc(t('common.actions.move'))}</span></button>
        ${canArchive ? `<button class="tbtn" data-bulk="archive">${icons.archive}<span data-i18n="common.actions.archive">${esc(t('common.actions.archive'))}</span></button>` : ''}
        <button class="tbtn danger" data-bulk="delete">${icons.trash}<span data-i18n="common.actions.delete">${esc(t('common.actions.delete'))}</span></button>
      </div>
      <button class="link-btn" data-bulk="clear" data-i18n="mailbox.selection.clear">${esc(t('mailbox.selection.clear'))}</button>
    </div>`;
    return;
  }
  const m = S.message;
  if (!m) {
    el.innerHTML = `<div class="reader-empty">
      ${icons.mailOpen}
      <div class="t" data-i18n="reader.empty.title">${esc(t('reader.empty.title'))}</div>
      <div class="keys"><span><kbd>Ctrl+N</kbd> ${esc(t('composer.titles.new'))}</span><span><kbd>Ctrl+E</kbd> ${esc(t('mailbox.search.label'))}</span><span><kbd>↑</kbd><kbd>↓</kbd> ${esc(t('reader.empty.browse'))}</span></div>
    </div>`;
    return;
  }
  const draft = m.role === 'drafts';
  const from = m.from || {};
  const body = m.error
    ? `<p class="error">${esc(m.error)}</p>`
    : S.loading || m.html === null || m.html === undefined
      ? '<div class="loading-bar"></div>'
      : `<iframe class="mail-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" data-i18n-title="reader.content.label" title="${esc(t('reader.content.label'))}"></iframe>`;
  const unsubscribe =
    m.unsubscribe && !draft ? `<button class="chip-btn" data-reader="unsubscribe" data-i18n-title="reader.unsubscribe.tooltip" title="${esc(t('reader.unsubscribe.tooltip'))}">${icons.unsubscribe}<span data-i18n="reader.unsubscribe.action">${esc(t('reader.unsubscribe.action'))}</span></button>` : '';
  el.innerHTML = `${readerBar(m)}
    <div class="reader-scroll" tabindex="-1">
      <article class="message">
        <header class="msg-head">
          <div class="subject-row">
            <h2 class="reader-subject">${esc(m.subject || t('mailbox.message.noSubject'))}</h2>
            ${m.role === 'saved' || draft ? '' : `<button class="icon-btn reader-star ${m.starred ? 'on' : ''}" data-reader="star" title="${m.starred ? t('mailbox.actions.unstar') : t('mailbox.actions.addStar')}">${m.starred ? icons.starFilled : icons.star}</button>`}
          </div>
          <div class="msg-from">
            ${senderAvatar(draft ? (m.to || [])[0] || from : from, 'lg')}
            <div class="who">
              <div class="from-line">${
                draft
                  ? `<span class="draft-tag" data-i18n="composer.titles.draft">${esc(t('composer.titles.draft'))}</span>`
                  : `<button class="person from-name" data-person="${esc(from.address || '')}" data-name="${esc(from.name || '')}" title="${esc(from.address || '')}">${esc(person(from) || '(Onbekende afzender)')}</button>${
                      from.name ? `<span class="addr">${esc(from.address)}</span>` : ''
                    }${m.vip ? `<span class="pill vip" data-i18n="mailbox.message.vip">${esc(t('mailbox.message.vip'))}</span>` : ''}`
              }</div>
              ${recipientsHtml(m)}
            </div>
            <div class="msg-side">${unsubscribe}<time class="reader-date" title="${esc(longDate(m.date))}">${esc(readerDate(m.date))}</time></div>
          </div>
          ${detailsHtml(m)}
        </header>
        ${attachmentsHtml(m)}
        ${body}
      </article>
    </div>`;
  renderReaderNav();
  const scroll = el.querySelector('.reader-scroll');
  scroll.addEventListener('scroll', () => el.classList.toggle('scrolled', scroll.scrollTop > 56), { passive: true });
  const frame = el.querySelector('.mail-frame');
  if (frame && m.html !== null && m.html !== undefined) {
    const s = S.data?.settings || {};
    fillFrame(frame, m, { light: isLight(), darkEmails: s.darkEmails !== false, fitContent: s.fitContent !== false });
  }
  if (!S.loading) loadPreviews(m);
  wantLogos([m]);
}

async function unsubscribe(m) {
  const sender = person(m.from) || t('reader.unsubscribe.unknownSender');
  const ok = await confirmDialog(
    t('reader.unsubscribe.title', { sender: sender }),
    m.unsubscribe.oneClick || m.unsubscribe.url
      ? t('reader.unsubscribe.linkHelp')
      : t('reader.unsubscribe.mailHelp'),
    t('reader.unsubscribe.action')
  );
  if (!ok) return;
  try {
    const res = await api('unsubscribe', m.id);
    if (res.done) toast(t('reader.unsubscribe.done', { sender: sender }));
    else if (res.opened) toast(t('reader.unsubscribe.opened'));
    else if (res.mailto) {
      const u = new URL(res.mailto);
      compose({
        mode: 'new',
        to: decodeURIComponent(u.pathname).split(',').filter(Boolean).map((address) => ({ name: '', address: address.trim() })),
        subject: u.searchParams.get('subject') || t('reader.unsubscribe.subject'),
        body: u.searchParams.get('body') || ''
      });
    }
  } catch (err) {
    toast(err.message, 5000);
  }
}

function personMenu(btn) {
  const address = btn.dataset.person;
  if (!address) return;
  const name = btn.dataset.name;
  const vip = (S.data.settings.vips || []).includes(address.toLowerCase());
  showMenu(
    btn,
    [
      { heading: name ? `${name} <${address}>` : address },
      { icon: 'compose', get label() { return t('composer.titles.new'); }, action: () => compose({ mode: 'new', to: [{ name, address }] }) },
      {
        icon: 'link',
        get label() { return t('reader.address.copy'); },
        action: async () => {
          await navigator.clipboard.writeText(address).catch(() => {});
          toast(t('reader.address.copied'));
        }
      },
      {
        icon: 'vip',
        label: vip ? t('mailbox.vip.remove') : t('mailbox.vip.add'),
        action: async () => {
          const on = await api('toggleVip', address);
          toast(on ? t('mailbox.vip.added') : t('mailbox.vip.removed'));
        }
      }
    ],
    { align: 'left' }
  );
}

function bindReader() {
  $('.reader').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.bulk) return bulkAction(btn.dataset.bulk, btn);
    const m = S.message;
    if (!m) return;
    const item = byId(m.id) || m;
    if (btn.dataset.person !== undefined) return personMenu(btn);
    if (btn.dataset.openAtt) return api('openAttachment', m.id, Number(btn.dataset.openAtt)).catch((err) => toast(err.message));
    if (btn.dataset.saveAtt) {
      const p = await api('saveAttachment', m.id, Number(btn.dataset.saveAtt)).catch((err) => toast(err.message));
      if (p) toast(t('reader.attachments.savedOne'));
      return;
    }
    switch (btn.dataset.reader) {
      case 'back':
        return closeReader();
      case 'expand':
        S.expanded = !S.expanded;
        renderShell();
        return renderReader();
      case 'prev':
      case 'next':
        return step(btn.dataset.reader === 'next' ? 1 : -1);
      case 'star':
        return setStarred([item], !item.starred);
      case 'unread':
        setUnread([item], true);
        toast(t('mailbox.actions.markedUnread'));
        return;
      case 'details':
        S.details = !S.details;
        return renderReader();
      case 'unsubscribe':
        return unsubscribe(m);
      case 'toggle-atts':
        S.attachmentsOpen = !S.attachmentsOpen;
        return renderReader();
      case 'save-all': {
        const n = await api('saveAllAttachments', m.id).catch((err) => toast(err.message, 5000));
        if (n) toast(t('reader.attachments.savedCount', { count: n }));
        return;
      }
      case 'edit':
        return compose({ mode: 'draft', id: m.id });
      case 'reply':
      case 'replyAll':
      case 'forward':
        if (m.error) return;
        return compose({ mode: btn.dataset.reader, id: m.id });
      case 'archive':
        return archiveMessages([item]);
      case 'move':
        return moveWithPicker([item]);
      case 'delete':
        return removeMessages([item]);
      case 'more':
        return showMenu(btn, messageMenu(item));
    }
  });
}

function step(dir, extend = false) {
  const list = visibleRows();
  if (!list.length) return;
  const from = cursor();
  const i = list.findIndex((x) => x.id === from);
  const target = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + dir))];
  if (!target) return;
  if (extend) {
    // Grow or shrink the selection from its anchor; the message on screen does not change.
    if (!S.checked.size && S.selectedId) S.checked.add(S.selectedId);
    const anchor = list.some((x) => x.id === S.anchorId) ? S.anchorId : from || target.id;
    S.anchorId = anchor;
    const a = list.findIndex((x) => x.id === anchor);
    const b = list.findIndex((x) => x.id === target.id);
    S.checked = new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1).map((m) => m.id));
    S.cursorId = target.id;
    selectionChanged();
    revealRow(target.id);
    return;
  }
  if (S.checked.size) {
    S.checked.clear();
    selectionChanged();
  }
  if (target.id === S.selectedId) {
    S.cursorId = target.id;
    return syncRowClasses();
  }
  openMessage(target.id);
}

// ---------- divider-free layout changes ----------

window.addEventListener('resize', () => {
  if (S.data) renderShell();
});

// ---------- keyboard ----------

function editing(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

document.addEventListener('keydown', (e) => {
  if (menuOpen()) return;
  if (document.querySelector('.page, .scrim')) return;
  if (e.target.closest && e.target.closest('.composer')) return;
  if (!S.data || !S.data.accounts.length) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && key === 'n') {
    e.preventDefault();
    return compose({ mode: 'new' });
  }
  if ((ctrl && key === 'e') || (e.key === '/' && !editing(e))) {
    e.preventDefault();
    return focusSearch();
  }
  if (e.key === 'F5') {
    e.preventDefault();
    return syncNow();
  }
  if (editing(e)) return;
  if (ctrl && key === 'z') {
    if (runToastAction()) e.preventDefault();
    return;
  }
  const list = targets();
  const m = S.composer ? null : S.message;
  if (ctrl && key === 'a') {
    e.preventDefault();
    S.checked = new Set(rows().map((x) => x.id));
    return selectionChanged();
  }
  if (e.key === 'Escape') {
    if (clearChecks()) return;
    if (S.composer) return S.composer.close();
    if (S.expanded) {
      S.expanded = false;
      renderShell();
      return renderReader();
    }
    if (S.query) return clearSearch();
    return;
  }
  if (ctrl && e.shiftKey && key === 'r' && m && m.role !== 'drafts') {
    e.preventDefault();
    return compose({ mode: 'replyAll', id: m.id });
  }
  if (ctrl && key === 'r' && m && m.role !== 'drafts') {
    e.preventDefault();
    return compose({ mode: 'reply', id: m.id });
  }
  if (ctrl && key === 'f' && m && m.role !== 'drafts') {
    e.preventDefault();
    return compose({ mode: 'forward', id: m.id });
  }
  if (ctrl && key === 'p' && m) {
    e.preventDefault();
    return printMessage(m.id);
  }
  if (ctrl && key === 'u' && list.length) {
    e.preventDefault();
    return setUnread(list, true);
  }
  if (ctrl && key === 'q' && list.length) {
    e.preventDefault();
    return setUnread(list, false);
  }
  if (ctrl && e.shiftKey && key === 'v' && list.length) {
    e.preventDefault();
    return moveWithPicker(list);
  }
  if (e.key === 'Delete' && list.length) {
    e.preventDefault();
    return removeMessages(list);
  }
  if (e.key === 'Enter' && m && m.role === 'drafts' && !e.target.closest?.('button')) {
    e.preventDefault();
    return compose({ mode: 'draft', id: m.id });
  }
  const nav = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };
  if (nav[e.key] !== undefined && !e.target.closest?.('.reader-scroll, .divider')) {
    e.preventDefault();
    $('.list-scroll')?.classList.add('kbd');
    if (document.activeElement === document.body) $('.list-scroll')?.focus();
    return step(nav[e.key], e.shiftKey);
  }
  if ((e.key === 'Home' || e.key === 'End') && e.target.closest?.('.list-scroll')) {
    e.preventDefault();
    const all = visibleRows();
    const target = e.key === 'Home' ? all[0] : all[all.length - 1];
    if (target) openMessage(target.id);
  }
});

// ---------- taskbar badge ----------

function drawBadge(count) {
  if (!count) return api('setBadge', null, 0);
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#d6336c';
  g.beginPath();
  g.arc(16, 16, 16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  const label = count > 99 ? '99+' : String(count);
  g.font = `bold ${label.length > 2 ? 13 : label.length > 1 ? 17 : 20}px Segoe UI`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 16, 17);
  return api('setBadge', c.toDataURL(), count);
}

// ---------- events from main ----------

window.mail.on(async ({ type, payload }) => {
  if (type === 'updated') scheduleRefresh();
  if (type === 'language') await refresh();
  if (type === 'badge') drawBadge(payload);
  if (type === 'toast') toast(payload);
  if (type === 'theme') {
    applyTheme(S.data?.settings.theme);
    if (S.message) renderReader();
    S.composer?.retheme(S.data);
  }
  if (type === 'open-message') {
    S.scope = 'all';
    S.view = 'inbox';
    S.folder = null;
    S.query = '';
    S.filter = 'all';
    await refresh();
    openMessage(payload);
  }
});

onSystemThemeChange(() => {
  applyTheme(S.data?.settings.theme);
  if (S.message) renderReader();
  S.composer?.retheme(S.data);
});

// Closing the window with unsaved text in the editor: keep it open and ask first.
window.addEventListener('beforeunload', (e) => {
  const editor = S.composer;
  if (!editor || (!editor.isDirty() && !editor.isBusy())) return;
  e.preventDefault();
  e.returnValue = false;
  if (!editor.isBusy()) setTimeout(() => editor.close(), 0);
});

// Scrollbars show while scrolling and fade after.
const scrolling = new Map();
document.addEventListener(
  'scroll',
  (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    el.classList.add('is-scrolling');
    clearTimeout(scrolling.get(el));
    scrolling.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 900));
  },
  true
);

// Context shared with the settings and setup pages.
export const ctx = {
  S,
  refresh,
  account,
  openMessage,
  closeReader,
  openSetup: (opts) => openSetup(ctx, opts),
  openSettings: () => openSettings(ctx)
};

refresh().catch((err) => toast(err.message, 6000));
