// Screenshots of every pill state and every Settings page, in light and dark, English and Dutch, from the mocks.
// Development only; the images are verification evidence for the GitHub issue and never go into Git.
//   node voice/ui/dev/screenshots.js <outDir> [--scale 1.5] [--only pill|settings]
// Runs the repository's Electron through Playwright with a bare app (electron-main.js) whose window sits off-screen
// and never takes focus. Settings pages are captured at their full height, at 760 or 480 CSS pixels wide.
'use strict';

const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { start } = require('./serve.js');

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const out = path.resolve(args.find((arg, i) => !arg.startsWith('--') && !['--scale', '--only'].includes(args[i - 1])) || 'tmp/voice-ui-shots');
const scale = Number(option('--scale')) || 1.5;
const only = option('--only');

const THEMES = ['light', 'dark'];
const LANGS = ['en', 'nl'];
const PILL_STATES = [
  'arming',
  'listening',
  'listening-sound',
  'listening-edit',
  'no-audio',
  'warning',
  'transcribing',
  'loading-model',
  'rewriting',
  'inserted',
  'inserted-one',
  'rewrote',
  'nothing-heard',
  'error-offline',
  'error-no-key',
  'error-auth',
  'error-timeout',
  'error-mic',
  'error-model',
  'error-model-missing',
  'error-blocked',
  'error-select-text',
  'error-selection-too-long',
  'error-generic',
  'meeting-recording',
  'meeting-compact',
  'meeting-long',
  'meeting-paused',
  'meeting-confirm',
  'meeting-hover',
  'meeting-saving',
  'meeting-failed',
  'meeting-mic-lost',
  'meeting-mic-back',
  'meeting-video-dropped',
  'meeting-dictating'
];
const SETTINGS_PAGES = ['main', 'transcription', 'dictionary', 'fillers', 'rewriting', 'meetingTranscription', 'storage', 'rukoo', 'import'];
// Other states worth seeing: [file name, query].
const SCENARIOS = [
  ['main-fresh', 'page=main&scenario=fresh'],
  ['main-busy', 'page=main&scenario=busy'],
  ['main-failed', 'page=main&scenario=failed'],
  ['main-dev', 'page=main&scenario=dev'],
  ['main-cloud', 'page=meetings&scenario=cloud'],
  ['transcription-missing', 'page=transcription&scenario=fresh'],
  ['transcription-downloading', 'page=transcription&scenario=busy'],
  ['transcription-failed', 'page=transcription&scenario=failed'],
  ['transcription-cloud', 'page=transcription&scenario=cloud'],
  ['meeting-transcription-consent', 'page=meetingTranscription&scenario=cloud'],
  ['dictionary-empty', 'page=dictionary&scenario=fresh'],
  ['rukoo-not-running', 'page=rukoo&scenario=fresh'],
  ['rukoo-outdated', 'page=rukoo&scenario=busy'],
  ['import-never', 'page=import&scenario=fresh'],
  ['import-dev', 'page=import&scenario=dev'],
  ['import-cloud', 'page=import&scenario=cloud'],
  ['later-main', 'page=meetings&later=1'],
  ['later-speakers', 'page=speakers&later=1'],
  ['later-storage-sync', 'page=storage&later=1&sync=1']
];

