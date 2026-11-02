// Runs in the existing native-tool-capable cloud host. No timer is installed.
const reads=new Set(['mcp__codex_apps__slack_slack_search_public_and_private','mcp__codex_apps__slack_slack_read_thread','mcp__codex_apps__slack_slack_read_file']);
const writes=new Set(['mcp__codex_apps__slack_slack_get_file_upload_url','mcp__codex_apps__slack_slack_complete_file_upload']);
// Short physical lines avoid ConPTY's destructive wrapping/cursor rewrites.
// JSON remains data, with ordered chunks; native result objects are not encoded
// by this output framer and are forwarded to stdin without alteration.
export function frameRemoteMessage(value){
 const ascii=JSON.stringify(value).replace(/[^\x20-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
 const hex=Array.from(ascii,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');let out='';
 for(let at=0,index=0;at<hex.length;at+=48,index++)out+=`@nr1:${index}:${at+48>=hex.length?1:0}:${hex.slice(at,at+48)}\r\n`;
 return out;
}
export class RemoteFrames{
 constructor(){this.buffer='';this.payload='';this.index=0;}
 push(text){this.buffer+=text;if(this.buffer.length+this.payload.length>200000)throw Error('Oversized remote host output');}
 next(){
  this.buffer=this.buffer.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  let newline;
  while((newline=this.buffer.indexOf('\n'))>=0){
   const line=this.buffer.slice(0,newline).replace(/\r+$/,'');this.buffer=this.buffer.slice(newline+1);if(!line)continue;
   const m=/^@nr1:(0|[1-9]\d{0,4}):([01]):(.+)$/u.exec(line);
   if(!m||Number(m[1])!==this.index||m[3].length>48||! /^(?:[0-9a-f]{2})+$/.test(m[3]))throw Error('Invalid remote output frame');
   this.payload+=m[3];this.index++;if(this.payload.length>131072)throw Error('Oversized remote host request');
   if(m[2]==='1'){const value=JSON.parse(this.payload.match(/../g).map(h=>String.fromCharCode(parseInt(h,16))).join(''));this.payload='';this.index=0;return value;}
  }
  return null;
 }
}
export async function driveRemoteNativeHost({tools,start,now=Date.now,budgetMs=20*60000,readTimeoutMs=15000,onStatus=()=>{},bootstrapNotBefore,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 if(!Number.isSafeInteger(budgetMs)||budgetMs<120000||budgetMs>30*60000||!Number.isSafeInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>60000)throw Error('Bounded remote execution required');
 if(bootstrapNotBefore!==undefined){
  if(!Number.isSafeInteger(bootstrapNotBefore)||bootstrapNotBefore<=0||bootstrapNotBefore>now()+60*60000)throw Error('Invalid bootstrap window');
  // Wait before launching the bounded CLI, with no upload or intent allocated.
  while(now()<bootstrapNotBefore){onStatus({type:'waiting',not_before:bootstrapNotBefore});await sleep(Math.min(30000,bootstrapNotBefore-now()));}
 }
 const deadline=now()+budgetMs,seen=new Set(),frames=new RemoteFrames();let session,ready=false,result=await tools.exec_command({...start,tty:true,yield_time_ms:1000,max_output_tokens:16000});
 while(true){
  session=result.session_id??session;frames.push(result.output??'');const message=frames.next();
  if(!message){
   if(result.exit_code!==undefined)throw Error('Remote host exited without a result');
   if(!session||now()>deadline+10000)throw Error('Remote slice ended; reconcile existing intents');
   result=await tools.write_stdin({session_id:session,chars:'',yield_time_ms:1000,max_output_tokens:16000});continue;
  }
  let reply;
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
  // Send the delimiter separately: large terminal pastes can retain their last
  // newline until another input event. No host command is complete before it.
  const body=await tools.write_stdin({session_id:session,chars:JSON.stringify(reply),yield_time_ms:1000,max_output_tokens:16000});
  if(body.exit_code!==undefined)result=body;
  else{const end=await tools.write_stdin({session_id:session,chars:'\n',yield_time_ms:1000,max_output_tokens:16000});result={...end,output:(body.output??'')+(end.output??'')};}
 }
}
