// Producer intake only. No native notice/begin, final DM, scheduler admission or
// alternate upload route. Native tools are executed by the caller, never a shell API.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {digest} from './archive.mjs';
import {decodeBundle,requireThat} from './report-handoff.mjs';
import {verifyControlUpload} from './cloud-sender.mjs';
import {statusImages} from './scheduled-delivery-bridge.mjs';

export const PRODUCER_TOOLS=Object.freeze({ticket:'mcp__codex_apps__slack_slack_get_file_upload_url',complete:'mcp__codex_apps__slack_slack_complete_file_upload'});
export const READ_TTL_MS=60000, RETRY_DELAY_MS=30000;
export const postRetryDelay=attempt=>Math.min(15*60000,RETRY_DELAY_MS*2**Math.min(Math.max(attempt-1,0),5));
const FILE=/^F[A-Z0-9]+$/, HASH=/^[a-f0-9]{64}$/, SHA=/^[a-f0-9]{40}$/, TS=/^\d{10}\.\d{6}$/;
const exact=(v,keys)=>requireThat(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join(),'Unexpected evidence fields');
const matches=(re,v)=>typeof v==='string'&&re.test(v)&&!/[\r\n]/.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>digest(JSON.stringify(canonical(v)));
function clock(now){requireThat(Number.isSafeInteger(now)&&now>0,'Valid host clock required');return now;}
export function producerScope(c){
 exact(c,['team_id','channel_id','sender_user_id','sender_user_app_id','sender_attribution_text','publisher_scope_sha256','scheduler_scope_sha256','scheduler_team_id','scheduler_channel_id']);
 requireThat(matches(/^T[A-Z0-9]+$/,c.team_id)&&matches(/^[CG][A-Z0-9]+$/,c.channel_id)&&matches(/^U[A-Z0-9]+$/,c.sender_user_id)&&matches(/^A[A-Z0-9]+$/,c.sender_user_app_id),'Pinned intake and sender identity required');
 requireThat(typeof c.sender_attribution_text==='string'&&c.sender_attribution_text.length>0&&c.sender_attribution_text.length<=1000&&!/[\r\n]/.test(c.sender_attribution_text),'Pinned attribution required');
 requireThat(matches(/^T[A-Z0-9]+$/,c.scheduler_team_id)&&matches(/^[CDG][A-Z0-9]+$/,c.scheduler_channel_id),'Pinned scheduler day-claim identity required');
 requireThat(matches(HASH,c.publisher_scope_sha256)&&matches(HASH,c.scheduler_scope_sha256),'Pinned read-only Publisher and scheduler scopes required');
 return Object.freeze({...c});
}
// This parser extracts only known ticket fields. Never persist tool text or URL.
export function producerTicket(result){
 let t=result;
 if(result?.content){
  requireThat(!result.isError&&result.content.length===1&&result.content[0].type==='text'&&typeof result.content[0].text==='string'&&Buffer.byteLength(result.content[0].text)<=16384,'Ticket tool failed or changed format');
  t=JSON.parse(result.content[0].text);
  if(Object.keys(t).join()==='result'){
   const m=/^Upload URL generated successfully!\r?\n\r?\nFile ID: (F[A-Z0-9]+)\r?\nUpload URL: ([^\r\n]+)\r?\n\r?\nInstructions:\r?\n([^\0]+)$/.exec(t.result);
   requireThat(m&&!/(?:File ID|Upload URL):/.test(m[3]),'Ambiguous ticket response');t={file_id:m[1],upload_url:m[2]};
  }
 }
 exact(t,['file_id','upload_url']);
 requireThat(matches(FILE,t.file_id)&&typeof t.upload_url==='string'&&/^https:\/\/files\.slack\.com\/upload\/v1\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+$/.test(t.upload_url)&&t.upload_url.length<=8192,'Invalid original ticket');
 const u=new URL(t.upload_url);
 requireThat(u.hostname==='files.slack.com'&&!u.username&&!u.password&&!u.port&&!u.hash&&u.pathname.startsWith('/upload/v1/'),'Invalid original upload endpoint');
 return {file_id:t.file_id,url_sha256:digest(t.upload_url),upload_url:t.upload_url};
}
// Safe numeric allowlist only: do not journal curl errors, URL, headers or bodies.
export function postMetrics(m){
 const keys=['curl_exit','http_status','num_connects','num_redirects','upload_bytes','response_bytes','header_bytes','time_namelookup','time_connect','time_appconnect','time_starttransfer','ssl_verify_result','response_sha256'];
 exact(m,keys);
 for(const k of keys.filter(k=>k!=='response_sha256'))requireThat(Number.isFinite(m[k])&&m[k]>=0,'Invalid POST measurement');
 for(const k of keys.filter(k=>!k.startsWith('time_')&&k!=='response_sha256'))requireThat(Number.isSafeInteger(m[k]),'Invalid POST count');
 requireThat(m.curl_exit<=255&&m.http_status<=599&&(m.response_sha256===null||matches(HASH,m.response_sha256)),'Invalid POST response metadata');
 return Object.fromEntries(keys.map(k=>[k,m[k]]));
}
function postOutcome(m,size){
 if(m.curl_exit===0&&m.http_status===200&&m.upload_bytes===size&&m.num_redirects===0&&m.ssl_verify_result===0)return 'confirmed';
 // Only the fixed, direct, no-proxy/no-redirect curl adapter can supply this.
 // 000, zero bytes, timeout, TLS failure or connection reset alone prove nothing.
 if([6,7].includes(m.curl_exit)&&m.http_status===0&&m.num_connects===0&&m.num_redirects===0&&m.upload_bytes===0&&m.response_bytes===0&&m.header_bytes===0&&m.time_connect===0&&m.time_appconnect===0&&m.time_starttransfer===0)return 'not_executed';
 return 'unknown';
}
export const PRODUCER_SCHEMA=Object.freeze({
 producer_scope:'CREATE TABLE producer_scope(id INTEGER PRIMARY KEY CHECK(id=1),hash TEXT NOT NULL)',
 producer_runs:'CREATE TABLE producer_runs(id TEXT PRIMARY KEY,date TEXT UNIQUE NOT NULL,edition TEXT NOT NULL,bundle BLOB NOT NULL,hash TEXT NOT NULL,detail TEXT NOT NULL)',
 producer_ops:'CREATE TABLE producer_ops(run_id TEXT NOT NULL,name TEXT NOT NULL,attempt INTEGER NOT NULL,operation_id TEXT UNIQUE NOT NULL,phase TEXT NOT NULL,at INTEGER NOT NULL,result TEXT,PRIMARY KEY(run_id,name,attempt))'
});
export const producerScopeHash=scope=>hash({schema:1,scope:producerScope(scope)});
export class ProducerUploadState{
 constructor(filename,scope,{now=Date.now}={}){
  this.scope=producerScope(scope);this.now=now;this.db=new DatabaseSync(filename);
  try{
   const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7)!='sqlite_'").all();
   requireThat(tables.every(t=>['producer_scope','producer_runs','producer_ops','producer_inspect_scope','producer_inspect_queries'].includes(t.name)),'Use a dedicated Producer journal, never a Publisher, scheduler or native journal');
   this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;'+Object.values(PRODUCER_SCHEMA).map(sql=>sql.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ')).join(';'));
   const h=producerScopeHash(this.scope);this.db.prepare('INSERT OR IGNORE INTO producer_scope VALUES(1,?)').run(h);
   requireThat(this.db.prepare('SELECT hash FROM producer_scope WHERE id=1').get().hash===h,'Producer scope changed; use the original journal');
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 get(id){const r=this.db.prepare('SELECT * FROM producer_runs WHERE id=?').get(id);return r?{...r,bundle:Buffer.from(r.bundle),detail:JSON.parse(r.detail)}:null;}
 op(id,name){const o=this.db.prepare('SELECT * FROM producer_ops WHERE run_id=? AND name=? ORDER BY attempt DESC LIMIT 1').get(id,name);return o?{...o,result:o.result===null?null:JSON.parse(o.result)}:null;}
 save(row,detail){this.db.prepare('UPDATE producer_runs SET detail=? WHERE id=?').run(JSON.stringify(detail),row.id);}
 async prepare(bytes){
  const b=await decodeBundle(bytes);requireThat(/^\d{4}-\d\d-\d\d$/.test(b.report.date)&&new Date(b.report.date+'T00:00:00Z').toISOString().slice(0,10)===b.report.date,'Invalid report date');
  return this.transaction(()=>{
   const old=this.get(b.data.request_id);
   if(old){requireThat(old.bundle.equals(bytes)&&old.hash===b.hash,'Original bundle bytes changed');return this.summary(old);}
   requireThat(!this.db.prepare('SELECT 1 FROM producer_runs WHERE date=?').get(b.report.date),'Date already reserved; reconcile original request');
   this.db.prepare('INSERT INTO producer_runs VALUES(?,?,?,?,?,?)').run(b.data.request_id,b.report.date,`${b.report.date}/r${b.report.revision}`,bytes,b.hash,'{}');return this.summary(this.get(b.data.request_id));
  });
 }
 summary(j){const operations=['ticket','post','complete'].map(name=>this.op(j.id,name)).filter(Boolean).map(o=>({operation:o.name,attempt:o.attempt,outcome:o.phase,...(o.name==='post'&&o.result?{metrics:o.result.metrics}:{})}));return {operations,request_id:j.id,report_date:j.date,edition:j.edition,bundle_sha256:j.hash,bundle_bytes:j.bundle.length,file_id:j.detail.file_id??null,source_ts:j.detail.source_ts??null,status:j.detail.delivery?.complete?'sent':j.detail.source_ts?'intake_verified':'pending',delivery:j.detail.delivery??null};}
 readAction(j,reason='preflight'){return {type:'read',next_action:'read_original_publisher_scheduler',reason,...this.summary(j),publisher_scope_sha256:this.scope.publisher_scope_sha256,scheduler_scope_sha256:this.scope.scheduler_scope_sha256,require_complete_date_claims:true,write_allowed:false};}
 sourceAction(j,reason){return {type:'read',next_action:'read_original_file_and_share',reason,...this.summary(j),team_id:this.scope.team_id,channel_id:this.scope.channel_id,require_actual_bytes:true,write_allowed:false};}
 // A dispatch action is emitted once, only after the durable transaction commits.
 // It is a one-shot instruction, not a replayable capability. Another next() will
 // reconcile the same operation even if this process died before invoking it.
 next(id,{postAvailable=true}={}){return this.transaction(()=>{
  const j=this.get(id);requireThat(j,'Unknown Producer request');const now=clock(this.now());
  if(j.detail.delivery?.complete)return {type:'done',next_action:'none',...this.summary(j),write_allowed:false};
  if(j.detail.source_ts)return this.readAction(j,'delivery_pending');
  if(j.detail.existing)return this.sourceAction(j,'existing_original_intake');
  for(const name of ['ticket','post','complete']){
   const op=this.op(id,name);
   if(op?.phase==='confirmed')continue;
   if(op&&!(name==='post'&&op.phase==='not_executed')){
    if(name==='complete')return this.sourceAction(j,'completion_outcome_unknown');
    return {type:'blocked',next_action:'reconcile_original_operation',reason:op.result?.metrics?.http_status===401?'original_ticket_rejected_or_expired':'write_outcome_unknown',operation:name,operation_id:op.operation_id,attempt:op.attempt,...this.summary(j),write_allowed:false};
   }
   if(op&&now<op.at+postRetryDelay(op.attempt))return {type:'wait',next_action:'wait_same_operation',next_attempt_at:op.at+postRetryDelay(op.attempt),...this.summary(j),write_allowed:false};
   if(!j.detail.preflight_at||now<j.detail.preflight_at||now-j.detail.preflight_at>=READ_TTL_MS)return this.readAction(j);
   if(name==='post'&&!postAvailable)return {type:'blocked',next_action:'restore_original_ticket',...this.summary(j),write_allowed:false};
   const attempt=(op?.attempt??0)+1,operation_id=randomUUID();
   this.db.prepare("INSERT INTO producer_ops VALUES(?,?,?,?,'unknown',?,NULL)").run(id,name,attempt,operation_id,now);
   this.save(j,{...j.detail,preflight_at:null}); // One fresh read authorizes one write, never a reservation.
   const action={type:'write',next_action:name,operation_id,attempt,...this.summary(j),write_allowed:true};
   if(name==='ticket')return {...action,tool:PRODUCER_TOOLS.ticket,arguments:{filename:'ai-brief-bundle.json',content_length:j.bundle.length}};
   if(name==='post')return {...action,adapter:'producer_curl_direct_v1',url_sha256:j.detail.url_sha256,method:'POST',content_type:'application/json',same_ticket_only:true};
   return {...action,tool:PRODUCER_TOOLS.complete,arguments:{file_id:j.detail.file_id,channel_id:this.scope.channel_id,initial_comment:`!ai-report publish ${j.id} ${j.hash}`}};
  }
  return this.sourceAction(j,'completion_acknowledged_not_verified');
 });}
 record(action,result){
  return this.transaction(()=>{
   const j=this.get(action.request_id),op=j&&this.op(j.id,action.next_action);
   requireThat(op&&op.operation_id===action.operation_id&&op.attempt===action.attempt&&action.bundle_sha256===j.hash&&action.bundle_bytes===j.bundle.length,'Original operation binding required');
   requireThat(op.phase==='unknown'||op.phase==='confirmed'||op.phase==='not_executed','Invalid operation state');
   let phase='unknown',safe=null,detail=j.detail;
   if(action.next_action==='ticket'){
    const t=producerTicket(result);phase='confirmed';safe={file_id:t.file_id,url_sha256:t.url_sha256};
    requireThat(!detail.file_id||detail.file_id===t.file_id,'Replacement file is forbidden');detail={...detail,...safe};
   }else if(action.next_action==='post'){
    exact(result,['adapter','file_id','url_sha256','bundle_sha256','metrics']);
    requireThat(result.adapter==='producer_curl_direct_v1'&&result.file_id===detail.file_id&&result.url_sha256===detail.url_sha256&&result.bundle_sha256===j.hash,'Original POST binding required');
    const metrics=postMetrics(result.metrics);phase=postOutcome(metrics,j.bundle.length);safe={...result,metrics};
   }else{
    requireThat(action.next_action==='complete','Unsupported write');
    // Even a native success string proves no visible file or share. Remember only
    // acknowledgement; source validation is mandatory before downstream status.
    exact(result,['acknowledged']);requireThat(typeof result.acknowledged==='boolean','Completion acknowledgement required');
    phase=result.acknowledged?'confirmed':'unknown';safe=result;
   }
   if(op.result!==null){requireThat(hash(op.result)===hash(safe)&&op.phase===phase,'Conflicting receipt; reconcile original operation');return this.summary(j);}
   this.db.prepare('UPDATE producer_ops SET phase=?,result=? WHERE operation_id=?').run(phase,JSON.stringify(safe),op.operation_id);this.save(j,detail);return this.summary(this.get(j.id));
  });
 }
 // Authenticated, read-only adapter output, not search snippets or success text.
 // Missing, partial, stale or unavailable reads never authorize a write.
 observeDownstream(id,e,{inTransaction=false}={}){const apply=()=>{
  const j=this.get(id);requireThat(j,'Unknown Producer request');const now=clock(this.now());
  exact(e,['read_context','observed_at','complete','publisher_day','publisher','scheduler_day_claim','scheduler']);
  exact(e.read_context,['publisher_scope_sha256','scheduler_scope_sha256']);
  requireThat(e.complete===true&&e.read_context.publisher_scope_sha256===this.scope.publisher_scope_sha256&&e.read_context.scheduler_scope_sha256===this.scope.scheduler_scope_sha256,'Authenticated complete original scopes required');
  requireThat(Number.isSafeInteger(e.observed_at)&&e.observed_at<=now&&now-e.observed_at<READ_TTL_MS,'Fresh read evidence required');
  requireThat(Array.isArray(e.publisher_day)&&e.publisher_day.length<=1,'Ambiguous Publisher date ownership');
  const binding=v=>requireThat(v?.request_id===j.id&&v.bundle_sha256===j.hash&&v.report_date===j.date,'Original request/date/hash mismatch');
  for(const row of e.publisher_day)binding(row);
  requireThat((e.publisher===null)===(e.publisher_day.length===0),'Incomplete Publisher date scan');
  requireThat(!j.detail.existing||e.publisher,'Previously observed Publisher intake cannot disappear');
  requireThat(!j.detail.delivery||e.scheduler,'Previously observed scheduler request cannot disappear');
  if(e.publisher){
   exact(e.publisher,['request_id','report_date','bundle_sha256','source_ts','report_commit',...(Object.hasOwn(e.publisher,'file_id')?['file_id']:[])]);binding(e.publisher);
   requireThat(e.publisher.file_id==null||matches(FILE,e.publisher.file_id),'Publisher original file identity required');
   if(e.publisher.file_id&&j.detail.file_id)requireThat(e.publisher.file_id===j.detail.file_id,'Publisher original file differs');
   requireThat(matches(TS,e.publisher.source_ts)&&(e.publisher.report_commit===null||matches(SHA,e.publisher.report_commit)),'Publisher original identity required');
   if(j.detail.source_ts)requireThat(e.publisher.source_ts===j.detail.source_ts,'Publisher source changed');
   if(j.detail.publisher_source_ts)requireThat(e.publisher.source_ts===j.detail.publisher_source_ts,'Publisher source changed');
  }
  if(e.scheduler_day_claim){
   exact(e.scheduler_day_claim,['request_id','report_date','bundle_sha256','report_commit']);binding(e.scheduler_day_claim);requireThat(matches(SHA,e.scheduler_day_claim.report_commit),'Scheduler original commit required');
  }
  requireThat((e.scheduler===null)===(e.scheduler_day_claim===null),'Incomplete scheduler day claim');
  // Trusted original ledger/Publisher receipt retains this ID only after strict
  // file+byte admission. A legacy missing ID is never synthesized.
  const source=e.publisher?.file_id?{file_id:e.publisher.file_id,source_ts:e.publisher.source_ts}:{};
  let delivery=null;
  if(e.scheduler){
   const s=e.scheduler;binding(s);requireThat(s.report_commit===e.scheduler_day_claim.report_commit&&matches(SHA,s.report_commit)&&e.publisher?.report_commit===s.report_commit,'Original Publisher/scheduler commit mismatch');
   requireThat(['queued','sending','sent','failed','unknown','partial'].includes(s.status)&&Number.isSafeInteger(s.parts_total)&&s.parts_total>0&&Number.isSafeInteger(s.parts_sent)&&s.parts_sent>=0&&s.parts_sent<=s.parts_total,'Invalid scheduler receipt counts');
   const images=statusImages(s.images),complete=s.status==='sent'&&s.phase==='complete'&&s.parts_sent===s.parts_total&&images.length===1&&images[0].file_id==='scheduled-poster'&&images[0].status==='sent'&&images[0].error===null;
   requireThat(s.status!=='sent'||complete,'All real parts and poster receipt required');
   delivery={status:s.status,parts_sent:s.parts_sent,parts_total:s.parts_total,complete:!!(source.source_ts||j.detail.source_ts)&&complete};
  }
  this.save(j,{...j.detail,...source,preflight_at:e.observed_at,existing:!!e.publisher,publisher_source_ts:e.publisher?.source_ts??null,publisher_commit:e.publisher?.report_commit??null,delivery});return this.summary(this.get(id));
 };return inTransaction?apply():this.transaction(apply);}
 observeSource(id,e){return this.transaction(()=>{
  const j=this.get(id);requireThat(j,'Unknown Producer request');
  const proof=verifyControlUpload(e,this.scope,{bytes:j.bundle,id,kind:'publish'},clock(this.now()));
  requireThat(!j.detail.file_id||j.detail.file_id===proof.file_id,'Original file differs; never replace it');
  requireThat(!j.detail.source_ts||j.detail.source_ts===proof.source_ts,'Original source differs');
  requireThat(!j.detail.publisher_source_ts||j.detail.publisher_source_ts===proof.source_ts,'Publisher source differs');
  requireThat(j.detail.existing||this.op(id,'complete'),'No original intake operation to reconcile');
  this.save(j,{...j.detail,...proof});return this.summary(this.get(id));
 });}
}

