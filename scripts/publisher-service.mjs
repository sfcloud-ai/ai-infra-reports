// The service manager pins the non-root account, release directory and config.
// SIGTERM drains the current tick. Durable unknown writes are reconciled by the
// worker, while an unavailable dependency does not silently stop the supervisor.
import path from "node:path";
import {writeFile,rename} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {randomUUID} from "node:crypto";
import {runHandoff,privateFile,privateDirectory,validateConfig} from "./run-handoff.mjs";
import {safeDiagnostic} from './handoff-recovery.mjs';
import {isHandoffLockBusy} from './handoff-lock.mjs';

export async function serialTicks(tick,report,wait,signal,onError){
 while(!signal.aborted){
  let result,recovery;
  try{result=await tick();}catch(error){if(!onError)throw error;recovery=await onError(error);}
  if(result!==undefined)await report(result);
  if(signal.aborted)break;
  const requested=result?.next_delay_ms??recovery?.next_delay_ms;
  const interval=Number.isFinite(requested)?Math.max(1000,Math.min(120000,requested)):120000;
  try{await wait(interval,signal);}catch(error){if(error.name!=="AbortError"||!signal.aborted)throw error;}
 }
}
export function releaseIdentity(directory){
 const commit=path.basename(directory);
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error("Immutable release directory required");
 return commit;
}
export async function writeHealth(directory,health){
 const temporary=path.join(directory,`health.${randomUUID()}.tmp`);
 await writeFile(temporary,JSON.stringify(health)+"\n",{mode:0o600,flag:"wx"});
 await rename(temporary,path.join(directory,"health.json"));
}
export async function superviseTicks(tick,report,wait,signal,identity,onDeferred=()=>{}){
 let count=0;
 await serialTicks(tick,async result=>{
  const healthy=result.healthy===true;count=healthy?count+1:0;
  await report({...result,...identity,healthy,successful_checks:count,checked_at:new Date().toISOString()});
 },wait,signal,async error=>{
  count=0;
  if(isHandoffLockBusy(error)){
   // Preserve the last completed health observation. Refreshing checked_at here
   // would hide a stuck lock; repeated deferrals must become heartbeat_stale.
   await onDeferred({...identity,phase:'tick_deferred',observed_at:new Date().toISOString(),error:safeDiagnostic(error,'tick')});
   return {next_delay_ms:1000};
  }
  await report({...identity,healthy:false,successful_checks:count,checked_at:new Date().toISOString(),phase:'tick_failed',error:safeDiagnostic(error,'tick')});
 });
}
async function main(){
 const [configFile,flag,...extra]=process.argv.slice(2);
 if(process.platform!=="linux"||process.getuid()<=0||!configFile||flag!=="--live"||extra.length)throw Error("Explicit non-root Linux service required");
 const commit=releaseIdentity(process.cwd());
 const config=validateConfig(JSON.parse((await privateFile(configFile,16384)).toString("utf8")));
 await privateDirectory(config.state_dir);
 const stop=new AbortController();process.once("SIGTERM",()=>stop.abort());process.once("SIGINT",()=>stop.abort());
 const started_at=new Date().toISOString();
 await writeHealth(config.state_dir,{healthy:false,mode:'live',consumption_enabled:true,commit,successful_checks:0,checked_at:started_at,started_at,pid:process.pid,phase:'starting'});
 await superviseTicks(()=>runHandoff(configFile),async health=>{
  await writeHealth(config.state_dir,health);
  (health.error?console.error:console.log)(JSON.stringify(health));
 },(ms,signal)=>delay(ms,undefined,{signal}),stop.signal,{mode:'live',consumption_enabled:true,commit,started_at,pid:process.pid},diagnostic=>console.log(JSON.stringify(diagnostic)));
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 main().catch(()=>{console.error("Publisher stopped. Reconcile durable state before restarting; uncertain writes are never retried automatically.");process.exitCode=1;});
}
