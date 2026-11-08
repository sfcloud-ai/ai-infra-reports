// Original CLI/native inspect parsing with synthetic tools; never calls Slack.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile,chmod,copyFile,rename} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn,spawnSync} from 'node:child_process';import {createInterface} from 'node:readline';
import {ProducerUploadState,RESTART_RECOVERY_DELAY_MS} from '../scripts/producer-upload.mjs';import {ProducerInspect} from '../scripts/producer-native-inspect.mjs';import {encodeBundle} from '../scripts/report-handoff.mjs';import {digest} from '../scripts/archive.mjs';
import {verifyProducerJournal as legacyVerify} from './helpers/producer-journal-v76.mjs';
import {FILES,BASE,PROMPTS,ID,DAY,MERGE} from './helpers/cloud-sender-fixture.mjs';
process.umask(0o077);
const scope={team_id:'T123',channel_id:'C123',sender_user_id:'U123',sender_user_app_id:'A123',sender_attribution_text:'*Sent using* <@U789>',publisher_scope_sha256:'a'.repeat(64),scheduler_scope_sha256:'b'.repeat(64),scheduler_team_id:'T123',scheduler_channel_id:'D123'};
const native={publisher_user_id:'U456',publisher_bot_id:'B456',workspace_host:'fixture-workspace.slack.com'};
const bytes=await encodeBundle(FILES,ID,BASE,PROMPTS.commit),hash=digest(bytes),ticket={file_id:'FNEW',upload_url:'https://files.slack.com/upload/v1/SYNTHETIC-NEW'};
const empty=now=>({read_context:{publisher_scope_sha256:scope.publisher_scope_sha256,scheduler_scope_sha256:scope.scheduler_scope_sha256},observed_at:now,complete:true,publisher_day:[],publisher:null,scheduler_day_claim:null,scheduler:null});
const env={...process.env,HTTPS_PROXY:'http://synthetic.invalid:8080',https_proxy:'http://synthetic.invalid:8080'};
const nativeResult=body=>({content:[{type:'text',text:JSON.stringify(body)}],isError:false});
async function fixture(fn){
 const dir=await mkdtemp(join(tmpdir(),'producer-restart-cli-')),file=join(dir,'state.sqlite'),lock=join(dir,'runner.lock'),cfg=join(dir,'operator.json'),bin=join(dir,'bin'),bundle=join(dir,'bundle.json');
 const config={state_file:file,bundle_file:bundle,scope,native_inspect:native};
 try{
  await mkdir(bin);await writeFile(lock,'',{mode:0o600});await writeFile(cfg,JSON.stringify(config));await writeFile(bundle,bytes);
  const run=(args,input='{"type":"close"}\n',locked=true)=>spawnSync(locked?'flock':process.execPath,locked?['-n','-E','73',lock,process.execPath,'scripts/producer-upload-cli.mjs',cfg,...args]:['scripts/producer-upload-cli.mjs',cfg,...args],{env,input,encoding:'utf8'});
  const init=run(['--initialize']);assert.equal(init.status,0,init.stdout+init.stderr);
  await fn({dir,file,lock,cfg,bin,bundle,config,run});
 }finally{await rm(dir,{recursive:true,force:true});}
}
function journal(file,fn){const s=new ProducerUploadState(file,scope);try{return fn(s);}finally{s.close();}}
function readBridge(child){const queue=[],waiters=[];let stderr='',ended=false;child.stderr.on('data',x=>stderr+=x);const lines=createInterface({input:child.stdout});lines.on('line',l=>{let x;try{x=JSON.parse(l);}catch{for(const w of waiters.splice(0))w.reject(Error('Non-JSON bridge output'));return;}if(waiters.length)waiters.shift().resolve(x);else queue.push(x);});child.once('exit',()=>{ended=true;for(const w of waiters.splice(0))w.reject(Error('CLI ended '+stderr));});const read=()=>queue.length?Promise.resolve(queue.shift()):ended?Promise.reject(Error('CLI ended '+stderr)):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CLI timeout '+stderr)),5000);waiters.push({resolve:x=>{clearTimeout(timer);resolve(x);},reject:e=>{clearTimeout(timer);reject(e);}});});return {read,send:async cmd=>{child.stdin.write(JSON.stringify(cmd)+'\n');return read();}};}
async function inspect(send,{delivered=false,clockLag=0}={}){
 const w=await send({type:'tick'});assert.equal(w.next_action,'inspect',JSON.stringify(w));const command=w.arguments.message;assert.equal((await send({type:'native_result',operation_id:w.operation_id,result:{content:[]}})).type,'inspect_pending');
 const a=await send({type:'tick'});assert.equal(a.next_action,'locate_original_inspect');const source=(Date.now()/1000).toFixed(6);
 await send({type:'inspect_source_result',invocation:{tool:a.tool,arguments:a.arguments,result:nativeResult({results:`# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: #control (ID: C123)\nFrom: User (ID: U123) \nTime: synthetic\nMessage_ts: ${source}\nPermalink: [link](https://${native.workspace_host}/archives/C123/p${source.replace('.','')})\nText: \n${command} ${scope.sender_attribution_text}\n\n---\n\n`,pagination_info:'End of results - No more pages available.\n'})}});
 const t=await send({type:'tick'});assert.equal(t.next_action,'read_inspect_thread');const now=Date.now(),r={query_id:w.operation_id,request_id:ID,report_date:DAY,bundle_sha256:hash,source_ts:source,...empty(now-clockLag)};
 if(delivered){const bind={request_id:ID,report_date:DAY,bundle_sha256:hash};r.publisher_day=[bind];r.publisher={...bind,file_id:ticket.file_id,source_ts:source,report_commit:MERGE};r.scheduler_day_claim={...bind,report_commit:MERGE};r.scheduler={...r.scheduler_day_claim,status:'sent',phase:'complete',parts_total:2,parts_sent:2,images:[{file_id:'scheduled-poster',status:'sent',error:null}]};}
 const response=await send({type:'inspect_thread_result',invocation:{tool:t.tool,arguments:t.arguments,result:nativeResult({messages:`=== THREAD PARENT MESSAGE ===\nFrom: User <user@example.test> (U123)\nTime: synthetic\nMessage TS: ${source}\n${command}\n${scope.sender_attribution_text}\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Publisher <botuser-T123-B456@slack-bots.com> (U456)\nTime: synthetic\nMessage TS: ${(now/1000+0.001).toFixed(6)}\n!ai-report inspect-receipt ${JSON.stringify(r)}\n`,pagination_info:'There are no more messages in this thread.\n'})}});assert.equal(response.type,'state',JSON.stringify(response));return {query_id:w.operation_id,observed_at:r.observed_at};
}

test('policy installation is explicit/offline, retains original rows, rejects missing lock, and blocks legacy verifier without writes',()=>fixture(async({file,lock,bundle,run})=>{
 await rm(bundle);const before=await readFile(file);
 let r=run(['--enable-restart-recovery','synthetic:permission'],'',false);assert.equal(r.status,1);assert.deepEqual(await readFile(file),before);
 r=run(['--enable-restart-recovery','synthetic:permission']);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).type,'restart_recovery_enabled');
 assert.equal(journal(file,s=>s.db.prepare('SELECT COUNT(*) n FROM producer_runs').get().n),0);assert.equal(journal(file,s=>s.db.prepare('SELECT COUNT(*) n FROM producer_ops').get().n),0);
 const installed=await readFile(file);r=run(['--enable-restart-recovery','synthetic:permission']);assert.equal(r.status,1);assert.deepEqual(await readFile(file),installed);
 await assert.rejects(legacyVerify(file,scope,native),e=>e.code==='producer_journal_schema_incompatible');assert.deepEqual(await readFile(file),installed);
 await writeFile(bundle,bytes);r=run(['--serve']);assert.equal(r.status,1);assert(!r.stdout.includes('"type":"ready"'));assert.deepEqual(await readFile(file),installed);
 r=run(['--serve-managed-proxy'],'{"type":"close"}\n',false);assert.equal(r.status,1);assert.deepEqual(await readFile(file),installed);
}));

