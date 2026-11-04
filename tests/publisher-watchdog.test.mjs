import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,chmod,readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {validateWatchdogConfig,shanghaiDay,checkPublisherHealth,checkDailyDelivery,inspectWatchdog,WatchdogJournal,WatchdogSlack,advanceWatchdogAlerts,schedulerStatus,watchdogMain,readDayBindings} from '../scripts/publisher-watchdog.mjs';
import {HandoffState} from '../scripts/handoff-state.mjs';
import {withHandoffLock} from '../scripts/handoff-lock.mjs';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {digest} from '../scripts/archive.mjs';
import {FILES,BASE} from './helpers/cloud-sender-fixture.mjs';

const now=Date.parse('2026-11-04T00:01:00Z'),commit='a'.repeat(40),hash='b'.repeat(64);
const health={healthy:true,checked_at:new Date(now).toISOString(),pid:123,commit};
const service={active:'active',sub:'running',pid:123,process_alive:true,directory:'/releases/'+commit,process_directory:'/releases/'+commit};
const binding={request_id:'morning-20261104-r1',report_date:'2026-11-04',report_commit:commit,bundle_sha256:hash,published:true};
const sent={...binding,status:'sent',phase:'complete',parts_total:2,parts_sent:2,images:[{file_id:'scheduled-poster',status:'sent',error:null}]};
const c={publisher_config:path.resolve('publisher.json'),state_dir:path.resolve('watchdog'),unit:'publisher.service',heartbeat_max_age_seconds:300,deadline_grace_seconds:60};
const publisher={scheduled_delivery:{activation_date:'2026-11-04'}};
const observation={category:'publisher_health',issues:['publisher_not_running']};
const inspection={checked_at:new Date(now).toISOString(),observations:[observation]};
const slackConfig={team_id:'T123',channel_id:'C123',bot_user_id:'U456',bot_id:'B456'};

test('watchdog preflight cooldown survives journal reopen without another HTTP request',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'watchdog-preflight-')),filename=path.join(directory,'watchdog.sqlite');let journal,calls=0;
 try{
  const client=clock=>new WatchdogSlack(slackConfig,'synthetic',async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'1800'}});},{now:()=>clock,cooldowns:{deadline:method=>journal.methodDeadline(method),defer:(method,deadline)=>journal.deferMethod(method,deadline)}});
  journal=new WatchdogJournal(filename,{});
  await assert.rejects(client(now).preflight(),error=>error.diagnostic.retry_at===now+1800000);
  journal.close();journal=new WatchdogJournal(filename,{});
  await assert.rejects(client(now+120000).preflight());assert.equal(calls,1);
  assert.equal(journal.methodReady('conversations.history',now+120000),true);
  await assert.rejects(client(now+1800000).preflight());assert.equal(calls,2);
 }finally{journal?.close();await rm(directory,{recursive:true,force:true});}
});

test('read-only Publisher ledger works with an active WAL and after its writer closes',{skip:process.platform!=='linux'||process.getuid()===0},async()=>{
 for(const openWriter of [false,true]){
  const directory=await mkdtemp(path.join(os.tmpdir(),'watchdog-readonly-')),filename=path.join(directory,'handoff.sqlite');let state;
  try{
   await writeFile(filename,'',{mode:0o600});
   await withHandoffLock(directory,async()=>{
    state=new HandoffState(filename,{});
    const bytes=await encodeBundle(FILES,'readonly-wal',BASE,'b'.repeat(40));
    state.admit({request_id:'readonly-wal',hash:digest(bytes),source_ts:'1793491200.000001'},bytes);
    if(!openWriter){state.close();state=null;}
   });
   const entries=await readdir(directory),before=await readFile(filename);
   if(!openWriter)assert(!entries.some(name=>name.endsWith('-wal')||name.endsWith('-shm')));
   for(const entry of entries)await chmod(path.join(directory,entry),0o400);await chmod(directory,0o500);
   const result=await readDayBindings({state_dir:directory},'2026-11-01');
   assert.equal(result.length,1);assert.equal(result[0].request_id,'readonly-wal');assert.equal(result[0].published,false);
   assert.deepEqual(await readFile(filename),before);assert.deepEqual((await readdir(directory)).sort(),entries.sort());
  }finally{
   await chmod(directory,0o700);for(const entry of await readdir(directory))await chmod(path.join(directory,entry),0o600);
   state?.close();await rm(directory,{recursive:true,force:true});
  }
 }
});

