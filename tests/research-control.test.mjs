import {producerInspection} from '../scripts/producer-inspect.mjs';
import {replyScheduledStatus} from '../scripts/scheduled-delivery-bridge.mjs';
import {inspectDay} from '../scripts/producer-day.mjs';
import {installResearchRecovery,approveResearchRecoveryGrant,nextResearchContinuationAt} from '../scripts/research-recovery.mjs';
// Isolated host authority fixtures. No real provider calls or native uploads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {administerRecovery} from '../scripts/research-recovery-admin.mjs';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {REQUIRED_RESEARCH_CHECKS} from '../scripts/research-coverage.mjs';
import {DISCOVERY_CHECKS,DISCOVERY_CONTRACT} from '../scripts/research-discovery.mjs';
import {auditBudget,LAYERED_BUDGET_POLICY} from '../scripts/research-budget.mjs';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {installFence} from '../scripts/producer-admission-fence.mjs';
import {installSubmission,advanceSubmission,queueSubmission,acceptSubmission,submissionStatus,pendingSubmissions} from '../scripts/slack-submission.mjs';
import {PublisherInbox} from '../scripts/publisher-inbox.mjs';
import {propose} from '../scripts/propose.mjs';
import {FakeGitHub} from './helpers/fake-github.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {installResearchArchive,storeResearchArchive,decodeResearchArchive} from '../scripts/research-archive.mjs';
import {installResearchControl,installReportParts,migrateResearchControl,assertResearchControl,executeResearchControl,researchSourceIdentity,decodeResearchControl,preparePublicationCheck,RESEARCH_CONTROL_SCHEMA,researchOperationDispatchValid} from '../scripts/research-control.mjs';
import {advanceResearchControl,queueResearchControl,pendingResearchControls,researchControlHealth} from '../scripts/research-control-inbox.mjs';
import {handoffTick} from '../scripts/run-handoff.mjs';
import {nativeResearchAuthority,researchCommandText,verifyResearchControlReceipt,CONTROL_THREAD_TOOL} from '../scripts/research-control-client.mjs';
import {readCompleteResearchStatus} from '../scripts/research-status-pages.mjs';
import {stageFile} from '../scripts/slack-stage-cli.mjs';
import {PRODUCER_TOOLS,producerTicket} from '../scripts/producer-upload.mjs';
import {digest,validateArchive} from '../scripts/archive.mjs';
import {REPOSITORY_INPUT_PATHS,repositoryResearchInputsHash,readRepositoryResearchInputs,repositoryInputCachePath} from '../scripts/repository-research-inputs.mjs';
import {SCOPE,DAY,FILES} from './helpers/cloud-sender-fixture.mjs';
const now=1793491210000,id='morning-20261101-r1',ownerA=randomUUID(),ownerB=randomUUID();
const {transport_profile,notification_destination,...identity}=SCOPE;
const fence={generation:randomUUID(),activation_ts:'1793491200.000000',producer_scope_sha256:'b'.repeat(64),installation:{journal_device:'1',journal_inode:'2',lock_device:'1',lock_inode:'3'}};
const config={...identity,durable_intake:{not_before:'1793462400.000000'},producer_fence:fence,scheduled_delivery:{activation_date:DAY,executable:'/usr/bin/python3',args:[]},slack_submission:{activation_ts:fence.activation_ts,first_report_date:DAY,generation:randomUUID()},research_archive:{activation_ts:fence.activation_ts,first_report_date:DAY,generation:randomUUID()},research_control:{activation_ts:fence.activation_ts,first_report_date:DAY,generation:randomUUID(),protocol:'repository_inputs_v1'}};
const input=Buffer.from('new research output\r\n');
const repositoryFiles=new Map(REPOSITORY_INPUT_PATHS.map(path=>[path,Buffer.from('original repository file: '+path+'\r\n')]));
const plan=Buffer.from(JSON.stringify({schema_version:'research_plan_v3',request_id:id,report_date:DAY,prompt_commit_sha:'a'.repeat(40),reports_commit_sha:'b'.repeat(40),files:Object.fromEntries([...repositoryFiles].map(([path,data])=>[path,digest(data)])),model_stages:['editor','review'],limits:{max_attempts_per_source:2,max_attempts_per_model:1,operation_timeout_seconds:180,total_budget_seconds:3600}}));
function auditSummary(overrides={},files=FILES){
 const p=JSON.parse(plan),gaps=overrides.readiness==='partial'?['qwen_blog']:[];
 return {schema_version:'1.3',date:DAY,audit_valid:true,blockers:[],readiness:'ready',delivery_allowed:false,
  coverage_contract:'daily_required_v1',required_checks:[...REQUIRED_RESEARCH_CHECKS],coverage_unchecked:[],
  coverage_checked:REQUIRED_RESEARCH_CHECKS.filter(name=>!gaps.includes(name)),coverage_incomplete:gaps,
  selected_count:overrides.readiness==='zero_items'?0:1,budget_unknown:true,
  inputs:{prompt_commit:p.prompt_commit_sha,history_commit:p.reports_commit_sha,
   prompt_hashes:Object.fromEntries(Object.entries(p.files).filter(([path])=>path.startsWith('ai_brief/')).map(([path,hash])=>[path.split('/').at(-1),hash])),
   history_sha256:p.files['reports/index.json'],draft_sha256:digest([...files].find(([path])=>path.endsWith('/report.json'))[1])},
  limits:{source_attempts:2,model_attempts:1,operation_seconds:180,run_seconds:3600},...overrides};
}
function setup(path=':memory:',c=config){
 const state=new HandoffState(path,handoffScope(c));installFence(state.db,fence,'synthetic',[]);installSubmission(state.db,c,'synthetic');installResearchArchive(state.db,c,'synthetic');installResearchControl(state.db,c,'synthetic');return state;
}
function command(action,args={},run=null,owner=ownerA){return {schema_version:'research_control_v2',command_id:randomUUID(),request_id:id,action,owner_id:['status','receipt'].includes(action)?null:owner,epoch:run?.epoch??0,expected_revision:run?.revision??0,args};}
const execute=(s,c,clock=now)=>executeResearchControl(s.db,config,Buffer.from(JSON.stringify(c)),clock);
const issuePermit=async(s,c)=>{const bytes=Buffer.from(JSON.stringify(c));return executeResearchControl(s.db,config,bytes,now,{publicationCheck:await preparePublicationCheck(s.db,bytes)});};
function archive(s,files){
 const previous_sha256=s.db.prepare('SELECT hash FROM research_archive_heads WHERE report_date=?').get(DAY)?.hash??null;
 const bytes=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:randomUUID(),request_id:id,report_date:DAY,previous_sha256,files:Object.entries(files).map(([path,data])=>({path,sha256:digest(data),content_base64:data.toString('base64')}))}));
 const hash=digest(bytes);storeResearchArchive(s.db,{request_id:id,hash,source_ts:'1793491201.'+String(s.db.prepare('SELECT count(*) n FROM research_archives').get().n).padStart(6,'0'),file_id:'FARCHIVE'},bytes);return hash;
}
const repositoryPlan=plan;
test('runtime probe detects an outstanding incomplete permit in a restored ledger',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'edition-permit-')),file=join(dir,'handoff.sqlite');
 const day='2026-11-19',request='morning-20261119-r1';
 let s=setup(file);
 try{
  const frozen=Buffer.from(JSON.stringify({...JSON.parse(plan),report_date:day,request_id:request}));
  const claim={...command('claim',{plan_base64:frozen.toString('base64')}),request_id:request};
  const run=executeResearchControl(s.db,config,Buffer.from(JSON.stringify(claim)),now+18*86400000);
  assert.equal(run.status,'claimed',JSON.stringify(run));
  installPageAuthority(s.db);
  assert.throws(()=>beginPageRound(s.db,run.run,{added:[],previous_request_id:request},now),/whole_edition_revision_required/);
  const revision='morning-20261119-r2';
  s.db.prepare('INSERT INTO research_page_rounds VALUES(?,?,?,?,?,?,NULL)').run(revision,request,2,'{}','[]',now);
  assert.equal(pageRevisionReserved(s.db,revision,day),false);
  s.db.prepare('UPDATE research_page_rounds SET permit=? WHERE request_id=?').run('{}',revision);
  assert.equal(pageRevisionReserved(s.db,revision,day),true);
  s.db.prepare('UPDATE research_page_rounds SET permit=NULL WHERE request_id=?').run(revision);
  const files=new Map([...FILES].map(([p,b])=>[p.replace(DAY,day),b]));
  const name=[...files.keys()].find(p=>p.endsWith('/report.json')),report=JSON.parse(files.get(name));
  report.date=day;report.entries=report.entries.filter(entry=>entry.article_id!==report.articles[0].id);
  files.set(name,Buffer.from(JSON.stringify(report)));
  const bundle=await encodeBundle(files,request,'b'.repeat(40),'a'.repeat(40)),audit=Buffer.from('{}');
  const original=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:randomUUID(),request_id:request,
   report_date:day,previous_sha256:null,files:[['bundle.json',bundle],['audit.json',audit]].map(([path,data])=>({path,sha256:digest(data),content_base64:data.toString('base64')}))}));
  storeResearchArchive(s.db,{request_id:request,hash:digest(original),source_ts:'1795045000.000001',file_id:'FORIGINAL'},original);
  const permit=JSON.stringify({request_id:request,permit_id:randomUUID(),archive_sha256:digest(original),bundle_sha256:digest(bundle),audit_sha256:digest(audit)});
  s.db.prepare('UPDATE research_control_runs SET permit=? WHERE request_id=?').run(permit,request);
  s.close();s=new HandoffState(file,handoffScope(config));
  assert.throws(()=>assertResearchControl(s.db,config),/outstanding_permit_requires_complete_edition/);
  assert.equal(s.db.prepare('SELECT permit FROM research_control_runs WHERE request_id=?').get(request).permit,permit);
 }finally{s.close();await rm(dir,{recursive:true,force:true});}
});
function start(s,bytes=plan){if(JSON.parse(bytes).schema_version==='research_plan_v4')installResearchRecovery(s.db,'synthetic layered activation');const claim=execute(s,command('claim',{plan_base64:bytes.toString('base64')}));assert.equal(claim.status,'claimed');const result=execute(s,command('inputs',{},claim.run));assert.equal(result.status,'committed');return result.run;}
function message(text,ts,file){return {type:'message',user:SCOPE.sender_user_id,app_id:SCOPE.sender_user_app_id,ts,text:text+' '+SCOPE.sender_attribution_text,...(file?{files:[{id:file}]}:{}),blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text}]}]},{type:'context',elements:[{type:'mrkdwn',text:SCOPE.sender_attribution_text,verbatim:false}]}]};}
const source=(key='https://example.org/changes',kind='source')=>{const input=kind==='source'?{method:'GET',url:key}:null,hash=input?researchSourceIdentity(input).hash:'d'.repeat(64);return {operation_id:randomUUID(),kind,key:input?hash:key,input_sha256:hash,input,max_seconds:180};};
const unknown=operation_id=>({operation_id,outcome:'unknown',elapsed_seconds:null,archive_sha256:null,file_sha256:null,native_result:null});

// Construct the exact original policy shape; preserve all other fixture rows.
function originalPolicy(s,c=config){
 const {protocol,...old}=c.research_control,previous={...c,research_control:old};
 const binding=JSON.parse(s.db.prepare('SELECT binding FROM research_control_policy').get().binding);delete binding.protocol;
 s.db.prepare('UPDATE research_control_policy SET binding=?').run(JSON.stringify(binding));return previous;
}
const authorityRows=s=>Object.fromEntries(Object.keys(RESEARCH_CONTROL_SCHEMA).filter(n=>n!=='research_control_policy').map(n=>[n,s.db.prepare('SELECT * FROM '+n+' ORDER BY rowid').all()]));

test('explicit original authority upgrade preserves empty ledger and rejects mismatched or repeated migration',()=>{
 const s=setup();try{
  const previous=originalPolicy(s),rows=authorityRows(s),binding=s.db.prepare('SELECT * FROM research_control_policy').get();
  assertResearchControl(s.db,previous);assert.throws(()=>assertResearchControl(s.db,config),/binding/);
  assert.throws(()=>migrateResearchControl(s.db,{...config,research_control:{...config.research_control,generation:randomUUID()}},'wrong generation'),/binding/);
  assert.deepEqual(s.db.prepare('SELECT * FROM research_control_policy').get(),binding);
  assert.throws(()=>migrateResearchControl(s.db,config,''),/reference/);
  migrateResearchControl(s.db,config,'constructed upgrade evidence');assertResearchControl(s.db,config);
  assert.deepEqual(authorityRows(s),rows);
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT evidence_reference FROM research_control_policy').get().evidence_reference),{original_evidence_reference:'synthetic',migration_reference:'constructed upgrade evidence',protocol:'repository_inputs_v1'});
  assert.throws(()=>assertResearchControl(s.db,previous),/binding/);
  assert.throws(()=>migrateResearchControl(s.db,config,'repeat'),/binding/);
  assert.equal(execute(s,command('claim',{plan_base64:plan.toString('base64')})).status,'claimed');
 }finally{s.close();}
});

test('old policy permits observations only; migration preserves v2 unknown budget and permanently fences its execution',async()=>{
 const s=setup();try{
  const run=start(s),op=source(),c=command('reserve',{operations:[op]},run);queue(s,c);
  await advanceResearchControl(s,config,{controlReceipt:async()=>{throw Error('constructed unknown receipt');}},now);
  const v2=Buffer.from(JSON.stringify({...JSON.parse(plan),schema_version:'research_plan_v2'}));
  s.db.prepare('UPDATE research_control_runs SET plan=?,plan_hash=?').run(v2,digest(v2));
  const previous=originalPolicy(s);
  const read=command('status',{offset:0}),observed=executeResearchControl(s.db,previous,Buffer.from(JSON.stringify(read)),now);
  assert.equal(observed.status,'observed');assert.equal(observed.run.charged_seconds,180);assert.equal(observed.operations[0].phase,'intent');
  assert.equal(researchControlHealth(s.db).blocked.length,1);assert.equal(researchControlHealth(s.db).frozen.length,0);
  const denied=executeResearchControl(s.db,previous,Buffer.from(JSON.stringify(command('renew',{},observed.run))),now);
  assert.equal(denied.code,'authority_migration_required');
  const rows=authorityRows(s);migrateResearchControl(s.db,config,'constructed v2 migration');assert.deepEqual(authorityRows(s),rows);
  const health=researchControlHealth(s.db);assert.equal(health.blocked.length,0);assert.equal(health.frozen.length,1);
  assert.equal(health.frozen[0].phase,'unknown');assert.equal(health.frozen[0].request_id,id);
  assert.equal(execute(s,command('renew',{},observed.run)).code,'retired_plan_read_only');
  assert.equal(execute(s,command('settle',unknown(op.operation_id),observed.run)).code,'retired_plan_read_only');
  assert.equal(execute(s,command('claim',{plan_base64:plan.toString('base64')},observed.run),now+16*60000).code,'retired_plan_read_only');
  const after=execute(s,command('status',{offset:0}));assert.equal(after.run.charged_seconds,180);assert.equal(after.operations[0].phase,'intent');assert.equal(after.run.epoch,observed.run.epoch);
  await advanceResearchControl(s,config,{controlReceipt:async()=>assert.fail('unknown receipt never replayed')},now+600000);
 }finally{s.close();}
});

test('migration rejects unfinished original staging before changing any policy or business row',async()=>{
 for(const kind of ['bundle','event']){
  const s=setup();try{
   const previous=originalPolicy(s),bytes=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40));
   if(kind==='bundle')s.db.prepare('INSERT INTO slack_staged_bundles(request_id,report_date,hash,source_ts,file_id,bytes) VALUES(?,?,?,?,?,?)').run(id,DAY,digest(bytes),'1793491201.000001','FORIGINAL',bytes);
   else s.db.prepare("INSERT INTO slack_submission_events(source_ts,kind,request_id,hash,file_id) VALUES(?,'stage',?,?,?)").run('1793491201.000001',id,digest(bytes),'FORIGINAL');
   const before=s.db.prepare('SELECT * FROM research_control_policy').get(),rows=authorityRows(s);
   assert.throws(()=>migrateResearchControl(s.db,config,'premature migration'),/Reconcile original/);
   assert.deepEqual(s.db.prepare('SELECT * FROM research_control_policy').get(),before);assert.deepEqual(authorityRows(s),rows);assertResearchControl(s.db,previous);
   assert.equal(s.db.prepare('SELECT count(*) n FROM '+(kind==='bundle'?'slack_staged_bundles':'slack_submission_events')).get().n,1);
  }finally{s.close();}
 }
});

test('lost claim reply, competing owners and takeover preserve original plan and charged unknown budget',()=>{
 const s=setup();try{
  const c=command('claim',{plan_base64:plan.toString('base64')}),first=execute(s,c);assert.equal(first.status,'claimed');
  assert.equal(execute(s,c).replayed,true);assert.equal(execute(s,c).dispatch_granted,false);
  const competing=execute(s,command('claim',c.args,first.run,ownerB));assert.equal(competing.code,'owner_still_live');
  let run=execute(s,command('inputs',{},first.run)).run;
  const op=source(),reserve=execute(s,command('reserve',{operations:[op]},run));assert.equal(reserve.dispatch_granted,true);run=reserve.run;
  run=execute(s,command('settle',unknown(op.operation_id),run)).run;assert.equal(run.charged_seconds,180);
  const clock=now+16*60000,takeover=execute(s,command('claim',c.args,run,ownerB),clock);assert.equal(takeover.status,'claimed');assert.equal(takeover.run.charged_seconds,180);assert.equal(takeover.run.epoch,2);assert.equal(takeover.run.started_at,now);
  assert.equal(execute(s,command('reserve',{operations:[source()]},takeover.run,ownerA),clock).code,'owner_fenced');
  const second=execute(s,command('reserve',{operations:[source()]},takeover.run,ownerB),clock);assert.equal(second.dispatch_granted,true);
  assert.equal(execute(s,command('reserve',{operations:[source()]},second.run,ownerB),clock).code,'attempt_budget');
 }finally{s.close();}
});

test('native authority client records each upload boundary and host archive commit completes the original intent',async()=>{
 const s=setup();try{
  execute(s,command('claim',{plan_base64:plan.toString('base64')}));
  const bytes=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:randomUUID(),request_id:id,report_date:DAY,previous_sha256:null,files:[{path:'research/notes.md',sha256:digest(input),content_base64:input.toString('base64')}]})),hash=digest(bytes),events=[];
  const authority=nativeResearchAuthority({request_id:id,owner_id:ownerA,archive_sha256:hash},async bytes=>executeResearchControl(s.db,config,bytes,now),()=>now);
  const ticket={file_id:'FORIGINAL',upload_url:'https://files.slack.com/upload/v1/synthetic-test-only'};
  const intent=step=>{const op=s.db.prepare('SELECT * FROM research_control_ops WHERE operation_key=?').get('archive:'+hash+':'+step);assert.equal(op.phase,'intent');events.push(step);return op;};
  await stageFile(bytes,SCOPE.channel_id,async(tool,args,operation_id)=>{
   if(tool===PRODUCER_TOOLS.ticket){assert.equal(intent('ticket').operation_id,operation_id);return ticket;}
   assert.equal(intent('complete').operation_id,operation_id);assert.equal(args.file_id,ticket.file_id);assert.equal(args.initial_comment,`!ai-research save ${id} ${hash}`);return {};
  },{authority,research:true,upload:async({bytes:original})=>{intent('post');assert.deepEqual(original,bytes);assert.equal(s.db.prepare("SELECT phase FROM research_control_ops WHERE operation_key=?").get('archive:'+hash+':ticket').phase,'acknowledged');return {adapter:'producer_curl_managed_proxy_v1',file_id:ticket.file_id,url_sha256:producerTicket(ticket).url_sha256,bundle_sha256:hash,metrics:{curl_exit:0,http_status:200,upload_bytes:bytes.length,num_redirects:0,ssl_verify_result:0}};}});
  assert.deepEqual(events,['ticket','post','complete']);
  s.db.exec('BEGIN IMMEDIATE');storeResearchArchive(s.db,{request_id:id,hash,source_ts:'1793491203.000001',file_id:ticket.file_id},bytes);s.db.exec('COMMIT');
  const completion=s.db.prepare("SELECT * FROM research_control_ops WHERE operation_key=?").get('archive:'+hash+':complete');assert.equal(completion.phase,'acknowledged');assert.equal(JSON.parse(completion.native_result).source_ts,'1793491203.000001');
  // A new disposable process cannot acquire another ticket for the same bytes.
  const restarted=nativeResearchAuthority({request_id:id,owner_id:ownerA,archive_sha256:hash},async bytes=>executeResearchControl(s.db,config,bytes,now),()=>now);
  const recovered=await stageFile(bytes,SCOPE.channel_id,()=>assert.fail('no duplicate upload'),{authority:restarted,research:true});assert.equal(recovered.file_id,'FORIGINAL');assert.equal(recovered.source_ts,'1793491203.000001');
 }finally{s.close();}
});
test('fixed input path or renamed original bytes are rejected before native ticket, POST or host intent',async()=>{
 for(const mode of ['path','renamed']){
  const s=setup();try{
   start(s);const original=REPOSITORY_INPUT_PATHS[0],data=mode==='path'?Buffer.from('changed bytes'):repositoryFiles.get(original);
   const bytes=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:randomUUID(),request_id:id,report_date:DAY,previous_sha256:null,files:[{path:mode==='path'?original:'output/renamed.txt',sha256:digest(data),content_base64:data.toString('base64')}]}));
   const authority=nativeResearchAuthority({request_id:id,owner_id:ownerA,archive_sha256:digest(bytes)},async bytes=>executeResearchControl(s.db,config,bytes,now),()=>now);
   await assert.rejects(stageFile(bytes,SCOPE.channel_id,()=>assert.fail('no native write'),{authority,research:true,upload:()=>assert.fail('no POST')}),/Repository inputs must be references/);
   assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,0);
   assert.equal(s.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);
  }finally{s.close();}
 }
});
test('a real child-process exit after confirmed POST resumes completion using the original host file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'authority-process-')),database=join(dir,'original.sqlite'),fixture=join(dir,'fixture.json');let s=setup(database);try{
  execute(s,command('claim',{plan_base64:plan.toString('base64')}));s.close();s=null;
  const bytes=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:randomUUID(),request_id:id,report_date:DAY,previous_sha256:null,files:[{path:'research/notes.md',sha256:digest(input),content_base64:input.toString('base64')}]}));
  await writeFile(fixture,JSON.stringify({config,database,now,id,owner:ownerA,base64:bytes.toString('base64')}));
  const child=mode=>spawnSync(process.execPath,['tests/helpers/research-control-process.mjs',fixture,mode],{encoding:'utf8',timeout:10000});
  const killed=child('exit-after-post');assert.equal(killed.status,77,killed.stderr);
  const resumed=child('resume');assert.equal(resumed.status,0,resumed.stderr);assert.match(resumed.stdout,/"file_id":"FORIGINAL"/);
  s=new HandoffState(database,handoffScope(config));assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,3);
  assert.equal(s.db.prepare("SELECT count(*) n FROM research_control_ops WHERE phase='acknowledged'").get().n,3);
  assert.equal(s.db.prepare('SELECT file_id FROM research_archives').get().file_id,'FORIGINAL');
 }finally{s?.close();delete config.producer_app_id;delete config.merger_app_id;delete config.ready_for_review;await rm(dir,{recursive:true,force:true});}
});
test('wire size rejects oversized batches before reservation and malformed settle receives a terminal reply',async()=>{
 const s=setup();try{
  const run=start(s),small=command('reserve',{operations:Array.from({length:8},(_,i)=>source('https://api.github.com/repos/example/project/commits?page='+i))},run);
  assert.ok(researchCommandText(Buffer.from(JSON.stringify(small))).length<=5000);
  const large={...small,args:{operations:Array.from({length:8},(_,i)=>source('https://example.org/'+String(i)+'x'.repeat(1600)))}};
  assert.throws(()=>decodeResearchControl(Buffer.from(JSON.stringify(large))),/control_wire_limit/);assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,0);
  const malformed=command('settle',{...unknown(randomUUID()),operation_id:{unexpected:true}},run);queue(s,malformed);let reply;
  await advanceResearchControl(s,config,{controlReceipt:async(_ts,text)=>{reply=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793491209.000001';}},now);
  assert.equal(reply.status,'rejected');assert.equal(reply.code,'settle_fields');assert.equal(s.db.prepare('SELECT phase FROM research_control_events').get().phase,'sent');
 }finally{s.close();}
});
test('the existing zero-items report and audit contract remains eligible for a permit',async()=>{
 const s=setup();try{
  const run=start(s),files=new Map(FILES),path=`reports/${DAY}/r1/report.json`,report=JSON.parse(files.get(path));
  report.articles=report.articles.filter(a=>a.id==='hardware-status');report.entries=report.entries.filter(e=>e.article_id==='hardware-status');report.images=report.images.filter(i=>i.path===report.poster);
  for(const key of files.keys())if(key.includes('/articles/')&&!key.endsWith('/hardware-status.md')||key.includes('/assets/')&&!key.endsWith('/'+report.poster))files.delete(key);
  files.set(path,Buffer.from(JSON.stringify(report)));
  validateArchive(files,{checkIndex:false});
  const bytes=await encodeBundle(files,id,'b'.repeat(40),'a'.repeat(40)),audit=Buffer.from(JSON.stringify(auditSummary({readiness:'zero_items'},files)));
  const hash=archive(s,{'bundle.json':bytes,'audit.json':audit});assert.equal((await issuePermit(s,command('permit',{archive_sha256:hash,bundle_sha256:digest(bytes),audit_sha256:digest(audit)},run))).status,'committed');
 }finally{s.close();}
});
test('publication rejects downgraded, incomplete, re-bound or over-budget audit declarations before any permit',async()=>{
 const s=setup();try{
  const run=start(s),bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40)),valid=auditSummary();
  const mutations=[
   a=>{a.schema_version='1.2';},a=>{delete a.coverage_contract;},a=>{a.delivery_allowed=true;},
   a=>{a.coverage_unchecked=['small_models'];},a=>{a.coverage_checked.push('vllm');},
   a=>{a.coverage_checked.pop();},a=>{a.required_checks.push('unknown');},
   a=>{a.readiness='partial';},a=>{a.selected_count=0;},
   a=>{a.inputs.prompt_commit='c'.repeat(40);},a=>{a.inputs.history_commit='c'.repeat(40);},
   a=>{a.inputs.history_sha256='c'.repeat(64);},a=>{a.inputs.prompt_hashes['research.md']='c'.repeat(64);},
   a=>{a.inputs.draft_sha256='c'.repeat(64);},a=>{delete a.limits;},a=>{a.limits.source_attempts=3;},
   a=>{a.coverage_incomplete=['qwen_blog'];a.coverage_checked=a.coverage_checked.filter(x=>x!=='qwen_blog');}
  ];
  for(const name of REQUIRED_RESEARCH_CHECKS)mutations.push(a=>{a.required_checks=a.required_checks.filter(x=>x!==name);});
  for(const mutate of mutations){
   const rejected=structuredClone(valid);mutate(rejected);const audit=Buffer.from(JSON.stringify(rejected)),hash=archive(s,{'bundle.json':bundle,'audit.json':audit});
   const result=await issuePermit(s,command('permit',{archive_sha256:hash,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},run));
   assert.equal(result.code,'publication_coverage_contract');assert.equal(s.db.prepare('SELECT permit FROM research_control_runs').get().permit,null);
  }
  const audit=Buffer.from(JSON.stringify(valid)),hash=archive(s,{'bundle.json':bundle,'audit.json':audit});
  assert.equal((await issuePermit(s,command('permit',{archive_sha256:hash,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},run))).status,'committed');
 }finally{s.close();}
});

