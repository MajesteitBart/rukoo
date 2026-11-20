'use strict';

// Files in team chat (rich chat contract 3.5, 3.6 and 4.6): staging what the person attaches, measuring images,
// uploading with progress, the files a draft keeps, downloads into a cache on this computer, and the links the
// renderer shows a downloaded image with. ipc.js turns METHODS into chatPickFiles, chatStage, chatUnstage,
// chatRetryStage, chatStaged and chatFile, each as (svc, ...checkedArgs) => result.
//
// Staging. A file is staged the moment it is attached: chatStage answers at once with a Staged entry in state
// measuring, and staged events follow it through uploading (with loaded, at most every 100 ms) to ready, or to failed
// with an error code, from which chatRetryStage starts it again. Measuring reads the file once for its SHA-256 and,
// for a PNG, JPEG, GIF or WebP, its width and height from the header (EXIF orientation applied) and a small thumbnail
// for the tray from the host (nativeImage in main.js). Then POST /uploads reserves it and a PUT streams the bytes to the
// Worker-signed link, with Content-Length the declared size. Only paths chatPickFiles answered with can be staged by
// path, so a renderer can't make main read any other file; dropped and pasted files come as bytes, which go to a
// temporary file in the profile first. The staged lists live in memory: a restart drops what wasn't ready, and the
// draft keeps what was (ID, metadata, expiresAt). Reading a draft stages its files again as ready, and drops those
// whose upload expired, saying how many.
//
// Downloads. chatFile asks the server for a 60-second link, accepts it only for the configured server's origin or the
// advertised files origin, and fetches it with a request of its own: no cookies, no account headers, no redirects.
// The file lands in chat-files/ next to chat.db, named by its SHA-256 and checked for size and digest, at most
// timing.fileCacheMax bytes in all with the least recently used going first. A removed message, an evicted room, a
// workspace that goes and the end of the session take their files with them. 'view' answers a rukoo-chat-file: URL
// that main.js serves only for files this session fetched; 'open' copies the file under its own name to a temporary
// folder and opens it in its default app, after asking about a risky type; 'save' asks where.
//
// What the service gives this module: svc.store, svc.epoch, svc.call(ws, method, route, body, { retry }),
// svc.guard(epoch), svc.emitChat(payload), svc.now(), svc.clock(), svc.server, svc.timing, svc.timers,
// svc.capabilities(), svc.filesInfo(), svc.isStale(err), svc.hookFailed(err), and svc.host: the Electron side, which
// tests replace: { pickFiles(), saveDialog(name), openPath(file), askRisky(name), thumbnail(file), imageSize(file) }.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Transform, pipeline } = require('stream');
const wire = require('./wire');
const { filesDir, uploadsDir } = require('./store');
const { AccountError, errorDetails } = require('../account/client');
const { RISKY, safeName, markOfTheWeb } = require('../files');

const { ChatError, chatError } = wire;

const MiB = 1024 * 1024;
// The largest file when the server names none (rich contract 2.1).
const FILE_BYTES_DEFAULT = 25 * MiB;
// A path chatPickFiles answered with can be staged for this long.
const PICK_TTL = 10 * 60 * 1000;
// How much of a file the image header is looked for in.
const HEADER_BYTES = 512 * 1024;
// The tray's thumbnail fits this square; a GIF or WebP that nativeImage can't read shows itself up to this size.
const THUMB_SIDE = 192;
const THUMB_RAW_MAX = 512 * 1024;
// A transfer that sends or receives nothing for this long fails.
const IDLE_TIMEOUT = 60 * 1000;
// Transfers at once, uploads and downloads each.
const TRANSFERS = 3;
// view links kept per session, the oldest going first.
const VIEWS_MAX = 500;
const VIEW_SCHEME = 'rukoo-chat-file';
// Types the viewer may show as what they are; anything else is served as a download.
const VIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

// A type by extension, for a file attached from disk. Anything else is application/octet-stream.
const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/vnd.microsoft.icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  ics: 'text/calendar',
  eml: 'message/rfc822',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation'
};

function typeFromName(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

// A name the server takes (rich contract 2.6) from a file's name on disk: no control characters, / or \, trimmed, at
// most 255 characters with the extension kept.
function nameOf(file) {
  let name = path.basename(String(file || '')).replace(/[\p{Cc}/\\]/gu, '_').trim();
  if (!name) name = 'file';
  const chars = Array.from(name);
  if (chars.length <= wire.limits.FILE_NAME) return name;
  const ext = Array.from(path.extname(name)).slice(0, 32);
  return chars.slice(0, wire.limits.FILE_NAME - ext.length).join('').trimEnd() + ext.join('');
}

// ---- image headers ----

// The orientation an EXIF block names (1 to 8), or 1. tiff: the bytes from the TIFF header on.
function exifOrientation(tiff) {
  if (tiff.length < 8) return 1;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
  const u16 = (at) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > tiff.length) break;
    if (u16(at) === 0x0112) {
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpegSize(b) {
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Markers without a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && i + 10 <= b.length && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      orientation = exifOrientation(b.subarray(i + 10, Math.min(b.length, i + 2 + length)));
    }
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (i + 9 > b.length) return null;
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      // Orientations 5 to 8 turn the picture a quarter, so it shows the other way round.
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    i += 2 + length;
  }
  return null;
}

