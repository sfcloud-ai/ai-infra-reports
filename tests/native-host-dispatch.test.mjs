import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {driveNativeHost} from '../scripts/native-host-dispatch.mjs';
import {NATIVE_TOOLS} from '../scripts/native-scheduled-host.mjs';
const line=x=>JSON.stringify(x)+'\n';
test('dispatcher never invokes a tool after budget expiry and defers quiescent runs',async()=>{
 let calls=0,time=1000;
 const expired={exec_command:async()=>{time=121001;return {session_id:17,output:line({type:'tool',id:1,tool:NATIVE_TOOLS.complete,arguments:{}})};},[NATIVE_TOOLS.complete]:async()=>{calls++;}};
 await assert.rejects(()=>driveNativeHost({tools:expired,start:{cmd:'fixed'},now:()=>time,budgetMs:120000}),/budget expired/);assert.equal(calls,0);
 const writes=[],tools={exec_command:async()=>{time=61001;return {session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',not_before:new Date(9000).toISOString()})};},write_stdin:async args=>{writes.push(JSON.parse(args.chars));return {session_id:17,output:line({type:'deferred',run_id:'existing',next_attempt_at:9000,resume_mode:'continue_before_begin'})};}};
 time=1000;const result=await driveNativeHost({tools,start:{cmd:'fixed'},now:()=>time,budgetMs:120000});
 assert.deepEqual(writes,[{type:'defer'}]);assert.equal(result.type,'deferred');assert.equal(result.slack_status,'not_checked');
});
test('scheduled dispatcher forwards the actual tool result once and does not claim WeCom delivery',async()=>{
 const actual={content:[{type:'text',text:'{"file_id":"F123"}'}]},writes=[],calls=[];
 const outputs=[{type:'tool',id:1,tool:NATIVE_TOOLS.ticket,arguments:{filename:'poster.png',content_length:10}},{type:'state',phase:'sender_reported'}];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',not_before:'2026-11-01T00:00:00.000Z'})}),write_stdin:async args=>{writes.push(JSON.parse(args.chars));return {session_id:17,output:line(outputs.shift())};},[NATIVE_TOOLS.ticket]:async args=>{calls.push(args);return actual;}};
 const result=await driveNativeHost({tools,start:{cmd:'fixed operator command'},now:()=>1793491200000});
 assert.deepEqual(writes,[{type:'tick',deadline:1793491200000+20*60*1000},{type:'tool_result',id:1,result:actual}]);assert.equal(calls.length,1);assert.equal(result.wecom_status,'not_checked');
});
test('dispatcher does not retry unknown tools, thrown writes or repeated request IDs',async()=>{
 for(const mode of ['unknown','throw','repeat']){
  let calls=0;
  const m={type:'tool',id:1,tool:mode==='unknown'?'unapproved_tool':NATIVE_TOOLS.complete,arguments:{file_id:'F123',channel_id:'D123'}};
  const tools={exec_command:async()=>({session_id:17,output:line(m)}),write_stdin:async()=>({session_id:17,output:line(m)}),[NATIVE_TOOLS.complete]:async()=>{calls++;if(mode==='throw')throw Error('outcome unknown');return {};}};
  await assert.rejects(()=>driveNativeHost({tools,start:{cmd:'fixed'},now:()=>1793491200000}));assert.equal(calls,mode==='unknown'?0:1);
 }
});

test('temporary search exceptions are returned as read failures, never mutation retries',async()=>{
 const received=[],outputs=[{type:'tool',id:1,tool:NATIVE_TOOLS.search,arguments:{}},{type:'pending',next_attempt_at:1793491200000+3600000},{type:'deferred',resume_mode:'reconcile_only'}];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',not_before:'2026-11-01T00:00:00Z'})}),write_stdin:async args=>{received.push(JSON.parse(args.chars));return {session_id:17,output:line(outputs.shift())};},[NATIVE_TOOLS.search]:async()=>{throw new DOMException('read timeout','TimeoutError');}};
 const result=await driveNativeHost({tools,start:{cmd:'fixed'},now:()=>1793491200000});
 assert.deepEqual(received[1],{type:'tool_read_error',id:1,reason:'temporary_read_failure'});assert.deepEqual(received[2],{type:'defer'});assert.equal(result.type,'deferred');
});

test('an unsettled read defers in a runtime without DOMException',async()=>{
 const received=[],outputs=[{type:'tool',id:1,tool:NATIVE_TOOLS.search,arguments:{}},{type:'pending',next_attempt_at:1793491200000+3600000},{type:'deferred',resume_mode:'reconcile_only'}];let calls=0;
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',not_before:'2026-11-01T00:00:00Z'})}),write_stdin:async args=>{received.push(JSON.parse(args.chars));return {session_id:17,output:line(outputs.shift())};},[NATIVE_TOOLS.search]:()=>{calls++;return new Promise(()=>{});}};
 const context={setTimeout,clearTimeout,NATIVE_TOOLS};assert.equal(runInNewContext('typeof DOMException',context),'undefined');
 const runtimeDrive=runInNewContext('('+driveNativeHost.toString()+')',context);
 const result=await runtimeDrive({tools,start:{cmd:'fixed'},now:()=>1793491200000,readTimeoutMs:5});
 assert.equal(result.type,'deferred');assert.equal(calls,1);assert.equal(received[1].type,'tool_read_error');
});
test('execution budget must leave room for the pre-begin safety margin',async()=>{
 await assert.rejects(()=>driveNativeHost({tools:{},start:{},budgetMs:60000}),/Bounded host budget/);
});

test('legacy recovery hosts receive only legacy ticks and never durable protocol messages',async()=>{
 const replies=[],outputs=[{type:'tool',id:1,tool:NATIVE_TOOLS.search,arguments:{}},{type:'state',phase:'sender_reported'}];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',not_before:'2026-11-01T00:00:00Z'})}),write_stdin:async args=>{replies.push(JSON.parse(args.chars));return {session_id:17,output:line(outputs.shift())};},[NATIVE_TOOLS.search]:async()=>({found:true})};
 const result=await driveNativeHost({tools,start:{cmd:'fixed recovery operator'},now:()=>1793491200000});
 assert.equal(result.slack_status,'verified');assert.deepEqual(replies,[{type:'tick'},{type:'tool_result',id:1,result:{found:true}}]);
});
test('legacy hosts stop on temporary reads or slice end without unsupported replies',async()=>{
 for(const mode of ['timeout','budget']){
  let time=1000;const replies=[];
  const tools={exec_command:async()=>{if(mode==='budget')time=61001;return {session_id:17,output:line({type:'ready',not_before:new Date(1).toISOString()})};},write_stdin:async args=>{replies.push(JSON.parse(args.chars));return {session_id:17,output:line({type:'tool',id:1,tool:NATIVE_TOOLS.search,arguments:{}})};},[NATIVE_TOOLS.search]:async()=>{throw Object.assign(new Error('read timeout'),{name:'TimeoutError'});}};
  await assert.rejects(()=>driveNativeHost({tools,start:{cmd:'fixed recovery operator'},now:()=>time,budgetMs:120000}),/read timeout|without durable defer/);
  assert.deepEqual(replies,mode==='timeout'?[{type:'tick'}]:[]);
 }
});

for(const mode of ['deferred','silent','write'])test('late read timeout cleanup is bounded and read-only: '+mode,async()=>{
 let time=1000,calls=0,mutations=0,polls=0;const replies=[];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',not_before:new Date(1).toISOString()})}),
  write_stdin:async args=>{
   if(args.chars===''){
    polls++;time+=5000;
    return {session_id:17,output:mode==='silent'?'':line(mode==='write'?{type:'tool',id:2,tool:NATIVE_TOOLS.complete,arguments:{}}:{type:'pending',next_attempt_at:time+5000})};
   }
   const reply=JSON.parse(args.chars);replies.push(reply);
   if(reply.type==='tick'){time=120999;return {session_id:17,output:line({type:'tool',id:1,tool:NATIVE_TOOLS.search,arguments:{}})};}
   if(reply.type==='tool_read_error'){time=121001;return {session_id:17,output:''};}
   assert.equal(reply.type,'defer');return {session_id:17,output:line({type:'deferred',run_id:'original',next_attempt_at:time+15000,resume_mode:'reconcile_only'})};
  },[NATIVE_TOOLS.search]:()=>{calls++;return new Promise(()=>{});},[NATIVE_TOOLS.complete]:async()=>{mutations++;return {};}};
 const drive=()=>driveNativeHost({tools,start:{cmd:'fixed'},now:()=>time,budgetMs:120000,readTimeoutMs:5});
 if(mode==='deferred'){assert.equal((await drive()).type,'deferred');assert.equal(replies.at(-1).type,'defer');}
 else await assert.rejects(drive,/budget expired|Read cleanup cannot dispatch/);
 assert.equal(calls,1);assert.equal(mutations,0);assert.equal(replies[1].type,'tool_read_error');assert(polls<=3);
});

for(const mode of ['remaining','expired'])test('current-process begin can use its reserved completion minute: '+mode,async()=>{
 let time=1000,ticks=0,completions=0;const replies=[];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',phase:'native_begin',not_before:new Date(1).toISOString()})}),
  write_stdin:async args=>{
   const reply=JSON.parse(args.chars);replies.push(reply);let message;
   if(reply.type==='tick'&&++ticks===1){time=mode==='remaining'?62000:121000;message={type:'state',phase:'final_ready'};}
   else if(reply.type==='tick')message={type:'tool',id:1,tool:NATIVE_TOOLS.complete,arguments:{}};
   else if(reply.type==='defer')message={type:'deferred',resume_mode:'reconcile_only'};
   else message={type:'state',phase:'sender_reported'};
   return {session_id:17,output:line(message)};
  },[NATIVE_TOOLS.complete]:async()=>{completions++;return {ok:true};}};
 const result=await driveNativeHost({tools,start:{cmd:'fixed'},now:()=>time,budgetMs:120000});
 assert.equal(completions,mode==='remaining'?1:0);assert.equal(replies[1].type,mode==='remaining'?'tick':'defer');
 assert.equal(mode==='remaining'?result.slack_status:result.type,mode==='remaining'?'verified':'deferred');
});
for(const mode of ['ack','silent','write'])test('every defer gets bounded acknowledgement polling: '+mode,async()=>{
 let time=1000,polls=0,mutations=0;const replies=[];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',not_before:new Date(1).toISOString()})}),
  write_stdin:async args=>{
   if(args.chars===''){polls++;time+=5000;return {session_id:17,output:mode==='silent'?'':line(mode==='write'?{type:'tool',id:2,tool:NATIVE_TOOLS.complete,arguments:{}}:{type:'deferred',run_id:'original',next_attempt_at:time+15000,resume_mode:'reconcile_only'})};}
   const reply=JSON.parse(args.chars);replies.push(reply);
   if(reply.type==='tick'){time=120999;return {session_id:17,output:line({type:'tool',id:1,tool:NATIVE_TOOLS.search,arguments:{}})};}
   if(reply.type==='tool_result')return {session_id:17,output:line({type:'pending',next_attempt_at:time+5000})};
   assert.equal(reply.type,'defer');return {session_id:17,output:''};
  },[NATIVE_TOOLS.search]:async()=>{time=121001;return {found:false};},[NATIVE_TOOLS.complete]:async()=>{mutations++;return {};}};
 const drive=()=>driveNativeHost({tools,start:{cmd:'fixed'},now:()=>time,budgetMs:120000});
 if(mode==='ack')assert.equal((await drive()).type,'deferred');
 else await assert.rejects(drive,/budget expired|did not acknowledge durable defer/);
 assert.equal(replies.at(-1).type,'defer');assert.equal(mutations,0);assert(polls<=3);
});