test('malformed archived discovery is a rejected permit, never a pending retry',async()=>{
 for(const malformed of ['null source','unknown status']){
  const s=setup();try{
   const p=JSON.parse(layeredPlan()),run=start(s,Buffer.from(JSON.stringify(p))),bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40));
   const required=[...REQUIRED_RESEARCH_CHECKS,...DISCOVERY_CHECKS];
   const metadata={schema_version:'1.4',coverage_contract:DISCOVERY_CONTRACT,
    discovery:{queries:DISCOVERY_CHECKS.map((family,i)=>({id:'q'+i,family,mode:'current',source_id:'s'+i,results:[]}))},
    sources:DISCOVERY_CHECKS.map((_,i)=>({id:'s'+i,status:'ok'})),
    checks:Object.fromEntries(DISCOVERY_CHECKS.map((family,i)=>[family,{status:'checked',source_ids:['s'+i]}]))};
   if(malformed==='null source')metadata.sources.push(null);else metadata.checks.discovery_memory.status='nonsense';
   const raw=Buffer.from(JSON.stringify(metadata));
   const audit=Buffer.from(JSON.stringify(auditSummary({schema_version:'1.4',coverage_contract:DISCOVERY_CONTRACT,
    required_checks:required,coverage_checked:required,budget_policy:LAYERED_BUDGET_POLICY,limits:auditBudget(p),evidence_metadata_sha256:digest(raw)})));
   const hash=archive(s,{'bundle.json':bundle,'audit.json':audit,'metadata.json':raw});
   queue(s,command('permit',{archive_sha256:hash,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},run));
   let reply;
   await advanceResearchControl(s,config,{controlReceipt:async(_ts,text)=>{reply=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793491209.000001';}},now);
   assert.equal(reply?.status,'rejected');assert.equal(reply.code,'publication_coverage_contract');
   assert.equal(s.db.prepare('SELECT permit FROM research_control_runs').get().permit,null);
   assert.equal(s.db.prepare('SELECT phase FROM research_control_events').get().phase,'sent');
   assert.deepEqual(pendingResearchControls(s.db),[]);
  }finally{s.close();}
 }
});

test('native control parser binds the original tool parent and Publisher metadata, not body claims',()=>{
 const s=setup();try{
  const run=start(s),c=command('reserve',{operations:[source()]},run),bytes=Buffer.from(JSON.stringify(c)),ts='1793491202.000001';
  const result={source_ts:ts,...execute(s,c)},scope={channel_id:SCOPE.channel_id,team_id:SCOPE.team_id,sender_user_id:SCOPE.sender_user_id,sender_attribution_text:SCOPE.sender_attribution_text,publisher_user_id:'UPUBLISHER',publisher_bot_id:'BPUBLISHER'};
  const messages=`=== THREAD PARENT MESSAGE ===\nFrom: Sender <sender@example.org> (${scope.sender_user_id})\nTime: now\nMessage TS: ${ts}\n${researchCommandText(bytes)}\n${scope.sender_attribution_text}\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Publisher <botuser-${scope.team_id}-${scope.publisher_bot_id}@slack-bots.com> (${scope.publisher_user_id})\nTime: now\nMessage TS: 1793491203.000001\n!ai-research control-receipt ${JSON.stringify(result)}\n`;
  const invocation={tool:CONTROL_THREAD_TOOL,arguments:{channel_id:scope.channel_id,message_ts:ts,limit:100,response_format:'detailed'},result:{content:[{type:'text',text:JSON.stringify({messages,pagination_info:'There are no more messages in this thread.\n'})}]}};
  assert.equal(verifyResearchControlReceipt(scope,bytes,ts,invocation,now).dispatch_granted,true);
  assert.throws(()=>verifyResearchControlReceipt(scope,bytes,ts,{...invocation,arguments:{...invocation.arguments,channel_id:'COTHER'}},now));
  const forged=structuredClone(invocation);forged.result.content[0].text=forged.result.content[0].text.replace('botuser-'+scope.team_id,'botuser-TOTHER');assert.throws(()=>verifyResearchControlReceipt(scope,bytes,ts,forged,now));
  assert.throws(()=>verifyResearchControlReceipt(scope,bytes,ts,invocation,now+60001),/Fresh original/);
 }finally{s.close();}
});
test('publication permit requires original plan identity and a nonblocking audit for that date',async()=>{
 const s=setup();try{
  const run=start(s),bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40)),audit=auditSummary({readiness:'partial'});
  for(const [bytes,review,code] of [[await encodeBundle(FILES,id,'b'.repeat(40),'c'.repeat(40)),audit,'publication_plan_binding'],[bundle,{...audit,date:'2026-11-02'},'publication_audit_blocked'],[bundle,{...audit,blockers:['unsupported fact']},'publication_audit_blocked']]){
   const originalAudit=Buffer.from(JSON.stringify(review)),hash=archive(s,{'bundle.json':bytes,'audit.json':originalAudit});
   assert.equal((await issuePermit(s,command('permit',{archive_sha256:hash,bundle_sha256:digest(bytes),audit_sha256:digest(originalAudit)},run))).code,code);
  }
  const originalAudit=Buffer.from(JSON.stringify(audit)),hash=archive(s,{'bundle.json':bundle,'audit.json':originalAudit});
  assert.equal((await issuePermit(s,command('permit',{archive_sha256:hash,bundle_sha256:digest(bundle),audit_sha256:digest(originalAudit)},run))).status,'committed');
 }finally{s.close();}
});

function queue(s,c,ts='1793491202.000001'){
 const bytes=Buffer.from(JSON.stringify(c));queueResearchControl(s.db,{source_ts:ts,command_id:c.command_id,hash:digest(bytes),bytes});return ts;
}

// Synthetic Slack envelopes around the real inbox formatter and client parser.
// These tests make no provider calls and do not reconstruct production receipts.
function nativeFixtureControl(s,inspect=()=>{}){
 let sequence=100;
 const scope={channel_id:SCOPE.channel_id,team_id:SCOPE.team_id,sender_user_id:SCOPE.sender_user_id,sender_attribution_text:SCOPE.sender_attribution_text,publisher_user_id:'UPUBLISHER',publisher_bot_id:'BPUBLISHER'};
 return async bytes=>{
  const c=JSON.parse(bytes),ts='1793491202.'+String(sequence++).padStart(6,'0');queue(s,c,ts);
  let reply;
  const error=await advanceResearchControl(s,config,{controlReceipt:async(source,text)=>{assert.equal(source,ts);reply=text;return '1793491209.000001';}},now);
  assert.equal(error,undefined);assert.equal(typeof reply,'string');
  if(['status','status_part','upload_status'].includes(c.action))assert.ok(Buffer.byteLength(reply)<=4000,`oversized read-only status: ${Buffer.byteLength(reply)}`);
  const messages=`=== THREAD PARENT MESSAGE ===\nFrom: Sender <sender@example.org> (${scope.sender_user_id})\nTime: now\nMessage TS: ${ts}\n${researchCommandText(bytes)}\n${scope.sender_attribution_text}\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Publisher <botuser-${scope.team_id}-${scope.publisher_bot_id}@slack-bots.com> (${scope.publisher_user_id})\nTime: now\nMessage TS: 1793491209.000001\n${reply}\n`;
  const invocation={tool:CONTROL_THREAD_TOOL,arguments:{channel_id:scope.channel_id,message_ts:ts,limit:100,response_format:'detailed'},result:{content:[{type:'text',text:JSON.stringify({messages,pagination_info:'There are no more messages in this thread.\n'})}]}};
  const result=verifyResearchControlReceipt(scope,bytes,ts,invocation,now);
  inspect(c,result,reply,{scope,bytes,ts,invocation});return result;
 };
}

test('native status pages retain long v4 state and freeze each original command result',async()=>{
 // Constructed size boundary, using the real inbox and unchanged native verifier.
 const s=setup();try{
  let run=start(s,layeredPlan());installPageAuthority(s.db);
  const operations=[source('https://example.org/'+('segment/'.repeat(180))),source('https://example.org/second')];
  run=execute(s,command('reserve',{operations},run)).run;
  const permit={permit_id:randomUUID(),request_id:id,report_date:DAY,prompt_commit_sha:'c'.repeat(40),publisher_scope_sha256:'d'.repeat(64),archive_sha256:'e'.repeat(64),bundle_sha256:'f'.repeat(64),audit_sha256:'a'.repeat(64)};
  s.db.prepare('UPDATE research_control_runs SET permit=? WHERE request_id=?').run(JSON.stringify(permit),id);
  const pagePermit={...permit,permit_id:randomUUID(),request_id:id.replace('-r1','-r2'),page_ids:Object.keys(PAGE_CHECKS)};
  s.db.prepare('INSERT INTO research_page_rounds VALUES(?,?,?,?,?,?,?)').run(pagePermit.request_id,id,2,'{}',JSON.stringify(pagePermit.page_ids),now,JSON.stringify(pagePermit));
  const originalOps=s.db.prepare('SELECT * FROM research_control_ops ORDER BY rowid').all();
  let changed=false,partCount=0;
  const read=nativeFixtureControl(s,(c,result,text,{scope,bytes,ts,invocation})=>{
   assert.ok(Buffer.byteLength(text)<=4000);
   if(result.status==='status_part')partCount++;
   const forged=structuredClone(invocation);forged.result.content[0].text=forged.result.content[0].text.replace('(UPUBLISHER)','(UOTHER)');
   assert.throws(()=>verifyResearchControlReceipt(scope,bytes,ts,forged,now),/Original native Publisher receipt/);
   if(c.action==='status'&&!changed){changed=true;run=execute(s,command('renew',{},run)).run;}
  });
  const next=(requestId,args)=>Buffer.from(JSON.stringify({...command('status_part',args),request_id:requestId,owner_id:null}));
  let offset=0,firstCommand;const seen=[];
  do{
   const c=command('status',{offset}),bytes=Buffer.from(JSON.stringify(c));
   firstCommand??=c;
   const result=await readCompleteResearchStatus(bytes,read,next),{source_ts,...logical}=result;
   assert.ok(source_ts);assert.deepEqual(logical,JSON.parse(s.db.prepare('SELECT result FROM research_control_commands WHERE command_id=?').get(c.command_id).result));
   assert.deepEqual(result.run.permit,permit);assert.deepEqual(JSON.parse(result.page_round.permit),pagePermit);
   assert.equal(result.plan_base64,layeredPlan().toString('base64'));assert.ok(result.effective_budget);
   if(offset===0)assert.equal(result.run.revision,run.revision-1);
   seen.push(...result.operations.map(op=>op.operation_id));offset=result.next_offset;
  }while(offset!==null);
  assert.deepEqual(seen,operations.map(op=>op.operation_id));assert.ok(partCount>=4);
  assert.deepEqual(s.db.prepare('SELECT * FROM research_control_ops ORDER BY rowid').all(),originalOps);
  // Historical oversized/unknown transport is retained, never patched or resent.
  const priorResult=s.db.prepare('SELECT result FROM research_control_commands WHERE command_id=?').get(firstCommand.command_id).result;
  const oldTs=queue(s,firstCommand,'1793491203.000001');
  s.db.prepare("UPDATE research_control_events SET phase='unknown',reply_text=? WHERE source_ts=?").run('!ai-research control-receipt '+JSON.stringify({source_ts:oldTs,...JSON.parse(priorResult)}),oldTs);
  const oldEvent=s.db.prepare('SELECT * FROM research_control_events WHERE source_ts=?').get(oldTs);
  assert.ok(Buffer.byteLength(oldEvent.reply_text)>4000);
  const replayed=await readCompleteResearchStatus(Buffer.from(JSON.stringify(firstCommand)),read,next);
  assert.equal(replayed.replayed,true);assert.equal(replayed.dispatch_granted,false);
  assert.equal(s.db.prepare('SELECT result FROM research_control_commands WHERE command_id=?').get(firstCommand.command_id).result,priorResult);
  assert.deepEqual(s.db.prepare('SELECT * FROM research_control_events WHERE source_ts=?').get(oldTs),oldEvent);
  const output=Buffer.from('new output'),checkpoint=Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id:randomUUID(),request_id:id,report_date:DAY,previous_sha256:null,files:[{path:'new.txt',sha256:digest(output),content_base64:output.toString('base64')}]}));
  const authority=nativeResearchAuthority({request_id:id,owner_id:ownerA,archive_sha256:digest(checkpoint)},bytes=>readCompleteResearchStatus(bytes,read,next),()=>now);
  await authority.validateArchive(decodeResearchArchive(checkpoint));
  assert.deepEqual(s.db.prepare('SELECT * FROM research_control_ops ORDER BY rowid').all(),originalOps);
 }finally{s.close();}
});

test('an oversized legacy ready status resumes after cooldown without changing its snapshot or unknown events',async()=>{
 for(const replayed of [false,true]){
  const s=setup();try{
   const run=start(s,layeredPlan()),op=source('https://example.org/'+('segment/'.repeat(180)));
   execute(s,command('reserve',{operations:[op]},run));
   const c=command('status',{offset:0}),original=execute(s,c),ts=queue(s,c);
   // Construct the old formatter's persisted ready state after a known-unsent cooldown.
   const oldText=source_ts=>'!ai-research control-receipt '+JSON.stringify({source_ts,...original,...(replayed?{replayed:true,dispatch_granted:false}:{})});
   assert.ok(Buffer.byteLength(oldText(ts))>4000);
   s.db.prepare("UPDATE research_control_events SET phase='ready',reply_text=?,attempts=1,next_at=?,diagnostic=? WHERE source_ts=?").run(oldText(ts),now+60000,JSON.stringify({stage:'research_control',code:'slack_cooldown',outcome:'not_started',retryable:true}),ts);
   const oldTs=queue(s,c,'1793491201.000001');
   s.db.prepare("UPDATE research_control_events SET phase='unknown',reply_text=? WHERE source_ts=?").run(oldText(oldTs),oldTs);
   const oldEvent=s.db.prepare('SELECT * FROM research_control_events WHERE source_ts=?').get(oldTs);
   const oldCommand=s.db.prepare('SELECT * FROM research_control_commands WHERE command_id=?').get(c.command_id);
   const oldRun=s.db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(id);
   const oldOps=s.db.prepare('SELECT * FROM research_control_ops ORDER BY rowid').all();
   await advanceResearchControl(s,config,{controlReceipt:()=>assert.fail('cooldown must remain enforced')},now);
   let reply;
   assert.equal(await advanceResearchControl(s,config,{controlReceipt:async(source,text)=>{assert.equal(source,ts);assert.ok(Buffer.byteLength(text)<=4000);reply=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793491262.000001';}},now+60000),undefined);
   assert.equal(reply.status,'status_part');assert.equal(reply.status_part.command_id,c.command_id);
   assert.equal(reply.status_part.sha256,digest(Buffer.from(oldCommand.result)));assert.equal(reply.status_part.offset,0);
   assert.equal(reply.replayed,replayed?true:undefined);assert.equal(reply.dispatch_granted,replayed?false:undefined);
   assert.equal(s.db.prepare('SELECT phase FROM research_control_events WHERE source_ts=?').get(ts).phase,'sent');
   assert.deepEqual(s.db.prepare('SELECT * FROM research_control_events WHERE source_ts=?').get(oldTs),oldEvent);
   assert.deepEqual(s.db.prepare('SELECT * FROM research_control_commands WHERE command_id=?').get(c.command_id),oldCommand);
   assert.deepEqual(s.db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(id),oldRun);
   assert.deepEqual(s.db.prepare('SELECT * FROM research_control_ops ORDER BY rowid').all(),oldOps);
   assert.deepEqual(pendingResearchControls(s.db),[]);
  }finally{s.close();}
 }
});

test('the actual control CLI consumes authenticated status parts before completing',async()=>{
 const s=setup(),dir=await mkdtemp(join(tmpdir(),'status-parts-cli-'));let child;
 try{
  const run=start(s,layeredPlan()),op=source('https://example.org/'+('segment/'.repeat(180)));
  execute(s,command('reserve',{operations:[op]},run));
  const scope={channel_id:SCOPE.channel_id,team_id:SCOPE.team_id,sender_user_id:SCOPE.sender_user_id,sender_attribution_text:SCOPE.sender_attribution_text,publisher_user_id:'UPUBLISHER',publisher_bot_id:'BPUBLISHER'};
  const c=command('status',{offset:0}),bytes=Buffer.from(JSON.stringify(c)),client=join(dir,'client.json'),input=join(dir,'command.json');
  await writeFile(client,JSON.stringify({scope}));await writeFile(input,bytes);
  child=spawn(process.execPath,['scripts/research-client-cli.mjs',client,input,'--control'],{stdio:['pipe','pipe','pipe']});
  const ended=new Promise(resolve=>child.once('close',resolve));let stderr='';child.stderr.on('data',data=>stderr+=data);
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});let envelope,completed,queries=0;
  const read=nativeFixtureControl(s,(command,result,text,original)=>{envelope={type:'control_result',source_ts:original.ts,invocation:original.invocation};assert.ok(['status','status_part'].includes(command.action));});
  for await(const line of lines){
   const value=JSON.parse(line);
   if(value.type==='control'){
    queries++;const commandBytes=Buffer.from(value.message.slice('!ai-research control v2 '.length),'base64');
    await read(commandBytes);child.stdin.write(JSON.stringify(envelope)+'\n');
   }else{completed=value;child.stdin.end();}
  }
  assert.equal(await ended,0,stderr);assert.equal(completed.type,'control_observed');assert.equal(completed.result.operations[0].operation_id,op.operation_id);
  assert.equal(completed.result.plan_base64,layeredPlan().toString('base64'));assert.ok(queries>1);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,1);
 }finally{child?.kill();s.close();await rm(dir,{recursive:true,force:true});}
});

test('status parts reject cross-request, non-status, changed hash and invalid offsets',()=>{
 const s=setup();try{
  const run=start(s),c=command('status',{offset:0}),observed=execute(s,c);
  const bytes=Buffer.from(s.db.prepare('SELECT result FROM research_control_commands WHERE command_id=?').get(c.command_id).result);
  const args={command_id:c.command_id,sha256:digest(bytes),offset:0};
  const part=overrides=>({...command('status_part',{...args,...overrides}),owner_id:null});
  assert.equal(execute(s,part({})).status,'status_part');
  assert.equal(execute(s,part({offset:1})).code,'status_part_fields');
  assert.equal(execute(s,part({offset:14000})).code,'status_part_binding');
  assert.equal(execute(s,part({sha256:'0'.repeat(64)})).code,'status_part_binding');
  assert.equal(execute(s,{...part({}),request_id:'morning-20261102-r1'}).code,'status_part_original');
  const mutation=command('renew',{},run);execute(s,mutation);
  assert.equal(execute(s,part({command_id:mutation.command_id})).code,'status_part_original');
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT result FROM research_control_commands WHERE command_id=?').get(c.command_id).result),observed);
 }finally{s.close();}
});

test('bounded native upload receipts stage once, recover original file and grant submit once',async()=>{
 const s=setup();try{
  const run=start(s),bytes=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40)),hash=digest(bytes),audit=Buffer.from(JSON.stringify(auditSummary()));
  const archiveHash=archive(s,{'bundle.json':bytes,'audit.json':audit});
  const permit=(await issuePermit(s,command('permit',{archive_sha256:archiveHash,bundle_sha256:hash,audit_sha256:digest(audit)},run))).run.permit;
  const counts=new Set(),control=nativeFixtureControl(s,(c,result)=>{if(c.action==='upload_status')counts.add(result.operations.length);});
  const create=()=>nativeResearchAuthority({request_id:id,owner_id:ownerA,archive_sha256:archiveHash,permit_id:permit.permit_id},control,()=>now);
  const ticket={file_id:'F'+'A'.repeat(127),upload_url:'https://files.slack.com/upload/v1/synthetic-test-only'},stageTs='1793491205.000001';let nativeCalls=0,posts=0;
  await stageFile(bytes,SCOPE.channel_id,async(tool,args)=>{
   nativeCalls++;if(tool===PRODUCER_TOOLS.ticket)return ticket;
   assert.equal(tool,PRODUCER_TOOLS.complete);assert.equal(args.file_id,ticket.file_id);
   const original=message(args.initial_comment,stageTs,ticket.file_id),slack={historyPage:async()=>({messages:[original],next_cursor:null}),exactPublish:async()=>original,download:async()=>bytes};
   const remote=async()=>({complete:true,observed_at:now,read_context:{scheduler_scope_sha256:'c'.repeat(64)},scheduler:null,scheduler_day_claim:null});
   await new PublisherInbox(s,config).scan(slack,now);assert.equal(await advanceSubmission(s,config,slack,remote,now),undefined);
   assert.equal(s.db.prepare('SELECT phase FROM slack_staged_bundles').get().phase,'staged');return {};
  },{authority:create(),upload:async()=>{posts++;return {adapter:'producer_curl_managed_proxy_v1',file_id:ticket.file_id,url_sha256:producerTicket(ticket).url_sha256,bundle_sha256:hash,metrics:{curl_exit:0,http_status:200,upload_bytes:bytes.length,num_redirects:0,ssl_verify_result:0}};}});
  assert.equal(nativeCalls,2);assert.equal(posts,1);
  const recovered=await stageFile(bytes,SCOPE.channel_id,()=>assert.fail('must not upload again'),{authority:create()});
  assert.equal(recovered.file_id,ticket.file_id);assert.equal(recovered.source_ts,stageTs);
  const submit=await create().before('submit',ticket.file_id,bytes,stageTs);
  assert.equal(s.db.prepare('SELECT phase FROM research_control_ops WHERE operation_id=?').get(submit).phase,'intent');
  await assert.rejects(create().before('submit',ticket.file_id,bytes,stageTs),/Original host upload grant required/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,4);
  assert.deepEqual([...counts].sort(),[0,1,2,3,4]);
 }finally{s.close();}
});

test('compact upload observation preserves unknown steps and exact resume input binding',async()=>{
 for(const stopped of ['post','complete']){
  const s=setup();try{
   start(s);const bytes=Buffer.from('synthetic checkpoint bytes'),hash=digest(bytes),control=nativeFixtureControl(s);
   const create=()=>nativeResearchAuthority({request_id:id,owner_id:ownerA,archive_sha256:hash},control,()=>now);
   const authority=create();await authority.before('ticket',null,bytes);await authority.after('ticket','FORIGINAL',bytes);
   const post=await authority.before('post','FORIGINAL',bytes);
   let op=post;
   if(stopped==='complete'){await authority.after('post','FORIGINAL',bytes);op=await authority.before('complete','FORIGINAL',bytes);}
   const live=execute(s,command('status',{offset:0})).run;execute(s,command('settle',unknown(op),live));
   const before=s.db.prepare('SELECT * FROM research_control_ops ORDER BY rowid').all();
   await assert.rejects(create().recover(bytes),/requires reconciliation/);
   await assert.rejects(create().before(stopped,'FORIGINAL',bytes),/requires reconciliation/);
   await assert.rejects(create().recover(Buffer.from('different original bytes')),/Original upload bytes differ/);
   assert.deepEqual(s.db.prepare('SELECT * FROM research_control_ops ORDER BY rowid').all(),before);
  }finally{s.close();}
 }
});

