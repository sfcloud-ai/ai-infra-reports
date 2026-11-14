import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../scripts/archive.mjs';
import {REPOSITORY_INPUT_PATHS,fetchRepositoryInput,repositoryResearchInputs} from '../scripts/repository-research-inputs.mjs';
import {recoverRepositoryInputs} from '../scripts/repository-input-cache.mjs';
const bytes=new Map(REPOSITORY_INPUT_PATHS.map(p=>[p,Buffer.from(p)]));
const plan={schema_version:'research_plan_v4',prompt_commit_sha:'a'.repeat(40),reports_commit_sha:'b'.repeat(40),files:Object.fromEntries([...bytes].map(([p,b])=>[p,digest(b)]))};
async function cache(t){const root=await mkdtemp(path.join(os.tmpdir(),'input-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('partial verified cache survives failure and only missing files download on resume',{skip:process.platform==='win32'?'POSIX ownership and permissions required':false},async t=>{
 const root=await cache(t),calls=[];const error=Object.assign(Error('timeout'),{retryable:true});
 await assert.rejects(recoverRepositoryInputs(plan,root,{sleep:async()=>{},read:async ref=>{calls.push(ref.path);if(ref.path===REPOSITORY_INPUT_PATHS[2])throw error;return bytes.get(ref.path);}}));
 assert.deepEqual(calls,REPOSITORY_INPUT_PATHS.slice(0,3).concat(REPOSITORY_INPUT_PATHS[2]));calls.length=0;
 assert.deepEqual(await recoverRepositoryInputs(plan,root,{read:async ref=>{calls.push(ref.path);return bytes.get(ref.path);}}),bytes);
 assert.deepEqual(calls,REPOSITORY_INPUT_PATHS.slice(2));
 await recoverRepositoryInputs(plan,root,{read:()=>assert.fail('verified cache should suffice')});
 const fresh=await cache(t);let count=0;await recoverRepositoryInputs(plan,fresh,{read:async ref=>{count++;return bytes.get(ref.path);}});assert.equal(count,6);
});
test('cache tampering and links fail closed, never trusted as host authority',{skip:process.platform==='win32'?'POSIX ownership and permissions required':false},async t=>{
 const root=await cache(t);await recoverRepositoryInputs(plan,root,{read:async ref=>bytes.get(ref.path)});
 await assert.rejects(recoverRepositoryInputs({...plan,prompt_commit_sha:'c'.repeat(40)},root),/different/);
 await writeFile(path.join(root,'prompts/audit.md'),'corrupted');
 await assert.rejects(recoverRepositoryInputs(plan,root,{read:()=>assert.fail()}),/hash mismatch/);
 const other=await cache(t);await symlink(root,path.join(other,'prompts'));
 await assert.rejects(recoverRepositoryInputs(plan,other),/Unsafe/);
});
test('integrity failures never retried or persisted',{skip:process.platform==='win32'?'POSIX ownership and permissions required':false},async t=>{
 const root=await cache(t);let calls=0;
 await assert.rejects(recoverRepositoryInputs(plan,root,{read:async()=>{calls++;return Buffer.from('wrong');}}),/bytes differ/);assert.equal(calls,1);
 await assert.rejects(readFile(path.join(root,'prompts/audit.md')),/ENOENT/);
});
test('transport diagnostics retain only safe numeric data and transient errors',async()=>{
 const environment={PATH:'/bin',https_proxy:'http://managed.invalid:3128'};
 for(const code of [28,22,60]){
  await assert.rejects(fetchRepositoryInput(repositoryResearchInputs(plan)[0],{environment,run:async()=>{throw Object.assign(Error('secret'),{code,stderr:Buffer.from('secret token\nREPOSITORY_METRICS 000 0.1 0.2 0 0 30\n')});}}),error=>{
   assert.equal(error.retryable,code===28);assert.equal(error.diagnostic.total_seconds,30);assert(!JSON.stringify(error.diagnostic).includes('secret'));return true;
  });
 }
});

test('resumable cache explicitly rejects platforms without POSIX ownership',async()=>{
 const original=process.getuid;process.getuid=undefined;
 try{await assert.rejects(recoverRepositoryInputs(plan,path.resolve('unused-cache')),/requires POSIX/);}finally{process.getuid=original;}
});
