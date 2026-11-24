// Which of Rukoo's modes show: Settings > General > Tabs turns Mail, Calendar, Meet and Chat on and off. The setting
// is settings.hiddenModes, the modes the person turned off. Hiding is not disconnecting: accounts, data, sync and the
// agents' tools stay as they are, so only what people see and hear of a hidden mode goes.
//
// Main has the same rules in src/main/modes.js, for notifications, badges and the tray; test/modes.test.js checks
// that both answer alike.

export const MODES = Object.freeze(['mail', 'calendar', 'meeting', 'chat']);

// A stored list as it may be kept: known modes, each once, in MODES order. A list that hides all four keeps none of
// them, since at least one mode always shows.
export function normalizeHidden(value) {
  const list = Array.isArray(value) ? MODES.filter((m) => value.includes(m)) : [];
  return list.length === MODES.length ? [] : list;
}

// The modes that show now, in tab order. Chat shows only while the server has team chat (chatAvailable): the setting
// can hide it, it can't bring it. When the setting leaves nothing that can show, such as Chat alone while team chat
// is away, Mail shows.
export function visibleModes(hidden, chatAvailable) {
  const off = normalizeHidden(hidden);
  const shown = MODES.filter((m) => !off.includes(m) && (m !== 'chat' || chatAvailable));
  return shown.length ? shown : ['mail'];
}

export function modeHidden(hidden, mode, chatAvailable) {
  return !visibleModes(hidden, chatAvailable).includes(mode);
}

// Whether the setting's switch for mode can turn it off: something else must still show, without the fallback to
// Mail. A mode that doesn't show can always be switched.
export function canHide(hidden, mode, chatAvailable) {
  const off = normalizeHidden(hidden);
  if (off.includes(mode)) return true;
  const next = [...off, mode];
  if (next.length >= MODES.length) return false;
  return MODES.some((m) => !next.includes(m) && (m !== 'chat' || chatAvailable));
}

// The list after the switch for mode turned it on (hide false) or off (hide true), or null when it can't go off.
export function withMode(hidden, mode, hide, chatAvailable) {
  const off = normalizeHidden(hidden);
  if (!MODES.includes(mode)) return null;
  if (!hide) return off.filter((m) => m !== mode);
  if (!canHide(off, mode, chatAvailable)) return null;
  return normalizeHidden([...off, mode]);
}

// The mode a window shows: the one it had when that still shows, else the first that does.
export function modeFor(current, hidden, chatAvailable) {
  const shown = visibleModes(hidden, chatAvailable);
  return shown.includes(current) ? current : shown[0];
}
