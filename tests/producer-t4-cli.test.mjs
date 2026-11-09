// Real Linux CLI/flock/SQLite, synthetic native replies and curl. No live writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {ProducerUploadState,producerScopeHash} from '../scripts/producer-upload.mjs';
import {ProducerInspect} from '../scripts/producer-native-inspect.mjs';
import {HandoffState,handoffScope,scopeDigest} from '../scripts/handoff-state.mjs';
import {installFence} from '../scripts/producer-admission-fence.mjs';
import {installSubmission} from '../scripts/slack-submission.mjs';
import {installProducerAdmissionPolicy,installT4DirectTransportPolicy} from '../scripts/producer-local-admission.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {FILES,BASE,PROMPTS,DAY} from './helpers/cloud-sender-fixture.mjs';

process.umask(0o077);
const id='morning-20261101-r1',bytes=await encodeBundle(FILES,id,BASE,PROMPTS.commit),hash=digest(bytes);
const native={publisher_user_id:'U456',publisher_bot_id:'B456',workspace_host:'fixture-workspace.slack.com'};
const body=value=>({content:[{type:'text',text:JSON.stringify(value)}],isError:false});
const inspectDb=(file,fn)=>{const db=new DatabaseSync(file,{readOnly:true});try{return fn(db);}finally{db.close();}};

async function fixture({direct=true,restart=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'producer-t4-cli-'));
 const pub=join(dir,'publisher'),bin=join(dir,'bin');await mkdir(pub);await mkdir(bin);
 const file=join(dir,'state.sqlite'),lock=join(dir,'runner.lock'),configFile=join(dir,'publisher.json'),operator=join(dir,'operator.json');
 await writeFile(lock,'');
 const config={team_id:'T123',channel_id:'C123',sender_user_id:'U123',sender_user_app_id:'A123',sender_attribution_text:'*Sent using* <@U789>',bot_user_id:'U456',bot_id:'B456',producer_app_id:1,merger_app_id:2,slack_token_file:join(dir,'unused-token'),producer_key_file:join(dir,'unused-key'),state_dir:pub,ready_for_review:false,durable_intake:{not_before:'1793462400.000000'},scheduled_delivery:{activation_date:DAY,executable:'/usr/bin/python3',args:['/synthetic/unused-client.py']}};
 const scope={team_id:config.team_id,channel_id:config.channel_id,sender_user_id:config.sender_user_id,sender_user_app_id:config.sender_user_app_id,sender_attribution_text:config.sender_attribution_text,publisher_scope_sha256:scopeDigest(handoffScope(config)),scheduler_scope_sha256:'b'.repeat(64),scheduler_team_id:'T123',scheduler_channel_id:'D123'};
 const producer=new ProducerUploadState(file,scope);new ProducerInspect(producer,native);
 const j=await lstat(file,{bigint:true}),l=await lstat(lock,{bigint:true});
 const installation={journal_device:String(j.dev),journal_inode:String(j.ino),lock_device:String(l.dev),lock_inode:String(l.ino)};
 if(restart)producer.enableRestartRecovery('synthetic:restart',installation);
 config.producer_fence={generation:'a1111111-1111-4111-8111-111111111111',activation_ts:((Date.now()-60000)/1000).toFixed(6),producer_scope_sha256:producerScopeHash(scope),installation};
 const publisherFile=join(pub,'handoff.sqlite'),publisher=new HandoffState(publisherFile,handoffScope(config));
 installFence(publisher.db,config.producer_fence,'synthetic cutover fixture',[]);publisher.close();
 installProducerAdmissionPolicy(producer,configFile,config);if(direct)installT4DirectTransportPolicy(producer,'synthetic:t4-direct');producer.close();
 await writeFile(configFile,JSON.stringify(config));await writeFile(join(dir,'bundle.json'),bytes);
 await writeFile(operator,JSON.stringify({state_file:file,bundle_file:join(dir,'bundle.json'),scope,native_inspect:native,publisher_fence_config_file:configFile}));
 await writeFile(join(bin,'curl'),`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);if(a[a.indexOf('--noproxy')+1]!=='*'||a.includes('--insecure')||a.includes('-L'))process.exit(91);fs.writeFileSync(a[a.indexOf('--output')+1],'OK');const size=a.find(x=>x.startsWith('Content-Length: ')).split(': ')[1];process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(['200','1','0',size,'2','35','0.01','0.02','0.03','0.04','0'].join('\\t')));`,{mode:0o700});
 return {dir,pub,file,lock,operator,configFile,config,scope,publisherFile,env:{...process.env,PATH:bin+':'+process.env.PATH}};
}
function launch(f){
 const child=spawn('flock',['--no-fork','--nonblock',f.lock,process.execPath,'scripts/producer-upload-cli.mjs',f.operator,'--serve-t4-direct'],{env:f.env,stdio:['pipe','pipe','pipe']});
 const ended=once(child,'exit'),queue=[],waiters=[];let stderr='';child.stderr.on('data',b=>stderr+=b);
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);if(waiters.length)waiters.shift()(value);else queue.push(value);});
 const read=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('T4 CLI timeout: '+stderr)),10000);waiters.push(v=>{clearTimeout(timer);resolve(v);});});
 return {child,ended,read,send:cmd=>{child.stdin.write(JSON.stringify(cmd)+'\n');return read();},stop:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;lines.close();}};
}
async function fresh(cli,f){
 const write=await cli.send({type:'tick'});assert.equal(write.next_action,'inspect');const command=write.arguments.message;
 assert.equal((await cli.send({type:'native_result',operation_id:write.operation_id,result:{}})).type,'inspect_pending');
 const locate=await cli.send({type:'tick'}),source=(Date.now()/1000).toFixed(6);assert.equal(locate.next_action,'locate_original_inspect');
 const search={results:`# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: #control (ID: C123)\nFrom: User (ID: U123) \nTime: synthetic\nMessage_ts: ${source}\nPermalink: [link](https://${native.workspace_host}/archives/C123/p${source.replace('.','')})\nText: \n${command} ${f.scope.sender_attribution_text}\n\n---\n\n`,pagination_info:'End of results - No more pages available.\n'};
 assert.equal((await cli.send({type:'inspect_source_result',invocation:{tool:locate.tool,arguments:locate.arguments,result:body(search)}})).type,'located');
 const thread=await cli.send({type:'tick'});assert.equal(thread.next_action,'read_inspect_thread');
 const now=Date.now(),receipt={query_id:write.operation_id,request_id:id,report_date:DAY,bundle_sha256:hash,source_ts:source,read_context:{publisher_scope_sha256:f.scope.publisher_scope_sha256,scheduler_scope_sha256:f.scope.scheduler_scope_sha256},observed_at:now,complete:true,publisher_day:[],publisher:null,scheduler_day_claim:null,scheduler:null};
 const message={messages:`=== THREAD PARENT MESSAGE ===\nFrom: User <user@example.test> (U123)\nTime: synthetic\nMessage TS: ${source}\n${command}\n${f.scope.sender_attribution_text}\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Publisher <botuser-T123-B456@slack-bots.com> (U456)\nTime: synthetic\nMessage TS: ${((now+1)/1000).toFixed(6)}\n!ai-report inspect-receipt ${JSON.stringify(receipt)}\n`,pagination_info:'There are no more messages in this thread.\n'};
 assert.equal((await cli.send({type:'inspect_thread_result',invocation:{tool:thread.tool,arguments:thread.arguments,result:body(message)}})).type,'state');
}

