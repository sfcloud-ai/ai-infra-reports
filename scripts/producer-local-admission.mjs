import {DatabaseSync} from 'node:sqlite';
import {lstat} from 'node:fs/promises';
// Local T4 bridge only. No endpoint, credentials, or external-supplied proof.
import path from 'node:path';
import {privateFile,validateConfig} from './run-handoff.mjs';
import {HandoffState,handoffScope,scopeDigest} from './handoff-state.mjs';
import {withHandoffLock} from './handoff-lock.mjs';
import {ADMISSION_SCHEMA,TRANSPORT_SCHEMA,producerScopeHash} from './producer-upload.mjs';
import {registerCompletion,assertFence} from './producer-admission-fence.mjs';
import {requireThat} from './report-handoff.mjs';
import {requireOriginalRunnerLock} from './producer-recovery-lock.mjs';
export async function withCompletionAdmission(configFile,producerConfig,producer,id,makeAction){
 const j=producer.get(id);
 // Other steps never need Publisher's lock. Any old COMPLETE intent remains
 // reconciliation-only; this API cannot re-emit it or register it retroactively.
 const candidate=j&&!j.detail.existing&&!j.detail.source_ts&&!j.detail.delivery&&producer.activeOp(id,'post')?.phase==='confirmed'&&!producer.activeOp(id,'complete');
 if(!candidate)return makeAction();
 const lock=await requireOriginalRunnerLock(producerConfig.state_file),journal=await lstat(producerConfig.state_file,{bigint:true});
 const config=validateConfig(JSON.parse((await privateFile(configFile,16384)).toString('utf8')));
 requireThat(config.producer_fence,'Explicit T4 Publisher fence required');
 requireThat(producer.scope.publisher_scope_sha256===scopeDigest(handoffScope(config)),'Producer inspect scope must match the local Publisher');
 const policy=producer.db.prepare('SELECT * FROM producer_admission_policy WHERE id=1').get();
 requireThat(policy&&policy.generation===config.producer_fence.generation&&policy.config_file===configFile,'Original mandatory admission policy required');
 const current={journal_device:String(journal.dev),journal_inode:String(journal.ino),...lock};
 requireThat(policy.installation_json===JSON.stringify(Object.fromEntries(Object.entries(config.producer_fence.installation).sort(([a],[b])=>a.localeCompare(b)))),'Original admission installation policy differs');
 requireThat(Object.entries(config.producer_fence.installation).every(([key,value])=>current[key]===value),'Designated T4 journal/lock installation required');
 const filename=path.join(config.state_dir,'handoff.sqlite');
 await privateFile(filename,Number.MAX_SAFE_INTEGER,false);
 const original=await lstat(filename,{bigint:true});
 // Acquire BEFORE makeAction can commit COMPLETE. Ordinary contention must not
 // turn an undispatched operation into an unknown. The callback is synchronous:
 // no native action is emitted while holding Publisher's lock.
 return withHandoffLock(config.state_dir,async()=>{
  await privateFile(filename,Number.MAX_SAFE_INTEGER,false);
  const current=await lstat(filename,{bigint:true});
  requireThat(original.dev===current.dev&&original.ino===current.ino,'Original Publisher ledger changed while waiting');
  const state=new HandoffState(filename,handoffScope(config));
  try{
  assertFence(state.db,config.producer_fence);
  requireThat(producerScopeHash(producer.scope)===config.producer_fence.producer_scope_sha256,'Designated Producer scope required');
  requireThat(!state.db.prepare('SELECT 1 FROM producer_quarantined_dates WHERE report_date=?').get(j.date),'Original unresolved date requires explicit adjudication');
  requireThat(!state.db.prepare('SELECT 1 FROM producer_admission_grants WHERE request_id=?').get(id),'Original completion grant requires reconciliation');
  const action=makeAction();
  if(action.type==='write'&&action.next_action==='complete'){
   requireThat(action.write_allowed===true&&producer.activeOp(id,'complete')?.operation_id===action.operation_id,'Original one-shot dispatch binding required');
   registerCompletion(state.db,config.producer_fence,producer,id,Date.now());
  }
  return action;
  }finally{state.close();}
 });
}

