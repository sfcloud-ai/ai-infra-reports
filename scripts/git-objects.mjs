// Fetch Git objects without checking out or executing any report content.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,writeFile,rm,realpath} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const exec=promisify(execFile);
export function parseBatch(buffer,entries) {
 const result=new Map();let offset=0;
 for(const e of entries) {
  const end=buffer.indexOf(10,offset);if(end<0)throw Error("Truncated Git object header");
  const header=buffer.toString("ascii",offset,end).split(" ");
  if(header[0]!==e.sha||header[1]!=="blob"||Number(header[2])!==e.size)throw Error("Git object identity mismatch");
  const start=end+1,stop=start+e.size;
  if(stop>=buffer.length||buffer[stop]!==10)throw Error("Truncated Git object");
  result.set(e.sha,Buffer.from(buffer.subarray(start,stop)));offset=stop+1;
 }
 if(offset!==buffer.length)throw Error("Unexpected Git object output");return result;
}
export class GitObjects {
 constructor(){this.cache=new Map();this.fetched=new Set();this.tail=Promise.resolve();}
 async init() {
  if(this.root)return;
  this.tempBase=await realpath(os.tmpdir());this.root=await mkdtemp(path.join(this.tempBase,"ai-report-objects-"));
  await mkdir(path.join(this.root,"hooks"));await writeFile(path.join(this.root,"config-empty"),"");
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith("GIT_"))delete env[key];
  delete env.GITHUB_TOKEN;delete env.REPORT_APP_TOKEN;delete env.REPORT_MERGER_TOKEN;
  this.env={...env,GIT_CONFIG_GLOBAL:path.join(this.root,"config-empty"),GIT_CONFIG_SYSTEM:path.join(this.root,"config-empty"),GIT_TERMINAL_PROMPT:"0"};
  await this.run(["init","--bare","--template=",path.join(this.root,"objects.git")],false);
 }
 async run(args,hasRepo=true,input) {
  const prefix=["-c","core.hooksPath="+path.join(this.root,"hooks"),"-c","protocol.file.allow=never","-c","protocol.ext.allow=never","-c","submodule.recurse=false"];
  if(hasRepo)prefix.push("--git-dir",path.join(this.root,"objects.git"));
  const child=exec(process.env.REPORT_GIT_BIN||"git",[...prefix,...args],{env:this.env,encoding:"buffer",maxBuffer:280*1024*1024,timeout:120000,windowsHide:true});
  if(input!==undefined)child.child.stdin.end(input);else child.child.stdin.end();
  return (await child).stdout;
 }
 async read(sha,entries) {
  const result=this.tail.then(()=>this.readSerial(sha,entries));this.tail=result.catch(()=>{});return result;
 }
 async readSerial(sha,entries) {
  await this.init();
  if(!this.fetched.has(sha)){
   await this.run(["fetch","--no-tags","--no-recurse-submodules","--depth=1","https://github.com/sfcloud-ai/ai-infra-reports.git",sha]);
   this.fetched.add(sha);
  }
  const missing=[...new Map(entries.filter(e=>!this.cache.has(e.sha)).map(e=>[e.sha,e])).values()];
  if(missing.length){
   const out=await this.run(["cat-file","--batch"],true,missing.map(e=>e.sha+"\n").join(""));
   for(const [id,b]of parseBatch(out,missing))this.cache.set(id,b);
  }
  return this.cache;
 }
 async close() {
  await this.tail;
  if(!this.root)return;
  const target=await realpath(this.root);
  if(path.dirname(target)!==this.tempBase||!path.basename(target).startsWith("ai-report-objects-"))throw Error("Refusing unexpected cleanup target");
  await rm(target,{recursive:true,force:true});this.root=undefined;this.cache.clear();
 }
}
