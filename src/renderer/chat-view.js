import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, hhmm, longDate, listTime, groupLabel, hue, initials, showMenu, toast, confirmDialog } from './ui.js';
import { h } from './agent/bui.js';
import { timeline, displayName, memberTag, canRemove } from './chat-model.js';
import { segments, toParts } from './chat-text.js';
import { mountChatInput } from './chat-input.js';

// Team chat's pane (contract 5.4 to 5.6, desktop-ui 5.2 to 5.7 and 7): the open conversation's header, the banner,
// the log with its reading, jump pills and older history, the composer and the bars that replace it, unsent messages
// with their actions, the message tools and menus, the thread panel, and the pane's states. chat.js decides what
// shows; this module draws it. The log's rows come from chat-model.js timeline() and are kept by key: a row is built
// again only when its sig changed, so live messages, pending sends and removals touch only their rows and the scroll
// position holds.
//
// Everything in the log was written by people: it reaches the DOM through h()'s text prop and text nodes, never as
// HTML. Icons are the app's own static markup.

// When the log is this close to its end, a new message keeps it there (desktop-ui 5.3).
const STICK_PX = 80;
// Older messages load when the top is this close.
const OLDER_PX = 400;
// A read report goes this long after the last change (contract 3.9, READ_REPORT_DELAY).
const READ_DELAY = 1000;
// A row opened at from a notification keeps its outline this long.
const TARGET_MS = 2000;
const ANNOUNCE_CHARS = 120;
// The picker puts people who posted among this many of the last messages first (desktop-ui 5.6).
const RECENT_MESSAGES = 50;

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const behavior = () => (reduced() ? 'auto' : 'smooth');

// The app's icon markup as an element. Static strings from icons.js only.
function svg(name) {
  const tpl = document.createElement('template');
  tpl.innerHTML = icons[name] || '';
  return tpl.content.firstElementChild;
}

function avatarEl(id, name, { cls = 'ch-av', deleted = false } = {}) {
  const el = h('span', { class: `avatar ${cls}`, 'aria-hidden': 'true', text: deleted ? '?' : initials({ name }) });
  el.style.setProperty('--h', String(hue(id || '')));
  return el;
}

function timeEl(at, cls = 'ch-time') {
  const iso = Number.isFinite(at) ? new Date(at).toISOString() : '';
  return h('time', { class: cls, datetime: iso, title: longDate(at), text: hhmm(at) });
}

const dayOf = (at) => (Number.isFinite(at) ? new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(at)) : '');
// A retry time to the second: the waits between attempts are seconds long.
const clockTime = (at) => (Number.isFinite(at) ? new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(at)) : '');
const firstChars = (text, n) => {
  const chars = [...String(text || '').replace(/\s+/g, ' ').trim()];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
};
const bySeq = (a, b) => a.seq - b.seq;

function copyText(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(
    () => toast(t('chat.msg.copied')),
    () => {}
  );
}

