import {requireThat} from './report-handoff.mjs';

export const SCHEDULED_SCHEMA=Object.freeze({
 scheduled_handoffs:'CREATE TABLE scheduled_handoffs (request_id TEXT PRIMARY KEY, binding TEXT NOT NULL, phase TEXT NOT NULL, result TEXT, poll_order INTEGER NOT NULL DEFAULT 0)',
 scheduled_bridge_scope:'CREATE TABLE scheduled_bridge_scope (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)',
 scheduled_status_replies:'CREATE TABLE scheduled_status_replies (source_ts TEXT PRIMARY KEY, hash TEXT NOT NULL, phase TEXT NOT NULL, text TEXT NOT NULL, reply_ts TEXT, poll_order INTEGER NOT NULL DEFAULT 0)'
});
export function installScheduledTables(db,names){
 for(const name of names)db.exec(SCHEDULED_SCHEMA[name].replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS '));
}
export function scheduledSchemaObjects(db){
 const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name IN ('scheduled_handoffs','scheduled_bridge_scope','scheduled_status_replies') ORDER BY name").all();
 requireThat(objects.every(o=>o.type==='table'&&SCHEDULED_SCHEMA[o.name]===o.sql),'Unexpected scheduled delivery schema');
 const names=new Set(objects.map(o=>o.name));
 requireThat(names.has('scheduled_handoffs')===names.has('scheduled_bridge_scope'),'Incomplete scheduled delivery schema');
 return objects;
}

export function requireSettledScheduled(db){
 const rows=new Map(db.prepare('SELECT request_id,binding,phase,result FROM scheduled_handoffs').all().map(r=>[r.request_id,r]));
 const bound=id=>{
  const row=rows.get(id);requireThat(row,'Scheduled successor missing');
  const binding=JSON.parse(row.binding),result=JSON.parse(row.result);
  requireThat(Object.keys(binding).sort().join()==='bundle_sha256,report_commit,report_date,request_id'&&binding.request_id===id&&Object.entries(binding).every(([k,v])=>result?.[k]===v),'Scheduled terminal binding differs');
  return {row,binding,result};
 };
 for(const original of rows.values()){
  if(original.phase==='complete')continue; // 已有 legacy complete 原样保留。
  requireThat(['skipped','superseded'].includes(original.phase),'Unresolved scheduled delivery prevents migration');
  let id=original.request_id,current=bound(id);const seen=new Set();
  while(current.row.phase==='superseded'){
   requireThat(!seen.has(id)&&seen.size<=100,'Scheduled successor cycle');seen.add(id);
   const {binding,result}=current,next=result.superseded_by;
   requireThat(result.phase==='superseded'&&result.status!=='sent'&&typeof next==='string'&&new RegExp('^morning-'+binding.report_date.replaceAll('-','')+'-r(?:[2-9]|[1-9][0-9]+)$').test(next),'Scheduled successor differs');
   current=bound(next);requireThat(current.binding.report_date===binding.report_date,'Scheduled successor date differs');id=next;
  }
  const {row,result}=current;
  const complete=row.phase==='complete'&&result.phase==='complete'&&result.status==='sent'&&Number.isSafeInteger(result.parts_sent)&&result.parts_sent>0&&result.parts_sent===result.parts_total;
  const skipped=row.phase==='skipped'&&result.phase==='skipped'&&result.status==='skipped'&&result.delivery_kind==='web_only'&&Number.isSafeInteger(result.report_revision)&&result.report_revision>1&&result.parts_total===0&&result.parts_sent===0&&Array.isArray(result.images??[])&&(result.images??[]).length===0;
  requireThat(complete||skipped,'Unresolved scheduled delivery prevents migration');
 }
}
