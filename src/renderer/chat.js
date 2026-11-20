import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, $, hue, initials, toast, showMenu, dialog, KEEP_OPEN } from './ui.js';
import { sortRooms, dmTitle, displayName, roomBadge, modeBadge as badgeFor } from './chat-model.js';
import { mountView } from './chat-view.js';

// Team chat: a fourth mode next to Mail, Calendar and Meet (Ctrl+4), shown while the server of the person's Rukoo
// account has team chat (contract 3.1, 5.2). Main holds the workspaces, their cache and the network
// (src/main/workspaces); this module keeps what the window shows of them (CH), draws the sidebar, the foot status, the
// mode badge and the pane's states, and hands the open conversation to chat-view.js. It never talks to the server:
// every call goes through api() to main's chat* methods, and main's 'chat' events come in through onEvent().
//
// Everything in a workspace was written by other people (names, channel names, messages): it reaches the DOM through
// esc() in the sidebar's template strings, and through textContent in the pane.

// The conversation last open in each workspace, by ID only (contract 5.1 leaves it to the view, as meeting.js does).
const SAVED = 'rukoo.chat.open';
const WS_ID = /^w_[A-Za-z0-9_-]{22}$/;
const ROOM_ID = /^c_[A-Za-z0-9_-]{22}$/;
// After this long reconnecting, the banner says so and offers Try now (desktop-ui 7).
const RECONNECT_BANNER_MS = 10000;
const DIRECTORY_WAIT = 300;

export const CH = {
  // ChatState from main (contract 4.6), and whether it has answered at all.
  state: null,
  known: false,
  // The workspace whose conversations show, and what chatView said about it: { ws, me, membersMore, channels }.
  ws: null,
  view: null,
  rooms: new Map(),
  members: new Map(),
  blocks: new Set(),
  // The conversation on screen, or null.
  openId: null,
  // Goes up whenever the workspace on screen changes, so an answer for the one before is dropped.
  generation: 0,
  // Chat mode is on screen.
  open: false,
  // The workspace went while it was on screen (desktop-ui 7.11): { name } until the person says OK.
  gone: null,
  // The open conversation went (desktop-ui 7.10): the gone state shows until OK.
  goneRoom: false,
  // Connection history for the foot status and the reconnecting banner.
  wasOnline: false,
  connectingSince: null
};

// Sidebar and menu entries that U5's dialogs fill in (New message, the Channels plus menu, Browse channels, the
// workspace's own settings). A button shows only once its action exists, so nothing on screen does nothing.
export const ACTIONS = {
  newMessage: null,
  addChannel: null,
  browse: null,
  workspaceItems: null
};
// The thread panel (U4): open(root, { seq }) shows a thread beside the log.
export const THREAD = { open: null };

let ctx = null;
let view = null;
let directoryTimer = null;
let bannerTimer = null;
let takingJoin = false;

// ---------- small helpers ----------

function readSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}
function saveOpen(ws, room) {
  if (!WS_ID.test(ws || '') || !ROOM_ID.test(room || '')) return;
  try {
    const all = readSaved();
    all[ws] = room;
    // Only the workspaces the person is in now.
    const keep = new Set((CH.state?.workspaces || []).map((w) => w.id));
    for (const key of Object.keys(all)) if (!keep.has(key) && key !== ws) delete all[key];
    localStorage.setItem(SAVED, JSON.stringify(all));
  } catch (_) {
    // A full or blocked storage only means the workspace opens on its first conversation next time.
  }
}

const fmt = (n) => (n > 99 ? '99+' : String(n));
const listFormat = () => new Intl.ListFormat(getLocale(), { type: 'conjunction', style: 'long' });
const collator = () => new Intl.Collator(getLocale(), { sensitivity: 'base', numeric: true });
const summary = (id = CH.ws) => (CH.state?.workspaces || []).find((w) => w.id === id) || null;
const myRole = () => CH.view?.me?.role || summary()?.role || 'member';
const isGuest = () => myRole() === 'guest';
const me = () => CH.view?.me?.id || null;

// What a room is called: a channel's name, a DM's participants (contract 3.12).
export function roomName(room) {
  if (!room) return '';
  if (room.kind === 'dm') return dmTitle(room, CH.members, me(), listFormat(), t);
  return String(room.name || '');
}

// The rooms of the workspace on screen in sidebar order (contract 5.3), and the visible list for Alt+arrows.
function ordered() {
  return sortRooms([...CH.rooms.values()], collator(), { open: CH.openId });
}
function inOrder() {
  const { channels, dms } = ordered();
  const guest = isGuest();
  return [...channels, ...dms.filter((r) => !guest || r.closedReason)];
}

function memberAvatar(id, cls = 'ch-av-18') {
  const m = CH.members.get(id);
  const deleted = m && m.state === 'deleted';
  const text = deleted ? '?' : initials({ name: displayName(m, t) });
  return `<span class="avatar ${cls}" style="--h:${hue(id || '')}" aria-hidden="true">${esc(text)}</span>`;
}

