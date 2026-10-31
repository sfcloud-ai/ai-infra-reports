import test from "node:test";
import assert from "node:assert/strict";
import {propose} from "../scripts/propose.mjs";
import {readReports} from "../scripts/archive.mjs";
import {FakeGitHub} from "./helpers/fake-github.mjs";
const bundle=new Map([...await readReports("tests/fixtures/archive")].filter(([p])=>p.startsWith("reports/2026-10-31/")));
test("publisher commits report and index atomically and creates a draft by default",async()=>{
 const api=new FakeGitHub(),r=await propose(api,bundle,api.base);
 assert.equal(r.merged,false);assert.equal(api.pulls[0].draft,true);
 const change=api.calls.find(c=>c.route.endsWith("/git/trees")&&c.method==="POST");
 assert(change.body.tree.some(e=>e.path==="reports/index.json"));assert(change.body.tree.some(e=>e.path.endsWith("/report.json")));
 assert.equal(api.calls.filter(c=>c.route.endsWith("/git/refs")&&c.method==="POST").length,1);
});
test("unknown ref/PR response reconciles without duplicate branch or pull request",async()=>{
 const api=new FakeGitHub();api.unknownRef=true;api.unknownPR=true;
 const first=await propose(api,bundle,api.base),again=await propose(api,bundle,api.base);
 assert.equal(first.sha,again.sha);assert.equal(again.reused,true);
 assert.equal(api.pulls.length,1);assert.equal(api.calls.filter(c=>c.route.endsWith("/pulls")&&c.method==="POST").length,1);
});
test("stale main and closed PR stop without force pushes or reopening",async()=>{
 const api=new FakeGitHub();await assert.rejects(()=>propose(api,bundle,"b".repeat(40)),/Main moved/);
 assert.equal(api.calls.filter(c=>c.method!=="GET").length,0);
 await propose(api,bundle,api.base);api.pulls[0].state="closed";
 await assert.rejects(()=>propose(api,bundle,api.base),/closed/);
 assert.equal(api.pulls.length,1);assert(!api.calls.some(c=>c.method==="PATCH"));
});
test("wrong content bundle rejected before any GitHub write",async()=>{
 const api=new FakeGitHub(),bad=new Map(bundle);bad.set("reports/2026-10-31/r1/run.mjs",Buffer.from("code"));
 await assert.rejects(()=>propose(api,bad,api.base),/unexpected path/);
 assert.equal(api.calls.filter(c=>c.method!=="GET").length,0);
});

test("equivalent racing commits reuse the winning ref and PR",async()=>{
 const api=new FakeGitHub();api.raceEquivalent=true;
 const result=await propose(api,bundle,api.base);
 assert.equal(result.sha,"d".repeat(40));assert.equal(api.pulls.length,1);
 assert.equal(api.pulls[0].head.sha,result.sha);
});
test("lost PR response reports an already completed merge accurately",async()=>{
 const api=new FakeGitHub();api.unknownPR=true;api.mergeAfterUnknownPR=true;
 const result=await propose(api,bundle,api.base);assert.equal(result.merged,true);assert.equal(api.pulls.length,1);
});
