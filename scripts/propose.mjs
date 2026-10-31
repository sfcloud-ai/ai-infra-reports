import {validateRasters} from "./rasters.mjs";
import {pathToFileURL} from "node:url";
import {readReports,validateArchive,validateChange,json,digest,REPOSITORY} from "./archive.mjs";
import {GitHub,PREFIX,snapshot,assertReportOnly} from "./github.mjs";
export async function propose(api,bundle,expectedBase,{ready=false}={}) {
 if(!/^[a-f0-9]{40}$/.test(expectedBase))throw Error("Expected main SHA is required");
 const main=await api.request("GET",PREFIX+"/git/ref/heads/main");
 if(main?.object.sha!==expectedBase)throw Error("Main moved; rebuild against the new base");
 const base=await snapshot(api,expectedBase),head=new Map(base.files);
 const incoming=[...bundle].filter(([p])=>p!=="reports/index.json").sort(([a],[b])=>a.localeCompare(b));
 if(!incoming.length)throw Error("Empty bundle");
 for(const [p,b]of incoming){if(base.files.has(p))throw Error("Published paths cannot be reused");head.set(p,b);}
 head.set("reports/index.json",Buffer.from(json(validateArchive(head,{checkIndex:false}).index)));
 const result=validateChange(base.files,head);await validateRasters(head);
 const hash=digest(Buffer.concat(incoming.flatMap(([p,b])=>[Buffer.from(p+"\0"),Buffer.from(digest(b)+"\n")])));
 const branch="report/"+expectedBase.slice(0,12)+"-"+hash.slice(0,24);
 let ref=await api.request("GET",PREFIX+"/git/ref/heads/"+branch),commit;
 async function reconcile(ref){
  const previous=await snapshot(api,ref.object.sha);
  if(previous.commit.parents.length!==1||previous.commit.parents[0].sha!==expectedBase||previous.files.size!==head.size||[...head].some(([p,b])=>!previous.files.get(p)?.equals(b)))throw Error("Existing branch differs; reconcile manually");
  assertReportOnly(base,previous);return ref.object.sha;

 }
 if(ref) {commit=await reconcile(ref); } else {
  const tree=[];
  for(const [p,b]of [...incoming,["reports/index.json",head.get("reports/index.json")]]) {
   const blob=await api.request("POST",PREFIX+"/git/blobs",{content:b.toString("base64"),encoding:"base64"});
   tree.push({path:p,mode:"100644",type:"blob",sha:blob.sha});
  }
  const newTree=await api.request("POST",PREFIX+"/git/trees",{base_tree:base.commit.tree.sha,tree});
  const edition=result.reports.find(r=>incoming.some(([p])=>p===r.path+"report.json"));
  const created=await api.request("POST",PREFIX+"/git/commits",{message:"docs(report): "+edition.date+" r"+edition.revision,tree:newTree.sha,parents:[expectedBase]});
  commit=created.sha;
  if((await api.request("GET",PREFIX+"/git/ref/heads/main")).object.sha!==expectedBase)throw Error("Main moved before branch creation; no ref written");
  try {await api.request("POST",PREFIX+"/git/refs",{ref:"refs/heads/"+branch,sha:commit});}
  catch(error){const actual=await api.request("GET",PREFIX+"/git/ref/heads/"+branch);if(!actual)throw error;commit=await reconcile(actual);}
 }
 const headName=encodeURIComponent(REPOSITORY.split("/")[0]+":"+branch);
 const route=PREFIX+"/pulls?state=all&head="+headName+"&base=main&per_page=100";
 const pulls=await api.request("GET",route);
 if(pulls?.length){
  if(pulls.length!==1||pulls[0].head.sha!==commit)throw Error("Ambiguous existing PR");
  if(pulls[0].state!=="open"&&!pulls[0].merged_at)throw Error("Previous PR closed; do not reopen automatically");
  return {url:pulls[0].html_url,sha:commit,reused:true,merged:!!pulls[0].merged_at};
 }
 let pr;
 try {pr=await api.request("POST",PREFIX+"/pulls",{title:"docs(report): "+incoming[0][0].split("/").slice(1,3).join(" "),head:branch,base:"main",draft:!ready,body:"报告、独立文章、图片与去重索引在同一提交中。自动校验不代替内容审校。精确提交："+commit});}
 catch(error){const actual=await api.request("GET",route);if(actual?.length!==1||actual[0].head.sha!==commit)throw error;pr=actual[0];}
 if(pr.state!=="open"&&!pr.merged_at)throw Error("Previous PR closed; do not reopen automatically");
 return {url:pr.html_url,sha:commit,reused:false,merged:!!pr.merged_at};
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 const [bundle,base,...flags]=process.argv.slice(2);if(!bundle||!base||flags.some(f=>f!=="--ready"))throw Error("Usage: node scripts/propose.mjs BUNDLE_ROOT EXPECTED_MAIN_SHA [--ready]");
 const api=new GitHub(process.env.REPORT_APP_TOKEN);
 try {console.log(JSON.stringify(await propose(api,await readReports(bundle),base,{ready:flags.includes("--ready")})));} finally {await api.close();}
}
