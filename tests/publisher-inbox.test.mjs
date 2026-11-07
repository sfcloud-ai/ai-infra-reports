import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PublisherInbox,intakeStatus} from '../scripts/publisher-inbox.mjs';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {SlackHandoff} from '../scripts/slack-handoff.mjs';
import {handoffTick,prepareSlack,validateConfig} from '../scripts/run-handoff.mjs';
import {acceptMessage,acceptQueuedPublish,encodeBundle} from '../scripts/report-handoff.mjs';
import {replyScheduledStatus} from '../scripts/scheduled-delivery-bridge.mjs';
import {digest} from '../scripts/archive.mjs';
import {FILES,BASE,MERGE} from './helpers/cloud-sender-fixture.mjs';
const start='1793491200.000000',ts='1793491201.000001',now=1793494800000;
const id='durable-intake-fixture',bytes=await encodeBundle(FILES,id,BASE,'b'.repeat(40)),hash=digest(bytes);
const config={team_id:'T123',channel_id:'C123',sender_user_id:'U123',bot_user_id:'U456',bot_id:'B456',producer_app_id:10,merger_app_id:11,slack_token_file:'/private/token',producer_key_file:'/private/key',state_dir:'/private/state',ready_for_review:false,durable_intake:{not_before:start}};
const scheduled={activation_date:'2026-11-01',executable:'/usr/bin/python3',args:[]};
const message={type:'message',subtype:'file_share',user:'U123',ts,text:`!ai-report publish ${id} ${hash}`,files:[{id:'F123'}]};
const queued={request_id:id,report_date:'2026-11-01',report_commit:MERGE,bundle_sha256:hash,status:'queued',phase:'pending',parts_total:2,parts_sent:0};
const make=(filename=':memory:')=>new HandoffState(filename,handoffScope(config));
const slackFor=(messages=[message])=>({history:async()=>[],historyPage:async()=>({messages,next_cursor:null}),exactPublish:async()=>message,download:async()=>bytes});

