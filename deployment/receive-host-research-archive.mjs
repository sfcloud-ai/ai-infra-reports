import {constants,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {digest} from '../scripts/archive.mjs';
import {withHandoffLock} from '../scripts/handoff-lock.mjs';
import {assertIntakeScope} from '../scripts/publisher-inbox.mjs';
import {isRepositoryResearchPlan} from '../scripts/research-budget.mjs';
import {ARCHIVE_LIMIT,assertResearchArchive,decodeResearchArchive,storeResearchArchive,verifiedHostProvenance} from '../scripts/research-archive.mjs';
import {assertResearchControl} from '../scripts/research-control.mjs';
import {storedRecoveryForOperation} from '../scripts/research-archive-recovery.mjs';
import {privateDirectory,privateFile,validateLiveConfig,PUBLISHER_LEDGER_LIMIT} from '../scripts/run-handoff.mjs';

const inbox='/var/lib/report-publisher/host-archive-inbox';
const guard=readFileSync(new URL('./host-archive-guard.sql',import.meta.url),'utf8').replaceAll('\r\n','\n').trim();
const hashPattern=/^[a-f0-9]{64}$/;
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
class ReceiptRefusal extends Error {}
function check(ok,message){if(!ok)throw new ReceiptRefusal(message);}
export function receiptFailure(error){
 if(error instanceof ReceiptRefusal&&error.message==='Original controls not yet scanned')return {status:'deferred',reason:'intake_before_owner_handoff'};
 if(error instanceof ReceiptRefusal&&error.message==='Queued research mutation')return {status:'deferred',reason:'queued_research_mutation'};
 if(error instanceof ReceiptRefusal)return {status:'rejected',reason:error.message.toLowerCase().replace(/[^a-z0-9]+/g,'_')};
 if(error.researchDeferred?.code==='archive_parent_unavailable')return {status:'deferred',reason:'archive_parent_unavailable'};
 const code=error.researchRejection?.code;
 if(['invalid_archive','archive_envelope_mismatch','archive_command_id_conflict','repository_inputs_must_be_references',
    'archive_parent_scope_conflict','archive_predecessor_conflict','archive_checkpoint_capacity','archive_storage_capacity'].includes(code))
  return {status:'rejected',reason:code};
 if(error.code==='ENOENT')return {status:'rejected',reason:'required_private_input_missing'};
 return {status:'unknown',reason:'inspect_original_archive_receipt'};
}

async function operatorBytes(hash){
 check(hashPattern.test(hash),'Expected original SHA-256');
 const parent=await lstat(inbox);
 check(await realpath(inbox)===inbox&&parent.isDirectory()&&parent.uid===0&&parent.gid===process.getgid()&&(parent.mode&0o7777)===0o750,'Unsafe host receipt inbox');
 const file=await open(path.join(inbox,hash+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const s=await file.stat();
  check(s.isFile()&&s.uid===0&&s.gid===parent.gid&&s.nlink===1&&(s.mode&0o7777)===0o440&&s.size>0&&s.size<=ARCHIVE_LIMIT,'Unsafe host archive');
  const bytes=await file.readFile();
  check(bytes.length===s.size&&digest(bytes)===hash,'Staged original bytes changed');
  return bytes;
 }finally{await file.close();}
}

// Operator custody confirms archive bytes. It does not acknowledge a Slack POST,
// complete an upload, select a checkpoint, grant publication, or enqueue delivery.
export function receiveHostArchive(db,{request,operation,file,hash,lastControl},bytes){
 check(/^morning-\d{8}-r1$/.test(request)&&uuid.test(operation)&&/^F[A-Z0-9]+$/.test(file)&&hashPattern.test(hash),'Invalid archive identity');
 check(bytes.length>0&&bytes.length<=ARCHIVE_LIMIT&&digest(bytes)===hash,'Archive bytes differ');
 let value;
 try{({value}=decodeResearchArchive(bytes));}catch{throw new ReceiptRefusal('Invalid research archive');}
 check(value.request_id===request,'Archive request differs');
 db.exec('BEGIN IMMEDIATE');
 try{
  const run=db.prepare('SELECT report_date,permit,plan FROM research_control_runs WHERE request_id=?').get(request);
  const policy=db.prepare('SELECT binding FROM research_control_policy WHERE id=1').get();
  check(policy&&JSON.parse(policy.binding).protocol==='repository_inputs_v1'&&run&&isRepositoryResearchPlan(JSON.parse(Buffer.from(run.plan))),'Active repository research authority required');
  const ticket=db.prepare('SELECT kind,operation_key,input,phase,native_result FROM research_control_ops WHERE request_id=? AND operation_id=?').get(request,operation);
  const key='archive:'+hash+':';
  check(run?.report_date===value.report_date&&ticket?.kind==='native'&&ticket.operation_key===key+'ticket'&&ticket.phase==='acknowledged','Confirmed original ticket required');
  const input=JSON.parse(ticket.input),result=JSON.parse(ticket.native_result);
  check(input.step==='ticket'&&input.permit_id===null&&input.file_id===null&&input.source_ts===null&&input.archive_sha256===hash&&input.sha256===hash&&input.bytes===bytes.length&&
        result?.file_id===file&&result.source_ts===null&&result.sha256===hash&&result.bytes===bytes.length,'Original ticket binding differs');
  check(!db.prepare('SELECT 1 FROM research_control_ops WHERE request_id=? AND operation_key IN (?,?)').get(request,key+'post',key+'complete'),'An original POST or completion requires reconciliation');
  const localFile='t4-sha256:'+hash, prefix='t4-receipt:'+operation+':';
  let prior=db.prepare('SELECT request_id,source_ts,file_id,bytes FROM research_archives WHERE hash=?').get(hash);
  const installed=db.prepare("SELECT sql FROM sqlite_master WHERE name='host_archive_native_guard'").get();
  const hasReceipt=db.prepare("SELECT 1 FROM research_archives WHERE file_id='t4-sha256:'||hash LIMIT 1").get();
  check(!!installed===!!hasReceipt&&(!installed||installed.sql===guard),'Host receipt guard requires reconciliation');
  if(!prior){
   // The owner pauses submissions and identifies its last original mutation.
   // Its existing Slack timestamp can predate an outage.
   const scanned=db.prepare("SELECT 1 FROM publisher_intake_scan WHERE id=1 AND watermark>=? AND upper_bound IS NULL AND page_cursor IS NULL");
   check(typeof lastControl==='string'&&/^\d{10}\.\d{6}$/.test(lastControl)&&scanned.get(lastControl),'Original controls not yet scanned');
   const controls=db.prepare(`SELECT max(source_ts) AS latest, max(phase='pending') AS pending FROM research_control_events
     WHERE json_extract(CAST(bytes AS TEXT),'$.request_id')=?
     AND json_extract(CAST(bytes AS TEXT),'$.action') NOT IN ('status','status_part','upload_status','receipt','archive_recovery_status')`).get(request);
   check(!controls.pending,'Queued research mutation');
   check(controls.latest===lastControl,'Original control handoff differs');
   const replies=db.prepare("SELECT reply_text FROM research_control_events WHERE phase IN ('ready','sending','unknown') AND reply_text LIKE '!ai-research control-receipt %'");
   const intent=db.prepare("SELECT 1 FROM research_control_ops WHERE request_id=? AND operation_id=? AND phase='intent'");
   for(const row of replies.iterate()){
    const reply=JSON.parse(row.reply_text.slice('!ai-research control-receipt '.length));
    check(!(reply.request_id===request&&reply.dispatch_granted&&reply.operations?.some(op=>intent.get(request,op.operation_id)&&!storedRecoveryForOperation(db,request,op.operation_id))),'Unresolved research control requires reconciliation');
   }
   // A pending share can coexist with this receipt when the archive worker
   // authenticated its bytes and found it waiting for this exact parent.
   const competing=db.prepare(`WITH saves AS (
    SELECT e.*,CASE WHEN json_extract(diagnostic,'$.code')='archive_parent_unavailable' THEN diagnostic
      ELSE json_extract(diagnostic,'$.verified_parent') END AS parent FROM research_archive_events e WHERE e.kind='save')
    SELECT 1 FROM research_control_ops o
    WHERE o.request_id=? AND o.kind='native' AND (o.operation_key GLOB 'archive:*:post' OR o.operation_key GLOB 'archive:*:complete')
    AND NOT EXISTS (SELECT 1 FROM research_archives a WHERE a.request_id=o.request_id AND a.hash=json_extract(o.input,'$.archive_sha256'))
    AND NOT EXISTS (SELECT 1 FROM saves e JOIN research_control_ops c ON c.request_id=e.request_id
      AND c.kind='native' AND c.operation_key='archive:'||e.hash||':complete'
      WHERE e.request_id=o.request_id
      AND e.hash=json_extract(o.input,'$.archive_sha256') AND e.file_id=json_extract(o.input,'$.file_id')
      AND (c.native_result IS NULL OR (json_extract(c.native_result,'$.source_ts')=e.source_ts
        AND json_extract(c.native_result,'$.file_id')=e.file_id AND json_extract(c.native_result,'$.sha256')=e.hash))
      AND ((c.phase='acknowledged' AND c.native_result IS NOT NULL AND json_extract(e.diagnostic,'$.outcome')='rejected'
        AND json_extract(e.diagnostic,'$.code') IN ('invalid_file_metadata','invalid_archive','archive_envelope_mismatch','archive_command_id_conflict',
          'repository_inputs_must_be_references','archive_parent_scope_conflict','archive_predecessor_conflict'))
       OR (e.phase='pending' AND json_extract(e.parent,'$.outcome')='not_stored'
         AND json_extract(e.parent,'$.source_ts')=e.source_ts AND json_extract(e.parent,'$.file_id')=e.file_id
         AND json_extract(e.parent,'$.request_id')=e.request_id AND json_extract(e.parent,'$.child_sha256')=e.hash
         AND json_type(e.parent,'$.expected_head') IS NOT NULL AND json_extract(e.parent,'$.expected_head') IS ?
         AND json_extract(e.parent,'$.missing_parent_sha256')=?))) LIMIT 1`).get(request,value.previous_sha256,hash);
   check(!competing,'Unresolved archive upload requires reconciliation');
   const waitingChildren=db.prepare(`SELECT DISTINCT hash FROM research_archive_events
    WHERE request_id=? AND kind='save' AND phase='pending'
      AND coalesce(json_extract(diagnostic,'$.missing_parent_sha256'),json_extract(diagnostic,'$.verified_parent.missing_parent_sha256'))=? LIMIT 2`).all(request,hash);
   check(waitingChildren.length<2,'Competing archive children require reconciliation');
   check(run.permit===null,'Original publication already permitted');
   check(!db.prepare('SELECT 1 FROM research_archive_events WHERE request_id=? AND hash=? AND kind=?').get(request,hash,'save'),'An original Slack save requires reconciliation');
   const source=prefix+new Date().toISOString();
   storeResearchArchive(db,{request_id:request,hash,file_id:localFile,source_ts:source},bytes);
   prior=db.prepare('SELECT request_id,source_ts,file_id,bytes FROM research_archives WHERE hash=?').get(hash);
  }
  check(prior?.request_id===request&&prior.file_id===localFile&&prior.source_ts.startsWith(prefix)&&Buffer.from(prior.bytes).equals(bytes),'Original archive provenance conflict');
  if(!installed)db.exec(guard);
  check(verifiedHostProvenance(db,prior,hash)?.host_receipt_id===prior.source_ts,'Original archive provenance conflict');
  const receipt={transport:'t4_host_archive',request_id:request,original_ticket:operation,original_slack_file:file,sha256:hash,bytes:bytes.length,receipt_id:prior.source_ts};
  const pages=db.prepare('PRAGMA page_count').get().page_count;
  const pageSize=db.prepare('PRAGMA page_size').get().page_size;
  check(pages*pageSize<=PUBLISHER_LEDGER_LIMIT,'Publisher ledger size limit');
  db.exec('COMMIT');
  return receipt;
 }catch(error){db.exec('ROLLBACK');throw error;}
}

export async function receiveStagedHostArchive(configFile,request,operation,file,hash,lastControl,directory){
 const loaded=JSON.parse(await privateFile(configFile,16384));
 check(loaded.state_dir===directory,'Publisher state directory differs');
 const config=validateLiveConfig(loaded);
 await privateDirectory(directory);
 const bytes=await operatorBytes(hash);
 return withHostArchiveLedger(directory,db=>{
  assertIntakeScope(db,config);
  check(assertResearchArchive(db,config)&&assertResearchControl(db,config),'Original archive and research authorities required');
  return receiveHostArchive(db,{request,operation,file,hash,lastControl},bytes);
 });
}

function publisherStopped(){
 const probe=spawnSync('/bin/systemctl',['show','ai-report-publisher.service','--property=ActiveState,SubState,MainPID'],
  {encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C'}});
 if(probe.status!==0)return false;
 const fields=new Set(probe.stdout.trim().split('\n'));
 return fields.has('MainPID=0')&&fields.has('ActiveState=inactive')&&fields.has('SubState=dead');
}

export async function withHostArchiveLedger(directory,receive,checkStopped=publisherStopped){
 return withHandoffLock(directory,async()=>{
  const ledger=path.join(directory,'handoff.sqlite');
  await privateFile(ledger,PUBLISHER_LEDGER_LIMIT,false);
  // Recheck the stopped service under the ledger writer's lock.
  const controller=fileURLToPath(new URL('./publisher_cd.py',import.meta.url));
  const script=`import runpy,sys
from pathlib import Path
controller,ledger=sys.argv[1:]
cd=runpy.run_path(controller)
try: cd['snapshot'](Path(ledger),settled=True,fingerprint=False)
except cd['Deferred']: sys.exit(75)`;
  const probe=spawnSync('python3',['-I','-B','-c',script,controller,ledger],{env:{PATH:'/usr/bin:/bin:/usr/local/bin'},stdio:'ignore',timeout:300000,killSignal:'SIGKILL'});
  if(probe.error?.code==='ETIMEDOUT')return {status:'deferred',reason:'ledger_validation_timed_out'};
  if(probe.status===75)return {status:'deferred',reason:'unsettled_publisher_ledger'};
  check(probe.status===0,'Publisher ledger validation failed');
  if(!checkStopped())return {status:'deferred',reason:'publisher_must_be_stopped'};
  const db=new DatabaseSync(pathToFileURL(ledger).href+'?mode=rw');
  try{return await receive(db);}finally{db.close();}
 });
}
