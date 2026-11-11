import {assertFence,assertFencedEnvelope,consumeFencedEnvelope} from './producer-admission-fence.mjs';
import {assertSubmission,acceptSubmission,queueSubmission} from './slack-submission.mjs';
import {assertResearchArchive,acceptResearchArchive,queueResearchArchive} from './research-archive.mjs';
import {assertResearchControl} from './research-control.mjs';
import {acceptResearchControl,queueResearchControl} from './research-control-inbox.mjs';
// Durable discovery is separate from publication and delivery. A scan records
// authenticated envelopes before advancing its watermark; file reads can then
// retry without expiring or blocking discovery of later reports.
import {acceptQueuedPublish,acceptReportStatus,acceptProducerInspect,acceptProducerDay,decodeBundle,requireThat} from './report-handoff.mjs';
import {dayCommand} from './producer-day.mjs';
import {installScheduledTables} from './scheduled-delivery-state.mjs';
import {scopeDigest} from './handoff-state.mjs';
import {safeDiagnostic,recoveryDelay} from './handoff-recovery.mjs';

import {installIntakeTables} from './publisher-intake-state.mjs';

const TS=/^\d{10}\.\d{6}$/;
export function validateIntakeConfig(config){
 requireThat(config&&Object.keys(config).join()==='not_before'&&TS.test(config.not_before),'Explicit durable intake boundary required');
 return config;
}
export function intakeStatus(db,requestId){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publisher_inbox'").get())return null;
 const row=db.prepare("SELECT source_ts,file_id,hash,phase,attempts,next_at,diagnostic FROM publisher_inbox WHERE request_id=? ORDER BY source_ts LIMIT 1").get(requestId);
 return row?{...row,diagnostic:row.diagnostic?JSON.parse(row.diagnostic):null}:null;
}
export class PublisherInbox{
 constructor(state,config){
  this.state=state;this.db=state.db;this.config=config;
  assertFence(this.db,config.producer_fence);
  assertSubmission(this.db,config);
  assertResearchArchive(this.db,config);
  assertResearchControl(this.db,config);
  const boundary=validateIntakeConfig(config.durable_intake).not_before;
  installIntakeTables(this.db);
  const scope=scopeDigest({not_before:boundary,team_id:config.team_id,channel_id:config.channel_id,sender_user_id:config.sender_user_id,sender_bot_id:config.sender_bot_id??null,sender_app_id:config.sender_app_id??null,sender_user_app_id:config.sender_user_app_id??null,sender_attribution_text:config.sender_attribution_text??null});
  this.db.prepare('INSERT OR IGNORE INTO publisher_intake_scan VALUES (1,?,?,NULL,NULL)').run(scope,boundary);
  requireThat(this.db.prepare('SELECT scope FROM publisher_intake_scan WHERE id=1').get().scope===scope,'Durable intake scope changed; reconcile first');
 }
 async scan(slack,now=Date.now()){
  let scan=this.db.prepare('SELECT * FROM publisher_intake_scan WHERE id=1').get();
  if(scan.upper_bound===null){
   const upper=(now/1000).toFixed(6);
   requireThat(TS.test(upper),'Canonical intake clock required');
   if(upper<scan.watermark)return {page_complete:true,discovered:0,rejected:[]};
   this.db.prepare('UPDATE publisher_intake_scan SET upper_bound=? WHERE id=1').run(upper);
   scan={...scan,upper_bound:upper};
  }
  let page;
  try{page=await slack.historyPage({from:scan.watermark,to:scan.upper_bound,cursor:scan.page_cursor});}
  catch(error){
   if(error?.diagnostic?.stage==='slack.conversations.history'&&error?.diagnostic?.code==='invalid_cursor'){
    // Restart the same fixed range, never jump to now. Already discovered
    // envelopes are idempotent; an expired provider cursor cannot lose them.
    this.db.prepare('UPDATE publisher_intake_scan SET page_cursor=NULL WHERE id=1').run();
   }
   throw error;
  }
  requireThat(Array.isArray(page.messages)&&page.messages.length<=100&&(page.next_cursor===null||typeof page.next_cursor==='string'&&page.next_cursor.length>0&&page.next_cursor.length<=1024)&&(page.next_cursor===null||page.next_cursor!==scan.page_cursor),'Invalid intake pagination');
  const events=[],reads=[],submissions=[],research=[],control=[],rejected=[];
  for(const message of page.messages){
   requireThat(TS.test(message?.ts??'')&&message.ts>=scan.watermark&&message.ts<=scan.upper_bound,'History page outside durable range');
   if(this.config.research_control&&message?.text?.startsWith('!ai-research control v2 ')){
    try{const event=acceptResearchControl(message,this.config,now,{from:this.config.research_control.activation_ts,to:scan.upper_bound});if(event)control.push(event);}
    catch(error){rejected.push({source_ts:message.ts,...safeDiagnostic(error,'research_control','not_started')});}
    continue;
   }
   if(this.config.research_archive&&message?.text?.startsWith('!ai-research ')){
    try{const event=acceptResearchArchive(message,this.config,now,{from:this.config.research_archive.activation_ts,to:scan.upper_bound});if(event)research.push(event);}
    catch(error){rejected.push({source_ts:message.ts,...safeDiagnostic(error,'research_command','not_started')});}
    continue;
   }
   if(this.config.slack_submission&&/^!ai-report (?:stage|submit)(?:-v2)? /.test(message?.text??'')){
    try{const event=acceptSubmission(message,this.config,now,{from:this.config.slack_submission.activation_ts,to:scan.upper_bound});if(event)submissions.push(event);}
    catch(error){rejected.push({source_ts:message.ts,...safeDiagnostic(error,'staging_command','not_started')});}
    continue;
   }
   if(this.config.scheduled_delivery&&(message?.text?.startsWith('!ai-report inspect ')||message?.text?.startsWith('!ai-report day ')||message?.text?.startsWith('!ai-report status '))){
    try{const range={from:this.config.durable_intake.not_before,to:scan.upper_bound};reads.push(acceptReportStatus(message,this.config,now,range)??acceptProducerInspect(message,this.config,now,range)??acceptProducerDay(message,this.config,now,range));}
    catch(error){rejected.push({source_ts:message.ts,...safeDiagnostic(error,'intake_read_command','not_started')});}
    continue;
   }
   if(!message?.text?.startsWith('!ai-report publish '))continue;
   try{events.push(acceptQueuedPublish(message,this.config,{from:this.config.durable_intake.not_before,to:scan.upper_bound},now));}
   catch(error){rejected.push({source_ts:message.ts,...safeDiagnostic(error,'intake_message','not_started')});}
  }
  if(reads.length)installScheduledTables(this.db,['scheduled_status_replies']);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   for(const event of submissions)queueSubmission(this.db,event);
   for(const event of research){const refusal=queueResearchArchive(this.db,event);if(refusal)rejected.push(refusal);}
   for(const event of control){const refusal=queueResearchControl(this.db,event);if(refusal)rejected.push(refusal);}
   for(const event of events){
    const prior=this.db.prepare('SELECT request_id,file_id,hash FROM publisher_inbox WHERE source_ts=?').get(event.source_ts);
    if(prior){requireThat(prior.request_id===event.request_id&&prior.file_id===event.file_id&&prior.hash===event.hash,'Original intake envelope changed');continue;}
    requireThat(this.db.prepare('SELECT count(*) AS n FROM publisher_inbox').get().n<10000,'Durable intake capacity reached');
    this.db.prepare('INSERT INTO publisher_inbox(source_ts,request_id,file_id,hash) VALUES (?,?,?,?)').run(event.source_ts,event.request_id,event.file_id,event.hash);
   }
   // Read commands and their scan checkpoint commit together. Restarts after
   // long outages must not strand an authenticated original query.
   for(const event of reads){
    const prior=this.db.prepare('SELECT hash FROM scheduled_status_replies WHERE source_ts=?').get(event.source_ts);
    if(prior){requireThat(prior.hash===event.hash,'Original read command changed');continue;}
    requireThat(this.db.prepare('SELECT count(*) AS n FROM scheduled_status_replies').get().n<10000,'Read command capacity reached');
    const command=event.kind==='day'?dayCommand({kind:'day',request_id:event.request_id,report_date:event.report_date,query_id:event.query_id}):event.kind==='inspect'?{kind:event.kind,request_id:event.request_id,report_date:event.report_date,bundle_sha256:event.bundle_sha256,query_id:event.query_id}:{request_id:event.request_id};
    this.db.prepare("INSERT INTO scheduled_status_replies(source_ts,hash,phase,text,reply_ts) VALUES (?,?,'queued',?,NULL)").run(event.source_ts,event.hash,JSON.stringify(command));
   }
   if(page.next_cursor)this.db.prepare('UPDATE publisher_intake_scan SET page_cursor=? WHERE id=1').run(page.next_cursor);
   else this.db.prepare('UPDATE publisher_intake_scan SET watermark=upper_bound,upper_bound=NULL,page_cursor=NULL WHERE id=1').run();
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  return {page_complete:page.next_cursor===null,discovered:events.length,read_commands:reads.length,rejected:rejected.slice(0,16)};
 }
 async admitOne(slack,now=Date.now()){
  const row=this.db.prepare("SELECT * FROM publisher_inbox WHERE phase='pending' AND next_at<=? ORDER BY last_attempt,source_ts LIMIT 1").get(now);
  if(!row)return;
  this.db.prepare('UPDATE publisher_inbox SET last_attempt=? WHERE source_ts=?').run(now,row.source_ts);
  const event={source_ts:row.source_ts,request_id:row.request_id,file_id:row.file_id,hash:row.hash};
  try{
   assertFencedEnvelope(this.state,this.config.producer_fence,event);
   const prior=this.state.metadata(row.request_id);
   if(prior){
    requireThat(prior.source_ts===row.source_ts&&prior.hash===row.hash,'Original admitted request conflicts with intake');
   }else{
    const message=await slack.exactPublish(row.source_ts);
    const reread=acceptQueuedPublish(message,this.config,{from:this.config.durable_intake.not_before,to:row.source_ts},now);
    requireThat(reread&&Object.keys(event).every(key=>reread[key]===event[key]),'Original publish message changed');
    const bytes=await slack.download(event),bundle=await decodeBundle(bytes);
    requireThat(bundle.data.request_id===row.request_id&&bundle.hash===row.hash,'Original publish bundle mismatch');
    consumeFencedEnvelope(this.state,this.config.producer_fence,event,bundle.report.date);
    this.state.admit(event,bytes);
   }
   this.db.prepare("UPDATE publisher_inbox SET phase='admitted',next_at=0,diagnostic=NULL WHERE source_ts=?").run(row.source_ts);
  }catch(error){
   if(error.code==='producer_upload_fenced'){
    this.db.prepare("UPDATE publisher_inbox SET phase='fenced',diagnostic=? WHERE source_ts=? AND phase='pending'").run(JSON.stringify({stage:'producer_fence',code:'producer_upload_fenced',outcome:'not_admitted'}),row.source_ts);
    return {request_id:row.request_id,source_ts:row.source_ts,code:'producer_upload_fenced'};
   }
   const attempts=Math.min(row.attempts+1,1000000),diagnostic=safeDiagnostic(error,'intake_file','not_started');
   this.db.prepare('UPDATE publisher_inbox SET attempts=?,next_at=?,diagnostic=? WHERE source_ts=?').run(attempts,Math.max(now+recoveryDelay(attempts),diagnostic.retry_at??0),JSON.stringify(diagnostic),row.source_ts);
   return {request_id:row.request_id,source_ts:row.source_ts,...diagnostic};
  }
 }
 pending(){
  return this.db.prepare("SELECT source_ts,request_id,file_id,hash,phase,attempts,next_at,diagnostic FROM publisher_inbox WHERE phase='pending' ORDER BY source_ts LIMIT 16").all().map(row=>({...row,diagnostic:row.diagnostic?JSON.parse(row.diagnostic):null}));
 }
}
