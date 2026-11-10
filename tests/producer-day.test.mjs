import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptProducerDay,encodeBundle} from '../scripts/report-handoff.mjs';
import {inspectDay,DAY_PREFIX} from '../scripts/producer-day.mjs';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {PublisherInbox} from '../scripts/publisher-inbox.mjs';
import {replyScheduledStatus} from '../scripts/scheduled-delivery-bridge.mjs';
import {SUBMISSION_SCHEMA} from '../scripts/slack-submission.mjs';
import {digest} from '../scripts/archive.mjs';
import {confirmedSlackRejection} from '../scripts/handoff-recovery.mjs';
import {FILES,SCOPE,DAY,MERGE,TARGET} from './helpers/cloud-sender-fixture.mjs';
const id='morning-20261101-r1',source='1793491200.000010',nonce='11111111-1111-4111-8111-111111111111';
const config={...SCOPE,producer_app_id:1,merger_app_id:2,ready_for_review:false,durable_intake:{not_before:'1793462400.000000'},scheduled_delivery:{activation_date:DAY,executable:'/usr/bin/python3',args:['/fixture/client.py']}};
const command={kind:'day',request_id:id,report_date:DAY,query_id:nonce};
const event={...command,source_ts:source,hash:digest('query')};
const empty=()=>({complete:true,observed_at:Date.now(),read_context:{scheduler_scope_sha256:'d'.repeat(64)},scheduler_day_claim:null,scheduler:null});
function setup(){const s=new HandoffState(':memory:',handoffScope(config));new PublisherInbox(s,config);s.db.prepare('UPDATE publisher_intake_scan SET watermark=?').run(source);return s;}
function message(text){return {type:'message',user:SCOPE.sender_user_id,app_id:SCOPE.sender_user_app_id,ts:source,text:text+' '+SCOPE.sender_attribution_text,blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text}]}]},{type:'context',elements:[{type:'mrkdwn',text:SCOPE.sender_attribution_text,verbatim:false}]}]};}
const inspect=s=>inspectDay(s,config,command,source,async()=>empty());

test('hash-free day command authenticates original visible sender and canonical date',()=>{
 const text=`!ai-report day ${DAY} ${nonce}`,m=message(text);
 assert.deepEqual(acceptProducerDay(m,config,TARGET),{...command,source_ts:source,hash:digest(text)});
 for(const patch of [{user:'UOTHER'},{app_id:'AOTHER'},{edited:{}},{files:[{id:'F123'}]},{blocks:[]}])assert.throws(()=>acceptProducerDay({...m,...patch},config,TARGET));
 assert.throws(()=>acceptProducerDay(message(text.replace(DAY,'2026-02-30')),config,TARGET));
});

test('missed first run can discover a complete empty date without a manufactured hash',async()=>{
 const s=setup();try{
  const before=s.db.prepare('SELECT * FROM jobs').all(),result=await inspect(s);
  assert.equal(result.state,'empty');assert.equal(result.complete,true);assert.equal(result.bundle_sha256,undefined);
  assert.deepEqual(s.db.prepare('SELECT * FROM jobs').all(),before);
  s.db.prepare('UPDATE publisher_intake_scan SET watermark=?').run('1793491199.999999');
  await assert.rejects(inspect(s),/scan incomplete/);
 }finally{s.close();}
});

test('pending upload, staged bytes and noncanonical admitted date are never empty',async()=>{
 const s=setup();try{
  for(const sql of Object.values(SUBMISSION_SCHEMA))s.db.exec(sql);
  s.db.prepare('INSERT INTO slack_submission_events(source_ts,kind,request_id,hash,file_id) VALUES (?,?,?,?,?)').run(source,'stage',id,'a'.repeat(64),'F123');
  let result=await inspect(s);assert.equal(result.state,'pending');assert.equal(result.pending_submissions[0].file_id,'F123');
  s.db.prepare("UPDATE slack_submission_events SET phase='done'").run();
  s.db.prepare('INSERT INTO slack_staged_bundles(request_id,report_date,hash,source_ts,file_id,bytes) VALUES (?,?,?,?,?,?)').run(id,DAY,'a'.repeat(64),source,'F123',Buffer.from('retained'));
  result=await inspect(s);assert.equal(result.state,'occupied');assert.equal(result.staged_bundles[0].phase,'staged');
  const other='custom-original',bytes=await encodeBundle(FILES,other,'a'.repeat(40),'b'.repeat(40));
  s.admit({request_id:other,hash:digest(bytes),source_ts:'1793491200.000001'},bytes);
  result=await inspect(s);assert.equal(result.publisher_day[0].request_id,other);assert.equal(result.state,'occupied');
 }finally{s.close();}
});

