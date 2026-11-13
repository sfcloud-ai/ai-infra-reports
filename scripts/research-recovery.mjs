import {createHash} from 'node:crypto';
// Supplemental authority is append-only. It never updates original run/plan/ops.
export const RESEARCH_RECOVERY_SCHEMA={
 research_recovery_grants:'CREATE TABLE research_recovery_grants(grant_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,generation TEXT NOT NULL,plan_hash TEXT NOT NULL,previous_sha256 TEXT,sha256 TEXT UNIQUE NOT NULL,bytes BLOB NOT NULL,created_at INTEGER NOT NULL)',
 research_recovery_authorizations:'CREATE TABLE research_recovery_authorizations(sha256 TEXT PRIMARY KEY,reference TEXT NOT NULL,bytes BLOB NOT NULL,approved_at INTEGER NOT NULL)',
 research_recovery_operations:'CREATE TABLE research_recovery_operations(operation_id TEXT NOT NULL,request_id TEXT NOT NULL,grant_id TEXT NOT NULL,window_start INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(operation_id,window_start))',
 research_recovery_installation:'CREATE TABLE research_recovery_installation(id INTEGER PRIMARY KEY CHECK(id=1),reference TEXT NOT NULL,installed_at INTEGER NOT NULL)'
};
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const immediate=grant=>grant.continuation_policy==='immediate_once_then_hourly_20_until_complete';
const sameReportDate=(grant,now)=>grant.request_id==='morning-'+new Date(now+8*3600000).toISOString().slice(0,10).replaceAll('-','')+'-r1';
const hash=b=>createHash('sha256').update(b).digest('hex');
const need=(yes,code)=>{if(!yes)throw Object.assign(Error(code),{researchControlCode:code});};
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
export function nextResearchContinuationAt(now){
 need(integer(now,0,Number.MAX_SAFE_INTEGER),'recovery_time');
 const hour=3600000, candidate=Math.floor(now/hour)*hour+20*60000;
 return candidate>now?candidate:candidate+hour;
}
export function validateResearchRecoveryGrant(grant,{request_id,generation,plan_hash,plan}){
 const keys='schema_version,grant_id,request_id,generation,plan_hash,previous_sha256,authorization_reference,effective_not_before,window_seconds,failed_attempts_consume_success_budget,continuation_policy';
 need(grant&&typeof grant==='object'&&Object.keys(grant).sort().join()===keys.split(',').sort().join(),'recovery_fields');
 need(grant.schema_version==='research_recovery_grant_v1'&&UUID.test(grant.grant_id),'recovery_schema');
 need(grant.request_id===request_id&&grant.generation===generation&&grant.plan_hash===plan_hash&&HASH.test(plan_hash),'recovery_binding');
 need(grant.previous_sha256===null||typeof grant.previous_sha256==='string'&&HASH.test(grant.previous_sha256),'recovery_previous');
 need(typeof grant.authorization_reference==='string'&&grant.authorization_reference.trim().length>0&&grant.authorization_reference.length<=512,'recovery_authorization_reference');
 need(integer(grant.effective_not_before,0,Number.MAX_SAFE_INTEGER)&&(immediate(grant)||grant.effective_not_before%3600000===20*60000),'recovery_schedule');
 need(grant.window_seconds===3600&&(grant.continuation_policy==='hourly_20_until_complete'||immediate(grant))&&grant.failed_attempts_consume_success_budget===false,'recovery_limits');
 return grant;
}
export function readResearchRecoveryHead(db,request_id){
 const rows=db.prepare('SELECT * FROM research_recovery_grants WHERE request_id=? ORDER BY created_at, rowid').all(request_id);
 let previous=null,head=null;
 for(const row of rows){
  const bytes=Buffer.from(row.bytes),grant=JSON.parse(bytes.toString('utf8'));
  need(hash(bytes)===row.sha256&&grant.previous_sha256===previous&&row.previous_sha256===previous,'recovery_chain');
  need(grant.grant_id===row.grant_id&&grant.request_id===row.request_id&&grant.generation===row.generation&&grant.plan_hash===row.plan_hash,'recovery_row_binding');
  previous=row.sha256;head={grant,sha256:row.sha256,created_at:row.created_at};
 }
 return head;
}
// Caller must authenticate owner approval, hold the original host lock and
// wrap this insert in its command transaction. A text reference alone is NOT approval.
function parseGrant(bytes){
 try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}
 catch{need(false,'recovery_json');}
}
export function appendResearchRecoveryGrant(db,bytes,context,{now}){
 need(Buffer.isBuffer(bytes),'recovery_original_bytes');
 need(integer(now,0,Number.MAX_SAFE_INTEGER),'recovery_time');
 const grant=validateResearchRecoveryGrant(parseGrant(bytes),context),sha256=hash(bytes);
 need(assertResearchRecovery(db),'recovery_layer_not_installed');
 const approved=db.prepare('SELECT * FROM research_recovery_authorizations WHERE sha256=?').get(sha256);
 need(approved&&approved.reference===grant.authorization_reference&&Buffer.from(approved.bytes).equals(bytes)&&approved.approved_at<=now,'recovery_authorization_unverified');
 const same=db.prepare('SELECT sha256 FROM research_recovery_grants WHERE grant_id=?').get(grant.grant_id);
 if(same){need(same.sha256===sha256,'recovery_grant_id_used');return {grant,sha256,already_stored:true};}
 need(immediate(grant)?approved.approved_at===grant.effective_not_before&&sameReportDate(grant,approved.approved_at):grant.effective_not_before>=nextResearchContinuationAt(approved.approved_at),'recovery_not_before');
 const head=readResearchRecoveryHead(db,grant.request_id);
 need(grant.previous_sha256===(head?.sha256??null),'recovery_head_changed');
 db.prepare('INSERT INTO research_recovery_grants VALUES(?,?,?,?,?,?,?,?)').run(grant.grant_id,grant.request_id,grant.generation,grant.plan_hash,grant.previous_sha256,sha256,bytes,now);
 return {grant,sha256,already_stored:false};
}
export function researchRecoveryWindow(head,now){
 if(!head)return null;
 need(integer(now,0,Number.MAX_SAFE_INTEGER),'recovery_time');
 const grant=head.grant,initial=grant.effective_not_before;
 const aligned=immediate(grant)?nextResearchContinuationAt(initial):initial;
 const first=immediate(grant)&&now<aligned;
 const window_start=first?initial:aligned+Math.max(0,Math.floor((now-aligned)/3600000))*3600000;
 const deadline=first?aligned:window_start+grant.window_seconds*1000;
 return {grant_id:grant.grant_id,grant_sha256:head.sha256,not_before:initial,window_start,deadline,active:now>=window_start&&now<deadline};
}
// Outcomes must be derived by the host from stored authenticated result bytes,
// not from claimant-supplied labels or 'acknowledged' transport receipts.
// A failed result is free only when known and verified; unknown stays reserved.
export function researchRecoveryAccounting(operations,classifyVerifiedResult){
 const totals={success_seconds:0,reserved_seconds:0,failed_seconds:0,timing_unknown:false,successful_attempts:{},failed_attempts:{},unknown_attempts:{}};
 for(const op of operations){
  if(op.kind==='native')continue;
  need(Number.isFinite(op.reserved_seconds)&&op.reserved_seconds>=0,'recovery_operation_budget');
  const result=classifyVerifiedResult(op),key=JSON.stringify([op.kind,op.operation_key]);
  const known=op.phase==='acknowledged'&&result?.authenticated===true&&result?.archive_sha256===op.result_archive&&result?.file_sha256===op.result_file&&HASH.test(op.result_archive??'')&&HASH.test(op.result_file??'');
  const elapsed=Number.isFinite(op.elapsed_seconds)&&op.elapsed_seconds>=0?op.elapsed_seconds:null;
  if(known&&elapsed!==null&&result.outcome==='failed'){
   totals.failed_attempts[key]=(totals.failed_attempts[key]??0)+1;
   if(elapsed===null)totals.timing_unknown=true;else totals.failed_seconds+=elapsed;
  }else if(known&&elapsed!==null&&result.outcome==='success'){
   totals.successful_attempts[key]=(totals.successful_attempts[key]??0)+1;
   if(elapsed===null){totals.timing_unknown=true;totals.reserved_seconds+=op.reserved_seconds;}
   else totals.success_seconds+=elapsed;
  }else {totals.reserved_seconds+=Math.max(op.reserved_seconds,elapsed??0);totals.unknown_attempts[key]=(totals.unknown_attempts[key]??0)+1;if(elapsed===null)totals.timing_unknown=true;}
 }
 return totals;
}

