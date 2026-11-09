import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installFence,assertFence,assertFencedEnvelope,consumeFencedEnvelope,registerCompletion} from '../scripts/producer-admission-fence.mjs';
const config={generation:'a1111111-1111-4111-8111-111111111111',activation_ts:'1794186000.000000',producer_scope_sha256:'b'.repeat(64),installation:{journal_device:'1',journal_inode:'2',lock_device:'1',lock_inode:'3'}};
const event={request_id:'morning-20261109-r1',hash:'c'.repeat(64),file_id:'F123',source_ts:'1794186001.000001'};
function fixture(){const db=new DatabaseSync(':memory:');return {db,metadata:()=>null};}
function grant(s){s.db.prepare('INSERT INTO producer_admission_grants VALUES(?,?,?,?,?,?,?,NULL)').run(event.request_id,'2026-11-09',event.hash,event.file_id,config.generation,'d1111111-1111-4111-8111-111111111111',1794186000000);}
test('runtime never initializes a missing fence or permits silent removal',()=>{const s=fixture();try{assert.throws(()=>assertFence(s.db,config),/schema/);assert.equal(s.db.prepare('SELECT count(*) n FROM sqlite_master').get().n,0);installFence(s.db,config,'synthetic migration fixture only',[]);assert.throws(()=>assertFence(s.db,null),/removed/);assert.throws(()=>installFence(s.db,config,'second',[]),/reinstall/);assert.throws(()=>assertFence(s.db,{...config,generation:'e1111111-1111-4111-8111-111111111111'}),/binding/);}finally{s.db.close();}});
test('obsolete cloud envelope and pre-cutover pending envelopes cannot be admitted',()=>{const s=fixture();try{installFence(s.db,config,'synthetic',[]);assert.throws(()=>assertFencedEnvelope(s,config,event),/Unregistered/);grant(s);assert.throws(()=>assertFencedEnvelope(s,config,{...event,source_ts:'1794185999.000001'}),/obsolete/);for(const p of [{hash:'e'.repeat(64)},{file_id:'FOLD'},{request_id:'morning-20261108-r1'}])assert.throws(()=>assertFencedEnvelope(s,config,{...event,...p}),/Unregistered/);}finally{s.db.close();}});
test('one admitted source binds immutable request date hash and file',()=>{const s=fixture();try{installFence(s.db,config,'synthetic',[]);grant(s);assert.throws(()=>consumeFencedEnvelope(s,config,event,'2026-11-10'),/date/);consumeFencedEnvelope(s,config,event,'2026-11-09');assert.doesNotThrow(()=>consumeFencedEnvelope(s,config,event,'2026-11-09'));assert.throws(()=>assertFencedEnvelope(s,config,{...event,source_ts:'1794186002.000001'}),/obsolete/);}finally{s.db.close();}});
test('original admitted jobs continue only with exact original bindings',()=>{const s=fixture();try{installFence(s.db,config,'synthetic',[]);s.metadata=()=>({hash:event.hash,source_ts:event.source_ts,detail:{intake_file_id:event.file_id}});assert.doesNotThrow(()=>assertFencedEnvelope(s,config,event));assert.throws(()=>assertFencedEnvelope(s,config,{...event,file_id:'FOTHER'}),/conflict/);assert.throws(()=>assertFencedEnvelope(s,config,{...event,source_ts:'1794186002.000001'}),/conflict/);}finally{s.db.close();}});
test('invalid Producer scope cannot register an admission',()=>{const s=fixture();try{installFence(s.db,config,'synthetic',[]);assert.throws(()=>registerCompletion(s.db,config,{scope:{}},event.request_id,1794186000001));assert.equal(s.db.prepare('SELECT count(*) n FROM producer_admission_grants').get().n,0);}finally{s.db.close();}});

