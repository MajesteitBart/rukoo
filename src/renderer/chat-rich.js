import { t, getLocale } from './i18n.js';
import { icons, emojiGroupIcons } from './icons.js';
import { fileSize } from './ui.js';
import { h } from './agent/bui.js';
import { parse } from './chat-markdown.js';
import { fileLayout, fitBox, fileKind, cardImage, reactionNames, REACTION_LIMIT, VIEWABLE } from './chat-model.js';
import { FORMATS, SHORTCUTS } from './chat-format.js';

// Team chat's rich messages (contract 3.3 to 3.6, 5.2): a message's Markdown as DOM, its files, link cards and
// reactions, the image viewer, the emoji picker, and the composer's formatting bar and file tray. chat-view.js and
// chat-input.js put these together; this module only builds them and calls back.
//
// Everything here shows what people wrote or sent: their text, file names, link titles. It reaches the DOM through
// h()'s text prop and text nodes, never as HTML. Icons are the app's own static markup.

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Rukoo in the browser (src/web): a page can't open a file in an app on the computer, so Open shows an image in a new
// tab and downloads anything else, and Save is the browser's download (src/web/host.js chatFile).
const WEB = window.mail?.platform === 'web';

export function svg(name) {
  const tpl = document.createElement('template');
  tpl.innerHTML = icons[name] || '';
  return tpl.content.firstElementChild;
}

// ---------- Markdown (contract 3.3) ----------

// A message of one to three emoji and nothing else shows them larger, as Slack does.
const ONLY_EMOJI = /^(?:\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️|‍\p{Extended_Pictographic})*\s*){1,3}$/u;

// text and mentions as the log shows them: the blocks of chat-markdown.js parse() as DOM, in a div.ch-text that people
// can select. opts: { me, blocked, nameOf(actorId) } for the mentions' tooltips.
export function textEl(text, mentions, { me = null, blocked = false, nameOf = () => '' } = {}) {
  const div = h('div', { class: 'ch-text sel' });
  const s = typeof text === 'string' ? text : '';
  let blocks;
  try {
    blocks = parse(s, mentions, { me, blocked });
  } catch (_) {
    // A text the parser can't take still shows, as it was written.
    blocks = [{ type: 'paragraph', lines: s.split('\n').map((line) => [{ type: 'text', text: line }]) }];
  }
  for (const b of blocks || []) {
    const el = blockEl(b, nameOf);
    if (el) div.append(el);
  }
  if (s.trim() && ONLY_EMOJI.test(s.trim())) div.classList.add('is-jumbo');
  return div;
}

// Lines of inline content, one text node of "\n" between them: the text reads back as it was written
// (textContent), and .ch-text's pre-wrap breaks the line.
function linesInto(el, lines, nameOf) {
  (lines || []).forEach((line, i) => {
    if (i) el.append('\n');
    inlineInto(el, line, nameOf);
  });
  return el;
}

function blockEl(b, nameOf) {
  switch (b && b.type) {
    case 'paragraph':
      return linesInto(h('p', { class: 'ch-p' }), b.lines, nameOf);
    case 'heading':
      return inlineInto(h('p', { class: `ch-h is-${Math.min(3, Math.max(1, b.level || 1))}`, role: 'heading', 'aria-level': String(Math.min(3, Math.max(1, b.level || 1)) + 2) }), b.content, nameOf);
    case 'quote':
      return linesInto(h('blockquote', { class: 'ch-quote' }), b.lines, nameOf);
    case 'list':
      return listEl(b, nameOf);
    case 'code':
      return h('pre', { class: 'ch-pre' }, h('code', { text: String(b.text ?? '') }));
    default:
      return null;
  }
}

// A list with nested levels: an item deeper than the one before opens a list inside that item. A nested item keeps its
// own kind (chat-markdown.js gives each item ordered and number), so "1. step" with "- detail" under it nests bullets.
function listEl(b, nameOf) {
  const make = (ordered, start) => {
    const el = h(ordered ? 'ol' : 'ul', { class: 'ch-list' });
    if (ordered && Number.isSafeInteger(start) && start !== 1) el.setAttribute('start', String(start));
    return el;
  };
  const root = make(Boolean(b.ordered), b.start);
  const stack = [{ list: root, depth: 0, ordered: Boolean(b.ordered), last: null }];
  for (const item of b.items || []) {
    const depth = Math.max(0, Math.min(2, item.depth || 0));
    const ordered = typeof item.ordered === 'boolean' ? item.ordered : Boolean(b.ordered);
    while (stack.length > 1 && stack[stack.length - 1].depth > depth) stack.pop();
    let top = stack[stack.length - 1];
    while (depth > top.depth && top.last) {
      const inner = make(ordered, item.number);
      top.last.append(inner);
      top = { list: inner, depth: top.depth + 1, ordered, last: null };
      stack.push(top);
    }
    // A nested run of the other kind starts a list of its own under the same item.
    if (top.depth > 0 && top.ordered !== ordered && top.list.parentElement) {
      const inner = make(ordered, item.number);
      top.list.parentElement.append(inner);
      top = { list: inner, depth: top.depth, ordered, last: null };
      stack[stack.length - 1] = top;
    }
    const li = inlineInto(h('li'), item.content, nameOf);
    top.list.append(li);
    top.last = li;
  }
  return root;
}

function inlineInto(el, list, nameOf) {
  for (const n of list || []) {
    const node = inlineEl(n, nameOf);
    if (node) el.append(node);
  }
  return el;
}

