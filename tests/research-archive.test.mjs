// Isolated host storage and native-message fixtures; no live uploads or sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {installFence} from '../scripts/producer-admission-fence.mjs';
import {installSubmission} from '../scripts/slack-submission.mjs';
import {PublisherInbox} from '../scripts/publisher-inbox.mjs';
import {SlackHandoff} from '../scripts/slack-handoff.mjs';
import {handoffTick,validateConfig} from '../scripts/run-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {stageFile} from '../scripts/slack-stage-cli.mjs';
import {installResearchArchive,assertResearchArchive,decodeResearchArchive,acceptResearchArchive,advanceResearchArchive,readResearchArchive,ARCHIVE_SCHEMA,ARCHIVE_CHUNK} from '../scripts/research-archive.mjs';
import {installFixtureAuthority,fixtureNative} from './helpers/repository-authority-fixture.mjs';
import {SCOPE,DAY} from './helpers/cloud-sender-fixture.mjs';

const id='morning-20261101-r1',now=1793491210000,ts='1793491201.000001',uuid='d1111111-1111-4111-8111-111111111111';
const fence={generation:'a1111111-1111-4111-8111-111111111111',activation_ts:'1793491200.000000',producer_scope_sha256:'b'.repeat(64),installation:{journal_device:'1',journal_inode:'2',lock_device:'1',lock_inode:'3'}};
const {transport_profile,notification_destination,...identity}=SCOPE;
const config={...identity,ready_for_review:false,producer_app_id:1,merger_app_id:2,slack_token_file:'/private/token',producer_key_file:'/private/key',state_dir:'/private/state',durable_intake:{not_before:'1793462400.000000'},producer_fence:fence,scheduled_delivery:{activation_date:DAY,executable:'/usr/bin/python3',args:[]},slack_submission:{activation_ts:fence.activation_ts,first_report_date:DAY,generation:'b1111111-1111-4111-8111-111111111111'},research_archive:{activation_ts:fence.activation_ts,first_report_date:DAY,generation:'c1111111-1111-4111-8111-111111111111'}};
config.research_control={...config.research_archive,generation:'e1111111-1111-4111-8111-111111111111',protocol:'repository_inputs_v1'};
function packet({data=Buffer.from('{"budget":3600}\n'),path='audit/plan.json',command_id=uuid,previous_sha256=null,request_id=id,report_date=DAY}={}){
 return Buffer.from(JSON.stringify({schema_version:'research_archive_v1',command_id,request_id,report_date,previous_sha256,files:[{path,sha256:digest(data),content_base64:data.toString('base64')}]}));
}
function message(text,source=ts,file){return {type:'message',user:SCOPE.sender_user_id,app_id:SCOPE.sender_user_app_id,ts:source,text:text+' '+SCOPE.sender_attribution_text,...(file?{files:[{id:file}]}:{}),blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text}]}]},{type:'context',elements:[{type:'mrkdwn',text:SCOPE.sender_attribution_text,verbatim:false}]}]};}
function setup(filename=':memory:'){
 const state=new HandoffState(filename,handoffScope(config));installFence(state.db,fence,'synthetic original',[]);installSubmission(state.db,config,'synthetic staging');installResearchArchive(state.db,config,'synthetic archive');installFixtureAuthority(state,config);return state;
}
function slackFor(messages,bytes,receipt=async()=> '1793491209.000001'){
 return {history:async()=>[],historyPage:async({from,to})=>({messages:messages.filter(m=>m.ts>=from&&m.ts<=to),next_cursor:null}),exactPublish:async source=>messages.find(m=>m.ts===source),download:async(_event,options)=>{assert.equal(options.name,'ai-brief-research-archive.json');return bytes;},controlReceipt:receipt};
}
async function ingest(state,bytes=packet(),source=ts,receipt){
 fixtureNative(state,config,{hash:digest(bytes),bytes:bytes.length});
 const msg=message(`!ai-research save ${id} ${digest(bytes)}`,source,'FSOURCE'),slack=slackFor([msg],bytes,receipt);
 await new PublisherInbox(state,config).scan(slack,Math.ceil(Number(source)*1000));await advanceResearchArchive(state,config,slack,now);return slack;
}
const query=(action='head',hash='head',offset=0)=>({query_id:uuid,action,hash,offset});

