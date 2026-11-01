import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {readReports,digest} from "../scripts/archive.mjs";
import {encodeBundle,decodeBundle} from "../scripts/report-handoff.mjs";
import {HandoffState,handoffScope} from "../scripts/handoff-state.mjs";
import {NoticeOutbox,notificationScope,decodeNoticeCommand,acceptNoticeCommand,advanceNotice,noticeResponseText} from "../scripts/notice-outbox.mjs";
import {encodeNoticeCommand,verifyNoticeGrant} from "../scripts/notice-command.mjs";
import {SlackHandoff} from "../scripts/slack-handoff.mjs";
import {validateConfig,handoffTick} from "../scripts/run-handoff.mjs";
const request="morning-2030-01-01",merge="d".repeat(40),ts="1793448000.000001";
const config={team_id:"T123",channel_id:"C123",sender_user_id:"U123",bot_user_id:"U456",bot_id:"B456",producer_app_id:10,merger_app_id:11,slack_token_file:path.resolve("slack-token"),producer_key_file:path.resolve("producer-key"),state_dir:path.resolve("state"),ready_for_review:false,notification_destination:"D123",notification_not_before:"1793447000.000001"};
const dir="reports/2026-10-31/r1/",files=new Map([...await readReports("tests/fixtures/archive")].filter(([p])=>p.startsWith(dir)));
const png=await sharp({create:{width:20,height:20,channels:3,background:"white"}}).png().toBuffer();
const report=JSON.parse(files.get(dir+"report.json"));report.poster="assets/poster.png";report.images=[{path:report.poster,sha256:digest(png),alt:"Test poster"}];
files.set(dir+"report.json",Buffer.from(JSON.stringify(report)));files.set(dir+report.poster,png);
const bytes=await encodeBundle(files,request,"a".repeat(40),"b".repeat(40)),bundle=await decodeBundle(bytes);
const proof={publication_status:"verified",commit:merge,request_id:request,bundle_sha256:bundle.hash,edition:"2026-10-31/r1",url:"https://sfcloud-ai.github.io/ai-infra-reports/2026-10-31/r1/",poster_sha256:digest(png)};
const claim=(id="claim-command-01",attempt="scheduled-attempt-01",file="F111")=>({schema_version:"1.0",command_id:id,action:"claim",report_request_id:request,bundle_sha256:bundle.hash,attempt_id:attempt,file_id:file});
function rig(filename=":memory:"){
 const state=new HandoffState(filename,handoffScope(config));
 if(!state.get(request)){state.admit({request_id:request,hash:bundle.hash,source_ts:ts},bytes);state.move(request,"received","receipt_sent",{commit:merge,proof,receipt_ts:ts});}
 const outbox=new NoticeOutbox(state,notificationScope(config)),sent=[];
 const io={verify:async()=>proof,receipt:async(thread,text)=>{sent.push({thread,text});return "1793448500.000001";},findReceipt:async()=>{throw Error("not found");}};
 return {state,outbox,io,sent};
}
function admit(r,c,source="1793448100.000001"){
 const data=encodeNoticeCommand(c);r.outbox.admit({request_id:c.command_id,hash:digest(data),source_ts:source},data);return data;
}
test("outbox is opt-in, destination is independently bound, and old report scope stays stable",()=>{
 const {notification_destination,notification_not_before,...old}=config;
 assert.deepEqual(handoffScope(validateConfig(config)),handoffScope(validateConfig(old)));
 assert.throws(()=>validateConfig({...config,notification_destination:"COTHER"}));
 const r=rig();assert.throws(()=>new NoticeOutbox(r.state,{...notificationScope(config),destination:"DOTHER"}),/scope changed/);r.state.close();
});
test("notice data transport reuses strict pinned sender and rejects extra authority or bad identity",()=>{
 const c=claim(),data=encodeNoticeCommand(c),command=`!ai-notice submit ${c.command_id} ${digest(data)}`;
 const m={type:"message",subtype:"file_share",user:"U123",ts,text:command,files:[{id:"F123"}]};
 assert.equal(acceptNoticeCommand(m,config,Number(ts)*1000).request_id,c.command_id);
 for(const patch of [{user:"U999"},{bot_id:"B999"},{edited:{}},{thread_ts:"1793447000.000001"},{text:command+" extra"}])assert.throws(()=>acceptNoticeCommand({...m,...patch},config,Number(ts)*1000));
 for(const patch of [{destination:"DOTHER"},{action:"retry"},{action:["claim"]},{attempt_id:"bad"},{file_id:12},{bundle_sha256:1}])assert.throws(()=>decodeNoticeCommand(Buffer.from(JSON.stringify({...c,...patch}))));
});
test("only verified publication can reserve one edition, and a second attempt never receives permission",async()=>{
 const r=rig();try{
  const c=claim();admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);
  assert.equal(r.outbox.command(c.command_id).response.send_authorized,true);
  const other=claim("claim-command-02","scheduled-attempt-02","F222");admit(r,other,"1793448101.000001");await advanceNotice(r.outbox,other.command_id,r.io);
  assert.equal(r.outbox.command(other.command_id).response.send_authorized,false);assert.equal(r.outbox.notice(request).attempt_id,c.attempt_id);
  assert.equal(r.sent.length,2);assert(r.sent.every(s=>s.thread.startsWith("179344810")));
 }finally{r.state.close();}
 for(const change of [p=>p.commit="f".repeat(40),p=>p.poster_sha256="0".repeat(64),p=>p.url="https://other.example/",p=>p.bundle_sha256="0".repeat(64)]){
  const r=rig();try{const c=claim(),bad=structuredClone(proof);change(bad);admit(r,c);await assert.rejects(()=>advanceNotice(r.outbox,c.command_id,{...r.io,verify:async()=>bad}));assert.equal(r.outbox.notice(request),null);assert.equal(r.sent.length,0);}finally{r.state.close();}
 }
});
test("two connections racing for an edition reserve it once",async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),"notice-race-")),file=path.join(tmp,"state.sqlite");
 const a=rig(file),b=rig(file);
 try{const ca=claim(),cb=claim("claim-command-02","scheduled-attempt-02","F222");admit(a,ca);admit(b,cb,"1793448101.000001");await Promise.all([advanceNotice(a.outbox,ca.command_id,a.io),advanceNotice(b.outbox,cb.command_id,b.io)]);assert.equal([a.outbox.command(ca.command_id),b.outbox.command(cb.command_id)].filter(c=>c.response.send_authorized).length,1);}finally{a.state.close();b.state.close();await rm(tmp,{recursive:true,force:true});}
});
test("enabling a new outbox cannot grant already published pre-activation reports",async()=>{
 const state=new HandoffState(":memory:",handoffScope(config));
 try{
  state.admit({request_id:request,hash:bundle.hash,source_ts:ts},bytes);state.move(request,"received","receipt_sent",{commit:merge,proof});
  const outbox=new NoticeOutbox(state,notificationScope({...config,notification_not_before:ts})),c=claim();
  admit({outbox},c);
  await assert.rejects(()=>advanceNotice(outbox,c.command_id,{verify:()=>assert.fail("historical report must stop before network verification"),receipt:()=>assert.fail("no grant")}),/Pre-activation/);
  assert.equal(outbox.notice(request),null);
 }finally{state.close();}
});
test("lost control response survives restart, resolves through reads, and is never resent",async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),"notice-recovery-")),file=path.join(tmp,"state.sqlite"),c=claim();let r=rig(file),sentText;
 try{
  admit(r,c);await assert.rejects(()=>advanceNotice(r.outbox,c.command_id,{...r.io,receipt:async(t,text)=>{sentText=text;throw Error("timeout after send");}}),/unknown/);
  assert.equal(r.outbox.command(c.command_id).phase,"response_unknown");r.state.close();r=rig(file);
  await assert.rejects(()=>advanceNotice(r.outbox,c.command_id,r.io),/not found/);assert.equal(r.sent.length,0);
  await advanceNotice(r.outbox,c.command_id,{...r.io,findReceipt:async(t,text)=>{assert.equal(t,"1793448100.000001");assert.equal(text,sentText);return "1793448500.000001";}});
  assert.equal(r.outbox.command(c.command_id).phase,"response_sent");assert.equal(r.sent.length,0);
 }finally{r.state.close();await rm(tmp,{recursive:true,force:true});}
});
test("unknown final send only reconciles to a sender report, never a fresh attempt or WeCom success",async()=>{
 const r=rig();try{
  const c=claim();admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);
  const unknown={...c,command_id:"unknown-command-01",action:"unknown"};admit(r,unknown,"1793448101.000001");await advanceNotice(r.outbox,unknown.command_id,r.io);
  assert.equal(r.outbox.notice(request).phase,"send_unknown");
  const record={...c,command_id:"record-command-01",action:"record",message_ts:"1793448700.000001",text_sha256:r.outbox.notice(request).detail.text_sha256,transport_sha256:digest(png),transport_bytes:png.length};
  admit(r,record,"1793448102.000001");await advanceNotice(r.outbox,record.command_id,r.io);
  const response=r.outbox.command(record.command_id).response;assert.equal(response.send_authorized,false);assert.equal(response.slack_status,"sender_reported");assert.equal(response.wecom_status,"not_checked");
  const replay={...c,command_id:"claim-command-03",attempt_id:"scheduled-attempt-03",file_id:"F333"};admit(r,replay,"1793448103.000001");await advanceNotice(r.outbox,replay.command_id,r.io);assert.equal(r.outbox.command(replay.command_id).response.send_authorized,false);
 }finally{r.state.close();}
});
test("client rejects spoofed, edited, wrong-destination and replay-denial grants",async()=>{
 const r=rig();try{
  const c=claim(),data=admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);
  const m={type:"message",user:"U456",bot_id:"B456",ts:"1793448500.000001",thread_ts:"1793448100.000001",text:noticeResponseText(r.outbox.command(c.command_id).response)};
  const options={bytes:data,sourceTs:m.thread_ts,readContext:{team_id:"T123",channel_id:"C123"},config};
  assert.equal(verifyNoticeGrant(m,options).resume_send_allowed,false);
  for(const patch of [{user:"U999"},{bot_id:"B999"},{edited:{}},{thread_ts:ts},{team:"TOTHER"},{subtype:"message_changed"},{ts:m.thread_ts}])assert.throws(()=>verifyNoticeGrant({...m,...patch},options));
  assert.throws(()=>verifyNoticeGrant(m,{...options,config:{...config,notification_destination:"DOTHER"}}));
  const denied=structuredClone(r.outbox.command(c.command_id).response);denied.send_authorized=false;assert.throws(()=>verifyNoticeGrant({...m,text:noticeResponseText(denied)},options));
  for(const mutate of [n=>delete n.detail.poster_original_sha256,n=>n.detail.report_merge_sha="bad",n=>n.detail.text_sha256=1,n=>n.detail.resume_send_allowed=true,n=>n.detail.url="https://other.example/",n=>n.edition="../other"]){
   const bad=structuredClone(r.outbox.command(c.command_id).response);mutate(bad.notice);assert.throws(()=>verifyNoticeGrant({...m,text:noticeResponseText(bad)},options));
  }
 }finally{r.state.close();}
});
test("control reconciliation requires complete authenticated original thread and exact unedited reply",async()=>{
 const text="!ai-notice receipt {}",reply={type:"message",thread_ts:ts,ts:"1793448500.000001",text,bot_id:"B456",user:"U456"};
 const check=body=>new SlackHandoff(config,"fake",async(url,o)=>{assert.equal(o.method,"GET");assert.equal(new URL(url).searchParams.get("channel"),"C123");return Response.json({ok:true,...body});}).findControlReceipt(ts,text);
 assert.equal(await check({messages:[reply]}),reply.ts);
 for(const body of [{messages:[]},{messages:[reply,reply]},{messages:[reply],has_more:true},{messages:[{...reply,edited:{}}]},{messages:[{...reply,user:"U999"}]},{messages:[{...reply,team:"TOTHER"}]},{messages:[{...reply,subtype:"message_changed"}]},{messages:[{...reply,ts}]}])await assert.rejects(()=>check(body));
});
test("the serialized runtime ignores disabled notices, then admits and resumes the opt-in protocol",async()=>{
 const r=rig(),c=claim(),data=encodeNoticeCommand(c),source=(Date.now()/1000).toFixed(6);
 const message={type:"message",subtype:"file_share",user:config.sender_user_id,ts:source,text:`!ai-notice submit ${c.command_id} ${digest(data)}`,files:[{id:"FCOMMAND"}]};
 let downloads=0,replies=0;
 const slack={history:async()=>[message],download:async(e,options)=>{downloads++;assert.equal(options.name,"ai-notice-command.json");assert.equal(e.file_id,"FCOMMAND");return data;},controlReceipt:async()=>{replies++;return "1793448500.000001";},findControlReceipt:async()=>assert.fail("no recovery needed")};
 try{
  const {notification_destination,notification_not_before,...disabled}=config;
  assert.deepEqual(await handoffTick(r.state,disabled,slack,r.io),{phase:"idle"});assert.equal(downloads,0);
  assert.equal((await handoffTick(r.state,config,slack,r.io)).phase,"response_sent");
  assert.equal((await handoffTick(r.state,config,slack,r.io)).phase,"idle");assert.equal(downloads,1);assert.equal(replies,1);
 }finally{r.state.close();}
});

