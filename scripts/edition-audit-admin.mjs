// Explicit offline operator command. Normal startup and deployment never invoke it.
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {privateDirectory,privateFile,validateConfig} from './run-handoff.mjs';
import {withLockedHandoffState} from './handoff-state.mjs';
import {assertResearchControl} from './research-control.mjs';
import {requireThat} from './report-handoff.mjs';
import {applyEditionMigration,prepareEditionMigration,receiptText,storedEditionMigration} from './edition-audit-migration.mjs';

const [configPath,mode,id,...args]=process.argv.slice(2);
requireThat(/^morning-\d{8}-r1$/.test(id) &&
  ((mode==='prepare' && args.length===3) || (mode==='apply' && args.length===2) || (mode==='receipt' && !args.length)),
  'Usage: edition-audit-admin.mjs CONFIG prepare REQUEST ORIGINAL_RESULT EPOCH REVISION | apply REQUEST ORIGINAL_RESULT RECEIPT | receipt REQUEST');
const config=JSON.parse(await privateFile(configPath,65536));
validateConfig(config);
await privateDirectory(config.state_dir);
const pdf=mode==='receipt'?null:await privateFile(args[0],2_000_000);
if(mode==='apply'){
  const expected=(await privateFile(args[1],16_384)).toString('utf8');
  const result=await withLockedHandoffState(config,({db})=>{
    requireThat(assertResearchControl(db,config),'Original authority required');
    return applyEditionMigration(db,id,pdf,expected);
  });
  process.stdout.write(result);
}else{
  const db=new DatabaseSync(join(config.state_dir,'handoff.sqlite'),{readOnly:true});
  try{
    db.exec('BEGIN');
    requireThat(assertResearchControl(db,config),'Original authority required');
    let text=storedEditionMigration(db,id);
    if(mode==='prepare'){
      requireThat(text===null,'Use receipt for an already migrated request');
      const record=prepareEditionMigration(db,id,pdf);
      requireThat(String(record.epoch)===args[1] && String(record.revision)===args[2],'unexpected owner epoch or revision');
      text=receiptText(record);
    }
    requireThat(text!==null,'No committed edition migration receipt');
    db.exec('COMMIT');
    process.stdout.write(text);
  }finally{db.close();}
}
