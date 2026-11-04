import {REPOSITORY} from "./archive.mjs";
import {decodeBundle,requireThat,SHA} from "./report-handoff.mjs";
import {failureDetail,safeDiagnostic,isLocalSlackCooldown} from "./handoff-recovery.mjs";
const PR=new RegExp("^https://github.com/"+REPOSITORY+"/pull/([1-9][0-9]*)$");
// An interrupted write must be reconciled before the original request advances.
export async function advanceHandoff(state,id,io){
 let job=state.get(id);requireThat(job,"Unknown request");
 if(["sending","receipt_unknown"].includes(job.phase)){
  requireThat(typeof io.findReceipt==='function',"Unresolved external mutation; operator reconciliation required");
  const found=await io.findReceipt(job.source_ts,{schema_version:"1.0",status:"published",...job.detail.proof,pr:job.detail.pr});
  if(found){requireThat(/^\d{10}\.\d{6}$/.test(found),"Reconciled receipt timestamp missing");state.move(id,job.phase,"receipt_sent",{...job.detail,receipt_ts:found});}
  return;
 }
 const bundle=await decodeBundle(job.bytes);
 if(["proposing","proposal_unknown"].includes(job.phase)){
  requireThat(typeof io.reconcileProposal==='function',"Unresolved external mutation; operator reconciliation required");
  const result=await io.reconcileProposal(bundle.files,bundle.data.expected_base_sha);
  if(result.outcome==='published'){
   requireThat(PR.test(result.url)&&SHA.test(result.sha),"Unexpected reconciled proposal response");
   state.move(id,job.phase,"pr_open",{...job.detail,pr:result.url,head:result.sha});
  }else if(['absent','branch_only'].includes(result.outcome)){
   // This observation is durable before any later mutation. propose() performs
   // the same original branch/PR checks again, never chooses a replacement ID.
   state.move(id,job.phase,"received",{...job.detail,reconciled:{outcome:result.outcome,at:(io.now??Date.now)()}});
  }else{
   requireThat(result.outcome==='blocked',"Unexpected proposal reconciliation outcome");
   const codes=['main_moved','identity_conflict','pr_closed','published_path','validation'];
   throw Object.assign(Error('Proposal reconciliation remains blocked'),{diagnostic:{stage:'proposal_reconciliation',code:codes.includes(result.reason)?result.reason:'blocked',outcome:'unknown',retryable:false}});
  }
  return;
 }
 if(job.phase==='proposal_failed')return;
 if(job.phase==="received"){
  const proposalAfter=job.detail.recovery?.proposal_after??0;
  if(proposalAfter>(io.now??Date.now)()){
   state.move(id,'received','received',{...job.detail,recovery:{...job.detail.recovery,next_at:Math.max(job.detail.recovery?.next_at??0,proposalAfter)}});return;
  }
  if(!state.move(id,"received","proposing",job.detail))return;
  try{
   const result=await io.propose(bundle.files,bundle.data.expected_base_sha);
   requireThat(PR.test(result.url)&&SHA.test(result.sha),"Unexpected proposal response");
   state.move(id,"proposing","pr_open",{...job.detail,pr:result.url,head:result.sha});
  }catch(error){
   const diagnostic=safeDiagnostic(error,'proposal');
   const phase=diagnostic.outcome==='not_started'?(diagnostic.retryable?'received':'proposal_failed'):'proposal_unknown';
   const detail=failureDetail(job.detail,error,'proposal',(io.now??Date.now)());
   if(phase==='received')detail.recovery.next_at=Math.max(detail.recovery.next_at,detail.recovery.proposal_after);
   state.move(id,"proposing",phase,detail);
   throw Object.assign(Error("Proposal outcome requires reconciliation before retrying"),{diagnostic});
  }
  return;
 }
 if(job.phase==="pr_open"){
  const number=PR.exec(job.detail.pr)?.[1];requireThat(number,"Stored PR identity");
  const pr=await io.readPR(number);
  requireThat(pr.number===Number(number)&&pr.head?.sha===job.detail.head&&pr.head?.repo?.full_name===REPOSITORY&&pr.base?.repo?.full_name===REPOSITORY&&pr.base?.ref==="main","PR identity changed");
  if(!pr.merged){requireThat(pr.state==="open","PR closed without merging");return;}
  requireThat(pr.merged===true&&pr.state==="closed","Merged PR state required");
  const commit=await io.readMergeCommit(number,pr);
  requireThat(typeof commit==="string"&&SHA.test(commit),"Missing merge commit evidence");
  // Drain both reads before the tick may close its shared quota database. A
  // later throttled response must still persist its deadline if its peer fails.
  const reads=await Promise.allSettled([io.readCommit(job.detail.head),io.readCommit(commit)]);
  const failed=reads.find(read=>read.status==='rejected');if(failed)throw failed.reason;
  const [head,merge]=reads.map(read=>read.value);
  requireThat(head.sha===job.detail.head&&merge.sha===commit&&SHA.test(head.tree?.sha)&&head.tree.sha===merge.tree?.sha&&head.parents?.length===1&&head.parents[0].sha===bundle.data.expected_base_sha&&merge.parents?.length===1&&merge.parents[0].sha===bundle.data.expected_base_sha,"Merge must contain the exact proposed tree and base (squash only)");
  state.move(id,"pr_open","merged",{...job.detail,commit});return;
 }
 if(job.phase==="merged"){
  const proof=await io.verify(job.detail.commit,bundle);
  requireThat(proof.publication_status==="verified"&&proof.commit===job.detail.commit&&proof.bundle_sha256===job.hash,"Publication proof mismatch");
  state.move(id,"merged","verified",{...job.detail,proof});return;
 }
 if(job.phase==="verified"){
  // Revalidate after a restart/delay before producing the success receipt.
  const proof=await io.verify(job.detail.commit,bundle);
  requireThat(proof.publication_status==="verified"&&proof.commit===job.detail.commit&&proof.bundle_sha256===job.hash,"Publication proof mismatch");
  const detail={...job.detail,proof};if(!state.move(id,"verified","sending",detail))return;
  try{
   const ts=await io.receipt(job.source_ts,{schema_version:"1.0",status:"published",...proof,pr:job.detail.pr});
   requireThat(/^\d{10}\.\d{6}$/.test(ts),"Receipt timestamp missing");
   state.move(id,"sending","receipt_sent",{...detail,receipt_ts:ts});
  }catch(error){
   const local=isLocalSlackCooldown(error);
   state.move(id,"sending",local?'verified':'receipt_unknown',failureDetail(detail,error,'publication_receipt',(io.now??Date.now)()));
   if(local)throw error;
   throw Error("Receipt outcome requires operator reconciliation; no automatic resend");
  }
 }
}
