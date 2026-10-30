// Behavior checks for the pill and Settings against their mocks: what a user does, and what the app would receive.
// Development only. Runs the repository's Electron through Playwright, off-screen and without taking focus.
//   node voice/ui/dev/check.js
'use strict';

const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const path = require('path');
const { start } = require('./serve.js');

const checks = [];
const check = (name, run) => checks.push({ name, run });

// ---------- Settings ----------

check('a switch saves at once and shows the new state', async ({ open, page, mockState }) => {
  await open('settings.html?mock=1&lang=en&theme=dark');
  const row = page.locator('[data-a="toggle:dictation.readyChime"]');
  assert.equal(await row.getAttribute('aria-checked'), 'false');
  await row.click();
  assert.equal(await row.getAttribute('aria-checked'), 'true');
  assert.equal((await mockState()).config.dictation.readyChime, true);
});

check('a key list greys out the other keys in use and saves the choice', async ({ open, page, mockState }) => {
  await open('settings.html?mock=1&lang=en&theme=dark');
  await page.click('[data-a="choose:dictation.hotkey"]');
  assert.equal(await page.locator('.radio-row', { hasText: 'Right Ctrl' }).isDisabled(), true, 'the rewrite key is taken');
  await page.locator('.radio-row', { hasText: 'F13' }).click();
  assert.equal((await mockState()).config.dictation.hotkey, 'f13');
  await page.waitForSelector('[data-a="choose:dictation.hotkey"] .value:text("F13")');
  assert.match(await page.locator('[data-section="status"]').innerText(), /Hold F13 to dictate/);
});

check('Escape goes back one page, and the back button too', async ({ open, page }) => {
  await open('settings.html?mock=1&lang=en&page=dictionary');
  assert.equal(await page.locator('h1').innerText(), 'Dictionary');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('h1').innerText(), 'Rukoo Voice');
  await page.click('[data-a="go:rukoo"]');
  await page.click('[data-a="back"]');
  assert.equal(await page.locator('h1').innerText(), 'Rukoo Voice');
});

check('text being typed survives the download progress redrawing its card', async ({ open, page }) => {
  await open('settings.html?mock=1&lang=en&page=transcription&scenario=fresh');
  await page.click('[data-a="model:orukeet:download"]');
  const minutes = page.locator('[data-field="local.idleMinutes"]');
  await minutes.click();
  await minutes.press('Control+A');
  for (const key of ['4', '5']) {
    await page.keyboard.type(key);
    await page.waitForTimeout(450);
  }
  // The card redrew at least twice in the meantime (the mock ticks every 300 ms).
  assert.equal(await minutes.inputValue(), '45');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.field), 'local.idleMinutes');
});

check('changing the provider clears the key and asks for consent again', async ({ open, page, mockState }) => {
  await open('settings.html?mock=1&lang=en&page=meetingTranscription&scenario=cloud');
  assert.equal(await page.locator('.key-saved').count(), 1, 'Mistral has a saved key');
  const consent = page.locator('[data-field="meetings.consent"]');
  assert.equal(await consent.isChecked(), false);
  await consent.check();
  await page.selectOption('[data-field="meetings.provider"]', 'openai');
  assert.equal(await page.locator('.key-saved').count(), 0, "Mistral's key isn't offered for OpenAI");
  assert.equal(await page.inputValue('[data-field="meetings.endpoint"]'), 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(await page.inputValue('[data-field="meetings.model"]'), '');
  assert.equal(await page.locator('[data-field="meetings.consent"]').isChecked(), false, 'consent was for another provider');
  assert.match(await page.locator('.consent').innerText(), /api\.openai\.com/);
  await page.selectOption('[data-field="meetings.provider"]', 'orukeet');
  assert.equal(await page.locator('.consent').count(), 0, 'Orukeet keeps the audio here');
  assert.equal((await mockState()).config.meetings.provider, 'mistral', 'nothing saved without Save');
});

check('consent is saved per provider and host, and the top page stops waiting', async ({ open, page, mockState }) => {
  await open('settings.html?mock=1&lang=en&page=meetingTranscription&scenario=cloud');
  await page.locator('[data-field="meetings.consent"]').check();
  await page.click('[data-a="save:meetings"]');
  await page.waitForSelector('.form-status.ok');
  assert.deepEqual((await mockState()).config.meetings.consent, { provider: 'mistral', host: 'api.mistral.ai' });
  const save = await page.evaluate(() => window.__lastSave);
  assert.equal(save.apiKey, null, 'the saved key is kept, never sent back');
  await page.fill('[data-field="meetings.endpoint"]', 'https://eu.api.mistral.ai/v1/audio/transcriptions');
  await page.locator('[data-field="meetings.endpoint"]').blur();
  assert.equal(await page.locator('[data-field="meetings.consent"]').isChecked(), false, 'another host asks again');
  await page.keyboard.press('Escape');
  assert.doesNotMatch(await page.locator('[data-section="meetings"]').innerText(), /Waiting for your consent/);
});

check('Save refuses a cloud provider without a model, with Ownkey\'s message', async ({ open, page }) => {
  await open('settings.html?mock=1&lang=en&page=transcription');
  await page.selectOption('[data-field="transcription.provider"]', 'mistral');
  await page.click('[data-a="save:transcription"]');
  assert.match(await page.locator('.form-status').innerText(), /Choose an audio endpoint and model before saving\./);
});

check('a model list that arrives after the endpoint changed is dropped', async ({ open, page }) => {
  await open('settings.html?mock=1&lang=en&page=rewriting');
  await page.click('[data-a="refresh:rewriting"]');
  await page.fill('[data-field="rewriting.endpoint"]', 'http://localhost:9999/v1/chat/completions');
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('[data-form="rewriting"] .field-help').count(), 0);
  assert.equal(await page.locator('#models-rewriting option').count(), 0);
});