function tileHtml(w, { dot = false } = {}) {
  const warn = w.status === 'quarantined';
  const mark = warn ? '<i class="ch-ws-dot is-warn"></i>' : dot ? '<i class="ch-ws-dot"></i>' : '';
  return `<span class="ch-ws-tile" style="--h:${hue(w.id)}" aria-hidden="true">${esc(initials({ name: w.name }))}${mark}</span>`;
}

// The host disclosure (desktop-ui 6): who hosts the workspace, where, and that the host can read it.
export function hostNote() {
  const s = CH.state || {};
  const operator = (s.operator && s.operator.name) || s.host || '';
  const where = ['eu', 'us', 'fedramp'].includes(s.jurisdiction) ? t(`settings.rukoo.where.${s.jurisdiction}`) : '';
  const lines = [`${t('chat.host.lineNoLocation', { operator, host: s.host || '' })}${where ? ` ${where}.` : ''}`];
  if (s.retention && s.retention.contentDays) lines.push(t('chat.host.retention', { count: s.retention.contentDays }));
  lines.push(t('chat.host.reads'));
  return `<div class="note ch-host">${lines.map((l) => esc(l)).join(' ')}</div>`;
}

// ---------- errors (contract 3.15) ----------

// A §3.15 code in the person's words. context: { host, workspace, linkHost } for the placeholders.
export function chatErrorText(err, context = {}) {
  const code = err && err.code;
  const host = context.host || CH.state?.host || '';
  const workspace = context.workspace || summary()?.name || '';
  switch (code) {
    case 'network':
      return t('chat.errors.network', { host });
    case 'signed_out':
      return t('chat.errors.signedOut');
    case 'upgrade_required':
      return t('chat.errors.upgrade', { host });
    case 'rate_limited':
      return err.limit === 'dailyDms' ? t('chat.errors.dailyDms') : t('chat.errors.rateLimited', { count: Math.max(1, Number(err.retryAfter) || 1) });
    case 'not_found':
      if (err.scope === 'workspace') return t('chat.errors.goneWorkspace');
      if (err.scope === 'conversation') return t('chat.errors.goneConversation');
      return t('chat.errors.notFound');
    case 'forbidden':
      return t('chat.errors.forbidden');
    case 'cosign_required':
      return t('chat.channel.addGuestNeedsAdmin');
    case 'workspace_limit':
      return t('chat.errors.workspaceLimit', { host });
    case 'workspaces_full':
      return t('chat.errors.workspacesFull', { host });
    case 'workspace_account_scope':
      return t('chat.errors.accountScope');
    case 'dm_unavailable':
      return t('chat.errors.dmUnavailable');
    case 'blocked':
      return t('chat.errors.blocked', { name: displayName(CH.members.get(err.member), t) });
    case 'name_taken':
      return t('chat.errors.nameTaken');
    case 'last_owner':
      return t('chat.errors.lastOwner');
    case 'last_manager':
      return t('chat.errors.lastManager');
    case 'members_remain':
      return t('chat.errors.membersRemain');
    case 'archived':
      return t('chat.errors.archived');
    case 'invite_gone':
      return t('chat.errors.inviteGone');
    case 'quota': {
      const by = { members: 'quotaMembers', conversations: 'quotaConversations', invites: 'quotaInvites', bytes: 'quotaBytes' }[err.limit];
      return t(`chat.errors.${by || 'quota'}`, { workspace });
    }
    case 'invalid':
      return ['name', 'displayName'].includes(err.field) ? t('chat.errors.invalidName') : t('chat.errors.invalid');
    case 'bad_link':
      return t('chat.join.badLink');
    case 'other_server':
      return t('chat.join.otherHost', { host: context.linkHost || '', own: host });
    case 'not_saved':
      return t('chat.errors.notSaved');
    case 'paused':
      return t('chat.errors.paused', { workspace });
    default:
      return t('chat.errors.failed');
  }
}

// ---------- the API app.js uses ----------

export function init(context) {
  ctx = context;
  api('chatState')
    .then(applyState)
    .catch(() => {
      // Main without team chat (or failing to say): the mode stays hidden.
      CH.known = true;
      ctx.chatAvailability?.();
    });
}

export const isOpen = () => CH.open;
export const known = () => CH.known;
export const available = () => Boolean(CH.state && CH.state.available);

export function show() {
  CH.open = true;
  ensureView();
  renderPane();
  if (CH.ws && CH.view && !CH.openId && !CH.goneRoom) openDefault();
  else if (CH.openId && CH.view) view.open(CH.ws, CH.openId, { refresh: true });
  maybeTakeJoin();
}

export function hide() {
  CH.open = false;
  api('chatClose').catch(() => {});
  view?.hide();
}

export function relocalize() {
  if (!view) return;
  view.relocalize();
  renderPane();
}

