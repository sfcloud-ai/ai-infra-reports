import test from 'node:test';
import assert from 'node:assert/strict';
import {recentReportDays,recentNavigationPages} from '../src/data/recent-reports.mjs';
const day=date=>({kind:'day',date,slug:date});
const article=date=>({kind:'article',date,slug:date+'/overview',parent:date});
test('new publications move a seven-calendar-day window automatically across year boundaries',()=>{
 const pages=['2025-12-20','2025-12-26','2025-12-27','2025-12-31','2026-01-01'].flatMap(date=>[day(date),article(date)]);
 const before=structuredClone(pages);
 assert.deepEqual(recentReportDays(pages).map(p=>p.date),['2026-01-01','2025-12-31','2025-12-27','2025-12-26']);
 assert.deepEqual(recentReportDays([...pages,day('2026-01-03')]).map(p=>p.date),['2026-01-03','2026-01-01','2025-12-31']);
 assert.deepEqual(pages,before);assert.deepEqual(recentReportDays([]),[]);
});
test('recent navigation stays bounded while an older search result retains its own report chapters',()=>{
 const pages=Array.from({length:20},(_,i)=>'2026-11-'+String(i+1).padStart(2,'0')).flatMap(date=>[day(date),article(date)]);
 const home=recentNavigationPages(pages);assert.equal(home.filter(p=>p.kind==='day').length,7);assert.equal(home.length,14);assert.equal(home.some(p=>p.date==='2026-11-01'),false);
 const old=recentNavigationPages(pages,'2026-11-01/overview');assert.equal(old.filter(p=>p.kind==='day').length,8);assert.ok(old.some(p=>p.slug==='2026-11-01/overview'));
 assert.equal(pages.length,40);assert.deepEqual(recentNavigationPages(pages,'missing'),home);
});
