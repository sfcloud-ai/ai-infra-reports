// Shared synthetic Python audit outputs. No production state or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {discoveryCoverageBound,discoverySourcesPreserved} from '../scripts/research-discovery.mjs';
import {pageCoverageValid} from '../scripts/research-page-coverage.mjs';
const read=(name,path)=>readFileSync(new URL(`./fixtures/research-cancellation/${name}/${path}`,import.meta.url));
const json=(name,path)=>JSON.parse(read(name,path));
function fixture(name){
 const audit=json(name,'summary.json'),metadata=json(name,'audit.json'),bytes=read(name,'draft.json');
 const bundle={files:[{path:`reports/${audit.date}/report.json`,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}]};
 assert.equal(createHash('sha256').update(read(name,'audit.json')).digest('hex'),audit.evidence_metadata_sha256);
 const previous=name.startsWith('successor')?{evidence:audit.page_scope.previous_evidence,report:json(name,'previous/report.json'),audit:json(name,'previous/audit.json'),metadata:json(name,'previous/metadata.json')}:null;
 return {audit,metadata,bundle,previous};
}
for(const name of ['cancel_only','ok_cancel','failed_cancel','successor_v1','successor_v2'])test('Python cancellation fixture agrees with host '+name,()=>{
 const f=fixture(name);assert.equal(f.audit.audit_valid,true);assert.equal(discoveryCoverageBound(f.audit,f.metadata),true);
 if(f.previous){assert.equal(discoverySourcesPreserved(f.metadata,f.previous.metadata),true);assert.equal(pageCoverageValid(f.audit,f.bundle,f.previous,f.metadata),true);}
});
for(const name of ['successor_v1','successor_v2'])test('successor cancellation preserves original response and attempt prefix '+name,()=>{
 const f=fixture(name),prior=f.previous.metadata;
 const index=prior.sources.findIndex(source=>source.attempt_records?.length&&source.attempt_records.every(attempt=>attempt.status==='not_dispatched'));
 assert(index>=0);
 const corrupt=structuredClone(f.metadata);corrupt.sources[index].attempt_records[0].error='changed original evidence';
 assert.equal(discoverySourcesPreserved(corrupt,prior),false);
 const cancelled=structuredClone(f.metadata),old=prior.sources[index];cancelled.sources[index]=structuredClone(old);
 cancelled.sources[index].attempt_records.push({...old.attempt_records.at(-1),operation_id:'00000000-0000-4000-8000-000000000099'});cancelled.sources[index].attempts++;
 assert.equal(discoverySourcesPreserved(cancelled,prior),true);
 for(const field of ['content_sha256','retrieved_at','published_at']){
  const changed=structuredClone(cancelled);changed.sources[index][field]=field==='content_sha256'?'f'.repeat(64):'2026-11-06T00:01:00Z';
  assert.equal(discoverySourcesPreserved(changed,prior),false);
 }
});
test('discovery cancellation is neither successful coverage nor a failed request',()=>{
 for(const status of ['checked','failed']){
  const f=fixture('cancel_only'),name=f.metadata.discovery.queries.find(q=>q.mode==='current'&&f.metadata.checks[q.family].status==='not_checked').family;
  f.metadata.checks[name].status=status;f.audit.coverage_unchecked=f.audit.coverage_unchecked.filter(n=>n!==name);
  if(status==='checked')f.audit.coverage_checked.push(name);
  assert.equal(discoveryCoverageBound(f.audit,f.metadata),false);
 }
});
test('discovery rejects duplicate or out-of-range attempt bindings',()=>{
 for(const mutate of [q=>{q.attempt=999;},(q,metadata)=>{metadata.discovery.queries.push({...q,id:'duplicate-attempt'});}]){
  const f=fixture('ok_cancel');mutate(f.metadata.discovery.queries[0],f.metadata);
  assert.equal(discoveryCoverageBound(f.audit,f.metadata),false);
 }
});

test('shared cancellation fixtures preserve the validator original bytes',()=>{
 const provenance=JSON.parse(readFileSync(new URL('./fixtures/research-cancellation/provenance.json',import.meta.url)));
 assert.equal(provenance.synthetic,true);assert.match(provenance.validator_commit,/^[a-f0-9]{40}$/);
 for(const [path,hash] of Object.entries(provenance.files))assert.equal(createHash('sha256').update(readFileSync(new URL('./fixtures/research-cancellation/'+path,import.meta.url))).digest('hex'),hash);
});

