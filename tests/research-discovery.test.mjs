// Synthetic contract regression; no live searches or publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {requiredCoverageValid,REQUIRED_RESEARCH_CHECKS} from '../scripts/research-coverage.mjs';
import {DISCOVERY_CONTRACT,DISCOVERY_CHECKS,discoveryCoverageBound} from '../scripts/research-discovery.mjs';
import {PAGE_CHECKS,pageCoverageValid} from '../scripts/research-page-coverage.mjs';
import {auditBudget,LAYERED_BUDGET_POLICY} from '../scripts/research-budget.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const ids=Object.keys(PAGE_CHECKS),pages={previous:null,added:ids,pending:[]};
 const report={schema_version:'1.2',date:'2026-11-17',revision:1,articles:ids.map(id=>({id})),entries:ids.map(article_id=>({article_id})),page_delivery:pages};
 const bytes=Buffer.from(JSON.stringify(report)),bundle={files:[{path:'reports/2026-11-17/report.json',base64:bytes.toString('base64'),sha256:hash(bytes)}]};
 const plan={schema_version:'research_plan_v4',prompt_commit_sha:'a'.repeat(40),reports_commit_sha:'b'.repeat(40),files:{'reports/index.json':'c'.repeat(64)},limits:{max_attempts_per_source:2,max_attempts_per_model:2,source_attempt_timeout_seconds:180,model_stage_timeout_seconds:1200,total_budget_seconds:3600}};
 const required=[...REQUIRED_RESEARCH_CHECKS,...DISCOVERY_CHECKS];
 const metadata={schema_version:'1.4',coverage_contract:DISCOVERY_CONTRACT,discovery:{queries:DISCOVERY_CHECKS.map((family,i)=>({id:'query-'+i,family,mode:'current',source_id:'search-'+i,results:[]}))},checks:Object.fromEntries(required.map(name=>[name,{status:'checked',source_ids:DISCOVERY_CHECKS.includes(name)?['search-'+DISCOVERY_CHECKS.indexOf(name)]:[]}])),sources:DISCOVERY_CHECKS.map((_,i)=>({id:'search-'+i,status:'ok'}))};
 const audit={schema_version:'1.4',date:report.date,coverage_contract:DISCOVERY_CONTRACT,delivery_allowed:false,required_checks:required,coverage_checked:required,coverage_incomplete:[],coverage_unchecked:[],selected_count:1,readiness:'ready',page_scope:{contract:'verified_pages_v1',page_delivery:pages,checked_pages:ids,previous_evidence:null},budget_policy:LAYERED_BUDGET_POLICY,limits:auditBudget(plan),inputs:{prompt_commit:plan.prompt_commit_sha,history_commit:plan.reports_commit_sha,history_sha256:plan.files['reports/index.json'],prompt_hashes:{},draft_sha256:hash(bytes)},evidence_metadata_sha256:hash(JSON.stringify(metadata))};
 return {audit,metadata,plan,bundle,report};
}
const valid=f=>requiredCoverageValid(f.audit,f.plan,f.bundle,null,f.metadata);
test('new declaration retains fixed checks and binds four discovery operations',()=>assert.equal(valid(fixture()),true));
for(const [name,change]of Object.entries({
 'missing metadata':f=>f.metadata=null,
 'old declared metadata':f=>f.metadata.coverage_contract='daily_required_v1',
 'missing discovery':f=>delete f.metadata.discovery,
 'fixed sources only':f=>f.audit.required_checks=REQUIRED_RESEARCH_CHECKS,
 'one family omitted':f=>f.metadata.discovery.queries.pop(),
 'followup masquerading as current':f=>f.metadata.discovery.queries[0].mode='followup',
 'unknown query source':f=>f.metadata.discovery.queries[0].source_id='absent',
 'failed source as completed':f=>f.metadata.sources[0].status='failed',
 'metadata check differs':f=>f.metadata.checks.discovery_memory.status='not_checked',
 'null source':f=>f.metadata.sources.push(null),
 'duplicate source':f=>f.metadata.sources.push(f.metadata.sources[0]),
 'unknown check status':f=>f.metadata.checks.discovery_memory.status='nonsense',
 'missing archive binding':f=>delete f.audit.evidence_metadata_sha256,
 'new contract on old budget':f=>f.plan.schema_version='research_plan_v3',
}))test('rejects '+name,()=>{const f=fixture();change(f);assert.equal(valid(f),false);});
test('v1 historical declarations remain valid without discovery metadata',()=>{
 const f=fixture();f.audit.coverage_contract='daily_required_v1';f.audit.required_checks=f.audit.coverage_checked=[...REQUIRED_RESEARCH_CHECKS];delete f.audit.evidence_metadata_sha256;
 assert.equal(requiredCoverageValid(f.audit,f.plan,f.bundle),true);assert.equal(valid(f),false);
});
test('a ready page requires its versioned discovery checks',()=>{
 const f=fixture();for(const family of DISCOVERY_CHECKS){
  const a=structuredClone(f.audit);a.coverage_checked=a.coverage_checked.filter(c=>c!==family);a.coverage_incomplete=[family];a.coverage_unchecked=[family];
  assert.equal(pageCoverageValid(a,f.bundle),false);
 }
});

// A verified predecessor may predate cancellation query completeness. Do not
// invent queries for its frozen failed attempts when a successor cancels.
test('successor cancellation preserves authenticated legacy query prefix',()=>{
 const f=fixture(),source=f.metadata.sources[0],query=f.metadata.discovery.queries[0];
 source.status='failed';source.attempt_records=[{status:'timeout'},{status:'timeout'}];query.attempt=2;
 f.metadata.checks.discovery_memory.status='failed';
 f.audit.coverage_checked=f.audit.coverage_checked.filter(c=>c!=='discovery_memory');
 const previous=structuredClone(f.metadata);
 assert.equal(discoveryCoverageBound(f.audit,f.metadata),true);
 source.attempt_records.push({status:'not_dispatched'});
 f.metadata.discovery.queries.push({...query,id:'cancel-query',mode:'followup',attempt:3});
 assert.equal(discoveryCoverageBound(f.audit,f.metadata),false);
 assert.equal(discoveryCoverageBound(f.audit,f.metadata,previous),true);
 f.metadata.discovery.queries.pop();
 assert.equal(discoveryCoverageBound(f.audit,f.metadata,previous),false);
 f.metadata.discovery.queries.push({...query,id:'cancel-query',mode:'followup',attempt:3});
 source.attempt_records[0].status='ok';
 assert.equal(discoveryCoverageBound(f.audit,f.metadata,previous),false);
});