// Main's 'chat' events (contract 4.5); kind 'open' is app.js's.
export function onEvent(p) {
  switch (p.kind) {
    case 'state':
      if (p.state) applyState(p.state);
      return;
    case 'rooms':
      if (p.ws !== CH.ws) return;
      for (const r of Array.isArray(p.rooms) ? p.rooms : []) if (r && r.id) CH.rooms.set(r.id, r);
      for (const id of Array.isArray(p.removed) ? p.removed : []) CH.rooms.delete(id);
      if (CH.openId && CH.rooms.has(CH.openId)) view?.roomChanged(CH.rooms.get(CH.openId));
      redrawSide();
      // A workspace's first pass brings its rooms: the first one opens.
      if (CH.open && !CH.openId && !CH.goneRoom && !CH.gone && CH.view) openDefault();
      else renderPane();
      return;
    case 'directory':
      if (p.ws !== CH.ws) return;
      clearTimeout(directoryTimer);
      directoryTimer = setTimeout(() => reloadView(), DIRECTORY_WAIT);
      return;
    case 'events':
    case 'redacted':
    case 'pending':
    case 'sent':
      if (p.ws === CH.ws) view?.onEvent(p);
      return;
    case 'evicted':
      if (p.ws !== CH.ws) return;
      if (p.conversation === CH.openId) {
        const room = CH.rooms.get(p.conversation);
        CH.goneRoom = true;
        CH.openId = null;
        view?.goneConversation(roomName(room));
      }
      CH.rooms.delete(p.conversation);
      redrawSide();
      return;
    case 'removed':
      if (p.ws !== CH.ws) return;
      CH.gone = { name: summary(p.ws)?.name || CH.view?.ws?.name || '' };
      CH.generation++;
      CH.rooms.clear();
      CH.members.clear();
      CH.blocks.clear();
      CH.openId = null;
      CH.view = null;
      if (CH.open) view?.goneWorkspace(CH.gone.name);
      redrawSide();
      return;
    default:
  }
}

// Keys that reach the document in Chat mode (desktop-ui 9.2, without the ones contract 5.9 leaves out). True when
// handled.
export function onKey(e) {
  if (!CH.open) return false;
  const typing = e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
  // Alt+ArrowUp and Alt+ArrowDown: the conversation before or after in sidebar order.
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const list = inOrder();
    if (!list.length) return true;
    const i = list.findIndex((r) => r.id === CH.openId);
    const next = list[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
    if (next) openRoom(next.id);
    return true;
  }
  // Shift+Escape: the open conversation read (contract 3.9).
  if (e.key === 'Escape' && e.shiftKey && !typing) {
    view?.markRead();
    return true;
  }
  return view ? view.onKey(e, { typing }) : false;
}

// The sidebar below the mode switch (contract 5.3); app.js adds its foot.
export function sidebarHtml() {
  // Room above the foot, which belongs at the bottom also when the sidebar has nothing else to show.
  const fill = '<div class="ch-side-fill" aria-hidden="true"></div>';
  const s = CH.state;
  if (!s || !s.available || !s.storage || !s.signedIn) return fill;
  const list = s.workspaces || [];
  if (!list.length || CH.gone) {
    if (!list.length && s.connection === 'connecting') return fill;
    return `<nav class="nav ch-nav" aria-label="${esc(t('chat.sidebar.label'))}">
      <button class="nav-item ch-row-quiet" data-ch-side="make" title="${esc(t('chat.workspace.make'))}"><span class="ic">${icons.plus}</span><span class="label">${esc(t('chat.workspace.make'))}</span></button>
      <button class="nav-item ch-row-quiet" data-ch-side="join" title="${esc(t('chat.workspace.join'))}"><span class="ic">${icons.link}</span><span class="label">${esc(t('chat.workspace.join'))}</span></button>
    </nav>`;
  }
  const w = summary() || list[0];
  const othersAsk = list.some((x) => x.id !== w.id && (x.attention > 0 || x.unread));
  const role = t(`chat.roles.${['owner', 'admin', 'member', 'guest'].includes(w.role) ? w.role : 'member'}`);
  const sw = `<button class="account-switch ch-ws-switch" data-ch-side="workspaces" aria-haspopup="menu" title="${esc(`${w.name} · ${t('chat.workspace.switch')}`)}">${tileHtml(w, { dot: othersAsk })}<span class="who"><span class="name">${esc(w.name)}</span><span class="email">${esc(t('chat.workspace.sub', { role, host: s.host }))}</span></span><span class="chev">${icons.chevronUpDown}</span></button>`;
  if (!CH.view) return sw + fill;
  const full = !isGuest();
  const compose =
    full && ACTIONS.newMessage
      ? `<button class="btn compose-btn" data-ch-side="new-message" title="${esc(t('chat.sidebar.newMessageShortcut'))}">${icons.compose}<span>${esc(t('chat.sidebar.newMessage'))}</span></button>`
      : '';
  const { channels, dms } = ordered();
  const shownDms = full ? dms : dms.filter((r) => r.closedReason);
  const addChannel = full && ACTIONS.addChannel ? `<button class="icon-btn xs" data-ch-side="channel-add" aria-haspopup="menu" title="${esc(t('chat.sidebar.addChannel'))}">${icons.plus}</button>` : '';
  const addDm = full && ACTIONS.newMessage ? `<button class="icon-btn xs" data-ch-side="dm-add" title="${esc(t('chat.sidebar.newMessage'))}">${icons.plus}</button>` : '';
  const browse =
    full && ACTIONS.browse
      ? `<button class="nav-item ch-row-quiet" data-ch-side="browse" title="${esc(t('chat.sidebar.browse'))}"><span class="ic">${icons.search}</span><span class="label">${esc(t('chat.sidebar.browse'))}</span></button>`
      : '';
  const empty = (key) => `<p class="ch-side-empty">${esc(t(key))}</p>`;
  const channelRows = channels.length ? channels.map(roomRow).join('') : empty('chat.sidebar.noChannels');
  const dmSection =
    full || shownDms.length
      ? `<div class="nav-section"><span>${esc(t('chat.sidebar.direct'))}</span>${addDm}</div>${shownDms.length ? shownDms.map(roomRow).join('') : empty('chat.sidebar.noDirect')}`
      : '';
  return `${sw}${compose}<nav class="nav ch-nav${compose ? '' : ' no-compose'}" aria-label="${esc(t('chat.sidebar.label'))}">
    <div class="nav-section"><span>${esc(t('chat.sidebar.channels'))}</span>${addChannel}</div>${channelRows}${browse}${dmSection}
  </nav>`;
}

