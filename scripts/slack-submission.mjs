// Opt-in, host-persistent staging. Slack is the data transport, not an executor.
// Installation is offline under the original Publisher lock; normal ticks never
// create policy or infer a missing ledger. Old Producer unknowns remain fenced.
import {randomUUID} from 'node:crypto';
import {acceptDataCommand,canonicalRequestDate,decodeBundle,requireThat,reportDate} from './report-handoff.mjs';
import {assertFence} from './producer-admission-fence.mjs';
import {handoffScope,scopeDigest} from './handoff-state.mjs';
import {producerInspection} from './producer-inspect.mjs';
import {queryScheduled} from './scheduled-delivery-bridge.mjs';
import {safeDiagnostic,recoveryDelay} from './handoff-recovery.mjs';
import {controlledDate,acceptPermitSubmission,queuePermitSubmission,permitSubmission,settlePermitSubmission} from './research-control-publication.mjs';

const TS=/^\d{10}\.\d{6}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const SUBMISSION_SCHEMA={
 slack_submission_policy:'CREATE TABLE slack_submission_policy(id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL,evidence_reference TEXT NOT NULL)',
 slack_submission_events:"CREATE TABLE slack_submission_events(source_ts TEXT PRIMARY KEY,kind TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,file_id TEXT,target_ts TEXT,phase TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER NOT NULL DEFAULT 0,diagnostic TEXT)",
 slack_staged_bundles:"CREATE TABLE slack_staged_bundles(request_id TEXT PRIMARY KEY,report_date TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,source_ts TEXT UNIQUE NOT NULL,file_id TEXT NOT NULL,bytes BLOB NOT NULL,phase TEXT NOT NULL DEFAULT 'staged',submit_ts TEXT)"
};
export function validateSubmissionConfig(c){
 requireThat(c&&Object.keys(c).sort().join()==='activation_ts,first_report_date,generation'&&UUID.test(c.generation)&&TS.test(c.activation_ts)&&reportDate(c.first_report_date),'Explicit Slack staging activation required');
 requireThat(c.first_report_date>=new Date(Number(c.activation_ts)*1000+8*3600000).toISOString().slice(0,10),'New staging dates cannot precede activation');return c;
}
function binding(config){
 validateSubmissionConfig(config.slack_submission);
 requireThat(config.producer_fence&&config.durable_intake&&config.scheduled_delivery&&config.sender_user_app_id,'Staging requires fenced durable native intake');
 requireThat(config.slack_submission.activation_ts>=config.producer_fence.activation_ts,'Staging cannot predate the fence');
 const {generation,activation_ts,first_report_date}=config.slack_submission;
 return JSON.stringify({generation,activation_ts,first_report_date,publisher_scope_sha256:scopeDigest(handoffScope(config)),fence_generation:config.producer_fence.generation});
}
export function assertSubmission(db,config){
 const rows=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('slack_submission_policy','slack_submission_events','slack_staged_bundles')").all();
 if(!config.slack_submission){requireThat(!rows.length,'Installed Slack staging cannot be removed');return false;}
 assertFence(db,config.producer_fence);
 requireThat(rows.length===3&&rows.every(r=>r.sql===SUBMISSION_SCHEMA[r.name]),'Original Slack staging schema required');
 const policy=db.prepare('SELECT * FROM slack_submission_policy').all();
 requireThat(policy.length===1&&policy[0].id===1&&policy[0].binding===binding(config),'Original Slack staging binding required');
 requireThat(!db.prepare('SELECT 1 FROM producer_admission_grants').get(),'Legacy Producer grant conflicts with Slack staging');return true;
}
export function installSubmission(db,config,reference){
 const value=binding(config);assertFence(db,config.producer_fence);
 requireThat(typeof reference==='string'&&reference.length>0&&reference.length<=512,'Reviewed activation reference required');
 requireThat(!db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('slack_submission_policy','slack_submission_events','slack_staged_bundles')").get(),'Staging already exists; never reinstall');
 requireThat(!db.prepare('SELECT 1 FROM producer_admission_grants').get(),'Reconcile original Producer grants first');
 db.exec('BEGIN IMMEDIATE');try{
  for(const sql of Object.values(SUBMISSION_SCHEMA))db.exec(sql);
  db.prepare('INSERT INTO slack_submission_policy VALUES(1,?,?)').run(value,reference);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function acceptSubmission(message,config,now,window){
 if(!config.slack_submission)return null;
 const revision=acceptDataCommand(message,config,'!ai-report revise ',/^!ai-report revise (morning-\d{8}-r(?:[2-9]|[1-9]\d+)) ([a-f0-9]{64})$/,now,window);
 if(revision){
  requireThat(canonicalRequestDate(revision.request_id)>=config.slack_submission.first_report_date&&revision.source_ts>=config.slack_submission.activation_ts,'Revision outside activation boundary');
  return {...revision,kind:'revision',target_ts:null};
 }
 requireThat(!/^!ai-report (?:stage|submit) /.test(message?.text??''),'Retired publication entry; use the original host research client');
 const event=acceptPermitSubmission(message,config,now,window);if(!event)return null;
 const date=canonicalRequestDate(event.request_id);
 requireThat(event.permit_id&&controlledDate(config,event.request_id)&&event.source_ts>=config.research_control.activation_ts&&(event.kind==='stage'||event.target_ts<event.source_ts),'Permit submission outside authority activation');
 requireThat(date>=config.slack_submission.first_report_date&&event.source_ts>=config.slack_submission.activation_ts,'Staging outside activation boundary');return event;
}
// Called in the same transaction as the fixed history-page checkpoint.
export function queueSubmission(db,event){
 const values={source_ts:event.source_ts,kind:event.kind,request_id:event.request_id,hash:event.hash,file_id:event.file_id??null,target_ts:event.target_ts};
 const prior=db.prepare('SELECT * FROM slack_submission_events WHERE source_ts=?').get(event.source_ts);
 if(prior){requireThat(Object.entries(values).every(([k,v])=>prior[k]===v),'Original staging command changed');queuePermitSubmission(db,event);return;}
 requireThat(db.prepare('SELECT count(*) AS n FROM slack_submission_events').get().n<10000,'Staging capacity reached');
 db.prepare('INSERT INTO slack_submission_events(source_ts,kind,request_id,hash,file_id,target_ts) VALUES(?,?,?,?,?,?)').run(...Object.values(values));
 queuePermitSubmission(db,event);
}
export function submissionStatus(db,id){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='slack_submission_policy'").get())return null;
 const bundle=db.prepare('SELECT request_id,report_date,hash,source_ts,file_id,phase,submit_ts FROM slack_staged_bundles WHERE request_id=?').get(id);
 const pending=db.prepare("SELECT source_ts,kind,hash,file_id,target_ts,phase,next_at,diagnostic FROM slack_submission_events WHERE request_id=? AND phase='pending' ORDER BY source_ts LIMIT 4").all(id);
 return {bundle:bundle??null,pending:pending.map(r=>({...r,diagnostic:r.diagnostic?JSON.parse(r.diagnostic):null}))};
}
export function pendingSubmissions(db){
 return db.prepare("SELECT source_ts,request_id,kind,phase,next_at,diagnostic FROM slack_submission_events WHERE phase='pending' ORDER BY source_ts LIMIT 16").all().map(r=>({...r,diagnostic:r.diagnostic?JSON.parse(r.diagnostic):null}));
}
export async function advanceSubmission(state,config,slack,query=queryScheduled,now=Date.now(),{monotonicNow=()=>performance.now()}={}){
 const started=monotonicNow(),clock=()=>now+Math.floor(monotonicNow()-started);
 if(!assertSubmission(state.db,config))return;
 const db=state.db,row=db.prepare("SELECT * FROM slack_submission_events WHERE phase='pending' AND next_at<=? ORDER BY last_attempt,source_ts LIMIT 1").get(now);
 if(!row)return;
 db.prepare('UPDATE slack_submission_events SET last_attempt=? WHERE source_ts=?').run(now,row.source_ts);
 try{
  const date=canonicalRequestDate(row.request_id);
  requireThat(!db.prepare('SELECT 1 FROM producer_quarantined_dates WHERE report_date=?').get(date),'Original unresolved date is quarantined');
  if(row.kind==='revision'){
   requireThat(!db.prepare("SELECT 1 FROM slack_submission_events WHERE request_id=? AND hash!=? AND phase!='fenced'").get(row.request_id,row.hash),'Conflicting original revision evidence requires reconciliation');
   const message=await slack.exactPublish(row.source_ts),original=acceptSubmission(message,config,now,{from:config.slack_submission.activation_ts,to:row.source_ts});
   requireThat(original&&['kind','request_id','hash','file_id','target_ts'].every(k=>(original[k]??null)===row[k]),'Original revision command changed');
   const bytes=await slack.download(row),bundle=await decodeBundle(bytes);
   requireThat(bundle.report.schema_version==='1.1'&&bundle.report.revision>1&&bundle.data.request_id===row.request_id&&bundle.hash===row.hash&&bundle.report.date===date,'Explicit revision bundle binding required');
   db.exec('BEGIN IMMEDIATE');try{
    assertSubmission(db,config);
    const prior=state.metadata(row.request_id);
    if(prior)requireThat(prior.hash===row.hash&&prior.source_ts===row.source_ts&&prior.detail.intake_file_id===row.file_id,'Original revision publication conflict');
    else{
     const pending=db.prepare("SELECT id,length(bytes) AS size FROM jobs WHERE phase!='receipt_sent' LIMIT 1001").all();
     requireThat(pending.length<=1000,'Publisher pending capacity exceeded');
     const read=db.prepare('SELECT bytes FROM jobs WHERE id=?');
     for(const metadata of pending){
      requireThat(Number.isSafeInteger(metadata.size)&&metadata.size>0&&metadata.size<=8*1024*1024,'Publisher original bundle too large');
      const previous=read.get(metadata.id);
      const originalBundle=await decodeBundle(Buffer.from(previous.bytes));
      requireThat(originalBundle.report.date!==date,'Previous publication receipt must settle before revising this date');
     }
     const job=state.admit({request_id:row.request_id,hash:row.hash,source_ts:row.source_ts,file_id:row.file_id},bytes);
     state.move(job.id,'received','received',{...job.detail,intake_transport:'slack_revision_file_v1'});
    }
    db.prepare("UPDATE slack_submission_events SET phase='done',diagnostic=NULL,next_at=0 WHERE source_ts=?").run(row.source_ts);db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   return;
  }
  let stored=db.prepare('SELECT * FROM slack_staged_bundles WHERE request_id=?').get(row.request_id);
  permitSubmission(db,config,row,stored);
  requireThat(!db.prepare("SELECT 1 FROM slack_submission_events WHERE request_id=? AND hash!=? AND phase!='fenced'").get(row.request_id,row.hash),'Conflicting original staging evidence requires reconciliation');
  const message=await slack.exactPublish(row.source_ts),original=acceptSubmission(message,config,now,{from:config.slack_submission.activation_ts,to:row.source_ts});
  requireThat(original&&['kind','request_id','hash','file_id','target_ts'].every(k=>(original[k]??null)===row[k]),'Original staging command changed');
  if(controlledDate(config,row.request_id))requireThat(original.permit_id===db.prepare('SELECT permit_id FROM research_control_submissions WHERE source_ts=?').get(row.source_ts)?.permit_id,'Original publication permit changed');
  if(row.kind==='stage'){
   const bytes=await slack.download(row),bundle=await decodeBundle(bytes);
   requireThat(bundle.data.request_id===row.request_id&&bundle.hash===row.hash&&bundle.report.date===date,'Staged bundle binding differs');
   if(stored){requireThat(stored.hash===row.hash&&stored.report_date===date&&Buffer.from(stored.bytes).equals(bytes),'Original staged bytes cannot change');}
   else{
    requireThat(!db.prepare('SELECT 1 FROM slack_staged_bundles WHERE report_date=?').get(date),'Date already staged');
    await emptyDay(state,config,row,date,query,clock);
   }
   db.exec('BEGIN IMMEDIATE');try{
    const authority=permitSubmission(db,config,row,stored);
    if(!stored)db.prepare('INSERT INTO slack_staged_bundles(request_id,report_date,hash,source_ts,file_id,bytes) VALUES(?,?,?,?,?,?)').run(row.request_id,date,row.hash,row.source_ts,row.file_id,bytes);
    settlePermitSubmission(db,authority,row,bytes.length);
    db.prepare("UPDATE slack_submission_events SET phase='done',diagnostic=NULL,next_at=0 WHERE source_ts=?").run(row.source_ts);db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
  }else{
   requireThat(stored&&stored.hash===row.hash&&stored.source_ts===row.target_ts&&stored.report_date===date,'Submission requires original staged bytes');
   const bytes=Buffer.from(stored.bytes),bundle=await decodeBundle(bytes);
   requireThat(bundle.hash===stored.hash&&bundle.report.date===date&&bundle.data.request_id===row.request_id,'Original staged bytes changed');
   const prior=state.metadata(row.request_id);
   if(prior)requireThat(stored.phase==='admitted'&&prior.hash===stored.hash&&prior.source_ts===stored.source_ts&&prior.detail.intake_file_id===stored.file_id,'Original publication conflicts with staging');
   else{requireThat(stored.phase==='staged','Original staged admission missing');await emptyDay(state,config,row,date,query,clock);}
   db.exec('BEGIN IMMEDIATE');try{
    const authority=permitSubmission(db,config,row,stored);
    if(!prior){
     const job=state.admit({request_id:row.request_id,hash:stored.hash,source_ts:stored.source_ts,file_id:stored.file_id},bytes);
     state.move(job.id,'received','received',{...job.detail,intake_transport:'slack_staged_file_v1',submission_source_ts:row.source_ts});
     db.prepare("UPDATE slack_staged_bundles SET phase='admitted',submit_ts=? WHERE request_id=?").run(row.source_ts,row.request_id);
    }
    settlePermitSubmission(db,authority,row,bytes.length);
    db.prepare("UPDATE slack_submission_events SET phase='done',diagnostic=NULL,next_at=0 WHERE source_ts=?").run(row.source_ts);db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
  }
 }catch(error){
  if(error.researchPublicationRejection){
   const diagnostic={stage:'research_publication',code:error.researchPublicationRejection,outcome:'rejected'};
   db.prepare("UPDATE slack_submission_events SET phase='fenced',next_at=0,diagnostic=? WHERE source_ts=?").run(JSON.stringify(diagnostic),row.source_ts);return;
  }
  const diagnostic=safeDiagnostic(error,'slack_submission','not_started'),attempts=Math.min(row.attempts+1,1000000);
  db.prepare('UPDATE slack_submission_events SET attempts=?,next_at=?,diagnostic=? WHERE source_ts=?').run(attempts,Math.max(now+recoveryDelay(attempts),diagnostic.retry_at??0),JSON.stringify(diagnostic),row.source_ts);
  return {request_id:row.request_id,source_ts:row.source_ts,...diagnostic};
 }
}
async function emptyDay(state,config,row,date,query,clock){
 const result=await producerInspection(state,config,{kind:'inspect',query_id:randomUUID(),request_id:row.request_id,report_date:date,bundle_sha256:row.hash},row.source_ts,query,clock,{stagedRequest:row.request_id});
 requireThat(result.publisher===null&&result.publisher_day.length===0&&result.scheduler===null&&result.scheduler_day_claim===null,'Original date is occupied');
}
