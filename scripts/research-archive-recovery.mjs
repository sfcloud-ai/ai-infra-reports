// Explicit compensation on the original authenticated control lane. Never replay
// an uncertain POST, change its outcome, or create a replacement Slack file.
import {digest} from './archive.mjs';
import {storeResearchArchive} from './research-archive.mjs';
export const ARCHIVE_RECOVERY_VERSION=1;
export const ARCHIVE_RECOVERY_SCHEMA='CREATE TABLE research_control_archive_recovery(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1))';
export const ARCHIVE_RECOVERY_TRANSPORT='authenticated_control_chunks_v1';
const LIMIT=65536,CHUNK=1024;
const exact=(v,k)=>v&&Object.keys(v).sort().join()===k.split(',').sort().join();
const fail=code=>{throw Object.assign(Error(code),{researchControlCode:code});};
const need=(value,code)=>{if(!value)fail(code);};
// First explicit begin installs a permanent fail-closed release fence in its
// transaction. Old runtimes reject this extra authority table, including when
// launched by an old rollback driver that does not know the capability.
export function assertArchiveRecoveryFence(db){
 const row=db.prepare("SELECT type,sql FROM sqlite_master WHERE name='research_control_archive_recovery'").get();
 if(!row){
  need(!db.prepare("SELECT 1 FROM research_control_commands WHERE json_extract(bytes,'$.action')='archive_recovery_begin' AND json_extract(result,'$.status')='committed' LIMIT 1").get(),'archive_recovery_fence_missing');
  return false;
 }
 need(row.type==='table'&&row.sql===ARCHIVE_RECOVERY_SCHEMA,'archive_recovery_fence_schema');
 const versions=db.prepare('SELECT id,version FROM research_control_archive_recovery').all();
 need(versions.length===1&&versions[0].id===1&&versions[0].version===ARCHIVE_RECOVERY_VERSION,'archive_recovery_fence_version');
 return true;
}
function installArchiveRecoveryFence(db){
 if(assertArchiveRecoveryFence(db))return;
 db.exec(ARCHIVE_RECOVERY_SCHEMA);
 db.prepare('INSERT INTO research_control_archive_recovery VALUES(1,?)').run(ARCHIVE_RECOVERY_VERSION);
}
function commands(db,id){return db.prepare("SELECT bytes,result FROM research_control_commands WHERE request_id=? AND json_extract(result,'$.status')='committed' AND json_extract(bytes,'$.action') LIKE 'archive_recovery_%' ORDER BY rowid").all(id).map(row=>({command:JSON.parse(Buffer.from(row.bytes)),result:JSON.parse(row.result)}));}
function original(db,id,args){
 const op=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? AND operation_id=?').get(id,args.operation_id);
 need(op&&op.kind==='native'&&['intent','unknown'].includes(op.phase),'archive_recovery_original_unknown');
 const input=JSON.parse(op.input);
 need(input.permit_id===null&&input.step==='post'&&input.archive_sha256===args.archive_sha256&&input.sha256===args.archive_sha256&&input.file_id===args.file_id&&input.bytes===args.total_bytes&&op.operation_key==='archive:'+args.archive_sha256+':post','archive_recovery_original_binding');
 const ticket=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? AND operation_key=?').get(id,'archive:'+args.archive_sha256+':ticket');
 need(ticket?.phase==='acknowledged'&&JSON.parse(ticket.native_result).file_id===args.file_id,'archive_recovery_original_ticket');
 need(!db.prepare('SELECT 1 FROM research_control_ops WHERE request_id=? AND operation_key=?').get(id,'archive:'+args.archive_sha256+':complete'),'archive_recovery_completion_exists');
 return op;
}
export function recoveryForOperation(db,id,operationId){return commands(db,id).find(({command})=>command.action==='archive_recovery_begin'&&command.args.operation_id===operationId)?.command??null;}
function observation(db,id,recoveryId){
 const rows=commands(db,id),begin=rows.find(({command})=>command.command_id===recoveryId&&command.action==='archive_recovery_begin');
 need(begin,'archive_recovery_not_found');
 const commit=rows.find(({command})=>command.action==='archive_recovery_commit'&&command.args.recovery_id===recoveryId);
 const chunks=rows.filter(({command})=>command.action==='archive_recovery_chunk'&&command.args.recovery_id===recoveryId);
 return {begin:begin.command,commit,chunks};
}
export function readArchiveRecovery(db,id,recoveryId){
 const {begin,commit,chunks}=observation(db,id,recoveryId);
 return {recovery_id:recoveryId,transport:ARCHIVE_RECOVERY_TRANSPORT,...begin.args,original_post_outcome:'unknown',status:commit?'stored':'receiving',received_offsets:[...new Set(chunks.map(row=>row.command.args.offset))].sort((a,b)=>a-b),source_ts:commit?.result.recovery.source_ts??null};
}
export function archiveRecoveryEvidence(db,id,hash){
 const begin=commands(db,id).find(({command})=>command.action==='archive_recovery_begin'&&command.args.archive_sha256===hash);
 if(!begin)return null;
 return readArchiveRecovery(db,id,begin.command.command_id);
}
export function applyArchiveRecovery(db,c,commandHash){
 if(c.action==='archive_recovery_begin'){
  const a=c.args;
  need(exact(a,'operation_id,archive_sha256,file_id,total_bytes,reason')&&a.reason==='original_post_unknown'&&typeof a.operation_id==='string'&&/^[a-f0-9-]{36}$/.test(a.operation_id)&&typeof a.archive_sha256==='string'&&/^[a-f0-9]{64}$/.test(a.archive_sha256)&&typeof a.file_id==='string'&&/^[A-Z0-9]{1,128}$/.test(a.file_id)&&Number.isSafeInteger(a.total_bytes)&&a.total_bytes>0&&a.total_bytes<=LIMIT,'archive_recovery_fields');
  original(db,c.request_id,a);
  need(!recoveryForOperation(db,c.request_id,a.operation_id),'archive_recovery_already_started');
  need(!db.prepare('SELECT 1 FROM research_archives WHERE request_id=? AND hash=?').get(c.request_id,a.archive_sha256),'archive_recovery_already_stored');
  installArchiveRecoveryFence(db);
  return {recovery_id:c.command_id,transport:ARCHIVE_RECOVERY_TRANSPORT,status:'receiving',original_post_outcome:'unknown',...a};
 }
 need(typeof c.args.recovery_id==='string','archive_recovery_fields');
 const state=observation(db,c.request_id,c.args.recovery_id),a=state.begin.args;
 original(db,c.request_id,a);
 if(c.action==='archive_recovery_chunk'){
  need(exact(c.args,'recovery_id,offset,content_base64,chunk_sha256')&&!state.commit,'archive_recovery_chunk_fields');
  const {offset,content_base64,chunk_sha256}=c.args;
  need(Number.isSafeInteger(offset)&&offset>=0&&offset<a.total_bytes&&offset%CHUNK===0&&typeof content_base64==='string','archive_recovery_chunk_offset');
  const bytes=Buffer.from(content_base64,'base64');
  need(bytes.toString('base64')===content_base64&&bytes.length===Math.min(CHUNK,a.total_bytes-offset)&&digest(bytes)===chunk_sha256,'archive_recovery_chunk_bytes');
  const prior=state.chunks.find(row=>row.command.args.offset===offset);
  need(!prior||prior.command.args.content_base64===content_base64,'archive_recovery_chunk_conflict');
  return {recovery_id:state.begin.command_id,status:'receiving',offset,chunk_sha256};
 }
 need(c.action==='archive_recovery_commit'&&exact(c.args,'recovery_id'),'archive_recovery_fields');
 if(state.commit)return state.commit.result.recovery;
 const chunks=[];
 for(let offset=0;offset<a.total_bytes;offset+=CHUNK){const row=state.chunks.find(row=>row.command.args.offset===offset);need(row,'archive_recovery_chunk_missing');chunks.push(Buffer.from(row.command.args.content_base64,'base64'));}
 const bytes=Buffer.concat(chunks);need(bytes.length===a.total_bytes&&digest(bytes)===a.archive_sha256,'archive_recovery_archive_hash');
 const event=db.prepare('SELECT source_ts FROM research_control_events WHERE command_id=? AND hash=?').get(c.command_id,commandHash);
 need(event,'archive_recovery_authenticated_event_required');
 try{storeResearchArchive(db,{request_id:c.request_id,hash:a.archive_sha256,file_id:a.file_id,source_ts:event.source_ts},bytes);}catch(error){fail(error.researchRejection?.code??error.researchDeferred?.code??'archive_recovery_storage_failed');}
 return {recovery_id:state.begin.command_id,transport:ARCHIVE_RECOVERY_TRANSPORT,status:'stored',archive_sha256:a.archive_sha256,file_id:a.file_id,operation_id:a.operation_id,source_ts:event.source_ts,original_post_outcome:'unknown'};
}

// Only a committed compensation and its exact stored archive make a prior
// unknown dispatch nonblocking. The original operation/event stay unchanged.
export function storedRecoveryForOperation(db,id,operationId){
 const begin=recoveryForOperation(db,id,operationId);if(!begin)return null;
 const evidence=readArchiveRecovery(db,id,begin.command_id);
 if(evidence.status!=='stored')return null;
 const stored=db.prepare('SELECT bytes,file_id,source_ts FROM research_archives WHERE request_id=? AND hash=?').get(id,evidence.archive_sha256);
 if(!stored||stored.file_id!==evidence.file_id||stored.source_ts!==evidence.source_ts||Buffer.from(stored.bytes).length!==evidence.total_bytes||digest(Buffer.from(stored.bytes))!==evidence.archive_sha256)return null;
 return evidence;
}
