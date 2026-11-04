import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,verify} from "node:crypto";
import {producerJWT,withProducerToken} from "../scripts/producer-token.mjs";
import {proposeWithApp,reconcileProposalWithApp} from "../scripts/propose-with-app.mjs";
import {readReports,REPOSITORY} from "../scripts/archive.mjs";
import {FakeGitHub} from "./helpers/fake-github.mjs";
import {operationError} from '../scripts/github.mjs';

// Ephemeral, in-memory test key: never registered with GitHub or written to disk.
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const identity={appId:101,mergerAppId:102,privateKey:privateKey.export({type:"pkcs8",format:"pem"})};
const time=Date.parse("2026-10-31T00:00:00Z"),now=()=>time;
const permissions={contents:"write",pull_requests:"write",metadata:"read"};
const token="fixture-installation-token-not-a-credential";
function authFixture(){
 const state={calls:[],installation:{id:9,app_id:101,account:{login:"sfcloud-ai",type:"Organization"},repository_selection:"selected",suspended_at:null,permissions:{...permissions}},issued:{token,expires_at:new Date(time+3600000).toISOString(),permissions:{...permissions}},repositories:{total_count:1,repositories:[{full_name:REPOSITORY,private:false}]}};
 state.fetcher=async(url,options)=>{
  const route=new URL(url).pathname+new URL(url).search;
  state.calls.push({route,...options});
  assert.equal(new URL(url).origin,"https://api.github.com");
  assert.equal(options.redirect,"error");assert(options.signal instanceof AbortSignal);
  if(route.startsWith("/installation/"))assert.equal(options.headers.authorization,"Bearer "+token);
  else assert.equal(options.headers.authorization,"Bearer "+producerJWT(101,identity.privateKey,time));
  if(state.fail===route)throw Error("transport failure "+token);
  if(state.deny===route)return {ok:false,status:403,json:()=>{throw Error("response body must not be read");}};
  const data=route.endsWith("/installation")?state.installation:route.endsWith("/access_tokens")?state.issued:route.startsWith("/installation/repositories")?state.repositories:undefined;
  if(route==="/installation/token"){assert.equal(options.method,"DELETE");return {ok:true,status:204};}
  assert(data,"unexpected route "+route);return {ok:true,status:200,json:async()=>structuredClone(data)};
 };
 return state;
}

test("Producer JWT is signed RS256 with bounded lifetime and clock-skew allowance",()=>{
 const jwt=producerJWT(101,identity.privateKey,time),[header,payload,signature]=jwt.split(".");
 assert.deepEqual(JSON.parse(Buffer.from(header,"base64url")),{alg:"RS256",typ:"JWT"});
 assert.deepEqual(JSON.parse(Buffer.from(payload,"base64url")),{iss:"101",iat:time/1000-60,exp:time/1000+540});
 assert(verify("RSA-SHA256",Buffer.from(header+"."+payload),publicKey,Buffer.from(signature,"base64url")));
 assert.throws(()=>producerJWT(0,identity.privateKey,time));
 assert.throws(()=>producerJWT(101,"not a private key",time),/valid Producer RSA/);
});

test("issuance scopes one repository and two permissions, then revokes before returning",async()=>{
 const f=authFixture();let used=false;
 const result=await withProducerToken(identity,async value=>{assert.equal(value,token);used=true;return {url:"fixture-pr"};},{...f,now});
 assert(used);assert.deepEqual(result,{url:"fixture-pr"});
 const issue=f.calls.find(c=>c.method==="POST");
 assert.deepEqual(JSON.parse(issue.body),{repositories:["ai-infra-reports"],permissions:{contents:"write",pull_requests:"write"}});
 assert.equal(f.calls.at(-1).route,"/installation/token");
 assert.equal(f.calls.at(-1).method,"DELETE");
 assert(!JSON.stringify(result).includes(token));
});

test("identity, installation selection and excessive grants fail before issuing any token",async()=>{
 let calls=0;await assert.rejects(()=>withProducerToken({...identity,mergerAppId:101},()=>{}, {fetcher:()=>{calls++;},now}),/Independent/);assert.equal(calls,0);
 for(const change of [
  s=>s.app_id=102,s=>s.account.login="another-owner",s=>s.repository_selection="all",
  s=>s.suspended_at=new Date(time).toISOString(),s=>s.permissions.actions="read",s=>s.permissions.contents="read"
 ]){const f=authFixture();change(f.installation);await assert.rejects(()=>withProducerToken(identity,()=>assert.fail("must not publish"),{...f,now}),/installation/);assert.equal(f.calls.length,1);}
});

