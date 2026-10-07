import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';

export const api = (method, ...args) => window.mail.call(method, ...args);

export function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The wordmark in both colourways; styles.css hides the one that does not match the theme.
export const brandLogo = (cls) =>
  `<img class="${cls} brand-dark" src="assets/rukoo-logo-dark.svg" alt="Rukoo Mail"><img class="${cls} brand-light" src="assets/rukoo-logo.svg" alt="Rukoo Mail">`;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const dateFormat = (ts, options) => new Intl.DateTimeFormat(getLocale(), options).format(new Date(ts));

const pad = (n) => String(n).padStart(2, '0');

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function hhmm(ts) {
  return dateFormat(ts, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

// List time: "14:45" today, "5 okt." this year, "05-10-2025" before that.
export function listTime(ts, now = Date.now()) {
  const d = new Date(ts);
  if (startOfDay(ts) === startOfDay(now)) return hhmm(ts);
  if (d.getFullYear() === new Date(now).getFullYear()) return dateFormat(ts, { day: 'numeric', month: 'short' });
  return numericDate(ts);
}

export function groupLabel(ts, now = Date.now()) {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000);
  if (diff <= 0) return t('common.dates.today');
  if (diff === 1) return t('common.dates.yesterday');
  const d = new Date(ts);
  if (diff < 7) return dateFormat(ts, { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
  if (d.getFullYear() === new Date(now).getFullYear()) return dateFormat(ts, { day: 'numeric', month: 'long' });
  return dateFormat(ts, { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase());
}

export function longDate(ts) {
  return `${dateFormat(ts, { day: 'numeric', month: 'long', year: 'numeric' })}  ${hhmm(ts)}`;
}

export function numericDate(ts) {
  return dateFormat(ts, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function quoteDate(ts) {
  const d = new Date(ts);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${numericDate(ts)} ${hhmm(ts)} (GMT${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)})`;
}

export function fileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0 }).format(bytes / 1024)} kB`;
  return `${new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}

export function person(a) {
  if (!a) return '';
  return a.name || a.address || '';
}

export function formatAddress(a) {
  if (!a) return '';
  return a.name ? `${a.name} <${a.address}>` : a.address;
}


// Reader header: "Vandaag 14:45", "Gisteren 09:12" or "di 6 okt. 2026, 14:45".
export function readerDate(ts, now = Date.now()) {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000);
  if (diff === 0) return `${t('common.dates.today')} ${hhmm(ts)}`;
  if (diff === 1) return `${t('common.dates.yesterday')} ${hhmm(ts)}`;
  return `${dateFormat(ts, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, ${hhmm(ts)}`;
}

// ---------- previews ----------

// Newsletters open with "view in browser" lines and mail with a greeting; neither says what it is about.
const PREVIEW_NOISE = [
  /^(bekijk|lees|open|view|read)( (deze|de|het|this|the|onze|our))?( (e-?mail|mail|nieuwsbrief|newsletter|bericht|message))?( (in|online|op|on))?( (je|jouw|uw|de|een|your|a|the))? ?(web)?(browser|versie|version|site|website)\b[.!:]?\s*/i,
  /^(web ?versie|online versie|web version|view online|online bekijken)\b[.!:]?\s*/i,
  /^(problemen met (het )?(weergeven|bekijken|lezen)[^.?!]*[.?!]|(wordt|is) deze (e-?mail|nieuwsbrief) niet goed (weergegeven|leesbaar|zichtbaar)[^.?!]*[.?!]?|having trouble (viewing|reading)[^.?!]*[.?!]?|can'?t see (this|the) (e-?mail|images)[^.?!]*[.?!]?)\s*/i,
  /^(beste|hoi|hallo|hi|hey|hello|dear|geachte|goedemorgen|goedemiddag|goedenavond)\b[^,!\n]{0,40}[,!]\s*/i
];

export function cleanPreview(text) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 4; pass++) {
    const before = out;
    for (const re of PREVIEW_NOISE) out = out.replace(re, '');
    if (out === before) break;
  }
  return out || String(text || '').trim();
}

// ---------- avatars ----------

export function initials(a) {
  const raw = String((a && (a.name || a.address)) || '?')
    .replace(/\(.*?\)|["'<>[\]]/g, ' ')
    .trim();
  const words = a && !a.name && raw.includes('@') ? [raw.split('@')[0]] : raw.split(/[\s._-]+/).filter(Boolean);
  const first = [...(words[0] || '?')];
  const last = words.length > 1 ? [...words[words.length - 1]] : [];
  return (first[0] + (last[0] || first[1] || '')).toUpperCase();
}

export function hue(text) {
  let h = 7;
  for (const c of String(text || '').toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function avatar(a, cls = '') {
  const key = (a && (a.address || a.name)) || '';
  return `<span class="avatar ${cls}" style="--h:${hue(key)}" aria-hidden="true">${esc(initials(a))}</span>`;
}

// ---------- theme ----------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(theme = 'system') {
  const light = theme === 'light' || (theme === 'system' && !darkQuery.matches);
  document.documentElement.classList.toggle('light', light);
  return light;
}

export function onSystemThemeChange(fn) {
  darkQuery.addEventListener('change', fn);
}

export const isLight = () => document.documentElement.classList.contains('light');

// ---------- toast ----------

let toastTimer = null;
let toastAction = null;

function hideToast() {
  document.getElementById('toast')?.classList.remove('show');
  toastAction = null;
}

// opts: a duration in ms, or { ms, action: { label, run } }. A toast with an action stays longer
// and its action also runs on Ctrl+Z (see runToastAction).
export function toast(message, opts = {}) {
  if (typeof opts === 'number') opts = { ms: opts };
  const el = document.getElementById('toast');
  if (!el) return;
  const ms = opts.ms || (opts.action ? 8000 : 2600);
  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  toastAction = opts.action || null;
  if (toastAction) {
    const b = document.createElement('button');
    b.textContent = toastAction.label;
    b.addEventListener('click', runToastAction);
    el.appendChild(b);
  }
  el.classList.toggle('has-action', Boolean(toastAction));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
  el.onmouseenter = () => clearTimeout(toastTimer);
  el.onmouseleave = () => {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 2500);
  };
}

export function runToastAction() {
  const action = toastAction;
  if (!action) return false;
  hideToast();
  action.run();
  return true;
}

// ---------- popover menu ----------

let openMenu = null;
let menuAnchor = null;

export function closeMenu({ refocus = false } = {}) {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  if (refocus && menuAnchor && document.contains(menuAnchor)) menuAnchor.focus();
  menuAnchor = null;
}

export const menuOpen = () => Boolean(openMenu);

// items: [{ label, action, icon, shortcut, danger, checked, disabled }] or { separator: true } or { heading }.
// Opens below the anchor element, or at { x, y } for context menus.
export function showMenu(anchor, items, { above = false, at = null, align = 'right' } = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  const list = items.filter(Boolean);
  list.forEach((item, i) => {
    if (item.separator) {
      if (i > 0 && i < list.length - 1 && !list[i - 1].separator) menu.insertAdjacentHTML('beforeend', '<div class="menu-sep" role="separator"></div>');
      return;
    }
    if (item.heading) {
      menu.insertAdjacentHTML('beforeend', `<div class="menu-heading">${esc(item.heading)}</div>`);
      return;
    }
    const b = document.createElement('button');
    b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (item.checked !== undefined) b.setAttribute('aria-checked', String(Boolean(item.checked)));
    b.className = `${item.danger ? 'danger' : ''} ${item.current ? 'current' : ''}`;
    if (item.current) b.setAttribute('aria-current', 'true');
    b.disabled = Boolean(item.disabled);
    const lead = item.checked !== undefined ? (item.checked ? icons.check : '') : item.icon ? icons[item.icon] || item.icon : '';
    b.innerHTML = `<span class="mi">${lead}</span><span class="ml">${esc(item.label)}</span>${item.hint ? `<span class="mh">${esc(item.hint)}</span>` : ''}${
      item.shortcut ? `<kbd>${esc(item.shortcut)}</kbd>` : ''
    }`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      item.action();
    });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left;
  let top;
  if (at) {
    left = Math.min(at.x, window.innerWidth - mw - 8);
    top = at.y + mh > window.innerHeight - 8 ? Math.max(8, at.y - mh) : at.y;
    menu.style.transformOrigin = 'top left';
  } else {
    const r = anchor.getBoundingClientRect();
    left = align === 'left' ? r.left : r.right - mw;
    top = above ? r.top - mh - 6 : r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(48, r.top - mh - 6);
    menu.style.transformOrigin = `${above ? 'bottom' : 'top'} ${align === 'left' ? 'left' : 'right'}`;
  }
  menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - mw - 8))}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  openMenu = menu;
  menuAnchor = anchor || null;
  menu.addEventListener('keydown', (e) => {
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      buttons[(i + step + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      buttons[e.key === 'Home' ? 0 : buttons.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu({ refocus: true });
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  });
  menu.querySelector('button:not(:disabled)')?.focus();
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
window.addEventListener('blur', () => closeMenu());
window.addEventListener('resize', () => closeMenu());

// ---------- dialogs ----------

export function dialog({ title, body = '', buttons = [{ get label() { return t('common.actions.ok'); }, value: true }], render, wide = false }) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="dialog ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" ${title ? 'aria-labelledby="dialog-title"' : ''}>
      ${title ? `<h2 id="dialog-title">${esc(title)}</h2>` : ''}
      <div class="dialog-body">${body}</div>
      <div class="buttons">${buttons
        .map((b, i) => `<button data-i="${i}" class="${b.danger ? 'danger' : ''} ${b.primary ? 'primary' : ''}">${esc(b.label)}</button>`)
        .join('')}</div>
    </div>`;
    const done = (value) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      if (before && document.contains(before)) before.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
      // Keep Tab inside the dialog.
      if (e.key === 'Tab') {
        const items = [...scrim.querySelectorAll('button, input, textarea, select')].filter((x) => !x.disabled);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) done(null);
    });
    scrim.querySelectorAll('.buttons button').forEach((b) =>
      b.addEventListener('click', () => {
        const btn = buttons[Number(b.dataset.i)];
        done(typeof btn.value === 'function' ? btn.value(scrim) : btn.value);
      })
    );
    document.body.appendChild(scrim);
    if (render) render(scrim.querySelector('.dialog-body'), done);
    (scrim.querySelector('input, textarea') || scrim.querySelector('.buttons button:last-child'))?.focus();
  });
}

export function confirmDialog(title, message, okLabel = t('common.actions.ok'), danger = false) {
  return dialog({
    title,
    body: `<p>${esc(message)}</p>`,
    buttons: [
      { get label() { return t('common.actions.cancel'); }, value: false },
      { label: okLabel, value: true, danger, primary: !danger }
    ]
  });
}

export function choiceDialog(title, options, current) {
  return dialog({
    title,
    buttons: [{ get label() { return t('common.actions.cancel'); }, value: null }],
    render(body, done) {
      body.innerHTML = `<div class="choices" role="radiogroup">${options
        .map(
          (o, i) =>
            `<button class="radio-row" role="radio" aria-checked="${o.value === current}" data-i="${i}"><span class="radio ${o.value === current ? 'on' : ''}"></span><span class="rl">${esc(o.label)}</span>${
              o.hint ? `<span class="rh">${esc(o.hint)}</span>` : ''
            }</button>`
        )
        .join('')}</div>`;
      body.querySelectorAll('.radio-row').forEach((b) =>
        b.addEventListener('click', () => done(options[Number(b.dataset.i)].value))
      );
      setTimeout(() => (body.querySelector('.radio.on')?.parentElement || body.querySelector('.radio-row'))?.focus(), 0);
    }
  });
}

export function icon(name) {
  return icons[name] || '';
}