function roomRow(room) {
  const name = roomName(room);
  const b = roomBadge(room);
  const closed = room.kind === 'dm' && Boolean(room.closedReason);
  const active = room.id === CH.openId;
  const cls = ['nav-item', 'ch-row', active && 'active', b.bold && 'is-unread', room.muted && 'is-muted', closed && 'is-closed'].filter(Boolean).join(' ');
  let label = name;
  if (room.muted) label = t('chat.sidebar.rowMuted', { name });
  else if (closed) label = t('chat.sidebar.rowClosed', { name });
  else if (b.pill && room.kind === 'channel') label = t('chat.sidebar.rowMentions', { name, count: b.pill });
  else if (b.pill || b.count) label = t('chat.sidebar.rowUnread', { name, count: b.pill || b.count });
  const badge = b.pill ? `<span class="ch-badge" aria-hidden="true">${fmt(b.pill)}</span>` : b.count ? `<span class="count strong" aria-hidden="true">${fmt(b.count)}</span>` : '';
  let icon;
  if (room.kind === 'channel') {
    const glyph = room.archived ? icons.archive : room.visibility === 'private' ? icons.lock : icons.hash;
    icon = `<span class="ic ch-ic" style="--h:${hue(room.id)}">${glyph}<b>${esc(([...name][0] || '#').toUpperCase())}</b></span>`;
  } else {
    const others = (room.participants || []).filter((id) => id !== me());
    icon =
      others.length > 1
        ? `<span class="ic"><span class="ch-av-group">${memberAvatar(others[0], 'ch-av-14')}${memberAvatar(others[1], 'ch-av-14')}</span></span>`
        : `<span class="ic">${memberAvatar(others[0] || me())}</span>`;
  }
  return `<button class="${cls}" data-ch-open="${esc(room.id)}" title="${esc(name)}" aria-label="${esc(label)}"${active ? ' aria-current="page"' : ''}>${icon}<span class="label">${esc(name)}</span>${badge}</button>`;
}

// A click in the sidebar; false when it isn't chat's.
export function sidebarClick(btn) {
  if (btn.dataset.chOpen) {
    // By keyboard the focus would go to the composer (desktop-ui 9.3); by click it stays on the row.
    openRoom(btn.dataset.chOpen);
    return true;
  }
  switch (btn.dataset.chSide) {
    case 'workspaces':
      workspaceMenu(btn);
      return true;
    case 'make':
      makeWorkspace();
      return true;
    case 'join':
      openJoin();
      return true;
    case 'new-message':
    case 'dm-add':
      ACTIONS.newMessage?.();
      return true;
    case 'channel-add':
      ACTIONS.addChannel?.(btn);
      return true;
    case 'browse':
      ACTIONS.browse?.();
      return true;
    default:
      return false;
  }
}

// The foot's status line in Chat mode, as syncStatus in app.js: { cls, text, title }.
export function footStatus() {
  const s = CH.state;
  if (!s || !s.signedIn) return { cls: '', text: t('chat.status.signedOut'), title: '' };
  const w = summary();
  if (w && w.status === 'quarantined') return { cls: 'error', text: t('chat.status.stopped'), title: t('chat.banner.paused', { workspace: w.name }) };
  if (w && w.status === 'upgrade') return { cls: 'error', text: t('chat.status.update'), title: t('chat.errors.upgrade', { host: s.host }) };
  if (w && w.status === 'loading') return { cls: 'busy', text: t('chat.status.catchingUp'), title: '' };
  if (s.connection === 'online') return { cls: 'ok', text: t('chat.status.connected'), title: t('chat.status.connectedTitle', { host: s.host }) };
  if (s.connection === 'connecting') return { cls: 'busy', text: t(CH.wasOnline ? 'chat.status.reconnecting' : 'chat.status.connecting'), title: '' };
  return { cls: '', text: t('chat.status.offline'), title: s.connection === 'offline' ? t('chat.errors.network', { host: s.host }) : '' };
}

