// Native calls are performed by the trusted orchestrator. Stdin carries their
// original envelopes through a non-echoing pipe, never a reconstructed receipt.
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {researchClientScope,researchCommandText,verifyResearchControlReceipt,nativeResearchAuthority} from './research-control-client.mjs';
import {stageFile} from './slack-stage-cli.mjs';
import {producerCurlEnvironment} from './producer-upload-adapters.mjs';
import {requireThat} from './report-handoff.mjs';
import {digest} from './archive.mjs';
export async function researchClientMain(args){
 let lines;const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
 try{
  const [configFile,file,mode,...extra]=args;
  requireThat(isAbsolute(configFile??'')&&isAbsolute(file??'')&&['--control','--stage','--archive','--submit'].includes(mode)&&extra.length===0,'Usage: absolute client config, original command or artifact, --control|--stage|--archive|--submit');
  const c=JSON.parse(await readFile(configFile,'utf8'));researchClientScope(c.scope);process.umask(0o077);
  requireThat(Object.keys(c).sort().join()===(mode==='--control'?'scope':mode==='--submit'?'scope,stage,upload':'scope,upload'),'Exact disposable client configuration required');
  if(mode==='--stage'||mode==='--archive')producerCurlEnvironment('managed_proxy');
  lines=createInterface({input:process.stdin,crlfDelay:Infinity});const iterator=lines[Symbol.asyncIterator]();
  const read=async()=>{const line=await iterator.next();requireThat(!line.done&&Buffer.byteLength(line.value)<=256*1024,'Bounded original tool result required');return JSON.parse(line.value);};
  const control=async bytes=>{
   emit({type:'control',channel_id:c.scope.channel_id,message:researchCommandText(bytes),next_action:'send_original_command_and_read_its_publisher_receipt'});
   const reply=await read();requireThat(reply.type==='control_result','Original control result required');
   return verifyResearchControlReceipt(c.scope,bytes,reply.source_ts,reply.invocation);
  };
  const bytes=await readFile(file);
  if(mode==='--control'){emit({type:'control_observed',result:await control(bytes)});return 0;}
  const authority=nativeResearchAuthority(c.upload,control);
  requireThat(mode==='--archive'?authority.permit_id===null:authority.permit_id!==null,'Original artifact authority kind required');
  const callTool=async(tool,arguments_,operation_id)=>{
   emit({type:'write',operation_id,tool,arguments:arguments_});const r=await read();
   requireThat(r.type==='native_result'&&r.operation_id===operation_id&&r.result&&!r.result.isError,'Original native operation remains unresolved');return r.result;
  };
  if(mode==='--submit'){
   requireThat(c.stage&&Object.keys(c.stage).sort().join()==='file_id,source_ts','Original host staging receipt required');
   const operation_id=await authority.before('submit',c.stage.file_id,bytes,c.stage.source_ts);
   await callTool('mcp__codex_apps__slack_slack_send_message',{channel_id:c.scope.channel_id,message:`!ai-report submit-v2 ${authority.publication_request_id} ${digest(bytes)} ${c.stage.source_ts} ${authority.permit_id}`,unfurl_app_links:false},operation_id);
   emit({type:'submission_attempt_finished',next_action:'read_original_host_publication_and_delivery'});return 0;
  }
  emit(await stageFile(bytes,c.scope.channel_id,callTool,{authority,research:mode==='--archive',observe:emit}));return 0;
 }catch{emit({type:'research_client_unconfirmed',next_action:'read_original_host_run_and_reconcile_original_operation'});return 1;}
 finally{lines?.close();process.stdin.pause();}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)process.exitCode=await researchClientMain(process.argv.slice(2));