test('upload wire bound covers constructed maximum fields, all four steps and page permits',async()=>{
 // Boundary fixture, not a reproduction of a live four-step publication.
 for(const kind of ['archive','report','page']){
  const s=setup();try{
   start(s);installPageAuthority(s.db);
   const archiveHash='a'.repeat(64),bundleHash='b'.repeat(64),permit={permit_id:randomUUID(),request_id:id,report_date:DAY,prompt_commit_sha:'c'.repeat(40),publisher_scope_sha256:'d'.repeat(64),archive_sha256:archiveHash,bundle_sha256:bundleHash,audit_sha256:'e'.repeat(64)};
   s.db.prepare('UPDATE research_control_runs SET permit=?,epoch=1000000,revision=10000000,lease_until=?').run(JSON.stringify(permit),Number.MAX_SAFE_INTEGER);
   if(kind==='page'){
    permit.permit_id=randomUUID();permit.request_id=id.replace('-r1','-r9007199254740991');permit.page_ids=Object.keys(PAGE_CHECKS);
    s.db.prepare('INSERT INTO research_page_rounds VALUES(?,?,?,?,?,?,?)').run(permit.request_id,id,Number.MAX_SAFE_INTEGER,'{}',JSON.stringify(permit.page_ids),now,JSON.stringify(permit));
   }
   const steps=kind==='archive'?['ticket','post','complete']:['ticket','post','complete','submit'],permitId=kind==='archive'?null:permit.permit_id,hash=kind==='archive'?archiveHash:bundleHash;
   for(const step of steps){
    const key=(permitId?'permit:'+permitId:'archive:'+archiveHash)+':'+step,input={archive_sha256:archiveHash,permit_id:permitId,step,file_id:step==='ticket'?null:'F'.repeat(128),source_ts:step==='submit'?'1793491205.000001':null,bytes:16*1024*1024,sha256:hash};
    const result={file_id:'F'.repeat(128),source_ts:['complete','submit'].includes(step)?'1793491205.000001':null,sha256:hash,bytes:input.bytes};
    s.db.prepare('INSERT INTO research_control_ops VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,'native',key,digest(Buffer.from(JSON.stringify(input))),JSON.stringify(input),ownerA,1000000,0,'acknowledged',null,null,null,JSON.stringify(result));
   }
   let size=0;const control=nativeFixtureControl(s,(c,r,text)=>{size=Buffer.byteLength(text);assert.equal(r.run.permit,undefined);assert.equal(r.permit?.permit_id??null,permitId);assert.equal(r.operations.length,steps.length);});
   const original=s.db.prepare('SELECT * FROM research_control_ops ORDER BY rowid').all();
   await control(Buffer.from(JSON.stringify({...command('upload_status',{archive_sha256:archiveHash,permit_id:permitId}),owner_id:null})));
   assert.ok(size<=4000);assert.deepEqual(s.db.prepare('SELECT * FROM research_control_ops ORDER BY rowid').all(),original);
  }finally{s.close();}
 }
});

test('old oversized observations remain immutable; fresh command authenticates and split replies stay rejected',async()=>{
 const s=setup();try{
  start(s);const args={archive_sha256:'a'.repeat(64),permit_id:null},old={...command('upload_status',args),owner_id:null},bytes=Buffer.from(JSON.stringify(old));
  const oldResult=JSON.stringify({command_id:old.command_id,command_sha256:digest(bytes),request_id:id,status:'observed',padding:'x'.repeat(4400)});
  s.db.prepare('INSERT INTO research_control_commands VALUES(?,?,?,?,?)').run(old.command_id,id,digest(bytes),bytes,oldResult);
  queue(s,old,'1793491202.000001');const oldReply='!ai-research control-receipt '+JSON.stringify({source_ts:'1793491202.000001',...JSON.parse(oldResult)});
  s.db.prepare("UPDATE research_control_events SET phase='unknown',reply_text=? WHERE command_id=?").run(oldReply,old.command_id);
  const saved=s.db.prepare('SELECT * FROM research_control_events').get();
  await nativeFixtureControl(s,(c,r,text,{scope,bytes,ts,invocation})=>{
   assert.equal(r.status,'observed');assert.equal(r.dispatch_granted,undefined);
   const split=structuredClone(invocation);split.result.content[0].text=split.result.content[0].text.replace('THREAD REPLIES (1 total)','THREAD REPLIES (2 total)');
   assert.throws(()=>verifyResearchControlReceipt(scope,bytes,ts,split,now),/Original native Publisher receipt/);
  })(Buffer.from(JSON.stringify({...command('upload_status',args),owner_id:null})));
  assert.equal(s.db.prepare('SELECT result FROM research_control_commands WHERE command_id=?').get(old.command_id).result,oldResult);
  assert.deepEqual(s.db.prepare('SELECT * FROM research_control_events WHERE command_id=?').get(old.command_id),saved);
  // Even a separately queued replay must not send the old oversized bytes.
  queue(s,old,'1793491203.000001');await advanceResearchControl(s,config,{controlReceipt:()=>assert.fail('oversized replay must not send')},now);
  assert.equal(s.db.prepare('SELECT phase FROM research_control_events WHERE source_ts=?').get('1793491203.000001').phase,'pending');
  assert.equal(s.db.prepare('SELECT result FROM research_control_commands WHERE command_id=?').get(old.command_id).result,oldResult);
 }finally{s.close();}
});
test('source attempts cannot change identity through a forged key or reordered query',()=>{
 const s=setup();try{
  let run=start(s);const op=source('https://example.org/data?b=2&a=1');
  assert.equal(execute(s,command('reserve',{operations:[{...op,key:'f'.repeat(64)}]},run)).code,'source_identity_hash');
  run=execute(s,command('reserve',{operations:[op]},run)).run;
  run=execute(s,command('reserve',{operations:[source('https://example.org/data?a=1&b=2')]},run)).run;
  assert.equal(execute(s,command('reserve',{operations:[source('https://example.org/data?b=2&a=1')]},run)).code,'attempt_budget');
 }finally{s.close();}
});
test('control mutation and ready receipt commit together, including an injected crash before commit',async()=>{
 const s=setup();try{
  const run=start(s),op=source(),c=command('reserve',{operations:[op]},run),ts=queue(s,c);
  assert.throws(()=>executeResearchControl(s.db,config,Buffer.from(JSON.stringify(c)),now,{onResult:()=>{throw Error('synthetic crash before receipt');}}),/synthetic crash/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,0);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_commands WHERE command_id=?').get(c.command_id).n,0);
  assert.equal(s.db.prepare('SELECT phase FROM research_control_events').get().phase,'pending');
  let reply;await advanceResearchControl(s,config,{controlReceipt:async(thread,text)=>{assert.equal(thread,ts);reply=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793491209.000001';}},now);
  assert.equal(reply.dispatch_granted,true);assert.equal(s.db.prepare('SELECT phase FROM research_control_events').get().phase,'sent');
 }finally{s.close();}
});
test('unknown or interrupted control reply never grants again; a fresh receipt observes the consumed intent',async()=>{
 for(const interrupted of [false,true]){
  const s=setup();try{
   const run=start(s),op=source(),c=command('reserve',{operations:[op]},run);queue(s,c);let calls=0;
   await advanceResearchControl(s,config,{controlReceipt:async()=>{calls++;throw Error('synthetic unknown');}},now);
   if(interrupted)s.db.prepare("UPDATE research_control_events SET phase='sending'").run();
   assert.equal(pendingResearchControls(s.db).length,1);
   await advanceResearchControl(s,config,{controlReceipt:async()=>assert.fail('must not replay')},now+600000);
   const observed=execute(s,command('receipt',{command_id:c.command_id}));assert.equal(observed.original_result.dispatch_granted,false);assert.equal(calls,1);
   assert.equal(execute(s,command('resume',{operation_id:op.operation_id},observed.original_result.run)).code,'resume_dispatch_not_proven_unstarted');
   execute(s,command('settle',unknown(op.operation_id),observed.original_result.run));assert.equal(pendingResearchControls(s.db).length,0);
  }finally{s.close();}
 }
});
test('an unusable immutable input path is rejected before the day is claimed',()=>{
 const s=setup();try{
  for(const path of ['.config/prompt.md','a'.repeat(201),'dir/../prompt.md']){
   const p={...JSON.parse(plan),files:{[path]:digest(input)}};
   const result=execute(s,command('claim',{plan_base64:Buffer.from(JSON.stringify(p)).toString('base64')}));assert.equal(result.code,'plan_files');assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_runs').get().n,0);
  }
 }finally{s.close();}
});
test('retired and premature envelopes create no upload work and cannot stop history scanning',async()=>{
 const {research_control,...legacy}=config,s=new HandoffState(':memory:',handoffScope(legacy));try{
  installFence(s.db,fence,'synthetic',[]);installSubmission(s.db,legacy,'synthetic');installResearchArchive(s.db,legacy,'synthetic');
  const messages=[message(`!ai-report stage-v2 ${id} ${'a'.repeat(64)} ${randomUUID()}`,'1793491202.000001','FFUTURE'),message(`!ai-report stage ${id} ${'b'.repeat(64)}`,'1793491203.000001','FORIGINAL')];
  await new PublisherInbox(s,legacy).scan({historyPage:async()=>({messages,next_cursor:null})},now);
  assert.equal(s.db.prepare('SELECT count(*) n FROM slack_submission_events').get().n,0);
  assert.equal(s.db.prepare('SELECT upper_bound FROM publisher_intake_scan').get().upper_bound,null);
 }finally{s.close();}
});
test('a malformed bundle cannot consume the immutable permit before a corrected original is reviewed',async()=>{
 const s=setup();try{
  const run=start(s),bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40)),data=JSON.parse(bundle),empty=Buffer.from(JSON.stringify({...data,files:[]})),audit=Buffer.from(JSON.stringify(auditSummary()));
  const badHash=archive(s,{'bundle.json':empty,'audit.json':audit}),bad=command('permit',{archive_sha256:badHash,bundle_sha256:digest(empty),audit_sha256:digest(audit)},run);queue(s,bad);
  let reply;await advanceResearchControl(s,config,{controlReceipt:async(_ts,text)=>{reply=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793491209.000001';}},now);
  assert.equal(reply.code,'publication_bundle_invalid');assert.equal(reply.run.permit,null);assert.equal(execute(s,command('receipt',{command_id:bad.command_id})).original_result.code,'publication_bundle_invalid');
  const goodHash=archive(s,{'bundle.json':bundle,'audit.json':audit});assert.equal((await issuePermit(s,command('permit',{archive_sha256:goodHash,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},run))).status,'committed');
 }finally{s.close();}
});
test('a withheld grant can resume once after takeover without resetting attempts, including an expired observation',async()=>{
 for(const expiredReply of [false,true]){
  const s=setup();try{
   let run=start(s);const op=source(),c=command('reserve',{operations:[op]},run),ts=queue(s,c);
   await advanceResearchControl(s,config,{assertReady:()=>{throw Error('synthetic local cooldown');},controlReceipt:()=>assert.fail()},now);
   assert.equal(s.db.prepare('SELECT phase FROM research_control_events').get().phase,'ready');
   const clock=now+16*60000;
   if(expiredReply)await advanceResearchControl(s,config,{controlReceipt:async(_ts,text)=>{assert.equal(JSON.parse(text.slice('!ai-research control-receipt '.length)).dispatch_granted,false);return '1793492161.000001';}},clock);
   run=execute(s,command('status',{offset:0}),clock).run;
   run=execute(s,command('claim',{plan_base64:plan.toString('base64')},run,ownerB),clock).run;
   const resume=command('resume',{operation_id:op.operation_id},run,ownerB);queue(s,resume,'1793492162.000001');let reply;
   // The earlier ready event is selected first only if not yet expired; let it
   // publish the explicit expired observation before handling the new command.
   if(!expiredReply)await advanceResearchControl(s,config,{controlReceipt:async()=> '1793492163.000001'},clock);
   await advanceResearchControl(s,config,{controlReceipt:async(_ts,text)=>{reply=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793492164.000001';}},clock);
   assert.equal(reply.dispatch_granted,true);assert.equal(reply.run.owner_id,ownerB);assert.equal(reply.run.charged_seconds,180);
   assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,1);
   assert.equal(execute(s,command('resume',{operation_id:op.operation_id},reply.run,ownerB),clock).code,'resume_dispatch_not_proven_unstarted');
   assert.notEqual(s.db.prepare('SELECT phase FROM research_control_events WHERE source_ts=?').get(ts).phase,'ready');
   const observation=Buffer.from(JSON.stringify({artifact_kind:'local_dispatch_observation_not_settlement',request_id:id,status:'not_dispatched_grant_expired',dispatch_started:false,source_requests:0,operation_ids:[op.operation_id],command_id:resume.command_id,receipt_ts:'1793492164.000001',observed_at:new Date(clock+70000).toISOString()}));
   const result=Buffer.from(JSON.stringify({schema_version:'source_not_dispatched_v1',request_id:id,operation_id:op.operation_id,url:op.input.url,input_sha256:op.input_sha256,status:'not_dispatched',dispatch_started:false,source_requests:0,elapsed_seconds:null,reserved_seconds:op.max_seconds,observation_sha256:digest(observation),grant_command_id:resume.command_id,grant_receipt_ts:'1793492164.000001'}));
   const hash=archive(s,{'observation.json':observation,'result.json':result});
   const settled=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:hash,file_sha256:digest(result),native_result:null},reply.run,ownerB),clock+70000);
   assert.equal(settled.status,'committed');assert.equal(settled.run.charged_seconds,180);

  }finally{s.close();}
 }
});
test('renewal cannot send a withheld grant whose embedded lease has expired',async()=>{
 const s=setup();try{
  const run=start(s),op=source(),c=command('reserve',{operations:[op]},run);queue(s,c);
  await advanceResearchControl(s,config,{assertReady:()=>{throw Error('synthetic local cooldown');}},now);
  const original=execute(s,command('status',{offset:0})).run;
  const renewed=execute(s,command('renew',{},original),now+14*60000).run,clock=now+16*60000;
  assert.ok(original.lease_until<clock&&renewed.lease_until>clock);
  let expired;await advanceResearchControl(s,config,{controlReceipt:async(_ts,text)=>{expired=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793492171.000001';}},clock);
  assert.equal(expired.dispatch_granted,false);assert.equal(expired.grant_expired,true);
  queue(s,command('resume',{operation_id:op.operation_id},renewed),'1793492172.000001');
  let resumed;await advanceResearchControl(s,config,{controlReceipt:async(_ts,text)=>{resumed=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793492173.000001';}},clock);
  assert.equal(resumed.dispatch_granted,true);assert.equal(resumed.operations[0].operation_id,op.operation_id);assert.ok(resumed.run.lease_until>clock);
  assert.equal(resumed.run.charged_seconds,180);assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,1);
 }finally{s.close();}
});
test('submission-only CLI reaches native authorization without an upload proxy',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'research-submit-')),file=join(dir,'bundle.json'),configFile=join(dir,'client.json');
 const scope={channel_id:SCOPE.channel_id,team_id:SCOPE.team_id,sender_user_id:SCOPE.sender_user_id,sender_attribution_text:SCOPE.sender_attribution_text,publisher_user_id:'UPUBLISHER',publisher_bot_id:'BPUBLISHER'};
 const bytes=Buffer.from('original staged bytes'),upload={request_id:id,owner_id:ownerA,permit_id:randomUUID(),archive_sha256:digest(bytes)},env={...process.env};
 for(const key of Object.keys(env))if(key.toLowerCase()==='https_proxy')delete env[key];
 try{
  await writeFile(file,bytes);
  for(const mode of ['--submit','--stage','--archive']){
   await writeFile(configFile,JSON.stringify({scope,upload,...(mode==='--submit'?{stage:{file_id:'FORIGINAL',source_ts:'1793491202.000001'}}:{})}));
   // EOF deliberately stops before a native result. No provider call is made.
   const child=spawnSync(process.execPath,['scripts/research-client-cli.mjs',configFile,file,mode],{env,input:'',encoding:'utf8',timeout:5000});
   assert.equal(child.error,undefined);assert.equal(child.status,1,child.stderr);
   const output=child.stdout.trim().split('\n').map(line=>JSON.parse(line));
   assert.equal(output[0].type,mode==='--submit'?'control':'research_client_unconfirmed');
   if(mode==='--submit')assert.equal(JSON.parse(Buffer.from(output[0].message.slice('!ai-research control v2 '.length),'base64')).action,'upload_status');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('real elapsed overruns remain recorded and consume the additional time',()=>{
 const s=setup();try{
  let run=start(s);const op=source();run=execute(s,command('reserve',{operations:[op]},run)).run;
  const bytes=Buffer.from('original slow request result'),hash=archive(s,{'source.json':bytes});
  const result=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:181,archive_sha256:hash,file_sha256:digest(bytes),native_result:null},run));
  assert.equal(result.status,'committed');assert.equal(result.run.charged_seconds,181);
 }finally{s.close();}
});
test('a resumed executor can settle original results after another takeover without reclaiming ownership',async()=>{
 const s=setup();try{
  let run=start(s);const op=source();queue(s,command('reserve',{operations:[op]},run));
  await advanceResearchControl(s,config,{assertReady:()=>{throw Error('synthetic local cooldown');}},now);
  run=execute(s,command('status',{offset:0})).run;
  run=execute(s,command('claim',{plan_base64:plan.toString('base64')},run,ownerB),now+16*60000).run;
  const resumed=execute(s,command('resume',{operation_id:op.operation_id},run,ownerB),now+16*60000);assert.equal(resumed.dispatch_granted,true);
  const ownerC=randomUUID();run=execute(s,command('claim',{plan_base64:plan.toString('base64')},resumed.run,ownerC),now+32*60000).run;
  const bytes=Buffer.from('original resumed request result'),hash=archive(s,{'resumed-source.json':bytes});
  const late=command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:20,archive_sha256:hash,file_sha256:digest(bytes),native_result:null},run,ownerB);late.epoch=2;
  assert.equal(execute(s,{...late,command_id:randomUUID(),owner_id:randomUUID()},now+32*60000).code,'owner_fenced');
  const settled=execute(s,late,now+32*60000);assert.equal(settled.status,'committed');assert.equal(settled.run.owner_id,ownerC);assert.equal(settled.run.epoch,3);assert.equal(settled.run.lease_until,run.lease_until);assert.equal(settled.run.charged_seconds,20);
 }finally{s.close();}
});
test('CD preserves the authority schema and unknown command history without recreating it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'authority-cd-')),file=join(dir,'host.sqlite'),s=setup(file),python=process.platform==='win32'?'python':'python3';
 const snapshot=()=>spawnSync(python,['-B','-c',`from pathlib import Path;from deployment.publisher_cd import snapshot;print(snapshot(Path(${JSON.stringify(file)})))`],{encoding:'utf8'});
 try{
  new PublisherInbox(s,config);const before=snapshot();assert.equal(before.status,0,before.stderr);
  const run=start(s);queue(s,command('reserve',{operations:[source()]},run));await advanceResearchControl(s,config,{controlReceipt:async()=>{throw Error('unknown');}},now);
  const after=snapshot();assert.equal(after.status,0,after.stderr);assert.notEqual(before.stdout,after.stdout);
  const schema=spawnSync(python,['-B','-c','import json;from deployment.publisher_cd import RESEARCH_CONTROL_SCHEMA;print(json.dumps(RESEARCH_CONTROL_SCHEMA))'],{encoding:'utf8'});
  assert.equal(schema.status,0,schema.stderr);assert.deepEqual(JSON.parse(schema.stdout),RESEARCH_CONTROL_SCHEMA);
  s.db.exec('CREATE INDEX unexpected_authority_index ON research_control_runs(owner_id)');assert.notEqual(snapshot().status,0);
 }finally{s.close();await rm(dir,{recursive:true,force:true});}
});
test('replayed reservation never grants dispatch; rejected batches roll back operations and charge together',()=>{
 const s=setup();try{
  let run=start(s);const first=source(),c=command('reserve',{operations:[first]},run),reserved=execute(s,c);run=reserved.run;
  assert.equal(execute(s,c).dispatch_granted,false);assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,1);
  const failed=execute(s,command('reserve',{operations:[source(),source()]},run));assert.equal(failed.code,'attempt_budget');assert.equal(failed.run.charged_seconds,180);assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,1);
  assert.throws(()=>execute(s,{...c,args:{operations:[source()]}}),/command_identity_conflict/);
  const observation=execute(s,command('receipt',{command_id:c.command_id}));assert.equal(observation.original_result.dispatch_granted,false);
 }finally{s.close();}
});
test('unknown model attempt remains consumed and late original evidence cannot reclaim ownership',()=>{
 const s=setup();try{
  let run=start(s);const op=source('editor','model');run=execute(s,command('reserve',{operations:[op]},run)).run;
  run=execute(s,command('settle',unknown(op.operation_id),run)).run;
  assert.equal(execute(s,command('reserve',{operations:[source('editor','model')]},run)).code,'attempt_budget');
  const result=Buffer.from('original model output'),hash=archive(s,{'editor.json':result}),clock=now+16*60000;
  run=execute(s,command('claim',{plan_base64:plan.toString('base64')},run,ownerB),clock).run;const lease=run.lease_until;
  const late=command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:40,archive_sha256:hash,file_sha256:digest(result),native_result:null},run,ownerA);late.epoch=1;
  const settled=execute(s,late,clock);assert.equal(settled.status,'committed');assert.equal(settled.run.owner_id,ownerB);assert.equal(settled.run.epoch,2);assert.equal(settled.run.lease_until,lease);assert.equal(settled.run.charged_seconds,40);
  assert.equal(execute(s,command('reserve',{operations:[source('editor','model')]},settled.run,ownerB),clock).code,'attempt_budget');
 }finally{s.close();}
});
test('native intent and safe ticket result require no recursive archive upload and retain the original file',()=>{
 const s=setup();try{
  let run=execute(s,command('claim',{plan_base64:plan.toString('base64')})).run;
  const hash='e'.repeat(64),input={archive_sha256:hash,permit_id:null,step:'ticket',file_id:null,source_ts:null,bytes:12000,sha256:hash};
  const op={operation_id:randomUUID(),kind:'native',key:'archive:'+hash+':ticket',input_sha256:digest(Buffer.from(JSON.stringify(input))),input,max_seconds:0};
  run=execute(s,command('reserve',{operations:[op]},run)).run;
  assert.equal(execute(s,command('reserve',{operations:[{...op,operation_id:randomUUID()}]},run)).code,'native_intent_exists');
  run=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:null,file_sha256:null,native_result:{file_id:'FORIGINAL',source_ts:null,sha256:hash,bytes:12000}},run)).run;
  const postInput={...input,step:'post',file_id:'FCHANGED'},post={...op,operation_id:randomUUID(),key:'archive:'+hash+':post',input:postInput,input_sha256:digest(Buffer.from(JSON.stringify(postInput)))};
  assert.equal(execute(s,command('reserve',{operations:[post]},run)).code,'native_original_file');
  post.input.file_id='FORIGINAL';post.input_sha256=digest(Buffer.from(JSON.stringify(post.input)));
  assert.equal(execute(s,command('reserve',{operations:[post]},run)).dispatch_granted,true);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);
 }finally{s.close();}
});
test('repository input run recovers without an input archive and preserves unknown budget and result checkpoints',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'repository-authority-')),path=join(dir,'original.sqlite');let s=setup(path);try{
  let run=start(s,repositoryPlan);assert.equal(run.inputs_hash,repositoryResearchInputsHash(JSON.parse(repositoryPlan)));assert.equal(run.checkpoint_hash,null);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);
  assert.equal(execute(s,command('inputs',{archive_sha256:'f'.repeat(64)},run)).code,'repository_inputs_fields');
  const op=source();run=execute(s,command('reserve',{operations:[op]},run)).run;
  run=execute(s,command('settle',unknown(op.operation_id),run)).run;s.close();
  s=new HandoffState(path,handoffScope(config));assertResearchControl(s.db,config);
  const found=execute(s,command('status',{offset:0}));assert.deepEqual(Buffer.from(found.plan_base64,'base64'),repositoryPlan);
  assert.deepEqual(await readRepositoryResearchInputs(JSON.parse(Buffer.from(found.plan_base64,'base64')),async ref=>Buffer.from(repositoryFiles.get(ref.path))),repositoryFiles);
  assert.equal(found.operations[0].phase,'unknown');assert.equal(found.run.charged_seconds,180);
  const clock=now+16*60000;run=execute(s,command('claim',{plan_base64:found.plan_base64},found.run,ownerB),clock).run;
  assert.equal(run.epoch,2);assert.equal(run.started_at,now);assert.equal(run.charged_seconds,180);
  assert.equal(execute(s,command('inputs',{},run,ownerA),clock).code,'owner_fenced');
  const result=Buffer.from('new source response'),hash=archive(s,{'results/source.txt':result});
  run=execute(s,command('checkpoint',{archive_sha256:hash},run,ownerB),clock).run;
  run=execute(s,command('inputs',{},run,ownerB),clock).run;assert.equal(run.checkpoint_hash,hash);assert.equal(run.charged_seconds,180);
  const retry=source();run=execute(s,command('reserve',{operations:[retry]},run,ownerB),clock).run;
  run=execute(s,command('settle',{operation_id:retry.operation_id,outcome:'acknowledged',elapsed_seconds:12,archive_sha256:hash,file_sha256:digest(result),native_result:null},run,ownerB),clock).run;
  assert.equal(run.charged_seconds,192);assert.equal(execute(s,command('reserve',{operations:[source()]},run,ownerB),clock).code,'attempt_budget');
  const changed={...JSON.parse(repositoryPlan),reports_commit_sha:'c'.repeat(40)};
  assert.equal(execute(s,command('claim',{plan_base64:Buffer.from(JSON.stringify(changed)).toString('base64')},run,ownerB),clock).code,'immutable_plan');
 }finally{s.close();await rm(dir,{recursive:true,force:true});}
});

test('repository plans fit the control wire and reject missing inputs and copied fixed files before storage',()=>{
 const s=setup();try{
  const claim=command('claim',{plan_base64:repositoryPlan.toString('base64')});assert.ok(researchCommandText(Buffer.from(JSON.stringify(claim))).length<=5000);
  const missing=JSON.parse(repositoryPlan);delete missing.files['reports/index.json'];
  assert.equal(execute(s,command('claim',{plan_base64:Buffer.from(JSON.stringify(missing)).toString('base64')})).code,'plan_repository_inputs');
  start(s,repositoryPlan);
  for(const files of [{'reports/index.json':Buffer.from('replacement')},{'renamed.txt':repositoryFiles.get('reports/index.json')}])assert.throws(()=>archive(s,files),e=>e.researchRejection?.code==='repository_inputs_must_be_references');
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM research_archive_heads').get().n,0);
 }finally{s.close();}
});

test('input CLI rebuilds a deleted disposable cache from the original plan without any local journal',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'repository-input-cli-')),cache=join(dir,'cache'),preload=join(dir,'fetch-fixture.mjs');try{
  await writeFile(preload,`import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';import{promisify}from'node:util';const fake=()=>{throw Error('unexpected callback')};fake[promisify.custom]=async(exe,args)=>({stdout:Buffer.from('original repository file: '+new URL(args.at(-1)).pathname.split('/').slice(4).join('/')+'\\r\\n')});cp.execFile=fake;syncBuiltinESMExports();`);
  const run=()=>spawnSync(process.execPath,['--import',pathToFileURL(preload).href,'scripts/research-inputs-cli.mjs',cache],{input:repositoryPlan,encoding:'utf8',timeout:5000,env:{...process.env,https_proxy:'http://managed.invalid:3128',HTTPS_PROXY:'http://managed.invalid:3128'}});
  for(let attempt=0;attempt<2;attempt++){
   const child=run();assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).persistent_cloud_state_required,false);
   for(const [name,bytes] of repositoryFiles)assert.deepEqual(await readFile(join(cache,repositoryInputCachePath(name))),bytes);
   assert.equal(run().status,process.platform==='win32'?1:0,'Windows keeps one-shot behavior; POSIX reuses verified cache');
   await writeFile(join(cache,'prompts/audit.md'),'tampered');assert.equal(run().status,1,'changed cached bytes fail closed');
   await rm(cache,{recursive:true});
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('CD rejects an old runtime before opening a host ledger with repository inputs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'repository-input-cd-')),s=setup(join(dir,'handoff.sqlite'));try{
  new PublisherInbox(s,config);assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_runs').get().n,0);s.close();
  const scripts=join(dir,'scripts');await mkdir(scripts);
  await writeFile(join(scripts,'handoff-state.mjs'),"export class HandoffState{constructor(){throw Error('state_opened')}};export const handoffScope=x=>x;");
  await writeFile(join(scripts,'notice-outbox.mjs'),"export class NoticeOutbox{};export const notificationScope=x=>x;");
  await writeFile(join(scripts,'run-handoff.mjs'),"export function validateConfig(){throw Error('config_opened')}");
  await writeFile(join(scripts,'research-control.mjs'),'export const OLD_RUNTIME=true;');
  await writeFile(join(dir,'publisher.json'),'{}');await mkdir(join(dir,'operation'));
  const code=`import os,subprocess\nfrom pathlib import Path\nfrom unittest.mock import patch\nfrom deployment import publisher_cd as cd\nroot=Path(${JSON.stringify(dir)})\nconfig={'state':str(root),'publisher_config':str(root/'publisher.json'),'uid':996,'gid':996}\nbefore=cd.snapshot(root/'handoff.sqlite')\ndef probe(config,release,args,**kwargs):\n result=subprocess.run([${JSON.stringify(process.execPath)},'--input-type=module','-e',args[-1]],cwd=release,capture_output=True,text=True)\n assert result.returncode!=0 and 'repository_inputs_require_compatible_release' in result.stderr,result.stderr\n assert 'state_opened' not in result.stderr and 'config_opened' not in result.stderr,result.stderr\n raise ValueError('expected_old_reader_rejection')\nwith patch.object(cd,'container',side_effect=probe),patch.object(cd,'legacy_dependency_mount',return_value=[]),patch.object(os,'chown',create=True):\n try: cd.compatibility(config,root,root/'operation',before)\n except ValueError as error: assert str(error)=='expected_old_reader_rejection',str(error)\n else: raise AssertionError('old runtime accepted')\nassert cd.snapshot(root/'handoff.sqlite')==before\n`;
  const child=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c',code],{encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);
 }finally{if(s.db.isOpen)s.close();await rm(dir,{recursive:true,force:true});}
});

test('CD probes original and migrated authority bindings without changing rows and rejects mixed configurations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'authority-policy-cd-'));
 const complete={...config,producer_app_id:11,merger_app_id:22,ready_for_review:false,slack_token_file:join(dir,'token'),producer_key_file:join(dir,'key'),state_dir:dir},s=setup(join(dir,'handoff.sqlite'),complete);
 try{
  new PublisherInbox(s,complete);const previous=originalPolicy(s,complete);
  await mkdir(join(dir,'operation'));
  const probe=async(c,expected,migrated,failure="Original research authority binding required")=>{
   await writeFile(join(dir,'publisher.json'),JSON.stringify(c));
   const code=`import os,subprocess,json\nfrom pathlib import Path\nfrom unittest.mock import patch\nfrom contextlib import closing\nimport sqlite3\nfrom deployment import publisher_cd as cd\nroot=Path(${JSON.stringify(dir)})\nconfig={'state':str(root),'publisher_config':str(root/'publisher.json'),'uid':996,'gid':996}\nbefore=cd.snapshot(root/'handoff.sqlite')\nwith closing(sqlite3.connect(root/'handoff.sqlite')) as db: assert cd.repository_inputs_runtime_required(db)==${migrated?'True':'False'}\ndef container(config,release,args,**kwargs):\n mount=next(x for x in kwargs['extra'] if x.endswith(',dst=/probe'))\n directory=Path(mount.split('src=',1)[1].rsplit(',dst=',1)[0])\n script=args[-1].replace("'/probe/publisher.json'",json.dumps(str(directory/'publisher.json'))).replace("'/probe/handoff.sqlite'",json.dumps(str(directory/'handoff.sqlite')))\n result=subprocess.run([${JSON.stringify(process.execPath)},'--input-type=module','-e',script],cwd=release,capture_output=True,text=True)\n if result.returncode: raise RuntimeError(result.stderr)\nwith patch.object(cd,'container',side_effect=container),patch.object(cd,'legacy_dependency_mount',return_value=[]),patch.object(os,'chown',create=True):\n try: cd.compatibility(config,Path.cwd(),root/'operation',before)\n except RuntimeError as error:\n  assert ${expected?'False':'True'} and ${JSON.stringify(failure)} in str(error),str(error)\n else: assert ${expected?'True':'False'},'mixed authority binding accepted'\nassert cd.snapshot(root/'handoff.sqlite')==before\n`;
   const child=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c',code],{encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);
  };
  await probe(previous,true,false);await probe(complete,false,false);
  migrateResearchControl(s.db,complete,'constructed CD transition');
  await probe(previous,false,true);await probe(complete,true,true);
  await probe({...complete,research_archive:undefined,research_control:undefined},false,true,"Live Publisher requires the original host research entry");
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_runs').get().n,0);
 }finally{s.close();await rm(dir,{recursive:true,force:true});}
});

