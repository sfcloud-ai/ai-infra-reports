import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {digest} from "../scripts/archive.mjs";
import {freshNativeCommand,nativeReceiptSearch,readNativeReceipt,nativeCompletionArguments} from "../scripts/native-notice.mjs";
import {createNoticeManifest} from "../scripts/notice-manifest.mjs";
const config={channel_id:"C123",bot_user_id:"U456",notification_destination:"D123",workspace_host:"fixture-workspace.slack.com"};
const report=JSON.parse(await readFile("tests/fixtures/archive/reports/2026-10-31/r1/report.json"));
const poster=Buffer.from("validated original poster fixture");report.poster="assets/poster.png";report.images=[{path:report.poster,sha256:digest(poster),alt:"Fixture"}];
const reportJson=Buffer.from(JSON.stringify(report)),commit="a".repeat(40),manifest=createNoticeManifest(reportJson,commit);
const sourceTs="1793404700.000001",receiptTs="1793404750.000001",notBefore=Date.parse("2026-10-31T00:00:00.000Z");
function fixture(){
 const bytes=freshNativeCommand("begin",{report_request_id:"morning-report-01",bundle_sha256:"b".repeat(64),attempt_id:"native-attempt-01",file_id:"F123"}),c=JSON.parse(bytes);
 const detail={poster_policy:"original_bytes_v1",bundle_sha256:c.bundle_sha256,report_merge_sha:commit,url:manifest.index_url,poster_original_sha256:digest(poster),text_sha256:digest(Buffer.from(manifest.text)),destination:config.notification_destination,delivery_mode:"native_v1",not_before:"2026-10-31T00:00:00.000Z",completion_command_id:c.command_id,completion_command_sha256:digest(bytes)};
 const receipt={schema_version:"1.0",command_id:c.command_id,command_sha256:digest(bytes),report_request_id:c.report_request_id,bundle_sha256:c.bundle_sha256,send_authorized:true,reason:"new_completion_intent",notice:{edition:"2026-10-31/r1",report_id:c.report_request_id,attempt_id:c.attempt_id,file_id:c.file_id,phase:"completion_intent",detail},slack_status:"not_checked",wecom_status:"not_checked"};
 const build=(value=receipt)=>({tool:"mcp__codex_apps__slack_slack_search_public_and_private",arguments:nativeReceiptSearch(bytes,config),result:{content:[{type:"text",text:JSON.stringify({results:`# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: #control (ID: C123)\nFrom: Publisher (ID: U456)  [BOT]\nTime: 2026-10-30 23:59:10\nMessage_ts: ${receiptTs}\nPermalink: [link](https://${config.workspace_host}/archives/C123/p${receiptTs.replace(".","")}?thread_ts=${sourceTs}&cid=C123)\nText: \n!ai-notice receipt ${JSON.stringify(value)}\n\n---\n\n`,pagination_info:"End of results - No more pages available.\n"})}]}});
 return {bytes,c,receipt,build,options:{bytes,sourceTs,config,reportJson,poster,checkedAt:notBefore-30000,now:notBefore}};
}
test("native receipt adapter accepts the observed filtered tool format without fabricated app or bot IDs",()=>{
 const f=fixture();assert.deepEqual(readNativeReceipt(f.build(),f.options),f.receipt);
 const args=nativeCompletionArguments(f.build(),f.options);
 assert.deepEqual(args,{file_id:"F123",channel_id:"D123",initial_comment:manifest.text,title:"poster.png"});
 assert.equal(Object.hasOwn(args,"thread_ts"),false);assert.equal(args.initial_comment.includes(report.articles[0].summary),false);
});
test("native adapter fails closed on unfiltered, partial, wrong-author, wrong-workspace and wrong-thread results",()=>{
 const changes=[
  v=>v.arguments.filters="in:<#C123>",v=>v.arguments.include_bots=false,v=>v.arguments.include_context=true,
  v=>v.tool="mcp__codex_apps__slack_slack_read_thread",v=>v.result.isError=true,
  v=>v.result.content.push({type:"text",text:"extra"}),
  ...[["U456","U999"],["fixture-workspace.slack.com","foreign.slack.com"],[`thread_ts=${sourceTs}`,"thread_ts=1793404600.000001"],["1 results","2 results"],["[BOT]","[PERSON]"],["End of results - No more pages available.","More pages available."]].map(([a,b])=>v=>v.result.content[0].text=v.result.content[0].text.replace(a,b))
 ];
 for(const change of changes){const f=fixture(),v=f.build();change(v);assert.throws(()=>readNativeReceipt(v,f.options));}
});
test("native pagination accepts the observed escaped newline but rejects incomplete or augmented markers",()=>{
 const f=fixture();
 for(const marker of ["End of results - No more pages available.\n","End of results - No more pages available.\\n",
  "End of results - No more pages available.","End of results - No more pages available.\\nextra",
  "End of results - No more pages available.\nMore pages available."]){
  const v=f.build(),body=JSON.parse(v.result.content[0].text);body.pagination_info=marker;
  v.result.content[0].text=JSON.stringify(body);
  if(marker.endsWith("available.\n")||marker.endsWith("available.\\n"))assert.deepEqual(readNativeReceipt(v,f.options),f.receipt);
  else assert.throws(()=>readNativeReceipt(v,f.options));
 }
});
test("a prior command receipt, denied completion, changed destination or image cannot authorize final native upload",()=>{
 for(const change of [r=>r.command_sha256="f".repeat(64),r=>r.send_authorized=false,r=>r.notice.phase="reserved",r=>r.notice.detail.destination="DOTHER",r=>r.notice.detail.completion_command_id="old-command-01",r=>r.notice.detail.text_sha256="f".repeat(64),r=>r.notice.detail.poster_original_sha256="f".repeat(64),r=>r.notice.detail.not_before="2026-10-30T00:00:00.000Z"]){
  const f=fixture();change(f.receipt);assert.throws(()=>nativeCompletionArguments(f.build(),f.options));
 }
 const f=fixture();assert.throws(()=>nativeCompletionArguments(f.build(),{...f.options,poster:Buffer.from("changed")}));
 const fresh=fixture();assert.notEqual(JSON.parse(f.bytes).command_id,JSON.parse(fresh.bytes).command_id);
 assert.throws(()=>readNativeReceipt(f.build(),{...f.options,bytes:fresh.bytes}));
 assert.throws(()=>freshNativeCommand("begin",{...f.c}));
});
test("prepared upload cannot complete early or with a future or stale final byte/publication check",()=>{
 const f=fixture();
 for(const patch of [{now:notBefore-1},{checkedAt:notBefore-60001},{checkedAt:notBefore+1},{checkedAt:NaN}])assert.throws(()=>nativeCompletionArguments(f.build(),{...f.options,...patch}));
 assert.equal(nativeCompletionArguments(f.build(),{...f.options,checkedAt:notBefore-60000}).channel_id,"D123");
});
test("scheduled-host CLI creates fresh command files and returns only verified completion arguments",()=>{
 const f=fixture(),script="scripts/native-notice-cli.mjs";
 const invoke=(mode,input)=>spawnSync(process.execPath,[script,mode],{input:JSON.stringify(input),encoding:"utf8",timeout:10000});
 const fields={report_request_id:f.c.report_request_id,bundle_sha256:f.c.bundle_sha256,attempt_id:f.c.attempt_id,file_id:f.c.file_id};
 const first=invoke("command",{action:"prepare",fields,config}),second=invoke("command",{action:"prepare",fields,config});
 assert.equal(first.status,0,first.stderr);assert.equal(second.status,0,second.stderr);
 const a=JSON.parse(first.stdout),b=JSON.parse(second.stdout);
 assert.notEqual(a.command.command_id,b.command.command_id);assert.equal(a.sha256,digest(Buffer.from(a.bytes_base64,"base64")));
 assert.equal(a.initial_comment,`!ai-notice submit ${a.command.command_id} ${a.sha256}`);assert.equal(a.channel_id,config.channel_id);
 const input={command_bytes_base64:f.bytes.toString("base64"),source_ts:sourceTs,config,invocation:f.build(),report_json_base64:reportJson.toString("base64"),poster_base64:poster.toString("base64"),checked_at:Date.now()};
 const checked=invoke("receipt",input);assert.equal(checked.status,0,checked.stderr);assert.deepEqual(JSON.parse(checked.stdout),f.receipt);
 const complete=invoke("complete",input);assert.equal(complete.status,0,complete.stderr);
 assert.deepEqual(JSON.parse(complete.stdout),{tool:"mcp__codex_apps__slack_slack_complete_file_upload",arguments:{file_id:"F123",channel_id:"D123",initial_comment:manifest.text,title:"poster.png"}});
 input.invocation.arguments.filters="in:<#COTHER>";
 const rejected=invoke("complete",input);assert.equal(rejected.status,1);assert.equal(rejected.stdout,"");
});
