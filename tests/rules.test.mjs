import test from "node:test";
import assert from "node:assert/strict";
import {mergerPolicy,verifyRules} from "../scripts/rules.mjs";
import {sets} from "./helpers/policy.mjs";
import {readFile} from "node:fs/promises";
const identity={producerAppId:101,mergerAppId:102};
const policyFor=s=>mergerPolicy(...s,99,101,102);
test("owner policy allows ordinary metadata token while detecting configuration changes",async()=>{
 const source=sets(),policy=policyFor(source);
 const api={request:async(_,route)=>{const s=structuredClone(source[Number(route.split("/").at(-1))-1]);delete s.bypass_actors;return s;}};
 await verifyRules(api,99,policy,identity);
 source[1].updated_at="2026-10-30T00:00:01Z";await assert.rejects(()=>verifyRules(api,99,policy,identity),/changed/);
 await assert.rejects(()=>verifyRules(api,99,null,identity),/Owner-verified/);
});
test("configuration needs visible bypass actors, zero human approvals, exact scope and strict checks",()=>{
 for(const change of [
 s=>delete s[0].bypass_actors,s=>s[0].rules[0].parameters.require_code_owner_review=true,s=>s[0].rules[0].parameters.dismiss_stale_reviews_on_push=false,
 s=>s[0].rules[0].parameters.required_approving_review_count=1,s=>s[0].rules[0].parameters.require_last_push_approval=true,
 s=>s[0].rules[0].parameters.required_reviewers=[{reviewer_id:1,reviewer_type:"Team"}],
 s=>s[0].bypass_actors=[{actor_type:"Integration",actor_id:102}],
 s=>s[0].rules.at(-1).parameters.strict_required_status_checks_policy=false,
 s=>s[0].rules.at(-1).parameters.required_status_checks[0].integration_id=98,
 s=>s[1].conditions.ref_name.exclude.push("refs/heads/release"),
 s=>s[1].rules=[],s=>s[1].enforcement="evaluate",
 s=>s[1].bypass_actors=[{actor_type:"Integration",actor_id:102,bypass_mode:"always"}],
 s=>s[1].bypass_actors=[{actor_type:"RepositoryRole",actor_id:5,bypass_mode:"always"}],
 s=>s[1].updated_at=new Date().toISOString()
 ]){const s=sets();change(s);assert.throws(()=>policyFor(s));}
});
test("non-main updates may exempt named human users but never the merging App",()=>{
 const s=sets();
 assert.equal(policyFor(s).rulesets[1].bypass_actors[0].actor_type,"User");
});

test("human approval bypass is limited to PRs and cannot skip the quality gate",()=>{
 const policy=policyFor(sets()),[quality,,,codeReview]=policy.rulesets;
 assert.equal(policy.schema_version,"3.0");
 assert.equal(quality.rules.find(r=>r.type==="pull_request").parameters.required_approving_review_count,0);
 assert.deepEqual(quality.bypass_actors,[]);
 assert(codeReview.bypass_actors.every(a=>a.actor_type==="User"&&a.bypass_mode==="pull_request"));
 assert.equal(codeReview.rules[0].parameters.require_code_owner_review,true);
 for(const change of [
  s=>s[0].rules=s[0].rules.filter(r=>r.type!=="pull_request"),
  s=>s[0].bypass_actors.push({actor_type:"User",actor_id:123,bypass_mode:"pull_request"}),
  s=>s[3].bypass_actors[0].bypass_mode="always",
  s=>s[3].bypass_actors.push({actor_type:"Integration",actor_id:102,bypass_mode:"pull_request"}),
  s=>s[3].bypass_actors.push({actor_type:"RepositoryRole",actor_id:4,bypass_mode:"pull_request"}),
  s=>s[3].rules[0].parameters.require_code_owner_review=false,
  s=>s[3].rules[0].parameters.dismiss_stale_reviews_on_push=false,
  s=>s[3].rules.push({type:"required_status_checks"}),
  s=>s[3].conditions.ref_name.include.push("refs/heads/release"),
  s=>s[3].id=2
 ]){const s=sets();change(s);assert.throws(()=>policyFor(s));}
});

test("the same explicit human writers must appear once in all three bypass lists",()=>{
 for(const mutate of [
  s=>s[1].bypass_actors.pop(),s=>s[2].bypass_actors.pop(),s=>s[3].bypass_actors.pop(),
  s=>s[3].bypass_actors.push({...s[3].bypass_actors[0]}),
  s=>s[1].bypass_actors=[],s=>s[2].bypass_actors[1].actor_id=789
 ]){const s=sets();mutate(s);assert.throws(()=>policyFor(s));}
 const s=sets();s[3].bypass_actors.reverse();assert.doesNotThrow(()=>policyFor(s));
});

