import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {digest} from '../scripts/archive.mjs';
import {REPOSITORY_INPUT_PATHS} from '../scripts/repository-research-inputs.mjs';
import {ARCHIVE_SCHEMA,readResearchArchive,storeResearchArchive} from '../scripts/research-archive.mjs';
import {RESEARCH_CONTROL_SCHEMA} from '../scripts/research-control.mjs';
import {receiveHostArchive,receiveStagedHostArchive,receiptFailure,withHostArchiveLedger} from '../deployment/receive-host-research-archive.mjs';
import {withHandoffLock} from '../scripts/handoff-lock.mjs';

test('stopped receipt checks settlement after the preceding writer and keeps its lock through the write',{skip:process.platform!=='linux'},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'host-archive-lock-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'handoff.sqlite'),sql=new DatabaseSync(file);
 t.after(()=>sql.close());
 sql.exec('CREATE TABLE scope(id INTEGER PRIMARY KEY,value TEXT);CREATE TABLE jobs(id TEXT PRIMARY KEY,phase TEXT)');
 await chmod(file,0o600);
 let receipt;
 await withHandoffLock(dir,async()=>{
  receipt=withHostArchiveLedger(dir,()=>assert.fail('A pending job must defer the receipt'));
  sql.exec("INSERT INTO jobs VALUES('original','received')");
 });
 assert.deepEqual(await receipt,{status:'deferred',reason:'unsettled_publisher_ledger'});
 sql.exec("UPDATE jobs SET phase='receipt_sent'");
 const result=await withHostArchiveLedger(dir,db=>{
  const lock=spawnSync('/usr/bin/flock',['--nonblock','--conflict-exit-code','75',path.join(dir,'handoff.lock'),'true']);
  assert.equal(lock.status,75);
  return db.prepare('SELECT phase FROM jobs').get().phase;
 },()=>true);
 assert.equal(result,'receipt_sent');
 assert.deepEqual(await withHostArchiveLedger(dir,()=>assert.fail('restarted service must defer'),()=>false),
  {status:'deferred',reason:'publisher_must_be_stopped'});
 const configFile=path.join(dir,'publisher.json');
 await writeFile(configFile,JSON.stringify({state_dir:dir+'-rehearsal'}),{mode:0o600});
 await assert.rejects(receiveStagedHostArchive(configFile,'original','operation','FTEST','a'.repeat(64),'1795000100.000000',dir),/Publisher state directory differs/);
});