test('unmapped intake blocks absence but canonical earlier-date state does not block tomorrow',async()=>{
 const s=setup();try{
  const insert=s.db.prepare('INSERT INTO publisher_inbox(source_ts,request_id,file_id,hash) VALUES (?,?,?,?)');
  insert.run('1793404800.000001','morning-20261031-r1','F123','a'.repeat(64));assert.equal((await inspect(s)).state,'empty');
  insert.run('1793404800.000002','unmapped-original','F124','b'.repeat(64));assert.equal((await inspect(s)).state,'pending');
 }finally{s.close();}
});

test('existing unknown delivery is returned with original binding and never re-admitted',async()=>{
 const s=setup();try{
  const bytes=await encodeBundle(FILES,id,'a'.repeat(40),'b'.repeat(40)),hash=digest(bytes);
  s.admit({request_id:id,hash,source_ts:'1793491200.000001'},bytes);s.move(id,'received','receipt_unknown',{commit:MERGE});
  const claim={request_id:id,report_date:DAY,bundle_sha256:hash,report_commit:MERGE};
  const result=await inspectDay(s,config,command,source,async(c,r)=>{assert.equal(r.action,'inspect');return {...empty(),scheduler_day_claim:claim,scheduler:{...claim,status:'unknown',phase:'unknown',parts_sent:1,parts_total:2}};});
  assert.equal(result.state,'occupied');assert.equal(result.scheduler.status,'unknown');assert.equal(s.get(id).phase,'receipt_unknown');
  await assert.rejects(inspectDay(s,config,command,source,async()=>({...empty(),complete:false})),/incomplete/);
 }finally{s.close();}
});

test('durable pagination queues original day query and restart resolves it only after full scan',async()=>{
 const s=setup();try{
  s.db.prepare('UPDATE publisher_intake_scan SET watermark=?').run(config.durable_intake.not_before);
  const inbox=new PublisherInbox(s,config),m=message(`!ai-report day ${DAY} ${nonce}`);
  await inbox.scan({historyPage:async()=>({messages:[m],next_cursor:'page2'})},TARGET+3600000);
  const saved=s.db.prepare('SELECT * FROM scheduled_status_replies').get();assert.equal(JSON.parse(saved.text).kind,'day');
  let posts=0;const slack={controlReceipt:async(ts,text)=>{posts++;assert.equal(JSON.parse(text.slice(DAY_PREFIX.length)).state,'empty');return '1793491200.000020';}};
  await assert.rejects(replyScheduledStatus(s,config,{source_ts:source,hash:saved.hash},slack,async()=>empty()),/scan incomplete/);assert.equal(posts,0);
  await new PublisherInbox(s,config).scan({historyPage:async()=>({messages:[],next_cursor:null})},TARGET+3600001);
  await replyScheduledStatus(s,config,{source_ts:source,hash:saved.hash},slack,async()=>empty());assert.equal(posts,1);
 }finally{s.close();}
});

test('stale unsent day replies refresh; unknown reply is reconciled without another post',async t=>{
 let clock=TARGET,queries=0,posts=0;t.mock.method(Date,'now',()=>clock);
 const s=setup();try{
  const query=async()=>{queries++;return empty();},slack={controlReceipt:async()=>{posts++;throw confirmedSlackRejection(Error('429'));}};
  await assert.rejects(replyScheduledStatus(s,config,event,slack,query));clock+=61000;
  slack.controlReceipt=async()=>{posts++;throw Error('timeout');};await replyScheduledStatus(s,config,event,slack,query);
  assert.equal(queries,2);assert.equal(posts,2);clock+=61000;
  slack.findControlReceipt=async()=>null;await replyScheduledStatus(s,config,event,slack,query);assert.equal(queries,2);assert.equal(posts,2);
 }finally{s.close();}
});
