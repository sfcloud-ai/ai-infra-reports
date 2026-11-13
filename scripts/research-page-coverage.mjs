import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export const PAGE_CHECKS=Object.freeze({
 'model-serving-gpu':['model_serving'], 'hardware-status':['hardware'],
 'model-architecture-status':['model_architecture','glm_blog','qwen_blog','glm_models','deepseek_models','qwen_models','deepseek_articles'],
 'embodied-training':['embodied_training'], 'small-model-status':['small_models'],
 'inference-engines':['inference_engines','vllm','sglang','deepinfer','vllm_blog','sglang_blog','lmsys_blog','deepinfer_articles']
});
const ids=Object.keys(PAGE_CHECKS);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const equal=isDeepStrictEqual;
const line=s=>typeof s==='string'&&s.trim()===s&&s.length>0&&Buffer.byteLength(s)<=300&&!/[\x00-\x1f\x7f-\x9f<>\u2028\u2029\ufeff\uD800-\uDFFF]/u.test(s);
// Explicit opt-in, first publication only. Successors require authenticated prior
// publication evidence, which this contract deliberately does not infer.
export function initialPageCoverageValid(audit,bundle){return pageCoverageValid(audit,bundle);}
export function pageCoverageValid(audit,bundle,previous=null,metadata=null){
 try{
  const scope=audit.page_scope;
  if(audit.schema_version!=='1.4'||!exact(scope,['contract','page_delivery','checked_pages','previous_evidence'])||scope.contract!=='verified_pages_v1')return false;
  const files=bundle.files.filter(f=>f.path.endsWith('/report.json'));if(files.length!==1)return false;
  const file=files[0],bytes=Buffer.from(file.base64,'base64');
  if(bytes.toString('base64')!==file.base64||createHash('sha256').update(bytes).digest('hex')!==file.sha256)return false;
  const report=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)),pages=scope.page_delivery;
  if(report.schema_version!=='1.2'||report.date!==audit.date||!exact(pages,['previous','added','pending'])||!equal(report.page_delivery,pages))return false;
  const successor=pages.previous!==null;
  if(successor){if(!previous||!metadata||!successorEvidenceValid(audit,report,previous,metadata))return false;}
  else if(report.revision!==1||scope.previous_evidence!==null)return false;
  if(!Array.isArray(report.articles)||report.articles.length===0||!Array.isArray(pages.pending)||!Array.isArray(pages.added)||!Array.isArray(scope.checked_pages))return false;
  const ready=report.articles.map(a=>a.id),pending=pages.pending.map(p=>p.id);
  if(!equal(ready,ids.filter(id=>ready.includes(id)))||!equal(pending,ids.filter(id=>!ready.includes(id)))||(!successor&&!equal(pages.added,ready))||!equal(scope.checked_pages,pages.added))return false;
  if(!pages.pending.every(p=>exact(p,['id','reason'])&&line(p.reason)))return false;
  if(!Array.isArray(report.entries)||!report.entries.every(e=>ready.includes(e.article_id)))return false;
  if(!ready.every(id=>report.entries.some(e=>e.article_id===id)))return false;
  if(!ready.every(id=>PAGE_CHECKS[id].every(c=>audit.coverage_checked.includes(c))))return false;
  if(!Array.isArray(audit.coverage_unchecked)||new Set(audit.coverage_unchecked).size!==audit.coverage_unchecked.length)return false;
  if(!audit.coverage_unchecked.every(c=>audit.coverage_incomplete.includes(c)&&pending.some(id=>PAGE_CHECKS[id].includes(c))))return false;
  return true;
 }catch{return false;}
}

