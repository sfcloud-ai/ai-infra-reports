import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

test("publisher CD source, ledger and interrupted-deployment guards",()=>{
 // The real POSIX mode/fsync test runs in required Linux validation; Windows
 // still runs every platform-neutral control transition without blanket skips.
 const controls=process.platform==="win32"?"deployment.test_control_entry.ControlTests":"deployment.test_control_entry";
 const result=spawnSync(process.platform==="win32"?"python":"python3",["-B","-m","unittest","deployment.test_publisher_cd",controls,"-v"],{encoding:"utf8",timeout:60000});
 assert.ifError(result.error);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stderr,/\bOK\b/);
 assert.doesNotMatch(result.stderr,/skipped=/);
});
