import {originalRunId,publicationPermit} from './research-page-authority.mjs';
import {isRepositoryResearchPlan,isLayeredResearchPlan,operationBudget} from './research-budget.mjs';
import {acceptDataCommand,acceptReadCommand,canonicalRequestDate,requireThat} from './report-handoff.mjs';
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
export const controlledDate=(c,id)=>!!c.research_control&&canonicalRequestDate(id)>=c.research_control.first_report_date;
export function acceptPermitSubmission(message,c,now,window){
 if(!c.research_control)return null;
 const stage=acceptDataCommand(message,c,'!ai-report stage-v2 ',new RegExp('^!ai-report stage-v2 (morning-\\d{8}-r[1-6]) ([a-f0-9]{64}) ('+UUID+')$'),now,window);
 if(stage)return {...stage,kind:'stage',target_ts:null,permit_id:message.text.split(' ')[4]};
 const submit=acceptReadCommand(message,c,'!ai-report submit-v2 ',new RegExp('^!ai-report submit-v2 (morning-\\d{8}-r[1-6]) ([a-f0-9]{64}) (\\d{10}\\.\\d{6}) ('+UUID+')$'),now,window);
 if(!submit)return null;
 return {kind:'submit',source_ts:submit.source_ts,request_id:submit.match[1],hash:submit.match[2],target_ts:submit.match[3],file_id:null,permit_id:submit.match[4]};
}
export function queuePermitSubmission(db,event){
 if(!event.permit_id)return;
 const prior=db.prepare('SELECT permit_id FROM research_control_submissions WHERE source_ts=?').get(event.source_ts);
 requireThat(!prior||prior.permit_id===event.permit_id,'Original permit envelope changed');
 if(!prior)db.prepare('INSERT INTO research_control_submissions VALUES(?,?)').run(event.source_ts,event.permit_id);
}
function reject(code){throw Object.assign(Error(code),{researchPublicationRejection:code});}
const need=(ok,code)=>{if(!ok)reject(code);};
// Check in the same final transaction as stage/admission. Epoch does not erase
// a prior immutable external intent. It never permits a second intent either.
export function permitSubmission(db,c,row,stored=null){
 need(controlledDate(c,row.request_id),'retired_publication_entry');
 const envelope=db.prepare('SELECT permit_id FROM research_control_submissions WHERE source_ts=?').get(row.source_ts);
 const run=db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(originalRunId(row.request_id)),permit=publicationPermit(db,run,envelope?.permit_id);
 need(run&&isRepositoryResearchPlan(JSON.parse(Buffer.from(run.plan))),'retired_plan_read_only');
 need(envelope&&permit&&envelope.permit_id===permit.permit_id&&permit.request_id===row.request_id&&permit.bundle_sha256===row.hash&&permit.report_date===canonicalRequestDate(row.request_id),'publication_permit_binding');
 need(permit.publisher_scope_sha256===db.prepare('SELECT value FROM scope WHERE id=1').get().value,'publication_permit_scope');
 const step=row.kind==='stage'?'complete':'submit';
 const op=db.prepare("SELECT * FROM research_control_ops WHERE request_id=? AND kind='native' AND operation_key=?").get(run.request_id,'permit:'+permit.permit_id+':'+step);
 need(op&&['intent','unknown','acknowledged'].includes(op.phase),'publication_intent_missing');
 const input=JSON.parse(op.input);
 need(input.permit_id===permit.permit_id&&input.sha256===row.hash&&input.archive_sha256===permit.archive_sha256,'publication_intent_binding');
 if(row.kind==='stage')need(input.file_id===row.file_id&&input.source_ts===null,'publication_original_file');
 else{
  requireThat(stored,'Original staging has not been observed yet');
  need(stored&&stored.hash===row.hash&&input.file_id===stored.file_id&&input.source_ts===stored.source_ts&&row.target_ts===stored.source_ts,'publication_original_stage');
  const original=db.prepare('SELECT permit_id FROM research_control_submissions WHERE source_ts=?').get(stored.source_ts);need(original?.permit_id===permit.permit_id,'publication_stage_permit');
 }
 if(op.native_result){
  const result=JSON.parse(op.native_result);need(result.file_id===input.file_id&&result.source_ts===row.source_ts&&result.sha256===row.hash&&result.bytes===input.bytes,'publication_original_result');
 }
 return {op,input,permit,run_id:run.request_id};
}
export function settlePermitSubmission(db,proof,row,byteLength){
 if(!proof)return;
 need(proof.input.bytes===byteLength,'publication_original_size');
 const result={file_id:proof.input.file_id,source_ts:row.source_ts,sha256:row.hash,bytes:byteLength};
 db.prepare("UPDATE research_control_ops SET phase='acknowledged',native_result=? WHERE operation_id=?").run(JSON.stringify(result),proof.op.operation_id);
 db.prepare('UPDATE research_control_runs SET revision=revision+1 WHERE request_id=?').run(proof.run_id);
}
export function settleResearchArchiveUpload(db,event,byteLength){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_control_ops'").get())return;
 const op=db.prepare("SELECT * FROM research_control_ops WHERE request_id=? AND kind='native' AND operation_key=?").get(event.request_id,'archive:'+event.hash+':complete');
 if(!op)return;
 const input=JSON.parse(op.input);
 need(input.permit_id===null&&input.file_id===event.file_id&&input.sha256===event.hash&&input.bytes===byteLength,'archive_original_upload');
 if(op.native_result){const result=JSON.parse(op.native_result);need(result.file_id===event.file_id&&result.source_ts===event.source_ts&&result.sha256===event.hash&&result.bytes===byteLength,'archive_original_result');}
 db.prepare("UPDATE research_control_ops SET phase='acknowledged',native_result=? WHERE operation_id=?").run(JSON.stringify({file_id:event.file_id,source_ts:event.source_ts,sha256:event.hash,bytes:byteLength}),op.operation_id);
 db.prepare('UPDATE research_control_runs SET revision=revision+1 WHERE request_id=?').run(event.request_id);
}
