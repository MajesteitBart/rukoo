// Team chat as rows and labels: the timeline of a conversation or a thread, the sidebar's order and badges, the
// titles of direct messages and the names of members. Pure: no DOM and no window.mail, so the node tests can load
// it (test/chat-model.test.js). chat-view.js draws what this returns, and the text functions it takes (t, a collator,
// a list format) come from the caller, so the language is the caller's.

import { mentionsMember, validMentions } from './chat-text.js';
import { plainText } from './chat-markdown.js';

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

// The part of a member a row's look depends on, for its sig: an agent's row has the Agent tag.
const memberSig = (m) => (m ? `${m.name ?? ''}\u0001${m.state ?? ''}\u0001${m.role ?? ''}\u0001${m.kind === 'agent' ? 'agent' : ''}` : '');

const listOf = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

// What a row's files, cards and reactions look like, for its sig: who reacted shows by name in the tooltips, so a
// name that changes draws the row again.
function richSig(attachments, previews, reactions, members) {
  if (!attachments.length && !previews.length && !reactions.length) return '';
  const files = attachments.map((f) => [f.id, f.name, f.type, f.size, f.width ?? '', f.height ?? ''].join(':')).join(' ');
  const cards = previews.map((p) => [p.url, p.title, p.description, p.site, p.image ? p.image.id : '', p.video ? 1 : 0].join(':')).join(' ');
  const reacts = reactions.map((r) => `${r.emoji}=${actorIds(r.actors).map((a) => `${a}/${members.get(a)?.name ?? ''}`).join(',')}`).join(' ');
  return [files, cards, reacts].join('\u0002');
}
const actorIds = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// The start of a message on one line, for the context line of a reply: its text without Markdown markers (RUK-211
// contract 3.7).
function snippet(text, mentions) {
  let plain;
  try {
    plain = plainText(String(text || ''), mentions || []);
  } catch (_) {
    plain = String(text || '');
  }
  const chars = [...plain.replace(/\s+/g, ' ').trim()];
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
// member IDs you blocked), intro (passed through to the intro row: { actor, at, people }, where actor made the
// conversation and people are the member IDs it names besides), groupMs, now, and sentLocal (Map messageId ->
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
    if (!(floor > 1)) {
      // The intro names who made the conversation and who is in a DM: like a system row, it draws again when the
      // directory brings or changes their names.
      const people = intro ? [intro.actor, ...(Array.isArray(intro.people) ? intro.people : [])].filter(Boolean) : [];
      const sig = ['intro', JSON.stringify(intro ?? null), ...people.map((id) => memberSig(members.get(id)))].join('\u0001');
      rows.push({ type: 'intro', key: 'intro', intro, sig });
    }
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
    // Files, link cards and reactions (contract 2.2, 3.1): a pending send carries its files; a removed message none.
    const attachments = removed ? [] : listOf(item.attachments);
    const previews = removed || isPending ? [] : listOf(item.previews);
    const reactions = removed || isPending ? [] : listOf(item.reactions);
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
      attachments,
      previews,
      reactions,
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
      else row.context = { state: 'ok', root: threadOf, actor: top.actor, author: members.get(top.actor) || null, text: snippet(top.text, top.mentions), files: listOf(top.attachments).length };
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
      c ? [c.state, c.text ?? '', c.files ?? 0, memberSig(c.author)].join(',') : '',
      richSig(attachments, previews, reactions, members)
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

// The tag after a member's name, or null: Former member for someone who left or was removed, Agent for an agent, Guest
// for a guest. A deleted member has none, because their name is the tag already.
export function memberTag(member, t) {
  if (!member || member.state === 'deleted') return null;
  if (member.state === 'left' || member.state === 'removed') return t('chat.log.formerMember');
  if (isAgent(member)) return t('chat.roles.agent');
  if (member.role === 'guest') return t('chat.roles.guest');
  return null;
}

// ---------- agents in channels (server/WORKSPACES.md "Agents") ----------

// Whether a member is an agent: a bot account a full member made, run by its own runtime. On the wire its role is
// member and its kind agent.
export const isAgent = (member) => Boolean(member) && member.kind === 'agent';
// A person: someone who isn't an agent. A kind this version doesn't know counts as a person.
export const isPerson = (member) => Boolean(member) && member.kind !== 'agent';

// The choices of whom an agent answers, in the order the form shows them.
export const AGENT_ANSWERS = ['everyone', 'sponsor', 'members'];
// The most people an agent answers besides its sponsor (the server's limit).
export const AGENT_CHOSEN_MAX = 50;

// Whether an agent answers a mention by viewer, by its settings (member.agent: { sponsor, answers, members, agents }):
// its sponsor always; everyone with 'everyone'; with 'members' the people it lists. An answers word this version
// doesn't know counts as not answering, as Android's AgentRules.answers takes it. An agent without settings (an older
// cache, until its directory loads again) counts as answering, since nothing says otherwise yet.
export function agentAnswers(agent, viewer) {
  const s = agent && agent.agent;
  if (!s) return true;
  if (viewer && s.sponsor === viewer) return true;
  if (s.answers === 'everyone') return true;
  if (s.answers === 'members') return Array.isArray(s.members) && s.members.includes(viewer);
  return false;
}

// Who an agent answers, as one line: "Answers everyone", "Answers only Olga", "Answers only Olga, Bart and Sanne",
// "Answers only Olga, Bart and 3 others". The sponsor comes first. Names come from members (Map or list). An answers
// word this version doesn't know reads as its sponsor only. Someone the directory doesn't hold isn't named: a guest's
// directory holds only the people in their channels, which can leave out the sponsor. With nobody left to name the
// line reads "Answers only the person who made it", never "Former member".
export function agentAnswersText(agent, { members, t, listFormat = new Intl.ListFormat(undefined, { type: 'conjunction' }) } = {}) {
  const s = agent && (agent.agent || agent);
  if (!s || !s.answers) return null;
  if (s.answers === 'everyone') return t('chat.agents.answersEveryone');
  const map = asMap(members);
  const chosen = s.answers === 'members' && Array.isArray(s.members) ? s.members : [];
  const ids = [s.sponsor, ...chosen].filter((id, i, all) => id && all.indexOf(id) === i && map.has(id));
  const names = ids.map((id) => displayName(map.get(id), t));
  if (!names.length) return t('chat.agents.answersSponsorGone');
  if (names.length <= 3) return t('chat.agents.answersOnly', { names: listFormat.format(names) });
  return t('chat.agents.answersMore', { names: names.slice(0, 2).join(', '), count: names.length - 2 });
}

// The line under an agent in Workspace members, a channel's members and the Agents dialog: "Made by Olga · Answers
// only Olga · Answers other agents", as Android's agentNote. Made by is left out when the directory doesn't hold the
// sponsor; whom it answers then says "the person who made it". agent: a directory member or an AgentOut.
export function agentNote(agent, opts = {}) {
  const s = agent && (agent.agent || (agent.answers ? agent : null));
  if (!s) return null;
  const { t } = opts;
  const sponsor = s.sponsor ? asMap(opts.members).get(s.sponsor) : null;
  const parts = [sponsor ? t('chat.agents.madeBy', { name: displayName(sponsor, t) }) : '', agentAnswersText(s, opts) || '', s.agents ? t('chat.agents.answersAgents') : ''];
  return parts.filter(Boolean).join(' · ') || null;
}

// Whom the form for a new or changed agent starts on: the agent's own choice when this version knows it, else Only
// me ('sponsor'), so nobody else's mention reaches a new agent until its sponsor says so. Android's AgentFormState
// starts the same way.
export function agentFormAnswers(agent = null) {
  return agent && AGENT_ANSWERS.includes(agent.answers) ? agent.answers : 'sponsor';
}

// Whether the form for an agent can be saved, as far as whom it answers goes: a known choice, and for Chosen people
// at least one person and at most the server's limit. Android's AgentRules.formReady holds the same rule.
export function agentFormReady({ answers, chosen = 0 } = {}) {
  if (!AGENT_ANSWERS.includes(answers)) return false;
  if (answers !== 'members') return true;
  return chosen > 0 && chosen <= AGENT_CHOSEN_MAX;
}

// The note a mention list shows beside an agent that won't answer viewer ("Answers only Olga"), or null when it will.
export function agentMentionNote(agent, viewer, opts = {}) {
  if (!isAgent(agent) || agentAnswers(agent, viewer)) return null;
  return agentAnswersText(agent, opts);
}

// Whether viewer may add an agent to a channel (room: the Room, as the feed gives it): the channel's managers may add
// any active agent; its sponsor may add it to a channel the workspace can see and the sponsor is in. Into a private
// channel an agent comes only while its sponsor is in it (the server's 409 sponsor_not_in_channel): inside holds the
// channel's member IDs (a Set or a list), and without it no agent is offered for a private channel. Never to an
// archived channel or a DM.
export function canAddAgent(agent, room, viewer, inside = null) {
  if (!isAgent(agent) || agent.state !== 'active' || !room || room.kind !== 'channel' || room.archived) return false;
  const sponsor = agent.agent?.sponsor ?? null;
  if (room.visibility !== 'workspace') {
    const ids = inside instanceof Set ? inside : new Set(inside || []);
    if (!sponsor || !ids.has(sponsor)) return false;
  }
  if (room.role === 'manager') return true;
  return Boolean(viewer) && sponsor === viewer && room.visibility === 'workspace';
}

// Whether viewer may take an agent out of a channel: the channel's managers, and its sponsor. Also out of an archived
// channel, whose history its key reads on until it leaves; the server allows it there (server/WORKSPACES.md "Channels").
export function canRemoveAgent(agent, room, viewer) {
  if (!isAgent(agent) || !room || room.kind !== 'channel') return false;
  return room.role === 'manager' || (Boolean(viewer) && agent.agent?.sponsor === viewer);
}

// Whether viewer may change an agent (rename it, change whom it answers, remove it): its sponsor, an owner or an admin.
export function canManageAgent(agent, viewer, myRole) {
  if (!agent) return false;
  return ['owner', 'admin'].includes(myRole) || (Boolean(viewer) && sponsorOf(agent) === viewer);
}

// Whether viewer may give an agent a new key: its sponsor alone. The key reads every channel the agent is in, private
// ones too, so an owner or admin outside such a channel gets 403 forbidden from the server.
export function canRenewAgentKey(agent, viewer) {
  return Boolean(agent) && Boolean(viewer) && sponsorOf(agent) === viewer;
}

// The sponsor of an agent, a directory member (member.agent) or an AgentOut.
const sponsorOf = (agent) => (agent.agent ? agent.agent.sponsor : agent.sponsor) ?? null;

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

// Whether you may remove a message (an event or a timeline row): your own, anywhere, any in a channel you manage, or
// one an agent you made wrote, also once the agent itself was removed (server/WORKSPACES.md "Agents"; members, a Map
// or list, is the directory that says so). Never a pending send or one already removed.
export function canRemove(event, me, room, members = null) {
  if (!event) return false;
  const message = event.kind ? event.kind === 'message.posted' : event.type === 'msg' || event.type === 'reply';
  if (!message || event.redacted || event.removed || event.pending || event.seq == null) return false;
  if (me && event.actor === me) return true;
  if (room && room.kind === 'channel' && room.role === 'manager') return true;
  return sponsorsAuthor(event, me, members);
}

// Whether the author of a message is an agent that me made: its sponsor may remove the message and its link cards.
export function sponsorsAuthor(event, me, members) {
  if (!event || !me || !members) return false;
  const author = asMap(members).get(event.actor);
  return isAgent(author) && author.agent?.sponsor === me;
}

// ---------- leaving as the last owner or the only manager (desktop-ui 6.9, 6.10) ----------

// A successor list gets a search field once it holds more people than this.
export const SUCCESSOR_SEARCH_FROM = 6;

// Whether you are the workspace's only owner, as far as the directory knows: an owner with no other active owner in
// a complete directory (membersMore false). Leaving then can't work (409 last_owner), so the app says so first. An
// empty directory hasn't loaded yet (a loaded one holds you): unknown, so the server's 409 decides.
export function onlyOwner(myRole, me, members, membersMore = false) {
  const map = asMap(members);
  if (myRole !== 'owner' || membersMore || !map.size) return false;
  return ![...map.values()].some((m) => m.id !== me && m.state === 'active' && m.role === 'owner');
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

// Whether leaving room may take agents of me's with it, so the confirmation needs the channel's members to say so: the
// directory holds an active agent me made, the channel may hold agents, and it is private or me is the last person in
// it. This follows the server's #endGrant (server/src/workspace.js): a private channel keeps someone's agents only
// while they are in it, archived or not, and the last person's leaving archives a channel of either kind and takes
// every agent out.
export function mayTakeAgents(room, members, me) {
  if (!room || room.kind !== 'channel' || !(room.visibility === 'private' || room.members <= 1)) return false;
  if (room.agents !== undefined && !(room.agents > 0)) return false;
  return [...asMap(members).values()].some((m) => isAgent(m) && m.state === 'active' && Boolean(me) && m.agent?.sponsor === me);
}

// The agents that leave room with me: the active agents me made among the channel's members ([{ member, role }]), by
// name. Empty for a channel leaving doesn't take agents out of; null when it may and the members didn't load.
// A channel everyone can see keeps its agents while another person is in it, and the room's own count can be older
// than that: the members just loaded decide, and so does others, for a caller that knows someone else is in it (the
// server asked for a successor).
export function agentsLeavingWith(room, roomMembers, members, me, collator, t, { others = false } = {}) {
  if (!mayTakeAgents(room, members, me)) return [];
  const open = room.visibility !== 'private';
  if (open && others) return [];
  if (!roomMembers) return null;
  const map = asMap(members);
  if (open && roomMembers.some((m) => m.member !== me && !isAgent(map.get(m.member)))) return [];
  return [...new Set(roomMembers.map((m) => m.member))]
    .map((id) => map.get(id))
    .filter((m) => isAgent(m) && m.state === 'active' && m.agent?.sponsor === me)
    .sort((a, b) => collator.compare(displayName(a, t), displayName(b, t)));
}

// The line a leave confirmation adds for agents: "Your agent Clark leaves with you.", up to three names, past that
// how many. Null for none. agents null means they didn't load: the line then says what holds without their names.
export function leavingAgentsText(agents, { t, listFormat = new Intl.ListFormat(undefined, { type: 'conjunction' }) } = {}) {
  if (agents === null) return t('chat.channel.leaveAgentsUnknown');
  if (!agents || !agents.length) return null;
  if (agents.length > 3) return t('chat.channel.leaveAgentsMany', { count: agents.length });
  if (agents.length === 1) return t('chat.channel.leaveAgent', { name: displayName(agents[0], t) });
  return t('chat.channel.leaveAgents', { names: listFormat.format(agents.map((m) => displayName(m, t))) });
}

// Who can take a channel over: its active full members other than you, by name. Never an agent. ids: the channel's
// member IDs.
export function successors(ids, members, me, collator, t) {
  const map = asMap(members);
  return [...new Set(ids || [])]
    .filter((id) => id !== me && map.get(id)?.state === 'active' && map.get(id)?.role !== 'guest' && !isAgent(map.get(id)))
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
// a complete directory says), else null. matches(member) says whether a member fits the query. Agents are never in a
// DM, so they don't show at all.
export function dmPicker(people, { me = null, blocks, picked = [], query = '', matches = () => true, membersMore = false } = {}) {
  const mine = blocks instanceof Set ? blocks : new Set(blocks || []);
  const others = (people || []).filter((m) => m && m.id !== me && m.state === 'active' && !isAgent(m));
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
// workspace has nobody else, 'everyone' when everyone else is in the channel already. agentsOnly: the person doesn't
// manage the channel and may add only their own agents (Add agents), so the list says 'agents', all of them are in
// already, and never speaks for the people.
export function addPeopleEmpty({ rows = 0, candidates = 0, others = 0, query = '', agentsOnly = false } = {}) {
  if (rows > 0) return null;
  if (String(query || '').trim() && candidates > 0) return 'none';
  if (agentsOnly) return 'agents';
  return others > 0 ? 'everyone' : 'nobody';
}

// The channels a new invitation link grants, for the line under the link: up to three names, then "and n more".
// names: channel names without the #.
export function inviteChannelList(names, t) {
  const tags = (names || []).map((n) => `#${n}`);
  if (tags.length <= 1) return tags[0] || '';
  if (tags.length <= 3) return t('chat.invite.listAnd', { list: tags.slice(0, -1).join(', '), last: tags[tags.length - 1] });
  return t('chat.invite.listMore', { list: tags.slice(0, 3).join(', '), count: tags.length - 3 });
}

// The line under a new invitation link: who can join, as what, into which channels, until when.
export function inviteGrant(role, names, date, t) {
  const channels = inviteChannelList(names, t);
  if (role === 'guest') return t('chat.invite.readyGuest', { channels, date });
  return channels ? t('chat.invite.readyMemberIn', { channels, date }) : t('chat.invite.readyMember', { date });
}

// The channels in an open invitation's row: up to two names, then "+n" for the rest. total: the invitation's
// channelCount, which also counts private channels whose names the viewer doesn't get. Without a name, the count.
export function inviteRowChannels(names, total, t) {
  const tags = (names || []).filter(Boolean).map((n) => `#${n}`);
  const count = Math.max(Number(total) || 0, tags.length);
  if (!tags.length) return t('chat.invite.channelCount', { count });
  const rest = count - Math.min(tags.length, 2);
  const shown = tags.slice(0, 2).join(', ');
  return rest > 0 ? t('chat.invite.namesMore', { names: shown, count: rest }) : shown;
}

// ---------- reactions, files and link cards (contract 3.1, 3.5, 3.6) ----------

// A message holds at most this many distinct emoji (contract 2.4).
export const REACTION_LIMIT = 20;

// reactions with actor's reaction on or off, as the cache applies reaction.added and reaction.removed (contract 3.1):
// added at the end of its emoji's group, which is made at the end when new; taken out, dropping a group that empties.
// Applying it twice changes nothing. Returns a new list.
export function applyReaction(reactions, emoji, actor, on) {
  const list = listOf(reactions).map((r) => ({ emoji: r.emoji, actors: actorIds(r.actors) }));
  const group = list.find((r) => r.emoji === emoji);
  if (on) {
    if (!group) list.push({ emoji, actors: [actor] });
    else if (!group.actors.includes(actor)) group.actors.push(actor);
    return list;
  }
  if (!group || !group.actors.includes(actor)) return list;
  group.actors = group.actors.filter((a) => a !== actor);
  return list.filter((r) => r.actors.length);
}

// Whether me reacted with emoji.
export const reacted = (reactions, emoji, me) => listOf(reactions).some((r) => r.emoji === emoji && actorIds(r.actors).includes(me));

// Who reacted, for a chip's tooltip: names in the order they reacted, "You" for you (t('chat.react.you')), at most max
// of them. Returns { names, more }: more is how many weren't named.
export function reactionNames(group, { me = null, members, t, max = 8 } = {}) {
  const map = asMap(members);
  const actors = actorIds(group && group.actors);
  const names = actors.slice(0, max).map((a) => (a === me ? t('chat.react.you') : displayName(map.get(a), t)));
  return { names, more: Math.max(0, actors.length - max) };
}

// The image types Chromium shows (contract 3.6): a file of one of these, with its width and height, shows as an image.
export const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
export const isImage = (f) => Boolean(f) && VIEWABLE.has(String(f.type || '').toLowerCase()) && f.width > 0 && f.height > 0;

// A message's files as the log shows them: { images, allImages, more, files }. images: up to four images for the grid,
// more: how many images that leaves out (the "+n" on the fourth), files: the rest as cards, in the order the post
// listed them.
export function fileLayout(attachments) {
  const list = listOf(attachments);
  const all = list.filter(isImage);
  return { images: all.slice(0, 4), allImages: all, more: Math.max(0, all.length - 4), files: list.filter((f) => !isImage(f)) };
}

// The box one image takes: its aspect ratio within max by maxH, never larger than the image itself.
export function fitBox(width, height, max = 360, maxH = 280) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!(w > 0 && h > 0)) return { width: max, height: Math.round((max * 3) / 4) };
  const scale = Math.min(1, max / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

// The kind of a file, for its card's icon: image, pdf, video, audio, archive, text, sheet, slides, doc or file.
export function fileKind(file) {
  const type = String((file && file.type) || '').toLowerCase();
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(String((file && file.name) || '')) || [])[1]?.toLowerCase() || '';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (/zip|x-7z|x-rar|x-tar|gzip/.test(type) || ['zip', '7z', 'rar', 'tar', 'gz', 'tgz'].includes(ext)) return 'archive';
  if (/spreadsheet|excel|csv/.test(type) || ['xls', 'xlsx', 'ods', 'csv', 'numbers'].includes(ext)) return 'sheet';
  if (/presentation|powerpoint/.test(type) || ['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'slides';
  if (/wordprocessing|msword|opendocument\.text|rtf/.test(type) || ['doc', 'docx', 'odt', 'rtf', 'pages'].includes(ext)) return 'doc';
  if (type.startsWith('text/') || ['txt', 'md', 'json', 'log'].includes(ext)) return 'text';
  return 'file';
}

// Where a link card's image goes: 'below' the text when the image is at least 400 pixels wide, else 'side'; 'none'
// without one.
export const cardImage = (preview) => (!preview || !preview.image ? 'none' : Number(preview.image.width) >= 400 ? 'below' : 'side');

// The composer's staged files (contract 3.5): { ready, busy, failed, ids, canSend }. ready: files uploaded, ids their
// file IDs; busy: still being measured or uploaded; failed: what failed. canSend says whether Send may be on with the
// text there is: some text or a ready file, and nothing busy or failed.
export function stagedState(staged, hasText) {
  const list = listOf(staged);
  const ready = list.filter((s) => s.state === 'ready' && s.file);
  const busy = list.filter((s) => s.state === 'measuring' || s.state === 'uploading');
  const failed = list.filter((s) => s.state === 'failed');
  return { ready, busy, failed, ids: ready.map((s) => s.file), canSend: (Boolean(hasText) || ready.length > 0) && !busy.length && !failed.length };
}

// A draft's files that still hold, and how many expired (contract 3.5): files whose expiresAt is past go.
export function draftFiles(files, now = Date.now()) {
  const list = listOf(files).filter((f) => typeof f.id === 'string');
  const kept = list.filter((f) => !(Number.isFinite(f.expiresAt) && f.expiresAt <= now));
  return { kept, expired: list.length - kept.length };
}

// Whether a message's More menu offers Message {author} (contract 5.2): someone else's message, by an active full
// member you haven't blocked, and you a full member yourself. Never an agent's: agents aren't in DMs.
export function canMessageAuthor(row, { me = null, myRole = 'member', members, blocks } = {}) {
  if (!row || !row.actor || row.actor === me || row.pending || myRole === 'guest') return false;
  const m = asMap(members).get(row.actor);
  const mine = blocks instanceof Set ? blocks : new Set(blocks || []);
  return Boolean(m) && m.state === 'active' && m.role !== 'guest' && !isAgent(m) && !mine.has(row.actor);
}

// Whether a message's More menu offers Block {author}: someone else's, by an active full member you haven't blocked
// yet. Never an agent: its sponsor or an admin removes it instead.
export function canBlockAuthor(row, { me = null, members, blocks } = {}) {
  if (!row || !row.actor || row.actor === me) return false;
  const m = asMap(members).get(row.actor);
  const mine = blocks instanceof Set ? blocks : new Set(blocks || []);
  return Boolean(m) && m.state === 'active' && m.role !== 'guest' && !isAgent(m) && !mine.has(row.actor);
}
