import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {mergeReport} from "../scripts/merge-report.mjs";
import {mergerPolicy} from "../scripts/rules.mjs";
import {CODEOWNERS} from "../scripts/codeowners.mjs";
import {REPOSITORY,readReports,json,validateArchive,digest} from "../scripts/archive.mjs";
import {GitHub,PREFIX} from "../scripts/github.mjs";
import {sets} from "./helpers/policy.mjs";

const main="a".repeat(40),head="b".repeat(40);
const review=(id,state,second=id)=>({id,state,user:{id:4,login:"reviewer"},submitted_at:`2026-10-31T00:00:${String(second).padStart(2,"0")}Z`});
const empty=new Map([["reports/index.json",Buffer.from(json({schema_version:"1.0",reports:[],entries:[]}))]]);
const report=new Map([...await readReports("tests/fixtures/archive")].filter(([p])=>p.startsWith("reports/2026-10-31/")));
report.set("reports/index.json",Buffer.from(json(validateArchive(report,{checkIndex:false}).index)));

function mergerFixture(){
 const rules=sets(),calls=[],blobs=new Map();
 const trees=[empty,report].map(files=>[...files].map(([path,bytes])=>{
  const sha=digest(bytes).slice(0,40);blobs.set(sha,bytes);return {path,sha,size:bytes.length,type:"blob",mode:"100644"};
 }));
 const pr={number:1,state:"open",draft:false,merged:false,base:{sha:main,ref:"main",repo:{full_name:REPOSITORY}},head:{sha:head,ref:"report/"+main.slice(0,12)+"-"+"c".repeat(24),repo:{full_name:REPOSITORY}},user:{type:"Bot",id:17,login:"reports-example[bot]"},commits:1,mergeable:true,mergeable_state:"clean"};
 const run={workflow_id:7,check_suite_id:42,event:"pull_request",conclusion:"success",status:"completed",head_branch:pr.head.ref,head_sha:head,head_repository:{full_name:REPOSITORY},pull_requests:[{number:1,base:{ref:"main",sha:main},head:{sha:head}}]};
 const options={enabled:true,botId:17,botLogin:pr.user.login,trustedSha:main,policy:mergerPolicy(...rules,99,101,102),producerAppId:101,mergerAppId:102};
 const api={calls,contents:"write",blobReads:[],readBlobs:async sha=>{api.blobReads.push(sha);return blobs;},request:async(method,route,body,requestOptions)=>{
  calls.push({method,route,body,...(requestOptions?{requestOptions}:{})});const path=route.slice(PREFIX.length);
  // GitHub's merge endpoint needs Contents write; all other PR operations are read-only.
  if(method!=="GET"){
   assert.equal(method,"PUT");assert.equal(path,"/pulls/1/merge");
   if(api.contents!=="write")throw Error("Contents write required");
   assert.deepEqual(body,{sha:head,merge_method:"squash",commit_title:"docs(report): publish validated report"});
   return {merged:true,sha:"f".repeat(40)};
  }
  if(path==="/actions/runs/3")return run;
  if(path===`/commits/${head}/pulls?per_page=100`)return Object.hasOwn(api,"commitPulls")?api.commitPulls:[];
  if(path==="/actions/workflows/validate.yml")return {id:7,path:".github/workflows/validate.yml"};
  if(path==="/pulls/1")return pr;
  if(path==="/pulls/1/reviews?per_page=100")return [];
  if(path==="/collaborators/reviewer/permission")return {user:{id:4},permission:api.reviewPermission??"write"};
  if(path==="/git/ref/heads/main")return {object:{sha:main}};
  if(path==="/contents/.github/CODEOWNERS?ref="+main)return {type:"file",encoding:"base64",content:Buffer.from(CODEOWNERS).toString("base64")};
  if(path==="/codeowners/errors?ref="+main)return {errors:[]};
  if(path==="/check-suites/42")return {app:{id:99,slug:"github-actions"}};
  if(path.startsWith("/rulesets/"))return rules[Number(path.split("/").at(-1))-1];
  if(path.startsWith("/git/commits/")){const sha=path.split("/").at(-1);return {sha,tree:{sha:sha===main?"c".repeat(40):"d".repeat(40)},parents:sha===main?[]:[{sha:main}]};}
  if(path.startsWith("/git/trees/"))return {truncated:false,tree:trees[path.includes("c".repeat(40))?0:1]};
  throw Error("Unexpected API request "+method+" "+path);
 }};
 return {api,options,rules,pr,run};
}