test('copied journal and replaced lock inode fail pre-mutation; policy is not portable opt-in',async()=>{
 for(const target of ['journal','lock'])await fixture(async({file,lock,bundle,run})=>{
  assert.equal(run(['--enable-restart-recovery','synthetic:permission']).status,0);
  if(target==='journal'){await copyFile(file,file+'.copy');await chmod(file+'.copy',0o600);await rename(file+'.copy',file);}else{await rename(lock,lock+'.original');await writeFile(lock,'',{mode:0o600});}
  const before=await readFile(file),r=run(['--serve-managed-proxy']);assert.equal(r.status,1,r.stdout+r.stderr);assert(!r.stdout.includes('"type":"ready"'));assert.deepEqual(await readFile(file),before);
 });
});

test('real CLI resumes abandoned unknown ticket using native empty proofs, one successor and original exact bytes through delivery',()=>fixture(async({dir,file,lock,cfg,bin,run})=>{
 let child;try{
  assert.equal(run(['--enable-restart-recovery','synthetic:permission']).status,0);
  const time=Date.now()-RESTART_RECOVERY_DELAY_MS-1000;let s=new ProducerUploadState(file,scope,{now:()=>time});await s.prepare(bytes);s.observeDownstream(ID,empty(time));const old=s.next(ID),before={...s.op(ID,'ticket')};s.close();
  await writeFile(join(bin,'curl'),`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);const input=a[a.indexOf('--data-binary')+1].slice(1);if(fs.readFileSync(input).toString('base64')!==${JSON.stringify(bytes.toString('base64'))})process.exit(99);fs.writeFileSync(a[a.indexOf('--output')+1],'OK');const size=a.find(x=>x.startsWith('Content-Length: ')).split(': ')[1];process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(['200','1','0',size,'2','35','0.01','0.02','0.03','0.04','0'].join('\\t')));`,{mode:0o700});
  child=spawn('flock',['-n','-E','73',lock,process.execPath,'scripts/producer-upload-cli.mjs',cfg,'--serve-managed-proxy'],{env:{...env,PATH:bin+':'+env.PATH},stdio:['pipe','pipe','pipe']});const {read,send}=readBridge(child);assert.equal((await read()).type,'ready');
  await inspect(send);const retired=await send({type:'tick'});assert.equal(retired.type,'ticket_abandoned');assert.equal(retired.restart_generation,1);assert.equal(retired.active_operations.length,0);assert.equal(retired.operations[0].outcome,'unknown');
  await inspect(send);const tw=await send({type:'tick'});assert.equal(tw.next_action,'ticket');assert.equal(tw.attempt,2);assert.notEqual(tw.operation_id,old.operation_id);await send({type:'native_result',operation_id:tw.operation_id,result:ticket});
  await inspect(send);const posted=await send({type:'tick'});assert.equal(posted.active_operations.find(o=>o.operation==='post').outcome,'confirmed');
  await inspect(send);const cw=await send({type:'tick'});assert.equal(cw.next_action,'complete');assert.equal(cw.arguments.file_id,ticket.file_id);await send({type:'native_result',operation_id:cw.operation_id,result:{content:[{type:'text',text:'synthetic acknowledgement'}]}});
  await inspect(send,{delivered:true});assert.equal((await send({type:'tick'})).type,'done');child.stdin.write('{"type":"close"}\n');await new Promise(resolve=>child.once('exit',resolve));child=null;
  journal(file,state=>{const original=state.db.prepare('SELECT * FROM producer_ops WHERE operation_id=?').get(old.operation_id);assert.deepEqual({...original},{...before,result:null});assert.equal(state.op(ID,'ticket').attempt,2);assert.equal(state.op(ID,'post').attempt,1);assert.equal(state.op(ID,'complete').attempt,1);assert.deepEqual(state.get(ID).bundle,bytes);assert.equal(state.summary(state.get(ID)).status,'sent');const rows=state.db.prepare('SELECT * FROM producer_restart_audit').all();assert.equal(rows.length,1);assert(!JSON.stringify(rows).includes(ticket.upload_url));});
 }finally{child?.kill('SIGKILL');}
}));