// { type, width, height } of a PNG, JPEG, GIF or WebP from its first bytes, or null. width and height are what the
// picture shows as, and null when the header doesn't give them within limits.
function imageInfo(b) {
  if (!b || b.length < 12) return null;
  let type = null;
  let size = null;
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    type = 'image/png';
    if (b.toString('latin1', 12, 16) === 'IHDR') size = { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } else if (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a') {
    type = 'image/gif';
    size = { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  } else if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    type = 'image/webp';
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && b.length >= 30) size = { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    else if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      size = { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    } else if (chunk === 'VP8X' && b.length >= 30) size = { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  } else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    type = 'image/jpeg';
    size = jpegSize(b);
  }
  if (!type) return null;
  const fits = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 65535;
  return size && fits(size.width) && fits(size.height) ? { type, ...size } : { type, width: null, height: null };
}

// ---- transfers ----

// An HTTP request of its own: no cookies, no account headers, no keep-alive, and no redirect followed. body: a
// readable stream sent with the given content-length. onChunk(chunk) for each chunk read from body (upload) or
// received for sink (download). sink: makes the writable the answer's body goes to when the status is 2xx, at most
// limit bytes, in the tick the pipeline takes it, so a file that can't be opened rejects; else the body is read as
// JSON. Resolves { status, json } for 2xx, rejects with an AccountError (as client.js makes them) otherwise, with the
// sink's own error when writing fails (a full disk), or with a cancelled error when signal aborts.
function transfer(url, { method, headers = {}, body = null, sink = null, onChunk = null, limit = Infinity, signal }) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = lib.request(u, { method, headers: { 'accept-encoding': 'identity', ...headers }, agent: false, timeout: IDLE_TIMEOUT }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400) {
        res.resume();
        req.destroy();
        return finish(reject, new AccountError('server', status, 'redirect refused'));
      }
      const ok = status >= 200 && status < 300;
      if (ok && sink) {
        const out = sink();
        let got = 0;
        const meter = new Transform({
          transform(chunk, _encoding, done) {
            got += chunk.length;
            if (got > limit) return done(new AccountError('server', status, 'too long'));
            if (onChunk) onChunk(chunk);
            done(null, chunk);
          }
        });
        // An error of any of the three, the sink's included, ends all of them and rejects.
        let failed = null;
        out.once('error', (err) => (failed = err));
        pipeline(res, meter, out, (err) => {
          if (!err) return finish(resolve, { status, json: null });
          req.destroy();
          finish(reject, err === failed || err.cancelled || err instanceof AccountError ? err : new AccountError('network', 0, err.message));
        });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MiB) return req.destroy();
        chunks.push(chunk);
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          json = null;
        }
        if (ok) return finish(resolve, { status, json });
        finish(reject, new AccountError((json && json.error) || 'server', status, json && json.message, errorDetails(json, res)));
      });
      res.on('error', (err) => finish(reject, new AccountError('network', 0, err.message)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => finish(reject, err && err.cancelled ? err : new AccountError('network', 0, err && err.message)));
    if (signal) {
      if (signal.aborted) return req.destroy(cancelled());
      signal.addEventListener('abort', () => req.destroy(cancelled()), { once: true });
    }
    if (!body) return req.end();
    body.on('data', (chunk) => {
      if (onChunk) onChunk(chunk);
    });
    body.on('error', (err) => req.destroy(err));
    body.pipe(req);
  });
}

function cancelled() {
  const err = new Error('cancelled');
  err.cancelled = true;
  return err;
}

// A simple gate: at most n jobs at once, the rest waiting in order.
function gate(n) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= n || !waiting.length) return;
    running += 1;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        running -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      waiting.push({ fn, resolve, reject });
      next();
    });
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

async function readHead(file, bytes) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const removeQuietly = (file) => fsp.rm(file, { force: true }).catch(() => {});
const stagedKey = (ws, room, root) => `${ws}\n${room}\n${root || ''}`;

class Files {
  static METHODS = {
    chatPickFiles: (svc) => svc.files.pick(),
    chatStage: (svc, ws, c, root, source) => svc.files.stage(ws, c, root, source),
    chatUnstage: (svc, stage) => svc.files.unstage(stage),
    chatRetryStage: (svc, stage) => svc.files.retry(stage),
    chatStaged: (svc, ws, c, root) => svc.files.list(ws, c, root),
    chatFile: (svc, ws, c, file, action) => svc.files.file(ws, c, file, action)
  };

