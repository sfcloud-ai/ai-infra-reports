// Isolated host authority fixtures. No real provider calls or native uploads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {installFence} from '../scripts/producer-admission-fence.mjs';
import {installSubmission,advanceSubmission} from '../scripts/slack-submission.mjs';
import {PublisherInbox} from '../scripts/publisher-inbox.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {installResearchArchive,storeResearchArchive} from '../scripts/research-archive.mjs';
import {installResearchControl,migrateResearchControl,assertResearchControl,executeResearchControl,researchSourceIdentity,decodeResearchControl,preparePublicationCheck,RESEARCH_CONTROL_SCHEMA} from '../scripts/research-control.mjs';
import {advanceResearchControl,queueResearchControl,pendingResearchControls,researchControlHealth} from '../scripts/research-control-inbox.mjs';
import {handoffTick} from '../scripts/run-handoff.mjs';
import {nativeResearchAuthority,researchCommandText,verifyResearchControlReceipt,CONTROL_THREAD_TOOL} from '../scripts/research-control-client.mjs';
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
function start(s,bytes=plan){const claim=execute(s,command('claim',{plan_base64:bytes.toString('base64')}));assert.equal(claim.status,'claimed');const result=execute(s,command('inputs',{},claim.run));assert.equal(result.status,'committed');return result.run;}
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
 }finally{s?.close();await rm(dir,{recursive:true,force:true});}
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
  const bytes=await encodeBundle(files,id,'b'.repeat(40),'a'.repeat(40)),audit=Buffer.from(JSON.stringify({schema_version:'1.2',date:DAY,audit_valid:true,blockers:[],readiness:'zero_items'}));
  const hash=archive(s,{'bundle.json':bytes,'audit.json':audit});assert.equal((await issuePermit(s,command('permit',{archive_sha256:hash,bundle_sha256:digest(bytes),audit_sha256:digest(audit)},run))).status,'committed');
 }finally{s.close();}
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
  const run=start(s),bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40)),audit={schema_version:'1.2',date:DAY,audit_valid:true,blockers:[],readiness:'partial',delivery_allowed:false,budget_unknown:true};
  for(const [bytes,review,code] of [[await encodeBundle(FILES,id,'a'.repeat(40),'a'.repeat(40)),audit,'publication_plan_binding'],[bundle,{...audit,date:'2026-11-02'},'publication_audit_blocked'],[bundle,{...audit,blockers:['unsupported fact']},'publication_audit_blocked']]){
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
  const run=start(s),bundle=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40)),data=JSON.parse(bundle),empty=Buffer.from(JSON.stringify({...data,files:[]})),audit=Buffer.from(JSON.stringify({schema_version:'1.2',date:DAY,audit_valid:true,blockers:[],readiness:'ready'}));
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
   assert.equal(run().status,1,'an existing cache must not be overwritten');
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
test('real staging path accepts the original completed upload after takeover and fences unrelated envelopes',async()=>{
 const inputPlan=plan;
 const s=setup();try{
  let run=start(s,inputPlan);const bytes=await encodeBundle(FILES,id,'b'.repeat(40),'a'.repeat(40)),hash=digest(bytes),audit=Buffer.from(JSON.stringify({schema_version:'1.2',date:DAY,audit_valid:true,delivery_allowed:true,blockers:[],readiness:'partial',budget_unknown:true}));
  const checkpoint=archive(s,{'bundle.json':bytes,'audit.json':audit});run=(await issuePermit(s,command('permit',{archive_sha256:checkpoint,bundle_sha256:hash,audit_sha256:digest(audit)},run))).run;
  const permit=run.permit.permit_id;let completeOp;
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
 }finally{s.close();}
});