test('CANTOPEN uses a locked snapshot retaining committed WAL rows without changing the source',{skip:process.platform!=='linux'||process.getuid()===0},async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'watchdog-cantopen-')),filename=path.join(directory,'handoff.sqlite');
 const exec=DatabaseSync.prototype.exec;let state,first=true;
 try{
  await writeFile(filename,'',{mode:0o600});
  await withHandoffLock(directory,async()=>{
   state=new HandoffState(filename,{});
   const bytes=await encodeBundle(FILES,'cantopen-wal',BASE,'b'.repeat(40));
   state.admit({request_id:'cantopen-wal',hash:digest(bytes),source_ts:'1793491200.000001'},bytes);
  });
  const before=await readFile(filename),wal=await readFile(filename+'-wal');assert(wal.length>0);
  DatabaseSync.prototype.exec=function(sql){
   if(first&&sql==='BEGIN'){first=false;throw Object.assign(Error('unable to open database file'),{code:'ERR_SQLITE_ERROR',errcode:14});}
   return exec.call(this,sql);
  };
  const result=await readDayBindings({state_dir:directory},'2026-11-01');
  assert.equal(first,false);assert.equal(result.length,1);assert.equal(result[0].request_id,'cantopen-wal');
  assert.deepEqual(await readFile(filename),before);assert.deepEqual(await readFile(filename+'-wal'),wal);
  // A snapshot must still respect an active writer, and corruption must not
  // be reclassified as the recoverable missing-sidecar condition.
  first=true;await withHandoffLock(directory,async()=>{
   await assert.rejects(readDayBindings({state_dir:directory},'2026-11-01'),error=>error.code==='SQLITE_BUSY');
  });
  const corrupt=Object.assign(Error('database disk image is malformed'),{code:'ERR_SQLITE_ERROR',errcode:11});
  DatabaseSync.prototype.exec=function(sql){if(sql==='BEGIN')throw corrupt;return exec.call(this,sql);};
  await assert.rejects(readDayBindings({state_dir:directory},'2026-11-01'),error=>error===corrupt);
 }finally{DatabaseSync.prototype.exec=exec;state?.close();await rm(directory,{recursive:true,force:true});}
});

test('watchdog rejects an excessive daily backlog before fetching any bundle payload',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'watchdog-backlog-')),filename=path.join(directory,'handoff.sqlite');
 const prepare=DatabaseSync.prototype.prepare;let state,payloads=0;
 try{
  await writeFile(filename,'',{mode:0o600});state=new HandoffState(filename,{});
  for(let i=0;i<12;i++){
   const id='watchdog-backlog-'+i,bytes=await encodeBundle(FILES,id,BASE,'b'.repeat(40));
   state.admit({request_id:id,hash:digest(bytes),source_ts:'1793491200.'+String(i).padStart(6,'0')},bytes);
  }
  state.close();state=null;
  DatabaseSync.prototype.prepare=function(...args){
   const statement=prepare.apply(this,args);
   for(const method of ['all','get']){
    const original=statement[method];statement[method]=function(...params){
     const result=original.apply(this,params);
     for(const row of method==='all'?result:[result])if(row?.bytes instanceof Uint8Array)payloads++;
     return result;
    };
   }
   return statement;
  };
  await assert.rejects(readDayBindings({state_dir:directory},'2026-11-01'),/Ambiguous daily report count/);
  assert.equal(payloads,0);
  // The same read path still decodes each permitted report and preserves binding.
  const db=new DatabaseSync(filename);try{db.prepare('DELETE FROM jobs WHERE id NOT IN (?,?)').run('watchdog-backlog-0','watchdog-backlog-1');}finally{db.close();}
  const bindings=await readDayBindings({state_dir:directory},'2026-11-01');
  assert.deepEqual(bindings.map(b=>b.request_id),['watchdog-backlog-0','watchdog-backlog-1']);assert.equal(payloads,2);
 }finally{DatabaseSync.prototype.prepare=prepare;state?.close();await rm(directory,{recursive:true,force:true});}
});

