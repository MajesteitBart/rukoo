// The esbuild options of the browser build (website/tools/build-app.mjs runs them; the website tests reuse them). The
// chat engine is src/main/workspaces itself, bundled with the web's stand-ins for what it takes from Node:
//
// - node:sqlite             src/web/engine/sqlite.js (sql.js, in memory)
// - fs, path, events,       src/web/engine/shims/*.js
//   crypto, http, https,
//   buffer
// - src/main/account/client.js   src/web/engine/shims/account-client.js (AccountError only)
// - src/i18n/index.js       src/web/engine/shims/i18n.js (the page's RukooI18n): the catalogs are classic scripts of
//                           the page and are never bundled; importing en.js or nl.js fails the build
// - Buffer                  src/web/engine/shims/buffer.js, injected
// - process.env.SEM_TRACE   undefined
//
// Bare imports (sql.js, hash-wasm) resolve from website/node_modules only, where package.json pins them, so CI needs
// no npm ci at the root and a local build can't pick up the root's copy, or one in a folder above the checkout.
// Anything else Node-only fails the build: platform 'browser' leaves no built-in to fall back on.
import path from 'node:path';

// The name src/web/engine/index.js expects next to web/bridge.js (its SQL_WASM_FILE).
export const SQL_WASM_FILE = 'sql-wasm.wasm';

const TARGET = 'es2022';

// The files a relative request may name, as Node tries them: as written, with .js, and as a folder's index.js.
function resolveRelative(resolveDir, request) {
  const base = path.resolve(resolveDir, request);
  return [base, `${base}.js`, path.join(base, 'index.js')];
}

// Windows paths from esbuild and from the caller may differ in case and separators.
const same = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

// The esbuild plugin that puts the web's stand-ins in place. root: the repository.
export function webEnginePlugin({ root }) {
  const engine = path.join(root, 'src', 'web', 'engine');
  const shim = (name) => path.join(engine, 'shims', name);
  const builtins = {
    fs: shim('fs.js'),
    path: shim('path.js'),
    events: shim('events.js'),
    crypto: shim('crypto.js'),
    http: shim('http.js'),
    https: shim('http.js'),
    buffer: shim('buffer.js'),
    sqlite: path.join(engine, 'sqlite.js')
  };
  const redirects = [
    [path.join(root, 'src', 'i18n', 'index.js'), shim('i18n.js')],
    [path.join(root, 'src', 'main', 'account', 'client.js'), shim('account-client.js')]
  ];
  const catalogs = ['en.js', 'nl.js'].map((f) => path.join(root, 'src', 'i18n', f));
  return {
    name: 'rukoo-web-engine',
    setup(build) {
      // node:sqlite exists only with its prefix; the others with or without it.
      build.onResolve({ filter: /^(node:)?(fs|path|events|crypto|http|https|buffer)$|^node:sqlite$/ }, (args) => ({
        path: builtins[args.path.replace(/^node:/, '')]
      }));
      build.onResolve({ filter: /^\.\.?(\/|$)/ }, (args) => {
        const candidates = resolveRelative(args.resolveDir, args.path);
        for (const [from, to] of redirects) if (candidates.some((c) => same(c, from))) return { path: to };
        if (candidates.some((c) => catalogs.some((f) => same(c, f)))) {
          return { errors: [{ text: `${args.path} is a translation catalog: the page loads it as a classic script, read it through globalThis.RukooI18n` }] };
        }
        return undefined;
      });
    }
  };
}

const FROM_WEBSITE = Symbol('resolved from website/node_modules');

// Every bare import (a package name) resolves from website/node_modules and nowhere else. esbuild would otherwise
// look in node_modules beside and above the importing file first: the root's (hash-wasm is there too) and, in a
// worktree under tmp/, the main checkout's.
export function websiteModulesPlugin({ websiteDir }) {
  return {
    name: 'rukoo-website-modules',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === FROM_WEBSITE || path.isAbsolute(args.path)) return undefined;
        const result = await build.resolve(args.path, { kind: args.kind, resolveDir: websiteDir, pluginData: FROM_WEBSITE });
        if (result.errors.length) return { errors: result.errors };
        return { path: result.path, external: result.external, namespace: result.namespace, sideEffects: result.sideEffects };
      });
    }
  };
}

// What every bundle with the chat engine in it shares: the stand-ins, Buffer, the trace switch and the module paths.
// root: the repository; websiteDir: website/, whose node_modules hold sql.js, hash-wasm and esbuild.
export function webEngineOptions({ root, websiteDir }) {
  return {
    bundle: true,
    platform: 'browser',
    target: TARGET,
    // The stand-ins first: their names (fs, crypto, ...) would otherwise be looked up as packages.
    plugins: [webEnginePlugin({ root }), websiteModulesPlugin({ websiteDir })],
    inject: [path.join(root, 'src', 'web', 'engine', 'shims', 'buffer.js')],
    define: { 'process.env.SEM_TRACE': 'undefined' },
    nodePaths: [path.join(websiteDir, 'node_modules')],
    // sql.js and hash-wasm are MIT: their notices stay, at the end of each file.
    legalComments: 'eof'
  };
}

// The two bundles of website/site/app/web/: the bridge (window.mail with the chat engine and the account service) and
// the Argon2id worker. outdir: website/site/app.
export function webBuildOptions({ root, websiteDir, outdir, minify = false, sourcemap = false }) {
  const web = path.join(outdir, 'web');
  return [
    {
      ...webEngineOptions({ root, websiteDir }),
      entryPoints: [path.join(root, 'src', 'web', 'bridge.js')],
      outfile: path.join(web, 'bridge.js'),
      format: 'iife',
      minify,
      sourcemap
    },
    {
      bundle: true,
      platform: 'browser',
      target: TARGET,
      entryPoints: [path.join(root, 'src', 'web', 'account', 'argon2-worker.js')],
      outfile: path.join(web, 'argon2-worker.js'),
      format: 'iife',
      plugins: [websiteModulesPlugin({ websiteDir })],
      nodePaths: [path.join(websiteDir, 'node_modules')],
      legalComments: 'eof',
      minify,
      sourcemap
    }
  ];
}

// The files to copy next to the bundles: the sql.js WebAssembly that matches the browser build esbuild bundles
// (sql.js's "browser" entry, dist/sql-wasm-browser.js), under the name the engine asks for, and the sql.js license,
// since the wasm is a copy of sql.js too. hash-wasm's banner in the worker names the license without its text, so its
// LICENSE ships beside it. to is relative to outdir.
export function webAssets({ websiteDir }) {
  const dist = path.join(websiteDir, 'node_modules', 'sql.js');
  return [
    { from: path.join(dist, 'dist', 'sql-wasm-browser.wasm'), to: `web/${SQL_WASM_FILE}` },
    { from: path.join(dist, 'LICENSE'), to: 'web/sql-wasm.LICENSE.txt' },
    { from: path.join(websiteDir, 'node_modules', 'hash-wasm', 'LICENSE'), to: 'web/hash-wasm.LICENSE.txt' }
  ];
}

// The wasm alone: { from, to } as in webAssets.
export function sqlWasm({ websiteDir }) {
  return webAssets({ websiteDir })[0];
}
