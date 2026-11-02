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
import {publicationSite} from './helpers/publication-site.mjs';
import {FILES,SCOPE,MERGE,TARGET} from './helpers/cloud-sender-fixture.mjs';
const ID='isolated-native-host-fixture',workspace='fixture-workspace.slack.com';
const jsonResult=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const nativeTicket=(id,url,length)=>jsonResult({result:`Upload URL generated successfully!\n\nFile ID: ${id}\nUpload URL: ${url}\n\nInstructions:\n1. POST the raw file bytes to the Upload URL above\n2. Set Content-Type to match the file type\n3. Content-Length must be exactly ${length} bytes\n4. After upload completes, call slack_complete_file_upload with the File ID to finalize\n`});
const bytes=await encodeBundle(FILES,ID,'a'.repeat(40),'b'.repeat(40)),bundle=await decodeBundle(bytes);
const poster=bundle.files.get(bundle.report.path+bundle.report.poster),manifest=createNoticeManifest(bundle.files.get(bundle.report.path+'report.json'),MERGE);
const empty=()=>jsonResult({results:'# Search Results for: \n\nNo results found.\n',pagination_info:'End of results - No more pages available.\\n'});

test('control locator accepts only the pinned connector attribution or its stripped rendering',async()=>{
 for(const suffix of [SCOPE.sender_attribution_text,'*Sent using* <@U999>']){
  const r=await rig();try{r.modes.sourceAttribution=suffix;await r.host.step(ID);
   if(suffix===SCOPE.sender_attribution_text){await r.host.step(ID);assert.equal(r.state.get(ID).phase,'native_begin');}
   else await assert.rejects(()=>r.host.step(ID),/Control command text differs/);
   assert.equal(r.counts.final,0);
  }finally{r.close();}
 }
});
test('slow preflight refreshes reads without consuming a completion intent or another begin',async()=>{
 const r=await rig();try{
  await r.arm();r.clock.now=TARGET+60001;r.modes.slowPreflight=true;
  await assert.rejects(()=>r.host.step(ID),ReadPending);
  assert.equal(r.state.get(ID).phase,'final_ready');assert.equal(r.state.op(ID,'final_complete'),null);assert.equal(r.counts.begin,1);assert.equal(r.counts.final,0);
  await r.host.step(ID);assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);
 }finally{r.close();}
});
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
  if(isReceipt&&modes.pendingReceipt)return empty();
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
 return {state,publisher,outbox,host:makeHost(),makeHost,clock,modes,counts,reads,uploads,async arm(){await this.host.step(ID);await this.host.step(ID);if(clock.now<TARGET){await assert.rejects(()=>this.host.step(ID),ReadPending);assert.equal(counts.begin,0);clock.now=TARGET;}await this.host.step(ID);assert.equal(state.get(ID).phase,'final_ready');},close(){state.close();publisher.close();}};
}

