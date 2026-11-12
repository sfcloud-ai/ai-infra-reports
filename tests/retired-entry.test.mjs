import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('retired execution entries cannot create a journal or request a native write',async()=>{
 const root=await mkdtemp(join(tmpdir(),'retired-entry-')),config=join(root,'config.json');
 try{
  const bytes=Buffer.from(JSON.stringify({state_file:join(root,'original.sqlite')}));await writeFile(config,bytes);
  for(const mode of ['--initialize','--serve']){
   const result=spawnSync(process.execPath,['scripts/producer-upload-cli.mjs',config,mode],{encoding:'utf8'});
   assert.notEqual(result.status,0);assert(!result.stdout.includes('"type":"write"'));
  }
  for(const mode of ['--managed-proxy','--research-managed-proxy']){
   const result=spawnSync(process.execPath,['scripts/slack-stage-cli.mjs',config,'C123',mode],{encoding:'utf8'});
   assert.notEqual(result.status,0);assert(!result.stdout.includes('"type":"write"'));
  }
  assert.deepEqual(await readdir(root),['config.json']);assert.deepEqual(await readFile(config),bytes);
 }finally{await rm(root,{recursive:true,force:true});}
});