test("engineering runs without PR associations stop after the read-only branch check",async()=>{
 for(const head_branch of ["fix/engineering-change","feature/new-view","reports/not-a-producer-branch"]){
  const {api,options,run}=mergerFixture();run.head_branch=head_branch;run.pull_requests=[];
  // The run actor is not the PR author and is irrelevant to branch routing.
  run.actor={type:"Bot",id:17,login:options.botLogin};
  assert.deepEqual(await mergeReport(api,3,options),{merged:false,reason:"non_report_branch"});
  assert.deepEqual(api.calls,[{method:"GET",route:PREFIX+"/actions/runs/3",body:undefined}]);
 }
});

test("report runs retain strict association checks, including malformed report branches",async()=>{
 for(const head_branch of ["report/"+main.slice(0,12)+"-"+"c".repeat(24),"report/malformed"]){
  for(const associations of [null,undefined,{}, {length:1,0:{number:1}},[{number:1},{number:2}]]){
   const {api,options,run}=mergerFixture();run.head_branch=head_branch;run.pull_requests=associations;
   run.actor={type:"User",id:99,login:"maintainer"};
   await assert.rejects(()=>mergeReport(api,3,options),/One associated PR required/);
   assert.equal(api.calls.length,1);assert(api.calls.every(c=>c.method==="GET"));
  }
 }
});

function lateFixture({producer=false,merged=true,state=merged?"closed":"open"}={}){
 const f=mergerFixture();f.run.pull_requests=[];
 Object.assign(f.pr,{state,merged,merged_at:merged?"2026-11-03T10:04:41Z":null,merge_commit_sha:merged?"f".repeat(40):null});
 if(!producer)f.pr.user={type:"User",id:99,login:"maintainer"};
 // The commit association endpoint does not provide the full PR's merged flag.
 const candidate=structuredClone(f.pr);delete candidate.merged;delete candidate.merge_commit_sha;
 f.api.commitPulls=[candidate];return {...f,candidate};
}
function assertReadOnly(api){assert(api.calls.every(c=>c.method==="GET"));assert.deepEqual(api.blobReads,[]);}

test("late empty association resolves an already merged exact-head PR without merging again",async()=>{
 for(const producer of [false,true]){
  const {api,options,run}=lateFixture({producer});
  options.trustedSha="e".repeat(40); // Main advanced after the completed validation.
  run.actor={type:producer?"User":"Bot",id:producer?99:17,login:producer?"maintainer":options.botLogin};
  const before=structuredClone(run);
  assert.deepEqual(await mergeReport(api,3,options),{merged:false,reason:"already_merged_pr",number:1});
  assert.deepEqual(run,before);assertReadOnly(api);
  assert.deepEqual(api.calls.map(c=>c.route),["/actions/runs/3","/actions/workflows/validate.yml",`/commits/${head}/pulls?per_page=100`,"/pulls/1"].map(p=>PREFIX+p));
  assert.deepEqual(api.calls[2].requestOptions,{requireSinglePage:true});
 }
});

test("late empty association resolves non-Producer authors only from fresh bound PR facts",async()=>{
 for(const state of ["open","closed"])for(const type of ["User","Bot"]){
  const {api,options,pr,candidate,run}=lateFixture({merged:false,state});
  pr.user.type=candidate.user.type=type;run.actor={type:"Bot",id:17,login:options.botLogin};
  assert.deepEqual(await mergeReport(api,3,options),{merged:false,reason:"non_producer_pr",number:1});
  assertReadOnly(api);assert.deepEqual(run.pull_requests,[]);
 }
});

test("late no-op accepts confirmed terminal state without an optional merge commit SHA",async()=>{
 const {api,options,pr}=lateFixture();delete pr.merge_commit_sha;
 assert.deepEqual(await mergeReport(api,3,options),{merged:false,reason:"already_merged_pr",number:1});
 assertReadOnly(api);
});

test("late empty association never repairs an active or unmerged Producer merge gate",async()=>{
 for(const state of ["open","closed"]){
  const {api,options,run}=lateFixture({producer:true,merged:false,state});
  await assert.rejects(()=>mergeReport(api,3,options),/One associated PR required/);
  assertReadOnly(api);assert.deepEqual(run.pull_requests,[]);
 }
});