test('reopened original host ledger recovers plan and operations after disposable client state is lost',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'research-authority-')),path=join(dir,'original.sqlite');let s=setup(path);try{
  const run=start(s),op=source();execute(s,command('reserve',{operations:[op]},run));s.close();
  s=new HandoffState(path,handoffScope(config));assertResearchControl(s.db,config);
  const found=execute(s,command('status',{offset:0}));assert.equal(found.status,'observed');assert.deepEqual(Buffer.from(found.plan_base64,'base64'),plan);assert.equal(found.run.charged_seconds,180);assert.equal(found.operations[0].operation_id,op.operation_id);assert.equal(found.operations[0].phase,'intent');
 }finally{s.close();await rm(dir,{recursive:true,force:true});}
});
test('r1 publication base advances independently through permit stage submit and exact-main proposal',async()=>{
 const inputPlan=plan,files=new Map(FILES);
 const reportPath=[...files.keys()].find(p=>p.endsWith('/report.json')),report=JSON.parse(files.get(reportPath));
 // This isolated empty publication repository has no historical update targets.
 for(const entry of report.entries)entry.update_of=null;
 files.set(reportPath,Buffer.from(JSON.stringify(report)));
 const s=setup();try{
  let run=start(s,inputPlan);const api=new FakeGitHub(),publicationBase=api.base;
  assert.notEqual(publicationBase,JSON.parse(inputPlan).reports_commit_sha);
  const originalRun={plan_hash:run.plan_hash,inputs_hash:run.inputs_hash,started_at:run.started_at,charged_seconds:run.charged_seconds};
  const bytes=await encodeBundle(files,id,publicationBase,'a'.repeat(40)),hash=digest(bytes),audit=Buffer.from(JSON.stringify(auditSummary({readiness:'partial'},files)));
  const checkpoint=archive(s,{'bundle.json':bytes,'audit.json':audit});run=(await issuePermit(s,command('permit',{archive_sha256:checkpoint,bundle_sha256:hash,audit_sha256:digest(audit)},run))).run;
  assert.ok(run.permit);const permit=run.permit.permit_id;let completeOp;
  assert.deepEqual(Object.fromEntries(Object.keys(originalRun).map(k=>[k,run[k]])),originalRun);
  assert.deepEqual(Buffer.from(execute(s,command('status',{offset:0})).plan_base64,'base64'),inputPlan);
  const replacement=await encodeBundle(files,id,'c'.repeat(40),'a'.repeat(40));
  const replacementArchive=archive(s,{'bundle.json':replacement,'audit.json':audit});
  const refused=await issuePermit(s,command('permit',{archive_sha256:replacementArchive,bundle_sha256:digest(replacement),audit_sha256:digest(audit)},run));
  assert.equal(refused.code,'immutable_publication_permit');
  assert.equal(execute(s,command('status',{offset:0})).run.permit.bundle_sha256,hash);
  for(const step of ['ticket','post','complete']){
   const input={archive_sha256:checkpoint,permit_id:permit,step,file_id:step==='ticket'?null:'FORIGINAL',source_ts:null,bytes:bytes.length,sha256:hash};
   const op={operation_id:randomUUID(),kind:'native',key:'permit:'+permit+':'+step,input_sha256:digest(Buffer.from(JSON.stringify(input))),input,max_seconds:0};
   const reserved=execute(s,command('reserve',{operations:[op]},run));assert.equal(reserved.dispatch_granted,true);run=reserved.run;
   if(step==='complete'){completeOp=op;break;}
   run=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:null,file_sha256:null,native_result:{file_id:'FORIGINAL',source_ts:null,sha256:hash,bytes:bytes.length}},run)).run;
  }
  const clock=now+16*60000;run=execute(s,command('claim',{plan_base64:inputPlan.toString('base64')},run,ownerB),clock).run;
  const bad=message(`!ai-report stage-v2 ${id} ${'f'.repeat(64)} ${permit}`,'1793492161.000001','FOTHER');
  const stage=message(`!ai-report stage-v2 ${id} ${hash} ${permit}`,'1793492162.000001','FORIGINAL');
  const legacy=message(`!ai-report stage ${id} ${hash}`,'1793492163.000001','FORIGINAL');
  const messages=[bad,stage,legacy],slack={historyPage:async({from,to})=>({messages:messages.filter(m=>m.ts>=from&&m.ts<=to),next_cursor:null}),exactPublish:async ts=>messages.find(m=>m.ts===ts),download:async()=>bytes};
  const inbox=new PublisherInbox(s,config),scanned=await inbox.scan(slack,clock);assert.equal(scanned.rejected.length,1);
  const remote=async()=>({complete:true,observed_at:clock,read_context:{scheduler_scope_sha256:'c'.repeat(64)},scheduler:null,scheduler_day_claim:null});
  await advanceSubmission(s,config,slack,remote,clock);assert.equal(s.db.prepare('SELECT phase FROM slack_submission_events WHERE source_ts=?').get(bad.ts).phase,'fenced');
  const stageResult=await advanceSubmission(s,config,slack,remote,clock);assert.equal(stageResult,undefined);
  assert.equal(s.db.prepare('SELECT phase FROM slack_staged_bundles WHERE request_id=?').get(id).phase,'staged');
  assert.equal(s.db.prepare('SELECT phase FROM research_control_ops WHERE operation_id=?').get(completeOp.operation_id).phase,'acknowledged');
  slack.history=async()=>[stage];const tick=await handoffTick(s,config,slack,{now:()=>clock,scheduleQuery:remote});assert.deepEqual(tick.errors,[]);
  run=execute(s,command('status',{offset:0}),clock).run;assert.equal(run.owner_id,ownerB);
  const input={archive_sha256:checkpoint,permit_id:permit,step:'submit',file_id:'FORIGINAL',source_ts:stage.ts,bytes:bytes.length,sha256:hash};
  const op={operation_id:randomUUID(),kind:'native',key:'permit:'+permit+':submit',input_sha256:digest(Buffer.from(JSON.stringify(input))),input,max_seconds:0};
  assert.equal(execute(s,command('reserve',{operations:[op]},run,ownerB),clock).dispatch_granted,true);
  const submit=message(`!ai-report submit-v2 ${id} ${hash} ${stage.ts} ${permit}`,'1793492171.000001');messages.push(submit);
  await inbox.scan(slack,clock+2000);const submitted=await advanceSubmission(s,config,slack,async()=>({...await remote(),observed_at:clock+2000}),clock+2000);assert.equal(submitted,undefined);
  assert.equal(s.metadata(id).hash,hash);assert.equal(s.metadata(id).source_ts,stage.ts);assert.equal(s.metadata(id).detail.submission_source_ts,submit.ts);
  assert.equal(s.db.prepare('SELECT count(*) n FROM jobs').get().n,1);assert.equal(s.db.prepare('SELECT phase FROM research_control_ops WHERE operation_id=?').get(op.operation_id).phase,'acknowledged');
  const proposal=await propose(api,files,publicationBase);assert.equal(proposal.sha,api.pulls[0].head.sha);
  const writes=api.calls.filter(c=>c.method!=='GET').length;api.refs.set('main','c'.repeat(40));
  await assert.rejects(propose(api,files,publicationBase),e=>e.diagnostic?.code==='main_moved');
  assert.equal(api.calls.filter(c=>c.method!=='GET').length,writes);
  assert.deepEqual(Buffer.from(execute(s,command('status',{offset:0}),clock).plan_base64,'base64'),inputPlan);

 }finally{s.close();}
});

test('multipart stage uses one permit and submit across missing, corrupt and duplicate shares',async()=>{
 const s=setup();try{
  const run=start(s),files=new Map(FILES),meta=[...files.keys()].find(p=>p.endsWith('/report.json'));
  const descriptor=JSON.parse(files.get(meta)),asset=descriptor.images[0],dir=meta.slice(0,-'report.json'.length);
  const image='assets/second-view.png';files.set(dir+image,files.get(dir+asset.path));descriptor.images.push({...asset,path:image});
  files.set(meta,Buffer.from(JSON.stringify(descriptor)));
  const original=await encodeBundle(files,id,'b'.repeat(40),'a'.repeat(40));
  // Reach the exact logical bound with legal JSON whitespace. The two raster
  // files, all original Markdown and the surrounding bytes must survive intact.
  const bytes=Buffer.concat([original,Buffer.alloc(8*1024*1024-original.length,32)]),hash=digest(bytes);
  const audit=Buffer.from(JSON.stringify(auditSummary({readiness:'partial'},files)));
  const checkpoint=archive(s,{'bundle.json':bytes,'audit.json':audit});
  const issued=await issuePermit(s,command('permit',{archive_sha256:checkpoint,bundle_sha256:hash,audit_sha256:digest(audit)},run));
  assert.equal(issued.status,'committed',issued.code);
  const permit=issued.run.permit.permit_id;
  const shared=[],uploads=new Map(),messages=[];let anchorMessageReads=0,anchorDownloads=0;
  const callTool=async(tool,args)=>{
   if(tool===PRODUCER_TOOLS.ticket){
    const file_id='F'+(uploads.size+1);uploads.set(file_id,{name:args.filename,size:args.content_length});
    return {file_id,upload_url:'https://files.slack.com/upload/v1/synthetic-ticket-'+file_id};
   }
   assert.equal(tool,PRODUCER_TOOLS.complete);const index=Number(args.initial_comment.split('/').at(-1));
   shared[index]=message(args.initial_comment,'179349120'+(2+index)+'.000001',args.file_id);return {};
  };
  const upload=async({bytes:data,ticket,contentType})=>{
   assert.equal(contentType,'application/octet-stream');const entry=uploads.get(ticket.file_id);assert.equal(entry.size,data.length);entry.data=Buffer.from(data);
   return {adapter:'producer_curl_managed_proxy_v1',file_id:ticket.file_id,url_sha256:ticket.url_sha256,bundle_sha256:digest(data),metrics:{curl_exit:0,http_status:200,upload_bytes:data.length,num_redirects:0,ssl_verify_result:0}};
  };
  const slack={historyPage:async({from,to})=>({messages:messages.filter(m=>m.ts>=from&&m.ts<=to),next_cursor:null}),exactPublish:async ts=>{
   if(ts===shared[0]?.ts)assert.equal(++anchorMessageReads,1,'a verified anchor need not be retrieved from Slack again');
   return messages.find(m=>m.ts===ts);
  },download:async(row,{name,limit})=>{
   if(row.source_ts===shared[0]?.ts)assert.equal(++anchorDownloads,1);
   const file=uploads.get(row.file_id);assert.equal(file.name,name);assert.ok(file.data.length<=limit);return file.data;
  }};
  const inbox=new PublisherInbox(s,config),query=at=>async()=>({complete:true,observed_at:at,read_context:{scheduler_scope_sha256:'c'.repeat(64)},scheduler:null,scheduler_day_claim:null});
  const native=nativeFixtureControl(s);let racedOperation=null,casRefusals=0;
  const authority=nativeResearchAuthority({request_id:id,owner_id:ownerA,archive_sha256:checkpoint,permit_id:permit},async raw=>{
   const cmd=JSON.parse(raw),op=cmd.args.operations?.[0];
   if(cmd.action==='reserve'&&op.input.part===2&&op.input.step==='post'){
    if(racedOperation===null){
     racedOperation=op.operation_id;messages.push(shared[1]);
     queueSubmission(s.db,acceptSubmission(shared[1],config,now));

     // Isolate the scan clock so future history still arrives normally below.
     const probe=await mkdtemp(join(tmpdir(),'partial-day-'));let copy;
     try{
      const path=join(probe,'original.sqlite');s.db.prepare('VACUUM INTO ?').run(path);
      copy=new HandoffState(path,handoffScope(config));const cloneInbox=new PublisherInbox(copy,config);
      await cloneInbox.scan(slack,now);
      assert.equal(submissionStatus(copy.db,id).pending[0].phase,'pending');
      const inspect=()=>producerInspection(copy,config,{kind:'inspect',request_id:id,report_date:DAY,query_id:randomUUID(),bundle_sha256:hash},shared[1].ts,query(now),()=>now);
      const queued=await inspect();assert.equal(queued.complete,false);assert.equal(queued.reason,'multipart_staging_pending');
      await advanceSubmission(copy,config,slack,query(now),now);
      const day=await inspectDay(copy,config,{kind:'day',request_id:id,report_date:DAY,query_id:randomUUID()},shared[1].ts,query(now),()=>now);
      assert.equal(day.state,'pending');assert.equal(day.pending_submissions[0].phase,'receiving');
      const partial=await inspect();assert.equal(partial.complete,false);assert.equal(partial.reason,'multipart_staging_pending');
      assert.equal(Object.hasOwn(partial,'publisher'),false);
      const request={kind:'inspect',request_id:id,report_date:DAY,query_id:randomUUID(),bundle_sha256:hash,source_ts:'1793491202.123456',hash:'a'.repeat(64)};
      const posted=[];
      const receipt={controlReceipt:async(ts,text)=>{assert.equal(ts,request.source_ts);posted.push(JSON.parse(text.slice('!ai-report inspect-receipt '.length)));return '1793491211.125000';}};
      await replyScheduledStatus(copy,config,request,receipt,query(Date.now()));
      await replyScheduledStatus(copy,config,request,receipt,query(Date.now()));
      assert.equal(posted.length,1);assert.equal(posted[0].query_id,request.query_id);assert.equal(posted[0].complete,false);
      assert.equal(copy.db.prepare('SELECT phase FROM scheduled_status_replies WHERE source_ts=?').get(request.source_ts).phase,'sent');
      const later=now+20*60000;
      const health=await handoffTick(copy,config,{...slack,history:async()=>[]},{now:()=>later,scheduleQuery:query(later)});
      assert.equal(health.waiting_report_parts[0]?.phase,'receiving');assert.deepEqual(health.blocked_intake,[]);
      assert.equal(health.healthy,true);assert.equal(health.next_delay_ms,120000);
      const snapshot=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c',
       'from pathlib import Path;from deployment.publisher_cd import snapshot;import sys;print(snapshot(Path(sys.argv[1])))',path],{encoding:'utf8'});
      assert.equal(snapshot.status,0,snapshot.stderr);
      // The health response has a 16-row display limit. Older waiting parts
      // must never hide the deadline of runnable work just beyond that limit.
      const event=copy.db.prepare("INSERT INTO slack_submission_events(source_ts,request_id,hash,kind,file_id,phase,next_at) VALUES(?,?,?,'part-0','FOLDER',?,?)");
      for(let i=0;i<16;i++)event.run('1793491201.'+String(i).padStart(6,'0'),id,hash,'receiving',0);
      event.run('1793491299.000001',id,hash,'pending',later+7000);
      const backlog=await handoffTick(copy,config,{...slack,history:async()=>[]},{now:()=>later,scheduleQuery:query(later)});
      assert.equal(backlog.waiting_report_parts.length,15);assert.equal(backlog.blocked_intake.length,1);
      assert.equal(backlog.healthy,false);assert.equal(backlog.next_delay_ms,7000);
     }finally{copy?.close();await rm(probe,{recursive:true,force:true});}
     await advanceSubmission(s,config,slack,query(now),now);
     assert.equal(submissionStatus(s.db,id).pending[0]?.phase,'receiving');
     assert.equal(pendingSubmissions(s.db)[0]?.phase,'receiving');
    }else assert.equal(op.operation_id,racedOperation);
   }
   const result=await native(raw);
   if(result.code==='revision_conflict')casRefusals++;
   return result;
  },()=>now);
  await assert.rejects(stageFile(bytes,SCOPE.channel_id,callTool,{authority,upload}),/grant required/);
  assert.equal(uploads.size,0);assert.equal(s.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='research_control_report_parts'").get().n,0);
  assert.equal(installReportParts(s.db,config),true);assert.equal(installReportParts(s.db,config),false);
  await stageFile(bytes,SCOPE.channel_id,callTool,{authority,upload});assert.equal(shared.length,8);
  assert.equal(casRefusals,1);assert.equal(uploads.size,8);
  messages.length=0;
  messages.push(...shared);await inbox.scan(slack,now);
  await advanceSubmission(s,config,slack,query(now),now);
  assert.equal(s.db.prepare("SELECT phase FROM slack_submission_events WHERE kind='part-0'").get().phase,'receiving');
  assert.equal(s.db.prepare('SELECT count(*) n FROM slack_staged_bundles').get().n,0);
  const last=uploads.get(shared[2].files[0].id),originalPart=last.data;
  last.data=Buffer.from(originalPart);last.data[0]^=1;await advanceSubmission(s,config,slack,query(now),now);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_report_parts').get().n,2);last.data=originalPart;
  const dirCopy=await mkdtemp(join(tmpdir(),'multipart-snapshot-'));
  try{
   const file=join(dirCopy,'partial.sqlite');s.db.prepare('VACUUM INTO ?').run(file);
   const check=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c',
    'from pathlib import Path;from deployment.publisher_cd import snapshot;import sys;print(snapshot(Path(sys.argv[1]),settled=False))',file],{encoding:'utf8'});
   assert.equal(check.status,0,check.stderr);assert.match(check.stdout.trim(),/^[a-f0-9]{64}$/);
   const settled=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c',
    'from pathlib import Path;from deployment.publisher_cd import snapshot;import sys;snapshot(Path(sys.argv[1]))',file],{encoding:'utf8'});
   assert.notEqual(settled.status,0);assert.match(settled.stderr,/unfinished_slack_submission/);
  }finally{await rm(dirCopy,{recursive:true,force:true});}
  for(let i=0;i<16;i++){
   const {n}=s.db.prepare("SELECT min(next_at) n FROM slack_submission_events WHERE phase='pending'").get();
   if(n===null)break;const at=Math.max(now,n)+10;await advanceSubmission(s,config,slack,query(at),at);
  }
  const staged=s.db.prepare('SELECT * FROM slack_staged_bundles WHERE request_id=?').get(id);
  assert.ok(staged);assert.deepEqual(Buffer.from(staged.bytes),bytes);assert.equal(staged.source_ts,shared[0].ts);
  assert.equal(s.metadata(id),null);assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_report_parts').get().n,0);
  assert.equal(s.db.prepare("SELECT count(*) n FROM slack_submission_events WHERE kind LIKE 'part-%' AND phase='done'").get().n,8);
  const repeated=await stageFile(bytes,SCOPE.channel_id,()=>assert.fail('duplicate stage write'),{authority,upload:()=>assert.fail('duplicate POST')});
  assert.equal(repeated.source_ts,staged.source_ts);assert.equal(repeated.bundle_sha256,hash);
  await authority.before('submit',staged.file_id,bytes,staged.source_ts);
  messages.push(message(`!ai-report submit-v2 ${id} ${hash} ${staged.source_ts} ${permit}`,'1793491211.000001'));
  await inbox.scan(slack,now+2000);await advanceSubmission(s,config,slack,query(now+2000),now+2000);
  assert.equal(s.metadata(id)?.hash,hash);assert.equal(s.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  await assert.rejects(authority.before('submit',staged.file_id,bytes,staged.source_ts),/reconciliation/);
 }finally{s.close();}
});

const layeredPlan=()=>Buffer.from(JSON.stringify({...JSON.parse(plan),schema_version:'research_plan_v4',limits:{max_attempts_per_source:2,max_attempts_per_model:2,source_attempt_timeout_seconds:180,model_stage_timeout_seconds:1200,total_budget_seconds:3600}}));
test('layered plan admits model stages over 180 seconds without changing legacy plan limits',()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());
  const model={...source('editor','model'),max_seconds:600};
  const result=execute(s,command('reserve',{operations:[model]},run));
  assert.equal(result.status,'committed');assert.equal(result.run.charged_seconds,600);
  const bad={...source('https://example.org/slow'),max_seconds:181};
  assert.equal(execute(s,command('reserve',{operations:[bad]},result.run)).code,'operation_fields');
 }finally{s.close();}
 const old=setup();try{const run=start(old);assert.equal(execute(old,command('reserve',{operations:[{...source('editor','model'),max_seconds:600}]},run)).code,'operation_fields');}finally{old.close();}
});
test('layered model recovery binds original acknowledged failure checkpoint and remaining stage budget',()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const first={...source('editor','model'),max_seconds:600};
  run=execute(s,command('reserve',{operations:[first]},run)).run;
  const data=Buffer.from(JSON.stringify({status:'timeout',operation_id:first.operation_id,request_id:id,elapsed_seconds:500,completed:['candidate-1'],remaining:['candidate-2']}));
  const head=archive(s,{'stage_artifacts/checkpoint.json':data});
  run=execute(s,command('settle',{operation_id:first.operation_id,outcome:'acknowledged',elapsed_seconds:500,archive_sha256:head,file_sha256:digest(data),native_result:null},run)).run;
  const second={...source('editor','model'),input_sha256:'e'.repeat(64),max_seconds:1200,input:{previous_operation_id:first.operation_id,checkpoint_archive_sha256:head,checkpoint_file_sha256:digest(data)}};
  assert.equal(execute(s,command('reserve',{operations:[{...second,max_seconds:1201}]},run)).code,'operation_fields');
  assert.equal(execute(s,command('reserve',{operations:[{...second,input:{...second.input,checkpoint_file_sha256:'f'.repeat(64)}}]},run)).code,'model_recovery_original');
  const result=execute(s,command('reserve',{operations:[second]},run));assert.equal(result.status,'committed');assert.equal(result.run.charged_seconds,1700);
  const observed=execute(s,command('status',{offset:0}));assert.equal(observed.effective_budget.accounting.failed_seconds,500);assert.equal(observed.effective_budget.accounting.reserved_seconds,1200);
 }finally{s.close();}
});
test('layered model unknown result cannot be replayed as recovery',()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const first=source('editor','model');run=execute(s,command('reserve',{operations:[first]},run)).run;
  run=execute(s,command('settle',unknown(first.operation_id),run)).run;
  const second={...source('editor','model'),input:{previous_operation_id:first.operation_id,checkpoint_archive_sha256:'a'.repeat(64),checkpoint_file_sha256:'b'.repeat(64)}};
  assert.equal(execute(s,command('reserve',{operations:[second]},run)).code,'model_recovery_original');
 }finally{s.close();}
});

test('layered failed source attempts preserve evidence but resume next hourly window without consuming success allowance',()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const url='https://example.org/temporary';
  for(let i=0;i<2;i++){
   const op=source(url);run=execute(s,command('reserve',{operations:[op]},run)).run;
   const data=Buffer.from(JSON.stringify({status:'timeout',url,operation_id:op.operation_id,request_id:id,elapsed_seconds:181}));
   const head=archive(s,{['results/attempt-'+i+'.json']:data});
   const settled=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:181,archive_sha256:head,file_sha256:digest(data),native_result:null},run));
   assert.equal(settled.status,'committed');run=settled.run;
  }
  assert.equal(execute(s,command('reserve',{operations:[source(url)]},run)).code,'research_window_attempts_exhausted');
  const oldStarted=run.started_at,oldHash=run.plan_hash;
  const later=now+3600000;
  run=execute(s,command('claim',{plan_base64:layeredPlan().toString('base64')},run),later).run;
  const resumed=execute(s,command('reserve',{operations:[source(url)]},run),later);
  assert.equal(resumed.status,'committed');assert.equal(resumed.run.started_at,oldStarted);assert.equal(resumed.run.plan_hash,oldHash);
  const observed=execute(s,command('status',{offset:0}),later);
  assert.equal(observed.effective_budget.accounting.failed_seconds,362);assert.equal(observed.effective_budget.accounting.success_seconds,0);assert.equal(observed.run.charged_seconds,542);
 }finally{s.close();}
});

test('layered original unstarted intent can resume in a later window without duplicate operation or charge',()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const op=source('editor','model'),cmd=command('reserve',{operations:[op]},run),result=execute(s,cmd);run=result.run;
  const reply='!ai-research control-receipt '+JSON.stringify({...result,dispatch_granted:false,grant_expired:true});
  s.db.prepare('INSERT INTO research_control_events VALUES(?,?,?,?,?,?,?,?,?,?)').run('1793491201.999999',cmd.command_id,digest(Buffer.from(JSON.stringify(cmd))),Buffer.from(JSON.stringify(cmd)),'sent',1,0,reply,'1793491202.999999',null);
  const later=now+3600000;
  run=execute(s,command('claim',{plan_base64:layeredPlan().toString('base64')},run),later).run;
  const resumed=execute(s,command('resume',{operation_id:op.operation_id},run),later);
  assert.equal(resumed.status,'committed');assert.equal(resumed.dispatch_granted,true);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,1);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_recovery_operations').get().n,2);
  assert.equal(resumed.run.charged_seconds,180);
 }finally{s.close();}
});
test('approved recovery grant continues original legacy failed model without rewriting original plan or elapsed cost',()=>{
 const s=setup();try{
  let run=start(s);const first=source('editor','model');run=execute(s,command('reserve',{operations:[first]},run)).run;
  const data=Buffer.from(JSON.stringify({schema_version:'private_research_result_v1',request_id:id,operation_id:first.operation_id,stage_status:'failed',elapsed_seconds:189.45}));
  const head=archive(s,{'original-failure.json':data});
  run=execute(s,command('settle',{operation_id:first.operation_id,outcome:'acknowledged',elapsed_seconds:189.45,archive_sha256:head,file_sha256:digest(data),native_result:null},run)).run;
  const savedPlan=s.db.prepare('SELECT plan FROM research_control_runs').get().plan,originalStart=run.started_at;
  installResearchRecovery(s.db,'explicit synthetic user authorization',now);
  const grant={schema_version:'research_recovery_grant_v1',grant_id:randomUUID(),request_id:id,generation:config.research_control.generation,plan_hash:run.plan_hash,previous_sha256:null,authorization_reference:'synthetic owner approval',effective_not_before:nextResearchContinuationAt(now),window_seconds:3600,failed_attempts_consume_success_budget:false,continuation_policy:'hourly_20_until_complete'};
  const bytes=Buffer.from(JSON.stringify(grant));
  assert.equal(execute(s,command('recovery_grant',{grant_base64:bytes.toString('base64')},run)).code,'recovery_authorization_unverified');
  approveResearchRecoveryGrant(s.db,bytes,grant.authorization_reference,now);
  run=execute(s,command('recovery_grant',{grant_base64:bytes.toString('base64')},run)).run;
  const retry={...source('editor','model'),max_seconds:600,input:{previous_operation_id:first.operation_id,checkpoint_archive_sha256:head,checkpoint_file_sha256:digest(data)}};
  assert.equal(execute(s,command('reserve',{operations:[retry]},run)).code,'research_continuation_not_due');
  const later=grant.effective_not_before+3600000;
  run=execute(s,command('claim',{plan_base64:plan.toString('base64')},run),later).run;
  const resumed=execute(s,command('reserve',{operations:[retry]},run),later);
  assert.equal(resumed.status,'committed');assert.equal(resumed.run.charged_seconds,789.45);assert.equal(resumed.run.started_at,originalStart);
  assert.deepEqual(s.db.prepare('SELECT plan FROM research_control_runs').get().plan,savedPlan);
 }finally{s.close();}
});

