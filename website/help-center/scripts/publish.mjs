// Copies the build from dist/ to ../site/help/, where the rukoo-site Worker serves it as https://help.rukoo.io/, and
// gives every page a Content-Security-Policy <meta> that allows only the hashes of its own inline scripts. Starlight
// writes small inline scripts on every page (theme, sidebar, search shortcut). The Worker's header policy for the help
// center (../cloudflare/help-center.js) allows inline scripts; the browser enforces both policies, so only these run.
// The pages use the main site's Inter font at /assets/fonts/, so the build gets a copy of ../site/assets/fonts/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './validate.mjs';

export const site = path.resolve('..', 'site');
export const out = path.join(site, 'help');
const fonts = path.join(site, 'assets', 'fonts');

const META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g;

/** The contents of the inline scripts in a page, in order. */
export function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs, body]) => !/\bsrc=/.test(attrs) && body.trim())
    .map(([, , body]) => body);
}

export const scriptHash = (body) => `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`;

/** The page's own policy: scripts from this site, Pagefind's WebAssembly and the page's inline scripts. */
export function pagePolicy(html) {
  const hashes = [...new Set(inlineScripts(html).map(scriptHash))].sort();
  return ["script-src 'self' 'wasm-unsafe-eval'", ...hashes].join(' ');
}

/**
 * The page with its policy at the start of its head, before any script, replacing an older one. Astro's redirect pages
 * (a `redirects` entry in astro.config.mjs) have no <head> tag; there the policy goes right after the doctype, where
 * the browser still puts it in the head.
 */
export function withPolicy(html) {
  const page = html.replace(META, '');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${pagePolicy(page)}">`;
  const charset = page.match(/<head>\s*<meta charset="[^"]*"\s*\/?>/i);
  if (charset) return page.replace(charset[0], charset[0] + meta);
  if (/<head>/i.test(page)) return page.replace(/<head>/i, (head) => head + meta);
  const doctype = page.match(/^\s*<!doctype html>/i);
  return doctype ? page.replace(doctype[0], doctype[0] + meta) : meta + page;
}

/** The policies a page carries, for check-output.mjs. */
export const pagePolicies = (html) => [...html.matchAll(META)].map((m) => m[1]);

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const dist = path.resolve('dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('No build in dist/. Run astro build first.');
  // Every page gets its policy before ../site/help/ is touched, so a page that fails leaves the last copy as it was.
  const pages = walk(dist).filter((f) => f.endsWith('.html')).map((f) => [path.relative(dist, f), withPolicy(fs.readFileSync(f, 'utf8'))]);
  fs.cpSync(fonts, path.join(dist, 'assets', 'fonts'), { recursive: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(dist, out, { recursive: true });
  for (const [file, html] of pages) fs.writeFileSync(path.join(out, file), html);
  console.log(`PASS: copied dist/ to ${path.relative(process.cwd(), out)}; ${pages.length} pages carry their script policy.`);
}
