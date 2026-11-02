// Explicit operator-only successor. Never chosen by the scheduled --resume.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {CloudRunState,ReadPending} from './cloud-sender.mjs';
import {NativeSlackTransport,safeTransportError} from './native-scheduled-host.mjs';
import {NativeRecoveryHost} from './native-recovery-host.mjs';
import {planRecoverySuccessor,fenceRecoverySuccessor,recoverySuccessor,inspectRecoverySuccessor} from './recovery-control-successor.mjs';
import {frameRemoteMessage} from './remote-native-dispatch.mjs';
import {decodeBundle,requireThat} from './report-handoff.mjs';
let state,lines,raw=false;
const emit=v=>process.stdout.write(raw?frameRemoteMessage(v):JSON.stringify(v)+'\n');
try{
 const [operator,action,value,confirmation]=process.argv.slice(2);
 requireThat(['plan','fence','inspect','run'].includes(action)&&value,'Usage: native-recovery-successor-cli.mjs ORIGINAL_OPERATOR.json plan SUCCESSOR_ID | fence PLAN.json --confirm-original-owner-stopped | inspect SUCCESSOR_ID --confirm-original-owner-stopped | run SUCCESSOR_ID');
 requireThat(process.argv.length===(['fence','inspect'].includes(action)?6:5),'Unexpected recovery arguments');
 const c=JSON.parse(await readFile(operator,'utf8'));
 requireThat(c.allow_final===true&&path.isAbsolute(c.state_file)&&path.isAbsolute(c.bundle_file),'Original final operator required');
 const st=await lstat(c.state_file);requireThat(st.isFile()&&!st.isSymbolicLink()&&await realpath(c.state_file)===path.resolve(c.state_file),'Existing original journal required');
 state=new CloudRunState(c.state_file,c.scope,{readOnly:action==='inspect'});const bytes=await readFile(c.bundle_file),b=await decodeBundle(bytes),job=state.get(b.data.request_id);
 requireThat(job&&job.bundle.equals(bytes)&&job.detail.report_commit===c.report_commit&&job.detail.workspace_host===c.workspace_host,'Original operator differs');
 if(action==='plan')emit({type:'successor-plan',...planRecoverySuccessor(state,job.id,value)});
 else if(action==='fence'){
  requireThat(confirmation==='--confirm-original-owner-stopped','Explicit stopped-owner confirmation required');
  const plan=JSON.parse(await readFile(value,'utf8'));requireThat(plan.type==='successor-plan','Use original journal successor plan');
  const result=fenceRecoverySuccessor(state,plan,{owner_stopped:true,reference:'explicit CLI stopped-owner confirmation'});emit({...result,type:'successor-fenced'});
 }else if(action==='inspect'){
  requireThat(confirmation==='--confirm-original-owner-stopped','Explicit stopped-owner confirmation required');
  emit({...inspectRecoverySuccessor(state,job.id,value,{owner_stopped:true}),type:'successor-fenced'});
 }else{
  requireThat(recoverySuccessor(state.db,job.id)?.successor_id===value,'Original successor fence missing');
  if(process.stdin.isTTY){process.stdin.setRawMode(true);raw=true;}
  lines=createInterface({input:process.stdin,crlfDelay:Infinity});const input=lines[Symbol.asyncIterator]();let serial=0,interrupted=false;
  if(raw)process.stdin.on('data',v=>{if(Buffer.isBuffer(v)?v.includes(3):v.includes('\x03')){interrupted=true;lines.close();process.stdin.pause();}});
  const read=async()=>{const r=await input.next();requireThat(!interrupted&&!r.done&&Buffer.byteLength(r.value)<=24*1024*1024,'Recovery input unavailable');return JSON.parse(r.value);};
  emit({type:'ready',protocol:'native_remote_runtime_v1'});
  const run=await read();requireThat(run.type==='run'&&Object.keys(run).sort().join()==='deadline,type'&&Number.isSafeInteger(run.deadline)&&run.deadline>Date.now()&&run.deadline<=Date.now()+30*60000,'Bounded recovery execution required');
  const callTool=async(tool,args)=>{
   requireThat(!interrupted&&Date.now()<run.deadline,'Recovery execution slice ended');
   const id=++serial;emit({type:'tool',id,tool,arguments:args});const r=await read();
   if(r.type==='tool_read_error'){requireThat(tool.endsWith('slack_search_public_and_private')&&r.id===id&&r.reason==='temporary_read_failure','Unexpected read failure');throw new ReadPending('Native read temporarily unavailable');}
   requireThat(r.type==='tool_result'&&r.id===id&&Object.hasOwn(r,'result'),'Unexpected tool result');return r.result;
  };
  state.db.exec('CREATE TABLE IF NOT EXISTS native_transport_audit (seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, data TEXT NOT NULL)');
  const audit=data=>state.db.prepare('INSERT INTO native_transport_audit(run_id,recorded_at,data) VALUES(?,?,?)').run(job.id,Date.now(),JSON.stringify(data));
  const observedTool=async(tool,args)=>{
   if(tool.endsWith('slack_complete_file_upload'))audit({stage:'complete_started',file_id:args.file_id,channel_id:args.channel_id});
   let r;try{r=await callTool(tool,args);}catch(e){audit({stage:'tool_threw',tool,...safeTransportError(e)});throw e;}
   if(r?.isError)audit({stage:'tool_returned_error',tool});
   if(tool.endsWith('slack_complete_file_upload'))audit({stage:'complete_returned',file_id:args.file_id,is_error:!!r?.isError});
   return r;
  };
  const host=new NativeRecoveryHost(state,new NativeSlackTransport(observedTool,{onUploadStage:audit}),{allowFinal:true,successorId:value});
  while(Date.now()<run.deadline){
   try{const n=await host.step(job.id,{deadline:run.deadline});if(n.phase==='sender_reported'){emit({type:'complete',slack_status:'verified',wecom_status:'not_checked'});break;}}
   catch(e){if(!(e instanceof ReadPending))throw e;await new Promise(r=>setTimeout(r,Math.min(5000,Math.max(0,run.deadline-Date.now()))));}
  }
  if(state.get(job.id).phase!=='sender_reported')emit({type:'stopped',reason:'Recovery slice ended; reconcile original operations, never restart a grant',slack_status:'not_checked',wecom_status:'not_checked'});
 }
}catch(e){emit({type:'stopped',reason:'Recovery successor stopped; inspect original journal',error_type:e?.name??'unknown',slack_status:'not_checked',wecom_status:'not_checked'});process.exitCode=1;}
finally{lines?.close();if(raw)try{process.stdin.setRawMode(false);}catch{}process.stdin.pause();state?.close();}
