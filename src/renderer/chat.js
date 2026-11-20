import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, $, hue, initials, toast, showMenu } from './ui.js';
import { sortRooms, dmTitle, displayName, roomBadge, modeBadge as badgeFor } from './chat-model.js';
import { mountView } from './chat-view.js';
import * as D from './chat-dialogs.js';

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
  // The open conversation went (desktop-ui 7.10): { room } (the Room as it was, or null) while the gone state shows,
  // until OK. The room is kept so a language change can draw its name again.
  goneRoom: null,
  // A channel the person isn't in, opened from Browse (contract 5.5 "Channel not joined"): its directory row.
  preview: null,
  // Connection history for the foot status and the reconnecting banner.
  wasOnline: false,
  connectingSince: null,
  // The lost-unsent toast showed for the count main reports now (noticeLostUnsent).
  lostShown: false
};

// Sidebar and menu entries, filled in by chat-dialogs.js (desktop-ui 6): New message, the Channels plus menu, Browse
// channels, the workspace menu's items, and blocking someone from a message's menu.
export const ACTIONS = {
  newMessage: () => D.newMessage(),
  addChannel: (anchor) => channelMenu(anchor),
  browse: () => D.browseChannels(),
  workspaceItems: () => D.workspaceItems(),
  // block(memberId): the block confirmation (desktop-ui 6.13).
  block: (member) => D.blockMember(member)
};
// The thread panel (chat-view.js): open(root, { seq }) shows a thread beside the log, or over it in a narrow view.
export const THREAD = { open: null };

let ctx = null;
let view = null;
let directoryTimer = null;
let bannerTimer = null;
let takingJoin = false;
// A pending join waiting for another dialog to close.
let joinRetry = null;
// The chatView in flight for the workspace on screen: { gen, promise }, so a caller waits for it instead of asking again.
let loading = null;
// openConversation is choosing the room: a workspace switch's own first-room open stands back.
let routing = 0;
// Rooms this window is leaving (Leave channel, Leave conversation, Remove from list): their eviction opens the next
// conversation instead of the gone state.
const leaving = new Set();
// Workspaces this window is leaving or deleting: their removal opens the next workspace instead of the gone state.
const goingAway = new Set();

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
  D.bindDialogs({
    CH,
    ctx,
    errorText: (err, context2) => chatErrorText(err, context2),
    hostNote: () => hostNote(),
    summary: (id) => summary(id),
    me: () => me(),
    myRole: () => myRole(),
    isGuest: () => isGuest(),
    roomName: (room) => roomName(room),
    memberAvatar: (id, cls) => memberAvatar(id, cls),
    tileHtml: (w) => tileHtml(w),
    selectWorkspace: (ws, opts) => selectWorkspace(ws, opts),
    openRoom: (id, opts) => openRoom(id, opts),
    openDefault: () => openDefault(),
    previewChannel: (channel) => previewChannel(channel),
    expectLeave: (id) => leaving.add(id),
    cancelLeave: (id) => leaving.delete(id),
    afterLeave: (id) => afterLeave(id),
    expectGone: (ws) => goingAway.add(ws),
    cancelGone: (ws) => goingAway.delete(ws),
    reload: () => reloadView(),
    refreshState: () =>
      api('chatState')
        .then(applyState)
        .catch(() => {}),
    setBlocks: (blocks) => {
      if (Array.isArray(blocks)) CH.blocks = new Set(blocks.map((b) => b.member));
      redrawSide();
      // A closed DM's bar says who you blocked and what you can do about it.
      const open = CH.openId && CH.rooms.get(CH.openId);
      if (view && open) view.roomChanged(open);
    }
  });
  // A pending join waits while Settings covers the window (the sign-up that made it is still on screen there).
  document.addEventListener('rukoo:settings-closed', () => maybeTakeJoin());
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
  if (CH.ws && CH.view && !CH.openId && !CH.goneRoom && !CH.preview) openDefault();
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
      if (CH.open && !CH.openId && !CH.goneRoom && !CH.gone && !CH.preview && CH.view && !routing) openDefault();
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
      if (leaving.has(p.conversation)) {
        CH.rooms.delete(p.conversation);
        if (p.conversation === CH.openId) {
          CH.openId = null;
          openDefault();
        } else redrawSide();
      } else if (p.conversation === CH.openId) roomGone(p.conversation);
      else {
        CH.rooms.delete(p.conversation);
        redrawSide();
      }
      return;
    case 'removed':
      // Leaving or deleting it here: the next workspace opens, as the state that follows says.
      if (goingAway.has(p.ws)) {
        goingAway.delete(p.ws);
        api('chatState')
          .then(applyState)
          .catch(() => {});
        return;
      }
      workspaceGone(p.ws);
      return;
    default:
  }
}