for(const mode of ['retry','past-deadline','resumed'])test('post-begin read waits retain only the current-process completion window: '+mode,async()=>{
 let time=1000,ticks=0,completions=0;const replies=[];
 const tools={exec_command:async()=>{if(mode==='resumed')time=62000;return {session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',phase:mode==='resumed'?'final_ready':'native_begin',not_before:new Date(1).toISOString()})};},
  write_stdin:async args=>{
   const reply=JSON.parse(args.chars);replies.push(reply);let message;
   if(reply.type==='tick'){
    ticks++;
    if(ticks===1){time=62000;message={type:'state',phase:'final_ready'};}
    else if(ticks<=3){if(ticks===2)time=66000;message={type:'pending',next_attempt_at:mode==='past-deadline'?126000:time+15000};}
    else message={type:'tool',id:1,tool:NATIVE_TOOLS.complete,arguments:{}};
   }else message=reply.type==='defer'?{type:'deferred',resume_mode:'reconcile_only'}:{type:'state',phase:'sender_reported'};
   return {session_id:17,output:line(message)};
  },[NATIVE_TOOLS.complete]:async()=>{completions++;return {ok:true};}};
 const result=await driveNativeHost({tools,start:{cmd:'fixed'},now:()=>time,sleep:async ms=>{time+=ms;},budgetMs:120000});
 assert.equal(completions,mode==='retry'?1:0);assert.equal(mode==='retry'?result.slack_status:result.type,mode==='retry'?'verified':'deferred');
 if(mode==='resumed')assert.deepEqual(replies,[{type:'defer'}]);
});

test('pending allocated-begin receipts retain the current owner completion window',async()=>{
 let time=1000,ticks=0;const replies=[];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',not_before:new Date(1).toISOString()})}),write_stdin:async args=>{
  const reply=JSON.parse(args.chars);replies.push(reply);assert.equal(reply.type,'tick');
  return {session_id:17,output:line(++ticks===1?(time=62000,{type:'pending',phase:'native_begin',completion_window:true,next_attempt_at:67000}):{type:'state',phase:'sender_reported'})};
 }};
 assert.equal((await driveNativeHost({tools,start:{cmd:'fixed'},now:()=>time,sleep:async ms=>{time+=ms;},budgetMs:120000})).slack_status,'verified');assert.equal(replies.length,2);
});
for(const mode of ['pending','state','silent','write'])test('successful late reads drain bounded output without more tools: '+mode,async()=>{
 let time=1000,polls=0,mutations=0;const replies=[];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',not_before:new Date(1).toISOString()})}),write_stdin:async args=>{
  if(args.chars===''){polls++;time+=5000;return {session_id:17,output:mode==='silent'?'':line(mode==='write'?{type:'tool',id:2,tool:NATIVE_TOOLS.complete,arguments:{}}:mode==='state'?{type:'state',phase:'final_ready',completion_window:true}:{type:'pending',next_attempt_at:time+15000})};}
  const reply=JSON.parse(args.chars);replies.push(reply);
  if(reply.type==='tick'){time=120999;return {session_id:17,output:line({type:'tool',id:1,tool:NATIVE_TOOLS.search,arguments:{}})};}
  if(reply.type==='tool_result')return {session_id:17,output:''};
  assert.equal(reply.type,'defer');return {session_id:17,output:line({type:'deferred',resume_mode:'reconcile_only'})};
 },[NATIVE_TOOLS.search]:async()=>{time=121001;return {found:false};},[NATIVE_TOOLS.complete]:async()=>{mutations++;return {};}};
 const drive=()=>driveNativeHost({tools,start:{cmd:'fixed'},now:()=>time,budgetMs:120000});
 if(['pending','state'].includes(mode))assert.equal((await drive()).type,'deferred');else await assert.rejects(drive,/budget expired|Read cleanup cannot dispatch/);
 assert.equal(mutations,0);assert(polls<=3);
});

