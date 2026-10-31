import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,unlink,rm,realpath} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {readReports,validateArchive,json} from "../scripts/archive.mjs";
test("required CI detects manual deletion even with a correctly rebuilt index",async()=>{
 const temp=await realpath(os.tmpdir()),root=await mkdtemp(path.join(temp,"ai-report-ci-test-"));
 const script=fileURLToPath(new URL("../scripts/validate.mjs",import.meta.url));
 const git=process.env.REPORT_GIT_BIN||"git",files=await readReports("tests/fixtures/archive");
 const run=(...args)=>execFileSync(git,["-c","core.hooksPath="+path.join(root,"no-hooks"),...args],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 async function save(p,b){const f=path.join(root,p);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,b);}
 try{
  for(const [p,b]of files)await save(p,b);
  run("init","-b","main");run("add","reports");run("-c","user.name=Fixture","-c","user.email=fixture@example.com","commit","-m","test fixture");
  const base=run("rev-parse","HEAD"),env={...process.env,REPORT_BASE_SHA:base};
  assert.doesNotThrow(()=>execFileSync(process.execPath,[script],{cwd:root,env,stdio:"pipe"}));
  const reduced=new Map(files);
  for(const p of files.keys())if(p.startsWith("reports/2026-10-30/")){await unlink(path.join(root,p));reduced.delete(p);}
  await save("reports/index.json",Buffer.from(json(validateArchive(reduced,{checkIndex:false}).index)));
  assert.throws(()=>execFileSync(process.execPath,[script],{cwd:root,env,stdio:"pipe"}),e=>e.stderr.toString().includes("Published history is immutable"));
 }finally{
  const target=await realpath(root);assert.equal(path.dirname(target),temp);assert(path.basename(target).startsWith("ai-report-ci-test-"));await rm(target,{recursive:true,force:true});
 }
});
