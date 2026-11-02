import test from 'node:test';
import assert from 'node:assert/strict';
import {driveRemoteNativeHost,frameRemoteMessage,RemoteFrames} from '../scripts/remote-native-dispatch.mjs';
const file='mcp__codex_apps__slack_slack_read_file',complete='mcp__codex_apps__slack_slack_complete_file_upload';
const line=frameRemoteMessage;
function rig(messages){
 const received=[];let pending='';return {received,tools:{exec_command:async()=>({session_id:19,output:line({type:'ready',protocol:'native_remote_runtime_v1'})}),write_stdin:async args=>{
  if(args.chars!=='\n'){assert(!args.chars.includes('\n'));pending+=args.chars;return {session_id:19,output:''};}
  received.push(JSON.parse(pending));pending='';return {session_id:19,output:line(messages.shift())};
 }}};
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
test('interactive bridge removes split terminal framing without modifying native result data',async()=>{
 const actual={content:[{type:'text',text:'original \\u001b[0m data'}]},writes=[];let first=true,pending='';
 const outputs=[{type:'tool',id:1,tool:file,arguments:{file_id:'FSYNTHETIC'}},{type:'idle'}];
 const tools={exec_command:async args=>{assert.equal(args.tty,true);return {session_id:19,output:'\x1b]0;terminal title'};},write_stdin:async args=>{
  if(first){first=false;assert.equal(args.chars,'');return {session_id:19,output:'\x07\x1b[?25h'+line({type:'ready',protocol:'native_remote_runtime_v1'})};}
  if(args.chars!=='\n'){pending+=args.chars;return {session_id:19,output:''};}
  writes.push(JSON.parse(pending));pending='';return {session_id:19,output:'\x1b[0m'+line(outputs.shift())};
 },[file]:async()=>actual};
 assert.equal((await driveRemoteNativeHost({tools,start:{cmd:'synthetic'},now:()=>1000})).type,'idle');assert.deepEqual(writes[1].result,actual);
});
test('large native tool results use one payload and a separate delimiter without repeating the tool',async()=>{
 const actual={structuredContent:{text_content:'x'.repeat(2311666)}},r=rig([{type:'tool',id:1,tool:file,arguments:{file_id:'FSYNTHETIC'}},{type:'idle'}]);let calls=0;
 r.tools[file]=async()=>{calls++;return actual;};
 assert.equal((await driveRemoteNativeHost({tools:r.tools,start:{cmd:'synthetic'},now:()=>1000})).type,'idle');assert.equal(calls,1);assert.deepEqual(r.received[1].result,actual);
});
test('framed long Unicode requests preserve exact data across screenfuls and split reads',()=>{
 const value={type:'tool',id:1,arguments:{initial_comment:'测试中文 emoji 🧑‍💻 \\n '.repeat(160)}},encoded=line(value),frames=new RemoteFrames();
 for(const row of encoded.split('\r\n').filter(Boolean)){assert(row.length<64);assert(!/[^\x20-\x7e]/.test(row));}
 const chunks=encoded.match(/[\s\S]{1,37}/g);let decoded;
 for(const chunk of chunks){frames.push(chunk);decoded=frames.next()??decoded;}
 assert.deepEqual(decoded,value);
 const bad=new RemoteFrames();bad.push(encoded.replace('@nr1:1:','@nr1:2:'));assert.throws(()=>bad.next(),/frame/);
});
