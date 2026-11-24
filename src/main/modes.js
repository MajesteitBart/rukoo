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

// Whether a mode can be used now: Mail, Calendar and Meet need a mail account (hasMail), Chat needs the server's team
// chat (chatAvailable). Someone with only a Rukoo account can use Chat alone.
function usable(mode, chatAvailable, hasMail = true) {
  return mode === 'chat' ? Boolean(chatAvailable) : hasMail !== false;
}

// The modes that show now, in tab order. Chat shows only while the server has team chat (chatAvailable): the setting
// can hide it, it can't bring it. Whatever the setting says, one mode that can be used shows: when none of those
// turned on can, Mail shows with a mail account, and Chat without one while the server has it. Mail also shows when
// nothing can be used, which is the setup page's case.
function visibleModes(hidden, chatAvailable, hasMail = true) {
  const off = normalizeHidden(hidden);
  const shown = MODES.filter((m) => !off.includes(m) && (m !== 'chat' || chatAvailable));
  if (shown.some((m) => usable(m, chatAvailable, hasMail))) return shown;
  const keep = hasMail === false && chatAvailable ? 'chat' : 'mail';
  return MODES.filter((m) => shown.includes(m) || m === keep);
}

function modeHidden(hidden, mode, chatAvailable, hasMail = true) {
  return !visibleModes(hidden, chatAvailable, hasMail).includes(mode);
}

module.exports = { MODES, normalizeHidden, usable, visibleModes, modeHidden };
