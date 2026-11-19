'use strict';

// Alerts for direct messages and mentions, and taking them back (team chat contract 3.10). The sync engine (sync.js)
// calls afterRun at the end of each run and onRemoved and onEvicted after the pages that removed messages or rooms;
// the service (index.js) calls onWorkspaceGone and clear; the history module calls onRead after this device read a
// room further. Alerts go to main.js through svc.show({ id, title, body, open }) and come back through svc.hide(id),
// which main.js turns into desktop notifications, or a toast while the main window has focus.
//
// The rule. After each run, also the first after the app starts, a room is due when its head is above notified (the
// highest seq an alert covered) and it asks for attention: a DM with unread messages, a channel with mentions. A due
// room alerts when chat notifications are on, it isn't muted and it isn't on screen in the focused window. The pass
// that first fills a workspace sets notified to head for every room (sync.js installPass), so it alerts nothing.
//
// What an alert shows. Title: #channel, or the DM's people as the sidebar names them, with the workspace's name after
// it when there are several workspaces. Body: up to three of the newest messages after max(read, notified), one line
// each as "Name: text", the first 120 characters with mentions as @Name. For a channel those are the messages that
// mention the person; for a DM every message of someone else. Removed messages and messages of people the person
// blocked are left out. The cache gives them when it covers that range; else events?before=<head + 1>&limit=20 loads
// them, for at most three rooms per run. Three rooms alert per run, newest first; a fourth or more make one summary,
// "New messages in N conversations", N being the rooms the summary stands for.
//
// After an alert, notified = head and a notice row for each message shown, so a read or a removal can take it back.
// main.js turns the alert into a toast while the main window has focus. This module records every alert the same
// way, because only main.js knows which it became: taking back a toast closes nothing.
//
// Decisions where the contract is silent:
// - A due room the person silenced (notifications off, muted, on screen) gets notified = head too, so turning
//   notifications on or unmuting doesn't bring back alerts for messages from while it was silent.
// - A due room whose new messages hold nothing to show (a channel with only an older mention) gets notified = head
//   without an alert, but only when the cache or the loaded page saw every event after max(read, notified). That holds
//   for the rooms beyond three too: the cache settles them when it can, and the rest go into the summary.
// - A due room the cache can't settle and whose page of 20 holds nothing to show but doesn't reach back that far, such
//   as a mention followed by 20 or more messages while Rukoo was closed, goes into the summary: something new may be
//   in the part the page didn't reach. One whose messages couldn't be loaded stays due for the next run.
// - Alert ids are stable: chat:<ws>:<room> for a room, chat:<ws>:summary for a workspace's summary.
const wire = require('./wire');
const { t, getLocale } = require('../../i18n');

const BODY_CHARS = 120;
const LINES = 3;
const FETCH = 20;

const roomKey = (ws, room) => `chat:${ws}:${room}`;
const summaryKey = (ws) => `chat:${ws}:summary`;

// Due rooms of a workspace, the most recent activity first.
const DUE = `SELECT * FROM room WHERE ws = ? AND head > notified
               AND ((kind = 'dm' AND unread > 0) OR (kind <> 'dm' AND mentions > 0))
             ORDER BY COALESCE(lastAt, 0) DESC, head DESC, id`;

const isDue = (room) => room.head > room.notified && (room.kind === 'dm' ? room.unread > 0 : room.mentions > 0);
// Read on this device or another one to the alert's position or beyond.
const readTo = (room) => Math.max(room.read, room.readLocal) >= room.notified;

function parseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

// A member's name as the log shows it: "Deleted member" for an erased account, "Former member" for one this device
// doesn't know.
function displayName(member) {
  if (!member) return t('chat.log.formerMember');
  if (member.state === 'deleted') return t('chat.log.deletedMember');
  return String(member.name || '').trim() || t('chat.log.formerMember');
}

