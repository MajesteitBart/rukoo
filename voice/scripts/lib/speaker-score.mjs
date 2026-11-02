// The speaker label scorer: how much of the transcript went to the right speaker. The same function as
// voice/crates/voice-meetings/tests/common/score.rs; both pass voice/fixtures/speaker-score-vectors.json.
//
// - Each passage's reference speaker is the one whose turns overlap it most (ties go to the name that sorts first);
//   a passage that overlaps no reference turn is left out.
// - Ids map to reference speakers one to one: for every id and reference speaker, the time of the id's passages whose
//   reference speaker that is; the largest pair first, ties by id and then by reference speaker.
// - Accuracy is the time of passages whose id maps to their reference speaker, over the time of all scored passages.
//   A passage without an id counts as wrong. A passage's time is its whole length.
//
// Spans are { start, end, speaker } in ms; a passage's speaker is its id (`call-2`) or null.

// Code-unit order, as Rust's string order for the ASCII names and ids used here.
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function assign(passages, reference) {
  const scored = [];
  for (const p of passages) {
    const overlap = new Map();
    for (const r of reference) {
      const shared = Math.min(p.end, r.end) - Math.max(p.start, r.start);
      if (shared > 0 && r.speaker != null) overlap.set(r.speaker, (overlap.get(r.speaker) || 0) + shared);
    }
    let best = null;
    for (const name of [...overlap.keys()].sort(byName)) {
      if (best === null || overlap.get(name) > overlap.get(best)) best = name;
    }
    if (best !== null) scored.push({ passage: p, name: best });
  }
  const matrix = new Map();
  for (const { passage, name } of scored) {
    if (passage.speaker == null) continue;
    const key = JSON.stringify([passage.speaker, name]);
    matrix.set(key, (matrix.get(key) || 0) + (passage.end - passage.start));
  }
  const pairs = [...matrix].map(([key, time]) => [...JSON.parse(key), time]);
  pairs.sort((a, b) => b[2] - a[2] || byName(a[0], b[0]) || byName(a[1], b[1]));
  const ids = new Set();
  const names = new Set();
  const mapping = new Map();
  for (const [id, name] of pairs) {
    if (ids.has(id) || names.has(name)) continue;
    ids.add(id);
    names.add(name);
    mapping.set(id, name);
  }
  return { scored, mapping };
}

/** The fraction of scored passage time whose id maps to its reference speaker; 1 when nothing is scored. */
export function accuracy(passages, reference) {
  const { scored, mapping } = assign(passages, reference);
  let total = 0;
  let right = 0;
  for (const { passage, name } of scored) {
    const time = passage.end - passage.start;
    total += time;
    if (passage.speaker != null && mapping.get(passage.speaker) === name) right += time;
  }
  return total === 0 ? 1 : right / total;
}

/** The reference speaker each id maps to, by the same rule as `accuracy`, as a plain object. */
export function mapping(passages, reference) {
  return Object.fromEntries(assign(passages, reference).mapping);
}
