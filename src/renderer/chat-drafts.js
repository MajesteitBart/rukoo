// Team chat's draft versions (contract 3.8, 3.19), one per workspace, room and thread, for every composer that writes
// that draft. A composer goes when its room or thread leaves the screen while a send it started is still in flight; the
// one mounted when it comes back writes the same draft. The send's answer is reconciled against the draft as it is now:
//
//   - taken: the draft it left behind goes, but only when nothing wrote the draft since the send. A newer draft stays.
//   - refused: the text comes back. A composer on screen for the draft puts it before what it holds; without one, it
//     goes before the draft written since the send, or becomes the draft when none was.
//
// A slot: { version, parts, pending, live }. version counts the writes, parts is the last one (the parts written, or null for
// none), pending how many sends of it wait for an answer, live the composer on screen for the draft:
// { takeBack(parts, ticket), dropSent(parts) }. A slot goes when no composer shows it and no send waits on it.

const slots = new Map();

export const draftSlotKey = (ws, c, root) => JSON.stringify([ws, c, root || null]);

function slot(key) {
  let s = slots.get(key);
  if (!s) {
    s = { version: 0, parts: null, pending: 0, live: null };
    slots.set(key, s);
  }
  return s;
}

// A composer for key came on screen; it takes over from the one before it.
export function attachDraft(key, composer) {
  slot(key).live = composer;
}

// The composer went. A slot nothing is waiting on any more can go too.
export function detachDraft(key, composer) {
  const s = slots.get(key);
  if (!s || s.live !== composer) return;
  s.live = null;
  if (!s.pending) slots.delete(key);
}

// The draft for key was written: parts, or null for no draft.
export function draftWritten(key, parts) {
  const s = slot(key);
  s.version += 1;
  s.parts = parts && parts.length ? parts : null;
  const version = s.version;
  if (!s.live && !s.pending) slots.delete(key);
  return version;
}

// A send of the draft for key started: what sendSettled() compares the draft with later. extra goes along in the
// ticket, for the composer that takes a refused text back.
export function sendStarted(key, extra = {}) {
  const s = slot(key);
  s.pending += 1;
  return { ...extra, key, version: s.version };
}

// A send's answer. ticket: from sendStarted(). ok: main took the message. sent: its parts. save(parts|null): writes the
// draft for the ticket's key.
export function sendSettled(ticket, ok, sent, save) {
  const s = slot(ticket.key);
  s.pending = Math.max(0, s.pending - 1);
  const unchanged = s.version === ticket.version;
  if (ok) {
    if (unchanged) {
      draftWritten(ticket.key, null);
      save(null);
      // A composer mounted meanwhile loaded the draft this send left behind: it goes from there too, unless edited.
      if (s.live) s.live.dropSent(sent);
    }
  } else if (s.live) s.live.takeBack(sent, ticket);
  else {
    const since = unchanged ? null : s.parts;
    const back = since ? [...sent, '\n', ...since] : sent;
    draftWritten(ticket.key, back);
    save(back);
  }
  if (!s.live && !s.pending) slots.delete(ticket.key);
}