// section: the .chat element app.js made. H: what chat.js gives the view (see chat.js ensureView).
export function mountView(section, H) {
  section.textContent = '';
  const main = h('div', { class: 'ch-main' });
  const head = h('header', { class: 'ch-head', hidden: true });
  const banner = h('div', { class: 'ch-banner', role: 'status', hidden: true });
  const scroll = h('div', { class: 'ch-scroll', tabindex: '-1' });
  const older = h('div', { class: 'ch-older' });
  const log = h('ol', { class: 'ch-log' });
  scroll.append(older, log);
  const jumpUp = h('button', { class: 'ch-jump is-up', type: 'button', 'data-ch': 'jump-unread', hidden: true });
  const jumpDown = h('button', { class: 'ch-jump is-down', type: 'button', 'data-ch': 'jump-latest', hidden: true });
  // The log and the pills over it, which sit at its own top and bottom edge.
  const area = h('div', { class: 'ch-log-area', hidden: true }, scroll, jumpUp, jumpDown);
  const compose = h('div', { class: 'ch-compose', hidden: true });
  const empty = h('div', { class: 'ch-empty', hidden: true });
  const announce = h('div', { class: 'ch-announce', 'aria-live': 'polite' });
  main.append(head, banner, area, compose, empty, announce);

  // The thread panel (desktop-ui 5.7): docked beside the log from 900px of the view's own width, over it below that.
  const tBack = h('button', { type: 'button', class: 'icon-btn sm ch-thread-back', 'data-ch': 'thread-back' }, svg('back'));
  // Its parts have classes of their own (ch-thread-*), so a selector for the conversation's log, header or composer
  // never finds the thread's as well.
  const tTitle = h('h2', { class: 'ch-thread-title' });
  const tMeta = h('div', { class: 'ch-thread-meta' });
  const tClose = h('button', { type: 'button', class: 'icon-btn sm ch-thread-close', 'data-ch': 'thread-close' }, svg('close'));
  const tHead = h('header', { class: 'ch-thread-head' }, tBack, h('div', { class: 'ch-thread-titles' }, tTitle, tMeta), tClose);
  const tOlder = h('div', { class: 'ch-thread-older' });
  const tNote = h('div', { class: 'ch-thread-note', hidden: true });
  const tLog = h('ol', { class: 'ch-thread-log' });
  const tScroll = h('div', { class: 'ch-thread-scroll', tabindex: '-1' }, tOlder, tNote, tLog);
  const tCompose = h('div', { class: 'ch-thread-compose' });
  const thread = h('aside', { class: 'ch-thread', hidden: true }, tHead, tScroll, tCompose);
  section.append(main, thread);

  // 'room' while a conversation shows, 'state' for an empty or gone state, null before either.
  let mode = null;
  let stateKey = null;
  let bannerKey = null;
  let token = 0;
  let V = blank();
  // The open room's composer (chat-input.js).
  let input = null;
  // The open thread: { root, seq, ev, nodes, rows, complete, expired, loading, error, token, input, … }, or null.
  let T = null;
  // The room's members for the mention picker, loaded once per opened room: { key, promise }.
  let memberCache = null;
  // The connection the unsent rows were drawn for: a queued message waits for it.
  let drawnConnection = null;

  function blank() {
    return {
      ws: null,
      c: null,
      room: null,
      events: [],
      lo: null,
      hi: null,
      floor: 1,
      hasOlder: false,
      readAtOpen: null,
      at: null,
      // False when the open didn't reach at: at is then the newest cached event or the oldest loaded one, not the
      // message the notification was about.
      complete: true,
      pending: [],
      // messageId -> local ID of sends that committed while the room was open, so their rows keep their keys.
      sentLocal: new Map(),
      // The events arrived: the room has a cache to show. Until then the log shows its loading row.
      loaded: false,
      opening: false,
      openError: null,
      // 'idle', 'loading' or 'failed'.
      older: 'idle',
      // Reading (contract 3.9): the highest message seen fully in view while it counted, and the last one reported.
      visible: new Set(),
      readBest: 0,
      readSent: 0,
      readTimer: null,
      // New messages below the view while it was scrolled up.
      unseen: 0,
      nodes: new Map(),
      // The rows on screen by key, for the tools and menus.
      rows: new Map(),
      focusKey: null,
      targetTimer: null
    };
  }

  const members = () => H.members();
  const nameOf = (id) => displayName(members().get(id), t);
  // A conversation as text says it: #name for a channel, the people for a DM.
  const roomLabel = (room) => (!room ? '' : room.kind === 'dm' ? H.roomName(room) : `#${room.name || ''}`);

  // ---------- reading ----------

  // A row counts as seen when 90 percent of it shows, or when it fills 90 percent of the view (a message taller than
  // the log).
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const seq = Number(e.target.dataset.seq);
        if (!seq) continue;
        const tall = e.rootBounds && e.intersectionRect.height >= e.rootBounds.height * 0.9;
        if (e.isIntersecting && (e.intersectionRatio >= 0.9 || tall)) V.visible.add(seq);
        else V.visible.delete(seq);
      }
      considerRead();
    },
    { root: scroll, threshold: [0, 0.25, 0.5, 0.75, 0.9, 1] }
  );

  // Reading counts while the window has focus, Chat is on screen with this room, and nothing covers it (no Settings
  // page, no dialog, no thread over the log). The thread itself reports nothing (contract 3.9).
  const canRead = () =>
    mode === 'room' &&
    V.loaded &&
    V.c &&
    H.active() &&
    document.hasFocus() &&
    document.visibilityState !== 'hidden' &&
    !document.querySelector('#overlays .page, .scrim') &&
    !(T && getComputedStyle(thread).position === 'absolute');

  function considerRead() {
    if (!canRead()) return;
    let best = 0;
    for (const s of V.visible) if (s > best) best = s;
    if (best <= V.readBest) return;
    V.readBest = best;
    clearTimeout(V.readTimer);
    const at = token;
    V.readTimer = setTimeout(() => flushRead(at), READ_DELAY);
  }

  function flushRead(at) {
    if (at !== token || V.readBest <= V.readSent) return;
    const seq = V.readBest;
    const before = V.readSent;
    V.readSent = seq;
    api('chatRead', V.ws, V.c, seq).catch(() => {
      if (at === token && V.readSent === seq) V.readSent = before;
    });
  }

  // A dialog closing or the window coming back can make what shows count: look again.
  const recheck = () => setTimeout(considerRead, 0);
  window.addEventListener('focus', recheck);
  document.addEventListener('visibilitychange', recheck);
  document.addEventListener('click', recheck, true);
  document.addEventListener('keyup', recheck, true);

  // Mark as read and Shift+Escape: everything up to head.
  function markRead() {
    if (mode !== 'room' || !V.c) return;
    const top = V.room?.head || 0;
    V.readBest = Math.max(V.readBest, top);
    V.readSent = Math.max(V.readSent, top);
    clearTimeout(V.readTimer);
    const ws = V.ws;
    const c = V.c;
    api('chatMarkRead', ws, c).catch((err) => H.goneError(err, ws, c) || toast(H.errorText(err), 5000));
  }

  // ---------- shell ----------

  function showRoom(on) {
    head.hidden = !on;
    area.hidden = !on;
    compose.hidden = !on;
    empty.hidden = on;
    banner.hidden = !on || !bannerKey;
    if (!on) jumpUp.hidden = jumpDown.hidden = true;
  }

  // Leaves the open room: its thread, composer, rows, timers and observer entries go. The composer's draft is saved
  // first.
  function dropRoom() {
    closeThread({ restoreFocus: false });
    main.classList.remove('is-preview');
    if (input) input.dispose();
    input = null;
    compose.textContent = '';
    memberCache = null;
    clearTimeout(V.readTimer);
    clearTimeout(V.targetTimer);
    for (const li of V.nodes.values()) io.unobserve(li);
    log.textContent = '';
    older.textContent = '';
    older.className = 'ch-older';
    head.textContent = '';
    announce.textContent = '';
    V = blank();
  }

  // ---------- states (contract 5.8, desktop-ui 7) ----------

  function emptyBox({ icon = 'chat', title, body = '', hint = '', busy = false, actions = [] }) {
    empty.textContent = '';
    empty.classList.toggle('is-busy', busy);
    if (busy) {
      empty.setAttribute('aria-busy', 'true');
      empty.setAttribute('aria-label', title);
      empty.append(h('span', { class: 'spinner' }));
      return;
    }
    empty.removeAttribute('aria-busy');
    empty.removeAttribute('aria-label');
    if (icon) empty.append(svg(icon));
    empty.append(h('h2', { class: 'ch-empty-title', text: title }));
    if (body) empty.append(h('p', { class: 'ch-empty-body', text: body }));
    if (actions.length) {
      const row = h('div', { class: 'ch-empty-actions' });
      for (const a of actions) row.append(h('button', { type: 'button', class: `btn ${a.primary ? 'primary' : 'secondary'}`, 'data-ch-empty': a.id, text: a.label, onClick: a.run }));
      empty.append(row);
    }
    if (hint) empty.append(h('p', { class: 'ch-empty-hint', text: hint }));
  }

  // kind: loading, signedOut, storage, upgrade, noWorkspace, pick. opts: { inviteSignups }.
  function showState(kind, opts = {}) {
    const key = `${kind}|${getLocale()}|${opts.inviteSignups ? 1 : 0}|${H.workspaceName()}|${H.state()?.host || ''}`;
    if (mode === 'state' && key === stateKey) return;
    if (V.c || mode === 'preview') dropRoom();
    token++;
    mode = 'state';
    stateKey = key;
    showRoom(false);
    const host = H.state()?.host || '';
    switch (kind) {
      case 'loading':
        return emptyBox({ title: t('chat.empty.loading'), busy: true });
      case 'signedOut':
        return emptyBox({
          title: t('chat.empty.signedOutTitle'),
          body: t('chat.empty.signedOutBody', { host }),
          hint: opts.inviteSignups ? t('chat.empty.inviteHint') : '',
          actions: [
            { id: 'sign-up', label: t('chat.empty.signUpAction'), run: () => H.signUp() },
            { id: 'sign-in', label: t('chat.empty.signInAction'), primary: true, run: () => H.signIn() }
          ]
        });
      case 'storage':
        return emptyBox({ icon: 'warning', title: t('chat.empty.storageTitle'), body: t('chat.empty.storageBody') });
      case 'upgrade':
        return emptyBox({
          icon: 'download',
          title: t('chat.empty.upgradeTitle'),
          body: t('chat.empty.upgradeBody', { host }),
          actions: [{ id: 'updates', label: t('chat.empty.upgradeAction'), run: () => H.checkUpdates() }]
        });
      case 'noWorkspace':
        return emptyBox({
          title: t('chat.empty.noWorkspaceTitle'),
          body: t('chat.empty.noWorkspaceBody'),
          actions: [
            { id: 'join', label: t('chat.workspace.join'), run: () => H.joinWorkspace() },
            { id: 'make', label: t('chat.workspace.make'), primary: true, run: () => H.makeWorkspace() }
          ]
        });
      case 'pick':
      default:
        return emptyBox({
          icon: 'hash',
          title: t('chat.empty.pickTitle'),
          body: t('chat.empty.pickBody'),
          actions: H.browse && (!H.canBrowse || H.canBrowse()) ? [{ id: 'browse', label: t('chat.sidebar.browse'), run: () => H.browse() }] : []
        });
    }
  }

  // A channel the person isn't in, opened from Browse (contract 5.5): its header, a note in place of the log, and the
  // bar with Join where the composer goes. Its history needs a membership, so none shows. Drawn again only when the
  // channel's row or the language changed.
  function preview(channel, { join }) {
    const name = channel.name || '';
    const key = `preview|${channel.id}|${name}|${channel.members}|${channel.visibility}|${getLocale()}`;
    if (mode === 'preview' && stateKey === key) return;
    dropRoom();
    token++;
    mode = 'preview';
    stateKey = key;
    main.classList.add('is-preview');
    head.hidden = false;
    area.hidden = true;
    banner.hidden = true;
    jumpUp.hidden = jumpDown.hidden = true;
    empty.hidden = false;
    compose.hidden = false;
    const ic = h('span', { class: 'ch-head-ic', 'aria-hidden': 'true' }, svg(channel.visibility === 'private' ? 'lock' : 'hash'));
    const meta = [t('chat.head.members', { count: channel.members || 0 }), channel.visibility === 'private' ? t('chat.head.private') : ''].filter(Boolean).join(' · ');
    head.append(h('div', { class: 'ch-titles' }, h('div', { class: 'ch-title-row' }, ic, h('h1', { class: 'ch-title sel', title: name, text: name })), h('div', { class: 'ch-meta', text: meta })));
    emptyBox({ icon: 'hash', title: t('chat.log.startChannel', { name }), body: t('chat.channel.previewBody', { name }) });
    input = mountChatInput(compose, { placeholder: '', members: () => Promise.resolve([]), recent: () => [], onSend: () => Promise.resolve(true), onEscape: () => false });
    input.setBar({ icon: 'hash', text: t('chat.input.notJoined', { name }), actions: [{ id: 'join', label: t('chat.input.join', { name }), primary: true, run: () => join() }] });
  }

  // The open conversation went (desktop-ui 7.10): its rows leave the screen at once. Called again while it shows, it
  // draws only when the text changed (a language change); focus: the OK button takes the focus, only when it first shows.
  function goneConversation(name, { focus = true } = {}) {
    const label = name || (V.room ? H.roomName(V.room) : '');
    const key = `goneRoom|${label}|${getLocale()}`;
    if (mode === 'state' && stateKey === key) return;
    dropRoom();
    token++;
    mode = 'state';
    stateKey = key;
    showRoom(false);
    emptyBox({
      icon: 'leave',
      title: label ? t('chat.gone.conversationTitle', { name: label }) : t('chat.errors.goneConversation'),
      body: t('chat.gone.conversationBody'),
      actions: [{ id: 'gone-ok', label: t('common.actions.ok'), primary: true, run: () => H.goneOk() }]
    });
    if (focus) empty.querySelector('button')?.focus();
  }

  // The workspace went (desktop-ui 7.11).
  function goneWorkspace(name) {
    if (mode === 'state' && stateKey === `gone|${name}|${getLocale()}`) return;
    dropRoom();
    token++;
    mode = 'state';
    stateKey = `gone|${name}|${getLocale()}`;
    showRoom(false);
    emptyBox({
      icon: 'leave',
      title: t('chat.gone.workspaceTitle', { workspace: name }),
      body: t('chat.gone.workspaceBody'),
      actions: [{ id: 'gone-ok', label: t('common.actions.ok'), primary: true, run: () => H.goneWorkspaceOk() }]
    });
  }

  // { icon, text, action: { label, run } } or null. Shown without motion, its height only while it shows.
  function setBanner(b) {
    const key = b ? `${b.icon}|${b.text}|${b.action ? b.action.label : ''}` : null;
    if (key === bannerKey) return;
    bannerKey = key;
    banner.textContent = '';
    banner.hidden = !b || mode !== 'room';
    if (!b) return;
    banner.append(svg(b.icon || 'info'), h('span', { class: 'ch-banner-text', text: b.text }));
    if (b.action) banner.append(h('button', { type: 'button', class: 'link-btn', 'data-ch-banner': '', text: b.action.label, onClick: () => b.action.run() }));
  }

  // ChatState changed (the connection, a workspace's status): the bars that depend on it, and unsent rows that wait
  // for a connection.
  function stateChanged() {
    if (mode !== 'room') return;
    updateBars();
    const connection = H.state()?.connection || null;
    if (connection === drawnConnection) return;
    drawnConnection = connection;
    if (!V.pending.length) return;
    if (V.loaded) render({ position: 'keep' });
    if (T) renderThread({ position: 'keep' });
  }

  // ---------- the header ----------

  function renderHead() {
    head.textContent = '';
    const room = V.room;
    if (!room) return;
    const name = H.roomName(room);
    const dm = room.kind === 'dm';
    const ic = h('span', { class: 'ch-head-ic', 'aria-hidden': 'true' });
    if (dm) {
      const others = (room.participants || []).filter((id) => id !== H.me());
      const first = others[0] || H.me();
      ic.append(avatarEl(first, nameOf(first), { cls: 'ch-av-24', deleted: members().get(first)?.state === 'deleted' }));
    } else ic.append(svg(room.archived ? 'archive' : room.visibility === 'private' ? 'lock' : 'hash'));
    const titleRow = h('div', { class: 'ch-title-row' }, ic, h('h1', { class: 'ch-title sel', title: name, text: name }));
    if (room.muted) titleRow.append(h('span', { class: 'ch-head-muted', role: 'img', 'aria-label': t('chat.sidebar.rowMuted', { name }), title: t('chat.sidebar.rowMuted', { name }) }, svg('mute')));
    const meta = dm
      ? t('chat.head.direct', { host: H.state()?.host || '' })
      : [t('chat.head.members', { count: room.members || 0 }), room.visibility === 'private' ? t('chat.head.private') : ''].filter(Boolean).join(' · ');
    const titles = h('div', { class: 'ch-titles' }, titleRow, h('div', { class: 'ch-meta', text: meta }));
    const actions = h('div', { class: 'ch-actions' });
    const group = dm && (room.participants || []).length > 2;
    if (!dm || group) {
      actions.append(
        h(
          'button',
          {
            type: 'button',
            class: 'tbtn ch-members-btn',
            'data-ch': 'members',
            title: t('chat.head.membersButton'),
            'aria-label': `${t('chat.head.membersButton')}, ${t('chat.head.members', { count: room.members || 0 })}`
          },
          svg('people'),
          h('span', { class: 'ch-members-n', text: String(room.members || 0) })
        )
      );
    }
    actions.append(h('button', { type: 'button', class: 'icon-btn sm', 'data-ch': 'more', 'aria-haspopup': 'menu', 'aria-label': t('chat.head.more'), title: t('chat.head.more') }, svg('more')));
    head.append(titles, actions);
    log.setAttribute('aria-label', t('chat.log.label', { name }));
  }

  // The header's More menu (contract 5.4): Add people, Members and Rename from chat.js, then Mark as read and Mute,
  // then Leave, Block and Archive from chat.js.
  function moreMenu(anchor) {
    const room = V.room;
    if (!room) return;
    const name = H.roomName(room);
    const extra = H.roomItems ? H.roomItems(room) : { top: [], bottom: [] };
    const items = [...extra.top, { separator: true }];
    if ((room.unread || 0) > 0 || (room.mentions || 0) > 0) items.push({ icon: 'check', label: t('chat.head.markRead'), shortcut: 'Shift+Esc', action: () => markRead() });
    items.push(
      room.muted
        ? { icon: 'bell', label: t('chat.head.unmute'), action: () => mute(false, name) }
        : { icon: 'mute', label: t('chat.head.mute'), action: () => mute(true, name) }
    );
    if (extra.bottom.length) items.push({ separator: true }, ...extra.bottom);
    showMenu(anchor, items, { align: 'right' });
  }

  function mute(on, name) {
    const ws = V.ws;
    const c = V.c;
    api('chatMute', ws, c, on)
      .then(() => toast(t(on ? 'chat.mute.done' : 'chat.mute.undone', { name })))
      .catch((err) => H.goneError(err, ws, c) || toast(H.errorText(err), 5000));
  }

  // ---------- the composer and its bars (contract 5.5) ----------

  const placeholderFor = (room) =>
    room && room.kind === 'dm' ? t('chat.input.placeholderDirect', { name: H.roomName(room) }) : t('chat.input.placeholderChannel', { name: (room && room.name) || '' });

  // Who a mention can name: the conversation's members (a channel's from the server, once per opened room; a DM's
  // participants), active and without you, with their names from the workspace directory. Offline the directory
  // stands in, and the next @ asks again.
  function mentionCandidates() {
    const key = `${V.ws}|${V.c}`;
    if (!memberCache || memberCache.key !== key) {
      const ws = V.ws;
      const c = V.c;
      const entry = { key, promise: null };
      entry.promise = api('chatRoomMembers', ws, c).then(
        (r) => ((r && r.members) || []).map((m) => m.member),
        () => {
          if (memberCache === entry) memberCache = null;
          return null;
        }
      );
      memberCache = entry;
    }
    return memberCache.promise.then((ids) => {
      const dir = members();
      const me = H.me();
      const list = ids ? ids.map((id) => dir.get(id)).filter(Boolean) : [...dir.values()];
      return list.filter((m) => m.id !== me && (!m.state || m.state === 'active'));
    });
  }

  // Who posted among the last messages, the latest first: they come first among equal matches in the picker.
  function recentAuthors() {
    const out = [];
    const me = H.me();
    const msgs = V.events.filter((e) => e.kind === 'message.posted');
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - RECENT_MESSAGES); i--) {
      const a = msgs[i].actor;
      if (a !== me && !out.includes(a)) out.push(a);
    }
    return out;
  }

  // The bar in place of the composer, or null (contract 5.5): the workspace stopped, an archived channel, a closed DM.
  // main: the room's own composer, which carries the closed DM's actions.
  function barFor(room, { main = true } = {}) {
    if (!room) return null;
    if (H.workspaceStatus && H.workspaceStatus() === 'quarantined') return { icon: 'warning', text: t('chat.input.paused', { workspace: H.workspaceName() }) };
    if (room.kind === 'channel' && room.archived) return { icon: 'archive', text: t('chat.input.archived', { name: room.name || '' }) };
    if (room.kind === 'dm' && room.closedReason) {
      const key = room.closedReason === 'left' ? 'closedLeft' : room.closedReason === 'ineligible' ? 'closedIneligible' : 'closedBlocked';
      const actions = [];
      if (main) {
        const others = (room.participants || []).filter((id) => id !== H.me());
        if (H.full && H.full() && others.length) actions.push({ id: 'new-conversation', label: t('chat.input.newConversation'), run: () => H.startDm(others) });
        actions.push({ id: 'remove-from-list', label: t('chat.input.removeFromList'), run: () => H.leaveDm(room) });
      }
      return { icon: 'lock', text: t(`chat.input.${key}`), actions };
    }
    return null;
  }

  function updateBars() {
    if (input && V.room) input.setBar(barFor(V.room));
    if (T && T.input) T.input.setBar(threadBar());
  }

  function mountComposer() {
    if (input) input.dispose();
    compose.textContent = '';
    const ws = V.ws;
    const c = V.c;
    input = mountChatInput(compose, {
      placeholder: placeholderFor(V.room),
      members: () => mentionCandidates(),
      recent: () => recentAuthors(),
      onSend: (wire) => sendMessage(wire, null),
      // Escape in the composer: the log (desktop-ui 5.5).
      onEscape: () => {
        focusLog();
        return true;
      },
      onDraft: (draft) => api('chatSaveDraft', ws, c, null, draft).catch(() => {})
    });
    updateBars();
  }

  // chatSend (contract 3.8): main writes the message to disk and answers with its pending row; the queue sends it. A
  // refusal puts the text back in the composer (chat-input.js) and says why, unless the room or the workspace is gone.
  function sendMessage(wire, root) {
    const ws = V.ws;
    const c = V.c;
    return api('chatSend', ws, c, { text: wire.text, mentions: wire.mentions, root }).then(
      (res) => {
        const p = res && res.pending;
        if (!p || V.ws !== ws || V.c !== c || V.pending.some((x) => x.local === p.local)) return true;
        V.pending = [...V.pending, p];
        if (V.loaded) render({ position: root ? 'keep' : 'bottom' });
        if (T && root === T.root) renderThread({ position: 'bottom' });
        return true;
      },
      (err) => {
        if (H.goneError(err, ws, c)) return true;
        toast(H.errorText(err), 5000);
        throw err;
      }
    );
  }

  function focusLog() {
    const li = log.querySelector('li.ch-msg[tabindex="0"]') || [...log.querySelectorAll('li.ch-msg')].pop();
    if (li) {
      li.focus({ preventScroll: true });
      li.scrollIntoView({ block: 'nearest' });
    } else scroll.focus({ preventScroll: true });
  }

  // ---------- opening a room ----------

  // Opens c of ws (contract 5.4): chatOpen answers from the cache at once and the rest comes as events pushes. at: a
  // notification's message, which the log scrolls to and outlines.
  async function open(ws, c, { at = null } = {}) {
    const my = ++token;
    const keepScroll = V.c === c && V.ws === ws && mode === 'room' && at == null ? scroll.scrollTop : null;
    dropRoom();
    mode = 'room';
    stateKey = null;
    V.ws = ws;
    V.c = c;
    V.room = H.room(c);
    V.opening = true;
    drawnConnection = H.state()?.connection || null;
    showRoom(true);
    renderHead();
    renderOlder();
    mountComposer();
    let rv;
    try {
      rv = await api('chatOpen', ws, c, at != null ? { at } : {});
    } catch (err) {
      if (my !== token) return;
      V.opening = false;
      // A 404 for the room or the workspace shows its gone state (desktop-ui 7.10, 7.11), not an error with Retry.
      if (H.goneError(err, ws, c)) return;
      V.openError = err;
      renderOlder();
      return;
    }
    if (my !== token) return;
    V.opening = false;
    V.room = rv.room;
    H.roomOpened(rv.room);
    V.events = (rv.events || []).slice().sort(bySeq);
    V.lo = rv.lo;
    V.hi = rv.hi;
    V.floor = rv.room.floor || 1;
    V.hasOlder = Boolean(rv.hasOlder);
    V.readAtOpen = rv.readAtOpen;
    V.readBest = V.readSent = rv.room.read || 0;
    V.at = rv.at;
    V.complete = rv.complete !== false;
    V.pending = rv.pending || [];
    // An uncached room answers with nothing yet; the newest page follows as an events push.
    V.loaded = V.events.length > 0 || rv.hi !== null;
    renderHead();
    if (input) {
      input.setPlaceholder(placeholderFor(V.room));
      if (rv.draft && !input.parts().length) input.setParts(toParts(rv.draft.text, rv.draft.mentions));
    }
    updateBars();
    if (!V.loaded) return renderOlder();
    render({ position: at != null ? 'at' : keepScroll !== null ? 'restore' : 'open', restore: keepScroll });
  }

  // ---------- events for the open room (contract 4.5, 5.4) ----------

  function merge(events) {
    const map = new Map(V.events.map((e) => [e.seq, e]));
    for (const e of events) if (e && Number.isSafeInteger(e.seq)) map.set(e.seq, e);
    V.events = [...map.values()].sort(bySeq);
  }

  const inThread = (e) => Boolean(T) && e && e.kind === 'message.posted' && (e.id === T.root || e.root === T.root);
  const threadReplies = () => (T ? [...T.ev.values()].filter((e) => e.kind === 'message.posted' && e.root === T.root).length : 0);
  const threadAtEnd = () => tScroll.scrollHeight - tScroll.scrollTop - tScroll.clientHeight < STICK_PX;

  function onEvent(p) {
    if (mode !== 'room' || p.ws !== V.ws || p.conversation !== V.c) return;
    if (p.kind === 'events') {
      const wasLoaded = V.loaded;
      const stick = !wasLoaded || atBottom();
      const hiBefore = V.hi || 0;
      const list = Array.isArray(p.events) ? p.events : [];
      if (p.replace) {
        V.events = list.slice().sort(bySeq);
        V.hasOlder = p.lo !== null && p.lo > (p.floor || 1);
        // The range is new: older history may load again (a page main dropped for a moved grant waited for this).
        if (V.older === 'failed') V.older = 'idle';
      } else merge(list);
      V.lo = V.events.length ? V.events[0].seq : p.lo;
      V.hi = p.hi;
      V.floor = p.floor || 1;
      V.room = { ...V.room, head: p.head, floor: p.floor };
      V.loaded = true;
      V.opening = false;
      const arrivals = wasLoaded && !p.replace ? list.filter((e) => e.kind === 'message.posted' && e.seq > hiBefore) : [];
      render({ position: !wasLoaded || p.replace ? 'open' : stick ? 'bottom' : 'keep', arrivals });
      if (T) {
        const mine = list.filter(inThread);
        if (p.replace) {
          // The cache was emptied (a 410, a restore, a new key or Start over), and what the thread showed may hold text
          // removed since: it keeps only what the replace carries and loads again from the cache or the server.
          T.ev = new Map(mine.map((e) => [e.seq, e]));
          renderThread({ position: 'keep' });
          loadThread();
        } else if (mine.length) {
          const end = threadAtEnd();
          for (const e of mine) T.ev.set(e.seq, e);
          renderThread({ position: end ? 'bottom' : 'keep' });
        }
      }
      return;
    }
    if (p.kind === 'redacted') {
      const ids = new Set(Array.isArray(p.ids) ? p.ids : []);
      const gone = (e) => ({ ...e, text: null, mentions: [], redacted: true });
      let changed = false;
      V.events = V.events.map((e) => {
        if (!ids.has(e.id) || e.redacted) return e;
        changed = true;
        return gone(e);
      });
      if (changed) render({ position: 'keep' });
      if (T) {
        let mine = false;
        for (const [seq, e] of T.ev) {
          if (!ids.has(e.id) || e.redacted) continue;
          T.ev.set(seq, gone(e));
          mine = true;
        }
        // A root that went without replies leaves nothing to read: the thread closes (contract 5.4).
        if (ids.has(T.root) && !threadReplies() && !V.pending.some((x) => x.root === T.root)) closeThread();
        else if (mine) renderThread({ position: 'keep' });
      }
      return;
    }
    if (p.kind === 'pending') {
      const known = new Set(V.pending.map((x) => x.local));
      V.pending = Array.isArray(p.pending) ? p.pending : [];
      const added = V.pending.filter((x) => !known.has(x.local));
      // Sending your own message always goes to the end (desktop-ui 5.3), in the log or the thread it went to.
      if (V.loaded) render({ position: added.some((x) => !x.root) ? 'bottom' : 'keep' });
      if (T) renderThread({ position: added.some((x) => x.root === T.root) ? 'bottom' : 'keep' });
      return;
    }
    if (p.kind === 'sent') {
      // The pending row becomes the sent message in place (contract 5.4): it keeps its key, and the message is in the
      // log at once, from what was sent, until the history brings the server's copy.
      if (p.messageId && p.local) {
        V.sentLocal.set(p.messageId, p.local);
        const item = V.pending.find((x) => x.local === p.local);
        if (item && Number.isSafeInteger(p.seq) && !V.events.some((e) => e.seq === p.seq || e.id === p.messageId)) {
          const ev = { seq: p.seq, id: p.messageId, kind: 'message.posted', actor: H.me(), at: Date.now(), root: item.root || null, text: item.text, mentions: item.mentions || [], redacted: false, data: {} };
          merge([ev]);
          if (inThread(ev)) T.ev.set(ev.seq, ev);
        }
      }
      if (V.loaded) render({ position: atBottom() ? 'bottom' : 'keep' });
      if (T) renderThread({ position: threadAtEnd() ? 'bottom' : 'keep' });
    }
  }

  // The room's row changed (badges, members, mute, archived, closed) or the directory did (names): the header, the
  // bars, and the log when names may have changed.
  function roomChanged(room, { directory = false } = {}) {
    if (mode !== 'room' || !room || room.id !== V.c) return;
    V.room = { ...V.room, ...room };
    renderHead();
    if (directory) memberCache = null;
    if (input) input.setPlaceholder(placeholderFor(V.room));
    updateBars();
    if (T) renderThreadHead();
    if (directory && V.loaded) {
      render({ position: 'keep' });
      if (T) renderThread({ position: 'keep' });
    } else updateJumps();
  }

  // ---------- the log ----------

  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICK_PX;

  function introOf() {
    const first = V.events.find((e) => e.kind === 'channel.created' || e.kind === 'dm.started');
    return first ? { actor: first.actor, at: first.at } : null;
  }

  // How an unsent row looks: 'sending', 'waiting' (for a connection), 'turn' (for the message above), 'stale'
  // (held/stale_grant), 'unknown' (held/unknown) or 'failed' (contract 5.5). A queued message that hasn't failed yet
  // shows as sending while there is a connection.
  function lookOf(row) {
    switch (row.pending) {
      case 'queued': {
        if (row.reason === 'lookup') return 'sending';
        const connection = H.state()?.connection;
        return (row.nextAt || 0) > 0 || (connection && connection !== 'online') ? 'waiting' : 'sending';
      }
      case 'waiting':
        return 'turn';
      case 'held':
        return row.reason === 'unknown' ? 'unknown' : 'stale';
      case 'failed':
        return 'failed';
      default:
        return 'sending';
    }
  }
  // The look is part of a pending row's sig: the connection changes it without a pending event.
  function withLooks(rows) {
    for (const r of rows) if (r.pending) r.sig += `\u0001${lookOf(r)}`;
    return rows;
  }

  // render: the rows from timeline() put in place. position: 'open' (the New divider a third down, else the end),
  // 'at' (the notification's message), 'bottom', 'anchor' (older rows came in above), 'restore' or 'keep'. arrivals:
  // events that came in live, which fade in and may be announced.
  function render({ position = 'keep', arrivals = [], restore = null } = {}) {
    if (mode !== 'room' || !V.loaded) return;
    const heightBefore = scroll.scrollHeight;
    const topBefore = scroll.scrollTop;
    const rows = withLooks(
      timeline(V.events, {
        me: H.me(),
        members: members(),
        readAtOpen: V.readAtOpen,
        pending: V.pending,
        floor: V.floor,
        hasOlder: V.hasOlder,
        blocked: H.blocks(),
        intro: introOf(),
        now: Date.now(),
        sentLocal: V.sentLocal
      })
    );
    V.rows = new Map(rows.map((r) => [r.key, r]));
    const fresh = new Set(arrivals.map((e) => e.id));
    V.nodes = reconcile(log, V.nodes, rows, { observe: true, fresh, focusKey: V.focusKey, thread: false });
    // Visible rows that went no longer count.
    for (const seq of [...V.visible]) if (!log.querySelector(`li[data-seq="${seq}"]`)) V.visible.delete(seq);
    renderOlder();
    if (position === 'open') positionOpen();
    else if (position === 'at') positionAt();
    else if (position === 'bottom') toBottom(false);
    else if (position === 'anchor') scroll.scrollTop = topBefore + (scroll.scrollHeight - heightBefore);
    else if (position === 'restore' && restore !== null) scroll.scrollTop = restore;
    if (arrivals.length) {
      const others = arrivals.filter((e) => e.actor !== H.me());
      if (position === 'keep' && others.length) V.unseen += others.length;
      announceArrivals(others);
    }
    updateJumps();
    considerRead();
    maybeOlder();
  }

  // Puts rows into list, reusing the nodes of old whose sig didn't change. Returns the new map of nodes by key.
  // observe: the rows report reads (the main log only). The keyboard stays on the row it was on.
  function reconcile(list, old, rows, { observe = false, fresh = new Set(), focusKey = null, thread: threaded = false } = {}) {
    const active = document.activeElement;
    const focused = active && list.contains(active) ? active.closest('li')?.dataset.key : null;
    const next = new Map();
    for (const row of rows) {
      let li = old.get(row.key);
      if (!li || li.dataset.sig !== row.sig) {
        li = build(row, { thread: threaded });
        li.dataset.key = row.key;
        li.dataset.sig = row.sig;
        if (fresh.has(row.id) && !reduced()) li.classList.add('is-arriving');
        if (observe && li.dataset.seq) io.observe(li);
      }
      next.set(row.key, li);
    }
    let cursor = list.firstChild;
    for (const li of next.values()) {
      if (li === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(li, cursor);
    }
    for (const [key, li] of old) {
      if (next.get(key) === li) continue;
      if (observe) io.unobserve(li);
      li.remove();
    }
    // One message row takes Tab (desktop-ui 9.2): the focused one, else the last.
    const msgs = [...list.querySelectorAll('li.ch-msg')];
    const keep = (focused && next.get(focused)) || (focusKey && next.get(focusKey)) || msgs[msgs.length - 1] || null;
    for (const li of msgs) li.tabIndex = li === keep ? 0 : -1;
    const now = focused && next.get(focused);
    if (now && !now.contains(document.activeElement)) now.focus({ preventScroll: true });
    return next;
  }

  function build(row, ctx) {
    switch (row.type) {
      case 'day': {
        const label = groupLabel(row.at);
        return h('li', { class: 'ch-day', role: 'separator', 'aria-label': label }, h('span', { text: label }));
      }
      case 'new':
        return h('li', { class: 'ch-new', role: 'separator', 'aria-label': t('chat.log.newLabel') }, h('span', { text: t('chat.log.new') }));
      case 'floor': {
        // Older messages aged out. The server always says how long it keeps them; without that the row stays empty.
        const days = H.state()?.retention?.contentDays;
        return h('li', { class: 'ch-floor' }, days ? h('span', { text: t('chat.log.retentionFloor', { count: days }) }) : null);
      }
      case 'tdiv': {
        const label = t('chat.log.replies', { count: row.count });
        return h('li', { class: 'ch-day ch-thread-div', role: 'separator', 'aria-label': label }, h('span', { text: label }));
      }
      case 'intro':
        return buildIntro(row);
      case 'sys':
        return buildSys(row);
      default:
        return buildMessage(row, ctx);
    }
  }

  function buildIntro(row) {
    const room = V.room || {};
    const li = h('li', { class: 'ch-intro' });
    const name = H.roomName(room);
    const ic = h('span', { class: 'ch-intro-ic', 'aria-hidden': 'true' });
    if (room.kind === 'dm') {
      const others = (room.participants || []).filter((id) => id !== H.me()).slice(0, 3);
      for (const id of others.length ? others : [H.me()]) ic.append(avatarEl(id, nameOf(id), { cls: 'ch-av-40', deleted: members().get(id)?.state === 'deleted' }));
      li.append(ic, h('h2', { class: 'ch-intro-title', text: t('chat.log.startDirect', { names: name }) }));
      li.append(h('p', { class: 'ch-intro-line', text: t('chat.log.hostNote', { host: H.state()?.host || '' }) }));
      return li;
    }
    ic.append(svg(room.visibility === 'private' ? 'lock' : 'hash'));
    li.append(ic, h('h2', { class: 'ch-intro-title', text: t('chat.log.startChannel', { name }) }));
    const intro = row.intro;
    const lines = [];
    if (intro) lines.push(t('chat.log.startChannelBy', { name: nameOf(intro.actor), date: dayOf(intro.at) }));
    lines.push(room.visibility === 'private' ? t('chat.log.startPrivate') : t('chat.log.startPublic', { workspace: H.workspaceName() }));
    li.append(h('p', { class: 'ch-intro-line', text: lines.join(' ') }));
    return li;
  }

  const SYS_ICONS = { created: 'hash', renamed: 'edit', archived: 'archive', joined: 'person', added: 'person', left: 'leave', removedBy: 'leave', dmStarted: 'chat' };

  function sysText(row) {
    const actor = nameOf(row.actor);
    const member = row.member ? nameOf(row.member) : actor;
    switch (row.sys) {
      case 'created':
        return t('chat.sys.created', { actor, name: row.name || '' });
      case 'renamed':
        return t('chat.sys.renamed', { actor, name: row.name || '' });
      case 'archived':
        return t('chat.sys.archived', { actor });
      case 'joined':
        return t('chat.sys.joined', { name: member });
      case 'added':
        return t('chat.sys.added', { actor, name: member });
      case 'left':
        return t('chat.sys.left', { name: member });
      case 'removedBy':
        return t('chat.sys.removedBy', { actor, name: member });
      default:
        return t('chat.sys.dmStarted', { actor });
    }
  }

  function buildSys(row) {
    const li = h('li', { class: 'ch-sys', 'data-id': row.id });
    li.append(h('span', { class: 'ch-sys-ic', 'aria-hidden': 'true' }, svg(SYS_ICONS[row.sys] || 'info')));
    li.append(h('span', { class: 'ch-sys-text', text: sysText(row) }), timeEl(row.at, 'ch-time'));
    return li;
  }

  // A reply's context line opens its thread (contract 3.13).
  function contextLine(c) {
    let text;
    if (c.state === 'ok') text = t('chat.log.replyTo', { name: displayName(c.author, t), text: c.text });
    else if (c.state === 'removed') text = t('chat.log.replyToRemoved');
    else text = t('chat.log.replyInThread');
    return h('button', { type: 'button', class: 'ch-context', 'data-ch': 'thread', 'data-root': c.root, title: text, tabindex: '-1' }, svg('reply'), h('span', { text }));
  }

  function textEl(row) {
    const div = h('div', { class: 'ch-text sel' });
    for (const seg of segments(row.text, row.mentions, { me: H.me(), blocked: row.blocked })) {
      if (seg.href) div.append(h('a', { class: 'ch-link', href: seg.href, target: '_blank', rel: 'noopener noreferrer', text: seg.text }));
      else if (seg.mention) div.append(h('span', { class: seg.me ? 'ch-mention is-me' : 'ch-mention', title: nameOf(seg.mention), text: seg.text }));
      else div.append(document.createTextNode(seg.text));
    }
    return div;
  }

  function repliesEl(row) {
    const r = row.replies;
    const count = t(r.hasNew ? 'chat.log.repliesUnread' : 'chat.log.replies', { count: r.count });
    const last = Number.isFinite(r.lastAt) ? t('chat.log.lastReply', { time: listTime(r.lastAt) }) : '';
    const btn = h('button', { type: 'button', class: `ch-replies${r.hasNew ? ' has-new' : ''}`, 'data-ch': 'thread', 'data-root': row.id, tabindex: '-1', 'aria-label': [count, last].filter(Boolean).join(', ') });
    const avs = h('span', { class: 'ch-replies-av', 'aria-hidden': 'true' });
    for (const id of r.actors) avs.append(avatarEl(id, nameOf(id), { cls: 'ch-av-16', deleted: members().get(id)?.state === 'deleted' }));
    btn.append(avs);
    if (r.hasNew) btn.append(h('i', { class: 'ch-replies-dot', 'aria-hidden': 'true' }));
    btn.append(h('span', { class: 'ch-replies-n', text: t('chat.log.replies', { count: r.count }) }));
    if (last) btn.append(h('span', { class: 'ch-replies-at', text: last }));
    return btn;
  }

  // Why a send failed, for chat.msg.failed (contract 3.8 "Answers").
  function reasonText(reason) {
    switch (reason) {
      case 'conflict':
        return t('chat.errors.operationConflict');
      case 'archived':
        return V.room && V.room.kind === 'dm' ? t('chat.input.closedBlocked') : t('chat.errors.archived');
      case 'quota':
        return H.errorText({ code: 'quota' });
      case 'mentions':
        return t('chat.errors.mentions');
      case 'no_access':
        return t('chat.errors.goneConversation');
      default:
        return t('chat.errors.invalid');
    }
  }

  // The line under an unsent message (contract 5.5): what happens to it, and what the person can do.
  function stateLine(row) {
    const look = lookOf(row);
    const line = h('div', { class: `ch-state is-${look}` });
    const say = (text) => h('span', { class: 'ch-state-text', text });
    const act = (id, label) => h('button', { type: 'button', class: 'link-btn', 'data-ch-act': id, 'data-local': row.local, text: label });
    switch (look) {
      case 'waiting': {
        const later = (row.nextAt || 0) > Date.now() ? ` · ${t('chat.msg.retryAt', { time: clockTime(row.nextAt) })}` : '';
        line.append(svg('clock'), say(`${t('chat.msg.waiting')}${later}`));
        break;
      }
      case 'turn':
        line.append(svg('clock'), say(t('chat.msg.waitingTurn')));
        break;
      case 'stale':
        line.append(svg('warning'), say(t('chat.msg.staleGrant')), act('send', t('chat.msg.send')), act('discard', t('chat.msg.discard')));
        break;
      case 'unknown':
        line.append(svg('warning'), say(t('chat.msg.unknown')), act('send-again', t('chat.msg.sendAgain')), act('discard', t('chat.msg.discard')));
        break;
      case 'failed': {
        line.append(svg('warning'), say(t('chat.msg.failed', { reason: reasonText(row.reason) })));
        if (row.reason === 'quota') line.append(act('retry', t('chat.msg.retry')));
        if (row.reason === 'mentions') line.append(act('without-mentions', t('chat.msg.sendWithoutMentions')));
        if (row.reason === 'conflict' || row.reason === 'archived') line.append(act('copy', t('chat.msg.copy')));
        line.append(act('discard', t('chat.msg.discard')));
        break;
      }
      default:
        // Shown after a second, so a quick send doesn't flicker (styles.css .ch-state.is-sending).
        line.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), say(t('chat.msg.sending')));
    }
    return line;
  }

  // The menu of a message (desktop-ui 5.3, contract 5.5): Reply in thread, Copy text, Block {author} once U5 gives
  // blocks a dialog, and Remove message when the person may remove it. Unsent rows have none.
  function menuItems(row, threaded) {
    if (row.pending || !row.id) return [];
    const items = [];
    const root = row.root || row.id;
    if (!threaded && (!row.removed || (row.replies && row.replies.count))) items.push({ icon: 'thread', label: t('chat.msg.reply'), action: () => openThread(root) });
    if (!row.removed && row.text) items.push({ icon: 'copy', label: t('chat.msg.copy'), action: () => copyText(row.text) });
    const author = members().get(row.actor);
    if (H.canBlock && H.canBlock() && row.actor !== H.me() && author && author.state === 'active' && author.role !== 'guest' && !H.blocks().has(row.actor)) {
      items.push({ separator: true }, { icon: 'ban', label: t('chat.head.block', { name: nameOf(row.actor) }), action: () => H.block(row.actor) });
    }
    if (canRemove(row, H.me(), V.room)) items.push({ separator: true }, { icon: 'trash', label: t('chat.msg.remove'), danger: true, action: () => removeMessage(row) });
    return items;
  }

  // The tools over a message on hover and focus. They take no Tab stop of their own: the row does, and Shift+F10
  // opens the same actions as a menu.
  function toolsEl(row, threaded) {
    const items = menuItems(row, threaded);
    if (!items.length) return null;
    const tool = (id, icon, label) => h('button', { type: 'button', class: 'icon-btn sm', 'data-ch-tool': id, tabindex: '-1', 'aria-label': label, title: label }, svg(icon));
    const bar = h('div', { class: 'ch-tools', role: 'toolbar', 'aria-label': t('chat.msg.actions') });
    if (!threaded && (!row.removed || (row.replies && row.replies.count))) bar.append(tool('reply', 'thread', t('chat.msg.reply')));
    if (!row.removed && row.text) bar.append(tool('copy', 'copy', t('chat.msg.copy')));
    // More always, so a narrow view that keeps only it still reaches every action.
    bar.append(tool('menu', 'more', t('chat.msg.more')));
    return bar;
  }

  function buildMessage(row, ctx = {}) {
    const threaded = Boolean(ctx.thread);
    const author = row.author;
    const deleted = Boolean(author && author.state === 'deleted');
    const name = displayName(author, t);
    const cls = [
      'ch-msg',
      row.type === 'reply' && 'is-reply',
      row.head ? 'is-head' : 'is-cont',
      row.removed && 'is-removed',
      row.mentionsMe && 'mentions-me',
      row.pending && 'is-pending',
      (row.pending === 'held' || row.pending === 'failed') && 'is-failed'
    ]
      .filter(Boolean)
      .join(' ');
    const li = h('li', { class: cls, tabindex: '-1' });
    if (row.seq != null) li.dataset.seq = String(row.seq);
    if (row.id) li.dataset.id = row.id;
    if (row.local) li.dataset.local = row.local;
    if (row.root) li.dataset.root = row.root;
    if (row.pending) li.dataset.state = row.pending;
    if (row.type === 'reply' && row.head && row.context) li.append(contextLine(row.context));
    if (row.head) li.append(avatarEl(row.actor, name, { deleted }));
    else li.append(timeEl(row.at, 'ch-time is-gutter'));
    const body = h('div', { class: 'ch-body' });
    if (row.head) {
      const line = h('div', { class: 'ch-line' }, h('span', { class: 'ch-name', text: name }));
      const tag = memberTag(author, t);
      if (tag) line.append(h('span', { class: 'ch-tag', text: tag }));
      line.append(timeEl(row.at));
      body.append(line);
    } else body.append(h('span', { class: 'ch-vh', text: t('chat.msg.sender', { name, time: hhmm(row.at) }) }));
    if (row.removed) body.append(h('div', { class: 'ch-removed' }, svg('trash'), h('span', { text: t('chat.log.removed') })));
    else body.append(textEl(row));
    if (!threaded && row.replies && row.replies.count) body.append(repliesEl(row));
    if (row.pending) body.append(stateLine(row));
    if (row.mentionsMe) li.setAttribute('aria-description', t('chat.msg.mentionsYou'));
    li.append(body);
    const tools = toolsEl(row, threaded);
    if (tools) li.append(tools);
    return li;
  }

  // ---------- message actions ----------

  // Remove (desktop-ui 6.14, contract 3.14): asked first; the row changes when main's redacted event comes back.
  async function removeMessage(row) {
    const room = V.room;
    const own = row.actor === H.me();
    const ok = await confirmDialog(
      t('chat.remove.title'),
      t(own ? 'chat.remove.body' : 'chat.remove.bodyOther', { name: roomLabel(room), author: nameOf(row.actor) }),
      t('chat.remove.confirm'),
      true
    );
    if (!ok) return;
    const ws = V.ws;
    const c = V.c;
    try {
      await api('chatRedact', ws, c, row.id);
    } catch (err) {
      if (!H.goneError(err, ws, c)) toast(H.errorText(err), 5000);
    }
  }

  // An unsent message's actions (contract 3.8 "Resend modes"): Send again asks first, because the first one may have
  // arrived.
  async function pendingAction(id, local) {
    const p = V.pending.find((x) => x.local === local);
    if (!p) return;
    const ws = V.ws;
    const c = V.c;
    try {
      if (id === 'discard') {
        await api('chatDiscard', local);
        // The text was the person's own work: Undo puts it back in the composer it came from.
        toast(t('chat.msg.discarded'), { action: { label: t('common.actions.undo'), run: () => restoreDiscarded(p, ws, c) } });
      } else if (id === 'send') await api('chatResend', local, { mode: 'send' });
      else if (id === 'retry') await api('chatResend', local, { mode: 'retry' });
      else if (id === 'without-mentions') await api('chatResend', local, { mode: 'withoutMentions' });
      else if (id === 'copy') copyText(p.text);
      else if (id === 'send-again') {
        if (await confirmDialog(t('chat.msg.sendAgainTitle'), t('chat.msg.sendAgainBody'), t('chat.msg.sendAgain'))) await api('chatResend', local, { mode: 'send' });
      }
    } catch (err) {
      if (!H.goneError(err, ws, c)) toast(H.errorText(err), 5000);
    }
  }

  // Undo of Discard: the message's text and mentions back in the room's composer, or its thread's, after what is there
  // already. With the room no longer open, they become its draft.
  function restoreDiscarded(p, ws, c) {
    const parts = toParts(p.text, p.mentions);
    if (mode !== 'room' || V.ws !== ws || V.c !== c) {
      api('chatSaveDraft', ws, c, p.root || null, { text: p.text, mentions: p.mentions || [] }).catch(() => {});
      return;
    }
    if (p.root && (!T || T.root !== p.root)) openThread(p.root);
    const target = p.root ? T && T.input : input;
    if (!target) return;
    const had = target.parts();
    target.setParts(had.length ? [...had, '\n', ...parts] : parts, { dirty: true });
    target.focus();
  }

  function rowOf(li) {
    if (!li) return null;
    if (tLog.contains(li)) return T ? T.rows.get(li.dataset.key) || null : null;
    return V.rows.get(li.dataset.key) || null;
  }

  // at: { x, y } for a right click; without it the menu opens at the row (Shift+F10, the ContextMenu key).
  function messageMenu(li, at = null) {
    const row = rowOf(li);
    if (!row) return false;
    const items = menuItems(row, tLog.contains(li));
    if (!items.length) return false;
    let point = at;
    if (!point) {
      const r = li.getBoundingClientRect();
      point = { x: r.left + 48, y: Math.min(r.bottom, r.top + 24) };
    }
    showMenu(li, items, { at: point });
    return true;
  }

  // ---------- older history and positions ----------

  // The loading row, the older-history row and an open that failed, in the reserved space above the log.
  function renderOlder() {
    older.textContent = '';
    const reserve = mode === 'room' && (V.opening || !V.loaded || V.hasOlder || V.older !== 'idle' || V.openError);
    older.className = `ch-older${reserve ? ' is-reserved' : ''}${!V.loaded ? ' is-opening' : ''}`;
    if (V.openError) {
      older.append(
        h('span', { class: 'ch-older-text', text: H.errorText(V.openError) }),
        h('button', { type: 'button', class: 'btn secondary sm', text: t('common.actions.retry'), onClick: () => open(V.ws, V.c) })
      );
    } else if (!V.loaded) older.append(h('span', { class: 'spinner', role: 'status', 'aria-label': t('chat.empty.loading') }));
    else if (V.older === 'loading') older.append(h('span', { class: 'spinner', role: 'status', 'aria-label': t('chat.log.loadingOlder') }));
    else if (V.older === 'failed') {
      older.append(
        h('span', { class: 'ch-older-text', text: t('chat.log.olderFailed') }),
        h('button', {
          type: 'button',
          class: 'btn secondary sm',
          text: t('common.actions.retry'),
          onClick: () => {
            V.older = 'idle';
            loadOlder();
          }
        })
      );
    }
  }

  function maybeOlder() {
    if (mode !== 'room' || !V.loaded || !V.hasOlder || V.older !== 'idle' || V.lo == null) return;
    if (scroll.scrollTop < OLDER_PX) loadOlder();
  }

  // Older messages (contract 3.7): prepended, with the scroll position kept on what was in view.
  async function loadOlder() {
    if (V.older === 'loading' || V.lo == null) return;
    const my = token;
    V.older = 'loading';
    renderOlder();
    const ws = V.ws;
    const c = V.c;
    let res;
    try {
      res = await api('chatOlder', ws, c, V.lo);
    } catch (err) {
      if (my !== token) return;
      if (H.goneError(err, ws, c)) return;
      V.older = 'failed';
      renderOlder();
      return;
    }
    if (my !== token) return;
    // Nothing, though there is more: main dropped the page because the room's grant moved, and the room comes again as
    // a replacing events push. Asking at once would only repeat the request, so the next try waits for that push or
    // for Retry.
    if (!(res.events || []).length && res.hasOlder) {
      V.older = 'failed';
      renderOlder();
      return;
    }
    V.older = 'idle';
    merge(res.events || []);
    V.lo = V.events.length ? Math.min(V.events[0].seq, res.lo ?? Infinity) : res.lo;
    V.hasOlder = Boolean(res.hasOlder);
    render({ position: 'anchor' });
  }

  function toBottom(smooth) {
    if (smooth) scroll.scrollTo({ top: scroll.scrollHeight, behavior: behavior() });
    else scroll.scrollTop = scroll.scrollHeight;
    V.unseen = 0;
  }

  // Opening: with unread messages the New divider a third of the way down, else the end.
  function positionOpen() {
    const divider = log.querySelector('li.ch-new');
    if (divider) scroll.scrollTop = Math.max(0, divider.offsetTop - scroll.clientHeight / 3);
    else toBottom(false);
  }

  // Opening at a notification's message: in view, outlined for two seconds; a reply opens its thread too. When the open
  // didn't reach it (contract 3.7), the log goes to the event it opened at instead, unmarked and with no thread, as
  // that is another message: the end when that is the newest cached one (the requests failed), as on Android.
  function positionAt() {
    const at = V.at;
    if (!V.complete && (at === null || at === V.hi)) return toBottom(false);
    const rows = [...log.querySelectorAll('li[data-seq]')];
    const target = rows.find((li) => Number(li.dataset.seq) === at) || rows.find((li) => Number(li.dataset.seq) >= at) || rows[rows.length - 1];
    if (!target) return positionOpen();
    target.scrollIntoView({ block: 'center' });
    if (!V.complete) return;
    target.classList.add('is-target');
    clearTimeout(V.targetTimer);
    V.targetTimer = setTimeout(() => target.classList.remove('is-target'), TARGET_MS);
    if (target.dataset.root) openThread(target.dataset.root, { seq: Number(target.dataset.seq) });
  }

  function toNew() {
    const divider = log.querySelector('li.ch-new');
    if (!divider) return;
    scroll.scrollTo({ top: Math.max(0, divider.offsetTop - scroll.clientHeight / 3), behavior: behavior() });
  }

  // The pills over the log: new messages below, and unread ones above while the New divider is out of view.
  function updateJumps() {
    if (mode !== 'room' || !V.loaded) {
      jumpUp.hidden = jumpDown.hidden = true;
      return;
    }
    if (atBottom()) V.unseen = 0;
    if (V.unseen > 0) {
      const text = t('chat.log.latestCount', { count: V.unseen });
      if (jumpDown.dataset.text !== text) {
        jumpDown.textContent = '';
        jumpDown.append(svg('down'), h('span', { text }));
        jumpDown.dataset.text = text;
        jumpDown.setAttribute('aria-label', `${t('chat.log.latest')}, ${text}`);
      }
      jumpDown.hidden = false;
    } else jumpDown.hidden = true;
    const divider = log.querySelector('li.ch-new');
    const unread = V.room?.unread || 0;
    if (divider && unread > 0 && divider.offsetTop + divider.offsetHeight < scroll.scrollTop) {
      const text = t('chat.log.jumpUnread', { count: unread });
      if (jumpUp.dataset.text !== text) {
        jumpUp.textContent = '';
        jumpUp.append(svg('up'), h('span', { text }));
        jumpUp.dataset.text = text;
      }
      jumpUp.hidden = false;
    } else jumpUp.hidden = true;
  }

  // Messages that arrive while the window has focus are read out once each (desktop-ui 5.3).
  function announceArrivals(list) {
    if (!list.length || !document.hasFocus()) return;
    const e = list[list.length - 1];
    announce.textContent = t('chat.msg.announce', { name: nameOf(e.actor), text: firstChars(e.text, ANNOUNCE_CHARS) });
  }

  // ---------- the thread panel (contract 3.13, 5.6; desktop-ui 5.7) ----------

  function renderThreadHead() {
    const room = V.room;
    if (!T || !room) return;
    const name = H.roomName(room);
    tTitle.textContent = t('chat.thread.label');
    tMeta.textContent = room.kind === 'dm' ? t('chat.thread.inDirect', { names: name }) : t('chat.thread.inChannel', { name: room.name || '' });
    const back = t('chat.thread.back', { name: roomLabel(room) });
    tBack.setAttribute('aria-label', back);
    tBack.title = back;
    tClose.setAttribute('aria-label', t('chat.thread.close'));
    tClose.title = t('chat.thread.close');
    thread.setAttribute('aria-label', t('chat.thread.label'));
    tLog.setAttribute('aria-label', `${t('chat.thread.label')}, ${tMeta.textContent}`);
  }

  const threadRoot = () => (T ? [...T.ev.values()].find((e) => e.id === T.root) || null : null);

  // A root that was removed takes the thread's composer: nobody can reply to it (contract 3.13). Otherwise the
  // room's own bar, without the closed DM's actions, which sit under the log.
  function threadBar() {
    const root = threadRoot();
    if (root && (root.redacted || root.text == null)) return { icon: 'trash', text: t('chat.thread.rootRemoved') };
    return barFor(V.room, { main: false });
  }

  // The root, a divider with the reply count, then the replies and their unsent rows (contract 3.13).
  function threadRows() {
    const events = [...T.ev.values()].sort(bySeq);
    const rows = withLooks(
      timeline(events, { me: H.me(), members: members(), pending: V.pending, root: T.root, blocked: H.blocks(), now: Date.now(), sentLocal: V.sentLocal, hasOlder: true })
    );
    const count = threadReplies();
    const at = rows.findIndex((r) => r.id === T.root);
    rows.splice(at >= 0 ? at + 1 : 0, 0, { type: 'tdiv', key: 'tdiv', count, sig: `tdiv\u0001${count}\u0001${getLocale()}` });
    return rows;
  }

  // The loading row and the notes above the replies: loading, failed with Retry, partial with Load earlier, expired.
  function renderThreadNotes() {
    tOlder.textContent = '';
    tNote.textContent = '';
    const root = threadRoot();
    const busy = T.loading && !root && !threadReplies();
    tOlder.className = `ch-thread-older${busy || T.error ? ' is-reserved' : ''}`;
    if (busy) tOlder.append(h('span', { class: 'spinner', role: 'status', 'aria-label': t('chat.thread.loading') }));
    else if (T.error) {
      tOlder.append(h('span', { class: 'ch-thread-older-text', text: t('chat.thread.failed') }), h('button', { type: 'button', class: 'btn secondary sm', 'data-ch': 'thread-retry', text: t('common.actions.retry') }));
    } else if (!root) {
      const days = H.state()?.retention?.contentDays;
      if (T.expired && days) tNote.append(svg('info'), h('span', { text: t('chat.thread.rootExpired', { count: days }) }));
      else if (!T.complete || T.expired) {
        tNote.append(svg('info'), h('span', { text: t('chat.thread.partial') }));
        if (!T.expired) {
          const more = h('button', { type: 'button', class: 'link-btn', 'data-ch': 'thread-earlier', text: t('chat.thread.loadEarlier') });
          if (T.loading) more.disabled = true;
          tNote.append(more);
        }
      }
    }
    tNote.hidden = !tNote.childNodes.length;
  }

  // position: 'bottom', 'keep', 'anchor' (earlier replies came in above), 'restore' or 'at' (the notification's reply).
  function renderThread({ position = 'keep', restore = null } = {}) {
    if (!T || mode !== 'room') return;
    renderThreadHead();
    const heightBefore = tScroll.scrollHeight;
    const topBefore = tScroll.scrollTop;
    const rows = threadRows();
    T.rows = new Map(rows.map((r) => [r.key, r]));
    T.nodes = reconcile(tLog, T.nodes, rows, { focusKey: T.focusKey, thread: true });
    renderThreadNotes();
    if (T.input) T.input.setBar(threadBar());
    if (position === 'bottom') tScroll.scrollTop = tScroll.scrollHeight;
    else if (position === 'anchor') tScroll.scrollTop = topBefore + (tScroll.scrollHeight - heightBefore);
    else if (position === 'restore' && restore !== null) tScroll.scrollTop = restore;
    else if (position === 'at') threadAt();
  }

  function threadAt() {
    if (!T) return;
    const li = T.seq ? tLog.querySelector(`li[data-seq="${T.seq}"]`) : null;
    if (!li) {
      tScroll.scrollTop = tScroll.scrollHeight;
      return;
    }
    li.scrollIntoView({ block: 'center' });
    li.classList.add('is-target');
    clearTimeout(T.targetTimer);
    T.targetTimer = setTimeout(() => li.classList.remove('is-target'), TARGET_MS);
  }

  // chatThread: the root and its replies, paging back for a root older than the cache (contract 3.7 "Threads").
  // earlier: Load earlier, which pages ten more.
  async function loadThread({ earlier = false } = {}) {
    if (!T) return;
    const my = ++T.token;
    const root = T.root;
    const ws = V.ws;
    const c = V.c;
    T.loading = true;
    T.error = null;
    renderThreadNotes();
    let tv;
    try {
      tv = await api('chatThread', ws, c, root);
    } catch (err) {
      if (!T || T.token !== my || T.root !== root) return;
      T.loading = false;
      if (H.goneError(err, ws, c)) return;
      T.error = err;
      renderThreadNotes();
      return;
    }
    if (!T || T.token !== my || T.root !== root || V.c !== c) return;
    T.loading = false;
    if (tv.root) T.ev.set(tv.root.seq, tv.root);
    for (const e of tv.replies || []) T.ev.set(e.seq, e);
    T.complete = Boolean(tv.complete);
    T.expired = Boolean(tv.expired);
    if (!T.draftDone) {
      T.draftDone = true;
      if (tv.draft && T.input && !T.input.parts().length) T.input.setParts(toParts(tv.draft.text, tv.draft.mentions));
    }
    // A root removed without replies has nothing to show.
    if (tv.root && tv.root.redacted && !threadReplies() && !V.pending.some((x) => x.root === root)) {
      closeThread();
      return;
    }
    renderThread({ position: earlier ? 'anchor' : T.seq ? 'at' : 'bottom' });
    T.seq = null;
  }

  // Opens the thread of rootId beside the log, or over it in a narrow view, with the focus in its composer. seq: a
  // reply to show, outlined. Opening one never moves the main log (contract 3.13).
  function openThread(rootId, { seq = null } = {}) {
    if (mode !== 'room' || !rootId || !V.c) return;
    if (T && T.root === rootId) {
      if (seq) {
        T.seq = seq;
        threadAt();
      }
      T.input?.focus();
      return;
    }
    closeThread({ restoreFocus: false });
    T = { root: rootId, seq, ev: new Map(), nodes: new Map(), rows: new Map(), complete: true, expired: false, loading: true, error: null, token: 0, input: null, focusKey: null, targetTimer: null, draftDone: false };
    for (const e of V.events) if (inThread(e)) T.ev.set(e.seq, e);
    section.dataset.thread = 'open';
    thread.hidden = false;
    thread.classList.remove('is-entering');
    void thread.offsetWidth;
    if (!reduced()) thread.classList.add('is-entering');
    const ws = V.ws;
    const c = V.c;
    tCompose.textContent = '';
    T.input = mountChatInput(tCompose, {
      placeholder: t('chat.input.placeholderThread'),
      members: () => mentionCandidates(),
      recent: () => recentAuthors(),
      onSend: (wire) => sendMessage(wire, rootId),
      onEscape: () => {
        closeThread();
        return true;
      },
      onDraft: (draft) => api('chatSaveDraft', ws, c, rootId, draft).catch(() => {})
    });
    renderThread({ position: seq ? 'at' : 'bottom' });
    T.input.focus();
    // A bar without a button (the root removed): the header's close or back button, whichever shows.
    if (!thread.contains(document.activeElement)) (getComputedStyle(tClose).display === 'none' ? tBack : tClose).focus({ preventScroll: true });
    loadThread();
  }

  // Closes the thread, saving its draft. restoreFocus: back to the root's row in the main log (desktop-ui 5.7).
  function closeThread({ restoreFocus = true } = {}) {
    section.dataset.thread = 'closed';
    thread.hidden = true;
    thread.classList.remove('is-entering');
    if (!T) return;
    const root = T.root;
    const hadFocus = thread.contains(document.activeElement);
    if (T.input) T.input.dispose();
    clearTimeout(T.targetTimer);
    T = null;
    tLog.textContent = '';
    tNote.textContent = '';
    tOlder.textContent = '';
    tOlder.className = 'ch-thread-older';
    tCompose.textContent = '';
    if (!restoreFocus || mode !== 'room') return;
    const li = log.querySelector(`li.ch-msg[data-id="${CSS.escape(root)}"]`);
    if (li) {
      for (const x of log.querySelectorAll('li.ch-msg')) x.tabIndex = x === li ? 0 : -1;
      V.focusKey = li.dataset.key;
      li.focus({ preventScroll: true });
      li.scrollIntoView({ block: 'nearest' });
    } else if (hadFocus) (input ? input.focus() : scroll.focus({ preventScroll: true }));
    considerRead();
  }

  // ---------- input ----------

  scroll.addEventListener(
    'scroll',
    () => {
      updateJumps();
      maybeOlder();
    },
    { passive: true }
  );

  log.addEventListener('focusin', (e) => {
    const li = e.target.closest('li.ch-msg');
    if (!li) return;
    V.focusKey = li.dataset.key;
    for (const x of log.querySelectorAll('li.ch-msg')) x.tabIndex = x === li ? 0 : -1;
  });
  tLog.addEventListener('focusin', (e) => {
    const li = e.target.closest('li.ch-msg');
    if (!li || !T) return;
    T.focusKey = li.dataset.key;
    for (const x of tLog.querySelectorAll('li.ch-msg')) x.tabIndex = x === li ? 0 : -1;
  });

  section.addEventListener('click', (e) => {
    const tool = e.target.closest('[data-ch-tool]');
    if (tool && section.contains(tool)) {
      const li = tool.closest('li.ch-msg');
      const row = rowOf(li);
      if (!row) return;
      if (tool.dataset.chTool === 'reply') openThread(row.root || row.id);
      else if (tool.dataset.chTool === 'copy') copyText(row.text);
      else messageMenu(li, (() => {
        const r = tool.getBoundingClientRect();
        return { x: r.left, y: r.bottom + 4 };
      })());
      return;
    }
    const act = e.target.closest('[data-ch-act]');
    if (act && section.contains(act)) {
      pendingAction(act.dataset.chAct, act.dataset.local);
      return;
    }
    const b = e.target.closest('[data-ch]');
    if (!b || !section.contains(b)) return;
    switch (b.dataset.ch) {
      case 'thread':
        return openThread(b.dataset.root);
      case 'thread-close':
      case 'thread-back':
        return closeThread();
      case 'thread-earlier':
        return loadThread({ earlier: true });
      case 'thread-retry':
        return loadThread();
      case 'members':
        return H.showMembers(V.room);
      case 'more':
        return moreMenu(b);
      case 'jump-latest':
        return toBottom(true);
      case 'jump-unread':
        return toNew();
      default:
    }
  });

  section.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li.ch-msg');
    if (!li || !section.contains(li) || e.target.closest('a')) return;
    if (messageMenu(li, { x: e.clientX, y: e.clientY })) e.preventDefault();
  });

  // Keys in the log and the thread (desktop-ui 9.2, contract 5.9): the arrows step through message rows, Home and End
  // go to the first and last, Page Up and Page Down scroll, Enter on a message with replies opens its thread, Shift+F10
  // and the ContextMenu key open the message menu, Escape closes the thread or goes to the composer, and a printable
  // key goes to the composer. True when handled.
  function onKey(e, { typing }) {
    if (mode !== 'room') return false;
    if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey && !typing && T) {
      closeThread();
      return true;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return false;
    const inMain = scroll.contains(e.target) || e.target === scroll;
    const inThreadLog = tScroll.contains(e.target) || e.target === tScroll;
    if (!inMain && !inThreadLog) return false;
    const list = inMain ? log : tLog;
    const area = inMain ? scroll : tScroll;
    const rows = [...list.querySelectorAll('li.ch-msg')];
    const current = e.target.closest?.('li.ch-msg');
    const i = current ? rows.indexOf(current) : -1;
    const go = (li) => {
      if (!li) return;
      li.focus({ preventScroll: true });
      li.scrollIntoView({ block: 'nearest' });
    };
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      if (current) messageMenu(current);
      return true;
    }
    switch (e.key) {
      case 'ArrowDown':
        go(rows[i < 0 ? rows.length - 1 : Math.min(rows.length - 1, i + 1)]);
        return true;
      case 'ArrowUp':
        go(rows[i < 0 ? rows.length - 1 : Math.max(0, i - 1)]);
        return true;
      case 'Home':
        go(rows[0]);
        if (inMain) maybeOlder();
        return true;
      case 'End':
        go(rows[rows.length - 1]);
        return true;
      case 'PageDown':
      case 'PageUp':
        area.scrollBy({ top: (e.key === 'PageDown' ? 1 : -1) * area.clientHeight * 0.9, behavior: behavior() });
        return true;
      case 'Enter':
        if (inMain && current && current.querySelector('.ch-replies')) {
          openThread(current.dataset.id);
          return true;
        }
        return false;
      case 'Escape':
        if (e.shiftKey) return false;
        (inMain ? input : T && T.input)?.focus();
        return true;
      default: {
        // A printable key types in the composer: the focus moves there before the key's character goes in.
        const target = inMain ? input : T && T.input;
        if (target && e.key.length === 1 && e.key !== ' ' && target.input && !target.input.closest('[hidden]')) target.focus();
        return false;
      }
    }
  }

  // ---------- the view's API (chat.js) ----------

  return {
    open,
    onEvent,
    roomChanged,
    showState,
    goneConversation,
    goneWorkspace,
    setBanner,
    stateChanged,
    markRead,
    onKey,
    openThread,
    closeThread,
    preview,
    // Chat mode left the screen: reading stops until a room opens again, and the drafts are saved.
    hide() {
      clearTimeout(V.readTimer);
      if (input) input.flush();
      if (T && T.input) T.input.flush();
      token++;
      mode = null;
      V.loaded = false;
    },
    // Another workspace: the open room goes.
    close() {
      if (V.c) api('chatClose').catch(() => {});
      dropRoom();
      token++;
      mode = null;
      stateKey = null;
      showRoom(false);
    },
    // A language change: everything that says something is drawn again.
    relocalize() {
      stateKey = null;
      bannerKey = null;
      if (mode !== 'room') return;
      renderHead();
      if (input) input.setPlaceholder(placeholderFor(V.room));
      updateBars();
      const top = scroll.scrollTop;
      for (const li of V.nodes.values()) io.unobserve(li);
      log.textContent = '';
      V.nodes = new Map();
      render({ position: 'restore', restore: top });
      if (T) {
        if (T.input) T.input.setPlaceholder(t('chat.input.placeholderThread'));
        const threadTop = tScroll.scrollTop;
        tLog.textContent = '';
        T.nodes = new Map();
        renderThread({ position: 'restore', restore: threadTop });
      }
    },
    elements: { section, main, head, banner, scroll, log, compose, thread },
    current: () => (mode === 'room' ? { ws: V.ws, c: V.c, room: V.room } : null)
  };
}
