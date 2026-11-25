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

// Whether a mode can be used now: Mail, Calendar and Meet need a mail account (hasMail), Chat needs the server's team
// chat (chatAvailable). Someone with only a Rukoo account can use Chat alone.
export function usable(mode, chatAvailable, hasMail = true) {
  return mode === 'chat' ? Boolean(chatAvailable) : hasMail !== false;
}

// The modes that show now, in tab order. Chat shows only while the server has team chat (chatAvailable): the setting
// can hide it, it can't bring it. Whatever the setting says, one mode that can be used shows: when none of those
// turned on can, Mail shows with a mail account, and Chat without one while the server has it. Mail also shows when
// nothing can be used, which is the setup page's case.
export function visibleModes(hidden, chatAvailable, hasMail = true) {
  const off = normalizeHidden(hidden);
  const shown = MODES.filter((m) => !off.includes(m) && (m !== 'chat' || chatAvailable));
  if (shown.some((m) => usable(m, chatAvailable, hasMail))) return shown;
  const keep = hasMail === false && chatAvailable ? 'chat' : 'mail';
  return MODES.filter((m) => shown.includes(m) || m === keep);
}

export function modeHidden(hidden, mode, chatAvailable, hasMail = true) {
  return !visibleModes(hidden, chatAvailable, hasMail).includes(mode);
}

// The stored list as the tabs show it now: a mode that shows although the list turns it off (the one that stays in
// visibleModes) counts as on. A switch works from this list and saves it, so after a change the setting says what the
// tabs showed, and the mode that stood in doesn't lock the others' switches.
export function effectiveHidden(hidden, chatAvailable, hasMail = true) {
  const shown = visibleModes(hidden, chatAvailable, hasMail);
  return normalizeHidden(hidden).filter((m) => !shown.includes(m));
}

// Whether the setting's switch for mode can turn it off: another mode that can be used must still show, without the
// fallback in visibleModes. Without a mail account that is Chat, so Chat's switch stays on. A mode turned off can
// always be turned on. A mode that stands in counts as on (effectiveHidden).
export function canHide(hidden, mode, chatAvailable, hasMail = true) {
  const off = effectiveHidden(hidden, chatAvailable, hasMail);
  if (off.includes(mode)) return true;
  const next = [...off, mode];
  return MODES.some((m) => !next.includes(m) && usable(m, chatAvailable, hasMail));
}

// The list after the switch for mode turned it on (hide false) or off (hide true), or null when it can't go off. It
// starts from the list as the tabs show it (effectiveHidden), so a mode that stood in is saved as on.
export function withMode(hidden, mode, hide, chatAvailable, hasMail = true) {
  const off = effectiveHidden(hidden, chatAvailable, hasMail);
  if (!MODES.includes(mode)) return null;
  if (!hide) return off.filter((m) => m !== mode);
  if (!canHide(off, mode, chatAvailable, hasMail)) return null;
  return normalizeHidden([...off, mode]);
}

// The mode a window shows: the one it had when that still shows, else the first that shows and can be used.
export function modeFor(current, hidden, chatAvailable, hasMail = true) {
  const shown = visibleModes(hidden, chatAvailable, hasMail);
  if (shown.includes(current)) return current;
  return shown.find((m) => usable(m, chatAvailable, hasMail)) || shown[0];
}