function inlineEl(n, nameOf) {
  switch (n && n.type) {
    case 'text':
      return document.createTextNode(String(n.text ?? ''));
    case 'code':
      return h('code', { class: 'ch-code', text: String(n.text ?? '') });
    case 'strong':
      return inlineInto(h('strong'), n.children, nameOf);
    case 'em':
      return inlineInto(h('em'), n.children, nameOf);
    case 'strike':
      return inlineInto(h('s'), n.children, nameOf);
    case 'link': {
      const a = h('a', { class: 'ch-link', href: String(n.href || ''), target: '_blank', rel: 'noopener noreferrer' });
      inlineInto(a, n.children, nameOf);
      // A label that isn't the address says where it goes on hover.
      if (a.textContent !== n.href) a.title = n.href;
      return a;
    }
    case 'mention':
      return h('span', { class: n.me ? 'ch-mention is-me' : 'ch-mention', title: nameOf(n.actor) || null, text: String(n.text ?? '') });
    default:
      return null;
  }
}

// ---------- reactions (contract 3.6) ----------

const nameList = (names) => new Intl.ListFormat(getLocale(), { type: 'conjunction', style: 'long' }).format(names);

// Who reacted with group's emoji, as a sentence for its tooltip and accessible name.
export function reactionWho(group, { me, members }) {
  const { names, more } = reactionNames(group, { me, members, t });
  const count = (group.actors || []).length;
  const list = more ? t('chat.react.namesMore', { names: names.join(', '), count: more }) : nameList(names);
  return t('chat.react.who', { names: list, emoji: group.emoji, count });
}

// The row of reactions under a message: a chip per emoji with its count, marked when it holds yours, and the add
// button. opts: { me, members, canAdd, onToggle(emoji, on), onAdd(button) }.
export function reactionsEl(reactions, { me, members, canAdd = true, onToggle, onAdd }) {
  const row = h('div', { class: 'ch-reacts', role: 'group', 'aria-label': t('chat.react.label') });
  for (const g of reactions || []) {
    const actors = Array.isArray(g.actors) ? g.actors : [];
    if (!actors.length) continue;
    const mine = actors.includes(me);
    const who = reactionWho(g, { me, members });
    const chip = h(
      'button',
      { type: 'button', class: `ch-react${mine ? ' is-mine' : ''}`, 'data-emoji': g.emoji, 'data-roving': '', tabindex: '-1', 'aria-pressed': String(mine), 'aria-label': who, title: who },
      h('span', { class: 'ch-react-e', 'aria-hidden': 'true', text: g.emoji }),
      h('span', { class: 'ch-react-n', 'aria-hidden': 'true', text: String(actors.length) })
    );
    chip.addEventListener('click', () => onToggle && onToggle(g.emoji, !mine));
    row.append(chip);
  }
  if (canAdd && (reactions || []).length < REACTION_LIMIT) {
    const add = h('button', { type: 'button', class: 'ch-react-add', 'data-roving': '', tabindex: '-1', 'aria-label': t('chat.react.add'), title: t('chat.react.add') }, svg('smilePlus'));
    add.addEventListener('click', () => onAdd && onAdd(add));
    row.append(add);
  }
  return row;
}

// ---------- files (contract 3.6) ----------

const KIND_ICONS = { image: 'image', pdf: 'filePdf', video: 'fileVideo', audio: 'fileAudio', archive: 'fileArchive', sheet: 'fileSheet', slides: 'fileSlides', doc: 'fileText', text: 'fileText', file: 'file' };
export const fileIcon = (file) => KIND_ICONS[fileKind(file)] || 'file';

// An image's address from main (chatFile 'view'), loaded when its tile comes near the view: a log full of images
// doesn't download them all at once. The addresses stay for the session, so a row drawn again doesn't ask again.
const imageUrls = new Map();
let lazy = null;
const pending = new WeakMap();
function observeImage(img, load) {
  if (!lazy) {
    lazy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          lazy.unobserve(e.target);
          const run = pending.get(e.target);
          pending.delete(e.target);
          if (run) run();
        }
      },
      { rootMargin: '600px 0px' }
    );
  }
  pending.set(img, load);
  lazy.observe(img);
}

// The promise of file's address: the one kept for the session, else a new one from url(file).
function imageUrl(file, url) {
  let p = imageUrls.get(file.id);
  if (!p && url) {
    p = Promise.resolve()
      .then(() => url(file))
      .then((r) => (r && typeof r.url === 'string' ? r.url : typeof r === 'string' ? r : null));
    imageUrls.set(file.id, p);
  }
  return Promise.resolve(p);
}
// An address that failed is asked for again next time, unless another one replaced it meanwhile.
const forgetUrl = (file, p) => {
  if (imageUrls.get(file.id) === p) imageUrls.delete(file.id);
};

// Puts the picture of file into img once it's near the view. url(file) answers main's address for it. The tile shows
// a quiet placeholder until then, and an icon when the file can't load. A kept address can stop working: the file left
// the download cache (files.js trim), which takes its address with it. So a picture that doesn't load asks main once
// more, which downloads it again, before the tile gives up.
export function loadImage(img, file, url) {
  const box = img.parentElement;
  let tries = 0;
  const run = () => {
    tries += 1;
    const p = imageUrl(file, url);
    const failed = () => {
      forgetUrl(file, p);
      if (box) box.classList.add('is-failed');
    };
    p.then((src) => {
      if (!src) return failed();
      img.onload = () => box && box.classList.add('is-loaded');
      img.onerror = () => {
        forgetUrl(file, p);
        if (tries < 2) run();
        else failed();
      };
      img.src = src;
    }, failed);
  };
  if (imageUrls.get(file.id)) run();
  else observeImage(img, run);
}

