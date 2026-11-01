// Cloud-side data encoder and grant verifier; no credential or send implementation.
import {pathToFileURL} from "node:url";
import {digest} from "./archive.mjs";
import {decodeNoticeCommand,MAX_NOTICE_COMMAND} from "./notice-outbox.mjs";
import {requireThat} from "./report-handoff.mjs";
export function encodeNoticeCommand(command){
 const bytes=Buffer.from(JSON.stringify(command)+"\n");decodeNoticeCommand(bytes);return bytes;
}
export function verifyNoticeGrant(message,{bytes,sourceTs,readContext,config}){
 const c=decodeNoticeCommand(bytes),prefix="!ai-notice receipt ";
 requireThat(c.action==="claim"&&readContext?.team_id===config.team_id&&readContext.channel_id===config.channel_id,"Authenticated control read context required");
 requireThat(message?.type==="message"&&(!message.subtype||message.subtype==="bot_message")&&message.user===config.bot_user_id&&message.bot_id===config.bot_id&&message.thread_ts===sourceTs&&!message.edited&&!message.hidden&&(!message.channel||message.channel===config.channel_id)&&(!message.team||message.team===config.team_id)&&typeof sourceTs==="string"&&/^\d{10}\.\d{6}$/.test(sourceTs)&&typeof message.ts==="string"&&/^\d{10}\.\d{6}$/.test(message.ts)&&message.ts>sourceTs&&typeof message.text==="string"&&message.text.startsWith(prefix)&&Buffer.byteLength(message.text)<=MAX_NOTICE_COMMAND,"Untrusted notice grant");
 const r=JSON.parse(message.text.slice(prefix.length)),n=r.notice;
 requireThat(r.schema_version==="1.0"&&r.command_id===c.command_id&&r.command_sha256===digest(bytes)&&r.report_request_id===c.report_request_id&&r.bundle_sha256===c.bundle_sha256&&r.send_authorized===true&&r.reason==="new_reservation"&&n?.report_id===c.report_request_id&&n.attempt_id===c.attempt_id&&n.file_id===c.file_id&&n.phase==="reserved"&&n.detail?.bundle_sha256===c.bundle_sha256&&n.detail.destination===config.notification_destination,"Notice grant differs from the new attempt");
 requireThat(Object.keys(n.detail).sort().join()===["bundle_sha256","destination","poster_original_sha256","report_merge_sha","text_sha256","url"].sort().join()&&/^[a-f0-9]{40}$/.test(n.detail.report_merge_sha)&&[n.detail.poster_original_sha256,n.detail.text_sha256].every(v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v))&&/^\d{4}-\d\d-\d\d\/r[1-9]\d*$/.test(n.edition)&&n.detail.url===`https://sfcloud-ai.github.io/ai-infra-reports/${n.edition}/`,"Incomplete notice grant proof");
 return {...n.detail,first_attempt_only:true,resume_send_allowed:false,attempt_id:n.attempt_id,file_id:n.file_id,slack_status:"not_checked",wecom_status:"not_checked"};
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 try{
  requireThat(process.argv.length===2,"Usage: notice-command.mjs < COMMAND.json > ai-notice-command.json");
  const chunks=[];let size=0;
  for await(const part of process.stdin){size+=part.length;requireThat(size<=MAX_NOTICE_COMMAND,"Notice input byte limit");chunks.push(part);}
  const input=Buffer.concat(chunks);const command=decodeNoticeCommand(input);process.stdout.write(encodeNoticeCommand(command));
 }catch{console.error("Invalid notice command; nothing submitted.");process.exitCode=1;}
}