test("an unrelated open PR cannot starve completed-report claims, status or records",async()=>{
 const r=rig(),c=claim();let polls=0,replies=0;
 const pending="pending-report-02",nextBytes=await encodeBundle(files,pending,"a".repeat(40),"b".repeat(40));
 r.state.admit({request_id:pending,hash:digest(nextBytes),source_ts:"1793448001.000001"},nextBytes);
 r.state.move(pending,"received","pr_open",{pr:"https://github.com/sfcloud-ai/ai-infra-reports/pull/2",head:"c".repeat(40)});
 const slack={history:async()=>[],controlReceipt:async()=>{replies++;return "1793448500.000001";}};
 const io={...r.io,readPR:async()=>{polls++;return {number:2,head:{sha:"c".repeat(40),repo:{full_name:"sfcloud-ai/ai-infra-reports"}},base:{ref:"main",repo:{full_name:"sfcloud-ai/ai-infra-reports"}},merged:false,state:"open"};}};
 try{
  admit(r,c);let result=await handoffTick(r.state,config,slack,io);
  assert.equal(result.phase,"pr_open");assert.equal(result.notice.phase,"response_sent");assert.equal(r.outbox.command(c.command_id).response.send_authorized,true);
  const status={schema_version:"1.0",command_id:"status-command-01",action:"status",report_request_id:request,bundle_sha256:bundle.hash};
  admit(r,status,"1793448101.000001");result=await handoffTick(r.state,config,slack,io);assert.equal(result.notice.phase,"response_sent");
  const record={...c,command_id:"record-command-01",action:"record",message_ts:"1793448700.000001",text_sha256:r.outbox.notice(request).detail.text_sha256,transport_sha256:digest(png),transport_bytes:png.length};
  admit(r,record,"1793448102.000001");result=await handoffTick(r.state,config,slack,io);
  assert.equal(result.phase,"pr_open");assert.equal(result.notice.phase,"response_sent");assert.equal(r.outbox.notice(request).phase,"sender_reported");assert.equal(polls,3);assert.equal(replies,3);
 }finally{r.state.close();}
});

