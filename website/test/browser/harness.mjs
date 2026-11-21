// The setup the browser tests share. Both production Workers run in wrangler's local runtime (createTestHarness from
// server/node_modules): the site Worker with its real ASSETS from a fresh app build and its ACCOUNT service binding to
// the account server, so /join's redirect, the app's CSP headers, same-origin /v1 and the wake socket are the real
// ones. Chromium runs headless. Every harness has its own storage, a random PEPPER, and no metrics or cf.json fetch.
//
// People other than the ones the test drives are made through the server's own API: an account the page can sign in
// to with makeAccount (src/web/account's key derivation, from Node), the rest with test/fixtures/real-server.js's
// seeding against the harness (connectRealServer).
//
// By default the account server runs as rukoo.io does: no files bucket, so no files. startWorkers({ files: true })
// binds a local bucket as WORKSPACE_FILES, and starts the link card pages of server/test/fixtures/preview-pages.cjs on
// 127.0.0.1 for the server to fetch (WORKSPACE_PREVIEW_HOSTS), as test/fixtures/real-server.js does for desktop.
import assert from 'node:assert/strict';
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { expect as baseExpect } from 'playwright/test';
import { buildApp } from '../../tools/build-app.mjs';

const WEBSITE = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = path.resolve(WEBSITE, '..');
const require = createRequire(import.meta.url);
// From website/node_modules: the website's CI job installs no root packages.
const { argon2id } = require('hash-wasm');
const { createAccountService, SESSION_KEY } = require('../../../src/web/account/service.js');
const { connectRealServer, INVITE } = require('../../../test/fixtures/real-server.js');
const i18n = require('../../../src/i18n/index.js');

export const PASSWORD = 'a long enough password 1';
// Waits for UI states; a cold Worker or Argon2 in the page can take a few seconds on a CI runner.
export const expect = baseExpect.configure({ timeout: 20000 });
export const tr = (lang, key, params) => i18n.translate(lang, key, params);

// Where captures go when RUKOO_WEB_VERIFY names a folder (they are evidence for a review, never committed).
const VERIFY = process.env.RUKOO_WEB_VERIFY ? path.resolve(process.env.RUKOO_WEB_VERIFY) : null;

let built = null;
// The app as npm run app:build assembles it, into site/app, which the site Worker's ASSETS serve. Once per process.
function buildOnce() {
  built ||= buildApp({ log: () => {} });
  return built;
}

// The account server's settings for the tests: invite-only sign-ups with one code for any number of accounts, team
// chat on or off, and a workspace invitation standing in for the code (WORKSPACE_SIGNUPS).
const serverVars = (workspaceMode, previewHost = '') => ({
  JURISDICTION: '',
  SIGNUPS: 'invite',
  INVITE_USES: 0,
  OPERATOR_NAME: 'Rukoo test server',
  OPERATOR_URL: '',
  OPERATOR_CONTACT: '',
  WORKSPACE_MODE: workspaceMode,
  WORKSPACE_SIGNUPS: 'on',
  WORKSPACE_ORIGIN: '',
  BOOKING_ORIGIN: '',
  BOOKING_ALIASES: '',
  BOOKING_FORMER_ROOTS: '',
  WORKSPACE_PREVIEW_HOSTS: previewHost
});

