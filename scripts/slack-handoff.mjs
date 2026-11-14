import {REPOSITORY} from "./archive.mjs";
import {digest} from "./archive.mjs";
import {requireThat,boundedBytes,MAX_BUNDLE,SHA,acceptControlFile} from "./report-handoff.mjs";
import {operationError,rateLimitInfo} from "./github.mjs";
import {localSlackCooldown,confirmedSlackRejection} from './handoff-recovery.mjs';
// Slack escapes only these three characters in returned message text. Decode
// exactly one layer on the observed side; never normalize the bound original.
function controlReceiptTextMatches(observed,original){
 return typeof observed==='string'&&typeof original==='string'&&(observed===original||observed.replace(/&(amp|lt|gt);/g,(_match,entity)=>({amp:'&',lt:'<',gt:'>'})[entity])===original);
}
export class SlackHandoff{
 constructor(config,token,fetcher=fetch,{now=Date.now,cooldowns}={}){this.config=config;this.token=token;this.fetcher=fetcher;this.now=now;this.cooldowns=cooldowns;}
 assertReady(method){
  const deadline=this.cooldowns?.deadline(method)??0;
  if(deadline>this.now())throw localSlackCooldown(operationError('Slack method cooldown',{stage:'slack.'+method,code:'rate_limited',outcome:'not_started',retryable:true,retry_at:deadline}));
 }
 async call(method,params={},write=false,responseLimit=1024*1024){
  requireThat(Number.isSafeInteger(responseLimit)&&responseLimit>0&&responseLimit<=33*1024*1024&&(responseLimit===1024*1024||method==='files.info'&&!write),'Bounded Slack metadata response required');
  const url=new URL("https://slack.com/api/"+method);
  if(!write)for(const [k,v]of Object.entries(params))url.searchParams.set(k,String(v));
  const failure=(code,outcome,retryable,http_status,retry_at)=>operationError('Slack operation failed; reconcile writes before retrying',{stage:'slack.'+method,code,outcome,retryable,http_status,retry_at});
  this.assertReady(method);
  let response;
  try{response=await this.fetcher(url.href,{method:write?"POST":"GET",headers:{authorization:"Bearer "+this.token,"content-type":"application/json; charset=utf-8"},body:write?JSON.stringify(params):undefined,redirect:"error",signal:AbortSignal.timeout(30000)});}catch{throw failure('transport',write?'unknown':'not_started',!write);}
  const retryAt=()=>{const seconds=response.headers?.get?.('retry-after');return this.now()+(/^\d{1,6}$/.test(seconds??'')?Number(seconds)*1000:60000);};
  const limited=async()=>{const deadline=retryAt();await this.cooldowns?.defer(method,deadline);return deadline;};
  if(!response.ok){
   const error=failure('http_error',write&&response.status>=500?'unknown':'not_started',response.status===429||(!write&&response.status>=500),response.status,response.status===429?await limited():undefined);
   throw write&&response.status===429?confirmedSlackRejection(error):error;
  }
  // No inline write retry. The durable worker decides whether reconciliation
  // or a bounded retry is safe; only allowlisted error identifiers are logged.
  const data=JSON.parse((await boundedBytes(response,responseLimit)).toString("utf8"));
  if(data.ok!==true){const codes=['ratelimited','invalid_auth','token_revoked','missing_scope','not_authed','account_inactive','channel_not_found','not_in_channel','is_archived','invalid_cursor'];const code=codes.includes(data.error)?data.error:'api_error';const error=failure(code,write&&code==='api_error'?'unknown':'not_started',code==='ratelimited'||!write&&code==='invalid_cursor',undefined,code==='ratelimited'?await limited():undefined);throw write&&code!=='api_error'&&code!=='invalid_cursor'?confirmedSlackRejection(error):error;}
  return {data,scopes:response.headers.get("x-oauth-scopes")};
 }
 async preflight(){
  const c=this.config,{data:a,scopes}=await this.call("auth.test");
  requireThat(a.team_id===c.team_id&&a.user_id===c.bot_user_id&&a.bot_id===c.bot_id,"Slack bot identity mismatch");
  requireThat(scopes?.split(",").map(s=>s.trim()).sort().join() === ["chat:write","files:read","groups:history","groups:read"].sort().join(),"Slack scopes must match the dedicated publisher");
  const {data:{channel}}=await this.call("conversations.info",{channel:c.channel_id});
  requireThat(channel?.id===c.channel_id&&channel.is_private===true&&channel.is_member===true&&!channel.is_im&&!channel.is_mpim&&!channel.is_archived&&!channel.is_shared&&!channel.is_ext_shared&&!channel.is_org_shared,"Control channel must be private, unshared and joined");
 }
 async history(now=Date.now()){
  const from=(now/1000-15*60).toFixed(6),to=(now/1000+30).toFixed(6),messages=new Map(),seen=new Set();let cursor=null;
  for(let page=0;page<5;page++){
   const result=await this.historyPage({from,to,cursor});
   for(const message of result.messages){
    const prior=messages.get(message.ts);requireThat(!prior||JSON.stringify(prior)===JSON.stringify(message),'Control message changed during pagination');messages.set(message.ts,message);
   }
   cursor=result.next_cursor;
   if(cursor===null)return [...messages.values()].sort((a,b)=>a.ts.localeCompare(b.ts));
   requireThat(!seen.has(cursor),'Repeated control history cursor');seen.add(cursor);
  }
  throw Error('Incomplete control history; inspect backlog before continuing');
 }
 async historyPage({from,to,cursor=null}){
  const timestamp=/^\d{10}\.\d{6}$/;
  requireThat(timestamp.test(from)&&timestamp.test(to)&&from<=to&&(cursor===null||typeof cursor==='string'&&cursor.length>0&&cursor.length<=1024),"Bounded fixed history range required");
  const {data}=await this.call("conversations.history",{channel:this.config.channel_id,oldest:from,latest:to,inclusive:true,limit:100,...(cursor?{cursor}:{})});
  const next=data.response_metadata?.next_cursor||null;
  requireThat(Array.isArray(data.messages)&&data.messages.length<=100&&(data.has_more===undefined||typeof data.has_more==='boolean')&&(next===null||typeof next==='string'&&next.length<=1024)&&!(data.has_more&&!next),"Incomplete control history page");
  requireThat(data.messages.every(m=>timestamp.test(m?.ts??'')&&m.ts>=from&&m.ts<=to),"Control history outside fixed range");
  return {messages:data.messages,next_cursor:next};
 }
 async exactPublish(timestamp){
  requireThat(/^\d{10}\.\d{6}$/.test(timestamp),"Original message timestamp required");
  const {data}=await this.call("conversations.history",{channel:this.config.channel_id,oldest:timestamp,latest:timestamp,inclusive:true,limit:2});
  requireThat(Array.isArray(data.messages)&&data.messages.length===1&&data.messages[0].ts===timestamp&&!data.has_more&&!data.response_metadata?.next_cursor,"Original publish message unavailable or ambiguous");
  return data.messages[0];
 }
 async download(event,{name="ai-brief-bundle.json",limit=MAX_BUNDLE}={}){
  requireThat(Number.isSafeInteger(limit)&&limit>0&&limit<=16*1024*1024,'Bounded Slack file size required');
  // Native snippet metadata can embed multiple representations of its content.
  // Bound that envelope separately; the original file retains its own limit.
  const {data:{file:f}}=await this.call("files.info",{file:event.file_id},false,2*limit+1024*1024);
  const userApp=this.config.sender_user_app_id!==undefined;
  if(!(f?.id===event.file_id&&f.user===this.config.sender_user_id&&f.name===name&&(f.mode==="hosted"||(userApp&&f.mode==="snippet"))&&(!userApp||f.user_team===this.config.team_id)&&!f.is_external&&Number.isSafeInteger(f.size)&&f.size>0&&f.size<=limit))throw Object.assign(Error('Unexpected Slack file metadata'),{slackFileRejection:'invalid_metadata'});
  requireThat(f.shares?.private?.[this.config.channel_id]?.some(s=>s.ts===event.source_ts),"File is not shared in the command message");
  const url=new URL(f.url_private_download);
  requireThat(url.protocol==="https:"&&url.hostname==="files.slack.com"&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname.startsWith(`/files-pri/${this.config.team_id}-${event.file_id}/`),"Unexpected Slack download origin/path");
  const bytes=await boundedBytes(await this.fetcher(url.href,{headers:{authorization:"Bearer "+this.token},redirect:"error",signal:AbortSignal.timeout(30000)}),limit);
  requireThat(bytes.length===f.size,"Slack file size mismatch");return bytes;
 }
 async receipt(thread,proof){
  return this.controlReceipt(thread,"!ai-report receipt "+JSON.stringify(proof));
 }
 async controlAsset({message_ts,file_id,name,sha256,bytes},now=Date.now()){
  const {data}=await this.call("conversations.history",{channel:this.config.channel_id,oldest:message_ts,latest:message_ts,inclusive:true,limit:2});
  requireThat(Array.isArray(data.messages)&&data.messages.length===1&&!data.has_more&&!data.response_metadata?.next_cursor,"Exact complete asset history required");
  const message=data.messages[0];
  requireThat(message.ts===message_ts&&(!message.channel||message.channel===this.config.channel_id)&&(!message.team||message.team===this.config.team_id),"Asset channel/timestamp mismatch");
  const event=acceptControlFile(message,this.config,now);requireThat(event.file_id===file_id,"Asset file binding changed");
  const original=await this.download(event,{name,limit:2000000});
  requireThat(original.length===bytes&&digest(original)===sha256,"Original poster bytes changed in Slack");
  return {status:"verified",channel_id:this.config.channel_id,message_ts,file_id,sha256,bytes,messages_sent:0};
 }
 async controlReceipt(thread,text){
  const {data}=await this.call("chat.postMessage",{channel:this.config.channel_id,thread_ts:thread,text,parse:"none",mrkdwn:false,unfurl_links:false,unfurl_media:false},true);
  requireThat(data.channel===this.config.channel_id&&data.message?.thread_ts===thread&&data.message?.bot_id===this.config.bot_id&&data.message?.user===this.config.bot_user_id&&controlReceiptTextMatches(data.message?.text,text),"Slack receipt identity mismatch");
  return data.ts;
 }
 async findControlReceipt(thread,text){
  requireThat(/^\d{10}\.\d{6}$/.test(thread),'Original receipt thread required');
  const messages=new Map(),seen=new Set();let cursor=null,complete=false;
  for(let page=0;page<5;page++){
   const {data}=await this.call("conversations.replies",{channel:this.config.channel_id,ts:thread,limit:100,...(cursor?{cursor}:{})});
   requireThat(Array.isArray(data.messages)&&data.messages.length<=100,'Bounded receipt page required');
   const pageTimestamps=new Set();
   for(const message of data.messages){
    requireThat(/^\d{10}\.\d{6}$/.test(message?.ts??''),'Receipt timestamp required');
    requireThat(!pageTimestamps.has(message.ts),'Duplicate receipt timestamp in one page');pageTimestamps.add(message.ts);
    const prior=messages.get(message.ts);requireThat(!prior||JSON.stringify(prior)===JSON.stringify(message),'Receipt changed during pagination');messages.set(message.ts,message);
   }
   cursor=data.response_metadata?.next_cursor||null;
   if(!cursor){requireThat(!data.has_more,'Incomplete receipt thread; no automatic resend');complete=true;break;}
   requireThat(typeof cursor==='string'&&cursor.length<=1024&&!seen.has(cursor),'Invalid receipt pagination');seen.add(cursor);
  }
  requireThat(complete,'Incomplete receipt thread; no automatic resend');
  const matches=[...messages.values()].filter(m=>m.thread_ts===thread&&controlReceiptTextMatches(m.text,text));
  requireThat(matches.length===1,"Receipt absent or ambiguous; no automatic resend");
  const m=matches[0],c=this.config;
  requireThat(m.type==="message"&&(!m.subtype||m.subtype==="bot_message")&&m.user===c.bot_user_id&&m.bot_id===c.bot_id&&!m.edited&&!m.hidden&&(!m.channel||m.channel===c.channel_id)&&(!m.team||m.team===c.team_id)&&typeof m.ts==="string"&&/^\d{10}\.\d{6}$/.test(m.ts)&&m.ts>thread,"Receipt identity changed");
  return m.ts;
 }
}
// Public reads only. No long-lived token is minted while waiting for a merge.
async function publicRead(route,fetcher,now){
 let response;
 try{response=await fetcher("https://api.github.com/repos/"+REPOSITORY+route,{headers:{accept:"application/vnd.github+json","x-github-api-version":"2026-03-10"},redirect:"error",signal:AbortSignal.timeout(30000)});}
 catch{throw operationError('Remote read failed',{stage:'public_github_read',code:'transport',retryable:true});}
 const evidence={stage:'public_github_read',http_status:response.status,request_id:response.headers?.get?.('x-github-request-id')};
 if(!response.ok){
  const {limited,retry_at}=await rateLimitInfo(response,now());
  throw operationError('Remote read failed',{...evidence,provider_scope:limited?'github.public':undefined,code:limited?'rate_limited':'http_'+response.status,retryable:limited||response.status===408||response.status>=500,retry_at});
 }
 try{return {response,data:JSON.parse((await boundedBytes(response,2*1024*1024)).toString('utf8'))};}
 catch{throw operationError('Remote read failed',{...evidence,code:'invalid_response',retryable:true});}
}
export async function publicGitHub(route,fetcher=fetch,now=Date.now){
 requireThat(/^\/(pulls\/[1-9]\d*|git\/commits\/[a-f0-9]{40})$/.test(route),"GitHub read route");
 return (await publicRead(route,fetcher,now)).data;
}
// Read the repository's own merge event, never a commit mentioned in a comment
// or the current branch tip. Some PR representations omit merge_commit_sha.
export async function publicMergeCommit(number,pr,fetcher=fetch,now=Date.now){
 requireThat(/^[1-9]\d*$/.test(String(number))&&Number.isSafeInteger(Number(number))&&pr?.number===Number(number)&&pr.merged===true&&pr.state==="closed","Merged PR identity required");
 requireThat(typeof pr.merged_at==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(pr.merged_at)&&Number.isSafeInteger(pr.merged_by?.id)&&pr.merged_by.id>0,"Merged PR event metadata required");
 const origin="https://api.github.com/repos/"+REPOSITORY;
 const {response,data:events}=await publicRead(`/issues/${number}/timeline?per_page=100`,fetcher,now);
 // A partial page cannot prove uniqueness. Leave the durable phase unchanged
 // for operator reconciliation instead of following arbitrary pagination URLs.
 requireThat(!response.headers.get("link")&&Array.isArray(events)&&events.length<=100&&events.every(e=>e&&typeof e==="object"&&!Array.isArray(e)),"Incomplete merge timeline; reconcile first");
 const merged=events.filter(e=>e.event==="merged");
 requireThat(merged.length===1,"Missing or ambiguous merge event");
 const event=merged[0];
 requireThat(Number.isSafeInteger(event.id)&&event.id>0&&typeof event.commit_id==="string"&&SHA.test(event.commit_id)&&event.commit_url===`${origin}/commits/${event.commit_id}`&&event.created_at===pr.merged_at&&event.actor?.id===pr.merged_by.id,"Merge event identity mismatch");
 requireThat(pr.merge_commit_sha==null||pr.merge_commit_sha===event.commit_id,"Conflicting merge commit evidence");
 return event.commit_id;
}
