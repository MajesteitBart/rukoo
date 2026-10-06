import { icons } from './icons.js';
import {
  api,
  esc,
  $,
  $$,
  listTime,
  groupLabel,
  longDate,
  hhmm,
  fileSize,
  person,
  formatAddress,
  toast,
  showMenu,
  closeMenu,
  dialog,
  confirmDialog,
  choiceDialog
} from './ui.js';
import { openCompose, composeOpen } from './compose.js';
import { openSettings } from './settings.js';
import { openSetup } from './setup.js';

const VIEWS = [
  { id: 'inbox', label: 'Postvak IN', icon: 'inbox', badge: true },
  { id: 'unread', label: 'Ongelezen', icon: 'unread', badge: true },
  { id: 'vip', label: "VIP's", vip: true, badge: true },
  { id: 'starred', label: 'Sterren', icon: 'starFilled', star: true },
  { id: 'saved', label: 'Opgeslagen e-mails', icon: 'saved' },
  { id: 'drafts', label: 'Concepten', icon: 'drafts' },
  { id: 'sent', label: 'Verzonden', icon: 'sent' },
  { id: 'trash', label: 'Prullenbak', icon: 'trash' }
];
const EXTRA_ROLES = [
  { id: 'junk', label: 'Spam', icon: 'junk', badge: true },
  { id: 'archive', label: 'Archief', icon: 'archive' }
];

export const S = {
  data: null,
  scope: 'all',
  view: 'inbox',
  folder: null,
  query: '',
  searching: false,
  list: [],
  counts: null,
  selectedId: null,
  message: null,
  loading: false,
  drawerOpen: window.innerWidth > 1100,
  expanded: false,
  details: false
};

const root = document.documentElement;

// ---------- data ----------

let refreshTimer = null;
let pending = null;
let again = false;

export function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 60);
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

async function refreshOnce() {
  const data = await api('state');
  S.data = data;
  // With one account, "Alle accounts" would just repeat it; show the account itself.
  if (data.accounts.length === 1) S.scope = data.accounts[0].id;
  else if (!data.accounts.some((a) => a.id === S.scope)) S.scope = 'all';
  const [list, counts] = await Promise.all([
    api('list', { scope: S.scope, view: S.view, folder: S.folder, query: S.query }),
    api('counts', S.scope)
  ]);
  S.list = list;
  S.counts = counts;
  applyTheme();
  if (!data.accounts.length) {
    renderShell();
    if (!document.querySelector('.page.setup')) openSetup(ctx, { first: true });
    return;
  }
  renderDrawer();
  renderList();
  renderReaderNav();
}

function account(id) {
  return S.data.accounts.find((a) => a.id === id);
}

function viewLabel() {
  if (S.view === 'folder') {
    const acc = account(S.scope);
    const f = acc && acc.folders.find((x) => x.path === S.folder);
    return f ? f.name : S.folder;
  }
  return [...VIEWS, ...EXTRA_ROLES].find((v) => v.id === S.view)?.label || 'Postvak IN';
}

// ---------- theme ----------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = S.data?.settings.theme || 'system';
  const light = t === 'light' || (t === 'system' && !darkQuery.matches);
  root.classList.toggle('light', light);
}
darkQuery.addEventListener('change', () => {
  applyTheme();
  if (S.message) renderReader();
});

// ---------- shell ----------

function renderShell() {
  const app = $('#app');
  if (!app.querySelector('.shell')) {
    app.innerHTML = `<div class="shell">
      <aside class="drawer" aria-label="Mappen"></aside>
      <section class="listpane" aria-label="Berichten"></section>
      <section class="reader" aria-label="Bericht"></section>
    </div>`;
    bindList();
    renderReader();
  }
  const shell = app.querySelector('.shell');
  shell.classList.toggle('drawer-closed', !S.drawerOpen);
  shell.classList.toggle('expanded', S.expanded);
  shell.classList.toggle('has-message', Boolean(S.selectedId));
  shell.classList.toggle('compact', S.data?.settings.density === 'compact');
}

// ---------- drawer ----------