// The account server's config without its per-address rate limiters, written under the ignored server/.wrangler/.
// Every request in these tests comes from 127.0.0.1, and the suite signs up, signs in and joins more than the 30 a
// minute RATE_LIMITER allows; test/fixtures/real-server.js drops them for the same reason. limitRate() in
// server/src/config.js skips without the binding. files: a local bucket as WORKSPACE_FILES, which wrangler.jsonc leaves
// commented out. Returns the path relative to ROOT, as createTestHarness takes it.
function serverConfig({ files = false } = {}) {
  const { parseJsonc } = require(path.join(ROOT, 'test', 'fixtures', 'real-server.js'));
  const config = parseJsonc(readFileSync(path.join(ROOT, 'server', 'wrangler.jsonc'), 'utf8'));
  delete config.ratelimits;
  delete config.env;
  delete config.$schema;
  config.main = path.join(ROOT, 'server', 'src', 'index.js');
  // fallthrough: false silences wrangler's warning about the shadowed default rule, as in real-server.js.
  config.rules = (config.rules || []).map((rule) => ({ ...rule, fallthrough: false }));
  if (files) config.r2_buckets = [{ binding: 'WORKSPACE_FILES', bucket_name: 'rukoo-workspace-files-browser-test' }];
  else delete config.r2_buckets;
  const dir = path.join(ROOT, 'server', '.wrangler', 'browser-tests');
  mkdirSync(dir, { recursive: true });
  const name = files ? 'wrangler.files.json' : 'wrangler.json';
  writeFileSync(path.join(dir, name), JSON.stringify(config));
  return path.relative(ROOT, path.join(dir, name)).split(path.sep).join('/');
}

// Both Workers and a headless Chromium. files: the account server has a files bucket and makes link cards of the
// pages in pages (preview-pages.cjs: pages.page(spec) answers a page's address). Returns { origin, browser, seed,
// pages, close }.
export async function startWorkers({ workspaceMode = 'on', files = false } = {}) {
  await buildOnce();
  process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
  process.env.WRANGLER_SEND_METRICS = 'false';
  const { createTestHarness } = createRequire(path.join(ROOT, 'server', 'package.json'))('wrangler');
  const pages = files ? await require(path.join(ROOT, 'server', 'test', 'fixtures', 'preview-pages.cjs')).startPreviewServer() : null;
  const harness = createTestHarness({
    root: ROOT,
    workers: [
      { configPath: 'website/wrangler.jsonc' },
      {
        configPath: serverConfig({ files }),
        vars: serverVars(workspaceMode, pages ? pages.host : ''),
        secrets: { PEPPER: randomBytes(32).toString('base64'), INVITE_CODES: INVITE }
      }
    ]
  });
  let browser = null;
  try {
    const { url } = await harness.listen();
    browser = await chromium.launch({ headless: true });
    const origin = url.origin;
    return {
      origin,
      browser,
      seed: connectRealServer(origin, { previews: pages ? pages.origin : null }),
      pages,
      async close() {
        await browser.close().catch(() => {});
        await harness.close();
        await pages?.close();
      }
    };
  } catch (err) {
    await browser?.close().catch(() => {});
    await harness.close().catch(() => {});
    await pages?.close();
    throw err;
  }
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key)
  };
}

// An account on the server at origin that the page can sign in to: the browser's own account code, run in Node,
// derives the keys for this server and signs up with the operator's invite code. deviceName: what the account's
// devices list calls that sign-up. Returns { email, password, token }.
export async function makeAccount(origin, { email, password = PASSWORD, deviceName } = {}) {
  const storage = memoryStorage();
  const account = createAccountService({
    server: origin,
    fetch: (input, init) => fetch(input, init),
    storage,
    subtle: webcrypto.subtle,
    argon2: argon2id,
    userAgent: 'Rukoo browser test',
    deviceName
  });
  await account.accountSignUp({ email, password, invite: INVITE });
  const session = JSON.parse(storage.getItem(SESSION_KEY));
  return { email, password, token: session.token };
}

// Another session of an account makeAccount made, as a sign-in on another device makes one; deviceName: what the
// account's devices list calls it. Returns its token.
export async function anotherSession(origin, { email, password = PASSWORD }, deviceName) {
  const storage = memoryStorage();
  const account = createAccountService({
    server: origin,
    fetch: (input, init) => fetch(input, init),
    storage,
    subtle: webcrypto.subtle,
    argon2: argon2id,
    userAgent: 'Rukoo browser test',
    deviceName
  });
  await account.accountSignIn({ email, password });
  return JSON.parse(storage.getItem(SESSION_KEY)).token;
}

// The engine's catch-up timer at half an hour: within a test's wait only the wake socket brings a message in (a run
// for 'wake'), so a page with it proves the socket works instead of passing on the next catch-up.
export const NO_CATCHUP = { catchupFocused: 30 * 60000, catchupAway: 30 * 60000 };