for(const mode of ['before-deadline','after-deadline','repeated-id'])test('cleanup defers a chained receipt search without dispatching it: '+mode,async()=>{
 let time=1000,calls=0;const replies=[];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',protocol:'native_durable_retry_v1',not_before:new Date(1).toISOString()})}),write_stdin:async args=>{
  if(args.chars===''){time+=1000;return {session_id:17,output:line({type:'pending',next_attempt_at:time+15000})};}
  const reply=JSON.parse(args.chars);replies.push(reply);
  if(reply.type==='tick'){time=120999;return {session_id:17,output:line({type:'tool',id:1,tool:NATIVE_TOOLS.search,arguments:{}})};}
  if(reply.type==='tool_result')return {session_id:17,output:line({type:'tool',id:mode==='repeated-id'?1:2,tool:NATIVE_TOOLS.search,arguments:{}})};
  if(reply.type==='tool_read_error')return {session_id:17,output:''};
  assert.equal(reply.type,'defer');return {session_id:17,output:line({type:'deferred',resume_mode:'reconcile_only'})};
 },[NATIVE_TOOLS.search]:async()=>{calls++;if(mode==='after-deadline')time=121001;return {found:true};}};
 const drive=()=>driveNativeHost({tools,start:{cmd:'fixed'},now:()=>time,budgetMs:120000});
 if(mode==='repeated-id')await assert.rejects(drive,/repeated tool request/);
 else{assert.equal((await drive()).type,'deferred');assert.deepEqual(replies[2],{type:'tool_read_error',id:2,reason:'temporary_read_failure'});}
 assert.equal(calls,1);
});
