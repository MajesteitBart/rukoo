// Writes the booking pages' icons (server/src/icons.js) from the pigeon in src/renderer/assets, rendered in Playwright's
// Chromium: node scripts/make-booking-icons.js
//
// - favicon.svg: rukoo-icon.svg with the head in the dark logo's lighter color when the browser is dark, so the head
//   stays visible on a dark tab bar. Browsers that read SVG icons use this one.
// - favicon.ico: the dark logo at 16 and 32 pixels, for browsers without SVG icons and for /favicon.ico. It can't
//   follow the theme, so it takes the lighter head like build/icon.png does.
// - apple-touch-icon.png: 180 pixels, the pigeon on a white tile as on the Android launcher; iOS draws a transparent
//   icon on black.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'src', 'renderer', 'assets');
const out = path.join(root, 'server', 'src', 'icons');
const HEAD = '#3b4766';
const DARK_HEAD = '#5a6a96';

const light = fs.readFileSync(path.join(assets, 'rukoo-icon.svg'), 'utf8');
const dark = fs.readFileSync(path.join(assets, 'rukoo-icon-dark.svg'), 'utf8');
const shapes = (svg) => svg.match(/<path [^>]*\/>/g).join('\n');
if (!light.includes(`fill="${HEAD}"`) || !dark.includes(`fill="${DARK_HEAD}"`)) {
  throw new Error('The head colors in rukoo-icon.svg and rukoo-icon-dark.svg changed; update HEAD and DARK_HEAD.');
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 268 268">
<style>.head{fill:${HEAD}}@media (prefers-color-scheme:dark){.head{fill:${DARK_HEAD}}}</style>
${shapes(light).replace(`fill="${HEAD}"`, 'class="head"').replace(/#ffffff/g, '#fff')}
</svg>
`;

// The Android launcher's layout (android/app/src/main/res/drawable/ic_launcher_foreground.xml) with its visible 72dp
// mapped onto the tile: the bust and the purple wing carry on below the logo's flat cut to the tile's bottom edge. They
// start a unit above the cut and are drawn over it, and the wing's starts where the bust ends, so no seam shows.
const touch = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">
<rect width="180" height="180" fill="#fff"/>
<g transform="translate(10.9825 15) scale(0.5875)">
${shapes(light)}
<path fill="#bd2dc4" d="M175 267L220.5 267L220.5 300L175 300Z"/>
<path fill="#99c5f4" d="M40.54 267L175.46 267L175.46 300L40.54 300Z"/>
</g>
</svg>`;

// An .ico holding PNG images, which every browser and Windows since Vista read.
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

async function render(browser, svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block}</style><img src="${src}" width="${size}" height="${size}">`);
  await page.locator('img').evaluate((img) => img.decode());
  const data = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return data;
}

(async () => {
  const browser = await chromium.launch();
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'favicon.svg'), favicon);
    const sizes = [16, 32];
    const pngs = [];
    for (const size of sizes) pngs.push({ size, data: await render(browser, dark, size) });
    fs.writeFileSync(path.join(out, 'favicon.ico'), ico(pngs));
    fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), await render(browser, touch, 180));
  } finally {
    await browser.close();
  }
  for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
    console.log(`wrote ${path.relative(root, path.join(out, file))} (${fs.statSync(path.join(out, file)).size} bytes)`);
  }
})();
