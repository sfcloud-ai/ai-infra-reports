import {activePageResearch,pageModelKeyAllowed} from './research-page-budget.mjs';
import {beginPageRound,currentPageRound,publicationPermit,pagePublicationBinding,appendPagePermit,pageAuthorityInstalled} from './research-page-authority.mjs';
import {readResearchRecoveryHead,researchRecoveryWindow,researchRecoveryAccounting,recordResearchRecoveryOperation,appendResearchRecoveryGrant,assertResearchRecovery} from './research-recovery.mjs';
import {isRepositoryResearchPlan,isLayeredResearchPlan,operationBudget,continuationWindow,LAYERED_BUDGET_POLICY,researchSecondsWithin,RESEARCH_SECONDS_EPSILON} from './research-budget.mjs';
// Host authority for a disposable research client. Replies are observations;
// only a newly committed operation intent can grant one external dispatch.
import {randomUUID} from 'node:crypto';
import {digest,REPOSITORY} from './archive.mjs';
import {canonicalRequestDate,reportDate,requireThat,decodeBundle} from './report-handoff.mjs';
import {assertResearchArchive,decodeResearchArchive} from './research-archive.mjs';
import {handoffScope,scopeDigest} from './handoff-state.mjs';
import {repositoryResearchInputs,repositoryResearchInputsHash,REPOSITORY_RESEARCH_INPUTS_VERSION} from './repository-research-inputs.mjs';
import {requiredCoverageValid} from './research-coverage.mjs';
import {resumablePageMetadataValid} from './research-page-coverage.mjs';
export {REPOSITORY_RESEARCH_INPUTS_VERSION};
export const LAYERED_RESEARCH_BUDGET_VERSION=1;

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
  need(['permit','page_permit'].includes(c.action)&&string(c.args.archive_sha256,HASH)&&string(c.args.bundle_sha256,HASH),'permit_fields');
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
 assertResearchArchive(db,c);assertResearchRecovery(db);pageAuthorityInstalled(db);const binding=policy(c);
 requireThat(rows.length===Object.keys(RESEARCH_CONTROL_SCHEMA).length&&rows.every(r=>r.sql===RESEARCH_CONTROL_SCHEMA[r.name]),'Original research authority schema required');
 const installed=db.prepare('SELECT * FROM research_control_policy').all();requireThat(installed.length===1&&installed[0].id===1&&installed[0].binding===binding,'Original research authority binding required');return true;
}
export function installResearchControl(db,c,reference){
 assertResearchArchive(db,c);assertResearchRecovery(db);pageAuthorityInstalled(db);const binding=policy(c);
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
 need(exact(c,'schema_version,command_id,request_id,action,owner_id,epoch,expected_revision,args')&&c.schema_version==='research_control_v2'&&string(c.command_id,UUID)&&typeof c.request_id==='string'&&/^morning-\d{8}-r1$/.test(c.request_id)&&['claim','renew','inputs','checkpoint','reserve','resume','settle','permit','page_begin','page_permit','recovery_grant','status','upload_status','receipt'].includes(c.action)&&integer(c.epoch,0,1000000)&&integer(c.expected_revision,0,10000000)&&c.args&&typeof c.args==='object'&&!Array.isArray(c.args),'control_identity');
 canonicalRequestDate(c.request_id);
 need(['status','upload_status','receipt'].includes(c.action)?c.owner_id===null:string(c.owner_id,UUID),'control_owner');return c;
}
export function decodeResearchPlan(encoded,id){
 need(typeof encoded==='string'&&encoded.length<=10000,'plan_size');const bytes=Buffer.from(encoded,'base64');need(bytes.toString('base64')===encoded,'plan_encoding');
 let p;try{p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}catch{refuse('plan_json');}
 need(exact(p,'schema_version,request_id,report_date,prompt_commit_sha,reports_commit_sha,files,model_stages,limits')&&isRepositoryResearchPlan(p)&&p.request_id===id&&p.report_date===canonicalRequestDate(id)&&string(p.prompt_commit_sha,SHA)&&string(p.reports_commit_sha,SHA),'plan_identity');
 if(isLayeredResearchPlan(p)){
  need(exact(p.limits,'max_attempts_per_source,max_attempts_per_model,source_attempt_timeout_seconds,model_stage_timeout_seconds,total_budget_seconds')&&integer(p.limits.max_attempts_per_source,1,2)&&integer(p.limits.max_attempts_per_model,1,2)&&integer(p.limits.source_attempt_timeout_seconds,1,180)&&integer(p.limits.total_budget_seconds,1,3600)&&integer(p.limits.model_stage_timeout_seconds,1,p.limits.total_budget_seconds),'plan_limits');
 }else{
 need(exact(p.limits,'max_attempts_per_source,max_attempts_per_model,operation_timeout_seconds,total_budget_seconds')&&integer(p.limits.max_attempts_per_source,1,2)&&p.limits.max_attempts_per_model===1&&integer(p.limits.operation_timeout_seconds,1,180)&&integer(p.limits.total_budget_seconds,1,3600),'plan_limits');
 }
 need(p.files&&typeof p.files==='object'&&!Array.isArray(p.files)&&Object.keys(p.files).length>0&&Object.keys(p.files).length<=32&&Object.entries(p.files).every(([name,hash])=>name.length<=200&&/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]+)*$/.test(name)&&name.split('/').every(x=>x!=='.'&&x!=='..')&&string(hash,HASH)),'plan_files');
 need(Array.isArray(p.model_stages)&&p.model_stages.length>0&&p.model_stages.length<=12&&new Set(p.model_stages).size===p.model_stages.length&&p.model_stages.every(x=>string(x,keyName)),'plan_model_stages');
 try{repositoryResearchInputs(p);}catch{refuse('plan_repository_inputs');}
 return {bytes,value:p};
}
function archive(db,id,hash){
 need(string(hash,HASH),'archive_hash');const row=db.prepare('SELECT manifest FROM research_archives WHERE request_id=? AND hash=?').get(id,hash);need(row,'archive_not_stored');return JSON.parse(row.manifest);
}
function readPublicationBytes(db,run,args,cache){
 const decoded=commandArchive(db,run.request_id,args.archive_sha256,cache);
 need(decoded,'archive_not_stored');const {files}=decoded;
 const read=hash=>{const file=files.find(f=>f.sha256===hash);need(file,'publication_bytes_missing');try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(file.data));}catch{refuse('publication_json');}};
 const bundle=read(args.bundle_sha256),audit=read(args.audit_sha256);
 need(audit&&typeof audit==='object'&&!Array.isArray(audit),'publication_audit_blocked');
 const metadata=audit.evidence_metadata_sha256?read(audit.evidence_metadata_sha256):null;
 cache.archive=null;cache.archiveKey=null;
 return {bundle,audit,metadata};
}
function publicationEvidence(db,run,plan,args,now,cache,page=false){
 const {bundle,audit,metadata}=readPublicationBytes(db,run,args,cache);
 const pageBinding=page?pagePublicationBinding(db,run,bundle):null;
 need(exact(bundle,'schema_version,request_id,repository,expected_base_sha,prompt_commit_sha,files')&&bundle.schema_version==='1.0'&&bundle.repository===REPOSITORY&&bundle.request_id===(page?args.publication_request_id:run.request_id)&&(page?string(bundle.expected_base_sha,SHA):bundle.expected_base_sha===plan.reports_commit_sha)&&bundle.prompt_commit_sha===plan.prompt_commit_sha,'publication_plan_binding');
 // This is the existing trusted researcher's declaration, not a replacement
 // fact-checking engine. Keep its original bytes and explicit selected binding.
 need(audit&&audit.date===run.report_date&&audit.audit_valid===true&&Array.isArray(audit.blockers)&&audit.blockers.length===0&&['ready','partial','zero_items'].includes(audit.readiness),'publication_audit_blocked');
 const budget=effectiveResearchBudget(db,run,plan,now,cache);
 const coveragePlan=budget?{...plan,schema_version:'research_plan_v4',limits:budget.limits}:plan;
 need(requiredCoverageValid(audit,coveragePlan,bundle,pageBinding?.previous,metadata),'publication_coverage_contract');
 // Derive continuation requirements from authenticated report bytes, not an
 // optional audit declaration: omitting page_scope must not bypass this gate.
 const reportFiles=bundle.files.filter(f=>f.path.endsWith('/report.json'));
 let publicationReport;try{publicationReport=JSON.parse(Buffer.from(reportFiles[0].base64,'base64'));}catch{refuse('publication_json');}
 if(publicationReport.schema_version==='1.2')need(pageAuthorityInstalled(db),'publication_page_authority_required');
 if(publicationReport.page_delivery?.pending?.length){
  need(budget&&pageAuthorityInstalled(db),'publication_page_recovery_required');
  need(audit.page_scope&&resumablePageMetadataValid(audit,metadata),'publication_page_metadata_required');
 }
 if(budget){
  need(audit.budget_policy===LAYERED_BUDGET_POLICY,'publication_budget_policy');
  // Every research intent must have an authenticated known outcome before release.
  need(budget.operations.filter(op=>op.kind!=='native').every(op=>classifiedResult(db,run,op,cache)),'publication_research_result_unknown');
  need(researchSecondsWithin(budget.accounting.success_seconds+budget.accounting.reserved_seconds,budget.limits.total_budget_seconds),'publication_success_budget');
  for(const op of budget.operations.filter(op=>op.kind!=='native')){
   if(classifiedResult(db,run,op,cache)?.outcome==='success'&&op.elapsed_seconds!==null)need(researchSecondsWithin(op.elapsed_seconds,operationBudget(coveragePlan,op.kind)),'publication_operation_budget');
  }
  for(const [key,count] of Object.entries(budget.accounting.successful_attempts)){
   const [kind]=JSON.parse(key);need(count<=(kind==='source'?budget.limits.max_attempts_per_source:budget.limits.max_attempts_per_model),'publication_attempt_budget');
  }
  const actual=budget.accounting,summary=audit.budget_accounting;
  const equalSeconds=(a,b)=>typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<=RESEARCH_SECONDS_EPSILON;
  need(summary&&equalSeconds(summary.successful_seconds,actual.success_seconds)&&equalSeconds(summary.failed_seconds,actual.failed_seconds)&&equalSeconds(summary.reserved_unknown_seconds,actual.reserved_seconds)&&equalSeconds(summary.charged_seconds,actual.success_seconds+actual.reserved_seconds),'publication_budget_accounting');
  for(const kind of ['source','model']){
   const count=(map)=>Object.entries(map).filter(([key])=>JSON.parse(key)[0]===kind).reduce((n,[,value])=>n+value,0);
   need(summary.successful_attempts?.[kind]===count(actual.successful_attempts)&&summary.failed_attempts?.[kind]===count(actual.failed_attempts)&&summary.unknown_attempts?.[kind]===count(actual.unknown_attempts),'publication_budget_attempts');
  }
 }
 return pageBinding;
}
export function researchSourceIdentity(input){
 need(exact(input,'method,url')&&input.method==='GET'&&typeof input.url==='string'&&input.url.length<=2000,'source_identity');
 let url;try{url=new URL(input.url);}catch{refuse('source_url');}
 need(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash,'source_url');
 url.searchParams.sort();const value={method:'GET',url:url.href};return {value,hash:digest(Buffer.from(JSON.stringify(value)))};
}
function nativeScope(db,run,input){
 if(input.permit_id!==null){
  const permit=publicationPermit(db,run,input.permit_id);
  need(permit&&input.permit_id===permit.permit_id&&input.sha256===permit.bundle_sha256&&input.archive_sha256===permit.archive_sha256,'native_permit_binding');return 'permit:'+permit.permit_id;
 }
 need(string(input.archive_sha256,HASH)&&input.sha256===input.archive_sha256,'native_archive_binding');need(input.step!=='submit','archive_has_no_submit');return 'archive:'+input.archive_sha256;
}
function nativePredecessor(db,run,op){
 const scope=nativeScope(db,run,op.input);need(op.key===scope+':'+op.input.step,'native_operation_key');
 const steps=['ticket','post','complete','submit'],index=steps.indexOf(op.input.step);
 if(index===0)need(op.input.file_id===null&&op.input.source_ts===null,'ticket_has_no_file');
 else{
  const prior=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? AND kind=\'native\' AND operation_key=?').get(run.request_id,scope+':'+steps[index-1]);
  need(prior&&prior.phase==='acknowledged'&&prior.native_result,'native_predecessor_unresolved');const result=JSON.parse(prior.native_result),input=JSON.parse(prior.input);
  need(op.input.file_id===result.file_id&&op.input.sha256===input.sha256&&op.input.bytes===input.bytes,'native_original_file');
  need(index===3?op.input.source_ts===result.source_ts&&result.source_ts!==null:op.input.source_ts===null,'native_original_source');
 }
}
// Acknowledgement confirms storage, not success. Classify only original stored bytes.
// Disposable for one synchronous command/read only; SQLite remains authoritative.
function commandCache(){return {archiveKey:null,archive:null,classifications:new Map()};}
function commandArchive(db,requestId,hash,cache){
 const key=JSON.stringify([requestId,hash]);
 if(cache.archiveKey===key)return cache.archive;
 // Release the previous decoded body before fetching another bounded archive.
 cache.archive=null;cache.archiveKey=null;
 const row=db.prepare('SELECT bytes FROM research_archives WHERE request_id=? AND hash=?').get(requestId,hash);
 const original=row?decodeResearchArchive(Buffer.from(row.bytes)):null;
 // Never retain the envelope's base64 strings alongside decoded file bytes.
 const decoded=original?{files:original.files}:null;
 if(decoded){decoded.byHash=new Map();for(const file of decoded.files)if(!decoded.byHash.has(file.sha256))decoded.byHash.set(file.sha256,file);}
 cache.archiveKey=key;cache.archive=decoded;return decoded;
}
function classifiedResult(db,run,op,cache){
 const key=JSON.stringify([run.request_id,run.plan_hash,op.operation_id,op.phase,op.kind,op.input_hash,op.result_archive,op.result_file,op.elapsed_seconds]);
 if(cache.classifications.has(key))return cache.classifications.get(key);
 const result=classifyStoredResult(db,run,op,cache);
 cache.classifications.set(key,result);return result;
}
function classifyStoredResult(db,run,op,cache){
 if(op.phase!=='acknowledged'||!op.result_archive||!op.result_file)return null;
 const decoded=commandArchive(db,run.request_id,op.result_archive,cache),file=decoded?.byHash.get(op.result_file);if(!file)return null;
 const layered=isLayeredResearchPlan(JSON.parse(Buffer.from(run.plan)));
 // Original v3 sources settled the body hash; authenticated metadata was a sibling.
 if(!layered&&op.kind==='source'){
  const matches=[];
  for(const candidate of decoded.files){
   if(!candidate.path.endsWith('.json'))continue;
   let meta;try{meta=JSON.parse(candidate.data);}catch{continue;}
   if(!meta||typeof meta!=='object'||Array.isArray(meta)||meta.operation_id!==op.operation_id||meta.sha256!==op.result_file)continue;
   matches.push(meta);
  }
  if(matches.length){
   if(matches.length!==1)return null;const m=matches[0];
   if(m.kind!=='source'||m.key!==op.operation_key||m.input_sha256!==op.input_hash||m.bytes!==file.data.length||m.elapsed_seconds!==op.elapsed_seconds||m.max_seconds!==op.reserved_seconds||m.attempts!==1||!Number.isInteger(m.exit_code)||typeof m.http_status!=='string'||!/^\d{3}$/.test(m.http_status)||typeof m.error!=='string')return null;
   try{if(researchSourceIdentity(m.input).hash!==op.input_hash)return null;}catch{return null;}
   const success=m.exit_code===0&&Number(m.http_status)>=200&&Number(m.http_status)<300&&m.error===''&&m.bytes>0;
   const failure=m.exit_code!==0||Number(m.http_status)>=400||m.error!=='';
   if(!success&&!failure)return null;
   return {authenticated:true,outcome:success?'success':'failed',archive_sha256:op.result_archive,file_sha256:op.result_file};
  }
 }
 let result;try{result=JSON.parse(file.data);}catch{return null;}
 if(!result||typeof result!=='object'||Array.isArray(result))return null;
 if(op.kind==='model'){
  if(result.operation_id!==op.operation_id||result.request_id!==run.request_id)return null;
 }else{
  if(layered&&(result.operation_id!==op.operation_id||result.request_id!==run.request_id))return null;
  if(!layered&&db.prepare('SELECT count(*) AS n FROM research_control_ops WHERE request_id=? AND result_file=?').get(run.request_id,op.result_file).n!==1)return null;
  try{if(researchSourceIdentity({method:'GET',url:result.url}).hash!==op.input_hash)return null;}catch{return null;}
 }
 const status=result.stage_status??result.status;
 const outcome=['failed','timeout'].includes(status)?'failed':['ok','success','partial'].includes(status)?'success':null;
 if(!outcome||result.elapsed_seconds!==op.elapsed_seconds)return null;
 return {authenticated:true,outcome,archive_sha256:op.result_archive,file_sha256:op.result_file};
}
function researchContinuationAuthority(db,run,plan,now){
 const installed=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_recovery_grants'").get();
 const head=installed?readResearchRecoveryHead(db,run.request_id):null;
 if(head){const binding=JSON.parse(db.prepare('SELECT binding FROM research_control_policy WHERE id=1').get().binding);need(head.grant.plan_hash===run.plan_hash&&head.grant.request_id===run.request_id&&head.grant.generation===binding.generation,'recovery_binding');}
 if(!isLayeredResearchPlan(plan)&&!head)return null;
 need(installed,'layered_budget_not_installed');
 const limits=isLayeredResearchPlan(plan)?plan.limits:{max_attempts_per_source:plan.limits.max_attempts_per_source,max_attempts_per_model:plan.limits.max_attempts_per_model,source_attempt_timeout_seconds:plan.limits.operation_timeout_seconds,model_stage_timeout_seconds:plan.limits.total_budget_seconds,total_budget_seconds:plan.limits.total_budget_seconds};
 const window=head?researchRecoveryWindow(head,now):{...continuationWindow(now),active:true};
 return {policy:LAYERED_BUDGET_POLICY,grant_id:head?.grant.grant_id??'plan:'+run.plan_hash,grant_sha256:head?.sha256??null,limits,window};
}
function effectiveResearchBudget(db,run,plan,now,cache){
 const authority=researchContinuationAuthority(db,run,plan,now);
 if(!authority)return null;
 const operations=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? ORDER BY rowid').all(run.request_id);
 // Group interleaved operations by immutable archive; retain only small outcomes.
 const groups=new Map();
 for(const op of operations){const key=op.result_archive; if(!groups.has(key))groups.set(key,[]);groups.get(key).push(op);}
 for(const group of groups.values()){
  for(const op of group)classifiedResult(db,run,op,cache);
  cache.archive=null;cache.archiveKey=null;
 }
 const accounting=researchRecoveryAccounting(operations,op=>classifiedResult(db,run,op,cache));
 return {...authority,accounting,operations};
}
function budgetObservation(budget){
 if(!budget)return null;
 const {operations,...observation}=budget;
 const counts=map=>Object.fromEntries(['source','model'].map(kind=>[kind,Object.entries(map).filter(([key])=>JSON.parse(key)[0]===kind).reduce((n,[,value])=>n+value,0)]));
 observation.accounting={...budget.accounting,successful_attempts:counts(budget.accounting.successful_attempts),failed_attempts:counts(budget.accounting.failed_attempts),unknown_attempts:counts(budget.accounting.unknown_attempts)};
 return observation;
}
export function researchOperationDispatchValid(db,run,op,now){
 if(op.kind==='native')return true;
 const plan=JSON.parse(Buffer.from(run.plan)),budget=researchContinuationAuthority(db,run,plan,now);
 const scope=activePageResearch(db,run,plan);
 if(!scope.active||(op.kind==='model'&&!pageModelKeyAllowed(scope,op.operation_key)))return false;
 if(!budget)return now<run.started_at+plan.limits.total_budget_seconds*1000;
 const link=db.prepare('SELECT * FROM research_recovery_operations WHERE operation_id=? ORDER BY window_start DESC LIMIT 1').get(op.operation_id);
 return !!link&&link.request_id===run.request_id&&link.grant_id===budget.grant_id&&budget.window.active&&link.window_start===(budget.window.start??budget.window.window_start??budget.window.not_before)&&now>=link.window_start&&now<budget.window.deadline;
}
function view(run){return run?{request_id:run.request_id,report_date:run.report_date,owner_id:run.owner_id,epoch:run.epoch,revision:run.revision,lease_until:run.lease_until,started_at:run.started_at,charged_seconds:run.charged_seconds,plan_hash:run.plan_hash,inputs_hash:run.inputs_hash,checkpoint_hash:run.checkpoint_hash,permit:run.permit?JSON.parse(run.permit):null}:null;}
const load=(db,id)=>db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(id);
function owner(run,c,now){need(run,'run_not_found');need(run.owner_id===c.owner_id&&run.epoch===c.epoch,'owner_fenced');need(run.revision===c.expected_revision,'revision_conflict');need(run.lease_until>now,'lease_expired');}
function apply(db,c,now,config){
 const cache=commandCache();
 let run=load(db,c.request_id);
 if(c.action==='upload_status'){
  need(exact(c.args,'archive_sha256,permit_id')&&string(c.args.archive_sha256,HASH)&&(c.args.permit_id===null||string(c.args.permit_id,UUID)),'upload_status_fields');
  if(!run)return {status:'not_found',run:null};
  const scope=c.args.permit_id?'permit:'+c.args.permit_id:'archive:'+c.args.archive_sha256;
  if(c.args.permit_id){const permit=publicationPermit(db,run,c.args.permit_id);need(permit?.permit_id===c.args.permit_id&&permit.archive_sha256===c.args.archive_sha256,'upload_status_permit');}
  const ops=db.prepare("SELECT * FROM research_control_ops WHERE request_id=? AND kind='native' AND operation_key IN (?,?,?,?) ORDER BY rowid").all(c.request_id,...['ticket','post','complete','submit'].map(step=>scope+':'+step));
  return {status:'observed',run:view(run),permit:publicationPermit(db,run,c.args.permit_id),operations:ops.map(op=>({...op,input:JSON.parse(op.input),native_result:op.native_result?JSON.parse(op.native_result):null}))};
 }
 if(c.action==='status'){
  need(exact(c.args,'offset')&&integer(c.args.offset,0,100000),'status_offset');
  const capabilities=assertResearchRecovery(db)?{capabilities:{repository_plan_versions:['research_plan_v3','research_plan_v4'],budget_policy:LAYERED_BUDGET_POLICY}}:{};
  if(!run)return {status:'not_found',run:null,...capabilities};
  const ops=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? ORDER BY rowid LIMIT 2 OFFSET ?').all(c.request_id,c.args.offset);
  const budget=effectiveResearchBudget(db,run,JSON.parse(Buffer.from(run.plan)),now,cache);
  return {status:'observed',run:view(run),page_round:currentPageRound(db,c.request_id),...capabilities,...(budget?{effective_budget:budgetObservation(budget)}:{}),plan_base64:Buffer.from(run.plan).toString('base64'),operations:ops.slice(0,1).map(op=>({...op,input:JSON.parse(op.input),native_result:op.native_result?JSON.parse(op.native_result):null})),next_offset:ops.length>1?c.args.offset+1:null};
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
   if(isLayeredResearchPlan(plan.value))need(db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_recovery_grants'").get(),'layered_budget_not_installed');
   need(c.expected_revision===0&&c.epoch===0,'initial_claim_revision');
   need(!db.prepare('SELECT 1 FROM jobs WHERE id=?').get(c.request_id)&&!db.prepare('SELECT 1 FROM slack_staged_bundles WHERE request_id=?').get(c.request_id),'existing_publication');
   db.prepare('INSERT INTO research_control_runs VALUES(?,?,?,?,?,1,1,?,?,0,NULL,NULL,NULL)').run(c.request_id,plan.value.report_date,plan.bytes,digest(plan.bytes),c.owner_id,now+LEASE_MS,now);
  }else{
   need(isRepositoryResearchPlan(JSON.parse(Buffer.from(run.plan))),'retired_plan_read_only');
   need(run.plan_hash===digest(plan.bytes)&&Buffer.from(run.plan).equals(plan.bytes),'immutable_plan');
   need(run.revision===c.expected_revision&&run.epoch===c.epoch,'revision_conflict');
   need(run.lease_until<=now,'owner_still_live');
   db.prepare('UPDATE research_control_runs SET owner_id=?,epoch=epoch+1,revision=revision+1,lease_until=? WHERE request_id=?').run(c.owner_id,now+LEASE_MS,c.request_id);
  }
  return {status:'claimed',run:view(load(db,c.request_id))};
 }
 need(!run||isRepositoryResearchPlan(JSON.parse(Buffer.from(run.plan))),'retired_plan_read_only');
 if(c.action==='settle')need(exact(c.args,'operation_id,outcome,elapsed_seconds,archive_sha256,file_sha256,native_result')&&string(c.args.operation_id,UUID)&&['acknowledged','unknown'].includes(c.args.outcome),'settle_fields');
 if(c.action==='settle'&&run&&run.revision===c.expected_revision){
  const original=db.prepare('SELECT owner_id,epoch FROM research_control_ops WHERE request_id=? AND operation_id=?').get(c.request_id,c.args.operation_id??'');
  const resumed=db.prepare("SELECT 1 FROM research_control_commands WHERE request_id=? AND json_extract(result,'$.dispatch_granted')=1 AND json_extract(result,'$.run.owner_id')=? AND json_extract(result,'$.run.epoch')=? AND EXISTS(SELECT 1 FROM json_each(result,'$.operations') WHERE json_extract(value,'$.operation_id')=?)").get(c.request_id,c.owner_id,c.epoch,c.args.operation_id);
  // Every committed grant retains its executor in the immutable command
  // result. A later takeover cannot erase a resumed executor's late evidence.
  if(!(original&&original.owner_id===c.owner_id&&original.epoch===c.epoch)&&!resumed)owner(run,c,now);
 }else owner(run,c,now);
 const plan=JSON.parse(Buffer.from(run.plan));const budget=effectiveResearchBudget(db,run,plan,now,cache);let grants=[];
 if(c.action==='page_begin'){
  need(budget?.window.active,'research_continuation_not_due');
  beginPageRound(db,run,c.args,now);
 }else if(c.action==='recovery_grant'){
  need(exact(c.args,'grant_base64')&&typeof c.args.grant_base64==='string','recovery_fields');
  const bytes=Buffer.from(c.args.grant_base64,'base64');need(bytes.toString('base64')===c.args.grant_base64,'recovery_encoding');
  appendResearchRecoveryGrant(db,bytes,{request_id:run.request_id,generation:config.research_control.generation,plan_hash:run.plan_hash,plan},{now});
 }else if(c.action==='renew')need(exact(c.args,''),'renew_fields');
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
   need(exact(op,'operation_id,kind,key,input_sha256,input,max_seconds')&&string(op.operation_id,UUID)&&['source','model','native'].includes(op.kind)&&typeof op.key==='string'&&op.key.length>0&&op.key.length<=180&&string(op.input_sha256,HASH)&&integer(op.max_seconds,0,(budget?operationBudget({schema_version:'research_plan_v4',limits:budget.limits},op.kind):operationBudget(plan,op.kind))),'operation_fields');
   need(!db.prepare('SELECT 1 FROM research_control_ops WHERE operation_id=?').get(op.operation_id),'operation_id_used');
   const used=db.prepare('SELECT count(*) n FROM research_control_ops WHERE request_id=? AND kind=? AND operation_key=?').get(c.request_id,op.kind,op.key).n;
   if(op.kind==='native'){
    need(op.max_seconds===0&&used===0,'native_intent_exists');
    need(exact(op.input,'archive_sha256,permit_id,step,file_id,source_ts,bytes,sha256')&&['ticket','post','complete','submit'].includes(op.input.step)&&string(op.input.sha256,HASH)&&integer(op.input.bytes,1,16*1024*1024)&&(op.input.file_id===null||string(op.input.file_id,/^[A-Z0-9]{1,128}$/))&&(op.input.source_ts===null||string(op.input.source_ts,/^\d{10}\.\d{6}$/)),'safe_native_intent');
    need(digest(Buffer.from(JSON.stringify(op.input)))===op.input_sha256,'native_input_hash');
    nativePredecessor(db,run,op);
   }else{
    need(run.inputs_hash!==null&&activePageResearch(db,run,plan).active&&(run.permit===null||budget),'research_inputs_or_phase');need(op.max_seconds>0,'research_operation_input');
    if(op.kind==='source'){const source=researchSourceIdentity(op.input);need(op.key===source.hash&&op.input_sha256===source.hash,'source_identity_hash');}
    else if(budget&&used>0){
     need(exact(op.input,'previous_operation_id,checkpoint_archive_sha256,checkpoint_file_sha256')&&string(op.input.previous_operation_id,UUID)&&string(op.input.checkpoint_archive_sha256,HASH)&&string(op.input.checkpoint_file_sha256,HASH),'model_recovery_checkpoint');
     const prior=db.prepare("SELECT * FROM research_control_ops WHERE request_id=? AND kind='model' AND operation_key=? ORDER BY rowid DESC LIMIT 1").get(c.request_id,op.key);
     need(prior&&prior.operation_id===op.input.previous_operation_id&&prior.phase==='acknowledged'&&prior.elapsed_seconds!==null&&prior.result_archive===op.input.checkpoint_archive_sha256&&prior.result_file===op.input.checkpoint_file_sha256,'model_recovery_original');
     need(classifiedResult(db,run,prior,cache)?.outcome==='failed','model_recovery_not_failed');
     const succeeded=budget.operations.filter(item=>item.kind==='model'&&item.operation_key===op.key&&classifiedResult(db,run,item,cache)?.outcome!=='failed').reduce((n,item)=>n+(item.elapsed_seconds??item.reserved_seconds),0);
     need(researchSecondsWithin(succeeded+op.max_seconds,budget.limits.model_stage_timeout_seconds),'model_stage_budget');
    }else need(op.input===null,'research_operation_input');
    if(budget){
     need(budget.window.active,'research_continuation_not_due');
     const key=JSON.stringify([op.kind,op.key]),successes=budget.accounting.successful_attempts[key]??0;
     const unresolved=budget.operations.some(item=>item.kind===op.kind&&item.operation_key===op.key&&(!classifiedResult(db,run,item,cache)||item.elapsed_seconds===null));
     need(!unresolved,'research_original_result_unknown');
     need(op.kind==='source'?string(op.key,HASH)&&successes<budget.limits.max_attempts_per_source:pageModelKeyAllowed(activePageResearch(db,run,plan),op.key)&&successes<budget.limits.max_attempts_per_model,'attempt_budget');
     need(researchSecondsWithin(budget.accounting.success_seconds+budget.accounting.reserved_seconds+op.max_seconds,budget.limits.total_budget_seconds),'time_budget');
     // Reserve against the same accounting snapshot for every member of a batch.
     budget.accounting.reserved_seconds+=op.max_seconds;
     const windowStart=budget.window.start??budget.window.window_start??budget.window.not_before;
     const count=db.prepare('SELECT count(DISTINCT x.operation_id) AS n FROM research_recovery_operations x JOIN research_control_ops o ON o.operation_id=x.operation_id WHERE x.request_id=? AND x.window_start=? AND o.kind=? AND o.operation_key=?').get(c.request_id,windowStart,op.kind,op.key).n;
     need(count<2,'research_window_attempts_exhausted');
    }else{
     need(now<run.started_at+plan.limits.total_budget_seconds*1000,'research_deadline');
     need(op.kind==='source'?string(op.key,HASH)&&used<plan.limits.max_attempts_per_source:pageModelKeyAllowed(activePageResearch(db,run,plan),op.key)&&used<plan.limits.max_attempts_per_model,'attempt_budget');
     need(run.charged_seconds+op.max_seconds<=plan.limits.total_budget_seconds,'time_budget');
    }
    run.charged_seconds+=op.max_seconds;
   }
   db.prepare("INSERT INTO research_control_ops VALUES(?,?,?,?,?,?,?,?,?,'intent',NULL,NULL,NULL,NULL)").run(op.operation_id,c.request_id,op.kind,op.key,op.input_sha256,JSON.stringify(op.input),c.owner_id,c.epoch,op.max_seconds);
   if(budget&&op.kind!=='native'){
    const windowStart=budget.window.start??budget.window.window_start??budget.window.not_before;
    recordResearchRecoveryOperation(db,{operation_id:op.operation_id,request_id:c.request_id,grant_id:budget.grant_id,window_start:windowStart},now);
    budget.operations.push({...op,operation_key:op.key,phase:'intent',reserved_seconds:op.max_seconds});
   }
   grants.push({operation_id:op.operation_id,kind:op.kind,key:op.key,input_sha256:op.input_sha256});
  }
  db.prepare('UPDATE research_control_runs SET charged_seconds=? WHERE request_id=?').run(run.charged_seconds,c.request_id);
 }else if(c.action==='resume'){
  need(exact(c.args,'operation_id')&&string(c.args.operation_id,UUID),'resume_fields');
  const op=db.prepare('SELECT * FROM research_control_ops WHERE request_id=? AND operation_id=?').get(c.request_id,c.args.operation_id);
  need(op&&op.phase==='intent','resume_original_intent');
  if(!budget)need(researchOperationDispatchValid(db,run,op,now),'research_deadline');
  const events=[];
  for(const event of db.prepare('SELECT source_ts,phase,reply_text FROM research_control_events WHERE reply_text IS NOT NULL').iterate()){
   const reply=JSON.parse(event.reply_text.slice('!ai-research control-receipt '.length));
   if((reply.dispatch_granted||reply.grant_expired)&&reply.operations?.some(item=>item.operation_id===op.operation_id))events.push({source_ts:event.source_ts,phase:event.phase,dispatch_granted:reply.dispatch_granted});
  }
  need(events.length>0&&events.every(event=>event.phase==='ready'||event.phase==='superseded'||event.phase==='sent'&&event.dispatch_granted===false),'resume_dispatch_not_proven_unstarted');
  if(budget&&op.kind!=='native'){
   const scope=activePageResearch(db,run,plan);
   need(budget.window.active&&scope.active&&(op.kind!=='model'||pageModelKeyAllowed(scope,op.operation_key)),'research_continuation_not_due');
   const windowStart=budget.window.start??budget.window.window_start??budget.window.not_before;
   const count=db.prepare('SELECT count(DISTINCT x.operation_id) AS n FROM research_recovery_operations x JOIN research_control_ops o ON o.operation_id=x.operation_id WHERE x.request_id=? AND x.window_start=? AND o.kind=? AND o.operation_key=? AND o.operation_id!=?').get(c.request_id,windowStart,op.kind,op.operation_key,op.operation_id).n;
   need(count<2,'research_window_attempts_exhausted');
   recordResearchRecoveryOperation(db,{operation_id:op.operation_id,request_id:c.request_id,grant_id:budget.grant_id,window_start:windowStart},now);
  }
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
 }else if(c.action==='page_permit'){
  need(exact(c.args,'publication_request_id,archive_sha256,bundle_sha256,audit_sha256')&&/^morning-\d{8}-r(?:[2-9]|[1-9][0-9]+)$/.test(c.args.publication_request_id)&&string(c.args.bundle_sha256,HASH)&&string(c.args.audit_sha256,HASH),'permit_fields');
  need(run.inputs_hash,'publication_bytes_missing');
  const pageProof=publicationEvidence(db,run,plan,c.args,now,cache,true);
  const round=currentPageRound(db,run.request_id);
  need(round?.request_id===c.args.publication_request_id,'page_current_round');
  const {publication_request_id,...binding}=c.args;
  const prior=round.permit?JSON.parse(round.permit):null;
  const permit={permit_id:prior?.permit_id??randomUUID(),request_id:publication_request_id,page_ids:pageProof.completed_pages,report_date:run.report_date,prompt_commit_sha:plan.prompt_commit_sha,publisher_scope_sha256:db.prepare('SELECT value FROM scope WHERE id=1').get().value,...binding};
  appendPagePermit(db,run,permit);
 }else if(c.action==='permit'){
  need(exact(c.args,'archive_sha256,bundle_sha256,audit_sha256')&&string(c.args.bundle_sha256,HASH)&&string(c.args.audit_sha256,HASH),'permit_fields');
  const files=archive(db,c.request_id,c.args.archive_sha256);need(run.inputs_hash&&files.some(f=>f.sha256===c.args.bundle_sha256)&&files.some(f=>f.sha256===c.args.audit_sha256),'publication_bytes_missing');
  publicationEvidence(db,run,plan,c.args,now,cache);
  if(run.permit){const prior=JSON.parse(run.permit);need(prior.bundle_sha256===c.args.bundle_sha256&&prior.audit_sha256===c.args.audit_sha256&&prior.archive_sha256===c.args.archive_sha256,'immutable_publication_permit');}
  else{
   const permit={permit_id:randomUUID(),request_id:c.request_id,report_date:run.report_date,prompt_commit_sha:plan.prompt_commit_sha,publisher_scope_sha256:db.prepare('SELECT value FROM scope WHERE id=1').get().value,...c.args};
   db.prepare('UPDATE research_control_runs SET permit=? WHERE request_id=?').run(JSON.stringify(permit),c.request_id);
  }
 }
 const lease=run.owner_id===c.owner_id&&run.epoch===c.epoch&&run.lease_until>now?now+LEASE_MS:run.lease_until;
 db.prepare('UPDATE research_control_runs SET revision=revision+1,lease_until=? WHERE request_id=?').run(lease,c.request_id);
 return {status:'committed',run:view(load(db,c.request_id)),page_round:currentPageRound(db,c.request_id),dispatch_granted:grants.length>0,operations:grants};
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
   if(['permit','page_permit'].includes(c.action)){const check=publicationChecks.get(publicationCheck);need(check?.command_hash===hash,'publication_validation_required');need(!check.code,check.code);}
   result=apply(db,c,now,config);db.exec('RELEASE command');
  }catch(e){if(!e.researchControlCode)throw e;db.exec('ROLLBACK TO command; RELEASE command');result={status:'rejected',code:e.researchControlCode,run:view(load(db,c.request_id)),dispatch_granted:false};}
  result={command_id:c.command_id,command_sha256:hash,request_id:c.request_id,...result};
  need(Buffer.byteLength(JSON.stringify(result))<=16000,'control_result_limit');
  db.prepare('INSERT INTO research_control_commands VALUES(?,?,?,?,?)').run(c.command_id,c.request_id,hash,bytes,JSON.stringify(result));onResult(result);db.exec('COMMIT');return result;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