for(const terminal of [false,true])test('original host receipt after '+(terminal?'terminal metadata rejection':'verified missing parent'),t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const sql of Object.values(ARCHIVE_SCHEMA))db.exec(sql);
 db.exec('CREATE TABLE research_control_runs(request_id,report_date,permit,plan)');
 db.exec(RESEARCH_CONTROL_SCHEMA.research_control_ops);
 db.exec('CREATE TABLE research_control_policy(id,binding)');
 db.exec(RESEARCH_CONTROL_SCHEMA.research_control_events);
 db.exec(RESEARCH_CONTROL_SCHEMA.research_control_commands);
 db.prepare('INSERT INTO research_control_policy VALUES(1,?)').run(JSON.stringify({protocol:'repository_inputs_v1'}));
 const request='morning-20261124-r1',day='2026-11-24',file='FORIGINAL',operation=randomUUID();
 const payload=Buffer.from('original evidence');
 const bytes=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:randomUUID(),request_id:request,report_date:day,previous_sha256:null,
   files:[{path:'audit/evidence.json',sha256:digest(payload),content_base64:payload.toString('base64')}]}));
 const lastControl='1795000100.000000';
 db.exec('CREATE TABLE publisher_intake_scan(id INTEGER PRIMARY KEY,watermark TEXT,upper_bound TEXT,page_cursor TEXT)');
 db.prepare('INSERT INTO publisher_intake_scan VALUES(1,?,NULL,NULL)').run(lastControl);
 const binding=Buffer.from(JSON.stringify({action:'settle',request_id:request}));
 db.prepare("INSERT INTO research_control_events(source_ts,command_id,hash,bytes,phase) VALUES(?,'original',?,?,'sent')").run(lastControl,digest(binding),binding);
 const hash=digest(bytes),key='archive:'+hash+':',args={request,operation,file,hash,lastControl};
 const input={step:'ticket',permit_id:null,file_id:null,source_ts:null,archive_sha256:hash,sha256:hash,bytes:bytes.length};
 const malformed=Buffer.from('{"secret":"sensitive research"} broken');
 assert.throws(()=>receiveHostArchive(db,{...args,hash:digest(malformed)},malformed),e=>{
  assert.deepEqual(receiptFailure(e),{status:'rejected',reason:'invalid_research_archive'});return true;
 });
 const result={file_id:file,source_ts:null,sha256:hash,bytes:bytes.length};
 const plan={schema_version:'research_plan_v4',prompt_commit_sha:'a'.repeat(40),reports_commit_sha:'b'.repeat(40),files:Object.fromEntries(REPOSITORY_INPUT_PATHS.map(p=>[p,'c'.repeat(64)]))};
 db.prepare('INSERT INTO research_control_runs VALUES(?,?,NULL,?)').run(request,day,JSON.stringify({...plan,schema_version:'research_plan_v2'}));
 const insert=db.prepare("INSERT INTO research_control_ops(operation_id,request_id,kind,operation_key,input_hash,input,owner_id,epoch,reserved_seconds,phase,native_result) VALUES(?,?,?,?,?,?,'fixture',1,0,?,?)");
 function add(request,id,kind,key,input,phase,result){
  insert.run(id,request,kind,key,digest(input),input,phase,result);
 }
 add(request,operation,'native',key+'ticket',JSON.stringify(input),'acknowledged',JSON.stringify(result));
 assert.throws(()=>receiveHostArchive(db,args,bytes),/repository research authority/);
 db.prepare('UPDATE research_control_runs SET plan=?').run(JSON.stringify(plan));
 assert.throws(()=>receiveHostArchive(db,{...args,lastControl:'1795000100.000001'},bytes),e=>receiptFailure(e).reason==='intake_before_owner_handoff');
 const query=Buffer.from(JSON.stringify({action:'status',request_id:'other'}));
 const readOnly='!ai-research control-receipt '+JSON.stringify({request_id:'other',status:'ok'});
 db.prepare("INSERT INTO research_control_events(source_ts,command_id,hash,bytes,phase,reply_text,diagnostic) VALUES('2','status',?,?,'ready',?,'{}')").run(digest(query),query,readOnly);
 assert.throws(()=>receiveHostArchive(db,{...args,file:'FOTHER'},bytes),/binding/);
 assert.throws(()=>receiveHostArchive(db,args,Buffer.concat([bytes,Buffer.from(' ')])),/bytes/);
 add(request,randomUUID(),'native',key+'post','{}','intent',null);
 assert.throws(()=>receiveHostArchive(db,args,bytes),/POST/);
 db.prepare('DELETE FROM research_control_ops WHERE operation_key=?').run(key+'post');
 const reservation=Buffer.from(JSON.stringify({request_id:request,action:'reserve',operations:[{key:key+'post'}]}));
 db.prepare("INSERT INTO research_control_events(source_ts,command_id,hash,bytes) VALUES('0','queued',?,?)").run(digest(reservation),reservation);
 assert.throws(()=>receiveHostArchive(db,args,bytes),e=>receiptFailure(e).reason==='queued_research_mutation');
 assert.equal(db.prepare('SELECT count(*) AS n FROM research_archives').get().n,0);
 db.prepare("DELETE FROM research_control_events WHERE command_id='queued'").run();
 const unknown=randomUUID();
 add(request,unknown,'source','other-source','{}','intent',null);
 const reply={request_id:request,dispatch_granted:true,operations:[{operation_id:unknown}]};
 db.prepare("INSERT INTO research_control_events(source_ts,command_id,hash,bytes,phase,reply_text) VALUES('1','grant',?,?,'unknown',?)")
  .run(digest(bytes),bytes,'!ai-research control-receipt '+JSON.stringify(reply));
 assert.throws(()=>receiveHostArchive(db,args,bytes),/Unresolved research control/);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='host_archive_native_guard'").get().n,0);
 db.prepare("UPDATE research_control_ops SET phase='acknowledged' WHERE operation_id=?").run(unknown);
 assert.equal(db.prepare('SELECT count(*) AS n FROM research_archives').get().n,0);
 const child=Buffer.from(JSON.stringify({...JSON.parse(bytes),command_id:randomUUID(),previous_sha256:hash}));
 const childHash=digest(child),childFile='FCHILD',childOperation=randomUUID();
 const completion={...input,step:'complete',archive_sha256:childHash,sha256:childHash,bytes:child.length,file_id:childFile};
 add(request,childOperation,'native','archive:'+childHash+':complete',JSON.stringify(completion),'unknown',null);
 assert.throws(()=>receiveHostArchive(db,args,bytes),/Unresolved archive upload/);
 db.prepare("UPDATE research_control_ops SET phase='acknowledged',native_result=? WHERE operation_id=?")
  .run(JSON.stringify({file_id:childFile,source_ts:'1.000001',sha256:childHash,bytes:child.length}),childOperation);
 assert.throws(()=>receiveHostArchive(db,args,bytes),/Unresolved archive upload/);
 const childEvent={request_id:request,hash:childHash,file_id:childFile,source_ts:'1.000001'};
 const unboundPost=randomUUID(),unboundHash='e'.repeat(64),rejectionTs='1.000008';
 add(request,unboundPost,'native','archive:'+unboundHash+':post',JSON.stringify({...input,step:'post',file_id:'FUNBOUND',archive_sha256:unboundHash,sha256:unboundHash}),'unknown',null);
 db.prepare("INSERT INTO research_archive_events(source_ts,kind,request_id,hash,file_id,phase,diagnostic) VALUES(?,'save',?,?,?,'sent',?)")
  .run(rejectionTs,request,unboundHash,'FUNBOUND',JSON.stringify({code:'original_archive_operation_required',outcome:'rejected'}));
 assert.throws(()=>storeResearchArchive(db,{...childEvent,source_ts:'1.000009'},child),
  e=>e.researchRejection?.code==='archive_original_result');
 let waiting;
 assert.throws(()=>storeResearchArchive(db,childEvent,child),e=>(waiting=e.researchDeferred)?.code==='archive_parent_unavailable');
 db.prepare("INSERT INTO research_archive_events(source_ts,kind,request_id,hash,file_id,diagnostic) VALUES(?,'save',?,?,?,?)")
  .run(childEvent.source_ts,request,childHash,childFile,JSON.stringify({...waiting,expected_head:'d'.repeat(64)}));
 assert.throws(()=>receiveHostArchive(db,args,bytes),/Unresolved archive upload/);
 const {missing_parent_sha256,...olderDiagnostic}=waiting;
 assert.equal(missing_parent_sha256,hash);
 db.prepare('UPDATE research_archive_events SET diagnostic=? WHERE source_ts=?').run(JSON.stringify(olderDiagnostic),childEvent.source_ts);
 assert.throws(()=>receiveHostArchive(db,args,bytes),/Unresolved archive upload/);
 db.prepare('UPDATE research_archive_events SET diagnostic=? WHERE source_ts=?').run(JSON.stringify(waiting),childEvent.source_ts);
 db.prepare('UPDATE research_archive_events SET source_ts=? WHERE source_ts=?').run('1.000009',childEvent.source_ts);
 assert.throws(()=>receiveHostArchive(db,args,bytes),/Unresolved archive upload/);
 db.prepare('UPDATE research_archive_events SET source_ts=? WHERE source_ts=?').run(childEvent.source_ts,'1.000009');
 assert.throws(()=>receiveHostArchive(db,args,bytes),/Unresolved archive upload/);
 db.prepare('DELETE FROM research_control_ops WHERE operation_id=?').run(unboundPost);
 db.prepare('UPDATE research_archive_events SET diagnostic=? WHERE source_ts=?')
  .run(JSON.stringify({code:'ETIMEDOUT',outcome:'unknown',verified_parent:waiting}),childEvent.source_ts);
 const sibling=Buffer.from(JSON.stringify({...JSON.parse(bytes),command_id:randomUUID()}));
 const siblingHash=digest(sibling),siblingOp=randomUUID(),siblingFile='FSIBLING';
 add(request,siblingOp,'native','archive:'+siblingHash+':ticket',
  JSON.stringify({...input,archive_sha256:siblingHash,sha256:siblingHash,bytes:sibling.length}),'acknowledged',
  JSON.stringify({...result,file_id:siblingFile,sha256:siblingHash,bytes:sibling.length}));
 assert.throws(()=>receiveHostArchive(db,{request,operation:siblingOp,file:siblingFile,hash:siblingHash,lastControl},sibling),/Unresolved archive upload/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM research_archives').get().n,0);
 const otherChild=Buffer.from(JSON.stringify({...JSON.parse(child),command_id:randomUUID()}));
 const otherChildHash=digest(otherChild),otherFile='FOTHERCHILD',otherTs='1.000002',otherOp=randomUUID();
 add(request,otherOp,'native','archive:'+otherChildHash+':complete',
  JSON.stringify({...completion,archive_sha256:otherChildHash,sha256:otherChildHash,bytes:otherChild.length,file_id:otherFile}),
  'acknowledged',JSON.stringify({file_id:otherFile,source_ts:otherTs,sha256:otherChildHash,bytes:otherChild.length}));
 let otherWaiting;
 assert.throws(()=>storeResearchArchive(db,{request_id:request,hash:otherChildHash,file_id:otherFile,source_ts:otherTs},otherChild),
  e=>(otherWaiting=e.researchDeferred)?.missing_parent_sha256===hash);
 db.prepare("INSERT INTO research_archive_events(source_ts,kind,request_id,hash,file_id,diagnostic) VALUES(?,'save',?,?,?,?)")
  .run(otherTs,request,otherChildHash,otherFile,JSON.stringify(otherWaiting));
 assert.throws(()=>receiveHostArchive(db,args,bytes),/Competing archive children/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM research_archives').get().n,0);
 db.prepare('DELETE FROM research_archive_events WHERE source_ts=?').run(otherTs);
 db.prepare('DELETE FROM research_control_ops WHERE operation_id=?').run(otherOp);
 if(terminal){
  db.prepare("UPDATE research_archive_events SET phase='sent',diagnostic=? WHERE source_ts=?")
   .run(JSON.stringify({code:'invalid_file_metadata',outcome:'rejected'}),childEvent.source_ts);
 }
 const before=db.prepare('SELECT * FROM research_control_ops').all();
 const first=receiveHostArchive(db,args,bytes);
 assert.deepEqual(receiveHostArchive(db,args,bytes),first);
 const source=db.prepare('UPDATE research_archives SET source_ts=? WHERE hash=?');
 source.run(first.receipt_id.slice(0,-24),hash);
 assert.throws(()=>receiveHostArchive(db,args,bytes),/archive provenance conflict/);
 source.run(first.receipt_id,hash);
 assert.throws(()=>add(request,randomUUID(),'native',key+'post','{}','intent',null),/archive_already_received_on_host/);
 assert.deepEqual(db.prepare('SELECT * FROM research_control_ops').all(),before);
 assert.equal(db.prepare('SELECT permit FROM research_control_runs').get().permit,null);
 const read=readResearchArchive(db,request,{query_id:randomUUID(),action:'receipt',offset:0,hash});
 assert.equal(read.stored.transport,'t4_host_archive');
 assert.equal(read.stored.host_receipt_id,first.receipt_id);
 assert.equal(read.stored.file_id,undefined);
 const manifest=readResearchArchive(db,request,{query_id:randomUUID(),action:'manifest',offset:0,hash});
 assert.equal(manifest.transport,'t4_host_archive');assert.equal(manifest.host_receipt_id,first.receipt_id);
 assert.equal(manifest.archive_source_ts,undefined);assert.equal(manifest.file_id,undefined);
 assert.equal(read.events.length,0);
 db.exec('DROP TRIGGER host_archive_native_guard');
 assert.throws(()=>receiveHostArchive(db,args,bytes),/guard requires reconciliation/);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='host_archive_native_guard'").get().n,0);
});