test("late empty association requires one complete candidate and never filters ambiguity away",async()=>{
 for(const value of [null,undefined,{},[],[{}],[null],[{number:0}],[{number:"1"}],"1",Array(100).fill({number:1})]){
  const {api,options}=lateFixture();api.commitPulls=value;
  await assert.rejects(()=>mergeReport(api,3,options));assertReadOnly(api);
  assert(!api.calls.some(c=>c.route.endsWith("/pulls/1")));
 }
 for(const duplicate of [true,false]){
  const {api,options,candidate}=lateFixture();api.commitPulls.push({...candidate,number:duplicate?1:2});
  await assert.rejects(()=>mergeReport(api,3,options),/One complete commit-associated PR required/);assertReadOnly(api);
 }
});

test("late empty association requires exact trusted workflow and run evidence before discovery",async()=>{
 for(const patch of [
  {head_sha:null},{head_sha:main},{head_sha:"not-a-sha"},{head_branch:"report/malformed"},
  {head_repository:null},{head_repository:{full_name:"other/repo"}},
  {event:"push"},{status:"in_progress"},{conclusion:"failure"},{workflow_id:8},{workflow_id:null}
 ]){
  const {api,options,run}=lateFixture();Object.assign(run,patch);
  await assert.rejects(()=>mergeReport(api,3,options));assertReadOnly(api);
 }
 for(const workflow of [null,{id:7,path:".github/workflows/other.yml"},{id:null,path:".github/workflows/validate.yml"}]){
  const {api,options}=lateFixture(),request=api.request;
  api.request=async(...args)=>{const value=await request(...args);return args[1].endsWith("/actions/workflows/validate.yml")?workflow:value;};
  await assert.rejects(()=>mergeReport(api,3,options),/trusted CI/);assertReadOnly(api);
 }
});

test("late empty association checks candidate and fresh PR head, base and repository binding",async()=>{
 const changes=[
  p=>p.number=2,p=>p.head=null,p=>p.head.sha=main,p=>p.head.ref="report/other",
  p=>p.head.repo=null,p=>p.head.repo.full_name="other/repo",p=>p.base=null,
  p=>p.base.ref="other",p=>p.base.sha=null,p=>p.base.repo=null,p=>p.base.repo.full_name="other/repo"
 ];
 for(const which of ["candidate","pr"])for(const change of changes){
  const f=lateFixture();change(f[which]);
  await assert.rejects(()=>mergeReport(f.api,3,f.options));assertReadOnly(f.api);
 }
 const f=lateFixture();f.pr.base.sha="e".repeat(40);
 await assert.rejects(()=>mergeReport(f.api,3,f.options),/binding/);assertReadOnly(f.api);
});

test("late empty association rejects missing, partial or changed author identity even after merge",async()=>{
 for(const which of ["candidate","pr"])for(const user of [
  null,{type:"User",login:"maintainer"},{type:"User",id:99},{type:"Unknown",id:99,login:"maintainer"},
  {type:"Bot",id:18,login:"reports-example[bot]"},{type:"Bot",id:17,login:"other[bot]"},
  {type:"User",id:17,login:"reports-example[bot]"},{type:"User",id:100,login:"another"}
 ]){
  const f=lateFixture();f[which].user=user;
  await assert.rejects(()=>mergeReport(f.api,3,f.options),/author/);assertReadOnly(f.api);
 }
});

test("late empty association needs explicit consistent fresh state and merge evidence",async()=>{
 for(const producer of [false,true])for(const patch of [
  {state:null},{state:"open"},{merged:null},{merged:undefined},{merged:"true"},
  {merged_at:null},{merged_at:undefined},{merged_at:42},{merged_at:"1"},{merged_at:"invalid"},
  {merged:false},{merged:false,merged_at:undefined}
 ]){
  const {api,options,pr}=lateFixture({producer});Object.assign(pr,patch);
  await assert.rejects(()=>mergeReport(api,3,options),/state|merge evidence/);assertReadOnly(api);
 }
});