test("unexpected token scope or lifetime is revoked and never passed to the producer",async()=>{
 for(const change of [
  f=>f.issued.permissions.pages="write",f=>f.issued.permissions.pull_requests="read",
  f=>f.issued.expires_at=new Date(time-1).toISOString(),f=>f.issued.expires_at=new Date(time+7200000).toISOString(),
  f=>f.repositories.total_count=2,f=>f.repositories.repositories[0].full_name="sfcloud-ai/other",f=>f.repositories.repositories[0].private=true
 ]){const f=authFixture();change(f);await assert.rejects(()=>withProducerToken(identity,()=>assert.fail("must not publish"),{...f,now}),/token/);assert.equal(f.calls.at(-1).method,"DELETE");}
});

test("denied and uncertain issuance is never retried and transport errors cannot echo secrets",async()=>{
 for(const kind of ["deny","fail"]){
  const f=authFixture();f[kind]="/app/installations/9/access_tokens";
  await assert.rejects(()=>withProducerToken(identity,()=>assert.fail("must not publish"),{...f,now}),e=>/do not retry/.test(e.message)&&!e.message.includes(token));
  assert.equal(f.calls.filter(c=>c.method==="POST").length,1);assert.equal(f.calls.length,2);
 }
});

test("proposal errors still revoke; revocation failure must not return a successful receipt",async()=>{
 const f=authFixture();await assert.rejects(()=>withProducerToken(identity,()=>{throw Error("proposal rejected");},{...f,now}),/proposal rejected/);
 assert.equal(f.calls.at(-1).method,"DELETE");
 const bad=authFixture();bad.fail="/installation/token";
 await assert.rejects(()=>withProducerToken(identity,()=>({url:"created-pr"}),{...bad,now}),e=>/revocation unconfirmed/.test(e.message)&&!e.message.includes(token));
 assert.equal(bad.calls.filter(c=>c.method==="DELETE").length,1);
});

const bundle=new Map([...await readReports("tests/fixtures/archive")].filter(([p])=>p.startsWith("reports/2026-10-31/")));
test("App-backed producer executes the real proposal path, defaults to draft and closes before revoking",async()=>{
 for(const ready of [false,true]){
  const f=authFixture(),api=new FakeGitHub();let closed=false;
  api.close=async()=>{closed=true;assert(!f.calls.some(c=>c.method==="DELETE"));};
  const result=await proposeWithApp(bundle,api.base,identity,{...f,now,ready,createAPI:value=>{assert.equal(value,token);return api;}});
  assert(closed);assert.equal(api.pulls[0].draft,!ready);assert.equal(result.merged,false);
  assert.equal(api.calls.filter(c=>c.method==="POST"&&c.route.endsWith("/pulls")).length,1);
  assert.equal(f.calls.at(-1).method,"DELETE");
 }
});

test("invalid arguments avoid issuance; stale main closes the client and revokes without repository writes",async()=>{
 const f=authFixture();await assert.rejects(()=>proposeWithApp(bundle,"main",identity,{...f,now}),/exact main SHA/);assert.equal(f.calls.length,0);
 const api=new FakeGitHub();let closed=false;api.close=async()=>{closed=true;};
 await assert.rejects(()=>proposeWithApp(bundle,"b".repeat(40),identity,{...f,now,createAPI:()=>api}),/Main moved/);
 assert(closed);assert(!api.calls.some(c=>c.method!=="GET"));assert.equal(f.calls.at(-1).method,"DELETE");
});

test("proposal reconciliation reads public state without issuing or revoking any credential",async()=>{
 const f=authFixture(),api=new FakeGitHub();let closed=false;
 api.close=async()=>{closed=true;assert(!f.calls.some(c=>c.method==="DELETE"));};
 const result=await reconcileProposalWithApp(bundle,api.base,identity,{...f,now,createAPI:()=>api});
 assert.equal(result.outcome,"absent");assert(closed);assert(api.calls.every(c=>c.method==="GET"));
 assert.equal(f.calls.length,0);
});

test("authentication failures retain bounded diagnostics before any proposal write",async()=>{
 for(const kind of ["deny","fail"]){
  const f=authFixture();f[kind]="/repos/"+REPOSITORY+"/installation";
  await assert.rejects(()=>withProducerToken(identity,()=>assert.fail("must not publish"),{...f,now}),error=>error.diagnostic.stage==="installation_read"&&error.diagnostic.outcome==="not_started"&&error.diagnostic.retryable===(kind==="fail")&&!JSON.stringify(error.diagnostic).includes(token));
 }
});

test("explicit 403 rate limits remain retryable before the proposal starts",async()=>{
 for(const route of ["/repos/"+REPOSITORY+"/installation","/app/installations/9/access_tokens","/installation/repositories?per_page=2"]){
  for(const headers of [{"x-ratelimit-remaining":"0"},{"retry-after":"60"}]){
   const f=authFixture(),fetcher=f.fetcher;let rejected=0;
   f.fetcher=async(url,options)=>new URL(url).pathname+new URL(url).search===route?(rejected++,{ok:false,status:403,headers:new Headers(headers),json:()=>assert.fail('never read an authentication error body')}):fetcher(url,options);
   await assert.rejects(()=>withProducerToken(identity,()=>assert.fail('no proposal'),{...f,now}),error=>error.diagnostic.code==='rate_limited'&&error.diagnostic.retryable===true&&error.diagnostic.outcome==='not_started');
   assert.equal(rejected,1);
   if(route.startsWith('/installation/'))assert.equal(f.calls.at(-1).method,'DELETE');
  }
 }
});

