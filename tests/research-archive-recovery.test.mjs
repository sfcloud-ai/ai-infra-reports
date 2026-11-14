// Synthetic authority tests only: no provider calls, new tickets, or file uploads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {installFence} from '../scripts/producer-admission-fence.mjs';
import {installSubmission} from '../scripts/slack-submission.mjs';
import {installResearchArchive,readResearchArchive,storeResearchArchive} from '../scripts/research-archive.mjs';
import {installResearchControl,executeResearchControl,assertResearchControl} from '../scripts/research-control.mjs';
import {queueResearchControl,advanceResearchControl,researchControlHealth} from '../scripts/research-control-inbox.mjs';
import {digest} from '../scripts/archive.mjs';
import {REPOSITORY_INPUT_PATHS} from '../scripts/repository-research-inputs.mjs';
import {SCOPE,DAY} from './helpers/cloud-sender-fixture.mjs';
const now=1793491210000,id='morning-20261101-r1',file='FORIGINAL';
const {transport_profile,notification_destination,...identity}=SCOPE;
const fence={generation:randomUUID(),activation_ts:'1793491200.000000',producer_scope_sha256:'b'.repeat(64),installation:{journal_device:'1',journal_inode:'2',lock_device:'1',lock_inode:'3'}};
const config={...identity,durable_intake:{not_before:'1793462400.000000'},producer_fence:fence,scheduled_delivery:{activation_date:DAY,executable:'/usr/bin/python3',args:[]},slack_submission:{activation_ts:fence.activation_ts,first_report_date:DAY,generation:randomUUID()},research_archive:{activation_ts:fence.activation_ts,first_report_date:DAY,generation:randomUUID()},research_control:{activation_ts:fence.activation_ts,first_report_date:DAY,generation:randomUUID(),protocol:'repository_inputs_v1'}};
const plan=Buffer.from(JSON.stringify({schema_version:'research_plan_v3',request_id:id,report_date:DAY,prompt_commit_sha:'a'.repeat(40),reports_commit_sha:'b'.repeat(40),files:Object.fromEntries(REPOSITORY_INPUT_PATHS.map(p=>[p,digest(Buffer.from(p))])),model_stages:['editor','review'],limits:{max_attempts_per_source:2,max_attempts_per_model:1,operation_timeout_seconds:180,total_budget_seconds:3600}}));
function envelope(data=Buffer.from('verified source body\n'),previous_sha256=null){return Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:randomUUID(),request_id:id,report_date:DAY,previous_sha256,files:[{path:'sources/body.txt',sha256:digest(data),content_base64:data.toString('base64')}]}));}
function fixture(t,bytes=envelope()){
 const state=new HandoffState(':memory:',handoffScope(config)),db=state.db; t.after(()=>state.close());
 installFence(db,fence,'synthetic',[]);installSubmission(db,config,'synthetic');installResearchArchive(db,config,'synthetic');installResearchControl(db,config,'synthetic');
 const owner=randomUUID();let run=null;
 const command=(action,args={},override={})=>({schema_version:'research_control_v2',command_id:randomUUID(),request_id:id,action,owner_id:owner,epoch:run?.epoch??0,expected_revision:run?.revision??0,args,...override});
 const execute=(c,clock=now)=>{const result=executeResearchControl(db,config,Buffer.from(JSON.stringify(c)),clock);if(result.run)run=result.run;return result;};
 assert.equal(execute(command('claim',{plan_base64:plan.toString('base64')})).status,'claimed');
 assert.equal(execute(command('inputs')).status,'committed');
 const hash=digest(bytes);
 const native=(step,file_id)=>{const input={archive_sha256:hash,permit_id:null,step,file_id,source_ts:null,bytes:bytes.length,sha256:hash};return {operation_id:randomUUID(),kind:'native',key:'archive:'+hash+':'+step,input_sha256:digest(Buffer.from(JSON.stringify(input))),input,max_seconds:0};};
 const ticket=native('ticket',null);assert.equal(execute(command('reserve',{operations:[ticket]})).status,'committed');
 assert.equal(execute(command('settle',{operation_id:ticket.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:null,file_sha256:null,native_result:{file_id:file,source_ts:null,sha256:hash,bytes:bytes.length}})).status,'committed');
 const post=native('post',file);assert.equal(execute(command('reserve',{operations:[post]})).status,'committed');
 const original=db.prepare('SELECT * FROM research_control_ops WHERE operation_id=?').get(post.operation_id);
 return {db,bytes,hash,post,original,native,command,execute,get run(){return run;},owner};
}
function begin(f,overrides={}){
 const c=f.command('archive_recovery_begin',{operation_id:f.post.operation_id,archive_sha256:f.hash,file_id:file,total_bytes:f.bytes.length,reason:'original_post_unknown',...overrides});
 const result=f.execute(c);assert.equal(result.status,'committed',JSON.stringify(result));assert.equal(result.recovery.recovery_id,c.command_id);return c.command_id;
}
function chunk(f,recovery_id,offset,bytes=f.bytes.subarray(offset,offset+1024)){
 return f.execute(f.command('archive_recovery_chunk',{recovery_id,offset,content_base64:bytes.toString('base64'),chunk_sha256:digest(bytes)}));
}
function allChunks(f,r){for(let offset=0;offset<f.bytes.length;offset+=1024)assert.equal(chunk(f,r,offset).status,'committed');}
function commit(f,recovery_id,queued=true){
 const c=f.command('archive_recovery_commit',{recovery_id});
 if(queued){const bytes=Buffer.from(JSON.stringify(c));const serial=f.db.prepare('SELECT count(*) n FROM research_control_events').get().n;queueResearchControl(f.db,{source_ts:'1793491205.'+String(serial).padStart(6,'0'),command_id:c.command_id,hash:digest(bytes),bytes});}
 return {command:c,result:f.execute(c)};
}
function status(f,recovery_id){return f.execute(f.command('archive_recovery_status',{recovery_id},{owner_id:null,epoch:0,expected_revision:0}));}
function originalUnchanged(f){assert.deepEqual(f.db.prepare('SELECT * FROM research_control_ops WHERE operation_id=?').get(f.post.operation_id),f.original);}

