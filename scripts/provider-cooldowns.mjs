import {open,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {requireThat} from './report-handoff.mjs';
import {scopeDigest} from './handoff-state.mjs';
import {operationError} from './github.mjs';
import {safeDiagnostic} from './handoff-recovery.mjs';
export const PROVIDER_SCOPES=['github.public','github.producer','github.app','slack.auth.test','slack.conversations.info','slack.conversations.history','slack.conversations.replies','slack.files.info','slack.chat.postMessage'];
const canonical=scope=>scope.startsWith('slack.')?scope:'slack.'+scope;
const normalize=scope=>PROVIDER_SCOPES.includes(scope)?scope:canonical(scope);
const validDeadline=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
// Separate from all publication and alert intents. Short SQLite transactions
// coordinate processes without taking the Publisher's long-running tick lock.
export class ProviderCooldowns{
 constructor(filename,identity){
  this.db=new DatabaseSync(filename);
  try{
   this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS provider_scope(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS provider_deadlines(scope TEXT PRIMARY KEY,retry_at INTEGER NOT NULL)');
   this.db.prepare('INSERT OR IGNORE INTO provider_scope VALUES(1,?)').run(identity);
   requireThat(this.db.prepare('SELECT value FROM provider_scope WHERE id=1').get()?.value===identity,'Provider cooldown identity changed');
  }catch(error){this.db.close();throw error;}
 }
 deadline(scope){
  const value=this.db.prepare('SELECT retry_at FROM provider_deadlines WHERE scope=?').get(normalize(scope))?.retry_at;
  requireThat(value===undefined||validDeadline(value),'Invalid provider deadline');return value??0;
 }
 defer(scope,retryAt){
  scope=normalize(scope);requireThat(PROVIDER_SCOPES.includes(scope)&&validDeadline(retryAt),'Invalid provider cooldown');
  this.db.prepare('INSERT INTO provider_deadlines VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET retry_at=MAX(retry_at,excluded.retry_at)').run(scope,retryAt);
 }
 close(){this.db.close();}
}
export async function openProviderCooldowns(config,{privateFile,privateDirectory,createDirectory=false}){
 const directory=path.join(config.state_dir,'provider-cooldowns');
 await privateDirectory(config.state_dir);
 if(createDirectory)try{await mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 await privateDirectory(directory);
 const filename=path.join(directory,'cooldowns.sqlite');
 try{const file=await open(filename,'wx',0o600);await file.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 await privateFile(filename,1024*1024,false);
 const {team_id,bot_id,bot_user_id}=config;
 return new ProviderCooldowns(filename,scopeDigest({team_id,bot_id,bot_user_id}));
}
export async function guardProviderOperation(cooldowns,scopes,run,now=Date.now){
 for(const scope of scopes){
  const retry_at=cooldowns.deadline(scope);
  if(retry_at>now())throw operationError('Provider cooldown',{stage:'provider_cooldown',provider_scope:scope,code:'rate_limited',outcome:'not_started',retryable:true,retry_at});
 }
 try{return await run();}catch(error){
  const diagnostic=safeDiagnostic(error),scope=diagnostic.provider_scope??diagnostic.stage;
  if(PROVIDER_SCOPES.includes(scope)&&validDeadline(diagnostic.retry_at))cooldowns.defer(scope,diagnostic.retry_at);
  throw error;
 }
}
export function providerIO(io,cooldowns,now=Date.now){
 const result={...io,providerDeadline:scope=>Math.max(cooldowns.deadline(scope),io.providerDeadline?.(scope)??0)};
 const methods={propose:['github.app','github.producer'],reconcileProposal:['github.public'],readPR:['github.public'],readMergeCommit:['github.public'],readCommit:['github.public'],verify:['github.public']};
 for(const [method,scopes]of Object.entries(methods))if(io[method])result[method]=(...args)=>guardProviderOperation(cooldowns,scopes,()=>io[method](...args),now);
 return result;
}