test("code-review drift is detected even when the runtime token cannot see bypass actors",async()=>{
 const source=sets(),policy=policyFor(source);source[3].rules[0].parameters.require_code_owner_review=false;
 await assert.rejects(()=>verifyRules({request:async(_,route)=>{
  const s=structuredClone(source[Number(route.split("/").at(-1))-1]);delete s.bypass_actors;return s;
 }},99,policy,identity),/changed/);
});

test("three-ruleset v1 attestations fail before any merge-time API call",async()=>{
 const policy=policyFor(sets());policy.schema_version="1.0";policy.rulesets.pop();
 await assert.rejects(()=>verifyRules({request:()=>{throw Error("unexpected API call");}},99,policy,identity),/Owner-verified/);
});
test("ruleset object key order is semantically irrelevant",async()=>{
 const s=sets(),policy=policyFor(s);
 function reverse(v){return Array.isArray(v)?v.map(reverse):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;}
 const reversed=s.map(reverse);assert.doesNotThrow(()=>policyFor(reversed));
 await verifyRules({request:async(_,route)=>reversed[Number(route.split("/").at(-1))-1]},99,policy,identity);
});
test("producer cannot bypass main updates and merger cannot bypass quality checks",()=>{
 for(const change of [
 s=>s[2].bypass_actors.push({actor_type:"Integration",actor_id:101,bypass_mode:"always"}),
 s=>s[2].bypass_actors.push({actor_type:"RepositoryRole",actor_id:5,bypass_mode:"always"}),
 s=>s[0].bypass_actors.push({actor_type:"Integration",actor_id:102,bypass_mode:"always"}),
 s=>s[2].rules.push({type:"required_status_checks"}),
 s=>s[2].rules[0].parameters.update_allows_fetch_and_merge=true,
 s=>s[2].id=1
 ]){const s=sets();change(s);assert.throws(()=>policyFor(s));}
 const s=sets();assert.throws(()=>mergerPolicy(...s,99,102,102),/Independent/);
});
test("runtime identity drift cannot reuse an attested policy",async()=>{
 await assert.rejects(()=>verifyRules({request:()=>{throw Error("must not call");}},99,policyFor(sets()),{producerAppId:102,mergerAppId:102}),/Owner-verified/);
});

test("non-main deletion and merge-based updates cannot reopen the immutable branch boundary",()=>{
 for(const mutate of [
  s=>s[1].rules=s[1].rules.filter(r=>r.type!=="deletion"),
  s=>s[1].rules[0].parameters.update_allows_fetch_and_merge=true,
  s=>s[1].rules[0].parameters={},
  s=>s[1].rules[0].parameters=null,
  s=>s[1].rules.push({type:"creation"})
 ]){const s=sets();mutate(s);assert.throws(()=>policyFor(s));}
 const policy=policyFor(sets());
 assert(!policy.rulesets[1].rules.some(r=>r.type==="creation"));
});

test("GitHub's omitted false update parameters remain restrictive and are attested verbatim",async()=>{
 const s=sets();delete s[1].rules[0].parameters;delete s[2].rules[0].parameters;
 const policy=policyFor(s);assert.equal(policy.rulesets[1].rules[0].parameters,undefined);
 await verifyRules({request:async(_,route)=>s[Number(route.split("/").at(-1))-1]},99,policy,identity);
 s[2].rules[0].parameters={update_allows_fetch_and_merge:true};
 await assert.rejects(()=>verifyRules({request:async(_,route)=>s[Number(route.split("/").at(-1))-1]},99,policy,identity),/changed/);
});

test("old update-only attestations fail before any merge-time API call",async()=>{
 const policy=policyFor(sets());policy.rulesets[1].rules=policy.rulesets[1].rules.filter(r=>r.type!=="deletion");
 await assert.rejects(()=>verifyRules({request:()=>{throw Error("unexpected API call");}},99,policy,identity),/updates and deletion/);
});

test("creation policy pins Producer-only report branches and human-only other branches",()=>{
 const policy=policyFor(sets()),[,,,,reports,others]=policy.rulesets;
 assert.equal(policy.rulesets.length,6);
 assert.deepEqual(reports.conditions,{ref_name:{include:["refs/heads/report/*"],exclude:[]}});
 assert.deepEqual(others.conditions,{ref_name:{include:["~ALL"],exclude:["refs/heads/main","refs/heads/report/*"]}});
 assert.deepEqual(reports.bypass_actors.filter(a=>a.actor_type==="Integration"),[{actor_type:"Integration",actor_id:101,bypass_mode:"always"}]);
 assert(others.bypass_actors.every(a=>a.actor_type==="User"));
 assert(!reports.bypass_actors.some(a=>a.actor_type==="Integration"&&a.actor_id===102));
});