test('recovery stores original bytes with explicit provenance without acknowledging or replaying the original POST',t=>{
 const f=fixture(t,envelope(Buffer.alloc(2400,65))),before=f.run,r=begin(f);allChunks(f,r);
 const {result,command}=commit(f,r);assert.equal(result.status,'committed',JSON.stringify(result));
 assert.equal(result.recovery.status,'stored');assert.equal(result.recovery.transport,'authenticated_control_chunks_v1');assert.equal(result.recovery.original_post_outcome,'unknown');
 const stored=f.db.prepare('SELECT * FROM research_archives WHERE hash=?').get(f.hash);assert(stored);assert.deepEqual(Buffer.from(stored.bytes),f.bytes);assert.equal(stored.file_id,file);
 assert.equal(f.db.prepare('SELECT hash FROM research_archive_heads WHERE report_date=?').get(DAY).hash,f.hash);
 originalUnchanged(f);assert.equal(f.run.charged_seconds,before.charged_seconds);assert.equal(f.run.plan_hash,before.plan_hash);assert.equal(f.run.epoch,before.epoch);assert.equal(f.run.permit,null);
 assert.equal(f.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,2,'no ticket, POST, completion or submit intent created');
 const again=f.execute(command);assert.equal(again.replayed,true);assert.equal(again.dispatch_granted,false);assert.equal(f.db.prepare('SELECT count(*) n FROM research_archives').get().n,1);originalUnchanged(f);
 const query=readResearchArchive(f.db,id,{query_id:randomUUID(),action:'receipt',hash:f.hash,offset:0});assert.equal(query.status,'stored');
 const follow=readResearchArchive(f.db,id,{query_id:randomUUID(),action:'file',hash:digest(Buffer.alloc(2400,65)),offset:0});assert.equal(follow.chunk_sha256,digest(Buffer.alloc(2048,65)));
 const complete=f.execute(f.command('reserve',{operations:[f.native('complete',file)]}));assert.equal(complete.status,'rejected');originalUnchanged(f);
});
test('chunk status and duplicate exact chunks recover lost acknowledgements but conflicting offsets are rejected',t=>{
 const f=fixture(t,envelope(Buffer.alloc(1600,66))),r=begin(f);
 assert.equal(chunk(f,r,0).status,'committed');assert.equal(chunk(f,r,0).status,'committed');
 assert.equal(chunk(f,r,0,Buffer.alloc(1024,67)).status,'rejected');
 assert.equal(status(f,r).status,'observed');
 const {result}=commit(f,r);assert.equal(result.status,'rejected');assert.equal(f.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);
 for(let offset=1024;offset<f.bytes.length;offset+=1024)assert.equal(chunk(f,r,offset).status,'committed');
 assert.equal(commit(f,r).result.recovery.status,'stored');originalUnchanged(f);
});
test('recovery rejects non-original identities and oversized archives',t=>{
 const f=fixture(t);
 for(const bad of [{operation_id:randomUUID()},{archive_sha256:'d'.repeat(64)},{file_id:'FOTHER'},{total_bytes:f.bytes.length+1},{total_bytes:65537},{reason:'timeout_proves_unsent'}]){
  const result=f.execute(f.command('archive_recovery_begin',{operation_id:f.post.operation_id,archive_sha256:f.hash,file_id:file,total_bytes:f.bytes.length,reason:'original_post_unknown',...bad}));assert.equal(result.status,'rejected',JSON.stringify(bad));
 }
 originalUnchanged(f);
});
test('recovery mutations remain fenced by current owner, revision and lease',t=>{
 const f=fixture(t),r=begin(f),args={recovery_id:r,offset:0,content_base64:f.bytes.toString('base64'),chunk_sha256:f.hash};
 for(const override of [{owner_id:randomUUID()},{epoch:f.run.epoch+1},{expected_revision:f.run.revision-1}])assert.equal(f.execute(f.command('archive_recovery_chunk',args,override)).status,'rejected');
 assert.equal(f.execute(f.command('archive_recovery_chunk',args),f.run.lease_until+1).status,'rejected');originalUnchanged(f);
});
test('recovery checks chunk length alignment, encoded bytes, and whole archive hash before atomic storage',t=>{
 const f=fixture(t,envelope(Buffer.alloc(1400,68))),r=begin(f);
 assert.equal(chunk(f,r,1).status,'rejected');assert.equal(chunk(f,r,0,Buffer.from('short')).status,'rejected');
 assert.equal(f.execute(f.command('archive_recovery_chunk',{recovery_id:r,offset:0,content_base64:'!!!!',chunk_sha256:'e'.repeat(64)})).status,'rejected');
 assert.equal(f.execute(f.command('archive_recovery_chunk',{recovery_id:r,offset:0,content_base64:f.bytes.subarray(0,1024).toString('base64'),chunk_sha256:'e'.repeat(64)})).status,'rejected');
 const wrong=Buffer.from(f.bytes.subarray(0,1024));wrong[0]^=1;assert.equal(chunk(f,r,0,wrong).status,'committed');
 for(let offset=1024;offset<f.bytes.length;offset+=1024)assert.equal(chunk(f,r,offset).status,'committed');
 assert.equal(commit(f,r).result.status,'rejected');assert.equal(f.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);originalUnchanged(f);
});
test('recovery commit requires an authenticated queued source and preserves stale predecessor rejection',t=>{
 const f=fixture(t),r=begin(f);allChunks(f,r);
 assert.equal(commit(f,r,false).result.status,'rejected');
 const other=envelope(Buffer.from('intervening checkpoint'));
 storeResearchArchive(f.db,{request_id:id,hash:digest(other),source_ts:'1793491203.000001',file_id:'FOTHER'},other);
 assert.equal(commit(f,r).result.status,'rejected');assert.equal(f.db.prepare('SELECT hash FROM research_archive_heads WHERE report_date=?').get(DAY).hash,digest(other));assert.equal(f.db.prepare('SELECT count(*) n FROM research_archives WHERE hash=?').get(f.hash).n,0);originalUnchanged(f);
});
test('explicitly unknown original POST stays unknown after recovery',t=>{
 const f=fixture(t);assert.equal(f.execute(f.command('settle',{operation_id:f.post.operation_id,outcome:'unknown',elapsed_seconds:null,archive_sha256:null,file_sha256:null,native_result:null})).status,'committed');
 f.original=f.db.prepare('SELECT * FROM research_control_ops WHERE operation_id=?').get(f.post.operation_id);
 const r=begin(f);allChunks(f,r);assert.equal(commit(f,r).result.recovery.status,'stored');originalUnchanged(f);
});
test('begin command replay is readback only and original POST cannot be settled after compensation starts',t=>{
 const f=fixture(t),c=f.command('archive_recovery_begin',{operation_id:f.post.operation_id,archive_sha256:f.hash,file_id:file,total_bytes:f.bytes.length,reason:'original_post_unknown'});
 assert.equal(f.execute(c).status,'committed');const replay=f.execute(c);assert.equal(replay.replayed,true);assert.equal(replay.dispatch_granted,false);
 assert.equal(f.execute(f.command('archive_recovery_begin',c.args)).status,'rejected');
 const result=f.execute(f.command('settle',{operation_id:f.post.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:null,file_sha256:null,native_result:{file_id:file,source_ts:null,sha256:f.hash,bytes:f.bytes.length}}));assert.equal(result.code,'archive_recovery_preserves_original_unknown');originalUnchanged(f);
});
test('recovery resumes verified chunks after valid lease takeover without accepting the old owner',t=>{
 const f=fixture(t,envelope(Buffer.alloc(1400,69))),r=begin(f);assert.equal(chunk(f,r,0).status,'committed');
 const next=now+16*60000,newOwner=randomUUID();const takeover=f.command('claim',{plan_base64:plan.toString('base64')},{owner_id:newOwner});assert.equal(f.execute(takeover,next).status,'claimed');
 const old=f.command('archive_recovery_chunk',{recovery_id:r,offset:1024,content_base64:f.bytes.subarray(1024,2048).toString('base64'),chunk_sha256:digest(f.bytes.subarray(1024,2048))});assert.equal(f.execute(old,next).status,'rejected');
 const observed=status(f,r);assert.deepEqual(observed.recovery.received_offsets,[0]);
 for(let offset=1024;offset<f.bytes.length;offset+=1024){const bytes=f.bytes.subarray(offset,offset+1024);const c=f.command('archive_recovery_chunk',{recovery_id:r,offset,content_base64:bytes.toString('base64'),chunk_sha256:digest(bytes)},{owner_id:newOwner});assert.equal(f.execute(c,next).status,'committed');}
 const c=f.command('archive_recovery_commit',{recovery_id:r},{owner_id:newOwner}),bytes=Buffer.from(JSON.stringify(c));queueResearchControl(f.db,{source_ts:'1793492201.000001',command_id:c.command_id,hash:digest(bytes),bytes});assert.equal(f.execute(c,next).recovery.status,'stored');originalUnchanged(f);
});
test('commit archive bytes and recovery receipt roll back together after interrupted transaction',t=>{
 const f=fixture(t),r=begin(f);allChunks(f,r);
 const c=f.command('archive_recovery_commit',{recovery_id:r}),bytes=Buffer.from(JSON.stringify(c));queueResearchControl(f.db,{source_ts:'1793491205.000001',command_id:c.command_id,hash:digest(bytes),bytes});
 assert.throws(()=>executeResearchControl(f.db,config,bytes,now,{onResult:()=>{throw Error('synthetic crash before commit');}}),/synthetic crash/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM research_control_commands WHERE command_id=?').get(c.command_id).n,0);assert.equal(status(f,r).recovery.status,'receiving');
 assert.equal(f.execute(c).recovery.status,'stored');originalUnchanged(f);
});
test('recovery rejects structured malformed begin identities as durable rejections rather than throwing',t=>{
 const f=fixture(t),valid={operation_id:f.post.operation_id,archive_sha256:f.hash,file_id:file,total_bytes:f.bytes.length,reason:'original_post_unknown'};
 for(const field of ['operation_id','archive_sha256','file_id'])for(const value of [null,{},[],123,true]){
  let result;assert.doesNotThrow(()=>{result=f.execute(f.command('archive_recovery_begin',{...valid,[field]:value}));},field+':'+JSON.stringify(value));
  assert.equal(result.status,'rejected');assert.equal(result.code,'archive_recovery_fields');
 }
 originalUnchanged(f);assert.equal(f.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);
});
test('begin fences original POST resume even when its dispatch is otherwise proven unstarted',t=>{
 const f=fixture(t);
 const row=f.db.prepare("SELECT bytes,result FROM research_control_commands WHERE request_id=? AND json_extract(bytes,'$.action')='reserve' AND json_extract(result,'$.operations[0].operation_id')=?").get(id,f.post.operation_id);
 const c=JSON.parse(Buffer.from(row.bytes));queueResearchControl(f.db,{source_ts:'1793491204.000001',command_id:c.command_id,hash:digest(Buffer.from(row.bytes)),bytes:Buffer.from(row.bytes)});
 f.db.prepare("UPDATE research_control_events SET phase='ready',reply_text=? WHERE command_id=?").run('!ai-research control-receipt '+row.result,c.command_id);
 const proof=f.execute(f.command('resume',{operation_id:f.post.operation_id}));assert.equal(proof.status,'committed');assert.equal(proof.dispatch_granted,true,'fixture must be resumable before recovery');
 begin(f);
 const rejected=f.execute(f.command('resume',{operation_id:f.post.operation_id}));assert.equal(rejected.status,'rejected');assert.equal(rejected.code,'archive_recovery_preserves_original_unknown');assert.equal(rejected.dispatch_granted,false);originalUnchanged(f);
});

test('recovery fences a delayed ready original POST grant before the inbox sends it',async t=>{
 const f=fixture(t);
 const row=f.db.prepare("SELECT bytes,result FROM research_control_commands WHERE request_id=? AND json_extract(bytes,'$.action')='reserve' AND json_extract(result,'$.operations[0].operation_id')=?").get(id,f.post.operation_id);
 const c=JSON.parse(Buffer.from(row.bytes));queueResearchControl(f.db,{source_ts:'1793491204.000002',command_id:c.command_id,hash:digest(Buffer.from(row.bytes)),bytes:Buffer.from(row.bytes)});
 f.db.prepare("UPDATE research_control_events SET phase='ready',reply_text=? WHERE command_id=?").run('!ai-research control-receipt '+row.result,c.command_id);
 begin(f);let sent;
 await advanceResearchControl({db:f.db},config,{controlReceipt:async(source,text)=>{sent=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793491206.000001';}},now);
 assert(sent,'original ready receipt must be observed');assert.equal(sent.dispatch_granted,false);assert.equal(sent.grant_expired,true);originalUnchanged(f);
});
test('read-only recovery status cannot be requested as a mutation receipt',t=>{
 const f=fixture(t),r=begin(f),c=f.command('archive_recovery_status',{recovery_id:r},{owner_id:null,epoch:0,expected_revision:0});
 assert.equal(f.execute(c).status,'observed');
 const result=f.execute(f.command('receipt',{command_id:c.command_id},{owner_id:null,epoch:0,expected_revision:0}));assert.equal(result.status,'rejected');assert.equal(result.code,'receipt_requires_mutation');originalUnchanged(f);
});

test('nonlayered repository authority advertises its working archive recovery capability',t=>{
 const f=fixture(t);
 const result=f.execute(f.command('status',{offset:0},{owner_id:null,epoch:0,expected_revision:0}));
 assert.equal(result.capabilities.archive_recovery,'authenticated_control_chunks_v1');
 const r=begin(f);allChunks(f,r);assert.equal(commit(f,r).result.recovery.status,'stored');
});
for(const phase of ['sending','unknown'])test('committed compensation makes '+phase+' dispatch a visible nonblocking warning only after exact storage',t=>{
 const f=fixture(t);
 const row=f.db.prepare("SELECT bytes,result FROM research_control_commands WHERE request_id=? AND json_extract(bytes,'$.action')='reserve' AND json_extract(result,'$.operations[0].operation_id')=?").get(id,f.post.operation_id);
 const c=JSON.parse(Buffer.from(row.bytes));queueResearchControl(f.db,{source_ts:'1793491204.000003',command_id:c.command_id,hash:digest(Buffer.from(row.bytes)),bytes:Buffer.from(row.bytes)});
 f.db.prepare("UPDATE research_control_events SET phase=?,reply_text=? WHERE command_id=?").run(phase,'!ai-research control-receipt '+row.result,c.command_id);
 const event=f.db.prepare('SELECT * FROM research_control_events WHERE command_id=?').get(c.command_id);
 assert.equal(researchControlHealth(f.db).blocked.length,1);
 const r=begin(f);allChunks(f,r);assert.equal(researchControlHealth(f.db).blocked.length,1);
 assert.equal(commit(f,r).result.recovery.status,'stored');
 const health=researchControlHealth(f.db);assert.equal(health.blocked.length,0);assert.equal(health.warnings.length,1);assert.equal(health.warnings[0].recoveries[0].original_post_outcome,'unknown');
 originalUnchanged(f);assert.deepEqual(f.db.prepare('SELECT * FROM research_control_events WHERE command_id=?').get(c.command_id),event);
 f.db.prepare('UPDATE research_archives SET bytes=? WHERE hash=?').run(Buffer.from('corrupt'),f.hash);
 assert.equal(researchControlHealth(f.db).blocked.length,1);assert.equal(researchControlHealth(f.db).warnings.length,0);
});

import {ARCHIVE_RECOVERY_SCHEMA,ARCHIVE_RECOVERY_VERSION} from '../scripts/research-archive-recovery.mjs';
test('explicit begin installs permanent exact marker; receiving and stored preserve it',t=>{
 const f=fixture(t);assert.equal(ARCHIVE_RECOVERY_VERSION,1);
 const marker=()=>f.db.prepare("SELECT sql FROM sqlite_master WHERE name='research_control_archive_recovery'").get();
 assert.equal(marker(),undefined);assert.equal(assertResearchControl(f.db,config),true);
 const r=begin(f);assert.equal(marker().sql,ARCHIVE_RECOVERY_SCHEMA);
 assert.deepEqual({...f.db.prepare('SELECT * FROM research_control_archive_recovery').get()},{id:1,version:1});assert.equal(assertResearchControl(f.db,config),true);
 allChunks(f,r);assert.equal(commit(f,r).result.recovery.status,'stored');assert.equal(marker().sql,ARCHIVE_RECOVERY_SCHEMA);assert.equal(assertResearchControl(f.db,config),true);
});
test('rejected and transaction-rolled-back begin never install marker',t=>{
 const f=fixture(t),marker=()=>f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_control_archive_recovery'").get();
 const args={operation_id:f.post.operation_id,archive_sha256:f.hash,file_id:file,total_bytes:f.bytes.length,reason:'original_post_unknown'};
 assert.equal(f.execute(f.command('archive_recovery_begin',{...args,file_id:'FWRONG'})).status,'rejected');assert.equal(marker(),undefined);
 const c=f.command('archive_recovery_begin',args);
 assert.throws(()=>executeResearchControl(f.db,config,Buffer.from(JSON.stringify(c)),now,{onResult:()=>{throw Error('rollback begin');}}),/rollback begin/);
 assert.equal(marker(),undefined);assert.equal(f.execute(c).status,'committed');assert(marker());
});
