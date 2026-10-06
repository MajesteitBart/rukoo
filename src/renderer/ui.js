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

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

const pad = (n) => String(n).padStart(2, '0');

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function hhmm(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// List time: "14:45" today, "5 okt." this year, "05-10-2025" before that.
export function listTime(ts, now = Date.now()) {
  const d = new Date(ts);
  if (startOfDay(ts) === startOfDay(now)) return hhmm(ts);
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}.`;
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

export function groupLabel(ts, now = Date.now()) {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000);
  if (diff <= 0) return 'Vandaag';
  if (diff === 1) return 'Gisteren';
  const d = new Date(ts);
  if (diff < 7) return DAYS[d.getDay()].replace(/^./, (c) => c.toUpperCase());
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${MONTHS[d.getMonth()].replace(/^./, (c) => c.toUpperCase())} ${d.getFullYear()}`;
}

export function longDate(ts) {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}  ${hhmm(ts)}`;
}

export function numericDate(ts) {
  const d = new Date(ts);
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
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
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function person(a) {
  if (!a) return '';
  return a.name || a.address || '';
}

export function formatAddress(a) {
  if (!a) return '';
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

// ---------- toast ----------

let toastTimer = null;
export function toast(message, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- popover menu ----------

let openMenu = null;

export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

// items: [{label, action, danger}] ; anchor: element the menu hangs from.
export function showMenu(anchor, items, { above = false } = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  for (const item of items.filter(Boolean)) {
    const b = document.createElement('button');
    b.textContent = item.label;
    b.setAttribute('role', 'menuitem');
    if (item.danger) b.className = 'danger';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      item.action();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = above ? r.top - mh - 6 : r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(48, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = above ? 'bottom right' : 'top right';
  openMenu = menu;
  menu.querySelector('button')?.focus();
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});

// ---------- dialogs ----------

export function dialog({ title, body = '', buttons = [{ label: 'OK', value: true }], render }) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      ${title ? `<h2>${esc(title)}</h2>` : ''}
      <div class="dialog-body">${body}</div>
      <div class="buttons">${buttons
        .map((b, i) => `<button data-i="${i}" class="${b.danger ? 'danger' : ''}">${esc(b.label)}</button>`)
        .join('')}</div>
    </div>`;
    const done = (value) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
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

export function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return dialog({
    title,
    body: `<p>${esc(message)}</p>`,
    buttons: [
      { label: 'Annuleren', value: false },
      { label: okLabel, value: true, danger }
    ]
  });
}

export function choiceDialog(title, options, current) {
  return dialog({
    title,
    buttons: [{ label: 'Annuleren', value: null }],
    render(body, done) {
      body.innerHTML = options
        .map(
          (o, i) =>
            `<button class="radio-row" data-i="${i}"><span class="radio ${o.value === current ? 'on' : ''}"></span><span>${esc(o.label)}</span></button>`
        )
        .join('');
      body.querySelectorAll('.radio-row').forEach((b) =>
        b.addEventListener('click', () => done(options[Number(b.dataset.i)].value))
      );
    }
  });
}

export function icon(name) {
  return icons[name] || '';
}
