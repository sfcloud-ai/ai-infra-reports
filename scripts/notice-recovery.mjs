// Recovery grants are explicit operator decisions, not automatic upload retries.
import {digest} from './archive.mjs';
import {requireThat} from './report-handoff.mjs';
import {createNoticeManifest} from './notice-manifest.mjs';
const hash=v=>digest(Buffer.from(JSON.stringify(v)));
export const NOTICE_RECOVERY_SCHEMA=[
 "CREATE TABLE notice_recovery_authorizations (recovery_id TEXT PRIMARY KEY, report_id TEXT UNIQUE NOT NULL, binding TEXT NOT NULL, binding_sha256 TEXT NOT NULL, original_notice TEXT NOT NULL, authorization TEXT NOT NULL, phase TEXT NOT NULL, grant_command_id TEXT, replacement_file_id TEXT)",
 "CREATE TRIGGER notice_recovery_keep_evidence BEFORE UPDATE OF recovery_id,report_id,binding,binding_sha256,original_notice,authorization ON notice_recovery_authorizations BEGIN SELECT RAISE(ABORT,'Immutable recovery authorization'); END",
 "CREATE TRIGGER notice_recovery_no_delete BEFORE DELETE ON notice_recovery_authorizations BEGIN SELECT RAISE(ABORT,'Immutable recovery authorization'); END"
];
export function installNoticeRecovery(db){
 for(const sql of NOTICE_RECOVERY_SCHEMA)db.exec(sql.replace(/^CREATE (TABLE|TRIGGER) /,'CREATE $1 IF NOT EXISTS '));
}
// Recognize only this exact passive audit schema; unknown triggers still fail closed.
export function recoverySchemaObjects(db){
 const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name='notice_recovery_authorizations' OR tbl_name='notice_recovery_authorizations' AND type='trigger' ORDER BY name").all();
 if(!objects.length)return [];
 requireThat(objects.length===NOTICE_RECOVERY_SCHEMA.length&&objects.every(o=>NOTICE_RECOVERY_SCHEMA.includes(o.sql)),'Unexpected recovery audit schema');
 return objects;
}
export function noticeRecovery(outbox,id){
 if(!outbox.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notice_recovery_authorizations'").get())return null;
 const r=outbox.db.prepare('SELECT * FROM notice_recovery_authorizations WHERE report_id=?').get(id);
 return r?{...r,binding:JSON.parse(r.binding),original_notice:JSON.parse(r.original_notice),authorization:JSON.parse(r.authorization)}:null;
}
// Original identities remain reserved even after the active notice is replaced.
export function noticeIdentityReserved(outbox,attemptId,fileId){
 if(outbox.db.prepare('SELECT 1 FROM notices WHERE file_id=? OR attempt_id=?').get(fileId,attemptId))return true;
 if(!outbox.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notice_recovery_authorizations'").get())return false;
 return !!outbox.db.prepare("SELECT 1 FROM notice_recovery_authorizations WHERE json_extract(binding,'$.old_file_id')=? OR json_extract(binding,'$.old_attempt_id')=?").get(fileId,attemptId);
}
function originalNotice(outbox,plan){
 const b=plan?.binding,n=outbox.notice(b?.report_id),job=outbox.state.get(b?.report_id);
 requireThat(b&&hash(b)===plan.binding_sha256&&job&&job.hash===b.bundle_sha256&&job.detail.commit===b.report_commit&&n?.phase==='completion_intent'&&n.detail.delivery_mode==='native_bundle_v1','Original recovery source changed');
 requireThat(n.report_id===b.report_id&&n.edition===b.edition&&n.attempt_id===b.old_attempt_id&&n.file_id===b.old_file_id&&n.detail.destination===b.destination&&n.detail.destination===outbox.destination&&!n.detail.sender_receipt&&!n.detail.recovery,'Recovery must be the first completion of the original notice');
 const op=outbox.command(b.original_begin_id),c=op?JSON.parse(op.bytes):null;
 requireThat(op?.phase==='response_sent'&&op.hash===b.original_begin_sha256&&digest(op.bytes)===op.hash&&n.detail.completion_command_id===op.id&&n.detail.completion_command_sha256===op.hash&&c.action==='begin'&&c.report_request_id===b.report_id&&c.bundle_sha256===b.bundle_sha256&&c.file_id===b.old_file_id&&c.attempt_id===b.old_attempt_id&&op.response?.send_authorized===true&&op.response.reason==='new_completion_intent','Original persisted begin is required');
 return {notice:n,job};
}
// Only the local operator CLI calls this; it is never a control-channel action.
// Its plan comes from the original cloud journal after fencing, and the operator
// must verify that provenance. This record is authorization, not a cryptographic
// claim that a remote JSON object proves a filesystem write.
export function authorizeNoticeRecovery(outbox,plan,authorization){
 requireThat(authorization?.reference&&authorization.reference.length<=500&&Number.isSafeInteger(authorization.checked_at)&&authorization.relay_requests===0&&authorization.publisher_verified===true,'Explicit checked recovery authorization required');
 outbox.db.exec('BEGIN IMMEDIATE');
 try{
  installNoticeRecovery(outbox.db);
  const {notice}=originalNotice(outbox,plan);
  requireThat(!noticeRecovery(outbox,notice.report_id),'Recovery authorization already exists');
  outbox.db.prepare("INSERT INTO notice_recovery_authorizations VALUES(?,?,?,?,?,?,'approved',NULL,NULL)").run(plan.binding.recovery_id,notice.report_id,JSON.stringify(plan.binding),plan.binding_sha256,JSON.stringify(notice),JSON.stringify(authorization));
  outbox.db.exec('COMMIT');
 }catch(e){outbox.db.exec('ROLLBACK');throw e;}
}
// Called within NoticeOutbox's existing transaction after full public verification.
export function activateNoticeRecovery(outbox,c,job,bundle,proof){
 const r=noticeRecovery(outbox,job.id);
 requireThat(r?.phase==='approved'&&r.recovery_id===c.attempt_id&&r.binding_sha256===c.fence_sha256&&r.binding.original_begin_sha256===c.original_begin_sha256,'No matching unused operator recovery authorization');
 const {notice}=originalNotice(outbox,{binding:r.binding,binding_sha256:r.binding_sha256});
 requireThat(JSON.stringify(notice)===JSON.stringify(r.original_notice)&&c.file_id!==notice.file_id,'Recovery must retain the original notice and use its own new upload');
 requireThat(!noticeIdentityReserved(outbox,c.attempt_id,c.file_id),'Recovery upload or attempt already reserved');
 const manifest=createNoticeManifest(bundle.files.get(bundle.report.path+'report.json'),job.detail.commit);
 requireThat(proof.bundle_sha256===job.hash&&proof.poster_sha256===notice.detail.poster_original_sha256&&proof.url===notice.detail.url&&digest(Buffer.from(manifest.text))===notice.detail.text_sha256,'Recovered publication differs from original');
 const detail={...notice.detail,completion_command_id:c.command_id,completion_command_sha256:outbox.command(c.command_id).hash,
  recovery:{recovery_id:r.recovery_id,fence_sha256:r.binding_sha256,original_begin_sha256:r.binding.original_begin_sha256,original_file_id:notice.file_id,original_attempt_id:notice.attempt_id}};
 requireThat(outbox.db.prepare("UPDATE notice_recovery_authorizations SET phase='consumed',grant_command_id=?,replacement_file_id=? WHERE recovery_id=? AND phase='approved'").run(c.command_id,c.file_id,r.recovery_id).changes===1,'Recovery already consumed');
 requireThat(outbox.db.prepare("UPDATE notices SET attempt_id=?,file_id=?,detail=? WHERE report_id=? AND phase='completion_intent'").run(c.attempt_id,c.file_id,JSON.stringify(detail),job.id).changes===1,'Original notice changed during recovery');
}
export function checkRecoveryGrant(outbox,notice,command){
 const r=noticeRecovery(outbox,notice.report_id),d=notice.detail.recovery;
 requireThat(r?.phase==='consumed'&&r.grant_command_id===command.command_id&&r.replacement_file_id===notice.file_id&&r.recovery_id===notice.attempt_id&&d?.recovery_id===r.recovery_id&&d.fence_sha256===r.binding_sha256&&d.original_begin_sha256===r.binding.original_begin_sha256&&d.original_file_id===r.binding.old_file_id&&d.original_attempt_id===r.binding.old_attempt_id,'Recovery grant audit binding changed');
}
