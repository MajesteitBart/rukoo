// What the inbox sorting is doing, in the sidebar: a line above the sync status while Jev works through the inbox,
// waits for TypeSafe or can't use its key, and a panel with the progress and Jev's last decisions. The main process
// tells every change (categories/index.js, activity()).
import { t } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, hhmm, $ } from './ui.js';

// How long "Sorted 48 emails" stays after a sort someone asked for.
const DONE_SHOWS = 6000;
// A sort nobody asked for, of new mail, shows once it takes this long; a quick one doesn't flash by.
const QUIET_FOR = 1500;

let activity = null;
let categories = null;
let hooks = { settings: () => {}, open: () => {} };
let panel = null;
let anchor = null;
let timer = null;
// Decisions the panel already showed, so only new ones slide in.
const shown = new Set();

// hooks: settings() opens Settings > Inbox categories; open(id, category) opens an email Jev sorted.
export function initSortActivity(h) {
  hooks = { ...hooks, ...h };
  api('categoriesActivity')
    .then((a) => setActivity(a))
    .catch(() => {});
}

export function setActivity(next) {
  activity = next;
  paint();
}

// The categories state (S.categories): whether they are on, and the names and colors of the decisions.
export function setCategories(next) {
  categories = next;
  paint();
}

// sorting, done, waiting (for a busy or unreachable TypeSafe), key (refused), or null for nothing to show.
function status(now = Date.now()) {
  const a = activity;
  if (!a || !categories || !categories.enabled) return null;
  if (a.running && (a.user || now - a.startedAt >= QUIET_FOR)) return 'sorting';
  if (a.error === 'key') return 'key';
  if (a.error && a.waiting) return 'waiting';
  if (!a.running && a.user && a.finishedAt && now - a.finishedAt < DONE_SHOWS) return 'done';
  return null;
}

// The status changes by itself when a quiet sort has taken long enough, or "Sorted" has shown long enough.
function schedule() {
  clearTimeout(timer);
  const a = activity;
  if (!a) return;
  const now = Date.now();
  const at = a.running && !a.user ? a.startedAt + QUIET_FOR : !a.running && a.user && a.finishedAt ? a.finishedAt + DONE_SHOWS : 0;
  if (at > now) timer = setTimeout(paint, at - now + 20);
}

const fraction = (a) => (a.total ? Math.min(1, a.done / a.total) : 0);
// Before Jev's first answer the ring turns, so the line doesn't look stuck at nothing.
const starting = (a) => Boolean(a && a.running && a.asked && !a.answered);

function ring(p) {
  return `<span class="sort-ring" aria-hidden="true"><svg viewBox="0 0 16 16"><circle class="track" cx="8" cy="8" r="6"/><circle class="fill" cx="8" cy="8" r="6" pathLength="100" style="stroke-dasharray:${Math.round(p * 100)} 100"/></svg></span>`;
}

function line(s) {
  const a = activity;
  switch (s) {
    case 'sorting':
      return { lead: ring(fraction(a)), text: t(a.asked ? 'categories.activity.sortingJev' : 'categories.activity.sorting'), count: `${a.done}/${a.total}` };
    case 'done':
      return { lead: icons.check, text: a.sorted ? t('categories.activity.sorted', { count: a.sorted }) : t('categories.activity.nothing'), count: '' };
    case 'waiting':
      return { lead: icons.clock, text: a.retryAt ? t('categories.activity.waitingUntil', { time: hhmm(a.retryAt) }) : t('categories.activity.waitingTitle'), count: String(a.waiting) };
    case 'key':
      return { lead: icons.info, text: t('categories.activity.keyRefused'), count: '' };
  }
  return null;
}

// The sidebar's line, for sidebarFoot(); empty when there is nothing to tell.
export function sortStatusHtml() {
  const s = status();
  schedule();
  if (!s) return '<div class="sort-slot"></div>';
  const l = line(s);
  return `<div class="sort-slot"><button class="sort-status ${s}${s === 'sorting' && starting(activity) ? ' starting' : ''}" data-action="sort-activity" data-state="${s}" title="${esc(t('categories.activity.show'))}" aria-haspopup="dialog">
    <span class="lead">${l.lead}</span><span class="t">${esc(l.text)}</span><span class="n">${esc(l.count)}</span></button></div>`;
}

// Brings the sidebar's line and the panel up to date, in place, so the ring and the bar move instead of jumping.
function paint() {
  const slot = $('.sort-slot');
  if (slot) {
    const s = status();
    const button = slot.querySelector('.sort-status');
    if (s && button && button.dataset.state === s) {
      const l = line(s);
      button.querySelector('.t').textContent = l.text;
      button.querySelector('.n').textContent = l.count;
      const fill = button.querySelector('.sort-ring .fill');
      if (fill) fill.style.strokeDasharray = `${Math.round(fraction(activity) * 100)} 100`;
      button.classList.toggle('starting', s === 'sorting' && starting(activity));
      schedule();
    } else slot.outerHTML = sortStatusHtml();
  }
  if (panel) paintPanel();
}

// ---------- the panel ----------

function minutesLeft(a, now = Date.now()) {
  if (!a.running || a.answered < 6 || now - a.startedAt < 5000) return '';
  const perEmail = (now - a.startedAt) / a.answered;
  const seconds = ((a.asked - a.answered) * perEmail) / 1000;
  if (seconds < 60) return t('categories.activity.lessThanMinute');
  return t('categories.activity.minutesLeft', { count: Math.round(seconds / 60) });
}