test('native host prepares early, gates the single completion at 08:00 and records independent check',async()=>{
 const r=await rig();try{
  await r.arm();assert.equal(r.counts.begin,1);assert.equal(r.counts.final,0);
  assert.equal(r.clock.now,TARGET);await r.host.step(ID);assert.equal(r.counts.final,1);
  await r.host.step(ID);assert.equal(r.state.get(ID).phase,'sender_reported');assert.equal(r.counts.check,1);
  assert.equal(r.state.get(ID).detail.wecom_status,'not_checked');await r.host.step(ID);assert.equal(r.counts.final,1);
  assert(!JSON.stringify(r.state.get(ID)).includes('summary'));
 }finally{r.close();}
});
test('new native runs carry the exact bundle and record separate transport and original-poster proofs',async()=>{
 const r=await rig({deliveryMode:undefined});try{
  // An omitted deliveryMode in the public API defaults to bundle, while the
  // legacy harness remains explicit for old durable runs.
  const state=new CloudRunState(':memory:',SCOPE);try{await prepareNativeRun(state,{bundleBytes:bytes,reportCommit:MERGE,workspaceHost:workspace});assert.equal(state.get(ID).detail.mode,'native_bundle_v1');}finally{state.close();}
 }finally{r.close();}
 const b=await rig({deliveryMode:'native_bundle_v1'});try{
  await b.arm();assert.equal(b.counts.final,0);
  b.clock.now=TARGET;await b.host.step(ID);await b.host.step(ID);await b.host.step(ID);
  assert.equal(b.state.get(ID).phase,'sender_reported');assert.equal(b.counts.final,1);
  const receipt=b.outbox.notice(ID).detail.sender_receipt;
  assert.equal(receipt.transport_sha256,digest(bytes));assert.equal(receipt.transport_bytes,bytes.length);
  assert.equal(receipt.poster_sha256,digest(poster));assert.equal(receipt.poster_bytes,poster.length);
  assert.equal(b.state.get(ID).detail.wecom_status,'not_checked');
 }finally{b.close();}
});
test('bundle mode keeps unknown completion and restart recovery read-only, with no second upload',async()=>{
 for(const missing of [false,true]){
  const r=await rig({deliveryMode:'native_bundle_v1'});try{
   await r.arm();r.clock.now=TARGET;r.modes.finalTimeout=true;r.modes.finalMissing=missing;await r.host.step(ID);
   r.host=r.makeHost();
   if(missing){await assert.rejects(()=>r.host.step(ID),ReadPending);await assert.rejects(()=>r.host.step(ID),ReadPending);}
   else{await r.host.step(ID);assert.equal(r.state.get(ID).phase,'sender_reported');}
   assert.equal(r.counts.final,1);assert.equal(r.counts.begin,1);
  }finally{r.close();}
 }
});
test('bundle checker cannot replace original-poster proof with only a correct JSON digest',async()=>{
 const r=await rig({deliveryMode:'native_bundle_v1'});try{
  await r.arm();r.clock.now=TARGET;await r.host.step(ID);r.modes.badPoster=true;
  await assert.rejects(()=>r.host.step(ID),ReadPending);
  assert.equal(r.outbox.notice(ID).phase,'completion_intent');assert.equal(r.counts.final,1);
 }finally{r.close();}
});
test('existing native run keeps its transport across prepare and rejects a changed mode',async()=>{
 for(const deliveryMode of ['native_v1','native_bundle_v1']){
  const r=await rig({deliveryMode});try{
   await prepareNativeRun(r.state,{bundleBytes:bytes,reportCommit:MERGE,workspaceHost:workspace});assert.equal(r.state.get(ID).detail.mode,deliveryMode);
   await assert.rejects(()=>prepareNativeRun(r.state,{bundleBytes:bytes,reportCommit:MERGE,workspaceHost:workspace,deliveryMode:deliveryMode==='native_v1'?'native_bundle_v1':'native_v1'}));
  }finally{r.close();}
 }
});
test('default host stops before begin and never consumes a live completion intent',async()=>{
 const r=await rig({allowFinal:false});try{await r.host.step(ID);await r.host.step(ID);await assert.rejects(()=>r.host.step(ID),/disabled/);assert.equal(r.outbox.notice(ID).phase,'reserved');assert.equal(r.counts.begin,0);assert.equal(r.counts.final,0);}finally{r.close();}
});
test('unknown poster POST never obtains a replacement ticket',async()=>{
 const r=await rig();try{r.modes.posterUnknown=true;await assert.rejects(()=>r.host.step(ID),/Poster upload unknown/);r.modes.posterUnknown=false;await assert.rejects(()=>r.host.step(ID),/Poster upload unknown/);assert.equal(r.counts.ticket,1);assert.equal(r.counts.post,1);assert.equal(r.counts.control,0);}finally{r.close();}
});
test('malformed ticket remains unresolved across restart without allocating or posting again',async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),'native-ticket-')),filename=path.join(tmp,'state.sqlite'),r=await rig({filename});let reopened;
 try{
  r.modes.malformedTicket=true;await assert.rejects(()=>r.host.step(ID),/Poster upload unknown/);assert.equal(r.state.op(ID,'native:poster').phase,'unknown');
  r.state.close();reopened=new CloudRunState(filename,SCOPE);r.modes.malformedTicket=false;
  await assert.rejects(()=>r.makeHost(reopened).step(ID),/Poster upload unknown/);assert.equal(r.counts.ticket,1);assert.equal(r.counts.post,0);assert.equal(r.counts.control,0);assert.equal(r.counts.final,0);
 }finally{reopened?.close();r.publisher.close();await rm(tmp,{recursive:true,force:true});}
});
test('lost control completion is reconciled through reads without reposting',async()=>{
 const r=await rig();try{await r.host.step(ID);r.modes.controlTimeout=true;await r.host.step(ID);assert.equal(r.state.get(ID).phase,'native_begin');assert.equal(r.counts.control,1);}finally{r.close();}
});
test('missing control or receipt only polls the original command',async()=>{
 for(const mode of ['controlMissing','pendingReceipt']){
  const r=await rig();try{await r.host.step(ID);r.modes[mode]=true;await assert.rejects(()=>r.host.step(ID),ReadPending);const before={...r.counts};await assert.rejects(()=>r.host.step(ID),ReadPending);assert.deepEqual(r.counts,before);}finally{r.close();}
 }
});
test('forged Publisher result and changed public content cannot authorize completion',async()=>{
 const r=await rig();try{await r.host.step(ID);r.modes.forgedReceipt=true;await assert.rejects(()=>r.host.step(ID),/Untrusted/);assert.equal(r.counts.final,0);r.modes.forgedReceipt=false;await r.host.step(ID);r.clock.now=TARGET;r.modes.pagesUnavailable=true;await assert.rejects(()=>r.host.step(ID),/pages/);assert.equal(r.counts.final,0);}finally{r.close();}
});
test('restart after begin cannot reuse its grant even with the same durable journal',async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),'native-host-')),filename=path.join(tmp,'state.sqlite');const r=await rig({filename});let reopened;
 try{await r.arm();r.state.close();reopened=new CloudRunState(filename,SCOPE);const restarted=r.makeHost(reopened);r.clock.now=TARGET;await restarted.step(ID);await assert.rejects(()=>restarted.step(ID),ReadPending);assert.equal(r.counts.begin,1);assert.equal(r.counts.final,0);assert.equal(reopened.get(ID).phase,'native_reconcile');}
 finally{reopened?.close();r.publisher.close();await rm(tmp,{recursive:true,force:true});}
});
test('restart before begin retains the original uploaded poster and reservation',async()=>{
 const r=await rig();try{await r.host.step(ID);await r.host.step(ID);const file=r.state.get(ID).detail.file_id;r.host=r.makeHost();await assert.rejects(()=>r.host.step(ID),ReadPending);r.clock.now=TARGET;await r.host.step(ID);await r.host.step(ID);assert.equal(r.state.get(ID).detail.file_id,file);assert.equal(r.counts.final,1);}finally{r.close();}
});
test('unknown final completion reconciles and never calls completion again',async()=>{
 for(const missing of [false,true]){
  const r=await rig();try{await r.arm();r.clock.now=TARGET;r.modes.finalTimeout=true;r.modes.finalMissing=missing;await r.host.step(ID);assert.equal(r.state.op(ID,'final_complete').phase,'unknown');
   if(missing){await assert.rejects(()=>r.host.step(ID),ReadPending);await assert.rejects(()=>r.host.step(ID),ReadPending);}
   else{await r.host.step(ID);assert.equal(r.state.get(ID).phase,'sender_reported');}
   assert.equal(r.counts.final,1);
  }finally{r.close();}
 }
});
test('a negative checker result refreshes only the check, preserving the file and final intent',async()=>{
 const r=await rig();try{await r.arm();r.clock.now=TARGET;await r.host.step(ID);r.modes.checkerNegative=true;await assert.rejects(()=>r.host.step(ID),ReadPending);r.modes.checkerNegative=false;await r.host.step(ID);assert.equal(r.counts.check,2);assert.equal(r.counts.final,1);assert.equal(r.state.get(ID).phase,'sender_reported');}finally{r.close();}
});
test('locator rejects ambiguous results, changed sender, text, workspace and thread',()=>{
 const config={...SCOPE,workspace_host:workspace},source={text:'expected',ts:'1793491200.000001'};
 const good=rendered(source);assert.deepEqual(nativeMessageLocator(good,{config,channel:'C123',expectedText:'expected'}),{source_ts:source.ts});
 for(const patch of [{author:'U999'},{text:'changed'},{thread:'1793491100.000001'}])assert.throws(()=>nativeMessageLocator(rendered({...source,...patch}),{config,channel:'C123',expectedText:'expected'}));
 for(const [a,b] of [['1 results','2 results'],[workspace,'other.slack.com'],['available.\\\\n','available.\\\\nextra']]){const v=structuredClone(good);v.content[0].text=v.content[0].text.replace(a,b);assert.throws(()=>nativeMessageLocator(v,{config,channel:'C123',expectedText:'expected'}));}
});
test('transport rejects credential-bearing/foreign upload endpoints before POST',async()=>{
 for(const url of ['https://evil.example/upload/v1/id','http://files.slack.com/upload/v1/id','https://user:pass@files.slack.com/upload/v1/id','https://files.slack.com/other','https://files.slack.com:443/upload/v1/id','https://files.slack.com/upload/v1/a\nb','https://files.slack.com/upload/v1/a\\b','https://files.slack.com/upload/v1/id#fragment','https://files.slack.com/upload/v1/../../../other']){
  for(const result of [jsonResult({file_id:'F123',upload_url:url}),nativeTicket('F123',url,5)]){
   const t=new NativeSlackTransport(async()=>result,{uploadFetch:()=>assert.fail('no POST')});await assert.rejects(()=>t.upload(Buffer.from('bytes'),'poster.png'));
  }
 }
});
test('native formatted ticket preserves exact signed URL and file bytes; legacy JSON stays supported',async()=>{
 const bytes=Buffer.from([0,128,255,10]),url='https://files.slack.com/upload/v1/AbC%2fDeF?token=XyZ%2B09&x=1';
 for(const result of [nativeTicket('F123',url,bytes.length),jsonResult({file_id:'F123',upload_url:url})]){
  let tickets=0,posts=0;
  const t=new NativeSlackTransport(async(tool,args)=>{tickets++;assert.equal(tool,NATIVE_TOOLS.ticket);assert.deepEqual(args,{filename:'poster.png',content_length:4});return result;},{uploadFetch:async(actual,options)=>{posts++;assert.equal(actual,url);assert.deepEqual(options.body,bytes);assert.equal(options.headers['content-length'],'4');assert.equal(options.headers['content-type'],'image/png');assert.equal(options.redirect,'error');return new Response('ok');}});
  assert.deepEqual(await t.upload(bytes,'poster.png'),{file_id:'F123'});assert.equal(tickets,1);assert.equal(posts,1);
 }
});
test('malformed or ambiguous ticket envelopes fail closed before POST or completion',async()=>{
 const valid=nativeTicket('F123','https://files.slack.com/upload/v1/test',5),text=JSON.parse(valid.content[0].text).result;
 const cases=[{...valid,isError:true},{content:[...valid.content,...valid.content]},jsonResult(null),jsonResult([]),jsonResult({result:{file_id:'F123'}}),jsonResult({result:text,file_id:'FOTHER'}),jsonResult({file_id:'F123',upload_url:'https://files.slack.com/upload/v1/test',result:text}),jsonResult({result:text.replace('successfully!','maybe!')}),jsonResult({result:text+'File ID: FOTHER\n'}),jsonResult({result:text+'Upload URL: https://files.slack.com/upload/v1/other\n'}),jsonResult({result:text.replace('F123','f123')}),jsonResult({result:text+'x'.repeat(16384)}),{content:[{type:'text',text:'invalid JSON'}]}];
 for(const result of cases){let calls=0;const t=new NativeSlackTransport(async()=>{calls++;return result;},{uploadFetch:()=>assert.fail('no POST')});await assert.rejects(()=>t.upload(Buffer.from('bytes'),'poster.png'));assert.equal(calls,1);}
});
test('formatted ticket with unsuccessful POST never retries or completes',async()=>{
 for(const status of [302,401,500]){let tickets=0,posts=0;
  const t=new NativeSlackTransport(async tool=>{assert.equal(tool,NATIVE_TOOLS.ticket);tickets++;return nativeTicket('F123','https://files.slack.com/upload/v1/test',5);},{uploadFetch:async()=>{posts++;return new Response(null,{status});}});
  await assert.rejects(()=>t.upload(Buffer.from('bytes'),'poster.png'),/unconfirmed/);assert.equal(tickets,1);assert.equal(posts,1);
 }
});
test('starting too early does not allocate an expiring upload, and changed inputs cannot reuse a run',async()=>{
 const r=await rig({start:TARGET-600001});try{
  await assert.rejects(()=>r.host.step(ID),ReadPending);assert.equal(r.counts.ticket,0);
  await assert.rejects(()=>prepareNativeRun(r.state,{bundleBytes:bytes,reportCommit:'e'.repeat(40),workspaceHost:workspace}),/inputs changed/);
  assert.equal(r.counts.begin,0);
 }finally{r.close();}
});

