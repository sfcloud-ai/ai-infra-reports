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
const bytes=await encodeBundle(FILES,ID,'a'.repeat(40),'b'.repeat(40)),bundle=await decodeBundle(bytes);
const poster=bundle.files.get(bundle.report.path+bundle.report.poster),manifest=createNoticeManifest(bundle.files.get(bundle.report.path+'report.json'),MERGE);
const empty=()=>jsonResult({results:'# Search Results for: \n\nNo results found.\n',pagination_info:'End of results - No more pages available.\\n'});
function rendered({text,ts,channel='C123',author='U123',thread,bot=false}){
 const url=`https://${workspace}/archives/${channel}/p${ts.replace('.','')}`+(thread?`?thread_ts=${thread}&cid=${channel}`:'');
 return jsonResult({results:`# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: ${channel.startsWith('D')?'DM':'#control'} (ID: ${channel})\nFrom: ${bot?'Publisher':'Sender'} (ID: ${author}) ${bot?' [BOT]':''}\nTime: fixture\nMessage_ts: ${ts}\nPermalink: [link](${url})\nText: \n${text}\n\n---\n\n`,pagination_info:'End of results - No more pages available.\\n'});
}
async function rig({filename=':memory:',start=TARGET-600000,allowFinal=true}={}){
 const clock={now:start},modes={},counts={ticket:0,post:0,control:0,final:0,begin:0,check:0},uploads=new Map(),sources=new Map(),replies=new Map();let serial=1,final;
 const next=()=>`${Math.floor(clock.now/1000)}.${String(serial++).padStart(6,'0')}`;
 const state=new CloudRunState(filename,SCOPE);
 await prepareNativeRun(state,{bundleBytes:bytes,reportCommit:MERGE,workspaceHost:workspace});
 const pc={...SCOPE,ready_for_review:true,producer_app_id:1,merger_app_id:2,notification_not_before:'1793400000.000001'};
 const publisher=new HandoffState(':memory:',pc);
 publisher.admit({request_id:ID,hash:bundle.hash,source_ts:'1793400010.000001'},bytes);publisher.move(ID,'received','receipt_sent',{commit:MERGE});
 const outbox=new NoticeOutbox(publisher,notificationScope(pc));
 const proof={publication_status:'verified',commit:MERGE,request_id:ID,bundle_sha256:bundle.hash,edition:'2026-11-01/r1',url:manifest.index_url,poster_sha256:digest(poster)};
 const callTool=async(tool,args)=>{
  if(tool===NATIVE_TOOLS.ticket){counts.ticket++;const id='F'+counts.ticket;uploads.set(id,{...args});return jsonResult({file_id:id,upload_url:'https://files.slack.com/upload/v1/'+id});}
  if(tool===NATIVE_TOOLS.complete){
   const file=uploads.get(args.file_id);assert(file?.bytes);
   if(args.channel_id==='D123'){
    counts.final++;assert.equal(args.initial_comment,manifest.text);assert.equal(args.thread_ts,undefined);assert.deepEqual(file.bytes,poster);
    if(!modes.finalMissing)final={ts:next(),text:args.initial_comment,file_id:args.file_id};
    if(modes.finalTimeout)throw Error('unknown final completion');return jsonResult({file_id:args.file_id});
   }
   assert.equal(args.channel_id,'C123');counts.control++;
   if(modes.controlMissing)throw Error('unknown control completion');
   const c=JSON.parse(file.bytes),ts=next();if(c.action==='begin')counts.begin++;if(c.action==='check')counts.check++;
   sources.set(c.command_id,{text:args.initial_comment,ts});
   outbox.admit({request_id:c.command_id,hash:digest(file.bytes),source_ts:ts},file.bytes);
   await advanceNotice(outbox,c.command_id,{verify:async()=>proof,receipt:async(thread,text)=>{const reply={thread,text,ts:next(),bot:true,author:'U456'};replies.set(c.command_id,reply);return reply.ts;},checkNotice:async()=>modes.checkerNegative?{slack_status:'not_verified'}:{slack_status:'verified',wecom_status:'not_checked',publication_status:'not_checked',receipt:{channel:'D123',ts:final.ts,relay_request_id:'auto:'+final.ts,file_id:final.file_id,transport_sha256:digest(poster),transport_bytes:poster.length},observed_publication_commit:MERGE,messages_sent:0,state_changed:false}});
   if(modes.controlTimeout)throw Error('lost control acknowledgment');return jsonResult({file_id:args.file_id});
  }
  assert.equal(tool,NATIVE_TOOLS.search);
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
 const fetchPublic=async(...args)=>{if(modes.pagesUnavailable)throw Error('pages unavailable');return site.fetcher(...args);};
 const transport=new NativeSlackTransport(callTool,{uploadFetch});
 const makeHost=(s=state)=>new NativeScheduledHost(s,transport,{allowFinal,now:()=>clock.now,fetchPublic});
 return {state,publisher,outbox,host:makeHost(),makeHost,clock,modes,counts,uploads,async arm(){for(let i=0;i<3;i++)await this.host.step(ID);assert.equal(state.get(ID).phase,'final_ready');},close(){state.close();publisher.close();}};
}

test('native host prepares early, gates the single completion at 08:00 and records independent check',async()=>{
 const r=await rig();try{
  await r.arm();assert.equal(r.counts.begin,1);assert.equal(r.counts.final,0);
  await assert.rejects(()=>r.host.step(ID),ReadPending);assert.equal(r.counts.final,0);
  r.clock.now=TARGET;await r.host.step(ID);assert.equal(r.counts.final,1);
  await r.host.step(ID);assert.equal(r.state.get(ID).phase,'sender_reported');assert.equal(r.counts.check,1);
  assert.equal(r.state.get(ID).detail.wecom_status,'not_checked');await r.host.step(ID);assert.equal(r.counts.final,1);
  assert(!JSON.stringify(r.state.get(ID)).includes('summary'));
 }finally{r.close();}
});
test('default host stops before begin and never consumes a live completion intent',async()=>{
 const r=await rig({allowFinal:false});try{await r.host.step(ID);await r.host.step(ID);await assert.rejects(()=>r.host.step(ID),/disabled/);assert.equal(r.outbox.notice(ID).phase,'reserved');assert.equal(r.counts.begin,0);assert.equal(r.counts.final,0);}finally{r.close();}
});
test('unknown poster POST never obtains a replacement ticket',async()=>{
 const r=await rig();try{r.modes.posterUnknown=true;await assert.rejects(()=>r.host.step(ID),/Poster upload unknown/);r.modes.posterUnknown=false;await assert.rejects(()=>r.host.step(ID),/Poster upload unknown/);assert.equal(r.counts.ticket,1);assert.equal(r.counts.post,1);assert.equal(r.counts.control,0);}finally{r.close();}
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
 const r=await rig();try{await r.host.step(ID);r.modes.forgedReceipt=true;await assert.rejects(()=>r.host.step(ID),/Untrusted/);assert.equal(r.counts.final,0);r.modes.forgedReceipt=false;await r.host.step(ID);await r.host.step(ID);r.clock.now=TARGET;r.modes.pagesUnavailable=true;await assert.rejects(()=>r.host.step(ID),/pages/);assert.equal(r.counts.final,0);}finally{r.close();}
});
test('restart after begin cannot reuse its grant even with the same durable journal',async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),'native-host-')),filename=path.join(tmp,'state.sqlite');const r=await rig({filename});let reopened;
 try{await r.arm();r.state.close();reopened=new CloudRunState(filename,SCOPE);const restarted=r.makeHost(reopened);r.clock.now=TARGET;await restarted.step(ID);await assert.rejects(()=>restarted.step(ID),ReadPending);assert.equal(r.counts.begin,1);assert.equal(r.counts.final,0);assert.equal(reopened.get(ID).phase,'native_reconcile');}
 finally{reopened?.close();r.publisher.close();await rm(tmp,{recursive:true,force:true});}
});
test('restart before begin retains the original uploaded poster and reservation',async()=>{
 const r=await rig();try{await r.host.step(ID);await r.host.step(ID);const file=r.state.get(ID).detail.file_id;r.host=r.makeHost();await r.host.step(ID);r.clock.now=TARGET;await r.host.step(ID);assert.equal(r.state.get(ID).detail.file_id,file);assert.equal(r.counts.final,1);}finally{r.close();}
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
 for(const url of ['https://evil.example/upload/v1/id','http://files.slack.com/upload/v1/id','https://user:pass@files.slack.com/upload/v1/id','https://files.slack.com/other']){
  const t=new NativeSlackTransport(async()=>jsonResult({file_id:'F123',upload_url:url}),{uploadFetch:()=>assert.fail('no POST')});await assert.rejects(()=>t.upload(Buffer.from('bytes'),'poster.png'));
 }
});
test('starting too early does not allocate an expiring upload, and changed inputs cannot reuse a run',async()=>{
 const r=await rig({start:TARGET-600001});try{
  await assert.rejects(()=>r.host.step(ID),ReadPending);assert.equal(r.counts.ticket,0);
  await assert.rejects(()=>prepareNativeRun(r.state,{bundleBytes:bytes,reportCommit:'e'.repeat(40),workspaceHost:workspace}),/inputs changed/);
  assert.equal(r.counts.begin,0);
 }finally{r.close();}
});
