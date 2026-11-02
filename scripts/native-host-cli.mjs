// One long-lived scheduled-host process. JSON lines bridge native MCP tools;
// no tokens, Slack SDK or replacement sender identity are introduced.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {CloudRunState,ReadPending} from './cloud-sender.mjs';
import {NativeScheduledHost,NativeSlackTransport,prepareNativeRun} from './native-scheduled-host.mjs';
import {requireThat,decodeBundle} from './report-handoff.mjs';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
let state,inputLines;
try{
 requireThat(process.argv.length===3||(process.argv.length===5&&process.argv[3]==='--resume'),'Usage: node scripts/native-host-cli.mjs OPERATOR_CONFIG.json [--resume RUN_ID]');
 const resumeId=process.argv[4];
 requireThat(resumeId===undefined||resumeId.length>0,'Resume run identifier required');
 const c=JSON.parse(await readFile(process.argv[2],'utf8'));
 requireThat(c&&Object.keys(c).sort().join()==='allow_final,bundle_file,report_commit,scope,state_file,workspace_host'&&typeof c.allow_final==='boolean','Exact operator configuration required');
 requireThat([c.state_file,c.bundle_file].every(p=>typeof p==='string'&&path.isAbsolute(p)),'Durable absolute journal and bundle paths required');
 inputLines=createInterface({input:process.stdin,crlfDelay:Infinity});
 const input=inputLines[Symbol.asyncIterator]();let serial=0;
 async function read(){const line=await input.next();requireThat(!line.done&&Buffer.byteLength(line.value)<=4*1024*1024,'Host input closed or too large');return JSON.parse(line.value);}
 const callTool=async(tool,args)=>{
  const id=++serial;emit({type:'tool',id,tool,arguments:args});
  const reply=await read();
  if(reply.type==='tool_read_error'){requireThat(tool.endsWith('slack_search_public_and_private')&&reply.id===id&&reply.reason==='temporary_read_failure','Invalid read failure response');throw new ReadPending('Temporary native Slack read failure');}
  requireThat(reply.type==='tool_result'&&reply.id===id&&Object.hasOwn(reply,'result'),'Out-of-order native tool response');return reply.result;
 };
 if(resumeId){
  const info=await lstat(c.state_file);
  requireThat(info.isFile()&&!info.isSymbolicLink()&&await realpath(c.state_file)===path.resolve(c.state_file),'Original durable journal required');
 }
 const bundleBytes=await readFile(c.bundle_file);
 if(resumeId)requireThat((await decodeBundle(bundleBytes)).data.request_id===resumeId,'Resume run differs from operator bundle');
 state=new CloudRunState(c.state_file,c.scope);
 if(resumeId)requireThat(state.get(resumeId),'Resume requires the original persisted run');
 const job=await prepareNativeRun(state,{bundleBytes,reportCommit:c.report_commit,workspaceHost:c.workspace_host});
 if(resumeId)requireThat(job.id===resumeId,'Resume run differs from operator bundle');
 const host=new NativeScheduledHost(state,new NativeSlackTransport(callTool),{allowFinal:c.allow_final});
 emit({type:'ready',protocol:'native_durable_retry_v1',run_id:job.id,phase:job.phase,not_before:job.detail.not_before,allow_final:c.allow_final});
 while(true){
  const command=await read();
  if(command.type==='defer'){
   requireThat(Object.keys(command).length===1,'Invalid defer command');
   const deferred=state.deferNativeRun(job.id,Date.now());emit({type:'deferred',...deferred,state_file:c.state_file});break;
  }
  requireThat(command.type==='tick'&&Object.keys(command).every(k=>['type','deadline'].includes(k))&&(command.deadline===undefined||Number.isSafeInteger(command.deadline)&&command.deadline>0),'Only bounded tick or defer commands are accepted');
  try{const next=await host.step(job.id,{deadline:command.deadline});emit({type:'state',phase:next.phase,completion_window:host.ownsCompletionWindow(job.id),slack_status:next.detail.slack_status??'not_checked',wecom_status:'not_checked'});if(next.phase==='sender_reported')break;}
  catch(error){if(error instanceof ReadPending){
   const current=state.get(job.id),now=Date.now();
   const due=current.phase==='native_prepared'?Date.parse(current.detail.not_before)-600000:current.phase==='native_begin'?Date.parse(current.detail.not_before):0;
   state.deferRead(job.id,'poll',{now,nextAt:Math.max(now+5000,due,state.retryAt(job.id)??0),reason:error.message.slice(0,200)});
   emit({type:'pending',phase:current.phase,completion_window:host.ownsCompletionWindow(job.id),reason:error.message,next_attempt_at:state.retryAt(job.id)});
  }else throw error;}
 }
}catch{emit({type:'stopped',reason:'Native host stopped; reconcile existing operations. Do not restart to resend.'});process.exitCode=1;}
finally{inputLines?.close();process.stdin.pause();state?.close();}