test("creation rules cannot widen scope, mix permissions, omit humans or exempt another App",()=>{
 for(const mutate of [
  s=>s[4].conditions.ref_name.include=["~ALL"],s=>s[4].conditions.ref_name.exclude=["refs/heads/report/private-*"],
  s=>s[5].conditions.ref_name.exclude.push("refs/heads/release/*"),s=>s[5].conditions.ref_name.include=["refs/heads/fix/*"],
  s=>s[5].conditions.ref_name.exclude=["refs/heads/report/*"],
  s=>s[4].rules.push({type:"update"}),s=>s[5].rules.push({type:"deletion"}),s=>s[4].rules[0].parameters={},
  s=>s[4].bypass_actors.at(-1).actor_id=102,s=>s[4].bypass_actors.at(-1).bypass_mode="pull_request",
  s=>s[4].bypass_actors.push({actor_type:"Integration",actor_id:102,bypass_mode:"always"}),
  s=>s[4].bypass_actors.pop(),s=>s[4].bypass_actors.shift(),s=>s[5].bypass_actors.pop(),
  s=>s[5].bypass_actors.push({actor_type:"Integration",actor_id:101,bypass_mode:"always"}),
  s=>s[5].bypass_actors.push({actor_type:"Integration",actor_id:102,bypass_mode:"always"}),
  s=>s[4].bypass_actors[0].actor_type="Team",s=>s[5].bypass_actors[0].actor_type="RepositoryRole",
  s=>s[5].bypass_actors.push({...s[5].bypass_actors[0]}),s=>s[5].bypass_actors[0].actor_id=789,
  s=>s[4].enforcement="disabled",s=>s[5].enforcement="evaluate",s=>delete s[4].bypass_actors,
  s=>s[5].id=s[4].id,s=>s[4].id=s[0].id,s=>s[5].target="tag",s=>s[5].source_type="Organization",
  s=>s[4].updated_at=new Date().toISOString()
 ]){const s=sets();mutate(s);assert.throws(()=>policyFor(s));}
});

test("legacy or incomplete policies cannot silently skip the creation checks",async()=>{
 for(const mutate of [p=>{p.schema_version="2.0";p.rulesets=p.rulesets.slice(0,4);},p=>p.schema_version="2.0",p=>p.rulesets.pop(),p=>p.rulesets.push(p.rulesets[0])]){
  const p=policyFor(sets());mutate(p);let calls=0;
  await assert.rejects(()=>verifyRules({request:()=>{calls++;}},99,p,identity),/Owner-verified/);assert.equal(calls,0);
 }
});

test("both creation rules are checked with metadata-only visibility and drift fails closed",async()=>{
 for(const index of [4,5])for(const mutate of [s=>s.enforcement="disabled",s=>s.conditions.ref_name.include=["refs/heads/unused/*"],s=>s.rules=[],s=>s.updated_at="2026-10-30T00:00:01Z"]){
  const source=sets(),policy=policyFor(source);mutate(source[index]);
  await assert.rejects(()=>verifyRules({request:async(_,route)=>{const s=structuredClone(source[Number(route.split("/").at(-1))-1]);delete s.bypass_actors;return s;}},99,policy,identity),/changed/);
 }
 for(const index of [4,5]){
  const source=sets(),policy=policyFor(source);source[index].bypass_actors.push({actor_type:"Integration",actor_id:102,bypass_mode:"always"});
  await assert.rejects(()=>verifyRules({request:async(_,route)=>source[Number(route.split("/").at(-1))-1]},99,policy,identity),/bypass changed/);
 }
});

test("missing or unreadable creation rules never become an empty permitted configuration",async()=>{
 for(const index of [4,5])for(const missing of [true,false]){
  const source=sets(),policy=policyFor(source);
  await assert.rejects(()=>verifyRules({request:async(_,route)=>{const i=Number(route.split("/").at(-1))-1;if(i===index){if(missing)return null;throw Error("read unavailable");}return source[i];}},99,policy,identity));
 }
});

test("checked-in policy is a complete normalized six-rule attestation",async()=>{
 const p=JSON.parse(await readFile(".github/report-policy.json","utf8"));
 assert.deepEqual(mergerPolicy(...p.rulesets,p.actions_app_id,p.producer_app_id,p.merger_app_id),p);
 assert.equal(p.schema_version,"3.0");assert.equal(p.rulesets.length,6);
});
