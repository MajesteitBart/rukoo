'use strict';

// What src/main/main.js's chatHost does for team chat's files (src/main/workspaces/files.js), for the browser page,
// and the page's side of chatFile. The files the engine handles live in memory (src/web/engine/shims/vfs.js) under
// names that look like paths, so files.js runs as on desktop; this module is where those names meet the page:
//
// - pickFiles(): the browser's file chooser (a hidden <input type=file multiple>). Each File the person picks goes
//   into the memory files under picked/, and its name there is the "path" files.js may stage, as a path the system's
//   dialog answered on desktop. A File is a handle on the file on disk, so nothing is read or copied yet. They go once
//   nothing needs them (prunePicked) or the session ends (dropPicked).
// - thumbnail(file, side): a PNG data URL of the image fitting side by side pixels (createImageBitmap and a canvas), or
//   null where the browser can't decode it. imageSize isn't here: a browser decodes asynchronously, and files.js asks
//   it synchronously, only for a picture whose header doesn't say its size.
// - askRisky(name): 'save'. Desktop asks before it opens a program or a script; a browser never opens a download, it
//   only saves it, and warns about risky files itself.
// - saveDialog(name): a name under downloads/ for files.js to copy the file to; the copy landing there is the browser
//   download (watch below), so the person's browser decides where it goes, as for any download.
// - openPath(file): the file downloads, as no page may hand a file to an app on the computer.
// - viewUrl(path, type): a blob: URL of a downloaded file for an <img>, in place of desktop's rukoo-chat-file: link.
// - openTab(path, type): an image of a type the viewer shows in a new tab, for chatFile 'open' (src/web/host.js).
//
// Security: a blob: URL is of the page's origin, so a file opened as what it says it is could run script with the
// page's session (text/html, an SVG). Only the image types of files.js VIEW_TYPES ever get their own type, for <img>
// and the new tab; everything else is application/octet-stream and only ever downloads.
const vfs = require('./engine/shims/vfs');
const path = require('./engine/shims/path');
const { VIEW_TYPES } = require('../main/workspaces/files');

const PICKED = 'rukoo-web/picked';
const DOWNLOADS = 'rukoo-web/downloads';
// How long a blob: URL the page opened in a new tab or handed to a download stays valid: long enough for the tab to
// load it, and the bytes go with it after.
const HAND_OVER_MS = 60 * 1000;
const OCTET = 'application/octet-stream';

function randomName(page) {
  const bytes = new Uint8Array(9);
  page.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// A File's name as one name in the memory files: no folders, nothing path.normalize would take apart.
function flat(name) {
  const text = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/^\.+$/, '_');
  return text || 'file';
}

