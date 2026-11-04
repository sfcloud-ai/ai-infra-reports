import test from "node:test";
import assert from "node:assert/strict";
import {GitHub,PREFIX,operationError,rateLimitInfo} from "../scripts/github.mjs";
import {propose,reconcileProposal} from "../scripts/propose.mjs";
import {readReports,REPOSITORY} from "../scripts/archive.mjs";
import {FakeGitHub} from "./helpers/fake-github.mjs";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const bundle=new Map([...await readReports("tests/fixtures/archive")].filter(([p])=>p.startsWith("reports/2026-10-31/")));
const transport=(outcome="unknown")=>operationError("private transport detail",{stage:"github_write",code:"transport",outcome,retryable:outcome==="not_started"});
const writes=api=>api.calls.filter(c=>c.method!=="GET");

test("a real child-process timeout remains a retryable pre-write Git snapshot failure",{skip:process.platform!=='linux'},async()=>{
 let timeout;
 await assert.rejects(promisify(execFile)(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:100}),error=>{timeout=error;return error.code===null&&error.killed===true&&error.signal==='SIGTERM';});
 for(const stage of ['base_snapshot','check_ref','check_pr','reconcile_commit']){
  const api=new FakeGitHub();
  if(stage!=='base_snapshot')await propose(api,bundle,api.base);
  if(stage==='check_pr')api.refs.delete(api.pulls[0].head.ref);
  const before=writes(api).length,read=api.readBlobs.bind(api);
  api.readBlobs=async(sha,...args)=>{if(stage==='base_snapshot'||sha!==api.base)throw timeout;return read(sha,...args);};
  const operation=stage==='reconcile_commit'?reconcileProposal:propose;
  await assert.rejects(()=>operation(api,bundle,api.base),error=>error.diagnostic.stage===stage&&error.diagnostic.code==='git_read_failed'&&error.diagnostic.outcome==='not_started'&&error.diagnostic.retryable===true);
  assert.equal(writes(api).length,before);
 }
});

test('a Git snapshot timeout after a competing ref creation stays retryable and reuses that ref',async()=>{
 for(const status of [409,422]){
  const api=new FakeGitHub(),call=api.request.bind(api),read=api.readBlobs.bind(api);let conflict=false;
  api.request=async(method,route,body,options)=>{
   const result=await call(method,route,body,options);
   if(method==='POST'&&route.endsWith('/git/refs')){conflict=true;throw operationError('fixture competing ref',{stage:'github_write',code:'http_'+status,http_status:status,outcome:'rejected'});}
   return result;
  };
  api.readBlobs=async(sha,...args)=>{if(conflict&&sha!==api.base)throw Object.assign(Error('fixture timeout'),{code:null,killed:true,signal:'SIGTERM'});return read(sha,...args);};
  await assert.rejects(propose(api,bundle,api.base),error=>error.diagnostic.stage==='reconcile_ref'&&error.diagnostic.outcome==='not_started'&&error.diagnostic.retryable===true);
  api.request=call;api.readBlobs=read;await propose(api,bundle,api.base);
  assert.equal(api.calls.filter(c=>c.method==='POST'&&c.route.endsWith('/git/refs')).length,1);assert.equal(api.pulls.length,1);
 }
});

test("public reconciliation client never sends credentials and rejects mutation locally",async()=>{
 let calls=0;
 const client=new GitHub("must-not-send",{readOnly:true,fetcher:async(url,options)=>{
  calls++;assert.equal(options.method,"GET");assert(!Object.hasOwn(options.headers,"authorization"));
  return new Response("{}",{status:200});
 }});
 await client.request("GET",PREFIX+"/git/ref/heads/main");
 await assert.rejects(()=>client.request("POST",PREFIX+"/git/refs",{}),error=>error.diagnostic.code==="write_forbidden");
 assert.equal(calls,1);await client.close();
});

