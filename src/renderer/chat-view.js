import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, hhmm, longDate, listTime, groupLabel, hue, initials, showMenu, toast } from './ui.js';
import { h } from './agent/bui.js';
import { timeline, displayName, memberTag } from './chat-model.js';
import { segments } from './chat-text.js';

// Team chat's pane (contract 5.4, desktop-ui 5.2 to 5.4 and 7): the open conversation's header, the banner, the log
// with its reading, jump pills and older history, and the pane's states. chat.js decides what shows; this module
// draws it. The log's rows come from chat-model.js timeline() and are kept by key: a row is built again only when
// its sig changed, so live messages, pending sends and removals touch only their rows and the scroll position holds.
//
// Everything in the log was written by people: it reaches the DOM through h()'s text prop and text nodes, never as
// HTML. Icons are the app's own static markup.
//
// The composer area (.ch-compose) and the thread panel (.ch-thread) stay empty here; chat-input.js and the thread
// code fill them in.

// When the log is this close to its end, a new message keeps it there (desktop-ui 5.3).
const STICK_PX = 80;
// Older messages load when the top is this close.
const OLDER_PX = 400;
// A read report goes this long after the last change (contract 3.9, READ_REPORT_DELAY).
const READ_DELAY = 1000;
// A row opened at from a notification keeps its outline this long.
const TARGET_MS = 2000;
const ANNOUNCE_CHARS = 120;

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
const firstChars = (text, n) => {
  const chars = [...String(text || '').replace(/\s+/g, ' ').trim()];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
};
const bySeq = (a, b) => a.seq - b.seq;

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
  const thread = h('aside', { class: 'ch-thread', hidden: true });
  section.append(main, thread);

  // 'room' while a conversation shows, 'state' for an empty or gone state, null before either.
  let mode = null;
  let stateKey = null;
  let bannerKey = null;
  let token = 0;
  let V = blank();

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
      pending: [],
      // messageId -> local ID of sends that committed while the room was open, so their rows keep their nodes.
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
      focusKey: null,
      targetTimer: null
    };
  }

  const members = () => H.members();
  const nameOf = (id) => displayName(members().get(id), t);

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
  // page, no dialog).
  const canRead = () =>
    mode === 'room' && V.loaded && V.c && H.active() && document.hasFocus() && document.visibilityState !== 'hidden' && !document.querySelector('#overlays .page, .scrim');

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
    const head = V.room?.head || 0;
    V.readBest = Math.max(V.readBest, head);
    V.readSent = Math.max(V.readSent, head);
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

  // Leaves the open room: its rows, timers and observer entries go.
  function dropRoom() {
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
    if (V.c) dropRoom();
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
          actions: H.browse ? [{ id: 'browse', label: t('chat.sidebar.browse'), run: () => H.browse() }] : []
        });
    }
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
    thread.hidden = true;
    section.dataset.thread = 'closed';
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
    thread.hidden = true;
    section.dataset.thread = 'closed';
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

  // The header's More menu (contract 5.4). Mark as read and Mute here; the rest of the menu comes with the dialogs.
  function moreMenu(anchor) {
    const room = V.room;
    if (!room) return;
    const name = H.roomName(room);
    const items = [];
    if ((room.unread || 0) > 0 || (room.mentions || 0) > 0) items.push({ icon: 'check', label: t('chat.head.markRead'), shortcut: 'Shift+Esc', action: () => markRead() });
    items.push(
      room.muted
        ? { icon: 'bell', label: t('chat.head.unmute'), action: () => mute(false, name) }
        : { icon: 'mute', label: t('chat.head.mute'), action: () => mute(true, name) }
    );
    showMenu(anchor, items, { align: 'right' });
  }

  function mute(on, name) {
    const ws = V.ws;
    const c = V.c;
    api('chatMute', ws, c, on)
      .then(() => toast(t(on ? 'chat.mute.done' : 'chat.mute.undone', { name })))
      .catch((err) => H.goneError(err, ws, c) || toast(H.errorText(err), 5000));
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
    showRoom(true);
    section.dataset.thread = 'closed';
    thread.hidden = true;
    renderHead();
    renderOlder();
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
    V.pending = rv.pending || [];
    // An uncached room answers with nothing yet; the newest page follows as an events push.
    V.loaded = V.events.length > 0 || rv.hi !== null;
    renderHead();
    if (!V.loaded) return renderOlder();
    render({ position: at != null ? 'at' : keepScroll !== null ? 'restore' : 'open', restore: keepScroll });
  }

  // ---------- events for the open room (contract 4.5, 5.4) ----------

  function merge(events) {
    const map = new Map(V.events.map((e) => [e.seq, e]));
    for (const e of events) if (e && Number.isSafeInteger(e.seq)) map.set(e.seq, e);
    V.events = [...map.values()].sort(bySeq);
  }

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
      return;
    }
    if (p.kind === 'redacted') {
      const ids = new Set(Array.isArray(p.ids) ? p.ids : []);
      let changed = false;
      V.events = V.events.map((e) => {
        if (!ids.has(e.id) || e.redacted) return e;
        changed = true;
        return { ...e, text: null, mentions: [], redacted: true };
      });
      if (changed) render({ position: 'keep' });
      return;
    }
    if (p.kind === 'pending') {
      const known = new Set(V.pending.map((x) => x.local));
      V.pending = Array.isArray(p.pending) ? p.pending : [];
      // Sending your own message always goes to the end (desktop-ui 5.3).
      const mine = V.pending.some((x) => !known.has(x.local) && !x.root);
      if (V.loaded) render({ position: mine ? 'bottom' : 'keep' });
      return;
    }
    if (p.kind === 'sent') {
      if (p.messageId && p.local) V.sentLocal.set(p.messageId, p.local);
      if (V.loaded) render({ position: 'keep' });
    }
  }

  // The room's row changed (badges, members, mute) or the directory did (names): the header, and the log when names
  // may have changed.
  function roomChanged(room, { directory = false } = {}) {
    if (mode !== 'room' || !room || room.id !== V.c) return;
    V.room = { ...V.room, ...room };
    renderHead();
    if (directory && V.loaded) render({ position: 'keep' });
    else updateJumps();
  }

  // ---------- the log ----------

  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICK_PX;

  function introOf() {
    const first = V.events.find((e) => e.kind === 'channel.created' || e.kind === 'dm.started');
    return first ? { actor: first.actor, at: first.at } : null;
  }

  // render: the rows from timeline() put in place. position: 'open' (the New divider a third down, else the end),
  // 'at' (the notification's message), 'bottom', 'anchor' (older rows came in above), 'restore' or 'keep'. arrivals:
  // events that came in live, which fade in and may be announced.
  function render({ position = 'keep', arrivals = [], restore = null } = {}) {
    if (mode !== 'room' || !V.loaded) return;
    const heightBefore = scroll.scrollHeight;
    const topBefore = scroll.scrollTop;
    const rows = timeline(V.events, {
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
    });
    const fresh = new Set(arrivals.map((e) => e.id));
    reconcile(rows, fresh);
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

  function reconcile(rows, fresh) {
    const focused = document.activeElement && log.contains(document.activeElement) ? document.activeElement.closest('li')?.dataset.key : null;
    const old = V.nodes;
    const next = new Map();
    for (const row of rows) {
      let li = old.get(row.key);
      if (!li || li.dataset.sig !== row.sig) {
        li = build(row);
        li.dataset.key = row.key;
        li.dataset.sig = row.sig;
        if (fresh.has(row.id) && !reduced()) li.classList.add('is-arriving');
        if (li.dataset.seq) io.observe(li);
      }
      next.set(row.key, li);
    }
    let cursor = log.firstChild;
    for (const li of next.values()) {
      if (li === cursor) cursor = cursor.nextSibling;
      else log.insertBefore(li, cursor);
    }
    for (const [key, li] of old) {
      if (next.get(key) === li) continue;
      io.unobserve(li);
      li.remove();
    }
    V.nodes = next;
    // Visible rows that went no longer count.
    for (const seq of [...V.visible]) if (!log.querySelector(`li[data-seq="${seq}"]`)) V.visible.delete(seq);
    // One message row takes Tab (desktop-ui 9.2): the focused one, else the last.
    const msgs = [...log.querySelectorAll('li.ch-msg')];
    const keep = (focused && next.get(focused)) || (V.focusKey && next.get(V.focusKey)) || msgs[msgs.length - 1] || null;
    for (const li of msgs) li.tabIndex = li === keep ? 0 : -1;
    if (focused && next.get(focused) && document.activeElement !== next.get(focused)) next.get(focused).focus({ preventScroll: true });
  }

  function build(row) {
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
      case 'intro':
        return buildIntro(row);
      case 'sys':
        return buildSys(row);
      default:
        return buildMessage(row);
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

  // A reply's context line and a thread's summary open the thread once the thread panel is there; until then they are
  // text.
  const threadTag = () => (H.threads() ? 'button' : 'div');
  const threadProps = (cls, root, extra = {}) => (H.threads() ? { type: 'button', class: cls, 'data-ch': 'thread', 'data-root': root, ...extra } : { class: cls, ...extra });

  function contextLine(c) {
    let text;
    if (c.state === 'ok') text = t('chat.log.replyTo', { name: displayName(c.author, t), text: c.text });
    else if (c.state === 'removed') text = t('chat.log.replyToRemoved');
    else text = t('chat.log.replyInThread');
    return h(threadTag(), threadProps('ch-context', c.root, { title: text }), svg('reply'), h('span', { text }));
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
    const btn = h(threadTag(), threadProps(`ch-replies${r.hasNew ? ' has-new' : ''}`, row.id, { 'aria-label': [count, last].filter(Boolean).join(', ') }));
    const avs = h('span', { class: 'ch-replies-av', 'aria-hidden': 'true' });
    for (const id of r.actors) avs.append(avatarEl(id, nameOf(id), { cls: 'ch-av-16', deleted: members().get(id)?.state === 'deleted' }));
    btn.append(avs);
    if (r.hasNew) btn.append(h('i', { class: 'ch-replies-dot', 'aria-hidden': 'true' }));
    btn.append(h('span', { class: 'ch-replies-n', text: t('chat.log.replies', { count: r.count }) }));
    if (last) btn.append(h('span', { class: 'ch-replies-at', text: last }));
    return btn;
  }

  function buildMessage(row) {
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
    if (row.replies && row.replies.count) body.append(repliesEl(row));
    if (row.mentionsMe) li.setAttribute('aria-description', t('chat.msg.mentionsYou'));
    li.append(body);
    return li;
  }

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

  // Opening at a notification's message: in view, outlined for two seconds; a reply opens its thread too.
  function positionAt() {
    const at = V.at;
    const rows = [...log.querySelectorAll('li[data-seq]')];
    const target = rows.find((li) => Number(li.dataset.seq) === at) || rows.find((li) => Number(li.dataset.seq) >= at) || rows[rows.length - 1];
    if (!target) return positionOpen();
    target.scrollIntoView({ block: 'center' });
    target.classList.add('is-target');
    clearTimeout(V.targetTimer);
    V.targetTimer = setTimeout(() => target.classList.remove('is-target'), TARGET_MS);
    if (target.dataset.root && H.threads()) H.openThread(target.dataset.root, { seq: at });
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

  main.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch]');
    if (!b || !main.contains(b)) return;
    switch (b.dataset.ch) {
      case 'thread':
        return H.openThread(b.dataset.root);
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

  // Keys in the log (desktop-ui 9.2): the arrows step through message rows, Home and End go to the first and last,
  // Page Up and Page Down scroll, and Enter on a message with replies opens its thread. True when handled.
  function onKey(e, { typing }) {
    if (mode !== 'room' || typing || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (!scroll.contains(e.target) && e.target !== scroll) return false;
    const rows = [...log.querySelectorAll('li.ch-msg')];
    const current = e.target.closest?.('li.ch-msg');
    const i = current ? rows.indexOf(current) : -1;
    const go = (li) => {
      if (!li) return;
      li.focus({ preventScroll: true });
      li.scrollIntoView({ block: 'nearest' });
    };
    switch (e.key) {
      case 'ArrowDown':
        go(rows[i < 0 ? rows.length - 1 : Math.min(rows.length - 1, i + 1)]);
        return true;
      case 'ArrowUp':
        go(rows[i < 0 ? rows.length - 1 : Math.max(0, i - 1)]);
        return true;
      case 'Home':
        go(rows[0]);
        maybeOlder();
        return true;
      case 'End':
        go(rows[rows.length - 1]);
        return true;
      case 'PageDown':
      case 'PageUp':
        scroll.scrollBy({ top: (e.key === 'PageDown' ? 1 : -1) * scroll.clientHeight * 0.9, behavior: behavior() });
        return true;
      case 'Enter':
        if (current && H.threads() && current.querySelector('.ch-replies')) {
          H.openThread(current.dataset.id);
          return true;
        }
        return false;
      default:
        return false;
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
    markRead,
    onKey,
    // Chat mode left the screen: reading stops until a room opens again.
    hide() {
      clearTimeout(V.readTimer);
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
      const top = scroll.scrollTop;
      for (const li of V.nodes.values()) io.unobserve(li);
      log.textContent = '';
      V.nodes = new Map();
      render({ position: 'restore', restore: top });
    },
    // The log's element and the room on screen, for the composer and thread code that build on this view.
    elements: { section, main, head, banner, scroll, log, compose, thread },
    current: () => (mode === 'room' ? { ws: V.ws, c: V.c, room: V.room } : null)
  };
}