// page: the window. log: its console.
function createWebFiles(page, { log = console } = {}) {
  const doc = page.document;
  const URLs = page.URL;
  const canBlobUrl = Boolean(URLs && typeof URLs.createObjectURL === 'function');
  // `${path}\n${type}` -> blob: URL, for the files the log shows; revoked when the file leaves the cache.
  const views = new Map();

  function revokeLater(url) {
    page.setTimeout(() => {
      try {
        URLs.revokeObjectURL(url);
      } catch (_) {
        // Gone already.
      }
    }, HAND_OVER_MS);
  }

  // A file the browser downloads: its bytes as application/octet-stream, so no browser shows it in place of saving.
  function download(blob, name) {
    if (!canBlobUrl || !doc || typeof doc.createElement !== 'function') throw new Error('This browser cannot download files');
    const url = URLs.createObjectURL(new page.Blob([blob], { type: OCTET }));
    const a = doc.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.hidden = true;
    (doc.body || doc.documentElement).append(a);
    try {
      a.click();
    } finally {
      a.remove();
      revokeLater(url);
    }
  }

  // A copy files.js made in downloads/ is downloaded and goes again: saveAs copied it there (saveDialog).
  const stopWatching = vfs.watch(({ type, path: name, blob }) => {
    if (type === 'remove') {
      for (const [key, url] of views) {
        if (key.slice(0, key.indexOf('\n')) !== name) continue;
        views.delete(key);
        try {
          URLs.revokeObjectURL(url);
        } catch (_) {
          // Gone already.
        }
      }
      return;
    }
    if (type !== 'put' || !name.startsWith(`${DOWNLOADS}/`)) return;
    try {
      download(blob, path.basename(name));
    } catch (err) {
      log.error('[web] the download did not start', err);
    } finally {
      vfs.remove(path.dirname(name), { recursive: true });
    }
  });

  // ---- the host files.js asks ----

  // The chooser open now: settle(files) ends its pick.
  let picking = null;
  async function pickFiles() {
    if (!doc || typeof doc.createElement !== 'function') return [];
    // A chooser is modal: a click on Attach while a pick still waits means that chooser closed without telling the
    // page (no change or cancel came). That pick ends empty and a new chooser opens, so Attach never stops working.
    if (picking) picking([]);
    const input = doc.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.tabIndex = -1;
    (doc.body || doc.documentElement).append(input);
    // The window's focus coming back says nothing: a browser may send it before 'change', as long as a phone takes to
    // copy a cloud file. A cancelled chooser sends 'cancel' in every browser the page runs in (bridge.js) but Chrome
    // 112, where that pick waits for the next Attach to end it.
    const files = await new Promise((resolve) => {
      const settle = (list) => {
        if (picking === settle) picking = null;
        input.remove();
        resolve(list);
      };
      picking = settle;
      input.addEventListener('change', () => settle([...(input.files || [])]), { once: true });
      input.addEventListener('cancel', () => settle([]), { once: true });
      // Still inside the click that asked: the browser opens the chooser only for a user's own action.
      input.click();
    });
    const dir = `${PICKED}/${randomName(page)}`;
    const used = new Set();
    const out = [];
    for (const file of files) {
      let name = flat(file.name);
      // Two picked files with one name (from two folders) each keep theirs.
      for (let n = 2; used.has(name); n++) name = `${flat(file.name)} (${n})`;
      used.add(name);
      const at = `${dir}/${name}`;
      vfs.put(at, file);
      out.push(at);
    }
    return out;
  }

  async function thumbnail(file, side) {
    const blob = vfs.get(file);
    if (!blob || typeof page.createImageBitmap !== 'function') return null;
    let bitmap;
    try {
      bitmap = await page.createImageBitmap(blob);
    } catch (_) {
      // A format this browser can't decode.
      return null;
    }
    try {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height, 1));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (!g) return null;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, 0, 0, width, height);
      return canvas.toDataURL('image/png');
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  async function askRisky() {
    return 'save';
  }

  async function saveDialog(name) {
    return `${DOWNLOADS}/${randomName(page)}/${flat(name)}`;
  }

  // files.js 'open' copies the file to a folder of its own and hands it over here: it downloads, as no page may give a
  // file to an app on the computer. The bridge answers 'open' itself for the images a tab can show (openTab), so this
  // is for what files.js reaches anyway. Answers '' as shell.openPath does on success; the copy goes once handed over.
  async function openPath(file) {
    const blob = vfs.get(file);
    if (!blob) return 'The file is gone';
    try {
      download(blob, path.basename(file));
      return '';
    } finally {
      vfs.remove(path.dirname(file), { recursive: true });
    }
  }

  // An image of a type the viewer shows (files.js VIEW_TYPES) in a new tab: its own blob: URL, an image document of
  // the page's origin without script. Not opened with noopener, so a tab the browser refused is known (null) and the
  // caller downloads instead; the tab still gets no way back to the page. Answers whether it opened.
  function openTab(file, type) {
    const blob = vfs.get(file);
    if (!blob || !VIEW_TYPES.has(type) || !canBlobUrl || typeof page.open !== 'function') return false;
    const url = URLs.createObjectURL(new page.Blob([blob], { type }));
    let tab = null;
    try {
      tab = page.open(url, '_blank');
    } catch (_) {
      tab = null;
    }
    if (!tab) {
      URLs.revokeObjectURL(url);
      return false;
    }
    try {
      tab.opener = null;
    } catch (_) {
      // Not ours to change any more.
    }
    revokeLater(url);
    return true;
  }

  // ---- the page's side of chatFile 'view' ----

  // A blob: URL for <img> of a file in the cache: path and type as files.js serve() answers them. The same file keeps
  // its URL until it leaves the cache.
  function viewUrl(file, type) {
    const blob = vfs.get(file);
    if (!blob || !canBlobUrl) return null;
    const as = VIEW_TYPES.has(type) ? type : OCTET;
    const key = `${path.normalize(file)}\n${as}`;
    let url = views.get(key);
    if (!url) {
      url = URLs.createObjectURL(new page.Blob([blob], { type: as }));
      views.set(key, url);
    }
    return url;
  }

  // The files picked in a session that ended: files.js forgets the paths at once (Files.clear), and the page lets go
  // of the files they named.
  function dropPicked() {
    vfs.remove(PICKED, { recursive: true });
  }

  // The picked files nothing needs any more: keep(path) says whether files.js may still stage the path or a staged
  // file still reads it (src/web/host.js asks the engine). A File holds no bytes of its own, but each one stays in
  // the memory files, which every lookup there walks, until it goes here or at the session's end.
  function prunePicked(keep) {
    for (const name of vfs.under(PICKED)) if (!keep(name)) vfs.remove(name);
  }

  function dispose() {
    stopWatching();
    for (const url of views.values()) {
      try {
        URLs.revokeObjectURL(url);
      } catch (_) {
        // Gone already.
      }
    }
    views.clear();
  }

  return {
    host: { pickFiles, thumbnail, askRisky, saveDialog, openPath },
    viewUrl,
    openTab,
    dropPicked,
    prunePicked,
    dispose,
    // For the bridge's tests: what lives in memory now.
    stored: () => vfs.size()
  };
}

module.exports = { createWebFiles, PICKED, DOWNLOADS };
