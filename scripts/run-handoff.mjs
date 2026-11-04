import {validateScheduledConfig,advanceScheduledDelivery,advanceScheduledStatus} from "./scheduled-delivery-bridge.mjs";
// Single bounded tick, suitable for a separately approved 120-second service timer.
// No default config, environment token, daemon, scheduler or deployment is installed.
import {open,lstat,realpath} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {HandoffState,handoffScope} from "./handoff-state.mjs";
import {openProviderCooldowns,providerIO,PROVIDER_SCOPES} from './provider-cooldowns.mjs';
import {NoticeOutbox,notificationScope,acceptNoticeCommand,decodeNoticeCommand,advanceNotice,MAX_NOTICE_COMMAND,remoteReceiptCanWait} from "./notice-outbox.mjs";
import {SlackHandoff,publicGitHub,publicMergeCommit} from "./slack-handoff.mjs";
import {acceptMessage,acceptReportStatus,decodeBundle,requireThat,verifyReportPublication} from "./report-handoff.mjs";
import {advanceHandoff} from "./handoff-worker.mjs";
import {proposeWithApp,reconcileProposalWithApp} from "./propose-with-app.mjs";
import {validateCheckerConfig,runNoticeChecker} from "./notice-checker.mjs";
import {safeDiagnostic,recordHandoffFailure,attemptDetail} from "./handoff-recovery.mjs";
import {withHandoffLock} from "./handoff-lock.mjs";
export async function privateDirectory(dir){
 requireThat(path.isAbsolute(dir)&&await realpath(dir)===path.resolve(dir),"Private directory must be absolute and not symlinked");
 const s=await lstat(dir);requireThat(s.isDirectory()&&s.uid===process.getuid()&&(s.mode&0o077)===0,"Private directory must be owner-only");
}
export async function privateFile(filename,limit,read=true){
 await privateDirectory(path.dirname(filename));
 const f=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await f.stat();requireThat(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=limit,"Private file ownership/mode/size");return read?await f.readFile():undefined;}finally{await f.close();}
}
export function validateConfig(c){
 const keys=["team_id","channel_id","sender_user_id","bot_user_id","bot_id","producer_app_id","merger_app_id","slack_token_file","producer_key_file","state_dir","ready_for_review"];
 const appSender=c&&(Object.hasOwn(c,"sender_bot_id")||Object.hasOwn(c,"sender_app_id"));
 const userAppSender=c&&(Object.hasOwn(c,"sender_user_app_id")||Object.hasOwn(c,"sender_attribution_text"));
 if(appSender)keys.push("sender_bot_id","sender_app_id");
 if(userAppSender)keys.push("sender_user_app_id","sender_attribution_text");
 if(c&&(Object.hasOwn(c,"notification_destination")||Object.hasOwn(c,"notification_not_before"))){
  keys.push("notification_destination","notification_not_before");
  requireThat(typeof c.notification_destination==="string"&&/^D[A-Z0-9]+$/.test(c.notification_destination)&&typeof c.notification_not_before==="string"&&/^\d{10}\.\d{6}$/.test(c.notification_not_before),"Explicit final DM destination and fixed activation boundary required");
 }
 if(c&&Object.hasOwn(c,"notification_checker")){
  keys.push("notification_checker");validateCheckerConfig(c.notification_checker);
  requireThat(Object.hasOwn(c,"notification_destination")&&Object.hasOwn(c,"notification_not_before"),"Checker requires configured notices");
 }
 if(c&&Object.hasOwn(c,"scheduled_delivery")){keys.push("scheduled_delivery");validateScheduledConfig(c.scheduled_delivery);}
 requireThat(c&&Object.keys(c).sort().join()===keys.sort().join(),"Unexpected publisher config");
 for(const [key,prefix]of [["team_id","T"],["channel_id","[CG]"],["sender_user_id","U"],["bot_user_id","U"],["bot_id","B"]])requireThat(new RegExp("^"+prefix+"[A-Z0-9]+$").test(c[key]),"Publisher identity config");
 requireThat(c.sender_user_id!==c.bot_user_id&&typeof c.ready_for_review==="boolean"&&Number.isSafeInteger(c.producer_app_id)&&c.producer_app_id>0&&Number.isSafeInteger(c.merger_app_id)&&c.merger_app_id>0&&c.producer_app_id!==c.merger_app_id,"Independent publisher identities required");
 if(appSender)requireThat(typeof c.sender_bot_id==="string"&&/^B[A-Z0-9]+$/.test(c.sender_bot_id)&&typeof c.sender_app_id==="string"&&/^A[A-Z0-9]+$/.test(c.sender_app_id)&&c.sender_bot_id!==c.bot_id,"Explicit independent Slack App sender required");
 if(userAppSender)requireThat(!appSender&&typeof c.sender_user_app_id==="string"&&/^A[A-Z0-9]+$/.test(c.sender_user_app_id)&&typeof c.sender_attribution_text==="string"&&c.sender_attribution_text.length<=200&&/^\*[^*\r\n<>]+\* <@U[A-Z0-9]+>$/.test(c.sender_attribution_text),"Explicit user-authorized App and exact attribution required");
 for(const k of ["slack_token_file","producer_key_file","state_dir"])requireThat(typeof c[k]==="string"&&path.isAbsolute(c[k]),"Absolute private paths required");
 return c;
}
// Dependencies here are supplied only by trusted runtime code, never the payload.
export async function handoffTick(state,config,slack,io){
  const now=io.now??Date.now,errors=[];
  const capture=(stage,error,extra={})=>{if(errors.length<16)errors.push({...safeDiagnostic(error,stage),...extra});};
  const notices=config.notification_destination?new NoticeOutbox(state,notificationScope(config)):null;
  let messages=[];const statusEvents=[];
  try{messages=await slack.history();}catch(error){capture('intake_history',error);}
  for(const message of messages){
   try{
   let status=null;
   if(config.scheduled_delivery&&message?.text?.startsWith("!ai-report status ")){
    try{status=acceptReportStatus(message,config);}catch{continue;}
   }
   if(status){
    // Admit every report before the separately bounded advisory status lane.
    statusEvents.push(status);
    continue;
   }
   const command=notices?acceptNoticeCommand(message,config):null;
   if(command){
    const prior=notices.command(command.request_id);
    if(prior){requireThat(prior.hash===command.hash&&prior.source_ts===command.source_ts,"Duplicate notice conflict");continue;}
    notices.admit(command,await slack.download(command,{name:"ai-notice-command.json",limit:MAX_NOTICE_COMMAND}));continue;
   }
   // Ignore other protocols; invalid matching commands fail closed without writes.
   const event=acceptMessage(message,config);if(!event)continue;
   const prior=state.get(event.request_id);
   if(prior){requireThat(prior.hash===event.hash&&prior.source_ts===event.source_ts,"Duplicate request conflict");continue;}
   const bytes=await slack.download(event),bundle=await decodeBundle(bytes);
   requireThat(bundle.data.request_id===event.request_id&&bundle.hash===event.hash,"Message and bundle mismatch");state.admit(event,bytes);
   }catch(error){capture('intake_message',error,{source_ts:/^\d{10}\.\d{6}$/.test(message?.ts??'')?message.ts:null});}
  }
  // Bound each lane to one operation. A later PR must not starve completed-report
  // notices; a premature claim waits while its publication continues advancing.
  // T4 admission/status progresses independently of a lost Slack publication
  // receipt. No original receipt is resent and no native completion is recreated.
  let scheduled=null,id,commandId,noticeResult,waitingRemoteReceipt;
  try{
  for(const candidate of notices?.pending()??[]){
   const operation=notices.command(candidate);
   // Reconcile any uncertain write before another reply, even if a previously
   // waiting claim earlier in the queue has since become eligible.
   if(["response_sending","response_unknown"].includes(operation.phase)){
    // A lost remote-ledger response stays read-only. Let new authenticated
    // snapshots/reconciliation commands progress without repeating that write.
    if(remoteReceiptCanWait(notices,operation)){waitingRemoteReceipt??=candidate;continue;}
    commandId=candidate;break;
   }
   if(commandId)continue;
   const command=operation.phase==="received"?decodeNoticeCommand(operation.bytes):null;
   const job=["claim","prepare","prepare_bundle","begin","asset"].includes(command?.action)?state.metadata(command.report_request_id):null;
   if(job&&job.phase!=="receipt_sent")continue;
   commandId=candidate;
  }
  commandId??=waitingRemoteReceipt;
  if(commandId){
   await advanceNotice(notices,commandId,{verify:io.verify,checkNotice:io.checkNotice,verifyAsset:io.verifyAsset,receiptReady:()=>slack.assertReady?.('chat.postMessage'),receipt:(thread,text)=>slack.controlReceipt(thread,text),findReceipt:(thread,text)=>slack.findControlReceipt(thread,text)});
   noticeResult={command_id:commandId,phase:notices.command(commandId).phase};
  }
  }catch(error){capture('notice',error);}
  // A blocked job is isolated. Persistent last-attempt ordering prevents an old
  // request from starving later dates, without erasing any uncertain intent.
  const reportStarted=now();
  const candidates=state.pendingMetadata().filter(job=>job.phase!=='proposal_failed'&&(job.detail.recovery?.next_at??0)<=now()).sort((a,b)=>(a.detail.recovery?.last_attempt_at??0)-(b.detail.recovery?.last_attempt_at??0)||a.source_ts.localeCompare(b.source_ts));
  for(const candidate of candidates.slice(0,8)){
   if(now()-reportStarted>90000)break;
   id??=candidate.id;
   state.move(candidate.id,candidate.phase,candidate.phase,attemptDetail(candidate.detail,now()));
   for(let step=0;step<5;step++){
    const before=state.metadata(candidate.id);if(before.phase==='receipt_sent')break;
    const scopes={received:['github.app','github.producer'],proposing:['github.public'],proposal_unknown:['github.public'],pr_open:['github.public'],merged:['github.public'],verified:['github.public','slack.chat.postMessage'],sending:['slack.conversations.replies'],receipt_unknown:['slack.conversations.replies']}[before.phase]??[];
    const sharedDeadline=Math.max(0,...scopes.map(scope=>Math.max(state.providerDeadline(scope),io.providerDeadline?.(scope)??0)));
    if(sharedDeadline>now()){
     // A new or different report cannot bypass the same app/workspace quota.
     // Defer before creating a write intent; other methods may still progress.
     state.move(candidate.id,before.phase,before.phase,{...before.detail,recovery:{...before.detail.recovery,next_at:Math.max(before.detail.recovery?.next_at??0,sharedDeadline)}});break;
    }
    try{await advanceHandoff(state,candidate.id,io);}catch(error){
     // Proposal/receipt handlers already preserve write outcome before throwing.
     const after=state.metadata(candidate.id);
     if((after.detail.recovery?.attempts??0)===(before.detail.recovery?.attempts??0))recordHandoffFailure(state,candidate.id,error,now());
     capture('report',error,{request_id:candidate.id,phase:after.phase});break;
    }
    const after=state.metadata(candidate.id);
    if(after.phase===before.phase||after.phase==='receipt_sent'||now()-reportStarted>90000)break;
   }
  }
  // A report reaching verified is admitted in this same tick. No extra fixed
  // two-minute wait is inserted between a completed phase and its successor.
  if(config.scheduled_delivery){
   try{scheduled=await advanceScheduledDelivery(state,config,io.scheduleQuery);}catch(error){capture('scheduled_delivery',error);}
  }
  if(config.scheduled_delivery){
   try{await advanceScheduledStatus(state,config,statusEvents,slack,io.scheduleQuery);}catch(error){capture('scheduled_status',error);}
  }
  const pending=state.pendingMetadata();
  // A quiet/backoff tick must not erase a durable failure from service health.
  // Keep the report degraded until the original request finishes or is reconciled.
  const blocked_reports=pending.filter(job=>['proposal_failed','proposing','proposal_unknown','sending','receipt_unknown'].includes(job.phase)||job.detail.recovery?.last_error).slice(0,16).map(job=>({request_id:job.id,phase:job.phase,...(job.detail.recovery?.last_error?{error:safeDiagnostic({diagnostic:job.detail.recovery.last_error},job.phase)}:{})}));
  const due=pending.filter(job=>job.phase!=='proposal_failed').map(job=>job.detail.recovery?.next_at).filter(t=>Number.isFinite(t)&&t>0);
  const next_delay_ms=due.length?Math.max(1000,Math.min(120000,Math.min(...due)-now())):120000;
  return {...(id?{request_id:id,phase:state.metadata(id).phase}:noticeResult??{phase:'idle'}),...(noticeResult?{notice:noticeResult}:{}),...(scheduled?{scheduled}:{}),errors,blocked_reports,healthy:errors.length===0&&blocked_reports.length===0,next_delay_ms};
}
export async function runHandoff(configFile){
 requireThat(process.platform==="linux","Live publisher requires the reviewed Linux service layout");
 const config=validateConfig(JSON.parse((await privateFile(configFile,16384)).toString("utf8")));
 const token=(await privateFile(config.slack_token_file,8192)).toString("utf8").trim();requireThat(/^xoxb-[a-zA-Z0-9-]+$/.test(token),"Dedicated Slack bot token required");
 await privateDirectory(config.state_dir);
 return withHandoffLock(config.state_dir,async()=>{
 const cooldowns=await openProviderCooldowns(config,{privateFile,privateDirectory,createDirectory:true});
 try{
 const slack=new SlackHandoff(config,token,fetch,{cooldowns});await slack.preflight();
 const filename=path.join(config.state_dir,"handoff.sqlite");
 try{const f=await open(filename,"wx",0o600);await f.close();}catch(e){if(e.code!=="EEXIST")throw e;}
 await privateFile(filename,10*1024*1024*1024,false);
 const state=new HandoffState(filename,handoffScope(config));
 try{
 for(const scope of PROVIDER_SCOPES){const deadline=state.providerDeadline(scope);if(deadline)cooldowns.defer(scope,deadline);}
 const io={
  propose:async(files,base)=>proposeWithApp(files,base,{appId:config.producer_app_id,mergerAppId:config.merger_app_id,privateKey:await privateFile(config.producer_key_file,32768)},{ready:config.ready_for_review}),
  reconcileProposal:(files,base)=>reconcileProposalWithApp(files,base,{appId:config.producer_app_id,mergerAppId:config.merger_app_id}),
  readPR:n=>publicGitHub("/pulls/"+n),readMergeCommit:publicMergeCommit,readCommit:sha=>publicGitHub("/git/commits/"+sha),
  verify:verifyReportPublication,verifyAsset:request=>slack.controlAsset(request),receipt:(thread,proof)=>slack.receipt(thread,proof),findReceipt:(thread,proof)=>slack.findControlReceipt(thread,'!ai-report receipt '+JSON.stringify(proof))
 };
 if(config.notification_checker)io.checkNotice=request=>runNoticeChecker(config.notification_checker,request);
 return await handoffTick(state,config,slack,providerIO(io,cooldowns));
 }finally{state.close();}
 }finally{cooldowns.close();}
 });
}
export async function handoffMain(args,{run=runHandoff,log=console.log,error=console.error}={}){
 try{
  const [config,flag,...extra]=args;requireThat(config&&flag==="--live"&&!extra.length,"Usage: node scripts/run-handoff.mjs ABSOLUTE_CONFIG --live (requires separate deployment authorization)");
  const result=await run(config);log(JSON.stringify(result));return result.healthy===true?0:1;
 }catch{error("Handoff stopped. Inspect durable phase and reconcile before retrying any mutation; no credentials or remote error bodies logged.");return 1;}
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 process.exitCode=await handoffMain(process.argv.slice(2));
}
