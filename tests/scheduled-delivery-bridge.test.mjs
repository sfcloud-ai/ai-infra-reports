import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {advanceScheduledDelivery,validateScheduledConfig} from '../scripts/scheduled-delivery-bridge.mjs';
import {handoffTick,validateConfig} from '../scripts/run-handoff.mjs';
import {FILES,MERGE} from './helpers/cloud-sender-fixture.mjs';
const id='scheduled-bridge-fixture',bytes=await encodeBundle(FILES,id,'a'.repeat(40),'b'.repeat(40)),hash=digest(bytes);
const scheduled={activation_date:'2026-11-01',executable:'/usr/bin/python3',args:['/trusted/scheduled_client.py','--socket','/run/relay/scheduled.sock','--reader-uid','1002']};
const config={team_id:'T123',channel_id:'C123',sender_user_id:'U123',bot_user_id:'U456',bot_id:'B456',producer_app_id:10,merger_app_id:11,slack_token_file:'/private/token',producer_key_file:'/private/key',state_dir:'/private/state',ready_for_review:false,scheduled_delivery:scheduled};
const state=()=>{const s=new HandoffState(':memory:',handoffScope(config));s.admit({request_id:id,hash,source_ts:'1793491200.000001'},bytes);s.move(id,'received','receipt_unknown',{commit:MERGE,proof:{publication_status:'verified',commit:MERGE,bundle_sha256:hash}});return s;};
const queued={request_id:id,report_date:'2026-11-01',report_commit:MERGE,bundle_sha256:hash,status:'queued',phase:'pending',parts_total:2,parts_sent:0};
test('explicit opt-in config leaves existing handoff scope unchanged',()=>{
 assert.equal(validateConfig(config),config);const {scheduled_delivery,...old}=config;assert.deepEqual(handoffScope(config),handoffScope(old));
 for(const patch of [{activation_date:'2026-02-30'},{destination:'other'},{executable:'relative'}])assert.throws(()=>validateScheduledConfig({...scheduled,...patch}));
});
test('configuration key order is stable but a changed endpoint still blocks',async()=>{
 const s=state();try{
  await advanceScheduledDelivery(s,config,async()=>queued);
  const reordered={args:scheduled.args,executable:scheduled.executable,activation_date:scheduled.activation_date};
  assert.equal((await advanceScheduledDelivery(s,{...config,scheduled_delivery:reordered},async()=>queued)).phase,'observed');
  await assert.rejects(()=>advanceScheduledDelivery(s,{...config,scheduled_delivery:{...scheduled,args:['/different.py']}},async()=>queued),/scope changed/);
 }finally{s.close();}
});
test('slow advisory requests cannot delay intake and only one is queried per tick',async t=>{
 let now=1793491201000,reads=0;
 t.mock.method(Date,'now',()=>now);
 const statuses=Array.from({length:6},(_,i)=>({type:'message',user:'U123',ts:`1793491200.00000${i+1}`,text:'!ai-report status status-query-'+i}));
 const publish={type:'message',subtype:'file_share',user:'U123',ts:'1793491200.000009',text:`!ai-report publish ${id} ${hash}`,files:[{id:'F123'}]};
 const s=new HandoffState(':memory:',handoffScope(config));
 try{
  const slack={history:async()=>[...statuses,publish],download:async()=>bytes,controlReceipt:async()=> '1793491201.000001'};
  const io={propose:async()=>({url:'https://github.com/sfcloud-ai/ai-infra-reports/pull/1',sha:'c'.repeat(40)}),scheduleQuery:async()=>{
   reads++;assert.equal(s.get(id).phase,'pr_open');now+=180000;return {status:'not_found'};
  }};
  await handoffTick(s,config,slack,io);
  assert.equal(reads,1);assert.equal(s.get(id).phase,'pr_open');
 }finally{s.close();}
});
test('status first, exact bytes admission once, partial is not completion',async()=>{
 const s=state();let admitted=false,calls=[];
 const query=async(c,r)=>{calls.push(r);if(r.action==='status')return admitted?queued:{status:'not_found'};admitted=true;assert.equal(r.bundle_base64,bytes.toString('base64'));return queued;};
 try{assert.equal((await advanceScheduledDelivery(s,config,query)).wecom_status,'queued');await advanceScheduledDelivery(s,config,query);assert.deepEqual(calls.map(x=>x.action),['status','admit','status']);}finally{s.close();}
});
test('lost admission response reconciles original request without another admission',async()=>{
 const s=state();let admitted=false,writes=0;
 const query=async(c,r)=>{if(r.action==='status')return admitted?queued:{status:'not_found'};writes++;admitted=true;throw Error('lost local reply');};
 try{assert.equal((await advanceScheduledDelivery(s,config,query)).phase,'reconcile_pending');assert.equal((await advanceScheduledDelivery(s,config,query)).phase,'observed');assert.equal(writes,1);}finally{s.close();}
});
test('complete requires all real parts and rejects wrong binding',async()=>{
 const s=state();try{
  assert.equal((await advanceScheduledDelivery(s,config,async()=>({...queued,bundle_sha256:'f'.repeat(64)}))).phase,'reconcile_pending');
  assert.equal((await advanceScheduledDelivery(s,config,async()=>({...queued,status:'sent',phase:'complete',parts_sent:1}))).phase,'reconcile_pending');
  assert.equal((await advanceScheduledDelivery(s,config,async()=>({...queued,status:'sent',phase:'complete',parts_sent:2}))).phase,'complete');
  assert.equal((await advanceScheduledDelivery(s,config,()=>assert.fail('completed report must not query or send again'))).phase,'idle');
 }finally{s.close();}
});
test('lost Slack publication receipt does not block T4 scheduling or get resent',async()=>{
 const s=state();try{
  const result=await handoffTick(s,config,{history:async()=>[]},{scheduleQuery:async()=>queued});
  assert.equal(result.scheduled.phase,'observed');assert.equal(s.get(id).phase,'receipt_unknown');
 }finally{s.close();}
});
import {acceptReportStatus} from '../scripts/report-handoff.mjs';
import {replyScheduledStatus,advanceScheduledStatus} from '../scripts/scheduled-delivery-bridge.mjs';
test('expired source replies reconcile from the durable journal without another write',async()=>{
 const s=state();let writes=0;
 try{
  const old={request_id:id,source_ts:'1793491200.000001',hash:'original-hash'};
  await replyScheduledStatus(s,config,old,{controlReceipt:async()=>{writes++;throw Error('lost response');}},async()=>queued);
  const before=s.db.prepare('SELECT * FROM scheduled_status_replies').get();
  assert.equal(before.phase,'unknown');
  const slack={controlReceipt:()=>assert.fail('must not repost'),findControlReceipt:async(ts,text)=>{
   assert.equal(ts,old.source_ts);assert.equal(text,before.text);return '1793491201.000001';
  }};
  await advanceScheduledStatus(s,config,[],slack,()=>assert.fail('no new remote status query'));
  assert.equal(s.db.prepare('SELECT phase FROM scheduled_status_replies').get().phase,'sent');
  assert.equal(writes,1);
 }finally{s.close();}
});
test('plain status authenticates original sender without an upload or business write',async()=>{
 const now=1793491201000,message={type:'message',user:'U123',ts:'1793491200.000001',text:'!ai-report status '+id};
 const event=acceptReportStatus(message,config,now);assert.equal(event.request_id,id);
 assert.equal(acceptReportStatus({...message,thread_ts:message.ts},config,now).request_id,id);
 for(const change of [{user:'U999'},{edited:{}},{files:[{id:'F123'}]},{thread_ts:"1793491199.000001"},{app_id:'AOTHER'}])assert.throws(()=>acceptReportStatus({...message,...change},config,now));
 const s=state();let replies=0,reads=0;
 try{
  const slack={controlReceipt:async()=>{replies++;return '1793491201.000001';},findControlReceipt:()=>assert.fail()};
  const query=async(c,r)=>{reads++;assert.equal(r.action,'status');return queued;};
  await replyScheduledStatus(s,config,event,slack,query);await replyScheduledStatus(s,config,event,slack,query);
  assert.equal(reads,1);assert.equal(replies,1);assert.equal(s.get(id).phase,'receipt_unknown');
 }finally{s.close();}
});
test('old unknown or repeatedly unreadable job cannot starve a new date',async()=>{
 const nextId='scheduled-bridge-next-day',nextFiles=new Map();
 for(const [p,b]of FILES){const next=p.replace('2026-11-01','2026-11-02');if(p.endsWith('/report.json')){const r=JSON.parse(b);r.date='2026-11-02';nextFiles.set(next,Buffer.from(JSON.stringify(r)));}else nextFiles.set(next,b);}
 const nextBytes=await encodeBundle(nextFiles,nextId,'a'.repeat(40),'b'.repeat(40)),nextHash=digest(nextBytes);
 for(const unreadable of [false,true]){
  const s=state(),calls=[];try{
   const query=async(c,r)=>{calls.push(r.request_id);if(r.request_id===id){if(unreadable)throw Error('old read failed');return {...queued,status:'unknown',phase:'unknown'};}return {...queued,request_id:nextId,report_date:'2026-11-02',bundle_sha256:nextHash};};
   await advanceScheduledDelivery(s,config,query);
   s.admit({request_id:nextId,hash:nextHash,source_ts:'1793577600.000001'},nextBytes);
   s.move(nextId,'received','verified',{commit:MERGE,proof:{publication_status:'verified',commit:MERGE,bundle_sha256:nextHash}});
   await advanceScheduledDelivery(s,config,query);await advanceScheduledDelivery(s,config,query);await advanceScheduledDelivery(s,config,query);
   assert.deepEqual(calls,[id,nextId,id,nextId]);
  }finally{s.close();}
 }
});