test("a claim awaiting its report advances publication without granting early",async()=>{
 const r=rig(),c=claim();let receipts=0;
 r.state.move(request,"receipt_sent","verified",{commit:merge,proof});admit(r,c);
 const slack={history:async()=>[],controlReceipt:async()=>{receipts++;return "1793448500.000001";}};
 try{
  const first=await handoffTick(r.state,config,slack,r.io);
  assert.equal(first.phase,"receipt_sent");assert.equal(r.outbox.command(c.command_id).phase,"received");assert.equal(receipts,0);
  assert.equal((await handoffTick(r.state,config,slack,r.io)).phase,"response_sent");assert.equal(receipts,1);
 }finally{r.state.close();}
});

async function enqueueWaitingClaim(r){
 const pending="pending-report-02",nextBytes=await encodeBundle(files,pending,"a".repeat(40),"b".repeat(40));
 r.state.admit({request_id:pending,hash:digest(nextBytes),source_ts:"1793448001.000001"},nextBytes);
 r.state.move(pending,"received","pr_open",{pr:"https://github.com/sfcloud-ai/ai-infra-reports/pull/2",head:"c".repeat(40)});
 const waiting={...claim("waiting-claim-02","waiting-attempt-02","F222"),report_request_id:pending,bundle_sha256:digest(nextBytes)};
 admit(r,waiting,"1793448099.000001");return waiting;
}