// The Chat segment's badge (contract 3.10): { count, text }, { dot }, or null.
export function modeBadge() {
  const s = CH.state;
  if (!s || !s.signedIn || !s.available) return null;
  return badgeFor({ attention: s.attention, unread: s.unread });
}

// The foot's status line was clicked: a run now, or the Rukoo account page while signed out.
export function reconnect() {
  const s = CH.state;
  if (!s || !s.signedIn) return ctx.openSettings('rukoo');
  return api('chatSync', CH.ws || undefined)
    .then(applyState)
    .catch((err) => toast(chatErrorText(err), 5000));
}

// A chat notification was clicked (contract 5.7): that workspace, that conversation, at that message.
export async function openConversation(ws, c, seq = null) {
  if (!WS_ID.test(ws || '') || !ROOM_ID.test(c || '')) return;
  if (!summary(ws)) return;
  CH.gone = null;
  if (ws !== CH.ws) {
    await selectWorkspace(ws, { openFirst: false });
    if (CH.ws !== ws) return;
  }
  if (!CH.view) await reloadView();
  if (!CH.rooms.has(c)) {
    toast(t('chat.errors.goneConversation'), 5000);
    return openDefault();
  }
  openRoom(c, { at: Number.isSafeInteger(seq) && seq > 0 ? seq : null });
}

// ---------- state ----------

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  const wasAvailable = available();
  const first = !CH.known;
  CH.state = state;
  CH.known = true;
  trackConnection();
  if (!state.signedIn || !state.available) {
    if (CH.ws) switchTo(null);
    CH.gone = null;
    CH.wasOnline = false;
  } else if (!CH.gone) {
    const list = state.workspaces || [];
    const has = (id) => id && list.some((w) => w.id === id);
    const want = has(state.selected) ? state.selected : has(CH.ws) ? CH.ws : list[0]?.id || null;
    if (want !== CH.ws) {
      switchTo(want);
      // Main learns the choice, for its sockets and the next start.
      if (want && want !== state.selected) api('chatSelect', want).catch(() => {});
    }
  }
  if (first || available() !== wasAvailable) ctx.chatAvailability?.();
  else ctx.renderModeSwitch?.();
  redrawSide();
  renderPane();
  maybeTakeJoin();
}

// The connection as the person sees it: "Reconnecting" once it was online, and the banner after ten seconds of it.
function trackConnection() {
  const c = CH.state?.connection;
  if (c === 'online') CH.wasOnline = true;
  if (c === 'connecting' && CH.wasOnline) {
    if (!CH.connectingSince) {
      CH.connectingSince = Date.now();
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => renderPane(), RECONNECT_BANNER_MS + 50);
    }
  } else {
    CH.connectingSince = null;
    clearTimeout(bannerTimer);
  }
}

// Another workspace on screen (or none): what the window had of the one before goes.
function switchTo(ws) {
  CH.generation++;
  CH.ws = ws;
  CH.view = null;
  CH.rooms = new Map();
  CH.members = new Map();
  CH.blocks = new Set();
  CH.openId = null;
  CH.goneRoom = false;
  view?.close();
  if (ws) {
    reloadView().then(() => {
      if (CH.open && CH.ws === ws && !CH.openId && !CH.goneRoom) openDefault();
    });
  }
}

// chatView for the workspace on screen: its rooms, members, channels and blocks from main's cache.
async function reloadView() {
  const ws = CH.ws;
  const gen = CH.generation;
  if (!ws) return;
  let v;
  try {
    v = await api('chatView', ws);
  } catch (err) {
    if (gen === CH.generation && err && err.code === 'not_found') renderPane();
    return;
  }
  if (gen !== CH.generation || CH.ws !== ws || !v) return;
  CH.view = { ws: v.ws, me: v.me, membersMore: Boolean(v.membersMore), channels: v.channels || [] };
  CH.rooms = new Map((v.rooms || []).map((r) => [r.id, r]));
  CH.members = new Map((v.members || []).map((m) => [m.id, m]));
  CH.blocks = new Set((v.blocks || []).map((b) => b.member));
  if (CH.openId && !CH.rooms.has(CH.openId)) CH.openId = null;
  if (CH.openId) view?.roomChanged(CH.rooms.get(CH.openId), { directory: true });
  redrawSide();
  renderPane();
}

export async function selectWorkspace(ws, { openFirst = true } = {}) {
  if (!ws) return;
  CH.gone = null;
  try {
    const state = await api('chatSelect', ws);
    applyState(state);
    if (CH.ws !== ws) switchTo(ws);
    if (!CH.view) await reloadView();
    if (openFirst && CH.open && !CH.openId) openDefault();
  } catch (err) {
    toast(chatErrorText(err), 5000);
  }
}

// The conversation a workspace opens on: the one open last time, else the first in sidebar order.
function openDefault() {
  if (!CH.open || !CH.ws || !CH.view) return renderPane();
  const saved = readSaved()[CH.ws];
  const list = inOrder();
  const pick = (saved && CH.rooms.has(saved) && list.some((r) => r.id === saved) ? saved : null) || list[0]?.id || null;
  if (pick) return openRoom(pick);
  CH.openId = null;
  renderPane();
}

