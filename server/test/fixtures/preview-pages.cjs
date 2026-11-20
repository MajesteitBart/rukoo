'use strict';

// Web pages for link card tests, served on 127.0.0.1 by Node: the server's tests reach it through
// WORKSPACE_PREVIEW_HOSTS (test/fixtures/preview-server.js), and so does the desktop's real-server helper
// (test/fixtures/real-server.js at the repository root). It needs nothing outside Node.
//
//   const pages = await startPreviewServer();
//   const url = pages.page({ title: 'A & B', description: 'About it', image: { width: 1200, height: 630 } });
//   pages.hits('/p/…');   // how often a path was asked for
//   await pages.close();
//
// A test in the Workers runtime can't call page() in this process, so it registers a page over HTTP: POST /pages with
// the same JSON answers { url }. GET /hits?path=… answers { hits }.
//
// Other paths: /redirect?to=<address> (302), /chain/<n> (n redirects in a row, then a page), /text (text/plain with
// card tags in it), /missing (404 with a title), /big.png (3 MiB of image/png) and /image.svg (image/svg+xml).

const crypto = require('crypto');
const http = require('http');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A real PNG of one colour, width by height pixels.
function png(width, height, [r, g, b] = [80, 120, 200]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const esc = (s) => String(s).replace(/&(?![#a-zA-Z0-9]+;)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// A page's HTML from a spec. Values are put into attributes as given, character references included, so a test can
// check that they are decoded: { title, description, site, image, video, type, titleTag }.
function html(spec, base) {
  const meta = [];
  const tag = (property, content) => meta.push(`<meta property="${property}" content="${esc(content)}">`);
  if (spec.title !== undefined && spec.title !== null) tag('og:title', spec.title);
  if (spec.description !== undefined && spec.description !== null) meta.push(`<meta name="description" content="${esc(spec.description)}">`);
  if (spec.site) tag('og:site_name', spec.site);
  if (spec.type) tag('og:type', spec.type);
  if (spec.video) tag('og:video', `${base}/video.mp4`);
  if (spec.imageUrl) tag('og:image', spec.imageUrl);
  const title = spec.titleTag !== undefined ? `<title>${spec.titleTag}</title>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">${title}${meta.join('')}</head><body><p>${esc(spec.body ?? 'A page for link card tests.')}</p></body></html>`;
}

async function startPreviewServer() {
  const pages = new Map();
  const images = new Map();
  const counts = new Map();
  let origin = '';

  // Registers a page and answers its address. image: true for a 64 by 32 PNG, { width, height } for one of that size,
  // or a string: an address of an image elsewhere, written into og:image as it is (relative ones too).
  function page(spec = {}) {
    const id = crypto.randomBytes(6).toString('hex');
    const entry = { ...spec };
    if (spec.image === true || (spec.image && typeof spec.image === 'object')) {
      const { width = 64, height = 32 } = spec.image === true ? {} : spec.image;
      images.set(`/p/${id}.png`, png(width, height));
      entry.imageUrl = `${origin}/p/${id}.png`;
    } else if (typeof spec.image === 'string') {
      entry.imageUrl = spec.image;
    }
    pages.set(`/p/${id}`, entry);
    return `${origin}/p/${id}`;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1);
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...headers });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/pages') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let spec;
        try {
          spec = JSON.parse(body || '{}');
        } catch {
          return send(400, 'application/json', '{"error":"invalid"}');
        }
        send(200, 'application/json', JSON.stringify({ url: page(spec) }));
      });
      return;
    }
    if (url.pathname === '/hits') return send(200, 'application/json', JSON.stringify({ hits: counts.get(url.searchParams.get('path')) || 0 }));
    if (pages.has(url.pathname)) {
      const spec = pages.get(url.pathname);
      return send(spec.status || 200, spec.contentType || 'text/html; charset=utf-8', html(spec, origin));
    }
    if (images.has(url.pathname)) return send(200, 'image/png', images.get(url.pathname));
    if (url.pathname === '/redirect') return send(302, 'text/plain', '', { location: url.searchParams.get('to') || '/' });
    const chain = /^\/chain\/(\d+)$/.exec(url.pathname);
    if (chain) {
      const n = Number(chain[1]);
      if (n > 0) return send(302, 'text/plain', '', { location: `/chain/${n - 1}` });
      return send(200, 'text/html', html({ title: 'End of the chain' }, origin));
    }
    if (url.pathname === '/text') return send(200, 'text/plain', html({ title: 'Plain text' }, origin));
    if (url.pathname === '/missing') return send(404, 'text/html', html({ title: 'Not found' }, origin));
    if (url.pathname === '/big.png') return send(200, 'image/png', Buffer.concat([png(1, 1), Buffer.alloc(3 * 1024 * 1024)]));
    if (url.pathname === '/image.svg') return send(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    send(404, 'text/plain', 'not here');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // Ends with the test run even when nobody closes it.
  server.unref();
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    host: `127.0.0.1:${port}`,
    page,
    hits: (path) => counts.get(path) || 0,
    // The Worker's fetches may leave keep-alive connections open, which would hold close() until they time out.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}

module.exports = { startPreviewServer, png };
