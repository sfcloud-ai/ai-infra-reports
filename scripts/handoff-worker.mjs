import {REPOSITORY} from "./archive.mjs";
import {decodeBundle,requireThat,SHA} from "./report-handoff.mjs";
const PR=new RegExp("^https://github.com/"+REPOSITORY+"/pull/([1-9][0-9]*)$");
// An interrupted mutation stays proposing/sending (or *_unknown); it is never retried.
export async function advanceHandoff(state,id,io){
 let job=state.get(id);requireThat(job,"Unknown request");
 requireThat(!["proposing","proposal_unknown","sending","receipt_unknown"].includes(job.phase),"Unresolved external mutation; operator reconciliation required");
 const bundle=await decodeBundle(job.bytes);
 if(job.phase==="received"){
  if(!state.move(id,"received","proposing",{}))return;
  try{
   const result=await io.propose(bundle.files,bundle.data.expected_base_sha);
   requireThat(PR.test(result.url)&&SHA.test(result.sha),"Unexpected proposal response");
   state.move(id,"proposing","pr_open",{pr:result.url,head:result.sha});
  }catch{state.move(id,"proposing","proposal_unknown",{});throw Error("Proposal outcome requires operator reconciliation; no automatic retry");}
  return;
 }
 if(job.phase==="pr_open"){
  const number=PR.exec(job.detail.pr)?.[1];requireThat(number,"Stored PR identity");
  const pr=await io.readPR(number);
  requireThat(pr.number===Number(number)&&pr.head?.sha===job.detail.head&&pr.head?.repo?.full_name===REPOSITORY&&pr.base?.repo?.full_name===REPOSITORY&&pr.base?.ref==="main","PR identity changed");
  if(!pr.merged){requireThat(pr.state==="open","PR closed without merging");return;}
  requireThat(SHA.test(pr.merge_commit_sha),"Missing merge commit");
  const [head,merge]=await Promise.all([io.readCommit(job.detail.head),io.readCommit(pr.merge_commit_sha)]);
  requireThat(head.sha===job.detail.head&&merge.sha===pr.merge_commit_sha&&SHA.test(head.tree?.sha)&&head.tree.sha===merge.tree?.sha&&merge.parents?.length===1&&merge.parents[0].sha===bundle.data.expected_base_sha,"Merge must contain the exact proposed tree and base (squash only)");
  state.move(id,"pr_open","merged",{...job.detail,commit:pr.merge_commit_sha});return;
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
  }catch{state.move(id,"sending","receipt_unknown",detail);throw Error("Receipt outcome requires operator reconciliation; no automatic resend");}
 }
}