  constructor(svc) {
    this.svc = svc;
    // stage -> entry, in the order they were attached.
    this.staged = new Map();
    // path -> when it stops being stageable.
    this.picked = new Map();
    // token -> { ws, room, file, path, type, name, sha256, epoch } for rukoo-chat-file: links.
    this.views = new Map();
    // Downloads in flight: `${ws}\n${room}\n${file}` -> promise.
    this.downloads = new Map();
    // SHA-256s of cached files whose digest this session checked, and of files a download is putting in place.
    this.verified = new Set();
    this.landing = new Set();
    // Per staged list: the timer of a progress event held back, and when the last went out.
    this.emits = new Map();
    this.uploads = gate(TRANSFERS);
    this.fetches = gate(TRANSFERS);
    this.closed = false;
  }

  // ---- plumbing ----

  get host() {
    return this.svc.host || {};
  }

  get cacheMax() {
    return this.svc.timing.fileCacheMax || 1024 * MiB;
  }

  store() {
    if (!this.svc.store) throw new ChatError('signed_out');
    return this.svc.store;
  }

  dir() {
    return filesDir(this.store().file);
  }

  room(ws, c) {
    const store = this.store();
    const row = store.getWs(ws);
    if (!row) throw new ChatError('not_found', { scope: 'workspace' });
    if (row.state === 'quarantined') throw new ChatError('paused');
    if (row.state === 'upgrade') throw new ChatError('upgrade_required');
    const room = store.getRoom(ws, c);
    if (!room) throw new ChatError('not_found', { scope: 'conversation' });
    return { ws: row, room };
  }

  // The largest file the server takes: GET /'s limits.fileBytes, else /v1/info's files.maxBytes, else 25 MiB.
  fileLimit(wsRow) {
    let limits = null;
    try {
      limits = wsRow && wsRow.limits ? JSON.parse(wsRow.limits) : null;
    } catch (_) {
      limits = null;
    }
    if (limits && Number.isSafeInteger(limits.fileBytes) && limits.fileBytes > 0) return limits.fileBytes;
    const info = this.svc.filesInfo();
    if (info && Number.isSafeInteger(info.maxBytes) && info.maxBytes > 0) return info.maxBytes;
    return FILE_BYTES_DEFAULT;
  }

  // The origins a transfer link may point at: the account server's, and the files origin /v1/info advertises.
  origins() {
    const out = new Set();
    try {
      out.add(new URL(this.svc.server).origin);
    } catch (_) {
      // No server, no transfers.
    }
    const info = this.svc.filesInfo();
    if (info && typeof info.origin === 'string' && info.origin) {
      try {
        const u = new URL(info.origin);
        if (u.protocol === 'https:' || u.protocol === 'http:') out.add(u.origin);
      } catch (_) {
        // Not an origin.
      }
    }
    return out;
  }

  allowedLink(url) {
    try {
      const u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && this.origins().has(u.origin);
    } catch (_) {
      return false;
    }
  }

  // The server's time now, for an upload's expiresAt.
  serverNow() {
    return this.svc.now() + (this.svc.clock() ?? 0);
  }

  // ---- Staged ----

  view(entry) {
    return {
      stage: entry.stage,
      ws: entry.ws,
      conversation: entry.conversation,
      root: entry.root,
      name: entry.name,
      type: entry.type,
      size: entry.size,
      width: entry.width ?? null,
      height: entry.height ?? null,
      state: entry.state,
      loaded: entry.loaded,
      file: entry.file,
      error: entry.error,
      thumb: entry.thumb,
      expiresAt: entry.expiresAt
    };
  }

  entries(ws, c, root) {
    const key = stagedKey(ws, c, root);
    return [...this.staged.values()].filter((e) => e.key === key);
  }

  // chatStaged: the room's or thread's staged files, in the order they were attached.
  list(ws, c, root) {
    this.room(ws, c);
    return this.entries(ws, c, root).map((e) => this.view(e));
  }

  // The staged event for one list: at once for a change of state, at most every 100 ms for progress.
  emit(entry, { progress = false } = {}) {
    const key = entry.key;
    let e = this.emits.get(key);
    if (!e) {
      e = { last: -Infinity, timer: null };
      this.emits.set(key, e);
    }
    const send = () => {
      e.timer = null;
      e.last = this.svc.now();
      this.svc.emitChat({ kind: 'staged', ws: entry.ws, conversation: entry.conversation, root: entry.root, staged: this.entries(entry.ws, entry.conversation, entry.root).map((x) => this.view(x)) });
    };
    const wait = e.last + 100 - this.svc.now();
    if (!progress || wait <= 0) {
      if (e.timer) this.svc.timers.clearTimeout(e.timer);
      return send();
    }
    if (!e.timer) e.timer = this.svc.timers.setTimeout(send, wait);
  }