test('real CLI accepts a new authenticated recovery proof from a Publisher clock five seconds behind',()=>fixture(async({file,lock,cfg,run})=>{
 let child;try{
  assert.equal(run(['--enable-restart-recovery','synthetic:permission']).status,0);
  const time=Date.now()-RESTART_RECOVERY_DELAY_MS-1000,s=new ProducerUploadState(file,scope,{now:()=>time});await s.prepare(bytes);s.observeDownstream(ID,empty(time));const old=s.next(ID);s.close();
  child=spawn('flock',['--no-fork','-n','-E','73',lock,process.execPath,'scripts/producer-upload-cli.mjs',cfg,'--serve-managed-proxy'],{env,stdio:['pipe','pipe','pipe']});const {read,send}=readBridge(child);assert.equal((await read()).type,'ready');
  const proof=await inspect(send,{clockLag:5000});
  // The parser already authenticated this fresh receipt. Its remote clock must
  // not be ordered against the local query clock to establish causal identity.
  journal(file,state=>{const query=state.db.prepare('SELECT * FROM producer_inspect_queries WHERE query_id=?').get(proof.query_id);assert.equal(query.phase,'resolved');assert(proof.observed_at<query.started_at);assert.equal(state.get(ID).detail.preflight_query_id,proof.query_id);});
  const retired=await send({type:'tick'});assert.equal(retired.type,'ticket_abandoned');assert.equal(retired.restart_generation,1);
  journal(file,state=>{assert.equal(state.op(ID,'ticket').operation_id,old.operation_id);assert.equal(state.op(ID,'ticket').phase,'unknown');assert.equal(state.op(ID,'post'),null);assert.equal(state.op(ID,'complete'),null);assert.equal(JSON.parse(state.restartAudit(ID).original).inspect_operation_id,proof.query_id);});
  // Retirement consumed its proof. Only a distinct query may admit successor.
  const next=await send({type:'tick'});assert.equal(next.next_action,'inspect');assert.notEqual(next.operation_id,proof.query_id);await send({type:'native_result',operation_id:next.operation_id,result:{content:[]}});
  child.stdin.write('{"type":"close"}\n');await new Promise(resolve=>child.once('exit',resolve));child=null;
 }finally{child?.kill('SIGKILL');}
}));
