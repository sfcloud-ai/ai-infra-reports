// Synthetic receipts and local temporary journals only; no external writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,lstat,readFile,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {ProducerUploadState,ProducerUploadAdapter,producerTicket,producerScopeHash,RESTART_RECOVERY_DELAY_MS,RETRY_DELAY_MS} from '../scripts/producer-upload.mjs';
import {ProducerInspect} from '../scripts/producer-native-inspect.mjs';
import {verifyProducerJournal} from '../scripts/producer-upload-journal.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {FILES,BASE,PROMPTS,ID,DAY,TARGET} from './helpers/cloud-sender-fixture.mjs';
process.umask(0o077);
const scope={team_id:'T123',channel_id:'C123',sender_user_id:'U123',sender_user_app_id:'A123',sender_attribution_text:'*Sent using* <@U789>',publisher_scope_sha256:'a'.repeat(64),scheduler_scope_sha256:'b'.repeat(64),scheduler_team_id:'T123',scheduler_channel_id:'D123'};
const native={publisher_user_id:'U456',publisher_bot_id:'B456',workspace_host:'fixture-workspace.slack.com'};
const bytes=await encodeBundle(FILES,ID,BASE,PROMPTS.commit),hash=digest(bytes),url='https://files.slack.com/upload/v1/SYNTHETIC-ORIGINAL',ticket={file_id:'FOLD',upload_url:url},safe=producerTicket(ticket);
const failure={curl_exit:6,http_status:0,num_connects:0,num_redirects:0,upload_bytes:0,response_bytes:0,header_bytes:0,time_namelookup:0,time_connect:0,time_appconnect:0,time_starttransfer:0,ssl_verify_result:0,response_sha256:null};
const success={...failure,curl_exit:0,http_status:200,num_connects:1,upload_bytes:bytes.length,time_connect:.01,time_appconnect:.02,time_starttransfer:.03};
const post=(metrics=failure,t=safe,adapter='producer_curl_direct_v1')=>({adapter,file_id:t.file_id,url_sha256:t.url_sha256,bundle_sha256:hash,metrics});
const empty=now=>({read_context:{publisher_scope_sha256:scope.publisher_scope_sha256,scheduler_scope_sha256:scope.scheduler_scope_sha256},observed_at:now,complete:true,publisher_day:[],publisher:null,scheduler_day_claim:null,scheduler:null});
const originalOps=s=>s.db.prepare('SELECT * FROM producer_ops ORDER BY name,attempt').all().map(o=>({...o}));
async function fixture(fn,{enabled=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'producer-restart-')),file=join(dir,'state.sqlite'),lock=join(dir,'runner.lock');let time=TARGET,s=new ProducerUploadState(file,scope,{now:()=>time});
 try{
  await writeFile(lock,'',{mode:0o600});await chmod(file,0o600);new ProducerInspect(s,native);await s.prepare(bytes);
  const a=await lstat(file,{bigint:true}),b=await lstat(lock,{bigint:true}),installation={journal_device:String(a.dev),journal_inode:String(a.ino),lock_device:String(b.dev),lock_inode:String(b.ino)};
  if(enabled)s.enableRestartRecovery('synthetic:approved-restart-policy',installation);
  const c={dir,file,lock,installation,now:()=>time,advance:n=>time+=n,stop:()=>{s.close();s=null;},reopen:()=>{s?.close();s=new ProducerUploadState(file,scope,{now:()=>time});return s;}};
  await fn(s,c);
 }finally{s?.close();await rm(dir,{recursive:true,force:true});}
}
function allocate(s,now,{confirmed=false}={}){s.observeDownstream(ID,empty(now));const a=s.next(ID);assert.equal(a.next_action,'ticket');if(confirmed)s.record(a,ticket);return a;}
function startup(s,c){return {operation_id:s.activeOp(ID,'ticket').operation_id,started_at:c.now(),inspect_attempt:s.db.prepare('SELECT COALESCE(MAX(attempt),0) n FROM producer_inspect_queries WHERE run_id=?').get(ID).n};}
// Model only ProducerInspect's authenticated, resolved receipt write. CLI tests
// separately exercise its actual formatted native parser end-to-end.
function fresh(s,c){const n=s.db.prepare('SELECT COALESCE(MAX(attempt),0)+1 n FROM producer_inspect_queries WHERE run_id=?').get(ID).n,id=randomUUID();s.db.prepare("INSERT INTO producer_inspect_queries VALUES(?,?,?,?,?,NULL,NULL,NULL,'resolved',?)").run(ID,n,id,c.now(),(c.now()/1000).toFixed(6),id);s.observeDownstream(ID,empty(c.now()),{inspectQueryId:id});return id;}
function rotate(s,c){const start=startup(s,c);fresh(s,c);return s.recoverAbandonedTicket(ID,start);}