function renderDrawer() {
  renderShell();
  const el = $('.drawer');
  const accounts = S.data.accounts;
  const counts = S.counts;
  const current = account(S.scope);
  const hidden = new Set(S.data.settings.hiddenViews || []);
  const badge = (n) => (n ? `<span class="badge">${n > 999 ? '999+' : n}</span>` : '');
  const count = (n) => (n ? `<span class="count">${n}</span>` : '');

  const accountRows = accounts
    .map(
      (a) => `<button class="drawer-account" data-scope="${esc(a.id)}" title="${esc(a.email)}">
        <span class="ring" style="--ring:${a.color}"></span>
        <span class="label">${esc(a.email)}</span>
        ${S.scope === a.id ? `<span class="check">${icons.check}</span>` : badge(counts.accounts[a.id])}
      </button>`
    )
    .join('');
  const allRow =
    accounts.length > 1
      ? `<button class="drawer-account" data-scope="all"><span class="ring"></span><span class="label">Alle accounts</span>
        ${S.scope === 'all' ? `<span class="check">${icons.check}</span>` : badge(counts.all)}</button>`
      : '';

  const views = VIEWS.filter((v) => !hidden.has(v.id));
  if (current) {
    for (const extra of EXTRA_ROLES) {
      if (current.folders.some((f) => f.role === extra.id) && !hidden.has(extra.id)) views.push(extra);
    }
  }
  const viewRows = views
    .map((v) => {
      const n = counts.views[v.id] || 0;
      const ic = v.vip ? '<span class="ic vip">VIP</span>' : `<span class="ic ${v.star ? 'star' : ''}">${icons[v.icon]}</span>`;
      return `<button class="drawer-item ${S.view === v.id ? 'active' : ''}" data-view="${v.id}">
        ${ic}<span class="label">${v.label}</span>${v.badge ? badge(n) : count(n)}
      </button>`;
    })
    .join('');

  let folderRows = '';
  if (current) {
    const user = current.folders.filter((f) => !f.role && !hidden.has(`folder:${f.path}`));
    if (user.length) {
      folderRows =
        '<div class="drawer-section">Mappen</div>' +
        user
          .map(
            (f) => `<button class="drawer-item ${S.view === 'folder' && S.folder === f.path ? 'active' : ''}" data-folder="${esc(f.path)}">
            <span class="ic">${icons.folder}</span><span class="label">${esc(f.name)}</span>${badge(counts.folders[f.path])}
          </button>`
          )
          .join('');
    }
  }

  const avatar = current
    ? `<div class="avatar" style="--accent:${current.color}">${esc((current.name || current.email).trim()[0] || '?').toUpperCase()}</div>
       <div class="profile-email">${esc(current.email)}</div>`
    : `<div class="avatar all">${icons.person}</div><div class="profile-email">Alle accounts</div>`;

  el.innerHTML = `<div class="drawer-card">
    <div class="drawer-top"><button class="icon-btn" data-action="settings" title="Instellingen">${icons.settings}</button></div>
    <div class="drawer-scroll">
      <div class="drawer-profile">${avatar}</div>
      <div class="drawer-accounts">${accountRows}${allRow}</div>
      ${viewRows}
      ${folderRows}
    </div>
  </div>`;
}

function onDrawerClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.action === 'settings') return openSettings(ctx);
  if (t.dataset.scope) {
    S.scope = t.dataset.scope;
    if (S.view === 'folder') {
      S.view = 'inbox';
      S.folder = null;
    }
    return changeView();
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
}

function changeView() {
  S.query = '';
  S.searching = false;
  if (window.innerWidth <= 1100) S.drawerOpen = false;
  $('.list-scroll')?.scrollTo(0, 0);
  refresh();
}

// ---------- list ----------

