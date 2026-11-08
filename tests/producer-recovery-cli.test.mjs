// Synthetic transport ONLY. No real Slack, upload, Publisher or delivery calls.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,chmod} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn,spawnSync} from 'node:child_process';import {createInterface} from 'node:readline';
import {ProducerUploadState,producerTicket,postRetryDelay} from '../scripts/producer-upload.mjs';import {ProducerInspect} from '../scripts/producer-native-inspect.mjs';import {encodeBundle} from '../scripts/report-handoff.mjs';import {digest} from '../scripts/archive.mjs';
import {FILES,BASE,PROMPTS,ID,DAY,MERGE} from './helpers/cloud-sender-fixture.mjs';
process.umask(0o077);
const scope={team_id:'T123',channel_id:'C123',sender_user_id:'U123',sender_user_app_id:'A123',sender_attribution_text:'*Sent using* <@U789>',publisher_scope_sha256:'a'.repeat(64),scheduler_scope_sha256:'b'.repeat(64),scheduler_team_id:'T123',scheduler_channel_id:'D123'};
const native={publisher_user_id:'U456',publisher_bot_id:'B456',workspace_host:'fixture-workspace.slack.com'};
const bytes=await encodeBundle(FILES,ID,BASE,PROMPTS.commit),hash=digest(bytes),ticket={file_id:'FOLD',upload_url:'https://files.slack.com/upload/v1/SYNTHETIC-OLD'},safe=producerTicket(ticket);
const empty=now=>({read_context:{publisher_scope_sha256:scope.publisher_scope_sha256,scheduler_scope_sha256:scope.scheduler_scope_sha256},observed_at:now,complete:true,publisher_day:[],publisher:null,scheduler_day_claim:null,scheduler:null});
const failure={curl_exit:6,http_status:0,num_connects:0,num_redirects:0,upload_bytes:0,response_bytes:0,header_bytes:0,time_namelookup:0,time_connect:0,time_appconnect:0,time_starttransfer:0,ssl_verify_result:0,response_sha256:null};
const result=body=>({content:[{type:'text',text:JSON.stringify(body)}],isError:false});
test('real CLI under original flock: four failed original POSTs, explicit recovery, native reads, managed success and delivery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'producer-cli-synthetic-')),file=join(dir,'state.sqlite'),lock=join(dir,'runner.lock'),cfg=join(dir,'operator.json'),bin=join(dir,'bin');let child;
 try{
  await mkdir(bin);await writeFile(lock,'',{mode:0o600});await writeFile(join(dir,'bundle.json'),bytes);await writeFile(cfg,JSON.stringify({state_file:file,bundle_file:join(dir,'bundle.json'),scope,native_inspect:native}));
  await writeFile(join(bin,'curl'),`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('--output')+1],'OK');const size=a.find(x=>x.startsWith('Content-Length: ')).split(': ')[1];process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(['200','1','0',size,'2','35','.01','.02','.03','.04','0'].map(x=>x.startsWith('.')?'0'+x:x).join('\\t')));`,{mode:0o700});
  let time=Date.now()-900000;let s=new ProducerUploadState(file,scope,{now:()=>time});await chmod(file,0o600);await s.prepare(bytes);const ins=new ProducerInspect(s,native);const unknown=ins.next(ID);const unknownRow=JSON.stringify(ins.query(ID));
  s.observeDownstream(ID,empty(time));s.record(s.next(ID),ticket);
  for(let n=1;n<=4;n++){s.observeDownstream(ID,empty(time));s.record(s.next(ID),{adapter:'producer_curl_direct_v1',file_id:ticket.file_id,url_sha256:safe.url_sha256,bundle_sha256:hash,metrics:failure});time+=postRetryDelay(n);}
  const original=JSON.stringify(s.db.prepare('SELECT * FROM producer_ops ORDER BY name,attempt').all());s.close();
  for(const extra of [{HTTPS_PROXY:'',https_proxy:''},{HTTPS_PROXY:'http://synthetic.invalid',https_proxy:'http://synthetic.invalid',CURL_CA_BUNDLE:'relative-ca'}]){
   const bad=spawnSync(process.execPath,['scripts/producer-upload-cli.mjs',cfg,'--serve-managed-proxy'],{env:{...process.env,...extra},input:'{\"type\":\"tick\"}\n',encoding:'utf8'});assert.equal(bad.status,1);assert(!bad.stdout.includes('\"type\":\"ready\"'));assert(!bad.stdout.includes('\"type\":\"write\"'));
   s=new ProducerUploadState(file,scope);assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM producer_ops ORDER BY name,attempt').all()),original);s.close();
  }
  const q=x=>"'"+x.replaceAll("'","'\"'\"'")+"'";
  const launcher=`flock -n -E 73 ${q(lock)} bash -c 'test -t 0 && stty -echo -echonl -icanon min 1 time 0 && exec "$1" "$2" "$3" --serve-managed-proxy' producer-runner ${q(process.execPath)} ${q(join(process.cwd(),'scripts/producer-upload-cli.mjs'))} ${q(cfg)}`;
  child=spawn('script',['-q','-e','-c',launcher,'/dev/null'],{env:{...process.env,PATH:bin+':'+process.env.PATH,HTTPS_PROXY:'http://synthetic.invalid:8080',https_proxy:'http://synthetic.invalid:8080'},stdio:['pipe','pipe','pipe']});
  const queue=[],waiters=[];let stderr='';child.stderr.on('data',x=>stderr+=x);const lines=createInterface({input:child.stdout});lines.on('line',l=>{const x=JSON.parse(l);if(waiters.length)waiters.shift()(x);else queue.push(x);});
  const read=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CLI timeout '+stderr)),5000);waiters.push(x=>{clearTimeout(timer);resolve(x);});});
  const send=async cmd=>{child.stdin.write(JSON.stringify(cmd)+'\n');return read();};assert.equal((await read()).type,'ready');
  const inspect=async(delivered=false)=>{
   const w=await send({type:'tick'});assert.equal(w.next_action,'inspect');const command=w.arguments.message;assert.equal((await send({type:'native_result',operation_id:w.operation_id,result:{content:[]}})).type,'inspect_pending');
   const a=await send({type:'tick'});assert.equal(a.next_action,'locate_original_inspect');const source=(Date.now()/1000).toFixed(6);
   await send({type:'inspect_source_result',invocation:{tool:a.tool,arguments:a.arguments,result:result({results:`# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: #control (ID: C123)\nFrom: User (ID: U123) \nTime: synthetic\nMessage_ts: ${source}\nPermalink: [link](https://${native.workspace_host}/archives/C123/p${source.replace('.','')})\nText: \n${command} ${scope.sender_attribution_text}\n\n---\n\n`,pagination_info:'End of results - No more pages available.\n'})}});
   const t=await send({type:'tick'});assert.equal(t.next_action,'read_inspect_thread');const now=Date.now(),r={query_id:w.operation_id,request_id:ID,report_date:DAY,bundle_sha256:hash,source_ts:source,...empty(now)};
   if(delivered){const bind={request_id:ID,report_date:DAY,bundle_sha256:hash};r.publisher_day=[bind];r.publisher={...bind,file_id:'FNEW',source_ts:source,report_commit:MERGE};r.scheduler_day_claim={...bind,report_commit:MERGE};r.scheduler={...r.scheduler_day_claim,status:'sent',phase:'complete',parts_total:2,parts_sent:2,images:[{file_id:'scheduled-poster',status:'sent',error:null}]};}
   const response=await send({type:'inspect_thread_result',invocation:{tool:t.tool,arguments:t.arguments,result:result({messages:`=== THREAD PARENT MESSAGE ===\nFrom: User <user@example.test> (U123)\nTime: synthetic\nMessage TS: ${source}\n${command}\n${scope.sender_attribution_text}\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Publisher <botuser-T123-B456@slack-bots.com> (U456)\nTime: synthetic\nMessage TS: ${(now/1000+0.001).toFixed(6)}\n!ai-report inspect-receipt ${JSON.stringify(r)}\n`,pagination_info:'There are no more messages in this thread.\n'})}});assert.equal(response.type,'state',JSON.stringify(response));
  };
  await inspect();assert.equal((await send({type:'authorize_ticket_recovery',authorization:{authorization_reference:'synthetic:operator-approved',file_id:ticket.file_id,url_sha256:safe.url_sha256,bundle_sha256:hash}})).type,'recovery_authorized');
  await inspect();const tw=await send({type:'tick'});assert.equal(tw.next_action,'ticket');await send({type:'native_result',operation_id:tw.operation_id,result:{file_id:'FNEW',upload_url:'https://files.slack.com/upload/v1/SYNTHETIC-NEW'}});
  await inspect();const posted=await send({type:'tick'});assert.equal(posted.active_operations.find(x=>x.operation==='recovery_post').outcome,'confirmed');
  await inspect();const cw=await send({type:'tick'});assert.equal(cw.next_action,'complete');assert.equal(cw.arguments.file_id,'FNEW');await send({type:'native_result',operation_id:cw.operation_id,result:{content:[{type:'text',text:'synthetic ack'}]}});
  await inspect(true);assert.equal((await send({type:'tick'})).type,'done');child.stdin.write('{"type":"close"}\n');await new Promise(resolve=>child.once('exit',resolve));child=null;
  s=new ProducerUploadState(file,scope);assert.equal(JSON.stringify(s.db.prepare("SELECT * FROM producer_ops WHERE name NOT LIKE 'recovery_%' ORDER BY name,attempt").all()),original);assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM producer_inspect_queries WHERE operation_id=?').get(unknown.operation_id)),unknownRow);for(const name of ['recovery_ticket','recovery_post','recovery_complete'])assert.equal(s.db.prepare('SELECT COUNT(*) n FROM producer_ops WHERE name=?').get(name).n,1);assert.equal(s.summary(s.get(ID)).delivery.complete,true);s.close();
 }finally{child?.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
