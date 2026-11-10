import test from 'node:test';
import assert from 'node:assert/strict';
import {stableReportLink,publicAssetPlan,legacyRedirects,legacyDestination} from '../scripts/public-paths.mjs';
import reportMarkdown from '../scripts/remark-reports.mjs';
import {dailyBody} from '../scripts/content-text.mjs';
import historicalRoutes from '../src/data/legacy-report-routes.json' with {type:'json'};

test('every known retired article has a content-free static redirect even without JavaScript',()=>{
 const from='2026-11-01/r1/vllm-logprobs-memory';assert(historicalRoutes.includes(from));
 const reports=[{date:'2026-11-01',revision:2,articles:[{id:'inference-engines'}]}];
 const redirects=legacyRedirects(reports,historicalRoutes);
 assert.deepEqual(redirects.find(r=>r.from===from),{from,to:'2026-11-01'});
 assert.equal(new Set(redirects.map(r=>r.from)).size,redirects.length);
 assert(redirects.every(r=>r.from.startsWith('2026-11-01/')));
 assert.throws(()=>legacyRedirects(reports,['2026-11-01/r1/../secret']),/historical article route/);
});
test('only this site article links lose revision segments; fragments and queries survive',()=>{
 for(const prefix of ['/ai-infra-reports/','https://sfcloud-ai.github.io/ai-infra-reports/'])assert.equal(stableReportLink(prefix+'2026-11-10/r3/topic/?q=1#section'),prefix+'2026-11-10/topic/?q=1#section');
 for(const url of ['https://other.example/ai-infra-reports/2026-11-10/r3/topic/','https://sfcloud-ai.github.io.evil.test/ai-infra-reports/2026-11-10/r3/topic/','https://github.com/team/repo/r3/topic/'])assert.equal(stableReportLink(url),url);
});

test('Markdown retains the compatibility redirect for a retired article',()=>{
 const days={'2026-11-01':['inference-engines']},old='/ai-infra-reports/2026-11-01/r1/vllm-logprobs-memory/?ref=old#evidence';
 for(const prefix of ['', 'https://sfcloud-ai.github.io']){
  assert.equal(stableReportLink(prefix+old,days),prefix+old);
  const tree={type:'root',children:[{type:'link',url:prefix+old},{type:'link',url:prefix+'/ai-infra-reports/2026-11-01/r2/inference-engines/'}]};
  reportMarkdown({legacyDays:days})(tree);
  assert.equal(tree.children[0].url,prefix+old);assert.equal(tree.children[1].url,prefix+'/ai-infra-reports/2026-11-01/inference-engines/');
 }
});
test('current article links and posters have stable URLs',()=>{
 const r={date:'2026-11-10',revision:3,path:'reports/2026-11-10/r3/',articles:[{id:'topic',title:'Topic',summary:'Summary'}],images:[{path:'assets/poster.png',alt:'Poster'}],poster:'assets/poster.png'};
 const text=dailyBody(r);assert(text.includes('(/ai-infra-reports/2026-11-10/topic/)'));assert(text.includes('(/ai-infra-reports/reports/2026-11-10/assets/poster.png)'));assert(!text.includes('/r3/'));
});
test('legacy redirects retain no historical content and unknown old article falls back to its known day',()=>{
 const r={date:'2026-11-10',revision:3,articles:[{id:'topic'}]},days={[r.date]:['topic']};
 assert.deepEqual(legacyRedirects([r]),[1,2,3].flatMap(n=>[{from:`2026-11-10/r${n}`,to:'2026-11-10'},{from:`2026-11-10/r${n}/topic`,to:'2026-11-10/topic'}]));
 assert.equal(legacyDestination('/ai-infra-reports/2026-11-10/r2/topic/',days),'/ai-infra-reports/2026-11-10/topic/');
 assert.equal(legacyDestination('/ai-infra-reports/2026-11-10/r999/removed/',days),'/ai-infra-reports/2026-11-10/');
 for(const path of ['/ai-infra-reports/2026-11-11/r1/topic/','/ai-infra-reports/2026-11-10/r0/topic/','/ai-infra-reports/2026-11-10/r1/../secret','//evil.test/2026-11-10/r1/','/ai-infra-reports/2026-11-10/topic/'])assert.equal(legacyDestination(path,days),null);
});
test('asset publication removes revision paths but cannot replace a different image',()=>{
 const a='reports/2026-11-10/r1/assets/figure.png',b='reports/2026-11-10/r2/assets/figure.png',files=new Map([[a,Buffer.from('first')],[b,Buffer.from('second')]]);
 const plan=publicAssetPlan([b,a],files);assert.equal(plan.outputs.size,2);assert.equal(plan.aliases['/ai-infra-reports/'+b],'/ai-infra-reports/reports/2026-11-10/assets/figure.png');assert(![...plan.outputs.keys()].some(x=>/\/r\d+\//.test(x)));assert.notEqual(plan.aliases['/ai-infra-reports/'+a],plan.aliases['/ai-infra-reports/'+b]);
});
test('AST rewrite preserves code examples while normalizing report hyperlinks and image aliases',()=>{
 const old='/ai-infra-reports/reports/2026-11-10/r1/assets/figure.png',current='/ai-infra-reports/reports/2026-11-10/assets/figure.png';
 const tree={type:'root',children:[{type:'link',url:'/ai-infra-reports/2026-11-10/r2/topic/'},{type:'image',url:old},{type:'code',value:'/ai-infra-reports/2026-11-10/r2/topic/'}]};
 reportMarkdown({assets:[current],assetAliases:{[old]:current}})(tree);
 assert.equal(tree.children[0].url,'/ai-infra-reports/2026-11-10/topic/');assert.equal(tree.children[1].url,current);assert(tree.children[2].value.includes('/r2/'));
});

test('current revision absolute image aliases remain renderable after source migration',()=>{
 const source='reports/2026-11-10/assets/figure.png',old='/ai-infra-reports/reports/2026-11-10/r3/assets/figure.png';
 const files=new Map([[source,Buffer.from('same verified image')]]),reports=[{date:'2026-11-10',revision:3,path:'reports/2026-11-10/',images:[{path:'assets/figure.png'}]}];
 const plan=publicAssetPlan([source],files,reports);
 assert.equal(plan.aliases[old],'/ai-infra-reports/'+source);
 assert.equal(plan.aliases[old.replace('/r3/','/r2/')],undefined);
 const tree={type:'root',children:[{type:'image',url:old}]};
 reportMarkdown({assets:['/ai-infra-reports/'+source],assetAliases:plan.aliases})(tree);
 assert.equal(tree.children[0].url,'/ai-infra-reports/'+source);
});
