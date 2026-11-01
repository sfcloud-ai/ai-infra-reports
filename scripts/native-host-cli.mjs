// One long-lived scheduled-host process. JSON lines bridge native MCP tools;
// no tokens, Slack SDK or replacement sender identity are introduced.
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {CloudRunState,ReadPending} from './cloud-sender.mjs';
import {NativeScheduledHost,NativeSlackTransport,prepareNativeRun} from './native-scheduled-host.mjs';
import {requireThat} from './report-handoff.mjs';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
let state;
try{
 requireThat(process.argv.length===3,'Usage: node scripts/native-host-cli.mjs OPERATOR_CONFIG.json');
 const c=JSON.parse(await readFile(process.argv[2],'utf8'));
 requireThat(c&&Object.keys(c).sort().join()==='allow_final,bundle_file,report_commit,scope,state_file,workspace_host'&&typeof c.allow_final==='boolean','Exact operator configuration required');
 requireThat([c.state_file,c.bundle_file].every(p=>typeof p==='string'&&path.isAbsolute(p)),'Durable absolute journal and bundle paths required');
 const input=createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();let serial=0;
 async function read(){const line=await input.next();requireThat(!line.done&&Buffer.byteLength(line.value)<=4*1024*1024,'Host input closed or too large');return JSON.parse(line.value);}
 const callTool=async(tool,args)=>{
  const id=++serial;emit({type:'tool',id,tool,arguments:args});
  const reply=await read();requireThat(reply.type==='tool_result'&&reply.id===id&&Object.hasOwn(reply,'result'),'Out-of-order native tool response');return reply.result;
 };
 state=new CloudRunState(c.state_file,c.scope);
 const job=await prepareNativeRun(state,{bundleBytes:await readFile(c.bundle_file),reportCommit:c.report_commit,workspaceHost:c.workspace_host});
 const host=new NativeScheduledHost(state,new NativeSlackTransport(callTool),{allowFinal:c.allow_final});
 emit({type:'ready',run_id:job.id,phase:job.phase,not_before:job.detail.not_before,allow_final:c.allow_final});
 while(true){
  const command=await read();requireThat(command.type==='tick'&&Object.keys(command).length===1,'Only tick commands are accepted');
  try{const next=await host.step(job.id);emit({type:'state',phase:next.phase,slack_status:next.detail.slack_status??'not_checked',wecom_status:'not_checked'});if(next.phase==='sender_reported')break;}
  catch(error){if(error instanceof ReadPending)emit({type:'pending',reason:error.message});else throw error;}
 }
}catch{emit({type:'stopped',reason:'Native host stopped; reconcile existing operations. Do not restart to resend.'});process.exitCode=1;}
finally{state?.close();}
