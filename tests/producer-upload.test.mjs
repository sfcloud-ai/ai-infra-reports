import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../scripts/archive.mjs';
import {encodeBundle,MAX_BUNDLE} from '../scripts/report-handoff.mjs';
import {ProducerUploadState,ProducerUploadAdapter,producerTicket,READ_TTL_MS,RETRY_DELAY_MS,postRetryDelay} from '../scripts/producer-upload.mjs';
import {curlUploadPlan,uploadProducerBytes,readProducerLedgers,LEDGER_READ_BUDGET_MS} from '../scripts/producer-upload-adapters.mjs';
import {FILES,BASE,PROMPTS,SCOPE as OLD,ID,DAY,MERGE,TARGET} from './helpers/cloud-sender-fixture.mjs';
const scope={team_id:OLD.team_id,channel_id:OLD.channel_id,sender_user_id:OLD.sender_user_id,sender_user_app_id:OLD.sender_user_app_id,sender_attribution_text:OLD.sender_attribution_text,publisher_scope_sha256:'a'.repeat(64),scheduler_scope_sha256:'b'.repeat(64),scheduler_team_id:'T123',scheduler_channel_id:'D123'};
const bytes=await encodeBundle(FILES,ID,BASE,PROMPTS.commit),bundleHash=digest(bytes),url='https://files.slack.com/upload/v1/CASE-Sensitive-Token?value=A%2Fb',ticket={file_id:'F123',upload_url:url},safeTicket=producerTicket(ticket);
const metrics={curl_exit:0,http_status:200,num_connects:1,num_redirects:0,upload_bytes:bytes.length,response_bytes:2,header_bytes:35,time_namelookup:0.01,time_connect:0.02,time_appconnect:0.04,time_starttransfer:0.05,ssl_verify_result:0,response_sha256:digest('OK')};
const post=m=>({adapter:'producer_curl_direct_v1',file_id:ticket.file_id,url_sha256:digest(url),bundle_sha256:bundleHash,metrics:{...metrics,...m}});
function ledger(now=TARGET,existing=false,sent=false){
 const bind={request_id:ID,report_date:DAY,bundle_sha256:bundleHash};
 return {read_context:{publisher_scope_sha256:scope.publisher_scope_sha256,scheduler_scope_sha256:scope.scheduler_scope_sha256},observed_at:now,complete:true,publisher_day:existing?[bind]:[],publisher:existing?{...bind,source_ts:'1793491200.000001',report_commit:MERGE}:null,scheduler_day_claim:existing?{...bind,report_commit:MERGE}:null,scheduler:existing?{...bind,report_commit:MERGE,status:sent?'sent':'queued',phase:sent?'complete':'pending',parts_total:2,parts_sent:sent?2:0,images:[{file_id:'scheduled-poster',status:sent?'sent':'pending',error:null}]}:null};
}
function source(){
 const text=`!ai-report publish ${ID} ${bundleHash}`,ts='1793491200.000001';
 return {complete:true,read_context:{team_id:scope.team_id,channel_id:scope.channel_id},bytes:Buffer.from(bytes),message:{type:'message',user:scope.sender_user_id,app_id:scope.sender_user_app_id,ts,text:text+' '+scope.sender_attribution_text,files:[{id:'F123'}],blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text}]}]},{type:'context',elements:[{type:'mrkdwn',text:scope.sender_attribution_text,verbatim:false}]}]},file:{id:'F123',user:scope.sender_user_id,user_team:scope.team_id,mode:'snippet',name:'ai-brief-bundle.json',is_external:false,size:bytes.length,shares:{private:{[scope.channel_id]:[{ts}]}}}};
}
async function fixture(fn){const state=new ProducerUploadState(':memory:',scope,{now:()=>time}),timeStart=TARGET;let time=timeStart;try{await state.prepare(bytes);await fn(state,{advance:ms=>time+=ms,now:()=>time});}finally{state.close();}}
function toPost(s){s.observeDownstream(ID,ledger());const a=s.next(ID);assert.equal(a.next_action,'ticket');s.record(a,ticket);s.observeDownstream(ID,ledger());return s.next(ID);}
function toComplete(s){const a=toPost(s);s.record(a,post());s.observeDownstream(ID,ledger());return s.next(ID);}
const noExecution={curl_exit:6,http_status:0,num_connects:0,num_redirects:0,upload_bytes:0,response_bytes:0,header_bytes:0,time_namelookup:0,time_connect:0,time_appconnect:0,time_starttransfer:0,ssl_verify_result:0,response_sha256:null};

