import {researchTimeNotBefore} from './research-time.mjs';
// The trusted Brief validator parses original search responses. The host binds
// its declaration to archived metadata and the unchanged original input plan.
import {isDeepStrictEqual as equal} from 'node:util';
export const DISCOVERY_CONTRACT='daily_required_v2';
export const DISCOVERY_CHECKS=Object.freeze(['discovery_memory','discovery_scheduling','discovery_compute','discovery_data_path']);
export const DISCOVERY_PAGE_CHECKS=Object.freeze({'model-serving-gpu':DISCOVERY_CHECKS.slice(0,3),'hardware-status':['discovery_data_path']});
const onlyUndispatched=source=>Array.isArray(source?.attempt_records)&&source.attempt_records.length>0&&source.attempt_records.every(attempt=>attempt?.status==='not_dispatched');
const without=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.has(key)));
export function discoverySourcesPreserved(current,previous){
 if(!Array.isArray(current.sources)||!Array.isArray(previous.sources)||current.sources.length<previous.sources.length)return false;
 const checks=Object.entries(previous.checks??{}),queries=previous.discovery?.queries??[];
 if(!Array.isArray(queries))return false;
 const protectedIds=new Set(checks.filter(([name,c])=>!DISCOVERY_CHECKS.includes(name)||c.status!=='failed').flatMap(([,c])=>c.source_ids));
 const checkedIds=new Set(checks.filter(([,c])=>['checked','no_qualifying_items'].includes(c.status)).flatMap(([,c])=>c.source_ids));
 const retryable=new Set(queries.filter(q=>previous.checks[q.family]?.status==='failed'&&!protectedIds.has(q.source_id)).map(q=>q.source_id));
 for(const source of previous.sources)if(onlyUndispatched(source)&&!checkedIds.has(source.id))retryable.add(source.id);
 const accounting=new Set(['attempts','attempt_records','elapsed_seconds','timing_unavailable_reason','status','error']);
 const mutable=new Set([...accounting,'content_sha256','retrieved_at']);
 return previous.sources.every((old,i)=>{
  const next=current.sources[i];
  if(onlyUndispatched(old)&&old.retrieved_at!==null||onlyUndispatched(next)&&next.retrieved_at!==null)return false;
  if(equal(old,next))return true;
  if(!old||!next||!retryable.has(old.id))return false;
  const before=old.attempt_records,after=next.attempt_records;
  if(!Array.isArray(before)||!Array.isArray(after)||after.length<=before.length||next.attempts!==after.length||!equal(after.slice(0,before.length),before))return false;
  const suffix=after.slice(before.length);
  if(onlyUndispatched(old)&&suffix.some(a=>a?.status!=='not_dispatched')){
   const ordering=researchTimeNotBefore(next.retrieved_at,previous.finished_at);
   if(ordering!==true)return false;
  }
  if(suffix.every(a=>a?.status==='not_dispatched')&&!equal(without(old,accounting),without(next,accounting)))return false;
  const fields=onlyUndispatched(old)&&old.published_at===null&&suffix.some(a=>a?.status==='ok')?new Set([...mutable,'published_at']):mutable;
  return equal(without(old,fields),without(next,fields))&&(old.elapsed_seconds===null||next.elapsed_seconds===null||typeof next.elapsed_seconds==='number'&&next.elapsed_seconds>=old.elapsed_seconds);
 });
}
export function discoveryCoverageBound(audit,metadata,previous=null){
 if(audit.coverage_contract!==DISCOVERY_CONTRACT)return metadata?.discovery===undefined;
 if(!metadata||metadata.schema_version!=='1.4'||metadata.coverage_contract!==audit.coverage_contract||!metadata.discovery
  ||!Array.isArray(metadata.discovery.queries)||metadata.discovery.queries.length>16||!metadata.checks||!Array.isArray(metadata.sources))return false;
 if(!Array.isArray(audit.coverage_checked)||!Array.isArray(audit.coverage_unchecked))return false;
 const queries=metadata.discovery.queries,ids=new Set(),sources=new Map(),outcomes=new Map(),operations=new Set();
 // The caller authenticates the predecessor and preserves its query/attempt prefix.
 const priorAttempts=new Map((previous?.sources??[]).map(source=>[source.id,source.attempt_records?.length??0]));
 for(const source of metadata.sources){
  if(!source||typeof source.id!=='string'||sources.has(source.id))return false;
  if(onlyUndispatched(source)&&source.retrieved_at!==null)return false;
  sources.set(source.id,source);
 }
 for(const q of queries){
  if(!q||typeof q.id!=='string'||ids.has(q.id)||!DISCOVERY_CHECKS.includes(q.family)||!['current','backscan','followup'].includes(q.mode)
   ||!sources.has(q.source_id)||!Array.isArray(q.results))return false;
  ids.add(q.id);
  const source=sources.get(q.source_id);
  if(source.attempt_records!==undefined){
   if(!Array.isArray(source.attempt_records)||!Number.isSafeInteger(q.attempt)||q.attempt<1||q.attempt>source.attempt_records.length||!source.attempt_records[q.attempt-1])return false;
   const status=source.attempt_records[q.attempt-1].status,key=JSON.stringify([q.source_id,q.attempt]);
   if(!['ok','failed','timeout','not_dispatched'].includes(status)||operations.has(key))return false;
   operations.add(key);outcomes.set(q.id,status);
  }else {if(source.status==='not_dispatched')return false;outcomes.set(q.id,source.status);}
 }
 for(const id of new Set(queries.map(q=>q.source_id))){
  const attempts=sources.get(id).attempt_records;
  const cancelled=attempts?.some(attempt=>attempt?.status==='not_dispatched');
  if(attempts?.some((attempt,i)=>!attempt||(cancelled&&i>=(priorAttempts.get(id)??0)||attempt.status==='ok')&&!operations.has(JSON.stringify([id,i+1]))))return false;
 }
 for(const family of DISCOVERY_CHECKS){
  const check=metadata.checks[family],refs=[...new Set(queries.filter(q=>q.family===family&&q.mode==='current').map(q=>q.source_id))];
  if(!check||!['checked','no_qualifying_items','failed','not_checked'].includes(check.status)||!Array.isArray(check.source_ids)
   ||check.source_ids.length!==refs.length||!refs.every(id=>check.source_ids.includes(id)))return false;
  const complete=['checked','no_qualifying_items'].includes(check.status);
  if(complete!==audit.coverage_checked.includes(family)||(check.status==='not_checked')!==audit.coverage_unchecked.includes(family))return false;
  const current=queries.filter(q=>q.family===family&&q.mode==='current'),executed=current.filter(q=>outcomes.get(q.id)!=='not_dispatched');
  if(complete&&!current.some(q=>outcomes.get(q.id)==='ok')||check.status==='not_checked'&&executed.length||check.status==='failed'&&!executed.length)return false;
 }
 return true;
}
