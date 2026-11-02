// Explicit, single successor for an ungranted recovery control command.
// Unknown Slack writes remain unknown. A server fence makes a late old command
// powerless; it is not inferred absent from Slack search results.
import {digest} from './archive.mjs';
import {requireThat,REQUEST} from './report-handoff.mjs';
import {freshNativeCommand} from './native-notice.mjs';
import {readRecoveryFence} from './native-recovery-fence.mjs';
const hash=x=>digest(Buffer.from(JSON.stringify(x)));
export const SUCCESSOR_SCHEMA=[
 "CREATE TABLE recovery_control_successors (report_id TEXT PRIMARY KEY, successor_id TEXT UNIQUE NOT NULL, plan TEXT NOT NULL, plan_sha256 TEXT NOT NULL, authorization TEXT NOT NULL)",
 "CREATE TRIGGER recovery_successor_no_update BEFORE UPDATE ON recovery_control_successors BEGIN SELECT RAISE(ABORT,'Immutable recovery successor'); END",
 "CREATE TRIGGER recovery_successor_no_delete BEFORE DELETE ON recovery_control_successors BEGIN SELECT RAISE(ABORT,'Immutable recovery successor'); END"
];
export const SUCCESSOR_GUARD="CREATE TRIGGER recovery_successor_grant_guard BEFORE UPDATE ON notice_recovery_authorizations WHEN NEW.phase='consumed' AND EXISTS(SELECT 1 FROM recovery_control_successors WHERE report_id=NEW.report_id) BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM recovery_control_successors s JOIN notice_commands c ON c.id=NEW.grant_command_id WHERE s.report_id=NEW.report_id AND json_extract(s.plan,'$.command_id')=NEW.grant_command_id AND json_extract(s.plan,'$.command_sha256')=c.hash AND json_extract(s.plan,'$.file_id')=NEW.replacement_file_id) THEN RAISE(ABORT,'Recovery command permanently fenced') END; END";
export function installRecoverySuccessor(db,{publisher=false}={}){for(const s of SUCCESSOR_SCHEMA)db.exec(s.replace(/^CREATE (TABLE|TRIGGER) /,'CREATE $1 IF NOT EXISTS '));if(publisher)db.exec(SUCCESSOR_GUARD.replace('CREATE TRIGGER ','CREATE TRIGGER IF NOT EXISTS '));}
export function successorSchemaObjects(db){
 const rows=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name IN ('recovery_control_successors','recovery_successor_grant_guard') OR tbl_name='recovery_control_successors' AND type='trigger' ORDER BY name").all();
 if(!rows.length)return [];
 requireThat(rows.length===SUCCESSOR_SCHEMA.length+1&&rows.every(r=>[...SUCCESSOR_SCHEMA,SUCCESSOR_GUARD].includes(r.sql)),'Unexpected recovery successor schema');return rows;
}
export function recoverySuccessor(db,id){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery_control_successors'").get())return null;
 const r=db.prepare('SELECT * FROM recovery_control_successors WHERE report_id=?').get(id);
 if(!r)return null;
 requireThat(hash(JSON.parse(r.plan))===r.plan_sha256,'Recovery successor audit changed');
 return {...r,plan:JSON.parse(r.plan),authorization:JSON.parse(r.authorization)};
}
export function verifySuccessorPlan(plan){
 const p=plan?.binding;
 requireThat(p&&hash(p)===plan.binding_sha256&&p.schema_version==='1.0'&&REQUEST.test(p.successor_id)&&hash(p.original_detail)===p.detail_sha256,'Invalid recovery successor plan');
 const oldBytes=Buffer.from(p.old_command_base64,'base64'),newBytes=Buffer.from(p.command_base64,'base64');
 requireThat(digest(oldBytes)===p.old_command_sha256&&digest(newBytes)===p.command_sha256,'Successor command digest changed');
 const old=JSON.parse(oldBytes),next=JSON.parse(newBytes);
 requireThat(old.action==='recover_begin'&&next.action==='recover_begin'&&old.command_id===p.old_command_id&&next.command_id===p.command_id&&old.command_id!==next.command_id,'Successor must replace only one recovery control command');
 const fields=['schema_version','action','report_request_id','bundle_sha256','attempt_id','file_id','fence_sha256','original_begin_sha256'];
 requireThat(Object.keys(old).sort().join()===Object.keys(next).sort().join()&&fields.every(k=>old[k]===next[k]),'Successor changed immutable notification binding');
 requireThat(next.report_request_id===p.report_id&&next.bundle_sha256===p.bundle_sha256&&next.file_id===p.file_id&&next.attempt_id===p.recovery_id&&next.fence_sha256===p.fence_sha256,'Successor plan binding differs');
 return {p,old,next,newBytes};
}
export function planRecoverySuccessor(state,id,successorId){
 requireThat(typeof successorId==='string'&&REQUEST.test(successorId),'Explicit successor identity required');
 const job=state.get(id),fence=readRecoveryFence(state,id),command=state.op(id,'native:recovery:begin:command'),share=state.op(id,'native:recovery:begin:share'),upload=state.op(id,'recovery:upload');
 requireThat(job?.phase==='recovery_uploaded'&&!state.op(id,'final_complete'),'Only an unstarted recovery control is eligible');
 requireThat(command?.phase==='acknowledged'&&command.result?.bytes&&command.result?.owner&&share?.phase==='unknown'&&upload?.phase==='acknowledged'&&upload.result?.file_id===job.detail.file_id,'Unknown control evidence and known original replacement upload required');
 requireThat(!recoverySuccessor(state.db,id),'A control successor already exists');
 const oldBytes=Buffer.from(command.result.bytes,'base64'),old=JSON.parse(oldBytes);
 requireThat(old.action==='recover_begin'&&old.report_request_id===id&&old.file_id===job.detail.file_id&&old.attempt_id===fence.recovery_id&&old.fence_sha256===fence.binding_sha256&&old.bundle_sha256===digest(job.bundle),'Original recovery command changed');
 const {command_id,...fields}=old,{schema_version,action,...input}=fields;
 const next=freshNativeCommand('recover_begin',input),c=JSON.parse(next);
 const p={schema_version:'1.0',successor_id:successorId,report_id:id,recovery_id:fence.recovery_id,fence_sha256:fence.binding_sha256,bundle_sha256:digest(job.bundle),file_id:job.detail.file_id,report_commit:job.detail.report_commit,input_hash:job.input_hash,detail_sha256:hash(job.detail),original_detail:job.detail,old_owner:command.result.owner,old_command_id:old.command_id,old_command_sha256:digest(oldBytes),old_command_base64:oldBytes.toString('base64'),command_id:c.command_id,command_sha256:digest(next),command_base64:next.toString('base64')};
 return {binding:p,binding_sha256:hash(p)};
}
export function fenceRecoverySuccessor(state,plan,authorization){
 const {p}=verifySuccessorPlan(plan);
 requireThat(authorization?.owner_stopped===true&&typeof authorization.reference==='string'&&authorization.reference.length>0,'Explicit stopped-owner attestation required');
 const db=state.db;db.exec('BEGIN IMMEDIATE');
 try{
  installRecoverySuccessor(db);
  const job=state.get(p.report_id),old=state.op(p.report_id,'native:recovery:begin:command');
  requireThat(job?.phase==='recovery_uploaded'&&job.input_hash===p.input_hash&&hash(job.detail)===p.detail_sha256&&digest(job.bundle)===p.bundle_sha256&&!state.op(job.id,'final_complete'),'Original recovery changed before successor fence');
  requireThat(old?.phase==='acknowledged'&&old.result.owner===p.old_owner&&old.result.bytes===p.old_command_base64&&state.op(job.id,'native:recovery:begin:share')?.phase==='unknown'&&!recoverySuccessor(db,job.id),'Original unknown control changed');
  db.prepare('INSERT INTO recovery_control_successors VALUES(?,?,?,?,?)').run(job.id,p.successor_id,JSON.stringify(p),plan.binding_sha256,JSON.stringify(authorization));
  db.exec('COMMIT');return plan;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
// Recover the original persisted fence result without allocating another fence.
export function inspectRecoverySuccessor(state,id,successorId,{owner_stopped=false}={}){
 requireThat(owner_stopped===true,'Explicit stopped-owner attestation required');
 const row=recoverySuccessor(state.db,id);
 requireThat(row?.successor_id===successorId&&row.authorization.owner_stopped===true&&typeof row.authorization.reference==='string'&&row.authorization.reference.length>0,'Original successor authorization missing');
 const plan={binding:row.plan,binding_sha256:row.plan_sha256},{p}=verifySuccessorPlan(plan),fence=readRecoveryFence(state,id);
 const job=state.get(id),old=state.op(id,'native:recovery:begin:command'),upload=state.op(id,'recovery:upload');
 requireThat(p.report_id===id&&p.recovery_id===fence.recovery_id&&p.fence_sha256===fence.binding_sha256,'Original recovery fence differs');
 requireThat(job?.phase==='recovery_uploaded'&&job.input_hash===p.input_hash&&hash(job.detail)===p.detail_sha256&&digest(job.bundle)===p.bundle_sha256&&!state.op(id,'final_complete'),'Original successor source changed');
 requireThat(old?.phase==='acknowledged'&&old.result?.owner===p.old_owner&&old.result?.bytes===p.old_command_base64&&state.op(id,'native:recovery:begin:share')?.phase==='unknown'&&upload?.phase==='acknowledged'&&upload.result?.file_id===p.file_id,'Original successor evidence changed');
 requireThat(!state.op(id,'native:recovery:successor:begin:command')&&!state.op(id,'native:recovery:successor:begin:share'),'Successor already started; reconcile its original operations');
 return plan;
}
// A T4 local operator calls this after publication and relay checks. The source
// is the successful fence from the ORIGINAL cloud journal, not a plan alone.
export function authorizeRecoverySuccessor(outbox,plan,authorization){
 const {p,old}=verifySuccessorPlan(plan);
 requireThat(authorization?.owner_stopped===true&&authorization.publisher_verified===true&&authorization.relay_requests===0&&Number.isSafeInteger(authorization.checked_at)&&typeof authorization.reference==='string'&&authorization.reference.length>0,'Checked successor authorization required');
 const db=outbox.db;db.exec('BEGIN IMMEDIATE');
 try{
  installRecoverySuccessor(db,{publisher:true});
  const row=db.prepare('SELECT * FROM notice_recovery_authorizations WHERE report_id=?').get(p.report_id),n=outbox.notice(p.report_id),job=outbox.state.get(p.report_id);
  requireThat(row?.phase==='approved'&&row.recovery_id===p.recovery_id&&row.binding_sha256===p.fence_sha256&&!row.grant_command_id&&!row.replacement_file_id,'Recovery grant was already issued or changed');
  const b=JSON.parse(row.binding);
  requireThat(n&&JSON.stringify(n)===row.original_notice&&n.phase==='completion_intent'&&!n.detail.sender_receipt&&job?.hash===p.bundle_sha256&&job.detail.commit===p.report_commit&&old.original_begin_sha256===b.original_begin_sha256,'Original notice or publication changed');
  const prior=outbox.command(p.old_command_id);
  requireThat(!prior||(prior.hash===p.old_command_sha256&&digest(prior.bytes)===prior.hash&&prior.phase==='received'&&!prior.response),'Old recovery command may already have a grant');
  requireThat(!outbox.command(p.command_id)&&!recoverySuccessor(db,p.report_id),'Successor already admitted or authorized');
  db.prepare('INSERT INTO recovery_control_successors VALUES(?,?,?,?,?)').run(p.report_id,p.successor_id,JSON.stringify(p),plan.binding_sha256,JSON.stringify(authorization));
  db.exec('COMMIT');return plan;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
// Must be checked INSIDE the same transaction that consumes the authorization.
export function recoveryCommandAllowed(outbox,c){
 const r=recoverySuccessor(outbox.db,c.report_request_id);if(!r)return true;
 const p=r.plan,op=outbox.command(c.command_id);
 return c.command_id===p.command_id&&op?.hash===p.command_sha256&&digest(op.bytes)===p.command_sha256&&c.file_id===p.file_id&&c.attempt_id===p.recovery_id&&c.fence_sha256===p.fence_sha256;
}