// A room this window left: it goes from the list now, and the next conversation opens when it was on screen. Its
// eviction can come a little later; until then it counts as expected.
function afterLeave(id) {
  CH.rooms.delete(id);
  if (CH.openId === id) {
    CH.openId = null;
    openDefault();
  } else redrawSide();
  setTimeout(() => leaving.delete(id), 10000);
}

// The open conversation went (desktop-ui 7.10): evicted, or a 404 with scope 'conversation' about it.
function roomGone(id) {
  if (id !== CH.openId) return;
  const room = CH.rooms.get(id) || null;
  CH.goneRoom = { room };
  CH.openId = null;
  CH.rooms.delete(id);
  view?.goneConversation(roomName(room));
  redrawSide();
}

// The workspace on screen went (desktop-ui 7.11): removed, or a 404 with scope 'workspace' from a call about it.
function workspaceGone(ws) {
  if (!ws || ws !== CH.ws || CH.gone) return;
  CH.gone = { name: summary(ws)?.name || CH.view?.ws?.name || '' };
  CH.generation++;
  CH.rooms.clear();
  CH.members.clear();
  CH.blocks.clear();
  CH.openId = null;
  CH.goneRoom = null;
  CH.preview = null;
  CH.view = null;
  if (CH.open) view?.goneWorkspace(CH.gone.name);
  redrawSide();
}

// A call's error that says the room or the workspace on screen is gone shows that state. True when it did.
function goneError(err, ws, c) {
  if (!err || err.code !== 'not_found') return false;
  if (err.scope === 'workspace' && ws === CH.ws) {
    workspaceGone(ws);
    return true;
  }
  if (err.scope === 'conversation' && ws === CH.ws && c && c === CH.openId) {
    roomGone(c);
    return true;
  }
  return false;
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
  // Ctrl+N: New message, for full members (desktop-ui 9.2).
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
    if (CH.ws && CH.view && !isGuest()) ACTIONS.newMessage();
    return true;
  }
  return view ? view.onKey(e, { typing }) : false;
}

// app.js draws the sidebar again as a whole: on every rooms event (any message, read or badge in the workspace), on
// every state change and when a room opens. The keyboard stays where it was, as calendar.js keepSideFocus() does:
// sidebarHtml() runs just before the old buttons go, so it notes the focused row or button and puts the focus on its
// new copy once the redraw is done.
function keepSideFocus() {
  const el = document.activeElement;
  if (!el || !el.closest || !el.closest('.sidebar .sidebar-main')) return;
  let selector = null;
  if (el.dataset.chOpen) selector = `[data-ch-open="${CSS.escape(el.dataset.chOpen)}"]`;
  else if (el.dataset.chSide) selector = `[data-ch-side="${CSS.escape(el.dataset.chSide)}"]`;
  else if (el.dataset.action) selector = `[data-action="${CSS.escape(el.dataset.action)}"]`;
  if (!selector) return;
  queueMicrotask(() => {
    if (document.contains(el)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    $(`.sidebar .sidebar-main ${selector}`)?.focus({ preventScroll: true });
  });
}

// The list keeps its place through those redraws as well. The open conversation's row comes into view when another
// conversation opens and when Chat's list comes back after another mode: in the rail at 200 percent zoom the list shows
// about three rows and the whole column scrolls, so the open row is easily out of sight.
let shownRoom = null;
function keepSideScroll() {
  const nav = $('.sidebar .ch-nav');
  const top = nav ? nav.scrollTop : 0;
  queueMicrotask(() => {
    const next = $('.sidebar .ch-nav');
    if (!next) return;
    if (nav && next !== nav) next.scrollTop = top;
    if (!CH.openId) shownRoom = null;
    if (!CH.openId || (nav && CH.openId === shownRoom)) return;
    const row = next.querySelector(`[data-ch-open="${CSS.escape(CH.openId)}"]`);
    if (!row) return;
    shownRoom = CH.openId;
    // The list first, then the column around it; 8px to spare, so the row doesn't end right at the cut.
    for (const box of [next, $('.sidebar')]) {
      const r = row.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.top < b.top + 8) box.scrollTop -= b.top + 8 - r.top;
      else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - (b.bottom - 8);
    }
  });
}

