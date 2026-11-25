import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
export const root = path.resolve('src/content/docs');
export const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(path.join(d,x.name)) : [path.join(d,x.name)]);
export const forbidden = /linear\.app|\b(?:RUK|REV)-\d+\b|\b(?:TODO|TBD|FIXME)\b|\{\{[^}]+\}\}|PRIVATE_SOURCE_MAP_CANARY|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|(?:api[_-]?key|password|token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}|\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/ig;
export function assertPublic(text, label) { forbidden.lastIndex=0; const hit=text.match(forbidden); if(hit || /\bPLACEHOLDER\b/.test(text)) throw new Error(`${label}: forbidden private input or placeholder detected`); }
export function loadPages() {
 const files=walk(root); const pages=[];
 for(const file of files) {
  if(!file.endsWith('.md')) throw new Error(`Only Markdown pages allowed: ${file}`);
  const text=fs.readFileSync(file,'utf8'); assertPublic(text,file);
  const parts=text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/); if(!parts) throw new Error(`Missing frontmatter: ${file}`);
  const data=parse(parts[1]);
  const keys=['pageId','slug','title','description','docType','productArea','appliesTo','reviewed','behaviorChecked'];
  for(const k of Object.keys(data)) if(!keys.includes(k)) throw new Error(`Unknown public metadata ${k}: ${file}`);
  for(const k of keys.filter(k=>k!=='slug')) if(!(k in data)) throw new Error(`Missing ${k}: ${file}`);
  if(!/^rk-[a-z][a-z0-9-]{2,63}$/.test(data.pageId)) throw new Error(`Invalid pageId: ${file}`);
  if(data.slug!==undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(data.slug)) throw new Error(`Invalid slug: ${file}`);
  if(!['landing','tutorial','how-to','reference','explanation'].includes(data.docType)) throw new Error(`Invalid docType: ${file}`);
  if(!['overview','mail','chat','account','calendar','agents','meetings','platforms'].includes(data.productArea)) throw new Error(`Invalid productArea: ${file}`);
  for(const k of ['title','description']) if(typeof data[k]!=='string'||!data[k].trim()) throw new Error(`Invalid ${k}: ${file}`);
  if(!Array.isArray(data.appliesTo)||!data.appliesTo.length||data.appliesTo.some(x=>typeof x!=='string'||!x.trim())) throw new Error(`Invalid appliesTo: ${file}`);
  for(const k of ['reviewed','behaviorChecked']) { const d=data[k]; if(k==='behaviorChecked'&&d===null) continue; if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||new Date(d).toISOString().slice(0,10)!==d) throw new Error(`Invalid date ${k}: ${file}`); }
  const route=data.slug ? `/${data.slug}/` : '/';
  if(route==='/' && path.basename(file)!=='index.md') throw new Error(`Only index.md may omit slug: ${file}`);
  pages.push({file,text,body:parts[2],data,route});
 }
 return pages;
}
export function validate() {
 const pages=loadPages();const ids=new Set(),urls=new Set();
 for(const p of pages) { if(ids.has(p.data.pageId)) throw new Error('Duplicate pageId '+p.data.pageId); if(urls.has(p.route)) throw new Error('Duplicate URL '+p.route);ids.add(p.data.pageId);urls.add(p.route); }
 const registry=JSON.parse(fs.readFileSync('page-registry.json')); if(Object.keys(registry).length!==pages.length) throw new Error('Registry/page count mismatch');
 for(const p of pages) if(registry[p.data.pageId]!==p.route) throw new Error(`Stable registry mismatch: ${p.data.pageId}`);
 const checkLink=(href,base)=>{
  if(/^https:\/\//.test(href))return;
  if(/^(mailto:|tel:)/.test(href))throw new Error('Use public help links, not contact data: '+href);
  const u=new URL(href,'https://help.rukoo.io'+base);const pathname=u.pathname.endsWith('/')?u.pathname:u.pathname+'/';
  if(u.origin!=='https://help.rukoo.io'||!urls.has(pathname))throw new Error(`Broken or unsupported link ${href} from ${base}`);
 };
 for(const p of pages)for(const m of p.body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))checkLink(m[1],p.route);
 function nav(items){for(const n of items) { if(n.link)checkLink(n.link,'/');if(n.items)nav(n.items); }}
 const navigation=fs.readFileSync('navigation.json','utf8');assertPublic(navigation,'navigation');nav(JSON.parse(navigation));
 for(const file of walk(path.resolve('public'))) { if(!['rukoo-logo.svg','rukoo-logo-dark.svg','favicon.svg'].includes(path.basename(file))) throw new Error(`Public asset requires allowlist review: ${file}`); assertPublic(fs.readFileSync(file,'utf8'),file); }
 console.log(`PASS: ${pages.length} pages; unique stable IDs/URLs, metadata, Markdown links, navigation and public-input checks.`);
}
if(path.resolve(process.argv[1] || '')===fileURLToPath(import.meta.url))validate();