test("a waiting claim at the front cannot block later completed-report status or records",async()=>{
 const r=rig(),c=claim();let polls=0,replies=0;
 const slack={history:async()=>[],controlReceipt:async()=>{replies++;return "1793448500.000001";}};
 const io={...r.io,readPR:async()=>{polls++;return {number:2,head:{sha:"c".repeat(40),repo:{full_name:"sfcloud-ai/ai-infra-reports"}},base:{ref:"main",repo:{full_name:"sfcloud-ai/ai-infra-reports"}},merged:false,state:"open"};}};
 try{
  admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);const waiting=await enqueueWaitingClaim(r);
  const status={schema_version:"1.0",command_id:"status-command-01",action:"status",report_request_id:request,bundle_sha256:bundle.hash};
  const record={...c,command_id:"record-command-01",action:"record",message_ts:"1793448700.000001",text_sha256:r.outbox.notice(request).detail.text_sha256,transport_sha256:digest(png),transport_bytes:png.length};
  admit(r,status,"1793448101.000001");admit(r,record,"1793448102.000001");
  assert.equal((await handoffTick(r.state,config,slack,io)).notice.command_id,status.command_id);
  assert.equal((await handoffTick(r.state,config,slack,io)).notice.command_id,record.command_id);
  assert.equal((await handoffTick(r.state,config,slack,io)).phase,"pr_open");
  assert.equal(r.outbox.command(waiting.command_id).phase,"received");assert.equal(r.outbox.notice(waiting.report_request_id),null);
  assert.equal(r.outbox.notice(request).phase,"sender_reported");assert.equal(polls,3);assert.equal(replies,2);
 }finally{r.state.close();}
});

