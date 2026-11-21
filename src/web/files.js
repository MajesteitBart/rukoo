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
// - viewUrl(token, path, type): a blob: URL for an <img> of a downloaded file, in place of desktop's rukoo-chat-file:
//   link with that token. checkViews(valid) revokes the URLs whose link files.js serve() no longer answers.
// - openTab(path, type): an image of a type the viewer shows in a new tab, for chatFile 'open' (src/web/host.js).
// - readable(path): whether the browser still reads the file, for a picked file whose upload failed (src/web/host.js).
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

// A File's name as one name in the memory files: no folders, nothing path.normalize would take apart ('.' and '..';
// '...' is a name like any other, as on desktop).
function flat(name) {
  const text = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/^\.\.?$/, '_');
  return text || 'file';
}

// page: the window. log: its console.
function createWebFiles(page, { log = console } = {}) {
  const doc = page.document;
  const URLs = page.URL;
  const canBlobUrl = Boolean(URLs && typeof URLs.createObjectURL === 'function');
  // A view link's token -> { url, path }: the blob: URL that stands in for desktop's rukoo-chat-file: link with that
  // token (files.js viewLink). Desktop's serve() checks the link's attachment on every load; a browser loads a blob:
  // URL without asking the page, so each link gets a URL of its own, revoked once serve() would refuse the link: its
  // file's row went (a removed message), the token went (files.js keeps 500, and none past a session), or the bytes
  // left the cache. Two attachments with the same bytes share the Blob and never a URL.
  const views = new Map();

  function revoke(url) {
    try {
      URLs.revokeObjectURL(url);
    } catch (_) {
      // Gone already.
    }
  }

  function revokeLater(url) {
    page.setTimeout(() => revoke(url), HAND_OVER_MS);
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

  // A copy files.js made in downloads/ is downloaded and goes again: saveAs copied it there (saveDialog). Bytes that
  // left the cache take their view URLs with them at once, as serve() would refuse those links, so no URL keeps them in
  // memory. A cached file written over (two downloads of the same bytes, named by their digest, landing one after the
  // other) still has bytes there, and serve() still answers its links: their URLs stay, on the first download's Blob,
  // until checkViews or the bytes leaving revoke them.
  const stopWatching = vfs.watch(({ type, path: name, blob }) => {
    if (type === 'remove') {
      if (vfs.get(name)) return;
      for (const [token, v] of views) {
        if (v.path !== name) continue;
        views.delete(token);
        revoke(v.url);
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
    // Each file in a folder of its own: files.js takes the name, and from it the type, from the path's last part, so
    // two picked files with one name (from two folders) both keep it whole.
    const out = [];
    for (const file of files) {
      const at = `${PICKED}/${randomName(page)}/${flat(file.name)}`;
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

  // A blob: URL for <img> of the view link with this token: path and type as files.js serve() answers them for it.
  // The Blob is a view of the cached one, without a copy of its bytes.
  function viewUrl(token, file, type) {
    const blob = vfs.get(file);
    if (!blob || !canBlobUrl || !token) return null;
    const known = views.get(token);
    if (known) return known.url;
    const url = URLs.createObjectURL(new page.Blob([blob], { type: VIEW_TYPES.has(type) ? type : OCTET }));
    views.set(token, { url, path: path.normalize(file) });
    return url;
  }

  // valid(token): whether files.js serve() still answers the link with this token. The others' URLs are revoked.
  function checkViews(valid) {
    for (const [token, v] of views) {
      if (valid(token)) continue;
      views.delete(token);
      revoke(v.url);
    }
  }

  // Whether the file at a path can still be read. A browser refuses to read a picked File again once it changed or
  // went on disk (Chromium: NotReadableError), and only the chooser hands out a new one.
  async function readable(file) {
    const blob = vfs.get(file);
    if (!blob) return false;
    try {
      await blob.slice(0, 1).arrayBuffer();
      return true;
    } catch (_) {
      return false;
    }
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
    for (const v of views.values()) revoke(v.url);
    views.clear();
  }

  return {
    host: { pickFiles, thumbnail, askRisky, saveDialog, openPath },
    viewUrl,
    checkViews,
    openTab,
    readable,
    dropPicked,
    prunePicked,
    dispose,
    // How many view URLs work now (checkViews has nothing to do without any).
    views: () => views.size,
    // For the bridge's tests: what lives in memory now.
    stored: () => vfs.size()
  };
}

module.exports = { createWebFiles, PICKED, DOWNLOADS };