  // chatPickFiles: the system's dialog, which only main opens. Each path it answers with may be staged for ten
  // minutes.
  async pick() {
    if (typeof this.host.pickFiles !== 'function') return [];
    const paths = (await this.host.pickFiles()) || [];
    const out = [];
    const until = this.svc.now() + PICK_TTL;
    for (const p of paths) {
      try {
        const stat = await fsp.stat(p);
        if (!stat.isFile()) continue;
        this.picked.set(p, until);
        const name = nameOf(p);
        out.push({ path: p, name, size: stat.size, type: typeFromName(name) });
      } catch (_) {
        // Gone between the dialog and now.
      }
    }
    return out;
  }

  // chatStage (rich contract 3.5): a file for the room's or thread's next message. Answers at once with the entry in
  // state measuring; staged events follow it. A file over the server's limit, an 11th file, or a path chatPickFiles
  // didn't answer with is refused here.
  async stage(ws, c, root, source) {
    const svc = this.svc;
    const { ws: wsRow } = this.room(ws, c);
    if (!svc.capabilities().includes('files')) throw new ChatError('files_off');
    if (this.entries(ws, c, root).length >= wire.limits.ATTACHMENTS_MAX) throw new ChatError('invalid', { field: 'attachments' });
    const limit = this.fileLimit(wsRow);
    const epoch = svc.epoch;
    let file;
    let temp = false;
    let name;
    let type;
    let size;
    if (source.path !== undefined) {
      const until = this.picked.get(source.path);
      if (!until || until < svc.now()) throw new ChatError('invalid', { field: 'path' });
      let stat;
      try {
        stat = await fsp.stat(source.path);
      } catch (err) {
        throw new ChatError('unreadable', { cause: err });
      }
      if (!stat.isFile()) throw new ChatError('unreadable');
      file = source.path;
      name = nameOf(file);
      type = typeFromName(name);
      size = stat.size;
    } else {
      name = source.name;
      type = source.type || typeFromName(name);
      size = source.bytes.byteLength;
    }
    if (size < 1) throw new ChatError('invalid', { field: 'size' });
    if (size > limit) throw new ChatError('too_large', { limit: 'fileBytes', status: 413 });
    if (source.path === undefined) {
      // Pasted or dropped bytes go to a file of their own in the profile, which the upload streams from.
      const dir = uploadsDir(this.store().file);
      await fsp.mkdir(dir, { recursive: true });
      file = path.join(dir, crypto.randomBytes(16).toString('hex'));
      await fsp.writeFile(file, source.bytes);
      temp = true;
      svc.guard(epoch);
    }
    // Another attach may have filled the list while this one read the file or wrote its bytes.
    if (this.entries(ws, c, root).length >= wire.limits.ATTACHMENTS_MAX) {
      if (temp) await removeQuietly(file);
      throw new ChatError('invalid', { field: 'attachments' });
    }
    const entry = {
      stage: wire.localId(),
      key: stagedKey(ws, c, root),
      ws,
      conversation: c,
      root: root || null,
      name,
      type,
      size,
      width: null,
      height: null,
      state: 'measuring',
      loaded: 0,
      file: null,
      error: null,
      thumb: null,
      expiresAt: null,
      epoch,
      path: file,
      temp,
      sha256: null,
      put: null,
      abort: null,
      gone: false
    };
    this.staged.set(entry.stage, entry);
    this.emit(entry);
    this.run(entry);
    return this.view(entry);
  }

  // Measures (once), reserves and uploads; failed with an error code when something refuses.
  async run(entry) {
    const svc = this.svc;
    try {
      if (!entry.sha256) await this.measure(entry);
      if (entry.gone) return;
      entry.state = 'uploading';
      entry.loaded = 0;
      this.emit(entry);
      await this.uploads(() => (entry.gone ? null : this.upload(entry)));
      if (entry.gone) return;
      entry.state = 'ready';
      entry.loaded = entry.size;
      this.emit(entry);
    } catch (err) {
      if (entry.gone || svc.isStale(err) || (err && err.cancelled) || entry.epoch !== svc.epoch) return;
      const e = chatError(err);
      // A file that changed on disk since it was measured is measured again by Retry.
      if (e.code === 'invalid' && (e.field === 'sha256' || e.field === 'size')) entry.sha256 = null;
      entry.state = 'failed';
      entry.error = wire.isInternal(e.code) ? 'server' : e.code;
      entry.abort = null;
      this.emit(entry);
    }
  }