// A message's text as one line of an alert: each mention as the text its author sent, with @ before it when it lacks
// one; white space folded; the first 120 characters. A range that breaks the rules of contract 3.17 stays plain.
function alertText(text, mentions) {
  let out = String(text || '');
  if (Array.isArray(mentions) && mentions.length && !wire.mentionRule(out, mentions)) {
    const bytes = Buffer.from(out, 'utf8');
    let at = 0;
    let built = '';
    for (const m of mentions) {
      built += bytes.subarray(at, m.start).toString('utf8');
      const part = bytes.subarray(m.start, m.end).toString('utf8');
      built += part.startsWith('@') ? part : `@${part}`;
      at = m.end;
    }
    out = built + bytes.subarray(at).toString('utf8');
  }
  out = out.replace(/\s+/g, ' ').trim();
  const chars = Array.from(out);
  return chars.length > BODY_CHARS ? `${chars.slice(0, BODY_CHARS).join('').trimEnd()}…` : out;
}

class Notifier {
  // Notifications have no IPC methods of their own.
  static METHODS = {};

  constructor(svc) {
    this.svc = svc;
    // The alerts on screen, by id: { ws, room, messages: Set } for a room's, { ws, rooms: Set } for a summary.
    this.shown = new Map();
  }

  // ---- hooks ----

  // At the end of a run: alerts the rooms read elsewhere took back go, then the due rooms alert. changedIds and pass
  // aren't needed: every room of the workspace is checked, so a room whose messages couldn't load gets its turn in the
  // next run, and the first pass already counts as notified.
  async afterRun(ws) {
    const svc = this.svc;
    const store = svc.store;
    const row = store && store.getWs(ws);
    if (!row) return;
    const epoch = svc.epoch;
    this.takeBackRead(ws);
    if (row.state !== 'ok' || row.fresh || !row.me) return;
    const due = store.all(DUE, ws);
    if (!due.length) return;
    const on = svc.settings().chatNotifications !== false;
    const ctx = this.context(ws, row);
    let slots = svc.timing.notifyRooms;
    let fetches = svc.timing.notifyRooms;
    const rest = [];
    for (const { id } of due) {
      svc.guard(epoch);
      let room = store.getRoom(ws, id);
      if (!room || !isDue(room)) continue;
      if (!on || room.muted || svc.isOnScreen(ws, id)) {
        this.mark(ws, id, room.head);
        continue;
      }
      const after = Math.max(room.read, room.readLocal, room.notified);
      // The cache first, also for the rooms beyond three: one it shows to hold nothing new to show isn't due.
      let messages = this.cachedMessages(ws, room, after, ctx);
      if (messages !== null && !messages.length) {
        this.mark(ws, id, room.head);
        continue;
      }
      if (slots <= 0) {
        rest.push(room);
        continue;
      }
      if (messages === null) {
        if (fetches <= 0) {
          rest.push(room);
          continue;
        }
        fetches -= 1;
        try {
          messages = await this.fetchMessages(ws, room, after, ctx);
        } catch (err) {
          if (svc.isStale(err)) throw err;
          // Not now: the room stays due for the next run.
          continue;
        }
        svc.guard(epoch);
        // Meanwhile the person may have read it, muted it or opened it.
        room = store.getRoom(ws, id);
        if (!room || !isDue(room)) continue;
        if (room.muted || svc.isOnScreen(ws, id) || svc.settings().chatNotifications === false) {
          this.mark(ws, id, room.head);
          continue;
        }
        // The page didn't reach back to after + 1 and showed nothing: what's new may be older than the page.
        if (messages === null) {
          rest.push(room);
          continue;
        }
        if (!messages.length) {
          this.mark(ws, id, room.head);
          continue;
        }
      }
      this.alert(ws, room, messages, ctx);
      slots -= 1;
    }
    if (rest.length) this.summarize(ws, rest, ctx);
  }

  // This device read the room further: its alert goes once the read reaches what the alert covered.
  onRead(ws, room) {
    const store = this.svc.store;
    const row = store && store.getRoom(ws, room);
    if (!row || readTo(row)) this.takeBack(ws, room);
  }

