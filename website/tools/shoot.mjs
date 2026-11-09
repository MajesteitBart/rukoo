// Screenshots every section at desktop and phone width for review, and reports console errors.
// Usage: node tools/shoot.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:4321';
const out = process.argv[3] || 'tmp/shots-review';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${out}/${name}-00-hero.png` });
  const ids = await page.$$eval('main > section[id]:not([hidden])', (els) => els.map((e) => e.id));
  let i = 1;
  for (const id of ids.slice(1)) {
    await page.$eval(`#${id}`, (el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(id === 'agents' ? 400 : 1100);
    if (id === 'agents') {
      await page.$eval('[data-demo]', (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.waitForTimeout(7000);
    }
    await page.screenshot({ path: `${out}/${name}-${String(i++).padStart(2, '0')}-${id}.png` });
  }
  await page.goto(base + '/does-not-exist', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}-99-404.png` });
  console.log(name, 'sections:', ids.join(','), '| errors:', errors.filter((e) => !/404|media\//.test(e)).join(' / ') || 'none');
  await page.close();
}
await browser.close();
