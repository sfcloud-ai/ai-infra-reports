import {verifyCodeowners} from "./codeowners.mjs";
import {validateRasters} from "./rasters.mjs";
// Execute ONLY from the trusted default branch, never from a PR checkout.
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {GitHub,PREFIX,snapshot,assertReportOnly} from "./github.mjs";
import {verifyRules} from "./rules.mjs";
import {REPOSITORY,validateChange} from "./archive.mjs";
function requireBotIdentity(botId,botLogin){
 if(!Number.isSafeInteger(botId)||botId<=0||typeof botLogin!=="string"||!botLogin.endsWith("[bot]"))throw Error("Pinned App bot identity required");
}
function isProducer(pr,botId,botLogin){
 const user=pr?.user;
 if(!user||!Number.isSafeInteger(user.id)||user.id<=0||typeof user.login!=="string"||!user.login||!["Bot","User"].includes(user.type))throw Error("PR author identity required");
 if(user.id!==botId&&user.login!==botLogin)return false;
 // A partial identity match is suspicious, not an unrelated engineering PR.
 if(user.type!=="Bot"||user.id!==botId||user.login!==botLogin)throw Error("Untrusted author");
 return true;
}
async function missingAssociationNoop(api,run,botId,botLogin){
 if(!/^report\/[a-f0-9]{12}-[a-f0-9]{24}$/.test(run.head_branch)||typeof run.head_sha!=="string"||!/^[a-f0-9]{40}$/.test(run.head_sha))throw Error("Missing association requires exact-head trusted CI");
 const workflow=await api.request("GET",PREFIX+"/actions/workflows/validate.yml");
 if(workflow?.path!==".github/workflows/validate.yml"||!Number.isSafeInteger(workflow.id)||workflow.id<=0||run.workflow_id!==workflow.id||run.event!=="pull_request"||run.conclusion!=="success"||run.status!=="completed"||run.head_repository?.full_name!==REPOSITORY)throw Error("Missing association requires exact-head trusted CI");
 // Commit associations are discovery evidence only. A paginated or ambiguous
 // result cannot authorize a no-op, and can never repair the merge gate's run.
 const candidates=await api.request("GET",PREFIX+"/commits/"+run.head_sha+"/pulls?per_page=100",undefined,{requireSinglePage:true});
 if(!Array.isArray(candidates)||candidates.length!==1)throw Error("One complete commit-associated PR required");
 const candidate=candidates[0],number=candidate?.number;
 if(!Number.isSafeInteger(number)||number<=0)throw Error("Associated PR number required");
 const bound=p=>p?.number===number&&p.head?.sha===run.head_sha&&p.head?.ref===run.head_branch&&p.head?.repo?.full_name===REPOSITORY&&p.base?.ref==="main"&&p.base?.repo?.full_name===REPOSITORY&&typeof p.base?.sha==="string"&&/^[a-f0-9]{40}$/.test(p.base.sha);
 if(!bound(candidate))throw Error("Commit-associated PR binding mismatch");
 const pr=await api.request("GET",PREFIX+"/pulls/"+number);
 if(!bound(pr)||pr.base.sha!==candidate.base.sha)throw Error("Commit-associated PR binding mismatch");
 isProducer(candidate,botId,botLogin);
 const producer=isProducer(pr,botId,botLogin);
 if(["id","login","type"].some(key=>pr.user[key]!==candidate.user[key]))throw Error("PR author changed during lookup");
 if(!["open","closed"].includes(pr.state)||typeof pr.merged!=="boolean")throw Error("Explicit PR state required");
 if(pr.merged){
  if(pr.state!=="closed"||typeof pr.merged_at!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(pr.merged_at)||!Number.isFinite(Date.parse(pr.merged_at)))throw Error("Complete PR merge evidence required");
  // Fresh terminal state proves a no-op; no merge or merge SHA is claimed here.
  return {merged:false,reason:"already_merged_pr",number};
 }
 if(pr.merged_at!==null)throw Error("Consistent PR merge evidence required");
 if(!producer)return {merged:false,reason:"non_producer_pr",number};
 throw Error("One associated PR required for an unmerged Producer");
}
export function gateFacts({pr,run,workflow,main,botId,botLogin}) {
 requireBotIdentity(botId,botLogin);
 if(pr.state!=="open"||pr.draft||pr.merged||pr.base.ref!=="main"||pr.base.repo.full_name!==REPOSITORY||pr.head.repo.full_name!==REPOSITORY)throw Error("PR state/repository mismatch");
 if(pr.user.type!=="Bot"||pr.user.id!==botId||pr.user.login!==botLogin)throw Error("Untrusted author");
 if(!/^report\/[a-f0-9]{12}-[a-f0-9]{24}$/.test(pr.head.ref)||pr.commits!==1||pr.base.sha!==main)throw Error("Stale base or unexpected branch/history");
 // A protected-ref update restriction can report blocked even to its allowed
 // Merger. Only the SHA-conditional merge endpoint decides whether that actor
 // may merge; verified quality rules have no bypass, and remain enforced there.
 if(pr.mergeable!==true||!["clean","blocked"].includes(pr.mergeable_state))throw Error("PR mergeability is not confirmed");
 if(workflow.path!==".github/workflows/validate.yml"||run.workflow_id!==workflow.id||run.event!=="pull_request"||run.conclusion!=="success"||run.status!=="completed"||run.head_branch!==pr.head.ref||run.head_sha!==pr.head.sha||run.head_repository.full_name!==REPOSITORY)throw Error("Exact-head trusted CI required");
 if(run.pull_requests.length!==1||run.pull_requests[0].number!==pr.number||run.pull_requests[0].base?.ref!=="main"||run.pull_requests[0].base?.sha!==main||run.pull_requests[0].head?.sha!==pr.head.sha)throw Error("CI/PR association mismatch");
 return pr.head.sha;
}
async function verifyReviews(api,number){
 const reviews=await api.request("GET",PREFIX+"/pulls/"+number+"/reviews?per_page=100");
 if(!Array.isArray(reviews)||reviews.length>=100)throw Error("Complete bounded review history required");
 const latest=new Map();
 for(const review of reviews){
  if(!Number.isSafeInteger(review.id)||review.id<=0||!Number.isSafeInteger(review.user?.id)||review.user.id<=0||!["APPROVED","CHANGES_REQUESTED","DISMISSED","COMMENTED","PENDING"].includes(review.state))throw Error("Invalid review evidence");
  if(["COMMENTED","PENDING"].includes(review.state))continue;
  const at=Date.parse(review.submitted_at),previous=latest.get(review.user.id);
  if(typeof review.submitted_at!=="string"||!Number.isFinite(at)||typeof review.user.login!=="string"||!review.user.login)throw Error("Invalid submitted review evidence");
  // Draft review IDs are assigned before submission. Ambiguous simultaneous
  // decisions retain a changes request rather than accidentally clearing it.
  if(!previous||previous.at<at||(previous.at===at&&review.state==="CHANGES_REQUESTED"))latest.set(review.user.id,{...review,at});
 }
 for(const review of latest.values())if(review.state==="CHANGES_REQUESTED"){
  const access=await api.request("GET",PREFIX+"/collaborators/"+encodeURIComponent(review.user.login)+"/permission");
  if(access?.user?.id!==review.user.id||!["admin","write","read","none"].includes(access?.permission))throw Error("Reviewer permissions unconfirmed");
  if(["admin","write"].includes(access.permission))throw Error("Unresolved Request changes");
 }
}
export async function mergeReport(api,runId,{enabled,botId,botLogin,trustedSha,policy,producerAppId,mergerAppId}){
 if(enabled!==true)return {merged:false,reason:"disabled"};
 if(!Number.isSafeInteger(runId)||runId<=0||!/^[a-f0-9]{40}$/.test(trustedSha))throw Error("Trusted execution context required");
 requireBotIdentity(botId,botLogin);
 const run=await api.request("GET",PREFIX+"/actions/runs/"+runId);
 if(typeof run?.head_branch!=="string"||!run.head_branch)throw Error("CI head branch required");
 // Producer branches are report/<base>-<bundle>. Route only outside that
 // namespace; malformed report branches still face every strict merge gate.
 // Engineering workflow_run records can legitimately omit PR associations.
 if(!run.head_branch.startsWith("report/"))return {merged:false,reason:"non_report_branch"};
 if(Array.isArray(run.pull_requests)&&run.pull_requests.length===0)return missingAssociationNoop(api,run,botId,botLogin);
 if(!Array.isArray(run.pull_requests)||run.pull_requests.length!==1)throw Error("One associated PR required");
 const number=run.pull_requests[0].number;
 if(!Number.isSafeInteger(number)||number<=0)throw Error("Associated PR number required");
 const pr=await api.request("GET",PREFIX+"/pulls/"+number);
 if(pr?.number!==number)throw Error("CI/PR association mismatch");
 // workflow_run also fires for ordinary PRs. Route on fresh API author facts,
 // never on the run actor (which may be a maintainer rerunning Producer CI).
 if(!isProducer(pr,botId,botLogin))return {merged:false,reason:"non_producer_pr",number};
 const workflow=await api.request("GET",PREFIX+"/actions/workflows/validate.yml");
 const main=(await api.request("GET",PREFIX+"/git/ref/heads/main")).object.sha;
 if(main!==trustedSha)throw Error("Default branch moved since trusted checkout");
 await verifyCodeowners(api,main);
 const sha=gateFacts({pr,run,workflow,main,botId,botLogin});
 if(!Number.isSafeInteger(run.check_suite_id))throw Error("CI check suite required");
 const suite=await api.request("GET",PREFIX+"/check-suites/"+run.check_suite_id);
 if(suite?.app?.slug!=="github-actions"||!Number.isSafeInteger(suite.app.id))throw Error("Trusted Actions suite required");
 await verifyRules(api,suite.app.id,policy,{producerAppId,mergerAppId});
 await verifyReviews(api,number);
 const [base,head]=await Promise.all([snapshot(api,main),snapshot(api,sha)]);
 if(head.commit.parents.length!==1||head.commit.parents[0].sha!==main)throw Error("Head must have the validated main parent");
 assertReportOnly(base,head);validateChange(base.files,head.files);await validateRasters(head.files);
 const now=await api.request("GET",PREFIX+"/pulls/"+number);
 const latest=(await api.request("GET",PREFIX+"/git/ref/heads/main")).object.sha;
 if(latest!==main||gateFacts({pr:now,run,workflow,main:latest,botId,botLogin})!==sha)throw Error("PR/main changed during validation");
 await verifyRules(api,suite.app.id,policy,{producerAppId,mergerAppId});
 await verifyReviews(api,number);
 try {
  const result=await api.request("PUT",PREFIX+"/pulls/"+number+"/merge",{sha,merge_method:"squash",commit_title:"docs(report): publish validated report"});
  if(!result?.merged)throw Error("GitHub did not merge the PR");
  return {merged:true,sha:result.sha,number};
 } catch(error){
  const actual=await api.request("GET",PREFIX+"/pulls/"+number);
  if(actual?.merged&&actual.head.sha===sha&&actual.base.ref==="main"&&actual.base.repo.full_name===REPOSITORY)return {merged:true,sha:actual.merge_commit_sha,number,reconciled:true};
  throw error;
 }
}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href){
 const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,"utf8"));
 const api=new GitHub(process.env.REPORT_MERGER_TOKEN);
 try {console.log(JSON.stringify(await mergeReport(api,event.workflow_run.id,{enabled:process.env.REPORT_AUTOMERGE_ENABLED==="true",botId:Number(process.env.REPORT_BOT_ID),botLogin:process.env.REPORT_BOT_LOGIN,trustedSha:process.env.GITHUB_SHA,producerAppId:Number(process.env.REPORT_PRODUCER_APP_ID),mergerAppId:Number(process.env.REPORT_MERGER_APP_ID),policy:JSON.parse(await readFile(".github/report-policy.json","utf8"))})));} finally {await api.close();}
}
