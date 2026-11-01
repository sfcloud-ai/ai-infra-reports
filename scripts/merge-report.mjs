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
export function gateFacts({pr,run,workflow,main,botId,botLogin}) {
 requireBotIdentity(botId,botLogin);
 if(pr.state!=="open"||pr.draft||pr.merged||pr.base.ref!=="main"||pr.base.repo.full_name!==REPOSITORY||pr.head.repo.full_name!==REPOSITORY)throw Error("PR state/repository mismatch");
 if(pr.user.type!=="Bot"||pr.user.id!==botId||pr.user.login!==botLogin)throw Error("Untrusted author");
 if(!/^report\/[a-f0-9]{12}-[a-f0-9]{24}$/.test(pr.head.ref)||pr.commits!==1||pr.base.sha!==main)throw Error("Stale base or unexpected branch/history");
 // A protected-ref update restriction can report blocked even to its allowed
 // Merger. Only the SHA-conditional merge endpoint decides whether that actor
 // may merge; verified quality rules have no bypass, and remain enforced there.
 if(pr.mergeable!==true||!["clean","blocked"].includes(pr.mergeable_state))throw Error("PR mergeability is not confirmed");
 if(workflow.path!==".github/workflows/validate.yml"||run.workflow_id!==workflow.id||run.event!=="pull_request"||run.conclusion!=="success"||run.status!=="completed"||run.head_sha!==pr.head.sha||run.head_repository.full_name!==REPOSITORY)throw Error("Exact-head trusted CI required");
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
 if(run?.pull_requests?.length!==1)throw Error("One associated PR required");
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
