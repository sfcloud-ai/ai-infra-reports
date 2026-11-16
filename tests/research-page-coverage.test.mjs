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
import {pageCoverageValid} from '../scripts/research-page-coverage.mjs';
import {DISCOVERY_CONTRACT,DISCOVERY_CHECKS} from '../scripts/research-discovery.mjs';
function successor(){
 const first=fixture();const evidence={request_id:'morning-20261113-r1',bundle_sha256:'a'.repeat(64),audit_sha256:'b'.repeat(64),archive_sha256:'c'.repeat(64),report_commit:'d'.repeat(40)};
 const prior={page_scope:first.audit.page_scope,limits:{run_seconds:3600},started_at:'original',budget_policy:LAYERED_BUDGET_POLICY,inputs:{prompt_commit:'f'.repeat(40),history_commit:'e'.repeat(40),prompt_hashes:{},history_sha256:'a'.repeat(64)},sources:[{id:'original',status:'ok'}],checks:Object.fromEntries(Object.values(PAGE_CHECKS).flat().map(k=>[k,{status:k==='model_serving'?'checked':'not_checked'}])),model_calls:['research','editor'].map(stage=>({stage,attempt_records:[{outcome:'success',elapsed_seconds:20}]}))};
 const report=structuredClone(first.report);report.revision=2;report.articles.push({id:'hardware-status'});report.entries.push({article_id:'hardware-status'});report.page_delivery={previous:{request_id:evidence.request_id,bundle_sha256:evidence.bundle_sha256},added:['hardware-status'],pending:report.page_delivery.pending.slice(1)};
 const audit=structuredClone(first.audit);audit.coverage_checked.push('hardware');audit.coverage_unchecked=audit.coverage_unchecked.filter(c=>c!=='hardware');audit.coverage_incomplete=audit.coverage_incomplete.filter(c=>c!=='hardware');audit.evidence_metadata_sha256='f'.repeat(64);audit.page_scope={contract:'verified_pages_v1',page_delivery:report.page_delivery,checked_pages:['hardware-status'],previous_evidence:evidence};
 const metadata=structuredClone(prior);metadata.page_scope=structuredClone(audit.page_scope);metadata.checks.hardware={status:'checked'};for(const call of metadata.model_calls)call.attempt_records.push({outcome:'success',elapsed_seconds:10,page_round:{revision:2,page_ids:['hardware-status'],previous_audit_sha256:evidence.audit_sha256}});
 const previous={evidence,report:first.report,audit:{...first.audit,audit_valid:true,delivery_allowed:false,readiness:'partial',blockers:[],evidence_metadata_sha256:'e'.repeat(64)},metadata:prior};return {audit,report,previous,metadata};
}
test('successor requires authenticated original metadata and retains original pages and operations',()=>{const f=successor();assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),true);assert.equal(pageCoverageValid(f.audit,bundle(f.report)),false);});
test('v2 continuation appends discovery and preserves original query and contract bytes',()=>{
 const f=successor(),old=f.previous.metadata;
 for(const object of [f.audit,f.previous.audit,f.metadata,old])object.coverage_contract=DISCOVERY_CONTRACT;
 const queries=DISCOVERY_CHECKS.slice(0,3).map((family,i)=>({id:'query-'+i,family,mode:'current',query:'Synthetic query '+i}));
 old.discovery={queries:structuredClone(queries)};
 f.metadata.discovery={queries:[...structuredClone(queries),{id:'query-3',family:'discovery_data_path',mode:'current',query:'Synthetic data path query'}]};
 for(const family of DISCOVERY_CHECKS.slice(0,3)){
  old.checks[family]={status:'checked'};f.metadata.checks[family]={status:'checked'};
 }
 f.audit.coverage_checked.push(...DISCOVERY_CHECKS);
 assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),true);
 f.metadata.discovery.queries[0].query='Rewritten old search';
 assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),false);
 f.metadata.discovery.queries[0].query=queries[0].query;old.coverage_contract='daily_required_v1';
 assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),false);
});
test('v2 pending discovery retries preserve the same source attempts and old query',()=>{
 const f=successor(),old=f.previous.metadata;
 for(const object of [f.audit,f.previous.audit,f.metadata,old])object.coverage_contract=DISCOVERY_CONTRACT;
 const query={id:'failed-search',family:'discovery_data_path',mode:'current',source_id:'search',attempt:1,response_sha256:null,results:[]};
 old.discovery={queries:[query]};f.metadata.discovery={queries:[structuredClone(query),{...query,id:'retry',attempt:2,response_sha256:'a'.repeat(64)}]};
 for(const family of DISCOVERY_CHECKS.slice(0,3)){old.checks[family]={status:'checked',source_ids:[]};f.metadata.checks[family]=structuredClone(old.checks[family]);}
 old.checks.discovery_data_path={status:'failed',source_ids:['search']};f.metadata.checks.discovery_data_path={status:'no_qualifying_items',source_ids:['search']};
 const source={id:'search',url:'https://api.github.com/search/issues?q=GPU+RDMA',attempts:1,status:'failed',elapsed_seconds:3,content_sha256:null,attempt_records:[{status:'failed',elapsed_seconds:3}]};
 old.sources.push(source);f.metadata.sources.push({...source,attempts:2,status:'ok',elapsed_seconds:5,content_sha256:'a'.repeat(64),attempt_records:[...structuredClone(source.attempt_records),{status:'ok',elapsed_seconds:2}]});
 f.audit.coverage_checked.push(...DISCOVERY_CHECKS);
 assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),true);
 f.metadata.sources.at(-1).attempt_records[0].elapsed_seconds=0;
 assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),false);
 f.metadata.sources.at(-1).attempt_records[0].elapsed_seconds=3;f.metadata.sources.at(-1).elapsed_seconds=1;
 assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),false);
 f.metadata.sources.at(-1).elapsed_seconds=null;f.metadata.sources.at(-1).attempt_records.at(-1).elapsed_seconds=null;
 assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),true);
});
for(const [name,change] of Object.entries({
 'dropped old source':f=>f.metadata.sources=[],
 'changed old attempt':f=>f.metadata.model_calls[0].attempt_records[0].elapsed_seconds=0,
 'unbound current round':f=>f.metadata.model_calls[0].attempt_records[1].page_round.page_ids=['small-model-status'],
 'changed old page':f=>f.report.articles[0].title='replacement',
 'changed old check':f=>f.metadata.checks.model_serving={status:'not_checked'},
 'reset budget clock':f=>f.metadata.started_at='new',
 'unbound previous summary':f=>f.previous.audit.evidence_metadata_sha256=null,
 'wrong authenticated receipt':f=>f.previous.evidence.report_commit='e'.repeat(40),
}))test('successor rejects '+name,()=>{const f=successor();change(f);assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),false);});
test('completed subset preserves wider failed attempts but cannot expand the host allowed set',()=>{
 const f=successor();f.previous.allowed_pages=['hardware-status','embodied-training'];
 for(const call of f.metadata.model_calls){
  const successful=call.attempt_records.at(-1);successful.page_round.page_ids=['hardware-status','embodied-training'];
  call.attempt_records.splice(-1,0,{status:'failed',elapsed_seconds:2,page_round:{...successful.page_round,page_ids:['embodied-training']}});
 }
 assert.equal(pageCoverageValid(f.audit,bundle(f.report),f.previous,f.metadata),true);
 const bad=structuredClone(f);bad.metadata.model_calls[0].attempt_records.at(-1).page_round.page_ids=['hardware-status','small-model-status'];
 assert.equal(pageCoverageValid(bad.audit,bundle(bad.report),bad.previous,bad.metadata),false);
 const uncovered=structuredClone(f);uncovered.metadata.model_calls[1].attempt_records.at(-1).page_round.page_ids=['embodied-training'];
 assert.equal(pageCoverageValid(uncovered.audit,bundle(uncovered.report),uncovered.previous,uncovered.metadata),false);
});
