import test from 'node:test';
import assert from 'node:assert/strict';
import {driveNativeHost} from '../scripts/native-host-dispatch.mjs';
import {NATIVE_TOOLS} from '../scripts/native-scheduled-host.mjs';
const line=x=>JSON.stringify(x)+'\n';
test('scheduled dispatcher forwards the actual tool result once and does not claim WeCom delivery',async()=>{
 const actual={content:[{type:'text',text:'{"file_id":"F123"}'}]},writes=[],calls=[];
 const outputs=[{type:'tool',id:1,tool:NATIVE_TOOLS.ticket,arguments:{filename:'poster.png',content_length:10}},{type:'state',phase:'sender_reported'}];
 const tools={exec_command:async()=>({session_id:17,output:line({type:'ready',not_before:'2026-11-01T00:00:00.000Z'})}),write_stdin:async args=>{writes.push(JSON.parse(args.chars));return {session_id:17,output:line(outputs.shift())};},[NATIVE_TOOLS.ticket]:async args=>{calls.push(args);return actual;}};
 const result=await driveNativeHost({tools,start:{cmd:'fixed operator command'},now:()=>1793491200000});
 assert.deepEqual(writes,[{type:'tick'},{type:'tool_result',id:1,result:actual}]);assert.equal(calls.length,1);assert.equal(result.wecom_status,'not_checked');
});
test('dispatcher does not retry unknown tools, thrown writes or repeated request IDs',async()=>{
 for(const mode of ['unknown','throw','repeat']){
  let calls=0;
  const m={type:'tool',id:1,tool:mode==='unknown'?'unapproved_tool':NATIVE_TOOLS.complete,arguments:{file_id:'F123',channel_id:'D123'}};
  const tools={exec_command:async()=>({session_id:17,output:line(m)}),write_stdin:async()=>({session_id:17,output:line(m)}),[NATIVE_TOOLS.complete]:async()=>{calls++;if(mode==='throw')throw Error('outcome unknown');return {};}};
  await assert.rejects(()=>driveNativeHost({tools,start:{cmd:'fixed'},now:()=>1793491200000}));assert.equal(calls,mode==='unknown'?0:1);
 }
});