check('the dictionary follows Ownkey\'s rules', async ({ open, page, mockState }) => {
  await open('settings.html?mock=1&lang=en&page=dictionary');
  await page.fill('[data-field="dict.word"]', '  rukoo  ');
  await page.press('[data-field="dict.word"]', 'Enter');
  const words = (await mockState()).config.dictionary.vocabulary;
  assert.deepEqual(words.filter((w) => w.toLowerCase() === 'rukoo'), ['rukoo'], 'replaced case-insensitively, not duplicated');
  await page.click('[data-a="dict-mode"]');
  await page.fill('[data-field="dict.from"]', 'Same');
  await page.fill('[data-field="dict.to"]', 'Same');
  await page.click('[data-a="dict-add"]');
  assert.match(await page.locator('[role="alert"]').innerText(), /The two spellings are identical\./);
  await page.click('[data-a^="dict-remove:fix:rocco"]');
  assert.equal((await mockState()).config.dictionary.corrections.some((c) => c.from === 'rocco'), false);
});

check('a model in Ownkey\'s folder offers no Remove download', async ({ open, page }) => {
  await open('settings.html?mock=1&lang=en&page=transcription');
  assert.equal(await page.locator('[data-a="model:orukeet:remove"]').count(), 0);
  assert.match(await page.locator('.model-card').innerText(), /Shared with Ownkey\. Remove it in Ownkey\./);
});

check('a development copy can\'t import or start at login', async ({ open, page }) => {
  await open('settings.html?mock=1&lang=en&scenario=dev');
  assert.equal(await page.locator('[data-a="toggle:dictation.startAtLogin"]').isDisabled(), true);
  await page.click('[data-a="go:import"]');
  assert.equal(await page.locator('[data-a="import"]').isDisabled(), true);
  assert.match(await page.locator('.page-actions').innerText(), /--import-ownkey <copy>/);
});

check('Dutch is complete on every page', async ({ open, page }) => {
  for (const name of ['main', 'transcription', 'dictionary', 'fillers', 'rewriting', 'meetingTranscription', 'storage', 'rukoo', 'import']) {
    await open(`settings.html?mock=1&lang=nl&scenario=cloud&page=${name}`);
    const text = await page.locator('.page').innerText();
    for (const english of ['Settings', 'Save', 'Transcription', 'Dictionary', 'Rewriting', 'Storage', 'Connection', 'Import from']) {
      assert.ok(!new RegExp(`\\b${english}\\b`).test(text), `"${english}" on the Dutch ${name} page`);
    }
  }
});

// ---------- the pill ----------

check('the pill reports the stop button for the native window, and null without one', async ({ open, page }) => {
  await open('pill.html?mock=meeting-recording&lang=en');
  await page.waitForTimeout(400);
  let layout = await page.evaluate(() => window.__pillLayout);
  // 28px, rounded outwards: the centred pill can start at a fractional x.
  assert.ok([28, 29].includes(layout.button.width), `width ${layout.button.width}`);
  assert.equal(layout.button.height, 28);
  assert.equal(layout.button.y, 28, '4px inside a 36px pill that starts 24px down');
  assert.ok(layout.button.x + layout.button.width <= layout.pill.x + layout.pill.width - 3, 'inside the pill, 4px from its end');
  await page.click('.stop');
  await page.waitForTimeout(400);
  layout = await page.evaluate(() => window.__pillLayout);
  assert.ok(layout.button.width > 40, 'the widened Stop? button is reported');
  await open('pill.html?mock=listening&lang=en');
  await page.waitForTimeout(400);
  layout = await page.evaluate(() => window.__pillLayout);
  assert.equal(layout.button, null);
});