  // Its SHA-256, and for an image its type, width, height and thumbnail.
  async measure(entry) {
    let digest;
    let head;
    try {
      digest = await hashFile(entry.path);
      head = await readHead(entry.path, Math.min(HEADER_BYTES, digest.size));
    } catch (err) {
      throw new ChatError('unreadable', { cause: err });
    }
    if (entry.gone) return;
    // The file changed size since it was staged: what it is now is what goes.
    if (digest.size < 1) throw new ChatError('unreadable');
    entry.size = digest.size;
    entry.sha256 = digest.sha256;
    const image = imageInfo(head);
    if (image) {
      entry.type = image.type;
      let size = image.width ? { width: image.width, height: image.height } : null;
      if (!size && typeof this.host.imageSize === 'function') {
        try {
          size = this.host.imageSize(entry.path);
        } catch (_) {
          size = null;
        }
      }
      if (size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width >= 1 && size.height >= 1 && size.width <= 65535 && size.height <= 65535) {
        entry.width = size.width;
        entry.height = size.height;
      }
      entry.thumb = await this.thumbnail(entry, image.type);
    }
  }

  async thumbnail(entry, type) {
    if (typeof this.host.thumbnail === 'function') {
      try {
        const url = await this.host.thumbnail(entry.path, THUMB_SIDE);
        if (typeof url === 'string' && /^data:image\/(png|jpeg);base64,/.test(url)) return url;
      } catch (_) {
        // nativeImage can't read it; GIF and WebP below.
      }
    }
    if ((type === 'image/gif' || type === 'image/webp') && entry.size <= THUMB_RAW_MAX) {
      try {
        return `data:${type};base64,${(await fsp.readFile(entry.path)).toString('base64')}`;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  // Reserves when there is no live link yet, then sends the bytes. A link that expired, or an upload the server no
  // longer takes bytes for, is reserved again once.
  async upload(entry) {
    for (let attempt = 0; ; attempt++) {
      if (!entry.file || !entry.put || entry.put.expiresAt <= this.serverNow() + 5000) await this.reserve(entry);
      if (entry.gone) return;
      try {
        await this.put(entry);
        return;
      } catch (raw) {
        if (raw && raw.cancelled) throw raw;
        const err = chatError(raw);
        if (attempt === 0 && (err.code === 'expired' || err.code === 'invalid_state')) {
          this.cancelOnServer(entry);
          entry.file = null;
          entry.put = null;
          continue;
        }
        throw err;
      }
    }
  }

  async reserve(entry) {
    const svc = this.svc;
    const epoch = svc.epoch;
    if (entry.file) this.cancelOnServer(entry);
    const body = { name: entry.name, type: entry.type, size: entry.size, sha256: entry.sha256 };
    if (entry.width && entry.height && entry.type.startsWith('image/')) Object.assign(body, { width: entry.width, height: entry.height });
    const answer = wire.checkReserve(await svc.call(entry.ws, 'POST', `/conversations/${entry.conversation}/uploads`, body, { retry: true }));
    svc.guard(epoch);
    entry.file = answer.upload.id;
    entry.expiresAt = answer.upload.expiresAt;
    entry.put = answer.put;
    // Removed meanwhile: the reservation goes too.
    if (entry.gone) this.cancelOnServer(entry);
  }

  async put(entry) {
    const svc = this.svc;
    const epoch = svc.epoch;
    if (!this.allowedLink(entry.put.url)) throw new ChatError('server', { where: 'put.url' });
    const controller = new AbortController();
    entry.abort = () => controller.abort();
    entry.loaded = 0;
    try {
      const res = await transfer(entry.put.url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(entry.size), accept: 'application/json' },
        body: fs.createReadStream(entry.path, { start: 0, end: entry.size - 1 }),
        signal: controller.signal,
        onChunk: (chunk) => {
          entry.loaded = Math.min(entry.size, entry.loaded + chunk.length);
          if (!entry.gone) this.emit(entry, { progress: true });
        }
      });
      svc.guard(epoch);
      const answer = wire.checkUploaded(res.json);
      if (answer.upload.id !== entry.file) throw new ChatError('server', { where: 'uploaded.upload.id' });
    } finally {
      entry.abort = null;
    }
  }

  // DELETE /uploads/{f}, best effort: a reservation nobody will send goes, so it no longer counts against the
  // workspace's files.
  cancelOnServer(entry) {
    const file = entry.file;
    if (!file || !this.svc.store) return;
    this.svc.call(entry.ws, 'DELETE', `/conversations/${entry.conversation}/uploads/${file}`).catch(() => {});
  }

  forgetEntry(entry, { cancel }) {
    entry.gone = true;
    this.staged.delete(entry.stage);
    if (entry.abort) entry.abort();
    if (cancel) this.cancelOnServer(entry);
    if (entry.temp && entry.path) removeQuietly(entry.path);
  }

  // chatUnstage: the file leaves the tray, its upload is cancelled, and a draft that kept it lets it go.
  unstage(stage) {
    const entry = this.staged.get(stage);
    if (!entry) return true;
    this.forgetEntry(entry, { cancel: true });
    const store = this.svc.store;
    if (store && entry.file) {
      try {
        const draft = store.getDraft(entry.ws, entry.conversation, entry.root);
        if (draft && draft.attachments.some((f) => f.id === entry.file)) {
          store.putDraft(entry.ws, entry.conversation, entry.root, { ...draft, attachments: draft.attachments.filter((f) => f.id !== entry.file) });
        }
      } catch (err) {
        this.svc.hookFailed(err);
      }
    }
    this.emit(entry);
    return true;
  }

  // chatRetryStage: a failed file starts again from where it failed; others answer as they are.
  retry(stage) {
    const entry = this.staged.get(stage);
    if (!entry) throw new ChatError('not_found');
    if (entry.state !== 'failed') return this.view(entry);
    if (!entry.path) throw new ChatError('invalid', { field: 'stage' });
    entry.error = null;
    entry.loaded = 0;
    entry.state = entry.sha256 ? 'uploading' : 'measuring';
    entry.epoch = this.svc.epoch;
    this.emit(entry);
    this.run(entry);
    return this.view(entry);
  }

  // ---- sending and drafts ----

  // The File objects of a message's attachments: each ID a ready staged file of the same room and root, or a file the
  // stored draft of it keeps that hasn't expired. Throws invalid attachments otherwise.
  forSend(ws, c, root, ids) {
    if (!ids.length) return [];
    if (!this.svc.capabilities().includes('files')) throw new ChatError('files_off');
    const ready = new Map();
    for (const e of this.entries(ws, c, root)) if (e.state === 'ready' && e.file) ready.set(e.file, e);
    const draft = this.svc.store.getDraft(ws, c, root);
    const kept = new Map((draft ? draft.attachments : []).filter((f) => !(f.expiresAt <= this.serverNow())).map((f) => [f.id, f]));
    return ids.map((id) => {
      const e = ready.get(id);
      if (e) return fileOf(e);
      const f = kept.get(id);
      if (f) return fileOf(f);
      throw new ChatError('invalid', { field: 'attachments' });
    });
  }

  // After the message with these files is on disk: they leave the tray, bound to it now.
  consume(ws, c, root, ids) {
    if (!ids.length) return;
    let any = null;
    for (const e of this.entries(ws, c, root)) {
      if (!e.file || !ids.includes(e.file)) continue;
      this.forgetEntry(e, { cancel: false });
      any = e;
    }
    if (any) this.emit(any);
  }

  // A draft's kept files as it is read: those whose upload expired go, from the tray too, and the rest are staged
  // again as ready, so the tray shows them and chatSend takes them. Returns { attachments, expired }.
  restore(ws, c, root, attachments) {
    const list = Array.isArray(attachments) ? attachments : [];
    const now = this.serverNow();
    const expired = (f) => Number.isSafeInteger(f.expiresAt) && f.expiresAt <= now;
    let changed = null;
    for (const e of this.entries(ws, c, root)) {
      if (e.state !== 'ready' || !expired(e)) continue;
      this.forgetEntry(e, { cancel: false });
      changed = e;
    }
    const kept = list.filter((f) => !expired(f));
    const have = new Set(this.entries(ws, c, root).map((e) => e.file).filter(Boolean));
    for (const f of kept) {
      if (have.has(f.id)) continue;
      const entry = {
        stage: wire.localId(),
        key: stagedKey(ws, c, root),
        ws,
        conversation: c,
        root: root || null,
        name: f.name,
        type: f.type,
        size: f.size,
        width: f.width ?? null,
        height: f.height ?? null,
        state: 'ready',
        loaded: f.size,
        file: f.id,
        error: null,
        thumb: null,
        expiresAt: f.expiresAt ?? null,
        epoch: this.svc.epoch,
        path: null,
        temp: false,
        sha256: null,
        put: null,
        abort: null,
        gone: false
      };
      this.staged.set(entry.stage, entry);
      changed = entry;
    }
    if (changed) this.emit(changed);
    return { attachments: kept, expired: list.length - kept.length };
  }

  // ---- downloads ----

  // chatFile: the file downloaded (or found in the cache), then viewed, opened or saved.
  async file(ws, c, fileId, action) {
    this.room(ws, c);
    const local = await this.fetch(ws, c, fileId);
    if (action === 'view') return { url: this.viewLink(ws, c, fileId, local) };
    if (action === 'save') return this.saveAs(local);
    // open
    if (RISKY.test(safeName(local.name))) {
      const choice = typeof this.host.askRisky === 'function' ? await this.host.askRisky(safeName(local.name)) : 'cancel';
      return choice === 'save' ? this.saveAs(local) : false;
    }
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rukoo-chat-'));
    const copy = path.join(dir, safeName(local.name));
    await fsp.copyFile(local.path, copy);
    markOfTheWeb(copy);
    if (typeof this.host.openPath !== 'function') return true;
    const err = await this.host.openPath(copy);
    if (err) throw new ChatError('server', { cause: new Error(String(err)) });
    return true;
  }

  async saveAs(local) {
    if (typeof this.host.saveDialog !== 'function') return false;
    const target = await this.host.saveDialog(safeName(local.name));
    if (!target) return false;
    await fsp.copyFile(local.path, target);
    markOfTheWeb(target);
    return true;
  }

  viewLink(ws, room, file, local) {
    const token = crypto.randomBytes(18).toString('base64url');
    this.views.set(token, { ws, room, file, path: local.path, type: local.type, name: local.name, sha256: local.sha256, epoch: this.svc.epoch });
    while (this.views.size > VIEWS_MAX) this.views.delete(this.views.keys().next().value);
    return `${VIEW_SCHEME}://view/${token}`;
  }

  // What main.js's rukoo-chat-file: handler serves for a URL: { path, type, name } of a file this session fetched and
  // still has, or null. The link's own file must still be in the cache, of the same room and with the same digest: a
  // removed message's file, or another file with the same bytes, doesn't keep it working. type is the file's own only
  // for the image types the viewer shows.
  serve(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    if (u.protocol !== `${VIEW_SCHEME}:` || u.hostname !== 'view') return null;
    const token = u.pathname.replace(/^\/+/, '');
    const v = this.views.get(token);
    if (!v || v.epoch !== this.svc.epoch || !this.svc.store) return null;
    const row = this.svc.store.getCachedFile(v.ws, v.file);
    if (!row || row.room !== v.room || row.sha256 !== v.sha256 || !fs.existsSync(v.path)) return null;
    return { path: v.path, type: VIEW_TYPES.has(v.type) ? v.type : 'application/octet-stream', name: v.name };
  }

  // The file on this computer: { path, name, type, size, sha256 }. One download per file and room at a time.
  fetch(ws, c, fileId) {
    const key = `${ws}\n${c}\n${fileId}`;
    const running = this.downloads.get(key);
    if (running && running.epoch === this.svc.epoch) return running.promise;
    const entry = { epoch: this.svc.epoch, promise: null };
    entry.promise = this.fetchOnce(ws, c, fileId).finally(() => {
      if (this.downloads.get(key) === entry) this.downloads.delete(key);
    });
    this.downloads.set(key, entry);
    return entry.promise;
  }

  // The cache answers by itself only for a file of a message it holds, live, in that room. Anything else asks the
  // server first, which checks that the person may still see the file, and is downloaded unless this computer holds
  // those bytes whole already. A download is kept only when, as it lands, the room still has the grant it started
  // under and a message the cache held with the file at the start is still cached and not removed; else it goes, as
  // not_found, since the removal's cleanup may have run before its row existed.
  async fetchOnce(ws, c, fileId) {
    const svc = this.svc;
    const epoch = svc.epoch;
    const store = this.store();
    const dir = this.dir();
    const grant = store.getRoom(ws, c).grantId;
    const known = store.messageWithFile(ws, c, fileId);
    const row = store.getCachedFile(ws, fileId);
    if (row) {
      const local = path.join(dir, row.sha256);
      if (!(await this.intact(local, row.size, row.sha256))) store.deleteCachedFile(ws, fileId);
      else if (known && row.room === c && row.message === known.message && svc.epoch === epoch && svc.store === store) {
        // Read again after the disk check: the hit holds only while the grant, the live message and the row stay.
        const r = store.getRoom(ws, c);
        const holder = store.messageWithFile(ws, c, fileId);
        const again = store.getCachedFile(ws, fileId);
        if (r && r.grantId === grant && holder && holder.message === known.message && again && again.room === c && again.message === row.message && again.sha256 === row.sha256) {
          store.touchCachedFile(ws, fileId);
          return { path: local, name: row.name, type: row.type, size: row.size, sha256: row.sha256 };
        }
      }
    }
    for (let attempt = 0; ; attempt++) {
      const link = wire.checkDownload(await svc.call(ws, 'POST', `/conversations/${c}/files/${fileId}/download`, undefined, { retry: true }));
      svc.guard(epoch);
      if (!this.allowedLink(link.url)) throw new ChatError('server', { where: 'download.url' });
      if (link.size > this.cacheMax) throw new ChatError('too_large', { status: 413 });
      this.landing.add(link.sha256);
      let kept = false;
      try {
        if (!(await this.intact(path.join(dir, link.sha256), link.size, link.sha256))) {
          try {
            await this.fetches(() => this.download(link, dir));
          } catch (raw) {
            const err = chatError(raw);
            // The 60-second link ran out before the request got there: a fresh one, once.
            if (attempt === 0 && err.code === 'expired') continue;
            throw err;
          }
        }
        svc.guard(epoch);
        const now = this.store();
        kept = now.tx(() => {
          const r = now.getRoom(ws, c);
          if (!r || r.grantId !== grant) return false;
          const holder = now.messageWithFile(ws, c, fileId);
          if (known && (!holder || holder.message !== known.message)) return false;
          now.putCachedFile({ ws, room: c, file: fileId, message: holder ? holder.message : null, sha256: link.sha256, size: link.size, name: link.name, type: link.type });
          return true;
        });
      } finally {
        this.landing.delete(link.sha256);
      }
      if (!kept) {
        this.sweep();
        throw new ChatError('not_found');
      }
      this.verified.add(link.sha256);
      this.trim();
      return { path: path.join(dir, link.sha256), name: link.name, type: link.type, size: link.size, sha256: link.sha256 };
    }
  }

  // Whether the cached file is there whole: its size, and its digest once per session.
  async intact(file, size, sha256) {
    try {
      const stat = await fsp.stat(file);
      if (stat.size !== size) return false;
      if (this.verified.has(sha256)) return true;
      const digest = await hashFile(file);
      if (digest.sha256 !== sha256) return false;
      this.verified.add(sha256);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Streams the link's file to dir/<sha256>, checked for size and digest on the way; nothing is left on a failure.
  async download(link, dir) {
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, link.sha256);
    const part = path.join(dir, `.${crypto.randomBytes(8).toString('hex')}.part`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let sink = null;
    try {
      await transfer(link.url, {
        method: 'GET',
        headers: { accept: '*/*' },
        sink: () => (sink = fs.createWriteStream(part)),
        limit: link.size,
        onChunk: (chunk) => {
          hash.update(chunk);
          size += chunk.length;
        }
      });
      if (size !== link.size || hash.digest('hex') !== link.sha256) throw new ChatError('server', { where: 'download.sha256' });
      await fsp.rename(part, target);
    } catch (err) {
      // The part goes once the stream let go of it (Windows won't delete an open file).
      if (sink) await new Promise((resolve) => (sink.closed ? resolve() : (sink.once('close', resolve), sink.destroy())));
      await removeQuietly(part);
      throw err;
    }
  }

  // At most cacheMax bytes of downloaded files: the least recently used go first.
  trim() {
    const store = this.svc.store;
    if (!store) return;
    const files = store.cachedFiles();
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) {
      if (total <= this.cacheMax) break;
      store.forgetCachedSha(f.sha256);
      total -= f.size;
    }
    this.sweep();
  }

  // Deletes what chat-files/ holds that no row names: files of removed messages and evicted rooms, leftovers of a
  // download that stopped, and files of a cache that couldn't be deleted whole.
  sweep() {
    const store = this.svc.store;
    if (!store) return;
    let names;
    const dir = this.dir();
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return;
    }
    for (const name of names) {
      if (name.endsWith('.part') && this.downloads.size) continue;
      if (this.landing.has(name)) continue;
      if (wire.patterns.SHA256.test(name) && store.hasCachedSha(name)) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true, recursive: true });
      } catch (_) {
        // Held by another process; the next sweep tries again.
      }
      this.verified.delete(name);
    }
  }

  // ---- hooks ----

  // The cache opened for a session: leftovers of before go.
  onOpened() {
    this.sweep();
    const store = this.svc.store;
    if (!store) return;
    // Staged bytes of an earlier run: a restart drops files that weren't ready (rich contract 4.6).
    try {
      fs.rmSync(uploadsDir(store.file), { recursive: true, force: true });
    } catch (_) {
      // Held; the next start tries again.
    }
  }

  // Messages of the room were removed: their downloaded files go.
  onRemoved(ws, room, ids) {
    const store = this.svc.store;
    if (!store || !Array.isArray(ids) || !ids.length) return;
    if (store.dropCachedFilesOf(ws, ids)) this.sweep();
  }

  // The person lost the room: its staged files and downloads go (the rows went with the room).
  onEvicted(ws, room) {
    for (const e of [...this.staged.values()]) if (e.ws === ws && e.conversation === room) this.forgetEntry(e, { cancel: false });
    this.sweep();
  }

  onWorkspaceGone(ws) {
    for (const e of [...this.staged.values()]) if (e.ws === ws) this.forgetEntry(e, { cancel: false });
    for (const [token, v] of this.views) if (v.ws === ws) this.views.delete(token);
    this.sweep();
  }

  // The session ended: transfers stop, staged files and links go. The cache's wipe deletes the folders.
  clear() {
    for (const e of [...this.staged.values()]) this.forgetEntry(e, { cancel: false });
    for (const e of this.emits.values()) if (e.timer) this.svc.timers.clearTimeout(e.timer);
    this.emits.clear();
    this.picked.clear();
    this.views.clear();
    this.verified.clear();
  }

  close() {
    this.closed = true;
    this.clear();
  }
}

// A File object (rich contract 2.2) of a staged entry or a draft's file.
function fileOf(f) {
  const out = { id: f.file || f.id, name: f.name, type: f.type, size: f.size };
  if (f.width && f.height) Object.assign(out, { width: f.width, height: f.height });
  return out;
}

module.exports = { Files, imageInfo, typeFromName, nameOf, transfer, VIEW_SCHEME, VIEW_TYPES };
