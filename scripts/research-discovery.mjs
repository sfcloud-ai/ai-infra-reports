// The trusted Brief validator parses original search responses. The host binds
// its declaration to archived metadata and the unchanged original input plan.
import {isDeepStrictEqual as equal} from 'node:util';
export const DISCOVERY_CONTRACT='daily_required_v2';
export const DISCOVERY_CHECKS=Object.freeze(['discovery_memory','discovery_scheduling','discovery_compute','discovery_data_path']);
export const DISCOVERY_PAGE_CHECKS=Object.freeze({'model-serving-gpu':DISCOVERY_CHECKS.slice(0,3),'hardware-status':['discovery_data_path']});
export function discoverySourcesPreserved(current,previous){
 if(!Array.isArray(current.sources)||!Array.isArray(previous.sources)||current.sources.length<previous.sources.length)return false;
 const retryable=new Set(previous.discovery.queries.filter(q=>previous.checks[q.family]?.status==='failed').map(q=>q.source_id));
 const protectedIds=new Set(Object.entries(previous.checks).filter(([name,c])=>!DISCOVERY_CHECKS.includes(name)||c.status!=='failed').flatMap(([,c])=>c.source_ids));
 const mutable=new Set(['attempts','attempt_records','elapsed_seconds','timing_unavailable_reason','status','error','content_sha256','retrieved_at']);
 const stable=s=>Object.fromEntries(Object.entries(s).filter(([k])=>!mutable.has(k)));
 return previous.sources.every((old,i)=>{
  const next=current.sources[i];if(equal(old,next))return true;
  if(!old||!next||!retryable.has(old.id)||protectedIds.has(old.id)||!equal(stable(old),stable(next)))return false;
  const before=old.attempt_records,after=next.attempt_records;
  return Array.isArray(before)&&Array.isArray(after)&&after.length>before.length&&next.attempts===after.length
   &&equal(after.slice(0,before.length),before)&&(old.elapsed_seconds===null||next.elapsed_seconds===null||typeof next.elapsed_seconds==='number'&&next.elapsed_seconds>=old.elapsed_seconds);
 });
}
export function discoveryCoverageBound(audit,metadata){
 if(audit.coverage_contract!==DISCOVERY_CONTRACT)return metadata?.discovery===undefined;
 if(!metadata||metadata.schema_version!=='1.4'||metadata.coverage_contract!==audit.coverage_contract||!metadata.discovery
  ||!Array.isArray(metadata.discovery.queries)||metadata.discovery.queries.length>16||!metadata.checks||!Array.isArray(metadata.sources))return false;
 if(!Array.isArray(audit.coverage_checked)||!Array.isArray(audit.coverage_unchecked))return false;
 const queries=metadata.discovery.queries,ids=new Set(),sources=new Map();
 for(const source of metadata.sources){
  if(!source||typeof source.id!=='string'||sources.has(source.id))return false;
  sources.set(source.id,source);
 }
 for(const q of queries){
  if(!q||typeof q.id!=='string'||ids.has(q.id)||!DISCOVERY_CHECKS.includes(q.family)||!['current','backscan','followup'].includes(q.mode)
   ||!sources.has(q.source_id)||!Array.isArray(q.results))return false;
  ids.add(q.id);
 }
 for(const family of DISCOVERY_CHECKS){
  const check=metadata.checks[family],refs=[...new Set(queries.filter(q=>q.family===family&&q.mode==='current').map(q=>q.source_id))];
  if(!check||!['checked','no_qualifying_items','failed','not_checked'].includes(check.status)||!Array.isArray(check.source_ids)
   ||check.source_ids.length!==refs.length||!refs.every(id=>check.source_ids.includes(id)))return false;
  const complete=['checked','no_qualifying_items'].includes(check.status);
  if(complete!==audit.coverage_checked.includes(family)||(check.status==='not_checked')!==audit.coverage_unchecked.includes(family))return false;
  if(complete&&!refs.some(id=>sources.get(id).status==='ok')||check.status==='not_checked'&&refs.length||check.status==='failed'&&!refs.length)return false;
 }
 return true;
}