test('watchdog scope survives nested key reordering while preserving real identity changes',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'watchdog-scope-')),filename=path.join(directory,'watchdog.sqlite');let journal;
 const scope={unit:'publisher.service',publisher_scope:{team_id:'T123',channel_id:'C123'},scheduled_delivery:{activation_date:'2026-11-04',executable:'/usr/bin/python3',args:['first','second']}};
 const reordered={scheduled_delivery:{args:['first','second'],executable:'/usr/bin/python3',activation_date:'2026-11-04'},publisher_scope:{channel_id:'C123',team_id:'T123'},unit:'publisher.service'};
 try{
  journal=new WatchdogJournal(filename,scope);const alert=journal.observe(observation,inspection.checked_at);journal.close();journal=null;
  journal=new WatchdogJournal(filename,reordered);assert.equal(journal.pending()[0].id,alert.id);journal.close();journal=null;
  for(const changed of [{...reordered,publisher_scope:{...reordered.publisher_scope,channel_id:'C999'}},{...reordered,scheduled_delivery:{...reordered.scheduled_delivery,args:['second','first']}}])assert.throws(()=>new WatchdogJournal(filename,changed),/Watchdog scope changed/);
 }finally{journal?.close();await rm(directory,{recursive:true,force:true});}
});

test('watchdog rejects unsafe configuration and computes the Shanghai delivery day',()=>{
 assert.equal(validateWatchdogConfig(c),c);
 for(const patch of [{unit:'x; restart publisher.service'},{heartbeat_max_age_seconds:0},{deadline_grace_seconds:901},{destination:'D123'},{publisher_config:'relative.json'}])assert.throws(()=>validateWatchdogConfig({...c,...patch}));
 assert.deepEqual(shanghaiDay(Date.parse('2026-11-03T23:59:59Z')),{date:'2026-11-04',due:Date.parse('2026-11-04T00:00:00Z')});
});
test('a stale healthy flag cannot conceal a dead process or a different release',()=>{
 assert.deepEqual(checkPublisherHealth(health,service,{now}),[]);
 const stopped={...service,active:'failed',sub:'failed',pid:0,process_alive:false};
 const issues=checkPublisherHealth({...health,checked_at:new Date(now-301000).toISOString()},stopped,{now});
 for(const code of ['publisher_not_running','heartbeat_stale','heartbeat_process_mismatch'])assert.ok(issues.includes(code));
 assert.ok(checkPublisherHealth({...health,commit:'c'.repeat(40)},service,{now}).includes('heartbeat_release_mismatch'));
 assert.ok(checkPublisherHealth({...health,pid:124},service,{now}).includes('heartbeat_process_mismatch'));
 assert.ok(checkPublisherHealth({...health,checked_at:new Date(now+31000).toISOString()},service,{now}).includes('heartbeat_stale'));
});
test('an unavailable systemd or proc observation is not presented as a dead service',()=>{
 assert.deepEqual(checkPublisherHealth(health,null,{now}),['publisher_service_unavailable']);
 assert.deepEqual(checkPublisherHealth(health,{...service,process_alive:null,process_directory:null},{now}),['publisher_process_unavailable']);
});
test('only exact original binding and confirmed text plus image completion satisfies delivery',async()=>{
 assert.deepEqual(await checkDailyDelivery([binding],async id=>{assert.equal(id,binding.request_id);return sent;}),{request_id:binding.request_id,parts_sent:2,parts_total:2,issues:[]});
 for(const patch of [{parts_sent:1},{phase:'queued'},{status:'unknown'},{images:[]},{images:[{file_id:'scheduled-poster',status:'unknown',error:null}]},{images:[{file_id:'scheduled-poster',status:'sent',error:'failed'}]}]){
  assert.deepEqual((await checkDailyDelivery([binding],async()=>({...sent,...patch}))).issues,['daily_delivery_incomplete']);
 }
 for(const key of ['request_id','report_date','report_commit','bundle_sha256'])assert.deepEqual((await checkDailyDelivery([binding],async()=>({...sent,[key]:'wrong'}))).issues,['daily_delivery_binding_mismatch']);
 assert.deepEqual((await checkDailyDelivery([binding],async()=>({status:'not_found'}))).issues,['daily_delivery_not_admitted']);
 assert.deepEqual((await checkDailyDelivery([binding],async()=>{throw Error('secret');})).issues,['scheduler_status_unavailable']);
 assert.deepEqual((await checkDailyDelivery([],()=>assert.fail('query'))).issues,['daily_report_missing']);
 assert.deepEqual((await checkDailyDelivery([{...binding,published:false}],()=>assert.fail('query'))).issues,['daily_report_unpublished']);
 assert.deepEqual((await checkDailyDelivery([binding,binding],()=>assert.fail('query'))).issues,['daily_report_ambiguous']);
});
test('independent inspection checks the deadline without admitting or sending a report',async()=>{
 let queries=0,reads=0;
 const io={now,readService:async()=>service,readHealth:async()=>health,readBindings:async(_,date)=>{reads++;assert.equal(date,binding.report_date);return [binding];},query:async id=>{queries++;assert.equal(id,binding.request_id);return sent;}};
 assert.equal((await inspectWatchdog(c,publisher,{...io,now:now-1})).observations.length,1);
 assert.equal(reads,0);assert.equal(queries,0);
 const result=await inspectWatchdog(c,publisher,io);assert.equal(result.observations.length,2);assert.deepEqual(result.observations[1].issues,[]);assert.equal(queries,1);
 const failed=await inspectWatchdog(c,publisher,{...io,readService:async()=>{throw Error('private path');},readBindings:async()=>{throw Error('raw db error');}});
 assert.equal(JSON.stringify(failed).includes('private path'),false);assert.equal(JSON.stringify(failed).includes('raw db error'),false);
 assert.deepEqual(failed.observations[1].issues,['daily_report_ledger_unavailable']);
});
test('status subprocess can only receive a read request',async()=>{
 const program="let s='';process.stdin.on('data',p=>s+=p);process.stdin.on('end',()=>{const r=JSON.parse(s);if(Object.keys(r).sort().join()!=='action,request_id'||r.action!=='status')process.exit(2);process.stdout.write(JSON.stringify({status:'not_found',request_id:r.request_id}));});";
 const result=await schedulerStatus({activation_date:'2026-11-04',executable:process.execPath,args:['-e',program]},binding.request_id);
 assert.deepEqual(result,{status:'not_found',request_id:binding.request_id});
});
test('alert uncertainty survives restart and absent reconciliation never reposts',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'watchdog-test-')),filename=path.join(dir,'watchdog.sqlite');let journal;
 let sends=0,reads=0,found=null;
 const slack={alert:async()=>{sends++;throw Error('timeout after post');},findAlert:async()=>{reads++;return found;}};
 try{
  journal=new WatchdogJournal(filename,{channel:'C123'});
  await advanceWatchdogAlerts(journal,slack,inspection,{now});assert.equal(sends,1);assert.equal(journal.pending()[0].phase,'unknown');journal.close();
  journal=new WatchdogJournal(filename,{channel:'C123'});
  await advanceWatchdogAlerts(journal,slack,inspection,{now:now+60000});assert.equal(sends,1);assert.equal(reads,1);
  found='1793750461.000001';await advanceWatchdogAlerts(journal,slack,inspection,{now:now+120000});assert.equal(sends,1);assert.deepEqual(journal.pending(),[]);
  await advanceWatchdogAlerts(journal,slack,inspection,{now:now+180000});assert.equal(sends,1);
 }finally{journal?.close();await rm(dir,{recursive:true,force:true});}
});
test('history throttling pauses every watchdog reconciliation across restart while posts can progress',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'watchdog-history-limit-')),filename=path.join(directory,'watchdog.sqlite'),scope={channel:'C123'};let journal,clock=now,reads=0,posts=0;
 const observations=[{category:'first',issues:['publisher_unhealthy']},{category:'second',issues:['daily_report_missing']}];
 const slack=new WatchdogSlack(slackConfig,'xoxb-synthetic',async(url,options)=>{
  if(url.endsWith('chat.postMessage')){posts++;const {text,channel}=JSON.parse(options.body),ts=Math.floor(clock/1000)+'.000001';return Response.json({ok:true,channel,ts,message:{type:'message',text,user:'U456',bot_id:'B456',ts}});}
  assert(url.includes('conversations.history'));reads++;
  return reads===1?new Response('',{status:429,headers:{'retry-after':'1800'}}):Response.json({ok:true,messages:[]});
 },{now:()=>clock});
 const check=()=>advanceWatchdogAlerts(journal,slack,{checked_at:new Date(clock).toISOString(),observations},{now:clock});
 try{
  journal=new WatchdogJournal(filename,scope);
  for(const o of observations){const alert=journal.observe(o,inspection.checked_at);assert(journal.claim(alert.id,clock));journal.unknown(alert.id);}
  await check();assert.equal(reads,1);assert.equal(posts,0);journal.close();journal=new WatchdogJournal(filename,scope);
  clock+=60000;observations.push({category:'new-daily-incident',issues:['daily_report_missing']});await check();assert.equal(posts,1);assert.equal(reads,1);
  clock=now+1800000-1;await check();assert.equal(reads,1);
  clock++;await check();assert.equal(reads,3);assert.equal(posts,1);
 }finally{journal?.close();await rm(directory,{recursive:true,force:true});}
});