async function main() {
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(__dirname, 'electron-main.js'), `--force-device-scale-factor=${scale}`], env });
  const problems = [];
  const saved = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (e) => problems.push(`${page.url()}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`${page.url()}: ${m.text()}`));
    const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    const shot = async (file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file });
      saved.push(file);
    };

    if (only !== 'settings') {
      for (const theme of THEMES)
        for (const lang of LANGS) {
          await size(384, 100);
          for (const state of PILL_STATES) {
            await page.goto(`${base}pill.html?mock=${state}&theme=${theme}&lang=${lang}&backdrop=1`);
            await page.waitForSelector('.pill');
            await page.waitForTimeout(650);
            await shot(path.join(out, 'pill', `${theme}-${lang}`, `${state}.png`));
          }
          // Where the app puts the native stop window, from the page's own pill_layout report.
          for (const state of ['meeting-recording', 'meeting-confirm']) {
            await page.goto(`${base}pill.html?mock=${state}&theme=${theme}&lang=${lang}&backdrop=1&hit=1`);
            await page.waitForTimeout(700);
            await shot(path.join(out, 'pill', `${theme}-${lang}`, `${state}-hit.png`));
          }
          await size(1240, 1600);
          await page.goto(`${base}dev/gallery.html?theme=${theme}&lang=${lang}`);
          await page.waitForTimeout(1800);
          await fitHeight(page, size, 1240, 'body');
          await shot(path.join(out, 'pill', `gallery-${theme}-${lang}.png`));
        }
      await size(1240, 1600);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${base}dev/gallery.html?theme=dark&lang=en`);
      await page.waitForTimeout(1800);
      await fitHeight(page, size, 1240, 'body');
      await shot(path.join(out, 'pill', 'gallery-dark-en-reduced-motion.png'));
      await page.emulateMedia({ reducedMotion: null });
    }

    if (only !== 'pill') {
      const settings = async (file, query, width = 760) => {
        await size(width, 680);
        await page.goto(`${base}settings.html?mock=1&${query}`);
        await page.waitForSelector('.page-inner .card');
        await page.waitForTimeout(500);
        await fitHeight(page, size, width, '.page-inner', 52 + 4 + 48);
        await shot(file);
      };
      for (const theme of THEMES)
        for (const lang of LANGS) {
          for (const name of SETTINGS_PAGES) await settings(path.join(out, 'settings', `${theme}-${lang}`, `${name}.png`), `page=${name}&theme=${theme}&lang=${lang}`);
          for (const [name, query] of SCENARIOS) await settings(path.join(out, 'settings', `${theme}-${lang}`, `${name}.png`), `${query}&theme=${theme}&lang=${lang}`);
        }
      // A narrow window, at Settings' minimum width.
      for (const [theme, lang] of [
        ['dark', 'nl'],
        ['light', 'en'],
        ['light', 'nl']
      ]) {
        for (const [name, query] of [
          ['main', 'page=main&scenario=busy'],
          ['transcription', 'page=transcription&scenario=busy'],
          ['meeting-transcription', 'page=meetingTranscription&scenario=cloud'],
          ['dictionary', 'page=dictionary'],
          ['rukoo', 'page=rukoo'],
          ['import', 'page=import&scenario=cloud']
        ])
          await settings(path.join(out, 'settings', `narrow-${theme}-${lang}`, `${name}.png`), `${query}&theme=${theme}&lang=${lang}`, 480);
      }
      // Dialogs, opened the way a user opens them.
      for (const [theme, lang] of [
        ['dark', 'en'],
        ['light', 'nl']
      ]) {
        const dir = path.join(out, 'settings', `dialogs-${theme}-${lang}`);
        await size(760, 680);
        await page.goto(`${base}settings.html?mock=1&page=main&scenario=busy&theme=${theme}&lang=${lang}`);
        await page.waitForSelector('.page-inner .card');
        await page.click('[data-a="choose:dictation.hotkey"]');
        await page.waitForTimeout(300);
        await shot(path.join(dir, 'dictation-key.png'));
        await page.keyboard.press('Escape');
        await page.click('[data-a="licenses"]');
        await page.waitForTimeout(300);
        await shot(path.join(dir, 'licenses.png'));
        await page.keyboard.press('Escape');
        await page.goto(`${base}settings.html?mock=1&page=import&theme=${theme}&lang=${lang}`);
        await page.waitForSelector('.page-inner .card');
        await page.click('[data-a="import"]');
        await page.waitForTimeout(300);
        await shot(path.join(dir, 'import-again.png'));
        await page.keyboard.press('Escape');
        // A provider form after Refresh, and after a failed save.
        await page.goto(`${base}settings.html?mock=1&page=rewriting&theme=${theme}&lang=${lang}`);
        await page.waitForSelector('[data-a="refresh:rewriting"]');
        await page.click('[data-a="refresh:rewriting"]');
        await page.waitForTimeout(1000);
        await page.fill('[data-field="rewriting.model"]', 'fail');
        await page.click('[data-a="save:rewriting"]');
        await page.waitForTimeout(900);
        await fitHeight(page, size, 760, '.page-inner', 52 + 4 + 48);
        await shot(path.join(dir, 'rewriting-save-failed.png'));
        await size(760, 680);
        await page.click('[data-a="details:rewriting"]');
        await page.waitForTimeout(300);
        await shot(path.join(dir, 'rewriting-error-details.png'));
        await page.keyboard.press('Escape');
        // A dictionary entry that's refused.
        await page.goto(`${base}settings.html?mock=1&page=dictionary&theme=${theme}&lang=${lang}`);
        await page.waitForSelector('[data-a="dict-mode"]');
        await page.click('[data-a="dict-mode"]');
        await page.fill('[data-field="dict.from"]', 'rukoo');
        await page.click('[data-a="dict-add"]');
        await page.waitForTimeout(200);
        await shot(path.join(dir, 'dictionary-error.png'));
      }
    }
  } finally {
    await app.close();
    server.close();
  }
  console.log(`${saved.length} screenshots in ${out}`);
  if (problems.length) {
    console.log(`Page errors:\n${[...new Set(problems)].join('\n')}`);
    process.exitCode = 1;
  }
}

// Grows the window to the content's full height, so one image shows the whole page.
async function fitHeight(page, size, width, selector, extra = 40) {
  const height = await page.evaluate((sel) => Math.ceil(document.querySelector(sel).scrollHeight), selector);
  await size(width, Math.min(4000, height + extra));
  await page.waitForTimeout(250);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
