import test from "node:test";
import assert from "node:assert/strict";
import {parseBatch} from "../scripts/git-objects.mjs";
test("binary Git batches verify object identity, length and separator",()=>{
 const sha="a".repeat(40),data=Buffer.from([0,255,10,32]),batch=Buffer.concat([Buffer.from(sha+" blob 4\n"),data,Buffer.from("\n")]);
 assert.deepEqual(parseBatch(batch,[{sha,size:4}]).get(sha),data);
 for(const corrupt of [batch.subarray(0,-1),Buffer.concat([batch,Buffer.from("extra")]),Buffer.from(sha+" missing\n")])assert.throws(()=>parseBatch(corrupt,[{sha,size:4}]));
 assert.throws(()=>parseBatch(batch,[{sha:"b".repeat(40),size:4}]));
});

import {GitObjects} from "../scripts/git-objects.mjs";

test("Git object subprocesses do not inherit the Producer secret-file location",async()=>{
 const original=process.env.REPORT_PRODUCER_PRIVATE_KEY_FILE,store=new GitObjects();
 process.env.REPORT_PRODUCER_PRIVATE_KEY_FILE="fixture-secret-path";
 try {await store.init();assert.equal(store.env.REPORT_PRODUCER_PRIVATE_KEY_FILE,undefined);}
 finally {if(original===undefined)delete process.env.REPORT_PRODUCER_PRIVATE_KEY_FILE;else process.env.REPORT_PRODUCER_PRIVATE_KEY_FILE=original;await store.close();}
});
test("real Git batch reads binary objects without checkout and reuses cached bytes",async()=>{
 const store=new GitObjects();
 try{
  await store.init();
  const data=Buffer.from([0,255,10,13,65]),sha=(await store.run(["hash-object","-w","--stdin"],true,data)).toString().trim();
  const commit="a".repeat(40);store.fetched.add(commit);
  const first=await store.read(commit,[{sha,size:data.length}]),bytes=first.get(sha);
  assert.deepEqual(bytes,data);
  const second=await store.read(commit,[{sha,size:data.length}]);assert.equal(second.get(sha),bytes);
 }finally{await store.close();}
});
