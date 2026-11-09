// Builds the page's images from the app's own screenshots: full frames and crops, as AVIF and WebP
// at two widths. Crops are in source pixels of the 2423x1512 (or 2403x1502) captures.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'assets-src/shots';
const OUT = 'site/img';
fs.mkdirSync(OUT, { recursive: true });

// name, source, crop [left, top, width, height] or null, output widths
const jobs = [
  ['hero-dark', 'dark/02-inbox.png', null, [2400, 1200]],
  ['hero-light', 'light/02-inbox.png', null, [2400, 1200]],
  ['list-folded', 'dark/04-reader.png', [0, 0, 957, 1190], [960, 480]],
  ['list-open', 'dark/06-stack-open.png', [0, 0, 957, 1190], [960, 480]],
  ['calendar', 'dark/14-calendar-event.png', null, [2400, 1200]],
  // The walkthrough's captures (tmp/walkthrough in the Rukoo repo): 2x screencast frames and stills, demo data.
  ['cat-sidebar', 'story/categories-needs-you.png', [0, 0, 1270, 1240], [1270, 640]],
  ['cat-describe', 'story/categories-settings.png', [820, 100, 1560, 1180], [1560, 780]],
  ['cat-jev', 'story/categories-jev.png', [820, 880, 1560, 560], [1560, 780]],
  ['agent-draft', 'story/agent-rewrite.png', [930, 40, 2268, 1700], [2260, 1130]],
  ['book-page', 'story/booking-page-top.png', [560, 40, 1760, 1160], [1760, 880]],
  ['book-settings', 'story/settings-booking-top.png', [840, 40, 1500, 1400], [1500, 750]],
  ['book-event', 'story/arrival-agent-card.png', [2072, 828, 736, 964], [736, 368]],
  ['phone-agent', 'story/android-agent.png', null, [1300, 650]],
];

const sizes = {};
for (const [name, src, crop, widths] of jobs) {
  let base = sharp(path.join(SRC, src));
  if (crop) base = base.extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] });
  const buf = await base.png().toBuffer();
  const meta = await sharp(buf).metadata();
  sizes[name] = { w: meta.width, h: meta.height };
  for (const w of widths) {
    const width = Math.min(w, meta.width);
    const img = sharp(buf).resize({ width, withoutEnlargement: true });
    await img.clone().avif({ quality: 62, effort: 6 }).toFile(path.join(OUT, `${name}-${w}.avif`));
    await img.clone().webp({ quality: 84, effort: 6 }).toFile(path.join(OUT, `${name}-${w}.webp`));
  }
}

// Icons for the browser tab and home screens.
await sharp('site/assets/rukoo-icon.svg', { density: 400 }).resize(180, 180, { fit: 'contain', background: '#08090a' }).png().toFile(path.join(OUT, 'apple-touch-icon.png'));
await sharp('site/assets/rukoo-icon.svg', { density: 200 }).resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(OUT, 'favicon-32.png'));

fs.writeFileSync(path.join(OUT, 'sizes.json'), JSON.stringify(sizes, null, 2));
const total = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(JSON.stringify(sizes), `\n${fs.readdirSync(OUT).length} files, ${(total / 1024).toFixed(0)} KB`);
