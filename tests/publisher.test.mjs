import test from "node:test";
import assert from "node:assert/strict";
import {propose} from "../scripts/propose.mjs";
import {readReports,json,digest,REPOSITORY} from "../scripts/archive.mjs";
import {PREFIX} from "../scripts/github.mjs";
class FakeGitHub {
 constructor(){
  this.calls=[];this.blobs=new Map();this.trees=new Map();this.commits=new Map();this.refs=new Map();this.pulls=[];this.unknownRef=false;this.unknownPR=false;
  const bytes=Buffer.from(json({schema_version:"1.0",reports:[],entries:[]}));
  const blob=this.putBlob(bytes);this.trees.set("0".repeat(40),[{path:"reports/index.json",sha:blob,mode:"100644",type:"blob",size:bytes.length}]);
  this.base="a".repeat(40);this.commits.set(this.base,{sha:this.base,tree:{sha:"0".repeat(40)},parents:[]});this.refs.set("main",this.base);
 }
 async readBlobs(){return this.blobs;}
 putBlob(b){const sha=digest(b).slice(0,40);this.blobs.set(sha,b);return sha;}
 async request(method,route,body){
  this.calls.push({method,route,body});const p=route.slice(PREFIX.length);
  if(method==="GET"&&p.startsWith("/git/ref/heads/")){const sha=this.refs.get(p.slice(15));return sha?{object:{sha}}:null;}
  if(method==="GET"&&p.startsWith("/git/commits/"))return this.commits.get(p.split("/").at(-1));
  if(method==="GET"&&p.startsWith("/git/trees/"))return {truncated:false,tree:this.trees.get(p.split("/").at(-1).split("?")[0])};
  if(method==="GET"&&p.startsWith("/git/blobs/")){const b=this.blobs.get(p.split("/").at(-1));return {encoding:"base64",size:b.length,content:b.toString("base64")};}
  if(method==="POST"&&p==="/git/blobs")return {sha:this.putBlob(Buffer.from(body.content,"base64"))};
  if(method==="POST"&&p==="/git/trees"){
   const tree=new Map(this.trees.get(body.base_tree).map(e=>[e.path,e]));
   for(const e of body.tree)tree.set(e.path,{...e,size:this.blobs.get(e.sha).length});
   const entries=[...tree.values()],sha=digest(json(entries)).slice(0,40);this.trees.set(sha,entries);return {sha};
  }
  if(method==="POST"&&p==="/git/commits"){const sha=digest(json(body)).slice(0,40);this.commits.set(sha,{sha,tree:{sha:body.tree},parents:body.parents.map(sha=>({sha}))});return {sha};}
  if(method==="POST"&&p==="/git/refs"){const name=body.ref.slice(11);if(this.refs.has(name))throw Error("exists");this.refs.set(name,body.sha);if(this.raceEquivalent){this.raceEquivalent=false;const winner="d".repeat(40);this.commits.set(winner,{...this.commits.get(body.sha),sha:winner});this.refs.set(name,winner);throw Error("concurrent create");}if(this.unknownRef){this.unknownRef=false;throw Error("connection lost");}return {object:{sha:body.sha}};}
  if(method==="GET"&&p.startsWith("/pulls?"))return this.pulls;
  if(method==="POST"&&p==="/pulls"){
   this.pulls.push({number:1,state:"open",head:{sha:this.refs.get(body.head)},html_url:"https://github.com/"+REPOSITORY+"/pull/1",draft:body.draft});
   if(this.unknownPR){this.unknownPR=false;if(this.mergeAfterUnknownPR){this.pulls[0].state="closed";this.pulls[0].merged_at="2026-10-31T00:00:00Z";}throw Error("unknown result");}return this.pulls[0];
  }
  throw Error("Unexpected mock call "+method+" "+p);
 }
}
const bundle=new Map([...await readReports("tests/fixtures/archive")].filter(([p])=>p.startsWith("reports/2026-10-31/")));
test("publisher commits report and index atomically and creates a draft by default",async()=>{
 const api=new FakeGitHub(),r=await propose(api,bundle,api.base);
 assert.equal(r.merged,false);assert.equal(api.pulls[0].draft,true);
 const change=api.calls.find(c=>c.route.endsWith("/git/trees")&&c.method==="POST");
 assert(change.body.tree.some(e=>e.path==="reports/index.json"));assert(change.body.tree.some(e=>e.path.endsWith("/report.json")));
 assert.equal(api.calls.filter(c=>c.route.endsWith("/git/refs")&&c.method==="POST").length,1);
});
test("unknown ref/PR response reconciles without duplicate branch or pull request",async()=>{
 const api=new FakeGitHub();api.unknownRef=true;api.unknownPR=true;
 const first=await propose(api,bundle,api.base),again=await propose(api,bundle,api.base);
 assert.equal(first.sha,again.sha);assert.equal(again.reused,true);
 assert.equal(api.pulls.length,1);assert.equal(api.calls.filter(c=>c.route.endsWith("/pulls")&&c.method==="POST").length,1);
});
test("stale main and closed PR stop without force pushes or reopening",async()=>{
 const api=new FakeGitHub();await assert.rejects(()=>propose(api,bundle,"b".repeat(40)),/Main moved/);
 assert.equal(api.calls.filter(c=>c.method!=="GET").length,0);
 await propose(api,bundle,api.base);api.pulls[0].state="closed";
 await assert.rejects(()=>propose(api,bundle,api.base),/closed/);
 assert.equal(api.pulls.length,1);assert(!api.calls.some(c=>c.method==="PATCH"));
});
test("wrong content bundle rejected before any GitHub write",async()=>{
 const api=new FakeGitHub(),bad=new Map(bundle);bad.set("reports/2026-10-31/r1/run.mjs",Buffer.from("code"));
 await assert.rejects(()=>propose(api,bad,api.base),/unexpected path/);
 assert.equal(api.calls.filter(c=>c.method!=="GET").length,0);
});

test("equivalent racing commits reuse the winning ref and PR",async()=>{
 const api=new FakeGitHub();api.raceEquivalent=true;
 const result=await propose(api,bundle,api.base);
 assert.equal(result.sha,"d".repeat(40));assert.equal(api.pulls.length,1);
 assert.equal(api.pulls[0].head.sha,result.sha);
});
test("lost PR response reports an already completed merge accurately",async()=>{
 const api=new FakeGitHub();api.unknownPR=true;api.mergeAfterUnknownPR=true;
 const result=await propose(api,bundle,api.base);assert.equal(result.merged,true);assert.equal(api.pulls.length,1);
});