// The sidebar below the mode switch (contract 5.3); app.js adds its foot.
export function sidebarHtml() {
  keepSideFocus();
  keepSideScroll();
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
  // A closed DM says so in the trailing slot; dimming alone reads like a muted row.
  const badge = closed
    ? `<span class="ch-tag ch-row-tag" aria-hidden="true">${esc(t('chat.sidebar.closedTag'))}</span>`
    : b.pill
      ? `<span class="ch-badge" aria-hidden="true">${fmt(b.pill)}</span>`
      : b.count
        ? `<span class="count strong" aria-hidden="true">${fmt(b.count)}</span>`
        : '';
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
    // The focus stays on the row, by click and by Enter: the redraw puts it on the row's new copy (keepSideFocus).
    openRoom(btn.dataset.chOpen);
    return true;
  }
  switch (btn.dataset.chSide) {
    case 'workspaces':
      workspaceMenu(btn);
      return true;
    case 'make':
      D.makeWorkspace();
      return true;
    case 'join':
      D.joinWorkspace();
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
  routing++;
  try {
    if (ws !== CH.ws) {
      await selectWorkspace(ws, { openFirst: false });
      if (CH.ws !== ws) return;
    }
    await viewReady();
    if (CH.ws !== ws) return;
  } finally {
    routing--;
  }
  if (!CH.rooms.has(c)) {
    toast(t('chat.errors.goneConversation'), 5000);
    return openDefault();
  }
  openRoom(c, { at: Number.isSafeInteger(seq) && seq > 0 ? seq : null });
}

// ---------- state ----------

// openFirst: a workspace switch this state causes opens its first conversation once its view is in. selectWorkspace
// turns it off, because it opens the conversation itself.
function applyState(state, { openFirst = true } = {}) {
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
      switchTo(want, { openFirst });
      // Main learns the choice, for its sockets and the next start.
      if (want && want !== state.selected) api('chatSelect', want).catch(() => {});
    }
  }
  if (first || available() !== wasAvailable) ctx.chatAvailability?.();
  else ctx.renderModeSwitch?.();
  redrawSide();
  renderPane();
  maybeTakeJoin();
  noticeLostUnsent(state);
}

