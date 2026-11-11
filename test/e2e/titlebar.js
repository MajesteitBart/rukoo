'use strict';

// Where the title bar's content sits against the native window buttons on Windows and Linux. The page learns where
// they are from navigator.windowControlsOverlay: its titlebar-area rectangle is the part of the bar they leave free,
// in CSS pixels at the page's zoom.

// The free part of the bar, and the visible brand icon, compose title, search and actions in it.
function titlebar(page) {
  return page.evaluate(() => {
    const area = navigator.windowControlsOverlay.getTitlebarAreaRect();
    const box = (selector) => {
      const el = [...document.querySelectorAll(selector)].find((e) => e.checkVisibility());
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    };
    return {
      area: { left: area.x, right: area.x + area.width, height: area.height },
      icon: box('.titlebar-icon'),
      title: box('#compose-title'),
      search: box('.titlebar-search'),
      actions: box('.titlebar-actions')
    };
  });
}

// How far the icon starts after the buttons on the left (or the window's edge), and how far the actions end before
// the buttons on the right (or the edge), rounded to whole CSS pixels. Null for a part the page doesn't show.
async function clearance(page) {
  const g = await titlebar(page);
  return {
    icon: g.icon && Math.round(g.icon.left - g.area.left),
    actions: g.actions && Math.round(g.area.right - g.actions.right)
  };
}

module.exports = { titlebar, clearance };
