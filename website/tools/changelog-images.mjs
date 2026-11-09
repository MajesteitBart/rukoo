// Builds the changelog screenshots from assets-src/changelog/*.png as AVIF
// and WebP at two widths, like tools/images.mjs does for the landing page.
// Sources and their GitHub origin are listed in assets-src/changelog/sources.json.
// Run after adding screenshots, then run tools/build-changelog.mjs.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'assets-src/changelog';
const OUT = 'site/img/changelog';
// 720 and 1440 serve the column (1x and 2x). The native width, when wider,
// is kept as the full-resolution file the click-to-enlarge view opens.
const WIDTHS = [1440, 720];
fs.mkdirSync(OUT, { recursive: true });

const sizes = {};
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.png')).sort()) {
  const name = file.replace(/\.png$/, '');
  const buf = fs.readFileSync(path.join(SRC, file));
  const meta = await sharp(buf).metadata();
  const widths = [...(meta.width > 1440 ? [meta.width] : []), ...WIDTHS.map((w) => Math.min(w, meta.width))].filter(
    (w, i, a) => a.indexOf(w) === i,
  );
  sizes[name] = { w: meta.width, h: meta.height, widths };
  for (const w of widths) {
    const img = sharp(buf).resize({ width: w, withoutEnlargement: true });
    await img.clone().avif({ quality: 62, effort: 6 }).toFile(path.join(OUT, `${name}-${w}.avif`));
    await img.clone().webp({ quality: 84, effort: 6 }).toFile(path.join(OUT, `${name}-${w}.webp`));
  }
}

fs.writeFileSync(path.join(OUT, 'sizes.json'), JSON.stringify(sizes, null, 2));
const files = fs.readdirSync(OUT);
const total = files.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`${Object.keys(sizes).length} screenshots, ${files.length} files, ${(total / 1024).toFixed(0)} KB`);
