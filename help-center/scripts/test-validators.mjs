import fs from 'node:fs';
import { loadPages, validate, assertPublic } from './validate.mjs';
const pages=loadPages();const p=pages.find(p=>p.route!=='/');const original=fs.readFileSync(p.file,'utf8');let count=0;
function reject(name,fn){try{fn();}catch{console.log('PASS rejection: '+name);count++;return;}throw new Error('Failed to reject '+name);}
try{
 for(const [name,text] of [
 ['duplicate pageId',original.replace(p.data.pageId,'rk-help-home')],
 ['invalid pageId',original.replace(p.data.pageId,'INVALID_ID')],
 ['duplicate URL',original.replace(/slug: .+/, 'slug: mail/hide-category')],
 ['invalid slug',original.replace(/slug: .+/, 'slug: Invalid_Path')],
 ['unknown metadata',original.replace('docType:', 'privateIssue: internal\ndocType:')],
 ['changed permanent URL',original.replace(/slug: .+/, 'slug: changed-url')],
 ['broken Markdown link',original+'\n[Broken](/missing-page/)'],
 ['template placeholder',original+'\n{{WRITE_THIS}}'],
 ['internal ticket URL',original+'\nhttps://linear.app/example/issue/RUK-999'],
 ]){fs.writeFileSync(p.file,text);reject(name,validate);fs.writeFileSync(p.file,original);}
 reject('private canary',()=>assertPublic('PRIVATE_SOURCE_MAP_CANARY_EXAMPLE','test'));
 reject('real email address',()=>assertPublic('person@company.invalid','test'));
}finally{fs.writeFileSync(p.file,original);}
fs.writeFileSync(p.file,original.replace(/title: .+/, 'title: \"A clearer title\"'));
validate();console.log('PASS: title edit preserves permanent page ID and URL.');
fs.writeFileSync(p.file,original);validate();console.log(`PASS: ${count} negative tests; source restored.`);
