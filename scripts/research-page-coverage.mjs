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
export function initialPageCoverageValid(audit,bundle){
 try{
  const scope=audit.page_scope;
  if(audit.schema_version!=='1.4'||!exact(scope,['contract','page_delivery','checked_pages','previous_evidence'])||scope.contract!=='verified_pages_v1'||scope.previous_evidence!==null)return false;
  const files=bundle.files.filter(f=>f.path.endsWith('/report.json'));if(files.length!==1)return false;
  const file=files[0],bytes=Buffer.from(file.base64,'base64');
  if(bytes.toString('base64')!==file.base64||createHash('sha256').update(bytes).digest('hex')!==file.sha256)return false;
  const report=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)),pages=scope.page_delivery;
  if(report.schema_version!=='1.2'||report.revision!==1||report.date!==audit.date||!exact(pages,['previous','added','pending'])||pages.previous!==null||!equal(report.page_delivery,pages))return false;
  if(!Array.isArray(report.articles)||report.articles.length===0||!Array.isArray(pages.pending)||!Array.isArray(pages.added)||!Array.isArray(scope.checked_pages))return false;
  const ready=report.articles.map(a=>a.id),pending=pages.pending.map(p=>p.id);
  if(!equal(ready,ids.filter(id=>ready.includes(id)))||!equal(pending,ids.filter(id=>!ready.includes(id)))||!equal(pages.added,ready)||!equal(scope.checked_pages,ready))return false;
  if(!pages.pending.every(p=>exact(p,['id','reason'])&&line(p.reason)))return false;
  if(!Array.isArray(report.entries)||!report.entries.every(e=>ready.includes(e.article_id)))return false;
  if(!ready.every(id=>report.entries.some(e=>e.article_id===id)))return false;
  if(!ready.every(id=>PAGE_CHECKS[id].every(c=>audit.coverage_checked.includes(c))))return false;
  if(!Array.isArray(audit.coverage_unchecked)||new Set(audit.coverage_unchecked).size!==audit.coverage_unchecked.length)return false;
  if(!audit.coverage_unchecked.every(c=>audit.coverage_incomplete.includes(c)&&pending.some(id=>PAGE_CHECKS[id].includes(c))))return false;
  return true;
 }catch{return false;}
}