import {ProducerUploadState,ProducerUploadAdapter,producerScopeHash} from '../scripts/producer-upload.mjs';
import {INSPECT_SCHEMA,ProducerInspect} from '../scripts/producer-native-inspect.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {FILES,BASE,PROMPTS,SCOPE} from './helpers/cloud-sender-fixture.mjs';
const scope={team_id:SCOPE.team_id,channel_id:SCOPE.channel_id,sender_user_id:SCOPE.sender_user_id,sender_user_app_id:SCOPE.sender_user_app_id,sender_attribution_text:SCOPE.sender_attribution_text,publisher_scope_sha256:'a'.repeat(64),scheduler_scope_sha256:'b'.repeat(64),scheduler_team_id:'T123',scheduler_channel_id:'D123'};
const id='morning-20261101-r1',time=1793494800000;
const bytes=await encodeBundle(FILES,id,BASE,PROMPTS.commit),hash=digest(bytes);
function ledger(){return {read_context:{publisher_scope_sha256:scope.publisher_scope_sha256,scheduler_scope_sha256:scope.scheduler_scope_sha256},observed_at:time,complete:true,publisher_day:[],publisher:null,scheduler_day_claim:null,scheduler:null};}
async function completeFixture(){
 const producer=new ProducerUploadState(':memory:',scope,{now:()=>time});await producer.prepare(bytes);
 const proof=()=>producer.observeDownstream(id,ledger());
 proof();producer.record(producer.next(id),{file_id:'F123',upload_url:'https://files.slack.com/upload/v1/SYNTHETIC'});
 proof();producer.record(producer.next(id),{adapter:'producer_curl_direct_v1',file_id:'F123',url_sha256:digest('https://files.slack.com/upload/v1/SYNTHETIC'),bundle_sha256:hash,metrics:{curl_exit:0,http_status:200,num_connects:1,num_redirects:0,upload_bytes:bytes.length,response_bytes:2,header_bytes:35,time_namelookup:.01,time_connect:.02,time_appconnect:.04,time_starttransfer:.05,ssl_verify_result:0,response_sha256:digest('OK')}});
 for(const sql of Object.values(INSPECT_SCHEMA))producer.db.exec(sql);
 const q='d1111111-1111-4111-8111-111111111111',ts=(time/1000).toFixed(6);
 producer.db.prepare('INSERT INTO producer_inspect_queries VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,1,q,time,ts,ts,ts,'f'.repeat(64),'resolved',q);
 producer.observeDownstream(id,ledger(),{inspectQueryId:q});return producer;
}
test('fresh complete action registers exact real-state binding and cannot mutate it',async()=>{
 const p=await completeFixture(),s=fixture(),c={...config,activation_ts:((time-1000)/1000).toFixed(6),producer_scope_sha256:producerScopeHash(scope)};
 try{installFence(s.db,c,'synthetic',[]);const action=p.next(id);assert.equal(action.next_action,'complete');registerCompletion(s.db,c,p,id,time);assert.equal(s.db.prepare('SELECT count(*) n FROM producer_admission_grants').get().n,1);registerCompletion(s.db,c,p,id,time);assert.throws(()=>registerCompletion(s.db,c,p,id,time+60000),/Fresh/);assert.equal(p.next(id).next_action,'read_original_file_and_share');}finally{p.close();s.db.close();}
});
test('local gate lock failure happens before COMPLETE intent, without native writes',async()=>{
 const p=await completeFixture();let native=0;
 try{const adapter=new ProducerUploadAdapter(p,{nextAction:()=>{throw Error('HANDOFF_LOCK_BUSY');},callTool:()=>native++});await assert.rejects(adapter.step(id),/HANDOFF_LOCK_BUSY/);assert.equal(p.activeOp(id,'complete'),null);assert.equal(native,0);}finally{p.close();}
});

test('old unresolved date inventory remains a hard registration block',async()=>{const p=await completeFixture(),s=fixture(),c={...config,activation_ts:((time-1000)/1000).toFixed(6),producer_scope_sha256:producerScopeHash(scope)};try{installFence(s.db,c,'synthetic unresolved date',['2026-11-01']);p.next(id);assert.throws(()=>registerCompletion(s.db,c,p,id,time),/adjudication/);assert.equal(s.db.prepare('SELECT count(*) n FROM producer_quarantined_dates').get().n,1);}finally{p.close();s.db.close();}});

test('completion uses the authenticated observation freshness despite allowed receipt clock skew',async()=>{
 const p=await completeFixture(),s=fixture(),c={...config,activation_ts:((time-1000)/1000).toFixed(6),producer_scope_sha256:producerScopeHash(scope)};
 try{
  installFence(s.db,c,'synthetic clock boundary',[]);
  // Parse an accepted native receipt with Slack 20s behind the host clock,
  // then dispatch 50s after its authenticated observed_at (still fresh).
  let clock=time+60001;p.now=()=>clock;
  const native={publisher_user_id:'U456',publisher_bot_id:'B456',workspace_host:'fixture-workspace.slack.com'},inspect=new ProducerInspect(p,native);
  const write=inspect.next(id),locate=inspect.next(id),command=write.arguments.message,source=((clock-20000)/1000).toFixed(6),receipt=((clock-19999)/1000).toFixed(6);
  const body=value=>({content:[{type:'text',text:JSON.stringify(value)}],isError:false});
  inspect.observeSource(id,{tool:locate.tool,arguments:locate.arguments,result:body({results:`# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: #control (ID: C123)\nFrom: User (ID: U123) \nTime: synthetic\nMessage_ts: ${source}\nPermalink: [link](https://${native.workspace_host}/archives/C123/p${source.replace('.','')})\nText: \n${command} ${scope.sender_attribution_text}\n\n---\n\n`,pagination_info:'End of results - No more pages available.\n'})});
  const thread=inspect.next(id),evidence={query_id:write.operation_id,request_id:id,report_date:'2026-11-01',bundle_sha256:hash,source_ts:source,...ledger(),observed_at:clock};
  const result=inspect.observeReceipt(id,{tool:thread.tool,arguments:thread.arguments,result:body({messages:`=== THREAD PARENT MESSAGE ===\nFrom: User <user@example.test> (U123)\nTime: synthetic\nMessage TS: ${source}\n${command}\n${scope.sender_attribution_text}\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Publisher <botuser-T123-B456@slack-bots.com> (U456)\nTime: synthetic\nMessage TS: ${receipt}\n!ai-report inspect-receipt ${JSON.stringify(evidence)}\n`,pagination_info:'There are no more messages in this thread.\n'})});
  assert.equal(result.type,'state');clock+=50000;
  assert.equal(p.next(id).next_action,'complete');
  assert.doesNotThrow(()=>registerCompletion(s.db,c,p,id,p.now()));
 }finally{p.close();s.db.close();}
});
