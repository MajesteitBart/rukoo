// Copies the build from dist/ to ../site/help/, where the rukoo-site Worker serves it as https://rukoo.io/help/, and
// gives every page a Content-Security-Policy <meta> that allows only the hashes of its own inline scripts. Starlight
// writes small inline scripts on every page (theme, sidebar, search shortcut). The Worker's header policy for /help/
// (../cloudflare/help-center.js) allows inline scripts; the browser enforces both policies, so only these run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './validate.mjs';

export const site = path.resolve('..', 'site');
export const out = path.join(site, 'help');

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

/** The page with its policy as the first element in <head>, before any script, replacing an older one. */
export function withPolicy(html) {
  const page = html.replace(META, '');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${pagePolicy(page)}">`;
  const charset = page.match(/<head>\s*<meta charset="[^"]*"\s*\/?>/i);
  if (charset) return page.replace(charset[0], charset[0] + meta);
  if (!/<head>/i.test(page)) throw new Error('A page without <head>');
  return page.replace(/<head>/i, (head) => head + meta);
}

/** The policies a page carries, for check-output.mjs. */
export const pagePolicies = (html) => [...html.matchAll(META)].map((m) => m[1]);

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const dist = path.resolve('dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('No build in dist/. Run astro build first.');
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(dist, out, { recursive: true });
  const pages = walk(out).filter((f) => f.endsWith('.html'));
  for (const file of pages) fs.writeFileSync(file, withPolicy(fs.readFileSync(file, 'utf8')));
  console.log(`PASS: copied dist/ to ${path.relative(process.cwd(), out)}; ${pages.length} pages carry their script policy.`);
}