export function openRoom(id, { at = null } = {}) {
  if (!CH.rooms.has(id)) return;
  ensureView();
  CH.goneRoom = false;
  CH.openId = id;
  saveOpen(CH.ws, id);
  redrawSide();
  renderPane();
  view.open(CH.ws, id, { at });
}

// ---------- drawing ----------

// Only once the window has its accounts: before that app.js has no sidebar to draw.
function redrawSide() {
  if (!ctx || !ctx.S || !ctx.S.data || !ctx.S.data.accounts.length) return;
  if (ctx.chatMode?.() && document.querySelector('.sidebar-main')) ctx.renderSidebar();
  else ctx.renderModeSwitch?.();
}

function ensureView() {
  if (view) return;
  const section = $('.chat');
  if (!section) return;
  view = mountView(section, {
    state: () => CH.state,
    me: () => me(),
    myRole: () => myRole(),
    members: () => CH.members,
    blocks: () => CH.blocks,
    room: (id) => CH.rooms.get(id) || null,
    roomName: (room) => roomName(room),
    workspaceName: () => summary()?.name || '',
    active: () => CH.open && Boolean(ctx.chatMode?.()),
    errorText: (err) => chatErrorText(err),
    showMembers: (room) => showMembers(room),
    // The thread panel (U4) sets THREAD.open; until then reply summaries and context lines are text, not buttons.
    threads: () => typeof THREAD.open === 'function',
    openThread: (root, opts) => (typeof THREAD.open === 'function' ? THREAD.open(root, opts) : undefined),
    // OK on a gone conversation: the next one in sidebar order (desktop-ui 7.10).
    goneOk: () => {
      CH.goneRoom = false;
      openDefault();
    },
    // OK on a gone workspace: the next workspace, else the no-workspace state (desktop-ui 7.11).
    goneWorkspaceOk: () => {
      CH.gone = null;
      const next = (CH.state?.workspaces || [])[0];
      if (next) selectWorkspace(next.id);
      else {
        switchTo(null);
        redrawSide();
        renderPane();
      }
    },
    roomOpened: (room) => {
      if (room && room.id) CH.rooms.set(room.id, room);
    },
    roomGone: (id) => {
      if (id !== CH.openId) return;
      CH.goneRoom = true;
      CH.openId = null;
      const room = CH.rooms.get(id);
      CH.rooms.delete(id);
      view.goneConversation(roomName(room));
      redrawSide();
    },
    signIn: () => ctx.openSettings('rukoo-signin'),
    signUp: () => ctx.openSettings('rukoo-signup'),
    makeWorkspace: () => makeWorkspace(),
    joinWorkspace: () => openJoin(),
    browse: ACTIONS.browse ? () => ACTIONS.browse() : null,
    checkUpdates: () => api('updatesOpen').catch(() => {}),
    startOver: () => startOver(),
    syncNow: () => reconnect()
  });
}

// What the pane shows besides an open conversation (contract 5.8), and the banner over it.
function renderPane() {
  if (!CH.open) return;
  ensureView();
  if (!view) return;
  const s = CH.state;
  if (CH.gone) return view.goneWorkspace(CH.gone.name);
  let kind = null;
  if (!s) kind = 'loading';
  else if (!s.storage) kind = 'storage';
  else if (!s.signedIn) kind = 'signedOut';
  else if (!(s.workspaces || []).length) kind = s.connection === 'connecting' ? 'loading' : 'noWorkspace';
  else {
    const w = summary();
    if (w && w.status === 'upgrade') kind = 'upgrade';
    else if (!CH.view) kind = 'loading';
    else if (CH.goneRoom) kind = null;
    else if (!CH.openId) kind = w && w.status === 'loading' && !CH.rooms.size ? 'loading' : 'pick';
  }
  if (kind) view.showState(kind, { inviteSignups: Boolean(s && s.inviteSignups) });
  view.setBanner(bannerFor());
}

function bannerFor() {
  const s = CH.state;
  if (!s || !s.signedIn) return null;
  const w = summary();
  if (w && w.status === 'quarantined') return { icon: 'warning', text: t('chat.banner.paused', { workspace: w.name }), action: { label: t('chat.banner.startOver'), run: () => startOver() } };
  if (s.connection === 'offline') return { icon: 'info', text: t('chat.banner.offline') };
  if (s.connection === 'connecting' && CH.connectingSince && Date.now() - CH.connectingSince >= RECONNECT_BANNER_MS) {
    return { icon: 'sync', text: t('chat.banner.reconnecting', { host: s.host }), action: { label: t('chat.banner.tryNow'), run: () => reconnect() } };
  }
  return null;
}

// Start over on a stopped workspace (contract 3.6): main loads it again from the server.
function startOver() {
  if (!CH.ws) return;
  api('chatReload', CH.ws)
    .then(applyState)
    .catch((err) => toast(chatErrorText(err), 5000));
}

