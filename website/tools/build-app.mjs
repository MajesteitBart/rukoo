// node tools/build-app.mjs [--watch] [-- <command> <args…>]
//
// Assembles Rukoo in the browser into site/app/, which the site Worker serves at rukoo.io/app/ (cloudflare/web-app.js).
// The folder is generated and gitignored; every file in it comes from the desktop sources:
//   index.html                 src/web/index.html
//   i18n/en.js nl.js index.js  src/i18n, as they are
//   styles.css, chat.js, …     src/renderer, as it is, without the agent gallery (a desktop development page)
//   web/bridge.js              esbuild, with webBuildOptions from src/web/build-options.mjs: window.mail, the chat
//   web/argon2-worker.js       engine from src/main/workspaces and the account, bundled for the browser
//   web/sql-wasm.wasm …        webAssets from the same file: SQLite for the chat engine (sql.js) and its license
//
// A missing source stops the build with an error that names it, so a deploy never goes out without the app.
// --watch keeps the folder up to date while you work. Anything after -- runs once the first build is done, and the
// watcher stops when it exits: npm run app:dev uses this to run both Workers (README.md, Running the app locally).

import { spawn } from 'node:child_process';
import { existsSync, realpathSync, watch as watchFiles } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const WEBSITE = fileURLToPath(new URL('..', import.meta.url));
const ROOT = path.resolve(WEBSITE, '..');

const I18N = ['en.js', 'nl.js', 'index.js'];
// The files the app can't start without, checked after every full build.
const REQUIRED = ['index.html', 'styles.css', 'web.css', 'web-shell.js', ...I18N.map((f) => `i18n/${f}`), 'web/bridge.js', 'web/argon2-worker.js', 'web/sql-wasm.wasm'];

// Renderer files that stay out of the app. The renderer's own index.html is the desktop window's; the app has its own.
export function rendererFile(relative) {
  const name = relative.split(/[\\/]/).pop();
  if (/^agent-gallery\./.test(name)) return false;
  return relative !== 'index.html';
}

export function sources({ root = ROOT, website = WEBSITE } = {}) {
  return {
    root,
    website,
    renderer: path.join(root, 'src', 'renderer'),
    i18n: path.join(root, 'src', 'i18n'),
    index: path.join(root, 'src', 'web', 'index.html'),
    options: path.join(root, 'src', 'web', 'build-options.mjs')
  };
}

function missing(files) {
  return files.filter((file) => !existsSync(file));
}

