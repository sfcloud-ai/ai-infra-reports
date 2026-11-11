import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptProducerInspect,encodeBundle,decodeBundle,canonicalRequestDate} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {handoffTick} from '../scripts/run-handoff.mjs';
import {PublisherInbox} from '../scripts/publisher-inbox.mjs';
import {producerInspection,inspectPublisherDay,INSPECT_PREFIX} from '../scripts/producer-inspect.mjs';
import {replyScheduledStatus,scheduledQueryBudget} from '../scripts/scheduled-delivery-bridge.mjs';
import {confirmedSlackRejection} from '../scripts/handoff-recovery.mjs';
import {FILES,SCOPE,DAY,MERGE,TARGET} from './helpers/cloud-sender-fixture.mjs';
const id='morning-20261101-r1',bytes=await encodeBundle(FILES,id,'a'.repeat(40),'b'.repeat(40)),hash=digest(bytes),source='1793491200.000010';
const config={...SCOPE,notification_not_before:'1793462400.000000',producer_app_id:1,merger_app_id:2,ready_for_review:false,durable_intake:{not_before:'1793462400.000000'},scheduled_delivery:{activation_date:DAY,executable:'/usr/bin/python3',args:['/fixture/client.py']}};
const nonce='11111111-1111-4111-8111-111111111111';
const command={query_id:nonce,kind:'inspect',request_id:id,report_date:DAY,bundle_sha256:hash};
const event={...command,source_ts:source,hash:digest('fixture-query')};
const empty=()=>({read_context:{scheduler_scope_sha256:'d'.repeat(64)},observed_at:Date.now(),complete:true,scheduler_day_claim:null,scheduler:null});
function state(){const s=new HandoffState(':memory:',handoffScope(config));new PublisherInbox(s,config);s.db.prepare('UPDATE publisher_intake_scan SET watermark=?').run(source);return s;}
function admit(s){s.admit({request_id:id,hash,source_ts:'1793491200.000001',file_id:'F123'},bytes);s.move(id,'received','receipt_unknown',{...s.get(id).detail,commit:MERGE});}
function message(text){return {type:'message',user:SCOPE.sender_user_id,app_id:SCOPE.sender_user_app_id,ts:source,text:text+' '+SCOPE.sender_attribution_text,blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text}]}]},{type:'context',elements:[{type:'mrkdwn',text:SCOPE.sender_attribution_text,verbatim:false}]}]};}

test('inspect authenticates the exact original App, visible command, date and no-file envelope',()=>{
 const text=`!ai-report inspect ${id} ${DAY} ${hash} ${nonce}`,m=message(text);
 assert.deepEqual(acceptProducerInspect(m,config,TARGET),{...command,source_ts:source,hash:digest(text)});
 for(const patch of [{user:'UOTHER'},{app_id:'AOTHER'},{bot_id:'BOTHER'},{edited:{}},{thread_ts:'1793491200.000002'},{files:[{id:'F123'}]},{blocks:[]},{text:text+'x '+SCOPE.sender_attribution_text}])assert.throws(()=>acceptProducerInspect({...m,...patch},config,TARGET));
 assert.throws(()=>acceptProducerInspect(message(text.replace(DAY,'2026-02-30')),config,TARGET));
 assert.throws(()=>acceptProducerInspect(message(text.replace(nonce,'bad-query')),config,TARGET));
 assert.throws(()=>acceptProducerInspect(message(text.replace(' '+nonce,'')),config,TARGET));
 assert.throws(()=>acceptProducerInspect(m,config,TARGET+16*60000));
});

test('canonical request date/revision is proven by actual bytes, not trusted filename',async()=>{
 assert.equal(canonicalRequestDate(id),DAY);assert.equal(canonicalRequestDate('custom-request'),null);
 await assert.rejects(encodeBundle(FILES,'morning-20261102-r1','a'.repeat(40),'b'.repeat(40)),/edition differs/);
 await assert.rejects(encodeBundle(FILES,'morning-20261101-r2','a'.repeat(40),'b'.repeat(40)),/edition differs/);
 assert.equal((await decodeBundle(bytes)).report.date,DAY);
});