// A message's files: images in a grid, other files as cards (contract 3.6). opts:
//   pending          an unsent message's files: they show, and nothing opens yet
//   url(file)        main's address of an image (chatFile 'view')
//   onView(images, i)  an image was clicked: the viewer
//   onOpen(file, el), onSave(file, el)  a file card or its download button
export function filesEl(files, { pending: unsent = false, url, onView, onOpen, onSave } = {}) {
  const { images, allImages, more, files: rest } = fileLayout(files);
  const wrap = h('div', { class: 'ch-files' });
  if (images.length && !unsent) {
    const grid = h('div', { class: `ch-media is-n${images.length}` });
    if (images.length === 1) {
      const box = fitBox(images[0].width, images[0].height);
      grid.style.setProperty('--w', `${box.width}px`);
      grid.style.setProperty('--ar', `${box.width} / ${box.height}`);
    }
    images.forEach((f, i) => {
      const extra = i === 3 && more ? more : 0;
      const label = extra ? t('chat.files.openImageMore', { name: f.name, count: extra }) : t('chat.files.openImage', { name: f.name });
      const img = h('img', { alt: f.name || '', draggable: 'false' });
      const tile = h('button', { type: 'button', class: 'ch-img', 'data-file': f.id, 'data-roving': '', tabindex: '-1', 'aria-label': label, title: f.name || '' }, h('span', { class: 'ch-img-ph', 'aria-hidden': 'true' }, svg('image')), img);
      if (extra) tile.append(h('span', { class: 'ch-img-more', 'aria-hidden': 'true', text: `+${extra}` }));
      tile.addEventListener('click', () => onView && onView(allImages, i));
      grid.append(tile);
      if (url) loadImage(img, f, url);
    });
    wrap.append(grid);
  }
  const cards = unsent ? [...allImages, ...rest] : rest;
  if (cards.length) {
    const list = h('div', { class: 'ch-file-list' });
    for (const f of cards) list.append(fileCard(f, { unsent, onOpen, onSave }));
    wrap.append(list);
  }
  return wrap;
}

function fileCard(f, { unsent, onOpen, onSave }) {
  const meta = fileSize(Number(f.size) || 0);
  const tile = h('span', { class: 'ch-file-ic', 'aria-hidden': 'true' }, svg(fileIcon(f)));
  const text = h('span', { class: 'ch-file-text' }, h('span', { class: 'ch-file-name', text: f.name || '', title: f.name || '' }), h('span', { class: 'ch-file-meta', text: meta }));
  if (unsent) return h('div', { class: 'ch-file is-unsent', 'data-file': f.id }, tile, text);
  const label = { name: f.name || '', size: meta };
  const tab = WEB && VIEWABLE.has(String(f.type || '').toLowerCase());
  const openLabel = WEB ? t(tab ? 'chat.files.webOpenImage' : 'chat.files.webOpen', label) : t('chat.files.open', label);
  const openTitle = WEB ? t(tab ? 'chat.files.webOpenImageTitle' : 'chat.files.webOpenTitle') : t('chat.files.openTitle');
  const open = h('button', { type: 'button', class: 'ch-file-main', 'data-roving': '', tabindex: '-1', 'aria-label': openLabel, title: openTitle }, tile, text);
  const save = h('button', { type: 'button', class: 'ch-file-dl', 'data-roving': '', tabindex: '-1', 'aria-label': t('chat.files.save', { name: f.name || '' }), title: t('chat.files.saveTitle') }, svg('download'));
  const card = h('div', { class: 'ch-file', 'data-file': f.id }, open, save);
  open.addEventListener('click', () => onOpen && onOpen(f, card));
  save.addEventListener('click', () => onSave && onSave(f, card));
  return card;
}

// A file card waits for main while a file downloads to open or save: its icon spins and its buttons rest.
export async function busyCard(card, work) {
  if (!card || card.classList.contains('is-busy')) return work();
  card.classList.add('is-busy');
  card.setAttribute('aria-busy', 'true');
  const ic = card.querySelector('.ch-file-ic');
  const was = ic ? [...ic.childNodes] : [];
  if (ic) ic.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  try {
    return await work();
  } finally {
    card.classList.remove('is-busy');
    card.removeAttribute('aria-busy');
    if (ic) ic.replaceChildren(...was);
  }
}

// ---------- link cards (contract 2.7, 3.6) ----------

// The cards under a message's text: the site, the title as the link, two lines of description and the image beside
// it, or under it when it's wide. opts: { canRemove, onRemove(url), url(file) }.
export function cardsEl(previews, { canRemove = false, onRemove, url } = {}) {
  const wrap = h('div', { class: 'ch-cards' });
  for (const p of previews || []) {
    if (!p || !p.url || !p.title) continue;
    const where = cardImage(p);
    const card = h('div', { class: `ch-card is-${where}${p.video ? ' is-video' : ''}`, 'data-url': p.url });
    const title = h('a', { class: 'ch-card-title', href: p.url, target: '_blank', rel: 'noopener noreferrer', 'data-roving': '', tabindex: '-1', text: p.title, title: p.url });
    const text = h('div', { class: 'ch-card-text' });
    if (p.site) text.append(h('span', { class: 'ch-card-site', text: p.site }));
    text.append(title);
    if (p.description) text.append(h('span', { class: 'ch-card-desc', text: p.description }));
    card.append(text);
    if (p.image && p.image.id) {
      const box = h('span', { class: 'ch-card-img', 'aria-hidden': 'true' });
      if (where === 'below') {
        const fit = fitBox(p.image.width, p.image.height, 360, 200);
        box.style.aspectRatio = `${fit.width} / ${fit.height}`;
      }
      const img = h('img', { alt: '', draggable: 'false' });
      box.append(h('span', { class: 'ch-img-ph' }, svg('image')), img);
      if (p.video) box.append(h('span', { class: 'ch-card-play' }, svg('play')));
      card.append(box);
      if (url) loadImage(img, p.image, url);
    }
    if (canRemove) {
      const x = h('button', { type: 'button', class: 'ch-card-x', 'data-roving': '', tabindex: '-1', 'aria-label': t('chat.cards.remove', { title: p.title }), title: t('chat.cards.removeTitle') }, svg('close'));
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onRemove) onRemove(p.url, card);
      });
      card.append(x);
    }
    // The whole card opens the address, as its title does.
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      if (document.getSelection()?.toString()) return;
      title.click();
    });
    wrap.append(card);
  }
  return wrap.childNodes.length ? wrap : null;
}