// An agent can bridge native tools with this adapter; there is no invented shell
// native API. External mutations happen only for the newly returned write action.
export class ProducerUploadAdapter{
 constructor(state,io){this.state=state;this.io=io;this.tickets=new Map();}
 restoreTicket(id,result){const j=this.state.get(id),t=producerTicket(result);requireThat(j&&j.detail.file_id===t.file_id&&j.detail.url_sha256===t.url_sha256,'Restore only the original ticket');this.tickets.set(id,t);}
 async step(id){
  const j=this.state.get(id);requireThat(j,'Unknown Producer request');
  // Check availability inside next(), after fresh reads but before POST intent.
  const action=this.state.next(id,{postAvailable:this.tickets.has(id)});
  if(action.type!=='write')return action;
  try{
   let result;
   if(action.next_action==='ticket'){
    result=await this.io.callTool(action.tool,action.arguments,action);
    const ticket=producerTicket(result);this.state.record(action,result);this.tickets.set(id,ticket);return this.state.summary(this.state.get(id));
   }
   if(action.next_action==='post'){
    const t=this.tickets.get(id);requireThat(t,'Original ticket unavailable');
    result=await this.io.upload({bytes:j.bundle,ticket:t});
   }else {const reply=await this.io.callTool(action.tool,action.arguments,action);result={acknowledged:!!reply&&!reply.isError&&Array.isArray(reply.content)};}
   this.state.record(action,result);
  }catch{
   // The intent already says unknown. Do not log the transport exception: it may
   // contain the signed URL, request headers, response text or authentication.
  }
  return this.state.summary(this.state.get(id));
 }
}
