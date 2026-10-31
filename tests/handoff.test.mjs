import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {readReports,digest,REPOSITORY} from "../scripts/archive.mjs";
import {encodeBundle,decodeBundle,acceptMessage,boundedBytes,verifyReportPublication,MAX_BUNDLE} from "../scripts/report-handoff.mjs";
import {HandoffState} from "../scripts/handoff-state.mjs";
import {advanceHandoff} from "../scripts/handoff-worker.mjs";
import {SlackHandoff,publicGitHub} from "../scripts/slack-handoff.mjs";
import {validateConfig} from "../scripts/run-handoff.mjs";
import {propose} from "../scripts/propose.mjs";
import {FakeGitHub} from "./helpers/fake-github.mjs";
const base="a".repeat(40),prompt="b".repeat(40),head="c".repeat(40),merge="d".repeat(40),tree="e".repeat(40);
const root="reports/2026-10-31/r1/",request="morning-2026-10-31",ts="1793448000.000001",now=Number(ts)*1000;
const config={team_id:"T123",channel_id:"C123",sender_user_id:"U123",bot_user_id:"U456",bot_id:"B456",producer_app_id:10,merger_app_id:11,slack_token_file:path.resolve("slack-token"),producer_key_file:path.resolve("producer-key"),state_dir:path.resolve("state"),ready_for_review:false};
const files=new Map([...await readReports("tests/fixtures/archive")].filter(([p])=>p.startsWith(root)));
const png=await sharp({create:{width:20,height:20,channels:3,background:"white"}}).png().toBuffer();
const report=JSON.parse(files.get(root+"report.json"));report.poster="assets/poster.png";report.images=[{path:report.poster,sha256:digest(png),alt:"Test poster"}];
files.set(root+"report.json",Buffer.from(JSON.stringify(report)));files.set(root+report.poster,png);
const bytes=await encodeBundle(files,request,base,prompt),bundle=await decodeBundle(bytes);
const event={request_id:request,source_ts:ts,hash:digest(bytes),file_id:"F123"};
const message={type:"message",subtype:"file_share",user:"U123",ts,text:`!ai-report publish ${request} ${event.hash}`,files:[{id:"F123"}]};
const proof={publication_status:"verified",commit:merge,url:"https://sfcloud-ai.github.io/ai-infra-reports/2026-10-31/r1/",bundle_sha256:event.hash,request_id:request,delivery_allowed:false};
function rig(state=new HandoffState(":memory:",config)){
 state.admit(event,bytes);let proposals=0,receipts=0,verified=0;
 const io={propose:async()=>{proposals++;return {url:`https://github.com/${REPOSITORY}/pull/4`,sha:head};},readPR:async()=>({number:4,state:"closed",merged:true,merge_commit_sha:merge,head:{sha:head,repo:{full_name:REPOSITORY}},base:{ref:"main",repo:{full_name:REPOSITORY}}}),readCommit:async sha=>({sha,tree:{sha:tree},parents:[{sha:base}]}),verify:async()=>{verified++;return proof;},receipt:async()=>{receipts++;return "1793448300.000001";}};
 return {state,io,counts:()=>({proposals,receipts,verified})};
}
test("transport round-trip is data-only and feeds the existing validating publisher",async()=>{
 assert.equal(bundle.data.prompt_commit_sha,prompt);assert.equal(bundle.files.size,files.size);
 const api=new FakeGitHub();const result=await propose(api,bundle.files,api.base);
 assert.match(result.url,/\/pull\//);assert.equal(api.pulls[0].draft,true);
});
test("bundle rejects extra authority fields, traversal, undeclared files, hash drift and duplicate paths",async()=>{
 for(const mutate of [d=>d.token="secret",d=>d.files[0].path="../x",d=>d.files[0].sha256="0".repeat(64),d=>d.files.push(d.files[0]),d=>d.files[0].base64+="\n",d=>d.repository="other/repo"]){
  const d=JSON.parse(bytes);mutate(d);await assert.rejects(()=>decodeBundle(Buffer.from(JSON.stringify(d))));
 }
 await assert.rejects(()=>decodeBundle(Buffer.alloc(MAX_BUNDLE+1)),/byte limit/);
 const noPoster=new Map(files);const r={...report,poster:null};noPoster.set(root+"report.json",Buffer.from(JSON.stringify(r)));
 await assert.rejects(()=>encodeBundle(noPoster,request,base,prompt),/poster/);
});
test("intake pins authenticated human sender and rejects edits, threads, bots, stale and malformed commands",()=>{
 assert.deepEqual(acceptMessage(message,config,now),event);assert.equal(acceptMessage({text:"!ai-brief x ping"},config,now),null);
 assert.deepEqual(acceptMessage({...message,thread_ts:ts},config,now),event);
 for(const patch of [{user:"U999"},{edited:{}},{hidden:true},{thread_ts:"1793447999.000001"},{bot_id:"B456"},{app_id:"A123"},{subtype:"message_changed"},{ts:"1.000000"},{files:[]},{text:message.text+" extra"}])assert.throws(()=>acceptMessage({...message,...patch},config,now));
});
test("durable intake rejects changed/reposted request IDs and mismatched identities after reopening",async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"handoff-test-")),filename=path.join(dir,"state.sqlite");
 let state;
 try{
  state=new HandoffState(filename,config);state.admit(event,bytes);state.admit(event,bytes);
  assert.equal(state.pending().length,1);assert.throws(()=>state.admit({...event,source_ts:"1793448001.000001"},bytes),/reused/);
  state.move(request,"received","proposing",{});state.close();state=null;
  state=new HandoffState(filename,Object.fromEntries(Object.entries(config).reverse()));assert.equal(state.get(request).phase,"proposing");assert.deepEqual(state.pending(),[request]);state.close();state=null;
  assert.throws(()=>new HandoffState(filename,{...config,channel_id:"C999"}),/identity changed/);
 }finally{state?.close();await rm(dir,{recursive:true,force:true});}
});
test("one request reaches the receipt only after exact merge and repeated publication verification",async()=>{
 const {state,io,counts}=rig();try{
  for(const phase of ["pr_open","merged","verified","receipt_sent"]){await advanceHandoff(state,request,io);assert.equal(state.get(request).phase,phase);}
  await advanceHandoff(state,request,io);assert.deepEqual(counts(),{proposals:1,receipts:1,verified:2});
 }finally{state.close();}
});
test("unmerged, mismatched head/base/tree or closed PR never yields a publication receipt",async()=>{
 for(const kind of ["open","head","repository","tree","parent","closed"]){
  const {state,io,counts}=rig();try{
   await advanceHandoff(state,request,io);const read=io.readPR,commit=io.readCommit;
   io.readPR=async()=>{const p=await read();if(kind==="open"){p.merged=false;p.state="open";}if(kind==="closed")p.merged=false;if(kind==="head")p.head.sha=base;if(kind==="repository")p.head.repo.full_name="wrong/repo";return p;};
   io.readCommit=async sha=>{const c=await commit(sha);if(sha===merge&&kind==="tree")c.tree.sha=base;if(sha===merge&&kind==="parent")c.parents[0].sha=head;return c;};
   if(kind==="open")await advanceHandoff(state,request,io);else await assert.rejects(()=>advanceHandoff(state,request,io));
   assert.equal(state.get(request).phase,"pr_open");assert.equal(counts().receipts,0);
  }finally{state.close();}
 }
});
test("unknown proposals and receipts remain blocked across subsequent ticks",async()=>{
 for(const stage of ["propose","receipt"]){
  const {state,io,counts}=rig();try{
   if(stage==="receipt")for(let i=0;i<3;i++)await advanceHandoff(state,request,io);
   let attempts=0;io[stage]=async()=>{attempts++;throw Error("response lost after mutation");};
   await assert.rejects(()=>advanceHandoff(state,request,io),/reconciliation/);
   await assert.rejects(()=>advanceHandoff(state,request,io),/reconciliation/);assert.equal(attempts,1);assert.equal(state.get(request).phase,stage==="propose"?"proposal_unknown":"receipt_unknown");assert.equal(counts().receipts,0);
  }finally{state.close();}
 }
});
test("an unresolved mutation is a queue barrier for later requests",async()=>{
 for(const phase of ["proposing","proposal_unknown","sending","receipt_unknown"]){
  const {state,io,counts}=rig();try{
   state.move(request,"received",phase,{});
   const later=await encodeBundle(files,"later-request",base,prompt);
   state.admit({request_id:"later-request",hash:digest(later),source_ts:"1793448002.000001"},later);
   assert.deepEqual(state.pending(),[request,"later-request"]);
   await assert.rejects(()=>advanceHandoff(state,state.pending()[0],io),/reconciliation/);
   assert.equal(state.get("later-request").phase,"received");assert.equal(counts().proposals,0);
  }finally{state.close();}
 }
});
test("concurrent ticks cannot claim the same proposal or receipt twice",async()=>{
 const {state,io,counts}=rig();try{
  await Promise.allSettled([advanceHandoff(state,request,io),advanceHandoff(state,request,io)]);
  assert.equal(state.get(request).phase,"pr_open");assert.equal(counts().proposals,1);
  await advanceHandoff(state,request,io);await advanceHandoff(state,request,io);
  await Promise.allSettled([advanceHandoff(state,request,io),advanceHandoff(state,request,io)]);
  assert.equal(state.get(request).phase,"receipt_sent");assert.equal(counts().receipts,1);
 }finally{state.close();}
});
test("publication failure remains retryable without re-proposing or sending early",async()=>{
 const {state,io,counts}=rig();try{
  await advanceHandoff(state,request,io);await advanceHandoff(state,request,io);
  const verify=io.verify;io.verify=async()=>{throw Error("not deployed yet");};
  await assert.rejects(()=>advanceHandoff(state,request,io));assert.equal(state.get(request).phase,"merged");
  io.verify=verify;await advanceHandoff(state,request,io);io.verify=async()=>{throw Error("changed while waiting");};
  await assert.rejects(()=>advanceHandoff(state,request,io));assert.equal(state.get(request).phase,"verified");assert.equal(counts().receipts,0);assert.equal(counts().proposals,1);
 }finally{state.close();}
});
function site(kind){return async url=>{
 if(url.endsWith("publication.json"))return Response.json({schema_version:"1.0",commit:kind==="stale"?base:merge,preview:false,reports:["2026-10-31/r1"]});
 if(url.endsWith(".png"))return new Response(kind==="image"?Buffer.from("corrupt"):png,{headers:{"content-type":"image/png"}});
 const id=url.split("/ai-infra-reports/")[1].replace(/\/$/,"");
 return new Response(`<main data-report-id="${kind==="article"&&id.includes("kv-cache")?"wrong":id}"><section data-report-sources></section></main>`,{headers:{"content-type":"text/html"}});
};}
test("public verification covers every article and asset, exact deployment, and never asserts notification delivery",async()=>{
 const result=await verifyReportPublication(merge,bundle,site());assert.equal(result.delivery_allowed,false);assert.equal(result.poster_sha256,digest(png));
 for(const kind of ["stale","article","image"])await assert.rejects(()=>verifyReportPublication(merge,bundle,site(kind)));
 await assert.rejects(()=>boundedBytes(new Response("too much"),3),/byte limit/);
});
const file={id:"F123",user:"U123",name:"ai-brief-bundle.json",mode:"hosted",size:bytes.length,shares:{private:{C123:[{ts}]}},url_private_download:"https://files.slack.com/files-pri/T123-F123/ai-brief-bundle.json"};
test("Slack file transport sends credentials only to pinned Slack origins with redirects forbidden",async()=>{
 const calls=[];const slack=new SlackHandoff(config,"fake",async(url,options)=>{calls.push([url,options]);return url.startsWith("https://slack.com/")?Response.json({ok:true,file}):new Response(bytes);});
 assert.deepEqual(await slack.download(event),bytes);assert.equal(calls.length,2);assert(calls.every(([,o])=>o.redirect==="error"));
 for(const change of [{url_private_download:"https://evil.example/f"},{user:"U999"},{is_external:true},{shares:{private:{C999:[{ts}]}}},{size:MAX_BUNDLE+1}]){
  let n=0;const s=new SlackHandoff(config,"fake",async()=>{n++;return Response.json({ok:true,file:{...file,...change}});});
  await assert.rejects(()=>s.download(event));assert.equal(n,1);
 }
});
test("Slack preflight rejects expanded scopes, shared channels, wrong bot and incomplete history",async()=>{
 for(const bad of [null,"scopes","channel","mpim","bot","history"]){
  const s=new SlackHandoff(config,"fake",async url=>{
   if(url.includes("auth.test"))return Response.json({ok:true,team_id:"T123",user_id:"U456",bot_id:bad==="bot"?"B999":"B456"},{headers:{"x-oauth-scopes":"chat:write,files:read,groups:history,groups:read"+(bad==="scopes"?",im:history":"")}});
   if(url.includes("conversations.info"))return Response.json({ok:true,channel:{id:"C123",is_private:true,is_member:true,is_shared:bad==="channel",is_mpim:bad==="mpim"}});
   return Response.json({ok:true,messages:[message],has_more:bad==="history"});
  });
  if(["scopes","channel","mpim","bot"].includes(bad))await assert.rejects(()=>s.preflight());else{await s.preflight();if(bad==="history")await assert.rejects(()=>s.history(now));else assert.equal((await s.history(now)).length,1);}
 }
});
test("receipt stays in the pinned thread; changed response identity is rejected",async()=>{
 let sent;const s=new SlackHandoff(config,"fake",async(url,o)=>{sent=JSON.parse(o.body);return Response.json({ok:true,channel:"C123",ts,message:{thread_ts:ts,bot_id:"B456",user:"U456",text:sent.text}});});
 assert.equal(await s.receipt(ts,proof),ts);assert.equal(sent.channel,"C123");assert.equal(sent.thread_ts,ts);assert.equal(sent.unfurl_links,false);assert.equal(sent.parse,"none");
 const bad=new SlackHandoff(config,"fake",async()=>Response.json({ok:true,channel:"C999",ts}));await assert.rejects(()=>bad.receipt(ts,proof));
});
test("publisher config and public GitHub adapter cannot broaden identity or token scope",async()=>{
 assert.equal(validateConfig(config),config);assert.equal(validateConfig({...config,channel_id:"G123"}).channel_id,"G123");assert.throws(()=>validateConfig({...config,token:"unexpected"}));assert.throws(()=>validateConfig({...config,merger_app_id:10}));
 let called=false;await assert.rejects(()=>publicGitHub("/../other",async()=>{called=true;}));assert.equal(called,false);
 await publicGitHub("/pulls/4",async(url,o)=>{assert.equal(o.headers.authorization,undefined);assert(url.startsWith("https://api.github.com/repos/"+REPOSITORY+"/"));return Response.json({number:4});});
});