test('T4 CLI preserves original journal across lock contention and unknown completion restart',{timeout:30000},async()=>{
 const f=await fixture();let cli,holder;
 try{
  const before=digest(await readFile(f.file));
  for(const mode of ['--serve','--serve-t4-direct']){
   // Direct mode without inherited flock, or silent mode downgrade, fails early.
   const rejected=spawnSync(process.execPath,['scripts/producer-upload-cli.mjs',f.operator,mode],{input:'{"type":"close"}\n',encoding:'utf8',timeout:5000});
   assert.equal(rejected.status,1,rejected.stdout+rejected.stderr);assert(!rejected.stdout.includes('"type":"ready"'));assert.equal(digest(await readFile(f.file)),before);
  }
  cli=launch(f);assert.equal((await cli.read()).type,'ready');
  await fresh(cli,f);const ticket=await cli.send({type:'tick'});assert.equal(ticket.next_action,'ticket');
  await cli.send({type:'native_result',operation_id:ticket.operation_id,result:{file_id:'F123',upload_url:'https://files.slack.com/upload/v1/SYNTHETIC'}});
  await fresh(cli,f);const posted=await cli.send({type:'tick'});assert.equal(posted.active_operations.find(o=>o.operation==='post').outcome,'confirmed');
  await fresh(cli,f);
  holder=spawn('flock',['--no-fork',join(f.pub,'handoff.lock'),'sh','-c','echo held; read release'],{stdio:['pipe','pipe','pipe']});const holderEnded=once(holder,'exit');
  await once(holder.stdout,'data');
  const blocked=await cli.send({type:'tick'});assert.equal(blocked.type,'blocked');await cli.ended;
  assert.equal(inspectDb(f.file,db=>db.prepare("SELECT count(*) n FROM producer_ops WHERE name='complete'").get().n),0);
  assert.equal(inspectDb(f.publisherFile,db=>db.prepare('SELECT count(*) n FROM producer_admission_grants').get().n),0);
  holder.stdin.end('release\n');await holderEnded;holder=null;
  cli=launch(f);assert.equal((await cli.read()).type,'ready');
  const complete=await cli.send({type:'tick'});assert.equal(complete.next_action,'complete');
  const grant=inspectDb(f.publisherFile,db=>db.prepare('SELECT * FROM producer_admission_grants').get());
  assert.equal(grant.operation_id,complete.operation_id);assert.equal(grant.file_id,'F123');assert.equal(grant.hash,hash);
  // Crash after one-shot action emission; restart must retain the unknown intent.
  await cli.stop();cli=launch(f);assert.equal((await cli.read()).type,'ready');
  const reconcile=await cli.send({type:'tick'});assert.notEqual(reconcile.next_action,'complete');
  await cli.stop();cli=null;
  const operations=inspectDb(f.file,db=>db.prepare("SELECT * FROM producer_ops WHERE name='complete'").all());
  assert.equal(operations.length,1);assert.equal(operations[0].phase,'unknown');assert.equal(operations[0].operation_id,grant.operation_id);
  assert.equal(inspectDb(f.file,db=>db.prepare('SELECT hash FROM producer_runs WHERE id=?').get(id).hash),hash);
 }finally{if(holder){holder.kill('SIGKILL');}await cli?.stop();await rm(f.dir,{recursive:true,force:true});}
});

