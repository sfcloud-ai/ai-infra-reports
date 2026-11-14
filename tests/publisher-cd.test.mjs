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

// The root-owned controller cannot import the application runtime. Keep its
// reviewed schema copy byte-for-byte identical to the actual SQLite DDL.
import {INTAKE_SCHEMA} from '../scripts/publisher-intake-state.mjs';
test('publisher CD durable intake schema matches the runtime exactly',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c','import json; from deployment.publisher_cd import INTAKE_SCHEMA; print(json.dumps(INTAKE_SCHEMA))'],{encoding:'utf8',timeout:10000});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),INTAKE_SCHEMA);
});

import {ARCHIVE_RECOVERY_SCHEMA} from '../scripts/research-archive-recovery.mjs';
test('publisher CD archive recovery marker schema matches runtime exactly',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c','import json; from deployment.publisher_cd import ARCHIVE_RECOVERY_SCHEMA; print(json.dumps(ARCHIVE_RECOVERY_SCHEMA))'],{encoding:'utf8',timeout:10000});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
 assert.equal(JSON.parse(result.stdout),ARCHIVE_RECOVERY_SCHEMA);
});
