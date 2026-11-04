import {validateRasters} from "./rasters.mjs";
import {pathToFileURL} from "node:url";
import {readReports,validateArchive,validateChange,json,digest,REPOSITORY} from "./archive.mjs";
import {GitHub,PREFIX,snapshot,assertReportOnly,operationError} from "./github.mjs";
const SHA=/^[a-f0-9]{40}$/;
const PR_URL=new RegExp("^https://github.com/"+REPOSITORY+"/pull/([1-9][0-9]*)$");
const transient=d=>d?.retryable===true||d?.code==="transport"||d?.code==="invalid_response";
function failure(error,stage,uncertain=false,{message,code,retryable}={}) {
 const d=error?.diagnostic;
 if(["base_snapshot","reconcile_ref","reconcile_pr"].includes(d?.stage))stage=d.stage;
 const gitRead=["base_snapshot","check_ref","check_pr","reconcile_ref","reconcile_commit"].includes(stage)&&(Number.isInteger(error?.code)||["ETIMEDOUT","ECONNRESET","ENOENT"].includes(error?.code)||error?.code===null&&error?.killed===true&&error?.signal==="SIGTERM");
 return operationError(message||"Proposal "+stage+" failed",{...d,stage,code:code||d?.code||(gitRead?"git_read_failed":"unexpected_error"),outcome:uncertain?"unknown":"not_started",retryable:retryable??(!uncertain&&(transient(d)||gitRead))});
}
function invalid(message,code="validation") {return operationError(message,{stage:"proposal_validation",code,retryable:false});}
function incomingFiles(bundle,expectedBase) {
 if(!SHA.test(expectedBase)||!(bundle instanceof Map)||!bundle.size)throw invalid("Report bundle and expected main SHA are required");
 const incoming=[...bundle].filter(([p])=>p!=="reports/index.json").sort(([a],[b])=>a.localeCompare(b));
 if(!incoming.length||incoming.some(([p,b])=>typeof p!=="string"||!Buffer.isBuffer(b)))throw invalid("Empty or invalid bundle");
 const hash=digest(Buffer.concat(incoming.flatMap(([p,b])=>[Buffer.from(p+"\0"),Buffer.from(digest(b)+"\n")])));
 const branch="report/"+expectedBase.slice(0,12)+"-"+hash.slice(0,24);
 const route=PREFIX+"/pulls?state=all&head="+encodeURIComponent(REPOSITORY.split("/")[0]+":"+branch)+"&base=main&per_page=100";
 return {incoming,branch,route,expectedBase};
}
async function prepare(api,bundle,expectedBase) {
 const plan=incomingFiles(bundle,expectedBase);
 let base;
 try {base=await snapshot(api,expectedBase);}catch(error){throw failure(error,"base_snapshot");}
 const head=new Map(base.files);
 for(const [p,b]of plan.incoming){if(base.files.has(p))throw invalid("Published paths cannot be reused","published_path");head.set(p,b);}
 let result;
 try {
  head.set("reports/index.json",Buffer.from(json(validateArchive(head,{checkIndex:false}).index)));
  result=validateChange(base.files,head);await validateRasters(head);
 }catch {throw invalid("Report validation failed: unexpected path, invalid content or raster");}
 return {...plan,base,head,result};
}
async function exactCommit(api,plan,sha) {
 if(!SHA.test(sha||""))throw invalid("Existing branch or PR has invalid commit","identity_conflict");
 const previous=await snapshot(api,sha);
 if(previous.commit.parents.length!==1||previous.commit.parents[0].sha!==plan.expectedBase||previous.files.size!==plan.head.size||[...plan.head].some(([p,b])=>!previous.files.get(p)?.equals(b)))throw invalid("Existing branch differs; reconcile manually","identity_conflict");
 try {assertReportOnly(plan.base,previous);}catch {throw invalid("Existing branch changes non-report files","identity_conflict");}
 return sha;
}
function exactPR(pr,plan,sha) {
 const match=PR_URL.exec(pr?.html_url||"");
 if(!match||Number(match[1])!==pr.number||pr.head?.sha!==sha||pr.head?.ref!==plan.branch||pr.head?.repo?.full_name!==REPOSITORY||pr.base?.ref!=="main"||pr.base?.repo?.full_name!==REPOSITORY)throw invalid("Existing PR identity differs","identity_conflict");
 if(pr.state!=="open"&&!pr.merged_at)throw invalid("Previous PR closed; do not reopen automatically","pr_closed");
 if(!["open","closed"].includes(pr.state)||pr.merged_at&&pr.state!=="closed")throw invalid("Existing PR state differs","identity_conflict");
 return {url:pr.html_url,sha,reused:true,merged:!!pr.merged_at};
}
async function pulls(api,plan) {
 const found=await api.request("GET",plan.route,undefined,{requireSinglePage:true});
 if(!Array.isArray(found)||found.length>1)throw invalid("Ambiguous existing PR","identity_conflict");
 return found;
}
// Only repository reads, including when main moved or a merged branch vanished.
export async function reconcileProposal(api,bundle,expectedBase) {
 let plan,stage="reconcile_prepare";
 try {
  plan=await prepare(api,bundle,expectedBase);
  stage="reconcile_ref";const ref=await api.request("GET",PREFIX+"/git/ref/heads/"+plan.branch);
  stage="reconcile_pulls";const found=await pulls(api,plan);
  if(found.length){
   stage="reconcile_commit";const sha=await exactCommit(api,plan,found[0].head?.sha);
   if(ref&&ref.object?.sha!==sha)throw invalid("Existing branch and PR differ","identity_conflict");
   return {outcome:"published",branch:plan.branch,...exactPR(found[0],plan,sha)};
  }
  let sha;
  if(ref){stage="reconcile_commit";sha=await exactCommit(api,plan,ref.object?.sha);}
  stage="reconcile_main";const main=await api.request("GET",PREFIX+"/git/ref/heads/main");
  if(main?.object?.sha!==expectedBase)return {outcome:"blocked",branch:plan.branch,reason:"main_moved"};
  return {outcome:ref?"branch_only":"absent",branch:plan.branch,...(sha?{sha}:{})};
 }catch(error){
  if(["identity_conflict","pr_closed","published_path","validation"].includes(error?.diagnostic?.code))return {outcome:"blocked",...(plan?{branch:plan.branch}:{}),reason:error.diagnostic.code};
  throw failure(error,stage,false);
 }
}
export async function propose(api,bundle,expectedBase,{ready=false}={}) {
 let stage="proposal_validation",uncertain=false;
 try {
  incomingFiles(bundle,expectedBase);
  stage="read_main";const main=await api.request("GET",PREFIX+"/git/ref/heads/main");
  if(main?.object?.sha!==expectedBase)throw invalid("Main moved; rebuild against the new base","main_moved");
  stage="prepare";const plan=await prepare(api,bundle,expectedBase),{incoming,branch,head,base,result}=plan;
  stage="read_ref";const ref=await api.request("GET",PREFIX+"/git/ref/heads/"+branch);let commit;
 if(ref){stage="check_ref";commit=await exactCommit(api,plan,ref.object?.sha);}
  // A merged PR may outlive its branch. Do not recreate either before checking.
  stage="read_pulls";const existing=await pulls(api,plan);
  if(existing.length){
   stage="check_pr";const sha=await exactCommit(api,plan,existing[0].head?.sha);
   if(commit&&sha!==commit)throw invalid("Existing branch and PR differ","identity_conflict");
   return exactPR(existing[0],plan,sha);
  }
  if(!ref){
   const tree=[];
   for(const [p,b]of [...incoming,["reports/index.json",head.get("reports/index.json")]]) {
    stage="create_blob";const blob=await api.request("POST",PREFIX+"/git/blobs",{content:b.toString("base64"),encoding:"base64"});
    if(!SHA.test(blob?.sha||""))throw invalid("Invalid Git blob response","invalid_response");
    tree.push({path:p,mode:"100644",type:"blob",sha:blob.sha});
   }
   stage="create_tree";const newTree=await api.request("POST",PREFIX+"/git/trees",{base_tree:base.commit.tree.sha,tree});
   if(!SHA.test(newTree?.sha||""))throw invalid("Invalid Git tree response","invalid_response");
   const edition=result.reports.find(r=>incoming.some(([p])=>p===r.path+"report.json"));
   stage="create_commit";const created=await api.request("POST",PREFIX+"/git/commits",{message:"docs(report): "+edition.date+" r"+edition.revision,tree:newTree.sha,parents:[expectedBase]});
   if(!SHA.test(created?.sha||""))throw invalid("Invalid Git commit response","invalid_response");
   commit=created.sha;
   stage="check_main";if((await api.request("GET",PREFIX+"/git/ref/heads/main"))?.object?.sha!==expectedBase)throw invalid("Main moved before branch creation; no ref written","main_moved");
   stage="create_ref";
   try {await api.request("POST",PREFIX+"/git/refs",{ref:"refs/heads/"+branch,sha:commit});}
   catch(error){
    uncertain=error?.diagnostic?.outcome!=="rejected";
    if(!uncertain&&![409,422].includes(error.diagnostic.http_status))throw error;
    let actual;
    try {actual=await api.request("GET",PREFIX+"/git/ref/heads/"+branch);}catch(readError){throw failure(readError,"reconcile_ref",uncertain);}
    if(!actual)throw error;
    stage="reconcile_ref";commit=await exactCommit(api,plan,actual.object?.sha);uncertain=false;
   }
  }
  stage="check_pulls";const found=await pulls(api,plan);
  if(found.length)return exactPR(found[0],plan,commit);
  stage="check_main";if((await api.request("GET",PREFIX+"/git/ref/heads/main"))?.object?.sha!==expectedBase)throw invalid("Main moved before PR creation","main_moved");
  stage="create_pr";let pr;uncertain=true;
  try {pr=await api.request("POST",PREFIX+"/pulls",{title:"docs(report): "+incoming[0][0].split("/").slice(1,3).join(" "),head:branch,base:"main",draft:!ready,body:"Report, articles, images and deduplication index are bound to the same validated commit: "+commit});}
  catch(error){
   uncertain=error?.diagnostic?.outcome!=="rejected";
   if(!uncertain&&![409,422].includes(error.diagnostic.http_status))throw error;
   let actual;
   try {actual=await pulls(api,plan);}catch(readError){throw failure(readError,"reconcile_pr",uncertain);}
   if(actual.length!==1)throw error;
   pr=actual[0];
  }
  stage="check_pr";const checked=exactPR(pr,plan,commit);uncertain=false;return {...checked,reused:false};
 }catch(error){
  throw failure(error,stage,uncertain,{message:error?.diagnostic?.stage==="proposal_validation"?error.message:undefined});
 }
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 const [bundle,base,...flags]=process.argv.slice(2);if(!bundle||!base||flags.some(f=>f!=="--ready"))throw Error("Usage: node scripts/propose.mjs BUNDLE_ROOT EXPECTED_MAIN_SHA [--ready]");
 const api=new GitHub(process.env.REPORT_APP_TOKEN);
 try {console.log(JSON.stringify(await propose(api,await readReports(bundle),base,{ready:flags.includes("--ready")})));} finally {await api.close();}
}
