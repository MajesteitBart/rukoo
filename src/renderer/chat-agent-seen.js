// When each agent's runner last reached the server (AgentOut.lastSeen, server/WORKSPACES.md "Agents"), per workspace:
// for the mention list, a channel's Members and the toast after a mention of an agent that never connected. The
// server writes lastSeen once a minute at most, and only full members can read it (GET /agents). Callers ask only for
// a full member and read it only while the person is one: a guest sees none of it, cached or not, and forgetSeen()
// drops what a person who became a guest, or signed out, had. The Agents dialog's list fills it too.
import { api } from './ui.js';

// How old an answer may be before the next look asks again: the mention list opens often. A Members dialog asks
// every time it opens, since someone who just started a runner looks there.
const FRESH = 30000;
// How long a Members dialog waits for an answer before it draws without one.
const WAIT = 1500;

// ws → { at, seen: Map(agent id → lastSeen or null), loading, failedAt }
const byWs = new Map();

// What the server said of an agent: a time, null for never, or undefined when it isn't known.
export function seenOf(ws, id) {
  const entry = byWs.get(ws);
  return entry && entry.seen.has(id) ? entry.seen.get(id) : undefined;
}

// Keeps the agents of a GET /agents answer (the Agents dialog's, or refreshSeen's).
export function rememberAgents(ws, agents, at = Date.now()) {
  if (!ws || !Array.isArray(agents)) return;
  const seen = new Map(agents.filter((a) => a && a.id).map((a) => [a.id, Number.isFinite(a.lastSeen) ? a.lastSeen : null]));
  byWs.set(ws, { at, seen, loading: null, failedAt: 0 });
}

// Whether a look should ask the server: no answer younger than maxAge, and no failed ask that recent either, so a
// server that refuses isn't asked at every key press.
export function needsAsk(ws, maxAge = FRESH) {
  const entry = byWs.get(ws);
  if (!entry) return true;
  const now = Date.now();
  return !(entry.at && now - entry.at < maxAge) && !(entry.failedAt && now - entry.failedAt < maxAge) && !entry.loading;
}

// Asks the server now, one request per workspace at a time: the Map of a successful answer, or null when it failed.
// Never an older answer: what a caller does with it is what the server says now.
export function refreshSeen(ws) {
  const entry = byWs.get(ws);
  if (entry && entry.loading) return entry.loading;
  const loading = api('chatAgents', ws).then(
    (res) => {
      rememberAgents(ws, (res && res.agents) || []);
      return byWs.get(ws).seen;
    },
    () => {
      const now = byWs.get(ws);
      if (now && now.loading === loading) Object.assign(now, { loading: null, failedAt: Date.now() });
      return null;
    }
  );
  if (entry) entry.loading = loading;
  else byWs.set(ws, { at: 0, seen: new Map(), loading, failedAt: 0 });
  return loading;
}

// For a Members dialog: asks again when the answer is older than maxAge, and waits at most WAIT for it; an answer that
// comes later is kept for the next draw.
export function loadSeen(ws, { maxAge = FRESH } = {}) {
  const entry = byWs.get(ws);
  if (entry && entry.at && Date.now() - entry.at < maxAge) return Promise.resolve(entry.seen);
  return Promise.race([refreshSeen(ws), new Promise((resolve) => setTimeout(() => resolve(null), WAIT))]);
}

// Drops what is known of ws, or of every workspace.
export function forgetSeen(ws) {
  if (ws === undefined) byWs.clear();
  else byWs.delete(ws);
}
