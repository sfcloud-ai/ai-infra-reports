// Disposable native-tool client. Authority and original bytes live on the host.
import {randomUUID} from 'node:crypto';
import {digest} from './archive.mjs';
import {decodeResearchControl,decodeResearchPlan} from './research-control.mjs';
import {assertResearchOutputFiles} from './repository-research-inputs.mjs';
import {requireThat} from './report-handoff.mjs';
export const CONTROL_THREAD_TOOL='mcp__codex_apps__slack_slack_read_thread';
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const TS=/^\d{10}\.\d{6}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function researchClientScope(s){
 requireThat(s&&Object.keys(s).sort().join()==='channel_id,publisher_bot_id,publisher_user_id,sender_attribution_text,sender_user_id,team_id','Exact native control identity required');
 for(const [k,re] of Object.entries({channel_id:/^C[A-Z0-9]+$/,team_id:/^T[A-Z0-9]+$/,sender_user_id:/^U[A-Z0-9]+$/,publisher_user_id:/^U[A-Z0-9]+$/,publisher_bot_id:/^B[A-Z0-9]+$/}))requireThat(typeof s[k]==='string'&&re.test(s[k]),'Pinned native control identity required');
 requireThat(typeof s.sender_attribution_text==='string'&&s.sender_attribution_text.length>0&&s.sender_attribution_text.length<1000&&!/[\r\n]/.test(s.sender_attribution_text),'Pinned native attribution required');return s;
}
export function researchCommandText(bytes){decodeResearchControl(bytes);return '!ai-research control v2 '+bytes.toString('base64');}
export function verifyResearchControlReceipt(scope,bytes,source,invocation,now=Date.now()){
 const s=researchClientScope(scope),c=decodeResearchControl(bytes),text=researchCommandText(bytes);
 requireThat(TS.test(source)&&Number(source)*1000<=now+30000,'Original command source required');
 const args={channel_id:s.channel_id,message_ts:source,limit:100,response_format:'detailed'};
 requireThat(invocation?.tool===CONTROL_THREAD_TOOL&&invocation.arguments&&Object.keys(invocation.arguments).sort().join()===Object.keys(args).sort().join()&&Object.entries(args).every(([k,v])=>invocation.arguments[k]===v),'Original native thread invocation required');
 const result=invocation.result;requireThat(result&&!result.isError&&result.content?.length===1&&result.content[0].type==='text'&&Buffer.byteLength(result.content[0].text)<=128*1024,'Complete native receipt required');
 const body=JSON.parse(result.content[0].text);requireThat(body&&Object.keys(body).sort().join()==='messages,pagination_info'&&['There are no more messages in this thread.\n','There are no more messages in this thread.\\n'].includes(body.pagination_info),'Complete native receipt required');
 const footers=[...new Set([s.sender_attribution_text,s.sender_attribution_text.replace(/<@(U[A-Z0-9]+)>/g,'<@$1|ChatGPT>')])];
 const pattern='^=== THREAD PARENT MESSAGE ===\\nFrom: [^\\n<>]+ <[^\\n<>]+> \\('+escape(s.sender_user_id)+'\\)\\nTime: [^\\n]+\\nMessage TS: '+escape(source)+'\\n'+escape(text)+'\\n(?:'+footers.map(escape).join('|')+')\\n\\n=== THREAD REPLIES \\(1 total\\) ===\\n\\n--- Reply 1 of 1 ---\\nFrom: [^\\n<>]+ <botuser-'+escape(s.team_id)+'-'+escape(s.publisher_bot_id)+'@slack-bots\\.com> \\('+escape(s.publisher_user_id)+'\\)\\nTime: [^\\n]+\\nMessage TS: (\\d{10}\\.\\d{6})\\n!ai-research control-receipt ([^\\n]+)\\n$';
 const match=new RegExp(pattern).exec(body.messages);requireThat(match&&match[1]>source&&Number(match[1])*1000<=now+30000,'Original native Publisher receipt required');
 const r=JSON.parse(match[2]);requireThat(r.source_ts===source&&r.command_id===c.command_id&&r.command_sha256===digest(bytes)&&r.request_id===c.request_id,'Original control receipt binding differs');
 if(r.dispatch_granted)requireThat(r.run?.owner_id===c.owner_id&&r.run.epoch===c.epoch&&r.run.lease_until>now&&!r.replayed&&!r.grant_expired&&now-Number(match[1])*1000<60000,'Fresh original dispatch grant required');
 return r;
}
export function controlCommand(request_id,action,args,owner_id=null,run=null){
 const c={schema_version:'research_control_v2',command_id:randomUUID(),request_id,action,owner_id,epoch:run?.epoch??0,expected_revision:run?.revision??0,args};
 const bytes=Buffer.from(JSON.stringify(c));decodeResearchControl(bytes);return bytes;
}
export function nativeResearchAuthority({request_id,owner_id,permit_id=null,archive_sha256},control,now=Date.now){
 requireThat(UUID.test(owner_id)&&(permit_id===null||UUID.test(permit_id))&&/^[a-f0-9]{64}$/.test(archive_sha256),'Original research upload binding required');
 let currentOperation=null;
 const current=async()=>{
  const observed=await control(controlCommand(request_id,'upload_status',{archive_sha256,permit_id}));
  requireThat(observed.status==='observed'&&observed.run?.owner_id===owner_id&&observed.run.lease_until>now(),'Read and claim the original host run first');return observed;
 };
 return {permit_id,
  async validateArchive(archive){
   const observed=await control(controlCommand(request_id,'status',{offset:0}));
   requireThat(observed.status==='observed'&&observed.run?.owner_id===owner_id&&observed.run.lease_until>now(),'Read and claim the original host run first');
   const plan=decodeResearchPlan(observed.plan_base64,request_id);
   requireThat(digest(plan.bytes)===observed.run.plan_hash&&archive.value.request_id===request_id&&archive.hash===archive_sha256,'Original checkpoint plan binding differs');
   assertResearchOutputFiles(plan.value,archive.files);
  },
  async recover(bytes){
   const observed=await current(),ops=observed.operations,hash=digest(bytes);
   requireThat(ops.every(op=>op.input.sha256===hash&&op.input.bytes===bytes.length),'Original upload bytes differ');
   const get=step=>ops.find(op=>op.input.step===step),ticket=get('ticket'),post=get('post'),complete=get('complete');
   if(!ticket||ticket.phase==='intent'&&!post)return null;
   requireThat(ticket.phase==='acknowledged'&&post?.phase==='acknowledged'&&ticket.native_result.file_id===post.native_result.file_id,'Original ticket or POST requires reconciliation');
   if(complete?.phase==='acknowledged')return {file_id:post.native_result.file_id,complete:true,source_ts:complete.native_result.source_ts};
   requireThat(!complete||complete.phase==='intent','Original completion requires reconciliation');return {file_id:post.native_result.file_id,complete:false};
  },
  async before(step,file_id,bytes,source_ts=null){
   const observed=await current(),run=observed.run,hash=digest(bytes),input={archive_sha256,permit_id,step,file_id,source_ts,bytes:bytes.length,sha256:hash};
   if(permit_id)requireThat(run.permit?.permit_id===permit_id&&run.permit.bundle_sha256===hash&&run.permit.archive_sha256===archive_sha256,'Original publication permit required');
   else requireThat(hash===archive_sha256,'Original checkpoint bytes required');
   const op={operation_id:randomUUID(),kind:'native',key:(permit_id?'permit:'+permit_id:'archive:'+archive_sha256)+':'+step,input_sha256:digest(Buffer.from(JSON.stringify(input))),input,max_seconds:0};
   const original=observed.operations.find(old=>old.operation_key===op.key);
   if(original){requireThat(original.phase==='intent'&&original.input_hash===op.input_sha256,'Original upload intent requires reconciliation');op.operation_id=original.operation_id;}
   const result=await control(controlCommand(request_id,original?'resume':'reserve',original?{operation_id:op.operation_id}:{operations:[op]},owner_id,run));
   requireThat(result.dispatch_granted===true&&result.operations?.length===1&&result.operations[0].operation_id===op.operation_id&&result.operations[0].input_sha256===op.input_sha256,'Original host upload grant required');currentOperation=op;return op.operation_id;
  },
  async after(step,file_id,bytes){
   requireThat(currentOperation?.input.step===step,'Original upload step required');const {run}=await current();
   const result=await control(controlCommand(request_id,'settle',{operation_id:currentOperation.operation_id,outcome:'acknowledged',elapsed_seconds:null,archive_sha256:null,file_sha256:null,native_result:{file_id,source_ts:null,sha256:digest(bytes),bytes:bytes.length}},owner_id,run));
   requireThat(result.status==='committed','Host upload result remains unresolved');currentOperation=null;
  }
 };
}