// ---------- the image viewer (contract 3.6, 5.2) ----------

let viewer = null;

// An overlay with images[index] at fit size, its name, Open and Save. Escape, the close button and a click outside the
// image close it; with several images the arrows step through them. opts: { url(file), onOpen(file), onSave(file) }.
export function openViewer(images, index, { url, onOpen, onSave } = {}) {
  if (viewer) viewer.close();
  const list = (images || []).filter(Boolean);
  if (!list.length) return null;
  const returnTo = document.activeElement;
  let at = Math.max(0, Math.min(index || 0, list.length - 1));
  const name = h('span', { class: 'ch-viewer-name' });
  const meta = h('span', { class: 'ch-viewer-meta' });
  const btn = (id, icon, label, text = null) => {
    const b = h('button', { type: 'button', class: text ? 'btn secondary sm' : 'icon-btn', 'data-viewer': id, 'aria-label': label, title: label }, svg(icon));
    if (text) b.append(h('span', { text }));
    return b;
  };
  const openB = btn('open', 'popOut', t(WEB ? 'chat.viewer.webOpenTitle' : 'chat.viewer.openTitle'), t('chat.viewer.open'));
  const saveB = btn('save', 'download', t(WEB ? 'chat.viewer.webSaveTitle' : 'chat.viewer.saveTitle'), t(WEB ? 'chat.viewer.webSave' : 'chat.viewer.save'));
  const closeB = btn('close', 'close', t('chat.viewer.close'));
  const bar = h('div', { class: 'ch-viewer-bar' }, h('div', { class: 'ch-viewer-titles' }, name, meta), h('div', { class: 'ch-viewer-actions' }, openB, saveB, closeB));
  const img = h('img', { class: 'ch-viewer-img', alt: '', draggable: 'false' });
  const stage = h('div', { class: 'ch-viewer-stage' }, img);
  const prev = btn('prev', 'chevronLeft', t('chat.viewer.previous'));
  const next = btn('next', 'chevronRight', t('chat.viewer.next'));
  prev.classList.add('ch-viewer-step', 'is-prev');
  next.classList.add('ch-viewer-step', 'is-next');
  const root = h('div', { class: 'scrim ch-viewer', role: 'dialog', 'aria-modal': 'true' }, bar, stage);
  if (list.length > 1) root.append(prev, next);
  let token = 0;

  function show() {
    const f = list[at];
    const my = ++token;
    name.textContent = f.name || '';
    name.title = f.name || '';
    meta.textContent = list.length > 1 ? t('chat.viewer.position', { n: at + 1, count: list.length, size: fileSize(Number(f.size) || 0) }) : fileSize(Number(f.size) || 0);
    root.setAttribute('aria-label', f.name || t('chat.viewer.label'));
    img.alt = f.name || '';
    img.removeAttribute('src');
    stage.classList.remove('is-loaded', 'is-failed');
    const box = fitBox(f.width, f.height, f.width || 360, f.height || 280);
    img.width = box.width;
    img.height = box.height;
    // As loadImage: an address that stopped working is asked for once more before the picture shows as failed.
    const attempt = (n) => {
      const p = imageUrl(f, url);
      const failed = () => {
        forgetUrl(f, p);
        if (my === token) stage.classList.add('is-failed');
      };
      p.then((src) => {
        if (my !== token) return;
        if (!src) return failed();
        img.onload = () => my === token && stage.classList.add('is-loaded');
        img.onerror = () => {
          if (my !== token) return;
          forgetUrl(f, p);
          if (n === 0 && url) attempt(1);
          else failed();
        };
        img.src = src;
      }, failed);
    };
    attempt(0);
    prev.disabled = at === 0;
    next.disabled = at === list.length - 1;
  }

  function close({ refocus = true } = {}) {
    if (viewer !== api) return;
    viewer = null;
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    if (refocus && returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && list.length > 1 && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      at = Math.max(0, Math.min(list.length - 1, at + step));
      show();
    } else if (e.key === 'Tab') {
      // The focus stays in the viewer.
      const stops = [...root.querySelectorAll('button:not(:disabled)')];
      const i = stops.indexOf(document.activeElement);
      e.preventDefault();
      stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
    }
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-viewer]');
    if (b) {
      const f = list[at];
      if (b.dataset.viewer === 'close') close();
      else if (b.dataset.viewer === 'open' && onOpen) onOpen(f, b);
      else if (b.dataset.viewer === 'save' && onSave) onSave(f, b);
      else if (b.dataset.viewer === 'prev' && at > 0) {
        at--;
        show();
      } else if (b.dataset.viewer === 'next' && at < list.length - 1) {
        at++;
        show();
      }
      return;
    }
    // Outside the picture and the bar: close.
    if (e.target === root || e.target === stage) close();
  });
  const api = { close, el: root };
  viewer = api;
  document.body.append(root);
  document.addEventListener('keydown', onKey, true);
  show();
  closeB.focus({ preventScroll: true });
  return api;
}

export const viewerOpen = () => Boolean(viewer);
export function closeViewer({ refocus = true } = {}) {
  if (viewer) viewer.close({ refocus });
}

