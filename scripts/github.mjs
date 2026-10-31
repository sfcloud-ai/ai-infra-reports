import {GitObjects} from "./git-objects.mjs";
import {REPOSITORY} from "./archive.mjs";
export const PREFIX="/repos/"+REPOSITORY;
export class GitHub {
 constructor(token){if(!token)throw Error("A short-lived installation token is required");this.token=token;this.objects=new GitObjects();}
 async readBlobs(sha,entries){return this.objects.read(sha,entries);}
 async close(){await this.objects.close();}
 async request(method,route,body) {
  if(!route.startsWith(PREFIX+"/"))throw Error("Repository scope mismatch");
  const response=await fetch("https://api.github.com"+route,{method,headers:{accept:"application/vnd.github+json",authorization:"Bearer "+this.token,"x-github-api-version":"2026-03-10","content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:"error"});
  if(response.status===404)return null;
  if(!response.ok)throw Error("GitHub "+method+" failed: "+response.status+"; reconcile before retrying");
  return response.status===204?{}:response.json();
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
