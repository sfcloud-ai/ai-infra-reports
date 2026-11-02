import {digest} from './archive.mjs';
import {decodeBundle,requireThat} from './report-handoff.mjs';
import {NativeScheduledHost} from './native-scheduled-host.mjs';
import {ReadPending,ReconciliationRequired} from './cloud-sender.mjs';
import {nativeCompletionArguments} from './native-notice.mjs';
import {readRecoveryFence} from './native-recovery-fence.mjs';
import {recoverySuccessor,verifySuccessorPlan} from './recovery-control-successor.mjs';
const hash=x=>digest(Buffer.from(JSON.stringify(x)));
export class NativeRecoveryHost extends NativeScheduledHost {
 #grant;
 constructor(state,transport,options={}){super(state,transport,options);this.successorId=options.successorId;}
 successor(job){
  const r=recoverySuccessor(this.state.db,job.id);
  if(!r){requireThat(!this.successorId,'Explicit successor fence missing');return null;}
  requireThat(this.successorId===r.successor_id,'Old recovery executor is permanently fenced');
  const {p}=verifySuccessorPlan({binding:r.plan,binding_sha256:r.plan_sha256});
  const detail={...job.detail},expected={...p.original_detail};
  if(['final_pending','native_reconcile','sender_reported'].includes(job.phase)){delete detail.check_generation;delete expected.check_generation;}
  requireThat(job.input_hash===p.input_hash&&(job.phase==='sender_reported'||hash(detail)===hash(expected))&&digest(job.bundle)===p.bundle_sha256&&job.detail.file_id===p.file_id&&job.detail.report_commit===p.report_commit,'Successor source binding changed');
  return r;
 }
 async command(job,action,fields={},slot=action){
  const s=this.successor(job);
  if(!s||action!=='recover_begin')return super.command(job,action,fields,slot);
  requireThat(slot==='recovery:successor:begin','Unexpected successor command slot');
  const c=JSON.parse(Buffer.from(s.plan.command_base64,'base64'));
  requireThat(Object.entries(fields).every(([k,v])=>c[k]===v),'Successor command inputs differ');
  const input={action,report_request_id:job.id,bundle_sha256:job.detail.bundle_sha256,...fields};
  const op=await this.once(job.id,`native:${slot}:command`,input,async()=>({bytes:s.plan.command_base64,owner:this.session}));
  requireThat(op.phase==='acknowledged'&&op.result?.bytes===s.plan.command_base64,'Successor command journal differs');
  return {bytes:Buffer.from(op.result.bytes,'base64'),owner:op.result.owner};
 }
 async step(id,{deadline=Infinity}={}){
  requireThat(deadline===Infinity||Number.isSafeInteger(deadline)&&deadline>0,'Invalid recovery execution deadline');
  requireThat(this.allowFinal,'Explicit final-recovery execution is disabled');
  let job=this.state.get(id);const fence=readRecoveryFence(this.state,id),binding=fence.binding;
  const successor=this.successor(job),beginSlot=successor?'recovery:successor:begin':'recovery:begin';
  requireThat(job&&job.input_hash===binding.original_input_hash&&job.edition===binding.edition&&digest(job.bundle)===binding.bundle_sha256&&job.detail.report_commit===binding.report_commit&&hash(this.state.scope)===binding.scope_sha256,'Recovery source changed');
  if(['final_pending','native_reconcile','sender_reported'].includes(job.phase))return super.step(id,{deadline});
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
   const prior=this.state.op(id,`native:${beginSlot}:command`);
   if(prior&&prior.result?.owner!==this.session){if(successor)throw new ReconciliationRequired('Successor owner differs; observe without changing shared state');this.state.move(id,job.phase,'native_reconcile',job.detail);return this.state.get(id);}
   // Reserve time before allocating the one-shot command. An already allocated
   // command keeps polling under its live owner; no new grant is created.
   if(!prior&&this.now()+180000>=deadline)throw new ReadPending('Recovery execution slice ending before begin');
   await this.verifyPublication(job,b);
   if(!prior&&this.now()+180000>=deadline)throw new ReadPending('Recovery execution slice ending before begin');
   const fields={attempt_id:binding.recovery_id,file_id:job.detail.file_id,fence_sha256:fence.binding_sha256,original_begin_sha256:binding.original_begin_sha256};
   const grant=await this.control(job,'recover_begin',fields,beginSlot);
   this.boundNotice(job,b,grant.receipt,'completion_intent');
   requireThat(grant.receipt.send_authorized&&grant.receipt.reason==='recovery_completion_intent','Fresh recovery grant required');
   this.#grant=grant;this.state.move(id,job.phase,'recovery_final_ready',job.detail);
  }else if(job.phase==='recovery_final_ready'){
   const op=this.state.op(id,`native:${beginSlot}:command`);
   if(op?.result?.owner!==this.session||!this.#grant){if(successor)throw new ReconciliationRequired('Successor live grant unavailable; observe without changing shared state');this.state.move(id,job.phase,'native_reconcile',job.detail);return this.state.get(id);}
   const at=this.now();await this.verifyPublication(job,b);
   if(this.now()<at||this.now()-at>60000)throw new ReadPending('Recovery publication proof expired; refresh reads');
   const args=()=>nativeCompletionArguments(this.#grant.invocation,{bytes:this.#grant.bytes,sourceTs:this.#grant.sourceTs,config,
    reportJson:b.files.get(b.report.path+'report.json'),poster:b.files.get(b.report.path+b.report.poster),bundleBytes:job.bundle,checkedAt:at,now:this.now()});
   const input=args(),db=this.state.db;db.exec('BEGIN IMMEDIATE');
   let started=false;
   try{
    const current=this.state.get(id);
    this.successor(current);
    requireThat(this.state.op(id,`native:${beginSlot}:command`)?.result?.owner===this.session,'Recovery executor changed');
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
