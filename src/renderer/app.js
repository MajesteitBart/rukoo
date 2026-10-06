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
import { openSettings } from './settings.js';
import { openSetup } from './setup.js';

// Sidebar entries. `drop` marks a folder role that accepts dragged messages.
const VIEWS = [
  { id: 'inbox', label: 'Postvak IN', icon: 'inbox', count: 'strong', drop: 'inbox' },
  { id: 'vip', label: "VIP's", icon: 'vip', count: 'muted' },
  { id: 'starred', label: 'Sterren', icon: 'star' },
  { id: 'drafts', label: 'Concepten', icon: 'drafts', count: 'muted' },
  { id: 'sent', label: 'Verzonden', icon: 'sent' },
  { id: 'archive', label: 'Archief', icon: 'archive', role: true, drop: 'archive' },
  { id: 'junk', label: 'Spam', icon: 'junk', role: true, count: 'muted', drop: 'junk' },
  { id: 'trash', label: 'Prullenbak', icon: 'trash', drop: 'trash' },
  { id: 'saved', label: 'Opgeslagen e-mails', icon: 'saved' }
];
const LABELS = Object.fromEntries(VIEWS.map((v) => [v.id, v.label]));
const FILTERS = [
  { id: 'all', label: 'Alles' },
  { id: 'unread', label: 'Ongelezen' },
  { id: 'starred', label: 'Met ster' },
  { id: 'attachments', label: 'Bijlagen' }
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
  allRecipients: false,
  attachmentsOpen: true
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
  return LABELS[S.view] || 'Postvak IN';
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
  const m = S.message && (byId(S.message.id) || S.message);
  return m && m.id ? [m] : [];
}

function cursor() {
  return S.cursorId && rows().some((m) => m.id === S.cursorId) ? S.cursorId : S.selectedId;
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
      <aside class="sidebar" aria-label="Mappen"></aside>
      <div class="workspace">
        <section class="listpane" aria-label="Berichten">
          <div class="list-head"></div>
          <div class="list-tools"></div>
          <div class="list-scroll" tabindex="0" role="listbox" aria-multiselectable="true" aria-label="Berichten"></div>
        </section>
        <div class="divider" role="separator" aria-orientation="vertical" aria-label="Breedte van de lijst" tabindex="0"></div>
        <section class="reader" aria-label="Bericht"></section>
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
  shell.classList.toggle('has-message', Boolean(S.selectedId) || S.checked.size > 1);
  shell.classList.toggle('compact', S.data?.settings.density === 'compact');
  shell.classList.toggle('selecting', S.checked.size > 0);
  root.style.setProperty('--sidebar-w', `${collapsed ? RAIL_W : SIDEBAR_W}px`);
  root.style.setProperty('--list-w', `${listWidth()}px`);
  document.body.classList.toggle('no-accounts', !S.data?.accounts.length);
  document.body.classList.toggle('collapsed-sidebar', collapsed);
}

// ---------- search (in the title bar) ----------

function searchScopeLabel(scope = S.searchScope) {
  if (scope === 'account') return 'Dit account';
  if (scope === 'all') return S.data.accounts.length > 1 ? 'Alle accounts' : 'Alle mappen';
  return 'Deze map';
}