test('empty inspection requires full date scan, preserves rows and exposes no content',async()=>{
 const s=state();try{
  const before=s.db.prepare('SELECT * FROM jobs').all();
  const result=await producerInspection(s,config,command,source,async(c,r)=>{assert.deepEqual(r,{action:'inspect',request_id:id,report_date:DAY});return empty();});
  assert.equal(result.complete,true);assert.equal(result.query_id,nonce);assert.equal(result.publisher,null);assert.equal(result.scheduler,null);assert.deepEqual(s.db.prepare('SELECT * FROM jobs').all(),before);
  assert.equal(JSON.stringify(result).includes('base64'),false);
  s.db.prepare('UPDATE publisher_intake_scan SET watermark=?').run('1793491199.999999');
  await assert.rejects(inspectPublisherDay(s,config,command,source),/scan/);
  await assert.rejects(inspectPublisherDay(s,{...config,durable_intake:{not_before:'1793491200.000000'}},command,source),/scan/);
 }finally{s.close();}
});

test('unknown target retains original file/source/hash and ignores unrelated unresolved dates',async()=>{
 const s=state();try{
  admit(s);s.db.prepare('INSERT INTO publisher_inbox(source_ts,request_id,file_id,hash) VALUES (?,?,?,?)').run('1793404800.000001','unmapped-old','F999','9'.repeat(64));
  const original=s.get(id),local=await inspectPublisherDay(s,config,command,source);
  assert.deepEqual(local.publisher,{request_id:id,report_date:DAY,bundle_sha256:hash,source_ts:original.source_ts,report_commit:MERGE,file_id:'F123'});
  assert.deepEqual(s.get(id),original);
  s.db.prepare('UPDATE jobs SET detail=?').run(JSON.stringify({commit:MERGE}));
  assert.equal((await inspectPublisherDay(s,config,command,source)).publisher.file_id,null);
 }finally{s.close();}
});

test('pending unknown day or same-day conflict never yields empty; another canonical date is isolated',async()=>{
 const s=state();try{
  const insert=s.db.prepare('INSERT INTO publisher_inbox(source_ts,request_id,file_id,hash) VALUES (?,?,?,?)');
  insert.run('1793404800.000001','morning-20261031-r1','F999','9'.repeat(64));
  assert.equal((await inspectPublisherDay(s,config,command,source)).publisher,null);
  insert.run('1793491200.000002',id,'F998',hash);
  await assert.rejects(inspectPublisherDay(s,config,command,source),/unresolved/);
  s.db.prepare('DELETE FROM publisher_inbox WHERE request_id=?').run(id);insert.run('1793491200.000003','unknown-date-id','F997',hash);
  await assert.rejects(inspectPublisherDay(s,config,command,source),/unresolved/);
 }finally{s.close();}
});

test('other request occupying the date and crossed bindings fail closed without leaking its details',async()=>{
 const s=state();try{
  const other='private-other-request',b=await encodeBundle(FILES,other,'a'.repeat(40),'b'.repeat(40));
  s.admit({request_id:other,hash:digest(b),source_ts:'1793491200.000001'},b);
  await assert.rejects(inspectPublisherDay(s,config,command,source),e=>e.message==='Publisher day occupied'&&!e.message.includes(other));
 }finally{s.close();}
});

test('original inspection retains its binding alongside an explicitly declared revision',async()=>{
 const s=state();try{
  admit(s);
  const revised=new Map([...FILES].map(([p,b])=>[p.replace('/r1/','/r2/'),p.endsWith('/report.json')?Buffer.from(JSON.stringify({...JSON.parse(b),schema_version:'1.1',revision:2,revision_notice:{kind:'maintenance',summary:'修复排版。'}})):b]));
  const rid='morning-20261101-r2',raw=await encodeBundle(revised,rid,'a'.repeat(40),'b'.repeat(40));
  s.admit({request_id:rid,hash:digest(raw),source_ts:'1793491200.000002'},raw);
  const snapshot=await inspectPublisherDay(s,config,command,source);
  assert.equal(snapshot.publisher.request_id,id);assert.equal(snapshot.publisher.bundle_sha256,hash);
  assert.deepEqual(snapshot.publisher_day.map(row=>row.request_id),[id,rid]);
 }finally{s.close();}
});

