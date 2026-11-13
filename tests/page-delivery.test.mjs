import test from 'node:test';
import assert from 'node:assert/strict';
import {TOPIC_IDS,validatePageDelivery} from '../scripts/page-delivery.mjs';
import {createNoticeManifest} from '../scripts/notice-manifest.mjs';
const hash='a'.repeat(64),commit='b'.repeat(40);
function report(n=2){const articles=TOPIC_IDS.slice(0,n).map(id=>({id,title:id,summary:'Verified fact',sha256:hash}));return {schema_version:'1.2',date:'2026-11-13',revision:1,title:'AI Infra 晨报 · 2026-11-13',subtitle:'待补页有明确原因',articles,entries:[],images:[{path:'assets/poster.png',sha256:hash,alt:'Poster'}],poster:'assets/poster.png',page_delivery:{previous:null,added:articles.map(a=>a.id),pending:TOPIC_IDS.slice(n).map(id=>({id,reason:'正文证据仍待核验'}))}};}
const manifest=r=>createNoticeManifest(Buffer.from(JSON.stringify(r)),commit,{stableUrls:true});
test('first notice includes only ready links and explains pending without links',()=>{const r=report(),m=manifest(r);assert.equal(m.schema_version,'1.1');assert.match(m.text,/晨报说明：/);for(const id of TOPIC_IDS.slice(2))assert.ok(!m.text.includes('/'+id+'/'));assert.equal(m.articles.length,2);});
test('supplement lists only newly completed page and retains original date',()=>{const r=report(3);r.revision=2;r.page_delivery.previous={request_id:'morning-20261113-r1',bundle_sha256:hash};r.page_delivery.added=[TOPIC_IDS[2]];r.revision_notice={kind:'page_completion',summary:'补齐架构页'};const m=manifest(r);assert.match(m.text,/2026-11-13 · 补充/);assert.ok(!m.text.includes('/model-serving-gpu/'));assert.ok(m.text.includes('/model-architecture-status/'));});
test('missing topics, duplicate/overlapping pages, stale-date binding rejected',()=>{for(const change of [r=>r.page_delivery.pending.pop(),r=>r.page_delivery.pending[0].id=TOPIC_IDS[0],r=>r.page_delivery.added=[],r=>r.page_delivery.pending[0].reason='\n',r=>r.page_delivery.previous={request_id:'morning-20261112-r1',bundle_sha256:hash}]){const r=report();change(r);assert.throws(()=>manifest(r));}});
test('pure contract rejects noncanonical topic order',()=>{const r=report();r.articles.reverse();assert.throws(()=>validatePageDelivery(r.page_delivery,r.articles,r.date,r.revision));});
import {validatePageProgressReport} from '../scripts/page-delivery.mjs';
test('publication cannot overwrite old pages or reannounce them as additions',()=>{const old=report(2),next=report(3);next.revision=2;next.page_delivery.previous={request_id:'morning-20261113-r1',bundle_sha256:hash};next.page_delivery.added=[TOPIC_IDS[2]];next.revision_notice={kind:'page_completion',summary:'新增架构页'};validatePageProgressReport(old,next);for(const mutate of [r=>r.articles[0].sha256='b'.repeat(64),r=>r.page_delivery.added.push(TOPIC_IDS[0]),r=>r.page_delivery.pending.pop()]){const bad=structuredClone(next);mutate(bad);assert.throws(()=>validatePageProgressReport(old,bad));}});
import {validatePageCorrectionReport} from '../scripts/page-delivery.mjs';
import {revisionNoticeText} from '../scripts/revision-notice.mjs';
test('correction preserves pending without masquerading as page completion',()=>{
 const old=report(),next=structuredClone(old);next.revision=2;next.page_delivery.previous={request_id:'morning-20261113-r1',bundle_sha256:hash};next.page_delivery.added=[];next.revision_notice={kind:'correction',summary:'纠正已发布硬件说明'};next.articles[0].sha256='c'.repeat(64);
 validatePageCorrectionReport(old,next);manifest(next);assert.match(revisionNoticeText(next),/重要更正/);assert.ok(!revisionNoticeText(next).includes('/model-serving-gpu/'));
 const maintenance=structuredClone(next);maintenance.revision_notice.kind='maintenance';assert.equal(revisionNoticeText(maintenance),'');
 for(const mutate of [r=>r.page_delivery.pending.pop(),r=>r.page_delivery.pending[0].reason='隐去缺口',r=>r.page_delivery.added.push(TOPIC_IDS[0]),r=>r.articles.pop()]){const bad=structuredClone(next);mutate(bad);assert.throws(()=>validatePageCorrectionReport(old,bad));}
 next.revision_notice.kind='page_completion';assert.throws(()=>manifest(next));
});