function headHtml(s) {
  const a = activity || {};
  if (s === 'sorting') {
    const eta = minutesLeft(a);
    return `<h3>${esc(t(a.asked ? 'categories.activity.titleJev' : 'categories.activity.titleSorting'))}</h3>
      <p class="sa-sub"><span class="sa-count">${esc(t('categories.activity.progress', { done: a.done, total: a.total }))}</span>${eta ? ` · ${esc(eta)}` : ''}</p>
      <div class="sa-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${a.total}" aria-valuenow="${a.done}"><span style="width:${(fraction(a) * 100).toFixed(1)}%"></span></div>`;
  }
  if (s === 'waiting' || s === 'key') {
    const why =
      s === 'key'
        ? t('categories.activity.keyText')
        : `${t(a.error === 'busy' ? 'categories.activity.busy' : 'categories.activity.network')}${a.retryAt ? ` ${t('categories.activity.retryAt', { time: hhmm(a.retryAt) })}` : ''}`;
    return `<h3>${esc(t(s === 'key' ? 'categories.activity.keyRefused' : 'categories.activity.waitingTitle'))}</h3>
      <p class="sa-sub">${esc(why)}</p>
      ${a.waiting ? `<p class="sa-sub">${esc(t('categories.activity.waitingCount', { count: a.waiting }))}</p>` : ''}`;
  }
  return `<h3>${esc(t('categories.activity.titleDone'))}</h3>
    <p class="sa-sub">${esc(a.finishedAt && a.user ? `${a.sorted ? t('categories.activity.sorted', { count: a.sorted }) : t('categories.activity.nothing')}. ` : '')}${esc(t(a.jev ? 'categories.activity.newMailJev' : 'categories.activity.newMail'))}</p>`;
}

function recentHtml() {
  const list = (activity && activity.recent) || [];
  if (!list.length) return '';
  const byId = new Map(((categories && categories.categories) || []).map((c) => [c.id, c]));
  const rows = list
    .map((r) => {
      const c = byId.get(r.category);
      const chose = byId.get(r.chose);
      const key = `${r.id}|${r.at}`;
      const fresh = panel && panel.dataset.ready && !shown.has(key);
      shown.add(key);
      const pct = Math.round(r.confidence * 100);
      const how = r.sure ? t('categories.activity.sure', { percent: pct }) : t('categories.activity.unsure', { name: (chose && chose.name) || '', percent: pct });
      return `<button class="sa-item${fresh ? ' fresh' : ''}" data-sa-open="${esc(r.id)}" data-sa-category="${esc(r.category)}">
        <span class="sa-subject">${esc(r.subject || t('mailbox.message.noSubject'))}</span>
        ${c ? `<span class="sa-cat" style="--cat:${esc(c.color)}"><span class="cdot"></span>${esc(c.name)}</span>` : '<span></span>'}
        <span class="sa-meta">${esc(r.from)}${r.from ? ' · ' : ''}${esc(how)}</span>
      </button>`;
    })
    .join('');
  return `<div class="sa-heading">${esc(t('categories.activity.recent'))}</div><div class="sa-list">${rows}</div>`;
}

function paintPanel() {
  const s = status() || 'idle';
  const showNote = s === 'sorting' || s === 'waiting' || s === 'key';
  panel.innerHTML = `<div class="sa-head">${headHtml(s)}</div>
    ${recentHtml()}
    <div class="sa-foot">${showNote ? `<p>${esc(t('categories.activity.meanwhile'))}</p>` : '<span></span>'}
      <button class="btn ghost sm" data-sa="settings">${esc(t(s === 'key' ? 'categories.activity.checkKey' : 'categories.activity.settings'))}</button></div>`;
  panel.dataset.ready = '1';
  place();
}

function place() {
  if (!panel) return;
  // The sidebar draws itself again now and then; the panel stays with the line, or where it was once it's gone.
  if (!anchor || !document.contains(anchor)) anchor = $('[data-action="sort-activity"]');
  if (!anchor) return;
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const collapsed = Boolean(anchor.closest('.shell.collapsed'));
  panel.style.left = `${collapsed ? r.right + 8 : r.left}px`;
  panel.style.bottom = `${window.innerHeight - (collapsed ? r.bottom : r.top - 6)}px`;
}

export function closeSortPanel() {
  if (!panel) return;
  panel.remove();
  panel = null;
  if (anchor && document.contains(anchor)) anchor.setAttribute('aria-expanded', 'false');
  anchor = null;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', escape, true);
  window.removeEventListener('resize', place);
}

function outside(e) {
  if (panel && !panel.contains(e.target) && !e.target.closest('[data-action="sort-activity"]')) closeSortPanel();
}

function escape(e) {
  if (e.key !== 'Escape' || !panel) return;
  e.preventDefault();
  e.stopPropagation();
  const back = anchor;
  closeSortPanel();
  if (back && document.contains(back)) back.focus();
}

// Opens the panel above the sidebar's line, or closes it when it is open.
export function toggleSortPanel(button) {
  if (panel) return closeSortPanel();
  anchor = button || $('[data-action="sort-activity"]');
  panel = document.createElement('div');
  panel.className = 'sort-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('categories.activity.show'));
  for (const r of (activity && activity.recent) || []) shown.add(`${r.id}|${r.at}`);
  document.body.appendChild(panel);
  paintPanel();
  panel.addEventListener('click', (e) => {
    const open = e.target.closest('[data-sa-open]');
    if (open) {
      closeSortPanel();
      return hooks.open(open.dataset.saOpen, open.dataset.saCategory);
    }
    if (e.target.closest('[data-sa="settings"]')) {
      closeSortPanel();
      hooks.settings();
    }
  });
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', escape, true);
  window.addEventListener('resize', place);
}

export const sortPanelOpen = () => Boolean(panel);
