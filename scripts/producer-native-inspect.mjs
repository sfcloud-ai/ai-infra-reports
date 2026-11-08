// Native Slack inspection bridge. Parse the actual formatted tool envelope,
// never fabricate app_id/bot_id from JSON supplied in a message body.
import {randomUUID} from 'node:crypto';
import {digest} from './archive.mjs';
import {requireThat} from './report-handoff.mjs';
import {READ_TTL_MS} from './producer-upload.mjs';
const TOOLS={send:'mcp__codex_apps__slack_slack_send_message',search:'mcp__codex_apps__slack_slack_search_public_and_private',thread:'mcp__codex_apps__slack_slack_read_thread'};
const TS=/^\d{10}\.\d{6}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const INSPECT_REFRESH_MS=5*60000;
const exact=(v,keys)=>requireThat(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join(),'Unexpected inspect evidence fields');
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const equal=(a,b)=>{exact(a,Object.keys(b));for(const k of Object.keys(b))requireThat(JSON.stringify(a[k])===JSON.stringify(b[k]),'Native inspect invocation changed');};
function toolBody(invocation,tool,args){
 requireThat(invocation?.tool===tool,'Actual native read invocation required');equal(invocation.arguments,args);
 const r=invocation.result;requireThat(r&&!r.isError&&r.content?.length===1&&r.content[0].type==='text'&&typeof r.content[0].text==='string'&&Buffer.byteLength(r.content[0].text)<=128*1024,'Native inspect read incomplete');
 return JSON.parse(r.content[0].text);
}
// Native formatting may expand a fixed user mention to its known ChatGPT label.
// Keep the exact ID and all surrounding footer text; arbitrary aliases are not
// identity evidence and are not accepted as alternative footer renderings.
function footers(text){return [...new Set([text,text.replace(/<@(U[A-Z0-9]+)>/g,'<@$1|ChatGPT>')])];}
function command(j,q){requireThat(q&&UUID.test(q.query_id)&&q.query_id===q.operation_id,'Original nonce-bound inspect query required');return `!ai-report inspect ${j.id} ${j.date} ${j.hash} ${q.query_id}`;}
export const INSPECT_SCHEMA=Object.freeze({
 producer_inspect_scope:'CREATE TABLE producer_inspect_scope(id INTEGER PRIMARY KEY CHECK(id=1),hash TEXT NOT NULL)',
 producer_inspect_queries:'CREATE TABLE producer_inspect_queries(run_id TEXT NOT NULL,attempt INTEGER NOT NULL,operation_id TEXT UNIQUE NOT NULL,started_at INTEGER NOT NULL,after_ts TEXT NOT NULL,source_ts TEXT UNIQUE,receipt_ts TEXT,receipt_hash TEXT,phase TEXT NOT NULL,query_id TEXT UNIQUE NOT NULL CHECK(query_id=operation_id),PRIMARY KEY(run_id,attempt))'
});
export function producerInspectScope(config){
 exact(config,['publisher_user_id','publisher_bot_id','workspace_host']);
 requireThat(/^U[A-Z0-9]+$/.test(config.publisher_user_id)&&/^B[A-Z0-9]+$/.test(config.publisher_bot_id)&&/^[a-z0-9-]+\.slack\.com$/.test(config.workspace_host),'Pinned native Publisher identity required');
 return Object.freeze({...config});
}
export function producerInspectScopeHash(config){const c=producerInspectScope(config);return digest(JSON.stringify([c.publisher_user_id,c.publisher_bot_id,c.workspace_host]));}
export class ProducerInspect{
 constructor(state,config){
  this.state=state;this.config=producerInspectScope(config);
  state.db.exec(Object.values(INSPECT_SCHEMA).map(sql=>sql.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ')).join(';'));
  const h=producerInspectScopeHash(config);state.db.prepare('INSERT OR IGNORE INTO producer_inspect_scope VALUES(1,?)').run(h);
  requireThat(state.db.prepare('SELECT hash FROM producer_inspect_scope WHERE id=1').get().hash===h,'Original inspect identity changed');
 }
 query(id){return this.state.db.prepare('SELECT * FROM producer_inspect_queries WHERE run_id=? ORDER BY attempt DESC LIMIT 1').get(id)??null;}
 sourceArguments(j,q){return {keywords:['"!ai-report inspect"',`"${j.id}"`,`"${j.date}"`,`"${j.hash}"`,`"${q.query_id}"`],filters:`in:<#${this.state.scope.channel_id}> from:<@${this.state.scope.sender_user_id}>`,after:q.after_ts,natural_language_query:'',channel_types:'private_channel',content_types:'messages',include_bots:true,include_context:false,response_format:'detailed',limit:2,sort:'timestamp',sort_dir:'desc'};}
 threadArguments(q){return {channel_id:this.state.scope.channel_id,message_ts:q.source_ts,limit:100,response_format:'detailed'};}
 next(id){return this.state.transaction(()=>{
  const j=this.state.get(id);requireThat(j,'Original Producer request required');const now=this.state.now();requireThat(Number.isSafeInteger(now)&&now>0,'Host clock required');
  const q=this.query(id);
  const common={request_id:id,report_date:j.date,bundle_sha256:j.hash};
  if(q)command(j,q); // Refuse pre-nonce rows; never synthesize their old wire identity.
  if(q&&q.phase!=='resolved'&&now<q.started_at+INSPECT_REFRESH_MS)return {type:'read',next_action:q.source_ts?'read_inspect_thread':'locate_original_inspect',operation_id:q.operation_id,attempt:q.attempt,tool:q.source_ts?TOOLS.thread:TOOLS.search,arguments:q.source_ts?this.threadArguments(q):this.sourceArguments(j,q),...common,write_allowed:false};
  if(j.detail.preflight_at&&now>=j.detail.preflight_at&&now-j.detail.preflight_at<READ_TTL_MS)return {type:'wait',next_action:'wait_inspect_refresh',next_attempt_at:j.detail.preflight_at+READ_TTL_MS,...common,write_allowed:false};
  const after_ts=Math.max((now-30000)/1000,Number(q?.receipt_ts??0)+0.000001).toFixed(6),operation_id=randomUUID(),attempt=(q?.attempt??0)+1;
  this.state.db.prepare("INSERT INTO producer_inspect_queries VALUES(?,?,?,?,?,NULL,NULL,NULL,'unknown',?)").run(id,attempt,operation_id,now,after_ts,operation_id);
  return {type:'write',next_action:'inspect',operation_id,attempt,tool:TOOLS.send,arguments:{channel_id:this.state.scope.channel_id,message:command(j,{operation_id,query_id:operation_id}),unfurl_app_links:false},...common,write_allowed:true};
 });}
 observeSource(id,invocation){return this.state.transaction(()=>{
  const j=this.state.get(id),q=this.query(id);requireThat(j&&q&&q.phase!=='resolved','Original pending inspect required');
  const args=this.sourceArguments(j,q),body=toolBody(invocation,TOOLS.search,args);exact(body,['results','pagination_info']);
  requireThat(['End of results - No more pages available.\n','End of results - No more pages available.\\n'].includes(body.pagination_info)&&typeof body.results==='string','Complete original inspect search required');
  if(/^# Search Results for: [^\n]*\n\nNo results found\.\n$/.test(body.results))return {type:'pending',next_action:'locate_original_inspect',write_allowed:false};
  const head=/^# Search Results for: [^\n]*\n\n## Messages \(([12]) results\)\n/.exec(body.results);requireThat(head,'Ambiguous inspect search');
  const count=Number(head[1]),candidates=[];let at=head[0].length;
  for(let i=1;i<=count;i++){
   const pattern=new RegExp('### Result '+i+' of '+count+'\\nChannel: (?:#[^\\n]+|DM) \\(ID: ([CG][A-Z0-9]+)\\)\\nFrom: [^\\n]+ \\(ID: (U[A-Z0-9]+)\\) (?: \\[BOT\\])?\\nTime: [^\\n]+\\nMessage_ts: (\\d{10}\\.\\d{6})\\n(?:Reply count: \\d+\\n)?Permalink: \\[link\\]\\((https:\\/\\/[^\\n]+)\\)\\nText: \\n([\\s\\S]*?)\\n\\n---\\n\\n','y');pattern.lastIndex=at;const m=pattern.exec(body.results);
   requireThat(m&&m[1]===this.state.scope.channel_id&&m[2]===this.state.scope.sender_user_id,'Unexpected inspect source metadata');at=pattern.lastIndex;
   const u=new URL(m[4]),keys=[...u.searchParams.keys()].sort().join();requireThat(u.hostname===this.config.workspace_host&&!u.port&&!u.username&&!u.password&&!u.hash&&u.pathname===`/archives/${m[1]}/p${m[3].replace('.','')}`&&(keys===''||(keys==='cid,thread_ts'&&u.searchParams.get('cid')===m[1]&&u.searchParams.get('thread_ts')===m[3])),'Inspect source must be the original top-level message');
   requireThat([command(j,q),...footers(this.state.scope.sender_attribution_text).flatMap(footer=>[command(j,q)+' '+footer,command(j,q)+'\n'+footer])].includes(m[5]),'Original inspect command differs');
   // Native search may round after to seconds. Filter the actual six-digit TS
   // locally, not by trusting the provider's claimed window or sort precision.
   if(m[3]>=q.after_ts)candidates.push(m[3]);
  }
  requireThat(at===body.results.length&&candidates.length<=1,'Ambiguous original inspect source');
  if(!candidates.length)return {type:'pending',next_action:'locate_original_inspect',write_allowed:false};
  const located={source_ts:candidates[0]};
  requireThat(Number(located.source_ts)*1000<=this.state.now()+30000&&(!q.source_ts||q.source_ts===located.source_ts),'Original inspect source differs');
  this.state.db.prepare("UPDATE producer_inspect_queries SET source_ts=?,phase='located' WHERE operation_id=?").run(located.source_ts,q.operation_id);
  return {type:'located',source_ts:located.source_ts,write_allowed:false};
 });}
 observeReceipt(id,invocation){
  const j=this.state.get(id),q=this.query(id);requireThat(j&&q&&q.source_ts,'Locate original inspect before reading its receipt');
  const body=toolBody(invocation,TOOLS.thread,this.threadArguments(q));exact(body,['messages','pagination_info']);
  requireThat(['There are no more messages in this thread.\n','There are no more messages in this thread.\\n'].includes(body.pagination_info)&&typeof body.messages==='string','Complete native inspect thread required');
  const s=this.state.scope,c=this.config;
  // The From IDs, bot address, parent/reply counts and timestamps come from the
  // actual native tool envelope, not lines located inside arbitrary body text.
  const pattern='^=== THREAD PARENT MESSAGE ===\\nFrom: [^\\n<>]+ <[^\\n<>]+> \\('+escape(s.sender_user_id)+'\\)\\nTime: [^\\n]+\\nMessage TS: '+escape(q.source_ts)+'\\n'+escape(command(j,q))+'\\n'+'(?:'+footers(s.sender_attribution_text).map(escape).join('|')+')'+'\\n\\n=== THREAD REPLIES \\(1 total\\) ===\\n\\n--- Reply 1 of 1 ---\\nFrom: [^\\n<>]+ <botuser-'+escape(s.team_id)+'-'+escape(c.publisher_bot_id)+'@slack-bots\\.com> \\('+escape(c.publisher_user_id)+'\\)\\nTime: [^\\n]+\\nMessage TS: (\\d{10}\\.\\d{6})\\n!ai-report inspect-receipt ([^\\n]+)\\n$';
  const match=new RegExp(pattern).exec(body.messages);requireThat(match&&TS.test(match[1])&&match[1]>q.source_ts&&Number(match[1])*1000<=this.state.now()+30000,'Untrusted inspect parent, Publisher or reply structure');
  const r=JSON.parse(match[2]);
  exact(r,['query_id','request_id','report_date','bundle_sha256','source_ts','read_context','observed_at','complete','publisher_day','publisher','scheduler_day_claim','scheduler']);
  requireThat(r.query_id===q.query_id&&r.request_id===id&&r.report_date===j.date&&r.bundle_sha256===j.hash&&r.source_ts===q.source_ts&&r.complete===true,'Inspect original query binding differs');
  requireThat(Number.isSafeInteger(r.observed_at)&&r.observed_at>=Number(q.source_ts)*1000-30000&&r.observed_at<=this.state.now()&&r.observed_at<=Number(match[1])*1000+30000,'Inspect observation clock differs');
  const {query_id,request_id,report_date,bundle_sha256,source_ts,...evidence}=r;
  const fresh=this.state.now()-r.observed_at<READ_TTL_MS;
  requireThat(evidence.read_context?.publisher_scope_sha256===s.publisher_scope_sha256&&evidence.read_context.scheduler_scope_sha256===s.scheduler_scope_sha256,'Inspect original read scope differs');
  // Stale authenticated receipts resolve this read query but grant no upload.
  // This allows a new inspection without replaying an uncertain query send.
  this.state.transaction(()=>{
   const latest=this.query(id);requireThat(latest?.operation_id===q.operation_id,'Inspect changed while verifying');
   const receipt_hash=digest(match[2]);requireThat(!latest.receipt_hash||(latest.receipt_hash===receipt_hash&&latest.receipt_ts===match[1]),'Original inspect receipt changed');
   if(fresh&&latest.phase!=='resolved'){requireThat(q.started_at>=Math.max(j.detail.recovery_at??0,j.detail.restart_recovery_at??0),'Post-recovery inspect required');this.state.observeDownstream(id,evidence,{inTransaction:true,inspectQueryId:q.query_id});}
   this.state.db.prepare("UPDATE producer_inspect_queries SET receipt_ts=?,receipt_hash=?,phase='resolved' WHERE operation_id=?").run(match[1],receipt_hash,q.operation_id);
  });
  return {type:fresh?'state':'stale_inspect',...this.state.summary(this.state.get(id)),write_allowed:false};
 }
}
