import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

test("publisher CD source, ledger and interrupted-deployment guards",()=>{
 const result=spawnSync(process.platform==="win32"?"python":"python3",["-B","-m","unittest","deployment.test_publisher_cd","-v"],{encoding:"utf8",timeout:60000});
 assert.ifError(result.error);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stderr,/\bOK\b/);
 assert.doesNotMatch(result.stderr,/skipped=/);
});
