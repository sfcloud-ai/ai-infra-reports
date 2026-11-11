// Private, immutable research checkpoints. This storage lane grants no research
// ownership, publication permission, or budget; those require separate policy.
import {digest} from './archive.mjs';
import {acceptDataCommand,acceptReadCommand,canonicalRequestDate,reportDate,requireThat} from './report-handoff.mjs';
import {handoffScope,scopeDigest} from './handoff-state.mjs';
import {assertSubmission} from './slack-submission.mjs';
import {safeDiagnostic,recoveryDelay,isSlackWriteUnexecuted} from './handoff-recovery.mjs';

const HASH=/^[a-f0-9]{64}$/, UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TS=/^\d{10}\.\d{6}$/;
export const ARCHIVE_LIMIT=16*1024*1024, ARCHIVE_CHUNK=8192;
export const ARCHIVE_SCHEMA={
 research_archive_policy:'CREATE TABLE research_archive_policy(id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL,evidence_reference TEXT NOT NULL)',
 research_archive_events:"CREATE TABLE research_archive_events(source_ts TEXT PRIMARY KEY,kind TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,file_id TEXT,query TEXT,phase TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER NOT NULL DEFAULT 0,diagnostic TEXT,reply_text TEXT,reply_ts TEXT)",
 research_archives:'CREATE TABLE research_archives(command_id TEXT PRIMARY KEY,report_date TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,previous_hash TEXT,manifest TEXT NOT NULL,bytes BLOB NOT NULL,source_ts TEXT UNIQUE NOT NULL,file_id TEXT NOT NULL)',
 research_archive_heads:'CREATE TABLE research_archive_heads(report_date TEXT PRIMARY KEY,hash TEXT NOT NULL)'
};
const keys=(v,wanted)=>v&&Object.keys(v).sort().join()===wanted.split(',').sort().join();
function rejectArchive(code,expected_head){
 const error=Error(code);error.researchRejection={stage:'research_archive',code,outcome:'rejected',...(expected_head!==undefined?{expected_head}: {})};throw error;
}
export function validateArchiveConfig(c){
 requireThat(keys(c,'generation,activation_ts,first_report_date')&&typeof c.generation==='string'&&UUID.test(c.generation)&&typeof c.activation_ts==='string'&&TS.test(c.activation_ts)&&reportDate(c.first_report_date),'Explicit research archive activation required');
 return c;
}
function binding(c){
 validateArchiveConfig(c.research_archive);
 requireThat(c.slack_submission&&c.durable_intake&&c.sender_user_app_id,'Research archive requires authenticated durable staging');
 requireThat(c.research_archive.activation_ts>=c.slack_submission.activation_ts&&c.research_archive.first_report_date>=c.slack_submission.first_report_date,'Research archive predates staging');
 const {generation,activation_ts,first_report_date}=c.research_archive;
 return JSON.stringify({generation,activation_ts,first_report_date,publisher_scope_sha256:scopeDigest(handoffScope(c)),submission_generation:c.slack_submission.generation});
}
export function assertResearchArchive(db,c){
 const rows=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'research_archive%'").all();
 if(!c.research_archive){requireThat(!rows.length,'Installed research archive cannot be removed');return false;}
 assertSubmission(db,c);
 requireThat(rows.length===4&&rows.every(r=>r.sql===ARCHIVE_SCHEMA[r.name]),'Original research archive schema required');
 const policy=db.prepare('SELECT * FROM research_archive_policy').all();
 requireThat(policy.length===1&&policy[0].id===1&&policy[0].binding===binding(c),'Original research archive binding required');
 return true;
}
export function installResearchArchive(db,c,reference){
 const value=binding(c);assertSubmission(db,c);
 requireThat(typeof reference==='string'&&reference.length>0&&reference.length<=512,'Reviewed archive migration reference required');
 requireThat(!db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'research_archive%'").get(),'Research archive already exists; never reinstall');
 db.exec('BEGIN IMMEDIATE');try{
  for(const sql of Object.values(ARCHIVE_SCHEMA))db.exec(sql);
  db.prepare('INSERT INTO research_archive_policy VALUES(1,?,?)').run(value,reference);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function decodeResearchArchive(bytes){
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=ARCHIVE_LIMIT,'Bounded research archive required');
 const v=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
 requireThat(keys(v,'schema_version,command_id,request_id,report_date,previous_sha256,files')&&v.schema_version==='research_archive_v1'&&typeof v.command_id==='string'&&UUID.test(v.command_id)&&reportDate(v.report_date)&&v.request_id===`morning-${v.report_date.replaceAll('-','')}-r1`&&(v.previous_sha256===null||typeof v.previous_sha256==='string'&&HASH.test(v.previous_sha256)),'Exact research archive identity required');
 requireThat(Array.isArray(v.files)&&v.files.length>0&&v.files.length<=128,'Bounded research files required');
 const seen=new Set();let total=0;
 const files=v.files.map(f=>{
  requireThat(keys(f,'path,sha256,content_base64')&&typeof f.path==='string'&&f.path.length<=200&&/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]+)*$/.test(f.path)&&f.path.split('/').every(x=>x!=='.'&&x!=='..')&&!seen.has(f.path)&&typeof f.sha256==='string'&&HASH.test(f.sha256)&&typeof f.content_base64==='string','Exact private research file required');
  seen.add(f.path);const data=Buffer.from(f.content_base64,'base64');
  requireThat(data.toString('base64')===f.content_base64&&data.length<=8*1024*1024&&digest(data)===f.sha256,'Research file bytes differ');
  total+=data.length;requireThat(total<=12*1024*1024,'Research checkpoint byte limit');
  return {path:f.path,sha256:f.sha256,bytes:data.length,data};
 });
 return {value:v,files,hash:digest(bytes)};
}
export function acceptResearchArchive(message,c,now,window){
 if(!c.research_archive)return null;
 const save=acceptDataCommand(message,c,'!ai-research save ',/^!ai-research save (morning-\d{8}-r1) ([a-f0-9]{64})$/,now,window);
 let result=save?{...save,kind:'save',query:null}:null;
 if(!result){
  const read=acceptReadCommand(message,c,'!ai-research read ',/^!ai-research read (morning-\d{8}-r1) ([a-f0-9-]{36}) (head|manifest|file|receipt) (head|[a-f0-9]{64}) (0|[1-9]\d{0,7})$/,now,window);
  if(!read)return null;
  const [,request_id,query_id,action,hash,offset]=read.match;
  requireThat(UUID.test(query_id)&&(action!=='head'||hash==='head'&&offset==='0')&&(!['file','receipt'].includes(action)||HASH.test(hash))&&(action!=='receipt'||offset==='0'),'Exact research read required');
  result={kind:'read',request_id,source_ts:read.source_ts,hash:read.hash,file_id:null,query:{query_id,action,hash,offset:Number(offset)}};
 }
 requireThat(canonicalRequestDate(result.request_id)>=c.research_archive.first_report_date&&result.source_ts>=c.research_archive.activation_ts,'Research command outside activation');
 return result;
}
// Queue in the same transaction as the existing fixed history checkpoint.
export function queueResearchArchive(db,event){
 const value={source_ts:event.source_ts,kind:event.kind,request_id:event.request_id,hash:event.hash,file_id:event.file_id??null,query:event.query?JSON.stringify(event.query):null};
 const prior=db.prepare('SELECT * FROM research_archive_events WHERE source_ts=?').get(value.source_ts);
 if(prior){requireThat(Object.entries(value).every(([k,v])=>prior[k]===v),'Original research envelope changed');return;}
 // Refuse new research work without rolling back unrelated report commands
 // or the shared history watermark. Existing commands retain their identity.
 if(db.prepare('SELECT count(*) n FROM research_archive_events').get().n>=100000)return {source_ts:event.source_ts,stage:'research_command',code:'research_command_capacity',outcome:'not_started',retryable:false};
 db.prepare('INSERT INTO research_archive_events(source_ts,kind,request_id,hash,file_id,query) VALUES(?,?,?,?,?,?)').run(...Object.values(value));
}
export function storeResearchArchive(db,event,bytes){
 let decoded;try{decoded=decodeResearchArchive(bytes);}catch{rejectArchive('invalid_archive');}
 const {value,files,hash}=decoded;
 if(hash!==event.hash||value.request_id!==event.request_id)rejectArchive('archive_envelope_mismatch');
 const prior=db.prepare('SELECT hash FROM research_archives WHERE command_id=? OR hash=?').all(value.command_id,hash);
 if(prior.length){if(prior.length!==1||prior[0].hash!==hash)rejectArchive('archive_command_id_conflict');return {hash,command_id:value.command_id,already_stored:true};}
 const head=db.prepare('SELECT hash FROM research_archive_heads WHERE report_date=?').get(value.report_date);
 if((head?.hash??null)!==value.previous_sha256){
  const parent=value.previous_sha256?db.prepare('SELECT request_id FROM research_archives WHERE hash=?').get(value.previous_sha256):null;
  if(value.previous_sha256&&!parent){const error=Error('archive_parent_unavailable');error.researchDeferred={stage:'research_archive',code:'archive_parent_unavailable',outcome:'not_stored',expected_head:head?.hash??null};throw error;}
  if(parent&&parent.request_id!==value.request_id)rejectArchive('archive_parent_scope_conflict');
  rejectArchive('archive_predecessor_conflict',head?.hash??null);
 }
 if(db.prepare('SELECT count(*) n FROM research_archives WHERE report_date=?').get(value.report_date).n>=256)rejectArchive('archive_checkpoint_capacity');
 if(db.prepare('SELECT coalesce(sum(length(bytes)),0) n FROM research_archives').get().n+bytes.length>2*1024*1024*1024)rejectArchive('archive_storage_capacity');
 const manifest=JSON.stringify(files.map(({data,...f})=>f));
 db.prepare('INSERT INTO research_archives VALUES(?,?,?,?,?,?,?,?,?)').run(value.command_id,value.report_date,value.request_id,hash,value.previous_sha256,manifest,bytes,event.source_ts,event.file_id);
 db.prepare('INSERT INTO research_archive_heads VALUES(?,?) ON CONFLICT(report_date) DO UPDATE SET hash=excluded.hash').run(value.report_date,hash);
 return {hash,command_id:value.command_id,already_stored:false};
}
export function readResearchArchive(db,id,q){
 requireThat(keys(q,'query_id,action,hash,offset')&&UUID.test(q.query_id)&&['head','manifest','file','receipt'].includes(q.action)&&Number.isSafeInteger(q.offset)&&q.offset>=0,'Exact research query required');
 const day=canonicalRequestDate(id),head=db.prepare('SELECT hash FROM research_archive_heads WHERE report_date=?').get(day)?.hash??null;
 const common={request_id:id,report_date:day,query_id:q.query_id,head_sha256:head};
 if(q.action==='head')return {...common,status:head?'stored':'not_found'};
 if(q.action==='receipt'){
  const stored=db.prepare('SELECT command_id,source_ts,file_id FROM research_archives WHERE request_id=? AND hash=?').get(id,q.hash);
  const events=db.prepare("SELECT source_ts,phase,diagnostic FROM research_archive_events WHERE kind='save' AND request_id=? AND hash=? ORDER BY source_ts DESC LIMIT 8").all(id,q.hash).map(r=>({...r,diagnostic:r.diagnostic?JSON.parse(r.diagnostic):null}));
  return {...common,archive_sha256:q.hash,status:stored?'stored':events.length?events.every(r=>r.diagnostic?.outcome==='rejected')?'rejected':'pending':'not_found',stored:stored??null,events};
 }
 const hash=q.hash==='head'?head:q.hash;
 const row=hash?db.prepare('SELECT command_id,previous_hash,manifest,source_ts,file_id FROM research_archives WHERE request_id=? AND hash=?').get(id,hash):null;
 if(q.action==='manifest'){
  if(!row)return {...common,archive_sha256:hash,status:'not_found'};
  const files=JSON.parse(row.manifest);
  if(q.offset>files.length)return {...common,archive_sha256:hash,status:'rejected',code:'invalid_manifest_offset'};
  return {...common,archive_sha256:hash,command_id:row.command_id,previous_sha256:row.previous_hash,archive_source_ts:row.source_ts,file_id:row.file_id,files:files.slice(q.offset,q.offset+32),next_offset:q.offset+32<files.length?q.offset+32:null};
 }
 // File hashes are restricted to this request; no arbitrary host path access.
 const entries=db.prepare('SELECT hash,manifest FROM research_archives WHERE request_id=?').all(id);
 const owner=entries.find(r=>JSON.parse(r.manifest).some(f=>f.sha256===q.hash));
 if(!owner)return {...common,sha256:q.hash,status:'not_found'};
 const packet=db.prepare('SELECT bytes FROM research_archives WHERE hash=?').get(owner.hash);
 const f=decodeResearchArchive(Buffer.from(packet.bytes)).files.find(f=>f.sha256===q.hash);
 if(q.offset>f.bytes||q.offset%ARCHIVE_CHUNK!==0)return {...common,sha256:q.hash,status:'rejected',code:'invalid_file_offset'};
 const chunk=f.data.subarray(q.offset,q.offset+ARCHIVE_CHUNK);
 return {...common,sha256:f.sha256,total_bytes:f.bytes,offset:q.offset,content_base64:chunk.toString('base64'),chunk_sha256:digest(chunk),next_offset:q.offset+chunk.length<f.bytes?q.offset+chunk.length:null};
}
export async function advanceResearchArchive(state,c,slack,now=Date.now()){
 const db=state.db;if(!assertResearchArchive(db,c))return;
 // An uncertain advisory reply never prevents later queries of committed data.
 const row=db.prepare("SELECT * FROM research_archive_events WHERE phase IN ('pending','ready') AND next_at<=? ORDER BY last_attempt,source_ts LIMIT 1").get(now);
 if(!row)return;
 db.prepare('UPDATE research_archive_events SET last_attempt=? WHERE source_ts=?').run(now,row.source_ts);
 try{
  if(row.phase==='pending'){
   let result;
   if(row.kind==='save'){
    const message=await slack.exactPublish(row.source_ts);
    const original=acceptResearchArchive(message,c,now,{from:c.research_archive.activation_ts,to:row.source_ts});
    requireThat(original&&['kind','request_id','hash','file_id'].every(k=>original[k]===row[k]),'Original research file source changed');
    const bytes=await slack.download(row,{name:'ai-brief-research-archive.json',limit:ARCHIVE_LIMIT});
    db.exec('BEGIN IMMEDIATE');try{
     result=storeResearchArchive(db,row,bytes);
     const text='!ai-research receipt '+JSON.stringify({request_id:row.request_id,source_ts:row.source_ts,status:'stored',...result});
     db.prepare("UPDATE research_archive_events SET phase='ready',reply_text=?,diagnostic=NULL WHERE source_ts=?").run(text,row.source_ts);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
   }else{
    result=readResearchArchive(db,row.request_id,JSON.parse(row.query));
    const text='!ai-research receipt '+JSON.stringify({source_ts:row.source_ts,...result});
    requireThat(Buffer.byteLength(text)<=16384,'Bounded research receipt required');
    db.prepare("UPDATE research_archive_events SET phase='ready',reply_text=?,diagnostic=NULL WHERE source_ts=?").run(text,row.source_ts);
   }
  }
  const ready=db.prepare('SELECT reply_text FROM research_archive_events WHERE source_ts=?').get(row.source_ts);
  slack.assertReady?.('chat.postMessage');
  db.prepare("UPDATE research_archive_events SET phase='sending' WHERE source_ts=?").run(row.source_ts);
  try{
   const ts=await slack.controlReceipt(row.source_ts,ready.reply_text);requireThat(TS.test(ts),'Research receipt timestamp required');
   db.prepare("UPDATE research_archive_events SET phase='sent',reply_ts=? WHERE source_ts=?").run(ts,row.source_ts);
  }catch(e){
   db.prepare('UPDATE research_archive_events SET phase=? WHERE source_ts=?').run(isSlackWriteUnexecuted(e)?'ready':'unknown',row.source_ts);throw e;
  }
 }catch(e){
  if(e.researchRejection||e.slackFileRejection==='invalid_metadata'){
   const diagnostic=e.researchRejection??{stage:'research_archive',code:'invalid_file_metadata',outcome:'rejected'};
   const text='!ai-research receipt '+JSON.stringify({request_id:row.request_id,source_ts:row.source_ts,status:'rejected',archive_sha256:row.hash,...diagnostic});
   db.prepare("UPDATE research_archive_events SET phase='ready',next_at=0,diagnostic=?,reply_text=? WHERE source_ts=?").run(JSON.stringify(diagnostic),text,row.source_ts);
   return;
  }
  const diagnostic=e.researchDeferred??safeDiagnostic(e,'research_archive');
  // Keep an already-decided storage rejection if its advisory reply is lost.
  db.prepare("UPDATE research_archive_events SET attempts=attempts+1,next_at=?,diagnostic=CASE WHEN json_extract(diagnostic,'$.outcome')='rejected' THEN diagnostic ELSE ? END WHERE source_ts=?").run(Math.max(now+recoveryDelay(row.attempts+1),diagnostic.retry_at??0),JSON.stringify(diagnostic),row.source_ts);
  return {source_ts:row.source_ts,...diagnostic};
 }
}