// ---------- the emoji picker (contract 3.4, 5.2) ----------

// The emoji data and recent list (U7a's src/renderer/emoji/), loaded the first time a picker or a ":" completion needs
// them. A data file that can't load leaves the picker with its error line.
let emojiMods = null;
const dataByLocale = new Map();
export function emojiData() {
  if (!emojiMods) emojiMods = Promise.all([import('./emoji/index.js'), import('./emoji/recent.js')]);
  const locale = getLocale();
  if (!dataByLocale.has(locale)) {
    const p = emojiMods.then(([index]) => index.loadEmoji(locale));
    p.catch(() => dataByLocale.delete(locale));
    dataByLocale.set(locale, p);
  }
  return Promise.all([dataByLocale.get(locale), emojiMods.then(([, recent]) => recent)]).then(([data, recent]) => ({ data, recent }));
}

// The character to put in for e with the chosen skin tone (1 to 5, 0 for none).
export const withTone = (e, tone) => (tone > 0 && Array.isArray(e.skins) && e.skins[tone - 1] ? e.skins[tone - 1] : e.char);

// The emoji a character goes in as, its toned forms included, for the labels of Recent.
const byChar = (data, char) => (typeof data.byChar === 'function' ? data.byChar(char) : null);

const TONES = ['✋', '✋\u{1F3FB}', '✋\u{1F3FC}', '✋\u{1F3FD}', '✋\u{1F3FE}', '✋\u{1F3FF}'];
const COLUMNS = 9;
let picker = null;

export const pickerOpen = () => Boolean(picker);
// refocus: false when what opened it is leaving the screen, such as the room changing.
export function closeEmojiPicker({ refocus = true } = {}) {
  if (picker) picker.close({ refocus });
}

