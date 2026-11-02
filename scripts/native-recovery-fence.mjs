// Explicit first-completion recovery uses the ORIGINAL sender journal.
// The fence is permanent; it never resets a run or resumes an old grant.
import {digest} from './archive.mjs';
import {requireThat,decodeBundle,REQUEST} from './report-handoff.mjs';
const encode=value=>JSON.stringify(value);
const hash=value=>digest(Buffer.from(encode(value)));
const PREPARED=['native:poster','native:prepare_bundle:command','native:prepare_bundle:share','native:begin:command','native:begin:share'];
export function installRecoveryFence(state){
 state.db.exec(`CREATE TABLE IF NOT EXISTS native_recovery_fences (
  run_id TEXT PRIMARY KEY, recovery_id TEXT UNIQUE NOT NULL, binding TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL, original_phase TEXT NOT NULL, original_detail TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS native_recovery_fence_no_update BEFORE UPDATE ON native_recovery_fences BEGIN SELECT RAISE(ABORT,'Immutable recovery fence'); END;
  CREATE TRIGGER IF NOT EXISTS native_recovery_fence_no_delete BEFORE DELETE ON native_recovery_fences BEGIN SELECT RAISE(ABORT,'Immutable recovery fence'); END;`);
}
export function assertUnstartedNative(state,job){
 requireThat(job&&['final_ready','native_reconcile'].includes(job.phase),'Only an unstarted original completion is recoverable');
 requireThat(!state.op(job.id,'final_complete'),'Any final completion intent forbids recovery');
 const ops=state.db.prepare('SELECT name,phase FROM cloud_ops WHERE run_id=? ORDER BY name').all(job.id);
 requireThat(ops.length===PREPARED.length&&ops.every(o=>PREPARED.includes(o.name)&&o.phase==='acknowledged'),'Unknown or incomplete original operation history');
 requireThat(job.detail.mode==='native_bundle_v1'&&job.bundle&&digest(job.bundle)===job.detail.bundle_sha256,'Original report bundle is required');
 const begin=state.op(job.id,'native:begin:command');
 requireThat(typeof begin.result?.owner==='string'&&typeof begin.result?.bytes==='string','Original begin owner and bytes are required');
 const bytes=Buffer.from(begin.result.bytes,'base64'),c=JSON.parse(bytes);
 requireThat(c.action==='begin'&&c.report_request_id===job.id&&c.bundle_sha256===job.detail.bundle_sha256&&c.attempt_id===job.detail.attempt_id&&c.file_id===job.detail.file_id,'Original begin binding changed');
 return {command:c,command_sha256:digest(bytes),owner:begin.result.owner};
}
export async function nativeRecoveryPlan(state,id,recoveryId){
 requireThat(typeof recoveryId==='string'&&REQUEST.test(recoveryId),'Explicit recovery identity required');
 const job=state.get(id),begin=assertUnstartedNative(state,job);
 requireThat(recoveryId!==job.detail.attempt_id,'Recovery identity must differ from the original attempt');
 const bundle=await decodeBundle(job.bundle);
 requireThat(bundle.data.request_id===job.id&&`${bundle.report.date}/r${bundle.report.revision}`===job.edition,'Original edition changed');
 const binding={schema_version:'1.0',recovery_id:recoveryId,report_id:job.id,edition:job.edition,
  bundle_sha256:digest(job.bundle),report_commit:job.detail.report_commit,
  old_attempt_id:job.detail.attempt_id,old_file_id:job.detail.file_id,
  original_begin_id:begin.command.command_id,original_begin_sha256:begin.command_sha256,
  original_owner:begin.owner,original_input_hash:job.input_hash,original_detail_sha256:hash(job.detail),
  destination:state.scope.notification_destination,scope_sha256:hash(state.scope)};
 return {binding,binding_sha256:hash(binding)};
}
export async function fenceNativeRecovery(state,plan){
 installRecoveryFence(state);
 const fresh=await nativeRecoveryPlan(state,plan?.binding?.report_id,plan?.binding?.recovery_id);
 requireThat(encode(fresh)===encode(plan),'Recovery plan changed');
 const db=state.db;db.exec('BEGIN IMMEDIATE');
 try{
  const job=state.get(plan.binding.report_id);assertUnstartedNative(state,job);
  requireThat(job.input_hash===plan.binding.original_input_hash&&hash(job.detail)===plan.binding.original_detail_sha256,'Original journal changed before fencing');
  requireThat(!db.prepare('SELECT 1 FROM native_recovery_fences WHERE run_id=?').get(job.id),'Recovery already fenced');
  db.prepare('INSERT INTO native_recovery_fences VALUES(?,?,?,?,?,?)').run(job.id,plan.binding.recovery_id,encode(plan.binding),plan.binding_sha256,job.phase,encode(job.detail));
  requireThat(state.move(job.id,job.phase,'recovery_fenced',job.detail),'Could not fence original sender');
  db.exec('COMMIT');return plan;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function readRecoveryFence(state,id){
 const r=state.db.prepare('SELECT * FROM native_recovery_fences WHERE run_id=?').get(id);
 requireThat(r&&hash(JSON.parse(r.binding))===r.binding_sha256,'Original recovery fence unavailable');
 return {...r,binding:JSON.parse(r.binding),original_detail:JSON.parse(r.original_detail)};
}
