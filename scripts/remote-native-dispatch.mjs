// Runs in the existing native-tool-capable cloud host. No timer is installed.
const reads=new Set(['mcp__codex_apps__slack_slack_search_public_and_private','mcp__codex_apps__slack_slack_read_thread','mcp__codex_apps__slack_slack_read_file']);
const writes=new Set(['mcp__codex_apps__slack_slack_get_file_upload_url','mcp__codex_apps__slack_slack_complete_file_upload']);
export async function driveRemoteNativeHost({tools,start,now=Date.now,budgetMs=20*60000,readTimeoutMs=15000,onStatus=()=>{},bootstrapNotBefore,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 if(!Number.isSafeInteger(budgetMs)||budgetMs<120000||budgetMs>30*60000||!Number.isSafeInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>60000)throw Error('Bounded remote execution required');
 if(bootstrapNotBefore!==undefined){
  if(!Number.isSafeInteger(bootstrapNotBefore)||bootstrapNotBefore<=0||bootstrapNotBefore>now()+60*60000)throw Error('Invalid bootstrap window');
  // Wait before launching the bounded CLI, with no upload or intent allocated.
  while(now()<bootstrapNotBefore){onStatus({type:'waiting',not_before:bootstrapNotBefore});await sleep(Math.min(30000,bootstrapNotBefore-now()));}
 }
 const deadline=now()+budgetMs,seen=new Set();let session,buffer='',ready=false,result=await tools.exec_command({...start,yield_time_ms:1000,max_output_tokens:4000});
 while(true){
  session=result.session_id??session;buffer+=result.output??'';
  if(buffer.length>65536)throw Error('Oversized remote host request');
  const newline=buffer.indexOf('\n');
  if(newline<0){
   if(result.exit_code!==undefined)throw Error('Remote host exited without a result');
   if(!session||now()>deadline+10000)throw Error('Remote slice ended; reconcile existing intents');
   result=await tools.write_stdin({session_id:session,chars:'',yield_time_ms:1000,max_output_tokens:4000});continue;
  }
  const message=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);let reply;
  if(['complete','deferred','idle','stopped','observed'].includes(message.type)){if(!ready)throw Error('Missing remote protocol handshake');onStatus(message);return message;}
  if(!session)throw Error('Remote host session unavailable');
  if(message.type==='ready'){
   if(ready||message.protocol!=='native_remote_runtime_v1')throw Error('Unexpected remote protocol');ready=true;reply={type:'run',deadline};
  }else{
   if(!ready||message.type!=='tool'||!Number.isSafeInteger(message.id)||seen.has(message.id)||![...reads,...writes].includes(message.tool)||typeof tools[message.tool]!=='function')throw Error('Unexpected or repeated remote tool request');
   if(now()>=deadline)throw Error('Deadline passed before remote tool dispatch');seen.add(message.id);
   let value;
   try{
    if(reads.has(message.tool)){
     let timer;try{value=await Promise.race([tools[message.tool](message.arguments),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Read timeout'),{name:'TimeoutError'})),Math.min(readTimeoutMs,Math.max(1,deadline-now())));})]);}finally{clearTimeout(timer);}
    }else value=await tools[message.tool](message.arguments);
    reply={type:'tool_result',id:message.id,result:value};
   }catch(error){
    const code=error?.cause?.code??error?.code;
    if(!reads.has(message.tool)||!(error?.name==='TimeoutError'||['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code)))throw error;
    reply={type:'tool_read_error',id:message.id,reason:'temporary_read_failure'};
   }
  }
  result=await tools.write_stdin({session_id:session,chars:JSON.stringify(reply)+'\n',yield_time_ms:1000,max_output_tokens:4000});
 }
}
