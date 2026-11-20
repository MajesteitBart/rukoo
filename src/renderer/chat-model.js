// Team chat as rows and labels: the timeline of a conversation or a thread, the sidebar's order and badges, the
// titles of direct messages and the names of members. Pure: no DOM and no window.mail, so the node tests can load
// it (test/chat-model.test.js). chat-view.js draws what this returns, and the text functions it takes (t, a collator,
// a list format) come from the caller, so the language is the caller's.

import { mentionsMember, validMentions } from './chat-text.js';

// A message group ends after this long without one from the same author.
export const GROUP_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// The start of a thread's first message that a reply row quotes.
const CONTEXT_CHARS = 120;

const isMessage = (e) => Boolean(e) && e.kind === 'message.posted';
const asMap = (members) => (members instanceof Map ? members : new Map((members || []).filter(Boolean).map((m) => [m.id, m])));
const bySeq = (events) =>
  (events || [])
    .filter((e) => e && Number.isSafeInteger(e.seq))
    .slice()
    .sort((a, b) => a.seq - b.seq)
    // One row per seq: a page loaded twice must not show a message twice.
    .filter((e, i, list) => i === 0 || list[i - 1].seq !== e.seq);

// The local calendar day of a time, as a key, and how many days before today it is.
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const startOfDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
// Rounded, because a day with a daylight saving change has 23 or 25 hours.
const daysAgo = (ms, now) => Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);

// What a system event says, or null for events that show no row: message.redacted shows on its target, and a kind
// this version doesn't know shows nothing.
function sysKind(e) {
  const member = e.data && e.data.member;
  switch (e.kind) {
    case 'channel.created':
      return 'created';
    case 'channel.renamed':
      return 'renamed';
    case 'channel.archived':
      return 'archived';
    case 'member.joined':
      return member && member !== e.actor ? 'added' : 'joined';
    case 'member.left':
      return member && member !== e.actor ? 'removedBy' : 'left';
    case 'dm.started':
      return 'dmStarted';
    default:
      return null;
  }
}

// The part of a member a row's look depends on, for its sig.
const memberSig = (m) => (m ? `${m.name ?? ''}\u0001${m.state ?? ''}\u0001${m.role ?? ''}` : '');

// The start of a message on one line, for the context line of a reply.
function snippet(text) {
  const chars = [...String(text || '').replace(/\s+/g, ' ').trim()];
  return chars.length > CONTEXT_CHARS ? `${chars.slice(0, CONTEXT_CHARS).join('')}…` : chars.join('');
}

// The replies to each thread among events: Map rootId -> { count, lastAt, newest, newestOther, actors }. newest is
// the seq of the latest reply, newestOther that of the latest reply by someone other than me (0 when there is none),
// lastAt the latest reply's time, actors the latest three distinct authors of replies that weren't removed, the
// latest first. Counts cover the cached replies; an open room's cache reaches its head, so they are complete for
// every root shown.
export function replyCounts(events, { me = null } = {}) {
  const out = new Map();
  for (const e of bySeq(events)) {
    if (!isMessage(e) || !e.root) continue;
    let s = out.get(e.root);
    if (!s) out.set(e.root, (s = { count: 0, lastAt: null, newest: 0, newestOther: 0, actors: [] }));
    s.count++;
    s.newest = e.seq;
    if (e.actor !== me) s.newestOther = e.seq;
    s.lastAt = e.at;
    if (!e.redacted) s.actors = [e.actor, ...s.actors.filter((a) => a !== e.actor)].slice(0, 3);
  }
  return out;
}

