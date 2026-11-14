// Disposable verified Git bytes, never a replacement for the original host plan.
import {mkdir,lstat,open,link,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from './archive.mjs';
import {repositoryResearchInputs,repositoryResearchInputsHash,repositoryInputCachePath,readRepositoryResearchInputs,fetchRepositoryInput} from './repository-research-inputs.mjs';
async function directory(dir){
 await mkdir(dir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
 const stat=await lstat(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid())throw Error('Unsafe repository input cache directory');
}
export async function recoverRepositoryInputs(plan,root,{read=fetchRepositoryInput,attempts=2,onEvent=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 if(!path.isAbsolute(root)||!Number.isInteger(attempts)||attempts<1||attempts>2)throw Error('Invalid repository input recovery options');
 if(typeof process.getuid!=='function')throw Error('Verified resumable repository cache requires POSIX ownership and permissions');
 repositoryResearchInputs(plan);await directory(root);
 const binding=repositoryResearchInputsHash(plan),bindingPath=path.join(root,'.repository-inputs');
 try{
  // Never expose a partial binding if interrupted during the first write.
  const temporary=path.join(root,'.binding-'+randomUUID());
  const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
   try{await handle.writeFile(binding);await handle.sync();}finally{await handle.close();}
   await link(temporary,bindingPath);
  }finally{await unlink(temporary);}
 }catch(error){
  if(error.code!=='EEXIST')throw error;
  const handle=await open(bindingPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size!==64||stat.uid!==process.getuid()||(stat.mode&0o077)||await handle.readFile('utf8')!==binding)throw Error('Repository cache belongs to different or invalid pinned inputs');}finally{await handle.close();}
 }
 return readRepositoryResearchInputs(plan,async ref=>{
  const target=path.join(root,repositoryInputCachePath(ref.path));await directory(path.dirname(target));
  let cached;
  try{
   const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const stat=await handle.stat();if(!stat.isFile()||stat.size>8*1024*1024||(stat.mode&0o077)||stat.uid!==process.getuid())throw Error('Unsafe repository input cache file');cached=await handle.readFile();}finally{await handle.close();}
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(cached){if(digest(cached)!==ref.sha256)throw Error('Cached repository input hash mismatch');onEvent({path:ref.path,status:'cache_verified'});return cached;}
  for(let attempt=1;attempt<=attempts;attempt++){
   try{
    const bytes=await read(ref);
    if(!Buffer.isBuffer(bytes)||bytes.length>8*1024*1024||digest(bytes)!==ref.sha256)throw Error('Pinned repository input bytes differ');
    // Publish only complete verified bytes; interruption leaves an ignorable temp file.
    const temporary=path.join(path.dirname(target),'.input-'+randomUUID());
    const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    try{await link(temporary,target);}finally{await unlink(temporary);}
    onEvent({path:ref.path,status:'download_verified',attempt});return bytes;
   }catch(error){
    onEvent({path:ref.path,status:'failed',attempt,...(error.diagnostic||{kind:'validation_or_cache'})});
    if(!error.retryable||attempt===attempts)throw error;
    await sleep(1000);
   }
  }
 });
}
