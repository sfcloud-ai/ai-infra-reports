// Trusted, host-local migration API. No Slack command can install this fence or
// register an admission. Callers must hold the original Publisher outer lock;
// registration additionally holds the designated T4 Producer lock throughout.
// This is not a reconstruction of a missing Producer journal.
import {requireThat,reportDate} from './report-handoff.mjs';
import {producerScopeHash,ProducerUploadState} from './producer-upload.mjs';
const HASH=/^[a-f0-9]{64}$/, UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, TS=/^\d{10}\.\d{6}$/;
export const FENCE_SCHEMA={
 producer_quarantined_dates:'CREATE TABLE producer_quarantined_dates(report_date TEXT PRIMARY KEY,evidence_reference TEXT NOT NULL)',
 producer_admission_fence:'CREATE TABLE producer_admission_fence(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL,activation_ts TEXT NOT NULL,producer_scope_sha256 TEXT NOT NULL,installation_json TEXT NOT NULL,migration_reference TEXT NOT NULL)',
 producer_admission_grants:'CREATE TABLE producer_admission_grants(request_id TEXT PRIMARY KEY,report_date TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,file_id TEXT UNIQUE NOT NULL,generation TEXT NOT NULL,operation_id TEXT UNIQUE NOT NULL,registered_at INTEGER NOT NULL,source_ts TEXT UNIQUE)'
};
export function validateFenceConfig(c){
 requireThat(c&&Object.keys(c).sort().join()==='activation_ts,generation,installation,producer_scope_sha256'&&UUID.test(c.generation)&&TS.test(c.activation_ts)&&HASH.test(c.producer_scope_sha256),'Explicit Producer fence configuration required');
 requireThat(c.installation&&Object.keys(c.installation).sort().join()==='journal_device,journal_inode,lock_device,lock_inode'&&Object.values(c.installation).every(v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,31})$/.test(v)),'Pinned T4 journal and lock identity required');return c;
}
const installationJSON=c=>JSON.stringify(Object.fromEntries(Object.entries(c.installation).sort(([a],[b])=>a.localeCompare(b))));
export function assertFence(db,c){
 const rows=db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('producer_admission_fence','producer_admission_grants','producer_quarantined_dates')").all();
 if(!c){requireThat(rows.length===0,'Installed Producer fence cannot be removed');return null;}
 validateFenceConfig(c);
 requireThat(rows.length===3&&rows.every(r=>r.sql===FENCE_SCHEMA[r.name]),'Installed Producer fence schema required');
 const states=db.prepare('SELECT * FROM producer_admission_fence').all();
 requireThat(states.length===1&&states[0].id===1&&['generation','activation_ts','producer_scope_sha256'].every(k=>states[0][k]===c[k])&&states[0].installation_json===installationJSON(c),'Original Producer fence binding required');return states[0];
}
// Explicit migration-only entry point. The caller supplies the approved evidence
// reference; runtime construction never calls this. Existing inbox/jobs are kept.
export function installFence(db,c,migrationReference,blockedDates){
 requireThat(Array.isArray(blockedDates)&&blockedDates.length<=1000&&new Set(blockedDates).size===blockedDates.length&&blockedDates.every(reportDate),'Explicit reviewed old-date quarantine inventory required');
 validateFenceConfig(c);requireThat(typeof migrationReference==='string'&&migrationReference.length>0&&migrationReference.length<=512,'Migration evidence reference required');
 requireThat(!db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('producer_admission_fence','producer_admission_grants','producer_quarantined_dates')").get(),'Fence already present; never reinstall');
 db.exec('BEGIN IMMEDIATE');try{
  for(const sql of Object.values(FENCE_SCHEMA))db.exec(sql);
  db.prepare('INSERT INTO producer_admission_fence VALUES(1,?,?,?,?,?)').run(c.generation,c.activation_ts,c.producer_scope_sha256,installationJSON(c),migrationReference);
  for(const date of blockedDates)db.prepare('INSERT INTO producer_quarantined_dates VALUES(?,?)').run(date,migrationReference);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
// This only registers an already-created COMPLETE intent. It cannot create,
// replay or dispatch it. The transport must never emit COMPLETE before this
// commit succeeds. producer must be the verified designated live original T4
// state, under its lock, not a caller-supplied JSON or a snapshot used to dispatch.
export function registerCompletion(db,c,producer,id,now){
 assertFence(db,c);
 requireThat(Number.isSafeInteger(now)&&now>=Number(c.activation_ts)*1000,'Post-cutover registration clock required');
 requireThat(producer instanceof ProducerUploadState,'Verified live Producer state required');
 requireThat(producerScopeHash(producer.scope)===c.producer_scope_sha256,'Designated Producer scope required');
 const j=producer.get(id);
 requireThat(j&&!db.prepare('SELECT 1 FROM producer_quarantined_dates WHERE report_date=?').get(j.date),'Original unresolved date requires explicit adjudication');
 const op=j&&producer.activeOp(id,'complete'),post=j&&producer.activeOp(id,'post');
 requireThat(j&&/^morning-\d{8}-r1$/.test(j.id)&&j.id===`morning-${j.date.replaceAll('-','')}-r1`&&HASH.test(j.hash)&&/^F[A-Z0-9]+$/.test(j.detail.file_id??''),'Original daily bundle binding required');
 requireThat(op?.phase==='unknown'&&op.at>=Number(c.activation_ts)*1000&&UUID.test(op.operation_id)&&post?.phase==='confirmed'&&!j.detail.existing&&!j.detail.source_ts&&!j.detail.delivery,'Original undispatched completion intent required');
 const query=producer.db.prepare("SELECT * FROM producer_inspect_queries WHERE query_id=? AND phase='resolved'").get(j.detail.preflight_query_id);
 // next() already checks the authenticated observed_at before consuming it.
 // ProducerInspect permits that observation up to 30s after Slack receipt_ts;
 // the receipt can therefore be almost 90s old at a valid 60s dispatch gate.
 requireThat(query&&query.run_id===id&&HASH.test(query.receipt_hash??'')&&TS.test(query.source_ts??'')&&TS.test(query.receipt_ts??'')&&j.detail.preflight_empty===true&&op.at>=query.started_at&&op.at<=now&&now-op.at<60000&&Number(query.receipt_ts)*1000>op.at-90000&&Number(query.receipt_ts)*1000<=op.at+30000,'Fresh consumed native inspect proof required');
 requireThat(j.detail.preflight_at===null,'Dispatch must consume its native proof');
 db.exec('BEGIN IMMEDIATE');try{
  const prior=db.prepare('SELECT * FROM producer_admission_grants WHERE request_id=?').get(id);
  const binding={request_id:id,report_date:j.date,hash:j.hash,file_id:j.detail.file_id,generation:c.generation,operation_id:op.operation_id};
  if(prior)requireThat(Object.keys(binding).every(k=>prior[k]===binding[k]),'Original fenced admission cannot change');
  else db.prepare('INSERT INTO producer_admission_grants VALUES(?,?,?,?,?,?,?,NULL)').run(...Object.values(binding),now);
  db.exec('COMMIT');return binding;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function assertFencedEnvelope(state,c,event){
 assertFence(state.db,c);if(!c)return;
 const prior=state.metadata(event.request_id);
 // Only already-admitted original jobs survive without a new grant. Pending
 // pre-cutover inbox entries do not become trusted merely because they are old.
 if(prior){
  if(!(prior.hash===event.hash&&prior.source_ts===event.source_ts&&(!prior.detail.intake_file_id||prior.detail.intake_file_id===event.file_id))){const error=Error('Original grandfathered request conflict');error.code='producer_upload_fenced';throw error;}
  return;
 }
 const grant=state.db.prepare('SELECT * FROM producer_admission_grants WHERE request_id=?').get(event.request_id);
 if(!(grant&&grant.generation===c.generation&&event.source_ts>=c.activation_ts&&grant.hash===event.hash&&grant.file_id===event.file_id&&(!grant.source_ts||grant.source_ts===event.source_ts))){const error=Error('Unregistered or obsolete Producer upload');error.code='producer_upload_fenced';throw error;}
}
export function consumeFencedEnvelope(state,c,event,date){
 assertFencedEnvelope(state,c,event);if(!c)return;
 const grant=state.db.prepare('SELECT * FROM producer_admission_grants WHERE request_id=?').get(event.request_id);
 if(!grant)return; // An exact pre-cutover admitted job, never a new admission.
 requireThat(grant.report_date===date,'Fenced report date mismatch');
 state.db.prepare('UPDATE producer_admission_grants SET source_ts=? WHERE request_id=? AND source_ts IS NULL').run(event.source_ts,event.request_id);
}

export function isFencedOut(state,c,event){
 if(!c)return false;
 try{assertFencedEnvelope(state,c,event);return false;}catch(error){if(error.code==='producer_upload_fenced')return true;throw error;}
}