test('layered publication verifies host accounting with only microsecond summation tolerance',async()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());
  for(const [i,elapsed] of [0.3,0.2,0.1].entries()){
   const url='https://example.org/accounting/'+i,op=source(url);run=execute(s,command('reserve',{operations:[op]},run)).run;
   const data=Buffer.from(JSON.stringify({request_id:id,operation_id:op.operation_id,url,status:'ok',elapsed_seconds:elapsed}));
   const h=archive(s,{['source-'+i+'.json']:data});
   run=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:elapsed,archive_sha256:h,file_sha256:digest(data),native_result:null},run)).run;
  }
  const bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40));
  const valid=auditSummary({schema_version:'1.4',budget_policy:'successful_work_hourly_continuation_v1',limits:{source_attempts:2,model_attempts:2,source_attempt_seconds:180,model_stage_seconds:1200,run_seconds:3600},budget_accounting:{successful_attempts:{source:3,model:0},failed_attempts:{source:0,model:0},unknown_attempts:{source:0,model:0},successful_seconds:0.1+0.2+0.3,failed_seconds:0,reserved_unknown_seconds:0,charged_seconds:0.1+0.2+0.3}});
  for(const [a,code] of [[{...valid,schema_version:'1.3'},'publication_coverage_contract'],[{...valid,budget_accounting:{...valid.budget_accounting,successful_seconds:0}},'publication_budget_accounting']]){
   const audit=Buffer.from(JSON.stringify(a)),h=archive(s,{'bundle.json':bundle,'audit.json':audit});
   assert.equal((await issuePermit(s,command('permit',{archive_sha256:h,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},run))).code,code);
  }
  const audit=Buffer.from(JSON.stringify(valid)),h=archive(s,{'bundle.json':bundle,'audit.json':audit});
  assert.equal((await issuePermit(s,command('permit',{archive_sha256:h,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},run))).status,'committed');
 }finally{s.close();}
});


test('malformed recovery grant is a durable rejection not an unhandled pending command',async()=>{
 const s=setup();try{const run=start(s);const cmd=command('recovery_grant',{grant_base64:Buffer.from('{broken').toString('base64')},run);
 const result=execute(s,cmd);assert.equal(result.status,'rejected');assert.equal(result.code,'recovery_json');assert.equal(result.dispatch_granted,false);
 assert.deepEqual(execute(s,cmd),{...result,replayed:true});
 const fresh=command('recovery_grant',{grant_base64:Buffer.from('{broken').toString('base64')},run);queue(s,fresh);
 let receipt;await advanceResearchControl(s,config,{controlReceipt:async(_,text)=>{receipt=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793491209.000001';}},now);
 assert.equal(receipt.code,'recovery_json');assert.equal(receipt.status,'rejected');
 assert.equal(s.db.prepare('SELECT phase FROM research_control_events').get().phase,'sent');
 }finally{s.close();}
});

test('unstarted legacy intent follows approved grant chain without a new operation',()=>{
 const s=setup();try{
 let run=start(s),t=now;installResearchRecovery(s.db,'explicit synthetic user authorization',now);
 const grant=(previous)=>{const g={schema_version:'research_recovery_grant_v1',grant_id:randomUUID(),request_id:id,generation:config.research_control.generation,plan_hash:run.plan_hash,previous_sha256:previous,authorization_reference:'synthetic owner approval',effective_not_before:nextResearchContinuationAt(t),window_seconds:3600,failed_attempts_consume_success_budget:false,continuation_policy:'hourly_20_until_complete'};const b=Buffer.from(JSON.stringify(g));approveResearchRecoveryGrant(s.db,b,g.authorization_reference,t);run=execute(s,command('recovery_grant',{grant_base64:b.toString('base64')},run),t).run;return {g,b};};
 const first=grant(null);t=first.g.effective_not_before;
 run=execute(s,command('claim',{plan_base64:plan.toString('base64')},run),t).run;
 const op=source('editor','model'),cmd=command('reserve',{operations:[op]},run),result=execute(s,cmd,t);run=result.run;
 const reply='!ai-research control-receipt '+JSON.stringify({...result,dispatch_granted:false,grant_expired:true});
 s.db.prepare('INSERT INTO research_control_events VALUES(?,?,?,?,?,?,?,?,?,?)').run('1793491201.999999',cmd.command_id,digest(Buffer.from(JSON.stringify(cmd))),Buffer.from(JSON.stringify(cmd)),'sent',1,0,reply,'1793491202.999999',null);
 const second=grant(digest(first.b));t=second.g.effective_not_before;
 run=execute(s,command('claim',{plan_base64:plan.toString('base64')},run),t).run;
 const resumed=execute(s,command('resume',{operation_id:op.operation_id},run),t);
 assert.equal(resumed.status,'committed');assert.equal(resumed.dispatch_granted,true);assert.equal(resumed.run.charged_seconds,180);
 assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,1);
 assert.equal(s.db.prepare('SELECT count(*) n FROM research_recovery_operations').get().n,2);
 }finally{s.close();}
});


test('non-object archived results remain unknown without breaking the original control ledger',()=>{
 for(const value of ['null','[]','42','"invalid"']){
 const s=setup();try{
  let run=start(s,layeredPlan());const op=source('editor','model');run=execute(s,command('reserve',{operations:[op]},run)).run;
  const data=Buffer.from(value),head=archive(s,{'malformed-result.json':data});
  const settled=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:20,archive_sha256:head,file_sha256:digest(data),native_result:null},run));
  assert.equal(settled.status,'committed');run=settled.run;
  const status=execute(s,command('status',{offset:0},null,null));assert.equal(status.status,'observed');
  assert.equal(execute(s,command('renew',{},run)).status,'committed');
  run=execute(s,command('status',{offset:0},null,null)).run;
  const retry={...source('editor','model'),input:{previous_operation_id:op.operation_id,checkpoint_archive_sha256:head,checkpoint_file_sha256:digest(data)}};
  assert.equal(execute(s,command('reserve',{operations:[retry]},run)).code,'model_recovery_not_failed');
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_ops').get().n,1);
 }finally{s.close();}
 }
});

test('uninstalled recovery layer returns durable well-formed rejection through inbox',async()=>{
 const s=setup();try{
  const run=start(s),original=Buffer.from(s.db.prepare('SELECT plan FROM research_control_runs').get().plan);
  const grant={schema_version:'research_recovery_grant_v1',grant_id:randomUUID(),request_id:id,generation:config.research_control.generation,plan_hash:run.plan_hash,previous_sha256:null,authorization_reference:'synthetic owner approval',effective_not_before:nextResearchContinuationAt(now),window_seconds:3600,failed_attempts_consume_success_budget:false,continuation_policy:'hourly_20_until_complete'};
  const args={grant_base64:Buffer.from(JSON.stringify(grant)).toString('base64')};
  const cmd=command('recovery_grant',args,run),result=execute(s,cmd);
  assert.equal(result.status,'rejected');assert.equal(result.code,'recovery_layer_not_installed');assert.equal(result.dispatch_granted,false);
  assert.deepEqual(execute(s,cmd),{...result,replayed:true});
  queue(s,command('recovery_grant',args,run));let receipt;
  await advanceResearchControl(s,config,{controlReceipt:async(_,text)=>{receipt=JSON.parse(text.slice('!ai-research control-receipt '.length));return '1793491209.000001';}},now);
  assert.equal(receipt.code,'recovery_layer_not_installed');assert.equal(receipt.status,'rejected');
  assert.equal(s.db.prepare('SELECT phase FROM research_control_events').get().phase,'sent');
  assert.equal(s.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'research_recovery_%'").get().n,0);
  assert.deepEqual(Buffer.from(s.db.prepare('SELECT plan FROM research_control_runs').get().plan),original);
 }finally{s.close();}
});
test('installed capability is observable for both absent and existing legacy run before grant',()=>{
 const s=setup();try{
  assert.deepEqual(execute(s,command('status',{offset:0})).capabilities,{archive_recovery:'authenticated_control_chunks_v1'});
  installResearchRecovery(s.db,'synthetic explicit installation');
  const absent=execute(s,command('status',{offset:0}));assert.equal(absent.status,'not_found');
  const run=start(s),original=Buffer.from(s.db.prepare('SELECT plan FROM research_control_runs').get().plan);
  const existing=execute(s,command('status',{offset:0}));
  assert.equal(existing.status,'observed');assert.deepEqual(existing.capabilities,absent.capabilities);
  assert.deepEqual(existing.capabilities.repository_plan_versions,['research_plan_v3','research_plan_v4']);
  assert.equal(existing.capabilities.budget_policy,'successful_work_hourly_continuation_v1');
  assert.equal(existing.effective_budget,undefined);assert.equal(existing.run.plan_hash,run.plan_hash);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_recovery_grants').get().n,0);
  assert.deepEqual(Buffer.from(s.db.prepare('SELECT plan FROM research_control_runs').get().plan),original);
 }finally{s.close();}
});

test('layered cumulative publication budget tolerates only bounded floating arithmetic error',async()=>{
 for(const excess of [0,0.000002]){
 const s=setup();try{
  let run=start(s,layeredPlan()),total=0;
  const durations=excess?[...Array(18).fill(180),0.03,179.99,179.98+excess]:[...Array(18).fill(180),0.03,179.99,178.98,1];
  for(const [i,elapsed] of durations.entries()){
   const url='https://example.org/float-limit/'+i,op={...source(url),max_seconds:Math.max(1,Math.floor(elapsed))};
   const reservation=execute(s,command('reserve',{operations:[op]},run));assert.equal(reservation.status,'committed');run=reservation.run;
   const data=Buffer.from(JSON.stringify({request_id:id,operation_id:op.operation_id,url,status:'ok',elapsed_seconds:elapsed}));
   const h=archive(s,{['float-'+i+'.json']:data});run=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:elapsed,archive_sha256:h,file_sha256:digest(data),native_result:null},run)).run;total+=elapsed;
  }
  const bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40));
  const a=auditSummary({schema_version:'1.4',budget_policy:'successful_work_hourly_continuation_v1',limits:{source_attempts:2,model_attempts:2,source_attempt_seconds:180,model_stage_seconds:1200,run_seconds:3600},budget_accounting:{successful_attempts:{source:durations.length,model:0},failed_attempts:{source:0,model:0},unknown_attempts:{source:0,model:0},successful_seconds:total,failed_seconds:0,reserved_unknown_seconds:0,charged_seconds:total}});
  const audit=Buffer.from(JSON.stringify(a)),h=archive(s,{'bundle.json':bundle,'audit.json':audit});
  const result=await issuePermit(s,command('permit',{archive_sha256:h,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},run));
  if(excess)assert.equal(result.code,'publication_success_budget');else {assert(total>3600);assert.equal(result.status,'committed');}
 }finally{s.close();}
 }
});

test('large shared result archive is decoded once per command and never reused across commands',()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());
  const ops=Array.from({length:16},(_,i)=>source('https://example.org/command-cache/'+i));
  for(let i=0;i<ops.length;i+=8){const result=execute(s,command('reserve',{operations:ops.slice(i,i+8)},run));assert.equal(result.status,'committed');run=result.run;}
  const files=Object.fromEntries(ops.map((op,i)=>['result-'+i+'.json',Buffer.from(JSON.stringify({request_id:id,operation_id:op.operation_id,url:op.input.url,status:'ok',elapsed_seconds:1}))]));
  files['body-a.txt']=Buffer.alloc(8*1024*1024,65);files['body-b.txt']=Buffer.alloc(3*1024*1024,66);
  const head=archive(s,files);
  // Synthetic fixture rows bind each original intent to its distinct stored result.
  for(const [i,op] of ops.entries())s.db.prepare("UPDATE research_control_ops SET phase='acknowledged',elapsed_seconds=1,result_archive=?,result_file=? WHERE operation_id=?").run(head,digest(files['result-'+i+'.json']),op.operation_id);
  const parse=JSON.parse,prepare=s.db.prepare;
  let decodes=0,reads=0;
  JSON.parse=function(value,...args){if(typeof value==='string'&&value.startsWith('{"schema_version":"research_archive_v1",'))decodes++;return parse(value,...args);};
  s.db.prepare=function(sql){if(sql==='SELECT bytes FROM research_archives WHERE request_id=? AND hash=?')reads++;return prepare.call(this,sql);};
  try{
   const observed=execute(s,command('status',{offset:0}));assert.equal(observed.status,'observed');
   assert.equal(observed.effective_budget.accounting.success_seconds,16);assert.equal(decodes,1);assert.equal(reads,1);
   const renewed=execute(s,command('renew',{},run));assert.equal(renewed.status,'committed');
   assert.equal(decodes,2);assert.equal(reads,2);
   // A new command must observe changed phase/result evidence, not old classifications.
   s.db.prepare("UPDATE research_control_ops SET phase='unknown',elapsed_seconds=NULL,result_archive=NULL,result_file=NULL WHERE operation_id=?").run(ops[0].operation_id);
   const changed=execute(s,command('status',{offset:0}));
   assert.equal(changed.effective_budget.accounting.success_seconds,15);assert.equal(changed.effective_budget.accounting.reserved_seconds,180);
   assert.equal(changed.effective_budget.accounting.unknown_attempts.source,1);assert.equal(decodes,3);assert.equal(reads,3);
   // Tampering between commands is detected by a fresh original-byte hash validation.
   const row=s.db.prepare('SELECT bytes FROM research_archives WHERE hash=?').get(head),bad=parse(Buffer.from(row.bytes).toString());
   bad.files[0].content_base64=Buffer.from('changed').toString('base64');
   s.db.prepare('UPDATE research_archives SET bytes=? WHERE hash=?').run(Buffer.from(JSON.stringify(bad)),head);
   assert.throws(()=>execute(s,command('status',{offset:0})),/Research file bytes differ/);
   assert.equal(decodes,4);assert.equal(reads,4);
  }finally{JSON.parse=parse;s.db.prepare=prepare;}
 }finally{s.close();}
});

test('interleaved large archives have bounded command-local retained memory',()=>{
 if(!process.env.RESEARCH_CACHE_MEMORY_CHILD){
  const env={...process.env,RESEARCH_CACHE_MEMORY_CHILD:'1'};delete env.NODE_TEST_CONTEXT;
  const child=spawnSync(process.execPath,['--expose-gc','--test','--test-name-pattern=^interleaved large archives have bounded command-local retained memory$',fileURLToPath(import.meta.url)],{env,encoding:'utf8',timeout:120000});
  assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
  assert.match(child.stdout,/cache-memory peak_growth_bytes=\d+ after_growth_bytes=-?\d+ archives=8/);
  console.log(child.stdout.match(/cache-memory peak_growth_bytes=\d+ after_growth_bytes=-?\d+ archives=8/)[0]);
  return;
 }
 assert.equal(typeof global.gc,'function');
 const s=setup();try{
  let run=start(s,layeredPlan());
  const ops=Array.from({length:16},(_,i)=>source('https://example.org/bounded-cache/'+i));
  for(let i=0;i<ops.length;i+=8){const r=execute(s,command('reserve',{operations:ops.slice(i,i+8)},run));assert.equal(r.status,'committed');run=r.run;}
  // Row order interleaves eight archives twice, each with an 8 MiB body.
  function storeGroup(group){
   const files={'body.txt':Buffer.alloc(8*1024*1024,65+group)};
   for(const i of [group,group+8])files['result-'+i+'.json']=Buffer.from(JSON.stringify({request_id:id,operation_id:ops[i].operation_id,url:ops[i].input.url,status:'ok',elapsed_seconds:1}));
   const head=archive(s,files);
   for(const i of [group,group+8])s.db.prepare("UPDATE research_control_ops SET phase='acknowledged',elapsed_seconds=1,result_archive=?,result_file=? WHERE operation_id=?").run(head,digest(files['result-'+i+'.json']),ops[i].operation_id);
  }
  for(let i=0;i<8;i++)storeGroup(i);
  const retained=()=>{global.gc();global.gc();const m=process.memoryUsage();return m.heapUsed+m.arrayBuffers;};
  const baseline=retained();let peak=baseline,decodes=0;
  const parse=JSON.parse;
  JSON.parse=function(value,...args){
   if(typeof value==='string'&&value.startsWith('{"schema_version":"research_archive_v1",')){
    decodes++;peak=Math.max(peak,retained());
   }
   return parse(value,...args);
  };
  try{
   const observed=execute(s,command('status',{offset:0}));
   assert.equal(observed.effective_budget.accounting.success_seconds,16);
   assert.equal(decodes,8,'one decode per archive despite interleaved operation rows');
   const after=retained();
   // Forced-GC live-memory samples at parse boundaries include current raw
   // SQLite bytes and UTF-8 text, not transient allocation peaks or process RSS.
   // Retaining eight bodies/envelopes exceeded 150 MiB in the previous cache.
   assert(peak-baseline<80*1024*1024,'bounded live archive memory: '+(peak-baseline));
   assert(after-baseline<8*1024*1024,'no large bodies retained after command: '+(after-baseline));
   const again=execute(s,command('status',{offset:0}));
   assert.equal(again.effective_budget.accounting.success_seconds,16);assert.equal(decodes,16);
   console.log('cache-memory peak_growth_bytes='+(peak-baseline)+' after_growth_bytes='+(after-baseline)+' archives=8');
  }finally{JSON.parse=parse;}
 }finally{s.close();}
});

test('offline immediate approval stamps real locked approval time and dispatch ends at next :20',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'immediate-admin-')),stateFile=join(dir,'handoff.sqlite');let s;
 Object.assign(config,{producer_app_id:10,merger_app_id:11,ready_for_review:false});
 try{
  s=setup(stateFile);let run=start(s);installResearchRecovery(s.db,'synthetic immediate installation',now);
  const grant={schema_version:'research_recovery_grant_v1',grant_id:randomUUID(),request_id:id,generation:config.research_control.generation,plan_hash:run.plan_hash,previous_sha256:null,authorization_reference:'synthetic immediate user approval',effective_not_before:null,window_seconds:3600,failed_attempts_consume_success_budget:false,continuation_policy:'immediate_once_then_hourly_20_until_complete'};
  s.close();s=null;
  const cfg=join(dir,'config.json'),file=join(dir,'template.json');
  await writeFile(cfg,JSON.stringify({...config,state_dir:dir,slack_token_file:join(dir,'unused-token'),producer_key_file:join(dir,'unused-key')}),{mode:0o600});await writeFile(file,JSON.stringify(grant),{mode:0o600});
  const approved=await administerRecovery(cfg,'--approve-now',grant.authorization_reference,file,now);
  const original=Buffer.from(approved.grant_base64,'base64');assert.equal(approved.approved_at,now);assert.equal(JSON.parse(original).effective_not_before,now);assert.equal(digest(original),approved.sha256);
  s=new HandoffState(stateFile,handoffScope(config));
  run=execute(s,command('recovery_grant',{grant_base64:approved.grant_base64},run)).run;
  const op=source();const reserved=execute(s,command('reserve',{operations:[op]},run));assert.equal(reserved.status,'committed');
  const row=s.db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(id),operation=s.db.prepare('SELECT * FROM research_control_ops WHERE operation_id=?').get(op.operation_id);
  assert.equal(researchOperationDispatchValid(s.db,row,operation,now),true);
  assert.equal(researchOperationDispatchValid(s.db,row,operation,nextResearchContinuationAt(now)),false);
 }finally{s?.close();delete config.producer_app_id;delete config.merger_app_id;delete config.ready_for_review;await rm(dir,{recursive:true,force:true});}
});

test('legacy body-bound source results require unique authenticated original metadata and never downgrade v4',()=>{
 for(const mode of ['ok','reserved-status','http-failed','mismatch','duplicate','layered']){
 const s=setup();try{
  let run=start(s,mode==='layered'?layeredPlan():plan);const op=source('https://example.org/original-body');run=execute(s,command('reserve',{operations:[op]},run)).run;
  const body=Buffer.from(mode==='reserved-status'?JSON.stringify({status:'not_dispatched'}):'original source body'),meta={operation_id:op.operation_id,kind:'source',key:op.key,input_sha256:op.input_sha256,input:op.input,max_seconds:op.max_seconds,elapsed_seconds:1,attempts:1,exit_code:0,http_status:mode==='http-failed'?'404':'200',error:'',bytes:body.length,sha256:digest(body)};
  if(mode==='mismatch')meta.key='f'.repeat(64);
  const files={'sources/original.txt':body,'sources/original.json':Buffer.from(JSON.stringify(meta))};if(mode==='duplicate')files['sources/duplicate.json']=files['sources/original.json'];
  const h=archive(s,files);run=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:1,archive_sha256:h,file_sha256:digest(body),native_result:null},run)).run;
  if(mode!=='layered'){
   installResearchRecovery(s.db,'synthetic installation',now);const grant={schema_version:'research_recovery_grant_v1',grant_id:randomUUID(),request_id:id,generation:config.research_control.generation,plan_hash:run.plan_hash,previous_sha256:null,authorization_reference:'synthetic immediate approval',effective_not_before:now,window_seconds:3600,failed_attempts_consume_success_budget:false,continuation_policy:'immediate_once_then_hourly_20_until_complete'};
   const b=Buffer.from(JSON.stringify(grant));approveResearchRecoveryGrant(s.db,b,grant.authorization_reference,now);run=execute(s,command('recovery_grant',{grant_base64:b.toString('base64')},run)).run;
  }
  const totals=execute(s,command('status',{offset:0})).effective_budget.accounting;
  assert.equal(totals.success_seconds,['ok','reserved-status'].includes(mode)?1:0);assert.equal(totals.failed_seconds,mode==='http-failed'?1:0);assert.equal(totals.reserved_seconds,['ok','reserved-status','http-failed'].includes(mode)?0:180);
 }finally{s.close();}
 }
});

