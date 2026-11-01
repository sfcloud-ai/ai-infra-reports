// Native Slack tools remain the transport. These helpers bind their real filtered
// result format to the persisted T4 command; they never invent raw bot metadata.
import {randomUUID} from "node:crypto";
import {digest} from "./archive.mjs";
import {requireThat} from "./report-handoff.mjs";
import {decodeNoticeCommand,MAX_NOTICE_COMMAND} from "./notice-outbox.mjs";
import {encodeNoticeCommand} from "./notice-command.mjs";
import {createNoticeManifest} from "./notice-manifest.mjs";
const SEARCH="mcp__codex_apps__slack_slack_search_public_and_private",TS=/^\d{10}\.\d{6}$/;
const exact=(o,keys)=>requireThat(o&&typeof o==="object"&&!Array.isArray(o)&&Object.keys(o).sort().join()===keys.sort().join(),"Native receipt fields changed");
function configIdentity(c){
 requireThat(c&&/^[CG][A-Z0-9]+$/.test(c.channel_id)&&/^U[A-Z0-9]+$/.test(c.bot_user_id)&&/^D[A-Z0-9]+$/.test(c.notification_destination)&&/^[a-z0-9-]+\.slack\.com$/.test(c.workspace_host),"Pinned native control identity required");
}
export function freshNativeCommand(action,fields){
 requireThat(["prepare","prepare_bundle","begin","status","asset","check","record","record_bundle","unknown"].includes(action),"Unsupported native command");
 requireThat(!Object.hasOwn(fields,"command_id")&&!Object.hasOwn(fields,"action"),"Never reuse a previous command or completion grant");
 return encodeNoticeCommand({schema_version:"1.0",...fields,action,command_id:`native-${action.replaceAll('_','-')}-${randomUUID()}`});
}
export function nativeReceiptSearch(bytes,config){
 configIdentity(config);const c=decodeNoticeCommand(bytes);
 return {keywords:[`"!ai-notice receipt"`,`"${c.command_id}"`],filters:`in:<#${config.channel_id}> from:<@${config.bot_user_id}>`,natural_language_query:"",channel_types:"private_channel",content_types:"messages",include_bots:true,include_context:false,response_format:"detailed",limit:2,sort:"timestamp",sort_dir:"desc"};
}
export function readNativeReceipt(invocation,{bytes,sourceTs,config}){
 const c=decodeNoticeCommand(bytes),expected=nativeReceiptSearch(bytes,config);
 requireThat(invocation?.tool===SEARCH&&TS.test(sourceTs),"Actual filtered Slack tool invocation required");
 exact(invocation.arguments,Object.keys(expected));
 for(const key of Object.keys(expected))requireThat(JSON.stringify(invocation.arguments[key])===JSON.stringify(expected[key]),"Native search scope changed");
 const result=invocation.result;
 requireThat(result&&!result.isError&&Array.isArray(result.content)&&result.content.length===1&&result.content[0].type==="text","Incomplete native tool result");
 const body=JSON.parse(result.content[0].text);
 const finished=["End of results - No more pages available.\n","End of results - No more pages available.\\n"];
 requireThat(finished.includes(body.pagination_info)&&typeof body.results==="string"&&Buffer.byteLength(body.results)<=MAX_NOTICE_COMMAND+4096,"Incomplete or oversized native receipt search");
 const match=/^# Search Results for: [^\n]*\n\n## Messages \(1 results\)\n### Result 1 of 1\nChannel: #[^\n]+ \(ID: ([CG][A-Z0-9]+)\)\nFrom: [^\n]+ \(ID: (U[A-Z0-9]+)\)  \[BOT\]\nTime: [^\n]+\nMessage_ts: (\d{10}\.\d{6})\nPermalink: \[link\]\((https:\/\/[^\n]+)\)\nText: \n!ai-notice receipt ([^\n]+)\n\n---\n\n$/.exec(body.results);
 requireThat(match&&match[1]===config.channel_id&&match[2]===config.bot_user_id&&match[3]>sourceTs,"Untrusted native receipt envelope");
 const url=new URL(match[4]);
 requireThat(url.hostname===config.workspace_host&&!url.port&&!url.username&&!url.password&&!url.hash&&url.pathname===`/archives/${config.channel_id}/p${match[3].replace(".","")}`&&[...url.searchParams.keys()].sort().join()==="cid,thread_ts"&&url.searchParams.get("cid")===config.channel_id&&url.searchParams.get("thread_ts")===sourceTs,"Receipt is not in the original control thread");
 const r=JSON.parse(match[5]);
 const keys=["schema_version","command_id","command_sha256","report_request_id","bundle_sha256","send_authorized","reason","notice","slack_status","wecom_status"];
 if(c.action==="asset")keys.push("asset");if(c.action==="check")keys.push("verification");exact(r,keys);
 requireThat(r.schema_version==="1.0"&&r.command_id===c.command_id&&r.command_sha256===digest(bytes)&&r.report_request_id===c.report_request_id&&r.bundle_sha256===c.bundle_sha256&&typeof r.send_authorized==="boolean"&&r.wecom_status==="not_checked","Receipt does not bind this fresh command");
 return r;
}
function completionArguments(receipt,{bytes,config,reportJson,poster,bundleBytes,checkedAt,now=Date.now()}){
 configIdentity(config);const c=decodeNoticeCommand(bytes),n=receipt?.notice;
 requireThat(c.action==="begin"&&receipt.command_id===c.command_id&&receipt.command_sha256===digest(bytes)&&receipt.report_request_id===c.report_request_id&&receipt.bundle_sha256===c.bundle_sha256&&receipt.send_authorized===true&&receipt.reason==="new_completion_intent"&&n?.phase==="completion_intent"&&n.report_id===c.report_request_id&&n.attempt_id===c.attempt_id&&n.file_id===c.file_id,"Only a fresh persisted completion intent permits one final upload");
 const d=n.detail;
 exact(d,["poster_policy","bundle_sha256","report_merge_sha","url","poster_original_sha256","text_sha256","destination","delivery_mode","not_before","completion_command_id","completion_command_sha256"]);
 const manifest=createNoticeManifest(reportJson,d.report_merge_sha);
 requireThat(["native_v1","native_bundle_v1"].includes(d.delivery_mode)&&d.poster_policy==="original_bytes_v1"&&d.completion_command_id===c.command_id&&d.completion_command_sha256===digest(bytes)&&d.bundle_sha256===c.bundle_sha256&&d.destination===config.notification_destination&&d.url===manifest.index_url&&n.edition===`${manifest.date}/r${manifest.revision}`&&d.text_sha256===digest(Buffer.from(manifest.text))&&d.poster_original_sha256===manifest.poster.sha256,"Native grant differs from the report plan");
 if(d.delivery_mode==="native_bundle_v1")requireThat(Buffer.isBuffer(bundleBytes)&&bundleBytes.length>0&&bundleBytes.length<=8*1024*1024&&digest(bundleBytes)===d.bundle_sha256,"Final bundle differs from reserved source");
 requireThat(Buffer.isBuffer(poster)&&poster.length>0&&poster.length<=2000000&&digest(poster)===d.poster_original_sha256,"Final poster bytes differ from the verified original");
 requireThat(d.not_before===n.edition.split("/")[0]+"T00:00:00.000Z"&&Number.isFinite(now)&&now>=Date.parse(d.not_before),"Do not complete the upload before 08:00 Asia/Shanghai");
 requireThat(Number.isFinite(checkedAt)&&checkedAt<=now&&now-checkedAt<=60000,"Recheck public report and staged poster within 60 seconds of completion");
 return {file_id:c.file_id,channel_id:d.destination,initial_comment:manifest.text,title:d.delivery_mode==="native_bundle_v1"?"ai-brief-bundle.json":new URL(manifest.poster.url).pathname.split("/").at(-1)};
}
export function nativeCompletionArguments(invocation,options){
 return completionArguments(readNativeReceipt(invocation,options),options);
}