// Read-only runtime/CD validation; observing a legacy database never installs tables.
export function assertResearchRecovery(db){
 const rows=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'research_recovery_%'").all();
 if(!rows.length)return false;
 need(rows.length===Object.keys(RESEARCH_RECOVERY_SCHEMA).length&&rows.every(row=>RESEARCH_RECOVERY_SCHEMA[row.name]===row.sql),'recovery_schema_mismatch');
 const records=db.prepare('SELECT * FROM research_recovery_installation').all();
 need(records.length===1&&records[0].id===1&&typeof records[0].reference==='string'&&records[0].reference.trim().length>0,'recovery_installation_missing');
 return true;
}
// Offline operator-only migration. Call under the existing exclusive host lock.
export function installResearchRecovery(db,reference,now=Date.now()){
 need(typeof reference==='string'&&reference.trim().length>0&&reference.length<=512,'recovery_install_reference');
 need(integer(now,0,Number.MAX_SAFE_INTEGER),'recovery_time');
 const rows=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'research_recovery_%'").all();
 if(rows.length){assertResearchRecovery(db);return false;}
 db.exec('SAVEPOINT install_research_recovery');
 try{for(const sql of Object.values(RESEARCH_RECOVERY_SCHEMA))db.exec(sql);db.prepare('INSERT INTO research_recovery_installation VALUES(1,?,?)').run(reference,now);db.exec('RELEASE install_research_recovery');}
 catch(error){db.exec('ROLLBACK TO install_research_recovery');db.exec('RELEASE install_research_recovery');throw error;}
 return true;
}
// This function must only be exposed to the offline authenticated operator CLI,
// never the claimant-controlled Slack action. Approval fixes exact original bytes.
export function approveResearchRecoveryGrant(db,bytes,reference,now){
 need(Buffer.isBuffer(bytes)&&integer(now,0,Number.MAX_SAFE_INTEGER),'recovery_approval_input');
 const grant=JSON.parse(bytes.toString('utf8'));
 need(typeof reference==='string'&&reference.trim().length>0&&reference.length<=512&&grant.authorization_reference===reference,'recovery_authorization_reference');
 const sha256=hash(bytes),prior=db.prepare('SELECT * FROM research_recovery_authorizations WHERE sha256=?').get(sha256);
 if(prior){need(prior.reference===reference&&Buffer.from(prior.bytes).equals(bytes),'recovery_approval_conflict');return {sha256,already_approved:true};}
 need(integer(grant.effective_not_before,0,Number.MAX_SAFE_INTEGER),'recovery_not_before');
 if(immediate(grant)){
  need(grant.effective_not_before===now&&sameReportDate(grant,now),'recovery_immediate_time');
  const approvals=db.prepare('SELECT bytes FROM research_recovery_authorizations').all();
  need(!approvals.some(row=>{const prior=parseGrant(Buffer.from(row.bytes));return prior.request_id===grant.request_id&&immediate(prior);}), 'recovery_immediate_used');
 }else need(grant.effective_not_before>=nextResearchContinuationAt(now),'recovery_not_before');
 db.prepare('INSERT INTO research_recovery_authorizations VALUES(?,?,?,?)').run(sha256,reference,bytes,now);
 return {sha256,already_approved:false};
}
export function recordResearchRecoveryOperation(db,record,now){
 need(record&&Object.keys(record).sort().join()==='grant_id,operation_id,request_id,window_start','recovery_operation_fields');
 need(UUID.test(record.operation_id)&&/^morning-\d{8}-r1$/.test(record.request_id)&&(UUID.test(record.grant_id)||/^plan:[a-f0-9]{64}$/.test(record.grant_id)),'recovery_operation_binding');
 need(integer(now,0,Number.MAX_SAFE_INTEGER)&&integer(record.window_start,0,now),'recovery_operation_window');
 let validWindow=record.window_start%3600000===1200000&&now<record.window_start+3600000;
 if(!validWindow&&UUID.test(record.grant_id)){
  const stored=db.prepare('SELECT * FROM research_recovery_grants WHERE grant_id=?').get(record.grant_id);
  if(stored){
   const bytes=Buffer.from(stored.bytes),grant=parseGrant(bytes);
   need(hash(bytes)===stored.sha256&&grant.grant_id===stored.grant_id&&grant.request_id===stored.request_id,'recovery_row_binding');
   validWindow=immediate(grant)&&grant.request_id===record.request_id&&record.window_start===grant.effective_not_before&&stored.created_at<=now&&now<nextResearchContinuationAt(grant.effective_not_before);
  }
 }
 need(validWindow,'recovery_operation_window');
 const prior=db.prepare('SELECT * FROM research_recovery_operations WHERE operation_id=? AND window_start=?').get(record.operation_id,record.window_start);
 if(prior){need(prior.request_id===record.request_id&&prior.grant_id===record.grant_id,'recovery_operation_conflict');return false;}
 const older=db.prepare('SELECT * FROM research_recovery_operations WHERE operation_id=? ORDER BY window_start DESC LIMIT 1').get(record.operation_id);
 let sameAuthority=older?.grant_id===record.grant_id;
 if(older&&!sameAuthority){
  const head=readResearchRecoveryHead(db,record.request_id);
  const previous=db.prepare('SELECT * FROM research_recovery_grants WHERE grant_id=?').get(older.grant_id);
  sameAuthority=!!(head&&previous&&head.grant.grant_id===record.grant_id&&previous.request_id===record.request_id&&previous.generation===head.grant.generation&&previous.plan_hash===head.grant.plan_hash);
 }
 need(!older||(older.request_id===record.request_id&&sameAuthority&&older.window_start<record.window_start),'recovery_operation_conflict');
 db.prepare('INSERT INTO research_recovery_operations VALUES(?,?,?,?,?)').run(record.operation_id,record.request_id,record.grant_id,record.window_start,now);
 return true;
}
