import {json,digest,REPOSITORY} from "../../scripts/archive.mjs";
import {PREFIX} from "../../scripts/github.mjs";
export class FakeGitHub {
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