import {installPageAuthority,authenticatedPrevious,beginPageRound,pageRevisionReserved} from '../scripts/research-page-authority.mjs';
import {PAGE_CHECKS} from '../scripts/research-page-coverage.mjs';
import {installScheduledTables} from '../scripts/scheduled-delivery-state.mjs';
for(const targetRevision of [2,6,11])test(`real r${targetRevision} page bundle permits append to original run and use independent native/staging identity`,async()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());installPageAuthority(s.db);
  const original=JSON.parse([...FILES].find(([p])=>p.endsWith('/report.json'))[1]);
  const topicIds=Object.keys(PAGE_CHECKS),rootPath=`reports/${DAY}/`;
  function pageBundle(revision,previous=null){
   const report={...structuredClone(original),schema_version:'1.2',revision,articles:original.articles.slice(0,revision),entries:original.entries.filter(e=>topicIds.slice(0,revision).includes(e.article_id))};
   report.page_delivery={previous,added:[topicIds[revision-1]],pending:topicIds.slice(revision).map(id=>({id,reason:'等待原始来源核验'}))};
   if(revision>1)report.revision_notice={kind:'page_completion',summary:'补齐硬件页'};
   const files=new Map([...FILES].filter(([p])=>!p.includes('/articles/')||topicIds.slice(0,revision).some(id=>p.endsWith('/'+id+'.md'))).map(([p,b])=>[p.replace('/r1/','/'),b]));
   files.set(rootPath+'report.json',Buffer.from(JSON.stringify(report)));return {report,files};
  }
  const first=pageBundle(1),scope=report=>({contract:'verified_pages_v1',page_delivery:report.page_delivery,checked_pages:report.page_delivery.added,previous_evidence:null});
  const limits={source_attempts:2,model_attempts:2,source_attempt_seconds:180,model_stage_seconds:1200,run_seconds:3600};
  let metadata={schema_version:'1.4',date:DAY,scope:'new_daily',decisions:[],status_entries:[],page_scope:scope(first.report),limits,started_at:new Date(now).toISOString(),budget_policy:'successful_work_hourly_continuation_v1',inputs:auditSummary().inputs,sources:[],checks:Object.fromEntries(REQUIRED_RESEARCH_CHECKS.map(k=>[k,{status:k==='model_serving'?'checked':'not_checked'}])),model_calls:['research','editor'].map(stage=>({stage,model:{name:null,version:null,unavailable_reason:'Synthetic fixture'},attempt_records:[]}))};
  async function artifacts(page,metadata,base){
   metadata.inputs={...metadata.inputs,draft_sha256:digest(page.files.get(rootPath+'report.json'))};
   const meta=Buffer.from(JSON.stringify(metadata)),ready=page.report.articles.flatMap(a=>PAGE_CHECKS[a.id]),pending=REQUIRED_RESEARCH_CHECKS.filter(c=>!ready.includes(c));
   const host=execute(s,command('status',{offset:0})).effective_budget.accounting;
   const audit=auditSummary({schema_version:'1.4',readiness:pending.length?'partial':'ready',coverage_checked:ready,coverage_incomplete:pending,coverage_unchecked:pending,page_scope:metadata.page_scope,evidence_metadata_sha256:digest(meta),budget_policy:metadata.budget_policy,limits,budget_accounting:{successful_attempts:host.successful_attempts,failed_attempts:host.failed_attempts,unknown_attempts:host.unknown_attempts,successful_seconds:host.success_seconds,failed_seconds:host.failed_seconds,reserved_unknown_seconds:host.reserved_seconds,charged_seconds:host.success_seconds+host.reserved_seconds}},page.files);
   const bytes=await encodeBundle(page.files,`morning-${DAY.replaceAll('-','')}-r${page.report.revision}`,base,'a'.repeat(40));
   const auditBytes=Buffer.from(JSON.stringify(audit)),archiveHash=archive(s,{'audit.json':meta,'audit-summary.json':auditBytes,'bundle.json':bytes});
   return {bytes,audit,args:{archive_sha256:archiveHash,bundle_sha256:digest(bytes),audit_sha256:digest(auditBytes)}};
  }
  const a=await artifacts(first,metadata,'b'.repeat(40));
  const oldLayoutFiles=new Map([...first.files].map(([path,bytes])=>[path.replace(rootPath,rootPath+'r1/'),bytes]));
  const oldLayout=await encodeBundle(oldLayoutFiles,id,'b'.repeat(40),'a'.repeat(40)),oldSummary=Buffer.from(JSON.stringify(a.audit)),oldMeta=Buffer.from(JSON.stringify(metadata));
  const oldHead=archive(s,{'bundle.json':oldLayout,'audit-summary.json':oldSummary,'audit.json':oldMeta});
  const oldDenied=await issuePermit(s,command('permit',{archive_sha256:oldHead,bundle_sha256:digest(oldLayout),audit_sha256:digest(oldSummary)},run));
  assert.equal(oldDenied.status,'rejected');assert.equal(oldDenied.code,'publication_page_layout_required');assert.equal(oldDenied.run.permit,null);

  // A conventional full-coverage audit must not opt a pending report out of
  // the page metadata/recovery contract by merely omitting page_scope.
  const unscoped=structuredClone(a.audit);delete unscoped.page_scope;delete unscoped.evidence_metadata_sha256;
  unscoped.coverage_checked=[...REQUIRED_RESEARCH_CHECKS];unscoped.coverage_incomplete=[];unscoped.coverage_unchecked=[];unscoped.readiness='ready';
  const unscopedHead=archive(s,{'bundle.json':a.bytes,'audit-summary.json':Buffer.from(JSON.stringify(unscoped))});
  const unscopedCommand=command('permit',{archive_sha256:unscopedHead,bundle_sha256:digest(a.bytes),audit_sha256:digest(Buffer.from(JSON.stringify(unscoped)))},run);
  const unscopedResult=await issuePermit(s,unscopedCommand);assert.equal(unscopedResult.status,'rejected');assert.equal(unscopedResult.code,'publication_page_metadata_required');assert.equal(unscopedResult.run.permit,null);
  assert.equal((await issuePermit(s,unscopedCommand)).replayed,true);
  // A legacy v3 run lacking an explicit recovery grant must not seal a pending
  // package even when its ordinary audit otherwise passes the old contract.
  const legacy=setup();try{
   const legacyRun=start(legacy);installPageAuthority(legacy.db);
   const legacyAudit=auditSummary({},first.files);
   const legacyBytes=Buffer.from(JSON.stringify(legacyAudit));
   const legacyHead=archive(legacy,{'bundle.json':a.bytes,'audit-summary.json':legacyBytes});
   const legacyResult=await issuePermit(legacy,command('permit',{archive_sha256:legacyHead,bundle_sha256:digest(a.bytes),audit_sha256:digest(legacyBytes)},legacyRun));
   assert.equal(legacyResult.status,'rejected');assert.equal(legacyResult.code,'publication_page_recovery_required');assert.equal(legacyResult.run.permit,null);
  }finally{legacy.close();}

  // Missing or structurally unusable metadata must not freeze an unresumable
  // first permit. Each rejection is durable and leaves the original run usable.
  for(const mode of ['missing','null','bad-scope','bad-stages','bad-model']){
   const bad=structuredClone(a.audit);let rawMetadata;
   if(mode==='missing')delete bad.evidence_metadata_sha256;
   else{const m=structuredClone(metadata);if(mode==='null')rawMetadata=Buffer.from('null');else{if(mode==='bad-scope')m.page_scope=null;else if(mode==='bad-model')delete m.model_calls[0].model;else m.model_calls=[];rawMetadata=Buffer.from(JSON.stringify(m));}bad.evidence_metadata_sha256=digest(rawMetadata);}
   const summary=Buffer.from(JSON.stringify(bad)),files={'bundle.json':a.bytes,'audit-summary.json':summary};if(rawMetadata)files['audit.json']=rawMetadata;
   const badHead=archive(s,files),cmd=command('permit',{archive_sha256:badHead,bundle_sha256:digest(a.bytes),audit_sha256:digest(summary)},run);
   const denied=await issuePermit(s,cmd);assert.equal(denied.status,'rejected');assert.equal(denied.code,'publication_page_metadata_required');assert.equal(denied.run.permit,null);
   const replay=await issuePermit(s,cmd);assert.equal(replay.replayed,true);assert.equal(replay.status,'rejected');
  }
  const nullAudit=Buffer.from('null'),nullHead=archive(s,{'bundle.json':a.bytes,'audit-summary.json':nullAudit});
  const nullCommand=command('permit',{archive_sha256:nullHead,bundle_sha256:digest(a.bytes),audit_sha256:digest(nullAudit)},run);
  const nullResult=await issuePermit(s,nullCommand);assert.equal(nullResult.status,'rejected');assert.equal(nullResult.code,'publication_audit_blocked');assert.equal((await issuePermit(s,nullCommand)).replayed,true);
  let result=await issuePermit(s,command('permit',a.args,run));assert.equal(result.status,'committed',result.code);run=result.run;const originalPermit=run.permit;
  const commit='c'.repeat(40),job=s.admit({request_id:id,hash:digest(a.bytes),source_ts:'1793491202.000031'},a.bytes);
  s.move(id,'received','receipt_sent',{commit,proof:{publication_status:'verified',bundle_sha256:job.hash,commit}});
  installScheduledTables(s.db,['scheduled_handoffs','scheduled_bridge_scope']);
  const binding={request_id:id,report_date:DAY,report_commit:commit,bundle_sha256:job.hash};
  s.db.prepare('INSERT INTO scheduled_handoffs VALUES(?,?,?,?,0)').run(id,JSON.stringify(binding),'complete',JSON.stringify({...binding,status:'sent',phase:'complete',parts_sent:2,parts_total:2,images:[{file_id:'scheduled-poster',status:'sent',error:null}]}));
  let previousId=id,previousHash=job.hash;
  for(let revision=2;revision<targetRevision;revision++){
   const r=structuredClone(first.report);r.revision=revision;r.revision_notice={kind:'correction',summary:'已审核纠错'};r.page_delivery={...r.page_delivery,previous:{request_id:previousId,bundle_sha256:previousHash},added:[]};
   const files=new Map(first.files);files.set(rootPath+'report.json',Buffer.from(JSON.stringify(r)));const request_id=id.replace(/r1$/,`r${revision}`),bytes=await encodeBundle(files,request_id,commit,'a'.repeat(40));
   const hash=digest(bytes),ts=`1793491202.${String(100+revision).padStart(6,'0')}`;s.admit({request_id,hash,source_ts:ts},bytes);s.move(request_id,'received','receipt_sent',{commit,proof:{publication_status:'verified',bundle_sha256:hash,commit}});
   const bound={request_id,report_date:DAY,report_commit:commit,bundle_sha256:hash};s.db.prepare('INSERT INTO scheduled_handoffs VALUES(?,?,?,?,0)').run(request_id,JSON.stringify(bound),'complete',JSON.stringify({...bound,status:'sent',phase:'complete',parts_sent:1,parts_total:1,delivery_kind:'revision_update',images:[]}));previousId=request_id;previousHash=hash;
  }
  const completing=targetRevision===6,attemptPages=completing?topicIds.slice(1):['hardware-status','embodied-training'];
  result=execute(s,command('page_begin',{previous_request_id:previousId,added:attemptPages},run));assert.equal(result.status,'committed',result.code);run=result.run;
  const failedSource=source('https://example.org/embodied-missing');
  run=execute(s,command('reserve',{operations:[failedSource]},run)).run;
  const failure=Buffer.from(JSON.stringify({request_id:id,operation_id:failedSource.operation_id,url:failedSource.input.url,status:'failed',elapsed_seconds:2}));
  const failureArchive=archive(s,{'embodied-failure.json':failure});
  run=execute(s,command('settle',{operation_id:failedSource.operation_id,outcome:'acknowledged',elapsed_seconds:2,archive_sha256:failureArchive,file_sha256:digest(failure),native_result:null},run)).run;
  const continued=execute(s,command('status',{offset:0}));assert.equal(continued.effective_budget.accounting.failed_seconds,2);assert.equal(continued.effective_budget.accounting.success_seconds,0);
  const previous=authenticatedPrevious(s.db,s.db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(id),previousId);
  const second=pageBundle(completing?6:2,{request_id:previousId,bundle_sha256:previousHash});if(completing)second.report.page_delivery.added=topicIds.slice(1);second.report.revision=targetRevision;second.files.set(rootPath+'report.json',Buffer.from(JSON.stringify(second.report)));metadata=structuredClone(metadata);metadata.page_scope={...scope(second.report),previous_evidence:previous.evidence};metadata.checks.hardware={status:'checked'};if(completing)for(const k of REQUIRED_RESEARCH_CHECKS)metadata.checks[k]={status:'checked'};
  metadata.sources.push({id:'embodied-failure',status:'failed',operation_id:failedSource.operation_id,archive_sha256:failureArchive});
  for(const call of metadata.model_calls){
   call.attempt_records.push({outcome:'success',elapsed_seconds:0,page_round:{revision:targetRevision,page_ids:attemptPages,previous_audit_sha256:a.args.audit_sha256}});
  }
  const publicationBase='e'.repeat(40),b=await artifacts(second,metadata,publicationBase),target=id.replace(/r1$/,`r${targetRevision}`);
  if(completing){
   assert.deepEqual(second.report.page_delivery.pending,[]);
   for(const mode of ['no-scope','missing-metadata']){
    const bad=structuredClone(b.audit);bad.readiness='ready';
    if(mode==='no-scope')delete bad.page_scope;
    delete bad.evidence_metadata_sha256;
    const summary=Buffer.from(JSON.stringify(bad)),head=archive(s,{'bundle.json':b.bytes,'summary.json':summary});
    const denied=await issuePermit(s,command('page_permit',{publication_request_id:target,archive_sha256:head,bundle_sha256:digest(b.bytes),audit_sha256:digest(summary)},run));
    assert.equal(denied.status,'rejected');assert.equal(denied.code,mode==='no-scope'?'publication_page_metadata_required':'publication_coverage_contract');assert.equal(denied.page_round?.permit??null,null);
   }
  }
  result=await issuePermit(s,command('page_permit',{publication_request_id:target,...b.args},run));
  assert.equal(result.status,'committed',result.code);assert.deepEqual(result.run.permit,originalPermit);assert.equal(JSON.parse(result.page_round.permit).request_id,target);assert.deepEqual(JSON.parse(result.page_round.permit).page_ids,completing?topicIds.slice(1):['hardware-status']);
  if(!completing)assert.ok(second.report.page_delivery.pending.some(p=>p.id==='embodied-training'));assert.equal(result.run.charged_seconds,run.charged_seconds);
  const roundPermit=JSON.parse(result.page_round.permit),upload=execute(s,{...command('upload_status',{archive_sha256:b.args.archive_sha256,permit_id:roundPermit.permit_id}),owner_id:null});
  assert.equal(upload.permit.request_id,target);assert.deepEqual(upload.operations,[]);
  run=result.run;const hash=digest(b.bytes),permit=roundPermit.permit_id;
  for(const step of ['ticket','post','complete']){
   const input={archive_sha256:b.args.archive_sha256,permit_id:permit,step,file_id:step==='ticket'?null:'FPAGE',source_ts:null,bytes:b.bytes.length,sha256:hash};
   const op={operation_id:randomUUID(),kind:'native',key:'permit:'+permit+':'+step,input_sha256:digest(Buffer.from(JSON.stringify(input))),input,max_seconds:0};
   result=execute(s,command('reserve',{operations:[op]},run));assert.equal(result.dispatch_granted,true,result.code);run=result.run;
   if(step==='complete')break;
   run=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:null,file_sha256:null,native_result:{file_id:'FPAGE',source_ts:null,sha256:hash,bytes:b.bytes.length}},run)).run;
  }
  const correction=structuredClone(first.report);correction.revision=targetRevision;correction.revision_notice={kind:'correction',summary:'Concurrent correction'};correction.page_delivery={...correction.page_delivery,previous:{request_id:previousId,bundle_sha256:previousHash},added:[]};const correctionFiles=new Map(first.files);correctionFiles.set(rootPath+'report.json',Buffer.from(JSON.stringify(correction)));const correctionBytes=await encodeBundle(correctionFiles,target,publicationBase,'a'.repeat(40));
  const raced=message(`!ai-report revise ${target} ${digest(correctionBytes)}`,'1793491202.900001','FCORRECTION');
  const stage=message(`!ai-report stage-v2 ${target} ${hash} ${permit}`,'1793491203.000001','FPAGE'),messages=[raced,stage];
  const slack={historyPage:async({from,to})=>({messages:messages.filter(m=>m.ts>=from&&m.ts<=to),next_cursor:null}),exactPublish:async ts=>messages.find(m=>m.ts===ts),download:async row=>row.file_id==='FCORRECTION'?correctionBytes:b.bytes};
  const inbox=new PublisherInbox(s,config);await inbox.scan(slack,now);await advanceSubmission(s,config,slack,()=>assert.fail('No date lookup'),now);assert.equal(s.db.prepare('SELECT phase FROM slack_submission_events WHERE source_ts=?').get(raced.ts).phase,'fenced');assert.equal(s.metadata(target),null);await advanceSubmission(s,config,slack,()=>assert.fail('successor must not require empty date'),now);
  assert.equal(s.db.prepare('SELECT phase FROM research_page_staged WHERE request_id=?').get(target)?.phase,'staged');
  assert.equal(s.db.prepare('SELECT count(*) n FROM slack_staged_bundles').get().n,0);
  run=execute(s,command('status',{offset:0})).run;
  const input={archive_sha256:b.args.archive_sha256,permit_id:permit,step:'submit',file_id:'FPAGE',source_ts:stage.ts,bytes:b.bytes.length,sha256:hash};
  const op={operation_id:randomUUID(),kind:'native',key:'permit:'+permit+':submit',input_sha256:digest(Buffer.from(JSON.stringify(input))),input,max_seconds:0};
  assert.equal(execute(s,command('reserve',{operations:[op]},run)).dispatch_granted,true);
  messages.push(message(`!ai-report submit-v2 ${target} ${hash} ${stage.ts} ${permit}`,'1793491211.000001'));
  await inbox.scan(slack,now+2000);await advanceSubmission(s,config,slack,()=>assert.fail('successor must not require empty date'),now+2000);
  assert.equal(s.metadata(target)?.hash,hash);assert.equal(s.db.prepare('SELECT count(*) n FROM jobs').get().n,targetRevision);
  assert.equal(s.db.prepare('SELECT phase FROM research_page_staged WHERE request_id=?').get(target).phase,'admitted');
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_control_runs').get().n,1);
  const {inspectPublisherDay}=await import('../scripts/producer-inspect.mjs');
  for(const [request_id,bundle_sha256] of [[id,job.hash],[target,hash]]){
   const inspect={kind:'inspect',request_id,report_date:DAY,bundle_sha256,query_id:randomUUID()};const result=await inspectPublisherDay(s,config,inspect,'1793491212.000001');assert.equal(result.publisher.request_id,request_id);assert.equal(result.publisher_day.length,targetRevision);
  }
  s.db.prepare("UPDATE research_page_staged SET phase='staged' WHERE request_id=?").run(target);
  await assert.rejects(inspectPublisherDay(s,config,{kind:'inspect',request_id:id,report_date:DAY,bundle_sha256:job.hash,query_id:randomUUID()},'1793491213.000001'),/Date reserved/);

 }finally{s.close();}
});

test('inbox dispatch batch checks authority without decoding historical archives per operation',async()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const old=source('https://example.org/dispatch-history');
  run=execute(s,command('reserve',{operations:[old]},run)).run;
  const data=Buffer.from(JSON.stringify({request_id:id,operation_id:old.operation_id,url:old.input.url,status:'ok',elapsed_seconds:1}));
  const head=archive(s,{'result.json':data,'body.txt':Buffer.alloc(8*1024*1024,65)});
  s.db.prepare("UPDATE research_control_ops SET phase='acknowledged',elapsed_seconds=1,result_archive=?,result_file=? WHERE operation_id=?").run(head,digest(data),old.operation_id);
  const ops=Array.from({length:8},(_,i)=>source('https://example.org/batch-dispatch/'+i));
  queue(s,command('reserve',{operations:ops},run));
  const parse=JSON.parse;let decodes=0,reply;
  JSON.parse=function(value,...args){if(typeof value==='string'&&value.startsWith('{"schema_version":"research_archive_v1",'))decodes++;return parse(value,...args);};
  try{
   await advanceResearchControl(s,config,{controlReceipt:async(_ts,text)=>{reply=parse(text.slice('!ai-research control-receipt '.length));return '1793491209.000001';}},now);
   assert.equal(reply.dispatch_granted,true);assert.equal(reply.operations.length,8);assert.equal(decodes,1,'only command accounting reads archive, dispatch uses authority/window');
   const actual=s.db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(id);
   for(const op of ops){const original=s.db.prepare('SELECT * FROM research_control_ops WHERE operation_id=?').get(op.operation_id);assert.equal(researchOperationDispatchValid(s.db,actual,original,now),true);assert.equal(researchOperationDispatchValid(s.db,actual,original,now+3600000),false);}
   assert.equal(decodes,1,'direct dispatch checks do not classify historic results');
  }finally{JSON.parse=parse;}
 }finally{s.close();}
});

test('v4 original withheld intent survives explicit grant activation with one operation and no refunded charge',()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const op=source('editor','model'),cmd=command('reserve',{operations:[op]},run),result=execute(s,cmd);run=result.run;
  const original=s.db.prepare('SELECT * FROM research_control_ops').get();
  const reply='!ai-research control-receipt '+JSON.stringify({...result,dispatch_granted:false,grant_expired:true});
  s.db.prepare('INSERT INTO research_control_events VALUES(?,?,?,?,?,?,?,?,?,?)').run('1793491201.999999',cmd.command_id,digest(Buffer.from(JSON.stringify(cmd))),Buffer.from(JSON.stringify(cmd)),'sent',1,0,reply,'1793491202.999999',null);
  const grant={schema_version:'research_recovery_grant_v1',grant_id:randomUUID(),request_id:id,generation:config.research_control.generation,plan_hash:run.plan_hash,previous_sha256:null,authorization_reference:'synthetic owner approval',effective_not_before:nextResearchContinuationAt(now),window_seconds:3600,failed_attempts_consume_success_budget:false,continuation_policy:'hourly_20_until_complete'};
  const bytes=Buffer.from(JSON.stringify(grant));approveResearchRecoveryGrant(s.db,bytes,grant.authorization_reference,now);
  run=execute(s,command('recovery_grant',{grant_base64:bytes.toString('base64')},run)).run;
  const later=grant.effective_not_before;run=execute(s,command('claim',{plan_base64:layeredPlan().toString('base64')},run),later).run;
  const resumed=execute(s,command('resume',{operation_id:op.operation_id},run),later);
  assert.equal(resumed.status,'committed');assert.equal(resumed.dispatch_granted,true);assert.equal(resumed.run.charged_seconds,180);
  assert.deepEqual(s.db.prepare('SELECT * FROM research_control_ops').get(),original);
  assert.equal(s.db.prepare('SELECT count(*) n FROM research_recovery_operations').get().n,2);
  const actual=s.db.prepare('SELECT * FROM research_control_runs').get();assert.equal(researchOperationDispatchValid(s.db,actual,original,later),true);
  s.db.prepare("UPDATE research_control_events SET phase='unknown'").run();
  assert.equal(execute(s,command('resume',{operation_id:op.operation_id},resumed.run),later).code,'resume_dispatch_not_proven_unstarted');
 }finally{s.close();}
});

test('full ready schema 1.2 still requires installed page decoder authority without changing v3 budget',async()=>{
 const s=setup();try{
  const run=start(s),files=new Map([...FILES].map(([p,b])=>[p.replace('/r1/','/'),b]));
  const path=[...files.keys()].find(p=>p.endsWith('/report.json')),report=JSON.parse(files.get(path));
  report.schema_version='1.2';report.page_delivery={previous:null,added:report.articles.map(a=>a.id),pending:[]};files.set(path,Buffer.from(JSON.stringify(report)));
  const bytes=await encodeBundle(files,id,'b'.repeat(40),'a'.repeat(40)),audit=Buffer.from(JSON.stringify(auditSummary({readiness:'ready'},files)));
  const hash=archive(s,{'bundle.json':bytes,'audit.json':audit}),args={archive_sha256:hash,bundle_sha256:digest(bytes),audit_sha256:digest(audit)};
  const before=s.db.prepare('SELECT plan FROM research_control_runs WHERE request_id=?').get(id).plan;
  const result=await issuePermit(s,command('permit',args,run));
  assert.equal(result.status,'rejected');assert.equal(result.code,'publication_page_authority_required');assert.equal(result.run.permit,null);
  assert.deepEqual(s.db.prepare('SELECT plan FROM research_control_runs WHERE request_id=?').get(id).plan,before);
  installPageAuthority(s.db);
  assert.equal((await issuePermit(s,command('permit',args,result.run))).status,'committed');
  assert.deepEqual(s.db.prepare('SELECT plan FROM research_control_runs WHERE request_id=?').get(id).plan,before);
 }finally{s.close();}
});

test('expired undispatched source remains charged but admits a fresh bounded retry',async()=>{
 const single=JSON.parse(layeredPlan());single.limits.max_attempts_per_source=1;
 for(const inputPlan of [plan,layeredPlan(),Buffer.from(JSON.stringify(single))]){const s=setup();try{
  let run=start(s,inputPlan);const op=source('https://example.org/changes?b=2&a=1'),c=command('reserve',{operations:[op]},run);queue(s,c);
  const receipt='1793491210.000001';
  await advanceResearchControl(s,config,{controlReceipt:async()=>receipt},now);
  run=execute(s,command('status',{offset:0}),now+70000).run;
  const observation=Buffer.from(JSON.stringify({artifact_kind:'local_dispatch_observation_not_settlement',request_id:id,status:'not_dispatched_grant_expired',dispatch_started:false,source_requests:0,operation_ids:[op.operation_id],command_id:c.command_id,receipt_ts:receipt,observed_at:new Date(now+65000).toISOString()}));
  const result=Buffer.from(JSON.stringify({schema_version:'source_not_dispatched_v1',request_id:id,operation_id:op.operation_id,url:op.input.url,input_sha256:op.input_sha256,status:'not_dispatched',dispatch_started:false,source_requests:0,elapsed_seconds:null,reserved_seconds:op.max_seconds,observation_sha256:digest(observation),grant_command_id:c.command_id,grant_receipt_ts:receipt}));
  const hash=archive(s,{'observation.json':observation,'result.json':result});
  const settled=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:hash,file_sha256:digest(result),native_result:null},run),now+70000);
  assert.equal(settled.status,'committed');assert.equal(settled.run.charged_seconds,180);
  assert.equal(settled.cancellation_settlement_version,inputPlan===plan?undefined:1);
  const storedSettlement=s.db.prepare('SELECT bytes,result FROM research_control_commands WHERE command_id=?').get(settled.command_id);
  assert.equal(JSON.parse(storedSettlement.result).cancellation_settlement_version,inputPlan===plan?undefined:1);
  const parsedSettlement=await nativeFixtureControl(s)(Buffer.from(storedSettlement.bytes));assert.equal(parsedSettlement.cancellation_settlement_version,inputPlan===plan?undefined:1);
  const status=execute(s,command('status',{offset:0}),now+70000);
  if(status.effective_budget){assert.equal(status.effective_budget.accounting.reserved_seconds,180);
  assert.equal(status.effective_budget.accounting.unknown_attempts.source,1);
  assert.equal(status.effective_budget.accounting.failed_attempts.source,0);}
  const replay=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:hash,file_sha256:digest(result),native_result:null},settled.run),now+70000);
  assert.equal(replay.code,'operation_unsettled');
  assert.equal(execute(s,command('resume',{operation_id:op.operation_id},settled.run),now+70000).code,'resume_original_intent');
  const retried=execute(s,command('reserve',{operations:[source('https://example.org/changes?a=1&b=2')]},settled.run),now+70000);
  if(JSON.parse(inputPlan).limits.max_attempts_per_source===1){assert.equal(retried.code,'attempt_budget');assert.equal(retried.run.charged_seconds,180);continue;}
  assert.equal(retried.status,'committed');assert.equal(retried.run.charged_seconds,360);
  assert.equal(execute(s,command('reserve',{operations:[source('https://example.org/changes?a=1&b=2')]},retried.run),now+70000).code,inputPlan===plan?'attempt_budget':'research_original_result_unknown');
  if(inputPlan===plan){
   const retry=retried.operations[0],bytes=Buffer.from(JSON.stringify({request_id:id,operation_id:retry.operation_id,url:'https://example.org/changes?a=1&b=2',status:'ok',elapsed_seconds:10}));
   const retryArchive=archive(s,{'result.json':bytes});
   const complete=execute(s,command('settle',{operation_id:retry.operation_id,outcome:'acknowledged',elapsed_seconds:10,archive_sha256:retryArchive,file_sha256:digest(bytes),native_result:null},retried.run),now+70000);
   assert.equal(complete.status,'committed');assert.equal(complete.run.charged_seconds,190);
   const bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40)),audit=Buffer.from(JSON.stringify(auditSummary()));
   const h=archive(s,{'bundle.json':bundle,'audit.json':audit});
   const answer=await issuePermit(s,command('permit',{archive_sha256:h,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},complete.run));
   assert.equal(answer.status,'committed');assert.equal(answer.cancellation_page_version,undefined);assert.equal(answer.run.charged_seconds,190);
  }
 }finally{s.close();}}
});

test('no-dispatch settlement rejects missing, mismatched, unexpired or future declarations',async()=>{
 for(const mutation of ['missing','null','array','timestamp-object','missing-command','missing-receipt','command','receipt','operation','input','dispatched','requests','elapsed','unexpired','future','native']){
  const s=setup();try{
   let run=start(s,layeredPlan());const op=source(),c=command('reserve',{operations:[op]},run);queue(s,c);
   const receipt='1793491210.000001';await advanceResearchControl(s,config,{controlReceipt:async()=>receipt},now);
   run=execute(s,command('status',{offset:0}),now+70000).run;
   const obs={artifact_kind:'local_dispatch_observation_not_settlement',request_id:id,status:'not_dispatched_grant_expired',dispatch_started:false,source_requests:0,operation_ids:[op.operation_id],command_id:c.command_id,receipt_ts:receipt,observed_at:new Date(now+65000).toISOString()};
   if(mutation==='unexpired')obs.observed_at=new Date(now+50000).toISOString();
   if(mutation==='future')obs.observed_at=new Date(now+80000).toISOString();
   if(mutation==='timestamp-object')obs.observed_at={toString:null};
   if(mutation==='missing-command')delete obs.command_id;if(mutation==='missing-receipt')delete obs.receipt_ts;
   const observation=Buffer.from(JSON.stringify(mutation==='null'?null:mutation==='array'?[]:obs));
   const value={schema_version:'source_not_dispatched_v1',request_id:id,operation_id:op.operation_id,url:op.input.url,input_sha256:op.input_sha256,status:'not_dispatched',dispatch_started:false,source_requests:0,elapsed_seconds:null,reserved_seconds:op.max_seconds,observation_sha256:digest(observation),grant_command_id:c.command_id,grant_receipt_ts:receipt};
   if(mutation==='missing-command')delete value.grant_command_id;if(mutation==='missing-receipt')delete value.grant_receipt_ts;
   if(mutation==='command')value.grant_command_id=randomUUID();if(mutation==='receipt')value.grant_receipt_ts='1793491209.000001';
   if(mutation==='operation')value.operation_id=randomUUID();if(mutation==='input')value.input_sha256='e'.repeat(64);
   if(mutation==='dispatched')value.dispatch_started=true;if(mutation==='requests')value.source_requests=1;
   if(mutation==='elapsed')value.elapsed_seconds=0;if(mutation==='native')value.schema_version='native_not_dispatched_v1';
   const result=Buffer.from(JSON.stringify(value)),files={'result.json':result};if(mutation!=='missing')files['observation.json']=observation;
   const hash=archive(s,files),settled=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:hash,file_sha256:digest(result),native_result:null},run),now+70000);
   assert.equal(settled.status,'rejected',mutation);assert.equal(settled.run.charged_seconds,180,mutation);
   assert.equal(s.db.prepare('SELECT phase FROM research_control_ops WHERE operation_id=?').get(op.operation_id).phase,'intent',mutation);
  }finally{s.close();}
 }
});


