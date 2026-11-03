import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,json,validateArchive,validateChange} from '../scripts/archive.mjs';
import {currentReportDate,validateCIReportChange} from '../scripts/historical-backfill.mjs';

const emptyReport = date => ({schema_version:'1.0',date,revision:1,title:'Test report',subtitle:'Validation fixture',articles:[],entries:[],images:[],poster:null});
function reindex(files) {
  files.set('reports/index.json',Buffer.from(json(validateArchive(files,{checkIndex:false}).index)));
  return files;
}
function add(files,date,label) {
  const report=emptyReport(date),body=Buffer.from('# '+label+'\nPublic source analysis.\n');
  report.articles=[{id:label,title:label,summary:'Evidence summary '+label,sha256:digest(body)}];
  report.entries=[{id:'event-'+label,event_key:'event-'+label,title:label,summary:'Source-backed '+label,source_urls:['https://example.com/'+label],update_of:null,article_id:label}];
  files.set('reports/'+date+'/r1/report.json',Buffer.from(json(report)));
  files.set('reports/'+date+'/r1/articles/'+label+'.md',body);
  return files;
}
const base=reindex(new Map([['reports/2026-11-03/r1/report.json',Buffer.from(json(emptyReport('2026-11-03')))]]));
const head=reindex(add(add(new Map(base),'2025-01-02','older'),'2026-10-31','recent'));
const check=(before=base,after=head,today='2026-11-03')=>validateCIReportChange(before,after,{today});

test('arbitrary past dates can be backfilled together without changing existing reports',()=>{
  assert.deepEqual(check().reports.map(r=>r.date),['2025-01-02','2026-10-31','2026-11-03']);
});
test('ordinary Producer and Merger validation still rejects a multi-edition change',()=>{
  assert.throws(()=>validateChange(base,head),/one report revision/);
});
test('ordinary single-edition publishing keeps its existing behavior',()=>{
  const single=reindex(add(new Map(base),'2026-11-04','single'));
  assert.equal(check(base,single).reports.length,2);
});
test('a batch containing today or a future date fails closed at the report date boundary',()=>{
  for(const date of ['2026-11-03','2026-11-04']) {
    const empty=reindex(new Map());
    const batch=reindex(add(add(new Map(empty),'2026-10-31','past'),date,'not-past'));
    assert.throws(()=>check(empty,batch),/precede the current UTC\+8 report date/);
  }
  assert.equal(check(base,head,'2026-11-01').reports.length,3);
  assert.throws(()=>check(base,head,'2026-10-31'),/precede the current UTC\+8 report date/);
});
test('today follows the morning report UTC+8 calendar rather than the runner timezone',()=>{
  assert.equal(currentReportDate(new Date('2026-11-02T15:59:59.999Z')),'2026-11-02');
  assert.equal(currentReportDate(new Date('2026-11-02T16:00:00.000Z')),'2026-11-03');
});
test('historical corrections cannot be mixed into a backfill batch',()=>{
  const changed=new Map(head),from='reports/2026-11-03/r1/report.json',report=JSON.parse(changed.get(from));
  report.revision=2;changed.set('reports/2026-11-03/r2/report.json',Buffer.from(json(report)));reindex(changed);
  assert.throws(()=>check(base,changed,'2026-11-05'),/previously absent dates/);
});
test('published history remains immutable even with a self-consistent new index',()=>{
  const changed=new Map(head),p='reports/2026-11-03/r1/report.json',report=JSON.parse(changed.get(p));
  report.subtitle='Changed historical text';changed.set(p,Buffer.from(json(report)));reindex(changed);
  assert.throws(()=>check(base,changed),/published reports are immutable/);
});
test('each article hash and the final same-commit index are still required',()=>{
  const changed=new Map(head);changed.set('reports/2026-10-31/r1/articles/recent.md',Buffer.from('tampered'));
  assert.throws(()=>check(base,changed),/article hash/);
  const stale=new Map(head);stale.set('reports/index.json',base.get('reports/index.json'));
  assert.throws(()=>check(base,stale),/index must match/);
});
test('invalid cutoff dates cannot enable backfills',()=>{
  for(const cutoff of ['2026-02-30','20261103','',null]) assert.throws(()=>check(base,head,cutoff));
});
test('event identities cannot be reused across backfilled dates',()=>{
  const changed=new Map(head),p='reports/2026-10-31/r1/report.json',report=JSON.parse(changed.get(p));
  report.entries[0].id='event-older';changed.set(p,Buffer.from(json(report)));
  assert.throws(()=>check(base,changed),/existing ID/);
});
