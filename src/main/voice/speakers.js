'use strict';

// Turning "Speaker 1" into a name: which calendar event a meeting was, and which of its guests can be the voices on
// the call. Pure. Attendee names and addresses come from whoever sent the invitation, so the renderer shows them
// as text only and the agent gets them tagged.

const WINDOW_MS = 15 * 60 * 1000;
const RESPONSE_ORDER = { accepted: 0, tentative: 1, needsAction: 2 };

// The events a meeting that started at startedAt can be: timed, overlapping the start (give or take 15 minutes),
// not declined. Events with a video link and guests first, then the one that starts nearest.
function candidateEvents(events, startedAt) {
  if (!Number.isFinite(startedAt)) return [];
  const list = (Array.isArray(events) ? events : []).filter(
    (e) => e && !e.allDay && Number.isFinite(e.start) && Number.isFinite(e.end) && e.start <= startedAt + WINDOW_MS && e.end >= startedAt - WINDOW_MS && e.response !== 'declined' && e.status !== 'cancelled'
  );
  const call = (e) => (e.meeting && Array.isArray(e.attendees) && e.attendees.length ? 0 : 1);
  return list.sort((a, b) => call(a) - call(b) || Math.abs(a.start - startedAt) - Math.abs(b.start - startedAt));
}

// The guests who can be a voice on the call: not the user, not declined; accepted first, optional guests last.
function attendeeCandidates(event) {
  const people = Array.isArray(event && event.attendees) ? event.attendees : [];
  return people
    .filter((a) => a && !a.self && a.response !== 'declined' && (a.address || a.name))
    .map((a, i) => ({ name: String(a.name || a.address || ''), address: String(a.address || ''), response: a.response || 'needsAction', optional: Boolean(a.optional), i }))
    .sort((a, b) => Number(a.optional) - Number(b.optional) || (RESPONSE_ORDER[a.response] ?? 3) - (RESPONSE_ORDER[b.response] ?? 3) || a.i - b.i)
    .map(({ i, ...a }) => a);
}

// Per speaker, the names to offer. The microphone is the user. A name is only filled in by itself for a 1:1: one
// voice on the call and one guest who can be it. Returns {suggestions: {speakerId: [candidate]}, auto: {speakerId:
// candidate} | {}}.
function suggest(speakers, event) {
  const call = (Array.isArray(speakers) ? speakers : []).filter((s) => s.track === 'call');
  const candidates = event ? attendeeCandidates(event) : [];
  const suggestions = {};
  for (const s of call) suggestions[s.id] = candidates;
  const auto = call.length === 1 && candidates.length === 1 ? { [call[0].id]: candidates[0] } : {};
  return { suggestions, auto };
}

module.exports = { candidateEvents, attendeeCandidates, suggest, WINDOW_MS };