test("GitHub distinguishes GET absence, rejected writes and ambiguous transport without leaking bodies",async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const client=new GitHub("fixture-secret"),secret="credential body must never be logged";
 globalThis.fetch=async()=>new Response(secret,{status:404,headers:{"x-github-request-id":"REQ:123"}});
 assert.equal(await client.request("GET",PREFIX+"/git/ref/heads/missing"),null);
 await assert.rejects(()=>client.request("POST",PREFIX+"/git/refs",{}),error=>error.diagnostic.outcome==="rejected"&&error.diagnostic.http_status===404&&error.diagnostic.request_id==="REQ:123"&&!error.message.includes(secret));
 globalThis.fetch=async()=>{throw Error(secret);};
 await assert.rejects(()=>client.request("GET",PREFIX+"/pulls"),error=>error.diagnostic.outcome==="not_started"&&error.diagnostic.retryable===true&&!error.message.includes(secret));
 await assert.rejects(()=>client.request("POST",PREFIX+"/pulls",{}),error=>error.diagnostic.outcome==="unknown"&&!error.message.includes(secret));
 globalThis.fetch=async()=>new Response(secret,{status:503,headers:{"x-github-request-id":"bad secret header"}});
 await assert.rejects(()=>client.request("POST",PREFIX+"/pulls",{}),error=>error.diagnostic.outcome==="unknown"&&error.diagnostic.http_status===503&&!Object.hasOwn(error.diagnostic,"request_id"));
 globalThis.fetch=async()=>new Response(secret,{status:403,headers:{"x-ratelimit-remaining":"0"}});
 await assert.rejects(()=>client.request("POST",PREFIX+"/pulls",{}),error=>error.diagnostic.outcome==="rejected"&&error.diagnostic.code==="rate_limited"&&error.diagnostic.retryable===true);
 await client.close();
});

test('GitHub diagnostics preserve provider deadlines and the secondary-limit minimum',async()=>{
 const time=Date.parse('2026-11-04T00:00:00Z');
 for(const [status,headers,delay,retryable]of [
  [403,{'retry-after':'60'},60000,true],
  [403,{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(time/1000+3600)},3600000,true],
  [429,{'retry-after':'120','x-ratelimit-remaining':'0','x-ratelimit-reset':String(time/1000+3600)},3600000,true],
  [429,{'retry-after':'60','x-ratelimit-remaining':'1','x-ratelimit-reset':String(time/1000+3600)},60000,true],
  [429,{},60000,true],
  [403,{'retry-after':'-1','x-ratelimit-remaining':'1'},null,false]
 ]){
  const api=new GitHub('fixture',{now:()=>time,fetcher:async()=>new Response('private body',{status,headers})});
  try{await assert.rejects(()=>api.request('GET',PREFIX+'/git/ref/heads/main'),error=>error.diagnostic.retryable===retryable&&error.diagnostic.retry_at===(delay===null?undefined:time+delay)&&!JSON.stringify(error.diagnostic).includes('private body'));}
  finally{await api.close();}
 }
});

test('secondary 403 limits without retry headers use bounded private body inspection',async()=>{
 const time=100000;
 for(const [body,limited]of [
  [JSON.stringify({message:'You have exceeded a secondary rate limit. Private request details.',secret:'never persist'}),true],
  [JSON.stringify({message:'Resource not accessible by integration',secret:'never persist'}),false],
  ['malformed private body',false],
  [JSON.stringify({message:'You have exceeded a secondary rate limit.',secret:'x'.repeat(65536)}),false]
 ]){
  const api=new GitHub('fixture',{now:()=>time,fetcher:async()=>new Response(body,{status:403,headers:{'x-ratelimit-remaining':'99'}})});
  try{await assert.rejects(()=>api.request('POST',PREFIX+'/pulls',{}),error=>error.diagnostic.code===(limited?'rate_limited':'http_403')&&error.diagnostic.retryable===limited&&error.diagnostic.retry_at===(limited?time+60000:undefined)&&!JSON.stringify(error.diagnostic).includes('secret')&&!error.message.includes('Private'));}
  finally{await api.close();}
 }
 let chunks=0;
 const oversized={status:403,headers:new Headers(),body:(async function*(){for(let i=0;i<100;i++){chunks++;yield Buffer.alloc(32768);}})()};
 assert.equal((await rateLimitInfo(oversized,time)).limited,false);assert.equal(chunks,3);
});