// The picker beside anchor: search, Recent, the groups with tabs, a skin tone choice and the arrows to move. onPick(char)
// gets the emoji as it goes in, with the tone applied; the picker closes. opts: { anchor, onPick, onClose, label }.
export function openEmojiPicker({ anchor, onPick, onClose, label = t('chat.emoji.label') } = {}) {
  if (picker) {
    const same = picker.anchor === anchor;
    picker.close();
    if (same) return null;
  }
  const returnTo = document.activeElement;
  const search = h('input', { type: 'search', class: 'ch-emoji-search', placeholder: t('chat.emoji.search'), 'aria-label': t('chat.emoji.search'), spellcheck: 'false', autocomplete: 'off' });
  const toneB = h('button', { type: 'button', class: 'ch-emoji-tone', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
  const tones = h('div', { class: 'ch-emoji-tones', role: 'radiogroup', 'aria-label': t('chat.emoji.tone'), hidden: true });
  const tabs = h('div', { class: 'ch-emoji-tabs', role: 'tablist', 'aria-label': t('chat.emoji.groups') });
  const grid = h('div', { class: 'ch-emoji-grid', role: 'grid', 'aria-label': label });
  const foot = h('div', { class: 'ch-emoji-foot', 'aria-hidden': 'true' });
  const status = h('div', { class: 'ch-emoji-status', role: 'status' });
  const root = h(
    'div',
    { class: 'ch-emoji', role: 'dialog', 'aria-label': label },
    h('div', { class: 'ch-emoji-top' }, h('span', { class: 'ch-emoji-field' }, svg('search'), search), toneB),
    tones,
    tabs,
    grid,
    status,
    foot
  );
  let data = null;
  let recent = null;
  let tone = 0;
  let cells = [];
  let active = 0;
  let closed = false;
  let pendingEnter = false;

  function close({ refocus = true } = {}) {
    if (closed) return;
    closed = true;
    if (picker === api) picker = null;
    root.remove();
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', onResize);
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    if (onClose) onClose();
    if (refocus && returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
  }
  function onDown(e) {
    if (!root.contains(e.target) && !(anchor && anchor.contains(e.target))) close({ refocus: false });
  }
  // A resize moves the anchor, so the picker closes. In the browser a phone's keyboard, which opens for the search
  // field, only makes the page shorter (interactive-widget=resizes-content in src/web/index.html): the picker moves
  // with its anchor then, and only a change of width (a phone turned, a window resized) closes it.
  const openWidth = window.innerWidth;
  const onResize = () => {
    if (WEB && window.innerWidth === openWidth) place();
    else close({ refocus: false });
  };

  function pick(e) {
    const char = withTone(e, tone);
    if (recent) {
      try {
        recent.useEmoji(char);
      } catch (_) {
        // A full storage only means Recent doesn't learn this one.
      }
    }
    close();
    if (onPick) onPick(char, e);
  }

  const cellOf = (e) => {
    const char = withTone(e, tone);
    const b = h('button', { type: 'button', class: 'ch-emoji-cell', role: 'gridcell', tabindex: '-1', 'aria-label': e.label || char, title: e.label || char, text: char });
    b.addEventListener('click', () => pick(e));
    b.addEventListener('mouseenter', () => setActive(cells.indexOf(b), { focus: false }));
    b.__emoji = e;
    return b;
  };

  function section(id, title, list) {
    const head = h('div', { class: 'ch-emoji-head', id: `ch-emoji-${id}`, text: title });
    const body = h('div', { class: 'ch-emoji-cells', role: 'row' });
    for (const e of list) body.append(cellOf(e));
    return h('section', { class: 'ch-emoji-sec', 'data-group': id }, head, body);
  }

  function setActive(i, { focus = true } = {}) {
    if (!cells.length) return;
    active = Math.max(0, Math.min(cells.length - 1, i));
    cells.forEach((c, j) => (c.tabIndex = j === active ? 0 : -1));
    const c = cells[active];
    if (focus) {
      c.focus({ preventScroll: true });
      c.scrollIntoView({ block: 'nearest' });
    }
    const e = c.__emoji;
    foot.textContent = '';
    foot.append(h('span', { class: 'ch-emoji-big', text: c.textContent }), h('span', { class: 'ch-emoji-name', text: e.label || '' }));
    if (e.shortcodes && e.shortcodes[0]) foot.append(h('span', { class: 'ch-emoji-code', text: `:${e.shortcodes[0]}:` }));
  }

  function recentList() {
    if (!recent || !data) return [];
    let chars = [];
    try {
      chars = recent.recentEmoji() || [];
    } catch (_) {
      chars = [];
    }
    // A recent emoji keeps the tone it was used with.
    return chars.map((c) => {
      const e = byChar(data, c);
      return e ? { ...e, char: c, skins: null } : { char: c, label: c, shortcodes: [], skins: null };
    });
  }

  function draw() {
    const q = search.value.trim();
    grid.textContent = '';
    status.textContent = '';
    if (!data) return;
    if (q) {
      const hits = data.search(q, 90) || [];
      if (hits.length) grid.append(section('results', t('chat.emoji.results'), hits));
      else status.textContent = t('chat.emoji.none');
      tabs.hidden = true;
    } else {
      tabs.hidden = false;
      const rec = recentList();
      if (rec.length) grid.append(section('recent', t('chat.emoji.recent'), rec));
      for (const g of data.groups || []) grid.append(section(g.id, g.label, g.emoji || []));
      markTab();
    }
    cells = [...grid.querySelectorAll('.ch-emoji-cell')];
    active = 0;
    cells.forEach((c, j) => (c.tabIndex = j === 0 ? 0 : -1));
    if (cells.length) setActive(0, { focus: false });
    else foot.textContent = '';
  }

  // A tab per group, with a line icon (icons.js emojiGroupIcons): it only scrolls to its group, so it must not look like
  // an emoji people can pick (issue 377). The tab of the group at the top of the list shows as selected.
  function drawTabs() {
    tabs.textContent = '';
    const list = [];
    if (recentList().length) list.push({ id: 'recent', label: t('chat.emoji.recent'), icon: 'clock' });
    for (const g of data.groups || []) list.push({ id: g.id, label: g.label, icon: emojiGroupIcons[g.id] || 'smile' });
    for (const g of list) {
      const b = h('button', { type: 'button', class: 'ch-emoji-tab', role: 'tab', 'aria-selected': 'false', 'aria-label': g.label, title: g.label, 'data-group': g.id }, svg(g.icon));
      b.addEventListener('click', () => {
        const sec = grid.querySelector(`[data-group="${CSS.escape(g.id)}"]`);
        if (!sec) return;
        jumpTo(sec, g.id);
        const first = sec.querySelector('.ch-emoji-cell');
        if (first) setActive(cells.indexOf(first), { focus: false });
      });
      tabs.append(b);
    }
    markTab();
  }

  // The group whose section is at the top of the list, or the last one once the list is scrolled to its end: a short
  // group near the bottom can't reach the top.
  function markTab(id = null) {
    if (!id) {
      const secs = [...grid.querySelectorAll('.ch-emoji-sec')];
      const end = grid.scrollTop > 0 && grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 1;
      const top = secs.filter((s) => s.offsetTop <= grid.scrollTop + 1);
      id = ((end ? secs[secs.length - 1] : top[top.length - 1]) || secs[0])?.dataset.group || null;
    }
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.group === id));
  }

  // A tab's jump to its group, followed frame by frame. The groups it passes are drawn only once they come near
  // (content-visibility in styles.css) and turn out taller than the room kept for them, so the group moves further down
  // while the list scrolls: where the scroll stops short, it goes on to where the group is now. Its tab stays selected
  // on the way. A wheel, a touch, a press or a key in the list hands the scrolling back to the person.
  let jump = null;
  function jumpTo(sec, id) {
    const mine = { id, until: Date.now() + 3000 };
    jump = mine;
    markTab(id);
    grid.scrollTo({ top: sec.offsetTop, behavior: reduced() ? 'auto' : 'smooth' });
    let last = -1;
    let still = 0;
    const step = () => {
      if (jump !== mine || closed) return;
      const target = Math.min(sec.offsetTop, grid.scrollHeight - grid.clientHeight);
      if (!sec.isConnected || Date.now() > mine.until || Math.abs(grid.scrollTop - target) <= 1) {
        jump = null;
        return markTab(sec.isConnected && Math.abs(grid.scrollTop - target) <= 1 ? id : null);
      }
      still = grid.scrollTop === last ? still + 1 : 0;
      last = grid.scrollTop;
      if (still >= 6) grid.scrollTo({ top: target, behavior: 'auto' });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // The list also stops where it is: a smooth scroll that ran on would move the emoji away from under a press before
  // its release, and the click would miss it.
  const handBack = () => {
    if (jump) {
      jump = null;
      grid.scrollTo({ top: grid.scrollTop, behavior: 'instant' });
      markTab();
    }
  };
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) grid.addEventListener(type, handBack, { passive: true });
  grid.addEventListener(
    'scroll',
    () => {
      if (!tabs.hidden && !jump) markTab();
    },
    { passive: true }
  );

  function drawTone() {
    toneB.textContent = TONES[tone] || TONES[0];
    toneB.setAttribute('aria-label', t('chat.emoji.toneButton'));
    toneB.title = t('chat.emoji.toneButton');
    tones.textContent = '';
    TONES.forEach((char, n) => {
      const b = h('button', { type: 'button', class: 'ch-emoji-tone-opt', role: 'radio', 'aria-checked': String(n === tone), 'aria-label': t(`chat.emoji.tone${n}`), title: t(`chat.emoji.tone${n}`), text: char });
      b.addEventListener('click', () => {
        tone = n;
        try {
          recent && recent.setSkinTone(n);
        } catch (_) {
          // Kept for this picker only.
        }
        tones.hidden = true;
        toneB.setAttribute('aria-expanded', 'false');
        drawTone();
        draw();
        toneB.focus();
      });
      tones.append(b);
    });
  }

  toneB.addEventListener('click', () => {
    tones.hidden = !tones.hidden;
    toneB.setAttribute('aria-expanded', String(!tones.hidden));
    if (!tones.hidden) tones.querySelector('[aria-checked="true"]')?.focus();
  });
  search.addEventListener('input', () => draw());
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey && search.value)) {
      if (!cells.length) return;
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Typed before the data came in: the first match is picked once it's there.
      if (!data) pendingEnter = true;
      else if (cells.length) pick(cells[0].__emoji);
    }
  });
  // The cells in a row: COLUMNS, or the grid's own count where the page lays it out with another (web.css fits 44px
  // cells on a phone). Read from the focused cell's row, which is on screen and laid out.
  const columns = (cell) => {
    const tracks = cell && cell.parentElement ? getComputedStyle(cell.parentElement).gridTemplateColumns : '';
    return /^[\d.]+px( [\d.]+px)*$/.test(tracks) ? tracks.split(' ').length : COLUMNS;
  };
  grid.addEventListener('keydown', (e) => {
    const i = cells.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = columns(cells[i]);
    // Rows hold cols cells within a section; Up and Down move to the same column of the row above or below.
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    if (move) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'ArrowUp' && i < cols) return search.focus();
      setActive(i + move);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : cells.length - 1);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      setActive(i + (e.key === 'PageDown' ? 1 : -1) * cols * 5);
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!tones.hidden) {
        tones.hidden = true;
        toneB.setAttribute('aria-expanded', 'false');
        toneB.focus();
        return;
      }
      close();
    }
  });

  const api = { close, el: root, anchor };
  picker = api;
  document.body.append(root);
  // Beside the anchor: under it when it fits, else above; its right edge with the anchor's where the window is narrow.
  // Never over the title bar, which lies above it (and drags the desktop's window, a tap there goes Back on a phone):
  // at most from 8px under the bar, as the shared menus keep (ui.js), and as tall as the room left there.
  function place() {
    const r = anchor ? anchor.getBoundingClientRect() : { left: 8, right: 8, top: 8, bottom: 8 };
    const bar = document.querySelector('.titlebar');
    const top = Math.max(8, (bar ? bar.getBoundingClientRect().bottom : 0) + 8);
    const bottom = window.innerHeight - 8;
    root.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    const w = root.offsetWidth;
    const hgt = root.offsetHeight;
    const below = r.bottom + 6 + hgt <= bottom;
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = r.right - w;
    root.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
    root.style.top = `${Math.max(top, Math.min(below ? r.bottom + 6 : r.top - hgt - 6, bottom - hgt))}px`;
    root.style.transformOrigin = below ? 'top left' : 'bottom left';
  }
  place();
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onResize);
  search.focus({ preventScroll: true });
  status.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  status.setAttribute('aria-label', t('chat.emoji.loading'));
  emojiData().then(
    (r) => {
      if (closed) return;
      data = r.data;
      recent = r.recent;
      try {
        tone = Math.max(0, Math.min(5, Number(recent.skinTone()) || 0));
      } catch (_) {
        tone = 0;
      }
      status.removeAttribute('aria-label');
      drawTone();
      drawTabs();
      draw();
      if (pendingEnter && search.value.trim() && cells.length) pick(cells[0].__emoji);
    },
    () => {
      if (closed) return;
      status.removeAttribute('aria-label');
      status.textContent = t('chat.emoji.failed');
    }
  );
  drawTone();
  return api;
}