test('explicit offline policy is immutable, native scoped and bound to installation; no migration on serve',()=>fixture(async(s,c)=>{
 const policy=s.restartPolicy();assert.equal(policy.scope_hash,producerScopeHash(scope));for(const [k,v] of Object.entries(c.installation))assert.equal(policy[k],v);
 assert.throws(()=>s.enableRestartRecovery('another',c.installation));
 for(const sql of ['UPDATE producer_restart_policy SET policy=policy','DELETE FROM producer_restart_policy'])assert.throws(()=>s.db.exec(sql),/Immutable/);
 const check=await verifyProducerJournal(c.file,scope,native);assert.deepEqual(check.restartPolicy,{...policy});await check();
}));

test('unknown ticket and confirmed lost ticket each retire without inventing a receipt or changing original bytes',async()=>{
 for(const confirmed of [false,true])await fixture(async(s,c)=>{
  const old=allocate(s,c.now(),{confirmed}),before=originalOps(s);c.advance(RESTART_RECOVERY_DELAY_MS);const start=startup(s,c);
  assert.equal(s.recoverAbandonedTicket(ID,start).next_action,'read_original_publisher_scheduler');fresh(s,c);
  const r=s.recoverAbandonedTicket(ID,start);assert.equal(r.type,'ticket_abandoned');assert.equal(r.restart_generation,1);assert.equal(r.restart_recovery_id,s.restartAudit(ID).recovery_id);assert.equal(r.recovery_id,null);assert.equal(r.file_id,null);assert.deepEqual(originalOps(s),before);assert.deepEqual(s.get(ID).bundle,bytes);assert.equal(s.get(ID).hash,hash);assert.equal(s.get(ID).date,DAY);
  assert.equal(s.next(ID).next_action,'read_original_publisher_scheduler');assert.equal(s.activeOp(ID,'ticket'),null);
  const audit=s.restartAudit(ID),e=JSON.parse(audit.original);assert.equal(e.abandoned_operation_id,old.operation_id);assert.equal(e.scope_sha256,producerScopeHash(scope));assert.deepEqual(e.operations,before);
  s.observeDownstream(ID,empty(c.now()));const successor=s.next(ID);assert.equal(successor.next_action,'ticket');assert.equal(successor.attempt,2);assert.notEqual(successor.operation_id,old.operation_id);
  assert.throws(()=>s.record(old,ticket),/Original operation/);assert.equal(s.activeOp(ID,'ticket').phase,'unknown');
  assert.throws(()=>s.db.prepare("UPDATE producer_ops SET phase='confirmed' WHERE operation_id=?").run(old.operation_id),/immutable/);
  assert.throws(()=>s.db.exec('DELETE FROM producer_ops'),/immutable/);
  for(const sql of ['DELETE FROM producer_restart_audit','UPDATE producer_restart_audit SET at=at','UPDATE producer_runs SET bundle=x\'00\''])assert.throws(()=>s.db.exec(sql),/Immutable|immutable/);
  assert(!JSON.stringify(originalOps(s)).includes(url));assert(!JSON.stringify(audit).includes(url));
 });
});