test('admission-only installation cannot use legacy serve to bypass separate direct authorization',async()=>{
 const f=await fixture({direct:false,restart:false});
 try{
  const before=digest(await readFile(f.file));
  for(const mode of ['--serve','--serve-t4-direct']){
   const result=spawnSync('flock',['--no-fork','--nonblock',f.lock,process.execPath,'scripts/producer-upload-cli.mjs',f.operator,mode],{input:'{"type":"close"}\n',env:f.env,encoding:'utf8',timeout:5000});
   assert.equal(result.status,1,result.stdout+result.stderr);assert(!result.stdout.includes('"type":"ready"'));assert.equal(digest(await readFile(f.file)),before);
  }
 }finally{await rm(f.dir,{recursive:true,force:true});}
});

async function activateStagingFixture(f){
 f.config.slack_submission={generation:'b1111111-1111-4111-8111-111111111111',activation_ts:(Date.now()/1000).toFixed(6),first_report_date:new Date(Date.now()+8*3600000).toISOString().slice(0,10)};
 const publisher=new HandoffState(f.publisherFile,handoffScope(f.config));try{installSubmission(publisher.db,f.config,'synthetic staging cutover');}finally{publisher.close();}
 await writeFile(f.configFile,JSON.stringify(f.config));
}
test('installed Slack staging rejects the old CLI before preparing a run or any external action',async()=>{
 const f=await fixture();try{
  await activateStagingFixture(f);const before=digest(await readFile(f.file));
  const result=spawnSync('flock',['--no-fork','--nonblock',f.lock,process.execPath,'scripts/producer-upload-cli.mjs',f.operator,'--serve-t4-direct'],{input:'{"type":"tick"}\n',env:f.env,encoding:'utf8',timeout:5000});
  assert.equal(result.status,1,result.stdout+result.stderr);assert(!result.stdout.includes('"type":"ready"'));assert(!result.stdout.includes('"type":"write"'));assert.equal(digest(await readFile(f.file)),before);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('a policy change is rejected before an already-running CLI can create COMPLETE unknown',{timeout:30000},async()=>{
 const f=await fixture();let cli;
 try{
  cli=launch(f);assert.equal((await cli.read()).type,'ready');await fresh(cli,f);
  const ticket=await cli.send({type:'tick'});await cli.send({type:'native_result',operation_id:ticket.operation_id,result:{file_id:'F123',upload_url:'https://files.slack.com/upload/v1/SYNTHETIC'}});
  await fresh(cli,f);await cli.send({type:'tick'});await fresh(cli,f);
  const before=inspectDb(f.file,db=>JSON.stringify([db.prepare('SELECT * FROM producer_ops ORDER BY name,attempt').all(),db.prepare('SELECT detail FROM producer_runs').all()]));
  // Fault injection only. Actual cutover must hold the Producer lock and cannot
  // install while this session is live; this exercises the second dispatch gate.
  await activateStagingFixture(f);
  assert.equal((await cli.send({type:'tick'})).type,'blocked');await cli.ended;
  assert.equal(inspectDb(f.file,db=>JSON.stringify([db.prepare('SELECT * FROM producer_ops ORDER BY name,attempt').all(),db.prepare('SELECT detail FROM producer_runs').all()])),before);
  assert.equal(inspectDb(f.file,db=>db.prepare("SELECT count(*) n FROM producer_ops WHERE name='complete'").get().n),0);
 }finally{await cli?.stop();await rm(f.dir,{recursive:true,force:true});}
});
