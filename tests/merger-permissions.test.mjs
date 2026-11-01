import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {mergeReport} from "../scripts/merge-report.mjs";
import {mergerPolicy} from "../scripts/rules.mjs";
import {CODEOWNERS} from "../scripts/codeowners.mjs";
import {REPOSITORY,readReports,json,validateArchive,digest} from "../scripts/archive.mjs";
import {PREFIX} from "../scripts/github.mjs";
import {sets} from "./helpers/policy.mjs";

const main="a".repeat(40),head="b".repeat(40);
const empty=new Map([["reports/index.json",Buffer.from(json({schema_version:"1.0",reports:[],entries:[]}))]]);
const report=new Map([...await readReports("tests/fixtures/archive")].filter(([p])=>p.startsWith("reports/2026-10-31/")));
report.set("reports/index.json",Buffer.from(json(validateArchive(report,{checkIndex:false}).index)));

function mergerFixture(){
 const rules=sets(),calls=[],blobs=new Map();
 const trees=[empty,report].map(files=>[...files].map(([path,bytes])=>{
  const sha=digest(bytes).slice(0,40);blobs.set(sha,bytes);return {path,sha,size:bytes.length,type:"blob",mode:"100644"};
 }));
 const pr={number:1,state:"open",draft:false,merged:false,base:{sha:main,ref:"main",repo:{full_name:REPOSITORY}},head:{sha:head,ref:"report/"+main.slice(0,12)+"-"+"c".repeat(24),repo:{full_name:REPOSITORY}},user:{type:"Bot",id:17,login:"reports-example[bot]"},commits:1,mergeable:true,mergeable_state:"clean"};
 const run={workflow_id:7,check_suite_id:42,event:"pull_request",conclusion:"success",status:"completed",head_sha:head,head_repository:{full_name:REPOSITORY},pull_requests:[{number:1,base:{ref:"main",sha:main},head:{sha:head}}]};
 const options={enabled:true,botId:17,botLogin:pr.user.login,trustedSha:main,policy:mergerPolicy(...rules,99,101,102),producerAppId:101,mergerAppId:102};
 const api={calls,contents:"write",readBlobs:async()=>blobs,request:async(method,route,body)=>{
  calls.push({method,route,body});const path=route.slice(PREFIX.length);
  // GitHub's merge endpoint needs Contents write; all other PR operations are read-only.
  if(method!=="GET"){
   assert.equal(method,"PUT");assert.equal(path,"/pulls/1/merge");
   if(api.contents!=="write")throw Error("Contents write required");
   assert.deepEqual(body,{sha:head,merge_method:"squash",commit_title:"docs(report): publish validated report"});
   return {merged:true,sha:"f".repeat(40)};
  }
  if(path==="/actions/runs/3")return run;
  if(path==="/actions/workflows/validate.yml")return {id:7,path:".github/workflows/validate.yml"};
  if(path==="/pulls/1")return pr;
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
 for(const kind of ["fork","branch","head","final-author"]){
  const {api,options,pr,run}=mergerFixture(),request=api.request;let reads=0;
  if(kind==="fork")pr.head.repo.full_name="elsewhere/reports";
  if(kind==="branch")pr.head.ref="fix/engineering-change";
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
 const granted=Object.fromEntries([...workflow.matchAll(/^\s+permission-([a-z-]+): (read|write)\s*$/gm)].map(m=>[m[1],m[2]]));
 assert.deepEqual(granted,{contents:"write","pull-requests":"read",actions:"read",checks:"read"});
});

test("full merger validation reads PR metadata and performs exactly one SHA-conditional merge",async()=>{
 const {api,options}=mergerFixture(),result=await mergeReport(api,3,options);
 assert.equal(result.merged,true);assert.equal(result.sha,"f".repeat(40));
 assert.equal(api.calls.filter(c=>c.route.endsWith("/pulls/1")&&c.method==="GET").length,2);
 assert.equal(api.calls.filter(c=>c.method!=="GET").length,1);
 for(const id of [1,2,3,4,5,6])assert.equal(api.calls.filter(c=>c.method==="GET"&&c.route.endsWith("/rulesets/"+id)).length,2);
});

test("creation drift at initial validation or final recheck blocks the sole merge write",async()=>{
 for(const id of [5,6])for(const phase of [1,2]){
  const {api,options,rules}=mergerFixture(),request=api.request;let reads=0;
  api.request=async(method,route,body)=>{if(method==="GET"&&route.endsWith("/rulesets/"+id)&&++reads===phase)rules[id-1].updated_at="2026-10-30T00:00:01Z";return request(method,route,body);};
  await assert.rejects(()=>mergeReport(api,3,options),/changed/);assert.equal(reads,phase);assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("blocked review or failed CI cannot use the creation policy to authorize a merge",async()=>{
 for(const kind of ["review","CI"]){
  const {api,options}=mergerFixture(),request=api.request;
  api.request=async(method,route,body)=>{const value=await request(method,route,body);if(kind==="review"&&route.endsWith("/pulls/1"))return {...value,mergeable_state:"blocked"};if(kind==="CI"&&route.endsWith("/actions/runs/3"))return {...value,conclusion:"failure"};return value;};
  await assert.rejects(()=>mergeReport(api,3,options),kind==="review"?/mergeability/:/Exact-head/);assert(!api.calls.some(c=>c.method!=="GET"));
 }
});

test("read-only Contents cannot merge and missing deletion protection blocks before any write",async()=>{
 const readOnly=mergerFixture();readOnly.api.contents="read";
 await assert.rejects(()=>mergeReport(readOnly.api,3,readOnly.options),/Contents write/);
 const unsafe=mergerFixture();unsafe.options.policy.rulesets[1].rules=unsafe.options.policy.rulesets[1].rules.filter(r=>r.type!=="deletion");
 await assert.rejects(()=>mergeReport(unsafe.api,3,unsafe.options),/updates and deletion/);
 assert(!unsafe.api.calls.some(c=>c.method!=="GET"));
});