// The rows of a conversation's log, or of a thread with opts.root, in the order they show:
//   intro  the start of the conversation, when floor is 1 and nothing is older (not in a thread)
//   floor  older messages aged out, when floor is above 1 and nothing older can load (not in a thread)
//   day    a day divider before the first row of each local day
//   new    before the first message by someone else after the read position the room had when it opened
//   sys    a system event
//   msg    a message; in a thread, the root and its replies
//   reply  a reply to a thread, in the main timeline, with the context line of its root
// Every row has a stable key (the event ID, local:{id} for a pending send, or a fixed name) and a sig: a string of
// what its DOM depends on, so the view rebuilds only rows whose sig changed.
//
// opts: me (your member ID), members (Map or list of Member), readAtOpen (the read seq when the room opened),
// pending (Pending[] of the room), root (a thread's root ID), floor and hasOlder (from RoomView), blocked (Set of
// member IDs you blocked), intro (passed through to the intro row), groupMs, now, and sentLocal (Map messageId ->
// local ID of sends that committed while the view was open, so the row keeps its key and its DOM node).
export function timeline(events, opts = {}) {
  const {
    me = null,
    readAtOpen = null,
    pending = [],
    root = null,
    floor = 1,
    hasOlder = false,
    blocked = new Set(),
    intro = null,
    groupMs = GROUP_MS,
    now = Date.now(),
    sentLocal = null
  } = opts;
  const members = asMap(opts.members);
  const list = bySeq(events);
  const messages = new Map(list.filter(isMessage).map((e) => [e.id, e]));
  const counts = replyCounts(list, { me });
  const shown = root ? list.filter((e) => isMessage(e) && (e.id === root || e.root === root)) : list;
  const committed = new Set(sentLocal ? [...sentLocal].filter(([id]) => messages.has(id)).map(([, local]) => local) : []);
  const waiting = (pending || [])
    .filter((p) => p && p.local && !committed.has(p.local) && (root ? p.root === root : true))
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const rows = [];
  if (!root && !hasOlder) {
    if (!(floor > 1)) rows.push({ type: 'intro', key: 'intro', intro, sig: `intro\u0001${JSON.stringify(intro ?? null)}` });
    else rows.push({ type: 'floor', key: 'floor', floor, sig: 'floor' });
  }

  let lastDay = null;
  let lastAt = -Infinity; // the time of the last row shown, for the day of a pending row
  const days = new Set(); // day keys already shown: a key never shows twice
  let prev = null; // the last message row, while a group can continue
  let newPlaced = false;
  const mentionNames = (text, mentions) =>
    validMentions(text, mentions)
      .map((m) => members.get(m.actor)?.name ?? '')
      .join('\u0002');

  // A day divider before the first row of a local day. Only called for an item that shows a row, so a removal or an
  // unknown kind on a later day leaves no divider with nothing under it.
  const dayBefore = (at) => {
    const day = dayKey(at);
    if (day === lastDay || days.has(day)) return;
    const ago = daysAgo(at, now);
    rows.push({ type: 'day', key: `day:${day}`, at: startOfDay(at), sig: `day\u0001${ago >= 0 && ago < 7 ? ago : 'date'}` });
    days.add(day);
    lastDay = day;
    prev = null;
  };

  const add = (item, isPending) => {
    const at = isPending ? item.createdAt || 0 : item.at;
    const sys = !isPending && !isMessage(item) ? sysKind(item) : null;
    if (!isPending && !isMessage(item) && !sys) return;
    // Pending rows come after every sent row, so one written before the last sent row (a held send from yesterday,
    // or a local clock behind the server's) takes that row's day instead of a divider that runs backwards.
    dayBefore(isPending ? Math.max(at, lastAt) : at);
    if (Number.isFinite(at)) lastAt = Math.max(lastAt, at);
    if (sys) {
      const data = item.data || {};
      const subject = data.member || null;
      rows.push({
        type: 'sys',
        key: item.id,
        sig: ['sys', sys, memberSig(members.get(item.actor)), memberSig(subject && members.get(subject)), data.name ?? ''].join('\u0001'),
        seq: item.seq,
        id: item.id,
        actor: item.actor,
        at,
        sys,
        member: subject,
        name: data.name ?? null,
        visibility: data.visibility ?? null
      });
      prev = null;
      return;
    }

    const actor = isPending ? me : item.actor;
    if (!root && !isPending && !newPlaced && readAtOpen != null && actor !== me && item.seq > readAtOpen) {
      rows.push({ type: 'new', key: 'new', sig: 'new' });
      newPlaced = true;
      prev = null;
    }
    const threadOf = item.root || null;
    const removed = !isPending && Boolean(item.redacted || item.text == null);
    const head = !(
      prev &&
      prev.actor === actor &&
      at >= prev.at &&
      at - prev.at < groupMs &&
      !prev.removed &&
      !removed &&
      prev.root === threadOf
    );
    const isBlocked = blocked.has(actor);
    const text = removed ? null : item.text;
    const mentions = removed ? [] : item.mentions || [];
    const mentionsMe = !removed && actor !== me && mentionsMember(text, mentions, me, { blocked: isBlocked });
    const author = members.get(actor) || null;
    const row = {
      type: threadOf && !root ? 'reply' : 'msg',
      key: isPending ? `local:${item.local}` : sentLocal?.has(item.id) ? `local:${sentLocal.get(item.id)}` : item.id,
      seq: isPending ? null : item.seq,
      id: isPending ? null : item.id,
      local: isPending ? item.local : (sentLocal?.get(item.id) ?? null),
      actor,
      author,
      at,
      root: threadOf,
      head,
      text,
      mentions,
      removed,
      mentionsMe,
      blocked: isBlocked,
      pending: isPending ? item.state : null,
      reason: isPending ? (item.reason ?? null) : null,
      nextAt: isPending ? (item.nextAt ?? null) : null,
      replies: null,
      context: null
    };
    if (!threadOf && !isPending) {
      const s = counts.get(item.id);
      // Like the New divider, your own replies are never new to you.
      if (s) row.replies = { ...s, hasNew: readAtOpen != null && s.newestOther > readAtOpen };
    }
    if (row.type === 'reply') {
      const top = messages.get(threadOf);
      if (!top) row.context = { state: 'missing', root: threadOf };
      else if (top.redacted || top.text == null) row.context = { state: 'removed', root: threadOf };
      else row.context = { state: 'ok', root: threadOf, actor: top.actor, author: members.get(top.actor) || null, text: snippet(top.text) };
    }
    const r = row.replies;
    const c = row.context;
    row.sig = [
      row.type,
      row.seq ?? '',
      head ? 1 : 0,
      removed ? 1 : 0,
      mentionsMe ? 1 : 0,
      isBlocked ? 1 : 0,
      row.pending ?? '',
      row.reason ?? '',
      row.nextAt ?? '',
      memberSig(author),
      removed ? '' : mentionNames(text, mentions),
      r ? [r.count, r.hasNew ? 1 : 0, r.lastAt ?? '', r.actors.map((a) => `${a}=${members.get(a)?.name ?? ''}`).join(' ')].join(',') : '',
      c ? [c.state, c.text ?? '', memberSig(c.author)].join(',') : ''
    ].join('\u0001');
    rows.push(row);
    prev = row;
  };

  for (const e of shown) add(e, false);
  for (const p of waiting) add(p, true);
  return rows;
}

