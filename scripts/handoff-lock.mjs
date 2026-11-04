// flock belongs to the open file description shared with fd 3 in the child.
// The parent keeps it alive across durable intents and remote operations;
// process exit releases it without stale PID files or lease expiry races.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
async function withLedgerLock(directory,run,readOnly){
 if(process.platform!=='linux')throw Error('Publisher lock requires Linux flock');
 const flags=(readOnly?constants.O_RDONLY:constants.O_CREAT|constants.O_RDWR)|constants.O_NOFOLLOW;
 const file=await open(path.join(directory,'handoff.lock'),flags,0o600);
 try{
  const stat=await file.stat();
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw Error('Private publisher lock required');
  await new Promise((resolve,reject)=>{
   const child=spawn('/usr/bin/flock',[readOnly?'--shared':'--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',file.fd],env:{LANG:'C'}});
   child.once('error',()=>reject(Error('Publisher lock unavailable')));
   child.once('close',code=>code===0?resolve():reject(Object.assign(Error('Another publisher tick owns the ledger'),{code:'SQLITE_BUSY'})));
  });
  return await run();
 }finally{await file.close();}
}
export const withHandoffLock=(directory,run)=>withLedgerLock(directory,run,false);
export const withHandoffReadLock=(directory,run)=>withLedgerLock(directory,run,true);