function renderList() {
  // Re-rendering mid-drag would detach the row being swiped; render once the gesture ends.
  if (swipeState.el) {
    swipeState.renderPending = true;
    return;
  }
  const el = $('.listpane');
  const acc = account(S.scope);
  const header = S.searching
    ? `<div class="list-header">
        <button class="icon-btn" data-action="search-close" title="Terug">${icons.back}</button>
        <div class="searchbar">${icons.search}<input id="search" type="search" placeholder="Zoeken" value="${esc(S.query)}" autocomplete="off"/></div>
      </div>`
    : `<div class="list-header">
        <button class="icon-btn" data-action="drawer" title="Menu">${icons.menu}</button>
        <div class="list-title"><h1>${esc(viewLabel())}</h1><div class="sub">${esc(acc ? acc.email : 'Alle accounts')}</div></div>
        <button class="icon-btn" data-action="search" title="Zoeken (Ctrl+E)">${icons.search}</button>
        <button class="icon-btn" data-action="list-more" title="Meer opties">${icons.more}</button>
      </div>`;

  const existingHeader = el.querySelector('.list-header');
  const wantSearch = S.searching;
  const hadSearch = Boolean(existingHeader && existingHeader.querySelector('#search'));
  if (!existingHeader || wantSearch !== hadSearch || !wantSearch) {
    if (existingHeader) existingHeader.outerHTML = header;
    else el.insertAdjacentHTML('afterbegin', header);
    if (wantSearch) {
      const input = $('#search');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  let scroll = el.querySelector('.list-scroll');
  if (!scroll) {
    el.insertAdjacentHTML('beforeend', `<div class="list-scroll" tabindex="0"></div><button class="fab" data-action="compose" title="Opstellen (Ctrl+N)">${icons.compose}</button>`);
    scroll = el.querySelector('.list-scroll');
  }
  scroll.innerHTML = listHtml(acc);
  renderShell();
}

function senderLine(m) {
  if (m.role === 'sent' || m.role === 'drafts') {
    const names = (m.to || []).map(person).filter(Boolean);
    if (m.role === 'drafts') return names.length ? names.join(', ') : '(Geen ontvanger)';
    return names.join(', ') || '(Geen ontvanger)';
  }
  return person(m.from) || '(Onbekende afzender)';
}

function listHtml(acc) {
  if (!S.list.length) {
    const scoped = S.scope === 'all' ? S.data.accounts : [acc];
    const syncing = scoped.some((a) => a.syncing);
    const failed = scoped.find((a) => a.error);
    const msg = S.query ? 'Geen resultaten' : syncing ? 'Bezig met synchroniseren...' : 'Geen e-mails';
    const error = failed && !syncing ? `<p class="error">${esc(failed.email)}: ${esc(failed.error)}</p>` : '';
    return `<div class="empty">${icons.mailOpen}${msg}${error}</div>`;
  }
  const groups = [];
  let current = null;
  for (const m of S.list) {
    const label = S.data.settings.sort === 'date-desc' || S.data.settings.sort === 'date-asc' ? groupLabel(m.date) : null;
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(m);
  }
  const allScope = S.scope === 'all';
  return groups
    .map((g, gi) => {
      const synced =
        gi === 0 && acc && acc.lastSync ? `<span class="synced">Laatste synchronisatie  ${hhmm(acc.lastSync)}</span>` : '';
      const syncingLabel =
        gi === 0 && acc && acc.syncing
          ? '<span class="synced">Synchroniseren...</span>'
          : gi === 0 && acc && acc.error
            ? `<span class="synced error" title="${esc(acc.error)}">Synchronisatie mislukt</span>`
            : synced;
      const head = g.label !== null || syncingLabel ? `<div class="group-head"><span>${esc(g.label || '')}</span>${syncingLabel}</div>` : '';
      return `${head}<div class="group-card">${g.items.map((m) => itemHtml(m, allScope)).join('')}</div>`;
    })
    .join('');
}

function itemHtml(m, allScope) {
  const dot = m.unread ? 'unread' : allScope ? 'read' : '';
  const tags = m.vip ? '<span class="tags"><span class="tag">VIP</span></span>' : '';
  const swipe = S.data.settings.swipeActions
    ? `<div class="swipe-bg read">${icons.mailOpen}<span>${m.unread ? 'Gelezen' : 'Ongelezen'}</span></div>
       <div class="swipe-bg delete"><span>Wissen</span>${icons.trash}</div>`
    : '';
  return `<div class="item-wrap" data-id="${esc(m.id)}">${swipe}
    <div class="item ${m.unread ? 'unread' : ''} ${S.selectedId === m.id ? 'selected' : ''}" data-id="${esc(m.id)}" style="--dot:${m.accountColor || 'var(--accent)'}" role="option" aria-selected="${S.selectedId === m.id}">
      <span class="dot ${dot}"></span>
      <div class="body">
        <div class="sender">${esc(senderLine(m))}${tags}</div>
        <div class="subject">${esc(m.subject || '(Geen onderwerp)')}</div>
        <div class="preview">${esc(m.preview || '')}</div>
      </div>
      <div class="side">
        <div class="meta">${m.hasAttachments ? icons.clip : ''}${listTime(m.date)}</div>
        ${m.role === 'saved' ? '' : `<button class="icon-btn star-btn ${m.starred ? 'on' : ''}" data-star title="${m.starred ? 'Ster verwijderen' : 'Ster toevoegen'}">${m.starred ? icons.starFilled : icons.star}</button>`}
      </div>
    </div>
  </div>`;
}

function bindList() {
  const pane = $('.listpane');
  $('.drawer').addEventListener('click', onDrawerClick);
  pane.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && btn.dataset.action) return listAction(btn.dataset.action, btn);
    if (btn && btn.hasAttribute('data-star')) {
      const id = btn.closest('.item').dataset.id;
      const m = S.list.find((x) => x.id === id);
      if (m) toggleStar(m);
      return;
    }
    const item = e.target.closest('.item');
    if (item && !swipeState.moved) openMessage(item.dataset.id);
  });
  pane.addEventListener('input', (e) => {
    if (e.target.id === 'search') {
      S.query = e.target.value;
      scheduleRefresh();
    }
  });
  pane.addEventListener('keydown', (e) => {
    if (e.target.id === 'search' && e.key === 'Escape') listAction('search-close');
  });
  pane.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    e.preventDefault();
    const m = S.list.find((x) => x.id === item.dataset.id);
    if (m) showMenu(item.querySelector('.meta'), messageMenu(m));
  });
  bindSwipe(pane);
}