test("a denied PR creation stays a known failure even when its branch already exists",async()=>{
 const api=new FakeGitHub(),call=api.request.bind(api);
 api.request=async(method,route,body,options)=>{
  if(method==="POST"&&route.endsWith("/pulls"))throw operationError("denied",{stage:"github_write",code:"http_403",http_status:403,outcome:"rejected"});
  return call(method,route,body,options);
 };
 await assert.rejects(()=>propose(api,bundle,api.base),error=>error.diagnostic.stage==="create_pr"&&error.diagnostic.outcome==="not_started"&&error.diagnostic.retryable===false);
 assert.equal(api.refs.size,2);assert.equal(api.pulls.length,0);
});

test("immutable Git object transport failure is a safe prepublication retry",async()=>{
 const api=new FakeGitHub(),call=api.request.bind(api);
 api.request=async(method,route,body,options)=>{
  if(method==="POST"&&route.endsWith("/git/blobs"))throw transport();
  return call(method,route,body,options);
 };
 await assert.rejects(()=>propose(api,bundle,api.base),error=>error.diagnostic.stage==="create_blob"&&error.diagnostic.outcome==="not_started"&&error.diagnostic.retryable===true);
 assert.equal(api.refs.size,1);assert.equal(api.pulls.length,0);
});

test("a denied ref creation is not an unknown publication",async()=>{
 const api=new FakeGitHub(),call=api.request.bind(api);
 api.request=async(method,route,body,options)=>{
  if(method==="POST"&&route.endsWith("/git/refs"))throw operationError("denied",{stage:"github_write",code:"http_403",http_status:403,outcome:"rejected"});
  return call(method,route,body,options);
 };
 await assert.rejects(()=>propose(api,bundle,api.base),error=>error.diagnostic.stage==="create_ref"&&error.diagnostic.outcome==="not_started"&&error.diagnostic.retryable===false&&error.diagnostic.http_status===403);
 assert.equal(api.refs.size,1);assert.equal(api.pulls.length,0);
});

test("lost ref response and failed reconciliation persist unknown, then resume the exact branch",async()=>{
 const api=new FakeGitHub(),call=api.request.bind(api);let uncertain=false;
 api.request=async(method,route,body,options)=>{
  if(method==="POST"&&route.endsWith("/git/refs")){await call(method,route,body,options);uncertain=true;throw transport();}
  if(uncertain&&method==="GET"&&route.includes("/git/ref/heads/report/"))throw transport("not_started");
  return call(method,route,body,options);
 };
 await assert.rejects(()=>propose(api,bundle,api.base),error=>error.diagnostic.outcome==="unknown");
 api.request=call;const before=writes(api).length;
 const reconciled=await reconcileProposal(api,bundle,api.base);
 assert.equal(reconciled.outcome,"branch_only");assert.equal(writes(api).length,before);
 const result=await propose(api,bundle,api.base);
 assert.equal(result.sha,reconciled.sha);assert.equal(api.pulls.length,1);
 assert.equal(api.calls.filter(c=>c.method==="POST"&&c.route.endsWith("/git/refs")).length,1);
});

