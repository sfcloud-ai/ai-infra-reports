import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {encodeBundle} from '../scripts/report-handoff.mjs';
import {CloudRunState} from '../scripts/cloud-sender.mjs';
import {FILES,SCOPE,MERGE} from './helpers/cloud-sender-fixture.mjs';
const id='durable-cli-retry-fixture';
async function fixture(fn){
 const dir=await mkdtemp(path.join(os.tmpdir(),'native-cli-retry-'));
 try{
  const state_file=path.join(dir,'journal.sqlite'),bundle_file=path.join(dir,'bundle.json'),config=path.join(dir,'operator.json');
  await writeFile(bundle_file,await encodeBundle(FILES,id,'a'.repeat(40),'b'.repeat(40)));
  await writeFile(config,JSON.stringify({allow_final:true,bundle_file,report_commit:MERGE,scope:SCOPE,state_file,workspace_host:'fixture-workspace.slack.com'}));
  const run=(args=[],input='{"type":"defer"}\n')=>spawnSync(process.execPath,['scripts/native-host-cli.mjs',config,...args],{input,encoding:'utf8'});
  const launch=()=>spawn(process.execPath,['scripts/native-host-cli.mjs',config],{stdio:['pipe','pipe','pipe']});
  await fn({run,state_file,bundle_file,launch});
 }finally{await rm(dir,{recursive:true,force:true});}
}
test('CLI defers and resumes the original durable run without touching Slack',()=>fixture(async({run,state_file})=>{
 const first=run();assert.equal(first.status,0,first.stderr);const lines=first.stdout.trim().split('\n').map(JSON.parse);
 assert.deepEqual(lines.map(v=>v.type),['ready','deferred']);assert.equal(lines[1].resume_mode,'continue_before_begin');assert.equal(lines[1].state_file,state_file);
 const second=run(['--resume',id]);assert.equal(second.status,0,second.stderr);const resumed=second.stdout.trim().split('\n').map(JSON.parse);
 assert.deepEqual(resumed.map(v=>v.type),['ready','deferred']);assert.equal(resumed[1].input_hash,lines[1].input_hash);
 const state=new CloudRunState(state_file,SCOPE);try{assert.equal(state.op(id,'native:begin:command'),null);assert.equal(state.op(id,'native:poster'),null);assert(state.readRetry(id,'resume'));}finally{state.close();}
}));

test('CLI exits after defer while the interactive bridge keeps stdin open',()=>fixture(async({launch,state_file})=>{
 const child=launch(),exited=once(child,'exit');let output='',errors='',timer;
 child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{errors+=b;});
 try{
  child.stdin.write('{"type":"defer"}\n');
  const [code]=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Host remained alive after defer')),5000);})]);
  assert.equal(code,0,errors);assert.equal(child.stdin.writableEnded,false);
  const lines=output.trim().split('\n').map(JSON.parse);assert.deepEqual(lines.map(v=>v.type),['ready','deferred']);assert.equal(lines[0].protocol,'native_durable_retry_v1');
  const state=new CloudRunState(state_file,SCOPE);try{assert(state.readRetry(id,'resume'));assert.equal(state.op(id,'final_complete'),null);}finally{state.close();}
 }finally{clearTimeout(timer);if(child.exitCode===null){child.kill();await exited;}}
}));
test('CLI explicit resume refuses a missing journal rather than admitting a new run',()=>fixture(async({run,state_file})=>{
 const missing=run(['--resume',id]);assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stdout.trim()).type,'stopped');await assert.rejects(()=>access(state_file));
}));
test('CLI explicit resume rejects a different run identifier',()=>fixture(async({run})=>{
 assert.equal(run().status,0);const changed=run(['--resume','different-report-id']);assert.equal(changed.status,1);assert.equal(JSON.parse(changed.stdout.trim()).type,'stopped');
}));

test('CLI resume with another edition bundle never reserves the unrelated run',()=>fixture(async({run,state_file,bundle_file})=>{
 assert.equal(run().status,0);let state=new CloudRunState(state_file,SCOPE);const before=state.get(id);state.close();
 const files=new Map([...FILES].map(([p,b])=>[p.replace('2026-11-01/','2026-11-02/'),b]));
 const reportPath=[...files.keys()].find(p=>p.endsWith('/report.json')),report=JSON.parse(files.get(reportPath));report.date='2026-11-02';files.set(reportPath,Buffer.from(JSON.stringify(report)));
 const otherId='unrelated-next-day-run';await writeFile(bundle_file,await encodeBundle(files,otherId,'a'.repeat(40),'b'.repeat(40)));
 const changed=run(['--resume',id]);assert.equal(changed.status,1);assert.equal(JSON.parse(changed.stdout.trim()).type,'stopped');
 state=new CloudRunState(state_file,SCOPE);try{assert.deepEqual(state.get(id),before);assert.equal(state.get(otherId),null);assert.equal(state.db.prepare('SELECT count(*) n FROM cloud_runs').get().n,1);}finally{state.close();}
}));
test('CLI refuses an empty explicit resume ID without creating a journal',()=>fixture(async({run,state_file})=>{
 const result=run(['--resume','']);assert.equal(result.status,1);await assert.rejects(()=>access(state_file));
}));

test('repeated deferrals always persist a future wakeup, never an expired resume instant',()=>fixture(async({run,state_file})=>{
 assert.equal(run().status,0);const state=new CloudRunState(state_file,SCOPE);
 try{const now=Date.now()+86400000;const first=state.deferNativeRun(id,now);const later=state.deferNativeRun(id,now+86400000);assert(later.next_attempt_at>now+86400000);assert(later.next_attempt_at>first.next_attempt_at);}finally{state.close();}
}));
