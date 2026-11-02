// JSON-lines bridge for one cloud execution slice. Only new reservations may
// opt in; --resume discovers existing remote journals without a local database.
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {requireThat} from './report-handoff.mjs';
import {CloudRunState,ReadPending} from './cloud-sender.mjs';
import {NativeScheduledHost,NativeSlackTransport,prepareNativeRun,NATIVE_TOOLS} from './native-scheduled-host.mjs';
import {RemoteControl,RemoteNativeRuntime,REMOTE_READ_TOOLS,discoverRemoteRuns,readRemoteBundle,SliceEnded,temporaryRead} from './remote-native-runtime.mjs';
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
let lines,state;
try{
 const [mode,filename,...extra]=process.argv.slice(2);
 requireThat(['--resume','--start'].includes(mode)&&filename&&!extra.length,'Usage: remote-native-cli.mjs --resume|--start CONFIG.json');
 const c=JSON.parse(await readFile(filename,'utf8')),starting=mode==='--start';
 const keys=['allow_final','scope','workspace_host',...(starting?['state_file','bundle_file','report_commit']:[])].sort().join();
 requireThat(c&&Object.keys(c).sort().join()===keys&&typeof c.allow_final==='boolean','Exact remote operator required');
 lines=createInterface({input:process.stdin,crlfDelay:Infinity});const input=lines[Symbol.asyncIterator]();let serial=0;
 const read=async()=>{const r=await input.next();requireThat(!r.done&&Buffer.byteLength(r.value)<=24*1024*1024,'Invalid host input');return JSON.parse(r.value);};
 emit({type:'ready',protocol:'native_remote_runtime_v1'});
 const run=await read();requireThat(Object.keys(run).sort().join()==='deadline,type'&&run.type==='run'&&Number.isSafeInteger(run.deadline)&&run.deadline>Date.now()&&run.deadline<=Date.now()+30*60000,'Bounded run required');
 const callTool=async(tool,args)=>{
  requireThat(Date.now()<run.deadline,'Execution slice ended before tool call');
  const id=++serial;emit({type:'tool',id,tool,arguments:args});const reply=await read();
  if(reply.type==='tool_read_error'){requireThat([NATIVE_TOOLS.search,...Object.values(REMOTE_READ_TOOLS)].includes(tool)&&reply.id===id&&reply.reason==='temporary_read_failure','Invalid read error');throw new ReadPending('Native read temporarily unavailable');}
  requireThat(reply.type==='tool_result'&&reply.id===id&&Object.hasOwn(reply,'result'),'Out-of-order tool response');return reply.result;
 };
 const config={...c.scope,workspace_host:c.workspace_host},transport=new NativeSlackTransport(callTool),control=new RemoteControl(config,transport,{deadline:run.deadline});
 let entry,bytes;
 if(starting){
  requireThat([c.state_file,c.bundle_file].every(p=>typeof p==='string'&&path.isAbsolute(p)),'Absolute bootstrap paths required');
  bytes=await readFile(c.bundle_file);state=new CloudRunState(c.state_file,c.scope);
  let job=await prepareNativeRun(state,{bundleBytes:bytes,reportCommit:c.report_commit,workspaceHost:c.workspace_host});
  requireThat(['native_prepared','native_reserve','native_begin'].includes(job.phase)&&!state.op(job.id,'native:begin:command')&&!state.op(job.id,'final_complete'),'Only an original pre-begin reservation may opt in');
  const host=new NativeScheduledHost(state,transport,{allowFinal:false});
  while(job.phase!=='native_begin'){
   if(Date.now()+180000>=run.deadline)throw new SliceEnded('Bootstrap incomplete; retain original local journal, do not create a replacement');
   try{job=await host.step(job.id,{deadline:run.deadline});}catch(error){if(!temporaryRead(error))throw error;await control.sleep(5000);}
  }
  entry={report_request_id:job.id,bundle_sha256:job.detail.bundle_sha256,attempt_id:job.detail.attempt_id,file_id:job.detail.file_id};
 }else{
  const catalog=await discoverRemoteRuns(control);entry=catalog.find(e=>e.next_attempt_at<=Date.now());
  if(!entry){emit({type:'idle',next_attempt_at:catalog[0]?.next_attempt_at??null,slack_status:'not_checked',wecom_status:'not_checked'});process.exitCode=0;}
  else bytes=await readRemoteBundle(callTool,config,entry);
 }
 if(entry){const host=new RemoteNativeRuntime(control,entry,bytes,{allowFinal:c.allow_final});emit(await host.run({open:starting}));}
}catch(error){
 // No assertion that a defer was persisted when the control reply is unknown.
 emit({type:'stopped',reason:error instanceof SliceEnded?'Execution slice ended; discover existing remote intents next time. Bootstrap uploads require the original journal.':'Remote runtime stopped; reconcile original operations. No replacement upload or grant.',slack_status:'not_checked',wecom_status:'not_checked'});process.exitCode=1;
}finally{lines?.close();process.stdin.pause();state?.close();}