// A page in a fresh browser context, with the engine's test timing (window.__rukooWebTest, chatFast: the shorter
// catch-up and backoff of SEM_CHAT_FAST; timing: the engine's own timing values over those, such as NO_CATCHUP).
// allow: console errors the test provokes on purpose, as regular expressions, collected in allowed; every other console
// error or page error is a problem that fails the test (clean()). sockets: the wake socket frames the page received.
export async function openPage(browser, { locale = 'en-GB', width = 1280, height = 800, colorScheme = 'light', phone = false, allow = [], timing = null } = {}) {
  const context = await browser.newContext({
    locale,
    viewport: { width, height },
    colorScheme,
    deviceScaleFactor: 1,
    ...(phone ? { isMobile: true, hasTouch: true } : {})
  });
  await context.addInitScript((override) => {
    window.__rukooWebTest = override ? { chatFast: true, timing: override } : { chatFast: true };
  }, timing);
  return watch(context, await context.newPage(), allow);
}

// Another tab in the context of view, which shares its storage (and so its sign-in), watched the same way.
export async function openTab(view, { allow = [] } = {}) {
  return watch(view.context, await view.context.newPage(), allow);
}

function watch(context, page, allow) {
  page.setDefaultTimeout(20000);
  const problems = [];
  // The allowed errors that came, so a test can check its allowance is still needed.
  const allowed = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (allow.some((re) => re.test(text))) return void allowed.push(text);
    problems.push(`console error: ${text} (${message.location().url || 'no location'})`);
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  const sockets = { opened: [], frames: [] };
  page.on('websocket', (ws) => {
    if (!/\/v1\/workspaces\/[^/]+\/socket$/.test(new URL(ws.url()).pathname)) return;
    sockets.opened.push(ws.url());
    ws.on('framereceived', ({ payload }) => sockets.frames.push(String(payload)));
  });
  return { context, page, problems, allowed, sockets };
}

// From now on (until the page loads again), the reason of every run the page's engine asks for, in window.__rukooRuns:
// 'wake' when the socket said something changed, 'socket' when it opened, 'catchup' for the timer, and so on.
export async function recordRuns(page) {
  await page.waitForFunction(() => Boolean(window.__rukooWebTest && window.__rukooWebTest.engine));
  await page.evaluate(() => {
    const svc = window.__rukooWebTest.engine.svc;
    if (window.__rukooRuns) return;
    window.__rukooRuns = [];
    const sync = svc.sync;
    svc.sync = function (ws, why, ...rest) {
      window.__rukooRuns.push(String(why));
      return sync.call(this, ws, why, ...rest);
    };
  });
}
export const runs = (page) => page.evaluate(() => (window.__rukooRuns || []).slice());

// The browser's back button (Android's back gesture). A back that leaves the page is a navigation the test then sees
// in page.url(); one within the page's own history entries settles at once.
export async function browserBack(page) {
  await page.goBack({ waitUntil: 'commit', timeout: 5000 }).catch(() => {});
}

