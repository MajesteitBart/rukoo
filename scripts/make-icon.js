// Renders build/icon.png (512x512) from the pigeon in src/renderer/assets using an offscreen Electron window.
// It uses the lighter head from the dark logo: the taskbar and Start menu are often dark, and the slate head of
// the light logo disappears there.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'rukoo-icon-dark.svg');
const svg = fs.readFileSync(source, 'utf8');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  // 16px of padding on each side, like the 480px tile of the old icon.
  const html = `<html><body style="margin:0;background:transparent"><div style="padding:16px;width:480px;height:480px">${svg.replace('<svg ', '<svg style="width:100%;height:100%" ')}</div></body></html>`;
  await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.resize({ width: 512, height: 512 }).toPNG());
  console.log(`wrote ${out}`);
  app.quit();
});