test('post throttling also blocks new incidents until the response-based deadline after restart',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'watchdog-post-limit-')),filename=path.join(directory,'watchdog.sqlite'),scope={channel:'C123'};let journal,clock=now,posts=0;
 const slack=new WatchdogSlack(slackConfig,'xoxb-synthetic',async(_url,options)=>{
  if(++posts===1){clock+=30000;return new Response('',{status:429,headers:{'retry-after':'1800'}});}
  const {text,channel}=JSON.parse(options.body),ts=Math.floor(clock/1000)+'.000001';return Response.json({ok:true,channel,ts,message:{type:'message',text,user:'U456',bot_id:'B456',ts}});
 },{now:()=>clock});
 slack.findAlert=()=>assert.fail('known rejection needs no reconciliation');
 try{
  journal=new WatchdogJournal(filename,scope);await advanceWatchdogAlerts(journal,slack,inspection,{now:clock});const deadline=clock+1800000;
  journal.close();journal=new WatchdogJournal(filename,scope);
  const next={checked_at:new Date(clock).toISOString(),observations:[{...observation,issues:[]},{category:'new-incident',issues:['daily_report_missing']}]};
  clock=deadline-1;await advanceWatchdogAlerts(journal,slack,next,{now:clock});assert.equal(posts,1);
  clock++;await advanceWatchdogAlerts(journal,slack,next,{now:clock});assert.equal(posts,2);assert.deepEqual(journal.pending(),[]);
 }finally{journal?.close();await rm(directory,{recursive:true,force:true});}
});

