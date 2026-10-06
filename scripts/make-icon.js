// Renders build/icon.png (512x512) from an inline SVG using an offscreen Electron window.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6a4d"/><stop offset="1" stop-color="#e8402a"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="150" fill="url(#g)"/>
  <rect x="116" y="156" width="280" height="200" rx="34" fill="none" stroke="#fff" stroke-width="30"/>
  <path d="M128 176 256 268 384 176" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,<html><body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body></html>`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.resize({ width: 512, height: 512 }).toPNG());
  console.log(`wrote ${out}`);
  app.quit();
});
