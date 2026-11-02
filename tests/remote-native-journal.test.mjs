import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import sharp from 'sharp';
import {readReports,digest} from '../scripts/archive.mjs';
import {encodeBundle,decodeBundle} from '../scripts/report-handoff.mjs';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {NoticeOutbox,notificationScope,advanceNotice,noticeResponseText} from '../scripts/notice-outbox.mjs';
import {encodeNoticeCommand} from '../scripts/notice-command.mjs';
import {remoteJournal,remoteJournalSchemaObjects,remoteFinalInputHash} from '../scripts/remote-native-journal.mjs';
import {NativeRemoteJournal} from '../scripts/native-remote-journal.mjs';
import {nativeReceiptSearch,nativeCompletionArguments} from '../scripts/native-notice.mjs';
import {handoffTick} from '../scripts/run-handoff.mjs';
const ID='synthetic-remote-journal',MERGE='d'.repeat(40),SOURCE='1793448000.000001';
const config={team_id:'T123',channel_id:'C123',sender_user_id:'U123',bot_user_id:'U456',bot_id:'B456',producer_app_id:10,merger_app_id:11,slack_token_file:path.resolve('unused-token'),producer_key_file:path.resolve('unused-key'),state_dir:path.resolve('unused-state'),ready_for_review:false,notification_destination:'D123',notification_not_before:'1793447000.000001'};
const nativeConfig={...config,workspace_host:'fixture-workspace.slack.com'};
const dir='reports/2026-10-31/r1/',files=new Map([...await readReports('tests/fixtures/archive')].filter(([p])=>p.startsWith(dir)));
const png=await sharp({create:{width:20,height:20,channels:3,background:'white'}}).png().toBuffer();
const report=JSON.parse(files.get(dir+'report.json'));report.poster='assets/poster.png';report.images=[{path:report.poster,sha256:digest(png),alt:'Synthetic poster'}];
files.set(dir+'report.json',Buffer.from(JSON.stringify(report)));files.set(dir+report.poster,png);
const bytes=await encodeBundle(files,ID,'a'.repeat(40),'b'.repeat(40)),bundle=await decodeBundle(bytes);
const proof={publication_status:'verified',commit:MERGE,request_id:ID,bundle_sha256:bundle.hash,edition:'2026-10-31/r1',url:'https://sfcloud-ai.github.io/ai-infra-reports/2026-10-31/r1/',poster_sha256:digest(png)};
const fixed={report_request_id:ID,bundle_sha256:bundle.hash,attempt_id:'synthetic-attempt-01',file_id:'FSYNTHETIC'};
const A='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
let serial=0;
const command=(action,extra={})=>({schema_version:'1.0',command_id:`fixture-command-${String(++serial).padStart(8,'0')}`,action,...fixed,...(action==='journal_settle'?{executor_id:A}:{}),...extra});
function connect(filename=':memory:'){
 const state=new HandoffState(filename,handoffScope(config));
 if(!state.get(ID)){state.admit({request_id:ID,hash:bundle.hash,source_ts:SOURCE},bytes);state.move(ID,'received','receipt_sent',{commit:MERGE,proof});}
 const outbox=new NoticeOutbox(state,notificationScope(config)),sent=[];
 const io={verify:async()=>proof,receipt:async(thread,text)=>{sent.push({thread,text});return '1793450000.000001';},findReceipt:async()=>null};
 return {state,outbox,io,sent};
}
function admit(r,c){const data=encodeNoticeCommand(c),ts=`1793449000.${String(++serial).padStart(6,'0')}`;r.outbox.admit({request_id:c.command_id,hash:digest(data),source_ts:ts},data);return {data,ts};}
async function submit(r,c,io=r.io){admit(r,c);await advanceNotice(r.outbox,c.command_id,io);return r.outbox.command(c.command_id).response;}
async function setup(filename){const r=connect(filename);if(!r.outbox.notice(ID))await submit(r,command('prepare_bundle'));return r;}
const open=r=>submit(r,command('journal_open',{expected_revision:0}));
function invocation(r,c){
 const op=r.outbox.command(c.command_id),data=op.bytes,ts=op.source_ts,receipt='1793450000.000001';
 return {options:{bytes:data,sourceTs:ts},invocation:{tool:'mcp__codex_apps__slack_slack_search_public_and_private',arguments:nativeReceiptSearch(data,nativeConfig),result:{content:[{type:'text',text:JSON.stringify({pagination_info:'End of results - No more pages available.\n',results:`# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: #control (ID: C123)\nFrom: Publisher (ID: U456)  [BOT]\nTime: synthetic\nMessage_ts: ${receipt}\nPermalink: [link](https://fixture-workspace.slack.com/archives/C123/p${receipt.replace('.','')}?thread_ts=${ts}&cid=C123)\nText: \n${noticeResponseText(op.response)}\n\n---\n\n`})}]}}};
}
test('remote open reuses the original stored bundle and binds immutable identity without a send grant',async()=>{
 const r=await setup();try{
  const before=r.state.get(ID).bytes,notice=r.outbox.notice(ID),o=await open(r);
  assert.equal(o.send_authorized,false);assert.equal(o.new_intent,false);assert.equal(o.journal.binding.file_id,fixed.file_id);
  assert.deepEqual(r.state.get(ID).bytes,before);assert.deepEqual(r.outbox.notice(ID),notice);assert.equal(remoteJournalSchemaObjects(r.state.db).length,6);
  assert.equal((await open(r)).reason,'journal_already_open');assert.equal(remoteJournal(r.state.db,ID).revision,1);
  for(const patch of [{file_id:'FCHANGED'},{attempt_id:'changed-attempt'},{bundle_sha256:'f'.repeat(64)}])await assert.rejects(()=>submit(r,command('journal_read',patch)));
  assert.throws(()=>r.state.db.prepare('UPDATE remote_native_runs SET binding=?').run('{}'),/Immutable/);
  assert.throws(()=>r.state.db.exec('DELETE FROM remote_native_runs'),/cannot be deleted/);
 }finally{r.state.close();}
});
test('an old completion intent cannot be imported or granted again',async()=>{
 const r=await setup();try{await submit(r,command('begin'));await assert.rejects(()=>open(r),/cannot be imported/);assert.equal(remoteJournal(r.state.db,ID),null);}finally{r.state.close();}
});
test('intent and its reply are one transaction, including a response storage failure',async()=>{
 const r=await setup();try{
  await open(r);
  r.state.db.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE OF response ON notice_commands BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
  await assert.rejects(()=>submit(r,command('journal_intent',{expected_revision:1,executor_id:A,operation:'begin',input_sha256:'a'.repeat(64)})),/synthetic storage/);
  assert.equal(remoteJournal(r.state.db,ID).revision,1);assert.equal(remoteJournal(r.state.db,ID).operations.length,0);
 }finally{r.state.close();}
});
test('an unknown operation with no evidence cannot be executed later or replaced',async()=>{
 const r=await setup();try{
  await open(r);const begin=command('begin');
  await submit(r,command('journal_intent',{expected_revision:1,executor_id:A,operation:'begin',input_sha256:digest(encodeNoticeCommand(begin))}));
  await assert.rejects(()=>submit(r,command('journal_settle',{expected_revision:2,executor_id:B,operation:'begin',outcome:'unknown',evidence_command_id:null})),/original executor/);
  await submit(r,command('journal_settle',{expected_revision:2,operation:'begin',outcome:'unknown',evidence_command_id:null}));
  await assert.rejects(()=>submit(r,begin),/unknown writes only reconcile/);
  await assert.rejects(()=>submit(r,command('journal_intent',{expected_revision:3,executor_id:B,operation:'begin',input_sha256:'f'.repeat(64)})),/input changed/);
  assert.equal(r.outbox.notice(ID).phase,'reserved');
 }finally{r.state.close();}
});
test('atomic intent and response survive a lost receipt and server restart without replaying writes',async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),'remote-journal-'));let r=await setup(path.join(tmp,'state.sqlite'));
 try{
  await open(r);const begin=command('begin'),c=command('journal_intent',{expected_revision:1,executor_id:A,operation:'begin',input_sha256:digest(encodeNoticeCommand(begin))});let writes=0;
  await submit(r,c,{...r.io,receipt:async()=>{writes++;throw Error('response disconnected');}});
  assert.equal(r.outbox.command(c.command_id).phase,'response_unknown');assert.equal(remoteJournal(r.state.db,ID).operations.length,1);
  r.state.close();r=connect(path.join(tmp,'state.sqlite'));
  await advanceNotice(r.outbox,c.command_id,{...r.io,receipt:()=>assert.fail('must not retry'),findReceipt:async()=>null});assert.equal(writes,1);
  const read=command('journal_read');admit(r,read);
  await handoffTick(r.state,config,{history:async()=>[],controlReceipt:r.io.receipt,findControlReceipt:async()=>null},{});
  assert.equal(r.outbox.command(read.command_id).phase,'response_sent');assert.equal(r.outbox.command(c.command_id).phase,'response_unknown');
  const existing=await submit(r,command('journal_intent',{expected_revision:2,executor_id:B,operation:'begin',input_sha256:c.input_sha256}));
  assert.equal(existing.reason,'journal_existing_intent');assert.equal(existing.new_intent,false);assert.equal(existing.send_authorized,false);
  await submit(r,begin); // Original synthetic operation reached T4; its client reply is lost.
  const unknown=await submit(r,command('journal_settle',{expected_revision:2,operation:'begin',outcome:'unknown',evidence_command_id:null}));assert.equal(unknown.journal.operations[0].phase,'unknown');
  await assert.rejects(()=>submit(r,command('journal_intent',{expected_revision:3,executor_id:B,operation:'final_complete',input_sha256:'a'.repeat(64)})),/reconciliation/);
  const reconciled=await submit(r,command('journal_settle',{expected_revision:3,operation:'begin',outcome:'acknowledged',evidence_command_id:begin.command_id}));assert.equal(reconciled.journal.operations[0].phase,'acknowledged');
  await assert.rejects(()=>submit(r,command('journal_intent',{expected_revision:4,executor_id:B,operation:'final_complete',input_sha256:'a'.repeat(64)})),/Restart/);
 }finally{r.state.close();await rm(tmp,{recursive:true,force:true});}
});
test('unknown final writes require actual checker evidence and cannot be cleared by a claimed result',async()=>{
 const r=await setup();try{
  await open(r);const begin=command('begin');await submit(r,command('journal_intent',{expected_revision:1,executor_id:A,operation:'begin',input_sha256:digest(encodeNoticeCommand(begin))}));await submit(r,begin);
  await submit(r,command('journal_settle',{expected_revision:2,operation:'begin',outcome:'acknowledged',evidence_command_id:begin.command_id}));
  await assert.rejects(()=>submit(r,command('journal_intent',{expected_revision:3,executor_id:A,operation:'final_complete',input_sha256:'a'.repeat(64)})),/original file and exact bundle/);
  await submit(r,command('journal_intent',{expected_revision:3,executor_id:A,operation:'final_complete',input_sha256:remoteFinalInputHash(bundle,r.outbox.notice(ID))}));
  await submit(r,command('journal_settle',{expected_revision:4,operation:'final_complete',outcome:'unknown',evidence_command_id:null}));
  await assert.rejects(()=>submit(r,command('journal_settle',{expected_revision:5,operation:'final_complete',outcome:'acknowledged',evidence_command_id:begin.command_id})),/verified original delivery/);
  assert.throws(()=>encodeNoticeCommand(command('journal_settle',{expected_revision:5,operation:'final_complete',outcome:'acknowledged',evidence_command_id:null,result:{ok:true}})));
  const check=command('check',{message_ts:'1793448500.000001'});
  const checked=await submit(r,check,{...r.io,checkNotice:async request=>({slack_status:'verified',wecom_status:'not_checked',publication_status:'not_checked',receipt:{channel:config.notification_destination,ts:request.message_ts,relay_request_id:'auto:'+request.message_ts,file_id:fixed.file_id,transport_sha256:bundle.hash,transport_bytes:bytes.length,poster_sha256:digest(png),poster_bytes:png.length},observed_publication_commit:MERGE,messages_sent:0,state_changed:false})});
  assert.equal(checked.verification.slack_status,'verified');
  const done=await submit(r,command('journal_settle',{expected_revision:5,operation:'final_complete',outcome:'acknowledged',evidence_command_id:check.command_id}));assert.equal(done.journal.revision,6);
  const n=r.outbox.notice(ID),record=command('record_bundle',{message_ts:check.message_ts,text_sha256:n.detail.text_sha256,transport_sha256:bundle.hash,transport_bytes:bytes.length,poster_sha256:digest(png),poster_bytes:png.length});
  await submit(r,command('journal_intent',{expected_revision:6,executor_id:B,operation:'record',input_sha256:digest(encodeNoticeCommand(record))}));await submit(r,record);
  const closed=await submit(r,command('journal_settle',{expected_revision:7,operation:'record',outcome:'acknowledged',evidence_command_id:record.command_id}));assert.equal(closed.journal.phase,'complete');
 }finally{r.state.close();}
});
test('durable deferrals have no lifetime cutoff and preserve backoff across reopened journals',async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),'remote-defer-'));let r=await setup(path.join(tmp,'state.sqlite'));
 try{
  await open(r);let due=Date.now()+86400000,revision=1;
  for(let i=0;i<3;i++){
   due+=365*86400000;const reply=await submit(r,command('journal_defer',{expected_revision:revision,next_attempt_at:due,reason:'publication_retry'}));revision++;
   assert.equal(reply.journal.next_attempt_at,due);assert.equal(reply.journal.deferrals,i+1);
   r.state.close();r=connect(path.join(tmp,'state.sqlite'));assert.equal(remoteJournal(r.state.db,ID).next_attempt_at,due);
  }
  const stale=await submit(r,command('journal_defer',{expected_revision:1,next_attempt_at:Date.now(),reason:'read_retry'}));assert.equal(stale.reason,'journal_revision_conflict');
  const blocked=await submit(r,command('journal_intent',{expected_revision:revision,executor_id:A,operation:'begin',input_sha256:'a'.repeat(64)}));assert.equal(blocked.reason,'journal_retry_not_due');assert.equal(blocked.journal.operations.length,0);
 }finally{r.state.close();await rm(tmp,{recursive:true,force:true});}
});
test('two independent processes racing one revision can allocate only one intent',async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),'remote-cas-')),filename=path.join(tmp,'state.sqlite');const r=await setup(filename);
 try{
  await open(r);
  const script=`import {HandoffState,handoffScope} from './scripts/handoff-state.mjs';import {NoticeOutbox,notificationScope,advanceNotice} from './scripts/notice-outbox.mjs';import {encodeNoticeCommand} from './scripts/notice-command.mjs';import {digest} from './scripts/archive.mjs';const [file,configText,commandText,ts]=process.argv.slice(1);const config=JSON.parse(configText),c=JSON.parse(commandText),state=new HandoffState(file,handoffScope(config));try{const outbox=new NoticeOutbox(state,notificationScope(config)),bytes=encodeNoticeCommand(c);outbox.admit({request_id:c.command_id,hash:digest(bytes),source_ts:ts},bytes);await advanceNotice(outbox,c.command_id,{receipt:async()=> '1793450000.000001'});console.log(JSON.stringify(outbox.command(c.command_id).response));}finally{state.close();}`;
  const run=(executor,index)=>new Promise((resolve,reject)=>{const c=command('journal_intent',{expected_revision:1,executor_id:executor,operation:'begin',input_sha256:'a'.repeat(64)}),p=spawn(process.execPath,['--input-type=module','-e',script,filename,JSON.stringify(config),JSON.stringify(c),`1793449200.00000${index}`],{stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',error='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>error+=v);p.on('error',reject);p.on('close',code=>code?reject(Error(error)):resolve(JSON.parse(out)));});
  const results=await Promise.all([run(A,1),run(B,2)]);assert.equal(results.filter(v=>v.new_intent).length,1);assert.equal(results.filter(v=>v.reason==='journal_revision_conflict').length,1);assert.equal(remoteJournal(r.state.db,ID).operations.length,1);
 }finally{r.state.close();await rm(tmp,{recursive:true,force:true});}
});
test('native client accepts only its own fresh receipt once, and restart never reuses it',async()=>{
 const r=await setup();try{
  await open(r);const client=new NativeRemoteJournal(nativeConfig,fixed),data=client.command('journal_intent',{expected_revision:1,operation:'begin',input_sha256:'a'.repeat(64)}),c=JSON.parse(data);await submit(r,c);
  const f=invocation(r,c);let writes=0;
  await assert.rejects(()=>client.executeOnce(f.invocation,f.options,async()=>{writes++;throw Error('unknown write');}),/unknown write/);
  await assert.rejects(()=>client.executeOnce(f.invocation,f.options,async()=>{writes++;}),/reconciliation-only/);
  const restarted=new NativeRemoteJournal(nativeConfig,fixed);await assert.rejects(()=>restarted.executeOnce(f.invocation,f.options,async()=>{writes++;}),/reconciliation-only/);assert.equal(writes,1);
  assert.throws(()=>nativeCompletionArguments(f.invocation,{...f.options,config:nativeConfig}),/Only a fresh/);
  const bad=structuredClone(f.invocation);bad.arguments.filters='in:<#COTHER>';assert.throws(()=>client.read(bad,f.options));
 }finally{r.state.close();}
});

