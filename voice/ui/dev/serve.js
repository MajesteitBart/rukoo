// Serves voice/ui on 127.0.0.1, so the pages run outside Tauri with their mocks. The pages are ES modules and load
// their catalogs with fetch, and neither works from file://.
//   node voice/ui/dev/serve.js [port]
//   then open http://127.0.0.1:<port>/settings.html?mock=1&page=meetings&theme=dark&lang=nl
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { start };

if (require.main === module) {
  start(Number(process.argv[2]) || 0).then((server) => {
    const { port } = server.address();
    console.log(`Rukoo Voice UI on http://127.0.0.1:${port}/`);
    console.log(`  http://127.0.0.1:${port}/dev/gallery.html`);
    console.log(`  http://127.0.0.1:${port}/settings.html?mock=1`);
  });
}
