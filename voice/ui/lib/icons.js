// Static icon markup only; never pass user or app text through here.

// The pill's icons: Beautiful UI's set from Rukoo's src/renderer/agent/bui.js, on a 24 grid, as
// [paths, default stroke width]. Width 0 means a filled shape. pause and screen are new, drawn in that style.
// Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
const PILL = {
  stop: ['<rect x="4.5" y="4.5" width="15" height="15" rx="3" fill="currentColor" stroke="none"/>', 0],
  check: ['<path d="M20 6L9 17l-5-5"/>', 2.5],
  x: ['<path d="M18 6L6 18M6 6l12 12"/>', 2.2],
  info: ['<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.2"/>', 2],
  mic: ['<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>', 2],
  pause: ['<g fill="currentColor" stroke="none"><rect x="6" y="4.5" width="4" height="15" rx="1.5"/><rect x="14" y="4.5" width="4" height="15" rx="1.5"/></g>', 0],
  screen: ['<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M8.5 20.5h7M12 16.5v4"/>', 1.8]
};

export function pillIcon(name, size, strokeWidth) {
  const [paths, defaultWidth] = PILL[name];
  const width = strokeWidth ?? defaultWidth;
  const stroke = width ? `stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"` : 'stroke="none"';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ${stroke} aria-hidden="true" data-icon="${name}">${paths}</svg>`;
}

// Settings uses Rukoo's app icons from src/renderer/icons.js: a 24 grid with 1.6px round strokes.
const p = (d) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const icons = {
  back: p('<path d="m15 4-8 8 8 8"/>'),
  chevronRight: p('<path d="m10 7 5 5-5 5"/>'),
  warning: p('<path d="M10.3 4.6 3.4 16.8a2 2 0 0 0 1.7 3h13.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 16.8h.01"/>'),
  plus: p('<path d="M12 5v14M5 12h14"/>'),
  trash: p('<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l1 13.5h9l1-13.5M10 10.5v6M14 10.5v6"/>'),
  folder: p('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  sync: p('<path d="M20 11a8 8 0 0 0-14.3-4.6L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.6L20 15.5M20 20v-4.5h-4.5"/>'),
  check: p('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  info: p('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>'),
  link: p('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  download: p('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>')
};
