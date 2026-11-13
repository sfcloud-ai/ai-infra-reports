// Explicit offline additive migration. No uploads, research or sends.
import {pathToFileURL} from 'node:url';
import {privateFile,privateDirectory,validateConfig} from './run-handoff.mjs';
import {withLockedHandoffState} from './handoff-state.mjs';
import {assertResearchControl} from './research-control.mjs';
import {installPageAuthority} from './research-page-authority.mjs';
import {requireThat} from './report-handoff.mjs';
export async function installPages(configFile){
 const config=JSON.parse(await privateFile(configFile,65536));validateConfig(config);await privateDirectory(config.state_dir);
 return withLockedHandoffState(config,async state=>{
  requireThat(assertResearchControl(state.db,config),'Original authority required');state.db.exec('BEGIN IMMEDIATE');
  try{const installed=installPageAuthority(state.db);state.db.exec('COMMIT');return {installed};}
  catch(error){state.db.exec('ROLLBACK');throw error;}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [config,action,...rest]=process.argv.slice(2);requireThat(config&&action==='--install'&&!rest.length,'Usage: research-page-admin.mjs CONFIG --install');
 process.stdout.write(JSON.stringify(await installPages(config))+'\n');
}