test('a hidden executed failure cannot become cancellation-only discovery',()=>{
 const f=fixture('ok_cancel'),query=f.metadata.discovery.queries[0];
 const source=f.metadata.sources.find(source=>source.id===query.source_id);
 source.attempt_records[0].status='failed';
 source.attempt_records.push({...source.attempt_records[0],status:'not_dispatched'});query.attempt=source.attempt_records.length;
 f.metadata.checks[query.family].status='not_checked';f.audit.coverage_checked=f.audit.coverage_checked.filter(name=>name!==query.family);
 if(!f.audit.coverage_unchecked.includes(query.family))f.audit.coverage_unchecked.push(query.family);
 assert.equal(discoveryCoverageBound(f.audit,f.metadata),false);
});

test('cancellation-only discovery requires its indexed retained attempt',()=>{
 const f=fixture('cancel_only');const query=f.metadata.discovery.queries.find(q=>f.metadata.checks[q.family].status==='not_checked');
 const source=f.metadata.sources.find(source=>source.id===query.source_id);assert.equal(source.status,'not_dispatched');delete source.attempt_records;
 assert.equal(discoveryCoverageBound(f.audit,f.metadata),false);
});

test('discovery retains cancelled attempts within the query limit',()=>{
 const f=fixture('cancel_only'),q=f.metadata.discovery.queries.find(q=>f.metadata.checks[q.family].status==='not_checked');
 const source=f.metadata.sources.find(source=>source.id===q.source_id);
 source.attempt_records.push({...source.attempt_records[0]});source.attempts++;
 assert.equal(discoveryCoverageBound(f.audit,f.metadata),false);
});
test('cancel-only null retrieval never becomes successful coverage',()=>{
 const f=fixture('cancel_only'),q=f.metadata.discovery.queries.find(q=>f.metadata.checks[q.family].status==='not_checked');
 const source=f.metadata.sources.find(source=>source.id===q.source_id);assert.equal(source.retrieved_at,null);
 assert.equal(discoveryCoverageBound(f.audit,f.metadata),true);
 f.metadata.checks[q.family].status='checked';f.audit.coverage_checked.push(q.family);f.audit.coverage_unchecked=f.audit.coverage_unchecked.filter(x=>x!==q.family);
 assert.equal(discoveryCoverageBound(f.audit,f.metadata),false);
});

test('ordinary legacy discovery retry need not backfill an earlier query',()=>{
 const f=fixture('ok_cancel');
 const cancelledQueries=new Set(f.metadata.discovery.queries.filter(q=>f.metadata.sources.find(x=>x.id===q.source_id).attempt_records[q.attempt-1].status==='not_dispatched').map(q=>q.id));
 for(const source of f.metadata.sources)if(source.attempt_records){source.attempt_records=source.attempt_records.filter(a=>a.status!=='not_dispatched');source.attempts=source.attempt_records.length;}
 f.metadata.discovery.queries=f.metadata.discovery.queries.filter(q=>!cancelledQueries.has(q.id));
 const q=f.metadata.discovery.queries[0],source=f.metadata.sources.find(x=>x.id===q.source_id);
 source.attempt_records.unshift({status:'timeout',elapsed_seconds:1,error:'timeout'});source.attempts++;q.attempt++;
 assert.equal(discoveryCoverageBound(f.audit,f.metadata),true);
});
test('cancel-only source cannot claim a retrieval timestamp',()=>{
 const f=fixture('cancel_only'),source=f.metadata.sources.find(x=>x.attempt_records?.every(a=>a.status==='not_dispatched'));
 source.retrieved_at='2026-11-06T07:22:00+08:00';assert.equal(discoveryCoverageBound(f.audit,f.metadata),false);
});

test('first actual read after cancelled-only history follows the previous finish',()=>{
 const f=fixture('successor_v2'),index=f.previous.metadata.sources.findIndex(x=>x.attempt_records?.every(a=>a.status==='not_dispatched'));
 assert(index>=0);assert.equal(discoverySourcesPreserved(f.metadata,f.previous.metadata),true);
 f.metadata.sources[index].retrieved_at='2026-11-06T07:29:59.999999+08:00';
 assert.equal(discoverySourcesPreserved(f.metadata,f.previous.metadata),false);
});