test('repeated crashes use monotonic generations and original ticket times impose durable cooldown without lifetime cap',()=>fixture(async(s,c)=>{
 allocate(s,c.now());
 for(let n=1;n<=10;n++){
  const start=startup(s,c);fresh(s,c);const waiting=s.recoverAbandonedTicket(ID,start);assert.equal(waiting.next_action,'wait_abandoned_ticket_recovery');assert.equal(waiting.next_attempt_at,c.now()+RESTART_RECOVERY_DELAY_MS);
  c.advance(RESTART_RECOVERY_DELAY_MS);fresh(s,c);const result=s.recoverAbandonedTicket(ID,start);assert.equal(result.restart_generation,n);
  s.observeDownstream(ID,empty(c.now()));assert.equal(s.next(ID).attempt,n+1);
  s=c.reopen();assert.equal(s.restartAudit(ID).generation,n);assert.equal(s.op(ID,'ticket').attempt,n+1);assert.equal(s.op(ID,'ticket').phase,'unknown');
 }
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM producer_restart_audit').get().n,10);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM producer_ops').get().n,11);
}));

test('existing authenticated receipt, same-millisecond old query, stale and consumed evidence do not authorize retirement',()=>fixture(async(s,c)=>{
 allocate(s,c.now());c.advance(RESTART_RECOVERY_DELAY_MS);fresh(s,c);const start=startup(s,c);
 assert.equal(s.recoverAbandonedTicket(ID,start).type,'read'); // Timestamp equal is insufficient: new query attempt required.
 fresh(s,c);s.save(s.get(ID),{...s.get(ID).detail,preflight_query_id:randomUUID()});assert.equal(s.recoverAbandonedTicket(ID,start).type,'read');
 fresh(s,c);s.save(s.get(ID),{...s.get(ID).detail,preflight_at:null});assert.equal(s.recoverAbandonedTicket(ID,start).type,'read');
 fresh(s,c);c.advance(60000);assert.equal(s.recoverAbandonedTicket(ID,start).type,'read');
 fresh(s,c);assert.equal(s.recoverAbandonedTicket(ID,start).type,'ticket_abandoned');assert.equal(s.recoverAbandonedTicket(ID,start),null);
}));

test('all historical direct proven POST failures may retire, never just the latest success-shaped receipt',async()=>{
 for(const bad of ['unknown','confirmed','proxy','malformed','binding'])await fixture(async(s,c)=>{
  allocate(s,c.now(),{confirmed:true});s.observeDownstream(ID,empty(c.now()));const p=s.next(ID);s.record(p,post());
  if(bad==='unknown'||bad==='confirmed')s.db.prepare('UPDATE producer_ops SET phase=? WHERE operation_id=?').run(bad,p.operation_id);
  if(bad==='proxy')s.db.prepare('UPDATE producer_ops SET result=? WHERE operation_id=?').run(JSON.stringify(post(failure,safe,'producer_curl_managed_proxy_v1')),p.operation_id);
  if(bad==='malformed')s.db.prepare('UPDATE producer_ops SET result=? WHERE operation_id=?').run(JSON.stringify(post({...failure,curl_exit:28})),p.operation_id);
  if(bad==='binding')s.db.prepare('UPDATE producer_ops SET result=? WHERE operation_id=?').run(JSON.stringify({...post(),url_sha256:'f'.repeat(64)}),p.operation_id);
  s.db.prepare("INSERT INTO producer_ops VALUES(?,'post',2,?,'not_executed',?,?)").run(ID,randomUUID(),c.now(),JSON.stringify(post()));
  c.advance(RESTART_RECOVERY_DELAY_MS);assert.equal(rotate(s,c),null);assert.equal(s.restartAudit(ID),null);
 });
 await fixture(async(s,c)=>{
  allocate(s,c.now(),{confirmed:true});s.observeDownstream(ID,empty(c.now()));s.record(s.next(ID),post());c.advance(RESTART_RECOVERY_DELAY_MS);
  const before=originalOps(s);assert.equal(rotate(s,c).type,'ticket_abandoned');assert.deepEqual(originalOps(s),before);
 });
});