test('late remote snapshot, impossible counts and wrong original commit cannot authorize recovery',async()=>{
 const s=state();try{
  admit(s);const claim={request_id:id,report_date:DAY,bundle_sha256:hash,report_commit:MERGE};
  const remote=()=>({...empty(),scheduler_day_claim:claim,scheduler:{...claim,status:'unknown',phase:'unknown',parts_sent:0,parts_total:2,attempts:2,next_attempt_at:1793923213.7277515,images:[{file_id:'scheduled-poster',status:'unknown',error:'secret body with spaces'}],last_error:'private token'}});
  const result=await producerInspection(s,config,command,source,async()=>remote());assert.equal(result.scheduler.status,'unknown');assert.equal(result.scheduler.next_attempt_at,1793923213.7277515);assert.equal(result.scheduler.last_error,'unspecified');assert.equal(result.scheduler.images[0].error,'unspecified');
  for(const patch of [{observed_at:Date.now()-61000},{complete:false},{scheduler:{...remote().scheduler,attempts:0.5}},{scheduler:{...remote().scheduler,next_attempt_at:Infinity}},{scheduler:{...remote().scheduler,parts_sent:3}},{scheduler:{...remote().scheduler,report_commit:'e'.repeat(40)}}])await assert.rejects(producerInspection(s,config,command,source,async()=>({...remote(),...patch})));
 }finally{s.close();}
});

test('confirmed no-send rejection refreshes stale inspect before retry, unknown reply is only reconciled',async t=>{
 let clock=TARGET,posts=0,queries=0; t.mock.method(Date,'now',()=>clock);
 const s=state(),slack={controlReceipt:async()=>{posts++;throw confirmedSlackRejection(Error('429'));}};
 try{
  const query=async()=>{queries++;return empty();};
  await assert.rejects(replyScheduledStatus(s,config,event,slack,query));assert.equal(queries,1);
  clock+=61000;slack.controlReceipt=async()=>{posts++;throw Error('timeout');};
  await replyScheduledStatus(s,config,event,slack,query);assert.equal(queries,2);assert.equal(posts,2);
  const text=s.db.prepare('SELECT text FROM scheduled_status_replies').get().text;
  assert.equal(JSON.parse(text.slice(INSPECT_PREFIX.length)).observed_at,clock);
  clock+=61000;slack.findControlReceipt=async(ts,original)=>{assert.equal(original,text);return null;};
  await replyScheduledStatus(s,config,event,slack,()=>assert.fail('unknown must not recompose'));assert.equal(posts,2);
  slack.findControlReceipt=async()=> '1793491322.000001';await replyScheduledStatus(s,config,event,slack,query);
  assert.equal(s.db.prepare('SELECT phase FROM scheduled_status_replies').get().phase,'sent');assert.equal(posts,2);
 }finally{s.close();}
});

test('late Publisher admission invalidates a previously empty snapshot on a new inspection',async()=>{
 const s=state();try{
  assert.equal((await producerInspection(s,config,command,source,async()=>empty())).publisher,null);
  admit(s);const result=await producerInspection(s,config,command,source,async()=>empty());
  assert.equal(result.publisher.file_id,'F123');assert.equal(result.scheduler,null);
 }finally{s.close();}
});


test('read-only scheduler queries cannot consume the full publication verification budget',()=>{
 assert.equal(scheduledQueryBudget({action:'inspect'}),10000);
 assert.equal(scheduledQueryBudget({action:'status'}),10000);
 assert.equal(scheduledQueryBudget({action:'admit'}),180000);
 assert.throws(()=>scheduledQueryBudget({action:'send'}));
});


