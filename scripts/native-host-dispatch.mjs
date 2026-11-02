// Runs in the tool-capable scheduled host, using its existing tools object.
// No eval, token, alternate Slack identity, or hidden mutation retry.
const NATIVE_TOOLS={ticket:'mcp__codex_apps__slack_slack_get_file_upload_url',complete:'mcp__codex_apps__slack_slack_complete_file_upload',search:'mcp__codex_apps__slack_slack_search_public_and_private'};
export async function driveNativeHost({tools,start,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),onStatus=()=>{},budgetMs=20*60*1000,readTimeoutMs=15000}){
 const allowed=new Set(Object.values(NATIVE_TOOLS));
 if(!Number.isSafeInteger(budgetMs)||budgetMs<120000||budgetMs>30*60*1000)throw Error('Bounded host budget required');
 if(!Number.isSafeInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>60000)throw Error('Bounded read timeout required');
 const end=now()+budgetMs;let session,buffer='',notBefore=null,seen=new Set(),awaitingDefer=false,durableRetry=false,readCleanupDeadline=null,deferAckDeadline=null,completionWindow=false;
 let result=await tools.exec_command({...start,yield_time_ms:1000,max_output_tokens:4000});
 while(true){
  session=result.session_id??session;buffer+=result.output??'';
  if(buffer.length>4*1024*1024)throw Error('Host output exceeded limit; do not restart');
  const newline=buffer.indexOf('\n');
  if(newline<0){
   if(result.exit_code!==undefined)throw Error('Host exited before verified completion; do not restart');
   if(now()>(deferAckDeadline??readCleanupDeadline??end))throw Error('Host budget expired; reconcile existing operations');
   result=await tools.write_stdin({session_id:session,chars:'',yield_time_ms:1000,max_output_tokens:4000});continue;
  }
  const message=JSON.parse(buffer.slice(0,newline).trim());buffer=buffer.slice(newline+1);
  if(awaitingDefer&&!['deferred','stopped'].includes(message.type))throw Error('Host did not acknowledge durable defer');
  if(message.type==='deferred'){if(!awaitingDefer)throw Error('Unrequested durable defer');onStatus(message);return {...message,slack_status:'not_checked',wecom_status:'not_checked',session_id:session};}
  if(message.type==='stopped')throw Error(message.reason);
  const cleanupSearch=readCleanupDeadline!==null&&message.type==='tool'&&message.tool===NATIVE_TOOLS.search;
  if(readCleanupDeadline!==null&&((!['pending','state'].includes(message.type)&&!cleanupSearch)||now()>readCleanupDeadline))throw Error('Read cleanup cannot dispatch more work; reconcile existing operations');
  if(message.type==='state'&&message.phase==='sender_reported'){onStatus(message);return {slack_status:'verified',wecom_status:'not_checked',session_id:session};}
  if(!session)throw Error('No running host session; do not restart');
  let reply;
  if(message.type==='tool'){
   if(!allowed.has(message.tool)||!Number.isSafeInteger(message.id)||seen.has(message.id)||typeof tools[message.tool]!=='function')throw Error('Unexpected or repeated tool request; do not dispatch');
   if(!cleanupSearch&&now()>=end)throw Error('Host budget expired before tool dispatch; reconcile existing operations');
   seen.add(message.id);
   if(cleanupSearch)reply={type:'tool_read_error',id:message.id,reason:'temporary_read_failure'};
   else{
   // A thrown mutation outcome stops the driver. Never repeat a tool call.
   try{
    let result;
    if(message.tool===NATIVE_TOOLS.search){
     let timer;
     try{result=await Promise.race([tools[message.tool](message.arguments),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Native read deadline'),{name:'TimeoutError'})),Math.min(readTimeoutMs,Math.max(1,end-now())));})]);}
     finally{clearTimeout(timer);}
    }else result=await tools[message.tool](message.arguments);
    reply={type:'tool_result',id:message.id,result};
    if(message.tool===NATIVE_TOOLS.search&&durableRetry&&now()+5000>=end)readCleanupDeadline=now()+10000;
   }catch(error){
    const code=error?.cause?.code??error?.code;
    const temporary=error?.name==='TimeoutError'||['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code);
    if(message.tool!==NATIVE_TOOLS.search||!temporary||!durableRetry)throw error;
    // A late read timeout may still need multiple empty pipe polls before the
    // host acknowledges pending. Allow only the defer handshake, for 10s.
    if(now()+5000>=end)readCleanupDeadline=now()+10000;
    reply={type:'tool_read_error',id:message.id,reason:'temporary_read_failure'};
   }
   }
  }else{
   if(!['ready','state','pending'].includes(message.type))throw Error('Unexpected host protocol');
   if(message.type==='ready'){
    notBefore=Date.parse(message.not_before);if(!Number.isFinite(notBefore))throw Error('Delivery time missing');
    if(message.protocol!==undefined&&message.protocol!=='native_durable_retry_v1')throw Error('Unsupported host protocol');
    durableRetry=message.protocol==='native_durable_retry_v1';
   }
   onStatus(message);
   if(['state','pending'].includes(message.type)&&message.completion_window!==undefined){
    if(typeof message.completion_window!=='boolean')throw Error('Invalid completion window');
    completionWindow=message.completion_window;
   }else if(message.type==='state')completionWindow=message.phase==='final_ready';
   const due=message.next_attempt_at??(message.type==='pending'?Math.max(now()+5000,notBefore):now());
   if(!Number.isSafeInteger(due)||due<0)throw Error('Invalid pending retry time');
   // Begin has already succeeded in this process: use the minute reserved for
   // its one completion instead of converting the grant to reconciliation.
   const reserve=durableRetry&&completionWindow?0:60000;
   // Defer only at a quiescent protocol boundary, never during a tool write.
   if(readCleanupDeadline!==null||now()+reserve>=end||due+reserve>=end)reply={type:'defer'};
   else{
    if(message.type==='pending')await sleep(Math.min(30000,Math.max(0,due-now())));
    reply=now()+reserve>=end?{type:'defer'}:durableRetry?{type:'tick',deadline:end}:{type:'tick'};
   }
   if(reply.type==='defer'&&!durableRetry)throw Error('Host budget ending without durable defer support; reconcile existing operations');
  }
  if(reply.type==='tick'&&now()>=end)throw Error('Host budget expired before tick; reconcile existing operations');
  if(reply.type==='defer'){awaitingDefer=true;deferAckDeadline=now()+10000;}
  result=await tools.write_stdin({session_id:session,chars:JSON.stringify(reply)+'\n',yield_time_ms:1000,max_output_tokens:4000});
 }
}
