// One ephemeral data-staging attempt. Never grants publication or reconstructs
// a Producer journal. Native tool replies enter only through trusted stdin.
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {decodeBundle,requireThat} from './report-handoff.mjs';
import {digest} from './archive.mjs';
import {producerTicket,PRODUCER_TOOLS} from './producer-upload.mjs';
import {producerCurlEnvironment,uploadProducerBytes} from './producer-upload-adapters.mjs';

export async function stageFile(bytes,channel,callTool,{upload=uploadProducerBytes,probe=false,observe=()=>{}}={}){
 requireThat(/^C[A-Z0-9]+$/.test(channel),'Pinned private channel required');
 let id,name,comment;
 if(probe){
  requireThat(bytes.length<=4096,'Probe size bound');const data=JSON.parse(bytes);
  requireThat(Object.keys(data).sort().join()==='nonce,payload,schema_version'&&data.schema_version==='slack_staging_probe_v1'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(data.nonce)&&data.payload==='transport validation; no report publication','Exact inert probe required');
  id=data.nonce;name='ai-brief-transport-probe.json';comment=`!ai-transport-probe ${id} ${digest(bytes)}`;
 }else{
  const bundle=await decodeBundle(bytes);requireThat(bundle.data.request_id===`morning-${bundle.report.date.replaceAll('-','')}-r1`,'Daily revision-one staging required');
  id=bundle.data.request_id;name='ai-brief-bundle.json';comment=`!ai-report stage ${id} ${bundle.hash}`;
 }
 const ticket=producerTicket(await callTool(PRODUCER_TOOLS.ticket,{filename:name,content_length:bytes.length}));
 observe({type:'staging_ticket_observed',request_id:id,bundle_sha256:digest(bytes),file_id:ticket.file_id,publication_allowed:false});
 // Exactly one POST, with existing managed proxy and normal TLS verification.
 // Unknown/error stops this attempt; no ticket refresh, repeat or auto-submit.
 const result=await upload({bytes,ticket},{transport:'managed_proxy'}),m=result.metrics;
 requireThat(result.file_id===ticket.file_id&&result.bundle_sha256===digest(bytes)&&result.url_sha256===ticket.url_sha256&&result.adapter==='producer_curl_managed_proxy_v1'&&m.curl_exit===0&&m.http_status===200&&m.upload_bytes===bytes.length&&m.num_redirects===0&&m.ssl_verify_result===0,'Staging POST unconfirmed; reconcile original file');
 await callTool(PRODUCER_TOOLS.complete,{file_id:ticket.file_id,channel_id:channel,initial_comment:comment});
 return {type:'staging_attempt_finished',request_id:id,bundle_sha256:digest(bytes),file_id:ticket.file_id,publication_allowed:false,next_action:'read_original_stage_and_publisher_status'};
}
export async function stagingMain(args){
 let lines;
 const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
 try{
  const [filename,channel,mode,...extra]=args;requireThat(isAbsolute(filename??'')&&['--managed-proxy','--probe-managed-proxy'].includes(mode)&&extra.length===0,'Usage: absolute bundle, pinned channel, --managed-proxy');
  producerCurlEnvironment('managed_proxy');process.umask(0o077);
  const bytes=await readFile(filename);lines=createInterface({input:process.stdin,crlfDelay:Infinity});const iterator=lines[Symbol.asyncIterator]();
  const callTool=async(tool,args)=>{
   const operation_id=randomUUID();emit({type:'write',operation_id,tool,arguments:args,publication_allowed:false});
   const reply=await iterator.next();requireThat(!reply.done&&Buffer.byteLength(reply.value)<=65536,'Bounded original native result required');
   const value=JSON.parse(reply.value);requireThat(Object.keys(value).sort().join()==='operation_id,result,type'&&value.type==='native_result'&&value.operation_id===operation_id,'Original one-shot native result required');
   requireThat(value.result&&!value.result.isError,'Native staging failed; reconcile original file');return value.result;
  };
  emit(await stageFile(bytes,channel,callTool,{probe:mode==='--probe-managed-proxy',observe:emit}));return 0;
 }catch{emit({type:'staging_unconfirmed',publication_allowed:false,next_action:'read_original_file_and_stage; do not replay this attempt'});return 1;}
 finally{lines?.close();process.stdin.pause();}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)process.exitCode=await stagingMain(process.argv.slice(2));
