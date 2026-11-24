// When each agent's runner last reached the server (AgentOut.lastSeen, server/WORKSPACES.md "Agents"), per workspace:
// for the mention list, a channel's Members and the toast after a mention of an agent that never connected. The
// server writes lastSeen once a minute at most, and only full members can read it (GET /agents), so for a guest it
// stays unknown and nothing shows. The Agents dialog's list fills it too.
import { api } from './ui.js';

// How old an answer may be before the next look asks again: the mention list opens often. A Members dialog asks
// every time it opens, since someone who just started a runner looks there.
const FRESH = 30000;
// How long a list waits for an answer before it draws without one.
const WAIT = 1500;

// ws → { at, seen: Map(agent id → lastSeen or null), loading }
const byWs = new Map();

// What the server said of an agent: a time, null for never, or undefined when it isn't known.
export function seenOf(ws, id) {
  const entry = byWs.get(ws);
  return entry && entry.seen.has(id) ? entry.seen.get(id) : undefined;
}

// Keeps the agents of a GET /agents answer (the Agents dialog's, or loadSeen's).
export function rememberAgents(ws, agents, at = Date.now()) {
  if (!ws || !Array.isArray(agents)) return;
  const seen = new Map(agents.filter((a) => a && a.id).map((a) => [a.id, Number.isFinite(a.lastSeen) ? a.lastSeen : null]));
  byWs.set(ws, { at, seen, loading: null });
}

// The workspace's agents' lastSeen, asked again when older than maxAge: a Map, or null when it can't be read. Never
// waits longer than WAIT; an answer that comes later is kept for the next look.
export function loadSeen(ws, { maxAge = FRESH } = {}) {
  const entry = byWs.get(ws);
  if (entry && entry.seen && Date.now() - entry.at < maxAge) return Promise.resolve(entry.seen);
  const loading =
    (entry && entry.loading) ||
    api('chatAgents', ws).then(
      (res) => {
        rememberAgents(ws, (res && res.agents) || []);
        return byWs.get(ws).seen;
      },
      () => {
        const now = byWs.get(ws);
        if (now) now.loading = null;
        return null;
      }
    );
  if (entry) entry.loading = loading;
  else byWs.set(ws, { at: 0, seen: new Map(), loading });
  return Promise.race([loading, new Promise((resolve) => setTimeout(() => resolve(byWs.get(ws)?.seen || null), WAIT))]);
}