function listAction(action, btn) {
  switch (action) {
    case 'drawer':
      S.drawerOpen = !S.drawerOpen;
      return renderShell();
    case 'search':
      S.searching = true;
      return renderList();
    case 'search-close':
      S.searching = false;
      S.query = '';
      return refresh();
    case 'compose':
      return openCompose(ctx, { mode: 'new' });
    case 'list-more':
      return showMenu(btn, [
        { label: 'Alles als gelezen markeren', action: markAllRead },
        { label: 'Synchroniseren', action: syncNow },
        { label: 'Sorteren op', action: chooseSort },
        S.view === 'trash' || S.view === 'junk' ? { label: `${viewLabel()} leegmaken`, action: emptyCurrent, danger: true } : null,
        { label: 'Instellingen', action: () => openSettings(ctx) }
      ]);
  }
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
  const accounts = S.scope === 'all' ? S.data.accounts : [account(S.scope)];
  const ok = await confirmDialog(`${viewLabel()} leegmaken?`, 'Alle e-mails in deze map worden definitief verwijderd.', 'Leegmaken', true);
  if (!ok) return;
  let n = 0;
  for (const a of accounts) {
    const f = a.folders.find((x) => x.role === S.view);
    if (f) n += await api('emptyFolder', a.id, f.path);
  }
  toast(`${n} e-mails verwijderd`);
}

// ---------- swipe ----------

const swipeState = { el: null, startX: 0, startY: 0, dx: 0, moved: false, id: null };
const SWIPE_TRIGGER = 110;

