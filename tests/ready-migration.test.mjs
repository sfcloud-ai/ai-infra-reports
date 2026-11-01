import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,chmod,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {HandoffState,handoffScope} from "../scripts/handoff-state.mjs";
import {NoticeOutbox,notificationScope} from "../scripts/notice-outbox.mjs";
import {digest} from "../scripts/archive.mjs";
import {planReadyMigration,stageReadyMigration,verifyReadyMigration} from "../scripts/ready-migration.mjs";
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),"readiness-migration-")),oldDir=path.join(root,"old");await mkdir(oldDir,{mode:0o700});
 const before={team_id:"T123",channel_id:"C123",sender_user_id:"U123",bot_user_id:"U456",bot_id:"B456",producer_app_id:10,merger_app_id:11,slack_token_file:path.join(root,"slack-token"),producer_key_file:path.join(root,"producer-key"),state_dir:oldDir,ready_for_review:false};
 const after={...before,state_dir:path.join(root,"new"),ready_for_review:true};
 const file=path.join(oldDir,"handoff.sqlite"),state=new HandoffState(file,handoffScope(before)),bytes=Buffer.from("preserved opaque report bytes");
 state.admit({request_id:"original-report-01",source_ts:"1793448000.000001",hash:digest(bytes)},bytes);state.move("original-report-01","received","receipt_sent",{commit:"a".repeat(40),receipt_ts:"1793448500.000001"});state.close();await chmod(file,0o600);
 return {root,file,before,after,clean:()=>rm(root,{recursive:true,force:true})};
}
test("staging preserves original bytes, jobs and scope; copied state accepts ready config only",async()=>{
 const f=await fixture();try{
  const original=await readFile(f.file),plan=await planReadyMigration(f.before,f.after);
  assert.deepEqual(await readFile(f.file),original);
  const staged=await stageReadyMigration(f.before,f.after,plan.data_sha256);assert.equal(staged.activated,false);
  assert.deepEqual(await readFile(f.file),original);
  assert.equal((await verifyReadyMigration(f.before,f.after,plan.data_sha256)).verified,true);
  const old=new HandoffState(f.file,handoffScope(f.before)),fresh=new HandoffState(path.join(f.after.state_dir,"handoff.sqlite"),handoffScope(f.after));
  try{assert.deepEqual(fresh.get("original-report-01"),old.get("original-report-01"));assert.deepEqual(fresh.pending(),[]);}finally{old.close();fresh.close();}
  await assert.rejects(()=>stageReadyMigration(f.before,f.after,plan.data_sha256),/EEXIST/);
 }finally{await f.clean();}
});
test("identity, destination, keys and unrelated config cannot piggyback on a readiness migration",async()=>{
 const f=await fixture();try{
  for(const patch of [{sender_user_id:"U999"},{producer_app_id:99},{channel_id:"C999"},{producer_key_file:path.join(f.root,"other")},{notification_destination:"D123",notification_not_before:"1793447000.000001"},{state_dir:f.before.state_dir},{ready_for_review:false}])await assert.rejects(()=>planReadyMigration(f.before,{...f.after,...patch}));
 }finally{await f.clean();}
});
test("pending report and uncertain notification/control writes prevent migration",async()=>{
 const f=await fixture();try{
  let state=new HandoffState(f.file,handoffScope(f.before));state.move("original-report-01","receipt_sent","proposal_unknown",{});state.close();
  await assert.rejects(()=>planReadyMigration(f.before,f.after),/Pending report/);
  state=new HandoffState(f.file,handoffScope(f.before));state.move("original-report-01","proposal_unknown","receipt_sent",{});
  const outbox=new NoticeOutbox(state,notificationScope({...f.before,notification_destination:"D123",notification_not_before:"1793447000.000001"}));
  outbox.db.prepare("INSERT INTO notices VALUES (?,?,?,?,?,?)").run("2026-10-31/r1","original-report-01","attempt-01","F123","send_unknown","{}");state.close();
  await assert.rejects(()=>planReadyMigration(f.before,f.after),/Unresolved notification/);
  state=new HandoffState(f.file,handoffScope(f.before));state.db.exec("UPDATE notices SET phase='sender_reported'; INSERT INTO notice_commands VALUES ('command-01','hash','1793448001.000001',X'00','response_unknown','{}',NULL)");state.close();
  await assert.rejects(()=>planReadyMigration(f.before,f.after),/Unresolved control receipt/);
 }finally{await f.clean();}
});
test("completed outbox dedup data survives migration and a new sender claim remains blocked",async()=>{
 const f=await fixture();try{
  f.before.notification_destination="D123";f.after.notification_destination="D123";f.before.notification_not_before="1793447000.000001";f.after.notification_not_before="1793447000.000001";
  const state=new HandoffState(f.file,handoffScope(f.before)),outbox=new NoticeOutbox(state,notificationScope(f.before));
  outbox.db.prepare("INSERT INTO notices VALUES (?,?,?,?,?,?)").run("2026-10-31/r1","original-report-01","attempt-01","F123","sender_reported",'{"sender_receipt":{"message_ts":"1793448500.000001"}}');
  const expected=outbox.notice("original-report-01");state.close();
  const plan=await planReadyMigration(f.before,f.after);await stageReadyMigration(f.before,f.after,plan.data_sha256);
  const copied=new HandoffState(path.join(f.after.state_dir,"handoff.sqlite"),handoffScope(f.after));
  try{assert.deepEqual(new NoticeOutbox(copied,notificationScope(f.after)).notice("original-report-01"),expected);}finally{copied.close();}
 }finally{await f.clean();}
});
test("source changes after planning or staging invalidate the activation check",async()=>{
 const f=await fixture();try{
  const plan=await planReadyMigration(f.before,f.after);await stageReadyMigration(f.before,f.after,plan.data_sha256);
  const state=new HandoffState(f.file,handoffScope(f.before));state.move("original-report-01","receipt_sent","receipt_sent",{receipt_ts:"1793448600.000001"});state.close();
  await assert.rejects(()=>verifyReadyMigration(f.before,f.after,plan.data_sha256),/Original state moved/);
  await assert.rejects(()=>stageReadyMigration(f.before,{...f.after,state_dir:path.join(f.root,"another")},plan.data_sha256),/changed since reviewed plan/);
 }finally{await f.clean();}
});
test("unexpected triggers cannot run while rebinding a staged scope",async()=>{
 const f=await fixture();try{
  const state=new HandoffState(f.file,handoffScope(f.before));state.db.exec("CREATE TRIGGER unexpected AFTER UPDATE ON scope BEGIN DELETE FROM jobs; END");state.close();
  await assert.rejects(()=>planReadyMigration(f.before,f.after),/triggers/);
  const check=new HandoffState(f.file,handoffScope(f.before));try{assert(check.get("original-report-01"));}finally{check.close();}
 }finally{await f.clean();}
});
