// Runs in the tool-capable scheduled host, using its existing tools object.
// No eval, token, alternate Slack identity, or hidden mutation retry.
const NATIVE_TOOLS={ticket:'mcp__codex_apps__slack_slack_get_file_upload_url',complete:'mcp__codex_apps__slack_slack_complete_file_upload',search:'mcp__codex_apps__slack_slack_search_public_and_private'};
export async function driveNativeHost({tools,start,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),onStatus=()=>{},budgetMs=20*60*1000}){
 const allowed=new Set(Object.values(NATIVE_TOOLS));
 if(!Number.isSafeInteger(budgetMs)||budgetMs<1000||budgetMs>30*60*1000)throw Error('Bounded host budget required');
 const end=now()+budgetMs;let session,buffer='',notBefore=null,seen=new Set();
 let result=await tools.exec_command({...start,yield_time_ms:1000,max_output_tokens:4000});
 while(true){
  session=result.session_id??session;buffer+=result.output??'';
  if(buffer.length>4*1024*1024)throw Error('Host output exceeded limit; do not restart');
  const newline=buffer.indexOf('\n');
  if(newline<0){
   if(result.exit_code!==undefined)throw Error('Host exited before verified completion; do not restart');
   if(now()>end)throw Error('Host budget expired; reconcile existing operations');
   result=await tools.write_stdin({session_id:session,chars:'',yield_time_ms:1000,max_output_tokens:4000});continue;
  }
  const message=JSON.parse(buffer.slice(0,newline).trim());buffer=buffer.slice(newline+1);
  if(message.type==='stopped')throw Error(message.reason);
  if(message.type==='state'&&message.phase==='sender_reported'){onStatus(message);return {slack_status:'verified',wecom_status:'not_checked',session_id:session};}
  if(!session)throw Error('No running host session; do not restart');
  let reply;
  if(message.type==='tool'){
   if(!allowed.has(message.tool)||!Number.isSafeInteger(message.id)||seen.has(message.id)||typeof tools[message.tool]!=='function')throw Error('Unexpected or repeated tool request; do not dispatch');
   if(now()>=end)throw Error('Host budget expired before tool dispatch; reconcile existing operations');
   seen.add(message.id);
   // A thrown mutation outcome stops the driver. Never repeat a tool call.
   reply={type:'tool_result',id:message.id,result:await tools[message.tool](message.arguments)};
  }else{
   if(!['ready','state','pending'].includes(message.type))throw Error('Unexpected host protocol');
   if(message.type==='ready'){notBefore=Date.parse(message.not_before);if(!Number.isFinite(notBefore))throw Error('Delivery time missing');}
   onStatus(message);
   if(now()>end)throw Error('Host budget expired; reconcile existing operations');
   if(message.type==='pending'){
    const remaining=notBefore-now();
    await sleep(remaining>0?Math.min(30000,remaining):5000);
   }
   reply={type:'tick'};
  }
  if(reply.type==='tick'&&now()>=end)throw Error('Host budget expired before tick; reconcile existing operations');
  result=await tools.write_stdin({session_id:session,chars:JSON.stringify(reply)+'\n',yield_time_ms:1000,max_output_tokens:4000});
 }
}
