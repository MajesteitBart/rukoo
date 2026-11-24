'use strict';

// Which of Rukoo's modes show: Settings > General > Tabs turns Mail, Calendar, Meet and Chat on and off. The setting
// is settings.hiddenModes, the modes the person turned off. Hiding is not disconnecting: accounts, data, sync and the
// agents' tools stay as they are, so only what people see and hear of a hidden mode goes (its tab, shortcut,
// notifications, sounds and badges).
//
// The renderer has the same rules in src/renderer/modes.js, for the tabs and the setting itself;
// test/modes.test.js checks that both answer alike.

const MODES = Object.freeze(['mail', 'calendar', 'meeting', 'chat']);

// A stored list as it may be kept: known modes, each once, in MODES order. A list that hides all four keeps none of
// them, since at least one mode always shows.
function normalizeHidden(value) {
  const list = Array.isArray(value) ? MODES.filter((m) => value.includes(m)) : [];
  return list.length === MODES.length ? [] : list;
}

// The modes that show now, in tab order. Chat shows only while the server has team chat (chatAvailable): the setting
// can hide it, it can't bring it. When the setting leaves nothing that can show, such as Chat alone while team chat
// is away, Mail shows.
function visibleModes(hidden, chatAvailable) {
  const off = normalizeHidden(hidden);
  const shown = MODES.filter((m) => !off.includes(m) && (m !== 'chat' || chatAvailable));
  return shown.length ? shown : ['mail'];
}

function modeHidden(hidden, mode, chatAvailable) {
  return !visibleModes(hidden, chatAvailable).includes(mode);
}

module.exports = { MODES, normalizeHidden, visibleModes, modeHidden };
