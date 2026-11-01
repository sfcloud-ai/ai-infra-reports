// The service manager pins the non-root account, release directory and config.
// SIGTERM drains the current tick; a failed/unknown write never starts another tick.
import path from "node:path";
import {writeFile,rename} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {randomUUID} from "node:crypto";
import {runHandoff,privateFile,privateDirectory,validateConfig} from "./run-handoff.mjs";

export async function serialTicks(tick,report,wait,signal){
 while(!signal.aborted){
  const result=await tick();await report(result);
  if(signal.aborted)break;
  try{await wait(120000,signal);}catch(error){if(error.name!=="AbortError"||!signal.aborted)throw error;}
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
async function main(){
 const [configFile,flag,...extra]=process.argv.slice(2);
 if(process.platform!=="linux"||process.getuid()<=0||!configFile||flag!=="--live"||extra.length)throw Error("Explicit non-root Linux service required");
 const commit=releaseIdentity(process.cwd());
 const config=validateConfig(JSON.parse((await privateFile(configFile,16384)).toString("utf8")));
 await privateDirectory(config.state_dir);
 const stop=new AbortController();process.once("SIGTERM",()=>stop.abort());process.once("SIGINT",()=>stop.abort());
 let count=0;const started_at=new Date().toISOString();
 await serialTicks(()=>runHandoff(configFile),async result=>{
  const health={...result,healthy:true,mode:"live",consumption_enabled:true,commit,successful_checks:++count,checked_at:new Date().toISOString(),started_at,pid:process.pid};
  await writeHealth(config.state_dir,health);
  console.log(JSON.stringify(health));
 },(ms,signal)=>delay(ms,undefined,{signal}),stop.signal);
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 main().catch(()=>{console.error("Publisher stopped. Reconcile durable state before restarting; uncertain writes are never retried automatically.");process.exitCode=1;});
}
