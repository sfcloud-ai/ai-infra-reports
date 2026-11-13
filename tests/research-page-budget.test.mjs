import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PAGE_ROUNDS_SQL,PAGE_STAGED_SQL} from '../scripts/research-page-authority.mjs';
import {activePageResearch,pageModelKeyAllowed} from '../scripts/research-page-budget.mjs';
test('only exact host open round scopes model keys, original budget identity remains unchanged',()=>{
 const db=new DatabaseSync(':memory:'),plan={model_stages:['research','editor']},run={request_id:'morning-20261113-r1',permit:null};
 assert.deepEqual(activePageResearch(db,run,plan),{active:true,modelKeys:['research','editor']});
 run.permit='{}';assert.equal(activePageResearch(db,run,plan).active,false);db.exec(PAGE_ROUNDS_SQL);db.exec(PAGE_STAGED_SQL);
 db.prepare('INSERT INTO research_page_rounds VALUES(?,?,?,?,?,?,?)').run('morning-20261113-r2',run.request_id,2,'{}','["hardware-status"]',1,null);
 const scope=activePageResearch(db,run,plan);assert.equal(pageModelKeyAllowed(scope,'research:morning-20261113-r2'),true);
 for(const key of ['research','research:morning-20261113-r3','invented:morning-20261113-r2'])assert.equal(pageModelKeyAllowed(scope,key),false);
 assert.deepEqual(plan,{model_stages:['research','editor']});
 db.prepare('UPDATE research_page_rounds SET permit=?').run('{}');assert.equal(activePageResearch(db,run,plan).active,false);db.close();
});
