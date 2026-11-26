import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {digest} from './archive.mjs';
import {requireThat} from './report-handoff.mjs';
import {isLayeredResearchPlan} from './research-budget.mjs';
import {recoveryHeadForRun} from './research-recovery.mjs';
import {pdfFollowup} from './research-pdf-followup.mjs';
import {repositoryResearchInputsHash} from './repository-research-inputs.mjs';

export const MIGRATION_TABLE='research_control_edition_migrations';
export const MIGRATION_SCHEMA='CREATE TABLE research_control_edition_migrations(request_id TEXT PRIMARY KEY,receipt TEXT NOT NULL)';
export const VERIFIER_COMMIT='a88c1909709a701785498aadb0310af2bded1640';
const predecessor='dba8eadebbdcd284a17db7f4f732bf7d7bda157f509f3842f70cf9bfbd7a8ba7';
const successor='e754920ee1850c145a9484c105570c05eebf84e3928c2ef291aa9bc2d739a615';
const hasTable=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

export function storedEditionMigration(db,id){
  if(!hasTable(db,MIGRATION_TABLE))return null;
  const row=db.prepare('SELECT receipt FROM research_control_edition_migrations WHERE request_id=?').get(id);
  return row?.receipt??null;
}

export function migratedPdf(db,id,operationId){
  const receipt=storedEditionMigration(db,id);
  const pdf=receipt && JSON.parse(receipt).reserve_pdf;
  return pdf?.operation_id===operationId?pdf:null;
}

export const EDITION_MIGRATION_VERSION=2;
export function requiresEditionMigration(plan){
  return plan.files?.['ai_brief/resources/prompts/audit.md']===predecessor;
}

export function migrationAuditValid(db,run,audit){
  const receipt=storedEditionMigration(db,run.request_id);
  if(receipt){
    const migration=JSON.parse(receipt);
    if(audit.edition_migration_sha256!==digest(receipt))return false;
    if(migration.schema_version==='edition_audit_migration_v1')return true;
    const followups=audit.archive_followups;
    if(migration.schema_version!=='edition_audit_migration_v2'||!Array.isArray(followups)||followups.length!==1||!followups[0])return false;
    const {source_id,...descriptor}=followups[0];
    return typeof source_id==='string'&&isDeepStrictEqual(descriptor,migration.reserve_pdf);
  }
  return !Object.hasOwn(audit,'edition_migration_sha256') && !(audit.archive_followups?.length &&
    requiresEditionMigration(JSON.parse(Buffer.from(run.plan))));
}

