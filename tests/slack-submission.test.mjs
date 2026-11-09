// Synthetic native Slack fixtures. No production uploads or deliveries.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {PublisherInbox} from '../scripts/publisher-inbox.mjs';
import {installFence,registerCompletion} from '../scripts/producer-admission-fence.mjs';
import {installSubmission,assertSubmission,acceptSubmission,advanceSubmission,submissionStatus,SUBMISSION_SCHEMA} from '../scripts/slack-submission.mjs';
import {inspectPublisherDay} from '../scripts/producer-inspect.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {handoffTick,validateConfig} from '../scripts/run-handoff.mjs';
import {replyScheduledStatus} from '../scripts/scheduled-delivery-bridge.mjs';
import {FILES,SCOPE,DAY} from './helpers/cloud-sender-fixture.mjs';

const id='morning-20261101-r1',bytes=await encodeBundle(FILES,id,'a'.repeat(40),'b'.repeat(40)),hash=digest(bytes);
const now=1793491210000,ts='1793491201.000001',submitTs='1793491202.000001';
const fence={generation:'a1111111-1111-4111-8111-111111111111',activation_ts:'1793491200.000000',producer_scope_sha256:'b'.repeat(64),installation:{journal_device:'1',journal_inode:'2',lock_device:'1',lock_inode:'3'}};
const {transport_profile,notification_destination,...identity}=SCOPE;
const config={...identity,ready_for_review:false,producer_app_id:1,merger_app_id:2,slack_token_file:'/private/token',producer_key_file:'/private/key',state_dir:'/private/state',durable_intake:{not_before:'1793462400.000000'},producer_fence:fence,scheduled_delivery:{activation_date:'2026-11-01',executable:'/usr/bin/python3',args:[]},slack_submission:{activation_ts:fence.activation_ts,first_report_date:DAY,generation:'b1111111-1111-4111-8111-111111111111'}};
function message(text,source,file){return {type:'message',user:SCOPE.sender_user_id,app_id:SCOPE.sender_user_app_id,ts:source,text:text+' '+SCOPE.sender_attribution_text,...(file?{files:[{id:file}]}:{}),blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text}]}]},{type:'context',elements:[{type:'mrkdwn',text:SCOPE.sender_attribution_text,verbatim:false}]}]};}
const stage=message(`!ai-report stage ${id} ${hash}`,ts,'FFIRST'),submit=message(`!ai-report submit ${id} ${hash} ${ts}`,submitTs);
const remote=async()=>({complete:true,observed_at:now,read_context:{scheduler_scope_sha256:'c'.repeat(64)},scheduler:null,scheduler_day_claim:null});
function setup(filename=':memory:',blocked=[]){
 const state=new HandoffState(filename,handoffScope(config));installFence(state.db,fence,'synthetic cutover',blocked);installSubmission(state.db,config,'synthetic activation');return state;
}
const slackFor=(messages=[stage,submit],download=async()=>bytes)=>({history:async()=>[],historyPage:async({from,to})=>({messages:messages.filter(m=>m.ts>=from&&m.ts<=to),next_cursor:null}),exactPublish:async source=>messages.find(m=>m.ts===source),download});
async function scan(state,messages=[stage,submit]){const inbox=new PublisherInbox(state,config);await inbox.scan(slackFor(messages),Math.ceil(Math.max(...messages.map(m=>Number(m.ts)))*1000));return inbox;}
async function stageOnly(state){await scan(state,[stage]);assert.equal(await advanceSubmission(state,config,slackFor([stage]),remote,now),undefined);}

