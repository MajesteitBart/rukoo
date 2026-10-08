'use strict';

// Page zoom for the main window and the compose windows. Without an application menu Electron has no zoom
// shortcuts, so main.js handles the keys and Ctrl+mouse wheel with these helpers.

// Steps in percent, as in Chrome. settings.json stores the level as one of these (zoomLevel: 125).
const ZOOM_LEVELS = [80, 90, 100, 110, 125, 150, 175, 200];
const ZOOM_DEFAULT = 100;

// Any stored value as a step: the nearest one, or 100 when it is not a number.
function normalizeZoom(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ZOOM_DEFAULT;
  return ZOOM_LEVELS.reduce((best, level) => (Math.abs(level - value) < Math.abs(best - value) ? level : best));
}

// action: 'in' or 'out' (also the directions of Electron's zoom-changed event), or 'reset'. The ends stay put.
function nextZoom(level, action) {
  if (action === 'reset') return ZOOM_DEFAULT;
  const i = ZOOM_LEVELS.indexOf(normalizeZoom(level));
  const to = action === 'in' ? i + 1 : action === 'out' ? i - 1 : i;
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, to))];
}

// The zoom action for an input of webContents' before-input-event, or null. `key` follows the layout, `code`
// names the physical key: Ctrl+= and Ctrl+Shift+= ("+") on US keyboards, "+" and "-" wherever a layout puts
// them, the numpad keys, and the 0 key on layouts where it types another character, such as AZERTY.
// AltGr arrives as Ctrl+Alt and types characters, so it never zooms. Numpad 0 with Num Lock off is Insert,
// and Ctrl+Insert copies.
function zoomKey(input) {
  if (!input || input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null;
  const { key, code } = input;
  if (key === '+' || code === 'NumpadAdd' || (key === '=' && code === 'Equal')) return 'in';
  if (key === '-' || code === 'NumpadSubtract' || (key === '_' && code === 'Minus')) return 'out';
  if (key === '0' || code === 'Digit0') return 'reset';
  return null;
}

module.exports = { ZOOM_LEVELS, ZOOM_DEFAULT, normalizeZoom, nextZoom, zoomKey };