// Called inside one SQLite transaction. Hash each original archive before advancing the cursor.
export function prepareEditionMigration(db,id,pdfBytes){
  const run=db.prepare('SELECT * FROM research_control_runs WHERE request_id=?').get(id);
  requireThat(run && !run.permit && run.inputs_hash && run.checkpoint_hash,'unpublished frozen run required');
  const planText=Buffer.from(run.plan).toString('utf8'),plan=JSON.parse(planText);
  requireThat(id===plan.request_id && run.report_date===plan.report_date && digest(planText)===run.plan_hash &&
    requiresEditionMigration(plan) && repositoryResearchInputsHash(plan)===run.inputs_hash,
    'original frozen plan and inputs required');
  requireThat(hasTable(db,'research_recovery_grants'),'layered budget required for migration');
  const recovery=recoveryHeadForRun(db,run);
  requireThat(isLayeredResearchPlan(plan)||recovery,'layered budget required for migration');
  const prefix='morning-'+run.report_date.replaceAll('-','')+'-r';
  for(const [table,column] of [['jobs','id'],['slack_submission_events','request_id'],['slack_staged_bundles','request_id'],
    ['research_page_rounds','request_id'],['research_page_staged','request_id'],['publisher_inbox','request_id'],
    ['producer_admission_grants','request_id'],['scheduled_handoffs','request_id']]){
    if(hasTable(db,table))requireThat(!db.prepare('SELECT 1 FROM '+table+' WHERE '+column+' GLOB ? LIMIT 1').get(prefix+'*'),
      'existing edition publication or intake');
  }
  requireThat(!db.prepare("SELECT 1 FROM research_control_events WHERE json_extract(CAST(bytes AS TEXT),'$.request_id')=? AND phase NOT IN ('sent','superseded')").get(id)
    && !db.prepare("SELECT 1 FROM research_archive_events WHERE request_id=? AND phase!='sent'").get(id),'unreconciled control or archive event');
  const result=JSON.parse(pdfBytes),pdf=pdfFollowup(result,pdfBytes);
  const pending=db.prepare("SELECT * FROM research_control_ops WHERE request_id=? AND phase!='acknowledged'").all(id);
  const op=pending[0];
  requireThat(pdf && pending.length===1 && op.kind==='source' && op.phase==='intent' && pdf.operation_id===op.operation_id &&
    result.request_id===id && result.input_sha256===op.input_hash && result.url===JSON.parse(op.input).url &&
    result.reserved_seconds===op.reserved_seconds && Number.isFinite(result.elapsed_seconds) && result.elapsed_seconds>=0,
    'original outstanding PDF result required');
  requireThat(typeof result.source_id==='string' && /^[a-z][a-z0-9_-]{0,79}$/.test(result.source_id) &&
    !db.prepare("SELECT 1 FROM research_control_ops WHERE request_id=? AND kind='source' AND input_hash=? AND operation_id!=?").get(id,op.input_hash,op.operation_id),
    'single original PDF source attempt with a valid source ID required');
  requireThat(!db.prepare(`SELECT 1 FROM research_control_ops op JOIN research_archives a
    ON a.request_id=op.request_id AND a.hash=op.result_archive, json_each(a.manifest) f
    WHERE op.request_id=? AND op.kind='source' AND op.phase='acknowledged'
    AND json_extract(f.value,'$.path')='archive_followups/'||op.operation_id||'.json' LIMIT 1`).get(id),
    'another PDF followup is already settled');
  const state=createHash('sha256');
  const record=(tag,value)=>state.update(JSON.stringify([tag,value])+'\n');
  record('run',{...run,plan:planText});
  for(const [table,key] of [['research_control_ops','operation_id'],['research_control_commands','command_id'],
    ['research_recovery_grants','grant_id'],['research_recovery_operations','operation_id']]){
    if(!hasTable(db,table))continue;
    for(const row of db.prepare('SELECT * FROM '+table+' WHERE request_id=? ORDER BY '+key).iterate(id)){
      if(row.bytes)row.bytes=digest(row.bytes);
      record(table,row);
    }
  }
  let previous=null,foundCheckpoint=false;
  for(const row of db.prepare('SELECT * FROM research_archives WHERE request_id=? ORDER BY rowid').iterate(id)){
    const hash=digest(row.bytes);
    requireThat(hash===row.hash && row.previous_hash===previous && row.report_date===run.report_date,'original archive chain differs');
    previous=hash;
    foundCheckpoint ||= hash===run.checkpoint_hash;
    record('archive',{...row,bytes:hash});
  }
  const head=db.prepare('SELECT hash FROM research_archive_heads WHERE report_date=?').get(run.report_date);
  requireThat(foundCheckpoint && previous===head?.hash,'original archive head or checkpoint differs');
  return {schema_version:'edition_audit_migration_v2',request_id:id,owner_id:run.owner_id,epoch:run.epoch,revision:run.revision,
    plan:planText,plan_sha256:run.plan_hash,inputs_sha256:run.inputs_hash,checkpoint_sha256:run.checkpoint_hash,
    archive_head_sha256:previous,state_sha256:state.digest('hex'),scope_sha256:db.prepare('SELECT value FROM scope WHERE id=1').get().value,
    policy_sha256:successor,verifier_commit:VERIFIER_COMMIT,reserve_pdf:pdf};
}

export const receiptText=record=>JSON.stringify(record)+'\n';

export function applyEditionMigration(db,id,pdfBytes,expected){
  db.exec('BEGIN IMMEDIATE');
  try{
    const saved=storedEditionMigration(db,id);
    if(saved!==null){
      requireThat(saved===expected && isDeepStrictEqual(JSON.parse(saved).reserve_pdf,pdfFollowup(JSON.parse(pdfBytes),pdfBytes)),
        'different migration already recorded');
    }else{
      const record=prepareEditionMigration(db,id,pdfBytes);
      requireThat(receiptText(record)===expected,'migration snapshot changed');
      if(!hasTable(db,MIGRATION_TABLE))db.exec(MIGRATION_SCHEMA);
      db.prepare('INSERT INTO research_control_edition_migrations VALUES(?,?)').run(id,expected);
      const update=db.prepare('UPDATE research_control_runs SET revision=revision+1 WHERE request_id=? AND epoch=? AND revision=? AND owner_id=? AND permit IS NULL')
        .run(id,record.epoch,record.revision,record.owner_id);
      requireThat(update.changes===1,'migration revision conflict');
    }
    db.exec('COMMIT');
    return expected;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
