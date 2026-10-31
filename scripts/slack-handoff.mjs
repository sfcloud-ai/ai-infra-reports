import {REPOSITORY} from "./archive.mjs";
import {requireThat,boundedBytes,MAX_BUNDLE} from "./report-handoff.mjs";
export class SlackHandoff{
 constructor(config,token,fetcher=fetch){this.config=config;this.token=token;this.fetcher=fetcher;}
 async call(method,params={},write=false){
  const url=new URL("https://slack.com/api/"+method);
  if(!write)for(const [k,v]of Object.entries(params))url.searchParams.set(k,String(v));
  const response=await this.fetcher(url.href,{method:write?"POST":"GET",headers:{authorization:"Bearer "+this.token,"content-type":"application/json; charset=utf-8"},body:write?JSON.stringify(params):undefined,redirect:"error",signal:AbortSignal.timeout(30000)});
  // No retries here: the runner is invoked at most once per two minutes; writes
  // have durable unknown states. A rate limit stops this invocation.
  const data=JSON.parse((await boundedBytes(response,1024*1024)).toString("utf8"));
  requireThat(data.ok===true,"Slack operation failed; reconcile writes before retrying");
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
  const {data}=await this.call("conversations.history",{channel:this.config.channel_id,oldest:(now/1000-15*60).toFixed(6),limit:15});
  requireThat(Array.isArray(data.messages)&&!data.has_more&&!data.response_metadata?.next_cursor,"Incomplete control history; inspect backlog before continuing");
  return data.messages.slice().reverse();
 }
 async download(event){
  const {data:{file:f}}=await this.call("files.info",{file:event.file_id});
  requireThat(f?.id===event.file_id&&f.user===this.config.sender_user_id&&f.name==="ai-brief-bundle.json"&&f.mode==="hosted"&&!f.is_external&&Number.isSafeInteger(f.size)&&f.size>0&&f.size<=MAX_BUNDLE,"Unexpected Slack file metadata");
  requireThat(f.shares?.private?.[this.config.channel_id]?.some(s=>s.ts===event.source_ts),"File is not shared in the command message");
  const url=new URL(f.url_private_download);
  requireThat(url.protocol==="https:"&&url.hostname==="files.slack.com"&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname.startsWith(`/files-pri/${this.config.team_id}-${event.file_id}/`),"Unexpected Slack download origin/path");
  const bytes=await boundedBytes(await this.fetcher(url.href,{headers:{authorization:"Bearer "+this.token},redirect:"error",signal:AbortSignal.timeout(30000)}),MAX_BUNDLE);
  requireThat(bytes.length===f.size,"Slack file size mismatch");return bytes;
 }
 async receipt(thread,proof){
  const text="!ai-report receipt "+JSON.stringify(proof);
  const {data}=await this.call("chat.postMessage",{channel:this.config.channel_id,thread_ts:thread,text,parse:"none",mrkdwn:false,unfurl_links:false,unfurl_media:false},true);
  requireThat(data.channel===this.config.channel_id&&data.message?.thread_ts===thread&&data.message?.bot_id===this.config.bot_id&&data.message?.user===this.config.bot_user_id&&data.message?.text===text,"Slack receipt identity mismatch");
  return data.ts;
 }
}
// Public reads only. No long-lived token is minted while waiting for a merge.
export async function publicGitHub(route,fetcher=fetch){
 requireThat(/^\/(pulls\/[1-9]\d*|git\/commits\/[a-f0-9]{40})$/.test(route),"GitHub read route");
 const response=await fetcher("https://api.github.com/repos/"+REPOSITORY+route,{headers:{accept:"application/vnd.github+json","x-github-api-version":"2026-03-10"},redirect:"error",signal:AbortSignal.timeout(30000)});
 return JSON.parse((await boundedBytes(response,2*1024*1024)).toString("utf8"));
}
