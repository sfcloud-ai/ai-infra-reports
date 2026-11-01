import test from "node:test";
import assert from "node:assert/strict";
import {gateFacts,mergeReport} from "../scripts/merge-report.mjs";
import {assertReportOnly,snapshot,PREFIX} from "../scripts/github.mjs";
import {verifyPublication} from "../scripts/verify-publication.mjs";
import {REPOSITORY} from "../scripts/archive.mjs";
import {publicationSite} from "./helpers/publication-site.mjs";
const a="a".repeat(40),b="b".repeat(40);
function facts(){return {main:a,botId:17,botLogin:"reports-example[bot]",workflow:{id:7,path:".github/workflows/validate.yml"},pr:{number:1,state:"open",draft:false,merged:false,base:{sha:a,ref:"main",repo:{full_name:REPOSITORY}},head:{sha:b,ref:"report/"+a.slice(0,12)+"-"+"c".repeat(24),repo:{full_name:REPOSITORY}},user:{type:"Bot",id:17,login:"reports-example[bot]"},commits:1,mergeable:true,mergeable_state:"clean"},run:{workflow_id:7,event:"pull_request",conclusion:"success",status:"completed",head_sha:b,head_repository:{full_name:REPOSITORY},pull_requests:[{number:1,base:{ref:"main",sha:a},head:{sha:b}}]}};}
test("exact bot/head/base/run facts accepted",()=>assert.equal(gateFacts(facts()),b));
test("fork, spoofed identity, draft, stale head and ambiguous CI rejected",()=>{
 for(const mutate of [
 f=>f.pr.head.repo.full_name="elsewhere/reports",f=>f.pr.user.id=18,f=>f.pr.user.type="User",f=>f.pr.draft=true,
 f=>f.pr.base.sha=b,f=>f.run.head_sha=a,f=>f.run.workflow_id=8,f=>f.run.event="push",f=>f.run.conclusion="failure",
 f=>f.run.pull_requests=[],f=>f.run.pull_requests[0].base.ref="other",f=>f.run.pull_requests[0].base.sha=b,f=>f.run.pull_requests[0].head.sha=a,f=>f.pr.commits=2,f=>f.pr.mergeable=null,f=>f.pr.mergeable_state="blocked"
 ]){const f=facts();mutate(f);assert.throws(()=>gateFacts(f));}
});
test("disabled merge has no API effects",async()=>{let calls=0;const r=await mergeReport({request:()=>{calls++;throw Error();}},1,{enabled:false});assert.equal(calls,0);assert.equal(r.reason,"disabled");});
test("report subtree cannot hide workflow, executable or deleted file changes",()=>{
 const base={tree:new Map([[".github/workflows/x.yml",{sha:a,type:"blob",mode:"100644"}]])};
 for(const [p,mode]of [[".github/workflows/x.yml","100644"],["reports/x","100755"],["reports/x","120000"]]){
 const head={tree:new Map(base.tree)};head.tree.set(p,{sha:b,type:"blob",mode});assert.throws(()=>assertReportOnly(base,head));}
 assert.throws(()=>assertReportOnly(base,{tree:new Map()}));
});
test("truncated Git tree fails without reading or executing blob contents",async()=>{
 let n=0;await assert.rejects(()=>snapshot({request:async()=>++n===1?{sha:a,tree:{sha:b}}:{truncated:true,tree:[]}},a),/Incomplete/);assert.equal(n,2);
});
const publication=()=>publicationSite({files:new Map([["reports/2026-10-31/r1/report.json",Buffer.from("{}")]]),slug:"2026-10-31/r1",sourceCommit:a});
test("publication gate refuses stale, missing and changed pages",async()=>{
 for(const change of [s=>s.root.preview=true,s=>s.root.reports=[],s=>s.pages.set("2026-10-31/r1","<h1>wrong</h1>")]){
  const s=publication();change(s);await assert.rejects(()=>verifyPublication(a,"2026-10-31",1,s.fetcher));
 }
 await assert.rejects(()=>verifyPublication(a,"2026-10-31",1,async()=>new Response("unavailable",{status:503})),/unavailable/);
});
test("verified page still cannot claim a Slack/WeCom delivery",async()=>{
 const s=publication(),r=await verifyPublication(a,"2026-10-31",1,s.fetcher);
 assert(s.calls.every(c=>c.options.redirect==="error"&&c.options.cache==="no-store"));
 assert.equal(r.publication_status,"verified");assert.equal(r.delivery_allowed,false);
});
