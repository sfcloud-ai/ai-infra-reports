import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../scripts/archive.mjs';
import {encodeBundle,decodeBundle} from '../scripts/report-handoff.mjs';
import {CloudRunState,ReadPending} from '../scripts/cloud-sender.mjs';
import {HandoffState} from '../scripts/handoff-state.mjs';
import {NoticeOutbox,notificationScope,advanceNotice} from '../scripts/notice-outbox.mjs';
import {createNoticeManifest} from '../scripts/notice-manifest.mjs';
import {NativeScheduledHost,NativeSlackTransport,prepareNativeRun,NATIVE_TOOLS,nativeMessageLocator} from '../scripts/native-scheduled-host.mjs';
import {nativeRecoveryPlan,fenceNativeRecovery,readRecoveryFence} from '../scripts/native-recovery-fence.mjs';
import {NativeRecoveryHost} from '../scripts/native-recovery-host.mjs';
import {authorizeNoticeRecovery,noticeRecovery} from '../scripts/notice-recovery.mjs';
import {publicationSite} from './helpers/publication-site.mjs';
import {FILES,SCOPE,MERGE,TARGET} from './helpers/cloud-sender-fixture.mjs';
const ID='isolated-native-host-fixture',workspace='fixture-workspace.slack.com';
const jsonResult=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const nativeTicket=(id,url,length)=>jsonResult({result:`Upload URL generated successfully!\n\nFile ID: ${id}\nUpload URL: ${url}\n\nInstructions:\n1. POST the raw file bytes to the Upload URL above\n2. Set Content-Type to match the file type\n3. Content-Length must be exactly ${length} bytes\n4. After upload completes, call slack_complete_file_upload with the File ID to finalize\n`});
const bytes=await encodeBundle(FILES,ID,'a'.repeat(40),'b'.repeat(40)),bundle=await decodeBundle(bytes);
const poster=bundle.files.get(bundle.report.path+bundle.report.poster),manifest=createNoticeManifest(bundle.files.get(bundle.report.path+'report.json'),MERGE);
const empty=()=>jsonResult({results:'# Search Results for: \n\nNo results found.\n',pagination_info:'End of results - No more pages available.\\n'});