function renderSearch() {
  const box = $('.titlebar-search');
  if (!box.querySelector('input')) {
    box.innerHTML = `<span class="s-ic">${icons.search}</span>
      <input id="search" type="search" autocomplete="off" spellcheck="false" aria-label="Zoeken"/>
      <button class="search-scope" data-action="search-scope" title="Waar zoeken" aria-haspopup="menu"><span></span>${icons.chevronDown}</button>
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
        const first = rows()[0];
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
          { heading: 'Zoeken in' },
          ...options.map((o) => ({
            label: o === 'view' ? `Deze map (${viewLabel()})` : searchScopeLabel(o),
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
  input.placeholder = S.searchScope === 'view' ? `Zoeken in ${viewLabel()}` : `Zoeken in ${searchScopeLabel().toLowerCase()}`;
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
  if (accounts.some((a) => a.syncing)) return { cls: 'busy', text: 'Synchroniseren...', title: '' };
  const failed = accounts.find((a) => a.error);
  if (failed) return { cls: 'error', text: 'Synchronisatie mislukt', title: `${failed.email}: ${failed.error}` };
  const times = accounts.map((a) => a.lastSync).filter(Boolean);
  if (!times.length) return { cls: '', text: 'Nog niet gesynchroniseerd', title: '' };
  const t = Math.min(...times);
  const today = new Date(t).toDateString() === new Date().toDateString();
  return { cls: 'ok', text: today ? `Bijgewerkt om ${hhmm(t)}` : `Bijgewerkt op ${numericDate(t)}`, title: 'Klik om nu te synchroniseren (F5)' };
}

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
    return `<span class="count ${v.count}" aria-label="${n} ${v.id === 'drafts' ? 'concepten' : 'ongelezen'}">${fmt(n)}</span>`;
  };

  const views = VIEWS.filter((v) => !hidden.has(v.id) && (!v.role || roles.has(v.id)));
  const viewRows = views
    .map((v) => {
      const active = S.view === v.id;
      return `<button class="nav-item ${active ? 'active' : ''}" data-view="${v.id}" ${v.drop ? `data-drop-role="${v.drop}"` : ''} title="${esc(v.label)}" ${
        active ? 'aria-current="page"' : ''
      }><span class="ic ${v.id === 'starred' ? 'star' : ''}">${icons[v.icon]}</span><span class="label">${esc(v.label)}</span>${countHtml(v, counts.views[v.id] || 0)}</button>`;
    })
    .join('');

  let folderRows = '';
  if (current) {
    const user = current.folders.filter((f) => !f.role && !hidden.has(`folder:${f.path}`));
    if (user.length) {
      folderRows =
        '<div class="nav-section">Mappen</div>' +
        user
          .map((f) => {
            const active = S.view === 'folder' && S.folder === f.path;
            const n = counts.folders[f.path] || 0;
            return `<button class="nav-item ${active ? 'active' : ''}" data-folder="${esc(f.path)}" data-drop-path="${esc(f.path)}" title="${esc(f.name)}" ${
              active ? 'aria-current="page"' : ''
            }><span class="ic">${icons.folder}</span><span class="label">${esc(f.name)}</span>${n ? `<span class="count muted">${fmt(n)}</span>` : ''}</button>`;
          })
          .join('');
    }
  }

  const who = current
    ? `${accountAvatar(current)}<span class="who"><span class="name">${esc(current.name || current.email.split('@')[0])}</span><span class="email">${esc(current.email)}</span></span>`
    : `<span class="avatar acc all" aria-hidden="true">${icons.inbox}</span><span class="who"><span class="name">Alle accounts</span><span class="email">${accounts.length} accounts</span></span>`;
  const status = syncStatus();

  el.innerHTML = `
    <button class="account-switch" data-action="accounts" aria-haspopup="menu" title="${esc(current ? current.email : 'Alle accounts')}">${who}<span class="chev">${icons.chevronUpDown}</span></button>
    <button class="btn primary compose-btn" data-action="compose" title="Nieuw bericht (Ctrl+N)">${icons.compose}<span>Nieuw bericht</span></button>
    <nav class="nav" aria-label="Mappen">${viewRows}${folderRows}</nav>
    <div class="sidebar-foot">
      <button class="sync-status ${status.cls}" data-action="sync" title="${esc(status.title)}"><span class="dot"></span><span class="t">${esc(status.text)}</span></button>
      <button class="icon-btn" data-action="settings" title="Instellingen">${icons.settings}</button>
      <button class="icon-btn" data-action="collapse" title="${sidebarCollapsed() ? 'Zijbalk uitklappen' : 'Zijbalk inklappen'}">${icons.panelLeft}</button>
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
    items.push({ icon: 'inbox', label: 'Alle accounts', hint: S.counts.all ? String(S.counts.all) : '', current: S.scope === 'all', action: () => switchScope('all') });
  }
  items.push({ separator: true });
  items.push({ icon: 'plus', label: 'Account toevoegen', action: () => openSetup(ctx, { first: false }) });
  items.push({ icon: 'settings', label: 'Accounts en instellingen', action: () => openSettings(ctx) });
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
  // A message from the previous folder would look like it belongs to this one.
  if (S.selectedId) closeReader();
  const input = $('#search');
  if (input) input.value = '';
  $('.list-scroll')?.scrollTo(0, 0);
  refresh();
}

// ---------- list ----------

function senderLine(m) {
  if (m.role === 'sent' || m.role === 'drafts') {
    const names = (m.to || []).map(person).filter(Boolean);
    return names.length ? `Aan: ${names.join(', ')}` : '(Geen ontvanger)';
  }
  return person(m.from) || '(Onbekende afzender)';
}