test('any historical complete intent permanently prevents automatic rotation regardless of phase',async()=>{
 for(const phase of ['unknown','confirmed'])await fixture(async(s,c)=>{
  allocate(s,c.now(),{confirmed:true});s.observeDownstream(ID,empty(c.now()));s.record(s.next(ID),post(success));s.observeDownstream(ID,empty(c.now()));const a=s.next(ID);if(phase==='confirmed')s.record(a,{acknowledged:true});
  c.advance(RESTART_RECOVERY_DELAY_MS);assert.equal(rotate(s,c),null);assert.equal(s.restartAudit(ID),null);assert.equal(s.next(ID).next_action,'read_original_file_and_share');assert.equal(s.op(ID,'complete').attempt,1);
 });
});

test('late receipt from abandoned generation cannot change active successor, and a live-process unknown cannot self-rotate',()=>fixture(async(s,c)=>{
 let calls=0;const adapter=new ProducerUploadAdapter(s,{callTool:async()=>{calls++;throw Error('interrupted');}},{transport:'managed_proxy',restart:{started_at:c.now(),requireLock:async()=>{}}});
 s.observeDownstream(ID,empty(c.now()));await adapter.step(ID);c.advance(RESTART_RECOVERY_DELAY_MS);fresh(s,c);assert.equal((await adapter.step(ID)).next_action,'reconcile_original_operation');assert.equal(s.restartAudit(ID),null);assert.equal(calls,1);
 const original=s.activeOp(ID,'ticket'),restarted=new ProducerUploadAdapter(s,{callTool:async()=>assert.fail('No tool during retirement')},{transport:'managed_proxy',restart:{started_at:c.now(),requireLock:async()=>{}}});fresh(s,c);assert.equal((await restarted.step(ID)).type,'ticket_abandoned');
 assert.equal(s.op(ID,'ticket').operation_id,original.operation_id);assert.equal(s.op(ID,'ticket').phase,'unknown');assert.equal(s.op(ID,'ticket').result,null);
}));

test('explicit #76 audit and original operations stay immutable while its abandoned successor can rotate',()=>fixture(async(s,c)=>{
 allocate(s,c.now(),{confirmed:true});s.observeDownstream(ID,empty(c.now()));s.record(s.next(ID),post());s.observeDownstream(ID,empty(c.now()));s.authorizeTicketRecovery(ID,{authorization_reference:'synthetic:explicit',file_id:ticket.file_id,url_sha256:safe.url_sha256,bundle_sha256:hash});
 const explicit={...s.db.prepare('SELECT * FROM producer_recovery_audit').get()},original=originalOps(s);s.observeDownstream(ID,empty(c.now()));const successor=s.next(ID);assert.equal(successor.next_action,'ticket');c.advance(RESTART_RECOVERY_DELAY_MS);assert.equal(rotate(s,c).type,'ticket_abandoned');
 assert.deepEqual({...s.db.prepare('SELECT * FROM producer_recovery_audit').get()},explicit);assert.deepEqual(originalOps(s).filter(o=>!o.name.startsWith('recovery_')),original);assert.equal(s.op(ID,'recovery_ticket').phase,'unknown');
 s.observeDownstream(ID,empty(c.now()));const next=s.next(ID);assert.equal(next.attempt,2);assert.equal(s.activeName(ID,'ticket'),'recovery_ticket');assert.equal(s.get(ID).detail.recovery_id,explicit.recovery_id);assert.throws(()=>s.authorizeTicketRecovery(ID,{}));
}));