test('three sequential fresh inspection gates reply in their discovery tick, without extra two-minute waits',async t=>{
 let clock=TARGET+1000,posts=0; t.mock.method(Date,'now',()=>clock);
 const s=new HandoffState(':memory:',handoffScope(config));
 try{
  for(let step=0;step<3;step++){
   const querySource=((clock-500)/1000).toFixed(6),text=`!ai-report inspect ${id} ${DAY} ${hash} ${nonce}`;
   const m={...message(text),ts:querySource};
   const slack={history:async()=>[m],historyPage:async()=>({messages:[m],next_cursor:null}),controlReceipt:async(ts,text)=>{assert.equal(ts,querySource);assert.equal(JSON.parse(text.slice(INSPECT_PREFIX.length)).complete,true);posts++;return (clock/1000).toFixed(6);}};
   const result=await handoffTick(s,config,slack,{now:()=>clock,scheduleQuery:async()=>empty()});
   assert.equal(posts,step+1);assert.deepEqual(result.errors,[]);assert.equal(result.next_delay_ms,120000);
   clock+=1000; // A new proof is demanded after each ticket/POST/complete intent.
  }
 }finally{s.close();}
});

test('partial or older fixed scans promptly catch up to inspect but never claim empty early',async t=>{
 let clock=TARGET+2000,posts=0,calls=0; t.mock.method(Date,'now',()=>clock);
 const s=state();
 try{
  s.db.prepare('UPDATE publisher_intake_scan SET watermark=?,upper_bound=?,page_cursor=?').run(config.durable_intake.not_before,'1793491200.000000','old-page');
  const querySource='1793491201.000000',text=`!ai-report inspect ${id} ${DAY} ${hash} ${nonce}`,m={...message(text),ts:querySource};
  const slack={history:async()=>[m],historyPage:async()=>({messages:[],next_cursor:++calls===1?'last-page':null}),controlReceipt:async()=>{posts++;return '1793491202.000001';}};
  for(let tick=0;tick<2;tick++){
   const r=await handoffTick(s,config,slack,{now:()=>clock,scheduleQuery:async()=>empty()});
   assert.equal(posts,0);assert.equal(r.next_delay_ms,1000);assert.equal(s.db.prepare('SELECT phase FROM scheduled_status_replies').get().phase,'queued');clock+=1000;
  }
  const r=await handoffTick(s,config,slack,{now:()=>clock,scheduleQuery:async()=>empty()});
  assert.equal(posts,1);assert.deepEqual(r.errors,[]);assert.equal(r.next_delay_ms,120000);
 }finally{s.close();}
});

test('an authenticated original inspect survives a publisher outage beyond the freshness window',async t=>{
 let clock=TARGET+3600000,posts=0;t.mock.method(Date,'now',()=>clock);
 const s=new HandoffState(':memory:',handoffScope(config)),text=`!ai-report inspect ${id} ${DAY} ${hash} ${nonce}`,m=message(text);
 try{
  assert.throws(()=>acceptProducerInspect(m,config,clock),/window/);
  const slack={history:async()=>[],historyPage:async()=>({messages:[m],next_cursor:null}),controlReceipt:async(ts)=>{assert.equal(ts,source);posts++;return '1793494800.000001';}};
  const r=await handoffTick(s,config,slack,{now:()=>clock,scheduleQuery:async()=>empty()});
  assert.equal(posts,1);assert.deepEqual(r.errors,[]);assert.equal(s.db.prepare('SELECT source_ts,phase FROM scheduled_status_replies').get().phase,'sent');
  clock+=120000;await handoffTick(s,config,{...slack,historyPage:async()=>({messages:[],next_cursor:null})},{now:()=>clock,scheduleQuery:async()=>empty()});assert.equal(posts,1);
 }finally{s.close();}
});

