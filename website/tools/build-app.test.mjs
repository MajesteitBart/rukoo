// node --test "tools/*.test.mjs"   The app build: a small made-up source tree for the rules and the watcher, then the
// real sources into a temporary folder.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildApp, references, rendererFile } from './build-app.mjs';

const WEBSITE = fileURLToPath(new URL('..', import.meta.url));
const ROOT = path.resolve(WEBSITE, '..');
const temp = [];
after(() => Promise.all(temp.map((dir) => rm(dir, { recursive: true, force: true }))));

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'rukoo-app-'));
  temp.push(dir);
  return dir;
}

async function put(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

// The renderer files the real page needs, a few others, the agent gallery, and options that bundle the two entries.
async function fixture() {
  const root = await tempDir();
  const files = {
    'src/renderer/styles.css': 'body{}',
    'src/renderer/web.css': '.web{}',
    'src/renderer/web-shell.js': 'export {};',
    'src/renderer/chat.js': 'export const chat = 1;',
    'src/renderer/index.html': '<!doctype html><title>desktop window</title>',
    'src/renderer/agent-gallery.html': 'gallery',
    'src/renderer/agent-gallery.js': 'gallery',
    'src/renderer/assets/rukoo-icon.svg': '<svg/>',
    'src/renderer/assets/rukoo-icon-dark.svg': '<svg/>',
    'src/renderer/assets/fonts/Inter-LICENSE.txt': 'Inter',
    'src/i18n/en.js': 'globalThis.en = 1;',
    'src/i18n/nl.js': 'globalThis.nl = 1;',
    'src/i18n/index.js': 'globalThis.RukooI18n = {};',
    'src/i18n/AGENTS.md': 'not for the browser',
    'src/web/index.html': await readFile(path.join(ROOT, 'src/web/index.html'), 'utf8'),
    'src/web/bridge.js': "import { mark } from './mark.js'; window.mail = { platform: 'web', mark };",
    'src/web/mark.js': "export const mark = 'first';",
    'src/web/account/argon2-worker.js': 'self.onmessage = () => {};',
    // The shape of the real src/web/build-options.mjs: bundles that write into outdir/web, and files to copy.
    'src/web/build-options.mjs': `
      import path from 'node:path';
      export function webBuildOptions({ root, outdir }) {
        const one = (entry, name) => ({
          entryPoints: [path.join(root, 'src', 'web', entry)], outfile: path.join(outdir, 'web', name),
          bundle: true, format: 'iife', platform: 'browser', logLevel: 'silent'
        });
        return [one('bridge.js', 'bridge.js'), one(path.join('account', 'argon2-worker.js'), 'argon2-worker.js')];
      }
      export function webAssets({ websiteDir }) {
        const sql = path.join(websiteDir, 'node_modules', 'sql.js');
        return [
          { from: path.join(sql, 'dist', 'sql-wasm-browser.wasm'), to: 'web/sql-wasm.wasm' },
          { from: process.env.RUKOO_FIXTURE_ASSET || path.join(sql, 'LICENSE'), to: 'web/sql-wasm.LICENSE.txt' }
        ];
      }`
  };
  for (const [file, text] of Object.entries(files)) await put(path.join(root, file), text);
  return root;
}

async function until(check, what) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting until ${what}`);
}

const read = (file) => readFile(file, 'utf8').catch(() => null);

test('the page addresses checked are its own, not the site\'s', () => {
  const html = '<link href="styles.css"><script src="web/bridge.js?v=1"></script><link href="/img/a.png"><a href="#x"></a><img src="data:,">' +
    '<a href="https://rukoo.io/">';
  assert.deepEqual(references(html), ['styles.css', 'web/bridge.js']);
});

test('the agent gallery and the desktop page stay out', () => {
  assert.equal(rendererFile('chat.js'), true);
  assert.equal(rendererFile(path.join('assets', 'fonts', 'Inter-LICENSE.txt')), true);
  assert.equal(rendererFile('agent-gallery.js'), false);
  assert.equal(rendererFile('agent-gallery.html'), false);
  assert.equal(rendererFile('index.html'), false);
  assert.equal(rendererFile(path.join('agent', 'index.html')), true);
});

test('a missing source stops the build and is named', async () => {
  const root = await fixture();
  await rm(path.join(root, 'src/web/index.html'));
  await rm(path.join(root, 'src/i18n/nl.js'));
  const out = path.join(await tempDir(), 'app');
  await assert.rejects(buildApp({ root, website: WEBSITE, out }), (error) => {
    assert.match(error.message, /^build-app: missing /);
    assert.ok(error.message.includes(path.join(root, 'src', 'web', 'index.html')), error.message);
    assert.ok(error.message.includes(path.join(root, 'src', 'i18n', 'nl.js')), error.message);
    return true;
  });
  assert.equal(existsSync(out), false);
});

test('a missing file to copy next to the bundles stops the build before anything is written', async () => {
  const root = await fixture();
  const out = path.join(await tempDir(), 'app');
  const absent = path.join(root, 'no-such-license.txt');
  process.env.RUKOO_FIXTURE_ASSET = absent;
  try {
    await assert.rejects(buildApp({ root, website: WEBSITE, out }), (error) => error.message === `build-app: missing ${absent}`);
  } finally {
    delete process.env.RUKOO_FIXTURE_ASSET;
  }
  assert.equal(existsSync(out), false);
});

test('a page that points at a file the app doesn\'t have stops the build, and leaves no app behind', async () => {
  const root = await fixture();
  await rm(path.join(root, 'src/renderer/web.css'));
  const out = path.join(await tempDir(), 'app');
  await put(path.join(out, 'index.html'), 'an earlier build');
  await assert.rejects(buildApp({ root, website: WEBSITE, out }), / is missing web\.css$/);
  assert.equal(existsSync(out), false);
  // Also when a bundle doesn't build, in --watch too.
  await put(path.join(root, 'src/renderer/web.css'), '.web{}');
  await put(path.join(root, 'src/web/bridge.js'), "import './nowhere.js';");
  for (const watch of [false, true]) {
    await assert.rejects(buildApp({ root, website: WEBSITE, out, watch, log: () => {} }), /Build failed/);
    assert.equal(existsSync(out), false, `watch: ${watch}`);
  }
});

test('it never empties a folder that holds the sources', async () => {
  const root = await fixture();
  await assert.rejects(buildApp({ root, website: WEBSITE, out: root }), /won't empty/);
  await assert.rejects(buildApp({ root, website: WEBSITE, out: path.dirname(root) }), /won't empty/);
  assert.equal(existsSync(path.join(root, 'src/web/index.html')), true);
});

test('the build lays out the app, and --watch follows the sources', async () => {
  const root = await fixture();
  const out = path.join(await tempDir(), 'app');
  await put(path.join(out, 'stale.js'), 'from an earlier build');
  const logs = [];
  const build = await buildApp({ root, website: WEBSITE, out, watch: true, log: (line) => logs.push(line) });
  try {
    assert.equal(existsSync(path.join(out, 'stale.js')), false);
    assert.equal(await read(path.join(out, 'index.html')), await read(path.join(root, 'src/web/index.html')));
    assert.equal(await read(path.join(out, 'chat.js')), 'export const chat = 1;');
    assert.equal(await read(path.join(out, 'assets/fonts/Inter-LICENSE.txt')), 'Inter');
    assert.equal(await read(path.join(out, 'i18n/en.js')), 'globalThis.en = 1;');
    for (const gone of ['agent-gallery.js', 'agent-gallery.html', 'i18n/AGENTS.md', 'build-options.mjs']) {
      assert.equal(existsSync(path.join(out, gone)), false, gone);
    }
    assert.match(await read(path.join(out, 'web/bridge.js')), /first/);
    assert.ok(existsSync(path.join(out, 'web/argon2-worker.js')));
    assert.deepEqual(readdirSync(path.join(out, 'web')).sort(), ['argon2-worker.js', 'bridge.js', 'sql-wasm.LICENSE.txt', 'sql-wasm.wasm']);

    await writeFile(path.join(root, 'src/renderer/chat.js'), 'export const chat = 2;');
    await until(async () => (await read(path.join(out, 'chat.js'))) === 'export const chat = 2;', 'chat.js is copied again');
    await put(path.join(root, 'src/renderer/chat/new.js'), 'export {};');
    await until(() => existsSync(path.join(out, 'chat/new.js')), 'a new file in a new folder is copied');
    await rm(path.join(root, 'src/renderer/chat.js'));
    await until(() => !existsSync(path.join(out, 'chat.js')), 'a deleted file is removed');
    await writeFile(path.join(root, 'src/i18n/nl.js'), 'globalThis.nl = 2;');
    await until(async () => (await read(path.join(out, 'i18n/nl.js'))) === 'globalThis.nl = 2;', 'a catalog is copied again');
    await writeFile(path.join(root, 'src/web/mark.js'), "export const mark = 'second';");
    await until(async () => /second/.test(await read(path.join(out, 'web/bridge.js'))), 'the bridge is bundled again');
    await writeFile(path.join(root, 'src/web/index.html'), '<!doctype html><title>changed</title>');
    await until(async () => /changed/.test(await read(path.join(out, 'index.html'))), 'the page is copied again');
    // The desktop window's page and the gallery never replace or join the app's.
    await writeFile(path.join(root, 'src/renderer/index.html'), '<!doctype html><title>desktop again</title>');
    await writeFile(path.join(root, 'src/renderer/agent-gallery.js'), 'gallery again');
    await writeFile(path.join(root, 'src/renderer/styles.css'), 'body{color:red}');
    await until(async () => (await read(path.join(out, 'styles.css'))) === 'body{color:red}', 'a later change is copied');
    assert.match(await read(path.join(out, 'index.html')), /changed/);
    assert.equal(existsSync(path.join(out, 'agent-gallery.js')), false);
  } finally {
    await build.close();
  }
  assert.ok(logs.some((line) => line.includes('watching')), logs.join('\n'));
});

test('the real sources build into a complete app', async () => {
  const out = path.join(await tempDir(), 'app');
  await buildApp({ root: ROOT, website: WEBSITE, out, log: () => {} });

  const html = await read(path.join(out, 'index.html'));
  assert.equal(html, await read(path.join(ROOT, 'src/web/index.html')));
  assert.doesNotMatch(html, /http-equiv/i, 'the Worker sends the policy; a meta policy would be enforced on top');
  // The styles in order, then the catalogs, the bridge as a classic script and the shell as the only module.
  const order = [...html.matchAll(/<(?:link rel="stylesheet" href|script(?: type="module")? src)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['styles.css', 'web.css', 'i18n/en.js', 'i18n/nl.js', 'i18n/index.js', 'web/bridge.js', 'web-shell.js']);
  assert.match(html, /<script src="web\/bridge\.js"><\/script>\s*<script type="module" src="web-shell\.js"><\/script>/);
  for (const ref of references(html)) assert.ok(existsSync(path.join(out, ref)), ref);

  // The renderer and the catalogs are copies, byte for byte.
  for (const file of ['chat.js', 'chat-view.js', 'rukoo-account.js', 'ui.js', 'styles.css', 'assets/fonts/Inter-LICENSE.txt']) {
    assert.ok((await readFile(path.join(out, file))).equals(await readFile(path.join(ROOT, 'src/renderer', file))), file);
  }
  for (const file of ['en.js', 'nl.js', 'index.js']) {
    assert.ok((await readFile(path.join(out, 'i18n', file))).equals(await readFile(path.join(ROOT, 'src/i18n', file))), file);
  }
  assert.deepEqual(readdirSync(path.join(out, 'i18n')).sort(), ['en.js', 'index.js', 'nl.js']);
  assert.equal(readdirSync(out).some((name) => name.startsWith('agent-gallery.')), false);

  // The bundles run as classic scripts: the page loads the bridge without type="module", and the worker is classic.
  for (const file of ['web/bridge.js', 'web/argon2-worker.js']) {
    const code = await read(path.join(out, file));
    assert.doesNotThrow(() => new vm.Script(code, { filename: file }), file);
    assert.doesNotMatch(code, /\brequire\(["'](?:fs|path|node:sqlite|crypto|http|https)["']\)/, `${file} reaches for a Node module`);
  }
  // SQLite as the bundled sql.js browser build expects it, and the notices of what is bundled.
  const wasm = await readFile(path.join(out, 'web/sql-wasm.wasm'));
  assert.ok(wasm.equals(await readFile(path.join(WEBSITE, 'node_modules/sql.js/dist/sql-wasm-browser.wasm'))));
  assert.ok(wasm.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d])), 'a WebAssembly module');
  assert.match(await read(path.join(out, 'web/sql-wasm.LICENSE.txt')), /MIT license/);
  assert.match(await read(path.join(out, 'web/argon2-worker.js')), /hash-wasm[\s\S]*@license MIT/);
  assert.match(await read(path.join(out, 'web/hash-wasm.LICENSE.txt')), /MIT License[\s\S]*Permission is hereby granted/);
  assert.match(await read(path.join(out, 'web/bridge.js')), /sql\.js [\d.]+ .*MIT license/);
});