function listTitle() {
  if (S.query.trim()) {
    return { title: 'Zoekresultaten', sub: `${rows().length} voor "${S.query.trim()}" in ${S.searchScope === 'view' ? viewLabel() : searchScopeLabel().toLowerCase()}` };
  }
  const acc = account(S.scope);
  const unread = S.view === 'inbox' || S.view === 'folder' || S.view === 'vip' || S.view === 'junk' || S.view === 'archive' ? S.list.filter((m) => m.unread).length : 0;
  const where = acc ? acc.email : 'Alle accounts';
  return { title: viewLabel(), sub: unread ? `${unread} ongelezen · ${where}` : where };
}

function renderListHead() {
  const head = $('.list-head');
  const { title, sub } = listTitle();
  head.innerHTML = `<div class="list-title"><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
    ${S.query.trim() ? `<button class="tbtn" data-action="search-clear" title="Zoeken wissen (Esc)">${icons.close}<span>Wissen</span></button>` : ''}
    <button class="icon-btn" data-action="sync" title="Synchroniseren (F5)">${icons.sync}</button>
    <button class="icon-btn" data-action="list-more" title="Meer opties" aria-haspopup="menu">${icons.more}</button>`;
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
    tools.innerHTML = `<button class="check ${all ? 'on' : 'some'}" data-action="check-all" title="${all ? 'Niets selecteren' : 'Alles selecteren (Ctrl+A)'}" role="checkbox" aria-checked="${all ? 'true' : 'mixed'}">${icons.check}</button>
      <span class="sel-count">${n} geselecteerd</span>
      <span class="spacer"></span>
      <button class="icon-btn" data-bulk="${anyUnread ? 'read' : 'unread'}" title="${anyUnread ? 'Markeren als gelezen (Ctrl+Q)' : 'Markeren als ongelezen (Ctrl+U)'}">${anyUnread ? icons.mailOpen : icons.markUnread}</button>
      <button class="icon-btn" data-bulk="star" title="Ster">${icons.star}</button>
      <button class="icon-btn" data-bulk="move" title="Verplaatsen (Ctrl+Shift+V)">${icons.move}</button>
      ${canArchive ? `<button class="icon-btn" data-bulk="archive" title="Archiveren">${icons.archive}</button>` : ''}
      <button class="icon-btn" data-bulk="delete" title="Verwijderen (Delete)">${icons.trash}</button>
      <button class="icon-btn" data-bulk="clear" title="Selectie opheffen (Esc)">${icons.close}</button>`;
    return;
  }
  tools.className = 'list-tools';
  const n = (id) => {
    if (id === 'unread') return S.list.filter((m) => m.unread).length;
    if (id === 'starred') return S.list.filter((m) => m.starred).length;
    if (id === 'attachments') return S.list.filter((m) => m.hasAttachments).length;
    return 0;
  };
  tools.innerHTML = `<div class="filters" role="tablist" aria-label="Filter">${FILTERS.map((f) => {
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

function listHtml() {
  const list = rows();
  if (!list.length) {
    const scoped = scopedAccounts();
    const syncing = scoped.some((a) => a.syncing);
    const failed = scoped.find((a) => a.error);
    let msg = 'Geen e-mails';
    let hint = '';
    if (S.query.trim()) {
      msg = 'Niets gevonden';
      hint = S.searchScope === 'view' ? 'Probeer te zoeken in alle mappen.' : 'Probeer een ander zoekwoord.';
    } else if (S.filter !== 'all') {
      msg = 'Niets in dit filter';
      hint = '<button class="link-btn" data-filter="all">Alles weergeven</button>';
    } else if (syncing) msg = 'Bezig met synchroniseren...';
    const error = failed && !syncing ? `<p class="error">${esc(failed.email)}: ${esc(failed.error)}</p>` : '';
    const searchAll =
      S.query.trim() && S.searchScope === 'view' ? '<button class="btn secondary sm" data-action="search-everywhere">Zoeken in alle mappen</button>' : '';
    return `<div class="empty">${icons.mailOpen}<div class="t">${msg}</div>${hint && !hint.startsWith('<') ? `<div class="h">${hint}</div>` : hint}${searchAll}${error}</div>`;
  }
  const byDate = S.data.settings.sort === 'date-desc' || S.data.settings.sort === 'date-asc';
  const opts = {
    multi: S.data.accounts.length > 1 && (S.scope === 'all' || searchingAll()),
    showFolder: searchingAll() || S.view === 'starred'
  };
  let out = '';
  let label = null;
  for (const m of list) {
    const l = byDate ? groupLabel(m.date) : null;
    if (l !== label) {
      label = l;
      if (l) out += `<div class="group-head" role="presentation">${esc(l)}</div>`;
    }
    out += itemHtml(m, opts);
  }
  return out;
}

function itemHtml(m, { multi, showFolder }) {
  const acc = multi && account(m.accountId);
  const draft = m.role === 'drafts';
  const pills = [
    m.vip ? '<span class="pill vip">VIP</span>' : '',
    showFolder ? `<span class="pill">${esc(folderName(m))}</span>` : '',
    acc ? `<span class="pill acc" style="--acc:${esc(acc.color)}" title="${esc(acc.email)}">${esc(accountLabel(acc))}</span>` : ''
  ].join('');
  const swipe = S.data.settings.swipeActions
    ? `<div class="swipe-bg read">${icons.mailOpen}<span>${m.unread ? 'Gelezen' : 'Ongelezen'}</span></div>
       <div class="swipe-bg delete"><span>Wissen</span>${icons.trash}</div>`
    : '';
  const selected = S.selectedId === m.id;
  const checked = S.checked.has(m.id);
  const atCursor = (S.cursorId || S.selectedId) === m.id;
  const who = m.role === 'sent' || draft ? (m.to || [])[0] : m.from;
  return `<div class="item-wrap" data-id="${esc(m.id)}">${swipe}
    <div class="item ${m.unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${checked ? 'checked' : ''} ${atCursor ? 'cursor' : ''}" data-id="${esc(m.id)}" role="option" aria-selected="${selected || checked}" draggable="true">
      <span class="unread-dot" aria-hidden="true"></span>
      <div class="lead">${avatar(who || { name: '?' })}<button class="check ${checked ? 'on' : ''}" data-check role="checkbox" aria-checked="${checked}" aria-label="Selecteren" tabindex="-1">${icons.check}</button></div>
      <div class="body">
        <div class="line1">
          <span class="sender">${draft ? '<span class="draft-tag">Concept</span>' : ''}${esc(senderLine(m))}</span>
          <span class="meta">${m.answered ? `<span class="ic-ans" title="Beantwoord">${icons.reply}</span>` : ''}${m.hasAttachments ? `<span class="ic-att" title="Bijlage">${icons.clip}</span>` : ''}<time>${listTime(m.date)}</time></span>
        </div>
        <div class="line2">
          <span class="subject">${esc(m.subject || '(Geen onderwerp)')}</span><span class="sep"> - </span><span class="preview-inline">${esc(m.preview || '')}</span>
          <span class="flags">${pills}${
            m.role === 'saved'
              ? ''
              : `<button class="star-btn ${m.starred ? 'on' : ''}" data-star tabindex="-1" title="${m.starred ? 'Ster verwijderen' : 'Ster toevoegen'}">${m.starred ? icons.starFilled : icons.star}</button>`
          }</span>
        </div>
        <div class="preview">${esc(m.preview || '')}</div>
      </div>
    </div>
  </div>`;
}

function syncRowClasses() {
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
  const list = rows();
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
    ghost.textContent = ids.length === 1 ? (byId(id)?.subject || '1 bericht').slice(0, 60) : `${ids.length} berichten`;
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
        { icon: 'mailOpen', label: 'Alles als gelezen markeren', action: markAllRead },
        { icon: 'sync', label: 'Synchroniseren', shortcut: 'F5', action: syncNow },
        { separator: true },
        { label: 'Compacte weergave', checked: compact, action: () => setDensity(compact ? 'standard' : 'compact') },
        { icon: 'chevronUpDown', label: 'Sorteren op...', action: chooseSort },
        S.view === 'trash' || S.view === 'junk' ? { separator: true } : null,
        S.view === 'trash' || S.view === 'junk' ? { icon: 'trash', label: `${viewLabel()} leegmaken`, action: emptyCurrent, danger: true } : null,
        { separator: true },
        { icon: 'settings', label: 'Instellingen', action: () => openSettings(ctx) }
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
  toast(n ? `${n} e-mails als gelezen gemarkeerd` : 'Alles is al gelezen');
}

export async function syncNow() {
  toast('Synchroniseren...');
  try {
    await api('sync', S.scope === 'all' ? null : S.scope);
    toast('Gesynchroniseerd');
  } catch (err) {
    toast(err.message, 5000);
  }
}

async function chooseSort() {
  const v = await choiceDialog(
    'Sorteren op',
    [
      { label: 'Datum (nieuwste eerst)', value: 'date-desc' },
      { label: 'Datum (oudste eerst)', value: 'date-asc' },
      { label: 'Ongelezen eerst', value: 'unread' },
      { label: 'Afzender', value: 'sender' }
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
      ? 'Alle e-mails in deze map worden definitief verwijderd.'
      : 'Alle e-mails in deze map worden naar de Prullenbak verplaatst.';
  const ok = await confirmDialog(`${viewLabel()} leegmaken?`, what, 'Leegmaken', true);
  if (!ok) return;
  let n = 0;
  for (const a of accounts) {
    const f = a.folders.find((x) => x.role === S.view);
    if (f) n += await api('emptyFolder', a.id, f.path);
  }
  toast(`${n} e-mails verwijderd`);
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
  const visible = rows();
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
  toast(message, { action: { label: 'Ongedaan maken', run: () => undoMoves(undoable, reopen) } });
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
  if (back.length) toast(back.length === 1 ? 'Teruggezet' : `${back.length} e-mails teruggezet`);
}

export async function removeMessages(list) {
  list = list.filter(Boolean);
  if (!list.length) return;
  const permanent = list.filter((m) => m.role === 'trash' || m.role === 'saved');
  if (permanent.length) {
    const ok = await confirmDialog(
      'Definitief verwijderen?',
      permanent.length === 1 ? 'Deze e-mail wordt definitief verwijderd.' : `${permanent.length} e-mails worden definitief verwijderd.`,
      'Verwijderen',
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
      'Definitief verwijderen?',
      confirm.length === 1
        ? 'Dit account heeft geen Prullenbak. De e-mail wordt definitief van de server verwijderd.'
        : `Dit account heeft geen Prullenbak. ${confirm.length} e-mails worden definitief van de server verwijderd.`,
      'Verwijderen',
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
  if (moved.length) offerUndo(moved, moved.length === 1 ? 'Verplaatst naar Prullenbak' : `${moved.length} e-mails verplaatst naar Prullenbak`, reopen);
  else if (deleted) toast(deleted === 1 ? 'Verwijderd' : `${deleted} e-mails verwijderd`);
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
  if (!plan.length) return toast(target.role === 'archive' ? 'Er is geen archiefmap' : 'Die e-mails staan daar al');
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
  if (moved.length) offerUndo(moved, moved.length === 1 ? `Verplaatst naar ${label}` : `${moved.length} e-mails verplaatst naar ${label}`, reopen);
}

function archiveMessages(list) {
  return moveMessages(list, { role: 'archive' }, 'Archief');
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
    options = ['inbox', 'archive', 'junk', 'trash'].map((role) => ({ label: LABELS[role], value: { role, label: LABELS[role] } }));
  }
  return choiceDialog(list.length === 1 ? 'Verplaatsen naar' : `${list.length} e-mails verplaatsen naar`, options, null);
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
    { icon: anyUnread ? 'mailOpen' : 'markUnread', label: anyUnread ? 'Markeren als gelezen' : 'Markeren als ongelezen', shortcut: anyUnread ? 'Ctrl+Q' : 'Ctrl+U', action: () => setUnread(list, !anyUnread) },
    { icon: 'star', label: list.every((m) => m.starred) ? 'Ster verwijderen' : 'Ster toevoegen', action: () => setStarred(list, !list.every((m) => m.starred)) },
    { separator: true },
    { icon: 'move', label: 'Verplaatsen...', shortcut: 'Ctrl+Shift+V', action: () => moveWithPicker(list) },
    canArchive ? { icon: 'archive', label: 'Archiveren', action: () => archiveMessages(list) } : null,
    { separator: true },
    { icon: 'trash', label: `${list.length} e-mails verwijderen`, shortcut: 'Delete', action: () => removeMessages(list), danger: true }
  ];
}

function messageMenu(m) {
  const saved = m.role === 'saved';
  const draft = m.role === 'drafts';
  const acc = account(m.accountId);
  const canArchive = Boolean(acc && acc.archive && m.role !== 'archive' && !saved && !draft);
  return [
    draft ? { icon: 'edit', label: 'Concept bewerken', shortcut: 'Enter', action: () => compose({ mode: 'draft', id: m.id }) } : null,
    draft ? null : { icon: 'reply', label: 'Beantwoorden', shortcut: 'Ctrl+R', action: () => compose({ mode: 'reply', id: m.id }) },
    draft ? null : { icon: 'replyAll', label: 'Allen beantwoorden', shortcut: 'Ctrl+Shift+R', action: () => compose({ mode: 'replyAll', id: m.id }) },
    draft ? null : { icon: 'forward', label: 'Doorsturen', shortcut: 'Ctrl+F', action: () => compose({ mode: 'forward', id: m.id }) },
    { separator: true },
    saved ? null : { icon: m.unread ? 'mailOpen' : 'markUnread', label: m.unread ? 'Markeren als gelezen' : 'Markeren als ongelezen', shortcut: m.unread ? 'Ctrl+Q' : 'Ctrl+U', action: () => setUnread([m], !m.unread) },
    saved ? null : { icon: 'star', label: m.starred ? 'Ster verwijderen' : 'Ster toevoegen', action: () => setStarred([m], !m.starred) },
    saved ? null : { icon: 'move', label: 'Verplaatsen...', shortcut: 'Ctrl+Shift+V', action: () => moveWithPicker([m]) },
    canArchive ? { icon: 'archive', label: 'Archiveren', action: () => archiveMessages([m]) } : null,
    { separator: true },
    {
      icon: 'vip',
      label: m.vip ? "Verwijderen uit VIP's" : "Toevoegen aan VIP's",
      action: async () => {
        const on = await api('toggleVip', m.from.address);
        toast(on ? `${person(m.from)} toegevoegd aan VIP's` : `${person(m.from)} verwijderd uit VIP's`);
      }
    },
    saved || m.role === 'sent' || draft
      ? null
      : {
          icon: 'ban',
          label: 'Toevoegen aan spamadressen',
          action: async () => {
            const ok = await confirmDialog('Toevoegen aan spamadressen?', `E-mails van ${m.from.address} worden niet meer in je Postvak IN getoond.`, 'Toevoegen');
            if (!ok) return;
            if (S.selectedId === m.id) closeReader();
            try {
              await api('markSpam', m.id);
              toast('Toegevoegd aan spamadressen');
            } catch (err) {
              toast(err.message, 5000);
            }
          }
        },
    saved
      ? null
      : {
          icon: 'saved',
          label: 'Opslaan in Opgeslagen e-mails',
          action: async () => {
            await api('saveToDevice', m.id);
            toast('Opgeslagen in Opgeslagen e-mails');
          }
        },
    {
      icon: 'export',
      label: 'Exporteren als .eml',
      action: async () => {
        const p = await api('exportEml', m.id).catch((err) => toast(err.message));
        if (p) toast('Geëxporteerd');
      }
    },
    { icon: 'print', label: 'Afdrukken', shortcut: 'Ctrl+P', action: () => printMessage(m.id) },
    { separator: true },
    { icon: 'trash', label: 'Verwijderen', shortcut: 'Delete', action: () => removeMessages([m]), danger: true }
  ];
}

async function printMessage(id) {
  const full = S.message && S.message.id === id && S.message.html != null ? S.message : await api('get', id);
  const head = `<h2 style="font:600 20px Segoe UI,sans-serif;margin:0 0 8px">${esc(full.subject)}</h2>
    <div style="font:13px Segoe UI,sans-serif;color:#444;margin-bottom:16px">Van: ${esc(formatAddress(full.from))}<br>Aan: ${esc(full.to.map(formatAddress).join(', '))}<br>Datum: ${esc(longDate(full.date))}</div><hr>`;
  await api('print', `<!doctype html><meta charset="utf-8"><body style="margin:24px">${head}${full.html}</body>`);
}

function compose(opts) {
  const accountId = S.scope !== 'all' ? S.scope : null;
  api('openCompose', { accountId, ...opts }).catch((err) => toast(err.message, 5000));
}

// ---------- reader ----------

export async function openMessage(id) {
  const m = S.list.find((x) => x.id === id);
  S.selectedId = id;
  S.anchorId = id;
  S.cursorId = id;
  S.allRecipients = false;
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
  if (m && m.unread && m.role !== 'drafts') setUnread([m], false);
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
  const list = rows();
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

function recipientsHtml(m) {
  const all = [
    ...(m.to || []).map((a) => ['Aan', a]),
    ...(m.cc || []).map((a) => ['Cc', a]),
    ...(m.bcc || []).map((a) => ['Bcc', a])
  ];
  if (!all.length) return '';
  const LIMIT = 4;
  const shown = S.allRecipients ? all : all.slice(0, LIMIT);
  let prev = null;
  const parts = shown.map(([k, a]) => {
    const label = k !== prev ? `${prev ? '; ' : ''}<span class="rk">${k}</span> ` : ', ';
    prev = k;
    return `${label}<button class="person" data-person="${esc(a.address)}" data-name="${esc(a.name || '')}" title="${esc(formatAddress(a))}">${esc(person(a))}</button>`;
  });
  const more = all.length > LIMIT && !S.allRecipients ? ` <button class="link-btn" data-reader="all-recipients">+${all.length - LIMIT} meer</button>` : '';
  return `<div class="recips">${parts.join('')}${more}</div>`;
}

function attachmentsHtml(m) {
  const list = m.attachments || [];
  if (!list.length) return '';
  const total = list.reduce((n, a) => n + (a.size || 0), 0);
  const open = S.attachmentsOpen;
  return `<section class="atts ${open ? '' : 'closed'}" aria-label="Bijlagen">
    <div class="atts-head">
      <button class="atts-toggle" data-reader="toggle-atts" aria-expanded="${open}">${icons.chevronDown}<span>${list.length === 1 ? '1 bijlage' : `${list.length} bijlagen`}</span><span class="atts-size">${fileSize(total)}</span></button>
      ${list.length > 1 ? `<button class="link-btn" data-reader="save-all">${icons.download}<span>Alles opslaan</span></button>` : ''}
    </div>
    ${
      open
        ? `<div class="atts-list">${list
            .map((a) => {
              const { ext, kind } = attachmentKind(a.filename);
              return `<div class="att">
                <button class="att-open" data-open-att="${a.index}" title="Openen: ${esc(a.filename)}"><span class="ftype ${kind}">${esc(ext)}</span><span class="att-text"><span class="att-name">${esc(a.filename)}</span><span class="att-size">${fileSize(a.size)}</span></span></button>
                <button class="icon-btn sm" data-save-att="${a.index}" title="Opslaan">${icons.download}</button>
              </div>`;
            })
            .join('')}</div>`
        : ''
    }
  </section>`;
}

function readerBar(m) {
  const draft = m.role === 'drafts';
  const saved = m.role === 'saved';
  const acc = account(m.accountId);
  const canArchive = Boolean(acc && acc.archive && m.role !== 'archive' && !saved && !draft);
  const nav = `<span class="spacer"></span>
    <button class="icon-btn" data-reader="prev" title="Vorige (Pijl omhoog)">${icons.up}</button>
    <button class="icon-btn" data-reader="next" title="Volgende (Pijl omlaag)">${icons.down}</button>
    <button class="icon-btn wide-only" data-reader="expand" title="${S.expanded ? 'Lijst weer tonen (Esc)' : 'Leesvenster vergroten'}">${S.expanded ? icons.collapse : icons.expand}</button>`;
  const back = `<button class="icon-btn narrow-only" data-reader="back" title="Terug naar de lijst">${icons.back}</button>`;
  if (draft) {
    return `<div class="reader-bar" role="toolbar" aria-label="Acties">${back}
      <button class="btn primary sm" data-reader="edit" title="Concept bewerken (Enter)">${icons.edit}<span>Concept bewerken</span></button>
      <button class="tbtn" data-reader="delete" title="Verwijderen (Delete)">${icons.trash}<span>Verwijderen</span></button>
      ${nav}</div>`;
  }
  return `<div class="reader-bar" role="toolbar" aria-label="Acties">${back}
    <button class="tbtn" data-reader="reply" title="Beantwoorden (Ctrl+R)">${icons.reply}<span>Beantwoorden</span></button>
    <button class="tbtn" data-reader="replyAll" title="Allen beantwoorden (Ctrl+Shift+R)">${icons.replyAll}<span>Allen beantwoorden</span></button>
    <button class="tbtn" data-reader="forward" title="Doorsturen (Ctrl+F)">${icons.forward}<span>Doorsturen</span></button>
    <span class="bar-sep"></span>
    ${canArchive ? `<button class="icon-btn" data-reader="archive" title="Archiveren">${icons.archive}</button>` : ''}
    <button class="icon-btn" data-reader="delete" title="Verwijderen (Delete)">${icons.trash}</button>
    ${saved ? '' : `<button class="icon-btn" data-reader="move" title="Verplaatsen (Ctrl+Shift+V)">${icons.move}</button>`}
    ${saved ? '' : `<button class="icon-btn" data-reader="unread" title="Markeren als ongelezen (Ctrl+U)">${icons.markUnread}</button>`}
    <button class="icon-btn" data-reader="more" title="Meer acties" aria-haspopup="menu">${icons.more}</button>
    ${nav}</div>`;
}

function renderReader() {
  const el = $('.reader');
  if (!el) return;
  if (S.checked.size > 1) {
    const list = checkedMessages();
    const canArchive = list.some((m) => account(m.accountId)?.archive && m.role !== 'archive');
    el.innerHTML = `<div class="reader-empty multi">
      <div class="stack" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="t">${list.length} e-mails geselecteerd</div>
      <div class="multi-actions">
        <button class="tbtn" data-bulk="${list.some((m) => m.unread) ? 'read' : 'unread'}">${list.some((m) => m.unread) ? icons.mailOpen : icons.markUnread}<span>${list.some((m) => m.unread) ? 'Gelezen' : 'Ongelezen'}</span></button>
        <button class="tbtn" data-bulk="move">${icons.move}<span>Verplaatsen</span></button>
        ${canArchive ? `<button class="tbtn" data-bulk="archive">${icons.archive}<span>Archiveren</span></button>` : ''}
        <button class="tbtn danger" data-bulk="delete">${icons.trash}<span>Verwijderen</span></button>
      </div>
      <button class="link-btn" data-bulk="clear">Selectie opheffen</button>
    </div>`;
    return;
  }
  const m = S.message;
  if (!m) {
    el.innerHTML = `<div class="reader-empty">
      ${icons.mailOpen}
      <div class="t">Selecteer een e-mail om te lezen</div>
      <div class="keys"><span><kbd>Ctrl+N</kbd> Nieuw bericht</span><span><kbd>Ctrl+E</kbd> Zoeken</span><span><kbd>↑</kbd><kbd>↓</kbd> Bladeren</span></div>
    </div>`;
    return;
  }
  const draft = m.role === 'drafts';
  const from = m.from || {};
  const body = m.error
    ? `<p class="error">${esc(m.error)}</p>`
    : S.loading || m.html === null || m.html === undefined
      ? '<div class="loading-bar"></div>'
      : '<iframe class="mail-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Inhoud van e-mail"></iframe>';
  el.innerHTML = `${readerBar(m)}
    <div class="reader-scroll" tabindex="-1">
      <article class="message">
        <header class="msg-head">
          <div class="subject-row">
            <h2 class="reader-subject">${esc(m.subject || '(Geen onderwerp)')}</h2>
            ${m.role === 'saved' || draft ? '' : `<button class="icon-btn reader-star ${m.starred ? 'on' : ''}" data-reader="star" title="${m.starred ? 'Ster verwijderen' : 'Ster toevoegen'}">${m.starred ? icons.starFilled : icons.star}</button>`}
          </div>
          <div class="msg-from">
            ${avatar(draft ? (m.to || [])[0] || from : from, 'lg')}
            <div class="who">
              <div class="from-line">${
                draft
                  ? '<span class="draft-tag">Concept</span>'
                  : `<button class="person from-name" data-person="${esc(from.address || '')}" data-name="${esc(from.name || '')}">${esc(person(from) || '(Onbekende afzender)')}</button>${
                      from.name ? `<span class="addr">${esc(from.address)}</span>` : ''
                    }${m.vip ? '<span class="pill vip">VIP</span>' : ''}`
              }</div>
              ${recipientsHtml(m)}
            </div>
            <time class="reader-date" title="${esc(longDate(m.date))}">${esc(readerDate(m.date))}</time>
          </div>
        </header>
        ${attachmentsHtml(m)}
        ${body}
      </article>
    </div>`;
  renderReaderNav();
  const frame = el.querySelector('.mail-frame');
  if (frame && m.html !== null && m.html !== undefined) {
    const s = S.data?.settings || {};
    fillFrame(frame, m, { light: isLight(), darkEmails: s.darkEmails !== false, fitContent: s.fitContent !== false });
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
      { icon: 'compose', label: 'Nieuw bericht', action: () => compose({ mode: 'new', to: [{ name, address }] }) },
      {
        icon: 'link',
        label: 'E-mailadres kopiëren',
        action: async () => {
          await navigator.clipboard.writeText(address).catch(() => {});
          toast('Gekopieerd');
        }
      },
      {
        icon: 'vip',
        label: vip ? "Verwijderen uit VIP's" : "Toevoegen aan VIP's",
        action: async () => {
          const on = await api('toggleVip', address);
          toast(on ? "Toegevoegd aan VIP's" : "Verwijderd uit VIP's");
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
      if (p) toast('Bijlage opgeslagen');
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
        toast('Gemarkeerd als ongelezen');
        return;
      case 'all-recipients':
        S.allRecipients = true;
        return renderReader();
      case 'toggle-atts':
        S.attachmentsOpen = !S.attachmentsOpen;
        return renderReader();
      case 'save-all': {
        const n = await api('saveAllAttachments', m.id).catch((err) => toast(err.message, 5000));
        if (n) toast(`${n} bijlagen opgeslagen`);
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
  const list = rows();
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
  const m = S.message;
  if (ctrl && key === 'a') {
    e.preventDefault();
    S.checked = new Set(rows().map((x) => x.id));
    return selectionChanged();
  }
  if (e.key === 'Escape') {
    if (clearChecks()) return;
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
    const all = rows();
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
  if (type === 'badge') drawBadge(payload);
  if (type === 'toast') toast(payload);
  if (type === 'theme') {
    applyTheme(S.data?.settings.theme);
    if (S.message) renderReader();
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
});

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
