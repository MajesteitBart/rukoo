import fs from 'node:fs';
import path from 'node:path';
import { walk, assertPublic } from './validate.mjs';
import { site, out, inlineScripts, scriptHash, pagePolicies } from './publish.mjs';
// Checks the published copy in ../site/help/. Links resolve against ../site/, so links from the help center to the
// rest of rukoo.io (the home page, the changelog, the shared fonts) are checked as well.
const base='/help/';
if(!fs.existsSync(path.join(out,'index.html'))) throw new Error('No published help center in site/help/. Run npm run build.');
const files=walk(out); const html=files.filter(x=>x.endsWith('.html'));
if(!fs.existsSync(path.join(out,'pagefind/pagefind.js'))) throw new Error('Missing Pagefind search index');
for(const f of files)if(/(?:private|source-map|templates|ticket-inventory|AGENTS\.md|editorial)/i.test(path.relative(out,f)))throw new Error(`Private/editorial output path: ${f}`);
let links=0;
for(const f of html){
 const text=fs.readFileSync(f,'utf8');assertPublic(text.replace(/\bplaceholder=/g, 'inputhint='),f);
 // One script policy per page, ahead of its first script, with the hash of each inline script (publish.mjs).
 const policies=pagePolicies(text);if(policies.length!==1)throw new Error(`${policies.length} script policies in ${f}`);
 const firstScript=text.indexOf('<script');
 if(firstScript!==-1&&firstScript<text.indexOf('http-equiv="Content-Security-Policy"'))throw new Error(`Script before the policy in ${f}`);
 const unhashed=inlineScripts(text).map(scriptHash).filter(h=>!policies[0].includes(h));
 if(unhashed.length)throw new Error(`Inline script without its hash in ${f}: ${unhashed.join(' ')}`);
 const page=base+path.relative(out,f).split(path.sep).join('/').replace(/index\.html$/,'');
 for(const m of text.matchAll(/(?:href|src)=["']([^"']+)["']/g)){
  let h=m[1].replaceAll('&amp;','&');if(/^(?:https?:|mailto:|tel:|data:|javascript:)/.test(h)) continue;
  const u=new URL(h,'https://rukoo.io'+page);
  let file=path.join(site,decodeURIComponent(u.pathname));if(u.pathname.endsWith('/'))file=path.join(file,'index.html');
  if(!fs.existsSync(file))throw new Error(`Broken output link ${h} in ${f}`);
  if(u.hash&&file.endsWith('.html')){ const target=fs.readFileSync(file,'utf8');const id=decodeURIComponent(u.hash.slice(1));if(!target.includes(`id="${id}"`)&&!target.includes(`id='${id}'`))throw new Error(`Broken fragment ${h} in ${f}`); }
  links++;
 }
}
const registry=JSON.parse(fs.readFileSync('page-registry.json'));
for(const route of Object.values(registry))if(!fs.existsSync(path.join(out,route,'index.html')))throw new Error('Missing route '+route);
console.log(`PASS: ${html.length} HTML files, ${links} local links/assets/fragments; Pagefind present; every page's script policy covers its inline scripts; private-input/output path scans clear.`);