function bindSwipe(pane) {
  pane.addEventListener('pointerdown', (e) => {
    if (!S.data?.settings.swipeActions || e.button !== 0) return;
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
    const read = wrap.querySelector('.swipe-bg.read');
    const del = wrap.querySelector('.swipe-bg.delete');
    const strength = Math.min(1, Math.abs(dx) / SWIPE_TRIGGER);
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
    const m = S.list.find((x) => x.id === id);
    if (dx <= -SWIPE_TRIGGER && m) {
      el.style.transform = 'translateX(-110%)';
      setTimeout(() => deleteMessage(m), 160);
    } else {
      el.style.transform = '';
      el.parentElement.querySelectorAll('.swipe-bg').forEach((b) => (b.style.opacity = 0));
      if (dx >= SWIPE_TRIGGER && m && m.role !== 'saved') setUnread(m, !m.unread);
    }
    flush();
    // Swallow the click that follows a drag.
    setTimeout(() => (st.moved = false), 0);
  };
  pane.addEventListener('pointerup', end);
  pane.addEventListener('pointercancel', end);
}

// ---------- message actions ----------

async function setUnread(m, unread) {
  m.unread = unread;
  renderList();
  try {
    await api('setFlags', m.id, { unread });
  } catch (err) {
    toast(err.message);
  }
}

async function toggleStar(m) {
  m.starred = !m.starred;
  if (S.message && S.message.id === m.id) {
    S.message.starred = m.starred;
    renderReader();
  }
  renderList();
  try {
    await api('setFlags', m.id, { starred: m.starred });
  } catch (err) {
    toast(err.message);
  }
}

function neighbour(id) {
  const i = S.list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  return S.list[i + 1] || S.list[i - 1] || null;
}

export async function deleteMessage(m) {
  const next = S.selectedId === m.id ? neighbour(m.id) : null;
  const permanent = m.role === 'trash' || m.role === 'saved';
  if (permanent) {
    const ok = await confirmDialog('Definitief verwijderen?', 'Deze e-mail wordt definitief verwijderd.', 'Verwijderen', true);
    if (!ok) return renderList();
  }
  S.list = S.list.filter((x) => x.id !== m.id);
  if (S.selectedId === m.id) {
    if (next) openMessage(next.id);
    else closeReader();
  }
  renderList();
  try {
    const where = await api('remove', m.id);
    toast(where === 'trash' ? 'Verplaatst naar Prullenbak' : 'Verwijderd');
  } catch (err) {
    toast(err.message, 5000);
    refresh();
  }
}

async function moveMessage(m) {
  const acc = account(m.accountId);
  const options = acc.folders.filter((f) => f.path !== m.folder && f.role !== 'drafts').map((f) => ({ label: f.name, value: f.path }));
  const dest = await choiceDialog('Verplaatsen naar', options, null);
  if (!dest) return;
  const next = S.selectedId === m.id ? neighbour(m.id) : null;
  S.list = S.list.filter((x) => x.id !== m.id);
  if (S.selectedId === m.id) {
    if (next) openMessage(next.id);
    else closeReader();
  }
  renderList();
  try {
    await api('move', m.id, dest);
    toast(`Verplaatst naar ${options.find((o) => o.value === dest).label}`);
  } catch (err) {
    toast(err.message, 5000);
    refresh();
  }
}

function messageMenu(m) {
  const saved = m.role === 'saved';
  return [
    saved ? null : { label: m.unread ? 'Markeren als gelezen' : 'Markeren als ongelezen', action: () => setUnread(m, !m.unread) },
    saved ? null : { label: m.starred ? 'Ster verwijderen' : 'Ster toevoegen', action: () => toggleStar(m) },
    saved ? null : { label: 'Verplaatsen', action: () => moveMessage(m) },
    {
      label: m.vip ? "Verwijderen uit VIP's" : "Toevoegen aan VIP's",
      action: async () => {
        const on = await api('toggleVip', m.from.address);
        toast(on ? `${person(m.from)} toegevoegd aan VIP's` : `${person(m.from)} verwijderd uit VIP's`);
      }
    },
    saved || m.role === 'sent' || m.role === 'drafts'
      ? null
      : {
          label: 'Toevoegen aan spamadressen',
          action: async () => {
            const ok = await confirmDialog('Toevoegen aan spamadressen?', `E-mails van ${m.from.address} worden niet meer in je Postvak IN getoond.`, 'Toevoegen');
            if (!ok) return;
            if (S.selectedId === m.id) closeReader();
            await api('markSpam', m.id).catch((err) => toast(err.message));
            toast('Toegevoegd aan spamadressen');
          }
        },
    saved
      ? null
      : {
          label: 'Opslaan in Opgeslagen e-mails',
          action: async () => {
            await api('saveToDevice', m.id);
            toast('Opgeslagen in Opgeslagen e-mails');
          }
        },
    {
      label: 'Exporteren als .eml',
      action: async () => {
        const p = await api('exportEml', m.id).catch((err) => toast(err.message));
        if (p) toast('Geëxporteerd');
      }
    },
    { label: 'Afdrukken', action: () => printMessage(m.id) },
    { label: 'Wissen', action: () => deleteMessage(m), danger: true }
  ];
}

async function printMessage(id) {
  const full = S.message && S.message.id === id ? S.message : await api('get', id);
  const head = `<h2 style="font:600 20px Segoe UI,sans-serif;margin:0 0 8px">${esc(full.subject)}</h2>
    <div style="font:13px Segoe UI,sans-serif;color:#444;margin-bottom:16px">Van: ${esc(formatAddress(full.from))}<br>Aan: ${esc(full.to.map(formatAddress).join(', '))}<br>Datum: ${esc(longDate(full.date))}</div><hr>`;
  await api('print', `<!doctype html><meta charset="utf-8"><body style="margin:24px">${head}${full.html}</body>`);
}

// ---------- reader ----------

export async function openMessage(id) {
  const m = S.list.find((x) => x.id === id);
  if (m && m.role === 'drafts') {
    S.selectedId = id;
    renderList();
    const full = await api('get', id).catch((err) => toast(err.message));
    if (full) openCompose(ctx, { mode: 'draft', message: full });
    return;
  }
  S.selectedId = id;
  S.details = false;
  S.loading = true;
  S.message = m ? { ...m, html: null, attachments: [] } : S.message;
  renderShell();
  $$('.item').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
    el.setAttribute('aria-selected', el.dataset.id === id);
  });
  $(`.item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
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
  if (m && m.unread) setUnread(m, false);
}

export function closeReader() {
  S.selectedId = null;
  S.message = null;
  S.expanded = false;
  renderShell();
  renderReader();
  $$('.item.selected').forEach((el) => el.classList.remove('selected'));
}

function renderReaderNav() {
  const i = S.list.findIndex((x) => x.id === S.selectedId);
  const up = $('[data-reader="prev"]');
  const down = $('[data-reader="next"]');
  if (up) up.disabled = i <= 0;
  if (down) down.disabled = i < 0 || i >= S.list.length - 1;
}

function renderReader() {
  const el = $('.reader');
  if (!el) return;
  const m = S.message;
  if (!m) {
    el.innerHTML = `<div class="reader-empty"><div>${icons.mailOpen}Selecteer een e-mail om te lezen</div></div>`;
    return;
  }
  const chips = [m.from].filter(Boolean).map(
    (a) => `<button class="chip" data-copy="${esc(a.address)}" title="${esc(formatAddress(a))}">${esc(person(a))}</button>`
  );
  const addrChips = (list) => (list || []).map((a) => `<span class="chip" title="${esc(a.address)}">${esc(person(a))}</span>`).join('') || '<span class="k">-</span>';
  const details = S.details
    ? `<div class="details">
        <span class="k">Van</span><span class="v"><span class="chip">${esc(formatAddress(m.from))}</span></span>
        <span class="k">Aan</span><span class="v">${addrChips(m.to)}</span>
        ${m.cc && m.cc.length ? `<span class="k">Cc</span><span class="v">${addrChips(m.cc)}</span>` : ''}
        ${m.bcc && m.bcc.length ? `<span class="k">Bcc</span><span class="v">${addrChips(m.bcc)}</span>` : ''}
        <span class="k">Datum</span><span class="v">${esc(longDate(m.date))}</span>
      </div>`
    : '';
  const attachments = (m.attachments || []).length
    ? `<div class="attachments">${m.attachments
        .map(
          (a) => `<div class="attachment">
            <button class="open" data-open-att="${a.index}" title="Openen">${icons.file}<span><div class="name">${esc(a.filename)}</div><div class="size">${fileSize(a.size)}</div></span></button>
            <button class="icon-btn" data-save-att="${a.index}" title="Opslaan">${icons.download}</button>
          </div>`
        )
        .join('')}</div>`
    : '';
  const isSaved = m.role === 'saved';
  el.innerHTML = `
    <div class="reader-top">
      <button class="icon-btn" data-reader="expand" title="${S.expanded ? 'Verkleinen' : 'Vergroten'}">${S.expanded ? icons.collapse : icons.expand}</button>
      <div class="nav">
        <button class="icon-btn" data-reader="prev" title="Vorige">${icons.up}</button>
        <button class="icon-btn" data-reader="next" title="Volgende">${icons.down}</button>
      </div>
    </div>
    <div class="reader-scroll">
      <div class="reader-head">
        <div style="flex:1;min-width:0">
          <h2 class="reader-subject">${esc(m.subject || '(Geen onderwerp)')}</h2>
          <div class="reader-date">${esc(longDate(m.date))}</div>
        </div>
        ${isSaved ? '' : `<button class="icon-btn reader-star ${m.starred ? 'on' : ''}" data-reader="star" title="Ster">${m.starred ? icons.starFilled : icons.star}</button>`}
      </div>
      <div class="sender-row">
        <div class="chips">${chips.join('')}</div>
        <button class="link-btn" data-reader="details">${S.details ? 'Verbergen' : 'Gegevens'}</button>
      </div>
      ${details}
      ${attachments}
      ${m.error ? `<p class="error" style="margin-top:20px">${esc(m.error)}</p>` : S.loading || m.html === null ? '<div class="loading-bar"></div>' : '<iframe class="mail-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Inhoud van e-mail"></iframe>'}
    </div>
    <div class="reader-actions">
      <button class="action" data-reader="reply">${icons.reply}<span>Antwoorden</span></button>
      <button class="action" data-reader="replyAll">${icons.replyAll}<span>Antw. allen</span></button>
      <button class="action" data-reader="forward">${icons.forward}<span>Doorsturen</span></button>
      <button class="action" data-reader="delete">${icons.trash}<span>Wissen</span></button>
      <button class="action" data-reader="more">${icons.more}<span>Meer</span></button>
    </div>`;
  renderReaderNav();
  const frame = el.querySelector('.mail-frame');
  if (frame && m.html !== null && m.html !== undefined) fillFrame(frame, m);
}

export function frameDoc(m, { forQuote = false } = {}) {
  const light = root.classList.contains('light');
  const darkEmails = S.data?.settings.darkEmails !== false;
  const invert = !light && darkEmails && m.isHtml;
  const textColor = light || invert ? '#111111' : '#ececec';
  const link = invert ? '#1a5fd0' : light ? '#2a62e6' : '#7aa5ff';
  const invertCss = invert
    ? `html{filter:invert(1) hue-rotate(180deg);background:#ececec}
       img,picture,video,svg,[style*="background-image"],[background]{filter:invert(1) hue-rotate(180deg)}`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>
html{color:${textColor};background:transparent}
body{margin:0;padding:0 2px 8px;font:15px/1.55 'Segoe UI',system-ui,sans-serif;overflow-wrap:anywhere;${forQuote ? '' : 'overflow:hidden;'}}
a{color:${link}}
img{max-width:100%;height:auto}
pre{white-space:pre-wrap}
blockquote{border-left:3px solid rgba(128,128,128,.45);margin:0 0 0 2px;padding-left:12px}
${invertCss}
</style></head><body>${m.html || ''}</body></html>`;
}

export function fillFrame(frame, m, opts = {}) {
  frame.srcdoc = frameDoc(m, opts);
  frame.addEventListener(
    'load',
    () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const fit = () => {
        const body = doc.body;
        if (!body) return;
        if (S.data?.settings.fitContent !== false) {
          body.style.zoom = '';
          const avail = frame.clientWidth;
          const needed = doc.documentElement.scrollWidth;
          if (needed > avail + 4) body.style.zoom = String(Math.max(0.3, avail / needed));
        }
        frame.style.height = `${Math.ceil(doc.documentElement.scrollHeight * 1) + 4}px`;
      };
      fit();
      new ResizeObserver(fit).observe(doc.body);
      new ResizeObserver(fit).observe(frame);
      doc.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href');
        if (href && !href.startsWith('#')) window.mail.call('openExternal', a.href);
      });
    },
    { once: true }
  );
}