  // Messages of the room were removed (removed, removedMore, a floor): an alert that showed one of them goes.
  onRemoved(ws, room, ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    const store = this.svc.store;
    const entry = this.shown.get(roomKey(ws, room));
    const noticed = new Set(store ? store.noticesForRoom(ws, room).map((n) => n.message) : []);
    if (ids.some((id) => noticed.has(id) || (entry && entry.messages && entry.messages.has(id)))) this.takeBack(ws, room);
  }

  // The person lost the room: its alert goes. Its notice rows went with the room.
  onEvicted(ws, room) {
    this.takeBack(ws, room);
  }

  // The person lost the workspace: every alert of it goes.
  onWorkspaceGone(ws) {
    for (const [id, entry] of [...this.shown]) {
      if (entry.ws !== ws) continue;
      this.shown.delete(id);
      this.svc.hide(id);
    }
  }

  // The session ended: every alert goes. The cache with its notice rows is deleted by the service.
  clear() {
    const ids = [...this.shown.keys()];
    this.shown.clear();
    for (const id of ids) this.svc.hide(id);
  }

  // ---- alerts ----

  // What every alert of a run needs: who I am, the directory, my blocks, and the workspace's name when there are
  // several.
  context(ws, row) {
    const store = this.svc.store;
    return {
      me: row.me,
      members: new Map(store.listMembers(ws).map((m) => [m.id, m])),
      blocked: new Set(store.listBlocks(ws).map((b) => b.member)),
      suffix: store.listWs().length > 1 ? row.name : null
    };
  }

  // Whether a message is worth showing in the room's alert.
  qualifies(message, room, ctx) {
    if (message.actor === ctx.me || ctx.blocked.has(message.actor)) return false;
    if (typeof message.text !== 'string' || !message.text) return false;
    if (room.kind === 'dm') return true;
    return Array.isArray(message.mentions) && message.mentions.some((m) => m && m.actor === ctx.me);
  }

  // The messages to show from the cache: up to three of the newest after `after`; [] when it holds every event after
  // `after` that still exists and none to show; null when it can't tell, because it doesn't reach head, or doesn't
  // reach back to after + 1 (or the floor) and holds none to show.
  cachedMessages(ws, room, after, ctx) {
    if (room.hi === null || room.hi === undefined || room.hi < room.head) return null;
    const rows = this.svc.store
      .all(
        `SELECT id, seq, actor, text, mentions FROM event
         WHERE ws = ? AND room = ? AND seq > ? AND seq <= ? AND kind = 'message.posted' AND redacted = 0 AND text IS NOT NULL
         ORDER BY seq`,
        ws,
        room.id,
        after,
        room.head
      )
      .map((r) => ({ ...r, mentions: parseJson(r.mentions, []) }))
      .filter((m) => this.qualifies(m, room, ctx));
    if (rows.length) return rows.slice(-LINES);
    // Events below the floor are gone, so a range that starts at the floor holds all there is.
    return room.lo !== null && room.lo <= Math.max(after + 1, room.floor || 0) ? [] : null;
  }

  // The messages to show from the server's newest events, which this module doesn't keep: the history module owns the
  // room's cached range. Like cachedMessages, [] only when the page saw every event after `after`: it held the oldest
  // there are (more: false) or reached back to after + 1. A full page of other events that stops short of that gives
  // null, because what's new may be older than the page.
  async fetchMessages(ws, room, after, ctx) {
    const svc = this.svc;
    const page = wire.checkEvents(await svc.call(ws, 'GET', `/conversations/${room.id}/events?before=${room.head + 1}&limit=${FETCH}`));
    const store = svc.store;
    const shown = page.events
      .filter((e) => e.kind === 'message.posted' && !e.redacted && e.seq > after && e.seq <= room.head && !store.hasTombstone(ws, e.id))
      .filter((e) => this.qualifies(e, room, ctx))
      .slice(-LINES);
    if (shown.length) return shown;
    const reached = !page.more || (page.events.length > 0 && page.events[0].seq <= after + 1);
    return reached ? [] : null;
  }