// ---------- the workspace menu (desktop-ui 6.17) ----------

function workspaceMenu(anchor) {
  const list = CH.state?.workspaces || [];
  const items = [{ heading: t('chat.workspace.menuHeading') }];
  for (const w of list) {
    items.push({ icon: tileHtml(w), label: w.name, current: w.id === CH.ws, hint: w.attention ? fmt(w.attention) : '', action: () => selectWorkspace(w.id) });
  }
  const more = typeof ACTIONS.workspaceItems === 'function' ? ACTIONS.workspaceItems() : [];
  if (more.length) items.push({ separator: true }, ...more);
  items.push({ separator: true });
  items.push({ icon: 'plus', label: t('chat.workspace.make'), action: () => makeWorkspace() });
  items.push({ icon: 'link', label: t('chat.workspace.join'), action: () => openJoin() });
  showMenu(anchor, items, { align: 'left' });
}

// ---------- making and joining (U5 moves these into chat-dialogs.js with the rest of desktop-ui 6) ----------

// The name a person goes by in a new workspace: the first mail account's display name, else the part of the Rukoo
// account's address before the @ (contract 3.3).
async function defaultName() {
  const acc = ctx.S?.data?.accounts?.[0];
  if (acc && String(acc.name || '').trim()) return String(acc.name).trim();
  const status = await api('accountStatus').catch(() => null);
  return status && typeof status.email === 'string' ? status.email.split('@')[0] : '';
}

// 1 to 80 characters on one line, as the server takes them (contract 3.16).
const nameOk = (s) => {
  const v = String(s || '').trim();
  return v.length > 0 && [...v].length <= 80 && !/[\r\n]/.test(v);
};

function showError(body, field, text) {
  for (const el of body.querySelectorAll('[data-error]')) {
    const mine = el.dataset.error === (field || '');
    el.hidden = !(mine && text);
    if (mine) el.textContent = text || '';
  }
  if (field) body.querySelector(`[name="${field}"]`)?.focus();
}

function setBusy(scrim, busy) {
  for (const b of scrim.querySelectorAll('.buttons button')) b.disabled = busy;
  const primary = scrim.querySelector('.buttons button:last-child');
  if (primary) primary.toggleAttribute('aria-busy', busy);
}

// Make a workspace (desktop-ui 6.1): its name, your name in it, and who hosts it.
export async function makeWorkspace() {
  if (!CH.state || !CH.state.signedIn) return;
  const yourName = await defaultName();
  let finish = null;
  let busy = false;
  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const name = body.querySelector('[name="name"]').value.trim();
    const displayName = body.querySelector('[name="displayName"]').value.trim();
    if (!nameOk(name)) return showError(body, 'name', t('chat.errors.invalidName'));
    if (!nameOk(displayName)) return showError(body, 'displayName', t('chat.errors.invalidName'));
    showError(body, null, '');
    busy = true;
    setBusy(scrim, true);
    try {
      const made = await api('chatCreateWorkspace', { name, displayName });
      finish(made && made.ws);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      const field = err && err.code === 'invalid' && ['name', 'displayName'].includes(err.field) ? err.field : '';
      showError(body, field, chatErrorText(err));
    }
  };
  const ws = await dialog({
    title: t('chat.make.title'),
    buttons: [
      { get label() { return t('common.actions.cancel'); }, value: null },
      { label: t('chat.make.submit'), value: (scrim) => (submit(scrim), KEEP_OPEN) }
    ],
    render(body, done) {
      finish = done;
      body.innerHTML = `<div class="form ch-form">
        <label>${esc(t('chat.make.name'))}<input type="text" name="name" autocomplete="off" spellcheck="false" placeholder="${esc(t('chat.make.namePlaceholder'))}"/></label>
        <p class="error" data-error="name" hidden></p>
        <label>${esc(t('chat.make.yourName'))}<input type="text" name="displayName" autocomplete="off" spellcheck="false" value="${esc(yourName)}"/></label>
        <p class="error" data-error="displayName" hidden></p>
        ${hostNote()}
        <p class="error" data-error="" hidden></p>
      </div>`;
      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('input')) {
          e.preventDefault();
          submit(body.closest('.scrim'));
        }
      });
    }
  });
  if (ws) await selectWorkspace(ws);
}

const firstUrlHost = (text) => {
  const m = String(text || '').match(/https?:\/\/[^\s]+/);
  if (!m) return '';
  try {
    return new URL(m[0]).host;
  } catch (_) {
    return '';
  }
};

