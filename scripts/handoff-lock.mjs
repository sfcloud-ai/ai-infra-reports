// flock belongs to the open file description shared with fd 3 in the child.
// The parent keeps it alive across durable intents and remote operations;
// process exit releases it without stale PID files or lease expiry races.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
// Only acquisition can prove that the callback never started. A callback's
// SQLite error or lookalike diagnostic must never be treated as a skipped tick.
const CONTENTION=new WeakSet(),CONFLICT_EXIT=75;
export const isHandoffLockBusy=error=>CONTENTION.has(error);
function lockFailure(code,readOnly,waitMs,extra={}){
 const busy=code==='HANDOFF_LOCK_BUSY';
 const error=Object.assign(Error(busy?'Another publisher operation owns the ledger':'Publisher lock unavailable'),{code,diagnostic:{stage:'handoff.lock',code,outcome:'not_started',retryable:busy,lock_mode:readOnly?'shared':'exclusive',wait_ms:waitMs,...extra}});
 if(busy)CONTENTION.add(error);
 return error;
}
async function withLedgerLock(directory,run,readOnly,{waitMs=5000}={}){
 if(process.platform!=='linux')throw Error('Publisher lock requires Linux flock');
 if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>5000)throw Error('Bounded publisher lock wait required');
 const flags=(readOnly?constants.O_RDONLY:constants.O_CREAT|constants.O_RDWR)|constants.O_NOFOLLOW;
 const file=await open(path.join(directory,'handoff.lock'),flags,0o600);
 try{
  const stat=await file.stat();
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw Error('Private publisher lock required');
  await new Promise((resolve,reject)=>{
   const child=spawn('/usr/bin/flock',[readOnly?'--shared':'--exclusive','--wait',String(waitMs/1000),'--conflict-exit-code',String(CONFLICT_EXIT),'3'],{stdio:['ignore','ignore','ignore',file.fd],env:{LANG:'C'}});
   child.once('error',error=>reject(lockFailure('HANDOFF_LOCK_ERROR',readOnly,waitMs,{system_code:error.code})));
   child.once('close',(code,signal)=>{
    if(code===0)return resolve();
    reject(lockFailure(code===CONFLICT_EXIT&&!signal?'HANDOFF_LOCK_BUSY':'HANDOFF_LOCK_ERROR',readOnly,waitMs,{flock_exit_code:code,...(signal?{signal}:{})}));
   });
  });
  try{return await run();}
  catch(error){CONTENTION.delete(error);throw error;}
 }finally{await file.close();}
}
export const withHandoffLock=(directory,run,options)=>withLedgerLock(directory,run,false,options);
export const withHandoffReadLock=(directory,run,options)=>withLedgerLock(directory,run,true,options);
