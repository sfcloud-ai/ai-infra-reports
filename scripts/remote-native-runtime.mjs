// Ephemeral cloud execution, with authoritative operation state on Publisher.
// No credentials, local journal reconstruction, replacement file or grant reuse.
import {digest} from './archive.mjs';
import {decodeBundle,requireThat,verifyReportPublication} from './report-handoff.mjs';
import {ReadPending} from './cloud-sender.mjs';
import {freshNativeCommand,nativeCompletionArguments} from './native-notice.mjs';
import {NativeRemoteJournal} from './native-remote-journal.mjs';
import {JOURNAL_CATALOG} from './remote-native-journal.mjs';
import {createNoticeManifest} from './notice-manifest.mjs';
export const REMOTE_READ_TOOLS=Object.freeze({thread:'mcp__codex_apps__slack_slack_read_thread',file:'mcp__codex_apps__slack_slack_read_file'});
export const temporaryRead=error=>error instanceof ReadPending||error?.name==='TimeoutError'||['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(error?.cause?.code??error?.code);
export class SliceEnded extends Error{}
export class RemoteControl{
 constructor(config,transport,{now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),deadline}={}){
  requireThat(Number.isSafeInteger(deadline)&&deadline>now(),'Bounded execution deadline required');
  this.config=Object.freeze({...config});this.transport=transport;this.now=now;this.sleep=sleep;this.deadline=deadline;
 }
 async request(bytes){
  if(this.now()+15000>=this.deadline)throw new SliceEnded('No time for another control operation');
  const c=JSON.parse(bytes),readDeadline=Math.min(this.deadline,this.now()+180000);
  // The upload/share is attempted once. Even a thrown result goes only to reads.
  try{
   const ticket=await this.transport.upload(bytes,'ai-notice-command.json');
   await this.transport.complete({...ticket,channel_id:this.config.channel_id,initial_comment:`!ai-notice submit ${c.command_id} ${digest(bytes)}`,title:'ai-notice-command.json'});
  }catch{}
  while(this.now()+5000<readDeadline){
   try{
    const source=await this.transport.source(bytes,this.config);
    if(source){const r=await this.transport.receipt(bytes,source.source_ts,this.config);return {...r,bytes,sourceTs:source.source_ts};}
   }catch(error){if(!temporaryRead(error))throw error;}
   await this.sleep(5000);
  }
  throw new SliceEnded('Control response unresolved; never repost this command');
 }
}
export async function discoverRemoteRuns(control){
 const r=await control.request(freshNativeCommand('journal_catalog',JOURNAL_CATALOG)),v=r.receipt;
 requireThat(v.reason==='journal_catalog'&&v.send_authorized===false&&v.new_intent===false&&v.journal===null&&Array.isArray(v.catalog)&&v.catalog.length<=4,'Invalid remote catalog');
 for(const e of v.catalog)requireThat(Object.keys(e).sort().join()==='attempt_id,bundle_sha256,file_id,next_attempt_at,report_commit,report_request_id,source_ts'&&/^[a-f0-9]{64}$/.test(e.bundle_sha256)&&/^[a-f0-9]{40}$/.test(e.report_commit)&&/^\d{10}\.\d{6}$/.test(e.source_ts)&&Number.isSafeInteger(e.next_attempt_at)&&e.next_attempt_at>=0,'Invalid catalog entry');
 return v.catalog;
}
export async function readRemoteBundle(callTool,config,entry){
 const thread=await callTool(REMOTE_READ_TOOLS.thread,{channel_id:config.channel_id,message_ts:entry.source_ts,limit:2,response_format:'detailed'});
 requireThat(thread&&!thread.isError&&thread.content?.length===1&&thread.content[0].type==='text','Original report thread unavailable');
 const body=JSON.parse(thread.content[0].text),parent=body.messages?.split('\n\n=== THREAD REPLIES')[0];
 requireThat(typeof parent==='string'&&parent.length<16384,'Original report parent unavailable');
 const lines=parent.split('\n'),file=lines.filter(l=>l.startsWith('Files: ')),expected=`!ai-report publish ${entry.report_request_id} ${entry.bundle_sha256}`;
 const text=lines[4]?.replace(/<@(U[A-Z0-9]+)\|[^>\r\n]+>/g,'<@$1>');
 requireThat(lines[0]==='=== THREAD PARENT MESSAGE ==='&&lines[1].endsWith(`(${config.sender_user_id})`)&&lines[3]===`Message TS: ${entry.source_ts}`&&(text===expected||config.sender_attribution_text&&text===expected+' '+config.sender_attribution_text)&&file.length===1,'Original report source binding differs');
 const match=/^Files: ai-brief-bundle.json \(ID: (F[A-Z0-9]+), [^\n()]+\)$/.exec(file[0]);
 requireThat(match,'Original report must have one bundle attachment');
 const result=await callTool(REMOTE_READ_TOOLS.file,{file_id:match[1]}),data=result?.structuredContent;
 requireThat(!result?.isError&&data?.file_id===match[1]&&typeof data.text_content==='string'&&Buffer.byteLength(data.text_content)<=8*1024*1024,'Original bundle read unavailable or too large');
 const bytes=Buffer.from(data.text_content,'utf8');
 requireThat(digest(bytes)===entry.bundle_sha256,'Original bundle hash differs');
 const bundle=await decodeBundle(bytes);requireThat(bundle.data.request_id===entry.report_request_id,'Original bundle request differs');
 return bytes;
}
export class RemoteNativeRuntime{
 constructor(control,binding,bundleBytes,{allowFinal=false,fetchPublic=fetch}={}){
  this.control=control;this.config=control.config;this.transport=control.transport;this.now=control.now;
  this.fixed=Object.freeze(Object.fromEntries(['report_request_id','bundle_sha256','attempt_id','file_id'].map(k=>[k,binding[k]])));
  this.client=new NativeRemoteJournal(this.config,this.fixed);this.bundleBytes=Buffer.from(bundleBytes);this.allowFinal=allowFinal;this.fetchPublic=fetchPublic;this.journal=null;this.retryAt=0;
 }
 async journalCommand(action,fields={}){
  const r=await this.control.request(this.client.command(action,fields));
  const checked=this.client.read(r.invocation,{bytes:r.bytes,sourceTs:r.sourceTs});
  requireThat(checked.journal,'Remote journal absent; do not recreate an old run');
  this.journal=checked.journal;return r;
 }
 async settle(operation,evidence){
  while(true){
   const r=await this.journalCommand('journal_settle',{expected_revision:this.journal.revision,operation,outcome:'acknowledged',evidence_command_id:evidence});
   if(r.receipt.reason!=='journal_revision_conflict'){
    requireThat(this.journal.operations.find(o=>o.operation===operation)?.phase==='acknowledged','Operation settlement unresolved');return r;
   }
  }
 }
 async defer(reason='reconcile_wait',due=this.now()+15000){
  const r=await this.journalCommand('journal_defer',{expected_revision:this.journal.revision,next_attempt_at:Math.max(due,this.now()+15000),reason});
  return {type:'deferred',run_id:this.fixed.report_request_id,next_attempt_at:r.receipt.journal.next_attempt_at,phase:r.receipt.journal.phase,slack_status:'not_checked',wecom_status:'not_checked'};
 }
 async verify(bundle){
  const fetchPublic=async(...args)=>{
   const response=await this.fetchPublic(...args),h=response.headers,s=response.status;
   if(s===429||s>=500&&s<=599||s===403&&(h.get('x-ratelimit-remaining')==='0'||h.has('retry-after'))){
    const now=this.now(),ra=h.get('retry-after'),reset=h.get('x-ratelimit-reset');
    const at=ra===null?0:/^\d+$/.test(ra)?now+Number(ra)*1000:Date.parse(ra),resetAt=/^\d+$/.test(reset??'')?Number(reset)*1000:0;
    this.retryAt=Math.max(now+15000,Number.isSafeInteger(at)?at:0,Number.isSafeInteger(resetAt)?resetAt:0);
    await response.body?.cancel().catch(()=>{});throw new ReadPending('Publication temporarily unavailable');
   }
   return response;
  };
  return verifyReportPublication(this.journal.binding.report_commit,bundle,fetchPublic);
 }
 async intent(operation,input){
  while(true){
   const r=await this.journalCommand('journal_intent',{expected_revision:this.journal.revision,operation,input_sha256:digest(input)});
   if(r.receipt.reason!=='journal_revision_conflict'||this.journal.operations.some(o=>o.operation===operation))return r;
  }
 }
 async verifyOwned(bundle){
  while(true){
   const at=this.now();
   try{await this.verify(bundle);if(this.now()>=at&&this.now()-at<=60000)return at;throw new ReadPending('Preflight expired');}
   catch(error){
    if(!temporaryRead(error))throw error;
    const due=Math.max(this.retryAt,this.now()+15000);
    if(due+30000>=this.control.deadline)throw error;
    while(this.now()<due)await this.control.sleep(Math.min(30000,due-this.now()));
   }
  }
 }
 async once(r,write){return this.client.executeOnce(r.invocation,{bytes:r.bytes,sourceTs:r.sourceTs},write);}
 async run({open=false}={}){
  const b=await decodeBundle(this.bundleBytes);
  requireThat(b.hash===this.fixed.bundle_sha256&&b.data.request_id===this.fixed.report_request_id,'Runtime bundle identity changed');
  await this.journalCommand(open?'journal_open':'journal_read',open?{expected_revision:0}:{});
  const j=this.journal.binding,manifest=createNoticeManifest(b.files.get(b.report.path+'report.json'),j.report_commit),poster=b.files.get(b.report.path+b.report.poster);
  requireThat(j.edition===`${b.report.date}/r${b.report.revision}`&&j.not_before===b.report.date+'T00:00:00.000Z'&&j.mode==='native_bundle_v1'&&j.url===manifest.index_url&&j.text_sha256===digest(Buffer.from(manifest.text))&&j.poster_sha256===digest(poster),'Remote journal differs from original publication');
  if(this.journal.phase==='complete')return {type:'complete',run_id:this.fixed.report_request_id,slack_status:'verified',wecom_status:'not_checked'};
  if(this.journal.next_attempt_at>this.now())return {type:'deferred',run_id:this.fixed.report_request_id,next_attempt_at:this.journal.next_attempt_at,slack_status:'not_checked',wecom_status:'not_checked'};
  try{
   if(!this.journal.operations.length){
    requireThat(this.allowFinal,'Final delivery disabled');
    if(this.now()<Date.parse(j.not_before))return this.defer('read_retry',Date.parse(j.not_before));
    if(this.now()+180000>=this.control.deadline)return this.defer('execution_slice_complete');
    await this.verify(b);
    const bytes=freshNativeCommand('begin',this.fixed),intent=await this.intent('begin',bytes);
    if(!intent.receipt.new_intent)return {type:'observed',run_id:this.fixed.report_request_id,reason:'existing_operation_owner',slack_status:'not_checked',wecom_status:'not_checked'};
    const begin=await this.once(intent,()=>this.control.request(bytes));
    // Validate this live begin receipt before acknowledging or allocating final.
    const argumentsAt=at=>nativeCompletionArguments(begin.invocation,{bytes:begin.bytes,sourceTs:begin.sourceTs,config:this.config,reportJson:b.files.get(b.report.path+'report.json'),poster,bundleBytes:this.bundleBytes,checkedAt:at,now:this.now()});
    const input=argumentsAt(this.now());
    await this.settle('begin',JSON.parse(bytes).command_id);
    if(this.now()+120000>=this.control.deadline)return this.defer('execution_slice_complete');
    const finalIntent=await this.intent('final_complete',Buffer.from(JSON.stringify(input)));
    if(!finalIntent.receipt.new_intent)return this.defer();
    const checkedAt=await this.verifyOwned(b);
    try{await this.once(finalIntent,()=>this.transport.complete(argumentsAt(checkedAt)));}catch(error){
     // The immutable intent already prevents replay, including a lost response.
     if(error instanceof SliceEnded)throw error;
    }
   }
   // Any restart lands here. Stored evidence may acknowledge begin/record,
   // but cannot recreate a live begin owner or call final completion.
   for(const operation of ['begin','record']){
    const op=this.journal.operations.find(o=>o.operation===operation),e=this.journal.evidence?.[operation];
    if(op&&op.phase!=='acknowledged'&&e)await this.settle(operation,e);
   }
   if(this.journal.phase==='complete')return {type:'complete',run_id:this.fixed.report_request_id,slack_status:'verified',wecom_status:'not_checked'};
   const final=this.journal.operations.find(o=>o.operation==='final_complete');
   if(!final)return this.defer();
   const source=await this.transport.finalSource(manifest,this.config);
   if(!source)return this.defer();
   const check=await this.control.request(freshNativeCommand('check',{...this.fixed,message_ts:source.source_ts})),v=check.receipt.verification;
   if(v?.slack_status==='not_verified')return this.defer();
   requireThat(check.receipt.send_authorized===false&&v?.slack_status==='verified'&&v.wecom_status==='not_checked'&&v.receipt?.channel===this.config.notification_destination&&v.receipt.ts===source.source_ts&&v.receipt.file_id===this.fixed.file_id&&v.receipt.transport_sha256===b.hash&&v.receipt.transport_bytes===this.bundleBytes.length&&v.receipt.poster_sha256===digest(poster)&&v.receipt.poster_bytes===poster.length,'Original final delivery not independently verified');
   if(final.phase!=='acknowledged')await this.settle('final_complete',JSON.parse(check.bytes).command_id);
   if(this.journal.operations.some(o=>o.phase!=='acknowledged'))return this.defer();
   const bytes=freshNativeCommand('record_bundle',{...this.fixed,message_ts:source.source_ts,text_sha256:digest(Buffer.from(manifest.text)),transport_sha256:b.hash,transport_bytes:this.bundleBytes.length,poster_sha256:digest(poster),poster_bytes:poster.length});
   const intent=await this.intent('record',bytes);
   if(!intent.receipt.new_intent)return this.defer();
   await this.once(intent,()=>this.control.request(bytes));
   await this.settle('record',JSON.parse(bytes).command_id);
   requireThat(this.journal.phase==='complete','Remote record unresolved');
   return {type:'complete',run_id:this.fixed.report_request_id,slack_status:'verified',wecom_status:'not_checked'};
  }catch(error){
   if(error instanceof SliceEnded&&this.now()+30000<this.control.deadline){
    await this.journalCommand('journal_read');return this.defer('read_retry');
   }
   if(temporaryRead(error))return this.defer(this.retryAt?'publication_retry':'read_retry',Math.max(this.retryAt,this.now()+15000));
   throw error;
  }
 }
}
