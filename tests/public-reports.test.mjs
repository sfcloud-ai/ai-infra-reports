import test from 'node:test';
import assert from 'node:assert/strict';
import {publicReports,publicAssets} from '../scripts/public-reports.mjs';
import {createHash} from 'node:crypto';
test('publish only the greatest numeric revision for each date, independent of order',()=>{
 const reports=[{date:'2026-11-02',revision:1},{date:'2026-11-01',revision:2},{date:'2026-11-01',revision:10},{date:'2026-11-01',revision:1}];
 const before=structuredClone(reports);
 assert.deepEqual(publicReports(reports),[reports[2],reports[0]]);
 assert.deepEqual(reports,before);
 assert.deepEqual(publicReports([]),[]);
});
test('retained articles keep referenced older images without publishing unrelated assets',()=>{
 const old='reports/2026-11-01/r1/',current='reports/2026-11-01/r2/';
 const bytes=Buffer.from('original figure'),hash=createHash('sha256').update(bytes).digest('hex');
 const archive=[{path:old,images:[{path:'assets/figure.png',sha256:hash},{path:'assets/unused.png',sha256:'0'.repeat(64)}],articles:[]},
  {path:current,images:[],articles:[{path:current+'articles/topic.md'}]}];
 const files=new Map([[old+'assets/figure.png',bytes],[current+'articles/topic.md',Buffer.from('![figure][source]\n\n[source]: /ai-infra-reports/'+old+'assets/figure.png')]]);
 assert.deepEqual(publicAssets([archive[1]],archive,files),[old+'assets/figure.png']);
});