  // The room's name in an alert.
  title(room, ctx) {
    let title;
    if (room.kind === 'dm') {
      const others = [...new Set(parseJson(room.participants, []))].filter((id) => id !== ctx.me);
      const names = others.map((id) => displayName(ctx.members.get(id)));
      if (!names.length) title = displayName(ctx.members.get(ctx.me));
      else if (names.length === 1) title = names[0];
      else if (names.length <= 3) title = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(names);
      else title = `${names.slice(0, 2).join(', ')}${t('reader.recipients.others', { count: names.length - 2 })}`;
    } else {
      title = `#${room.name}`;
    }
    return ctx.suffix ? `${title} · ${ctx.suffix}` : title;
  }

  line(message, ctx) {
    return t('chat.notify.body', { name: displayName(ctx.members.get(message.actor)), text: alertText(message.text, message.mentions) });
  }

  mark(ws, room, head) {
    this.svc.store.run('UPDATE room SET notified = MAX(notified, ?) WHERE ws = ? AND id = ?', head, ws, room);
  }

  // One room's alert, which replaces the one it had. It's recorded even when main.js shows it as a toast, which it
  // decides by the window's focus at that moment: hiding a toast closes nothing.
  alert(ws, room, messages, ctx) {
    const svc = this.svc;
    const store = svc.store;
    const id = roomKey(ws, room.id);
    const newest = messages[messages.length - 1];
    store.tx(() => {
      this.mark(ws, room.id, room.head);
      store.deleteNotices(ws, room.id);
      store.addNotices(
        ws,
        room.id,
        messages.map((m) => ({ message: m.id, seq: m.seq }))
      );
    });
    this.shown.set(id, { ws, room: room.id, messages: new Set(messages.map((m) => m.id)) });
    svc.show({
      id,
      title: this.title(room, ctx),
      body: messages.map((m) => this.line(m, ctx)).join('\n'),
      open: { ws, conversation: room.id, seq: newest.seq }
    });
  }

  // The rooms beyond three: one alert for the workspace, which counts the rooms it stands for.
  summarize(ws, rooms, ctx) {
    const svc = this.svc;
    const id = summaryKey(ws);
    svc.store.tx(() => {
      for (const room of rooms) this.mark(ws, room.id, room.head);
    });
    const before = this.shown.get(id);
    const set = new Set(before ? before.rooms : []);
    for (const room of rooms) set.add(room.id);
    this.shown.set(id, { ws, rooms: set });
    const title = t('chat.notify.summaryTitle');
    svc.show({
      id,
      title: ctx.suffix ? `${title} · ${ctx.suffix}` : title,
      body: t('chat.notify.summaryBody', { count: set.size }),
      open: { ws, conversation: rooms[0].id, seq: rooms[0].head }
    });
  }

  // ---- taking back ----

  // The room's alert goes, with its notice rows, and the room leaves the workspace's summary, which goes once it
  // stands for no room.
  takeBack(ws, room) {
    const svc = this.svc;
    const store = svc.store;
    const id = roomKey(ws, room);
    let had = this.shown.delete(id);
    if (store && store.getRoom(ws, room) && store.deleteNotices(ws, room).length) had = true;
    if (had) svc.hide(id);
    const sid = summaryKey(ws);
    const summary = this.shown.get(sid);
    if (summary && summary.rooms.delete(room) && summary.rooms.size === 0) {
      this.shown.delete(sid);
      svc.hide(sid);
    }
  }

  // After a run: the rooms with an alert that were read to it, here or on another device, or are gone.
  takeBackRead(ws) {
    const store = this.svc.store;
    const rooms = new Set(store.all('SELECT DISTINCT room FROM notice WHERE ws = ?', ws).map((r) => r.room));
    for (const entry of this.shown.values()) {
      if (entry.ws !== ws) continue;
      if (entry.room) rooms.add(entry.room);
      if (entry.rooms) for (const room of entry.rooms) rooms.add(room);
    }
    for (const room of rooms) {
      const row = store.getRoom(ws, room);
      if (!row || readTo(row)) this.takeBack(ws, room);
    }
  }
}

module.exports = { Notifier, alertText };