// A broken cache was made again and took unsent messages with it (contract 3.4, ChatState.lostUnsent): one toast says
// how many. Main reports the count until a chatState call takes it, and a state event can bring it first, so the toast
// shows once for it and the chatState call that follows takes it, as Android's takeLostUnsent() does.
function noticeLostUnsent(state) {
  const count = Number(state.lostUnsent) || 0;
  if (count <= 0) {
    CH.lostShown = false;
    return;
  }
  if (CH.lostShown) return;
  CH.lostShown = true;
  toast(t('chat.lostUnsent', { count }), 8000);
  api('chatState')
    .then(applyState)
    .catch(() => {});
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

// Another workspace on screen (or none): what the window had of the one before goes. openFirst: its first conversation
// opens once its view is in; off when the caller opens one itself.
function switchTo(ws, { openFirst = true } = {}) {
  CH.generation++;
  CH.ws = ws;
  CH.view = null;
  CH.rooms = new Map();
  CH.members = new Map();
  CH.blocks = new Set();
  CH.openId = null;
  CH.goneRoom = null;
  CH.preview = null;
  view?.close();
  if (!ws) return;
  const gen = CH.generation;
  const ready = reloadView();
  if (openFirst) {
    ready.then(() => {
      if (gen === CH.generation && CH.open && CH.ws === ws && !CH.openId && !CH.goneRoom && !routing) openDefault();
    });
  }
}

// The workspace on screen has its view: at once, after the chatView already in flight for it, or after a new one.
function viewReady() {
  if (CH.view || !CH.ws) return Promise.resolve();
  if (loading && loading.gen === CH.generation) return loading.promise;
  return reloadView();
}

// chatView for the workspace on screen: its rooms, members, channels and blocks from main's cache.
function reloadView() {
  const gen = CH.generation;
  const promise = loadView();
  const entry = { gen, promise };
  loading = entry;
  const done = () => {
    if (loading === entry) loading = null;
  };
  promise.then(done, done);
  return promise;
}

async function loadView() {
  const ws = CH.ws;
  const gen = CH.generation;
  if (!ws) return;
  let v;
  try {
    v = await api('chatView', ws);
  } catch (err) {
    if (gen !== CH.generation) return;
    if (!goneError(err, ws) && err && err.code === 'not_found') renderPane();
    return;
  }
  if (gen !== CH.generation || CH.ws !== ws || !v) return;
  CH.view = { ws: v.ws, me: v.me, membersMore: Boolean(v.membersMore), channels: v.channels || [] };
  CH.rooms = new Map((v.rooms || []).map((r) => [r.id, r]));
  CH.members = new Map((v.members || []).map((m) => [m.id, m]));
  CH.blocks = new Set((v.blocks || []).map((b) => b.member));
  // A previewed channel follows its directory row (its name and member count).
  if (CH.preview) CH.preview = CH.view.channels.find((c) => c.id === CH.preview.id) || CH.preview;
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
    // One chatView and one opened conversation: the switch only loads the view, and this call opens the room.
    applyState(state, { openFirst: false });
    if (CH.ws !== ws) switchTo(ws, { openFirst: false });
    await viewReady();
    if (CH.ws !== ws) return;
    if (openFirst && CH.open && !CH.openId && !CH.goneRoom) openDefault();
  } catch (err) {
    toast(chatErrorText(err), 5000);
  }
}

// The conversation a workspace opens on: the one open last time, else the first in sidebar order.
function openDefault() {
  CH.preview = null;
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
  CH.goneRoom = null;
  CH.preview = null;
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
    showMembers: (room) => D.channelMembers(room),
    // The header's More menu around Mark as read and Mute (contract 5.4): { top, bottom }.
    roomItems: (room) => roomItems(room),
    // The workspace's status, for the stopped bar (contract 5.5); full members start DMs from a closed one.
    workspaceStatus: () => summary()?.status || null,
    full: () => !isGuest(),
    startDm: (others) => startDm(others),
    // A closed DM's Unblock, when you blocked someone in it; the bar then offers Start a new conversation.
    unblock: (member) => D.unblockMember(member),
    leaveDm: (room) => leaveDm(room),
    // Block {author} in a message's menu, once U5's block dialog is there; full members only (contract 3.12).
    canBlock: () => typeof ACTIONS.block === 'function' && !isGuest(),
    block: (member) => (typeof ACTIONS.block === 'function' ? ACTIONS.block(member) : undefined),
    // OK on a gone conversation: the next one in sidebar order (desktop-ui 7.10).
    goneOk: () => {
      CH.goneRoom = null;
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
    // A call about the open room or the workspace said it is gone (a 404 with that scope): desktop-ui 7.10 or 7.11.
    goneError: (err, ws, c) => goneError(err, ws, c),
    signIn: () => ctx.openSettings('rukoo-signin'),
    signUp: () => ctx.openSettings('rukoo-signup'),
    makeWorkspace: () => D.makeWorkspace(),
    joinWorkspace: () => D.joinWorkspace(),
    browse: () => (isGuest() ? null : ACTIONS.browse()),
    canBrowse: () => !isGuest(),
    // Join on the bar of a previewed channel.
    joinPreview: (channel) => joinPreview(channel),
    checkUpdates: () => api('updatesOpen').catch(() => {}),
    startOver: () => startOver(),
    syncNow: () => reconnect()
  });
  THREAD.open = (root, opts) => view.openThread(root, opts);
}

