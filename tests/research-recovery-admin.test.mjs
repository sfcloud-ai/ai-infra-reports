import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HandoffState,handoffScope} from '../scripts/handoff-state.mjs';
import {administerRecovery} from '../scripts/research-recovery-admin.mjs';

test('offline recovery administration requires installed authority before any recovery schema write',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'recovery-admin-'));
 const config={team_id:'T123',channel_id:'C123',sender_user_id:'U123',bot_user_id:'U456',bot_id:'B456',producer_app_id:10,merger_app_id:11,slack_token_file:join(directory,'token'),producer_key_file:join(directory,'key'),state_dir:directory,ready_for_review:false};
 const filename=join(directory,'config.json'),grantFile=join(directory,'grant.json');
 await writeFile(filename,JSON.stringify(config),{mode:0o600});await writeFile(grantFile,'{}',{mode:0o600});
 const snapshot=()=>{const state=new HandoffState(join(directory,'handoff.sqlite'),handoffScope(config));try{return {schema:state.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),scope:state.db.prepare('SELECT * FROM scope').all()};}finally{state.close();}};
 try{
  const original=snapshot();
  for(const action of ['--install','--approve']){
   await assert.rejects(administerRecovery(filename,action,'synthetic explicit approval',action==='--approve'?grantFile:null),/Installed research authority required/);
   assert.deepEqual(snapshot(),original);
   assert.equal(snapshot().schema.some(row=>row.name.startsWith('research_recovery_')),false);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
