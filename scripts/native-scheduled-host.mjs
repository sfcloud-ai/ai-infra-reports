// Native MCP transport + scheduled-host steps. The existing CloudRunState is the
// client write-intent journal; the Publisher remains the reservation authority.
import {randomUUID} from 'node:crypto';
import {digest} from './archive.mjs';
import {decodeBundle,requireThat,verifyReportPublication} from './report-handoff.mjs';
import {ReadPending,ReconciliationRequired} from './cloud-sender.mjs';
import {freshNativeCommand,nativeReceiptSearch,readNativeReceipt,nativeCompletionArguments} from './native-notice.mjs';
import {createNoticeManifest} from './notice-manifest.mjs';
export const NATIVE_TOOLS=Object.freeze({
 ticket:'mcp__codex_apps__slack_slack_get_file_upload_url',
 complete:'mcp__codex_apps__slack_slack_complete_file_upload',
 search:'mcp__codex_apps__slack_slack_search_public_and_private'
});
const TS=/^\d{10}\.\d{6}$/;
function toolJson(result,maxBytes=Infinity){
 requireThat(result&&!result.isError&&result.content?.length===1&&result.content[0].type==='text'&&typeof result.content[0].text==='string'&&Buffer.byteLength(result.content[0].text)<=maxBytes,'Native tool failed or changed format');
 return JSON.parse(result.content[0].text);
}
function uploadTicket(result){
 const value=toolJson(result,16384);
 requireThat(value&&typeof value==='object'&&!Array.isArray(value),'Upload ticket format changed');
 if(Object.keys(value).sort().join() === 'file_id,upload_url')return value;
 requireThat(Object.keys(value).join()==='result'&&typeof value.result==='string','Upload ticket format changed');
 // The native connector wraps a formatted result inside its JSON text block.
 // Only these two fields are data; never interpret the trailing instructions.
 const m=/^Upload URL generated successfully!\r?\n\r?\nFile ID: (F[A-Z0-9]+)\r?\nUpload URL: ([^\r\n]+)\r?\n\r?\nInstructions:\r?\n([^\0]+)$/.exec(value.result);
 requireThat(m&&!/(?:File ID|Upload URL):/.test(m[3]),'Upload ticket format changed');
 return {file_id:m[1],upload_url:m[2]};
}
function searchArgs(config,keywords,channel=config.channel_id){
 return {keywords,filters:`in:<#${channel}> from:<@${config.sender_user_id}>`,natural_language_query:'',channel_types:channel.startsWith('D')?'im':'private_channel',content_types:'messages',include_bots:true,include_context:false,response_format:'detailed',limit:2,sort:'timestamp',sort_dir:'desc'};
}
// This is a bounded message locator, not raw Slack identity or file proof. The
// Publisher authenticates command bytes; check validates the final DM separately.
export function nativeMessageLocator(result,{config,channel,expectedText,expectedAttribution}){
 const b=toolJson(result);
 requireThat(['End of results - No more pages available.\n','End of results - No more pages available.\\n'].includes(b.pagination_info)&&typeof b.results==='string'&&Buffer.byteLength(b.results)<32768,'Incomplete native message search');
 if(/^# Search Results for: [^\n]*\n\nNo results found\.\n$/.test(b.results))return null;
 const m=/^# Search Results for: [^\n]*\n\n## Messages \(1 results\)\n### Result 1 of 1\nChannel: (?:#[^\n]+|DM) \(ID: ([CDG][A-Z0-9]+)\)\n(?:Participants: [^\n]+\n)?From: [^\n]+ \(ID: (U[A-Z0-9]+)\) (?: \[BOT\])?\nTime: [^\n]+\nMessage_ts: (\d{10}\.\d{6})\n(?:Reply count: \d+\n)?Permalink: \[link\]\((https:\/\/[^\n]+)\)\nText: \n([\s\S]*)\n\n---\n\n$/.exec(b.results);
 requireThat(m&&m[1]===channel&&m[2]===config.sender_user_id,'Unexpected or ambiguous native source');
 const u=new URL(m[4]);
 requireThat(u.hostname===config.workspace_host&&!u.port&&!u.username&&!u.password&&!u.hash&&u.pathname===`/archives/${channel}/p${m[3].replace('.','')}`,'Native source workspace/path mismatch');
 const keys=[...u.searchParams.keys()].sort().join();
 requireThat(keys===''||(keys==='cid,thread_ts'&&u.searchParams.get('cid')===channel&&u.searchParams.get('thread_ts')===m[3]),'Source must be a top-level message');
 if(expectedText!==undefined)requireThat(m[5]===expectedText||(expectedAttribution&&m[5]===expectedText+' '+expectedAttribution),'Control command text differs');
 return {source_ts:m[3]};
}
export class NativeSlackTransport{
 constructor(callTool,{uploadFetch=fetch}={}){this.callTool=callTool;this.uploadFetch=uploadFetch;}
 async upload(bytes,name){
  const t=uploadTicket(await this.callTool(NATIVE_TOOLS.ticket,{filename:name,content_length:bytes.length}));
  requireThat(typeof t.file_id==='string'&&/^F[A-Z0-9]+$/.test(t.file_id)&&typeof t.upload_url==='string','Upload ticket format changed');
  requireThat(/^https:\/\/files\.slack\.com\/upload\/v1\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+$/.test(t.upload_url),'Unexpected upload endpoint');
  const u=new URL(t.upload_url);
  requireThat(u.protocol==='https:'&&u.hostname==='files.slack.com'&&!u.port&&!u.username&&!u.password&&!u.hash&&u.pathname.startsWith('/upload/v1/'),'Unexpected upload endpoint');
  // Never normalize the signed URL, follow redirects or retry this mutation.
  const r=await this.uploadFetch(t.upload_url,{method:'POST',body:bytes,headers:{'content-type':name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':'application/json','content-length':String(bytes.length)},redirect:'error',signal:AbortSignal.timeout(30000)});
  requireThat(r.status===200,'Upload outcome unconfirmed; do not obtain a replacement ticket');
  await r.body?.cancel();return {file_id:t.file_id};
 }
 async complete(args){const r=await this.callTool(NATIVE_TOOLS.complete,args);requireThat(r&&!r.isError,'Completion outcome unconfirmed');return null;}
 async source(bytes,config){
  const c=JSON.parse(bytes),comment=`!ai-notice submit ${c.command_id} ${digest(bytes)}`;
  return nativeMessageLocator(await this.callTool(NATIVE_TOOLS.search,searchArgs(config,['"!ai-notice submit"',`"${c.command_id}"`])),{config,channel:config.channel_id,expectedText:comment,expectedAttribution:config.sender_attribution_text});
 }
 async receipt(bytes,sourceTs,config){
  const args=nativeReceiptSearch(bytes,config),result=await this.callTool(NATIVE_TOOLS.search,args),body=toolJson(result);
  if(body.results==='# Search Results for: \n\nNo results found.\n')throw new ReadPending('Publisher receipt pending; poll the same command');
  const invocation={tool:NATIVE_TOOLS.search,arguments:args,result};
  return {invocation,receipt:readNativeReceipt(invocation,{bytes,sourceTs,config})};
 }
 async finalSource(manifest,config){
  const args=searchArgs(config,['"AI Infra 晨报"',`"${manifest.date}"`,`"${manifest.articles[0].url}"`],config.notification_destination);
  return nativeMessageLocator(await this.callTool(NATIVE_TOOLS.search,args),{config,channel:config.notification_destination});
 }
}
export async function prepareNativeRun(state,{bundleBytes,reportCommit,workspaceHost,deliveryMode}){
 const b=await decodeBundle(bundleBytes);
 requireThat(/^[a-f0-9]{40}$/.test(reportCommit)&&/^[a-z0-9-]+\.slack\.com$/.test(workspaceHost),'Pinned publication and workspace required');
 const mode=deliveryMode??state.get(b.data.request_id)?.detail.mode??'native_bundle_v1';
 requireThat(['native_v1','native_bundle_v1'].includes(mode),'Unsupported persisted native transport');
 const detail={mode,report_commit:reportCommit,workspace_host:workspaceHost,bundle_sha256:b.hash,not_before:b.report.date+'T00:00:00.000Z'};
 return state.admit(b.data.request_id,`${b.report.date}/r${b.report.revision}`,bundleBytes,detail,'native_prepared',detail);
}
export class NativeScheduledHost{
 #cache=new Map();
 #retryAfter=new Map();
 constructor(state,transport,{allowFinal=false,now=Date.now,fetchPublic=fetch}={}){
  this.state=state;this.transport=transport;this.allowFinal=allowFinal;this.now=now;this.fetchPublic=fetchPublic;this.session=randomUUID();
 }
 config(job){return {...this.state.scope,workspace_host:job.detail.workspace_host};}
 waitForPublicationRetry(job){
  const now=this.now(),retry=this.#retryAfter.get(job.id);
  requireThat(Number.isSafeInteger(now)&&now>0,'Host clock unavailable');
  if(retry&&now<retry)throw new ReadPending('Publication read temporarily unavailable; waiting before retry');
 }
 async verifyPublication(job,b){
  this.waitForPublicationRetry(job);
  const fetchPublic=async(...args)=>{
   const response=await this.fetchPublic(...args);
   const status=response.status,h=response.headers;
   if(status===429||status>=500&&status<=599||status===403&&(h.get('x-ratelimit-remaining')==='0'||h.has('retry-after'))){
    const current=this.now(),ra=h.get('retry-after'),reset=h.get('x-ratelimit-reset');
    const retryAt=ra===null?0:/^\d+$/.test(ra)?current+Number(ra)*1000:Date.parse(ra);
    const resetAt=reset!==null&&/^\d+$/.test(reset)?Number(reset)*1000:0;
    this.#retryAfter.set(job.id,Math.max(current+15000,Number.isFinite(retryAt)?retryAt:0,Number.isFinite(resetAt)?resetAt:0));
    await response.body?.cancel().catch(()=>{});
    throw new ReadPending(`Publication HTTP ${status}; waiting before retry`);
   }
   return response;
  };
  try{await verifyReportPublication(job.detail.report_commit,b,fetchPublic);}catch(error){
   // Include failures while streaming a response, not just response headers.
   const code=error?.cause?.code??error?.code;
   if(error?.name==='TimeoutError'||['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code)){
    this.#retryAfter.set(job.id,this.now()+15000);throw new ReadPending('Publication network read temporarily unavailable');
   }
   throw error;
  }
  this.#retryAfter.delete(job.id);
 }
 async once(id,name,input,write){
  const prior=this.state.op(id,name);
  if(prior){this.state.begin(id,name,input);return prior;}
  if(!this.state.begin(id,name,input))return this.state.op(id,name);
  try{const result=await write();this.state.settle(id,name,'acknowledged',result??null);}
  catch{this.state.settle(id,name,'unknown',null);}
  return this.state.op(id,name);
 }
 async command(job,action,fields={},slot=action){
  const input={action,report_request_id:job.id,bundle_sha256:job.detail.bundle_sha256,...fields};
  const op=await this.once(job.id,`native:${slot}:command`,input,async()=>({bytes:freshNativeCommand(action,{report_request_id:job.id,bundle_sha256:job.detail.bundle_sha256,...fields}).toString('base64'),owner:this.session}));
  requireThat(op.phase==='acknowledged'&&op.result?.bytes,'Command journal unavailable');
  return {bytes:Buffer.from(op.result.bytes,'base64'),owner:op.result.owner};
 }
 async control(job,action,fields={},slot=action){
  const command=await this.command(job,action,fields,slot),{bytes}=command,c=JSON.parse(bytes),config=this.config(job);
  if(action==='begin'&&command.owner!==this.session)throw new ReconciliationRequired('Restart cannot reuse a completion grant');
  await this.once(job.id,`native:${slot}:share`,{sha256:digest(bytes)},async()=>{
   const ticket=await this.transport.upload(bytes,'ai-notice-command.json');
   await this.transport.complete({...ticket,channel_id:config.channel_id,initial_comment:`!ai-notice submit ${c.command_id} ${digest(bytes)}`,title:'ai-notice-command.json'});
   return ticket;
  });
  // Read reconciliation is allowed even if control completion had an unknown result.
  const source=await this.transport.source(bytes,config);
  if(!source)throw new ReadPending('Control source unresolved; read only, never repost');
  const checked=await this.transport.receipt(bytes,source.source_ts,config);
  return {...checked,bytes,sourceTs:source.source_ts,owner:command.owner};
 }
 boundNotice(job,b,receipt,phase){
  const n=receipt.notice,m=createNoticeManifest(b.files.get(b.report.path+'report.json'),job.detail.report_commit);
  requireThat(n&&n.report_id===job.id&&n.edition===job.edition&&n.attempt_id===job.detail.attempt_id&&n.file_id===job.detail.file_id&&(!phase||n.phase===phase)&&n.detail.bundle_sha256===b.hash&&n.detail.report_merge_sha===job.detail.report_commit&&n.detail.destination===this.state.scope.notification_destination&&n.detail.poster_original_sha256===m.poster.sha256&&n.detail.text_sha256===digest(Buffer.from(m.text))&&n.detail.url===m.index_url&&n.detail.delivery_mode===job.detail.mode&&n.detail.not_before===job.detail.not_before,'Native reservation differs from the immutable plan');
  return m;
 }
 async step(id){
  const job=this.state.get(id);requireThat(['native_v1','native_bundle_v1'].includes(job?.detail.mode),'Not a native scheduled run');
  const bundled=job.detail.mode==='native_bundle_v1';
  if(job.phase==='sender_reported')return job;
  const b=await decodeBundle(job.bundle),config=this.config(job),fields={attempt_id:job.detail.attempt_id,file_id:job.detail.file_id};
  const poster=b.files.get(b.report.path+b.report.poster);
  if(job.phase==='native_prepared'){
   requireThat(Number.isSafeInteger(this.now())&&this.now()>0,'Host clock unavailable');
   if(this.now()<Date.parse(job.detail.not_before)-600000)throw new ReadPending('Pre-upload window starts ten minutes before delivery');
   await this.verifyPublication(job,b);
   const attachment=bundled?job.bundle:poster;
   const op=await this.once(id,'native:poster',{sha256:digest(attachment)},()=>this.transport.upload(attachment,bundled?'ai-brief-bundle.json':b.report.poster.split('/').at(-1)));
   if(op.phase!=='acknowledged')throw new ReconciliationRequired('Poster upload unknown; no replacement');
   this.state.move(id,job.phase,'native_reserve',{...job.detail,file_id:op.result.file_id,attempt_id:`native-${digest(id).slice(0,32)}`});
  }else if(job.phase==='native_reserve'){
   const r=await this.control(job,bundled?'prepare_bundle':'prepare',fields);this.boundNotice(job,b,r.receipt,'reserved');
   requireThat(r.receipt.send_authorized===false&&['prepared_without_send_grant','already_reserved'].includes(r.receipt.reason),'Prepare must not grant sending');
   this.state.move(id,job.phase,'native_begin',job.detail);
  }else if(job.phase==='native_begin'){
   // Default launch stops here, before consuming the remote one-time intent.
   requireThat(this.allowFinal,'Final delivery disabled; begin was not submitted');
   const prior=this.state.op(id,'native:begin:command');
   if(prior&&prior.result?.owner!==this.session){this.state.move(id,job.phase,'native_reconcile',job.detail);return this.state.get(id);}
   // Do not consume the durable one-time intent while waiting for the due time
   // or for public sources. A restarted host before begin is still safe.
   if(this.now()<Date.parse(job.detail.not_before))throw new ReadPending('Awaiting 08:00 Asia/Shanghai before begin');
   const at=this.now();await this.verifyPublication(job,b);
   if(this.now()<at||this.now()-at>60000)throw new ReadPending('Preflight expired before begin; refresh reads');
   const r=await this.control(job,'begin',fields);this.boundNotice(job,b,r.receipt,'completion_intent');
   requireThat(r.receipt.send_authorized&&r.receipt.reason==='new_completion_intent','No new completion permission');
   this.#cache.set(id,{at,r});
   this.state.move(id,job.phase,'final_ready',job.detail);
  }else if(job.phase==='final_ready'){
   requireThat(this.allowFinal,'Final delivery disabled');
   if(this.state.op(id,'native:begin:command')?.result?.owner!==this.session){this.state.move(id,job.phase,'native_reconcile',job.detail);return this.state.get(id);}
   let cached=this.#cache.get(id),now=this.now();
   requireThat(Number.isSafeInteger(now)&&now>0,'Host clock unavailable');
   if(!cached||now<cached.at||now-cached.at>60000){
    // Backoff also gates receipt reads; polling Slack cannot repair a throttled source.
    this.waitForPublicationRetry(job);
    const at=now,r=await this.control(job,'begin',fields);this.boundNotice(job,b,r.receipt,'completion_intent');
    await this.verifyPublication(job,b);
    cached={at,r};this.#cache.set(id,cached);
   }
   const args=()=>{
    const current=this.now();requireThat(Number.isSafeInteger(current)&&current>0,'Host clock unavailable');
    if(current<cached.at||current-cached.at>60000){this.#cache.delete(id);throw new ReadPending('Preflight expired before completion; refresh reads without a new begin');}
    return nativeCompletionArguments(cached.r.invocation,{bytes:cached.r.bytes,sourceTs:cached.r.sourceTs,config,reportJson:b.files.get(b.report.path+'report.json'),poster,bundleBytes:job.bundle,checkedAt:cached.at,now:current});
   };
   if(this.now()<Date.parse(job.detail.not_before))throw new ReadPending('Awaiting 08:00 Asia/Shanghai');
   // The transaction repeats the freshness/time check after acquiring the lock.
   const input=args();
   if(this.state.beginCompletion(job,input,args)){
    this.#cache.delete(id);
    try{await this.transport.complete(args());this.state.settle(id,'final_complete','acknowledged',null);}
    catch{this.state.settle(id,'final_complete','unknown',null);}
   }
  }else if(['final_pending','native_reconcile'].includes(job.phase)){
   const r=await this.control(job,'status');const manifest=this.boundNotice(job,b,r.receipt);
   requireThat(!r.receipt.send_authorized&&['completion_intent','send_unknown','sender_reported'].includes(r.receipt.notice.phase),'Status never grants a new attempt');
   const source=await this.transport.finalSource(manifest,config);
   if(!source)throw new ReadPending('Final message unresolved; do not resend');
   const generation=job.detail.check_generation??0;
   requireThat(Number.isSafeInteger(generation)&&generation>=0&&generation<100,'Checker refresh budget exhausted');
   const checked=await this.control(job,'check',{...fields,message_ts:source.source_ts},`check:${generation}`),v=checked.receipt.verification;
   this.boundNotice(job,b,checked.receipt);
   if(v?.slack_status==='not_verified'){
    this.state.move(id,job.phase,job.phase,{...job.detail,check_generation:generation+1});
    throw new ReadPending('Independent check unavailable; next tick requests a fresh check of the same file');
   }
   requireThat(!checked.receipt.send_authorized&&v?.slack_status==='verified'&&v.wecom_status==='not_checked'&&v.publication_status==='not_checked'&&v.receipt?.channel===config.notification_destination&&v.receipt.ts===source.source_ts&&v.receipt.file_id===fields.file_id&&v.receipt.transport_sha256===(bundled?b.hash:digest(poster))&&v.receipt.transport_bytes===(bundled?job.bundle.length:poster.length)&&(!bundled||(v.receipt.poster_sha256===digest(poster)&&v.receipt.poster_bytes===poster.length)),'Independent checker did not verify the original final image/message');
   const record=await this.control(job,bundled?'record_bundle':'record',{...fields,message_ts:source.source_ts,text_sha256:digest(Buffer.from(manifest.text)),transport_sha256:v.receipt.transport_sha256,transport_bytes:v.receipt.transport_bytes,...(bundled?{poster_sha256:v.receipt.poster_sha256,poster_bytes:v.receipt.poster_bytes}:{})});
   this.boundNotice(job,b,record.receipt,'sender_reported');requireThat(!record.receipt.send_authorized&&record.receipt.slack_status==='sender_reported','Sender record not acknowledged');
   this.state.move(id,job.phase,'sender_reported',{...job.detail,slack_status:'verified',wecom_status:'not_checked',receipt:v.receipt});
  }else throw new ReconciliationRequired('Unknown native host phase');
  return this.state.get(id);
 }
}
