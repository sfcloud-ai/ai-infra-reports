// Offline operator entrypoint. Stop the Publisher first; its original lock is
// held for the entire schema activation/approval transaction. No network calls.
import {pathToFileURL} from 'node:url';
import {privateFile,privateDirectory,validateConfig} from './run-handoff.mjs';
import {withLockedHandoffState} from './handoff-state.mjs';
import {assertResearchControl} from './research-control.mjs';
import {installResearchRecovery,approveResearchRecoveryGrant,validateResearchRecoveryGrant} from './research-recovery.mjs';
import {requireThat} from './report-handoff.mjs';
export async function administerRecovery(configFile,action,reference,grantFile=null,now=Date.now()){
 requireThat(['--install','--approve'].includes(action),'Use --install or --approve');
 const config=JSON.parse(await privateFile(configFile,65536));validateConfig(config);await privateDirectory(config.state_dir);
 const bytes=grantFile?await privateFile(grantFile,65536):null;
 return withLockedHandoffState(config,async state=>{
  const db=state.db;requireThat(assertResearchControl(db,config)===true,'Installed research authority required before recovery administration');db.exec('BEGIN IMMEDIATE');
  try{
   let result;
   if(action==='--install'){
    requireThat(bytes===null,'Install does not accept a grant');
    result={installed:installResearchRecovery(db,reference,now)};
   }else{
    requireThat(bytes!==null,'Original grant bytes required');const grant=JSON.parse(bytes);
    const run=db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(grant.request_id);
    requireThat(run&&run.permit===null&&!db.prepare('SELECT 1 FROM jobs WHERE id=?').get(grant.request_id)&&!db.prepare('SELECT 1 FROM slack_staged_bundles WHERE request_id=?').get(grant.request_id),'Recovery requires the original unfinished research task');
    validateResearchRecoveryGrant(grant,{request_id:run.request_id,generation:config.research_control.generation,plan_hash:run.plan_hash,plan:JSON.parse(Buffer.from(run.plan))});
    result=approveResearchRecoveryGrant(db,bytes,reference,now);
   }
   db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [config,action,reference,grant,...extra]=process.argv.slice(2);
 if(extra.length||!config||!reference)throw Error('Usage: research-recovery-admin.mjs CONFIG --install REFERENCE | CONFIG --approve REFERENCE GRANT');
 process.stdout.write(JSON.stringify(await administerRecovery(config,action,reference,grant??null))+'\n');
}