test('retained journal polls have no command-count expiry and preserve the ordinary notice quota',async()=>{
 const r=await setup();try{
  await open(r);
  const insert=r.state.db.prepare("INSERT INTO notice_commands VALUES(?,?,?,?,'response_sent','{}','1793450000.000001')");
  const retain=(action,prefix)=>{
   r.state.db.exec('BEGIN');
   for(let i=0;i<10000;i++){
    const c=command(action,{command_id:`${prefix}-${String(i).padStart(8,'0')}`}),data=encodeNoticeCommand(c);
    insert.run(c.command_id,digest(data),`1793449100.${String(++serial).padStart(6,'0')}`,data);
   }
   r.state.db.exec('COMMIT');
  };
  retain('journal_read','retained-journal');
  const first=await submit(r,command('journal_read'));assert.equal(first.journal.revision,1);
  admit(r,command('prepare_bundle')); // Poll history has not exhausted this quota.
  retain('prepare_bundle','retained-notice');
  assert.throws(()=>admit(r,command('prepare_bundle')),/capacity reached/);
  assert.equal((await submit(r,command('journal_read'))).reason,'journal_read');
 }finally{r.state.close();}
});

test('retained duplicate JSON action keys use the same final value as command admission',async()=>{
 for(const actual of ['prepare_bundle','journal_read']){
  const r=await setup();try{
   await open(r);
   const insert=r.state.db.prepare("INSERT INTO notice_commands VALUES(?,?,?,?,'response_sent','{}','1793450000.000001')");
   r.state.db.exec('BEGIN');
   for(let i=0;i<9999;i++){
    const c={schema_version:'1.0',command_id:`duplicate-action-${String(i).padStart(8,'0')}`,action:actual,report_request_id:ID,bundle_sha256:bundle.hash,attempt_id:fixed.attempt_id,file_id:fixed.file_id};
    const first=actual==='prepare_bundle'?'journal_read':'prepare_bundle';
    const data=Buffer.from(JSON.stringify(c).replace(`"action":"${actual}"`,`"action":"${first}","action":"${actual}"`)+'\n');
    insert.run(c.command_id,digest(data),`1793449200.${String(++serial).padStart(6,'0')}`,data);
   }
   r.state.db.exec('COMMIT');
   if(actual==='prepare_bundle')assert.throws(()=>admit(r,command('prepare_bundle')),/capacity reached/);
   else assert.doesNotThrow(()=>admit(r,command('prepare_bundle')));
   assert.equal((await submit(r,command('journal_read'))).reason,'journal_read');
  }finally{r.state.close();}
 }
});
