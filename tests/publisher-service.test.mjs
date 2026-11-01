import test from "node:test";
import assert from "node:assert/strict";
import {serialTicks,releaseIdentity,writeHealth} from "../scripts/publisher-service.mjs";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("an abandoned temporary health file cannot poison subsequent restarts",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"publisher-health-"));
 try{
  await writeFile(path.join(directory,"health.json.tmp"),"old abandoned intent");
  await writeHealth(directory,{pid:1,successful_checks:1});
  await writeHealth(directory,{pid:2,successful_checks:2});
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,"health.json"),"utf8")),{pid:2,successful_checks:2});
  assert.equal(await readFile(path.join(directory,"health.json.tmp"),"utf8"),"old abandoned intent");
 }finally{await rm(directory,{recursive:true,force:true});}
});

test("a draining supervisor finishes its current tick and starts no second tick",async()=>{
 const stop=new AbortController(),events=[];
 await serialTicks(async()=>{events.push("write-started");stop.abort();await Promise.resolve();events.push("write-settled");return {phase:"idle"};},async()=>events.push("health"),()=>assert.fail("wait after stop"),stop.signal);
 assert.deepEqual(events,["write-started","write-settled","health"]);
});
test("an unknown tick stops without reporting healthy or retrying",async()=>{
 const stop=new AbortController();let calls=0;
 await assert.rejects(serialTicks(async()=>{calls++;throw Error("unknown");},()=>assert.fail("report"),()=>assert.fail("retry"),stop.signal),/unknown/);
 assert.equal(calls,1);
});
test("serial idle polls retain their bounded interval and abort their wait",async()=>{
 const stop=new AbortController();let calls=0;
 await serialTicks(async()=>{calls++;return {phase:"idle"};},async()=>{},async(ms,signal)=>{assert.equal(ms,120000);assert.equal(signal,stop.signal);stop.abort();throw Object.assign(Error(),{name:"AbortError"});},stop.signal);
 assert.equal(calls,1);
});
test("an already drained process cannot consume a message",async()=>{
 const stop=new AbortController();stop.abort();
 await serialTicks(()=>assert.fail("tick"),()=>assert.fail("report"),()=>assert.fail("wait"),stop.signal);
});
test("health commit is bound to an immutable release directory",()=>{
 assert.equal(releaseIdentity("/synthetic/releases/"+"a".repeat(40)),"a".repeat(40));
 for(const value of ["/synthetic/current","/synthetic/releases/main","/synthetic/releases/"+"a".repeat(39)])assert.throws(()=>releaseIdentity(value),/Immutable/);
});
