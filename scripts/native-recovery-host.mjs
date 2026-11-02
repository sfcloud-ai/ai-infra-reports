import {digest} from './archive.mjs';
import {decodeBundle,requireThat} from './report-handoff.mjs';
import {NativeScheduledHost} from './native-scheduled-host.mjs';
import {ReadPending,ReconciliationRequired} from './cloud-sender.mjs';
import {nativeCompletionArguments} from './native-notice.mjs';
import {readRecoveryFence} from './native-recovery-fence.mjs';
const hash=x=>digest(Buffer.from(JSON.stringify(x)));
export class NativeRecoveryHost extends NativeScheduledHost {
 #grant;
 async step(id){
  requireThat(this.allowFinal,'Explicit final-recovery execution is disabled');
  let job=this.state.get(id);const fence=readRecoveryFence(this.state,id),binding=fence.binding;
  requireThat(job&&job.input_hash===binding.original_input_hash&&job.edition===binding.edition&&digest(job.bundle)===binding.bundle_sha256&&job.detail.report_commit===binding.report_commit&&hash(this.state.scope)===binding.scope_sha256,'Recovery source changed');
  if(['final_pending','native_reconcile','sender_reported'].includes(job.phase))return super.step(id);
  requireThat(!this.state.op(id,'final_complete'),'A final completion intent already exists');
  const b=await decodeBundle(job.bundle),config=this.config(job);
  if(job.phase==='recovery_fenced'){
   requireThat(hash(job.detail)===binding.original_detail_sha256,'Fenced original detail changed');
   let generation=0;
   while(this.state.op(id,`recovery:authorization:negative:${generation}`)?.phase==='acknowledged')generation++;
   const status=await this.control(job,'status',{},`recovery:authorization:${generation}`);
   const authorization=status.receipt.recovery;
   requireThat(!status.receipt.send_authorized,'Status cannot authorize recovery');
   if(!authorization){
    await this.once(id,`recovery:authorization:negative:${generation}`,{command_sha256:digest(status.bytes)},async()=>null);
    throw new ReadPending('Explicit operator recovery approval is not available; no upload was started');
   }
   requireThat(authorization.phase==='approved'&&authorization.recovery_id===binding.recovery_id&&authorization.fence_sha256===fence.binding_sha256&&authorization.original_begin_sha256===binding.original_begin_sha256,'Recovery authorization differs or was already consumed');
   this.boundNotice(job,b,status.receipt,'completion_intent');
   await this.verifyPublication(job,b);
   const op=await this.once(id,'recovery:upload',{bundle_sha256:b.hash},()=>this.transport.upload(job.bundle,'ai-brief-bundle.json'));
   if(op.phase!=='acknowledged')throw new ReconciliationRequired('Recovery upload outcome unknown; never upload another file');
   requireThat(op.result.file_id!==binding.old_file_id,'Recovery needs its own newly recorded upload');
   this.state.move(id,job.phase,'recovery_uploaded',{...job.detail,file_id:op.result.file_id,attempt_id:binding.recovery_id,recovery_id:binding.recovery_id,fence_sha256:fence.binding_sha256});
  }else if(job.phase==='recovery_uploaded'){
   const prior=this.state.op(id,'native:recovery:begin:command');
   if(prior&&prior.result?.owner!==this.session){this.state.move(id,job.phase,'native_reconcile',job.detail);return this.state.get(id);}
   await this.verifyPublication(job,b);
   const fields={attempt_id:binding.recovery_id,file_id:job.detail.file_id,fence_sha256:fence.binding_sha256,original_begin_sha256:binding.original_begin_sha256};
   const grant=await this.control(job,'recover_begin',fields,'recovery:begin');
   this.boundNotice(job,b,grant.receipt,'completion_intent');
   requireThat(grant.receipt.send_authorized&&grant.receipt.reason==='recovery_completion_intent','Fresh recovery grant required');
   this.#grant=grant;this.state.move(id,job.phase,'recovery_final_ready',job.detail);
  }else if(job.phase==='recovery_final_ready'){
   const op=this.state.op(id,'native:recovery:begin:command');
   if(op?.result?.owner!==this.session||!this.#grant){this.state.move(id,job.phase,'native_reconcile',job.detail);return this.state.get(id);}
   const at=this.now();await this.verifyPublication(job,b);
   if(this.now()<at||this.now()-at>60000)throw new ReadPending('Recovery publication proof expired; refresh reads');
   const args=()=>nativeCompletionArguments(this.#grant.invocation,{bytes:this.#grant.bytes,sourceTs:this.#grant.sourceTs,config,
    reportJson:b.files.get(b.report.path+'report.json'),poster:b.files.get(b.report.path+b.report.poster),bundleBytes:job.bundle,checkedAt:at,now:this.now()});
   const input=args(),db=this.state.db;db.exec('BEGIN IMMEDIATE');
   let started=false;
   try{
    const current=this.state.get(id);
    requireThat(current.phase==='recovery_final_ready'&&hash(current.detail)===hash(job.detail)&&current.input_hash===binding.original_input_hash,'Recovery ownership changed');
    args();requireThat(!this.state.op(id,'final_complete'),'Final completion already allocated');
    requireThat(this.state.begin(id,'final_complete',input),'Final completion already allocated');
    requireThat(this.state.move(id,'recovery_final_ready','final_pending',job.detail),'Recovery fence changed');
    db.exec('COMMIT');started=true;
   }catch(e){db.exec('ROLLBACK');throw e;}
   if(started){
    try{await this.transport.complete(args());this.state.settle(id,'final_complete','acknowledged',null);}
    catch{this.state.settle(id,'final_complete','unknown',null);}
    this.#grant=undefined;
   }
  }else throw new ReconciliationRequired('Original run was not explicitly fenced for recovery');
  return this.state.get(id);
 }
}