check('two clicks stop a meeting; one only asks', async ({ open, page }) => {
  await open('pill.html?mock=meeting-recording&lang=en');
  await page.click('.stop');
  await page.waitForSelector('.stop.confirm');
  assert.equal(await page.locator('.stop-label').innerText(), 'Stop?');
  await page.click('.stop');
  await page.waitForSelector('.label:text("Saving")');
});

check('a snapshot with the wrong shape is ignored, an older one too', async ({ open, page }) => {
  await open('pill.html?mock=listening&lang=en');
  await page.evaluate(() => {
    window.__pillMock.emit('pill://snapshot', { seq: 999, visible: true, phase: 'exploding' });
    window.__pillMock.emit('pill://snapshot', { seq: 0, visible: false, phase: 'hidden', activity: 'dictate', edge: 'bottom', theme: 'dark', locale: 'en' });
  });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.label:not(.out)').innerText(), 'Listening');
});

check('an unknown notice falls back instead of breaking the pill', async ({ open, page }) => {
  await open('pill.html?mock=listening&lang=en');
  await page.evaluate(() =>
    window.__pillMock.emit('pill://snapshot', { seq: 50, visible: true, phase: 'error', activity: 'dictate', notice: { key: 'pill.error.fromTheFuture', args: {} }, edge: 'bottom', theme: 'dark', locale: 'en' })
  );
  await page.waitForSelector('.label.error:text("Try again")');
});

check('the meeting clock ticks from atMs and shows hours from an hour on', async ({ open, page }) => {
  await open('pill.html?mock=meeting-long&lang=en');
  const first = await page.locator('.time').innerText();
  assert.match(first, /^1:02:3\d$/);
  await page.waitForTimeout(1200);
  assert.notEqual(await page.locator('.time').innerText(), first);
});

check('with reduced motion the level still shows, in three steps', async ({ open, page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  try {
    await open('pill.html?mock=listening-sound&lang=en');
    await page.waitForTimeout(1500);
    const scales = await page.$$eval('.bar', (bars) => bars.map((bar) => bar.style.transform));
    assert.ok(scales.every((s) => ['scaleY(0.35)', 'scaleY(0.6)', 'scaleY(1)'].includes(s)), scales.join());
    assert.equal(await page.$eval('.bar', (bar) => getComputedStyle(bar).animationName), 'none');
    // The other loops stop too, and their bars rest at their rest heights.
    for (const state of ['arming', 'no-audio', 'transcribing']) {
      await open(`pill.html?mock=${state}&lang=en`);
      const names = await page.$$eval('.bar', (bars) => bars.map((bar) => getComputedStyle(bar).animationName));
      assert.deepEqual([...new Set(names)], ['none'], `${state} still animates`);
    }
    await open('pill.html?mock=transcribing&lang=en');
    assert.equal(await page.$eval('.label', (label) => getComputedStyle(label).backgroundImage), 'none', 'the shimmer stops');
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
});

// ---------- runner ----------

async function main() {
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(__dirname, 'electron-main.js')], env });
  let failed = 0;
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 680));
    const open = async (url) => {
      const pill = url.startsWith('pill');
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), pill ? [384, 100] : [760, 680]);
      await page.goto(base + url);
      // Records what the page sent to settings_save_provider, as the app would receive it.
      if (!pill) {
        await page.waitForSelector('.page-inner .card');
        await page.evaluate(() => {
          window.__lastSave = null;
        });
      } else await page.waitForSelector('.pill');
    };
    const mockState = () => page.evaluate(() => window.__settingsMockState());
    for (const { name, run } of checks) {
      errors.length = 0;
      try {
        await run({ open, page, mockState });
        assert.deepEqual(errors, [], 'page errors');
        console.log(`ok   ${name}`);
      } catch (error) {
        failed += 1;
        console.log(`FAIL ${name}\n     ${String(error.message).split('\n').join('\n     ')}`);
      }
    }
  } finally {
    await app.close();
    server.close();
  }
  console.log(`${checks.length - failed} of ${checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
