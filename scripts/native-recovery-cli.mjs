// Explicit operator entrypoint; never selected by the regular scheduled host.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {CloudRunState,ReadPending} from './cloud-sender.mjs';
import {NativeSlackTransport} from './native-scheduled-host.mjs';
import {NativeRecoveryHost} from './native-recovery-host.mjs';
import {nativeRecoveryPlan,fenceNativeRecovery,readRecoveryFence} from './native-recovery-fence.mjs';
import {decodeBundle,requireThat} from './report-handoff.mjs';
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');let state;
try{
 const [configFile,action,recoveryId]=process.argv.slice(2);
 requireThat(process.argv.length===5&&['plan','fence','run'].includes(action),'Usage: native-recovery-cli.mjs ORIGINAL_OPERATOR.json plan|fence|run RECOVERY_ID');
 const c=JSON.parse(await readFile(configFile,'utf8'));
 requireThat(c.allow_final===true&&path.isAbsolute(c.state_file)&&path.isAbsolute(c.bundle_file),'Original explicit final-delivery operator is required');
 const st=await lstat(c.state_file);requireThat(st.isFile()&&!st.isSymbolicLink()&&await realpath(c.state_file)===path.resolve(c.state_file),'Existing original journal required; never create or copy one');
 state=new CloudRunState(c.state_file,c.scope);const b=await decodeBundle(await readFile(c.bundle_file));
 const job=state.get(b.data.request_id);requireThat(job&&job.bundle.equals(b.bytes??await readFile(c.bundle_file))&&job.detail.report_commit===c.report_commit&&job.detail.workspace_host===c.workspace_host,'Original operator and persisted bundle differ');
 if(action!=='run'){
  const plan=await nativeRecoveryPlan(state,job.id,recoveryId);
  if(action==='fence')await fenceNativeRecovery(state,plan);
  emit({type:action==='fence'?'fenced':'plan',...plan});
 }else{
  requireThat(readRecoveryFence(state,job.id).recovery_id===recoveryId,'Recovery identity differs');
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();let serial=0;
  async function read(){const n=await lines.next();requireThat(!n.done&&Buffer.byteLength(n.value)<=4*1024*1024,'Recovery input closed or too large');return JSON.parse(n.value);}
  const callTool=async(tool,args)=>{const id=++serial;emit({type:'tool',id,tool,arguments:args});const r=await read();requireThat(r.type==='tool_result'&&r.id===id&&Object.hasOwn(r,'result'),'Unexpected tool result');return r.result;};
  const host=new NativeRecoveryHost(state,new NativeSlackTransport(callTool),{allowFinal:true});
  emit({type:'ready',run_id:job.id,phase:job.phase,not_before:job.detail.not_before,allow_final:true});
  while(true){const c=await read();requireThat(c.type==='tick'&&Object.keys(c).length===1,'Only tick commands are accepted');
   try{const n=await host.step(job.id);emit({type:'state',phase:n.phase,wecom_status:'not_checked'});if(n.phase==='sender_reported')break;}
   catch(e){if(e instanceof ReadPending)emit({type:'pending',reason:e.message});else throw e;}
  }
 }
}catch(e){emit({type:'stopped',reason:e.message});process.exitCode=1;}finally{state?.close();}