import {RemoteControl,RemoteNativeRuntime,discoverRemoteRuns,readRemoteBundle,REMOTE_READ_TOOLS,SliceEnded} from '../scripts/remote-native-runtime.mjs';
import {remoteJournal,JOURNAL_CATALOG} from '../scripts/remote-native-journal.mjs';
import {freshNativeCommand} from '../scripts/native-notice.mjs';
function rendered({text,ts,channel='C123',author='U123',thread,bot=false}){
 const url=`https://${workspace}/archives/${channel}/p${ts.replace('.','')}`+(thread?`?thread_ts=${thread}&cid=${channel}`:'');
 return jsonResult({results:`# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: ${channel.startsWith('D')?'DM':'#control'} (ID: ${channel})\nFrom: ${bot?'Publisher':'Sender'} (ID: ${author}) ${bot?' [BOT]':''}\nTime: fixture\nMessage_ts: ${ts}\nPermalink: [link](${url})\nText: \n${text}\n\n---\n\n`,pagination_info:'End of results - No more pages available.\\n'});
}
async function rig({filename=':memory:',start=TARGET-600000,allowFinal=true,deliveryMode='native_v1'}={}){
 const clock={now:start},modes={},reads={search:0},counts={ticket:0,post:0,control:0,final:0,begin:0,check:0},uploads=new Map(),sources=new Map(),replies=new Map();let serial=1,final;
 const next=()=>`${Math.floor(clock.now/1000)}.${String(serial++).padStart(6,'0')}`;
 const state=new CloudRunState(filename,SCOPE);
 await prepareNativeRun(state,{bundleBytes:bytes,reportCommit:MERGE,workspaceHost:workspace,deliveryMode});
 const bundled=state.get(ID).detail.mode==='native_bundle_v1';
 const pc={...SCOPE,ready_for_review:true,producer_app_id:1,merger_app_id:2,notification_not_before:'1793400000.000001'};
 const publisher=new HandoffState(':memory:',pc);
 publisher.admit({request_id:ID,hash:bundle.hash,source_ts:'1793400010.000001'},bytes);publisher.move(ID,'received','receipt_sent',{commit:MERGE});
 const outbox=new NoticeOutbox(publisher,notificationScope(pc));
 const proof={publication_status:'verified',commit:MERGE,request_id:ID,bundle_sha256:bundle.hash,edition:'2026-11-01/r1',url:manifest.index_url,poster_sha256:digest(poster)};
 const callTool=async(tool,args)=>{
  if(tool===NATIVE_TOOLS.ticket){counts.ticket++;const id='F'+counts.ticket;uploads.set(id,{...args});return modes.malformedTicket?jsonResult({result:'Unexpected response'}):nativeTicket(id,'https://files.slack.com/upload/v1/'+id,args.content_length);}
  if(tool===NATIVE_TOOLS.complete){
   const file=uploads.get(args.file_id);assert(file?.bytes);
   if(args.channel_id==='D123'){
    counts.final++;assert.equal(args.initial_comment,manifest.text);assert.equal(args.thread_ts,undefined);assert.deepEqual(file.bytes,bundled?bytes:poster);assert.equal(args.title,bundled?'ai-brief-bundle.json':bundle.report.poster.split('/').at(-1));
    if(!modes.finalMissing)final={ts:next(),text:args.initial_comment,file_id:args.file_id};
    if(modes.finalTimeout)throw Error('unknown final completion');return jsonResult({file_id:args.file_id});
   }
   assert.equal(args.channel_id,'C123');counts.control++;
   if(modes.controlMissing)throw Error('unknown control completion');
   const c=JSON.parse(file.bytes),ts=next();if(c.action==='begin')counts.begin++;if(c.action==='check')counts.check++;
   sources.set(c.command_id,{text:args.initial_comment+(modes.sourceAttribution?' '+modes.sourceAttribution:''),ts});
   outbox.admit({request_id:c.command_id,hash:digest(file.bytes),source_ts:ts},file.bytes);
   await advanceNotice(outbox,c.command_id,{verify:async()=>proof,receipt:async(thread,text)=>{const reply={thread,text,ts:next(),bot:true,author:'U456'};replies.set(c.command_id,reply);return reply.ts;},checkNotice:async request=>{
    if(bundled){assert.equal(request.transport,'report_bundle_v1');assert.equal(request.bundle_sha256,digest(bytes));assert.equal(request.bundle_bytes,bytes.length);}
    return modes.checkerNegative?{slack_status:'not_verified'}:{slack_status:'verified',wecom_status:'not_checked',publication_status:'not_checked',receipt:{channel:'D123',ts:final.ts,relay_request_id:'auto:'+final.ts,file_id:final.file_id,transport_sha256:digest(bundled?bytes:poster),transport_bytes:bundled?bytes.length:poster.length,...(bundled?{poster_sha256:modes.badPoster?'0'.repeat(64):digest(poster),poster_bytes:poster.length}:{})},observed_publication_commit:MERGE,messages_sent:0,state_changed:false};}});
   if(modes.controlTimeout)throw Error('lost control acknowledgment');return jsonResult({file_id:args.file_id});
  }
  assert.equal(tool,NATIVE_TOOLS.search);reads.search++;
  if(args.filters.includes('D123'))return final?rendered({...final,channel:'D123'}):empty();
  const id=args.keywords[1].slice(1,-1),isReceipt=args.keywords[0]==='"!ai-notice receipt"';
  if(isReceipt&&(modes.pendingReceipt||modes.lostAction&&JSON.parse(outbox.command(id)?.bytes??'{}').action===modes.lostAction))return empty();
  const found=(isReceipt?replies:sources).get(id);
  if(!found)return empty();
  return rendered({...found,...(isReceipt&&modes.forgedReceipt?{author:'U999'}:{})});
 };
 const uploadFetch=async(url,options)=>{
  counts.post++;if(modes.posterUnknown)throw Error('unknown POST');
  assert.equal(options.redirect,'error');const f=uploads.get(url.split('/').at(-1));assert.equal(Number(options.headers['content-length']),f.content_length);assert.equal(options.body.length,f.content_length);f.bytes=Buffer.from(options.body);return new Response('ok',{status:200});
 };
 const site=publicationSite({files:bundle.files,slug:'2026-11-01/r1',sourceCommit:MERGE});
 const fetchPublic=async(...args)=>{if(modes.pagesUnavailable)throw Error('pages unavailable');if(modes.httpStatus)return new Response(null,{status:modes.httpStatus,headers:modes.headers});if(modes.networkTimeout)throw new DOMException('read timeout','TimeoutError');if(modes.streamTimeout)return new Response(new ReadableStream({start(c){c.error(new DOMException('stream timeout','TimeoutError'));}}),{headers:{'content-type':'application/json'}});if(modes.badContent)return new Response('{}',{headers:{'content-type':'application/json'}});if(modes.slowPreflight){clock.now+=61000;modes.slowPreflight=false;}return site.fetcher(...args);};
 const transport=new NativeSlackTransport(callTool,{uploadFetch});
 const makeHost=(s=state)=>new NativeScheduledHost(s,transport,{allowFinal,now:()=>clock.now,fetchPublic});
 return {transport,fetchPublic,config:{...SCOPE,workspace_host:workspace},bytes,bundle,poster,manifest,state,publisher,outbox,host:makeHost(),makeHost,makeRecovery:(s=state,enabled=allowFinal)=>new NativeRecoveryHost(s,transport,{allowFinal:enabled,now:()=>clock.now,fetchPublic}),clock,modes,counts,reads,uploads,async arm(){await this.host.step(ID);await this.host.step(ID);if(clock.now<TARGET){await assert.rejects(()=>this.host.step(ID),ReadPending);assert.equal(counts.begin,0);clock.now=TARGET;}await this.host.step(ID);assert.equal(state.get(ID).phase,'final_ready');},close(){state.close();publisher.close();}};
}

