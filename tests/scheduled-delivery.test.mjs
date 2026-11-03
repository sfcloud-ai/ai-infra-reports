import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeBundle,decodeBundle} from '../scripts/report-handoff.mjs';
import {verifyScheduledDelivery} from '../scripts/verify-scheduled-delivery.mjs';
import {publicationSite} from './helpers/publication-site.mjs';
import {FILES,MERGE} from './helpers/cloud-sender-fixture.mjs';
const bytes=await encodeBundle(FILES,'scheduled-fixture','a'.repeat(40),'b'.repeat(40)),bundle=await decodeBundle(bytes);
const input={bundle_base64:bytes.toString('base64'),report_commit:MERGE};
test('scheduled verifier derives exact notice and original poster from independently verified source',async()=>{
 const site=publicationSite({files:bundle.files,slug:'2026-11-01/r1',sourceCommit:MERGE});
 const plan=await verifyScheduledDelivery(input,site.fetcher);
 assert.equal(plan.report_date,'2026-11-01');assert.equal(plan.bundle_sha256,bundle.hash);
 assert.deepEqual(Buffer.from(plan.poster_base64,'base64'),bundle.files.get(bundle.report.path+bundle.report.poster));
 assert.equal(plan.poster_sha256,bundle.report.images.find(i=>i.path===bundle.report.poster).sha256);
});
test('scheduled verifier refuses altered public images and arbitrary destination fields',async()=>{
 const site=publicationSite({files:bundle.files,slug:'2026-11-01/r1',sourceCommit:MERGE});
 await assert.rejects(()=>verifyScheduledDelivery({...input,destination:'other'},site.fetcher));
 await assert.rejects(()=>verifyScheduledDelivery(input,(u,o)=>u.endsWith('.png')?new Response('bad',{headers:{'content-type':'image/png'}}):site.fetcher(u,o)));
});
import {verifyHistoricalDelivery} from '../scripts/verify-scheduled-delivery.mjs';
test('history migration validates immutable source when old Pages are gone, without send authority',async()=>{
 const site=publicationSite({files:bundle.files,slug:'2026-11-01/r1',sourceCommit:MERGE});
 const sourceOnly=(u,o)=>{assert.ok(u.startsWith('https://api.github.com/'));return site.fetcher(u,o);};
 const result=await verifyHistoricalDelivery(input,sourceOnly);
 assert.equal(result.purpose,'historical_daily_claims_only');assert.equal(result.delivery_allowed,false);
 assert.equal(result.plan.bundle_sha256,bundle.hash);
 site.tree.tree[0].sha='f'.repeat(40);await assert.rejects(()=>verifyHistoricalDelivery(input,sourceOnly));
});
