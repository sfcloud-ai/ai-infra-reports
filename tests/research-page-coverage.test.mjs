import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {initialPageCoverageValid,PAGE_CHECKS} from '../scripts/research-page-coverage.mjs';
function fixture(){
 const pending=Object.keys(PAGE_CHECKS).slice(1).map(id=>({id,reason:'尚未完成来源核验'}));
 const page_delivery={previous:null,added:['model-serving-gpu'],pending};
 const report={schema_version:'1.2',date:'2026-11-13',revision:1,articles:[{id:'model-serving-gpu'}],entries:[{article_id:'model-serving-gpu'}],page_delivery};
 const audit={schema_version:'1.4',date:report.date,coverage_checked:['model_serving'],coverage_unchecked:pending.flatMap(p=>PAGE_CHECKS[p.id]),coverage_incomplete:pending.flatMap(p=>PAGE_CHECKS[p.id]),page_scope:{contract:'verified_pages_v1',page_delivery:structuredClone(page_delivery),checked_pages:['model-serving-gpu'],previous_evidence:null}};
 return {audit,report};
}
function bundle(report){const b=Buffer.from(JSON.stringify(report));return {files:[{path:'reports/2026-11-13/report.json',base64:b.toString('base64'),sha256:createHash('sha256').update(b).digest('hex')}]};}
test('explicit first page contract preserves honest unchecked pending directions',()=>{const {audit,report}=fixture();assert.equal(initialPageCoverageValid(audit,bundle(report)),true);});
for(const [name,change] of Object.entries({
 'unchecked ready topic':a=>a.coverage_checked=[],
 'unbound reason':a=>a.page_scope.page_delivery.pending[0].reason='different',
 'successor not supported':a=>a.page_scope.page_delivery.previous={request_id:'morning-20261113-r1',bundle_sha256:'a'.repeat(64)},
 'fabricated previous evidence':a=>a.page_scope.previous_evidence={audit_sha256:'a'.repeat(64)},
 'unknown check':a=>a.coverage_unchecked.push('invented'),
 'duplicate ready':a=>a.page_scope.checked_pages.push('model-serving-gpu'),
}))test(name,()=>{const {audit,report}=fixture();change(audit);assert.equal(initialPageCoverageValid(audit,bundle(report)),false);});
test('ready page cannot borrow pending entries or corrupt bytes',()=>{const {audit,report}=fixture();report.entries[0].article_id='hardware-status';assert.equal(initialPageCoverageValid(audit,bundle(report)),false);const f=fixture(),b=bundle(f.report);b.files[0].sha256='0'.repeat(64);assert.equal(initialPageCoverageValid(f.audit,b),false);});
import {requiredCoverageValid,REQUIRED_RESEARCH_CHECKS} from '../scripts/research-coverage.mjs';
import {auditBudget,LAYERED_BUDGET_POLICY} from '../scripts/research-budget.mjs';
test('permit coverage binds original inputs, draft bytes, and opt-in without weakening legacy',()=>{
 const {audit,report}=fixture(),b=bundle(report),plan={schema_version:'research_plan_v4',prompt_commit_sha:'a'.repeat(40),reports_commit_sha:'b'.repeat(40),files:{'reports/index.json':'c'.repeat(64)},limits:{max_attempts_per_source:2,max_attempts_per_model:1,source_attempt_timeout_seconds:180,model_stage_timeout_seconds:900,total_budget_seconds:3600}};
 Object.assign(audit,{delivery_allowed:false,coverage_contract:'daily_required_v1',required_checks:[...REQUIRED_RESEARCH_CHECKS],readiness:'partial',selected_count:1,budget_policy:LAYERED_BUDGET_POLICY,limits:auditBudget(plan),inputs:{prompt_commit:plan.prompt_commit_sha,history_commit:plan.reports_commit_sha,history_sha256:plan.files['reports/index.json'],prompt_hashes:{},draft_sha256:b.files[0].sha256}});
 assert.equal(requiredCoverageValid(audit,plan,b),true);
 const old=structuredClone(audit);delete old.page_scope;assert.equal(requiredCoverageValid(old,plan,b),false);
 audit.inputs.draft_sha256='d'.repeat(64);assert.equal(requiredCoverageValid(audit,plan,b),false);
});
