// Renders Rukoo Voice's macOS app icon, icon.icns, from mark.js into this folder. Run it from the repository root, in
// a terminal without ELECTRON_RUN_AS_NODE:
//
//   npx electron voice/crates/voice-app/icons/make-icns.js
//
// The macOS icon is its own composition: Apple's rounded square with the mark inside it, 16 to 1024 px. It draws each
// size into a canvas in a hidden window and writes the container itself, so no iconutil or other Mac tool is needed.
// make-icons.js renders the Windows icons and the PNG set; icon.icns is committed, so a build needs neither script.
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { macIconSvg } = require('./mark.js');

const HERE = __dirname;
// The pixel sizes a macOS app icon holds. 32, 64, 128, 256 and 512 px each serve two types, once as they are and
// once as the 2x bitmap of the size below, so there are eleven entries for seven images.
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32], // 16 px at 2x
  ['ic12', 64], // 32 px at 2x
  ['ic13', 256], // 128 px at 2x
  ['ic14', 512], // 256 px at 2x
];

// Draws SVG text into a canvas and returns the PNG.
async function draw(win, svg, size) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const png = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(src)};
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = ${size};
    canvas.height = ${size};
    canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  return Buffer.from(png, 'base64');
}

// An ICNS file: an 8-byte header, then one 8-byte header and the PNG for each type. macOS reads PNG in every one of
// these types, so the PNGs the window renders are the data.
function icns(images) {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const png = images.get(size);
    if (!png) throw new Error(`no ${size} px image for ${type}`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'latin1');
  header.writeUInt32BE(8 + entries.reduce((total, entry) => total + entry.length, 0), 4);
  return Buffer.concat([header, ...entries]);
}

// Reads an ICNS back and checks the container and every PNG's own header, so a wrong size fails here rather than in
// Finder: the magic, the total length, each entry inside the file, and PNGs of the size its type names.
function checkIcns(file, types) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4).toString('latin1') !== 'icns') throw new Error(`${file} doesn't start with icns`);
  if (buf.readUInt32BE(4) !== buf.length) throw new Error(`${file} says it is ${buf.readUInt32BE(4)} bytes, not ${buf.length}`);
  const found = [];
  let offset = 8;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw new Error(`${file}: an entry starts past the end`);
    const type = buf.subarray(offset, offset + 4).toString('latin1');
    const length = buf.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buf.length) throw new Error(`${file}: ${type} runs past the end`);
    const png = buf.subarray(offset + 8, offset + length);
    if (png.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error(`${file}: ${type} is not a PNG`);
    const wanted = types.find(([name]) => name === type);
    if (!wanted) throw new Error(`${file}: has an unexpected ${type} entry`);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width !== wanted[1] || height !== wanted[1]) {
      throw new Error(`${file}: ${type} is ${width} x ${height} instead of ${wanted[1]}`);
    }
    found.push(type);
    offset += length;
  }
  if (found.join() !== types.map(([type]) => type).join()) {
    throw new Error(`${file}: has ${found.join()} instead of ${types.map(([type]) => type).join()}`);
  }
}

app.disableHardwareAcceleration();
// Keep Electron's own profile out of the user's application data.
app.setPath('userData', path.join(require('os').tmpdir(), 'rukoo-voice-make-icns'));
app.whenReady().then(async () => {
  let code = 0;
  try {
    const win = new BrowserWindow({ show: false, width: 64, height: 64 });
    await win.loadURL('data:text/html,<html><body></body></html>');
    const images = new Map();
    for (const size of ICNS_SIZES) images.set(size, await draw(win, macIconSvg(size), size));
    const file = path.join(HERE, 'icon.icns');
    fs.writeFileSync(file, icns(images));
    checkIcns(file, ICNS_TYPES);
    console.log(`wrote Rukoo Voice's macOS icon to ${file}`);
  } catch (e) {
    console.error(e);
    code = 1;
  }
  app.exit(code);
});