test('Producer path gates day ownership, POST, complete, actual source and real delivery separately',()=>fixture(async s=>{
 assert.equal(s.next(ID).next_action,'read_original_publisher_scheduler');assert.equal(s.op(ID,'ticket'),null);
 const complete=toComplete(s);assert.equal(complete.next_action,'complete');assert.equal(complete.arguments.channel_id,scope.channel_id);assert(!JSON.stringify(complete).includes('!ai-notice'));
 s.record(complete,{acknowledged:true});assert.equal(s.next(ID).next_action,'read_original_file_and_share');assert.equal(s.summary(s.get(ID)).status,'pending');
 s.observeSource(ID,source());assert.equal(s.summary(s.get(ID)).status,'intake_verified');
 s.observeDownstream(ID,ledger(TARGET,true,true));assert.equal(s.next(ID).type,'done');assert.equal(s.next(ID).status,'sent');assert.equal(s.op(ID,'complete').attempt,1);
}));
test('same date cannot be re-keyed, rewritten or revised',()=>fixture(async s=>{
 await assert.rejects(s.prepare(Buffer.from(bytes.toString().replace(ID,'replacement-request'))),/Date already reserved/);
 await assert.rejects(s.prepare(Buffer.concat([bytes,Buffer.from(' ')])),/Original bundle bytes changed/);
 const changed=new Map([...FILES].map(([p,b])=>[p.replace('/r1/','/r2/'),p.endsWith('report.json')?Buffer.from(JSON.stringify({...JSON.parse(b),revision:2})):b]));
 await assert.rejects(s.prepare(await encodeBundle(changed,'revision-replacement',BASE,PROMPTS.commit)),/Date already reserved/);
}));
test('original recovery accepts declared revision siblings without resetting its source or send identity',()=>fixture(async s=>{
 const evidence=ledger(TARGET,true,true);
 evidence.publisher_day.push({request_id:'morning-20261101-r2',report_date:DAY,bundle_sha256:'c'.repeat(64)});
 s.observeDownstream(ID,evidence);s.observeSource(ID,source());s.observeDownstream(ID,evidence);assert.equal(s.next(ID).type,'done');assert.equal(s.op(ID,'ticket'),null);
 evidence.publisher_day[1].report_date='2026-11-02';assert.throws(()=>s.observeDownstream(ID,evidence));
}));
test('lost ticket response never obtains another file',()=>fixture(async s=>{
 s.observeDownstream(ID,ledger());const a=s.next(ID);assert.equal(s.next(ID).next_action,'reconcile_original_operation');assert.equal(s.op(ID,'ticket').attempt,1);
 assert.throws(()=>s.record(a,{file_id:'FOTHER'}));assert.equal(s.op(ID,'ticket').phase,'unknown');
 s.record(a,ticket);s.record(a,ticket);assert.throws(()=>s.record(a,{...ticket,file_id:'FOTHER'}),/Replacement/);
}));
test('each process death after durable intent leaves only original reconciliation',async()=>{
 for(const stage of ['ticket','post','complete']){
  const dir=await mkdtemp(join(tmpdir(),'producer-crash-')),file=join(dir,'state.sqlite');let s=new ProducerUploadState(file,scope,{now:()=>TARGET});
  try{
   await s.prepare(bytes);s.observeDownstream(ID,ledger());
   if(stage!=='ticket'){const a=s.next(ID);s.record(a,ticket);s.observeDownstream(ID,ledger());}
   if(stage==='complete'){const a=s.next(ID);s.record(a,post());s.observeDownstream(ID,ledger());}
   s.close();s=null;
   const child=spawnSync(process.execPath,['--input-type=module','-e',`import {ProducerUploadState} from './scripts/producer-upload.mjs';const s=new ProducerUploadState(${JSON.stringify(file)},${JSON.stringify(scope)},{now:()=>${TARGET}});s.next(${JSON.stringify(ID)});process.exit(21);`],{encoding:'utf8'});assert.equal(child.status,21,child.stderr);
   s=new ProducerUploadState(file,scope,{now:()=>TARGET});const a=s.next(ID);assert.equal(a.write_allowed,false);assert.equal(s.op(ID,stage).phase,'unknown');assert.equal(s.op(ID,stage).attempt,1);
  }finally{s?.close();await rm(dir,{recursive:true,force:true});}
 }
});
test('concurrent connections receive just one ticket dispatch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'producer-concurrent-')),file=join(dir,'state.sqlite'),a=new ProducerUploadState(file,scope,{now:()=>TARGET}),b=new ProducerUploadState(file,scope,{now:()=>TARGET});
 try{await a.prepare(bytes);a.observeDownstream(ID,ledger());assert.equal(a.next(ID).type,'write');assert.equal(b.next(ID).type,'blocked');assert.equal(b.op(ID,'ticket').attempt,1);}finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}
});
test('HTTP 000, timeout, TLS/reset and zero upload are not evidence of non-execution',async()=>{
 for(const m of [{...noExecution,curl_exit:28},{...noExecution,curl_exit:35},{...noExecution,curl_exit:60},{...noExecution,curl_exit:56},{...noExecution,curl_exit:0},{...noExecution,curl_exit:7,num_connects:1},{...noExecution,curl_exit:6,header_bytes:1},{http_status:401},{http_status:503}])await fixture(async s=>{const a=toPost(s);s.record(a,post(m));assert.equal(s.op(ID,'post').phase,'unknown');assert.equal(s.next(ID).write_allowed,false);assert.equal(s.op(ID,'complete'),null);});
});
test('proven direct DNS/connect failure persists backoff without a lifetime retry cutoff',async()=>{
 for(const curl_exit of [6,7])await fixture(async(s,c)=>{
  let a=toPost(s);
  for(let attempt=1;attempt<=6;attempt++){
   assert.equal(a.attempt,attempt);assert.equal(a.file_id,'F123');assert.equal(a.url_sha256,digest(url));assert.equal(a.bundle_sha256,bundleHash);
   s.record(a,post({...noExecution,curl_exit}));assert.equal(s.op(ID,'post').phase,'not_executed');
   if(attempt<6){assert.equal(s.next(ID).type,'wait');c.advance(postRetryDelay(attempt));s.observeDownstream(ID,ledger(c.now()));a=s.next(ID);}
  }
  assert.equal(s.next(ID).type,'wait');c.advance(postRetryDelay(6));s.observeDownstream(ID,ledger(c.now()));assert.equal(s.next(ID).attempt,7);assert.equal(s.op(ID,'ticket').attempt,1);assert.equal(s.op(ID,'complete'),null);
 });
});
test('safe same-ticket retry can succeed without repeating ticket or completing early',()=>fixture(async(s,c)=>{
 const a=toPost(s);s.record(a,post(noExecution));c.advance(RETRY_DELAY_MS);s.observeDownstream(ID,ledger(c.now()));const retry=s.next(ID);s.record(retry,post());s.observeDownstream(ID,ledger(c.now()));assert.equal(s.next(ID).next_action,'complete');
 assert.throws(()=>s.record(a,post()),/Original operation/);
}));
test('wrong hash/file/ticket or malformed metrics cannot confirm POST or leak error text',async()=>{
 for(const change of [{file_id:'FOTHER'},{url_sha256:'e'.repeat(64)},{bundle_sha256:'e'.repeat(64)},{metrics:{...metrics,error:'SECRET'}},{metrics:{...metrics,time_connect:NaN}}])await fixture(async s=>{const a=toPost(s);assert.throws(()=>s.record(a,{...post(),...change}));assert.equal(s.next(ID).type,'blocked');});
});
test('unknown completion is reconciled with real source, never retried',()=>fixture(async s=>{
 const a=toComplete(s);s.record(a,{acknowledged:false});assert.equal(s.next(ID).next_action,'read_original_file_and_share');s.observeSource(ID,source());assert.equal(s.next(ID).next_action,'read_original_publisher_scheduler');assert.equal(s.op(ID,'complete').attempt,1);
}));
test('complete acknowledgement, search snippet and wrong actual bytes are insufficient',async()=>{
 for(const change of [e=>e.bytes=Buffer.from('other'),e=>e.complete=false,e=>e.file.id='FOTHER',e=>e.message.files[0].id='FOTHER',e=>e.message.user='UOTHER',e=>e.file.shares={},e=>e.read_context.channel_id='COTHER',e=>e.message.text='File upload complete'])await fixture(async s=>{s.record(toComplete(s),{acknowledged:true});const e=source();change(e);assert.throws(()=>s.observeSource(ID,e));assert.equal(s.summary(s.get(ID)).status,'pending');});
});
test('downstream sent never substitutes for actual source proof',()=>fixture(async s=>{
 s.observeDownstream(ID,ledger(TARGET,true,true));assert.equal(s.next(ID).next_action,'read_original_file_and_share');assert.equal(s.op(ID,'ticket'),null);assert.notEqual(s.summary(s.get(ID)).status,'sent');s.observeSource(ID,source());s.observeDownstream(ID,ledger(TARGET,true,true));assert.equal(s.next(ID).type,'done');
}));
test('stale, absent, mismatched or incomplete date ownership cannot grant writes',async()=>{
 for(const change of [e=>e.complete=false,e=>e.observed_at-=READ_TTL_MS,e=>e.observed_at++,e=>e.read_context.scheduler_scope_sha256='f'.repeat(64),e=>e.publisher_day=[{request_id:'other',report_date:DAY,bundle_sha256:bundleHash}],e=>e.scheduler_day_claim={request_id:'other'},e=>e.publisher={request_id:'other'}])await fixture(async s=>{const e=ledger();change(e);assert.throws(()=>s.observeDownstream(ID,e));assert.equal(s.next(ID).write_allowed,false);assert.equal(s.op(ID,'ticket'),null);});
});
test('freshness is checked again at dispatch and prior ownership cannot disappear',()=>fixture(async(s,c)=>{
 s.observeDownstream(ID,ledger());c.advance(READ_TTL_MS);assert.equal(s.next(ID).type,'read');assert.equal(s.op(ID,'ticket'),null);
 s.observeDownstream(ID,ledger(c.now(),true));assert.throws(()=>s.observeDownstream(ID,ledger(c.now())),/cannot disappear/);assert.equal(s.next(ID).next_action,'read_original_file_and_share');
}));
test('source timestamp and all real delivery parts are mandatory',async()=>{
 for(const change of [e=>e.publisher.source_ts='1793491200.000999',e=>e.scheduler.report_commit='f'.repeat(40),e=>e.scheduler.parts_sent=1,e=>e.scheduler.images=[],e=>e.scheduler.images[0].status='unknown'])await fixture(async s=>{s.record(toComplete(s),{acknowledged:true});s.observeSource(ID,source());const e=ledger(TARGET,true,true);change(e);assert.throws(()=>s.observeDownstream(ID,e));assert.notEqual(s.summary(s.get(ID)).status,'sent');});
});
test('ticket parser never persists URL or native instructional tail',()=>fixture(async s=>{
 const native={content:[{type:'text',text:JSON.stringify({result:`Upload URL generated successfully!\n\nFile ID: F123\nUpload URL: ${url}\n\nInstructions:\nSECRET INSTRUCTION`})}]};
 s.observeDownstream(ID,ledger());s.record(s.next(ID),native);const state=JSON.stringify(s.get(ID))+JSON.stringify(s.op(ID,'ticket'));
 assert(!state.includes(url));assert(!state.includes('SECRET'));assert(!JSON.stringify(s.next(ID)).includes(url));
 for(const t of [{...ticket,upload_url:url+'#secret'},{...ticket,upload_url:'https://evil.test/upload/v1/a'},{...ticket,upload_url:url+'\nHeader: secret'}])assert.throws(()=>producerTicket(t));
}));
test('adapter never fabricates native API or repeats failed native calls',()=>fixture(async s=>{
 s.observeDownstream(ID,ledger());let calls=0;
 const adapter=new ProducerUploadAdapter(s,{callTool:async()=>{calls++;throw Error(url+' SECRET');},upload:()=>assert.fail()});
 await adapter.step(ID);await adapter.step(ID);assert.equal(calls,1);assert.equal(s.op(ID,'ticket').phase,'unknown');assert(!JSON.stringify(s.op(ID,'ticket')).includes('SECRET'));
}));
test('adapter restores only original ticket and uses bytes fixed in journal',()=>fixture(async s=>{
 s.observeDownstream(ID,ledger());let calls=[],uploads=0;const io={callTool:async(tool,args)=>{calls.push({tool,args});return calls.length===1?ticket:{content:[{type:'text',text:'successful'}]};},upload:async({bytes:b,ticket:t})=>{uploads++;assert.deepEqual(b,bytes);assert.equal(t.upload_url,url);return post();}};
 let adapter=new ProducerUploadAdapter(s,io);await adapter.step(ID);adapter=new ProducerUploadAdapter(s,io);
 assert.equal((await adapter.step(ID)).next_action,'read_original_publisher_scheduler');s.observeDownstream(ID,ledger());
 assert.equal((await adapter.step(ID)).next_action,'restore_original_ticket');assert.equal(s.op(ID,'post'),null);assert.throws(()=>adapter.restoreTicket(ID,{...ticket,upload_url:url+'x'}));adapter.restoreTicket(ID,ticket);
 await adapter.step(ID);s.observeDownstream(ID,ledger());await adapter.step(ID);assert.equal(uploads,1);assert.equal(calls.length,2);assert.equal(s.op(ID,'complete').phase,'confirmed');await adapter.step(ID);assert.equal(calls.length,2);
}));
test('curl plan has no automatic retry, redirect, proxy or URL argv and preserves exact signed bytes',()=>{
 const plan=curlUploadPlan({url,input:'/tmp/input',output:'/tmp/output',size:123});assert.equal(plan.args[0],'-q');assert(!plan.args.some(a=>a.includes(url)));assert.equal(plan.stdin,`url = "${url}"\n`);assert(!plan.args.includes('--location'));assert.equal(plan.args[plan.args.indexOf('--retry')+1],'0');assert.equal(plan.args[plan.args.indexOf('--noproxy')+1],'*');assert(plan.args.includes('Content-Length: 123'));
});
test('concrete curl adapter collects safe 000 metrics without recording stderr or credentials',async()=>{
 let observed;
 const spawnCurl=(_exe,args,options)=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};let stdin='';child.stdin.on('data',b=>stdin+=b);
  child.stdin.on('finish',()=>{observed={args,options,stdin};child.stdout.write('000\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0');child.emit('close',6);});return child;
 };
 const result=await uploadProducerBytes({bytes,ticket:safeTicket},{spawnCurl});assert.deepEqual(result.metrics,noExecution);assert(!JSON.stringify(result).includes(url));assert.equal(observed.stdin,`url = "${url}"\n`);assert.equal(observed.options.stdio[2],'ignore');
});