test("lost PR response is recovered read-only without another PR create",async()=>{
 const api=new FakeGitHub(),call=api.request.bind(api);let uncertain=false;
 api.request=async(method,route,body,options)=>{
  if(method==="POST"&&route.endsWith("/pulls")){await call(method,route,body,options);uncertain=true;throw transport();}
  if(uncertain&&method==="GET"&&route.includes("/pulls?"))throw transport("not_started");
  return call(method,route,body,options);
 };
 await assert.rejects(()=>propose(api,bundle,api.base),error=>error.diagnostic.outcome==="unknown");
 api.request=call;const before=writes(api).length;
 const result=await reconcileProposal(api,bundle,api.base);
 assert.equal(result.outcome,"published");assert.equal(result.url,api.pulls[0].html_url);assert.equal(writes(api).length,before);
 assert.equal(api.calls.filter(c=>c.method==="POST"&&c.route.endsWith("/pulls")).length,1);
});

test("merged PR is recoverable after main advances and the deterministic branch is deleted",async()=>{
 const api=new FakeGitHub();const first=await propose(api,bundle,api.base),pr=api.pulls[0];
 pr.state="closed";pr.merged_at="2026-11-04T00:00:00Z";api.refs.delete(pr.head.ref);api.refs.set("main","f".repeat(40));
 const before=writes(api).length,result=await reconcileProposal(api,bundle,api.base);
 assert.equal(result.outcome,"published");assert.equal(result.sha,first.sha);assert.equal(result.merged,true);assert.equal(writes(api).length,before);
});

test("absence is declared only after complete successful reads and unchanged base",async()=>{
 const api=new FakeGitHub();assert.equal((await reconcileProposal(api,bundle,api.base)).outcome,"absent");assert.equal(writes(api).length,0);
 api.refs.set("main","f".repeat(40));assert.equal((await reconcileProposal(api,bundle,api.base)).reason,"main_moved");
 const call=api.request.bind(api);api.request=async(method,route,body,options)=>{
  if(route.includes("/pulls?"))throw operationError("denied",{stage:"github_read",code:"http_403",http_status:403});
  return call(method,route,body,options);
 };
 await assert.rejects(()=>reconcileProposal(api,bundle,api.base),error=>error.diagnostic.http_status===403);
 assert.equal(writes(api).length,0);
});

test("wrong PR identity, multiple PRs and closed unmerged requests block recovery without mutations",async()=>{
 for(const mutate of [
  pr=>pr.head.repo.full_name="untrusted/reports",pr=>pr.head.ref="report/wrong",pr=>pr.base.ref="other",
  pr=>pr.base.repo.full_name="untrusted/reports",pr=>pr.html_url="https://github.com/untrusted/reports/pull/1",
  pr=>pr.number=2,pr=>pr.state="closed"
 ]){
  const api=new FakeGitHub();await propose(api,bundle,api.base);mutate(api.pulls[0]);const before=writes(api).length;
  assert.equal((await reconcileProposal(api,bundle,api.base)).outcome,"blocked");assert.equal(writes(api).length,before);
 }
 const api=new FakeGitHub();await propose(api,bundle,api.base);api.pulls.push({...api.pulls[0],number:2});const before=writes(api).length;
 assert.equal((await reconcileProposal(api,bundle,api.base)).outcome,"blocked");assert.equal(writes(api).length,before);
});

test("reconciliation refuses divergent report trees and complete-list pagination errors",async()=>{
 const api=new FakeGitHub();await propose(api,bundle,api.base);const commit=api.commits.get(api.pulls[0].head.sha);
 commit.parents=[{sha:"f".repeat(40)}];const before=writes(api).length;
 assert.equal((await reconcileProposal(api,bundle,api.base)).outcome,"blocked");assert.equal(writes(api).length,before);
 const clean=new FakeGitHub(),call=clean.request.bind(clean);
 clean.request=async(method,route,body,options)=>{
  if(route.includes("/pulls?")){assert.equal(options.requireSinglePage,true);throw operationError("pagination",{stage:"github_read",code:"incomplete_response"});}
  return call(method,route,body,options);
 };
 await assert.rejects(()=>reconcileProposal(clean,bundle,clean.base),error=>error.diagnostic.code==="incomplete_response");assert.equal(writes(clean).length,0);
});
