import test from 'node:test';
import assert from 'node:assert/strict';
import {runNoticeChecker,validateCheckerConfig,checkedNoticeResult} from '../scripts/notice-checker.mjs';
import {validateConfig} from '../scripts/run-handoff.mjs';
import {handoffScope} from '../scripts/handoff-state.mjs';

const request={message_ts:'1793448700.000001',file_id:'F123',notice_manifest:{poster:{sha256:'a'.repeat(64)}}};
const result={slack_status:'verified',wecom_status:'not_checked',publication_status:'not_checked',messages_sent:0,state_changed:false,observed_publication_commit:'b'.repeat(40),receipt:{channel:'D123',ts:request.message_ts,relay_request_id:'auto:'+request.message_ts,file_id:'F123',transport_sha256:'a'.repeat(64),transport_bytes:100}};
const command=code=>({executable:process.execPath,args:['--input-type=module','-e',code]});
test('the local checker receives only bounded JSON through stdin and does not inherit secrets',async()=>{
 process.env.NOTICE_CHECKER_TEST_SECRET='must-not-reach-child';
 try{
  const program=`let input='';for await(const b of process.stdin)input+=b;const r=JSON.parse(input);if(r.file_id!=='F123'||process.env.NOTICE_CHECKER_TEST_SECRET)process.exit(2);console.log(${JSON.stringify(JSON.stringify(result))});`;
  assert.deepEqual(await runNoticeChecker(command(program),request),result);
 }finally{delete process.env.NOTICE_CHECKER_TEST_SECRET;}
});
test('bounded negative CLI result is distinct from a successful verification',async()=>{
 const negative={slack_status:'not_verified',wecom_status:'not_checked',error:'notice_read_unverified',messages_sent:0,state_changed:false};
 const r=await runNoticeChecker(command(`process.stdin.resume();process.stdin.on('end',()=>{console.log(${JSON.stringify(JSON.stringify(negative))});process.exitCode=1;});`),request);
 assert.equal(checkedNoticeResult(r,{}).slack_status,'not_verified');
});
test('process failures, malformed/oversized output and deadlines never become positive evidence',async()=>{
 for(const program of ["process.stdin.resume();process.stdin.on('end',()=>process.exit(2));","process.stdin.resume();process.stdin.on('end',()=>console.log('not JSON'));","process.stdin.resume();process.stdin.on('end',()=>console.log('x'.repeat(20000)));",`process.stdin.resume();process.stdin.on('end',()=>{console.log(${JSON.stringify(JSON.stringify(result))});process.exitCode=1;});`]){
  await assert.rejects(()=>runNoticeChecker(command(program),request),/checker unavailable/);
 }
 await assert.rejects(()=>runNoticeChecker(command('setInterval(()=>{},1000);'),request,{timeout:50}),/checker unavailable/);
 await assert.rejects(()=>runNoticeChecker({executable:process.execPath+'-does-not-exist',args:[]},request),/checker unavailable/);
 assert.throws(()=>runNoticeChecker(command(''),{large:'x'.repeat(140000)}),/limit/);
});
test('only private deployment configuration may choose a fixed executable and arguments',()=>{
 for(const c of [{executable:'relative',args:[]},{executable:process.execPath,args:[],shell:true},{executable:process.execPath,args:['a\0b']},{executable:process.execPath,args:Array(9).fill('x')}])assert.throws(()=>validateCheckerConfig(c));
 const config={team_id:'T123',channel_id:'C123',sender_user_id:'U123',bot_user_id:'U456',bot_id:'B456',producer_app_id:10,merger_app_id:11,slack_token_file:process.execPath,producer_key_file:process.execPath,state_dir:process.execPath,ready_for_review:false};
 assert.throws(()=>validateConfig({...config,notification_checker:command('')}),/configured notices/);
 const enabled={...config,notification_destination:'D123',notification_not_before:'1793447000.000001',notification_checker:command('')};
 assert.deepEqual(handoffScope(validateConfig(enabled)),handoffScope(config));
});
test('strict checker receipt binding rejects false authority and changed files or destinations',()=>{
 const expected={request,destination:'D123',posterBytes:100};
 assert.equal(checkedNoticeResult(result,expected).slack_status,'verified');
 for(const change of [r=>r.wecom_status='verified',r=>r.publication_status='verified',r=>r.messages_sent=1,r=>r.state_changed=true,r=>r.extra='token',r=>r.receipt.channel='DOTHER',r=>r.receipt.ts='1793448700.000002',r=>r.receipt.file_id='FOTHER',r=>r.receipt.transport_sha256='c'.repeat(64),r=>r.receipt.transport_bytes=101,r=>r.receipt.relay_request_id='other',r=>r.observed_publication_commit='bad']){
  const bad=structuredClone(result);change(bad);assert.throws(()=>checkedNoticeResult(bad,expected));
 }
});
test('bundle check requires independent exact transport and extracted-poster evidence',()=>{
 const req={...request,transport:'report_bundle_v1',bundle_sha256:'c'.repeat(64),bundle_bytes:2000};
 const value={...result,receipt:{...result.receipt,transport_sha256:req.bundle_sha256,transport_bytes:req.bundle_bytes,poster_sha256:request.notice_manifest.poster.sha256,poster_bytes:100}};
 const expected={request:req,destination:'D123',posterBytes:100};
 assert.equal(checkedNoticeResult(value,expected).slack_status,'verified');
 for(const mutate of [v=>delete v.receipt.poster_sha256,v=>v.receipt.poster_sha256=req.bundle_sha256,v=>v.receipt.poster_bytes=101,v=>v.receipt.transport_sha256=request.notice_manifest.poster.sha256,v=>v.receipt.transport_bytes=100]){
  const bad=structuredClone(value);mutate(bad);assert.throws(()=>checkedNoticeResult(bad,expected));
 }
 assert.throws(()=>checkedNoticeResult(value,{request,destination:'D123',posterBytes:100}));
});
