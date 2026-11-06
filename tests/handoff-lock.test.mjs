import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {withHandoffLock,withHandoffReadLock,isHandoffLockBusy} from '../scripts/handoff-lock.mjs';
import {safeDiagnostic} from '../scripts/handoff-recovery.mjs';
import {superviseTicks,writeHealth} from '../scripts/publisher-service.mjs';
import {checkPublisherHealth} from '../scripts/publisher-watchdog.mjs';
const linux={skip:process.platform!=='linux'};

test('a real shared flock is released before a bounded exclusive waiter enters',linux,async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'lock-wait-'));let writer;
 try{
  await withHandoffLock(directory,()=>{});
  await withHandoffReadLock(directory,async()=>{
   let entered=false;
   writer=withHandoffLock(directory,()=>{entered=true;return 42;},{waitMs:2000});
   await delay(50);assert.equal(entered,false);
  });
  assert.equal(await writer,42);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('contention is bounded, leaves its callback untouched, and has precise safe diagnostics',linux,async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'lock-busy-'));
 try{
  await withHandoffLock(directory,async()=>{
   const started=performance.now();
   await assert.rejects(withHandoffReadLock(directory,()=>assert.fail('read must not start'),{waitMs:50}),error=>{
    assert.equal(isHandoffLockBusy(error),true);
    assert.deepEqual(safeDiagnostic(error),{stage:'handoff.lock',code:'HANDOFF_LOCK_BUSY',outcome:'not_started',retryable:true,flock_exit_code:75,lock_mode:'shared',wait_ms:50});
    return true;
   });
   assert(performance.now()-started<2000);
  });
  assert.equal(await withHandoffLock(directory,()=>42),42);
  for(const waitMs of [-1,5001,Infinity,0.5])await assert.rejects(withHandoffLock(directory,()=>assert.fail('invalid wait'),{waitMs}),/Bounded/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('non-conflict flock exit and spawn failures are not retryable contention',linux,async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'lock-tool-'));
 try{
  for(const failure of [{exit:64},{exit:null,signal:'SIGTERM'},{spawn:'ENOENT'}]){
   const mock=t.mock.method(childProcess,'spawn',()=>{const child=new EventEmitter();queueMicrotask(()=>failure.spawn?child.emit('error',Object.assign(Error('secret tool path'),{code:failure.spawn})):child.emit('close',failure.exit,failure.signal));return child;});
   syncBuiltinESMExports();
   try{
    await assert.rejects(withHandoffLock(directory,()=>assert.fail('failed flock cannot enter')),error=>{
     const d=safeDiagnostic(error);assert.equal(error.code,'HANDOFF_LOCK_ERROR');assert.equal(isHandoffLockBusy(error),false);assert.equal(d.retryable,false);
     if(failure.spawn)assert.equal(d.system_code,'ENOENT');else if(failure.signal)assert.equal(d.signal,failure.signal);else assert.equal(d.flock_exit_code,64);
     assert(!JSON.stringify(d).includes('secret'));return true;
    });
   }finally{mock.mock.restore();syncBuiltinESMExports();}
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('contention thrown after the protected callback starts cannot attest a skipped tick',linux,async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'nested-lock-'));
 try{
  await assert.rejects(withHandoffLock(directory,()=>withHandoffLock(directory,()=>assert.fail('nested'),{waitMs:0})),error=>error.code==='HANDOFF_LOCK_BUSY'&&!isHandoffLockBusy(error));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('deferred ticks neither refresh health nor hide prolonged contention and reset consecutive checks',linux,async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'lock-health-')),stop=new AbortController(),records=[],deferred=[];
 const identity={pid:123,commit:'a'.repeat(40)};let busy,index=0,previous,waits=0;
 try{
  await withHandoffLock(directory,async()=>{try{await withHandoffLock(directory,()=>assert.fail('busy'),{waitMs:0});}catch(error){busy=error;}});
  const results=[{healthy:true},{healthy:true},busy,busy,{healthy:true},{healthy:true}];
  await superviseTicks(async()=>{const result=results[index++];if(result instanceof Error)throw result;return result;},async health=>{
   await writeHealth(directory,health);records.push(health);previous=await readFile(path.join(directory,'health.json'),'utf8');if(index===results.length)stop.abort();
  },async ms=>{waits++;assert.equal(ms,index===3||index===4?1000:120000);},stop.signal,identity,async observation=>{
   deferred.push(observation);assert.equal(await readFile(path.join(directory,'health.json'),'utf8'),previous);
   const staleAt=Date.parse(records.at(-1).checked_at)+301000;
   assert(checkPublisherHealth(records.at(-1),null,{now:staleAt}).includes('heartbeat_stale'));
  });
  assert.deepEqual(records.map(r=>r.successful_checks),[1,2,1,2]);assert.equal(deferred.length,2);assert.equal(waits,5);
  assert(deferred.every(r=>r.phase==='tick_deferred'&&!('checked_at' in r)&&r.error.outcome==='not_started'));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a real SQLite failure or serialized lock lookalike remains an unhealthy unknown tick',async()=>{
 for(const error of [Object.assign(Error('private'),{code:'SQLITE_BUSY'}),Object.assign(Error('private'),{code:'HANDOFF_LOCK_BUSY',diagnostic:{stage:'handoff.lock',outcome:'not_started',retryable:true}})]){
  const stop=new AbortController();let health;
  await superviseTicks(async()=>{throw error;},async result=>{health=result;stop.abort();},()=>assert.fail('no retry after stop'),stop.signal,{},()=>assert.fail('not proven acquisition failure'));
  assert.equal(health.phase,'tick_failed');assert.equal(health.healthy,false);assert.equal(health.successful_checks,0);
 }
});
