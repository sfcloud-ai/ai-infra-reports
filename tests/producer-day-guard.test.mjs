import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Linux cloud guard persists original daily state and excludes competing real processes',{skip:process.platform!=='linux'},()=>{
 const result=spawnSync('python3',['-B','tests/producer_day_guard_test.py'],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});