function bindReader() {
  $('#app').addEventListener('click', async (e) => {
    const reader = e.target.closest('.reader');
    if (!reader) return;
    const btn = e.target.closest('button');
    if (!btn) return;
    const m = S.message;
    if (!m) return;
    const listItem = S.list.find((x) => x.id === m.id) || m;
    if (btn.dataset.copy) {
      await navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
      return showMenu(btn, [
        { label: `Nieuwe e-mail aan ${btn.dataset.copy}`, action: () => openCompose(ctx, { mode: 'new', to: [{ name: person(m.from), address: btn.dataset.copy }] }) },
        { label: 'E-mailadres kopiëren', action: () => toast('Gekopieerd') },
        {
          label: m.vip ? "Verwijderen uit VIP's" : "Toevoegen aan VIP's",
          action: async () => {
            const on = await api('toggleVip', btn.dataset.copy);
            toast(on ? "Toegevoegd aan VIP's" : "Verwijderd uit VIP's");
          }
        }
      ]);
    }
    if (btn.dataset.openAtt) {
      return api('openAttachment', m.id, Number(btn.dataset.openAtt)).catch((err) => toast(err.message));
    }
    if (btn.dataset.saveAtt) {
      const p = await api('saveAttachment', m.id, Number(btn.dataset.saveAtt)).catch((err) => toast(err.message));
      if (p) toast('Bijlage opgeslagen');
      return;
    }
    switch (btn.dataset.reader) {
      case 'expand':
        S.expanded = !S.expanded;
        renderShell();
        return renderReader();
      case 'prev':
      case 'next': {
        const i = S.list.findIndex((x) => x.id === m.id);
        const target = S.list[i + (btn.dataset.reader === 'next' ? 1 : -1)];
        if (target) openMessage(target.id);
        return;
      }
      case 'star':
        return toggleStar(listItem);
      case 'details':
        S.details = !S.details;
        return renderReader();
      case 'reply':
      case 'replyAll':
      case 'forward':
        if (!m.html && m.html !== '') return;
        return openCompose(ctx, { mode: btn.dataset.reader, message: m });
      case 'delete':
        return deleteMessage(listItem);
      case 'more':
        return showMenu(btn, messageMenu(listItem), { above: true });
    }
  });
}

