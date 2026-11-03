// Optional Publisher -> fixed relay socket client. Admission is idempotent and
// never itself sends; an uncertain response is followed only by original-ID status.
import {spawn} from 'node:child_process';
import {scopeDigest} from './handoff-state.mjs';
import {installScheduledTables} from './scheduled-delivery-state.mjs';
import {decodeBundle,requireThat} from './report-handoff.mjs';
import {validateCheckerConfig} from './notice-checker.mjs';
export function validateScheduledConfig(c){
 requireThat(c&&Object.keys(c).sort().join()==='activation_date,args,executable'&&/^\d{4}-\d\d-\d\d$/.test(c.activation_date)&&new Date(c.activation_date+'T00:00:00Z').toISOString().slice(0,10)===c.activation_date,'Explicit scheduler activation boundary required');
 validateCheckerConfig({args:c.args,executable:c.executable});return c;
}
export function queryScheduled(config,request){
 validateScheduledConfig(config);const bytes=Buffer.from(JSON.stringify(request));
 requireThat(bytes.length<=12*1024*1024,'Bounded scheduling request required');
 return new Promise((resolve,reject)=>{
  const child=spawn(config.executable,config.args,{shell:false,stdio:['pipe','pipe','ignore'],env:{LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'}});
  const parts=[];let size=0,done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(error);}else resolve(value);};
  const timer=setTimeout(()=>finish(Error('Scheduled endpoint timeout')),180000);
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
  if(local){requireThat(local.binding===binding,'Scheduled original binding differs');if(local.phase==='complete')continue;}
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
   requireThat(result&&Object.entries(expected).every(([k,v])=>result[k]===v)&&['queued','sending','sent','failed','unknown','partial'].includes(result.status)&&Number.isSafeInteger(result.parts_total)&&result.parts_total>0&&Number.isSafeInteger(result.parts_sent)&&result.parts_sent>=0&&result.parts_sent<=result.parts_total,'Relay status binding/counts differ');
   const complete=result.status==='sent'&&result.phase==='complete'&&result.parts_sent===result.parts_total;
   requireThat(result.status!=='sent'||complete,'Incomplete delivery cannot be sent');
   db.prepare('UPDATE scheduled_handoffs SET phase=?,result=? WHERE request_id=?').run(complete?'complete':'observed',JSON.stringify(result),id);
   return {request_id:id,phase:complete?'complete':'observed',wecom_status:complete?'sent':result.status,parts_sent:result.parts_sent,parts_total:result.parts_total};
  }catch{
   // Do not stop publication or reissue a send. Next tick queries original ID.
   return {request_id:id,phase:'reconcile_pending',wecom_status:'not_verified'};
  }
 }
 return {phase:'idle'};
}
export async function advanceScheduledStatus(state,config,events,slack,query=queryScheduled){
 if(!events.length&&!state.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_status_replies'").get())return;
 installScheduledTables(state.db,['scheduled_status_replies']);
 const phase=event=>state.db.prepare('SELECT phase FROM scheduled_status_replies WHERE source_ts=?').get(event.source_ts)?.phase;
 // A durable uncertain reply outlives the authenticated intake window. Use its
 // original text and thread only; no expired command gains a new write.
 const pending=state.db.prepare("SELECT source_ts,hash FROM scheduled_status_replies WHERE phase IN ('sending','unknown') ORDER BY poll_order,source_ts LIMIT 1").get();
 const event=events.find(event=>phase(event)===undefined)??pending;
 if(event){
  state.db.prepare('UPDATE scheduled_status_replies SET poll_order=(SELECT COALESCE(MAX(poll_order),0)+1 FROM scheduled_status_replies) WHERE source_ts=?').run(event.source_ts);
  await replyScheduledStatus(state,config,event,slack,query);
 }
}
export async function replyScheduledStatus(state,config,event,slack,query=queryScheduled){
 const db=state.db;
 installScheduledTables(db,['scheduled_status_replies']);
 const prior=db.prepare('SELECT * FROM scheduled_status_replies WHERE source_ts=?').get(event.source_ts);
 if(prior){
  requireThat(prior.hash===event.hash,'Status source changed');
  if(prior.phase==='unknown'||prior.phase==='sending'){
   // Reconcile the original thread reply; never repost an unknown write.
   const found=await slack.findControlReceipt(event.source_ts,prior.text);
   if(found)db.prepare("UPDATE scheduled_status_replies SET phase='sent',reply_ts=? WHERE source_ts=?").run(found,event.source_ts);
  }
  return;
 }
 const remote=await query(config.scheduled_delivery,{action:'status',request_id:event.request_id});
 requireThat(remote&&['not_found','queued','sending','sent','failed','unknown','partial'].includes(remote.status),'Status unavailable');
 if(remote.status!=='not_found')requireThat(remote.request_id===event.request_id,'Status request differs');
 const fields=['status','phase','report_date','report_commit','bundle_sha256','parts_sent','parts_total','next_attempt_at','attempts','last_error'];
 const result=Object.fromEntries(fields.filter(k=>Object.hasOwn(remote,k)).map(k=>[k,remote[k]]));
 const text='!ai-report status-receipt '+JSON.stringify({request_id:event.request_id,source_ts:event.source_ts,...result});
 requireThat(Buffer.byteLength(text)<=16384,'Bounded status receipt required');
 const inserted=db.prepare("INSERT OR IGNORE INTO scheduled_status_replies(source_ts,hash,phase,text,reply_ts) VALUES (?,?,'sending',?,NULL)").run(event.source_ts,event.hash,text);
 if(!inserted.changes)return;
 try{
  const ts=await slack.controlReceipt(event.source_ts,text);requireThat(/^\d{10}\.\d{6}$/.test(ts),'Receipt timestamp missing');
  db.prepare("UPDATE scheduled_status_replies SET phase='sent',reply_ts=? WHERE source_ts=?").run(ts,event.source_ts);
 }catch{db.prepare("UPDATE scheduled_status_replies SET phase='unknown' WHERE source_ts=?").run(event.source_ts);}
}