// Join with an invitation link. U3 opens it for a pending join from a sign-up and from the empty state; U5's Join
// dialog (desktop-ui 6.2, with the preview card) takes its place. link: filled in when there is one.
export async function openJoin(link = '') {
  if (!CH.state || !CH.state.signedIn) return;
  const yourName = await defaultName();
  let finish = null;
  let busy = false;
  let preview = null;
  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const text = body.querySelector('[name="link"]').value.trim();
    if (preview && preview.already) {
      finish({ ws: preview.workspace.id, already: true });
      return;
    }
    busy = true;
    setBusy(scrim, true);
    try {
      if (!preview) {
        preview = await api('chatPreviewInvite', text);
        const info = body.querySelector('[data-preview]');
        const lines = preview.already
          ? [t('chat.join.already', { name: preview.workspace.name })]
          : [
              t(preview.role === 'guest' ? 'chat.join.invitedByGuest' : 'chat.join.invitedBy', { name: preview.issuer?.name || '' }),
              t('chat.join.channels', { count: Number(preview.channels) || 0 }),
              t('chat.join.history')
            ];
        info.innerHTML = `<p class="ch-join-ws">${esc(preview.workspace.name)}</p>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}`;
        info.hidden = false;
        body.querySelector('[data-name]').hidden = Boolean(preview.already);
        body.querySelector('[name="link"]').readOnly = true;
        const primary = scrim.querySelector('.buttons button:last-child');
        primary.textContent = preview.already ? t('chat.join.open') : t('chat.join.submit', { name: preview.workspace.name });
        busy = false;
        setBusy(scrim, false);
        if (!preview.already) body.querySelector('[name="name"]').focus();
        return;
      }
      const name = body.querySelector('[name="name"]').value.trim();
      if (!nameOk(name)) {
        busy = false;
        setBusy(scrim, false);
        return showError(body, 'name', t('chat.errors.invalidName'));
      }
      const joined = await api('chatJoin', { link: text, name });
      finish(joined);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      const field = err && err.code === 'invalid' && err.field === 'name' ? 'name' : '';
      showError(body, field, chatErrorText(err, { linkHost: firstUrlHost(text) }));
    }
  };
  const joined = await dialog({
    title: t('chat.join.title'),
    buttons: [
      { get label() { return t('common.actions.cancel'); }, value: null },
      { label: t('chat.join.check'), value: (scrim) => (submit(scrim), KEEP_OPEN) }
    ],
    render(body, done) {
      finish = done;
      body.innerHTML = `<div class="form ch-form">
        <label>${esc(t('chat.join.link'))}<input type="text" name="link" autocomplete="off" spellcheck="false" value="${esc(link)}"/></label>
        <div class="ch-join-preview" data-preview hidden></div>
        <label data-name hidden>${esc(t('chat.make.yourName'))}<input type="text" name="name" autocomplete="off" spellcheck="false" value="${esc(yourName)}"/></label>
        <p class="error" data-error="name" hidden></p>
        ${hostNote()}
        <p class="error" data-error="" hidden></p>
      </div>`;
      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('input')) {
          e.preventDefault();
          submit(body.closest('.scrim'));
        }
      });
      // A link that came with a sign-up loads its preview at once.
      if (link) setTimeout(() => submit(body.closest('.scrim')), 0);
    }
  });
  if (joined && joined.ws) {
    if (joined.already) toast(t('chat.join.already', { name: summary(joined.ws)?.name || preview?.workspace?.name || '' }));
    await selectWorkspace(joined.ws);
  }
}

// A sign-up with an invitation link left a pending join: the next time Chat shows, the Join dialog opens with it
// (contract 3.3, 5.8).
function maybeTakeJoin() {
  if (!CH.open || takingJoin || !CH.state || !CH.state.pendingJoin || !CH.state.signedIn) return;
  takingJoin = true;
  api('chatTakePendingJoin')
    .then((r) => (r && r.link ? openJoin(r.link) : null))
    .catch(() => {})
    .finally(() => {
      takingJoin = false;
    });
}

// ---------- a channel's members (U5's members dialog, desktop-ui 6.6, takes its place) ----------

async function showMembers(room) {
  if (!room || !CH.ws) return;
  const ws = CH.ws;
  await dialog({
    title: room.kind === 'channel' ? t('chat.channel.membersTitle', { name: room.name || '' }) : roomName(room),
    buttons: [{ get label() { return t('common.actions.close'); }, value: null }],
    render(body) {
      body.innerHTML = `<div class="ch-members" aria-busy="true"><span class="spinner"></span></div>`;
      api('chatRoomMembers', ws, room.id)
        .then((r) => {
          const list = (r && r.members) || [];
          const name = (m) => displayName(CH.members.get(m.member), t);
          list.sort((a, b) => collator().compare(name(a), name(b)));
          const rows = list
            .map((m) => {
              const member = CH.members.get(m.member);
              const label = m.member === me() ? t('chat.members.you', { name: name(m) }) : name(m);
              const tags = [m.role === 'manager' ? t('chat.roles.manager') : '', member && member.role === 'guest' ? t('chat.roles.guest') : ''].filter(Boolean);
              return `<li class="ch-member">${memberAvatar(m.member, 'ch-av-24')}<span class="ch-member-name">${esc(label)}</span>${tags.map((x) => `<span class="ch-tag">${esc(x)}</span>`).join('')}</li>`;
            })
            .join('');
          body.innerHTML = `<ul class="ch-members">${rows}</ul>`;
        })
        .catch((err) => {
          body.innerHTML = `<p class="error">${esc(chatErrorText(err))}</p>`;
        });
    }
  });
}