test('explicit durable boundary preserves existing identity scope and rejects ambiguous configuration',()=>{
 assert.equal(validateConfig(config),config);
 const {durable_intake,...old}=config;assert.deepEqual(handoffScope(config),handoffScope(old));
 for(const c of [{},{not_before:'bad'},{not_before:start,allow_history:true}])assert.throws(()=>validateConfig({...config,durable_intake:c}));
 assert.throws(()=>acceptMessage(message,config,now),/window/);
 assert.equal(acceptQueuedPublish(message,config,{from:start,to:(now/1000).toFixed(6)},now).request_id,id);
 for(const patch of [{edited:{}},{user:'UOTHER'},{ts:'1793491199.000001'},{files:[]}])assert.throws(()=>acceptQueuedPublish({...message,...patch},config,{from:start,to:(now/1000).toFixed(6)},now));
 assert.throws(()=>acceptQueuedPublish(message,config,{from:start,to:'9999999999.999999'},now));
});
test('page envelopes and fixed-range progress survive restart, expired freshness and file outages',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'publisher-inbox-')),file=path.join(dir,'state.sqlite');let s=make(file);
 try{
  let inbox=new PublisherInbox(s,config),args;
  await inbox.scan({historyPage:async q=>{args=q;return {messages:[message],next_cursor:'page-two'};}},now);
  assert.equal(args.from,start);const upper=args.to;s.close();s=make(file);inbox=new PublisherInbox(s,config);
  await assert.rejects(inbox.scan({historyPage:async q=>{assert.equal(q.to,upper);assert.equal(q.cursor,'page-two');throw Error('offline');}},now+3600000));
  assert.equal(s.db.prepare('SELECT watermark FROM publisher_intake_scan').get().watermark,start);
  await inbox.scan({historyPage:async q=>{assert.equal(q.to,upper);return {messages:[message],next_cursor:null};}},now+3600000);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publisher_inbox').get().n,1);
  let downloads=0;const slack={...slackFor(),download:async()=>{downloads++;throw Error('private token');}};
  const failure=await inbox.admitOne(slack,now+3600000);assert.equal(failure.code,'unclassified');assert(!JSON.stringify(inbox.pending()).includes('private token'));
  await inbox.admitOne(slack,now+3600001);assert.equal(downloads,1);
  s.close();s=make(file);inbox=new PublisherInbox(s,config);await inbox.admitOne(slackFor(),now+3602000);
  assert.equal(s.metadata(id).hash,hash);assert.equal(inbox.pending().length,0);
  await inbox.admitOne({download:()=>assert.fail('no duplicate')},now+7200000);
 }finally{s.close();await rm(dir,{recursive:true,force:true});}
});
test('expired provider cursor restarts the same bounded scan without dropping discovered messages',async()=>{
 const s=make(),inbox=new PublisherInbox(s,config);try{
  await inbox.scan({historyPage:async()=>({messages:[message],next_cursor:'expired'})},now);
  await assert.rejects(inbox.scan({historyPage:async()=>{throw Object.assign(Error('expired'),{diagnostic:{stage:'slack.conversations.history',code:'invalid_cursor'}});}},now+1000));
  assert.equal(s.db.prepare('SELECT page_cursor FROM publisher_intake_scan').get().page_cursor,null);
  await inbox.scan({historyPage:async q=>{assert.equal(q.to,(now/1000).toFixed(6));assert.equal(q.cursor,null);return {messages:[message],next_cursor:null};}},now+2000);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publisher_inbox').get().n,1);
 }finally{s.close();}
});
test('changed source, conflicting repost and mismatched bytes cannot create a second original job',async()=>{
 for(const kind of ['edited','bytes','repost']){
  const s=make(),inbox=new PublisherInbox(s,config);try{
   await inbox.scan(slackFor(),now);
   const slack=slackFor();
   if(kind==='edited'){slack.exactPublish=async()=>({...message,edited:{}});slack.download=()=>assert.fail('edited message cannot download');}
   if(kind==='bytes')slack.download=async()=>Buffer.from('{}');
   if(kind==='repost')s.admit({request_id:id,source_ts:'1793491200.000001',hash},bytes);
   assert.equal((await inbox.admitOne(slack,now)).outcome,'not_started');
   assert.equal(s.pending().length,kind==='repost'?1:0);assert.equal(inbox.pending().length,1);
  }finally{s.close();}
 }
});
test('inbox preserves identity boundary and cannot silently revert to freshness-only mode',async()=>{
 const s=make();try{
  new PublisherInbox(s,config);
  assert.throws(()=>new PublisherInbox(s,{...config,durable_intake:{not_before:'1793491201.000000'}}),/scope changed/);
  const {durable_intake,...old}=config;
  await assert.rejects(handoffTick(s,old,slackFor(),{}),/cannot be removed/);
 }finally{s.close();}
});
test('only one page and one file are read after existing verified work receives its scheduling turn',async()=>{
 const s=make(),order=[];try{
  s.admit({request_id:id,source_ts:ts,hash},bytes);
  s.move(id,'received','receipt_unknown',{commit:MERGE,proof:{publication_status:'verified',commit:MERGE,bundle_sha256:hash}});
  const slack={...slackFor(),historyPage:async()=>{order.push('page');return {messages:Array.from({length:100},(_,i)=>({ts:`17934912${String(i).padStart(2,'0')}.000001`,text:'ordinary'})),next_cursor:'next-page'};},download:()=>assert.fail('no matching publish')};
  const result=await handoffTick(s,{...config,scheduled_delivery:scheduled},slack,{now:()=>now,findReceipt:async()=>null,scheduleQuery:async()=>{order.push('schedule');return queued;}});
  assert.deepEqual(order,['schedule','page']);assert.equal(result.next_delay_ms,1000);
 }finally{s.close();}
});
test('Slack preflight outage blocks every Slack operation but permits original Pages and T4 progression',async()=>{
 const s=make(),calls=[];try{
  s.admit({request_id:id,source_ts:ts,hash},bytes);s.move(id,'received','verified',{commit:MERGE,proof:{publication_status:'verified',commit:MERGE,bundle_sha256:hash}});
  const blocked=await prepareSlack({preflight:async()=>{throw Error('private auth failure');},history:()=>assert.fail('unverified history'),receipt:()=>assert.fail('unverified write')});
  for(const method of ['history','historyPage','exactPublish','download','controlAsset','controlReceipt','findControlReceipt','receipt','assertReady'])assert.throws(()=>blocked[method]());
  const result=await handoffTick(s,{...config,scheduled_delivery:scheduled},blocked,{now:()=>now,verify:async()=>({publication_status:'verified',commit:MERGE,bundle_sha256:hash}),receipt:()=>blocked.receipt(),scheduleQuery:async(_c,q)=>{calls.push(q.action);return q.action==='status'?{status:'not_found'}:queued;}});
  assert.deepEqual(calls,['status','admit']);assert.equal(s.metadata(id).phase,'verified');assert.equal(result.scheduled.wecom_status,'queued');assert.equal(result.healthy,false);assert(!JSON.stringify(result).includes('private auth failure'));
 }finally{s.close();}
});
test('status distinguishes pending inbox from Publisher absence without admitting or downloading',async()=>{
 const s=make(),inbox=new PublisherInbox(s,config);let reply;try{
  await inbox.scan(slackFor(),now);await inbox.admitOne({...slackFor(),download:async()=>{throw Error('offline');}},now);
  await replyScheduledStatus(s,{...config,scheduled_delivery:scheduled},{request_id:id,source_ts:'1793494801.000001',hash:'status'}, {controlReceipt:async(_ts,text)=>{reply=JSON.parse(text.slice('!ai-report status-receipt '.length));return '1793494802.000001';}},async()=>({status:'not_found'}));
  assert.equal(reply.publisher_phase,'intake_pending');assert.equal(reply.publisher_intake.file_id,'F123');assert.equal(reply.publisher_intake.hash,hash);assert.equal(s.pending().length,0);assert.equal(intakeStatus(s.db,id).attempts,1);
 }finally{s.close();}
});
test('history pages require complete pagination and original range, never trust a remote URL',async()=>{
 const replies=[{messages:[message],has_more:true,response_metadata:{next_cursor:'two'}},{messages:[],has_more:false}];const requests=[];
 const slack=new SlackHandoff(config,'fixture',async(url)=>{requests.push(new URL(url));return Response.json({ok:true,...replies.shift()});});
 assert.equal((await slack.historyPage({from:start,to:(now/1000).toFixed(6)})).next_cursor,'two');
 assert.equal(requests[0].searchParams.get('limit'),'100');assert.equal(requests[0].searchParams.get('latest'),(now/1000).toFixed(6));
 for(const value of [{messages:[],has_more:true},{messages:[{...message,ts:'1793491199.000001'}]},{messages:[],response_metadata:{next_cursor:42}}]){
  const bad=new SlackHandoff(config,'fixture',async()=>Response.json({ok:true,...value}));await assert.rejects(bad.historyPage({from:start,to:(now/1000).toFixed(6)}));
 }
});
test('receipt pagination finds late receipts and rejects duplicate or incomplete evidence',async()=>{
 const thread='1793491200.000001',text='receipt',receipt={type:'message',ts:'1793491400.000001',thread_ts:thread,text,user:'U456',bot_id:'B456'};
 for(const variant of ['found','duplicate','incomplete']){
  let page=0;const slack=new SlackHandoff(config,'fixture',async()=>{
   page++;
   if(page===1)return Response.json({ok:true,messages:[{type:'message',ts:thread,text:'root'},...(variant==='duplicate'?[{...receipt,ts:'1793491300.000001'}]:[])],has_more:true,response_metadata:{next_cursor:'two'}});
   return Response.json({ok:true,messages:[receipt],has_more:variant==='incomplete'});
  });
  if(variant==='found')assert.equal(await slack.findControlReceipt(thread,text),receipt.ts);
  else await assert.rejects(slack.findControlReceipt(thread,text));
  assert.equal(page,2);
 }
});
test('trusted HTTP 429 status rejection returns to ready and retries the same receipt after cooldown',async()=>{
 const s=make(),event={request_id:id,source_ts:ts,hash:'status'};let clock=now,posts=0,deadline=0;
 const slack=new SlackHandoff(config,'fixture',async(_url,options)=>{
  posts++;if(posts===1)return new Response('',{status:429,headers:{'retry-after':'60'}});
  const request=JSON.parse(options.body);return Response.json({ok:true,channel:'C123',ts:'1793494801.000001',message:{thread_ts:ts,bot_id:'B456',user:'U456',text:request.text}});
 },{now:()=>clock,cooldowns:{deadline:()=>deadline,defer:async(_method,at)=>{deadline=at;}}});
 try{
  await assert.rejects(replyScheduledStatus(s,{...config,scheduled_delivery:scheduled},event,slack,async()=>({status:'not_found'})));
  assert.equal(s.db.prepare('SELECT phase FROM scheduled_status_replies').get().phase,'ready');
  await assert.rejects(replyScheduledStatus(s,{...config,scheduled_delivery:scheduled},event,slack,()=>assert.fail('already ready')));assert.equal(posts,1);
  clock+=60000;await replyScheduledStatus(s,{...config,scheduled_delivery:scheduled},event,slack,()=>assert.fail('original result reused'));
  assert.equal(posts,2);assert.equal(s.db.prepare('SELECT phase FROM scheduled_status_replies').get().phase,'sent');
 }finally{s.close();}
});
test('serialized not_started is insufficient to replay an uncertain status write',async()=>{
 const s=make();try{
  await replyScheduledStatus(s,{...config,scheduled_delivery:scheduled},{request_id:id,source_ts:ts,hash:'status'},{controlReceipt:async()=>{throw Object.assign(Error('untrusted'),{diagnostic:{outcome:'not_started',retryable:true}});}},async()=>({status:'not_found'}));
  assert.equal(s.db.prepare('SELECT phase FROM scheduled_status_replies').get().phase,'unknown');
 }finally{s.close();}
});
