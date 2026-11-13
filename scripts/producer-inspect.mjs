import {assertFence,isFencedOut} from './producer-admission-fence.mjs';
// Read-only, authenticated control replies. A complete snapshot is not a claim,
// reservation, or permission to repeat an uncertain upload or delivery.
import {decodeBundle,requireThat,REQUEST,reportDate,canonicalRequestDate,MAX_BUNDLE} from './report-handoff.mjs';
import {scopeDigest,handoffScope} from './handoff-state.mjs';
const QUERY=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/,TS=/^\d{10}\.\d{6}$/;
export const INSPECT_PREFIX='!ai-report inspect-receipt ';
export function inspectCommand(value){
 requireThat(value&&Object.keys(value).sort().join()==='bundle_sha256,kind,query_id,report_date,request_id'&&value.kind==='inspect'&&REQUEST.test(value.request_id)&&reportDate(value.report_date)&&HASH.test(value.bundle_sha256)&&QUERY.test(value.query_id),'Stored inspect command invalid');
 return value;
}
const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export async function inspectPublisherDay(state,config,command,sourceTs,{now=()=>performance.now(),stagedRequest=null}={}){
 inspectCommand(command);requireThat(TS.test(sourceTs),'Inspect source invalid');
 const db=state.db,started=now(),budget=()=>{const elapsed=now()-started;requireThat(Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=45000,'Publisher inspection read budget exceeded');};
 // Keep one read snapshot, but never materialize the historical BLOB set.
 // At most one bounded bundle and its decoded files are live at a time.
 db.exec('BEGIN');
 try{
  assertFence(db,config.producer_fence);
  if(config.producer_fence)requireThat(!db.prepare('SELECT 1 FROM producer_quarantined_dates WHERE report_date=?').get(command.report_date),'Original unresolved date is quarantined');
  for(const staging of ['slack_staged_bundles','research_page_staged'])if(exists(db,staging)){
   const staged=db.prepare(`SELECT request_id,hash,phase,source_ts FROM ${staging} WHERE report_date=? OR request_id=?`).all(command.report_date,command.request_id);
   requireThat(staged.every(s=>s.request_id===command.request_id&&s.hash===command.bundle_sha256&&(s.request_id===stagedRequest||s.phase==='admitted'&&db.prepare('SELECT 1 FROM jobs WHERE id=? AND hash=? AND source_ts=?').get(s.request_id,s.hash,s.source_ts))),'Date reserved by original Slack staging');
  }
  const scope=db.prepare('SELECT value FROM scope WHERE id=1').get()?.value;
  requireThat(scope===scopeDigest(handoffScope(config)),'Publisher inspect scope mismatch');
  const rows=db.prepare('SELECT id,hash,source_ts,length(bytes) AS bundle_size FROM jobs ORDER BY source_ts LIMIT 1001').all();
  requireThat(rows.length<=1000,'Publisher inspect capacity exceeded');
  const inbox=exists(db,'publisher_inbox')?db.prepare("SELECT request_id,hash,file_id,source_ts,phase FROM publisher_inbox WHERE phase!='admitted' LIMIT 10001").all():[];
  requireThat(inbox.length<=10000,'Publisher intake snapshot too large');
  const scan=exists(db,'publisher_intake_scan')?db.prepare('SELECT watermark FROM publisher_intake_scan WHERE id=1').get():null;
  const day=[];let target=null;
  const read=db.prepare('SELECT bytes,detail FROM jobs WHERE id=?');
  for(const row of rows){
   budget();requireThat(Number.isSafeInteger(row.bundle_size)&&row.bundle_size>0&&row.bundle_size<=MAX_BUNDLE,'Publisher original bundle too large');
   const original=read.get(row.id);requireThat(original,'Publisher original record absent');
   const bundle=await decodeBundle(Buffer.from(original.bytes));budget();
   requireThat(bundle.hash===row.hash&&bundle.data.request_id===row.id&&TS.test(row.source_ts),'Publisher original binding invalid');
   const detail=JSON.parse(original.detail);
   if(row.id===command.request_id)requireThat(bundle.report.date===command.report_date&&row.hash===command.bundle_sha256,'Publisher request conflicts with query');
   if(bundle.report.date!==command.report_date)continue;
   requireThat(row.id===command.request_id&&row.hash===command.bundle_sha256||bundle.report.revision_notice&&canonicalRequestDate(row.id)===command.report_date,'Publisher day occupied');
   requireThat(detail.commit===undefined||SHA.test(detail.commit),'Publisher commit invalid');
   requireThat(detail.intake_file_id===undefined||/^F[A-Z0-9]+$/.test(detail.intake_file_id),'Publisher file identity invalid');
   day.push({request_id:row.id,report_date:bundle.report.date,bundle_sha256:row.hash});
   if(row.id===command.request_id)target={...day.at(-1),source_ts:row.source_ts,report_commit:detail.commit??null,file_id:detail.intake_file_id??null};
  }
  budget();requireThat(day.length<=101&&(!day.length||target),'Publisher date ambiguous');
  if(!target){
   // Absence is stronger than request-ID not_found. Relevant messages must be
   // scanned; unresolved envelopes cannot be silently omitted.
   const boundary=config.durable_intake?.not_before,dayStart=Date.parse(command.report_date+'T00:00:00+08:00')/1000;
   requireThat(TS.test(boundary??'')&&Number(boundary)<=dayStart&&scan&&scan.watermark>=sourceTs,'Publisher scan does not prove date absence');
   for(const row of inbox){
    // Retained fenced envelopes are provably ineligible under this installed
    // server gate, not claimed to be unexecuted Slack operations. Revalidate the
    // gate each time; a removed/changed fence or new conflicting grant blocks.
    if(row.phase==='fenced'){requireThat(isFencedOut(state,config.producer_fence,row),'Quarantined envelope is no longer fenced');if(row.source_ts>=config.producer_fence.activation_ts)continue;}
    const date=canonicalRequestDate(row.request_id);
    requireThat(date&&date!==command.report_date&&row.request_id!==command.request_id,'Publisher unresolved intake may occupy date');
   }
  }
  budget();return {publisher_scope_sha256:scope,publisher_day:day,publisher:target};
 }finally{db.exec('ROLLBACK');}
}
export async function producerInspection(state,config,command,sourceTs,query,now=Date.now,localOptions){
 inspectCommand(command);
 const remote=await query(config.scheduled_delivery,{action:'inspect',request_id:command.request_id,report_date:command.report_date});
 requireThat(remote&&Object.keys(remote).sort().join()==='complete,observed_at,read_context,scheduler,scheduler_day_claim'&&remote.complete===true&&Object.keys(remote.read_context??{}).join()==='scheduler_scope_sha256'&&HASH.test(remote.read_context.scheduler_scope_sha256),'Scheduler inspect incomplete');
 requireThat(Number.isSafeInteger(remote.observed_at)&&remote.observed_at<=now()+30000&&remote.observed_at>=now()-60000,'Scheduler inspect stale');
 const claim=remote.scheduler_day_claim,status=remote.scheduler;
 requireThat((claim===null)===(status===null),'Scheduler inspect claim differs');
 const expected={request_id:command.request_id,report_date:command.report_date,bundle_sha256:command.bundle_sha256};
 if(status!==null){
  requireThat(claim&&Object.keys(claim).sort().join()==='bundle_sha256,report_commit,report_date,request_id'&&Object.entries(expected).every(([k,v])=>claim[k]===v&&status[k]===v)&&SHA.test(claim.report_commit)&&claim.report_commit===status.report_commit,'Scheduler inspect binding differs');
  requireThat(['queued','sending','sent','failed','unknown','partial'].includes(status.status)&&typeof status.phase==='string'&&/^[a-z_]{1,40}$/.test(status.phase)&&Number.isSafeInteger(status.parts_total)&&status.parts_total>0&&Number.isSafeInteger(status.parts_sent)&&status.parts_sent>=0&&status.parts_sent<=status.parts_total,'Scheduler inspect status invalid');
 }
 const local=await inspectPublisherDay(state,config,command,sourceTs,localOptions);
 if(status!==null)requireThat(local.publisher&&local.publisher.report_commit===status.report_commit,'Scheduler and publisher binding differs');
 // The wire whitelist must never grow merely because an adapter adds fields.
 const safe=status===null?null:Object.fromEntries(['request_id','report_date','report_commit','bundle_sha256','status','phase','parts_sent','parts_total','next_attempt_at','attempts'].filter(k=>Object.hasOwn(status,k)).map(k=>[k,status[k]]));
 if(safe&&status.images!==undefined){
  requireThat(Array.isArray(status.images)&&status.images.length<=32,'Scheduler image receipts invalid');
  safe.images=status.images.map(image=>{requireThat(image&&image.file_id==='scheduled-poster'&&['pending','sending','sent','failed','unknown'].includes(image.status),'Scheduler image receipt invalid');return {file_id:image.file_id,status:image.status,error:image.error==null?null:typeof image.error==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(image.error)?image.error:'unspecified'};});
 }
 if(safe&&status.last_error!=null)safe.last_error=typeof status.last_error==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(status.last_error)?status.last_error:'unspecified';
 if(safe){
  requireThat(safe.attempts===undefined||safe.attempts===null||Number.isSafeInteger(safe.attempts)&&safe.attempts>=0,'Scheduler attempts invalid');
  // Relay stores Unix seconds as SQLite REAL; fractional backoff times are real
  // evidence, not invalid counters or milliseconds to silently reinterpret.
  requireThat(safe.next_attempt_at===undefined||safe.next_attempt_at===null||typeof safe.next_attempt_at==='number'&&Number.isFinite(safe.next_attempt_at)&&safe.next_attempt_at>=0,'Scheduler attempt time invalid');
 }
 requireThat(remote.observed_at>=now()-60000,'Combined inspect snapshot stale');
 return {...expected,query_id:command.query_id,source_ts:sourceTs,read_context:{publisher_scope_sha256:local.publisher_scope_sha256,...remote.read_context},observed_at:Math.min(remote.observed_at,now()),complete:true,publisher_day:local.publisher_day,publisher:local.publisher,scheduler_day_claim:claim,scheduler:safe};
}
