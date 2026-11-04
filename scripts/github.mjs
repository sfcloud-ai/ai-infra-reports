import {GitObjects} from "./git-objects.mjs";
import {REPOSITORY} from "./archive.mjs";
export const PREFIX="/repos/"+REPOSITORY;
// Never retain response bodies, credentials, URLs, or arbitrary exceptions.
export function operationError(message,{stage,code,outcome="not_started",retryable=false,http_status,request_id,retry_at,provider_scope,cleanup_after}={}) {
 const error=new Error(message),diagnostic={
  stage:/^[A-Za-z0-9_.:-]{1,80}$/.test(stage||"")?stage:"unknown",
  code:/^[A-Za-z0-9_.:-]{1,80}$/.test(code||"")?code:"unknown",
  outcome:["not_started","unknown","rejected"].includes(outcome)?outcome:"unknown",retryable:retryable===true
 };
 if(Number.isInteger(http_status)&&http_status>=100&&http_status<=599)diagnostic.http_status=http_status;
 if(typeof request_id==="string"&&/^[A-Za-z0-9:_-]{1,128}$/.test(request_id))diagnostic.request_id=request_id;
 if(Number.isSafeInteger(retry_at)&&retry_at>=0&&retry_at<=8640000000000000)diagnostic.retry_at=retry_at;
 if(Number.isSafeInteger(cleanup_after)&&cleanup_after>0&&cleanup_after<=8640000000000000)diagnostic.cleanup_after=cleanup_after;
 if(['github.public','github.producer','github.app'].includes(provider_scope))diagnostic.provider_scope=provider_scope;
 error.diagnostic=diagnostic;return error;
}
async function secondaryLimit(response){
 // Inspect only the documented error discriminator, with a hard byte bound.
 // Never return, log or persist the body (which may contain private details).
 try{
  const length=response.headers?.get?.('content-length');
  if(length!=null&&(!/^\d+$/.test(length)||Number(length)>65536))return false;
  if(!response.body)return false;
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>65536)return false;chunks.push(chunk);}
  const message=JSON.parse(Buffer.concat(chunks).toString('utf8'))?.message;
  return typeof message==='string'&&/^You have exceeded a secondary rate limit\b/i.test(message);
 }catch{return false;}
}
export async function rateLimitInfo(response,now=Date.now()){
 // Absolute deadlines survive restarts. Without usable timing, a secondary
 // rate limit requires at least a minute before another request.
 const header=name=>response.headers?.get?.(name)??'',after=header('retry-after'),remaining=header('x-ratelimit-remaining'),reset=header('x-ratelimit-reset');
 const afterAt=/^\d{1,6}$/.test(after)?now+Number(after)*1000:/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(after)?Date.parse(after):NaN;
 const limited=response.status===429||response.status===403&&(remaining==='0'||Number.isFinite(afterAt)||await secondaryLimit(response));
 const deadlines=[afterAt,remaining==='0'&&/^\d{1,12}$/.test(reset)?Number(reset)*1000:NaN].filter(at=>Number.isSafeInteger(at)&&at>now&&at<=8640000000000000);
 const retry_at=deadlines.length?Math.max(...deadlines):limited?now+60000:undefined;
 return {limited,...(retry_at===undefined?{}:{retry_at})};
}
export class GitHub {
 constructor(token,{readOnly=false,fetcher,now=Date.now}={}){if(!token&&!readOnly)throw Error("A short-lived installation token is required");this.token=readOnly?undefined:token;this.readOnly=readOnly;this.fetcher=fetcher;this.now=now;this.objects=new GitObjects();}
 async readBlobs(sha,entries){return this.objects.read(sha,entries);}
 async close(){await this.objects.close();}
 async request(method,route,body,{requireSinglePage=false}={}) {
  if(!route.startsWith(PREFIX+"/"))throw Error("Repository scope mismatch");
  if(this.readOnly&&method!=="GET")throw operationError("Public reconciliation cannot write",{stage:"public_reconcile",code:"write_forbidden"});
  const read=method==="GET",stage=read?"github_read":"github_write";
  let response;
  try {response=await (this.fetcher||fetch)("https://api.github.com"+route,{method,headers:{accept:"application/vnd.github+json",...(this.token?{authorization:"Bearer "+this.token}:{}),"x-github-api-version":"2026-03-10","content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:"error"});}
  catch {throw operationError("GitHub transport failed",{stage,code:"transport",outcome:read?"not_started":"unknown",retryable:read});}
  const evidence={stage,http_status:response.status,request_id:response.headers?.get?.("x-github-request-id")};
  const {limited,retry_at}=await rateLimitInfo(response,this.now());
  if(read&&response.status===404)return null;
  if(!response.ok)throw operationError("GitHub "+method+" failed: "+response.status,{...evidence,retry_at,provider_scope:limited?(this.readOnly?'github.public':'github.producer'):undefined,code:limited?"rate_limited":"http_"+response.status,outcome:read?"not_started":response.status>=500||response.status===408?"unknown":"rejected",retryable:limited||response.status===408||response.status>=500});
  if(requireSinglePage&&response.headers.has("link"))throw operationError("Complete single-page response required",{...evidence,code:"incomplete_response",outcome:read?"not_started":"unknown"});
  try {return response.status===204?{}:await response.json();}
  catch {throw operationError("Invalid GitHub response",{...evidence,code:"invalid_response",outcome:read?"not_started":"unknown",retryable:read});}
 }
}
export async function snapshot(api,sha) {
 if(!/^[a-f0-9]{40}$/.test(sha))throw Error("Invalid commit SHA");
 const commit=await api.request("GET",PREFIX+"/git/commits/"+sha);
 if(!commit||commit.sha!==sha)throw Error("Commit not found");
 const response=await api.request("GET",PREFIX+"/git/trees/"+commit.tree.sha+"?recursive=1");
 if(!response||response.truncated||response.tree.length>100000)throw Error("Incomplete Git tree");
 const tree=new Map(response.tree.filter(e=>e.type!=="tree").map(e=>[e.path,e]));
 const entries=[...tree.values()].filter(e=>e.path.startsWith("reports/"));
 let total=0,allSize=0;
 for(const e of tree.values()) {allSize+=e.size||0;if(allSize>384*1024*1024)throw Error("Git snapshot size limit");}
 for(const e of entries){
  if(e.type!=="blob"||e.mode!=="100644"||!Number.isSafeInteger(e.size)||e.size>32*1024*1024||!/^[a-f0-9]{40}$/.test(e.sha))throw Error("Reports must be regular bounded files");
  total+=e.size;if(total>256*1024*1024)throw Error("Archive size limit");
 }
 const objects=await api.readBlobs(sha,entries),files=new Map();
 for(const e of entries){const b=objects.get(e.sha);if(!b||b.length!==e.size)throw Error("Truncated Git blob");files.set(e.path,b);}
 return {sha,commit,tree,files};
}
export function assertReportOnly(base,head) {
 for(const p of new Set([...base.tree.keys(),...head.tree.keys()])) {
  const a=base.tree.get(p),b=head.tree.get(p);
  if(a?.sha===b?.sha&&a?.mode===b?.mode&&a?.type===b?.type)continue;
  if(!p.startsWith("reports/")||!b||b.mode!=="100644"||b.type!=="blob")throw Error("Non-report path or mode changed: "+p);
 }
}