function successorEvidenceValid(audit,report,previous,metadata){
 const {evidence,report:old,audit:summary,metadata:prior}=previous;
 if(!exact(evidence,['request_id','bundle_sha256','audit_sha256','archive_sha256','report_commit'])||!equal(audit.page_scope.previous_evidence,evidence)
  ||!equal(report.page_delivery.previous,{request_id:evidence.request_id,bundle_sha256:evidence.bundle_sha256}))return false;
 if(!summary||summary.audit_valid!==true||summary.delivery_allowed!==false||!equal(summary.blockers,[])||!['ready','partial','zero_items'].includes(summary.readiness)
  ||!prior||!equal(prior.page_scope,summary.page_scope)||prior.page_scope?.contract!=='verified_pages_v1'||!equal(metadata.page_scope,audit.page_scope))return false;
 if(!/^[a-f0-9]{64}$/.test(audit.evidence_metadata_sha256??'')||!/^[a-f0-9]{64}$/.test(summary.evidence_metadata_sha256??''))return false;
 if(report.date!==old.date||report.revision!==old.revision+1||evidence.request_id!==`morning-${report.date.replaceAll('-','')}-r${old.revision}`)return false;
 if(!equal(old.page_delivery,prior.page_scope.page_delivery)||!equal(metadata.limits,prior.limits)||metadata.started_at!==prior.started_at||metadata.budget_policy!==prior.budget_policy)return false;
 for(const key of ['prompt_commit','history_commit','prompt_hashes','history_sha256'])if(!equal(metadata.inputs?.[key],prior.inputs?.[key]))return false;
 if(!Array.isArray(metadata.sources)||!Array.isArray(prior.sources)||!equal(metadata.sources.slice(0,prior.sources.length),prior.sources))return false;
 const added=report.page_delivery.added,oldReady=old.articles.map(a=>a.id),oldPending=old.page_delivery.pending.map(p=>p.id);
 if(!equal(added,ids.filter(id=>added.includes(id)))||added.length===0||!added.every(id=>oldPending.includes(id))
  ||!equal(report.articles.map(a=>a.id),ids.filter(id=>oldReady.includes(id)||added.includes(id)))
  ||!equal(report.page_delivery.pending.map(p=>p.id),oldPending.filter(id=>!added.includes(id))))return false;
 for(const article of old.articles){
  if(!equal(report.articles.find(a=>a.id===article.id),article))return false;
  if(!equal(report.entries.filter(e=>e.article_id===article.id),old.entries.filter(e=>e.article_id===article.id)))return false;
  for(const check of PAGE_CHECKS[article.id])if(!equal(metadata.checks?.[check],prior.checks?.[check]))return false;
 }
 if(!Array.isArray(metadata.model_calls)||!Array.isArray(prior.model_calls)||metadata.model_calls.length!==2||prior.model_calls.length!==2)return false;
 for(const stage of ['research','editor']){
  const call=metadata.model_calls.find(c=>c.stage===stage),oldCall=prior.model_calls.find(c=>c.stage===stage);
  if(!call||!oldCall||!Array.isArray(call.attempt_records)||!Array.isArray(oldCall.attempt_records)||call.attempt_records.length<=oldCall.attempt_records.length
   ||!equal(call.attempt_records.slice(0,oldCall.attempt_records.length),oldCall.attempt_records))return false;
  const allowed=previous.allowed_pages??added,newAttempts=call.attempt_records.slice(oldCall.attempt_records.length);
  if(!Array.isArray(allowed)||!equal(allowed,ids.filter(id=>allowed.includes(id)))||!added.every(id=>allowed.includes(id)))return false;
  for(const attempt of newAttempts){
   const round=attempt.page_round,pages=round?.page_ids;
   if(!exact(round,['revision','page_ids','previous_audit_sha256'])||round.revision!==report.revision||round.previous_audit_sha256!==evidence.audit_sha256
    ||!Array.isArray(pages)||pages.length===0||!equal(pages,ids.filter(id=>pages.includes(id)))||!pages.every(id=>allowed.includes(id)&&oldPending.includes(id)))return false;
  }
  const lastSuccess=newAttempts.findLast(a=>['ok','partial','success'].includes(a.status??a.outcome));
  if(!lastSuccess||!added.every(id=>lastSuccess.page_round.page_ids.includes(id)))return false;
 }
 return true;
}

// Before an immutable permit can send a partial edition, preserve everything the
// next round needs. The caller resolves metadata by its hash from original T4
// archive bytes, never a client-supplied parsed object or reserialized digest.
export function resumablePageMetadataValid(audit,metadata){
 if(!/^[a-f0-9]{64}$/.test(audit?.evidence_metadata_sha256??'')||!metadata||typeof metadata!=='object'||Array.isArray(metadata)
  ||!equal(metadata.page_scope,audit.page_scope)||!audit.inputs||!Object.keys(audit.inputs).every(k=>equal(metadata.inputs?.[k],audit.inputs[k]))||!equal(metadata.limits,audit.limits)
  ||metadata.budget_policy!==audit.budget_policy||typeof metadata.started_at!=='string'||!Number.isFinite(Date.parse(metadata.started_at)))return false;
 if(metadata.schema_version!=='1.4'||metadata.date!==audit.date||metadata.scope!=='new_daily'||!Array.isArray(metadata.decisions)||!Array.isArray(metadata.status_entries))return false;
 if(!Array.isArray(metadata.sources)||!metadata.sources.every(s=>s&&typeof s==='object'&&!Array.isArray(s)))return false;
 if(!metadata.checks||typeof metadata.checks!=='object'||!Object.values(PAGE_CHECKS).flat().every(k=>metadata.checks[k]&&typeof metadata.checks[k]==='object'))return false;
 if(!Array.isArray(metadata.model_calls)||metadata.model_calls.length!==2)return false;
 return ['research','editor'].every(stage=>{
  const calls=metadata.model_calls.filter(c=>c&&c.stage===stage);
  return calls.length===1&&exact(calls[0].model,['name','version','unavailable_reason'])&&['name','version'].every(k=>calls[0].model[k]===null||typeof calls[0].model[k]==='string')&&typeof calls[0].model.unavailable_reason==='string'&&Array.isArray(calls[0].attempt_records)&&calls[0].attempt_records.every(a=>a&&typeof a==='object'&&!Array.isArray(a));
 });
}