// The sidebar's order: { channels, dms }. Channels by name with collator, archived ones left out unless open (the
// one on screen stays where it was). DMs: open ones by their last activity, the latest first, then closed ones the
// same way.
export function sortRooms(rooms, collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }), { open = null } = {}) {
  const list = (rooms || []).filter(Boolean);
  const name = (r) => String(r.name ?? '');
  const channels = list
    .filter((r) => r.kind === 'channel' && (!r.archived || r.id === open))
    .sort((a, b) => collator.compare(name(a), name(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const last = (r) => (Number.isFinite(r.lastAt) ? r.lastAt : 0);
  const dms = list
    .filter((r) => r.kind === 'dm')
    .sort((a, b) => (a.closedReason ? 1 : 0) - (b.closedReason ? 1 : 0) || last(b) - last(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { channels, dms };
}

// A member's name as the log and the titles show it: "Deleted member" for an erased account, and "Former member"
// for someone this device doesn't know (a guest's directory lists only the active members of their channels).
export function displayName(member, t) {
  if (!member) return t('chat.log.formerMember');
  if (member.state === 'deleted') return t('chat.log.deletedMember');
  return String(member.name || '').trim() || t('chat.log.formerMember');
}

// The tag after a member's name, or null: Former member for someone who left or was removed, Guest for a guest. A
// deleted member has none, because their name is the tag already.
export function memberTag(member, t) {
  if (!member || member.state === 'deleted') return null;
  if (member.state === 'left' || member.state === 'removed') return t('chat.log.formerMember');
  if (member.role === 'guest') return t('chat.roles.guest');
  return null;
}

// A direct message's title: the other participant's name; two or three names joined by listFormat ("Sanne, Mila and
// Olga"); four or more as "Sanne, Mila and 3 others". members: Map or list of Member.
export function dmTitle(room, members, me, listFormat = new Intl.ListFormat(undefined, { type: 'conjunction' }), t) {
  const map = asMap(members);
  const others = [...new Set((room && room.participants) || [])].filter((id) => id !== me);
  if (!others.length) return displayName(map.get(me), t);
  const names = others.map((id) => displayName(map.get(id), t));
  if (names.length === 1) return names[0];
  if (names.length <= 3) return listFormat.format(names);
  return `${names.slice(0, 2).join(', ')}${t('reader.recipients.others', { count: names.length - 2 })}`;
}

// What a room calls for: 0 when muted, else its unread count for a DM and its mention count for a channel.
export function attention(room) {
  if (!room || room.muted) return 0;
  return Math.max(0, (room.kind === 'dm' ? room.unread : room.mentions) || 0);
}

// A sidebar row's badge: { attention, pill, count, bold, dim }. pill is the accent pill's number (a DM's unread, a
// channel's mentions), count the plain number of a channel with unread messages and no mentions. Muted rows are
// never bold and show no number; muted and closed rows are dimmed.
export function roomBadge(room) {
  const muted = Boolean(room && room.muted);
  const closed = Boolean(room && room.kind === 'dm' && room.closedReason);
  const unread = Math.max(0, (room && room.unread) || 0);
  const mentions = Math.max(0, (room && room.mentions) || 0);
  const badge = { attention: attention(room), pill: null, count: null, bold: false, dim: muted || closed };
  if (!room || muted) return badge;
  if (room.kind === 'dm') {
    if (unread) badge.pill = unread;
  } else if (mentions) badge.pill = mentions;
  else if (unread) badge.count = unread;
  badge.bold = unread > 0;
  return badge;
}

// A workspace's totals from its rooms: { attention, unread }, attention capped at 100 and unread saying whether any
// room that isn't muted has unread messages.
export function totals(rooms) {
  let sum = 0;
  let unread = false;
  for (const r of rooms || []) {
    sum += attention(r);
    if (r && !r.muted && r.unread > 0) unread = true;
  }
  return { attention: Math.min(100, sum), unread };
}

// The Chat mode segment's badge from ChatState's attention and unread: { count, text } for the count pill (99+ above
// 99), { dot: true } when only something is unread, or null.
export function modeBadge({ attention: n = 0, unread = false } = {}) {
  if (n > 0) return { count: n, text: n > 99 ? '99+' : String(n) };
  return unread ? { dot: true } : null;
}

// Whether you may remove a message (an event or a timeline row): your own, anywhere, or any in a channel you
// manage. Never a pending send or one already removed.
export function canRemove(event, me, room) {
  if (!event) return false;
  const message = event.kind ? event.kind === 'message.posted' : event.type === 'msg' || event.type === 'reply';
  if (!message || event.redacted || event.removed || event.pending || event.seq == null) return false;
  if (me && event.actor === me) return true;
  return Boolean(room && room.kind === 'channel' && room.role === 'manager');
}

// ---------- leaving as the last owner or the only manager (desktop-ui 6.9, 6.10) ----------

// A successor list gets a search field once it holds more people than this.
export const SUCCESSOR_SEARCH_FROM = 6;

// Whether you are the workspace's only owner, as far as the directory knows: an owner with no other active owner in
// a complete directory (membersMore false). Leaving then can't work (409 last_owner), so the app says so first.
export function onlyOwner(myRole, me, members, membersMore = false) {
  if (myRole !== 'owner' || membersMore) return false;
  return ![...asMap(members).values()].some((m) => m.id !== me && m.state === 'active' && m.role === 'owner');
}

// The channels that may need a successor before you leave: open channels you manage with other people in them.
export function sharedManaged(rooms) {
  return [...(rooms || [])].filter((r) => r.kind === 'channel' && !r.archived && r.role === 'manager' && r.members > 1);
}

// Whether you are the only manager among a channel's members ([{ member, role }]) while others are in it.
export function soleManager(roomMembers, me) {
  const list = roomMembers || [];
  return list.some((m) => m.member !== me) && !list.some((m) => m.member !== me && m.role === 'manager');
}

// Who can take a channel over: its active full members other than you, by name. ids: the channel's member IDs.
export function successors(ids, members, me, collator, t) {
  const map = asMap(members);
  return [...new Set(ids || [])]
    .filter((id) => id !== me && map.get(id)?.state === 'active' && map.get(id)?.role !== 'guest')
    .sort((a, b) => collator.compare(displayName(map.get(a), t), displayName(map.get(b), t)));
}

// Whether every channel of a hand-over ([{ id, people }]) has a successor picked from its own people. picks: Map or
// object of channel ID to member ID.
export function handOverReady(channels, picks) {
  const pick = (id) => (picks instanceof Map ? picks.get(id) : picks?.[id]);
  return channels.length > 0 && channels.every((c) => Array.isArray(c.people) && c.people.includes(pick(c.id)));
}

// ---------- closed conversations and the people pickers (contract 3.12) ----------

// What a closed DM's bar says and offers, or null when the room isn't a closed DM: { key, blocked, startNew }. key is
// the catalog key after chat.input.: closedYouBlocked when you blocked someone in it (blocked: the first of them by
// name), else the reason's own line. startNew: a full member may start a new conversation with the same people only
// when every other one is an active full member nobody here blocked, because the server refuses anything else. A
// block from the other side keeps the neutral line, since the client doesn't know about blocks it didn't make.
export function closedBar(room, { me = null, members, blocks, full = true, collator = new Intl.Collator(undefined, { sensitivity: 'base' }), t } = {}) {
  if (!room || room.kind !== 'dm' || !room.closedReason) return null;
  const map = asMap(members);
  const mine = blocks instanceof Set ? blocks : new Set(blocks || []);
  const others = [...new Set(room.participants || [])].filter((id) => id !== me);
  const blocked = others.filter((id) => mine.has(id)).sort((a, b) => collator.compare(displayName(map.get(a), t), displayName(map.get(b), t)))[0] || null;
  const key = blocked ? 'closedYouBlocked' : room.closedReason === 'left' ? 'closedLeft' : room.closedReason === 'ineligible' ? 'closedIneligible' : 'closedBlocked';
  const startNew =
    Boolean(full) &&
    others.length > 0 &&
    others.every((id) => {
      const m = map.get(id);
      return m && m.state === 'active' && m.role !== 'guest' && !mine.has(id);
    });
  return { key, blocked, startNew };
}

// New message's list (desktop-ui 6.11): { pick, blocked, guests, empty }. people: the directory in the order to show.
// pick: active full members you can message that fit the search and aren't picked yet. blocked: people you blocked,
// shown switched off with Unblock. guests: shown switched off with the reason, while searching or when nobody else
// would show. empty: 'none' for a search that finds nobody, 'nobody' when nobody else is in the workspace (as far as
// a complete directory says), else null. matches(member) says whether a member fits the query.
export function dmPicker(people, { me = null, blocks, picked = [], query = '', matches = () => true, membersMore = false } = {}) {
  const mine = blocks instanceof Set ? blocks : new Set(blocks || []);
  const others = (people || []).filter((m) => m && m.id !== me && m.state === 'active');
  const searching = Boolean(String(query || '').trim());
  const fits = (m) => !searching || matches(m);
  const full = others.filter((m) => m.role !== 'guest');
  const pick = full.filter((m) => !mine.has(m.id) && !picked.includes(m.id) && fits(m));
  const blocked = full.filter((m) => mine.has(m.id) && fits(m));
  const showGuests = searching || !full.length;
  const guests = showGuests ? others.filter((m) => m.role === 'guest' && fits(m)) : [];
  let empty = null;
  if (!pick.length && !blocked.length && !guests.length) {
    if (searching) empty = 'none';
    else if (!others.length) empty = membersMore ? 'none' : 'nobody';
  }
  return { pick, blocked, guests, empty };
}

// What Add people says when its list is empty, or null while it has rows: 'none' after a search, 'nobody' when the
// workspace has nobody else, 'everyone' when everyone else is in the channel already.
export function addPeopleEmpty({ rows = 0, candidates = 0, others = 0, query = '' } = {}) {
  if (rows > 0) return null;
  if (String(query || '').trim() && candidates > 0) return 'none';
  return others > 0 ? 'everyone' : 'nobody';
}
