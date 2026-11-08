// Linux flock is inherited by the bridge from the one original launcher.
// A caller-supplied boolean, PID or alternative lock path is not evidence.
import {lstat,stat,readFile,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {requireThat} from './report-handoff.mjs';
export async function requireOriginalRunnerLock(stateFile){
 const lock=join(dirname(stateFile),'runner.lock'),info=await lstat(lock,{bigint:true});
 requireThat(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1n&&info.uid===BigInt(process.getuid())&&(info.mode&0o777n)===0o600n,'Original private runner lock required');
 let held=false;
 for(const fd of await readdir('/proc/self/fd')){
  try{
   const own=await stat('/proc/self/fd/'+fd,{bigint:true});
   if(own.dev!==info.dev||own.ino!==info.ino)continue;
   const detail=await readFile('/proc/self/fdinfo/'+fd,'utf8');
   if(/^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+[a-f0-9]+:[a-f0-9]+:(\d+)\s+0 EOF$/m.test(detail)&&detail.match(/^lock:.*?([a-f0-9]+):([a-f0-9]+):(\d+)\s+0 EOF$/m)?.[3]===String(info.ino))held=true;
  }catch(e){if(!['ENOENT','EBADF'].includes(e.code))throw e;}
 }
 requireThat(held,'Bridge must inherit the original exclusive runner.lock flock');
 const after=await lstat(lock,{bigint:true});requireThat(after.dev===info.dev&&after.ino===info.ino,'Original runner lock changed');
}