test("late empty association transport rejects every pagination marker even on a short page",async t=>{
 for(const link of [null,'<https://api.github.com/next>; rel="next"','<https://api.github.com/last>; rel="last"',""]){
  const {api:fixture,options}=lateFixture(),client=new GitHub("fixture-token");
  const mocked=t.mock.method(globalThis,"fetch",async(url,request)=>{
   assert.equal(request.method,"GET");assert.equal(request.headers.authorization,"Bearer fixture-token");
   assert(url.startsWith("https://api.github.com"+PREFIX+"/"));
   const route=url.slice("https://api.github.com".length),value=await fixture.request("GET",route);
   return new Response(JSON.stringify(value),{headers:route.includes("/commits/")&&link!==null?{link}:{}});
  });
  try{
   if(link===null)assert.deepEqual(await mergeReport(client,3,options),{merged:false,reason:"already_merged_pr",number:1});
   else await assert.rejects(()=>mergeReport(client,3,options),/Complete single-page response required/);
   assertReadOnly(fixture);
  }finally{mocked.mock.restore();await client.close();}
 }
});

test("late empty association lookup failures stay errors without any merge attempt",async()=>{
 for(const suffix of ["/actions/workflows/validate.yml",`/commits/${head}/pulls?per_page=100`,"/pulls/1"])for(const missing of [false,true]){
  const {api,options}=lateFixture(),request=api.request;
  api.request=async(...args)=>{const value=await request(...args);if(args[1].endsWith(suffix)){if(missing)return null;throw Error("Read failed: 403");}return value;};
  await assert.rejects(()=>mergeReport(api,3,options));assertReadOnly(api);
 }
});

test("missing branch evidence cannot classify a run as unrelated",async()=>{
 for(const head_branch of [undefined,null,"",17]){
  const {api,options,run}=mergerFixture();run.head_branch=head_branch;run.pull_requests=[];
  await assert.rejects(()=>mergeReport(api,3,options),/CI head branch required/);
  assert.equal(api.calls.length,1);assert(api.calls.every(c=>c.method==="GET"));
 }
});

test("ordinary human and unrelated bot PRs are explicit read-only no-ops",async()=>{
 for(const type of ["User","Bot"])for(const reportBranch of [false,true]){
  const {api,options,pr}=mergerFixture();
  pr.user={type,id:99,login:type==="User"?"maintainer":"other-app[bot]"};
  if(!reportBranch)pr.head.ref="fix/engineering-change";
  // Main can have advanced since the workflow checkout; an unrelated PR is
  // still a no-op and must not enter report-specific quality/protection gates.
  options.trustedSha="e".repeat(40);
  assert.deepEqual(await mergeReport(api,3,options),{merged:false,reason:"non_producer_pr",number:1});
  assert.deepEqual(api.calls,[{method:"GET",route:PREFIX+"/actions/runs/3",body:undefined},{method:"GET",route:PREFIX+"/pulls/1",body:undefined}]);
 }
});

