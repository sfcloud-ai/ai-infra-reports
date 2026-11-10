import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {readReports,migrateArchive,validateArchive,validateChange,validateMigration,replaceCurrentReport,reindexArchive,json,digest} from '../scripts/archive.mjs';
import {validateCIReportChange} from '../scripts/historical-backfill.mjs';
import {evidenceAssets} from '../scripts/evidence-assets.mjs';
import {publicAssetPlan} from '../scripts/public-paths.mjs';
import reportMarkdown from '../scripts/remark-reports.mjs';
const old=await readReports('tests/fixtures/archive');
const current=migrateArchive(old);

test('metadata-only current revisions retain legacy absolute image references and immutable evidence',async()=>{
 const source=new Map(old),legacy='reports/2026-10-31/r1/',dir='reports/2026-10-31/',image='assets/figure.png';
 const url='/ai-infra-reports/'+legacy+image,bytes=await sharp({create:{width:20,height:20,channels:3,background:'white'}}).png().toBuffer();
 const report=JSON.parse(source.get(legacy+'report.json')),article=legacy+'articles/'+report.articles[0].id+'.md';
 const body=Buffer.concat([source.get(article),Buffer.from(`\n![Retained figure](${url})\n`)]);
 source.set(article,body);report.articles[0].sha256=digest(body);report.images.push({path:image,sha256:digest(bytes),alt:'Retained figure'});
 source.set(legacy+image,bytes);source.set(legacy+'report.json',Buffer.from(json(report)));reindexArchive(source);
 const migrated=migrateArchive(source),incoming=new Map([...migrated].filter(([p])=>p.startsWith(dir)));
 const updated=JSON.parse(incoming.get(dir+'report.json'));updated.revision=2;updated.subtitle+=' metadata correction';incoming.set(dir+'report.json',Buffer.from(json(updated)));
 const next=replaceCurrentReport(migrated,incoming),validated=validateChange(migrated,next);
 assert(next.get(dir+'articles/'+report.articles[0].id+'.md').equals(body));assert(next.get(dir+image).equals(bytes));
 assert.deepEqual(evidenceAssets(body.toString(),dir,next),[digest(bytes)]);
 const plan=publicAssetPlan([dir+image],next,validated.reports),target='/ai-infra-reports/'+dir+image;
 assert.equal(plan.aliases[url],target);const tree={type:'root',children:[{type:'image',url}]};
 reportMarkdown({assets:[target],assetAliases:plan.aliases})(tree);assert.equal(tree.children[0].url,target);
 const replaced=new Map(incoming),changed=await sharp({create:{width:20,height:20,channels:3,background:'black'}}).png().toBuffer();updated.images[0].sha256=digest(changed);
 replaced.set(dir+image,changed);replaced.set(dir+'report.json',Buffer.from(json(updated)));
 assert.throws(()=>replaceCurrentReport(migrated,replaced),/existing ID/);
 for(const invalid of [url.replace('/r1/','/r3/'),url.replace('2026-10-31','2026-10-29'),url.replace('figure.png','missing.png')])
  assert.throws(()=>evidenceAssets(`![Invalid](${invalid})`,dir,next),/existing archive asset/);
});
function correction({changed=false,newId=false}={}) {
 const dir='reports/2026-10-31/',target=dir+'r2/';
 const bundle=new Map([...current].filter(([p])=>p.startsWith(dir)).map(([p,b])=>[target+p.slice(dir.length),b]));
 const p=target+'report.json',r=JSON.parse(bundle.get(p));r.revision=2;
 if(changed){const file=target+'articles/kv-cache.md',b=Buffer.concat([bundle.get(file),Buffer.from('\nNew evidence.\n')]);bundle.set(file,b);r.articles[0].sha256=digest(b);r.entries[0].summary+=' New evidence.';}
 if(newId){r.entries[0].update_of=r.entries[0].id;r.entries[0].id+='-update';}
 bundle.set(p,Buffer.from(json(r)));return bundle;
}
test('migration is exact, latest-only, and does not retain historical prose',()=>{
 assert.equal(validateMigration(old,current).reports.length,2);
 assert([...current.keys()].every(p=>!p.includes('/r1/')));
 for(const row of JSON.parse(current.get('reports/history.json')).entries)assert.deepEqual(Object.keys(row).sort(),['content_sha256','date','event_key','fingerprint','id','revision']);
 assert.throws(()=>validateChange(old,current),/migration/);
 assert.doesNotThrow(()=>validateCIReportChange(old,current));
 const tampered=new Map(current),history=JSON.parse(tampered.get('reports/history.json'));history.entries.pop();tampered.set('reports/history.json',Buffer.from(json(history)));assert.throws(()=>validateMigration(old,tampered),/exactly/);
});
test('current correction replaces one date and accepts legacy bundles',()=>{
 const next=replaceCurrentReport(current,correction());assert.equal(validateChange(current,next).reports.length,2);assert.equal(JSON.parse(next.get('reports/2026-10-31/report.json')).revision,2);assert(![...next.keys()].some(p=>p.includes('/r2/')));
 assert.doesNotThrow(()=>validateCIReportChange(old,next));
});
test('snapshot corrections retain ID and evidence replay defenses',()=>{
 assert.throws(()=>replaceCurrentReport(current,correction({changed:true})),/existing ID/);
 assert.throws(()=>replaceCurrentReport(current,correction({newId:true})),/replay/);
 const next=replaceCurrentReport(current,correction({changed:true,newId:true}));assert.equal(validateArchive(next).reports.length,2);
 const h=JSON.parse(next.get('reports/history.json'));h.entries.shift();next.set('reports/history.json',Buffer.from(json(h)));assert.throws(()=>validateChange(current,next));
});
test('current snapshots cannot remove dates, skip revisions, or add undeclared files',()=>{
 const next=replaceCurrentReport(current,correction());const r=JSON.parse(next.get('reports/2026-10-31/report.json'));r.revision=4;next.set('reports/2026-10-31/report.json',Buffer.from(json(r)));reindexArchive(next);assert.throws(()=>validateChange(current,next),/consecutive/);
 const removed=new Map(current);for(const p of removed.keys())if(p.startsWith('reports/2026-10-30/'))removed.delete(p);reindexArchive(removed);assert.throws(()=>validateChange(current,removed),/consecutive/);
 const mixed=new Map(current);mixed.set('reports/2026-10-31/r2/report.json',Buffer.from(json(r)));assert.throws(()=>validateArchive(mixed),/mixed/);
});

