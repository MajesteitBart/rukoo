import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rukoo-map-test-'));
const sample=JSON.parse(fs.readFileSync('editorial/source-map.example.json'));
function run(data){const f=path.join(dir,'map.json');fs.writeFileSync(f,JSON.stringify(data));execFileSync(process.execPath,['scripts/check-source-map.mjs',f],{stdio:'pipe'});}
let count=0;
try {
 run(sample);
 const released=structuredClone(sample);Object.assign(released.changes[0],{released:true,publicRelease:'https://github.com/MajesteitBart/rukoo/releases/tag/v2.4.0',outcome:'update-existing',pageIds:['rk-demo-mail']});run(released);
 for(const [name,mutate] of [
 ['unreleased public update',x=>x.changes[0].released=false],
 ['missing release evidence',x=>x.changes[0].publicRelease=null],
 ['unknown target page',x=>x.changes[0].pageIds=['rk-absent-page']],
 ['missing target page',x=>x.changes[0].pageIds=[]],
 ]){const input=structuredClone(released);mutate(input);let rejected=false;try{run(input);}catch{rejected=true;}if(!rejected)throw new Error('Failed source-map gate: '+name);console.log('PASS rejection: '+name);count++;}
 console.log(`PASS: held and released examples accepted; ${count} private source-map gate rejection tests.`);
}finally { for(const f of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,f));fs.rmdirSync(dir); }
