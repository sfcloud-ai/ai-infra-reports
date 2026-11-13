import {isLayeredResearchPlan,auditBudget,LAYERED_BUDGET_POLICY} from './research-budget.mjs';
// The host checks the trusted audit declaration and its exact original inputs.
// Source semantics and article quality still require independent content review.
export const REQUIRED_RESEARCH_CHECKS=Object.freeze([
 'model_serving','hardware','model_architecture','embodied_training','small_models','inference_engines',
 'vllm','sglang','deepinfer','vllm_blog','sglang_blog','lmsys_blog','deepseek_articles',
 'deepinfer_articles','glm_blog','qwen_blog','glm_models','deepseek_models','qwen_models'
]);
const sameSet=(a,b)=>Array.isArray(a)&&a.every(x=>typeof x==='string')&&new Set(a).size===a.length&&a.length===b.length&&a.every(x=>b.includes(x));
export function requiredCoverageValid(audit,plan,bundle){
 if(audit?.schema_version!==(isLayeredResearchPlan(plan)?'1.4':'1.3')||audit.coverage_contract!=='daily_required_v1'||audit.delivery_allowed!==false
  ||!sameSet(audit.required_checks,REQUIRED_RESEARCH_CHECKS)||!sameSet(audit.coverage_unchecked,[])
  ||!Array.isArray(audit.coverage_checked)||!Array.isArray(audit.coverage_incomplete)
  ||!sameSet([...audit.coverage_checked,...audit.coverage_incomplete],REQUIRED_RESEARCH_CHECKS))return false;
 const gaps=audit.coverage_incomplete.length;
 if(gaps?(audit.readiness!=='partial'||!Number.isSafeInteger(audit.selected_count)||audit.selected_count<1)
  :!['ready','zero_items'].includes(audit.readiness)||!Number.isSafeInteger(audit.selected_count)
    ||(audit.readiness==='zero_items'?audit.selected_count!==0:audit.selected_count<1))return false;
 if(isLayeredResearchPlan(plan)&&audit.budget_policy!==LAYERED_BUDGET_POLICY)return false;
 const inputs=audit.inputs,prompts=Object.keys(plan.files).filter(path=>path.startsWith('ai_brief/resources/prompts/'));
 if(!inputs||inputs.prompt_commit!==plan.prompt_commit_sha||inputs.history_commit!==plan.reports_commit_sha
  ||inputs.history_sha256!==plan.files['reports/index.json']||!inputs.prompt_hashes
  ||!sameSet(Object.keys(inputs.prompt_hashes),prompts.map(path=>path.split('/').at(-1)))
  ||!prompts.every(path=>inputs.prompt_hashes[path.split('/').at(-1)]===plan.files[path]))return false;
 const reports=bundle.files.filter(file=>file.path.endsWith('/report.json'));
 if(reports.length!==1||inputs.draft_sha256!==reports[0].sha256)return false;
 const expected=auditBudget(plan);
 return audit.limits&&sameSet(Object.keys(audit.limits),Object.keys(expected))&&Object.entries(expected).every(([key,value])=>audit.limits[key]===value);
}