// The page's own addresses (src and href), relative to the app folder. Absolute paths such as /img/… are site files.
export function references(html) {
  const found = [];
  for (const [, url] of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url) || url === '') continue;
    found.push(url.split(/[?#]/)[0]);
  }
  return found;
}

async function checkOutput(out) {
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  const gone = [...new Set([...REQUIRED, ...references(html)])].filter((file) => !existsSync(path.join(out, file)));
  if (gone.length) throw new Error(`build-app: ${out} is missing ${gone.join(', ')}`);
}

// What src/web/build-options.mjs says to bundle (webBuildOptions, a list of esbuild options that write into out) and
// to copy next to the bundles (webAssets, a list of { from, to } with to relative to out). The file belongs to the
// web engine; this only runs it.
async function plan(src, out) {
  const module = await import(pathToFileURL(src.options).href);
  for (const name of ['webBuildOptions', 'webAssets']) {
    if (typeof module[name] !== 'function') throw new Error(`build-app: ${src.options} has no function ${name}`);
  }
  const options = [module.webBuildOptions({ root: src.root, websiteDir: src.website, outdir: out })].flat();
  const assets = module.webAssets({ websiteDir: src.website });
  const absent = missing(assets.map((asset) => asset.from));
  if (absent.length) throw new Error(`build-app: missing ${absent.join(', ')}`);
  return { options: options.map((one) => ({ logLevel: 'warning', ...one })), assets };
}

async function copyRenderer(src, out) {
  await cp(src.renderer, out, {
    recursive: true,
    filter: (from) => from === src.renderer || rendererFile(path.relative(src.renderer, from))
  });
}

async function copyStatic(src, out, assets) {
  await mkdir(path.join(out, 'i18n'), { recursive: true });
  for (const file of I18N) await copyFile(path.join(src.i18n, file), path.join(out, 'i18n', file));
  await copyFile(src.index, path.join(out, 'index.html'));
  for (const { from, to } of assets) {
    await mkdir(path.dirname(path.join(out, to)), { recursive: true });
    await copyFile(from, path.join(out, to));
  }
}

function guardOut(src, out) {
  // The folder is emptied first, so it must be a folder of its own, never one that holds the sources.
  for (const keep of [src.root, src.website, path.join(src.website, 'site')]) {
    const relative = path.relative(out, keep);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error(`build-app: won't empty ${out}, it holds ${keep}`);
  }
}

// Builds the app once into out (site/app/ by default). With watch, it then keeps out up to date and returns
// { close() } to stop; without, it returns once the folder is complete.
export async function buildApp({ root = ROOT, website = WEBSITE, out = path.join(website, 'site', 'app'), watch = false, log = console.log } = {}) {
  const src = sources({ root, website });
  out = path.resolve(out);
  const absent = missing([src.renderer, ...I18N.map((f) => path.join(src.i18n, f)), src.index, src.options]);
  if (absent.length) throw new Error(`build-app: missing ${absent.join(', ')}`);
  guardOut(src, out);
  const { options, assets } = await plan(src, out);

  await rm(out, { recursive: true, force: true });
  // A build that fails leaves no app behind, so nothing half built can be served or deployed.
  const contexts = [];
  try {
    await mkdir(out, { recursive: true });
    await copyRenderer(src, out);
    await copyStatic(src, out, assets);
    if (!watch) {
      for (const one of options) await esbuild.build(one);
      await checkOutput(out);
      return { out };
    }
    for (const one of options) contexts.push(await esbuild.context(one));
    for (const context of contexts) await context.rebuild();
    await checkOutput(out);
  } catch (error) {
    await Promise.all(contexts.map((context) => context.dispose()));
    await rm(out, { recursive: true, force: true });
    throw error;
  }
  for (const context of contexts) await context.watch();
  const watchers = watchSources(src, out, log);
  log(`build-app: watching; ${path.relative(process.cwd(), out) || out} follows src/renderer, src/i18n and src/web`);
  return {
    out,
    async close() {
      for (const watcher of watchers) watcher.close();
      await Promise.all(contexts.map((context) => context.dispose()));
    }
  };
}

// Copies a changed source file into out, or removes the copy of a deleted one. esbuild follows the bundled sources.
function watchSources(src, out, log) {
  const pending = new Map();
  let timer = null;
  const queue = (from, to) => {
    pending.set(from, to);
    clearTimeout(timer);
    // Editors write a file in several steps; copy once they are done.
    timer = setTimeout(flush, 60);
  };
  const flush = async () => {
    const jobs = [...pending];
    pending.clear();
    for (const [from, to] of jobs) {
      try {
        const info = await stat(from).catch(() => null);
        if (!info) await rm(to, { recursive: true, force: true });
        else if (info.isDirectory()) {
          // A new folder: copy what is in it already, in case its files came before the watcher saw the folder.
          await cp(from, to, { recursive: true, filter: (file) => rendererFile(path.relative(src.renderer, file)) });
        } else {
          await mkdir(path.dirname(to), { recursive: true });
          await copyFile(from, to);
        }
        log(`build-app: ${info ? 'copied' : 'removed'} ${path.relative(src.root, from)}`);
        if (to === path.join(out, 'index.html')) await checkOutput(out).catch((error) => log(error.message));
      } catch (error) {
        log(`build-app: ${path.relative(src.root, from)}: ${error.message}`);
      }
    }
  };
  // Windows reports changes under the folder's long name; watching a short name (C:\Users\ABCDEF~1\…) crashes libuv.
  const real = (dir) => realpathSync.native(dir);
  const renderer = watchFiles(real(src.renderer), { recursive: true }, (event, name) => {
    if (name && rendererFile(name)) queue(path.join(src.renderer, name), path.join(out, name));
  });
  const i18n = watchFiles(real(src.i18n), (event, name) => {
    if (I18N.includes(name)) queue(path.join(src.i18n, name), path.join(out, 'i18n', name));
  });
  const page = watchFiles(real(path.dirname(src.index)), (event, name) => {
    if (name === path.basename(src.index)) queue(src.index, path.join(out, 'index.html'));
  });
  return [renderer, i18n, page];
}

// Runs the command after --, with this Node for `node`, and resolves with its exit code.
function run(command) {
  const [program, ...args] = command;
  const child = spawn(program === 'node' ? process.execPath : program, args, { stdio: 'inherit' });
  // Ctrl+C reaches the command too; this process waits for it to finish instead of leaving it behind.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', ignore);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main(argv) {
  const split = argv.indexOf('--');
  const flags = split < 0 ? argv : argv.slice(0, split);
  const command = split < 0 ? [] : argv.slice(split + 1);
  const unknown = flags.filter((flag) => flag !== '--watch');
  if (unknown.length) throw new Error(`build-app: unknown option ${unknown.join(' ')}`);
  const watch = flags.includes('--watch');
  const started = Date.now();
  const build = await buildApp({ watch });
  console.log(`build-app: built ${path.relative(process.cwd(), build.out) || build.out} in ${Date.now() - started} ms`);
  // Watching on its own runs until Ctrl+C.
  if (!command.length) return watch ? new Promise(() => {}) : 0;
  const code = await run(command);
  await build.close?.();
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    }
  );
}