test('explicit rejection retries with backoff, but an active alert is deduplicated',async()=>{
 const journal=new WatchdogJournal(':memory:',{channel:'C123'});let calls=0;
 const slack={alert:async()=>{calls++;if(calls===1)throw Object.assign(Error('rejected'),{outcome:'not_sent'});return '1793750521.000001';},findAlert:()=>assert.fail('not an unknown write')};
 try{
  await advanceWatchdogAlerts(journal,slack,inspection,{now});assert.equal(calls,1);
  await advanceWatchdogAlerts(journal,slack,inspection,{now:now+59999});assert.equal(calls,1);
  await advanceWatchdogAlerts(journal,slack,inspection,{now:now+60000});assert.equal(calls,2);
  await advanceWatchdogAlerts(journal,slack,inspection,{now:now+120000});assert.equal(calls,2);
  await advanceWatchdogAlerts(journal,slack,{...inspection,observations:[{...observation,issues:[]}]},{now:now+180000});
  await advanceWatchdogAlerts(journal,slack,inspection,{now:now+240000});assert.equal(calls,3);
 }finally{journal.close();}
});

test('watchdog exit remains failed until an uncertain alert is reconciled without reposting',async()=>{
 const journal=new WatchdogJournal(':memory:',{channel:'C123'}),outputs=[];let sends=0,found=null,clock=now;
 const slack={alert:async()=>{sends++;throw Error('private post timeout');},findAlert:async()=>found};
 const io={run:async()=>({...inspection,alerts_enabled:true,alerts_pending:await advanceWatchdogAlerts(journal,slack,inspection,{now:clock})}),log:text=>outputs.push(JSON.parse(text)),error:()=>assert.fail('pending diagnostics should remain structured')};
 try{
  assert.equal(await watchdogMain(['fixture.json','--live'],io),1);
  assert.equal(outputs.at(-1).alerts_pending[0].phase,'unknown');
  clock+=60000;assert.equal(await watchdogMain(['fixture.json','--live'],io),1);assert.equal(sends,1);
  slack.findAlert=async()=>{throw Error('private history error');};clock+=60000;
  assert.equal(await watchdogMain(['fixture.json','--live'],io),1);assert.equal(sends,1);
  slack.findAlert=async()=> '1793750461.000001';clock+=60000;
  assert.equal(await watchdogMain(['fixture.json','--live'],io),0);assert.deepEqual(outputs.at(-1).alerts_pending,[]);assert.equal(sends,1);
  assert(!JSON.stringify(outputs).includes('private'));
 }finally{journal.close();}
});

