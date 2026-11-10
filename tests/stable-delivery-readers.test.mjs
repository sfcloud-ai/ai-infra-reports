import test from 'node:test';
import assert from 'node:assert/strict';
import {readReports,digest} from '../scripts/archive.mjs';
import sharp from 'sharp';
import {encodeBundle,decodeBundle,isEditionPublicURL} from '../scripts/report-handoff.mjs';
import {verifyPublicationReceipt} from '../scripts/cloud-sender.mjs';
import {createNoticeManifest} from '../scripts/notice-manifest.mjs';
import {verifyNoticeGrant,encodeNoticeCommand} from '../scripts/notice-command.mjs';
const date='2026-10-31',legacy=`reports/${date}/r1/`,current=`reports/${date}/`,commit='a'.repeat(40);
const original=new Map([...await readReports('tests/fixtures/archive')].filter(([p])=>p.startsWith(legacy)));
const poster=await sharp({create:{width:10,height:10,channels:3,background:'white'}}).png().toBuffer();
const report=JSON.parse(original.get(legacy+'report.json'));report.poster='assets/poster.png';report.images=[{path:report.poster,sha256:digest(poster),alt:'Fixture'}];
original.set(legacy+'report.json',Buffer.from(JSON.stringify(report)));original.set(legacy+report.poster,poster);
const files=new Map([...original].map(([p,b])=>[current+p.slice(legacy.length),b]));
const bundle=await decodeBundle(await encodeBundle(files,'morning-20261031-r1',commit,commit));
const origin='https://sfcloud-ai.github.io/ai-infra-reports',edition=date+'/r1';

test('current transport reserves legacy revision routes while old bundles remain decodable',async()=>{
 const r=structuredClone(report),oldId=r.articles[0].id;r.articles[0].id='r1';r.entries.find(e=>e.article_id===oldId).article_id='r1';
 const renamed=new Map(files);renamed.set(current+'articles/r1.md',renamed.get(current+'articles/'+oldId+'.md'));renamed.delete(current+'articles/'+oldId+'.md');renamed.set(current+'report.json',Buffer.from(JSON.stringify(r)));
 await assert.rejects(()=>encodeBundle(renamed,'morning-20261031-r1',commit,commit),/Revision-shaped article IDs/);
 const historical=new Map([...renamed].map(([p,b])=>[legacy+p.slice(current.length),b]));
 assert.equal((await decodeBundle(await encodeBundle(historical,'morning-20261031-r1',commit,commit))).report.articles[0].id,'r1');
});
test('current transport is a strict single-date layout retaining immutable revision and bytes',async()=>{
 assert.equal(bundle.report.path,current);assert.equal(bundle.report.revision,1);
 const old=await decodeBundle(await encodeBundle(original,'morning-20261031-r1',commit,commit));assert.equal(old.report.path,legacy);
 for(const changed of [new Map([...files,...original]),new Map([...files].map(([p,b])=>[p===current+'report.json'?legacy+'report.json':p,b]))])await assert.rejects(()=>encodeBundle(changed,'morning-20261031-r1',commit,commit));
 await assert.rejects(()=>encodeBundle(files,'morning-20261031-r2',commit,commit));
 const changed=new Map(files);changed.set(current+'report.json',Buffer.from(JSON.stringify({...report,revision:0})));await assert.rejects(()=>encodeBundle(changed,'other-request',commit,commit));
 const oldManifest=createNoticeManifest(original.get(legacy+'report.json'),commit),newManifest=createNoticeManifest(files.get(current+'report.json'),commit,{stableUrls:true});
 assert.equal(oldManifest.index_url,origin+'/'+edition+'/');assert.equal(newManifest.index_url,origin+'/'+date+'/');assert.notEqual(digest(oldManifest.text),digest(newManifest.text));
});
const scope={team_id:'T123',channel_id:'C123',notification_destination:'D123',bot_user_id:'U456',bot_id:'B456'},sourceTs='1793404700.000001';
const envelope=text=>({complete:true,read_context:{team_id:scope.team_id,channel_id:scope.channel_id},message:{type:'message',user:scope.bot_user_id,bot_id:scope.bot_id,thread_ts:sourceTs,ts:'1793404750.000001',text}});
const receipt={schema_version:'1.0',status:'published',publication_status:'verified',delivery_allowed:false,request_id:bundle.data.request_id,bundle_sha256:bundle.hash,edition,commit,url:origin+'/'+date+'/',poster_sha256:digest(poster),pr:'https://github.com/sfcloud-ai/ai-infra-reports/pull/1'};
test('publication receipt accepts only exact current or matching legacy URL and keeps all bindings',()=>{
 for(const url of [origin+'/'+date+'/',origin+'/'+edition+'/'])assert.equal(verifyPublicationReceipt(envelope('!ai-report receipt '+JSON.stringify({...receipt,url})),sourceTs,scope,bundle).url,url);
 for(const patch of [{url:origin+'/'+date+'/r2/'},{url:origin+'/2026-11-01/'},{url:receipt.url+'?x=1'},{url:receipt.url+'\n'},{edition:date+'/r2'},{bundle_sha256:'b'.repeat(64)},{request_id:'other-request'},{poster_sha256:'b'.repeat(64)},{commit:'bad'}])assert.throws(()=>verifyPublicationReceipt(envelope('!ai-report receipt '+JSON.stringify({...receipt,...patch})),sourceTs,scope,bundle));
 assert.equal(isEditionPublicURL(origin+'/2026-02-30/','2026-02-30/r1'),false);
});
test('notice grant accepts exact stable URL without weakening attempt, edition or content binding',()=>{
 const command={schema_version:'1.0',command_id:'claim-current-01',action:'claim',report_request_id:bundle.data.request_id,bundle_sha256:bundle.hash,attempt_id:'attempt-current-01',file_id:'F123'},bytes=encodeNoticeCommand(command);
 const manifest=createNoticeManifest(files.get(current+'report.json'),commit,{stableUrls:true});
 const response={schema_version:'1.0',command_id:command.command_id,command_sha256:digest(bytes),report_request_id:command.report_request_id,bundle_sha256:bundle.hash,send_authorized:true,reason:'new_reservation',notice:{report_id:command.report_request_id,attempt_id:command.attempt_id,file_id:command.file_id,phase:'reserved',edition,detail:{bundle_sha256:bundle.hash,destination:scope.notification_destination,poster_policy:'original_bytes_v1',report_merge_sha:commit,poster_original_sha256:digest(poster),text_sha256:digest(manifest.text),url:manifest.index_url}}};
 const verify=r=>{const e=envelope('!ai-notice receipt '+JSON.stringify(r));return verifyNoticeGrant(e.message,{bytes,sourceTs,readContext:e.read_context,config:scope});};
 assert.equal(verify(response).url,manifest.index_url);
 for(const url of [origin+'/'+date+'/r2/',origin+'/2026-11-01/',manifest.index_url+'#x']){const r=structuredClone(response);r.notice.detail.url=url;assert.throws(()=>verify(r));}
 for(const change of [r=>r.notice.attempt_id='another-attempt',r=>r.notice.detail.destination='D999',r=>r.notice.detail.text_sha256='invalid',r=>r.notice.edition=date+'/r1\n']){const r=structuredClone(response);change(r);assert.throws(()=>verify(r));}
});