test('no-dispatch expiry honors the original embedded lease after current owner renewal',async()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const op=source(),c=command('reserve',{operations:[op]},run);queue(s,c);
  const receipt=String((now+899000)/1000)+'.000001';
  await advanceResearchControl(s,config,{assertReady:()=>{throw Error('synthetic cooldown');}},now);
  await advanceResearchControl(s,config,{controlReceipt:async()=>receipt},now+899000);
  run=execute(s,command('status',{offset:0}),now+899500).run;
  run=execute(s,command('renew',{},run),now+899500).run;
  const observed=now+901000,originalGrant=Buffer.from(s.db.prepare('SELECT reply_text FROM research_control_events WHERE command_id=?').get(c.command_id).reply_text);
  const observation=Buffer.from(JSON.stringify({artifact_kind:'local_dispatch_observation_not_settlement',request_id:id,status:'not_dispatched_grant_expired',dispatch_started:false,source_requests:0,operation_ids:[op.operation_id],command_id:c.command_id,receipt_ts:receipt,observed_at:new Date(observed).toISOString()}));
  const result=Buffer.from(JSON.stringify({schema_version:'source_not_dispatched_v1',request_id:id,operation_id:op.operation_id,url:op.input.url,input_sha256:op.input_sha256,status:'not_dispatched',dispatch_started:false,source_requests:0,elapsed_seconds:null,reserved_seconds:op.max_seconds,observation_sha256:digest(observation),grant_command_id:c.command_id,grant_receipt_ts:receipt,grant_receipt_sha256:digest(originalGrant)}));
  const missing=archive(s,{'observation.json':observation,'result.json':result});
  assert.equal(execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:missing,file_sha256:digest(result),native_result:null},run),observed).code,'source_not_dispatched_evidence');
  const hash=archive(s,{'observation.json':observation,'result.json':result,'grant.txt':originalGrant});
  const settled=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:hash,file_sha256:digest(result),native_result:null},run),observed);
  assert.equal(settled.status,'committed',JSON.stringify(settled));assert.equal(settled.run.charged_seconds,180);
 }finally{s.close();}
});

function continuationFixture(status='partial',earlySource=false,oldBody=false,originalOverride=null,priorResultChanges={},extraArtifacts={}){
 const s=setup(),p=JSON.parse(layeredPlan());p.model_stages=['research','editor','review'];let run=start(s,Buffer.from(JSON.stringify(p)));
 const added=source();if(earlySource)run=execute(s,command('reserve',{operations:[added]},run)).run;
 const originalInput=Buffer.from(JSON.stringify(originalOverride??{request_id:id,stage:'editor',sources:oldBody?[{body_sha256:digest(Buffer.from('new original source body'))}]:[],research:{result_sha256:'a'.repeat(64),outputs:[{sha256:'b'.repeat(64)}]}}));
 const first={...source('editor','model'),max_seconds:600,input_sha256:digest(originalInput)};
 if(originalOverride?.operation_id)first.operation_id=originalOverride.operation_id;
 run=execute(s,command('reserve',{operations:[first]},run)).run;
 const result=Buffer.from(JSON.stringify({request_id:id,operation_id:first.operation_id,stage:'editor',input_sha256:first.input_sha256,status,elapsed_seconds:400,...priorResultChanges}));
 const head=archive(s,{'stage_artifacts/prior.json':result});
 run=execute(s,command('settle',{operation_id:first.operation_id,outcome:'acknowledged',elapsed_seconds:400,archive_sha256:head,file_sha256:digest(result),native_result:null},run)).run;
 if(!earlySource)run=execute(s,command('reserve',{operations:[added]},run)).run;
 const content=Buffer.from('new original source body');
 const body=Buffer.from(JSON.stringify({request_id:id,operation_id:added.operation_id,input_sha256:added.input_sha256,url:added.input.url,status:'ok',elapsed_seconds:10,response_complete:true,curl_exit_code:0,error:'',http_status:200,content_sha256:digest(content)}));
 const addedHead=archive(s,{'stage_artifacts/new-source.json':body,'stage_artifacts/source-body.txt':content});
 run=execute(s,command('settle',{operation_id:added.operation_id,outcome:'acknowledged',elapsed_seconds:10,archive_sha256:addedHead,file_sha256:digest(body),native_result:null},run)).run;
 const payloadValue={request_id:id,stage:'editor',sources:[{operation_id:added.operation_id,result_sha256:digest(body),body_sha256:digest(content)}]};
 const manifest={schema_version:'model_prepublication_continuation_v1',request_id:id,stage:'editor',previous_operation_id:first.operation_id,checkpoint_archive_sha256:head,checkpoint_file_sha256:digest(result),payload_sha256:'0'.repeat(64),added_evidence:[{operation_id:added.operation_id,archive_sha256:addedHead,file_sha256:digest(body)}]};
 function next(changes={},payloadChanges={}){
  const m={...manifest,...changes};
  const payload=Buffer.from(JSON.stringify({...payloadValue,continuation:{previous_operation_id:m.previous_operation_id,checkpoint_archive_sha256:m.checkpoint_archive_sha256,checkpoint_file_sha256:m.checkpoint_file_sha256,added_evidence:m.added_evidence},...payloadChanges}));
  if(!('payload_sha256' in changes))m.payload_sha256=digest(payload);
  const data=Buffer.from(JSON.stringify(m));
  const nextHead=archive(s,{'stage_artifacts/continuation.json':data,'stage_artifacts/new-input.txt':payload,'stage_artifacts/original-input.json':originalInput,...extraArtifacts});
  return {...source('editor','model'),max_seconds:800,input_sha256:digest(data),input:{previous_operation_id:first.operation_id,checkpoint_archive_sha256:head,checkpoint_file_sha256:digest(result),continuation_archive_sha256:nextHead}};
 }
 return {s,run,first,added,manifest,next,originalInput,content};
}
test('editor continuation reads a bound findings inventory before classifying new content',()=>{
 for(const repeated of [false,true]){
  const common={request_id:id,operation_id:randomUUID(),stage:'research',input_sha256:'a'.repeat(64)};
  const record={operation_id:randomUUID(),input_sha256:'b'.repeat(64),result_sha256:'c'.repeat(64),body_sha256:digest(Buffer.from(repeated?'new original source body':'prior bytes'))};
  const findings=Buffer.from(JSON.stringify({...common,source_records:{prior:record}}));
  const outputs=[{name:'findings.json',sha256:digest(findings)}];
  const research=Buffer.from(JSON.stringify({...common,outputs,status:'partial',elapsed_seconds:1}));
  const original={request_id:id,stage:'editor',operation_id:randomUUID(),source_records_location:'findings.json#/source_records',source_attempt_count:1,
   research:{operation_id:common.operation_id,input_sha256:common.input_sha256,result_sha256:digest(research),outputs,status:'partial',elapsed_seconds:1,started_at:'retained'}};
  const f=continuationFixture('ok',false,false,original,{}, {'stage_artifacts/findings.json':findings,'stage_artifacts/research.json':research});
  try{
   const op=f.next({},{research:original.research});
   const answer=execute(f.s,command('reserve',{operations:[op]},f.run));
   if(repeated)assert.equal(answer.code,'model_continuation_no_new_content');
   else assert.equal(answer.status,'committed',JSON.stringify(answer));
  }finally{f.s.close();}
 }
});
test('prepublication continuation preserves successful results and cumulative stage budget',()=>{
 for(const status of ['partial','ok']){
  const f=continuationFixture(status);try{
   const original=authorityRows(f.s).research_control_ops,op=f.next();
   assert.equal(execute(f.s,command('reserve',{operations:[{...op,max_seconds:801}]},f.run)).code,'model_stage_budget');
   assert.deepEqual(authorityRows(f.s).research_control_ops,original);
   const result=execute(f.s,command('reserve',{operations:[op]},f.run));assert.equal(result.status,'committed');
   assert.equal(result.run.charged_seconds,1210);
   const old=f.s.db.prepare('SELECT * FROM research_control_ops WHERE operation_id=?').get(f.first.operation_id);
   assert.equal(old.phase,'acknowledged');assert.equal(old.elapsed_seconds,400);
   const unknownResult=execute(f.s,command('reserve',{operations:[f.next()]},result.run));
   assert.equal(unknownResult.code,'model_recovery_original');
  }finally{f.s.close();}
 }
});
test('prepublication continuation authenticates new bytes and refuses missing or substituted evidence',()=>{
 for(const mutation of [
  {stage:'review'}, {request_id:'morning-20261102-r1'}, {payload_sha256:'f'.repeat(64)},
  {added_evidence:[]}, {added_evidence:[{operation_id:randomUUID(),archive_sha256:'a'.repeat(64),file_sha256:'b'.repeat(64)}]},
 ]){
  const f=continuationFixture();try{
   const before=authorityRows(f.s).research_control_ops,op=f.next(mutation),result=execute(f.s,command('reserve',{operations:[op]},f.run));
   assert.equal(result.status,'rejected');assert.match(result.code,/model_continuation_/);assert.deepEqual(authorityRows(f.s).research_control_ops,before);
  }finally{f.s.close();}
 }
 const f=continuationFixture();try{
  const op=f.next({added_evidence:[f.manifest.added_evidence[0],f.manifest.added_evidence[0]]});
  assert.equal(execute(f.s,command('reserve',{operations:[op]},f.run)).code,'model_continuation_evidence');
  const absent={...f.next(),input_sha256:'f'.repeat(64)};
  assert.equal(execute(f.s,command('reserve',{operations:[absent]},f.run)).code,'model_continuation_manifest');
  f.s.db.prepare("UPDATE research_control_ops SET phase='unknown' WHERE operation_id=?").run(f.added.operation_id);
  assert.equal(execute(f.s,command('reserve',{operations:[f.next()]},f.run)).code,'model_continuation_new_evidence');
 }finally{f.s.close();}
});
test('prepublication continuation cannot relabel failure as new successful work',()=>{
 const f=continuationFixture('failed');try{
  assert.equal(execute(f.s,command('reserve',{operations:[f.next()]},f.run)).code,'model_continuation_prior_success');
 }finally{f.s.close();}
});

test('continuation refuses previously available evidence and preserves global budget',()=>{
 const old=continuationFixture('partial',true);try{
  assert.equal(execute(old.s,command('reserve',{operations:[old.next()]},old.run)).code,'model_continuation_new_evidence');
 }finally{old.s.close();}
 const f=continuationFixture();try{
  // Other work consumes the original global allowance, without changing stage quota.
  const extra={...source('review','model'),max_seconds:1200};
  let run=execute(f.s,command('reserve',{operations:[extra]},f.run)).run;
  const result=Buffer.from(JSON.stringify({request_id:id,operation_id:extra.operation_id,status:'ok',elapsed_seconds:2800}));
  const head=archive(f.s,{'stage_artifacts/other.json':result});
  run=execute(f.s,command('settle',{operation_id:extra.operation_id,outcome:'acknowledged',elapsed_seconds:2800,archive_sha256:head,file_sha256:digest(result),native_result:null},run)).run;
  assert.equal(execute(f.s,command('reserve',{operations:[f.next()]},run)).code,'time_budget');
 }finally{f.s.close();}
});

test('continuation requires stored nonempty source body, not a JSON success label',()=>{
 const f=continuationFixture();try{
  const data=Buffer.from(JSON.stringify({request_id:id,operation_id:f.added.operation_id,input_sha256:f.added.input_sha256,url:f.added.input.url,status:'ok',elapsed_seconds:10}));
  const head=archive(f.s,{'stage_artifacts/empty-source.json':data});
  f.s.db.prepare('UPDATE research_control_ops SET result_archive=?,result_file=? WHERE operation_id=?').run(head,digest(data),f.added.operation_id);
  const op=f.next({added_evidence:[{operation_id:f.added.operation_id,archive_sha256:head,file_sha256:digest(data)}]});
  assert.equal(execute(f.s,command('reserve',{operations:[op]},f.run)).code,'model_continuation_source_content');
 }finally{f.s.close();}
});

test('publication rechecks accumulated successful model time after continuation overrun',async()=>{
 for(const elapsed of [800,900]){
  const f=continuationFixture();try{
   const second=f.next();let run=execute(f.s,command('reserve',{operations:[second]},f.run)).run;
   const data=Buffer.from(JSON.stringify({request_id:id,operation_id:second.operation_id,stage:'editor',input_sha256:second.input_sha256,status:'ok',elapsed_seconds:elapsed}));
   const head=archive(f.s,{'stage_artifacts/continued-result.json':data});
   run=execute(f.s,command('settle',{operation_id:second.operation_id,outcome:'acknowledged',elapsed_seconds:elapsed,archive_sha256:head,file_sha256:digest(data),native_result:null},run)).run;
   const bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40)),total=410+elapsed;
   const a=auditSummary({schema_version:'1.4',budget_policy:LAYERED_BUDGET_POLICY,limits:{source_attempts:2,model_attempts:2,source_attempt_seconds:180,model_stage_seconds:1200,run_seconds:3600},budget_accounting:{successful_attempts:{source:1,model:2},failed_attempts:{source:0,model:0},unknown_attempts:{source:0,model:0},successful_seconds:total,failed_seconds:0,reserved_unknown_seconds:0,charged_seconds:total}});
   for(const scenario of elapsed===800?['missing','foreign','input','result','checkpoint','reserved','elapsed','prior','extra','future','valid']:['valid']){
    const proof=Buffer.from(JSON.stringify({schema_version:'model_prepublication_continuation_evidence_v1',operation_id:scenario==='foreign'?randomUUID():second.operation_id,control_commands:[],source_attempts:[]}));
    const attempts=[{status:'partial',input_sha256:f.first.input_sha256,result_sha256:f.manifest.checkpoint_file_sha256,reserved_seconds:600,elapsed_seconds:400},{status:'ok',input_sha256:second.input_sha256,result_sha256:digest(data),checkpoint_sha256:f.manifest.checkpoint_file_sha256,reserved_seconds:800,elapsed_seconds:elapsed,...(scenario==='missing'?{}:{prepublication_continuation_sha256:digest(proof)})}];
    if(scenario==='input')attempts[1].input_sha256='f'.repeat(64);if(scenario==='result')attempts[1].result_sha256='f'.repeat(64);if(scenario==='checkpoint')attempts[1].checkpoint_sha256='f'.repeat(64);
    if(scenario==='reserved')attempts[1].reserved_seconds=799;if(scenario==='elapsed')attempts[1].elapsed_seconds=799;if(scenario==='prior')attempts[0].result_sha256='f'.repeat(64);if(scenario==='extra')attempts.push({...attempts[1]});if(scenario==='future')attempts.push({...attempts[1],prepublication_continuation_sha256:undefined,page_round:{revision:2}});
    const metadata=Buffer.from(JSON.stringify({sources:[],model_calls:[{stage:'editor',attempt_records:attempts}]}));
    const audit=Buffer.from(JSON.stringify({...a,evidence_metadata_sha256:digest(metadata)})),h=archive(f.s,{'bundle.json':bundle,'audit.json':audit,'metadata.json':metadata,'proof.json':proof});
    const result=await issuePermit(f.s,command('permit',{archive_sha256:h,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},run));
    if(elapsed===900)assert.equal(result.code,'publication_model_stage_budget');else if(scenario==='valid')assert.equal(result.status,'committed');else assert.equal(result.code,'publication_model_continuation_binding',scenario);
   }
  }finally{f.s.close();}
 }
});

test('publication retains ordinary model missing timing at its original reservation',async()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const op={...source('editor','model'),max_seconds:600};run=execute(s,command('reserve',{operations:[op]},run)).run;
  const d=Buffer.from(JSON.stringify({request_id:id,operation_id:op.operation_id,stage:'editor',input_sha256:op.input_sha256,status:'ok',elapsed_seconds:null}));const h=archive(s,{'result.json':d});
  run=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:h,file_sha256:digest(d),native_result:null},run)).run;
  const b=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40));const a=Buffer.from(JSON.stringify(auditSummary({schema_version:'1.4',budget_policy:LAYERED_BUDGET_POLICY,limits:{source_attempts:2,model_attempts:2,source_attempt_seconds:180,model_stage_seconds:1200,run_seconds:3600},budget_accounting:{successful_attempts:{source:0,model:0},failed_attempts:{source:0,model:0},unknown_attempts:{source:0,model:1},successful_seconds:0,failed_seconds:0,reserved_unknown_seconds:600,charged_seconds:600}})));const ah=archive(s,{'bundle.json':b,'audit.json':a});
  assert.equal((await issuePermit(s,command('permit',{archive_sha256:ah,bundle_sha256:digest(b),audit_sha256:digest(a)},run))).status,'committed');
 }finally{s.close();}
});

test('legacy recovery continuation is durably rejected without parsing body-bound results',()=>{
 const s=setup();try{
  let run=start(s);installResearchRecovery(s.db,'synthetic legacy recovery');
  const grant={schema_version:'research_recovery_grant_v1',grant_id:randomUUID(),request_id:id,generation:config.research_control.generation,plan_hash:run.plan_hash,previous_sha256:null,authorization_reference:'synthetic approval',effective_not_before:nextResearchContinuationAt(now),window_seconds:3600,failed_attempts_consume_success_budget:false,continuation_policy:'hourly_20_until_complete'};
  const bytes=Buffer.from(JSON.stringify(grant));approveResearchRecoveryGrant(s.db,bytes,grant.authorization_reference,now);
  run=execute(s,command('recovery_grant',{grant_base64:bytes.toString('base64')},run)).run;
  const later=grant.effective_not_before;run=execute(s,command('claim',{plan_base64:plan.toString('base64')},run),later).run;
  const first=source('editor','model');run=execute(s,command('reserve',{operations:[first]},run),later).run;
  const result=Buffer.from(JSON.stringify({request_id:id,operation_id:first.operation_id,status:'partial',elapsed_seconds:10}));
  const h=archive(s,{'stage_artifacts/legacy-prior.json':result});
  run=execute(s,command('settle',{operation_id:first.operation_id,outcome:'acknowledged',elapsed_seconds:10,archive_sha256:h,file_sha256:digest(result),native_result:null},run),later).run;
  const op={...source('editor','model'),input:{previous_operation_id:first.operation_id,checkpoint_archive_sha256:h,checkpoint_file_sha256:digest(result),continuation_archive_sha256:h}};
  const c=command('reserve',{operations:[op]},run),rejected=execute(s,c,later);
  assert.equal(rejected.code,'model_continuation_layered_plan');assert.equal(rejected.status,'rejected');assert.equal(rejected.dispatch_granted,false);
  assert.deepEqual(execute(s,c,later),{...rejected,replayed:true});
 }finally{s.close();}
});

test('publication retains a known source failure with unknown duration at its reservation',async()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const op=source();run=execute(s,command('reserve',{operations:[op]},run)).run;
  const d=Buffer.from(JSON.stringify({request_id:id,operation_id:op.operation_id,url:op.input.url,status:'failed',elapsed_seconds:null}));const h=archive(s,{'result.json':d});
  run=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:h,file_sha256:digest(d),native_result:null},run)).run;
  const b=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40));const a=Buffer.from(JSON.stringify(auditSummary({schema_version:'1.4',budget_policy:LAYERED_BUDGET_POLICY,limits:{source_attempts:2,model_attempts:2,source_attempt_seconds:180,model_stage_seconds:1200,run_seconds:3600},budget_accounting:{successful_attempts:{source:0,model:0},failed_attempts:{source:0,model:0},unknown_attempts:{source:1,model:0},successful_seconds:0,failed_seconds:0,reserved_unknown_seconds:180,charged_seconds:180}})));const ah=archive(s,{'bundle.json':b,'audit.json':a});
  assert.equal((await issuePermit(s,command('permit',{archive_sha256:ah,bundle_sha256:digest(b),audit_sha256:digest(a)},run))).status,'committed');
 }finally{s.close();}
});


test('continuation payload must bind its checkpoint and every evidence content hash',()=>{
 for(const changes of [{continuation:null},{sources:[]},{stage:'research'}]){
  const f=continuationFixture();try{
   const result=execute(f.s,command('reserve',{operations:[f.next({},changes)]},f.run));
   assert.equal(result.status,'rejected');assert.match(result.code,/model_continuation_(payload|stage_input)/);
  }finally{f.s.close();}
 }
 const f=continuationFixture('partial',false,true);try{
  assert.equal(execute(f.s,command('reserve',{operations:[f.next()]},f.run)).code,'model_continuation_no_new_content');
 }finally{f.s.close();}
});
test('continuation refuses to guess when exact previous input bytes are missing',()=>{
 const f=continuationFixture();try{
  const op=f.next(),row=f.s.db.prepare('SELECT bytes FROM research_archives WHERE hash=?').get(op.input.continuation_archive_sha256);
  const files=Object.fromEntries(decodeResearchArchive(Buffer.from(row.bytes)).files.filter(file=>file.sha256!==f.first.input_sha256).map(file=>[file.path,file.data]));
  op.input.continuation_archive_sha256=archive(f.s,files);
  assert.equal(execute(f.s,command('reserve',{operations:[op]},f.run)).code,'model_continuation_input_bytes');
 }finally{f.s.close();}
});
test('editor continuation binds newly archived research output bytes',()=>{
 for(const scalar of [false,true]){
 const f=continuationFixture();try{
  const research={...source('research','model'),max_seconds:30};let run=execute(f.s,command('reserve',{operations:[research]},f.run)).run;
  const output=Buffer.from('new research findings');const data=Buffer.from(JSON.stringify({request_id:id,operation_id:research.operation_id,stage:'research',input_sha256:research.input_sha256,status:'partial',elapsed_seconds:10,...(scalar?{output_sha256:digest(output)}:{outputs:[{sha256:digest(output)}]})}));
  const head=archive(f.s,{'stage_artifacts/new-research.json':data,'stage_artifacts/new-findings.txt':output});
  run=execute(f.s,command('settle',{operation_id:research.operation_id,outcome:'acknowledged',elapsed_seconds:10,archive_sha256:head,file_sha256:digest(data),native_result:null},run)).run;
  const evidence={added_evidence:[{operation_id:research.operation_id,archive_sha256:head,file_sha256:digest(data)}]};
  const misplaced=f.next(evidence,{sources:[{body_sha256:digest(output)}],research:{operation_id:research.operation_id,result_sha256:digest(data),outputs:[]}});
  assert.equal(execute(f.s,command('reserve',{operations:[misplaced]},run)).code,'model_continuation_payload_research');
  const extra=f.next(evidence,{sources:[],research:{operation_id:research.operation_id,result_sha256:digest(data),outputs:[{sha256:digest(output)},{sha256:'f'.repeat(64)}]}});
  assert.equal(execute(f.s,command('reserve',{operations:[extra]},run)).code,'model_continuation_payload_research');
  for(const changes of [{input_sha256:'f'.repeat(64)},{status:'failed'},{elapsed_seconds:11}]){
   const contradicted=f.next(evidence,{sources:[],research:{operation_id:research.operation_id,result_sha256:digest(data),outputs:[{sha256:digest(output)}],...changes}});
   assert.equal(execute(f.s,command('reserve',{operations:[contradicted]},run)).code,'model_continuation_payload_research');
  }
  const op=f.next(evidence,{sources:[],research:{operation_id:research.operation_id,result_sha256:digest(data),outputs:[{sha256:digest(output)}],input_sha256:research.input_sha256,status:'partial',elapsed_seconds:10}});
  assert.equal(execute(f.s,command('reserve',{operations:[op]},run)).status,'committed');
 }finally{f.s.close();}
 }
});

test('research output declarations are a complete validated union',()=>{
 for(const mode of ['union','invalid','missing','blank']){
  const f=continuationFixture();try{
   const research={...source('research','model'),max_seconds:30};let run=execute(f.s,command('reserve',{operations:[research]},f.run)).run;
   const first=Buffer.from('first new output'),second=Buffer.from(mode==='blank'?' \r\n\t':'second new output');
   const result=Buffer.from(JSON.stringify({request_id:id,operation_id:research.operation_id,stage:'research',input_sha256:research.input_sha256,status:'ok',elapsed_seconds:10,outputs:[{sha256:digest(first)}],output_sha256:mode==='invalid'?'invalid':digest(second)}));
   const files={'stage_artifacts/result.json':result,'stage_artifacts/first.txt':first};if(mode!=='missing')files['stage_artifacts/second.txt']=second;
   const head=archive(f.s,files);run=execute(f.s,command('settle',{operation_id:research.operation_id,outcome:'acknowledged',elapsed_seconds:10,archive_sha256:head,file_sha256:digest(result),native_result:null},run)).run;
   const op=f.next({added_evidence:[{operation_id:research.operation_id,archive_sha256:head,file_sha256:digest(result)}]},{sources:[],research:{operation_id:research.operation_id,result_sha256:digest(result),outputs:[{sha256:digest(first)},{sha256:digest(second)}]}});
   const answer=execute(f.s,command('reserve',{operations:[op]},run));
   if(mode==='union')assert.equal(answer.status,'committed');else assert.equal(answer.code,'model_continuation_model_content');
  }finally{f.s.close();}
 }
});

test('continuation rejects a source payload with right bytes but wrong operation binding',()=>{
 const f=continuationFixture();try{
  const op=f.next({},{sources:[{operation_id:randomUUID(),result_sha256:f.manifest.added_evidence[0].file_sha256,body_sha256:digest(f.content)}]});
  assert.equal(execute(f.s,command('reserve',{operations:[op]},f.run)).code,'model_continuation_payload_source');
 }finally{f.s.close();}
});

test('continuation rejects duplicate source identity with a different body',()=>{
 const f=continuationFixture();try{
  const bound={operation_id:f.added.operation_id,result_sha256:f.manifest.added_evidence[0].file_sha256,body_sha256:digest(f.content)};
  const op=f.next({},{sources:[bound,{...bound,body_sha256:'f'.repeat(64)}]});
  assert.equal(execute(f.s,command('reserve',{operations:[op]},f.run)).code,'model_continuation_payload_source');
 }finally{f.s.close();}
});

test('untimed continuation stays reconcilable until original timing is known',()=>{
 const f=continuationFixture();try{
  const op=f.next();let run=execute(f.s,command('reserve',{operations:[op]},f.run)).run;
  const data=Buffer.from(JSON.stringify({request_id:id,operation_id:op.operation_id,stage:'editor',input_sha256:op.input_sha256,status:'ok',elapsed_seconds:null})),h=archive(f.s,{'stage_artifacts/unknown-continuation.json':data});
  const rejected=execute(f.s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:h,file_sha256:digest(data),native_result:null},run));
  assert.equal(rejected.code,'model_continuation_timing_required');assert.equal(rejected.run.charged_seconds,1210);
  assert.equal(f.s.db.prepare('SELECT phase FROM research_control_ops WHERE operation_id=?').get(op.operation_id).phase,'intent');
  for(const changes of [{elapsed_seconds:null},{elapsed_seconds:21},{stage:undefined},{stage:'research'},{input_sha256:undefined},{input_sha256:'f'.repeat(64)}]){
   const mismatched=Buffer.from(JSON.stringify({request_id:id,operation_id:op.operation_id,stage:'editor',input_sha256:op.input_sha256,status:'ok',elapsed_seconds:20,...changes})),mh=archive(f.s,{'mismatched.json':mismatched});
   const answer=execute(f.s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:20,archive_sha256:mh,file_sha256:digest(mismatched),native_result:null},run));
   assert.equal(answer.code,'model_continuation_result_binding');assert.equal(answer.run.charged_seconds,1210);
   assert.equal(f.s.db.prepare('SELECT phase FROM research_control_ops WHERE operation_id=?').get(op.operation_id).phase,'intent');
  }
  run=execute(f.s,command('settle',unknown(op.operation_id),run)).run;
  const known=Buffer.from(JSON.stringify({request_id:id,operation_id:op.operation_id,stage:'editor',input_sha256:op.input_sha256,status:'ok',elapsed_seconds:20})),kh=archive(f.s,{'stage_artifacts/known-continuation.json':known});
  const settled=execute(f.s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:20,archive_sha256:kh,file_sha256:digest(known),native_result:null},run));
  assert.equal(settled.status,'committed');assert.equal(settled.run.charged_seconds,430);
 }finally{f.s.close();}
});