test("unknown control writes remain barriers even when an earlier waiting claim becomes eligible",async()=>{
 for(const phase of ["response_sending","response_unknown"]){
  const r=rig(),c=claim();let reads=0;
  try{
   const waiting=await enqueueWaitingClaim(r);admit(r,c);
   await assert.rejects(()=>advanceNotice(r.outbox,c.command_id,{...r.io,receipt:async()=>{throw Error("lost response");}}),/unknown/);
   if(phase==="response_sending")assert(r.outbox.move(c.command_id,"response_unknown","response_sending"));
   const status={schema_version:"1.0",command_id:"status-command-01",action:"status",report_request_id:request,bundle_sha256:bundle.hash};admit(r,status,"1793448101.000001");
   // This older claim is now eligible; the uncertain write must still win.
   r.state.move(waiting.report_request_id,"pr_open","receipt_sent",{commit:merge});
   const slack={history:async()=>[],controlReceipt:async()=>assert.fail("no fresh response"),findControlReceipt:async(thread)=>{reads++;assert.equal(thread,"1793448100.000001");throw Error("unreconciled control write");}};
   await assert.rejects(()=>handoffTick(r.state,config,slack,{verify:async()=>assert.fail("no fresh grant")}),/unreconciled/);
   assert.equal(reads,1);assert.equal(r.outbox.command(waiting.command_id).phase,"received");assert.equal(r.outbox.command(status.command_id).phase,"received");
   assert.equal(r.outbox.command(c.command_id).phase,phase);assert.equal(r.outbox.notice(waiting.report_request_id),null);
  }finally{r.state.close();}
 }
});
test("new reservations bind every article title and URL with no summaries",async()=>{
 const r=rig();try{
  const c=claim();admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);
  const text=`AI Infra 晨报 · ${report.date}\n\n`+report.articles.map(a=>`${a.title}\n${proof.url}${a.id}/`).join("\n\n");
  assert.equal(r.outbox.notice(request).detail.text_sha256,digest(Buffer.from(text)));
  assert.notEqual(r.outbox.notice(request).detail.text_sha256,digest(Buffer.from(`AI Infra 晨报 · ${report.date} · ${report.subtitle}\n\n${proof.url}`)));
 }finally{r.state.close();}
});
test("pre-upgrade reservations retain their exact digest and never gain another send grant",async()=>{
 const r=rig();try{
  const old={bundle_sha256:bundle.hash,report_merge_sha:merge,url:proof.url,poster_original_sha256:proof.poster_sha256,text_sha256:digest(Buffer.from(`AI Infra 晨报 · ${report.date} · ${report.subtitle}\n\n${proof.url}`)),destination:config.notification_destination};
  r.state.db.prepare("INSERT INTO notices VALUES (?,?,?,?,'reserved',?)").run("2026-10-31/r1",request,"legacy-attempt-01","FOLD",JSON.stringify(old));
  const c=claim();admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);
  const response=r.outbox.command(c.command_id).response;
  assert.equal(response.send_authorized,false);assert.equal(response.reason,"already_reserved");
  assert.deepEqual(r.outbox.notice(request).detail,old);
  const record={schema_version:"1.0",command_id:"legacy-record-01",action:"record",report_request_id:request,bundle_sha256:bundle.hash,attempt_id:"legacy-attempt-01",file_id:"FOLD",message_ts:"1793448700.000001",text_sha256:old.text_sha256,transport_sha256:digest(png),transport_bytes:png.length};
  admit(r,record,"1793448102.000001");await advanceNotice(r.outbox,record.command_id,r.io);
  assert.equal(r.outbox.notice(request).phase,"sender_reported");assert.equal(r.outbox.notice(request).detail.text_sha256,old.text_sha256);
 }finally{r.state.close();}
});
test("new sender records reject changed poster bytes even if a sender claims equivalent pixels",async()=>{
 const r=rig();try{
  const c=claim();admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);
  const before=r.outbox.notice(request);
  const record={...c,command_id:"altered-record-01",action:"record",message_ts:"1793448700.000001",text_sha256:before.detail.text_sha256,transport_sha256:"f".repeat(64),transport_bytes:png.length};
  admit(r,record,"1793448101.000001");await assert.rejects(()=>advanceNotice(r.outbox,record.command_id,r.io),/poster bytes/);
  assert.deepEqual(r.outbox.notice(request),before);assert.equal(r.outbox.command(record.command_id).phase,"received");
 }finally{r.state.close();}
});
test("legacy sender-reported transformed-image receipts stay immutable and grant no permission",async()=>{
 const r=rig();try{
  const c=claim();admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);
  const before=r.outbox.notice(request),receipt={message_ts:"1793448700.000001",file_id:c.file_id,text_sha256:before.detail.text_sha256,transport_sha256:"f".repeat(64),transport_bytes:png.length};
  const detail={...before.detail,sender_receipt:receipt};delete detail.poster_policy;
  r.state.db.prepare("UPDATE notices SET phase='sender_reported',detail=? WHERE report_id=?").run(JSON.stringify(detail),request);
  const old=r.outbox.notice(request),record={...c,command_id:"legacy-image-record",action:"record",...receipt};
  admit(r,record,"1793448101.000001");await advanceNotice(r.outbox,record.command_id,r.io);
  assert.deepEqual(r.outbox.notice(request),old);assert.equal(r.outbox.command(record.command_id).response.send_authorized,false);
  const conflict={...record,command_id:"legacy-image-conflict",transport_sha256:digest(png)};
  admit(r,conflict,"1793448102.000001");await assert.rejects(()=>advanceNotice(r.outbox,conflict.command_id,r.io),/Conflicting/);
  assert.deepEqual(r.outbox.notice(request),old);
  const another=claim("legacy-image-newclaim","legacy-image-newattempt","FNEW");
  admit(r,another,"1793448103.000001");await advanceNotice(r.outbox,another.command_id,r.io);
  assert.equal(r.outbox.command(another.command_id).response.send_authorized,false);assert.deepEqual(r.outbox.notice(request),old);
 }finally{r.state.close();}
});
test("legacy pending reservations reconcile transformed bytes after restart without another send grant",async()=>{
 for(const phase of ["reserved","send_unknown"]){
  const tmp=await mkdtemp(path.join(os.tmpdir(),"legacy-notice-")),filename=path.join(tmp,"state.sqlite");let r=rig(filename);
  try{
   const detail={bundle_sha256:bundle.hash,report_merge_sha:merge,url:proof.url,poster_original_sha256:proof.poster_sha256,text_sha256:digest(Buffer.from("immutable old text")),destination:config.notification_destination};
   r.state.db.prepare("INSERT INTO notices VALUES (?,?,?,?,?,?)").run("2026-10-31/r1",request,"legacy-attempt-01","FOLD",phase,JSON.stringify(detail));
   r.state.close();r=rig(filename);
   const c=claim();admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);
   assert.equal(r.outbox.command(c.command_id).response.send_authorized,false);
   const record={schema_version:"1.0",command_id:"legacy-record-01",action:"record",report_request_id:request,bundle_sha256:bundle.hash,attempt_id:"legacy-attempt-01",file_id:"FOLD",message_ts:"1793448700.000001",text_sha256:detail.text_sha256,transport_sha256:"f".repeat(64),transport_bytes:png.length};
   admit(r,record,"1793448101.000001");await advanceNotice(r.outbox,record.command_id,r.io);
   const notice=r.outbox.notice(request);assert.equal(notice.phase,"sender_reported");
   assert.equal(notice.detail.text_sha256,detail.text_sha256);assert.equal(notice.detail.sender_receipt.transport_sha256,record.transport_sha256);
   assert.equal(Object.hasOwn(notice.detail,"poster_policy"),false);assert.equal(r.outbox.command(record.command_id).response.send_authorized,false);
  }finally{r.state.close();await rm(tmp,{recursive:true,force:true});}
 }
});
test("new grants require persisted byte policy and commands cannot choose legacy behavior",async()=>{
 const r=rig();try{
  const c=claim(),data=admit(r,c);await advanceNotice(r.outbox,c.command_id,r.io);
  const response=r.outbox.command(c.command_id).response;
  assert.equal(response.notice.detail.poster_policy,"original_bytes_v1");
  const message={type:"message",user:"U456",bot_id:"B456",ts:"1793448500.000001",thread_ts:"1793448100.000001"};
  const options={bytes:data,sourceTs:message.thread_ts,readContext:{team_id:"T123",channel_id:"C123"},config};
  for(const value of [undefined,null,"legacy","original_bytes_v2"]){
   const old=structuredClone(response);if(value===undefined)delete old.notice.detail.poster_policy;else old.notice.detail.poster_policy=value;
   assert.throws(()=>verifyNoticeGrant({...message,text:noticeResponseText(old)},options),/proof/);
  }
  assert.throws(()=>encodeNoticeCommand({...c,poster_policy:"legacy"}),/fields/);
  const notice=r.outbox.notice(request);notice.detail.poster_policy="unknown_future_policy";
  r.state.db.prepare("UPDATE notices SET detail=? WHERE report_id=?").run(JSON.stringify(notice.detail),request);
  const record={...c,command_id:"unknown-policy-record",action:"record",message_ts:"1793448700.000001",text_sha256:notice.detail.text_sha256,transport_sha256:digest(png),transport_bytes:png.length};
  admit(r,record,"1793448101.000001");await assert.rejects(()=>advanceNotice(r.outbox,record.command_id,r.io),/Unknown persisted/);
  assert.equal(r.outbox.notice(request).phase,"reserved");
 }finally{r.state.close();}
});