test('hard process deaths around every external intent/result retain fences or safe ticket retirement',async()=>{
 for(const phase of ['ticket_intent','ticket_result','post_intent','post_result_unknown','post_result_success','complete_intent','complete_result'])await fixture(async(s,c)=>{
  c.stop();const code=`import {ProducerUploadState} from './scripts/producer-upload.mjs';const s=new ProducerUploadState(${JSON.stringify(c.file)},${JSON.stringify(scope)},{now:()=>${TARGET}});const e=${JSON.stringify(empty(TARGET))};s.observeDownstream(${JSON.stringify(ID)},e);const t=s.next(${JSON.stringify(ID)});${phase!=='ticket_intent'?`s.record(t,${JSON.stringify(ticket)});`:''}${!phase.startsWith('ticket')?`s.observeDownstream(${JSON.stringify(ID)},e);const p=s.next(${JSON.stringify(ID)});`:''}${['post_result_unknown','post_result_success','complete_intent','complete_result'].includes(phase)?`s.record(p,${JSON.stringify(post(phase==='post_result_unknown'?{...failure,curl_exit:28}:success))});`:''}${phase.startsWith('complete')?`s.observeDownstream(${JSON.stringify(ID)},e);const a=s.next(${JSON.stringify(ID)});`:''}${phase==='complete_result'?`s.record(a,{acknowledged:true});`:''}process.kill(process.pid,'SIGKILL');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});assert.equal(child.signal,'SIGKILL',child.stderr);
  s=c.reopen();c.advance(RESTART_RECOVERY_DELAY_MS);const before=originalOps(s);const result=rotate(s,c);
  if(phase.startsWith('ticket'))assert.equal(result.type,'ticket_abandoned');else assert.equal(result,null);
  assert.deepEqual(originalOps(s),before);assert.equal(s.op(ID,'ticket').attempt,1);
  if(['post_intent','post_result_unknown'].includes(phase))assert.equal(s.next(ID).next_action,'reconcile_original_operation');
  if(phase.startsWith('complete'))assert.equal(s.next(ID).next_action,'read_original_file_and_share');
 });
});

test('crash after retirement before successor intent resumes one generation and still consumes new read',()=>fixture(async(s,c)=>{
 allocate(s,c.now());c.advance(RESTART_RECOVERY_DELAY_MS);assert.equal(rotate(s,c).type,'ticket_abandoned');const before=originalOps(s);s=c.reopen();
 const adapter=new ProducerUploadAdapter(s,{callTool:async()=>ticket},{transport:'managed_proxy',restart:{started_at:c.now(),requireLock:async()=>{}}});
 assert.equal((await adapter.step(ID)).next_action,'read_original_publisher_scheduler');assert.deepEqual(originalOps(s),before);assert.equal(s.restartAudit(ID).generation,1);
 s.observeDownstream(ID,empty(c.now()));await adapter.step(ID);assert.equal(s.activeOp(ID,'ticket').attempt,2);assert.equal(s.activeOp(ID,'ticket').phase,'confirmed');assert.equal(s.restartAudit(ID).generation,1);
}));

test('restoring original native ticket after restart preserves it instead of rotating',()=>fixture(async(s,c)=>{
 allocate(s,c.now(),{confirmed:true});c.advance(RESTART_RECOVERY_DELAY_MS);let uploads=0;
 const adapter=new ProducerUploadAdapter(s,{upload:async args=>{uploads++;assert.equal(args.ticket.upload_url,url);return post(success,safe,'producer_curl_managed_proxy_v1');}},{transport:'managed_proxy',restart:{started_at:c.now(),requireLock:async()=>{}}});
 adapter.restoreTicket(ID,ticket);fresh(s,c);await adapter.step(ID);assert.equal(uploads,1);assert.equal(s.restartAudit(ID),null);assert.equal(s.activeOp(ID,'ticket').attempt,1);assert.equal(s.activeOp(ID,'post').phase,'confirmed');
}));

test('summary retains history but active_operations reports latest outcome of each current stage',()=>fixture(async(s,c)=>{
 allocate(s,c.now(),{confirmed:true});s.observeDownstream(ID,empty(c.now()));s.record(s.next(ID),post());c.advance(RETRY_DELAY_MS);s.observeDownstream(ID,empty(c.now()));s.record(s.next(ID),post(success));
 const summary=s.summary(s.get(ID));assert.equal(summary.operation_history.filter(o=>o.operation==='post').length,2);assert.equal(summary.operations.filter(o=>o.operation==='post').length,1);assert.equal(summary.active_operations.filter(o=>o.operation==='post').length,1);assert.equal(summary.active_operations.find(o=>o.operation==='post').outcome,'confirmed');assert.equal(summary.active_operations.find(o=>o.operation==='post').attempt,2);
}));

function nativeProof(s,c,{offset,elapsed}){
 const inspect=new ProducerInspect(s,native),write=inspect.next(ID),command=write.arguments.message,sourceTime=c.now(),source=(sourceTime/1000).toFixed(6);
 assert.equal(write.next_action,'inspect');const locate=inspect.next(ID),result=body=>({content:[{type:'text',text:JSON.stringify(body)}],isError:false});
 inspect.observeSource(ID,{tool:locate.tool,arguments:locate.arguments,result:result({results:`# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: #control (ID: C123)\nFrom: User (ID: U123) \nTime: synthetic\nMessage_ts: ${source}\nPermalink: [link](https://${native.workspace_host}/archives/C123/p${source.replace('.','')})\nText: \n${command} ${scope.sender_attribution_text}\n\n---\n\n`,pagination_info:'End of results - No more pages available.\n'})});
 c.advance(elapsed);const read=inspect.next(ID),receipt={query_id:write.operation_id,request_id:ID,report_date:DAY,bundle_sha256:hash,source_ts:source,...empty(sourceTime+offset)};
 const invocation={tool:read.tool,arguments:read.arguments,result:result({messages:`=== THREAD PARENT MESSAGE ===\nFrom: User <user@example.test> (U123)\nTime: synthetic\nMessage TS: ${source}\n${command}\n${scope.sender_attribution_text}\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Publisher <botuser-T123-B456@slack-bots.com> (U456)\nTime: synthetic\nMessage TS: ${((sourceTime+1)/1000).toFixed(6)}\n!ai-report inspect-receipt ${JSON.stringify(receipt)}\n`,pagination_info:'There are no more messages in this thread.\n'})};
 return {inspect,invocation,query_id:write.operation_id,accept:()=>inspect.observeReceipt(ID,invocation)};
}
for(const sample of [
 {name:'one millisecond slow',offset:-1,elapsed:0,outcome:'state'},
 {name:'five seconds slow',offset:-5000,elapsed:0,outcome:'state'},
 {name:'exact allowed thirty-second skew',offset:-30000,elapsed:0,outcome:'state'},
 {name:'one millisecond outside allowed skew',offset:-30001,elapsed:0,outcome:'reject'},
 {name:'one millisecond in the future',offset:1,elapsed:0,outcome:'reject'},
 {name:'five seconds in the future',offset:5000,elapsed:0,outcome:'reject'},
 {name:'fast clock caught up before receipt',offset:5000,elapsed:5000,outcome:'state'},
 {name:'one millisecond before freshness expiry',offset:-30000,elapsed:29999,outcome:'state'},
 {name:'exact freshness expiry',offset:-30000,elapsed:30000,outcome:'stale_inspect'}
])test('native recovery clock boundary: '+sample.name,()=>fixture(async(s,c)=>{
 allocate(s,c.now());c.advance(RESTART_RECOVERY_DELAY_MS);const start=startup(s,c),proof=nativeProof(s,c,sample);
 if(sample.outcome==='reject'){
  assert.throws(proof.accept,/observation clock/);assert.equal(proof.inspect.query(ID).phase,'located');assert.equal(s.recoverAbandonedTicket(ID,start).type,'read');assert.equal(s.restartAudit(ID),null);return;
 }
 assert.equal(proof.accept().type,sample.outcome);
 if(sample.outcome==='stale_inspect'){
  assert.equal(proof.inspect.query(ID).phase,'resolved');assert.equal(s.recoverAbandonedTicket(ID,start).type,'read');assert.equal(s.restartAudit(ID),null);assert.equal(s.get(ID).detail.preflight_at,null);return;
 }
 assert.equal(s.get(ID).detail.preflight_query_id,proof.query_id);assert.equal(s.recoverAbandonedTicket(ID,start).type,'ticket_abandoned');assert.equal(s.get(ID).detail.preflight_at,null);
 // Even the original authenticated resolved reply cannot replenish a consumed
 // proof. A newly created query also cannot accept the older nonce's receipt.
 proof.accept();assert.equal(s.get(ID).detail.preflight_at,null);assert.equal(s.next(ID).type,'read');const next=proof.inspect.next(ID);assert.equal(next.type,'write');assert.notEqual(next.operation_id,proof.query_id);assert.throws(proof.accept);assert.equal(s.get(ID).detail.preflight_at,null);assert.equal(s.op(ID,'post'),null);assert.equal(s.op(ID,'complete'),null);
}));
