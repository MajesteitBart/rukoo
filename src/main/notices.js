'use strict';

// The desktop notifications Rukoo has out, by mode ('mail', 'calendar', 'chat'), so turning a mode off in Settings >
// General > Tabs can take its notifications down (main.js closeModeNotices), and a chat alert can be taken back by its
// id. Each is also held so Windows doesn't drop its click handler with the object.
//
// Electron emits 'close' when a notification leaves the screen. On Windows that includes the banner timing out, while
// the notification stays in Action Center, where only close() on the same object removes it (Electron's Notification
// docs). So on Windows a notification that closed by timing out, or for a reason Electron doesn't give, stays held.
// What the person dismissed, a click and a failure let it go. At most `limit` stay held per mode: the oldest goes
// first, and is closed as it goes, so nothing is left in Action Center that Rukoo can no longer take down.

const LIMIT = 20;
// Close reasons after which a Windows notification is no longer in Action Center.
const GONE = new Set(['userCanceled', 'applicationHidden']);

class NoticeKeeper {
  constructor({ platform = process.platform, limit = LIMIT } = {}) {
    this.windows = platform === 'win32';
    this.limit = limit;
    // mode -> Set of entries { n, key }, in the order they were shown.
    this.modes = new Map();
  }

  group(mode) {
    let g = this.modes.get(mode);
    if (!g) this.modes.set(mode, (g = new Set()));
    return g;
  }

  // Holds n for mode. key: an id to take it back by (chat alerts); a notification already held under that key is
  // closed first, as a newer alert replaces it.
  keep(mode, n, key = null) {
    if (key !== null) this.closeKey(mode, key);
    const g = this.group(mode);
    const entry = { n, key };
    g.add(entry);
    const drop = () => g.delete(entry);
    n.on('click', drop);
    n.on('failed', drop);
    n.on('close', (details) => {
      const reason = details && details.reason;
      if (this.windows && !GONE.has(reason)) return;
      drop();
    });
    while (g.size > this.limit) this.closeEntry(g, g.values().next().value);
    return n;
  }

  closeEntry(g, entry) {
    g.delete(entry);
    try {
      entry.n.close();
    } catch (_) {
      // Gone already.
    }
  }

  // Takes down every notification of mode, also those in Windows' Action Center. Returns how many it closed.
  close(mode) {
    const g = this.modes.get(mode);
    if (!g) return 0;
    const all = [...g];
    for (const entry of all) this.closeEntry(g, entry);
    return all.length;
  }

  // Takes down mode's notification held under key. Whether there was one.
  closeKey(mode, key) {
    const g = this.modes.get(mode);
    if (!g) return false;
    let found = false;
    for (const entry of [...g]) {
      if (entry.key !== key) continue;
      this.closeEntry(g, entry);
      found = true;
    }
    return found;
  }

  // The keys of mode's notifications held under one.
  keys(mode) {
    const g = this.modes.get(mode);
    return g ? [...new Set([...g].filter((e) => e.key !== null).map((e) => e.key))] : [];
  }

  // How many are held for mode: on screen, or in Action Center on Windows.
  size(mode) {
    const g = this.modes.get(mode);
    return g ? g.size : 0;
  }
}

module.exports = { NoticeKeeper, LIMIT };