// ---------- the composer's formatting bar (contract 3.3, 5.2) ----------

const FORMAT_ICONS = { bold: 'bold', italic: 'italic', strike: 'strike', code: 'code', link: 'link', bullets: 'ul', numbers: 'ol', quote: 'quote', codeBlock: 'codeBlock' };

// The bar above the composer's text: one button per command with its shortcut in the tooltip. A press keeps the text's
// selection (mousedown doesn't take the focus); onCommand(kind) applies it.
export function formatBarEl(onCommand) {
  const bar = h('div', { class: 'ch-fmt', role: 'toolbar', 'aria-label': t('chat.format.label') });
  FORMATS.forEach((kind, i) => {
    if (kind === 'link' || kind === 'bullets' || kind === 'codeBlock') bar.append(h('span', { class: 'ch-fmt-sep', 'aria-hidden': 'true' }));
    const label = t(`chat.format.${kind}`);
    const b = h('button', { type: 'button', class: 'icon-btn sm', 'data-format': kind, 'aria-label': label, title: `${label} (${SHORTCUTS[kind]})`, 'aria-keyshortcuts': SHORTCUTS[kind].replace(/Ctrl/g, 'Control'), tabindex: i === 0 ? '0' : '-1' }, svg(FORMAT_ICONS[kind]));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => onCommand(kind));
    bar.append(b);
  });
  // A toolbar is one Tab stop; the arrows move inside it.
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const list = [...bar.querySelectorAll('button')];
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    list.forEach((b, j) => (b.tabIndex = j === n ? 0 : -1));
    list[n].focus();
  });
  return bar;
}

// ---------- the composer's file tray (contract 3.5, 5.2) ----------

