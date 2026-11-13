// Independent, read-only publication/delivery checks. Only the optional alert
// lane writes: its own journal, shared quota metadata and the private control room.
import {DatabaseSync} from 'node:sqlite';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,open,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {privateFile,privateDirectory,validateConfig} from './run-handoff.mjs';
import {handoffScope,scopeDigest} from './handoff-state.mjs';
import {decodeBundle,requireThat,SHA,boundedBytes} from './report-handoff.mjs';
import {validateScheduledConfig} from './scheduled-delivery-bridge.mjs';
import {SlackHandoff} from './slack-handoff.mjs';
import {withHandoffReadLock,isHandoffLockBusy} from './handoff-lock.mjs';
import {safeDiagnostic} from './handoff-recovery.mjs';
import {openProviderCooldowns} from './provider-cooldowns.mjs';

export function validateWatchdogConfig(c){
 requireThat(c&&Object.keys(c).sort().join()==='deadline_grace_seconds,heartbeat_max_age_seconds,publisher_config,state_dir,unit','Explicit watchdog configuration required');
 for(const key of ['publisher_config','state_dir'])requireThat(typeof c[key]==='string'&&path.isAbsolute(c[key])&&!c[key].includes('\0'),'Absolute watchdog path required');
 requireThat(typeof c.unit==='string'&&/^[a-zA-Z0-9_.@-]+\.service$/.test(c.unit),'Fixed Publisher unit required');
 requireThat(Number.isSafeInteger(c.heartbeat_max_age_seconds)&&c.heartbeat_max_age_seconds>=120&&c.heartbeat_max_age_seconds<=900,'Bounded heartbeat age required');
 requireThat(Number.isSafeInteger(c.deadline_grace_seconds)&&c.deadline_grace_seconds>=0&&c.deadline_grace_seconds<=900,'Bounded delivery grace required');
 return c;
}
export function shanghaiDay(now=Date.now()){
 requireThat(Number.isFinite(now),'Valid watchdog clock required');
 const date=new Date(now+8*3600000).toISOString().slice(0,10);
 return {date,due:Date.parse(date+'T08:00:00+08:00')};
}
export function checkPublisherHealth(health,service,{now=Date.now(),maxAgeSeconds=300}={}){
 const issues=[];
 if(!service)issues.push('publisher_service_unavailable');
 else if(service.active!=='active'||service.sub!=='running'||!Number.isSafeInteger(service.pid)||service.pid<=0)issues.push('publisher_not_running');
 if(!health||typeof health!=='object')return [...issues,'heartbeat_unavailable'];
 const checked=Date.parse(health.checked_at);
 if(!Number.isFinite(checked)||checked>now+30000||now-checked>maxAgeSeconds*1000)issues.push('heartbeat_stale');
 if(health.healthy!==true)issues.push('publisher_unhealthy');
 if(service){
  if(service.process_alive===null)issues.push('publisher_process_unavailable');
  else if(service.pid!==health.pid||!service.process_alive)issues.push('heartbeat_process_mismatch');
  const directory=service.directory,commit=typeof directory==='string'?path.basename(directory):'';
  if(!SHA.test(commit)||health.commit!==commit||(service.process_alive===true&&service.process_directory!==directory))issues.push('heartbeat_release_mismatch');
 }
 return [...new Set(issues)];
}
export async function readPublisherService(unit){
 const {stdout}=await promisify(execFile)('/usr/bin/systemctl',['show',unit,'--property=ActiveState,SubState,MainPID,WorkingDirectory'],{timeout:10000,maxBuffer:8192,encoding:'utf8',windowsHide:true});
 const data=Object.fromEntries(stdout.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
 const pid=Number(data.MainPID);let process_alive=false,process_directory=null;
 if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);process_directory=await realpath('/proc/'+pid+'/cwd');process_alive=true;}catch(error){process_alive=['ESRCH','ENOENT'].includes(error.code)?false:null;}}
 return {active:data.ActiveState,sub:data.SubState,pid,directory:data.WorkingDirectory,process_alive,process_directory};
}
// Never open HandoffState here: its constructor creates/migrates writable tables.
export async function readDayBindings(config,date){
 let stage='watchdog.ledger.stat';
 try{
  const filename=path.join(config.state_dir,'handoff.sqlite');await privateFile(filename,10*1024*1024*1024,false);
  stage='watchdog.ledger.query';
  try{return await queryDayBindings(filename,config,date);}
  catch(error){
   // A closed WAL writer removes its sidecars. SQLite may need writable sidecars
   // even for a read-only connection. A read-only mount can report CANTOPEN
   // instead of READONLY; both use a locked copy, never writable Publisher state.
   if(error.code!=='ERR_SQLITE_ERROR'||!Number.isInteger(error.errcode)||![8,14].includes(error.errcode&255))throw error;
  }
  stage='watchdog.ledger.snapshot_create';
  const directory=await mkdtemp(path.join(os.tmpdir(),'publisher-watchdog-snapshot-'));
  try{
   const snapshot=path.join(directory,'handoff.sqlite');
   stage='watchdog.ledger.snapshot_lock';
   await withHandoffReadLock(config.state_dir,async()=>{
    // All Publisher writers hold the exclusive lock. Copy the WAL as well so a
    // terminated writer's committed transactions are not lost. Rebuild only the
    // temporary copy's SHM; do not copy a potentially stale shared-memory index.
    stage='watchdog.ledger.snapshot_copy';
    await privateFile(filename,10*1024*1024*1024,false);await copyFile(filename,snapshot);
    try{await privateFile(filename+'-wal',10*1024*1024*1024,false);await copyFile(filename+'-wal',snapshot+'-wal');}
    catch(error){if(error.code!=='ENOENT')throw error;}
   });
   stage='watchdog.ledger.snapshot_query';
   return await queryDayBindings(snapshot,config,date);
  }finally{
   try{await rm(directory,{recursive:true,force:true});}
   catch(error){stage='watchdog.ledger.snapshot_cleanup';throw error;}
  }
 }catch(error){
  const failure=error instanceof Error?error:Error('Publisher ledger read failed');
  failure.diagnostic={...failure.diagnostic,stage};throw failure;
 }
}
async function queryDayBindings(filename,config,date){
 const db=new DatabaseSync(filename,{readOnly:true});
 try{
  db.exec('BEGIN');
  requireThat(db.prepare('SELECT value FROM scope WHERE id=1').get()?.value===scopeDigest(handoffScope(config)),'Publisher scope differs');
  // Reject excessive matches using IDs alone, then decode one bundle at a time.
  // Keep both reads in one snapshot so a concurrent writer cannot change them.
  const rows=db.prepare("SELECT id FROM jobs WHERE json_extract(CAST(bytes AS TEXT),'$.files[0].path') LIKE ? ORDER BY source_ts LIMIT 102").all('reports/'+date+'/%');
  requireThat(rows.length<=101,'Ambiguous daily report count');
  const bindings=[],read=db.prepare('SELECT id,hash,bytes,detail FROM jobs WHERE id=?');
  for(const {id} of rows){
   const row=read.get(id);
   const bundle=await decodeBundle(Buffer.from(row.bytes)),detail=JSON.parse(row.detail);
   requireThat(bundle.hash===row.hash&&bundle.data.request_id===row.id&&bundle.report.date===date,'Publisher report binding differs');
   bindings.push({request_id:row.id,report_date:date,bundle_sha256:row.hash,report_commit:detail.commit??null,published:detail.proof?.publication_status==='verified'&&detail.proof?.commit===detail.commit&&detail.proof?.bundle_sha256===row.hash,...(bundle.report.revision_notice?{report_revision:bundle.report.revision,revision_kind:bundle.report.revision_notice.kind}:{})});
  }
  return bindings;
 }finally{db.close();}
}
// A shorter independent read timeout prevents a stalled scheduler from hiding a
// Publisher-down alert. The request is constructed here and can only be status.
export function schedulerStatus(config,requestId){
 validateScheduledConfig(config);
 return new Promise((resolve,reject)=>{
  const child=spawn(config.executable,config.args,{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env:{LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'}});
  let done=false,size=0;const chunks=[];
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(Error('Scheduler status unavailable'));}else resolve(result);};
  const timer=setTimeout(()=>finish(true),30000);
  child.on('error',()=>finish(true));child.stdin.on('error',()=>finish(true));
  child.stdout.on('data',part=>{size+=part.length;if(size>16384)finish(true);else chunks.push(part);});
  child.on('close',code=>{try{if(code!==0)throw Error();finish(null,JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{finish(true);}});
  child.stdin.end(JSON.stringify({action:'status',request_id:requestId}));
 });
}
export async function checkDailyDelivery(bindings,query){
 if(!bindings.length)return {issues:['daily_report_missing']};
 if(bindings.some(b=>b.report_revision!==undefined))return checkRevisionDeliveries(bindings,query);
 if(bindings.length!==1)return {issues:['daily_report_ambiguous']};
 const binding=bindings[0],base={request_id:binding.request_id};
 if(!binding.published||!SHA.test(binding.report_commit??''))return {...base,issues:['daily_report_unpublished']};
 let result;try{result=await query(binding.request_id);}catch{return {...base,issues:['scheduler_status_unavailable']};}
 if(result?.status==='not_found')return {...base,issues:['daily_delivery_not_admitted']};
 if(!result||['request_id','report_date','report_commit','bundle_sha256'].some(key=>result[key]!==binding[key]))return {...base,issues:['daily_delivery_binding_mismatch']};
 const counts=Number.isSafeInteger(result.parts_total)&&result.parts_total>=2&&Number.isSafeInteger(result.parts_sent)&&result.parts_sent>=0&&result.parts_sent<=result.parts_total;
 const poster=Array.isArray(result.images)&&result.images.length===1&&result.images[0].file_id==='scheduled-poster'&&result.images[0].status==='sent'&&result.images[0].error==null;
 const complete=counts&&poster&&result.status==='sent'&&result.phase==='complete'&&result.parts_sent===result.parts_total;
 return {...base,...(counts?{parts_sent:result.parts_sent,parts_total:result.parts_total}:{}),issues:complete?[]:['daily_delivery_incomplete']};
}

async function checkRevisionDeliveries(bindings,query){
 const day=bindings[0].report_date,ids=new Set(),versions=new Set();let legacy=0;
 for(const b of bindings){
  if(ids.has(b.request_id)||b.report_date!==day)return {issues:['daily_report_ambiguous']};ids.add(b.request_id);
  if(b.report_revision===undefined){legacy++;continue;}
  if(!Number.isSafeInteger(b.report_revision)||b.report_revision<=1||versions.has(b.report_revision)||b.request_id!==`morning-${day.replaceAll('-','')}-r${b.report_revision}`)return {issues:['daily_report_ambiguous']};
  versions.add(b.report_revision);
 }
 if(legacy>1||bindings.length>101)return {issues:['daily_report_ambiguous']};
 // 已发首版不会因为下一版仍在 PR 中变成“日报未发布”；发布健康仍由 Publisher 独立监控。
 const published=bindings.filter(b=>b.published&&SHA.test(b.report_commit??''));
 if(!published.length)return {issues:['daily_report_unpublished']};
 const records=new Map(),pending=[...published],deadline=performance.now()+45000;let unavailable=false;
 await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
  while(pending.length){
   const binding=pending.shift();let timer;
   try{
    if(unavailable||performance.now()>=deadline)throw Error('Status read deadline');
    const result=await Promise.race([query(binding.request_id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Status read deadline')),Math.max(1,deadline-performance.now()));})]);
    records.set(binding.request_id,{binding,result});
   }catch{unavailable=true;records.set(binding.request_id,{binding,error:'scheduler_status_unavailable'});}
   finally{clearTimeout(timer);}
  }
 }));
 const issues=new Set();
 const settled=(id,seen=new Set())=>{
  const record=records.get(id);if(!record){issues.add('daily_delivery_binding_mismatch');return false;}
  if(record.error){issues.add(record.error);return false;}
  const {binding:b,result:r}=record,revision=b.report_revision!==undefined;
  if(r?.status==='not_found'){issues.add('daily_delivery_not_admitted');return false;}
  if(!r||['request_id','report_date','report_commit','bundle_sha256'].some(k=>r[k]!==b[k])||revision&&(r.report_revision!==b.report_revision||!['initial','revision_update','web_only','page_completion'].includes(r.delivery_kind))){issues.add('daily_delivery_binding_mismatch');return false;}
  const counts=Number.isSafeInteger(r.parts_total)&&r.parts_total>=0&&Number.isSafeInteger(r.parts_sent)&&r.parts_sent>=0&&r.parts_sent<=r.parts_total;
  if(r.phase==='superseded'){
   const next=records.get(r.superseded_by)?.binding;
   if(counts&&r.parts_sent<r.parts_total&&['queued','failed','partial'].includes(r.status)&&next?.report_revision>(b.report_revision??1)&&!seen.has(id)&&seen.size<=100){seen.add(id);return settled(r.superseded_by,seen);}
  }else{
   const images=r.images??[],poster=Array.isArray(images)&&images.length===1&&images[0].file_id==='scheduled-poster'&&images[0].status==='sent'&&images[0].error==null;
   const skipped=revision&&r.delivery_kind==='web_only'&&r.phase==='skipped'&&r.status==='skipped'&&r.parts_total===0&&r.parts_sent===0&&Array.isArray(images)&&images.length===0;
   const complete=r.status==='sent'&&r.phase==='complete'&&r.parts_sent===r.parts_total&&(revision&&['revision_update','page_completion'].includes(r.delivery_kind)?r.parts_total===1&&Array.isArray(images)&&images.length===0:(!revision||r.delivery_kind==='initial')&&r.parts_total>=2&&poster);
   if(counts&&(skipped||complete))return true;
  }
  issues.add(revision?'revision_delivery_incomplete':'daily_delivery_incomplete');return false;
 };
 for(const {binding} of records.values())settled(binding.request_id);
 if(![...records.values()].some(({binding,result})=>binding.report_revision===undefined||result?.delivery_kind==='initial'))issues.add('daily_original_binding_missing');
 const latest=published.at(-1),result=records.get(latest.request_id)?.result;
 return {request_id:latest.request_id,...(result?{parts_sent:result.parts_sent,parts_total:result.parts_total}:{}),issues:[...issues]};
}
export async function inspectWatchdog(c,publisher,{now=Date.now(),readService=readPublisherService,readHealth=async()=>JSON.parse((await privateFile(path.join(publisher.state_dir,'health.json'),65536)).toString('utf8')),readBindings=readDayBindings,query=id=>schedulerStatus(publisher.scheduled_delivery,id)}={}){
 const [service,health]=await Promise.all([readService(c.unit).catch(()=>null),readHealth().catch(()=>null)]);
 const observations=[{category:'publisher_health',issues:checkPublisherHealth(health,service,{now,maxAgeSeconds:c.heartbeat_max_age_seconds})}];
 const {date,due}=shanghaiDay(now);
 if(date>=publisher.scheduled_delivery.activation_date&&now>=due+c.deadline_grace_seconds*1000){
  let delivery;try{delivery=await checkDailyDelivery(await readBindings(publisher,date),query);}catch(error){delivery={issues:[isHandoffLockBusy(error)?'daily_report_ledger_busy':'daily_report_ledger_unavailable'],error:safeDiagnostic(error,'watchdog.ledger','not_started')};}
  observations.push({category:'delivery:'+date,report_date:date,...delivery});
 }
 return {schema_version:'1.0',checked_at:new Date(now).toISOString(),observations};
}
function canonicalScope(value){
 if(Array.isArray(value))return value.map(canonicalScope);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalScope(value[key])]));
 return value;
}
export class WatchdogJournal{
 constructor(filename,scope){
  this.db=new DatabaseSync(filename);
  try{
  this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS watchdog_scope(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS watchdog_alerts(id TEXT PRIMARY KEY,category TEXT NOT NULL,text TEXT NOT NULL,created REAL NOT NULL,phase TEXT NOT NULL,reply_ts TEXT,active INTEGER NOT NULL,checked REAL NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at REAL NOT NULL DEFAULT 0); CREATE UNIQUE INDEX IF NOT EXISTS watchdog_active_category ON watchdog_alerts(category) WHERE active=1;");
  this.db.exec('CREATE TABLE IF NOT EXISTS watchdog_rate_limits(method TEXT PRIMARY KEY,retry_at INTEGER NOT NULL)');
  const identity=scopeDigest(canonicalScope(scope));
  this.db.prepare('INSERT OR IGNORE INTO watchdog_scope VALUES(1,?)').run(identity);
  requireThat(this.db.prepare('SELECT value FROM watchdog_scope WHERE id=1').get().value===identity,'Watchdog scope changed');
  }catch(error){this.db.close();throw error;}
 }
 observe(observation,checkedAt){
  if(!observation.issues.length){this.db.prepare("UPDATE watchdog_alerts SET active=0,phase=CASE WHEN phase='pending' THEN 'cancelled' ELSE phase END WHERE category=?").run(observation.category);return;}
  const prior=this.db.prepare('SELECT * FROM watchdog_alerts WHERE category=? AND active=1').get(observation.category);if(prior)return prior;
  const id=randomUUID(),text='AI Infra Publisher alert '+JSON.stringify({schema_version:'1.0',alert_id:id,checked_at:checkedAt,...observation});
  this.db.prepare("INSERT OR IGNORE INTO watchdog_alerts(id,category,text,created,phase,reply_ts,active) VALUES(?,?,?,?,'pending',NULL,1)").run(id,observation.category,text,Date.parse(checkedAt)/1000);
  return this.db.prepare('SELECT * FROM watchdog_alerts WHERE category=? AND active=1').get(observation.category);
 }
 pending(){return this.db.prepare("SELECT * FROM watchdog_alerts WHERE phase IN ('pending','sending','unknown') ORDER BY CASE WHEN phase='pending' THEN 0 ELSE 1 END,checked,created,id LIMIT 20").all();}
 methodDeadline(method){return this.db.prepare('SELECT retry_at FROM watchdog_rate_limits WHERE method=?').get(method)?.retry_at??0;}
 methodReady(method,now){return this.methodDeadline(method)<=now;}
 deferMethod(method,retryAt){
  requireThat(['auth.test','conversations.info','conversations.history','chat.postMessage'].includes(method),'Unexpected watchdog method');
  if(!Number.isSafeInteger(retryAt)||retryAt<=0||retryAt>8640000000000000)return;
  this.db.prepare('INSERT INTO watchdog_rate_limits(method,retry_at) VALUES(?,?) ON CONFLICT(method) DO UPDATE SET retry_at=MAX(retry_at,excluded.retry_at)').run(method,retryAt);
 }
 checked(id,now){this.db.prepare('UPDATE watchdog_alerts SET checked=? WHERE id=?').run(now,id);}
 claim(id,now){return this.db.prepare("UPDATE watchdog_alerts SET phase='sending',attempts=attempts+1 WHERE id=? AND phase='pending' AND active=1 AND next_at<=?").run(id,now).changes===1;}
 sent(id,ts){this.db.prepare("UPDATE watchdog_alerts SET phase='sent',reply_ts=? WHERE id=? AND phase IN ('sending','unknown')").run(ts,id);}
 unknown(id){this.db.prepare("UPDATE watchdog_alerts SET phase='unknown' WHERE id=? AND phase='sending'").run(id);}
 rejected(id,now,retryAfter=0){this.db.prepare("UPDATE watchdog_alerts SET phase='pending',next_at=?+MAX(?,MIN(900000,60000*(1 << MIN(attempts-1,4)))) WHERE id=? AND phase='sending'").run(now,Number.isSafeInteger(retryAfter)&&retryAfter>=0&&retryAfter<=86400000?retryAfter:0,id);}
 close(){this.db.close();}
}
// Slack internal/fatal errors can follow partial execution. Unrecognized errors
// also stay unknown; only definitive pre-execution rejection permits a retry.
const ALERT_REJECTIONS=new Set(['not_authed','invalid_auth','token_revoked','token_expired','account_inactive','missing_scope','no_permission','channel_not_found','not_in_channel','is_archived','restricted_action','restricted_action_read_only_channel','no_text','invalid_arguments','invalid_arg_name','invalid_charset','invalid_form_data','invalid_post_type','rate_limited','ratelimited']);
export class WatchdogSlack extends SlackHandoff{
 async alert(text){
  try{this.assertReady('chat.postMessage');}catch(error){throw Object.assign(error,{outcome:'not_sent',retry_at:error.diagnostic?.retry_at});}
  const response=await this.fetcher('https://slack.com/api/chat.postMessage',{method:'POST',headers:{authorization:'Bearer '+this.token,'content-type':'application/json; charset=utf-8'},body:JSON.stringify({channel:this.config.channel_id,text,parse:'none',mrkdwn:false,unfurl_links:false,unfurl_media:false}),redirect:'error',signal:AbortSignal.timeout(30000)});
  // Only Slack's explicit rejection and rate-limit responses prove no post.
  // A timeout, malformed result, 5xx or identity mismatch remains unknown.
  const seconds=response.headers.get('retry-after'),retry_after_ms=/^\d{1,5}$/.test(seconds??'')?Math.min(Number(seconds),86400)*1000:0;
  const rejection=async limited=>{
   const retry_at=limited||retry_after_ms?this.now()+(retry_after_ms||60000):undefined;
   if(retry_at)await this.cooldowns?.defer('chat.postMessage',retry_at);
   return Object.assign(Error('Slack rejected alert'),{outcome:'not_sent',retry_after_ms:limited?(retry_after_ms||60000):retry_after_ms,...(retry_at?{retry_at}:{})});
  };
  if(response.status===429)throw await rejection(true);
  const data=JSON.parse((await boundedBytes(response,65536)).toString('utf8'));
  if(response.ok&&data.ok===false&&ALERT_REJECTIONS.has(data.error))throw await rejection(['ratelimited','rate_limited'].includes(data.error));
  requireThat(data.ok===true,'Slack alert outcome unknown');
  const m=data.message,c=this.config;
  requireThat(data.channel===c.channel_id&&m?.type==='message'&&(!m.subtype||m.subtype==='bot_message')&&m.text===text&&m.user===c.bot_user_id&&m.bot_id===c.bot_id&&!m.edited&&!m.hidden&&(!m.thread_ts||m.thread_ts===data.ts)&&/^\d{10}\.\d{6}$/.test(data.ts)&&m.ts===data.ts,'Alert receipt identity mismatch');
  return data.ts;
 }
 async findAlert(alert){
  const matches=[];let cursor='';
  for(let page=0;page<20;page++){
   const {data}=await this.call('conversations.history',{channel:this.config.channel_id,oldest:(alert.created-60).toFixed(6),limit:100,...(cursor?{cursor}:{})});
   requireThat(Array.isArray(data.messages),'Alert history unavailable');
   matches.push(...data.messages.filter(m=>m.text===alert.text));
   cursor=data.response_metadata?.next_cursor??'';
   if(!data.has_more&&!cursor){
    if(!matches.length)return null;
    const m=matches[0],c=this.config;
    requireThat(matches.length===1&&m.type==='message'&&(!m.subtype||m.subtype==='bot_message')&&m.user===c.bot_user_id&&m.bot_id===c.bot_id&&!m.edited&&!m.hidden&&(!m.thread_ts||m.thread_ts===m.ts)&&(!m.channel||m.channel===c.channel_id)&&(!m.team||m.team===c.team_id)&&/^\d{10}\.\d{6}$/.test(m.ts)&&Number(m.ts)>=alert.created-30,'Alert reconciliation identity mismatch');
    return m.ts;
   }
   requireThat(cursor,'Incomplete alert history');
  }
  throw Error('Alert history exceeds reconciliation bound');
 }
}
export async function advanceWatchdogAlerts(journal,slack,inspection,{now=Date.now()}={}){
 for(const observation of inspection.observations)journal.observe(observation,inspection.checked_at);
 // One mutation per tick, with a durable intent before Slack. Every subsequent
 // attempt on an uncertain alert is read-only, even when no match is found.
 const pending=journal.pending();
 const fresh=pending.find(a=>a.phase==='pending'&&a.active===1&&a.next_at<=now);
 if(fresh&&journal.methodReady('chat.postMessage',now)&&(slack.cooldowns?.deadline('chat.postMessage')??0)<=now&&journal.claim(fresh.id,now)){
  try{const ts=await slack.alert(fresh.text);journal.sent(fresh.id,ts);}catch(error){if(error.outcome==='not_sent'){journal.rejected(fresh.id,now,error.retry_after_ms);journal.deferMethod('chat.postMessage',error.retry_at);}else journal.unknown(fresh.id);}
 }
 // A slow reconciliation of an older alert must not block a new daily alarm.
 for(const alert of pending.filter(a=>a.phase!=='pending').slice(0,2)){
  if(!journal.methodReady('conversations.history',now))break;
  journal.checked(alert.id,now);
  try{const ts=await slack.findAlert(alert);if(ts)journal.sent(alert.id,ts);}catch(error){journal.deferMethod('conversations.history',error?.diagnostic?.retry_at);}
 }
 return journal.pending().map(({id,category,phase})=>({id,category,phase}));
}
export async function runWatchdog(filename,{live=false}={}){
 requireThat(process.platform==='linux'&&process.getuid()>0,'Explicit non-root Linux watchdog required');
 const c=validateWatchdogConfig(JSON.parse((await privateFile(filename,16384)).toString('utf8')));
 const publisher=validateConfig(JSON.parse((await privateFile(c.publisher_config,16384)).toString('utf8')));
 validateScheduledConfig(publisher.scheduled_delivery);
 requireThat(path.resolve(c.state_dir)!==path.resolve(publisher.state_dir),'Watchdog journal must be independent');
 const inspection=await inspectWatchdog(c,publisher);
 if(!live)return {...inspection,alerts_enabled:false};
 const token=(await privateFile(publisher.slack_token_file,8192)).toString('utf8').trim();
 requireThat(/^xoxb-[a-zA-Z0-9-]+$/.test(token),'Dedicated Slack bot token required');
 await privateDirectory(c.state_dir);const file=path.join(c.state_dir,'watchdog.sqlite');
 try{const f=await open(file,'wx',0o600);await f.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 await privateFile(file,16*1024*1024,false);
 const journal=new WatchdogJournal(file,{unit:c.unit,publisher_config:c.publisher_config,publisher_scope:handoffScope(publisher),scheduled_delivery:publisher.scheduled_delivery});
 try{
  const cooldowns=await openProviderCooldowns(publisher,{privateFile,privateDirectory});
  try{
  for(const method of ['auth.test','conversations.info','conversations.history','chat.postMessage']){const deadline=journal.methodDeadline(method);if(deadline)cooldowns.defer(method,deadline);}
  const slack=new WatchdogSlack(publisher,token,fetch,{cooldowns});
  await slack.preflight();
  return {...inspection,alerts_enabled:true,alerts_pending:await advanceWatchdogAlerts(journal,slack,inspection)};
  }finally{cooldowns.close();}
 }finally{journal.close();}
}
export async function watchdogMain(args,{run=runWatchdog,log=console.log,error=console.error}={}){
 try{
  const [config,flag,...extra]=args;requireThat(config&&['--check','--live'].includes(flag)&&!extra.length,'Usage: publisher-watchdog.mjs ABSOLUTE_CONFIG --check|--live');
  const result=await run(config,{live:flag==='--live'});log(JSON.stringify(result));
  return flag==='--live'&&(result.alerts_enabled!==true||!Array.isArray(result.alerts_pending)||result.alerts_pending.length>0)?1:0;
 }catch{error(JSON.stringify({component:'publisher_watchdog',status:'failed',code:'watchdog_check_or_alert_unavailable'}));return 1;}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 process.exitCode=await watchdogMain(process.argv.slice(2));
}