// A closed DM's Start a new conversation (contract 3.12): the same people again, which the server may refuse.
async function startDm(others) {
  const ws = CH.ws;
  if (!ws || !others.length) return;
  try {
    const res = await api('chatStartDm', ws, others);
    if (ws !== CH.ws || !res || !res.room || !res.room.id) return;
    CH.rooms.set(res.room.id, res.room);
    openRoom(res.room.id);
  } catch (err) {
    if (!goneError(err, ws)) toast(chatErrorText(err), 5000);
  }
}

// A closed DM's Remove from list, and Close conversation: asked first, then the DM leaves the list and the next
// conversation opens (chat-dialogs.js).
function leaveDm(room) {
  return D.leaveConversation(room);
}

// The header's More menu, without Mark as read and Mute, which the view adds between (contract 5.4, desktop-ui 5.2):
// Add people, Members and Rename on top; Leave, Block and Archive below.
function roomItems(room) {
  const top = [];
  const bottom = [];
  if (!room) return { top, bottom };
  const admin = ['owner', 'admin'].includes(myRole());
  if (room.kind === 'channel') {
    const manager = room.role === 'manager' && !room.archived;
    if (manager) top.push({ icon: 'userPlus', label: t('chat.head.addPeople'), action: () => D.channelMembers(room, { add: true }) });
    top.push({ icon: 'people', label: t('chat.head.membersButton'), action: () => D.channelMembers(room) });
    if (manager) top.push({ icon: 'edit', label: t('chat.head.rename'), action: () => D.renameChannel(room) });
    bottom.push({ icon: 'leave', label: t('chat.head.leave'), action: () => D.leaveChannel(room) });
    if (!room.archived && (room.role === 'manager' || admin)) bottom.push({ separator: true }, { icon: 'archive', label: t('chat.head.archive'), danger: true, action: () => D.archiveChannel(room) });
  } else {
    const others = (room.participants || []).filter((id) => id !== me());
    if (others.length > 1) top.push({ icon: 'people', label: t('chat.head.membersButton'), action: () => D.channelMembers(room) });
    if (!room.closedReason) bottom.push({ icon: 'leave', label: t('chat.head.leaveDm'), action: () => D.leaveConversation(room) });
    else bottom.push({ icon: 'leave', label: t('chat.input.removeFromList'), action: () => D.leaveConversation(room) });
    const other = others.length === 1 ? CH.members.get(others[0]) : null;
    if (!isGuest() && other && other.state === 'active' && other.role !== 'guest' && !CH.blocks.has(other.id)) {
      bottom.push({ icon: 'ban', label: t('chat.head.block', { name: displayName(other, t) }), action: () => D.blockMember(other.id) });
    }
  }
  return { top, bottom };
}

// The Channels plus menu (desktop-ui 5.1): Make a channel, Browse channels.
function channelMenu(anchor) {
  showMenu(
    anchor,
    [
      { icon: 'plus', label: t('chat.sidebar.makeChannel'), action: () => D.makeChannel() },
      { icon: 'search', label: t('chat.sidebar.browse'), action: () => D.browseChannels() }
    ],
    { align: 'left' }
  );
}

// A channel the person isn't in, from Browse: its header and the Join bar (contract 5.5). Nothing of its history
// shows, because the server lets only members read it.
function previewChannel(channel) {
  if (!channel || !CH.ws) return;
  if (CH.rooms.has(channel.id)) return openRoom(channel.id);
  ensureView();
  CH.goneRoom = null;
  CH.openId = null;
  CH.preview = channel;
  redrawSide();
  renderPane();
}