for(const condition of [
 {httpStatus:403,headers:{'x-ratelimit-remaining':'0'}},
 {httpStatus:429,headers:{'retry-after':'30'}},
 {httpStatus:503}, {networkTimeout:true}, {streamTimeout:true},
])test('temporary read waits before begin and cannot consume intent '+JSON.stringify(condition),async()=>{
 const r=await rig();try{
  await r.host.step(ID);await r.host.step(ID);r.clock.now=TARGET;Object.assign(r.modes,condition);
  await assert.rejects(()=>r.host.step(ID),ReadPending);
  assert.equal(r.counts.begin,0);assert.equal(r.state.op(ID,'native:begin:command'),null);assert.equal(r.counts.final,0);
  for(const k of Object.keys(condition))delete r.modes[k];
  await assert.rejects(()=>r.host.step(ID),ReadPending);
  r.clock.now+=30001;await r.host.step(ID);await r.host.step(ID);
  assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);
 }finally{r.close();}
});
test('temporary failure after begin preserves live grant but never re-sends begin',async()=>{
 const r=await rig();try{
  await r.arm();r.clock.now+=60001;r.modes.httpStatus=503;
  await assert.rejects(()=>r.host.step(ID),ReadPending);assert.equal(r.counts.begin,1);assert.equal(r.counts.final,0);
  delete r.modes.httpStatus;r.clock.now+=15001;await r.host.step(ID);
  assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);
 }finally{r.close();}
});
for(const condition of [{httpStatus:401},{httpStatus:403},{badContent:true}])test('identity/content failures remain fatal '+JSON.stringify(condition),async()=>{
 const r=await rig();try{
  await r.host.step(ID);await r.host.step(ID);r.clock.now=TARGET;Object.assign(r.modes,condition);
  await assert.rejects(()=>r.host.step(ID),e=>!(e instanceof ReadPending));
  assert.equal(r.counts.begin,0);assert.equal(r.counts.final,0);
 }finally{r.close();}
});
test('slow preflight before begin does not consume an intent',async()=>{
 const r=await rig();try{
  await r.host.step(ID);await r.host.step(ID);r.clock.now=TARGET;r.modes.slowPreflight=true;
  await assert.rejects(()=>r.host.step(ID),ReadPending);assert.equal(r.counts.begin,0);
  await r.host.step(ID);await r.host.step(ID);assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);
 }finally{r.close();}
});

