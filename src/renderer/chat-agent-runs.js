// The team chat agents this computer runs (src/main/agent-runs.js, "Run on this computer"): main's view of them, kept
// current from its 'agent-runs' events, for the key step, the Agents dialog and the toast after a mention. Never a key.
// Rukoo in a browser (src/web) runs no agents: there every answer here says nothing runs and nothing can.
import { api } from './ui.js';

const WEB = window.mail?.platform === 'web';

// { available, runs: [view] }, as agentRuns answers it.
let snap = { available: false, runs: [] };
// Events since the last agentRuns call went out: an answer that left before one is older than it.
let seq = 0;
const listeners = new Set();

function apply(next) {
  if (!next || typeof next !== 'object' || !Array.isArray(next.runs)) return;
  snap = next;
  for (const fn of [...listeners]) {
    try {
      fn(snap);
    } catch (_) {
      // One listener's error doesn't keep the others from hearing.
    }
  }
}

if (!WEB && typeof window.mail?.on === 'function') {
  window.mail.on(({ type, payload } = {}) => {
    if (type !== 'agent-runs') return;
    seq += 1;
    apply(payload);
  });
}

// main's view, asked again: a promise of { available, runs }.
export function loadRuns() {
  if (WEB) return Promise.resolve(snap);
  const at = seq;
  return api('agentRuns').then(
    (next) => {
      if (seq === at) apply(next);
      return snap;
    },
    () => snap
  );
}

export const runsNow = () => snap;

// The setup of an agent on this computer, or null.
export const runOf = (ws, agent) => snap.runs.find((r) => r.ws === ws && r.agent === agent) || null;

// fn(snapshot) after every change; answers the function that stops it.
export function onRuns(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Main says what runs when it starts, which can be before this window listens: asked once here.
if (!WEB) loadRuns();