test('durable old read commands retain identity, no-edit and fixed-boundary checks',async()=>{
 const s=state();try{
  s.db.prepare('UPDATE publisher_intake_scan SET watermark=?').run(config.durable_intake.not_before);
  const inbox=new PublisherInbox(s,config),text=`!ai-report inspect ${id} ${DAY} ${hash} ${nonce}`,original=message(text);
  const messages=[{...original,user:'UOTHER'},{...original,ts:'1793491200.000011',edited:{}},{...original,ts:'1793491200.000012',files:[{id:'F123'}]}];
  const r=await inbox.scan({historyPage:async()=>({messages,next_cursor:null})},TARGET+3600000);
  assert.equal(r.read_commands,0);assert.equal(r.rejected.length,3);
  assert.equal(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='scheduled_status_replies'").get(),undefined);
 }finally{s.close();}
});


test('inspection fetches individual bounded blobs, never the complete history into memory',async t=>{
 const s=state();try{
  admit(s);let blobReads=0;
  const prepare=s.db.prepare.bind(s.db);
  t.mock.method(s.db,'prepare',sql=>{
   const statement=prepare(sql);
   if(sql==='SELECT bytes,detail FROM jobs WHERE id=?')return {get:(...args)=>{blobReads++;return statement.get(...args);},all:()=>assert.fail('Do not load the BLOB history')};
   assert(!/^SELECT \* FROM jobs/.test(sql),'Do not load full job rows');
   return statement;
  });
  const result=await inspectPublisherDay(s,config,command,source);assert.equal(result.publisher.file_id,'F123');assert.equal(blobReads,1);
 }finally{s.close();}
});

test('inspection read budget and oversized blob fail closed without leaving an open snapshot',async()=>{
 const s=state();try{
  admit(s);let elapsed=0;
  await assert.rejects(inspectPublisherDay(s,config,command,source,{now:()=>{elapsed+=46000;return elapsed;}}),/budget/);
  s.db.exec('BEGIN');s.db.exec('ROLLBACK'); // The failed read released its transaction.
  const original=s.get(id);
  s.db.prepare('UPDATE jobs SET bytes=zeroblob(?) WHERE id=?').run(8*1024*1024+1,id);
  await assert.rejects(inspectPublisherDay(s,config,command,source),/too large/);
  s.db.prepare('UPDATE jobs SET bytes=? WHERE id=?').run(original.bytes,id);
  assert.equal((await inspectPublisherDay(s,config,command,source)).publisher.file_id,'F123');
 }finally{s.close();}
});

test('day lookup retains legacy original bytes and completion intent after public source migration',async()=>{
 const s=state();try{
  admit(s);
  const detail={...s.get(id).detail,completion_intent:{url:`https://sfcloud-ai.github.io/ai-infra-reports/${DAY}/r1/`,text_sha256:'c'.repeat(64)}};
  s.db.prepare('UPDATE jobs SET detail=? WHERE id=?').run(JSON.stringify(detail),id);
  const before=s.get(id),decoded=await decodeBundle(before.bytes);
  assert.equal(decoded.report.path,`reports/${DAY}/r1/`);
  const result=await inspectPublisherDay(s,config,command,source);
  assert.equal(result.publisher.bundle_sha256,digest(bytes));assert.equal(result.publisher.report_commit,MERGE);
  assert.deepEqual(s.get(id),before);assert.deepEqual(before.bytes,bytes);
  // The same day cannot be treated as absent using a newly encoded/current bundle.
  const currentFiles=new Map([...decoded.files].map(([p,b])=>[p.replace(decoded.report.path,`reports/${DAY}/`),b]));
  const currentBytes=await encodeBundle(currentFiles,id,'a'.repeat(40),'b'.repeat(40));
  assert.notEqual(digest(currentBytes),hash);
  await assert.rejects(inspectPublisherDay(s,config,{...command,bundle_sha256:digest(currentBytes)},source),/conflicts/);
  assert.deepEqual(s.get(id),before);
 }finally{s.close();}
});