async function databases(fn){
 const dir=await mkdtemp(join(tmpdir(),'producer-ledgers-')),publisher_database=join(dir,'publisher.sqlite'),scheduler_database=join(dir,'scheduler.sqlite');
 const p=new DatabaseSync(publisher_database),s=new DatabaseSync(scheduler_database);
 p.exec('CREATE TABLE scope(id INTEGER PRIMARY KEY,value TEXT); CREATE TABLE jobs(id TEXT,hash TEXT,source_ts TEXT,bytes BLOB,detail TEXT)');p.prepare('INSERT INTO scope VALUES(1,?)').run(scope.publisher_scope_sha256);
 s.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE scheduled_notices(request_id TEXT,report_date TEXT,record TEXT,bundle BLOB,phase TEXT); CREATE TABLE requests(id TEXT,status TEXT,parts_total INTEGER,parts_sent INTEGER); CREATE TABLE parts(request_id TEXT,status TEXT); CREATE TABLE image_parts(request_id TEXT,file_id TEXT,ordinal INTEGER,status TEXT,error_code TEXT)');s.prepare('INSERT INTO meta VALUES(?,?)').run('scheduled_delivery_scope_v1',scope.scheduler_scope_sha256);
 try{await fn({p,s,dir,config:{publisher_database,scheduler_database,scope},read:()=>readProducerLedgers({publisher_database,scheduler_database,scope},{request_id:ID,report_date:DAY},{now:()=>TARGET})});}finally{p.close();s.close();await rm(dir,{recursive:true,force:true});}
}
function populate({p,s}){
 p.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(ID,bundleHash,'1793491200.000001',bytes,JSON.stringify({commit:MERGE}));
 const record={report_request_id:ID,report_date:DAY,bundle_sha256:bundleHash,report_commit:MERGE};
 s.prepare('INSERT INTO scheduled_notices VALUES(?,?,?,?,?)').run(ID,DAY,JSON.stringify(record),bytes,'complete');s.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(ID,'sent',2,2);s.prepare('INSERT INTO parts VALUES(?,?)').run(ID,'sent');s.prepare('INSERT INTO image_parts VALUES(?,?,?,?,?)').run(ID,'scheduled-poster',1,'sent',null);
 s.prepare('INSERT INTO meta VALUES(?,?)').run('notice_day:'+digest(JSON.stringify([scope.scheduler_team_id,scope.scheduler_channel_id,DAY])),ID);
}
test('real read-only ledger adapter verifies original schemas and real per-part counts',()=>databases(async d=>{
 await assert.rejects(d.read(),/native inspect/);populate(d);assert.deepEqual(await d.read(),ledger(TARGET,true,true));
 d.s.prepare("UPDATE parts SET status='unknown'").run();await assert.rejects(d.read(),/part counts/);
}));
test('read-only ledger adapter cannot treat not_found, legacy or other-date requests as empty day',async()=>{
 for(const change of [
  d=>d.s.prepare('INSERT INTO meta VALUES(?,?)').run('notice_edition:unknown','legacy'),
  d=>d.s.prepare('INSERT INTO meta VALUES(?,?)').run('notice_day:'+digest(JSON.stringify([scope.scheduler_team_id,scope.scheduler_channel_id,DAY])),'legacy'),
  d=>d.s.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(ID,'unknown',2,0),
  d=>d.s.prepare("UPDATE meta SET value='wrong' WHERE key='scheduled_delivery_scope_v1'").run()
 ])await databases(async d=>{change(d);await assert.rejects(d.read());});
});
test('read-only adapters never perform Store constructor recovery on sending rows',()=>databases(async d=>{
 populate(d);d.s.prepare("UPDATE requests SET status='sending'").run();d.s.prepare("UPDATE parts SET status='sending'").run();d.s.prepare('UPDATE requests SET parts_sent=1').run();
 const before=await readFile(d.config.scheduler_database);await d.read();const after=await readFile(d.config.scheduler_database);assert.deepEqual(after,before);assert.equal(d.s.prepare('SELECT status FROM requests').get().status,'sending');
}));
test('foreign journal is refused before creating any Producer tables',()=>databases(async d=>{
 const before=await readFile(d.config.publisher_database);assert.throws(()=>new ProducerUploadState(d.config.publisher_database,scope),/dedicated Producer journal/);assert.deepEqual(await readFile(d.config.publisher_database),before);
 assert.equal(d.p.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'producer_%'").get().n,0);
}));
test('adapter refreshes stale daily evidence before requesting a lost original ticket',()=>fixture(async(s,c)=>{
 s.observeDownstream(ID,ledger());s.record(s.next(ID),ticket);c.advance(READ_TTL_MS);
 const adapter=new ProducerUploadAdapter(s,{callTool:()=>assert.fail(),upload:()=>assert.fail()});assert.equal((await adapter.step(ID)).next_action,'read_original_publisher_scheduler');assert.equal(s.op(ID,'post'),null);
}));

test('late original completion receipt cannot undo verified delivery or dispatch a second upload',()=>fixture(async s=>{
 const completion=toComplete(s),e=ledger(TARGET,true,true);e.publisher.file_id='F123';s.observeDownstream(ID,e);assert.equal(s.next(ID).type,'done');
 s.record(completion,{acknowledged:true});assert.equal(s.next(ID).type,'done');assert.equal(s.op(ID,'ticket').attempt,1);assert.equal(s.op(ID,'post').attempt,1);assert.equal(s.op(ID,'complete').attempt,1);
}));


test('ledger reads fetch BLOBs one at a time and keep only bounded job metadata',t=>databases(async d=>{
 populate(d);const prepare=DatabaseSync.prototype.prepare;let blobs=0;
 t.mock.method(DatabaseSync.prototype,'prepare',function(sql){const stmt=prepare.call(this,sql);return {
  all:(...args)=>{const rows=stmt.all(...args);assert(rows.every(r=>!Object.hasOwn(r,'bytes')&&!Object.hasOwn(r,'bundle')),'Never eagerly collect BLOB rows');return rows;},
  get:(...args)=>{const row=stmt.get(...args);if(row&&(Object.hasOwn(row,'bytes')||Object.hasOwn(row,'bundle')))blobs++;return row;}
 };});
 assert.deepEqual(await d.read(),ledger(TARGET,true,true));assert.equal(blobs,2);
}));
test('Publisher count and BLOB length limits reject before decoding invalid or oversized data',async()=>{
 await databases(async d=>{const insert=d.p.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)');d.p.exec('BEGIN');for(let n=0;n<1001;n++)insert.run('bounded-job-'+n,bundleHash,'1793491200.000001',Buffer.from('x'),'{}');d.p.exec('COMMIT');await assert.rejects(d.read(),/bounded Publisher scan/);});
 for(const n of [0,MAX_BUNDLE+1])await databases(async d=>{d.p.prepare('INSERT INTO jobs VALUES(?,?,?,zeroblob(?),?)').run(ID,bundleHash,'1793491200.000001',n,'{}');await assert.rejects(d.read(),/Bounded original Publisher bundle/);});
 await databases(async d=>{populate(d);d.s.prepare('UPDATE scheduled_notices SET bundle=zeroblob(?)').run(MAX_BUNDLE+1);await assert.rejects(d.read(),/Bounded original scheduler bundle/);});
});
test('ledger metadata and bundle fetches use the same original read snapshots',()=>databases(async d=>{
 populate(d);d.p.exec('PRAGMA journal_mode=WAL');d.s.exec('PRAGMA journal_mode=WAL');let calls=0,changed=false;
 const result=await readProducerLedgers(d.config,{request_id:ID,report_date:DAY},{now:()=>TARGET,monotonicNow:()=>{
  if(++calls===6){d.p.prepare("UPDATE jobs SET bytes=x'00'").run();d.s.prepare("UPDATE scheduled_notices SET bundle=x'00'").run();changed=true;}return 0;
 }});
 assert(changed);assert.deepEqual(result,ledger(TARGET,true,true));assert.equal(d.p.prepare('SELECT length(bytes) AS n FROM jobs').get().n,1);assert.equal(d.s.prepare('SELECT length(bundle) AS n FROM scheduled_notices').get().n,1);
}));
test('45-second monotonic read budget fails closed after decoding and before proof return',()=>databases(async d=>{
 populate(d);assert(LEDGER_READ_BUDGET_MS<READ_TTL_MS);let total=0;
 await readProducerLedgers(d.config,{request_id:ID,report_date:DAY},{now:()=>TARGET,monotonicNow:()=>{total++;return 0;}});
 const beforeP=await readFile(d.config.publisher_database),beforeS=await readFile(d.config.scheduler_database);
 for(const expiresAt of [2,7,total]){
  let calls=0;await assert.rejects(readProducerLedgers(d.config,{request_id:ID,report_date:DAY},{now:()=>TARGET,monotonicNow:()=>++calls>=expiresAt?LEDGER_READ_BUDGET_MS:0}),/read time budget exceeded/);
 }
 assert.deepEqual(await readFile(d.config.publisher_database),beforeP);assert.deepEqual(await readFile(d.config.scheduler_database),beforeS);
 await fixture(async state=>{let calls=0;await assert.rejects(async()=>state.observeDownstream(ID,await readProducerLedgers(d.config,{request_id:ID,report_date:DAY},{now:()=>TARGET,monotonicNow:()=>++calls>=7?LEDGER_READ_BUDGET_MS:0})),/read time budget exceeded/);assert.equal(state.get(ID).detail.preflight_at,undefined);assert.equal(state.op(ID,'ticket'),null);assert.equal(state.next(ID).type,'read');});
}));
test('bounded scanning still decodes every historical bundle rather than inferring its date from ID',()=>databases(async d=>{
 populate(d);const otherDay='2026-10-31',otherId='historical-request-no-date';
 const files=new Map([...FILES].map(([path,data])=>[path.replace(DAY,otherDay),path.endsWith('/report.json')?Buffer.from(JSON.stringify({...JSON.parse(data),date:otherDay})):data]));
 const history=await encodeBundle(files,otherId,BASE,PROMPTS.commit);d.p.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(otherId,digest(history),'1793404800.000001',history,'{}');assert.deepEqual(await d.read(),ledger(TARGET,true,true));
 d.p.prepare('UPDATE jobs SET hash=? WHERE id=?').run('f'.repeat(64),otherId);await assert.rejects(d.read(),/Publisher bundle binding differs/);
}));