test('known alert rejection and its backoff remain visible as failed service checks',async()=>{
 const journal=new WatchdogJournal(':memory:',{channel:'C123'});let calls=0,clock=now;
 const slack={alert:async()=>{calls++;if(calls===1)throw Object.assign(Error('rejected'),{outcome:'not_sent'});return '1793750521.000001';},findAlert:()=>assert.fail('no unknown outcome')};
 const io={run:async()=>({alerts_enabled:true,alerts_pending:await advanceWatchdogAlerts(journal,slack,inspection,{now:clock})}),log:()=>{},error:()=>assert.fail('unexpected exception')};
 try{
  assert.equal(await watchdogMain(['fixture.json','--live'],io),1);
  clock+=59999;assert.equal(await watchdogMain(['fixture.json','--live'],io),1);assert.equal(calls,1);
  clock++;assert.equal(await watchdogMain(['fixture.json','--live'],io),0);assert.equal(calls,2);
 }finally{journal.close();}
});
test('a concurrent claimant cannot repeat a post and cleared pending alerts are cancelled',()=>{
 const journal=new WatchdogJournal(':memory:',{channel:'C123'});
 try{
  const alert=journal.observe(observation,inspection.checked_at);assert.equal(journal.claim(alert.id,now),true);assert.equal(journal.claim(alert.id,now),false);
  journal.observe({category:'other',issues:['daily_report_missing']},inspection.checked_at);
  journal.observe({category:'other',issues:[]},inspection.checked_at);
  assert.equal(journal.pending().some(a=>a.category==='other'),false);
 }finally{journal.close();}
});
test('Slack alert goes only to configured control room and exposes no raw rejection',async()=>{
 let calls=0;
 const client=new WatchdogSlack(slackConfig,'xoxb-synthetic',async(url,options)=>{
  assert.equal(url,'https://slack.com/api/chat.postMessage');const body=JSON.parse(options.body);assert.equal(body.channel,'C123');assert.equal(body.text,'example');assert.equal(body.thread_ts,undefined);calls++;
  return new Response(JSON.stringify({ok:false,error:'channel_not_found',private_detail:'private provider body'}),{status:200});
 });
 await assert.rejects(()=>client.alert('example'),error=>error.outcome==='not_sent'&&!error.message.includes('private provider body'));assert.equal(calls,1);
 const limited=new WatchdogSlack(slackConfig,'xoxb-synthetic',async()=>new Response('rate limited',{status:429,headers:{'retry-after':'1800'}}));
 await assert.rejects(()=>limited.alert('example'),error=>error.outcome==='not_sent'&&error.retry_after_ms===1800000);
 const apiLimited=new WatchdogSlack(slackConfig,'xoxb-synthetic',async()=>new Response(JSON.stringify({ok:false,error:'ratelimited'}),{status:200,headers:{'retry-after':'1800'}}));
 await assert.rejects(()=>apiLimited.alert('example'),error=>error.outcome==='not_sent'&&error.retry_after_ms===1800000);
 const unknown=new WatchdogSlack(slackConfig,'xoxb-synthetic',async()=>new Response('gateway error',{status:502}));
 await assert.rejects(()=>unknown.alert('example'),error=>error.outcome===undefined);
});