// The staged files above the composer's text: image thumbnails and file cards with name, size and state, a progress
// bar while uploading, Remove, and Retry on a failed one. Kept by stage, so progress moves a bar instead of drawing the
// tray again. handlers: { onRemove(stage), onRetry(stage), errorText(code) }. Returns { el, set(list) }.
export function mountTray(handlers) {
  const el = h('div', { class: 'ch-tray', role: 'list', 'aria-label': t('chat.files.trayLabel'), hidden: true });
  const items = new Map();

  // A browser tells the page nothing of an upload until the server answers (src/web/engine/shims/http.js), so the web
  // shows that it uploads, without a share.
  const unmeasured = (s) => WEB && s.state === 'uploading';
  function stateText(s) {
    if (s.state === 'failed') return handlers.errorText ? handlers.errorText(s.error) : t('chat.files.failed');
    if (s.state === 'measuring') return t('chat.files.preparing');
    if (unmeasured(s)) return t('chat.files.webUploading');
    if (s.state === 'uploading') return t('chat.files.uploading', { percent: percent(s) });
    return t('chat.files.ready');
  }
  const percent = (s) => (s.size > 0 ? Math.max(0, Math.min(100, Math.floor(((Number(s.loaded) || 0) / s.size) * 100))) : 0);

  function build(s) {
    const image = Boolean(s.thumb);
    const x = h('button', { type: 'button', class: 'ch-tray-x', 'aria-label': t('chat.files.remove', { name: s.name || '' }), title: t('chat.files.removeTitle') }, svg('close'));
    x.addEventListener('click', () => handlers.onRemove && handlers.onRemove(s.stage));
    const retry = h('button', { type: 'button', class: 'link-btn ch-tray-retry', text: t('common.actions.retry') });
    retry.addEventListener('click', () => handlers.onRetry && handlers.onRetry(s.stage));
    const bar = h('span', { class: 'ch-tray-bar', 'aria-hidden': 'true' }, h('i'));
    const sub = h('span', { class: 'ch-tray-sub' });
    let node;
    if (image) {
      const img = h('img', { alt: '', src: s.thumb, draggable: 'false' });
      node = h('div', { class: 'ch-tray-item is-image', role: 'listitem', 'data-stage': s.stage }, h('span', { class: 'ch-tray-thumb' }, img, bar), sub, x, retry);
    } else {
      node = h(
        'div',
        { class: 'ch-tray-item is-file', role: 'listitem', 'data-stage': s.stage },
        h('span', { class: 'ch-file-ic', 'aria-hidden': 'true' }, svg(fileIcon(s))),
        h('span', { class: 'ch-file-text' }, h('span', { class: 'ch-file-name', text: s.name || '', title: s.name || '' }), sub),
        bar,
        x,
        retry
      );
    }
    return { node, sub, bar, retry, image, thumb: s.thumb, name: s.name };
  }

  function update(item, s) {
    const text = stateText(s);
    const size = fileSize(Number(s.size) || 0);
    // A thumbnail has no room for the line: it's the accessible name and the tooltip instead. In the browser a failed
    // picture shows it (web.css), as a touch screen has no tooltip.
    if (item.image) item.sub.textContent = s.state === 'failed' ? text : '';
    else item.sub.textContent = `${size} · ${text}`;
    item.node.classList.toggle('is-busy', s.state === 'measuring' || s.state === 'uploading');
    item.node.classList.toggle('is-failed', s.state === 'failed');
    item.node.classList.toggle('is-ready', s.state === 'ready');
    item.node.classList.toggle('is-unmeasured', unmeasured(s));
    item.node.setAttribute('aria-label', `${s.name || ''}, ${size}, ${text}`);
    item.node.title = `${s.name || ''} · ${size} · ${text}`;
    // An upload of unknown share leaves the bar to web.css, which runs a light along it.
    item.bar.firstChild.style.width = unmeasured(s) ? '' : `${s.state === 'uploading' ? percent(s) : s.state === 'measuring' ? 0 : 100}%`;
    // A browser can't read a picked file again once it changed on disk (only the file chooser hands out a new one), so
    // Retry, which reads it again, can't help there; the text says to attach it again (chat.errors.webFileUnreadable).
    item.retry.hidden = s.state !== 'failed' || (WEB && s.error === 'unreadable');
  }

  function set(list) {
    const next = new Map();
    for (const s of list || []) {
      if (!s || !s.stage) continue;
      let item = items.get(s.stage);
      // A thumbnail that came in after the card showed: drawn again as an image.
      if (item && Boolean(s.thumb) !== item.image) item = null;
      if (!item) item = build(s);
      update(item, s);
      next.set(s.stage, item);
    }
    const hadFocus = el.contains(document.activeElement);
    let cursor = el.firstChild;
    for (const item of next.values()) {
      if (item.node === cursor) cursor = cursor.nextSibling;
      else el.insertBefore(item.node, cursor);
    }
    for (const [key, item] of items) if (next.get(key) !== item) item.node.remove();
    items.clear();
    for (const [k, v] of next) items.set(k, v);
    el.hidden = !items.size;
    return hadFocus && !el.contains(document.activeElement);
  }

  // A language change: the list's name and every item's words.
  let last = [];
  function relabel() {
    el.setAttribute('aria-label', t('chat.files.trayLabel'));
    for (const item of items.values()) {
      const x = item.node.querySelector('.ch-tray-x');
      if (x) {
        x.setAttribute('aria-label', t('chat.files.remove', { name: item.name || '' }));
        x.title = t('chat.files.removeTitle');
      }
      item.retry.textContent = t('common.actions.retry');
    }
    set(last);
  }
  const setAndKeep = (list) => {
    last = list || [];
    return set(last);
  };

  return { el, set: setAndKeep, relabel };
}

// ---------- drop target ----------

// Whether a drag carries files.
export const dragHasFiles = (e) => Boolean(e.dataTransfer) && [...(e.dataTransfer.types || [])].includes('Files');