import {FakeGitHub} from './helpers/fake-github.mjs';
import {propose,reconcileProposal} from '../scripts/propose.mjs';
import {assertReportOnly} from '../scripts/github.mjs';
test('proposal creates current snapshots, deletes retired articles and reconciles exactly',async()=>{
 const base=new Map(current),dir='reports/2026-10-31/',r=JSON.parse(base.get(dir+'report.json'));
 const article={...r.articles[0],id:'retired'};r.articles.push(article);r.entries.push({...r.entries[0],id:'retired-id',event_key:'retired-event',title:'Retired',article_id:'retired'});
 base.set(dir+'articles/retired.md',base.get(dir+'articles/'+article.id.replace('retired','kv-cache')+'.md'));base.set(dir+'report.json',Buffer.from(json(r)));reindexArchive(base);
 const api=new FakeGitHub();api.trees.set('0'.repeat(40),[...base].map(([path,b])=>({path,sha:api.putBlob(b),mode:'100644',type:'blob',size:b.length})));
 const result=await propose(api,correction(),api.base);
 const treeCall=api.calls.find(c=>c.method==='POST'&&c.route.endsWith('/git/trees'));assert(treeCall.body.tree.some(e=>e.path===dir+'articles/retired.md'&&e.sha===null));
 assert(!treeCall.body.tree.some(e=>e.path.includes('/r2/')));assert.equal((await reconcileProposal(api,correction(),api.base)).outcome,'published');assert.equal((await propose(api,correction(),api.base)).sha,result.sha);
});
test('report-only tree guard permits recoverable report blob deletion but not executable or unrelated changes',()=>{
 const entry={sha:'a',mode:'100644',type:'blob'};
 assert.doesNotThrow(()=>assertReportOnly({tree:new Map([['reports/date/articles/old.md',entry]])},{tree:new Map()}));
 assert.throws(()=>assertReportOnly({tree:new Map([['scripts/run.mjs',entry]])},{tree:new Map()}));
 assert.throws(()=>assertReportOnly({tree:new Map([['reports/x',{...entry,mode:'120000'}]])},{tree:new Map()}));
});
test('current CI retains historical batch backfills while ordinary merge gate rejects them',()=>{
 const empty=migrateArchive(new Map([['reports/index.json',Buffer.from(json({schema_version:'1.0',reports:[],entries:[]}))]]));
 const head=new Map(current);head.set('reports/history.json',empty.get('reports/history.json'));reindexArchive(head);
 assert.doesNotThrow(()=>validateCIReportChange(empty,head,{today:'2026-11-01'}));
 assert.throws(()=>validateCIReportChange(empty,head,{today:'2026-10-31'}),/precede/);
 assert.throws(()=>validateChange(empty,head),/one report/);
});
test('current historical batches allow chronological dependencies and reject invalid ancestry',()=>{
 const empty=migrateArchive(new Map([['reports/index.json',Buffer.from(json({schema_version:'1.0',reports:[],entries:[]}))]]));
 const head=new Map(current);head.set('reports/history.json',empty.get('reports/history.json'));
 const first=JSON.parse(head.get('reports/2026-10-30/report.json')).entries[0];
 const p='reports/2026-10-31/report.json',r=JSON.parse(head.get(p));r.entries[0].event_key=first.event_key;r.entries[0].update_of=first.id;head.set(p,Buffer.from(json(r)));reindexArchive(head);
 // Deliberately reverse insertion order: validation must use chronological order.
 const reversed=new Map([...head].reverse());
 assert.doesNotThrow(()=>validateCIReportChange(empty,reversed,{today:'2026-11-01'}));
 const invalid=new Map(head);r.entries[0].update_of='missing-prior-id';invalid.set(p,Buffer.from(json(r)));
 assert.throws(()=>validateCIReportChange(empty,invalid,{today:'2026-11-01'}),/prior ID/);
 const erased=new Map(head);erased.delete('reports/2026-10-30/report.json');assert.throws(()=>validateCIReportChange(empty,erased,{today:'2026-11-01'}));
 const forged=new Map(head);forged.set('reports/history.json',current.get('reports/history.json'));
 assert.throws(()=>validateCIReportChange(empty,forged,{today:'2026-11-01'}));
 const reverseDependency=new Map(current);reverseDependency.set('reports/history.json',empty.get('reports/history.json'));
 const earlierPath='reports/2026-10-30/report.json',earlier=JSON.parse(reverseDependency.get(earlierPath)),later=JSON.parse(reverseDependency.get(p)).entries[0];earlier.entries[0].event_key=later.event_key;earlier.entries[0].update_of=later.id;reverseDependency.set(earlierPath,Buffer.from(json(earlier)));
 assert.throws(()=>validateCIReportChange(empty,reverseDependency,{today:'2026-11-01'}),/unknown update/);
});