test("explicit 429 issuance rejection is retryable but uncertain issuance is not",async()=>{
 for(const status of [429,403,408,503]){
  const f=authFixture(),fetcher=f.fetcher;let rejected=0;
  f.fetcher=async(url,options)=>options.method==='POST'?(rejected++,{ok:false,status,headers:new Headers(),json:()=>assert.fail('never read error body')}):fetcher(url,options);
  await assert.rejects(()=>withProducerToken(identity,()=>assert.fail('no proposal'),{...f,now}),error=>error.diagnostic.stage==='token_issue'&&error.diagnostic.retryable===(status===429));
  assert.equal(rejected,1);
 }
});

test('authentication retains the later retry/reset deadline through token cleanup',async()=>{
 for(const route of ['/repos/'+REPOSITORY+'/installation','/app/installations/9/access_tokens','/installation/repositories?per_page=2']){
  const f=authFixture(),fetcher=f.fetcher;
  f.fetcher=async(url,options)=>new URL(url).pathname+new URL(url).search===route?{ok:false,status:403,headers:new Headers({'retry-after':'60','x-ratelimit-remaining':'0','x-ratelimit-reset':String(time/1000+3600)}),json:()=>assert.fail('never read error body')}:fetcher(url,options);
  await assert.rejects(()=>withProducerToken(identity,()=>assert.fail('no proposal'),{...f,now}),error=>error.diagnostic.retryable===true&&error.diagnostic.retry_at===time+3600000&&error.diagnostic.provider_scope===(route.startsWith('/installation/')?'github.producer':'github.app'));
 }
});

test('headerless secondary throttling is recoverable at every pre-proposal authentication stage',async()=>{
 for(const route of ['/repos/'+REPOSITORY+'/installation','/app/installations/9/access_tokens','/installation/repositories?per_page=2']){
  const f=authFixture(),fetcher=f.fetcher;
  f.fetcher=async(url,options)=>new URL(url).pathname+new URL(url).search===route?Response.json({message:'You have exceeded a secondary rate limit.',private_detail:token},{status:403,headers:{'x-ratelimit-remaining':'100'}}):fetcher(url,options);
  await assert.rejects(()=>withProducerToken(identity,()=>assert.fail('no proposal'),{...f,now}),error=>error.diagnostic.code==='rate_limited'&&error.diagnostic.retryable===true&&error.diagnostic.retry_at===time+60000&&!JSON.stringify(error.diagnostic).includes(token));
  if(route.startsWith('/installation/'))assert.equal(f.calls.at(-1).method,'DELETE');
 }
});

test("rate-limited revocation cannot authorize another proposal",async()=>{
 const f=authFixture(),fetcher=f.fetcher;let proposals=0,revocations=0;
 f.fetcher=async(url,options)=>options.method==='DELETE'?(revocations++,{ok:false,status:403,headers:new Headers({'x-ratelimit-remaining':'0'})}):fetcher(url,options);
 await assert.rejects(()=>withProducerToken(identity,()=>{proposals++;return 'created';},{...f,now}),error=>error.diagnostic.stage==='token_revoke'&&error.diagnostic.retryable===false&&error.diagnostic.outcome==='unknown');
 assert.equal(proposals,1);assert.equal(revocations,1);
});

test('transient pre-write failure plus failed cleanup waits for validated token expiry without becoming permanent',async()=>{
 for(const site of ['scope','proposal']){
  const f=authFixture(),fetcher=f.fetcher;let used=0;
  f.fetcher=async(url,options)=>{if(options.method==='DELETE'||site==='scope'&&new URL(url).pathname==='/installation/repositories')throw Error('fixture outage '+token);return fetcher(url,options);};
  await assert.rejects(withProducerToken(identity,()=>{used++;throw operationError('fixture read outage',{stage:'read_main',code:'transport',outcome:'not_started',retryable:true});},{...f,now}),error=>error.diagnostic.stage==='token_revoke'&&error.diagnostic.retryable===true&&error.diagnostic.outcome==='not_started'&&error.diagnostic.cleanup_after===time+3660000&&!JSON.stringify(error.diagnostic).includes(token));
  assert.equal(used,site==='scope'?0:1);
 }
 const f=authFixture();f.fail='/installation/token';
 await assert.rejects(withProducerToken(identity,()=>{throw operationError('permanent validation',{stage:'read_main',code:'identity_mismatch'});},{...f,now}),error=>error.diagnostic.retryable===false);
});