test('ambiguous Slack API failures remain read-only instead of repeating an alert',async()=>{
 for(const [status,error]of [[200,'internal_error'],[200,'fatal_error'],[200,'unknown_provider_error'],[503,'channel_not_found']]){
  const journal=new WatchdogJournal(':memory:',{channel:'C123'});let posts=0,reads=0;
  const slack=new WatchdogSlack(slackConfig,'xoxb-synthetic',async()=>{posts++;return new Response(JSON.stringify({ok:false,error}),{status});});
  slack.findAlert=async()=>{reads++;return null;};
  try{
   await advanceWatchdogAlerts(journal,slack,inspection,{now});
   assert.equal(journal.pending()[0].phase,'unknown');
   await advanceWatchdogAlerts(journal,slack,inspection,{now:now+60000});
   await advanceWatchdogAlerts(journal,slack,inspection,{now:now+3600000});
   assert.equal(posts,1);assert.equal(reads,2);assert.equal(journal.pending()[0].phase,'unknown');
  }finally{journal.close();}
 }
});
test('reconciliation requires exact text, author, channel and complete history',async()=>{
 const alert={text:'unique alert',created:now/1000};
 const message={type:'message',subtype:'bot_message',text:alert.text,ts:'1793750461.000001',user:'U456',bot_id:'B456',channel:'C123',team:'T123'};
 const clientFor=data=>new WatchdogSlack(slackConfig,'xoxb-synthetic',async()=>new Response(JSON.stringify({ok:true,...data}),{status:200}));
 assert.equal(await clientFor({messages:[message]}).findAlert(alert),message.ts);
 assert.equal(await clientFor({messages:[]}).findAlert(alert),null);
 for(const data of [{messages:[{...message,user:'U999'}]},{messages:[{...message,edited:{}}]},{messages:[{...message,thread_ts:'1793750000.000001'}]},{messages:[message,message]},{messages:[message],has_more:true}])await assert.rejects(()=>clientFor(data).findAlert(alert));
});
