// Hash-free, read-only discovery before research. This is a snapshot, never a
// reservation, an upload permit, or proof that a cloud write did not execute.
import {assertFence,isFencedOut} from './producer-admission-fence.mjs';
import {decodeBundle,requireThat,reportDate,canonicalRequestDate,MAX_BUNDLE,REQUEST} from './report-handoff.mjs';
import {scopeDigest,handoffScope} from './handoff-state.mjs';
const HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/,TS=/^\d{10}\.\d{6}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const DAY_PREFIX='!ai-report day-receipt ';
export function dayCommand(c){
 requireThat(c&&Object.keys(c).sort().join()==='kind,query_id,report_date,request_id'&&c.kind==='day'&&reportDate(c.report_date)&&c.request_id===`morning-${c.report_date.replaceAll('-','')}-r1`&&UUID.test(c.query_id),'Exact daily discovery command required');return c;
}
const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export async function inspectDay(state,config,command,sourceTs,query,now=Date.now){
 dayCommand(command);requireThat(TS.test(sourceTs),'Day query source invalid');
 const db=state.db,day=command.report_date,started=performance.now(),observed=now();
 const budget=()=>requireThat(performance.now()-started<=45000,'Day discovery read budget exceeded');
 let local;
 db.exec('BEGIN');
 try{
  assertFence(db,config.producer_fence);
  if(config.producer_fence)requireThat(!db.prepare('SELECT 1 FROM producer_quarantined_dates WHERE report_date=?').get(day),'Original unresolved date is quarantined');
  const scope=db.prepare('SELECT value FROM scope WHERE id=1').get()?.value;
  requireThat(scope===scopeDigest(handoffScope(config)),'Publisher day scope differs');
  const scan=exists(db,'publisher_intake_scan')?db.prepare('SELECT watermark FROM publisher_intake_scan WHERE id=1').get():null;
  requireThat(TS.test(config.durable_intake?.not_before??'')&&Number(config.durable_intake.not_before)<=Date.parse(day+'T00:00:00+08:00')/1000&&scan?.watermark>=sourceTs,'Publisher day scan incomplete');
  const rows=db.prepare('SELECT id,hash,source_ts,phase,length(bytes) AS bundle_size FROM jobs ORDER BY source_ts LIMIT 1001').all();
  requireThat(rows.length<=1000,'Publisher day capacity exceeded');
  const publisher=[];
  for(const row of rows){
   budget();requireThat(row.bundle_size>0&&row.bundle_size<=MAX_BUNDLE,'Original day bundle size invalid');
   const stored=db.prepare('SELECT bytes,detail FROM jobs WHERE id=?').get(row.id),bundle=await decodeBundle(Buffer.from(stored.bytes));
   requireThat(bundle.hash===row.hash&&bundle.data.request_id===row.id&&TS.test(row.source_ts),'Original day binding invalid');
   if(row.id===command.request_id)requireThat(bundle.report.date===day,'Original request date differs');
   if(bundle.report.date!==day)continue;
   const detail=JSON.parse(stored.detail);
   requireThat(detail.commit===undefined||SHA.test(detail.commit),'Original day commit invalid');
   requireThat(detail.intake_file_id===undefined||/^F[A-Z0-9]+$/.test(detail.intake_file_id),'Original day file invalid');
   publisher.push({request_id:row.id,bundle_sha256:row.hash,source_ts:row.source_ts,phase:row.phase,report_commit:detail.commit??null,file_id:detail.intake_file_id??null});
  }
  const allInbox=exists(db,'publisher_inbox')?db.prepare("SELECT request_id,hash,file_id,source_ts,phase FROM publisher_inbox WHERE phase!='admitted' LIMIT 10001").all():[];
  requireThat(allInbox.length<=10000,'Publisher day intake capacity exceeded');
  const intake=allInbox.filter(row=>{
   if(row.phase==='fenced'&&isFencedOut(state,config.producer_fence,row)&&row.source_ts>=config.producer_fence.activation_ts)return false;
   const date=canonicalRequestDate(row.request_id);return !date||date===day||row.request_id===command.request_id;
  });
  const staged=['slack_staged_bundles','research_page_staged'].flatMap(table=>exists(db,table)?db.prepare(`SELECT request_id,report_date,hash,source_ts,file_id,phase,submit_ts FROM ${table} WHERE report_date=? OR request_id=? LIMIT 101`).all(day,command.request_id):[]);
  const allPending=exists(db,'slack_submission_events')?db.prepare("SELECT source_ts,kind,request_id,hash,file_id,target_ts,phase,next_at FROM slack_submission_events WHERE phase='pending' LIMIT 10001").all():[];
  requireThat(allPending.length<=10000&&staged.length<=100,'Publisher day staging capacity exceeded');
  const pending=allPending.filter(row=>{const date=canonicalRequestDate(row.request_id);return !date||date===day||row.request_id===command.request_id;});
  budget();local={publisher_scope_sha256:scope,scan_watermark:scan.watermark,publisher_day:publisher,publisher_intake:intake,staged_bundles:staged,pending_submissions:pending};
 }finally{db.exec('ROLLBACK');}
 const remote=await query(config.scheduled_delivery,{action:'inspect',request_id:command.request_id,report_date:day});
 requireThat(remote&&Object.keys(remote).sort().join()==='complete,observed_at,read_context,scheduler,scheduler_day_claim'&&remote.complete===true&&Object.keys(remote.read_context??{}).join()==='scheduler_scope_sha256'&&HASH.test(remote.read_context.scheduler_scope_sha256),'Scheduler day inspection incomplete');
 requireThat(Number.isSafeInteger(remote.observed_at)&&remote.observed_at<=now()+30000&&remote.observed_at>=now()-60000,'Scheduler day inspection stale');
 const claim=remote.scheduler_day_claim,status=remote.scheduler;
 requireThat((claim===null)===(status===null),'Scheduler day claim differs');
 let scheduler=null;
 if(status!==null){
  requireThat(claim&&Object.keys(claim).sort().join()==='bundle_sha256,report_commit,report_date,request_id'&&REQUEST.test(claim.request_id??'')&&claim.report_date===day&&HASH.test(claim.bundle_sha256)&&SHA.test(claim.report_commit)&&Object.entries(claim).every(([k,v])=>status[k]===v),'Scheduler original day binding differs');
  requireThat(['queued','sending','sent','failed','unknown','partial'].includes(status.status)&&typeof status.phase==='string'&&/^[a-z_]{1,40}$/.test(status.phase)&&Number.isSafeInteger(status.parts_total)&&status.parts_total>0&&Number.isSafeInteger(status.parts_sent)&&status.parts_sent>=0&&status.parts_sent<=status.parts_total,'Scheduler original day status invalid');
  scheduler={...claim,status:status.status,phase:status.phase,parts_sent:status.parts_sent,parts_total:status.parts_total};
  requireThat(local.publisher_day.some(p=>p.request_id===claim.request_id&&p.bundle_sha256===claim.bundle_sha256&&p.report_commit===claim.report_commit),'Scheduler and Publisher original day differ');
 }
 const occupied=local.publisher_day.length||local.staged_bundles.length||scheduler;
 const pending=local.publisher_intake.length||local.pending_submissions.length;
 requireThat(observed>=now()-60000,'Combined day inspection stale');
 const result={...command,source_ts:sourceTs,observed_at:Math.min(observed,remote.observed_at),complete:true,state:pending?'pending':occupied?'occupied':'empty',...local,...remote.read_context,scheduler_day_claim:claim,scheduler};
 requireThat(Buffer.byteLength(JSON.stringify(result))<=15000,'Bounded day receipt required');return result;
}
