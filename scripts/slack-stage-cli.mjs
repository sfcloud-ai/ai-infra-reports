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
import {producerCurlEnvironment,uploadProducerBytes,uploadResearchArchiveBytes} from './producer-upload-adapters.mjs';
import {decodeResearchArchive} from './research-archive.mjs';

export async function stageFile(bytes,channel,callTool,{upload,probe=false,research=false,revision=false,authority=null,observe=()=>{}}={}){
 requireThat(/^C[A-Z0-9]+$/.test(channel),'Pinned private channel required');
 requireThat(Number(probe)+Number(research)+Number(revision)<=1,'Single staging format required');
 requireThat(!revision||!authority,'Revisions do not consume a new-daily research permit');
 requireThat(!authority||!probe&&typeof authority.before==='function'&&typeof authority.after==='function','Explicit research authority bridge required');
 upload??=research?uploadResearchArchiveBytes:uploadProducerBytes;
 let id,name,comment;
 if(probe){
  requireThat(bytes.length<=4096,'Probe size bound');const data=JSON.parse(bytes);
  requireThat(Object.keys(data).sort().join()==='nonce,payload,schema_version'&&data.schema_version==='slack_staging_probe_v1'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(data.nonce)&&data.payload==='transport validation; no report publication','Exact inert probe required');
  id=data.nonce;name='ai-brief-transport-probe.json';comment=`!ai-transport-probe ${id} ${digest(bytes)}`;
 }else if(research){
  const archive=decodeResearchArchive(bytes);id=archive.value.request_id;name='ai-brief-research-archive.json';comment=`!ai-research save ${id} ${archive.hash}`;
 }else if(revision){
  const bundle=await decodeBundle(bytes);requireThat(bundle.report.schema_version==='1.1'&&bundle.report.revision>1,'Explicit revision notice required');
  id=bundle.data.request_id;name='ai-brief-bundle.json';comment=`!ai-report revise ${id} ${bundle.hash}`;
 }else{
  const bundle=await decodeBundle(bytes);requireThat(bundle.data.request_id===`morning-${bundle.report.date.replaceAll('-','')}-r1`,'Daily revision-one staging required');
  id=bundle.data.request_id;name='ai-brief-bundle.json';comment=authority?`!ai-report stage-v2 ${id} ${bundle.hash} ${authority.permit_id}`:`!ai-report stage ${id} ${bundle.hash}`;
 }
 const recovered=await authority?.recover?.(bytes);
 if(recovered?.complete)return {type:'staging_attempt_finished',request_id:id,bundle_sha256:digest(bytes),file_id:recovered.file_id,source_ts:recovered.source_ts,publication_allowed:false,next_action:'read_original_stage_and_publisher_status'};
 let ticket;
 if(recovered)ticket={file_id:recovered.file_id};
 else{
 const ticketOperation=await authority?.before('ticket',null,bytes);
 ticket=producerTicket(await callTool(PRODUCER_TOOLS.ticket,{filename:name,content_length:bytes.length},ticketOperation));
 await authority?.after('ticket',ticket.file_id,bytes);
 observe({type:'staging_ticket_observed',request_id:id,bundle_sha256:digest(bytes),file_id:ticket.file_id,publication_allowed:false});
 // Exactly one POST, with existing managed proxy and normal TLS verification.
 // Unknown/error stops this attempt; no ticket refresh, repeat or auto-submit.
 await authority?.before('post',ticket.file_id,bytes);
 let result;
 try{result=await upload({bytes,ticket},{transport:'managed_proxy'});}catch(error){observe({type:'staging_post_observed',request_id:id,file_id:ticket.file_id,bundle_sha256:digest(bytes),metrics:null,outcome:'unknown'});throw error;}
 const m=result.metrics;
 const numeric=['curl_exit','http_status','num_connects','num_redirects','upload_bytes','response_bytes','header_bytes','time_namelookup','time_connect','time_appconnect','time_starttransfer','ssl_verify_result'];
 const metrics=Object.fromEntries(numeric.map(k=>[k,typeof m?.[k]==='number'&&Number.isFinite(m[k])&&m[k]>=0?m[k]:null]));
 observe({type:'staging_post_observed',request_id:id,file_id:ticket.file_id,bundle_sha256:digest(bytes),metrics,outcome:'observed'});
 requireThat(result.file_id===ticket.file_id&&result.bundle_sha256===digest(bytes)&&result.url_sha256===ticket.url_sha256&&result.adapter==='producer_curl_managed_proxy_v1'&&m.curl_exit===0&&m.http_status===200&&m.upload_bytes===bytes.length&&m.num_redirects===0&&m.ssl_verify_result===0,'Staging POST unconfirmed; reconcile original file');
 await authority?.after('post',ticket.file_id,bytes);
 }
 const completeOperation=await authority?.before('complete',ticket.file_id,bytes);
 await callTool(PRODUCER_TOOLS.complete,{file_id:ticket.file_id,channel_id:channel,initial_comment:comment},completeOperation);
 return revision?{type:'revision_submission_attempt_finished',request_id:id,bundle_sha256:digest(bytes),file_id:ticket.file_id,publication_requested:true,next_action:'read_original_publisher_and_revision_delivery_status'}:{type:'staging_attempt_finished',request_id:id,bundle_sha256:digest(bytes),file_id:ticket.file_id,publication_allowed:false,next_action:'read_original_stage_and_publisher_status'};
}
export async function stagingMain(args){
 let lines;
 const revision=args[2]==='--revision-managed-proxy';
 const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
 try{
  const [filename,channel,mode,...extra]=args;requireThat(isAbsolute(filename??'')&&['--managed-proxy','--probe-managed-proxy','--research-managed-proxy','--revision-managed-proxy'].includes(mode)&&extra.length===0,'Usage: absolute bundle, pinned channel, managed proxy mode');
  producerCurlEnvironment('managed_proxy');process.umask(0o077);
  const bytes=await readFile(filename);lines=createInterface({input:process.stdin,crlfDelay:Infinity});const iterator=lines[Symbol.asyncIterator]();
  const callTool=async(tool,args)=>{
   const operation_id=randomUUID();emit({type:'write',operation_id,tool,arguments:args,...(mode==='--revision-managed-proxy'?{publication_requested:true}:{publication_allowed:false})});
   const reply=await iterator.next();requireThat(!reply.done&&Buffer.byteLength(reply.value)<=65536,'Bounded original native result required');
   const value=JSON.parse(reply.value);requireThat(Object.keys(value).sort().join()==='operation_id,result,type'&&value.type==='native_result'&&value.operation_id===operation_id,'Original one-shot native result required');
   requireThat(value.result&&!value.result.isError,'Native staging failed; reconcile original file');return value.result;
  };
  emit(await stageFile(bytes,channel,callTool,{probe:mode==='--probe-managed-proxy',research:mode==='--research-managed-proxy',revision:mode==='--revision-managed-proxy',observe:emit}));return 0;
 }catch{emit(revision?{type:'revision_submission_unconfirmed',publication_requested:true,outcome:'unknown',next_action:'reconcile_original_file_command_and_revision_status'}:{type:'staging_unconfirmed',publication_allowed:false,next_action:'read_original_file_and_stage; do not replay this attempt'});return 1;}
 finally{lines?.close();process.stdin.pause();}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)process.exitCode=await stagingMain(process.argv.slice(2));