// Explicit offline migration setup only; no serve path invokes this. The caller
// holds both designated locks and validates the installed Publisher fence first.
export function installProducerAdmissionPolicy(producer,configFile,config){
 requireThat(!producer.db.prepare("SELECT 1 FROM sqlite_master WHERE name='producer_admission_policy'").get(),'Producer admission policy already exists');
 requireThat(producer.db.prepare('SELECT count(*) n FROM producer_runs').get().n===0,'New T4 installation only; never upgrade a missing or unknown old run');
 producer.db.exec('BEGIN IMMEDIATE');try{
  producer.db.exec(ADMISSION_SCHEMA.producer_admission_policy);
  const installation=JSON.stringify(Object.fromEntries(Object.entries(config.producer_fence.installation).sort(([a],[b])=>a.localeCompare(b))));
  producer.db.prepare('INSERT INTO producer_admission_policy VALUES(1,?,?,?)').run(config.producer_fence.generation,configFile,installation);
  producer.db.exec('COMMIT');
 }catch(e){producer.db.exec('ROLLBACK');throw e;}
}

export async function verifyAdmissionStartup(configFile,producerConfig,policy){
 const config=validateConfig(JSON.parse((await privateFile(configFile,16384)).toString('utf8')));
 requireThat(producerConfig.scope.publisher_scope_sha256===scopeDigest(handoffScope(config)),'Producer inspect scope must match the local Publisher');
 requireThat(config.producer_fence&&policy.generation===config.producer_fence.generation&&policy.config_file===configFile,'Installed T4 fence configuration differs');
 requireThat(producerScopeHash(producerConfig.scope)===config.producer_fence.producer_scope_sha256,'Designated Producer scope required');
 const identity=JSON.stringify(Object.fromEntries(Object.entries(config.producer_fence.installation).sort(([a],[b])=>a.localeCompare(b))));
 requireThat(policy.installation_json===identity,'Installed T4 installation differs');
 const lock=await requireOriginalRunnerLock(producerConfig.state_file),stat=await lstat(producerConfig.state_file,{bigint:true});
 const current={journal_device:String(stat.dev),journal_inode:String(stat.ino),...lock};
 requireThat(Object.entries(config.producer_fence.installation).every(([key,value])=>current[key]===value),'Designated T4 journal/lock installation required');
 return withHandoffLock(config.state_dir,async()=>{
  const filename=path.join(config.state_dir,'handoff.sqlite');await privateFile(filename,Number.MAX_SAFE_INTEGER,false);
  const db=new DatabaseSync(filename,{readOnly:true});try{db.exec('PRAGMA query_only=ON');assertFence(db,config.producer_fence);requireThat(db.prepare('SELECT value FROM scope WHERE id=1').get()?.value===scopeDigest(handoffScope(config)),'Original Publisher identity required');}finally{db.close();}
 });
}

// Explicit migration-only activation of the separately approved T4 egress.
// Existing nonempty journals and their transport history are never rewritten.
export function installT4DirectTransportPolicy(producer,authorizationReference){
 requireThat(/^[A-Za-z0-9:_./-]{1,200}$/.test(authorizationReference??''),'Explicit T4 direct TLS authorization reference required');
 requireThat(producer.db.prepare("SELECT 1 FROM sqlite_master WHERE name='producer_admission_policy'").get()&&!producer.db.prepare("SELECT 1 FROM sqlite_master WHERE name='producer_transport_policy'").get(),'Mandatory admission installation required; never reinstall transport');
 requireThat(producer.db.prepare('SELECT count(*) n FROM producer_runs').get().n===0,'Explicit empty T4 installation required');
 producer.db.exec('BEGIN IMMEDIATE');try{producer.db.exec(TRANSPORT_SCHEMA.producer_transport_policy);producer.db.prepare('INSERT INTO producer_transport_policy VALUES(1,?,?)').run('t4_direct_tls_v1',authorizationReference);producer.db.exec('COMMIT');}catch(e){producer.db.exec('ROLLBACK');throw e;}
}