// ---------- keyboard ----------

function editing(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
  if (composeOpen() || document.querySelector('.page, .scrim')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    return openCompose(ctx, { mode: 'new' });
  }
  if (ctrl && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    S.searching = true;
    return renderList();
  }
  if (e.key === 'F5') {
    e.preventDefault();
    return syncNow();
  }
  if (editing(e)) return;
  const m = S.message;
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'r' && m) return openCompose(ctx, { mode: 'replyAll', message: m });
  if (ctrl && e.key.toLowerCase() === 'r' && m) {
    e.preventDefault();
    return openCompose(ctx, { mode: 'reply', message: m });
  }
  if (ctrl && e.key.toLowerCase() === 'f' && m) {
    e.preventDefault();
    return openCompose(ctx, { mode: 'forward', message: m });
  }
  if (e.key === 'Delete' && m) {
    const item = S.list.find((x) => x.id === m.id);
    if (item) deleteMessage(item);
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    const i = S.list.findIndex((x) => x.id === S.selectedId);
    const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1;
    const target = S.list[i < 0 ? 0 : i + step];
    if (target) openMessage(target.id);
    return;
  }
  if (e.key === 'Escape' && S.expanded) {
    S.expanded = false;
    renderShell();
    renderReader();
  }
});

// ---------- taskbar badge ----------

