// Optional Publisher -> fixed relay socket client. Admission is idempotent and
// never itself sends; an uncertain response is followed only by original-ID status.
import {spawn} from 'node:child_process';
import {scopeDigest} from './handoff-state.mjs';
import {installScheduledTables} from './scheduled-delivery-state.mjs';
import {decodeBundle,requireThat,REQUEST} from './report-handoff.mjs';
import {validateCheckerConfig} from './notice-checker.mjs';
import {safeDiagnostic,isSlackWriteUnexecuted} from './handoff-recovery.mjs';
import {producerInspection,inspectCommand,INSPECT_PREFIX} from './producer-inspect.mjs';
import {inspectDay,dayCommand,DAY_PREFIX} from './producer-day.mjs';
import {intakeStatus} from './publisher-inbox.mjs';
import {submissionStatus} from './slack-submission.mjs';
export function statusImages(value){
 if(value===undefined)return [];
 requireThat(Array.isArray(value)&&value.length<=32,'Bounded image receipts required');
 return value.map(image=>{
  requireThat(image&&typeof image.file_id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(image.file_id)&&['pending','sending','sent','failed','unknown'].includes(image.status),'Invalid image receipt');
  return {file_id:image.file_id,status:image.status,error:image.error==null?null:typeof image.error==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(image.error)?image.error:'unspecified'};
 });
}
export function validateScheduledConfig(c){
 requireThat(c&&Object.keys(c).sort().join()==='activation_date,args,executable'&&/^\d{4}-\d\d-\d\d$/.test(c.activation_date)&&new Date(c.activation_date+'T00:00:00Z').toISOString().slice(0,10)===c.activation_date,'Explicit scheduler activation boundary required');
 validateCheckerConfig({args:c.args,executable:c.executable});return c;
}
export function scheduledQueryBudget(request){
 requireThat(request&&['admit','status','inspect'].includes(request.action),'Known scheduled action required');
 return request.action==='admit'?180000:10000;
}
export function queryScheduled(config,request){
 validateScheduledConfig(config);const budget=scheduledQueryBudget(request),bytes=Buffer.from(JSON.stringify(request));
 requireThat(bytes.length<=12*1024*1024,'Bounded scheduling request required');
 return new Promise((resolve,reject)=>{
  const child=spawn(config.executable,config.args,{shell:false,stdio:['pipe','pipe','ignore'],env:{LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'}});
  const parts=[];let size=0,done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(error);}else resolve(value);};
  const timer=setTimeout(()=>finish(Error('Scheduled endpoint timeout')),budget);
  child.on('error',()=>finish(Error('Scheduled endpoint unavailable')));child.stdin.on('error',()=>finish(Error('Scheduled endpoint input unresolved')));
  child.stdout.on('data',part=>{size+=part.length;if(size>16384)finish(Error('Scheduled endpoint result too large'));else parts.push(part);});
  child.on('close',code=>{try{requireThat(code===0,'Scheduled endpoint rejected');const result=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(parts)));finish(null,result);}catch{finish(Error('Scheduled endpoint outcome unresolved'));}});
  child.stdin.end(bytes);
 });
}
export async function advanceScheduledDelivery(state,config,query=queryScheduled){
 const c=validateScheduledConfig(config.scheduled_delivery),db=state.db;
 installScheduledTables(db,['scheduled_handoffs','scheduled_bridge_scope']);
 const scope=scopeDigest(c);db.prepare('INSERT OR IGNORE INTO scheduled_bridge_scope VALUES (1,?)').run(scope);
 requireThat(db.prepare('SELECT value FROM scheduled_bridge_scope WHERE id=1').get().value===scope,'Scheduled bridge scope changed; reconcile first');
 const candidates=db.prepare("SELECT j.id FROM jobs j LEFT JOIN scheduled_handoffs h ON h.request_id=j.id WHERE j.phase IN ('verified','sending','receipt_unknown','receipt_sent') ORDER BY CASE WHEN h.request_id IS NULL THEN 0 ELSE 1 END, COALESCE(h.poll_order,0),j.source_ts").all();
 for(const {id}of candidates){
  const job=state.get(id),bundle=await decodeBundle(job.bytes);
  if(bundle.report.date<c.activation_date)continue;
  requireThat(job.detail.proof?.publication_status==='verified'&&job.detail.proof.bundle_sha256===job.hash&&job.detail.proof.commit===job.detail.commit,'Actual published source required before scheduling');
  const binding=JSON.stringify({request_id:id,report_date:bundle.report.date,report_commit:job.detail.commit,bundle_sha256:job.hash});
  let local=db.prepare('SELECT * FROM scheduled_handoffs WHERE request_id=?').get(id);
  if(local){requireThat(local.binding===binding,'Scheduled original binding differs');if(['complete','skipped','superseded'].includes(local.phase))continue;}
  else{db.prepare("INSERT INTO scheduled_handoffs VALUES (?,?,'new',NULL,0)").run(id,binding);local={phase:'new'};}
  // New reports first, then persistent round-robin. An old unknown job may
  // remain unresolved forever without starving later dates or disappearing.
  db.prepare('UPDATE scheduled_handoffs SET poll_order=(SELECT COALESCE(MAX(poll_order),0)+1 FROM scheduled_handoffs) WHERE request_id=?').run(id);
  try{
   let result=await query(c,{action:'status',request_id:id});
   if(result?.status==='not_found'){
    // Same original bytes and ID only. The receiver transaction makes admission
    // idempotent; it cannot duplicate sends or replace an earlier binding.
    db.prepare("UPDATE scheduled_handoffs SET phase='admission_pending' WHERE request_id=?").run(id);
    result=await query(c,{action:'admit',request_id:id,report_commit:job.detail.commit,bundle_base64:job.bytes.toString('base64')});
   }
   const expected=JSON.parse(binding);
   const revised=!!bundle.report.revision_notice;
   requireThat(result&&Object.entries(expected).every(([k,v])=>result[k]===v)&&['queued','sending','sent','failed','unknown','partial',...(revised?['skipped']:[])].includes(result.status)&&Number.isSafeInteger(result.parts_total)&&result.parts_total>=(revised?0:1)&&Number.isSafeInteger(result.parts_sent)&&result.parts_sent>=0&&result.parts_sent<=result.parts_total,'Relay status binding/counts differ');
   if(revised)requireThat(result.report_revision===bundle.report.revision&&['initial','revision_update','web_only'].includes(result.delivery_kind),'Revision delivery policy binding differs');
   const images=statusImages(result.images);
   const full=images.length===1&&images[0].file_id==='scheduled-poster'&&images[0].status==='sent'&&images[0].error===null;
   const complete=result.status==='sent'&&result.phase==='complete'&&result.parts_sent===result.parts_total&&(revised&&result.delivery_kind==='revision_update'?result.parts_total===1&&images.length===0:(!revised||result.delivery_kind==='initial')&&full);
   const skipped=revised&&result.delivery_kind==='web_only'&&result.phase==='skipped'&&result.status==='skipped'&&result.parts_total===0&&images.length===0;
   requireThat(result.status!=='skipped'||skipped,'Website-only update is not a sent message');
   requireThat(result.status!=='sent'||complete,'Incomplete delivery cannot be sent');
   if(result.phase==='superseded')requireThat(result.status!=='sent'&&result.parts_sent<result.parts_total&&/^morning-\d{8}-r(?:[2-9]|[1-9]\d+)$/.test(result.superseded_by??'')&&result.superseded_by.startsWith(`morning-${bundle.report.date.replaceAll('-','')}-r`),'Supersession requires a bound same-day successor');
   const phase=complete?'complete':skipped?'skipped':result.phase==='superseded'?'superseded':'observed';
   db.prepare('UPDATE scheduled_handoffs SET phase=?,result=? WHERE request_id=?').run(phase,JSON.stringify(result),id);
   return {request_id:id,phase,wecom_status:complete?'sent':result.status,parts_sent:result.parts_sent,parts_total:result.parts_total};
  }catch(error){
   // Do not stop publication or reissue a send. Next tick queries original ID.
   const diagnostic=safeDiagnostic(error,'scheduled_delivery');
   db.prepare('UPDATE scheduled_handoffs SET result=? WHERE request_id=?').run(JSON.stringify({request_id:id,diagnostic}),id);
   return {request_id:id,phase:'reconcile_pending',wecom_status:'not_verified',diagnostic};
  }
 }
 return {phase:'idle'};
}
export async function advanceScheduledStatus(state,config,events,slack,query=queryScheduled){
 if(!events.length&&!state.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_status_replies'").get())return;
 installScheduledTables(state.db,['scheduled_status_replies']);
 // Admit authenticated requests before the separately bounded query/send lane.
 // Both unsent and uncertain responses survive expiry of the intake window.
 for(const event of events)admitStatus(state.db,event);
 const event=state.db.prepare("SELECT source_ts,hash FROM scheduled_status_replies WHERE phase IN ('queued','ready','sending','unknown') ORDER BY poll_order,source_ts LIMIT 1").get();
 if(event){
  state.db.prepare('UPDATE scheduled_status_replies SET poll_order=(SELECT COALESCE(MAX(poll_order),0)+1 FROM scheduled_status_replies) WHERE source_ts=?').run(event.source_ts);
  await replyScheduledStatus(state,config,event,slack,query);
 }
}
function admitStatus(db,event){
 const prior=db.prepare('SELECT * FROM scheduled_status_replies WHERE source_ts=?').get(event.source_ts);
 if(prior){requireThat(prior.hash===event.hash,'Status source changed');return prior;}
 requireThat(REQUEST.test(event.request_id??''),'Status request identity required');
 db.prepare("INSERT INTO scheduled_status_replies(source_ts,hash,phase,text,reply_ts) VALUES (?,?,'queued',?,NULL)").run(event.source_ts,event.hash,JSON.stringify(event.kind==='day'?dayCommand({kind:'day',request_id:event.request_id,report_date:event.report_date,query_id:event.query_id}):event.kind==='inspect'?inspectCommand({kind:event.kind,request_id:event.request_id,report_date:event.report_date,bundle_sha256:event.bundle_sha256,query_id:event.query_id}):{request_id:event.request_id}));
 return db.prepare('SELECT * FROM scheduled_status_replies WHERE source_ts=?').get(event.source_ts);
}
export async function replyScheduledStatus(state,config,event,slack,query=queryScheduled){
 const db=state.db;
 installScheduledTables(db,['scheduled_status_replies']);
 let prior=admitStatus(db,event);
 if(prior.phase==='unknown'||prior.phase==='sending'){
   // Reconcile the original thread reply; never repost an unknown write.
   const found=await slack.findControlReceipt(event.source_ts,prior.text);
   if(found)db.prepare("UPDATE scheduled_status_replies SET phase='sent',reply_ts=? WHERE source_ts=?").run(found,event.source_ts);
  return;
 }
 if(prior.phase==='sent')return;
 const snapshotPrefix=[INSPECT_PREFIX,DAY_PREFIX].find(prefix=>prior.text.startsWith(prefix));
 if(prior.phase==='ready'&&snapshotPrefix){
  const old=JSON.parse(prior.text.slice(snapshotPrefix.length));
  if(!Number.isSafeInteger(old.observed_at)||old.observed_at<Date.now()-60000){
   const command=snapshotPrefix===DAY_PREFIX?dayCommand({kind:'day',request_id:old.request_id,report_date:old.report_date,query_id:old.query_id}):inspectCommand({kind:'inspect',request_id:old.request_id,report_date:old.report_date,bundle_sha256:old.bundle_sha256,query_id:old.query_id});
   db.prepare("UPDATE scheduled_status_replies SET phase='queued',text=? WHERE source_ts=? AND phase='ready'").run(JSON.stringify(command),event.source_ts);
   prior=db.prepare('SELECT * FROM scheduled_status_replies WHERE source_ts=?').get(event.source_ts);
  }
 }
 if(prior.phase==='queued'){
 const command=JSON.parse(prior.text);
 if(['inspect','day'].includes(command.kind)){
  const result=command.kind==='day'?await inspectDay(state,config,command,event.source_ts,query):await producerInspection(state,config,command,event.source_ts,query);
  const text=(command.kind==='day'?DAY_PREFIX:INSPECT_PREFIX)+JSON.stringify(result);
  requireThat(Buffer.byteLength(text)<=32768,'Bounded inspect receipt required');
  db.prepare("UPDATE scheduled_status_replies SET phase='ready',text=? WHERE source_ts=? AND phase='queued'").run(text,event.source_ts);
 }else{

 requireThat(command&&Object.keys(command).join()==='request_id'&&REQUEST.test(command.request_id??''),'Stored status command changed');
 const requestId=command.request_id;
 const remote=await query(config.scheduled_delivery,{action:'status',request_id:requestId});
 requireThat(remote&&['not_found','queued','sending','sent','failed','unknown','partial','skipped'].includes(remote.status),'Status unavailable');
 if(remote.status!=='not_found')requireThat(remote.request_id===requestId,'Status request differs');
 const job=state.metadata(requestId);
 if(job?.detail.commit&&remote.status!=='not_found')requireThat(remote.report_commit===job.detail.commit&&remote.bundle_sha256===job.hash,'Status original binding differs');
 const fields=['status','phase','report_date','report_commit','bundle_sha256','parts_sent','parts_total','next_attempt_at','attempts','delivery_kind','report_revision'];
 const result=Object.fromEntries(fields.filter(k=>Object.hasOwn(remote,k)).map(k=>[k,remote[k]]));
 if(remote.phase==='superseded'){
  requireThat(typeof remote.report_date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(remote.report_date)&&new RegExp('^morning-'+remote.report_date.replaceAll('-','')+'-r(?:[2-9]|[1-9][0-9]+)$').test(remote.superseded_by??''),'Status successor binding differs');
  result.superseded_by=remote.superseded_by;
 }
 if(remote.last_error!=null)result.last_error=typeof remote.last_error==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(remote.last_error)?remote.last_error:'unspecified';
 if(remote.images!==undefined)result.images=statusImages(remote.images);
   const intake=intakeStatus(db,requestId);
   result.publisher_phase=job?.phase??(intake?'intake_pending':'not_found');
   if(intake&&!job)result.publisher_intake=intake;
   if(config.slack_submission){
    const submission=submissionStatus(db,requestId);
    result.publisher_submission=submission;
    if(!job&&(submission?.bundle||submission?.pending.length))result.publisher_phase=submission.bundle?'staged':'staging_pending';
   }
 if(job){
  result.publisher_bundle_sha256=job.hash;
  result.publisher_source_ts=job.source_ts;
  if(job.detail.recovery?.last_error)result.publisher_diagnostic=safeDiagnostic({diagnostic:job.detail.recovery.last_error},'publisher');
  if(job.detail.recovery?.next_at)result.publisher_next_attempt_at=job.detail.recovery.next_at;
 }
 const text='!ai-report status-receipt '+JSON.stringify({request_id:requestId,source_ts:event.source_ts,...result});
 requireThat(Buffer.byteLength(text)<=16384,'Bounded status receipt required');
 db.prepare("UPDATE scheduled_status_replies SET phase='ready',text=? WHERE source_ts=? AND phase='queued'").run(text,event.source_ts);
 }
 prior=db.prepare('SELECT * FROM scheduled_status_replies WHERE source_ts=?').get(event.source_ts);
 }
 requireThat(prior.phase==='ready','Unexpected status reply phase');
 // Defer before durable intent; no HTTP call has occurred during a cooldown.
 slack.assertReady?.('chat.postMessage');
 const inserted=db.prepare("UPDATE scheduled_status_replies SET phase='sending' WHERE source_ts=? AND phase='ready'").run(event.source_ts);
 if(!inserted.changes)return;
 try{
  const ts=await slack.controlReceipt(event.source_ts,prior.text);requireThat(/^\d{10}\.\d{6}$/.test(ts),'Receipt timestamp missing');
  db.prepare("UPDATE scheduled_status_replies SET phase='sent',reply_ts=? WHERE source_ts=?").run(ts,event.source_ts);
 }catch(error){
  // A concurrent quota update can land between the precheck and adapter call.
  // This in-process proof preserves our original never-attempted response.
  if(isSlackWriteUnexecuted(error)){db.prepare("UPDATE scheduled_status_replies SET phase='ready' WHERE source_ts=? AND phase='sending'").run(event.source_ts);throw error;}
  db.prepare("UPDATE scheduled_status_replies SET phase='unknown' WHERE source_ts=?").run(event.source_ts);
 }
}