async function remoteRig(){
 const r=await rig({start:TARGET,deliveryMode:'native_bundle_v1'});
 const wall=Date.now,close=r.close;Date.now=()=>r.clock.now;r.close=()=>{Date.now=wall;close();};
 await r.host.step(ID);await r.host.step(ID);
 r.control=()=>new RemoteControl(r.config,r.transport,{now:()=>r.clock.now,sleep:async ms=>{r.clock.now+=ms;},deadline:r.clock.now+20*60000});
 r.fixed={report_request_id:ID,bundle_sha256:bundle.hash,attempt_id:r.state.get(ID).detail.attempt_id,file_id:r.state.get(ID).detail.file_id};
 r.runtime=()=>new RemoteNativeRuntime(r.control(),r.fixed,bytes,{allowFinal:true,fetchPublic:r.fetchPublic});
 return r;
}
test('remote runtime completes only original file once through real Publisher CAS and native receipts',async()=>{
 const r=await remoteRig();try{
  const result=await r.runtime().run({open:true});assert.equal(result.type,'complete');assert.equal(result.wecom_status,'not_checked');
  assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);assert.equal(remoteJournal(r.publisher.db,ID).phase,'complete');
  assert.equal((await r.runtime().run()).type,'complete');assert.equal(r.counts.final,1);
  assert.deepEqual(await discoverRemoteRuns(r.control()),[]);
 }finally{r.close();}
});
test('remote publication backoff survives a new executor and permits exactly one due send',async()=>{
 const r=await remoteRig();try{
  r.modes.httpStatus=429;r.modes.headers={'retry-after':'86400'};
  const first=await r.runtime().run({open:true});assert.equal(first.type,'deferred');assert(first.next_attempt_at>=TARGET+86400000);assert.equal(r.counts.begin,0);
  const catalog=await discoverRemoteRuns(r.control());assert.equal(catalog.length,1);assert.equal(catalog[0].file_id,r.fixed.file_id);assert.equal(catalog[0].source_ts,'1793400010.000001');
  delete r.modes.httpStatus;assert.equal((await r.runtime().run()).type,'deferred');assert.equal(r.counts.final,0);
  r.clock.now=first.next_attempt_at;assert.equal((await r.runtime().run()).type,'complete');assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);
 }finally{r.close();}
});
test('lost begin reply is settled from Publisher evidence after restart without a new completion owner',async()=>{
 const r=await remoteRig();try{
  r.modes.lostAction='begin';const first=await r.runtime().run({open:true});assert.equal(first.type,'deferred');
  assert.equal(r.counts.begin,1);assert.equal(r.counts.final,0);delete r.modes.lostAction;
  for(let i=0;i<3;i++){r.clock.now+=86400000;assert.equal((await r.runtime().run()).type,'deferred');}
  assert.equal(remoteJournal(r.publisher.db,ID).operations.find(o=>o.operation==='begin').phase,'acknowledged');assert.equal(r.counts.begin,1);assert.equal(r.counts.final,0);
 }finally{r.close();}
});
test('unknown final completion is never repeated across slices, whether delivered or absent',async()=>{
 for(const missing of [true,false]){
  const r=await remoteRig();try{
   r.modes.finalTimeout=true;r.modes.finalMissing=missing;
   assert.equal((await r.runtime().run({open:true})).type,missing?'deferred':'complete');
   for(let i=0;i<3;i++){r.clock.now+=86400000;assert.equal((await r.runtime().run()).type,missing?'deferred':'complete');}
   assert.equal(r.counts.final,1);assert.equal(r.counts.begin,1);
  }finally{r.close();}
 }
});
test('lost record response can be reconciled using exact stored command evidence',async()=>{
 const r=await remoteRig();try{
  r.modes.lostAction='record_bundle';assert.equal((await r.runtime().run({open:true})).type,'deferred');delete r.modes.lostAction;
  r.clock.now+=86400000;assert.equal((await r.runtime().run()).type,'complete');assert.equal(r.counts.final,1);
  assert.equal(r.publisher.db.prepare("SELECT count(*) n FROM remote_native_ops WHERE operation='record'").get().n,1);
 }finally{r.close();}
});
test('bootstrap cannot import an already started legacy notice, and catalog excludes it',async()=>{
 const r=await remoteRig();try{
  await r.host.step(ID);const before=r.outbox.notice(ID);
  await assert.rejects(()=>r.runtime().run({open:true}),SliceEnded);
  assert.deepEqual(r.outbox.notice(ID),before);assert.equal(remoteJournal(r.publisher.db,ID),null);assert.deepEqual(await discoverRemoteRuns(r.control()),[]);assert.equal(r.counts.final,0);
 }finally{r.close();}
});
test('two runtime executors racing the same reservation never complete twice',async()=>{
 const r=await remoteRig();try{
  const results=await Promise.allSettled([r.runtime().run({open:true}),r.runtime().run({open:true})]);
  assert(results.some(r=>r.status==='fulfilled'&&r.value.type==='complete'));
  assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);
  assert.equal(remoteJournal(r.publisher.db,ID).operations.filter(o=>o.operation==='begin').length,1);
 }finally{r.close();}
});
test('original native bundle read binds source timestamp, sender, attachment and exact bytes',async()=>{
 const entry={report_request_id:ID,bundle_sha256:bundle.hash,source_ts:'1793400010.000001'},config={...SCOPE,workspace_host:workspace};
 const thread={content:[{type:'text',text:JSON.stringify({messages:`=== THREAD PARENT MESSAGE ===\nFrom: Synthetic (U123)\nTime: fixture\nMessage TS: ${entry.source_ts}\n!ai-report publish ${ID} ${bundle.hash}\nFiles: ai-brief-bundle.json (ID: FORIGINAL, text/plain, 2 MB)\n\n=== THREAD REPLIES (0 total) ===\n`})}]};
 let corrupt=false;const calls=[],read=async(tool,args)=>{calls.push({tool,args});return tool===REMOTE_READ_TOOLS.thread?thread:{structuredContent:{file_id:'FORIGINAL',text_content:bytes.toString()+(corrupt?' ':''),metadata_text:'unused'}};};
 assert.deepEqual(await readRemoteBundle(read,config,entry),bytes);assert.deepEqual(calls[1].args,{file_id:'FORIGINAL'});
 const original=JSON.parse(thread.content[0].text);
 for(const suffix of [SCOPE.sender_attribution_text,SCOPE.sender_attribution_text.replace('<@U789>','<@U789|Tool>')]){
  thread.content[0].text=JSON.stringify({...original,messages:original.messages.replace(`publish ${ID} ${bundle.hash}\n`,`publish ${ID} ${bundle.hash} ${suffix}\n`)});
  assert.deepEqual(await readRemoteBundle(read,config,entry),bytes);
 }
 thread.content[0].text=JSON.stringify(original);
 corrupt=true;await assert.rejects(()=>readRemoteBundle(read,config,entry),/hash differs/);
 await assert.rejects(()=>readRemoteBundle(read,{...config,sender_user_id:'UOTHER'},entry),/binding differs/);
});

test('retryable post-begin preflight preserves the live completion owner within its slice',async()=>{
 const r=await remoteRig();try{
  const host=r.runtime(),verify=host.verify.bind(host);let count=0;
  host.verify=async b=>{if(++count===2){r.modes.httpStatus=429;r.modes.headers={'retry-after':'60'};}else delete r.modes.httpStatus;return verify(b);};
  const result=await host.run({open:true});assert.equal(result.type,'complete');assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);assert(r.clock.now>=TARGET+60000);
 }finally{r.close();}
});