test("partial Producer matches and missing author facts fail closed without writes",async()=>{
 for(const user of [
  {type:"Bot",id:18,login:"reports-example[bot]"},
  {type:"Bot",id:17,login:"other-app[bot]"},
  {type:"User",id:17,login:"reports-example[bot]"},
  null,{type:"Bot",login:"other-app[bot]"},{type:"Bot",id:18},
  {type:"Unknown",id:18,login:"other-app[bot]"}
 ]){
  const {api,options,pr}=mergerFixture();pr.user=user;
  await assert.rejects(()=>mergeReport(api,3,options),/author/);
  assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("invalid pinned identity cannot silently skip ordinary PRs",async()=>{
 for(const identity of [{botId:0},{botId:NaN},{botLogin:""},{botLogin:17},{botLogin:"maintainer"}]){
  const {api,options,pr}=mergerFixture();pr.user={type:"User",id:99,login:"maintainer"};
  await assert.rejects(()=>mergeReport(api,3,{...options,...identity}),/Pinned App bot identity/);
  assert.equal(api.calls.length,0);
 }
});

test("Producer routing ignores the CI rerun actor and keeps the exact merge gate",async()=>{
 const {api,options,run}=mergerFixture();run.actor={type:"User",id:99,login:"maintainer"};
 assert.equal((await mergeReport(api,3,options)).merged,true);
 assert.equal(api.calls.filter(c=>c.method!=="GET").length,1);
});

test("Producer origin, branch, head and final author changes remain errors",async()=>{
 for(const kind of ["fork","branch","run-branch","head","final-author"]){
  const {api,options,pr,run}=mergerFixture(),request=api.request;let reads=0;
  if(kind==="fork")pr.head.repo.full_name="elsewhere/reports";
  if(kind==="branch")pr.head.ref="fix/engineering-change";
  if(kind==="run-branch")run.head_branch="report/"+"d".repeat(12)+"-"+"e".repeat(24);
  if(kind==="head")run.head_sha=main;
  api.request=async(method,route,body)=>{
   const value=await request(method,route,body);
   if(route.endsWith("/pulls/1")&&++reads===2&&kind==="final-author")return {...value,user:{type:"User",id:99,login:"maintainer"}};
   return value;
  };
  await assert.rejects(()=>mergeReport(api,3,options),/mismatch|branch|Exact-head|Untrusted author/);
  assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("workflow requests PR read while preserving the separate merger permissions",async()=>{
 const workflow=await readFile(".github/workflows/merge-report.yml","utf8");
 const condition=workflow.match(/^    if: (.+)$/m)?.[1];
 assert.equal(condition,"vars.REPORT_AUTOMERGE_ENABLED == 'true' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request' && startsWith(github.event.workflow_run.head_branch, 'report/')");
 const granted=Object.fromEntries([...workflow.matchAll(/^\s+permission-([a-z-]+): (read|write)\s*$/gm)].map(m=>[m[1],m[2]]));
 assert.deepEqual(granted,{contents:"write","pull-requests":"read",actions:"read",checks:"read"});
});

test("full merger validation reads PR metadata and performs exactly one SHA-conditional merge",async()=>{
 const {api,options}=mergerFixture(),result=await mergeReport(api,3,options);
 assert.equal(result.merged,true);assert.equal(result.sha,"f".repeat(40));
 assert.equal(api.calls.filter(c=>c.route.endsWith("/pulls/1")&&c.method==="GET").length,2);
 assert.equal(api.calls.filter(c=>c.method!=="GET").length,1);
 for(const id of [1,2,3,4,5,6])assert.equal(api.calls.filter(c=>c.method==="GET"&&c.route.endsWith("/rulesets/"+id)).length,2);
 assert.deepEqual(api.blobReads.sort(),[main,head].sort());
 for(const suffix of ["/actions/workflows/validate.yml","/check-suites/42","/contents/.github/CODEOWNERS?ref="+main,"/codeowners/errors?ref="+main])assert.equal(api.calls.filter(c=>c.route===PREFIX+suffix).length,1);
 for(const suffix of ["/git/ref/heads/main","/pulls/1/reviews?per_page=100"])assert.equal(api.calls.filter(c=>c.route===PREFIX+suffix).length,2);
 assert.equal(api.calls.filter(c=>c.route.includes("/git/commits/")).length,2);
 assert.equal(api.calls.filter(c=>c.route.includes("/git/trees/")).length,2);
 assert(!api.calls.some(c=>c.route.includes(`/commits/${head}/pulls`)));
});

test("creation drift at initial validation or final recheck blocks the sole merge write",async()=>{
 for(const id of [5,6])for(const phase of [1,2]){
  const {api,options,rules}=mergerFixture(),request=api.request;let reads=0;
  api.request=async(method,route,body)=>{if(method==="GET"&&route.endsWith("/rulesets/"+id)&&++reads===phase)rules[id-1].updated_at="2026-10-30T00:00:01Z";return request(method,route,body);};
  await assert.rejects(()=>mergeReport(api,3,options),/changed/);assert.equal(reads,phase);assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("Request changes or failed CI cannot use a blocked update exemption to authorize a merge",async()=>{
 for(const kind of ["review","CI"]){
  const {api,options,pr}=mergerFixture(),request=api.request;pr.mergeable_state="blocked";
  api.request=async(method,route,body)=>{const value=await request(method,route,body);if(kind==="review"&&route.includes("/reviews?"))return [review(1,"CHANGES_REQUESTED")];if(kind==="CI"&&route.endsWith("/actions/runs/3"))return {...value,conclusion:"failure"};return value;};
  await assert.rejects(()=>mergeReport(api,3,options),kind==="review"?/Request changes/:/Exact-head/);assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("protected update state uses one normal merge with no admin override",async()=>{
 const {api,options,pr}=mergerFixture();pr.mergeable_state="blocked";
 assert.equal((await mergeReport(api,3,options)).merged,true);
 assert.equal(api.calls.filter(c=>c.method!=="GET").length,1);
 assert.equal(api.calls.filter(c=>c.route.includes("/reviews?")).length,2);
});

test("GitHub protection rejection is reconciled read-only and never retried or bypassed",async()=>{
 for(const status of [403,405,409]){
  const {api,options,pr}=mergerFixture(),request=api.request;pr.mergeable_state="blocked";
  api.request=async(method,route,body)=>{const result=await request(method,route,body);if(method==="PUT")throw Error("GitHub merge rejected "+status);return result;};
  await assert.rejects(()=>mergeReport(api,3,options),/GitHub merge rejected/);
  assert.equal(api.calls.filter(c=>c.method!=="GET").length,1);
  assert.equal(api.calls.at(-1).route,PREFIX+"/pulls/1");
 }
});

test("review recheck blocks new changes requests; comments do not clear a veto",async()=>{
 for(const finalOnly of [false,true]){
  const {api,options,pr}=mergerFixture(),request=api.request;pr.mergeable_state="blocked";let reads=0;
  api.request=async(method,route,body)=>{const result=await request(method,route,body);if(route.includes("/reviews?")&&++reads>Number(finalOnly))return [review(2,"COMMENTED"),review(1,"CHANGES_REQUESTED")];return result;};
  await assert.rejects(()=>mergeReport(api,3,options),/Request changes/);
  assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("the latest substantive review is used regardless of response order",async()=>{
 for(const state of ["APPROVED","DISMISSED"]){
  const {api,options,pr}=mergerFixture(),request=api.request;pr.mergeable_state="blocked";
  api.request=async(method,route,body)=>{const result=await request(method,route,body);return route.includes("/reviews?")?[review(2,state),review(1,"CHANGES_REQUESTED")]:result;};
  assert.equal((await mergeReport(api,3,options)).merged,true);
 }
});

test("only current writers veto; permission lookup failure never implies read-only",async()=>{
 for(const permission of ["write","admin","read","none","unknown"]){
  const {api,options}=mergerFixture(),request=api.request;api.reviewPermission=permission;
  api.request=async(method,route,body)=>{const result=await request(method,route,body);return route.includes("/reviews?")?[review(1,"CHANGES_REQUESTED")]:result;};
  if(["read","none"].includes(permission))assert.equal((await mergeReport(api,3,options)).merged,true);
  else{await assert.rejects(()=>mergeReport(api,3,options),/Request changes|permissions/);assert(!api.calls.some(c=>c.method!=="GET"));}
 }
 for(const evidence of [null,{permission:"read",user:{id:5}}]){
  const {api,options}=mergerFixture(),request=api.request;
  api.request=async(method,route,body)=>{const result=await request(method,route,body);return route.includes("/reviews?")?[review(1,"CHANGES_REQUESTED")]:route.endsWith("/permission")?evidence:result;};
  await assert.rejects(()=>mergeReport(api,3,options),/permissions/);assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("late draft submission and simultaneous decisions retain writer changes requests",async()=>{
 for(const second of [2,3]){
  const {api,options}=mergerFixture(),request=api.request;
  api.request=async(method,route,body)=>{const result=await request(method,route,body);return route.includes("/reviews?")?[review(1,"CHANGES_REQUESTED",second),review(2,"APPROVED",2)]:result;};
  await assert.rejects(()=>mergeReport(api,3,options),/Request changes/);assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("incomplete review evidence and quality bypass drift fail before merge",async()=>{
 for(const kind of ["missing","bounded","invalid","bypass"]){
  const {api,options,pr}=mergerFixture(),request=api.request;pr.mergeable_state="blocked";
  if(kind==="bypass")options.policy.rulesets[0].bypass_actors=[{actor_type:"Integration",actor_id:102,bypass_mode:"always"}];
  api.request=async(method,route,body)=>{const result=await request(method,route,body);if(route.includes("/reviews?"))return kind==="missing"?null:kind==="bounded"?Array(100).fill({}):[{}];return result;};
  await assert.rejects(()=>mergeReport(api,3,options),/review|no bypass/i);
  assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("read-only Contents cannot merge and missing deletion protection blocks before any write",async()=>{
 const readOnly=mergerFixture();readOnly.api.contents="read";
 await assert.rejects(()=>mergeReport(readOnly.api,3,readOnly.options),/Contents write/);
 const unsafe=mergerFixture();unsafe.options.policy.rulesets[1].rules=unsafe.options.policy.rulesets[1].rules.filter(r=>r.type!=="deletion");
 await assert.rejects(()=>mergeReport(unsafe.api,3,unsafe.options),/updates and deletion/);
 assert(!unsafe.api.calls.some(c=>c.method!=="GET"));
});
