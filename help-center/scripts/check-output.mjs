import fs from 'node:fs';
import path from 'node:path';
import { walk, assertPublic } from './validate.mjs';
const dist=path.resolve('dist');const files=walk(dist); const html=files.filter(x=>x.endsWith('.html'));
if(!fs.existsSync(path.join(dist,'pagefind/pagefind.js'))) throw new Error('Missing Pagefind search index');
for(const f of files)if(/(?:private|source-map|templates|ticket-inventory|AGENTS\.md|editorial)/i.test(path.relative(dist,f)))throw new Error(`Private/editorial output path: ${f}`);
let links=0;
for(const f of html){
 const text=fs.readFileSync(f,'utf8');assertPublic(text.replace(/\bplaceholder=/g, 'inputhint='),f);
 for(const m of text.matchAll(/(?:href|src)=["']([^"']+)["']/g)){
  let h=m[1].replaceAll('&amp;','&');if(/^(?:https?:|mailto:|tel:|data:|javascript:)/.test(h)) continue;
  const base='/'+path.relative(dist,f).replace(/index\.html$/,'');const u=new URL(h,'https://help.rukoo.io'+base);
  let file=path.join(dist,decodeURIComponent(u.pathname));if(u.pathname.endsWith('/'))file=path.join(file,'index.html');
  if(!fs.existsSync(file))throw new Error(`Broken output link ${h} in ${f}`);
  if(u.hash&&file.endsWith('.html')){ const target=fs.readFileSync(file,'utf8');const id=decodeURIComponent(u.hash.slice(1));if(!target.includes(`id="${id}"`)&&!target.includes(`id='${id}'`))throw new Error(`Broken fragment ${h} in ${f}`); }
  links++;
 }
}
const registry=JSON.parse(fs.readFileSync('page-registry.json'));
for(const route of Object.values(registry))if(!fs.existsSync(path.join(dist,route,'index.html')))throw new Error('Missing route '+route);
console.log(`PASS: ${html.length} HTML files, ${links} local links/assets/fragments; Pagefind present; private-input/output path scans clear.`);