async function joinPreview(channel) {
  const ws = CH.ws;
  if (!ws || !channel) return;
  try {
    await api('chatJoinChannel', ws, channel.id);
    for (let i = 0; i < 80 && ws === CH.ws && !CH.rooms.has(channel.id); i++) await new Promise((r) => setTimeout(r, 100));
    if (ws !== CH.ws) return;
    if (!CH.rooms.has(channel.id)) await reloadView();
    if (CH.rooms.has(channel.id)) openRoom(channel.id);
  } catch (err) {
    if (!goneError(err, ws)) toast(chatErrorText(err), 5000);
  }
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
    else if (CH.goneRoom) kind = 'goneRoom';
    else if (!CH.openId && CH.preview) kind = 'preview';
    else if (!CH.openId) kind = w && w.status === 'loading' && !CH.rooms.size ? 'loading' : 'pick';
  }
  // The gone conversation stays until OK; drawn again only when its text changed (a language change).
  if (kind === 'goneRoom') view.goneConversation(roomName(CH.goneRoom.room), { focus: false });
  else if (kind === 'preview') view.preview(CH.preview, { join: () => joinPreview(CH.preview) });
  else if (kind) view.showState(kind, { inviteSignups: Boolean(s && s.inviteSignups) });
  view.setBanner(bannerFor());
  view.stateChanged();
}

function bannerFor() {
  const s = CH.state;
  if (!s || !s.signedIn) return null;
  const w = summary();
  if (w && w.status === 'quarantined') return { icon: 'warning', text: t('chat.banner.paused', { workspace: w.name }), action: { label: t('chat.banner.startOver'), run: () => startOver() } };
  // Offline means the chat server is out of reach, which says nothing about the computer's network: name the server.
  if (s.connection === 'offline') return { icon: 'info', text: t('chat.banner.offline', { host: s.host || '' }), action: { label: t('chat.banner.tryNow'), run: () => reconnect() } };
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

// ---------- the workspace menu (desktop-ui 6.17, contract 5.10) ----------

function workspaceMenu(anchor) {
  const list = CH.state?.workspaces || [];
  const items = [{ heading: t('chat.workspace.menuHeading') }];
  for (const w of list) {
    items.push({ icon: tileHtml(w), label: w.name, current: w.id === CH.ws, hint: w.attention ? fmt(w.attention) : '', action: () => selectWorkspace(w.id) });
  }
  const { top, bottom } = ACTIONS.workspaceItems();
  if (top.length) items.push({ separator: true }, ...top);
  items.push({ separator: true });
  items.push({ icon: 'plus', label: t('chat.workspace.make'), action: () => D.makeWorkspace() });
  items.push({ icon: 'link', label: t('chat.workspace.join'), action: () => D.joinWorkspace() });
  if (bottom.length) items.push({ separator: true }, ...bottom);
  showMenu(anchor, items, { align: 'left' });
}

// Make a workspace and Join with an invitation link (chat-dialogs.js), for the empty states and the menu.
export const makeWorkspace = () => D.makeWorkspace();
export const openJoin = (link = '') => D.joinWorkspace(link);

// A sign-up with an invitation link left a pending join: the next time Chat shows, the Join dialog opens with it
// (contract 3.3, 5.8). Not while Settings covers the window, where the sign-up still shows: closing it brings the
// dialog (rukoo:settings-closed). Not over another dialog either: it opens once that one closes.
function maybeTakeJoin() {
  clearTimeout(joinRetry);
  joinRetry = null;
  if (!CH.open || takingJoin || !CH.state || !CH.state.pendingJoin || !CH.state.signedIn) return;
  if (document.querySelector('#overlays .page.settings')) return;
  if (document.querySelector('.scrim')) {
    joinRetry = setTimeout(maybeTakeJoin, 400);
    return;
  }
  takingJoin = true;
  api('chatTakePendingJoin')
    .then((r) => (r && r.link ? D.joinWorkspace(r.link) : null))
    .catch(() => {})
    .finally(() => {
      takingJoin = false;
    });
}
