'use strict';

const { t } = require('../i18n');
const { imageType } = require('./logos');
const { safeName } = require('./files');

// The images an email shows, for the reader's context menu: Copy image, Open image and Save image as. An image is a
// data: URL, which is what the parser makes of an inline cid: image, or an address on the web. The frame loaded that
// address already (remote images are not blocked), so the request goes through the window's own session, with its
// cache and proxy: mostly the cache answers, and otherwise the sender sees one more request for an image it served,
// after the user asked for it. Only raster images pass the sniff: SVG can carry script.
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT = 20000;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/x-icon': 'ico' };

function sniff(buf) {
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return imageType(buf);
}

// Base64, or percent escapes standing for the bytes; the sniff below decides what the bytes are.
function fromDataUrl(src) {
  const m = /^data:([^,]*),(.*)$/is.exec(src);
  if (!m) return null;
  if (/;base64$/i.test(m[1])) return Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  return Buffer.from(m[2].replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
}

async function readCapped(res) {
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error(t('errors.image.unavailable'));
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error(t('errors.image.unavailable'));
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// The file name to save under: the last part of the address, with the extension of what the image turned out to be.
function imageName(src, type) {
  let base = '';
  if (/^https?:/i.test(src)) {
    try {
      base = decodeURIComponent(new URL(src).pathname.split('/').pop() || '');
    } catch {
      base = '';
    }
  }
  base = base.replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 100);
  return `${base ? safeName(base) : t('native.image.defaultName')}.${EXT[type]}`;
}

// { content, type, name } for an image's src, or an error the reader shows as it is.
// fetch: the window session's fetch in the app, a fake in the tests.
async function mailImage(src, { fetch: fetchImpl = fetch, timeout = TIMEOUT } = {}) {
  const url = typeof src === 'string' ? src : '';
  let content = null;
  if (/^data:/i.test(url)) content = fromDataUrl(url);
  else if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      content = await readCapped(res);
    } catch {
      throw new Error(t('errors.image.unavailable'));
    }
  }
  if (!content || !content.length) throw new Error(t('errors.image.unsupported'));
  if (content.length > MAX_BYTES) throw new Error(t('errors.image.unavailable'));
  const type = sniff(content);
  if (!type) throw new Error(t('errors.image.unsupported'));
  return { content, type, name: imageName(url, type) };
}

module.exports = { mailImage, imageName, MAX_BYTES };
