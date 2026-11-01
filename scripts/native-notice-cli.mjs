// Data-only bridge for a tool-capable scheduled host. Never performs Slack writes.
import {freshNativeCommand,nativeReceiptSearch,readNativeReceipt,nativeCompletionArguments} from "./native-notice.mjs";
import {digest} from "./archive.mjs";
import {requireThat} from "./report-handoff.mjs";
let size=0;const chunks=[];
try{
 requireThat(process.argv.length===3&&["command","receipt","complete"].includes(process.argv[2]),"Expected command, receipt or complete");
 for await(const part of process.stdin){size+=part.length;requireThat(size<=4000000,"Native bridge input too large");chunks.push(part);}
 const input=JSON.parse(Buffer.concat(chunks)),mode=process.argv[2];let output;
 if(mode==="command"){
  const bytes=freshNativeCommand(input.action,input.fields),command=JSON.parse(bytes);
  output={command,filename:"ai-notice-command.json",bytes_base64:bytes.toString("base64"),sha256:digest(bytes),initial_comment:`!ai-notice submit ${command.command_id} ${digest(bytes)}`,channel_id:input.config.channel_id,receipt_search:nativeReceiptSearch(bytes,input.config)};
 }else{
  const bytes=Buffer.from(input.command_bytes_base64,"base64");
  const options={bytes,sourceTs:input.source_ts,config:input.config};
  if(mode==="receipt")output=readNativeReceipt(input.invocation,options);
  else{
   output={tool:"mcp__codex_apps__slack_slack_complete_file_upload",arguments:nativeCompletionArguments(input.invocation,{...options,reportJson:Buffer.from(input.report_json_base64,"base64"),poster:Buffer.from(input.poster_base64,"base64"),checkedAt:input.checked_at})};
  }
 }
 process.stdout.write(JSON.stringify(output)+"\n");
}catch{
 console.error("Native handoff input or proof rejected; no messages were sent.");process.exitCode=1;
}
