// Versioned budgets keep existing ledger bytes and semantics immutable.
export const isRepositoryResearchPlan = plan => ['research_plan_v3','research_plan_v4'].includes(plan?.schema_version);
export const isLayeredResearchPlan = plan => plan?.schema_version === 'research_plan_v4';
export function operationBudget(plan, kind) {
 if (!isLayeredResearchPlan(plan)) return plan.limits.operation_timeout_seconds;
 return kind === 'source' ? plan.limits.source_attempt_timeout_seconds : plan.limits.model_stage_timeout_seconds;
}
export function auditBudget(plan) {
 const common={source_attempts:plan.limits.max_attempts_per_source,model_attempts:plan.limits.max_attempts_per_model};
 return isLayeredResearchPlan(plan)
  ? {...common,source_attempt_seconds:plan.limits.source_attempt_timeout_seconds,model_stage_seconds:plan.limits.model_stage_timeout_seconds,run_seconds:plan.limits.total_budget_seconds}
  : {...common,operation_seconds:plan.limits.operation_timeout_seconds,run_seconds:plan.limits.total_budget_seconds};
}
export const LAYERED_BUDGET_POLICY='successful_work_hourly_continuation_v1';
export function continuationWindow(now){
 const hour=3600000,start=Math.floor((now-20*60000)/hour)*hour+20*60000;
 return {start,deadline:start+hour};
}

// Bounded arithmetic tolerance only; never round or increase stored quotas.
export const RESEARCH_SECONDS_EPSILON=1e-6;
export const researchSecondsWithin=(actual,limit)=>Number.isFinite(actual)&&Number.isFinite(limit)&&actual<=limit+RESEARCH_SECONDS_EPSILON;
