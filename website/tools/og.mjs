// Renders tools/og/og.html to site/img/og.png (1200x630), the social card.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL('tools/og/og.html').href);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: 'site/img/og.png' });
await browser.close();
console.log('site/img/og.png');