// Every control a finger can reach on screen now is at least 44 by 44 CSS pixels (the design's phone target; a
// ::before or ::after touch area around it counts). Links in message text, a link card's title (the whole card takes
// the tap), a switch drawn inside its row and the composer's text field are no targets of their own; a checkbox counts
// with its label.
export async function targets(page, label) {
  const small = await page.evaluate(() => {
    const out = [];
    const sel = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [contenteditable="true"]';
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    for (let el of document.querySelectorAll(sel)) {
      if (el.matches('.ch-text a, .ch-text *, .ch-card-title, .switch, .ch-input')) continue;
      if (el.matches('input[type="checkbox"], input[type="radio"]')) el = el.closest('label, .row, .radio-row') || el;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      // Only what a tap reaches: not a control under a dialog or Settings.
      const hit = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), Math.min(Math.max(r.top + r.height / 2, 0), vh - 1));
      if (!hit || !(hit === el || el.contains(hit))) continue;
      let w = r.width;
      let h = r.height;
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content === 'none' || cs.position !== 'absolute') continue;
        const out = (v) => (v.endsWith('px') ? Math.max(0, -parseFloat(v)) : 0);
        w = Math.max(w, r.width + out(cs.left) + out(cs.right));
        h = Math.max(h, r.height + out(cs.top) + out(cs.bottom));
      }
      if (w < 43.5 || h < 43.5) {
        const name = (el.getAttribute('aria-label') || el.title || el.textContent || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(w)}x${Math.round(h)} "${name}"`);
      }
    }
    return out;
  });
  assert.deepEqual(small, [], `${label}: touch targets under 44px`);
}

// The notice's box and the one of what sits at the bottom of the screen (selector), in CSS pixels, once the notice has
// slid into place (it rises a few pixels as it shows).
export const toastOver = (page, selector) =>
  page.evaluate(async (sel) => {
    await Promise.all(document.getElementById('toast').getAnimations().map((a) => a.finished.catch(() => {})));
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom) };
    };
    const below = document.querySelector(sel);
    return { toast: box(document.getElementById('toast')), below: below ? box(below) : null };
  }, selector);

// No console or page error on any of the pages so far.
export function clean(...views) {
  for (const v of views) assert.deepEqual(v.problems, [], 'console or page errors');
}

// No horizontal overflow: the page doesn't scroll sideways, and nothing visible reaches past the right edge unless a
// box that clips or scrolls it ends inside the window.
export async function noOverflow(page, label) {
  const found = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const se = document.scrollingElement;
    if (se.scrollWidth > vw + 1) out.push(`the page scrolls sideways: ${se.scrollWidth}px in ${vw}px`);
    const describe = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= vw + 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      let clipped = false;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX !== 'visible' && a.getBoundingClientRect().right <= vw + 1) {
          clipped = true;
          break;
        }
      }
      if (!clipped) out.push(`${describe(el)} ends at ${Math.round(r.right)}px in ${vw}px`);
    }
    return out.slice(0, 10);
  });
  assert.deepEqual(found, [], `${label}: horizontal overflow`);
}

// A capture for the review, when RUKOO_WEB_VERIFY is set; the overflow check runs either way.
export async function shot(page, name) {
  await noOverflow(page, name);
  if (!VERIFY) return;
  mkdirSync(VERIFY, { recursive: true });
  // Dialogs, pages and a theme change fade in: the capture waits for every animation and transition that ends (a
  // spinner never does).
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => {}))
    )
  );
  await page.screenshot({ path: path.join(VERIFY, `${name}.png`) });
}

// ---- what a person does ----

// Signs in from the chat pane's signed-out state, through Settings > Rukoo account, which closes on success.
export async function signIn(page, { email, password = PASSWORD }) {
  await page.locator('[data-ch-empty="sign-in"]').click();
  const form = page.locator('form[data-form="rukoo-signin"]');
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#overlays .page.settings')).toHaveCount(0);
  await expect(page.locator('.ch-ws-switch')).toBeVisible();
}

// A row of the sidebar's conversation list.
export const row = (page, name) => page.locator('.sidebar .ch-row', { hasText: name });

// Opens a conversation from the sidebar and waits for its title.
export async function openRoom(page, name) {
  await row(page, name).first().click();
  await expect(page.locator('.ch-head .ch-title')).toHaveText(name);
}

// A message in the open conversation's log (or a thread's, with where: '.ch-thread-log'), by its own text: a thread
// reply shown in the channel quotes its root's text in its "replied to" line, which doesn't count.
export const message = (page, text, where = '.ch-log') => page.locator(`${where} .ch-msg`, { has: page.locator('.ch-text', { hasText: text }) });

// Types into a composer and sends with Enter, as a person does; the message then shows in that log, sent.
export async function send(page, text, { compose = '.ch-compose', log = '.ch-log' } = {}) {
  const input = page.locator(`${compose} .ch-input`);
  await input.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  const sent = message(page, text, log);
  await expect(sent).toBeVisible();
  // Sent: the server gave it a seq (a pending one has none).
  await expect(sent.and(page.locator('[data-seq]'))).toHaveCount(1);
}