function drawBadge(count) {
  if (!count) return api('setBadge', null, 0);
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ea5a1c';
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

function parseMailto(url) {
  const u = new URL(url);
  const to = decodeURIComponent(u.pathname || '')
    .split(',')
    .filter(Boolean)
    .map((address) => ({ name: '', address: address.trim() }));
  return {
    mode: 'new',
    to,
    subject: u.searchParams.get('subject') || '',
    body: u.searchParams.get('body') || ''
  };
}

window.mail.on(async ({ type, payload }) => {
  if (type === 'updated') scheduleRefresh();
  if (type === 'badge') drawBadge(payload);
  if (type === 'theme') {
    applyTheme();
    if (S.message) renderReader();
  }
  if (type === 'open-message') {
    S.scope = 'all';
    S.view = 'inbox';
    S.folder = null;
    await refresh();
    openMessage(payload);
  }
  if (type === 'compose-mailto') {
    try {
      openCompose(ctx, parseMailto(payload));
    } catch (_) {
      openCompose(ctx, { mode: 'new' });
    }
  }
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 1100 && !S.drawerOpen && S.autoClosed) S.drawerOpen = true;
});

// Context shared with the compose, settings and setup pages.
export const ctx = {
  S,
  refresh,
  account,
  openMessage,
  closeReader,
  frameDoc,
  fillFrame,
  openSetup: (opts) => openSetup(ctx, opts),
  openSettings: () => openSettings(ctx)
};

bindReader();
refresh().catch((err) => toast(err.message, 6000));
