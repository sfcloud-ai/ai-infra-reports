import test from 'node:test';
import assert from 'node:assert/strict';
import {driveRemoteNativeHost} from '../scripts/remote-native-dispatch.mjs';
const file='mcp__codex_apps__slack_slack_read_file',complete='mcp__codex_apps__slack_slack_complete_file_upload';
const line=x=>JSON.stringify(x)+'\n';
function rig(messages){
 const received=[];return {received,tools:{exec_command:async()=>({session_id:19,output:line({type:'ready',protocol:'native_remote_runtime_v1'})}),write_stdin:async args=>{received.push(JSON.parse(args.chars));return {session_id:19,output:line(messages.shift())};}}};
}
test('remote dispatcher forwards the actual structured file read without replacing its bytes',async()=>{
 const actual={structuredContent:{file_id:'FSYNTHETIC',text_content:'original\n'}},r=rig([{type:'tool',id:1,tool:file,arguments:{file_id:'FSYNTHETIC'}},{type:'idle'}]);
 r.tools[file]=async()=>actual;const result=await driveRemoteNativeHost({tools:r.tools,start:{cmd:'synthetic'},now:()=>1000});
 assert.equal(result.type,'idle');assert.deepEqual(r.received[1],{type:'tool_result',id:1,result:actual});assert.equal(r.received[0].deadline,1201000);
});
test('remote read timeout becomes a read error, but ambiguous mutations stop with one call',async()=>{
 for(const tool of [file,complete]){
  const r=rig([{type:'tool',id:1,tool,arguments:{}},{type:'stopped'}]);let calls=0;r.tools[tool]=async()=>{calls++;throw Object.assign(Error('synthetic'),{name:'TimeoutError'});};
  const run=()=>driveRemoteNativeHost({tools:r.tools,start:{cmd:'synthetic'},now:()=>1000});
  if(tool===file){assert.equal((await run()).type,'stopped');assert.equal(r.received[1].type,'tool_read_error');}else await assert.rejects(run,/synthetic/);
  assert.equal(calls,1);
 }
});
test('remote dispatcher refuses unexpected tools, repeated IDs and late writes',async()=>{
 for(const mode of ['unknown','repeat','late']){
  let time=1000,calls=0;const tool=mode==='unknown'?'unexpected':complete,r=rig([{type:'tool',id:1,tool,arguments:{}},{type:'tool',id:1,tool,arguments:{}}]);
  r.tools[tool]=async()=>{calls++;return {};};const original=r.tools.write_stdin;
  r.tools.write_stdin=async args=>{const result=await original(args);if(mode==='late')time=2000000;return result;};
  await assert.rejects(()=>driveRemoteNativeHost({tools:r.tools,start:{cmd:'synthetic'},now:()=>time}));assert.equal(calls,mode==='repeat'?1:0);
 }
});
test('daily bootstrap waits until 07:50 before starting its bounded execution slice',async()=>{
 const before=Date.parse('2026-11-01T23:20:00Z'),due=Date.parse('2026-11-01T23:50:00Z');let time=before,launch;
 const r=rig([{type:'idle'}]),exec=r.tools.exec_command;r.tools.exec_command=async()=>{launch=time;return exec();};
 await driveRemoteNativeHost({tools:r.tools,start:{cmd:'synthetic'},now:()=>time,bootstrapNotBefore:due,sleep:async ms=>{assert(ms<=30000);time+=ms;}});
 assert.equal(launch,due);assert.equal(r.received[0].deadline,due+20*60000);
});
