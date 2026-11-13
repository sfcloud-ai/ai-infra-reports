// Additive per-page authority. All callers hold the original Publisher lock and
// mutation transaction. A successor never replaces the original run or permit.
import {isDeepStrictEqual as equal} from 'node:util';
import {decodeResearchArchive} from './research-archive.mjs';
import {digest} from './archive.mjs';
import {validatePageDelivery,validatePageProgressReport,validatePageCorrectionReport,TOPIC_IDS} from './page-delivery.mjs';
const fail=code=>{throw Object.assign(Error(code),{researchControlCode:code});};
const need=(ok,code)=>{if(!ok)fail(code);};
export const PAGE_AUTHORITY_VERSION=1;
export const PAGE_STAGED_SQL="CREATE TABLE research_page_staged(request_id TEXT PRIMARY KEY,report_date TEXT NOT NULL,hash TEXT NOT NULL,source_ts TEXT UNIQUE NOT NULL,file_id TEXT NOT NULL,bytes BLOB NOT NULL,phase TEXT NOT NULL DEFAULT 'staged',submit_ts TEXT)";
export const PAGE_ROUNDS_SQL='CREATE TABLE research_page_rounds(request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,revision INTEGER NOT NULL,previous_evidence TEXT NOT NULL,added TEXT NOT NULL,opened_at INTEGER NOT NULL,permit TEXT,UNIQUE(run_id,revision))';
export function pageAuthorityInstalled(db){
 const table=db.prepare("SELECT sql FROM sqlite_master WHERE name='research_page_rounds'").get();
 const staged=db.prepare("SELECT sql FROM sqlite_master WHERE name='research_page_staged'").get();
 need((!table&&!staged)||(table?.sql===PAGE_ROUNDS_SQL&&staged?.sql===PAGE_STAGED_SQL),'page_authority_schema');return !!table;
}
export function installPageAuthority(db){
 need(db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_control_policy'").get(),'page_original_authority_required');
 if(pageAuthorityInstalled(db))return false;db.exec(PAGE_ROUNDS_SQL);db.exec(PAGE_STAGED_SQL);return true;
}
export const originalRunId=id=>id.replace(/-r[1-9]\d*$/,'-r1');
export function pageRound(db,requestId){return pageAuthorityInstalled(db)?db.prepare('SELECT * FROM research_page_rounds WHERE request_id=?').get(requestId):null;}
export function currentPageRound(db,runId){return pageAuthorityInstalled(db)?db.prepare('SELECT * FROM research_page_rounds WHERE run_id=? ORDER BY revision DESC LIMIT 1').get(runId):null;}
export function publicationPermit(db,run,permitId=null){
 if(!run)return null;
 const first=run.permit?JSON.parse(run.permit):null;
 if(!permitId||first?.permit_id===permitId)return first;
 if(!pageAuthorityInstalled(db))return null;
 const row=db.prepare('SELECT permit FROM research_page_rounds WHERE run_id=? AND json_extract(permit,\'$.permit_id\')=?').get(run.request_id,permitId);
 return row?.permit?JSON.parse(row.permit):null;
}
function reportFromBundle(bytes,hash){
 need(digest(bytes)===hash,'page_previous_bundle_hash');
 const bundle=JSON.parse(Buffer.from(bytes));
 const files=bundle.files.filter(f=>f.path.endsWith('/report.json'));
 need(files.length===1,'page_previous_report');const file=files[0],raw=Buffer.from(file.base64,'base64');
 need(raw.toString('base64')===file.base64&&digest(raw)===file.sha256,'page_previous_report_hash');
 const report=JSON.parse(raw);need(report.schema_version==='1.2','page_previous_partition_missing');
 try{validatePageDelivery(report.page_delivery,report.articles,report.date,report.revision);}catch{fail('page_partition_invalid');}
 return {bundle,report};
}
// Only original host records may authenticate previous_evidence. Client claims,
// Slack acknowledgments, a published URL, or an unknown send cannot do so.
export function authenticatedPrevious(db,run,previousId,depth=0){
 need(typeof previousId==='string','page_previous_permit');
 need(depth<100,'page_correction_chain_limit');
 need(previousId===`morning-${run.report_date.replaceAll('-','')}-r${Number(previousId.split('-r').at(-1))}`&&originalRunId(previousId)===run.request_id,'page_previous_permit');
 const round=pageRound(db,previousId);
 const permit=previousId===run.request_id?(run.permit?JSON.parse(run.permit):null):(round?.run_id===run.request_id&&round.permit?JSON.parse(round.permit):null);
 if(permit)need(permit.request_id===previousId,'page_previous_permit');
 const job=db.prepare('SELECT * FROM jobs WHERE id=?').get(previousId);
 need(job&&(!permit||job.hash===permit.bundle_sha256),'page_previous_job');
 const {bundle,report}=reportFromBundle(Buffer.from(job.bytes),job.hash),detail=JSON.parse(job.detail);
 need(bundle.request_id===previousId&&report.date===run.report_date&&detail.proof?.publication_status==='verified'&&detail.proof.bundle_sha256===job.hash&&detail.proof.commit===detail.commit,'page_previous_publication');
 const table=db.prepare("SELECT 1 FROM sqlite_master WHERE name='scheduled_handoffs'").get();
 const handoff=table&&db.prepare('SELECT * FROM scheduled_handoffs WHERE request_id=?').get(previousId);
 need(['complete','skipped'].includes(handoff?.phase),'page_previous_delivery_incomplete');
 const receipt=JSON.parse(handoff.result),binding=JSON.parse(handoff.binding);
 const expected={request_id:previousId,report_date:run.report_date,report_commit:detail.commit,bundle_sha256:job.hash};
 need(equal(binding,expected)&&Object.entries(expected).every(([k,v])=>receipt[k]===v),'page_previous_delivery_binding');
 const webOnly=!permit&&report.revision_notice?.kind==='maintenance'&&handoff.phase==='skipped'&&receipt.status==='skipped'&&receipt.phase==='skipped'&&receipt.delivery_kind==='web_only'&&receipt.parts_total===0&&receipt.parts_sent===0&&Array.isArray(receipt.images)&&receipt.images.length===0;
 need(webOnly||receipt.status==='sent'&&receipt.phase==='complete'&&Number.isSafeInteger(receipt.parts_total)&&receipt.parts_total>0&&receipt.parts_sent===receipt.parts_total,'page_previous_delivery_incomplete');
 const images=receipt.images;
 need(webOnly||Array.isArray(images)&&(report.revision===1?receipt.parts_total===2&&images.length===1&&images[0].file_id==='scheduled-poster'&&images[0].status==='sent'&&images[0].error===null:receipt.delivery_kind===(report.revision_notice?.kind==='page_completion'?'page_completion':'revision_update')&&receipt.parts_total===1&&images.length===0),'page_previous_delivery_parts');
 if(!permit){
  need(['correction','maintenance','material_update'].includes(report.revision_notice?.kind),'page_previous_permit');
  const prior=authenticatedPrevious(db,run,report.page_delivery.previous?.request_id,depth+1);
  need(report.page_delivery.previous.bundle_sha256===prior.evidence.bundle_sha256&&/^[a-f0-9]{40}$/.test(bundle.expected_base_sha),'page_correction_binding');
  try{validatePageCorrectionReport(prior.report,report);}catch{fail('page_correction_partition');}
  const research=prior.evidence.research_previous??prior.evidence;
  return {...prior,report,bundle,research_report:prior.research_report??prior.report,
   corrections:[...(prior.corrections??[]),{bundle_base64:Buffer.from(job.bytes).toString('base64'),report_commit:detail.commit}],
   evidence:{request_id:previousId,bundle_sha256:job.hash,audit_sha256:research.audit_sha256,archive_sha256:research.archive_sha256,report_commit:detail.commit,research_previous:research}};
 }
 const stored=db.prepare('SELECT bytes FROM research_archives WHERE request_id=? AND hash=?').get(run.request_id,permit.archive_sha256);
 need(stored&&digest(Buffer.from(stored.bytes))===permit.archive_sha256,'page_previous_archive');
 const saved=decodeResearchArchive(Buffer.from(stored.bytes));
 const summary=saved.files.find(f=>f.sha256===permit.audit_sha256);need(summary,'page_previous_audit');
 const audit=JSON.parse(summary.data);
 need(audit.inputs?.draft_sha256===bundle.files.find(f=>f.path.endsWith('/report.json')).sha256,'page_previous_audit_draft');
 need(/^[a-f0-9]{64}$/.test(audit.evidence_metadata_sha256??''),'page_previous_metadata_missing');
 const metadataFile=saved.files.find(f=>f.sha256===audit.evidence_metadata_sha256);need(metadataFile,'page_previous_metadata_missing');
 const metadata=JSON.parse(metadataFile.data);
 return {report,bundle,audit,metadata,evidence:{request_id:previousId,bundle_sha256:job.hash,audit_sha256:permit.audit_sha256,archive_sha256:permit.archive_sha256,report_commit:detail.commit}};
}
export function beginPageRound(db,run,args,now){
 need(pageAuthorityInstalled(db),'page_authority_not_installed');
 need(args&&Object.keys(args).sort().join()==='added,previous_request_id','page_begin_fields');
 const previous=authenticatedPrevious(db,run,args.previous_request_id),revision=previous.report.revision+1;
 need(Number.isSafeInteger(revision)&&revision>1,'page_revision_limit');
 const requestId=`${run.request_id.replace(/-r1$/, '-r')}${revision}`;
 const pending=new Set(previous.report.page_delivery.pending.map(p=>p.id));
 need(Array.isArray(args.added)&&args.added.length>0&&equal(args.added,TOPIC_IDS.filter(id=>args.added.includes(id)))&&args.added.every(id=>pending.has(id)),'page_added_scope');
 const prior=pageRound(db,requestId);
 if(prior){need(equal(JSON.parse(prior.previous_evidence),previous.evidence)&&equal(JSON.parse(prior.added),args.added),'immutable_page_round');return prior;}
 for(const job of db.prepare('SELECT id FROM jobs WHERE id LIKE ?').all(run.request_id.replace(/-r1$/, '-r')+'%'))need(Number(job.id.split('-r').at(-1))<revision,'page_predecessor_must_be_latest');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='slack_submission_events'").get())need(!db.prepare("SELECT 1 FROM slack_submission_events WHERE request_id=? AND kind='revision' AND phase!='fenced'").get(requestId),'page_revision_reserved');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='publisher_inbox'").get())need(!db.prepare("SELECT 1 FROM publisher_inbox WHERE request_id=? AND phase!='fenced'").get(requestId),'page_revision_reserved');
 const latest=currentPageRound(db,run.request_id);
 need(!latest||latest.permit&&latest.revision<revision,'page_round_already_open');
 need(!db.prepare('SELECT 1 FROM jobs WHERE id=?').get(requestId)&&!db.prepare('SELECT 1 FROM slack_staged_bundles WHERE request_id=?').get(requestId),'page_existing_publication');
 db.prepare('INSERT INTO research_page_rounds VALUES(?,?,?,?,?,?,NULL)').run(requestId,run.request_id,revision,JSON.stringify(previous.evidence),JSON.stringify(args.added),now);
 return pageRound(db,requestId);
}
export function pagePublicationBinding(db,run,bundle){
 const round=pageRound(db,bundle.request_id);
 need(round?.run_id===run.request_id,'page_original_run');
 const previous=authenticatedPrevious(db,run,JSON.parse(round.previous_evidence).request_id);
 need(equal(previous.evidence,JSON.parse(round.previous_evidence)),'page_previous_evidence_changed');
 const bytes=Buffer.from(JSON.stringify(bundle)),{report}=reportFromBundle(bytes,digest(bytes));
 const allowed=JSON.parse(round.added),completed=report.page_delivery.added;
 need(Array.isArray(completed)&&completed.length>0&&completed.every(id=>allowed.includes(id)),'page_completed_scope');
 need(report.revision===round.revision&&equal(report.page_delivery.previous,{request_id:previous.evidence.request_id,bundle_sha256:previous.evidence.bundle_sha256}),'page_round_binding');
 try{validatePageProgressReport(previous.report,report);}catch{fail('page_progress_invalid');}
 const oldIds=new Set(previous.report.articles.map(a=>a.id));
 need(equal(previous.report.entries??[],(report.entries??[]).filter(e=>oldIds.has(e.article_id))),'page_previous_entries_changed');
 const mutable=new Set([`reports/${run.report_date}/report.json`,`reports/${run.report_date}/${previous.report.poster}`]);
 for(const file of previous.bundle.files){if(mutable.has(file.path))continue;const next=bundle.files.find(f=>f.path===file.path);need(next&&equal(file,next),'page_previous_assets_changed');}
 need(/^[a-f0-9]{40}$/.test(bundle.expected_base_sha),'page_base_commit'); // Independent immutable publication base; Producer checks the live main before writes.
 // Verify actual old article bytes too, not merely unchanged report metadata.
 for(const old of previous.report.articles){
  const path=`reports/${run.report_date}/articles/${old.id}.md`;
  const a=previous.bundle.files.find(f=>f.path===path),b=bundle.files.find(f=>f.path===path);
  need(a&&b&&a.sha256===b.sha256&&a.base64===b.base64,'page_previous_bytes_changed');
 }
 return {round,previous:{...previous,allowed_pages:allowed},completed_pages:completed};
}
export function appendPagePermit(db,run,permit){
 const round=pageRound(db,permit.request_id);need(round?.run_id===run.request_id,'page_original_run');
 if(round.permit){need(equal(JSON.parse(round.permit),permit),'immutable_page_permit');return;}
 db.prepare('UPDATE research_page_rounds SET permit=? WHERE request_id=? AND permit IS NULL').run(JSON.stringify(permit),permit.request_id);
}

export function stagingTable(db,id){
 if(originalRunId(id)===id)return 'slack_staged_bundles';
 return pageRound(db,id)?'research_page_staged':'slack_staged_bundles';
}
export function assertPageAdmission(db,run,bundle){
 const proof=pagePublicationBinding(db,run,bundle);
 for(const job of db.prepare('SELECT id FROM jobs WHERE id LIKE ?').all(run.request_id.replace(/-r1$/, '-r')+'%')){
  const revision=Number(job.id.split('-r').at(-1));
  need(Number.isSafeInteger(revision)&&revision<proof.round.revision||job.id===bundle.request_id,'page_competing_publication');
 }
 return proof;
}