test('staging is opt-in, bound to original scope/fence, and disables local completion without erasing it',()=>{
 const state=setup();try{
  const {notification_destination,...valid}=config;assert.equal(validateConfig(valid),valid);
  assert.equal(assertSubmission(state.db,config),true);
  const {slack_submission,...old}=config;assert.deepEqual(handoffScope(old),handoffScope(config));
  assert.throws(()=>assertSubmission(state.db,old),/cannot be removed/);
  assert.throws(()=>assertSubmission(state.db,{...config,slack_submission:{...config.slack_submission,generation:'c1111111-1111-4111-8111-111111111111'}}),/binding/);
  assert.throws(()=>installSubmission(state.db,config,'again'),/never reinstall/);
  assert.throws(()=>registerCompletion(state.db,fence,null,id,now),/disabled/);
 }finally{state.close();}
});
test('native file and explicit submit require exact immutable identity, visible content, and activation',()=>{
 const range={from:fence.activation_ts,to:(now/1000).toFixed(6)};
 assert.equal(acceptSubmission(stage,config,now,range).kind,'stage');assert.equal(acceptSubmission(submit,config,now,range).target_ts,ts);
 for(const original of [stage,submit])for(const patch of [{edited:{}},{user:'UOTHER'},{app_id:'AOTHER'},{thread_ts:'1793491200.000001'},{blocks:[]},{text:original.text+'extra'}])assert.throws(()=>acceptSubmission({...original,...patch},config,now,range));
 assert.throws(()=>acceptSubmission({...stage,files:[]},config,now,range));
 assert.throws(()=>acceptSubmission({...submit,files:[{id:'FBAD'}]},config,now,range));
 assert.throws(()=>acceptSubmission(stage,{...config,slack_submission:{...config.slack_submission,first_report_date:'2026-11-02'}},now,range));
});
test('staged original survives restart; submit admits once atomically, retaining source and bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'slack-stage-')),file=join(dir,'handoff.sqlite');let state=setup(file);
 try{
  await stageOnly(state);assert.equal(state.pending().length,0);assert.equal(submissionStatus(state.db,id).bundle.phase,'staged');
  state.close();state=new HandoffState(file,handoffScope(config));await scan(state);
  assert.equal(await advanceSubmission(state,config,slackFor(),remote,now),undefined);
  const job=state.get(id);assert.equal(job.source_ts,ts);assert.deepEqual(job.bytes,bytes);assert.equal(job.detail.intake_file_id,'FFIRST');assert.equal(job.detail.intake_transport,'slack_staged_file_v1');
  assert.equal(submissionStatus(state.db,id).bundle.submit_ts,submitTs);
  const duplicate=message(submit.blocks[0].elements[0].elements[0].text,'1793491203.000001');await scan(state,[duplicate]);
  assert.equal(await advanceSubmission(state,config,slackFor([duplicate]),()=>assert.fail('already admitted'),now),undefined);
  assert.equal(state.pending().length,1);assert.equal(submissionStatus(state.db,id).bundle.submit_ts,submitTs);
 }finally{state.close();await rm(dir,{recursive:true,force:true});}
});
test('commit failure rolls back both job and staged phase; retry reuses original bytes',async()=>{
 const state=setup();try{
  await stageOnly(state);await scan(state);
  state.db.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE ON slack_staged_bundles BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert((await advanceSubmission(state,config,slackFor(),remote,now)).code);assert.equal(state.pending().length,0);assert.equal(submissionStatus(state.db,id).bundle.phase,'staged');
  state.db.exec('DROP TRIGGER synthetic_failure');
  await advanceSubmission(state,config,slackFor(),async()=>({...await remote(),observed_at:now+10000}),now+10000);
  assert.equal(state.pending().length,1);
 }finally{state.close();}
});
test('duplicate staged files preserve first identity; conflicting bytes never replace it',async()=>{
 const state=setup();try{
  await stageOnly(state);
  const duplicate=message(stage.blocks[0].elements[0].elements[0].text,'1793491203.000001','FSECOND');await scan(state,[duplicate]);
  assert.equal(await advanceSubmission(state,config,slackFor([duplicate]),remote,now),undefined);
  assert.equal(submissionStatus(state.db,id).bundle.file_id,'FFIRST');
  const otherBytes=await encodeBundle(FILES,id,'c'.repeat(40),'b'.repeat(40));
  const conflict=message(`!ai-report stage ${id} ${digest(otherBytes)}`,'1793491204.000001','FTHIRD');await scan(state,[conflict]);
  assert((await advanceSubmission(state,config,slackFor([conflict],async()=>otherBytes),remote,now)).code);
  assert.deepEqual(Buffer.from(state.db.prepare('SELECT bytes FROM slack_staged_bundles').get().bytes),bytes);assert.equal(state.pending().length,0);
 }finally{state.close();}
});
test('old quarantine, original jobs, unresolved inbox and scheduler claims block staging',async()=>{
 for(const mode of ['quarantine','jobs','inbox','scheduler','incomplete-scan']){
  const state=setup(':memory:',mode==='quarantine'?[DAY]:[]);try{
   await scan(state,[stage]);
   if(mode==='jobs')state.admit({request_id:id,hash,source_ts:'1793491199.000001'},bytes);
   if(mode==='inbox')state.db.prepare('INSERT INTO publisher_inbox(source_ts,request_id,file_id,hash) VALUES(?,?,?,?)').run('1793491199.000001',id,'FOLD',hash);
   if(mode==='incomplete-scan')state.db.prepare('UPDATE publisher_intake_scan SET watermark=?').run('1793491200.000000');
   const query=mode==='scheduler'?async()=>({...await remote(),scheduler_day_claim:{request_id:'other'}}):remote;
   assert((await advanceSubmission(state,config,slackFor([stage]),query,now)).code,mode);
   assert.equal(submissionStatus(state.db,id).bundle,null,mode);
  }finally{state.close();}
 }
});
test('stage is a date reservation for original inspect; wrong submit source and changed staged bytes block',async()=>{
 const state=setup();try{
  await stageOnly(state);
  await assert.rejects(inspectPublisherDay(state,config,{kind:'inspect',query_id:'c1111111-1111-4111-8111-111111111111',request_id:id,report_date:DAY,bundle_sha256:hash},ts),/reserved/);
  const wrong=message(`!ai-report submit ${id} ${hash} 1793491200.000001`,submitTs);await scan(state,[wrong]);
  assert((await advanceSubmission(state,config,slackFor([wrong]),remote,now)).code);assert.equal(state.pending().length,0);
 }finally{state.close();}
});
test('paginated discovery and file failures retain events; status reports staging without publication',async()=>{
 const state=setup();try{
  const inbox=new PublisherInbox(state,config);
  await inbox.scan({historyPage:async()=>({messages:[submit],next_cursor:'older'})},now);
  assert((await advanceSubmission(state,config,slackFor(),remote,now)).code);
  await inbox.scan({historyPage:async()=>({messages:[stage],next_cursor:null})},now);
  let downloads=0;await advanceSubmission(state,config,slackFor([stage],async()=>{downloads++;throw Error('private URL');}),remote,now);
  assert.equal(downloads,1);assert.equal(state.pending().length,0);
  let receipt;await replyScheduledStatus(state,config,{request_id:id,source_ts:'1793491205.000001',hash:'read'}, {controlReceipt:async(_ts,text)=>{receipt=text;return '1793491206.000001';}},async()=>({status:'not_found'}));
  assert.match(receipt,/staging_pending/);assert(!receipt.includes('private URL'));
 }finally{state.close();}
});
test('live tick stages before any proposal; explicit submission is still required after restart',async()=>{
 const state=setup();try{
  const result=await handoffTick(state,config,{...slackFor([stage]),history:async()=>[stage,submit]}, {now:()=>now,scheduleQuery:remote,propose:()=>assert.fail('staging cannot publish')});
  assert.equal(state.pending().length,0);assert.equal(submissionStatus(state.db,id).bundle.phase,'staged');assert.deepEqual(result.errors,[]);
 }finally{state.close();}
});
test('slow original file reads use current scheduler freshness instead of the tick start clock',async()=>{
 const state=setup();let elapsed=0;try{
  await scan(state,[stage]);
  const slack=slackFor([stage],async()=>{elapsed+=45000;return bytes;});
  const result=await advanceSubmission(state,config,slack,async()=>({...await remote(),observed_at:now+elapsed}),now,{monotonicNow:()=>elapsed});
  assert.equal(result,undefined);assert.equal(submissionStatus(state.db,id).bundle.phase,'staged');
 }finally{state.close();}
});
const python=process.platform==='win32'?'python':'python3';
function snapshot(file,settled){return spawnSync(python,['-B','-c',`from pathlib import Path; from deployment.publisher_cd import snapshot; print(snapshot(Path(${JSON.stringify(file)}), settled=${settled?'True':'False'}))`],{encoding:'utf8',timeout:10000});}
test('CD recognizes exact staging schema, fingerprints bytes and defers unfinished staging',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'slack-stage-cd-')),file=join(dir,'handoff.sqlite'),state=setup(file);try{
  new PublisherInbox(state,config);assert.equal(snapshot(file,true).status,0);
  const original=snapshot(file,false);await stageOnly(state);const staged=snapshot(file,false);
  assert.equal(staged.status,0,staged.stderr);assert.notEqual(staged.stdout,original.stdout);assert.notEqual(snapshot(file,true).status,0);
  state.db.exec('CREATE INDEX unexpected_stage_index ON slack_staged_bundles(hash)');assert.notEqual(snapshot(file,false).status,0);
 }finally{state.close();await rm(dir,{recursive:true,force:true});}
 const schema=spawnSync(python,['-B','-c','import json; from deployment.publisher_cd import SUBMISSION_SCHEMA; print(json.dumps(SUBMISSION_SCHEMA))'],{encoding:'utf8'});
 assert.equal(schema.status,0,schema.stderr);assert.deepEqual(JSON.parse(schema.stdout),SUBMISSION_SCHEMA);
});