test('legacy producer bundle normalized to current publication creates and reconciles a stable notice',async()=>{
 const {rig,arm,ID}=await import('./helpers/cloud-sender-fixture.mjs');
 const r=await rig({stable:true});
 try{
  assert.match(r.bundle.report.path,/\/r1\/$/);
  await arm(r);assert.equal(r.manifest.index_url,origin+'/2026-11-01/');
  await r.sender.step(ID);await r.sender.step(ID);assert.equal(r.counts.complete,1);assert.equal(r.state.get(ID).phase,'sender_reported');
  await r.sender.step(ID);assert.equal(r.counts.complete,1);
 }finally{r.close();}
});

test('historical day verification reads immutable legacy source and keeps original notice contract, never public latest',async()=>{
 const {publicationSite}=await import('./helpers/publication-site.mjs');
 const {verifyHistoricalDelivery}=await import('../scripts/verify-scheduled-delivery.mjs');
 const bytes=await encodeBundle(original,'morning-20261031-r1',commit,commit),snapshot=Buffer.from(bytes);
 const site=publicationSite({files:original,slug:edition,sourceCommit:commit});
 const result=await verifyHistoricalDelivery({bundle_base64:bytes.toString('base64'),report_commit:commit},site.fetcher);
 assert.equal(result.delivery_allowed,false);assert.equal(result.plan.bundle_sha256,digest(snapshot));
 assert.equal(result.plan.notice_key,origin+'/'+edition+'/');assert.equal(result.plan.text,createNoticeManifest(original.get(legacy+'report.json'),commit).text);
 assert.ok(site.calls.every(({url})=>url.startsWith('https://api.github.com/')));assert.deepEqual(bytes,snapshot);
});
