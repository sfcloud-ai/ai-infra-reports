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
// Explicit operator-only, one-time recovery. Extra schema fences old executables.
export const RECOVERY_SCHEMA=Object.freeze({
 producer_recovery_audit: "CREATE TABLE producer_recovery_audit(run_id TEXT PRIMARY KEY,recovery_id TEXT UNIQUE NOT NULL,at INTEGER NOT NULL,authorization_reference TEXT NOT NULL,original TEXT NOT NULL)",
 producer_recovery_no_update: "CREATE TRIGGER producer_recovery_no_update BEFORE UPDATE ON producer_recovery_audit BEGIN SELECT RAISE(ABORT,'Immutable recovery audit'); END",
 producer_recovery_no_delete: "CREATE TRIGGER producer_recovery_no_delete BEFORE DELETE ON producer_recovery_audit BEGIN SELECT RAISE(ABORT,'Immutable recovery audit'); END",
 producer_recovery_old_insert: "CREATE TRIGGER producer_recovery_old_insert BEFORE INSERT ON producer_ops WHEN EXISTS(SELECT 1 FROM producer_recovery_audit WHERE run_id=NEW.run_id) AND NEW.name NOT IN ('recovery_ticket','recovery_post','recovery_complete') BEGIN SELECT RAISE(ABORT,'Original operation fenced'); END",
 producer_recovery_old_update: "CREATE TRIGGER producer_recovery_old_update BEFORE UPDATE ON producer_ops WHEN EXISTS(SELECT 1 FROM producer_recovery_audit WHERE run_id=OLD.run_id) AND (OLD.name NOT IN ('recovery_ticket','recovery_post','recovery_complete') OR NEW.run_id!=OLD.run_id OR NEW.name!=OLD.name OR NEW.attempt!=OLD.attempt OR NEW.operation_id!=OLD.operation_id OR NEW.at!=OLD.at) BEGIN SELECT RAISE(ABORT,'Original operation immutable'); END",
 producer_recovery_ops_delete: "CREATE TRIGGER producer_recovery_ops_delete BEFORE DELETE ON producer_ops WHEN EXISTS(SELECT 1 FROM producer_recovery_audit WHERE run_id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'Recovery operation immutable'); END",
 producer_recovery_binding: "CREATE TRIGGER producer_recovery_binding BEFORE UPDATE ON producer_runs WHEN EXISTS(SELECT 1 FROM producer_recovery_audit WHERE run_id=OLD.id) AND (NEW.id!=OLD.id OR NEW.date!=OLD.date OR NEW.edition!=OLD.edition OR NEW.hash!=OLD.hash OR NEW.bundle!=OLD.bundle OR json_extract(NEW.detail,'$.recovery_id') IS NOT json_extract(OLD.detail,'$.recovery_id')) BEGIN SELECT RAISE(ABORT,'Original recovery binding immutable'); END",
 producer_recovery_run_delete: "CREATE TRIGGER producer_recovery_run_delete BEFORE DELETE ON producer_runs WHEN EXISTS(SELECT 1 FROM producer_recovery_audit WHERE run_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Original recovery run immutable'); END"
});
// Installed only by the explicit offline policy command. No credential is stored.
export const RESTART_RECOVERY_POLICY='producer_abandoned_ticket_v1';
export const RESTART_RECOVERY_DELAY_MS=5*60000;
export const RESTART_SCHEMA=Object.freeze({
 producer_restart_policy:'CREATE TABLE producer_restart_policy(id INTEGER PRIMARY KEY CHECK(id=1),policy TEXT NOT NULL,authorization_reference TEXT NOT NULL,scope_hash TEXT NOT NULL,journal_device TEXT NOT NULL,journal_inode TEXT NOT NULL,lock_device TEXT NOT NULL,lock_inode TEXT NOT NULL)',
 producer_restart_audit:'CREATE TABLE producer_restart_audit(run_id TEXT NOT NULL,generation INTEGER NOT NULL,recovery_id TEXT UNIQUE NOT NULL,at INTEGER NOT NULL,ticket_attempt INTEGER NOT NULL,post_attempt INTEGER NOT NULL,complete_attempt INTEGER NOT NULL,original TEXT NOT NULL,PRIMARY KEY(run_id,generation))',
 producer_restart_policy_update:"CREATE TRIGGER producer_restart_policy_update BEFORE UPDATE ON producer_restart_policy BEGIN SELECT RAISE(ABORT,'Immutable restart policy'); END",
 producer_restart_policy_delete:"CREATE TRIGGER producer_restart_policy_delete BEFORE DELETE ON producer_restart_policy BEGIN SELECT RAISE(ABORT,'Immutable restart policy'); END",
 producer_restart_audit_update:"CREATE TRIGGER producer_restart_audit_update BEFORE UPDATE ON producer_restart_audit BEGIN SELECT RAISE(ABORT,'Immutable restart audit'); END",
 producer_restart_audit_delete:"CREATE TRIGGER producer_restart_audit_delete BEFORE DELETE ON producer_restart_audit BEGIN SELECT RAISE(ABORT,'Immutable restart audit'); END",
 producer_restart_op_update:"CREATE TRIGGER producer_restart_op_update BEFORE UPDATE ON producer_ops WHEN EXISTS(SELECT 1 FROM producer_restart_audit a,json_each(a.original,'$.operations') o WHERE json_extract(o.value,'$.operation_id')=OLD.operation_id) BEGIN SELECT RAISE(ABORT,'Abandoned operation immutable'); END",
 producer_restart_op_delete:"CREATE TRIGGER producer_restart_op_delete BEFORE DELETE ON producer_ops WHEN EXISTS(SELECT 1 FROM producer_restart_audit a,json_each(a.original,'$.operations') o WHERE json_extract(o.value,'$.operation_id')=OLD.operation_id) BEGIN SELECT RAISE(ABORT,'Abandoned operation immutable'); END",
 producer_restart_binding:"CREATE TRIGGER producer_restart_binding BEFORE UPDATE ON producer_runs WHEN EXISTS(SELECT 1 FROM producer_restart_audit WHERE run_id=OLD.id) AND (NEW.id!=OLD.id OR NEW.date!=OLD.date OR NEW.edition!=OLD.edition OR NEW.hash!=OLD.hash OR NEW.bundle!=OLD.bundle OR json_extract(NEW.detail,'$.recovery_id') IS NOT json_extract(OLD.detail,'$.recovery_id')) BEGIN SELECT RAISE(ABORT,'Original restart binding immutable'); END",
 producer_restart_run_delete:"CREATE TRIGGER producer_restart_run_delete BEFORE DELETE ON producer_runs WHEN EXISTS(SELECT 1 FROM producer_restart_audit WHERE run_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Original restart run immutable'); END"
});
export const producerScopeHash=scope=>hash({schema:1,scope:producerScope(scope)});
export class ProducerUploadState{
 constructor(filename,scope,{now=Date.now}={}){
  this.scope=producerScope(scope);this.now=now;this.db=new DatabaseSync(filename);
  try{
   const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7)!='sqlite_'").all();
   requireThat(tables.every(t=>['producer_scope','producer_runs','producer_ops','producer_inspect_scope','producer_inspect_queries','producer_recovery_audit','producer_restart_policy','producer_restart_audit'].includes(t.name)),'Use a dedicated Producer journal, never a Publisher, scheduler or native journal');
   this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;'+Object.values(PRODUCER_SCHEMA).map(sql=>sql.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ')).join(';'));
   const h=producerScopeHash(this.scope);this.db.prepare('INSERT OR IGNORE INTO producer_scope VALUES(1,?)').run(h);
   requireThat(this.db.prepare('SELECT hash FROM producer_scope WHERE id=1').get().hash===h,'Producer scope changed; use the original journal');
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 get(id){const r=this.db.prepare('SELECT * FROM producer_runs WHERE id=?').get(id);return r?{...r,bundle:Buffer.from(r.bundle),detail:JSON.parse(r.detail)}:null;}
 op(id,name){const o=this.db.prepare('SELECT * FROM producer_ops WHERE run_id=? AND name=? ORDER BY attempt DESC LIMIT 1').get(id,name);return o?{...o,result:o.result===null?null:JSON.parse(o.result)}:null;}
 activeName(id,name){return this.get(id)?.detail.recovery_id?'recovery_'+name:name;}
 restartPolicy(){return this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='producer_restart_policy'").get()?this.db.prepare('SELECT * FROM producer_restart_policy WHERE id=1').get():null;}
 restartAudit(id){return this.restartPolicy()?this.db.prepare('SELECT * FROM producer_restart_audit WHERE run_id=? ORDER BY generation DESC LIMIT 1').get(id)??null:null;}
 activeOp(id,name){const op=this.op(id,this.activeName(id,name)),audit=this.restartAudit(id);return op&&op.attempt>(audit?.[name+'_attempt']??0)?op:null;}
 enableRestartRecovery(authorization_reference,installation){return this.transaction(()=>{
  requireThat(typeof authorization_reference==='string'&&/^[A-Za-z0-9:_./-]{1,200}$/.test(authorization_reference),'Explicit restart policy authorization required');
  exact(installation,['journal_device','journal_inode','lock_device','lock_inode']);
  requireThat(Object.values(installation).every(v=>typeof v==='string'&&/^\d+$/.test(v)),'Original installation identity required');
  requireThat(!this.restartPolicy(),'Restart policy already installed');
  for(const sql of Object.values(RESTART_SCHEMA))this.db.exec(sql);
  this.db.prepare('INSERT INTO producer_restart_policy VALUES(1,?,?,?,?,?,?,?)').run(RESTART_RECOVERY_POLICY,authorization_reference,producerScopeHash(this.scope),installation.journal_device,installation.journal_inode,installation.lock_device,installation.lock_inode);
  return {type:'restart_recovery_enabled',policy:RESTART_RECOVERY_POLICY,write_allowed:false};
 });}
 // Called only for a ticket observed at process startup, with the inherited
 // original flock. It cannot refresh an uncertain call from the live process.
 recoverAbandonedTicket(id,{operation_id,started_at,inspect_attempt}){return this.transaction(()=>{
  const policy=this.restartPolicy();requireThat(policy?.policy===RESTART_RECOVERY_POLICY&&policy.scope_hash===producerScopeHash(this.scope),'Installed restart policy required');
  const j=this.get(id),ticket=this.activeOp(id,'ticket'),now=clock(this.now());
  requireThat(Number.isSafeInteger(started_at)&&started_at>0&&started_at<=now&&Number.isSafeInteger(inspect_attempt)&&inspect_attempt>=0,'Original restart time required');
  if(!j||!ticket||ticket.operation_id!==operation_id||j.detail.existing||j.detail.source_ts||j.detail.publisher_source_ts||j.detail.delivery)return null;
  const ops=this.db.prepare('SELECT * FROM producer_ops WHERE run_id=? ORDER BY name,attempt').all(id),posts=ops.filter(o=>['post','recovery_post'].includes(o.name));
  if(ops.some(o=>!['ticket','post','recovery_ticket','recovery_post'].includes(o.name)))return null; // Any historical completion fences all rotation.
  if(!['unknown','confirmed'].includes(ticket.phase)||ticket.phase==='unknown'&&ticket.result!==null)return null;
  if(ticket.phase==='confirmed'&&(ticket.result?.file_id!==j.detail.file_id||ticket.result?.url_sha256!==j.detail.url_sha256))return null;
  try{
   for(const op of posts){
    const r=JSON.parse(op.result),tickets=ops.filter(t=>t.name===(op.name==='post'?'ticket':'recovery_ticket')&&t.phase==='confirmed'&&t.at<=op.at);
    requireThat(op.phase==='not_executed'&&r?.adapter==='producer_curl_direct_v1'&&r.bundle_sha256===j.hash&&postOutcome(postMetrics(r.metrics),j.bundle.length)==='not_executed'&&tickets.some(t=>{const v=JSON.parse(t.result);return v.file_id===r.file_id&&v.url_sha256===r.url_sha256;}),'Every historical POST must independently prove nonexecution');
   }
  }catch{return null;}
  const eligible_at=Math.max(ticket.at+RESTART_RECOVERY_DELAY_MS,...posts.map(o=>o.at+postRetryDelay(o.attempt)));
  if(now<eligible_at)return {type:'wait',next_action:'wait_abandoned_ticket_recovery',next_attempt_at:eligible_at,...this.summary(j),write_allowed:false};
  // Only a new native query, authenticated by ProducerInspect, can authorize
  // retirement. Bind its nonce, not independent Publisher/cloud clock order.
  // A still-fresh receipt inherited from the dead runner cannot authorize it.
  const query=this.db.prepare('SELECT * FROM producer_inspect_queries WHERE run_id=? ORDER BY attempt DESC LIMIT 1').get(id);
  if(!query||query.phase!=='resolved'||query.attempt<=inspect_attempt||query.started_at<started_at||!j.detail.preflight_at||j.detail.preflight_query_id!==query.query_id||now<j.detail.preflight_at||now-j.detail.preflight_at>=READ_TTL_MS)return this.readAction(j,'restart_ticket_recovery_preflight');
  requireThat(j.detail.preflight_empty===true,'Fresh empty downstream required for restart recovery');
  const previous=this.restartAudit(id),generation=(previous?.generation??0)+1,recovery_id=randomUUID();
  const high=name=>this.op(id,this.activeName(id,name))?.attempt??0;
  const original=JSON.stringify({request_id:j.id,report_date:j.date,edition:j.edition,bundle_sha256:j.hash,bundle_bytes:j.bundle.length,detail:j.detail,operations:ops,abandoned_operation_id:ticket.operation_id,inspect_operation_id:query.operation_id,scope_sha256:producerScopeHash(this.scope),policy_authorization_reference:this.restartPolicy().authorization_reference});
  this.db.prepare('INSERT INTO producer_restart_audit VALUES(?,?,?,?,?,?,?,?)').run(id,generation,recovery_id,now,high('ticket'),high('post'),high('complete'),original);
  // The old ticket is not "not_executed" and its result is never invented. A
  // separate audited allocation follows only after another authenticated read.
  const detail={...j.detail,restart_recovery_at:now,preflight_at:null,preflight_empty:false};delete detail.file_id;delete detail.url_sha256;
  this.save(j,detail);
  return {type:'ticket_abandoned',generation,...this.summary(this.get(id)),write_allowed:false};
 });}
 authorizeTicketRecovery(id,authorization){return this.transaction(()=>{
  exact(authorization,['authorization_reference','file_id','url_sha256','bundle_sha256']);
  requireThat(typeof authorization.authorization_reference==='string'&&/^[A-Za-z0-9:_./-]{1,200}$/.test(authorization.authorization_reference),'Explicit authorization reference required');
  const j=this.get(id),now=clock(this.now());requireThat(j&&!j.detail.recovery_id&&!this.restartAudit(id),'Original unrecovered request required');
  requireThat(j.hash===authorization.bundle_sha256&&j.detail.file_id===authorization.file_id&&j.detail.url_sha256===authorization.url_sha256,'Exact original recovery binding required');
  requireThat(j.detail.preflight_empty===true&&j.detail.preflight_at&&now>=j.detail.preflight_at&&now-j.detail.preflight_at<READ_TTL_MS&&!j.detail.existing&&!j.detail.source_ts&&!j.detail.publisher_source_ts&&!j.detail.delivery,'Fresh authenticated empty downstream required');
  const ops=this.db.prepare('SELECT * FROM producer_ops WHERE run_id=? ORDER BY name,attempt').all(id),tickets=ops.filter(o=>o.name==='ticket'),posts=ops.filter(o=>o.name==='post');
  requireThat(ops.every(o=>['ticket','post'].includes(o.name))&&tickets.length===1&&tickets[0].phase==='confirmed'&&posts.length>0,'Exactly one confirmed ticket, proven POST failures and no completion required');
  const ticket=JSON.parse(tickets[0].result);
  requireThat(ticket.file_id===j.detail.file_id&&ticket.url_sha256===j.detail.url_sha256,'Original ticket journal binding required');
  for(const o of posts){const r=JSON.parse(o.result);requireThat(o.phase==='not_executed'&&r?.adapter==='producer_curl_direct_v1'&&r.file_id===ticket.file_id&&r.url_sha256===ticket.url_sha256&&r.bundle_sha256===j.hash&&postOutcome(postMetrics(r.metrics),j.bundle.length)==='not_executed','Every original POST must prove nonexecution');}
  const recovery_id=randomUUID(),original=JSON.stringify({request_id:j.id,report_date:j.date,edition:j.edition,bundle_sha256:j.hash,bundle_bytes:j.bundle.length,detail:j.detail,operations:ops});
  for(const sql of Object.values(RECOVERY_SCHEMA))this.db.exec(sql.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ').replace('CREATE TRIGGER ','CREATE TRIGGER IF NOT EXISTS '));
  // The binding trigger permits no recovery-id change after the audit row exists.
  this.save(j,{recovery_id,recovery_at:now,preflight_at:null,preflight_empty:false});
  this.db.prepare('INSERT INTO producer_recovery_audit VALUES(?,?,?,?,?)').run(id,recovery_id,now,authorization.authorization_reference,original);
  return {type:'recovery_authorized',request_id:id,recovery_id,write_allowed:false};
 });}
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
 summary(j){const operation_history=this.db.prepare('SELECT * FROM producer_ops WHERE run_id=? ORDER BY name,attempt').all(j.id).map(o=>({operation:o.name,attempt:o.attempt,outcome:o.phase,...(['post','recovery_post'].includes(o.name)&&o.result?{metrics:JSON.parse(o.result).metrics}:{})})),operations=operation_history.filter(o=>o.attempt===this.op(j.id,o.operation)?.attempt),audit=this.restartAudit(j.id);return {operations,operation_history,recovery_id:j.detail.recovery_id??null,restart_generation:audit?.generation??0,restart_recovery_id:audit?.recovery_id??null,active_operations:operations.filter(o=>['ticket','post','complete'].some(name=>o.operation===this.activeName(j.id,name)&&o.attempt===this.activeOp(j.id,name)?.attempt)),request_id:j.id,report_date:j.date,edition:j.edition,bundle_sha256:j.hash,bundle_bytes:j.bundle.length,file_id:j.detail.file_id??null,source_ts:j.detail.source_ts??null,status:j.detail.delivery?.complete?'sent':j.detail.source_ts?'intake_verified':'pending',delivery:j.detail.delivery??null};}
 readAction(j,reason='preflight'){return {type:'read',next_action:'read_original_publisher_scheduler',reason,...this.summary(j),publisher_scope_sha256:this.scope.publisher_scope_sha256,scheduler_scope_sha256:this.scope.scheduler_scope_sha256,require_complete_date_claims:true,write_allowed:false};}
 sourceAction(j,reason){return {type:'read',next_action:'read_original_file_and_share',reason,...this.summary(j),team_id:this.scope.team_id,channel_id:this.scope.channel_id,require_actual_bytes:true,write_allowed:false};}
 // A dispatch action is emitted once, only after the durable transaction commits.
 // It is a one-shot instruction, not a replayable capability. Another next() will
 // reconcile the same operation even if this process died before invoking it.
 next(id,{postAvailable=true,transport=null}={}){return this.transaction(()=>{
  const j=this.get(id);requireThat(j,'Unknown Producer request');const now=clock(this.now());
  transport??=j.detail.recovery_id?'managed_proxy':'direct';requireThat(['direct','managed_proxy'].includes(transport),'Known upload transport required');
  if(j.detail.delivery?.complete)return {type:'done',next_action:'none',...this.summary(j),write_allowed:false};
  if(j.detail.source_ts)return this.readAction(j,'delivery_pending');
  if(j.detail.existing)return this.sourceAction(j,'existing_original_intake');
  for(const name of ['ticket','post','complete']){
   const op=this.activeOp(id,name);
   if(op?.phase==='confirmed')continue;
   if(op&&!(name==='post'&&op.phase==='not_executed')){
    if(name==='complete')return this.sourceAction(j,'completion_outcome_unknown');
    return {type:'blocked',next_action:'reconcile_original_operation',reason:op.result?.metrics?.http_status===401?'original_ticket_rejected_or_expired':'write_outcome_unknown',operation:name,operation_id:op.operation_id,attempt:op.attempt,...this.summary(j),write_allowed:false};
   }
   if(op&&now<op.at+postRetryDelay(op.attempt))return {type:'wait',next_action:'wait_same_operation',next_attempt_at:op.at+postRetryDelay(op.attempt),...this.summary(j),write_allowed:false};
   if(!j.detail.preflight_at||now<j.detail.preflight_at||now-j.detail.preflight_at>=READ_TTL_MS)return this.readAction(j);
   if(name==='post'&&!postAvailable)return {type:'blocked',next_action:'restore_original_ticket',...this.summary(j),write_allowed:false};
   const attempt=(this.op(id,this.activeName(id,name))?.attempt??0)+1,operation_id=randomUUID();
   this.db.prepare("INSERT INTO producer_ops VALUES(?,?,?,?,'unknown',?,NULL)").run(id,this.activeName(id,name),attempt,operation_id,now);
   this.save(j,{...j.detail,preflight_at:null}); // One fresh read authorizes one write, never a reservation.
   const action={type:'write',next_action:name,operation_id,attempt,...this.summary(j),write_allowed:true};
   if(name==='ticket')return {...action,tool:PRODUCER_TOOLS.ticket,arguments:{filename:'ai-brief-bundle.json',content_length:j.bundle.length}};
   if(name==='post')return {...action,adapter:transport==='managed_proxy'?'producer_curl_managed_proxy_v1':'producer_curl_direct_v1',url_sha256:j.detail.url_sha256,method:'POST',content_type:'application/json',same_ticket_only:true};
   return {...action,tool:PRODUCER_TOOLS.complete,arguments:{file_id:j.detail.file_id,channel_id:this.scope.channel_id,initial_comment:`!ai-report publish ${j.id} ${j.hash}`}};
  }
  return this.sourceAction(j,'completion_acknowledged_not_verified');
 });}
 record(action,result){
  return this.transaction(()=>{
   const j=this.get(action.request_id),op=j&&this.activeOp(j.id,action.next_action);
   requireThat(op&&op.operation_id===action.operation_id&&op.attempt===action.attempt&&action.bundle_sha256===j.hash&&action.bundle_bytes===j.bundle.length,'Original operation binding required');
   requireThat(op.phase==='unknown'||op.phase==='confirmed'||op.phase==='not_executed','Invalid operation state');
   let phase='unknown',safe=null,detail=j.detail;
   if(action.next_action==='ticket'){
    const t=producerTicket(result);phase='confirmed';safe={file_id:t.file_id,url_sha256:t.url_sha256};
    requireThat(!detail.file_id||detail.file_id===t.file_id,'Replacement file is forbidden');detail={...detail,...safe};
   }else if(action.next_action==='post'){
    exact(result,['adapter','file_id','url_sha256','bundle_sha256','metrics']);
    requireThat(['producer_curl_direct_v1','producer_curl_managed_proxy_v1'].includes(result.adapter)&&result.adapter===action.adapter&&result.file_id===detail.file_id&&result.url_sha256===detail.url_sha256&&result.bundle_sha256===j.hash,'Original POST binding required');
    const metrics=postMetrics(result.metrics);phase=postOutcome(metrics,j.bundle.length);if(result.adapter==='producer_curl_managed_proxy_v1'&&phase!=='confirmed')phase='unknown';safe={...result,metrics};
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
 observeDownstream(id,e,{inTransaction=false,inspectQueryId=null}={}){const apply=()=>{
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
  this.save(j,{...j.detail,...source,preflight_at:e.observed_at,preflight_query_id:inspectQueryId,preflight_empty:!e.publisher&&!e.scheduler&&!e.scheduler_day_claim&&e.publisher_day.length===0,existing:!!e.publisher,publisher_source_ts:e.publisher?.source_ts??null,publisher_commit:e.publisher?.report_commit??null,delivery});return this.summary(this.get(id));
 };return inTransaction?apply():this.transaction(apply);}
 observeSource(id,e){return this.transaction(()=>{
  const j=this.get(id);requireThat(j,'Unknown Producer request');
  const proof=verifyControlUpload(e,this.scope,{bytes:j.bundle,id,kind:'publish'},clock(this.now()));
  requireThat(!j.detail.file_id||j.detail.file_id===proof.file_id,'Original file differs; never replace it');
  requireThat(!j.detail.source_ts||j.detail.source_ts===proof.source_ts,'Original source differs');
  requireThat(!j.detail.publisher_source_ts||j.detail.publisher_source_ts===proof.source_ts,'Publisher source differs');
  requireThat(j.detail.existing||this.activeOp(id,'complete'),'No original intake operation to reconcile');
  this.save(j,{...j.detail,...proof});return this.summary(this.get(id));
 });}
}

// An agent can bridge native tools with this adapter; there is no invented shell
// native API. External mutations happen only for the newly returned write action.
export class ProducerUploadAdapter{
 constructor(state,io,{transport='direct',restart=null}={}){requireThat(['direct','managed_proxy'].includes(transport),'Known upload transport required');this.state=state;this.io=io;this.transport=transport;this.tickets=new Map();this.restart=restart;this.startupTickets=new Map();if(restart)for(const j of state.db.prepare('SELECT id FROM producer_runs').all()){const op=state.activeOp(j.id,'ticket');if(op)this.startupTickets.set(j.id,{operation_id:op.operation_id,inspect_attempt:state.db.prepare('SELECT COALESCE(MAX(attempt),0) n FROM producer_inspect_queries WHERE run_id=?').get(j.id).n});}}
 restoreTicket(id,result){const j=this.state.get(id),t=producerTicket(result);requireThat(j&&j.detail.file_id===t.file_id&&j.detail.url_sha256===t.url_sha256,'Restore only the original ticket');this.tickets.set(id,t);}
 async step(id){
  const j=this.state.get(id);requireThat(j,'Unknown Producer request');
  // Check availability inside next(), after fresh reads but before POST intent.
  const transport=j.detail.recovery_id?'managed_proxy':this.transport;
  if(this.restart&&!this.tickets.has(id)&&this.startupTickets.has(id)){
   await this.restart.requireLock();
   const recovered=this.state.recoverAbandonedTicket(id,{...this.startupTickets.get(id),started_at:this.restart.started_at});
   if(recovered){if(recovered.type==='ticket_abandoned')this.startupTickets.delete(id);return recovered;}
  }
  const action=this.state.next(id,{postAvailable:this.tickets.has(id),transport});
  if(action.type!=='write')return action;
  try{
   let result;
   if(action.next_action==='ticket'){
    result=await this.io.callTool(action.tool,action.arguments,action);
    const ticket=producerTicket(result);this.state.record(action,result);this.tickets.set(id,ticket);return this.state.summary(this.state.get(id));
   }
   if(action.next_action==='post'){
    const t=this.tickets.get(id);requireThat(t,'Original ticket unavailable');
    result=await this.io.upload({bytes:j.bundle,ticket:t,transport});
   }else {const reply=await this.io.callTool(action.tool,action.arguments,action);result={acknowledged:!!reply&&!reply.isError&&Array.isArray(reply.content)};}
   this.state.record(action,result);
  }catch{
   // The intent already says unknown. Do not log the transport exception: it may
   // contain the signed URL, request headers, response text or authentication.
  }
  return this.state.summary(this.state.get(id));
 }
}
