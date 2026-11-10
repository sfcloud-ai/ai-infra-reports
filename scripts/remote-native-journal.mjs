// Publisher-owned state over the existing authenticated private control lane.
// This ledger records intent; it never grants a Slack send or replaces a file.
import {digest} from './archive.mjs';
import {requireThat,REQUEST} from './report-handoff.mjs';
import {createNoticeManifest} from './notice-manifest.mjs';
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OPS=['begin','final_complete','record'];
export const JOURNAL_CATALOG=Object.freeze({report_request_id:'remote-journal-catalog',bundle_sha256:'0'.repeat(64)});
export const JOURNAL_FIELDS=Object.freeze({
 journal_catalog:[],
 journal_open:['attempt_id','file_id','expected_revision'],
 journal_read:['attempt_id','file_id'],
 journal_intent:['attempt_id','file_id','expected_revision','executor_id','operation','input_sha256'],
 journal_settle:['attempt_id','file_id','expected_revision','executor_id','operation','outcome','evidence_command_id'],
 journal_defer:['attempt_id','file_id','expected_revision','next_attempt_at','reason']
});
export function validateJournalCommand(c){
 if(c.action==='journal_catalog'){requireThat(Object.entries(JOURNAL_CATALOG).every(([k,v])=>c[k]===v),'Invalid journal catalog scope');return;}
 if(c.action!=='journal_read')requireThat(Number.isSafeInteger(c.expected_revision)&&c.expected_revision>=0,'Invalid journal revision');
 if(c.action==='journal_open')requireThat(c.expected_revision===0,'Opening revision must be zero');
 if(['journal_intent','journal_settle'].includes(c.action))requireThat(OPS.includes(c.operation),'Unsupported journal operation');
 if(c.action==='journal_intent')requireThat(UUID.test(c.executor_id)&&HASH.test(c.input_sha256),'Invalid operation identity');
 if(c.action==='journal_settle')requireThat(UUID.test(c.executor_id)&&['acknowledged','unknown'].includes(c.outcome)&&(c.outcome==='unknown'?c.evidence_command_id===null:typeof c.evidence_command_id==='string'&&REQUEST.test(c.evidence_command_id)),'Acknowledgement requires existing Publisher evidence');
 if(c.action==='journal_defer')requireThat(Number.isSafeInteger(c.next_attempt_at)&&c.next_attempt_at>0&&['publication_retry','reconcile_wait','execution_slice_complete','read_retry'].includes(c.reason),'Invalid durable retry');
}
export const REMOTE_JOURNAL_SCHEMA=[
 'CREATE TABLE remote_native_runs (report_id TEXT PRIMARY KEY, binding TEXT NOT NULL, binding_sha256 TEXT NOT NULL, revision INTEGER NOT NULL, phase TEXT NOT NULL, next_attempt_at INTEGER NOT NULL, deferrals INTEGER NOT NULL, retry_reason TEXT)',
 'CREATE TABLE remote_native_ops (report_id TEXT NOT NULL, operation TEXT NOT NULL, input_sha256 TEXT NOT NULL, executor_id TEXT NOT NULL, intent_command_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, evidence_command_id TEXT, result_sha256 TEXT, PRIMARY KEY(report_id,operation))',
 "CREATE TRIGGER remote_native_binding_immutable BEFORE UPDATE OF report_id,binding,binding_sha256 ON remote_native_runs BEGIN SELECT RAISE(ABORT,'Immutable remote journal binding'); END",
 "CREATE TRIGGER remote_native_run_keep BEFORE DELETE ON remote_native_runs BEGIN SELECT RAISE(ABORT,'Remote journal cannot be deleted'); END",
 "CREATE TRIGGER remote_native_intent_immutable BEFORE UPDATE OF report_id,operation,input_sha256,executor_id,intent_command_id ON remote_native_ops BEGIN SELECT RAISE(ABORT,'Immutable remote operation intent'); END",
 "CREATE TRIGGER remote_native_op_keep BEFORE DELETE ON remote_native_ops BEGIN SELECT RAISE(ABORT,'Remote operation cannot be deleted'); END"
];
export function remoteJournalSchemaObjects(db){
 const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name IN ('remote_native_runs','remote_native_ops') OR tbl_name IN ('remote_native_runs','remote_native_ops') AND type='trigger' ORDER BY name").all();
 if(objects.length)requireThat(objects.length===REMOTE_JOURNAL_SCHEMA.length&&objects.every(o=>REMOTE_JOURNAL_SCHEMA.includes(o.sql)),'Unexpected remote journal schema');
 return objects;
}
export function remoteJournal(db,id){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_native_runs'").get())return null;
 const row=db.prepare('SELECT * FROM remote_native_runs WHERE report_id=?').get(id);
 if(!row)return null;
 requireThat(digest(Buffer.from(row.binding))===row.binding_sha256,'Remote journal binding damaged');
 return {...row,binding:JSON.parse(row.binding),operations:db.prepare('SELECT * FROM remote_native_ops WHERE report_id=? ORDER BY operation').all(id)};
}
// A bounded authenticated read, ordered by oldest due time for fairness.
export function remoteCatalog(outbox){
 remoteJournalSchemaObjects(outbox.db);
 if(!outbox.db.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_native_runs'").get())return [];
 return outbox.db.prepare("SELECT report_id FROM remote_native_runs WHERE phase='open' ORDER BY next_attempt_at,report_id LIMIT 4").all().map(({report_id})=>{
  const run=remoteJournal(outbox.db,report_id),job=outbox.state.get(report_id),n=outbox.notice(report_id);
  requireThat(JSON.stringify(run.binding)===JSON.stringify(binding(outbox,job,n)),'Catalog binding changed');
  return {report_request_id:report_id,bundle_sha256:run.binding.bundle_sha256,attempt_id:run.binding.attempt_id,file_id:run.binding.file_id,report_commit:run.binding.report_commit,source_ts:job.source_ts,next_attempt_at:run.next_attempt_at};
 });
}
// Recovered evidence settles an intent; it cannot replay the original write.
export function remoteEvidence(outbox,run,job,n){
 const found={};
 for(const op of run.operations){
  if(op.phase==='acknowledged'||op.operation==='final_complete')continue;
  for(const row of outbox.db.prepare('SELECT id FROM notice_commands WHERE hash=? AND response IS NOT NULL').all(op.input_sha256)){
   try{evidence(outbox,{operation:op.operation,evidence_command_id:row.id},job,n,op);found[op.operation]=row.id;break;}catch{}
  }
 }
 return found;
}
function binding(outbox,job,n){
 requireThat(job.phase==='receipt_sent'&&n?.report_id===job.id&&n.detail.delivery_mode==='native_bundle_v1'&&n.detail.poster_policy==='original_bytes_v1'&&n.detail.bundle_sha256===job.hash&&n.detail.report_merge_sha===job.detail.commit&&n.detail.destination===outbox.destination,'Remote journal requires the original published native bundle reservation');
 const d=n.detail;
 return {schema_version:'1.0',report_id:job.id,edition:n.edition,bundle_sha256:job.hash,report_commit:job.detail.commit,attempt_id:n.attempt_id,file_id:n.file_id,destination:d.destination,mode:d.delivery_mode,not_before:d.not_before,url:d.url,text_sha256:d.text_sha256,poster_sha256:d.poster_original_sha256,scope_sha256:outbox.db.prepare('SELECT value FROM notice_scope WHERE id=1').get().value};
}
export function remoteFinalInputHash(bundle,notice){
 const manifest=createNoticeManifest(bundle.files.get(bundle.report.path+'report.json'),notice.detail.report_merge_sha,{stableUrls:notice.detail.url===`https://sfcloud-ai.github.io/ai-infra-reports/${bundle.report.date}/`});
 return digest(Buffer.from(JSON.stringify({file_id:notice.file_id,channel_id:notice.detail.destination,initial_comment:manifest.text,title:'ai-brief-bundle.json'})));
}
function evidence(outbox,c,job,n,op){
 const e=outbox.command(c.evidence_command_id);
 requireThat(e?.response&&digest(e.bytes)===e.hash,'Original operation evidence unavailable');
 const command=JSON.parse(e.bytes),r=e.response;
 requireThat(command.report_request_id===job.id&&command.bundle_sha256===job.hash&&command.attempt_id===n.attempt_id&&command.file_id===n.file_id&&r.command_id===e.id&&r.command_sha256===e.hash,'Operation evidence binding changed');
 if(c.operation==='begin')requireThat(command.action==='begin'&&e.hash===op.input_sha256&&r.send_authorized===true&&n.detail.completion_command_id===e.id&&n.detail.completion_command_sha256===e.hash,'Begin acknowledgement requires the original completion intent');
 if(c.operation==='final_complete'){
  const v=r.verification;
  requireThat(command.action==='check'&&v?.slack_status==='verified'&&v.receipt?.file_id===n.file_id&&v.receipt.channel===outbox.destination&&v.receipt.transport_sha256===job.hash&&v.receipt.transport_bytes===job.bytes.length,'Final acknowledgement requires a verified original delivery');
 }
 if(c.operation==='record')requireThat(command.action==='record_bundle'&&e.hash===op.input_sha256&&n.phase==='sender_reported','Record acknowledgement requires the original stored receipt');
 return digest(Buffer.from(JSON.stringify(r)));
}
// Called inside NoticeOutbox's BEGIN IMMEDIATE. State and response commit together.
export function applyJournalCommand(outbox,c,job,{now=Date.now(),bundle}={}){
 requireThat(Number.isSafeInteger(now)&&now>0,'Publisher clock unavailable');
 const db=outbox.db;remoteJournalSchemaObjects(db);
 const n=outbox.notice(job.id),b=binding(outbox,job,n);
 requireThat(c.attempt_id===b.attempt_id&&c.file_id===b.file_id,'Journal cannot change original upload identity');
 let run=remoteJournal(db,job.id),reason='journal_read',newIntent=false;
 if(run)requireThat(JSON.stringify(run.binding)===JSON.stringify(b),'Journal scope or immutable plan changed');
 if(c.action==='journal_open'&&!run){
  requireThat(n.phase==='reserved'&&!n.detail.recovery,'An existing completion intent cannot be imported into a new journal');
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='notice_recovery_authorizations'").get())requireThat(!db.prepare('SELECT 1 FROM notice_recovery_authorizations WHERE report_id=?').get(job.id),'Explicit recovery cannot be imported');
  for(const sql of REMOTE_JOURNAL_SCHEMA)db.exec(sql.replace(/^CREATE (TABLE|TRIGGER) /,'CREATE $1 IF NOT EXISTS '));
  const encoded=JSON.stringify(b);
  db.prepare("INSERT INTO remote_native_runs VALUES(?,?,?,1,'open',0,0,NULL)").run(job.id,encoded,digest(Buffer.from(encoded)));
  reason='journal_opened';
 }else if(c.action==='journal_open')reason='journal_already_open';
 else if(c.action==='journal_read')reason=run?'journal_read':'journal_absent';
 else{
  requireThat(run,'Open the original reservation journal first');
  if(run.phase==='complete')reason='journal_complete';
  else if(c.expected_revision!==run.revision)reason='journal_revision_conflict';
  else if(c.action==='journal_intent'){
   const prior=run.operations.find(o=>o.operation===c.operation);
   if(prior){requireThat(prior.input_sha256===c.input_sha256,'Operation input changed');reason='journal_existing_intent';}
   else if(c.operation==='begin'&&now<run.next_attempt_at)reason='journal_retry_not_due';
   else{
    const index=OPS.indexOf(c.operation),previous=run.operations.find(o=>o.operation===OPS[index-1]);
    requireThat(index===0?n.phase==='reserved':previous?.phase==='acknowledged','Previous operation needs reconciliation');
    if(c.operation==='final_complete'){
     requireThat(previous.executor_id===c.executor_id&&n.phase==='completion_intent','Restart cannot reuse the completion owner');
     requireThat(bundle&&c.input_sha256===remoteFinalInputHash(bundle,n),'Final operation must retain the original file and exact bundle comment');
    }
    requireThat(!run.operations.some(o=>o.phase!=='acknowledged'),'Unknown writes require reconciliation');
    db.prepare("INSERT INTO remote_native_ops VALUES(?,?,?,?,?,'intent',NULL,NULL)").run(job.id,c.operation,c.input_sha256,c.executor_id,c.command_id);
    db.prepare('UPDATE remote_native_runs SET revision=revision+1,next_attempt_at=0 WHERE report_id=? AND revision=?').run(job.id,run.revision);
    reason='journal_new_intent';newIntent=true;
   }
  }else if(c.action==='journal_settle'){
   const op=run.operations.find(o=>o.operation===c.operation);requireThat(op,'Missing original operation intent');
   if(c.outcome==='unknown')requireThat(c.executor_id===op.executor_id,'Only the original executor can report its ambiguous write');
   if(op.phase==='acknowledged')reason='journal_already_acknowledged';
   else{
    const result=c.outcome==='acknowledged'?evidence(outbox,c,job,n,op):null;
    db.prepare('UPDATE remote_native_ops SET phase=?,evidence_command_id=?,result_sha256=? WHERE report_id=? AND operation=?').run(c.outcome,c.evidence_command_id,result,job.id,c.operation);
    const complete=c.operation==='record'&&c.outcome==='acknowledged';
    db.prepare('UPDATE remote_native_runs SET revision=revision+1,phase=?,next_attempt_at=? WHERE report_id=? AND revision=?').run(complete?'complete':'open',complete?0:run.next_attempt_at,job.id,run.revision);
    reason=c.outcome==='acknowledged'?'journal_reconciled':'journal_unknown';
   }
  }else if(c.action==='journal_defer'){
   const due=Math.max(now+15000,c.next_attempt_at,run.next_attempt_at);requireThat(Number.isSafeInteger(due),'Invalid retry clock');
   db.prepare('UPDATE remote_native_runs SET revision=revision+1,next_attempt_at=?,deferrals=deferrals+1,retry_reason=? WHERE report_id=? AND revision=?').run(due,c.reason,job.id,run.revision);
   reason='journal_deferred';
  }
 }
 const journal=remoteJournal(db,job.id);
 if(journal)journal.evidence=remoteEvidence(outbox,journal,job,n);
 return {reason,new_intent:newIntent,journal};
}
// Existing begin/record commands must match the remote intent exactly once a
// reservation opts in. Ordinary legacy reservations retain their original rules.
export function guardJournalOperation(outbox,c){
 const run=remoteJournal(outbox.db,c.report_request_id);if(!run)return;
 requireThat(c.action!=='recover_begin','Remote journal cannot switch to a replacement attempt');
 const operation=c.action==='begin'?'begin':c.action==='record_bundle'?'record':null;
 if(operation){
  const op=run.operations.find(o=>o.operation===operation),command=outbox.command(c.command_id);
  requireThat(op?.phase==='intent'&&op.input_sha256===command.hash,'Control operation lacks its original remote intent; unknown writes only reconcile');
 }
}
