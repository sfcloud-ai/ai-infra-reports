import test from "node:test";
import assert from "node:assert/strict";
import {configurationPolicy,mergerPolicy,verifyRules} from "../scripts/rules.mjs";
import {REPOSITORY} from "../scripts/archive.mjs";
const identity={producerAppId:101,mergerAppId:102};
function sets(){
 const common={source:REPOSITORY,source_type:"Repository",target:"branch",enforcement:"active",updated_at:"2026-10-30T00:00:00Z",bypass_actors:[]};
 return [
 {...common,id:1,conditions:{ref_name:{include:["refs/heads/main"],exclude:[]}},rules:[{type:"pull_request",parameters:{require_code_owner_review:true,dismiss_stale_reviews_on_push:true}},{type:"non_fast_forward"},{type:"deletion"},{type:"required_status_checks",parameters:{strict_required_status_checks_policy:true,required_status_checks:[{context:"validate",integration_id:99}]}}]},
 {...common,id:2,conditions:{ref_name:{include:["~ALL"],exclude:["refs/heads/main"]}},rules:[{type:"update"}]},
 {...common,id:3,conditions:{ref_name:{include:["refs/heads/main"],exclude:[]}},rules:[{type:"update",parameters:{update_allows_fetch_and_merge:false}}],bypass_actors:[{actor_type:"Integration",actor_id:102,bypass_mode:"always"}]}
 ];
}
const policyFor=s=>mergerPolicy(...s,99,101,102);
test("owner policy allows ordinary metadata token while detecting configuration changes",async()=>{
 const source=sets(),policy=policyFor(source);
 const api={request:async(_,route)=>{const s=structuredClone(source[Number(route.split("/").at(-1))-1]);delete s.bypass_actors;return s;}};
 await verifyRules(api,99,policy,identity);
 source[1].updated_at="2026-10-30T00:00:01Z";await assert.rejects(()=>verifyRules(api,99,policy,identity),/changed/);
 await assert.rejects(()=>verifyRules(api,99,null,identity),/Owner-verified/);
});
test("configuration needs visible bypass actors, code-owner review, exact scope and strict checks",()=>{
 for(const change of [
 s=>delete s[0].bypass_actors,s=>s[0].rules[0].parameters.require_code_owner_review=false,s=>s[0].rules[0].parameters.dismiss_stale_reviews_on_push=false,
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
 const s=sets();s[1].bypass_actors=[{actor_type:"User",actor_id:123,bypass_mode:"always"}];
 assert.equal(policyFor(s).rulesets[1].bypass_actors[0].actor_type,"User");
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
