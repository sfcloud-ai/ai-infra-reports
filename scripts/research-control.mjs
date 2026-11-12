// Host authority for a disposable research client. Replies are observations;
// only a newly committed operation intent can grant one external dispatch.
import {randomUUID} from 'node:crypto';
import {digest,REPOSITORY} from './archive.mjs';
import {canonicalRequestDate,reportDate,requireThat,decodeBundle} from './report-handoff.mjs';
import {assertResearchArchive,decodeResearchArchive} from './research-archive.mjs';
import {handoffScope,scopeDigest} from './handoff-state.mjs';
import {repositoryResearchInputs,repositoryResearchInputsHash,REPOSITORY_RESEARCH_INPUTS_VERSION} from './repository-research-inputs.mjs';
import {requiredCoverageValid} from './research-coverage.mjs';
export {REPOSITORY_RESEARCH_INPUTS_VERSION};

const HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const keyName=/^[a-zA-Z0-9_.-]{1,80}$/,LEASE_MS=15*60000;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.split(',').sort().join();
const string=(v,re)=>typeof v==='string'&&re.test(v);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function refuse(code){throw Object.assign(Error(code),{researchControlCode:code});}
const need=(ok,code)=>{if(!ok)refuse(code);};
const publicationChecks=new WeakMap();
// Validate the complete original transport, including decoded rasters, before
// committing an immutable permit. The witness stays inside this host process.
export async function preparePublicationCheck(db,bytes){
 const c=decodeResearchControl(bytes),witness={};let code=null;
 try{
  need(c.action==='permit'&&string(c.args.archive_sha256,HASH)&&string(c.args.bundle_sha256,HASH),'permit_fields');
  const row=db.prepare('SELECT bytes FROM research_archives WHERE request_id=? AND hash=?').get(c.request_id,c.args.archive_sha256);
  need(row,'archive_not_stored');const archive=decodeResearchArchive(Buffer.from(row.bytes));
  const file=archive.files.find(f=>f.sha256===c.args.bundle_sha256);need(file,'publication_bytes_missing');
  await decodeBundle(file.data);
 }catch(error){code=error.researchControlCode??'publication_bundle_invalid';}
 publicationChecks.set(witness,{command_hash:digest(bytes),code});return witness;
}
export const RESEARCH_CONTROL_SCHEMA={
 research_control_policy:'CREATE TABLE research_control_policy(id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL,evidence_reference TEXT NOT NULL)',
 research_control_runs:'CREATE TABLE research_control_runs(request_id TEXT PRIMARY KEY,report_date TEXT UNIQUE NOT NULL,plan BLOB NOT NULL,plan_hash TEXT NOT NULL,owner_id TEXT NOT NULL,epoch INTEGER NOT NULL,revision INTEGER NOT NULL,lease_until INTEGER NOT NULL,started_at INTEGER NOT NULL,charged_seconds REAL NOT NULL,inputs_hash TEXT,checkpoint_hash TEXT,permit TEXT)',
 research_control_ops:'CREATE TABLE research_control_ops(operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,kind TEXT NOT NULL,operation_key TEXT NOT NULL,input_hash TEXT NOT NULL,input TEXT NOT NULL,owner_id TEXT NOT NULL,epoch INTEGER NOT NULL,reserved_seconds INTEGER NOT NULL,phase TEXT NOT NULL,elapsed_seconds REAL,result_archive TEXT,result_file TEXT,native_result TEXT)',
 research_control_commands:'CREATE TABLE research_control_commands(command_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,hash TEXT NOT NULL,bytes BLOB NOT NULL,result TEXT NOT NULL)',
 research_control_submissions:'CREATE TABLE research_control_submissions(source_ts TEXT PRIMARY KEY,permit_id TEXT NOT NULL)',
 research_control_events:"CREATE TABLE research_control_events(source_ts TEXT PRIMARY KEY,command_id TEXT NOT NULL,hash TEXT NOT NULL,bytes BLOB NOT NULL,phase TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,reply_text TEXT,reply_ts TEXT,diagnostic TEXT)"
};
export function validateResearchControlConfig(c){
 const legacy=exact(c,'generation,activation_ts,first_report_date');
 requireThat((legacy||exact(c,'generation,activation_ts,first_report_date,protocol')&&c.protocol==='repository_inputs_v1')&&string(c.generation,UUID)&&string(c.activation_ts,/^\d{10}\.\d{6}$/)&&reportDate(c.first_report_date),'Explicit repository-input authority activation required');return c;
}
function policy(c){
 validateResearchControlConfig(c.research_control);
 requireThat(c.research_archive&&c.research_control.activation_ts>=c.research_archive.activation_ts&&c.research_control.first_report_date>=c.research_archive.first_report_date,'Research authority requires original archive policy');
 const {generation,activation_ts,first_report_date,protocol}=c.research_control;
 return JSON.stringify({generation,activation_ts,first_report_date,protocol,archive_generation:c.research_archive.generation,publisher_scope_sha256:scopeDigest(handoffScope(c))});
}
export function assertResearchControl(db,c){
 const rows=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'research_control_%'").all();
 if(!c.research_control){requireThat(!rows.length,'Installed research authority cannot be removed');return false;}
 assertResearchArchive(db,c);const binding=policy(c);
 requireThat(rows.length===Object.keys(RESEARCH_CONTROL_SCHEMA).length&&rows.every(r=>r.sql===RESEARCH_CONTROL_SCHEMA[r.name]),'Original research authority schema required');
 const installed=db.prepare('SELECT * FROM research_control_policy').all();requireThat(installed.length===1&&installed[0].id===1&&installed[0].binding===binding,'Original research authority binding required');return true;
}
export function installResearchControl(db,c,reference){
 assertResearchArchive(db,c);const binding=policy(c);
 requireThat(c.research_control.protocol==='repository_inputs_v1','New authority requires repository-input protocol');
 requireThat(typeof reference==='string'&&reference.length>0&&reference.length<=512&&!db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'research_control_%'").get(),'Explicit first authority installation required');
 const first=c.research_control.first_report_date;
 requireThat(!db.prepare('SELECT 1 FROM slack_staged_bundles WHERE report_date>=?').get(first)&&!db.prepare("SELECT 1 FROM jobs WHERE substr(json_extract(detail,'$.proof.edition'),1,10)>=? OR id>=? AND id GLOB 'morning-????????-r1'").get(first,'morning-'+first.replaceAll('-','')+'-r1'),'Authority activation must preserve existing publication dates');
 db.exec('BEGIN IMMEDIATE');try{
  for(const sql of Object.values(RESEARCH_CONTROL_SCHEMA))db.exec(sql);
  db.prepare('INSERT INTO research_control_policy VALUES(1,?,?)').run(binding,reference);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
// Offline under the original Publisher lock. Runtime/CD never migrate a ledger.
export function migrateResearchControl(db,c,reference){
 requireThat(c.research_control?.protocol==='repository_inputs_v1'&&typeof reference==='string'&&reference.length>0&&reference.length<=512,'Explicit authority migration reference required');
 const {protocol,...original}=c.research_control,previous={...c,research_control:original};
 db.exec('BEGIN IMMEDIATE');try{
  assertResearchControl(db,previous);
  requireThat(!db.prepare("SELECT 1 FROM slack_staged_bundles WHERE phase!='admitted'").get(),'Reconcile original staged bundles before authority migration');
  requireThat(!db.prepare("SELECT 1 FROM slack_submission_events WHERE phase!='done' AND NOT coalesce(phase='fenced' AND json_extract(diagnostic,'$.stage')='research_publication' AND json_extract(diagnostic,'$.outcome')='rejected',0)").get(),'Reconcile original submission events before authority migration');
  const prior=db.prepare('SELECT evidence_reference FROM research_control_policy WHERE id=1').get();
  const evidence=JSON.stringify({original_evidence_reference:prior.evidence_reference,migration_reference:reference,protocol});
  db.prepare('UPDATE research_control_policy SET binding=?,evidence_reference=? WHERE id=1').run(policy(c),evidence);
  assertResearchControl(db,c);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function decodeResearchControl(bytes){
 need(Buffer.isBuffer(bytes)&&bytes.length>0&&'!ai-research control v2 '.length+bytes.toString('base64').length<=5000,'control_wire_limit_split_reservations_or_reduce_plan');
 let c;try{c=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}catch{refuse('control_json');}
 need(exact(c,'schema_version,command_id,request_id,action,owner_id,epoch,expected_revision,args')&&c.schema_version==='research_control_v2'&&string(c.command_id,UUID)&&typeof c.request_id==='string'&&/^morning-\d{8}-r1$/.test(c.request_id)&&['claim','renew','inputs','checkpoint','reserve','resume','settle','permit','status','upload_status','receipt'].includes(c.action)&&integer(c.epoch,0,1000000)&&integer(c.expected_revision,0,10000000)&&c.args&&typeof c.args==='object'&&!Array.isArray(c.args),'control_identity');
 canonicalRequestDate(c.request_id);
 need(['status','upload_status','receipt'].includes(c.action)?c.owner_id===null:string(c.owner_id,UUID),'control_owner');return c;
}
export function decodeResearchPlan(encoded,id){
 need(typeof encoded==='string'&&encoded.length<=10000,'plan_size');const bytes=Buffer.from(encoded,'base64');need(bytes.toString('base64')===encoded,'plan_encoding');
 let p;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}catch{refuse('plan_json');}
 need(exact(p,'schema_version,request_id,report_date,prompt_commit_sha,reports_commit_sha,files,model_stages,limits')&&p.schema_version==='research_plan_v3'&&p.request_id===id&&p.report_date===canonicalRequestDate(id)&&string(p.prompt_commit_sha,SHA)&&string(p.reports_commit_sha,SHA),'plan_identity');
 need(exact(p.limits,'max_attempts_per_source,max_attempts_per_model,operation_timeout_seconds,total_budget_seconds')&&integer(p.limits.max_attempts_per_source,1,2)&&p.limits.max_attempts_per_model===1&&integer(p.limits.operation_timeout_seconds,1,180)&&integer(p.limits.total_budget_seconds,1,3600),'plan_limits');
 need(p.files&&typeof p.files==='object'&&!Array.isArray(p.files)&&Object.keys(p.files).length>0&&Object.keys(p.files).length<=32&&Object.entries(p.files).every(([name,hash])=>name.length<=200&&/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]+)*$/.test(name)&&name.split('/').every(x=>x!=='.'&&x!=='..')&&string(hash,HASH)),'plan_files');
 need(Array.isArray(p.model_stages)&&p.model_stages.length>0&&p.model_stages.length<=12&&new Set(p.model_stages).size===p.model_stages.length&&p.model_stages.every(x=>string(x,keyName)),'plan_model_stages');
 try{repositoryResearchInputs(p);}catch{refuse('plan_repository_inputs');}
 return {bytes,value:p};
}
function archive(db,id,hash){
 need(string(hash,HASH),'archive_hash');const row=db.prepare('SELECT manifest FROM research_archives WHERE request_id=? AND hash=?').get(id,hash);need(row,'archive_not_stored');return JSON.parse(row.manifest);
}
function publicationEvidence(db,run,plan,args){
 const row=db.prepare('SELECT bytes FROM research_archives WHERE request_id=? AND hash=?').get(run.request_id,args.archive_sha256);
 need(row,'archive_not_stored');const {files}=decodeResearchArchive(Buffer.from(row.bytes));
 const read=hash=>{const file=files.find(f=>f.sha256===hash);need(file,'publication_bytes_missing');try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(file.data));}catch{refuse('publication_json');}};
 const bundle=read(args.bundle_sha256),audit=read(args.audit_sha256);
 need(exact(bundle,'schema_version,request_id,repository,expected_base_sha,prompt_commit_sha,files')&&bundle.schema_version==='1.0'&&bundle.repository===REPOSITORY&&bundle.request_id===run.request_id&&bundle.expected_base_sha===plan.reports_commit_sha&&bundle.prompt_commit_sha===plan.prompt_commit_sha,'publication_plan_binding');
 // This is the existing trusted researcher's declaration, not a replacement
 // fact-checking engine. Keep its original bytes and explicit selected binding.
 need(audit&&audit.date===run.report_date&&audit.audit_valid===true&&Array.isArray(audit.blockers)&&audit.blockers.length===0&&['ready','partial','zero_items'].includes(audit.readiness),'publication_audit_blocked');
 need(requiredCoverageValid(audit,plan,bundle),'publication_coverage_contract');
}
export function researchSourceIdentity(input){
 need(exact(input,'method,url')&&input.method==='GET'&&typeof input.url==='string'&&input.url.length<=2000,'source_identity');
 let url;try{url=new URL(input.url);}catch{refuse('source_url');}
 need(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash,'source_url');
 url.searchParams.sort();const value={method:'GET',url:url.href};return {value,hash:digest(Buffer.from(JSON.stringify(value)))};
}
function nativeScope(run,input){
 if(input.permit_id!==null){
  const permit=run.permit?JSON.parse(run.permit):null;
  need(permit&&input.permit_id===permit.permit_id&&input.sha256===permit.bundle_sha256&&input.archive_sha256===permit.archive_sha256,'native_permit_binding');return 'permit:'+permit.permit_id;
 }
 need(string(input.archive_sha256,HASH)&&input.sha256===input.archive_sha256,'native_archive_binding');need(input.step!=='submit','archive_has_no_submit');return 'archive:'+input.archive_sha256;
}
function nativePredecessor(db,run,op){
 const scope=nativeScope(run,op.input);need(op.key===scope+':'+op.input.step,'native_operation_key');
 const steps=['ticket','post','complete','submit'],index=steps.indexOf(op.input.step);
 if(index===0)need(op.input.file_id===null&&op.input.source_ts===null,'ticket_has_no_file');
 else{
  const prior=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? AND kind=\'native\' AND operation_key=?').get(run.request_id,scope+':'+steps[index-1]);
  need(prior&&prior.phase==='acknowledged'&&prior.native_result,'native_predecessor_unresolved');const result=JSON.parse(prior.native_result),input=JSON.parse(prior.input);
  need(op.input.file_id===result.file_id&&op.input.sha256===input.sha256&&op.input.bytes===input.bytes,'native_original_file');
  need(index===3?op.input.source_ts===result.source_ts&&result.source_ts!==null:op.input.source_ts===null,'native_original_source');
 }
}
function view(run){return run?{request_id:run.request_id,report_date:run.report_date,owner_id:run.owner_id,epoch:run.epoch,revision:run.revision,lease_until:run.lease_until,started_at:run.started_at,charged_seconds:run.charged_seconds,plan_hash:run.plan_hash,inputs_hash:run.inputs_hash,checkpoint_hash:run.checkpoint_hash,permit:run.permit?JSON.parse(run.permit):null}:null;}
const load=(db,id)=>db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(id);
function owner(run,c,now){need(run,'run_not_found');need(run.owner_id===c.owner_id&&run.epoch===c.epoch,'owner_fenced');need(run.revision===c.expected_revision,'revision_conflict');need(run.lease_until>now,'lease_expired');}
function apply(db,c,now){
 let run=load(db,c.request_id);
 if(c.action==='upload_status'){
  need(exact(c.args,'archive_sha256,permit_id')&&string(c.args.archive_sha256,HASH)&&(c.args.permit_id===null||string(c.args.permit_id,UUID)),'upload_status_fields');
  if(!run)return {status:'not_found',run:null};
  const scope=c.args.permit_id?'permit:'+c.args.permit_id:'archive:'+c.args.archive_sha256;
  if(c.args.permit_id){const permit=run.permit?JSON.parse(run.permit):null;need(permit?.permit_id===c.args.permit_id&&permit.archive_sha256===c.args.archive_sha256,'upload_status_permit');}
  const ops=db.prepare("SELECT * FROM research_control_ops WHERE request_id=? AND kind='native' AND operation_key IN (?,?,?,?) ORDER BY rowid").all(c.request_id,...['ticket','post','complete','submit'].map(step=>scope+':'+step));
  return {status:'observed',run:view(run),operations:ops.map(op=>({...op,input:JSON.parse(op.input),native_result:op.native_result?JSON.parse(op.native_result):null}))};
 }
 if(c.action==='status'){
  need(exact(c.args,'offset')&&integer(c.args.offset,0,100000),'status_offset');
  if(!run)return {status:'not_found',run:null};
  const ops=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? ORDER BY rowid LIMIT 2 OFFSET ?').all(c.request_id,c.args.offset);
  return {status:'observed',run:view(run),plan_base64:Buffer.from(run.plan).toString('base64'),operations:ops.slice(0,1).map(op=>({...op,input:JSON.parse(op.input),native_result:op.native_result?JSON.parse(op.native_result):null})),next_offset:ops.length>1?c.args.offset+1:null};
 }
 if(c.action==='receipt'){
  need(exact(c.args,'command_id')&&string(c.args.command_id,UUID),'receipt_identity');
  const prior=db.prepare('SELECT hash,result,bytes FROM research_control_commands WHERE request_id=? AND command_id=?').get(c.request_id,c.args.command_id);
  need(!prior||!['status','upload_status','receipt'].includes(JSON.parse(Buffer.from(prior.bytes)).action),'receipt_requires_mutation');
  return {status:prior?'observed':'not_found',original_command_id:c.args.command_id,original_hash:prior?.hash??null,original_result:prior?{...JSON.parse(prior.result),dispatch_granted:false}:null};
 }
 if(c.action==='claim'){
  need(exact(c.args,'plan_base64'),'claim_fields');const plan=decodeResearchPlan(c.args.plan_base64,c.request_id);
  if(!run){
   need(c.expected_revision===0&&c.epoch===0,'initial_claim_revision');
   need(!db.prepare('SELECT 1 FROM jobs WHERE id=?').get(c.request_id)&&!db.prepare('SELECT 1 FROM slack_staged_bundles WHERE request_id=?').get(c.request_id),'existing_publication');
   db.prepare('INSERT INTO research_control_runs VALUES(?,?,?,?,?,1,1,?,?,0,NULL,NULL,NULL)').run(c.request_id,plan.value.report_date,plan.bytes,digest(plan.bytes),c.owner_id,now+LEASE_MS,now);
  }else{
   need(JSON.parse(Buffer.from(run.plan)).schema_version==='research_plan_v3','retired_plan_read_only');
   need(run.plan_hash===digest(plan.bytes)&&Buffer.from(run.plan).equals(plan.bytes),'immutable_plan');
   need(run.revision===c.expected_revision&&run.epoch===c.epoch,'revision_conflict');
   need(run.lease_until<=now,'owner_still_live');
   db.prepare('UPDATE research_control_runs SET owner_id=?,epoch=epoch+1,revision=revision+1,lease_until=? WHERE request_id=?').run(c.owner_id,now+LEASE_MS,c.request_id);
  }
  return {status:'claimed',run:view(load(db,c.request_id))};
 }
 need(!run||JSON.parse(Buffer.from(run.plan)).schema_version==='research_plan_v3','retired_plan_read_only');
 if(c.action==='settle')need(exact(c.args,'operation_id,outcome,elapsed_seconds,archive_sha256,file_sha256,native_result')&&string(c.args.operation_id,UUID)&&['acknowledged','unknown'].includes(c.args.outcome),'settle_fields');
 if(c.action==='settle'&&run&&run.revision===c.expected_revision){
  const original=db.prepare('SELECT owner_id,epoch FROM research_control_ops WHERE request_id=? AND operation_id=?').get(c.request_id,c.args.operation_id??'');
  const resumed=db.prepare("SELECT 1 FROM research_control_commands WHERE request_id=? AND json_extract(result,'$.dispatch_granted')=1 AND json_extract(result,'$.run.owner_id')=? AND json_extract(result,'$.run.epoch')=? AND EXISTS(SELECT 1 FROM json_each(result,'$.operations') WHERE json_extract(value,'$.operation_id')=?)").get(c.request_id,c.owner_id,c.epoch,c.args.operation_id);
  // Every committed grant retains its executor in the immutable command
  // result. A later takeover cannot erase a resumed executor's late evidence.
  if(!(original&&original.owner_id===c.owner_id&&original.epoch===c.epoch)&&!resumed)owner(run,c,now);
 }else owner(run,c,now);
 const plan=JSON.parse(Buffer.from(run.plan));let grants=[];
 if(c.action==='renew')need(exact(c.args,''),'renew_fields');
 else if(c.action==='inputs'){
  need(exact(c.args,''),'repository_inputs_fields');
  const hash=repositoryResearchInputsHash(plan);
  need(run.inputs_hash===null||run.inputs_hash===hash,'immutable_inputs');
  db.prepare('UPDATE research_control_runs SET inputs_hash=? WHERE request_id=?').run(hash,c.request_id);
 }
 else if(c.action==='checkpoint'){
  need(exact(c.args,'archive_sha256'),'checkpoint_fields');archive(db,c.request_id,c.args.archive_sha256);
  db.prepare('UPDATE research_control_runs SET checkpoint_hash=? WHERE request_id=?').run(c.args.archive_sha256,c.request_id);
 }else if(c.action==='reserve'){
  need(exact(c.args,'operations')&&Array.isArray(c.args.operations)&&c.args.operations.length>0&&c.args.operations.length<=8,'operation_batch');
  for(const op of c.args.operations){
   need(exact(op,'operation_id,kind,key,input_sha256,input,max_seconds')&&string(op.operation_id,UUID)&&['source','model','native'].includes(op.kind)&&typeof op.key==='string'&&op.key.length>0&&op.key.length<=180&&string(op.input_sha256,HASH)&&integer(op.max_seconds,0,plan.limits.operation_timeout_seconds),'operation_fields');
   need(!db.prepare('SELECT 1 FROM research_control_ops WHERE operation_id=?').get(op.operation_id),'operation_id_used');
   const used=db.prepare('SELECT count(*) n FROM research_control_ops WHERE request_id=? AND kind=? AND operation_key=?').get(c.request_id,op.kind,op.key).n;
   if(op.kind==='native'){
    need(op.max_seconds===0&&used===0,'native_intent_exists');
    need(exact(op.input,'archive_sha256,permit_id,step,file_id,source_ts,bytes,sha256')&&['ticket','post','complete','submit'].includes(op.input.step)&&string(op.input.sha256,HASH)&&integer(op.input.bytes,1,16*1024*1024)&&(op.input.file_id===null||string(op.input.file_id,/^[A-Z0-9]{1,128}$/))&&(op.input.source_ts===null||string(op.input.source_ts,/^\d{10}\.\d{6}$/)),'safe_native_intent');
    need(digest(Buffer.from(JSON.stringify(op.input)))===op.input_sha256,'native_input_hash');
    nativePredecessor(db,run,op);
   }else{
    need(run.inputs_hash!==null&&run.permit===null,'research_inputs_or_phase');need(op.max_seconds>0,'research_operation_input');
    if(op.kind==='source'){const source=researchSourceIdentity(op.input);need(op.key===source.hash&&op.input_sha256===source.hash,'source_identity_hash');}
    else need(op.input===null,'research_operation_input');
    need(now<run.started_at+plan.limits.total_budget_seconds*1000,'research_deadline');
    need(op.kind==='source'?string(op.key,HASH)&&used<plan.limits.max_attempts_per_source:plan.model_stages.includes(op.key)&&used<plan.limits.max_attempts_per_model,'attempt_budget');
    need(run.charged_seconds+op.max_seconds<=plan.limits.total_budget_seconds,'time_budget');run.charged_seconds+=op.max_seconds;
   }
   db.prepare("INSERT INTO research_control_ops VALUES(?,?,?,?,?,?,?,?,?,'intent',NULL,NULL,NULL,NULL)").run(op.operation_id,c.request_id,op.kind,op.key,op.input_sha256,JSON.stringify(op.input),c.owner_id,c.epoch,op.max_seconds);
   grants.push({operation_id:op.operation_id,kind:op.kind,key:op.key,input_sha256:op.input_sha256});
  }
  db.prepare('UPDATE research_control_runs SET charged_seconds=? WHERE request_id=?').run(run.charged_seconds,c.request_id);
 }else if(c.action==='resume'){
  need(exact(c.args,'operation_id')&&string(c.args.operation_id,UUID),'resume_fields');
  const op=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? AND operation_id=?').get(c.request_id,c.args.operation_id);
  need(op&&op.phase==='intent','resume_original_intent');
  need(op.kind==='native'||run.permit===null&&now<run.started_at+plan.limits.total_budget_seconds*1000,'research_deadline');
  const events=[];
  for(const event of db.prepare('SELECT source_ts,phase,reply_text FROM research_control_events WHERE reply_text IS NOT NULL').iterate()){
   const reply=JSON.parse(event.reply_text.slice('!ai-research control-receipt '.length));
   if((reply.dispatch_granted||reply.grant_expired)&&reply.operations?.some(item=>item.operation_id===op.operation_id))events.push({source_ts:event.source_ts,phase:event.phase,dispatch_granted:reply.dispatch_granted});
  }
  need(events.length>0&&events.every(event=>event.phase==='ready'||event.phase==='superseded'||event.phase==='sent'&&event.dispatch_granted===false),'resume_dispatch_not_proven_unstarted');
  for(const event of events)if(event.phase==='ready')db.prepare("UPDATE research_control_events SET phase='superseded' WHERE source_ts=?").run(event.source_ts);
  grants=[{operation_id:op.operation_id,kind:op.kind,key:op.operation_key,input_sha256:op.input_hash}];
 }else if(c.action==='settle'){
  need(exact(c.args,'operation_id,outcome,elapsed_seconds,archive_sha256,file_sha256,native_result')&&string(c.args.operation_id,UUID)&&['acknowledged','unknown'].includes(c.args.outcome),'settle_fields');
  const op=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? AND operation_id=?').get(c.request_id,c.args.operation_id);need(op&&op.phase!=='acknowledged','operation_unsettled');
  const elapsed=c.args.elapsed_seconds;need(elapsed===null||typeof elapsed==='number'&&Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=86400,'elapsed_evidence');
  if(c.args.outcome==='acknowledged'){
   if(op.kind==='native'){
    const input=JSON.parse(op.input),result=c.args.native_result;
    need(c.args.archive_sha256===null&&c.args.file_sha256===null&&elapsed===null&&exact(result,'file_id,source_ts,sha256,bytes')&&string(result.file_id,/^[A-Z0-9]{1,128}$/)&&result.sha256===input.sha256&&result.bytes===input.bytes,'native_safe_result');
    need(input.file_id===null||input.file_id===result.file_id,'native_result_file');
    need(['complete','submit'].includes(input.step)?string(result.source_ts,/^\d{10}\.\d{6}$/):result.source_ts===null,'native_result_source');
   }else{need(c.args.native_result===null,'research_result_kind');need(archive(db,c.request_id,c.args.archive_sha256).some(f=>f.sha256===c.args.file_sha256),'result_bytes_missing');}
  }else need(c.args.archive_sha256===null&&c.args.file_sha256===null&&elapsed===null&&c.args.native_result===null,'unknown_preserves_charge');
  const refund=op.elapsed_seconds===null&&elapsed!==null?op.reserved_seconds-elapsed:0;
  db.prepare('UPDATE research_control_ops SET phase=?,elapsed_seconds=?,result_archive=?,result_file=?,native_result=? WHERE operation_id=?').run(c.args.outcome,elapsed,c.args.archive_sha256,c.args.file_sha256,c.args.native_result?JSON.stringify(c.args.native_result):null,c.args.operation_id);
  db.prepare('UPDATE research_control_runs SET charged_seconds=charged_seconds-? WHERE request_id=?').run(refund,c.request_id);
 }else if(c.action==='permit'){
  need(exact(c.args,'archive_sha256,bundle_sha256,audit_sha256')&&string(c.args.bundle_sha256,HASH)&&string(c.args.audit_sha256,HASH),'permit_fields');
  const files=archive(db,c.request_id,c.args.archive_sha256);need(run.inputs_hash&&files.some(f=>f.sha256===c.args.bundle_sha256)&&files.some(f=>f.sha256===c.args.audit_sha256),'publication_bytes_missing');
  publicationEvidence(db,run,plan,c.args);
  if(run.permit){const prior=JSON.parse(run.permit);need(prior.bundle_sha256===c.args.bundle_sha256&&prior.audit_sha256===c.args.audit_sha256&&prior.archive_sha256===c.args.archive_sha256,'immutable_publication_permit');}
  else{
   const permit={permit_id:randomUUID(),request_id:c.request_id,report_date:run.report_date,prompt_commit_sha:plan.prompt_commit_sha,publisher_scope_sha256:db.prepare('SELECT value FROM scope WHERE id=1').get().value,...c.args};
   db.prepare('UPDATE research_control_runs SET permit=? WHERE request_id=?').run(JSON.stringify(permit),c.request_id);
  }
 }
 const lease=run.owner_id===c.owner_id&&run.epoch===c.epoch&&run.lease_until>now?now+LEASE_MS:run.lease_until;
 db.prepare('UPDATE research_control_runs SET revision=revision+1,lease_until=? WHERE request_id=?').run(lease,c.request_id);
 return {status:'committed',run:view(load(db,c.request_id)),dispatch_granted:grants.length>0,operations:grants};
}
export function executeResearchControl(db,config,bytes,now=Date.now(),{onResult=()=>{},publicationCheck=null}={}){
 need(assertResearchControl(db,config),'authority_disabled');const c=decodeResearchControl(bytes),hash=digest(bytes);
 need(canonicalRequestDate(c.request_id)>=config.research_control.first_report_date,'authority_date');need(integer(now,1,Number.MAX_SAFE_INTEGER),'authority_clock');
 db.exec('BEGIN IMMEDIATE');try{
  const prior=db.prepare('SELECT request_id,hash,result FROM research_control_commands WHERE command_id=?').get(c.command_id);
  if(prior){need(prior.hash===hash&&prior.request_id===c.request_id,'command_identity_conflict');const result={...JSON.parse(prior.result),replayed:true,dispatch_granted:false};onResult(result);db.exec('COMMIT');return result;}
  let result;db.exec('SAVEPOINT command');
  try{
   need(config.research_control.protocol==='repository_inputs_v1'||['status','upload_status','receipt'].includes(c.action),'authority_migration_required');
   if(c.action==='permit'){const check=publicationChecks.get(publicationCheck);need(check?.command_hash===hash,'publication_validation_required');need(!check.code,check.code);}
   result=apply(db,c,now);db.exec('RELEASE command');
  }catch(e){if(!e.researchControlCode)throw e;db.exec('ROLLBACK TO command; RELEASE command');result={status:'rejected',code:e.researchControlCode,run:view(load(db,c.request_id)),dispatch_granted:false};}
  result={command_id:c.command_id,command_sha256:hash,request_id:c.request_id,...result};
  need(Buffer.byteLength(JSON.stringify(result))<=16000,'control_result_limit');
  db.prepare('INSERT INTO research_control_commands VALUES(?,?,?,?,?)').run(c.command_id,c.request_id,hash,bytes,JSON.stringify(result));onResult(result);db.exec('COMMIT');return result;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
