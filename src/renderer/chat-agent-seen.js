// When each agent's runner last reached the server (AgentOut.lastSeen, server/WORKSPACES.md "Agents"), per workspace:
// for the mention list, a channel's Members and the toast after a mention of an agent that never connected. The
// server writes lastSeen once a minute at most, and only full members can read it (GET /agents). Callers ask only for
// a full member and read it only while the person is one: a guest sees none of it, cached or not, and forgetSeen()
// drops what a person who became a guest, or signed out, had, along with any answer still on its way. The Agents
// dialog's list fills it too.
import { api } from './ui.js';

// How old an answer may be before the next look asks again: the mention list opens often. A Members dialog asks
// every time it opens, since someone who just started a runner looks there.
const FRESH = 30000;
// How long a Members dialog waits for an answer before it draws without one.
const WAIT = 1500;

// ws → { at, seen: Map(agent id → lastSeen or null), loading: { n, promise } or null, failedAt, stored }. stored: the
// number of the request whose answer seen holds, so an answer to an older request never replaces a newer one. An entry
// that forgetSeen() dropped takes no answer any more: a request keeps the entry it started on and checks it is still
// the one there.
const byWs = new Map();
let requests = 0;

const entryOf = (ws) => {
  let entry = byWs.get(ws);
  if (!entry) {
    entry = { at: 0, seen: new Map(), loading: null, failedAt: 0, stored: 0 };
    byWs.set(ws, entry);
  }
  return entry;
};
const seenMap = (agents) => new Map(agents.filter((a) => a && a.id).map((a) => [a.id, Number.isFinite(a.lastSeen) ? a.lastSeen : null]));

// What the server said of an agent: a time, null for never, or undefined when it isn't known.
export function seenOf(ws, id) {
  const entry = byWs.get(ws);
  return entry && entry.seen.has(id) ? entry.seen.get(id) : undefined;
}

// Keeps the agents of a GET /agents answer the Agents dialog got.
export function rememberAgents(ws, agents, at = Date.now()) {
  if (!ws || !Array.isArray(agents)) return;
  const entry = entryOf(ws);
  Object.assign(entry, { at, seen: seenMap(agents), failedAt: 0, stored: ++requests });
}

// Whether a look should ask the server: no answer younger than maxAge, and no failed ask that recent either, so a
// server that refuses isn't asked at every key press.
export function needsAsk(ws, maxAge = FRESH) {
  const entry = byWs.get(ws);
  if (!entry) return true;
  const now = Date.now();
  return !(entry.at && now - entry.at < maxAge) && !(entry.failedAt && now - entry.failedAt < maxAge) && !entry.loading;
}

// Asks the server, one request per workspace at a time: the Map of a successful answer, or null when it failed or
// forgetSeen() dropped the workspace meanwhile. Never an older answer: what a caller does with it is what the server
// says now. fresh: a request of its own, started now, rather than one already on its way, for a caller that must know
// the state after something happened, such as the server taking a message.
export function refreshSeen(ws, { fresh = false } = {}) {
  const entry = entryOf(ws);
  if (entry.loading && !fresh) return entry.loading.promise;
  const n = ++requests;
  const current = () => byWs.get(ws) === entry;
  const done = () => {
    if (entry.loading && entry.loading.n === n) entry.loading = null;
  };
  const promise = api('chatAgents', ws).then(
    (res) => {
      done();
      if (!current()) return null;
      const seen = seenMap((res && res.agents) || []);
      if (n > entry.stored) Object.assign(entry, { at: Date.now(), seen, failedAt: 0, stored: n });
      return seen;
    },
    () => {
      done();
      if (current() && n > entry.stored) entry.failedAt = Date.now();
      return null;
    }
  );
  entry.loading = { n, promise };
  return promise;
}

// For a Members dialog: asks again when the answer is older than maxAge, and waits at most WAIT for it; an answer that
// comes later is kept for the next draw.
export function loadSeen(ws, { maxAge = FRESH } = {}) {
  const entry = byWs.get(ws);
  if (entry && entry.at && Date.now() - entry.at < maxAge) return Promise.resolve(entry.seen);
  return Promise.race([refreshSeen(ws), new Promise((resolve) => setTimeout(() => resolve(null), WAIT))]);
}

// Drops what is known of ws, or of every workspace, and the answers still on their way for it.
export function forgetSeen(ws) {
  if (ws === undefined) byWs.clear();
  else byWs.delete(ws);
}