test('no-dispatch observation cannot precede a late grant receipt',async()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const op=source(),c=command('reserve',{operations:[op]},run);queue(s,c);
  const receipt=String((now+910000)/1000)+'.000001';
  await advanceResearchControl(s,config,{assertReady:()=>{throw Error('synthetic cooldown');}},now);
  await advanceResearchControl(s,config,{controlReceipt:async()=>receipt},now+899000);
  run=execute(s,command('status',{offset:0}),now+899500).run;
  run=execute(s,command('renew',{},run),now+899500).run;
  const observed=now+901000,originalGrant=Buffer.from(s.db.prepare('SELECT reply_text FROM research_control_events WHERE command_id=?').get(c.command_id).reply_text);
  const observation=Buffer.from(JSON.stringify({artifact_kind:'local_dispatch_observation_not_settlement',request_id:id,status:'not_dispatched_grant_expired',dispatch_started:false,source_requests:0,operation_ids:[op.operation_id],command_id:c.command_id,receipt_ts:receipt,observed_at:new Date(observed).toISOString()}));
  const result=Buffer.from(JSON.stringify({schema_version:'source_not_dispatched_v1',request_id:id,operation_id:op.operation_id,url:op.input.url,input_sha256:op.input_sha256,status:'not_dispatched',dispatch_started:false,source_requests:0,elapsed_seconds:null,reserved_seconds:op.max_seconds,observation_sha256:digest(observation),grant_command_id:c.command_id,grant_receipt_ts:receipt,grant_receipt_sha256:digest(originalGrant)}));
  const missing=archive(s,{'observation.json':observation,'result.json':result});
  assert.equal(execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:missing,file_sha256:digest(result),native_result:null},run),observed).code,'source_not_dispatched_evidence');
  const hash=archive(s,{'observation.json':observation,'result.json':result,'grant.txt':originalGrant});
  const settled=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:hash,file_sha256:digest(result),native_result:null},run),observed);
  assert.equal(settled.code,'source_not_dispatched_evidence');assert.equal(settled.run.charged_seconds,180);
 }finally{s.close();}
});

test('prior model source contents require comparable explicit hashes',()=>{
 for(const sourceEntry of [{body:'old inline body'},{body_sha256:null,body:'old inline body'},{body_sha256:null,body_file:'old-body.txt'},{body_sha256:null,status:'ok'}]){
  const f=continuationFixture('partial',false,false,{request_id:id,stage:'editor',sources:[sourceEntry]});try{
   const op=f.next();
   assert.equal(execute(f.s,command('reserve',{operations:[op]},f.run)).code,'model_continuation_stage_input');
  }finally{f.s.close();}
 }
});

test('continuation cannot relabel a stored source URL or input identity',()=>{
 for(const changes of [{url:'https://example.org/other'},{input_sha256:'f'.repeat(64)},{status:'failed'},{elapsed_seconds:11}]){
  const f=continuationFixture();try{
   const op=f.next({},{sources:[{operation_id:f.added.operation_id,result_sha256:f.manifest.added_evidence[0].file_sha256,body_sha256:digest(f.content),...changes}]});
   assert.equal(execute(f.s,command('reserve',{operations:[op]},f.run)).code,'model_continuation_payload_source');
  }finally{f.s.close();}
 }
});
test('prior model research must use explicit hashed outputs',()=>{
 for(const research of ['inline prior output',{text:'inline prior output'},{outputs:[{sha256:'f'.repeat(64),text:'inline prior output'}]}]){
  const f=continuationFixture('partial',false,false,{request_id:id,stage:'editor',sources:[],research});try{
   const op=f.next();
   assert.equal(execute(f.s,command('reserve',{operations:[op]},f.run)).code,'model_continuation_stage_input');
  }finally{f.s.close();}
 }
});

test('no-dispatch ordering preserves microsecond precision after a late receipt',async()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const op=source(),c=command('reserve',{operations:[op]},run);queue(s,c);
  const receipt=String((now+910000)/1000)+'.123456';
  await advanceResearchControl(s,config,{assertReady:()=>{throw Error('synthetic cooldown');}},now);
  await advanceResearchControl(s,config,{controlReceipt:async()=>receipt},now+899000);
  run=execute(s,command('status',{offset:0}),now+899500).run;
  run=execute(s,command('renew',{},run),now+899500).run;
  const observed=now+910124,originalGrant=Buffer.from(s.db.prepare('SELECT reply_text FROM research_control_events WHERE command_id=?').get(c.command_id).reply_text);
  const observation=Buffer.from(JSON.stringify({artifact_kind:'local_dispatch_observation_not_settlement',request_id:id,status:'not_dispatched_grant_expired',dispatch_started:false,source_requests:0,operation_ids:[op.operation_id],command_id:c.command_id,receipt_ts:receipt,observed_at:new Date(now+910123).toISOString().replace('.123Z','.123900Z')}));
  const result=Buffer.from(JSON.stringify({schema_version:'source_not_dispatched_v1',request_id:id,operation_id:op.operation_id,url:op.input.url,input_sha256:op.input_sha256,status:'not_dispatched',dispatch_started:false,source_requests:0,elapsed_seconds:null,reserved_seconds:op.max_seconds,observation_sha256:digest(observation),grant_command_id:c.command_id,grant_receipt_ts:receipt,grant_receipt_sha256:digest(originalGrant)}));
  const missing=archive(s,{'observation.json':observation,'result.json':result});
  assert.equal(execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:missing,file_sha256:digest(result),native_result:null},run),observed).code,'source_not_dispatched_evidence');
  const hash=archive(s,{'observation.json':observation,'result.json':result,'grant.txt':originalGrant});
  const settled=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:hash,file_sha256:digest(result),native_result:null},run),observed);
  assert.equal(settled.status,'committed',JSON.stringify(settled));assert.equal(settled.run.charged_seconds,180);
 }finally{s.close();}
});


test('actual permit rejects omitted batch cancellations and records a compatible versioned receipt',async()=>{
 const s=setup();try{
  let run=start(s,layeredPlan());const ops=Array.from({length:8},(_,i)=>({...source('https://example.org/batch-'+i),max_seconds:30}));
  const reserved=command('reserve',{operations:ops},run);queue(s,reserved);
  const receipt='1793491210.000001';await advanceResearchControl(s,config,{controlReceipt:async()=>receipt},now);
  run=execute(s,command('status',{offset:0}),now+70000).run;
  const observation=Buffer.from(JSON.stringify({artifact_kind:'local_dispatch_observation_not_settlement',request_id:id,status:'not_dispatched_grant_expired',dispatch_started:false,source_requests:0,operation_ids:ops.map(op=>op.operation_id),command_id:reserved.command_id,receipt_ts:receipt,observed_at:new Date(now+65000).toISOString()}));
  for(const op of ops){
   const data=Buffer.from(JSON.stringify({schema_version:'source_not_dispatched_v1',request_id:id,operation_id:op.operation_id,url:op.input.url,input_sha256:op.input_sha256,status:'not_dispatched',dispatch_started:false,source_requests:0,elapsed_seconds:null,reserved_seconds:30,observation_sha256:digest(observation),grant_command_id:reserved.command_id,grant_receipt_ts:receipt}));
   const h=archive(s,{'observation.json':observation,'result.json':data});
   const settled=execute(s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:h,file_sha256:digest(data),native_result:null},run),now+70000);assert.equal(settled.status,'committed');run=settled.run;
  }
  const bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40));
  for(const scenario of ['omitted','substituted','wrong_hash','wrong_url','duplicate','missing_records','missing_metadata','bad_sources','null_source','null_attempt','valid']){
   const count=scenario==='omitted'?1:8;
   const sources=ops.slice(0,count).map(op=>({id:op.operation_id,url:op.input.url,attempt_records:[{status:'not_dispatched',operation_id:op.operation_id,not_dispatched_evidence_sha256:s.db.prepare('SELECT result_file FROM research_control_ops WHERE operation_id=?').get(op.operation_id).result_file}]}));
   if(scenario==='substituted')sources[0].attempt_records[0].operation_id=randomUUID();
   if(scenario==='wrong_hash')sources[0].attempt_records[0].not_dispatched_evidence_sha256='f'.repeat(64);
   if(scenario==='wrong_url')sources[0].url='https://example.org/unrelated';
   if(scenario==='missing_records')delete sources[0].attempt_records;
   if(scenario==='duplicate')sources[0]=sources[1];
   if(scenario==='null_source')sources[0]=null;
   if(scenario==='null_attempt')sources[0].attempt_records[0]=null;
   const metadata=Buffer.from(JSON.stringify({sources:scenario==='bad_sources'?{}:sources}));
   const summary=Buffer.from(JSON.stringify(auditSummary({schema_version:'1.4',budget_policy:LAYERED_BUDGET_POLICY,evidence_metadata_sha256:scenario==='missing_metadata'?undefined:digest(metadata),limits:{source_attempts:2,model_attempts:2,source_attempt_seconds:180,model_stage_seconds:1200,run_seconds:3600},budget_accounting:{successful_attempts:{source:0,model:0},failed_attempts:{source:0,model:0},unknown_attempts:{source:count,model:0},successful_seconds:0,failed_seconds:0,reserved_unknown_seconds:count*30,charged_seconds:count*30}})));
   const h=archive(s,{'bundle.json':bundle,'metadata.json':metadata,'summary.json':summary}),c=command('permit',{archive_sha256:h,bundle_sha256:digest(bundle),audit_sha256:digest(summary)},run);
   const answer=await issuePermit(s,c);
   if(scenario!=='valid'){assert.equal(answer.code,scenario==='omitted'?'publication_budget_accounting':['bad_sources','null_source','null_attempt'].includes(scenario)?'publication_cancellation_metadata':'publication_cancellation_binding',scenario);assert.equal(answer.cancellation_page_version,undefined);assert.equal(answer.run.permit,null);}
   else{
    assert.equal(answer.status,'committed');assert.equal(answer.cancellation_page_version,1);assert.equal(answer.run.charged_seconds,240);
    const parsed=await nativeFixtureControl(s)(Buffer.from(JSON.stringify(c)));assert.equal(parsed.cancellation_page_version,1);
    assert.equal(JSON.parse(s.db.prepare('SELECT result FROM research_control_commands WHERE command_id=?').get(c.command_id).result).cancellation_page_version,1);
   }
  }
 }finally{s.close();}
});

test('editor-only continuation requires its original research checkpoint shape',()=>{
 for(const research of [undefined,{outputs:[]},{result_sha256:'a'.repeat(64),outputs:[]},{result_sha256:'a'.repeat(64),outputs:null}]){
  const f=continuationFixture('partial',false,false,{request_id:id,stage:'editor',sources:[],...(research===undefined?{}:{research})});try{
   const op=f.next();
   const answer=execute(f.s,command('reserve',{operations:[op]},f.run));assert.equal(answer.code,research?.outputs===null?'model_continuation_stage_input':'model_continuation_prior_research');assert.equal(answer.run.charged_seconds,410);
  }finally{f.s.close();}
 }
});

test('continuation rejects unbound additional payload references but keeps original context',()=>{
 for(const kind of ['source','research']){
  const f=continuationFixture();try{
   const original=JSON.parse(f.originalInput);
   const extra=kind==='source'?{sources:[{operation_id:f.added.operation_id,result_sha256:f.manifest.added_evidence[0].file_sha256,body_sha256:digest(f.content)},{operation_id:randomUUID(),result_sha256:'e'.repeat(64),body_sha256:'f'.repeat(64)}]}:{research:{operation_id:randomUUID(),result_sha256:'e'.repeat(64),outputs:[{sha256:'f'.repeat(64)}]}};
   assert.equal(execute(f.s,command('reserve',{operations:[f.next({},extra)]},f.run)).code,'model_continuation_payload_unbound');
   assert.equal(execute(f.s,command('reserve',{operations:[f.next({},{research:original.research})]},f.run)).status,'committed');
  }finally{f.s.close();}
 }
});

test('continuation requires original model stage and input bindings',()=>{
 for(const fields of [{stage:undefined},{stage:'research'},{input_sha256:undefined},{input_sha256:'f'.repeat(64)}]){
  const f=continuationFixture('partial',false,false,null,fields);try{
   const answer=execute(f.s,command('reserve',{operations:[f.next()]},f.run));
   assert.equal(answer.code,'model_continuation_prior_binding');assert.equal(answer.run.charged_seconds,410);
  }finally{f.s.close();}
 }
});
test('continuation refuses whitespace-only successful source bytes',()=>{
 const f=continuationFixture();try{
  const content=Buffer.from(' \t\r\n'),data=Buffer.from(JSON.stringify({request_id:id,operation_id:f.added.operation_id,input_sha256:f.added.input_sha256,url:f.added.input.url,status:'ok',elapsed_seconds:10,response_complete:true,curl_exit_code:0,error:'',http_status:200,content_sha256:digest(content)}));
  const h=archive(f.s,{'result.json':data,'body.txt':content});
  f.s.db.prepare('UPDATE research_control_ops SET result_archive=?,result_file=? WHERE operation_id=?').run(h,digest(data),f.added.operation_id);
  const op=f.next({added_evidence:[{operation_id:f.added.operation_id,archive_sha256:h,file_sha256:digest(data)}]},{sources:[{operation_id:f.added.operation_id,result_sha256:digest(data),body_sha256:digest(content)}]});
  assert.equal(execute(f.s,command('reserve',{operations:[op]},f.run)).code,'model_continuation_source_content');
 }finally{f.s.close();}
});

test('continuation authority includes its peer and a real next-window ordinary retry',async()=>{
 const s=setup();try{
  const p=JSON.parse(layeredPlan());p.model_stages=['research','editor'];const planBytes=Buffer.from(JSON.stringify(p));let run=start(s,planBytes),clock=now;
  const call=(action,args)=>{const answer=execute(s,command(action,args,run),clock);assert.equal(answer.status,'committed',JSON.stringify(answer));run=answer.run;return answer;};
  const settled=(op,value,files={})=>{const data=Buffer.from(JSON.stringify(value)),h=archive(s,{...files,['stage_artifacts/'+digest(data)+'.json']:data});call('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:value.elapsed_seconds,archive_sha256:h,file_sha256:digest(data),native_result:null});return {op,data,archive:h,file:digest(data)};};
  const oldResearch=Buffer.from('retained real research'),researchInput=Buffer.from(JSON.stringify({request_id:id,stage:'research',sources:[]}));
  const research={...source('research','model'),max_seconds:100,input_sha256:digest(researchInput)};call('reserve',{operations:[research]});
  const rr=settled(research,{request_id:id,operation_id:research.operation_id,stage:'research',input_sha256:research.input_sha256,status:'ok',elapsed_seconds:10,outputs:[{sha256:digest(oldResearch)}]},{'research.txt':oldResearch});
  const editorInput=Buffer.from(JSON.stringify({request_id:id,stage:'editor',sources:[],research:{operation_id:research.operation_id,result_sha256:rr.file,outputs:[{sha256:digest(oldResearch)}]}}));
  const editor={...source('editor','model'),max_seconds:100,input_sha256:digest(editorInput)};call('reserve',{operations:[editor]});
  const er=settled(editor,{request_id:id,operation_id:editor.operation_id,stage:'editor',input_sha256:editor.input_sha256,status:'ok',elapsed_seconds:10});
  const added=source(),body=Buffer.from('new source');call('reserve',{operations:[added]});
  const sr=settled(added,{request_id:id,operation_id:added.operation_id,input_sha256:added.input_sha256,url:added.input.url,status:'ok',elapsed_seconds:10,response_complete:true,curl_exit_code:0,http_status:200,error:'',content_sha256:digest(body)},{'source.txt':body});
  const binding={previous_operation_id:editor.operation_id,checkpoint_archive_sha256:er.archive,checkpoint_file_sha256:er.file,added_evidence:[{operation_id:added.operation_id,archive_sha256:sr.archive,file_sha256:sr.file}]};
  const payload=Buffer.from(JSON.stringify({request_id:id,stage:'editor',sources:[{operation_id:added.operation_id,result_sha256:sr.file,body_sha256:digest(body)}],continuation:binding}));
  const manifest=Buffer.from(JSON.stringify({schema_version:'model_prepublication_continuation_v1',request_id:id,stage:'editor',...binding,payload_sha256:digest(payload)})),mh=archive(s,{'manifest.json':manifest,'payload.json':payload,'prior.json':editorInput});
  const continuation={...source('editor','model'),max_seconds:100,input_sha256:digest(manifest),input:{previous_operation_id:editor.operation_id,checkpoint_archive_sha256:er.archive,checkpoint_file_sha256:er.file,continuation_archive_sha256:mh}};call('reserve',{operations:[continuation]});
  const failed=settled(continuation,{request_id:id,operation_id:continuation.operation_id,stage:'editor',input_sha256:continuation.input_sha256,status:'failed',elapsed_seconds:10,error:'synthetic model failure'});
  const retry={...source('editor','model'),max_seconds:100,input_sha256:digest(payload),input:{previous_operation_id:continuation.operation_id,checkpoint_archive_sha256:failed.archive,checkpoint_file_sha256:failed.file}};
  assert.equal(execute(s,command('reserve',{operations:[retry]},run),clock).code,'research_window_attempts_exhausted');
  const grant={schema_version:'research_recovery_grant_v1',grant_id:randomUUID(),request_id:id,generation:config.research_control.generation,plan_hash:run.plan_hash,previous_sha256:null,authorization_reference:'synthetic next-window approval',effective_not_before:nextResearchContinuationAt(now),window_seconds:3600,failed_attempts_consume_success_budget:false,continuation_policy:'hourly_20_until_complete'};
  const grantBytes=Buffer.from(JSON.stringify(grant));approveResearchRecoveryGrant(s.db,grantBytes,grant.authorization_reference,now);call('recovery_grant',{grant_base64:grantBytes.toString('base64')});clock=grant.effective_not_before;
  const claimed=execute(s,command('claim',{plan_base64:planBytes.toString('base64')},run),clock);assert.equal(claimed.status,'claimed');run=claimed.run;
  call('reserve',{operations:[retry]});const final=settled(retry,{request_id:id,operation_id:retry.operation_id,stage:'editor',input_sha256:retry.input_sha256,status:'ok',elapsed_seconds:10});
  const proof=Buffer.from(JSON.stringify({schema_version:'model_prepublication_continuation_evidence_v1',operation_id:continuation.operation_id,control_commands:[],source_attempts:[]}));
  const record=(item,status,checkpoint=null)=>({status,input_sha256:item.op.input_sha256,result_sha256:item.file,checkpoint_sha256:checkpoint,reserved_seconds:item.op.max_seconds,elapsed_seconds:10});
  const bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40));
  for(const mutation of ['peer','retry','checkpoint','round','valid']){
   const calls=[{stage:'research',attempt_records:[record(rr,'ok')]},{stage:'editor',attempt_records:[record(er,'ok'),{...record(failed,'failed',er.file),prepublication_continuation_sha256:digest(proof)},record(final,'ok',failed.file)]}];
   if(mutation==='peer')calls[0].attempt_records[0].result_sha256='f'.repeat(64);if(mutation==='retry')calls[1].attempt_records[2].result_sha256='f'.repeat(64);if(mutation==='checkpoint')calls[1].attempt_records[2].checkpoint_sha256='f'.repeat(64);if(mutation==='round')calls[1].attempt_records[2].page_round={revision:2};
   const metadata=Buffer.from(JSON.stringify({sources:[],model_calls:calls})),audit=Buffer.from(JSON.stringify(auditSummary({schema_version:'1.4',budget_policy:LAYERED_BUDGET_POLICY,evidence_metadata_sha256:digest(metadata),limits:{source_attempts:2,model_attempts:2,source_attempt_seconds:180,model_stage_seconds:1200,run_seconds:3600},budget_accounting:{successful_attempts:{source:1,model:3},failed_attempts:{source:0,model:1},unknown_attempts:{source:0,model:0},successful_seconds:40,failed_seconds:10,reserved_unknown_seconds:0,charged_seconds:40}})));
   const h=archive(s,{'bundle.json':bundle,'metadata.json':metadata,'audit.json':audit,'proof.json':proof}),cmd=command('permit',{archive_sha256:h,bundle_sha256:digest(bundle),audit_sha256:digest(audit)},run),raw=Buffer.from(JSON.stringify(cmd));
   const answer=executeResearchControl(s.db,config,raw,clock,{publicationCheck:await preparePublicationCheck(s.db,raw)});
   if(mutation==='valid')assert.equal(answer.status,'committed',JSON.stringify(answer));else assert.equal(answer.code,'publication_model_continuation_binding',mutation);
  }
 }finally{s.close();}
});

test('continuation delta cannot introduce unbound top-level material',()=>{
 for(const change of [{raw_text:'unverified material'},{as_of:'2027-01-01T00:00:00Z'},{scope:{topic:'replacement'}}]){
  const old={request_id:id,stage:'editor',sources:[],research:{result_sha256:'a'.repeat(64),outputs:[{sha256:'b'.repeat(64)}]},as_of:'2026-11-01T00:00:00Z',scope:{topic:'original',nested:{a:1,b:2}}};
  const f=continuationFixture('partial',false,false,old);try{
   assert.equal(execute(f.s,command('reserve',{operations:[f.next({},change)]},f.run)).code,'model_continuation_payload_unbound');
   assert.equal(execute(f.s,command('reserve',{operations:[f.next({},{as_of:old.as_of,scope:{nested:{b:2,a:1},topic:'original'}})]},f.run)).status,'committed');
  }finally{f.s.close();}
 }
});
test('added evidence binds its reserved input and research stage',()=>{
 for(const kind of ['source','research'])for(const mutation of ['missing-input','wrong-input',...(kind==='research'?['missing-stage','wrong-stage']:[])]){
  const f=continuationFixture();try{
   let run=f.run,op=f.added;const output=Buffer.from('new real content');
   if(kind==='research'){op={...source('research','model'),max_seconds:30};run=execute(f.s,command('reserve',{operations:[op]},run)).run;}
   const value={request_id:id,operation_id:op.operation_id,stage:'research',input_sha256:op.input_sha256,status:'ok',elapsed_seconds:10,...(kind==='source'?{url:op.input.url,response_complete:true,curl_exit_code:0,http_status:200,error:'',content_sha256:digest(output)}:{outputs:[{sha256:digest(output)}]})};
   if(mutation==='missing-input')delete value.input_sha256;if(mutation==='wrong-input')value.input_sha256='f'.repeat(64);if(mutation==='missing-stage')delete value.stage;if(mutation==='wrong-stage')value.stage='editor';
   const data=Buffer.from(JSON.stringify(value)),h=archive(f.s,{'result.json':data,'body.txt':output});
   if(kind==='source')f.s.db.prepare('UPDATE research_control_ops SET result_archive=?,result_file=? WHERE operation_id=?').run(h,digest(data),op.operation_id);
   else run=execute(f.s,command('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:10,archive_sha256:h,file_sha256:digest(data),native_result:null},run)).run;
   const payload=kind==='source'?{sources:[{operation_id:op.operation_id,result_sha256:digest(data),body_sha256:digest(output)}]}:{sources:[],research:{operation_id:op.operation_id,result_sha256:digest(data),outputs:[{sha256:digest(output)}]}};
   const next=f.next({added_evidence:[{operation_id:op.operation_id,archive_sha256:h,file_sha256:digest(data)}]},payload);
   assert.equal(execute(f.s,command('reserve',{operations:[next]},run)).code,'model_continuation_evidence_binding');
  }finally{f.s.close();}
 }
});

test('editor recognizes research continuation through an authenticated successful recovery',()=>{
 const f=continuationFixture('partial',false,false,{request_id:id,stage:'editor',sources:[]});try{
  let run=f.run,clock=now;const call=(action,args)=>{const answer=execute(f.s,command(action,args,run),clock);assert.equal(answer.status,'committed',JSON.stringify(answer));run=answer.run;return answer;};
  const settle=(op,value,files={})=>{const data=Buffer.from(JSON.stringify(value)),h=archive(f.s,{...files,'result.json':data});call('settle',{operation_id:op.operation_id,outcome:'acknowledged',elapsed_seconds:value.elapsed_seconds,archive_sha256:h,file_sha256:digest(data),native_result:null});return {archive:h,file:digest(data)};};
  const oldInput=Buffer.from(JSON.stringify({request_id:id,stage:'research',sources:[]})),research={...source('research','model'),max_seconds:30,input_sha256:digest(oldInput)};call('reserve',{operations:[research]});
  const prior=settle(research,{request_id:id,operation_id:research.operation_id,stage:'research',input_sha256:research.input_sha256,status:'ok',elapsed_seconds:10});
  const added=source('https://example.org/new-research-evidence'),body=Buffer.from('new actual source');call('reserve',{operations:[added]});
  const sr=settle(added,{request_id:id,operation_id:added.operation_id,input_sha256:added.input_sha256,url:added.input.url,status:'ok',elapsed_seconds:10,response_complete:true,curl_exit_code:0,http_status:200,error:'',content_sha256:digest(body)},{'body.txt':body});
  const binding={previous_operation_id:research.operation_id,checkpoint_archive_sha256:prior.archive,checkpoint_file_sha256:prior.file,added_evidence:[{operation_id:added.operation_id,archive_sha256:sr.archive,file_sha256:sr.file}]};
  const payload=Buffer.from(JSON.stringify({request_id:id,stage:'research',sources:[{operation_id:added.operation_id,result_sha256:sr.file,body_sha256:digest(body)}],continuation:binding})),manifest=Buffer.from(JSON.stringify({schema_version:'model_prepublication_continuation_v1',request_id:id,stage:'research',...binding,payload_sha256:digest(payload)}));
  const h=archive(f.s,{'old.json':oldInput,'manifest.json':manifest,'payload.json':payload}),continued={...source('research','model'),max_seconds:30,input_sha256:digest(manifest),input:{previous_operation_id:research.operation_id,checkpoint_archive_sha256:prior.archive,checkpoint_file_sha256:prior.file,continuation_archive_sha256:h}};call('reserve',{operations:[continued]});
  const failed=settle(continued,{request_id:id,operation_id:continued.operation_id,stage:'research',input_sha256:continued.input_sha256,status:'failed',elapsed_seconds:10});
  const grant={schema_version:'research_recovery_grant_v1',grant_id:randomUUID(),request_id:id,generation:config.research_control.generation,plan_hash:run.plan_hash,previous_sha256:null,authorization_reference:'synthetic next-window recovery',effective_not_before:nextResearchContinuationAt(now),window_seconds:3600,failed_attempts_consume_success_budget:false,continuation_policy:'hourly_20_until_complete'},bytes=Buffer.from(JSON.stringify(grant));
  approveResearchRecoveryGrant(f.s.db,bytes,grant.authorization_reference,now);call('recovery_grant',{grant_base64:bytes.toString('base64')});clock=grant.effective_not_before;
  const originalPlan=Buffer.from(f.s.db.prepare('SELECT plan FROM research_control_runs WHERE request_id=?').get(id).plan),claimed=execute(f.s,command('claim',{plan_base64:originalPlan.toString('base64')},run),clock);assert.equal(claimed.status,'claimed');run=claimed.run;
  const retry={...source('research','model'),max_seconds:30,input_sha256:digest(payload),input:{previous_operation_id:continued.operation_id,checkpoint_archive_sha256:failed.archive,checkpoint_file_sha256:failed.file}};call('reserve',{operations:[retry]});
  const findings=Buffer.from('new research after a real retry'),final=settle(retry,{request_id:id,operation_id:retry.operation_id,stage:'research',input_sha256:retry.input_sha256,status:'ok',elapsed_seconds:10,outputs:[{sha256:digest(findings)}]},{'findings.txt':findings});
  const next=f.next({added_evidence:[{operation_id:retry.operation_id,archive_sha256:final.archive,file_sha256:final.file}]},{sources:[],research:{operation_id:retry.operation_id,result_sha256:final.file,outputs:[{sha256:digest(findings)}]}});
  assert.equal(execute(f.s,command('reserve',{operations:[next]},run),clock).status,'committed');
 }finally{f.s.close();}
});