test('archive requires explicit original policy and leaves report scope unchanged',()=>{
 const state=setup();try{
  assert.equal(validateConfig(config),config);assert.equal(assertResearchArchive(state.db,config),true);
  const reordered={...config,research_archive:{first_report_date:DAY,activation_ts:fence.activation_ts,generation:config.research_archive.generation}};
  assert.equal(assertResearchArchive(state.db,reordered),true);
  const {research_archive,...before}=config;assert.deepEqual(handoffScope(config),handoffScope(before));
  assert.throws(()=>assertResearchArchive(state.db,before),/cannot be removed/);
  assert.throws(()=>installResearchArchive(state.db,config,'again'),/never reinstall/);
  assert.throws(()=>assertResearchArchive(state.db,{...config,research_archive:{...config.research_archive,generation:uuid}}),/binding/);
 }finally{state.close();}
});
test('exact native identity, file, hashes, paths and activation are checked before storage',()=>{
 const bytes=packet(),msg=message(`!ai-research save ${id} ${digest(bytes)}`,ts,'FSOURCE'),window={from:fence.activation_ts,to:(now/1000).toFixed(6)};
 assert.equal(acceptResearchArchive(msg,config,now,window).kind,'save');
 for(const patch of [{user:'UOTHER'},{app_id:'AOTHER'},{edited:{}},{thread_ts:'1793491200.000001'},{blocks:[]},{files:[]}])assert.throws(()=>acceptResearchArchive({...msg,...patch},config,now,window));
 assert.throws(()=>acceptResearchArchive(msg,{...config,research_archive:{...config.research_archive,first_report_date:'2026-11-02'}},now,window));
 for(const path of ['../outside','/absolute','audit/../../outside','audit\\outside','a/./b'])assert.throws(()=>decodeResearchArchive(packet({path})));
 assert.equal(decodeResearchArchive(packet({path:'research-plan.json'})).files.length,1);
 const bad=JSON.parse(bytes);bad.files[0].sha256='f'.repeat(64);assert.throws(()=>decodeResearchArchive(Buffer.from(JSON.stringify(bad))),/bytes differ/);
 bad.files[0].content_base64+='\n';assert.throws(()=>decodeResearchArchive(Buffer.from(JSON.stringify(bad))));
});
test('cloud directory loss and deleted Slack upload still recover exact original files from reopened host state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'research-durable-')),dbPath=join(dir,'host.sqlite'),cloud=join(dir,'cloud');
 const original=Buffer.concat([Buffer.from('original\r\n'),Buffer.alloc(20000,123)]),bytes=packet({data:original});
 let state=setup(dbPath);
 try{
  await mkdir(cloud);await writeFile(join(cloud,'source.json'),original);await ingest(state,bytes);
  assert.equal(state.pending().length,0);state.close();await rm(cloud,{recursive:true});
  state=new HandoffState(dbPath,handoffScope(config));assertResearchArchive(state.db,config);
  const head=readResearchArchive(state.db,id,query());assert.equal(head.head_sha256,digest(bytes));
  const manifest=readResearchArchive(state.db,id,query('manifest',head.head_sha256));assert.equal(manifest.files[0].sha256,digest(original));
  const restored=[];let offset=0;
  do{const result=readResearchArchive(state.db,id,query('file',digest(original),offset));const chunk=Buffer.from(result.content_base64,'base64');assert.equal(digest(chunk),result.chunk_sha256);restored.push(chunk);offset=result.next_offset;}while(offset!==null);
  assert.deepEqual(Buffer.concat(restored),original);
  assert.equal(readResearchArchive(state.db,id,query('file',digest(original),1)).code,'invalid_file_offset');
  assert.equal(readResearchArchive(state.db,'morning-20261102-r1',query('file',digest(original))).status,'not_found');
 }finally{state.close();await rm(dir,{recursive:true,force:true});}
});
test('coercible identifiers receive durable rejection without repeated downloads',async()=>{
 for(const patch of [{command_id:[uuid]},{previous_sha256:['a'.repeat(64)]}]){
  const state=setup(),bytes=packet(patch);let downloads=0;try{
   assert.throws(()=>decodeResearchArchive(bytes),/identity/);
   const msg=message(`!ai-research save ${id} ${digest(bytes)}`,ts,'FSOURCE'),slack=slackFor([msg],bytes);
   slack.download=async()=>{downloads++;return bytes;};
   fixtureNative(state,config,{hash:digest(bytes),bytes:bytes.length});await new PublisherInbox(state,config).scan(slack,now);await advanceResearchArchive(state,config,slack,now);
   assert.equal(readResearchArchive(state.db,id,query('receipt',digest(bytes))).status,'rejected');
   await advanceResearchArchive(state,config,slack,now+600000);await advanceResearchArchive(state,config,slack,now+1200000);
   assert.equal(downloads,1);assert.equal(state.db.prepare('SELECT phase FROM research_archive_events').get().phase,'sent');
   assert.equal(state.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);
  }finally{state.close();}
 }
});
test('archive storage failure stays unhealthy through backoff until stored',async()=>{
 const state=setup(),bytes=packet(),msg=message(`!ai-research save ${id} ${digest(bytes)}`,ts,'FSOURCE');let clock=now,downloads=0;try{
  const slack=slackFor([msg],bytes);slack.download=async()=>{downloads++;if(downloads===1)throw Error('synthetic download failure');return bytes;};
  const io={now:()=>clock,scheduleQuery:()=>assert.fail('no report to schedule'),propose:()=>assert.fail('not report content')};
  fixtureNative(state,config,{hash:digest(bytes),bytes:bytes.length});const failed=await handoffTick(state,config,slack,io);assert.equal(failed.healthy,false);assert.equal(failed.blocked_research.length,1);
  clock+=1000;const backoff=await handoffTick(state,config,slack,io);assert.deepEqual(backoff.errors,[]);assert.equal(backoff.healthy,false);assert.equal(backoff.blocked_research[0].source_ts,ts);assert.equal(downloads,1);
  clock+=600000;const recovered=await handoffTick(state,config,slack,io);assert.equal(recovered.healthy,true);assert.deepEqual(recovered.blocked_research,[]);assert.equal(readResearchArchive(state.db,id,query()).status,'stored');
 }finally{state.close();}
});
test('full research command journal refuses new research without rolling back report staging or watermark',async()=>{
 const state=setup(),bytes=packet();try{
  // Constructed capacity fixture; exercise the actual shared native intake.
  state.db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO research_archive_events(source_ts,kind,request_id,hash,phase) SELECT printf('1793400000.%06d',x),'read','morning-20261101-r1','fixture','sent' FROM n");
  const save=message(`!ai-research save ${id} ${digest(bytes)}`,ts,'FSOURCE');
  const stage=message(`!ai-report stage-v2 ${id} ${'a'.repeat(64)} ${uuid}`,'1793491202.000001','FREPORT');
  const inbox=new PublisherInbox(state,config),result=await inbox.scan(slackFor([save,stage],bytes),now);
  assert.equal(result.page_complete,true);assert.equal(result.rejected.length,1);assert.equal(result.rejected[0].code,'research_command_capacity');
  assert.equal(state.db.prepare('SELECT kind FROM slack_submission_events').get().kind,'stage');
  assert.equal(state.db.prepare('SELECT watermark FROM publisher_intake_scan').get().watermark,(now/1000).toFixed(6));
  assert.equal(state.db.prepare('SELECT count(*) n FROM research_archive_events').get().n,100000);
  assert.equal((await inbox.scan(slackFor([save,stage],bytes),now+1000)).rejected.length,0);
 }finally{state.close();}
});
test('permanently invalid native file metadata is rejected once while transport failures remain retryable',async()=>{
 for(const patch of [{name:'wrong.json'},{size:16*1024*1024+1}]){
  const state=setup(),bytes=packet(),msg=message(`!ai-research save ${id} ${digest(bytes)}`,ts,'FSOURCE');let reads=0;try{
   const native=new SlackHandoff(config,'synthetic-token',async url=>{
    assert.equal(new URL(url).pathname,'/api/files.info');reads++;
    return new Response(JSON.stringify({ok:true,file:{id:'FSOURCE',user:config.sender_user_id,user_team:config.team_id,name:'ai-brief-research-archive.json',mode:'snippet',size:bytes.length,...patch}}),{headers:{'content-type':'application/json'}});
   });
   const slack=slackFor([msg],bytes);slack.download=native.download.bind(native);
   fixtureNative(state,config,{hash:digest(bytes),bytes:bytes.length});await new PublisherInbox(state,config).scan(slack,now);await advanceResearchArchive(state,config,slack,now);
   assert.equal(readResearchArchive(state.db,id,query('receipt',digest(bytes))).status,'rejected');
   assert.equal(JSON.parse(state.db.prepare('SELECT diagnostic FROM research_archive_events').get().diagnostic).code,'invalid_file_metadata');
   await advanceResearchArchive(state,config,slack,now+600000);await advanceResearchArchive(state,config,slack,now+1200000);
   assert.equal(reads,1);assert.equal(state.db.prepare('SELECT phase FROM research_archive_events').get().phase,'sent');
  }finally{state.close();}
 }
});
test('invalid offsets and missing files return terminal read results without retrying or degrading health',async()=>{
 const state=setup(),bytes=packet();try{
  await ingest(state,bytes);const fileHash=decodeResearchArchive(bytes).files[0].sha256;
  const cases=[['file',fileHash,1,'rejected'],['file',fileHash,ARCHIVE_CHUNK,'rejected'],['manifest',digest(bytes),2,'rejected'],['manifest','f'.repeat(64),0,'not_found'],['file','f'.repeat(64),0,'not_found']];
  for(const [i,[action,hash,offset,status]] of cases.entries()){
   const source=`17934912${11+i}.000001`,clock=1793491211001+i*1000,msg=message(`!ai-research read ${id} ${uuid} ${action} ${hash} ${offset}`,source);let replies=0;
   const slack=slackFor([msg],null,async(_ts,text)=>{replies++;const result=JSON.parse(text.slice('!ai-research receipt '.length));assert.equal(result.status,status);assert.equal(result.query_id,uuid);return '1793491209.000001';});
   const io={now:()=>clock,scheduleQuery:()=>assert.fail('no report'),propose:()=>assert.fail('no report')};
   const result=await handoffTick(state,config,slack,io);assert.equal(result.healthy,true);assert.equal(replies,1);
   await advanceResearchArchive(state,config,slack,clock+600000);assert.equal(replies,1);
   assert.equal(state.db.prepare('SELECT phase FROM research_archive_events WHERE source_ts=?').get(source).phase,'sent');
  }
 }finally{state.close();}
});
test('duplicate saves retain original source; changed operation bytes and stale predecessors cannot replace head',async()=>{
 const state=setup(),bytes=packet();try{
  await ingest(state,bytes);await ingest(state,bytes,'1793491202.000001');
  assert.equal(state.db.prepare('SELECT count(*) n FROM research_archives').get().n,1);
  assert.equal(state.db.prepare('SELECT source_ts FROM research_archives').get().source_ts,ts);
  await ingest(state,packet({data:Buffer.from('changed')}),'1793491203.000001');
  assert.equal(readResearchArchive(state.db,id,query()).head_sha256,digest(bytes));
  const next=packet({command_id:'e1111111-1111-4111-8111-111111111111',previous_sha256:digest(bytes),data:Buffer.from('next')});
  await ingest(state,next,'1793491204.000001');assert.equal(readResearchArchive(state.db,id,query()).head_sha256,digest(next));
  await ingest(state,packet({command_id:'f1111111-1111-4111-8111-111111111111',previous_sha256:digest(bytes)}),'1793491205.000001');
  assert.equal(readResearchArchive(state.db,id,query()).head_sha256,digest(next));
  const rejected=state.db.prepare('SELECT diagnostic FROM research_archive_events WHERE source_ts=?').get('1793491205.000001');
  assert.deepEqual(JSON.parse(rejected.diagnostic),{stage:'research_archive',code:'archive_predecessor_conflict',outcome:'rejected',expected_head:digest(next)});
  assert.equal(readResearchArchive(state.db,'morning-20261102-r1',query()).status,'not_found');
 }finally{state.close();}
});
test('an unavailable predecessor remains pending and can arrive without losing the original child',async()=>{
 const state=setup(),parent=packet(),child=packet({command_id:'e1111111-1111-4111-8111-111111111111',previous_sha256:digest(parent),data:Buffer.from('child')});try{
  await ingest(state,child,ts);const event=state.db.prepare('SELECT * FROM research_archive_events').get();assert.equal(event.phase,'pending');assert.equal(JSON.parse(event.diagnostic).code,'archive_parent_unavailable');
  await ingest(state,parent,'1793491202.000001');assert.equal(readResearchArchive(state.db,id,query()).head_sha256,digest(parent));
  const msg=message(`!ai-research save ${id} ${digest(child)}`,ts,'FSOURCE');
  await advanceResearchArchive(state,config,slackFor([msg],child),now+600000);assert.equal(readResearchArchive(state.db,id,query()).head_sha256,digest(child));
 }finally{state.close();}
});
test('commit failure rolls back original bytes, chain head and acknowledgement together',async()=>{
 const state=setup();try{
  state.db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON research_archive_heads BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await ingest(state);assert.equal(state.db.prepare('SELECT count(*) n FROM research_archives').get().n,0);assert.equal(readResearchArchive(state.db,id,query()).status,'not_found');
  assert.equal(state.db.prepare('SELECT phase FROM research_archive_events').get().phase,'pending');
 }finally{state.close();}
});
test('unknown save acknowledgement does not replay it or block a new query of committed host results',async()=>{
 const state=setup(),bytes=packet();let attempts=0;try{
  await ingest(state,bytes,ts,async()=>{attempts++;throw Error('transport outcome unknown');});
  assert.equal(attempts,1);assert.equal(state.db.prepare('SELECT phase FROM research_archive_events').get().phase,'unknown');
  const msg=message(`!ai-research read ${id} ${uuid} receipt ${digest(bytes)} 0`,'1793491202.000001');let reply;
  const slack=slackFor([msg],null,async(_ts,text)=>{reply=text;return '1793491209.000001';});
  fixtureNative(state,config,{hash:digest(bytes),bytes:bytes.length});await new PublisherInbox(state,config).scan(slack,now);await advanceResearchArchive(state,config,slack,now);
  assert.equal(attempts,1);assert.match(reply,/"status":"stored"/);assert.match(reply,new RegExp(digest(bytes)));assert.equal(state.pending().length,0);
 }finally{state.close();}
});
test('durable history records file and later read across pages before advancing its watermark',async()=>{
 const state=setup(),bytes=packet(),msg=message(`!ai-research save ${id} ${digest(bytes)}`,ts,'FSOURCE');try{
  const inbox=new PublisherInbox(state,config);
  await inbox.scan({historyPage:async()=>({messages:[msg],next_cursor:'page2'})},now);
  assert.equal(state.db.prepare('SELECT page_cursor FROM publisher_intake_scan').get().page_cursor,'page2');
  await inbox.scan({historyPage:async()=>({messages:[],next_cursor:null})},now);
  assert.equal(state.db.prepare('SELECT count(*) n FROM research_archive_events').get().n,1);
 }finally{state.close();}
});
test('manifest receipt binds the new query thread and preserves the original archive source separately',async()=>{
 const state=setup(),bytes=packet(),readSource='1793491212.000001';try{
  await ingest(state,bytes);const msg=message(`!ai-research read ${id} ${uuid} manifest ${digest(bytes)} 0`,readSource);let reply;
  const slack=slackFor([msg],null,async(thread,text)=>{reply={thread,value:JSON.parse(text.slice('!ai-research receipt '.length))};return '1793491213.000001';});
  await new PublisherInbox(state,config).scan(slack,now+3000);await advanceResearchArchive(state,config,slack,now+3000);
  assert.equal(reply.thread,readSource);assert.equal(reply.value.source_ts,readSource);assert.equal(reply.value.archive_source_ts,ts);assert.equal(reply.value.query_id,uuid);assert.equal(reply.value.archive_sha256,digest(bytes));
 }finally{state.close();}
});
test('archive lane in a real tick persists private bytes without report publication or scheduled admission',async()=>{
 const state=setup(),bytes=packet(),msg=message(`!ai-research save ${id} ${digest(bytes)}`,ts,'FSOURCE');try{
  fixtureNative(state,config,{hash:digest(bytes),bytes:bytes.length});const result=await handoffTick(state,config,slackFor([msg],bytes),{now:()=>now,scheduleQuery:()=>assert.fail('no report to schedule'),propose:()=>assert.fail('not report content')});
  assert.deepEqual(result.errors,[]);assert.equal(state.pending().length,0);assert.equal(readResearchArchive(state.db,id,query()).status,'stored');
 }finally{state.close();}
});
const python=process.platform==='win32'?'python':'python3';
test('CD fingerprints exact archive schema and original bytes including unresolved advisory replies',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'research-cd-')),file=join(dir,'host.sqlite'),state=setup(file);
 const snapshot=()=>spawnSync(python,['-B','-c',`from pathlib import Path;from deployment.publisher_cd import snapshot;print(snapshot(Path(${JSON.stringify(file)}),settled=True))`],{encoding:'utf8'});
 try{
  new PublisherInbox(state,config);const before=snapshot();assert.equal(before.status,0,before.stderr);
  await ingest(state,packet(),ts,async()=>{throw Error('unknown reply');});const after=snapshot();assert.equal(after.status,0,after.stderr);assert.notEqual(before.stdout,after.stdout);
  state.db.exec('CREATE INDEX unsupported_research ON research_archives(hash)');assert.notEqual(snapshot().status,0);
 }finally{state.close();await rm(dir,{recursive:true,force:true});}
 const schema=spawnSync(python,['-B','-c','import json;from deployment.publisher_cd import RESEARCH_ARCHIVE_SCHEMA;print(json.dumps(RESEARCH_ARCHIVE_SCHEMA))'],{encoding:'utf8'});
 assert.equal(schema.status,0,schema.stderr);assert.deepEqual(JSON.parse(schema.stdout),ARCHIVE_SCHEMA);
});
