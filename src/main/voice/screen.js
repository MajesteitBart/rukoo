'use strict';

const MODES = new Set(['off', 'frames', 'video']);

// since is the earliest frame that can represent this stretch: an image from before an Off
// interval must not be reused after recording is enabled again.
function screenAt(meeting, marks = [], at = Infinity) {
  let screen = MODES.has(meeting.initialScreen) ? meeting.initialScreen : MODES.has(meeting.screen) ? meeting.screen : 'off';
  let since = 0;
  let until = Infinity;
  let framesDropped = false;
  let videoDropped = false;
  const changes = marks.filter((k) => (k.kind === 'screen_mode' && MODES.has(k.label)) || (k.track === 'screen' && ['dropped', 'video_dropped'].includes(k.kind)))
    .slice().sort((a, b) => a.at - b.at || (a.changed || 0) - (b.changed || 0));
  for (const mark of changes) {
    if (mark.at > at) { until = mark.at; break; }
    if (mark.kind === 'screen_mode') { screen = mark.label; since = mark.at; }
    else if (mark.kind === 'dropped') framesDropped = true;
    else videoDropped = true;
    if (framesDropped) screen = 'off';
    else if (videoDropped && screen === 'video') screen = 'frames';
  }
  return { screen, since, until };
}

function screenSpans(meeting, marks, start, end) {
  const spans = [];
  let at = start;
  while (at <= end) {
    const state = screenAt(meeting, marks, at);
    spans.push({ screen: state.screen, start: at, end: Math.min(end, state.until) });
    if (!Number.isFinite(state.until) || state.until > end) break;
    at = state.until;
    if (spans.length > marks.length + 1) break;
  }
  return spans;
}

module.exports = { screenAt, screenSpans };