test('rate limit reset prevents premature source polling',async()=>{
 const r=await rig();try{
  await r.host.step(ID);await r.host.step(ID);r.clock.now=TARGET;
  r.modes.httpStatus=403;r.modes.headers={'x-ratelimit-remaining':'0','x-ratelimit-reset':String((TARGET+120000)/1000)};
  await assert.rejects(()=>r.host.step(ID),ReadPending);delete r.modes.httpStatus;
  r.clock.now+=119999;await assert.rejects(()=>r.host.step(ID),ReadPending);assert.equal(r.counts.begin,0);
  r.clock.now++;await r.host.step(ID);await r.host.step(ID);assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);
 }finally{r.close();}
});

test('publication backoff waits before reading the original begin receipt again',async()=>{
 const r=await rig();try{
  await r.arm();r.clock.now+=60001;r.modes.httpStatus=429;r.modes.headers={'retry-after':'30'};
  await assert.rejects(()=>r.host.step(ID),ReadPending);
  const reads=r.reads.search,writes={...r.counts};
  for(let i=0;i<5;i++){
   r.clock.now+=5000;await assert.rejects(()=>r.host.step(ID),ReadPending);
   assert.equal(r.reads.search,reads);assert.deepEqual(r.counts,writes);
  }
  delete r.modes.httpStatus;r.clock.now+=5000;await r.host.step(ID);
  assert(r.reads.search>reads);assert.equal(r.counts.begin,1);assert.equal(r.counts.final,1);
 }finally{r.close();}
});
